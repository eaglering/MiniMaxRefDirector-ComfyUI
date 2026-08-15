// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: createDOM, syncWidgetsAndUI, checkResize, syncLayoutToNode, getRenderScale, resizeCanvas, getMousePos, updateWidgetVisibility
import { CANVAS_HEIGHT, ICONS, RULER_HEIGHT, app, clamp, hideWidget, showWidget } from "./shared.js";
import { render } from "../../vendor/preact.module.js";
import { mountTransfer } from "./transfer.js";

export const dom = {
  createDOM() {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "pr-wrapper";

    this.wrapper.addEventListener("mouseenter", () => { this._isHovering = true; });
    this.wrapper.addEventListener("mouseleave", () => { this._isHovering = false; });

    this.handleKeyDown = (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : "";
      if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

      const isCtrl = e.ctrlKey || e.metaKey;

      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedIndex !== -1 && this._isHovering) {
        this.deleteSelectedSegment();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === " " || e.code === "Space") && this._isHovering) {
        this.togglePlay();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "b" || e.key === "B") && isCtrl && this._isHovering) {
        if (this.selectedIndex !== -1) {
          const arr = this.getSegmentArray(this.selectionType);
          const seg = arr[this.selectedIndex];
          if (seg) this.splitSegmentAtPlayhead(seg, this.selectionType);
        }
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "c" || e.key === "C") && isCtrl && this._isHovering) {
        if (this.selectedIndex !== -1) {
          const arr = this.getSegmentArray(this.selectionType);
          const seg = arr[this.selectedIndex];
          if (seg) {
            window._ltxCopiedSegment = { main: { ...seg }, sibling: null };
            window._ltxCopiedSegmentType = this.selectionType;

            // Keep image/video elements
            if (seg.imgObj) window._ltxCopiedSegment.main.imgObj = seg.imgObj;
            if (seg.videoEl) window._ltxCopiedSegment.main.videoEl = seg.videoEl;

            if (seg.id.endsWith("_v") || seg.id.endsWith("_a")) {
              const isVid = seg.id.endsWith("_v");
              const sibId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
              const sibArr = isVid ? this.timeline.audioSegments : this.timeline.segments;
              const sib = sibArr.find(s => s.id === sibId);
              if (sib) {
                window._ltxCopiedSegment.sibling = { ...sib };
                if (sib.imgObj) window._ltxCopiedSegment.sibling.imgObj = sib.imgObj;
                if (sib.videoEl) window._ltxCopiedSegment.sibling.videoEl = sib.videoEl;
              }
            }
          }
        }
      } else if ((e.key === "v" || e.key === "V") && isCtrl && this._isHovering) {
        if (window._ltxCopiedSegment) {
          this.pasteCopiedSegment();
          e.stopPropagation();
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      } else if ((e.key === "s" || e.key === "S") && !isCtrl && this._isHovering) {
        this.isSnapping = !this.isSnapping;
        this.node.properties.isSnapping = this.isSnapping;
        if (typeof this.updateSnapStyle === "function") {
          this.updateSnapStyle();
        }
        this.commitChanges();
        this.render();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "i" || e.key === "I") && !isCtrl && this._isHovering) {
        if (this.startFramesWidget) {
          this.startFramesWidget.value = this.currentFrame;
          if (this.startFramesWidget.callback) {
            this.startFramesWidget.callback(this.currentFrame);
          }
          this.commitChanges();
          this.render();
        }
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "o" || e.key === "O") && !isCtrl && this._isHovering) {
        if (this.endFramesWidget) {
          this.endFramesWidget.value = this.currentFrame;
          if (this.endFramesWidget.callback) {
            this.endFramesWidget.callback(this.currentFrame);
          }
          this.commitChanges();
          this.render();
        }
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "x" || e.key === "X") && !isCtrl && this._isHovering) {
        this.markCurrentSelection();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", this.handleKeyDown, true);

    this.handlePaste = (e) => {
      if (this._isHovering) {
        const activeTag = document.activeElement ? document.activeElement.tagName : "";
        if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
          const imageFiles = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
          if (imageFiles.length > 0) {
            this.handleImageUpload(imageFiles, this.currentFrame);
            e.preventDefault();
            e.stopPropagation();
          }
        }
      }
    };
    window.addEventListener("paste", this.handlePaste, true);

    // --- Toolbar ---
    const toolbar = document.createElement("div");
    toolbar.className = "pr-toolbar";

    const actionGroup = document.createElement("div");
    actionGroup.className = "pr-actions";

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "image/*";
    this.fileInput.multiple = true;
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", (e) => this.handleImageUpload(e.target.files));

    this.audioFileInput = document.createElement("input");
    this.audioFileInput.type = "file";
    this.audioFileInput.accept = "audio/*";
    this.audioFileInput.multiple = true;
    this.audioFileInput.style.display = "none";
    this.audioFileInput.addEventListener("change", (e) => this.handleAudioUpload(e.target.files));

    this.videoFileInput = document.createElement("input");
    this.videoFileInput.type = "file";
    this.videoFileInput.accept = "video/*";
    this.videoFileInput.multiple = true;
    this.videoFileInput.style.display = "none";
    this.videoFileInput.addEventListener("change", (e) => this.handleVideoUpload(e.target.files));

    const uploadBtn = document.createElement("button");
    uploadBtn.className = "pr-btn";
    uploadBtn.innerHTML = `${ICONS.upload} Add Image`;
    uploadBtn.addEventListener("click", () => this.fileInput.click());
    this.uploadBtn = uploadBtn;

    const uploadAudioBtn = document.createElement("button");
    uploadAudioBtn.className = "pr-btn";
    uploadAudioBtn.innerHTML = `${ICONS.audio} Add Audio`;
    uploadAudioBtn.addEventListener("click", () => this.audioFileInput.click());
    this.uploadAudioBtn = uploadAudioBtn;

    const uploadVideoBtn = document.createElement("button");
    uploadVideoBtn.className = "pr-btn";
    uploadVideoBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Add Video`;
    uploadVideoBtn.addEventListener("click", () => this.videoFileInput.click());
    this.uploadVideoBtn = uploadVideoBtn;

    const addTextBtn = document.createElement("button");
    addTextBtn.className = "pr-btn";
    addTextBtn.innerHTML = `${ICONS.text} Add Text`;
    addTextBtn.addEventListener("click", () => this.addTextSegmentFreeSpace());
    this.addTextBtn = addTextBtn;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "pr-btn pr-btn-danger";
    deleteBtn.innerHTML = `${ICONS.trash} Delete`;
    deleteBtn.addEventListener("click", () => this.deleteSelectedSegment());
    this.deleteBtn = deleteBtn;

    actionGroup.appendChild(this.fileInput);
    actionGroup.appendChild(this.audioFileInput);
    actionGroup.appendChild(this.videoFileInput);
    actionGroup.appendChild(uploadBtn);
    actionGroup.appendChild(addTextBtn);
    actionGroup.appendChild(uploadAudioBtn);
    actionGroup.appendChild(uploadVideoBtn);
    actionGroup.appendChild(deleteBtn);

    // Retake-mode-only delete button (shown next to Add Video when retakeMode is on)
    const deleteRetakeBtn = document.createElement("button");
    deleteRetakeBtn.className = "pr-btn pr-btn-danger";
    deleteRetakeBtn.innerHTML = `${ICONS.trash} Delete`;
    deleteRetakeBtn.title = "Remove retake video";
    deleteRetakeBtn.style.display = "none"; // hidden until retakeMode + video loaded
    deleteRetakeBtn.addEventListener("click", () => {
      this._deleteRetakeVideo();
    });
    this.deleteRetakeBtn = deleteRetakeBtn;
    actionGroup.appendChild(deleteRetakeBtn);

    toolbar.appendChild(actionGroup);

    const rightGroup = document.createElement("div");
    rightGroup.className = "pr-right-group";

    this.segmentBoundsDisplay = document.createElement("div");
    this.segmentBoundsDisplay.className = "pr-segment-bounds";
    this.segmentBoundsDisplay.textContent = "Start: - | End: - | Length: -";

    this.timeCodeDisplay = document.createElement("div");
    this.timeCodeDisplay.className = "pr-timecode";
    this.timeCodeDisplay.textContent = this.formatTime(0);

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "pr-btn";
    settingsBtn.style.padding = "6px";
    settingsBtn.style.display = "flex";
    settingsBtn.style.alignItems = "center";
    settingsBtn.style.justifyContent = "center";
    settingsBtn.style.width = "28px";
    settingsBtn.style.height = "28px";
    settingsBtn.style.boxSizing = "border-box";
    settingsBtn.innerHTML = ICONS.gear;
    settingsBtn.title = "Settings";
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._settingsMenu) {
        this.dismissSettingsMenu();
      } else {
        this.showSettingsMenu(settingsBtn);
      }
    });

    const inpaintToggleBtn = document.createElement("button");
    inpaintToggleBtn.className = "pr-btn";
    inpaintToggleBtn.style.padding = "4px 0px";
    inpaintToggleBtn.style.fontSize = "9px";
    inpaintToggleBtn.style.lineHeight = "1";
    inpaintToggleBtn.style.marginRight = "0px";
    inpaintToggleBtn.style.marginTop = "8px"; // Adjust this value to fine-tune spacing between the title and button
    inpaintToggleBtn.style.width = "72px";
    inpaintToggleBtn.style.whiteSpace = "nowrap";
    inpaintToggleBtn.style.textAlign = "center";
    inpaintToggleBtn.style.justifyContent = "center";
    inpaintToggleBtn.style.alignItems = "center";
    inpaintToggleBtn.style.gap = "0px";
    inpaintToggleBtn.style.boxSizing = "border-box";
    inpaintToggleBtn.style.borderRadius = "2px";
    inpaintToggleBtn.textContent = "Inpaint: ON";
    inpaintToggleBtn.title = "Toggle Audio Inpainting in Gaps";

    this.updateInpaintToggleStyle = (isOn) => {
      inpaintToggleBtn.textContent = isOn ? "Inpaint: ON" : "Inpaint: OFF";
      if (isOn) {
        inpaintToggleBtn.classList.add("toggle-on");
      } else {
        inpaintToggleBtn.classList.remove("toggle-on");
      }
    };

    this.syncInpaintState = () => {
      const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
      if (customAudioWidget && !customAudioWidget.value) {
        inpaintToggleBtn.disabled = true;
        inpaintToggleBtn.style.opacity = "0.4";
        inpaintToggleBtn.style.cursor = "default";
        inpaintToggleBtn.title = "Audio Inpainting requires Custom Audio to be ON";
      } else {
        inpaintToggleBtn.disabled = false;
        inpaintToggleBtn.style.opacity = "1.0";
        inpaintToggleBtn.style.cursor = "pointer";
        inpaintToggleBtn.title = "Toggle Audio Inpainting in Gaps";
      }
    };



    inpaintToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (inpaintToggleBtn.disabled) return;
      const widget = this.node.widgets?.find(w => w.name === "inpaint_audio");
      if (widget) {
        widget.value = !widget.value;
        if (this.node.properties) {
          this.node.properties.inpaint_audio = widget.value;
        }
        this.updateInpaintToggleStyle(widget.value);
        this.commitChanges(true);
        this.node.setDirtyCanvas(true, true);
      }
    });

    // Initial state check (widgets might not be ready immediately)
    setTimeout(() => {
      const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
      if (inpaintWidget) {
        this.updateInpaintToggleStyle(inpaintWidget.value);
      }
    }, 100);

    const helpBtn = document.createElement("button");
    helpBtn.className = "pr-btn";
    helpBtn.style.padding = "6px";
    helpBtn.style.display = "flex";
    helpBtn.style.alignItems = "center";
    helpBtn.style.justifyContent = "center";
    helpBtn.style.width = "28px";
    helpBtn.style.height = "28px";
    helpBtn.style.boxSizing = "border-box";
    helpBtn.innerHTML = ICONS.help;
    helpBtn.title = "Help / Documentation";
    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open("https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI", "_blank");
    });

    this.isSnapping = this.node.properties.isSnapping !== false;

    const snapBtn = document.createElement("button");
    snapBtn.className = "pr-btn";
    snapBtn.style.padding = "6px";
    snapBtn.style.display = "flex";
    snapBtn.style.alignItems = "center";
    snapBtn.style.justifyContent = "center";
    snapBtn.style.width = "28px";
    snapBtn.style.height = "28px";
    snapBtn.style.boxSizing = "border-box";
    snapBtn.innerHTML = ICONS.magnet;

    const updateSnapStyle = () => {
      snapBtn.title = this.isSnapping ? "Disable Snapping (Magnet)" : "Enable Snapping (Magnet)";
      if (this.isSnapping) {
        snapBtn.classList.add("toggle-on");
      } else {
        snapBtn.classList.remove("toggle-on");
      }
    };
    this.updateSnapStyle = updateSnapStyle;
    updateSnapStyle();

    snapBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.isSnapping = !this.isSnapping;
      this.node.properties.isSnapping = this.isSnapping;
      updateSnapStyle();
      this.commitChanges();
      this.render();
    });

    const startBtn = document.createElement("button");
    startBtn.className = "pr-btn";
    startBtn.style.padding = "6px";
    startBtn.style.display = "flex";
    startBtn.style.alignItems = "center";
    startBtn.style.justifyContent = "center";
    startBtn.style.width = "28px";
    startBtn.style.height = "28px";
    startBtn.style.boxSizing = "border-box";
    startBtn.innerHTML = ICONS.start;
    startBtn.title = "Set Start Frame";
    startBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.retakeMode) return;
      if (this.startFramesWidget) {
        this.startFramesWidget.value = this.currentFrame;
        if (this.startFramesWidget.callback) {
          this.startFramesWidget.callback(this.currentFrame);
        }
        this.commitChanges();
        this.render();
      }
    });

    const endBtn = document.createElement("button");
    endBtn.className = "pr-btn";
    endBtn.style.padding = "6px";
    endBtn.style.display = "flex";
    endBtn.style.alignItems = "center";
    endBtn.style.justifyContent = "center";
    endBtn.style.width = "28px";
    endBtn.style.height = "28px";
    endBtn.style.boxSizing = "border-box";
    endBtn.innerHTML = ICONS.end;
    endBtn.title = "Set End Frame";
    endBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.retakeMode) return;
      if (this.endFramesWidget) {
        this.endFramesWidget.value = this.currentFrame;
        if (this.endFramesWidget.callback) {
          this.endFramesWidget.callback(this.currentFrame);
        }
        this.commitChanges();
        this.render();
      }
    });

    const markBtn = document.createElement("button");
    markBtn.className = "pr-btn";
    markBtn.style.padding = "6px";
    markBtn.style.display = "flex";
    markBtn.style.alignItems = "center";
    markBtn.style.justifyContent = "center";
    markBtn.style.width = "28px";
    markBtn.style.height = "28px";
    markBtn.style.boxSizing = "border-box";
    markBtn.innerHTML = ICONS.mark;
    markBtn.title = "Mark Selection (X)";
    markBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.retakeMode) return;
      this.markCurrentSelection();
    });

    const retakeToggleBtn = document.createElement("button");
    retakeToggleBtn.className = "pr-btn";
    retakeToggleBtn.style.padding = "4px 8px";
    retakeToggleBtn.style.display = "flex";
    retakeToggleBtn.style.alignItems = "center";
    retakeToggleBtn.style.justifyContent = "center";
    retakeToggleBtn.style.gap = "6px";
    retakeToggleBtn.style.height = "28px";
    retakeToggleBtn.style.boxSizing = "border-box";
    retakeToggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> <span>Retake Mode (BETA)</span>`;

    const updateRetakeStyle = () => {
      retakeToggleBtn.title = this.retakeMode ? "Switch to Multi-Clip Timeline" : "Switch to Retake Tab";
      if (this.retakeMode) {
        retakeToggleBtn.classList.add("toggle-on");
      } else {
        retakeToggleBtn.classList.remove("toggle-on");
      }
    };
    this.updateRetakeStyle = updateRetakeStyle;
    updateRetakeStyle();

    retakeToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      
      // Stop and mute any active playback first
      this.pauseAudio();
      
      // Save current input value to the mode we are EXITING
      if (this.retakeMode) {
        this.timeline.retake_global_prompt = this.globalPromptInput ? this.globalPromptInput.value : "";
      } else {
        this.timeline.global_prompt = this.globalPromptInput ? this.globalPromptInput.value : "";
        // Backup normal mode values before entering Retake Mode
        this.timeline.normalStartFrame = this.getStartFrames();
        this.timeline.normalDurationFrames = this.getDurationFrames();
      }

      this.retakeMode = !this.retakeMode;
      this.timeline.retakeMode = this.retakeMode;
      if (this.node.properties) {
        this.node.properties.retakeMode = this.retakeMode;
      }

      // Adjust widgets for the new mode
      if (this.retakeMode) {
        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoDurationFrames) {
          this.syncWidgetsToRetakeDuration(this.timeline.retakeVideo.videoDurationFrames);
        }
      } else {
        // Restore normal mode backup
        this._suppressCommit = true;
        if (this.timeline.normalStartFrame !== undefined && this.startFramesWidget) {
          this.startFramesWidget.value = this.timeline.normalStartFrame;
          if (this.startFramesWidget.callback) {
            try { this.startFramesWidget.callback(this.timeline.normalStartFrame); } catch (_) {}
          }
        }
        if (this.timeline.normalDurationFrames !== undefined && this.durationFramesWidget) {
          this.durationFramesWidget.value = this.timeline.normalDurationFrames;
          if (this.durationFramesWidget.callback) {
            try { this.durationFramesWidget.callback(this.timeline.normalDurationFrames); } catch (_) {}
          }
        }
        this._suppressCommit = false;
      }

      this.updateRetakeUIState();
      this.commitChanges();
      this.render();
    });

    const btnGroup = document.createElement("div");
    btnGroup.style.display = "flex";
    btnGroup.style.gap = "6px";
    btnGroup.style.alignItems = "center";
    btnGroup.appendChild(retakeToggleBtn);
    btnGroup.appendChild(snapBtn);
    btnGroup.appendChild(startBtn);
    btnGroup.appendChild(endBtn);
    btnGroup.appendChild(markBtn);
    btnGroup.appendChild(helpBtn);
    btnGroup.appendChild(settingsBtn);
    rightGroup.appendChild(btnGroup);

    toolbar.appendChild(rightGroup);

    // --- Canvas & Viewport ---
    this.viewport = document.createElement("div");
    this.viewport.className = "pr-timeline-viewport";

    this.viewport.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        let zoomDelta = e.deltaY > 0 ? -0.5 : 0.5;
        this.zoomLevel = Math.max(1, Math.min(this.getMaxZoom(), this.zoomLevel + zoomDelta));
        if (this.zoomSlider) this.zoomSlider.value = this.zoomLevel;

        const oldWidth = this.canvas.offsetWidth;
        const newWidth = this.viewport.clientWidth * this.zoomLevel;
        const mouseX = e.clientX - this.viewport.getBoundingClientRect().left;
        const scrollRatio = (this.viewport.scrollLeft + mouseX) / oldWidth;

        this.canvas.style.width = newWidth + "px";
        this.viewport.scrollLeft = scrollRatio * newWidth - mouseX;

        if (this.node) this.node.setDirtyCanvas?.(true, true);
        else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
      }
    }, { passive: false, capture: true });

    this.canvas = document.createElement("canvas");
    this.canvas.className = "pr-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.canvas.style.width = "100%";

    this.viewport.appendChild(this.canvas);

    this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.canvas.style.height = `${CANVAS_HEIGHT}px`;

    // --- Content Area Container ---
    if (!this.node.properties) this.node.properties = {};
    if (this.node.properties.showFilenames === undefined) {
      this.node.properties.showFilenames = (this.timeline.showFilenames !== undefined) ? this.timeline.showFilenames : true;
    }
    if (this.node.properties.propHeight === undefined && this.timeline.propHeight !== undefined) {
      this.node.properties.propHeight = this.timeline.propHeight;
    }
    this.initialPropHeight = this.node.properties.propHeight || 200;
    this.propHeight = this.initialPropHeight;

    const propContainer = document.createElement("div");
    propContainer.className = "pr-prop-container";
    propContainer.style.position = "relative";
    propContainer.style.flex = "none";
    propContainer.style.height = `${this.propHeight}px`;
    propContainer.style.marginBottom = "5px"; // Add some spacing between the two prompt boxes
    this.propContainer = propContainer;

    if (this.node.properties.globalPropHeight === undefined && this.timeline.globalPropHeight !== undefined) {
      this.node.properties.globalPropHeight = this.timeline.globalPropHeight;
    }
    if (!this.node.properties.globalPropHeight) this.node.properties.globalPropHeight = 60;
    this.globalPropHeight = this.node.properties.globalPropHeight;

    const globalPropContainer = document.createElement("div");
    globalPropContainer.className = "pr-prop-container";
    globalPropContainer.style.position = "relative";
    globalPropContainer.style.flex = "none";
    globalPropContainer.style.height = `${this.globalPropHeight}px`;
    this.globalPropContainer = globalPropContainer;

    const globalPromptWrapper = document.createElement("div");
    globalPromptWrapper.className = "pr-prompt-wrapper";
    globalPromptWrapper.style.width = "100%";
    globalPromptWrapper.style.height = "100%";

    this.globalPromptLabel = document.createElement("div");
    this.globalPromptLabel.className = "pr-prompt-label";
    this.globalPromptLabel.textContent = "Global Prompt";
    globalPromptWrapper.appendChild(this.globalPromptLabel);

    this.globalPromptInput = document.createElement("textarea");
    this.globalPromptInput.className = "pr-prompt-area";
    this.globalPromptInput.placeholder = "Enter global prompt here...";
    this.globalPromptInput.spellcheck = false;
    globalPromptWrapper.appendChild(this.globalPromptInput);

    this.globalPromptInput.addEventListener("focus", () => {
      globalPromptWrapper.classList.add("focus-active");
      this.wrapper.classList.add("has-focus");
    });
    this.globalPromptInput.addEventListener("blur", () => {
      globalPromptWrapper.classList.remove("focus-active");
      this.wrapper.classList.remove("has-focus");
    });
    let saveTimeout = null;
    const triggerAutoSave = () => {
      try {
        const canvasEl = app.canvasEl || app.canvas?.canvas;
        if (canvasEl) {
          canvasEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        }
        if (app.canvas && app.canvas.checkState) app.canvas.checkState();
        if (app.canvas && app.canvas.captureCanvasState) app.canvas.captureCanvasState();
      } catch (_) { }
    };

    this.globalPromptInput.addEventListener("input", (e) => {
      const val = e.target.value;
      this.syncGlobalPrompt(val);

      this.commitChanges(true);
      this.render();

      // Debounce ComfyUI auto-save by 300ms to avoid lag while typing
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(triggerAutoSave, 300);
    });

    this.globalPromptInput.addEventListener("blur", () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      triggerAutoSave();
    });

    const globalPropResizer = document.createElement("div");
    globalPropResizer.style.position = "absolute";
    globalPropResizer.style.bottom = "0px";
    globalPropResizer.style.left = "0px";
    globalPropResizer.style.width = "100%";
    globalPropResizer.style.height = "12px"; // Hit area
    globalPropResizer.style.cursor = "ns-resize";
    globalPropResizer.style.display = "flex";
    globalPropResizer.style.justifyContent = "center";
    globalPropResizer.style.alignItems = "flex-end";
    globalPropResizer.style.paddingBottom = "4px";
    globalPropResizer.style.zIndex = "10";
    globalPropResizer.innerHTML = `<div style="width: 40px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px;"></div>`;

    let isGlobalResizing = false;
    let startGlobalY = 0;
    let startGlobalH = 0;

    globalPropResizer.addEventListener("mousedown", (ev) => {
      isGlobalResizing = true;
      startGlobalY = ev.clientY;
      startGlobalH = this.globalPropHeight;
      ev.stopPropagation();
      ev.preventDefault();
    });

    document.addEventListener("mousemove", (ev) => {
      if (isGlobalResizing) {
        const newH = Math.max(60, startGlobalH + (ev.clientY - startGlobalY));
        this.globalPropHeight = newH;
        this.node.properties.globalPropHeight = newH;
        globalPropContainer.style.height = `${newH}px`;

        if (this.node && this.node.computeSize) {
          const sz = this.node.computeSize();
          this.node.size[1] = sz[1];
          if (window.app && window.app.graph) {
            window.app.graph.setDirtyCanvas(true, true);
          }
        }
      }
    });

    document.addEventListener("mouseup", () => {
      if (isGlobalResizing) {
        isGlobalResizing = false;
      }
    });

    globalPropContainer.appendChild(globalPromptWrapper);
    globalPropContainer.appendChild(globalPropResizer);

    const propResizer = document.createElement("div");
    propResizer.style.position = "absolute";
    propResizer.style.bottom = "0px";
    propResizer.style.left = "0px";
    propResizer.style.width = "100%";
    propResizer.style.height = "12px"; // Hit area
    propResizer.style.cursor = "ns-resize";
    propResizer.style.display = "flex";
    propResizer.style.justifyContent = "center";
    propResizer.style.alignItems = "flex-end";
    propResizer.style.paddingBottom = "4px";
    propResizer.innerHTML = `<div style="width: 40px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px;"></div>`;

    propResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = this.propHeight;

      const doDrag = (ev) => {
        if (ev.buttons === 0) {
          stopDrag();
          return;
        }
        const newH = Math.max(90, startH + (ev.clientY - startY));
        this.propHeight = newH;
        this.node.properties.propHeight = newH;
        propContainer.style.height = `${newH}px`;

        if (this.node && this.node.computeSize) {
          const sz = this.node.computeSize();
          this.node.size[1] = sz[1];
          if (window.app && window.app.graph) {
            window.app.graph.setDirtyCanvas(true, true);
          }
        }
      };

      const stopDrag = () => {
        window.removeEventListener("mousemove", doDrag, true);
        window.removeEventListener("mouseup", stopDrag, true);
        document.body.style.cursor = "default";
      };

      document.body.style.cursor = "ns-resize";
      window.addEventListener("mousemove", doDrag, true);
      window.addEventListener("mouseup", stopDrag, true);
    });

    // --- Text Area (Image/Text) ---
    this.promptWrapper = document.createElement("div");
    this.promptWrapper.className = "pr-prompt-wrapper";
    this.promptWrapper.style.width = "100%";
    this.promptWrapper.style.height = "100%";
    this.promptWrapper.style.display = "none";

    this.segmentPromptLabel = document.createElement("div");
    this.segmentPromptLabel.className = "pr-prompt-label";
    this.segmentPromptLabel.textContent = "Segment Prompt";
    this.promptWrapper.appendChild(this.segmentPromptLabel);

    this.promptInput = document.createElement("textarea");
    this.promptInput.className = "pr-prompt-area";
    this.promptInput.placeholder = "No segment selected!";
    this.promptInput.style.opacity = "0.4";
    this.promptWrapper.appendChild(this.promptInput);

    this.promptInput.addEventListener("focus", () => {
      this.promptWrapper.classList.add("focus-active");
      this.wrapper.classList.add("has-focus");
    });
    this.promptInput.addEventListener("blur", () => {
      this.promptWrapper.classList.remove("focus-active");
      this.wrapper.classList.remove("has-focus");
    });

    this.promptInput.addEventListener("input", () => {
      if (this.retakeMode) {
        this.timeline.retakePrompt = this.promptInput.value;
        this.commitChanges();
        return;
      }
      if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
        this.timeline.segments[this.selectedIndex].prompt = this.promptInput.value;
        this.commitChanges();
        this.commitChanges(true);
        this.render();

        // Debounce ComfyUI auto-save by 300ms to avoid lag while typing
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(triggerAutoSave, 300);
      }
    });

    // --- Audio Info Area ---
    this.audioInfoArea = document.createElement("div");
    this.audioInfoArea.className = "pr-audio-info";

    // --- Transfer 窗体（Preact 内层，替代原 promptWrapper 的可视区）---
    // promptInput 引用保留在 this 上，transfer 左输入与它双向同步，
    // 继续复用原有 commitChanges 链路。
    this.transferMount = document.createElement("div");
    this.transferMount.className = "pr-transfer-mount";
    this.transferMount.style.boxSizing = "border-box";
    this.transferMount.style.width = "100%";
    this.transferMount.style.height = "100%";
    propContainer.appendChild(this.transferMount);
    mountTransfer(this, this.transferMount);

    propContainer.appendChild(this.audioInfoArea);
    propContainer.appendChild(propResizer);

    this.wrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.wrapper.classList.add("drag-active");

      if (this.retakeMode) {
        return; // Skip ghost segments rendering when in retakeMode
      }

      const { x, y } = this.getMousePos(e);
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      if (!logicalWidth || totalFrames <= 0) return;

      const trackType = this.getTrackFromY(y);
      const arrToModify = this.getSegmentArray(trackType);

      if (!this._ghostSegmentId || this._ghostTrack !== trackType) {
        this._ghostSegmentId = "GHOST_" + Date.now();
        this._ghostTrack = trackType;
        this._ghostInitialTimeline = arrToModify.map(s => ({ ...s }));

        const frameRate = this.getFrameRate();
        const newLength = Math.max(1, frameRate * 1);

        let mouseFrameX = x * (totalFrames / logicalWidth);
        let startFrame = clamp(Math.round(mouseFrameX - newLength / 2), 0, totalFrames - newLength);

        this._ghostInitialTimeline.push({
          id: this._ghostSegmentId,
          start: startFrame,
          length: newLength,
          type: "ghost"
        });
      }

      let mouseFrameX = x * (totalFrames / logicalWidth);
      const ghost = this._ghostInitialTimeline.find(s => s.id === this._ghostSegmentId);
      let D_mouse_start = mouseFrameX - ghost.length / 2;

      this._previewSegments = this._applyCenterDragPhysics(
        this._ghostInitialTimeline,
        this._ghostSegmentId,
        D_mouse_start,
        mouseFrameX,
        totalFrames,
        totalFrames,
        logicalWidth
      );

      for (let ps of this._previewSegments) {
        const orig = arrToModify.find(s => s.id === ps.id);
        if (orig) {
          ps.videoEl = orig.videoEl;
          ps.imgObj = orig.imgObj;
          if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
        }
      }

      this.render();
    });

    this.wrapper.addEventListener("dragleave", (e) => {
      const rect = this.wrapper.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX >= rect.right ||
        e.clientY < rect.top || e.clientY >= rect.bottom) {
        this.wrapper.classList.remove("drag-active");
        this._ghostSegmentId = null;
        this._ghostTrack = null;
        this._ghostInitialTimeline = null;
        this._previewSegments = null;
        this.render();
      }
    });

    this.wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.wrapper.classList.remove("drag-active");

      let targetFrameStart = null;
      let targetTrack = this._ghostTrack || "image";

      if (this._ghostSegmentId && this._previewSegments) {
        const ghost = this._previewSegments.find(s => s.id === this._ghostSegmentId);
        if (ghost) {
          targetFrameStart = ghost.resolvedStart !== undefined ? ghost.resolvedStart : ghost.start;
        }
      }
      this._ghostSegmentId = null;
      this._ghostTrack = null;
      this._ghostInitialTimeline = null;
      this._previewSegments = null;
      this.render();

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const imageFiles = [];
        const audioFiles = [];
        const videoFiles = [];
        for (let file of e.dataTransfer.files) {
          const nameLower = file.name.toLowerCase();
          const isVideo = file.type.startsWith("video/") || nameLower.match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/);
          const isAudio = file.type.startsWith("audio/") || nameLower.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/);
          const isImage = file.type.startsWith("image/") || nameLower.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/);
          
          if (isVideo) videoFiles.push(file);
          else if (isAudio) audioFiles.push(file);
          else if (isImage) imageFiles.push(file);
        }

        // Let implicit intent handle mixing drops: use the track we hovered over
        // for the first type we process, or fallback.
        if (videoFiles.length > 0) {
          this.handleVideoUpload(videoFiles, targetFrameStart);
        } else if (audioFiles.length > 0 && (targetTrack === "audio" || imageFiles.length === 0)) {
          this.handleAudioUpload(audioFiles, targetFrameStart);
        } else if (imageFiles.length > 0) {
          this.handleImageUpload(imageFiles, targetFrameStart);
        }
      }
    });

    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", (e) => this.onMouseUp(e));

    // --- Player Controls ---
    const playerControls = document.createElement("div");
    playerControls.className = "pr-player-controls";

    this.playBtn = document.createElement("button");
    this.playBtn.className = "pr-icon-btn";
    this.playBtn.style.padding = "4px";
    this.playBtn.innerHTML = ICONS.play;
    this.playBtn.title = "Play/Pause Audio";
    this.playBtn.addEventListener("click", () => this.togglePlay());

    this.loopBtn = document.createElement("button");
    this.loopBtn.className = "pr-icon-btn";
    this.loopBtn.style.padding = "4px";
    this.loopBtn.innerHTML = ICONS.loop;
    this.loopBtn.title = "Toggle Loop";
    this.loopBtn.addEventListener("click", () => this.toggleLoop());

    this.seekBar = document.createElement("input");
    this.seekBar.type = "range";
    this.seekBar.className = "pr-seek-bar";
    this.seekBar.min = "0";
    this.seekBar.value = "0";
    this.seekBar.style.flex = "1"; // take up remaining space
    this.seekBar.addEventListener("input", (e) => {
      let val = parseInt(e.target.value, 10);
      if (this.retakeMode && this.timeline.retakeVideo) {
        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 0;
        if (val > baseVideoDur) {
          val = baseVideoDur;
          this.seekBar.value = val;
        }
      }
      this.currentFrame = val;
      this.updateSeekBarBackground();
      this.render();
      if (this.isPlaying) {
        this.playAudio();
      }
    });

    // --- Zoom Controls ---
    const zoomControls = document.createElement("div");
    zoomControls.className = "pr-zoom-controls";

    const zoomOutBtn = document.createElement("button");
    zoomOutBtn.className = "pr-icon-btn";
    zoomOutBtn.style.padding = "4px";
    zoomOutBtn.innerHTML = ICONS.minus;
    zoomOutBtn.title = "Zoom Out";
    zoomOutBtn.addEventListener("click", () => {
      const currentZoom = parseFloat(this.zoomSlider.value);
      this.zoomSlider.value = Math.max(1, currentZoom - 0.5);
      this.zoomSlider.dispatchEvent(new Event("input"));
    });

    this.zoomSlider = document.createElement("input");
    this.zoomSlider.type = "range";
    this.zoomSlider.className = "pr-zoom-slider";
    this.zoomSlider.min = "1";
    this.zoomSlider.max = "1"; // Updated dynamically via updateZoomSliderMax()
    this.zoomSlider.step = "0.1";
    this.zoomSlider.value = "1";
    this.zoomSlider.title = "Zoom Level";
    this.zoomSlider.addEventListener("input", (e) => {
      this.zoomLevel = parseFloat(e.target.value);

      const viewportWidth = this.viewport.clientWidth;
      const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);

      this.canvas.style.width = newCanvasWidth + "px";
      this.resizeCanvas(newCanvasWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;

      // Keep playhead centered
      const totalFrames = this.getVisualDurationFrames();
      const playheadRatio = this.currentFrame / totalFrames;
      const newPlayheadX = playheadRatio * newCanvasWidth;
      this.viewport.scrollLeft = newPlayheadX - (viewportWidth / 2);

      if (this.node) this.node.setDirtyCanvas?.(true, true);
      else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    });

    const zoomInBtn = document.createElement("button");
    zoomInBtn.className = "pr-icon-btn";
    zoomInBtn.style.padding = "4px";
    zoomInBtn.innerHTML = ICONS.plus;
    zoomInBtn.title = "Zoom In";
    zoomInBtn.addEventListener("click", () => {
      const currentZoom = parseFloat(this.zoomSlider.value);
      this.zoomSlider.value = Math.min(this.getMaxZoom(), currentZoom + 0.5);
      this.zoomSlider.dispatchEvent(new Event("input"));
    });

    const zoomFitBtn = document.createElement("button");
    zoomFitBtn.className = "pr-icon-btn";
    zoomFitBtn.style.padding = "4px";
    zoomFitBtn.style.marginLeft = "4px";
    zoomFitBtn.innerHTML = ICONS.fit;
    zoomFitBtn.title = "Zoom to Fit (show full timeline)";
    zoomFitBtn.addEventListener("click", () => {
      this.zoomLevel = 1;
      this.zoomSlider.value = 1;
      const viewportWidth = this.viewport.clientWidth;
      this.canvas.style.width = viewportWidth + "px";
      this.resizeCanvas(viewportWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = 1;
      this.viewport.scrollLeft = 0;

      if (this.node) this.node.setDirtyCanvas?.(true, true);
      else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    });

    zoomControls.appendChild(zoomOutBtn);
    zoomControls.appendChild(this.zoomSlider);
    zoomControls.appendChild(zoomInBtn);
    zoomControls.appendChild(zoomFitBtn);

    playerControls.appendChild(this.playBtn);
    playerControls.appendChild(this.loopBtn);
    playerControls.appendChild(this.seekBar);
    playerControls.appendChild(zoomControls);



    // --- Guide Strength Slider ---
    this.strengthRow = document.createElement("div");
    this.strengthRow.className = "pr-strength-row";

    this.strengthLabel = document.createElement("span");
    this.strengthLabel.className = "pr-strength-label";
    this.strengthLabel.textContent = "Guide Strength:";

    this.strengthValue = document.createElement("input");
    this.strengthValue.type = "text";
    this.strengthValue.className = "pr-strength-input";
    this.strengthValue.value = "1.00";
    this.strengthValue.disabled = true;
    this.strengthValue.style.cursor = "ew-resize";

    // Dragging logic for guide strength
    let isDragging = false;
    let startX = 0;
    let startVal = 0;
    let hasMoved = false;

    this.strengthValue.addEventListener("mousedown", (e) => {
      if (this.strengthValue.disabled) return;
      startX = e.clientX;
      startVal = parseFloat(this.strengthValue.value) || 1.0;
      hasMoved = false;

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        if (Math.abs(deltaX) > 3) {
          hasMoved = true;
          isDragging = true;
        }

        if (isDragging) {
          moveEvent.preventDefault();
          const sensitivity = 0.002;
          let newVal = startVal + deltaX * sensitivity;

          if (newVal < 0) newVal = 0;
          if (newVal > 1) newVal = 1;

          this.strengthValue.value = newVal.toFixed(2);

          if (this.retakeMode) {
            this.timeline.retakeStrength = newVal;
            this.commitChanges();
          } else if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
            const seg = this.timeline.segments[this.selectedIndex];
            if (seg.type !== "text") {
              seg.guideStrength = newVal;
              this.commitChanges();
            }
          }
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (!hasMoved) {
          this.strengthValue.focus();
          this.strengthValue.select();
        }
        isDragging = false;
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    this.strengthValue.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (isNaN(val)) val = 1;
      val = Math.max(0, Math.min(1, val));
      this.strengthValue.value = val.toFixed(2);
      if (this.retakeMode) {
        this.timeline.retakeStrength = val;
        this.commitChanges();
      } else if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
        const seg = this.timeline.segments[this.selectedIndex];
        if (seg.type !== "text") {
          seg.guideStrength = val;
          this.commitChanges();
        }
      }
    });

    this.strengthRow.appendChild(this.timeCodeDisplay);
    this.strengthRow.appendChild(this.segmentBoundsDisplay);
    this.strengthRow.appendChild(this.strengthLabel);
    this.strengthRow.appendChild(this.strengthValue);



    // Layout container for sidebar + viewport
    this.layoutContainer = document.createElement("div");
    this.layoutContainer.className = "pr-timeline-layout";
    this.layoutContainer.style.display = "flex";
    this.layoutContainer.style.flexDirection = "row";
    this.layoutContainer.style.width = "100%";
    this.layoutContainer.style.border = "1px solid #111";
    this.layoutContainer.style.borderRadius = "6px";
    this.layoutContainer.style.overflow = "hidden";

    // Sidebar
    this.sidebar = document.createElement("div");
    this.sidebar.className = "pr-timeline-sidebar";
    this.sidebar.style.width = "120px";
    this.sidebar.style.flexShrink = "0";
    this.sidebar.style.display = "flex";
    this.sidebar.style.flexDirection = "column";
    this.sidebar.style.borderRight = "1px solid #111";
    this.sidebar.style.boxSizing = "border-box";
    this.sidebar.style.backgroundColor = "#1e1e1e";
    this.sidebar.style.userSelect = "none";

    // Spacer for Ruler
    this.rulerSpacer = document.createElement("div");
    this.rulerSpacer.style.height = `${RULER_HEIGHT}px`;
    this.rulerSpacer.style.width = "100%";
    this.rulerSpacer.style.borderBottom = "1px solid #111";
    this.rulerSpacer.style.backgroundColor = "#1e1e1e";
    this.rulerSpacer.style.boxSizing = "border-box";
    this.rulerSpacer.style.flexShrink = "0";
    this.sidebar.appendChild(this.rulerSpacer);

    const getTrackIconHtml = (trackId, isEnabled) => {
      if (trackId === "audio") {
        if (isEnabled) {
          return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>`;
        } else {
          return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <line x1="1" y1="1" x2="23" y2="23"></line>
                </svg>`;
        }
      } else {
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
              ${!isEnabled ? '<line x1="1" y1="1" x2="23" y2="23"></line>' : ''}
            </svg>`;
      }
    };

    const updateTrackIcon = (btn, trackId, isEnabled) => {
      btn.style.color = isEnabled ? "#aaa" : "#444";
      btn.innerHTML = getTrackIconHtml(trackId, isEnabled);
    };
    this.updateTrackIcon = updateTrackIcon;

    const createTrackLabel = (text, bgColor, trackId, isEnabled, toggleCallback) => {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.flexDirection = "column";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.borderBottom = "1px solid #111";
      el.style.backgroundColor = bgColor;
      el.style.boxSizing = "border-box";
      el.style.gap = "4px";
      el.style.overflow = "hidden";
      el.style.position = "relative";
      el.style.flexShrink = "0";

      const headerRow = document.createElement("div");
      headerRow.style.display = "flex";
      headerRow.style.alignItems = "center";
      headerRow.style.justifyContent = "center";
      headerRow.style.gap = "6px";

      const textSpan = document.createElement("span");
      textSpan.style.color = "#ccc";
      textSpan.style.fontSize = "12px";
      textSpan.style.fontWeight = "bold";
      textSpan.style.lineHeight = "1";
      textSpan.style.display = "inline-flex";
      textSpan.style.alignItems = "center";
      textSpan.textContent = text;

      const eyeBtn = document.createElement("div");
      eyeBtn.style.cursor = "pointer";
      eyeBtn.style.display = "inline-flex";
      eyeBtn.style.alignItems = "center";
      eyeBtn.style.justifyContent = "center";
      eyeBtn.style.width = "14px";
      eyeBtn.style.height = "14px";
      eyeBtn.style.color = isEnabled ? "#aaa" : "#444";
      eyeBtn.innerHTML = getTrackIconHtml(trackId, isEnabled);

      eyeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleCallback();
      });

      // Store reference so we can update it later
      el._eyeBtn = eyeBtn;

      headerRow.appendChild(textSpan);
      headerRow.appendChild(eyeBtn);
      el.appendChild(headerRow);

      return el;
    };

    this.mainTrackLabel = createTrackLabel("MAIN", "#1e1e1e", "main", this.mainTrackEnabled, () => {
      this.mainTrackEnabled = !this.mainTrackEnabled;
      updateTrackIcon(this.mainTrackLabel._eyeBtn, "main", this.mainTrackEnabled);
      this.commitChanges(true);
      this.render();
    });

    this.audioTrackLabel = createTrackLabel("AUDIO", "#1e1e1e", "audio", this.audioTrackEnabled, () => {
      this.audioTrackEnabled = !this.audioTrackEnabled;
      updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", this.audioTrackEnabled);

      // Auto-disable custom audio if track disabled
      const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
      if (customAudioWidget) {
        if (!this.audioTrackEnabled) {
          // Store previous state just in case, though the user requested it auto-enables
          this._prevCustomAudioState = customAudioWidget.value;
          customAudioWidget.value = false;
        } else {
          // Auto-turn it back on as requested
          customAudioWidget.value = true;
        }
        if (this.updateToggleStyle) this.updateToggleStyle(customAudioWidget.value);
      }

      // Disable toggle buttons visually
      inpaintToggleBtn.disabled = !this.audioTrackEnabled;
      inpaintToggleBtn.style.opacity = this.audioTrackEnabled ? "1.0" : "0.3";

      this.commitChanges(true);
      this.render();
    });
    this.audioTrackLabel.appendChild(inpaintToggleBtn);

    // Initialize audio toggle states immediately
    inpaintToggleBtn.disabled = !this.audioTrackEnabled;
    inpaintToggleBtn.style.opacity = this.audioTrackEnabled ? "1.0" : "0.3";

    this.sidebar.appendChild(this.mainTrackLabel);
    this.sidebar.appendChild(this.audioTrackLabel);

    const setupSidebarLabelResizing = (labelEl, dragType) => {
      labelEl.addEventListener("mousemove", (e) => {
        if (this.retakeMode) {
          labelEl.style.cursor = "default";
          return;
        }
        if (this._isDragging) return;
        const rect = labelEl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        if (rect.height - y <= 8) {
          labelEl.style.cursor = "ns-resize";
        } else {
          labelEl.style.cursor = "default";
        }
      });

      labelEl.addEventListener("mousedown", (e) => {
        if (this.retakeMode) return;
        if (e.button !== 0) return;
        if (e.target.closest("svg") || e.target.style.cursor === "pointer" || window.getComputedStyle(e.target).cursor === "pointer") {
          return;
        }
        const rect = labelEl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        if (rect.height - y <= 8) {
          this._isDragging = true;
          this._dragType = dragType;
          this._startBlockHeight = this.blockHeight;
          this._startAudioTrackHeight = this.audioTrackHeight;
          this._startY = this.getMousePos(e).y;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "ns-resize";
          e.preventDefault();
          e.stopPropagation();
        }
      });
    };

    setupSidebarLabelResizing(this.mainTrackLabel, "divider");
    setupSidebarLabelResizing(this.audioTrackLabel, "audio_divider");

    this.updateSidebarHeights();

    this.layoutContainer.appendChild(this.sidebar);

    // Viewport takes remaining space
    this.viewport.style.flexGrow = "1";
    this.viewport.style.minWidth = "0";
    this.layoutContainer.appendChild(this.viewport);

    this.wrapper.appendChild(toolbar);
    this.wrapper.appendChild(this.layoutContainer);


    const controlsGroup = document.createElement("div");
    controlsGroup.className = "pr-controls-group";
    controlsGroup.appendChild(this.strengthRow);
    controlsGroup.appendChild(playerControls);
    this.wrapper.appendChild(controlsGroup);
    this.wrapper.appendChild(propContainer);
    this.wrapper.appendChild(this.globalPropContainer);

    this.container.appendChild(this.wrapper);
  }
,

  syncWidgetsAndUI() {
    console.log("[LTXDirector debug] syncWidgetsAndUI() called.");
    console.log(`  - mainTrackEnabled: ${this.mainTrackEnabled}`);
    console.log(`  - audioTrackEnabled: ${this.audioTrackEnabled}`);

    // 1. Sync the widgets with the loaded track enablement states
    const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
    if (customAudioWidget) {
      customAudioWidget.value = this.audioTrackEnabled;
      console.log(`  - Set use_custom_audio widget value to ${this.audioTrackEnabled}`);
    }

    // 2. Sync the track icon buttons
    if (this.mainTrackLabel?._eyeBtn && this.updateTrackIcon) {
      this.updateTrackIcon(this.mainTrackLabel._eyeBtn, "main", this.mainTrackEnabled);
      console.log("  - Updated main track eye icon");
    }
    if (this.audioTrackLabel?._eyeBtn && this.updateTrackIcon) {
      this.updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", this.audioTrackEnabled);
      console.log("  - Updated audio track eye icon");
    }

    // 3. Sync the inpaint button disabled/opacity state
    const inpaintToggleBtn = this.audioTrackLabel?.querySelector(".pr-btn");
    if (inpaintToggleBtn) {
      inpaintToggleBtn.disabled = !this.audioTrackEnabled;
      inpaintToggleBtn.style.opacity = this.audioTrackEnabled ? "1.0" : "0.3";
      console.log(`  - Updated inpaint toggle button disabled: ${inpaintToggleBtn.disabled}`);
    }

    if (this.updateInpaintToggleStyle) {
      const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
      if (inpaintWidget) {
        console.log(`  - calling updateInpaintToggleStyle with ${inpaintWidget.value}`);
        this.updateInpaintToggleStyle(inpaintWidget.value);
      }
    }


  }
,

  checkResize() {
    this.syncLayoutToNode(false);
    const viewportWidth = this.viewport.clientWidth;
    const currentScale = this.getRenderScale();

    if (viewportWidth > 0 && (this._lastWidth !== viewportWidth || this._lastZoom !== this.zoomLevel || this._lastScale !== currentScale)) {
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;
      this._lastScale = currentScale;

      const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
      this.canvas.style.width = newCanvasWidth + "px";
      this.resizeCanvas(newCanvasWidth);

      if (this.node) this.node.setDirtyCanvas?.(true, true);
      else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    }
    this._renderLoop = requestAnimationFrame(() => this.checkResize());
  }
,

  syncLayoutToNode(forceRender = true) {
    const nodeWidth = this.node?.size?.[0] || 1375;
    const targetWidth = Math.max(10, nodeWidth - 30);

    if (this.container) {
      this.container.style.width = `${targetWidth}px`;
      this.container.style.maxWidth = `${targetWidth}px`;
      this.container.style.setProperty("height", "auto", "important");
      this.container.style.boxSizing = "border-box";
    }
    if (this.wrapper) {
      this.wrapper.style.width = "100%";
      this.wrapper.style.maxWidth = "100%";
      this.wrapper.style.setProperty("height", "auto", "important");
      this.wrapper.style.boxSizing = "border-box";
    }
    if (this.viewport) {
      this.viewport.style.boxSizing = "content-box";
      this.viewport.style.height = `${this.canvasHeight}px`;
      this.viewport.style.minHeight = `${this.canvasHeight}px`;
      this.viewport.style.flexShrink = "0";
    }
    if (this.layoutContainer) {
      this.layoutContainer.style.flexShrink = "0";
    }

    const viewportWidth = this.viewport?.clientWidth || targetWidth;
    const canvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
    const currentWidth = parseFloat(this.canvas?.style?.width) || 0;
    if (viewportWidth > 0 && Math.abs(currentWidth - canvasWidth) > 1) {
      this.canvas.style.width = `${canvasWidth}px`;
      this.resizeCanvas(canvasWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;
      if (forceRender) this.render();
    }
  }
,

  getRenderScale() {
    const dpr = window.devicePixelRatio || 1;
    let graphScale = 1;
    try {
      if (window.app && window.app.canvas && window.app.canvas.ds && window.app.canvas.ds.scale) {
        graphScale = window.app.canvas.ds.scale;
      }
    } catch (e) { }
    // Scale up if zoomed in, but don't drop below 1x DPR if zoomed out
    return dpr * Math.max(1, graphScale);
  }
,

  resizeCanvas(widthPx) {
    const scale = this.getRenderScale();
    const targetWidth = Math.round(widthPx * scale);
    const targetHeight = Math.round(this.canvasHeight * scale);

    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.render();
  }
,

  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();

    const scaleX = this.canvas.offsetWidth / rect.width;
    const scaleY = this.canvas.offsetHeight / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return { x, y };
  }
,

  updateWidgetVisibility() {
    const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";
    const isSeconds = mode === "seconds";

    const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;

    if (isSeconds) {
      if (this.startFramesWidget) hideWidget(this.startFramesWidget);
      if (this.endFramesWidget) hideWidget(this.endFramesWidget);
      if (this.durationFramesWidget) hideWidget(this.durationFramesWidget);
      if (this.startSecondsWidget) showWidget(this.startSecondsWidget);
      if (this.endSecondsWidget) showWidget(this.endSecondsWidget);
      if (this.durationSecondsWidget) showWidget(this.durationSecondsWidget);

      // LiteGraph: remove frame input slots, restore second input slots
      if (isLiteGraph && this.node.inputs) {
        for (const name of ["start_frame", "end_frame", "duration_frames"]) {
          const idx = this.node.inputs.findIndex(i => i.name === name);
          if (idx !== -1 && this.node.inputs[idx].link == null) {
            this.node.removeInput(idx);
          }
        }
        for (const [name, type] of [["start_second", "FLOAT"], ["end_second", "FLOAT"], ["duration_seconds", "FLOAT"]]) {
          if (!this.node.inputs.find(i => i.name === name)) {
            const w = this.node.widgets?.find(w => w.name === name);
            const slot = this.node.addInput(name, type);
            // keep the slot linked to its widget
            if (w && slot != null) {
              const inp = this.node.inputs[this.node.inputs.length - 1];
              if (inp) inp.widget = { name };
            }
          }
        }
      }
    } else {
      if (this.startSecondsWidget) hideWidget(this.startSecondsWidget);
      if (this.endSecondsWidget) hideWidget(this.endSecondsWidget);
      if (this.durationSecondsWidget) hideWidget(this.durationSecondsWidget);
      if (this.startFramesWidget) showWidget(this.startFramesWidget);
      if (this.endFramesWidget) showWidget(this.endFramesWidget);
      if (this.durationFramesWidget) showWidget(this.durationFramesWidget);

      // LiteGraph: remove second input slots, restore frame input slots
      if (isLiteGraph && this.node.inputs) {
        for (const name of ["start_second", "end_second", "duration_seconds"]) {
          const idx = this.node.inputs.findIndex(i => i.name === name);
          if (idx !== -1 && this.node.inputs[idx].link == null) {
            this.node.removeInput(idx);
          }
        }
        for (const [name, type] of [["start_frame", "INT"], ["end_frame", "INT"], ["duration_frames", "INT"]]) {
          if (!this.node.inputs.find(i => i.name === name)) {
            const slot = this.node.addInput(name, type);
            if (slot != null) {
              const inp = this.node.inputs[this.node.inputs.length - 1];
              if (inp) inp.widget = { name };
            }
          }
        }
      }
    }

    // Force node resize and redraw deferred to next tick
    setTimeout(() => {
      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (window.app && window.app.graph) {
          window.app.graph.setDirtyCanvas(true, true);
        }
      }
    }, 0);
  }
};
