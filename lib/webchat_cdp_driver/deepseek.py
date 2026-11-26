"""DeepseekDriver: DeepSeek 站点驱动（完全自包含，无跨驱动共享代码）。

本驱动独立实现全部链路（页面 JS / 元素选择器 / SSE 协议 / 会话与发送流程），
修改本文件的常量不影响豆包/千问驱动：

- 页面助手：window.__mrdCdp（DeepSeek 专用选择器）
- 会话列表：首页侧栏滚动加载扫描（a[href*="/a/chat/s/"] 锚点 + 行扫描兜底）
- 删除会话：悬停条目 → 锚点内 div[role="button"]（更多）→ 菜单
  .ds-dropdown-menu-option--error（删除）→ 确认弹窗「删除该对话」（.ds-button--error）
  → 侧栏条目消失校验；逐步精确选择器，任一步失败立即报错不跳步
- SSE 协议：DeepSeek 私有协议（p: "response/think..." 排除、v: content 累积）

不再调用 chat.deepseek.com 站内 API（/api/v0/chat_session/*）：带 cookie/Token
的高频程序化请求存在封号风险。
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

# 发送核验窗口（秒）：回车/点发送后等待「已上屏」信号的时间预算。
# 深度思考从发送到生成态亮起可能数秒，旧 18.5s 窗口不够用；45s 兜底。
_SUBMIT_VERIFY_WINDOW_S = 45.0

# 页面助手总入口（写入 window.__mrdCdp；DeepSeek 专用 SITE 与选择器）
_PAGE_JS = r"""
() => {
  const SITE = { id: "deepseek", name: "DeepSeek", chatIdRe: /\/a\/chat\/s\/([0-9A-Za-z_-]+)/, sessionApi: false };

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

  // DeepSeek 新版输入框：textarea[name="search"]（旧版 id=chat-input 已不存在）。
  // 选中后打 data-mrd-input="1" 标记，后续一律按标记取。
  function findInput() {
    return (
      document.querySelector("[data-mrd-input]") ||
      document.querySelector('textarea[name="search"]')
    );
  }

  function pickInput() {
    document.querySelectorAll("[data-mrd-input]").forEach((e) => e.removeAttribute("data-mrd-input"));
    const el = document.querySelector('textarea[name="search"]');
    if (!el) return { found: false };
    el.setAttribute("data-mrd-input", "1");
    return { found: true, tag: el.tagName, id: el.id || "", len: inputText(el).length };
  }

  function currentInput() {
    return findInput();
  }

  // DeepSeek 新版发送按钮：div[role="button"].ds-button--primary.ds-button--circle
  function sendButtonEl() {
    return document.querySelector('div[role="button"].ds-button--primary.ds-button--circle');
  }

  function sendBtnDisabled(btn) {
    // ds-button--disabled 类 = 输入框无内容的禁用态（非生成中）
    return !!btn && btn.classList.contains("ds-button--disabled");
  }

  // 内联 md5（hex）：把 svg path 的 d 属性指纹化后与已知图标哈希比对
  function md5(str) {
    const rotl = (n, s) => (n << s) | (n >>> (32 - s));
    const K = new Array(64);
    for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const utf8 = unescape(encodeURIComponent(String(str)));
    const bytes = [];
    for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i) & 0xff);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const lenLo = bitLen >>> 0, lenHi = Math.floor(bitLen / 4294967296);
    for (let i = 0; i < 4; i++) bytes.push((lenLo >>> (8 * i)) & 0xff);
    for (let i = 0; i < 4; i++) bytes.push((lenHi >>> (8 * i)) & 0xff);
    let a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;
    for (let off = 0; off < bytes.length; off += 64) {
      const M = new Array(16);
      for (let i = 0; i < 16; i++) {
        M[i] = (bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24)) | 0;
      }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[(i >> 4) * 4 + (i % 4)])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return [a0, b0, c0, d0].map((v) => {
      let h = "";
      for (let i = 0; i < 4; i++) h += ((v >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
      return h;
    }).join("");
  }

  // 生成中判定：按钮内出现 .ds-loading → 加载中（生成中）；svg path d 指纹命中
  // 生成中图标 → 生成中；ds-button--disabled（无输入禁用态）或待发送图标 → false；
  // 图标哈希都不匹配 → false（fail-open，不阻塞发送）
  const DS_SEND_ICON_MD5 = "f75f13feeb6c74f411e2d0e9f9b9030a";
  const DS_GENERATING_ICON_MD5 = "48967a962b67d4a56d53a5d09d965125";

  function generating() {
    const btn = sendButtonEl();
    if (!btn) return false;
    if (btn.querySelector(".ds-loading")) return true;
    if (sendBtnDisabled(btn)) return false;
    for (const p of btn.querySelectorAll("svg path")) {
      const d = p.getAttribute("d") || "";
      if (!d) continue;
      const h = md5(d);
      if (h === DS_GENERATING_ICON_MD5) return true;
      if (h === DS_SEND_ICON_MD5) return false;
    }
    return false;
  }

  function findSendButton(input) {
    const btn = sendButtonEl();
    if (btn && isVisible(btn) && !sendBtnDisabled(btn)) return btn;
    return null;
  }

  function pickSendButton() {
    document.querySelectorAll("[data-mrd-send]").forEach((e) => e.removeAttribute("data-mrd-send"));
    const btn = findSendButton();
    if (!btn) return { found: false };
    btn.setAttribute("data-mrd-send", "1");
    return { found: true, disabled: sendBtnDisabled(btn) };
  }

  function currentChatId() {
    const m = (location.pathname || "").match(SITE.chatIdRe);
    if (m) return m[1];
    return "";
  }

  // 计数前对正文与 marker 都做空白归一化：气泡可能保留提示词换行，而 marker
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

  // DeepSeek 新版：助手回复正文挂 .ds-markdown.ds-assistant-message-main-content
  // （用户气泡不带 assistant-message 修饰类）；虚拟列表下只挂载可视区条目，
  // 最后一个即为最新回复 —— 回复等待/拉取只依赖最后一条，截断不影响判定
  function blockSel() {
    return ".ds-markdown.ds-assistant-message-main-content";
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

  // 发送轮次（DeepSeek 新版）：取「无 key 条目数」与「有 key 条目数/2（一问一答
  // 两条）」的最大值；新发送使计数相对 baseline 增加
  function roundCount() {
    const vis = document.querySelector(".ds-virtual-list-visible-items");
    if (!vis) return 0;
    const keyed = vis.querySelectorAll(":scope > div[data-virtual-list-item-key]").length;
    const unkeyed = vis.querySelectorAll(":scope > div:not([data-virtual-list-item-key])").length;
    return Math.max(unkeyed, Math.floor(keyed / 2));
  }

  function sentCheck(marker, beforeMarker, pathBefore) {
    const input = currentInput();
    const text = input ? inputText(input) : "";
    const empty = !input || !text;
    const btn = sendButtonEl();
    const blocks = assistantBlocks();
    // marker 计数空白归一化 + 剔除输入框草稿：草稿也在 body.innerText 里，
    // 不剔除会把「尚未发送」误判成「已上屏」
    const markerCount = Math.max(0, countInBody(marker) - countInText(text, marker));
    return {
      inputEmpty: empty,
      inputLen: text.length,
      sendBtnFound: !!btn,
      sendBtnDisabled: sendBtnDisabled(btn),
      markerCount,
      markerAppeared: markerCount > (Number(beforeMarker) || 0),
      pathChanged: location.pathname !== String(pathBefore || ""),
      blockCount: blocks.length,
      roundCount: roundCount(),
      generating: generating(),
      chatId: currentChatId(),
    };
  }

  function domSnapshot(beforeCount, beforeLast) {
    // 虚拟列表下助手回复块只挂载可视区条目，最后一个为最新回复；新回复判定
    // 主要靠与 baseline before_last 的文本比较
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
      sendButtonDisabled: sendBtnDisabled(btn),
      assistantBlocks: blocks.length,
      chatId: currentChatId(),
    };
  }

  window.__mrdCdp = {
    SITE,
    pickInput,
    pickSendButton,
    inputReady,
    sentCheck,
    domSnapshot,
    generating,
    probe,
    currentChatId,
    countInBody,
    roundCount,
    assistantBlocks,
    blockText,
  };
  return true;
}
"""

# DeepSeek：侧栏会话扫描（行元素 + a[href*="/a/chat/s/"] 兜底；伪链接过滤）
_SIDEBAR_SESSIONS_JS = r"""
() => {
  const SITE = window.__mrdCdp.SITE;
  const out = [];
  const seen = new Set();
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
  const PSEUDO = /^(cron-jobs|skills|drive|chat|new|login)$/i;
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
  for (const row of document.querySelectorAll('[class*="conversation-item"]')) {
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

# DeepSeek：侧栏滚动加载更多（虚拟列表只挂载可视区条目）：返回当前已挂载条目数
_SCROLL_SIDEBAR_JS = r"""
() => {
  let els = [...document.querySelectorAll('[data-testid="conversation-list-v2-item"]')];
  if (!els.length) {
    els = [...document.querySelectorAll('a[href]')].filter((a) => {
      if (!(a.getAttribute("href") || "").includes("/a/chat/s/")) return false;
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

def _norm_path(p: str) -> str:
    return (p[: -1] if p and len(p) > 1 and p.endswith("/") else p) or "/"


def _marker_of(text: str) -> str:
    """用户消息特征文本（去掉 Markdown 记号，与扩展 driveFillAndCollect 一致）。"""
    return re.sub(r"\s+", " ", re.sub(r"[`*#>~_|-]", " ", str(text))).strip()[:20]


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


class DeepseekDriver(BaseSiteDriver):
    parse_mode = "deepseek"
    session_source = "ui"  # 页面模拟（曾为 "api"，站内 API 有封号风险已移除）
    supports_delete = True

    # ---- 页面 JS 助手 ----

    async def inject_helpers(self, page: Any) -> None:
        """注入 DeepSeek 页面 JS 助手（幂等；goto 后需重新调用）。"""
        for _ in range(20):
            try:
                ok = await page.evaluate(_PAGE_JS)
                if ok:
                    return
            except Exception:
                pass
            await asyncio.sleep(0.5)
        raise RuntimeError("页面 JS 助手注入失败（页面可能未加载完成）")

    # ---- SSE 协议（DeepSeek 私有：p: "response/..."、v 载荷） ----

    _REASONING_RE = re.compile(r"think|reason|thought|cot|reflect", re.I)

    def parse_sse_body(self, body: str, state: dict) -> None:
        """解析 DeepSeek SSE 文本，累积正文到 state（移植 page-hook 行解析器）。"""
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
            p = obj.get("p")
            if p == "response/status":
                if str(obj.get("v") or "") in ("FINISHED", "COMPLETED"):
                    state["finished"] = True
                continue
            if isinstance(p, str) and (
                self._REASONING_RE.search(p) or "title" in p or "search" in p
            ):
                continue
            v = obj.get("v")
            if isinstance(v, str):
                if not p or "content" in p:
                    if v and len(state["text"]) < MAX_TEXT:
                        state["text"] += v
            elif isinstance(v, list):
                self._read_fragments(state, v)
            elif isinstance(v, dict):
                r = v.get("response")
                if isinstance(r, dict) and isinstance(r.get("content"), str):
                    if r["content"] and len(state["text"]) < MAX_TEXT:
                        state["text"] += r["content"]

    def _read_fragments(self, state: dict, arr: Any) -> None:
        for f in arr or []:
            if not isinstance(f, dict):
                continue
            ftype = str(f.get("type") or f.get("kind") or "").upper()
            if "THINK" in ftype or "REASON" in ftype:
                continue
            p = f.get("p") or f.get("path")
            if isinstance(p, str) and self._REASONING_RE.search(p):
                continue
            for k in ("content", "text"):
                if isinstance(f.get(k), str) and f[k] and len(state["text"]) < MAX_TEXT:
                    state["text"] += f[k]

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
        """会话列表：侧栏滚动加载扫描。

        DeepSeek 侧栏为虚拟列表（只挂载可视区条目），先反复滚动到底部触发加载，
        条目数不再增长后再扫描。
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
        """删除后校验侧栏条目消失（明确报错，不做任何额外点击）。"""
        for _ in range(8):
            await asyncio.sleep(0.8)
            try:
                if not await loc.count():
                    return {"ok": True}
            except Exception:
                pass
        raise RuntimeError(
            f"{site_name} 删除会话未生效：侧栏条目仍存在。"
            "请刷新页面后在该网页内手动确认删除"
        )

    async def close_session(self, mgr: Any, page: Any, chat_id: str = "") -> dict:
        """删除会话（DeepSeek 新版结构，逐步精确选择器，失败即在当前步骤报错）：

        1. 悬停侧栏条目 → 2. 点锚点内 div[role="button"]（更多按钮）→
        3. 等 1s → 点 div[role='menu'].ds-elevated .ds-dropdown-menu-option--error（删除）→
        4. 等 1s → 确认 div[role='dialog'].ds-elevated div[role='button'].ds-button--error
           存在且 innerText ==「删除该对话」→ 点击 → 5. 校验侧栏条目消失。
        任何一步失败立即抛错，不做候选轮换、不跳步、不自行往下走。
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

        # 1) 悬停显示操作按钮（失败不阻断：部分主题按钮常显）
        try:
            await anchor.hover(timeout=4000)
        except Exception:
            pass
        await asyncio.sleep(0.5)

        # 2) 锚点内 div[role="button"] = 更多按钮，点击
        more = anchor.locator('div[role="button"]').first
        if not await more.count():
            raise RuntimeError(
                "DeepSeek 删除失败（第 2 步）：会话条目内未找到 div[role=\"button\"]"
                "（更多按钮）。请刷新页面后重试，或在该网页内手动删除该会话"
            )
        try:
            await more.click(timeout=4000)
        except Exception as e:
            raise RuntimeError(f"DeepSeek 删除失败（第 2 步）：更多按钮点击未生效：{e}")

        # 3) 等 1s → 弹出菜单中 .ds-dropdown-menu-option--error 即「删除」项，点击
        await asyncio.sleep(1.0)
        item = page.locator("div[role='menu'].ds-elevated .ds-dropdown-menu-option--error").first
        if not await item.count():
            raise RuntimeError(
                "DeepSeek 删除失败（第 3 步）：弹出菜单中未找到"
                " div[role='menu'].ds-elevated .ds-dropdown-menu-option--error（删除项）。"
                "请刷新页面后重试，或在该网页内手动删除该会话"
            )
        try:
            await item.click(timeout=4000)
        except Exception as e:
            raise RuntimeError(f"DeepSeek 删除失败（第 3 步）：删除菜单项点击未生效：{e}")

        # 4) 等 1s → 确认弹窗：div[role='button'].ds-button--error 且文本为「删除该对话」，点击
        await asyncio.sleep(1.0)
        confirm = page.locator("div[role='dialog'].ds-elevated div[role='button'].ds-button--error").first
        if not await confirm.count():
            raise RuntimeError(
                "DeepSeek 删除失败（第 4 步）：确认弹窗中未找到"
                " div[role='dialog'].ds-elevated div[role='button'].ds-button--error。"
                "请刷新页面后重试，或在该网页内手动确认删除"
            )
        confirm_text = (await confirm.inner_text()).strip()
        if confirm_text != "删除该对话":
            raise RuntimeError(
                f"DeepSeek 删除失败（第 4 步）：确认按钮文本异常（期望「删除该对话」，实际「{confirm_text}」），"
                "为避免误删不执行点击。请刷新页面后重试，或在该网页内手动确认删除"
            )
        try:
            await confirm.click(timeout=4000)
        except Exception as e:
            raise RuntimeError(f"DeepSeek 删除失败（第 4 步）：确认按钮点击未生效：{e}")

        # 5) 校验侧栏条目消失
        result = await self._verify_session_gone(page, anchor, "DeepSeek")
        log.info("[WebChatCDP] DeepSeek 会话 %s 已删除（UI 模拟）", chat_id[:8])
        return result

    # ---- 发送消息 ----

    async def send_prompt(self, mgr: Any, page: Any, text: str, cancelled) -> dict:
        """发送消息（写入 + 提交 + 核验）。失败/取消抛异常。"""
        mgr.reset_sse(page)
        marker = _marker_of(text)
        await self._wait_generation_idle(page)  # 生成中发送会被丢弃，先等空闲
        before = await page.evaluate(
            "([m]) => { const blocks = window.__mrdCdp.assistantBlocks();"
            " return { beforeCount: blocks.length, beforeLast: blocks.length ? blocks[blocks.length - 1] : '',"
            " beforeMarker: window.__mrdCdp.countInBody(m), pathBefore: location.pathname,"
            " beforeRounds: window.__mrdCdp.roundCount() }; }",
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

    async def _wait_generation_idle(self, page: Any, max_wait: float = 90.0) -> None:
        """等待上一轮生成结束（发送按钮图标恢复待发送/非生成态）再发送。

        生成中写入的消息会被站点静默丢弃；这里最多等 max_wait 秒，超时则
        告警并照常尝试发送（由 _submit 的核验兜底）。
        """
        deadline = time.monotonic() + max_wait
        warned = False
        while time.monotonic() < deadline:
            try:
                busy = await page.evaluate("() => window.__mrdCdp.generating()")
            except Exception:
                return
            if not busy:
                return
            if not warned:
                log.info("[WebChatCDP] %s 上一轮仍在生成，等待其结束后再发送", self.name)
                warned = True
            await asyncio.sleep(1.0)
        log.warning("[WebChatCDP] %s 等待上一轮生成结束超时（%ss），继续尝试发送", self.name, int(max_wait))

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
        """回读校验：输入框内容与提示词一致（空白归一后比对，容忍编辑器重排）。"""
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
        输入框已清空 + 任一信号（生成中 / 新助手块 / 消息上屏 / 轮次增长 / 路径变化）。
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
                # 已清空但信号未到（生成态切换有 1-2s 延迟）：继续等，不盲目补发
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
                btn = await page.evaluate("() => window.__mrdCdp.pickSendButton()")
                if btn and btn.get("found"):
                    try:
                        await page.locator('[data-mrd-send="1"]').first.click(timeout=5000)
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
            # 输入框被清空但会话内毫无变化：站点静默丢弃（多为生成中发送/频控）。
            # 文案保留「发送未生效」以命中 _RISK_ERROR_WORDS，走前端 risk 弹窗链路。
            raise RuntimeError(
                "发送未生效（疑似被站点丢弃）：输入框已清空，但会话内未出现这条消息、"
                f"也未开始任何生成（等待 {_SUBMIT_VERIFY_WINDOW_S:.0f}s 无任何变化）。"
                "建议冷却 1-2 分钟后再重试"
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

            def _json_pending() -> bool:
                return bool(expect_json and not _looks_json_complete(last_text))

            # 生成中（发送按钮处于生成态）不得因 DOM 短暂稳定而提前返回：深度思考
            # / 流式停顿期间 DOM 可能数十秒不变，提前返回会让下一镜在生成中发送
            # 而被静默丢弃。生成中持续重置稳定计时；生成态持续超过 60s 且 DOM 无
            # 变化时按已完成处理（生成态残留兜底，避免死等）。
            if dom.get("generating") and time.monotonic() - stable_since < 60.0:
                stable_since = time.monotonic()

            cur = str(dom.get("lastBlockText") or "")
            # 虚拟列表下 blockCount 恒为挂载上限，新回复判定主要靠与 baseline
            # before_last 的文本比较（最后一个 assistant-message 内容即最新回复）
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
