// MiniMax Ref Director — DeepSeek 页面钩子（MAIN world，document_start）
//
// 目的：不依赖易变的 DOM 类名来判定「回复是否生成完毕」。
// 在页面上下文 hook fetch / XHR，捕获 /api/v0/chat/completion 的 SSE 流，
// 累积 response/content 片段，经 window.postMessage 交给隔离世界的 content.js：
//   { __mrd_ds: 1, type: "stream_start" }
//   { __mrd_ds: 1, type: "stream_progress", length }
//   { __mrd_ds: 1, type: "stream_done", text }
// 注意：只做读取（clone 响应），不改动页面请求与响应。

(() => {
  if (window.__mrdDsHook) return;
  window.__mrdDsHook = true;

  const MAX_TEXT = 200_000;

  // ---- 站点适配（host → SSE 端点匹配 + 行解析器）----
  // DeepSeek：/api/v0/chat/completion，response/status=FINISHED 结束。
  // 豆包：samantha/chat/completion SSE。千问（通义）：/dialog/conversation SSE。
  // 豆包/千问的字段结构无公开稳定契约，使用通用提取器（递归收集 content/text
  // 字符串），配合 content.js 的 DOM 回复块兜底与 SW 的稳定性判定。
  const HOST = location.hostname;
  const SITES = HOST.indexOf("doubao.com") >= 0
    ? { id: "doubao", match: (u) => u.indexOf("samantha/chat") >= 0, parse: parseGenericLine }
    : (HOST.indexOf("qianwen.com") >= 0 || HOST.indexOf("tongyi.aliyun.com") >= 0 || HOST.indexOf("qwen.ai") >= 0)
      ? { id: "qwen", match: (u) => u.indexOf("/dialog/conversation") >= 0 || u.indexOf("/conversation") >= 0, parse: parseGenericLine }
      : { id: "deepseek", match: (u) => u.indexOf("/api/v0/chat/completion") >= 0, parse: parseDeepseekLine };

  function post(msg) {
    try {
      window.postMessage(Object.assign({ __mrd_ds: 1 }, msg), "*");
    } catch {
      // 忽略
    }
  }

  // 握手：content（隔离世界）通过 postMessage 探测本钩子是否已注入
  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (d && d.__mrd_ds_ping === 1) post({ type: "hook_pong" });
  });

  // 解析一行 SSE：只累积正文（response/content），忽略思考过程。
  // 注意 DeepSeek 的思考片段路径可能是 thinking_content / reasoning_content /
  // thought 等，其中 reasoning_content 也含 "content"，只过滤 "thinking" 会把
  // 英文思考过程当成正文（实测抓到 "need answer JSON only. Need design..."）。
  const REASONING_RE = /think|reason|thought|cot|reflect/i;

  function isReasoningPath(p) {
    return typeof p === "string" && REASONING_RE.test(p);
  }

  function appendText(state, s) {
    if (!s) return;
    if (state.text.length < MAX_TEXT) {
      state.text += s;
      state.touched = true;
    }
  }

  // 分片数组（部分版本把一次增量拆成 fragments）：只取 THINK/REASONING 之外的内容
  function readFragments(state, arr) {
    for (const f of arr) {
      if (!f || typeof f !== "object") continue;
      const type = String(f.type || f.kind || "").toUpperCase();
      if (type.indexOf("THINK") >= 0 || type.indexOf("REASON") >= 0) continue;
      if (isReasoningPath(f.p || f.path)) continue;
      if (typeof f.content === "string") appendText(state, f.content);
      else if (typeof f.text === "string") appendText(state, f.text);
    }
  }

  // DeepSeek 行解析（站点私有字段结构：p/v 增量路径 + response/status 状态行）
  function parseDeepseekLine(line, state) {
    if (!line || line.charCodeAt(0) === 58 /* ':' */) return;
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;

    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    if (!obj) return;

    // 状态行：response/status = FINISHED 表示生成结束
    if (obj.p === "response/status") {
      const st = String(obj.v || "");
      if (st === "FINISHED" || st === "COMPLETED") state.finished = true;
      return;
    }
    // 思考过程（以及标题 / 搜索等旁路）一律丢弃
    if (isReasoningPath(obj.p)) return;
    if (typeof obj.p === "string" && (obj.p.indexOf("title") >= 0 || obj.p.indexOf("search") >= 0)) return;

    if (typeof obj.v === "string") {
      if (!obj.p || obj.p.indexOf("content") >= 0) appendText(state, obj.v);
      return;
    }
    if (Array.isArray(obj.v)) {
      readFragments(state, obj.v);
      return;
    }
    const r = obj.v && obj.v.response;
    if (r && typeof r.content === "string") appendText(state, r.content);
  }

  // 通用行解析（豆包/千问等无稳定公开契约的站点）：递归收集 data JSON 里
  // content/text 字符串；跳过键名带 think/reason 的对象（思考过程）；遇
  // [DONE] / 常见结束标志置 finished。
  const REASONING_KEY_RE = /think|reason|thought|cot/i;

  function walkExtract(node, out, depth) {
    if (depth > 12 || out.length > 2000) return;
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const x of node) walkExtract(x, out, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (REASONING_KEY_RE.test(k)) continue;
      if ((k === "content" || k === "text") && typeof v === "string") out.push(v);
      else walkExtract(v, out, depth + 1);
    }
  }

  function parseGenericLine(line, state) {
    if (!line || line.charCodeAt(0) === 58) return;
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") {
      if (raw === "[DONE]") state.finished = true;
      return;
    }
    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    if (!obj) return;
    const st = String(obj.finish_reason || obj.status || obj.event || "").toLowerCase();
    if (st === "finished" || st === "done" || st === "complete" || st === "stop") state.finished = true;
    if (obj.is_finish === true || obj.finished === true) state.finished = true;
    const out = [];
    walkExtract(obj, out, 0);
    for (const s of out) appendText(state, s);
  }

  // 行解析分发（按站点配置）
  function parseLine(line, state) {
    SITES.parse(line, state);
  }

  function readStream(resp) {
    const state = { text: "", touched: false, finished: false };
    let lastPostedLen = 0;
    post({ type: "stream_start" });
    (async () => {
      try {
        if (!resp.body || !resp.body.getReader) return;
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            parseLine(line, state);
          }
          if (state.touched && state.text.length !== lastPostedLen) {
            lastPostedLen = state.text.length;
            post({ type: "stream_progress", length: lastPostedLen });
          }
        }
        if (buf) parseLine(buf, state);
      } catch {
        // 读取中断（用户停止生成等），按已有内容返回
      } finally {
        post({ type: "stream_done", text: state.text });
      }
    })();
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function patchedFetch(...args) {
      const p = origFetch.apply(this, args);
      try {
        const a0 = args[0];
        const url = typeof a0 === "string" ? a0 : (a0 && a0.url) || "";
        if (SITES.match(url)) {
          p.then((resp) => {
            try {
              readStream(resp.clone());
            } catch {
              // clone 失败（流已被消费），忽略
            }
          }).catch(() => {});
        }
      } catch {
        // 忽略
      }
      return p;
    };
  }

  // ---- XHR 兜底 ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    try {
      this.__mrdUrl = String(url || "");
    } catch {
      // 忽略
    }
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    try {
      if (SITES.match(this.__mrdUrl || "")) {
        post({ type: "stream_start" });
        this.addEventListener("load", () => {
          try {
            const text = String(this.responseText || "");
            const state = { text: "", touched: false, finished: false };
            for (const line of text.split("\n")) parseLine(line.replace(/\r$/, ""), state);
            post({ type: "stream_done", text: state.text });
          } catch {
            post({ type: "stream_done", text: "" });
          }
        });
        this.addEventListener("error", () => post({ type: "stream_done", text: "" }));
      }
    } catch {
      // 忽略
    }
    return origSend.apply(this, args);
  };
})();
