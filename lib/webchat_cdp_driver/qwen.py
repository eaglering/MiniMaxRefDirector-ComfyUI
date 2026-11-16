"""QwenDriver: 千问站点驱动。

- 获取会话列表：div[data-session-switch-target="normal"]，data-session-id 即会话 id
- 删除会话：目标 div 内 button 点击 → 查找 div[data-session-switch-target=
  "delete-session"][data-session-id=<id>] 点击触发删除（确认弹窗兜底）
- 发送消息：输入框为自绘富文本编辑器，locator.fill 常不触发其内部状态
  （「发送消息」按钮保持禁用、回车不提交）→ 覆写 _write_text 改用可信键盘
  输入（insert_text），并以「发送按钮变为可用」作为写入成功判据；
  _submit 优先点发送按钮，基类通用重试兜底。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .base import BaseSiteDriver
from .pagescripts import _QWEN_SEND_STATE_JS, _QWEN_SESSIONS_JS
from .shared import (
    _CancelledError,
    _inject_helpers,
)

log = logging.getLogger(__name__)

_SEND_BTN_LOC = 'button[aria-label="发送消息"], button[aria-label="发送"]'


class QwenDriver(BaseSiteDriver):
    supports_delete = True

    # ---- 获取会话列表 ----

    async def list_sessions(self, mgr: Any, page: Any) -> list:
        """获取会话列表（data-session-switch-target="normal" + data-session-id）。"""
        await _inject_helpers(page)
        await self._navigate_and_wait(page, self.cfg["home"], self.cfg["home_path"])
        await asyncio.sleep(1.5)  # 侧栏渲染
        try:
            sessions = await page.evaluate(_QWEN_SESSIONS_JS)
        except Exception as e:
            raise RuntimeError(f"读取千问会话列表失败（页面可能正在加载，请稍后重试）：{e}")
        if not sessions:
            raise RuntimeError(
                '未能从千问侧栏识别到会话列表（data-session-switch-target="normal"，'
                "页面结构可能改版）。可在导入弹窗手动粘贴会话链接，或留空自动新建会话"
            )
        return sessions

    # ---- 删除会话 ----

    async def close_session(self, mgr: Any, page: Any, chat_id: str = "") -> dict:
        """删除会话：条目内 button → 删除入口 → 消失校验（确认弹窗兜底）。"""
        if not chat_id:
            raise RuntimeError("缺少 chat_id")
        await self._goto_home_for_sidebar(mgr, page)
        item = page.locator(f'div[data-session-switch-target="normal"][data-session-id="{chat_id}"]').first
        try:
            await item.wait_for(state="attached", timeout=8000)
        except Exception:
            raise RuntimeError(
                f"千问侧栏中未找到该会话（data-session-id={chat_id}）：可能已被删除，"
                "或会话过多被侧栏折叠（可在千问网页搜索该会话确认）"
            )
        try:
            try:
                await item.hover(timeout=4000)  # 操作按钮通常 hover 后才显示
            except Exception:
                pass
            await item.locator("button").first.click(timeout=5000)
        except Exception as e:
            raise RuntimeError(f"未能点击千问会话条目内的操作按钮（页面结构可能改版）：{e}")
        await asyncio.sleep(0.8)
        deleter = page.locator(f'div[data-session-switch-target="delete-session"][data-session-id="{chat_id}"]').first
        try:
            await deleter.click(timeout=8000)
        except Exception:
            raise RuntimeError(
                '未找到千问删除入口（div[data-session-switch-target="delete-session"]，'
                "页面结构可能改版）"
            )
        await asyncio.sleep(0.6)
        return await self._verify_session_gone(page, item, "千问")

    # ---- 获取消息（chat_id 兜底） ----

    async def get_reply(
        self,
        mgr: Any,
        page: Any,
        baseline: dict,
        expect_json: bool,
        timeout_s: float,
        cancelled,
    ) -> dict:
        """基类取回复 + chat_id 兜底。

        千问新建会话 URL 恒为 /chat/（不含 id），chat_id 需从侧栏「当前会话」
        高亮条目读取；侧栏条目可能晚于回复渲染，故回复成功但 chat_id 为空时
        短暂重试若干次（最多约 5s）。
        """
        reply = await super().get_reply(mgr, page, baseline, expect_json, timeout_s, cancelled)
        if reply.get("ok") and not reply.get("chat_id"):
            for _ in range(10):
                try:
                    cid = str(await page.evaluate("() => window.__mrdCdp.currentChatId()") or "")
                except Exception:
                    cid = ""
                if cid:
                    reply["chat_id"] = cid
                    log.debug("[WebChatCDP] qwen chat_id from sidebar: %s", cid)
                    break
                await asyncio.sleep(0.5)
        return reply

    # ---- 发送消息（站点特化写入与提交） ----

    async def _wait_send_enabled(self, page: Any) -> bool:
        """等待「发送消息」按钮可用（编辑器状态同步有延迟）。找不到按钮视为可用。"""
        for _ in range(6):
            try:
                st = await page.evaluate(_QWEN_SEND_STATE_JS)
            except Exception:
                return True
            if not st.get("found") or not st.get("disabled"):
                return True
            await asyncio.sleep(0.5)
        return False

    async def _write_text(self, page: Any, text: str, cancelled) -> bool:
        """千问写入：可信键盘输入（insert_text）+ 发送按钮可用性核验。

        千问编辑器是 Slate：fill 会破坏其内部状态（按钮不启用），禁用；
        只用可信键盘事件写入（Ctrl+A/Delete 清空 + insert_text）。
        """
        self._pending_text = text  # 供 _submit 在草稿被清空时重写
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
            except Exception:
                await asyncio.sleep(0.8)
                continue
            # 可信键盘清空 + 输入
            try:
                await page.keyboard.press("Control+a")
                await page.keyboard.press("Delete")
                await page.keyboard.insert_text(text)
            except Exception as e:
                log.debug("[WebChatCDP] qwen type retry: %s", e)
            await asyncio.sleep(0.4)
            if await self._readback_ok(loc, text) and await self._wait_send_enabled(page):
                return True
            # 键盘输入未生效 → 重试（fill 会破坏 Slate 内部状态，禁用；
            # 只允许可信键盘事件，下一轮重新聚焦清空再输入）
            await asyncio.sleep(0.6)
        return False

    async def _submit(self, page: Any, marker: str, baseline: dict, cancelled) -> None:
        """千问提交：优先点「发送消息」按钮。

        实测（CDP 复现）：回车在部分内容下不触发发送，反而会把草稿清空
        （输入框变空、无消息、URL 不变——千问新建会话不改 URL，始终 /chat/），
        而点发送按钮可靠。故按钮优先；若草稿被清空但消息没发出，重新写入再点。
        """
        for attempt in range(4):
            if cancelled():
                raise _CancelledError()
            if attempt:
                st = await self._sent_state(page, marker, baseline)
                pending = getattr(self, "_pending_text", "")
                if st is not None and int(st.get("inputLen") or 0) == 0 and pending:
                    # 草稿被站点清空但消息未发出 → 重新写入再提交
                    await self._write_text(page, pending, cancelled)
            try:
                # 优先点 findSendButton 打标的元素（与手工验证一致）；
                # 页面可能存在多个 aria-label="发送消息" 的按钮，直接按 CSS
                # 选择器取 .first 可能点到无效的那个（点后草稿被清但消息不发）
                mark = await page.evaluate("() => window.__mrdCdp.pickSendButton()")
                if mark and mark.get("found") and not mark.get("disabled"):
                    await page.locator('[data-mrd-send="1"]').first.click(timeout=5000)
                else:
                    await page.locator(_SEND_BTN_LOC).first.click(timeout=4000)
            except Exception as e:
                log.debug("[WebChatCDP] qwen send click: %s", e)
            await asyncio.sleep(2.0 if attempt == 0 else 1.5)
            if await self._sent_ok(page, marker, baseline):
                return
        # 兜底：基类通用重试（回车路径 + 通用按钮定位）
        await super()._submit(page, marker, baseline, cancelled)

    async def _sent_state(self, page: Any, marker: str, baseline: dict):
        """取 sentCheck 快照（异常返回 None）。"""
        try:
            return await page.evaluate(
                "([m, bm, pb]) => window.__mrdCdp.sentCheck(m, bm, pb)",
                [marker, baseline["before_marker"], baseline["path_before"]],
            )
        except Exception:
            return None
