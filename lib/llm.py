
import functools
import json
import logging
import os
import re
import threading
import urllib.error
import urllib.request

import folder_paths

from ..api_config import api_config_manager, parse_provider_value
from .image import has_image, tensor_to_base64
from .llama_server import endpoint as _llama_server_endpoint, status as _llama_server_status

log = logging.getLogger(__name__)

# 全局 LLM 推理锁：llama-server 的生成调用、云 API 与 Ollama 的推理全部经
# _llm_serialized 串行化——多个请求（HTTP to_thread worker / 节点执行器线程）
# 同时打进来会排队而不是并发抢共享服务与显存。用 threading.Lock 而非
# asyncio.Lock：临界区可能跨线程（执行器线程与 asyncio 线程池同时到达）。
_LLM_INFER_LOCK = threading.Lock()


def _llm_serialized(fn):
    """持全局锁执行一次 LLM 推理/生成，保证任何时刻只有一个请求在跑。"""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with _LLM_INFER_LOCK:
            return fn(*args, **kwargs)

    return wrapper

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


@_llm_serialized
def generate_prompt_with_llama(
    image=None,
    prompt: str = "",
    gguf_path: str = "",
    mmproj_path: str = "",
    seed: int = 42,
) -> str:
    """Generate text with the external llama-server (OpenAI-compatible HTTP).

    模型由 llama-server 进程加载（lib/llama_server.py start()，GGUF + 可选
    mmproj 由设置面板「启动」时指定）；本函数仅做 HTTP 调用，不再在 ComfyUI
    进程内加载 GGUF（避免与 torch 抢占显存/RAM）。

    Args:
        image: ComfyUI image tensor [B, H, W, C], optional (None = text-only mode)
        prompt: user prompt
        gguf_path / mmproj_path: 兼容旧调用签名；llama-server 模式下模型由
            启动参数决定，这两个入参被忽略（仅用于日志提示不一致）
        seed: sampling seed

    Returns:
        str: the raw generated text (parsing is left to the caller)

    Raises:
        RuntimeError: llama-server 未启动（含设置面板指引）
    """
    st = _llama_server_status()
    if not st.get("running"):
        # 按需拉起：生成时自动启动 llama-server（配置取 API 管理器 llama-server 页），
        # 空闲 5 分钟后由看门狗自动停止；失败时给出可操作的指引。
        try:
            from .llama_server import ensure_running

            st = ensure_running(gguf_path=gguf_path, mmproj_path=mmproj_path)
            log.info("[llm] llama-server 已自动拉起（model=%s，空闲 %ds 后自动停止）",
                     st.get("model"), 300)
        except Exception as e:
            raise RuntimeError(
                "[llm] llama-server 自动启动失败：" + str(e)
                + "。也可在 SPA「LLM 设置 → llama-server」手动启动。"
                + (f"（当前状态：模型加载中 {st.get('model', '')}）"
                   if isinstance(st, dict) and st.get("loading") else "")
            ) from e
        if not st.get("running"):
            raise RuntimeError("[llm] llama-server 启动后健康检查未就绪，请查看 llama-server.log")
    if gguf_path and os.path.basename(gguf_path) != st.get("model", ""):
        log.info(
            "[llm] llama-server 已加载 %s，忽略请求参数 gguf_path=%s（换模型请在设置面板重启服务）",
            st.get("model"), os.path.basename(gguf_path),
        )

    content: list[dict] = [{"type": "text", "text": prompt}]
    if has_image(image):
        if not st.get("mmproj"):
            log.warning(
                "[llm] Image provided but llama-server started without --mmproj "
                "-> the server may reject the image; restart with mmproj for vision."
            )
        content.append({"type": "image_url", "image_url": {"url": tensor_to_base64(image)}})

    payload = {
        "model": st.get("model") or "default",
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.1,
        "max_tokens": 4096,
    }
    if seed is not None:
        payload["seed"] = _clamp_seed_32(seed)

    url = _llama_server_endpoint() + "/v1/chat/completions"
    log.info("[llm] Calling llama-server (%s) at %s ...", st.get("model"), url)
    try:
        from .llama_server import mark_activity

        mark_activity()  # 刷新空闲计时（自动拉起的实例用完续命）
    except ImportError:
        pass
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"[llm] llama-server HTTP {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"[llm] llama-server request failed: {e.reason}. "
            "服务可能已退出，请在设置面板重新启动"
        ) from e

    data = json.loads(body)
    try:
        generated_text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"[llm] Unexpected llama-server response: {body[:500]}") from e
    log.info("[llm] llama-server generated (first 200 chars): %s", str(generated_text)[:200])
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


def unload_llama_models(keep: set | None = None) -> None:
    """兼容旧接口：确保 llama-server 已停止（释放其显存占用）。

    旧语义为卸载进程内 llama-cpp 模型；llama-server 模式下模型在外部进程，
    ComfyUI 节点开始视频生成（Guide 编码 / VRAM 清理节点）前调用本函数停止
    llama-server，实现"LLM 生成与视频生成串行"。与进行中的 LLM 推理互斥：
    持 _LLM_INFER_LOCK 排队，不会打断正在进行的生成。keep 参数仅为签名兼容，
    忽略。
    """
    with _LLM_INFER_LOCK:
        try:
            st = _llama_server_status()
            if st.get("running") or st.get("loading"):
                from .llama_server import stop as _ls_stop

                _ls_stop()
                log.info("[llm] llama-server 已停止（节点开始视频生成前释放显存）")
        except Exception as e:  # pragma: no cover - defensive
            log.warning("[llm] stop llama-server failed: %s", e)


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


@_llm_serialized
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
        # H3 长输出（max_tokens 4096）可达 3-6 分钟，180s 会在三种服务端模式里
        # 最先超时失败；统一放宽到 480s（与 ollama/llama-server/网页通道对齐）
        with urllib.request.urlopen(req, timeout=480) as resp:
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


@_llm_serialized
def generate_prompt_with_ollama(
    image=None,
    prompt: str = "",
    model: str = "",
    base_url: str = "",
    api_key: str = "ollama",
    seed: int = 42,
) -> str:
    """Generate text with a local Ollama server (native /api/chat or OpenAI-compatible endpoint).

    Args:
        image: ComfyUI image tensor [B, H, W, C], optional (None = text-only mode)
        prompt: full user prompt (with the H3 skills template baked in)
        model: Ollama model tag (e.g. "llava", "qwen2.5vl:7b"). Falls back to the
            API 管理器 ollama service model, then to "llava".
        base_url: Ollama endpoint. Defaults to "http://localhost:11434/api/chat".
            Point it at an OpenAI-compatible "…/v1/chat/completions" URL to use
            that API instead (both response formats are accepted).
        api_key: Ollama does not require a real key; any non-empty placeholder
            is fine (default "ollama").
        seed: sampling seed, clamped into the signed 32-bit int range
            (passed through Ollama options.seed).

    Returns:
        str: the raw generated text (parsing is left to the caller)
    """
    resolved_url = (base_url or "").strip() or "http://localhost:11434/api/chat"
    resolved_model = (model or "").strip()
    if not resolved_model:
        cfg = api_config_manager.get_config_for("vlm", service_id="ollama") or {}
        resolved_model = (cfg.get("model") or "").strip() or "llava"

    is_openai_compat = resolved_url.rstrip("/").endswith("/v1/chat/completions")
    messages: list[dict] = [{"role": "user", "content": prompt}]
    if has_image(image):
        b64 = tensor_to_base64(image)
        if is_openai_compat:
            messages[0]["content"] = [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": b64}},
            ]
        else:
            messages[0]["images"] = [b64]

    payload: dict = {
        "model": resolved_model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 4096},
    }
    if seed is not None:
        payload["options"]["seed"] = _clamp_seed_32(seed)

    log.info("[llm] Calling Ollama (%s) at %s ...", resolved_model, resolved_url)
    req = urllib.request.Request(
        resolved_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer %s" % ((api_key or "").strip() or "ollama"),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"[llm] Ollama HTTP {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"[llm] Ollama request failed: {e.reason}. "
            "Is the Ollama server running (default http://localhost:11434)?"
        ) from e

    data = json.loads(body)
    generated_text = ""
    try:
        # OpenAI 兼容格式：{"choices": [{"message": {"content": ...}}]}
        generated_text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        # Ollama 原生格式：{"message": {"content": ...}}
        try:
            generated_text = data["message"]["content"]
        except (KeyError, TypeError) as e:
            raise RuntimeError(f"[llm] Unexpected Ollama response: {body[:500]}") from e
    log.info("[llm] Ollama generated (first 200 chars): %s", str(generated_text)[:200])
    return generated_text


# ---------------------------------------------------------------------------
# deepseek-proxy：经浏览器扩展（DeepSeek Bridge）的 WS 桥接调用 chat.deepseek.com
# 网页会话完成纯文本生成，无需 API Key，也无需本地模型。
# ---------------------------------------------------------------------------
# 专用轻量锁（与 _LLM_INFER_LOCK 分离）：deepseek 不占本地模型与显存，不应把
# llama 卸载（llama_server.stop 抢占的是模块内 _LOCK）与本地推理卡在它后面；
# 但扩展侧单个 DeepSeek 页面同一时刻只能服务一次填充发送，后端并发任务必须
# 排队，否则「发送前文本快照 / 回复归属」会错乱。
_DEEPSEEK_LOCK = threading.Lock()


def generate_prompt_with_deepseek_proxy(
    prompt: str = "", image=None, seed: int = 42, timeout_s: float = 290.0,
    site: str = "deepseek",
) -> str:
    """Generate text via the web-chat bridge (browser extension over WS).

    与 generate_prompt_with_api / ollama / llama 同一契约：返回生成的原始文本
    str，出错 raise（ValueError / RuntimeError）。仅支持纯文本——image 非 None
    时抛 ValueError（网页会话无法传图，请改用 api / ollama / llama-server）。
    seed 仅为接口对齐（网页会话无法固定采样种子，忽略）。
    timeout_s 默认 290s：受扩展 MV3 Service Worker 单请求存活上限约束。
    site：桥接站点（"deepseek" / "doubao" / "qwen"，即扩展多站点适配器）。
    """
    if image is not None:
        raise ValueError(
            f"{site}-proxy 不支持图片输入（网页会话无法传图）："
            "请改用 api / ollama / llama-server 模式"
        )
    if not (prompt or "").strip():
        raise ValueError(f"[llm] {site}-proxy: prompt is empty")

    from .deepseek_bridge import deepseek_complete  # 惰性导入，规避导入顺序问题

    with _DEEPSEEK_LOCK:
        result = deepseek_complete(
            system="", prompt=prompt, expect_json=False, timeout_s=timeout_s, site=site,
        )
    if not result.get("ok"):
        raise RuntimeError(
            f"[llm] {site}-proxy bridge failed: {result.get('error') or 'unknown error'}"
        )
    generated_text = str(result.get("text") or "")
    log.info("[llm] %s-proxy generated (first 200 chars): %s", site, generated_text[:200])
    return generated_text
