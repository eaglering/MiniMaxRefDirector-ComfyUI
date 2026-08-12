import { app } from "../../scripts/app.js";

// MiniMaxRef Merge Videos From Paths: all parameters are user-visible inputs.
// No hidden widgets or custom frontend behavior is required — the node schema
// is rendered automatically by ComfyUI's new node API.
app.registerExtension({
  name: "Comfy.MiniMaxRefMergeVideosFromPaths",
  async nodeCreated(node) {
    if (node.comfyClass !== "MiniMaxRefMergeVideosFromPaths") return;

    // No hidden widgets needed — all params are user-visible.
  },
});
