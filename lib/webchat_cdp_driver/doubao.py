"""DoubaoDriver: 豆包站点驱动（完全自包含，无跨驱动共享代码）。

本驱动独立实现全部链路（页面 JS / 元素选择器 / SSE 协议 / 会话与发送流程），
修改本文件的常量不影响 DeepSeek/千问驱动：

- 页面助手：window.__mrdCdp（豆包专用 SITE 与回复块选择器
  [data-testid="receive_message"] [data-testid="message_text_content"]）
- 会话列表：侧栏 a[href] 以 /chat/ 开头、后跟会话 id（锚点 + 行元素扫描）
- 删除会话：a[href="/chat/<id>"] 内 button[aria-label="更多"] 点击 → Ctrl+D 触发删除
  （确认弹窗兜底点「确定/删除」）
- SSE 协议：generic 行解析（finish 事件 + 递归抽取 content/text，跳过推理字段）
- 打开/发送/获取消息：fill 写入 + 回车/发送按钮提交 + SSE/DOM 双通道读取
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

from .base import (
    NOT_JSON_GRACE_S,
    NO_SIGNAL_S,
    MAX_TEXT,
    BaseSiteDriver,
    _CancelledError,
    sse_state,
)

log = logging.getLogger(__name__)

# 页面助手总入口（写入 window.__mrdCdp；豆包专用 SITE 与回复块选择器）
_PAGE_JS = r"""
() => {
  const SITE = { id: "doubao", name: "豆包", chatIdRe: /\/chat\/([0-9A-Za-z_-]+)/, sessionApi: false };

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function inputText(input) {
    if (!input) return "";
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") return input.value || "";
    const clone = input.cloneNode(true);
    clone.querySelectorAll("[data-slate-placeholder], [data-placeholder]").forEach((n) => n.remove());
    return (clone.innerText || "").replace(/\u00a0/g, " ").trim();
  }

  // 豆包专用输入框：composer 唯一的 div[contenteditable='true']，选中后打
  // data-mrd-input="1" 标记，后续一律按标记取（不做启发式打分猜测）。
  function findInput() {
    return (
      document.querySelector("[data-mrd-input]") ||
      document.querySelector("div[contenteditable='true']")
    );
  }

  function pickInput() {
    document.querySelectorAll("[data-mrd-input]").forEach((e) => e.removeAttribute("data-mrd-input"));
    const el = document.querySelector("div[contenteditable='true']");
    if (!el) return { found: false };
    el.setAttribute("data-mrd-input", "1");
    return { found: true, tag: el.tagName, id: el.id || "", len: inputText(el).length };
  }

  function currentInput() {
    return findInput();
  }

  // 生成中判定（豆包专用）：发送/停止按钮为 button[data-testid="chat_input_send_button"]，
  // data-disabled="true" 即生成中（点击发送后 1-2s 才切换，属正常过渡）。
  // 按钮不存在时返回 false（fail-open，不阻塞发送）。
  function generating() {
    const btn = document.querySelector('button[data-testid="chat_input_send_button"]');
    return !!btn && btn.getAttribute("data-disabled") === "true";
  }

  // 豆包专用：发送/停止按钮唯一入口 button[data-testid="chat_input_send_button"]，
  // 生成停止态（data-disabled="true"）不可点。不做通用文案/位置猜测（那是
  // deepseek 通用实现的思路，对豆包只会误判）。
  function findSendButton(input) {
    const btn = document.querySelector('button[data-testid="chat_input_send_button"]');
    if (btn && isVisible(btn) && btn.getAttribute("data-disabled") !== "true") return btn;
    return null;
  }

  function currentChatId() {
    const m = (location.pathname || "").match(SITE.chatIdRe);
    if (m) return m[1];
    return "";
  }

  // 计数前对正文与特征文本都做空白归一化：豆包气泡保留提示词换行，而 marker
  // 在 Python 侧已把换行压成空格，不归一化则多行提示词永远匹配不上
  function normSpace(s) {
    return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  }

  function countInBody(marker) {
    if (!marker) return 0;
    const body = normSpace((document.body && document.body.innerText) || "");
    const m = normSpace(marker);
    return body ? body.split(m).length - 1 : 0;
  }

  function countInText(text, marker) {
    if (!text || !marker) return 0;
    const t = normSpace(text);
    const m = normSpace(marker);
    return t ? t.split(m).length - 1 : 0;
  }

  function blockText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("span.linenumber, [class*='line-number'], [class*='linenumber']").forEach((n) => n.remove());
    clone.querySelectorAll("button, [class*='copy'], [class*='toolbar']").forEach((n) => n.remove());
    clone.querySelectorAll("pre").forEach((pre) => {
      let box = pre.parentElement;
      for (let i = 0; i < 3 && box && box !== clone; i++) {
        if (box.querySelector("button, [class*='copy']")) {
          [...box.children].forEach((ch) => { if (ch !== pre) ch.remove(); });
          break;
        }
        box = box.parentElement;
      }
    });
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none;" +
      `width:${Math.max(el.clientWidth || 0, 600)}px;`;
    host.appendChild(clone);
    document.body.appendChild(host);
    const text = clone.innerText || clone.textContent || "";
    host.remove();
    return text
      .replace(/\u00a0/g, " ")
      .replace(/^(json|javascript|python|java|cpp|c|js|ts|typescript|xml|html|css|yaml|yml|bash|shell|sql|markdown|md|plain|text)\s*\n/i, "")
      .trim();
  }

  // 豆包：消息正文统一挂 [data-testid="message_text_content"]，用户气泡与助手
  // 回复都带此 testid，必须用 receive_message 祖先限定排除用户消息。会话区虚拟
  // 滚动只挂载最近约 3 条，最后一个即为最新回复 —— 回复等待/拉取只依赖最后
  // 一条，截断不影响判定。
  function blockSel() {
    return '[data-testid="receive_message"] [data-testid="message_text_content"]';
  }

  function assistantBlocks() {
    return [...document.querySelectorAll(blockSel())].map(blockText).filter((t) => t);
  }

  function inputReady() {
    const input = findInput();
    return {
      ready: !!(input && isVisible(input) && !(input.disabled || input.readOnly === true)),
      path: location.pathname,
      chatId: currentChatId(),
    };
  }

  function sentCheck(marker, beforeMarker, pathBefore) {
    const input = currentInput();
    const text = input ? inputText(input) : "";
    const empty = !input || !text;
    const btn = input ? findSendButton(input) : null;
    const blocks = assistantBlocks();
    // marker 计数剔除输入框自身的草稿文本：baseline 取自输入框为空时，
    // 不剔除则填入草稿后总计数 +1，会把「尚未发送」误判成「已上屏」
    const markerCount = Math.max(0, countInBody(marker) - countInText(text, marker));
    return {
      inputEmpty: empty,
      inputLen: text.length,
      sendBtnFound: !!btn,
      sendBtnDisabled: btn
        ? btn.getAttribute("aria-disabled") === "true" || btn.hasAttribute("disabled")
          || btn.getAttribute("data-disabled") === "true"
        : false,
      markerCount,
      markerAppeared: markerCount > (Number(beforeMarker) || 0),
      pathChanged: location.pathname !== String(pathBefore || ""),
      blockCount: blocks.length,
      // 发送轮次：每条已发送消息挂 button[data-index-entry-key]；助手回复块会
      // 因虚拟滚动最多只挂载约 3 条，不能用作轮次计数
      roundCount: document.querySelectorAll("button[data-index-entry-key]").length,
      generating: generating(),
      chatId: currentChatId(),
    };
  }

  function domSnapshot(beforeCount, beforeLast) {
    // 虚拟滚动下 blockCount 恒为挂载上限（约 3），新旧判定主要靠 lastBlockText
    // 与 baseline before_last 的文本比较
    const blocks = assistantBlocks();
    const last = blocks.length ? blocks[blocks.length - 1] : "";
    const isNew = !!last && (blocks.length > (beforeCount || 0) || last !== (beforeLast || ""));
    return {
      blockCount: blocks.length,
      lastBlockText: last,
      lastBlockChanged: isNew && last !== (beforeLast || ""),
      generating: generating(),
      chatId: currentChatId(),
      path: location.pathname,
    };
  }

  function probe() {
    const input = findInput();
    const btn = findSendButton(input);
    const blocks = assistantBlocks();
    return {
      url: location.href,
      title: document.title,
      loggedIn: !document.querySelector("button[class*='login'], a[href*='login']") || blocks.length > 0 || !!input,
      inputFound: !!input,
      inputKind: input ? input.tagName : "",
      sendButtonFound: !!btn,
      sendButtonLabel: btn ? (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").slice(0, 40) : "",
      assistantBlocks: blocks.length,
      chatId: currentChatId(),
    };
  }

  window.__mrdCdp = {
    SITE,
    pickInput,
    inputReady,
    sentCheck,
    domSnapshot,
    generating,
    probe,
    currentChatId,
    countInBody,
    assistantBlocks,
    blockText,
  };
  return true;
}
"""

# 豆包：侧栏会话扫描
# 两类入口并行：
# 1) 会话行元素（data-testid="conversation-list-v2-item" / class 含 conversation-item
#    —— 豆包侧栏条目的 class 是 group/conversation-item，只看 a[href] 会漏掉
#    href 尚未写入（懒渲染）的条目）；
# 2) a[href] 兜底，但过滤 cron-jobs / skills / drive 等非会话伪链接。
_SIDEBAR_SESSIONS_JS = r"""
() => {
  const SITE = window.__mrdCdp.SITE;
  const out = [];
  const seen = new Set();
  // 标题重复问题：豆包条目 textContent 常把标题渲染 3 份（主对话主对话主对话）
  const dedupe = (s) => {
    for (let k = 1; k <= s.length; k++) {
      if (s.length % k === 0 && s.slice(0, k).repeat(s.length / k) === s) return s.slice(0, k);
    }
    return s;
  };
  const titleOf = (el) => {
    const cands = [...el.querySelectorAll('[class*="text-ellipsis"], [class*="ellipsis"], [class*="truncate"]')]
      .map((n) => (n.textContent || "").trim())
      .filter(Boolean);
    const raw = cands.length ? cands[0] : (el.textContent || "");
    return dedupe(String(raw).trim().replace(/\s+/g, " ")).slice(0, 80);
  };
  const PSEUDO = /^(cron-jobs|skills|drive|chat|new|login|workbench)$/i;
  const push = (id, title) => {
    if (!id || PSEUDO.test(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ id, title: String(title || "").trim(), updatedAt: null });
  };
  const idOf = (el) => {
    const own = el.getAttribute && el.getAttribute("href");
    if (own) {
      const m = own.match(SITE.chatIdRe);
      if (m) return m[1];
    }
    const a = el.querySelector && el.querySelector("a[href]");
    if (a) {
      const m = (a.getAttribute("href") || "").match(SITE.chatIdRe);
      if (m) return m[1];
    }
    for (const attr of ["data-session-id", "data-conversation-id", "data-chat-id", "data-id"]) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) {
        const m = String(v).match(/([0-9A-Za-z_-]{8,})/);
        if (m) return m[1];
      }
    }
    return "";
  };
  const rows = [
    ...document.querySelectorAll('[data-testid="conversation-list-v2-item"]'),
    ...document.querySelectorAll('[class*="conversation-item"]'),
  ];
  for (const row of rows) {
    if (!row.isConnected) continue;
    const r = row.getBoundingClientRect();
    if (r.height < 12 || r.height > 160) continue;
    const id = idOf(row);
    if (id) push(id, titleOf(row));
  }
  for (const a of document.querySelectorAll("a[href]")) {
    if (!a.isConnected) continue;
    const m = (a.getAttribute("href") || "").match(SITE.chatIdRe);
    if (m) push(m[1], titleOf(a));
  }
  const cur = window.__mrdCdp.currentChatId();
  if (cur) push(cur, document.title || "");
  return out;
}
"""

# 豆包：侧栏滚动加载更多（虚拟列表只挂载可视区条目）：返回当前已挂载条目数
_SCROLL_SIDEBAR_JS = r"""
() => {
  let els = [...document.querySelectorAll('[data-testid="conversation-list-v2-item"]')];
  if (!els.length) {
    els = [...document.querySelectorAll('a[href]')].filter((a) => {
      if (!(a.getAttribute("href") || "").match(/\/chat\/[0-9A-Za-z_-]+/)) return false;
      return a.getBoundingClientRect().height > 8;
    });
  }
  if (!els.length) return 0;
  let box = els[0].parentElement;
  while (box && box !== document.body) {
    const s = getComputedStyle(box);
    if ((s.overflowY === "auto" || s.overflowY === "scroll") && box.scrollHeight > box.clientHeight + 20) break;
    box = box.parentElement;
  }
  if (!box || box === document.body) {
    try { els[els.length - 1].scrollIntoView({ block: "end" }); } catch (e) {}
  } else {
    box.scrollTop = box.scrollHeight;
  }
  return els.length;
}
"""

# 确认弹窗兜底：仅在弹窗/浮层容器内点「确定/确认/删除」
_CONFIRM_DELETE_JS = r"""
() => {
  const texts = ["确定", "确认", "删除"];
  const containers = document.querySelectorAll(
    '[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popover"], [class*="confirm"]'
  );
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  for (const c of containers) {
    if (!visible(c)) continue;
    for (const b of c.querySelectorAll("button, [role=button], [class*=btn], [class*=button]")) {
      const t = String(b.innerText || b.textContent || "").trim();
      if (!t || !visible(b)) continue;
      if (texts.some((x) => t.includes(x))) {
        b.click();
        return t;
      }
    }
  }
  return "";
}
"""


def _norm_path(p: str) -> str:
    return (p[: -1] if p and len(p) > 1 and p.endswith("/") else p) or "/"


def _marker_of(text: str) -> str:
    """用户消息特征文本（去掉 Markdown 记号，与扩展 driveFillAndCollect 一致）。"""
    return re.sub(r"\s+", " ", re.sub(r"[`*#>~_|-]", " ", str(text))).strip()[:20]


# 发送核验窗口：深度思考启动可能慢于旧版 12 轮 ≈18.5s 的轮询总时长
_SUBMIT_VERIFY_WINDOW_S = 45.0


def _looks_json_complete(text: str) -> bool:
    """文本里是否已出现配平的 {...}（跳过字符串字面量）。"""
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


class DoubaoDriver(BaseSiteDriver):
    supports_delete = True

    # ---- 页面 JS 助手 ----

    async def inject_helpers(self, page: Any) -> None:
        """注入豆包页面 JS 助手（幂等；goto 后需重新调用）。"""
        for _ in range(20):
            try:
                ok = await page.evaluate(_PAGE_JS)
                if ok:
                    return
            except Exception:
                pass
            await asyncio.sleep(0.5)
        raise RuntimeError("页面 JS 助手注入失败（页面可能未加载完成）")

    # ---- SSE 协议（generic：finish 事件 + 递归抽取 content/text） ----

    _REASONING_RE = re.compile(r"think|reason|thought|cot|reflect", re.I)
    _REASONING_KEY_RE = re.compile(r"think|reason|thought|cot", re.I)

    def parse_sse_body(self, body: str, state: dict) -> None:
        """解析 generic SSE 文本，累积正文到 state（移植 page-hook 行解析器）。"""
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
            st = str(obj.get("finish_reason") or obj.get("status") or obj.get("event") or "").lower()
            if st in ("finished", "done", "complete", "stop"):
                state["finished"] = True
            if obj.get("is_finish") is True or obj.get("finished") is True:
                state["finished"] = True
            out: list = []
            self._walk_extract(obj, out, 0)
            for s in out:
                if s and len(state["text"]) < MAX_TEXT:
                    state["text"] += s

    def _walk_extract(self, node: Any, out: list, depth: int) -> None:
        if depth > 12 or len(out) > 2000:
            return
        if isinstance(node, str):
            out.append(node)
            return
        if isinstance(node, list):
            for x in node:
                self._walk_extract(x, out, depth + 1)
            return
        if not isinstance(node, dict):
            return
        for k, v in node.items():
            if self._REASONING_KEY_RE.search(str(k)):
                continue
            if k in ("content", "text") and isinstance(v, str):
                out.append(v)
            else:
                self._walk_extract(v, out, depth + 1)

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
                    await self.inject_helpers(page)
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
        """打开会话：chat_id 为空 → 回首页；否则导航到会话页。返回解析出的 chat_id。"""
        await self.inject_helpers(page)
        if chat_id:
            await self._navigate_and_wait(page, self.cfg["chat_url"](chat_id), self.cfg["chat_path"](chat_id))
            await self._wait_input_ready(page, want_home=False)
        else:
            await self._navigate_and_wait(page, self.cfg["home"], self.cfg["home_path"])
            await self._wait_input_ready(page, want_home=True)
        return self._chat_id_from_url(page)

    async def list_sessions(self, mgr: Any, page: Any) -> list:
        """会话列表：侧栏行（class convention + data-testid）扫描。

        豆包侧栏是虚拟列表（只挂载可视区条目），先滚动到底部反复触发加载，
        条目数不再增长后再扫描，避免只拿到首屏十条。
        """
        await self.inject_helpers(page)
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
            return []
        return sessions

    async def _goto_home_for_sidebar(self, mgr: Any, page: Any) -> None:
        """删除流程前置：回到首页并等侧栏/输入框就绪。"""
        await self.inject_helpers(page)
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

    # ---- 发送消息 ----

    async def send_prompt(self, mgr: Any, page: Any, text: str, cancelled) -> dict:
        """发送消息（等待空闲 + 写入 + 提交 + 核验）。失败/取消抛异常。"""
        mgr.reset_sse(page)
        # 关键修复：上一轮仍在生成时发送会被豆包静默丢弃（发送按钮处于「停止」态，
        # Enter / 发送按钮均不生效）。批量转 H3 第 3 条以后必现——会话越长生成越慢、
        # 流式停顿越长，get_reply 的 DOM 稳定判定越容易提前返回，下一镜就会在
        # 生成中写入。先等「停止」按钮消失再发送（纯前置条件，不是重试）。
        await self._wait_generation_idle(page, cancelled)
        marker = _marker_of(text)
        before = await page.evaluate(
            "([m]) => { const blocks = window.__mrdCdp.assistantBlocks();"
            " return { beforeCount: blocks.length, beforeLast: blocks.length ? blocks[blocks.length - 1] : '',"
            " beforeMarker: window.__mrdCdp.countInBody(m), pathBefore: location.pathname,"
            " beforeRounds: document.querySelectorAll('button[data-index-entry-key]').length }; }",
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

    async def _wait_generation_idle(self, page: Any, cancelled, max_wait: float = 90.0) -> None:
        """等待豆包上一轮生成结束（发送按钮停止态 data-disabled="true" 消失）再发送。

        生成中写入的消息会被站点静默丢弃；这里最多等 max_wait 秒（深度思考
        一般不超过此限），超时则告警并照常尝试发送（由 _submit 的核验兜底）。
        """
        deadline = time.monotonic() + max_wait
        warned = False
        while time.monotonic() < deadline:
            if cancelled():
                raise _CancelledError()
            try:
                busy = bool(await page.evaluate("() => window.__mrdCdp.generating()"))
            except Exception:
                return  # 助手未就绪 / 页面异常时不阻塞发送
            if not busy:
                return
            if not warned:
                log.info("[WebChatCDP] %s 上一轮仍在生成，等待其结束后再发送", self.name)
                warned = True
            await asyncio.sleep(2.0)
        log.warning(
            "[WebChatCDP] %s 等待上一轮生成结束超时（%.0fs），仍尝试发送", self.name, max_wait)

    async def _write_text(self, page: Any, text: str, cancelled) -> bool:
        """写入输入框（locator.fill 可信事件，带回读校验重试）。"""
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
        """回读校验：输入框内容与提示词一致（空白归一后比对，容忍编辑器重排）。

        contenteditable 编辑器会把写入的多行文本重排（空行段落化 / 换行归一 /
        零宽字符），逐字面比对会把"其实已写入"误判为失败；比较前压掉全部空白，
        只比内容字符。
        """
        read_back = await loc.evaluate(
            "el => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? (el.value || '') : (el.innerText || '').trim()"
        )
        if not read_back:
            return False
        norm_read = re.sub(r"[\s\u200b-\u200f\u2060\ufeff]+", "", read_back)
        norm_text = re.sub(r"[\s\u200b-\u200f\u2060\ufeff]+", "", text)
        prefix_ok = norm_text.startswith(norm_read[:40])
        len_ok = len(norm_read) == len(norm_text)
        if not (prefix_ok or len_ok):
            log.warning(
                "[WebChatCDP] %s 回读不一致：输入框 %d 字（%r…）vs 提示词 %d 字（%r…）",
                self.name, len(read_back), read_back[:40], len(text), text[:40],
            )
        return prefix_ok or len_ok

    async def _submit(self, page: Any, marker: str, baseline: dict, cancelled) -> None:
        """提交消息（回车 → 补回车 → 通用发送按钮）。

        每轮都先核验「已上屏」信号，不以输入框清空为前提（旧实现的互斥分支曾让
        已发送的消息被判失败）；输入框未清空只决定是否补发动作。判定条件：
        输入框已清空 + 任一信号（生成中 / 新助手块 / 消息上屏 / 路径变化）。
        """
        submits = 0
        deadline = time.monotonic() + _SUBMIT_VERIFY_WINDOW_S
        last_snap: dict = {}
        while time.monotonic() < deadline:
            if cancelled():
                raise _CancelledError()
            if submits == 0:
                try:
                    await page.keyboard.press("Enter")
                except Exception:
                    pass
                submits = 1
            await asyncio.sleep(2.0)
            try:
                s = await page.evaluate(
                    "([m, bm, pb]) => window.__mrdCdp.sentCheck(m, bm, pb)",
                    [marker, baseline["before_marker"], baseline["path_before"]],
                )
            except Exception:
                continue
            last_snap = s if isinstance(s, dict) else {}
            if s and s.get("inputEmpty"):
                if (s.get("generating") or s.get("markerAppeared") or s.get("pathChanged")
                        or int(s.get("blockCount") or 0) > baseline["before_count"]
                        or int(s.get("roundCount") or 0) > int(baseline.get("before_rounds") or 0)):
                    return
                # 已清空但信号未到（如深度思考尚未流式输出）：继续等，不盲目补发
                continue
            # 输入框仍有内容：补发（补回车一次，再点发送按钮，各限一次防重复）
            if submits == 1:
                submits = 2
                try:
                    await page.keyboard.press("Enter")
                except Exception:
                    pass
                continue
            if submits < 4:
                submits += 1
                try:
                    await page.locator('button[data-testid="chat_input_send_button"]').first.click(
                        timeout=5000
                    )
                except Exception:
                    pass
        swallowed = bool(last_snap) and bool(last_snap.get("inputEmpty")) and (
            int(last_snap.get("blockCount") or 0) == int(baseline.get("before_count") or 0)
            and int(last_snap.get("roundCount") or 0) == int(baseline.get("before_rounds") or 0)
            and not last_snap.get("generating")
        )
        log.warning(
            "[WebChatCDP] %s 发送核验失败（baseline: before_count=%s before_rounds=%s before_marker=%s），"
            "最后一轮快照：%s",
            self.name,
            baseline.get("before_count"), baseline.get("before_rounds"), baseline.get("before_marker"),
            {k: last_snap.get(k) for k in ("inputEmpty", "inputLen", "markerCount", "markerAppeared",
                                           "blockCount", "roundCount", "generating", "pathChanged", "chatId")},
        )
        if swallowed:
            # 输入框被清空但会话内毫无变化（无气泡 / 无生成 / 无回复块）：
            # 站点静默吞消息（高频连发风控），不是检测问题。文案保留「发送未生效」
            # 以命中 _RISK_ERROR_WORDS，继续走前端 risk 弹窗（拉取 / 重试 / 跳过）。
            raise RuntimeError(
                "发送未生效（疑似风控吞消息）：输入框已清空，但会话内未出现这条消息、"
                "也未开始任何生成（等待 45s 无任何变化）。建议冷却 1-2 分钟后再重试该镜"
            )
        raise RuntimeError(
            "发送未生效：已回车并补点发送按钮（含重试），但输入框始终未清空、页面上也没出现这条消息。"
            f"常见原因：页面结构改版导致发送按钮/输入框定位偏移。请在 {self.name} 页面手动粘贴发送一次确认页面可用"
        )

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
        """获取消息：SSE 主通道 + DOM 回复块稳定性兜底。取消抛 _CancelledError。"""
        sse = getattr(page, "_mrd_sse", None) or sse_state()
        before_count = int(baseline.get("before_count") or 0)
        before_last = str(baseline.get("before_last") or "")
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
                if not expect_json or _looks_json_complete(sse_text):
                    return {"ok": True, "text": sse_text, "chat_id": str(dom.get("chatId") or ""), "error": ""}
                if not not_json_at:
                    not_json_at = time.monotonic()
                elif time.monotonic() - not_json_at > NOT_JSON_GRACE_S:
                    return {"ok": True, "text": sse_text, "chat_id": str(dom.get("chatId") or ""), "error": ""}
            stable_need = 3.0 if not sse.get("active") else 8.0
            # 生成中（发送按钮处于停止态）不得因 DOM 短暂稳定而提前返回：深度思考
            # / 流式停顿期间 DOM 可能数十秒不变，提前返回会让下一镜在生成中发送
            # 而被静默丢弃（批量转 H3 第 3 条以后失败的根因）。生成中持续重置
            # 稳定计时；但生成态持续超过 60s 且 DOM 无任何变化时按已完成处理
            # （停止态残留兜底，避免死等；深度思考单次停顿一般不超过此限）。
            if dom.get("generating") and time.monotonic() - stable_since < 60.0:
                stable_since = time.monotonic()

            def _json_pending() -> bool:
                return bool(expect_json and not _looks_json_complete(last_text))

            cur = str(dom.get("lastBlockText") or "")
            # 虚拟滚动下 blockCount 恒为挂载上限（约 3），新回复判定主要靠与
            # baseline before_last 的文本比较（最后一个 message_text_content
            # 即最新回复）
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

    async def last_reply(self, mgr: Any, page: Any) -> dict:
        """读取当前会话最后一条助手回复（不发送任何消息）。

        风控失败后的补救拉取：等 DOM 连续两轮快照一致视为稳定（站点可能仍在
        流式渲染）。拉到的可能是上一条提问的旧回复，由前端做串轮判定。
        """
        await self.inject_helpers(page)
        last, stable = "", 0
        for _ in range(20):
            try:
                blocks = await page.evaluate("() => window.__mrdCdp.assistantBlocks()")
            except Exception:
                blocks = []
            cur = str(blocks[-1]) if blocks else ""
            if cur and cur == last:
                stable += 1
                if stable >= 2:
                    return {"ok": True, "text": cur, "error": "", "risk": False}
            else:
                stable = 0
            last = cur
            await asyncio.sleep(0.5)
        if last:
            return {"ok": True, "text": last, "error": "", "risk": False}
        return {"ok": False, "text": "", "error": "会话中没有找到助手回复", "risk": False}
