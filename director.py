import json
import os
import logging
from comfy_api.latest import io

from .lib.path import resolve_input_path

GuideData = io.Custom("GUIDE_DATA")
SubjectData = io.Custom("SUBJECT_DATA")

log = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_TEMPLATE = os.path.join(_PROJECT_ROOT, "prompt", "minimax_ref2v_template.txt")

# Aspect ratio presets: (width_ratio, height_ratio)
RESOLUTION_PRESETS = {
    "1:1方形":   (1, 1),
    "9:16竖屏":  (9, 16),
    "16:9横屏":  (16, 9),
    "3:2横屏":   (3, 2),
    "2:3竖屏":   (2, 3),
    "4:3横屏":   (4, 3),
    "3:4竖屏":   (3, 4),
    "21:9超宽":  (21, 9),
}


def _calc_resolution(preset: str, million_pixels: float, divide_by=32) -> tuple[int, int]:
    """Calculate width/height from aspect ratio and target megapixels.

    Computes the long side first: long = sqrt(total_pixels * long_ratio / short_ratio),
    snaps it to divide_by, then derives the short side from the snapped long side.
    Uses round-half-up to avoid Python's banker's rounding.
    """
    ratios = RESOLUTION_PRESETS.get(preset, RESOLUTION_PRESETS["16:9横屏"])
    w_ratio, h_ratio = ratios
    total_pixels = million_pixels * 1_000_000

    if total_pixels <= 0:
        return divide_by, divide_by

    def snap(v: float) -> int:
        """Round-half-up and snap to nearest multiple of divide_by."""
        return max(divide_by, int(v / divide_by + 0.5) * divide_by)

    if w_ratio >= h_ratio:
        # Landscape or square: width is the long side
        w = (total_pixels * w_ratio / h_ratio) ** 0.5
        w = snap(w)
        h = snap(w * h_ratio / w_ratio)
    else:
        # Portrait: height is the long side
        h = (total_pixels * h_ratio / w_ratio) ** 0.5
        h = snap(h)
        w = snap(h * w_ratio / h_ratio)

    return int(w), int(h)


def _read_template_file(path: str) -> str:
    search_path = resolve_input_path(path) if path else _DEFAULT_TEMPLATE
    if not search_path:
        return "{user_prompt}"
    try:
        if os.path.isfile(search_path):
            with open(search_path, "r", encoding="utf-8") as f:
                result = f.read()
                return result if result.find("{user_prompt}") != -1 else "{user_prompt}"
    except Exception:
        log.error("[MiniMaxRefDirector] Failed to read prompt_template file.")
    return "{user_prompt}"

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
                SubjectData.Input("subject_data"),
                io.String.Input(
                    "global_prompt", multiline=True, default="", force_input=True, optional=True,
                    tooltip="Conditions the entire video. Anchors persistent characters, objects, and scene context.",
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
                    "prompt_template", default="",
                    tooltip="Path to a prompt template file. Defaults to prompt/minimax_ref2v_template.txt if empty. Use {user_prompt} placeholder where the assembled prompt should be inserted.",
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
                io.Int.Output(display_name="segment_count", tooltip="Number of timeline segments."),
            ],
        )

    @classmethod
    def execute(cls, subject_data=None, global_prompt="", start_second=0.0, end_second=5.0,
                duration_seconds=5.0, start_frame=0, end_frame=120, duration_frames=120,
                prompt_template="", timeline_data="", local_prompts="", segment_lengths="",
                frame_rate=24, display_mode="seconds",  outpu_resolution="16:9横屏", million_pixels=0.6) -> io.NodeOutput:
        """Assemble guide_data from timeline, subjects, resolution, and prompt template."""
        subject = subject_data.get("subjects", []) if subject_data else []

        if not timeline_data or not timeline_data.strip():
            raise ValueError("[MiniMaxRefDirector] timeline_data is required and must not be empty.")

        # --- Read prompt_template file ---
        template_content = _read_template_file(prompt_template)

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
            prompt = template_content.replace("{user_prompt}", prompt)
            guide_timeline.append({
                "prompt": prompt,
                "prev_prompt": prev_prompt,
                "first_frame": first_frame,
                "duration_frames": dur,
                "prompt_enhance": seg.get("prompt_enhance", "Default"),
                "is_end_frame": seg.get("isEndFrame", False)
            })
            prev_prompt = prompt
            segment_count += 1

        # --- Resolve output resolution ---
        out_w, out_h = _calc_resolution(outpu_resolution, million_pixels)

        # --- Assemble guide_data ---
        guide_data = {
            "width": out_w,
            "height": out_h,
            "global_prompt": global_prompt,
            "frame_rate": float(frame_rate),
            "subject_data": subject,
            "timeline_data": guide_timeline,
        }

        log.info(
            f"[MiniMaxRefDirector] {segment_count} segments | timeline: {timeline_data} "
            f"{out_w}×{out_h} ({outpu_resolution}, {million_pixels}MP) | "
            f"{len(subject)} subjects | template: {len(template_content)} chars"
        )

        return io.NodeOutput(
            guide_data,
            segment_count,
        )

NODE_CLASS_MAPPINGS = {
    "MiniMaxRefDirector": MiniMaxRefDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefDirector": "MiniMax Super Director",
}
