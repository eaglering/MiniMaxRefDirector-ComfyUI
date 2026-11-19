"""网页会话 CDP 自动化管理器（Playwright 附加用户真实 Chrome）。

替代浏览器扩展桥接（lib/deepseek_bridge.py 的 WS 通道）的统一下一代实现：
通过 ``connect_over_cdp`` 附加到用户以 ``--remote-debugging-port=9222`` 启动的
真实 Chrome，复用其登录态与浏览器指纹，在 chat.deepseek.com / www.doubao.com /
www.qianwen.com 三个网页会话内完成 LLM 生成（H3 提示词 / 翻译 / 分镜导入流水线）。

与扩展实现的行为对齐（移植自 extension/content.js + background.js + page-hook.js）：
- 输入框候选打分（textarea / contenteditable 双策略），发送按钮定位排除语音/上传；
- 发送判据：输入框清空 + 用户消息 marker 真实出现；未提交时安全重试（先补回车
  再补点发送按钮，绝不重复写入）；
- 回复捕获双通道：站点 SSE 响应监听（Playwright response 事件，主通道）+
  DOM 回复块稳定性检测（兜底）；expect_json 时要求正文出现 ``{``，否则给 20s 宽限；
- 90s 无信号快失败、240s 回复超时、页面未就绪/未登录/发送未生效等文案保持一致。

站点驱动（工厂模式）：驱动实现拆分在子包 webchat_cdp_driver/（每站一文件完全
自包含——页面 JS / 元素选择器 / SSE 协议 / 流程实现各自独立维护；base.py 仅
为纯接口）；外壳工厂 ``get_driver(site)`` 暴露统一方法：
获取会话列表 list_sessions / 打开会话 open_session / 发送提示词 send_prompt /
获取提示词返回 get_reply / 关闭会话 close_session。修改某站点的选择器或常量
不影响其他站点。

关键优势：Playwright 经 CDP Input domain 注入的键盘/鼠标事件 ``isTrusted=true``，
不被站点"合成事件"过滤（解决豆包扩展桥"发送未生效"类问题）。

线程模型：ComfyUI 节点执行线程（executor）经同步 API 提交到模块自持的
asyncio 事件循环线程；全局线程锁串行化（同一时刻仅一个网页会话任务），
与 lib/llm.py 的 ``_DEEPSEEK_LOCK`` 模式一致。

Playwright 为可选依赖：未安装时返回带 ``pip install playwright`` 提示的错误，
不影响其他 LLM 模式。
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.request
from typing import Any

from . import webchat_cdp_driver as _driver_pkg
from .webchat_cdp_driver.base import _CancelledError, sse_state

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = 290.0
REPLY_TIMEOUT_S = 240.0   # 等待回复总时长（与扩展 REPLY_TIMEOUT_MS 一致）
DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222"

CDP_START_HINT = (
    "无法连接浏览器调试端口（CDP）。请在「全局参数 → LLM 设置」点「启动浏览器」"
    "（自动以调试参数启动并使用项目内独立用户目录），或手动启动：\n"
    '  chrome.exe --remote-debugging-port=9222 --user-data-dir="D:\\chrome-cdp"\n'
    "说明：Chrome 136+ 禁止默认用户目录开调试端口，--user-data-dir 必须指向一个"
    "独立目录（首次启动后在里面登录各站点，cookies 会持久保留）。"
)

# ---------------- 站点适配配置 ----------------
# DOM 自动化链路（输入框/发送按钮/回复块）跨站通用，仅"会话 URL 结构"、
# "SSE 端点匹配"、"回复解析器"、"会话管理方式"因站而异。新增站点只需加配置。

SITES: dict[str, dict[str, Any]] = {
    "deepseek": {
        "id": "deepseek",
        "name": "DeepSeek",
        "hosts": ["chat.deepseek.com"],
        "home": "https://chat.deepseek.com/",
        "home_path": "/",
        "chat_url": lambda cid: f"https://chat.deepseek.com/a/chat/s/{cid}",
        "chat_path": lambda cid: f"/a/chat/s/{cid}",
        "chat_id_re": re.compile(r"/a/chat/s/([0-9A-Za-z_-]+)"),
        "sse_match": ["/api/v0/chat/completion"],
        "parse": "deepseek",
        "session_api": True,
    },
    "doubao": {
        "id": "doubao",
        "name": "豆包",
        "hosts": ["www.doubao.com", "doubao.com"],
        "home": "https://www.doubao.com/chat/",
        "home_path": "/chat",
        "chat_url": lambda cid: f"https://www.doubao.com/chat/{cid}",
        "chat_path": lambda cid: f"/chat/{cid}",
        "chat_id_re": re.compile(r"/chat/([0-9A-Za-z_-]+)"),
        "sse_match": ["samantha/chat"],
        "parse": "generic",
        "session_api": False,  # 会话列表走 UI 扫描；删除走 UI 流程（更多按钮 → Ctrl+D）
    },
    "qwen": {
        "id": "qwen",
        "name": "千问",
        "hosts": ["www.qianwen.com", "qianwen.com", "tongyi.aliyun.com"],
        "home": "https://www.qianwen.com/chat/",
        "home_path": "/chat",
        "chat_url": lambda cid: f"https://www.qianwen.com/chat/{cid}",
        "chat_path": lambda cid: f"/chat/{cid}",
        "chat_id_re": re.compile(r"/(?:qianwen/)?chat/([0-9A-Za-z_-]+)"),
        "sse_match": ["/dialog/conversation", "/conversation"],
        "parse": "generic",
        "session_api": False,  # 会话列表/删除走页面 data-session-* 元素（驱动实现）
    },
}

_PROXY_MODE_TO_SITE = {
    "deepseek": "deepseek",
    "doubao": "doubao",
    "qwen": "qwen",
    # 兼容 vlm_mode 写法（deepseek-proxy 等）
    "deepseek-proxy": "deepseek",
    "doubao-proxy": "doubao",
    "qianwen-proxy": "qwen",
    "qwen-proxy": "qwen",
}


def normalize_site(site: str) -> str:
    s = _PROXY_MODE_TO_SITE.get(str(site or "").strip().lower())
    if not s:
        raise ValueError(f"未知桥接站点：{site}（支持 deepseek / doubao / qwen）")
    return s


def site_of(site: str) -> dict[str, Any]:
    return SITES[normalize_site(site)]


# ---------------- SSE 行解析（移植 extension/page-hook.js） ----------------

class _Manager:
    """进程内单例：自持 asyncio 循环线程 + Playwright 连接 + 站点页面复用。"""

    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.ready = threading.Event()
        self.op_lock = threading.Lock()          # 跨线程串行化（一次一个网页任务）
        self._thread = threading.Thread(target=self._run, name="mrd-webchat-cdp", daemon=True)
        self._thread.start()
        self.ready.wait(timeout=10)

    def _run(self) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.ready.set()
        self.loop.run_forever()

    def submit(self, coro, timeout: float) -> Any:
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return fut.result(timeout=timeout)

    # ---- 连接与页面 ----
    async def ensure_connected(self, endpoint: str):
        st = getattr(self, "_st", None)
        if st is not None and st["browser"].is_connected and st["endpoint"] == endpoint:
            return st
        if st is not None:
            try:
                await st["pw"].stop()
            except Exception:
                pass
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError(
                "Playwright 未安装：请在本 ComfyUI 的 Python 环境执行 pip install playwright"
                "（无需 playwright install，直接附加系统 Chrome）"
            )
        pw = await async_playwright().start()
        try:
            browser = await pw.chromium.connect_over_cdp(endpoint, timeout=20_000)
        except Exception as e:
            try:
                await pw.stop()
            except Exception:
                pass
            raise RuntimeError(f"{CDP_START_HINT}\n连接失败：{e}")
        if not browser.contexts:
            raise RuntimeError("CDP 已连接但未发现浏览器上下文（浏览器可能刚启动未完成初始化）")
        st = {"pw": pw, "browser": browser, "endpoint": endpoint, "pages": {}, "cancel": None}
        self._st = st
        log.info("[WebChatCDP] 已附加 Chrome（%s）", endpoint)
        return st

    async def disconnect(self) -> None:
        st = getattr(self, "_st", None)
        if st is None:
            return
        try:
            await st["pw"].stop()
        except Exception:
            pass
        self._st = None

    @staticmethod
    def _host_matches(url: str, site: dict) -> bool:
        host = url.split("//", 1)[-1].split("/", 1)[0]
        return any(h in host for h in site["hosts"])

    async def page_for(self, driver: Any) -> Any:
        """取站点页面（driver 为站点驱动实例，SSE 附加与解析经驱动分发）。"""
        site = driver.cfg
        st = self._st
        cached = st["pages"].get(site["id"])
        if cached is not None:
            try:
                if cached.is_closed():
                    st["pages"].pop(site["id"], None)
                elif self._host_matches(cached.url, site):
                    return cached
                else:
                    # 页面被用户导航走：仍复用该页，稍后由调用方导航回站点
                    return cached
            except Exception:
                st["pages"].pop(site["id"], None)
        # 优先复用浏览器里已打开的站点标签页
        for ctx in st["browser"].contexts:
            for page in ctx.pages:
                if self._host_matches(page.url, site):
                    st["pages"][site["id"]] = page
                    self._attach_sse(page, driver)
                    return page
        if not st["browser"].contexts:
            raise RuntimeError(
                "CDP 已连接但浏览器没有任何窗口上下文（浏览器可能已关闭全部窗口）。"
                "请重新打开浏览器后重试"
            )
        ctx = st["browser"].contexts[0]
        page = await ctx.new_page()
        st["pages"][site["id"]] = page
        self._attach_sse(page, driver)
        try:
            await page.goto(site["home"], wait_until="domcontentloaded", timeout=45_000)
        except Exception as e:
            raise RuntimeError(f"打开 {site['name']} 页面失败（网络异常或站点不可达）：{e}")
        return page

    def _attach_sse(self, page: Any, driver: Any) -> None:
        if getattr(page, "_mrd_sse_attached", False):
            return
        page._mrd_sse_attached = True
        state = sse_state()
        page._mrd_sse = state
        site = driver.cfg

        def on_response(resp) -> None:
            try:
                url = resp.url or ""
                if not any(m in url for m in site["sse_match"]):
                    return
                state["active"] = True
                state["done"] = False

                async def consume() -> None:
                    try:
                        body = await resp.text()
                        driver.parse_sse_body(body, state)
                    except Exception:
                        pass
                    finally:
                        state["done"] = True

                asyncio.ensure_future(consume())
            except Exception:
                pass

        page.on("response", on_response)

    @staticmethod
    def reset_sse(page: Any) -> None:
        st = getattr(page, "_mrd_sse", None)
        if st is not None:
            st.update(active=False, text="", done=False, finished=False)


_mgr: _Manager | None = None
_mgr_lock = threading.Lock()


def _manager() -> _Manager:
    global _mgr
    with _mgr_lock:
        if _mgr is None:
            _mgr = _Manager()
        return _mgr


# ---------------- 站点驱动（工厂 + 热重载） ----------------
# 驱动实现拆分在子包 webchat_cdp_driver/：base.py 公共链路、deepseek.py /
# doubao.py / qwen.py 每站一文件（方法：获取会话列表 list_sessions、删除会话
# close_session、打开会话 open_session、发送消息 send_prompt、获取消息 get_reply）。
# 本外壳只负责 SITES 配置注入、管理器与对外同步 API。

def get_driver(site: str):
    """站点驱动工厂：deepseek / doubao / qwen（兼容 deepseek-proxy 等写法）。"""
    sid = normalize_site(site)
    return _driver_pkg.get_class(sid)(SITES[sid])


def reload_drivers() -> list:
    """热重载站点驱动与页面 JS（开发用，免重启 ComfyUI）。"""
    return _driver_pkg.reload_drivers()


async def _page_for(mgr: "_Manager", driver: Any) -> Any:
    """取站点页面（缓存页已关闭时重建缓存后重取）。"""
    page = await mgr.page_for(driver)
    if page.is_closed():
        mgr._st["pages"].pop(driver.cfg["id"], None)
        page = await mgr.page_for(driver)
    return page


# 疑似站点风控的错误特征：发送被静默拒绝（输入框未清空、消息不上屏、无任何提示）
# 或发送后长时间无回复流。豆包实测：连续高频自动化发送约 4 条后触发，静默吞消息。
_RISK_ERROR_WORDS = ("发送未生效", "未检测到")

# 风控冷却时长（秒）：实测几分钟内即恢复；取 45-75s 随机，只自动重试一次
_RISK_COOLDOWN_S = (45.0, 75.0)


async def _complete(
    system: str,
    prompt: str,
    expect_json: bool,
    timeout_s: float,
    site_id: str,
    session_mode: str,
    chat_id: str,
    cdp_endpoint: str,
) -> dict:
    """完整生成流程：驱动编排（打开会话 → 发送提示词 → 获取提示词返回）。

    发送/回复出现疑似站点风控（静默吞消息）时，冷却 45-75s 后**自动重试一次**：
    内容并未发出（或未获回复），重试不构成重复发送；预算由 timeout_s 统一控制。
    """
    driver = get_driver(site_id)
    mgr = _manager()
    st = await mgr.ensure_connected(cdp_endpoint or DEFAULT_CDP_ENDPOINT)
    text = f"{system}\n\n---\n{prompt}" if (system or "").strip() else prompt
    if not text.strip():
        return {"ok": False, "text": "", "error": "prompt is empty"}

    cancel_evt = asyncio.Event()
    st["cancel"] = cancel_evt

    def _cancelled() -> bool:
        return cancel_evt.is_set()

    def _result(ok: bool, msg: str = "", reply: str = "", cid: str = "", risk: bool = False) -> dict:
        st["cancel"] = None
        return {"ok": ok, "text": reply, "error": msg, "chat_id": cid, "risk": bool(risk)}

    async def _cooldown(seconds: float) -> None:
        """可取消的冷却等待。"""
        waited = 0.0
        while waited < seconds:
            if _cancelled():
                raise _CancelledError()
            step = min(2.0, seconds - waited)
            await asyncio.sleep(step)
            waited += step

    started = time.monotonic()
    last_err = ""
    try:
        for attempt in range(2):
            budget = max(60.0, timeout_s - (time.monotonic() - started) - 15.0)
            try:
                page = await _page_for(mgr, driver)
                # 打开会话：reuse → 会话页追问；new → 首页（发送后站点自动新建会话）
                await driver.open_session(
                    mgr, page, chat_id if (session_mode == "reuse" and chat_id) else ""
                )
                # SSE 状态每轮必须清零：reset_sse 此前从未被调用，上一轮的
                # done=True/text 残留会让下一轮 get_reply 在新回复开始前直接把
                # 上一轮正文当作本轮回复返回（批量 H3 后段"串轮"的根因之一）
                mgr.reset_sse(page)
                baseline = await driver.send_prompt(mgr, page, text, _cancelled)
                reply = await driver.get_reply(
                    mgr, page, baseline, expect_json, min(REPLY_TIMEOUT_S, budget), _cancelled
                )
            except RuntimeError as e:
                reply = {"ok": False, "error": str(e), "text": "", "chat_id": ""}
            last_err = str(reply.get("error") or "")
            if reply.get("ok"):
                return _result(
                    True,
                    "",
                    str(reply.get("text") or ""),
                    str(reply.get("chat_id") or ""),
                )
            # 疑似风控（静默吞消息 / 无回复流）：不再自动重发（高频自动重发易触发
            # 站点风控升级为封号）。返回 risk 标记交前端弹窗，由用户决定
            # 「拉取会话最后回复（不发送）/ 重发该镜提示词 / 跳过」。
            if any(w in last_err for w in _RISK_ERROR_WORDS):
                return _result(False, last_err, risk=True)
            return _result(False, last_err)
        return _result(False, last_err)
    except _CancelledError:
        return _result(False, "已取消")
    except Exception as e:
        log.warning("[WebChatCDP] complete 异常", exc_info=True)
        return _result(False, f"网页会话调用异常：{e}")


async def _list_sessions(site_id: str, cdp_endpoint: str) -> list:
    driver = get_driver(site_id)
    mgr = _manager()
    await mgr.ensure_connected(cdp_endpoint or DEFAULT_CDP_ENDPOINT)
    page = await _page_for(mgr, driver)
    return await driver.list_sessions(mgr, page)


async def _delete_session(site_id: str, chat_id: str, cdp_endpoint: str) -> dict:
    driver = get_driver(site_id)
    if not chat_id:
        raise RuntimeError("缺少 chat_id")  # 连接前校验，避免无谓的 CDP 连接
    mgr = _manager()
    await mgr.ensure_connected(cdp_endpoint or DEFAULT_CDP_ENDPOINT)
    page = await _page_for(mgr, driver)
    return await driver.close_session(mgr, page, chat_id)


async def _fetch_last_reply(site_id: str, chat_id: str, cdp_endpoint: str) -> dict:
    """打开指定会话并读取最后一条助手回复（不发送任何消息）。"""
    driver = get_driver(site_id)
    mgr = _manager()
    await mgr.ensure_connected(cdp_endpoint or DEFAULT_CDP_ENDPOINT)
    page = await _page_for(mgr, driver)
    await driver.open_session(mgr, page, chat_id or "")
    return await driver.last_reply(mgr, page)


async def _diag(cdp_endpoint: str) -> dict:
    mgr = _manager()
    out: dict[str, Any] = {"connected": False, "sites": [], "endpoint": cdp_endpoint or DEFAULT_CDP_ENDPOINT}
    try:
        st = await mgr.ensure_connected(cdp_endpoint or DEFAULT_CDP_ENDPOINT)
    except RuntimeError as e:
        out["error"] = str(e)
        return out
    out["connected"] = bool(st["browser"].is_connected)
    for site in SITES.values():
        pages = []
        for ctx in st["browser"].contexts:
            for page in ctx.pages:
                if _Manager._host_matches(page.url, site):
                    pages.append(page)
        entry: dict[str, Any] = {
            "id": site["id"], "name": site["name"], "tabs": len(pages),
            "sessionApi": bool(site["session_api"]), "probes": [],
        }
        drv = get_driver(site["id"])
        for page in pages[:3]:
            try:
                await drv.inject_helpers(page)
                p = await page.evaluate("() => window.__mrdCdp.probe()")
                entry["probes"].append(p)
            except Exception as e:
                entry["probes"].append({"url": getattr(page, "url", ""), "error": str(e)})
        out["sites"].append(entry)
    return out


# ---------------- 对外同步 API（任意线程可调） ----------------

def complete(
    system: str = "",
    prompt: str = "",
    expect_json: bool = False,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    site: str = "deepseek",
    session_mode: str = "new",
    chat_id: str = "",
    cdp_endpoint: str = "",
) -> dict:
    """在指定站点网页会话内完成一次生成（同步阻塞，节点线程可调）。

    session_mode："new" 回站点首页新开会话（返回新会话 chat_id）；
    "reuse" 导航到 chat_id 会话内追问。
    """
    site_id = normalize_site(site)
    mgr = _manager()
    if not mgr.op_lock.acquire(timeout=2.0):
        return {"ok": False, "text": "", "error": "已有网页会话任务进行中，请稍后再试"}
    try:
        return mgr.submit(
            _complete(system, prompt, expect_json, timeout_s, site_id, session_mode, chat_id, cdp_endpoint),
            timeout=timeout_s + 180.0,  # 余量：疑似风控时的 45-75s 冷却重试
        )
    except Exception as e:
        return {"ok": False, "text": "", "error": f"网页会话调用异常：{e}"}
    finally:
        mgr.op_lock.release()


def list_sessions(site: str = "deepseek", cdp_endpoint: str = "", timeout_s: float = 60.0) -> list:
    site_id = normalize_site(site)
    mgr = _manager()
    if not mgr.op_lock.acquire(timeout=2.0):
        raise RuntimeError("已有网页会话任务进行中，请稍后再试")
    try:
        return mgr.submit(_list_sessions(site_id, cdp_endpoint), timeout=timeout_s)
    finally:
        mgr.op_lock.release()


def delete_session(site: str = "deepseek", chat_id: str = "", cdp_endpoint: str = "", timeout_s: float = 30.0) -> dict:
    site_id = normalize_site(site)
    mgr = _manager()
    if not mgr.op_lock.acquire(timeout=2.0):
        raise RuntimeError("已有网页会话任务进行中，请稍后再试")
    try:
        return mgr.submit(_delete_session(site_id, chat_id, cdp_endpoint), timeout=timeout_s)
    finally:
        mgr.op_lock.release()


def fetch_last_reply(
    site: str = "deepseek",
    chat_id: str = "",
    cdp_endpoint: str = "",
    timeout_s: float = 90.0,
) -> dict:
    """读取指定会话最后一条助手回复（不发送任何消息；风控失败后的补救拉取）。"""
    site_id = normalize_site(site)
    mgr = _manager()
    if not mgr.op_lock.acquire(timeout=2.0):
        return {"ok": False, "text": "", "error": "已有网页会话任务进行中，请稍后再试", "risk": False}
    try:
        return mgr.submit(_fetch_last_reply(site_id, chat_id, cdp_endpoint), timeout=timeout_s)
    except Exception as e:
        return {"ok": False, "text": "", "error": f"拉取会话回复异常：{e}", "risk": False}
    finally:
        mgr.op_lock.release()


def diag(cdp_endpoint: str = "", timeout_s: float = 45.0) -> dict:
    mgr = _manager()
    if not mgr.op_lock.acquire(timeout=2.0):
        raise RuntimeError("已有网页会话任务进行中，请稍后再试")
    try:
        return mgr.submit(_diag(cdp_endpoint), timeout=timeout_s)
    finally:
        mgr.op_lock.release()


def cancel() -> bool:
    """置取消标志：进行中的 complete 在下一个轮询点返回「已取消」。"""
    mgr = _manager()
    st = getattr(mgr, "_st", None)
    if st is not None and st.get("cancel") is not None:
        mgr.loop.call_soon_threadsafe(st["cancel"].set)
        return True
    return False


def status(cdp_endpoint: str = "") -> dict:
    """轻量连接状态（不拉页面探针，供设置面板「测试连接」）。"""
    endpoint = cdp_endpoint or DEFAULT_CDP_ENDPOINT
    mgr = _manager()
    st = getattr(mgr, "_st", None)
    connected = bool(st and st["endpoint"] == endpoint and st["browser"].is_connected)
    return {"connected": connected, "endpoint": endpoint}


# ---------------- 浏览器探测与一键启动（设置面板「启动浏览器」按钮） ----------------
# 目标：用户在 SPA 设置里选好浏览器、点一下按钮，后端即以调试参数拉起浏览器并
# 自动打开当前桥接站点网页，全程无需手动敲命令行。不限于 Chrome（Edge / Brave /
# Chromium / 自定义路径均可），用户目录固定放在项目 userdata/browser 下（随项目
# 备份迁移，登录态持久保留）。

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 独立用户目录：Chrome/Edge 136+ 禁止默认 profile 开调试端口，必须用独立目录。
BROWSER_PROFILE_DIR = os.path.join(_PROJECT_ROOT, "userdata", "browser")

_BROWSER_DEFINITIONS: list[tuple[str, str, list[str]]] = [
    ("chrome", "Chrome", [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "google-chrome", "google-chrome-stable",
    ]),
    ("edge", "Edge", [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "microsoft-edge", "microsoft-edge-stable",
    ]),
    ("brave", "Brave", [
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
        r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "brave-browser", "brave",
    ]),
    ("chromium", "Chromium", [
        r"C:\Program Files\Chromium\Application\chrome.exe",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "chromium", "chromium-browser",
    ]),
]


def _exe_exists(path: str) -> bool:
    p = os.path.expandvars(path)
    if os.path.isfile(p):
        return True
    # 无扩展名的可执行名（Linux 常见）：走 PATH 探测
    if os.path.splitext(p)[1] == "" and shutil.which(p):
        return True
    return False


def find_browsers() -> dict:
    """探测本机已安装的可用浏览器 → { browsers: [{id,name,installed,path}], profileDir }。"""
    browsers = []
    for bid, name, candidates in _BROWSER_DEFINITIONS:
        found = ""
        for c in candidates:
            if _exe_exists(c):
                found = os.path.abspath(os.path.expandvars(c))
                break
        browsers.append({"id": bid, "name": name, "installed": bool(found), "path": found})
    return {"browsers": browsers, "profileDir": BROWSER_PROFILE_DIR}


def _cdp_probe(host: str, port: int, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/json/version", timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def launch_browser(
    browser: str = "",
    browser_path: str = "",
    urls: "tuple[str, ...] | list[str]" = (),
    cdp_endpoint: str = "",
    timeout_s: float = 40.0,
) -> dict:
    """以调试参数启动浏览器（独立用户目录 = 项目 userdata/browser）。

    - 目标端口已有 CDP：幂等返回已连接（按钮可重复点击，不会重复拉起）；
    - 端口被其它程序占用：自动向后寻找空闲端口，返回实际 endpoint；
    - 启动后轮询 /json/version 确认 CDP 就绪（失败多为此前已有同目录实例在跑）。
    """
    endpoint = (cdp_endpoint or DEFAULT_CDP_ENDPOINT).strip() or DEFAULT_CDP_ENDPOINT
    m = re.match(r"^(?:https?://)?([^/:]+):(\d+)", endpoint)
    host, port = (m.group(1), int(m.group(2))) if m else ("127.0.0.1", 9222)

    if _cdp_probe(host, port):
        return {
            "launched": False, "connected": True, "endpoint": endpoint,
            "profileDir": BROWSER_PROFILE_DIR,
        }

    # 解析可执行文件：自定义路径 > 指定 id > 探测列表第一个
    if browser_path.strip():
        exe = os.path.abspath(os.path.expandvars(browser_path.strip()))
        if not os.path.isfile(exe):
            return {
                "launched": False, "connected": False, "endpoint": endpoint,
                "error": f"自定义浏览器路径不存在：{exe}",
            }
    else:
        installed = {b["id"]: b["path"] for b in find_browsers()["browsers"] if b["installed"]}
        if browser.strip():
            exe = installed.get(browser.strip().lower(), "")
            if not exe:
                return {
                    "launched": False, "connected": False, "endpoint": endpoint,
                    "error": (
                        f"未检测到所选浏览器（{browser}）。已安装：{', '.join(installed) or '无'}；"
                        "可在设置中改用「自定义路径」手动指定可执行文件。"
                    ),
                }
        else:
            if not installed:
                return {
                    "launched": False, "connected": False, "endpoint": endpoint,
                    "error": "未检测到 Chrome / Edge / Brave / Chromium，请在设置中用「自定义路径」指定浏览器可执行文件。",
                }
            exe = installed.get("chrome") or next(iter(installed.values()))

    # 目标端口被非 CDP 程序占用 → 向后找空闲端口
    if not _port_free(host, port):
        for p2 in range(port + 1, port + 10):
            if _port_free(host, p2):
                port = p2
                break
        else:
            return {
                "launched": False, "connected": False, "endpoint": endpoint,
                "error": f"{host} 的 {port}-{port + 9} 端口均被占用，无法启动调试浏览器",
            }

    os.makedirs(BROWSER_PROFILE_DIR, exist_ok=True)
    args = [
        exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={BROWSER_PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
    ] + [u for u in urls if u]
    popen_kwargs: dict[str, Any] = {"close_fds": True}
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        proc = subprocess.Popen(args, **popen_kwargs)  # noqa: S603
    except Exception as e:
        return {
            "launched": False, "connected": False, "endpoint": endpoint,
            "error": f"启动浏览器失败：{e}",
        }

    deadline = time.time() + max(timeout_s, 10.0)
    while time.time() < deadline:
        if _cdp_probe(host, port, timeout=1.0):
            return {
                "launched": True, "connected": True,
                "endpoint": f"http://{host}:{port}",
                "profileDir": BROWSER_PROFILE_DIR, "pid": proc.pid,
            }
        time.sleep(0.5)
    return {
        "launched": True, "connected": False,
        "endpoint": f"http://{host}:{port}",
        "profileDir": BROWSER_PROFILE_DIR, "pid": proc.pid,
        "error": (
            "浏览器已启动，但调试端口未就绪。若该浏览器此前已用同一用户目录运行过"
            "（无调试参数），请先完全退出它（含托盘/后台进程）再点一次「启动浏览器」。"
        ),
    }
