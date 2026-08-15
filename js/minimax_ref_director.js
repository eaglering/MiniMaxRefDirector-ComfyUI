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
    this._gapMenu = null;         // Active gap popup menu element
    this._gapMenuDismisser = null;

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
    this.retakeMode = this.timeline.retakeMode === true;
    if (this.retakeMode) {
      if (this.timeline.retake_global_prompt) {
        if (!this.node.properties) this.node.properties = {};
        this.node.properties.global_prompt = this.timeline.retake_global_prompt;
      }
    } else {
      if (this.timeline.global_prompt) {
        if (!this.node.properties) this.node.properties = {};
        this.node.properties.global_prompt = this.timeline.global_prompt;
      }
    }
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
    this.updateRetakeUIState();
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


// --- Node Registration Hooks ---
const APPENDED_WIDGET_DEFAULTS = [
  ["timeline_data", "{}"],
  ["local_prompts", ""],
  ["segment_lengths", ""],
];

app.registerExtension({
  name: "MiniMaxRefDirector",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name === "MiniMaxRefDirector") {

      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        if (onNodeCreated) onNodeCreated.apply(this, arguments);

        if (!this.properties) this.properties = {};
        const DEFAULTS = {
          global_prompt: "",
          mainTrackEnabled: true,
          audioTrackEnabled: true,
          audioTrackWasEnabledBeforeOverride: false,
          inpaint_audio: true,
          override_audio: false,
          overrideAudio: false,
          showFilenames: true,
          use_custom_audio: false,
          frame_rate: 24,
          display_mode: "seconds",
          custom_width: 0,
          custom_height: 0,
          resize_method: "maintain aspect ratio",
          divisible_by: 32,
          img_compression: 18,
          guide_strength: "",
          local_prompts: "",
          segment_lengths: "",
          timeline_data: "{}",
          epsilon: 0.001,
          start_second: 0.0,
          end_second: 5.0,
          duration_seconds: 5.0,
          start_frame: 0,
          end_frame: 120,
          duration_frames: 120,
        };
        for (const [key, val] of Object.entries(DEFAULTS)) {
          if (this.properties[key] === undefined) {
            this.properties[key] = val;
          }
        }

        for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
          if (!this.widgets?.find(w => w.name === name)) {
            this.addWidget("string", name, def, () => { });
          }
        }
        const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;
        for (const w of this.widgets) {
          if (HIDDEN_WIDGET_NAMES.includes(w.name)) {
            hideWidget(w);
            if (isLiteGraph && this.inputs) {
              const idx = this.inputs.findIndex(i => i.name === w.name);
              if (idx !== -1 && this.inputs[idx].link == null) {
                this.removeInput(idx);
              }
            }
          }
        }

        // Set default width to be wider on creation (approx 2.5x default ~220px)
        this.size[0] = 1375;

        // Force default for img_compression if not set (ComfyUI sometimes skips optional defaults)
        const compWidget = this.widgets?.find(w => w.name === "img_compression");
        if (compWidget && (compWidget.value === undefined || compWidget.value === null || compWidget.value === 0)) {
          compWidget.value = 18;
        }

        const self = this;
        this._syncGlobalPromptFromLink = function () {
          const globalInput = self.inputs?.find(i => i.name === "global_prompt");
          if (globalInput && globalInput.link !== null && globalInput.link !== undefined) {
            const link = app.graph.links[globalInput.link];
            if (link) {
              const originNode = app.graph.getNodeById(link.origin_id);
              if (originNode) {
                // Usually string values are in widgets[0] for primitives
                if (originNode.widgets && originNode.widgets.length > 0) {
                  const val = originNode.widgets[0].value;
                  if (self._timelineEditor && self._timelineEditor.globalPromptInput) {
                    const isRetake = self._timelineEditor.retakeMode;
                    const currentValInEditor = isRetake ? (self._timelineEditor.timeline.retake_global_prompt || "") : (self._timelineEditor.timeline.global_prompt || "");
                    if (val !== currentValInEditor) {
                      if (isRetake) {
                        self._timelineEditor.timeline.retake_global_prompt = val;
                      } else {
                        self._timelineEditor.timeline.global_prompt = val;
                      }
                      self._timelineEditor.globalPromptInput.value = val;
                      if (self.properties) {
                        self.properties.global_prompt = val;
                      }
                    } else if (self._timelineEditor.globalPromptInput.value !== val) {
                      self._timelineEditor.globalPromptInput.value = val;
                    }
                  }
                }
              }
            }
          } else {
            if (self.properties && self._timelineEditor && self._timelineEditor.globalPromptInput) {
              const val = self.properties.global_prompt || "";
              const isRetake = self._timelineEditor.retakeMode;
              const currentValInEditor = isRetake ? (self._timelineEditor.timeline.retake_global_prompt || "") : (self._timelineEditor.timeline.global_prompt || "");
              if (val !== currentValInEditor) {
                if (isRetake) {
                  self._timelineEditor.timeline.retake_global_prompt = val;
                } else {
                  self._timelineEditor.timeline.global_prompt = val;
                }
                self._timelineEditor.globalPromptInput.value = val;
              } else if (self._timelineEditor.globalPromptInput.value !== val) {
                self._timelineEditor.globalPromptInput.value = val;
              }
            }
          }
        };

        const origOnConnectionsChange = this.onConnectionsChange;
        this.onConnectionsChange = function (type, index, connected, link_info) {
          if (origOnConnectionsChange) {
            origOnConnectionsChange.apply(this, arguments);
          }
          self._syncGlobalPromptFromLink();
        };

        const origOnDrawForeground = this.onDrawForeground;
        this.onDrawForeground = function (ctx) {
          if (origOnDrawForeground) {
            origOnDrawForeground.apply(this, arguments);
          }
          self._syncGlobalPromptFromLink();
        };

        const container = document.createElement("div");

        container.style.boxSizing = "border-box";
        const widget = this.addDOMWidget("timeline_ui", "timeline_ui", container, {
          getValue: () => "",
          setValue: () => { },
        });

        widget.computeSize = function (width) {
          const canvasH = self._timelineEditor ? self._timelineEditor.canvasHeight : CANVAS_HEIGHT;
          const propH = self._timelineEditor ? (self._timelineEditor.propHeight || 90) : 90;
          const globalPropH = self._timelineEditor ? (self._timelineEditor.globalPropHeight || 60) : 60;
          const nodeWidth = self.size?.[0] || width || 1375;
          return [Math.max(10, nodeWidth - 30), canvasH + propH + globalPropH + 160];
        };

        setTimeout(() => {
          try {
            self._timelineEditor = new TimelineEditor(self, container, widget);
          } catch (err) {
            console.error("[PromptRelay] timeline editor init failed:", err);
          }
        }, 0);
      };

      const onResize = nodeType.prototype.onResize;
      nodeType.prototype.onResize = function (size) {
        const out = onResize?.apply(this, arguments);
        if (this._timelineEditor) {
          requestAnimationFrame(() => this._timelineEditor?.syncLayoutToNode());
        }
        return out;
      };

      const onRemoved = nodeType.prototype.onRemoved;
      nodeType.prototype.onRemoved = function () {
        this._timelineEditor?.destroy();
        return onRemoved?.apply(this, arguments);
      };

      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (info) {
        // 1. Call parent/original onConfigure first, with info.widgets_values intact
        const out = onConfigure ? onConfigure.apply(this, arguments) : undefined;

        if (info.properties) {
          this.properties = { ...this.properties, ...info.properties };
        }

        console.log("[MiniMaxRefDirector debug] onConfigure called. info.widgets_values:", info.widgets_values ? JSON.stringify(info.widgets_values) : "undefined");

        // Helper to set widget value, sync DOM element, and trigger callbacks safely
        const setWidgetValue = (w, val) => {
          if (!w) return;
          w.value = val;
          if (w.element) {
            if (w.element.type === "checkbox") {
              w.element.checked = !!val;
            } else {
              w.element.value = val;
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

        // 2. Check if we have serialized properties. If so, restore widgets from properties!
        if (info.properties && info.properties.has_serialized_properties) {
          console.log("[MiniMaxRefDirector debug] Restoring widgets from properties");
          if (this.widgets) {
            for (const w of this.widgets) {
              if (w.name && this.properties[w.name] !== undefined) {
                setWidgetValue(w, this.properties[w.name]);
              }
            }
          }
        } else if (info.widgets_values) {
          // Fallback to name-based schema mapping for older workflows
          console.log("[MiniMaxRefDirector debug] Restoring widgets via fallback name-based schema mapping");
          const SCHEMA_19 = [
            "start_frame", "end_frame", "duration_frames",
            "timeline_data", "use_custom_audio", "inpaint_audio", "local_prompts", "segment_lengths",
            "epsilon", "frame_rate", "display_mode", "guide_strength", "custom_width", "custom_height",
            "resize_method", "divisible_by", "img_compression", "timeline_ui"
          ];
          const SCHEMA_21_NO_INPAINT = [
            "start_second", "end_second", "duration_seconds", "start_frame", "end_frame", "duration_frames",
            "timeline_data", "local_prompts", "segment_lengths", "epsilon", "guide_strength",
            "use_custom_audio", "frame_rate", "display_mode", "custom_width", "custom_height",
            "resize_method", "divisible_by", "img_compression", "timeline_ui"
          ];
          const SCHEMA_22_NO_INPAINT = [
            "start_second", "end_second", "duration_seconds", "start_frame", "end_frame", "duration_frames",
            "timeline_data", "local_prompts", "segment_lengths", "epsilon", "guide_strength",
            "use_custom_audio", "frame_rate", "display_mode", "custom_width", "custom_height",
            "resize_method", "divisible_by", "img_compression", "override_audio", "timeline_ui"
          ];
          const SCHEMA_22_WITH_INPAINT = [
            "start_second", "end_second", "duration_seconds", "start_frame", "end_frame", "duration_frames",
            "timeline_data", "use_custom_audio", "inpaint_audio", "local_prompts", "segment_lengths",
            "epsilon", "frame_rate", "display_mode", "guide_strength", "custom_width", "custom_height",
            "resize_method", "divisible_by", "img_compression", "timeline_ui"
          ];
          const SCHEMA_23 = [
            "start_second", "end_second", "duration_seconds", "start_frame", "end_frame", "duration_frames",
            "timeline_data", "use_custom_audio", "inpaint_audio", "local_prompts", "segment_lengths",
            "epsilon", "frame_rate", "display_mode", "guide_strength", "custom_width", "custom_height",
            "resize_method", "divisible_by", "img_compression", "override_audio", "timeline_ui"
          ];

          const ALL_WIDGET_DEFAULTS = {
            inpaint_audio: true,
            override_audio: false,
            use_custom_audio: false,
            frame_rate: 24,
            display_mode: "seconds",
            custom_width: 0,
            custom_height: 0,
            resize_method: "maintain aspect ratio",
            divisible_by: 32,
            img_compression: 18,
            guide_strength: "",
            local_prompts: "",
            segment_lengths: "",
            timeline_data: "{}",
            epsilon: 0.001,
            start_second: 0.0,
            end_second: 5.0,
            duration_seconds: 5.0,
            start_frame: 0,
            end_frame: 120,
            duration_frames: 120,
          };

          let names = SCHEMA_23;
          const len = info.widgets_values.length;
          if (len <= 19) {
            names = SCHEMA_19;
          } else if (len === 21) {
            names = SCHEMA_21_NO_INPAINT;
          } else if (len === 22) {
            if (typeof info.widgets_values[13] === "number") {
              names = SCHEMA_22_NO_INPAINT;
            } else {
              names = SCHEMA_22_WITH_INPAINT;
            }
          }

          if (this.widgets) {
            for (const w of this.widgets) {
              const schemaIdx = names.indexOf(w.name);
              if (schemaIdx !== -1 && schemaIdx < len) {
                setWidgetValue(w, info.widgets_values[schemaIdx]);
              } else if (ALL_WIDGET_DEFAULTS.hasOwnProperty(w.name)) {
                setWidgetValue(w, ALL_WIDGET_DEFAULTS[w.name]);
              }
            }
          }

          // Populate properties with these restored values
          if (this.widgets) {
            for (const w of this.widgets) {
              if (w.name && w.value !== undefined) {
                this.properties[w.name] = w.value;
              }
            }
          }
          this.properties.has_serialized_properties = true;
        }

        for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
          const w = this.widgets.find(x => x.name === name);
          if (w && (w.value == null || w.value === "")) w.value = def;
        }

        setTimeout(() => {
          if (this._timelineEditor) {
            console.log("[MiniMaxRefDirector debug] setTimeout sync block called.");
            console.log("[MiniMaxRefDirector debug] setTimeout: timelineDataWidget value:", this._timelineEditor.timelineDataWidget?.value);
            const tl = parseInitial(this._timelineEditor.timelineDataWidget?.value);
            console.log("[MiniMaxRefDirector debug] setTimeout: parsed timeline:", JSON.stringify(tl));
            this._timelineEditor.timeline = tl;

            // Sync editor states from the parsed timeline object (the absolute source of truth)
            this._timelineEditor.mainTrackEnabled = tl.mainTrackEnabled !== false;
            this._timelineEditor.audioTrackEnabled = tl.audioTrackEnabled !== false;
            this._timelineEditor.retakeMode = tl.retakeMode === true;
            this._timelineEditor._audioTrackWasEnabledBeforeOverride = !!this.properties.audioTrackWasEnabledBeforeOverride;

            // Sync properties to match
            this.properties.mainTrackEnabled = this._timelineEditor.mainTrackEnabled;
            this.properties.audioTrackEnabled = this._timelineEditor.audioTrackEnabled;
            this.properties.retakeMode = this._timelineEditor.retakeMode;
            if (tl.showFilenames !== undefined) {
              this.properties.showFilenames = tl.showFilenames;
            }
            if (tl.overrideAudio !== undefined) {
              this.properties.overrideAudio = tl.overrideAudio;
            }
            if (tl.inpaint_audio !== undefined) {
              this.properties.inpaint_audio = tl.inpaint_audio;
            }

            // Sync widgets to match the timeline data
            const inpaintWidget = this.widgets?.find(w => w.name === "inpaint_audio");
            if (inpaintWidget && tl.inpaint_audio !== undefined) {
              inpaintWidget.value = tl.inpaint_audio;
            }
            const overrideWidget = this.widgets?.find(w => w.name === "override_audio");
            if (overrideWidget && tl.overrideAudio !== undefined) {
              overrideWidget.value = tl.overrideAudio;
            }

            this._timelineEditor.loadMedia();
            this._timelineEditor.selectionType = "image";
            this._timelineEditor.selectedIndex = clamp(
              this._timelineEditor.selectedIndex, -1,
              Math.max(-1, this._timelineEditor.timeline.segments.length - 1)
            );
            this._timelineEditor.updateRetakeUIState();
            this._timelineEditor.updateUIFromSelection();
            this._timelineEditor.syncWidgetsAndUI();
            this._timelineEditor.syncLayoutToNode();
            this._timelineEditor.render();
          }
        }, 0);

        return out;
      };

      const onSerialize = nodeType.prototype.onSerialize;
      nodeType.prototype.onSerialize = function (info) {
        if (onSerialize) {
          onSerialize.apply(this, arguments);
        }

        // Sync all current widgets to properties
        if (this.widgets) {
          for (const w of this.widgets) {
            if (w.name && w.value !== undefined) {
              this.properties[w.name] = w.value;
            }
          }
        }

        // Sync timeline editor state if it exists
        if (this._timelineEditor) {
          this.properties.mainTrackEnabled = this._timelineEditor.mainTrackEnabled !== false;
          this.properties.audioTrackEnabled = this._timelineEditor.audioTrackEnabled !== false;
          this.properties.audioTrackWasEnabledBeforeOverride = !!this._timelineEditor._audioTrackWasEnabledBeforeOverride;
        }

        // Mark that properties have been serialized
        this.properties.has_serialized_properties = true;

        // Ensure info.properties is populated with all our properties
        info.properties = { ...this.properties };
      };
    }
  },
});

