import { app } from "../../scripts/app.js";

// MiniMaxRefDirector — combo value repair.
//
// gguf_name / mmproj_name / api_provider are populated from live folder/config
// listings at schema time. Workflows saved earlier may hold values that no
// longer exist (a GGUF file was moved/removed, the provider list changed), and
// ComfyUI blocks the node with "Invalid input / Some input values are not
// available for this node". Here we repair such values to a valid default right
// after the node is configured, so the workflow still loads and runs.

const NODE_CLASSES = new Set(["MiniMaxRefDirector"]);

function getComboValues(w) {
  // Newer ComfyUI: options.values array; legacy: options is the array itself.
  if (w?.options?.values && Array.isArray(w.options.values)) return w.options.values;
  if (Array.isArray(w?.options)) return w.options;
  return [];
}

function fixInvalidComboValues(node) {
  for (const w of node.widgets ?? []) {
    if (w.type !== "combo") continue;
    const values = getComboValues(w);
    if (!values.length) continue;
    if (values.includes(w.value)) continue;
    // Prefer the widget's declared default, else the first option.
    const fallback = w.options?.default_value ?? w.options?.default ?? values[0];
    if (w.value === fallback) continue;
    w.value = fallback;
    if (w.callback) w.callback(w.value);
  }
  if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "Comfy.MiniMaxRefComboFix",
  async nodeCreated(node) {
    if (node.comfyClass !== "MiniMaxRefDirector") return;

    // Repair synchronously inside onConfigure so it runs before ComfyUI's
    // graph-level invalid-input check after a workflow load.
    const origConfigure = node.onConfigure;
    node.onConfigure = function (info) {
      const out = origConfigure ? origConfigure.apply(this, arguments) : undefined;
      fixInvalidComboValues(node);
      return out;
    };

    // Freshly dragged-in nodes (and safety net for late configure ordering).
    setTimeout(() => fixInvalidComboValues(node), 0);
  },
});
