"""MiniMaxRefDirector server routes for the Settings API config panel."""

from __future__ import annotations

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


@PromptServer.instance.routes.get(f"{API_PREFIX}/config")
async def get_api_config(request: web.Request) -> web.Response:
    """Return the full API configuration (API keys are returned as-is to the owner)."""
    try:
        config = api_config_manager.load_config()
        return web.json_response({"success": True, "config": config})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post(f"{API_PREFIX}/config")
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


@PromptServer.instance.routes.post(f"{API_PREFIX}/llm/unload")
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

@PromptServer.instance.routes.post(f"{API_PREFIX}/llm/generate_image_analysis")
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

@PromptServer.instance.routes.post(f"{API_PREFIX}/llm/generate_prompt_json")
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


@PromptServer.instance.routes.post(f"{API_PREFIX}/h3/build_subject_bindings")
async def build_subject_bindings_api(request: web.Request) -> web.Response:
    """构建 H3 主体绑定（subject_definition / retention_analysis
    + images / audios / videos），替代前端 buildFirstFramePayload 中的组装逻辑。"""
    try:
        from .lib.prompt import build_h3_subject_bindings
        data = await request.json()
        subject_data = data.get("subject_data", {}) or {}
        prompt_json = data.get("prompt_json", {}) or {}
        if isinstance(prompt_json, str):
            try:
                prompt_json = json.loads(prompt_json)
            except (json.JSONDecodeError, TypeError):
                prompt_json = {}
        if not isinstance(prompt_json, dict):
            return web.json_response({"success": False, "error": "prompt_json must be an object"}, status=400)
        last_frame_path = data.get("last_frame_path", "") or ""
        timeline_segment = data.get("timeline_segment", None)
        result = build_h3_subject_bindings(
            subject_data,
            prompt_json,
            last_frame_path=last_frame_path,
            timeline_segment=timeline_segment,
        )
        return web.json_response({"success": True, "data": result})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)
