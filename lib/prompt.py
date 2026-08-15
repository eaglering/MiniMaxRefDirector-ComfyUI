
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

# 需要做角色/对话占位符替换的字段
H3_PLACEHOLDER_FIELDS = ("detailed_description", "overall_soundscape", "non_diegetic_music")

# 已经形如 <@名字> / <#名字:对话> 的占位符（保护位，避免二次包裹）
_PLACEHOLDER_RE = re.compile(r"<@[^>]*>|<#[^>]*:[^>]*>")


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


def _apply_h3_placeholders(text: str, mapping: dict) -> str:
    """Deterministically wrap character names and dialogue in the H3 placeholder format.

    Names become <@名字> and dialogue becomes <#名字:对话>. Existing <@...>/<#...>
    spans are protected so they are never double-wrapped.

    mapping: {"ROLE_0": "Zhang San", "ROLE_0_DIALOGUE_0": "Hello", ...}
    """
    if not text or not mapping:
        return text

    # 收集角色名与对话（ROLE_N -> name，dialogue 列表）
    names: dict[str, str] = {}
    dialogues: list[tuple[str, str]] = []
    for key, value in mapping.items():
        m = re.match(r"^ROLE_(\d+)$", key)
        dm = re.match(r"^ROLE_(\d+)_DIALOGUE_(\d+)$", key)
        if m and isinstance(value, str) and value:
            names[m.group(1)] = value
        elif dm and isinstance(value, str) and value:
            name = names.get(dm.group(1), "")
            if name:
                dialogues.append((name, value))

    sentinels: dict[str, str] = {}

    def _protect(match: re.Match) -> str:
        token = f"\x00S{len(sentinels)}\x00"
        sentinels[token] = match.group(0)
        return token

    # 1. 保护已存在的占位符
    text = _PLACEHOLDER_RE.sub(_protect, text)
    # 2. 先替换对话（长文本优先，避免部分重叠），再保护新生成的 <#...> 占位符
    for name, dlg in sorted(dialogues, key=lambda x: len(x[1]), reverse=True):
        if dlg:
            text = text.replace(dlg, f"<#{name}:{dlg}>")
    text = _PLACEHOLDER_RE.sub(_protect, text)
    # 3. 最后替换角色名
    for name in sorted(set(names.values()), key=len, reverse=True):
        if name:
            text = text.replace(name, f"<@{name}>")
    # 4. 恢复被保护的占位符
    for token, value in sentinels.items():
        text = text.replace(token, value)
    return text


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
