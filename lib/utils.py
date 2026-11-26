import gc
import json
import re
from comfy_api.latest import io, UI
import torch
import comfy.model_management

from .llm import unload_llama_models

def find_index(list: list, func: callable):
    for i, v in enumerate(list):
        if func(v):
            return i
    return -1

def _extract_balanced_json(text: str) -> str | None:
    """从文本中提取首个括号配平的 JSON 对象（跳过字符串字面量与转义）。

    与前端 parseJsonBlock 的平衡扫描同构：正则非贪婪匹配在 JSON 值内含
    ``}`` + 围栏样文本时会截断，平衡扫描则始终返回完整对象。
    """
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def parse_generated_json(generated_text: str) -> dict:
    """Parse JSON from model output, return a dict with all fields.

    解析顺序：```json 围栏 → 平衡括号扫描（容忍模型输出的前后缀文字/追问尾巴）
    → 裸 JSON.parse 兜底；全部失败抛带原文摘录的 RuntimeError（HTTP 层转 400）。
    """
    raw = str(generated_text or "")
    # 1) 围栏内容优先（其中若被截断再回落平衡扫描）
    fence = re.search(r"```(?:json)?\s*(\{[\s\S]*?\}?)\s*```", raw)
    candidates = []
    if fence:
        candidates.append(fence.group(1))
    balanced = _extract_balanced_json(raw)
    if balanced:
        candidates.append(balanced)
    # 2) 兜底：首 { 到尾 }（旧行为）
    lazy = re.search(r"\{[\s\S]*\}", raw)
    if lazy:
        candidates.append(lazy.group(0))
    candidates.append(raw.strip())

    last_err: Exception | None = None
    for cand in candidates:
        if not cand.strip():
            continue
        try:
            obj = json.loads(cand, strict=False)
        except Exception as e:
            last_err = e
            continue
        if isinstance(obj, dict):
            return obj
    raise RuntimeError(
        f"返回内容无法解析为 JSON（回复中未找到完整 JSON 对象）。"
        f"解析错误：{last_err}。原文摘录：{raw[:300]!r}"
    )

class RefJoinString(io.ComfyNode):
    """Replace placeholders in an expression with up to 4 fixed values.

    Example:
        value1 = "内容1", value2 = 2, value3 = 3.5, value4 = "内容4"
        expression = "{value1}/{value2}/{value3}/{value4}"
        output = "内容1/2/3.5/内容4"

    Values accept STRING, INT or FLOAT. Unused placeholders can simply be
    left out of the expression, and unconnected inputs are substituted as
    empty strings.
    """

    @classmethod
    def define_schema(cls):
        value_types = [io.String, io.Int, io.Float]
        return io.Schema(
            node_id="MiniMaxRefJoinString",
            display_name="MiniMaxRef Join Strings",
            category="minimaxrefdirector",
            search_aliases=["join", "concatenate", "combine", "merge strings", "template"],
            description=(
                "Replaces {value1}..{value4} placeholders in an expression with "
                "the connected values (STRING, INT or FLOAT). Placeholders left "
                "out of the expression are ignored; unconnected inputs become "
                "empty strings."
            ),
            inputs=[
                io.MultiType.Input(
                    "value1",
                    value_types,
                    optional=True,
                    tooltip="First value. Accepts STRING, INT or FLOAT.",
                ),
                io.MultiType.Input(
                    "value2",
                    value_types,
                    optional=True,
                    tooltip="Second value. Accepts STRING, INT or FLOAT.",
                ),
                io.MultiType.Input(
                    "value3",
                    value_types,
                    optional=True,
                    tooltip="Third value. Accepts STRING, INT or FLOAT.",
                ),
                io.MultiType.Input(
                    "value4",
                    value_types,
                    optional=True,
                    tooltip="Fourth value. Accepts STRING, INT or FLOAT.",
                ),
                io.String.Input(
                    "expression",
                    default="{value1}/{value2}/{value3}/{value4}",
                    multiline=False,
                    tooltip=(
                        "Expression with {value1}..{value4} placeholders that get "
                        "replaced by the connected values."
                    ),
                ),
            ],
            outputs=[
                io.String.Output("output", tooltip="The substituted string."),
            ],
            is_output_node=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Force execution on every loop iteration. 
        return float("NaN")

    @classmethod
    def execute(
        cls,
        value1: io.MultiType.Type = None,
        value2: io.MultiType.Type = None,
        value3: io.MultiType.Type = None,
        value4: io.MultiType.Type = None,
        expression: str = "",
    ) -> io.NodeOutput:
        values = {
            "value1": "" if value1 is None else str(value1),
            "value2": "" if value2 is None else str(value2),
            "value3": "" if value3 is None else str(value3),
            "value4": "" if value4 is None else str(value4),
        }
        try:
            return io.NodeOutput(expression.format(**values))
        except KeyError as exc:
            raise ValueError(
                f"MiniMaxRefJoinString: expression references unknown placeholder "
                f"{exc}. Available placeholders: {sorted(values)}"
            ) from exc

class RefPureVRAM(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefPureVRAM",
            display_name="MiniMaxRef Pure VRAM",
            category="minimaxrefdirector",
            search_aliases=["pure vram", "vram", "gpu"],
            description=(
                "Purge all models and GPU memory, for testing VRAM usage."
            ),
            inputs=[
                io.AnyType.Input(
                    "anything",
                    tooltip="Any input to trigger the purge.",
                ),
                io.Boolean.Input(
                    "purge_vram",
                    default=True,
                    tooltip="Whether to purge GPU memory.",
                ),
                io.Boolean.Input(
                    "purge_models",
                    default=True,
                    tooltip="Whether to purge all models.",
                ),
            ],
            outputs=[
                io.AnyType.Output("anything", tooltip="Any output to trigger the purge."),
            ],
            is_output_node=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Force execution on every loop iteration. 
        return float("NaN")
    
    @classmethod
    def execute(
            cls,
            anything: any = None,
            purge_vram: bool = True,
            purge_models: bool = True,
    ) -> io.NodeOutput:
        if purge_vram:
            unload_llama_models()
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        if purge_models:
            comfy.model_management.unload_all_models()
            comfy.model_management.soft_empty_cache()
        return io.NodeOutput(anything)