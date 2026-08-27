// ============================================================
// HighlightedTextarea - overlay 镜像层关键词高亮 textarea
//
// 方案：透明字符 textarea（color: transparent + caret-color 可见）
// 叠加在底层 <pre> 高亮层之上。二者 font / line-height / padding /
// white-space 完全一致并滚动同步，从而实现输入区关键词高亮。
//
// 受控组件注意：程序写回 value 不触发 input 事件，因此本组件在
// value 变化时通过 useEffect 统一刷新高亮层（天然覆盖程序写回）。
//
// 高亮规则：
//   <@主体>          主体引用（蓝）
//   <#主体:对白>     主体 + 对白引用（绿）
//   <d>...</d>       对白标记（黄）
// ============================================================
import { h } from "../../vendor/preact.module.js";
import { useEffect, useRef } from "../../vendor/hooks.module.js";
import htm from "../../vendor/htm.module.js";

const html = htm.bind(h);

// ---------- 幂等注入高亮样式 ----------
if (!document.getElementById("ref-hl-styles")) {
  const st = document.createElement("style");
  st.id = "ref-hl-styles";
  st.textContent = `
.ref-hl-wrap {
    position: relative;
    display: flex;
    min-height: 0;
    min-width: 0;
}
.ref-hl-pre {
    position: absolute;
    inset: 0;
    margin: 0;
    pointer-events: none;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: break-word;
    overflow: hidden;
    z-index: 1;
    font-family: "ui-monoscope, inherit";
}
.ref-hl-ta {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: transparent !important;
    color: transparent !important;
    caret-color: #e0e0e0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: break-word;
    z-index: 2;
    font-family: "ui-monospace, inherit";
}
.ref-hl-ta::selection {
    background: rgba(79, 195, 247, 0.25);
}
.ref-hl-ta::placeholder {
    color: #8a8a8a;
    opacity: 1;
}
.ref-hl {
    border-radius: 2px;
}
.ref-hl-at {
    color: #4fc3f7;
    background: rgba(79, 195, 247, 0.14);
}
.ref-hl-hash {
    color: #a5d6a7;
    background: rgba(165, 214, 167, 0.13);
}
.ref-hl-d {
    color: #ffd54f;
    background: rgba(255, 213, 79, 0.13);
}
`;
  document.head.appendChild(st);
}

// ---------- 工具 ----------

// 高亮正则：<@...> / <#...> / <d>...</d>（<d> 内容可跨行）
const HL_RE = /(<@[^>]*>|<#[^>]*>|<d>[\s\S]*?<\/d>)/g;

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 将原始文本渲染为带高亮 span 的 HTML
function highlightHtml(text) {
  if (!text) return "";
  let out = "";
  let last = 0;
  HL_RE.lastIndex = 0;
  let m;
  while ((m = HL_RE.exec(text))) {
    out += escHtml(text.slice(last, m.index));
    const tok = m[0];
    const cls = tok.startsWith("<@") ? "ref-hl-at"
      : tok.startsWith("<#") ? "ref-hl-hash"
      : "ref-hl-d";
    out += `<span class="ref-hl ${cls}">${escHtml(tok)}</span>`;
    last = HL_RE.lastIndex;
  }
  out += escHtml(text.slice(last));
  return out;
}

// 解析 padding 简写 → { top, right, bottom, left }（数值 px）
function parsePadding(p) {
  if (!p) return { top: 0, right: 0, bottom: 0, left: 0 };
  const parts = String(p).trim().split(/\s+/).map((s) => parseFloat(s) || 0);
  if (parts.length === 1) return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
  if (parts.length === 2) return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
  if (parts.length === 3) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
  return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
}

// 滚动条占位宽度（仅测量一次；overlay 滚动条环境下为 0）
let _sbw = null;
function scrollbarWidth() {
  if (_sbw !== null) return _sbw;
  const d = document.createElement("div");
  d.style.cssText = "width:100px;height:100px;overflow:scroll;position:absolute;visibility:hidden;top:-9999px";
  document.body.appendChild(d);
  _sbw = d.offsetWidth - d.clientWidth;
  document.body.removeChild(d);
  return _sbw;
}

// 需同步到 pre 层的"外观"样式键（保证与 textarea 像素级对齐）
const APPEAR_KEYS = new Set([
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
  "letterSpacing", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "border", "borderTop", "borderRight", "borderBottom", "borderLeft",
  "borderWidth", "borderStyle", "borderColor", "borderRadius",
  "boxSizing", "color", "textIndent", "wordSpacing", "tabSize",
]);

// 由 wrapper 承接的布局样式键（替代原 textarea 参与 flex 布局）
const LAYOUT_KEYS = new Set([
  "flex", "flexGrow", "flexShrink", "flexBasis", "alignSelf", "order",
  "minHeight", "height", "width", "minWidth", "maxWidth", "maxHeight",
  "position", "top", "right", "bottom", "left", "margin", "zIndex",
]);

// ---------- 组件 ----------
export function HighlightedTextarea(props) {
  const {
    taRef,
    value = "",
    onInput,
    style = {},
    className = "",
    placeholder,
    spellcheck,
    readOnly,
  } = props;
  const preRef = useRef(null);

  // 拆分样式：布局属性归 wrapper，外观属性 textarea/pre 共用
  const layout = {};
  const appear = {};
  for (const [k, v] of Object.entries(style)) {
    if (LAYOUT_KEYS.has(k)) layout[k] = v;
    else appear[k] = v;
  }
  const baseColor = appear.color || "#e0e0e0";

  // 受控写回（程序 setValue 不触发 input）→ value 变化时统一刷新高亮层
  useEffect(() => {
    if (preRef.current) preRef.current.innerHTML = highlightHtml(value);
  }, [value]);

  // 滚动同步：textarea 滚动 → pre 跟随
  const syncScroll = (e) => {
    if (preRef.current) {
      preRef.current.scrollTop = e.target.scrollTop;
      preRef.current.scrollLeft = e.target.scrollLeft;
    }
  };

  // pre 层右侧补偿滚动条占位，使内容区宽与 textarea（scrollbar-gutter）一致
  const pad = parsePadding(appear.padding);
  const prePadRight = `${(pad.right || 0) + scrollbarWidth()}px`;

  return html`
    <div class="ref-hl-wrap" style=${{ ...layout, position: "relative" }}>
      <pre
        ref=${preRef}
        class="ref-hl-pre"
        style=${{ ...appear, color: baseColor, paddingRight: prePadRight, overflow: "hidden" }}
      ></pre>
      <textarea
        ref=${(el) => { if (taRef) taRef.current = el; }}
        class="${className ? className + " " : ""}ref-hl-ta"
        style=${{ ...appear, minHeight: "0" }}
        value=${value}
        placeholder=${placeholder}
        spellcheck=${spellcheck}
        readOnly=${readOnly}
        onInput=${onInput}
        onScroll=${syncScroll}
      ></textarea>
    </div>
  `;
}

// ---------- 纯 DOM 工厂（供非 Preact 调用方使用，如 subject.js）----------
// 返回 { wrap, ta, refresh }：
//   wrap   overlay 容器（替代原 textarea 参与布局）
//   ta     真实透明 textarea（value / selectionStart / 事件绑定点保持原样）
//   refresh()  手动刷新高亮层（程序直接写 ta.value 后调用，如 acceptMention）
// 注意：resize 交给 wrapper 承担（ta 强制 resize:none），避免 absolute 布局错位。
export function createHighlightedTextarea(opts = {}) {
  const {
    className = "",
    style = {},
    value = "",
    placeholder = "",
    spellcheck = false,
    readOnly = false,
  } = opts;

  // 拆分样式：布局 / resize / 背景归 wrapper，外观归 ta/pre 共用
  const BG_KEYS = new Set([
    "background", "backgroundColor", "backgroundImage", "backgroundSize",
    "backgroundRepeat", "backgroundPosition", "backgroundClip",
  ]);
  const layout = {};
  const appear = {};
  for (const [k, v] of Object.entries(style)) {
    if (LAYOUT_KEYS.has(k) || k === "resize" || BG_KEYS.has(k)) layout[k] = v;
    else appear[k] = v;
  }

  const wrap = document.createElement("div");
  wrap.className = "ref-hl-wrap";
  Object.assign(wrap.style, layout, { position: "relative" });

  const pre = document.createElement("pre");
  pre.className = "ref-hl-pre";

  const ta = document.createElement("textarea");
  ta.className = (className ? className + " " : "") + "ref-hl-ta";
  ta.spellcheck = spellcheck;
  ta.readOnly = readOnly;
  ta.placeholder = placeholder;
  ta.style.resize = "none"; // 拉伸交给 wrapper，避免 absolute 布局下 ta/pre 错位

  // pre 层右侧补偿滚动条占位，使内容区宽与 textarea（scrollbar-gutter）一致
  const pad = parsePadding(appear.padding);
  const prePadRight = `${(pad.right || 0) + scrollbarWidth()}px`;

  const baseColor = appear.color || "#e0e0e0";
  Object.assign(ta.style, appear, { minHeight: "0" });
  Object.assign(pre.style, appear, { color: baseColor, paddingRight: prePadRight, overflow: "hidden" });

  const refresh = () => { pre.innerHTML = highlightHtml(ta.value); };
  ta.addEventListener("input", refresh);
  ta.addEventListener("scroll", () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });

  ta.value = value;
  refresh();

  wrap.appendChild(pre);
  wrap.appendChild(ta);

  return { wrap, ta, refresh };
}
