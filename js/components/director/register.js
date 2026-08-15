// ============================================================
// MiniMax Ref Director - 节点注册钩子（拆分自 director.js）
// 负责 beforeRegisterNodeDef 生命周期钩子：onNodeCreated /
// onResize / onRemoved / onConfigure（含 5 套旧 schema 兼容
// 映射）/ onSerialize。
// 通过 registerNode(TimelineEditor) 注入类，避免与 director.js
// 产生循环依赖。
// ============================================================
import { CANVAS_HEIGHT, HIDDEN_WIDGET_NAMES, app, clamp, hideWidget, parseInitial } from "./shared.js";

export function registerNode(TimelineEditor) {
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
}
