"""页面侧 JS 常量（注入站点页面执行；热重载后下次注入自动生效）。

所有 JS 均为幂等定义：goto 重置页面上下文后重新注入即恢复；执行只做"找与判"，
写入与点击由 Playwright 定位器完成（isTrusted=true 事件）。
"""

# 页面助手总入口（写入 window.__mrdCdp）
_PAGE_JS = r"""
() => {
  const HOST = location.hostname;
  const SITE = HOST.indexOf("doubao.com") >= 0
    ? { id: "doubao", name: "豆包", chatIdRe: /\/chat\/([0-9A-Za-z_-]+)/, sessionApi: false }
    : (HOST.indexOf("qianwen.com") >= 0 || HOST.indexOf("tongyi.aliyun.com") >= 0 || HOST.indexOf("qwen.ai") >= 0)
      ? { id: "qwen", name: "千问", chatIdRe: /\/(?:qianwen\/)?chat\/([0-9A-Za-z_-]+)/, sessionApi: false }
      : { id: "deepseek", name: "DeepSeek", chatIdRe: /\/a\/chat\/s\/([0-9A-Za-z_-]+)/, sessionApi: false };

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function inputText(input) {
    if (!input) return "";
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") return input.value || "";
    // 富文本编辑器（如千问 Slate）空状态会把占位符渲染为真实 DOM 文本
    // （data-slate-placeholder / data-placeholder），剥离后再读 innerText
    const clone = input.cloneNode(true);
    clone.querySelectorAll("[data-slate-placeholder], [data-placeholder]").forEach((n) => n.remove());
    // 富文本编辑器会把空格写成 NBSP（\u00a0），统一归一化便于比对
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

  // 选中输入框并打标（Python 侧用 data-mrd-input="1" 定位器操作，事件为可信事件）
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
    // 千问新建会话后 URL 恒为 /chat/（不含会话 id）：从侧栏「当前会话」条目
    // 取 id（该条目带 !bg-option 高亮 class）。只认明确的高亮标记，
    // 不猜「最新条目」，避免把用户正在看的其他会话误判成当前会话。
    if (SITE.id === "qwen") {
      const act = document.querySelector('div[data-session-switch-target="normal"][class*="!bg-option"]');
      if (act) {
        const id = act.getAttribute("data-session-id");
        if (id) return id;
      }
    }
    return "";
  }

  function countInBody(marker) {
    if (!marker) return 0;
    // 归一化 NBSP：富文本气泡里的空格常是 \u00a0，直接 count 会漏配
    const body = ((document.body && document.body.innerText) || "").replace(/\u00a0/g, " ");
    const m = String(marker).replace(/\u00a0/g, " ");
    return body ? body.split(m).length - 1 : 0;
  }

  // 单个回复块净化提取：克隆后剥离代码块行号（react-syntax-highlighter）、
  // 头部工具条（语言标签/编辑/复制按钮）等非内容节点，避免污染 JSON 解析。
  function blockText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("span.linenumber, [class*='line-number'], [class*='linenumber']").forEach((n) => n.remove());
    clone.querySelectorAll("button, [class*='copy'], [class*='toolbar']").forEach((n) => n.remove());
    clone.querySelectorAll("pre").forEach((pre) => {
      // 从 pre 向上找"确实包含工具按钮"的代码块容器，剥离除 pre 外的头部
      // （语言标签/编辑/复制按钮）；没找到就不动（语法高亮 token 常被
      // aria-hidden 包裹，绝不能按 aria-hidden 删，否则代码正文会被清空）
      let box = pre.parentElement;
      for (let i = 0; i < 3 && box && box !== clone; i++) {
        if (box.querySelector("button, [class*='copy']")) {
          [...box.children].forEach((ch) => { if (ch !== pre) ch.remove(); });
          break;
        }
        box = box.parentElement;
      }
    });
    // 注意：脱离文档的克隆节点没有布局，innerText 恒为空 —— 需离屏挂载后再取
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none;" +
      `width:${Math.max(el.clientWidth || 0, 600)}px;`;
    host.appendChild(clone);
    document.body.appendChild(host);
    const text = clone.innerText || clone.textContent || "";
    host.remove();
    // 语言标签头部是 markdown 块的兄弟节点（克隆够不到），这里兜底剥掉
    // 首行裸语言标记（json / python / ...），避免污染 JSON 解析
    return text
      .replace(/\u00a0/g, " ")
      .replace(/^(json|javascript|python|java|cpp|c|js|ts|typescript|xml|html|css|yaml|yml|bash|shell|sql|markdown|md|plain|text)\s*\n/i, "")
      .trim();
  }

  function blockSel() {
    // 豆包：消息正文统一挂在 [data-testid="message_text_content"]（md-box-root），
    // 且 [class*='markdown'] 在豆包零命中 —— 只按 markdown 类名找会导致 DOM 回复
    // 通道完全失效（表现为大纲等步骤一直"执行中"直到超时）。
    // 用 receive_message 祖先限定，排除用户自己的消息气泡（send_message）。
    if (SITE.id === "doubao") {
      return '[data-testid="receive_message"] [data-testid="message_text_content"]';
    }
    return ".ds-markdown, .markdown-body, [class*='markdown']";
  }

  function assistantBlocks() {
    return [...document.querySelectorAll(blockSel())].map(blockText).filter((t) => t);
  }

  // 指定容器内的回复块（用于只读"最后一轮"答案，避免取到上一轮回复）
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

  // 发送结果核对（与扩展 sentCheck 一致）
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
      // 对话轮数：用户消息入 DOM 时立即 +1（千问 .chat-round，其他站为 0 不影响判定）
      roundCount: document.querySelectorAll(".chat-round").length,
      // 用户消息气泡数（千问 .message-card-wrap.question；其他站为 0）
      userMsgCount: document.querySelectorAll(".message-card-wrap.question").length,
      chatId: currentChatId(),
    };
  }

  // DOM 回复快照（Python 侧合并 SSE 通道后判定）
  function domSnapshot(beforeCount, beforeLast) {
    const blocks = assistantBlocks();
    const last = blocks.length ? blocks[blocks.length - 1] : "";
    const cur = last;
    const isNew = !!cur && (blocks.length > (beforeCount || 0) || cur !== (beforeLast || ""));
    return {
      blockCount: blocks.length,
      lastBlockText: last,
      lastBlockChanged: isNew && cur !== (beforeLast || ""),
      // 对话轮数：新用户消息入 DOM 即 +1（注意：早于回复到达，不能单独作为
      // "回复已到"的判据）
      roundCount: document.querySelectorAll(".chat-round").length,
      // 最后一轮内的答案文本（只读最新一轮，天然排除上一轮回复；
      // 无 .chat-round 的站点为空串，走 lastBlockText 兜底）
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

# DeepSeek 站内 API（同源 fetch，带 cookie；移植 content.js）
# DeepSeek：悬停会话条目后标记行内/邻近的「更多」按钮候选（多个候选时逐个尝试）。
# DeepSeek 侧栏条目 hover 才显示操作按钮（svg 小方块，无稳定 aria/class 约定），
# 因此按"锚点旁的小尺寸可点击元素"启发式标记，Python 侧用 data-mrd-more 定位后
# 以 Playwright 可信事件点击。
_DS_MORE_BUTTON_JS = r"""
([chatId]) => {
  const a = [...document.querySelectorAll('a[href]')]
    .find((el) => (el.getAttribute("href") || "").includes(chatId));
  if (!a) return { found: false, reason: "anchor not found" };
  document.querySelectorAll("[data-mrd-more]").forEach((e) => e.removeAttribute("data-mrd-more"));
  const picked = [];
  // 从锚点向外最多 4 层找行容器；候选 = 容器内不在锚点内的小尺寸可点击元素
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

# DeepSeek：在弹出菜单（portal/浮层）中标记「删除」项。菜单项无稳定 role/class，
# 按"可见且文本含删除"的叶子级可点击元素启发式定位（排除会话行内的误命中：
# 限制在弹出层容器 [class*='menu'/'dropdown'/'popover'/portal] 或 body 直接浮层内）。
_DS_DELETE_ITEM_JS = r"""
() => {
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
  };
  document.querySelectorAll("[data-mrd-del]").forEach((e) => e.removeAttribute("data-mrd-del"));
  // 取所有可见叶子元素中，自身文本（不含后代）含"删除"的
  const leaves = [...document.querySelectorAll("body *")].filter((el) => {
    if (!isVisible(el)) return false;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent || "").join("");
    if (!own.includes("删除")) return false;
    // 排除侧栏会话行（锚点内部）
    return !el.closest("a[href]");
  });
  if (!leaves.length) return { found: false };
  // 取最内层（文本真正挂在其上的节点）
  const target = leaves[leaves.length - 1];
  target.setAttribute("data-mrd-del", "1");
  return { found: true, cls: String(target.className || "").slice(0, 60), text: (target.textContent || "").slice(0, 30) };
}
"""

# 豆包：UI 扫描会话侧栏
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
    // 标题节点可能有多份（含空的可访问性/悬浮层副本）：取第一个非空文本
    const cands = [...el.querySelectorAll('[class*="text-ellipsis"], [class*="ellipsis"], [class*="truncate"]')]
      .map((n) => (n.textContent || "").trim())
      .filter(Boolean);
    const raw = cands.length ? cands[0] : (el.textContent || "");
    return dedupe(String(raw).trim().replace(/\s+/g, " ")).slice(0, 80);
  };
  // 非会话伪链接（/chat/cron-jobs、/chat/skills、/chat/drive/...）
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
    // 部分版本把 id 放在 data-* 上
    for (const attr of ["data-session-id", "data-conversation-id", "data-chat-id", "data-id"]) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) {
        const m = String(v).match(/([0-9A-Za-z_-]{8,})/);
        if (m) return m[1];
      }
    }
    return "";
  };
  // 1) 会话行（class / data-testid 两种标记）
  const rows = [
    ...document.querySelectorAll('[data-testid="conversation-list-v2-item"]'),
    ...document.querySelectorAll('[class*="conversation-item"]'),
  ];
  for (const row of rows) {
    if (!row.isConnected) continue;
    const r = row.getBoundingClientRect();
    if (r.height < 12 || r.height > 160) continue; // 排除整块容器
    const id = idOf(row);
    if (id) push(id, titleOf(row));
  }
  // 2) a[href] 兜底
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

# 会话侧栏滚动加载更多（虚拟列表只挂载可视区条目）：返回当前已挂载条目数。
# 通用实现：优先豆包 testid 条目，否则按站点链接规则找会话锚点
# （DeepSeek a[href*="/a/chat/s/"]、千问 data-session-switch-target 均可覆盖），
# 然后向上找滚动容器滚到底部。
_SCROLL_SIDEBAR_JS = r"""
() => {
  const SITE = window.__mrdCdp.SITE;
  let els = [...document.querySelectorAll('[data-testid="conversation-list-v2-item"]')];
  if (!els.length && SITE && SITE.id === "deepseek") {
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

# 豆包/千问删除流程的确认弹窗兜底：仅在弹窗/浮层容器内点「确定/确认/删除」
# （避免误点页面正文按钮）；找不到则返回空串，由调用方的消失校验给出明确报错。
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

# 千问发送按钮状态（aria-label="发送消息"；输入框为空/编辑器状态未同步时 disabled）
_QWEN_SEND_STATE_JS = r"""
() => {
  for (const b of document.querySelectorAll("button, [role='button']")) {
    const label = String(b.getAttribute("aria-label") || b.getAttribute("title") || "").trim();
    if (label === "发送消息" || label === "发送" || /^send$/i.test(label)) {
      const r = b.getBoundingClientRect();
      return {
        found: true,
        disabled: b.disabled === true || b.getAttribute("aria-disabled") === "true",
        visible: r.width > 0 && r.height > 0,
      };
    }
  }
  return { found: false };
}
"""
