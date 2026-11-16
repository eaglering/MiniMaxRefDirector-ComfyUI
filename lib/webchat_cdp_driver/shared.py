"""驱动包共享层：SSE 解析 + 纯函数助手（页面 JS 常量见 pagescripts.py）。

热重载说明（免重启 ComfyUI）：spa_server 的 reload 路由按依赖序重载包内
全部模块（shared → pagescripts → base → 各站点），重载后各模块顶部的
``from .shared import X`` 符号引用随重载刷新。
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from . import pagescripts as _pagescripts  # noqa: F401  模块对象绑定：热重载后取到新 JS

# 回复判定阈值（与扩展 NO_SIGNAL_MS / 宽限一致；驱动经本模块引用，热重载可调）
NO_SIGNAL_S = 90.0        # 无任何回复信号快失败
NOT_JSON_GRACE_S = 20.0   # SSE 结束但正文不像 JSON 的宽限期
MAX_TEXT = 200_000


class _CancelledError(RuntimeError):
    """内部哨兵：用户点「取消」时由驱动抛出，外壳 _complete 统一转为「已取消」。"""


def _norm_path(p: str) -> str:
    return (p[: -1] if p and len(p) > 1 and p.endswith("/") else p) or "/"


def _marker_of(text: str) -> str:
    """用户消息特征文本（去掉 Markdown 记号，与扩展 driveFillAndCollect 一致）。"""
    return re.sub(r"\s+", " ", re.sub(r"[`*#>~_|-]", " ", str(text))).strip()[:20]


async def _inject_helpers(page: Any) -> None:
    """注入页面 JS 助手（幂等）。注意：goto 会重置页面上下文，导航后需重新调用。"""
    for _ in range(20):
        try:
            ok = await page.evaluate(_pagescripts._PAGE_JS)
            if ok:
                return
        except Exception:
            pass
        await asyncio.sleep(0.5)
    raise RuntimeError("页面 JS 助手注入失败（页面可能未加载完成）")


async def _page_for(mgr: Any, driver: Any) -> Any:
    """取站点页面（缓存页已关闭时重建缓存后重取）。mgr 为外壳 _Manager（鸭子类型）。"""
    site = driver.cfg
    page = await mgr.page_for(site)
    if page.is_closed():
        mgr._st["pages"].pop(site["id"], None)
        page = await mgr.page_for(site)
    return page


# ---------------- SSE 行解析（移植 extension/page-hook.js） ----------------

_REASONING_RE = re.compile(r"think|reason|thought|cot|reflect", re.I)
_REASONING_KEY_RE = re.compile(r"think|reason|thought|cot", re.I)


def sse_state() -> dict[str, Any]:
    return {"active": False, "text": "", "done": False, "finished": False}


def _append(state: dict, s: str) -> None:
    if s and len(state["text"]) < MAX_TEXT:
        state["text"] += s


def _read_fragments(state: dict, arr: Any) -> None:
    for f in arr or []:
        if not isinstance(f, dict):
            continue
        ftype = str(f.get("type") or f.get("kind") or "").upper()
        if "THINK" in ftype or "REASON" in ftype:
            continue
        p = f.get("p") or f.get("path")
        if isinstance(p, str) and _REASONING_RE.search(p):
            continue
        if isinstance(f.get("content"), str):
            _append(state, f["content"])
        elif isinstance(f.get("text"), str):
            _append(state, f["text"])


def _walk_extract(node: Any, out: list, depth: int) -> None:
    if depth > 12 or len(out) > 2000:
        return
    if isinstance(node, str):
        out.append(node)
        return
    if isinstance(node, list):
        for x in node:
            _walk_extract(x, out, depth + 1)
        return
    if not isinstance(node, dict):
        return
    for k, v in node.items():
        if _REASONING_KEY_RE.search(str(k)):
            continue
        if k in ("content", "text") and isinstance(v, str):
            out.append(v)
        else:
            _walk_extract(v, out, depth + 1)


def parse_sse_body(body: str, mode: str, state: dict) -> None:
    """解析一段 SSE 文本，累积正文到 state（移植 page-hook 的行解析器）。"""
    for line in body.split("\n"):
        line = line.rstrip("\r")
        if not line or line.startswith(":"):
            continue
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw:
            continue
        if raw == "[DONE]":
            state["finished"] = True
            continue
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue

        if mode == "deepseek":
            p = obj.get("p")
            if p == "response/status":
                if str(obj.get("v") or "") in ("FINISHED", "COMPLETED"):
                    state["finished"] = True
                continue
            if isinstance(p, str) and (_REASONING_RE.search(p) or "title" in p or "search" in p):
                continue
            v = obj.get("v")
            if isinstance(v, str):
                if not p or "content" in p:
                    _append(state, v)
            elif isinstance(v, list):
                _read_fragments(state, v)
            elif isinstance(v, dict):
                r = v.get("response")
                if isinstance(r, dict) and isinstance(r.get("content"), str):
                    _append(state, r["content"])
        else:
            st = str(obj.get("finish_reason") or obj.get("status") or obj.get("event") or "").lower()
            if st in ("finished", "done", "complete", "stop"):
                state["finished"] = True
            if obj.get("is_finish") is True or obj.get("finished") is True:
                state["finished"] = True
            out: list = []
            _walk_extract(obj, out, 0)
            for s in out:
                _append(state, s)
