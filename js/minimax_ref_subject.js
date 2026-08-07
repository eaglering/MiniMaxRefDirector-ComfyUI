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
    background: transparent;
    color: #ff6666;
    border: 1px solid #3a1515;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    padding: 2px 8px;
    transition: all 0.15s;
}
.ref-ms-card-remove:hover {
    background: #4a1515;
    color: #ffaaaa;
    border-color: #cc4444;
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
.ref-ms-file-row {
    display: flex;
    gap: 6px;
    align-items: center;
}
.ref-ms-file-btn {
    background: #2a2a2a;
    color: #bbb;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 4px;
}
.ref-ms-file-btn:hover {
    background: #333;
    border-color: #666;
    color: #fff;
}
.ref-ms-file-btn.has-file {
    border-color: #38bdf8;
    color: #38bdf8;
    background: rgba(56, 189, 248, 0.08);
}
.ref-ms-file-name {
    font-size: 10px;
    color: #666;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
}
.ref-ms-file-name.has-file {
    color: #38bdf8;
}
.ref-ms-thumb-preview {
    width: 60px;
    height: 60px;
    border-radius: 4px;
    border: 1px solid #444;
    object-fit: cover;
    background: #151515;
    flex-shrink: 0;
}
.ref-ms-add-btn {
    background: #252525;
    color: #38bdf8;
    border: 1px dashed #38bdf8;
    border-radius: 4px;
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    text-align: center;
    width: 100%;
    box-sizing: border-box;
}
.ref-ms-add-btn:hover {
    background: rgba(56, 189, 248, 0.1);
    border-style: solid;
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
                addBtn.textContent = "+ Add Subject";

                const footer = document.createElement("div");
                footer.className = "ref-ms-footer";
                footer.textContent = "Up to 9 subjects";

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
                    subjectCount = Math.max(1, Math.min(9, countVal));

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
                        removeBtn.textContent = "Remove";
                        if (subjects.length <= 1) {
                            removeBtn.disabled = true;
                            removeBtn.style.opacity = "0.3";
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

                        // Image upload
                        const imgRow = document.createElement("div");
                        imgRow.className = "ref-ms-file-row";

                        // Thumbnail preview
                        const thumb = document.createElement("img");
                        thumb.className = "ref-ms-thumb-preview";
                        if (subj.imageFile) {
                            let subfolder = "";
                            let fname = subj.imageFile;
                            if (fname.includes("/") || fname.includes("\\")) {
                                const sep = fname.includes("/") ? "/" : "\\";
                                const parts = fname.split(sep);
                                fname = parts.pop();
                                subfolder = parts.join("/");
                            }
                            thumb.src = subj.imageB64;
                        }

                        const imgFileBtn = document.createElement("button");
                        imgFileBtn.className = "ref-ms-file-btn";
                        if (subj.imageFile) imgFileBtn.classList.add("has-file");
                        imgFileBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg> Image`;
                        imgFileBtn.addEventListener("click", () => {
                            createFileInput("image/*", (filename, imgUrl) => {
                                subjects[idx].imageFile = filename;
                                imgFileBtn.classList.add("has-file");
                                imgFileName.textContent = basename(filename);
                                imgFileName.classList.add("has-file");
                                // Update thumbnail
                                let subfolder = "";
                                let fname = filename;
                                if (fname.includes("/") || fname.includes("\\")) {
                                    const sep = fname.includes("/") ? "/" : "\\";
                                    const parts = fname.split(sep);
                                    fname = parts.pop();
                                    subfolder = parts.join("/");
                                }
                                thumb.src = imgUrl;
                                saveState();
                            });
                        });

                        const imgFileName = document.createElement("span");
                        imgFileName.className = "ref-ms-file-name";
                        if (subj.imageFile) {
                            imgFileName.textContent = basename(subj.imageFile);
                            imgFileName.classList.add("has-file");
                        } else {
                            imgFileName.textContent = "No file";
                        }

                        imgRow.appendChild(thumb);
                        imgRow.appendChild(imgFileBtn);
                        imgRow.appendChild(imgFileName);
                        card.appendChild(imgRow);

                        // Audio upload
                        const audRow = document.createElement("div");
                        audRow.className = "ref-ms-file-row";

                        const audSpacer = document.createElement("div");
                        audSpacer.style.width = "60px";
                        audSpacer.style.flexShrink = "0";

                        const audFileBtn = document.createElement("button");
                        audFileBtn.className = "ref-ms-file-btn";
                        if (subj.audioFile) audFileBtn.classList.add("has-file");
                        audFileBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg> Audio`;
                        audFileBtn.addEventListener("click", () => {
                            createFileInput("audio/*,video/*", (filename) => {
                                subjects[idx].audioFile = filename;
                                audFileBtn.classList.add("has-file");
                                audFileName.textContent = basename(filename);
                                audFileName.classList.add("has-file");
                                saveState();
                            });
                        });

                        const audFileName = document.createElement("span");
                        audFileName.className = "ref-ms-file-name";
                        if (subj.audioFile) {
                            audFileName.textContent = basename(subj.audioFile);
                            audFileName.classList.add("has-file");
                        } else {
                            audFileName.textContent = "No file";
                        }

                        audRow.appendChild(audSpacer);
                        audRow.appendChild(audFileBtn);
                        audRow.appendChild(audFileName);
                        card.appendChild(audRow);

                        subjectList.appendChild(card);
                    });

                    // Update add button state
                    addBtn.disabled = subjects.length >= 9;
                    addBtn.textContent = subjects.length >= 9 ? "Max 9 subjects" : "+ Add Subject";
                    footer.textContent = `${subjects.length}/9 subjects`;
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
                    if (subjects.length >= 9) return;
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
                            const targetIdx = subjects.length < 9 ? subjects.length : -1;
                            if (targetIdx >= 0) {
                                // Check if we need to add a new subject
                                const last = subjects[subjects.length - 1];
                                if (!last || last.imageFile || last.name) {
                                    if (subjects.length < 9) {
                                        subjects.push({ name: "", description: "", imageFile: filename, imageB64: imgUrl, audioFile: "" });
                                        subjectCount = subjects.length;
                                        renderSubjects();
                                        saveState();
                                        updateNodeSize();
                                    }
                                } else {
                                    last.imageFile = filename;
                                    last.imageB64 = imgUrl;
                                    renderSubjects();
                                    saveState();
                                }
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
