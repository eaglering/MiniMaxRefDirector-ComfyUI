import { app } from "../../scripts/app.js";
import { viewUrl } from "./components/director/shared.js";
import { api } from "../../scripts/api.js";

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
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
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
    min-width: 40px;
}
.ref-ms-input {
    flex: 1;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 4px 8px;
    font-size: 12px;
    font-family: inherit;
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
    font-family: inherit;
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
    font-family: inherit;
    outline: none;
    resize: vertical;
    min-height: 60px;
    box-sizing: border-box;
    transition: border-color 0.2s;
}
.ref-ms-textarea:focus {
    border-color: #888;
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
}
.ref-ms-global-prompt-input:focus {
    border-color: #888;
}
/* --- Media box styles (attached to desc row, right-aligned image & audio) --- */
.ref-ms-media-box {
    width: 56px;
    height: 56px;
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
`;

let styleEl = document.getElementById("minimax-subject-styles");
if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "minimax-subject-styles";
    document.head.appendChild(styleEl);
}
styleEl.textContent = MSCSS;

// 图像类主体（Subject / Picture / Video）的关系选项
const REF_RELATIONSHIPS_PRESERVED = [
    ["fully_preserved", "fully preserved"],
    ["partially_preserved", "partially preserved"],
    ["attribute_transfer", "attribute transfer"],
    ["weak_reference", "weak reference"],
];

// Audio 的关系选项
const REF_RELATIONSHIPS_COPY = [
    ["fully_copy", "fully copy"],
    ["partially_copy", "partially copy"],
    ["reference", "reference"],
    ["weak_reference", "weak reference"],
];

// type → 关系选项组（联动）
const REF_TYPE_RELATIONSHIPS = {
    Subject: REF_RELATIONSHIPS_PRESERVED,
    Picture: REF_RELATIONSHIPS_PRESERVED,
    Video: REF_RELATIONSHIPS_PRESERVED,
    Audio: REF_RELATIONSHIPS_COPY,
};

// type → relationship 默认值
function refDefaultRelationship(type) {
    return (REF_TYPE_RELATIONSHIPS[type || "Subject"] || REF_RELATIONSHIPS_PRESERVED)[0][0];
}

// type → 可上传的媒体类型（联动显示）
const REF_TYPE_MEDIA = {
    Subject: { image: true, audio: true, video: false },
    Picture: { image: true, audio: false, video: false },
    Audio: { image: false, audio: true, video: false },
    Video: { image: false, audio: false, video: true },
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

                const globalPromptBox = document.createElement("div");
                globalPromptBox.className = "ref-ms-global-prompt";
                const globalPromptLabel = document.createElement("div");
                globalPromptLabel.className = "ref-ms-global-prompt-label";
                globalPromptLabel.textContent = "Global Prompt";
                const globalPromptInput = document.createElement("textarea");
                globalPromptInput.className = "ref-ms-global-prompt-input";
                globalPromptInput.placeholder = "Conditions the entire video (anchors persistent characters, objects, scene context)...";
                globalPromptInput.spellcheck = false;
                globalPromptBox.appendChild(globalPromptLabel);
                globalPromptBox.appendChild(globalPromptInput);

                // --- Type tabs (Subject / Picture / Video / Audio) ---
                let activeTab = "Subject"; // 当前 tab，替代卡片内 type 选择
                const TYPE_TABS = ["Subject", "Picture", "Video", "Audio"];
                const tabBar = document.createElement("div");
                tabBar.className = "ref-ms-tabs";
                const tabBtns = {};
                TYPE_TABS.forEach(t => {
                    const btn = document.createElement("button");
                    btn.className = "ref-ms-tab";
                    btn.textContent = t;
                    btn.addEventListener("click", () => {
                        if (activeTab === t) return;
                        activeTab = t;
                        renderSubjects();
                        updateNodeSize();
                    });
                    tabBar.appendChild(btn);
                    tabBtns[t] = btn;
                });

                const subjectList = document.createElement("div");
                subjectList.className = "ref-ms-subject-list";

                const addBtn = document.createElement("button");
                addBtn.className = "ref-ms-add-btn";
                addBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Add Subject`;

                const footer = document.createElement("div");
                footer.className = "ref-ms-footer";
                footer.textContent = "Up 9 subjects，3 audios per shot";

                wrapper.appendChild(globalPromptBox);
                wrapper.appendChild(tabBar);
                wrapper.appendChild(subjectList);
                wrapper.appendChild(addBtn);
                wrapper.appendChild(footer);

                const domWidget = this.addDOMWidget("minimax_subject_ui", "minimax_subject_ui", wrapper);

                // --- State ---
                let subjects = [];
                let subjectCount = 1;
                
                domWidget.computeSize = function (width) {
                    const nodeWidth = node.size?.[0] || 475;
                    const innerWidth = Math.max(10, nodeWidth - 30); // DOM widget 内容宽（与 .ref-ms-wrapper 一致）
                    const listWidth = Math.max(1, innerWidth - 12); // 列表可用宽（wrapper padding 6px ×2）
                    const estCardHeight = 215; // per subject card (image/audio boxes + video row)
                    const extras = 206; // global prompt area + tabs + add button + footer + gaps
                    const visibleCount = subjects.filter(s => (s.type || "Subject") === activeTab).length;
                    if (visibleCount === 0) return [innerWidth, extras];
                    // 与 CSS .ref-ms-subject-list 的 minmax(340px, 1fr) 对齐：最小列宽 340 + 间隙 6
                    const cols = Math.max(1, Math.floor((listWidth + 6) / 346));
                    const rows = Math.ceil(visibleCount / cols);
                    const height = rows * estCardHeight + extras;
                    return [innerWidth, height];
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
                            relationship: s.relationship || refDefaultRelationship(s.type),
                            imageFile: s.imageFile || "",
                            audioFile: s.audioFile || "",
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
                                        relationship: s.relationship || refDefaultRelationship(s.type),
                                        imageFile: s.imageFile || "",
                                        imageB64: s.imageB64 || viewUrl(s.imageFile, "minimaxrefdirector"),
                                        audioFile: s.audioFile || "",
                                        videoFile: s.videoFile || "",
                                        videoB64: s.videoB64 || viewUrl(s.videoFile, "minimaxrefdirector"),
                                    });
                                });
                            }
                        }
                    } catch (_) { }

                    // Sync global prompt from widget
                    if (globalPromptWidget && globalPromptInput) {
                        globalPromptInput.value = globalPromptWidget.value || "";
                    }

                    const countVal = subjectCountWidget ? parseInt(subjectCountWidget.value) || 1 : 1;
                    subjectCount = Math.max(1, countVal);

                    if (subjects.length === 0) {
                        while (subjects.length < subjectCount) {
                            subjects.push({ name: "", description: "", type: "Subject", relationship: "fully_preserved", imageFile: "", audioFile: "", videoFile: "" });
                        }
                    } else {
                        subjectCount = subjects.length;
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
                        btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> Stop`;
                        btn.classList.add("playing");
                    } else {
                        btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Play`;
                        btn.classList.remove("playing");
                    }
                }

                function stopAudio() {
                    if (_audioEl) {
                        _audioEl.pause();
                        _audioEl.currentTime = 0;
                        if (_audioPlayBtn) {
                            updatePlayBtnIcon(_audioPlayBtn, false);
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
                            relationship: s.relationship || refDefaultRelationship(s.type),
                            imageFile: s.imageFile,
                            audioFile: s.audioFile,
                            videoFile: s.videoFile,
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

                function renderSubjects() {
                    subjectList.innerHTML = "";
                    // tab 高亮
                    TYPE_TABS.forEach(t => {
                        tabBtns[t].classList.toggle("active", t === activeTab);
                    });
                    // 仅渲染当前 tab 类型的卡片
                    const visible = subjects.filter(s => (s.type || "Subject") === activeTab);
                    visible.forEach((subj, i) => {
                        const idx = subjects.indexOf(subj); // 原数组真实索引
                        const card = document.createElement("div");
                        card.className = "ref-ms-subject-card";

                        // Header
                        const header = document.createElement("div");
                        header.className = "ref-ms-card-header";
                        const indexLabel = document.createElement("span");
                        indexLabel.className = "ref-ms-card-index";
                        indexLabel.textContent = `${subj.type || activeTab} ${i + 1}`;
                        header.appendChild(indexLabel);

                        const removeBtn = document.createElement("button");
                        removeBtn.className = "ref-ms-card-remove";
                        removeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Remove`;
                        if (subjects.length <= 1) {
                            removeBtn.disabled = true;
                            removeBtn.style.opacity = "0.35";
                        }
                        removeBtn.addEventListener("click", () => {
                            if (subjects.length <= 1) return;
                            subjects.splice(idx, 1);
                            subjectCount = subjects.length;
                            renderSubjects();
                            saveState();
                            updateNodeSize();
                        });
                        header.appendChild(removeBtn);
                        card.appendChild(header);

                        // Name
                        const nameRow = document.createElement("div");
                        nameRow.className = "ref-ms-row";
                        const nameLabel = document.createElement("span");
                        nameLabel.className = "ref-ms-label";
                        nameLabel.textContent = "Name";
                        const nameInput = document.createElement("input");
                        nameInput.className = "ref-ms-input";
                        nameInput.type = "text";
                        nameInput.placeholder = "Subject name...";
                        nameInput.value = subj.name || "";
                        nameInput.maxLength = 128;
                        nameInput.addEventListener("input", () => {
                            subjects[idx].name = nameInput.value;
                            saveState();
                        });
                        nameRow.appendChild(nameLabel);
                        nameRow.appendChild(nameInput);
                        card.appendChild(nameRow);

                        // Relationship（选项组随当前 tab 类型固定：Subject/Picture/Video 用 preserved 系，Audio 用 copy 系）
                        const metaRow = document.createElement("div");
                        metaRow.className = "ref-ms-row";
                        const relLabel = document.createElement("span");
                        relLabel.className = "ref-ms-label-sm";
                        relLabel.textContent = "Rel";
                        const relSelect = document.createElement("select");
                        relSelect.className = "ref-ms-select";
                        const relOptions = REF_TYPE_RELATIONSHIPS[activeTab] || REF_RELATIONSHIPS_PRESERVED;
                        const relDefault = relOptions[0][0];
                        relOptions.forEach(([val, label]) => {
                            const opt = document.createElement("option");
                            opt.value = val;
                            opt.textContent = label;
                            opt.selected = (subj.relationship || relDefault) === val;
                            relSelect.appendChild(opt);
                        });
                        relSelect.addEventListener("change", () => {
                            subjects[idx].relationship = relSelect.value;
                            saveState();
                        });
                        metaRow.appendChild(relLabel);
                        metaRow.appendChild(relSelect);
                        card.appendChild(metaRow);

                        // Description
                        const descRow = document.createElement("div");
                        descRow.className = "ref-ms-row";
                        const descLabel = document.createElement("span");
                        descLabel.className = "ref-ms-label";
                        descLabel.textContent = "Desc";
                        const descInput = document.createElement("textarea");
                        descInput.className = "ref-ms-textarea";
                        descInput.placeholder = "Subject description...";
                        descInput.value = subj.description || "";
                        descInput.rows = 1;
                        descInput.addEventListener("input", () => {
                            subjects[idx].description = descInput.value;
                            saveState();
                        });
                        descRow.appendChild(descLabel);
                        descRow.appendChild(descInput);
                        card.appendChild(descRow);

                        // --- Media boxes (attached to the desc row for a compact layout) ---
                        // 可上传的媒体随 type 联动（REF_TYPE_MEDIA）
                        const typeMedia = REF_TYPE_MEDIA[subj.type || "Subject"] || REF_TYPE_MEDIA.Subject;
                        const mediaRow = descRow;

                        // ----- Image box -----
                        const imgBox = document.createElement("div");
                        imgBox.className = "ref-ms-media-box";
                        if (subj.imageFile) {
                            imgBox.classList.add("has-file");
                            const thumbImg = document.createElement("img");
                            thumbImg.src = subj.imageB64 || subj.imageFile;
                            thumbImg.alt = "";
                            imgBox.appendChild(thumbImg);
                        } else {
                            const icon = document.createElement("div");
                            icon.className = "ref-ms-media-icon";
                            icon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg><span>Image</span>`;
                            imgBox.appendChild(icon);
                        }

                        const imgOverlay = document.createElement("div");
                        imgOverlay.className = "ref-ms-media-overlay";

                        const imgAddBtn = document.createElement("button");
                        imgAddBtn.className = "ref-ms-media-action";
                        imgAddBtn.textContent = subj.imageFile ? "Change" : "Add";
                        imgAddBtn.addEventListener("click", (e) => {
                            e.stopPropagation();
                            createFileInput("image/*", (filename, imgUrl) => {
                                subjects[idx].imageFile = filename;
                                subjects[idx].imageB64 = imgUrl;
                                saveState();
                                renderSubjects();
                            });
                        });
                        imgOverlay.appendChild(imgAddBtn);

                        if (subj.imageFile) {
                            const imgDelBtn = document.createElement("button");
                            imgDelBtn.className = "ref-ms-media-action del";
                            imgDelBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
                            imgDelBtn.addEventListener("click", (e) => {
                                e.stopPropagation();
                                subjects[idx].imageFile = null;
                                subjects[idx].imageB64 = null;
                                saveState();
                                renderSubjects();
                            });
                            imgOverlay.appendChild(imgDelBtn);
                        }
                        imgBox.appendChild(imgOverlay);
                        if (!typeMedia.image) imgBox.style.display = "none";
                        mediaRow.appendChild(imgBox);

                        // ----- Audio box -----
                        const audioBox = document.createElement("div");
                        audioBox.className = "ref-ms-media-box";
                        if (subj.audioFile) {
                            audioBox.classList.add("has-file");
                            const aIcon = document.createElement("div");
                            aIcon.className = "ref-ms-media-icon";
                            aIcon.style.cssText = "color:#38bdf8;";
                            aIcon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg><span style="font-size:8px;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${basename(subj.audioFile)}</span>`;
                            audioBox.appendChild(aIcon);
                        } else {
                            const icon = document.createElement("div");
                            icon.className = "ref-ms-media-icon";
                            icon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon></svg><span>Audio</span>`;
                            audioBox.appendChild(icon);
                        }

                        const audioOverlay = document.createElement("div");
                        audioOverlay.className = "ref-ms-media-overlay";

                        const audAddBtn = document.createElement("button");
                        audAddBtn.className = "ref-ms-media-action";
                        audAddBtn.textContent = subj.audioFile ? "Change" : "Add";
                        audAddBtn.addEventListener("click", (e) => {
                            e.stopPropagation();
                            createFileInput("audio/*", (filename) => {
                                subjects[idx].audioFile = filename;
                                saveState();
                                renderSubjects();
                            });
                        });
                        audioOverlay.appendChild(audAddBtn);

                        if (subj.audioFile) {
                            const playBtn = document.createElement("button");
                            playBtn.className = "ref-ms-media-action play-btn";
                            playBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Play`;
                            playBtn.addEventListener("click", (e) => {
                                e.stopPropagation();
                                playAudio(subj.audioFile, playBtn);
                            });
                            audioOverlay.appendChild(playBtn);

                            const audDelBtn = document.createElement("button");
                            audDelBtn.className = "ref-ms-media-action del";
                            audDelBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
                            audDelBtn.addEventListener("click", (e) => {
                                e.stopPropagation();
                                subjects[idx].audioFile = null;
                                saveState();
                                renderSubjects();
                            });
                            audioOverlay.appendChild(audDelBtn);
                        }
                        audioBox.appendChild(audioOverlay);
                        if (!typeMedia.audio) audioBox.style.display = "none";
                        mediaRow.appendChild(audioBox);

                        // ----- Video row (type=Video, 单独一行大图预览/替换/删除) -----
                        const videoRow = document.createElement("div");
                        videoRow.className = "ref-ms-video-row";
                        if (subj.videoFile) {
                            videoRow.classList.add("has-file");
                            const vEl = document.createElement("video");
                            vEl.src = subj.videoB64 || subj.videoFile;
                            vEl.controls = true;
                            vEl.preload = "metadata";
                            vEl.addEventListener("click", (e) => e.stopPropagation());
                            videoRow.appendChild(vEl);
                        } else {
                            const icon = document.createElement("div");
                            icon.className = "ref-ms-media-icon";
                            icon.style.cssText = "flex-direction: row; gap: 8px;";
                            icon.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg><span>Upload Video</span>`;
                            videoRow.appendChild(icon);
                        }

                        // 右下角浮动按钮组：不覆盖视频主体，可正常播放/预览
                        const videoActions = document.createElement("div");
                        videoActions.className = "ref-ms-video-actions";

                        const vidAddBtn = document.createElement("button");
                        vidAddBtn.className = "ref-ms-video-action";
                        vidAddBtn.textContent = subj.videoFile ? "Change" : "Add";
                        vidAddBtn.title = "替换视频";
                        vidAddBtn.addEventListener("click", (e) => {
                            e.stopPropagation();
                            createFileInput("video/*", (filename, videoUrl) => {
                                subjects[idx].videoFile = filename;
                                subjects[idx].videoB64 = videoUrl;
                                saveState();
                                renderSubjects();
                            });
                        });
                        videoActions.appendChild(vidAddBtn);

                        if (subj.videoFile) {
                            const vidDelBtn = document.createElement("button");
                            vidDelBtn.className = "ref-ms-video-action del";
                            vidDelBtn.textContent = "Delete";
                            vidDelBtn.title = "删除视频";
                            vidDelBtn.addEventListener("click", (e) => {
                                e.stopPropagation();
                                subjects[idx].videoFile = null;
                                subjects[idx].videoB64 = null;
                                saveState();
                                renderSubjects();
                            });
                            videoActions.appendChild(vidDelBtn);
                        }
                        videoRow.appendChild(videoActions);
                        if (!typeMedia.video) videoRow.style.display = "none";
                        card.appendChild(mediaRow);
                        card.appendChild(videoRow);

                        subjectList.appendChild(card);
                    });

                    // Update add button state
                    addBtn.disabled = false;
                    addBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Add ${activeTab}`;
                    footer.textContent = `${visible.length} ${activeTab}${visible.length !== 1 ? "s" : ""}`;
                }

                function basename(path) {
                    if (!path) return "";
                    const parts = path.replace(/\\/g, "/").split("/");
                    return parts[parts.length - 1];
                }

                function updateNodeSize() {
                    if (domWidget.computeSize) {
                        const sz = domWidget.computeSize();
                        node.size[1] = sz[1] + 20;
                    }
                    if (app.graph) {
                        app.graph.setDirtyCanvas(true, true);
                    }
                }

                // Global Prompt input → widget sync
                let gpSaveTimeout = null;
                globalPromptInput.addEventListener("input", () => {
                    const val = globalPromptInput.value;
                    if (globalPromptWidget) {
                        globalPromptWidget.value = val;
                        if (globalPromptWidget.callback) {
                            globalPromptWidget.callback(val);
                        }
                    }
                    if (app.graph) {
                        app.graph.setDirtyCanvas(true, false);
                    }
                    if (gpSaveTimeout) clearTimeout(gpSaveTimeout);
                    gpSaveTimeout = setTimeout(() => {
                        if (app.graph && app.graph.change) app.graph.change();
                        if (window.LiteGraph && window.LiteGraph.fireEvent) {
                            window.LiteGraph.fireEvent("onSaveState");
                        }
                    }, 300);
                });

                addBtn.addEventListener("click", () => {
                    subjects.push({ name: "", description: "", type: activeTab, relationship: refDefaultRelationship(activeTab), imageFile: "", audioFile: "", videoFile: "" });
                    subjectCount = subjects.length;
                    renderSubjects();
                    saveState();
                    updateNodeSize();
                });

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
                            // 按文件类型分发到最后一个空卡片，否则新建对应类型的卡片
                            const last = subjects[subjects.length - 1];
                            if (!last || last.name || last[field]) {
                                subjects.push({ name: "", description: "", type, relationship: refDefaultRelationship(type), imageFile: "", imageB64: "", audioFile: "", videoFile: "", videoB64: "" });
                                subjectCount = subjects.length;
                            }
                            const target = subjects[subjects.length - 1];
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
