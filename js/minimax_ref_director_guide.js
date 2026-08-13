import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// MiniMax Super Director Guide — dynamic visibility of VLM-backend inputs.
// Depending on vlm_mode (clip / llama-cpp / api) only the relevant widgets are
// shown; prompt_enhance=Pre-formatted hides all VLM widgets (pure JSON parse).

const VLM_WIDGET_MODE = {
  gguf_name: ["llama-cpp"],
  mmproj_name: ["llama-cpp"],
  api_provider: ["api"],
  api_key: ["api"],
};

function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  if (!w.options) w.options = {};
  w.options.hidden = true;

  // Collapse via computeSize/draw overrides (safely in LiteGraph,
  // without triggering ComfyUI's "convert to input slot" auto-behavior).
  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    w.computeSize = () => [0, -4]; // -4 cancels ComfyUI's hardcoded 4px widget padding
    if (!w._mmrHiddenDrawHooked) {
      w._mmrOrigDraw = w.hasOwnProperty("draw") ? w.draw : undefined;
      w._mmrHiddenDrawHooked = true;
    }
    w.draw = () => {};
  }

  if (w.element) w.element.style.display = "none";
}

function showWidget(w) {
  if (!w) return;
  w.hidden = false;
  if (w.options) w.options.hidden = false;

  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    delete w.computeSize;
    if (w._mmrHiddenDrawHooked) {
      if (w._mmrOrigDraw !== undefined) {
        w.draw = w._mmrOrigDraw;
      } else {
        delete w.draw;
      }
      delete w._mmrHiddenDrawHooked;
      delete w._mmrOrigDraw;
    }
  }

  if (w.element) w.element.style.display = "";
}

app.registerExtension({
  name: "Comfy.MiniMaxRefDirectorGuide",
  async nodeCreated(node) {
    if (node.comfyClass !== "MiniMaxRefDirectorGuide") return;

    const getWidget = (name) => node.widgets?.find((w) => w.name === name);

    const applyVisibility = () => {
      const mode = getWidget("vlm_mode")?.value;
      const preFormatted = getWidget("prompt_enhance")?.value === "Pre-formatted";
      for (const [name, modes] of Object.entries(VLM_WIDGET_MODE)) {
        const w = getWidget(name);
        if (!w) continue;
        const visible = !preFormatted && modes.includes(mode);
        if (visible) showWidget(w);
        else hideWidget(w);
      }
    };

    // Re-apply whenever the user switches the mode dropdowns.
    const hookCallback = (name) => {
      const w = getWidget(name);
      if (!w) return;
      const orig = w.callback;
      w.callback = function (value) {
        if (orig) orig.call(this, value);
        applyVisibility();
      };
    };
    hookCallback("vlm_mode");
    hookCallback("prompt_enhance");

    // 1. Re-apply after workflow load (onConfigure restores the saved values,
    //    so the initial hide must run after other extensions have configured it).
    const origConfigure = node.onConfigure;
    node.onConfigure = function (info) {
      const out = origConfigure ? origConfigure.apply(this, arguments) : undefined;
      setTimeout(applyVisibility, 0);
      return out;
    };

    // 2. Also apply for freshly dragged-in nodes (no onConfigure fired).
    setTimeout(applyVisibility, 50);

    // 3. Manual "unload GGUF" button: frees the cached llama-cpp model's
    //    RAM/VRAM on demand (see server.py /minimax_ref/api/llama/unload).
    if (node.widgets && !node.widgets.some((w) => w.name === "_mmr_unload_gguf")) {
      const unloadBtn = node.addWidget(
        "button",
        "释放 GGUF 模型内存",
        null,
        () => {
          unloadBtn.disabled = true;
          api
            .fetchApi("/minimax_ref/api/llama/unload", { method: "POST" })
            .then((r) => r.json())
            .then((j) => {
              if (j.success) {
                app.extensionManager?.toast?.add({
                  text: "GGUF 模型已卸载，内存已释放",
                  severity: "success",
                });
              } else {
                app.extensionManager?.toast?.add({
                  text: `GGUF 卸载失败: ${j.error || "未知错误"}`,
                  severity: "error",
                });
              }
            })
            .catch((e) => console.error("[MiniMaxRef] unload GGUF error:", e))
            .finally(() => {
              unloadBtn.disabled = false;
            });
        },
        { serialize: false }
      );
      unloadBtn.serializeValue = false;
    }
  },
});
