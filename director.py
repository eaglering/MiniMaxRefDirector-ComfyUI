import json
import os
import logging
from comfy_api.latest import io

from .lib.image import calc_resolution
from .lib.prompt import build_h3_subject_bindings

GuideData = io.Custom("GUIDE_DATA")
SubjectData = io.Custom("SUBJECT_DATA")
SubjectConfig = io.Custom("SUBJECT_CONFIG")

log = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_TEMPLATE = os.path.join(_PROJECT_ROOT, "prompt", "minimax_ref2v_template.txt")


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
                io.Model.Input(
                    "model", optional=True,
                    tooltip="Diffusion model to pass through to the generation node.",
                ),
                io.Clip.Input(
                    "clip", optional=True,
                    tooltip="CLIP model to pass through to the generation node.",
                ),
                io.Vae.Input(
                    "video_vae", optional=True,
                    tooltip="Video VAE to pass through to the generation node.",
                ),
                io.Vae.Input(
                    "audio_vae", optional=True,
                    tooltip="Audio VAE to pass through to the generation node.",
                ),
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
    def execute(cls, model=None, clip=None, video_vae=None, audio_vae=None, config=None,
                start_second=0.0, end_second=5.0, duration_seconds=5.0, 
                start_frame=0, end_frame=120, duration_frames=120, timeline_data="", 
                local_prompts="", segment_lengths="", frame_rate=24, 
                display_mode="seconds",  outpu_resolution="16:9横屏", million_pixels=0.6) -> io.NodeOutput:
        """Assemble guide_data from timeline, subjects, resolution, and prompt template."""
        # model/clip/video_vae/audio_vae 为保留的透传输入（不再输出，由外部自行接入采样链路）
        _ = (model, clip, video_vae, audio_vae)
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
        prev_prompt = ""

        # 全局尾帧（最后一个有图 segment，与前端 buildFirstFramePayload 一致）；
        # 首帧图不再作为 shot1 首帧锚点（图片改为与提示词合并进 detailed_description）
        img_segs = [s for s in timeline_segments if s.get("imageFile", "")]
        last_frame_path = img_segs[-1].get("imageFile", "") if img_segs else ""

        if len(timeline_segments) == 0:
            timeline_segments = [{
                "length": duration_frames,
                "start": 0,
                "prompt": "",
                "imageFile": "",
            }]
        
        for seg in timeline_segments:
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
            first_frame = seg.get("imageFile", "") if seg.get("type", "text") == "image" else ""
            prompt = seg.get("prompt", "").replace("@", "")
            entry = {
                "prompt": prompt,
                "prev_prompt": prev_prompt,
                "first_frame": first_frame,
                "duration_frames": dur,
                "prompt_enhance": seg.get("prompt_enhance", "Default"),
                "is_end_frame": seg.get("isEndFrame", False)
            }
            # 右侧 H3 prompt JSON（per-segment 持久化）：重建与前端 buildFirstFramePayload
            # 等价的 prompt（subject_definitions + retention_analysis + detailed_description
            # + overall_soundscape + non_diegetic_music）与媒体列表（pictures / audios / videos），
            prompt_json = seg.get("h3PromptJson")
            if isinstance(prompt_json, str):
                try:
                    prompt_json = json.loads(prompt_json)
                except (json.JSONDecodeError, TypeError):
                    prompt_json = None
            if isinstance(prompt_json, dict) and prompt_json:
                try:
                    bind = build_h3_subject_bindings(
                        subject_data, prompt_json,
                        last_frame_path=last_frame_path,
                        timeline_segment=seg,
                    )
                except Exception:
                    log.warning("[MiniMaxRefDirector] build_h3_subject_bindings failed", exc_info=True)
                    bind = None
                if bind:
                    entry["prompt_json"] = prompt_json
                    entry["subject_definition"] = bind.get("subject_definition", "")
                    entry["retention_analysis"] = bind.get("retention_analysis", "")
                    entry["pictures"] = [
                        {"label": f"<Picture {i}>", "src": p} for i, p in enumerate(bind.get("images", []) or [], 1)
                    ]
                    entry["audios"] = [
                        {"label": f"<Audio {i}>", "src": a} for i, a in enumerate(bind.get("audios", []) or [], 1)
                    ]
                    entry["videos"] = [
                        {"label": f"<Video {i}>", "src": v} for i, v in enumerate(bind.get("videos", []) or [], 1)
                    ]
                    subject_defs = bind.get("subject_definition", "")
                    parts = []
                    if subject_defs:
                        parts.append(subject_defs)
                    if bind.get("retention_analysis"):
                        parts.append(bind["retention_analysis"])
                    for field in ("detailed_description", "overall_soundscape", "non_diegetic_music"):
                        val = prompt_json.get(field)
                        if isinstance(val, str) and val.strip():
                            parts.append(f"{field}:\n{val}")
                    if parts:
                        entry["h3_prompt"] = "\n\n".join(parts)
            guide_timeline.append(entry)
            prev_prompt = prompt
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
            # Easy-Use forLoopStart 的 num_loops 建议取 seg_count：
            # 循环执行 0..len(timeline) 共 len+1 轮，最后一轮 guide_index 越界，
            # MiniMaxRefGuide 发送 exception 通知并结束循环。
            "seg_count": len(guide_timeline) + 1,
        }

        log.info(
            f"[MiniMaxRefDirector] {segment_count} segments | timeline: {timeline_data} "
            f"{out_w}×{out_h} ({outpu_resolution}, {million_pixels}MP) | "
            f"{len(subject)} subjects"
        )

        # --- 视频生成已迁移到 MiniMaxRefGuide 节点 ---
        # 将 director 输出的 guide_data 接入 Easy-Use forLoop，循环内由
        # MiniMaxRefGuide 按 guide_index 逐段构建条件并生成视频。

        return io.NodeOutput(guide_data=guide_data, segment_count=segment_count+1)

NODE_CLASS_MAPPINGS = {
    "MiniMaxRefDirector": MiniMaxRefDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefDirector": "MiniMax Super Director",
}
