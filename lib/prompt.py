
import json
import os
import re
import logging

from .image import load_image_tensor
from .llm import generate_prompt_with_api, generate_prompt_with_llama
from .utils import find_index, parse_generated_json

log = logging.getLogger(__name__)

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
1. Wrap every character name as <@角色名称>, e.g. <@Zhang San>.
2. Wrap every dialogue as <#角色名称:对话内容>, e.g. <#Zhang San:Hello!> or <#李四:你好！>.
3. Keep character names and dialogue in their original language, never translate them.

## Strictness
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

# 官方 retention_analysis 支持的类型与关系标记
_H3_TYPES = ("Subject", "Picture", "Video", "Audio")
_VISUAL_RELATIONS = ("fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference")
_AUDIO_RELATIONS = ("fully_copy", "partially_copy", "reference", "weak_reference")

# 音频关系 -> retention_analysis 文案模板（{n} 为 Audio 编号）
_AUDIO_RELATION_TEXT = {
    "fully_copy": "<Audio {n}> is reused 1:1 as the target video's complete final audio track.",
    "partially_copy": "Only part of the timeline or selected audio layers of <Audio {n}> are copied.",
    "reference": "the target speaker follows <Audio {n}>'s voice timbre and measured delivery without copying the original signal.",
    "weak_reference": "Only broad similarity in category or atmosphere from <Audio {n}> is retained.",
}


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
    last_frame_path: str = "",
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
    log.info(f"mentions: {json.dumps(mentions, indent=2)}")
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
        index += 1
        subjects_out.append(subj)
        mapping[f"<@{name}>"] = f"<Subject {index}>"
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

    if last_frame_path:
        label = f"<Picture {index}>"
        subject_definitions.append(f"{label} is the last frame of the target video.")
        retention_analysis.append(f"{label} (last frame of the target video): fully_preserved.")
        index += 1
        images.append(last_frame_path)

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

    log.info(f"build_h3_subject_bindings: {json.dumps(data, indent=2)}")

    return data

def build_h3_prompt(
    global_prompt: str,
    subject_data: dict,
    raw_prompt: str,
    last_frame_path: str = "",
    timeline_segment: dict|None = None
) -> dict:
    prompt_res = build_h3_subject_bindings(subject_data=subject_data, raw_prompt=raw_prompt,
                                           last_frame_path=last_frame_path, timeline_segment=timeline_segment)
    mapping = prompt_res.get("mapping", {})
    subject_definitions = prompt_res.get("subject_definitions", "")
    retention_analysis = prompt_res.get("retention_analysis", "")
    detailed_description = prompt_res.get("detailed_description", "")

    detailed_description = _replace_mapping(detailed_description, mapping)
    overall_soundscape = prompt_res.get("overall_soundscape", "") 
    overall_soundscape = _replace_mapping(overall_soundscape, mapping)
    non_diegetic_music = prompt_res.get("non_diegetic_music", "")
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