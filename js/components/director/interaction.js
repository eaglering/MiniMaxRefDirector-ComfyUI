// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: _liveScrubVideo, _liveScrubPlayhead, getSnappedPlayhead, getTrackFromY, getHitTest, onMouseDown, onMouseMove, _applyCenterDragPhysics, _resolveGlobalPhysics, _restoreTransientProperties, onMouseUp
import { HANDLE_HIT_PX, MIN_SEGMENT_LENGTH, RULER_HEIGHT, app, clamp } from "./shared.js";

export const interaction = {
  _liveScrubVideo(seg, edge) {
    if (!seg || seg.type !== "video") return;
    this._ensureVideoEl(seg);
    if (!seg.videoEl) return;
    const targetSec = edge === "end"
      ? ((seg.trimStart || 0) + seg.length) / this.getFrameRate()
      : (seg.trimStart || 0) / this.getFrameRate();

    seg._scrubTargetSec = targetSec;
  }
,

  _liveScrubPlayhead() {
    const targetFrame = this.currentFrame;
    const seg = this.timeline.segments.find(s => s.type === "video" && targetFrame >= s.start && targetFrame < s.start + s.length);
    if (seg) {
      this._ensureVideoEl(seg);
      if (seg.videoEl) {
        const targetSec = ((seg.trimStart || 0) + (targetFrame - seg.start)) / this.getFrameRate();
        seg._scrubTargetSec = targetSec;
      }
    }
  }
,

  getSnappedPlayhead(mouseFrameX, logicalWidth) {
    if (!this.isSnapping) return mouseFrameX;

    const totalFrames = this.getVisualDurationFrames();
    const thresholdFrames = (15 / logicalWidth) * totalFrames;
    const snapCandidates = [0, this.getDurationFrames()];

    // Add start and end frames of active generation range
    snapCandidates.push(this.getStartFrames());
    if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
      snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
    }

    const allTracks = [
      this.timeline.segments || [],
      this.timeline.audioSegments || []
    ];
    for (const track of allTracks) {
      for (const seg of track) {
        snapCandidates.push(seg.start);
        snapCandidates.push(seg.start + seg.length);
      }
    }

    let bestFrame = mouseFrameX;
    let minDiff = thresholdFrames;
    for (const candidate of snapCandidates) {
      const diff = Math.abs(mouseFrameX - candidate);
      if (diff < minDiff) {
        minDiff = diff;
        bestFrame = candidate;
      }
    }
    return bestFrame;
  }
,

  getTrackFromY(y) {
    if (y > RULER_HEIGHT + this.blockHeight) return "audio";
    return "image";
  }
,

  getHitTest(mouseX, mouseY) {
    const width = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();

    // Check Playhead Handle first
    const playheadX = (this.currentFrame / totalFrames) * width;
    if (mouseY <= 24 && Math.abs(mouseX - playheadX) <= 12) {
      return { type: "playhead" };
    }

    if (mouseY <= RULER_HEIGHT) {
      return { type: "ruler" };
    }

    if (mouseY < RULER_HEIGHT || mouseY > this.canvasHeight) return null;

    const trackType = this.getTrackFromY(mouseY);
    const trackSegments = this.getSegmentArray(trackType);

    if (trackSegments.length === 0) return null;

    // Helper to check if a segment (or its sibling video/audio counterpart) is uploading/decoding
    const isSegmentProcessing = (s) => {
      if (!s) return false;
      if (s._uploading || s._decoding) return true;
      const isVid = s.id?.endsWith("_v");
      const isAud = s.id?.endsWith("_a");
      if (isVid || isAud) {
        const siblingId = isVid ? s.id.slice(0, -2) + "_a" : s.id.slice(0, -2) + "_v";
        const siblingArray = isVid ? this.timeline.audioSegments : this.timeline.segments;
        const sibling = siblingArray.find(x => x.id === siblingId);
        if (sibling && (sibling._uploading || sibling._decoding)) {
          return true;
        }
      }
      return false;
    };

    // The variables width and totalFrames are already declared above.

    let sortedSegments = [...trackSegments]
      .map((s, i) => ({ ...s, originalIndex: i }))
      .sort((a, b) => a.start - b.start);

    const HANDLE_CORE = 4;

    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const endX = startX + pxWidth;

      const prevSeg = sortedSegments[i - 1];
      const nextSeg = sortedSegments[i + 1];

      const isLeftJoint = prevSeg && prevSeg.start + prevSeg.length === seg.start;
      if (!isLeftJoint) {
        if (Math.abs(mouseX - startX) <= HANDLE_HIT_PX) {
          if (!isSegmentProcessing(seg)) {
            return { type: "edge", index: seg.originalIndex, dir: "left", track: trackType };
          }
        }
      }

      const isRightJoint = nextSeg && nextSeg.start === seg.start + seg.length;
      if (isRightJoint) {
        const dx = mouseX - endX;
        if (Math.abs(dx) <= HANDLE_HIT_PX) {
          if (dx < -HANDLE_CORE) {
            if (!isSegmentProcessing(seg)) {
              return { type: "edge", index: seg.originalIndex, dir: "right", track: trackType };
            }
          } else if (dx > HANDLE_CORE) {
            if (!isSegmentProcessing(nextSeg)) {
              return { type: "edge", index: nextSeg.originalIndex, dir: "left", track: trackType };
            }
          } else {
            if (!isSegmentProcessing(seg) && !isSegmentProcessing(nextSeg)) {
              return { type: "joint", leftIndex: seg.originalIndex, rightIndex: nextSeg.originalIndex, track: trackType };
            }
          }
        }
      } else {
        if (Math.abs(mouseX - endX) <= HANDLE_HIT_PX) {
          if (!isSegmentProcessing(seg)) {
            return { type: "edge", index: seg.originalIndex, dir: "right", track: trackType };
          }
        }
      }
    }

    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const endX = startX + pxWidth;

      if (mouseX >= startX && mouseX < endX) {
        return { type: "center", index: seg.originalIndex, track: trackType };
      }
    }

    return null;
  }
,

  onMouseDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this.getMousePos(e);

    if (e.shiftKey) {
      this._isSelectingBox = true;
      this._isDragging = true;
      this._dragType = "box_select";
      this._selectBoxStart = { x, y };
      this._selectBoxCurrent = { x, y };
      this._selectBoxInitialSelectedIds = (e.ctrlKey || e.metaKey) ? [...this.selectedSegmentIds] : [];
      this.selectedSegmentIds = [...this._selectBoxInitialSelectedIds];
      this.syncSelectionTypeAndIndex();
      this.updateUIFromSelection();
      this.render();
      return;
    }

    // Canvas height and width resizing apply in both modes.
    const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
    const isAtBottom = Math.abs(y - visibleBottom) <= 15;
    if (isAtBottom) {
      this._isDragging = true;
      this._dragType = "height_resize";
      this._startBlockHeight = this.blockHeight;
      this._startY = y;
      document.body.style.userSelect = "none";
      return;
    }

    const viewRect = this.viewport.getBoundingClientRect();
    const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;
    if (isAtRightEdge) {
      this._isDragging = true;
      this._dragType = "width_resize";
      this._startNodeWidth = this.node.size[0];
      this._startX = e.clientX;
      document.body.style.userSelect = "none";
      return;
    }

    // Track height dividers only apply in normal timeline mode.
    const isOverDivider = Math.abs(y - (RULER_HEIGHT + this.blockHeight)) <= 8;
    if (isOverDivider) {
      this._isDragging = true;
      this._dragType = "divider";
      this._startBlockHeight = this.blockHeight;
      this._startAudioTrackHeight = this.audioTrackHeight;
      this._startY = y;
      return;
    }

    if (y >= RULER_HEIGHT && y <= this.canvasHeight) {
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const dx = x - gap.centerX, dy2 = y - gap.centerY;
        if (dx * dx + dy2 * dy2 <= BTN_R * BTN_R) {
          const currentTrack = gap.track;
          const hasCopied = this._copiedSegment || window._ltxCopiedSegment;
          const copiedTrack = this._copiedSegmentTrack || window._ltxCopiedSegmentType;
          const isCompatible = hasCopied && this.getCanonicalTrack(copiedTrack) === currentTrack;

          if (currentTrack === "audio" && !isCompatible) {
            this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
          } else {
            this.showGapMenu(e.clientX, e.clientY, gap);
          }
          return;
        }
      }
    }

    const isCtrl = e.ctrlKey || e.metaKey;
    const hit = this.getHitTest(x, y);
    if (!hit) {
      if (!isCtrl) {
        this.selectedSegmentIds = [];
        this.selectedIndex = -1;
        this.updateUIFromSelection();
      }
      this.render();
      return;
    }

    if (hit.type === "playhead" || hit.type === "ruler") {
      this._isDragging = true;
      this._dragType = "playhead";
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      let mouseFrameX = x * (totalFrames / logicalWidth);
      mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
      this.currentFrame = clamp(mouseFrameX, 0, totalFrames);
      this._liveScrubPlayhead();
      this.render();
      if (this.isPlaying) {
        this.playAudio();
      }
      return;
    }

    const clickedTrack = hit.track;
    const targetArray = this.getSegmentArray(clickedTrack);
    let clickedId = null;
    let clickedIdx = -1;
    if (hit.type === "joint") {
      clickedIdx = hit.leftIndex;
    } else {
      clickedIdx = hit.index;
    }
    if (clickedIdx !== -1 && targetArray[clickedIdx]) {
      clickedId = targetArray[clickedIdx].id;
    }

    if (clickedId) {
      if (isCtrl) {
        const sibId = clickedId.endsWith("_v") ? clickedId.slice(0, -2) + "_a" : (clickedId.endsWith("_a") ? clickedId.slice(0, -2) + "_v" : null);
        const isSelected = this.selectedSegmentIds.includes(clickedId);
        if (isSelected) {
          this.selectedSegmentIds = this.selectedSegmentIds.filter(id => id !== clickedId && id !== sibId);
        } else {
          if (!this.selectedSegmentIds.includes(clickedId)) this.selectedSegmentIds.push(clickedId);
          if (sibId && !this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
        }

        if (this.selectedSegmentIds.length > 0) {
          this.selectionType = clickedTrack;
          this.selectedIndex = clickedIdx;
        } else {
          this.selectedIndex = -1;
        }
        this._multiDragClickPendingDeselect = null;
      } else {
        if (this.selectedSegmentIds.includes(clickedId)) {
          this._multiDragClickPendingDeselect = clickedId;
        } else {
          this.selectedSegmentIds = [clickedId];
          const sibId = clickedId.endsWith("_v") ? clickedId.slice(0, -2) + "_a" : (clickedId.endsWith("_a") ? clickedId.slice(0, -2) + "_v" : null);
          if (sibId && !this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
          this.selectionType = clickedTrack;
          this.selectedIndex = clickedIdx;
          this._multiDragClickPendingDeselect = null;
        }
      }
    }

    this.updateUIFromSelection();

    if (this.isMultiSelectActive()) {
      this._isDragging = true;
      this._dragType = "center";
      this._dragStartX = x;
      this._isMultiDraggingAndMoved = false;
      this._multiDragInitialSegments = {
        image: this.timeline.segments.map(s => ({ ...s })),
        audio: this.timeline.audioSegments.map(s => ({ ...s }))
      };
      this._multiDragPreviewTimelines = null;
    } else {
      this.selectionType = hit.track;
      if (hit.type === "joint") {
        this.selectedIndex = hit.leftIndex;
        this._dragType = "joint";
        this._dragTargetId = targetArray[hit.leftIndex].id;
        this._dragTargetIdRight = targetArray[hit.rightIndex].id;
      } else if (hit.type === "center") {
        this.selectedIndex = hit.index;
        this._dragType = "center";
      } else {
        if (this.selectedIndex !== hit.index) {
          this.selectedIndex = hit.index;
        }
        this._dragType = hit.dir;
      }

      this._isDragging = true;
      this._previewSegments = null;
      this._previewSiblingSegments = null;
      this._dragStartX = x;
      this._dragInitialTimeline = targetArray.map(s => ({ ...s }));
      this._dragInitialSiblingTimeline = (this.selectionType === "audio" ? this.timeline.segments : this.timeline.audioSegments).map(s => ({ ...s }));

      if (hit.type !== "joint") {
        this._dragTargetId = targetArray[hit.index].id;
      }
    }

    if (this.isPlaying) {
      this.pauseAudio();
    }

    this.render();
  }
,

  onMouseMove(e) {
    const { x: mouseX, y: mouseY } = this.getMousePos(e);

    if (this._isSelectingBox && this._dragType === "box_select") {
      this.canvas.style.cursor = "crosshair";
      this._selectBoxCurrent = { x: mouseX, y: mouseY };
      this.updateSelectionFromBox();
      this.render();
      return;
    }

    if (!this._isDragging) {
      let newHoveredGapIdx = -1;
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const dx = mouseX - gap.centerX, dy2 = mouseY - gap.centerY;
        if (dx * dx + dy2 * dy2 <= BTN_R * BTN_R) { newHoveredGapIdx = i; break; }
      }
      if (this._hoveredGapIdx !== newHoveredGapIdx) {
        this._hoveredGapIdx = newHoveredGapIdx;
        this.render();
      }

      const isOverDivider = Math.abs(mouseY - (RULER_HEIGHT + this.blockHeight)) <= 8;
      const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
      const isAtBottom = Math.abs(mouseY - visibleBottom) <= 15;
      const viewRect = this.viewport.getBoundingClientRect();
      const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;
      const hit = this.getHitTest(mouseX, mouseY);
      if (isOverDivider || isAtBottom) {
        this.canvas.style.cursor = "ns-resize";
      } else if (isAtRightEdge) {
        this.canvas.style.cursor = "ew-resize";
      } else if (newHoveredGapIdx >= 0) {
        this.canvas.style.cursor = "pointer";
      } else if (hit?.type === "edge") {
        this.canvas.style.cursor = "ew-resize";
      } else if (hit?.type === "joint") {
        this.canvas.style.cursor = "col-resize";
      } else if (hit?.type === "center") {
        this.canvas.style.cursor = "grab";
      } else if (hit?.type === "playhead") {
        this.canvas.style.cursor = "ew-resize";
      } else {
        this.canvas.style.cursor = "default";
      }
      return;
    }

    if (this._dragType === "divider") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;

      const minBlockH = 50;
      const minAudioH = 50;

      let newBlockHeight = this._startBlockHeight + deltaY;
      let newAudioTrackHeight = this._startAudioTrackHeight - deltaY;

      if (newBlockHeight < minBlockH) {
        newBlockHeight = minBlockH;
        newAudioTrackHeight = this._startBlockHeight + this._startAudioTrackHeight - minBlockH;
      }
      if (newAudioTrackHeight < minAudioH) {
        newAudioTrackHeight = minAudioH;
        newBlockHeight = this._startBlockHeight + this._startAudioTrackHeight - minAudioH;
      }

      this.blockHeight = newBlockHeight;
      this.audioTrackHeight = newAudioTrackHeight;

      this.updateSidebarHeights();
      this.render();
      return;
    }

    // Sidebar track label 拖拽（AUDIO 轨高度拉伸）
    if (this._dragType === "audio_divider") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;
      const minH = 40;
      this.audioTrackHeight = Math.max(minH, (this._startAudioTrackHeight ?? this.audioTrackHeight) + deltaY);
      this.updateSidebarHeights();
      return;
    }

    if (this._dragType === "height_resize") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;

      this.blockHeight = Math.max(100, this._startBlockHeight + deltaY);
      this.canvasHeight = this.rulerHeight + this.blockHeight + this.audioTrackHeight;

      this.canvas.style.height = `${this.canvasHeight}px`;

      this.resizeCanvas(this.canvas.offsetWidth);
      this.updateSidebarHeights();
      this.render();

      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (window.app && window.app.graph) {
          window.app.graph.setDirtyCanvas(true, true);
        }
      }
      return;
    }

    if (this._dragType === "width_resize") {
      this.canvas.style.cursor = "ew-resize";
      const deltaX = e.clientX - this._startX;

      this.node.size[0] = Math.max(300, this._startNodeWidth + deltaX);

      if (window.app && window.app.graph) {
        window.app.graph.setDirtyCanvas(true, true);
      }
      return;
    }

    if (this._dragType === "playhead") {
      this.canvas.style.cursor = "ew-resize";
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      let mouseFrameX = mouseX * (totalFrames / logicalWidth);
      mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
      this.currentFrame = clamp(mouseFrameX, 0, totalFrames);
      this._liveScrubPlayhead();
      this.render();
      if (this.isPlaying) {
        this.playAudio(); // Scrub (restart from new position)
      }
      return;
    }

    if (this._multiDragInitialSegments) {
      this.canvas.style.cursor = "grabbing";
      this._isMultiDraggingAndMoved = true;

      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      const durationFrames = totalFrames;
      let dragDelta = Math.round((mouseX - this._dragStartX) * (totalFrames / logicalWidth));

      const selectedIds = this.selectedSegmentIds;

      // Group Blocking Physics Calculation
      let maxLeftShift = Infinity;
      let maxRightShift = Infinity;

      for (const track of ["image", "audio"]) {
        const allTrackSegs = this._multiDragInitialSegments[track];
        if (!allTrackSegs) continue;
        const selectedOnTrack = allTrackSegs.filter(s => selectedIds.includes(s.id));
        const nonSelectedOnTrack = allTrackSegs.filter(s => !selectedIds.includes(s.id));

        if (selectedOnTrack.length === 0) continue;

        for (const S of selectedOnTrack) {
          // Find closest non-selected segment to the left on the same track
          let closestLeftEnd = 0;
          for (const L of nonSelectedOnTrack) {
            if (L.start + L.length <= S.start) {
              closestLeftEnd = Math.max(closestLeftEnd, L.start + L.length);
            }
          }
          const spaceLeft = S.start - closestLeftEnd;
          maxLeftShift = Math.min(maxLeftShift, spaceLeft);

          // Find closest non-selected segment to the right on the same track
          let closestRightStart = durationFrames;
          for (const R of nonSelectedOnTrack) {
            if (R.start >= S.start + S.length) {
              closestRightStart = Math.min(closestRightStart, R.start);
            }
          }
          const spaceRight = closestRightStart - (S.start + S.length);
          maxRightShift = Math.min(maxRightShift, spaceRight);
        }
      }

      // Clamp drag delta
      let clampedDragDelta = clamp(dragDelta, -maxLeftShift, maxRightShift);

      // Apply snapping if active
      if (this.isSnapping) {
        const thresholdFrames = (15 / logicalWidth) * totalFrames;
        let bestAdjustment = null;
        let minDiff = thresholdFrames;

        // Collect snap candidates
        const snapCandidates = [0, this.getDurationFrames(), this.getStartFrames(), this.currentFrame];
        if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
          snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
        }

        for (const track of ["image", "audio"]) {
          const allTrackSegs = this._multiDragInitialSegments[track];
          if (!allTrackSegs) continue;
          const nonSelectedOnTrack = allTrackSegs.filter(s => !selectedIds.includes(s.id));
          for (const L of nonSelectedOnTrack) {
            snapCandidates.push(L.start);
            snapCandidates.push(L.start + L.length);
          }
        }

        // Test all selected segments against candidates
        for (const track of ["image", "audio"]) {
          const allTrackSegs = this._multiDragInitialSegments[track];
          if (!allTrackSegs) continue;
          const selectedOnTrack = allTrackSegs.filter(s => selectedIds.includes(s.id));
          for (const S of selectedOnTrack) {
            const targetStart = S.start + clampedDragDelta;
            const targetEnd = S.start + S.length + clampedDragDelta;

            for (const cand of snapCandidates) {
              // Check start edge
              const diffStart = cand - targetStart;
              if (Math.abs(diffStart) < minDiff) {
                minDiff = Math.abs(diffStart);
                bestAdjustment = diffStart;
              }
              // Check end edge
              const diffEnd = cand - targetEnd;
              if (Math.abs(diffEnd) < minDiff) {
                minDiff = Math.abs(diffEnd);
                bestAdjustment = diffEnd;
              }
            }
          }
        }

        if (bestAdjustment !== null) {
          const adjustedDelta = clampedDragDelta + bestAdjustment;
          if (adjustedDelta >= -maxLeftShift && adjustedDelta <= maxRightShift) {
            clampedDragDelta = adjustedDelta;
          }
        }
      }

      // Compute previews
      this._multiDragPreviewTimelines = {
        image: this._multiDragInitialSegments.image.map(s => {
          if (selectedIds.includes(s.id)) {
            return { ...s, start: s.start + clampedDragDelta };
          }
          return s;
        }),
        audio: this._multiDragInitialSegments.audio.map(s => {
          if (selectedIds.includes(s.id)) {
            return { ...s, start: s.start + clampedDragDelta };
          }
          return s;
        })
      };

      // Scrub support for video segments being moved
      const prevSegs = this._multiDragPreviewTimelines.image;
      for (const s of prevSegs) {
        if (selectedIds.includes(s.id) && s.type === "video") {
          this._liveScrubVideo(s, "start");
        }
      }

      this.render();
      return;
    }

    this.canvas.style.cursor = this._dragType === "center" ? "grabbing" :
      this._dragType === "joint" ? "col-resize" : "ew-resize";

    const logicalWidth = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();
    const durationFrames = totalFrames;
    let dragDelta = Math.round((mouseX - this._dragStartX) * (totalFrames / logicalWidth));

    let t = this._dragInitialTimeline.map(s => ({ ...s }));

    // --- Rolling Edit (Slide Edit) ---
    if (this._dragType === "joint") {
      let leftIdx = t.findIndex(s => s.id === this._dragTargetId);
      let rightIdx = t.findIndex(s => s.id === this._dragTargetIdRight);

      if (leftIdx >= 0 && rightIdx >= 0) {
        let origLeft = this._dragInitialTimeline.find(s => s.id === this._dragTargetId);
        let origRight = this._dragInitialTimeline.find(s => s.id === this._dragTargetIdRight);

        let maxDeltaRight = origRight.length - MIN_SEGMENT_LENGTH;
        let maxDeltaLeft = origLeft.length - MIN_SEGMENT_LENGTH;

        if (this.selectionType === "audio" || origRight.type === "video") {
          // Drag LEFT: right clip extends left by un-trimming its head.
          // Can only un-trim as much as the right clip has been trimmed (trimStart >= 0).
          maxDeltaLeft = Math.min(maxDeltaLeft, origRight.trimStart || 0);
        }
        if (this.selectionType === "audio" || origLeft.type === "video") {
          // Drag RIGHT: left clip extends right by consuming its remaining tail audio.
          // Can only extend as far as the left clip's unplayed tail allows.
          let origDur = origLeft.audioDurationFrames || origLeft.videoDurationFrames || origLeft.length;
          let availLeftTail = origDur - ((origLeft.trimStart || 0) + origLeft.length);
          maxDeltaRight = Math.min(maxDeltaRight, availLeftTail);
        }

        // Apply snapping to the shared boundary position
        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const jointPos = origLeft.start + origLeft.length + dragDelta;
          let bestJoint = jointPos;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreIds = [String(this._dragTargetId), String(this._dragTargetIdRight)];
          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            const diff = Math.abs(jointPos - candidate);
            if (diff < minDiff) {
              minDiff = diff;
              bestJoint = candidate;
            }
          }
          dragDelta = bestJoint - (origLeft.start + origLeft.length);
        }

        let safeDelta = clamp(dragDelta, -maxDeltaLeft, maxDeltaRight);

        t[leftIdx].length = origLeft.length + safeDelta;
        t[rightIdx].start = origRight.start + safeDelta;
        t[rightIdx].length = origRight.length - safeDelta;

        if (this.selectionType === "audio" || t[rightIdx].type === "video") {
          t[rightIdx].trimStart = origRight.trimStart + safeDelta;
        }
      }
    }
    // --- Edge & Center Drags ---
    else {
      const targetIdx = t.findIndex((s) => s.id === this._dragTargetId);
      if (targetIdx < 0) return;

      if (this._dragType === "right") {
        let newLen = t[targetIdx].length + dragDelta;
        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const targetEnd = t[targetIdx].start + newLen;
          let bestEnd = targetEnd;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          // Add start and end frames of active generation range
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreSegmentIds = [String(this._dragTargetId)];
          const isVid = String(this._dragTargetId).endsWith("_v");
          const isAud = String(this._dragTargetId).endsWith("_a");
          if (isVid || isAud) {
            const siblingId = isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v";
            ignoreSegmentIds.push(siblingId);
          }

          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreSegmentIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            const diff = Math.abs(targetEnd - candidate);
            if (diff < minDiff) {
              minDiff = diff;
              bestEnd = candidate;
            }
          }
          newLen = bestEnd - t[targetIdx].start;
          dragDelta = newLen - t[targetIdx].length;
        }
        let maxPossibleLength = totalFrames - t[targetIdx].start;
        let nextSeg = t.find(s => s.start >= t[targetIdx].start + t[targetIdx].length && s.id !== t[targetIdx].id);
        if (nextSeg) {
          maxPossibleLength = nextSeg.start - t[targetIdx].start;
        }

        // Check sibling track obstacles if linked
        const isVid = String(this._dragTargetId).endsWith("_v");
        const isAud = String(this._dragTargetId).endsWith("_a");
        const siblingId = (isVid || isAud) ? (isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v") : null;
        if (siblingId && this._dragInitialSiblingTimeline) {
          let nextSibSeg = this._dragInitialSiblingTimeline.find(s => s.start >= t[targetIdx].start + t[targetIdx].length && s.id !== siblingId);
          if (nextSibSeg) {
            let sibMaxPossible = nextSibSeg.start - t[targetIdx].start;
            maxPossibleLength = Math.min(maxPossibleLength, sibMaxPossible);
          }
        }

        if ((this.selectionType === "audio" || t[targetIdx].type === "video") && !t[targetIdx].isStaticImage) {
          const origDur = t[targetIdx].audioDurationFrames || t[targetIdx].videoDurationFrames || t[targetIdx].length;
          maxPossibleLength = Math.min(maxPossibleLength, origDur - (t[targetIdx].trimStart || 0));
        }

        t[targetIdx].length = Math.max(MIN_SEGMENT_LENGTH, Math.min(newLen, maxPossibleLength));

      } else if (this._dragType === "left") {
        let newStart = t[targetIdx].start + dragDelta;
        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          let bestStart = newStart;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          // Add start and end frames of active generation range
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreSegmentIds = [String(this._dragTargetId)];
          const isVid = String(this._dragTargetId).endsWith("_v");
          const isAud = String(this._dragTargetId).endsWith("_a");
          if (isVid || isAud) {
            const siblingId = isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v";
            ignoreSegmentIds.push(siblingId);
          }

          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreSegmentIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            const diff = Math.abs(newStart - candidate);
            if (diff < minDiff) {
              minDiff = diff;
              bestStart = candidate;
            }
          }
          newStart = bestStart;
          dragDelta = newStart - t[targetIdx].start;
        }
        let minPossibleStart = 0;
        let prevSeg = t.slice().reverse().find(s => s.start + s.length <= t[targetIdx].start && s.id !== t[targetIdx].id);
        if (prevSeg) {
          minPossibleStart = prevSeg.start + prevSeg.length;
        }

        // Check sibling track obstacles if linked
        const isVid = String(this._dragTargetId).endsWith("_v");
        const isAud = String(this._dragTargetId).endsWith("_a");
        const siblingId = (isVid || isAud) ? (isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v") : null;
        if (siblingId && this._dragInitialSiblingTimeline) {
          let prevSibSeg = this._dragInitialSiblingTimeline.slice().reverse().find(s => s.start + s.length <= t[targetIdx].start && s.id !== siblingId);
          if (prevSibSeg) {
            let sibMinPossible = prevSibSeg.start + prevSibSeg.length;
            minPossibleStart = Math.max(minPossibleStart, sibMinPossible);
          }
        }

        if ((this.selectionType === "audio" || t[targetIdx].type === "video") && !t[targetIdx].isStaticImage) {
          minPossibleStart = Math.max(minPossibleStart, t[targetIdx].start - (t[targetIdx].trimStart || 0));
        }

        let maxStart = t[targetIdx].start + t[targetIdx].length - MIN_SEGMENT_LENGTH;
        newStart = Math.max(minPossibleStart, Math.min(newStart, maxStart));

        let diff = newStart - t[targetIdx].start;
        t[targetIdx].start = newStart;
        t[targetIdx].length -= diff;
        if ((this.selectionType === "audio" || t[targetIdx].type === "video") && !t[targetIdx].isStaticImage) {
          t[targetIdx].trimStart += diff;
        }

      } else if (this._dragType === "center") {
        let initT = this._dragInitialTimeline;
        let dIdx = initT.findIndex(s => s.id === this._dragTargetId);
        if (dIdx < 0) return;
        let D = { ...initT[dIdx] };

        let D_mouse_start = D.start + dragDelta;
        let mouseFrameX = mouseX * (totalFrames / logicalWidth);

        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          let bestStart = D_mouse_start;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          // Add start and end frames of active generation range
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreSegmentIds = [String(this._dragTargetId)];
          const isVid = String(this._dragTargetId).endsWith("_v");
          const isAud = String(this._dragTargetId).endsWith("_a");
          if (isVid || isAud) {
            const siblingId = isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v";
            ignoreSegmentIds.push(siblingId);
          }

          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreSegmentIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            // Check start snap
            const diffStart = Math.abs(D_mouse_start - candidate);
            if (diffStart < minDiff) {
              minDiff = diffStart;
              bestStart = candidate;
            }
            // Check end snap
            const diffEnd = Math.abs((D_mouse_start + D.length) - candidate);
            if (diffEnd < minDiff) {
              minDiff = diffEnd;
              bestStart = candidate - D.length;
            }
          }
          const rawStart = D_mouse_start;
          D_mouse_start = bestStart;
          const snapOffset = D_mouse_start - rawStart;
          dragDelta = D_mouse_start - D.start;
          mouseFrameX += snapOffset;
        }

        t = this._applyCenterDragPhysics(initT, D.id, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth);

        if (this._dragInitialSiblingTimeline) {
          let siblingPhysics = null;

          if (this._dragTargetId.endsWith("_v") || this._dragTargetId.endsWith("_a")) {
            const isVid = this._dragTargetId.endsWith("_v");
            const siblingId = isVid ? this._dragTargetId.slice(0, -2) + "_a" : this._dragTargetId.slice(0, -2) + "_v";
            siblingPhysics = this._applyCenterDragPhysics(this._dragInitialSiblingTimeline, siblingId, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth);

            // Ensure initial sync for the dragged segment so the solver starts from a good state
            const activeFinal = t.find(s => s.id === this._dragTargetId);
            const siblingFinal = siblingPhysics.find(s => s.id === siblingId);

            if (activeFinal && siblingFinal && activeFinal.start !== siblingFinal.start) {
              const origStart = D.start;
              const activeDelta = Math.abs(activeFinal.start - origStart);
              const siblingDelta = Math.abs(siblingFinal.start - origStart);
              const finalStart = activeDelta < siblingDelta ? activeFinal.start : siblingFinal.start;

              const finalMouseX = finalStart + D.length / 2;
              t = this._applyCenterDragPhysics(initT, D.id, finalStart, finalMouseX, durationFrames, totalFrames, logicalWidth, true);
              siblingPhysics = this._applyCenterDragPhysics(this._dragInitialSiblingTimeline, siblingId, finalStart, finalMouseX, durationFrames, totalFrames, logicalWidth, true);
            }
          } else {
            siblingPhysics = this._dragInitialSiblingTimeline.map(s => ({ ...s }));
          }

          // Resolve all secondary pushes to keep linked clips together
          this._resolveGlobalPhysics(t, siblingPhysics, durationFrames, initT, this._dragInitialSiblingTimeline);
          this._previewSiblingSegments = siblingPhysics;
        }
      }
    }

    const targetArray = this.getSegmentArray(this.selectionType);
    this._restoreTransientProperties(t, targetArray);

    if (this._dragType === "left") {
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "start");
    } else if (this._dragType === "right") {
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "end");
    } else if (this._dragType === "joint") {
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "end");
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetIdRight), "start");
    }

    const syncSibling = (targetId, activeArray) => {
      if (!targetId || this._dragType === "center") return; // Center drag handles physics separately above
      const isVid = targetId.endsWith("_v");
      const isAud = targetId.endsWith("_a");
      if (!isVid && !isAud) return;

      const siblingId = isVid ? targetId.slice(0, -2) + "_a" : targetId.slice(0, -2) + "_v";
      if (!this._previewSiblingSegments) {
        this._previewSiblingSegments = this._dragInitialSiblingTimeline.map(s => ({ ...s }));
      }
      const sibling = this._previewSiblingSegments.find(s => s.id === siblingId);
      const active = activeArray.find(s => s.id === targetId);

      if (sibling && active) {
        sibling.start = active.start;
        sibling.length = active.length;
        if (active.trimStart !== undefined) sibling.trimStart = active.trimStart;
      }
    };

    syncSibling(this._dragTargetId, t);
    if (this._dragType === "joint") syncSibling(this._dragTargetIdRight, t);

    this._previewSegments = t;

    if (this._previewSiblingSegments) {
      let siblingArray = null;
      if (this.selectionType === "audio") siblingArray = this.timeline.segments;
      else if (this.selectionType === "image") siblingArray = this.timeline.audioSegments;
      if (siblingArray) {
        this._restoreTransientProperties(this._previewSiblingSegments, siblingArray);
      }
    }

    this.updateUIFromSelection(); // Live update of trim values
    this.render();
  }
,

  _applyCenterDragPhysics(initT, D_id, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth, forceStart = false) {
    let t_copy = initT.map(s => ({ ...s }));
    let dIdx = t_copy.findIndex(s => s.id === D_id);
    if (dIdx < 0) return t_copy;

    let D = t_copy[dIdx];
    let D_clamped_start = clamp(D_mouse_start, 0, durationFrames - D.length);

    let baseSegments = t_copy.filter(s => s.id !== D.id);

    let insertIdx = baseSegments.length;
    for (let i = 0; i < baseSegments.length; i++) {
      let centerBase = baseSegments[i].start + baseSegments[i].length / 2;
      if (mouseFrameX < centerBase) {
        insertIdx = i;
        break;
      }
    }

    if (!forceStart) {
      let leftBound = insertIdx > 0 ? baseSegments[insertIdx - 1].start + baseSegments[insertIdx - 1].length : 0;
      let rightBound = insertIdx < baseSegments.length ? baseSegments[insertIdx].start : durationFrames;

      if (rightBound - leftBound >= D.length) {
        D_clamped_start = clamp(D_clamped_start, leftBound, rightBound - D.length);
      } else {
        let gapCenter = (leftBound + rightBound) / 2;
        D_clamped_start = gapCenter - D.length / 2;
      }
    }

    let t_test = [];
    for (let i = 0; i < insertIdx; i++) {
      t_test.push({ ...baseSegments[i], original_start: baseSegments[i].start });
    }
    t_test.push({ ...D, start: D_clamped_start, original_start: D_clamped_start });
    let D_index = insertIdx;

    for (let i = insertIdx; i < baseSegments.length; i++) {
      t_test.push({ ...baseSegments[i], original_start: baseSegments[i].start });
    }

    for (let i = D_index + 1; i < t_test.length; i++) {
      let prev = t_test[i - 1];
      t_test[i].start = Math.max(t_test[i].original_start, prev.start + prev.length);
    }

    for (let i = D_index - 1; i >= 0; i--) {
      let next = t_test[i + 1];
      t_test[i].start = Math.min(t_test[i].original_start, next.start - t_test[i].length);
    }

    let rightCursor = durationFrames;
    for (let i = t_test.length - 1; i >= 0; i--) {
      if (t_test[i].start + t_test[i].length > rightCursor) {
        t_test[i].start = rightCursor - t_test[i].length;
      }
      rightCursor = t_test[i].start;
    }
    let leftCursor = 0;
    for (let i = 0; i < t_test.length; i++) {
      if (t_test[i].start < leftCursor) {
        t_test[i].start = leftCursor;
      }
      leftCursor = t_test[i].start + t_test[i].length;
    }

    let result = t_test.map(s => {
      let clean = { ...s };
      delete clean.original_start;
      return clean;
    });

    let draggedPreview = result.find(s => s.id === D.id);
    if (draggedPreview) {
      draggedPreview.resolvedStart = draggedPreview.start;
    }

    return result;
  }
,

  _resolveGlobalPhysics(activeTimeline, siblingTimeline, durationFrames, activeInitial, siblingInitial) {
    if (!siblingTimeline) return;

    let changed = true;
    let iters = 0;
    while (changed && iters < 10) {
      changed = false;
      iters++;

      let syncedActiveIndices = [];
      let syncedSiblingIndices = [];

      // 1. Sync linked clips
      for (let i = 0; i < activeTimeline.length; i++) {
        let seg = activeTimeline[i];
        if (seg.id.endsWith("_v") || seg.id.endsWith("_a")) {
          const isVid = seg.id.endsWith("_v");
          const sibId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
          let sibIndex = siblingTimeline.findIndex(s => s.id === sibId);

          if (sibIndex >= 0) {
            let sib = siblingTimeline[sibIndex];
            if (sib.start !== seg.start) {
              let origStart = seg.start;
              if (activeInitial) {
                const origSeg = activeInitial.find(s => s.id === seg.id);
                if (origSeg) origStart = origSeg.start;
              }

              let sibOrigStart = sib.start;
              if (siblingInitial) {
                const origSib = siblingInitial.find(s => s.id === sib.id);
                if (origSib) sibOrigStart = origSib.start;
              }

              const dSeg = Math.abs(seg.start - origStart);
              const dSib = Math.abs(sib.start - sibOrigStart);

              // The segment that was pushed furthest dictates the new position
              const targetStart = dSeg > dSib ? seg.start : sib.start;

              if (seg.start !== targetStart) {
                seg.start = targetStart;
                changed = true;
                syncedActiveIndices.push(i);
              }
              if (sib.start !== targetStart) {
                sib.start = targetStart;
                changed = true;
                syncedSiblingIndices.push(sibIndex);
              }
            }
          }
        }
      }

      // 2. Resolve overlaps on both tracks by pushing outward from epicenters
      if (changed) {
        const sweepTrack = (track, epicenterIndices) => {
          let didChange = false;

          for (let epIndex of epicenterIndices) {
            // Push elements to the right of the epicenter
            for (let i = epIndex + 1; i < track.length; i++) {
              let prev = track[i - 1];
              let targetStart = prev.start + prev.length;
              if (track[i].start < targetStart) {
                track[i].start = targetStart;
                didChange = true;
              }
            }
            // Push elements to the left of the epicenter
            for (let i = epIndex - 1; i >= 0; i--) {
              let next = track[i + 1];
              let targetStart = next.start - track[i].length;
              if (track[i].start > targetStart) {
                track[i].start = targetStart;
                didChange = true;
              }
            }
          }

          // Boundary clamping to ensure nothing falls off the edges
          let rightCursor = durationFrames;
          for (let i = track.length - 1; i >= 0; i--) {
            if (track[i].start + track[i].length > rightCursor) {
              let newStart = rightCursor - track[i].length;
              if (track[i].start !== newStart) { track[i].start = newStart; didChange = true; }
            }
            rightCursor = track[i].start;
          }

          let leftCursor = 0;
          for (let i = 0; i < track.length; i++) {
            if (track[i].start < leftCursor) {
              let newStart = leftCursor;
              if (track[i].start !== newStart) { track[i].start = newStart; didChange = true; }
            }
            leftCursor = track[i].start + track[i].length;
          }
          return didChange;
        };

        sweepTrack(activeTimeline, syncedActiveIndices);
        sweepTrack(siblingTimeline, syncedSiblingIndices);
      }
    }
  }
,

  _restoreTransientProperties(copiedSegs, originalSegs) {
    if (!copiedSegs || !originalSegs) return;
    for (let ps of copiedSegs) {
      const orig = originalSegs.find(s => s.id === ps.id);
      if (orig) {
        if (orig._uploading !== undefined) ps._uploading = orig._uploading;
        if (orig._decoding !== undefined) ps._decoding = orig._decoding;
        if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
        if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
        if (orig.imgObj !== undefined) ps.imgObj = orig.imgObj;
        if (orig.videoEl !== undefined) ps.videoEl = orig.videoEl;
        if (orig.thumbnails !== undefined) ps.thumbnails = orig.thumbnails;
        if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
      }
    }
  }
,

  onMouseUp(e) {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";

    // Commit scrub target to actual video element so it's ready for playback
    const commitScrub = (segs) => {
      if (!segs) return;
      for (const seg of segs) {
        if (seg._scrubTargetSec !== undefined) {
          if (seg.videoEl && Number.isFinite(seg._scrubTargetSec)) seg.videoEl.currentTime = seg._scrubTargetSec;
          delete seg._scrubTargetSec;
        }
      }
    };

    commitScrub(this.timeline.segments);
    commitScrub(this._previewSegments);
    commitScrub(this._previewSiblingSegments);
    if (this._multiDragPreviewTimelines) {
      commitScrub(this._multiDragPreviewTimelines.image);
    }

    if (this._isDragging) {
      if (this._dragType === "box_select") {
        this._isSelectingBox = false;
        this._selectBoxStart = null;
        this._selectBoxCurrent = null;
        this._selectBoxInitialSelectedIds = null;
        this._isDragging = false;
        this.canvas.style.cursor = "default";
        this.updateUIFromSelection();
        this.render();
        this.commitChanges();
        return;
      }

      if (this._multiDragPreviewTimelines) {
        if (this._multiDragPreviewTimelines.image) {
          this.timeline.segments = this._multiDragPreviewTimelines.image.map(ps => {
            const orig = this.timeline.segments.find(s => s.id === ps.id);
            if (orig) {
              if (orig.imgObj) ps.imgObj = orig.imgObj;
              if (orig.videoEl) ps.videoEl = orig.videoEl;
              if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) ps._uploading = orig._uploading;
              if (orig._decoding !== undefined) ps._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
            }
            return ps;
          });
        }
        if (this._multiDragPreviewTimelines.audio) {
          this.timeline.audioSegments = this._multiDragPreviewTimelines.audio.map(ps => {
            const orig = this.timeline.audioSegments.find(s => s.id === ps.id);
            if (orig) {
              if (orig.imgObj) ps.imgObj = orig.imgObj;
              if (orig.videoEl) ps.videoEl = orig.videoEl;
              if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) ps._uploading = orig._uploading;
              if (orig._decoding !== undefined) ps._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
            }
            return ps;
          });
        }
        this._multiDragPreviewTimelines = null;
      } else if (this._previewSegments) {
        const targetArray = this.getSegmentArray(this.selectionType);

        const mappedArray = this._previewSegments.map(ps => {
          const orig = targetArray.find(s => s.id === ps.id);
          let finalStart = ps.resolvedStart !== undefined ? ps.resolvedStart : ps.start;
          let newPs = { ...ps, start: finalStart };
          if (orig) {
            if (orig.imgObj) newPs.imgObj = orig.imgObj;
            if (orig.videoEl) newPs.videoEl = orig.videoEl;
            if (orig.thumbnails) newPs.thumbnails = orig.thumbnails;
            if (orig._extractingThumbs !== undefined) newPs._extractingThumbs = orig._extractingThumbs;
            if (orig._uploading !== undefined) newPs._uploading = orig._uploading;
            if (orig._decoding !== undefined) newPs._decoding = orig._decoding;
            if (orig._blobUrl !== undefined) newPs._blobUrl = orig._blobUrl;
            if (orig._audioBuffer !== undefined) newPs._audioBuffer = orig._audioBuffer;
          }
          delete newPs.resolvedStart;
          return newPs;
        });

        if (this.selectionType === "audio") {
          this.timeline.audioSegments = mappedArray;
          if (this._dragTargetId) this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === this._dragTargetId);
        } else {
          this.timeline.segments = mappedArray;
          if (this._dragTargetId) this.selectedIndex = this.timeline.segments.findIndex(s => s.id === this._dragTargetId);
        }
      }

      if (this._previewSiblingSegments) {
        let siblingArray = null;
        if (this.selectionType === "audio") siblingArray = this.timeline.segments;
        else if (this.selectionType === "image") siblingArray = this.timeline.audioSegments;

        if (siblingArray) {
          const mappedSibling = this._previewSiblingSegments.map(ps => {
            const orig = siblingArray.find(s => s.id === ps.id);
            let finalStart = ps.resolvedStart !== undefined ? ps.resolvedStart : ps.start;
            let newPs = { ...ps, start: finalStart };
            if (orig) {
              if (orig.imgObj) newPs.imgObj = orig.imgObj;
              if (orig.videoEl) newPs.videoEl = orig.videoEl;
              if (orig.thumbnails) newPs.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) newPs._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) newPs._uploading = orig._uploading;
              if (orig._decoding !== undefined) newPs._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) newPs._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) newPs._audioBuffer = orig._audioBuffer;
            }
            delete newPs.resolvedStart;
            return newPs;
          });

          if (this.selectionType === "audio") this.timeline.segments = mappedSibling;
          else if (this.selectionType === "image") this.timeline.audioSegments = mappedSibling;
        }
      }

      if (this._multiDragClickPendingDeselect && !this._isMultiDraggingAndMoved) {
        const clickedId = this._multiDragClickPendingDeselect;
        this.selectedSegmentIds = [clickedId];
        const sibId = clickedId.endsWith("_v") ? clickedId.slice(0, -2) + "_a" : (clickedId.endsWith("_a") ? clickedId.slice(0, -2) + "_v" : null);
        if (sibId && !this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);

        let foundIdx = -1;
        let foundTrack = "image";
        for (const track of ["image", "audio"]) {
          const arr = this.getSegmentArray(track);
          const idx = arr.findIndex(s => s.id === clickedId);
          if (idx !== -1) {
            foundIdx = idx;
            foundTrack = track;
            break;
          }
        }
        if (foundIdx !== -1) {
          this.selectionType = foundTrack;
          this.selectedIndex = foundIdx;
        }
        this.updateUIFromSelection();
      }

      this._isDragging = false;
      this._previewSegments = null;
      this._previewSiblingSegments = null;
      this._ghostTrack = null;
      this._isMultiDraggingAndMoved = false;
      this._multiDragClickPendingDeselect = null;
      this._multiDragInitialSegments = null;
      this._multiDragPreviewTimelines = null;
      this.canvas.style.cursor = "default";
      this.commitChanges();
    }
  }
};
