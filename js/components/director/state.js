// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: updateSelectionFromBox, syncSelectionTypeAndIndex, growTimelineIfNeeded, getMaxZoom, getVisualDurationFrames, updateZoomSliderMax, updateUIFromSelection, updateSidebarHeights
import { AUDIO_TRACK_HEIGHT, BLOCK_HEIGHT, RULER_HEIGHT, MIN_SEGMENT_LENGTH, app } from "./shared.js";
import { t } from "../../i18n.js";

// transfer 面板（.mrd-pr-transfer-mount）显示时保证的最小 prop 区高度：
// buttons 行 + status + resources 预览条（含 H3 prompt 预览，min 450px）+ 间距
const TRANSFER_MIN_HEIGHT = 520;

export const state = {
  // 显示/隐藏 .mrd-pr-transfer-mount，并按需调整 prop 区（propContainer）高度
  _setTransferVisible(show) {
    if (this.transferMount) this.transferMount.style.display = show ? "block" : "none";
    if (this.propContainer) {
      const target = show
        ? Math.max(this.propHeight, TRANSFER_MIN_HEIGHT)
        : Math.min(this.propHeight, this.initialPropHeight || 200);
      this.propHeight = target;
      if (this.node && this.node.properties) this.node.properties.propHeight = target;
      // 固定 height：transfer 面板 height:100% 填满，textarea（flex:1）随容器拉伸
      this.propContainer.style.height = `${target}px`;
    }
    // 触发实测 wrapper 内容总高并同步 node 高度
    if (this._syncNodeHeight) this._syncNodeHeight();
  },

  updateSelectionFromBox() {
    if (!this._selectBoxStart || !this._selectBoxCurrent) return;

    const width = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();
    if (!width || totalFrames <= 0) return;

    const sx = this._selectBoxStart.x;
    const sy = this._selectBoxStart.y;
    const cx = this._selectBoxCurrent.x;
    const cy = this._selectBoxCurrent.y;

    const left = Math.min(sx, cx);
    const right = Math.max(sx, cx);
    const top = Math.min(sy, cy);
    const bottom = Math.max(sy, cy);

    const newSelectedIds = new Set(this._selectBoxInitialSelectedIds || []);

    for (const track of ["image", "audio"]) {
      const arr = this.getSegmentArray(track);
      if (!arr) continue;

      let trackTop = 0;
      let trackBottom = 0;

      if (track === "image") {
        trackTop = RULER_HEIGHT;
        trackBottom = RULER_HEIGHT + this.blockHeight;
      } else if (track === "audio") {
        trackTop = RULER_HEIGHT + this.blockHeight;
        trackBottom = RULER_HEIGHT + this.blockHeight + this.audioTrackHeight;
      }

      for (const seg of arr) {
        const startX = (seg.start / totalFrames) * width;
        const pxWidth = (seg.length / totalFrames) * width;
        const endX = startX + pxWidth;

        // Check rect intersection
        const intersects = (left <= endX && right >= startX && top <= trackBottom && bottom >= trackTop);

        if (intersects) {
          newSelectedIds.add(seg.id);
          const sibId = seg.id.endsWith("_v") ? seg.id.slice(0, -2) + "_a" : (seg.id.endsWith("_a") ? seg.id.slice(0, -2) + "_v" : null);
          if (sibId) {
            newSelectedIds.add(sibId);
          }
        }
      }
    }

    this.selectedSegmentIds = Array.from(newSelectedIds);
    this.syncSelectionTypeAndIndex();
  }
,

  syncSelectionTypeAndIndex() {
    if (!this.selectedSegmentIds || this.selectedSegmentIds.length === 0) {
      this._selectedIndex = -1;
      return;
    }
    if (this.isMultiSelectActive()) {
      this._selectedIndex = -1;
      return;
    }
    // Sync single selection (which might be video + audio sibling)
    const firstId = this.selectedSegmentIds[0];
    for (const track of ["image", "audio"]) {
      const arr = this.getSegmentArray(track);
      const idx = arr.findIndex(s => s.id === firstId);
      if (idx !== -1) {
        this.selectionType = track;
        this._selectedIndex = idx;
        break;
      }
    }
  }
,

  growTimelineIfNeeded(requiredFrames) {
    const current = this.getDurationFrames();
    if (requiredFrames <= current) return; // already big enough

    const newFrames = Math.ceil(requiredFrames);
    if (this.durationFramesWidget) {
      this.durationFramesWidget.value = newFrames;
    }
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.value = parseFloat((newFrames / this.getFrameRate()).toFixed(2));
    }
    // Notify ComfyUI that the widget value changed so it serialises correctly.
    if (window.app && window.app.graph) {
      window.app.graph.setDirtyCanvas(true, true);
    }
  }
,



  getMaxZoom() {
    const visualDurationSecs = this.getVisualDurationFrames() / this.getFrameRate();
    const baseMaxZoom = Math.max(1, visualDurationSecs / 4);

    // Limit max zoom to prevent canvas width from exceeding browser limits (causing crash)
    const viewportWidth = this.viewport ? this.viewport.clientWidth : 1000;
    const MAX_CANVAS_WIDTH = 32768; // Extended limit for modern browsers
    const limitMaxZoom = MAX_CANVAS_WIDTH / Math.max(1, viewportWidth);

    return Math.max(1, Math.min(baseMaxZoom, limitMaxZoom));
  }
,

  getVisualDurationFrames() {
    let furthest = 0;
    for (const seg of this.timeline.segments) {
      furthest = Math.max(furthest, seg.start + seg.length);
    }
    for (const seg of this.timeline.audioSegments) {
      furthest = Math.max(furthest, seg.start + seg.length);
    }
    const outputDuration = this.getDurationFrames();
    if (furthest <= 0) return outputDuration;
    return Math.max(outputDuration, Math.ceil(furthest * 1.30));
  }
,

  updateZoomSliderMax() {
    if (!this.zoomSlider) return;
    const maxZoom = this.getMaxZoom();
    this.zoomSlider.max = maxZoom.toFixed(2);
    if (this.zoomLevel > maxZoom) {
      this.zoomLevel = maxZoom;
      this.zoomSlider.value = maxZoom;
      // Resize the canvas to match the clamped zoom
      const viewportWidth = this.viewport ? this.viewport.clientWidth : 0;
      if (viewportWidth > 0) {
        const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
        this.canvas.style.width = newCanvasWidth + "px";
        this.resizeCanvas(newCanvasWidth);
      }
    }
  }
,

  updateUIFromSelection() {
    if (this._updateMultiBars) this._updateMultiBars();
    if (this.selectedSegmentIds && this.isMultiSelectActive()) {
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      if (this.promptInput) {
        this.promptInput.value = "";
        this.promptInput.placeholder = t("(Multiple Segments Selected)");
        this.promptInput.disabled = true;
        this.promptInput.style.opacity = "0.35";
        if (this._transferSetLeft) this._transferSetLeft("");
      }

      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = t("Segment Prompt");
      }

      if (this.strengthRow) this.strengthRow.style.display = "flex";
      if (this.strengthLabel) this.strengthLabel.style.display = "inline";
      if (this.strengthValue) {
        this.strengthValue.style.display = "inline-block";
        this.strengthValue.value = "";
        this.strengthValue.placeholder = t("(Multiple)");
        this.strengthValue.disabled = true;
        this.strengthValue.style.opacity = "0.35";
      }

      if (this.durationValue) {
        this.durationValue.style.display = "inline-block";
        this.durationValue.value = "";
        this.durationValue.placeholder = t("(Multiple)");
        this.durationValue.disabled = true;
        this.durationValue.style.opacity = "0.35";
      }

      if (this.audioInfoArea) this.audioInfoArea.style.display = "none";

      if (this.segmentBoundsDisplay) {
        this.segmentBoundsDisplay.textContent = t("Multiple Segments Selected");
      }
      if (this._transferSetSeg) this._transferSetSeg(null);
      this._setTransferVisible(false);
      return;
    }

    let seg = null;
    if (this.selectedIndex >= 0) {
      if (this.selectionType === "audio") {
        const origSeg = this.timeline.audioSegments[this.selectedIndex];
        if (origSeg) {
          const previewIsAudio = this._ghostTrack === 'audio' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
          const arr = (this._previewSegments && previewIsAudio) ? this._previewSegments : this.timeline.audioSegments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      } else {
        const origSeg = this.timeline.segments[this.selectedIndex];
        if (origSeg) {
          const previewIsImage = this._ghostTrack === 'image' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'image');
          const arr = (this._previewSegments && previewIsImage) ? this._previewSegments : this.timeline.segments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      }
    }

    // Reset default disabled/opacity values
    if (this.strengthValue) {
      this.strengthValue.style.opacity = "";
      this.strengthValue.placeholder = "";
    }
    if (this.durationValue) {
      this.durationValue.style.opacity = "";
      this.durationValue.placeholder = "";
    }
    if (this.promptInput) {
      this.promptInput.placeholder = "";
      this.promptInput.style.opacity = "";
    }

    if (this.selectionType === "audio" && seg) {
      if (this.promptWrapper) this.promptWrapper.style.display = "none";
      this._setTransferVisible(false);
      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "inline";
      this.strengthLabel.textContent = t("Guide Strength:");
      this.strengthValue.style.display = "inline-block";
      this.audioInfoArea.style.display = "block";
      this.audioInfoArea.innerHTML = `
        ${t("File")}: <span>${seg.fileName || t("Unknown")}</span><br>
        ${t("Length")}: <span>${this.formatTime(seg.audioDurationFrames)}</span> ${t("Output Length")}: <span>${this.formatTime(seg.length)}</span><br>
        ${t("Trim-in")}: <span>${this.formatTime(Math.round(seg.trimStart))}</span> ${t("Trim-Out")}: <span>${this.formatTime(Math.round(seg.audioDurationFrames - (seg.trimStart + seg.length)))}</span>
      `;
      this.strengthValue.value = "22";
      this.strengthValue.disabled = true;
      if (this.durationValue) {
        this.durationValue.style.display = "inline-block";
        this.durationValue.value = this._formatDurationValue(seg.length);
        this.durationValue.disabled = false;
        this.durationValue.style.opacity = "1.0";
      }
    } else {
      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = t("Segment Prompt");
      }
      this.audioInfoArea.style.display = "none";
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "inline";
      this.strengthLabel.textContent = t("Guide Strength:");
      this.strengthValue.style.display = "inline-block";

      if (seg) {
        this.promptInput.value = seg.prompt || "";
        if (this._transferSetLeft) this._transferSetLeft(this.promptInput.value);
        this.promptInput.placeholder = t("Enter prompt for selected segment...");
        this.promptInput.disabled = false;
        this.promptInput.style.opacity = "1.0";
        this._setTransferVisible(true);

        const strength = (seg.guideStrength ?? 22);
        this.strengthValue.value = parseInt(strength);
        this.strengthValue.disabled = false;
        this.strengthValue.style.opacity = "1.0";
        if (this.durationValue) {
          this.durationValue.style.display = "inline-block";
          this.durationValue.value = this._formatDurationValue(seg.length);
          this.durationValue.disabled = false;
          this.durationValue.style.opacity = "1.0";
        }
      } else {
        this.promptInput.value = "";
        if (this._transferSetLeft) this._transferSetLeft("");
        this.promptInput.placeholder = t("No segment selected!");
        this.promptInput.disabled = true;
        this.promptInput.style.opacity = "0.4";
        this._setTransferVisible(false);
        this.strengthValue.value = "22";
        this.strengthValue.disabled = true;
        this.strengthValue.style.opacity = "0.35";
        if (this.durationValue) {
          this.durationValue.style.display = "inline-block";
          this.durationValue.value = "";
          this.durationValue.disabled = true;
          this.durationValue.style.opacity = "0.35";
        }
      }
    }

    // 片段级降噪开关状态回显（audio 轨段不可用；seg 存在才激活）
    if (this._syncDenoiseUI) this._syncDenoiseUI(seg && this.selectionType !== "audio" ? seg : null);

    if (this.segmentBoundsDisplay) {
      if (seg) {
        const startStr = this.formatTime(seg.start, true);
        const endStr = this.formatTime(seg.start + seg.length, true);
        const lengthStr = this.formatTime(seg.length, true);
        this.segmentBoundsDisplay.textContent = t("Start: {s} | End: {e} | Length: {l}", { s: startStr, e: endStr, l: lengthStr });
      } else {
        this.segmentBoundsDisplay.textContent = t("Start: - | End: - | Length: -");
      }
    }

    if (this._transferSetSeg) this._transferSetSeg(seg);
  },

  // ---------- 片段级降噪（seg.denoise）UI ----------
  _ensureDenoiseObj(seg) {
    if (!seg || typeof seg !== "object") return null;
    if (!seg.denoise || typeof seg.denoise !== "object" || Array.isArray(seg.denoise)) {
      seg.denoise = { enabled: false, alpha: 0.45, alpha_end: 0.10, ramp: 3, seed: 0 };
    }
    return seg.denoise;
  },

  _setDenoiseParamEnabled(enabled) {
    if (!this.alphaValue) return;
    [this.alphaValue, this.alphaEndValue, this.rampValue, this.seedValue].forEach((inp) => {
      inp.disabled = !enabled;
      inp.style.opacity = enabled ? "1.0" : "0.35";
    });
  },

  _syncDenoiseUI(seg) {
    const group = this.denoiseGroup;
    if (!group) return;
    const active = !!seg && this.selectionType !== "audio";
    group.style.display = active ? "flex" : "none";
    if (!active) {
      // 切到不可用状态（未选中 / audio 轨段）时顺带收起浮动参数面板
      if (this._dismissDenoisePanel) this._dismissDenoisePanel();
      return;
    }
    const d = (seg.denoise && typeof seg.denoise === "object" && !Array.isArray(seg.denoise))
      ? seg.denoise : null;
    const enabled = !!(d && d.enabled);
    this.denoiseToggle.checked = enabled;
    this._setDenoiseParamEnabled(enabled);
    const v = d || { enabled: false, alpha: 0.45, alpha_end: 0.10, ramp: 3, seed: 0 };
    this.alphaValue.value = v.alpha ?? 0.45;
    this.alphaEndValue.value = v.alpha_end ?? 0.10;
    this.rampValue.value = v.ramp ?? 3;
    this.seedValue.value = v.seed ?? 0;
    if (this.denoiseParamsToggle) {
      this.denoiseParamsToggle.style.opacity = enabled ? "1.0" : "0.6";
    }
  },

  updateSidebarHeights() {
    if (this.mainTrackLabel) {
      this.mainTrackLabel.style.height = `${this.blockHeight}px`;
      this.audioTrackLabel.style.height = `${this.audioTrackHeight}px`;
    }
  },

  // display_mode 决定 duration 输入/显示单位："frames" 帧（整数）| 其他为 "seconds" 秒（两位小数）
  _durationDisplayMode() {
    return this.displayModeWidget && this.displayModeWidget.value === "frames" ? "frames" : "seconds";
  },

  _formatDurationValue(frames) {
    if (this._durationDisplayMode() === "frames") return String(Math.round(frames));
    return (frames / this.getFrameRate()).toFixed(2);
  },

  // Duration 输入应用：解析输入（帧或秒）→ 帧，钳制到 [MIN_SEGMENT_LENGTH, 源可用帧]，失焦/回车/change 时调用
  _applyDurationInput() {
    const input = this.durationValue;
    if (!input || input.disabled) return;

    // 解析当前选中段（与 updateUIFromSelection 相同逻辑，含 preview/ghostTrack 场景）
    let seg = null;
    let trackArr = null;
    if (this.selectedIndex >= 0) {
      if (this.selectionType === "audio") {
        const origSeg = this.timeline.audioSegments[this.selectedIndex];
        if (origSeg) {
          const previewIsAudio = this._ghostTrack === 'audio' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
          trackArr = (this._previewSegments && previewIsAudio) ? this._previewSegments : this.timeline.audioSegments;
          seg = trackArr.find(s => s.id === origSeg.id) || origSeg;
        }
      } else {
        const origSeg = this.timeline.segments[this.selectedIndex];
        if (origSeg) {
          const previewIsImage = this._ghostTrack === 'image' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'image');
          trackArr = (this._previewSegments && previewIsImage) ? this._previewSegments : this.timeline.segments;
          seg = trackArr.find(s => s.id === origSeg.id) || origSeg;
        }
      }
    }
    if (!seg) return;

    const fps = this.getFrameRate();
    const mode = this._durationDisplayMode();
    const raw = mode === "frames" ? parseInt(input.value, 10) : parseFloat(input.value);
    if (!isFinite(raw) || raw <= 0) {
      // 非法输入：回显当前实际时长
      input.value = this._formatDurationValue(seg.length);
      return;
    }

    let frames = mode === "frames" ? raw : Math.round(raw * fps);
    frames = Math.max(MIN_SEGMENT_LENGTH, frames);
    // 非静态图段：钳制到源素材可用帧（与拖拽右边框逻辑一致）
    if (this.selectionType === "audio" || seg.type === "video") {
      const origDur = seg.audioDurationFrames || seg.videoDurationFrames || seg.length;
      frames = Math.min(frames, Math.max(MIN_SEGMENT_LENGTH, origDur - (seg.trimStart || 0)));
    }

    const oldLen = seg.length;
    let delta = frames - oldLen;

    // 长度变化后顺移后续段的起始位置，避免变长时覆盖下一个 segment。
    // 输入多少秒就是多少秒：变长不受总时长（End）钳制，后续段全部顺移；若顺移后
    // 任一段超出当前总时长，自动扩展总时长（growTimelineIfNeeded，与 gap 补段 /
    // 添加素材行为一致）。commitChanges 会按总时长裁剪段——若不扩展，输入的超长
    // 部分会在落盘时被静默截断，因此这里扩展总时长而非钳制输入值。
    const idx = trackArr.findIndex((s) => s.id === seg.id);
    if (idx >= 0) {
      for (let j = idx + 1; j < trackArr.length; j++) {
        trackArr[j].start += delta;
      }
      frames = oldLen + delta;

      if (delta > 0) {
        let maxEnd = 0;
        for (const s of this.timeline.segments) {
          maxEnd = Math.max(maxEnd, s.start + s.length);
        }
        for (const s of this.timeline.audioSegments) {
          maxEnd = Math.max(maxEnd, s.start + s.length);
        }
        // preview/ghost 场景下 trackArr 是临时预览数组，顺移后的临时段也需计入
        if (trackArr !== this.timeline.segments && trackArr !== this.timeline.audioSegments) {
          for (const s of trackArr) {
            maxEnd = Math.max(maxEnd, s.start + s.length);
          }
        }
        this.growTimelineIfNeeded(maxEnd);
      }
    }

    seg.length = frames;
    input.value = this._formatDurationValue(frames);

    if (this.segmentBoundsDisplay) {
      const startStr = this.formatTime(seg.start, true);
      const endStr = this.formatTime(seg.start + seg.length, true);
      const lengthStr = this.formatTime(seg.length, true);
      this.segmentBoundsDisplay.textContent = t("Start: {s} | End: {e} | Length: {l}", { s: startStr, e: endStr, l: lengthStr });
    }
    this.commitChanges(true);
    this.render();
  },

  // ================= 多选模式（checkbox 式不连续多选） =================
  // 进入/退出由右键菜单「多选」触发；勾选直接读写 selectedSegmentIds
  //（含 _v/_a 音频兄弟 id），从而复用既有的多选删除 / Mark Selection 逻辑。

  enterMultiSelectMode() {
    this._multiMode = true;
    this.selectedSegmentIds = [];
    this.updateUIFromSelection();
    this.render();
  },

  exitMultiSelectMode() {
    this._multiMode = false;
    this.selectedSegmentIds = [];
    this.updateUIFromSelection();
    this.render();
  },

  // 勾选/取消一个段（自动带音频兄弟段）
  toggleCheckedSegment(segId) {
    if (!segId) return;
    const ids = this.selectedSegmentIds;
    const sibId = segId.endsWith("_v") ? segId.slice(0, -2) + "_a"
      : (segId.endsWith("_a") ? segId.slice(0, -2) + "_v" : null);
    if (ids.includes(segId)) {
      this.selectedSegmentIds = ids.filter(id => id !== segId && id !== sibId);
    } else {
      ids.push(segId);
      if (sibId && !ids.includes(sibId)) ids.push(sibId);
    }
    this.updateUIFromSelection();
    this.render();
  },

  // 全选：勾选主轨全部段（含视频段音频兄弟），并把跨度写入全局参数
  selectAllSegments() {
    if (!this._multiMode) return;
    const ids = [];
    for (const seg of this.timeline.segments) {
      ids.push(seg.id);
      if (seg.id.endsWith("_v")) {
        const sibId = seg.id.slice(0, -2) + "_a";
        if (this.timeline.audioSegments.some(s => s.id === sibId)) ids.push(sibId);
      }
    }
    this.selectedSegmentIds = ids;
    // markCurrentSelection：选区跨度（min start → max end）写入秒/帧两套全局 widget
    this.markCurrentSelection();
    this.updateUIFromSelection();
    this.render();
  },

  // 全不选：清空勾选，全局参数改用单个选中段的边界
  deselectAllSegments() {
    if (!this._multiMode) return;
    // 先取当前单选段（清空后 selectedIndex 会被重置）
    let seg = null;
    if (this.selectedIndex >= 0) {
      seg = this.selectionType === "audio"
        ? this.timeline.audioSegments[this.selectedIndex]
        : this.timeline.segments[this.selectedIndex];
    }
    this.selectedSegmentIds = [];
    if (seg) this.markSegment(seg);
    this.updateUIFromSelection();
    this.render();
  },

  // 批量删除勾选段（二次确认；>1 段走 deleteSelectedSegment 多选分支，
  // 仅勾选 1 段时直接按 id 删除（含音频兄弟级联），避免 selectedIndex 未定位导致无效）
  deleteCheckedSegments() {
    const baseIds = new Set(this.selectedSegmentIds.map(id => String(id).replace(/_(v|a)$/, "")));
    const n = baseIds.size;
    if (!n) return;
    if (!window.confirm(t("Delete {n} selected segment(s)?", { n }))) return;
    if (!this.isMultiSelectActive()) {
      const id = this.selectedSegmentIds[0];
      const isAud = id.endsWith("_a");
      const sibId = id.endsWith("_v") ? id.slice(0, -2) + "_a"
        : (id.endsWith("_a") ? id.slice(0, -2) + "_v" : null);
      const arr = isAud ? this.timeline.audioSegments : this.timeline.segments;
      const idx = arr.findIndex(s => s.id === id);
      if (idx !== -1) arr.splice(idx, 1);
      if (sibId) {
        const sibArr = isAud ? this.timeline.segments : this.timeline.audioSegments;
        const sIdx = sibArr.findIndex(s => s.id === sibId);
        if (sIdx !== -1) sibArr.splice(sIdx, 1);
      }
      this.selectedSegmentIds = [];
      this.updateUIFromSelection();
      this.commitChanges();
      this.render();
      return;
    }
    this.deleteSelectedSegment();
  },

  // 命中检测：段左下角 checkbox 小方块
  _hitSegmentCheckbox(x, y) {
    const CB = 13, M = 4;
    const logicalWidth = this.canvas.offsetWidth || 1;
    const totalFrames = this.getVisualDurationFrames();
    const toPx = (f) => (f / totalFrames) * logicalWidth;
    const hit = (seg, yBottom) => {
      const x1 = toPx(seg.start) + M;
      const y1 = yBottom - CB - M;
      return x >= x1 && x <= x1 + CB && y >= y1 && y <= y1 + CB;
    };
    const imgBottom = RULER_HEIGHT + this.blockHeight;
    if (y >= RULER_HEIGHT && y <= imgBottom) {
      for (const seg of this.timeline.segments) if (hit(seg, imgBottom)) return seg.id;
    }
    if ((this.audioTrackHeight || 0) > 0) {
      const audBottom = imgBottom + this.audioTrackHeight;
      if (y > imgBottom && y <= audBottom) {
        for (const seg of this.timeline.audioSegments) if (hit(seg, audBottom)) return seg.id;
      }
    }
    return null;
  },

  // canvas 绘制各段左下角 checkbox（render() 末段调用）
  _drawSegmentCheckboxes(ctx, width, totalFrames) {
    const CB = 13, M = 4;
    const toPx = (f) => (f / totalFrames) * width;
    const draw = (seg, yBottom) => {
      const x1 = toPx(seg.start) + M;
      const y1 = yBottom - CB - M;
      if (x1 + CB < 0 || x1 > width) return;
      const on = this.selectedSegmentIds.includes(seg.id);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x1, y1, CB, CB, 3);
      ctx.fillStyle = on ? "#6c5ce7" : "rgba(20,22,30,0.85)";
      ctx.fill();
      ctx.strokeStyle = on ? "#a78bfa" : "#666";
      ctx.lineWidth = 1;
      ctx.stroke();
      if (on) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(x1 + 3, y1 + CB / 2);
        ctx.lineTo(x1 + CB / 2 - 0.5, y1 + CB - 3.5);
        ctx.lineTo(x1 + CB - 3, y1 + 3);
        ctx.stroke();
      }
      ctx.restore();
    };
    const imgBottom = RULER_HEIGHT + this.blockHeight;
    for (const seg of this.timeline.segments) draw(seg, imgBottom);
    if ((this.audioTrackHeight || 0) > 0) {
      const audBottom = imgBottom + this.audioTrackHeight;
      for (const seg of this.timeline.audioSegments) draw(seg, audBottom);
    }
  },

  // 顶部/底部覆盖条（dom.js 创建 timelineWrap 后调用 _buildMultiBars）
  _buildMultiBars() {
    const mkBar = (pos) => {
      const bar = document.createElement("div");
      bar.style.position = "absolute";
      bar.style.left = "8px";
      bar.style.right = "8px";
      bar.style[pos] = "6px";
      bar.style.display = "none";
      bar.style.alignItems = "center";
      bar.style.gap = "8px";
      bar.style.padding = "4px 10px";
      bar.style.background = "rgba(20,22,30,0.92)";
      bar.style.border = "1px solid #333";
      bar.style.borderRadius = "6px";
      bar.style.zIndex = "5";
      bar.style.fontSize = "11px";
      bar.style.color = "#ddd";
      bar.style.boxSizing = "border-box";
      bar.style.pointerEvents = "auto";
      return bar;
    };
    const mkBtn = (label, onClick, color) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.background = "#2a2f3d";
      b.style.color = color || "#ddd";
      b.style.border = "1px solid #3a4152";
      b.style.borderRadius = "4px";
      b.style.padding = "3px 10px";
      b.style.fontSize = "11px";
      b.style.cursor = "pointer";
      b.onclick = onClick;
      return b;
    };
    // 顶部条：计数 + 右上角退出图标按钮
    this.multiTopbar = mkBar("top");
    this.multiTopbar.style.justifyContent = "space-between";
    this._multiCountEl = document.createElement("span");
    const exitBtn = document.createElement("button");
    exitBtn.textContent = "✕";
    exitBtn.title = t("Exit Multi-Select");
    exitBtn.style.background = "transparent";
    exitBtn.style.border = "none";
    exitBtn.style.color = "#aaa";
    exitBtn.style.fontSize = "13px";
    exitBtn.style.cursor = "pointer";
    exitBtn.style.padding = "0 2px";
    exitBtn.onclick = () => this.exitMultiSelectMode();
    this.multiTopbar.appendChild(this._multiCountEl);
    this.multiTopbar.appendChild(exitBtn);
    // 底部条：全选 / 全不选 / 删除
    this.multiBottombar = mkBar("bottom");
    this.multiBottombar.style.justifyContent = "flex-start";
    this.multiBottombar.appendChild(mkBtn(t("Select All"), () => this.selectAllSegments(), "#a78bfa"));
    this.multiBottombar.appendChild(mkBtn(t("Deselect All"), () => this.deselectAllSegments()));
    this.multiBottombar.appendChild(mkBtn(t("Delete"), () => this.deleteCheckedSegments(), "#ff6b6b"));
    this.timelineWrap.appendChild(this.multiTopbar);
    this.timelineWrap.appendChild(this.multiBottombar);
  },

  // 依据 _multiMode / 勾选数刷新覆盖条（updateUIFromSelection 内自动调用）
  _updateMultiBars() {
    if (!this.multiTopbar || !this._multiCountEl) return;
    const on = !!this._multiMode;
    this.multiTopbar.style.display = on ? "flex" : "none";
    this.multiBottombar.style.display = on ? "flex" : "none";
    if (!on) return;
    const total = this.timeline.segments.length;
    const sel = new Set(this.selectedSegmentIds.map(id => String(id).replace(/_(v|a)$/, ""))).size;
    this._multiCountEl.textContent = t("Selected {n}/{m} segments", { n: sel, m: total });
  },
};
