// MiniMax Ref Director — DeepSeek Bridge (content script on chat.deepseek.com)
// 职责：
// 1) 接收 background 的 ds/fill → 开新会话（或在当前会话）→ 填充输入 → 触发发送 →
//    观察助手回复完成 → 经 chrome.runtime.sendMessage({type:"ds/reply"}) 回传。
// 2) 会话管理：ds/list_sessions / ds/read_session / ds/new_session /
//    ds/delete_messages / ds/rename_session —— 走 chat.deepseek.com 站内 API
//    （同源带 cookie fetch）。
// 3) ds/probe：自检（输入框/发送按钮/回复区是否可定位），供前端「页面自检」按钮调用。
// DOM 选择器尽力兼容 DeepSeek Web 多个版本（textarea / contenteditable 双策略）。

(() => {
  if (window.__mrdDeepseekBridge) return;
  window.__mrdDeepseekBridge = true;

  const SEND_TIMEOUT_MS = 240_000;
  const STABLE_INTERVAL_MS = 2500;
  const NO_SIGNAL_MS = 90_000;

  // 回复捕获：主通道是 page-hook.js（MAIN world）hook 的 /api/v0/chat/completion
  // SSE 流（不依赖 DOM 类名）；DOM 文本块作为兜底。
  const sse = { startAt: 0, text: "", doneAt: 0, lastLen: 0 };
  let currentFillId = "";

  function resetSse() {
    sse.startAt = 0;
    sse.text = "";
    sse.doneAt = 0;
    sse.lastLen = 0;
  }

  // 阶段上报：background 记录后在「页面自检」里展示，便于定位卡在哪一步
  function stage(name, detail) {
    if (!currentFillId) return;
    try {
      chrome.runtime.sendMessage({
        type: "ds/stage", id: currentFillId, stage: name, detail: detail || "",
      });
    } catch {
      // 忽略
    }
  }

  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (!d || d.__mrd_ds !== 1) return;
    if (d.type === "stream_start") {
      sse.startAt = Date.now();
      sse.text = "";
      sse.doneAt = 0;
      sse.lastLen = 0;
      stage("stream_start");
    } else if (d.type === "stream_progress") {
      sse.lastLen = d.length || 0;
    } else if (d.type === "stream_done") {
      sse.text = String(d.text || "");
      sse.doneAt = Date.now();
      stage("stream_done", `len=${sse.text.length}`);
    }
  });

  // ---- 站内 API 端点（同源 fetch，带 cookie）----
  // 路径与响应结构对齐 linuxfight/deepseek4free（pkg/api/instance.go、models/chat.go）。
  // 若 DeepSeek 改版导致失效，可在 chat.deepseek.com 页面打开 DevTools → Network
  // 面板观察真实请求后修改以下常量。
  const DS_API = {
    // 会话列表（分页）：GET …/chat_session/fetch_page?count=&cursor=
    list: "/api/v0/chat_session/fetch_page",
    // 新建会话：POST，body {"agent":"chat"} → data.biz_data.id
    create: "/api/v0/chat_session/create",
    del: "/api/v0/chat_session/delete",
    rename: "/api/v0/chat_session/update_title",
    // 消息历史：GET …/chat/history_messages?chat_session_id=<id>
    history: (id) => `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(id)}`,
    // 删除单条消息：DeepSeek 站内无公开逆向资料确认此端点，先尝试；
    // 失败时返回明确错误（前端提示手动清理），绝不动用户整个会话。
    messageDelete: "/api/v0/chat/message/delete",
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "ds/ping":
        // 附带版本：background 据此发现"扩展重载后未刷新的旧标签页"并自动 reload
        sendResponse({ pong: true, v: chrome.runtime.getManifest().version });
        return;
      case "ds/probe":
        sendResponse(probe());
        return;
      case "ds/cancel":
        // 用户在导入界面点了取消：中止当前 fill 的等待循环
        cancelFlag = true;
        sendResponse({ cancelled: true });
        return;
      case "ds/fill":
        handleFill(msg.id, msg.text || "", msg.opts || {});
        sendResponse({ accepted: true });
        return;
      case "ds/list_sessions":
        handleApi(sendResponse, listSessions);
        return true;
      case "ds/read_session":
        handleApi(sendResponse, () => readSession(msg.chat_id));
        return true;
      case "ds/new_session":
        handleApi(sendResponse, newSession);
        return true;
      case "ds/delete_messages":
        handleApi(sendResponse, () => deleteMessages(msg.chat_id, msg.message_ids, msg.keep_count));
        return true;
      case "ds/rename_session":
        handleApi(sendResponse, () => renameSession(msg.chat_id, msg.title));
        return true;
    }
  });

  async function handleApi(sendResponse, fn) {
    try {
      const data = await fn();
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  }

  // 从页面 URL 解析当前会话 id：/a/chat/s/<id>（发送首条消息后 DeepSeek 会跳到会话页）
  function currentChatId() {
    const m = (location.pathname || "").match(/\/a\/chat\/s\/([0-9A-Za-z_-]+)/);
    return m ? m[1] : "";
  }

  function reply(id, ok, text, error) {
    if (id === currentFillId) {
      stage(ok ? "replied" : "reply_error", error || "");
      currentFillId = "";
    }
    chrome.runtime.sendMessage({
      type: "ds/reply", id, ok, text: text || "", error: error || "",
      chatId: currentChatId(),
    });
  }

  // ---------- 站内 API ----------

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    try {
      const raw = localStorage.getItem("userToken");
      if (raw) {
        let token = raw;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.value === "string") token = parsed.value;
        } catch {
          // 非 JSON，按原值使用
        }
        headers["Authorization"] = `Bearer ${token}`;
      }
    } catch {
      // localStorage 不可用时仅依赖 cookie
    }
    return headers;
  }

  async function api(path, { method = "GET", body } = {}) {
    let resp = null;
    try {
      resp = await fetch(path, {
        method,
        credentials: "include",
        headers: authHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`网络请求失败：${(e && e.message) || e}`);
    }
    if (!resp.ok) throw new Error(`API ${method} ${path} 返回 HTTP ${resp.status}`);
    let json = null;
    try {
      json = await resp.json();
    } catch {
      throw new Error(`API ${method} ${path} 返回非 JSON 内容（可能未登录或端点已变更）`);
    }
    if (json && typeof json.code !== "undefined" && json.code !== 0) {
      throw new Error(`API ${method} ${path} 业务错误 code=${json.code} msg=${json.msg || ""}`);
    }
    const data = json && json.data;
    if (data && typeof data === "object" && typeof data.biz_code !== "undefined" && data.biz_code !== 0) {
      throw new Error(`API ${method} ${path} 业务错误 biz_code=${data.biz_code} biz_msg=${data.biz_msg || ""}`);
    }
    return data !== undefined ? data : json;
  }

  // 各端点的业务数据包了一层 biz_data，防御式取值
  function bizData(data) {
    if (data && typeof data === "object" && "biz_data" in data) return data.biz_data;
    return data;
  }

  async function listSessions() {
    // 分页拉全：fetch_page 按 updated_at 倒序返回，has_more 时以最后一条的
    // updated_at 作为 cursor 续拉（最多 10 页，覆盖典型账号全量会话）
    const out = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const q = `count=100${cursor ? `&cursor=${cursor}` : ""}`;
      const data = bizData(await api(`${DS_API.list}?${q}`));
      const sessions = (data && (data.chat_sessions || data.chatSessions)) || [];
      for (const s of sessions) {
        if (!s || !s.id) continue;
        out.push({
          id: s.id,
          title: s.title || "",
          updatedAt: s.updated_at || s.inserted_at || null,
        });
      }
      const hasMore = !!(data && data.has_more);
      const last = sessions[sessions.length - 1];
      if (!hasMore || !last) break;
      cursor = String(last.updated_at || last.inserted_at || "");
      if (!cursor) break;
    }
    return out;
  }

  async function readSession(chatId) {
    if (!chatId) throw new Error("缺少 chat_id");
    const data = bizData(await api(DS_API.history(chatId)));
    const items = (data && (data.chat_messages || data.chatMessages)) || (Array.isArray(data) ? data : []);
    const messages = items
      .map((m) => ({
        id: m.message_id != null ? m.message_id : (m.id != null ? m.id : null),
        role: String(m.role || "").toLowerCase() === "assistant" ? "assistant" : "user",
        content: typeof m.content === "string" ? m.content : "",
      }))
      .filter((m) => m.content);
    return { chatId, count: messages.length, messages };
  }

  async function newSession() {
    const data = bizData(await api(DS_API.create, { method: "POST", body: { agent: "chat" } }));
    const id = data && (data.id || data.chat_session_id);
    if (!id) throw new Error("新建会话未返回会话 id");
    return { id };
  }

  async function renameSession(chatId, title) {
    if (!chatId || !title) throw new Error("缺少 chat_id 或 title");
    await api(DS_API.rename, { method: "POST", body: { chat_session_id: chatId, title } });
    return { ok: true };
  }

  // 删除会话内指定消息（用于清除本次导入新增的 skill 输入与模型返回）。
  // message_ids：显式消息 id 列表；keep_count：保留前 N 条、删除其余。
  async function deleteMessages(chatId, messageIds, keepCount) {
    if (!chatId) throw new Error("缺少 chat_id");
    let targets = [];
    if (Array.isArray(messageIds) && messageIds.length) {
      targets = messageIds;
    } else if (typeof keepCount === "number" && keepCount >= 0) {
      const snap = await readSession(chatId);
      targets = snap.messages.map((m) => m.id).filter((id) => !!id).slice(keepCount);
    } else {
      throw new Error("缺少 message_ids 或 keep_count");
    }
    if (!targets.length) return { deleted: 0, skipped: true };

    const failed = [];
    for (const mid of targets) {
      if (!mid) {
        failed.push("(无 id 消息)");
        continue;
      }
      let ok = false;
      // 先尝试 chat_session_id 命名（与其余端点一致），再尝试 chat_id 与仅 message_id
      for (const body of [
        { message_id: mid, chat_session_id: chatId },
        { message_id: mid, chat_id: chatId },
        { message_id: mid },
      ]) {
        try {
          await api(DS_API.messageDelete, { method: "POST", body });
          ok = true;
          break;
        } catch {
          // 尝试下一种请求体
        }
      }
      if (!ok) failed.push(mid);
    }
    if (failed.length) {
      throw new Error(
        `DeepSeek 网页 API 未能删除 ${failed.length}/${targets.length} 条消息（该端点可能不被支持）。` +
          "请在 chat.deepseek.com 页面手动删除本次新增的两条消息；原会话其余内容未受影响。"
      );
    }
    return { deleted: targets.length };
  }

  // ---------- DOM 定位 ----------

  // 输入框候选打分：全页收集可见 textarea / contenteditable，按线索排序，
  // 避免选到页面里其他可见的文本框（曾出现"找到输入框但页面毫无输入"的错选）
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

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findSendButton(input) {
    // 1) aria-label / title / 文本精确匹配
    const nodes = [...document.querySelectorAll("button, div[role='button'], span[role='button']")];
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const label = (
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.textContent ||
        ""
      ).trim().toLowerCase();
      if (label === "发送" || label === "send" || label === "发送消息") return el;
    }
    // 2) 输入框所在容器内、位于输入框之后的可点击元素（DeepSeek 发送键在输入框右侧）
    let scope = input;
    for (let i = 0; i < 4 && scope && scope.parentElement; i++) scope = scope.parentElement;
    if (scope) {
      const cands = [...scope.querySelectorAll("div[role='button'], button")].filter((el) => {
        if (!isVisible(el)) return false;
        if (el.getAttribute("aria-disabled") === "true") return false;
        if (el.hasAttribute("disabled")) return false;
        const cls = String(el.className || "");
        return /send|submit/i.test(cls) || !el.querySelector("svg");
      });
      // 取最靠右下（y 最大、x 最大）的一个
      const ranked = cands
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .sort((a, b) => b.r.top - a.r.top || b.r.left - a.r.left);
      if (ranked.length) return ranked[0].el;
    }
    return null;
  }

  function inputText(input) {
    if (!input) return "";
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") return input.value || "";
    return (input.innerText || "").trim();
  }

  // 回复区文本块：DeepSeek 新版 .ds-markdown / 兼容 .markdown-body 与含 markdown 的类名
  function assistantBlocks() {
    const els = [...document.querySelectorAll(".ds-markdown, .markdown-body, [class*='markdown']")];
    return els.map((e) => (e.innerText || "").trim()).filter((t) => t);
  }

  function lastAssistantText() {
    const blocks = assistantBlocks();
    return blocks.length ? blocks[blocks.length - 1] : "";
  }

  // 自检：返回当前页面定位状态，供前端快速判断页面结构是否可用
  function probe() {
    const input = findInput();
    const btn = input ? findSendButton(input) : null;
    const blocks = assistantBlocks();
    const cands = inputCandidates().slice(0, 5).map((c) => ({
      tag: c.tag, id: c.id || "", placeholder: (c.placeholder || "").slice(0, 24),
      size: `${c.w}x${c.h}`, score: c.score,
    }));
    return {
      ok: true,
      data: {
        url: location.href,
        title: document.title,
        inputFound: !!input,
        inputKind: input ? input.tagName : "",
        inputCandidates: cands,
        sendButtonFound: !!btn,
        sendButtonLabel: btn
          ? (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").slice(0, 40)
          : "",
        assistantBlocks: blocks.length,
        lastBlockChars: blocks.length ? blocks[blocks.length - 1].length : 0,
        hookInstalled: !!window.__mrdDsHook,
        sseActive: !!sse.startAt,
        sseDone: !!sse.doneAt,
        sseChars: sse.text.length,
      },
    };
  }

  // ---------- 填充与发送 ----------

  function setInputText(input, text) {
    input.focus();
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      // 用原型 setter 赋值，确保 React 受控组件能收到变化
      const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    // contenteditable：选中全部内容后用 execCommand 插入纯文本（React/自定义编辑器可感知）
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand("insertText", false, text);
      if (!ok || !inputText(input)) {
        input.textContent = text;
        input.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
        );
      }
    } catch {
      input.textContent = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
  }

  function pressEnter(input) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
        })
      );
    }
  }

  // opts.noNewChat: true → 在当前会话内发送（会话复用模式，由 background 负责导航）
  async function handleFill(id, text, opts) {
    currentFillId = id;
    cancelFlag = false;
    stage("fill_start", `${location.pathname} reuse=${!!opts.noNewChat}`);
    try {
      // 1) 默认开新会话（避免上下文污染；失败忽略）
      if (!opts.noNewChat) {
        const newChat = findNewChatButton();
        if (newChat) {
          newChat.click();
          await sleep(1200);
        }
      }

      // 2) 输入框（会话页面渲染有延迟，最多等 15s）
      let input = null;
      for (let i = 0; i < 25; i++) {
        input = findInput();
        if (input && isVisible(input)) break;
        await sleep(600);
      }
      if (!input) {
        stage("no_input");
        reply(id, false, "", `未找到 DeepSeek 输入框（当前页面 ${location.pathname}，页面结构可能已更新）`);
        return;
      }
      stage("input_ready", input.tagName);

      // 3) 写入并校验
      setInputText(input, text);
      await sleep(400);
      if (!inputText(input)) {
        stage("write_failed");
        reply(id, false, "", "无法写入 DeepSeek 输入框（页面结构可能已更新，请在该页面手动粘贴一次以确认可输入）");
        return;
      }
      stage("written", `chars=${inputText(input).length}`);

      // 4) 记录发送前状态：助手文本块数量 + 最后一个块文本
      const beforeCount = assistantBlocks().length;
      const beforeLast = lastAssistantText();
      resetSse();

      // 5) 发送并校验输入框被清空（先 Enter——DeepSeek 默认回车发送，再点发送按钮）
      let sent = false;
      for (let attempt = 0; attempt < 3 && !sent; attempt++) {
        if (attempt === 1) {
          const btn = findSendButton(input);
          if (btn) btn.click();
        } else {
          pressEnter(input);
        }
        await sleep(1200);
        if (!inputText(input)) sent = true;
      }
      if (!sent) {
        stage("send_failed");
        reply(id, false, "", "发送失败：输入框内容未被提交（Enter 与发送按钮均无效，请在该页面手动按一次回车确认可用）");
        return;
      }
      stage("sent");

      // 6) 等待回复：主通道 = SSE 流结束（page-hook），兜底 = DOM 文本块稳定
      const deadline = Date.now() + SEND_TIMEOUT_MS;
      const noSignalAt = Date.now() + NO_SIGNAL_MS;
      let lastText = "";
      let lastChangeAt = Date.now();
      let sawAny = false;

      while (Date.now() < deadline) {
        await sleep(600);

        // 用户取消：立即中止
        if (cancelFlag) {
          reply(id, false, "", "已取消");
          return;
        }

        // 主通道：SSE 已结束且有正文 → 直接返回（不依赖 DOM）
        if (sse.doneAt && sse.text.trim()) {
          stage("reply_via_sse", `chars=${sse.text.length}`);
          reply(id, true, sse.text.trim());
          return;
        }

        // 兜底：DOM 助手文本块
        const blocks = assistantBlocks();
        const cur = blocks.length ? blocks[blocks.length - 1] : "";
        const isNew = !!cur && (blocks.length > beforeCount || cur !== beforeLast);
        if (isNew) {
          sawAny = true;
          if (cur !== lastText) {
            lastText = cur;
            lastChangeAt = Date.now();
          } else if (!sse.startAt && Date.now() - lastChangeAt > STABLE_INTERVAL_MS) {
            stage("reply_via_dom", `chars=${lastText.length}`);
            reply(id, true, lastText);
            return;
          }
        }

        // 既无 SSE 流、也无任何 DOM 变化 → 快速失败，避免长时间"看起来卡死"
        if (!sse.startAt && !sawAny && Date.now() > noSignalAt) {
          stage("no_signal");
          reply(
            id,
            false,
            "",
            "发送后 90s 内未检测到 DeepSeek 回复流（未登录 / 被风控 / 页面接口变更）。" +
              "请在 chat.deepseek.com 手动发一条消息确认可正常回复，再点「页面自检」查看状态"
          );
          return;
        }
      }

      if (sse.text.trim()) {
        reply(id, true, sse.text.trim());
      } else if (sawAny && lastText) {
        reply(id, true, lastText);
      } else {
        stage("timeout");
        reply(id, false, "", "等待 DeepSeek 回复超时（生成过久或页面接口已变更）");
      }
    } catch (e) {
      stage("exception", String(e && e.message));
      reply(id, false, "", `页面执行异常：${e.message || e}`);
    }
  }

  function findNewChatButton() {
    const candidates = [...document.querySelectorAll("button, div[role='button'], a")];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
      if (label === "开启新对话" || label === "New chat" || label === "新建对话") return el;
    }
    return null;
  }

  // 等待：经 background SW 计时。页面隐藏时本地 setTimeout 会被浏览器节流到
  // 最长 1 次/分钟（表现为"卡住"），SW 计时不受影响；SW 不可达时退回本地定时器。
  function sleep(ms) {
    return new Promise((resolve) => {
      let fallback = null;
      const finish = () => {
        if (fallback) clearTimeout(fallback);
        resolve();
      };
      try {
        chrome.runtime.sendMessage({ type: "ds/wait", ms }, () => {
          void chrome.runtime.lastError; // SW 无监听等异常：走兜底
          finish();
        });
      } catch {
        setTimeout(finish, ms);
        return;
      }
      // 兜底：SW 无响应时（异常情况）避免永久挂起；正常路径会先被回包唤醒
      fallback = setTimeout(finish, Math.min(ms + 8000, 20_000));
    });
  }

  // 用户取消：由 background 的 ds/cancel 置位，等待循环里检查
  let cancelFlag = false;
})();
