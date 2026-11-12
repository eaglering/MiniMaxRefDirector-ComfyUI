// MiniMax Ref Director — DeepSeek Bridge (content script on chat.deepseek.com)
// 职责：
// 1) 接收 background 的 ds/input_ready / ds/write / ds/enter / ds/sent_check 同步指令 →
//    观察助手回复完成 → 经 chrome.runtime.sendMessage({type:"ds/reply"}) 回传。
// 2) 会话管理：ds/list_sessions / ds/read_session / ds/new_session /
//    ds/rename_session —— 走 chat.deepseek.com 站内 API
//    （同源带 cookie fetch）。
// 3) ds/probe：自检（输入框/发送按钮/回复区是否可定位），供前端「页面自检」按钮调用。
// DOM 选择器尽力兼容 DeepSeek Web 多个版本（textarea / contenteditable 双策略）。

(() => {
  if (window.__mrdDeepseekBridge) return;
  window.__mrdDeepseekBridge = true;

  // 回复捕获：主通道是 page-hook.js（MAIN world）hook 的 /api/v0/chat/completion
  // SSE 流（不依赖 DOM 类名）；DOM 文本块作为兜底。
  // 注意：所有计时（超时/重试/轮询）都在 background SW 里——页面侧零定时等待，
  // 否则隐藏/冻结标签页的定时器被 Chrome 停摆会导致流程永久卡死。
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
      sse.doneAt = 0;
      sse.lastLen = 0;
      stage("stream_start");
    } else if (d.type === "stream_progress") {
      sse.lastLen = d.length || 0;
    } else if (d.type === "stream_done") {
      // 同一轮可能出现多条流（分片重发/标题生成等）：只保留更长的正文，
      // 避免短片段覆盖真正的答案。正文清空统一由 resetSse() 负责。
      const t = String(d.text || "");
      if (t.length > sse.text.length) sse.text = t;
      sse.doneAt = Date.now();
      stage("stream_done", `len=${t.length} kept=${sse.text.length}`);
    } else if (d.type === "hook_pong") {
      hookAlive = true;
    }
  });

  // MAIN world 钩子（page-hook.js）存活标志：经 postMessage 握手确认。
  // 注意隔离世界看不到页面全局变量，不能用 window.__mrdDsHook 判断。
  let hookAlive = false;

  // ---- 站点适配（host → 会话 URL 结构 / 会话管理 API）----
  // DOM 自动化链路（输入框写入/回车/回复读取）跨站点通用（textarea 与
  // contenteditable 双策略 + 通用 markdown 回复块），只有"会话页 URL 结构"与
  // "会话管理站内 API"因站而异。豆包/千问暂不支持扩展侧会话列表/删除
  //（导入流程不依赖它们：大纲会话由用户在网页里选，分镜设计新会话 id 由
  // 页面 URL 自动获取），对应消息返回明确错误。
  const HOST = location.hostname;
  const SITE = HOST.indexOf("doubao.com") >= 0
    ? { id: "doubao", name: "豆包", chatIdRe: /\/chat\/([0-9A-Za-z_-]+)/, sessionApi: false }
    : (HOST.indexOf("qianwen.com") >= 0 || HOST.indexOf("tongyi.aliyun.com") >= 0 || HOST.indexOf("qwen.ai") >= 0)
      ? { id: "qwen", name: "千问", chatIdRe: /\/(?:qianwen\/)?chat\/([0-9A-Za-z_-]+)/, sessionApi: false }
      : { id: "deepseek", name: "DeepSeek", chatIdRe: /\/a\/chat\/s\/([0-9A-Za-z_-]+)/, sessionApi: true };

  // ---- 站内 API 端点（仅 DeepSeek；同源 fetch，带 cookie）----
  // 路径与响应结构对齐 linuxfight/deepseek4free（pkg/api/instance.go、models/chat.go）。
  // 若 DeepSeek 改版导致失效，可在 chat.deepseek.com 页面打开 DevTools → Network
  // 面板观察真实请求后修改以下常量。
  const DS_API = {
    // 会话列表（分页）：GET …/chat_session/fetch_page?count=&cursor=
    list: "/api/v0/chat_session/fetch_page",
    // 删除整个会话：POST，body {"chat_session_id":"<id>"}（界面「… → 删除」同一端点）
    del: "/api/v0/chat_session/delete",
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "ds/ping":
        // 附带版本：background 据此发现"扩展重载后未刷新的旧标签页"并自动 reload
        sendResponse({ pong: true, v: chrome.runtime.getManifest().version });
        return;
      case "ds/probe":
        probe().then(sendResponse);
        return true;
      case "ds/cancel":
        // 用户在导入界面点了取消：中止当前 fill 的等待循环
        cancelFlag = true;
        sendResponse({ cancelled: true });
        return;
      case "ds/input_ready":
        sendResponse(inputReady());
        return;
      case "ds/write":
        sendResponse(writePrompt(msg.id || "", msg.text || ""));
        return;
      case "ds/enter":
        sendResponse(enterNow(msg.marker || ""));
        return;
      case "ds/sent_check":
        sendResponse(sentCheck(msg.marker || "", msg.beforeMarker, msg.pathBefore));
        return;
      case "ds/click_send":
        // 同步动作：点击发送按钮（Enter 无效时的备选）
        sendResponse(clickSend());
        return;
      case "ds/check":
        // 同步状态快照：SSE 捕获 + DOM 回复块 + 取消标志（供 SW 轮询判定）
        sendResponse(checkState(msg.id || ""));
        return;
      case "ds/list_sessions":
        if (!SITE.sessionApi) {
          sendResponse({
            ok: false,
            error: `${SITE.name} 网页版暂不支持扩展侧会话列表，请在该网页内手动选择会话（手动导入模式下会话由用户在弹窗第一步选择）`,
          });
          return;
        }
        handleApi(sendResponse, listSessions);
        return true;
      case "ds/delete_session":
        if (!SITE.sessionApi) {
          sendResponse({
            ok: false,
            error: `${SITE.name} 网页版暂不支持扩展侧删除会话，请在该网页内手动管理（建议保留会话，不清理更安全）`,
          });
          return;
        }
        handleApi(sendResponse, () => deleteSession(msg.chat_id));
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

  // 从页面 URL 解析当前会话 id（发送首条消息后各站会跳到会话页）：
  // DeepSeek /a/chat/s/<id>；豆包 /chat/<id>；千问 /(qianwen/)chat/<id>
  function currentChatId() {
    const m = (location.pathname || "").match(SITE.chatIdRe);
    return m ? m[1] : "";
  }

  // ---------- 同步填充协议 ----------
  // 设计要点：页面里不做任何 await/定时等待。隐藏或被冻结的标签页里定时器
  // 会被 Chrome 节流（最长 1 次/分钟）甚至完全停摆，异步流程会在第一个
  // await 处永久挂起；而扩展消息可以随时唤醒页面同步执行。因此：
  //   ds/input_ready → 输入框是否就绪（可见/未禁用）
  //   ds/write       → 只写入，回传回读内容供 SW 校验（防止重渲染丢弃）
  //   ds/enter       → 回车提交，回传发送前基线（助手块/marker 次数/路径）
  //   ds/sent_check  → 核对：输入框是否清空 + 页面上是否真的出现该用户消息
  //   ds/click_send  → 点击发送按钮（Enter 无效时的备选）
  //   ds/check       → 状态快照（SSE/DOM/取消标志），供 SW 轮询取回复
  // 计时、重试、超时、结果判定全部在 background SW 中。

  let lastInput = null; // 最近一次定位到的输入框（verify/click 复用）

  // 输入框是否就绪（SW 轮询用；页面侧零等待）
  function inputReady() {
    const input = findInput();
    const ok = !!(input && isVisible(input) && !input.disabled);
    return {
      ready: ok,
      tag: input ? input.tagName : "",
      vis: document.visibilityState,
      path: location.pathname,
    };
  }

  // 只写入、不回车。回读内容回传给 SW 校验——避免"写进去又被重渲染丢弃"被误判成功。
  function writePrompt(id, text) {
    currentFillId = id;
    cancelFlag = false;
    stage("write_start", `${location.pathname} vis=${document.visibilityState}`);
    try {
      const input = findInput();
      if (!input || !isVisible(input)) {
        stage("no_input");
        return { status: "no_input" };
      }
      lastInput = input;
      setInputText(input, text);
      const readBack = inputText(input);
      stage("write_done", `chars=${readBack.length}/${String(text).length}`);
      if (!readBack) return { status: "write_failed" };
      return {
        status: "written",
        readBackLen: readBack.length,
        prefix: readBack.slice(0, 40),
      };
    } catch (e) {
      stage("exception", String(e && e.message));
      return { status: "error", error: `页面执行异常：${(e && e.message) || e}` };
    }
  }

  function countInBody(marker) {
    if (!marker) return 0;
    const body = (document.body && document.body.innerText) || "";
    if (!body) return 0;
    return body.split(marker).length - 1;
  }

  // 回车提交，附带"发送前基线"（助手块数量/最后文本/marker 出现次数/路径）
  function enterNow(marker) {
    const input = lastInput && lastInput.isConnected ? lastInput : findInput();
    if (!input) return { ok: false, reason: "no_input" };
    lastInput = input;
    const beforeCount = assistantBlocks().length;
    const beforeLast = lastAssistantText();
    const beforeMarker = countInBody(marker);
    const pathBefore = location.pathname;
    resetSse();
    pressEnter(input);
    stage("enter_sent", `path=${pathBefore} marker=${beforeMarker}`);
    return { ok: true, beforeCount, beforeLast, beforeMarker, pathBefore };
  }

  function clickSend() {
    const input = lastInput && lastInput.isConnected ? lastInput : findInput();
    if (!input) return { clicked: false };
    const btn = findSendButton(input);
    if (btn) {
      btn.click();
      stage("clicked_send");
      return { clicked: true };
    }
    return { clicked: false };
  }

  // 发送结果核对：输入框清空 + 页面上真的出现了这条用户消息（唯一可信判据）
  function sentCheck(marker, beforeMarker, pathBefore) {
    const input = lastInput && lastInput.isConnected ? lastInput : findInput();
    lastInput = input;
    const empty = !input || !inputText(input);
    const markerCount = countInBody(marker);
    const blocks = assistantBlocks();
    return {
      inputEmpty: empty,
      markerCount,
      markerAppeared: markerCount > (Number(beforeMarker) || 0),
      pathChanged: location.pathname !== String(pathBefore || ""),
      blockCount: blocks.length,
      sseActive: !!sse.startAt,
      chatId: currentChatId(),
    };
  }

  function checkState(msgId) {
    const blocks = assistantBlocks();
    return {
      stale: currentFillId !== msgId,
      cancelled: cancelFlag,
      sseActive: !!sse.startAt,
      sseDone: !!sse.doneAt,
      sseText: sse.text,
      blockCount: blocks.length,
      lastBlockText: blocks.length ? blocks[blocks.length - 1] : "",
      chatId: currentChatId(),
    };
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

  // 删除整个会话（导入结束后清理本次新建的会话）。注意：DeepSeek 没有删除
  // 单条消息的能力，只能删整个会话；用户原会话里的消息无法撤回。
  async function deleteSession(chatId) {
    if (!chatId) throw new Error("缺少 chat_id");
    await api(DS_API.del, { method: "POST", body: { chat_session_id: chatId } });
    return { ok: true, chatId };
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
  async function probe() {
    // 钩子握手：发 ping 等 pong（page-hook 在 MAIN world，须经 postMessage 探测）
    hookAlive = false;
    try {
      window.postMessage({ __mrd_ds_ping: 1 }, "*");
    } catch {
      // 忽略
    }
    await sleep(350);

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
        visibility: document.visibilityState,
        wasDiscarded: !!document.wasDiscarded,
        inputFound: !!input,
        inputKind: input ? input.tagName : "",
        inputCandidates: cands,
        sendButtonFound: !!btn,
        sendButtonLabel: btn
          ? (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").slice(0, 40)
          : "",
        assistantBlocks: blocks.length,
        lastBlockChars: blocks.length ? blocks[blocks.length - 1].length : 0,
        hookInstalled: hookAlive,
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
