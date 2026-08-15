// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: updateSelectionFromBox, syncSelectionTypeAndIndex, growTimelineIfNeeded, syncWidgetsToRetakeDuration, getMaxZoom, getVisualDurationFrames, updateZoomSliderMax, getGlobalPrompt, syncGlobalPrompt, updateUIFromSelection, updateRetakeUIState, updateSidebarHeights
import { AUDIO_TRACK_HEIGHT, BLOCK_HEIGHT, RULER_HEIGHT, app } from "./shared.js";

export const state = {
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
  },

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
  },

  growTimelineIfNeeded(requiredFrames) {
    const current = this.getDurationFrames();
    if (requiredFrames <= current) return; // already big enough

    const newFrames = Math.ceil(requiredFrames);
    if (this.durationFramesWidget) {
      this.durationFramesWidget.value = newFrames;
    }
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.value = parseFloat((newFrames / this.getFrameRate()).toFixed(3));
    }
    // Notify ComfyUI that the widget value changed so it serialises correctly.
    if (window.app && window.app.graph) {
      window.app.graph.setDirtyCanvas(true, true);
    }
  },

  syncWidgetsToRetakeDuration(durationFrames) {
    if (durationFrames <= 0) return;
    const rate = this.getFrameRate();
    const durationSeconds = parseFloat((durationFrames / rate).toFixed(3));

    const wasSuppressing = this._suppressCommit;
    this._suppressCommit = true;

    if (this.startFramesWidget) {
      this.startFramesWidget.value = 0;
      if (this.startFramesWidget.callback) {
        try { this.startFramesWidget.callback(0); } catch (_) {}
      }
    }
    if (this.startSecondsWidget) {
      this.startSecondsWidget.value = 0;
    }

    if (this.durationFramesWidget) {
      this.durationFramesWidget.value = durationFrames;
      if (this.durationFramesWidget.callback) {
        try { this.durationFramesWidget.callback(durationFrames); } catch (_) {}
      }
    }
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.value = durationSeconds;
    }

    if (this.endFramesWidget) {
      this.endFramesWidget.value = durationFrames;
    }
    if (this.endSecondsWidget) {
      this.endSecondsWidget.value = durationSeconds;
    }

    this._suppressCommit = wasSuppressing;
  },

  getMaxZoom() {
    const visualDurationSecs = this.getVisualDurationFrames() / this.getFrameRate();
    const baseMaxZoom = Math.max(1, visualDurationSecs / 4);

    // Limit max zoom to prevent canvas width from exceeding browser limits (causing crash)
    const viewportWidth = this.viewport ? this.viewport.clientWidth : 1000;
    const MAX_CANVAS_WIDTH = 32768; // Extended limit for modern browsers
    const limitMaxZoom = MAX_CANVAS_WIDTH / Math.max(1, viewportWidth);

    return Math.max(1, Math.min(baseMaxZoom, limitMaxZoom));
  },

  getVisualDurationFrames() {
    if (this.retakeMode) {
      if (this.timeline.retakeVideo) {
        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 0;
        // Add 15% visual buffer duration on the right to prevent the video segment
        // from being cut off by the DOM clipping (right ~9% of the viewport is clipped by ComfyUI).
        return Math.max(24, Math.ceil(baseVideoDur * 1.15));
      } else {
        return 24;
      }
    }

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
  },

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
  },

  getGlobalPrompt() {
    if (this.globalPromptInput) {
      return this.globalPromptInput.value || "";
    }
    let val = "";
    if (this.node) {
      const globalInput = this.node.inputs?.find(i => i.name === "global_prompt");
      if (globalInput && globalInput.link !== null && globalInput.link !== undefined) {
        const link = window.app.graph?.links?.[globalInput.link];
        if (link) {
          const originNode = window.app.graph.getNodeById(link.origin_id);
          if (originNode && originNode.widgets && originNode.widgets.length > 0) {
            val = originNode.widgets[0].value || "";
          }
        }
      } else {
        const w = this.node.widgets?.find(x => x.name === "global_prompt");
        if (w) {
          val = w.value || "";
        } else {
          val = this.node.properties?.global_prompt || "";
        }
      }
    }
    return val;
  },

  syncGlobalPrompt(val) {
    if (this.node.properties) {
      this.node.properties.global_prompt = val;
    }
    if (this.retakeMode) {
      this.timeline.retake_global_prompt = val;
    } else {
      this.timeline.global_prompt = val;
    }
    const globalInput = this.node.inputs?.find(i => i.name === "global_prompt");
    let synced = false;
    if (globalInput && globalInput.link !== null && globalInput.link !== undefined) {
      const link = window.app.graph?.links?.[globalInput.link];
      if (link) {
        const originNode = window.app.graph.getNodeById(link.origin_id);
        if (originNode && originNode.widgets && originNode.widgets.length > 0) {
          const w = originNode.widgets[0];
          const oldVal = w.value;
          w.value = val;
          if (originNode.onWidgetChanged) {
            originNode.onWidgetChanged(w.name, val, oldVal, w);
          }
          if (w.callback) {
            try {
              originNode.widgets[0].callback(val);
            } catch (err) { }
          }
          synced = true;
        }
      }
    }
    if (!synced) {
      const w = this.node.widgets?.find(x => x.name === "global_prompt");
      if (w) {
        const oldVal = w.value;
        w.value = val;
        if (this.node.onWidgetChanged) {
          this.node.onWidgetChanged(w.name, val, oldVal, w);
        }
        if (w.callback) {
          try {
            w.callback(val);
          } catch (err) { }
        }
      }
    }
    if (this.globalPromptInput && this.globalPromptInput.value !== val) {
      this.globalPromptInput.value = val;
    }
    if (this.node) {
      this.node.setDirtyCanvas(true, false);
    }
    if (window.app?.graph) {
      if (window.app.graph.change) window.app.graph.change();
      if (window.app.graph.onNodeChanged) window.app.graph.onNodeChanged(this.node);
      if (window.app.graph.onStateChanged) window.app.graph.onStateChanged();
    }
  },

  updateUIFromSelection() {
    if (this.selectedSegmentIds && this.isMultiSelectActive()) {
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = true;
        this.globalPromptInput.style.opacity = "0.35";
      }
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

      if (this.audioInfoArea) this.audioInfoArea.style.display = "none";

      if (this.segmentBoundsDisplay) {
        this.segmentBoundsDisplay.textContent = "Multiple Segments Selected";
      }
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
    if (this.promptInput) {
      this.promptInput.placeholder = "";
      this.promptInput.style.opacity = "";
    }

    if (this.retakeMode) {
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      this.promptInput.disabled = false;
      this.promptInput.style.opacity = "1.0";
      this.promptInput.placeholder = "Enter prompt for retake region...";
      this.promptInput.value = this.timeline.retakePrompt || "";
      if (this._transferSetLeft) this._transferSetLeft(this.promptInput.value);

      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "inline";
      this.strengthLabel.textContent = "Guide Strength:";
      this.strengthValue.style.display = "inline-block";
      this.strengthValue.disabled = true;
      this.strengthValue.style.opacity = "0.35";
      this.strengthValue.value = (this.timeline.retakeStrength ?? 1.0).toFixed(2);

      this.audioInfoArea.style.display = "none";

      if (this.segmentBoundsDisplay) {
        const startStr = this.formatTime(this.timeline.retakeStart, true);
        const endStr = this.formatTime(this.timeline.retakeStart + this.timeline.retakeLength, true);
        const lengthStr = this.formatTime(this.timeline.retakeLength, true);
        this.segmentBoundsDisplay.textContent = `Start: ${startStr} | End: ${endStr} | Length: ${lengthStr}`;
      }
    } else if (this.selectionType === "audio" && seg) {
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = false;
        this.globalPromptInput.style.opacity = "1.0";
      }
      if (this.promptWrapper) this.promptWrapper.style.display = "none";
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
      this.strengthValue.value = "1.00";
      this.strengthValue.disabled = true;
    } else {
      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = "Segment Prompt";
      }
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = false;
        this.globalPromptInput.style.opacity = "1.0";
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

        const isImage = (this.selectionType === "image") && (seg.type === "image" || seg.type === "video");
        const strength = isImage ? (seg.guideStrength ?? 1.0) : 1.0;
        this.strengthValue.value = strength.toFixed(2);
        this.strengthValue.disabled = !isImage;
        this.strengthValue.style.opacity = isImage ? "1.0" : "0.35";
      } else {
        this.promptInput.value = "";
        if (this._transferSetLeft) this._transferSetLeft("");
        this.promptInput.placeholder = "No segment selected!";
        this.promptInput.disabled = true;
        this.promptInput.style.opacity = "0.4";
        this.strengthValue.value = "1.00";
        this.strengthValue.disabled = true;
        this.strengthValue.style.opacity = "0.35";
      }
    }

    if (this.segmentBoundsDisplay && !this.retakeMode) {
      if (seg) {
        const startStr = this.formatTime(seg.start, true);
        const endStr = this.formatTime(seg.start + seg.length, true);
        const lengthStr = this.formatTime(seg.length, true);
        this.segmentBoundsDisplay.textContent = `Start: ${startStr} | End: ${endStr} | Length: ${lengthStr}`;
      } else {
        this.segmentBoundsDisplay.textContent = "Start: - | End: - | Length: -";
      }
    }
  },

  updateRetakeUIState() {
    const isRetake = this.retakeMode;

    if (this.globalPromptInput) {
      const p = isRetake ? (this.timeline.retake_global_prompt || "") : (this.timeline.global_prompt || "");
      if (this.globalPromptInput.value !== p) {
        this.globalPromptInput.value = p;
        this.syncGlobalPrompt(p);
      }
    }

    // 1. Set track heights
    if (isRetake) {
      if (this.blockHeight > 0 && this.audioTrackHeight > 0) {
        this._oldBlockHeight = this.blockHeight;
        this._oldAudioTrackHeight = this.audioTrackHeight;
      }
      this.blockHeight = this.canvasHeight - this.rulerHeight;
      this.audioTrackHeight = 0;
      // In retake mode, uploadVideoBtn stays as "Add Video" (same as normal mode)
      if (this.mainTrackLabel) {
        const textSpan = this.mainTrackLabel.querySelector("span");
        if (textSpan) textSpan.textContent = "VIDEO";
        if (this.mainTrackLabel._eyeBtn) this.mainTrackLabel._eyeBtn.style.display = "none";
        this.mainTrackLabel.style.backgroundColor = "#1e1e1e";
        this.audioTrackLabel.style.display = "none";
      }
      if (this.sidebar) this.sidebar.style.backgroundColor = "#1e1e1e";
      if (this.rulerSpacer) this.rulerSpacer.style.backgroundColor = "#1e1e1e";
    } else {
      this.blockHeight = this._oldBlockHeight ?? BLOCK_HEIGHT;
      this.audioTrackHeight = this._oldAudioTrackHeight ?? AUDIO_TRACK_HEIGHT;
      if (this.uploadVideoBtn) {
        this.uploadVideoBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Add Video`;
      }
      if (this.mainTrackLabel) {
        const textSpan = this.mainTrackLabel.querySelector("span");
        if (textSpan) textSpan.textContent = "MAIN";
        if (this.mainTrackLabel._eyeBtn) this.mainTrackLabel._eyeBtn.style.display = "inline-flex";
        this.mainTrackLabel.style.backgroundColor = "#1e1e1e";
        this.audioTrackLabel.style.display = "flex";
      }
      if (this.sidebar) this.sidebar.style.backgroundColor = "#1e1e1e";
      if (this.rulerSpacer) this.rulerSpacer.style.backgroundColor = "#1e1e1e";
    }

    this.updateSidebarHeights();

    // Reset zoom to fit viewport when entering retake mode so full video is visible
    if (isRetake) {
      this.zoomLevel = 1;
      if (this.zoomSlider) this.zoomSlider.value = 1;
      this.updateZoomSliderMax();
      const vw = this.viewport ? this.viewport.clientWidth : 0;
      if (vw > 0) {
        this.resizeCanvas(vw);
        this._lastWidth = vw;
        this._lastZoom = 1;
        if (this.viewport) this.viewport.scrollLeft = 0;
      }
    }

    // 2. Hide/show toolbar action buttons
    if (this.uploadBtn) this.uploadBtn.style.display = isRetake ? "none" : "";
    if (this.addTextBtn) this.addTextBtn.style.display = isRetake ? "none" : "";
    if (this.uploadAudioBtn) this.uploadAudioBtn.style.display = isRetake ? "none" : "";
    if (this.deleteBtn) this.deleteBtn.style.display = isRetake ? "none" : "";
    // deleteRetakeBtn is visible whenever Retake Mode is active
    if (this.deleteRetakeBtn) {
      this.deleteRetakeBtn.style.display = isRetake ? "" : "none";
    }

    // 3. Update the toggle button class/title
    if (this.updateRetakeStyle) this.updateRetakeStyle();

    // 4. Update the prompt labels
    if (this.segmentPromptLabel) {
      this.segmentPromptLabel.textContent = isRetake ? "Retake Prompt" : "Local Prompt";
    }

    // 5. Update UI selection inputs
    this.updateUIFromSelection();
  },

  updateSidebarHeights() {
    if (this.mainTrackLabel) {
      this.mainTrackLabel.style.height = `${this.blockHeight}px`;
      this.audioTrackLabel.style.height = `${this.audioTrackHeight}px`;
    }
  }
};
