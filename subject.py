import json
import os
import logging
import folder_paths
from comfy_api.latest import io

from .api_config import api_config_manager
from .lib.llm import list_llm_gguf_files

log = logging.getLogger(__name__)

SubjectData = io.Custom("SUBJECT_DATA")
SubjectConfig = io.Custom("SUBJECT_CONFIG")


def _llm_file_options() -> tuple[list[str], list[str]]:
    """Return (gguf models, mmproj files) found under models/llm.

    GGUFs whose name contains "mmproj" are treated as vision-projector files.
    """
    ggufs = list_llm_gguf_files()
    mmprojs = [f for f in ggufs if "mmproj" in f.lower()]
    models = [f for f in ggufs if f not in mmprojs]
    return models, mmprojs


def _provider_options() -> tuple[list[str], str]:
    """Return (provider options, default) from the API config manager (vlm mode)."""
    try:
        options, default = api_config_manager.get_provider_options("vlm")
        return options or ["GLM", "Kimi", "Qwen", "Doubao"], default or "GLM"
    except Exception:
        return ["GLM", "Kimi", "Qwen", "Doubao"], "GLM"


def _resolve_llm_path(filename: str) -> str:
    """Resolve a GGUF basename from models/llm to an absolute path ('' when missing)."""
    if not filename or filename == "None":
        return ""
    try:
        full = folder_paths.get_full_path("llm", filename)
        if full:
            return full
    except (KeyError, AttributeError):
        pass
    # Fallback: scan registered llm folders directly.
    for d in (folder_paths.get_folder_paths("llm") if "llm" in folder_paths.folder_names_and_paths else []):
        candidate = os.path.join(d, filename)
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    return filename


class MiniMaxRefSubject(io.ComfyNode):
    """Multi-subject input node supporting any number of subjects with name, description,
    reference image, audio file, type (Subject/Picture/Video/Audio) and retention
    relationship for multi-subject video generation workflows.

    Also aggregates the diffusion model / CLIP / video VAE / audio VAE and the VLM
    configuration (llama-cpp or API) into a single config output for downstream nodes.
    """

    @classmethod
    def define_schema(cls):
        gguf_models, mmproj_files = _llm_file_options()
        gguf_options = gguf_models or ["None"]
        mmproj_options = mmproj_files or ["None"]
        provider_options, provider_default = _provider_options()
        return io.Schema(
            node_id="MiniMaxRefSubject",
            display_name="MiniMax Reference Subject",
            category="minimaxrefdirector",
            description=(
                "Define any number of subjects, each with a name, description, reference image, "
                "and audio file. Connect to LTX Director for @-mention subject injection "
                "in prompts. Also forwards the diffusion model / CLIP / video VAE / audio VAE "
                "and VLM settings (local llama-cpp or cloud API) as a unified config."
            ),
            inputs=[
                io.Model.Input("model", tooltip="The diffusion model to use for generation."),
                io.Clip.Input("clip", tooltip="The CLIP model to use for conditioning."),
                io.Vae.Input("video_vae", tooltip="The video VAE to use for latent decoding."),
                io.Vae.Input("audio_vae", tooltip="The audio VAE to use for audio conditioning.", optional=True),
                io.DynamicCombo.Input(
                    "vlm_mode",
                    options=[
                        io.DynamicCombo.Option("llama-cpp", [
                            io.Combo.Input(
                                "gguf_name", options=gguf_options,
                                default=gguf_models[0] if gguf_models else "None",
                                tooltip="Local GGUF text model for the VLM (from models/llm).",
                            ),
                            io.Combo.Input(
                                "mmproj_path", options=mmproj_options,
                                default=mmproj_files[0] if mmproj_files else "None",
                                tooltip="Local mmproj (vision projector) GGUF for the VLM (from models/llm).",
                            ),
                        ]),
                        io.DynamicCombo.Option("api", [
                            io.Combo.Input(
                                "provider", options=provider_options, default=provider_default,
                                tooltip="Cloud VLM/LLM provider (configured in ComfyUI Settings -> API manager).",
                            ),
                            io.String.Input(
                                "api_key", default="",
                                tooltip="Optional API key override; falls back to the API manager config, then to the matching env var.",
                            ),
                        ]),
                    ],
                    tooltip="How the H3 prompt is generated: locally with llama-cpp (GGUF) or via a cloud API.",
                ),
                io.String.Input(
                    "global_prompt", multiline=True, default="", optional=True,
                    tooltip="Conditions the entire video. Anchors persistent characters, objects, and scene context.",
                ),
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
                io.Model.Output("model", tooltip="The diffusion model, passed through unchanged."),
                io.Clip.Output("clip", tooltip="The CLIP model, passed through unchanged."),
                io.Vae.Output("video_vae", tooltip="The video VAE, passed through unchanged."),
                io.Vae.Output("audio_vae", tooltip="The audio VAE, passed through unchanged."),
                SubjectConfig.Output("config", tooltip="Unified config: VLM opts plus structured subject data."),
            ],
        )

    @classmethod
    def execute(cls, model=None, clip=None, video_vae=None, audio_vae=None, vlm_mode=None,
                global_prompt="", subject_data="", subject_count=1) -> io.NodeOutput:
        # VLM mode: llama-cpp (local GGUF) or api (cloud provider).
        # DynamicCombo passes a dict, e.g. {"vlm_mode": "llama-cpp", "gguf_name": ..., "mmproj_path": ...}
        mode = "llama-cpp"
        gguf_name = ""
        mmproj_path = ""
        provider = ""
        api_key = ""
        if isinstance(vlm_mode, dict):
            mode = str(vlm_mode.get("vlm_mode") or "llama-cpp")
            gguf_name = str(vlm_mode.get("gguf_name") or "")
            mmproj_path = str(vlm_mode.get("mmproj_path") or "")
            provider = str(vlm_mode.get("provider") or "")
            api_key = str(vlm_mode.get("api_key") or "")

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
                "type": str(subj.get("type", "") or "Subject")[:32],
                "relationship": str(subj.get("relationship", "") or "fully_preserved")[:64],
                "audio_relationship": str(subj.get("audio_relationship", "") or "reference")[:64],
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

        # Unified config: VLM opts (consumed by the H3 prompt generator) + subject data.
        opts = {
            "vlm_mode": mode,
            "gguf_name": gguf_name,
            "gguf_path": _resolve_llm_path(gguf_name),
            "mmproj_name": mmproj_path,
            "mmproj_path": _resolve_llm_path(mmproj_path),
            "provider": provider,
            "api_key": api_key,
        }
        config = {
            "opts": opts,
            "subject_data": output,
            "global_prompt": global_prompt,
            "subject_count": subject_count,
        }

        return io.NodeOutput(
            model,
            clip,
            video_vae,
            audio_vae,
            config,
        )


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefSubject": MiniMaxRefSubject,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefSubject": "MiniMax Reference Subject",
}
