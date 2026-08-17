const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

// --- UI Constants & Configuration ---
const RULER_HEIGHT = 24;
const BLOCK_HEIGHT = 160; // Increased to make the image timeline area much taller
const AUDIO_TRACK_HEIGHT = 80;
const VIDEO_TRACK_HEIGHT = 80;
const CANVAS_HEIGHT = RULER_HEIGHT + BLOCK_HEIGHT + AUDIO_TRACK_HEIGHT;
const HANDLE_HIT_PX = 14;
const MIN_SEGMENT_LENGTH = 6;
const MAX_THUMBNAIL_DIM = 512; // Increased to maintain quality for taller images

const HIDDEN_WIDGET_NAMES = [
  "timeline_data", "local_prompts", "segment_lengths", "guide_strength",
  "audio_data", "use_custom_audio", "inpaint_audio", "override_audio",
  // 全局参数：改由 transfer 面板 GlobalParamsPanel inline 编辑
  // （秒/帧两组均由面板按 display_mode 动态展示对应单位）
  "start_second", "end_second", "duration_seconds",
  "start_frame", "end_frame", "duration_frames",
  "frame_rate", "outpu_resolution", "million_pixels",
];

function hideWidget(w) {
  if (!w) return;

  w.hidden = true;
  if (!w.options) w.options = {};
  w.options.hidden = true;

  // Use computeSize and draw overrides to safely collapse in LiteGraph 
  // without triggering ComfyUI's "convert to input slot" auto-behavior.
  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    w.computeSize = () => [0, -4]; // -4 cancels out ComfyUI's hardcoded 4px widget padding
    if (!w._hiddenDrawHooked) {
      w._origDraw = w.hasOwnProperty('draw') ? w.draw : undefined;
      w._hiddenDrawHooked = true;
    }
    w.draw = () => { };
  }

  if (w.element) w.element.style.display = "none";
  if (w.callback) w.callback(w.value);
}

function showWidget(w) {
  if (!w) return;

  w.hidden = false;
  if (w.options) w.options.hidden = false;

  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    delete w.computeSize;
    if (w._hiddenDrawHooked) {
      if (w._origDraw !== undefined) {
        w.draw = w._origDraw;
      } else {
        delete w.draw;
      }
      delete w._hiddenDrawHooked;
    }
  }

  if (w.element) w.element.style.display = "";
  if (w.callback) w.callback(w.value);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// --- Shared utilities (deduplicated across modules) ---
// Unique id for timeline segments / temp entities.
const genId = () => Date.now().toString() + Math.random().toString(36).substr(2, 5);

// Build a /view? URL for a stored media key. fileKey may be "name.ext" or
// "subfolder/name.ext"; an explicit subfolder param is used when fileKey has no slash.
// type 默认 input；output 目录的首帧图等产物传 type="output"。
const viewUrl = (fileKey, subfolder = "", type = "input") => {
  const slash = fileKey.lastIndexOf("/");
  const fn = slash >= 0 ? fileKey.slice(slash + 1) : fileKey;
  const sf = slash >= 0 ? fileKey.slice(0, slash) : subfolder;
  return api.apiURL(`/view?filename=${encodeURIComponent(fn)}&type=${type}&subfolder=${encodeURIComponent(sf)}`);
};

// 与 viewUrl 等价，但走插件自带的 /minimax_ref/api/view_image 端点。
// 该端点强制返回 Content-Disposition: inline，使浏览器右键
// “在新标签页中打开图片”时能直接显示；官方 /view 对图片只返回裸
// filename="..."（无 inline 前缀），浏览器按 RFC 6266 缺省视作
// attachment 而直接下载，导致新标签页里看不到图片。
const viewUrlInline = (fileKey, subfolder = "", type = "input") => {
  const slash = fileKey.lastIndexOf("/");
  const fn = slash >= 0 ? fileKey.slice(slash + 1) : fileKey;
  const sf = slash >= 0 ? fileKey.slice(0, slash) : subfolder;
  return api.apiURL(`/minimax_ref/api/view_image?filename=${encodeURIComponent(fn)}&type=${type}&subfolder=${encodeURIComponent(sf)}`);
};

// Upload an image to the server. Returns { imageFile, imgUrl } or null on failure.
const uploadImage = async (file, subfolder = "minimaxrefdirector") => {
  try {
    const body = new FormData();
    body.append("image", file);
    body.append("subfolder", subfolder);
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (resp.status !== 200) return null;
    const data = await resp.json();
    const sf = data.subfolder || "";
    const imageFile = sf ? sf + "/" + data.name : data.name;
    return { imageFile, imgUrl: viewUrl(data.name, sf) };
  } catch (e) {
    console.error("[PromptRelay] Upload failed", e);
    return null;
  }
};

// --- Modern Dark/Grey UI CSS (ComfyUI Match), compact single-line rules ---
const STYLES = `
.pr-wrapper{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;display:flex;flex-direction:column;gap:8px;width:100%;height:100%;box-sizing:border-box;padding-bottom:4px}
.pr-gp-mount{width:100%;box-sizing:border-box;padding:6px 0 0;flex-shrink:0}
.pr-wrapper.drag-active{outline:2px dashed #888;background:rgba(255,255,255,0.05);border-radius:6px}
.pr-toolbar{display:flex;justify-content:space-between;align-items:center;padding:2px 0px;flex-wrap:wrap;gap:6px}
.pr-actions{display:flex;gap:6px;flex-wrap:wrap}
.pr-btn{background:#222;color:#e0e0e0;border:1px solid #111;border-radius:4px;padding:6px 12px;font-size:11px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all 0.2s ease}
.pr-btn:hover:not(:disabled){background:#333;border-color:#555}
.pr-btn.toggle-on{background:#1c222d;border-color:#283142;color:#e0e0e0}
.pr-btn.toggle-on:hover:not(:disabled){background:#2a3445;border-color:#3b4b66}
.pr-btn-danger:hover:not(:disabled){background:#4a1515;border-color:#cc4444;color:#ffaaaa}
.pr-canvas{background:#2a2a2a;cursor:pointer;width:100%;outline:none;display:block}
.pr-prop-container{display:flex;flex-direction:column;width:100%;flex:none;min-height:40px}
.pr-prompt-wrapper{position:relative;display:flex;flex-direction:column;width:100%;height:auto;min-height:120px;background:#222;border:1px solid #111;border-radius:6px;box-sizing:border-box;transition:border-color 0.2s ease,opacity 0.2s ease;overflow:hidden}
.pr-prompt-wrapper.focus-active{border-color:#888}
.pr-wrapper.has-focus .pr-prompt-wrapper:not(.focus-active),.pr-wrapper:has(.pr-prompt-wrapper.focus-active) .pr-prompt-wrapper:not(.focus-active){opacity:0.65}
.pr-prompt-label{position:static;flex-shrink:0;margin:6px 0 2px 8px;font-size:9px;font-weight:bold;color:#666;text-transform:uppercase;letter-spacing:0.5px;pointer-events:none;user-select:none}
.pr-prompt-area{width:100%;height:auto;min-height:120px;background:transparent;color:#e0e0e0;border:none;padding:4px 8px 8px 8px;resize:none;font-size:12px;line-height:1.4;box-sizing:border-box;outline:none;display:block}
.pr-prompt-area:focus{border-color:#888}
.pr-audio-info{width:100%;height:100%;background:#181818;color:#aaa;border:1px solid #111;border-radius:6px;padding:10px;font-size:12px;line-height:1.6;box-sizing:border-box;display:none}
.pr-audio-info span{color:#fff;font-weight:500}
.pr-controls-group{background:#1e1e1e;border:1px solid #333;border-radius:6px;padding:6px 10px;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;width:100%}
.pr-strength-row{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box}
.pr-height-resizer{height:6px;background:#2a2a2a;cursor:ns-resize;border-radius:3px;margin:2px 0;transition:background 0.15s;border:1px solid #1e1e1e}
.pr-height-resizer:hover{background:#444;border-color:#555}
.pr-strength-label{font-size:11px;font-weight:600;color:#fff;white-space:nowrap;margin-left:auto;user-select:none;-webkit-user-select:none}
.pr-strength-slider{-webkit-appearance:none;appearance:none;width:80px;height:4px;background:#444;border-radius:2px;outline:none;cursor:pointer;border:1px solid #222}
.pr-strength-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:#aaa;cursor:pointer}
.pr-strength-slider:disabled{opacity:0.3;cursor:not-allowed}
.pr-strength-input{font-size:12px;color:#fff;background:#222;border:1px solid #444;border-radius:4px;width:52px;text-align:center;padding:3px;user-select:none;-webkit-user-select:none}
.pr-strength-input::-webkit-outer-spin-button,.pr-strength-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.pr-strength-input[type=number]{-moz-appearance:textfield}
.pr-strength-input:disabled{opacity:0.35;cursor:not-allowed}
.pr-gap-menu{position:fixed;background:#1e1e1e;border:1px solid #444;border-radius:6px;padding:4px;display:flex;flex-direction:column;gap:4px;z-index:1000;box-shadow:0 4px 16px rgba(0,0,0,0.6)}
.pr-gap-menu-btn{background:#2a2a2a;color:#e0e0e0;border:1px solid #333;border-radius:4px;padding:6px 14px;font-size:11px;font-family:inherit;cursor:pointer;text-align:left;white-space:nowrap;display:flex;align-items:center;gap:6px;transition:background 0.15s ease}
.pr-gap-menu-btn:hover{background:#3a3a3a;border-color:#666}
.pr-player-controls{display:flex;justify-content:center;align-items:center;gap:12px;padding:2px 0;flex-wrap:wrap;width:100%}
.pr-icon-btn{background:#2a2a2a;border:1px solid #444;color:#eee;cursor:pointer;padding:6px 12px;border-radius:4px;display:flex;align-items:center;justify-content:center;transition:all 0.2s}
.pr-icon-btn *{pointer-events:none}
.pr-icon-btn:hover{color:#fff;background:#3a3a3a;border-color:#666}
.pr-icon-btn.active{color:#4fff8f;border-color:#4fff8f;background:#1a3a2a}
.pr-seek-bar{-webkit-appearance:none;appearance:none;height:6px;background:#444;border-radius:3px;outline:none;cursor:pointer;border:1px solid #222}
.pr-seek-bar::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#ff4444;cursor:pointer;border:2px solid #222}
.pr-timeline-viewport{width:100%;overflow-x:auto;overflow-y:hidden;padding-bottom:10px;box-sizing:content-box}
.pr-timeline-viewport::-webkit-scrollbar{height:10px}
.pr-timeline-viewport::-webkit-scrollbar-track{background:#151515;border-radius:5px}
.pr-timeline-viewport::-webkit-scrollbar-thumb{background:#444;border-radius:5px;border:1px solid #000}
.pr-timeline-viewport::-webkit-scrollbar-thumb:hover{background:#666;border-color:#000}
.pr-zoom-controls{display:flex;align-items:center;gap:4px;margin-left:12px}
.pr-zoom-slider{width:80px;-webkit-appearance:none;appearance:none;height:4px;background:#444;border-radius:2px;outline:none;cursor:pointer}
.pr-zoom-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:#aaa;cursor:pointer}
.pr-right-group{display:flex;align-items:center;gap:12px}
.pr-segment-bounds{font-size:12px;color:#aaa;font-family:monospace;user-select:none;-webkit-user-select:none}
.pr-timecode{font-size:14px;font-weight:bold;color:#e0e0e0;font-family:monospace;user-select:none;-webkit-user-select:none}
.pr-settings-menu{position:fixed;background:#1e1e1e;border:1px solid #444;border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px;z-index:1000;box-shadow:0 4px 20px rgba(0,0,0,0.7);min-width:250px}
.pr-settings-title{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:4px;border-bottom:1px solid #333;margin-bottom:2px}
.pr-settings-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pr-settings-label{font-size:12px;color:#bbb;flex:1;white-space:nowrap}
.pr-number-control{display:flex;align-items:center;border:1px solid #444;border-radius:4px;background:#2a2a2a;overflow:hidden}
.pr-number-btn{background:#333;color:#aaa;border:none;width:20px;height:22px;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;transition:background 0.15s;user-select:none}
.pr-number-btn:hover{background:#444;color:#fff}
.pr-settings-input{background:transparent;color:#e0e0e0;border:none;padding:0 4px;font-size:12px;width:50px;height:22px;text-align:center;font-family:monospace;outline:none;-moz-appearance:textfield}
.pr-settings-input::-webkit-outer-spin-button,.pr-settings-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.pr-settings-select{background:#2a2a2a;color:#e0e0e0;border:1px solid #444;border-radius:4px;padding:3px 4px;font-size:12px;width:98px;cursor:pointer}
.pr-settings-divider{border:none;border-top:1px solid #333;margin:4px 0}
.pr-settings-toggle-btn{width:100%;box-sizing:border-box;margin:0;background:#252525;color:#fff;border:1px solid #333;border-radius:4px;padding:5px 8px;font-size:11px;cursor:pointer;text-align:center;transition:all 0.15s}
.pr-settings-toggle-btn:hover{background:#2e2e2e;color:#fff;border-color:#555}
.pr-settings-close-btn{background:transparent;color:#888;border:none;cursor:pointer;padding:2px;display:flex;align-items:center;justify-content:center;border-radius:4px;transition:all 0.15s}
.pr-settings-close-btn:hover{color:#fff;background:rgba(255,255,255,0.1)}
.pr-segmented-control{display:flex;background:#1e1e1e;border:1px solid #333;border-radius:6px;padding:2px;width:110px;height:25px;align-items:center;box-sizing:border-box}
.pr-segment{flex:1;text-align:center;font-size:10px;font-weight:500;display:flex;align-items:center;justify-content:center;height:100%;cursor:pointer;border-radius:4px;color:#888;transition:all 0.15s ease}
.pr-segment.active{background:#333;color:#fff}
.tr-gp{display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;margin-top:2px}
.tr-gp-head{font-size:11px;font-weight:700;color:#cfcfcf;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:5px;border-bottom:1px solid #3a3a3a;display:flex;align-items:center;gap:6px}
.tr-gp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:6px}
.tr-gp-item{display:flex;flex-direction:column;gap:2px;min-width:0}
.tr-gp-label{font-size:10px;color:#fff;white-space:nowrap;user-select:none;-webkit-user-select:none}
.tr-gp-input{background:#222;color:#e0e0e0;border:1px solid #3a3a3a;border-radius:4px;padding:3px 6px;font-size:11px;font-family:monospace;width:100%;box-sizing:border-box;outline:none;transition:border-color 0.15s ease}
.tr-gp-input:hover{border-color:#555}
.tr-gp-input:focus{border-color:#888}
.tr-gp-input::-webkit-outer-spin-button,.tr-gp-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.tr-gp-input[type=number]{-moz-appearance:textfield}
.tr-gp-select{background:#222;color:#e0e0e0;border:1px solid #3a3a3a;border-radius:4px;padding:3px 6px;font-size:11px;width:100%;box-sizing:border-box;outline:none;cursor:pointer}
.tr-gp-select:hover{border-color:#555}
.tr-gp-select:focus{border-color:#888}
.tr-gap-hr{height:1px;background:#fff;transform:scaleY(.2)}
/* --- Output 配置 toolbar（全局参数下方） --- */
.pr-out-mount{width:100%;box-sizing:border-box;flex-shrink:0}
.tr-out{display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;margin-top:2px}
.tr-out-head{font-size:11px;font-weight:700;color:#cfcfcf;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:5px;border-bottom:1px solid #3a3a3a}
.tr-out-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:6px}
.tr-out-item{display:flex;flex-direction:column;gap:2px;min-width:0}
.tr-out-label{font-size:10px;color:#fff;white-space:nowrap;user-select:none;-webkit-user-select:none}
.tr-out-select{background:#222;color:#e0e0e0;border:1px solid #3a3a3a;border-radius:4px;padding:3px 6px;font-size:11px;width:100%;box-sizing:border-box;outline:none;cursor:pointer}
.tr-out-select:hover{border-color:#555}
.tr-out-select:focus{border-color:#888}
.tr-out-input{background:#222;color:#e0e0e0;border:1px solid #3a3a3a;border-radius:4px;padding:3px 6px;font-size:11px;font-family:monospace;width:100%;box-sizing:border-box;outline:none;transition:border-color 0.15s ease}
.tr-out-input:hover{border-color:#555}
.tr-out-input:focus{border-color:#888}
.tr-out-input::-webkit-outer-spin-button,.tr-out-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.tr-out-input[type=number]{-moz-appearance:textfield}
/* --- VIDEO 结果轨 --- */
.pr-video-body{flex:1;min-height:0}
.pr-video-row{font-size:10px;color:#8f8;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5}
.pr-video-row a{color:#7ec8ff;text-decoration:none}
.pr-video-row a:hover{text-decoration:underline}
.pr-video-badge{color:#8f8;flex-shrink:0}
`;

const STYLE_VERSION = "20260816-d"; // 开发期改样式后递增；在 DevTools Console 检查是否打印，确认浏览器加载的是最新模块
// 注意：id 必须唯一！WhatDreamsCost-ComfyUI 的 ltx_director.js 也用 "prompt-relay-styles" 并会覆盖 textContent，
// 因此这里使用本扩展专属 id 避免样式被整体覆盖。
const STYLE_ID = "minimax-ref-director-styles";
let styleEl = document.getElementById(STYLE_ID);
if (!styleEl) {
  styleEl = document.createElement("style");
  styleEl.id = STYLE_ID;
  document.head.appendChild(styleEl);
}
styleEl.textContent = `/* MiniMaxRefDirector styles v${STYLE_VERSION} */\n${STYLES}`;
console.info(`[MiniMaxRefDirector] styles injected v${STYLE_VERSION} (id: ${STYLE_ID})`);

// --- 诊断：确认 CSS 规则真的在文档中 + 自动报告 .tr-gp 挂载状态 ---
// 1) 检查注入的 <style> 是否仍在 head 且包含 tr-gp 规则
const checkCssRules = () => {
  let rulesFound = 0;
  for (const sheet of document.styleSheets) {
    if (sheet.ownerNode !== styleEl) continue;
    try {
      for (const r of sheet.cssRules) {
        if (r.selectorText && r.selectorText.includes(".tr-gp")) rulesFound++;
      }
    } catch (e) { /* 跨域样式表不可读，忽略 */ }
  }
  console.info(`[MiniMaxRefDirector] styleEl in head: ${document.head.contains(styleEl)}, tr-gp cssRules found: ${rulesFound}`);
};
// 2) 监听 DOM：director 节点创建/选中后 .tr-gp 挂载时自动报告（避免页面加载瞬间误报 not-yet）
const trGpReport = (el) => {
  const style = el ? window.getComputedStyle(el) : null;
  console.info(
    `[MiniMaxRefDirector] tr-gp mounted: ${!!el}` + (style ? `, display=${style.display}, visibility=${style.visibility}, flexDirection=${style.flexDirection}` : "")
  );
  if (el) trGpObserver.disconnect();
};
const trGpObserver = new MutationObserver(() => {
  const el = document.querySelector(".tr-gp");
  if (el) trGpReport(el);
});
trGpObserver.observe(document.documentElement, { childList: true, subtree: true });
setTimeout(() => { trGpReport(document.querySelector(".tr-gp")); trGpObserver.disconnect(); }, 20000); // 20s 兜底：即使未选中节点也报告一次
checkCssRules();

// --- Icons ---
const ICONS = {
  upload: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`,
  audio: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,
  trash: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  text: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>`,
  play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
  pause: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
  loop: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12A9 9 0 0 0 6 5.3L3 8"></path><polyline points="3 3 3 8 8 8"></polyline><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"></path><polyline points="21 21 21 16 16 16"></polyline></svg>`,
  minus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  fit: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><polyline points="8 7 3 12 8 17"></polyline><polyline points="16 7 21 12 16 17"></polyline></svg>`,
  gear: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  close: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  start: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3H13.5a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" /></svg>`,
  end: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" /></svg>`,
  mark: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3H7.5a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" /><path d="M15.5 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" /></svg>`,
  help: `<svg width="14" height="14" viewBox="-5 -5 38 38" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10.398,22.811h4.618v4.964h-4.618V22.811z M21.058,1.594C19.854,0.532,17.612,0,14.33,0c-3.711,0-6.205,0.514-7.482,1.543 c-1.277,1.027-1.916,3.027-1.916,6L4.911,8.551h4.577l-0.02-1.049c0-1.424,0.303-2.377,0.907-2.854 c0.604-0.477,1.814-0.717,3.632-0.717c1.936,0,3.184,0.228,3.74,0.676c0.559,0.451,0.837,1.457,0.837,3.017 c0,1.883-0.745,3.133-2.237,3.752l-1.797,0.766c-1.882,0.781-3.044,1.538-3.489,2.27c-0.442,0.732-0.665,2.242-0.665,4.529h4.68 v-0.646c0-1.41,0.987-2.533,2.965-3.365c2.03-0.861,3.343-1.746,3.935-2.651c0.592-0.908,0.888-2.498,0.888-4.771 C22.863,4.625,22.261,2.655,21.058,1.594z"/></svg>`,
  magnet: `<svg width="15" height="15" viewBox="-30 -55 580 580" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path stroke="currentColor" stroke-width="15" stroke-linejoin="round" stroke-linecap="round" d="M502.915,274.353l-64.2-64.2c-5.5-5.5-14.4-5.5-19.9,0l-155.1,155c-45.4,45.4-99.2,20.4-119.6,0 c-20.3-20.3-45.8-73.8,0-119.6l155.1-155c5.5-5.5,5.5-14.4,0-19.9l-64.2-64.2c-2.6-2.6-9.9-9.9-19.9,0l-155.1,155 c-101.4,116.1-55.4,232.4,0,287.9c49.4,49.4,171.9,99.3,287.8,0l155.1-155.1C512.915,284.253,505.615,276.953,502.915,274.353z M225.115,36.253l44.3,44.3l-26,26l-44.3-44.3L225.115,36.253z M328.015,429.453c-61.3,61.3-175.2,72.8-248,0 c-72.9-72.9-64.9-183.1,0-248l99.2-99.2l44.3,44.3l-99.2,99.2c-47.5,47.5-45.1,114.2,0,159.4c44.8,44.8,114.4,45,159.4,0 l99.2-99.2l44.3,44.3L328.015,429.453z M447.115,310.253l-44.3-44.3l26-26l44.3,44.3L447.115,310.253z"/></svg>`
};

// --- Data Models ---
function parseInitial(jsonStr) {
  let parsed = {
    segments: [],
    audioSegments: [],
    mainTrackEnabled: true,
    audioTrackEnabled: true,
    propHeight: 90,
    showFilenames: true,
    overrideAudio: false,
    inpaint_audio: true,
    normalStartFrame: 0,
    normalDurationFrames: 120
  };
  try {
    if (jsonStr) {
      const p = JSON.parse(jsonStr);
      if (p.mainTrackEnabled !== undefined) parsed.mainTrackEnabled = p.mainTrackEnabled;
      if (p.audioTrackEnabled !== undefined) parsed.audioTrackEnabled = p.audioTrackEnabled;
      if (p.propHeight !== undefined) parsed.propHeight = p.propHeight;
      if (p.showFilenames !== undefined) parsed.showFilenames = p.showFilenames;
      if (p.overrideAudio !== undefined) parsed.overrideAudio = p.overrideAudio;
      if (p.inpaint_audio !== undefined) parsed.inpaint_audio = p.inpaint_audio;
      if (p.normalStartFrame !== undefined) parsed.normalStartFrame = p.normalStartFrame;
      if (p.normalDurationFrames !== undefined) parsed.normalDurationFrames = p.normalDurationFrames;
      if (Array.isArray(p.segments)) {
        parsed.segments = p.segments.map(s => {
          const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
          return rest;
        });
      }
      if (Array.isArray(p.audioSegments)) {
        parsed.audioSegments = p.audioSegments.map(s => {
          const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, ...rest } = s;
          return rest;
        });
      }
    }
  } catch (e) { }

  let currentStart = 0;
  for (let seg of parsed.segments) {
    if (seg.start === undefined) {
      seg.start = currentStart;
      currentStart += seg.length;
    }
    // Guarantee ID assignment to prevent node loading drag breaks
    if (!seg.id) {
      seg.id = genId();
    }
  }

  for (let seg of parsed.audioSegments) {
    if (!seg.id) {
      seg.id = genId();
    }
    if (seg.trimStart === undefined) seg.trimStart = 0;
  }

  return parsed;
}


export { app, api, RULER_HEIGHT, BLOCK_HEIGHT, AUDIO_TRACK_HEIGHT, VIDEO_TRACK_HEIGHT, CANVAS_HEIGHT, HANDLE_HIT_PX, MIN_SEGMENT_LENGTH, MAX_THUMBNAIL_DIM, HIDDEN_WIDGET_NAMES, hideWidget, showWidget, clamp, genId, viewUrl, viewUrlInline, uploadImage, ICONS, parseInitial, STYLES, styleEl };
