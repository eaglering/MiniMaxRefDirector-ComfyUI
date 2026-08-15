// ============================================================
// MiniMax Ref Director - Transfer 窗体（Preact 内层组件）
//
// 架构约定：原生 JS Widget 外壳（TimelineEditor）+ Preact 内层。
// 本组件只负责 DOM UI 渲染与数据流，不接管 Widget 生命周期。
// 外壳通过 props.director 注入，双方通过 director._transferSetLeft
// 等字段通信（外壳无感知降级）。
//
// 功能：
//  1. 左 textarea（Segment Prompt，原始 prompt）+ 中间列（生成按钮）+ 右 textarea（Minimax H3 Prompt）
//  2. 两个 textarea 均可自由编辑
//  3. 中间列：→ 按钮垂直居中；按住中间列（按钮除外）左右拖动可调节两个 textarea 的宽度
//  4. 点击 →：以左侧为源请求 /llm/generate_prompt_json，
//     返回的 JSON 按展示规则格式化后写入右侧 textarea（替代默认 JSON）
//  5. 左侧输入 @、右侧输入 @ / # → 弹出主体选择器；
//     选择后转换：@主体 → <@主体>；#主体 → <#主体:[Chinese]对话内容>
//  6. 右侧内容 debounce 500ms 解析资源引用（首帧 / 尾帧 / 主体），
//     在下方横排展示资源预览条（不换行，x 轴滑动）
// ============================================================
import { h, render } from "../../vendor/preact.module.js";
import { useEffect, useRef, useState } from "../../vendor/hooks.module.js";
import htm from "../../vendor/htm.module.js";
import { api, app, clamp, viewUrl } from "./shared.js";

const html = htm.bind(h);

// ---------- 工具函数 ----------

function getSubjectsFromGraph() {
  try {
    const nodes = app.graph?._nodes || [];
    for (const n of nodes) {
      if (n.type !== "MiniMaxRefSubject") continue;
      for (const w of n.widgets || []) {
        if (!w.value || typeof w.value !== "string") continue;
        try {
          const parsed = JSON.parse(w.value);
          if (parsed && Array.isArray(parsed.subjects)) return parsed.subjects;
        } catch { /* 尝试下一个 widget */ }
      }
    }
  } catch (e) {
    console.warn("[Transfer] getSubjectsFromGraph failed:", e);
  }
  return [];
}

function subjectImgSrc(s) {
  if (s.imageB64) return s.imageB64;
  if (s.imageFile && api) {
    return viewUrl(s.imageFile, "minimaxrefdirector");
  }
  return "";
}

// 右侧 textarea 默认 JSON 数据结构（→ 生成结果会替代它）
const DEFAULT_PROMPT_JSON = {
  detailed_description: "",
  overall_soundscape: "",
  non_diegetic_music: "",
  shot1_description: "",
};

// 将 prompt JSON 按展示规则格式化为 textarea 文本
// 规则：
//   detailed_description:
//   [Shot 1]{shot1_description}
//   {detailed_description}
//   overall_soundscape:
//   {overall_soundscape}或者N/A
//   non_diegetic_music:
//   {non_diegetic_music}N/A
function formatPromptJson(data) {
  const d = data && typeof data === "object" ? data : {};
  const val = (v) => (v != null && String(v).trim() !== "" ? String(v) : "N/A");
  const plain = (v) => (v != null ? String(v) : "");
  return [
    "detailed_description:",
    "[Shot 1]" + plain(d.shot1_description),
    plain(d.detailed_description),
    "overall_soundscape:",
    val(d.overall_soundscape),
    "non_diegetic_music:",
    val(d.non_diegetic_music),
  ].join("\n");
}

// ---------- 样式 ----------
const S = {
  panel: {
    boxSizing: "border-box", width: "100%", height: "100%",
    display: "flex", flexDirection: "column", gap: "4px",
    fontFamily: "inherit",
  },
  row: { display: "flex", gap: "6px", flex: 1, minHeight: 0 },
  area: {
    flex: 1, resize: "none", boxSizing: "border-box", width: "100%", minHeight: 0,
    background: "#1e1e1e", color: "#ccc", border: "1px solid #444", borderRadius: "4px",
    padding: "6px", fontFamily: "monospace", fontSize: "12px", lineHeight: "1.5", outline: "none",
  },
  col: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  actions: {
    display: "flex", flexDirection: "column", justifyContent: "center",
    alignItems: "center", cursor: "col-resize", touchAction: "none",
    userSelect: "none", borderRadius: "4px", transition: "background 0.15s",
  },
  btn: {
    width: "36px", height: "36px", borderRadius: "6px", border: "1px solid #666",
    background: "#3a3a3a", color: "#ddd", fontSize: "16px", cursor: "pointer",
    userSelect: "none", lineHeight: "1",
  },
  btnDisabled: { opacity: 0.4, cursor: "not-allowed" },
  resources: {
    display: "flex", flexDirection: "row", flexWrap: "nowrap", overflowX: "auto",
    gap: "8px", padding: "4px 0", minHeight: "60px", borderTop: "1px solid #333",
    scrollbarWidth: "thin",
  },
  res: {
    flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "center", gap: "2px",
    background: "#2a2a2a", borderRadius: "6px", padding: "4px", width: "64px",
  },
  img: { width: "48px", height: "48px", objectFit: "cover", borderRadius: "4px", background: "#111" },
  label: {
    fontSize: "10px", color: "#aaa", maxWidth: "64px", overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  status: { fontSize: "11px", color: "#8bc34a", minHeight: "14px" },
  error: { fontSize: "11px", color: "#ef5350", minHeight: "14px" },
  hint: { color: "#666", fontSize: "11px", alignSelf: "center", whiteSpace: "nowrap", margin: "0 auto" },
  menu: {
    position: "fixed", zIndex: 99999, background: "#2d2d2d", border: "1px solid #666",
    borderRadius: "6px", maxHeight: "200px", overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,.5)",
    padding: "4px", minWidth: "170px",
  },
  menuItem: {
    display: "block", width: "100%", textAlign: "left", background: "transparent",
    border: "none", color: "#ddd", padding: "6px 10px", cursor: "pointer", borderRadius: "4px",
    fontSize: "12px",
  },
  audioIcon: { fontSize: "10px", color: "#ffb74d" },
};

// ---------- Preact 组件 ----------

export function TransferPanel({ director }) {
  const [leftText, setLeftText] = useState(() => director?.promptInput?.value || "");
  const [rightText, setRightText] = useState(() => formatPromptJson(DEFAULT_PROMPT_JSON));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [subjects, setSubjects] = useState([]);
  const [menu, setMenu] = useState(null); // { side, trigger, caret, x, y }
  const [resources, setResources] = useState([]);
  const [leftWidth, setLeftWidth] = useState(null); // 左侧宽度(px)，null 表示默认平分
  const [midHover, setMidHover] = useState(false);

  const rowRef = useRef(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const debounceRef = useRef(null);
  const aliveRef = useRef(true);

  // 挂载：读主体列表，向外壳注册左侧同步通道
  useEffect(() => {
    aliveRef.current = true;
    setSubjects(getSubjectsFromGraph());
    if (director) director._transferSetLeft = setLeftText;
    return () => {
      aliveRef.current = false;
      clearTimeout(debounceRef.current);
      if (director && director._transferSetLeft === setLeftText) {
        director._transferSetLeft = null;
      }
    };
  }, [director]);

  // 中间列拖拽：按住中间列（按钮除外）左右拖动调节两个 textarea 的宽度
  function startDrag(e) {
    if (e.target.closest && e.target.closest("button")) return; // 点击按钮不触发拖拽
    e.preventDefault();
    const row = rowRef.current;
    const left = leftRef.current;
    if (!row || !left) return;
    const startX = e.clientX;
    const startW = left.getBoundingClientRect().width; // 左列当前宽度
    const actionsW = e.currentTarget.getBoundingClientRect().width;
    const minW = 80; // 左右两列各保留的最小宽度
    const maxW = Math.max(minW + 1, row.getBoundingClientRect().width - actionsW - minW);
    const onMove = (ev) => {
      if (!aliveRef.current) return;
      setLeftWidth(clamp(startW + (ev.clientX - startX), minW, maxW));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // 点击外部关闭 mention 菜单
  useEffect(() => {
    if (!menu) return;
    const onDown = (e) => {
      if (e.target.closest && !e.target.closest(".tr-menu")) setMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [menu]);

  // 右侧内容 debounce 解析资源引用
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (!aliveRef.current) return;
      setResources(parseResources(rightText, subjects));
    }, 500);
    return () => clearTimeout(debounceRef.current);
  }, [rightText, subjects]);

  // ---------- 工具 ----------

  const wVal = (name) =>
    director?.node?.widgets?.find(w => w.name === name)?.value ??
    director?.node?.properties?.[name];

  const firstFramePath = () => {
    const segs = director?.timeline?.segments || [];
    if (!segs.length) return "";
    const first = [...segs].sort((a, b) => (a.start || 0) - (b.start || 0))[0];
    return first.imageFile || first.videoFile || "";
  };

  async function runGenerate(source) {
    if (!source || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        prompt: source,
        image_path: firstFramePath(),
        vlm_mode: wVal("vlm_mode") || "llama-cpp",
        seed: wVal("seed") ?? 42,
        gguf_path: wVal("gguf_path") || "",
        mmproj_path: wVal("mmproj_path") || "",
        provider: wVal("provider") || "GLM",
        api_key: wVal("api_key") || "",
      };
      const res = await api.fetchApi("/minimax_ref/api/llm/generate_prompt_json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      console.log("[Transfer] generate_prompt_json ->", data);
      if (data.success) {
        let obj = data.json_data;
        if (typeof obj === "string") {
          try { obj = JSON.parse(obj); } catch { /* 保留原始字符串 */ }
        }
        setRightText(
          obj && typeof obj === "object"
            ? formatPromptJson(obj)
            : typeof data.json_data === "string"
              ? data.json_data
              : JSON.stringify(data.json_data, null, 2)
        );
      } else {
        setError(data.error || "生成失败");
      }
    } catch (err) {
      console.error("[Transfer] generate failed:", err);
      setError(String(err?.message || err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  function openMenu(e, side) {
    const el = e.target;
    const caret = el.selectionStart;
    const before = el.value.slice(0, caret);
    const ch = before.slice(-1) || "";
    const allowed = side === "left" ? "@" : "@#";
    if (!ch || !allowed.includes(ch)) return;
    const rect = el.getBoundingClientRect();
    const lines = before.split("\n");
    const line = lines.length - 1;
    const col = lines[line].length;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
    const charW = 7.5;
    const x = Math.max(4, Math.min(rect.left + col * charW, window.innerWidth - 200));
    const y = rect.top + (line + 1) * lineHeight + 6;
    setMenu({ side, trigger: ch, caret, x, y });
  }

  function handleInput(e, side) {
    const el = e.target;
    const caret = el.selectionStart;
    const before = el.value.slice(0, caret);
    const ch = before.slice(-1) || "";
    const allowed = side === "left" ? "@" : "@#";
    if (ch && allowed.includes(ch)) {
      openMenu(e, side);
    } else if (menu && menu.side === side) {
      setMenu(null);
    }
    // 左侧与外壳 promptInput 双向同步（复用原有 commit 链路）
    if (side === "left" && director?.promptInput && director.promptInput.value !== el.value) {
      director.promptInput.value = el.value;
      director.promptInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function pickSubject(s) {
    if (!menu) return;
    const el = menu.side === "left" ? leftRef.current : rightRef.current;
    if (!el) return;
    const token = menu.trigger === "@" ? `<@${s.name}>` : `<#${s.name}:[Chinese]对话内容>`;
    const text = el.value;
    const newText = text.slice(0, menu.caret - 1) + token + text.slice(menu.caret);
    if (menu.side === "left") {
      setLeftText(newText);
      if (director?.promptInput && director.promptInput.value !== newText) {
        director.promptInput.value = newText;
        director.promptInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      setRightText(newText);
    }
    const pos = menu.caret - 1 + token.length;
    requestAnimationFrame(() => {
      if (!aliveRef.current) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
    setMenu(null);
  }

  function parseResources(text, subjectsList) {
    const out = [];
    const segs = director?.timeline?.segments || [];
    const sorted = [...segs].sort((a, b) => (a.start || 0) - (b.start || 0));
    const srcOf = (s) => s.imgObj?.src || s.imageB64 || "";
    const first = sorted.find(s => s.imgObj || s.imageB64);
    if (first) out.push({ key: "first", label: "首帧", src: srcOf(first) });
    const last = [...sorted].reverse().find(s => s.imgObj || s.imageB64);
    if (last && last !== first) out.push({ key: "last", label: "尾帧", src: srcOf(last) });
    const re = /<(?:@|#)([^>:]+)(?::[^>]*)?>/g;
    const used = new Set();
    let m;
    while ((m = re.exec(text))) used.add(m[1]);
    for (const name of used) {
      const s = subjectsList.find(x => x.name === name);
      if (s) {
        out.push({ key: "subj-" + name, label: name, src: subjectImgSrc(s), audio: s.audioFile, kind: "subject" });
      }
    }
    return out;
  }

  // ---------- 渲染 ----------

  return html`
    <div class="tr-panel" style=${S.panel}>
      <div ref=${rowRef} style=${S.row}>
        <div class="pr-prompt-wrapper" style=${leftWidth ? Object.assign({}, S.col, { flex: "0 0 auto", width: leftWidth + "px" }) : S.col}>
          <div class="pr-prompt-label">Segment Prompt</div>
          <textarea
            ref=${leftRef}
            class="pr-prompt-area"
            value=${leftText}
            placeholder="原始 prompt（输入 @ 引用主体）"
            spellcheck=${false}
            onInput=${(e) => { setLeftText(e.target.value); handleInput(e, "left"); }}
          ></textarea>
        </div>
        <div
          style=${Object.assign({}, S.actions)}
          title="拖动调节左右宽度"
          onPointerDown=${startDrag}
          onPointerEnter=${() => setMidHover(true)}
          onPointerLeave=${() => setMidHover(false)}
        >
          <button
            style=${Object.assign({}, S.btn, busy ? S.btnDisabled : null)}
            title="以左侧为源生成 H3 Prompt，结果展示在右侧"
            disabled=${busy}
            onClick=${() => runGenerate(leftText)}
          >→</button>
        </div>
        <div class="pr-prompt-wrapper" style=${S.col}>
          <div class="pr-prompt-label">Minimax H3 Prompt</div>
          <textarea
            ref=${rightRef}
            class="pr-prompt-area"
            value=${rightText}
            placeholder="生成结果（输入 @ 或 # 引用主体）"
            spellcheck=${false}
            onInput=${(e) => { setRightText(e.target.value); handleInput(e, "right"); }}
          ></textarea>
        </div>
      </div>

      ${
        busy
          ? html`<div style=${S.status}>生成中…</div>`
          : error
            ? html`<div style=${S.error}>${error}</div>`
            : html`<div style=${S.status}></div>`
      }

      <div class="tr-resources" style=${S.resources}>
        ${
          resources.length === 0
            ? html`<div style=${S.hint}>资源引用（首帧 / 尾帧 / 主体）会显示在这里</div>`
            : resources.map(r => html`
                <div style=${S.res} key=${r.key}>
                  ${r.kind === "subject" && r.audio ? html`<span style=${S.audioIcon}>♪ ${r.label}</span>` : null}
                  <img style=${S.img} src=${r.src} alt=${r.label} />
                  ${r.kind === "subject" && r.audio ? null : html`<span style=${S.label}>${r.label}</span>`}
                </div>
              `)
        }
      </div>

      ${
        menu
          ? html`
            <div class="tr-menu" style=${Object.assign({}, S.menu, { left: menu.x + "px", top: menu.y + "px" })}>
              ${
                subjects.length === 0
                  ? html`<div style=${{ padding: "6px 10px", color: "#888", fontSize: "12px" }}>没有可用主体（请先在主体节点中添加）</div>`
                  : subjects.map(s => html`
                      <button
                        style=${S.menuItem}
                        key=${s.name}
                        onMouseDown=${(e) => e.preventDefault()}
                        onClick=${() => pickSubject(s)}
                      >@ ${s.name}</button>
                    `)
              }
            </div>
          `
          : null
      }
    </div>
  `;
}

// ---------- 挂载辅助 ----------

export function mountTransfer(director, container) {
  return render(h(TransferPanel, { director }), container);
}
