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

// 下拉菜单里的媒体缩略图：图片/视频显示资源，音频用图标占位
// size：缩略图边长（px），默认 22（mention 菜单）；弹窗"添加主体"列表放大一倍用 44
function subjectMediaThumb(s, size = 22) {
  const p = subjectMediaPreview(s);
  const base = { width: size + "px", height: size + "px", borderRadius: "3px", flex: "0 0 auto", objectFit: "cover" };
  if (p.kind === "image") return html`<img src=${p.src} alt="" style=${base} />`;
  if (p.kind === "video") return html`<video src=${p.src} muted preload="metadata" style=${Object.assign({}, base, { background: "#000" })} />`;
  if (p.kind === "audio") return html`<span title="音频" style=${{ width: size + "px", height: size + "px", borderRadius: "3px", flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#1e3a5f", color: "#38bdf8", fontSize: Math.round(size * 0.5) + "px", fontStyle: "normal" }}>♪</span>`;
  return null;
}

// 从 H3 prompt 文本提取 <@name> / <#name:dialogue> 提及
function extractH3Mentions(text) {
  const names = new Set();
  const dialogues = new Set();
  const nameRe = /<@([^>]+)>/g;
  const diaRe = /<#([^>:]+):/g;
  let m;
  while ((m = nameRe.exec(text || ""))) {
    const n = m[1].trim();
    if (n) names.add(n);
  }
  while ((m = diaRe.exec(text || ""))) {
    const n = m[1].trim();
    if (n) dialogues.add(n);
  }
  return { names, dialogues };
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

// ---------- 样式 ----------
const S = {
  panel: {
    boxSizing: "border-box", width: "100%", height: "100%",
    display: "flex", flexDirection: "column", gap: "4px",
    fontFamily: "inherit",
  },
  area: {
    flex: 1, resize: "none", boxSizing: "border-box", width: "100%", minHeight: 0,
    background: "#1e1e1e", color: "#ccc", border: "1px solid #444", borderRadius: "4px",
    padding: "6px", fontFamily: "monospace", fontSize: "12px", lineHeight: "1.5", outline: "none",
  },
  col: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  buttons: { display: "flex", gap: "6px", padding: "4px 0" },
  resources: {
    display: "flex", flexDirection: "row", flexWrap: "nowrap", overflowX: "auto",
    gap: "8px", padding: "4px 0", minHeight: "450px", alignItems: "flex-start",
    borderTop: "1px solid #333", scrollbarWidth: "thin",
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
  audioIcon: { fontSize: "10px", color: "#ffb74d" },
  resAudio: {
    width: "48px", height: "48px", borderRadius: "4px", background: "#1e3a5f",
    color: "#38bdf8", display: "inline-flex", alignItems: "center", justifyContent: "center",
    fontSize: "16px", flex: "0 0 auto",
  },
  defsWrap: {
    position: "relative", flex: "0 0 auto", display: "flex", alignItems: "center",
    alignSelf: "flex-start", padding: "6px 4px", cursor: "help",
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
    paddingLeft: "8px", minHeight: "450px", cursor: "pointer",
  },
  h3PreviewLabel: {
    fontSize: "10px", color: "#888", textTransform: "uppercase", letterSpacing: "0.5px",
    padding: "0 0 2px", userSelect: "none", whiteSpace: "nowrap",
  },
  h3PreviewArea: {
    flex: "1 1 0", minHeight: "0", width: "100%", boxSizing: "border-box",
    background: "rgba(30,30,30,.55)", color: "#9e9e9e", border: "1px dashed #444",
    borderRadius: "4px", padding: "4px 6px", fontFamily: "monospace", fontSize: "10px",
    lineHeight: "1.4", resize: "none", outline: "none", cursor: "pointer",
    overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-wrap",
  },
  refTextarea: { position: "static", flex: "1 1 0", minHeight: "0", height: "100%", width: "100%", boxSizing: "border-box", background: "#1e1e1e", border: "none", resize: "none", outline: "none", padding: "4px 8px 8px", color: "#e0e0e0", fontSize: "12px", lineHeight: "1.4", fontFamily: "monospace" },
  refTextareaLabel: { position: "static", flexShrink: 0, margin: "6px 0 2px 8px" },
};

// ---------- 全局参数 ----------

const RESOLUTION_OPTIONS = ["1:1方形", "9:16竖屏", "16:9横屏", "3:2横屏", "2:3竖屏", "4:3横屏", "3:4竖屏", "21:9超宽"];

// 全局参数 widget 名（已加入 HIDDEN_WIDGET_NAMES 在节点上隐藏，改由本面板 inline 编辑）
// Start/End/Duration 按 display_mode 动态切换单位：
//   seconds -> start_second/end_second/duration_seconds（Start(s)/End(s)/Duration(s)）
//   frames  -> start_frame/end_frame/duration_frames（Start(f)/End(f)/Duration(f)）
const TIME_PARAM_DEFS = {
  seconds: [
    { name: "start_second", label: "Start(s)", type: "number", fallback: 0, min: 0, max: 1000, step: 0.01 },
    { name: "end_second", label: "End(s)", type: "number", fallback: 5, min: 0, max: 1000, step: 0.01 },
    { name: "duration_seconds", label: "Duration(s)", type: "number", fallback: 5, min: 0.1, max: 1000, step: 0.01 },
  ],
  frames: [
    { name: "start_frame", label: "Start(f)", type: "number", fallback: 0, min: 0, max: 100000, step: 1 },
    { name: "end_frame", label: "End(f)", type: "number", fallback: 120, min: 1, max: 100000, step: 1 },
    { name: "duration_frames", label: "Duration(f)", type: "number", fallback: 120, min: 1, max: 100000, step: 1 },
  ],
};

const OTHER_GLOBAL_DEFS = [
  { name: "frame_rate", label: "FPS", type: "number", fallback: 24, min: 1, max: 240, step: 1 },
  { name: "outpu_resolution", label: "Resolution", type: "select", fallback: "16:9横屏", options: RESOLUTION_OPTIONS },
  { name: "million_pixels", label: "Million Pixels", type: "number", fallback: 0.6, min: 0.1, max: 4, step: 0.1 },
];

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
  const [imageVersion, setImageVersion] = useState(0); // 首帧/尾帧图回写计数（驱动资源条预览刷新）

  const leftRef = useRef(null);
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
  }, [rightText, subjects, addVersion, imageVersion]);

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
      const body = {
        subject_data: { subjects: subjects || [] },
        raw_prompt: rightText,
        last_frame_path: lastFramePath(),
        timeline_segment: seg
          ? {
              type: seg.type,
              start: seg.start,
              videoFile: seg.videoFile || "",
              audioFile: seg.audioFile || "",
              additionSubject: Array.isArray(seg.additionSubject) ? seg.additionSubject : [],
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
    return srcOf((segs?.[director.selectedIndex] || null));
  };
  const lastFramePath = () => {
    const segs = director?.timeline?.segments || [];
    return srcOf((segs?.[director.selectedIndex+1] || null));
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
    const cb = getFixedCb(el);
    const cbRect = cb ? cb.getBoundingClientRect() : { left: 0, top: 0 };
    const vw = cb ? cbRect.width : window.innerWidth;
    const x = Math.max(4, Math.min(rect.left + col * charW - cbRect.left, vw - 200));
    const y = rect.top + (line + 1) * lineHeight + 6 - cbRect.top;
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

  function parseResources(text, subjectsList) {
    const out = [];
    const first = firstFramePath();
    const last = lastFramePath();
    if (first) out.push({ key: "first", label: "首帧", src: first });
    if (last) out.push({ key: "last", label: "尾帧", src: last });
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
  // 候选主体：未在右侧 prompt 中提及、且尚未添加的主体
  const mentionNames = (() => {
    const m = extractH3Mentions(rightText);
    return new Set([...m.names, ...m.dialogues]);
  })();
  const addedNames = Array.isArray(curSeg?.additionSubject) ? curSeg.additionSubject : [];
  const addCandidates = subjects.filter((s) => !mentionNames.has(s.name) && !addedNames.includes(s.name));
  const addSubject = (name) => {
    if (!curSeg || !director) return;
    if (!Array.isArray(curSeg.additionSubject)) curSeg.additionSubject = [];
    if (curSeg.additionSubject.includes(name)) return;
    curSeg.additionSubject.push(name);
    setAddVersion((v) => v + 1);
    director.commitChanges(true);
  };
  // 信息图标 tooltip：fixed 定位避免被 .tr-resources 的 overflow 裁剪；按视口空间决定向上/向下弹出
  const openDefsTip = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const up = rect.top > window.innerHeight * 0.55;
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - 300));
    const top = up ? rect.top - 6 : rect.bottom + 6;
    setDefsPos({ left: left + "px", top: top + "px", up });
    setDefsOpen(true);
  };
  const removeAddedSubject = (name) => {
    if (!curSeg || !director) return;
    if (!Array.isArray(curSeg.additionSubject)) return;
    curSeg.additionSubject = curSeg.additionSubject.filter((x) => x !== name);
    setAddVersion((v) => v + 1);
    director.commitChanges(true);
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
                        title="Toggle Motion Context for the selected segment"
                        onClick=${toggleMotionContext}
                      >Motion Context</button>`
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
        ${
          resources.length === 0
            ? html`<div style=${S.hint}>资源引用（首帧 / 尾帧 / 主体 / 手动添加主体）会显示在这里</div>`
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
        <div
          class="tr-h3-preview"
          style=${S.h3PreviewWrap}
          title="点击打开 Prompt & Subjects 编辑器"
          onClick=${() => setEditorOpen(true)}
          onMouseDown=${(e) => e.preventDefault()}
        >
          <span style=${S.h3PreviewLabel}>Minimax H3 Prompt</span>
          <textarea
            class="mrd-h3-preview-area"
            style=${S.h3PreviewArea}
            value=${rightText}
            readOnly
            spellcheck=${false}
          ></textarea>
        </div>
        <div
          class="tr-defs"
          style=${S.defsWrap}
          onMouseEnter=${openDefsTip}
          onMouseLeave=${() => setDefsOpen(false)}
        >
          <span style=${S.defsIcon}>ℹ</span>
          ${
            defsOpen && defsPos
              ? html`<div
                  style=${Object.assign({}, S.defsTip, { left: defsPos.left, top: defsPos.top }, defsPos.up ? { transform: "translateY(-100%)" } : null)}
                  onMouseEnter=${() => setDefsOpen(true)}
                  onMouseLeave=${() => setDefsOpen(false)}
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

      ${
        menu
          ? html`
            <div class="tr-menu" style=${Object.assign({}, S.menu, { left: menu.x + "px", top: menu.y + "px" })}>
              ${
                subjects.length === 0
                  ? html`<div style=${{ padding: "6px 10px", color: "#888", fontSize: "12px" }}>没有可用主体（请先在主体节点中添加）</div>`
                  : subjects.map(h => html`
                      <button
                        class="mrd-pr-btn"
                        style=${Object.assign({}, S.trBtn, { display: "flex", alignItems: "center", gap: "6px", textAlign: "left", padding: "3px 6px" })}
                        key=${h.name}
                        onMouseDown=${(e) => e.preventDefault()}
                        onClick=${() => pickSubject(h)}
                      >${subjectMediaThumb(h)}<span>${h.name}</span></button>
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

        <div style=${{ borderTop: "1px solid #333", marginTop: "8px", paddingTop: "6px", display: "flex", flexDirection: "column", gap: "4px" }}>
          <div style=${{ fontSize: "10px", fontWeight: "bold", color: "#888", textTransform: "uppercase", letterSpacing: "0.5px", margin: "0 0 2px 2px" }}>添加主体（additionSubject）</div>
          <div style=${{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
            ${
              addedNames.length === 0 && addCandidates.length === 0
                ? html`<div style=${{ color: "#888", fontSize: "12px", padding: "2px" }}>没有可添加的主体（未提及的主体均已添加）</div>`
                : html`
                    ${
                      addedNames.map(n => {
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

  // 监听 display_mode 变化刷新面板（由 director.js 的 displayModeWidget callback 触发）
  useEffect(() => {
    director._onDisplayModeChange = () => setGp(readGlobal());
    return () => {
      if (director._onDisplayModeChange) director._onDisplayModeChange = null;
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
                  : html`<input
                      class="tr-gp-input"
                      type="number"
                      min=${def.min}
                      max=${def.max}
                      step=${def.step}
                      value=${gp[def.name]}
                      onInput=${(e) => setGlobal(def.name, parseFloat(e.target.value) || def.fallback)}
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
