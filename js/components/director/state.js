// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: updateSelectionFromBox, syncSelectionTypeAndIndex, growTimelineIfNeeded, getMaxZoom, getVisualDurationFrames, updateZoomSliderMax, updateUIFromSelection, updateSidebarHeights
import { AUDIO_TRACK_HEIGHT, BLOCK_HEIGHT, RULER_HEIGHT, MIN_SEGMENT_LENGTH, app } from "./shared.js";

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
    if (this.selectedSegmentIds && this.isMultiSelectActive()) {
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      if (this.promptInput) {
        this.promptInput.value = "";
        this.promptInput.placeholder = "(Multiple Segments Selected)";
        this.promptInput.disabled = true;
        this.promptInput.style.opacity = "0.35";
        if (this._transferSetLeft) this._transferSetLeft("");
      }

      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = "Segment Prompt";
      }

      if (this.strengthRow) this.strengthRow.style.display = "flex";
      if (this.strengthLabel) this.strengthLabel.style.display = "inline";
      if (this.strengthValue) {
        this.strengthValue.style.display = "inline-block";
        this.strengthValue.value = "";
        this.strengthValue.placeholder = "(Multiple)";
        this.strengthValue.disabled = true;
        this.strengthValue.style.opacity = "0.35";
      }

      if (this.durationValue) {
        this.durationValue.style.display = "inline-block";
        this.durationValue.value = "";
        this.durationValue.placeholder = "(Multiple)";
        this.durationValue.disabled = true;
        this.durationValue.style.opacity = "0.35";
      }

      if (this.audioInfoArea) this.audioInfoArea.style.display = "none";

      if (this.segmentBoundsDisplay) {
        this.segmentBoundsDisplay.textContent = "Multiple Segments Selected";
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
      this.strengthLabel.textContent = "Guide Strength:";
      this.strengthValue.style.display = "inline-block";
      this.audioInfoArea.style.display = "block";
      this.audioInfoArea.innerHTML = `
        File: <span>${seg.fileName || "Unknown"}</span><br>
        Length: <span>${this.formatTime(seg.audioDurationFrames)}</span> Output Length: <span>${this.formatTime(seg.length)}</span><br>
        Trim-in: <span>${this.formatTime(Math.round(seg.trimStart))}</span> Trim-Out: <span>${this.formatTime(Math.round(seg.audioDurationFrames - (seg.trimStart + seg.length)))}</span>
      `;
      this.strengthValue.value = "39";
      this.strengthValue.disabled = true;
      if (this.durationValue) {
        this.durationValue.style.display = "inline-block";
        this.durationValue.value = this._formatDurationValue(seg.length);
        this.durationValue.disabled = true;
        this.durationValue.style.opacity = "0.35";
      }
    } else {
      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = "Segment Prompt";
      }
      this.audioInfoArea.style.display = "none";
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "inline";
      this.strengthLabel.textContent = "Guide Strength:";
      this.strengthValue.style.display = "inline-block";

      if (seg) {
        this.promptInput.value = seg.prompt || "";
        if (this._transferSetLeft) this._transferSetLeft(this.promptInput.value);
        this.promptInput.placeholder = "Enter prompt for selected segment...";
        this.promptInput.disabled = false;
        this.promptInput.style.opacity = "1.0";
        this._setTransferVisible(true);

        const strength = (seg.guideStrength ?? 39);
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
        this.promptInput.placeholder = "No segment selected!";
        this.promptInput.disabled = true;
        this.promptInput.style.opacity = "0.4";
        this._setTransferVisible(false);
        this.strengthValue.value = "39";
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

    if (this.segmentBoundsDisplay) {
      if (seg) {
        const startStr = this.formatTime(seg.start, true);
        const endStr = this.formatTime(seg.start + seg.length, true);
        const lengthStr = this.formatTime(seg.length, true);
        this.segmentBoundsDisplay.textContent = `Start: ${startStr} | End: ${endStr} | Length: ${lengthStr}`;
      } else {
        this.segmentBoundsDisplay.textContent = "Start: - | End: - | Length: -";
      }
    }

    if (this._transferSetSeg) this._transferSetSeg(seg);
  }
,

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
    // 顺移不能把后续段挤出总时长：后端会把超出范围段 clamp 成 0 帧直接跳过
    // （director.py dur<=0 continue），即下一段 duration_frames 变成 0，不允许。
    // 因此变长时按“每段至少保留 MIN_SEGMENT_LENGTH 帧”约束截断顺移量，
    // 空间不足则当前段按最大可顺移量应用（与拖拽右边框 clamp 语义一致）。
    const idx = trackArr.findIndex((s) => s.id === seg.id);
    if (idx >= 0) {
      if (delta > 0) {
        const totalDur = this.getDurationFrames() || 0;
        if (totalDur > 0) {
          let maxDelta = delta;
          for (let j = idx + 1; j < trackArr.length; j++) {
            const s = trackArr[j];
            // 顺移后该段 start 最多到 totalDur - MIN_SEGMENT_LENGTH（保留最小帧）
            const room = totalDur - MIN_SEGMENT_LENGTH - s.start;
            if (room < maxDelta) maxDelta = Math.max(0, room);
          }
          delta = Math.min(delta, maxDelta);
        }
      }
      for (let j = idx + 1; j < trackArr.length; j++) {
        trackArr[j].start += delta;
      }
      frames = oldLen + delta;
    }

    seg.length = frames;
    input.value = this._formatDurationValue(frames);

    if (this.segmentBoundsDisplay) {
      const startStr = this.formatTime(seg.start, true);
      const endStr = this.formatTime(seg.start + seg.length, true);
      const lengthStr = this.formatTime(seg.length, true);
      this.segmentBoundsDisplay.textContent = `Start: ${startStr} | End: ${endStr} | Length: ${lengthStr}`;
    }
    this.commitChanges(true);
    this.render();
  }
};
