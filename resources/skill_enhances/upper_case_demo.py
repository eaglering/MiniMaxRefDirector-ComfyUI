"""示例脚本技能：把上游文本整体转为大写。

提示词增强 script 技能协议（服务端在 LLM 生成后按选择顺序链式调用）：

    def run(text: str, ctx: dict) -> str

- text   : 上游文本（首个脚本技能时为 LLM 生成结果，之后为上一个脚本的输出）
- ctx    : {"description", "subject_type", "subject_name", "mode",
            "skill_id", "skill_name"}
- 返回   : 处理后的文本（str）

脚本每次请求重新加载（支持热改）；执行超时 30s；抛异常会把错误透传到前端。
仅允许 resources/skill_enhances/ 目录内的脚本被加载。
"""


def run(text: str, ctx: dict) -> str:
    return str(text or "").upper()
