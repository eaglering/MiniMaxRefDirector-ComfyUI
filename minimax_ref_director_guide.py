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
                io.Combo.Input(
                    "clip_name",
                    options=text_encoders,
                    default=text_encoders[0] if text_encoders else "",
                    tooltip="Choose text encoder（CLIP/VL）text_encodes",
                ),
                io.Combo.Input(
                    "clip_type",
                    options=clip_types,
                    default="qwen3vl",
                    tooltip="CLIP model type",
                ),
                io.Int.Input(
                    "seed",
                    optional=True,
                    display_name="seed",
                    default=42,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    tooltip="随机种子，传递给 CLIP 模型生成",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "last_refer_mode", default=False,
                    tooltip="Whether to use the last reference frame as the first frame of the next segment.",
                ),
                io.Boolean.Input(
                    "prompt_enhance", default=False,
                    tooltip="Whether to enhance the prompt generation.",
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
            ],
        )

    @classmethod
    def execute(cls, guide_data=None, first_frame=None, clip_name="", clip_type="qwen3vl", seed=42, 
                last_refer_mode=False, prompt_enhance=False, seg_index=0) -> io.NodeOutput:
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
        frame_refer = seg.get("first_frame", "")
        duration_frames = seg.get("duration_frames", 0)
        if frame_refer:
            first_frame = load_image_tensor(frame_refer)
        else:
            first_frame = first_frame if last_refer_mode else None

        result = cls._process_prompt(
            subject_data=subject_data,
            global_prompt=global_prompt,
            prompt=prompt,
            duration_frames=duration_frames,
            first_frame=first_frame,
            last_prompt=prev_prompt,
            clip_name=clip_name,
            clip_type=clip_type,
            frame_rate=fps,
            enhance=prompt_enhance,
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
            f"{out_w}×{out_h} @ {fps}fps | length={duration_frames} | first_frame={'Yes' if first_frame is not None else 'No'}"
        )
        
        return io.NodeOutput(
            *images,
            *audios,
            out_w,
            out_h,
            result["duration_frames"],
            fps,
            result["prompt"],
        )


    @classmethod
    def _process_prompt(cls, subject_data: list[dict], global_prompt: str, prompt: str,
                       duration_frames: int, first_frame: torch.Tensor|None = None, last_prompt: str = "",
                       clip_name: str = "", clip_type: str = "qwen3vl",
                       frame_rate: float = 24.0, enhance: bool = False, seed: int = 42) -> dict:
        """处理单个分镜提示词：调用 VLM 增强 → 解析 mapping → 构建 subject_definitions / retention_analysis。"""

        # 调用 VLM 生成增强提示词
        duration_sec = max(duration_frames / max(frame_rate, 1.0), 0.1)
        clip_result = generate_prompt_with_clip(
            clip_name=clip_name,
            clip_type=clip_type,
            image=first_frame,
            last_prompt=last_prompt,
            prompt=prompt,
            duration=duration_sec,
            fps=frame_rate,
            enhance=enhance,
            seed=seed,
        )

        # 解析 mapping
        mapping_data = clip_result.get("mapping", {})
        if isinstance(mapping_data, str):
            try:
                mapping_data = json.loads(mapping_data)
            except json.JSONDecodeError:
                mapping_data = {}

        # 构建 subject_definitions / retention_analysis
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
                "subject_definition": f"<Subject {length + 1}>",
                "audio_definition": None
            })
        # 构建 detailed_description / overall_soundscape / non_diegetic_music
        detailed_description = clip_result.get("detailed_description", "")
        for key, value in replacements.items():
            detailed_description = detailed_description.replace(key, value)
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
        return {
            "subjects": subjects,
            "prompt": final_prompt,
            "first_frame": first_frame is not None,
            "duration_frames": duration_frames,
        }

    @classmethod
    def _build_first_frame_definition_and_retention(cls, subjects: list[dict], subject_definitions: str, retention_analysis: str) -> tuple[str, str]:
        length = len(subjects)
        subject_definitions += "\n" + f"<Subject {length + 1}> is the first frame of the video."
        retention_analysis += "\n" + f"<Subject {length + 1}> (appears in [Shot 1]): fully_preserved"
        return subject_definitions, retention_analysis

    @classmethod
    def _build_subject_definitions_and_retention(cls, subject_data: list[dict], mapping: dict) -> tuple[list[dict], dict[str, str], str, str]:
        """从 mapping 构建 subject_definitions 和 retention_analysis。

        subject_definitions 格式:
            <Subject 1> is {角色名}
            <Audio 1> is the voice timbre reference for <Subject 1>'s voice, ...

        retention_analysis 格式:
            <Subject 1> fully_preserved
            <Audio 1>: reference - ...
        """
        subjects: list[dict] = []      # {index: 角色名}
        replacements: dict[str, str] = {}  # {key: value}

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
                # 找到对应的主体
                subject_data_index = find_index(subject_data, lambda x, name=role_name: x["name"] == name)
                if subject_data_index == -1:
                    continue
                # 增加主体
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
                    # 找到对应的主体
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
                subject_lines.append(f"{value['audio_definition']} is the voice timbre reference for "
                                    f"{value['subject_definition']}'s voice, containing a spoken voiceover.")
                retention_lines.append(f"{value['audio_definition']}: reference - the target audio references "
                                    f"the voice timbre from {value['audio_definition']} to generate "
                                    f"{value['subject_definition']}'s spoken dialogue.")

        return subjects, replacements, "\n".join(subject_lines), "\n".join(retention_lines)


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefDirectorGuide": MiniMaxRefDirectorGuide,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefDirectorGuide": "MiniMax Reference Director Guide",
}
