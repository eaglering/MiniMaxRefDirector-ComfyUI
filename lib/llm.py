
import json
import logging
import os
import re
import urllib.error
import urllib.request

import folder_paths
import torch

from ..api_config import api_config_manager, parse_provider_value
from .image import has_image, tensor_to_base64

log = logging.getLogger(__name__)

_LLAMA_MODEL_CACHE: dict = {}

def ensure_llm_folder_registered() -> None:
    """Ensure ComfyUI's models/llm directory (used for GGUF files) is registered."""
    llm_dir = os.path.join(folder_paths.models_dir, "llm")
    try:
        paths = folder_paths.get_folder_paths("llm")
    except KeyError:
        folder_paths.add_model_folder_path("llm", llm_dir)
        return
    if llm_dir not in paths:
        folder_paths.add_model_folder_path("llm", llm_dir)


def list_llm_gguf_files() -> list[str]:
    """List *.gguf under the registered 'llm' folders plus models/llm (or models/LLM).

    Deliberately bypasses folder_paths.get_filename_list(): its results are kept
    in a strong cache (cache_helper) that is never invalidated when new
    directories are registered, so a stale empty result can stick forever (e.g.
    another extension registered 'llm' to an empty dir before we added ours, or
    the folder was created after the first call). Scanning the filesystem
    directly guarantees fresh results.
    """
    dirs: list[str] = []
    try:
        dirs.extend(folder_paths.get_folder_paths("llm"))
    except KeyError:
        pass
    for name in ("llm", "LLM"):
        d = os.path.join(folder_paths.models_dir, name)
        if d not in dirs:
            dirs.append(d)
    seen: set[str] = set()
    out: list[str] = []
    for d in dirs:
        if not os.path.isdir(d):
            continue
        try:
            entries = os.listdir(d)
        except OSError:  # pragma: no cover - defensive
            continue
        for f in entries:
            if f.lower().endswith(".gguf") and f not in seen:
                seen.add(f)
                out.append(f)
    return sorted(out)


def resolve_gguf_inputs(gguf_name: str = "", mmproj_name: str = "") -> tuple[str, str]:
    """Resolve GGUF model + optional mmproj for vlm_mode=llama-cpp.

    Falls back to auto-detecting the first VLM GGUF under models/llm when the
    dropdown selection is empty/stale (e.g. files added after the node list was
    built, or another extension hijacked the 'llm' folder registration).
    """
    ensure_llm_folder_registered()
    ggufs = list_llm_gguf_files()
    mmprojs = [f for f in ggufs if "mmproj" in f.lower()]
    models = [f for f in ggufs if f not in mmprojs]

    if not gguf_name and models:
        gguf_name = models[0]
        log.info(f"[llm] gguf_name empty, auto-selected {gguf_name!r} from models/llm")
    if (not mmproj_name or mmproj_name == "None") and mmprojs:
        mmproj_name = mmprojs[0]
        log.info(f"[llm] mmproj_name empty, auto-selected {mmproj_name!r}")
    return gguf_name, mmproj_name


def _py_tag() -> str:
    """Python tag for wheel matching, e.g. 'cp310'."""
    import sys
    return f"cp{sys.version_info.major}{sys.version_info.minor}"


def _cuda_tag() -> str | None:
    """CUDA tag from torch, e.g. '13.1' -> 'cu131'; None when torch has no CUDA build."""
    try:
        ver = torch.version.cuda
    except Exception:
        return None
    return "cu" + "".join(ver.split(".")[:2]) if ver else None


def ensure_llama_cpp() -> None:
    """Make llama_cpp importable; print a manual-install hint when missing.

    llama-cpp-python is intentionally NOT auto-installed. When it is missing,
    a console message with the download link and install steps is printed
    instead, so the user can pick the correct prebuilt wheel for their
    environment (platform / Python / CUDA).
    """
    try:
        import llama_cpp  # noqa: F401
        return
    except ImportError:
        pass

    py_tag = _py_tag()
    cuda_tag = _cuda_tag() or "CPU/unknown"
    log.error(
        "[llm] llama-cpp-python 未安装，无法加载本地 GGUF 模型"
        "（已移除自动安装，请按以下步骤手动安装）：\n"
        "1. 打开 https://github.com/JamePeng/llama-cpp-python/releases 下载最新 release 中的预编译 wheel\n"
        f"2. 选择与你的环境匹配的文件（形如 llama_cpp_python-0.3.46+cu131-{py_tag}-{py_tag}-win_amd64.whl）：\n"
        f"   - win_amd64：Windows x64 平台\n"
        f"   - {py_tag}：当前 Python 版本（由本机解释器检测）\n"
        f"   - cuXXX：CUDA 版本（本机 torch 为 {cuda_tag}，优先选择相同 cu 标签的 wheel，"
        "没有则任意 cu 版本均可）\n"
        "3. 用 ComfyUI portable 自带的 python 安装（在 ComfyUI_windows_portable 目录下执行）：\n"
        '   python_embeded\\python.exe -m pip install <下载的 .whl 文件路径>\n'
        "4. 安装完成后重启 ComfyUI 再重试\n"
    )
    raise RuntimeError(
        "[llm] llama-cpp-python is not installed. "
        "See the console output above for the manual install steps."
    )


def unload_llama_models(keep: set | None = None) -> None:
    """Explicitly close and drop cached llama-cpp models, freeing their memory.

    A llama-cpp-python ``Llama`` object owns native buffers (RAM + VRAM) that
    are only returned once ``close()`` is called and the object is released —
    simply removing the dict entry does NOT free anything. This helper:

    1. calls ``Llama.close()`` on every cached model (except keys in ``keep``),
    2. drops the references and forces a ``gc`` pass,
    3. calls ``torch.cuda.empty_cache()`` so VRAM freed by llama.cpp is
    reclaimed from the CUDA allocator pool.

    Args:
        keep: optional set of cache keys (tuples of (gguf_path, mmproj_path))
            to retain in memory, e.g. the model about to be reused by the
            current request.
    """
    global _LLAMA_MODEL_CACHE
    keys = [k for k in list(_LLAMA_MODEL_CACHE) if keep is None or k not in keep]
    if not keys:
        return
    import gc
    import torch

    freed: list[str] = []
    for k in keys:
        model = _LLAMA_MODEL_CACHE.pop(k, None)
        if model is None:
            continue
        name = os.path.basename(k[0])
        try:
            close = getattr(model, "close", None)
            if callable(close):
                close()
        except Exception as e:  # pragma: no cover - defensive
            log.warning(f"[llm] Error closing llama model {name}: {e}")
        del model
        freed.append(name)
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    log.info(
        f"[llm] Unloaded llama-cpp model(s): {', '.join(freed) or 'n/a'}; "
        f"cached models remaining: {len(_LLAMA_MODEL_CACHE)}"
    )


def get_llama_model(gguf_path: str, mmproj_path: str = ""):
    """Load (and cache) a GGUF model with llama-cpp-python; GPU first, CPU fallback.

    Only a single model is kept in memory at a time: loading a different GGUF
    (or different mmproj) evicts the previously cached one, so switching models
    in the dropdown releases the old model's RAM/VRAM immediately.
    """
    global _LLAMA_MODEL_CACHE
    key = (gguf_path, mmproj_path)
    cached = _LLAMA_MODEL_CACHE.get(key)
    if cached is not None:
        return cached
    ensure_llama_cpp()
    from llama_cpp import Llama

    kwargs: dict = dict(
        model_path=gguf_path,
        n_ctx=8192,
        n_gpu_layers=-1,  # all layers on GPU
        verbose=False,
    )
    if mmproj_path:
        kwargs["mmproj"] = mmproj_path
    log.info(
        f"[llm] Loading GGUF model: {os.path.basename(gguf_path)} "
        f"(mmproj={os.path.basename(mmproj_path) if mmproj_path else 'None'}) ..."
    )
    try:
        model = Llama(**kwargs)
    except Exception as e:
        log.warning(f"[llm] GPU load failed ({e}); retrying on CPU (n_gpu_layers=0)")
        kwargs["n_gpu_layers"] = 0
        model = Llama(**kwargs)
    _LLAMA_MODEL_CACHE[key] = model
    # Evict any previously cached model(s) so only the freshly loaded one stays
    # resident (avoids holding multiple multi-GB GGUFs in RAM/VRAM at once).
    unload_llama_models(keep={key})
    return model


def generate_prompt_with_llama(
    image = None,
    prompt: str = "",
    gguf_path: str = "",
    mmproj_path: str = "",
    seed: int = 42,
) -> dict:
    """Generate the placeholder-tagged prompt JSON with a local GGUF VLM via llama-cpp-python.

    Args:
        image: ComfyUI image tensor [B, H, W, C], optional (None = text-only mode)
        prompt: user prompt
        gguf_path: full path to the GGUF text model
        mmproj_path: full path to the vision projector GGUF (required for image analysis)
        seed: sampling seed for llama.cpp

    Returns:
        dict: same shape as generate_prompt_with_clip
    """
    has_multi_model = has_image(image) and bool(mmproj_path)
    if has_image(image) and not mmproj_path:
        log.warning(
            "[llm] Image provided but no mmproj (vision projector) selected "
            "-> running in text-only mode."
        )
    llm = get_llama_model(gguf_path, mmproj_path)
    content: list[dict] = [{"type": "text", "text": prompt}]
    if has_multi_model:
        content.append({"type": "image_url", "image_url": {"url": tensor_to_base64(image)}})
    log.info(f"[llm] Generating with GGUF model: {os.path.basename(gguf_path)} ...")
    try:
        resp = llm.create_chat_completion(
            messages=[{"role": "user", "content": content}],
            max_tokens=4096,
            temperature=0.1,
            seed=_clamp_seed_32(seed),
        )
    except Exception as e:
        raise RuntimeError(f"[llm] GGUF generation failed: {e}") from e
    unload_llama_models()
    generated_text = ""
    try:
        generated_text = resp["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"[llm] Unexpected GGUF response: {str(resp)[:500]}") from e
    log.info(f"[llm] GGUF model generated (first 200 chars): {generated_text[:200]}")
    return generated_text

def _clamp_seed_32(seed: int | None) -> int | None:
    """Map a (possibly 64-bit) seed into the signed 32-bit int range accepted by
    most OpenAI-compatible providers.

    Zhipu's GLM gateway rejects seeds outside [-2147483648, 2147483647] with
    HTTP 400 ("Numeric value out of range of int"), while the node's seed input
    allows values up to 2^64-1. Clamping keeps the value deterministic while
    staying within the API's contract. Returns None for None input.
    """
    if seed is None:
        return None
    return int(seed) % (2**31)


# Env-var fallback per service id (used only when the key is missing everywhere else)
_SERVICE_ENV_KEYS = {
    "glm": "ZHIPU_API_KEY",
    "kimi": "MOONSHOT_API_KEY",
    "qwen": "DASHSCOPE_API_KEY",
    "doubao": "ARK_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "xflow": "XFLOW_API_KEY",
}


def _is_glm_vision_model(model: str) -> bool:
    """True for Zhipu GLM vision models, whose max_tokens is capped at 1024."""
    return bool(re.search(r"glm-4(?:\.\d+)?v", (model or "").strip().lower()))


def generate_prompt_with_api(
    image = None,
    prompt: str = "",
    provider: str = "GLM",
    api_key: str = "",
    seed: int = 42,
) -> str:
    """Generate text with a cloud OpenAI-compatible VLM/LLM endpoint.

    Args:
        image: ComfyUI image tensor [B, H, W, C], optional (None = text-only mode)
        prompt: full user prompt (with the H3 skills template baked in)
        provider: service label or service id (e.g. "GLM", "glm", "openrouter")
        api_key: optional key override; falls back to the API 管理器 config,
            then to the matching env var (e.g. ZHIPU_API_KEY)
        seed: sampling seed, clamped into the signed 32-bit int range

    Returns:
        str: the raw generated text (parsing is left to the caller)
    """
    service_id = parse_provider_value(provider) if provider else ""
    cfg = api_config_manager.get_config_for("vlm", service_id=service_id or None) or {}
    service_name = cfg.get("service_name", "vlm")

    resolved_key = (api_key or "").strip() or cfg.get("api_key", "").strip()
    if not resolved_key:
        env_key = _SERVICE_ENV_KEYS.get(cfg.get("service_id", ""))
        if env_key:
            resolved_key = os.environ.get(env_key, "").strip()
    if not resolved_key:
        raise ValueError(
            f"[llm] No API key for '{service_name}'. Provide api_key in the node, "
            "configure it in ComfyUI Settings -> API 管理器, or set the "
            "corresponding env var (e.g. ZHIPU_API_KEY)."
        )

    base_url = cfg.get("base_url", "")
    model = cfg.get("model", "")
    if not base_url or not model:
        raise ValueError(
            f"[llm] Incomplete API config for '{service_name}': "
            "missing base_url/model. Open ComfyUI Settings -> API 管理器 to configure it."
        )

    content: list[dict] = [{"type": "text", "text": prompt}]
    if has_image(image):
        content.append({"type": "image_url", "image_url": {"url": tensor_to_base64(image)}})

    # GLM vision models cap max_tokens at 1024
    max_tokens = 1024 if _is_glm_vision_model(model) else 4096
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.1,
        "max_tokens": max_tokens,
    }
    if seed is not None:
        payload["seed"] = _clamp_seed_32(seed)

    log.info("[llm] Calling %s API (%s) ...", service_name, model)
    req = urllib.request.Request(
        base_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {resolved_key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"[llm] {service_name} API HTTP {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"[llm] {service_name} API request failed: {e.reason}") from e

    data = json.loads(body)
    try:
        generated_text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"[llm] Unexpected {service_name} API response: {body[:500]}") from e

    log.info("[llm] %s API generated (first 200 chars): %s",
             service_name, str(generated_text)[:200])
    return generated_text
