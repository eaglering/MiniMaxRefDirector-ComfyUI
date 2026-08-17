// ============================================================
// MiniMax Ref Director - MiniMaxRefDirector Timeline Editor
// 主文件：定义 TimelineEditor 类 + 节点注册逻辑。
// 大量实例方法按功能拆分到 js/components/director/ 下的 mixin 模块，
// 通过 Object.assign 合并到 TimelineEditor.prototype。
// ============================================================
import { AUDIO_TRACK_HEIGHT, BLOCK_HEIGHT, CANVAS_HEIGHT, HIDDEN_WIDGET_NAMES, RULER_HEIGHT, app, clamp, hideWidget, parseInitial } from "./components/director/shared.js";
import { state } from "./components/director/state.js";
import { media } from "./components/director/media.js";
import { dom } from "./components/director/dom.js";
import { editing } from "./components/director/editing.js";
import { interaction } from "./components/director/interaction.js";
import { render } from "./components/director/render.js";
import { menus } from "./components/director/menus.js";
import { settings } from "./components/director/settings.js";
import { audio } from "./components/director/audio.js";
import { registerNode } from "./components/director/register.js";

class TimelineEditor {
  constructor(node, container, domWidget) {
    this.node = node;
    this.container = container;
    this.domWidget = domWidget;

    // Track heights (dynamic)
    this.rulerHeight = RULER_HEIGHT;
    this.blockHeight = BLOCK_HEIGHT;
    this.audioTrackHeight = AUDIO_TRACK_HEIGHT;
    this.canvasHeight = CANVAS_HEIGHT;

    // Core data
    this.timeline = { segments: [], audioSegments: [] };
    this.selectionType = "image"; // "image" or "audio"
    this.selectedSegmentIds = [];
    this._selectedIndex = -1;
    this._audioTrackWasEnabledBeforeOverride = false;

    // Selection box tracking
    this._isSelectingBox = false;
    this._selectBoxStart = null;
    this._selectBoxCurrent = null;
    this._selectBoxInitialSelectedIds = null;

    // Interactions
    this._isDragging = false;
    this._dragType = null;
    this._dragStartX = 0;
    this._dragInitialTimeline = null;
    this.zoomLevel = 1.0;
    this._lastZoom = 1.0;
    this._lastScale = 1.0;
    this._dragTargetId = null;
    this._dragTargetIdRight = null;
    this._previewSegments = null;
    this._lastWidth = 0;
    this._hoveredGapIdx = -1;
    this._isHovering = false;

    // Playback state
    this.currentFrame = 0;
    this.isPlaying = false;
    this.isLooping = false;
    this.audioContext = null;
    this.activeAudioNodes = [];
    this.playbackStartTime = 0;
    this.playbackStartFrame = 0;
    this._playLoopId = null;

    // File handling
    this.currentFileHandle = null;

    // --- Ghost dragging state ---
    this._ghostSegmentId = null;
    this._ghostTrack = null;
    this._ghostInitialTimeline = null;

    // Attach to Python widgets
    this._menu = null;            // Active floating menu (context/gap) element
    this._menuDismisser = null;

    // Attach to Python widgets
    this.startFramesWidget = this.node.widgets.find(w => w.name === "start_frame");
    this.startSecondsWidget = this.node.widgets.find(w => w.name === "start_second");
    this.endFramesWidget = this.node.widgets.find(w => w.name === "end_frame");
    this.endSecondsWidget = this.node.widgets.find(w => w.name === "end_second");
    this.durationFramesWidget = this.node.widgets.find(w => w.name === "duration_frames");
    this.durationSecondsWidget = this.node.widgets.find(w => w.name === "duration_seconds");
    this.frameRateWidget = this.node.widgets.find(w => w.name === "frame_rate");
    this.timelineDataWidget = this.node.widgets.find(w => w.name === "timeline_data");
    this.localPromptsWidget = this.node.widgets.find(w => w.name === "local_prompts");
    this.segmentLengthsWidget = this.node.widgets.find(w => w.name === "segment_lengths");
    this.guideStrengthWidget = this.node.widgets.find(w => w.name === "guide_strength");
    this.displayModeWidget = this.node.widgets.find(w => w.name === "display_mode");

    // Track the last-known frame rate so we can compute the rescale ratio
    // inside the frameRateWidget callback (the widget value is already updated
    // to the new value before the callback fires, so we can't read "old" from it).
    this._prevFrameRate = this.getFrameRate();
    this._prevStartFrames = this.getStartFrames();
    this._prevStartSeconds = this.startSecondsWidget ? this.startSecondsWidget.value : 0;

    console.log("[MiniMaxRefDirector debug] Constructor: timelineDataWidget value:", this.timelineDataWidget?.value);
    this.timeline = parseInitial(this.timelineDataWidget?.value);
    console.log("[MiniMaxRefDirector debug] Constructor: parsed timeline:", JSON.stringify(this.timeline));

    // Treat this.timeline (from timeline_data widget) as the absolute source of truth!
    this.mainTrackEnabled = this.timeline.mainTrackEnabled !== false;
    this.audioTrackEnabled = this.timeline.audioTrackEnabled !== false;

    // Sync the properties dictionary too so they match
    this.node.properties.mainTrackEnabled = this.mainTrackEnabled;
    this.node.properties.audioTrackEnabled = this.audioTrackEnabled;
    if (this.timeline.showFilenames !== undefined) {
      this.node.properties.showFilenames = this.timeline.showFilenames;
    }
    if (this.timeline.overrideAudio !== undefined) {
      this.node.properties.overrideAudio = this.timeline.overrideAudio;
    }
    if (this.timeline.inpaint_audio !== undefined) {
      this.node.properties.inpaint_audio = this.timeline.inpaint_audio;
    }

    // Sync widgets to match the timeline data
    const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
    if (inpaintWidget && this.timeline.inpaint_audio !== undefined) {
      inpaintWidget.value = this.timeline.inpaint_audio;
    }
    const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
    if (overrideWidget && this.timeline.overrideAudio !== undefined) {
      overrideWidget.value = this.timeline.overrideAudio;
    }

    this._audioTrackWasEnabledBeforeOverride = this.node.properties.audioTrackWasEnabledBeforeOverride || false;
    this.loadMedia();

    this.createDOM();
    if (this.timeline.segments.length > 0) {
      this.selectedIndex = 0;
    }
    this.updateUIFromSelection();
    this.syncWidgetsAndUI();
    this.commitChanges(true);
    // Hide settings widgets by default to reduce node clutter.
    // Deferred so all widget types are finalized before we touch them.
    setTimeout(() => this.hideSettingsWidgets(), 0);

    let isSyncing = false;

    // --- Start Callbacks ---
    const origStartFramesCallback = this.startFramesWidget?.callback;
    if (this.startFramesWidget) {
      this.startFramesWidget.callback = (...args) => {
        if (origStartFramesCallback) origStartFramesCallback.apply(this.startFramesWidget, args);

        if (!isSyncing && this.startSecondsWidget && this.durationFramesWidget && this.endFramesWidget) {
          isSyncing = true;

          let newStartFrames = this.getStartFrames();
          const endFrame = this.endFramesWidget.value || 1;
          let newDurationFrames = Math.max(1, endFrame - newStartFrames);

          if (newDurationFrames <= 1) {
            newStartFrames = endFrame - 1;
            this.startFramesWidget.value = newStartFrames;
            newDurationFrames = 1;
          }

          this.startSecondsWidget.value = parseFloat((newStartFrames / this.getFrameRate()).toFixed(3));

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          this._prevStartFrames = newStartFrames;
          this._prevStartSeconds = this.startSecondsWidget.value;

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origStartSecondsCallback = this.startSecondsWidget?.callback;
    if (this.startSecondsWidget) {
      this.startSecondsWidget.callback = (...args) => {
        if (origStartSecondsCallback) origStartSecondsCallback.apply(this.startSecondsWidget, args);

        if (!isSyncing && this.startFramesWidget && this.durationSecondsWidget && this.endFramesWidget) {
          isSyncing = true;

          let newStartSeconds = this.startSecondsWidget.value;
          let newStartFrames = Math.max(0, Math.round(newStartSeconds * this.getFrameRate()));

          const endFrame = this.endFramesWidget.value || 1;
          let newDurationFrames = Math.max(1, endFrame - newStartFrames);

          if (newDurationFrames <= 1) {
            newStartFrames = endFrame - 1;
            newStartSeconds = newStartFrames / this.getFrameRate();
            this.startSecondsWidget.value = parseFloat(newStartSeconds.toFixed(3));
            newDurationFrames = 1;
          }

          this.startFramesWidget.value = newStartFrames;

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          this._prevStartFrames = newStartFrames;
          this._prevStartSeconds = this.startSecondsWidget.value;

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    // --- End Callbacks ---
    const origEndFramesCallback = this.endFramesWidget?.callback;
    if (this.endFramesWidget) {
      this.endFramesWidget.callback = (...args) => {
        if (origEndFramesCallback) origEndFramesCallback.apply(this.endFramesWidget, args);

        if (!isSyncing && this.endSecondsWidget && this.durationFramesWidget && this.startFramesWidget) {
          isSyncing = true;

          let newEndFrames = this.endFramesWidget.value;
          const startFrame = this.startFramesWidget.value || 0;
          let newDurationFrames = Math.max(1, newEndFrames - startFrame);

          if (newDurationFrames <= 1) {
            newEndFrames = startFrame + 1;
            this.endFramesWidget.value = newEndFrames;
            newDurationFrames = 1;
          }

          this.endSecondsWidget.value = parseFloat((newEndFrames / this.getFrameRate()).toFixed(3));

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origEndSecondsCallback = this.endSecondsWidget?.callback;
    if (this.endSecondsWidget) {
      this.endSecondsWidget.callback = (...args) => {
        if (origEndSecondsCallback) origEndSecondsCallback.apply(this.endSecondsWidget, args);

        if (!isSyncing && this.endFramesWidget && this.durationSecondsWidget && this.startFramesWidget) {
          isSyncing = true;

          let newEndSeconds = this.endSecondsWidget.value;
          let newEndFrames = Math.max(1, Math.round(newEndSeconds * this.getFrameRate()));

          const startFrame = this.startFramesWidget.value || 0;
          let newDurationFrames = Math.max(1, newEndFrames - startFrame);

          if (newDurationFrames <= 1) {
            newEndFrames = startFrame + 1;
            newEndSeconds = newEndFrames / this.getFrameRate();
            this.endSecondsWidget.value = parseFloat(newEndSeconds.toFixed(3));
            newDurationFrames = 1;
          }

          this.endFramesWidget.value = newEndFrames;

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    // --- Duration Callbacks ---
    const origDurationFramesCallback = this.durationFramesWidget?.callback;
    if (this.durationFramesWidget) {
      this.durationFramesWidget.callback = (...args) => {
        if (origDurationFramesCallback) origDurationFramesCallback.apply(this.durationFramesWidget, args);

        if (!isSyncing && this.durationSecondsWidget && this.startFramesWidget && this.endFramesWidget) {
          isSyncing = true;
          this.durationSecondsWidget.value = parseFloat((this.getDurationFrames() / this.getFrameRate()).toFixed(3));

          const newEndFrames = this.startFramesWidget.value + this.getDurationFrames();
          this.endFramesWidget.value = newEndFrames;
          this.endSecondsWidget.value = parseFloat((newEndFrames / this.getFrameRate()).toFixed(3));

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origDurationSecondsCallback = this.durationSecondsWidget?.callback;
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.callback = (...args) => {
        if (origDurationSecondsCallback) origDurationSecondsCallback.apply(this.durationSecondsWidget, args);

        if (!isSyncing && this.durationFramesWidget && this.startFramesWidget && this.endFramesWidget) {
          isSyncing = true;
          const newFrames = Math.max(1, Math.round(this.durationSecondsWidget.value * this.getFrameRate()));
          this.durationFramesWidget.value = newFrames;

          const newEndFrames = this.startFramesWidget.value + newFrames;
          this.endFramesWidget.value = newEndFrames;
          this.endSecondsWidget.value = parseFloat((newEndFrames / this.getFrameRate()).toFixed(3));

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origFrameRateCallback = this.frameRateWidget?.callback;
    if (this.frameRateWidget) {
      this.frameRateWidget.callback = (...args) => {
        if (origFrameRateCallback) origFrameRateCallback.apply(this.frameRateWidget, args);

        // Keep start_seconds and end_seconds constant; recompute frames to match the new rate.
        if (!isSyncing && this.durationSecondsWidget && this.durationFramesWidget) {
          isSyncing = true;
          const newFPS = this.getFrameRate();

          // Recompute all segment frame values from their seconds snapshots.
          // Using the snapshot avoids cumulative rounding errors when the user
          // drags the slider rapidly through many intermediate FPS values.
          this._rebaseSegmentsToFPS(newFPS);

          if (this.startSecondsWidget && this.startFramesWidget) {
            const newStartFrames = Math.max(0, Math.round(this.startSecondsWidget.value * newFPS));
            this.startFramesWidget.value = newStartFrames;
            this._prevStartFrames = newStartFrames;
          }

          if (this.endSecondsWidget && this.endFramesWidget) {
            const newEndFrames = Math.max(1, Math.round(this.endSecondsWidget.value * newFPS));
            this.endFramesWidget.value = newEndFrames;
          }

          const newFrames = Math.max(1, Math.round(this.durationSecondsWidget.value * newFPS));
          this.durationFramesWidget.value = newFrames;

          // Update our tracked previous rate now that the change is complete.
          this._prevFrameRate = newFPS;
          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origDisplayModeCallback = this.displayModeWidget?.callback;
    if (this.displayModeWidget) {
      this.displayModeWidget.callback = (...args) => {
        if (origDisplayModeCallback) origDisplayModeCallback.apply(this.displayModeWidget, args);
        this.updateWidgetVisibility();
        this.updateUIFromSelection();
        this.render();
        // 通知 GlobalParamsPanel 切换 Start/End/Duration 单位（秒 <-> 帧）
        if (typeof this._onDisplayModeChange === "function") {
          this._onDisplayModeChange(this.displayModeWidget.value);
        }
      };
      this.updateWidgetVisibility(); // Initial trigger
    }

    // Polling is much more reliable in Comfy than ResizeObserver due to scale transforms
    this._renderLoop = requestAnimationFrame(() => this.checkResize());
  }

  isMultiSelectActive() {
    if (!this.selectedSegmentIds || this.selectedSegmentIds.length <= 1) return false;
    const baseIds = new Set();
    for (const id of this.selectedSegmentIds) {
      const baseId = (id.endsWith("_v") || id.endsWith("_a")) ? id.slice(0, -2) : id;
      baseIds.add(baseId);
    }
    return baseIds.size > 1;
  }

  get selectedIndex() {
    return this._selectedIndex;
  }

  set selectedIndex(val) {
    this._selectedIndex = val;
    if (this.selectedSegmentIds && !this.isMultiSelectActive()) {
      if (val === -1) {
        this.selectedSegmentIds = [];
      } else {
        const arr = this.getSegmentArray(this.selectionType);
        const seg = arr ? arr[val] : null;
        if (seg) {
          this.selectedSegmentIds = [seg.id];
          if (seg.id.endsWith("_v")) {
            const sibId = seg.id.slice(0, -2) + "_a";
            if (!this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
          } else if (seg.id.endsWith("_a")) {
            const sibId = seg.id.slice(0, -2) + "_v";
            if (!this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
          }
        } else {
          this.selectedSegmentIds = [];
        }
      }
    }
  }

  destroy() {
    cancelAnimationFrame(this._renderLoop);
    this.pauseAudio();
    window.removeEventListener("keydown", this.handleKeyDown, true);
    window.removeEventListener("paste", this.handlePaste, true);
  }

  getStartFrames() {
    return parseInt((this.startFramesWidget && this.startFramesWidget.value >= 0) ? this.startFramesWidget.value : 0, 10);
  }

  getDurationFrames() {
    return parseInt((this.durationFramesWidget && this.durationFramesWidget.value > 0) ? this.durationFramesWidget.value : 24, 10);
  }

  getFrameRate() {
    return parseInt((this.frameRateWidget && this.frameRateWidget.value > 0) ? this.frameRateWidget.value : 24, 10);
  }

  getSegmentArray(trackType) {
    if (trackType === "audio") return this.timeline.audioSegments;
    return this.timeline.segments;
  }

  getCanonicalTrack(track) {
    if (track === "image" || track === "video" || track === "text") return "image";
    if (track === "audio") return "audio";
    return track;
  }

  formatTime(frames, dropSuffix = false) {
    const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";
    if (mode === "seconds") {
      const secs = Math.round(frames) / this.getFrameRate();
      return dropSuffix ? secs.toFixed(2) : secs.toFixed(2) + "s";
    }
    return dropSuffix ? Math.round(frames).toString() : Math.round(frames) + " frames";
  }

  get _settingsWidgetNames() {
    return ["display_mode", "epsilon", "divisible_by", "img_compression"];
  }
}

// 合并各功能模块的方法到类原型
Object.assign(TimelineEditor.prototype,
  state,
  media,
  dom,
  editing,
  interaction,
  render,
  menus,
  settings,
  audio
);

// 节点注册逻辑（beforeRegisterNodeDef / onConfigure / onSerialize 等）已拆分到 js/components/director/register.js
registerNode(TimelineEditor);
