// MiniMax Ref Director — DeepSeek Bridge (MV3 background service worker)
//
// 两条通道并存：
// 1) 页面外部消息（SPA / ComfyUI 页面经 externally_connectable）：
//    SPA → 本 SW: chrome.runtime.sendMessage(EXT_ID, {
//        source: "comfy-minimax-ref", type, id, payload })
//    type ∈ deepseek/complete | deepseek/list_sessions | deepseek/read_session |
//          deepseek/new_session | deepseek/delete_messages | deepseek/rename_session |
//          deepseek/set_bridge_url | deepseek/bridge_status
//    本 SW ↔ 页面 content: chrome.tabs.sendMessage(tabId, { type: "ds/...", ... })
//    页面 → 本 SW: chrome.runtime.sendMessage({ type: "ds/reply", id, ok, text, error })
//    本 SW → SPA:  sendResponse({ source: "comfy-minimax-ref-ext", id, ok, ... })
//
// 2) ComfyUI WebSocket 直连（后端 Python 执行期调用，无需打开任何页面）：
//    本 SW 主动连接 ComfyUI 桥接端点（默认 ws://127.0.0.1:8188/minimax_ref/api/deepseek/bridge，
//    可经 deepseek/set_bridge_url 或 chrome.storage.local 的 mrdBridgeUrl 配置），
//    注册 {type:"register"} → 接收 {type:"llm_task", id, payload} →
//    走 content 填充链路 → 回传 {type:"llm_result", id, ok, text, error}。

const DEEPSEEK_URL = "https://chat.deepseek.com/";
// 会话页真实路径为 /a/chat/s/<session_id>（旧版曾为 /a/<id>）
const DEEPSEEK_CHAT_URL = (id) => `https://chat.deepseek.com/a/chat/s/${id}`;
const REQUEST_TIMEOUT_MS = 290_000; // MV3 SW 5 分钟存活上限内
const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8188/minimax_ref/api/deepseek/bridge";
const HEARTBEAT_MS = 20_000;
const EXT_SOURCE = "comfy-minimax-ref";
const EXT_RESP_SOURCE = "comfy-minimax-ref-ext";
const EXT_VERSION = chrome.runtime.getManifest().version;

// id → { sendResponse, timer }
const pending = new Map();

// 最近一次生成请求的阶段流水（content 的 ds/stage 上报），供「页面自检」诊断
let lastAttempt = null;

// ---------------- DeepSeek 标签页管理 ----------------

async function ensureDeepSeekTab() {
  const tabs = await chrome.tabs.query({ url: "https://chat.deepseek.com/*" });
  if (tabs.length > 0) {
    // 用户正在看的（active）标签页优先；不强制激活、不抢焦点——
    // 隐藏标签页的定时器节流已由 ds/wait（SW 计时）规避，后台操作完全可靠
    const active = tabs.find((t) => t.active && !t.discarded);
    if (active) return active;
    return tabs.find((t) => !t.discarded) || tabs[0];
  }
  return chrome.tabs.create({ url: DEEPSEEK_URL, active: false });
}

// 等待 content script 就绪（新开/导航后的页面需要加载时间）。
// 关键：扩展「重新加载」后，已打开的标签页仍运行旧版 content script（不会自动更新），
// ping 回包带版本号，发现不一致就 reload 该标签页 —— 消除"页面毫无反应"的隐性故障。
async function waitForContent(tabId, rounds = 30) {
  let reloaded = false;
  for (let i = 0; i < rounds; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "ds/ping" });
      if (resp && resp.pong) {
        if (resp.v && resp.v !== EXT_VERSION && !reloaded) {
          reloaded = true;
          await chrome.tabs.reload(tabId);
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        return true;
      }
    } catch {
      // content 未注入或页面正在加载
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// 阶段流水：runComplete 主链路的关键节点（供「页面自检」与运行中轮询展示）
function noteStage(stage, detail = "") {
  if (!lastAttempt) return;
  lastAttempt.stages.push({ at: Date.now(), stage, detail });
  if (lastAttempt.stages.length > 40) lastAttempt.stages.shift();
}

// 用户取消：把所有挂起请求立即以错误回包，并通知 content 停止等待
function cancelAllPending(reason) {
  let n = 0;
  for (const [id, entry] of Array.from(pending.entries())) {
    pending.delete(id);
    clearTimeout(entry.timer);
    try {
      entry.sendResponse({ source: EXT_RESP_SOURCE, id, ok: false, error: reason });
    } catch {
      // 调用方已断开
    }
    n++;
  }
  noteStage("cancelled", `pending=${n}`);
  ensureDeepSeekTab()
    .then((tab) => {
      if (tab && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: "ds/cancel" }).catch(() => {});
      }
    })
    .catch(() => {});
  return n;
}

async function ensureReadyTab() {
  const tab = await ensureDeepSeekTab();
  if (!tab || tab.id == null) throw new Error("无法打开 chat.deepseek.com 标签页");
  const ok = await waitForContent(tab.id);
  if (!ok) throw new Error("DeepSeek 页面未就绪（未登录或页面加载失败）");
  return tab;
}

function resolvePending(id, payload) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  try {
    entry.sendResponse({ source: EXT_RESP_SOURCE, id, ...payload });
  } catch {
    // 调用方已关闭连接（页面刷新/关闭），忽略
  }
}

function armTimeout(id) {
  const entry = pending.get(id);
  if (!entry) return;
  entry.timer = setTimeout(() => {
    resolvePending(id, { ok: false, error: "DeepSeek 页面响应超时（请确认已登录 chat.deepseek.com）" });
  }, REQUEST_TIMEOUT_MS);
}

// ---------------- 完成请求（两种通道共用） ----------------
// opts.sendResponse: (resp) => void —— 外部消息用真实 sendResponse，WS 任务用回传函数。

async function runComplete(id, payload, sendResponse) {
  const system = (payload && payload.system) || "";
  const prompt = (payload && payload.prompt) || "";
  const expectJson = !!((payload && (payload.expectJson || payload.expect_json)));
  const sessionMode = (payload && payload.session_mode) || "new";
  const chatId = (payload && payload.chat_id) || "";
  const text = system ? `${system}\n\n---\n${prompt}` : prompt;
  if (!text.trim()) {
    sendResponse({ source: EXT_RESP_SOURCE, id, ok: false, error: "prompt is empty" });
    return;
  }

  pending.set(id, { sendResponse, timer: null });
  armTimeout(id);
  lastAttempt = {
    id,
    startedAt: Date.now(),
    promptChars: text.length,
    sessionMode,
    chatId,
    stages: [{ at: Date.now(), stage: "queued", detail: `${sessionMode}${chatId ? `:${String(chatId).slice(0, 8)}` : ""} prompt=${text.length}` }],
  };

  try {
    const tab = await ensureDeepSeekTab();
    if (!tab || tab.id == null) {
      resolvePending(id, { ok: false, error: "无法打开 chat.deepseek.com 标签页" });
      return;
    }
    noteStage("tab_ready", `tab=${tab.id}`);

    if (sessionMode === "reuse" && chatId) {
      // 复用指定会话：必要时导航到该会话页面（页面重载后 content 重新注入）
      const target = DEEPSEEK_CHAT_URL(chatId);
      const cur = (tab.url || "").split("#")[0].split("?")[0];
      if (cur !== target) {
        noteStage("navigating", `${target.slice(-32)}`);
        await chrome.tabs.update(tab.id, { url: target });
        const ready = await waitForContent(tab.id, 90);
        if (!ready) {
          resolvePending(id, { ok: false, error: "DeepSeek 会话页面未就绪（未登录或会话不存在）" });
          return;
        }
        noteStage("nav_done");
        // 会话页需要加载历史消息，留出渲染时间
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        const ready = await waitForContent(tab.id);
        if (!ready) {
          resolvePending(id, { ok: false, error: "DeepSeek 页面未就绪（未登录或页面加载失败）" });
          return;
        }
      }
      noteStage("fill_sent");
      await chrome.tabs.sendMessage(tab.id, { type: "ds/fill", id, text, expectJson, opts: { noNewChat: true } });
    } else {
      // 默认：新会话模式。先回首页再点「开启新对话」——即使按钮定位失败，
      // 从首页发送也会自动创建新会话，绝不会污染用户当前打开的会话。
      if ((tab.url || "").indexOf("/a/chat/s/") >= 0) {
        noteStage("go_home");
        await chrome.tabs.update(tab.id, { url: DEEPSEEK_URL });
      }
      const ready = await waitForContent(tab.id, 60);
      if (!ready) {
        resolvePending(id, { ok: false, error: "DeepSeek 页面未就绪（未登录或页面加载失败）" });
        return;
      }
      noteStage("fill_sent");
      await chrome.tabs.sendMessage(tab.id, { type: "ds/fill", id, text, expectJson });
    }
    // 应答由 content script 经 ds/reply 异步回传
  } catch (e) {
    resolvePending(id, { ok: false, error: `桥接调用失败：${e.message || e}` });
  }
}

// ---------------- 会话管理（转发给 content script 的站内 API） ----------------

async function sessionOp(msg, sendResponse, contentType, extra) {
  const resp = { source: EXT_RESP_SOURCE, id: msg.id || "" };
  try {
    const tab = await ensureReadyTab();
    const result = await chrome.tabs.sendMessage(tab.id, { type: contentType, ...extra });
    if (!result || typeof result !== "object") {
      sendResponse({ ...resp, ok: false, error: "扩展返回异常" });
      return;
    }
    sendResponse({ ...resp, ok: !!result.ok, data: result.data, error: result.error || "" });
  } catch (e) {
    sendResponse({ ...resp, ok: false, error: `桥接调用失败：${e.message || e}` });
  }
}

// ---------------- 自检（前端「页面自检」按钮） ----------------

async function runDiag(sendResponse) {
  const resp = { source: EXT_RESP_SOURCE, ok: true, data: {} };
  resp.data.version = EXT_VERSION;
  try {
    // 列出全部 DeepSeek 标签页：多个标签页时容易"填错页"，诊断时一目了然
    const all = await chrome.tabs.query({ url: "https://chat.deepseek.com/*" });
    resp.data.tabs = all.map((t) => ({
      id: t.id,
      active: !!t.active,
      discarded: !!t.discarded,
      url: (t.url || "").replace("https://chat.deepseek.com", "") || "/",
    }));
    const tab = await ensureDeepSeekTab();
    resp.data.tabId = tab && tab.id != null ? tab.id : null;
    resp.data.tabUrl = (tab && tab.url) || "";
    const ready = tab && tab.id != null ? await waitForContent(tab.id, 20) : false;
    resp.data.contentReady = ready;
    if (ready) {
      const probe = await chrome.tabs.sendMessage(tab.id, { type: "ds/probe" });
      resp.data.probe = (probe && probe.data) || probe || null;
    }
    resp.data.bridge = { connected: !!bridgeWs && bridgeWs.readyState === 1, url: bridgeUrl };
    if (lastAttempt) {
      resp.data.lastAttempt = {
        startedAt: lastAttempt.startedAt,
        promptChars: lastAttempt.promptChars,
        sessionMode: lastAttempt.sessionMode,
        stages: lastAttempt.stages.slice(-12),
      };
    }
  } catch (e) {
    resp.ok = false;
    resp.error = `自检失败：${e.message || e}`;
  }
  sendResponse(resp);
}

// ---------------- 外部消息入口（SPA / ComfyUI 页面） ----------------

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== EXT_SOURCE || !msg.type) return false;

  switch (msg.type) {
    case "deepseek/complete":
      runComplete(msg.id, msg.payload, sendResponse);
      return true; // 异步 sendResponse

    case "deepseek/list_sessions":
      sessionOp(msg, sendResponse, "ds/list_sessions", {}).catch(() => {});
      return true;

    case "deepseek/read_session":
      sessionOp(msg, sendResponse, "ds/read_session", { chat_id: msg.chat_id }).catch(() => {});
      return true;

    case "deepseek/new_session":
      sessionOp(msg, sendResponse, "ds/new_session", {}).catch(() => {});
      return true;

    case "deepseek/delete_messages":
      sessionOp(msg, sendResponse, "ds/delete_messages", {
        chat_id: msg.chat_id,
        message_ids: msg.message_ids,
        keep_count: msg.keep_count,
      }).catch(() => {});
      return true;

    case "deepseek/rename_session":
      sessionOp(msg, sendResponse, "ds/rename_session", { chat_id: msg.chat_id, title: msg.title }).catch(() => {});
      return true;

    case "deepseek/set_bridge_url": {
      const url = String(msg.url || "").trim();
      if (!/^wss?:\/\//i.test(url)) {
        sendResponse({ source: EXT_RESP_SOURCE, ok: false, error: "无效的 WebSocket 地址" });
        return false;
      }
      chrome.storage.local.set({ mrdBridgeUrl: url });
      // storage.onChanged 监听器会触发重连
      sendResponse({ source: EXT_RESP_SOURCE, ok: true, data: { url } });
      return false;
    }

    case "deepseek/bridge_status":
      sendResponse({
        source: EXT_RESP_SOURCE,
        ok: true,
        data: { connected: !!bridgeWs && bridgeWs.readyState === 1, url: bridgeUrl },
      });
      return false;

    case "deepseek/diag":
      runDiag(sendResponse);
      return true;

    // 轻量阶段查询（无副作用，供运行中轮询显示进度）
    case "deepseek/attempt":
      sendResponse({ source: EXT_RESP_SOURCE, ok: true, data: { version: EXT_VERSION, lastAttempt } });
      return false;

    // 取消：立即回包所有挂起请求并通知 content 停止
    case "deepseek/cancel":
      sendResponse({
        source: EXT_RESP_SOURCE,
        ok: true,
        data: { version: EXT_VERSION, cancelled: cancelAllPending("已取消（用户在导入界面点击取消）") },
      });
      return false;

    default:
      return false;
  }
});

// content script → SW：回传生成结果 / 阶段上报 / 计时代理
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // 计时代理：页面隐藏时本地 setTimeout 会被节流（最长 1 次/分钟），
  // 由 SW 计时并回包，content 的等待不再受标签页可见性影响
  if (msg.type === "ds/wait") {
    const ms = Math.max(0, Math.min(Number(msg.ms) || 0, 10_000));
    setTimeout(() => {
      try {
        sendResponse({ ok: true });
      } catch {
        // 页面已关闭
      }
    }, ms);
    return true;
  }

  if (msg.type === "ds/reply" && msg.id) {
    // chat_id：content 从页面 URL 解析的当前会话 id（新会话模式的取号方式）
    resolvePending(msg.id, {
      ok: !!msg.ok,
      text: msg.text || "",
      error: msg.error || "",
      chat_id: msg.chatId || "",
    });
    return;
  }
  // 阶段上报：记录到 lastAttempt，供「页面自检」展示卡点
  if (msg.type === "ds/stage" && msg.id) {
    const rec = lastAttempt && lastAttempt.id === msg.id ? lastAttempt : null;
    const target = rec || { id: msg.id, startedAt: Date.now(), stages: [] };
    target.stages.push({ at: Date.now(), stage: msg.stage || "", detail: msg.detail || "" });
    if (target.stages.length > 40) target.stages.shift();
    lastAttempt = target;
  }
});

// ---------------- ComfyUI WebSocket 直连 ----------------

let bridgeWs = null;
let bridgeUrl = DEFAULT_BRIDGE_URL;
let wsBackoffMs = 1000;
let wsReconnectTimer = null;
let heartbeatTimer = null;

function sendWs(obj) {
  if (bridgeWs && bridgeWs.readyState === 1) {
    try {
      bridgeWs.send(JSON.stringify(obj));
    } catch {
      // 忽略瞬时发送失败，由 onclose 触发重连
    }
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectBridge, wsBackoffMs);
  wsBackoffMs = Math.min(wsBackoffMs * 2, 30_000);
}

function connectBridge() {
  clearTimeout(wsReconnectTimer);
  if (bridgeWs && (bridgeWs.readyState === 0 || bridgeWs.readyState === 1)) return;
  try {
    bridgeWs = new WebSocket(bridgeUrl);
  } catch {
    bridgeWs = null;
    scheduleReconnect();
    return;
  }
  bridgeWs.onopen = () => {
    wsBackoffMs = 1000;
    sendWs({ type: "register", source: EXT_RESP_SOURCE, ext_version: chrome.runtime.getManifest().version });
    stopHeartbeat();
    heartbeatTimer = setInterval(() => sendWs({ type: "ping" }), HEARTBEAT_MS);
  };
  bridgeWs.onmessage = (ev) => {
    handleBridgeMessage(ev.data).catch(() => {});
  };
  bridgeWs.onclose = () => {
    stopHeartbeat();
    bridgeWs = null;
    scheduleReconnect();
  };
  bridgeWs.onerror = () => {
    try {
      if (bridgeWs) bridgeWs.close();
    } catch {
      // 忽略
    }
  };
}

async function handleBridgeMessage(raw) {
  let msg = null;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!msg || !msg.type) return;
  if (msg.type === "pong" || msg.type === "welcome") return;
  if (msg.type !== "llm_task" || !msg.id) return;

  // 与外部消息共用 content 填充链路；结果经 WS 回传给 ComfyUI
  const payload = msg.payload || {};
  const innerId = `ws-${msg.id}`;
  const wsReply = (resp) => {
    sendWs({
      type: "llm_result",
      id: msg.id,
      ok: !!(resp && resp.ok),
      text: (resp && resp.text) || "",
      error: (resp && resp.error) || "",
    });
  };
  await runComplete(innerId, payload, wsReply);
}

// 初始化：读取配置并建立连接
chrome.storage.local.get(["mrdBridgeUrl"], (r) => {
  const url = r && r.mrdBridgeUrl;
  if (url && /^wss?:\/\//i.test(url)) bridgeUrl = url;
  connectBridge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.mrdBridgeUrl) return;
  const url = changes.mrdBridgeUrl.newValue;
  bridgeUrl = url && /^wss?:\/\//i.test(url) ? url : DEFAULT_BRIDGE_URL;
  wsBackoffMs = 1000;
  if (bridgeWs) {
    try {
      bridgeWs.close(); // onclose → scheduleReconnect → 以新地址重连
    } catch {
      // 忽略
    }
  } else {
    connectBridge();
  }
});

// 周期闹钟：唤醒 SW 并确保 WS 连接存在（MV3 SW 可能被回收）
chrome.alarms.create("mrd-bridge-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "mrd-bridge-keepalive") connectBridge();
});
