"""DeepseekDriver: DeepSeek 站点驱动（全页面模拟，无站内 API 调用）。

获取会话列表/删除会话与豆包/千问一致走 UI 模拟：
- 会话列表：首页侧栏滚动加载扫描（a[href*="/a/chat/s/"] 锚点 + 通用扫描脚本兜底）
- 删除会话：悬停条目 → 行内「更多」按钮 → 弹出菜单「删除」→ 确认弹窗兜底
  （DeepSeek 无 Ctrl+D 快捷键，菜单项无稳定 role/class，用启发式定位 + 可信事件点击）
打开会话/发送消息/获取消息用基类公共链路；SSE 解析器为 deepseek 私有协议。

不再调用 chat.deepseek.com 站内 API（/api/v0/chat_session/*）：带 cookie/Token
的高频程序化请求存在封号风险。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .base import BaseSiteDriver
from .pagescripts import (
    _CONFIRM_DELETE_JS,
    _DS_DELETE_ITEM_JS,
    _DS_MORE_BUTTON_JS,
    _SCROLL_SIDEBAR_JS,
    _SIDEBAR_SESSIONS_JS,
)
from .shared import _inject_helpers

log = logging.getLogger(__name__)


class DeepseekDriver(BaseSiteDriver):
    parse_mode = "deepseek"
    session_source = "ui"  # 页面模拟（曾为 "api"，站内 API 有封号风险已移除）
    supports_delete = True

    async def list_sessions(self, mgr: Any, page: Any) -> list:
        """会话列表：侧栏滚动加载扫描（与豆包同构）。

        DeepSeek 侧栏为虚拟列表（只挂载可视区条目），先反复滚动到底部触发加载，
        条目数不再增长后再扫描。
        """
        await _inject_helpers(page)
        await self._navigate_and_wait(page, self.cfg["home"], self.cfg["home_path"])
        await asyncio.sleep(1.5)  # 侧栏渲染
        prev = -1
        for _ in range(12):
            try:
                count = int(await page.evaluate(_SCROLL_SIDEBAR_JS) or 0)
            except Exception:
                break
            await asyncio.sleep(0.8)
            if count <= prev:
                break
            prev = count
        try:
            sessions = await page.evaluate(_SIDEBAR_SESSIONS_JS)
        except Exception as e:
            raise RuntimeError(f"读取 {self.name} 会话列表失败（页面可能正在加载，请稍后重试）：{e}")
        if not sessions:
            raise RuntimeError(
                f"未能从 {self.name} 侧栏识别到会话列表（页面结构可能改版或未登录）。"
                "可在导入弹窗手动粘贴会话链接，或留空自动新建会话"
            )
        return sessions

    async def close_session(self, mgr: Any, page: Any, chat_id: str = "") -> dict:
        """删除会话：悬停条目 → 更多按钮 → 菜单「删除」→ 确认弹窗兜底 + 消失校验。

        全程 Playwright 可信事件（isTrusted=true），无任何站内 API 调用。
        """
        if not chat_id:
            raise RuntimeError("缺少 chat_id")
        await self._goto_home_for_sidebar(mgr, page)
        anchor = page.locator(f'a[href*="{chat_id}"]').first
        try:
            await anchor.wait_for(state="attached", timeout=8000)
        except Exception:
            raise RuntimeError(
                f"DeepSeek 侧栏中未找到该会话（href 含 {chat_id}）：可能已被删除，"
                "或会话过多被侧栏折叠（可在网页内搜索该会话确认）"
            )

        # 1) 悬停显示操作按钮
        try:
            await anchor.hover(timeout=4000)
        except Exception:
            pass
        await asyncio.sleep(0.5)

        # 2) 标记行内「更多」按钮候选并逐个尝试（启发式，无稳定选择器）
        tagged = await page.evaluate(_DS_MORE_BUTTON_JS, chat_id)
        if not tagged.get("found"):
            raise RuntimeError(
                "DeepSeek 会话条目上未找到「更多」按钮（页面结构可能改版）："
                "请刷新页面后在该网页内手动删除该会话"
            )
        deleted = False
        last_err = ""
        for idx in range(int(tagged.get("count") or 1)):
            cand = page.locator("[data-mrd-more]").nth(idx)
            try:
                try:
                    await anchor.hover(timeout=2000)  # 悬停态丢失会导致按钮隐藏
                except Exception:
                    pass
                await cand.click(timeout=4000)
            except Exception as e:
                last_err = str(e)
                continue
            await asyncio.sleep(0.8)
            # 3) 弹出菜单中点「删除」
            item = await page.evaluate(_DS_DELETE_ITEM_JS)
            if not item.get("found"):
                continue
            menu = page.locator("[data-mrd-del]").first
            try:
                await menu.click(timeout=4000)
            except Exception as e:
                last_err = str(e)
                continue
            await asyncio.sleep(0.5)
            # 4) 确认弹窗兜底（_CONFIRM_DELETE_JS 在 _verify_session_gone 内轮询点击）
            result = await self._verify_session_gone(page, anchor, "DeepSeek")
            deleted = True
            log.info("[WebChatCDP] DeepSeek 会话 %s 已删除（UI 模拟，候选 #%d）", chat_id[:8], idx)
            return result
        if not deleted:
            raise RuntimeError(
                f"DeepSeek 删除会话未完成（更多按钮/删除菜单点击失败：{last_err or '未找到「删除」菜单项'}）。"
                "请刷新页面后在该网页内手动确认删除"
            )
        return {"ok": True}
