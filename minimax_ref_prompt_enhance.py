import json
import logging
import math
import re

import comfy.sd
import folder_paths
from comfy_api.latest import io

log = logging.getLogger(__name__)

# ── 基础 Prompt（无增强） ──────────────────────────────────────────

PROMPT_BASE_HEADER = """【任务】处理多段视频/故事任务。"""

PROMPT_IMAGE_SECTION = """
【首帧图片】请根据首帧图片内容，分析场景、角色、氛围，作为视频的起始状态。"""
PROMPT_LAST_SECTION = """
【上一段提示词】{prev_prompt}"""

PROMPT_USER_SECTION = """
【用户新输入】{user_input}
【视频总时长】{duration} 秒"""

PROMPT_SHOT1_SECTION = """
首帧镜头说明：请在 detailed_description 最前面增加 [Shot 1] 0:00-{shot1_dur}，根据首帧图片描述初始画面状态和角色初始姿态。此镜头不计入用户输入的总时长。"""

PROMPT_SHOT1_DIALOGUE_SECTION = """
首帧镜头说明：请在 detailed_description 最前面增加 [Shot 1] 0:00-{shot1_dur}，结合首帧图片和上一段提示词，描述上一段结束时的画面状态、角色姿态和位置关系（作为本段起点）。此镜头不计入用户输入的总时长。"""

PROMPT_NO_IMAGE_INSTRUCTION = """
请直接根据文本信息生成提示词，无需分析图片。"""

PROMPT_REQUIREMENTS = """
要求：
1. 提示词中所有角色名称必须用占位符表示（格式：{{ROLE_0}}, {{ROLE_1}}...）。
2. 所有对话内容用占位符表示（格式：{{ROLE_0_DIALOGUE_0}}, {{ROLE_0_DIALOGUE_1}}, {{ROLE_1_DIALOGUE_2}}...）。
3. 每个不同的角色分配一个独立的 ROLE 占位符。
4. 每个对话分配一个DIALOGUE 占位符，占位符前面的ROLE_说话的角色。
5. mapping 中的对话值必须带语言标签前缀：[Chinese]表示中文，[English]表示英文，需自动检测对话内容的语言。

输出格式要求：
将视频按镜头切分（如 [Shot 1]），使用明确的时间戳（如 0:00-2.5）。
镜头间需有状态继承，确保人物姿态、道具位置等硬约束严格连续。

请输出一个 JSON，包含以下字段：
  - "detailed_description": 包含带时间戳的镜头描述（含角色占位符、对话占位符）
  - "overall_soundscape": 用户输入的环境音、动作音效等画面内的声音元素。如果没有则输出 null。
  - "non_diegetic_music": 用户输入的画外配乐、旁白等非画面内声音。如果没有则输出 null。
  - "mapping": 一个字典，键为占位符名（如 "ROLE_0"），值为对应的实际文本。

输出示例：
{{
  "detailed_description": "[Shot 1] 0:00-2.5 场景：咖啡馆内，{{ROLE_0}}和{{ROLE_1}}相对而坐。\\n[Shot 2] 2.5-5.0 近景，{{ROLE_0}}说：\\"{{ROLE_0_DIALOGUE_0}}\\"，{{ROLE_1}}也说：\\"{{ROLE_1_DIALOGUE_1}}\\"。\\n",
  "overall_soundscape": "咖啡机蒸汽声、杯盘碰撞声、轻柔背景交谈声",
  "non_diegetic_music": null,
  "mapping": {{
    "ROLE_0": "张三",
    "ROLE_1": "李四",
    "ROLE_0_DIALOGUE_0": "[Chinese]你好!",
    "ROLE_1_DIALOGUE_1": "[English]Hello!"
  }}
}}
请严格按照上述 JSON 格式输出，不要添加额外文字。"""

# ── 增强 Prompt ────────────────────────────────────────────────────

PROMPT_ENHANCE_HEADER = """【任务】处理多段视频/故事任务。你需要对用户输入进行优化润色，使其更适合视频生成。"""

PROMPT_ENHANCE_IMAGE_SECTION = """
【首帧图片】请根据首帧图片内容，分析场景、角色、氛围，作为视频的起始状态。"""

PROMPT_ENHANCE_LAST_SECTION = """
【上一段提示词】{prev_prompt}"""

PROMPT_ENHANCE_USER_SECTION = """
【用户新输入】{user_input}
【视频总时长】{duration} 秒"""

PROMPT_ENHANCE_SHOT1_SECTION = """
首帧镜头说明：请在 detailed_description 最前面增加 [Shot 1] 0:00-{shot1_dur}，根据首帧图片描述初始画面状态和角色初始姿态。此镜头不计入用户输入的总时长。"""

PROMPT_ENHANCE_SHOT1_DIALOGUE_SECTION = """
首帧镜头说明：请在 detailed_description 最前面增加 [Shot 1] 0:00-{shot1_dur}，结合首帧图片和上一段提示词，描述上一段结束时的画面状态、角色姿态和位置关系（作为本段起点）。此镜头不计入用户输入的总时长。"""

PROMPT_ENHANCE_NO_IMAGE = """
请直接根据文本信息生成提示词。"""

PROMPT_ENHANCE_REQUIREMENTS = """
## 优化要求：
1. 对场景描述进行润色和细化，增加画面细节、光影、色彩、氛围描写。
2. 如果用户输入中没有提及环境音和动作音效（画面内的声音），请根据场景合理补充。
3. 如果用户输入中没有提及运镜方式，请为每个镜头合理补充运镜描述（如：缓慢推镜、侧拍、环绕、固定镜头等）。
4. 确保镜头之间的连贯性，人物姿态、道具位置等硬约束严格连续。

## 占位符要求：
1. 提示词中所有角色名称必须用占位符表示（格式：{{ROLE_0}}, {{ROLE_1}}...）。
2. 所有对话内容用占位符表示（格式：{{ROLE_0_DIALOGUE_0}}, {{ROLE_0_DIALOGUE_1}}, {{ROLE_1_DIALOGUE_2}}...）。
3. 每个不同的角色分配一个独立的 ROLE 占位符。
4. 每个对话分配一个DIALOGUE 占位符，占位符前面的ROLE_说话的角色，不使用冒号引号包裹对话。
5. mapping 中的对话值必须带语言标签前缀：[Chinese]表示中文，[English]表示英文，需自动检测对话内容的语言。

## 输出格式要求：
将视频按镜头切分（如 [Shot 1]），使用明确的时间戳（如 0:00-2.5）。
每个镜头描述中需包含：画面描述、运镜方式、对话（如有）。

请输出一个 JSON，包含以下字段：
  - "detailed_description": 包含带时间戳的镜头描述（含角色占位符、对话占位符、运镜方式）
  - "overall_soundscape": 画面内的环境音、动作音效等。如果没有则输出 null。
  - "non_diegetic_music": 画外配乐、旁白等非画面内声音。如果没有则输出 null。
  - "mapping": 一个字典，键为占位符名（如 "ROLE_0"），值为对应的实际文本。

输出示例：
{{
  "detailed_description": "[Shot 1] 0:00-2.5 场景：昏暗的咖啡馆内，暖黄色灯光洒在橡木桌面上，{{ROLE_0}}和{{ROLE_1}}相对而坐。运镜：缓慢推镜，从全景推向中近景。\\n[Shot 2] 2.5-5.0 近景特写{{ROLE_0}}的面部，他神色凝重，缓缓开口。运镜：固定镜头，浅景深。{{ROLE_0}}说：\\"{{ROLE_0_DIALOGUE_0}}\\"\\n[Shot 3] 5.0-8.0 反打镜头切至{{ROLE_1}}，她也回应道。运镜：过肩侧拍。{{ROLE_1}}说：\\"{{ROLE_1_DIALOGUE_1}}\\"\\n",
  "overall_soundscape": "咖啡机蒸汽声、杯盘轻微碰撞声、远处低沉交谈声、窗外雨滴敲打玻璃声",
  "non_diegetic_music": null,
  "mapping": {{
    "ROLE_0": "张三",
    "ROLE_1": "李四",
    "ROLE_0_DIALOGUE_0": "[Chinese]好久不见。",
    "ROLE_1_DIALOGUE_1": "[Chinese]是啊，三年了。"
  }}
}}
请严格按照上述 JSON 格式输出，不要添加额外文字。"""


def _has_image(image) -> bool:
    """检查 image 是否有效（不为 None 且不为空张量）。"""
    if image is None:
        return False
    if hasattr(image, "numel") and image.numel() == 0:
        return False
    return True


def _calc_shot1_duration(fps: float) -> float:
    """计算首帧镜头的时长（秒）：ceil(8*100/fps)/100，保留2位小数。"""
    return round(math.ceil(8 * 100 / fps) / 100, 2)


def build_prompt_text(
    last_prompt: str,
    prompt: str,
    duration: float,
    enhance: bool,
    has_image: bool,
    shot1_dur: float = 0.0,
) -> str:
    """根据参数动态构建发送给 CLIP 模型的 prompt 文本。

    Args:
        last_prompt: 上一段提示词（可为空）
        prompt: 用户新输入
        duration: 视频总时长（秒）
        enhance: 是否启用提示词增强
        has_image: 是否有首帧图片
        shot1_dur: 首帧镜头时长（仅 has_image=True 时使用）
    """
    has_last = bool(last_prompt.strip())

    if enhance:
        parts = [PROMPT_ENHANCE_HEADER]
        if has_image:
            parts.append(PROMPT_ENHANCE_IMAGE_SECTION)
        if has_last:
            parts.append(PROMPT_ENHANCE_LAST_SECTION.format(prev_prompt=last_prompt))
        if not has_image:
            parts.append(PROMPT_ENHANCE_NO_IMAGE)
        parts.append(PROMPT_ENHANCE_USER_SECTION.format(
            user_input=prompt or "(无)",
            duration=f"{duration:.1f}",
        ))
        if has_image:
            if has_last:
                parts.append(PROMPT_ENHANCE_SHOT1_DIALOGUE_SECTION.format(shot1_dur=shot1_dur))
            else:
                parts.append(PROMPT_ENHANCE_SHOT1_SECTION.format(shot1_dur=shot1_dur))
        parts.append(PROMPT_ENHANCE_REQUIREMENTS)
    else:
        parts = [PROMPT_BASE_HEADER]
        if has_image:
            parts.append(PROMPT_IMAGE_SECTION)
        if has_last:
            parts.append(PROMPT_LAST_SECTION.format(prev_prompt=last_prompt))
        if not has_image:
            parts.append(PROMPT_NO_IMAGE_INSTRUCTION)
        parts.append(PROMPT_USER_SECTION.format(
            user_input=prompt or "(无)",
            duration=f"{duration:.1f}",
        ))
        if has_image:
            if has_last:
                parts.append(PROMPT_SHOT1_DIALOGUE_SECTION.format(shot1_dur=shot1_dur))
            else:
                parts.append(PROMPT_SHOT1_SECTION.format(shot1_dur=shot1_dur))
        parts.append(PROMPT_REQUIREMENTS)

    return "\n".join(parts)

def _normalize_description(text: str) -> str:
    """规范化 detailed_description 文本：
    - 全角冒号（：）和半角冒号（:）统一转为半角逗号（,）
    - 移除所有半角双引号（"）和全角双引号（""）
    """
    text = text.replace("：", "，")  # 全角冒号 → 全角逗号
    text = text.replace(":", ",")       # 半角冒号 → 半角逗号
    text = text.replace('"', "")
    text = text.replace("“", "")
    text = text.replace("”", "")
    return text


def parse_generated_json(generated_text: str) -> dict:
    """从模型输出中解析 JSON，返回包含各字段的字典。"""
    # 优先匹配被 ```json ... ``` 包裹的 JSON 块
    json_match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", generated_text)
    if json_match:
        clean_text = json_match.group(1)
    else:
        # 回退：尝试匹配文本中第一个纯 JSON 对象
        json_match = re.search(r"\{[\s\S]*\}", generated_text)
        if json_match:
            clean_text = json_match.group(0)
        else:
            clean_text = generated_text.strip()

    return json.loads(clean_text)


def generate_prompt_with_clip(
    clip_name: str,
    clip_type: str,
    image,
    last_prompt: str = "",
    prompt: str = "",
    duration: float = 5.0,
    fps: float = 24.0,
    enhance: bool = False,
    max_length: int = 1024,
    do_sample: bool = True,
    temperature: float = 0.1,
    top_k: int = 32,
    top_p: float = 0.9,
    min_p: float = 0.0,
    repetition_penalty: float = 1.0,
    seed: int = 42,
    presence_penalty: float = 0.0,
    thinking: bool = False,
    use_default_template: bool = True,
) -> dict:
    """使用 CLIP 模型分析首帧图片并生成带占位符的提示词 JSON。

    Args:
        clip_name: text_encoders 目录下的模型文件名
        clip_type: CLIP 模型类型 ("minimax", "qwen3vl", "gemma")
        image: ComfyUI 图像张量 [B, H, W, C], 可选（None 表示纯文本模式）
        last_prompt: 上一段提示词（可为空）
        prompt: 用户新输入的提示词
        duration: 视频总时长（秒）
        fps: 帧率
        enhance: 是否启用提示词增强（润色、补充环境音、补充运镜）
        max_length: 生成文本最大长度
        do_sample: 是否随机采样
        temperature: 采样温度
        top_k: Top-K 采样
        top_p: Top-P 采样
        min_p: Min-P 采样
        repetition_penalty: 重复惩罚
        seed: 随机种子
        presence_penalty: 存在惩罚
        thinking: 思考模式
        use_default_template: 是否使用模型内置模板

    Returns:
        dict: {
            "output_json": str,
            "detailed_description": str,
            "overall_soundscape": str,
            "non_diegetic_music": str,
            "mapping_str": str,
        }
    """
    has_image = _has_image(image)
    shot1_dur = _calc_shot1_duration(fps) if has_image else 0.0

    # 加载 CLIP 模型
    clip_type_enum = getattr(comfy.sd.CLIPType, clip_type.upper(), comfy.sd.CLIPType.MINIMAX)
    clip_path = folder_paths.get_full_path_or_raise("text_encoders", clip_name)
    clip = comfy.sd.load_clip(
        ckpt_paths=[clip_path],
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
        clip_type=clip_type_enum,
    )
    log.info(f"[MiniMaxRefPromptEnhance] 已加载 CLIP 模型: {clip_name} (type={clip_type})")

    # 构建 prompt 文本
    prompt_text = build_prompt_text(
        last_prompt=last_prompt,
        prompt=prompt,
        duration=duration,
        enhance=enhance,
        has_image=has_image,
        shot1_dur=shot1_dur,
    )

    log.info(
        f"[MiniMaxRefPromptEnhance] 生成提示词... "
        f"(last_prompt: {len(last_prompt)} chars, prompt: {len(prompt)} chars, "
        f"duration: {duration:.1f}s, fps: {fps}, enhance: {enhance}, "
        f"has_image: {has_image}, shot1_dur: {shot1_dur})"
    )

    # Tokenize: 将 prompt 和 image（如有）一起编码
    tokenize_kwargs = {
        "skip_template": not use_default_template,
        "min_length": 1,
        "thinking": thinking,
    }
    if has_image:
        tokenize_kwargs["image"] = image

    tokens = clip.tokenize(prompt_text, **tokenize_kwargs)

    # 生成文本
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
    log.info(f"[MiniMaxRefPromptEnhance] 生成结果（前200字符）: {generated_text[:200]}")

    # 解析 JSON
    try:
        result = parse_generated_json(generated_text)
        detailed_description = result.get("detailed_description", "") or ""
        detailed_description = _normalize_description(detailed_description)
        result["detailed_description"] = detailed_description
    except (json.JSONDecodeError, TypeError) as e:
        log.error(f"[MiniMaxRefPromptEnhance] JSON 解析失败: {e}")
        log.error(f"[MiniMaxRefPromptEnhance] 原始输出: {generated_text}")
        # 回退：用原始文本作为 detailed_description
        result = {
            "detailed_description": generated_text.strip(),
            "overall_soundscape": None,
            "non_diegetic_music": None,
            "mapping": {},
        }

    return result


class MinimaxRefPromptEnhance(io.ComfyNode):
    """使用 CLIP 模型分析首帧图片并生成带占位符的格式化提示词 JSON。"""

    @classmethod
    def define_schema(cls):
        text_encoders = folder_paths.get_filename_list("text_encoders")
        clip_types = ["minimax", "qwen3vl", "gemma"]

        return io.Schema(
            node_id="MiniMaxRefPromptEnhance",
            display_name="MiniMax Ref Prompt Enhance",
            category="minimaxrefdirector/prompt",
            description="使用 CLIP 模型分析首帧图片（可选），综合上一段提示词（可选）和用户新输入，生成带角色/对话占位符的格式化提示词。",
            inputs=[
                io.Combo.Input(
                    "clip_name",
                    options=text_encoders,
                    default=text_encoders[0] if text_encoders else "",
                    tooltip="选择一个 text encoder（CLIP/VL）模型",
                ),
                io.Combo.Input(
                    "clip_type",
                    options=clip_types,
                    default="qwen3vl",
                    tooltip="CLIP 模型类型",
                ),
                io.Image.Input(
                    "image",
                    optional=True,
                    tooltip="首帧图片（可选），用于分析场景和角色；不连接则纯文本模式",
                ),
                io.String.Input(
                    "last_prompt",
                    display_name="last_prompt",
                    multiline=True,
                    default="",
                    tooltip="上一段提示词（可选，有首帧图片时提供上下文）",
                ),
                io.String.Input(
                    "prompt",
                    display_name="prompt",
                    multiline=True,
                    default="",
                    tooltip="用户新输入的提示词",
                ),
                io.Float.Input(
                    "duration",
                    display_name="duration",
                    default=5.0,
                    min=0.5,
                    max=3600.0,
                    step=0.5,
                    tooltip="视频总时长（秒）",
                ),
                io.Float.Input(
                    "fps",
                    display_name="fps",
                    default=24.0,
                    min=1.0,
                    max=120.0,
                    step=0.01,
                    tooltip="帧率（每秒帧数），用于计算首帧镜头时长",
                ),
                io.Boolean.Input(
                    "enhance",
                    default=False,
                    tooltip="开启后会对提示词进行优化润色，自动补充环境音和运镜描述",
                ),
                io.Int.Input(
                    "max_length",
                    default=1024,
                    min=16,
                    max=32768,
                    tooltip="生成文本的最大长度",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "do_sample",
                    optional=True,
                    default=True,
                    tooltip="启用随机采样（关闭则使用贪心解码）",
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
                    tooltip="采样温度",
                    advanced=True,
                ),
                io.Int.Input(
                    "top_k",
                    optional=True,
                    display_name="top_k",
                    default=32,
                    min=0,
                    max=1000,
                    tooltip="Top-K 采样",
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
                    tooltip="Top-P (nucleus) 采样",
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
                    tooltip="Min-P 采样",
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
                    tooltip="重复惩罚",
                    advanced=True,
                ),
                io.Int.Input(
                    "seed",
                    optional=True,
                    display_name="seed",
                    default=42,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    tooltip="随机种子",
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
                    tooltip="存在惩罚",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "thinking",
                    optional=True,
                    default=False,
                    tooltip="启用思考模式（如果模型支持）",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "use_default_template",
                    optional=True,
                    default=True,
                    tooltip="使用模型内置的 system prompt/template",
                    advanced=True,
                ),
            ],
            outputs=[
                io.String.Output(
                    display_name="JSON",
                    tooltip="含 detailed_description、overall_soundscape、non_diegetic_music 和 mapping 的 JSON 字符串",
                ),
                io.String.Output(
                    display_name="detailed_description",
                    tooltip="格式化后的镜头描述（含时间戳和占位符）",
                ),
                io.String.Output(
                    display_name="mapping",
                    tooltip="占位符到实际文本的映射（JSON 字符串）",
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
        enhance=False,
        max_length=1024,
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

        output_json = json.dumps(result['output_json'], ensure_ascii=False)
        mapping_str = json.dumps(result['mapping_data'], ensure_ascii=False)

        return io.NodeOutput(
            output_json,
            result["detailed_description"],
            mapping_str,
        )


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefPromptEnhance": MinimaxRefPromptEnhance,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefPromptEnhance": "MiniMax Ref Prompt Enhance",
}
