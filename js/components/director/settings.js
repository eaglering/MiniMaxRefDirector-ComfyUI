// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: get_settingsWidgetNames, hideSettingsWidgets, showSettingsWidgets, handleLoadTimeline, _applyLoadedTimeline, _getTimelineSavePayload, handleSaveTimeline, handleSaveTimelineAs, _makeSettingRow, showSettingsMenu, dismissSettingsMenu
import { ICONS, api, app, hideWidget, parseInitial, showWidget } from "./shared.js";

export const settings = {
  hideSettingsWidgets() {
    const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;
    // If any settings widgets have active connections, show settings widgets instead
    let hasActiveSettings = false;
    for (const name of this._settingsWidgetNames) {
      const hasInput = this.node.inputs?.find(i => i.name === name);
      if (hasInput && hasInput.link != null) {
        hasActiveSettings = true;
        break;
      }
    }

    if (hasActiveSettings) {
      this.showSettingsWidgets();
      return;
    }

    for (const name of this._settingsWidgetNames) {
      const w = this.node.widgets?.find(w => w.name === name);
      if (w) {
        hideWidget(w);
        // If it was converted to an input slot but is unconnected, remove the input slot
        if (isLiteGraph && this.node.inputs) {
          const idx = this.node.inputs.findIndex(i => i.name === name);
          if (idx !== -1 && this.node.inputs[idx].link == null) {
            this.node.removeInput(idx);
          }
        }
      }
    }
    this.updateWidgetVisibility();

    // Workaround: toggle display mode to force ComfyUI to refresh the node
    if (this.displayModeWidget) {
      const origVal = this.displayModeWidget.value;
      const otherVal = origVal === "frames" ? "seconds" : "frames";

      this.displayModeWidget.value = otherVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);

      this.displayModeWidget.value = origVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
    }
  }
,

  showSettingsWidgets() {
    const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;
    for (const name of this._settingsWidgetNames) {
      const w = this.node.widgets?.find(w => w.name === name);
      if (!w) continue;
      showWidget(w);

      // If the widget is a converted-widget but the input slot is missing, add it back!
      if (isLiteGraph && w.type === "converted-widget" && this.node.inputs) {
        if (!this.node.inputs.find(i => i.name === name)) {
          let type = "FLOAT";
          if (name === "divisible_by" || name === "img_compression") {
            type = "INT";
          } else if (name === "display_mode") {
            type = "COMBO";
          }
          const slot = this.node.addInput(name, type);
          if (slot != null) {
            const inp = this.node.inputs[this.node.inputs.length - 1];
            if (inp) inp.widget = { name };
          }
        }
      }
    }
    this.updateWidgetVisibility();

    // Workaround: toggle display mode to force ComfyUI to refresh the node
    if (this.displayModeWidget) {
      const origVal = this.displayModeWidget.value;
      const otherVal = origVal === "frames" ? "seconds" : "frames";

      this.displayModeWidget.value = otherVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);

      this.displayModeWidget.value = origVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
    }
  }
,

  async handleLoadTimeline() {
    try {
      if (window.showOpenFilePicker) {
        const [fileHandle] = await window.showOpenFilePicker({
          types: [{ description: 'Timeline JSON', accept: { 'application/json': ['.json'] } }],
          multiple: false
        });
        const file = await fileHandle.getFile();
        const content = await file.text();
        this._applyLoadedTimeline(content, fileHandle);
      } else {
        // Fallback for browsers without showOpenFilePicker (e.g. Firefox)
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = e => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = evt => this._applyLoadedTimeline(evt.target.result, null);
          reader.readAsText(file);
        };
        input.click();
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("Failed to load timeline:", e);
        alert("Failed to load timeline. See console for details.");
      }
    }
  }
,

  _applyLoadedTimeline(jsonStr, fileHandle) {
    try {
      const data = JSON.parse(jsonStr);

      // Load settings if present
      if (data.global_prompt !== undefined) {
        if (data.retake_global_prompt !== undefined) {
          this.timeline.global_prompt = data.global_prompt;
          this.timeline.retake_global_prompt = data.retake_global_prompt;
        } else {
          this.syncGlobalPrompt(data.global_prompt);
        }
      }
      if (data.settings) {
        for (const [key, value] of Object.entries(data.settings)) {
          // Handle legacy keys for backward compatibility
          if (key === "startFrames" && this.startFramesWidget) {
            this.startFramesWidget.value = value;
            if (this.startFramesWidget.callback) this.startFramesWidget.callback(value);
            continue;
          }
          if (key === "durationFrames" && this.durationFramesWidget) {
            this.durationFramesWidget.value = value;
            if (this.durationFramesWidget.callback) this.durationFramesWidget.callback(value);
            continue;
          }
          if (key === "frameRate" && this.frameRateWidget) {
            this.frameRateWidget.value = value;
            if (this.frameRateWidget.callback) this.frameRateWidget.callback(value);
            continue;
          }

          const w = this.node.widgets?.find(x => x.name === key);
          if (w) {
            w.value = value;
            if (w.callback) w.callback(w.value);
          }
        }
      }

      if (this.timelineDataWidget) this.timelineDataWidget.value = JSON.stringify(data.timeline || data);
      this.timeline = parseInitial(this.timelineDataWidget.value);
      this.mainTrackEnabled = this.timeline.mainTrackEnabled !== false;
      this.audioTrackEnabled = this.timeline.audioTrackEnabled !== false;
      this.motionTrackEnabled = this.timeline.motionTrackEnabled !== false;
      if (this.timeline.showFilenames !== undefined) {
        this.node.properties.showFilenames = this.timeline.showFilenames;
      }
      if (this.timeline.overrideAudio !== undefined) {
        this.node.properties.overrideAudio = this.timeline.overrideAudio;
      }
      if (this.timeline.inpaint_audio !== undefined) {
        this.node.properties.inpaint_audio = this.timeline.inpaint_audio;
      }
      if (this.timeline.propHeight !== undefined) {
        this.node.properties.propHeight = this.timeline.propHeight;
        this.propHeight = this.timeline.propHeight;
        if (this.propContainer) {
          this.propContainer.style.height = `${this.propHeight}px`;
        }
      }
      if (this.timeline.globalPropHeight !== undefined) {
        this.node.properties.globalPropHeight = this.timeline.globalPropHeight;
        this.globalPropHeight = this.timeline.globalPropHeight;
        if (this.globalPropContainer) {
          this.globalPropContainer.style.height = `${this.globalPropHeight}px`;
        }
      }
      this.currentFileHandle = fileHandle;
      this.retakeMode = this.timeline.retakeMode === true;

      this.loadMedia();

      if (!this.retakeMode) {
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
      this.updateUIFromSelection();
      this.syncWidgetsAndUI();
      this.commitChanges(true); // forces sync to UI and other widgets


      if (this.updateInpaintToggleStyle) {
        const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
        if (inpaintWidget) this.updateInpaintToggleStyle(inpaintWidget.value);
      }

      this.render();
      this.dismissSettingsMenu();

      // Trigger ComfyUI's change-detection pipeline the same way a real user
      // interaction does: by dispatching a pointerup on the canvas. This fires
      // LiteGraph's onAfterChange → ChangeTracker.captureCanvasState() →
      // workflowDraftStore.saveDraft() → localStorage. This is what the user
      // experiences when they "move something" and it persists correctly.
      setTimeout(() => {
        try {
          const canvasEl = app.canvasEl || app.canvas?.canvas;
          if (canvasEl) {
            canvasEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
          }
          // Also try the direct ChangeTracker API as a backup for both frontend versions
          if (app.canvas && app.canvas.checkState) app.canvas.checkState();
          if (app.canvas && app.canvas.captureCanvasState) app.canvas.captureCanvasState();
        } catch (_) { }
      }, 100);
    } catch (e) {
      console.error("Invalid timeline JSON:", e);
      alert("Invalid timeline file.");
    }
  }
,

  _getTimelineSavePayload() {
    const allSettings = {};
    const skipWidgets = ["timeline_data", "local_prompts", "segment_lengths", "guide_strength", "timeline_ui", "global_prompt"];

    for (const w of this.node.widgets || []) {
      if (!skipWidgets.includes(w.name) && w.value !== undefined) {
        allSettings[w.name] = w.value;
      }
    }

    const normPrompt = this.retakeMode ? (this.timeline.global_prompt || "") : (this.globalPromptInput ? this.globalPromptInput.value : "");
    const retPrompt = this.retakeMode ? (this.globalPromptInput ? this.globalPromptInput.value : "") : (this.timeline.retake_global_prompt || "");

    return JSON.stringify({
      version: 1,
      settings: allSettings,
      global_prompt: normPrompt,
      retake_global_prompt: retPrompt,
      timeline: {
        mainTrackEnabled: this.mainTrackEnabled,
        audioTrackEnabled: this.audioTrackEnabled,
        motionTrackEnabled: this.motionTrackEnabled,
        showFilenames: !!this.node.properties.showFilenames,
        overrideAudio: !!this.node.properties.overrideAudio,
        inpaint_audio: !!(this.node.widgets?.find(w => w.name === "inpaint_audio")?.value),
        propHeight: this.propHeight,
        globalPropHeight: this.globalPropHeight,
        global_prompt: normPrompt,
        retake_global_prompt: retPrompt,
        retakeMode: this.retakeMode,
        retakeStart: this.timeline.retakeStart,
        retakeLength: this.timeline.retakeLength,
        retakePrompt: this.timeline.retakePrompt,
        retakeStrength: this.timeline.retakeStrength,
        retakeVideo: this.timeline.retakeVideo ? {
          fileName: this.timeline.retakeVideo.fileName,
          imageFile: this.timeline.retakeVideo.imageFile,
          videoDurationFrames: this.timeline.retakeVideo.videoDurationFrames,
          fileSize: this.timeline.retakeVideo.fileSize,
        } : null,
        normalStartFrame: this.timeline.normalStartFrame,
        normalDurationFrames: this.timeline.normalDurationFrames,
        segments: (this.timeline.segments || []).map(s => {
          const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
          return rest;
        }),
        motionSegments: (this.timeline.motionSegments || []).map(s => {
          const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
          return rest;
        }),
        audioSegments: (this.timeline.audioSegments || []).map(s => {
          const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, _blobUrl, _audioBuffer, ...rest } = s;
          return rest;
        })
      }
    }, null, 2);
  }
,

  async handleSaveTimeline() {
    if (!this.currentFileHandle) {
      return this.handleSaveTimelineAs();
    }

    try {
      const payload = this._getTimelineSavePayload();
      const writable = await this.currentFileHandle.createWritable();
      await writable.write(payload);
      await writable.close();
      this.dismissSettingsMenu();
    } catch (e) {
      console.error("Failed to save timeline:", e);
      alert("Failed to save. You may need to use Save As.");
    }
  }
,

  async handleSaveTimelineAs() {
    const payload = this._getTimelineSavePayload();

    try {
      if (window.showSaveFilePicker) {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: "timeline_export.json",
          types: [{ description: 'Timeline JSON', accept: { 'application/json': ['.json'] } }]
        });
        const writable = await fileHandle.createWritable();
        await writable.write(payload);
        await writable.close();
        this.currentFileHandle = fileHandle;
      } else {
        // Fallback for Firefox
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "timeline_export.json";
        a.click();
        URL.revokeObjectURL(url);
        // Can't track file handle via download fallback
        this.currentFileHandle = null;
      }
      this.dismissSettingsMenu();
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("Failed to save timeline as:", e);
      }
    }
  }
,

  _makeSettingRow(label, inputEl) {
    const row = document.createElement("div");
    row.className = "pr-settings-row";
    const lbl = document.createElement("span");
    lbl.className = "pr-settings-label";
    lbl.textContent = label;
    row.appendChild(lbl);
    row.appendChild(inputEl);
    return row;
  }
,

  showSettingsMenu(anchorEl) {
    this.dismissSettingsMenu();
    const menu = document.createElement("div");
    menu.className = "pr-settings-menu";

    // Title & Close Button Container
    const titleContainer = document.createElement("div");
    titleContainer.className = "pr-settings-title";
    titleContainer.style.display = "flex";
    titleContainer.style.justifyContent = "space-between";
    titleContainer.style.alignItems = "center";

    const titleText = document.createElement("span");
    titleText.textContent = "Timeline Settings";
    titleContainer.appendChild(titleText);

    const closeBtn = document.createElement("button");
    closeBtn.className = "pr-settings-close-btn";
    closeBtn.innerHTML = ICONS.close;
    closeBtn.title = "Close Settings";
    closeBtn.addEventListener("click", () => this.dismissSettingsMenu());
    titleContainer.appendChild(closeBtn);

    menu.appendChild(titleContainer);

    // --- Save / Load / Show Widgets Grid (2x2) ---
    const gridContainer = document.createElement("div");
    gridContainer.style.display = "grid";
    gridContainer.style.gridTemplateColumns = "repeat(2, 1fr)";
    gridContainer.style.gap = "6px";
    gridContainer.style.marginBottom = "4px";

    const btnSave = document.createElement("button");
    btnSave.className = "pr-settings-toggle-btn";
    btnSave.textContent = "Save Timeline";
    btnSave.addEventListener("click", () => this.handleSaveTimeline());
    gridContainer.appendChild(btnSave);

    const btnSaveAs = document.createElement("button");
    btnSaveAs.className = "pr-settings-toggle-btn";
    btnSaveAs.textContent = "Save Timeline As";
    btnSaveAs.addEventListener("click", () => this.handleSaveTimelineAs());
    gridContainer.appendChild(btnSaveAs);

    const btnLoad = document.createElement("button");
    btnLoad.className = "pr-settings-toggle-btn";
    btnLoad.textContent = "Load Timeline";
    btnLoad.addEventListener("click", () => this.handleLoadTimeline());
    gridContainer.appendChild(btnLoad);

    // --- Show/Hide on Node Toggle ---
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "pr-settings-toggle-btn";
    const widgetsVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
    toggleBtn.textContent = widgetsVisible ? "Hide Widgets" : "Show Widgets";
    toggleBtn.addEventListener("click", () => {
      const nowVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
      if (nowVisible) {
        this.hideSettingsWidgets();
        const stillVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
        toggleBtn.textContent = stillVisible ? "Hide Widgets" : "Show Widgets";
      } else {
        this.showSettingsWidgets();
        toggleBtn.textContent = "Hide Widgets";
      }
    });
    gridContainer.appendChild(toggleBtn);

    menu.appendChild(gridContainer);

    const div2 = document.createElement("hr");
    div2.className = "pr-settings-divider";
    menu.appendChild(div2);

    // Helper: fire a widget's callback safely
    const fireCallback = (w, val) => {
      w.value = val;
      if (w.callback) {
        try { w.callback(val, app.canvas, this.node, null, null); } catch (e) { }
      }
      if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    };

    // --- Display Mode ---
    const dmWidget = this.node.widgets?.find(w => w.name === "display_mode");
    if (dmWidget) {
      const ctrl = document.createElement("div");
      ctrl.className = "pr-segmented-control";

      const framesSeg = document.createElement("div");
      framesSeg.className = "pr-segment";
      framesSeg.textContent = "Frames";

      const secondsSeg = document.createElement("div");
      secondsSeg.className = "pr-segment";
      secondsSeg.textContent = "Seconds";

      const updateActive = (val) => {
        if (val === "frames") {
          framesSeg.classList.add("active");
          secondsSeg.classList.remove("active");
        } else {
          secondsSeg.classList.add("active");
          framesSeg.classList.remove("active");
        }
      };

      updateActive(dmWidget.value);

      const onSegClick = (val) => {
        fireCallback(dmWidget, val);
        updateActive(val);
        // Update ruler/timecode immediately
        if (this.updateWidgetVisibility) this.updateWidgetVisibility();
        if (this.updateUIFromSelection) this.updateUIFromSelection();
        this.render();
      };

      framesSeg.addEventListener("click", () => onSegClick("frames"));
      secondsSeg.addEventListener("click", () => onSegClick("seconds"));

      ctrl.appendChild(secondsSeg);
      ctrl.appendChild(framesSeg);

      menu.appendChild(this._makeSettingRow("Display Mode", ctrl));
    }



    // --- Show Filenames Toggle ---
    const showFnameCtrl = document.createElement("div");
    showFnameCtrl.className = "pr-segmented-control";

    const offSeg = document.createElement("div");
    offSeg.className = "pr-segment";
    offSeg.textContent = "Off";

    const onSeg = document.createElement("div");
    onSeg.className = "pr-segment";
    onSeg.textContent = "On";

    const updateFnameActive = (isEnabled) => {
      if (isEnabled) {
        onSeg.classList.add("active");
        offSeg.classList.remove("active");
      } else {
        offSeg.classList.add("active");
        onSeg.classList.remove("active");
      }
    };

    updateFnameActive(!!this.node.properties.showFilenames);

    const onFnameSegClick = (isEnabled) => {
      this.node.properties.showFilenames = isEnabled;
      updateFnameActive(isEnabled);
      this.render();
      this.commitChanges(true);
    };

    offSeg.addEventListener("click", () => onFnameSegClick(false));
    onSeg.addEventListener("click", () => onFnameSegClick(true));

    showFnameCtrl.appendChild(onSeg);
    showFnameCtrl.appendChild(offSeg);

    menu.appendChild(this._makeSettingRow("Show Filenames", showFnameCtrl));

    const divider2 = document.createElement("div");
    divider2.className = "pr-settings-divider";
    menu.appendChild(divider2);

    // Helper to create scrubbable number control with horizontal buttons
    const createScrubbableNumberControl = (w, step, min, max, isFloat = false) => {
      const container = document.createElement("div");
      container.className = "pr-number-control";

      const decBtn = document.createElement("button");
      decBtn.className = "pr-number-btn";
      decBtn.textContent = "-";

      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "pr-settings-input";
      inp.value = w.value;
      inp.step = step.toString();
      inp.min = min.toString();
      inp.max = max.toString();

      const incBtn = document.createElement("button");
      incBtn.className = "pr-number-btn";
      incBtn.textContent = "+";

      decBtn.addEventListener("click", () => {
        let val = parseFloat(inp.value) - step;
        if (val < min) val = min;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      incBtn.addEventListener("click", () => {
        let val = parseFloat(inp.value) + step;
        if (val > max) val = max;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      inp.addEventListener("change", () => {
        let val = parseFloat(inp.value);
        if (isNaN(val)) val = w.value;
        if (val < min) val = min;
        if (val > max) val = max;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      // Dragging logic
      let isDragging = false;
      let startX = 0;
      let startVal = 0;
      let hasMoved = false;

      inp.style.cursor = "ew-resize";

      inp.addEventListener("mousedown", (e) => {
        startX = e.clientX;
        startVal = parseFloat(inp.value);
        hasMoved = false;

        const onMouseMove = (moveEvent) => {
          const deltaX = moveEvent.clientX - startX;
          if (Math.abs(deltaX) > 3) {
            hasMoved = true;
            isDragging = true;
          }

          if (isDragging) {
            moveEvent.preventDefault();
            const sensitivity = isFloat ? 0.001 : 0.5;
            let newVal = startVal + deltaX * sensitivity;

            if (newVal < min) newVal = min;
            if (newVal > max) newVal = max;

            inp.value = isFloat ? newVal.toFixed(4) : Math.round(newVal);
            fireCallback(w, parseFloat(inp.value));
          }
        };

        const onMouseUp = () => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);

          if (!hasMoved) {
            inp.focus();
            inp.select();
          }
          isDragging = false;
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });

      container.appendChild(decBtn);
      container.appendChild(inp);
      container.appendChild(incBtn);

      return container;
    };

    // --- Epsilon ---
    const epsWidget = this.node.widgets?.find(w => w.name === "epsilon");
    if (epsWidget) {
      menu.appendChild(this._makeSettingRow("Epsilon", createScrubbableNumberControl(epsWidget, 0.0001, 0.0001, 0.99, true)));
    }

    // --- Divisible By ---
    const divByWidget = this.node.widgets?.find(w => w.name === "divisible_by");
    if (divByWidget) {
      menu.appendChild(this._makeSettingRow("Divisible By", createScrubbableNumberControl(divByWidget, 1, 1, 256, false)));
    }

    // --- Img Compression ---
    const compWidget = this.node.widgets?.find(w => w.name === "img_compression");
    if (compWidget) {
      menu.appendChild(this._makeSettingRow("Img Compression", createScrubbableNumberControl(compWidget, 1, 0, 100, false)));
    }

    // --- Divider ---
    const folderDivider = document.createElement("div");
    folderDivider.className = "pr-settings-divider";
    menu.appendChild(folderDivider);

    // --- Workspace Folder Button ---
    const btnOpenFolder = document.createElement("button");
    btnOpenFolder.className = "pr-settings-toggle-btn";
    btnOpenFolder.textContent = "Open";
    btnOpenFolder.style.width = "98px";
    btnOpenFolder.style.margin = "0";
    btnOpenFolder.addEventListener("click", async () => {
      try {
        const response = await api.fetchApi("/ltx_director_open_folder");
        const data = await response.json();
        if (!data.success) {
          console.error("Failed to open workspace folder:", data.error || "Unknown error");
          alert("Could not open workspace folder. This option is only supported when running ComfyUI locally.");
        }
      } catch (err) {
        console.error("Error opening workspace folder:", err);
        alert("Error opening workspace folder: " + err.message);
      }
    });

    menu.appendChild(this._makeSettingRow("Workspace Folder", btnOpenFolder));







    // Position the menu below the anchor button (pop down)
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const menuW = menu.offsetWidth || 230;
    const menuH = menu.offsetHeight || 350;
    let left = rect.right - menuW;
    let top = rect.bottom + 6;
    if (left < 4) left = 4;
    // Fallback to top if it overflows the bottom of the screen
    if (top + menuH > window.innerHeight - 4) {
      top = rect.top - menuH - 6;
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    this._settingsMenu = menu;
    setTimeout(() => {
      this._settingsDismisser = (ev) => {
        if (!menu.contains(ev.target) && !anchorEl.contains(ev.target)) this.dismissSettingsMenu();
      };
      document.addEventListener("pointerdown", this._settingsDismisser, true);
      document.addEventListener("wheel", this._settingsDismisser, true);
    }, 0);
  }
,

  dismissSettingsMenu() {
    if (this._settingsMenu) { this._settingsMenu.remove(); this._settingsMenu = null; }
    if (this._settingsDismisser) {
      document.removeEventListener("pointerdown", this._settingsDismisser, true);
      document.removeEventListener("wheel", this._settingsDismisser, true);
      this._settingsDismisser = null;
    }
  }
};
