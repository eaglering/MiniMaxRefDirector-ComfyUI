import json
import os
import logging
import folder_paths
from comfy_api.latest import io

log = logging.getLogger(__name__)

SubjectData = io.Custom("SUBJECT_DATA")


class MiniMaxRefSubject(io.ComfyNode):
    """Multi-subject input node supporting any number of subjects with name, description,
    reference image, and audio file for multi-subject video generation workflows."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefSubject",
            display_name="MiniMax Reference Subject",
            category="minimax",
            description=(
                "Define any number of subjects, each with a name, description, reference image, "
                "and audio file. Connect to LTX Director for @-mention subject injection "
                "in prompts."
            ),
            inputs=[
                io.String.Input(
                    "subject_data", default="", multiline=True,
                    tooltip="JSON state of all subjects (auto-managed by the UI; do not edit by hand).",
                ),
                io.Int.Input(
                    "subject_count", default=1, min=1, step=1,
                    tooltip="Number of active subjects to display in the UI.",
                ),
            ],
            outputs=[
                SubjectData.Output(display_name="subject_data", tooltip="Structured subject data for downstream nodes.")
            ],
        )

    @classmethod
    def execute(cls, subject_data="", subject_count=1) -> io.NodeOutput:
        subjects = []
        try:
            parsed = json.loads(subject_data) if subject_data else {}
            subjects = parsed.get("subjects", [])
        except (json.JSONDecodeError, TypeError) as e:
            log.warning(f"[MiniMaxRefSubject] Failed to parse subject_data: {e}")

        # Build structured output
        output = {
            "subjects": [],
        }

        for subj in subjects:
            entry = {
                "name": str(subj.get("name", ""))[:128],
                "description": str(subj.get("description", ""))[:1024],
                "imageFile": str(subj.get("imageFile", "")),
                "audioFile": str(subj.get("audioFile", "")),
            }
            output["subjects"].append(entry)

        # Resolve image/audio file paths to absolute paths for downstream consumption.
        # ComfyUI convention: files are stored relative to input/ directory.
        # We resolve them here so downstream nodes (calling external APIs) get full paths.
        def _resolve_file(filename: str) -> str:
            if not filename:
                return filename
            # 1. Direct match under input/
            candidate = os.path.join(folder_paths.get_input_directory(), filename)
            if os.path.exists(candidate):
                return os.path.abspath(candidate)
            # 2. Fallback: search by basename under minimaxrefdirector/
            basename = os.path.basename(filename)
            fallback = os.path.join(folder_paths.get_input_directory(), "minimaxrefdirector", basename)
            if os.path.exists(fallback):
                return os.path.abspath(fallback)
            # 3. Already an absolute path?
            if os.path.isabs(filename) and os.path.exists(filename):
                return filename
            # 4. Not found — keep original (may be base64, URL, or non-existent)
            return filename

        for s in output["subjects"]:
            s["imageFile"] = _resolve_file(s["imageFile"])
            s["audioFile"] = _resolve_file(s["audioFile"])

        return io.NodeOutput(
            output,
        )


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefSubject": MiniMaxRefSubject,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefSubject": "MiniMax Reference Subject",
}
