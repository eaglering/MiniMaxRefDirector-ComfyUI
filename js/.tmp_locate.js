const fs = require("fs");
const d = "d:/workspace/ComfyUI_windows_portable/ComfyUI/custom_nodes/MiniMaxRefDirector-ComfyUI/js/components/director/";
let s = fs.readFileSync(d + "media.js", "utf8");
let lines = s.split(/\r?\n/);
console.log("===== media.js upload/URL/fetch 模式 =====");
lines.forEach((l, i) => {
  if (/(upload|fetchApi|apiURL|FormData|view\?|subfolder|imageFile|imgUrl)/.test(l)) {
    console.log("M " + (i + 1) + ": " + l.trim().slice(0, 160));
  }
});
console.log("\n===== dom.js 关键 DOM 锚点 =====");
s = fs.readFileSync(d + "dom.js", "utf8");
lines = s.split(/\r?\n/);
lines.forEach((l, i) => {
  if (/(createDOM|pr-toolbar|pr-actions|pr-btn|segmentPrompt|promptWrapper|globalPrompt|toolbar)/.test(l)) {
    console.log("D " + (i + 1) + ": " + l.trim().slice(0, 160));
  }
});
