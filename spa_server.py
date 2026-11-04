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

import json
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

# --- FastDirector-Desktop skill 词库目录（deepseek 分镜导入用）---
# 优先级：环境变量 MINIMAX_REF_SKILL_LIBRARY > custom_nodes 下的同仓目录 > 绝对路径兜底
_SKILL_LIBRARY_CANDIDATES = [
    os.environ.get("MINIMAX_REF_SKILL_LIBRARY", ""),
    os.path.join(_PROJECT_ROOT, "..", "ComfyUI-FastDirector-Desktop", "resources", "skills"),
    r"D:\workspace\ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-FastDirector-Desktop\resources\skills",
]
_SKILL_LIBRARY_ROOT = next((p for p in _SKILL_LIBRARY_CANDIDATES if p and os.path.isdir(p)), "")

_SKILL_NAMES = (
    "story-design", "storyboard-design", "h3-prompt-convert",
    "character-design", "scene-design", "audio-design",
)


def _resolve_skill_dir(name: str) -> str:
    """按白名单校验 skill 名并返回其目录，防止路径穿越。"""
    if not name or name not in _SKILL_NAMES:
        raise ValueError(f"未知 skill：{name or '(空)'}，可用：{', '.join(_SKILL_NAMES)}")
    if not _SKILL_LIBRARY_ROOT:
        raise ValueError(
            "skill 词库目录不存在：请安装 ComfyUI-FastDirector-Desktop，"
            "或设置环境变量 MINIMAX_REF_SKILL_LIBRARY 指向其 resources/skills 目录"
        )
    d = os.path.join(_SKILL_LIBRARY_ROOT, name)
    if not os.path.isdir(d):
        raise ValueError(f"skill 目录缺失：{d}")
    return d


@_routes.get(f"{API_PREFIX}/spa/skill_library")
async def spa_skill_library(request: web.Request) -> web.Response:
    """FastDirector-Desktop skills 词库：无 name 时返回清单；有 name 时返回 prompt.md 全文。"""
    try:
        name = (request.query.get("name") or "").strip()
        if not name:
            skills = []
            if _SKILL_LIBRARY_ROOT:
                for n in _SKILL_NAMES:
                    try:
                        d = _resolve_skill_dir(n)
                        meta = {}
                        meta_path = os.path.join(d, "skill.json")
                        if os.path.isfile(meta_path):
                            with open(meta_path, "r", encoding="utf-8-sig") as f:
                                meta = json.load(f) or {}
                        skills.append({
                            "name": n,
                            "description": meta.get("description") or meta.get("title") or "",
                        })
                    except ValueError:
                        skills.append({"name": n, "description": "", "missing": True})
            return web.json_response({
                "success": True,
                "root": _SKILL_LIBRARY_ROOT,
                "skills": skills,
            })
        d = _resolve_skill_dir(name)
        prompt_path = os.path.join(d, "prompt.md")
        if not os.path.isfile(prompt_path):
            return web.json_response(
                {"success": False, "error": f"skill 缺少 prompt.md：{prompt_path}"}, status=404)
        with open(prompt_path, "r", encoding="utf-8-sig") as f:
            prompt_md = f.read()
        return web.json_response({"success": True, "name": name, "prompt": prompt_md})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


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
