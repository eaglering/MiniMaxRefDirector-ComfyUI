// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: markSegment, markCurrentSelection, deleteSelectedSegment, pasteCopiedSegment, pasteSegmentAtFrame, splitSegmentAtPlayhead, commitChanges, _stampSegmentSeconds, _rebaseSegmentsToFPS, getGapRegions, promptAddAudioInGap, addSegmentInGap, addTextSegmentFreeSpace
import { RULER_HEIGHT, app, genId } from "./shared.js";

export const editing = {
  markSegment(seg) {
    if (!seg) return;
    const newStart = Math.round(seg.start);
    const newEnd = Math.max(newStart + 1, Math.round(seg.start + seg.length));

    const currentStart = this.getStartFrames();
    const currentEnd = this.endFramesWidget ? parseInt(this.endFramesWidget.value, 10) : (currentStart + this.getDurationFrames());

    let targetStart = newStart;
    let targetEnd = newEnd;

    if (currentStart === newStart && currentEnd === newEnd) {
      const allSegs = [
        ...(this.timeline.segments || []),
        ...(this.timeline.audioSegments || [])
      ];
      let lastSegmentEnd = 0;
      for (const s of allSegs) {
        if (s.start + s.length > lastSegmentEnd) {
          lastSegmentEnd = s.start + s.length;
        }
      }
      if (lastSegmentEnd <= 0) {
        lastSegmentEnd = this.getDurationFrames();
      }
      targetStart = 0;
      targetEnd = Math.max(1, Math.round(lastSegmentEnd));
    }

    if (this.startFramesWidget && this.endFramesWidget) {
      this.startFramesWidget.value = targetStart;
      this.endFramesWidget.value = targetEnd;
      if (this.startFramesWidget.callback) {
        this.startFramesWidget.callback(targetStart);
      }
      if (this.endFramesWidget.callback) {
        this.endFramesWidget.callback(targetEnd);
      }
      this.commitChanges();
      this.render();
    }
  }
,

  markCurrentSelection() {
    const allSegs = [
      ...(this.timeline.segments || []),
      ...(this.timeline.audioSegments || [])
    ];
    let targetSegs = [];

    if (this.selectedSegmentIds && this.selectedSegmentIds.length > 0) {
      targetSegs = allSegs.filter(s => this.selectedSegmentIds.includes(s.id));
    }

    if (targetSegs.length === 0 && this.selectedIndex >= 0 && this.selectionType) {
      const arr = this.getSegmentArray(this.selectionType);
      if (arr && arr[this.selectedIndex]) {
        targetSegs = [arr[this.selectedIndex]];
      }
    }

    if (targetSegs.length === 0) return;

    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const s of targetSegs) {
      if (s.start < minStart) {
        minStart = s.start;
      }
      if (s.start + s.length > maxEnd) {
        maxEnd = s.start + s.length;
      }
    }

    if (minStart !== Infinity && maxEnd !== -Infinity) {
      const newStart = Math.round(minStart);
      const newEnd = Math.max(newStart + 1, Math.round(maxEnd));

      const currentStart = this.getStartFrames();
      const currentEnd = this.endFramesWidget ? parseInt(this.endFramesWidget.value, 10) : (currentStart + this.getDurationFrames());

      let targetStart = newStart;
      let targetEnd = newEnd;

      if (currentStart === newStart && currentEnd === newEnd) {
        let lastSegmentEnd = 0;
        for (const s of allSegs) {
          if (s.start + s.length > lastSegmentEnd) {
            lastSegmentEnd = s.start + s.length;
          }
        }
        if (lastSegmentEnd <= 0) {
          lastSegmentEnd = this.getDurationFrames();
        }
        targetStart = 0;
        targetEnd = Math.max(1, Math.round(lastSegmentEnd));
      }

      if (this.startFramesWidget && this.endFramesWidget) {
        this.startFramesWidget.value = targetStart;
        this.endFramesWidget.value = targetEnd;
        if (this.startFramesWidget.callback) {
          this.startFramesWidget.callback(targetStart);
        }
        if (this.endFramesWidget.callback) {
          this.endFramesWidget.callback(targetEnd);
        }
        this.commitChanges();
        this.render();
      }
    }
  }
,

  deleteSelectedSegment() {
    if (this.selectedSegmentIds && this.isMultiSelectActive()) {
      const idsToDelete = new Set(this.selectedSegmentIds);
      for (const id of this.selectedSegmentIds) {
        if (id.endsWith("_v")) idsToDelete.add(id.slice(0, -2) + "_a");
        else if (id.endsWith("_a")) idsToDelete.add(id.slice(0, -2) + "_v");
      }

      this.timeline.segments = this.timeline.segments.filter(s => !idsToDelete.has(s.id));
      this.timeline.audioSegments = this.timeline.audioSegments.filter(s => !idsToDelete.has(s.id));

      this.selectedSegmentIds = [];
      this.selectedIndex = -1;
    } else {
      const delSibling = (seg) => {
        if (!seg || !seg.id) return;
        const isVid = seg.id.endsWith("_v");
        const isAud = seg.id.endsWith("_a");
        if (!isVid && !isAud) return;

        const siblingId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
        const siblingArray = isVid ? this.timeline.audioSegments : this.timeline.segments;
        const sIdx = siblingArray.findIndex(s => s.id === siblingId);
        if (sIdx !== -1) siblingArray.splice(sIdx, 1);
      };

      if (this.selectionType === "audio") {
        if (this.timeline.audioSegments.length === 0 || this.selectedIndex === -1) return;
        delSibling(this.timeline.audioSegments[this.selectedIndex]);
        this.timeline.audioSegments.splice(this.selectedIndex, 1);
        this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
      } else {
        if (this.timeline.segments.length === 0 || this.selectedIndex === -1) return;
        delSibling(this.timeline.segments[this.selectedIndex]);
        this.timeline.segments.splice(this.selectedIndex, 1);
        this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
      }
      this.selectedSegmentIds = [];
    }
    this.updateUIFromSelection();
    this.commitChanges();
    this.render();
  }
,

  pasteCopiedSegment() {
    if (!window._ltxCopiedSegment || !window._ltxCopiedSegmentType) return;
    const trackType = window._ltxCopiedSegmentType;
    const startFrame = Math.round(this.currentFrame);
    this.pasteSegmentAtFrame(window._ltxCopiedSegment.main, trackType, window._ltxCopiedSegment.sibling, startFrame);
  }
,

  pasteSegmentAtFrame(copiedSegData, copiedTrack, siblingSegData, startFrame) {
    const isAudio = copiedTrack === "audio";

    const randId = () => genId();
    const baseId = randId();

    let mainSeg = { ...copiedSegData };
    let sibSeg = siblingSegData ? { ...siblingSegData } : null;

    if (sibSeg) {
      mainSeg.id = baseId + (isAudio ? "_a" : "_v");
      sibSeg.id = baseId + (isAudio ? "_v" : "_a");
    } else {
      if (mainSeg.id && (mainSeg.id.endsWith("_v") || mainSeg.id.endsWith("_a"))) {
        mainSeg.id = mainSeg.id.slice(0, -2);
      } else {
        mainSeg.id = baseId;
      }
    }

    if (mainSeg.thumbnails) mainSeg.thumbnails = [...mainSeg.thumbnails];
    if (sibSeg && sibSeg.thumbnails) sibSeg.thumbnails = [...sibSeg.thumbnails];

    mainSeg.start = startFrame;
    if (sibSeg) sibSeg.start = startFrame;

    const mainArr = isAudio ? [...this.timeline.audioSegments] : [...this.timeline.segments];
    mainArr.push(mainSeg);
    mainArr.sort((a, b) => a.start - b.start);

    const sibArr = isAudio ? [...this.timeline.segments] : [...this.timeline.audioSegments];
    if (sibSeg) {
      sibArr.push(sibSeg);
      sibArr.sort((a, b) => a.start - b.start);
    }

    const durationFrames = this.getDurationFrames();
    const totalFrames = this.getVisualDurationFrames();
    const width = this.canvas.offsetWidth || this._lastWidth;

    const mainInit = mainArr.map(s => ({ ...s }));
    const sibInit = sibSeg ? sibArr.map(s => ({ ...s })) : null;

    let finalMain, finalSib;
    finalMain = this._applyCenterDragPhysics(mainInit, mainSeg.id, startFrame, startFrame + mainSeg.length / 2, durationFrames, totalFrames, width, true);
    if (sibSeg) {
      finalSib = this._applyCenterDragPhysics(sibInit, sibSeg.id, startFrame, startFrame + sibSeg.length / 2, durationFrames, totalFrames, width, true);
    }

    if (sibSeg) {
      const activeTimeline = isAudio ? finalMain : finalSib;
      const siblingTimeline = isAudio ? finalSib : finalMain;
      this._resolveGlobalPhysics(activeTimeline, siblingTimeline, durationFrames, mainInit, sibInit);
    }

    const restoreDOM = (outArr, refArr) => {
      for (let ps of outArr) {
        const orig = refArr.find(s => s.id === ps.id);
        if (orig) {
          ps.videoEl = orig.videoEl;
          ps.imgObj = orig.imgObj;
          if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
        }
      }
    };

    restoreDOM(finalMain, mainArr);
    if (sibSeg) restoreDOM(finalSib, sibArr);

    if (copiedTrack === "audio") {
      this.timeline.audioSegments = finalMain;
      if (sibSeg) this.timeline.segments = finalSib;
    } else {
      this.timeline.segments = finalMain;
      if (sibSeg) this.timeline.audioSegments = finalSib;
    }

    this.selectionType = copiedTrack;
    this.selectedIndex = this.getSegmentArray(copiedTrack).findIndex(s => s.id === mainSeg.id);

    this.growTimelineIfNeeded(mainSeg.start + mainSeg.length);

    this.updateUIFromSelection();
    this.commitChanges();
    this.render();
  }
,

  splitSegmentAtPlayhead(seg, trackType) {
    if (this.isPlaying) {
      this.pauseAudio();
    }

    const splitFrame = Math.round(this.currentFrame);
    if (splitFrame <= seg.start || splitFrame >= seg.start + seg.length) {
      return;
    }

    const isVidLink = (trackType === "image" || trackType === "video") && seg.id.endsWith("_v");
    const isAudLink = trackType === "audio" && seg.id.endsWith("_a");
    let sibling = null;
    if (isVidLink) {
      sibling = this.timeline.audioSegments.find(s => s.id === seg.id.slice(0, -2) + "_a");
    } else if (isAudLink) {
      sibling = this.timeline.segments.find(s => s.id === seg.id.slice(0, -2) + "_v");
    }

    const randId = () => genId();
    const leftBase = randId();
    const rightBase = randId();

    const leftLen = splitFrame - seg.start;
    const rightLen = seg.start + seg.length - splitFrame;

    if (sibling) {
      const videoSeg = isVidLink ? seg : sibling;
      const audioSeg = isVidLink ? sibling : seg;

      const leftVid = {
        ...videoSeg,
        id: leftBase + "_v",
        length: leftLen,
        videoEl: null,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null),
        thumbnails: videoSeg.thumbnails ? [...videoSeg.thumbnails] : null
      };
      const leftAud = {
        ...audioSeg,
        id: leftBase + "_a",
        length: leftLen,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null)
      };

      let rightImageB64 = videoSeg.imageB64;
      let rightImgObj = videoSeg.imgObj;
      if (videoSeg.thumbnails && videoSeg.thumbnails.length > 0) {
        const targetTime = ((videoSeg.trimStart || 0) + leftLen) / this.getFrameRate();
        let nearest = videoSeg.thumbnails[0];
        let minDiff = Infinity;
        for (const t of videoSeg.thumbnails) {
          const diff = Math.abs(t.time - targetTime);
          if (diff < minDiff) {
            minDiff = diff;
            nearest = t;
          }
        }
        if (nearest && nearest.img) {
          rightImageB64 = nearest.img.src;
          rightImgObj = nearest.img;
        }
      }

      const rightVid = {
        ...videoSeg,
        id: rightBase + "_v",
        start: splitFrame,
        length: rightLen,
        trimStart: (videoSeg.trimStart || 0) + leftLen,
        videoEl: null,
        imageB64: rightImageB64,
        imgObj: rightImgObj,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null),
        thumbnails: videoSeg.thumbnails ? [...videoSeg.thumbnails] : null
      };
      const rightAud = {
        ...audioSeg,
        id: rightBase + "_a",
        start: splitFrame,
        length: rightLen,
        trimStart: (audioSeg.trimStart || 0) + leftLen,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null)
      };

      this.timeline.segments = this.timeline.segments.filter(s => s.id !== videoSeg.id);
      this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== audioSeg.id);

      this.timeline.segments.push(leftVid, rightVid);
      this.timeline.audioSegments.push(leftAud, rightAud);

      this.timeline.segments.sort((a, b) => a.start - b.start);
      this.timeline.audioSegments.sort((a, b) => a.start - b.start);

      this.selectionType = trackType;
      const targetId = trackType === "audio" ? leftAud.id : leftVid.id;
      const targetArray = this.getSegmentArray(trackType);
      this.selectedIndex = targetArray.findIndex(s => s.id === targetId);

    } else {
      const targetArray = this.getSegmentArray(trackType);

      const leftSeg = {
        ...seg,
        id: leftBase,
        length: leftLen
      };
      if (seg.type === "video") {
        leftSeg.videoEl = null;
        leftSeg._blobUrl = seg._blobUrl || (seg.videoEl ? seg.videoEl.src : null);
        leftSeg.thumbnails = seg.thumbnails ? [...seg.thumbnails] : null;
      }

      let rightImageB64 = seg.imageB64;
      let rightImgObj = seg.imgObj;
      if (seg.thumbnails && seg.thumbnails.length > 0) {
        const targetTime = ((seg.trimStart || 0) + leftLen) / this.getFrameRate();
        let nearest = seg.thumbnails[0];
        let minDiff = Infinity;
        for (const t of seg.thumbnails) {
          const diff = Math.abs(t.time - targetTime);
          if (diff < minDiff) {
            minDiff = diff;
            nearest = t;
          }
        }
        if (nearest && nearest.img) {
          rightImageB64 = nearest.img.src;
          rightImgObj = nearest.img;
        }
      }

      const rightSeg = {
        ...seg,
        id: rightBase,
        start: splitFrame,
        length: rightLen,
        trimStart: (seg.trimStart || 0) + leftLen
      };
      if (seg.type === "video") {
        rightSeg.videoEl = null;
        rightSeg.imageB64 = rightImageB64;
        rightSeg.imgObj = rightImgObj;
        rightSeg._blobUrl = seg._blobUrl || (seg.videoEl ? seg.videoEl.src : null);
        rightSeg.thumbnails = seg.thumbnails ? [...seg.thumbnails] : null;
      }

      const idx = targetArray.findIndex(s => s.id === seg.id);
      if (idx !== -1) {
        targetArray.splice(idx, 1);
      }

      targetArray.push(leftSeg, rightSeg);
      targetArray.sort((a, b) => a.start - b.start);

      this.selectionType = trackType;
      this.selectedIndex = targetArray.findIndex(s => s.id === leftSeg.id);
    }

    this.loadMedia();
    this.updateUIFromSelection();
    this.commitChanges();
    this.render();
  }
,

  commitChanges(skipRender = false) {
    if (this._suppressCommit) return;
    // Deduplicate segments by ID to clean up any duplicates created by the previous onseeked bug
    this.timeline.segments = this.timeline.segments.filter((seg, index, self) => index === self.findIndex((s) => s.id === seg.id));
    if (this.timeline.audioSegments) {
      this.timeline.audioSegments = this.timeline.audioSegments.filter((seg, index, self) => index === self.findIndex((s) => s.id === seg.id));
    }

    let sortedSegments = [...this.timeline.segments].sort((a, b) => a.start - b.start);
    let contiguousLengths = [];
    let contiguousPrompts = [];
    let imgStrengths = [];

    const startFrames = this.getStartFrames();
    const durationFrames = this.getDurationFrames();
    this.timeline.normalStartFrame = startFrames;
    this.timeline.normalDurationFrames = durationFrames;
    const endFrames = startFrames + durationFrames;
    let currentCursor = startFrames;

    // Build segment lengths clipped at the duration cutoff.
    // - Gaps before the first segment, or between segments, are absorbed into the adjacent
    //   segment's length (same as before), but are also clipped at endFrames.
    // - Segments completely before startFrames or after endFrames are excluded entirely.
    // - Segments that cross the boundaries are trimmed.
    let pendingGap = 0;
    for (let seg of sortedSegments) {
      if (seg.start + seg.length <= startFrames) continue;
      if (seg.start >= endFrames) break;

      const effectiveStart = Math.max(seg.start, startFrames);

      if (effectiveStart > currentCursor) {
        const gapLength = Math.min(effectiveStart, endFrames) - currentCursor;
        if (contiguousLengths.length > 0) {
          contiguousLengths[contiguousLengths.length - 1] += gapLength;
        } else {
          pendingGap += gapLength;
        }
      }

      const clippedEnd = Math.min(seg.start + seg.length, endFrames);
      const clippedLength = clippedEnd - effectiveStart;

      contiguousLengths.push(clippedLength + pendingGap);
      contiguousPrompts.push(seg.prompt || "");
      pendingGap = 0;
      currentCursor = Math.max(currentCursor, seg.start + seg.length);
    }

    const clampedCursor = Math.min(currentCursor, endFrames);
    if (contiguousLengths.length > 0 && clampedCursor < endFrames) {
      contiguousLengths[contiguousLengths.length - 1] += endFrames - clampedCursor;
    }

    const toSave = {
      mainTrackEnabled: this.mainTrackEnabled,
      audioTrackEnabled: this.audioTrackEnabled,
      propHeight: this.propHeight,
      showFilenames: !!this.node.properties.showFilenames,
      overrideAudio: !!this.node.properties.overrideAudio,
      inpaint_audio: !!(this.node.widgets?.find(w => w.name === "inpaint_audio")?.value),
      normalStartFrame: this.timeline.normalStartFrame,
      normalDurationFrames: this.timeline.normalDurationFrames,
      segments: sortedSegments.map(s => {
        const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
        return rest;
      }),
      audioSegments: (this.timeline.audioSegments || []).map(s => {
        const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, _blobUrl, _audioBuffer, ...rest } = s;
        return rest;
      })
    };

    const jsonStr = JSON.stringify(toSave);
    console.log("[LTXDirector debug] commitChanges: saving timelineDataWidget value:", jsonStr);

    const updateWidgetValue = (w, val) => {
      if (!w) return;
      const oldVal = w.value;
      w.value = val;
      if (this.node) {
        if (this.node.properties) {
          this.node.properties[w.name] = val;
        }
        if (this.node.onWidgetChanged) {
          this.node.onWidgetChanged(w.name, val, oldVal, w);
        }
      }
      if (w.callback) {
        try {
          w.callback(val);
        } catch (e) {
          // ignore
        }
      }
    };

    if (this.timelineDataWidget) {
      updateWidgetValue(this.timelineDataWidget, jsonStr);
    }

    if (this.node.properties) {
      this.node.properties.mainTrackEnabled = this.mainTrackEnabled;
      this.node.properties.audioTrackEnabled = this.audioTrackEnabled;
      this.node.properties.audioTrackWasEnabledBeforeOverride = !!this._audioTrackWasEnabledBeforeOverride;

      if (this.node.widgets) {
        for (const w of this.node.widgets) {
          if (w.name && w.value !== undefined) {
            this.node.properties[w.name] = w.value;
          }
        }
      }
      const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
      if (overrideWidget) {
        this.node.properties.overrideAudio = !!overrideWidget.value;
      }
    }

    const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
    if (overrideWidget) {
      updateWidgetValue(overrideWidget, !!this.node.properties.overrideAudio);
    }

    if (this.localPromptsWidget) {
      updateWidgetValue(this.localPromptsWidget, contiguousPrompts.join(" | "));
    }
    if (this.segmentLengthsWidget) {
      updateWidgetValue(this.segmentLengthsWidget, contiguousLengths.join(","));
    }

    if (this.guideStrengthWidget) {
      const strList = sortedSegments
        .filter(s => s.type !== "text")
        .filter(s => s.start + s.length > startFrames && s.start < endFrames)
        .map(s => (s.guideStrength !== undefined ? s.guideStrength : 1.0).toFixed(2));
      updateWidgetValue(this.guideStrengthWidget, strList.join(","));
    }

    // Keep zoom slider max in sync with the current timeline duration.
    this.updateZoomSliderMax();

    setTimeout(() => {
      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (app.graph) {
          app.graph.setDirtyCanvas(true, true);
          if (app.graph.change) app.graph.change();
          if (app.graph.onNodeChanged) app.graph.onNodeChanged(this.node);
          if (app.graph.onStateChanged) app.graph.onStateChanged();
        }
      }
      try {
        const canvasEl = app.canvasEl || app.canvas?.canvas;
        if (canvasEl) {
          canvasEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        }
        if (app.canvas && app.canvas.checkState) app.canvas.checkState();
        if (app.canvas && app.canvas.captureCanvasState) app.canvas.captureCanvasState();
      } catch (_) { }
    }, 100);

    // Stamp exact seconds on every live segment so FPS changes can recompute
    // frame values without cumulative rounding error.
    this._stampSegmentSeconds();

    if (this.isPlaying) {
      this.playAudio(); // Resync audio engine with new timeline data
    }

    if (!skipRender) this.render();
  }
,

  _stampSegmentSeconds() {
    const fps = this.getFrameRate();
    if (fps <= 0) return;
    for (const seg of this.timeline.segments) {
      seg._sSecs = seg.start / fps;
      seg._lSecs = seg.length / fps;
      if (seg.trimStart !== undefined) seg._tSecs = seg.trimStart / fps;
      if (seg.videoDurationFrames !== undefined) seg._dSecs = seg.videoDurationFrames / fps;
    }
    for (const seg of this.timeline.audioSegments) {
      seg._sSecs = seg.start / fps;
      seg._lSecs = seg.length / fps;
      if (seg.trimStart !== undefined) seg._tSecs = seg.trimStart / fps;
      if (seg.audioDurationFrames !== undefined) seg._dSecs = seg.audioDurationFrames / fps;
    }
  }
,

  _rebaseSegmentsToFPS(newFPS) {
    if (newFPS <= 0) return;
    const oldFPS = this._prevFrameRate || newFPS;
    const fallbackRatio = oldFPS > 0 ? newFPS / oldFPS : 1;
    for (const seg of this.timeline.segments) {
      if (seg._sSecs !== undefined) {
        seg.start = Math.round(seg._sSecs * newFPS);
        seg.length = Math.max(1, Math.round(seg._lSecs * newFPS));
        if (seg._tSecs !== undefined) seg.trimStart = Math.round(seg._tSecs * newFPS);
        if (seg._dSecs !== undefined) seg.videoDurationFrames = Math.round(seg._dSecs * newFPS);
      } else {
        seg.start = Math.round(seg.start * fallbackRatio);
        seg.length = Math.max(1, Math.round(seg.length * fallbackRatio));
        if (seg.trimStart !== undefined) seg.trimStart = Math.round(seg.trimStart * fallbackRatio);
        if (seg.videoDurationFrames !== undefined) seg.videoDurationFrames = Math.round(seg.videoDurationFrames * fallbackRatio);
      }
    }
    for (const seg of this.timeline.audioSegments) {
      if (seg._sSecs !== undefined) {
        seg.start = Math.round(seg._sSecs * newFPS);
        seg.length = Math.max(1, Math.round(seg._lSecs * newFPS));
        if (seg._tSecs !== undefined) seg.trimStart = Math.round(seg._tSecs * newFPS);
        if (seg._dSecs !== undefined) seg.audioDurationFrames = Math.round(seg._dSecs * newFPS);
      } else {
        seg.start = Math.round(seg.start * fallbackRatio);
        seg.length = Math.max(1, Math.round(seg.length * fallbackRatio));
        if (seg.trimStart !== undefined) seg.trimStart = Math.round(seg.trimStart * fallbackRatio);
        if (seg.audioDurationFrames !== undefined) seg.audioDurationFrames = Math.round(seg.audioDurationFrames * fallbackRatio);
      }
    }
  }
,

  getGapRegions() {
    const totalFrames = this.getVisualDurationFrames();
    const outputFrames = this.getStartFrames() + this.getDurationFrames();
    const width = this.canvas.offsetWidth || this._lastWidth || 0;
    const gaps = [];
    if (!width) return gaps;

    // Image gaps
    let cursor = 0;
    const sortedImg = [...this.timeline.segments].sort((a, b) => a.start - b.start);
    for (const seg of sortedImg) {
      if (seg.start > cursor) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (seg.start / totalFrames) * width;
        gaps.push({ track: 'image', frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight / 2, widthPx: x1 - x0 });
      }
      cursor = seg.start + seg.length;
    }
    if (cursor < outputFrames) {
      const x0 = (cursor / totalFrames) * width;
      const x1 = (outputFrames / totalFrames) * width;
      gaps.push({ track: 'image', frameStart: cursor, frameEnd: outputFrames, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight / 2, widthPx: x1 - x0 });
    }

    // Audio gaps
    cursor = 0;
    const sortedAud = [...this.timeline.audioSegments].sort((a, b) => a.start - b.start);
    for (const seg of sortedAud) {
      if (seg.start > cursor) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (seg.start / totalFrames) * width;
        gaps.push({ track: 'audio', frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight + this.audioTrackHeight / 2, widthPx: x1 - x0 });
      }
      cursor = seg.start + seg.length;
    }
    if (cursor < outputFrames) {
      const x0 = (cursor / totalFrames) * width;
      const x1 = (outputFrames / totalFrames) * width;
      gaps.push({ track: 'audio', frameStart: cursor, frameEnd: outputFrames, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight + this.audioTrackHeight / 2, widthPx: x1 - x0 });
    }

    return gaps;
  }
,

  promptAddAudioInGap(frameStart, frameEnd) {
    const fi = document.createElement("input");
    fi.type = "file";
    fi.accept = "audio/*";
    fi.addEventListener("change", (ev) => {
      if (ev.target.files?.[0]) this.handleAudioUpload([ev.target.files[0]], frameStart);
    });
    fi.click();
  }
,

  addSegmentInGap(frameStart, frameEnd, type = "text") {
    const seg = {
      id: genId(),
      start: frameStart, length: frameEnd - frameStart,
      prompt: "", type,
      motionContext: type == "text",
      autoEndFrame: true,
    };
    this.timeline.segments.push(seg);
    this.timeline.segments.sort((a, b) => a.start - b.start);

    this.growTimelineIfNeeded(seg.start + seg.length);

    this.selectionType = "image";
    this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }
,

  addTextSegmentFreeSpace() {
    const frameRate = this.getFrameRate();
    const newLength = Math.max(1, frameRate); // 1 second default
    const sorted = [...this.timeline.segments].sort((a, b) => a.start - b.start);
    let newStart = 0;
    for (const seg of sorted) {
      if (newStart + newLength <= seg.start) break;
      newStart = Math.max(newStart, seg.start + seg.length);
    }
    // Place the segment at the first free slot in the visual timeline (no output duration change).
    const durationFrames = this.getVisualDurationFrames();
    const seg = {
      id: genId(),
      start: newStart, length: Math.min(newLength, Math.max(newLength, durationFrames - newStart)),
      prompt: "", type: "text",
    };
    this.timeline.segments.push(seg);
    this.timeline.segments.sort((a, b) => a.start - b.start);

    this.growTimelineIfNeeded(seg.start + seg.length);

    this.selectionType = "image";
    this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }
};
