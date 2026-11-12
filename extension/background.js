// MiniMax Ref Director — DeepSeek Bridge (MV3 background service worker)
//
// 两条通道并存：
// 1) 页面外部消息（SPA / ComfyUI 页面经 externally_connectable）：
//    SPA → 本 SW: chrome.runtime.sendMessage(EXT_ID, {
//        source: "comfy-minimax-ref", type, id, payload })
//    type ∈ deepseek/complete | deepseek/list_sessions | deepseek/read_session |
//          deepseek/list_sessions |
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

// ---------------- 多站点适配（deepseek / doubao / qwen） ----------------
// 三类网页对话站共用同一桥接协议与 DOM 自动化链路，仅站点元数据不同：
// 标签页匹配、首页、会话页 URL 结构由 SITES 定义；消息 payload.site 决定路由
// （缺省 deepseek，兼容旧调用方）。豆包/千问的会话列表/删除暂不支持，
// content script 会返回明确错误。
const SITES = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    host: "chat.deepseek.com",
    home: "https://chat.deepseek.com/",
    pattern: "https://chat.deepseek.com/*",
    homePath: "/",
    chatUrl: (id) => `https://chat.deepseek.com/a/chat/s/${id}`,
    chatPath: (id) => `/a/chat/s/${id}`,
  },
  doubao: {
    id: "doubao",
    name: "豆包",
    host: "www.doubao.com",
    home: "https://www.doubao.com/chat/",
    pattern: "https://www.doubao.com/*",
    homePath: "/chat",
    chatUrl: (id) => `https://www.doubao.com/chat/${id}`,
    chatPath: (id) => `/chat/${id}`,
  },
  qwen: {
    id: "qwen",
    name: "千问",
    host: "www.qianwen.com",
    home: "https://www.qianwen.com/chat/",
    pattern: "https://www.qianwen.com/*",
    homePath: "/chat",
    chatUrl: (id) => `https://www.qianwen.com/chat/${id}`,
    chatPath: (id) => `/chat/${id}`,
  },
};

function siteOf(payload) {
  const key = String((payload && payload.site) || "deepseek").toLowerCase();
  return SITES[key] || SITES.deepseek;
}
const REQUEST_TIMEOUT_MS = 290_000; // MV3 SW 5 分钟存活上限内
const REPLY_TIMEOUT_MS = 240_000; // 等待回复总时长
const NO_SIGNAL_MS = 90_000; // 无任何回复信号的快速失败阈值

function swSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------- 调试事件流水 ----------------
// 记录 SW 侧每一步（阶段、页面消息往返、异常），并持久化到 storage：
// 即使 SW 被回收、或用户来不及点「页面自检」，也能导出完整过程定位卡点。

const DEBUG_MAX = 300;
let debugEvents = [];
let debugPersistTimer = null;

function persistDebug() {
  if (debugPersistTimer) return;
  debugPersistTimer = setTimeout(() => {
    debugPersistTimer = null;
    try {
      chrome.storage.local.set({ mrdDebugLog: debugEvents.slice(-DEBUG_MAX) });
    } catch {
      // 忽略
    }
  }, 800);
}

function dbg(kind, detail = "") {
  debugEvents.push({ at: Date.now(), kind, detail: String(detail || "").slice(0, 300) });
  if (debugEvents.length > DEBUG_MAX) debugEvents.shift();
  persistDebug();
}

chrome.storage.local.get(["mrdDebugLog"], (r) => {
  const prev = r && Array.isArray(r.mrdDebugLog) ? r.mrdDebugLog : [];
  if (prev.length) debugEvents = prev.slice(-DEBUG_MAX);
});

// 页面消息统一加超时：标签页被冻结/关闭时 chrome.tabs.sendMessage 可能永不返回，
// 会让 SW 侧流程无限挂起（外部表现就是"卡住不动"）。
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    ),
  ]);
}

function sendTab(tabId, msg, ms = 8000) {
  return withTimeout(chrome.tabs.sendMessage(tabId, msg), ms, `页面消息 ${(msg && msg.type) || "?"}`);
}
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

async function ensureSiteTab(site) {
  const tabs = await chrome.tabs.query({ url: site.pattern });
  if (tabs.length > 0) {
    // 用户正在看的（active）标签页优先
    const active = tabs.find((t) => t.active && !t.discarded);
    if (active) return active;
    return tabs.find((t) => !t.discarded) || tabs[0];
  }
  return chrome.tabs.create({ url: site.home, active: false });
}

// 兼容旧调用（诊断/取消等默认 DeepSeek）
const ensureDeepSeekTab = () => ensureSiteTab(SITES.deepseek);

// 保证填充期间页面"活着"：隐藏标签页会被 Chrome 冻结（JS 完全停摆）或重度节流，
// 表现为流程卡在某一步。若目标标签页当前不可见，把它挪进一个不抢焦点的小侧窗——
// 可见页面不会被冻结，用户也能顺便看到生成过程，且焦点仍留在原页面。
let _popWinId = null;

async function ensureAliveTab(tab) {
  try {
    const t = await chrome.tabs.get(tab.id);
    let win = null;
    try {
      win = await chrome.windows.get(t.windowId);
    } catch {
      win = null;
    }
    const visible = t.active && win && win.state !== "minimized";
    if (visible) return t;

    // 已在我们弹出的小窗里（该窗口只有这个标签页，即处于 active）→ 无需再动
    if (_popWinId != null) {
      try {
        const pop = await chrome.windows.get(_popWinId);
        if (pop && pop.id === t.windowId) return t;
      } catch {
        _popWinId = null;
      }
    }

    // 计算弹出位置：放在当前聚焦窗口的右侧（不覆盖中心内容）
    let left;
    let top;
    try {
      const cur = await chrome.windows.getLastFocused();
      left = Math.max(0, (cur.left || 0) + (cur.width || 1280) - 450);
      top = Math.max(0, (cur.top || 0) + 60);
    } catch {
      left = 60;
      top = 60;
    }
    const created = await chrome.windows.create({
      tabId: t.id,
      type: "popup",
      focused: false, // 不抢焦点
      width: 430,
      height: 660,
      left,
      top,
    });
    if (created && created.id != null) _popWinId = created.id;
    return t;
  } catch {
    return tab;
  }
}

// 等待 content script 就绪（新开/导航后的页面需要加载时间）。
// 关键：扩展「重新加载」后，已打开的标签页仍运行旧版 content script（不会自动更新），
// ping 回包带版本号，发现不一致就 reload 该标签页 —— 消除"页面毫无反应"的隐性故障。
// 等"页面自己报告的 path"变成目标值。权威来源是 content script 的 location：
// chrome.tabs.update 返回时旧文档仍在运行，此时填充会写到即将卸载的旧页面上，
// 导航完成后文本被一并丢弃（日志表现为 pathChanged=true 但 sse=false）。
async function waitForPath(tabId, wantPath, rounds = 90) {
  // 归一化末尾斜杠：豆包/千问首页为 /chat/，站点可能重定向为 /chat
  const norm = (p) => (p && p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p || "");
  const want = norm(wantPath);
  let last = "";
  for (let i = 0; i < rounds; i++) {
    let r = null;
    try {
      r = await sendTab(tabId, { type: "ds/input_ready" }, 2000);
    } catch {
      // content 尚未注入（整页重载中）
    }
    const p = norm((r && r.path) || "");
    if (p) last = p;
    if (p === want) {
      dbg("nav_confirmed", `path=${p} rounds=${i}`);
      return true;
    }
    await swSleep(500);
  }
  dbg("nav_unconfirmed", `want=${wantPath} last=${last || "(content 未就绪)"}`);
  return false;
}

async function waitForContent(tabId, rounds = 30) {
  let reloaded = false;
  for (let i = 0; i < rounds; i++) {
    try {
      const resp = await sendTab(tabId, { type: "ds/ping" }, 3000);
      if (resp && resp.pong) {
        if (resp.v && resp.v !== EXT_VERSION && !reloaded) {
          reloaded = true;
          dbg("content_stale", `tab=${tabId} v=${resp.v} → reload`);
          await chrome.tabs.reload(tabId);
          await swSleep(2500);
          continue;
        }
        dbg("content_ready", `tab=${tabId} v=${resp.v} rounds=${i}`);
        return true;
      }
    } catch {
      // content 未注入或页面正在加载
    }
    await swSleep(1000);
  }
  dbg("content_timeout", `tab=${tabId} rounds=${rounds}`);
  return false;
}

// 阶段流水：runComplete 主链路的关键节点（供「页面自检」与运行中轮询展示）
function noteStage(stage, detail = "") {
  dbg(`stage:${stage}`, detail);
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
  // 通知全部站点标签页停止等待（取消应覆盖任意站点）
  for (const site of Object.values(SITES)) {
    ensureSiteTab(site)
      .then((tab) => {
        if (tab && tab.id != null) {
          sendTab(tab.id, { type: "ds/cancel" }, 4000).catch(() => {});
        }
      })
      .catch(() => {});
  }
  return n;
}

async function ensureReadyTab(site = SITES.deepseek) {
  const tab = await ensureSiteTab(site);
  if (!tab || tab.id == null) throw new Error(`无法打开 ${site.host} 标签页`);
  const ok = await waitForContent(tab.id);
  if (!ok) throw new Error(`${site.name} 页面未就绪（未登录或页面加载失败）`);
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
    const site = siteOf(payload);
    noteStage("site", `${site.id} (${site.host})`);
    const tab = await ensureSiteTab(site);
    if (!tab || tab.id == null) {
      resolvePending(id, { ok: false, error: `无法打开 ${site.host} 标签页` });
      return;
    }
    noteStage("tab_ready", `tab=${tab.id}`);
    // 隐藏标签页会被 Chrome 冻结（JS 停摆）或重度节流：挪进可见小窗（不抢焦点）
    await ensureAliveTab(tab);

    if (sessionMode === "reuse" && chatId) {
      // 复用指定会话：必要时导航到该会话页面（页面重载后 content 重新注入）
      const target = site.chatUrl(chatId);
      const wantPath = site.chatPath(chatId);
      const cur = (tab.url || "").split("#")[0].split("?")[0];
      if (cur !== target) {
        noteStage("navigating", `${wantPath.slice(-32)}`);
        await chrome.tabs.update(tab.id, { url: target });
        // 关键：必须等"页面自己报告的 path"变成目标值。chrome.tabs.update 立即
        // 返回、旧文档的 content 仍在线，若此时就开始填充，内容会写在即将被
        // 卸载的旧页面上，导航完成后被一起丢弃。
        const navOk = await waitForPath(tab.id, wantPath, 90);
        noteStage(navOk ? "nav_done" : "nav_timeout", wantPath);
        if (!navOk) {
          resolvePending(id, { ok: false, error: `${site.name} 会话页面未就绪（未登录或会话不存在）` });
          return;
        }
        // 会话页需要加载历史消息，留出渲染时间
        await swSleep(1500);
      } else {
        const ready = await waitForContent(tab.id);
        if (!ready) {
          resolvePending(id, { ok: false, error: `${site.name} 页面未就绪（未登录或页面加载失败）` });
          return;
        }
      }
      noteStage("fill_sent");
      await driveFillAndCollect(tab.id, id, text, { noNewChat: true, expectJson, siteName: site.name });
    } else {
      // 默认：新会话模式。先回首页（首页发送会自动创建新会话），绝不污染
      // 用户当前会话。同样必须等 path 真的变成首页路径再动手。
      const normPath = (p) => (p && p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p || "/");
      const curPath = normPath((tab.url || "").replace(/^https?:\/\/[^/]+/, "") || "/");
      if (curPath !== site.homePath) {
        noteStage("go_home", `from=${curPath}`);
        await chrome.tabs.update(tab.id, { url: site.home });
        const navOk = await waitForPath(tab.id, site.homePath, 90);
        noteStage(navOk ? "home_ready" : "home_timeout");
        if (!navOk) {
          resolvePending(id, { ok: false, error: `回到 ${site.name} 首页超时（页面未加载完或网络异常）` });
          return;
        }
        await swSleep(800);
      }
      const ready = await waitForContent(tab.id, 30);
      if (!ready) {
        resolvePending(id, { ok: false, error: `${site.name} 页面未就绪（未登录或页面加载失败）` });
        return;
      }
      noteStage("fill_sent");
      await driveFillAndCollect(tab.id, id, text, { noNewChat: false, expectJson, siteName: site.name });
    }
  } catch (e) {
    resolvePending(id, { ok: false, error: `桥接调用失败：${e.message || e}` });
  }
}

// ---------------- 填充 / 发送 / 等待回复（SW 驱动） ----------------
// 架构约束：页面（content script）里绝不做定时等待。隐藏标签页的定时器会被
// Chrome 节流到最长 1 次/分钟、后台加载的页面甚至会被整页冻结（JS 停摆），
// 异步流程会在第一个 await 处永久挂起——这正是"已找到输入框后卡死"的根因。
// 扩展消息则能随时唤醒页面同步执行。因此页面只做同步动作立即回包，
// 所有计时/重试/轮询/判定都在本 SW 完成（SW 有闹钟保活，不受页面影响）。

async function driveFillAndCollect(tabId, id, text, { noNewChat, expectJson, siteName = "DeepSeek" }) {
  // marker：提示词里的一段特征文本，用于判定"页面上真的出现了这条用户消息"。
  // 注意去掉 Markdown 记号（#/*/` 等）——渲染后的用户消息里不会保留这些字符，
  // 否则 marker 永远匹配不上。
  const marker = String(text)
    .replace(/[`*#>~_|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);

  // ---- 阶段〇：等输入框就绪（路由切换/渲染中有延迟）----
  let ready = false;
  for (let i = 0; i < 25 && !ready; i++) {
    if (!pending.has(id)) return;
    try {
      const r = await sendTab(tabId, { type: "ds/input_ready" }, 4000);
      const p = (r && r.path) || "";
      // 新会话模式必须确认已回到首页：否则会把内容写进旧会话页（随后被导航丢弃，
      // 或直接污染用户原会话）
      ready = !!(r && r.ready) && (noNewChat || p === "/");
      if (i % 5 === 0 || ready) {
        noteStage("input_probe", `try=${i} ready=${ready} path=${p || "?"}`);
      }
    } catch (e) {
      noteStage("input_probe_err", String((e && e.message) || e).slice(0, 80));
    }
    if (!ready) await swSleep(700);
  }
  if (!ready) {
    resolvePending(id, {
      ok: false,
      error: `等待 ${siteName} 输入框就绪超时（页面可能未加载完或未登录）。请点「页面自检」查看输入框候选`,
    });
    return;
  }

  // ---- 阶段一：写入 + 回读校验（防止写入后被路由重渲染丢弃）----
  let written = false;
  for (let round = 0; round < 5 && !written; round++) {
    if (!pending.has(id)) return;
    let w = null;
    try {
      w = await sendTab(tabId, { type: "ds/write", id, text }, 12_000);
    } catch (e) {
      noteStage("write_err", String((e && e.message) || e).slice(0, 80));
      await swSleep(800);
      continue;
    }
    if (w && w.status === "error") {
      resolvePending(id, { ok: false, error: w.error });
      return;
    }
    const prefixOk = !!(w && w.prefix && String(text).startsWith(String(w.prefix).trim()));
    const lenOk = !!(w && w.readBackLen === String(text).length);
    noteStage(
      "write_resp",
      `round=${round} status=${(w && w.status) || "?"} len=${(w && w.readBackLen) || 0}/${String(text).length}`
    );
    written = !!(w && w.status === "written" && (prefixOk || lenOk));
    if (!written) await swSleep(800);
  }
  if (!written) {
    resolvePending(id, {
      ok: false,
      error: `写入 ${siteName} 输入框失败：回读内容与提示词不一致（页面可能正在重渲染）。请手动在该页面粘贴一次确认可输入`,
    });
    return;
  }

  // ---- 阶段二：提交 + 核验"用户消息真的出现在页面上" ----
  // 绝不重复发送：一次回车后，只要输入框被清空就视为已提交（页面渲染用户消息
  // / 回复流 / 新助手块可能延迟数秒才出现），此后只观察、不再写入或再次回车。
  // 只有"文本还留在输入框"才说明没提交成功，允许补点一次发送按钮。
  let sent = false;
  let baseline = null;
  let submits = 0;
  try {
    baseline = await sendTab(tabId, { type: "ds/enter", marker }, 8000);
  } catch (e) {
    noteStage("enter_err", String((e && e.message) || e).slice(0, 80));
  }
  if (baseline && baseline.ok) submits = 1;
  else noteStage("enter_refused", `reason=${(baseline && baseline.reason) || "?"}`);

  for (let round = 0; round < 12 && !sent; round++) {
    if (!pending.has(id)) return;
    await swSleep(round === 0 ? 2000 : 1500);
    let s = null;
    try {
      s = await sendTab(
        tabId,
        {
          type: "ds/sent_check",
          marker,
          beforeMarker: (baseline && baseline.beforeMarker) || 0,
          pathBefore: (baseline && baseline.pathBefore) || "",
        },
        6000
      );
    } catch (e) {
      noteStage("sent_check_err", String((e && e.message) || e).slice(0, 80));
      continue;
    }
    const grew = !!(s && Number(s.blockCount) > Number((baseline && baseline.beforeCount) || 0));
    noteStage(
      "sent_check",
      `round=${round} empty=${!!(s && s.inputEmpty)} marker=${(s && s.markerCount) || 0}/${
        (baseline && baseline.beforeMarker) || 0
      } blocks=${(s && s.blockCount) || 0}/${(baseline && baseline.beforeCount) || 0} sse=${!!(s && s.sseActive)}`
    );
    if (s && s.inputEmpty === false) {
      // 文本仍在输入框：确实没提交。最多补点一次发送按钮，绝不重复写入。
      if (submits < 2) {
        submits += 1;
        noteStage("send_retry", `round=${round} 文本仍在输入框，补点发送按钮`);
        try {
          await sendTab(tabId, { type: "ds/click_send" }, 6000);
        } catch {
          // 忽略
        }
      }
      continue;
    }
    // 输入框已清空 = 已提交（不接受重复发送）。有任一"页面确有反应"的证据即成功。
    if (s && (s.markerAppeared || s.sseActive || grew)) {
      sent = true;
      break;
    }
  }
  if (!sent) {
    resolvePending(id, {
      ok: false,
      error:
        "发送未生效：已回车并点击发送按钮，但输入框未清空或页面上始终没有出现这条消息。" +
        `请在 ${siteName} 页面手动发送一次确认页面可用`,
    });
    return;
  }
  if (!baseline) baseline = {};
  const beforeCount = Number(baseline && baseline.beforeCount) || 0;
  const beforeLast = String((baseline && baseline.beforeLast) || "");
  noteStage("send_ok", `mode=${noNewChat ? "reuse" : "new"} path=${(baseline && baseline.pathBefore) || "?"}`);

  // ---- 阶段三：等待回复（SW 每 4s 轮询页面状态快照）----
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  const noSignalAt = Date.now() + NO_SIGNAL_MS;
  let lastText = "";
  let stableSince = 0;
  let sawAny = false;
  let notJsonAt = 0; // 首次发现"SSE 结束但正文不像 JSON"的时间

  while (Date.now() < deadline) {
    if (!pending.has(id)) return; // 已超时/被取消
    await swSleep(4000);
    let st = null;
    try {
      st = await sendTab(tabId, { type: "ds/check", id }, 6000);
    } catch (e) {
      noteStage("check_miss", String((e && e.message) || e).slice(0, 60));
      continue;
    }
    if (!st || typeof st !== "object") continue;
    if (st.cancelled) {
      resolvePending(id, { ok: false, error: "已取消" });
      return;
    }
    // 主通道：SSE 流已结束且有正文（不依赖 DOM）。
    // expectJson 时不能见到"有文字"就收工：DeepSeek 会先推思考摘要，439 字的
    // 片段当答案必然解析失败。要求正文里出现 JSON 起始符，否则给 20s 宽限等
    // 更完整的正文（content 侧保留最长文本），超时再原样返回交给前端重试。
    if (st.sseDone && String(st.sseText || "").trim()) {
      const sseText = String(st.sseText).trim();
      if (!expectJson || sseText.indexOf("{") >= 0) {
        noteStage("reply_via_sse", `chars=${sseText.length}`);
        resolvePending(id, { ok: true, text: sseText, chat_id: st.chatId || "" });
        return;
      }
      if (!notJsonAt) {
        notJsonAt = Date.now();
        noteStage("reply_not_json_yet", `chars=${sseText.length}`);
      } else if (Date.now() - notJsonAt > 20_000) {
        noteStage("reply_not_json_timeout", `chars=${sseText.length}`);
        resolvePending(id, { ok: true, text: sseText, chat_id: st.chatId || "" });
        return;
      }
    }
    // 兜底：DOM 助手文本块（连续两次轮询相同 = 稳定）
    const cur = String(st.lastBlockText || "");
    const isNew = !!cur && (st.blockCount > beforeCount || cur !== beforeLast);
    if (isNew) {
      sawAny = true;
      if (cur !== lastText) {
        lastText = cur;
        stableSince = Date.now();
      } else if (!st.sseActive && Date.now() - stableSince > 3000) {
        noteStage("reply_via_dom", `chars=${lastText.length}`);
        resolvePending(id, { ok: true, text: lastText, chat_id: st.chatId || "" });
        return;
      }
    }
    // 既无 SSE 流也无 DOM 变化 → 快速失败
    if (!st.sseActive && !sawAny && Date.now() > noSignalAt) {
      noteStage("no_signal");
      resolvePending(id, {
        ok: false,
        error:
          `发送后 90s 内未检测到 ${siteName} 回复流（未登录 / 被风控 / 页面接口变更）。` +
          `请在 ${siteName} 页面手动发一条消息确认可正常回复`,
      });
      return;
    }
  }
  noteStage("timeout");
  resolvePending(id, { ok: false, error: `等待 ${siteName} 回复超时（生成过久或页面接口已变更）` });
}

// ---------------- 会话管理（转发给 content script 的站内 API） ----------------

async function sessionOp(msg, sendResponse, contentType, extra, siteKey) {
  const resp = { source: EXT_RESP_SOURCE, id: msg.id || "" };
  const site = siteOf({ site: siteKey || (msg.payload || {}).site });
  try {
    const tab = await ensureReadyTab(site);
    const result = await sendTab(tab.id, { type: contentType, ...extra }, 30_000);
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
    // 列出全部受支持站点的标签页：多个标签页时容易"填错页"，诊断时一目了然
    const tabs = [];
    for (const site of Object.values(SITES)) {
      const all = await chrome.tabs.query({ url: site.pattern });
      for (const t of all) {
        tabs.push({
          id: t.id,
          site: site.id,
          siteName: site.name,
          active: !!t.active,
          discarded: !!t.discarded,
          url: (t.url || "").replace(`https://${site.host}`, "") || "/",
        });
      }
    }
    resp.data.tabs = tabs;
    const tab = await ensureDeepSeekTab();
    resp.data.tabId = tab && tab.id != null ? tab.id : null;
    resp.data.tabUrl = (tab && tab.url) || "";
    const ready = tab && tab.id != null ? await waitForContent(tab.id, 20) : false;
    resp.data.contentReady = ready;
    if (ready) {
      const probe = await sendTab(tab.id, { type: "ds/probe" }, 12_000);
      resp.data.probe = (probe && probe.data) || probe || null;
    }
    resp.data.bridge = { connected: !!bridgeWs && bridgeWs.readyState === 1, url: bridgeUrl };
    // 完整事件流水（含页面消息往返/超时/阶段），导出让用户直接发来定位卡点
    resp.data.debug = debugEvents.slice(-120);
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
      sessionOp(msg, sendResponse, "ds/list_sessions", {}, (msg.payload || {}).site).catch(() => {});
      return true;

    case "deepseek/delete_session":
      sessionOp(msg, sendResponse, "ds/delete_session", { chat_id: msg.chat_id }, (msg.payload || {}).site).catch(() => {});
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

    // 轻量阶段查询（无副作用，供运行中轮询显示进度 + 调试尾巴）
    case "deepseek/attempt":
      sendResponse({
        source: EXT_RESP_SOURCE,
        ok: true,
        data: { version: EXT_VERSION, lastAttempt, debugTail: debugEvents.slice(-15) },
      });
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
