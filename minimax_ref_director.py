import json
import os
import re
import logging
import folder_paths
from comfy_api.latest import io

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
    """Read prompt template file. Falls back to default if path is empty."""
    search_path = path.strip() if path and path.strip() else _DEFAULT_TEMPLATE

    # Try absolute path
    if os.path.isabs(search_path):
        try:
            if os.path.isfile(search_path):
                with open(search_path, "r", encoding="utf-8") as f:
                    return f.read()
        except Exception:
            pass

    # Try relative to ComfyUI input directory
    try:
        full = os.path.join(folder_paths.get_input_directory(), search_path)
        if os.path.isfile(full):
            with open(full, "r", encoding="utf-8") as f:
                return f.read()
    except Exception:
        pass

    # Try relative to ComfyUI base directory
    try:
        base = os.path.dirname(os.path.dirname(folder_paths.get_input_directory()))
        full = os.path.join(base, search_path)
        if os.path.isfile(full):
            with open(full, "r", encoding="utf-8") as f:
                return f.read()
    except Exception:
        pass

    # Try relative to project root
    try:
        full = os.path.join(_PROJECT_ROOT, search_path) if not os.path.isabs(search_path) else search_path
        if os.path.isfile(full):
            with open(full, "r", encoding="utf-8") as f:
                return f.read()
    except Exception:
        pass

    # Fallback: try default template from project root
    try:
        if os.path.isfile(_DEFAULT_TEMPLATE):
            with open(_DEFAULT_TEMPLATE, "r", encoding="utf-8") as f:
                log.warning(f"[MiniMaxRefDirector] prompt_template not found, using default: {_DEFAULT_TEMPLATE}")
                return f.read()
    except Exception:
        pass

    log.warning(f"[MiniMaxRefDirector] Could not read prompt_template file: {search_path}")
    return "{user_prompt}"


def _contains_chinese(text: str) -> bool:
    """Check if text contains Chinese characters (CJK Unified Ideographs)."""
    return bool(re.search(r'[\u4e00-\u9fff\u3400-\u4dbf]', text))


def _process_dialogue(prompt: str) -> str:
    """Detect dialogue in [], 【】, Chinese quotes (""), or English quotes (""),
    and wrap them with <d> tags indicating language: Chinese or English.
    """
    # Pattern: [...]  or 【】 or Chinese quotes "..."  or  English quotes "..."
    dialogue_pattern = re.compile(
        r'\[([^\]]*)\]'
        r'|\u3010([^\u3011]*?)\u3011'
        r'|\u201c([^\u201d]*?)\u201d'
        r'|"([^"]*?)"'
    )

    def _replacer(m: re.Match) -> str:
        content = m.group(1) or m.group(2) or m.group(3) or m.group(4) or ""
        if not content.strip():
            return m.group(0)
        lang = "Chinese" if _contains_chinese(content) else "English"
        return f"<d>[{lang}]{content}</d>"

    return dialogue_pattern.sub(_replacer, prompt)


def _parse_references(prompt: str, subjects: list[dict]) -> tuple[list[int], str]:
    """
    Parse @SubjectName and @SubjectName-音频 references in a prompt.

    Sorts subject names by length (longest first), then for each name:
      1. Check @name-音频  → audio reference
      2. Check @name       → picture reference

    Returns:
        subject_index: ordered list of unique subject indices (audio-referenced first)
        rewritten_prompt: prompt with @refs replaced by <Picture N> / <Audio M>
    """
    if not prompt or not subjects:
        return [], prompt or ""

    # Build (name, index) pairs sorted by name length descending (longest first)
    name_idx_pairs: list[tuple[str, int]] = []
    for idx, subj in enumerate(subjects):
        name = subj.get("name", "").strip()
        if name:
            name_idx_pairs.append((name, idx))
    name_idx_pairs.sort(key=lambda x: len(x[0]), reverse=True)

    audio_subjects: set[int] = set()
    all_subjects: set[int] = set()

    # Phase 1: match @name-音频 first
    for name, idx in name_idx_pairs:
        if f"@{name}-音频" in prompt:
            audio_subjects.add(idx)
            all_subjects.add(idx)

    # Phase 2: match @name
    for name, idx in name_idx_pairs:
        if f"@{name}" in prompt:
            all_subjects.add(idx)

    if not all_subjects:
        return [], prompt

    # Build ordered subject_index: audio-referenced first, then non-audio
    audio_list = sorted(audio_subjects)
    non_audio_list = sorted(all_subjects - audio_subjects)
    subject_index = audio_list + non_audio_list

    # Build 1-based picture/audio number mappings
    pic_map = {sid: i + 1 for i, sid in enumerate(subject_index)}
    audio_map = {sid: i + 1 for i, sid in enumerate(audio_list)}

    # Build replacements sorted by length descending (longer first)
    replacements: list[tuple[str, str]] = []
    for name, idx in name_idx_pairs:
        if idx in audio_subjects:
            old = f"@{name}-音频"
            new = f"(参考音频<Audio {audio_map[idx]}>)"
            replacements.append((old, new))
        if idx in all_subjects:
            old = f"@{name}"
            new = f"<Picture {pic_map[idx]}>"
            replacements.append((old, new))

    replacements.sort(key=lambda x: len(x[0]), reverse=True)

    rewritten = prompt
    for old, new in replacements:
        rewritten = rewritten.replace(old, new)

    return subject_index, rewritten


def _build_segment_prompt(
    user_prompt: str,
    subject_index: list[int],
    subjects: list[dict],
    global_prompt: str,
    template_content: str,
) -> str:
    """Build the final segment prompt with reference pictures, story content, global prompt, and template wrapping."""

    # --- 【参考图片】section ---
    picture_lines = []
    for i, sid in enumerate(subject_index):
        pic_num = i + 1
        if 0 <= sid < len(subjects):
            desc = subjects[sid].get("description", "")
            picture_lines.append(f"<Picture {pic_num}> {desc}")
        else:
            picture_lines.append(f"<Picture {pic_num}>")

    # --- 【故事内容】section ---
    story = user_prompt

    # --- Assemble ---
    parts = []
    if picture_lines:
        parts.append("主体定义：\n" + "\n".join(picture_lines))
    parts.append(f"详情描述：\n{{first_frame}}{story}")

    assembled = "\n\n".join(parts)

    # Prepend global_prompt
    if global_prompt and global_prompt.strip():
        assembled = "摘要：\n" + global_prompt.strip() + "\n" + assembled

    # Wrap with template if {user_prompt} placeholder exists
    if "{user_prompt}" in template_content:
        final_prompt = template_content.replace("{user_prompt}", assembled)
    else:
        final_prompt = assembled

    return final_prompt


class MiniMaxRefDirector(io.ComfyNode):
    """Timeline director with resolution config and guide_data output for MiniMax pipelines."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefDirector",
            display_name="MiniMax Reference Director",
            category="minimax",
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
                frame_rate=24, display_mode="seconds",
                outpu_resolution="16:9横屏", million_pixels=0.6) -> io.NodeOutput:
        """Assemble guide_data from timeline, subjects, resolution, and prompt template."""
        log.info(f"[MiniMaxRefDirector] subject_data: {subject_data}, {local_prompts}, {global_prompt}")
        subject = subject_data.get("subjects", []) or []

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

        # --- Build timeline_data array for guide_data ---
        guide_timeline = []
        segment_count = 0

        def _process_prompt(raw_prompt: str, dur_arg: int, first_frame_arg=None):
            dialogue_processed = _process_dialogue(raw_prompt)
            subject_index, rewritten = _parse_references(dialogue_processed, subject)
            final_prompt = _build_segment_prompt(
                user_prompt=rewritten,
                subject_index=subject_index,
                subjects=subject,
                global_prompt=global_prompt,
                template_content=template_content,
            )
            return {
                "subject_index": subject_index,
                "prompt": final_prompt,
                "first_frame": first_frame_arg,
                "duration_frames": dur_arg,
            }

        for idx, seg in enumerate(timeline_segments):
            # Durations from segment_lengths are always in pixel-space frames
            dur = int(seg.get("length", 1))
            seg_start = seg.get("start", 0)
            seg_start_frames = int(seg_start)
            seg_end_frames = seg_start_frames + dur

            if seg_start_frames < range_start:
                seg_start_frames = range_start
            if seg_end_frames > range_end:
                seg_end_frames = range_end

            dur = seg_end_frames - seg_start_frames
            if dur <= 0:
                continue
            first_frame = seg.get("imageFile", "") if seg.get("type", "text") == "image" else ""
            guide_timeline.append(_process_prompt(seg.get("prompt", ""), dur, first_frame))
            segment_count += 1

        # Guarantee at least 1 segment
        if segment_count == 0:
            final_prompt = _build_segment_prompt(
                user_prompt="",
                subject_index=[],
                subjects=subject,
                global_prompt=global_prompt,
                template_content=template_content,
            )
            guide_timeline.append({
                "subject_index": [],
                "prompt": final_prompt,
                "duration_frames": max(end_frame - start_frame, 1),
            })
            segment_count = 1

        # --- Resolve output resolution ---
        out_w, out_h = _calc_resolution(outpu_resolution, million_pixels)

        # --- Assemble guide_data ---
        guide_data = {
            "subjects": subject,
            "width": out_w,
            "height": out_h,
            "frame_rate": float(frame_rate),
            "prompt_template": template_content,
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
