// MiniMax Ref Director — DeepSeek Bridge (MV3 background service worker)
// 消息流（与 SPA src/utils/llm.js 协议对应）：
//   SPA → 本 SW:  chrome.runtime.sendMessage(EXT_ID,
//      { source: "comfy-minimax-ref", type: "deepseek/complete", id, payload })
//   本 SW → 页面:  chrome.tabs.sendMessage(tabId, { type: "ds/fill", id, text })
//   页面 → 本 SW:  chrome.runtime.sendMessage({ type: "ds/reply", id, ok, text, error })
//   本 SW → SPA:   sendResponse({ source: "comfy-minimax-ref-ext", id, ok, text, error })

const DEEPSEEK_URL = "https://chat.deepseek.com/";
const REQUEST_TIMEOUT_MS = 290_000; // MV3 SW 5 分钟存活上限内

// id → { sendResponse, timer }
const pending = new Map();

async function ensureDeepSeekTab() {
  const tabs = await chrome.tabs.query({ url: "https://chat.deepseek.com/*" });
  if (tabs.length > 0) {
    const active = tabs.find((t) => !t.discarded) || tabs[0];
    return active;
  }
  return chrome.tabs.create({ url: DEEPSEEK_URL, active: false });
}

function resolvePending(id, payload) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  try {
    entry.sendResponse({ source: "comfy-minimax-ref-ext", id, ...payload });
  } catch {
    // SPA 侧已关闭连接（页面刷新/关闭），忽略
  }
}

function armTimeout(id) {
  const entry = pending.get(id);
  if (!entry) return;
  entry.timer = setTimeout(() => {
    resolvePending(id, { ok: false, error: "DeepSeek 页面响应超时（请确认已登录 chat.deepseek.com）" });
  }, REQUEST_TIMEOUT_MS);
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== "comfy-minimax-ref" || msg.type !== "deepseek/complete") {
    return false;
  }
  const { id, payload } = msg;
  if (!id || pending.has(id)) {
    sendResponse({ source: "comfy-minimax-ref-ext", id: id || "", ok: false, error: "无效或重复的请求 id" });
    return false;
  }
  const system = (payload && payload.system) || "";
  const prompt = (payload && payload.prompt) || "";
  const expectJson = !!(payload && payload.expectJson);
  const text = system ? `${system}\n\n---\n${prompt}` : prompt;
  if (!text.trim()) {
    sendResponse({ source: "comfy-minimax-ref-ext", id, ok: false, error: "prompt is empty" });
    return false;
  }

  pending.set(id, { sendResponse, timer: null });
  armTimeout(id);

  (async () => {
    try {
      const tab = await ensureDeepSeekTab();
      if (!tab || tab.id == null) {
        resolvePending(id, { ok: false, error: "无法打开 chat.deepseek.com 标签页" });
        return;
      }
      // 等待 content script 就绪（新开标签页时页面需要加载时间）
      let injected = false;
      for (let i = 0; i < 30; i++) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "ds/ping" });
          injected = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!injected) {
        resolvePending(id, { ok: false, error: "DeepSeek 页面未就绪（未登录或页面加载失败）" });
        return;
      }
      await chrome.tabs.sendMessage(tab.id, { type: "ds/fill", id, text, expectJson });
      // 应答由 content script 经 ds/reply 异步回传
    } catch (e) {
      resolvePending(id, { ok: false, error: `桥接调用失败：${e.message || e}` });
    }
  })();

  return true; // 异步 sendResponse
});

// content script → SW：回传生成结果
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "ds/reply" || !msg.id) return;
  resolvePending(msg.id, { ok: !!msg.ok, text: msg.text || "", error: msg.error || "" });
});
