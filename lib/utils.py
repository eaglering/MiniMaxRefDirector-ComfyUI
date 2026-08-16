import json
import re
from comfy_api.latest import io, UI

def find_index(list: list, func: callable):
    for i, v in enumerate(list):
        if func(v):
            return i
    return -1

def seconds_to_mmssmmm(seconds: float) -> str:
    """Convert float seconds to MM:SS.mmm format string.

    Example: 0.04 -> "00:00.040", 3.0 -> "00:03.000", 65.5 -> "01:05.500".
    """
    total_seconds = max(0.0, seconds)
    minutes = int(total_seconds // 60)
    secs = int(total_seconds % 60)
    millis = int(round((total_seconds - int(total_seconds)) * 1000))
    return f"{minutes:02d}:{secs:02d}.{millis:03d}"

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