"""MiniMaxRefDirector server routes for the Settings API config panel."""

from __future__ import annotations

import asyncio
import json
import os
import traceback

import folder_paths
from aiohttp import web

from .lib.image import load_image_tensor
from .lib.llm import generate_prompt_with_api
from .lib.prompt import generate_h3_prompt, image_analysis
from server import PromptServer

from .api_config import api_config_manager

API_PREFIX = "/minimax_ref/api"

# --- 惰性路由注册 ---
# `PromptServer.instance` 要到 ComfyUI 真正构造 PromptServer() 后才被赋值。
# 本模块可能在 instance 就绪之前被导入（例如被其他自定义节点提前 import），
# 若在模块顶层直接 `@PromptServer.instance.routes.get(...)` 会抛
# AttributeError 导致整个插件加载失败。这里用一个代理收集所有路由，待
# PromptServer.instance 可用时再统一注册（见模块末尾 _flush_routes()）。
class _LazyRoutes:
    _pending: list = []

    def get(self, path, **kwargs):
        return self._decorate("get", path, kwargs)

    def post(self, path, **kwargs):
        return self._decorate("post", path, kwargs)

    def _decorate(self, method, path, kwargs):
        def wrapper(func):
            self._pending.append((method, path, kwargs, func))
            return func
        return wrapper

    @classmethod
    def flush(cls):
        if not cls._pending:
            return
        ps = getattr(PromptServer, "instance", None)
        if ps is None or getattr(ps, "routes", None) is None:
            return  # 尚未就绪，保持 pending，待后续再次尝试
        table = ps.routes
        for method, path, kwargs, func in cls._pending:
            getattr(table, method)(path, **kwargs)(func)
        cls._pending = []


_routes = _LazyRoutes()

# --- 开发期扩展资源缓存失效 ---
# ComfyUI 对 /extensions/ 静态资源可能带 ETag / 启发式缓存，改 JS/CSS 后浏览器
# 仍可能使用旧模块，导致新增样式/逻辑不生效。这里对本节点的 web 资源强制
# Cache-Control: no-store，改文件后刷新页面即拉取最新模块。
_WEB_PREFIX = "/extensions/MiniMaxRefDirector-ComfyUI/"


@web.middleware
async def no_cache_extension_assets(request: web.Request, handler):
    response = await handler(request)
    if request.path.startswith(_WEB_PREFIX) and (
        request.path.endswith(".js") or request.path.endswith(".css")
    ):
        response.headers["Cache-Control"] = "no-store"
    return response


try:
    _app = PromptServer.instance.app
    if no_cache_extension_assets not in _app.middlewares:
        _app.middlewares.append(no_cache_extension_assets)
except Exception:
    # 极少数 ComfyUI 版本 app 已 freeze / middlewares 不可变时忽略，不影响功能
    pass


def _resolve_llm_file(name: str) -> str:
    """Resolve a GGUF model name (from the subject node dropdown) to a full path
    under the registered 'llm' model folders. Absolute paths pass through."""
    if not name or name == "None":
        return ""
    if os.path.isabs(name) or os.sep in name:
        return name
    try:
        dirs = folder_paths.get_folder_paths("llm")
    except KeyError:
        dirs = []
    for d in dirs:
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    return os.path.join(folder_paths.models_dir, "llm", name)


@_routes.get(f"{API_PREFIX}/view_image")
async def view_image_inline(request: web.Request) -> web.Response:
    """与 ComfyUI 官方 /view 等价，但强制 Content-Disposition: inline。

    官方 /view 对输出图只返回裸 ``filename="..."``（无 inline 前缀），
    浏览器按 RFC 6266 缺省视作 attachment，导致右键“在新标签页中打开
    图片”变成下载而非显示。本端点供插件内图片预览 URL 使用。
    """
    filename = request.query.get("filename", "")
    subfolder = (request.query.get("subfolder", "") or "").replace("\\", "/").strip("/")
    type_ = request.query.get("type", "output")
    if not filename:
        return web.Response(status=400)
    if type_ == "input":
        base_dir = folder_paths.get_input_directory()
    elif type_ == "temp":
        base_dir = folder_paths.get_temp_directory()
    else:
        base_dir = folder_paths.get_output_directory()
    target = os.path.abspath(os.path.join(base_dir, subfolder, os.path.basename(filename)))
    # 防目录穿越：target 必须位于 base_dir 之内
    try:
        if os.path.commonpath([target, os.path.abspath(base_dir)]) != os.path.abspath(base_dir):
            return web.Response(status=403)
    except ValueError:
        return web.Response(status=403)
    if not os.path.isfile(target):
        return web.Response(status=404)
    import mimetypes
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    safe_name = filename.replace("\\", "\\\\").replace('"', '\\"')
    return web.FileResponse(
        target,
        headers={
            "Content-Type": content_type,
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@_routes.get(f"{API_PREFIX}/config")
async def get_api_config(request: web.Request) -> web.Response:
    """Return the full API configuration (API keys are returned as-is to the owner)."""
    try:
        config = api_config_manager.load_config()
        return web.json_response({"success": True, "config": config})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


# 模块末尾尝试将惰性收集的路由注册到 PromptServer（正常 ComfyUI 启动时
# PromptServer.instance 此时已就绪）。若仍不可用，_pending 保留，等待
# __init__.py 末尾再次调用 _LazyRoutes.flush()。
_LazyRoutes.flush()


@_routes.post(f"{API_PREFIX}/config")
async def save_api_config(request: web.Request) -> web.Response:
    """Persist the full API configuration from the Settings panel."""
    try:
        data = await request.json()
        config = data.get("config", {})
        api_config_manager.save_config(config)
        return web.json_response({"success": True})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


# 模块末尾尝试将惰性收集的路由注册到 PromptServer（正常 ComfyUI 启动时
# PromptServer.instance 此时已就绪）。若仍不可用，_pending 保留，等待
# __init__.py 末尾再次调用 _LazyRoutes.flush()。
_LazyRoutes.flush()


@_routes.post(f"{API_PREFIX}/llm/unload")
async def unload_llama_models_api(request: web.Request) -> web.Response:
    """Unload all cached local GGUF (llama-cpp) models to free RAM/VRAM.

    Lazy import keeps this module import-order agnostic (avoids cycles with
    minimax_ref_prompt_enhance which imports comfy modules).
    """
    try:
        from .lib.llm import unload_llama_models as _unload

        _unload()
        return web.json_response({"success": True, "unloaded": True})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


# 模块末尾尝试将惰性收集的路由注册到 PromptServer（正常 ComfyUI 启动时
# PromptServer.instance 此时已就绪）。若仍不可用，_pending 保留，等待
# __init__.py 末尾再次调用 _LazyRoutes.flush()。
_LazyRoutes.flush()

@_routes.post(f"{API_PREFIX}/llm/generate_image_analysis")
async def generate_image_analysis_api(request: web.Request) -> web.Response:
    try:
        data = await request.json()
        image_path = data.get("image_path", "")
        prompt = data.get("prompt", "")
        vlm_mode = data.get("vlm_mode", "llama-cpp")
        gguf_path = data.get("gguf_path", "")
        mmproj_path = data.get("mmproj_path", "")
        seed = data.get("seed", 42)
        if not prompt:
            return web.json_response({"success": False, "error": "prompt is required"}, status=400)
        if vlm_mode == "llama-cpp":
            gguf_path = _resolve_llm_file(gguf_path)
            if not gguf_path:
                return web.json_response({"success": False, "error": "gguf_path is required (no GGUF found under models/llm)"}, status=400)
            mmproj_path = _resolve_llm_file(mmproj_path)
            prompt_data = image_analysis(gguf_path, mmproj_path, prompt, image_path, seed)
        else:
            provider = data.get("provider", "GLM")
            api_key = data.get("api_key", "")
            image = load_image_tensor(image_path) if image_path else None
            text = generate_prompt_with_api(
                image=image, prompt=prompt, provider=provider, api_key=api_key, seed=seed
            )
            prompt_data = {"detailed_description": text}
        return web.json_response({"success": True, "prompt_data": prompt_data})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


# 模块末尾尝试将惰性收集的路由注册到 PromptServer（正常 ComfyUI 启动时
# PromptServer.instance 此时已就绪）。若仍不可用，_pending 保留，等待
# __init__.py 末尾再次调用 _LazyRoutes.flush()。
_LazyRoutes.flush()

@_routes.post(f"{API_PREFIX}/llm/generate_prompt_json")
async def generate_prompt_json_api(request: web.Request) -> web.Response:
    try:
        data = await request.json()
        prompt = data.get("prompt", "")
        image_path = data.get("image_path", "")
        vlm_mode = data.get("vlm_mode", "llama-cpp")
        seed = data.get("seed", 42)
        options = {
            "gguf_path": data.get("gguf_path", ""),
            "mmproj_path": data.get("mmproj_path", ""),
            "provider": data.get("provider", "GLM"),
            "api_key": data.get("api_key", ""),
        }
        if not prompt:
            return web.json_response({"success": False, "error": "prompt is required"}, status=400)
        if vlm_mode == "llama-cpp":
            options["gguf_path"] = _resolve_llm_file(options["gguf_path"])
            if not options["gguf_path"]:
                return web.json_response({"success": False, "error": "gguf_path is required (no GGUF found under models/llm)"}, status=400)
            options["mmproj_path"] = _resolve_llm_file(options["mmproj_path"])
        elif vlm_mode == "api":
            if not options["provider"]:
                return web.json_response({"success": False, "error": "provider is required"}, status=400)
            # api_key 允许为空：generate_prompt_with_api 会回落 API 管理器配置 / 环境变量
        json_data = generate_h3_prompt(prompt=prompt, image_path=image_path, seed=seed, 
                                       vlm_mode=vlm_mode, options=options)
        return web.json_response({"success": True, "json_data": json_data})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


# 模块末尾尝试将惰性收集的路由注册到 PromptServer（正常 ComfyUI 启动时
# PromptServer.instance 此时已就绪）。若仍不可用，_pending 保留，等待
# __init__.py 末尾再次调用 _LazyRoutes.flush()。
_LazyRoutes.flush()


@_routes.post(f"{API_PREFIX}/h3/build_subject_bindings")
async def build_subject_bindings_api(request: web.Request) -> web.Response:
    """构建 H3 主体绑定（subject_definition / retention_analysis
    + images / audios / videos），替代前端 buildFirstFramePayload 中的组装逻辑。"""
    try:
        from .lib.prompt import build_h3_subject_bindings
        data = await request.json()
        subject_data = data.get("subject_data", {}) or {}
        raw_prompt = data.get("raw_prompt", "") or ""
        if isinstance(subject_data, str):
            try:
                subject_data = json.loads(subject_data)
            except (json.JSONDecodeError, TypeError):
                subject_data = {}
        if not isinstance(subject_data, dict):
            return web.json_response({"success": False, "error": "subject_data must be an object"}, status=400)
        if not raw_prompt.strip():
            return web.json_response({"success": False, "error": "raw_prompt must be an object"}, status=400)
        timeline_segment = data.get("timeline_segment", None)
        result = build_h3_subject_bindings(
            subject_data=subject_data,
            raw_prompt=raw_prompt,
            timeline_segment=timeline_segment,
        )
        return web.json_response({"success": True, "data": result})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


# 模块末尾尝试将惰性收集的路由注册到 PromptServer（正常 ComfyUI 启动时
# PromptServer.instance 此时已就绪）。若仍不可用，_pending 保留，等待
# __init__.py 末尾再次调用 _LazyRoutes.flush()。
_LazyRoutes.flush()


# ── 迁移自 WhatDreamsCost-ComfyUI/ltx_director.py：/ltx_director_get_audio ──
def _read_wav_peaks(wav_path: str) -> list:
    """读取 16-bit PCM WAV，返回 200 个归一化峰值点。"""
    import wave

    import numpy as np

    peaks: list = []
    with wave.open(wav_path, "rb") as wav:
        n_frames = wav.getnframes()
        if n_frames > 0:
            frames = wav.readframes(n_frames)
            samples = np.frombuffer(frames, dtype=np.int16)
            num_peaks = 200
            step = max(1, len(samples) // num_peaks)
            for i in range(num_peaks):
                chunk = samples[i * step : (i + 1) * step]
                if len(chunk) > 0:
                    max_val = np.max(np.abs(chunk)) / 32767.0
                    peaks.append(float(max_val))
                else:
                    peaks.append(0.0)
        else:
            peaks = [0.0] * 200
    return peaks


def _extract_audio_from_video(video_path: str):
    """用 PyAV 从视频提取 44.1kHz mono s16 音轨为同目录 WAV，返回 (相对 input 路径, 峰值)。"""
    import wave

    import numpy as np

    try:
        import av
    except ImportError:
        print("[MiniMaxRefDirector] 'av' 未安装，无法在服务端提取音频")
        return None, None

    try:
        base, _ = os.path.splitext(video_path)
        output_wav = base + "_extracted_audio.wav"

        # 已存在则直接复用，避免重复提取
        if os.path.exists(output_wav) and os.path.getsize(output_wav) > 44:
            try:
                with wave.open(output_wav, "rb") as wav:
                    if wav.getframerate() == 44100:
                        peaks = _read_wav_peaks(output_wav)
                        input_dir = folder_paths.get_input_directory()
                        rel_output = os.path.relpath(output_wav, input_dir).replace("\\", "/")
                        return rel_output, peaks
            except Exception:
                pass

        with av.open(video_path) as container:
            if not container.streams.audio:
                return None, None
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format="s16", layout="mono", rate=44100)
            audio_bytes = bytearray()

            for frame in container.decode(stream):
                for resampled_frame in resampler.resample(frame):
                    arr = resampled_frame.to_ndarray()
                    audio_bytes.extend(arr.tobytes())
            for resampled_frame in resampler.resample(None):
                arr = resampled_frame.to_ndarray()
                audio_bytes.extend(arr.tobytes())

            if not audio_bytes:
                return None, None

            with wave.open(output_wav, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(44100)
                wav.writeframes(audio_bytes)

        peaks = []
        samples = np.frombuffer(audio_bytes, dtype=np.int16)
        num_peaks = 200
        step = max(1, len(samples) // num_peaks)
        for i in range(num_peaks):
            chunk = samples[i * step : (i + 1) * step]
            if len(chunk) > 0:
                max_val = np.max(np.abs(chunk)) / 32767.0
                peaks.append(float(max_val))
            else:
                peaks.append(0.0)

        input_dir = folder_paths.get_input_directory()
        rel_output = os.path.relpath(output_wav, input_dir).replace("\\", "/")
        return rel_output, peaks
    except Exception:
        traceback.print_exc()
        return None, None


def _get_audio_peaks(audio_path: str):
    """读取音频文件（wav/mp3/ogg/flac/m4a 等）的 200 个归一化峰值点。"""
    import numpy as np

    try:
        import av
    except ImportError:
        print("[MiniMaxRefDirector] 'av' 未安装，无法在服务端计算音频峰值")
        return None

    try:
        _, ext = os.path.splitext(audio_path)
        if ext.lower() == ".wav":
            try:
                return _read_wav_peaks(audio_path)
            except Exception:
                pass

        with av.open(audio_path) as container:
            if not container.streams.audio:
                return None
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format="s16", layout="mono", rate=8000)
            audio_bytes = bytearray()

            for frame in container.decode(stream):
                for resampled_frame in resampler.resample(frame):
                    arr = resampled_frame.to_ndarray()
                    audio_bytes.extend(arr.tobytes())
            for resampled_frame in resampler.resample(None):
                arr = resampled_frame.to_ndarray()
                audio_bytes.extend(arr.tobytes())

            if not audio_bytes:
                return None

            peaks = []
            samples = np.frombuffer(audio_bytes, dtype=np.int16)
            num_peaks = 200
            step = max(1, len(samples) // num_peaks)
            for i in range(num_peaks):
                chunk = samples[i * step : (i + 1) * step]
                if len(chunk) > 0:
                    max_val = np.max(np.abs(chunk)) / 32767.0
                    peaks.append(float(max_val))
                else:
                    peaks.append(0.0)
            return peaks
    except Exception:
        traceback.print_exc()
        return None


@_routes.get(f"{API_PREFIX}/h3/ltx_director_get_audio")
async def get_audio_file(request):
    """从视频/音频文件提取波形峰值（迁移自 WhatDreamsCost 插件）。"""
    filename = request.query.get("filename")
    if not filename:
        return web.json_response({"error": "Missing filename"}, status=400)

    input_dir = folder_paths.get_input_directory()
    clean_filename = filename.replace("\\", "/")
    file_path = os.path.join(input_dir, clean_filename)
    if not os.path.exists(file_path):
        # 兼容旧上传路径：upload_dir/whatdreamscost/<name> 或 upload_dir/<name>
        basename = os.path.basename(clean_filename)
        temp_path = os.path.join(input_dir, "whatdreamscost", basename)
        if os.path.exists(temp_path):
            file_path = temp_path
        else:
            file_path = os.path.join(input_dir, basename)
    if not os.path.exists(file_path):
        return web.json_response({"error": f"File not found: {filename}"}, status=404)

    try:
        _, ext = os.path.splitext(file_path)
        audio_extensions = [".wav", ".mp3", ".ogg", ".flac", ".m4a"]
        if ext.lower() in audio_extensions:
            peaks = await asyncio.to_thread(_get_audio_peaks, file_path)
            rel_path = os.path.relpath(file_path, input_dir).replace("\\", "/")
            if peaks is None:
                return web.json_response({"error": "No audio track found in file"}, status=422)
            return web.json_response({"audio_file": rel_path, "peaks": peaks})
        else:
            rel_path, peaks = await asyncio.to_thread(_extract_audio_from_video, file_path)
            if peaks is None:
                return web.json_response({"error": "No audio track found in video"}, status=422)
            return web.json_response({"audio_file": rel_path, "peaks": peaks})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)


# ── 迁移自 WhatDreamsCost-ComfyUI/ltx_director.py：文件去重 / 分块上传 ──
@_routes.get(f"{API_PREFIX}/h3/ltx_director_check_file")
async def ltx_director_check_file(request):
    """检查文件是否已存在（去重），返回 {"exists": bool, "name": rel_path}。"""
    filename = request.query.get("filename", "")
    file_size = request.query.get("size", "")
    if not filename:
        return web.json_response({"exists": False})

    upload_dir = folder_paths.get_input_directory()
    temp_dir = os.path.join(upload_dir, "whatdreamscost")
    # 防路径穿越：仅取 basename
    filename = os.path.basename(filename)

    # 1. 精确匹配：whatdreamscost 子目录或 input 根目录
    possible_paths = [
        os.path.join(temp_dir, filename),
        os.path.join(upload_dir, filename),
    ]

    found_path = None
    for p in possible_paths:
        if os.path.exists(p) and os.path.isfile(p):
            if file_size:
                try:
                    if os.path.getsize(p) == int(file_size):
                        found_path = p
                        break
                except ValueError:
                    found_path = p
                    break
            else:
                found_path = p
                break

    if found_path:
        rel_name = os.path.relpath(found_path, upload_dir).replace("\\", "/")
        return web.json_response({"exists": True, "name": rel_name})

    # 2. 后缀匹配（如 _xxx.mp4）
    base_name = os.path.basename(filename)
    suffix = f"_{base_name}"
    try:
        for search_dir in [temp_dir, upload_dir]:
            if os.path.exists(search_dir):
                for f_name in os.listdir(search_dir):
                    if f_name.endswith(suffix) or f_name == base_name:
                        pot_path = os.path.join(search_dir, f_name)
                        if os.path.isfile(pot_path):
                            if file_size:
                                try:
                                    if os.path.getsize(pot_path) == int(file_size):
                                        rel_name = os.path.relpath(pot_path, upload_dir).replace("\\", "/")
                                        return web.json_response({"exists": True, "name": rel_name})
                                except ValueError:
                                    pass
                            else:
                                rel_name = os.path.relpath(pot_path, upload_dir).replace("\\", "/")
                                return web.json_response({"exists": True, "name": rel_name})
    except Exception:
        traceback.print_exc()

    return web.json_response({"exists": False})


def _read_and_write_file_chunk(file, file_path, mode):
    """读取上传的分块并写入磁盘（在 executor 中执行）。"""
    chunk_bytes = file.file.read()
    with open(file_path, mode) as f:
        f.write(chunk_bytes)


@_routes.post(f"{API_PREFIX}/h3/ltx_director_upload_chunk")
async def ltx_director_upload_chunk(request):
    """分块上传视频以绕过 413 限制；最后一块完成后提取音频波形。"""
    post = await request.post()
    file = post.get("file")
    filename = post.get("filename")
    chunk_index = int(post.get("chunk_index"))
    total_chunks = int(post.get("total_chunks"))

    upload_dir = os.path.join(folder_paths.get_input_directory(), "whatdreamscost")
    os.makedirs(upload_dir, exist_ok=True)

    # 防路径穿越
    filename = os.path.basename(filename)
    file_path = os.path.join(upload_dir, filename)
    if not os.path.realpath(file_path).startswith(os.path.realpath(upload_dir)):
        return web.json_response({"error": "Invalid filename"}, status=400)

    # 首块覆盖写入，后续块追加
    mode = "ab" if chunk_index > 0 else "wb"
    await asyncio.to_thread(_read_and_write_file_chunk, file, file_path, mode)

    if chunk_index == total_chunks - 1:
        audio_file, peaks = None, None
        try:
            audio_file, peaks = await asyncio.to_thread(_extract_audio_from_video, file_path)
        except Exception as e:
            print(f"[MiniMaxRefDirector] Error in final chunk audio extraction: {e}")

        return web.json_response({
            "name": f"whatdreamscost/{filename}",
            "audio_file": audio_file,
            "peaks": peaks,
        })
    return web.json_response({"status": "ok"})


# ── 迁移自 WhatDreamsCost-ComfyUI/ltx_director.py：/ltx_director_open_folder ──
@_routes.get(f"{API_PREFIX}/h3/ltx_director_open_folder")
async def ltx_director_open_folder(request):
    """打开本扩展视频上传目录。"""
    upload_dir = os.path.join(folder_paths.get_input_directory(), "whatdreamscost")
    os.makedirs(upload_dir, exist_ok=True)
    try:
        if hasattr(os, "startfile"):
            os.startfile(upload_dir)
        else:
            import webbrowser

            webbrowser.open(os.path.abspath(upload_dir))
        return web.json_response({"success": True})
    except Exception as e:
        print(f"[MiniMaxRefDirector] Failed to open workspace folder: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


# 模块末尾尝试将惰性收集的路由注册到 PromptServer（正常 ComfyUI 启动时
# PromptServer.instance 此时已就绪）。若仍不可用，_pending 保留，等待
# __init__.py 末尾再次调用 _LazyRoutes.flush()。
_LazyRoutes.flush()


# ── 视频素材合并：素材条多选 → RefMergeVideosFromPaths → 通知前端追加素材 ──

def _material_src_to_local_path(src: str) -> str | None:
    """把前端素材条的 viewUrl 解析为本地视频文件绝对路径。

    素材 src 形如 /view?filename=...&subfolder=...&type=... 或
    /minimax_ref/api/view_image?filename=...&subfolder=...&type=...，
    也可能是绝对/相对本地路径。解析 query 后按命中目录 + 兜底目录逐级查找。
    """
    if not src or not isinstance(src, str):
        return None
    # 1. 本地文件路径直接命中
    if os.path.isfile(src):
        return src

    filename, subfolder, typ = "", "", "output"
    try:
        from urllib.parse import parse_qs, urlparse

        qs = parse_qs(urlparse(src).query)
        filename = (qs.get("filename") or [""])[0]
        subfolder = (qs.get("subfolder") or [""])[0] or ""
        typ = (qs.get("type") or ["output"])[0] or "output"
    except Exception:
        pass
    if not filename:
        return None

    def _dirs() -> list[str]:
        dirs = []
        if typ == "input":
            dirs.append(folder_paths.get_input_directory())
        elif typ == "temp":
            dirs.append(folder_paths.get_temp_directory())
        else:
            dirs.append(folder_paths.get_output_directory())
        for d in (
            folder_paths.get_input_directory(),
            folder_paths.get_output_directory(),
            folder_paths.get_temp_directory(),
        ):
            if d not in dirs:
                dirs.append(d)
        return dirs

    subs = [subfolder, ""]
    if "whatdreamscost" not in subs:
        subs.append("whatdreamscost")
    for base in _dirs():
        for sf in subs:
            p = os.path.normpath(os.path.join(base, sf, filename))
            if not os.path.realpath(p).startswith(os.path.realpath(base)):
                continue
            if os.path.isfile(p):
                return p
    # 2. ComfyUI annotated path 兜底
    try:
        p = folder_paths.get_annotated_filepath(filename, subfolder, typ)
        if os.path.isfile(p):
            return p
    except Exception:
        pass
    return None


def _extract_merged_video_path(result) -> str | None:
    """从 RefMergeVideosFromPaths.execute 的 io.NodeOutput 提取合并后视频路径。

    io.NodeOutput 没有 outputs 属性，其输出参数通过 .result（即 .args）暴露，
    第一个参数是 Input.Video（VideoFromFile），真实文件路径取自 get_stream_source()。
    """
    raw = result
    try:
        if hasattr(result, "outputs") and result.outputs:
            raw = result.outputs[0]
        elif hasattr(result, "result"):
            res = result.result
            if isinstance(res, (list, tuple)) and res:
                raw = res[0]
    except Exception:
        pass
    if isinstance(raw, str) and os.path.isfile(raw):
        return raw
    if isinstance(raw, dict):
        p = raw.get("path")
        if isinstance(p, str) and os.path.isfile(p):
            return p
    try:
        source = raw.get_stream_source() if hasattr(raw, "get_stream_source") else None
        if isinstance(source, str) and os.path.isfile(source):
            return source
    except Exception:
        pass
    return None


@_routes.post(f"{API_PREFIX}/h3/merge_videos")
async def merge_videos_api(request: web.Request) -> web.Response:
    """合并多段视频素材为一段。

    请求体：{"paths": [素材 viewUrl / 本地路径, ...]}（至少 2 段）。
    流程：解析为本地路径 → 调用 RefMergeVideosFromPaths.execute →
    产物复制到 input/whatdreamscost/ → send_sync 通知前端追加素材。
    """
    try:
        data = await request.json()
        srcs = data.get("paths") or []
        if not isinstance(srcs, list) or len(srcs) < 2:
            return web.json_response({"success": False, "error": "请至少选择 2 段视频素材"}, status=400)

        # 前端传入的节点 id：合并产物的 add_material 通知仅该节点接收，
        # 避免多 tab / 多节点串收
        node_id = data.get("node_id")

        from .lib.video import RefMergeVideosFromPaths

        local_paths: list[str] = []
        for src in srcs:
            p = _material_src_to_local_path(src)
            if p is None:
                return web.json_response({"success": False, "error": f"无法解析素材路径: {src}"}, status=400)
            if p not in local_paths:
                local_paths.append(p)

        def _run_merge():
            return RefMergeVideosFromPaths.execute(
                paths="\n".join(local_paths),
                frame_count=-1,
                audio_mode="merge",
                audio=None,
            )

        result = await asyncio.to_thread(_run_merge)
        merged_path = _extract_merged_video_path(result)
        if not merged_path or not os.path.isfile(merged_path):
            return web.json_response({"success": False, "error": "合并失败：未生成输出文件"}, status=500)

        # 复制到素材库目录 input/whatdreamscost/，保证前端可预览、可再参与合并
        import shutil

        input_dir = folder_paths.get_input_directory()
        mat_dir = os.path.join(input_dir, "whatdreamscost")
        os.makedirs(mat_dir, exist_ok=True)
        ext = os.path.splitext(merged_path)[1] or ".mp4"
        if ext.lower() not in (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"):
            ext = ".mp4"
        import datetime

        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        name = f"merge_{ts}{ext}"
        dst = os.path.join(mat_dir, name)
        n = 1
        while os.path.exists(dst):
            name = f"merge_{ts}_{n}{ext}"
            dst = os.path.join(mat_dir, name)
            n += 1
        shutil.copy2(merged_path, dst)

        file_info = {"filename": name, "subfolder": "whatdreamscost", "type": "input"}
        payload = {"status": "add_material", "type": "video", "imageFile": file_info}
        if node_id is not None:
            payload["node_id"] = node_id
        PromptServer.instance.send_sync("minimax_ref_video_progress", payload)
        return web.json_response({"success": True, "name": f"whatdreamscost/{name}", "file": file_info})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


# 模块末尾尝试将惰性收集的路由注册到 PromptServer（正常 ComfyUI 启动时
# PromptServer.instance 此时已就绪）。若仍不可用，_pending 保留，等待
# __init__.py 末尾再次调用 _LazyRoutes.flush()。
_LazyRoutes.flush()


# 模块末尾尝试将惰性收集的路由注册到 PromptServer（正常 ComfyUI 启动时
# PromptServer.instance 此时已就绪）。若仍不可用，_pending 保留，等待
# __init__.py 末尾再次调用 _LazyRoutes.flush()。
_LazyRoutes.flush()
