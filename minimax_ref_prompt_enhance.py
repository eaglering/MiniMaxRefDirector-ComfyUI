import copy
import gc
import hashlib
import json
import logging
import math
import os
import re
from collections import OrderedDict

import comfy.sd
import folder_paths
import torch
from comfy_api.latest import io

from .api_config import api_config_manager, parse_provider_value
from .lib import seconds_to_mmssmmm
log = logging.getLogger(__name__)

# ── Shot structure instructions (conditional on first-frame image) ─

SHOT_STRUCTURE_NO_IMAGE = """- Structure shots with `[Shot 1]`, `[Shot 2] At MM:SS.mmm`, `[Shot 3] At MM:SS.mmm`, etc. The opening style sentence has no shot marker, and `[Shot 1]` has no timestamp."""

SHOT_STRUCTURE_HAS_IMAGE = """## IMPORTANT — First-Frame Shot Numbering:
A first-frame reference image IS provided. `[Shot 1]` is RESERVED for the first-frame image and MUST be described separately as `shot1_description`. Do NOT include `[Shot 1]` in `detailed_description`!
- Structure `detailed_description` shots starting from `[Shot 2] At {shot1_dur}s`, then `[Shot 3] At MM:SS.mmm`, `[Shot 4] At MM:SS.mmm`, etc.
- The opening style sentence has no shot marker.
- `[Shot 2]` has only a start timestamp (no duration range). All subsequent shots (`[Shot 3]`+) follow the normal `At MM:SS.mmm` format."""

# ── Example detailed_description variants (conditional on first-frame image) ─

EXAMPLE_BASIC_NO_IMAGE = ('"[Shot 1] A cozy cafe interior with exposed brick walls and warm pendant lights. '
                          '{{ROLE_0}} (S1) and {{ROLE_1}} (S2) sit across from each other at a wooden table by the window. '
                          '{{ROLE_0}} (S1) leans forward with a serious expression and says, {{ROLE_0_DIALOGUE_0}}.\\n'
                          '[Shot 2] At 00:05.000, a reverse over-the-shoulder shot on {{ROLE_1}} (S2) '
                          'as they smile warmly and reply, {{ROLE_1_DIALOGUE_1}}. '
                          'The camera holds steady in a medium close-up with shallow focus.\\n"')

EXAMPLE_BASIC_HAS_IMAGE = ('"[Shot 2] At 00:05.000, a reverse over-the-shoulder shot on {{ROLE_1}} (S2) '
                           'as they smile warmly and reply, {{ROLE_1_DIALOGUE_1}}. '
                           'The camera holds steady in a medium close-up with shallow focus.\\n"')

EXAMPLE_ENHANCED_NO_IMAGE = ('"[Shot 1] A dimly lit cafe interior with exposed brick walls. '
                             '{{ROLE_0}} (S1) and {{ROLE_1}} (S2) sit across from each other at a worn wooden table. '
                             'Rain streaks down the window behind them. '
                             'The camera slowly pushes in from a wide establishing shot to a medium two-shot.\\n'
                             '[Shot 2] At 00:05.000, a close-up on {{ROLE_0}} (S1). His expression is grave. '
                             'Fixed camera, shallow depth of field. He says, {{ROLE_0_DIALOGUE_0}}.\\n'
                             '[Shot 3] At 00:10.000, a reverse over-the-shoulder shot on {{ROLE_1}} (S2). '
                             '{{ROLE_1}} (S2) smiles warmly and replies, {{ROLE_1_DIALOGUE_1}}. '
                             'The camera holds steady in a medium close-up.\\n"')

EXAMPLE_ENHANCED_HAS_IMAGE = ('"[Shot 2] At 00:05.000, a close-up on {{ROLE_0}} (S1). His expression is grave. '
                              'Fixed camera, shallow depth of field. He says, {{ROLE_0_DIALOGUE_0}}.\\n'
                              '[Shot 3] At 00:10.000, a reverse over-the-shoulder shot on {{ROLE_1}} (S2). '
                              '{{ROLE_1}} (S2) smiles warmly and replies, {{ROLE_1_DIALOGUE_1}}. '
                              'The camera holds steady in a medium close-up.\\n"')

# ── Basic Prompt (no enhancement) ──────────────────────────────────

PROMPT_BASE_HEADER = """You are a video prompt writer for a full-reference text-to-video generation system. Convert user input into a structured video prompt with character and dialogue placeholders for downstream mapping and generation.

Write all shot descriptions in English. Preserve the original language of character names and dialogue content exactly as provided by the user—do not translate them. In the mapping, character name values must use their original language without any prefix. Dialogue values must include a language tag prefix: `[Chinese]` for Chinese or `[English]` for English."""

PROMPT_IMAGE_SECTION = """
## First Frame Reference Image:
Analyze the provided reference image as the starting visual state. Describe the scene, characters, lighting, and atmosphere visible in the image to establish the initial shot."""

PROMPT_LAST_SECTION = """
## Previous Shot Context:
The following is the prompt from the previous video segment. Extract the environment, character positions, clothing, and visible state to determine the starting state for the current segment. Ignore dialogue, camera movements, and timestamps—only retain what defines visual continuity:
{prev_prompt}"""

PROMPT_USER_SECTION = """
## User Input:
{user_input}

Video duration: {duration} seconds."""

PROMPT_SHOT1_SECTION = """
## Opening Shot (from reference image):
Describe the opening scene exactly as seen in the reference image. This shot is NOT counted toward the user-specified total duration and serves as the starting visual state before the directed action begins."""

PROMPT_SHOT1_DIALOGUE_SECTION = """
## Opening Shot (from reference image, with previous continuity):
Describe the opening scene by combining the reference image with the previous shot context below. Identify characters (matching ROLE_N assignments from the previous segment where applicable) and describe their current positions and states as visible in the image. This shot is NOT counted toward the user-specified total duration."""

PROMPT_NO_IMAGE_INSTRUCTION = """
No reference image provided. Generate descriptions based on the text input alone."""

PROMPT_REQUIREMENTS = """
## Placeholder Rules:
1. All character names MUST be represented with placeholders using the format `{{ROLE_0}}`, `{{ROLE_1}}`, etc.
2. All dialogue MUST be represented with placeholders using the format `{{ROLE_0_DIALOGUE_0}}`, `{{ROLE_1_DIALOGUE_1}}`, `{{ROLE_1_DIALOGUE_2}}`, etc.
3. Assign one ROLE_N placeholder per distinct character (ascending from 0).
4. Assign one ROLE_N_DIALOGUE_M placeholder per dialogue line. The ROLE_N prefix must match the speaking character.
5. Character name mapping values must preserve the original language as provided by the user. Do NOT add any language prefix to character names. Do NOT translate character names.
6. Dialogue mapping values must include a language tag prefix: `[Chinese]` for Chinese or `[English]` for English. Auto-detect the language of the dialogue content. Do NOT translate dialogue content—only add the language prefix.

## Shot Timing Guidelines (CRITICAL):
Placeholders like `{{ROLE_0_DIALOGUE_0}}` are SHORT tokens but represent the ACTUAL dialogue text from the User Input. DO NOT estimate shot duration from placeholder length!
- Chinese dialogue: ~3–4 characters per second of speaking time. A 12-character Chinese sentence ≈ 3–4 seconds. Add 0.5–1s of pause before and after.
- English dialogue: ~2–3 words per second of speaking time. A 10-word English sentence ≈ 3–5 seconds. Add 0.5–1s of pause before and after.
- Pure visual shots (no dialogue): allow adequate time for described actions and camera movements to play out visually (typically 2–5 seconds per shot).
- The sum of all shot durations should fit within the specified total video duration. Distribute time proportionally across shots based on content complexity.
- Shot timestamps must be monotonically increasing. The timestamp format is `At MM:SS.mmm`.

## Writing Guidelines (Full-Reference Video Prompt Standard):

### detailed_description:
__SHOT_STRUCTURE__
- Write camera movement as natural English prose within each shot description (e.g., "the camera slowly pushes in from a wide establishing shot to a medium close-up", "a static wide shot with shallow depth of field", "a smooth handheld tracking shot").
- Label each speaking character with (S1), (S2), etc., corresponding to their `{{ROLE_N}}` assignment order.
- When a character speaks, place the dialogue placeholder immediately after: `{{ROLE_N}} (Sx) says, {{ROLE_N_DIALOGUE_M}}` or `{{ROLE_N}} (Sx) looks up and replies, {{ROLE_N_DIALOGUE_M}}`.
- For each shot, clearly establish: shot composition (e.g., wide/medium/close-up/over-the-shoulder), subject appearance and position, environment and lighting, character actions and state changes, camera movement, and relevant on-screen sound.
- Describe what is actually visible in the frame—avoid reducing descriptions to plot summaries.
- All shot text must be in English. Character names and dialogue values in the mapping may preserve their original language.

### overall_soundscape:
- Summarize continuous ambient sound and recurring physical sound effects that persist across the full video.
- Dialogue, singing, and shot-specific isolated sound events should remain in detailed_description.
- Example: "Soft indoor room tone and distant traffic hum continue throughout."
- Output null if no continuous ambient sound is specified.

### non_diegetic_music:
- Describe background music audible only to the audience (not to characters in the scene). State instrumentation, tempo, and dynamic development.
- Example: "A restrained solo-piano score at a slow tempo, with sustained low cello underneath."
- Use "N/A" if no background music is present.

## Output Format:
Output a single JSON object with these fields:
__SHOT1_DESC__
  - "detailed_description": String (as described above)
  - "overall_soundscape": String or null
  - "non_diegetic_music": String (use "N/A" if none)
  - "mapping": Object (keys: "ROLE_0", "ROLE_1", "ROLE_0_DIALOGUE_0" etc.; values: corresponding actual text with language prefix for dialogue)

Example output:
{{
__SHOT1_EXAMPLE__  "detailed_description": __SHOT_EXAMPLE__
  "overall_soundscape": "Soft coffee-machine steam, gentle cup clinking, and low background chatter continue throughout.",
  "non_diegetic_music": "N/A",
  "mapping": {{
    "ROLE_0": "Zhang San",
    "ROLE_1": "Li Si",
    "ROLE_0_DIALOGUE_0": "[Chinese]我们已经有三年没见面了，你一点都没变。",
    "ROLE_1_DIALOGUE_1": "[English]It's good to see you again. How have you been all these years?"
  }}
}}

Output ONLY the JSON object. Do not add any text before or after it."""

# ── Enhanced Prompt ──────────────────────────────────────────────────

PROMPT_ENHANCE_HEADER = """You are a video prompt writer for a full-reference text-to-video generation system. Convert user input into a structured, enriched video prompt with character and dialogue placeholders for downstream mapping and generation.

In addition to basic conversion, you will enhance the output: fill in missing visual details, ambient sound, camera movement, and background music where the user has not specified them. Write all shot descriptions in English. Preserve the original language of character names and dialogue content exactly as provided by the user—do not translate them. In the mapping, character name values must use their original language without any prefix. Dialogue values must include a language tag prefix: `[Chinese]` for Chinese or `[English]` for English."""

PROMPT_ENHANCE_IMAGE_SECTION = """
## First Frame Reference Image:
Analyze the provided reference image as the starting visual state. Describe the scene, characters, lighting, and atmosphere visible in the image to establish the initial shot."""

PROMPT_ENHANCE_LAST_SECTION = """
## Previous Shot Context:
The following is the prompt from the previous video segment. Extract the environment, character positions, clothing, and visible state to determine the starting state for the current segment. Ignore dialogue, camera movements, and timestamps—only retain what defines visual continuity:
{prev_prompt}"""

PROMPT_ENHANCE_USER_SECTION = """
## User Input:
{user_input}

Video duration: {duration} seconds."""

PROMPT_ENHANCE_SHOT1_SECTION = """
## Opening Shot (from reference image):
Describe the opening scene exactly as seen in the reference image. This shot is NOT counted toward the user-specified total duration and serves as the starting visual state before the directed action begins."""

PROMPT_ENHANCE_SHOT1_DIALOGUE_SECTION = """
## Opening Shot (from reference image, with previous continuity):
Describe the opening scene by combining the reference image with the previous shot context below. Identify characters (matching ROLE_N assignments from the previous segment where applicable) and describe their current positions and states as visible in the image. This shot is NOT counted toward the user-specified total duration."""

PROMPT_ENHANCE_NO_IMAGE = """
No reference image provided. Generate and enhance descriptions based on the text input alone."""

PROMPT_ENHANCE_REQUIREMENTS = """
## Placeholder Rules:
1. All character names MUST be represented with placeholders using the format `{{ROLE_0}}`, `{{ROLE_1}}`, etc.
2. All dialogue MUST be represented with placeholders using the format `{{ROLE_0_DIALOGUE_0}}`, `{{ROLE_1_DIALOGUE_1}}`, `{{ROLE_1_DIALOGUE_2}}`, etc.
3. Assign one ROLE_N placeholder per distinct character (ascending from 0).
4. Assign one ROLE_N_DIALOGUE_M placeholder per dialogue line. The ROLE_N prefix must match the speaking character.
5. Character name mapping values must preserve the original language as provided by the user. Do NOT add any language prefix to character names. Do NOT translate character names.
6. Dialogue mapping values must include a language tag prefix: `[Chinese]` for Chinese or `[English]` for English. Auto-detect the language of the dialogue content. Do NOT translate dialogue content—only add the language prefix.

## Shot Timing Guidelines (CRITICAL):
Placeholders like `{{ROLE_0_DIALOGUE_0}}` are SHORT tokens but represent the ACTUAL dialogue text from the User Input. DO NOT estimate shot duration from placeholder length!
- Chinese dialogue: ~3–4 characters per second of speaking time. A 12-character Chinese sentence ≈ 3–4 seconds. Add 0.5–1s of pause before and after.
- English dialogue: ~2–3 words per second of speaking time. A 10-word English sentence ≈ 3–5 seconds. Add 0.5–1s of pause before and after.
- Pure visual shots (no dialogue): allow adequate time for described actions and camera movements to play out visually (typically 2–5 seconds per shot).
- The sum of all shot durations should fit within the specified total video duration. Distribute time proportionally across shots based on content complexity.
- Shot timestamps must be monotonically increasing. The timestamp format is `At MM:SS.mmm`.

## Enhancement Capabilities:
1. **Visual Enrichment**: Polish and enrich scene descriptions with specific visual detail, lighting descriptors, color palette, texture, and atmosphere. Fill in reasonable visual details where the user input is sparse.
2. **Ambient Sound Completion**: When the user input lacks ambient sound description, infer and add appropriate continuous ambient sound based on the scene context (environment type, weather, location, time of day, on-screen actions).
3. **Camera Movement Completion**: When the user input lacks camera direction, infer and add appropriate camera movements based on the scene's emotional tone and action (e.g., slow push-in for intimacy, static shot for tension, handheld for urgency, tracking for movement).
4. **Background Music Suggestion**: When applicable, suggest appropriate non-diegetic music based on the scene's emotional tone and pacing. Use "N/A" if unsuitable.

## Writing Guidelines (Full-Reference Video Prompt Standard):

### detailed_description:
__SHOT_STRUCTURE__
- Write camera movement as natural English prose within each shot description (e.g., "the camera slowly pushes in from a wide establishing shot to a medium close-up", "a static wide shot with shallow depth of field", "a smooth handheld tracking shot").
- Label each speaking character with (S1), (S2), etc., corresponding to their `{{ROLE_N}}` assignment order.
- When a character speaks, place the dialogue placeholder immediately after: `{{ROLE_N}} (Sx) says, {{ROLE_N_DIALOGUE_M}}` or `{{ROLE_N}} (Sx) looks up and replies, {{ROLE_N_DIALOGUE_M}}`.
- For each shot, clearly establish: shot composition (e.g., wide/medium/close-up/over-the-shoulder), subject appearance and position, environment and lighting, character actions and state changes, camera movement, and relevant on-screen sound.
- Describe what is actually visible in the frame—avoid reducing descriptions to plot summaries.
- All shot text must be in English. Character names and dialogue values in the mapping may preserve their original language.

### overall_soundscape:
- Summarize continuous ambient sound and recurring physical sound effects that persist across the full video.
- Dialogue, singing, and shot-specific isolated sound events should remain in detailed_description.
- Example: "Soft indoor room tone and distant traffic hum continue throughout."
- Output null if no continuous ambient sound is specified.

### non_diegetic_music:
- Describe background music audible only to the audience (not to characters in the scene). State instrumentation, tempo, and dynamic development.
- Example: "A restrained solo-piano score at a slow tempo, with sustained low cello underneath."
- Use "N/A" if no background music is present.

## Output Format:
Output a single JSON object with these fields:
__SHOT1_DESC__
  - "detailed_description": String (as described above)
  - "overall_soundscape": String or null
  - "non_diegetic_music": String (use "N/A" if none)
  - "mapping": Object (keys: "ROLE_0", "ROLE_1", "ROLE_0_DIALOGUE_0" etc.; values: corresponding actual text with language prefix for dialogue)

Example output:
{{
__SHOT1_EXAMPLE__  "detailed_description": __SHOT_EXAMPLE__
  "overall_soundscape": "Soft coffee-machine steam, gentle cup clinking, distant muffled conversation, and rain tapping against the window continue throughout.",
  "non_diegetic_music": "A restrained solo-piano score at a slow tempo, with sustained low cello underneath, growing subtly more hopeful in the middle section.",
  "mapping": {{
    "ROLE_0": "Zhang San",
    "ROLE_1": "Li Si",
    "ROLE_0_DIALOGUE_0": "[Chinese]好久不见，这些年你过得还好吗？",
    "ROLE_1_DIALOGUE_1": "[English]I've thought about this moment for a long time."
  }}
}}

Output ONLY the JSON object. Do not add any text before or after it."""


def _has_image(image) -> bool:
    """Check whether the image is valid (not None and not an empty tensor)."""
    if image is None:
        return False
    if hasattr(image, "numel") and image.numel() == 0:
        return False
    return True


def calc_shot1_duration(fps: float) -> float:
    """Calculate first shot duration (seconds): ceil(8*100/fps)/100, rounded to 3 decimal places."""
    return round(math.ceil(8 * 100 / fps) / 100, 3)


def _remove_dialogue(text: str) -> str:
    """Remove dialogue content from a plain-text previous prompt.

    Strips:
    - `{{ROLE_N_DIALOGUE_M}}` dialogue placeholders
    - Quoted dialogue fragments (Chinese 「」『』“” and English "...")
    - Residual speech verbs such as "says, / replies:"
    """
    text = re.sub(r"\{\{\s*ROLE_\d+_DIALOGUE_\d+\s*\}\}", "", text)
    text = re.sub(r"：", ".", text)
    text = re.sub(r":", ".", text)
    text = re.sub(r"“[^”]*”", "", text)
    text = re.sub(r"‘[^’]*’", "", text)
    text = re.sub(r"「[^」]*」", "", text)
    text = re.sub(r"『[^』]*』", "", text)
    text = re.sub(r'"[^"\n]*"', "", text)
    text = re.sub(
        r"\b(?:says|said|replies|replied|asks|asked|answers|answered)\b\s*[,:：]\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text


def _extract_prev_prompt(last_prompt: str) -> str:
    """Extract the usable visual reference from the previous segment prompt.

    Rules:
    - Empty input → ""
    - Valid JSON (structured output) → "" — a structured JSON cannot be used
      directly as a reference, so it is discarded
    - Plain text → dialogue content removed, rest kept for visual continuity
    """
    if not last_prompt:
        return ""
    stripped = last_prompt.strip()
    if not stripped:
        return ""
    try:
        parse_generated_json(stripped)
        log.info("[MiniMaxRefPromptEnhance] prev_prompt is JSON, ignored as reference")
        return ""
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return _remove_dialogue(stripped)


def build_prompt_text(
    last_prompt: str,
    prompt: str,
    duration: float,
    enhance: str,
    has_image: bool,
    shot1_dur: float = 0.0,
) -> str:
    """Build the prompt text sent to the CLIP/VLM model dynamically.

    Args:
        last_prompt: previous segment prompt (can be empty)
        prompt: new user input
        duration: total video duration (seconds)
        enhance: prompt mode ("Basic" = basic, "Enhanced" = enhanced). "Pre-formatted" skips VLM and never calls this function.
        has_image: whether a first-frame reference image is provided
        shot1_dur: first shot duration (only used when has_image=True, for log info)
    """
    # Sanitize the previous prompt: discard structured JSON (not usable as a
    # reference) and strip dialogue content from plain text.
    prev_prompt = _extract_prev_prompt(last_prompt)
    has_last = bool(prev_prompt)

    shot1_desc_instruction = (
        '\n  - "shot1_description": Describe the opening scene from the reference image. Describe the environment, characters, lighting, and atmosphere. Must output a full visual description—never use null!'
        if has_image else ''
    )
    shot1_example = (
        '  "shot1_description": "A warm cafe interior bathed in soft afternoon light. {{ROLE_0}} sits alone at a corner table, staring pensively at a cup of coffee. {{ROLE_1}} enters through the door in the background, partially silhouetted against the bright street outside.",\n'
        if has_image else ''
    )
    shot1_dur_str = seconds_to_mmssmmm(shot1_dur)
    shot_structure = SHOT_STRUCTURE_HAS_IMAGE.format(shot1_dur=shot1_dur_str) if has_image else SHOT_STRUCTURE_NO_IMAGE

    if enhance == "Enhanced":
        shot_example = EXAMPLE_ENHANCED_HAS_IMAGE if has_image else EXAMPLE_ENHANCED_NO_IMAGE
    else:
        shot_example = EXAMPLE_BASIC_HAS_IMAGE if has_image else EXAMPLE_BASIC_NO_IMAGE

    is_enhanced = enhance == "Enhanced"

    if is_enhanced:
        parts = [PROMPT_ENHANCE_HEADER]
        if has_image:
            parts.append(PROMPT_ENHANCE_IMAGE_SECTION)
        if has_last:
            parts.append(PROMPT_ENHANCE_LAST_SECTION.format(prev_prompt=prev_prompt))
        if not has_image:
            parts.append(PROMPT_ENHANCE_NO_IMAGE)
        parts.append(PROMPT_ENHANCE_USER_SECTION.format(
            user_input=prompt or "(none)",
            duration=f"{duration:.1f}",
        ))
        if has_image:
            if has_last:
                parts.append(PROMPT_ENHANCE_SHOT1_DIALOGUE_SECTION)
            else:
                parts.append(PROMPT_ENHANCE_SHOT1_SECTION)
        parts.append(PROMPT_ENHANCE_REQUIREMENTS
                     .replace("__SHOT1_DESC__", shot1_desc_instruction)
                     .replace("__SHOT1_EXAMPLE__", shot1_example)
                     .replace("__SHOT_STRUCTURE__", shot_structure)
                     .replace("__SHOT_EXAMPLE__", shot_example))
    else:
        parts = [PROMPT_BASE_HEADER]
        if has_image:
            parts.append(PROMPT_IMAGE_SECTION)
        if has_last:
            parts.append(PROMPT_LAST_SECTION.format(prev_prompt=prev_prompt))
        if not has_image:
            parts.append(PROMPT_NO_IMAGE_INSTRUCTION)
        parts.append(PROMPT_USER_SECTION.format(
            user_input=prompt or "(none)",
            duration=f"{duration:.1f}",
        ))
        if has_image:
            if has_last:
                parts.append(PROMPT_SHOT1_DIALOGUE_SECTION)
            else:
                parts.append(PROMPT_SHOT1_SECTION)
        parts.append(PROMPT_REQUIREMENTS
                     .replace("__SHOT1_DESC__", shot1_desc_instruction)
                     .replace("__SHOT1_EXAMPLE__", shot1_example)
                     .replace("__SHOT_STRUCTURE__", shot_structure)
                     .replace("__SHOT_EXAMPLE__", shot_example))
    return "\n".join(parts)

def _normalize_description(text: str) -> str:
    """Normalize detailed_description text:
    - Full-width colon (:）and half-width colon (:) converted to half-width comma (,)
    - Remove all double-quotes (", ", "")
    """
    text = text.replace("：", "，")  # full-width colon → full-width comma
    # Replace half-width colon with comma, but skip timestamps like "00:00.340"
    text = re.sub(r'(?<!\d\d):(?!\d\d\.\d\d\d)', ',', text)
    text = text.replace('"', "")
    text = text.replace(""", "")
    text = text.replace(""", "")
    return text


def parse_generated_json(generated_text: str) -> dict:
    """Parse JSON from model output, return a dict with all fields."""
    # Prefer extracting content from ```json ... ``` code blocks
    json_match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", generated_text)
    if json_match:
        clean_text = json_match.group(1)
    else:
        # Fallback: match the first raw JSON object in the text
        json_match = re.search(r"\{[\s\S]*\}", generated_text)
        if json_match:
            clean_text = json_match.group(0)
        else:
            clean_text = generated_text.strip()

    return json.loads(clean_text)


# ── Cloud VLM API providers (OpenAI-compatible) ─

API_PROVIDERS = {
    "GLM": {
        "base_url": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "model": "glm-4v-flash",  # 完全免费视觉模型
        "env_key": "ZHIPU_API_KEY",
    },
    "Kimi": {
        "base_url": "https://api.moonshot.cn/v1/chat/completions",
        "model": "moonshot-v1-8k-vision-preview",
        "env_key": "MOONSHOT_API_KEY",
    },
    "Qwen": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        "model": "qwen-vl-plus",
        "env_key": "DASHSCOPE_API_KEY",
    },
    "Doubao": {
        "base_url": "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
        "model": "doubao-1.5-vision-pro-32k",
        "env_key": "ARK_API_KEY",
    },
}

# Map config service ids (lowercase) to legacy provider names used by the nodes.
_SERVICE_TO_PROVIDER = {
    "glm": "GLM",
    "kimi": "Kimi",
    "qwen": "Qwen",
    "doubao": "Doubao",
    "xflow": "xFlow",
    "ollama": "Ollama",
}


def _resolve_api_config(mode: str = "vlm", provider: str = "", api_key: str = "") -> tuple[str, str, str, str]:
    """Merge Settings config with optional node-level overrides.

    Args:
        mode: "llm" or "vlm" — decides which default model/api_key to read from Settings.
        provider: node-level provider override. Accepts legacy names ("GLM"),
            bare service ids ("xflow", "ollama", custom ids) or labeled values
            ("name (id)") generated by the node combo. Empty = use the active service.
        api_key: node-level api_key override (non-empty takes precedence).

    Returns:
        (provider, api_key, base_url, model)
    """
    mode = "llm" if mode == "llm" else "vlm"

    # Normalize node provider to a config service id.
    service_id = parse_provider_value(provider) if provider else ""
    try:
        cfg = api_config_manager.get_config_for(mode, service_id=service_id or None)
    except Exception as e:
        log.warning(f"[MiniMaxRefPromptEnhance] Failed to load API config: {e}")
        cfg = {}

    if service_id:
        # Node-level provider: keep its display name (legacy name for built-ins,
        # service name for custom providers) so logs / errors stay readable.
        resolved_provider = _SERVICE_TO_PROVIDER.get(service_id) or cfg.get("service_name") or service_id.capitalize()
    else:
        # No node override: use the active config's service.
        resolved_provider = _SERVICE_TO_PROVIDER.get(
            cfg.get("service_id", ""), cfg.get("service_name", "GLM")
        )

    resolved_api_key = (api_key or "").strip() or cfg.get("api_key", "").strip()
    resolved_base_url = cfg.get("base_url", "")
    resolved_model = cfg.get("model", "")
    return resolved_provider, resolved_api_key, resolved_base_url, resolved_model


def _tensor_to_base64(image) -> str:
    """Convert a ComfyUI image tensor [B, H, W, C] (float 0-1) to a JPEG base64 data URL."""
    import base64 as _b64
    import io as _io
    from PIL import Image as _PILImage

    img = image[0].float().clamp(0, 1).cpu().numpy()
    img = (img * 255).round().astype("uint8")
    pil_img = _PILImage.fromarray(img, mode="RGB")
    buf = _io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=92)
    return "data:image/jpeg;base64," + _b64.b64encode(buf.getvalue()).decode("ascii")


def _finalize_generated_text(generated_text: str, source_label: str) -> dict:
    """Parse raw VLM output into the standard result dict (shared by API / GGUF backends)."""
    try:
        result = parse_generated_json(generated_text)
        dd = result.get("detailed_description", "") or ""
        result["detailed_description"] = _normalize_description(dd)
    except (json.JSONDecodeError, TypeError) as e:
        log.error(f"[MiniMaxRefPromptEnhance] JSON parse failed from {source_label}: {e}")
        result = {
            "detailed_description": generated_text.strip(),
            "overall_soundscape": None,
            "non_diegetic_music": None,
            "mapping": {},
        }
    return result


def _clamp_seed_32(seed: int | None) -> int | None:
    """Map a (possibly 64-bit) seed into the signed 32-bit int range accepted by
    most OpenAI-compatible providers.

    Zhipu's GLM gateway rejects seeds outside [-2147483648, 2147483647] with
    HTTP 400 ("Numeric value out of range of int"), while the node's seed input
    allows values up to 2^64-1. Clamping keeps the value deterministic while
    staying within the API's contract. Returns None for None input.
    """
    if seed is None:
        return None
    return int(seed) % (2**31)


def _is_glm_vision_model(model: str) -> bool:
    """True for Zhipu GLM vision models, whose max_tokens is capped at 1024.

    Matches names like 'glm-4v', 'glm-4v-flash', 'glm-4.1v-flash',
    'glm-4.6V-Flash', while NOT matching text models such as 'glm-4.5-flash'.
    """
    m = (model or "").strip().lower()
    return bool(re.search(r"glm-4(?:\.\d+)?v", m))


def generate_prompt_with_api(
    image,
    prompt: str,
    last_prompt: str = "",
    duration: float = 5.0,
    fps: float = 24.0,
    enhance: str = "Basic",
    provider: str = "GLM",
    api_key: str = "",
    seed: int | None = None,
    mode: str = "vlm",
) -> dict:
    """Call a cloud LLM/VLM API (OpenAI-compatible) to generate placeholder-tagged prompt JSON.

    Args:
        image: ComfyUI image tensor [B, H, W, C], optional (None = text-only mode)
        prompt: user prompt
        last_prompt: previous segment prompt (can be empty)
        duration: total video duration (seconds)
        fps: frame rate
        enhance: prompt mode ("Basic" = standard; "Enhanced" = polish)
        provider: API provider key ("GLM" / "Kimi" / "Qwen" / "Doubao")
        api_key: explicit API key (empty → read from Settings or env var of the provider)
        seed: sampling seed forwarded to the API (supported by most OpenAI-compatible
            providers). None = don't send the field. Best-effort determinism only —
            the result cache guarantees identical outputs within the same process.
        mode: "llm" or "vlm" — which default model/api_key to read from Settings.

    Returns:
        dict: same shape as generate_prompt_with_clip
    """
    import os
    import urllib.error
    import urllib.request

    resolved_provider, resolved_key, resolved_base_url, resolved_model = _resolve_api_config(
        mode=mode, provider=provider, api_key=api_key
    )

    provider_cfg = API_PROVIDERS.get(resolved_provider)
    if provider_cfg is None:
        # Custom / Settings-only provider: the key can only come from Settings or
        # the node's api_key input (no dedicated env var to fall back to).
        provider_cfg = API_PROVIDERS["GLM"].copy()
        from_settings_only = True
    else:
        provider_cfg = provider_cfg.copy()
        from_settings_only = False
    cfg = provider_cfg
    if resolved_base_url:
        cfg["base_url"] = resolved_base_url
    if resolved_model:
        cfg["model"] = resolved_model

    key = resolved_key or os.environ.get(cfg["env_key"], "").strip()
    if not key:
        if from_settings_only:
            raise ValueError(
                f"[MiniMaxRefPromptEnhance] No API key configured for '{resolved_provider}' "
                "(custom provider). Provide api_key in the node or open ComfyUI Settings "
                "→ API 管理器 and set the api_key for this service."
            )
        raise ValueError(
            f"[MiniMaxRefPromptEnhance] No API key for {resolved_provider}. "
            f"Provide api_key in the node, configure it in Settings, or set env var {cfg['env_key']}."
        )

    has_image = _has_image(image)
    shot1_dur = calc_shot1_duration(fps) if has_image else 0.0
    prompt_text = build_prompt_text(
        last_prompt=last_prompt,
        prompt=prompt,
        duration=duration,
        enhance=enhance,
        has_image=has_image,
        shot1_dur=shot1_dur,
    )

    content: list[dict] = [{"type": "text", "text": prompt_text}]
    if has_image:
        content.append({"type": "image_url", "image_url": {"url": _tensor_to_base64(image)}})

    # Some models cap max_tokens (e.g. GLM's glm-4v* vision models accept only
    # [1, 1024]); pick a safe default up front, then adaptively retry with a
    # smaller cap if the endpoint rejects the value (covers any provider/model).
    max_tokens = 1024 if _is_glm_vision_model(cfg["model"]) else 4096

    payload = {
        "model": cfg["model"],
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.1,
        "max_tokens": max_tokens,
    }
    if seed is not None:
        payload["seed"] = _clamp_seed_32(seed)

    def _post(p: dict) -> str:
        req = urllib.request.Request(
            cfg["base_url"],
            data=json.dumps(p).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.read().decode("utf-8")

    log.info(f"[MiniMaxRefPromptEnhance] Calling {resolved_provider} API ({cfg['model']}) ...")
    try:
        body = _post(payload)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        if payload.get("max_tokens", 0) > 1024 and "max_tokens" in detail:
            log.warning(
                f"[MiniMaxRefPromptEnhance] {resolved_provider} rejected max_tokens="
                f"{payload['max_tokens']} ({detail[:160]}); retrying with max_tokens=1024"
            )
            payload["max_tokens"] = 1024
            try:
                body = _post(payload)
            except urllib.error.HTTPError as e2:
                detail2 = e2.read().decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"[MiniMaxRefPromptEnhance] {resolved_provider} API HTTP {e2.code}: {detail2}"
                ) from e2
        else:
            raise RuntimeError(
                f"[MiniMaxRefPromptEnhance] {resolved_provider} API HTTP {e.code}: {detail}"
            ) from e

    data = json.loads(body)
    try:
        generated_text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(
            f"[MiniMaxRefPromptEnhance] Unexpected {resolved_provider} API response: {body[:500]}"
        ) from e

    log.info(f"[MiniMaxRefPromptEnhance] {resolved_provider} API generated (first 200 chars): {generated_text[:200]}")
    return _finalize_generated_text(generated_text, f"{resolved_provider} API")


# ── Local GGUF VLM via llama-cpp-python ─

_LLAMA_MODEL_CACHE: dict = {}


def _ensure_llm_folder_registered() -> None:
    """Ensure ComfyUI's models/llm directory (used for GGUF files) is registered.

    Always adds models/llm even if another extension already registered 'llm'
    (pointing elsewhere), so GGUF files placed there are always discoverable.
    On Windows the models/llm vs models/LLM casing is equivalent.
    """
    llm_dir = os.path.join(folder_paths.models_dir, "llm")
    try:
        paths = folder_paths.get_folder_paths("llm")
    except KeyError:
        folder_paths.add_model_folder_path("llm", llm_dir)
        return
    if llm_dir not in paths:
        folder_paths.add_model_folder_path("llm", llm_dir)


def _list_llm_gguf_files() -> list[str]:
    """List *.gguf under the registered 'llm' folders plus models/llm (or models/LLM).

    Deliberately bypasses folder_paths.get_filename_list(): its results are kept
    in a strong cache (cache_helper) that is never invalidated when new
    directories are registered, so a stale empty result can stick forever (e.g.
    another extension registered 'llm' to an empty dir before we added ours, or
    the folder was created after the first call). Scanning the filesystem
    directly guarantees fresh results.
    """
    dirs: list[str] = []
    try:
        dirs.extend(folder_paths.get_folder_paths("llm"))
    except KeyError:
        pass
    for name in ("llm", "LLM"):
        d = os.path.join(folder_paths.models_dir, name)
        if d not in dirs:
            dirs.append(d)
    seen: set[str] = set()
    out: list[str] = []
    for d in dirs:
        if not os.path.isdir(d):
            continue
        try:
            entries = os.listdir(d)
        except OSError:  # pragma: no cover - defensive
            continue
        for f in entries:
            if f.lower().endswith(".gguf") and f not in seen:
                seen.add(f)
                out.append(f)
    return sorted(out)


def _resolve_gguf_inputs(gguf_name: str = "", mmproj_name: str = "") -> tuple[str, str]:
    """Resolve GGUF model + optional mmproj for vlm_mode=llama-cpp.

    Falls back to auto-detecting the first VLM GGUF under models/llm when the
    dropdown selection is empty/stale (e.g. files added after the node list was
    built, or another extension hijacked the 'llm' folder registration).
    """
    _ensure_llm_folder_registered()
    ggufs = _list_llm_gguf_files()
    mmprojs = [f for f in ggufs if "mmproj" in f.lower()]
    models = [f for f in ggufs if f not in mmprojs]

    if not gguf_name and models:
        gguf_name = models[0]
        log.info(f"[MiniMaxRefPromptEnhance] gguf_name empty, auto-selected {gguf_name!r} from models/llm")
    if (not mmproj_name or mmproj_name == "None") and mmprojs:
        mmproj_name = mmprojs[0]
        log.info(f"[MiniMaxRefPromptEnhance] mmproj_name empty, auto-selected {mmproj_name!r}")
    return gguf_name, mmproj_name


def _py_tag() -> str:
    """Python tag for wheel matching, e.g. 'cp310'."""
    import sys
    return f"cp{sys.version_info.major}{sys.version_info.minor}"


def _cuda_tag() -> str | None:
    """CUDA tag from torch, e.g. '13.1' -> 'cu131'; None when torch has no CUDA build."""
    try:
        ver = torch.version.cuda
    except Exception:
        return None
    return "cu" + "".join(ver.split(".")[:2]) if ver else None


def _ensure_llama_cpp() -> None:
    """Make llama_cpp importable; print a manual-install hint when missing.

    llama-cpp-python is intentionally NOT auto-installed. When it is missing,
    a console message with the download link and install steps is printed
    instead, so the user can pick the correct prebuilt wheel for their
    environment (platform / Python / CUDA).
    """
    try:
        import llama_cpp  # noqa: F401
        return
    except ImportError:
        pass

    py_tag = _py_tag()
    cuda_tag = _cuda_tag() or "CPU/unknown"
    log.error(
        "[MiniMaxRefPromptEnhance] llama-cpp-python 未安装，无法加载本地 GGUF 模型"
        "（已移除自动安装，请按以下步骤手动安装）：\n"
        "1. 打开 https://github.com/JamePeng/llama-cpp-python/releases 下载最新 release 中的预编译 wheel\n"
        f"2. 选择与你的环境匹配的文件（形如 llama_cpp_python-0.3.46+cu131-{py_tag}-{py_tag}-win_amd64.whl）：\n"
        f"   - win_amd64：Windows x64 平台\n"
        f"   - {py_tag}：当前 Python 版本（由本机解释器检测）\n"
        f"   - cuXXX：CUDA 版本（本机 torch 为 {cuda_tag}，优先选择相同 cu 标签的 wheel，"
        "没有则任意 cu 版本均可）\n"
        "3. 用 ComfyUI portable 自带的 python 安装（在 ComfyUI_windows_portable 目录下执行）：\n"
        '   python_embeded\\python.exe -m pip install <下载的 .whl 文件路径>\n'
        "4. 安装完成后重启 ComfyUI 再重试\n"
    )
    raise RuntimeError(
        "[MiniMaxRefPromptEnhance] llama-cpp-python is not installed. "
        "See the console output above for the manual install steps."
    )


def _unload_llama_models(keep: set | None = None) -> None:
    """Explicitly close and drop cached llama-cpp models, freeing their memory.

    A llama-cpp-python ``Llama`` object owns native buffers (RAM + VRAM) that
    are only returned once ``close()`` is called and the object is released —
    simply removing the dict entry does NOT free anything. This helper:

    1. calls ``Llama.close()`` on every cached model (except keys in ``keep``),
    2. drops the references and forces a ``gc`` pass,
    3. calls ``torch.cuda.empty_cache()`` so VRAM freed by llama.cpp is
       reclaimed from the CUDA allocator pool.

    Args:
        keep: optional set of cache keys (tuples of (gguf_path, mmproj_path))
            to retain in memory, e.g. the model about to be reused by the
            current request.
    """
    global _LLAMA_MODEL_CACHE
    keys = [k for k in list(_LLAMA_MODEL_CACHE) if keep is None or k not in keep]
    if not keys:
        return
    import gc
    import torch

    freed: list[str] = []
    for k in keys:
        model = _LLAMA_MODEL_CACHE.pop(k, None)
        if model is None:
            continue
        name = os.path.basename(k[0])
        try:
            close = getattr(model, "close", None)
            if callable(close):
                close()
        except Exception as e:  # pragma: no cover - defensive
            log.warning(f"[MiniMaxRefPromptEnhance] Error closing llama model {name}: {e}")
        del model
        freed.append(name)
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    log.info(
        f"[MiniMaxRefPromptEnhance] Unloaded llama-cpp model(s): {', '.join(freed) or 'n/a'}; "
        f"cached models remaining: {len(_LLAMA_MODEL_CACHE)}"
    )


def _get_llama_model(gguf_path: str, mmproj_path: str = ""):
    """Load (and cache) a GGUF model with llama-cpp-python; GPU first, CPU fallback.

    Only a single model is kept in memory at a time: loading a different GGUF
    (or different mmproj) evicts the previously cached one, so switching models
    in the dropdown releases the old model's RAM/VRAM immediately.
    """
    global _LLAMA_MODEL_CACHE
    key = (gguf_path, mmproj_path)
    cached = _LLAMA_MODEL_CACHE.get(key)
    if cached is not None:
        return cached
    _ensure_llama_cpp()
    from llama_cpp import Llama

    kwargs: dict = dict(
        model_path=gguf_path,
        n_ctx=8192,
        n_gpu_layers=-1,  # all layers on GPU
        verbose=False,
    )
    if mmproj_path:
        kwargs["mmproj"] = mmproj_path
    log.info(
        f"[MiniMaxRefPromptEnhance] Loading GGUF model: {os.path.basename(gguf_path)} "
        f"(mmproj={os.path.basename(mmproj_path) if mmproj_path else 'None'}) ..."
    )
    try:
        model = Llama(**kwargs)
    except Exception as e:
        log.warning(f"[MiniMaxRefPromptEnhance] GPU load failed ({e}); retrying on CPU (n_gpu_layers=0)")
        kwargs["n_gpu_layers"] = 0
        model = Llama(**kwargs)
    _LLAMA_MODEL_CACHE[key] = model
    # Evict any previously cached model(s) so only the freshly loaded one stays
    # resident (avoids holding multiple multi-GB GGUFs in RAM/VRAM at once).
    _unload_llama_models(keep={key})
    return model


def generate_prompt_with_llama(
    image,
    gguf_path: str,
    mmproj_path: str = "",
    prompt: str = "",
    last_prompt: str = "",
    duration: float = 5.0,
    fps: float = 24.0,
    enhance: str = "Basic",
    seed: int = 42,
) -> dict:
    """Generate the placeholder-tagged prompt JSON with a local GGUF VLM via llama-cpp-python.

    Args:
        image: ComfyUI image tensor [B, H, W, C], optional (None = text-only mode)
        gguf_path: full path to the GGUF text model
        mmproj_path: full path to the vision projector GGUF (required for image analysis)
        prompt: user prompt
        last_prompt: previous segment prompt (can be empty)
        duration: total video duration (seconds)
        fps: frame rate
        enhance: prompt mode ("Basic" = standard; "Enhanced" = polish)
        seed: sampling seed for llama.cpp

    Returns:
        dict: same shape as generate_prompt_with_clip
    """
    has_image = _has_image(image) and bool(mmproj_path)
    if _has_image(image) and not mmproj_path:
        log.warning(
            "[MiniMaxRefPromptEnhance] Image provided but no mmproj (vision projector) selected "
            "-> running in text-only mode."
        )
    shot1_dur = calc_shot1_duration(fps) if has_image else 0.0
    prompt_text = build_prompt_text(
        last_prompt=last_prompt,
        prompt=prompt,
        duration=duration,
        enhance=enhance,
        has_image=has_image,
        shot1_dur=shot1_dur,
    )

    llm = _get_llama_model(gguf_path, mmproj_path)
    content: list[dict] = [{"type": "text", "text": prompt_text}]
    if has_image:
        content.append({"type": "image_url", "image_url": {"url": _tensor_to_base64(image)}})
    log.info(f"[MiniMaxRefPromptEnhance] Generating with GGUF model: {os.path.basename(gguf_path)} ...")
    try:
        resp = llm.create_chat_completion(
            messages=[{"role": "user", "content": content}],
            max_tokens=4096,
            temperature=0.1,
            seed=_clamp_seed_32(seed),
        )
    except Exception as e:
        raise RuntimeError(f"[MiniMaxRefPromptEnhance] GGUF generation failed: {e}") from e
    try:
        generated_text = resp["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"[MiniMaxRefPromptEnhance] Unexpected GGUF response: {str(resp)[:500]}") from e
    log.info(f"[MiniMaxRefPromptEnhance] GGUF model generated (first 200 chars): {generated_text[:200]}")
    return _finalize_generated_text(generated_text, f"GGUF({os.path.basename(gguf_path)})")


# ── Deterministic result cache (same inputs → same output) ────────────
#
# Guarantees identical VLM parsing results for identical inputs within the
# same process (e.g. Easy-Use for-loop iterations that reuse the same prompt /
# seed / image). Cache key = hash of every generation-affecting input.

_RESULT_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_RESULT_CACHE_MAX = 128


def _image_hash(image) -> str:
    """Stable content hash of an image tensor (empty string when no image)."""
    if image is None:
        return ""
    try:
        arr = image.detach().float().cpu().contiguous().numpy().tobytes()
    except Exception:
        return f"id:{id(image)}"
    return hashlib.sha256(arr).hexdigest()[:32]


def _make_cache_key(
    image,
    clip,
    gguf_name: str,
    mmproj_name: str,
    vlm_mode: str,
    api_provider: str,
    api_key: str,
    clip_name: str,
    clip_type: str,
    last_prompt: str,
    prompt: str,
    duration: float,
    fps: float,
    enhance: str,
    max_length: int,
    do_sample: bool,
    temperature: float,
    top_k: int,
    top_p: float,
    min_p: float,
    repetition_penalty: float,
    seed: int,
    presence_penalty: float,
    thinking: bool,
    use_default_template: bool,
) -> str:
    fields = {
        "vlm_mode": str(vlm_mode),
        "api_provider": str(api_provider),
        "api_key": hashlib.sha256(str(api_key or "").encode("utf-8")).hexdigest()[:16],
        "clip_ref": f"id:{id(clip)}" if clip is not None else "",
        "clip_name": str(clip_name),
        "clip_type": str(clip_type),
        "gguf_name": str(gguf_name),
        "mmproj_name": str(mmproj_name),
        "last_prompt": str(last_prompt),
        "prompt": str(prompt),
        "duration": float(duration),
        "fps": float(fps),
        "enhance": str(enhance),
        "max_length": int(max_length),
        "do_sample": bool(do_sample),
        "temperature": float(temperature),
        "top_k": int(top_k),
        "top_p": float(top_p),
        "min_p": float(min_p),
        "repetition_penalty": float(repetition_penalty),
        "seed": int(seed) if seed is not None else None,
        "presence_penalty": float(presence_penalty),
        "thinking": bool(thinking),
        "use_default_template": bool(use_default_template),
        "image_hash": _image_hash(image),
    }
    raw = json.dumps(fields, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _generate_prompt_with_clip_uncached(
    image,
    clip=None,
    gguf_name: str = "",
    mmproj_name: str = "",
    vlm_mode: str = "clip",
    api_provider: str = "GLM",
    api_key: str = "",
    clip_name: str = "",
    clip_type: str = "qwen3vl",
    last_prompt: str = "",
    prompt: str = "",
    duration: float = 5.0,
    fps: float = 24.0,
    enhance: str = "Basic",
    max_length: int = 1024,
    do_sample: bool = True,
    temperature: float = 0.1,
    top_k: int = 32,
    top_p: float = 0.9,
    min_p: float = 0.0,
    repetition_penalty: float = 1.0,
    seed: int = 62,
    presence_penalty: float = 0.0,
    thinking: bool = False,
    use_default_template: bool = True,
) -> dict:
    """Analyze the first-frame image and generate a placeholder-tagged prompt JSON.

    Mode selection (vlm_mode):
    - "clip": local CLIP model (external `clip` object, or loaded via clip_name/clip_type)
    - "llama-cpp": local GGUF VLM via llama-cpp-python (models/llm, optional mmproj for vision)
    - "api": cloud VLM API (GLM / Kimi / Qwen / Doubao)
    "Pre-formatted" enhance always parses the user prompt as JSON directly (no model call).

    Args:
        image: ComfyUI image tensor [B, H, W, C], optional (None = text-only mode)
        clip: external CLIP model object (optional; required when vlm_mode=clip and no clip_name)
        gguf_name: GGUF model filename under models/llm (used when vlm_mode=llama-cpp)
        mmproj_name: optional vision projector GGUF under models/llm ("None" = text-only)
        vlm_mode: VLM backend selector: "clip" / "llama-cpp" / "api"
        api_provider: API provider key ("GLM" / "Kimi" / "Qwen" / "Doubao")
        api_key: explicit API key (empty → read from provider env var)
        clip_name: model filename under text_encoders directory (required when clip is None and vlm_mode=clip)
        clip_type: CLIP model variant ("minimax", "qwen3vl", "gemma")
        last_prompt: previous segment prompt (can be empty)
        prompt: new user prompt; in "Pre-formatted" mode this is a pre-formatted skills JSON
        duration: total video duration (seconds)
        fps: frame rate
        enhance: prompt mode ("Basic" = standard; "Enhanced" = polish)
        max_length: max generated text length
        do_sample: whether to use random sampling
        temperature: sampling temperature
        top_k: Top-K sampling
        top_p: Top-P sampling
        min_p: Min-P sampling
        repetition_penalty: repetition penalty
        seed: random seed
        presence_penalty: presence penalty
        thinking: thinking mode
        use_default_template: whether to use the model's built-in template

    Returns:
        dict: {
            "detailed_description": str,
            "overall_soundscape": str,
            "non_diegetic_music": str,
            "mapping": dict,
        }
    """

    # The local GGUF model can occupy several GB of RAM/VRAM. Whenever the node
    # is not configured for vlm_mode=llama-cpp (i.e. clip / api / Pre-formatted),
    # release it so memory is not held indefinitely after switching modes.
    if vlm_mode != "llama-cpp":
        _unload_llama_models()

    has_image = _has_image(image)
    shot1_dur = calc_shot1_duration(fps) if has_image else 0.0

    # "Pre-formatted" mode: prompt is already a pre-formatted skills JSON, parse directly.
    if enhance == "Pre-formatted":
        log.info("[MiniMaxRefPromptEnhance] Pre-formatted mode: parsing user prompt as JSON, skipping VLM...")
        try:
            result = parse_generated_json(prompt)
        except (json.JSONDecodeError, TypeError) as e:
            log.warning(f"[MiniMaxRefPromptEnhance] Failed to parse user prompt as JSON: {e}, falling back to raw detailed_description")
            result = {
                "detailed_description": prompt,
                "overall_soundscape": None,
                "non_diegetic_music": None,
                "mapping": {},
            }
        return result

    # (has_image and shot1_dur already computed above for Basic/Enhanced modes)

    # Cloud API mode: vlm_mode == "api" -> remote VLM (GLM/Kimi/Qwen/Doubao)
    if vlm_mode == "api":
        log.info(f"[MiniMaxRefPromptEnhance] vlm_mode=api -> calling {api_provider} cloud API")
        return generate_prompt_with_api(
            image=image,
            prompt=prompt,
            last_prompt=last_prompt,
            duration=duration,
            fps=fps,
            enhance=enhance,
            provider=api_provider,
            api_key=api_key,
            seed=seed,
            mode="vlm",
        )

    # Local GGUF VLM mode (llama-cpp-python): vlm_mode == "llama-cpp"
    if vlm_mode == "llama-cpp":
        gguf_name, mmproj_name = _resolve_gguf_inputs(gguf_name, mmproj_name)
        if not gguf_name:
            raise ValueError(
                "[MiniMaxRefPromptEnhance] vlm_mode=llama-cpp requires a GGUF model: "
                "set gguf_name (model under models/llm) or switch vlm_mode to 'clip' / 'api'."
            )
        _ensure_llm_folder_registered()
        gguf_path = folder_paths.get_full_path_or_raise("llm", gguf_name)
        mmproj_path = ""
        if mmproj_name and mmproj_name != "None":
            mmproj_path = folder_paths.get_full_path_or_raise("llm", mmproj_name)
        return generate_prompt_with_llama(
            image=image,
            gguf_path=gguf_path,
            mmproj_path=mmproj_path,
            prompt=prompt,
            last_prompt=last_prompt,
            duration=duration,
            fps=fps,
            enhance=enhance,
            seed=seed,
        )

    # vlm_mode == "clip": local CLIP model (prefer externally-provided clip)
    external_clip = clip is not None
    if not external_clip:
        if not clip_name:
            raise ValueError(
                "[MiniMaxRefPromptEnhance] vlm_mode=clip requires a local CLIP model: "
                "connect an external CLIP model (CLIP Loader node) or set clip_name, "
                "or switch vlm_mode to 'llama-cpp' / 'api'."
            )
        clip_type_enum = getattr(comfy.sd.CLIPType, clip_type.upper(), comfy.sd.CLIPType.MINIMAX)
        clip_path = folder_paths.get_full_path_or_raise("text_encoders", clip_name)
        clip = comfy.sd.load_clip(
            ckpt_paths=[clip_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=clip_type_enum,
        )
        log.info(f"[MiniMaxRefPromptEnhance] Loaded CLIP model: {clip_name} (type={clip_type})")
    else:
        log.info(f"[MiniMaxRefPromptEnhance] Using externally-provided CLIP model")

    # Build prompt text
    prompt_text = build_prompt_text(
        last_prompt=last_prompt,
        prompt=prompt,
        duration=duration,
        enhance=enhance,
        has_image=has_image,
        shot1_dur=shot1_dur,
    )

    log.info(
        f"[MiniMaxRefPromptEnhance] Generating prompt... "
        f"(last_prompt: {len(last_prompt)} chars, prompt: {len(prompt)} chars, "
        f"duration: {duration:.1f}s, fps: {fps}, enhance: {enhance}, "
        f"has_image: {has_image}, shot1_dur: {shot1_dur})"
    )

    tokens = None
    generated_ids = None
    generated_text = ""
    try:
        # Tokenize: encode prompt and image (if available) together
        tokenize_kwargs = {
            "skip_template": not use_default_template,
            "min_length": 1,
            "thinking": thinking,
        }
        if has_image:
            tokenize_kwargs["image"] = image

        tokens = clip.tokenize(prompt_text, **tokenize_kwargs)

        # Generate text (inference_mode disables autograd to reduce VRAM)
        with torch.inference_mode():
            generated_ids = clip.generate(
                tokens,
                do_sample=do_sample,
                max_length=max_length,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                min_p=min_p,
                repetition_penalty=repetition_penalty,
                presence_penalty=presence_penalty,
                seed=seed,
            )

        generated_text = clip.decode(generated_ids)
        log.info(f"[MiniMaxRefPromptEnhance] Generated (first 200 chars): {generated_text}")

        # Parse JSON (before finally cleanup)
        try:
            result = parse_generated_json(generated_text)
            detailed_description = result.get("detailed_description", "") or ""
            detailed_description = _normalize_description(detailed_description)
            result["detailed_description"] = detailed_description
        except (json.JSONDecodeError, TypeError) as e:
            log.error(f"[MiniMaxRefPromptEnhance] JSON parse failed: {e}")
            log.error(f"[MiniMaxRefPromptEnhance] Raw output: {generated_text}")
            # Fallback: use raw text as detailed_description
            result = {
                "detailed_description": generated_text.strip(),
                "overall_soundscape": None,
                "non_diegetic_music": None,
                "mapping": {},
            }

        return result

    finally:
        # Release intermediate tensors to avoid VRAM leaks
        del tokens, generated_ids
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        # Only release internally-loaded CLIP model reference (ComfyUI's internal cache keeps a copy)
        # Externally-provided clip is NOT released — managed by the caller
        if not external_clip:
            del clip


def generate_prompt_with_clip(
    image,
    clip=None,
    gguf_name: str = "",
    mmproj_name: str = "",
    vlm_mode: str = "clip",
    api_provider: str = "GLM",
    api_key: str = "",
    clip_name: str = "",
    clip_type: str = "qwen3vl",
    last_prompt: str = "",
    prompt: str = "",
    duration: float = 5.0,
    fps: float = 24.0,
    enhance: str = "Basic",
    max_length: int = 1024,
    do_sample: bool = True,
    temperature: float = 0.1,
    top_k: int = 32,
    top_p: float = 0.9,
    min_p: float = 0.0,
    repetition_penalty: float = 1.0,
    seed: int = 62,
    presence_penalty: float = 0.0,
    thinking: bool = False,
    use_default_template: bool = True,
) -> dict:
    """Analyze the first-frame image and generate a placeholder-tagged prompt JSON.

    Wraps :func:`_generate_prompt_with_clip_uncached` with a process-level result
    cache, guaranteeing that identical inputs (mode, prompt, image, seed, sampling
    params) always produce identical outputs — for clip / llama-cpp / api alike.
    This keeps Easy-Use for-loop iterations and repeated runs deterministic within
    the same ComfyUI session, and skips redundant API / model calls.

    Args: (same as _generate_prompt_with_clip_uncached)

    Returns:
        dict: {
            "detailed_description": str,
            "overall_soundscape": str,
            "non_diegetic_music": str,
            "mapping": dict,
        }
    """
    # "Pre-formatted" mode parses the user prompt directly (no VLM call) — fully
    # deterministic, so it bypasses the cache.
    if enhance == "Pre-formatted":
        return _generate_prompt_with_clip_uncached(
            image=image, clip=clip, gguf_name=gguf_name, mmproj_name=mmproj_name,
            vlm_mode=vlm_mode, api_provider=api_provider, api_key=api_key,
            clip_name=clip_name, clip_type=clip_type, last_prompt=last_prompt,
            prompt=prompt, duration=duration, fps=fps, enhance=enhance,
            max_length=max_length, do_sample=do_sample, temperature=temperature,
            top_k=top_k, top_p=top_p, min_p=min_p,
            repetition_penalty=repetition_penalty, seed=seed,
            presence_penalty=presence_penalty, thinking=thinking,
            use_default_template=use_default_template,
        )

    cache_key = _make_cache_key(
        image, clip, gguf_name, mmproj_name, vlm_mode, api_provider, api_key,
        clip_name, clip_type, last_prompt, prompt, duration, fps, enhance,
        max_length, do_sample, temperature, top_k, top_p, min_p,
        repetition_penalty, seed, presence_penalty, thinking, use_default_template,
    )
    cached = _RESULT_CACHE.get(cache_key)
    if cached is not None:
        log.info(
            f"[MiniMaxRefPromptEnhance] Result cache HIT "
            f"(vlm_mode={vlm_mode}, enhance={enhance}, seed={seed})"
        )
        _RESULT_CACHE.move_to_end(cache_key)
        return copy.deepcopy(cached)

    result = _generate_prompt_with_clip_uncached(
        image=image, clip=clip, gguf_name=gguf_name, mmproj_name=mmproj_name,
        vlm_mode=vlm_mode, api_provider=api_provider, api_key=api_key,
        clip_name=clip_name, clip_type=clip_type, last_prompt=last_prompt,
        prompt=prompt, duration=duration, fps=fps, enhance=enhance,
        max_length=max_length, do_sample=do_sample, temperature=temperature,
        top_k=top_k, top_p=top_p, min_p=min_p,
        repetition_penalty=repetition_penalty, seed=seed,
        presence_penalty=presence_penalty, thinking=thinking,
        use_default_template=use_default_template,
    )
    _RESULT_CACHE[cache_key] = copy.deepcopy(result)
    while len(_RESULT_CACHE) > _RESULT_CACHE_MAX:
        _RESULT_CACHE.popitem(last=False)
    return result


class MinimaxRefPromptEnhance(io.ComfyNode):
    """Use a CLIP model to analyze the first-frame image (optional) and generate placeholder-tagged formatting prompt JSON."""

    @classmethod
    def define_schema(cls):
        text_encoders = folder_paths.get_filename_list("text_encoders")
        clip_types = ["minimax", "qwen3vl", "gemma"]
        _ensure_llm_folder_registered()
        gguf_files = [f for f in folder_paths.get_filename_list("llm") if f.lower().endswith(".gguf")]
        provider_options, provider_default = api_config_manager.get_provider_options("vlm")

        return io.Schema(
            node_id="MiniMaxRefPromptEnhance",
            display_name="MiniMax Ref Prompt Enhance",
            category="minimaxrefdirector/prompt",
            description="Uses a CLIP model to analyze the first-frame image (optional), incorporate the previous prompt (optional) and user input, then produce structured placeholder-tagged shot descriptions.",
            inputs=[
                io.Combo.Input(
                    "clip_name",
                    options=text_encoders,
                    default=text_encoders[0] if text_encoders else "",
                    tooltip="Select a text encoder (CLIP/VL) model",
                ),
                io.Combo.Input(
                    "clip_type",
                    options=clip_types,
                    default="qwen3vl",
                    tooltip="CLIP model variant",
                ),
                io.Image.Input(
                    "image",
                    optional=True,
                    tooltip="First-frame image (optional). Text-only mode when not connected.",
                ),
                io.String.Input(
                    "last_prompt",
                    display_name="last_prompt",
                    multiline=True,
                    default="",
                    tooltip="Previous segment prompt (optional, provides context when first frame is present)",
                ),
                io.String.Input(
                    "prompt",
                    display_name="prompt",
                    multiline=True,
                    default="",
                    tooltip="New user prompt; in 'Pre-formatted' mode this should be a pre-formatted skills JSON",
                ),
                io.Float.Input(
                    "duration",
                    display_name="duration",
                    default=5.0,
                    min=0.5,
                    max=3600.0,
                    step=0.5,
                    tooltip="Total video duration (seconds)",
                ),
                io.Float.Input(
                    "fps",
                    display_name="fps",
                    default=24.0,
                    min=1.0,
                    max=120.0,
                    step=0.01,
                    tooltip="Frame rate (fps), used for calculating first-shot duration",
                ),
                io.Combo.Input(
                    "enhance",
                    options=["Basic", "Enhanced", "Pre-formatted"],
                    default="Basic",
                    tooltip="Prompt generation mode: Basic=standard generation | Enhanced=polish + fill ambient sound / camera movement / BGM | Pre-formatted=parse prompt as pre-formatted JSON (no VLM)",
                ),
                io.Combo.Input(
                    "vlm_mode",
                    options=["clip", "llama-cpp", "api"],
                    default="clip",
                    tooltip="VLM backend for prompt enhancement: clip=local CLIP | llama-cpp=local GGUF via llama-cpp-python (needs gguf_name) | api=cloud API (GLM/Kimi/Qwen/Doubao)",
                ),
                io.Combo.Input(
                    "gguf_name",
                    options=[""] + gguf_files,
                    default=gguf_files[0] if gguf_files else "",
                    tooltip="Local GGUF VLM model (e.g. Qwen3-VL) under models/llm, loaded via llama-cpp-python. Used when vlm_mode=llama-cpp.",
                ),
                io.Combo.Input(
                    "mmproj_name",
                    options=["None"] + gguf_files,
                    default="None",
                    tooltip="Optional vision projector (mmproj) GGUF for multimodal models (under models/llm). 'None' = text-only mode.",
                ),
                io.Combo.Input(
                    "api_provider",
                    options=provider_options,
                    default=provider_default,
                    tooltip="Cloud VLM API provider (used when vlm_mode=api). Options come from Settings → API 管理器 — add / edit services there, then restart ComfyUI (or re-import this node) to refresh. GLM-4V-Flash is fully free; others require quota.",
                ),
                io.String.Input(
                    "api_key", default="", multiline=False,
                    tooltip="API key. Leave empty to read from environment variable (ZHIPU_API_KEY / MOONSHOT_API_KEY / DASHSCOPE_API_KEY / ARK_API_KEY).",
                ),
                io.Int.Input(
                    "max_length",
                    default=512,
                    min=16,
                    max=32768,
                    tooltip="Max generated text length (including input prompt). Lower values speed up generation.",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "do_sample",
                    optional=True,
                    default=True,
                    tooltip="Enable random sampling (disable for greedy decoding)",
                    advanced=True,
                ),
                io.Float.Input(
                    "temperature",
                    optional=True,
                    display_name="temperature",
                    default=0.1,
                    min=0.01,
                    max=2.0,
                    step=0.01,
                    tooltip="Sampling temperature",
                    advanced=True,
                ),
                io.Int.Input(
                    "top_k",
                    optional=True,
                    display_name="top_k",
                    default=32,
                    min=0,
                    max=1000,
                    tooltip="Top-K sampling",
                    advanced=True,
                ),
                io.Float.Input(
                    "top_p",
                    optional=True,
                    display_name="top_p",
                    default=0.9,
                    min=0.0,
                    max=1.0,
                    step=0.01,
                    tooltip="Top-P (nucleus) sampling",
                    advanced=True,
                ),
                io.Float.Input(
                    "min_p",
                    optional=True,
                    display_name="min_p",
                    default=0.0,
                    min=0.0,
                    max=1.0,
                    step=0.01,
                    tooltip="Min-P sampling",
                    advanced=True,
                ),
                io.Float.Input(
                    "repetition_penalty",
                    optional=True,
                    display_name="repetition_penalty",
                    default=1.0,
                    min=0.0,
                    max=5.0,
                    step=0.01,
                    tooltip="Repetition penalty",
                    advanced=True,
                ),
                io.Int.Input(
                    "seed",
                    optional=True,
                    display_name="seed",
                    default=42,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    tooltip="Random seed",
                    advanced=True,
                ),
                io.Float.Input(
                    "presence_penalty",
                    optional=True,
                    display_name="presence_penalty",
                    default=0.0,
                    min=0.0,
                    max=5.0,
                    step=0.01,
                    tooltip="Presence penalty",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "thinking",
                    optional=True,
                    default=False,
                    tooltip="Enable thinking mode (if supported by the model)",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "use_default_template",
                    optional=True,
                    default=True,
                    tooltip="Use model built-in system prompt / template",
                    advanced=True,
                ),
            ],
            outputs=[
                io.String.Output(
                    display_name="JSON",
                    tooltip="JSON string containing detailed_description, overall_soundscape, non_diegetic_music, and mapping",
                ),
                io.String.Output(
                    display_name="detailed_description",
                    tooltip="Formatted shot descriptions (with timestamps and placeholders)",
                ),
                io.String.Output(
                    display_name="mapping",
                    tooltip="Placeholder-to-text mapping (JSON string)",
                ),
            ],
        )

    @classmethod
    def execute(
        cls,
        clip_name,
        clip_type,
        image,
        last_prompt="",
        prompt="",
        duration=5.0,
        fps=24.0,
        enhance="Basic",
        vlm_mode="clip",
        gguf_name="",
        mmproj_name="None",
        api_provider="GLM",
        api_key="",
        max_length=512,
        do_sample=True,
        temperature=0.1,
        top_k=32,
        top_p=0.9,
        min_p=0.0,
        repetition_penalty=1.0,
        seed=42,
        presence_penalty=0.0,
        thinking=False,
        use_default_template=True,
    ) -> io.NodeOutput:
        result = generate_prompt_with_clip(
            clip_name=clip_name,
            clip_type=clip_type,
            vlm_mode=vlm_mode,
            gguf_name=gguf_name,
            mmproj_name=mmproj_name,
            api_provider=api_provider,
            api_key=api_key,
            image=image,
            last_prompt=last_prompt,
            prompt=prompt,
            duration=duration,
            fps=fps,
            enhance=enhance,
            max_length=max_length,
            do_sample=do_sample,
            temperature=temperature,
            top_k=top_k,
            top_p=top_p,
            min_p=min_p,
            repetition_penalty=repetition_penalty,
            seed=seed,
            presence_penalty=presence_penalty,
            thinking=thinking,
            use_default_template=use_default_template,
        )

        full_json = json.dumps(result, ensure_ascii=False)
        mapping_str = json.dumps(result.get("mapping", {}), ensure_ascii=False)

        return io.NodeOutput(
            full_json,
            result["detailed_description"],
            mapping_str,
        )


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefPromptEnhance": MinimaxRefPromptEnhance,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefPromptEnhance": "MiniMax Ref Prompt Enhance",
}
