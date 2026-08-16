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
        timeline_data_len = len(timeline_segments)

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
            prompt_json = cls._transfer_prompt_json(h3_prompt_json, global_prompt=global_prompt, mapping=mapping)
            last_frame_path = ""
            if i + 1 < timeline_data_len and seg.get("autoEndFrame", False):
                last_frame_path = timeline_segments[i + 1].get("imageFile", "")
            prompt_res = build_h3_subject_bindings(subject_data=subject, prompt_json=prompt_json,
                                               last_frame_path=last_frame_path, timeline_segment=seg)
            mapping = prompt_res.get("mapping", {})
            subject_definitions = prompt_res.get("subject_definitions", "")
            retention_analysis = prompt_res.get("retention_analysis", "")
            detailed_description = prompt_res.get("detailed_description", "")
            overall_soundscape = prompt_res.get("overall_soundscape", "") if prompt_res.get("detailed_description", "") else "N/A"
            non_diegetic_music = prompt_res.get("non_diegetic_music", "") if prompt_res.get("detailed_description", "") else "N/A"
            prompt = "subject_definitions:\n" + subject_definitions + "\n"
            prompt += "retention_analysis:\n" + retention_analysis + "\n"
            prompt += "detailed_description:\n" + detailed_description + "\n"
            prompt += "overall_soundscape:\n" + overall_soundscape + "\n"
            prompt += "non_diegetic_music:\n" + non_diegetic_music
            entry = {
                "prompt": prompt,
                "subjects": seg.get("subjects", ""),
                "images": seg.get("images", []),
                "audios": seg.get("audios", []),
                "videos": seg.get("videos", []),
                "duration_frames": dur,
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
            "seg_count": len(guide_timeline) + 1,
        }

        log.info(
            f"[MiniMaxRefDirector] {segment_count} segments | timeline: {timeline_data} "
            f"{out_w}×{out_h} ({outpu_resolution}, {million_pixels}MP) | "
            f"{len(subject)} subjects | {global_prompt} | {last_frame_path}"
        )

        return io.NodeOutput(guide_data=guide_data, segment_count=segment_count+1)

    @classmethod
    def _transfer_prompt_json(cls, h3_prompt_json: str, global_prompt: str, mapping: dict) -> list:
        for k, v in mapping.items():
            h3_prompt_json = h3_prompt_json.replace(k, v)
        lines = h3_prompt_json.split("\n")
        prompt_json = {
            "detailed_description": "",
            "overall_soundscape": "",
            "non_diegetic_music": ""
        }
        section = "detail"
        detail_lines = []
        for line in lines:
            if line.startswith("detailed_description:"):
                section = "detail"
                continue
            if line.startswith("overall_soundscape:"):
                section = "overall"
                continue
            if line.startswith("non_diegetic_music:"):
                section = "music"
                continue
            if section == "detail":
                detail_lines.append(line)
            elif section == "overall":
                if line.strip() != "" and line.strip() != "N/A":
                    prompt_json["overall_soundscape"] = line
            elif section == "music":
                if line.strip() != "" and line.strip() != "N/A":
                    prompt_json["non_diegetic_music"] = line
        prompt_json["detailed_description"] = global_prompt + "\n" + "\n".join(detail_lines)
        return prompt_json

NODE_CLASS_MAPPINGS = {
    "MiniMaxRefDirector": MiniMaxRefDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefDirector": "MiniMax Super Director",
}
