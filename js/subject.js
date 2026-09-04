import { app } from "../../scripts/app.js";
import { viewUrl } from "./components/director/shared.js";
import { createHighlightedTextarea } from "./components/director/highlight.js";
import { api } from "../../scripts/api.js";
import { getLocale, t } from "./i18n.js";
import { h, Fragment, render } from "./vendor/preact.module.js";
import { useEffect, useRef, useLayoutEffect } from "./vendor/hooks.module.js";
import htm from "./vendor/htm.module.js";

const html = htm.bind(h);

// ============================================================
// 【可调常量】Subject 主体列表高度封顶（px）
// 主体卡片较多时，列表在 max-height 内内部滚动，节点高度不再无限增长。
// 调大 → 节点一次显示更多卡片、更晚出现内部滚动条；
// 调小 → 卡片更早收进内部滚动区、节点整体更矮。
// 只改这一个值即可（CSS 与高度测量均已引用此常量）。
const SUBJECT_LIST_MAX_HEIGHT = 740;
// ============================================================

function hideWidget(w) {
    if (!w) return;
    w.hidden = true;
    if (!w.options) w.options = {};
    w.options.hidden = true;
    if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
        w.computeSize = () => [0, -4];
        if (!w._hiddenDrawHooked) {
            w._origDraw = w.hasOwnProperty('draw') ? w.draw : undefined;
            w._hiddenDrawHooked = true;
        }
        w.draw = () => { };
    }
    if (w.element) w.element.style.display = "none";
}

const MSCSS = `
.ref-ms-wrapper {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 6px 6px 6px;
}
.ref-ms-wrapper::-webkit-scrollbar {
    width: 6px;
}
.ref-ms-wrapper::-webkit-scrollbar-track {
    background: #151515;
    border-radius: 3px;
}
.ref-ms-wrapper::-webkit-scrollbar-thumb {
    background: #444;
    border-radius: 3px;
}
.ref-ms-subject-list {
    /* 流式 grid：列数按容器宽度自适应，列宽填满不留空
       （≥686px 排 2 列，≥1032px 排 3 列，即 760 两列一行、1080 三列一行） */
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 6px;
    align-items: start;
    /* tab 列表高度封顶：卡片较多时列表内部滚动，节点高度不再随卡片数无限增长 */
    max-height: ${SUBJECT_LIST_MAX_HEIGHT}px;
    overflow-y: auto;
    min-height: 0;
}
.ref-ms-subject-list::-webkit-scrollbar {
    width: 6px;
}
.ref-ms-subject-list::-webkit-scrollbar-track {
    background: transparent;
    border-radius: 3px;
}
.ref-ms-subject-list::-webkit-scrollbar-thumb {
    background: #444;
    border-radius: 3px;
}
.ref-ms-subject-list::-webkit-scrollbar-thumb:hover {
    background: #5a5a5a;
}
.ref-ms-subject-card {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    transition: border-color 0.2s;
    min-width: 0;
}
.ref-ms-subject-card:hover {
    border-color: #555;
}
/* ---- Definition 行下方的媒体引用上传条（图片≤9 / 视频≤3 / 音频≤1 固定最右）---- */
.ref-ms-upload-strip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    border-radius: 5px;
    min-height: 52px;
}
.ref-ms-row-footer {
    margin-top: 4px;
}
.ref-ms-upload-zone {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
}
.ref-ms-upload-zone.flex {
    flex: 1;
    min-width: 0;
}
.ref-ms-upload-zone.audio {
    flex-shrink: 0;
    margin-left: auto;
}
/* 引用资源上传条外层：label 引用资源 + 黄色小字提示 + 原横条 */
.ref-ms-upload-row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    width: 100%;
    margin-top: 2px;
    box-sizing: border-box;
}
.ref-ms-upload-cap {
    font-size: 10px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    line-height: 1.5;
    user-select: none;
}
.ref-ms-upload-hint {
    font-size: 9px;
    color: #fbbf24;
    opacity: 0.9;
    line-height: 1.4;
    user-select: none;
}
/* 图片/视频缩略图可点击插入 <@名称> */
.ref-ms-child-thumb.clickable {
    cursor: pointer;
}
.ref-ms-child-thumb {
    position: relative;
    width: 52px;
    height: 52px;
    border-radius: 4px;
    overflow: hidden;
    background: #222;
    border: 1px solid #444;
    flex-shrink: 0;
    box-sizing: border-box;
}
.ref-ms-child-thumb.audio {
    width: auto;
    min-width: 72px;
    max-width: 120px;
    height: 52px;
}
.ref-ms-child-thumb img,
.ref-ms-child-thumb video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    background: #000;
}
.ref-ms-child-thumb .cicon {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: 4px;
    color: #38bdf8;
    font-size: 8px;
    overflow: hidden;
    padding: 2px 4px;
    box-sizing: border-box;
}
.ref-ms-child-thumb .cicon svg {
    flex-shrink: 0;
}
.ref-ms-child-thumb .fname {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #ccc;
}
/* 缩略图类型角标：帮助区分 图片 / 视频 / 音频 */
.ref-ms-child-thumb .type-badge {
    position: absolute;
    left: 1px;
    bottom: 1px;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: 1px;
    max-width: calc(100% - 4px);
    padding: 1px 3px;
    border-radius: 2px;
    background: rgba(0, 0, 0, 0.72);
    color: #93c5fd;
    font-size: 7px;
    line-height: 1.3;
    box-sizing: border-box;
    pointer-events: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
}
.ref-ms-child-thumb .type-badge svg {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
}
.ref-ms-child-thumb .type-badge.video {
    color: #fcd34d;
}
.ref-ms-child-thumb .type-badge.audio {
    color: #c4b5fd;
}
/* 缩略图 视频/音频 hover 中央播放按钮 */
.ref-ms-child-thumb .child-thumb-play {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 3;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: none;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    margin: 0;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s;
    box-sizing: border-box;
}
.ref-ms-child-thumb:hover .child-thumb-play,
.ref-ms-child-thumb .child-thumb-play.playing {
    opacity: 1;
}
.ref-ms-child-thumb .child-thumb-play:hover {
    background: rgba(56, 189, 248, 0.85);
    color: #0b1220;
}
.ref-ms-child-thumb .child-thumb-play.playing {
    background: rgba(0, 0, 0, 0.6);
}
/* 音频缩略图没有画面内容，播放按钮常驻右下角，且不遮挡文件名主体 */
.ref-ms-child-thumb.audio .child-thumb-play {
    top: auto;
    left: auto;
    right: 4px;
    bottom: 4px;
    transform: none;
    width: 18px;
    height: 18px;
    opacity: 1;
    background: rgba(56, 189, 248, 0.28);
    color: #7dd3fc;
}
.ref-ms-child-thumb.audio .child-thumb-play:hover {
    background: #38bdf8;
    color: #0b1220;
}
.ref-ms-child-del {
    position: absolute;
    top: 1px;
    right: 1px;
    z-index: 5;
    width: 15px;
    height: 15px;
    border-radius: 3px;
    border: none;
    background: rgba(0, 0, 0, 0.75);
    color: #ff8888;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 0;
}
.ref-ms-child-thumb:hover .ref-ms-child-del {
    display: flex;
}
.ref-ms-child-del:hover {
    background: #cc4444;
    color: #fff;
}
.ref-ms-upload-add {
    width: 52px;
    height: 52px;
    border: 1px dashed #555;
    background: transparent;
    color: #777;
    border-radius: 4px;
    cursor: pointer;
    flex-shrink: 0;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    font-size: 7px;
    line-height: 1;
    transition: all 0.15s;
    padding: 0;
    box-sizing: border-box;
}
.ref-ms-upload-add:hover:not(:disabled) {
    border-color: #8ab4f8;
    color: #8ab4f8;
    background: rgba(138, 180, 248, 0.08);
}
.ref-ms-upload-add:disabled {
    opacity: 0.3;
    cursor: not-allowed;
}
.ref-ms-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.ref-ms-card-index {
    font-size: 10px;
    font-weight: 700;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.ref-ms-card-remove {
    background: #222;
    color: #e0e0e0;
    border: 1px solid #111;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    padding: 4px 10px;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    gap: 4px;
}
.ref-ms-card-remove:hover:not(:disabled) {
    background: #4a1515;
    border-color: #cc4444;
    color: #ffaaaa;
}
.ref-ms-row {
    display: flex;
    gap: 6px;
    align-items: center;
    justify-content: flex-end;
}
.ref-ms-row-group {
    display: flex;
    flex: 1;
    gap: 6px;
    align-items: center;
}
.ref-ms-label,.ref-ms-label-sm {
    font-size: 10px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex: 0 0 auto;
    white-space: nowrap;
    line-height: 1.5;
    text-align: left;
    user-select: none;
    min-width: 60px;
}
.ref-ms-input {
    flex: 1;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 4px 8px;
    font-size: 12px;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.2s;
}
.ref-ms-input:focus {
    border-color: #888;
}
.ref-ms-select {
    flex: 1;
    min-width: 0;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 4px 6px;
    font-size: 11px;
    outline: none;
    box-sizing: border-box;
    cursor: pointer;
    transition: border-color 0.2s;
}
.ref-ms-select:focus {
    border-color: #888;
}
.ref-ms-select option {
    background: #1e1e1e;
    color: #e0e0e0;
}
.ref-ms-textarea {
    flex: 1;
    min-width: 0;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 3px 8px;
    font-size: 11px;
    outline: none;
    resize: vertical;
    min-height: 90px;
    box-sizing: border-box;
    transition: border-color 0.2s;
}
.ref-ms-textarea:focus {
    border-color: #888;
}
.ref-ms-cell {
    flex: 1 1 50%;
    min-width: 0;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6px;
}
.ref-ms-retention {
    flex: 1;
    min-width: 0;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 3px 8px;
    font-size: 11px;
    outline: none;
    resize: none;
    min-height: 60px;
    line-height: 1.35;
    box-sizing: border-box;
    transition: border-color 0.2s;
}
.ref-ms-retention:focus {
    border-color: #888;
}
.ref-ms-input.required-missing {
    border-color: #e0533d;
}
/* --- Type tabs --- */
.ref-ms-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
}
.ref-ms-tab {
    flex: 1;
    padding: 4px 6px;
    font-size: 11px;
    text-align: center;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    transition: all 0.15s;
}
.ref-ms-tab:hover {
    border-color: #38bdf8;
    color: #fff;
}
.ref-ms-tab.active {
    background: #38bdf8;
    border-color: #38bdf8;
    color: #0b1220;
    font-weight: 600;
}
/* --- Global Prompt area --- */
.ref-ms-global-prompt {
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 6px 8px;
    box-sizing: border-box;
    flex-shrink: 0;
}
.ref-ms-global-prompt-label {
    font-size: 10px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.ref-ms-global-prompt-input {
    width: 100%;
    background: transparent;
    color: #e0e0e0;
    border: none;
    resize: none;
    font-size: 12px;
    line-height: 1.4;
    box-sizing: border-box;
    outline: none;
    height: 100%;
    min-height: 90px;
}
.ref-ms-global-prompt-input:focus {
    border-color: #888;
}
/* --- Media box styles (attached to desc row, right-aligned image & audio) --- */
.ref-ms-media-box {
    width: 90px;
    height: 90px;
    border: 1px dashed #444;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    background: #252525;
    transition: all 0.2s ease;
    flex-shrink: 0;
}
.ref-ms-media-box:hover {
    border-color: #666;
    background: #2a2a2a;
}
.ref-ms-media-box.has-file {
    border-style: solid;
    border-color: #38bdf8;
    background: rgba(56, 189, 248, 0.05);
}
.ref-ms-media-box img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}
.ref-ms-media-box video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    background: #000;
    cursor: pointer;
}
/* 视频单独一行：大图预览，支持播放/替换/删除 */
.ref-ms-video-row {
    position: relative;
    height: 136px;
    width: 100%;
    border: 1px dashed rgba(255, 255, 255, 0.18);
    border-radius: 6px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.03);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 6px;
    cursor: pointer;
}
.ref-ms-video-row.has-file {
    border-style: solid;
    background: #000;
}
.ref-ms-video-row video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    background: #000;
}
/* 视频右下角浮动按钮：不遮挡视频主体，悬停显示，可正常播放 */
.ref-ms-video-actions {
    position: absolute;
    right: 6px;
    bottom: 6px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 2;
    pointer-events: none;
}
.ref-ms-video-row:hover .ref-ms-video-actions {
    opacity: 1;
    pointer-events: auto;
}
.ref-ms-video-action {
    padding: 2px 8px;
    font-size: 10px;
    line-height: 1.4;
    border: none;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    cursor: pointer;
    backdrop-filter: blur(2px);
}
.ref-ms-video-action:hover {
    background: #38bdf8;
    color: #0b1220;
}
.ref-ms-video-action.del:hover {
    background: #ef5350;
    color: #fff;
}
.ref-ms-media-icon {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    color: #666;
    font-size: 10px;
    transition: color 0.2s;
}
.ref-ms-media-box:hover .ref-ms-media-icon {
    color: #aaa;
}
.ref-ms-media-box.has-file > img ~ .ref-ms-media-icon {
    display: none;
}

/* Overlay for hover controls */
.ref-ms-media-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    opacity: 0;
    transition: opacity 0.2s;
    pointer-events: none;
}
.ref-ms-media-box:hover .ref-ms-media-overlay {
    opacity: 1;
    pointer-events: auto;
}

.ref-ms-media-action {
    background: transparent;
    border: 1px solid #888;
    color: #ccc;
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 10px;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
    line-height: 1.3;
}
.ref-ms-media-action:hover {
    background: #333;
    color: #fff;
    border-color: #bbb;
}
.ref-ms-media-action.del:hover {
    background: #4a1515;
    border-color: #cc4444;
    color: #ffaaaa;
}
.ref-ms-media-action.play-btn:hover {
    background: rgba(56, 189, 248, 0.15);
    border-color: #38bdf8;
    color: #38bdf8;
}
.ref-ms-add-btn {
    background: #222;
    color: #e0e0e0;
    border: 1px solid #111;
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: center;
    transition: all 0.2s ease;
    text-align: center;
    width: 100%;
    box-sizing: border-box;
}
.ref-ms-add-btn:hover:not(:disabled) {
    background: #333;
    border-color: #555;
}
.ref-ms-add-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
}
.ref-ms-footer {
    font-size: 10px;
    color: #555;
    text-align: center;
    padding: 4px 0;
}
.ref-ms-mention-popup {
    position: fixed;
    z-index: 9999;
    min-width: 170px;
    max-width: 280px;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
    padding: 4px;
    display: none;
    box-sizing: border-box;
    flex-direction: column;
    overflow: hidden;
}
.ref-ms-mention-popup.open {
    display: flex;
}
/* 顶部主体类型 tab 条：固定不随列表滚动，选中态亮蓝强调 */
.ref-ms-mention-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 0 4px;
    margin-bottom: 4px;
    border-bottom: 1px solid #333;
    flex: 0 0 auto;
    overflow-x: auto;
    scrollbar-width: none;
}
.ref-ms-mention-tabs::-webkit-scrollbar {
    display: none;
}
.ref-ms-mention-tab {
    font-size: 9px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border: 1px solid #444;
    border-radius: 3px;
    background: transparent;
    padding: 1px 6px;
    cursor: pointer;
    white-space: nowrap;
    flex: 0 0 auto;
    line-height: 1.4;
}
.ref-ms-mention-tab:hover {
    color: #aaa;
    border-color: #555;
}
.ref-ms-mention-tab.active {
    color: #4fc3f7;
    background: rgba(79, 195, 247, 0.18);
    border-color: rgba(79, 195, 247, 0.5);
}
/* 主体列表容器：纵向滚动，max-height 由 popup 顶部 tab 条让位 */
.ref-ms-mention-list {
    overflow-y: auto;
    max-height: 176px;
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

let styleEl = document.getElementById("minimax-subject-styles");
if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "minimax-subject-styles";
    document.head.appendChild(styleEl);
}
styleEl.textContent = MSCSS;

// --- @mention 主体选择器（描述输入框输入 @ 弹出，插入 <@name> 供 H3 绑定） ---
let mentionPopup = null;
let mentionCtx = null; // { ta, uid, start, query, items, active, save, allSubjects }

document.addEventListener("mousedown", (e) => {
    if (mentionPopup && !mentionPopup.contains(e.target)) closeMention();
}, true);

function closeMention() {
    if (mentionPopup) {
        mentionPopup.classList.remove("open");
        mentionPopup.innerHTML = "";
        delete mentionPopup.dataset.tab; // 重置 tab 选中，下次打开回到「全部」
    }
    mentionCtx = null;
}

function buildMentionPopup() {
    if (!mentionPopup) {
        mentionPopup = document.createElement("div");
        mentionPopup.className = "ref-ms-mention-popup";
        document.body.appendChild(mentionPopup);
    }
    return mentionPopup;
}

function positionMentionPopup(ta) {
    const rect = ta.getBoundingClientRect();
    const pop = buildMentionPopup();
    pop.style.left = rect.left + "px";
    pop.style.top = (rect.bottom + 4) + "px";
    const popW = pop.offsetWidth || 200;
    if (rect.left + popW > window.innerWidth - 8) {
        pop.style.left = Math.max(8, window.innerWidth - popW - 8) + "px";
    }
}

function mentionQuery(ta) {
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return null;
    const v = ta.value;
    if (pos > 0 && v[pos - 1] === ">") return null; // 已闭合 <@name> 之后不触发
    const m = v.slice(0, pos).match(/@([^@\s>]*)$/);
    if (!m) return null;
    return { start: m.index, query: m[1] };
}

function setMentionActive(i) {
    if (!mentionCtx) return;
    mentionCtx.active = i;
    const pop = buildMentionPopup();
    const list = pop.querySelector(".ref-ms-mention-list");
    if (!list) return;
    [...list.children].forEach((el, j) => {
        el.classList.toggle("active", j === i);
    });
}

// 主体媒体展示：audio → 音频图标；video → 视频图标；image → 图片；无媒体 → "T"（文本主体）
function mentionMedia(s, size) {
    const typev = s.type || "Subject";
    const base = {
        width: size + "px",
        height: size + "px",
        borderRadius: "3px",
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.5) + "px",
        fontStyle: "normal",
        lineHeight: 1,
        background: "#1e3a5f",
        color: "#38bdf8",
    };
    if (typev === "Audio" || (s.audioFile && !s.imageFile && !s.videoFile) || (s.audioRef && typev === "Subject")) {
        const el = document.createElement("span");
        el.title = t("Audio");
        el.textContent = "♪";
        Object.assign(el.style, base);
        return el;
    }
    if (typev === "Video" || s.videoFile) {
        const el = document.createElement("span");
        el.title = t("Video");
        el.textContent = "▶";
        Object.assign(el.style, base, { color: "#a5d6a7" });
        return el;
    }
    if (typev === "Picture" || s.imageFile || s.imageB64) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = s.imageB64 || (s.imageFile ? viewUrl(s.imageFile, "minimaxrefdirector") : "");
        Object.assign(img.style, base, { objectFit: "cover" });
        return img;
    }
    // 无媒体 → 文本主体 T 徽标
    const el = document.createElement("span");
    el.title = t("Text");
    el.textContent = "T";
    Object.assign(el.style, base, { background: "#333", color: "#ccc" });
    return el;
}

function acceptMention() {
    const ctx = mentionCtx;
    if (!ctx) return;
    const item = ctx.items[ctx.active];
    if (!item) return;
    const insert = `<@${item.s.name.trim()}>`;
    const end = ctx.start + 1 + ctx.query.length; // @ + query 的结束位置
    const newVal = ctx.ta.value.slice(0, ctx.start) + insert + ctx.ta.value.slice(end);
    ctx.ta.value = newVal;
    const caret = ctx.start + insert.length;
    ctx.ta.focus();
    ctx.ta.setSelectionRange(caret, caret);
    if (ctx.save) ctx.save(newVal);
    closeMention();
}

// 渲染弹窗内容：顶部主体类型 tab 条（全部 / 可引用类型）+ 列表容器。
// 当前 tab 存 pop.dataset.tab（popup 为缓存单例：input 重建时保持选中态，
// closeMention 时重置回到「全部」）。tab 点击仅重渲染列表，不重建 mentionCtx
// （保留 caret / query，键盘导航与 active 索引随之更新）。
function renderMentionList(pop, allowed) {
    const ctx = mentionCtx;
    if (!ctx) return;
    const tab = pop.dataset.tab || "";
    pop.innerHTML = "";
    // 顶部 tab 条："" 表示「全部」，其余为当前主体可引用的类型
    const tabTypes = [""].concat(allowed || []);
    const tabs = document.createElement("div");
    tabs.className = "ref-ms-mention-tabs";
    tabTypes.forEach((tabType) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ref-ms-mention-tab" + (tabType === tab ? " active" : "");
        b.textContent = tabType || t("All");
        b.addEventListener("mousedown", (e) => {
            e.preventDefault(); // 保持 textarea 焦点
            if (pop.dataset.tab === tabType) return;
            pop.dataset.tab = tabType;
            renderMentionList(pop, allowed);
        });
        tabs.appendChild(b);
    });
    pop.appendChild(tabs);
    // 列表容器（滚动区域）
    const list = document.createElement("div");
    list.className = "ref-ms-mention-list";
    // 过滤链：排除自身 + allowed 类型 + 名称非空 + 关键词匹配 + 当前 tab 类型
    ctx.items = ctx.allSubjects
        .map((s) => ({ s }))
        .filter(({ s }) => (s.uid || "") !== ctx.uid && allowed.includes(s.type) && (s.name || "").trim()
            && s.name.toLowerCase().includes(ctx.query.toLowerCase())
            && (tab === "" || s.type === tab));
    ctx.active = 0;
    if (ctx.items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ref-ms-mention-empty";
        empty.textContent = t("No subjects available");
        list.appendChild(empty);
    } else {
        ctx.items.forEach((it, i) => {
            const item = document.createElement("div");
            item.className = "ref-ms-mention-item" + (i === 0 ? " active" : "");
            const type = document.createElement("span");
            type.className = "ref-ms-mention-type";
            type.textContent = t(it.s.type || "Subject");
            const name = document.createElement("span");
            name.textContent = it.s.name;
            item.appendChild(mentionMedia(it.s, 22));
            item.appendChild(name);
            item.appendChild(type);
            item.addEventListener("mousedown", (e) => {
                e.preventDefault(); // 保持 textarea 焦点
                mentionCtx.active = i;
                acceptMention();
            });
            item.addEventListener("mouseenter", () => setMentionActive(i));
            list.appendChild(item);
        });
    }
    pop.appendChild(list);
}

function updateMention(ta, uid, subjects, save, allowedOverride) {
    const q = mentionQuery(ta);
    if (!q) { closeMention(); return; }
    // 默认按 REF_MENTION_TYPES 过滤；retention 场景可传 allowedOverride 扩展可选类型
    const subj = subjects.find((s) => (s.uid || "") === uid);
    const allowed = allowedOverride || (subj && REF_MENTION_TYPES[subj.type]) || [];
    const pop = buildMentionPopup();
    mentionCtx = { ta, uid, start: q.start, query: q.query, items: [], active: 0, save, allSubjects: subjects };
    renderMentionList(pop, allowed);
    pop.classList.add("open");
    positionMentionPopup(ta);
}

function attachMention(ta, uid, subjects, save, opts) {
    const allowed = opts && opts.allowedTypes ? opts.allowedTypes : null;
    const onInput = () => updateMention(ta, uid, subjects, save, allowed);
    const onKeydown = (e) => {
        if (!mentionCtx) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setMentionActive(Math.min(mentionCtx.active + 1, mentionCtx.items.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setMentionActive(Math.max(mentionCtx.active - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            acceptMention();
        } else if (e.key === "Escape") {
            e.preventDefault();
            closeMention();
        }
    };
    const onBlur = () => {
        setTimeout(() => closeMention(), 120);
    };
    ta.addEventListener("input", onInput);
    ta.addEventListener("keydown", onKeydown);
    ta.addEventListener("blur", onBlur);
    // Preact 复用 DOM 时组件卸载需要解绑；再次挂载会重新 attach
    return () => {
        ta.removeEventListener("input", onInput);
        ta.removeEventListener("keydown", onKeydown);
        ta.removeEventListener("blur", onBlur);
    };
}

// 图像类主体（Subject / Picture / Video）的关系选项
const REF_RELATIONSHIPS_SUBJECT = [
    ["fully_preserved", "fully preserved", "The defined role of the referenced content is fully preserved"],
    ["partially_preserved", "partially preserved", "The referenced content is still used, but some defined characteristics are changed or only partially retained"],
    ["attribute_transfer", "attribute transfer", "Referenced characteristics are transferred to a different identifiable target subject"],
    ["weak_reference", "weak reference", "Only broad similarity in style, category, composition, or atmosphere is retained"],
];

const REF_RELATIONSHIPS_PV = [
    ["fully_preserved", "fully preserved", "The defined role of the referenced content is fully preserved"],
    ["partially_preserved", "partially preserved", "The referenced content is still used, but some defined characteristics are changed or only partially retained"],
    ["attribute_transfer", "attribute transfer", "Referenced characteristics are transferred to a different identifiable target subject"],
    ["weak_reference", "weak reference", "Only broad similarity in style, category, composition, or atmosphere is retained"],
];

// Audio 的关系选项
const REF_RELATIONSHIPS_AUDIO = [
    ["fully_copy", "fully copy", "The complete source audio serves as the target video's complete final audio track"],
    ["partially_copy", "partially copy", "Only part of the timeline or selected audio layers are copied, or other sounds are added, removed, or replaced after copying"],
    ["reference", "reference", "The signal is not copied directly; only timbre, rhythm, music style, dialogue content, or sound texture is referenced"],
    ["weak_reference", "weak reference", "Only broad similarity in category or atmosphere is retained"],
];

// type → 关系选项组（联动）
const REF_TYPE_RELATIONSHIPS = {
    Subject: REF_RELATIONSHIPS_SUBJECT,
    Picture: REF_RELATIONSHIPS_PV,
    Video: REF_RELATIONSHIPS_PV,
    Audio: REF_RELATIONSHIPS_AUDIO,
};

// type → relationship 默认值
function refDefaultRelationship(type) {
    return (REF_TYPE_RELATIONSHIPS[type || "Subject"])[0][0];
}

// type → 可上传的媒体类型（联动显示）
const REF_TYPE_MEDIA = {
    Subject: { image: false, audio: false, video: false },
    Picture: { image: true, audio: false, video: false },
    Audio: { image: false, audio: true, video: false },
    Video: { image: false, audio: false, video: true },
};

// type → 可 @ 引用的主体类型（mention 过滤）
const REF_MENTION_TYPES = {
    Subject: ["Picture", "Video"],
    Picture: ["Picture"],
    Video: ["Picture", "Video"],
    Audio: ["Audio", "Subject"],
};

app.registerExtension({
    name: "Comfy.MiniMaxRefSubject",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "MiniMaxRefSubject") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;

            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                const node = this;

                // Hide default widgets
                const subjectDataWidget = node.widgets.find(w => w.name === "subject_data");
                const subjectCountWidget = node.widgets.find(w => w.name === "subject_count");
                const globalPromptWidget = node.widgets.find(w => w.name === "global_prompt");
                if (subjectDataWidget) hideWidget(subjectDataWidget);
                if (subjectCountWidget) hideWidget(subjectCountWidget);
                if (globalPromptWidget) hideWidget(globalPromptWidget);

                // --- Build Custom UI ---
                const wrapper = document.createElement("div");
                wrapper.className = "ref-ms-wrapper";

                // --- Preact UI：UI 元素 / 高亮文本区注册表（组件上报引用，外部写入后经 render 同步） ---
                const uiEls = {};
                const setUiEl = (name) => (el) => { if (el) uiEls[name] = el; };
                const textEls = new Map();
                const regText = (uid, key, inst) => { textEls.set(uid + "|" + key, inst); };
                const unregText = (uid, key) => { textEls.delete(uid + "|" + key); };
                const getText = (uid, key) => textEls.get(uid + "|" + key);
                let globalPromptValue = ""; // 全局提示文本（与 widget 双向同步）
                let gpSaveTimeout = null;   // 全局提示输入防抖保存计时器（GPBox 使用）

                // --- Type tabs (Subject / Picture / Video / Audio) ---
                let activeTab = "Subject"; // 当前 tab，替代卡片内 type 选择
                const TYPE_TABS = ["Subject", "Picture", "Video", "Audio"];

                // addDOMWidget：隐藏数据行 widget（subject_data 等）后的唯一可见 DOM 行。
                // 注意：不要依赖 hideOnZoom（它只影响画布上的灰色占位绘制，不控制元素显隐）。
                // 元素被画布隐藏/尚未挂载（缩放平移 lowQuality、刷新后首帧）期间 wrapper.scrollHeight
                // 恒为 0，若把 0 或“兜底估算”直接写进 node.size，主体列表（唯一可压缩 flex 子项）
                // 就会塌缩为 0 且不会自动恢复。因此 computeSize 只在元素可见时采纳实测值，隐藏期
                // 沿用缓存；updateNodeSize 在从未实测成功前不采纳估算值，而是挂起循环等元素可见后补测。
                const domWidget = this.addDOMWidget("minimax_subject_ui", "minimax_subject_ui", wrapper);

                // --- State ---
                let subjects = [];
                let subjectCount = 1;

                // 唯一 id：每张卡片/引用子主体分配，用于上传子主体归属（ownerUid）与级联删除
                function genUid() {
                    try {
                        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
                    } catch (_) { }
                    return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
                }
                // 上传生成的引用子主体（relation 恒为 none、携带 ownerUid），仅由父卡片上传条管理，
                // 不在 tab 列表/外部选择器中展示；其 name 为自动生成的唯一名（图片1/视频1/音频1…），
                // 因此可被 <@名称> 在 Definition 中引用（mention 候选按名字非空收录）。
                const isChildSubject = (s) => !!(s && s.ownerUid);
                // 用户可见、可独立编辑的主体（不含上传生成的子主体）
                const visibleSubjects = () => subjects.filter(s => !isChildSubject(s));
                
                // 最近一次“元素可见”时实测到的内容高度缓存。元素被画布隐藏（缩放/平移低质量阶段、
                // 刷新后首帧未挂载等）期间无法测量；若此时把 0/估算值交给节点高度，
                // 主体列表（唯一可压缩的 flex 子项）就会塌缩为 0。因此隐藏期一律沿用缓存。
                let lastContentH = 0;
                // 元素此刻是否真正可见可测：已挂载到文档、未被 display:none/零尺寸隐藏
                function wrapperVisible() {
                    return !!(wrapper && wrapper.isConnected && wrapper.getClientRects().length > 0 && wrapper.offsetWidth > 0);
                }
                // 实测 wrapper 的“自然内容高度”——用组合测量，逐项累加，免疫前端对高度的任何锁定方式。
                // 背景：刷新工作流后 node.size 先恢复 JSON 旧值，前端会把 DOM widget 元素（或其所在层）
                // 的高度锁定为该 widget 画布区域高度。wrapper 是 flex 容器，唯一可压缩的
                // .ref-ms-subject-list 会被压扁；此时若整体读 wrapper.scrollHeight，列表内容已被它自身的
                // overflow-y:auto 收纳、且容器高度不足还会再被 flex 吃掉若干像素，测量值恒偏小 →
                // “测小→写小→更压→更小”自锁（列表 0 或差几像素出现多余滚动条）。
                // 组合测量不依赖 wrapper 是否被锁：兄弟元素均无 min-height:0，flex 压缩不到它们，
                // offsetHeight 恒为自然高；列表即便被压到 0，scrollHeight（overflow-y:auto 容器）
                // 也始终返回内容完整高。两者求和即真实内容高度。
                // 元素外部盒高 = offsetHeight + 上下 margin（如 .ref-ms-tabs 有 margin-bottom:8px，
                // 参与 flex 排布但 offsetHeight 不含，须计入否则测量少算）
                function marginBoxHeight(el) {
                    const cs = getComputedStyle(el);
                    return el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
                }
                function measureWrapperHeight() {
                    const siblings = [uiEls.globalPrompt, uiEls.tabBar, uiEls.addBtn, uiEls.footer].filter(el => el && el.offsetHeight > 0);
                    const listEl = uiEls.subjectList;
                    const listInFlow = !!(listEl && listEl.style.display !== "none");
                    let h = 12; // wrapper padding 6px ×2
                    for (const el of siblings) h += marginBoxHeight(el);
                    if (listInFlow) {
                        // 列表高度 = max(内容完整高, 当前高)，再与 SUBJECT_LIST_MAX_HEIGHT 封顶对齐
                        h += Math.min(Math.max(listEl.scrollHeight || 0, listEl.offsetHeight || 0), SUBJECT_LIST_MAX_HEIGHT);
                    }
                    // flex column gap 8px，仅相邻可见子项之间计
                    const inFlowCount = siblings.length + (listInFlow ? 1 : 0);
                    h += Math.max(0, inFlowCount - 1) * 8;
                    return h;
                }
                // 前端对 computeSize 返回值有固定扣减，须补偿：
                // litegraph _arrangeWidgets 把 widget.computedHeight 设为 computeSize()[1]+4；
                // GraphView updateWidgets 再以 computedHeight - 2×DEFAULT_MARGIN(10) 作为
                // .dom-widget 元素的实际高度 → 元素最终比 computeSize 返回值矮 2×10-4 = 16px。
                // 不补偿时 wrapper 被压 16px，列表（flex 唯一可压缩项）差 16px 出滚动条
                //（“内容不足封顶高也滚动”的根因）。统一 +20 = 16px 补偿 + 4px 保险。
                const DOM_WIDGET_H_COMP = 20;
                window.__refMSSubjectComp = DOM_WIDGET_H_COMP; // 诊断用版本标记
                domWidget.computeSize = function (width) {
                    const nodeWidth = node.size?.[0] || 475;
                    const innerWidth = Math.max(10, nodeWidth - 30); // DOM widget 内容宽（与 .ref-ms-wrapper 一致）
                    // 仅可见时采纳组合实测的自然内容高度（自动跟随卡片/媒体行/列数变化，
                    // 免疫前端对高度的任何锁定方式），并按上述补偿换算成前端期望的返回值。
                    if (wrapperVisible()) {
                        const raw = measureWrapperHeight();
                        if (raw > 0) {
                            lastContentH = raw;
                            return [innerWidth, raw + DOM_WIDGET_H_COMP];
                        }
                    }
                    // 隐藏/未挂载：沿用最近一次实测高度，保持节点高度稳定。
                    if (lastContentH > 0) return [innerWidth, lastContentH + DOM_WIDGET_H_COMP];
                    // 兜底估算：仅用于元素从未可见过的首帧（此值不会被 updateNodeSize 采纳，
                    // 元素可见后会立即被真实测量覆盖）。
                    const listWidth = Math.max(1, innerWidth - 12); // 列表可用宽（wrapper padding 6px ×2）
                    const estCardHeight = 235; // per subject card (image/audio boxes + retention + video row)
                    const extras = 206; // global prompt area + tabs + add button + footer + gaps
                    const visibleCount = subjects.filter(s => (s.type || "Subject") === activeTab && !isChildSubject(s)).length;
                    if (visibleCount === 0) return [innerWidth, extras + DOM_WIDGET_H_COMP];
                    // 与 CSS .ref-ms-subject-list 的 minmax(340px, 1fr) 对齐：最小列宽 340 + 间隙 6
                    const cols = Math.max(1, Math.floor((listWidth + 6) / 346));
                    const rows = Math.ceil(visibleCount / cols);
                    // 与 .ref-ms-subject-list 的 SUBJECT_LIST_MAX_HEIGHT 对齐，避免首帧估算使节点高度无限增长
                    const listH = Math.min(rows * estCardHeight, SUBJECT_LIST_MAX_HEIGHT);
                    const height = listH + extras;
                    return [innerWidth, height + DOM_WIDGET_H_COMP];
                };

                // 上次触发重算时的节点宽度，用于判断是否跨列档
                let lastNodeWidth = node.size?.[0] || 475;
                node.syncLayoutToNode = function () {
                    // grid 列数跨档时自动重算高度（多列并排后高度收缩，不留大片空白）；
                    // 同列数内的宽度/高度微调不干预，保留用户手动调整的高度。
                    const w = this.size?.[0] || 475;
                    const listWidth = Math.max(1, w - 42); // 节点宽 - 30 内容区 - 12 padding
                    const colsNow = Math.max(1, Math.floor((listWidth + 6) / 346));
                    const colsPrev = Math.max(1, Math.floor((lastNodeWidth - 42 + 6) / 346));
                    lastNodeWidth = w;
                    if (colsNow !== colsPrev) updateNodeSize();
                };

                // 将当前主体列表发布到全局缓存并通知外部（如 Transfer mention 菜单刷新）
                function publishSubjects() {
                    try {
                        window.__refSubjects = subjects.map(s => ({
                            name: s.name || "",
                            description: s.description || "",
                            type: s.type || "Subject",
                            relationship: isChildSubject(s) ? "" : (s.relationship || refDefaultRelationship(s.type)),
                            imageFile: s.imageFile || "",
                            audioFile: s.audioFile || "",
                            audioRef: s.audioRef || "",
                            retention: s.retention || "",
                            videoFile: s.videoFile || "",
                        }));
                        window.dispatchEvent(new CustomEvent("ref:subjects-changed"));
                    } catch (e) { /* 事件派发失败忽略 */ }
                }

                function loadStateFromWidget() {
                    subjects.length = 0;
                    try {
                        const raw = subjectDataWidget?.value;
                        if (raw && raw !== "undefined") {
                            const parsed = JSON.parse(raw);
                            if (parsed.subjects && Array.isArray(parsed.subjects)) {
                                parsed.subjects.forEach(s => {
                                    subjects.push({
                                        name: s.name || "",
                                        description: s.description || "",
                                        type: s.type || "Subject",
                                        relationship: isChildSubject(s) ? "" : (s.relationship || refDefaultRelationship(s.type)),
                                        imageFile: s.imageFile || "",
                                        imageB64: s.imageB64 || viewUrl(s.imageFile, "minimaxrefdirector"),
                                        audioFile: s.audioFile || "",
                                        audioRef: s.audioRef || "",
                                        retention: s.retention || "",
                                        videoFile: s.videoFile || "",
                                        videoB64: s.videoB64 || viewUrl(s.videoFile, "minimaxrefdirector"),
                                        uid: s.uid || genUid(),
                                        ownerUid: s.ownerUid || "",
                                    });
                                });
                            }
                        }
                    } catch (_) { }

                    // Sync global prompt from widget（GPBox 组件在渲染后据此同步 textarea）
                    globalPromptValue = globalPromptWidget ? (globalPromptWidget.value || "") : "";

                    const countVal = subjectCountWidget ? parseInt(subjectCountWidget.value) || 1 : 1;
                    subjectCount = Math.max(1, countVal);

                    if (subjects.length === 0) {
                        while (subjects.length < subjectCount) {
                            subjects.push({ name: "", description: "", type: "Subject", relationship: "fully_preserved", audioRef: "", retention: "", imageFile: "", audioFile: "", videoFile: "", uid: genUid(), ownerUid: "" });
                        }
                    } else {
                        // 计数按可见（非上传子主体）主体计，避免空槽补齐/容量受引用媒体干扰
                        subjectCount = Math.max(1, visibleSubjects().length);
                    }
                    publishSubjects();
                }

                // Initial load (may be overwritten on page reload by onConfigure below)
                loadStateFromWidget();

                // Store reload function on node so onConfigure can call it
                node._reloadMiniMaxSubjects = () => {
                    loadStateFromWidget();
                    renderSubjects();
                    updateNodeSize();
                };

                // Shared upload handler
                async function uploadFile(file, callback) {
                    try {
                        const body = new FormData();
                        body.append("image", file);
                        body.append("subfolder", "minimaxrefdirector");
                        const resp = await api.fetchApi("/upload/image", {
                            method: "POST",
                            body,
                        });
                        if (resp.status === 200) {
                            const data = await resp.json();
                            const filename = data.name;
                            const subfolder = data.subfolder || "";
                            const imageFile = subfolder ? subfolder + "/" + filename : filename;
                            const imgUrl = viewUrl(filename, subfolder);
                            callback(imageFile, imgUrl);
                        } else {
                            console.error("[MiniMaxRefSubject] Upload failed:", resp.status);
                        }
                    } catch (err) {
                        console.error("[MiniMaxRefSubject] Upload error:", err);
                    }
                }

                function createFileInput(accept, callback) {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = accept;
                    input.style.display = "none";
                    input.addEventListener("change", () => {
                        if (input.files && input.files.length > 0) {
                            uploadFile(input.files[0], callback);
                        }
                        input.remove();
                    });
                    document.body.appendChild(input);
                    input.click();
                }

                let _audioEl = null;
                let _audioPlayBtn = null;

                function updatePlayBtnIcon(btn, isPlaying) {
                    if (!btn) return;
                    if (isPlaying) {
                        btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> ${t("Stop")}`;
                        btn.classList.add("playing");
                    } else {
                        btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> ${t("Play")}`;
                        btn.classList.remove("playing");
                    }
                }

                function stopAudio() {
                    if (_audioEl) {
                        _audioEl.pause();
                        _audioEl.currentTime = 0;
                        if (_audioPlayBtn) {
                            // 缩略图中央播放按钮与卡片内文本播放按钮的恢复方式不同
                            if (_audioPlayBtn.classList && _audioPlayBtn.classList.contains("child-thumb-play")) {
                                setChildPlayBtn(_audioPlayBtn, false);
                            } else {
                                updatePlayBtnIcon(_audioPlayBtn, false);
                            }
                        }
                        _audioEl = null;
                        _audioPlayBtn = null;
                    }
                }

                function playAudio(audioFile, btnEl) {
                    // If the same audio is currently playing, stop it
                    if (_audioEl && !_audioEl.paused && _audioPlayBtn === btnEl) {
                        stopAudio();
                        return;
                    }

                    // Stop any other playing audio
                    if (_audioEl) {
                        stopAudio();
                    }

                    if (!audioFile) return;
                    // Build URL from filename (audioFile may contain subfolder, e.g. "minimaxrefdirector/audio.mp3")
                    let url = audioFile;
                    if (!url.startsWith("http") && !url.startsWith("/") && !url.startsWith("data:")) {
                        const parts = audioFile.replace(/\\/g, "/").split("/");
                        const filename = parts.pop();
                        const subfolder = parts.join("/");
                        url = viewUrl(filename, subfolder);
                    }
                    _audioEl = new Audio(url);
                    _audioPlayBtn = btnEl;
                    updatePlayBtnIcon(btnEl, true);

                    _audioEl.play().catch(err => {
                        console.error("[MiniMaxRefSubject] Audio play error:", err);
                        updatePlayBtnIcon(btnEl, false);
                        _audioEl = null;
                        _audioPlayBtn = null;
                    });
                    _audioEl.addEventListener("ended", () => {
                        updatePlayBtnIcon(btnEl, false);
                        _audioEl = null;
                        _audioPlayBtn = null;
                    });
                }

                function saveState() {
                    const data = {
                        subjects: subjects.map(s => ({
                            name: s.name,
                            description: s.description,
                            type: s.type || "Subject",
                            relationship: isChildSubject(s) ? "" : (s.relationship || refDefaultRelationship(s.type)),
                            imageFile: s.imageFile,
                            audioFile: s.audioFile,
                            audioRef: s.audioRef,
                            retention: s.retention,
                            videoFile: s.videoFile,
                            uid: s.uid || genUid(),
                            ownerUid: s.ownerUid || "",
                        }))
                    };
                    const jsonStr = JSON.stringify(data);
                    if (subjectDataWidget) {
                        subjectDataWidget.value = jsonStr;
                        if (subjectDataWidget.callback) {
                            subjectDataWidget.callback(jsonStr);
                        }
                    }
                    if (subjectCountWidget) {
                        subjectCountWidget.value = subjectCount;
                        if (subjectCountWidget.callback) {
                            subjectCountWidget.callback(subjectCount);
                        }
                    }
                    if (app.graph) {
                        app.graph.setDirtyCanvas(true, false);
                    }
                    publishSubjects();
                }

                // relationship 是否属于该 type 的合法选项
                function isValidRelationship(type, rel) {
                    const opts = REF_TYPE_RELATIONSHIPS[type || "Subject"] || REF_RELATIONSHIPS_SUBJECT;
                    return !!rel && opts.some(o => o[0] === rel);
                }

                // 供外部（如 settings.js 导入 Excel）按名称创建/更新主体的窗口级 API。
                // list: [{ name, relationship?, description?, retention?, type? }]
                // 按 name（trim + 忽略大小写）匹配：存在→更新；不存在→新建（type 默认 Subject）。
                // 节点/闭包未就绪时防御性降级：仅刷新 __refSubjects，不抛错。
                window.__upsertRefSubjects = function (list) {
                    try {
                        if (!Array.isArray(list) || list.length === 0) return;
                        let changed = false;
                        list.forEach(item => {
                            if (!item || typeof item.name !== "string") return;
                            const name = item.name.trim();
                            if (!name) return;
                            const lower = name.toLowerCase();
                            const existing = subjects.find(s => (s.name || "").trim().toLowerCase() === lower);
                            if (existing) {
                                if (typeof item.description === "string" && item.description !== (existing.description || "")) {
                                    existing.description = item.description;
                                    changed = true;
                                }
                                if (typeof item.retention === "string" && item.retention !== (existing.retention || "")) {
                                    existing.retention = item.retention;
                                    changed = true;
                                }
                                if (typeof item.relationship === "string" && item.relationship &&
                                    isValidRelationship(existing.type || "Subject", item.relationship) &&
                                    item.relationship !== (existing.relationship || "")) {
                                    existing.relationship = item.relationship;
                                    changed = true;
                                }
                            } else {
                                const type = item.type && ["Subject", "Picture", "Video", "Audio"].includes(item.type)
                                    ? item.type
                                    : "Subject";
                                let rel = typeof item.relationship === "string" && item.relationship ? item.relationship : "";
                                rel = isValidRelationship(type, rel) ? rel : refDefaultRelationship(type);
                                subjects.push({
                                    name,
                                    description: typeof item.description === "string" ? item.description : "",
                                    type,
                                    relationship: rel,
                                    audioRef: "",
                                    retention: typeof item.retention === "string" ? item.retention : "",
                                    imageFile: "",
                                    audioFile: "",
                                    videoFile: "",
                                    uid: genUid(),
                                    ownerUid: "",
                                });
                                changed = true;
                            }
                        });
                        if (changed) {
                            subjectCount = Math.max(1, visibleSubjects().length);
                            renderSubjects();
                            saveState();
                            updateNodeSize();
                        }
                        publishSubjects();
                    } catch (e) {
                        console.error("[MiniMaxRefSubject] upsert subjects failed:", e);
                        try { publishSubjects(); } catch (_) { }
                    }
                };

                // ---- Definition 行下方的媒体引用上传条：上传物生成 relation:none 的隐藏子主体 ----
                const REF_CHILD_CAP = { Picture: 9, Video: 3, Audio: 1 };
                const REF_CHILD_ACCEPT = { Picture: "image/*", Video: "video/*", Audio: "audio/*" };
                // 父卡片类型可上传生成的子主体类型（Subject→图/视频/音频，Picture→图，Video→图/视频，Audio→音频）
                const REF_UPLOAD_CHILD_TYPES = {
                    Subject: ["Picture", "Video", "Audio"],
                    Picture: ["Picture"],
                    Video: ["Picture", "Video"],
                    Audio: ["Audio"],
                };
                // 上传添加按钮图标（htm/SVG 声明式片段，函数化调用以避免 vnode 复用）
                const REF_CHILD_ICONS = {
                    Picture: () => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,
                    Video: () => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
                    Audio: () => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,
                };

                // ---- 上传条缩略图：名称角标 + 播放按钮辅助 ----
                // 引用主体唯一名生成：前缀 = t(type)（图片/视频/音频），
                // 按类型递增并回收复用（取不冲突的最小空闲号），保证全量 name 唯一
                function nextChildName(type) {
                    const prefix = t(type || "");
                    const used = new Set();
                    subjects.forEach(s => {
                        const n = (s.name || "").trim();
                        if (n) used.add(n);
                    });
                    let i = 1;
                    while (used.has(prefix + i)) i++;
                    return prefix + i;
                }
                // 缩略图左下方小角标：展示引用主体的名称（图片1/视频1…），空名回退为类型名
                function childThumbBadge(child) {
                    const type = child && child.type;
                    const name = child && child.name ? String(child.name).trim() : "";
                    return html`<span class=${"type-badge" + (type ? " " + type.toLowerCase() : "")}
                        title=${name && type ? `${t(type)} · ${name}` : null}>${name || t(type || "")}</span>`;
                }
                // 同步 视频/音频 缩略图中央按钮的 播放/暂停 状态
                function setChildPlayBtn(btn, playing) {
                    if (!btn) return;
                    btn.classList.toggle("playing", !!playing);
                    btn.title = playing ? t("Stop") : t("Play");
                    btn.innerHTML = playing
                        ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`
                        : `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
                }
                // 视频缩略图渲染已并入 ChildThumb 组件（见下方上传条声明式子组件层）：
                // 默认静音显示首帧，hover 出现中央播放按钮，播放互斥/静音回退逻辑保持一致。
                // 音频缩略图：点击播放/暂停，与卡片内其它音频共用同一单例，避免同时播放多个声音
                function toggleChildAudio(audioFile, btn) {
                    // 同一按钮正在播放 → 点击停止
                    if (_audioEl && _audioPlayBtn === btn && !_audioEl.paused) {
                        stopAudio();
                        return;
                    }
                    // 停掉当前正在播放的其它音频
                    if (_audioEl) stopAudio();
                    if (!audioFile) return;
                    // audioFile 可能含子目录，如 "minimaxrefdirector/audio.mp3"
                    let url = audioFile;
                    if (!url.startsWith("http") && !url.startsWith("/") && !url.startsWith("data:")) {
                        const parts = audioFile.replace(/\\/g, "/").split("/");
                        const filename = parts.pop();
                        const subfolder = parts.join("/");
                        url = viewUrl(filename, subfolder);
                    }
                    const a = new Audio(url);
                    _audioEl = a;
                    _audioPlayBtn = btn;
                    setChildPlayBtn(btn, true);
                    a.play().catch(err => {
                        console.error("[MiniMaxRefSubject] Audio thumb play error:", err);
                        if (_audioEl === a) {
                            setChildPlayBtn(btn, false);
                            _audioEl = null;
                            _audioPlayBtn = null;
                        }
                    });
                    a.addEventListener("ended", () => {
                        if (_audioEl === a) {
                            setChildPlayBtn(btn, false);
                            _audioEl = null;
                            _audioPlayBtn = null;
                        }
                    });
                }

                // 上传一张媒体 → 生成对应类型、relationship 为空(none) 的子主体并记录归属父卡
                function uploadChildMedia(parent, childType) {
                    createFileInput(REF_CHILD_ACCEPT[childType], (filename, mediaUrl) => {
                        const child = {
                            name: "",
                            description: "",
                            type: childType,
                            relationship: "", // relation:none —— 仅供引用，不在列表/选择器中展示
                            imageFile: "",
                            imageB64: "",
                            audioFile: "",
                            audioRef: "",
                            retention: "",
                            videoFile: "",
                            videoB64: "",
                            uid: genUid(),
                            ownerUid: parent.uid || "",
                        };
                        if (childType === "Picture") { child.imageFile = filename; child.imageB64 = mediaUrl || ""; }
                        else if (childType === "Video") { child.videoFile = filename; child.videoB64 = mediaUrl || ""; }
                        else { child.audioFile = filename; }
                        subjects.push(child);
                        // 引用主体自动分配唯一名称（图片1/视频1/音频1…，按类型递增并回收复用）
                        child.name = nextChildName(childType);
                        // 音频引用：把音频主体的名称写入父卡 audioRef（仅 Subject 父卡有 audioRef 语义，
                        // 后端据其把该音频绑定为音轨；Audio 父卡自身已是音频主体，无需回写）
                        if (childType === "Audio" && parent.type === "Subject") {
                            const pk = subjects.findIndex(s => (s.uid || "") === (parent.uid || ""));
                            if (pk >= 0) subjects[pk].audioRef = child.name;
                        }
                        saveState();
                        renderSubjects();
                        updateNodeSize();
                    });
                }

                // 删除上传条中的缩略项 → 同步从 subjects 删除对应子主体
                function removeChildSubject(child) {
                    const k = subjects.findIndex(s => (s.uid || "") === (child.uid || ""));
                    if (k >= 0) {
                        // 若被删的是音频引用主体，且父卡 audioRef 正指向它 → 同步清空
                        const parentUid = child.ownerUid || "";
                        let parentIdx = -1;
                        if (child.type === "Audio") {
                            parentIdx = subjects.findIndex(s =>
                                (s.uid || "") === parentUid && (s.audioRef || "") === (child.name || ""));
                        }
                        subjects.splice(k, 1);
                        if (parentIdx >= 0) subjects[parentIdx].audioRef = "";
                        saveState();
                        renderSubjects();
                        updateNodeSize();
                    }
                }

                // ================= 上传条（声明式子组件层） =================
                // 子主体缩略图：图片直显 / 视频静音首帧（hover 中央播放钮）/ 音频音符+文件名（右下播放钮），
                // 均带左下角名称角标与右上删除；图片/视频整体点击 → 父卡 Definition 光标处插入 <@名称>
                const ChildThumb = ({ child, onThumbClick }) => {
                    const vdRef = useRef(null);
                    const pbRef = useRef(null);
                    const syncPlay = () => {
                        const pb = pbRef.current, vd = vdRef.current;
                        if (pb && vd) setChildPlayBtn(pb, !vd.paused && !vd.ended);
                    };
                    const onVideoBtn = (e) => {
                        e.stopPropagation();
                        const vd = vdRef.current;
                        if (!vd) return;
                        if (vd.paused || vd.ended) {
                            // 同一时间只播放一个视频缩略图，避免声音混叠
                            wrapper.querySelectorAll(".ref-ms-child-thumb video").forEach(v => { if (v !== vd && !v.paused) v.pause(); });
                            // 用户点击触发的播放允许带声音
                            vd.muted = false;
                            vd.play().catch(() => {
                                // 个别浏览器限制 → 回退为静音播放
                                vd.muted = true;
                                vd.play().catch(err => console.error("[MiniMaxRefSubject] Video thumb play error:", err));
                            });
                        } else {
                            vd.pause();
                        }
                    };
                    const onThumbClickSelf = (e) => {
                        e.stopPropagation();
                        if (typeof onThumbClick === "function") onThumbClick(child);
                    };
                    const type = child.type;
                    const isMedia = type === "Picture" || type === "Video";
                    const playIcon = html`<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
                    return html`<div class=${"ref-ms-child-thumb" + (type === "Audio" ? " audio" : " media clickable")}
                            onClick=${isMedia ? onThumbClickSelf : null}>
                        ${type === "Picture" ? html`<img src=${child.imageB64 || child.imageFile || ""} alt="" />`
                            : type === "Video" ? html`<video ref=${vdRef} src=${child.videoB64 || child.videoFile || ""} muted=${true} playsInline=${true} preload=${"metadata"}
                                onPlay=${syncPlay} onPause=${syncPlay}
                                onEnded=${() => { const vd = vdRef.current; if (vd) { vd.muted = true; vd.currentTime = 0; } syncPlay(); }}></video>`
                            : html`<div class="cicon" style="color:#38bdf8">${REF_CHILD_ICONS.Audio()}<span class="fname">${basename(child.audioFile)}</span></div>`}
                        ${type === "Video" || type === "Audio" ? html`<button ref=${pbRef} type="button" class="child-thumb-play" title=${t("Play")}
                            onClick=${type === "Video" ? onVideoBtn : (e) => { e.stopPropagation(); toggleChildAudio(child.audioFile, pbRef.current); }}>${playIcon}</button>` : null}
                        ${childThumbBadge(child)}
                        <button type="button" class="ref-ms-child-del" title=${t("Delete")}
                            onClick=${(e) => { e.stopPropagation(); removeChildSubject(child); }}>
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>`;
                };

                // 渲染某卡片的上传条（无上传能力时返回 null；返回 htm vnode）
                // ctx.onThumbClick(child)：图片/视频缩略图点击回调（在父卡 Definition 插入 <@名称>）
                // ctx.audioOnly：仅渲染音频槽（供 Subject 卡独立「参考音频」行使用）
                function buildUploadStrip(subj, ctx) {
                    const audioOnly = !!(ctx && ctx.audioOnly);
                    // Subject 卡的音频引用拆到独立「参考音频」行（定义描述上方），普通引用资源条只留图/视频；
                    // 其余父卡（Audio 等）保持原「引用资源」条逻辑（含 Audio 槽）。
                    let allowed = (REF_UPLOAD_CHILD_TYPES[subj.type || "Subject"] || []).slice();
                    if (audioOnly) {
                        allowed = allowed.filter(tp => tp === "Audio");
                    } else if ((subj.type || "Subject") === "Subject") {
                        allowed = allowed.filter(tp => tp !== "Audio");
                    }
                    const hasPicVid = allowed.includes("Picture") || allowed.includes("Video");
                    const hasAudio = allowed.includes("Audio");
                    if (!hasPicVid && !hasAudio) return null;
                    const uid = subj.uid || "";
                    const kids = subjects.filter(c => (c.ownerUid || "") === uid && allowed.includes(c.type || ""));
                    const countByType = { Picture: 0, Video: 0, Audio: 0 };
                    kids.forEach(c => { if (c.type && c.type in countByType) countByType[c.type]++; });
                    // 旧数据兜底：空名引用主体自动补唯一名（保证角标/点击 <@> 可用）
                    kids.forEach(c => { if (!String(c.name || "").trim() && c.type) c.name = nextChildName(c.type); });
                    const addBtn = (childType) => {
                        const n = countByType[childType] || 0;
                        // 容量满 → 不渲染该添加上传按钮（旧实现为 disabled + display:none）
                        if (n >= (REF_CHILD_CAP[childType] || 1)) return null;
                        return html`<button type="button" class="ref-ms-upload-add"
                            title=${`${t("Upload")} ${t(childType)} (${n}/${REF_CHILD_CAP[childType]})`}
                            onClick=${(e) => { e.stopPropagation(); uploadChildMedia(subj, childType); }}>
                            ${REF_CHILD_ICONS[childType]()}
                            <span style="font-size:7px;color:#888;line-height:1">${t(childType)}</span>
                        </button>`;
                    };
                    const onThumb = ctx && typeof ctx.onThumbClick === "function"
                        ? (c) => ctx.onThumbClick(c) : null;
                    // 主区：图片/视频缩略 + 音频槽（音频槽固定最右，最多 1 个）；外层一行：label + 黄色小字提示 + 横条
                    return html`<div class="ref-ms-row">
                        <div class="ref-ms-row-group">
                            <div class="ref-ms-label-sm">${audioOnly ? t("Reference Audio") : t("Reference Assets")}</div>
                            <div class="ref-ms-row-group-right">
                                <div class="ref-ms-upload-strip">
                                    ${kids.map(child => html`<${ChildThumb} key=${child.uid || child.name} child=${child} onThumbClick=${onThumb} />`)}
                                    ${allowed.includes("Picture") ? addBtn("Picture") : null}
                                    ${allowed.includes("Video") ? addBtn("Video") : null}
                                    ${allowed.includes("Audio") ? addBtn("Audio") : null}
                                </div>
                                <div class="ref-ms-row-footer">
                                    ${audioOnly ? null : html`<div class="ref-ms-upload-hint">${t("ReferenceAssetsHint")}</div>`}
                                </div>
                            </div>
                        </div>
                    </div>`;
                }

                // ===================== Preact 声明式渲染层 =====================
                // 返回当前 tab 可见的非引用卡（引用子主体 relation:none，列表中不可见）
                const visibleSubjectsOfTab = () =>
                    subjects.filter(s => (s.type || "Subject") === activeTab && !isChildSubject(s));

                // 点击上传条内图片/视频缩略图 → 在父卡 Definition 光标处插入 <@名称>
                const childMentionInto = (subj, child) => {
                    const kidName = String(child && child.name || "").trim();
                    if (!kidName) return;
                    const idx = subjects.indexOf(subj);
                    if (idx < 0) return;
                    // Definition 行隐藏（relationship 空=纯引用）时：恢复为非空默认关系并显示
                    if (!(subj.relationship || "")) {
                        const relOpts = REF_TYPE_RELATIONSHIPS[subj.type || activeTab] || REF_RELATIONSHIPS_SUBJECT;
                        const nonEmpty = (relOpts || []).find(o => o[0] !== "") || (relOpts || [])[0];
                        if (nonEmpty) subj.relationship = nonEmpty[0];
                    }
                    closeMention();
                    const inst = getText(subj.uid, "description");
                    if (!inst) { renderSubjects(); updateNodeSize(); return; }
                    const ta = inst.ta;
                    const mentionText = `<@${kidName}>`;
                    const hadFocus = document.activeElement === ta;
                    ta.focus();
                    if (!hadFocus) {
                        // Definition 此前未聚焦 → 无有效光标位置，追加到末尾
                        ta.value = (ta.value || "") + mentionText;
                        ta.setSelectionRange(ta.value.length, ta.value.length);
                    } else {
                        const start = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
                        const end = typeof ta.selectionEnd === "number" ? ta.selectionEnd : ta.value.length;
                        ta.value = ta.value.slice(0, start) + mentionText + ta.value.slice(end);
                        const pos = start + mentionText.length;
                        ta.setSelectionRange(pos, pos);
                    }
                    subjects[idx].description = ta.value;
                    if (inst.refresh) inst.refresh();
                    saveState();
                    renderSubjects();
                    updateNodeSize();
                };

                // 高亮文本输入（描述/保留）：挂载 createHighlightedTextarea，输入直写 subjects 并保存
                const HTextHost = ({ subj, keyName, placeholderKey }) => {
                    const hostRef = useRef(null);
                    const instRef = useRef(null);
                    const uidRef = useRef(subj.uid || "");
                    const keyRef = useRef(keyName);
                    useLayoutEffect(() => {
                        const host = hostRef.current;
                        if (!host) return;
                        const self = subjects.find(x => (x.uid || "") === uidRef.current);
                        if (!self) return;
                        const isDesc = keyRef.current === "description";
                        const commonStyle = {
                            flex: "1",
                            minWidth: "0",
                            background: "#2a2a2a",
                            color: "#e0e0e0",
                            padding: "3px 8px",
                            fontSize: "11px",
                            boxSizing: "border-box",
                            borderRadius: "4px",
                        };
                        const inst = createHighlightedTextarea({
                            className: isDesc ? "ref-ms-textarea" : "ref-ms-retention",
                            style: isDesc ? Object.assign({ minHeight: "90px", resize: "vertical", borderWidth: "1px", borderStyle: "solid" }, commonStyle)
                                : Object.assign({ border: "1px solid #444", outline: "none", minHeight: "60px", lineHeight: "1.35" }, commonStyle),
                            value: isDesc ? (self.description || "") : (self.retention || ""),
                            placeholder: t(placeholderKey),
                            spellcheck: false,
                        });
                        inst.ta.rows = 1;
                        host.appendChild(inst.wrap);
                        instRef.current = inst;
                        const onInput = () => {
                            const s = subjects.find(x => (x.uid || "") === uidRef.current);
                            if (!s) return;
                            if (keyRef.current === "description") s.description = inst.ta.value;
                            else s.retention = inst.ta.value;
                            saveState();
                        };
                        inst.ta.addEventListener("input", onInput);
                        const detach = attachMention(inst.ta, uidRef.current, subjects, (v) => {
                            const s = subjects.find(x => (x.uid || "") === uidRef.current);
                            if (!s) return;
                            if (keyRef.current === "description") s.description = v;
                            else s.retention = v;
                            saveState();
                            inst.refresh();
                        });
                        const onWrapResize = () => updateNodeSize();
                        inst.wrap.addEventListener("resize", onWrapResize);
                        regText(uidRef.current, keyRef.current, inst);
                        return () => {
                            inst.ta.removeEventListener("input", onInput);
                            inst.wrap.removeEventListener("resize", onWrapResize);
                            if (detach) detach();
                            unregText(uidRef.current, keyRef.current);
                            instRef.current = null;
                            if (host.contains(inst.wrap)) host.removeChild(inst.wrap);
                        };
                    }, []);
                    // 外部写入（reload/插入 mention 后 commit）→ 与数据源对齐
                    useEffect(() => {
                        const inst = instRef.current;
                        if (!inst) return;
                        const self = subjects.find(x => (x.uid || "") === uidRef.current);
                        if (!self) return;
                        const cur = keyRef.current === "description" ? (self.description || "") : (self.retention || "");
                        if (inst.ta.value !== cur) {
                            inst.ta.value = cur;
                            inst.refresh();
                        }
                    });
                    return html`<div ref=${hostRef} style="display:contents"></div>`;
                };

                // 上传条声明式挂载：由 htm 子组件渲染（命名/audioRef/播放/删除等完整语义承载于上传条组件内）
                const UploadHost = ({ subj, audioOnly, onThumbClick }) => {
                    const v = buildUploadStrip(subj, { audioOnly: !!audioOnly, onThumbClick: onThumbClick || null });
                    return html`<div style="display:contents">${v}</div>`;
                };

                // 卡片（Subject/Picture/Video/Audio 共用）
                const SubjectCard = ({ subj, i }) => {
                    const idx = subjects.indexOf(subj);
                    const relOptions = REF_TYPE_RELATIONSHIPS[subj.type || activeTab] || REF_RELATIONSHIPS_SUBJECT;
                    const typeMedia = REF_TYPE_MEDIA[subj.type || "Subject"] || REF_TYPE_MEDIA.Subject;
                    const relCur = subj.relationship || "";
                    const descShown = relCur !== "";
                    const audioShown = relCur !== "";
                    const retAllowed = (REF_MENTION_TYPES[subj.type || "Subject"] || []).slice();
                    if (subj.type !== "Subject" && !retAllowed.includes("Subject")) retAllowed.push("Subject");
                    const canRemove = visibleSubjects().length > 1;
                    const onRemove = () => {
                        if (!canRemove) return;
                        for (let k = subjects.length - 1; k >= 0; k--) {
                            if (subjects[k].ownerUid && subjects[k].ownerUid === (subj.uid || "")) subjects.splice(k, 1);
                        }
                        subjects.splice(idx, 1);
                        subjectCount = Math.max(1, visibleSubjects().length);
                        renderSubjects();
                        saveState();
                        updateNodeSize();
                    };
                    return html`
                        <div class="ref-ms-subject-card">
                            <div class="ref-ms-card-header">
                                <span class="ref-ms-card-index">${t(subj.type || activeTab)} ${i + 1}</span>
                                <button class="ref-ms-card-remove" disabled=${!canRemove} style=${canRemove ? null : "opacity:0.35;"} onClick=${onRemove}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> ${t("Remove")}
                                </button>
                            </div>

                            <div class="ref-ms-row">
                                <div class="ref-ms-cell">
                                    <span class="ref-ms-label-sm" title=${t("Required")}>${t("Name *")}</span>
                                    <input class=${"ref-ms-input" + ((subj.name || "").trim() ? "" : " required-missing")} type="text"
                                        placeholder=${t("Subject name...")} maxLength=${128} title=${t("Required")}
                                        value=${subj.name || ""}
                                        onInput=${(e) => { const k = subjects.indexOf(subj); if (k < 0) return; subjects[k].name = e.target.value; e.currentTarget.classList.toggle("required-missing", !e.currentTarget.value.trim()); saveState(); }} />
                                </div>
                                <div class="ref-ms-cell">
                                    <span class="ref-ms-label-sm" title=${t("Required")}>${t("Relation *")}</span>
                                    <select class="ref-ms-select" value=${relCur}
                                        onChange=${(e) => { const k = subjects.indexOf(subj); if (k >= 0) { subjects[k].relationship = e.target.value; saveState(); renderSubjects(); updateNodeSize(); } }}>
                                        ${(relOptions || []).map(([val, label, description]) => html`<option key=${val} value=${val} title=${description || ""}>${label}</option>`)}
                                    </select>
                                </div>
                            </div>

                            ${(subj.type || "Subject") === "Subject" ? html`<${UploadHost} subj=${subj} audioOnly=${true} onThumbClick=${null} />` : null}

                            <div class="ref-ms-row">
                                <div class="ref-ms-row-group" style=${descShown ? null : "display:none;"}>
                                    <span class="ref-ms-label">${t("Definition")}</span>
                                    <${HTextHost} subj=${subj} keyName=${"description"} placeholderKey=${"Subject definition... (type @ to mention another subject)"} />
                                </div>
                                ${typeMedia.image ? html`
                                    <div class="ref-ms-media-box ${subj.imageFile ? "has-file" : ""}">
                                        ${subj.imageFile
                                            ? html`<img src=${subj.imageB64 || subj.imageFile} alt="" />`
                                            : html`<div class="ref-ms-media-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg><span>${t("Image")}</span></div>`}
                                        <div class="ref-ms-media-overlay">
                                            <button class="ref-ms-media-action" onClick=${(e) => { e.stopPropagation(); createFileInput("image/*", (filename, imgUrl) => { const k = subjects.indexOf(subj); if (k >= 0) { subjects[k].imageFile = filename; subjects[k].imageB64 = imgUrl; saveState(); renderSubjects(); updateNodeSize(); } }); }}>${subj.imageFile ? t("Change") : t("Add")}</button>
                                            ${subj.imageFile ? html`
                                                <button class="ref-ms-media-action del" onClick=${(e) => { e.stopPropagation(); const k = subjects.indexOf(subj); if (k >= 0) { subjects[k].imageFile = null; subjects[k].imageB64 = null; saveState(); renderSubjects(); updateNodeSize(); } }}>
                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                                </button>` : null}
                                        </div>
                                    </div>` : null}
                                ${(subj.type || "Subject") !== "Subject" && typeMedia.audio ? html`
                                    <div class="ref-ms-media-box ${subj.audioFile ? "has-file" : ""}">
                                        ${subj.audioFile
                                            ? html`<div class="ref-ms-media-icon" style="color:#38bdf8;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg><span style="font-size:8px;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${basename(subj.audioFile || "")}</span></div>`
                                            : html`<div class="ref-ms-media-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon></svg><span>${t("Audio")}</span></div>`}
                                        <div class="ref-ms-media-overlay">
                                            <button class="ref-ms-media-action" onClick=${(e) => { e.stopPropagation(); createFileInput("audio/*", (filename) => { const k = subjects.indexOf(subj); if (k >= 0) { subjects[k].audioFile = filename; saveState(); renderSubjects(); updateNodeSize(); } }); }}>${subj.audioFile ? t("Change") : t("Add")}</button>
                                            ${subj.audioFile ? html`
                                                <button class="ref-ms-media-action play-btn" onClick=${(e) => { e.stopPropagation(); playAudio(subj.audioFile, e.currentTarget); }}>
                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> ${t("Play")}
                                                </button>
                                                <button class="ref-ms-media-action del" onClick=${(e) => { e.stopPropagation(); const k = subjects.indexOf(subj); if (k >= 0) { subjects[k].audioFile = null; saveState(); renderSubjects(); updateNodeSize(); } }}>
                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                                </button>` : null}
                                        </div>
                                    </div>` : null}
                            </div>

                            <${UploadHost} subj=${subj} audioOnly=${false} onThumbClick=${(child) => childMentionInto(subj, child)} />

                            <div class="ref-ms-row" style=${audioShown ? null : "display:none;"}>
                                <span class="ref-ms-label">${t("Retention")}</span>
                                <${HTextHost} subj=${subj} keyName=${"retention"} placeholderKey=${"the young man's short wavy brown hair and dark-grey hoodie are retained."} />
                            </div>

                            ${typeMedia.video ? html`
                                <div class="ref-ms-video-row ${subj.videoFile ? "has-file" : ""}">
                                    ${subj.videoFile
                                        ? html`<video src=${subj.videoB64 || subj.videoFile} controls=${true} preload=${"metadata"} onClick=${(e) => e.stopPropagation()}></video>`
                                        : html`<div class="ref-ms-media-icon" style="flex-direction: row; gap: 8px;"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg><span>${t("Upload Video")}</span></div>`}
                                    <div class="ref-ms-video-actions">
                                        <button class="ref-ms-video-action" title=${t("Replace Video")} onClick=${(e) => { e.stopPropagation(); createFileInput("video/*", (filename, videoUrl) => { const k = subjects.indexOf(subj); if (k >= 0) { subjects[k].videoFile = filename; subjects[k].videoB64 = videoUrl; saveState(); renderSubjects(); updateNodeSize(); } }); }}>${subj.videoFile ? t("Change") : t("Add")}</button>
                                        ${subj.videoFile ? html`
                                            <button class="ref-ms-video-action del" title=${t("Delete Video")} onClick=${(e) => { e.stopPropagation(); const k = subjects.indexOf(subj); if (k >= 0) { subjects[k].videoFile = null; subjects[k].videoB64 = null; saveState(); renderSubjects(); updateNodeSize(); } }}>${t("Delete")}</button>` : null}
                                    </div>
                                </div>` : null}
                        </div>`;
                };

                // 全局提示输入
                const GPBox = () => {
                    const taRef = useRef(null);
                    useLayoutEffect(() => {
                        const ta = taRef.current;
                        if (!ta) return;
                        const onIn = () => {
                            globalPromptValue = ta.value;
                            if (globalPromptWidget) {
                                globalPromptWidget.value = ta.value;
                                if (globalPromptWidget.callback) globalPromptWidget.callback(ta.value);
                            }
                            if (app.graph) app.graph.setDirtyCanvas(true, false);
                            if (gpSaveTimeout) clearTimeout(gpSaveTimeout);
                            gpSaveTimeout = setTimeout(() => {
                                if (app.graph && app.graph.change) app.graph.change();
                                if (window.LiteGraph && window.LiteGraph.fireEvent) window.LiteGraph.fireEvent("onSaveState");
                            }, 300);
                        };
                        ta.addEventListener("input", onIn);
                        return () => ta.removeEventListener("input", onIn);
                    }, []);
                    // 外部写入（onConfigure 恢复等）→ 同步 textarea
                    useEffect(() => {
                        const ta = taRef.current;
                        if (ta && ta.value !== globalPromptValue) ta.value = globalPromptValue;
                    });
                    return html`<div ref=${setUiEl("globalPrompt")} class="ref-ms-global-prompt">
                        <div class="ref-ms-global-prompt-label">${t("Global Prompt")}</div>
                        <textarea ref=${taRef} class="ref-ms-global-prompt-input" placeholder=${t("GlobalPromptHint")} spellcheck=${false}></textarea>
                    </div>`;
                };

                // 顶部类型 tab
                const TabsBar = () => html`<div ref=${setUiEl("tabBar")} class="ref-ms-tabs">
                    ${TYPE_TABS.map((tb) => html`
                        <button key=${tb} class=${"ref-ms-tab" + (tb === activeTab ? " active" : "")} onClick=${() => { if (activeTab !== tb) { activeTab = tb; renderSubjects(); updateNodeSize(); } }}>${tb}</button>`)}
                </div>`;

                // 卡片列表（拦截滚轮防误拖动画布）
                const ListBox = () => {
                    const listRef = useRef(null);
                    useLayoutEffect(() => {
                        const el = listRef.current;
                        if (!el) return;
                        const onWheel = (e) => {
                            if (e.ctrlKey || e.metaKey) return; // 保留画布缩放快捷键
                            const maxTop = el.scrollHeight - el.clientHeight;
                            // 关键：preventDefault() 会同时取消浏览器对该元素的“原生滚动”，
                            // 所以必须在此手动写 scrollTop，否则列表滚轮/中键滚动完全失效
                            //（只能拖滚动条）。仅列表尚有滚动余量时接管，并把事件吞掉
                            // 避免冒泡到画布触发缩放/平移；已到边界或无溢出则放行给画布。
                            if (maxTop > 0 && (e.deltaY < 0 ? el.scrollTop > 0 : el.scrollTop < maxTop)) {
                                e.stopPropagation();
                                e.preventDefault();
                                // deltaMode: 0=像素, 1=行(Firefox), 2=页；统一换算成像素
                                const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
                                el.scrollTop = Math.max(0, Math.min(maxTop, el.scrollTop + step));
                            }
                        };
                        el.addEventListener("wheel", onWheel, { passive: false });
                        uiEls.subjectList = el;
                        return () => { el.removeEventListener("wheel", onWheel); if (uiEls.subjectList === el) delete uiEls.subjectList; };
                    }, []);
                    const visible = visibleSubjectsOfTab();
                    return html`<div ref=${listRef} class="ref-ms-subject-list">
                        ${visible.map((subj, i) => html`<${SubjectCard} key=${subj.uid || (subj.type + i)} subj=${subj} i=${i} />`)}
                    </div>`;
                };

                // 新增主体按钮
                const AddRow = () => html`<button ref=${setUiEl("addBtn")} class="ref-ms-add-btn" onClick=${() => {
                    subjects.push({ name: "", description: "", type: activeTab, relationship: refDefaultRelationship(activeTab), audioRef: "", retention: "", imageFile: "", imageB64: "", audioFile: "", audioB64: "", videoFile: "", videoB64: "", uid: genUid(), ownerUid: "" });
                    subjectCount = Math.max(1, visibleSubjects().length);
                    renderSubjects();
                    saveState();
                    updateNodeSize();
                }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> ${t("Add")} ${t(activeTab)}
                </button>`;

                // 底部计数
                const FootBox = () => {
                    const visible = visibleSubjectsOfTab();
                    const typeLabel = t(activeTab);
                    const pluralS = getLocale() === "en" && visible.length !== 1 ? "s" : "";
                    return html`<div ref=${setUiEl("footer")} class="ref-ms-footer">${visible.length} ${typeLabel}${pluralS}</div>`;
                };

                // UI 根：全局提示 / tabs / 列表 / 新增 / footer
                const SubjectEditor = () => html`<${Fragment}>
                    <${GPBox} />
                    <${TabsBar} />
                    <${ListBox} />
                    <${AddRow} />
                    <${FootBox} />
                </${Fragment}>`;

                // Preact 渲染入口（替代原命令式 DOM 构建）
                function renderSubjects() {
                    closeMention();
                    render(h(SubjectEditor), wrapper);
                }

                function basename(path) {
                    if (!path) return "";
                    const parts = path.replace(/\\/g, "/").split("/");
                    return parts[parts.length - 1];
                }

                // 可见性重试机制：
                // 刷新工作流后，DOM widget 元素并非创建即挂载——它要等画布首个高质量帧真正绘制节点时才被
                // 挂载/显示。在此之前 wrapper.scrollHeight 恒为 0，若把“兜底估算”写进 node.size，
                // 主体列表（唯一可压缩的 flex 子项）会被压成 0 高度且不会自动恢复（此前的刷新即崩根因）。
                // 因此：从未实测成功前，updateNodeSize 不采纳估算值，而是挂起短循环等待元素可见后补测。
                let heightRetryTimer = null;
                let heightRetryCount = 0;
                function armHeightRetry() {
                    if (heightRetryTimer !== null || lastContentH > 0) return;
                    heightRetryTimer = setTimeout(() => {
                        heightRetryTimer = null;
                        if (lastContentH > 0) return; // 已实测成功，无需再等
                        if (++heightRetryCount > 80) return; // ≤8s 上限，防空转
                        if (!wrapperVisible()) {
                            armHeightRetry(); // 元素仍未挂载/可见 → 继续等待下一帧
                            return;
                        }
                        // 元素现已可见：重新实测并采纳真实高度（语义同上：widget.y + computeSize[1] + 4）
                        const sz = domWidget.computeSize ? domWidget.computeSize() : null;
                        if (sz && sz[1] > 0) {
                            node.size[1] = (domWidget.y || 0) + sz[1] + 4;
                            if (typeof domWidget.computedHeight === "number") {
                                domWidget.computedHeight = sz[1] + 4;
                            }
                        }
                        if (app.graph) app.graph.setDirtyCanvas(true, true);
                        if (lastContentH <= 0) armHeightRetry();
                    }, 100);
                }

                // 高度收敛重测机制：
                // 卡片里的媒体（图片/音频封面/视频首帧）与数据恢复是异步完成的——刷新后首轮实测常发生在
                // 媒体就绪之前，此时测得的“自然高”偏小并被写进 node.size。媒体加载完成后内容真实变高，
                // 但前端已把 wrapper 高度锁定在旧值 → 列表容器不足、内容被裁成滚动条（“高度不到封顶高也滚动”）。
                // 因此：每次实测写回后，若测得高度仍在漂移（与上次写回差 >1px），延迟 400ms 再测一轮，
                // 直到连续两次一致为止（上限 8s 防空转）。高度稳定后自动停止，不影响后续手动调整。
                let reflowTimer = null;
                let lastAppliedH = 0;
                let reflowTries = 0;
                function scheduleReflow() {
                    if (reflowTimer !== null || reflowTries >= 20) return;
                    reflowTimer = setTimeout(() => {
                        reflowTimer = null;
                        if (wrapperVisible()) updateNodeSize();
                    }, 400);
                }

                function updateNodeSize() {
                    if (domWidget.computeSize) {
                        const sz = domWidget.computeSize(); // 元素可见时会顺手更新 lastContentH
                        const nowMeasured = lastContentH > 0 || (wrapperVisible() && measureWrapperHeight() > 0);
                        if (nowMeasured) {
                            // node.size 语义与 litegraph _arrangeWidgets 一致：
                            // 节点高 = widget.y + computedHeight(=computeSize()[1]+4)。否则手动写值
                            // 会被 arrange 的“只增不减”回写覆盖，收缩场景失效。
                            const target = (domWidget.y || 0) + sz[1] + 4;
                            node.size[1] = target;
                            // 主动同步 widget.computedHeight：前端 GraphView updateWidgets 每帧用
                            // computedHeight - 2×DEFAULT_MARGIN(10) 计算 .dom-widget 元素高度，
                            // 这里直接对齐 computeSize()[1]+4，不等下一次 _arrangeWidgets 才刷新。
                            if (typeof domWidget.computedHeight === "number") {
                                domWidget.computedHeight = sz[1] + 4;
                            }
                            if (Math.abs(target - lastAppliedH) > 1 && wrapperVisible()) {
                                // 高度仍在漂移（媒体/异步内容未就绪）→ 继续收敛重测
                                lastAppliedH = target;
                                reflowTries++;
                                scheduleReflow();
                            } else {
                                lastAppliedH = target;
                                reflowTries = 0; // 已稳定，复位漂移计数
                            }
                        } else {
                            // 元素不可见/从未实测成功：跳过，避免用估算值把节点压塌；元素可见后会自动补测
                            armHeightRetry();
                        }
                    }
                    if (app.graph) {
                        app.graph.setDirtyCanvas(true, true);
                    }
                }

                // 元素挂载/显隐变化监听：一旦 wrapper 首次真正挂载可见（或重新可见），
                // 若从未实测成功则立即触发一次补测，覆盖首帧估算阶段与缩放手势后的恢复。
                let mountRO = null;
                try {
                    if (typeof ResizeObserver !== "undefined" && wrapper) {
                        mountRO = new ResizeObserver(() => {
                            if (lastContentH <= 0 && wrapperVisible()) updateNodeSize();
                        });
                        mountRO.observe(wrapper);
                    }
                } catch (_) {
                    mountRO = null;
                }

                // 全局提示输入、新增按钮均已由 Preact 组件（GPBox / AddRow）接管，
                // 此处不再需要命令式监听。

                // Handle drag-and-drop for the entire wrapper
                wrapper.addEventListener("dragover", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    wrapper.style.outline = "2px dashed #38bdf8";
                });
                wrapper.addEventListener("dragleave", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    wrapper.style.outline = "";
                });
                wrapper.addEventListener("drop", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    wrapper.style.outline = "";
                    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        const file = e.dataTransfer.files[0];
                        const nameLower = file.name.toLowerCase();
                        const isImage = file.type.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(nameLower);
                        const isAudio = file.type.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(nameLower);
                        const isVideo = file.type.startsWith("video/") || /\.(mp4|webm|mkv|mov|m4v|flv|wmv)$/i.test(nameLower);
                        if (!isImage && !isAudio && !isVideo) return;

                        const field = isVideo ? "videoFile" : isAudio ? "audioFile" : "imageFile";
                        const type = isVideo ? "Video" : isAudio ? "Audio" : "Picture";

                        uploadFile(file, (filename, mediaUrl) => {
                            // 按文件类型分发到最后一个空卡片，否则新建对应类型的卡片（跳过上传生成的引用子主体）
                            const nonChildren = subjects.filter(s => !isChildSubject(s));
                            const last = nonChildren[nonChildren.length - 1];
                            let target = null;
                            if (last && !last.name && !last[field]) {
                                target = last; // 复用空卡片
                            }
                            if (!target) {
                                subjects.push({ name: "", description: "", type, relationship: refDefaultRelationship(type), audioRef: "", retention: "", imageFile: "", imageB64: "", audioFile: "", videoFile: "", videoB64: "", uid: genUid(), ownerUid: "" });
                                subjectCount = Math.max(1, visibleSubjects().length);
                                target = subjects[subjects.length - 1];
                            }
                            if (!REF_TYPE_MEDIA[target.type] || !REF_TYPE_MEDIA[target.type][isVideo ? "video" : isAudio ? "audio" : "image"]) {
                                target.type = type; // 空卡片类型不支持该媒体时联动切换
                                target.relationship = refDefaultRelationship(type);
                            }
                            target[field] = filename;
                            if (isImage) target.imageB64 = mediaUrl;
                            else if (isVideo) target.videoB64 = mediaUrl;
                            // 切换到对应类型 tab，让新卡片可见
                            activeTab = type;
                            renderSubjects();
                            saveState();
                            updateNodeSize();
                        });
                    }
                });

                // Initial render
                setTimeout(() => {
                    renderSubjects();
                    node.syncLayoutToNode();
                    updateNodeSize();
                }, 10);

                // Override onResize for layout sync
                const origOnResize = nodeType.prototype.onResize;
                nodeType.prototype.onResize = function (size) {
                    const out = origOnResize ? origOnResize.apply(this, arguments) : undefined;
                    if (this.syncLayoutToNode) this.syncLayoutToNode();
                    return out;
                };

                // Override onConfigure to reload state after widget values are restored (page refresh)
                if (!nodeType.prototype._minimaxRefSubjectConfigured) {
                    nodeType.prototype._minimaxRefSubjectConfigured = true;
                    const origOnConfigure = nodeType.prototype.onConfigure;
                    nodeType.prototype.onConfigure = function (info) {
                        const out = origOnConfigure ? origOnConfigure.apply(this, arguments) : undefined;
                        if (this._reloadMiniMaxSubjects) {
                            setTimeout(() => this._reloadMiniMaxSubjects(), 30);
                        }
                        return out;
                    };
                }

                return r;
            };
        }
    }
});
