import hashlib
import json
import os
import logging
from comfy_api.latest import io

from .lib.image import calc_resolution
from .lib.prompt import build_h3_prompt

GuideData = io.Custom("GUIDE_DATA")
SubjectData = io.Custom("SUBJECT_DATA")
SubjectConfig = io.Custom("SUBJECT_CONFIG")

log = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_TEMPLATE = os.path.join(_PROJECT_ROOT, "prompt", "minimax_ref2v_template.txt")

# director 是纯函数（同一组输入必得同一输出）。
# 缓存兜底：Easy-Use forLoop 展开时，director 输出可能被 compare 的 link 引用而重复调度执行。
# 同一次 prompt 内同一输入直接返回缓存，避免 build_h3_prompt / LLM 生成被重复计算。
_director_cache: dict[str, io.NodeOutput] = {}


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
                # --- 视频生成已迁移到 MiniMaxRefGuide 节点（Easy-Use forLoop 内按段调用） ---
                # director 仅负责组装 guide_data；model/clip/video_vae/audio_vae 由外部自行接入采样链路。
            ],
            outputs=[
                GuideData.Output(display_name="guide_data"),
                io.Int.Output(display_name="segment_count"),
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
        cache_key = hashlib.md5(
            json.dumps(key_data, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
        ).hexdigest()
        if cache_key in _director_cache:
            log.info("[MiniMaxRefDirector] cache hit (loop re-reference) -> skip recompute")
            return _director_cache[cache_key]

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

        timeline_segments = tdata.get("segments", [])

        # --- Determine effective frame range based on display_mode ---
        if display_mode == "seconds":
            range_start = int(start_second * frame_rate)
            range_end = int(end_second * frame_rate)
        else:
            range_start = start_frame
            range_end = end_frame
        range_end = max(range_end, range_start + 1)
        duration_frames = int(range_end - range_start)

        # --- Build timeline_data array for guide_data ---
        guide_timeline = []
        segment_count = 0
        timeline_data_len = len(timeline_segments)
        last_frame_path = ""

        if timeline_data_len == 0:
            timeline_segments = [{
                "length": duration_frames,
                "start": 0,
                "prompt": "",
                "imageFile": "",
            }]
        
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
            h3_prompt_json = seg.get("h3PromptJson", "")
            prev_seg = timeline_segments[i - 1] if i - 1 >= 0 else None
            next_seg = timeline_segments[i + 1] if i + 1 < timeline_data_len else None
            prompt_res = build_h3_prompt(global_prompt=global_prompt, subject_data=subject_data, 
                                         raw_prompt=h3_prompt_json, previous_timeline_segment=prev_seg,
                                         timeline_segment=seg, next_timeline_segment=next_seg)
            entry = {
                "prompt": prompt_res["prompt"],
                "subjects": prompt_res["subjects"],
                "images": prompt_res["images"],
                "audios": prompt_res["audios"],
                "videos": prompt_res["videos"],
                "prevImageFile": prompt_res["prevImageFile"],
                "durationFrames": dur,
                "type": seg.get("type", "text"),
                "imageFile": seg.get("imageFile", ""),
                "motionContext": seg.get("motionContext", False)
            }
            guide_timeline.append(entry)
            segment_count += 1

        # --- Resolve output resolution ---
        out_w, out_h = calc_resolution(outpu_resolution, million_pixels)

        # --- Assemble guide_data ---
        guide_data = {
            "width": out_w,
            "height": out_h,
            "frame_rate": float(frame_rate),
            "global_prompt": global_prompt,
            "subject_data": subject,
            "timeline_data": guide_timeline,
        }

        log.info(
            f"[MiniMaxRefDirector] {segment_count} segments | timeline: {timeline_data} "
            f"{out_w}×{out_h} ({outpu_resolution}, {million_pixels}MP) | "
            f"{len(subject)} subjects | {global_prompt} | {last_frame_path}"
        )

        result = io.NodeOutput(guide_data, segment_count + 1)
        _director_cache[cache_key] = result
        return result


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefDirector": MiniMaxRefDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefDirector": "MiniMax Super Director",
}
