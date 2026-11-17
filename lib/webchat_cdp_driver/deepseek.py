"""DeepseekDriver: DeepSeek 站点驱动（完全自包含，无跨驱动共享代码）。

本驱动独立实现全部链路（页面 JS / 元素选择器 / SSE 协议 / 会话与发送流程），
修改本文件的常量不影响豆包/千问驱动：

- 页面助手：window.__mrdCdp（DeepSeek 专用选择器）
- 会话列表：首页侧栏滚动加载扫描（a[href*="/a/chat/s/"] 锚点 + 行扫描兜底）
- 删除会话：悬停条目 → 行内「更多」按钮 → 弹出菜单「删除」→ 确认弹窗兜底
  （DeepSeek 无 Ctrl+D 快捷键，菜单项无稳定 role/class，用启发式定位 + 可信事件点击）
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

  function inputCandidates() {
    const els = [...document.querySelectorAll("textarea, div[contenteditable='true']")];
    return els
      .filter((el) => {
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 40 && r.height >= 16;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const id = String(el.id || "").toLowerCase();
        const cls = String(el.className || "").toLowerCase();
        const ph = el.getAttribute("placeholder") || "";
        let score = 0;
        if (id === "chat-input") score += 100;
        if (/chat|input|prompt|composer/.test(`${id} ${cls}`)) score += 20;
        if (ph) score += 10;
        if (el.tagName === "TEXTAREA") score += 5;
        score += Math.min(30, Math.round((r.width * r.height) / 4000));
        return { el, score, tag: el.tagName, id: el.id || "", placeholder: ph, w: Math.round(r.width), h: Math.round(r.height) };
      })
      .sort((a, b) => b.score - a.score);
  }

  function findInput() {
    const list = inputCandidates();
    return list.length ? list[0].el : null;
  }

  function pickInput() {
    const list = inputCandidates();
    document.querySelectorAll("[data-mrd-input]").forEach((e) => e.removeAttribute("data-mrd-input"));
    if (!list.length) return { found: false, candidates: [] };
    const el = list[0].el;
    el.setAttribute("data-mrd-input", "1");
    return {
      found: true,
      tag: el.tagName,
      id: el.id || "",
      placeholder: (el.getAttribute("placeholder") || "").slice(0, 24),
      len: inputText(el).length,
      candidates: list.slice(0, 5).map((c) => ({
        tag: c.tag, id: c.id || "", placeholder: (c.placeholder || "").slice(0, 24),
        size: `${c.w}x${c.h}`, score: c.score,
      })),
    };
  }

  function currentInput() {
    return document.querySelector("[data-mrd-input]") || findInput();
  }

  function labelOf(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.textContent ||
      ""
    ).trim().toLowerCase();
  }

  function isBypass(label) {
    return /语音|麦克风|上传|附件|图片|录音|暂停|停止|voice|mic|upload|attach|stop|pause/.test(label);
  }

  function findSendButton(input) {
    const nodes = [...document.querySelectorAll("button, div[role='button'], span[role='button'], [data-testid]")];
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const label = labelOf(el);
      if (isBypass(label)) continue;
      if (label === "发送" || label === "send" || label === "发送消息") return el;
    }
    let scope = input;
    for (let i = 0; i < 4 && scope && scope.parentElement; i++) scope = scope.parentElement;
    if (scope) {
      const cands = [...scope.querySelectorAll("div[role='button'], button, [data-testid]")].filter((el) => {
        if (!isVisible(el)) return false;
        if (el.getAttribute("aria-disabled") === "true") return false;
        if (el.hasAttribute("disabled")) return false;
        if (isBypass(labelOf(el))) return false;
        const cls = String(el.className || "") + String(el.getAttribute("data-testid") || "");
        return /send|submit/i.test(cls) || !el.querySelector("svg");
      });
      const ranked = cands
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .sort((a, b) => b.r.top - a.r.top || b.r.left - a.r.left);
      if (ranked.length) return ranked[0].el;
    }
    return null;
  }

  function pickSendButton() {
    document.querySelectorAll("[data-mrd-send]").forEach((e) => e.removeAttribute("data-mrd-send"));
    const input = currentInput();
    const btn = findSendButton(input);
    if (!btn) return { found: false };
    btn.setAttribute("data-mrd-send", "1");
    return {
      found: true,
      label: (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").slice(0, 24),
      disabled: btn.getAttribute("aria-disabled") === "true" || btn.hasAttribute("disabled"),
    };
  }

  function currentChatId() {
    const m = (location.pathname || "").match(SITE.chatIdRe);
    if (m) return m[1];
    return "";
  }

  function countInBody(marker) {
    if (!marker) return 0;
    const body = ((document.body && document.body.innerText) || "").replace(/\u00a0/g, " ");
    const m = String(marker).replace(/\u00a0/g, " ");
    return body ? body.split(m).length - 1 : 0;
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

  // DeepSeek：.ds-markdown / 通用 markdown 类名
  function blockSel() {
    return ".ds-markdown, .markdown-body, [class*='markdown']";
  }

  function assistantBlocks() {
    return [...document.querySelectorAll(blockSel())].map(blockText).filter((t) => t);
  }

  function assistantBlocksIn(root) {
    if (!root) return [];
    return [...root.querySelectorAll(blockSel())].map(blockText).filter((t) => t);
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
    const empty = !input || !inputText(input);
    const btn = input ? findSendButton(input) : null;
    const blocks = assistantBlocks();
    const markerCount = countInBody(marker);
    return {
      inputEmpty: empty,
      inputLen: input ? inputText(input).length : 0,
      sendBtnFound: !!btn,
      sendBtnDisabled: btn
        ? btn.getAttribute("aria-disabled") === "true" || btn.hasAttribute("disabled")
        : false,
      markerCount,
      markerAppeared: markerCount > (Number(beforeMarker) || 0),
      pathChanged: location.pathname !== String(pathBefore || ""),
      blockCount: blocks.length,
      roundCount: document.querySelectorAll(".chat-round").length,
      userMsgCount: document.querySelectorAll(".message-card-wrap.question").length,
      chatId: currentChatId(),
    };
  }

  function domSnapshot(beforeCount, beforeLast) {
    const blocks = assistantBlocks();
    const last = blocks.length ? blocks[blocks.length - 1] : "";
    const cur = last;
    const isNew = !!cur && (blocks.length > (beforeCount || 0) || cur !== (beforeLast || ""));
    return {
      blockCount: blocks.length,
      lastBlockText: last,
      lastBlockChanged: isNew && cur !== (beforeLast || ""),
      roundCount: document.querySelectorAll(".chat-round").length,
      lastRoundText: (() => {
        const rounds = document.querySelectorAll(".chat-round");
        if (!rounds.length) return "";
        return assistantBlocksIn(rounds[rounds.length - 1]).join("\n\n");
      })(),
      chatId: currentChatId(),
      path: location.pathname,
    };
  }

  function probe() {
    const input = findInput();
    const btn = input ? findSendButton(input) : null;
    const blocks = assistantBlocks();
    const cands = inputCandidates().slice(0, 5).map((c) => ({
      tag: c.tag, id: c.id || "", placeholder: (c.placeholder || "").slice(0, 24),
      size: `${c.w}x${c.h}`, score: c.score,
    }));
    return {
      url: location.href,
      title: document.title,
      loggedIn: !document.querySelector("button[class*='login'], a[href*='login']") || blocks.length > 0 || !!input,
      inputFound: !!input,
      inputKind: input ? input.tagName : "",
      inputCandidates: cands,
      sendButtonFound: !!btn,
      sendButtonLabel: btn ? (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").slice(0, 40) : "",
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
    probe,
    currentChatId,
    countInBody,
    assistantBlocks,
    assistantBlocksIn,
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

# DeepSeek：悬停会话条目后标记行内/邻近的「更多」按钮候选（多个候选时逐个尝试）
_DS_MORE_BUTTON_JS = r"""
([chatId]) => {
  const a = [...document.querySelectorAll('a[href]')]
    .find((el) => (el.getAttribute("href") || "").includes(chatId));
  if (!a) return { found: false, reason: "anchor not found" };
  document.querySelectorAll("[data-mrd-more]").forEach((e) => e.removeAttribute("data-mrd-more"));
  const picked = [];
  let box = a.parentElement;
  for (let level = 0; level < 4 && box && box !== document.body; level++) {
    const cands = [...box.querySelectorAll("button, [role='button'], svg, [class*='more'], [class*='icon'], [class*='option'], [class*='action']")];
    for (const el of cands) {
      if (el === a || a.contains(el) || picked.includes(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.width > 48 || r.height > 48) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      picked.push(el);
    }
    if (picked.length) break;
    box = box.parentElement;
  }
  picked.slice(0, 4).forEach((el) => el.setAttribute("data-mrd-more", "1"));
  return {
    found: picked.length > 0,
    count: Math.min(picked.length, 4),
    samples: picked.slice(0, 3).map((el) => ({
      tag: el.tagName,
      cls: String((el.className && el.className.baseVal) || el.className || "").slice(0, 60),
    })),
  };
}
"""

# DeepSeek：在弹出菜单（portal/浮层）中标记「删除」项（启发式叶子元素定位）
_DS_DELETE_ITEM_JS = r"""
() => {
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
  };
  document.querySelectorAll("[data-mrd-del]").forEach((e) => e.removeAttribute("data-mrd-del"));
  const leaves = [...document.querySelectorAll("body *")].filter((el) => {
    if (!isVisible(el)) return false;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent || "").join("");
    if (!own.includes("删除")) return false;
    return !el.closest("a[href]");
  });
  if (!leaves.length) return { found: false };
  const target = leaves[leaves.length - 1];
  target.setAttribute("data-mrd-del", "1");
  return { found: true, cls: String(target.className || "").slice(0, 60), text: (target.textContent || "").slice(0, 30) };
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
            raise RuntimeError(
                f"未能从 {self.name} 侧栏识别到会话列表（页面结构可能改版或未登录）。"
                "可在导入弹窗手动粘贴会话链接，或留空自动新建会话"
            )
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

    # ---- 发送消息 ----

    async def send_prompt(self, mgr: Any, page: Any, text: str, cancelled) -> dict:
        """发送消息（写入 + 提交 + 核验）。失败/取消抛异常。"""
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
        """提交消息（回车 → 补回车 → 通用发送按钮，未提交安全重试不重复写入）。"""
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
