import json
import os
import logging
import re
import torch
import folder_paths
from comfy_api.latest import io

from .minimax_ref_prompt_enhance import generate_prompt_with_clip
from .lib import find_index, load_image_tensor, load_audio_tensor, resolve_input_path

GuideData = io.Custom("GUIDE_DATA")

log = logging.getLogger(__name__)

_ROLE_KEY_RE = re.compile(r"^ROLE_(\d+)$")
_DIALOGUE_KEY_RE = re.compile(r"^ROLE_(\d+)_DIALOGUE_\d+$")


class MiniMaxRefDirectorGuide(io.ComfyNode):
    """Extracts segment-specific data from MiniMaxRefDirector's guide_data by seg_index,
    loading subject reference images as [H,W,C] tensors and audio as waveform tensors."""

    @classmethod
    def define_schema(cls):
        text_encoders = folder_paths.get_filename_list("text_encoders")
        clip_types = ["qwen3vl", "minimax"]
        return io.Schema(
            node_id="MiniMaxRefDirectorGuide",
            display_name="MiniMax Reference Director Guide",
            category="minimaxrefdirector",
            description=(
                "Given a guide_data from MiniMax Reference Director and a segment index, "
                "loads all referenced subject images/audio as tensors and outputs the segment prompt."
            ),
            inputs=[
                GuideData.Input(
                    "guide_data",
                    tooltip="Connect from MiniMax Reference Director's guide_data output.",
                ),
                io.Image.Input(
                    "first_frame", optional=True,
                    tooltip="Use first frame input if it's not set",
                ),
                io.Clip.Input(
                    "clip", optional=True,
                    tooltip="External CLIP model input (priority over clip_name/clip_type). Connect from a CLIP Loader node.",
                ),
                io.Combo.Input(
                    "clip_name",
                    options=text_encoders,
                    default=text_encoders[0] if text_encoders else "",
                    tooltip="Choose text encoder（CLIP/VL）text_encodes (used when no external clip connected).",
                ),
                io.Combo.Input(
                    "clip_type",
                    options=clip_types,
                    default="qwen3vl",
                    tooltip="CLIP model type (used when no external clip connected).",
                ),
                io.Int.Input(
                    "seed",
                    optional=True,
                    display_name="seed",
                    default=42,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    tooltip="Random seed, forwarded to CLIP model generation",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "last_refer_mode", default=False,
                    tooltip="Whether to use the last reference frame as the first frame of the next segment.",
                ),
                io.Combo.Input(
                    "prompt_enhance",
                    options=["Basic", "Enhanced", "Pre-formatted"],
                    default="Basic",
                    tooltip="Prompt enhancement mode: Basic=standard generation | Enhanced=polish + fill ambient sound / camera movement / BGM | Pre-formatted=parse prompt as pre-formatted JSON (no VLM)",
                ),
                io.Int.Input(
                    "seg_index", default=0, min=0, max=1000, step=1,
                    tooltip="Index of the timeline segment to extract (0-based).",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="image0", tooltip="Reference image0."),
                io.Image.Output(display_name="image1", tooltip="Reference image1."),
                io.Image.Output(display_name="image2", tooltip="Reference image2."),
                io.Image.Output(display_name="image3", tooltip="Reference image3."),
                io.Image.Output(display_name="image4", tooltip="Reference image4."),
                io.Image.Output(display_name="image5", tooltip="Reference image5."),
                io.Image.Output(display_name="image6", tooltip="Reference image6."),
                io.Image.Output(display_name="image7", tooltip="Reference image7."),
                io.Image.Output(display_name="image8", tooltip="Reference image8."),
                io.Audio.Output(display_name="audio0", tooltip="Reference audio0."),
                io.Audio.Output(display_name="audio1", tooltip="Reference audio1."),
                io.Audio.Output(display_name="audio2", tooltip="Reference audio2."),
                io.Int.Output(display_name="width", tooltip="Output width from global config."),
                io.Int.Output(display_name="height", tooltip="Output height from global config."),
                io.Int.Output(display_name="length", tooltip="Frame count."),
                io.Float.Output(display_name="frame_rate", tooltip="Frame rate from global config."),
                io.String.Output(display_name="prompt", tooltip="Fully assembled prompt for the selected segment."),
                io.String.Output(display_name="raw_prompt", tooltip="Raw prompt for the selected segment."),
                io.String.Output(display_name="pre_formatted", tooltip="Prompt as pre-formatted JSON"),
            ],
        )

    @classmethod
    def execute(cls, guide_data=None, first_frame=None, clip=None, clip_name="", clip_type="qwen3vl", seed=42, 
                last_refer_mode=False, prompt_enhance="Basic", seg_index=0) -> io.NodeOutput:
        """Extract segment-level data and load all referenced subject images/audio."""

        if guide_data is None:
            raise ValueError("[MiniMaxRefDirectorGuide] guide_data is required and must not be empty.")

        # --- Parse global config ---
        out_w = int(guide_data.get("width", 1920))
        out_h = int(guide_data.get("height", 1080))
        fps = float(guide_data.get("frame_rate", 24))
        global_prompt = guide_data.get("global_prompt", "") or ""
        subject_data = guide_data.get("subject_data", []) or []
        timeline = guide_data.get("timeline_data", []) or []

        segment_count = len(timeline)
        if segment_count == 0:
            raise ValueError("[MiniMaxRefDirectorGuide] guide_data.timeline_data is required and must not be empty.")

        # --- Clamp seg_index ---
        idx = max(0, min(int(seg_index), segment_count - 1))

        # --- Extract segment data ---
        seg = timeline[idx]
        prompt = str(seg.get("prompt", ""))
        prev_prompt = str(seg.get("prev_prompt", ""))
        prev_prompt = prev_prompt if last_refer_mode else ""
        director_first_frame = seg.get("first_frame", "")
        duration_frames = seg.get("duration_frames", 0)
        # --- Determine effective prompt_enhance: per-segment overrides global when not "Default" ---
        seg_prompt_enhance = seg.get("prompt_enhance", "Default")
        effective_prompt_enhance = seg_prompt_enhance if seg_prompt_enhance != "Default" else prompt_enhance

        if effective_prompt_enhance == "Pre-formatted":
            # "Pre-formatted" mode: skip VLM
            if director_first_frame:
                input_first_frame = load_image_tensor(director_first_frame)
            else:
                input_first_frame = None
        else:
            if director_first_frame:
                input_first_frame = load_image_tensor(director_first_frame)
            else:
                input_first_frame = first_frame if last_refer_mode else None

        result = cls._process_prompt(
            subject_data=subject_data,
            global_prompt=global_prompt,
            prompt=prompt,
            duration_frames=duration_frames,
            first_frame=input_first_frame,
            last_prompt=prev_prompt,
            clip=clip,
            clip_name=clip_name,
            clip_type=clip_type,
            frame_rate=fps,
            enhance=effective_prompt_enhance,
            seed=seed,
        )
        # --- Load all referenced subject images as [C, H, W] tensors ---
        images = []
        audios = []

        for subject_item in result["subjects"]:
            subject = subject_item.get("subject", {})

            if subject_item.get("subject_definition", None):
                image_file = subject.get("imageFile", "")
                if isinstance(image_file, torch.Tensor):
                    images.append(image_file)
                else:
                    # Load image
                    image_path = resolve_input_path(str(subject.get("imageFile", "")))
                    if image_path and os.path.exists(image_path):
                        img_tensor = load_image_tensor(image_path)
                        images.append(img_tensor)
                    else:
                        images.append(None)

            # Load audio if available
            if subject_item.get("audio_definition", None):
                audio_path = resolve_input_path(str(subject.get("audioFile", "")))
                if audio_path and os.path.exists(audio_path):
                    audio_tensor = load_audio_tensor(audio_path)
                    audios.append(audio_tensor)
                else:
                    audios.append(None)

        # Pad/truncate images to match 10 output slots
        while len(images) < 9:
            images.append(None)
        images = images[:9]

        # Pad/truncate audios to match 3 output slots
        while len(audios) < 3:
            audios.append(None)
        audios = audios[:3]

        log.info(
            f"[MiniMaxRefDirectorGuide] seg_index={idx}/{segment_count} | "
            f"subjects={len(subject_data)} | images={len(images)} audios={len(audios)} | "
            f"{out_w}×{out_h} @ {fps}fps | length={duration_frames} | effective_prompt_enhance={effective_prompt_enhance} | "
            f"first_frame={'Yes' if input_first_frame is not None else 'No'}"
        )
        
        return io.NodeOutput(
            *images,
            *audios,
            out_w,
            out_h,
            result["duration_frames"],
            fps,
            result["prompt"],
            result["raw_prompt"],
            result['pre_formatted']
        )


    @classmethod
    def _process_prompt(cls, subject_data: list[dict], global_prompt: str, prompt: str,
                       duration_frames: int, first_frame: torch.Tensor|None = None, last_prompt: str = "",
                       clip=None, clip_name: str = "", clip_type: str = "qwen3vl",
                       frame_rate: float = 24.0, enhance: str = "Basic", seed: int = 42) -> dict:
        """Process a single segment prompt: call VLM enhancement → parse mapping → build subject_definitions / retention_analysis."""

        # Call VLM to generate enhanced prompt
        duration_sec = max(duration_frames / max(frame_rate, 1.0), 0.1)
        clip_result = generate_prompt_with_clip(
            image=first_frame,
            clip=clip,
            clip_name=clip_name,
            clip_type=clip_type,
            last_prompt=last_prompt,
            prompt=prompt,
            duration=duration_sec,
            fps=frame_rate,
            enhance=enhance,
            seed=seed,
        )

        # Parse mapping
        mapping_data = clip_result.get("mapping", {})
        if isinstance(mapping_data, str):
            try:
                mapping_data = json.loads(mapping_data)
            except json.JSONDecodeError:
                mapping_data = {}

        # Build subject_definitions / retention_analysis
        subjects, replacements, subject_definitions, retention_analysis = cls._build_subject_definitions_and_retention(subject_data, mapping_data)

        if first_frame is not None:
            subject_definitions, retention_analysis = cls._build_first_frame_definition_and_retention(subjects, subject_definitions, retention_analysis)
            length = len(subjects) - 1
            subjects.append({
                "subject": {
                    "name": "First frame",
                    "description": "The first frame of the video",
                    "imageFile": first_frame,
                    "audioFile": "",
                },
                "first_frame": True,
                "subject_definition": f"<Picture {length + 1}>",
                "audio_definition": None
            })
        # Build detailed_description / overall_soundscape / non_diegetic_music
        shot1_desc = clip_result.get("shot1_description", None)
        if shot1_desc:
            for key, value in replacements.items():
                shot1_desc = shot1_desc.replace(key, value)
        detailed_description = clip_result.get("detailed_description", "")
        for key, value in replacements.items():
            detailed_description = detailed_description.replace(key, value)
        if shot1_desc:
            # Safety: strip any leading [Shot 1] that may have slipped through
            # (prompt templates now instruct VLM to start from [Shot 2] when first frame exists)
            detailed_description = re.sub(r'^\[Shot 1\]\s*', '', detailed_description.lstrip())
            shot_start = "[Shot 2] " if not detailed_description.startswith("[Shot ") else ""
            detailed_description = (
                f"[Shot 1] {shot1_desc}\n"
                f"{shot_start}{detailed_description}"
            )
        else:
            shot_start = "[Shot 1] " if not detailed_description.startswith("[Shot ") else ""
            detailed_description = f"{shot_start}{detailed_description}"
        detailed_description = global_prompt + "\n" + detailed_description
        overall_soundscape = clip_result.get("overall_soundscape", None)
        if overall_soundscape:
            for key, value in replacements.items():
                overall_soundscape = overall_soundscape.replace(key, value)
        non_diegetic_music = clip_result.get("non_diegetic_music", None)
        if non_diegetic_music:
            for key, value in replacements.items():
                non_diegetic_music = non_diegetic_music.replace(key, value)
        overall_soundscape = overall_soundscape if overall_soundscape else "None"
        non_diegetic_music = non_diegetic_music if non_diegetic_music else "None"
        final_prompt_attr = {
            "subject_definitions": subject_definitions,
            "retention_analysis": retention_analysis,
            "detailed_description": detailed_description,
            "overall_soundscape": overall_soundscape,
            "non_diegetic_music": non_diegetic_music,
        }
        final_prompt = ""
        for key, value in final_prompt_attr.items():
            final_prompt += f"{key}:\n{value}\n"

        raw_prompt = ""
        detailed_description = clip_result.get("detailed_description", "")
        detailed_description = cls._build_raw_prompt(detailed_description, mapping_data)
        raw_prompt += f"{detailed_description}\n"
        overall_soundscape = clip_result.get("overall_soundscape", None)
        if overall_soundscape:
            overall_soundscape = cls._build_raw_prompt(overall_soundscape, mapping_data)
            raw_prompt += f"{overall_soundscape}\n"
        non_diegetic_music = clip_result.get("non_diegetic_music", None)
        if non_diegetic_music:
            non_diegetic_music = cls._build_raw_prompt(non_diegetic_music, mapping_data)
            raw_prompt += f"{non_diegetic_music}\n"

        pre_formatted = json.dumps({
            "shot1_description": clip_result.get("shot1_description", None),
            "detailed_description": clip_result.get("detailed_description", ""),
            "overall_soundscape": clip_result.get("overall_soundscape") or None,
            "non_diegetic_music": clip_result.get("non_diegetic_music") or None,
            "mapping": mapping_data,
        }, ensure_ascii=False, indent=2)

        return {
            "subjects": subjects,
            "prompt": final_prompt,
            "raw_prompt": raw_prompt,
            "pre_formatted": pre_formatted,
            "first_frame": first_frame is not None,
            "duration_frames": duration_frames,
        }

    @classmethod
    def _build_raw_prompt(cls, prompt: str, mapping_data: dict[str, str]) -> str:
        for key, value in sorted(mapping_data.items(), key=lambda x: len(x[0]), reverse=True) :
            if prompt.find("{{" + key + "}}") == -1:
                continue
            if key.find("_DIALOGUE_") != -1:
                value = re.sub(r"\[[a-zA-Z]+\]", "", value)
                value = f"\"{value}\""
            prompt = prompt.replace("{{" + key + "}}", value)
        return prompt

    @classmethod
    def _build_first_frame_definition_and_retention(cls, subjects: list[dict], subject_definitions: str, retention_analysis: str) -> tuple[str, str]:
        length = len(subjects)
        subject_definitions += "\n" + f"<Picture {length + 1}> is the first frame of [Shot 1]."
        retention_analysis += "\n" + f"<Picture {length + 1}> ([Shot 1] first frame): fully_preserved."
        return subject_definitions, retention_analysis

    @classmethod
    def _build_subject_definitions_and_retention(cls, subject_data: list[dict], mapping: dict) -> tuple[list[dict], dict[str, str], str, str]:
        """Build subject_definitions and retention_analysis from mapping.

        subject_definitions format:
            <Subject 1> is {role_name}
            <Audio 1> is the voice timbre reference for <Subject 1>'s voice, ...

        retention_analysis format:
            <Subject 1> fully_preserved
            <Audio 1>: reference - ...
        """
        subjects: list[dict] = []           # [{index: role_name}]
        replacements: dict[str, str] = {}   # {key: value}

        for key, value in mapping.items():
            rKey = "{{" + key + "}}"
            replacements[rKey] = value
            dm = _DIALOGUE_KEY_RE.match(key)
            if dm:
                replacements[rKey] = f"<d>{value}</d>"
                role_key = f"ROLE_{dm.group(1)}"
                if role_key not in mapping:
                    continue
                role_name = mapping[role_key]
                # Find corresponding subject
                subject_data_index = find_index(subject_data, lambda x, name=role_name: x["name"] == name)
                if subject_data_index == -1:
                    continue
                # Add subject
                index = find_index(subjects, lambda x, dm=dm: x["index"] == int(dm.group(1)))
                if index > -1:
                    subjects[index]["audio_definition"] = f"<Audio {index + 1}>"
                else:
                    length = len(subjects)
                    subjects.append({
                        "index": int(dm.group(1)),
                        "subject": subject_data[subject_data_index],
                        "subject_definition": f"<Subject {length + 1}>",
                        "audio_definition": f"<Audio {length + 1}>"
                    })
            m = _ROLE_KEY_RE.match(key)
            if m:
                index = find_index(subjects, lambda x, m=m: x["index"] == int(m.group(1)))
                if index == -1:
                    # Find corresponding subject
                    subject_data_index = find_index(subject_data, lambda x, name=value: x["name"] == name)
                    if subject_data_index == -1:
                        continue
                    length = len(subjects)
                    subject_definition = f"<Subject {length + 1}>"
                    subjects.append({
                        "index": int(m.group(1)),
                        "subject": subject_data[subject_data_index],
                        "subject_definition": subject_definition,
                        "audio_definition": None
                    })
                    replacements[rKey] = subject_definition
                else:
                    replacements[rKey] = subjects[index]["subject_definition"]

        subject_lines: list[str] = []
        retention_lines: list[str] = []

        for value in subjects:
            subject_lines.append(f"{value['subject_definition']} {value['subject']['description']}")
            retention_lines.append(f"{value['subject_definition']}: fully_preserved")
            if value["audio_definition"]:
                subject_lines.append(f"{value['audio_definition']} is the voice-timbre reference for "
                                    f"{value['subject_definition']}")
                retention_lines.append(f"{value['audio_definition']}: reference - the target speaker follows "
                                    f"{value['audio_definition']}'s voice timbre and measured delivery "
                                    f"without copying the original signal.")

        return subjects, replacements, "\n".join(subject_lines), "\n".join(retention_lines)


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefDirectorGuide": MiniMaxRefDirectorGuide,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefDirectorGuide": "MiniMax Reference Director Guide",
}
