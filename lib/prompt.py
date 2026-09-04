
import json
import os
import re
import logging

import folder_paths
import torch
from PIL import Image

from .image import load_image_tensor
from .llm import generate_prompt_with_api, generate_prompt_with_llama, generate_prompt_with_ollama
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
_PROMPT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "prompt",
)
_H3_SKILLS_TEMPLATE_PATH = os.path.join(_PROMPT_DIR, "minimaxh3_custom_ref2v_prompt_writing.txt")
_H3_SKILLS_TEMPLATE_PATH_ZH = os.path.join(_PROMPT_DIR, "minimaxh3_custom_ref2v_prompt_writing_zh.txt")
# 提示词翻译为英文的 skill 模板（非英文语言生成后调用）
_TRANSLATE_TO_EN_TEMPLATE_PATH = os.path.join(_PROMPT_DIR, "prompt_translate_to_en.txt")
# 按语言选择 skills 模板：仅中/英双语，其他语言回退英文模板
_H3_SKILLS_TEMPLATES = {
    "zh": _H3_SKILLS_TEMPLATE_PATH_ZH,
    "en": _H3_SKILLS_TEMPLATE_PATH,
}
# 音频关系 -> retention_analysis 文案模板（{n} 为 Audio 编号）
_AUDIO_RELATION_TEXT = {
    "fully_copy": "{n} is reused 1:1 as the target video's complete final audio track.",
    "partially_copy": "Only part of the timeline or selected audio layers of {n} are copied.",
    "reference": "the target speaker follows {n}'s voice timbre and measured delivery without copying the original signal.",
    "weak_reference": "Only broad similarity in category or atmosphere from {n} is retained.",
}

# ── 运镜预设（Jojocodex MiniMax-H3 Camera Motion LoRA 的 9 大类）─────────────
# key 与前端 transfer.js 的 CAMERA_MOTIONS 保持一致。多选（list[str]）或单值
# （str）均可；空 / "auto" / 未知 key 一律不注入（由模型自由决定运镜）。
# desc 描述该类运镜的镜头语言，examples 给出可直接嵌入 shot 描述的英文运镜
# 短语示例。全部以 "camera motion" 触发词为前缀风格（LoRA 激活词），但具体
# 落点交由 LLM 自然嵌入，不强制固定位置；速度词（slow/steady/quick 等）由
# 模型依镜头节奏自然选择，无独立控件。
_CAMERA_MOTION_PRESETS: dict = {
    "push_in": {
        "name_en": "Push-in / Dolly-in",
        "name_zh": "推近 / 前移",
        "desc": "The camera moves toward the subject or a point of interest, gradually tightening the framing to increase tension or intimacy.",
        "examples": [
            "camera motion, slow push-in on the subject",
            "camera motion, dolly-in gradually closing the distance",
            "camera motion, a gentle push-in that ends on an intimate close-up",
        ],
    },
    "pull_back": {
        "name_en": "Pull-back / Dolly-out",
        "name_zh": "拉远 / 后移",
        "desc": "The camera retreats from the subject, widening the frame to reveal the environment, scale or context.",
        "examples": [
            "camera motion, slow pull-back revealing the surroundings",
            "camera motion, dolly-out widening into an establishing view",
            "camera motion, a long pull-back that shows how small the subject is in the scene",
        ],
    },
    "push_pull": {
        "name_en": "Push + Pull",
        "name_zh": "推拉结合",
        "desc": "A continuous move that combines a push-in with a pull-back (or the reverse) within one shot, creating a dynamic in-and-out rhythm.",
        "examples": [
            "camera motion, push-in then pull-back in one flowing move",
            "camera motion, a dolly-in that reverses into a slow dolly-out",
            "camera motion, rhythmic push-and-pull around the subject",
        ],
    },
    "orbit": {
        "name_en": "Orbit",
        "name_zh": "环绕",
        "desc": "The camera circles around the subject on a partial or full arc, revealing it from continuously changing angles.",
        "examples": [
            "camera motion, slow 360-degree orbit around the subject",
            "camera motion, orbiting arc from the side to the front",
            "camera motion, a full circular flight around the character",
        ],
    },
    "tracking": {
        "name_en": "Tracking / Handheld",
        "name_zh": "跟拍 / 手持",
        "desc": "The camera follows the subject laterally or from behind, moving in parallel with its action (optionally with subtle handheld realism).",
        "examples": [
            "camera motion, tracking shot following the subject sideways",
            "camera motion, handheld follow keeping pace with the movement",
            "camera motion, a smooth tracking run alongside the character",
        ],
    },
    "aerial": {
        "name_en": "Aerial / Drone",
        "name_zh": "航拍 / 无人机",
        "desc": "A high-angle aerial or drone shot that establishes the scene, flies over it, or descends toward a point of interest.",
        "examples": [
            "camera motion, aerial drone shot flying over the landscape",
            "camera motion, high-angle drone descent toward the subject",
            "camera motion, bird's-eye flyover establishing the area",
        ],
    },
    "crane": {
        "name_en": "Crane / Tilt",
        "name_zh": "升降 / 俯仰",
        "desc": "Vertical camera movement: a crane shot rising or lowering, or a tilt sweeping up or down to reframe the scene.",
        "examples": [
            "camera motion, crane shot rising above the scene",
            "camera motion, slow tilt from the feet up to the face",
            "camera motion, a lowering crane that settles at eye level",
        ],
    },
    "pan": {
        "name_en": "Pan",
        "name_zh": "摇镜",
        "desc": "The camera sweeps horizontally from a fixed position, scanning across the scene or moving between subjects.",
        "examples": [
            "camera motion, slow pan across the full scene",
            "camera motion, panning from one subject to another",
            "camera motion, a measured left-to-right pan",
        ],
    },
    "close_up": {
        "name_en": "Close-up / Macro",
        "name_zh": "特写 / 微距",
        "desc": "Extreme close-up or macro framing that isolates a face, object, texture or detail, filling the frame with it.",
        "examples": [
            "camera motion, extreme close-up on the subject's face",
            "camera motion, macro shot of the detail in slow movement",
            "camera motion, tight close-up holding on the object",
        ],
    },
}

def _normalize_camera_motions(camera_motion) -> list:
    """归一化运镜参数为合法 key 列表（顺序稳定、去重）。

    兼容 str 单值 / list 多选 / None；"" / "auto" / None → []（不注入）；
    未知 key 与重复值忽略。返回的 key 均存在于 _CAMERA_MOTION_PRESETS。
    """
    if camera_motion is None:
        return []
    if isinstance(camera_motion, str):
        keys = [camera_motion] if camera_motion.strip() else []
    elif isinstance(camera_motion, (list, tuple)):
        keys = list(camera_motion)
    else:
        return []
    seen = set()
    result = []
    for k in keys:
        if not isinstance(k, str):
            continue
        key = k.strip()
        if not key or key == "auto" or key in seen:
            continue
        if key in _CAMERA_MOTION_PRESETS:
            seen.add(key)
            result.append(key)
    return result


def _camera_motion_note(camera_motion: str | list = "") -> str:
    """按（多选）运镜 key 生成注入生成提示词的运镜指令块；空选择返回空串（不注入）。

    多选时要求 LLM 依据每个 [Shot N] 的镜头语义（景别/动作/情绪），从所选风格
    库中为该 Shot 挑选最契合的单一运镜并自然嵌入英文短语；不同 Shot 可自然轮换，
    不堆叠多风格于一镜，所选风格不必全部出现。速度词由模型依镜头节奏自然选择
    （slow/steady/quick 等），无独立控件。选中 ≤3 类时每类列 3 条示例，
    >3 类时每类列 1 条，控制注入 token。
    """
    keys = _normalize_camera_motions(camera_motion)
    if not keys:
        return ""
    many = len(keys) > 1
    lines = []
    lines.append("## Camera Motion Direction")
    if many:
        lines.append(
            "The target video's shots may use any of the camera motion styles below. "
            "For each [Shot N] description, choose the single style that best matches "
            "that shot's framing, action and emotion, then naturally embed one of its "
            "English camera-motion phrases into that shot. Different shots may switch "
            "styles to fit their content; do not pile multiple styles into one shot, "
            "and not every listed style has to be used."
        )
    else:
        lines.append("The target video should use this camera motion style:")
    examples_limit = 1 if many and len(keys) > 3 else 3
    for key in keys:
        preset = _CAMERA_MOTION_PRESETS[key]
        lines.append(f'- Style: {preset["name_en"]}（{preset["name_zh"]}）')
        lines.append(f"  - {preset['desc']}")
        lines.append("  - Suitable phrases (pick one per shot, adapt the wording, keep the LoRA trigger):")
        for ex in preset["examples"][:examples_limit]:
            lines.append(f"    - {ex}")
    lines.append(
        "- Speed words are not fixed: choose the pace that fits each shot's emotion "
        "and rhythm (e.g. slow / gentle, steady, quick / fast, or progressively "
        "accelerating) and weave it into the camera-motion phrase."
    )
    lines.append(
        '- The fixed trigger "camera motion" and the camera-motion keywords above are '
        'technical LoRA vocabulary: even when the output fields are written in Chinese, '
        'keep these phrases in English exactly as given.'
    )
    return "\n".join(lines) + "\n"

def _load_h3_skills_template(lang: str = "en") -> str:
    """Load the custom H3 skills template (four-field output) for the given language.

    lang == "zh" 使用中文模板，其余语言一律使用英文模板。
    """
    path = _H3_SKILLS_TEMPLATES.get(lang, _H3_SKILLS_TEMPLATES["en"])
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _build_h3_prompt(skills: str, prompt: str, has_image: bool, duration_seconds: float = 0, lang: str = "en", camera_motion: str | list = "") -> str:
    """Build the full prompt sent to the local GGUF VLM.

    Includes the custom skills guide, the required JSON output format
    (summary / detailed_description / overall_soundscape / non_diegetic_music)
    and the <@角色名称> / <#角色名称:对话内容> placeholder rules. When a reference
    image is provided it is NOT treated as a first frame; instead its contents
    are merged into "detailed_description" together with the user's input.
    camera_motion: 运镜 key 或 key 列表（见 _CAMERA_MOTION_PRESETS），空/"auto"/
    未知值不注入；多选时指令 LLM 为每个 [Shot N] 依镜头语义挑最契合的一种自然
    嵌入英文运镜短语（不同 Shot 可轮换风格），速度词由模型自然写。
    """
    image_note = ""
    if has_image:
        image_note = (
            "- If a reference image is provided, analyze what is visible in it "
            "(scene, characters, lighting, atmosphere) and merge it with the "
            "user's input into \"detailed_description\". The image is not a "
            "first frame and must not be output as its own field.\n"
        )

    duration_note = ""
    if duration_seconds and duration_seconds > 0:
        duration_note = (
            "The target video's total duration is %.2f seconds. "
        ) % (float(duration_seconds))

    # 输出语言指令放在 prompt 末尾（模型注意力最强的位置），
    # 避免被模板中大量英文正文/示例带偏语言
    if lang == "zh":
        lang_note = (
            "## Output Language\n"
            "IMPORTANT: All four JSON field values MUST be written entirely in Chinese "
            "(中文) with Chinese punctuation `，` `。` `？` `！`. Do NOT output English "
            "descriptions, even if the user's input is in English. Only the fixed "
            "structural markers ([Shot N], At MM:SS.mmm, <@...>, <#...>), the four "
            "field names, character names, and scene-visible text/dialogue may keep "
            "their original language.\n"
        )
    else:
        lang_note = (
            "## Output Language\n"
            "IMPORTANT: All four JSON field values MUST be written entirely in English. "
            "Only the fixed structural markers ([Shot N], At MM:SS.mmm, <@...>, "
            "<#...>), the four field names, character names, and scene-visible "
            "text/dialogue may keep their original language.\n"
        )

    camera_note = _camera_motion_note(camera_motion)

    return f"""You are an expert video prompt writer. Follow the skills guide below.

## Skills Guide
{skills}

## Task
Rewrite the user's input prompt into a full-reference video prompt.

## Output Format
Output ONLY a JSON object with exactly these keys:
  - "summary": string
  - "detailed_description": string
  - "overall_soundscape": string
  - "non_diegetic_music": string
## Placeholder Rules
In "summary": wrap every character name as <@角色名称>, e.g. <@Zhang San>. The summary is a plain summary and does not contain dialogue.
In "detailed_description", "overall_soundscape" and "non_diegetic_music":
1. Wrap every character name as <@角色名称>, e.g. <@Zhang San>. This applies even if the user wrote the name as a bare word (e.g. "小李做了什么" must become "<@小李>做了什么").
2. Wrap every dialogue as <#角色名称:对话内容>, e.g. <#Zhang San:Hello!> or <#李四:你好！>.
3. Keep character names and dialogue in their original language, never translate them.

## "summary" Format
Write one short paragraph summarizing the target video and its reference relationships. It begins with a square-bracketed task-type prefix, e.g. "[reference generation]" or "[video editing + reference generation + audio reuse]". Choose task types according to the actual role each reference asset plays in the target video: keyframe completion (an image is a concrete frame anchor), reference generation (an asset provides generation guidance), video editing (a source video is directly modified), video continuation (new content continues from a source video), audio reuse (the same audio signal is reused in full or in part), audio reference (only the audio's characteristics are referenced). When multiple relationships hold, combine task types with " + " and do not repeat a type. The summary describes the main subjects and shot flow using <@角色名称> placeholders, e.g. <@Zhang San>, without introducing content beyond the user's input and without quoting any dialogue.

## Strictness
- "detailed_description" MUST begin with "[Shot 1]" and no text may appear before it. If the user's input has no explicit shot marker, open with "[Shot 1]".
- Strictly follow the user's input prompt: format exactly what the user provided. Do NOT add extra descriptions, actions, shots, or dialogue beyond the user's input.
{image_note}{lang_note}{camera_note}## User Input Prompt
{duration_note}{prompt}

Output ONLY the JSON object. Do not add any text before or after it."""


# 生成h3提示词
_H3_DEFAULT_OPTIONS: dict = {
    "gguf_path": "",
    "mmproj_path": "",
    "provider": "GLM",        # vlm_mode="api" 时的服务商
    "api_key": "",            # vlm_mode="api" 时的 key 覆盖
    "ollama_model": "",       # vlm_mode="ollama" 时的模型名（空则回落 API 管理器 / "llava"）
    "ollama_base_url": "",    # vlm_mode="ollama" 时的端点（空则默认 http://localhost:11434/api/chat）
}


# 翻译时禁止改写的片段：<@主体名>、<#主体名:对白>、<d>[语言]对白</d>，
# 以及双引号（含全角引号）包裹的内容（台词/标语/歌名等）。
# 对白是视频实际发声内容、主体名可能含中文，均必须保持原语言。
# 引号保护：半角 "..." 与全角 \u201c...\u201d \u2018...\u2019。
# 注意：不含半角单引号 '...'，避免与英文撇号（don't / it's）冲突。
_PROTECTED_FRAGMENT_RE = re.compile(
    r"<@[^>]*>|<#[^>]*>|<d>.*?</d>|\"[^\"]*\"|\u201c.*?\u201d|\u2018.*?\u2019",
    re.DOTALL,
)
# 占位符使用 PUA 私有区字符（U+E000 与 U+F8FF）+ 序号，几乎不可能出现在正常文本或模型输出中
_PH_PREFIX = "\ue000"
_PH_SUFFIX = "\uf8ff"


def _mask_protected(text: str) -> tuple[str, dict[str, str]]:
    """把禁止改写的片段替换为唯一占位符，返回 (掩码文本, {占位符: 原文})。"""
    if not text:
        return text, {}
    placeholders: dict[str, str] = {}

    def _repl(m: re.Match) -> str:
        token = f"{_PH_PREFIX}{len(placeholders)}{_PH_SUFFIX}"
        placeholders[token] = m.group(0)
        return token

    return _PROTECTED_FRAGMENT_RE.sub(_repl, text), placeholders


def _unmask_protected(text: str, placeholders: dict[str, str]) -> str:
    """将占位符还原为原始片段。"""
    for token, original in placeholders.items():
        text = text.replace(token, original)
    return text


def _translate_text_to_en(text: str, vlm_mode: str, options: dict, seed: int) -> str:
    """将整段视频提示词文本翻译为英文。

    调用方负责将禁止改写的片段（主体名/对白）掩码为占位符（如 MASKED_0），
    翻译后还原；本函数在指令中提示模型原样保留占位符 token。翻译失败回退原文，
    不抛出异常、不中断流程。
    """
    try:
        full_prompt = (
            "You are a professional video prompt translator. Translate the following "
            "video prompt text into fluent, natural English.\n\n"
            "Rules:\n"
            "- Keep fixed structural markers unchanged: [Shot N], At MM:SS.mmm, "
            "<@...>, <#...>, <d>...</d>.\n"
            "- Keep every placeholder token such as MASKED_0 exactly as-is, at the "
            "same position and in the same order. Never translate, delete, or reorder them.\n"
            "- Output only the translated text, with no extra commentary.\n\n"
            "## Text to translate\n\n"
            + text
        )
        if vlm_mode == "api":
            generated = generate_prompt_with_api(
                image=None, prompt=full_prompt,
                provider=options.get("provider", "GLM"),
                api_key=options.get("api_key", ""), seed=seed,
            )
        elif vlm_mode == "llama-cpp":
            generated = generate_prompt_with_llama(
                image=None, prompt=full_prompt,
                gguf_path=options["gguf_path"],
                mmproj_path=options["mmproj_path"], seed=seed,
            )
        elif vlm_mode == "ollama":
            generated = generate_prompt_with_ollama(
                image=None, prompt=full_prompt,
                model=options.get("ollama_model", ""),
                base_url=options.get("ollama_base_url", ""),
                api_key=options.get("api_key", "ollama"),
                seed=seed,
            )
        else:
            return text
        result = str(generated).strip()
        # 模型偶尔把整段输出包在引号里，去掉首尾成对引号
        if len(result) >= 2 and result[0] == result[-1] and result[0] in ('"', "'"):
            result = result[1:-1].strip()
        return result or text
    except Exception as exc:
        log.warning(f"[MiniMaxRefDirector] failed to translate prompt text to English: {exc}")
        return text


def _translate_h3_prompt_to_en(json_data: dict, vlm_mode: str, options: dict, seed: int) -> dict:
    """将四字段提示词翻译为英文。

    读取 prompt_translate_to_en.txt 组装翻译 skill，复用 llm.py 的生成函数
    （image=None 纯文本模式）。翻译保留 [Shot N] / At MM:SS.mmm / <@...> / <#...>
    等固定标签，字段名不变；角色名与对白内容保持原语言（对白是视频实际发声内容，
    不可改写）。实现上先对 <@...> / <#...> / <d>...</d> 做占位符掩码，模型只看到
    无意义占位符、从源头杜绝改写，翻译后还原。若模型破坏/丢失了占位符，则该字段
    整体回退原文。翻译失败或解析失败时回退原 dict，不抛出异常、不中断流程。
    """
    try:
        # 掩码保护片段：翻译前替换为 PUA 占位符，翻译后还原
        protected: dict[str, str] = {}
        masked: dict[str, str] = {}
        for key, value in json_data.items():
            if isinstance(value, str) and value.strip():
                m_text, ph = _mask_protected(value)
                masked[key] = m_text
                protected.update(ph)
            else:
                masked[key] = value
        input_json = json.dumps(masked, ensure_ascii=False, indent=2)
        with open(_TRANSLATE_TO_EN_TEMPLATE_PATH, "r", encoding="utf-8") as f:
            skill = f.read()
        full_prompt = skill.replace("{{INPUT_JSON}}", input_json)
        if vlm_mode == "api":
            generate_text = generate_prompt_with_api(
                image=None, prompt=full_prompt, provider=options.get("provider", "GLM"),
                api_key=options.get("api_key", ""), seed=seed,
            )
        elif vlm_mode == "llama-cpp":
            generate_text = generate_prompt_with_llama(
                image=None, prompt=full_prompt, gguf_path=options["gguf_path"],
                mmproj_path=options["mmproj_path"], seed=seed,
            )
        elif vlm_mode == "ollama":
            generate_text = generate_prompt_with_ollama(
                image=None, prompt=full_prompt,
                model=options.get("ollama_model", ""),
                base_url=options.get("ollama_base_url", ""),
                api_key=options.get("api_key", "ollama"),
                seed=seed,
            )
        else:
            return json_data
        translated = parse_generated_json(generate_text)
        # 逐字段回填：翻译结果缺字段或为空时保留原字段；
        # 若模型删改/丢失了掩码占位符（对白或主体名被污染），该字段整体回退原文
        out = dict(json_data)
        for key in ("summary", "detailed_description", "overall_soundscape", "non_diegetic_music"):
            if isinstance(translated.get(key), str) and translated[key].strip():
                missing = [
                    token for token in protected
                    if token in masked.get(key, "") and token not in translated[key]
                ]
                if missing:
                    continue
                out[key] = _unmask_protected(translated[key], protected)
        return out
    except Exception as exc:
        log.warning(f"[MiniMaxRefDirector] prompt translation to EN failed, falling back to original: {exc}")
        return json_data


def generate_h3_prompt(prompt: str="", image_path: str="", seed: int=42, vlm_mode: str="llama-cpp", options: dict | None = None, duration_seconds: float = 0, lang: str = "en", camera_motion: str | list = "") -> dict:
    """Generate an H3 full-reference prompt JSON.

    options 是一个配置字典（未提供的键使用 _H3_DEFAULT_OPTIONS 默认值），
    避免调用参数不断膨胀。支持的键：
      - gguf_path / mmproj_path: llama-cpp 本地 GGUF 模型文件
      - image_path: 参考图路径（提供时与用户输入合并进 detailed_description）
      - seed: 采样种子
      - vlm_mode: "llama-cpp"（默认，本地 GGUF）/ "api"（云端 OpenAI 兼容接口）/
        "ollama"（本地 Ollama 服务）
      - provider: vlm_mode="api" 时的服务商（走 API 管理器配置）
      - api_key: vlm_mode="api"/"ollama" 时的 key 覆盖（可留空，回落配置/环境变量；
        Ollama 无需真实 key，任意非空占位符即可）
      - ollama_model: vlm_mode="ollama" 时的模型名（空则回落 API 管理器 ollama 服务 / "llava"）
      - ollama_base_url: vlm_mode="ollama" 时的端点（空则默认 http://localhost:11434/api/chat）
      - clip_type: CLIP 模型类型（"minimax" / "qwen3vl" / "gemma"）
      - lang: "zh" 加载中文模板，其余语言加载英文模板；同时在 prompt 末尾
        追加对应的输出语言强制指令（弥补模板正文以英文为主导致模型语言漂移的问题）

    The output JSON includes summary / detailed_description /
    overall_soundscape / non_diegetic_music (a provided reference image is
    merged into detailed_description, not treated as a first frame). Character
    names are wrapped as <@名字> and dialogue as <#名字:[Language]对话> directly
    by the model, with a language tag such as [Chinese] or [English] before the
    dialogue text. No mapping is returned. 输出语言由所选 skills 模板决定：
    lang="zh" 中文模板强制中文，其余语言英文模板强制英文。
    camera_motion: 运镜 key 或 key 列表（见 _CAMERA_MOTION_PRESETS），空/"auto"/
    未知值不注入，其余值向最终 prompt 追加 "## Camera Motion Direction" 指令块。
    多选时 LLM 依据每个 [Shot N] 的镜头语义为该 Shot 挑选最契合的单一运镜并自然
    嵌入对应英文运镜短语（中文输出时运镜短语仍保留英文，属 LoRA 技术词），不同
    Shot 可轮换风格；速度词（slow/steady/quick 等）由模型依镜头节奏自然写出。
    """
    opts = {**_H3_DEFAULT_OPTIONS, **(options or {})}
    # 首帧图路径来自函数参数 image_path（server.py 传入），options 中不包含该键
    image = load_image_tensor(image_path) if image_path else None
    skills = _load_h3_skills_template(lang)
    full_prompt = _build_h3_prompt(skills, prompt, image is not None, duration_seconds, lang, camera_motion=camera_motion)
    if vlm_mode == "api":
        generate_text = generate_prompt_with_api(
            image=image, prompt=full_prompt, provider=opts.get("provider", "GLM"),
            api_key=opts.get("api_key", ""), seed=seed,
        )
        json_data = parse_generated_json(generate_text)
    elif vlm_mode == "llama-cpp":
        generate_text = generate_prompt_with_llama(
            image=image, prompt=full_prompt, gguf_path=opts["gguf_path"],
            mmproj_path=opts["mmproj_path"], seed=seed,
        )
        json_data = parse_generated_json(generate_text)
    elif vlm_mode == "ollama":
        generate_text = generate_prompt_with_ollama(
            image=image, prompt=full_prompt,
            model=opts.get("ollama_model", ""),
            base_url=opts.get("ollama_base_url", ""),
            api_key=opts.get("api_key", "ollama"),
            seed=seed,
        )
        json_data = parse_generated_json(generate_text)
    else:
        raise ValueError(f"Unsupported vlm_mode: {vlm_mode}")
    return json_data


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

def _extract_h3_dialogue_mentions(text_list: list[str]) -> dict:
    """Extract <#name:dialogue> mentions from all H3 prompt fields.

    Returns {name: {"<#name:dialogue>":dialogue, ...}}.
    """
    dialogues: dict[str, dict[str, str]] = {}
    for text in text_list:
        for m in _H3_DIALOGUE_RE.finditer(text):
            name = m.group(1).strip()
            if name:
                dialogue = m.group(2).strip()
                dialogues.setdefault(name, {})[m.group(0).strip()] = dialogue
    return dialogues

def _extract_h3_name_mentions(text_list: list[str]) -> dict:
    """Extract <@name> mentions from all H3 prompt fields.

    Returns {name: "<@name>"}
    """
    names: dict[str, str] = {}
    for text in text_list:
        for m in _H3_NAME_RE.finditer(text):
            name = m.group(1).strip()
            if name:
                names[name] = m.group(0).strip()
    return names

def _extract_shot_mentions(detailed_description: str) -> dict:
    """按 [Shot N] 分段，统计每个主体名（<@name> / <#name:...>）出现的镜头编号。

    Returns {name: [shot_nums]}，镜头编号去重保序；未出现在任何镜头中的名字不在结果里。
    """
    shots: dict[str, list[int]] = {}
    current: int | None = None
    token_re = re.compile(r"\[Shot (\d+)\]|<@([^>]+)>|<#([^>:]+):")
    for m in token_re.finditer(detailed_description or ""):
        if m.group(1) is not None:
            current = int(m.group(1))
            continue
        name = (m.group(2) or m.group(3) or "").strip()
        if not name or current is None:
            continue
        lst = shots.setdefault(name, [])
        if current not in lst:
            lst.append(current)
    return shots


def _assign_speaker_ids(detailed_description: str) -> dict:
    """按 <#name:dialogue> 首次出现位置顺序分配 S1、S2…，返回 {name: "Sx"}。"""
    ids: dict[str, str] = {}
    for m in _H3_DIALOGUE_RE.finditer(detailed_description or ""):
        name = m.group(1).strip()
        if name and name not in ids:
            ids[name] = f"S{len(ids) + 1}"
    return ids


def _fmt_appears_in(shots: list[int]) -> str:
    """(appears in [Shot 1], [Shot 3])；无镜头时 (appears in [])。"""
    if not shots:
        return "(appears in [])"
    return "(appears in " + ", ".join(f"[Shot {n}]" for n in shots) + ")"


def _retention_line(label: str, relationship: str, retention: str, shots: list[int]) -> str:
    """retention_analysis 主体行：<Subject 1> (appears in [Shot 1], [Shot 3]): marker - text。

    relationship 为空（引用/未使用）时 marker 用 reference；shots 为空时写 (appears in [])。
    """
    marker = (relationship or "").strip() or "reference"
    suffix = f" - {retention}" if (retention or "").strip() else ""
    return f"{label} {_fmt_appears_in(shots)}: {marker}{suffix}"


def _normalize_h3_prompt_json(v) -> dict:
    """将 H3 prompt JSON 统一规范化为 dict。

    h3PromptJson 统一为 JSON 对象（dict 或 JSON 字符串）；空串 /
    解析失败 / 非 dict 按空 dict 兜底。旧纯文本展示格式不再解析。
    """
    if isinstance(v, dict):
        return v
    if isinstance(v, str) and v.strip():
        try:
            parsed = json.loads(v)
            return parsed if isinstance(parsed, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def build_h3_subject_bindings(
    subject_data: dict,
    prompt_json: dict,
    timeline_segment: dict|None = None,
    seg_audio: list[dict] = [],
) -> dict:
    """Match <@name> / <#name:dialogue> placeholders against subject data and build H3 bindings.

    Args:
        subject_data: JSON string or dict with {"subjects": [{name, description,
            imageFile, audioRef?, audioFile?, videoFile?, type?, relationship?, retention?}]}.
            type: "Subject" (default) | "Picture" | "Video" | "Audio".
            relationship: visual marker, one of fully_preserved (default) /
                partially_preserved / attribute_transfer / weak_reference.
            retention: retention description.
        prompt_json: H3 output JSON (dict 或 JSON 字符串) with summary /
            detailed_description / overall_soundscape / non_diegetic_music.
        timeline_segment: current timeline segment dict; its "additionSubject"
            list (subject names added in the editor but not mentioned in the
            prompt) is bound in addition. Its "retention" mapping
            ({name: retention text}) takes precedence over the subject-defined
            retention in retention_analysis (segment-level override).

    Returns:
        {
            "subjects": [...],             # 绑定后的主体对象
            "subject_definitions": str,     # <Subject 1> 描述 / <Audio 1> is the voice-timbre reference... / <Picture N> is the last frame...
            "retention_analysis": str,     # <Subject 1>: fully_preserved / <Audio 1>: reference - ...
            "unmatched_mentions": [...],   # 被 @ 提及 / 添加但未在主体中定义的名字
            "images": [...],               # 图片文件路径列表（主体图片 + 尾帧）
            "audios": [...],               # 音频文件路径列表
            "videos": [...],               # 视频文件路径列表
        }
    """
    # 统一 h3PromptJson 为 dict：director.py 直接传 timeline 段的原始值
    # （工作流反序列化后为 dict，或 JSON 字符串），解析失败按空 dict 兜底。
    prompt_json = _normalize_h3_prompt_json(prompt_json)
    subjects_in = (subject_data or {}).get("subjects", []) or []
    # 段级 retention 覆盖映射：编辑器中针对该 segment 手动覆盖的 retention
    # （{name: 文本}）。绑定生成 retention_analysis 时优先取覆盖值，其次回落
    # 主体自身定义的 retention。非 dict / 空值按空映射兜底，兼容旧段数据。
    seg_retentions = (timeline_segment or {}).get("retention", {}) or {}
    if not isinstance(seg_retentions, dict):
        seg_retentions = {}

    def _retention_for(_name: str, _subj: dict) -> str:
        """返回该主体的生效 retention：段级覆盖值优先（strip 后非空才生效），
        否则回落主体自身定义的 retention。"""
        _override = seg_retentions.get(_name, "")
        if isinstance(_override, str) and _override.strip():
            return _override.strip()
        return (_subj.get("retention", "") or "").strip()
    # 用户提交了有效 audiosegment（type=Audio 且 audioFile 非空）时，音频素材仅作
    # 参考绑定（mapping）供前端使用：不写入 subject_definitions / retention_analysis，
    # 也不放入 audios 资源数组（音频由 Combine 节点 clip_audio 通道直接传递）。
    suppress_audio = len(seg_audio) > 0
    names = _extract_h3_name_mentions([
        prompt_json.get("summary", ""),
        prompt_json.get("detailed_description", ""),
        prompt_json.get("overall_soundscape", ""),
        prompt_json.get("non_diegetic_music", ""),
    ])
    dialogues = _extract_h3_dialogue_mentions([
        prompt_json.get("detailed_description", ""),
    ])
    detailed_desc = prompt_json.get("detailed_description", "")
    shot_mentions = _extract_shot_mentions(detailed_desc)
    speaker_ids = _assign_speaker_ids(detailed_desc)
    subject_definitions = []
    retention_analysis = []
    subject_definitions_text = []
    retention_analysis_text = []
    images: list[str] = []
    audios: list[str] = []
    videos: list[str] = []
    unmatched: dict[str, list[str]] = {}
    seen: set[str] = set()
    subjects_out: list[dict] = []
    mapping: dict[str, str] = {}
    s_index = 1   # Subject 抽象对象全局编号

    def _bind_media(subj: dict, d_type: str, name: str) -> str | None:
        """绑定媒体资源主体（Picture→images / Audio→audios / Video→videos）。

        缺失时记录 unmatched 并返回 None。Subject 为抽象对象，不持有媒体资源，返回空串。
        """
        f = ""
        if d_type == "Picture":
            f = subj.get("imageFile", "")
            if not f:
                unmatched.setdefault(name, []).append(f"{name} has no imageFile")
                return None
            images.append(f)
        elif d_type == "Audio":
            f = subj.get("audioFile", "")
            if not f:
                unmatched.setdefault(name, []).append(f"{name} has no audioFile")
                return None
            audios.append(f)
        elif d_type == "Video":
            f = subj.get("videoFile", "")
            if not f:
                unmatched.setdefault(name, []).append(f"{name} has no videoFile")
                return None
            videos.append(f)
        return f

    def _next_label(d_type: str) -> str:
        """按官方规则编号：Picture/Audio/Video 各自独立编号（= 对应资源列表位置）。

        调用前资源须已加入对应列表（len = 编号），Subject 抽象对象全局递增。
        """
        nonlocal s_index
        if d_type == "Picture":
            return f"<Picture {len(images)}>"
        if d_type == "Audio":
            return f"<Audio {len(audios)}>"
        if d_type == "Video":
            return f"<Video {len(videos)}>"
        label = f"<Subject {s_index}>"
        s_index += 1
        return label

    def _extract_h3_subject_mentions(_input: str):
        nonlocal s_index
        _names = _extract_h3_name_mentions([_input])
        for _name, _pattern in _names.items():
            if _name in seen or _name in unmatched:
                continue
            idx = find_index(subjects_in, func=lambda x, y=_name: x.get("name") == y)
            if idx == -1:
                unmatched.setdefault(_name, []).append(f"{_name} not found in subjects")
                mapping[_pattern] = _name
                continue
            _subj = subjects_in[idx]
            _dType = _subj.get("type", "") or "Subject"
            _description = _subj.get("description", "")
            _relationship = _subj.get("relationship", "")
            _retention = _retention_for(_name, _subj)
            if _bind_media(_subj, _dType, _name) is None:
                mapping[_pattern] = _name
                continue
            _label = _next_label(_dType)
            # 是否写入 definitions / retention 取决于被引用主体的 relationship 是否有值
            if _relationship:
                subject_definitions.append(f"{_label} {_description}")
                subject_definitions_text.append(f"{_pattern} {_description}")
                retention_analysis.append(
                    _retention_line(_label, _relationship, _retention, shot_mentions.get(_name, []))
                )
                retention_analysis_text.append(
                    _retention_line(_pattern, _relationship, _retention, shot_mentions.get(_name, []))
                )
            seen.add(_name)
            subjects_out.append(_subj)
            mapping[_pattern] = _label
            # 递归处理描述中的提及
            if _description:
                _extract_h3_subject_mentions(_description)

    for name, dat in dialogues.items():
        for k, v in dat.items():
            # 判断是否存在汉字
            language = "Chinese" if any('\u4e00' <= char <= '\u9fff' for char in v) else "English"
            mapping[k] = f"<d>[{language}]{v}</d>"
        if name in seen or name in unmatched.keys():
            continue
        idx = find_index(subjects_in, func=lambda x, y=name: x.get("name") == y)
        if idx == -1:
            unmatched.setdefault(name, []).append(f"{name} not found in subjects")
            mapping[f"<@{name}>"] = name
            continue
        subj = subjects_in[idx]
        description = subj.get("description", "")
        relationship = subj.get("relationship", "")
        retention = _retention_for(name, subj)
        audio_ref = (subj.get("audioRef", "") or "").strip()
        # 对话说话者一定是主体（Subject）：抽象对象，无媒体资源可绑定，直接编号
        label = _next_label("Subject")
        subject_definitions.append(f"{label} {description}")
        subject_definitions_text.append(f"<@{name}> {description}")
        retention_analysis.append(
            _retention_line(label, relationship, retention, shot_mentions.get(name, []))
        )
        retention_analysis_text.append(
            _retention_line(f"<@{name}>", relationship, retention, shot_mentions.get(name, []))
        )
        seen.add(name)
        subjects_out.append(subj)
        mapping[f"<@{name}>"] = label
        # 递归处理描述中的 <@提及>（在 seen 之后调用，防止 <@自身> 自引用无限递归）
        if description:
            _extract_h3_subject_mentions(description)

        # 音频关联（仅 Subject 支持）：引用 / 定义双模式。
        # 判断依据为 audioRef 指向的 Audio 主体 relationship：空 → 引用（voice-timbre 模板）；
        # 非空 → 定义（用 Audio 主体 description 独立定义）。
        if audio_ref and not suppress_audio:
            if audio_ref in seen or audio_ref in unmatched.keys():
                continue
            a_idx = find_index(subjects_in, func=lambda x, y=audio_ref: x.get("name") == y)
            if a_idx == -1:
                unmatched.setdefault(name, []).append(f"{name}'s audioRef '{audio_ref}' not found")
                mapping[f"<@{audio_ref}>"] = audio_label
                continue
            audio_subj = subjects_in[a_idx]
            audio_file = audio_subj.get("audioFile", "")
            if not audio_file:
                unmatched.setdefault(audio_ref, []).append(f"{audio_ref} has no audioFile")
                mapping[f"<@{audio_ref}>"] = audio_label
                continue
            audio_relationship = (audio_subj.get("relationship", "") or "").strip()
            audio_description = audio_subj.get("description", "")
            audios.append(audio_file)
            audio_label = _next_label("Audio")
            seen.add(audio_ref)
            mapping[f"<@{audio_ref}>"] = audio_label
            subjects_out.append(audio_subj)
            # 递归处理 Audio 描述中的 <@提及>（在 seen 之后调用，防止自引用无限递归）
            if audio_description:
                _extract_h3_subject_mentions(audio_description)
            # 引用模式：voice-timbre reference，绑定目标说话者 (Sx)
            speaker = speaker_ids.get(name, "")
            speaker_suffix = f" ({speaker})" if speaker else ""

            if not audio_relationship or not audio_description.strip():
                # 引用模式：voice-timbre reference，绑定目标说话者 (Sx)。
                # 定义模式缺少 description 时也回退到引用模式，避免输出只有标签的残缺行（如 "<Audio 1> "）。
                subject_definitions.append(
                    f"{audio_label} is the voice-timbre reference for {label}{speaker_suffix}."
                )
                subject_definitions_text.append(
                    f"<@{audio_ref}> is the voice-timbre reference for <@{name}>{speaker_suffix}."
                )
                text = _AUDIO_RELATION_TEXT["reference"]
                retention_analysis.append(f"{audio_label}: reference - {text.format(n=audio_label)}")
                retention_analysis_text.append(f"<@{audio_ref}>: reference - {text.format(n=f"<@{audio_ref}>")}")
            else:
                # 定义模式：用 Audio 主体 description 独立定义
                audio_description_text = audio_description.replace(f"<@{name}>", f"<@{name}>{speaker_suffix}")
                subject_definitions.append(f"{audio_label} {audio_description_text}")
                subject_definitions_text.append(f"<@{audio_ref}> {audio_description_text}")
                text = _AUDIO_RELATION_TEXT.get(audio_relationship, _AUDIO_RELATION_TEXT["reference"])
                retention_descritpion = _retention_for(audio_ref, audio_subj)
                retention_descritpion_text = f" - {retention_descritpion}" if retention_descritpion else f" - {text.format(n=audio_label)}"
                retention_analysis.append(f"{audio_label}: {audio_relationship}{retention_descritpion_text}")
                retention_analysis_text.append(f"<@{audio_ref}>: {audio_relationship}{retention_descritpion_text}")

    for name, pattern in names.items():
        if name in seen or name in unmatched:
            continue
        idx = find_index(subjects_in, func=lambda x, y=name: x.get("name") == y)
        if idx == -1:
            unmatched.setdefault(name, []).append(f"{name} not found in subjects")
            mapping[pattern] = name
            continue
        subj = subjects_in[idx]
        description = subj.get("description", "")
        relationship = subj.get("relationship", "")
        d_type = subj.get("type", "") or "Subject"
        if _bind_media(subj, d_type, name) is None:
            mapping[pattern] = name
            continue
        label = _next_label(d_type)
        if relationship:
            subject_definitions.append(f"{label} {description}")
            subject_definitions_text.append(f"<@{name}> {description}")
            retention = _retention_for(name, subj)
            retention_analysis.append(
                _retention_line(label, relationship, retention, shot_mentions.get(name, []))
            )
            retention_analysis_text.append(
                _retention_line(f"<@{name}>", relationship, retention, shot_mentions.get(name, []))
            )
        seen.add(name)
        subjects_out.append(subj)
        mapping[pattern] = label
        # 递归处理描述中的 <@提及>（在 seen 之后调用，防止自引用无限递归）
        if description:
            _extract_h3_subject_mentions(description)

    for name in (timeline_segment or {}).get("additionSubject", []) or []:
        if name in seen or name in unmatched:
            continue
        idx = find_index(subjects_in, func=lambda x, y=name: x.get("name") == y)
        if idx == -1:
            unmatched.setdefault(name, []).append(f"{name} not found in subjects")
            mapping[f"<@{name}>"] = name
            continue
        subj = subjects_in[idx]
        description = subj.get("description", "")
        relationship = subj.get("relationship", "")
        d_type = subj.get("type", "") or "Subject"
        if _bind_media(subj, d_type, name) is None:
            mapping[f"<@{name}>"] = name
            continue
        label = _next_label(d_type)
        if relationship:
            subject_definitions.append(f"{label} {description}")
            subject_definitions_text.append(f"<@{name}> {description}")
            # additionSubject 未在 prompt 中提及，shot_mentions 为空 → (appears in []): reference
            retention = _retention_for(name, subj)
            retention_analysis.append(
                _retention_line(label, relationship, retention, shot_mentions.get(name, []))
            )
            retention_analysis_text.append(
                _retention_line(f"<@{name}>", relationship, retention, shot_mentions.get(name, []))
            )
        seen.add(name)
        subjects_out.append(subj)
        # 递归处理描述中的 <@提及>（在 seen 之后调用，防止自引用无限递归）
        if description:
            _extract_h3_subject_mentions(description)

    data = {
        "subjects": subjects_out,
        "subject_definitions": "\n".join(subject_definitions_text),
        "subject_definitions_final": "\n".join(subject_definitions),
        "retention_analysis": "\n".join(retention_analysis_text),
        "retention_analysis_final": "\n".join(retention_analysis),
        "summary": prompt_json.get("summary", ""),
        "detailed_description": prompt_json.get("detailed_description", ""), 
        "overall_soundscape": prompt_json.get("overall_soundscape", ""),
        "non_diegetic_music": prompt_json.get("non_diegetic_music", ""),
        "unmatched_mentions": unmatched,
        "images": images,
        "audios": audios,
        "videos": videos,
        "mapping": mapping,
        "speaker_ids": speaker_ids,
    }

    return data


def build_h3_prompt(
    global_prompt: str,
    subject_data: dict,
    prompt_json: dict,
    previous_timeline_segment: dict|None = None,
    timeline_segment: dict = {},
    next_timeline_segment: dict|None = None,
    seg_audio: list[dict] = [],
    frame_rate: float = 24,
) -> dict:
    prompt_res = build_h3_subject_bindings(subject_data=subject_data, prompt_json=prompt_json, 
                                           timeline_segment=timeline_segment, seg_audio=seg_audio)

    summary = prompt_res.get("summary", "")
    subject_definitions = prompt_res.get("subject_definitions", "")
    retention_analysis = prompt_res.get("retention_analysis", "")
    detailed_description = prompt_res.get("detailed_description", "")
    images = prompt_res.get("images", [])
    speaker_ids = prompt_res.get("speaker_ids", {})
    # Picture 编号 = 图片在 images 列表中的位置（<Picture N> 对应 images[N-1]）
    index = len(images) + 1
    # 尾帧图片对应的 <Picture N> 标签（视频段尾帧 / autoEndFrame 段），追加到详细描述末尾作为结束锚点
    last_frame_pic = ""
    prev_image_file = ""
    prev_type = "image"

    if timeline_segment.get("type", "text") == "video":
        video_path = timeline_segment.get("imageFile", "")
        video_start = timeline_segment.get("trimStart", 1)
        video_duration = timeline_segment.get("length", 1)
        # 视频段：获取 mp4 的首帧和尾帧图片路径（首帧位置=video_start，尾帧位置=video_start+video_duration）
        video_first_frame_path, video_last_frame_path = _extract_video_frames(video_path, video_start, video_duration)
        if video_first_frame_path:
            prev_image_file = video_first_frame_path
        if video_last_frame_path:
            label = f"<Picture {index}>"
            last_frame_pic = label
            subject_definitions = subject_definitions + f"\n{label} is the last frame of the target video."
            retention_analysis = retention_analysis + f"\n{label}(last frame of the target video): fully_preserved."
            index += 1
            images.append(video_last_frame_path)
    else:
        if timeline_segment.get("type", "text") == "image":
            prev_image_file = timeline_segment.get("imageFile")
        elif int(timeline_segment.get("guideStrength", 22)) > 0 and previous_timeline_segment is not None:
            if previous_timeline_segment.get("type") == "video" and previous_timeline_segment.get("imageFile"):
                prev_image_file = previous_timeline_segment.get("imageFile", "")
                prev_type = "video"
                video_start = previous_timeline_segment.get("trimStart", 1)
                video_duration = previous_timeline_segment.get("length", 1)
                try:
                    from .video import cut_video_window_with_ffmpeg
                    prev_image_file = cut_video_window_with_ffmpeg(prev_image_file, video_start, video_duration)
                except Exception as exc:  # noqa: BLE001
                    log.warning(f"[MiniMaxRefDirector] cut prev video window error for {prev_image_file!r}: {exc}")
                log.warning(
                    "[MiniMaxRefDirector] prev video window cut unavailable for "
                    f"{prev_image_file!r} [{video_start}, {video_start}+{video_duration})."
                )
            elif previous_timeline_segment.get("type", "text") == "image" and previous_timeline_segment.get("imageFile", ""):
                prev_image_file = previous_timeline_segment.get("imageFile", "")

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
    subject_definitions = _replace_mapping(subject_definitions, mapping)
    summary = _replace_mapping(summary, mapping)
    retention_analysis = _replace_mapping(retention_analysis, mapping)
    detailed_description = _replace_mapping(detailed_description, mapping, speaker_ids=speaker_ids)

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
    if summary:
        prompt += "summary:\n" + summary + "\n"
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
        "prevType": prev_type
    }
def _replace_mapping(input: str, mapping: dict, speaker_ids: dict = None) -> str:
        for k, v in mapping.items():
            label = v
            if speaker_ids and k.startswith("<@") and k.endswith(">"):
                name = k[2:-1]
                speaker_id = speaker_ids.get(name, "")
                if speaker_id:
                    label = f"{v} ({speaker_id})"
            input = input.replace(k, label)
        return input
