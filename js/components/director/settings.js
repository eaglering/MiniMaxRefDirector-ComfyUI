// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: get_settingsWidgetNames, hideSettingsWidgets, showSettingsWidgets, handleLoadTimeline, _applyLoadedTimeline, _getTimelineSavePayload, handleSaveTimeline, handleSaveTimelineAs, _makeSettingRow, showSettingsMenu, dismissSettingsMenu
import { ICONS, api, app, hideWidget, parseInitial, showWidget } from "./shared.js";
import { t } from "../../i18n.js";

// 导入 Excel 的 loading 遮罩样式（幂等注入）
if (!document.getElementById("mrd-pr-import-overlay-styles")) {
  const st = document.createElement("style");
  st.id = "mrd-pr-import-overlay-styles";
  st.textContent = `
.mrd-pr-import-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:2147483000;backdrop-filter:blur(2px)}
.mrd-pr-import-spinner{width:46px;height:46px;border:4px solid rgba(255,255,255,0.2);border-top-color:#5c9dff;border-radius:50%;animation:mrd-pr-import-spin 0.8s linear infinite}
.mrd-pr-import-text{color:#e8e8e8;font-size:13px;margin-top:14px;font-family:sans-serif;letter-spacing:0.03em}
@keyframes mrd-pr-import-spin{to{transform:rotate(360deg)}}`;
  document.head.appendChild(st);
}

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
          types: [{ description: t('Timeline JSON'), accept: { 'application/json': ['.json'] } }],
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
        alert(t("Failed to load timeline. See console for details."));
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
      alert(t("Invalid timeline file."));
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
          // 确保 guideStrength 始终落盘（前端默认 22，state.js 读取时 ?? 22）
          if (rest.guideStrength === undefined) rest.guideStrength = 22;
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
      alert(t("Failed to save. You may need to use Save As."));
    }
  }
,

  async handleSaveTimelineAs() {
    const payload = this._getTimelineSavePayload();

    try {
      if (window.showSaveFilePicker) {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: "timeline_export.json",
          types: [{ description: t('Timeline JSON'), accept: { 'application/json': ['.json'] } }]
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

  async handleExportTimelineAsExcel() {
    try {
      // 时间轴数据（segments）
      const payload = JSON.parse(this._getTimelineSavePayload());
      const segments = (payload.timeline && payload.timeline.segments) || [];
      // 主体数据：优先实时缓存 window.__refSubjects，兜底从 graph 中 Subject 节点 widget 解析
      let subjects = [];
      try {
        if (Array.isArray(window.__refSubjects)) subjects = window.__refSubjects;
      } catch (_) { }
      if (!subjects.length) subjects = this._getSubjectsFromGraph();

      const xml = this._buildSpreadsheetXml(segments, subjects);

      if (window.showSaveFilePicker) {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: "timeline_export.xlsm",
          types: [{ description: t("Export Excel"), accept: { "application/vnd.ms-excel": [".xlsm"] } }]
        });
        const writable = await fileHandle.createWritable();
        await writable.write(xml);
        await writable.close();
        this.currentFileHandle = fileHandle;
      } else {
        // Fallback for Firefox
        const blob = new Blob([xml], { type: "application/vnd.ms-excel" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "timeline_export.xlsm";
        a.click();
        URL.revokeObjectURL(url);
        // Can't track file handle via download fallback
        this.currentFileHandle = null;
      }
      this.dismissSettingsMenu();
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("Failed to export timeline as Excel:", e);
        alert(t("Failed to save. You may need to use Save As."));
      }
    }
  }
,

  // 从 graph 中 MiniMaxRefSubject 节点的 subject_data widget 解析主体列表（兜底）
  _getSubjectsFromGraph() {
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
      console.warn("[Settings] getSubjectsFromGraph failed:", e);
    }
    return [];
  }
,

  // XML 转义：& < > " ' 及换行（&#10;），保证任意内容都能安全写入 Excel XML
  _xmlEscape(s) {
    if (s === undefined || s === null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      .replace(/\n/g, "&#10;");
  }
,

  // 构建 SpreadsheetML 2003 XML：Timeline（ID/开始/时长/Prompt/H3PromptJson/GuideStrength）
  // + Subjects（名称/关联关系/主体描述/保留描述）双 sheet，关联关系列带下拉限制
  _buildSpreadsheetXml(segments, subjects) {
    const esc = (v) => this._xmlEscape(v);

    let tRows = '<Row><Cell><Data ss:Type="String">ID</Data></Cell>'
      + '<Cell><Data ss:Type="String">开始</Data></Cell>'
      + '<Cell><Data ss:Type="String">时长</Data></Cell>'
      + '<Cell><Data ss:Type="String">Prompt</Data></Cell>'
      + '<Cell><Data ss:Type="String">H3PromptJson</Data></Cell>'
      + '<Cell><Data ss:Type="String">GuideStrength</Data></Cell></Row>';
    for (const seg of segments || []) {
      const h3 = seg.h3PromptJson ? JSON.stringify(seg.h3PromptJson) : "";
      // guideStrength 默认与前端 state.js 保持一致（22）
      const gs = seg.guideStrength !== undefined && seg.guideStrength !== null ? seg.guideStrength : 22;
      tRows += '<Row>'
        + '<Cell><Data ss:Type="String">' + esc(seg.id || "") + '</Data></Cell>'
        + '<Cell><Data ss:Type="Number">' + (Number(seg.start) || 0) + '</Data></Cell>'
        + '<Cell><Data ss:Type="Number">' + (Number(seg.length) || 0) + '</Data></Cell>'
        + '<Cell><Data ss:Type="String">' + esc(seg.prompt || "") + '</Data></Cell>'
        + '<Cell><Data ss:Type="String">' + esc(h3) + '</Data></Cell>'
        + '<Cell><Data ss:Type="Number">' + gs + '</Data></Cell></Row>';
    }
    const timelineSheet = '<Worksheet ss:Name="Timeline"><Table>' + tRows + '</Table></Worksheet>';

    let sRows = '<Row><Cell><Data ss:Type="String">名称</Data></Cell>'
      + '<Cell><Data ss:Type="String">关联关系</Data></Cell>'
      + '<Cell><Data ss:Type="String">主体描述</Data></Cell>'
      + '<Cell><Data ss:Type="String">保留描述</Data></Cell></Row>';
    for (const s of subjects || []) {
      sRows += '<Row>'
        + '<Cell><Data ss:Type="String">' + esc(s.name || "") + '</Data></Cell>'
        + '<Cell><Data ss:Type="String">' + esc(s.relationship || "none") + '</Data></Cell>'
        + '<Cell><Data ss:Type="String">' + esc(s.description || "") + '</Data></Cell>'
        + '<Cell><Data ss:Type="String">' + esc(s.retention || "") + '</Data></Cell></Row>';
    }
    // 关联关系列可选值 = Subject/Picture/Video/Audio 全部合法值去重并集（none 代表空）
    const relOptions = [
      "fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference",
      "fully_copy", "partially_copy", "reference", "none"
    ];
    const dvFormula = '"' + relOptions.join(",") + '"';
    const subjectsSheet = '<Worksheet ss:Name="Subjects"><Table>' + sRows + '</Table>'
      + '<x:DataValidation><x:Type>List</x:Type><x:Formula1>' + dvFormula + '</x:Formula1>'
      + '<x:Range>R2C2:R1000C2</x:Range><x:ShowDropDown>0</x:ShowDropDown></x:DataValidation></Worksheet>';

    return '<?xml version="1.0"?>\n'
      + '<?mso-application progid="Excel.Sheet"?>\n'
      + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n'
      + ' xmlns:o="urn:schemas-microsoft-com:office:office"\n'
      + ' xmlns:x="urn:schemas-microsoft-com:office:excel"\n'
      + ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"\n'
      + ' xmlns:html="http://www.w3.org/TR/REC-html40">\n'
      + ' <Styles>\n'
      + '  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Top"/><Font ss:FontName="Calibri" ss:Size="11"/></Style>\n'
      + '  <Style ss:ID="Header"><Font ss:Bold="1"/></Style>\n'
      + ' </Styles>\n'
      + timelineSheet + '\n'
      + subjectsSheet + '\n'
      + '</Workbook>';
  }
,

  async handleImportTimelineFromExcel() {
    try {
      if (window.showOpenFilePicker) {
        const [fileHandle] = await window.showOpenFilePicker({
          types: [{ description: t("Import Excel"), accept: { "application/vnd.ms-excel": [".xlsm"] } }],
          multiple: false
        });
        const file = await fileHandle.getFile();
        const content = await file.text();
        await this._importTimelineFromExcelXml(content, fileHandle);
      } else {
        // Fallback for browsers without showOpenFilePicker (e.g. Firefox)
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".xlsm";
        input.onchange = async e => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = async evt => {
            try {
              await this._importTimelineFromExcelXml(evt.target.result, null);
            } catch (err) {
              console.error("Failed to import timeline from Excel:", err);
              alert(t("Failed to load timeline. See console for details."));
            }
          };
          reader.readAsText(file);
        };
        input.click();
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("Failed to import timeline from Excel:", e);
        alert(t("Failed to load timeline. See console for details."));
      }
    }
  }
,

  // 显示导入 loading 遮罩（spinner + 文案），幂等：重复调用先移除旧的
  _showImportOverlay(text) {
    this._hideImportOverlay();
    const overlay = document.createElement("div");
    overlay.className = "mrd-pr-import-overlay";
    overlay.innerHTML = '<div class="mrd-pr-import-spinner"></div><div class="mrd-pr-import-text"></div>';
    const txt = overlay.querySelector(".mrd-pr-import-text");
    if (txt) txt.textContent = text || t("Importing...");
    document.body.appendChild(overlay);
    this._importOverlayEl = overlay;
  }
,

  // 移除导入 loading 遮罩
  _hideImportOverlay() {
    if (this._importOverlayEl) {
      this._importOverlayEl.remove();
      this._importOverlayEl = null;
    }
  }
,

  // 从 SpreadsheetML 2003 XML 字符串导入：还原 segments（h3PromptJson 优先用 JSON 列，
  // 否则以 Prompt 列调 generate_prompt_json 生成），应用时间轴，再同步主体。
  async _importTimelineFromExcelXml(xmlStr, fileHandle) {
    // 二进制 xlsm/xlsx 是 ZIP 压缩格式（PK 开头），不是 XML 明文，无法用 DOMParser 解析
    if (!xmlStr || String(xmlStr).trim().slice(0, 5) !== "<?xml") {
      alert(t("Failed to load timeline. See console for details.") + "\n" + t("Invalid timeline file.") + " " + t("Please export as XML spreadsheet."));
      return;
    }
    this._showImportOverlay(t("Importing..."));
    let subjectRows = [];
    let segments = [];
    try {
      const sheets = this._parseSpreadsheetXml(xmlStr);
      const timelineRows = sheets["Timeline"] || [];
      subjectRows = sheets["Subjects"] || [];

      // ---- 还原 segments ----
      const frameRate = this.getFrameRate ? this.getFrameRate() : 24;
      segments = [];
      let genFailed = 0;
      for (let i = 1; i < timelineRows.length; i++) {
        const r = timelineRows[i];
        if (!r || r.every(c => String(c || "").trim() === "")) continue;
        const prompt = String(r[3] || "").trim();
        const id = String(r[0] || "").trim() || ("import_" + i + "_" + Date.now().toString(36));
        const start = parseFloat(r[1]) || 0;
        const length = parseFloat(r[2]) || 0;
        // 第 6 列 GuideStrength（可选，旧文件无此列）
        let guideStrength;
        const gsStr = String(r[5] || "").trim();
        if (gsStr !== "" && !isNaN(parseFloat(gsStr))) guideStrength = parseFloat(gsStr);
        const durSecs = length > 0 ? parseFloat((length / Math.max(1, frameRate)).toFixed(2)) : 0;

        let h3PromptJson = null;
        const jsonStr = String(r[4] || "").trim();
        if (jsonStr) {
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              h3PromptJson = this._normalizePromptJson(parsed);
            }
          } catch { /* JSON 非法 → 回退生成 */ }
        }
        if (!h3PromptJson && prompt) {
          // 内容描述字符串 prompt → 调 generate_prompt_json 生成 h3PromptJson
          try {
            h3PromptJson = await this._generatePromptJson(prompt, durSecs);
          } catch (err) {
            genFailed++;
            console.warn("[Settings] generate_prompt_json failed for segment", id, err);
          }
        }
        if (!h3PromptJson) h3PromptJson = this._normalizePromptJson(null);

        const seg = { id, start, length, prompt, type: "text", autoEndFrame: true, h3PromptJson };
        if (guideStrength !== undefined) seg.guideStrength = guideStrength;
        segments.push(seg);
      }

      // ---- 重叠检测：按 start 排序，重叠（start 落在前一段时长内）则自动延后开始时间 ----
      let overlapAdjusted = 0;
      if (segments.length > 1) {
        segments.sort((a, b) => (a.start || 0) - (b.start || 0));
        let cursor = 0;
        for (const seg of segments) {
          if ((seg.start || 0) < cursor) {
            seg.start = cursor;
            overlapAdjusted++;
          }
          cursor = Math.max(cursor, (seg.start || 0) + (seg.length || 0));
        }
      }

      // ---- 应用时间轴 ----
      const current = JSON.parse(this._getTimelineSavePayload());
      current.timeline.segments = segments;
      this._applyLoadedTimeline(JSON.stringify(current), fileHandle);

      // 提示导入完成（含生成失败/重叠调整数）
      if (segments.length > 0) {
        let msg = t("Excel import completed: {n} segments", { n: segments.length });
        if (genFailed) msg += " (" + t("Generation failed") + ": " + genFailed + ")";
        if (overlapAdjusted) msg += " (" + t("Overlapping segments auto-adjusted: {n}", { n: overlapAdjusted }) + ")";
        alert(msg);
      }
    } finally {
      this._hideImportOverlay();
    }

    // ---- 同步主体：Subjects sheet 优先 + h3PromptJson 引用补充 ----
    const merged = new Map();
    for (let i = 1; i < subjectRows.length; i++) {
      const r = subjectRows[i];
      if (!r) continue;
      const name = String(r[0] || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!merged.has(key)) {
        merged.set(key, {
          name,
          relationship: String(r[1] || "").trim() || undefined,
          description: String(r[2] || ""),
          retention: String(r[3] || ""),
        });
      }
    }
    for (const ref of this._extractSubjectRefs(segments)) {
      const key = ref.name.toLowerCase();
      if (!merged.has(key)) merged.set(key, ref);
    }
    const list = Array.from(merged.values());
    if (list.length) {
      if (typeof window.__upsertRefSubjects === "function") {
        try {
          window.__upsertRefSubjects(list);
        } catch (err) {
          console.error("[Settings] upsertRefSubjects failed:", err);
        }
      } else {
        console.warn("[Settings] window.__upsertRefSubjects not available; subjects skipped.");
      }
    }
  }
,

  // 命名空间容忍解析 SpreadsheetML 2003 XML → { sheetName: [ [cellText,...], ... ] }
  _parseSpreadsheetXml(xmlStr) {
    const sheets = {};
    const doc = new DOMParser().parseFromString(xmlStr, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) {
      throw new Error("XML parse error");
    }
    // 取带命名空间前缀属性的值（如 ss:Name / ss:Index），兼容任意前缀与无前缀
    const attrValue = (el, localName) => {
      const a = el && el.attributes && Array.from(el.attributes).find(x => x.localName === localName);
      return a ? a.value : "";
    };
    const worksheets = doc.getElementsByTagNameNS("*", "Worksheet");
    for (const ws of worksheets) {
      const name = attrValue(ws, "Name");
      const rows = [];
      const tables = ws.getElementsByTagNameNS("*", "Table");
      if (!tables.length) continue;
      const rowEls = tables[0].getElementsByTagNameNS("*", "Row");
      for (const rowEl of rowEls) {
        const cells = [];
        const cellEls = rowEl.getElementsByTagNameNS("*", "Cell");
        let idx = 0;
        for (const cellEl of cellEls) {
          const indexAttr = attrValue(cellEl, "Index");
          const colIndex = indexAttr ? (parseInt(indexAttr, 10) - 1) : idx;
          while (cells.length < colIndex) cells.push("");
          const dataEl = cellEl.getElementsByTagNameNS("*", "Data")[0];
          cells[colIndex] = dataEl ? (dataEl.textContent || "") : "";
          idx = colIndex + 1;
        }
        rows.push(cells);
      }
      if (name) sheets[name] = rows;
    }
    return sheets;
  }
,

  // 从 graph 中 MiniMaxRefSubject 节点读取 VLM 配置（与 transfer.js getSubjectVlmSettings 同款逻辑，
  // 兼容主 widget 对象 / 子 widget 带前缀 / 子 widget 裸名三种形态）
  _getSubjectVlmSettings() {
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
        const out = { vlm_mode: "api", gguf_name: "", mmproj_path: "", provider: "GLM", api_key: "", ollama_model: "", ollama_base_url: "" };
        if (v && typeof v === "object" && !Array.isArray(v)) {
          out.vlm_mode = v.vlm_mode || out.vlm_mode;
          out.gguf_name = clean(v.gguf_name);
          out.mmproj_path = clean(v.mmproj_path);
          out.provider = v.provider || out.provider;
          out.api_key = clean(v.api_key);
          out.ollama_model = clean(v.ollama_model);
          out.ollama_base_url = clean(v.ollama_base_url);
        } else {
          out.vlm_mode = v || out.vlm_mode;
          out.gguf_name = clean(findAny("vlm_mode.gguf_name", "gguf_name"));
          out.mmproj_path = clean(findAny("vlm_mode.mmproj_path", "mmproj_path"));
          out.provider = findAny("vlm_mode.provider", "provider") || out.provider;
          out.api_key = clean(findAny("vlm_mode.api_key", "api_key"));
          out.ollama_model = clean(findAny("vlm_mode.ollama_model", "ollama_model"));
          out.ollama_base_url = clean(findAny("vlm_mode.ollama_base_url", "ollama_base_url"));
        }
        // 主 widget 缺失或为空时，从子 widget 推断模式
        if (out.vlm_mode === "api") {
          const hasGguf =
            findW("vlm_mode.gguf_name") || findW("gguf_name") ||
            findW("vlm_mode.mmproj_path") || findW("mmproj_path");
          if (hasGguf) out.vlm_mode = "llama-cpp";
        }
        return out;
      }
    } catch (e) {
      console.warn("[Settings] getSubjectVlmSettings failed:", e);
    }
    return null;
  }
,

  // 以内容描述 prompt 调用 /minimax_ref/api/llm/generate_prompt_json 生成 h3PromptJson
  async _generatePromptJson(prompt, durationSeconds) {
    const v = this._getSubjectVlmSettings() || {};
    const seedWidget = this.node.widgets?.find(w => w.name === "seed");
    const body = {
      vlm_mode: v.vlm_mode || "api",
      seed: seedWidget?.value ?? 42,
      gguf_path: v.gguf_name || "",
      mmproj_path: v.mmproj_path || "",
      provider: v.provider || "GLM",
      api_key: v.api_key || "",
      ollama_model: v.ollama_model || "",
      ollama_base_url: v.ollama_base_url || "",
      prompt,
      image_path: null,
      duration_seconds: durationSeconds > 0 ? durationSeconds : 0,
      lang: "zh",
    };
    const res = await api.fetchApi("/minimax_ref/api/llm/generate_prompt_json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data || !data.success) {
      throw new Error((data && data.error) || "Generation failed");
    }
    return this._normalizePromptJson(data.json_data);
  }
,

  // h3PromptJson 统一规范化为 { summary, detailed_description, overall_soundscape, non_diegetic_music }
  _normalizePromptJson(v) {
    const defaults = { summary: "", detailed_description: "", overall_soundscape: "", non_diegetic_music: "" };
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.assign({}, defaults, v);
    if (typeof v === "string" && v.trim()) {
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return Object.assign({}, defaults, parsed);
        }
      } catch { /* 回退默认模板 */ }
    }
    return Object.assign({}, defaults);
  }
,

  // 从 segments 的 h3PromptJson 文本中提取 <@主体名> / <#主体名:内容> 引用，
  // 过滤纯数字（如 <@2> 是场景引用而非主体），去重返回 [{ name }]。
  _extractSubjectRefs(segments) {
    const seen = new Map();
    for (const seg of segments || []) {
      const h3 = seg && seg.h3PromptJson;
      const text = h3 && typeof h3 === "object"
        ? [h3.summary, h3.detailed_description, h3.overall_soundscape, h3.non_diegetic_music]
          .filter(v => typeof v === "string").join("\n")
        : String((seg && seg.prompt) || "");
      if (!text) continue;
      const patterns = [/<@([^>#\s]+)>/g, /<#([^>:]+):/g];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) {
          const name = (m[1] || "").trim();
          if (!name || /^\d+$/.test(name)) continue;
          const key = name.toLowerCase();
          if (!seen.has(key)) seen.set(key, { name });
        }
      }
    }
    return Array.from(seen.values());
  }
,

  _makeSettingRow(label, inputEl) {
    const row = document.createElement("div");
    row.className = "mrd-pr-settings-row";
    const lbl = document.createElement("span");
    lbl.className = "mrd-pr-settings-label";
    lbl.textContent = label;
    row.appendChild(lbl);
    row.appendChild(inputEl);
    return row;
  }
,

  showSettingsMenu(anchorEl) {
    this.dismissSettingsMenu();
    const menu = document.createElement("div");
    menu.className = "mrd-pr-settings-menu";

    // --- 闭包辅助（配置驱动构建，替代重复的 DOM 样板） ---
    const fire = (w, val) => {
      w.value = val;
      if (w.callback) { try { w.callback(val, app.canvas, this.node, null, null); } catch (e) { } }
      if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    };
    const divider = () => { const d = document.createElement("div"); d.className = "mrd-pr-settings-divider"; return d; };
    const btn = (text, onClick, style) => {
      const b = document.createElement("button");
      b.className = "mrd-pr-settings-toggle-btn";
      b.textContent = text;
      if (style) Object.assign(b.style, style);
      b.addEventListener("click", onClick);
      return b;
    };
    const segmented = (options, value, onChange) => {
      const ctrl = document.createElement("div");
      ctrl.className = "mrd-pr-segmented-control";
      const segs = {};
      for (const opt of options) {
        const s = document.createElement("div");
        s.className = "mrd-pr-segment" + (String(opt.value) === String(value) ? " active" : "");
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
      container.className = "mrd-pr-number-control";
      const mkBtn = (label, act) => {
        const b = document.createElement("button");
        b.className = "mrd-pr-number-btn";
        b.textContent = label;
        b.addEventListener("click", act);
        container.appendChild(b);
        return b;
      };
      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "mrd-pr-settings-input";
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
    titleContainer.className = "mrd-pr-settings-title";
    titleContainer.style.display = "flex";
    titleContainer.style.justifyContent = "space-between";
    titleContainer.style.alignItems = "center";
    const titleText = document.createElement("span");
    titleText.textContent = t("Timeline Settings");
    titleContainer.appendChild(titleText);
    const closeBtn = document.createElement("button");
    closeBtn.className = "mrd-pr-settings-close-btn";
    closeBtn.innerHTML = ICONS.close;
    closeBtn.title = t("Close Settings");
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
      { text: t("Save Timeline"), onClick: () => this.handleSaveTimeline() },
      { text: t("Save Timeline As"), onClick: () => this.handleSaveTimelineAs() },
      { text: t("Load Timeline"), onClick: () => this.handleLoadTimeline() },
      { text: t("Export Excel"), onClick: () => this.handleExportTimelineAsExcel() },
      { text: t("Import Excel"), onClick: () => this.handleImportTimelineFromExcel() },
    ]) grid.appendChild(btn(text, onClick));
    const widgetsVisible = () => !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
    const toggleBtn = btn(widgetsVisible() ? t("Hide Widgets") : t("Show Widgets"), () => {
      if (widgetsVisible()) {
        this.hideSettingsWidgets();
      } else {
        this.showSettingsWidgets();
      }
      toggleBtn.textContent = widgetsVisible() ? t("Hide Widgets") : t("Show Widgets");
    });
    grid.appendChild(toggleBtn);
    menu.appendChild(grid);
    menu.appendChild(divider());

    // Display Mode segmented control
    const dmWidget = this.node.widgets?.find(w => w.name === "display_mode");
    if (dmWidget) {
      menu.appendChild(this._makeSettingRow(t("Display Mode"), segmented(
        [{ value: "seconds", label: t("Seconds") }, { value: "frames", label: t("Frames") }],
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
    menu.appendChild(this._makeSettingRow(t("Show Filenames"), segmented(
      [{ value: "true", label: t("On") }, { value: "false", label: t("Off") }],
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
      [t("Epsilon"), "epsilon", 0.0001, 0.0001, 0.99, true],
      [t("Divisible By"), "divisible_by", 1, 1, 256, false],
      [t("Img Compression"), "img_compression", 1, 0, 100, false],
    ]) {
      const w = this.node.widgets?.find(x => x.name === name);
      if (w) menu.appendChild(this._makeSettingRow(label, scrub(w, step, min, max, isFloat)));
    }

    menu.appendChild(divider());

    // Workspace Folder button
    const btnOpenFolder = btn(t("Open"), async () => {
      try {
        const response = await api.fetchApi("/minimax_ref/api/h3/ltx_director_open_folder");
        const data = await response.json();
        if (!data.success) {
          console.error("Failed to open workspace folder:", data.error || "Unknown error");
          alert(t("Could not open workspace folder. This option is only supported when running ComfyUI locally."));
        }
      } catch (err) {
        console.error("Error opening workspace folder:", err);
        alert(t("Error opening workspace folder: ") + err.message);
      }
    }, { width: "98px", margin: "0" });
    menu.appendChild(this._makeSettingRow(t("Workspace Folder"), btnOpenFolder));

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
