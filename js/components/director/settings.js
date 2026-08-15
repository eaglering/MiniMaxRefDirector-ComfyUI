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
      this.currentFileHandle = fileHandle;

      this.loadMedia();

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
    const skipWidgets = ["timeline_data", "local_prompts", "segment_lengths", "guide_strength", "timeline_ui"];

    for (const w of this.node.widgets || []) {
      if (!skipWidgets.includes(w.name) && w.value !== undefined) {
        allSettings[w.name] = w.value;
      }
    }

    return JSON.stringify({
      version: 1,
      settings: allSettings,
      timeline: {
        mainTrackEnabled: this.mainTrackEnabled,
        audioTrackEnabled: this.audioTrackEnabled,
        showFilenames: !!this.node.properties.showFilenames,
        overrideAudio: !!this.node.properties.overrideAudio,
        inpaint_audio: !!(this.node.widgets?.find(w => w.name === "inpaint_audio")?.value),
        propHeight: this.propHeight,
        normalStartFrame: this.timeline.normalStartFrame,
        normalDurationFrames: this.timeline.normalDurationFrames,
        segments: (this.timeline.segments || []).map(s => {
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

    // --- 闭包辅助（配置驱动构建，替代重复的 DOM 样板） ---
    const fire = (w, val) => {
      w.value = val;
      if (w.callback) { try { w.callback(val, app.canvas, this.node, null, null); } catch (e) { } }
      if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    };
    const divider = () => { const d = document.createElement("div"); d.className = "pr-settings-divider"; return d; };
    const btn = (text, onClick, style) => {
      const b = document.createElement("button");
      b.className = "pr-settings-toggle-btn";
      b.textContent = text;
      if (style) Object.assign(b.style, style);
      b.addEventListener("click", onClick);
      return b;
    };
    const segmented = (options, value, onChange) => {
      const ctrl = document.createElement("div");
      ctrl.className = "pr-segmented-control";
      const segs = {};
      for (const opt of options) {
        const s = document.createElement("div");
        s.className = "pr-segment" + (String(opt.value) === String(value) ? " active" : "");
        s.textContent = opt.label;
        s.addEventListener("click", () => {
          for (const k in segs) segs[k].classList.toggle("active", k === opt.value);
          onChange(opt.value);
        });
        ctrl.appendChild(s);
        segs[opt.value] = s;
      }
      return ctrl;
    };
    const scrub = (w, step, min, max, isFloat) => {
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
      inp.value = w.value;
      inp.step = String(step);
      inp.min = String(min);
      inp.max = String(max);
      const commit = (val) => {
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fire(w, parseFloat(inp.value));
      };
      const nudge = (d) => commit(Math.min(max, Math.max(min, parseFloat(inp.value) + d * step)));
      mkBtn("-", () => nudge(-1));
      container.appendChild(inp);
      mkBtn("+", () => nudge(1));
      inp.addEventListener("change", () => {
        let val = parseFloat(inp.value);
        if (isNaN(val)) val = w.value;
        commit(Math.min(max, Math.max(min, val)));
      });
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
            commit(Math.min(max, Math.max(min, startVal + dx * (isFloat ? 0.001 : 0.5))));
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

    // Save / Load / Toggle Widgets grid (2x2)
    const grid = document.createElement("div");
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "repeat(2, 1fr)";
    grid.style.gap = "6px";
    grid.style.marginBottom = "4px";
    for (const { text, onClick } of [
      { text: "Save Timeline", onClick: () => this.handleSaveTimeline() },
      { text: "Save Timeline As", onClick: () => this.handleSaveTimelineAs() },
      { text: "Load Timeline", onClick: () => this.handleLoadTimeline() },
    ]) grid.appendChild(btn(text, onClick));
    const widgetsVisible = () => !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
    const toggleBtn = btn(widgetsVisible() ? "Hide Widgets" : "Show Widgets", () => {
      if (widgetsVisible()) {
        this.hideSettingsWidgets();
      } else {
        this.showSettingsWidgets();
      }
      toggleBtn.textContent = widgetsVisible() ? "Hide Widgets" : "Show Widgets";
    });
    grid.appendChild(toggleBtn);
    menu.appendChild(grid);
    menu.appendChild(divider());

    // Display Mode segmented control
    const dmWidget = this.node.widgets?.find(w => w.name === "display_mode");
    if (dmWidget) {
      menu.appendChild(this._makeSettingRow("Display Mode", segmented(
        [{ value: "seconds", label: "Seconds" }, { value: "frames", label: "Frames" }],
        dmWidget.value,
        (val) => {
          fire(dmWidget, val);
          if (this.updateWidgetVisibility) this.updateWidgetVisibility();
          if (this.updateUIFromSelection) this.updateUIFromSelection();
          this.render();
        }
      )));
    }

    // Show Filenames segmented control
    menu.appendChild(this._makeSettingRow("Show Filenames", segmented(
      [{ value: "true", label: "On" }, { value: "false", label: "Off" }],
      !!this.node.properties.showFilenames,
      (val) => {
        this.node.properties.showFilenames = val === "true";
        this.render();
        this.commitChanges(true);
      }
    )));

    menu.appendChild(divider());

    // Numeric scrub controls (Epsilon / Divisible By / Img Compression)
    for (const [label, name, step, min, max, isFloat] of [
      ["Epsilon", "epsilon", 0.0001, 0.0001, 0.99, true],
      ["Divisible By", "divisible_by", 1, 1, 256, false],
      ["Img Compression", "img_compression", 1, 0, 100, false],
    ]) {
      const w = this.node.widgets?.find(x => x.name === name);
      if (w) menu.appendChild(this._makeSettingRow(label, scrub(w, step, min, max, isFloat)));
    }

    menu.appendChild(divider());

    // Workspace Folder button
    const btnOpenFolder = btn("Open", async () => {
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
    }, { width: "98px", margin: "0" });
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
