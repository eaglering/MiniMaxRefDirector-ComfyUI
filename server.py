"""MiniMaxRefDirector server routes for the Settings API config panel."""

from __future__ import annotations

import traceback

from aiohttp import web
from .lib.prompt import generate_h3_prompt, image_analysis
from server import PromptServer

from .api_config import api_config_manager

API_PREFIX = "/minimax_ref/api"


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
async def unload_llama_models(request: web.Request) -> web.Response:
    """Unload all cached local GGUF (llama-cpp) models to free RAM/VRAM.

    Lazy import keeps this module import-order agnostic (avoids cycles with
    minimax_ref_prompt_enhance which imports comfy modules).
    """
    try:
        from .minimax_ref_prompt_enhance import _unload_llama_models as _unload

        _unload()
        return web.json_response({"success": True, "unloaded": True})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post(f"{API_PREFIX}/llm/generate_image_analysis")
async def generate_image_analysis(request: web.Request) -> web.Response:
    try:
        data = await request.json()
        image_path = data.get("image_path", "")
        prompt = data.get("prompt", "")
        gguf_path = data.get("gguf_path", "")
        mmproj_path = data.get("mmproj_path", "")
        seed = data.get("seed", 42)
        if not prompt:
            return web.json_response({"success": False, "error": "prompt is required"}, status=400)
        if not gguf_path:
            return web.json_response({"success": False, "error": "gguf_path is required"}, status=400)
        if not mmproj_path:
            return web.json_response({"success": False, "error": "mmproj_path is required"}, status=400)
        prompt_data = image_analysis(gguf_path, mmproj_path, prompt, image_path, seed)
        return web.json_response({"success": True, "prompt_data": prompt_data})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post(f"{API_PREFIX}/llm/generate_prompt_json")
async def generate_prompt_json(request: web.Request) -> web.Response:
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
        if options["vlm_mode"] == "llama-cpp":
            if not options["gguf_path"]:
                return web.json_response({"success": False, "error": "gguf_path is required"}, status=400)
            if not options["mmproj_path"]:
                return web.json_response({"success": False, "error": "mmproj_path is required"}, status=400)
        elif options["vlm_mode"] == "api":
            if not options["provider"]:
                return web.json_response({"success": False, "error": "provider is required"}, status=400)
            if not options["api_key"]:
                return web.json_response({"success": False, "error": "api_key is required"}, status=400)
        json_data = generate_h3_prompt(prompt=prompt, image_path=image_path, seed=seed, 
                                       vlm_mode=vlm_mode, options=options)
        return web.json_response({"success": True, "json_data": json_data})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)