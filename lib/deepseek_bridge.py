"""DeepSeek proxy 浏览器扩展 —— ComfyUI 侧 WebSocket 桥接。

扩展后台 Service Worker 主动连接 `GET /minimax_ref/api/deepseek/bridge` 并注册；
本模块维护单连接注册表与 pending Future 表，向后端 LLM 链路提供同步友好的
``deepseek_complete()``：节点执行（executor 线程）经
``asyncio.run_coroutine_threadsafe`` 提交任务到 server 事件循环，再经 WS 下发给
扩展，等待扩展回传 ``{type:"llm_result", id, ok, text, error}``。

消息协议（与 extension/background.js 对应）：
- 扩展 → ComfyUI：``{type:"register", ext_version}``、``{type:"ping"}``、
  ``{type:"llm_result", id, ok, text, error}``
- ComfyUI → 扩展：``{type:"welcome"}``、``{type:"pong"}``、
  ``{type:"llm_task", id, payload:{system, prompt, expect_json}}``

注意：本模块被 lib/llm.py 顶层导入（server.py 又顶层导入 lib/llm.py），因此
**不能**在模块顶层 import 本包 server 模块（会触发循环导入 / 半初始化属性错误）；
路由注册通过 :func:`register_routes` 由 ``__init__.py`` 在导入完成后显式调用。
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from aiohttp import WSMsgType, web

log = logging.getLogger(__name__)

API_PREFIX = "/minimax_ref/api"  # 与 server.py 保持一致（避免顶层循环导入而本地定义）

DEFAULT_TIMEOUT_S = 290.0  # MV3 Service Worker 单请求存活上限内

_state: dict[str, Any] = {
    "ws": None,          # 当前扩展连接（web.WebSocketResponse）
    "loop": None,        # server 事件循环
    "send_lock": None,   # asyncio.Lock（同一连接上的串行发送）
    "pending": {},       # task_id → asyncio.Future
    "ext_version": "",
    "connected_at": 0.0,
    "last_active": 0.0,
}

_routes_registered = False

BRIDGE_PATH = f"{API_PREFIX}/deepseek/bridge"


# ComfyUI 的 origin_only_middleware（server.py create_origin_only_middleware）会把
# Host 与 Origin 域名不一致的请求一律 403 —— 浏览器扩展 Service Worker 的 WS 握手
# 携带 `Origin: chrome-extension://<id>`，必然命中该拦截。这里在中间件链最外层
# 对桥接路径提前接管：保留同等的跨站防护（拒绝 Sec-Fetch-Site: cross-site，
# 阻止任意网页直连桥接滥用 DeepSeek），但不做 Host/Origin 域名比对。
@web.middleware
async def _bridge_bypass_middleware(request: web.Request, handler):
    if request.path == BRIDGE_PATH:
        sfs = request.headers.get("Sec-Fetch-Site")
        if sfs == "cross-site":
            return web.Response(status=403)
        return await bridge_ws_handler(request)
    return await handler(request)


# ---------------- WS 端点 ----------------

async def bridge_ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=55, max_msg_size=0)
    await ws.prepare(request)

    loop = asyncio.get_running_loop()
    old = _state["ws"]
    if old is not None and not old.closed:
        try:
            await old.close(code=4000, message=b"replaced by a newer bridge connection")
        except Exception:
            pass
    import time as _time
    _state["ws"] = ws
    _state["loop"] = loop
    _state["send_lock"] = asyncio.Lock()
    _state["connected_at"] = _time.time()
    _state["last_active"] = _time.time()
    log.info("[DeepSeekBridge] 扩展已连接（等待 register）")

    import time as _time
    try:
        await _ws_send(ws, {"type": "welcome"})
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                _state["last_active"] = _time.time()
                await _handle_bridge_message(ws, msg.data)
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                break
    finally:
        if _state["ws"] is ws:
            _state["ws"] = None
            _state["send_lock"] = None
            _fail_all_pending("DeepSeek 桥接连接已断开")
        log.info("[DeepSeekBridge] 扩展连接关闭")
    return ws


async def _handle_bridge_message(ws: web.WebSocketResponse, raw: str) -> None:
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return
    if not isinstance(msg, dict) or not msg.get("type"):
        return

    mtype = msg.get("type")
    if mtype == "ping":
        await _ws_send(ws, {"type": "pong"})
    elif mtype == "register":
        _state["ext_version"] = str(msg.get("ext_version") or "")
        log.info("[DeepSeekBridge] 扩展注册完成，ext_version=%s", _state["ext_version"])
    elif mtype == "llm_result":
        task_id = str(msg.get("id") or "")
        fut = _state["pending"].get(task_id)
        if fut is not None and not fut.done():
            fut.set_result({
                "ok": bool(msg.get("ok")),
                "text": str(msg.get("text") or ""),
                "error": str(msg.get("error") or ""),
            })


async def _ws_send(ws: web.WebSocketResponse, obj: dict) -> None:
    lock = _state.get("send_lock")
    if lock is not None:
        async with lock:
            await ws.send_json(obj)
    else:
        await ws.send_json(obj)


def _fail_all_pending(error: str) -> None:
    for fut in _state["pending"].values():
        if not fut.done():
            fut.set_result({"ok": False, "text": "", "error": error})
    _state["pending"].clear()


def _is_connected() -> bool:
    ws = _state["ws"]
    return ws is not None and not ws.closed


# ---------------- 状态端点 ----------------

async def bridge_status_handler(request: web.Request) -> web.Response:
    import time as _time
    return web.json_response({
        "success": True,
        "connected": _is_connected(),
        "ext_version": _state["ext_version"],
        "pending_tasks": len(_state["pending"]),
        "connected_at": _state["connected_at"] and _state["connected_at"] or None,
        "last_active": _state["last_active"] or None,
        "now": _time.time(),
    })


# ---------------- 对外 API（供 LLM 链路调用） ----------------

async def deepseek_complete_async(
    system: str = "",
    prompt: str = "",
    expect_json: bool = False,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    site: str = "deepseek",
) -> dict:
    """在 server 事件循环上调用：经 WS 桥接让扩展在目标站点网页完成一次生成。

    site：桥接站点适配器（"deepseek" / "doubao" / "qwen"），扩展 background 按
    payload.site 分发到对应标签页与 DOM 自动化链路。
    """
    if not (system or "").strip() and not (prompt or "").strip():
        return {"ok": False, "text": "", "error": "prompt is empty"}
    if not _is_connected():
        return {
            "ok": False, "text": "",
            "error": "浏览器桥接未连接：请确认浏览器扩展（MiniMaxRefDirector Bridge）已启用并加载，"
                     "且 ComfyUI 地址在扩展可访问范围内（默认 ws://127.0.0.1:8188）",
        }

    task_id = uuid.uuid4().hex
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    _state["pending"][task_id] = fut
    try:
        await _ws_send(_state["ws"], {
            "type": "llm_task",
            "id": task_id,
            "payload": {
                "system": system or "", "prompt": prompt or "",
                "expect_json": bool(expect_json), "site": str(site or "deepseek"),
            },
        })
        return await asyncio.wait_for(fut, timeout=timeout_s)
    except asyncio.TimeoutError:
        return {"ok": False, "text": "", "error": f"浏览器桥接任务超时（{timeout_s:.0f}s，站点 {site}）"}
    except asyncio.CancelledError:
        raise
    except Exception as e:  # 连接中断等
        return {"ok": False, "text": "", "error": f"浏览器桥接异常：{e}"}
    finally:
        _state["pending"].pop(task_id, None)


def _resolve_server_loop() -> asyncio.AbstractEventLoop | None:
    loop = _state.get("loop")
    if loop is not None and not loop.is_closed():
        return loop
    try:
        from server import PromptServer  # ComfyUI 全局 server 模块
        ps = getattr(PromptServer, "instance", None)
        loop = getattr(ps, "loop", None)
        if loop is not None and not loop.is_closed():
            _state["loop"] = loop
            return loop
    except Exception:
        pass
    return None


def deepseek_complete(
    system: str = "",
    prompt: str = "",
    expect_json: bool = False,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    site: str = "deepseek",
) -> dict:
    """同步封装：节点执行线程（executor）调用，提交到 server 事件循环后阻塞等待。"""
    import concurrent.futures as cf

    loop = _resolve_server_loop()
    if loop is None:
        return {"ok": False, "text": "", "error": "浏览器桥接不可用：ComfyUI 事件循环未就绪"}
    cfut = asyncio.run_coroutine_threadsafe(
        deepseek_complete_async(system, prompt, expect_json, timeout_s, site), loop
    )
    try:
        return cfut.result(timeout=timeout_s + 30.0)
    except cf.TimeoutError:
        cfut.cancel()
        return {"ok": False, "text": "", "error": "浏览器桥接任务超时"}
    except Exception as e:
        return {"ok": False, "text": "", "error": f"浏览器桥接异常：{e}"}


def is_connected() -> bool:
    """同步查询桥接连接状态（任意线程可调）。"""
    return _is_connected()


# ---------------- 路由注册（由 __init__.py 显式调用，避免顶层循环导入） ----------------

def register_routes() -> None:
    global _routes_registered
    if _routes_registered:
        return
    try:
        from server import PromptServer
        ps = getattr(PromptServer, "instance", None)
        table = getattr(ps, "routes", None) if ps is not None else None
        if table is None:
            log.info("[DeepSeekBridge] PromptServer 尚未就绪，路由保持待注册")
            return
        table.get(BRIDGE_PATH)(bridge_ws_handler)
        table.get(f"{API_PREFIX}/deepseek/status")(bridge_status_handler)
        _routes_registered = True
        # 绕过中间件必须插到链首（最外层），否则请求会先被 ComfyUI 的
        # origin_only_middleware 403。自定义节点在 app 启动监听前导入，此时插入有效。
        app = getattr(ps, "app", None)
        if app is not None:
            try:
                if _bridge_bypass_middleware not in app.middlewares:
                    app.middlewares.insert(0, _bridge_bypass_middleware)
                    log.info("[DeepSeekBridge] 已在中间件链首插入桥接路径绕过（避免扩展 Origin 被 403）")
            except Exception:
                log.warning("[DeepSeekBridge] 中间件插入失败：扩展 WS 握手可能被 origin 校验 403 拦截", exc_info=True)
        log.info("[DeepSeekBridge] 路由已注册：GET %s/deepseek/bridge (WebSocket), GET %s/deepseek/status",
                 API_PREFIX, API_PREFIX)
    except Exception:
        log.warning("[DeepSeekBridge] 路由注册失败", exc_info=True)
