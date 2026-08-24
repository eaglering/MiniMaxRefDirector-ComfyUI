
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
_H3_SKILLS_TEMPLATE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "prompt", "minimaxh3_custom_ref2v_prompt_writing.txt",
)
# 音频关系 -> retention_analysis 文案模板（{n} 为 Audio 编号）
_AUDIO_RELATION_TEXT = {
    "fully_copy": "{n} is reused 1:1 as the target video's complete final audio track.",
    "partially_copy": "Only part of the timeline or selected audio layers of {n} are copied.",
    "reference": "the target speaker follows {n}'s voice timbre and measured delivery without copying the original signal.",
    "weak_reference": "Only broad similarity in category or atmosphere from {n} is retained.",
}

def _load_h3_skills_template() -> str:
    """Load the custom H3 skills template (four-field output)."""
    with open(_H3_SKILLS_TEMPLATE_PATH, "r", encoding="utf-8") as f:
        return f.read()


def _build_h3_prompt(skills: str, prompt: str, has_image: bool, duration_seconds: float = 0) -> str:
    """Build the full prompt sent to the local GGUF VLM.

    Includes the custom skills guide, the required JSON output format
    (summary / detailed_description / overall_soundscape / non_diegetic_music)
    and the <@角色名称> / <#角色名称:对话内容> placeholder rules. When a reference
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

    duration_note = ""
    if duration_seconds and duration_seconds > 0:
        duration_note = (
            "The target video's total duration is %.2f seconds. "
        ) % (float(duration_seconds))

    return f"""You are an expert video prompt writer. Follow the skills guide below.

## Skills Guide
{skills}

## Task
Rewrite the user's input prompt into a full-reference video prompt.

## Output Language
Write every field in the same language as the user's input (Chinese input -> Chinese output, English input -> English output; follow any other input language accordingly). Keep only fixed structural markers ("[Shot N]", "At MM:SS.mmm", "<@...>", "<#...>") and field names unchanged. Character names, dialogue, and text visible in the scene always stay in their original language.

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
{image_note}## User Input Prompt
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


def generate_h3_prompt(prompt: str="", image_path: str="", seed: int=42, vlm_mode: str="llama-cpp", options: dict | None = None, duration_seconds: float = 0) -> dict:
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

    The output JSON includes summary / detailed_description /
    overall_soundscape / non_diegetic_music (a provided reference image is
    merged into detailed_description, not treated as a first frame). Character
    names are wrapped as <@名字> and dialogue as <#名字:[Language]对话> directly
    by the model, with a language tag such as [Chinese] or [English] before the
    dialogue text. No mapping is returned.
    """
    opts = {**_H3_DEFAULT_OPTIONS, **(options or {})}
    # 首帧图路径来自函数参数 image_path（server.py 传入），options 中不包含该键
    image = load_image_tensor(image_path) if image_path else None
    skills = _load_h3_skills_template()
    full_prompt = _build_h3_prompt(skills, prompt, image is not None, duration_seconds)
    if vlm_mode == "api":
        generate_text = generate_prompt_with_api(
            image=image, prompt=full_prompt, provider=opts.get("provider", "GLM"),
            api_key=opts.get("api_key", ""), seed=seed,
        )
        return parse_generated_json(generate_text)
    if vlm_mode == "llama-cpp":
        generate_text = generate_prompt_with_llama(
            image=image, prompt=full_prompt, gguf_path=opts["gguf_path"],
            mmproj_path=opts["mmproj_path"], seed=seed,
        )
        return parse_generated_json(generate_text)
    if vlm_mode == "ollama":
        generate_text = generate_prompt_with_ollama(
            image=image, prompt=full_prompt,
            model=opts.get("ollama_model", ""),
            base_url=opts.get("ollama_base_url", ""),
            api_key=opts.get("api_key", "ollama"),
            seed=seed,
        )
        return parse_generated_json(generate_text)
    raise ValueError(f"Unsupported vlm_mode: {vlm_mode}")


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
            prompt) is bound in addition.

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
    # 用户提交了有效 audiosegment（type=Audio 且 audioFile 非空）时，音频素材仅作
    # 参考绑定（mapping）供前端使用：不写入 subject_definitions / retention_analysis，
    # 也不放入 audios 资源数组（音频由 Combine 节点 clip_audio 通道直接传递）。
    suppress_audio = True if len(seg_audio) > 0 else False
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
            if suppress_audio:
                return None
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
            if _name in seen or _name in unmatched.keys():
                continue
            idx = find_index(subjects_in, func=lambda x, y=_name: x.get("name") == y)
            if idx == -1:
                unmatched.setdefault(_name, []).append(f"{_name} not found in subjects")
                continue
            _subj = subjects_in[idx]
            _dType = _subj.get("type", "") or "Subject"
            _description = _subj.get("description", "")
            _relationship = _subj.get("relationship", "")
            _retention = (_subj.get("retention", "") or "").strip()
            if _bind_media(_subj, _dType, _name) is None:
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
            if _dType != "Subject":
                subjects_out.append(_subj)
            mapping[_pattern] = _label
            # 递归处理描述中的提及
            if _description:
                _extract_h3_subject_mentions(_description)

    for name, dat in dialogues.items():
        if name in seen or name in unmatched.keys():
            continue
        idx = find_index(subjects_in, func=lambda x, y=name: x.get("name") == y)
        if idx == -1:
            unmatched.setdefault(name, []).append(f"{name} not found in subjects")
            continue
        subj = subjects_in[idx]
        description = subj.get("description", "")
        relationship = subj.get("relationship", "")
        retention = (subj.get("retention", "") or "").strip()
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
        mapping[f"<@{name}>"] = label
        # 递归处理描述中的 <@提及>（在 seen 之后调用，防止 <@自身> 自引用无限递归）
        if description:
            _extract_h3_subject_mentions(description)
        for k, v in dat.items():
            # 判断是否存在汉字
            language = "Chinese" if any('\u4e00' <= char <= '\u9fff' for char in v) else "English"
            mapping[k] = f"<d>[{language}]{v}</d>"

        # 音频关联（仅 Subject 支持）：引用 / 定义双模式。
        # 判断依据为 audioRef 指向的 Audio 主体 relationship：空 → 引用（voice-timbre 模板）；
        # 非空 → 定义（用 Audio 主体 description 独立定义）。
        if audio_ref and not suppress_audio:
            if audio_ref in seen or audio_ref in unmatched.keys():
                continue
            a_idx = find_index(subjects_in, func=lambda x, y=audio_ref: x.get("name") == y)
            if a_idx == -1:
                unmatched.setdefault(name, []).append(f"{name}'s audioRef '{audio_ref}' not found")
                continue
            audio_subj = subjects_in[a_idx]
            audio_file = audio_subj.get("audioFile", "")
            if not audio_file:
                unmatched.setdefault(audio_ref, []).append(f"{audio_ref} has no audioFile")
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
                retention_descritpion = audio_subj.get("retention", "").strip()
                retention_descritpion_text = f" - {retention_descritpion}" if retention_descritpion else f" - {text.format(n=audio_label)}"
                retention_analysis.append(f"{audio_label}: {audio_relationship}{retention_descritpion_text}")
                retention_analysis_text.append(f"<@{audio_ref}>: {audio_relationship}{retention_descritpion_text}")

    for name, pattern in names.items():
        if name in seen or name in unmatched:
            continue
        idx = find_index(subjects_in, func=lambda x, y=name: x.get("name") == y)
        if idx == -1:
            unmatched.setdefault(name, []).append(f"{name} not found in subjects")
            continue
        subj = subjects_in[idx]
        description = subj.get("description", "")
        relationship = subj.get("relationship", "")
        d_type = subj.get("type", "") or "Subject"
        if _bind_media(subj, d_type, name) is None:
            continue
        label = _next_label(d_type)
        if relationship:
            subject_definitions.append(f"{label} {description}")
            subject_definitions_text.append(f"<@{name}> {description}")
            retention = (subj.get("retention", "") or "").strip()
            retention_analysis.append(
                _retention_line(label, relationship, retention, shot_mentions.get(name, []))
            )
            retention_analysis_text.append(
                _retention_line(f"<@{name}>", relationship, retention, shot_mentions.get(name, []))
            )
        seen.add(name)
        if d_type != "Subject":
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
            continue
        subj = subjects_in[idx]
        description = subj.get("description", "")
        relationship = subj.get("relationship", "")
        d_type = subj.get("type", "") or "Subject"
        if _bind_media(subj, d_type, name) is None:
            continue
        label = _next_label(d_type)
        if relationship:
            subject_definitions.append(f"{label} {description}")
            subject_definitions_text.append(f"<@{name}> {description}")
            # additionSubject 未在 prompt 中提及，shot_mentions 为空 → (appears in []): reference
            retention = (subj.get("retention", "") or "").strip()
            retention_analysis.append(
                _retention_line(label, relationship, retention, shot_mentions.get(name, []))
            )
            retention_analysis_text.append(
                _retention_line(f"<@{name}>", relationship, retention, shot_mentions.get(name, []))
            )
        seen.add(name)
        if d_type != "Subject":
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
    # 首帧图片对应的 <Picture N> 标签（视频段首帧 / 图片段图），供 detailed_description reference 分镜使用
    first_frame_pic = ""
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
            label = f"<Picture {index}>"
            first_frame_pic = label
            prev_image_file = video_first_frame_path
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
            prev_image_file = timeline_segment.get("imageFile")
            subject_definitions = subject_definitions + f"\n{label} is the first frame of [Shot 1]."
            retention_analysis = retention_analysis + f"\n{label} ([Shot 1] first frame): fully_preserved."
            index += 1
            images.append(prev_image_file)
        elif int(timeline_segment.get("guideStrength", 16)) > 0 and previous_timeline_segment is not None:
            if previous_timeline_segment.get("type") == "video" and previous_timeline_segment.get("imageFile"):
                prev_image_file = previous_timeline_segment.get("imageFile", "")
                prev_type = "video"
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
    subject_definitions = _replace_mapping(subject_definitions, mapping)
    summary = _replace_mapping(summary, mapping)
    retention_analysis = _replace_mapping(retention_analysis, mapping)
    detailed_description = _replace_mapping(detailed_description, mapping, speaker_ids=speaker_ids)

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
