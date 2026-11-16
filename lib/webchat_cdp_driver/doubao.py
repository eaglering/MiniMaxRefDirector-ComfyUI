"""DoubaoDriver: 豆包站点驱动。

- 获取会话列表：侧栏 a[href] 以 /chat/ 开头、后跟会话 id（基类锚点扫描即此规则）
- 删除会话：a[href="/chat/<id>"] 内 button[aria-label="更多"] 点击 → Ctrl+D 触发删除
  （确认弹窗兜底点「确定/删除」）
- 打开会话/发送消息/获取消息：基类公共链路；SSE 端点 samantha/chat、generic 解析器
  由 SITES 配置注入。页面结构改版时可在此覆写 _write_text/_submit/get_reply。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .base import BaseSiteDriver
from .pagescripts import _SCROLL_SIDEBAR_JS, _SIDEBAR_SESSIONS_JS
from .shared import _inject_helpers

log = logging.getLogger(__name__)


class DoubaoDriver(BaseSiteDriver):
    supports_delete = True

    async def list_sessions(self, mgr: Any, page: Any) -> list:
        """会话列表：侧栏行（class convention + data-testid）扫描。

        豆包侧栏是虚拟列表（只挂载可视区条目），先滚动到底部反复触发加载，
        条目数不再增长后再扫描，避免只拿到首屏十条。
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
                f"未能从 {self.name} 侧栏识别到会话列表（页面结构可能改版）。"
                "可在导入弹窗手动粘贴会话链接，或留空自动新建会话"
            )
        return sessions

    async def close_session(self, mgr: Any, page: Any, chat_id: str = "") -> dict:
        """删除会话：更多按钮 → Ctrl+D → 消失校验（确认弹窗兜底）。"""
        if not chat_id:
            raise RuntimeError("缺少 chat_id")
        await self._goto_home_for_sidebar(mgr, page)
        # 会话条目有两种形态：a[href="/chat/<id>"] 与带 group/conversation-item
        # 类的行（href 可能懒写入 / 拼接在子元素上），两者都要能定位
        anchor = page.locator(
            f'a[href*="/chat/{chat_id}"], '
            f'a[class*="conversation-item"][href*="{chat_id}"], '
            f'[data-testid="conversation-list-v2-item"]:has(a[href*="{chat_id}"])'
        ).first
        try:
            await anchor.wait_for(state="attached", timeout=8000)
        except Exception:
            raise RuntimeError(
                f"豆包侧栏中未找到该会话（/chat/{chat_id}）：可能已被删除，"
                "或会话过多被侧栏折叠（可在豆包网页搜索该会话确认）"
            )
        more = anchor.locator('button[aria-label="更多"]').first
        try:
            try:
                await anchor.hover(timeout=4000)  # 更多按钮通常 hover 后才显示
            except Exception:
                pass
            await more.click(timeout=5000)
        except Exception:
            # 部分版本按钮 hover 后才挂载：再悬停重试一次
            try:
                await anchor.hover(timeout=3000)
                await more.click(timeout=5000)
            except Exception as e:
                raise RuntimeError(f"未能点击豆包会话的「更多」按钮（页面结构可能改版）：{e}")
        await asyncio.sleep(0.8)
        await page.keyboard.press("Control+d")  # 站点快捷键：删除该会话
        await asyncio.sleep(0.8)
        return await self._verify_session_gone(page, anchor, "豆包")
