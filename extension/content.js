// MiniMax Ref Director — DeepSeek Bridge (content script on chat.deepseek.com)
// 职责：接收 background 的 ds/fill → 开新会话 → 填充输入 → 触发发送 →
// 观察助手回复完成 → 经 chrome.runtime.sendMessage({type:"ds/reply"}) 回传。
// DOM 选择器尽力兼容 DeepSeek Web 多个版本（textarea / contenteditable 双策略）。

(() => {
  if (window.__mrdDeepseekBridge) return;
  window.__mrdDeepseekBridge = true;

  const SEND_TIMEOUT_MS = 240_000;
  const STABLE_INTERVAL_MS = 2500;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "ds/ping") {
      sendResponse({ pong: true });
      return;
    }
    if (msg.type === "ds/fill") {
      handleFill(msg.id, msg.text || "");
      sendResponse({ accepted: true });
    }
  });

  function reply(id, ok, text, error) {
    chrome.runtime.sendMessage({ type: "ds/reply", id, ok, text: text || "", error: error || "" });
  }

  // ---------- DOM 定位 ----------

  function findInput() {
    // 新版：div[contenteditable]；旧版：textarea#chat-input
    const ta = document.querySelector("textarea#chat-input, textarea[placeholder]");
    if (ta) return ta;
    const ce = [...document.querySelectorAll('div[contenteditable="true"]')].pop();
    return ce || null;
  }

  function findSendButton() {
    // 优先 aria-label / 文本；其次输入框容器内最后一个可点击元素
    const candidates = [...document.querySelectorAll('button, div[role="button"]')];
    for (const el of candidates) {
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
      if (label === "发送" || label === "send") return el;
    }
    return null;
  }

  function findNewChatButton() {
    const candidates = [...document.querySelectorAll('button, div[role="button"], a')];
    for (const el of candidates) {
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
      if (label === "开启新对话" || label === "New chat" || label === "新建对话") return el;
    }
    return null;
  }

  // 回复区容器：页面底部的主滚动区（取最后一个 markdown 渲染块）
  function lastAssistantText() {
    const blocks = [...document.querySelectorAll(".markdown-body, .ds-markdown, [class*='markdown']")];
    for (let i = blocks.length - 1; i >= 0; i--) {
      const t = (blocks[i].innerText || "").trim();
      if (t) return t;
    }
    return "";
  }

  // ---------- 填充与发送 ----------

  function setInputText(input, text) {
    input.focus();
    if (input.tagName === "TEXTAREA") {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // contenteditable：用粘贴事件插入纯文本（避免 React 状态不同步）
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const pasteEvent = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      input.dispatchEvent(pasteEvent);
    }
  }

  function clickSend(input) {
    const btn = findSendButton();
    if (btn) {
      btn.click();
      return true;
    }
    // 兜底：Enter
    const key = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true });
    input.dispatchEvent(key);
    return true;
  }

  async function handleFill(id, text) {
    try {
      // 1) 尽量开新会话（避免上下文污染；失败忽略）
      const newChat = findNewChatButton();
      if (newChat) {
        newChat.click();
        await sleep(1200);
      }

      // 2) 输入框
      let input = null;
      for (let i = 0; i < 10; i++) {
        input = findInput();
        if (input) break;
        await sleep(600);
      }
      if (!input) {
        reply(id, false, "", "未找到 DeepSeek 输入框（页面结构可能已更新）");
        return;
      }

      const before = lastAssistantText();
      setInputText(input, text);
      await sleep(300);
      clickSend(input);

      // 3) 等待回复完成：文本出现且在稳定窗口内不再增长
      const deadline = Date.now() + SEND_TIMEOUT_MS;
      let lastText = "";
      let lastChangeAt = Date.now();
      let sawAny = false;

      while (Date.now() < deadline) {
        await sleep(700);
        const cur = lastAssistantText();
        const isNew = cur && cur !== before;
        if (isNew) {
          sawAny = true;
          if (cur !== lastText) {
            lastText = cur;
            lastChangeAt = Date.now();
          } else if (Date.now() - lastChangeAt > STABLE_INTERVAL_MS) {
            reply(id, true, lastText);
            return;
          }
        } else if (!sawAny && Date.now() - lastChangeAt > 60_000) {
          // 60s 仍无任何新文本：可能发送失败
          const curInput = findInput();
          if (curInput && ((curInput.tagName === "TEXTAREA" && curInput.value) || curInput.innerText)) {
            // 输入框仍有内容 → 未发送成功，重试一次
            clickSend(curInput);
            lastChangeAt = Date.now();
          }
        }
      }
      if (sawAny && lastText) {
        reply(id, true, lastText);
      } else {
        reply(id, false, "", "等待 DeepSeek 回复超时");
      }
    } catch (e) {
      reply(id, false, "", `页面执行异常：${e.message || e}`);
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
