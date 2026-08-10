import { app } from "../../scripts/app.js";
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
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.ref-ms-subject-card {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: border-color 0.2s;
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
.ref-ms-label {
    font-size: 10px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    min-width: 60px;
    flex-shrink: 0;
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
.ref-ms-textarea {
    flex: 1;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 4px 8px;
    font-size: 11px;
    font-family: inherit;
    outline: none;
    resize: vertical;
    min-height: 40px;
    box-sizing: border-box;
    transition: border-color 0.2s;
}
.ref-ms-textarea:focus {
    border-color: #888;
}
/* --- Media box styles (right-aligned image & audio) --- */
.ref-ms-media-row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 4px;
}
.ref-ms-media-box {
    width: 72px;
    height: 72px;
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
                if (subjectDataWidget) hideWidget(subjectDataWidget);
                if (subjectCountWidget) hideWidget(subjectCountWidget);

                // --- Build Custom UI ---
                const wrapper = document.createElement("div");
                wrapper.className = "ref-ms-wrapper";

                const subjectList = document.createElement("div");
                subjectList.className = "ref-ms-subject-list";

                const addBtn = document.createElement("button");
                addBtn.className = "ref-ms-add-btn";
                addBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Add Subject`;

                const footer = document.createElement("div");
                footer.className = "ref-ms-footer";
                footer.textContent = "Up 9 subjects，3 audios per shot";

                wrapper.appendChild(subjectList);
                wrapper.appendChild(addBtn);
                wrapper.appendChild(footer);

                const domWidget = this.addDOMWidget("minimax_subject_ui", "minimax_subject_ui", wrapper);

                // --- State ---
                let subjects = [];
                let subjectCount = 1;
                
                domWidget.computeSize = function (width) {
                    const nodeWidth = node.size?.[0] || 475;
                    const estCardHeight = 200; // per subject card
                    const extras = 128; // add button + footer + gaps
                    const total = subjects.length * estCardHeight + extras;
                    const height = Math.max(estCardHeight + extras, total);
                    return [Math.max(10, nodeWidth - 30), height];
                };

                node.syncLayoutToNode = function () {
                    // const nodeWidth = this.size?.[0] || 475;
                    // const targetWidth = Math.max(10, nodeWidth - 30);
                    // if (wrapper) {
                    //     wrapper.style.width = `${targetWidth}px`;
                    //     wrapper.style.maxWidth = `${targetWidth}px`;
                    // }
                };

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
                                        imageFile: s.imageFile || "",
                                        imageB64: s.imageB64 || api.apiURL(`/view?filename=${encodeURIComponent(s.imageFile)}&type=input&subfolder=${encodeURIComponent("minimaxrefdirector")}`),
                                        audioFile: s.audioFile || "",
                                    });
                                });
                            }
                        }
                    } catch (_) { }

                    const countVal = subjectCountWidget ? parseInt(subjectCountWidget.value) || 1 : 1;
                    subjectCount = Math.max(1, countVal);

                    if (subjects.length === 0) {
                        while (subjects.length < subjectCount) {
                            subjects.push({ name: "", description: "", imageFile: "", audioFile: "" });
                        }
                    } else {
                        subjectCount = subjects.length;
                    }
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
                            const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
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
                        url = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
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
                            imageFile: s.imageFile,
                            audioFile: s.audioFile,
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
                }

                function renderSubjects() {
                    subjectList.innerHTML = "";
                    subjects.forEach((subj, idx) => {
                        const card = document.createElement("div");
                        card.className = "ref-ms-subject-card";

                        // Header
                        const header = document.createElement("div");
                        header.className = "ref-ms-card-header";
                        const indexLabel = document.createElement("span");
                        indexLabel.className = "ref-ms-card-index";
                        indexLabel.textContent = `Subject ${idx + 1}`;
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
                        descInput.rows = 2;
                        descInput.addEventListener("input", () => {
                            subjects[idx].description = descInput.value;
                            saveState();
                        });
                        descRow.appendChild(descLabel);
                        descRow.appendChild(descInput);
                        card.appendChild(descRow);

                        // --- Media boxes (right-aligned image & audio) ---
                        const mediaRow = document.createElement("div");
                        mediaRow.className = "ref-ms-media-row";

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
                            createFileInput("audio/*,video/*", (filename) => {
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
                        mediaRow.appendChild(audioBox);

                        card.appendChild(mediaRow);

                        subjectList.appendChild(card);
                    });

                    // Update add button state
                    addBtn.disabled = false;
                    addBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Add Subject`;
                    footer.textContent = `${subjects.length} subject${subjects.length !== 1 ? "s" : ""}`;
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

                addBtn.addEventListener("click", () => {
                    subjects.push({ name: "", description: "", imageFile: "", audioFile: "" });
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
                        uploadFile(file, (filename, imgUrl) => {
                            // Add dropped file as image for the first empty image slot
                            // or create a new subject
                            const last = subjects[subjects.length - 1];
                            if (!last || last.imageFile || last.name) {
                                subjects.push({ name: "", description: "", imageFile: filename, imageB64: imgUrl, audioFile: "" });
                                subjectCount = subjects.length;
                                renderSubjects();
                                saveState();
                                updateNodeSize();
                            } else {
                                last.imageFile = filename;
                                last.imageB64 = imgUrl;
                                renderSubjects();
                                saveState();
                            }
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
