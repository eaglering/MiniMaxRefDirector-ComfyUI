// ============================================================
// MiniMaxRefDirectorSPA — SPA 导演台入口节点前端
// - 节点体上挂「选择目标导演节点 + 打开导演台」按钮
// - 打开：收集目标 MiniMaxRefDirector widget 状态（含关联 Subject 节点）
//   → POST /minimax_ref/api/spa/push → 新标签页打开 js/spa/index.html
// - 回写：监听 send_sync("minimax_ref_spa_state")，把 SPA 保存的状态
//   写回目标节点 widget（双写 properties / onWidgetChanged / callback），
//   并同步刷新旧 timeline 编辑器视图（防回环标记 __spaExternalUpdate）
// ============================================================
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { parseInitial } from "./components/director/shared.js";

const NODE_NAME = "MiniMaxRefDirectorSPA";
const DIRECTOR_TYPE = "MiniMaxRefDirector";
const SUBJECT_TYPE = "MiniMaxRefSubject";

// SPA 保存状态里携带、需要写回导演节点的 widget 名单
const DIRECTOR_WIDGET_NAMES = [
  "outpu_resolution", "million_pixels", "display_mode", "frame_rate",
  "start_second", "end_second", "guide_strength",
  "inpaint_audio", "override_audio",
];

function directorNodes() {
  return (app.graph?._nodes || []).filter((n) => n?.type === DIRECTOR_TYPE);
}

function widgetValue(node, name) {
  const w = node?.widgets?.find((w) => w.name === name);
  return w ? w.value : undefined;
}

// 沿 config 输入连线找到上游 Subject 节点（支持多跳 Reroute 透传）
function findSubjectNode(directorNode) {
  try {
    const input = (directorNode.inputs || []).find((i) => i.name === "config");
    if (!input || input.link == null) return null;
    let linkId = input.link;
    for (let hops = 0; hops < 10 && linkId != null; hops++) {
      const link = app.graph.links[linkId];
      if (!link) return null;
      const src = app.graph._nodes_in_order?.find((n) => n.id === link.origin_id)
        || app.graph._nodes.find((n) => n.id === link.origin_id);
      if (!src) return null;
      if (src.type === SUBJECT_TYPE) return src;
      // Reroute 透传（兼容 rgthree 等变体命名）：向上继续找
      if (/reroute/i.test(src.type || "")) {
        const upInput = (src.inputs || [])[0];
        linkId = upInput && upInput.link != null ? upInput.link : null;
        continue;
      }
      return null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// 收集打开 SPA 时推送的完整状态
// Subject 节点缺失或其 subject_data 为空/损坏时，回退读取磁盘上次的 SPA
// 暂存状态（/spa/state），避免把空主体推给页面、随后一次保存覆盖掉真实主体。
async function collectState(directorNode) {
  const subjectNode = findSubjectNode(directorNode);
  const widgets = {};
  for (const name of DIRECTOR_WIDGET_NAMES) {
    const v = widgetValue(directorNode, name);
    if (v !== undefined) widgets[name] = v;
  }
  const llm = { mode: "llama-cpp" };
  if (subjectNode) {
    const vlm = widgetValue(subjectNode, "vlm_mode");
    if (vlm && typeof vlm === "object") {
      llm.mode = String(vlm.vlm_mode || "llama-cpp");
      llm.gguf_path = String(vlm.gguf_name || "");
      llm.mmproj_path = String(vlm.mmproj_path || "");
      llm.provider = String(vlm.provider || "");
      llm.api_key = String(vlm.api_key || "");
      llm.ollama_model = String(vlm.ollama_model || "");
      llm.ollama_base_url = String(vlm.ollama_base_url || "");
    } else if (typeof vlm === "string" && vlm) {
      llm.mode = vlm;
    }
    for (const k of ["gguf_name", "mmproj_path", "provider", "api_key", "ollama_model", "ollama_base_url"]) {
      const v = widgetValue(subjectNode, k);
      if (v !== undefined && v !== "") {
        if (k === "gguf_name") llm.gguf_path = String(v);
        else llm[k] = String(v);
      }
    }
  }
  let subjects = { subjects: [] };
  let global_prompt = "";
  let subjectsFromWidget = false;
  if (subjectNode) {
    const raw = widgetValue(subjectNode, "subject_data");
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.subjects)) {
        subjects = parsed;
        subjectsFromWidget = parsed.subjects.length > 0;
      }
    } catch (e) {
      console.warn("[SPA] subject_data parse failed, will fallback to saved state", e);
    }
    global_prompt = String(widgetValue(subjectNode, "global_prompt") || "");
  }
  let subjectsFallback = false;
  if (!subjectsFromWidget) {
    try {
      const resp = await api.fetchApi(
        `/minimax_ref/api/spa/state?node_id=${encodeURIComponent(String(directorNode.id))}`);
      if (resp.ok) {
        const d = await resp.json();
        const prev = d?.success ? (d.state || {}) : {};
        if (Array.isArray(prev.subjects?.subjects) && prev.subjects.subjects.length) {
          subjects = prev.subjects;
          subjectsFallback = true;
          console.warn("[SPA] subject node data empty, restored subjects from saved state");
        }
      }
    } catch (e) { /* 磁盘状态不可用时保持空 */ }
  }
  return {
    node_id: String(directorNode.id),
    node_title: directorNode.title || DIRECTOR_TYPE,
    timeline_data: String(widgetValue(directorNode, "timeline_data") || "{}"),
    widgets,
    global_prompt,
    subjects,
    subjects_fallback: subjectsFallback,
    subject_node_id: subjectNode ? String(subjectNode.id) : "",
    llm,
    updated_at: Date.now(),
  };
}

// 与 editing.js updateWidgetValue 同语义的回写
function updateWidgetValue(node, w, val) {
  if (!w) return;
  const oldVal = w.value;
  w.value = val;
  if (node?.properties) node.properties[w.name] = val;
  try { node?.onWidgetChanged?.(w.name, val, oldVal, w); } catch (e) { /* ignore */ }
  try { w.callback?.(val); } catch (e) { /* ignore */ }
}

// SPA 保存状态 → 写回目标节点
function applyStateToNodes(state) {
  const directorNode = directorNodes().find((n) => String(n.id) === String(state.node_id));
  if (!directorNode) {
    console.warn("[SPA] director node not found for write-back:", state.node_id);
    return false;
  }
  // 防回环：期间跳过可能触发的反向保存
  directorNode.__spaExternalUpdate = true;
  setTimeout(() => { delete directorNode.__spaExternalUpdate; }, 0);

  const timelineJson = typeof state.timeline_data === "string"
    ? state.timeline_data : JSON.stringify(state.timeline_data || {});

  // 1) timeline_data widget
  updateWidgetValue(directorNode, directorNode.widgets?.find((w) => w.name === "timeline_data"), timelineJson);

  // 2) 全局参数 widgets
  if (state.widgets && typeof state.widgets === "object") {
    for (const [name, val] of Object.entries(state.widgets)) {
      const w = directorNode.widgets?.find((w) => w.name === name);
      if (w) updateWidgetValue(directorNode, w, val);
    }
  }

  // 3) 刷新旧 timeline 编辑器视图（原地替换 timeline 数据 + 重绘）
  const ed = directorNode._timelineEditor;
  if (ed && ed.timeline) {
    try {
      const parsed = parseInitial(timelineJson);
      for (const k of Object.keys(ed.timeline)) delete ed.timeline[k];
      Object.assign(ed.timeline, parsed);
      ed.mainTrackEnabled = parsed.mainTrackEnabled !== false;
      ed.audioTrackEnabled = parsed.audioTrackEnabled !== false;
      ed.render?.();
    } catch (e) {
      console.warn("[SPA] refresh timeline editor failed", e);
    }
  }
  directorNode.setDirtyCanvas?.(true, true);

  // 4) Subject 节点：subject_data / global_prompt / vlm opts
  const subjectNode = state.subject_node_id
    ? (app.graph._nodes || []).find((n) => String(n.id) === String(state.subject_node_id) && n.type === SUBJECT_TYPE)
    : findSubjectNode(directorNode);
  if (subjectNode && state.subjects) {
    // 防覆盖：主体数据来自磁盘暂存回退（subjects_fallback）且为空时，
    // 不回写 subject_data，避免把 widget 里的真实主体清掉
    const emptyFallback = state.subjects_fallback && !(state.subjects.subjects || []).length;
    if (!emptyFallback) {
      updateWidgetValue(subjectNode, subjectNode.widgets?.find((w) => w.name === "subject_data"),
        JSON.stringify(state.subjects));
    }
    if (typeof state.global_prompt === "string") {
      updateWidgetValue(subjectNode, subjectNode.widgets?.find((w) => w.name === "global_prompt"),
        state.global_prompt);
    }
    // vlm 设置回写（DynamicCombo dict widget）
    if (state.llm && typeof state.llm === "object") {
      const vlmWidget = subjectNode.widgets?.find((w) => w.name === "vlm_mode");
      if (vlmWidget) {
        try {
          const cur = (vlmWidget.value && typeof vlmWidget.value === "object") ? { ...vlmWidget.value } : { vlm_mode: "llama-cpp" };
          cur.vlm_mode = state.llm.mode || cur.vlm_mode;
          if (state.llm.gguf_path) cur.gguf_name = state.llm.gguf_path;
          if (state.llm.mmproj_path) cur.mmproj_path = state.llm.mmproj_path;
          if (state.llm.provider) cur.provider = state.llm.provider;
          if (state.llm.api_key) cur.api_key = state.llm.api_key;
          if (state.llm.ollama_model) cur.ollama_model = state.llm.ollama_model;
          if (state.llm.ollama_base_url) cur.ollama_base_url = state.llm.ollama_base_url;
          updateWidgetValue(subjectNode, vlmWidget, cur);
        } catch (e) { /* ignore */ }
      }
    }
    // 主体面板刷新
    try { subjectNode._reloadMiniMaxSubjects?.(); } catch (e) { /* ignore */ }
  }
  return true;
}

// 开发模式：填 vite dev server 地址（如 "http://127.0.0.1:5173/"）后，
// 点「打开导演台」会直接打开 dev 页面（携带真实 node_id，前端改动热更新）。
// 留空 = 使用随 ComfyUI 提供的构建产物 js/spa/index.html。
const SPA_DEV_ORIGIN = "";

function spaPageUrl() {
  if (SPA_DEV_ORIGIN) return new URL(SPA_DEV_ORIGIN).href;
  // js/spa-node.js 位于 /extensions/<pkg>/ 下 → ./spa/index.html
  return new URL("./spa/index.html", import.meta.url).href;
}

function apiBase() {
  try {
    const u = api.apiURL("/");
    return new URL(u, location.href).pathname.replace(/\/?$/, "/");
  } catch (e) {
    return "/";
  }
}

function addSpaLauncher(node) {
  const wrapper = document.createElement("div");
  wrapper.className = "mrd-spa-launcher";
  const style = document.createElement("style");
  style.textContent = `
.mrd-spa-launcher{display:flex;flex-direction:column;gap:8px;padding:10px 12px;background:#151821;border:1px solid #2a3042;border-radius:8px;font-size:12px;color:#a9b1c3;width:100%;box-sizing:border-box}
.mrd-spa-launcher .mrd-spa-row{display:flex;align-items:center;gap:8px}
.mrd-spa-launcher select{flex:1;background:#1c202b;color:#edeff5;border:1px solid #2a3042;border-radius:4px;padding:4px 8px;font-size:12px;outline:none}
.mrd-spa-launcher button{background:linear-gradient(135deg,#6c5ce7,#4d6bfe);color:#fff;border:none;border-radius:6px;padding:7px 16px;font-size:12.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;transition:filter .15s ease,transform .1s ease}
.mrd-spa-launcher button:hover:not(:disabled){filter:brightness(1.15)}
.mrd-spa-launcher button:active:not(:disabled){transform:translateY(1px)}
.mrd-spa-launcher button:disabled{opacity:.45;cursor:not-allowed}
.mrd-spa-launcher .mrd-spa-status{font-size:11px;color:#6b7488;min-height:14px}
.mrd-spa-launcher .mrd-spa-status.ok{color:#22c55e}
.mrd-spa-launcher .mrd-spa-status.err{color:#ef4444}
.mrd-spa-launcher .mrd-spa-title{font-weight:700;color:#edeff5;display:flex;align-items:center;gap:6px;letter-spacing:.5px}
`;
  document.head.appendChild(style);

  const title = document.createElement("div");
  title.className = "mrd-spa-title";
  title.textContent = "MiniMax 导演台（SPA）";

  const row = document.createElement("div");
  row.className = "mrd-spa-row";

  const select = document.createElement("select");
  select.title = "选择要编辑的 MiniMax 超级导演节点";

  const btn = document.createElement("button");
  btn.textContent = "打开导演台";

  const status = document.createElement("div");
  status.className = "mrd-spa-status";

  row.appendChild(select);
  row.appendChild(btn);
  wrapper.appendChild(title);
  wrapper.appendChild(row);
  wrapper.appendChild(status);

  function setStatus(text, cls = "") {
    status.textContent = text;
    status.className = "mrd-spa-status" + (cls ? " " + cls : "");
  }

  function rescan() {
    const nodes = directorNodes();
    const prev = select.value;
    select.innerHTML = "";
    if (nodes.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "（图中没有 MiniMax 超级导演节点）";
      select.appendChild(opt);
      btn.disabled = true;
      return;
    }
    for (const n of nodes) {
      const opt = document.createElement("option");
      opt.value = String(n.id);
      opt.textContent = `#${n.id} ${n.title || "MiniMax 超级导演"}`;
      select.appendChild(opt);
    }
    // 自动选中：唯一节点 / 之前的选择
    if (nodes.length === 1) select.value = String(nodes[0].id);
    else if (prev && nodes.some((n) => String(n.id) === prev)) select.value = prev;
    btn.disabled = false;
  }

  // 图结构变化（节点删除/添加）时重新扫描
  const origOnRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    try { api.removeEventListener("minimax_ref_spa_state", onSpaState); } catch (e) { /* ignore */ }
    return origOnRemoved?.apply(this, args);
  };
  const origGraphChange = app.graph?.change;
  // 轻轮询兜底：打开时重新校验目标存在
  select.addEventListener("focus", rescan);

  async function open() {
    rescan();
    const nodeId = select.value;
    if (!nodeId) {
      setStatus("请先选择目标导演节点", "err");
      return;
    }
    const target = directorNodes().find((n) => String(n.id) === nodeId);
    if (!target) {
      setStatus("目标节点不存在（可能已被删除）", "err");
      rescan();
      return;
    }
    btn.disabled = true;
    setStatus("正在推送节点数据…");
    try {
      const state = await collectState(target);
      if (state.subjects_fallback) {
        setStatus("未读到 Subject 节点数据，已用上次暂存的主体数据", "err");
      }
      const resp = await api.fetchApi("/minimax_ref/api/spa/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: state.node_id, state }),
      });
      if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "推送失败");
      const url = `${spaPageUrl()}?node_id=${encodeURIComponent(state.node_id)}&api_base=${encodeURIComponent(apiBase())}`;
      window.open(url, "_blank");
      setStatus(`已打开导演台（节点 #${state.node_id}）`, "ok");
    } catch (e) {
      console.error("[SPA] open failed", e);
      setStatus(`打开失败：${e.message || e}`, "err");
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    open();
  });

  // 接收 SPA 保存通知（send_sync），回写目标节点
  function onSpaState(evt) {
    const detail = evt?.detail || {};
    const state = detail.state || detail;
    if (!state || !state.node_id) return;
    const ok = applyStateToNodes(state);
    const time = new Date().toLocaleTimeString();
    setStatus(ok ? `已同步 SPA 保存（${time}）` : `回写失败：找不到节点 #${state.node_id}`, ok ? "ok" : "err");
  }
  if (api && typeof api.addEventListener === "function") {
    api.addEventListener("minimax_ref_spa_state", onSpaState);
  }

  rescan();
  setStatus("选择目标节点后点击「打开导演台」");

  const widget = node.addDOMWidget("spa_launcher", "spa_launcher", wrapper, {
    getValue: () => "",
    setValue: () => { },
    hideOnZoom: false,
  });
  widget.label = "";
  widget.serialize = false;
  return widget;
}

app.registerExtension({
  name: "MiniMaxRefDirectorSPA",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== NODE_NAME) return;
    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const r = orig ? orig.apply(this, args) : undefined;
      setTimeout(() => {
        try {
          addSpaLauncher(this);
          this.size = [340, this.size?.[1] || 140];
        } catch (err) {
          console.error("[SPA] launcher init failed:", err);
        }
      }, 0);
      return r;
    };
  },
});
