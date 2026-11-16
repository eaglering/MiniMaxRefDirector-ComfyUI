"""BaseSiteDriver：三站公共链路基类。

统一方法（工厂 get_driver(site) 暴露）：
- list_sessions(mgr, page)                 获取会话列表 → [{id, title, updatedAt}]
- open_session(mgr, page, chat_id="")      打开会话（空 = 首页/新会话）→ 当前 chat_id
- send_prompt(mgr, page, text, cancelled)  发送消息（写入+提交+核验）→ 基线状态
- get_reply(mgr, page, baseline, ...)      获取消息 → {ok, text, chat_id, error}
- close_session(mgr, page, chat_id="")     删除会话（基类默认拒绝）

可覆写点：_write_text（写入策略）/ _submit（提交策略）/ list_sessions /
close_session / get_reply。新增站点：SITES 加配置 + 继承本类 + 注册 DRIVERS。
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .pagescripts import _CONFIRM_DELETE_JS, _PAGE_JS, _SIDEBAR_SESSIONS_JS
from .shared import (
    NOT_JSON_GRACE_S,
    NO_SIGNAL_S,
    _CancelledError,
    _inject_helpers,
    _marker_of,
    _norm_path,
    sse_state,
)

log = logging.getLogger(__name__)


def _looks_json_complete(text: str) -> bool:
    """文本里是否已出现配平的 {...}（跳过字符串字面量；括号平衡扫描的 Python 版）。

    用于 get_reply 的 expect_json 判定：流式输出常有 >3s 的停顿（段落与
    代码块之间），稳定性窗口内取到的"半截 JSON"会导致解析失败
    （豆包主体设计"回复中未找到完整 JSON"即此因），此时应继续等待。
    """
    s = str(text or "")
    start = s.find("{")
    if start < 0:
        return False
    depth = 0
    in_str = False
    esc = False
    for ch in s[start:]:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return True
    return False


class BaseSiteDriver:
    parse_mode = "generic"      # SSE 回复解析器（parse_sse_body 的 mode）
    session_source = "sidebar"  # 会话列表来源："api"=站内 API；"sidebar"=UI 扫描侧栏
    supports_delete = False     # 是否支持自动化删除会话

    def __init__(self, cfg: dict[str, Any]) -> None:
        self.cfg = cfg

    @property
    def site_id(self) -> str:
        return self.cfg["id"]

    @property
    def name(self) -> str:
        return self.cfg["name"]

    # ---- 导航与就绪等待 ----

    async def _navigate_and_wait(self, page: Any, target: str, want_path: str) -> None:
        cur = (page.url or "").split("#")[0].split("?")[0]
        if cur != target:
            try:
                await page.goto(target, wait_until="domcontentloaded", timeout=45_000)
            except Exception as e:
                raise RuntimeError(f"{self.name} 页面导航失败：{e}")
        for _ in range(90):
            try:
                p = _norm_path(await page.evaluate("() => location.pathname"))
                if p == want_path:
                    await asyncio.sleep(1.5)  # 会话页加载历史消息的渲染时间
                    # goto 会重置页面上下文（window.__mrdCdp 被清空），必须重新注入
                    await _inject_helpers(page)
                    return
            except RuntimeError:
                raise
            except Exception:
                pass
            await asyncio.sleep(0.5)
        raise RuntimeError(f"{self.name} 会话页面未就绪（未登录或会话不存在）")

    async def _wait_input_ready(self, page: Any, want_home: bool, rounds: int = 25) -> dict:
        last: dict = {}
        for _ in range(rounds):
            try:
                r = await page.evaluate("() => window.__mrdCdp.inputReady()")
                last = r or {}
                path = _norm_path(last.get("path") or "")
                if last.get("ready") and (not want_home or path == self.cfg["home_path"]):
                    return last
            except Exception:
                # 助手可能因导航/刷新被清空：幂等重注入后继续等
                try:
                    await page.evaluate(_PAGE_JS)
                except Exception:
                    pass
            await asyncio.sleep(0.7)
        raise RuntimeError(
            f"等待 {self.name} 输入框就绪超时（页面可能未加载完或未登录）。"
            "请确认浏览器里该站点已登录，或用「页面自检」查看输入框候选"
        )

    def _chat_id_from_url(self, page: Any) -> str:
        m = self.cfg["chat_id_re"].search((page.url or "").split("?")[0])
        return m.group(1) if m else ""

    # ---- 会话管理 ----

    async def open_session(self, mgr: Any, page: Any, chat_id: str = "") -> str:
        """打开会话：chat_id 为空 → 回首页（发送后自动新建会话）；否则导航到会话页。

        返回当前 URL 解析出的 chat_id（新会话在发送前为空，由 get_reply 回填）。
        """
        await _inject_helpers(page)
        if chat_id:
            await self._navigate_and_wait(page, self.cfg["chat_url"](chat_id), self.cfg["chat_path"](chat_id))
            await self._wait_input_ready(page, want_home=False)
        else:
            await self._navigate_and_wait(page, self.cfg["home"], self.cfg["home_path"])
            await self._wait_input_ready(page, want_home=True)
        return self._chat_id_from_url(page)

    async def list_sessions(self, mgr: Any, page: Any) -> list:
        """获取会话列表（基类实现 = UI 扫描会话侧栏）。"""
        await _inject_helpers(page)
        await self._navigate_and_wait(page, self.cfg["home"], self.cfg["home_path"])
        await asyncio.sleep(1.5)  # 侧栏渲染
        try:
            sessions = await page.evaluate(_SIDEBAR_SESSIONS_JS)
        except Exception as e:
            raise RuntimeError(f"读取 {self.name} 会话列表失败（页面可能正在加载，请稍后重试）：{e}")
        if not sessions:
            raise RuntimeError(
                f"未能从 {self.name} 侧栏识别到会话列表（页面结构可能改版）。"
                "可在导入弹窗手动粘贴会话链接，或留空自动新建会话"
            )
        return sessions

    async def close_session(self, mgr: Any, page: Any, chat_id: str = "") -> dict:
        """删除会话（基类默认拒绝；子类按站点实现：DeepSeek=站内 API，豆包/千问=UI 流程）。"""
        if not chat_id:
            raise RuntimeError("缺少 chat_id")
        raise RuntimeError(f"{self.name} 驱动未实现自动化删除会话，请在该网页内手动管理")

    async def _goto_home_for_sidebar(self, mgr: Any, page: Any) -> None:
        """删除流程前置：回到首页并等侧栏/输入框就绪（豆包/千问共用）。"""
        await _inject_helpers(page)
        await self._navigate_and_wait(page, self.cfg["home"], self.cfg["home_path"])
        await self._wait_input_ready(page, want_home=True)
        await asyncio.sleep(1.0)  # 侧栏渲染

    async def _verify_session_gone(self, page: Any, loc: Any, site_name: str) -> dict:
        """删除后校验侧栏条目消失（确认弹窗兜底 + 明确报错）。"""
        for _ in range(8):
            await asyncio.sleep(0.8)
            clicked = await page.evaluate(_CONFIRM_DELETE_JS)
            try:
                if not await loc.count():
                    return {"ok": True}
            except Exception:
                pass
            if clicked:
                await asyncio.sleep(0.6)
        raise RuntimeError(
            f"{site_name} 删除会话未生效：侧栏条目仍存在（可能弹出了未识别的确认框）。"
            "请刷新页面后在该网页内手动确认删除"
        )

    # ---- 发送消息 ----

    async def send_prompt(self, mgr: Any, page: Any, text: str, cancelled) -> dict:
        """发送消息（写入 + 提交 + 核验）。失败/取消抛异常。

        返回 get_reply 所需的基线状态 {marker, before_count, before_marker, path_before}。
        """
        mgr.reset_sse(page)
        marker = _marker_of(text)
        before = await page.evaluate(
            "([m]) => { const blocks = window.__mrdCdp.assistantBlocks();"
            " return { beforeCount: blocks.length, beforeLast: blocks.length ? blocks[blocks.length - 1] : '',"
            " beforeMarker: window.__mrdCdp.countInBody(m), pathBefore: location.pathname,"
            " beforeRounds: document.querySelectorAll('.chat-round').length }; }",
            [marker],
        )
        baseline = {
            "marker": marker,
            "before_count": int(before.get("beforeCount") or 0),
            "before_marker": int(before.get("beforeMarker") or 0),
            "path_before": str(before.get("pathBefore") or ""),
            "before_rounds": int(before.get("beforeRounds") or 0),
            "before_last": str(before.get("beforeLast") or ""),
        }
        written = await self._write_text(page, text, cancelled)
        if not written:
            raise RuntimeError(
                f"写入 {self.name} 输入框失败：回读内容与提示词不一致（页面可能正在重渲染）。"
                "请手动在该页面粘贴一次确认可输入"
            )
        await self._submit(page, marker, baseline, cancelled)
        return baseline

    async def _write_text(self, page: Any, text: str, cancelled) -> bool:
        """写入输入框（基类 = locator.fill 可信事件，带回读校验重试）。"""
        for _round in range(5):
            if cancelled():
                raise _CancelledError()
            pick = await page.evaluate("() => window.__mrdCdp.pickInput()")
            if not pick or not pick.get("found"):
                await asyncio.sleep(0.8)
                continue
            loc = page.locator('[data-mrd-input="1"]').first
            try:
                await loc.click(timeout=5000)
                await loc.fill(text, timeout=15_000)
            except Exception as e:
                log.debug("[WebChatCDP] fill retry: %s", e)
                await asyncio.sleep(0.8)
                continue
            if await self._readback_ok(loc, text):
                return True
            await asyncio.sleep(0.8)
        return False

    async def _readback_ok(self, loc: Any, text: str) -> bool:
        """回读校验：输入框内容与提示词一致（前缀或等长）。"""
        read_back = await loc.evaluate(
            "el => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? (el.value || '') : (el.innerText || '').trim()"
        )
        if not read_back:
            return False
        prefix_ok = text.startswith(read_back.strip()[:40])
        len_ok = len(read_back) == len(text)
        return prefix_ok or len_ok

    async def _submit(self, page: Any, marker: str, baseline: dict, cancelled) -> None:
        """提交消息（基类 = 回车 → 补回车 → 通用发送按钮，未提交安全重试不重复写入）。"""
        submits = 0
        for round_i in range(12):
            if cancelled():
                raise _CancelledError()
            if submits == 0:
                try:
                    await page.keyboard.press("Enter")
                except Exception:
                    pass
                submits = 1
            await asyncio.sleep(2.0 if round_i == 0 else 1.5)
            try:
                s = await page.evaluate(
                    "([m, bm, pb]) => window.__mrdCdp.sentCheck(m, bm, pb)",
                    [marker, baseline["before_marker"], baseline["path_before"]],
                )
            except Exception:
                continue
            if s and s.get("inputEmpty") is False:
                if submits == 1:
                    submits = 2
                    try:
                        await page.keyboard.press("Enter")
                    except Exception:
                        pass
                    continue
                if submits < 4:
                    submits += 1
                    btn = await page.evaluate("() => window.__mrdCdp.pickSendButton()")
                    if btn and btn.get("found"):
                        try:
                            await page.locator('[data-mrd-send="1"]').first.click(timeout=5000)
                        except Exception:
                            pass
                continue
            if s and (s.get("markerAppeared") or s.get("pathChanged")
                      or int(s.get("blockCount") or 0) > baseline["before_count"]
                      or int(s.get("roundCount") or 0) > int(baseline.get("before_rounds") or 0)):
                return
        raise RuntimeError(
            "发送未生效：已回车并补点发送按钮（含重试），但输入框始终未清空、页面上也没出现这条消息。"
            f"常见原因：页面结构改版导致发送按钮/输入框定位偏移。请在 {self.name} 页面手动粘贴发送一次确认页面可用"
        )

    async def _sent_ok(self, page: Any, marker: str, baseline: dict) -> bool:
        """单次发送结果核对（供子类覆写提交策略时复用）。"""
        try:
            s = await page.evaluate(
                "([m, bm, pb]) => window.__mrdCdp.sentCheck(m, bm, pb)",
                [marker, baseline["before_marker"], baseline["path_before"]],
            )
        except Exception:
            return False
        return bool(s and (s.get("markerAppeared") or s.get("pathChanged")
                           or int(s.get("blockCount") or 0) > baseline["before_count"]
                           or int(s.get("roundCount") or 0) > int(baseline.get("before_rounds") or 0)))

    # ---- 获取消息 ----

    async def get_reply(
        self,
        mgr: Any,
        page: Any,
        baseline: dict,
        expect_json: bool,
        timeout_s: float,
        cancelled,
    ) -> dict:
        """获取消息：SSE 主通道 + DOM 回复块稳定性兜底（判定阈值与扩展一致）。

        返回 {ok, text, chat_id, error}；取消抛 _CancelledError。
        """
        sse = getattr(page, "_mrd_sse", None) or sse_state()
        before_count = int(baseline.get("before_count") or 0)
        # 发送前最后一条回复：用于判定"新出现"的回复块（同会话累积时避免取旧回复）
        before_last = str(baseline.get("before_last") or "")
        before_rounds = int(baseline.get("before_rounds") or 0)
        deadline = time.monotonic() + max(timeout_s, 10.0)
        no_signal_at = time.monotonic() + NO_SIGNAL_S
        last_text = ""
        stable_since = 0.0
        saw_any = False
        not_json_at = 0.0

        while time.monotonic() < deadline:
            if cancelled():
                raise _CancelledError()
            await asyncio.sleep(3.0)
            dom: dict = {}
            try:
                dom = await page.evaluate(
                    "([bc, bl]) => window.__mrdCdp.domSnapshot(bc, bl)",
                    [before_count, before_last],
                )
            except Exception:
                continue
            sse_text = str(sse.get("text") or "").strip()
            if sse.get("done") and sse_text:
                # expect_json 时同样要求 JSON 配平（SSE 通道也可能取到半截正文）
                if not expect_json or _looks_json_complete(sse_text):
                    return {"ok": True, "text": sse_text, "chat_id": str(dom.get("chatId") or ""), "error": ""}
                if not not_json_at:
                    not_json_at = time.monotonic()
                elif time.monotonic() - not_json_at > NOT_JSON_GRACE_S:
                    return {"ok": True, "text": sse_text, "chat_id": str(dom.get("chatId") or ""), "error": ""}
            # 优先用"最后一轮"答案（千问 .chat-round）：只读最新一轮，
            # 天然排除上一轮回复（轮次壳在用户消息入 DOM 时即创建，
            # 不能用轮数增长单独判定回复到达）
            # SSE 卡死兜底：流式响应的结束事件可能丢失（active 恒为 True、
            # done 永不置位），此时只要正文长时间稳定也视为生成完成，
            # 避免整步一直"执行中"等到总超时。
            stable_need = 3.0 if not sse.get("active") else 8.0
            # 期望 JSON 时：文本稳定但 JSON 尚未配平 → 多半处于流式停顿中段
            # （段落与代码块之间），继续等待新内容；只在临近总超时才放行原文，
            # 由上层按"解析失败打印原文"处理，避免拿到半截 JSON
            def _json_pending() -> bool:
                return bool(expect_json and not _looks_json_complete(last_text))

            cur_round = str(dom.get("lastRoundText") or "")
            if cur_round:
                saw_any = True
                if cur_round != last_text:
                    last_text = cur_round
                    stable_since = time.monotonic()
                elif time.monotonic() - stable_since > stable_need and not (
                    _json_pending() and deadline - time.monotonic() > 20.0
                ):
                    return {"ok": True, "text": last_text, "chat_id": str(dom.get("chatId") or ""), "error": ""}
            else:
                cur = str(dom.get("lastBlockText") or "")
                # 无轮结构站点：回复块增多 / 文本变化 视为新回复
                is_new = bool(cur) and (
                    int(dom.get("blockCount") or 0) > before_count
                    or cur != before_last
                )
                if is_new:
                    saw_any = True
                    if cur != last_text:
                        last_text = cur
                        stable_since = time.monotonic()
                    elif time.monotonic() - stable_since > stable_need and not (
                        _json_pending() and deadline - time.monotonic() > 20.0
                    ):
                        return {"ok": True, "text": last_text, "chat_id": str(dom.get("chatId") or ""), "error": ""}
            if not sse.get("active") and not saw_any and time.monotonic() > no_signal_at:
                return {
                    "ok": False, "text": "", "chat_id": "",
                    "error": (
                        f"发送后 {NO_SIGNAL_S:.0f}s 内未检测到 {self.name} 回复流（未登录 / 被风控 / 页面接口变更）。"
                        f"请在 {self.name} 页面手动发一条消息确认可正常回复"
                    ),
                }
        return {
            "ok": False, "text": "", "chat_id": "",
            "error": f"等待 {self.name} 回复超时（生成过久或页面接口已变更）",
        }
