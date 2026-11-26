"""QwenDriver: 千问站点驱动（完全自包含，无跨驱动共享代码）。

本驱动独立实现全部链路（页面 JS / 元素选择器 / SSE 协议 / 会话与发送流程），
修改本文件的常量不影响 DeepSeek/豆包驱动：

- 页面助手：window.__mrdCdp（千问专用 SITE；currentChatId 含侧栏高亮条目兜底——
  千问新建会话 URL 恒为 /chat/ 不含 id，需从 [class*="!bg-option"] 高亮条目读取）
- 会话列表：div[data-session-switch-target="normal"]，data-session-id 即会话 id
- 删除会话：目标 div 内 button 点击 → div[data-session-switch-target=
  "delete-session"][data-session-id=<id>] 点击触发删除（确认弹窗兜底）
- 发送消息：输入框为 Slate 富文本编辑器，locator.fill 常不触发其内部状态
  → 可信键盘输入（insert_text），以「发送按钮变为可用」为写入成功判据；
  _submit 优先点发送按钮，通用回车重试路径兜底。
- SSE 协议：generic 行解析（finish 事件 + 递归抽取 content/text，跳过推理字段）
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

_SEND_BTN_LOC = 'button[aria-label="发送消息"], button[aria-label="发送"]'

# 页面助手总入口（写入 window.__mrdCdp；千问专用 SITE 与 currentChatId 兜底）
_PAGE_JS = r"""
() => {
  const SITE = { id: "qwen", name: "千问", chatIdRe: /\/(?:qianwen\/)?chat\/([0-9A-Za-z_-]+)/, sessionApi: false };

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function inputText(input) {
    if (!input) return "";
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") return input.value || "";
    // Slate 富文本编辑器空状态会把占位符渲染为真实 DOM 文本，剥离后再读 innerText
    const clone = input.cloneNode(true);
    clone.querySelectorAll("[data-slate-placeholder], [data-placeholder]").forEach((n) => n.remove());
    return (clone.innerText || "").replace(/\u00a0/g, " ").trim();
  }

  // 千问专用输入框：div[contenteditable='true'][role="textbox"]，选中后打
  // data-mrd-input="1" 标记，后续一律按标记取（不做启发式打分猜测）。
  function findInput() {
    return (
      document.querySelector("[data-mrd-input]") ||
      document.querySelector("div[contenteditable='true'][role='textbox']")
    );
  }

  function pickInput() {
    document.querySelectorAll("[data-mrd-input]").forEach((e) => e.removeAttribute("data-mrd-input"));
    const el = document.querySelector("div[contenteditable='true'][role='textbox']");
    if (!el) return { found: false };
    el.setAttribute("data-mrd-input", "1");
    return { found: true, tag: el.tagName, id: el.id || "", len: inputText(el).length };
  }

  function currentInput() {
    return findInput();
  }

  // 千问专用发送按钮：button[aria-label="发送消息"]，disabled 表示输入框无
  // 内容；页面可能存在多个同名按钮，取第一个可见且未禁用的
  function findSendButton(input) {
    for (const b of document.querySelectorAll('button[aria-label="发送消息"]')) {
      if (!isVisible(b)) continue;
      if (b.disabled === true || b.getAttribute("aria-disabled") === "true") continue;
      return b;
    }
    return null;
  }

  // 生成中判定（千问专用）：出现 button[aria-label="停止回答"] 即生成中
  function generating() {
    return !!document.querySelector('button[aria-label="停止回答"]');
  }

  function currentChatId() {
    const m = (location.pathname || "").match(SITE.chatIdRe);
    if (m) return m[1];
    // 千问新建会话后 URL 恒为 /chat/（不含会话 id）：从侧栏「当前会话」条目
    // 取 id（该条目带 !bg-option 高亮 class）。只认明确的高亮标记，
    // 不猜「最新条目」，避免把用户正在看的其他会话误判成当前会话。
    const act = document.querySelector('div[data-session-switch-target="normal"][class*="!bg-option"]');
    if (act) {
      const id = act.getAttribute("data-session-id");
      if (id) return id;
    }
    return "";
  }

  // 计数前对正文与 marker 都做空白归一化：千问气泡保留提示词换行，而 marker
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

  // 千问：每条助手回复正文挂 div[id="qk-markdown-react"]（多个条目共用同一
  // id 属站点行为），最后一个即为最新回复
  function blockSel() {
    return 'div[id="qk-markdown-react"]';
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
    // marker 计数空白归一化 + 剔除输入框草稿：草稿也在 body.innerText 里，
    // 不剔除会把「尚未发送」误判成「已上屏」
    const markerCount = Math.max(0, countInBody(marker) - countInText(text, marker));
    return {
      inputEmpty: empty,
      inputLen: text.length,
      sendBtnFound: !!btn,
      sendBtnDisabled: btn ? btn.disabled === true || btn.getAttribute("aria-disabled") === "true" : false,
      markerCount,
      markerAppeared: markerCount > (Number(beforeMarker) || 0),
      pathChanged: location.pathname !== String(pathBefore || ""),
      blockCount: blocks.length,
      // 发送轮次：每条消息挂 div[data-chat-list-key]（data-chat-list-index 从 0
      // 递增），新消息使计数相对 baseline 增加
      roundCount: document.querySelectorAll("div[data-chat-list-key]").length,
      generating: generating(),
      chatId: currentChatId(),
    };
  }

  function domSnapshot(beforeCount, beforeLast) {
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

# 千问：会话侧栏（data-session-switch-target="normal" 携带 data-session-id）
_QWEN_SESSIONS_JS = r"""
() => {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('div[data-session-switch-target="normal"]')) {
    if (!el.isConnected) continue;
    const id = el.getAttribute("data-session-id");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const t = String(el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
    out.push({ id, title: t, updatedAt: null });
  }
  const cur = window.__mrdCdp.currentChatId();
  if (cur && !seen.has(cur)) out.push({ id: cur, title: document.title || "", updatedAt: null });
  return out;
}
"""

# 千问发送按钮状态（button[aria-label="发送消息"]；disabled 表示输入框无内容）
_QWEN_SEND_STATE_JS = r"""
() => {
  const b = document.querySelector('button[aria-label="发送消息"]');
  if (!b) return { found: false };
  const r = b.getBoundingClientRect();
  return {
    found: true,
    disabled: b.disabled === true || b.getAttribute("aria-disabled") === "true",
    visible: r.width > 0 && r.height > 0,
  };
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


class QwenDriver(BaseSiteDriver):
    supports_delete = True

    # ---- 页面 JS 助手 ----

    async def inject_helpers(self, page: Any) -> None:
        """注入千问页面 JS 助手（幂等；goto 后需重新调用）。"""
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
        """获取会话列表（data-session-switch-target="normal" + data-session-id）。"""
        await self.inject_helpers(page)
        await self._navigate_and_wait(page, self.cfg["home"], self.cfg["home_path"])
        await asyncio.sleep(1.5)  # 侧栏渲染
        try:
            sessions = await page.evaluate(_QWEN_SESSIONS_JS)
        except Exception as e:
            raise RuntimeError(f"读取千问会话列表失败（页面可能正在加载，请稍后重试）：{e}")
        return sessions or []

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
            " beforeRounds: document.querySelectorAll('div[data-chat-list-key]').length }; }",
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
        """等待上一轮生成结束（「停止回答」按钮消失）再发送。

        生成中写入的消息可能被站点静默丢弃；超时则告警并照常尝试发送
        （由 _submit 的核验兜底）。
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
                # 千问发送按钮：button[aria-label="发送消息"]（可能有多个同名
                # 按钮，:visible 过滤取第一个可见的；disabled=输入框无内容）
                await page.locator('button[aria-label="发送消息"]:visible').first.click(timeout=5000)
            except Exception as e:
                log.debug("[WebChatCDP] qwen send click: %s", e)
            await asyncio.sleep(2.0 if attempt == 0 else 1.5)
            if await self._sent_ok(page, marker, baseline):
                return
        # 兜底：通用回车重试路径（与豆包/DeepSeek 同构）
        await self._submit_generic(page, marker, baseline, cancelled)

    async def _sent_state(self, page: Any, marker: str, baseline: dict):
        """取 sentCheck 快照（异常返回 None）。"""
        try:
            return await page.evaluate(
                "([m, bm, pb]) => window.__mrdCdp.sentCheck(m, bm, pb)",
                [marker, baseline["before_marker"], baseline["path_before"]],
            )
        except Exception:
            return None

    async def _sent_ok(self, page: Any, marker: str, baseline: dict) -> bool:
        """单次发送结果核对。"""
        s = await self._sent_state(page, marker, baseline)
        if s is None:
            return False
        return bool(s and (s.get("markerAppeared") or s.get("pathChanged")
                           or int(s.get("blockCount") or 0) > baseline["before_count"]
                           or int(s.get("roundCount") or 0) > int(baseline.get("before_rounds") or 0)))

    async def _submit_generic(self, page: Any, marker: str, baseline: dict, cancelled) -> None:
        """通用提交兜底（回车 → 补回车 → 点发送按钮），信号先行核验。

        每轮先核验「已上屏」信号，不以输入框清空为前提；输入框未清空只决定
        是否补发动作（补回车一次、点发送按钮一次，各限一次防重复提交）。
        """
        submits = 0
        deadline = time.monotonic() + 45.0
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
            if s and s.get("inputEmpty"):
                if (s.get("markerAppeared") or s.get("pathChanged")
                        or int(s.get("blockCount") or 0) > baseline["before_count"]
                        or int(s.get("roundCount") or 0) > int(baseline.get("before_rounds") or 0)):
                    return
                continue
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
                    await page.locator('button[aria-label="发送消息"]:visible').first.click(timeout=5000)
                except Exception:
                    pass
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
        """获取消息：SSE 主通道 + DOM 回复块稳定性兜底 + chat_id 侧栏兜底。

        千问新建会话 URL 恒为 /chat/（不含 id），chat_id 需从侧栏「当前会话」
        高亮条目读取；侧栏条目可能晚于回复渲染，故回复成功但 chat_id 为空时
        短暂重试若干次（最多约 5s）。
        """
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
                    reply = {"ok": True, "text": sse_text, "chat_id": str(dom.get("chatId") or ""), "error": ""}
                    return await self._fill_chat_id(page, reply)
                if not not_json_at:
                    not_json_at = time.monotonic()
                elif time.monotonic() - not_json_at > NOT_JSON_GRACE_S:
                    reply = {"ok": True, "text": sse_text, "chat_id": str(dom.get("chatId") or ""), "error": ""}
                    return await self._fill_chat_id(page, reply)
            stable_need = 3.0 if not sse.get("active") else 8.0

            def _json_pending() -> bool:
                return bool(expect_json and not _looks_json_complete(last_text))

            # 生成中（「停止回答」按钮仍在）不得因 DOM 短暂稳定而提前返回：
            # 流式停顿期提前返回会让下一镜在生成中发送。生成中持续重置稳定
            # 计时；生成态持续超过 60s 且 DOM 无变化时按已完成处理（残留兜底）
            if dom.get("generating") and time.monotonic() - stable_since < 60.0:
                stable_since = time.monotonic()

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
                    reply = {"ok": True, "text": last_text, "chat_id": str(dom.get("chatId") or ""), "error": ""}
                    return await self._fill_chat_id(page, reply)
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

    async def _fill_chat_id(self, page: Any, reply: dict) -> dict:
        """回复成功但 chat_id 为空时，从侧栏高亮条目短暂重试读取（最多约 5s）。"""
        if not (reply.get("ok") and not reply.get("chat_id")):
            return reply
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
