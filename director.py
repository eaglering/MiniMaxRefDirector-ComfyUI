import hashlib
import json
import os
import logging
from comfy_api.latest import io

from .lib.audio import fill_audio_gaps
from .lib.image import calc_resolution
from .lib.prompt import build_h3_prompt

GuideData = io.Custom("GUIDE_DATA")
SubjectData = io.Custom("SUBJECT_DATA")
SubjectConfig = io.Custom("SUBJECT_CONFIG")

log = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# director 是纯函数（同一组输入必得同一输出）。
# 缓存兜底：Easy-Use forLoop 展开时，director 输出可能被 compare 的 link 引用而重复调度执行。
# 同一次 prompt 内同一输入直接返回缓存，避免 build_h3_prompt / LLM 生成被重复计算。
# 缓存键含 prompt_id，跨 prompt（即使输入相同）不命中，保证修改 subject.py / prompt.py
# 后无需重启 Python 即可生效。
_director_cache: dict[str, io.NodeOutput] = {}
# 最近一次执行的 prompt_id：跨 prompt 时整体清空旧缓存（旧条目不会再被命中，避免无界增长）
_last_prompt_id: object = None


class MiniMaxRefDirector(io.ComfyNode):
    """Timeline director with resolution config and guide_data output for MiniMax pipelines."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefDirector",
            display_name="MiniMax Reference Director",
            category="minimaxrefdirector",
            description=(
                "Timeline director that combines prompt scheduling, subject data, "
                "resolution configuration, and prompt templates into a unified guide_data output."
            ),
            inputs=[
                SubjectConfig.Input(
                    "config", optional=True,
                    tooltip="Unified config from MiniMax Reference Subject (VLM opts + subject data).",
                ),
                io.Float.Input(
                    "start_second", default=0.0, min=0.0, max=1000.0, step=0.01,
                    tooltip="Start time in seconds of the timeline generation.",
                ),
                io.Float.Input(
                    "end_second", default=5.0, min=0.0, max=1000.0, step=0.01,
                    tooltip="End time in seconds of the timeline generation.",
                ),
                io.Float.Input(
                    "duration_seconds", default=5.0, min=0.1, max=1000.0, step=0.01,
                    tooltip="Total timeline duration in seconds (computed/synced from frames).",
                ),
                io.Int.Input(
                    "start_frame", default=0, min=0, max=10000, step=1,
                    tooltip="Start frame of the timeline generation.",
                ),
                io.Int.Input(
                    "end_frame", default=120, min=1, max=10000, step=1,
                    tooltip="End frame of the timeline generation.",
                ),
                io.Int.Input(
                    "duration_frames", default=120, min=1, max=10000, step=1,
                    tooltip="Total timeline length in pixel-space frames. Used by the editor for visual scale only.",
                ),
                io.String.Input(
                    "timeline_data", default="",
                    tooltip="JSON state of the timeline editor (auto-managed; do not edit by hand).",
                ),
                io.String.Input(
                    "local_prompts", multiline=True, default="",
                    tooltip="Auto-populated from the timeline editor.",
                ),
                io.String.Input(
                    "segment_lengths", default="",
                    tooltip="Auto-populated from the timeline editor (pixel-space frame counts).",
                ),
                io.Float.Input(
                    "frame_rate", default=24, min=1, max=240, step=1, optional=True,
                    tooltip="Frames per second — only affects how time is displayed in the timeline editor when time_units is set to 'seconds'.",
                ),
                io.Combo.Input(
                    "display_mode", options=["frames", "seconds"], default="seconds", optional=True,
                    tooltip="Display the ruler, segment ranges, length input, and total in frames or seconds. Internal storage is always pixel-space frames.",
                ),
                io.Combo.Input(
                    "outpu_resolution",
                    options=["1:1方形", "9:16竖屏", "16:9横屏", "3:2横屏", "2:3竖屏", "4:3横屏", "3:4竖屏", "21:9超宽"],
                    default="16:9横屏", optional=True,
                    tooltip="Target output aspect ratio. Width/height are calculated from million_pixels.",
                ),
                io.Float.Input(
                    "million_pixels", default=0.6, min=0.1, max=4.0, step=0.1, optional=True,
                    tooltip="Million pixels target. 1.0 MP ≈ 1024×1024.",
                ),
            ],
            outputs=[
                GuideData.Output(display_name="guide_data"),
                io.Int.Output(display_name="segment_count"),
                io.Float.Output(display_name="frame_rate"),
            ],
        )

    @classmethod
    def execute(cls, config=None,
                start_second=0.0, end_second=5.0, duration_seconds=5.0, 
                start_frame=0, end_frame=120, duration_frames=120, timeline_data="", 
                local_prompts="", segment_lengths="", frame_rate=24, 
                display_mode="seconds",  outpu_resolution="16:9横屏", million_pixels=0.6) -> io.NodeOutput:
        """Assemble guide_data from timeline, subjects, resolution, and prompt template."""
        # --- 缓存键：全量输入序列化（director 为纯函数，同一输入必得同一输出） ---
        key_data = {
            "config": config,
            "start_second": start_second, "end_second": end_second, "duration_seconds": duration_seconds,
            "start_frame": start_frame, "end_frame": end_frame, "duration_frames": duration_frames,
            "timeline_data": timeline_data, "local_prompts": local_prompts, "segment_lengths": segment_lengths,
            "frame_rate": frame_rate, "display_mode": display_mode,
            "outpu_resolution": outpu_resolution, "million_pixels": million_pixels,
        }
        # 附加当前 prompt_id：跨 prompt（即使输入相同）不命中旧缓存，
        # 保证修改 subject.py / prompt.py 后无需重启 Python 即可生效。
        global _last_prompt_id
        _current_prompt_id = None
        try:
            from comfy_execution.utils import get_executing_context
            _ctx = get_executing_context()
            _current_prompt_id = getattr(_ctx, "prompt_id", None)
            key_data["_prompt_id"] = _current_prompt_id
        except Exception:
            pass
        # 跨 prompt 清理：prompt_id 变化时旧缓存整体失效，避免无界增长
        if _current_prompt_id is not None and _current_prompt_id != _last_prompt_id:
            _last_prompt_id = _current_prompt_id
            if _director_cache:
                log.info("[MiniMaxRefDirector] prompt changed -> clear stale cache")
                _director_cache.clear()
        cache_key = hashlib.md5(
            json.dumps(key_data, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
        ).hexdigest()
        if cache_key in _director_cache:
            log.info("[MiniMaxRefDirector] cache hit (loop re-reference) -> skip recompute")
            cached = _director_cache[cache_key]
            # 缓存可能来自同一次 prompt 内较早的调度（同节点），无需修正；
            # 若被不同节点复用（多实例同输入），仍按当前执行节点修正归属
            try:
                from comfy_execution.utils import get_executing_context
                _ctx = get_executing_context()
                if _ctx is not None and getattr(_ctx, "node_id", None) is not None:
                    guide = cached.args[0]
                    if isinstance(guide, dict) and guide.get("_director_node_id") != _ctx.node_id:
                        guide = dict(guide)
                        guide["_director_node_id"] = _ctx.node_id
                        cached = io.NodeOutput(guide, *cached.args[1:])
            except Exception:
                pass
            return cached

        # config 是可选输入：前端首帧 subgraph 中 director 不连接 config，需容错
        global_prompt = config.get("global_prompt", "") if config else ""
        subject_data = config.get("subject_data", {}) if config else {}
        subject = subject_data.get("subjects", []) if subject_data else []
        if not subject:
            subject = subject_data.get("subjects", []) if isinstance(subject_data, dict) else []

        if not timeline_data or not timeline_data.strip():
            raise ValueError("[MiniMaxRefDirector] timeline_data is required and must not be empty.")

        # --- Parse timeline segments ---
        tdata = {}
        try:
            tdata = json.loads(timeline_data) if timeline_data else {}
        except (json.JSONDecodeError, TypeError):
            log.warning("[MiniMaxRefDirector] Failed to parse timeline_data.")

        # --- Determine effective frame range based on display_mode ---
        if display_mode == "seconds":
            range_start = int(start_second * frame_rate)
            range_end = int(end_second * frame_rate)
        else:
            range_start = start_frame
            range_end = end_frame
        range_end = max(range_end, range_start + 1)
        duration_frames = int(range_end - range_start)

        audio_segments = tdata.get("audioSegments", None) if tdata.get("audioTrackEnabled", False) else None
        audio_segments = fill_audio_gaps(audio_segments, range_start, range_end)

        # --- Build timeline_data array for guide_data ---
        guide_timeline = []
        segment_count = 0
        timeline_segments = tdata.get("segments", [])
        timeline_data_len = len(timeline_segments)
        last_frame_path = ""

        if timeline_data_len == 0:
            raise ValueError("[MiniMaxRefDirector] timeline_segments is required and must not be empty.")
        
        for i, seg in enumerate(timeline_segments):
            dur = int(seg.get("length", 1))
            seg_start_frames = int(seg.get("start", 0))
            seg_end_frames = seg_start_frames + dur

            if seg_start_frames < range_start:
                seg_start_frames = range_start
            if seg_end_frames > range_end:
                seg_end_frames = range_end

            dur = seg_end_frames - seg_start_frames
            if dur <= 0:
                continue
            seg_audio = fill_audio_gaps(audio_segments, seg_start_frames, seg_end_frames)
            h3_prompt_json = seg.get("h3PromptJson", "")
            prev_seg = timeline_segments[i - 1] if i - 1 >= 0 else None
            next_seg = timeline_segments[i + 1] if i + 1 < timeline_data_len else None
            prompt_res = build_h3_prompt(global_prompt=global_prompt, subject_data=subject_data, 
                                         prompt_json=h3_prompt_json, previous_timeline_segment=prev_seg,
                                         timeline_segment=seg, next_timeline_segment=next_seg, seg_audio=seg_audio)
            entry = {
                "prompt": prompt_res["prompt"],
                "subjects": prompt_res["subjects"],
                "images": prompt_res["images"],
                "audios": prompt_res["audios"],
                "videos": prompt_res["videos"],
                "prevImageFile": prompt_res["prevImageFile"],
                "prevType": prompt_res["prevType"],
                "durationFrames": dur,
                "startFrames": seg_start_frames,
                "type": seg.get("type", "text"),
                "imageFile": seg.get("imageFile", ""),
                "upscale": seg.get("upscale", False),
                "guideStrength": seg.get("guideStrength", 16),
            }
            guide_timeline.append(entry)
            segment_count += 1

        if segment_count == 0:
            raise ValueError("[MiniMaxRefDirector] No valid segments found in timeline_data.")

        # --- Resolve output resolution ---
        out_w, out_h = calc_resolution(outpu_resolution, million_pixels)

        # --- Assemble guide_data ---
        # 附带 Director 自身节点 id：Guide 节点执行时可借此把进度/素材通知关联回
        # 前端对应的 Director 节点，多 tab / 多实例时按节点精确过滤，避免串收。
        director_node_id = None
        try:
            from comfy_execution.utils import get_executing_context
            _ctx = get_executing_context()
            if _ctx is not None:
                director_node_id = getattr(_ctx, "node_id", None)
        except Exception:
            director_node_id = None
        guide_data = {
            "width": out_w,
            "height": out_h,
            "frame_rate": float(frame_rate),
            "range_start": int(range_start),
            "range_end": int(range_end),
            "global_prompt": global_prompt,
            "subject_data": subject,
            "timeline_data": guide_timeline,
            "audio_segments": audio_segments,
            "_director_node_id": director_node_id,
        }

        log.info(
            f"[MiniMaxRefDirector] {segment_count} segments | timeline: {timeline_data} | "
            f"start_second: {start_second} | end_second: {end_second} | duration_seconds: {duration_seconds} | "
            f"start_frane: {start_frame} | end_frame: {end_frame} | duration_frames: {duration_frames} | "
            f"{out_w}×{out_h} ({outpu_resolution}, {million_pixels}MP) | "
            f"{len(subject)} subjects | {global_prompt} | {last_frame_path}"
        )

        result = io.NodeOutput(guide_data, segment_count + 1, frame_rate)
        _director_cache[cache_key] = result
        return result


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefDirector": MiniMaxRefDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefDirector": "MiniMax Super Director",
}
