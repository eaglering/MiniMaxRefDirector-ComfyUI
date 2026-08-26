// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: render, drawAudioSegmentVisuals
import { RULER_HEIGHT } from "./shared.js";
import { t } from "../i18n.js";

export const render = {
  render() {
    if (!this.canvas) return;
    const width = this.canvas.offsetWidth || this._lastWidth;
    const height = this.canvasHeight;
    const totalFrames = this.getVisualDurationFrames();

    if (!width || width <= 0) return;

    this.ctx.clearRect(0, 0, width, height);

    // Lazy load active video segments
    const targetFrame = this.currentFrame;
    const activeSeg = this.timeline.segments.find(s => s.type === "video" && targetFrame >= s.start && targetFrame < s.start + s.length);
    if (activeSeg) this._ensureVideoEl(activeSeg);

    if (this.selectedIndex !== -1) {
      const selSeg = this.getSegmentArray(this.selectionType)[this.selectedIndex];
      if (selSeg && selSeg.type === "video") {
        this._ensureVideoEl(selSeg);
      }
    }

    if (this._isDragging && this._dragTargetId) {
      const dragSeg = this.timeline.segments.find(s => s.id === this._dragTargetId);
      if (dragSeg && dragSeg.type === "video") {
        this._ensureVideoEl(dragSeg);
      }
    }

    // Render Track Backgrounds
    this.ctx.fillStyle = "#121212"; // Image track bg
    this.ctx.fillRect(0, RULER_HEIGHT, width, this.blockHeight);

    this.ctx.fillStyle = "#141414"; // Audio track bg
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight, width, this.audioTrackHeight);

    // Determine which track the preview belongs to.
    // _ghostTrack is set during HTML file drag-and-drop.
    // During canvas mouse drags, _ghostTrack is null, so fall back to selectionType.
    const previewIsAudio = this._ghostTrack === 'audio' ||
      (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
    const previewIsImage = !previewIsAudio;

    let renderSegments = this.timeline.segments;
    let renderAudioSegments = this.timeline.audioSegments;

    if (this._isDragging && this._multiDragPreviewTimelines) {
      if (this._multiDragPreviewTimelines.image) renderSegments = this._multiDragPreviewTimelines.image;
      if (this._multiDragPreviewTimelines.audio) renderAudioSegments = this._multiDragPreviewTimelines.audio;
    } else {
      const previewIsAudio = this._ghostTrack === 'audio' ||
        (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
      const previewIsImage = !previewIsAudio;

      if (this._previewSegments && previewIsImage) renderSegments = this._previewSegments;
      else if (this._previewSiblingSegments && previewIsAudio) renderSegments = this._previewSiblingSegments;

      if (this._previewSegments && previewIsAudio) renderAudioSegments = this._previewSegments;
      else if (this._previewSiblingSegments && previewIsImage) renderAudioSegments = this._previewSiblingSegments;
    }

    const sortedSegments = [...renderSegments].sort((a, b) => {
      const aSel = this.selectedSegmentIds.includes(a.id) ? 1 : 0;
      const bSel = this.selectedSegmentIds.includes(b.id) ? 1 : 0;
      return aSel - bSel;
    });

    const sortedAudioSegments = [...renderAudioSegments].sort((a, b) => {
      const aSel = this.selectedSegmentIds.includes(a.id) ? 1 : 0;
      const bSel = this.selectedSegmentIds.includes(b.id) ? 1 : 0;
      return aSel - bSel;
    });

    { // Normal timeline segment rendering
      // --- Draw Image/Text Segments ---
      for (let i = 0; i < sortedSegments.length; i++) {
        const seg = sortedSegments[i];
        const rawStartX = (seg.start / totalFrames) * width;
        const rawEndX = ((seg.start + seg.length) / totalFrames) * width;
        const startX = Math.floor(rawStartX);
        const pxWidth = Math.max(1, Math.floor(rawEndX) - startX);
        const isSelected = this.selectedSegmentIds.includes(seg.id);

        const originalSeg = this.timeline.segments.find(s => s.id === seg.id);
        const imgObj = originalSeg ? originalSeg.imgObj : seg.imgObj;
        const videoEl = originalSeg ? originalSeg.videoEl : seg.videoEl;

        const isPlayheadOverSeg = (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length);
        const isScrubbingThis = this._isDragging && (this._dragTargetId === seg.id || this._dragTargetIdRight === seg.id);
        const isLiveActive = this.isPlaying && isPlayheadOverSeg;

        if ((this._isDragging && this.selectionType === "image" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
          this.ctx.globalAlpha = 0.65;
        } else {
          this.ctx.globalAlpha = 1.0;
        }

        if (seg.type === "ghost") {
          this.ctx.fillStyle = "#2a2a2a";
          this.ctx.fillRect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);

          this.ctx.strokeStyle = "#777";
          this.ctx.lineWidth = 2;
          this.ctx.setLineDash([5, 5]);
          this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
          this.ctx.setLineDash([]);

          this.ctx.fillStyle = "#aaa";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.font = "bold 12px sans-serif";
          this.ctx.fillText(t("Drop to Place"), startX + pxWidth / 2, RULER_HEIGHT + this.blockHeight / 2);
        } else {
          this.ctx.fillStyle = seg.type === "text" ? "#000b12" : "#000";
          this.ctx.fillRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
        }

        let drawSource = null;
        if (isLiveActive && videoEl && videoEl.readyState >= 2) {
          drawSource = videoEl;
        } else {
          if (seg.type === "video" && seg.thumbnails && seg.thumbnails.length > 0) {
            const targetTime = seg._scrubTargetSec !== undefined
              ? seg._scrubTargetSec
              : (isPlayheadOverSeg ? (this.currentFrame - seg.start + seg.trimStart) / this.getFrameRate() : seg.trimStart / this.getFrameRate());
            let nearestImg = seg.thumbnails[0].img;
            let minDiff = Infinity;
            for (const t of seg.thumbnails) {
              const diff = Math.abs(t.time - targetTime);
              if (diff < minDiff) {
                minDiff = diff;
                nearestImg = t.img;
              }
            }
            drawSource = nearestImg;
          } else {
            drawSource = imgObj && imgObj.complete ? imgObj : null;
          }
        }

        if (drawSource && seg.type !== "ghost") {
          const isVid = !!drawSource.videoWidth;
          const natW = isVid ? drawSource.videoWidth : drawSource.naturalWidth;
          const natH = isVid ? drawSource.videoHeight : drawSource.naturalHeight;

          if (natW > 0) {
            const imgRatio = natW / natH;
            const boxRatio = pxWidth / this.blockHeight;
            let drawW, drawH, drawX, drawY;
            if (imgRatio > boxRatio) {
              drawW = pxWidth; drawH = pxWidth / imgRatio;
              drawX = startX; drawY = RULER_HEIGHT + (this.blockHeight - drawH) / 2;
            } else {
              drawH = this.blockHeight; drawW = this.blockHeight * imgRatio;
              drawY = RULER_HEIGHT; drawX = startX + (pxWidth - drawW) / 2;
            }

            // Clip to segment bounds so tiled images don't bleed into adjacent segments
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
            this.ctx.clip();

            if (imgRatio > boxRatio) {
              // Fits width, vertical letterboxing (black bars top/bottom) — keep as is
              this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
            } else {
              // Fits height, horizontal letterboxing (black bars left/right)
              this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);

              // Tile left
              let leftX = drawX - drawW;
              while (leftX + drawW > startX) {
                this.ctx.drawImage(drawSource, leftX, drawY, drawW, drawH);
                leftX -= drawW;
              }
              // Tile right
              let rightX = drawX + drawW;
              while (rightX < startX + pxWidth) {
                this.ctx.drawImage(drawSource, rightX, drawY, drawW, drawH);
                rightX += drawW;
              }
            }
            this.ctx.restore();
          }
        }

        if ((seg.type === "video" || drawSource) && seg.type !== "ghost") {
          if (seg.type === "video" && pxWidth > 0) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
            this.ctx.clip();
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, RULER_HEIGHT + 1, 42, 16);
            this.ctx.fillStyle = "#fff";
            this.ctx.font = "bold 10px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText("VIDEO", startX + 21, RULER_HEIGHT + 9);
            this.ctx.restore();

            // Uploading / Loading indicator badge (bottom-left corner)
            if ((seg._uploading || seg._extractingThumbs) && pxWidth > 60) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
              this.ctx.clip();
              this.ctx.font = "bold 9px sans-serif";
              const upText = seg._extractingThumbs ? t("Loading...") : t("Uploading...");
              const upW = this.ctx.measureText(upText).width + 10;
              this.ctx.fillStyle = "rgba(0, 14, 37, 0.7)";
              this.ctx.fillRect(startX + 1, RULER_HEIGHT + this.blockHeight - 17, upW, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.textAlign = "center";
              this.ctx.textBaseline = "middle";
              this.ctx.fillText(upText, startX + 1 + upW / 2, RULER_HEIGHT + this.blockHeight - 9);
              this.ctx.restore();
            }

            // Filename next to VIDEO tag
            if (this.node.properties.showFilenames && pxWidth > 46) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
              this.ctx.clip();
              let rawPath = seg.imageFile || "";
              let fname = rawPath.split(/[/\\]/).pop() || "";
              this.ctx.font = "9px sans-serif";
              this.ctx.textAlign = "left";
              this.ctx.textBaseline = "middle";
              const maxFileTextW = pxWidth - 42 - 10;
              if (this.ctx.measureText(fname).width > maxFileTextW) {
                while (fname.length > 0 && this.ctx.measureText(fname + "…").width > maxFileTextW) {
                  fname = fname.slice(0, -1);
                }
                fname += "…";
              }
              const textW = this.ctx.measureText(fname).width;
              this.ctx.fillStyle = "rgba(0, 0, 0, 0.50)";
              this.ctx.fillRect(startX + 43, RULER_HEIGHT + 1, textW + 8, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.fillText(fname, startX + 47, RULER_HEIGHT + 9);
              this.ctx.restore();
            }
          } else if (seg.type === "image" && pxWidth > 0) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
            this.ctx.clip();
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, RULER_HEIGHT + 1, 42, 16);
            this.ctx.fillStyle = "#fff";
            this.ctx.font = "bold 10px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText("IMAGE", startX + 21, RULER_HEIGHT + 9);
            this.ctx.restore();

            // Filename next to IMAGE tag
            if (this.node.properties.showFilenames && pxWidth > 46) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
              this.ctx.clip();
              let rawPath = seg.imageFile || "";
              let fname = rawPath.split(/[/\\]/).pop() || "";
              this.ctx.font = "9px sans-serif";
              this.ctx.textAlign = "left";
              this.ctx.textBaseline = "middle";
              const maxFileTextW = pxWidth - 42 - 10;
              if (this.ctx.measureText(fname).width > maxFileTextW) {
                while (fname.length > 0 && this.ctx.measureText(fname + "…").width > maxFileTextW) {
                  fname = fname.slice(0, -1);
                }
                fname += "…";
              }
              const textW = this.ctx.measureText(fname).width;
              this.ctx.fillStyle = "rgba(0, 0, 0, 0.50)";
              this.ctx.fillRect(startX + 43, RULER_HEIGHT + 1, textW + 8, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.fillText(fname, startX + 47, RULER_HEIGHT + 9);
              this.ctx.restore();
            }
          }

          // --- Prompt subtitle overlay ---
          if (seg.prompt && seg.type !== "ghost" && pxWidth > 24) {
            const overlayH = Math.round(this.blockHeight * 0.20);
            const overlayY = RULER_HEIGHT + this.blockHeight - overlayH;

            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, overlayY, pxWidth, overlayH);
            this.ctx.clip();

            // Translucent background
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, overlayY, pxWidth, overlayH);

            // Text
            const fontSize = Math.min(11, overlayH * 0.58);
            this.ctx.font = `${fontSize}px sans-serif`;
            this.ctx.fillStyle = "#e0e3ed";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";

            // Measure and truncate to single line
            const maxTextW = pxWidth - 10;
            let label = seg.prompt;
            if (this.ctx.measureText(label).width > maxTextW) {
              while (label.length > 0 && this.ctx.measureText(label + "…").width > maxTextW) {
                label = label.slice(0, -1);
              }
              label += "…";
            }

            this.ctx.fillText(label, startX + pxWidth / 2, overlayY + overlayH / 2);
            this.ctx.restore();
          }
        } else if (seg.type === "text") {
          const pad = 8;
          const boxW = pxWidth - pad * 2;
          if (boxW > 12) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX + pad, RULER_HEIGHT + pad, boxW, this.blockHeight - pad * 2);
            this.ctx.clip();
            this.ctx.fillStyle = "#e0e3ed";
            this.ctx.font = "11px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "top";
            const label = seg.prompt || "(no prompt)";
            const words = label.split(" ");
            const lineH = 15;
            let line = "";
            let lines = [];
            for (const word of words) {
              const test = line ? line + " " + word : word;
              if (this.ctx.measureText(test).width > boxW && line) {
                lines.push(line);
                line = word;
              } else {
                line = test;
              }
            }
            if (line) lines.push(line);

            const maxLines = Math.max(1, Math.floor((this.blockHeight - pad * 2) / lineH));
            if (lines.length > maxLines) {
              lines = lines.slice(0, maxLines);
              lines[lines.length - 1] += "…";
            }

            const totalTextHeight = lines.length * lineH;
            let ty = RULER_HEIGHT + (this.blockHeight - totalTextHeight) / 2 + 2;

            for (const l of lines) {
              this.ctx.fillText(l, startX + pxWidth / 2, ty);
              ty += lineH;
            }
            this.ctx.restore();
          }
        }

        if (isSelected) {
          const outlineColor = "#fff";
          this.ctx.strokeStyle = outlineColor;
          this.ctx.lineWidth = 2;
          this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
          if (!this.isMultiSelectActive()) {
            this.ctx.fillStyle = outlineColor;
            this.ctx.beginPath();
            this.ctx.roundRect(startX, RULER_HEIGHT + this.blockHeight / 2 - 12, 4, 24, 2);
            this.ctx.fill();
            this.ctx.beginPath();
            this.ctx.roundRect(startX + pxWidth - 4, RULER_HEIGHT + this.blockHeight / 2 - 12, 4, 24, 2);
            this.ctx.fill();
          }
        } else {
          this.ctx.strokeStyle = "#000";
          this.ctx.lineWidth = 1.5;
          this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
        }

        // Latent Upscaler 标记：segment.upscale === true 时在段右上角显示 X2
        if (seg.upscale && seg.type !== "ghost" && pxWidth > 44) {
          const badgeW = 22;
          const badgeX = startX + pxWidth - badgeW - 3;
          const badgeY = RULER_HEIGHT + 1;
          this.ctx.save();
          this.ctx.beginPath();
          this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
          this.ctx.clip();
          this.ctx.fillStyle = "rgba(255, 145, 0, 0.9)";
          this.ctx.fillRect(badgeX, badgeY, badgeW, 15);
          this.ctx.fillStyle = "#fff";
          this.ctx.font = "bold 10px sans-serif";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.fillText("X2", badgeX + badgeW / 2, badgeY + 7.5);
          this.ctx.restore();
        }
        this.ctx.globalAlpha = 1.0;
      }

      // --- Draw Audio Segments ---
      for (let i = 0; i < sortedAudioSegments.length; i++) {
        const seg = sortedAudioSegments[i];
        const rawStartX = (seg.start / totalFrames) * width;
        const rawEndX = ((seg.start + seg.length) / totalFrames) * width;
        const startX = Math.floor(rawStartX);
        const pxWidth = Math.max(1, Math.floor(rawEndX) - startX);
        const isSelected = this.selectedSegmentIds.includes(seg.id);
        const trackY = RULER_HEIGHT + this.blockHeight;

        if ((this._isDragging && this.selectionType === "audio" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
          this.ctx.globalAlpha = 0.65;
        } else {
          this.ctx.globalAlpha = 1.0;
        }

        if (seg.type === "ghost") {
          this.ctx.fillStyle = "#1a1a1a";
          this.ctx.fillRect(startX, trackY, pxWidth, this.audioTrackHeight);
          this.ctx.strokeStyle = "#555";
          this.ctx.lineWidth = 2;
          this.ctx.setLineDash([5, 5]);
          this.ctx.strokeRect(startX, trackY, pxWidth, this.audioTrackHeight);
          this.ctx.setLineDash([]);
          this.ctx.fillStyle = "#888";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.font = "bold 12px sans-serif";
          this.ctx.fillText(t("Drop Audio"), startX + pxWidth / 2, trackY + this.audioTrackHeight / 2);
        } else {
          const showHandles = !this.isMultiSelectActive();
          const outlineColor = isSelected ? "#fff" : null;
          this.drawAudioSegmentVisuals(this.ctx, seg, isSelected, trackY, this.audioTrackHeight, startX, pxWidth, outlineColor, showHandles);
        }
        this.ctx.globalAlpha = 1.0;
      }


      // --- Dim Disabled Tracks ---
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
      if (!this.mainTrackEnabled) {
        this.ctx.fillRect(0, RULER_HEIGHT, width, this.blockHeight);
      }
      if (!this.audioTrackEnabled) {
        this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight, width, this.audioTrackHeight);
      }
    }

    // --- Draw Ruler & Divider AFTER segments to prevent overlap ---
    // Ruler Background
    this.ctx.fillStyle = "#1e1e1e";
    this.ctx.fillRect(0, 0, width, RULER_HEIGHT);

    // Crisp Ruler Text
    this.ctx.fillStyle = "#aaa";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.font = "10px sans-serif";

    const frameRate = this.getFrameRate();
    const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";

    // Define logical steps for both modes
    let steps;
    if (mode === "seconds") {
      steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    } else {
      steps = [1, 2, 5, 10, 24, 48, 120, 240, 480, 960, 1920];
    }

    const minSpacingPx = 60;
    let majorStep = steps[steps.length - 1];
    for (let i = 0; i < steps.length; i++) {
      const stepFrames = mode === "seconds" ? steps[i] * frameRate : steps[i];
      const spacingPx = (stepFrames / totalFrames) * width;
      if (spacingPx >= minSpacingPx) {
        majorStep = steps[i];
        break;
      }
    }

    const majorStepFrames = mode === "seconds" ? majorStep * frameRate : majorStep;

    let minorStep;
    if (mode === "seconds") {
      if (majorStep <= 0.2) minorStep = majorStep / 2;
      else if (majorStep <= 1) minorStep = majorStep / 5;
      else if (majorStep <= 5) minorStep = 1;
      else if (majorStep <= 15) minorStep = 5;
      else if (majorStep <= 30) minorStep = 10;
      else if (majorStep <= 60) minorStep = 10;
      else minorStep = majorStep / 5;
    } else {
      if (majorStep <= 5) minorStep = 1;
      else if (majorStep <= 10) minorStep = 2;
      else if (majorStep <= 24) minorStep = 6;
      else if (majorStep <= 48) minorStep = 12;
      else minorStep = majorStep / 5;
    }
    const minorStepFrames = mode === "seconds" ? minorStep * frameRate : minorStep;

    this.ctx.fillStyle = "#444";
    const totalMinorTicks = Math.floor(totalFrames / minorStepFrames);
    for (let i = 0; i <= totalMinorTicks; i++) {
      const frameVal = i * minorStepFrames;
      if (Math.abs(frameVal % majorStepFrames) < 0.1) continue;

      const x = (frameVal / totalFrames) * width;
      this.ctx.fillRect(Math.floor(x), RULER_HEIGHT - 3, 1, 3);
    }

    this.ctx.fillStyle = "#aaa";
    const totalMajorTicks = Math.floor(totalFrames / majorStepFrames);
    for (let i = 0; i <= totalMajorTicks; i++) {
      const frameVal = i * majorStepFrames;
      const x = (frameVal / totalFrames) * width;

      this.ctx.fillStyle = "#aaa";
      this.ctx.fillRect(Math.floor(x), RULER_HEIGHT - 6, 1, 6);

      if (frameVal > 0 && frameVal < totalFrames) {
        this.ctx.textAlign = "center";
        this.ctx.fillText(this.formatTime(frameVal, true), x, RULER_HEIGHT / 2);
      }
    }

    this.ctx.textAlign = "left";
    const zeroLabel = mode === "seconds" ? "0" : this.formatTime(0, true);
    this.ctx.fillText(zeroLabel, 4, RULER_HEIGHT / 2);

    // Divider
    this.ctx.fillStyle = "#111";
    this.ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight - 1, width, 1);
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight + this.audioTrackHeight - 1, width, 1);

    // Draw gap "+" buttons
    if (!this._isDragging) {
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const hov = this._hoveredGapIdx === i;
        const BTN_W = 18;
        const BTN_H = 18;
        this.ctx.beginPath();
        this.ctx.roundRect(gap.centerX - BTN_W / 2, gap.centerY - BTN_H / 2, BTN_W, BTN_H, 4);
        this.ctx.fillStyle = hov ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.05)";
        this.ctx.fill();
        this.ctx.fillStyle = hov ? "#fff" : "#888";
        this.ctx.font = "14px sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText("+", gap.centerX, gap.centerY + 1);
      }
    }

    // --- Out-of-duration shadow overlay ---
    const startFrames = this.getStartFrames();
    const durationFrames = this.getDurationFrames();
    const outputFrames = startFrames + durationFrames;

    if (startFrames > 0) {
      const startX = (startFrames / totalFrames) * width;
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      this.ctx.fillRect(0, RULER_HEIGHT, startX, this.blockHeight + this.audioTrackHeight);
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
      this.ctx.fillRect(0, 0, startX, RULER_HEIGHT);
    }

    if (outputFrames < totalFrames) {
      const cutoffX = (outputFrames / totalFrames) * width;
      // Semi-transparent black overlay on both tracks
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      this.ctx.fillRect(cutoffX, RULER_HEIGHT, width - cutoffX, this.blockHeight + this.audioTrackHeight);
      // Subtle tinted ruler overlay
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
      this.ctx.fillRect(cutoffX, 0, width - cutoffX, RULER_HEIGHT);
    }

    // --- Draw Playhead ---
    const playheadX = (this.currentFrame / totalFrames) * width;

    // Playhead Line
    this.ctx.beginPath();
    this.ctx.moveTo(playheadX, 14);
    this.ctx.lineTo(playheadX, this.canvasHeight);
    this.ctx.strokeStyle = "#ff4444";
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    // Playhead Handle (Polygon above numbers)
    this.ctx.fillStyle = "#ff4444";
    this.ctx.beginPath();
    this.ctx.moveTo(playheadX - 6, 0);
    this.ctx.lineTo(playheadX + 6, 0);
    this.ctx.lineTo(playheadX + 6, 8);
    this.ctx.lineTo(playheadX, 14);
    this.ctx.lineTo(playheadX - 6, 8);
    this.ctx.fill();

    // Draw vertical grab bar on the right edge of viewport for resizing width
    const grabBarW = 4;
    const grabBarH = 50;
    const grabBarX = this.viewport.scrollLeft + this.viewport.clientWidth - grabBarW - 3;
    const grabBarY = RULER_HEIGHT + (this.blockHeight + this.audioTrackHeight - grabBarH) / 2;

    this.ctx.fillStyle = "rgba(40, 40, 40, 0.6)";
    this.ctx.beginPath();
    this.ctx.roundRect(grabBarX, grabBarY, grabBarW, grabBarH, 2);
    this.ctx.fill();

    // Draw horizontal grab bar at the bottom of viewport for resizing height
    const hBarW = 50;
    const hBarH = 4;
    const hBarX = this.viewport.scrollLeft + (this.viewport.clientWidth - hBarW) / 2;
    const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
    const hBarY = visibleBottom - hBarH - 3; // 3px from the visible bottom edge

    this.ctx.fillStyle = "rgba(20, 20, 20, 0.8)";
    this.ctx.beginPath();
    this.ctx.roundRect(hBarX, hBarY, hBarW, hBarH, 2);
    this.ctx.fill();

    // --- Draw Selection Box Overlay ---
    if (this._isSelectingBox && this._selectBoxStart && this._selectBoxCurrent) {
      const sx = this._selectBoxStart.x;
      const sy = this._selectBoxStart.y;
      const cx = this._selectBoxCurrent.x;
      const cy = this._selectBoxCurrent.y;

      const left = Math.min(sx, cx);
      const top = Math.min(sy, cy);
      const rectWidth = Math.abs(cx - sx);
      const rectHeight = Math.abs(cy - sy);

      this.ctx.save();
      this.ctx.fillStyle = "rgba(59, 130, 246, 0.2)";
      this.ctx.fillRect(left, top, rectWidth, rectHeight);

      this.ctx.strokeStyle = "rgba(29, 78, 216, 0.9)";
      this.ctx.lineWidth = 1.5;
      this.ctx.setLineDash([4, 4]);
      this.ctx.strokeRect(left, top, rectWidth, rectHeight);
      this.ctx.setLineDash([]);
      this.ctx.restore();
    }

    this.updatePlayerUI();
  }
,

  drawAudioSegmentVisuals(ctx, seg, isSelected, yOffset, trackHeight, startX, pxWidth, outlineColor = null, showHandles = true) {
    ctx.fillStyle = isSelected ? "#2a4a3a" : "#1a2a1a";
    ctx.fillRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if (seg.waveformPeaks && pxWidth > 0) {
      ctx.fillStyle = isSelected ? "rgba(100, 255, 100, 0.6)" : "rgba(100, 255, 100, 0.3)";
      const startRatio = seg.trimStart / seg.audioDurationFrames;
      const endRatio = (seg.trimStart + seg.length) / seg.audioDurationFrames;
      const peakCount = seg.waveformPeaks.length;
      const centerY = yOffset + trackHeight / 2;

      ctx.beginPath();
      for (let i = 0; i < pxWidth; i++) {
        const pixelRatio = i / pxWidth;
        const globalRatio = startRatio + pixelRatio * (endRatio - startRatio);
        const peakIdx = Math.floor(globalRatio * peakCount);

        if (peakIdx >= 0 && peakIdx < peakCount) {
          const val = seg.waveformPeaks[peakIdx];
          const amp = (val * (trackHeight - 12) / 2) * 0.9;
          ctx.fillRect(startX + i, centerY - amp, 1, amp * 2);
        }
      }
    }

    const strokeColor = outlineColor || (isSelected ? "#4fff8f" : "#000");
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = isSelected || outlineColor ? 2 : 1.5;
    ctx.strokeRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if ((isSelected || outlineColor) && showHandles) {
      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      ctx.roundRect(startX, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(startX + pxWidth - 4, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
    }

    ctx.fillStyle = "#ccc";
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.save();
    ctx.beginPath();
    ctx.rect(startX, yOffset + 2, pxWidth, trackHeight - 3);
    ctx.clip();

    let text = seg.fileName || t("Audio Track");
    const maxWidth = pxWidth - 12;
    if (ctx.measureText(text).width > maxWidth && maxWidth > 0) {
      while (text.length > 0 && ctx.measureText(text + "...").width > maxWidth) {
        text = text.slice(0, -1);
      }
      text = text + "...";
    }

    ctx.fillText(text, startX + 6, yOffset + 8);
    ctx.restore();

    // Show Uploading or Decoding badge in bottom-left if applicable
    if ((seg._uploading || seg._decoding) && pxWidth > 60) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(startX, yOffset + 2, pxWidth, trackHeight - 3);
      ctx.clip();
      ctx.font = "bold 9px sans-serif";
      const upText = seg._decoding ? t("Decoding...") : t("Uploading...");
      const upW = ctx.measureText(upText).width + 10;
      ctx.fillStyle = "rgba(0, 14, 37, 0.7)";
      ctx.fillRect(startX + 1, yOffset + trackHeight - 17, upW, 14);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(upText, startX + 1 + upW / 2, yOffset + trackHeight - 10);
      ctx.restore();
    }
  }
};
