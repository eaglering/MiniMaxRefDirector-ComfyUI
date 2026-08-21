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
//     在下方横排展示资源预览条（不换行，x 轴滑动）；
//     主体展示最前方为 additionSubject 添加框（手动添加未提及的主体，写入 timeline_data）
// ============================================================
import { h, render } from "../../vendor/preact.module.js";
import { useEffect, useRef, useState } from "../../vendor/hooks.module.js";
import htm from "../../vendor/htm.module.js";
import { api, app, viewUrl, ICONS } from "./shared.js";
import { RefModal } from "./modal.js";

const html = htm.bind(h);

// mention 选择器样式：与 subject.js 的 @mention 弹层保持一致（幂等注入）
if (!document.getElementById("ref-ms-mention-styles")) {
  const st = document.createElement("style");
  st.id = "ref-ms-mention-styles";
  st.textContent = `
.ref-ms-mention-popup {
    position: fixed;
    z-index: 100000;
    min-width: 170px;
    max-width: 280px;
    max-height: 190px;
    overflow-y: auto;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
    padding: 4px;
    box-sizing: border-box;
}
.ref-ms-mention-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    color: #e0e0e0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.ref-ms-mention-item:hover,
.ref-ms-mention-item.active {
    background: #333;
}
.ref-ms-mention-item img,
.ref-ms-mention-item video {
    display: block;
}
.ref-ms-mention-type {
    font-size: 9px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex: 0 0 auto;
    border: 1px solid #444;
    border-radius: 3px;
    padding: 1px 4px;
}
.ref-ms-mention-empty {
    font-size: 11px;
    color: #777;
    padding: 6px 8px;
    white-space: nowrap;
}
`;
  document.head.appendChild(st);
}

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

// 优先读取 subject.js 实时发布的全局缓存（window.__refSubjects，随每次保存更新，
// 新增/改名/删主体后立即可用），无缓存时兜底从 graph widget 解析。
function getSubjectsLatest() {
  try {
    const cached = window.__refSubjects;
    if (Array.isArray(cached) && cached.length) return cached;
  } catch (e) {
    console.warn("[Transfer] getSubjectsLatest failed:", e);
  }
  return getSubjectsFromGraph();
}

function getSubjectVlmSettings() {
  // 从 graph 中的 MiniMaxRefSubject 节点读取 vlm_mode / gguf_name / mmproj_path /
  // provider / api_key widget 值（director 节点自身无这些 widget，配置在 subject 上）
  // vlm_mode 是 DynamicCombo，ComfyUI 前端有三种形态，这里全部兼容：
  //   1) 主 widget 值为对象 {vlm_mode, gguf_name, ...}（后端合并格式）
  //   2) 主 widget 值为字符串 + 子 widget 名带前缀 vlm_mode.gguf_name（LiteGraph 新格式）
  //   3) 主 widget 值为字符串 + 子 widget 裸名 gguf_name（旧格式）
  try {
    const nodes = app.graph?._nodes || [];
    for (const n of nodes) {
      if (n.type !== "MiniMaxRefSubject") continue;
      const widgets = n.widgets || [];
      const findW = (name) => widgets.find((x) => x.name === name);
      // 依次尝试多个候选 widget 名，返回第一个存在的值
      const findAny = (...names) => {
        for (const nm of names) {
          const w = findW(nm);
          if (w) return w.value;
        }
        return undefined;
      };
      const clean = (s) => (s === "None" ? "" : s || "");
      const v = findW("vlm_mode")?.value;
      const out = { vlm_mode: "api", gguf_name: "", mmproj_path: "", provider: "GLM", api_key: "" };
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out.vlm_mode = v.vlm_mode || out.vlm_mode;
        out.gguf_name = clean(v.gguf_name);
        out.mmproj_path = clean(v.mmproj_path);
        out.provider = v.provider || out.provider;
        out.api_key = clean(v.api_key);
      } else {
        out.vlm_mode = v || out.vlm_mode;
        out.gguf_name = clean(findAny("vlm_mode.gguf_name", "gguf_name"));
        out.mmproj_path = clean(findAny("vlm_mode.mmproj_path", "mmproj_path"));
        out.provider = findAny("vlm_mode.provider", "provider") || out.provider;
        out.api_key = clean(findAny("vlm_mode.api_key", "api_key"));
      }
      // 主 widget 缺失或为空时，从子 widget 推断模式
      if (out.vlm_mode === "api") {
        const hasGguf =
          findW("vlm_mode.gguf_name") || findW("gguf_name") ||
          findW("vlm_mode.mmproj_path") || findW("mmproj_path");
        if (hasGguf) out.vlm_mode = "llama-cpp";
      }
      if (!findW("vlm_mode") && !findW("vlm_mode.gguf_name") && !findW("vlm_mode.provider") && !findW("gguf_name") && !findW("provider")) {
        console.warn("[Transfer] getSubjectVlmSettings: 未找到 vlm 相关 widget，当前 widget 列表:",
          widgets.map((w) => `${w.name}(${w.type})`).join(", "));
      }
      return out;
    }
  } catch (e) {
    console.warn("[Transfer] getSubjectVlmSettings failed:", e);
  }
  return null;
}

function subjectImgSrc(s) {
  if (s.imageB64) return s.imageB64;
  if (s.imageFile && api) {
    return viewUrl(s.imageFile, "minimaxrefdirector");
  }
  return "";
}

// 主体媒体类型判断：优先按 type，其次按已有文件字段推断（兼容旧数据无 videoFile/type）
function subjectMediaPreview(s) {
  const t = s.type || "Subject";
  if (t === "Audio" || (s.audioFile && !s.imageFile && !s.videoFile)) return { kind: "audio" };
  if (t === "Video" || s.videoFile) return { kind: "video", src: s.videoB64 || (s.videoFile ? viewUrl(s.videoFile, "minimaxrefdirector") : "") };
  if (t === "Picture" || s.imageFile) return { kind: "image", src: subjectImgSrc(s) };
  return { kind: "none" };
}

// 下拉菜单里的媒体缩略图：
//   audio → 音频图标；video → 视频图标；image → 图片；无媒体 → "T"（文本主体）
// size：缩略图边长（px），默认 22（mention 菜单）；弹窗"添加主体"列表放大一倍用 44
function subjectMediaThumb(s, size = 22) {
  const p = subjectMediaPreview(s);
  const base = { width: size + "px", height: size + "px", borderRadius: "3px", flex: "0 0 auto", objectFit: "cover" };
  const iconBase = { width: size + "px", height: size + "px", borderRadius: "3px", flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(size * 0.5) + "px", fontStyle: "normal", lineHeight: 1, background: "#1e3a5f", color: "#38bdf8" };
  if (p.kind === "image") return html`<img src=${p.src} alt="" style=${base} />`;
  if (p.kind === "video") return html`<span title="视频" style=${Object.assign({}, iconBase, { color: "#a5d6a7" })}>▶</span>`;
  if (p.kind === "audio") return html`<span title="音频" style=${iconBase}>♪</span>`;
  // 无媒体（纯文本主体）：T 徽标
  return html`<span title="文本" style=${Object.assign({}, iconBase, { background: "#333", color: "#ccc", fontSize: Math.round(size * 0.5) + "px" })}>T</span>`;
}

// 主体定义 / retention_analysis / 媒体列表（images / audios / videos）
// 由后端 /h3/build_subject_bindings 接口（lib/prompt.py build_h3_subject_bindings）
// 生成，前端不再本地组装，见 fetchBindings()。

// 右侧 textarea 默认 JSON 数据结构（→ 生成结果会替代它）
const DEFAULT_PROMPT_JSON = {
  detailed_description: "",
  overall_soundscape: "",
  non_diegetic_music: "",
};

// 将 prompt JSON 按展示规则格式化为 textarea 文本
// 规则：
//   detailed_description:
//   [Shot 2]{shot2_description}（如果存在）
//   ...
//   {detailed_description}
//   overall_soundscape:
//   {overall_soundscape}或者N/A
//   non_diegetic_music:
//   {non_diegetic_music}N/A
function formatPromptJson(data) {
  const d = data && typeof data === "object" ? data : {};
  const val = (v) => (v != null && String(v).trim() !== "" ? String(v) : "N/A");
  const plain = (v) => (v != null ? String(v) : "");
  const lines = ["detailed_description:"];
  lines.push(plain(d.detailed_description) + "\n");
  lines.push("overall_soundscape:");
  lines.push(val(d.overall_soundscape) + "\n");
  lines.push("non_diegetic_music:");
  lines.push(val(d.non_diegetic_music) + "\n");
  return lines.join("\n");
}

// 将右侧 textarea 的展示文本反向解析回 JSON 对象
// （与 formatPromptJson 的规则对称，便于按钮增删 shotX_description）
function parsePromptText(text) {
  const obj = { detailed_description: "", overall_soundscape: "", non_diegetic_music: "" };
  const lines = (text || "").split("\n");
  let section = "detail"; // detail | overall | music
  const detailLines = [];
  for (const line of lines) {
    if (line.startsWith("detailed_description:")) { section = "detail"; continue; }
    if (line.startsWith("overall_soundscape:")) { section = "overall"; continue; }
    if (line.startsWith("non_diegetic_music:")) { section = "music"; continue; }
    if (section === "detail") {
      detailLines.push(line);
    } else if (section === "overall") {
      if (line.trim() !== "" && line.trim() !== "N/A") obj.overall_soundscape = line;
    } else if (section === "music") {
      if (line.trim() !== "" && line.trim() !== "N/A") obj.non_diegetic_music = line;
    }
  }
  obj.detailed_description = detailLines.join("\n");
  return obj;
}

// 更新右侧文本中某个字段
function updateShotField(text, key, value) {
  const obj = parsePromptText(text);
  obj[key] = value;
  return formatPromptJson(obj);
}

// 从右侧文本中删除某个字段
function removeShotField(text, key) {
  const obj = parsePromptText(text);
  delete obj[key];
  return formatPromptJson(obj);
}

// 素材追加计数器：每次 add_material 通知都会追加素材（不去重），
// id 需唯一（同时用作 React key 与多选集合依据），故在 URL 后附加自增序号。
let materialSeq = 0;

// 素材持久化 key：按 Director 节点 id 隔离（单 tab / 多 tab 均适用）。
// 多 tab 间的串扰由通知层的 director_node_id 精确过滤解决（见 onAddMaterial），
// 不再依赖不稳定的 workflow/tab 探测（探测依赖全局激活 tab，多 tab 下各组件
// 拿到的标识不一致，反而导致 key 错乱、素材互相覆盖）。
function materialStorageKey(director) {
  return "mrd_materials_" + (director?.node?.id || "default");
}

// 兼容旧版本迁移：上一版曾用 `mrd_materials_<nodeId>_<tabKey>` 存储，
// 升级后新 key 读不到时，从旧 key 迁移（避免素材“丢失”）。
function migrateLegacyMaterials(director) {
  try {
    const prefix = "mrd_materials_" + (director?.node?.id || "default") + "_";
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(prefix) === 0) {
        const raw = localStorage.getItem(k);
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list)) return { raw, list };
        }
      }
    }
  } catch (e) {
    // 迁移失败按无旧数据处理
  }
  return null;
}

// 长按拖出预取缓存：素材 id -> File。
// HTML5 DnD 的 dataTransfer.files 只能在 dragstart 里同步写入，而视频是异步 fetch 得到的
// Blob，因此先长按 ~400ms 触发预取并缓存为 File，随后原生拖动时在 dragstart 中同步注入。
const materialFileCache = new Map();
const LONG_PRESS_MS = 400; // 长按阈值
const DRAG_MOVE_TOLERANCE = 10; // 长按期间移动超过该像素视为放弃长按（改为直接拖动/滑动）
const CLICK_MOVE_TOLERANCE = 6; // 卡片 click 位移容忍：按下/松开位移超过该像素视为滑动而非点击

// 将后端 send_sync("minimax_ref_video_progress", ...) 通知里的 imageFile
// （VHS_FILENAMES：字符串 / 单对象 / 对象数组）解析为视频素材项 { id, label, src }。
// 基础 id 取文件 URL；实际 id 在追加时附加自增序号保证唯一（不做 URL/文件名去重）。
// 取文件名（兼容 Windows 反斜杠与 POSIX 斜杠）：
// VHS/输出目录返回的可能是绝对路径 D:\...\xx.mp4，若只用 "/" 分割，
// 整个绝对路径会变成 label 并被当作文件名上传到服务器。
function basename(p) {
  const parts = String(p || "").split(/[\\/]/);
  return parts.pop() || "";
}

function toVideoItems(imageFile) {
  const list = Array.isArray(imageFile) ? imageFile : [imageFile];
  const out = [];
  for (const f of list) {
    if (!f) continue;
    if (typeof f === "string") {
      if (!f.trim()) continue;
      const name = basename(f);
      out.push({ id: viewUrl(f, "", "output"), label: name, src: viewUrl(f, "", "output"), vw: null, vh: null });
    } else if (typeof f === "object") {
      const fn = f.filename || "";
      if (!fn) continue;
      const sub = f.subfolder || "";
      const type = f.type || "output";
      const src = viewUrl(fn, sub, type);
      out.push({ id: src, label: sub ? sub + "/" + fn : fn, src, vw: null, vh: null });
    }
  }
  return out;
}

// ---------- 样式 ----------
const S = {
  panel: {
    boxSizing: "border-box", width: "100%", height: "100%",
    display: "flex", flexDirection: "column", gap: "4px",
    fontFamily: "inherit", overflow: "hidden",
  },
  area: {
    flex: 1, resize: "none", boxSizing: "border-box", width: "100%", minHeight: 0,
    background: "#1e1e1e", color: "#ccc", border: "1px solid #444", borderRadius: "4px",
    padding: "6px", fontFamily: "monospace", fontSize: "12px", lineHeight: "1.5", outline: "none",
  },
  col: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  buttons: { display: "flex", gap: "6px", padding: "4px 0", flex: "0 0 auto" },
  resources: {
    display: "flex", flexDirection: "row", flexWrap: "nowrap", overflow: "auto",
    gap: "8px", padding: "4px 0", flex: "1 1 0", minHeight: "0",
    alignItems: "flex-start", borderTop: "1px solid #333", scrollbarWidth: "thin",
  },
  resourcesList: {
    display: "flex", flexWrap: "wrap", gap: "8px"
  },
  res: {
    flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "center", gap: "2px",
    background: "#2a2a2a", borderRadius: "6px", padding: "4px", width: "120px",
  },
  img: { width: "100%", height: "auto", objectFit: "cover", borderRadius: "4px", background: "#111" },
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
  audioIcon: { fontSize: "10px", color: "#ffb74d" },
  resAudio: {
    width: "48px", height: "48px", borderRadius: "4px", background: "#1e3a5f",
    color: "#38bdf8", display: "inline-flex", alignItems: "center", justifyContent: "center",
    fontSize: "16px", flex: "0 0 auto",
  },
  defsWrap: {
    position: "relative", flex: "0 0 auto", display: "flex", alignItems: "center",
    alignSelf: "flex-start", padding: "0 4px", cursor: "help",
  },
  defsIcon: { fontSize: "13px", color: "#5c9dff", lineHeight: 1, userSelect: "none" },
  defsTip: {
    position: "fixed", zIndex: 99999,
    background: "#2d2d2d", border: "1px solid #555", borderRadius: "6px",
    padding: "8px 10px", minWidth: "280px", maxWidth: "460px", maxHeight: "60vh",
    overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,.5)",
    fontSize: "11px", color: "#ccc", fontFamily: "monospace", lineHeight: "1.5",
  },
  defsTipEmpty: { color: "#888" },
  trBtn: { width: "100%", margin: "1px 0"},
  // .tr-resources 右下角：Minimax H3 Prompt 只读预览（点击打开编辑器）
  // 宽度占资源条一半，高度自适应（min 450px），超高内部滚动
  h3PreviewWrap: {
    flex: "0 0 50%", width: "50%", display: "flex", flexDirection: "column",
    alignSelf: "stretch", marginLeft: "auto", borderLeft: "1px solid #333",
    paddingLeft: "8px", minHeight: "0", cursor: "pointer",
  },
  h3PreviewLabel: {
    fontSize: "10px", color: "#888", textTransform: "uppercase", letterSpacing: "0.5px",
    padding: "0 0 2px", userSelect: "none", whiteSpace: "nowrap",
  },
  h3PreviewArea: {
    flex: "1 1 0", minHeight: "0", width: "100%", boxSizing: "border-box",
    background: "rgba(30,30,30,.55)", color: "#fff", border: "1px dashed #444",
    borderRadius: "4px", padding: "4px 6px", fontFamily: "monospace", fontSize: "10px",
    lineHeight: "1.4", resize: "none", outline: "none", cursor: "pointer",
    overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-wrap",
  },
  refTextarea: { position: "static", flex: "1 1 0", minHeight: "0", height: "100%", width: "100%", boxSizing: "border-box", background: "#1e1e1e", border: "none", resize: "none", outline: "none", padding: "4px 8px 8px", color: "#e0e0e0", fontSize: "12px", lineHeight: "1.4", fontFamily: "monospace" },
  refTextareaLabel: { position: "static", flexShrink: 0, margin: "6px 0 2px 8px" },
  // 视频素材条（接收后端 minimax_ref_video_progress 通知）：面板底部、x 轴排列、可横向滚动
  materialsWrap: {
    borderTop: "1px solid #333", padding: "6px 0 2px", flex: "0 0 auto", marginBottom: "20px",
    display: "flex", flexDirection: "column", gap: "4px", backgroundColor: "rgb(30, 30, 30)"
  },
  materialsHead: { display: "flex", alignItems: "center", gap: "8px", padding: "0 2px", flex: "0 0 auto", margin: "6px 0px 2px 8px", color: "#666" },
  // 标题采用 .mrd-pr-prompt-label 样式（shared.js 中定义）
  materialsTitle: {
    fontSize: "9px", fontWeight: "bold", color: "#666",
    textTransform: "uppercase", letterSpacing: "0.5px",
    pointerEvents: "none", userSelect: "none", flex: "0 0 auto",
  },
  materialsSel: { fontSize: "11px", color: "#5c9dff", userSelect: "none" },
  materialsDelBtn: { padding: "2px 8px", fontSize: "11px", marginLeft: "auto" },
  materialsMergeBtn: { padding: "2px 8px", fontSize: "11px" },
  materialsStrip: {
    display: "flex", flexDirection: "row", flexWrap: "nowrap", overflowX: "auto",
    gap: "6px", padding: "2px 8px 6px", alignItems: "stretch",
    outline: "none", scrollbarWidth: "thin",
  },
  materialCard: {
    flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "center", gap: "2px",
    background: "rgb(30, 30, 30)", border: "1px solid #444", borderRadius: "6px", padding: "3px",
    width: "186px", cursor: "pointer", userSelect: "none", position: "relative",
  },
  materialCardSel: { borderColor: "#5c9dff", boxShadow: "0 0 0 1px #5c9dff" },
  materialCardReady: { borderColor: "#3ecf5f", boxShadow: "0 0 0 1px #3ecf5f" },
  materialReadyBadge: {
    position: "absolute", top: "4px", right: "4px", zIndex: 2,
    background: "rgba(40, 167, 69, .92)", color: "#fff", fontSize: "9px",
    lineHeight: "14px", padding: "0 5px", borderRadius: "8px", pointerEvents: "none",
    boxShadow: "0 0 4px rgba(0,0,0,.5)",
  },
  // 合并选中序号角标：视频卡片左上角，按用户点击选中的先后顺序显示 1/2/3…
  materialOrderBadge: {
    position: "absolute", top: "4px", left: "4px", zIndex: 2,
    background: "rgba(92, 157, 255, .92)", color: "#fff", fontSize: "10px",
    fontWeight: "bold", lineHeight: "16px", minWidth: "16px", textAlign: "center",
    padding: "0 5px", borderRadius: "8px", pointerEvents: "none",
    boxShadow: "0 0 4px rgba(0,0,0,.5)",
  },
  dragHint: {
    margin: "0 8px 4px", fontSize: "11px", color: "#7fd88a",
    background: "rgba(40, 167, 69, .12)", border: "1px solid rgba(62, 207, 95, .35)",
    borderRadius: "4px", padding: "3px 8px", whiteSpace: "nowrap", overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // 16:9 预览区（180x101，宽度为原 90px 的 2 倍）：横屏视频单屏铺满；
  // 竖屏（如 9:16）视频在区域内横向重复平铺填满（materialTiles + materialTileVid）
  materialVideo: { width: "180px", height: "101px", objectFit: "cover", borderRadius: "3px", background: "#000", pointerEvents: "none", display: "block" },
  materialTiles: {
    width: "180px", height: "101px", overflow: "hidden", borderRadius: "3px", background: "#000",
    display: "flex", flexDirection: "row", flexWrap: "nowrap", pointerEvents: "none",
  },
  materialTileVid: { height: "101px", objectFit: "cover", flex: "0 0 auto", display: "block", pointerEvents: "none" },
  materialLabel: { fontSize: "9px", color: "#aaa", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  // 双击素材打开的播放器弹窗（暗色风格，仿 Comfy 媒体查看器）
  viewerOverlay: {
    position: "fixed", inset: 0, zIndex: 100000,
    background: "rgba(0,0,0,.75)", display: "flex", alignItems: "center", justifyContent: "center",
  },
  viewerBox: {
    maxWidth: "86vw", maxHeight: "86vh", background: "#1e1e1e", border: "1px solid #555",
    borderRadius: "8px", boxShadow: "0 8px 30px rgba(0,0,0,.6)", overflow: "hidden",
    display: "flex", flexDirection: "column",
  },
  viewerHead: {
    display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px",
    borderBottom: "1px solid #333", flex: "0 0 auto",
  },
  viewerTitle: {
    flex: "1", fontSize: "12px", color: "#ccc", overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  viewerBtn: { padding: "4px 10px", fontSize: "11px", flex: "0 0 auto" },
  viewerVideo: { maxWidth: "82vw", maxHeight: "74vh", display: "block", background: "#000" },
};

// ---------- 全局参数 ----------

const RESOLUTION_OPTIONS = ["1:1方形", "9:16竖屏", "16:9横屏", "3:2横屏", "2:3竖屏", "4:3横屏", "3:4竖屏", "21:9超宽"];

// 全局参数 widget 名（已加入 HIDDEN_WIDGET_NAMES 在节点上隐藏，改由本面板 inline 编辑）
// Start/End/Duration 按 display_mode 动态切换单位：
//   seconds -> start_second/end_second/duration_seconds（Start(s)/End(s)/Duration(s)）
//   frames  -> start_frame/end_frame/duration_frames（Start(f)/End(f)/Duration(f)）
const TIME_PARAM_DEFS = {
  seconds: [
    { name: "start_second", label: "Start(s)", type: "number", fallback: 0, min: 0, max: 1000, step: 0.01, digits: 2 },
    { name: "end_second", label: "End(s)", type: "number", fallback: 5, min: 0, max: 1000, step: 0.01, digits: 2 },
    { name: "duration_seconds", label: "Duration(s)", type: "number", fallback: 5, min: 0.1, max: 1000, step: 0.01, digits: 2 },
  ],
  frames: [
    { name: "start_frame", label: "Start(f)", type: "number", fallback: 0, min: 0, max: 100000, step: 1, digits: 0 },
    { name: "end_frame", label: "End(f)", type: "number", fallback: 120, min: 1, max: 100000, step: 1, digits: 0 },
    { name: "duration_frames", label: "Duration(f)", type: "number", fallback: 120, min: 1, max: 100000, step: 1, digits: 0 },
  ],
};

const OTHER_GLOBAL_DEFS = [
  { name: "frame_rate", label: "FPS", type: "number", fallback: 24, min: 1, max: 240, step: 1, digits: 0 },
  { name: "outpu_resolution", label: "Resolution", type: "select", fallback: "16:9横屏", options: RESOLUTION_OPTIONS },
  { name: "million_pixels", label: "Million Pixels", type: "number", fallback: 0.6, min: 0.1, max: 4, step: 0.1, digits: 1 },
];

// ---------- 数字输入框（失焦/回车提交，允许输入中间态） ----------
// 本地文本 state 保留用户正在输入的原始内容（如 "0."、"0.05"），只在
// 失焦/回车时解析并提交：按 digits 四舍五入、clamp 到 [min,max]。
// 避免受控组件在每次击键时强制重渲染，吞掉小数点 / 前导 0。
function NumInput({ def, value, onCommit }) {
  const [text, setText] = useState(() => String(value ?? def.fallback ?? ""));
  // 外部值变化（FPS 联动、显示模式切换等）时同步显示
  useEffect(() => {
    setText(String(value ?? def.fallback ?? ""));
  }, [value, def]);

  const commit = () => {
    let nv = parseFloat(text);
    if (Number.isNaN(nv)) nv = def.fallback;
    nv = Math.min(Math.max(nv, def.min), def.max);
    const digits = def.digits ?? (def.step < 1 ? 2 : 0);
    nv = digits > 0 ? Number(nv.toFixed(digits)) : Math.round(nv);
    onCommit(def.name, nv);
  };

  return html`<input
    class="tr-gp-input"
    type="number"
    min=${def.min}
    max=${def.max}
    step=${def.step}
    value=${text}
    onInput=${(e) => setText(e.target.value)}
    onBlur=${commit}
    onKeyDown=${(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
  />`;
}

// ---------- Preact 组件 ----------

export function TransferPanel({ director }) {
  const [leftText, setLeftText] = useState(() => director?.promptInput?.value || "");
  const [rightText, setRightText] = useState(() => formatPromptJson(DEFAULT_PROMPT_JSON));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [subjects, setSubjects] = useState([]);
  const [menu, setMenu] = useState(null); // { side, trigger, caret, x, y }
  const [resources, setResources] = useState([]);
  const [editorOpen, setEditorOpen] = useState(false); // 统一弹窗（Segment Prompt / H3 Prompt / 添加主体）
  const [curSeg, setCurSeg] = useState(null); // 当前选中 segment（由 director 推送）
  const [motionCtxOn, setMotionCtxOn] = useState(false); // Motion Context 开关
  const [autoEndOn, setAutoEndOn] = useState(false); // Auto End Frame 开关
  const [defsOpen, setDefsOpen] = useState(false); // .tr-resources 信息图标 hover
  const [defsPos, setDefsPos] = useState(null); // 信息图标 tooltip fixed 定位坐标 { left, top, up }
  const [bindData, setBindData] = useState(null); // 后端 build_h3_subject_bindings 结果
  const [addVersion, setAddVersion] = useState(0); // additionSubject 变更计数（驱动资源条 / 绑定刷新）
  // 视频素材条：接收后端 minimax_ref_video_progress 通知（status=add_material）。
  // 初始化时从 localStorage 恢复上次会话的素材（key 按节点 id 隔离），刷新页面后保留，
  // 只有点击删除才会移除。
  const [materials, setMaterials] = useState(() => {
    try {
      const key = materialStorageKey(director);
      const raw = localStorage.getItem(key);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          // 恢复自增序号，避免与后续追加素材的 id 冲突
          let maxSeq = 0;
          for (const m of list) {
            const n = parseInt(String(m.id).split("#").pop(), 10);
            if (!isNaN(n) && n > maxSeq) maxSeq = n;
          }
          if (maxSeq > materialSeq) materialSeq = maxSeq;
          return list;
        }
      }
      // 兼容上一版带 tab 后缀的 key：读到后迁移到当前 key，避免素材“丢失”
      const legacy = migrateLegacyMaterials(director);
      if (legacy) {
        const list = legacy.list;
        let maxSeq = 0;
        for (const m of list) {
          const n = parseInt(String(m.id).split("#").pop(), 10);
          if (!isNaN(n) && n > maxSeq) maxSeq = n;
        }
        if (maxSeq > materialSeq) materialSeq = maxSeq;
        try { localStorage.setItem(key, JSON.stringify(list)); } catch (e2) { /* ignore */ }
        return list;
      }
    } catch (e) {
      console.warn("[Transfer] 素材恢复失败:", e);
    }
    return [];
  }); // [{ id, label, src }]
  const [selIds, setSelIds] = useState(() => new Set()); // 多选选中的素材 id 集合
  // 选中顺序数组：按用户点击选中的先后顺序记录 id，作为合并时的拼接顺序；
  // Shift 范围选择 / Ctrl 追加的 id 追加到末尾，取消选中则移除。
  const [selOrder, setSelOrder] = useState(() => []);
  const [anchorId, setAnchorId] = useState(null); // Shift 范围选择锚点
  const [viewer, setViewer] = useState(null); // 双击素材打开的播放器弹窗（当前查看的素材对象）
  const [dragReadyId, setDragReadyId] = useState(null); // 长按预取完成、可拖出到其他上传框的素材 id
  const [dragHint, setDragHint] = useState(""); // 长按拖出操作提示（自动消失）
  const [mergeBusy, setMergeBusy] = useState(false); // 素材合并请求进行中
  const longPressRef = useRef(null); // 长按状态 { id, fired, x, y, timer }
  const suppressClickRef = useRef(false); // 长按松手后抑制随后的 click（避免误改选中）
  const dragHintTimerRef = useRef(null); // 提示自动消失定时器
  const downPosRef = useRef(null); // 卡片 pointerdown 位置 { x, y }：区分点击与滑动/拖动（见卡片 onClick）
  const stripDownPosRef = useRef(null); // 素材条空白处 pointerdown 位置：区分点击与滑动/拖动滚动

  const leftRef = useRef(null);
  const stripRef = useRef(null); // 素材条横向滚动容器
  const rightRef = useRef(null);
  const debounceRef = useRef(null);
  const bindDebounceRef = useRef(null); // 主体绑定接口请求防抖
  const bindSeqRef = useRef(0); // 绑定请求序号：只应用最新一次请求的返回，防并发乱序覆盖
  const aliveRef = useRef(true);
  const rightSaveFirstRun = useRef(true);
  const lastSegIdRef = useRef(null); // 记录当前已加载右侧 JSON 的 segment id

  // 挂载：读主体列表，向外壳注册左侧同步通道 + 当前选中 segment 通道
  useEffect(() => {
    aliveRef.current = true;
    setSubjects(getSubjectsLatest());
    // 监听 subject.js 发布的 ref:subjects-changed 事件：主体新增/删除/修改时实时刷新
    const onSubjectsChanged = () => {
      if (!aliveRef.current) return;
      setSubjects(getSubjectsLatest());
    };
    window.addEventListener("ref:subjects-changed", onSubjectsChanged);
    if (director) {
      director._transferSetLeft = setLeftText;
      director._transferSetSeg = (seg) => {
        setCurSeg(seg);
        setMotionCtxOn(!!(seg && seg.motionContext));
        setAutoEndOn(!!(seg && seg.autoEndFrame));
        // 切换 segment 时加载该 segment 独立的 H3 prompt JSON（右侧）。
        // 同一 segment 的 UI 刷新（如生成首帧成功后回推）不重置右侧内容。
        const segId = seg ? seg.id : null;
        if (segId && segId !== lastSegIdRef.current) {
          lastSegIdRef.current = segId;
          // 无 segment JSON 时回退默认模板，避免残留上一个 segment 的内容
          setRightText(
            seg && typeof seg.h3PromptJson === "string"
              ? seg.h3PromptJson
              : formatPromptJson(DEFAULT_PROMPT_JSON)
          );
        } else if (!segId) {
          lastSegIdRef.current = null;
        }
      };
      // 挂载时主动同步一次当前选中 segment（director 可能早已有选择）
      const initSeg = director.selectionType === "audio"
        ? (director.timeline?.audioSegments?.[director.selectedIndex] || null)
        : (director.timeline?.segments?.[director.selectedIndex] || null);
      if (initSeg && director._transferSetSeg) director._transferSetSeg(initSeg);
      // 同步左侧 prompt：外壳 updateUIFromSelection 可能在 _transferSetLeft 注册
      // 之前就已执行（构造时序竞争），这里手动补一次，保证刷新/加载后左侧显示对应内容
      const initPrompt = initSeg
        ? (initSeg.prompt || "")
        : (director.promptInput?.value || "");
      setLeftText(initPrompt);
      // 优先从当前 segment 的 h3PromptJson 恢复右侧内容；
      // 无 segment JSON 时兜底从节点 properties 恢复旧版 __rightPromptText（兼容旧 workflow）
      const segJson = initSeg && typeof initSeg.h3PromptJson === "string" ? initSeg.h3PromptJson : "";
      if (segJson) {
        lastSegIdRef.current = initSeg.id;
        setRightText(segJson);
      } else {
        const savedRight = director.node?.properties?.__rightPromptText;
        if (typeof savedRight === "string" && savedRight) setRightText(savedRight);
      }
    }
    return () => {
      aliveRef.current = false;
      window.removeEventListener("ref:subjects-changed", onSubjectsChanged);
      clearTimeout(debounceRef.current);
      if (director && director._transferSetLeft === setLeftText) {
        director._transferSetLeft = null;
      }
      if (director && director._transferSetSeg) {
        director._transferSetSeg = null;
      }
    };
  }, [director]);

  // 接收后端 send_sync("minimax_ref_video_progress", ...) 通知：
  //  status="add_material" & type="video" 时把 imageFile（VHS_FILENAMES）追加到视频素材条。
  // 新视频沿 x 轴依次添加（追加到末尾），并自动滚动到最新素材使其可见。
  // 多 tab / 多节点过滤：后端通知携带 director_node_id（即本 Director 节点 id），
  // 精确匹配才接收；旧版后端无该字段时回退为“当前 graph 中存在来源节点”才接收，
  // 避免 ComfyUI 工作台其他 tab 的节点执行/合并时把视频串收到本素材条。
  useEffect(() => {
    const onAddMaterial = (e) => {
      if (!aliveRef.current) return;
      const d = e && e.detail ? e.detail : {};
      if (d.status !== "add_material" || d.type !== "video") return;
      const myNodeId = director?.node?.id;
      const hasMine = myNodeId !== undefined && myNodeId !== null;
      if (d.director_node_id !== undefined && d.director_node_id !== null) {
        // 新后端：精确匹配 Director 节点 id
        if (!hasMine || String(d.director_node_id) !== String(myNodeId)) return;
      } else if (d.node_id !== undefined && d.node_id !== null && hasMine) {
        // 旧版后端兜底：node_id 是 Guide 节点 id，无法直接比对，
        // 仅当当前 graph 中存在该节点时接收（来源属于本工作流）
        let found = false;
        try {
          const g = (typeof window !== "undefined" && window.app) ? window.app.graph : null;
          if (g && Array.isArray(g._nodes)) {
            found = g._nodes.some((n) => String(n.id) === String(d.node_id));
          }
        } catch (_e) { /* ignore */ }
        if (!found) return;
      }
      // 无任何来源标识的极旧版本通知：直接接收（单 tab 正常行为）
      const items = toVideoItems(d.imageFile);
      if (!items.length) return;
      setMaterials((prev) => {
        const next = prev.slice();
        for (const it of items) {
          // 不去重：后端每次 add_material 通知都追加（guide 正常轮与越界轮会各发一次同 URL）。
          // id 附加自增序号保证唯一，避免 React key / 多选集合冲突。
          materialSeq += 1;
          next.push({ ...it, id: it.id + "#" + materialSeq });
        }
        return next;
      });
      // 渲染后滚动到最右端，展示最新添加的视频
      requestAnimationFrame(() => {
        if (stripRef.current) stripRef.current.scrollLeft = stripRef.current.scrollWidth;
      });
    };
    if (api && typeof api.addEventListener === "function") {
      api.addEventListener("minimax_ref_video_progress", onAddMaterial);
      return () => {
        if (typeof api.removeEventListener === "function") {
          api.removeEventListener("minimax_ref_video_progress", onAddMaterial);
        }
      };
    }
    return undefined;
  }, []);

  // 素材持久化：materials 变化（追加 / 删除 / metadata 更新）时写回 localStorage
  useEffect(() => {
    if (!aliveRef.current || !director?.node?.id) return;
    try {
      localStorage.setItem(materialStorageKey(director), JSON.stringify(materials));
    } catch (e) {
      console.warn("[Transfer] 素材保存失败:", e);
    }
  }, [materials, director]);

  // 播放器弹窗：Esc 关闭（在弹窗打开期间全局监听）
  useEffect(() => {
    if (!viewer) return;
    const onKey = (e) => { if (e.key === "Escape") setViewer(null); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [viewer]);

  // 右侧内容持久化：每次编辑写回当前 segment 的 h3PromptJson，
  // 随 commitChanges 的 ...rest 序列化进 timeline_data（per-segment 存储）。
  // 旧版 __rightPromptText 仅作为无 segment JSON 时的加载兜底，不再写入。
  // 首次渲染跳过，避免用默认值覆盖已保存内容。
  useEffect(() => {
    if (rightSaveFirstRun.current) {
      rightSaveFirstRun.current = false;
      return;
    }
    if (!aliveRef.current || !director?.node) return;
    const seg = curSeg;
    if (!seg || typeof seg.id === "undefined") return;
    if (seg.h3PromptJson !== rightText) {
      seg.h3PromptJson = rightText;
      // 经外壳 commitChanges 序列化（...rest 保留 h3PromptJson 自定义字段）
      director.commitChanges(true);
      // 标记画布已修改，触发 ComfyUI 自动保存 / 序列化
      if (app.graph) app.graph.setDirtyCanvas(true, true);
    }
  }, [rightText, curSeg, director]);

  // 点击外部关闭 mention 菜单
  useEffect(() => {
    if (!menu) return;
    const onDown = (e) => {
      if (e.target.closest && !e.target.closest(".ref-ms-mention-popup")) setMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [menu]);

  // 资源引用条：优先使用后端 /h3/build_subject_bindings 返回的 subjects
  // （已包含 prompt 提及 + additionSubject 手动添加的主体，媒体字段权威），
  // 不再本地正则解析 prompt；bindData 未就绪（未加载/请求失败）时 fallback 到 parseResources。
  useEffect(() => {
    if (bindData && Array.isArray(bindData.subjects)) {
      setResources(resourcesFromBindings(bindData, curSeg));
      return;
    }
    setResources(parseResources(rightText, subjects));
  }, [bindData, rightText, subjects, addVersion, curSeg]);

  // 右侧 H3 JSON / 主体 / 当前选中段 / 时间轴变化时 debounce 请求后端
  // /h3/build_subject_bindings（替代前端 buildFirstFramePayload 的绑定组装）。
  // 绑定 prompt 中提到的主体 + 当前 segment additionSubject 手动添加的主体。
  // 注意：curSeg 必须在依赖中——切换 segment 时若两段 h3PromptJson 相同，
  // setRightText 相同值会 bail out，仅靠 rightText 变化驱动会导致不发起请求。
  useEffect(() => {
    if (!aliveRef.current || !director) return;
    clearTimeout(bindDebounceRef.current);
    bindDebounceRef.current = setTimeout(() => {
      fetchBindings();
    }, 400);
    return () => clearTimeout(bindDebounceRef.current);
  }, [rightText, subjects, director, addVersion, curSeg]);

  // ---------- 工具 ----------

  const wVal = (name) =>
    director?.node?.widgets?.find(w => w.name === name)?.value ??
    director?.node?.properties?.[name];

  // 统一构造 VLM 生成请求体：优先读取连接的 Subject 节点配置（vlm_mode 等），
  // 兜底默认 api 模式（回落 API 管理器配置的 key）
  const vlmBody = (extra) => {
    const v = getSubjectVlmSettings() || {};
    return {
      vlm_mode: v.vlm_mode || "api",
      seed: wVal("seed") ?? 42,
      gguf_path: v.gguf_name || "",
      mmproj_path: v.mmproj_path || "",
      provider: v.provider || "GLM",
      api_key: v.api_key || "",
      ...extra,
    };
  };

  // textarea 高度由 flex:1 均分弹窗高度控制（auto-grow 已移除）

  // 返回 subject_definitions / retention_analysis + images / audios / videos。
  // 替代前端 buildFirstFramePayload 中的绑定组装；绑定 prompt 中提到的主体 +
  // 当前 segment additionSubject 手动添加的主体。
  const fetchBindings = async () => {
    if (!aliveRef.current || !director) return null;
    const seq = ++bindSeqRef.current; // 本次请求序号
    try {
      // timeline_segment：当前选中 segment（含 additionSubject，供后端追加绑定未提及的主体）
      const seg = curSeg;
      // 过滤 prompt 中已提及（<@name> 会由 prompt 绑定，后端将其写入 mapping）的主体，避免重复追加。
      // 注意：additionSubject 手动添加的主体不会被写入 mapping，必须保留发送，
      // 否则"已绑定→从 additionSubject 移除→解除绑定→回到候选"循环。
      const boundMentions = new Set();
      for (const k of Object.keys(bindData?.mapping || {})) {
        const mm = /^<@([^>]+)>$/.exec(k);
        if (mm) boundMentions.add(mm[1]);
      }
      const body = {
        subject_data: { subjects: subjects || [] },
        raw_prompt: rightText,
        timeline_segment: seg
          ? {
              type: seg.type,
              start: seg.start,
              videoFile: seg.videoFile || "",
              audioFile: seg.audioFile || "",
              additionSubject: (Array.isArray(seg.additionSubject) ? seg.additionSubject : []).filter((n) => !boundMentions.has(n)),
            }
          : {},
      };
      const res = await api.fetchApi("/minimax_ref/api/h3/build_subject_bindings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      // 仅最新一次请求的返回允许写回 bindData：并发请求乱序返回时，
      // 旧请求的成功响应不再覆盖新请求的结果（失败时保留上次成功结果作为 fallback）。
      if (data && data.success && aliveRef.current && seq === bindSeqRef.current) {
        setBindData(data.data || null);
        return data.data || null;
      }
      return null;
    } catch (e) {
      console.warn("[Transfer] build_subject_bindings failed:", e);
      return null;
    }
  };

      const srcOf = (s) => s?.imageB64 || s?.imgObj?.src || "";
  const firstFramePath = () => {
    const segs = director?.timeline?.segments || [];
    if (segs?.[director.selectedIndex]?.type === "image")
      return srcOf((segs?.[director.selectedIndex] || null));
    return null;
  };

  // Motion Context 开关：更新 timeline_data 对应字段。
  // 提示词优化后并入 detailed_description，文字 / 视频节点不再写任何 shot 字段。
  function toggleMotionContext() {
    const seg = curSeg;
    if (!seg || !director) return;
    const on = !motionCtxOn;
    setMotionCtxOn(on);
    seg.motionContext = on; // 更新 timeline_data 对应字段
    director.commitChanges();
  }

  // 图片节点：调用 /llm/generate_image_analysis 分析图片，图片内容 + 提示词合并优化后
  async function analyzeImageForDetailed(seg) {
    if (!seg || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = vlmBody({
        image_path: seg.imageFile || seg.imageB64 || "",
        prompt: seg.prompt || "",
      });
      const res = await api.fetchApi("/minimax_ref/api/llm/generate_image_analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      console.log("[Transfer] generate_image_analysis ->", data);
      if (data && data.success) {
        const pd = data.prompt_data;
        const desc = pd && typeof pd === "object"
          ? (pd.detailed_description || JSON.stringify(pd))
          : String(pd || "");
        // 追加而非覆盖，避免丢失已有 detailed_description
        const cur = parsePromptText(rightText).detailed_description || "";
        const merged = cur.trim() ? cur.trim() + "\n" + desc : desc;
        setRightText(updateShotField(rightText, "detailed_description", merged));
      } else {
        setError((data && data.error) || "图像分析失败");
      }
    } catch (e) {
      console.error("[Transfer] analyzeImageForDetailed failed:", e);
      setError(String(e?.message || e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  // 自动尾帧开关：更新 timeline_data 对应字段；开启将 shotX_description 放入 json，取消删除。
  function toggleAutoEndFrame() {
    const seg = curSeg;
    if (!seg || !director) return;
    const on = !autoEndOn;
    setAutoEndOn(on);
    seg.autoEndFrame = on; // 更新 timeline_data 对应字段
    director.commitChanges();
  }

  async function runGenerate(source) {
    if (busy) return;
    if (!source) {
      setError("请输入左侧 Segment Prompt 后再生成");
      return;
    }
    setBusy(true);
    setError("");
    const targetSeg = curSeg; // 记录发起请求时的 segment，返回结果写回该 segment
    try {
      const body = vlmBody({
        prompt: source,
        image_path: firstFramePath(),
      });
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
        const text =
          obj && typeof obj === "object"
            ? formatPromptJson(obj)
            : typeof data.json_data === "string"
              ? data.json_data
              : JSON.stringify(data.json_data, null, 2);
        // 生成结果写回发起请求时的 segment 的 H3 prompt JSON（随 timeline_data 持久化）
        if (targetSeg && typeof targetSeg.id !== "undefined") {
          targetSeg.h3PromptJson = text;
          director.commitChanges(true);
        }
        // 右侧编辑器仅在仍处于同一 segment 时刷新，避免请求期间切换 segment 被误覆盖
        if (targetSeg === curSeg) setRightText(text);
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

  // 最近的 transform 祖先 = position:fixed 的实际包含块（ComfyUI 图容器带平移/缩放）
  function getFixedCb(el) {
    let node = el.parentElement;
    while (node) {
      const cs = getComputedStyle(node);
      const tf = cs.transform || cs.webkitTransform || "";
      if (tf && tf !== "none") return node;
      node = node.parentElement;
    }
    return null;
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
    // fixed 定位实际以最近 transform 祖先（图容器）为包含块解析，rect 是视口坐标，
    // 需减去包含块左上角，否则菜单整体偏移（可能移出可视区，表现为输入 @/# 无反应）。
    // 注意与 modal.js 拖动定位一致：包含块在 ComfyUI 图容器（transform 平移/缩放）内时，
    // getBoundingClientRect 是已含 scale 的视口坐标，写入 fixed 定位必须是布局值，
    // 故差值必须除以缩放系数，否则画布缩放 ≠1 时菜单位置会被 scale 二次放大而偏离光标。
    const cb = getFixedCb(el);
    const cbRect = cb ? cb.getBoundingClientRect() : { left: 0, top: 0 };
    const scale = cb && cb.offsetWidth > 0 && cbRect.width > 0 ? cbRect.width / cb.offsetWidth : 1;
    const vw = cb ? cbRect.width / scale : window.innerWidth;
    const x = Math.max(4, Math.min((rect.left - cbRect.left) / scale + col * charW, vw - 200));
    const y = (rect.top - cbRect.top) / scale + (line + 1) * lineHeight + 6;
    // 打开菜单前刷新一次主体列表，确保新增的主体立即可选
    setSubjects(getSubjectsLatest());
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
    const token = menu.trigger === "@" ? `<@${s.name}>` : `<#${s.name}:对话内容>`;
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

  // 资源引用条数据：直接使用后端 /h3/build_subject_bindings 返回的 subjects
  // （后端已按 prompt 提及 + additionSubject 手动添加过滤，媒体字段为权威来源）。
  // kind 依据当前 segment 的 additionSubject 区分，用于展示"＋"与移除按钮。
  function resourcesFromBindings(bindData, seg) {
    const out = [];
    const added = new Set(Array.isArray(seg?.additionSubject) ? seg.additionSubject : []);
    for (const s of bindData.subjects || []) {
      if (!s || !s.name) continue;
      const kind = added.has(s.name) ? "addition" : "subject";
      out.push({
        key: (kind === "addition" ? "add-" : "subj-") + s.name,
        label: s.name,
        src: subjectImgSrc(s),
        audio: s.audioFile,
        kind,
      });
    }
    return out;
  }

  // 本地兜底解析：bindData 未就绪（未加载/请求失败）时从 prompt 文本提取引用
  function parseResources(text, subjectsList) {
    const out = [];
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
    // additionSubject：用户在主体添加框手动加入、但未在 prompt 中提及的主体
    for (const name of curSeg?.additionSubject || []) {
      if (used.has(name)) continue;
      const s = subjectsList.find(x => x.name === name);
      if (s) {
        out.push({ key: "add-" + name, label: name, src: subjectImgSrc(s), audio: s.audioFile, kind: "addition" });
      }
    }
    return out;
  }

  // ---------- additionSubject 添加框 ----------
  // 已绑定主体：后端 /h3/build_subject_bindings 返回的 subjects（= prompt 提及 + additionSubject 添加），
  // 不再本地解析 prompt 文本
  const boundNames = new Set((bindData?.subjects || []).map((s) => s?.name).filter(Boolean));
  const addedNames = Array.isArray(curSeg?.additionSubject) ? curSeg.additionSubject : [];
  // 已被绑定的主体不再作为 additionSubject 展示
  const visibleAdded = addedNames.filter((n) => !boundNames.has(n));
  const addCandidates = subjects.filter((s) => !boundNames.has(s.name) && !addedNames.includes(s.name));
  const addSubject = (name) => {
    if (!curSeg || !director) return;
    if (!Array.isArray(curSeg.additionSubject)) curSeg.additionSubject = [];
    if (curSeg.additionSubject.includes(name)) return;
    curSeg.additionSubject.push(name);
    setAddVersion((v) => v + 1);
    director.commitChanges(true);
  };
  // 信息图标 tooltip：fixed 定位避免被 .tr-resources 的 overflow 裁剪；跟随鼠标坐标移动，
  // 带 6px 移动阈值（鼠标慢速移动/停顿时 tooltip 留在原地，方便移入内部滚动），按包含块空间决定向上/向下弹出
  const defsTimer = useRef(null); // 延迟关闭定时器：鼠标从图标滑向 tooltip 的间隙不关闭
  const defsLastXY = useRef(null); // 上次定位的鼠标坐标，用于移动阈值判断
  const openDefsTip = (e) => {
    if (e.target && e.target.closest && e.target.closest(".tr-defs-tip")) return; // 鼠标在 tooltip 上时停止跟随，允许滚动内容
    const last = defsLastXY.current;
    if (last && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6) return; // 移动不足阈值：tooltip 原地不动，鼠标可移入
    defsLastXY.current = { x: e.clientX, y: e.clientY };
    // fixed 定位实际以最近 transform 祖先（图容器，带平移/缩放）为包含块解析，clientX/Y 是视口坐标，
    // 需减包含块左上角并除以缩放系数，否则画布缩放 ≠1 时 tooltip 偏离鼠标、根本点不到。
    // 与 openMenu / modal.js 拖动定位同一套换算。
    const cb = getFixedCb(e.currentTarget);
    const cbRect = cb ? cb.getBoundingClientRect() : { left: 0, top: 0 };
    const scale = cb && cb.offsetWidth > 0 && cbRect.width > 0 ? cbRect.width / cb.offsetWidth : 1;
    const cx = (e.clientX - cbRect.left) / scale;
    const cy = (e.clientY - cbRect.top) / scale;
    const cw = cb ? cbRect.width / scale : window.innerWidth;
    const ch = cb ? cbRect.height / scale : window.innerHeight;
    const up = cy > ch * 0.55;
    const left = Math.max(4, Math.min(cx, cw - 300));
    const top = up ? cy - 6 : cy + 14;
    setDefsPos({ left: left + "px", top: top + "px", up });
    setDefsOpen(true);
  };
  // 延迟关闭：鼠标从图标移向 tooltip（中间空隙）时不关闭；进入 tooltip 后由 keepDefsOpen 取消
  const delayCloseDefs = () => {
    clearTimeout(defsTimer.current);
    defsTimer.current = setTimeout(() => setDefsOpen(false), 150);
  };
  const keepDefsOpen = () => {
    clearTimeout(defsTimer.current);
    setDefsOpen(true);
  };
  useEffect(() => () => clearTimeout(defsTimer.current), []);
  const removeAddedSubject = (name) => {
    if (!curSeg || !director) return;
    if (!Array.isArray(curSeg.additionSubject)) return;
    curSeg.additionSubject = curSeg.additionSubject.filter((x) => x !== name);
    setAddVersion((v) => v + 1);
    director.commitChanges(true);
  };

  // ---------- 视频素材条 ----------
  // 记录素材视频原始宽高（metadata 加载后），用于竖屏/横屏差异化平铺预览
  const setMaterialMeta = (id, vw, vh) => {
    setMaterials((prev) =>
      prev.map((m) => (m.id === id && (m.vw !== vw || m.vh !== vh) ? { ...m, vw, vh } : m))
    );
  };
  // 播放器弹窗里的下载：fetch 原始字节 → Blob → a[download] 触发，确保下载到的是视频
  // 文件而非 HTML 页面（直接 href 在新标签打开可能被当作 inline 播放）。
  const downloadMaterial = async (m) => {
    try {
      const res = await fetch(m.src, { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = m.label || "video.mp4";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      // 兜底：同域直开（浏览器会按 Content-Disposition 处理）
      window.open(m.src, "_blank");
    }
  };
  // 根据新选中集合维护顺序数组：保留原顺序中仍选中的 id，
  // 新加入的 id 按追加顺序排到末尾，取消选中的 id 移除。
  const recomputeSelOrder = (next, prevOrder) => {
    const out = prevOrder.filter((x) => next.has(x));
    for (const x of next) {
      if (!out.includes(x)) out.push(x);
    }
    return out;
  };

  // 点击选中素材：单击单选；Ctrl/Cmd 点击切换；Shift 点击从锚点到当前项范围选择。
  // 选中顺序（selOrder）即合并时的拼接顺序，序号显示在视频卡片左上角。
  // 新素材固定宽度沿 x 轴吸附排列（见 JSX 中 flex 布局 + 滚动容器）。
  const selectMaterial = (id, e) => {
    e.stopPropagation();
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const ids = materials.map((m) => m.id);
    const prev = new Set(selIds);
    const next = new Set(prev);
    if (shift && anchorId && prev.size > 0 && ids.includes(anchorId)) {
      // Shift 范围选择：anchorId -> id（范围外的选中保持原顺序）
      const i0 = ids.indexOf(anchorId);
      const i1 = ids.indexOf(id);
      const [a, b] = i0 < i1 ? [i0, i1] : [i1, i0];
      for (let i = a; i <= b; i++) next.add(ids[i]);
    } else if (ctrl) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else {
      // 单击：若当前已仅选中该素材，再点一次取消选中；否则单选它
      if (prev.size === 1 && prev.has(id)) { next.clear(); }
      else { next.clear(); next.add(id); }
    }
    setSelIds(next);
    setSelOrder(recomputeSelOrder(next, selOrder));
    if (!shift) setAnchorId(id);
  };

  // 删除选中的素材（Del 键 / 头部的删除按钮）
  const deleteSelectedMaterials = () => {
    if (!selIds.size) return;
    // 同步清理长按预取的文件缓存（含全局注册表），避免内存残留与误用
    for (const id of selIds) {
      materialFileCache.delete(id);
      if (window.__mrdMaterialCache) window.__mrdMaterialCache.delete(id);
    }
    if (dragReadyId && selIds.has(dragReadyId)) setDragReadyId(null);
    setMaterials((prev) => prev.filter((m) => !selIds.has(m.id)));
    setSelIds(new Set());
    setSelOrder([]);
    setAnchorId(null);
  };

  // 合并选中的素材视频：请求后端 /minimax_ref/api/h3/merge_videos，
  // 后端调用 RefMergeVideosFromPaths 合并后 send_sync 通知（status=add_material），
  // 素材条会自动追加合并结果（无需手动 setMaterials）。
  const mergeSelectedMaterials = async () => {
    if (selIds.size < 2 || mergeBusy) return;
    // 按用户选中顺序（selOrder）取素材，保证合并拼接顺序与序号一致
    const byId = new Map(materials.map((m) => [m.id, m]));
    const sel = selOrder.map((x) => byId.get(x)).filter(Boolean);
    // 兜底：selOrder 中缺失的选中素材按素材条顺序补到末尾（正常流程不会出现）
    for (const m of materials) {
      if (selIds.has(m.id) && !sel.some((s) => s.id === m.id)) sel.push(m);
    }
    if (sel.length < 2) return;
    setMergeBusy(true);
    try {
      const res = await api.fetchApi("/minimax_ref/api/h3/merge_videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paths: sel.map((m) => m.src),
          node_id: director?.node?.id,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "合并失败");
      showDragHint(`已合并 ${sel.length} 段视频，结果已加入素材条`);
    } catch (err) {
      console.error("[Transfer] 合并失败:", err);
      showDragHint(`合并失败：${err.message || "未知错误"}`);
    } finally {
      setMergeBusy(false);
    }
  };

  // 拖放上传：把本地视频文件拖入素材条，上传到后端 input 目录后追加为素材
  const handleStripDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!director) return;
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    const videoFiles = Array.from(files).filter(
      (f) => f.type.startsWith("video/") || /\.(mp4|webm|mkv|mov|m4v|flv|wmv|avi)$/i.test(f.name)
    );
    if (!videoFiles.length) return;
    const added = [];
    for (const f of videoFiles) {
      try {
        const filePath = await director._uploadVideoFile(f);
        if (!filePath) continue;
        const src = viewUrl(filePath);
        materialSeq += 1;
        added.push({ id: src + "#" + materialSeq, label: basename(filePath) || filePath, src, vw: null, vh: null });
      } catch (err) {
        console.error("[Transfer] 素材拖放上传失败:", err);
      }
    }
    if (!added.length) return;
    setMaterials((prev) => prev.concat(added));
    requestAnimationFrame(() => {
      if (stripRef.current) stripRef.current.scrollLeft = stripRef.current.scrollWidth;
    });
  };

  // ---------- 长按拖出：把素材视频以文件形式拖到其他上传框 ----------
  // 流程：pointerdown 起 ~400ms 长按 -> fetch 视频 URL 预取 Blob 并缓存为 File
  //       （卡片出现“可拖出”角标）-> 继续按住拖动，dragstart 中同步注入
  //       e.dataTransfer.items，目标上传框的 drop 事件即可在 files 里拿到该文件。
  // 已缓存时无需等待：按下后直接拖动，dragstart 同步读缓存注入，长按只是可选的就绪反馈。
  const cacheMaterialFile = async (m) => {
    if (materialFileCache.has(m.id)) return materialFileCache.get(m.id);
    try {
      let blob;
      if (m.src.startsWith("data:")) {
        blob = await (await fetch(m.src)).blob();
      } else {
        const resp = await fetch(m.src, { credentials: "include" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        blob = await resp.blob();
      }
      // File.name 必须用干净的 basename：若沿用绝对路径 label，
      // 后续 handleVideoUpload 上传时会把它整个当作文件名传到服务器。
      const file = new File([blob], basename(m.label) || "video.mp4", { type: blob.type || "video/mp4" });
      materialFileCache.set(m.id, file);
      return file;
    } catch (err) {
      console.error("[Transfer] 长按预取视频失败:", err);
      return null;
    }
  };

  const showDragHint = (msg) => {
    setDragHint(msg);
    clearTimeout(dragHintTimerRef.current);
    dragHintTimerRef.current = setTimeout(() => setDragHint(""), 3000);
  };

  const clearLongPress = () => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
  };

  const onMaterialPointerDown = (m, e) => {
    clearLongPress();
    // 记录按下位置：click 时位移超过 CLICK_MOVE_TOLERANCE 视为滑动/拖动（如横向滚动素材条），
    // 忽略该次 click，避免误取消/误改选中状态。
    downPosRef.current = { x: e.clientX, y: e.clientY };
    // 统一走 ~400ms 长按计时：fired 只在按住满 LONG_PRESS_MS 后置真，
    // 快速单击/双击不会触发，避免吞掉 click（双击打开播放器）造成冲突。
    // 已缓存时 timer 到点直接就绪（无需再 fetch）；未缓存则异步预取。
    // 已缓存的素材不必等角标：按下后直接拖动，dragstart 会同步取缓存注入。
    longPressRef.current = {
      id: m.id,
      fired: false,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        const lp = longPressRef.current;
        if (!lp || lp.id !== m.id) return;
        lp.fired = true;
        const done = (file) => {
          if (longPressRef.current && longPressRef.current.id === m.id && file) {
            setDragReadyId(m.id);
            showDragHint("已就绪：按住并拖动即可把视频拖到其他上传框");
          }
        };
        if (materialFileCache.has(m.id)) {
          done(materialFileCache.get(m.id));
        } else {
          cacheMaterialFile(m).then(done);
        }
      }, LONG_PRESS_MS),
    };
  };

  const onMaterialPointerMove = (m, e) => {
    const lp = longPressRef.current;
    if (!lp || lp.id !== m.id || lp.fired) return;
    if (
      Math.abs(e.clientX - lp.x) > DRAG_MOVE_TOLERANCE ||
      Math.abs(e.clientY - lp.y) > DRAG_MOVE_TOLERANCE
    ) {
      clearLongPress(); // 移动过多：视为直接拖动/滑动，放弃长按
    }
  };

  const onMaterialPointerEnd = (m, e) => {
    const lp = longPressRef.current;
    if (lp && lp.id === m.id) {
      if (lp.fired) suppressClickRef.current = true; // 长按松手后抑制随后的 click 选中
      clearLongPress();
    }
  };

  const onMaterialDragStart = (m, e) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("text/plain", m.src);
    // 同文档拖拽（素材条与目标上传区同在一个页面）时，Chromium 不会把
    // items.add(file) 注入的文件传输给 drop 端（dataTransfer.files / items 均读不到文件），
    // 因此额外用自定义 MIME 传素材 id，drop 端从 window.__mrdMaterialCache 取回 File。
    e.dataTransfer.setData("application/x-mrd-material", m.id);
    const file = materialFileCache.get(m.id);
    if (file) {
      window.__mrdMaterialCache = window.__mrdMaterialCache || new Map();
      window.__mrdMaterialCache.set(m.id, file);
      // 跨窗口/跨页面拖拽（把素材拖出浏览器再拖回来）时 items.add 会被传输，
      // 目标端 files 可直接读到；同文档场景则走上面的自定义类型兜底。
      try { e.dataTransfer.items.add(file); } catch (err) { /* 不支持则忽略 */ }
      try {
        e.dataTransfer.setData(
          "DownloadURL", (file.type || "video/mp4") + ":" + (m.label || "video.mp4") + ":" + m.src
        );
      } catch (err) { /* 忽略 */ }
    } else if (longPressRef.current && longPressRef.current.id === m.id && longPressRef.current.fired) {
      showDragHint("正在预取视频，请稍候再拖动");
    } else {
      showDragHint("请先长按素材约 0.4 秒，出现“可拖出”角标后再拖动");
    }
  };

  const onMaterialDragEnd = (m, e) => {
    setDragReadyId(null);
  };

  // ---------- 渲染 ----------
  // 主体定义 / retention_analysis（来自后端 /h3/build_subject_bindings 的 debounce 结果）
  const bindings = bindData || {};
  const bindParts = [];
  if (bindings.subject_definitions) bindParts.push("subject_definitions:\n" + bindings.subject_definitions);
  if (bindings.retention_analysis) bindParts.push("retention_analysis:\n" + bindings.retention_analysis);
  const bindingsText = bindParts.join("\n\n");

  return html`
    <div class="tr-panel" style=${S.panel}>
      <div style=${S.buttons}>
        <button
          class="mrd-pr-btn"
          title="编辑 Segment Prompt / Minimax H3 Prompt / 添加主体"
          onClick=${() => setEditorOpen(true)}
        >✎ Prompt & Subjects</button>
        ${
          curSeg && curSeg.type !== "audio"
            ? html`
                ${
                  curSeg.type === "text" || curSeg.type === "image" || curSeg.type === "video"
                    ? html`<button
                        class=${motionCtxOn ? "mrd-pr-btn toggle-on" : "mrd-pr-btn"}
                        title="Toggle Auto First Frame for the selected segment"
                        onClick=${toggleMotionContext}
                      >Auto First Frame</button>`
                    : null
                }
                ${
                  curSeg.type !== "audio"
                    ? html`<button
                        class=${autoEndOn ? "mrd-pr-btn toggle-on" : "mrd-pr-btn"}
                        title="Toggle Auto End Frame for the selected segment"
                        onClick=${toggleAutoEndFrame}
                      >Auto End Frame</button>`
                    : null
                }`
            : null
        }
      </div>

      ${
        busy
          ? html`<div style=${S.status}>生成中…</div>`
          : error
            ? html`<div style=${S.error}>${error}</div>`
            : html`<div style=${S.status}></div>`
      }

      <div class="tr-resources" style=${S.resources}>
        <div style=${S.resourcesList}>
          ${
            resources.length === 0
              ? html`<div style=${S.hint}>资源引用（主体 / 手动添加主体）会显示在这里</div>`
              : resources.map(r => {
                  const hasImg = !!r.src;
                  const isAudio = !hasImg || !!r.audio;
                  return html`
                  <div style=${S.res} key=${r.key}>
                    ${
                      hasImg
                        ? html`<img style=${S.img} src=${r.src} alt=${r.label} />`
                        : html`<span style=${S.resAudio} title="音频主体">♪</span>`
                    }
                    ${
                      r.kind === "addition"
                        ? html`<span style=${{ display: "inline-flex", alignItems: "center", gap: "3px", maxWidth: "64px", overflow: "hidden", whiteSpace: "nowrap" }}>
                            <span style=${isAudio ? S.audioIcon : Object.assign({}, S.label, { color: "#a5d6a7" })}>${isAudio ? "♪ " : "＋"}${r.label}</span>
                            <span title="移除" style=${{ cursor: "pointer", color: "#ef5350", lineHeight: 1 }} onClick=${() => removeAddedSubject(r.label)}>×</span>
                          </span>`
                        : (isAudio
                            ? html`<span style=${S.audioIcon}>♪ ${r.label}</span>`
                            : html`<span style=${S.label}>${r.label}</span>`)
                    }
                  </div>
                `;
                })
          }
        </div>
        <div
          class="tr-h3-preview"
          style=${S.h3PreviewWrap}
          title="点击打开 Prompt & Subjects 编辑器"
          onClick=${() => setEditorOpen(true)}
          onMouseDown=${(e) => e.preventDefault()}
        >
          <div style="display:flex;align-items:center">
            <div style=${S.h3PreviewLabel}>Minimax H3 Prompt</div>
            <div
              class="tr-defs"
              style=${S.defsWrap}
              onMouseEnter=${openDefsTip}
              onMouseMove=${openDefsTip}
              onMouseLeave=${delayCloseDefs}
            >
              <span style=${S.defsIcon}>ℹ</span>
              ${
                defsOpen && defsPos
                  ? html`<div
                      class="tr-defs-tip"
                      style=${Object.assign({}, S.defsTip, { left: defsPos.left, top: defsPos.top }, defsPos.up ? { transform: "translateY(-100%)" } : null)}
                      onMouseEnter=${keepDefsOpen}
                      onMouseLeave=${delayCloseDefs}
                    >
                      ${
                        bindingsText
                          ? html`<div style=${{ whiteSpace: "pre-wrap" }}>${bindingsText}</div>`
                          : html`<div style=${S.defsTipEmpty}>暂无主体定义</div>`
                      }
                    </div>`
                  : null
              }
            </div>
          </div>
          <textarea
            class="mrd-h3-preview-area"
            style=${S.h3PreviewArea}
            value=${rightText}
            readOnly
            spellcheck=${false}
          ></textarea>
        </div>
      </div>

      <div class="tr-materials" style=${S.materialsWrap}>
        <div style=${S.materialsHead}>
          <span style=${S.materialsTitle}>视频素材</span>
          ${
            selIds.size
              ? html`<span style=${S.materialsSel}>已选 ${selIds.size} 项</span>`
              : null
          }
          ${
            selIds.size >= 2
              ? html`<button
                  class="mrd-pr-btn"
                  style=${S.materialsMergeBtn}
                  disabled=${mergeBusy}
                  onClick=${mergeSelectedMaterials}
                  onMouseDown=${(e) => e.preventDefault()}
                >${mergeBusy ? "合并中…" : "合并"}</button>`
              : null
          }
          ${
            selIds.size
              ? html`<button
                  class="mrd-pr-btn"
                  style=${S.materialsDelBtn}
                  onClick=${deleteSelectedMaterials}
                  onMouseDown=${(e) => e.preventDefault()}
                >删除</button>`
              : null
          }
        </div>
        <div
          class="tr-materials-strip"
          ref=${stripRef}
          style=${S.materialsStrip}
          tabindex=${0}
          onKeyDown=${(e) => { if (e.key === "Delete") { e.preventDefault(); deleteSelectedMaterials(); } }}
          onPointerDown=${(e) => {
            if (e.target === e.currentTarget) {
              stripDownPosRef.current = { x: e.clientX, y: e.clientY };
            }
          }}
          onPointerUp=${(e) => {
            const p = stripDownPosRef.current;
            if (p) {
              stripDownPosRef.current = null;
              if (
                e.target === e.currentTarget &&
                Math.abs(e.clientX - p.x) <= CLICK_MOVE_TOLERANCE &&
                Math.abs(e.clientY - p.y) <= CLICK_MOVE_TOLERANCE
              ) {
                setSelIds(new Set());
                setSelOrder([]);
                setAnchorId(null);
              }
            }
          }}
          onDragOver=${(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop=${(e) => handleStripDrop(e)}
        >
          ${
            materials.length === 0
              ? html`<div style=${S.hint}>运行 MiniMaxRefGuide 后，各段生成的视频（prev_tail）会显示在这里</div>`
              : materials.map((m) => {
                  const sel = selIds.has(m.id);
                  const orderNum = selOrder.indexOf(m.id) + 1; // 合并序号：0 表示未选中
                  const metaKnown = m.vw > 0 && m.vh > 0;
                  const isPortrait = metaKnown && m.vh > m.vw; // 竖屏（9:16 等）→ 重复平铺
                  const updateMeta = (e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth > 0 && (m.vw !== v.videoWidth || m.vh !== v.videoHeight)) {
                      setMaterialMeta(m.id, v.videoWidth, v.videoHeight);
                    }
                  };
                  const playAll = (e) => {
                    e.currentTarget.querySelectorAll("video").forEach((v) => v.play().catch(() => {}));
                  };
                  const stopAll = (e) => {
                    e.currentTarget.querySelectorAll("video").forEach((v) => { v.pause(); v.currentTime = 0; });
                  };
                  let preview;
                  if (isPortrait) {
                    // 竖屏视频：按原比例缩到区域高度 101px，横向重复铺满 180px 宽
                    const perW = Math.max(20, Math.round((101 * m.vw) / m.vh));
                    const count = Math.max(2, Math.ceil(180 / perW));
                    preview = html`<div style=${S.materialTiles}>
                      ${Array.from({ length: count }, (_, i) => html`<video
                        key=${m.id + "_" + i}
                        src=${m.src}
                        muted=${i > 0}
                        preload="metadata"
                        playsinline
                        draggable="false"
                        style=${Object.assign({}, S.materialTileVid, { width: perW + "px" })}
                        onLoadedMetadata=${updateMeta}
                      ></video>`)}
                    </div>`;
                  } else {
                    preview = html`<video
                      src=${m.src}
                      preload="metadata"
                      playsinline
                      draggable="false"
                      style=${S.materialVideo}
                      onLoadedMetadata=${updateMeta}
                    ></video>`;
                  }
                  const dragReady = dragReadyId === m.id;
                  return html`
                    <div
                      class="tr-material${sel ? " selected" : ""}${dragReady ? " drag-ready" : ""}"
                      style=${Object.assign(
                        {},
                        S.materialCard,
                        sel ? S.materialCardSel : null,
                        dragReady ? S.materialCardReady : null
                      )}
                      key=${m.id}
                      title=${m.label + "\n长按约 0.4 秒后可把视频拖到其他文件上传框"}
                      draggable="true"
                      onClick=${(e) => {
                        // 长按松手后抑制一次 click，避免误改选中状态
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false;
                          return;
                        }
                        // 滑动/拖动（如横向滚动素材条、拖滚动条）时浏览器仍可能派发 click，
                        // 按下/松开位移超过 CLICK_MOVE_TOLERANCE 则视为滑动而非点击，忽略本次 click。
                        const dp = downPosRef.current;
                        downPosRef.current = null;
                        if (
                          dp &&
                          (Math.abs(e.clientX - dp.x) > CLICK_MOVE_TOLERANCE ||
                            Math.abs(e.clientY - dp.y) > CLICK_MOVE_TOLERANCE)
                        ) {
                          return;
                        }
                        // 双击检测用 e.detail：onClick 中 setSelIds 会触发重渲染替换卡片 DOM，
                        // 浏览器派发的 dblclick 事件会因此丢失，故不用 onDoubleClick。
                        if (e.detail >= 2) {
                          e.stopPropagation();
                          setViewer(m);
                        } else {
                          selectMaterial(m.id, e);
                        }
                      }}
                      onPointerDown=${(e) => onMaterialPointerDown(m, e)}
                      onPointerMove=${(e) => onMaterialPointerMove(m, e)}
                      onPointerUp=${(e) => onMaterialPointerEnd(m, e)}
                      onPointerLeave=${(e) => onMaterialPointerEnd(m, e)}
                      onPointerCancel=${(e) => onMaterialPointerEnd(m, e)}
                      onDragStart=${(e) => onMaterialDragStart(m, e)}
                      onDragEnd=${(e) => onMaterialDragEnd(m, e)}
                      onMouseEnter=${playAll}
                      onMouseLeave=${stopAll}
                    >
                      ${orderNum > 0 ? html`<span style=${S.materialOrderBadge}>${orderNum}</span>` : null}
                      ${dragReady ? html`<span style=${S.materialReadyBadge}>可拖出</span>` : null}
                      ${preview}
                      <span style=${S.materialLabel}>${m.label}</span>
                    </div>
                  `;
                })
          }
        </div>
      </div>

      ${dragHint ? html`<div style=${S.dragHint}>${dragHint}</div>` : null}

      ${
        viewer
          ? html`
            <div class="tr-viewer-overlay" style=${S.viewerOverlay} onClick=${(e) => { if (e.target === e.currentTarget) setViewer(null); }}>
              <div class="tr-viewer-box" style=${S.viewerBox}>
                <div style=${S.viewerHead}>
                  <span style=${S.viewerTitle} title=${viewer.label}>${viewer.label}</span>
                  <button class="mrd-pr-btn" style=${S.viewerBtn} title="下载视频" onClick=${() => downloadMaterial(viewer)}>下载</button>
                  <button class="mrd-pr-btn" style=${S.viewerBtn} title="在新标签页打开" onClick=${() => window.open(viewer.src, "_blank")}>打开</button>
                  <button class="mrd-pr-btn" style=${S.viewerBtn} title="关闭 (Esc)" onClick=${() => setViewer(null)}>关闭</button>
                </div>
                <video src=${viewer.src} controls autoplay playsinline style=${S.viewerVideo}></video>
              </div>
            </div>
          `
          : null
      }

      ${
        menu
          ? html`
            <div class="ref-ms-mention-popup open" style=${{ left: menu.x + "px", top: menu.y + "px", zIndex: 100000 }}>
              ${
                subjects.length === 0
                  ? html`<div class="ref-ms-mention-empty">暂无可用主体（请先在主体节点中添加）</div>`
                  : subjects.map(h => html`
                      <div
                        class="ref-ms-mention-item"
                        key=${h.name}
                        onMouseDown=${(e) => e.preventDefault()}
                        onClick=${() => pickSubject(h)}
                        title="插入 ${menu.trigger === "@" ? `<@${h.name}>` : `<#${h.name}:对话内容>`}"
                      >
                        ${subjectMediaThumb(h, 22)}
                        <span class="ref-ms-mention-type">${h.type || "Subject"}</span>
                        <span>${h.name}</span>
                      </div>
                    `)
              }
            </div>
          `
          : null
      }

      <${RefModal}
        open=${editorOpen}
        title="Segment Prompt / H3 Prompt / 添加主体"
        width="1500px"
        height="720px"
        onClose=${() => { setEditorOpen(false); setMenu(null); }}
        help=${bindingsText || "暂无主体定义"}
      >
        <div style=${{ display: "flex", gap: "6px", flex: "1 1 0", minHeight: "0", alignItems: "stretch" }}>
          <div class="mrd-pr-prompt-wrapper" style=${S.col}>
            <div class="mrd-pr-prompt-label" style=${S.refTextareaLabel}>Segment Prompt</div>
            <textarea
              ref=${leftRef}
              class="mrd-pr-prompt-area"
              style=${S.refTextarea}
              value=${leftText}
              placeholder="原始 prompt（输入 @ 引用主体）"
              spellcheck=${false}
              onInput=${(e) => { setLeftText(e.target.value); handleInput(e, "left"); }}
            ></textarea>
          </div>
          <div style=${{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: "22px", flex: "0 0 auto" }}>
            <button
              class="mrd-pr-btn"
              title="以左侧为源生成 H3 Prompt，结果展示在右侧"
              disabled=${busy}
              onClick=${() => runGenerate(leftText)}
            >→</button>
          </div>
          <div class="mrd-pr-prompt-wrapper" style=${S.col}>
            <div class="mrd-pr-prompt-label" style=${S.refTextareaLabel}>
              Minimax H3 Prompt
            </div>
            <textarea
              ref=${rightRef}
              class="mrd-pr-prompt-area"
              style=${S.refTextarea}
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
        <div style=${{ borderTop: "1px solid #333", marginTop: "8px", paddingTop: "6px", display: "flex", flexDirection: "column", gap: "4px" }}>
          <div style=${{ fontSize: "10px", fontWeight: "bold", color: "#888", textTransform: "uppercase", letterSpacing: "0.5px", margin: "0 0 2px 2px" }}>添加主体（additionSubject）</div>
          <div style=${{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
            ${
              visibleAdded.length === 0 && addCandidates.length === 0
                ? html`<div style=${{ color: "#888", fontSize: "12px", padding: "2px" }}>没有可添加的主体（未提及的主体均已添加）</div>`
                : html`
                    ${
                      visibleAdded.map(n => {
                        const h = subjects.find(x => x.name === n);
                        return html`
                        <span
                          style=${{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#1e3a5f", color: "#a5d6a7", border: "1px solid #2b4a6f", borderRadius: "10px", padding: "2px 8px 2px 2px", fontSize: "12px" }}
                          key=${"added-" + n}
                          title=${h ? "已添加主体：" + n : n}
                        >${h ? subjectMediaThumb(h, 44) : null}<span>＋${n}</span><span
                            title="移除"
                            style=${{ cursor: "pointer", color: "#ef5350", lineHeight: 1 }}
                            onClick=${() => removeAddedSubject(n)}
                          >×</span></span>`;
                      })
                    }
                    ${
                      addCandidates.map(h => html`
                        <button
                          class="mrd-pr-btn"
                          style=${{ display: "flex", alignItems: "center", gap: "8px", textAlign: "left", padding: "4px 10px", fontSize: "12px" }}
                          key=${"addc-" + h.name}
                          onClick=${() => addSubject(h.name)}
                        >${subjectMediaThumb(h, 44)}<span>@ ${h.name}</span></button>
                      `)
                    }
                  `
            }
          </div>
        </div>
      </${RefModal}>
    </div>
  `;
}

// ---------- 全局参数分组（渲染在 .mrd-pr-wrapper 中 .mrd-pr-toolbar 之上） ----------

export function GlobalParamsPanel({ director }) {
  // 根据 display_mode 决定 Start/End/Duration 使用秒还是帧单位
  const getMode = () => (director?.displayModeWidget?.value === "frames" ? "frames" : "seconds");
  // 从 director 节点 widget 读取全局参数当前值（与节点真实状态保持一致）
  const readGlobal = () => {
    const val = (name, fb) =>
      director?.node?.widgets?.find(w => w.name === name)?.value ?? fb;
    const gp = {};
    for (const def of TIME_PARAM_DEFS[getMode()] || TIME_PARAM_DEFS.seconds) {
      gp[def.name] = val(def.name, def.fallback);
    }
    for (const def of OTHER_GLOBAL_DEFS) {
      gp[def.name] = val(def.name, def.fallback);
    }
    return gp;
  };
  const [gp, setGp] = useState(readGlobal);
  const mode = getMode();
  const defs = [...(TIME_PARAM_DEFS[mode] || TIME_PARAM_DEFS.seconds), ...OTHER_GLOBAL_DEFS];

  // 监听全局参数变化刷新面板：
  // - display_mode 切换（director.js displayModeWidget callback -> _onDisplayModeChange）
  // - start/end/duration/frame_rate 联动更新（director.js 各全局 widget callback -> _onGlobalChange）
  useEffect(() => {
    director._onDisplayModeChange = () => setGp(readGlobal());
    director._onGlobalChange = () => setGp(readGlobal());
    return () => {
      if (director._onDisplayModeChange) director._onDisplayModeChange = null;
      if (director._onGlobalChange) director._onGlobalChange = null;
    };
  }, [director]);

  // 写入全局参数 widget 值并触发其 callback（director 的帧/秒联动逻辑），随后刷新本地 state
  const setGlobal = (name, value) => {
    const wd = director?.node?.widgets?.find(w => w.name === name);
    if (wd) {
      wd.value = value;
      if (typeof wd.callback === "function") wd.callback(value);
    }
    setGp(readGlobal());
  };

  return html`
    <div class="tr-gp">
      <div class="tr-gp-head">全局参数</div>
      <div class="tr-gp-grid">
        ${
          defs.map(def => html`
            <label class="tr-gp-item" key=${def.name}>
              <span class="tr-gp-label">${def.label}</span>
              ${
                def.type === "select"
                  ? html`<select
                      class="tr-gp-select"
                      value=${gp[def.name]}
                      onChange=${(e) => setGlobal(def.name, e.target.value)}
                    >${def.options.map(o => html`<option value=${o}>${o}</option>`)}</select>`
                  : html`<${NumInput}
                      def=${def}
                      value=${gp[def.name]}
                      onCommit=${setGlobal}
                    />`
              }
            </label>
          `)
        }
      </div>
      <div class="tr-gap-hr"></div>
    </div>
  `;
}

// ---------- 挂载辅助 ----------

export function mountTransfer(director, container) {
  return render(h(TransferPanel, { director }), container);
}
