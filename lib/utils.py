import json
import re


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