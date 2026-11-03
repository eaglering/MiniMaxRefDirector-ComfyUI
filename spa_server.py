"""SPA 导演台服务端路由（挂载于 /minimax_ref/api/spa/*）。

- POST /spa/push          入口节点打开页面前推送初始状态（不通知）
- GET  /spa/state         读取某导演节点暂存状态
- POST /spa/save          SPA 保存：落盘 + send_sync 通知 ComfyUI 页面回写 widget
- GET/POST /spa/skills    自定义 skill 词条读写
- GET  /spa/llm_files     models/llm 下 GGUF / mmproj 文件列表
- GET  /spa/records       视频生成记录列表
- POST /spa/records/delete 删除记录
- GET  /spa/page          单文件 SPA HTML 兜底入口（静态路由受限时使用）

复用 server.py 的 _LazyRoutes 惰性注册机制。
"""

from __future__ import annotations

import logging
import os
import traceback

from aiohttp import web

from .server import API_PREFIX, _routes
from .lib import records as records_lib
from .lib import spa_store
from .lib.llm import list_llm_gguf_files

log = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
_SPA_HTML_PATH = os.path.join(_PROJECT_ROOT, "js", "spa", "index.html")


def _send_spa_state(node_id: str, state: dict) -> None:
    """send_sync 通知 ComfyUI 页面：该节点的 widget 需要回写。失败仅告警。"""
    try:
        from server import PromptServer
    except ImportError:
        from comfy_api.latest import server as _comfy_server
        PromptServer = _comfy_server.PromptServer
    try:
        PromptServer.instance.send_sync(
            "minimax_ref_spa_state",
            {"node_id": str(node_id), "state": state},
        )
    except Exception:
        log.warning("[SPA] send_sync minimax_ref_spa_state failed", exc_info=True)


@_routes.post(f"{API_PREFIX}/spa/push")
async def spa_push(request: web.Request) -> web.Response:
    """入口节点打开页面前推送初始状态（仅落盘，不通知回写）。"""
    try:
        data = await request.json()
        node_id = str(data.get("node_id") or "")
        state = data.get("state") or {}
        if not node_id:
            return web.json_response({"success": False, "error": "node_id is required"}, status=400)
        saved = spa_store.save_state(node_id, state)
        return web.json_response({"success": True, "state": saved})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.get(f"{API_PREFIX}/spa/state")
async def spa_get_state(request: web.Request) -> web.Response:
    try:
        node_id = request.query.get("node_id") or ""
        if not node_id:
            return web.json_response({"success": False, "error": "node_id is required"}, status=400)
        state = spa_store.load_state(node_id)
        return web.json_response({"success": True, "state": state})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.post(f"{API_PREFIX}/spa/save")
async def spa_save(request: web.Request) -> web.Response:
    """SPA 保存：落盘 + send_sync 通知 ComfyUI 页面按 node_id 回写 widget。"""
    try:
        data = await request.json()
        node_id = str(data.get("node_id") or "")
        state = data.get("state") or {}
        if not node_id:
            return web.json_response({"success": False, "error": "node_id is required"}, status=400)
        saved = spa_store.save_state(node_id, state)
        _send_spa_state(node_id, saved)
        return web.json_response({"success": True, "state": saved})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.get(f"{API_PREFIX}/spa/skills")
async def spa_get_skills(request: web.Request) -> web.Response:
    return web.json_response({"success": True, "skills": spa_store.load_skills()})


@_routes.post(f"{API_PREFIX}/spa/skills")
async def spa_save_skills(request: web.Request) -> web.Response:
    try:
        data = await request.json()
        cleaned = spa_store.save_skills(data.get("skills") or {})
        return web.json_response({"success": True, "skills": cleaned})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.get(f"{API_PREFIX}/spa/llm_files")
async def spa_llm_files(request: web.Request) -> web.Response:
    """models/llm 下 GGUF 文件列表，拆分为普通模型与 mmproj（视觉投影器）。"""
    try:
        ggufs = list_llm_gguf_files()
        mmprojs = [f for f in ggufs if "mmproj" in f.lower()]
        models = [f for f in ggufs if f not in mmprojs]
        return web.json_response({"success": True, "gguf": models, "mmproj": mmprojs})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.get(f"{API_PREFIX}/spa/records")
async def spa_records(request: web.Request) -> web.Response:
    try:
        limit = int(request.query.get("limit") or 200)
        offset = int(request.query.get("offset") or 0)
        return web.json_response({"success": True, "records": records_lib.list_records(limit, offset)})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.post(f"{API_PREFIX}/spa/records/delete")
async def spa_records_delete(request: web.Request) -> web.Response:
    try:
        data = await request.json()
        removed = records_lib.delete_records(data.get("ids") or [])
        return web.json_response({"success": True, "removed": removed})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.get(f"{API_PREFIX}/spa/page")
async def spa_page(request: web.Request) -> web.Response:
    """单文件 SPA HTML 兜底入口：/extensions/ 静态路由受限的 ComfyUI 版本用此路由。"""
    try:
        with open(_SPA_HTML_PATH, "r", encoding="utf-8") as f:
            html = f.read()
        return web.Response(
            text=html,
            content_type="text/html",
            charset="utf-8",
            headers={"Cache-Control": "no-store"},
        )
    except FileNotFoundError:
        return web.json_response(
            {"success": False,
             "error": "SPA 页面尚未构建：请在 spa/ 目录执行 npm install && npm run build 生成 js/spa/index.html"},
            status=404,
        )
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


from .server import _LazyRoutes  # noqa: E402
_LazyRoutes.flush()
