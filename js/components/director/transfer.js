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

// ---------- 主体定义 / 音频定义 / retention_analysis ----------
// 与 lib/prompt.py build_h3_subject_bindings 保持一致（前端版），
// 供 .tr-resources 信息图标 hover 展示。
const H3_TYPES_LIST = ["Subject", "Picture", "Video", "Audio"];
const VISUAL_RELATIONS_LIST = ["fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"];
const AUDIO_RELATIONS_LIST = ["fully_copy", "partially_copy", "reference", "weak_reference"];
const AUDIO_RELATION_TEXT = {
  fully_copy: "<Audio {n}> is reused 1:1 as the target video's complete final audio track.",
  partially_copy: "Only part of the timeline or selected audio layers of <Audio {n}> are copied.",
  reference: "the target speaker follows <Audio {n}>'s voice timbre and measured delivery without copying the original signal.",
  weak_reference: "Only broad similarity in category or atmosphere from <Audio {n}> is retained.",
};

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

// 参考 lib/prompt.py build_h3_subject_bindings：
// 返回 { subject_definition, audio_definition, retention_analysis,
//        pictures, audios, videos }（后三者按 <… N> 编号排序，含 label + src）
function buildSubjectBindings(text, subjectsList, dir) {
  const { names, dialogues } = extractH3Mentions(text);
  const bound = [];
  let subjectCounter = 0;
  let pictureCounter = 0;
  let audioCounter = 0;

  const pictures = []; // { label: "<Picture N>", src }
  const audios = [];   // { label: "<Audio N>", src }
  const videos = [];   // { label: "<Video N>", src }

  for (const s of subjectsList || []) {
    const name = String(s.name || "").trim();
    if (!name) continue;
    let stype = String(s.type || "").trim();
    if (!H3_TYPES_LIST.includes(stype)) stype = "Subject";
    let relationship = String(s.relationship || "").trim();
    if (!VISUAL_RELATIONS_LIST.includes(relationship)) relationship = "fully_preserved";
    let audioRelationship = String(s.audio_relationship || "").trim();
    if (!AUDIO_RELATIONS_LIST.includes(audioRelationship)) audioRelationship = "reference";

    const description = String(s.description || "").trim();
    const imageFile = String(s.imageFile || "").trim();
    const audioFile = String(s.audioFile || "").trim();
    const videoFile = String(s.videoFile || "").trim();
    const useAudio = !!audioFile;

    let label;
    let definition;
    if (stype === "Subject") {
      subjectCounter += 1;
      label = `<Subject ${subjectCounter}>`;
      let source = "";
      if (imageFile) {
        pictureCounter += 1;
        const picLabel = `<Picture ${pictureCounter}>`;
        source = ` in ${picLabel}`;
        pictures.push({ label: picLabel, src: subjectImgSrc(s) });
      }
      definition = `${label} is ${name}${source}`;
      if (description) definition += `, ${description}`;
    } else if (stype === "Picture") {
      pictureCounter += 1;
      label = `<Picture ${pictureCounter}>`;
      pictures.push({ label, src: subjectImgSrc(s) });
      definition = `${label} is ${description || name} (reference image anchor)`;
    } else if (stype === "Audio") {
      subjectCounter += 1;
      label = `<Audio ${subjectCounter}>`;
      if (audioFile) audios.push({ label, src: audioFile });
      definition = `${label} is ${description || name}`;
    } else if (stype === "Video") {
      subjectCounter += 1;
      label = `<Video ${subjectCounter}>`;
      if (videoFile) videos.push({ label, src: videoFile });
      definition = `${label} is ${description || name}`;
    } else {
      subjectCounter += 1;
      label = `<${stype} ${subjectCounter}>`;
      definition = `${label} is ${description || name}`;
    }

    let audioDefinition = null;
    let audioLabel = null;
    let audioNumber = null;
    if (useAudio) {
      audioCounter += 1;
      audioLabel = `<Audio ${audioCounter}>`;
      audioNumber = audioCounter;
      audios.push({ label: audioLabel, src: audioFile });
      audioDefinition = `${audioLabel} is the voice-timbre reference for ${label}`;
    }

    bound.push({
      label,
      name,
      relationship,
      audioRelationship,
      subject_definition: definition,
      audio_definition: audioDefinition,
      audio_label: audioLabel,
      audio_number: audioNumber,
      matched: names.has(name),
      has_dialogue: dialogues.has(name),
    });
  }

  const subjectLines = bound.filter((b) => b.subject_definition).map((b) => b.subject_definition);
  const audioLines = bound.filter((b) => b.audio_definition).map((b) => b.audio_definition);
  const retentionLines = [];
  for (const b of bound) {
    if (b.label) retentionLines.push(`${b.label}: ${b.relationship}`);
    if (b.audio_definition && b.audio_number) {
      const tpl = AUDIO_RELATION_TEXT[b.audioRelationship] || AUDIO_RELATION_TEXT.reference;
      retentionLines.push(
        `${b.audio_label}: ${b.audioRelationship} - ${tpl.replace("{n}", b.audio_number)}`
      );
    }
  }

  // 首帧 / 尾帧 → 独立 Picture 锚点（与 Python 端一致）
  const segs = dir?.timeline?.segments || [];
  const sorted = [...segs].sort((a, b) => (a.start || 0) - (b.start || 0));
  const srcOf = (s) => s.imgObj?.src || s.imageB64 || "";
  const first = sorted.find((s) => s.imgObj || s.imageB64);
  const last = [...sorted].reverse().find((s) => s.imgObj || s.imageB64);
  if (first) {
    pictureCounter += 1;
    const label = `<Picture ${pictureCounter}>`;
    pictures.push({ label, src: srcOf(first) });
    subjectLines.push(`${label} is the first frame of [Shot 1].`);
    retentionLines.push(`${label} ([Shot 1] first frame): fully_preserved.`);
  }
  if (last && last !== first) {
    pictureCounter += 1;
    const label = `<Picture ${pictureCounter}>`;
    pictures.push({ label, src: srcOf(last) });
    subjectLines.push(`${label} is the last frame of the target video.`);
    retentionLines.push(`${label} (last frame of the target video): fully_preserved.`);
  }

  // 从时间轴 segments 收集视频 / 音频地址（type 维度的兜底，编号续接主体绑定）
  for (const seg of sorted) {
    if (seg.type === "video" && seg.videoFile) {
      const n = videos.length + 1;
      videos.push({ label: `<Video ${n}>`, src: seg.videoFile });
    } else if (seg.type === "audio" && seg.audioFile) {
      const n = audios.length + 1;
      audios.push({ label: `<Audio ${n}>`, src: seg.audioFile });
    }
  }

  return {
    subject_definition: subjectLines.join("\n"),
    audio_definition: audioLines.join("\n"),
    retention_analysis: retentionLines.join("\n"),
    pictures,
    audios,
    videos,
  };
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
  lines.push("[Shot 1]" + plain(d.shot1_description));
  for (let i = 2; i <= 32; i++) {
    const key = "shot" + i + "_description";
    if (d[key] !== undefined && d[key] !== null && String(d[key]).trim() !== "") {
      lines.push("[Shot " + i + "]" + plain(d[key]));
    }
  }
  lines.push(plain(d.detailed_description));
  lines.push("overall_soundscape:");
  lines.push(val(d.overall_soundscape));
  lines.push("non_diegetic_music:");
  lines.push(val(d.non_diegetic_music));
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
      const m = line.match(/^\[Shot\s*(\d+)\](.*)$/);
      if (m) {
        obj["shot" + m[1] + "_description"] = m[2];
      } else {
        detailLines.push(line);
      }
    } else if (section === "overall") {
      if (line.trim() !== "" && line.trim() !== "N/A") obj.overall_soundscape = line;
    } else if (section === "music") {
      if (line.trim() !== "" && line.trim() !== "N/A") obj.non_diegetic_music = line;
    }
  }
  obj.detailed_description = detailLines.join("\n");
  return obj;
}

// 更新右侧文本中某个字段（如 shotX_description）
function updateShotField(text, key, value) {
  const obj = parsePromptText(text);
  obj[key] = value;
  return formatPromptJson(obj);
}

// 从右侧文本中删除某个字段（如 shotX_description）
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
  row: { display: "flex", gap: "6px", flex: 1, minHeight: 0 },
  area: {
    flex: 1, resize: "none", boxSizing: "border-box", width: "100%", minHeight: 0,
    background: "#1e1e1e", color: "#ccc", border: "1px solid #444", borderRadius: "4px",
    padding: "6px", fontFamily: "monospace", fontSize: "12px", lineHeight: "1.5", outline: "none",
  },
  col: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  buttons: { display: "flex", gap: "6px", padding: "4px 0" },
  actions: {
    display: "flex", flexDirection: "column", justifyContent: "center",
    alignItems: "center", cursor: "col-resize", touchAction: "none",
    userSelect: "none", borderRadius: "4px", transition: "background 0.15s",
  },
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
  audioIcon: { fontSize: "10px", color: "#ffb74d" },
  defsWrap: {
    position: "relative", flex: "0 0 auto", display: "flex", alignItems: "center",
    alignSelf: "flex-start", padding: "6px 4px", cursor: "help",
  },
  defsIcon: { fontSize: "13px", color: "#5c9dff", lineHeight: 1, userSelect: "none" },
  defsTip: {
    position: "absolute", bottom: "calc(100% + 6px)", right: "0", zIndex: 9999,
    background: "#2d2d2d", border: "1px solid #555", borderRadius: "6px",
    padding: "8px 10px", minWidth: "280px", maxWidth: "460px", maxHeight: "60vh",
    overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,.5)",
    fontSize: "11px", color: "#ccc", fontFamily: "monospace", lineHeight: "1.5",
  },
  defsTipEmpty: { color: "#888" },
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
  { name: "outpu_resolution", label: "Ratio", type: "select", fallback: "16:9横屏", options: RESOLUTION_OPTIONS },
  { name: "million_pixels", label: "MP", type: "number", fallback: 0.6, min: 0.1, max: 4, step: 0.1 },
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
  const [leftWidth, setLeftWidth] = useState(null); // 左侧宽度(px)，null 表示默认平分
  const [midHover, setMidHover] = useState(false);
  const [curSeg, setCurSeg] = useState(null); // 当前选中 segment（由 director 推送）
  const [motionCtxOn, setMotionCtxOn] = useState(false); // Motion Context 开关
  const [autoEndOn, setAutoEndOn] = useState(false); // Auto End Frame 开关
  const [defsOpen, setDefsOpen] = useState(false); // .tr-resources 信息图标 hover

  const rowRef = useRef(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const debounceRef = useRef(null);
  const aliveRef = useRef(true);
  const rightSaveFirstRun = useRef(true);

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
      // 从节点 properties 恢复已保存的右侧生成结果（随 workflow 持久化）
      const savedRight = director.node?.properties?.__rightPromptText;
      if (typeof savedRight === "string" && savedRight) setRightText(savedRight);
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

  // 右侧内容持久化：每次编辑写入节点 properties（__rightPromptText），
  // 随 workflow 的 onSerialize 一起保存，刷新后由挂载 effect 恢复。
  // 首次渲染跳过，避免用默认值覆盖已保存内容。
  useEffect(() => {
    if (rightSaveFirstRun.current) {
      rightSaveFirstRun.current = false;
      return;
    }
    if (!aliveRef.current || !director?.node) return;
    const node = director.node;
    if (node.properties.__rightPromptText !== rightText) {
      node.properties.__rightPromptText = rightText;
      // 标记画布已修改，触发 ComfyUI 自动保存 / 序列化
      if (app.graph) app.graph.setDirtyCanvas(true, true);
    }
  }, [rightText, director]);

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

  const firstFramePath = () => {
    const segs = director?.timeline?.segments || [];
    if (!segs.length) return "";
    const first = [...segs].sort((a, b) => (a.start || 0) - (b.start || 0))[0];
    return first.imageFile || first.videoFile || "";
  };

  // 当前 segment 在时间轴上的序号（第几个 shot，从 1 开始）
  const shotNumber = (seg) => {
    const segs = (director?.timeline?.segments || []).slice().sort((a, b) => (a.start || 0) - (b.start || 0));
    const idx = segs.findIndex((s) => s.id === seg.id);
    return idx >= 0 ? idx + 1 : 1;
  };

  // 生成首帧：调用后端 /h3/generate_first_frame（后端接口待实现，先写好前端调用）
  // 成功后：将节点转为图片节点并更新 imageFile
  async function generateFirstFrame(seg) {
    if (!seg || busy || !director) return;
    setBusy(true);
    setError("");
    try {
      const body = vlmBody({
        segment_id: seg.id,
        prompt: seg.prompt || "",
        image_path: seg.imageFile || seg.imageB64 || "",
      });
      const res = await api.fetchApi("/minimax_ref/api/h3/generate_first_frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      console.log("[Transfer] generate_first_frame ->", data);
      if (data && data.success) {
        // 将节点转图片节点并更新 imageFile
        seg.type = "image";
        seg.imageFile = data.image_file || data.imageFile || data.image_path || "";
        director.commitChanges();
        if (director._transferSetSeg) director._transferSetSeg(seg);
      } else {
        setError((data && data.error) || "生成首帧失败");
      }
    } catch (e) {
      console.error("[Transfer] generateFirstFrame failed:", e);
      setError(String(e?.message || e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  // ---------- 组装并提交 /llm/generate_first_frame ----------
  // 生成 payload：
  //   prompt   = subject_definitions(subject_definition + audio_definition)
  //            + retention_analysis + detailed_description + overall_soundscape
  //            + non_diegetic_music
  //   images   = 按 <Subject/Picture x> 排序的图片地址（含首帧 / 尾帧）
  //   audios   = 按 <Audio x> 排序的音频地址
  //   videos   = 按 <Video x> 排序的视频地址
  //   segment_data + 全局参数（start/end/frame_rate/resolution 等）
  function buildFirstFramePayload(extra) {
    // 1) subject_definitions + retention_analysis（与后端 build_h3_subject_bindings 一致）
    const bind = buildSubjectBindings(rightText, subjects, director);
    const subjectDefs = [bind.subject_definition, bind.audio_definition].filter(Boolean).join("\n");

    // 2) detailed_description / overall_soundscape / non_diegetic_music
    const pd = parsePromptText(rightText);
    const detail = String(pd.detailed_description || "").trim();
    const soundscape = String(pd.overall_soundscape || "").trim();
    const music = String(pd.non_diegetic_music || "").trim();

    // 3) prompt = subject_definitions + retention_analysis + detailed + soundscape + music
    const promptParts = [
      subjectDefs,
      bind.retention_analysis,
      detail ? "detailed_description:\n" + detail : "",
      soundscape ? "overall_soundscape:\n" + soundscape : "",
      music ? "non_diegetic_music:\n" + music : "",
    ].filter(Boolean);
    const prompt = promptParts.join("\n\n");

    // 4) images / audios / videos（去重，按编号顺序）
    const imgSeen = new Set();
    const images = (bind.pictures || [])
      .map((p) => p.src)
      .filter((src) => {
        if (!src || imgSeen.has(src)) return false;
        imgSeen.add(src);
        return true;
      });
    const audios = (bind.audios || []).map((a) => a.src).filter((src) => !!src);
    const videos = (bind.videos || []).map((v) => v.src).filter((src) => !!src);

    // 5) segment_data：时间轴 segments（按 start 排序）
    const segs = (director?.timeline?.segments || [])
      .slice()
      .sort((a, b) => (a.start || 0) - (b.start || 0))
      .map((s) => ({
        id: s.id,
        type: s.type,
        start: s.start,
        length: s.length,
        prompt: s.prompt || "",
        imageFile: s.imageFile || "",
        videoFile: s.videoFile || "",
        audioFile: s.audioFile || "",
        motionContext: !!s.motionContext,
        autoEndFrame: !!s.autoEndFrame,
        isEndFrame: !!s.isEndFrame,
      }));

    // 6) 全局参数（与 director.py widget 同名）
    const segment_data = {
      segments: segs,
      start_second: wVal("start_second"),
      end_second: wVal("end_second"),
      duration_seconds: wVal("duration_seconds"),
      start_frame: wVal("start_frame"),
      end_frame: wVal("end_frame"),
      duration_frames: wVal("duration_frames"),
      frame_rate: wVal("frame_rate"),
      display_mode: wVal("display_mode"),
      outpu_resolution: wVal("outpu_resolution"),
      million_pixels: wVal("million_pixels"),
    };

    const payload = {
      prompt,
      images,
      audios,
      videos,
      segment_data,
      ...(extra || {}),
    };

    console.log("[Transfer] buildFirstFramePayload ->", {
      prompt,
      images,
      audios,
      videos,
      segment_data,
    });

    return payload;
  }

  // 将 buildFirstFramePayload 的结果提交到 /llm/generate_first_frame 接口
  async function submitGenerateFirstFrame(seg) {
    if (busy || !director) return;
    setBusy(true);
    setError("");
    try {
      const extra = {};
      if (seg) {
        extra.segment_id = seg.id;
        extra.segment_type = seg.type;
      }
      const body = vlmBody(buildFirstFramePayload(extra));
      console.log("[Transfer] submit /llm/generate_first_frame, body:", body);
      const res = await api.fetchApi("/minimax_ref/api/llm/generate_first_frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      console.log("[Transfer] /llm/generate_first_frame ->", data);
      if (data && data.success) {
        if (seg) {
          seg.type = "image";
          seg.imageFile = data.image_file || data.imageFile || data.image_path || "";
          director.commitChanges();
          if (director._transferSetSeg) director._transferSetSeg(seg);
        }
        return data;
      }
      setError((data && data.error) || "提交 /llm/generate_first_frame 失败");
      return null;
    } catch (e) {
      console.error("[Transfer] submitGenerateFirstFrame failed:", e);
      setError(String(e?.message || e));
      return null;
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  // Motion Context 开关：更新 timeline_data 对应字段，并按节点类型处理右侧 json 的 shot1_description
  function toggleMotionContext() {
    const seg = curSeg;
    if (!seg || !director) return;
    const on = !motionCtxOn;
    setMotionCtxOn(on);
    seg.motionContext = on; // 更新 timeline_data 对应字段
    if (on) {
      if (seg.type === "image") {
        // 图片节点：调用后端接口生成 shot1_description 并加入 json
        analyzeImageForShot1(seg);
      } else if (seg.type === "video") {
        // 文字和图片节点：更新 [Shot 1]
        setRightText(updateShotField(rightText, "shot1_description", seg.prompt || ""));
      } else {
        // 文字节点：去除 shot1_description
        setRightText(removeShotField(rightText, "shot1_description"));
      }
    } else {
      // 取消选中：去除 shot1_description
      setRightText(removeShotField(rightText, "shot1_description"));
    }
    director.commitChanges();
  }

  // 图片节点：调用 /llm/generate_image_analysis 生成 shot1_description 加入 json
  async function analyzeImageForShot1(seg) {
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
          ? (pd.shot1_description || pd.detailed_description || JSON.stringify(pd))
          : String(pd || "");
        setRightText(updateShotField(rightText, "shot1_description", desc));
      } else {
        setError((data && data.error) || "图像分析失败");
      }
    } catch (e) {
      console.error("[Transfer] analyzeImageForShot1 failed:", e);
      setError(String(e?.message || e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  // 自动尾帧开关：更新 timeline_data 对应字段；开启将 shotX_description 放入 json，取消删除
  function toggleAutoEndFrame() {
    const seg = curSeg;
    if (!seg || !director) return;
    const on = !autoEndOn;
    setAutoEndOn(on);
    seg.autoEndFrame = on; // 更新 timeline_data 对应字段
    const key = "shot" + shotNumber(seg) + "_description";
    if (on) {
      // 开启：将 shotX_description 放入 json
      setRightText(updateShotField(rightText, key, seg.prompt || ""));
    } else {
      // 取消：删除 shotX_description
      setRightText(removeShotField(rightText, key));
    }
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
  // 计算主体定义 / 音频定义 / retention_analysis（参考 lib/prompt.py build_h3_subject_bindings）
  const bindings = buildSubjectBindings(rightText, subjects, director);
  const bindParts = [];
  if (bindings.subject_definition) bindParts.push("subject_definition:\n" + bindings.subject_definition);
  if (bindings.audio_definition) bindParts.push("audio_definition:\n" + bindings.audio_definition);
  if (bindings.retention_analysis) bindParts.push("retention_analysis:\n" + bindings.retention_analysis);
  const bindingsText = bindParts.join("\n\n");

  return html`
    <div class="tr-panel" style=${S.panel}>
    ${
        curSeg && curSeg.type !== "audio"
          ? html`<div style=${S.buttons}>
              ${
                curSeg.type === "text" || curSeg.type === "image"
                  ? html`<button
                      class="pr-btn"
                      title="Generate the first frame from the selected segment"
                      disabled=${busy}
                      onClick=${() => generateFirstFrame(curSeg)}
                    >Generate First Frame</button>`
                  : null
              }
              ${
                curSeg.type === "text" || curSeg.type === "image" || curSeg.type === "video"
                  ? html`<button
                      class=${motionCtxOn ? "pr-btn toggle-on" : "pr-btn"}
                      title="Toggle Motion Context for the selected segment"
                      onClick=${toggleMotionContext}
                    >Motion Context</button>`
                  : null
              }
              ${
                curSeg.type !== "audio"
                  ? html`<button
                      class=${autoEndOn ? "pr-btn toggle-on" : "pr-btn"}
                      title="Toggle Auto End Frame for the selected segment"
                      onClick=${toggleAutoEndFrame}
                    >Auto End Frame</button>`
                  : null
              }
            </div>`
          : null
      }
      <div ref=${rowRef} style=${S.row}>
        <div class="pr-prompt-wrapper" style=${leftWidth ? Object.assign({}, S.col, { flex: "0 0 auto", width: leftWidth + "px" }) : S.col}>
          <div class="pr-prompt-label">Segment Prompt</div>
          <textarea
            ref=${leftRef}
            class="pr-prompt-area pr-prompt-area-left"
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
            class="pr-btn"
            title="以左侧为源生成 H3 Prompt，结果展示在右侧"
            disabled=${busy}
            onClick=${() => runGenerate(leftText)}
          >→</button>
        </div>
        <div class="pr-prompt-wrapper" style=${S.col}>
          <div class="pr-prompt-label" style=${{ position: "static", flexShrink: 0, margin: "6px 0 2px 8px" }}>Minimax H3 Prompt</div>
          <textarea
            ref=${rightRef}
            class="pr-prompt-area pr-prompt-area-right"
            style=${{ position: "static", flex: "1", minHeight: "0", height: "auto", width: "100%", boxSizing: "border-box", background: "#1e1e1e", border: "none", resize: "none", outline: "none", padding: "4px 8px 8px", color: "#e0e0e0", fontSize: "12px", lineHeight: "1.4", fontFamily: "monospace" }}
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
                  <img style=${S.img} src=${r.src} alt=${r.label} />
                  ${r.kind === "subject" && r.audio ? html`<span style=${S.audioIcon}>♪ ${r.label}</span>` : html`<span style=${S.label}>${r.label}</span>`}
                </div>
              `)
        }
        <div
          class="tr-defs"
          style=${S.defsWrap}
          title="主体定义 / 音频定义 / retention_analysis"
          onMouseEnter=${() => setDefsOpen(true)}
          onMouseLeave=${() => setDefsOpen(false)}
        >
          <span style=${S.defsIcon}>ℹ</span>
          ${
            defsOpen
              ? html`<div style=${S.defsTip}>
                  ${
                    bindingsText
                      ? html`<div style=${{ whiteSpace: "pre-wrap" }}>${bindingsText}</div>`
                      : html`<div style=${S.defsTipEmpty}>暂无主体定义 / 音频引用</div>`
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
                  : subjects.map(s => html`
                      <button
                        class="pr-btn"
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

// ---------- 全局参数分组（渲染在 .pr-wrapper 中 .pr-toolbar 之上） ----------

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
    </div>
  `;
}

// ---------- 挂载辅助 ----------

export function mountTransfer(director, container) {
  return render(h(TransferPanel, { director }), container);
}
