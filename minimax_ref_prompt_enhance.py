import json
import logging
import re

import comfy.sd
import folder_paths
from comfy_api.latest import io

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """【任务】处理多段视频/故事任务。
【上一段提示词】{prev_prompt}
【用户新输入】{user_input}

请分析首帧图片，并综合以上信息，生成一段用于后续图像生成的提示词。
要求：
1. 提示词中所有角色名称必须用占位符表示（格式：{{ROLE_0}}, {{ROLE_1}}...）。
2. 所有对话内容用占位符表示（格式：{{ROLE_0_DIALOGUE_0}}, {{ROLE_0_DIALOGUE_1}},
{{ROLE_1_DIALOGUE_2}}...）。
3. 每个不同的角色分配一个独立的 ROLE 占位符，每个独立的对话片段分配一个 DIALOGUE 占位符。
4. 每个对话分配一个DIALOGUE 占位符，占位符前面的ROLE_说话的角色。
5. 最后输出一个 JSON，包含两个字段：
   - "template": 含占位符的完整提示词字符串。
   - "mapping": 一个字典，键为占位符名（如 "ROLE_0"），值为对应的实际文本。

输出示例：
{{
  "template": "场景：咖啡馆内，{{ROLE_0}}和{{ROLE_1}}相对而坐。{{ROLE_0}}说："{{ROLE_0_DIALOGUE_0}}"，{{ROLE_1}}也说："{{ROLE_1_DIALOGUE_1}}"。",
  "mapping": {{
    "ROLE_0": "张三",
    "ROLE_1": "李四",
    "ROLE_0_DIALOGUE_0": "你好",
    "ROLE_1_DIALOGUE_1": "你好"
  }}
}}
请严格按照上述 JSON 格式输出，不要添加额外文字。"""


class MinimaxRefPromptEnhance(io.ComfyNode):
    """使用 Qwen3VL CLIP 模型分析首帧图片并生成带占位符的提示词 JSON。"""

    @classmethod
    def define_schema(cls):
        # 获取所有可用的 text_encoder 模型文件名
        text_encoders = folder_paths.get_filename_list("text_encoders")
        clip_types = ["minimax", "qwen3vl", "gemma"]

        return io.Schema(
            node_id="MiniMaxRefPromptEnhance",
            display_name="MiniMax Ref Prompt Enhance",
            category="minimaxrefdirector/prompt",
            description="使用 Qwen3VL CLIP 模型分析首帧图片，综合上一段提示词和用户新输入，生成带角色/对话占位符的 JSON 提示词。",
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
                io.Image.Input("image", tooltip="首帧图片，用于分析场景和角色"),
                io.String.Input(
                    "last_prompt",
                    display_name="last_prompt",
                    multiline=True,
                    default="",
                    tooltip="上一段提示词",
                ),
                io.String.Input(
                    "prompt",
                    display_name="prompt",
                    multiline=True,
                    default="",
                    tooltip="用户新输入的提示词",
                ),
                io.Int.Input(
                    "max_length",
                    default=1024,
                    min=16,
                    max=32768,
                    tooltip="生成文本的最大长度",
                ),
                io.Boolean.Input(
                    "do_sample",
                    optional=True,
                    default=True,
                    tooltip="启用随机采样（关闭则使用贪心解码）",
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
                    max=0xffffffffffffffff,
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
                    tooltip="含 template 和 mapping 的 JSON 字符串",
                ),
                io.String.Output(
                    display_name="template",
                    tooltip="含占位符的完整提示词模板",
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
        if image is None or (hasattr(image, "numel") and image.numel() == 0):
            raise ValueError("[MiniMaxRefPromptEnhance] image 参数是必需的。")

        # 内部加载 CLIP 模型
        clip_type_enum = getattr(comfy.sd.CLIPType, clip_type.upper(), comfy.sd.CLIPType.MINIMAX)
        clip_path = folder_paths.get_full_path_or_raise("text_encoders", clip_name)
        clip = comfy.sd.load_clip(
            ckpt_paths=[clip_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=clip_type_enum,
        )
        log.info(f"[MiniMaxRefPromptEnhance] 已加载 CLIP 模型: {clip_name} (type={clip_type})")

        # 构建完整的 prompt 文本
        prompt_text = SYSTEM_PROMPT.format(
            prev_prompt=last_prompt or "(无)",
            user_input=prompt or "(无)",
        )

        # ComfyUI 的 image 格式为 [B, H, W, C]，值范围 [0, 1]
        # process_qwen2vl_images / Gemma4 preprocess_embed 均期望 [B, H, W, C]，无需 permute
        log.info(
            f"[MiniMaxRefPromptEnhance] 生成提示词... "
            f"(last_prompt: {len(last_prompt)} chars, prompt: {len(prompt)} chars, "
            f"image: {image.shape})"
        )

        # Tokenize: 将 prompt 和 image 一起编码
        tokens = clip.tokenize(
            prompt_text,
            image=image,
            skip_template=not use_default_template,
            min_length=1,
            thinking=thinking,
        )

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
        template_str = ""
        mapping_str = "{}"
        try:
            # 使用正则从文本中提取 JSON 对象，容忍模型输出额外文字
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

            result = json.loads(clean_text)
            template_str = result.get("template", "")
            mapping_str = json.dumps(result.get("mapping", {}), ensure_ascii=False)
            output_json = json.dumps(result, ensure_ascii=False)
        except (json.JSONDecodeError, TypeError) as e:
            log.error(f"[MiniMaxRefPromptEnhance] JSON 解析失败: {e}")
            log.error(f"[MiniMaxRefPromptEnhance] 原始输出: {generated_text}")
            output_json = json.dumps(
                {"template": generated_text.strip(), "mapping": {}},
                ensure_ascii=False,
            )
            template_str = generated_text.strip()
            mapping_str = "{}"

        return io.NodeOutput(output_json, template_str, mapping_str)


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefPromptEnhance": MinimaxRefPromptEnhance,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefPromptEnhance": "MiniMax Ref Prompt Enhance",
}
