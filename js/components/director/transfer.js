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
import { api, app, clamp, viewUrl, viewUrlInline, ICONS } from "./shared.js";

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
function subjectMediaThumb(s) {
  const p = subjectMediaPreview(s);
  const base = { width: "22px", height: "22px", borderRadius: "3px", flex: "0 0 auto", objectFit: "cover" };
  if (p.kind === "image") return html`<img src=${p.src} alt="" style=${base} />`;
  if (p.kind === "video") return html`<video src=${p.src} muted preload="metadata" style=${Object.assign({}, base, { background: "#000" })} />`;
  if (p.kind === "audio") return html`<span title="音频" style=${{ width: "22px", height: "22px", borderRadius: "3px", flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#1e3a5f", color: "#38bdf8", fontSize: "11px", fontStyle: "normal" }}>♪</span>`;
  return null;
}

// 从 graph 中的 MiniMaxRefSubject 节点读取 global_prompt widget 值（与 getSubjectVlmSettings 同源）
function getSubjectGlobalPrompt() {
  try {
    const nodes = app.graph?._nodes || [];
    for (const n of nodes) {
      if (n.type !== "MiniMaxRefSubject") continue;
      const w = (n.widgets || []).find((x) => x.name === "global_prompt");
      if (w && typeof w.value === "string" && w.value.trim()) return w.value.trim();
    }
  } catch (e) {
    console.warn("[Transfer] getSubjectGlobalPrompt failed:", e);
  }
  return "";
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

// ============================================================
// 首帧图 subgraph（机制 1：前端独立构造并提交，不污染 director 节点）
// ============================================================

// 根据输入语义找 loader 对应输出槽位（MODEL / CLIP / VAE）
function outputSlotFor(loaderNode, inputName) {
  const want = inputName === "model" ? "MODEL" : inputName === "clip" ? "CLIP" : "VAE";
  const outs = loaderNode?.outputs || [];
  for (let i = 0; i < outs.length; i++) {
    if (String(outs[i]?.type || "") === want) return i;
  }
  return 0;
}

// 按输入语义（model / clip / vae）从节点输出里找对应类型槽位，找不到取 0
function slotForOutputSemantic(node, inputName) {
  const want = inputName === "model" ? "MODEL" : inputName === "clip" ? "CLIP" : inputName.includes("vae") ? "VAE" : null;
  const outs = node?.outputs || [];
  if (want) {
    for (let i = 0; i < outs.length; i++) {
      if (String(outs[i]?.type || "") === want) return i;
    }
  }
  return 0;
}

// 整链 DFS：从节点某输入出发，沿连线向上把整条 model/clip/vae 链复制进 subgraph。
// 规则：
//  - 加载器（Checkpoint/CLIP/UNet/VAE Loader）→ 登记为资源源（Map 去重，model/clip 共用一份），返回其输出；
//  - 透传占位（MiniMaxRefSubject/Director/Guide、Reroute）→ 不改数据，穿透继续向上；
//  - skipModifiers=true（实验模式：只保留加载器链路）→ 跳过 LoRA / te-speed / SageAttention / Spectrum
//    等所有中间修改节点，沿其输入继续向上（等价 bypass，排除加速/改造节点对单帧细节的损耗）；
//  - 其余任何节点（LoRA、sigma shift、SageAttention patch、Spectrum Apply…）→ 先递归复制整棵上游，
//    再复制本节点并连线，返回其输出。未来新增的"修改型"节点无需改代码，自动被原样搬入。
// ctx = { addNode(class_type, inputs)->id, loaderSub: Map<原id,{id}>, copied: Map<原id,新id|null>, outLinks: [] }
// previewModel=true 时：穿透 MiniMaxRefSubject 且请求 "model"，优先沿 preview_model 输入继续向上
// （预览视频用 4 步 lora；未连接则回退到 model 输入即 pro model）。
// 返回 { node: 新节点 id 字符串, slot: 输出槽 } 或 null（悬空 / 无法解析 / 环）
function collectLoaderChain(node, inputName, ctx, skipModifiers = false, previewModel = false) {
  const input = (node.inputs || []).find((i) => i.name === inputName);
  if (!input || input.link == null) return null; // 悬空输入
  const link = app.graph?.links?.[input.link];
  if (!link) return null;
  const origin = app.graph?.getNodeById?.(link.origin_id);
  if (!origin) return null;

  const cls = origin.comfyClass || origin.type || "";

  // 1) 加载器：登记资源源（去重），返回对应语义的输出槽
  if (/^(CheckpointLoaderSimple|CheckpointLoader|UNETLoader|VAELoader|CLIPLoader|DualCLIPLoader|TripleCLIPLoader)$/.test(cls)) {
    let rec = ctx.loaderSub.get(origin.id);
    if (!rec) {
      rec = { id: ctx.addNode(cls, nodeWidgetValues(origin)) };
      ctx.loaderSub.set(origin.id, rec);
    }
    return { node: rec.id, slot: outputSlotFor(origin, inputName) };
  }

  // 2) 透传占位：穿透，沿它对应输入继续向上（Reroute 输入名固定为 "input"）
  if (/^(MiniMaxRefSubject|MiniMaxRefDirector|MiniMaxRefGuide|Reroute)$/.test(cls)) {
    let nextName = cls === "Reroute" ? "input" : inputName;
    // 预览模式：subject 的 model 是 {pro, preview} 数组，取 preview_model 输入对应的加载器链
    if (previewModel && cls === "MiniMaxRefSubject" && inputName === "model") {
      const hasPreview = (origin.inputs || []).some((i) => i.name === "preview_model" && i.link != null);
      nextName = hasPreview ? "preview_model" : "model";
    }
    return collectLoaderChain(origin, nextName, ctx, skipModifiers, previewModel);
  }

  // 2b) 实验模式（skipModifiers）：只保留加载器链路，跳过 LoRA / te-speed / SageAttention / Spectrum
  //     等所有中间修改节点——它们会原样搬进首帧 subgraph 并损耗单帧细节（turbo LoRA / Spectrum
  //     尤其明显）。穿透：优先取与目标语义同名的输入，无同名则取第一个已连接的输入继续向上。
  if (skipModifiers) {
    console.warn(`[Transfer] 首帧 subgraph 跳过中间节点 ${cls}（只保留加载器链路）`);
    const inp = origin.inputs?.find((i) => i.name === inputName && i.link != null)
      || origin.inputs?.find((i) => i.link != null);
    if (!inp) {
      // 没有任何已连接输入 = 资源源（自定义 Loader，如 MiniMaxRefHybridLoader 等）：
      // 视为加载器直接复制并登记去重，否则整条链断裂会返回 null 导致报错
      let rec = ctx.loaderSub.get(origin.id);
      if (!rec) {
        rec = { id: ctx.addNode(cls, nodeWidgetValues(origin)) };
        ctx.loaderSub.set(origin.id, rec);
      }
      return { node: rec.id, slot: outputSlotFor(origin, inputName) };
    }
    return collectLoaderChain(origin, inp.name, ctx, skipModifiers, previewModel);
  }

  // 3) 其余节点：后序 DFS —— 先复制整棵上游，再复制本节点并重建连线
  if (!ctx.copied.has(origin.id)) {
    ctx.copied.set(origin.id, null); // 防环占位
    const resolved = {};
    for (const inp of origin.inputs || []) {
      if (inp.link == null) continue;
      const src = collectLoaderChain(origin, inp.name, ctx, skipModifiers, previewModel);
      if (src) resolved[inp.name] = src;
    }
    const nid = ctx.addNode(cls, nodeWidgetValues(origin));
    ctx.copied.set(origin.id, nid);
    for (const name of Object.keys(resolved)) {
      const src = resolved[name];
      ctx.outLinks.push({ from: src.node, fromSlot: src.slot, to: nid, toInput: name });
    }
  }
  const nid = ctx.copied.get(origin.id);
  if (nid == null) return null; // 环，无法解析
  return { node: nid, slot: slotForOutputSemantic(origin, inputName) };
}

// 复制节点全部 widget 值（跳过隐藏 / 按钮 / 指定项）
function nodeWidgetValues(node, skip = {}) {
  const out = {};
  for (const w of node?.widgets || []) {
    if (!w || w.type === "hidden" || w.name == null) continue;
    if (w.name.startsWith("_") || w.type === "button") continue;
    if (skip[w.name]) continue;
    if (typeof w.value === "undefined" || w.value === null) continue;
    out[w.name] = w.value;
  }
  return out;
}

// 把资源 src（相对路径或 /view? URL）转成 LoadImage 可用的 input 相对文件名；
// data URL / 外部 URL / 非 input 类型的 /view URL 一律返回 null
function imageSrcToInputPath(src) {
  if (!src || typeof src !== "string") return null;
  if (src.startsWith("data:")) return null;
  // 相对路径（如 minimaxrefdirector/xxx.png，subjects 上传到 input 目录的产物）
  // 直接作为 input 相对文件名返回，否则会被 new URL 误判后丢弃（参考图不生效的根因）
  if (!src.startsWith("/") && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return src;
  try {
    const u = new URL(src, location.origin);
    if (u.origin !== location.origin) return null; // 外部 URL
    if (u.pathname.endsWith("/view")) {
      const fn = u.searchParams.get("filename");
      const sub = u.searchParams.get("subfolder") || "";
      const type = u.searchParams.get("type") || "input";
      if (!fn || type !== "input") return null;
      return sub ? `${sub}/${fn}` : fn;
    }
    return null; // 同源非 /view URL（如 output 类型）无法保证位于 input 目录
  } catch {
    return null;
  }
}

// 等待 prompt 执行完成：优先监听 ComfyUI WebSocket 事件（execution_success / error / interrupted）
// 即时结束等待，避免纯轮询造成的持续请求；轮询降为 3s 兜底（排队中 / 事件缺失场景）。
// 成功 resolve history 条目，失败 / 超时 reject。
// 默认 30 分钟：首帧 subgraph 可能排在用户主 workflow（视频任务）之后，且 H3 模型加载 + 采样较慢
function waitForPromptDone(promptId, timeoutMs = 1800000, label = "任务") {
  const start = Date.now();
  let lastLog = 0;

  // 拉取一次 /history：完成 → 返回条目；执行错误 → 抛错；其它 → null
  async function pollOnce() {
    // 注意：api.fetchApi 返回的是 Response 对象（不是 JSON），必须手动 .json()
    let hist = {};
    try {
      const resp = await api.fetchApi(`/history/${promptId}`);
      hist = resp && resp.ok ? await resp.json() : {};
    } catch { /* 网络抖动，重试 */ }
    const h = hist && hist[promptId];
    if (!h) return null;
    const st = h.status || {};
    if (st.completed || st.status_str === "success") return h;
    if (st.status_str === "error" || (st.messages || []).some((m) => m[0] === "execution_error")) {
      const err = (st.messages || []).find((m) => m[0] === "execution_error");
      throw new Error(err ? `生成失败：${err[1]?.message || "执行错误"}` : "生成失败");
    }
    return null; // 仍执行中
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer = null;

    const cleanup = () => {
      api.removeEventListener("execution_success", onSuccess);
      api.removeEventListener("execution_error", onError);
      api.removeEventListener("execution_interrupted", onInterrupt);
      if (pollTimer) clearTimeout(pollTimer);
    };
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    // 老版本事件 detail 无 prompt_id 时按当前任务处理；有则只响应自己的 prompt
    const matches = (ev) => {
      const id = ev && ev.detail && ev.detail.prompt_id;
      return !id || id === promptId;
    };

    const onSuccess = async (ev) => {
      if (!matches(ev)) return;
      try {
        const h = await pollOnce();
        if (h) settle(resolve, h); // history 尚未落盘时交给轮询兜底
      } catch (e) { settle(reject, e); }
    };
    const onError = (ev) => {
      if (!matches(ev)) return;
      const msg = (ev && ev.detail && ev.detail.exception_message) || "执行错误";
      settle(reject, new Error(`生成${label}失败：${msg}`));
    };
    const onInterrupt = (ev) => {
      if (!matches(ev)) return;
      settle(reject, new Error(`生成${label}已中断`));
    };

    api.addEventListener("execution_success", onSuccess);
    api.addEventListener("execution_error", onError);
    api.addEventListener("execution_interrupted", onInterrupt);

    const tick = async () => {
      if (settled) return;
      try {
        const h = await pollOnce();
        if (h) { settle(resolve, h); return; }
      } catch (e) { settle(reject, e); return; }
      const now = Date.now();
      if (now - lastLog >= 15000) {
        lastLog = now;
        let status = "未开始/排队中";
        try {
          const resp = await api.fetchApi(`/history/${promptId}`);
          const hist = resp && resp.ok ? await resp.json() : {};
          const h = hist && hist[promptId];
          if (h) status = JSON.stringify(h.status);
        } catch { /* ignore */ }
        console.log(
          `[Transfer] ${label} 执行中，已等待 ${Math.round((now - start) / 1000)}s ` +
          `(prompt_id=${promptId}, status=${status})`
        );
      }
      if (Date.now() - start >= timeoutMs) {
        settle(reject, new Error(`生成${label}超时（${Math.round(timeoutMs / 60000)} 分钟），请在 ComfyUI 后端控制台查看是否仍在执行`));
        return;
      }
      pollTimer = setTimeout(tick, 3000);
    };
    tick();
  });
}

// 从 history 输出中取第一张图片（SaveImage 产物）
function imageFromHistory(history) {
  const outputs = history?.outputs || {};
  for (const key of Object.keys(outputs)) {
    const o = outputs[key];
    if (o?.images?.length) {
      const img = o.images[0];
      return { filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output" };
    }
  }
  return null;
}

// 从 history 输出中取第一个视频（videos / gifs 产物，如预览视频 mp4）
function videoFromHistory(history) {
  const outputs = history?.outputs || {};
  for (const key of Object.keys(outputs)) {
    const o = outputs[key];
    const list = o?.videos || o?.gifs;
    if (list?.length) {
      const v = list[0];
      return { filename: v.filename, subfolder: v.subfolder || "", type: v.type || "output" };
    }
  }
  return null;
}

// ---------- 预览视频生成参数（Settings 弹窗） ----------
// 只存 localStorage，刷新后保留；不写入 timeline_data
const PREVIEW_SETTINGS_KEY = "mmrd.previewSettings";
const DEFAULT_PREVIEW_SETTINGS = {
  length_seconds: 1.0, // 预览时长（秒）
  steps: 8, // 8 步 turbo LoRA 对应 8 步；无 LoRA 建议 16+
  million_pixels: 0.6, // 画质（百万像素）
  sampler_name: "res_multistep",
  scheduler: "beta",
};
function loadPreviewSettings() {
  try {
    const raw = localStorage.getItem(PREVIEW_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_PREVIEW_SETTINGS };
    return { ...DEFAULT_PREVIEW_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREVIEW_SETTINGS };
  }
}
function savePreviewSettings(s) {
  try {
    localStorage.setItem(PREVIEW_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
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
  refTextarea: { position: "static", minHeight: "120px", height: "auto", width: "100%", boxSizing: "border-box", background: "#1e1e1e", border: "none", resize: "none", outline: "none", padding: "4px 8px 8px", color: "#e0e0e0", fontSize: "12px", lineHeight: "1.4", fontFamily: "monospace" },
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
  const [leftWidth, setLeftWidth] = useState(null); // 左侧宽度(px)，null 表示默认平分
  const [midHover, setMidHover] = useState(false);
  const [curSeg, setCurSeg] = useState(null); // 当前选中 segment（由 director 推送）
  const [motionCtxOn, setMotionCtxOn] = useState(false); // Motion Context 开关
  const [autoEndOn, setAutoEndOn] = useState(false); // Auto End Frame 开关
  const [defsOpen, setDefsOpen] = useState(false); // .tr-resources 信息图标 hover
  const [defsPos, setDefsPos] = useState(null); // 信息图标 tooltip fixed 定位坐标 { left, top, up }
  const [bindData, setBindData] = useState(null); // 后端 build_h3_subject_bindings 结果
  const [addMenu, setAddMenu] = useState(null); // additionSubject 添加框下拉坐标 { x, y }（fixed 定位，避免被资源条 overflow 裁剪）
  const [addVersion, setAddVersion] = useState(0); // additionSubject 变更计数（驱动资源条 / 绑定刷新）
  const [imageVersion, setImageVersion] = useState(0); // 首帧/尾帧图回写计数（驱动资源条预览刷新）
  const [previewSettings, setPreviewSettings] = useState(() => loadPreviewSettings()); // 预览视频生成参数（localStorage 持久化）
  const settingsMenuRef = useRef(null); // Settings 弹窗 DOM 元素
  const settingsDismisserRef = useRef(null); // 弹窗外点击关闭监听器

  const rowRef = useRef(null);
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

  // 点击外部关闭 additionSubject 下拉（fixed 定位，需显式关闭）
  useEffect(() => {
    if (!addMenu) return;
    const onDown = (e) => {
      if (e.target.closest && !e.target.closest(".tr-addmenu") && !e.target.closest(".tr-addsub")) setAddMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [addMenu]);

  // 右侧内容 debounce 解析资源引用
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (!aliveRef.current) return;
      setResources(parseResources(rightText, subjects));
    }, 500);
    return () => clearTimeout(debounceRef.current);
  }, [rightText, subjects, addVersion, imageVersion]);

  // 右侧 H3 JSON / 主体 / 时间轴变化时 debounce 请求后端
  // /h3/build_subject_bindings（替代前端 buildFirstFramePayload 的绑定组装）。
  // 绑定 prompt 中提到的主体 + 当前 segment additionSubject 手动添加的主体。
  useEffect(() => {
    if (!aliveRef.current || !director) return;
    clearTimeout(bindDebounceRef.current);
    bindDebounceRef.current = setTimeout(() => {
      fetchBindings();
    }, 400);
    return () => clearTimeout(bindDebounceRef.current);
  }, [rightText, subjects, director, addVersion]);

  // ---------- 工具 ----------

  // textarea auto-grow：高度跟随内容（scrollHeight），内容变少时先复位再重算。
  // fill 链路下 textarea 由 flex-grow 拉伸填满容器（拖拽有效）；
  // 内容超高（scrollHeight > 可见高）时回调外壳增大 prop 区，node 高度由
  // checkResize 自动跟随，保证完整显示。
  const autoGrow = (el, grow) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
    if (grow && el.scrollHeight > el.clientHeight + 1) {
      grow(el.scrollHeight - el.clientHeight);
    }
  };

  // 内容超高时增大 prop 区（固定 height），textarea 的 flex 分配随之变大
  const growProp = (px) => {
    if (!director) return;
    const target = Math.max(0, (director.propHeight || 0) + Math.ceil(px));
    director.propHeight = target;
    if (director.node && director.node.properties) director.node.properties.propHeight = target;
    if (director.propContainer) director.propContainer.style.height = `${target}px`;
    if (director._syncNodeHeight) director._syncNodeHeight();
  };

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

  // 请求后端 /h3/build_subject_bindings（lib/prompt.py build_h3_subject_bindings）：
  // textarea auto-grow：内容变化（含外部 _transferSetLeft / 加载 / 切换 segment）后恢复高度计算
  useEffect(() => {
    if (!aliveRef.current) return;
    const raf = requestAnimationFrame(() => {
      autoGrow(leftRef.current, growProp);
      autoGrow(rightRef.current, growProp);
    });
    return () => cancelAnimationFrame(raf);
  }, [leftText, rightText]);

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

<<<<<<< HEAD
=======
  // ---------- 组装 VLM 首帧 payload（供 subgraph 机制复用）----------
  // 生成 payload：
  //   prompt   = subject_definitions + retention_analysis + detailed_description
  //            + overall_soundscape + non_diegetic_music
  //   images   = 图片文件路径列表（主体图片 + 尾帧）
  //   audios   = 音频文件路径列表
  //   videos   = 视频文件路径列表
  //   segment_data + 全局参数（start/end/frame_rate/resolution 等）
  // 绑定部分（subject_definitions / retention_analysis + images / audios / videos）
  // 来自后端 /h3/build_subject_bindings 的返回（bindData）。
  function assembleVlmPayload(extra, bindOverride) {
    const bind = bindOverride || bindData || {};

    // 1) detailed_description / overall_soundscape / non_diegetic_music
    const pd = parsePromptText(rightText);
    const detail = String(pd.detailed_description || "").trim();
    const soundscape = String(pd.overall_soundscape || "").trim();
    const music = String(pd.non_diegetic_music || "").trim();

    // 主体节点传来的 global_prompt（锚定贯穿全片的人物/场景），拼到 detailed_description 之前
    const globalPrompt = getSubjectGlobalPrompt();

    // 2) prompt = subject_definitions + retention_analysis + global_prompt + detailed + soundscape + music
    const subjectDefs = bind.subject_definitions || "";
    const detailSection = globalPrompt
      ? `detailed_description:\n${globalPrompt}\n${detail}`
      : `detailed_description:\n${detail}`;
    const promptParts = [
      subjectDefs ? "subject_definitions:\n" + subjectDefs : "",
      bind.retention_analysis ? "retention_analysis:\n" + bind.retention_analysis : "",
      detail ? detailSection : (globalPrompt ? `detailed_description:\n${globalPrompt}` : ""),
      soundscape ? "overall_soundscape:\n" + soundscape : "",
      music ? "non_diegetic_music:\n" + music : "",
    ].filter(Boolean);
    const prompt = promptParts.join("\n\n");

    // 3) images / audios / videos（去重，按编号顺序；后端已返回纯文件路径列表）
    const imgSeen = new Set();
    const images = (bind.images || []).filter((src) => {
      if (!src || imgSeen.has(src)) return false;
      imgSeen.add(src);
      return true;
    });
    const audios = (bind.audios || []).filter((src) => !!src);
    const videos = (bind.videos || []).filter((src) => !!src);

    // 4) segment_data：时间轴 segments（按 start 排序）
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
        additionSubject: Array.isArray(s.additionSubject) ? s.additionSubject : [],
      }));

    // 5) 全局参数（与 director.py widget 同名）
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

    console.log("[Transfer] assembleVlmPayload ->", {
      prompt,
      images,
      audios,
      videos,
      segment_data,
    });

    return payload;
  }

>>>>>>> 92890455fa8445977525a2e06bd52fc367908311
  // ---------- 机制 1：前端构造预览视频 subgraph（独立 prompt，与用户完整图互不冲突）----------
  // subgraph = [loader 链(含 LoRA 等中间节点)] + [RefGenerateImage]
  // 节点内完成 ref 编码 + sigma shift + KSampler + VAEDecode + mp4 编码，
  // UI 输出保存视频的 filename 供前端回写 segment 的 video 轨道。
  // skipModifiers=false：把 LoRA / te-speed / SageAttention / Spectrum 等中间节点
  // 一起搬入（其中包含 8 步 turbo LoRA，配合 Settings 里 steps=8 快速出预览）。
<<<<<<< HEAD
  function buildPreviewSubgraph({ seg, promptText, refSrcs, refAudios, refVideos }) {
=======
  function buildPreviewSubgraph({ seg, promptText, refSrcs }) {
>>>>>>> 92890455fa8445977525a2e06bd52fc367908311
    const dNode = director?.node;
    if (!dNode) return null;
    const p = {};
    let nid = 1;
    const addNode = (class_type, inputs) => {
      const id = String(nid++);
      p[id] = { class_type, inputs };
      return id;
    };

    // 1) 整链复制（model / clip / video_vae / audio_vae 四路）：加载器登记资源源、透传占位穿透、
    //    其余任何节点（LoRA / sigma shift / SageAttention patch / Spectrum Apply…）原样搬入
    //    model 走 preview model（4 步 lora）：穿透 MiniMaxRefSubject 时沿 preview_model 输入向上
    const ctx = { addNode, loaderSub: new Map(), copied: new Map(), outLinks: [] };
<<<<<<< HEAD
    const modelRef = collectLoaderChain(dNode, "model", ctx, false, true);
    const clipRef = collectLoaderChain(dNode, "clip", ctx, false);
    const vaeRef = collectLoaderChain(dNode, "video_vae", ctx, false);
    // audio_vae 可选：只有传入 ref_audios 时才要求链路（未连接则退回不带音频的预览）
    const audioVaeRef = collectLoaderChain(dNode, "audio_vae", ctx, false);
=======
    const modelRef = collectLoaderChain(dNode, "model", ctx, false);
    const clipRef = collectLoaderChain(dNode, "clip", ctx, false);
    const vaeRef = collectLoaderChain(dNode, "video_vae", ctx, false);
>>>>>>> 92890455fa8445977525a2e06bd52fc367908311

    if (!modelRef || !clipRef || !vaeRef) {
      setError("预览视频需要 director 的 model / clip / video_vae 输入连接到加载器（如 CheckpointLoaderSimple / VAELoader）。");
      return null;
    }

    // 2) 建立中间修改节点（LoRA 等）的连线：上游输出 → 节点输入
    for (const l of ctx.outLinks) {
      const target = p[l.to];
      if (target) target.inputs[l.toInput] = [l.from, l.fromSlot];
    }

    // 3) 参考媒体 refs：路径统一转 input 相对路径，以字符串直接传给 RefGenerateImage
    //    图片最多 9 张，视频/音频各最多 4 条
    const toInputPath = (srcs, max) => {
      const out = [];
      for (const src of srcs || []) {
        const path = imageSrcToInputPath(src);
        if (!path) continue;
        out.push(path);
        if (out.length >= max) break;
      }
      return out;
    };
    const refPaths = toInputPath(refSrcs, 9);
    const refVideoPaths = toInputPath(refVideos, 4);
    let refAudioPaths = toInputPath(refAudios, 4);
    if (refPaths.length === 0) {
      console.warn("[Transfer] 参考图为空：subjects 中没有可用的 input 图片（检查 subjects 是否上传了图片文件）");
    }

    // 4) RefGenerateImage：ref 编码 + sigma shift + 采样 + 解码 + mp4 编码全部在节点内完成
    const segNo = (director.timeline?.segments || []).findIndex((s) => s.id === seg.id) + 1 || 1;
    const ps = previewSettings;
    const h3Inputs = {
      model: [modelRef.node, modelRef.slot],
      clip: [clipRef.node, clipRef.slot],
      vae: [vaeRef.node, vaeRef.slot],
      output_resolution: wVal("outpu_resolution") || "16:9横屏",
      million_pixels: parseFloat(ps.million_pixels) || 0.6,
      prompt: promptText || "",
      seed: Math.floor(Math.random() * 0xffffffff),
      length_seconds: parseFloat(ps.length_seconds) || 1.0,
      steps: parseInt(ps.steps, 10) || 8,
      sampler_name: ps.sampler_name || "res_multistep",
      scheduler: ps.scheduler || "beta",
      filename_prefix: `minimaxrefdirector/preview/seg${segNo}`,
    };
    // audio_vae：有参考音频且链路可用时接上；若链路缺失则主动丢弃音频（服务端
    // build_segment_conditioning 在 ref_audios 非空但 audio_vae 缺失时会抛错）
    if (refAudioPaths.length > 0 && !audioVaeRef) {
      console.warn("[Transfer] 有参考音频但 director.audio_vae 未连接加载器，预览将退回无音频条件（丢弃 audios）");
      refAudioPaths = [];
    } else if (refAudioPaths.length > 0 && audioVaeRef) {
      h3Inputs.audio_vae = [audioVaeRef.node, audioVaeRef.slot];
    }
    // 注意：ComfyUI v3 io 的 Autogrow 输入（io.Autogrow.Input("ref_images", ...)）要求提交 key
    // 使用完整动态路径前缀 "ref_images.ref_image_{i}"，否则服务端匹配不到变体输入，
    // 会按「未传值」处理并把 ref_images 默认为空 dict（表现为 h3.py 收到 ref_images={}）。
    refPaths.forEach((path, i) => { h3Inputs[`ref_images.ref_image_${i}`] = path; });
    refVideoPaths.forEach((path, i) => { h3Inputs[`ref_videos.ref_video_${i}`] = path; });
    refAudioPaths.forEach((path, i) => { h3Inputs[`ref_audios.ref_audio_${i}`] = path; });
    const refNodeId = addNode("RefGenerateImage", h3Inputs);

    // 5) 控制台日志：完整打印 subgraph（含传给 RefGenerateImage 的全部输入）
    console.log(`[Transfer] 预览视频 subgraph 已构造：${Object.keys(p).length} 个节点`);
    console.log(`[Transfer] model 链路末端 -> 节点 ${modelRef.node}[${modelRef.slot}]`);
    console.log(`[Transfer] clip 链路末端 -> 节点 ${clipRef.node}[${clipRef.slot}]`);
    console.log(`[Transfer] vae  链路末端 -> 节点 ${vaeRef.node}[${vaeRef.slot}]`);
    console.log(`[Transfer] audio_vae 链路末端 -> 节点 ${audioVaeRef ? audioVaeRef.node + "[" + audioVaeRef.slot + "]" : "未连接"}`);
    console.log(`[Transfer] 参考图 refs (${refPaths.length}/9) ->`, refPaths);
    console.log(`[Transfer] 参考视频 refs (${refVideoPaths.length}/4) ->`, refVideoPaths);
    console.log(`[Transfer] 参考音频 refs (${refAudioPaths.length}/4) ->`, refAudioPaths);
    console.log("[Transfer] RefGenerateImage 完整输入 ->", p[refNodeId]);
    console.log("[Transfer] 完整 subgraph ->", p);

    return p;
  }

  // 提交预览视频 subgraph → 轮询 /history → 回写 segment（type=video + videoFile + videoB64）
  async function submitPreviewVideo(seg) {
    if (busy || !director) return null;
    setBusy(true);
    setError("");
    try {
<<<<<<< HEAD
      // timeline_segment：当前选中 segment（含 additionSubject，供后端追加绑定未提及的主体）
      const seg = curSeg;
      const body = {
        global_prompt: getSubjectGlobalPrompt(),
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
      const res = await api.fetchApi("/minimax_ref/api/h3/build_h3_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      // 预览 prompt = 后端组装好的全局 prompt（subject_definitions + retention_analysis +
      // detailed_description + soundscape + music）+ 当前段 prompt（把段级镜头语言如"人物特写"
      // 带进预览，否则只按泛化描述生成，内容容易不符合预期）
      const bindData = data?.data || {};
      const promptText = [bindData.prompt, seg.prompt].filter(Boolean).join("\n\n");
      const refSrcs = [...(bindData.images || [])];
      const refAudios = [...(bindData.audios || [])];
      const refVideos = [...(bindData.videos || [])];
      console.log("[Transfer] /h3/build_h3_prompt 返回 ->", { prompt: bindData.prompt, images: refSrcs, audios: refAudios, videos: refVideos });
      const p = buildPreviewSubgraph({ seg, promptText, refSrcs, refAudios, refVideos });
=======
      if (!seg) { setError("未选中 segment"); return null; }
      // 复用组装逻辑（与视频任务一致）：绑定结果来自后端 /h3/build_subject_bindings
      let bind = bindData;
      if (!bind) bind = await fetchBindings();
      const payload = assembleVlmPayload({ segment_id: seg.id, segment_type: seg.type }, bind);
      // 预览 prompt = 全局主体/场景描述 + 当前段 prompt（把段级镜头语言如"人物特写"带进预览，
      // 否则只按泛化描述生成，内容容易不符合预期）
      const promptText = [payload?.prompt, seg.prompt].filter(Boolean).join("\n\n");
      const refSrcs = [...(payload?.images || [])];
      const p = buildPreviewSubgraph({ seg, promptText, refSrcs });
>>>>>>> 92890455fa8445977525a2e06bd52fc367908311
      if (!p) return null;
      console.log("[Transfer] submit preview-video subgraph ->", p);

      const resp = await api.queuePrompt(-1, { output: p, workflow: {} });
      const promptId = resp?.prompt_id;
      if (!promptId) throw new Error("提交队列失败");
      console.log("[Transfer] 预览视频 subgraph 已提交，prompt_id =", promptId);

      const history = await waitForPromptDone(promptId, 1800000, "预览视频");
      console.log("[Transfer] 预览 history status:", history?.status);
      console.log("[Transfer] 预览 history outputs keys:", Object.keys(history?.outputs || {}));
      const vid = videoFromHistory(history);
      if (!vid) {
        console.error("[Transfer] history.outputs 中未找到 videos，完整内容:", JSON.stringify(history?.outputs || {}));
        throw new Error("未找到生成的预览视频");
      }

      // 归一化 subfolder 分隔符：Windows 后端返回的是 os.sep（反斜杠），
      // 统一转正斜杠，保证与全站路径约定一致（viewUrl 的 "/" 分割、resolve_input_path 的前缀判断）
      const sub = (vid.subfolder || "").replace(/\\/g, "/");
      const fileKey = sub ? sub + "/" + vid.filename : vid.filename;
      // 用 inline 端点：官方 /view 返回裸 filename= 被浏览器当作附件下载，
      // 右键“在新标签页中打开视频”会看不到；viewUrlInline 强制 inline 显示。
      const url = viewUrlInline(vid.filename, sub, vid.type || "output");

      // 预览视频放进 VIDEO 轨（VIDEOTrackLabel / videoTrackBody）展示，
      // 不回写 segment 到 MAIN 轨（避免把预览结果当成正式视频素材）
      appendPreviewToVideoTrack(seg, fileKey, url);
      return { video_file: fileKey, url };
    } catch (e) {
      console.error("[Transfer] submitPreviewVideo failed:", e);
      setError(String(e?.message || e));
      return null;
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  // 把预览视频结果追加到 VIDEO 轨（VIDEOTrackLabel 下的 videoTrackBody）。
  // 与后端 /minimax_ref/exec/video-progress 推送的逐段行同一 DOM 区域，
  // 用 data-seg="preview-<segNo>" 隔离，避免覆盖正式生成行。
  // 行内容用 Preact/htm 声明式渲染；仅保留一个容器锚点定位（Preact render 会整体替换 container 内容，因此每行需要独立容器）。
  function appendPreviewToVideoTrack(seg, fileKey, url) {
<<<<<<< HEAD
    const initSeg = director.timeline?.segments?.[director.selectedIndex] || null;
    if (!initSeg) return;
    initSeg.previewVideoFile = url
    initSeg.previewVideoB64 = fileKey
    director.render()
    // const body = director?.videoTrackBody;
    // if (!body) return;
    // const segNo = (director.timeline?.segments || []).findIndex((s) => s.id === seg.id) + 1 || 1;
    // const key = `preview-${segNo}`;
    // let holder = body.querySelector(`[data-seg="${key}"]`);
    // if (!holder) {
    //   holder = document.createElement("div");
    //   holder.dataset.seg = key;
    //   body.appendChild(holder);
    // }
    // const rowStyle = { display: "flex", alignItems: "center", gap: "6px" };
    // render(
    //   html`
    //     <div class="pr-video-row" style=${rowStyle}>
    //       <span class="pr-video-badge">PREVIEW seg${segNo} </span>
    //       <a href=${url} target="_blank" rel="noreferrer">${fileKey}</a>
    //     </div>
    //   `,
    //   holder,
    // );
    // // 轨道被收起时自动展开，并同步眼睛图标，确保结果可见
    // if (body.style.display === "none") {
    //   body.style.display = "flex";
    //   director.videoTrackEnabled = true;
    //   try {
    //     if (director.updateTrackIcon && director.videoTrackLabel?._eyeBtn) {
    //       director.updateTrackIcon(director.videoTrackLabel._eyeBtn, "video", true);
    //     }
    //   } catch { /* 忽略图标同步失败 */ }
    // }
    // body.scrollTop = body.scrollHeight;
=======
    const body = director?.videoTrackBody;
    if (!body) return;
    const segNo = (director.timeline?.segments || []).findIndex((s) => s.id === seg.id) + 1 || 1;
    const key = `preview-${segNo}`;
    let holder = body.querySelector(`[data-seg="${key}"]`);
    if (!holder) {
      holder = document.createElement("div");
      holder.dataset.seg = key;
      body.appendChild(holder);
    }
    const rowStyle = { display: "flex", alignItems: "center", gap: "6px" };
    render(
      html`
        <div class="pr-video-row" style=${rowStyle}>
          <span class="pr-video-badge">PREVIEW seg${segNo} </span>
          <a href=${url} target="_blank" rel="noreferrer">${fileKey}</a>
        </div>
      `,
      holder,
    );
    // 轨道被收起时自动展开，并同步眼睛图标，确保结果可见
    if (body.style.display === "none") {
      body.style.display = "flex";
      director.videoTrackEnabled = true;
      try {
        if (director.updateTrackIcon && director.videoTrackLabel?._eyeBtn) {
          director.updateTrackIcon(director.videoTrackLabel._eyeBtn, "video", true);
        }
      } catch { /* 忽略图标同步失败 */ }
    }
    body.scrollTop = body.scrollHeight;
>>>>>>> 92890455fa8445977525a2e06bd52fc367908311
  }

  // ---------- 预览视频生成参数 Settings 弹窗 ----------
  // 参考 Timeline Settings（settings.js showSettingsMenu）的 DOM 弹窗模式：
  // 固定定位 + 配置驱动行构建 + 外部点击关闭。
  // 参数只存 localStorage（刷新后保留），不写入 timeline_data。
  function dismissPreviewSettings() {
    if (settingsMenuRef.current) { settingsMenuRef.current.remove(); settingsMenuRef.current = null; }
    if (settingsDismisserRef.current) {
      document.removeEventListener("pointerdown", settingsDismisserRef.current, true);
      document.removeEventListener("wheel", settingsDismisserRef.current, true);
      settingsDismisserRef.current = null;
    }
  }

  function openPreviewSettings(anchorEl) {
    dismissPreviewSettings();
    const menu = document.createElement("div");
    menu.className = "pr-settings-menu";

    // 更新 state + 写 localStorage（刷新后保留；不写 timeline_data）
    const update = (patch) => {
      const next = { ...previewSettings, ...patch };
      setPreviewSettings(next);
      savePreviewSettings(next);
    };

    const divider = () => { const d = document.createElement("div"); d.className = "pr-settings-divider"; return d; };
    const row = (label, el) => {
      const r = document.createElement("div");
      r.className = "pr-settings-row";
      const lbl = document.createElement("span");
      lbl.className = "pr-settings-label";
      lbl.textContent = label;
      r.appendChild(lbl);
      r.appendChild(el);
      return r;
    };
    const combo = (options, value, onChange) => {
      const c = document.createElement("select");
      c.className = "pr-settings-select";
      for (const opt of options) {
        const o = document.createElement("option");
        o.value = String(opt.value);
        o.textContent = opt.label;
        if (String(opt.value) === String(value)) o.selected = true;
        c.appendChild(o);
      }
      c.addEventListener("change", () => onChange(c.value));
      return c;
    };
    const scrub = (value, step, min, max, isFloat, onChange) => {
      const container = document.createElement("div");
      container.className = "pr-number-control";
      const mkBtn = (label, act) => {
        const b = document.createElement("button");
        b.className = "pr-number-btn";
        b.textContent = label;
        b.addEventListener("click", act);
        container.appendChild(b);
        return b;
      };
      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "pr-settings-input";
      inp.value = String(value);
      inp.step = String(step);
      inp.min = String(min);
      inp.max = String(max);
      const commit = (val) => {
        const v = isFloat
          ? Math.min(max, Math.max(min, parseFloat(val)))
          : Math.round(Math.min(max, Math.max(min, parseInt(val, 10) || min)));
        inp.value = String(v);
        onChange(v);
      };
      const nudge = (d) => commit((isFloat ? parseFloat(inp.value) : parseInt(inp.value, 10) || min) + d * step);
      mkBtn("-", () => nudge(-1));
      container.appendChild(inp);
      mkBtn("+", () => nudge(1));
      inp.addEventListener("change", () => commit(inp.value));
      inp.style.cursor = "ew-resize";
      inp.addEventListener("mousedown", (e) => {
        const startX = e.clientX;
        const startVal = parseFloat(inp.value);
        let dragging = false, moved = false;
        const onMove = (me) => {
          const dx = me.clientX - startX;
          if (Math.abs(dx) > 3) { moved = true; dragging = true; }
          if (dragging) {
            me.preventDefault();
            commit(startVal + dx * (isFloat ? 0.01 : 0.5));
          }
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          if (!moved) { inp.focus(); inp.select(); }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
      return container;
    };

    // 标题 + 关闭按钮
    const titleContainer = document.createElement("div");
    titleContainer.className = "pr-settings-title";
    titleContainer.style.display = "flex";
    titleContainer.style.justifyContent = "space-between";
    titleContainer.style.alignItems = "center";
    const titleText = document.createElement("span");
    titleText.textContent = "Preview Video Settings";
    titleContainer.appendChild(titleText);
    const closeBtn = document.createElement("button");
    closeBtn.className = "pr-settings-close-btn";
    closeBtn.innerHTML = ICONS.close;
    closeBtn.title = "Close Settings";
    closeBtn.addEventListener("click", () => dismissPreviewSettings());
    titleContainer.appendChild(closeBtn);
    menu.appendChild(titleContainer);

    // 生成参数行
    const s = previewSettings;
    menu.appendChild(row("Length (s)", scrub(s.length_seconds, 0.1, 0.2, 10, true, (v) => update({ length_seconds: v }))));
    menu.appendChild(row("Steps", scrub(s.steps, 1, 1, 60, false, (v) => update({ steps: v }))));
    menu.appendChild(row("Quality (MP)", scrub(s.million_pixels, 0.1, 0.1, 4, true, (v) => update({ million_pixels: v }))));
    menu.appendChild(divider());
    menu.appendChild(row("Sampler", combo(
      ["res_multistep", "euler", "euler_ancestral", "dpmpp_2m", "dpmpp_3m_sde"].map((v) => ({ value: v, label: v })),
      s.sampler_name,
      (v) => update({ sampler_name: v }),
    )));
    menu.appendChild(row("Scheduler", combo(
      ["beta", "simple", "karras", "sgm_uniform", "normal"].map((v) => ({ value: v, label: v })),
      s.scheduler,
      (v) => update({ scheduler: v }),
    )));

    // 定位到 anchor 下方（与 Timeline Settings 一致）
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const menuW = menu.offsetWidth || 260;
    const menuH = menu.offsetHeight || 480;
    let left = rect.right - menuW;
    let top = rect.bottom + 6;
    if (left < 4) left = 4;
    if (top + menuH > window.innerHeight - 4) {
      top = rect.top - menuH - 6;
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    settingsMenuRef.current = menu;
    setTimeout(() => {
      settingsDismisserRef.current = (ev) => {
        if (!menu.contains(ev.target) && !anchorEl.contains(ev.target)) dismissPreviewSettings();
      };
      document.addEventListener("pointerdown", settingsDismisserRef.current, true);
      document.addEventListener("wheel", settingsDismisserRef.current, true);
    }, 0);
  }

  // 组件卸载时清理 Settings 弹窗
  useEffect(() => () => dismissPreviewSettings(), []);

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
    setAddMenu(null);
    setAddVersion((v) => v + 1);
    director.commitChanges(true);
  };
  // 打开 / 关闭添加主体下拉：fixed 定位并按按钮位置计算坐标，做视口边界钳制。
  // 不能用 absolute（会被 .tr-resources 的 overflow-x: auto 裁剪遮挡）。
  const openAddMenu = (e) => {
    if (addMenu) {
      setAddMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const menuH = 200; // 与 S.menu.maxHeight 一致
    const top = rect.bottom + menuH > window.innerHeight ? Math.max(4, rect.top - menuH) : rect.bottom;
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - 190));
    setAddMenu({ x: left, y: top });
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
    ${
        curSeg && curSeg.type !== "audio"
          ? html`<div style=${S.buttons}>
              ${
                curSeg.type === "text" || curSeg.type === "image" || curSeg.type === "video"
                  ? html`<button
                      class="pr-btn pr-icon-btn"
                      title="Preview video generation settings (stored in localStorage, kept after refresh)"
                      disabled=${busy}
                      onClick=${(e) => openPreviewSettings(e.currentTarget)}
                    ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg></button>
                  <button
                      class="pr-btn"
                      title="Generate a short preview video for the selected segment (subgraph: loader chain incl. LoRA + RefGenerateImage, mp4). Use Settings to tune length/steps/quality."
                      disabled=${busy}
                      onClick=${() => submitPreviewVideo(curSeg)}
                    >Generate Preview Video</button>`
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
          <div class="pr-prompt-label" style=${S.refTextareaLabel}>Segment Prompt</div>
          <textarea
            ref=${leftRef}
            class="pr-prompt-area ref-prompt-area"
            style=${Object.assign({}, S.refTextarea, { flex: "1 1 auto" })}
            value=${leftText}
            placeholder="原始 prompt（输入 @ 引用主体）"
            spellcheck=${false}
            onInput=${(e) => { autoGrow(e.target, growProp); setLeftText(e.target.value); handleInput(e, "left"); }}
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
          <div class="pr-prompt-label" style=${S.refTextareaLabel}>
            Minimax H3 Prompt
          </div>
          <textarea
            ref=${rightRef}
            class="pr-prompt-area ref-prompt-area"
            style=${Object.assign({}, S.refTextarea, { flex: "1 1 auto" })}
            value=${rightText}
            placeholder="生成结果（输入 @ 或 # 引用主体）"
            spellcheck=${false}
            onInput=${(e) => { autoGrow(e.target, growProp); setRightText(e.target.value); handleInput(e, "right"); }}
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
          // additionSubject 添加框：主体展示最前方，可手动添加未在 prompt 中提及的主体
          curSeg && curSeg.type !== "audio"
            ? html`<div class="tr-addsub" style=${{ position: "relative", flex: "0 0 auto", display: "flex", alignItems: "center", gap: "4px", padding: "4px" }}>
                <button
                  class="pr-btn"
                  title="添加未在提示词中提及的主体（additionSubject，写入 timeline_data 当前段）"
                  onClick=${(e) => openAddMenu(e)}
                >＋添加主体</button>
                ${
                  addMenu
                    ? html`<div class="tr-addmenu" style=${Object.assign({}, S.menu, { left: addMenu.x + "px", top: addMenu.y + "px" })}>
                        ${
                          addCandidates.length === 0
                            ? html`<div style=${{ padding: "6px 10px", color: "#888", fontSize: "12px" }}>没有可添加的主体（未提及的主体均已添加）</div>`
                            : addCandidates.map(h => html`
                                <button
                                  class="pr-btn"
                                  style=${Object.assign({}, S.trBtn, { display: "flex", alignItems: "center", gap: "6px", textAlign: "left", padding: "3px 6px" })}
                                  key=${"addc-" + h.name}
                                  onMouseDown=${(e) => e.preventDefault()}
                                  onClick=${() => addSubject(h.name)}
                                >${subjectMediaThumb(h)}<span>@ ${h.name}</span></button>
                              `)
                        }
                      </div>`
                    : null
                }
              </div>`
            : null
        }
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
                        class="pr-btn"
                        style=${S.trBtn}
                        key=${h.name}
                        onMouseDown=${(e) => e.preventDefault()}
                        onClick=${() => pickSubject(h)}
                      >@ ${h.name}</button>
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
      <div class="tr-gap-hr"></div>
    </div>
  `;
}

// ---------- 挂载辅助 ----------

export function mountTransfer(director, container) {
  return render(h(TransferPanel, { director }), container);
}
