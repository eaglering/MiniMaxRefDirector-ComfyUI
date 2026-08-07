import { app } from "../../scripts/app.js";

// MiniMax Super Director Guide is a pure pass-through processor node.
// All data comes from the guide_data output of MiniMax Super Director.
app.registerExtension({
  name: "Comfy.MiniMaxRefDirectorGuide",
  async nodeCreated(node) {
    if (node.comfyClass !== "MiniMaxRefDirectorGuide") return;

    // No hidden widgets needed — all params are user-visible or linked via guide_data.
    // The seg_index widget is the only interactive input; guide_data comes via link.
  },
});
