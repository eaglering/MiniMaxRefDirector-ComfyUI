
import json
import os
import re

from lib.image import load_image_tensor
from lib.llm import generate_prompt_with_llama
from lib.utils import parse_generated_json

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
    (detailed_description / overall_soundscape / non_diegetic_music, plus
    shot1_description when a first-frame image is provided) and the
    <@角色名称> / <#角色名称:[Language]对话内容> placeholder rules. No mapping is returned.
    """
    shot1_field = ""
    shot1_note = ""
    if has_image:
        shot1_field = (
            '  - "shot1_description": a string describing what is visible in the '
            "first-frame reference image (scene, characters, lighting, atmosphere).\n\n"
        )
        shot1_note = (
            '- If a first-frame image is provided, analyze it and describe it in '
            '"shot1_description", then continue the remaining content in '
            '"detailed_description" following the user\'s input.\n'
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
{shot1_field}## Placeholder Rules
In "detailed_description", "overall_soundscape" and "non_diegetic_music":
1. Wrap every character name as <@角色名称>, e.g. <@Zhang San>.
2. Wrap every dialogue as <#角色名称:[Language]对话内容>, e.g. <#Zhang San:[English]Hello!> or <#李四:[Chinese]你好！>.
3. Add a language tag before the dialogue text using the format [Chinese], [English], [Japanese], etc. Keep character names and dialogue in their original language. Never translate them.

## Strictness
- Strictly follow the user's input prompt: format exactly what the user provided. Do NOT add extra descriptions, actions, shots, or dialogue beyond the user's input.
{shot1_note}## User Input Prompt
{prompt}

Output ONLY the JSON object. Do not add any text before or after it."""


# 生成h3提示词
def generate_h3_prompt(gguf_path: str, mmproj_path: str, prompt: str, 
                       image_path:str = "", seed: int = 42):
    """Generate an H3 full-reference prompt JSON via a local GGUF VLM.

    The output JSON includes detailed_description / overall_soundscape /
    non_diegetic_music (and shot1_description when a first-frame image is
    provided). Character names are wrapped as <@名字> and dialogue as
    <#名字:[Language]对话> directly by the model, with a language tag such as
    [Chinese] or [English] before the dialogue text. No mapping is returned.
    """
    image = load_image_tensor(image_path) if image_path else None
    skills = _load_h3_skills_template()
    full_prompt = _build_h3_prompt(skills, prompt, image is not None)
    generate_text = generate_prompt_with_llama(
        image=image, gguf_path=gguf_path, mmproj_path=mmproj_path,
        prompt=full_prompt, seed=seed,
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

    Returns {"names": {name: count}, "dialogues": {name: [dialogue, ...]}}.
    """
    names: dict[str, int] = {}
    dialogues: dict[str, list[str]] = {}
    for field in ("shot1_description", "detailed_description", "overall_soundscape", "non_diegetic_music"):
        text = prompt_json.get(field) or ""
        if not isinstance(text, str):
            continue
        for m in _H3_NAME_RE.finditer(text):
            name = m.group(1).strip()
            if name:
                names[name] = names.get(name, 0) + 1
        for m in _H3_DIALOGUE_RE.finditer(text):
            name = m.group(1).strip()
            if name:
                dialogues.setdefault(name, []).append(m.group(2).strip())
    return {"names": names, "dialogues": dialogues}


def _resolve_subject(subjects: list[dict], name: str) -> dict | None:
    """Find a subject by name (exact match first, case-insensitive fallback)."""
    target = name.strip()
    if not target:
        return None
    for s in subjects:
        if str(s.get("name", "")).strip() == target:
            return s
    for s in subjects:
        if str(s.get("name", "")).strip().lower() == target.lower():
            return s
    return None


def build_h3_subject_bindings(
    subject_data,
    prompt_json: dict,
    first_frame_path: str = "",
    last_frame_path: str = "",
) -> dict:
    """Match <@name> / <#name:dialogue> placeholders against subject data and build H3 bindings.

    Args:
        subject_data: JSON string or dict with {"subjects": [{name, description,
            imageFile, audioFile, type?, relationship?, audio_relationship?}]}.
            type: "Subject" (default) | "Picture" | "Video" | "Audio".
            relationship: visual marker, one of fully_preserved (default) /
                partially_preserved / attribute_transfer / weak_reference.
            audio_relationship: audio marker, one of reference (default) /
                fully_copy / partially_copy / weak_reference.
        prompt_json: H3 output JSON with shot1_description / detailed_description /
            overall_soundscape / non_diegetic_music.
        first_frame_path / last_frame_path: optional first/last frame images,
            appended as <Picture N> anchors.

    Returns:
        {
            "subjects": [...],             # 主体信息（含 use_audio / matched / has_dialogue）
            "subject_definition": str,     # <Subject 1> is 名字 in <Picture 1>, 描述 / <Picture N> is ...
            "audio_definition": str,       # <Audio 1> is the voice-timbre reference for <Subject 1>
            "retention_analysis": str,     # <Subject 1>: fully_preserved / <Audio 1>: reference - ...
            "unmatched_mentions": [...],   # 被 @ 提及但未在主体中定义的名字
        }
    """
    if isinstance(subject_data, str):
        try:
            subject_data = json.loads(subject_data)
        except (json.JSONDecodeError, TypeError):
            subject_data = {}
    subjects_in = (subject_data or {}).get("subjects", []) or []

    mentions = _extract_h3_mentions(prompt_json)
    names = mentions["names"]
    dialogues = mentions["dialogues"]

    # 被 @ 提及（含对话中的名字）但未在主体中定义
    unmatched: list[str] = []
    seen: set[str] = set()
    for n in list(names) + list(dialogues):
        if n in seen:
            continue
        if _resolve_subject(subjects_in, n) is None:
            unmatched.append(n)
            seen.add(n)

    bound: list[dict] = []
    subject_counter = 0
    picture_counter = 0
    audio_counter = 0

    for subj in subjects_in:
        name = str(subj.get("name", "")).strip()
        if not name:
            continue

        stype = str(subj.get("type", "") or "").strip()
        if stype not in _H3_TYPES:
            stype = "Subject"
        relationship = str(subj.get("relationship", "") or "").strip()
        if relationship not in _VISUAL_RELATIONS:
            relationship = "fully_preserved"
        audio_relationship = str(subj.get("audio_relationship", "") or "").strip()
        if audio_relationship not in _AUDIO_RELATIONS:
            audio_relationship = "reference"

        description = str(subj.get("description", "") or "").strip()
        image_file = str(subj.get("imageFile", "") or "").strip()
        audio_file = str(subj.get("audioFile", "") or "").strip()
        use_audio = bool(audio_file)

        if stype == "Subject":
            subject_counter += 1
            label = f"<Subject {subject_counter}>"
            source = ""
            if image_file:
                picture_counter += 1
                source = f" in <Picture {picture_counter}>"
            definition = f"{label} is {name}{source}"
            if description:
                definition += f", {description}"
        elif stype == "Picture":
            picture_counter += 1
            label = f"<Picture {picture_counter}>"
            definition = f"{label} is {description or name} (reference image anchor)"
        else:  # Video / Audio 兜底
            subject_counter += 1
            label = f"<{stype} {subject_counter}>"
            definition = f"{label} is {description or name}"

        audio_label = None
        audio_definition = None
        if use_audio:
            audio_counter += 1
            audio_label = f"<Audio {audio_counter}>"
            audio_definition = f"{audio_label} is the voice-timbre reference for {label}"

        bound.append({
            "name": name,
            "description": description,
            "type": stype,
            "relationship": relationship,
            "audio_relationship": audio_relationship,
            "imageFile": image_file,
            "audioFile": audio_file,
            "use_audio": use_audio,
            "matched": name in names,
            "has_dialogue": name in dialogues,
            "subject_definition": definition,
            "audio_definition": audio_definition,
            "audio_label": audio_label,
            "audio_number": audio_counter if use_audio else None,
        })

    subject_lines = [b["subject_definition"] for b in bound if b["subject_definition"]]
    audio_lines = [b["audio_definition"] for b in bound if b["audio_definition"]]
    retention_lines: list[str] = []

    for b in bound:
        label = b["subject_definition"].split(" is ")[0] if b["subject_definition"] else ""
        if label:
            retention_lines.append(f"{label}: {b['relationship']}")
        if b["audio_definition"] and b["audio_number"]:
            text = _AUDIO_RELATION_TEXT.get(b["audio_relationship"], _AUDIO_RELATION_TEXT["reference"])
            retention_lines.append(
                f"{b['audio_label']}: {b['audio_relationship']} - "
                f"{text.format(n=b['audio_number'])}"
            )

    # 首帧 / 尾帧 → 独立 Picture 锚点
    if first_frame_path:
        picture_counter += 1
        label = f"<Picture {picture_counter}>"
        subject_lines.append(f"{label} is the first frame of [Shot 1].")
        retention_lines.append(f"{label} ([Shot 1] first frame): fully_preserved.")
    if last_frame_path:
        picture_counter += 1
        label = f"<Picture {picture_counter}>"
        subject_lines.append(f"{label} is the last frame of the target video.")
        retention_lines.append(f"{label} (last frame of the target video): fully_preserved.")

    subjects_out = []
    for b in bound:
        entry = {k: v for k, v in b.items() if k not in ("audio_label", "audio_number")}
        subjects_out.append(entry)

    return {
        "subjects": subjects_out,
        "subject_definition": "\n".join(subject_lines),
        "audio_definition": "\n".join(audio_lines),
        "retention_analysis": "\n".join(retention_lines),
        "unmatched_mentions": unmatched,
    }
