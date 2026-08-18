
import json
import os
import re
import logging

import folder_paths
import torch
from PIL import Image

from .image import load_image_tensor
from .llm import generate_prompt_with_api, generate_prompt_with_llama
from .path import resolve_input_path
from .utils import find_index, parse_generated_json

try:
    from comfy_api.latest import VideoFromFile
except ImportError:  # pragma: no cover
    from comfy_api.latest._input_impl import VideoFromFile

log = logging.getLogger(__name__)

def _save_frame_tensor(frame, out_path: str) -> None:
    """把 H3 解码出的一帧 [H, W, C] float 张量保存为 PNG。"""
    arr = (frame.clamp(0.0, 1.0) * 255.0).round().to(torch.uint8).cpu().numpy()
    Image.fromarray(arr).save(out_path)

def _extract_video_frames(video_path: str, video_start: int, video_duration: int):
    """从视频文件中提取首帧和尾帧图片路径。

    首帧位置 = video_start，尾帧位置 = video_start + video_duration（越界时取最后一帧）。
    返回 (首帧路径, 尾帧路径)；任一提取/保存失败时对应路径返回 ""。
    """
    try:
        abs_path = resolve_input_path(video_path)
        if not abs_path:
            log.warning(f"[MiniMaxRefDirector] video file not found: {video_path!r}")
            return "", ""
        frames = VideoFromFile(abs_path).get_components().images  # [N, H, W, C]
    except Exception as exc:
        log.warning(f"[MiniMaxRefDirector] failed to load video {video_path!r}: {exc}")
        return "", ""

    total = frames.shape[0]
    if total <= 0:
        return "", ""

    first_idx = max(0, min(int(video_start or 0), total - 1))
    last_idx = max(0, min(int(video_start or 0) + int(video_duration or 0), total - 1))

    try:
        out_dir = os.path.join(folder_paths.get_temp_directory(), "minimaxrefdirector")
        os.makedirs(out_dir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(abs_path))[0]
        first_path = os.path.join(out_dir, f"{stem}_first.png")
        last_path = os.path.join(out_dir, f"{stem}_last.png")
        _save_frame_tensor(frames[first_idx], first_path)
        if last_idx == first_idx:
            last_path = ""
        else:
            _save_frame_tensor(frames[last_idx], last_path)
        return first_path, last_path
    except Exception as exc:
        log.warning(f"[MiniMaxRefDirector] failed to save extracted frames from {video_path!r}: {exc}")
        return "", ""

# 图像分析
def image_analysis(gguf_path: str, mmproj_path: str, prompt: str, 
                   image_path:str = "", seed: int = 42):
    image = load_image_tensor(image_path) if image_path else None
    return generate_prompt_with_llama(image=image, gguf_path=gguf_path, mmproj_path=mmproj_path, prompt=prompt, seed=seed)


# ── H3 skills 模板 ──────────────────────────────────────────────
_H3_SKILLS_TEMPLATE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "prompt", "minimaxh3_custom_ref2v_prompt_writing.txt",
)
# 音频关系 -> retention_analysis 文案模板（{n} 为 Audio 编号）
_AUDIO_RELATION_TEXT = {
    "fully_copy": "<Audio {n}> is reused 1:1 as the target video's complete final audio track.",
    "partially_copy": "Only part of the timeline or selected audio layers of <Audio {n}> are copied.",
    "reference": "the target speaker follows <Audio {n}>'s voice timbre and measured delivery without copying the original signal.",
    "weak_reference": "Only broad similarity in category or atmosphere from <Audio {n}> is retained.",
}

def _load_h3_skills_template() -> str:
    """Load the custom H3 skills template (three-field output only)."""
    with open(_H3_SKILLS_TEMPLATE_PATH, "r", encoding="utf-8") as f:
        return f.read()


def _build_h3_prompt(skills: str, prompt: str, has_image: bool) -> str:
    """Build the full prompt sent to the local GGUF VLM.

    Includes the custom skills guide, the required JSON output format
    (detailed_description / overall_soundscape / non_diegetic_music) and the
    <@角色名称> / <#角色名称:对话内容> placeholder rules. When a reference
    image is provided it is NOT treated as a first frame; instead its contents
    are merged into "detailed_description" together with the user's input.
    """
    image_note = ""
    if has_image:
        image_note = (
            "- If a reference image is provided, analyze what is visible in it "
            "(scene, characters, lighting, atmosphere) and merge it with the "
            "user's input into \"detailed_description\". The image is not a "
            "first frame and must not be output as its own field.\n"
        )

    return f"""You are an expert video prompt writer. Follow the skills guide below.

## Skills Guide
{skills}

## Task
Rewrite the user's input prompt into a full-reference video prompt.

## Output Format
Output ONLY a JSON object with exactly these keys:
  - "detailed_description": string
  - "overall_soundscape": string
  - "non_diegetic_music": string
## Placeholder Rules
In "detailed_description", "overall_soundscape" and "non_diegetic_music":
1. Wrap every character name as <@角色名称>, e.g. <@Zhang San>. This applies even if the user wrote the name as a bare word (e.g. "小李做了什么" must become "<@小李>做了什么").
2. Wrap every dialogue as <#角色名称:对话内容>, e.g. <#Zhang San:Hello!> or <#李四:你好！>.
3. Keep character names and dialogue in their original language, never translate them.

## Strictness
- "detailed_description" MUST begin with "[Shot 1]" and no text may appear before it. If the user's input has no explicit shot marker, open with "[Shot 1]".
- Strictly follow the user's input prompt: format exactly what the user provided. Do NOT add extra descriptions, actions, shots, or dialogue beyond the user's input.
{image_note}## User Input Prompt
{prompt}

Output ONLY the JSON object. Do not add any text before or after it."""


# 生成h3提示词
_H3_DEFAULT_OPTIONS: dict = {
    "gguf_path": "",
    "mmproj_path": "",
    "provider": "GLM",        # vlm_mode="api" 时的服务商
    "api_key": "",            # vlm_mode="api" 时的 key 覆盖
}


def generate_h3_prompt(prompt: str="", image_path: str="", seed: int=42, vlm_mode: str="llama-cpp", options: dict | None = None) -> dict:
    """Generate an H3 full-reference prompt JSON.

    options 是一个配置字典（未提供的键使用 _H3_DEFAULT_OPTIONS 默认值），
    避免调用参数不断膨胀。支持的键：
      - gguf_path / mmproj_path: llama-cpp 本地 GGUF 模型文件
      - image_path: 参考图路径（提供时与用户输入合并进 detailed_description）
      - seed: 采样种子
      - vlm_mode: "llama-cpp"（默认，本地 GGUF）/ "api"（云端 OpenAI 兼容接口）
      - provider: vlm_mode="api" 时的服务商（走 API 管理器配置）
      - api_key: vlm_mode="api" 时的 key 覆盖（可留空，回落配置/环境变量）
      - clip_type: CLIP 模型类型（"minimax" / "qwen3vl" / "gemma"）

    The output JSON includes detailed_description / overall_soundscape /
    non_diegetic_music (a provided reference image is merged into
    detailed_description, not treated as a first frame). Character names are
    wrapped as <@名字> and dialogue as <#名字:[Language]对话> directly by the
    model, with a language tag such as [Chinese] or [English] before the
    dialogue text. No mapping is returned.
    """
    opts = {**_H3_DEFAULT_OPTIONS, **(options or {})}
    # 首帧图路径来自函数参数 image_path（server.py 传入），options 中不包含该键
    image = load_image_tensor(image_path) if image_path else None
    skills = _load_h3_skills_template()
    full_prompt = _build_h3_prompt(skills, prompt, image is not None)
    if vlm_mode == "api":
        generate_text = generate_prompt_with_api(
        image=image, prompt=full_prompt, provider=opts.get("provider", "GLM"),
        api_key=opts.get("api_key", ""), seed=seed,
    )
    elif vlm_mode == "llama-cpp":
        generate_text = generate_prompt_with_llama(
            image=image,prompt=full_prompt, gguf_path=opts["gguf_path"], 
            mmproj_path=opts["mmproj_path"], seed=seed,
    )
    return parse_generated_json(generate_text)


# ── H3 主体绑定 ──────────────────────────────────────────────────
# 匹配 <@角色名称> 与 <#角色名称:对话内容> 占位符
_H3_NAME_RE = re.compile(r"<@([^>]+)>")
_H3_DIALOGUE_RE = re.compile(r"<#([^>:]+):([^>]+)>")
# 匹配 [Shot N] 分镜标记
_SHOT_MARK_RE = re.compile(r"\[Shot (\d+)\]")

def _shift_shots(text: str, delta: int = 1) -> str:
    """将文本中的 [Shot N] 编号整体偏移 delta（默认 +1），用于首帧 reference 分镜插入后重编号。"""
    if not text:
        return text
    return _SHOT_MARK_RE.sub(lambda m: f"[Shot {int(m.group(1)) + delta}]", text)

def _extract_h3_mentions(prompt_json: dict) -> dict:
    """Extract <@name> and <#name:dialogue> mentions from all H3 prompt fields.

    Returns {"names": {name: "<@name>"}, "dialogues": {name: {"<#name:dialogue>":dialogue, ...}}}.
    """
    names: dict[str, int] = {}
    dialogues: dict[str, dict[str, str]] = {}
    for field in ("detailed_description", "overall_soundscape", "non_diegetic_music"):
        text = prompt_json.get(field) or ""
        if not isinstance(text, str):
            continue
        for m in _H3_NAME_RE.finditer(text):
            name = m.group(1).strip()
            if name:
                names[name] = m.group(0).strip()
        for m in _H3_DIALOGUE_RE.finditer(text):
            name = m.group(1).strip()
            if name:
                dialogue = m.group(2).strip()
                dialogues.setdefault(name, {})[m.group(0).strip()] = dialogue
    return {"names": names, "dialogues": dialogues}

def build_h3_subject_bindings(
    subject_data: dict,
    raw_prompt: str,
    timeline_segment: dict|None = None,
) -> dict:
    """Match <@name> / <#name:dialogue> placeholders against subject data and build H3 bindings.

    Args:
        subject_data: JSON string or dict with {"subjects": [{name, description,
            imageFile, audioFile, videoFile, type?, relationship?, audio_relationship?}]}.
            type: "Subject" (default) | "Picture" | "Video" | "Audio".
            relationship: visual marker, one of fully_preserved (default) /
                partially_preserved / attribute_transfer / weak_reference.
            audio_relationship: audio marker, one of reference (default) /
                fully_copy / partially_copy / weak_reference.
        raw_prompt: H3 output JSON with detailed_description /
            overall_soundscape / non_diegetic_music.
        last_frame_path: optional last-frame image, appended as <Picture N> anchor.
        timeline_segment: current timeline segment dict; its "additionSubject"
            list (subject names added in the editor but not mentioned in the
            prompt) is bound in addition.

    Returns:
        {
            "subjects": [...],             # 主体信息（含 use_audio / matched / has_dialogue）
            "subject_definition": str,     # <Subject 1> 描述 / <Audio 1> is the voice-timbre reference... / <Picture N> is the last frame...
            "retention_analysis": str,     # <Subject 1>: fully_preserved / <Audio 1>: reference - ...
            "unmatched_mentions": [...],   # 被 @ 提及 / 添加但未在主体中定义的名字
            "images": [...],               # 图片文件路径列表（主体图片 + 尾帧）
            "audios": [...],               # 音频文件路径列表
            "videos": [...],               # 视频文件路径列表
        }
    """
    subjects_in = (subject_data or {}).get("subjects", []) or []
    prompt_json = _build_prompt_json(raw_prompt)
    mentions = _extract_h3_mentions(prompt_json)
    names = mentions["names"]
    dialogues = mentions["dialogues"]
    subject_definitions = []
    retention_analysis = []
    images: list[str] = []
    audios: list[str] = []
    videos: list[str] = []
    unmatched: list[str] = []
    seen: set[str] = set()
    subjects_out: list[dict] = []
    mapping: dict[str, str] = {}
    index = 1
    for name, dat in dialogues.items():
        if name in seen or name in unmatched:
            continue
        idx = find_index(subjects_in, func=lambda x, y=name: x.get("name") == y)
        if idx == -1:
            unmatched.append(name)
            continue
        subj = subjects_in[idx]
        image_file = subj.get("imageFile", "")
        audio_file = subj.get("audioFile", "")
        if not audio_file:
            unmatched.append(f"{name} has no audioFile")
            continue
        description = subj.get("description", "")
        relationship = subj.get("relationship", "")
        subject_definitions.append(f"<Subject {index}> {description}")
        retention_analysis.append(f"<Subject {index}>: {relationship}")
        images.append(image_file)
        subject_definitions.append(f"<Audio {index}> is the voice-timbre reference for <Subject {index}>")
        text = _AUDIO_RELATION_TEXT.get(relationship, _AUDIO_RELATION_TEXT["reference"])
        retention_analysis.append(
            f"<Audio {index}>: {relationship} - {text.format(n=index)}"
        )
        audios.append(audio_file)
        seen.add(name)
        mapping[f"<@{name}>"] = f"<Subject {index}>"
        index += 1
        subjects_out.append(subj)
        for k, v in dat.items():
            # 判断是否存在汉字
            language = "Chinese" if any('\u4e00' <= char <= '\u9fff' for char in v) else "English"
            mapping[k] = f"<d>[{language}]{v}</d>"

    for name, pattern in names.items():
        if name in seen or name in unmatched:
            continue
        idx = find_index(subjects_in, func=lambda x, y=name: x.get("name") == y)
        if idx == -1:
            unmatched.append(name)
            continue
        subj = subjects_in[idx]
        image_file = subj.get("imageFile", "")
        audio_file = subj.get("audioFile", "")
        video_file = subj.get("videoFile", "")
        description = subj.get("description", "")
        dType = subj.get("type", "") or "Subject"
        relationship = subj.get("relationship", "")
        label = f"<{dType} {index}>"
        subject_definitions.append(f"{label} {description}")
        retention_analysis.append(f"{label}: {relationship}")
        if dType == "Picture" or dType == "Subject":
            images.append(image_file)
        elif dType == "Audio":
            audios.append(audio_file)
        elif dType == "Video":
            videos.append(video_file)
        seen.add(name)
        index += 1
        subjects_out.append(subj)
        mapping[pattern] = label

    for name in (timeline_segment or {}).get("additionSubject", []) or []:
        if name in seen or name in unmatched:
            continue
        idx = find_index(subjects_in, func=lambda x, y=name: x.get("name") == y)
        if idx == -1:
            unmatched.append(name)
            continue
        subj = subjects_in[idx]
        image_file = subj.get("imageFile", "")
        audio_file = subj.get("audioFile", "")
        video_file = subj.get("videoFile", "")
        description = subj.get("description", "")
        dType = subj.get("type", "") or "Subject"
        relationship = subj.get("relationship", "")
        label = f"<{dType} {index}>"
        subject_definitions.append(f"{label} {description}")
        retention_analysis.append(f"{label}: {relationship}")
        if dType == "Picture" or dType == "Subject":
            images.append(image_file)
        elif dType == "Audio":
            audios.append(audio_file)
        elif dType == "Video":
            videos.append(video_file)
        seen.add(name)
        index += 1
        subjects_out.append(subj)

    data = {
        "subjects": subjects_out,
        "subject_definitions": "\n".join(subject_definitions),
        "retention_analysis": "\n".join(retention_analysis),
        "detailed_description": prompt_json.get("detailed_description", ""), 
        "overall_soundscape": prompt_json.get("overall_soundscape", ""),
        "non_diegetic_music": prompt_json.get("non_diegetic_music", ""),
        "unmatched_mentions": unmatched,
        "images": images,
        "audios": audios,
        "videos": videos,
        "mapping": mapping,
    }

    return data

def build_h3_prompt(
    global_prompt: str,
    subject_data: dict,
    raw_prompt: str,
    previous_timeline_segment: dict|None = None,
    timeline_segment: dict|None = None,
    next_timeline_segment: dict|None = None
) -> dict:
    prompt_res = build_h3_subject_bindings(subject_data=subject_data, raw_prompt=raw_prompt, timeline_segment=timeline_segment)

    subject_definitions = prompt_res.get("subject_definitions", "")
    retention_analysis = prompt_res.get("retention_analysis", "")
    detailed_description = prompt_res.get("detailed_description", "")
    images = prompt_res.get("images", [])
    # Picture 编号延续 Subject/Audio 编号：绑定完成后 index = 主体数 + 1
    index = len(prompt_res.get("subjects", []) or []) + 1
    # 首帧图片对应的 <Picture N> 标签（视频段首帧 / 图片段图），供 detailed_description reference 分镜使用
    first_frame_pic = ""
    # 尾帧图片对应的 <Picture N> 标签（视频段尾帧 / autoEndFrame 段），追加到详细描述末尾作为结束锚点
    last_frame_pic = ""
    prev_image_file = ""

    if timeline_segment.get("type", "text") == "video":
        video_path = timeline_segment.get("imageFile", "")
        video_start = timeline_segment.get("trimStart", 1)
        video_duration = timeline_segment.get("length", 1)
        # 视频段：获取 mp4 的首帧和尾帧图片路径（首帧位置=video_start，尾帧位置=video_start+video_duration）
        video_first_frame_path, video_last_frame_path = _extract_video_frames(video_path, video_start, video_duration)
        if video_first_frame_path:
            label = f"<Picture {index}>"
            first_frame_pic = label
            subject_definitions = subject_definitions + f"\n{label} is the first frame of [Shot 1]."
            retention_analysis = retention_analysis + f"\n{label} ([Shot 1] first frame): fully_preserved."
            index += 1
            images.append(video_first_frame_path)
        if video_last_frame_path:
            label = f"<Picture {index}>"
            last_frame_pic = label
            subject_definitions = subject_definitions + f"\n{label} is the last frame of the target video."
            retention_analysis = retention_analysis + f"\n{label}(last frame of the target video): fully_preserved."
            index += 1
            images.append(video_last_frame_path)
    else:
        if timeline_segment.get("type", "text") == "image":
            label = f"<Picture {index}>"
            first_frame_pic = label
            subject_definitions = subject_definitions + f"\n{label} is the first frame of [Shot 1]."
            retention_analysis = retention_analysis + f"\n{label} ([Shot 1] first frame): fully_preserved."
            index += 1
            images.append(timeline_segment.get("imageFile"))
        elif timeline_segment.get("motionContext", False) and previous_timeline_segment is not None:
            if previous_timeline_segment.get("type") == "video" and previous_timeline_segment.get("imageFile"):
                prev_image_file = previous_timeline_segment.get("imageFile", "")
                video_start = previous_timeline_segment.get("trimStart", 1)
                video_duration = previous_timeline_segment.get("length", 1)
                # 视频段：获取 mp4 的首帧和尾帧图片路径（首帧位置=video_start，尾帧位置=video_start+video_duration）
                video_first_frame_path, video_last_frame_path = _extract_video_frames(prev_image_file, video_start, video_duration)
                if video_last_frame_path:
                    label = f"<Picture {index}>"
                    first_frame_pic = label
                    subject_definitions = subject_definitions + f"\n{label} is the first frame of [Shot 1]."
                    retention_analysis = retention_analysis + f"\n{label} ([Shot 1] first frame): fully_preserved."
                    index += 1
                    images.append(video_last_frame_path)
            elif previous_timeline_segment.get("type", "text") == "image" and previous_timeline_segment.get("imageFile", ""):
                prev_image_file = previous_timeline_segment.get("imageFile", "")
                label = f"<Picture {index}>"
                first_frame_pic = label
                subject_definitions = subject_definitions + f"\n{label} is the first frame of [Shot 1]."
                retention_analysis = retention_analysis + f"\n{label} ([Shot 1] first frame): fully_preserved."
                index += 1
                images.append(prev_image_file)

        if timeline_segment.get("autoEndFrame", False) and next_timeline_segment is not None:
            if next_timeline_segment.get("type", "text") == "video" and next_timeline_segment.get("imageFile", ""):
                    video_path = next_timeline_segment.get("imageFile", "")
                    video_start = next_timeline_segment.get("trimStart", 1)
                    video_duration = next_timeline_segment.get("length", 1)
                    # 视频段：获取 mp4 的首帧和尾帧图片路径（首帧位置=video_start，尾帧位置=video_start+video_duration）
                    video_first_frame_path, video_last_frame_path = _extract_video_frames(video_path, video_start, video_duration)
                    if video_first_frame_path:
                        label = f"<Picture {index}>"
                        last_frame_pic = label
                        subject_definitions = subject_definitions + f"\n{label} is the last frame of the target video."
                        retention_analysis = retention_analysis + f"\n{label} (last frame of the target video): fully_preserved."
                        index += 1
                        images.append(video_first_frame_path)
            elif next_timeline_segment.get("type", "text") == "image" and next_timeline_segment.get("imageFile", ""):
                label = f"<Picture {index}>"
                last_frame_pic = label
                subject_definitions = subject_definitions + f"\n{label} is the last frame of the target video."
                retention_analysis = retention_analysis + f"\n{label} (last frame of the target video): fully_preserved."
                index += 1
                images.append(next_timeline_segment.get("imageFile"))

    mapping = prompt_res.get("mapping", {})
    detailed_description = _replace_mapping(detailed_description, mapping)

    # 首帧图作为 reference 分镜：detailed_description 已含 [Shot N] 时全部 +1，
    # 且原 [Shot 1] 移位为 [Shot 2] 后附上动画起点时间戳 At 00:00.330；
    # 否则直接补 [Shot 2] At 00:00.330 时间戳，再在最前插入 [Shot 1] <Picture N> is fully referenced.
    if first_frame_pic:
        if _SHOT_MARK_RE.search(detailed_description):
            detailed_description = _shift_shots(detailed_description, 1)
            detailed_description = re.sub(r"\[Shot 2\]", "[Shot 2] At 00:00.330", detailed_description, count=1)
            prefix = f"[Shot 1] {first_frame_pic} is fully referenced.\n"
        else:
            prefix = f"[Shot 1] {first_frame_pic} is fully referenced.\n[Shot 2] At 00:00.330\n"
        detailed_description = prefix + detailed_description

    # 尾帧作为结束锚点：追加到最后一个分镜上；详细描述不含分镜时先给内容补 [Shot 1] 开头
    if last_frame_pic:
        shot_numbers = [int(n) for n in _SHOT_MARK_RE.findall(detailed_description)]
        if shot_numbers:
            max_shot = max(shot_numbers)
            detailed_description = detailed_description + f"\n[Shot {max_shot + 1}] without a cut and the final composition settles precisely into {last_frame_pic}."
        else:
            if detailed_description:
                detailed_description = "[Shot 1] " + detailed_description
                detailed_description = detailed_description + f"\n[Shot 2] without a cut and the final composition settles precisely into {last_frame_pic}."
            else:
                detailed_description = f"[Shot 1] without a cut and the final composition settles precisely into {last_frame_pic}."
    
    overall_soundscape = prompt_res.get("overall_soundscape", "") or "N/A"
    overall_soundscape = _replace_mapping(overall_soundscape, mapping)

    non_diegetic_music = prompt_res.get("non_diegetic_music", "") or "N/A"
    non_diegetic_music = _replace_mapping(non_diegetic_music, mapping)

    prompt = "subject_definitions:\n" + subject_definitions + "\n"
    prompt += "retention_analysis:\n" + retention_analysis + "\n"
    prompt += "detailed_description:\n" + global_prompt + "\n" + detailed_description + "\n"
    prompt += "overall_soundscape:\n" + overall_soundscape + "\n"
    prompt += "non_diegetic_music:\n" + non_diegetic_music
    return {
        "subjects": prompt_res["subjects"],
        "prompt": prompt,
        "images": prompt_res["images"],
        "audios": prompt_res["audios"],
        "videos": prompt_res["videos"],
        "prevImageFile": prev_image_file,
    }

def _replace_mapping(input: str, mapping: dict) -> str:
        for k, v in mapping.items():
            input = input.replace(k, v)
        return input

def _build_prompt_json(raw_prompt: str) -> list:
    lines = raw_prompt.split("\n")
    prompt_json = {
        "detailed_descriptions": "",
        "overall_soundscape": "",
        "non_diegetic_music": ""
    }
    section = "detail"
    detail_lines = []
    overall_lines = []
    non_lines = []
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
            detail_lines.append(line.strip())
        elif section == "overall":
            if line.strip() != "" and line.strip() != "N/A":
                overall_lines.append(line)
        elif section == "music":
            if line.strip() != "" and line.strip() != "N/A":
                non_lines.append(line)
    
    prompt_json["detailed_description"] = "\n".join(detail_lines)
    prompt_json["overall_soundscape"] = "\n".join(overall_lines) if len(overall_lines) > 0 else "N/A"
    prompt_json["non_diegetic_music"] = "\n".join(non_lines) if len(overall_lines) > 0 else "N/A"
    return prompt_json