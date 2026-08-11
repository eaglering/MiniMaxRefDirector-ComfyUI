import gc
import json
import logging
import math
import re

import comfy.sd
import folder_paths
import torch
from comfy_api.latest import io

log = logging.getLogger(__name__)

# ── Basic Prompt (no enhancement) ──────────────────────────────────

PROMPT_BASE_HEADER = """You are a video prompt writer for a full-reference text-to-video generation system. Convert user input into a structured video prompt with character and dialogue placeholders for downstream mapping and generation.

Write all shot descriptions in English. Only dialogue content in the mapping may retain its original language (Chinese or English) with a `[Chinese]` or `[English]` prefix."""

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

Video duration: {duration} seconds at 24fps."""

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
5. Mapping values for dialogue must include a language tag prefix: `[Chinese]` for Chinese or `[English]` for English. Auto-detect the language of the dialogue content.

## Writing Guidelines (Full-Reference Video Prompt Standard):

### detailed_description:
- Begin with 1–2 English sentences establishing the overall visual style, lighting tone, and color palette before `[Shot 1]`.
- Structure shots with `[Shot 1]`, `[Shot 2] At MM:SS.mmm`, `[Shot 3] At MM:SS.mmm`, etc. The opening style sentence has no shot marker, and `[Shot 1]` has no timestamp.
- Write camera movement as natural English prose within each shot description (e.g., "the camera slowly pushes in from a wide establishing shot to a medium close-up", "a static wide shot with shallow depth of field", "a smooth handheld tracking shot").
- Label each speaking character with (S1), (S2), etc., corresponding to their `{{ROLE_N}}` assignment order.
- When a character speaks, place the dialogue placeholder immediately after: `{{ROLE_N}} (Sx) says, {{ROLE_N_DIALOGUE_M}}` or `{{ROLE_N}} (Sx) looks up and replies, {{ROLE_N_DIALOGUE_M}}`.
- For each shot, clearly establish: shot composition (e.g., wide/medium/close-up/over-the-shoulder), subject appearance and position, environment and lighting, character actions and state changes, camera movement, and relevant on-screen sound.
- Describe what is actually visible in the frame—avoid reducing descriptions to plot summaries.
- All shot text must be in English. Only the dialogue values in the mapping may be non-English.

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
__SHOT1_EXAMPLE__  "detailed_description": "The target video is in a warm, cinematic style with soft natural lighting and shallow depth of field.\\n[Shot 1] A cozy cafe interior with exposed brick walls and warm pendant lights. {{ROLE_0}} (S1) and {{ROLE_1}} (S2) sit across from each other at a wooden table by the window. {{ROLE_0}} (S1) leans forward with a serious expression and says, {{ROLE_0_DIALOGUE_0}}.\\n[Shot 2] At 00:03.000, a reverse over-the-shoulder shot on {{ROLE_1}} (S2) as they smile warmly and reply, {{ROLE_1_DIALOGUE_1}}. The camera holds steady in a medium close-up with shallow focus.\\n",
  "overall_soundscape": "Soft coffee-machine steam, gentle cup clinking, and low background chatter continue throughout.",
  "non_diegetic_music": "N/A",
  "mapping": {{
    "ROLE_0": "Zhang San",
    "ROLE_1": "Li Si",
    "ROLE_0_DIALOGUE_0": "[Chinese]你好!",
    "ROLE_1_DIALOGUE_1": "[English]Hello!"
  }}
}}

Output ONLY the JSON object. Do not add any text before or after it."""

# ── Enhanced Prompt ──────────────────────────────────────────────────

PROMPT_ENHANCE_HEADER = """You are a video prompt writer for a full-reference text-to-video generation system. Convert user input into a structured, enriched video prompt with character and dialogue placeholders for downstream mapping and generation.

In addition to basic conversion, you will enhance the output: fill in missing visual details, ambient sound, camera movement, and background music where the user has not specified them. Write all shot descriptions in English."""

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

Video duration: {duration} seconds at 24fps."""

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
5. Mapping values for dialogue must include a language tag prefix: `[Chinese]` for Chinese or `[English]` for English. Auto-detect the language of the dialogue content.

## Enhancement Capabilities:
1. **Visual Enrichment**: Polish and enrich scene descriptions with specific visual detail, lighting descriptors, color palette, texture, and atmosphere. Fill in reasonable visual details where the user input is sparse.
2. **Ambient Sound Completion**: When the user input lacks ambient sound description, infer and add appropriate continuous ambient sound based on the scene context (environment type, weather, location, time of day, on-screen actions).
3. **Camera Movement Completion**: When the user input lacks camera direction, infer and add appropriate camera movements based on the scene's emotional tone and action (e.g., slow push-in for intimacy, static shot for tension, handheld for urgency, tracking for movement).
4. **Background Music Suggestion**: When applicable, suggest appropriate non-diegetic music based on the scene's emotional tone and pacing. Use "N/A" if unsuitable.

## Writing Guidelines (Full-Reference Video Prompt Standard):

### detailed_description:
- Begin with 1–2 English sentences establishing the overall visual style, lighting tone, and color palette before `[Shot 1]`.
- Structure shots with `[Shot 1]`, `[Shot 2] At MM:SS.mmm`, `[Shot 3] At MM:SS.mmm`, etc. The opening style sentence has no shot marker, and `[Shot 1]` has no timestamp.
- Write camera movement as natural English prose within each shot description (e.g., "the camera slowly pushes in from a wide establishing shot to a medium close-up", "a static wide shot with shallow depth of field", "a smooth handheld tracking shot").
- Label each speaking character with (S1), (S2), etc., corresponding to their `{{ROLE_N}}` assignment order.
- When a character speaks, place the dialogue placeholder immediately after: `{{ROLE_N}} (Sx) says, {{ROLE_N_DIALOGUE_M}}` or `{{ROLE_N}} (Sx) looks up and replies, {{ROLE_N_DIALOGUE_M}}`.
- For each shot, clearly establish: shot composition (e.g., wide/medium/close-up/over-the-shoulder), subject appearance and position, environment and lighting, character actions and state changes, camera movement, and relevant on-screen sound.
- Describe what is actually visible in the frame—avoid reducing descriptions to plot summaries.
- All shot text must be in English. Only the dialogue values in the mapping may be non-English.

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
__SHOT1_EXAMPLE__  "detailed_description": "The target video is in a moody, cinematic style with dim warm lighting, deep shadows, and rich amber tones.\\n[Shot 1] A dimly lit cafe interior with exposed brick walls. {{ROLE_0}} (S1) and {{ROLE_1}} (S2) sit across from each other at a worn wooden table. Rain streaks down the window behind them. The camera slowly pushes in from a wide establishing shot to a medium two-shot.\\n[Shot 2] At 00:04.000, a close-up on {{ROLE_0}} (S1). His expression is grave. Fixed camera, shallow depth of field. He says, {{ROLE_0_DIALOGUE_0}}.\\n[Shot 3] At 00:08.000, a reverse over-the-shoulder shot on {{ROLE_1}} (S2). {{ROLE_1}} (S2) smiles warmly and replies, {{ROLE_1_DIALOGUE_1}}. The camera holds steady in a medium close-up.\\n",
  "overall_soundscape": "Soft coffee-machine steam, gentle cup clinking, distant muffled conversation, and rain tapping against the window continue throughout.",
  "non_diegetic_music": "A restrained solo-piano score at a slow tempo, with sustained low cello underneath, growing subtly more hopeful in the middle section.",
  "mapping": {{
    "ROLE_0": "Zhang San",
    "ROLE_1": "Li Si",
    "ROLE_0_DIALOGUE_0": "[Chinese]好久不见。",
    "ROLE_1_DIALOGUE_1": "[English]Hello!"
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


def _calc_shot1_duration(fps: float) -> float:
    """Calculate first shot duration (seconds): ceil(1*100/fps)/100, rounded to 2 decimal places."""
    return round(math.ceil(1 * 100 / fps) / 100, 2)


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
        enhance: prompt mode ("Basic" = basic, "Enhanced" = enhanced). "None" mode skips VLM entirely and never calls this function.
        has_image: whether a first-frame reference image is provided
        shot1_dur: first shot duration (only used when has_image=True, for log info)
    """
    has_last = bool(last_prompt.strip())

    shot1_desc_instruction = (
        '\n  - "shot1_description": Describe the opening scene from the reference image. Describe the environment, characters, lighting, and atmosphere. Must output a full visual description—never use null!'
        if has_image else ''
    )
    shot1_example = (
        '  "shot1_description": "A warm cafe interior bathed in soft afternoon light. {{ROLE_0}} sits alone at a corner table, staring pensively at a cup of coffee. {{ROLE_1}} enters through the door in the background, partially silhouetted against the bright street outside.",\n'
        if has_image else ''
    )

    is_enhanced = enhance == "Enhanced"

    if is_enhanced:
        parts = [PROMPT_ENHANCE_HEADER]
        if has_image:
            parts.append(PROMPT_ENHANCE_IMAGE_SECTION)
        if has_last:
            parts.append(PROMPT_ENHANCE_LAST_SECTION.format(prev_prompt=last_prompt))
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
                     .replace("__SHOT1_EXAMPLE__", shot1_example))
    else:
        parts = [PROMPT_BASE_HEADER]
        if has_image:
            parts.append(PROMPT_IMAGE_SECTION)
        if has_last:
            parts.append(PROMPT_LAST_SECTION.format(prev_prompt=last_prompt))
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
                     .replace("__SHOT1_EXAMPLE__", shot1_example))
    log.info(f"prompt: {json.dumps(parts, indent=2, ensure_ascii=False)}")
    return "\n".join(parts)

def _normalize_description(text: str) -> str:
    """Normalize detailed_description text:
    - Full-width colon (:）and half-width colon (:) converted to half-width comma (,)
    - Remove all double-quotes (", ", "")
    """
    text = text.replace("：", "，")  # full-width colon → full-width comma
    text = text.replace(":", ",")   # half-width colon → half-width comma
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


def generate_prompt_with_clip(
    image,
    clip=None,
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
    """Use a CLIP model to analyze the first-frame image and generate a placeholder-tagged prompt JSON.

    Args:
        image: ComfyUI image tensor [B, H, W, C], optional (None = text-only mode)
        clip: external CLIP model object (optional, preferred when set; loaded via clip_name/clip_type when None)
        clip_name: model filename under text_encoders directory (required when clip is None)
        clip_type: CLIP model variant ("minimax", "qwen3vl", "gemma")
        last_prompt: previous segment prompt (can be empty)
        prompt: new user prompt; in "None" mode this is a pre-formatted skills JSON
        duration: total video duration (seconds)
        fps: frame rate
        enhance: prompt mode ("None" = skip VLM, only placeholder replacement; "Basic" = standard; "Enhanced" = polish)
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

    # "None" mode: user prompt is already pre-formatted per skills JSON — parse directly, skip VLM
    if enhance == "None":
        log.info("[MiniMaxRefPromptEnhance] None mode: skipping VLM, parsing user prompt directly...")
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

    has_image = _has_image(image)
    shot1_dur = _calc_shot1_duration(fps) if has_image else 0.0

    # Load CLIP model (prefer externally-provided clip)
    external_clip = clip is not None
    if not external_clip:
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


class MinimaxRefPromptEnhance(io.ComfyNode):
    """Use a CLIP model to analyze the first-frame image (optional) and generate placeholder-tagged formatting prompt JSON."""

    @classmethod
    def define_schema(cls):
        text_encoders = folder_paths.get_filename_list("text_encoders")
        clip_types = ["minimax", "qwen3vl", "gemma"]

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
                    tooltip="New user prompt; in 'None' mode this should be a pre-formatted skills JSON",
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
                    options=["None", "Basic", "Enhanced"],
                    default="Basic",
                    tooltip="Prompt generation mode: None=skip VLM, placeholder replacement only | Basic=standard generation | Enhanced=polish + fill ambient sound / camera movement / BGM",
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
