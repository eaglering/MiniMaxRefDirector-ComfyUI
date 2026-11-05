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
from .lib import skill_db
from .lib.llm import list_llm_gguf_files

log = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
_SPA_HTML_PATH = os.path.join(_PROJECT_ROOT, "js", "spa", "index.html")

# --- skill 词库目录（本项目自带，deepseek 分镜导入用）---
# 优先级：环境变量 MINIMAX_REF_SKILL_LIBRARY > 项目内 resources/skills
_SKILL_LIBRARY_CANDIDATES = [
    os.environ.get("MINIMAX_REF_SKILL_LIBRARY", ""),
    os.path.join(_PROJECT_ROOT, "resources", "skills"),
]
_SKILL_LIBRARY_ROOT = next((p for p in _SKILL_LIBRARY_CANDIDATES if p and os.path.isdir(p)), "")

_SKILL_NAMES = (
    "story-design", "storyboard-design", "firstframe-design",
    "character-design", "audio-design",
)


def _resolve_skill_dir(name: str) -> str:
    """按白名单校验 skill 名并返回其目录，防止路径穿越。"""
    if not name or name not in _SKILL_NAMES:
        raise ValueError(f"未知 skill：{name or '(空)'}，可用：{', '.join(_SKILL_NAMES)}")
    if not _SKILL_LIBRARY_ROOT:
        raise ValueError(
            "skill 词库目录不存在：请确认 custom_nodes/MiniMaxRefDirector-ComfyUI/resources/skills，"
            "或设置环境变量 MINIMAX_REF_SKILL_LIBRARY 指向词库目录"
        )
    d = os.path.join(_SKILL_LIBRARY_ROOT, name)
    if not os.path.isdir(d):
        raise ValueError(f"skill 目录缺失：{d}")
    return d


async def _read_json_body(request: web.Request) -> dict:
    """读取 JSON 请求体。空 body / 非法 JSON / 非对象一律返回 {}

    页面刷新或关闭时，浏览器会中断在途的保存请求，服务端会收到只有
    头没有 body 的 POST——直接 400 干净返回，不打 traceback 吓人。
    """
    try:
        body = await request.read()
    except Exception:
        return {}
    if not body:
        return {}
    try:
        data = json.loads(body)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


@_routes.get(f"{API_PREFIX}/spa/skill_library")
async def spa_skill_library(request: web.Request) -> web.Response:
    """skill 词库：无 name 时返回清单；有 name 时返回该 skill 的 prompt.md 全文。"""
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
        # {{skill_keys}}：镜头技能词典的 key 清单（SQLite 查询注入；无占位符则不处理）
        if "{{skill_keys}}" in prompt_md:
            try:
                prompt_md = prompt_md.replace("{{skill_keys}}", skill_db.skill_keys_text())
            except Exception:
                log.warning("[SPA] skill_keys 注入失败", exc_info=True)
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
        data = await _read_json_body(request)
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
        data = await _read_json_body(request)
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


# ---------------- 镜头技能词典（SQLite）----------------

@_routes.get(f"{API_PREFIX}/spa/skill_dict")
async def spa_skill_dict(request: web.Request) -> web.Response:
    """技能词典全量：{ categories, skills, skillKeysText }（首次访问自动建库+种子迁移）。"""
    try:
        return web.json_response({"success": True, **skill_db.skill_dict_snapshot()})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


def _skill_dict_mutation(handler):
    """写操作统一包装：ValueError → 400，其余 → 500。"""
    async def _inner(request: web.Request) -> web.Response:
        try:
            data = await _read_json_body(request)
            result = handler(data)
            return web.json_response({"success": True, **(result or {})})
        except ValueError as e:
            return web.json_response({"success": False, "error": str(e)}, status=400)
        except Exception as e:
            traceback.print_exc()
            return web.json_response({"success": False, "error": str(e)}, status=500)
    return _inner


@_routes.post(f"{API_PREFIX}/spa/skill_dict/add")
async def spa_skill_add(request: web.Request) -> web.Response:
    # 新增技能必填：类别 / 名称 / 描述 / 触发词 / 案例（prompt 可选，默认取描述）
    return _skill_dict_mutation(lambda d: skill_db.add_skill(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skill_dict/update")
async def spa_skill_update(request: web.Request) -> web.Response:
    return _skill_dict_mutation(lambda d: skill_db.update_skill(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skill_dict/delete")
async def spa_skill_delete(request: web.Request) -> web.Response:
    return _skill_dict_mutation(lambda d: skill_db.delete_skill(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skill_dict/category/add")
async def spa_skill_category_add(request: web.Request) -> web.Response:
    return _skill_dict_mutation(lambda d: skill_db.add_category(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skills")
async def spa_save_skills(request: web.Request) -> web.Response:
    try:
        data = await _read_json_body(request)
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
        data = await _read_json_body(request)
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
