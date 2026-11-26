"""SPA 导演台服务端路由（挂载于 /minimax_ref/api/spa/*）。

- POST /spa/push          入口节点打开页面前推送初始状态（不通知）
- GET  /spa/state         读取某导演节点暂存状态
- POST /spa/save          SPA 保存：落盘 + send_sync 通知 ComfyUI 页面回写 widget
- GET  /spa/skill_dict    技能词典（类别含 render_mode）
- GET  /spa/skill_docs    技能文档列表（md 提示词模板，按分类过滤）
- GET  /spa/skill_doc     单篇技能文档全文（id 或内置 key，缺失回落文件库）
- POST /spa/skill_docs/add|update|delete  技能文档增删改
- POST /spa/skill_notes   技能选择 → skill_notes 渲染（服务端与桥接共用）
- GET  /spa/llm_files     models/llm 下 GGUF / mmproj 文件列表
- GET  /spa/records       视频生成记录列表
- POST /spa/records/delete 删除记录
- GET  /spa/page          单文件 SPA HTML 兜底入口（静态路由受限时使用）

复用 server.py 的 _LazyRoutes 惰性注册机制。
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import sys
import traceback

from aiohttp import web

import folder_paths

from .server import API_PREFIX, _routes
from .lib import records as records_lib
from .lib import skill_notes
from .lib import spa_store
from .lib import skill_db
from .lib import webchat_cdp
from .lib.llm import list_llm_gguf_files

log = logging.getLogger(__name__)

# 兜底注册：ComfyUI 以文件路径形式加载本节点包（模块名含反斜杠），个别加载
# 路径下外壳可能未按 __name__ 注册进 sys.modules（或键指向旧副本），热重载时
# importlib.reload 会报 "module ... not in sys.modules"。幂等：键已存在且
# 对象一致时不覆盖。
if sys.modules.get(webchat_cdp.__name__) is not webchat_cdp:
    sys.modules[webchat_cdp.__name__] = webchat_cdp

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


def _send_spa_exec(action: str) -> None:
    """send_sync 通知 ComfyUI 页面执行运行/取消动作（SPA 页右上角按钮）。"""
    try:
        from server import PromptServer
    except ImportError:
        from comfy_api.latest import server as _comfy_server
        PromptServer = _comfy_server.PromptServer
    try:
        PromptServer.instance.send_sync(
            "minimax_ref_spa_exec",
            {"action": action},
        )
    except Exception:
        log.warning("[SPA] send_sync minimax_ref_spa_exec failed", exc_info=True)


@_routes.post(f"{API_PREFIX}/spa/exec")
async def spa_exec(request: web.Request) -> web.Response:
    """SPA 页「运行 / 取消」→ send_sync 转发到 ComfyUI 页面执行。

    run: ComfyUI 页面调 app.queuePrompt（与工作流页面运行按钮效果一致）；
    cancel: ComfyUI 页面 POST /interrupt 中断当前执行。
    前置条件：ComfyUI 工作流页面处于打开状态（SPA 页是独立标签页，无法直接
    访问图结构，指令经页面内的 spa-node.js 落地）。
    """
    try:
        data = await _read_json_body(request)
        action = str(data.get("action") or "").strip()
        if action not in ("run", "cancel"):
            return web.json_response(
                {"success": False, "error": "action 必须是 run 或 cancel"}, status=400)
        _send_spa_exec(action)
        return web.json_response({"success": True, "action": action})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


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
    """SPA 保存：落盘 + send_sync 通知 ComfyUI 页面按 node_id 回写 widget。

    mirror_node_id（可选，SPA 节点自身编号）：保存目标为旧导演节点时，把同一份
    状态额外落盘到该编号下，保证工作流由 SPA 节点执行时磁盘兜底可取。
    """
    try:
        data = await _read_json_body(request)
        node_id = str(data.get("node_id") or "")
        state = data.get("state") or {}
        mirror_node_id = str(data.get("mirror_node_id") or "")
        if not node_id:
            return web.json_response({"success": False, "error": "node_id is required"}, status=400)
        saved = spa_store.save_state(node_id, state)
        if mirror_node_id and mirror_node_id != node_id:
            try:
                spa_store.save_state(mirror_node_id, {**saved, "node_id": mirror_node_id})
            except Exception:
                log.warning("[SPA] mirror save to %s failed", mirror_node_id, exc_info=True)
        _send_spa_state(node_id, saved)
        return web.json_response({"success": True, "state": saved})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


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
    # 新增技能：类别 / 名称必填；字段要求按类别注入方式 render_mode 校验
    # （见 lib/skill_db.py _RENDER_MODE_RULES）
    return await _skill_dict_mutation(lambda d: skill_db.add_skill(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skill_dict/update")
async def spa_skill_update(request: web.Request) -> web.Response:
    return await _skill_dict_mutation(lambda d: skill_db.update_skill(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skill_dict/delete")
async def spa_skill_delete(request: web.Request) -> web.Response:
    return await _skill_dict_mutation(lambda d: skill_db.delete_skill(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skill_dict/category/add")
async def spa_skill_category_add(request: web.Request) -> web.Response:
    # {name, renderMode: term|example|descriptive|block, description?, sort?}
    return await _skill_dict_mutation(lambda d: skill_db.add_category(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skill_dict/category/update")
async def spa_skill_category_update(request: web.Request) -> web.Response:
    # {id, name?, description?, renderMode?, sort?}
    return await _skill_dict_mutation(lambda d: skill_db.update_category(d))(request)


# ---------------- 技能文档（md 提示词模板，SQLite skill_docs 表）----------------


@_routes.get(f"{API_PREFIX}/spa/skill_docs")
async def spa_skill_docs(request: web.Request) -> web.Response:
    """技能文档列表：?category=主体设计 过滤；不带参数返回全部 + 各类计数。

    列表不返回正文（只回 summary），单文档按需再取全文，避免一次拉全量 md。
    """
    try:
        category = (request.query.get("category") or "").strip()
        return web.json_response({"success": True, **skill_db.list_docs(category)})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.get(f"{API_PREFIX}/spa/skill_doc")
async def spa_skill_doc(request: web.Request) -> web.Response:
    """单篇技能文档全文：?id= 或 ?key=（内置 key，如 storyboard-design）。

    key 在库中不存在时回落 resources/skills/<key>/prompt.md（导入流水线不断链）。
    """
    try:
        doc_id = int(request.query.get("id") or 0)
        key = (request.query.get("key") or "").strip()
        return web.json_response({"success": True, "doc": skill_db.get_doc(doc_id, key)})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.post(f"{API_PREFIX}/spa/skill_docs/add")
async def spa_skill_doc_add(request: web.Request) -> web.Response:
    # {category, title, content?}：分类固定四类，同分类标题唯一
    return await _skill_dict_mutation(lambda d: skill_db.add_doc(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skill_docs/update")
async def spa_skill_doc_update(request: web.Request) -> web.Response:
    # {id, category?, title?, content?}
    return await _skill_dict_mutation(lambda d: skill_db.update_doc(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skill_docs/delete")
async def spa_skill_doc_delete(request: web.Request) -> web.Response:
    return await _skill_dict_mutation(lambda d: skill_db.delete_doc(d))(request)


@_routes.post(f"{API_PREFIX}/spa/skill_notes")
async def spa_skill_notes(request: web.Request) -> web.Response:
    """把分镜选择的技能渲染成 skill_notes（服务端与三种网页桥接共用同一实现）。

    body: {selections: {类别名: [技能 key]}, lang?: "zh"|"en"}
    返回 {success, notes, protected, glossary, warnings}
    """
    try:
        data = await _read_json_body(request)
        selections = data.get("selections")
        if isinstance(data.get("skills"), dict) and selections is None:
            selections = data.get("skills")
        lang = str(data.get("lang") or "zh").lower()
        result = skill_notes.render_skill_notes(selections or {}, lang="en" if lang == "en" else "zh")
        return web.json_response({"success": True, **result})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ---------------- 网页会话 CDP 通道（Playwright 附加真实 Chrome）----------------
# 替代浏览器扩展桥接：SPA 的 H3 生成 / 分镜导入直接调这些端点，
# 后端 lib/webchat_cdp.py 经 CDP 驱动用户真实 Chrome（:9222）完成生成与回读。


def _cdp_endpoint_from(data: dict) -> str:
    return str((data or {}).get("cdp_endpoint") or "").strip()


@_routes.post(f"{API_PREFIX}/spa/webchat/complete")
async def spa_webchat_complete(request: web.Request) -> web.Response:
    """在指定站点网页会话内完成一次生成。

    body: {site: deepseek|doubao|qwen, system?, prompt, expectJson?, sessionMode?:
           "new"|"reuse", chatId?, cdpEndpoint?, timeoutMs?}
    返回 {success, ok, text, chatId, error}
    """
    try:
        data = await _read_json_body(request)
        site = str(data.get("site") or data.get("proxy_site") or "deepseek")
        prompt = str(data.get("prompt") or "")
        system = str(data.get("system") or "")
        expect_json = bool(data.get("expect_json") or data.get("expectJson"))
        session_mode = str(data.get("session_mode") or data.get("sessionMode") or "new")
        chat_id = str(data.get("chat_id") or data.get("chatId") or "")
        timeout_s = float(data.get("timeout_ms") or data.get("timeoutMs") or 300_000) / 1000.0
        # complete() 是同步阻塞实现（内部等待分钟级网页生成，含风控冷却重试）。
        # 必须放进线程执行器：直接在 async 处理器里调用会把 ComfyUI 事件循环
        # 整个冻住——批量 H3 后段浏览器收到 ERR_EMPTY_RESPONSE（连接无响应被掐断）
        # 的根因就是这个。
        result = await asyncio.get_running_loop().run_in_executor(
            None,
            functools.partial(
                webchat_cdp.complete,
                system=system, prompt=prompt, expect_json=expect_json,
                timeout_s=min(max(timeout_s, 30.0), 600.0), site=site,
                session_mode="reuse" if session_mode == "reuse" else "new",
                chat_id=chat_id, cdp_endpoint=_cdp_endpoint_from(data),
            ),
        )
        return web.json_response({
            "success": True, "ok": bool(result.get("ok")),
            "text": str(result.get("text") or ""),
            "chatId": str(result.get("chat_id") or ""),
            "error": str(result.get("error") or ""),
        })
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.post(f"{API_PREFIX}/spa/webchat/last_reply")
async def spa_webchat_last_reply(request: web.Request) -> web.Response:
    """读取指定会话最后一条助手回复（不发送任何消息；风控失败后的补救拉取）。

    body: {site, chatId?, cdpEndpoint?}
    返回 {success, ok, text, error}
    """
    try:
        data = await _read_json_body(request)
        result = await asyncio.get_running_loop().run_in_executor(
            None,
            functools.partial(
                webchat_cdp.fetch_last_reply,
                site=str(data.get("site") or data.get("proxy_site") or "deepseek"),
                chat_id=str(data.get("chat_id") or data.get("chatId") or ""),
                cdp_endpoint=_cdp_endpoint_from(data),
                timeout_s=90.0,
            ),
        )
        return web.json_response({
            "success": True, "ok": bool(result.get("ok")),
            "text": str(result.get("text") or ""),
            "error": str(result.get("error") or ""),
        })
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.get(f"{API_PREFIX}/spa/webchat/sessions")
async def spa_webchat_sessions(request: web.Request) -> web.Response:
    """列出指定站点的网页会话（DeepSeek 站内 API；豆包/千问 UI 扫描侧栏）。

    query: site=deepseek|doubao|qwen, cdpEndpoint?
    返回 {success, sessions: [{id, title, updatedAt}]}
    """
    try:
        site = str(request.query.get("site") or "deepseek")
        sessions = webchat_cdp.list_sessions(
            site=site, cdp_endpoint=str(request.query.get("cdpEndpoint") or "").strip()
        )
        return web.json_response({"success": True, "sessions": sessions})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.post(f"{API_PREFIX}/spa/webchat/session/delete")
async def spa_webchat_session_delete(request: web.Request) -> web.Response:
    """删除整个会话（仅 DeepSeek 站内 API 支持；豆包/千问返回明确错误）。"""
    try:
        data = await _read_json_body(request)
        site = str(data.get("site") or "deepseek")
        chat_id = str(data.get("chat_id") or data.get("chatId") or "")
        webchat_cdp.delete_session(
            site=site, chat_id=chat_id, cdp_endpoint=_cdp_endpoint_from(data)
        )
        return web.json_response({"success": True, "chatId": chat_id})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.get(f"{API_PREFIX}/spa/webchat/diag")
async def spa_webchat_diag(request: web.Request) -> web.Response:
    """页面自检：CDP 连接状态 + 三站标签页/输入框/发送按钮/回复区探针。"""
    try:
        result = webchat_cdp.diag(
            cdp_endpoint=str(request.query.get("cdpEndpoint") or "").strip()
        )
        return web.json_response({"success": True, **result})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.post(f"{API_PREFIX}/spa/webchat/cancel")
async def spa_webchat_cancel(request: web.Request) -> web.Response:
    """取消进行中的网页会话任务（complete 在下一轮询点返回「已取消」）。"""
    cancelled = webchat_cdp.cancel()
    return web.json_response({"success": True, "cancelled": bool(cancelled)})


@_routes.get(f"{API_PREFIX}/spa/webchat/status")
async def spa_webchat_status(request: web.Request) -> web.Response:
    """轻量连接测试（设置面板「测试连接」按钮）：CDP 端口是否可达。"""
    try:
        endpoint = str(request.query.get("cdpEndpoint") or "").strip()
        result = webchat_cdp.status(cdp_endpoint=endpoint)
        if not result.get("connected"):
            # 未连接时尝试真实连接一次，给出可操作的错误提示
            mgr_probe = webchat_cdp.diag(cdp_endpoint=endpoint, timeout_s=30.0)
            result["error"] = mgr_probe.get("error") or ""
        return web.json_response({"success": True, **result})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.get(f"{API_PREFIX}/spa/webchat/browsers")
async def spa_webchat_browsers(request: web.Request) -> web.Response:
    """探测本机可用浏览器（设置面板「浏览器」下拉框数据源）。"""
    try:
        return web.json_response({"success": True, **webchat_cdp.find_browsers()})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.post(f"{API_PREFIX}/spa/webchat/launch")
async def spa_webchat_launch(request: web.Request) -> web.Response:
    """一键启动调试浏览器并打开桥接站点网页（幂等，可重复点击）。

    body: {browser?: chrome|edge|brave|chromium, browser_path?, site?, cdpEndpoint?}
    用户目录固定为项目 userdata/browser（独立于浏览器默认 profile）。
    返回 {success, launched, connected, endpoint, profileDir, error?}
    """
    try:
        data = await _read_json_body(request)
        site = str(data.get("site") or "").strip()
        urls = []
        if site:
            sid = webchat_cdp.normalize_site(site)
            urls.append(webchat_cdp.SITES[sid]["home"])
        result = webchat_cdp.launch_browser(
            browser=str(data.get("browser") or ""),
            browser_path=str(data.get("browser_path") or data.get("browserPath") or ""),
            urls=urls,
            cdp_endpoint=_cdp_endpoint_from(data),
        )
        return web.json_response({"success": True, **result})
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@_routes.post(f"{API_PREFIX}/spa/webchat/reload")
async def spa_webchat_reload(request: web.Request) -> web.Response:
    """热重载网页会话驱动（开发用，免重启 ComfyUI）。

    依次重载 lib/webchat_cdp_driver 包内模块（shared / pagescripts / base /
    deepseek / doubao / qwen）并原地重建驱动注册表，随后原地重载 webchat_cdp
    外壳（SITES 配置 / 同步 API / 提示文案，importlib.reload 原地生效，路由内
    `webchat_cdp.xxx` 调用自动指向新实现）。

    注意：外壳重载会重置管理器单例（旧 Playwright 连接与事件循环线程废弃，
    新任务用新连接）；进行中的网页任务在旧实例上跑完不受影响。
    SPA 前端改动仍需 `npm run build` + 浏览器强制刷新（Ctrl+F5）。

    调用方式（SPA 页面 DevTools 控制台）：
      fetch("/minimax_ref/api/spa/webchat/reload", {method: "POST"}).then(r => r.json())
    """
    reloaded: list = []
    shell_note = ""
    try:
        reloaded += webchat_cdp.reload_drivers()
        import sys
        import importlib
        # ComfyUI 以文件路径形式加载本节点包（模块名含反斜杠），个别加载路径下
        # 外壳可能未按 __name__ 注册进 sys.modules（或键指向旧副本），直接 reload
        # 会报 "module ... not in sys.modules"。先兜底注册为当前持有对象再重载。
        _key = getattr(webchat_cdp, "__name__", "")
        if _key and sys.modules.get(_key) is not webchat_cdp:
            sys.modules[_key] = webchat_cdp
        try:
            importlib.reload(webchat_cdp)  # 原地重载外壳（模块对象身份不变）
            shell_note = "reloaded"
        except Exception as shell_err:
            # 外壳重载失败不影响驱动/页面 JS 热重载（上面已完成）；如实上报
            traceback.print_exc()
            shell_note = f"skipped: {shell_err}"
        return web.json_response(
            {"success": True, "reloaded": reloaded, "facade": webchat_cdp.__name__, "shell": shell_note}
        )
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "reloaded": reloaded, "error": str(e)}, status=500)


@_routes.post(f"{API_PREFIX}/spa/skill_dict/batch_add")
async def spa_skill_batch_add(request: web.Request) -> web.Response:
    # 批量导入技能词条：{categoryId?, newCategory?, items:[{name, nameEn?, desc?, guide?, examples?}]}
    return await _skill_dict_mutation(lambda d: skill_db.batch_add_skills(d))(request)


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
        removed = records_lib.delete_records(
            data.get("ids") or [], delete_files=bool(data.get("delete_files")))
        return web.json_response({"success": True, "removed": removed})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


_VIDEO_UPLOAD_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}


@_routes.post(f"{API_PREFIX}/spa/records/upload_video")
async def spa_records_upload_video(request: web.Request) -> web.Response:
    """上传视频并登记为生成记录（SPA「视频生成记录」页拖拽/手动上传入口）。

    multipart 表单：{file: <视频文件>}。存入 input/whatdreamscost/（与合并
    产物同目录，可直接预览、可再参与合并）；元信息（时长/分辨率/fps）尽力
    通过 ffprobe 探测，失败不阻断登记。
    """
    import datetime

    try:
        reader = await request.multipart()
        if reader is None:
            return web.json_response(
                {"success": False, "error": "需要 multipart/form-data 表单"}, status=400)
        field = None
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "file":
                field = part
                break
        if field is None or not field.filename:
            return web.json_response(
                {"success": False, "error": "缺少 file 字段"}, status=400)
        ext = os.path.splitext(field.filename)[1].lower()
        if ext not in _VIDEO_UPLOAD_EXTS:
            return web.json_response(
                {"success": False,
                 "error": f"不支持的文件类型「{ext or '(无后缀)'}」；支持 mp4/mov/mkv/webm/avi/m4v"},
                status=400)

        data = bytearray()
        while True:
            chunk = await field.read_chunk(1024 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 2 * 1024 * 1024 * 1024:
                return web.json_response(
                    {"success": False, "error": "文件超过 2GB 上限"}, status=413)
        if not data:
            return web.json_response({"success": False, "error": "空文件"}, status=400)

        mat_dir = os.path.join(folder_paths.get_input_directory(), "whatdreamscost")
        os.makedirs(mat_dir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(field.filename))[0][:80] or "video"
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        name = f"upload_{ts}_{stem}{ext}"
        dst = os.path.join(mat_dir, name)
        n = 1
        while os.path.exists(dst):
            name = f"upload_{ts}_{n}_{stem}{ext}"
            dst = os.path.join(mat_dir, name)
            n += 1
        with open(dst, "wb") as f:
            f.write(bytes(data))

        # 尽力探测元信息（时长/分辨率/fps），失败仅留空字段
        fps = width = height = duration_frames = None
        try:
            from .lib.video import ffprobe_info

            info = ffprobe_info(dst) or {}
            fps = info.get("fps")
            width = info.get("width")
            height = info.get("height")
            duration_frames = info.get("frame_count")
        except Exception:
            pass

        file_info = {"filename": name, "subfolder": "whatdreamscost", "type": "input"}
        rec = records_lib.append_record(records_lib.build_record(
            "upload", file_info,
            fps=float(fps) if fps else None,
            width=width, height=height,
            duration_frames=int(duration_frames) if duration_frames else None,
            size=len(data),
        ))
        return web.json_response({"success": True, "record": rec})
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
