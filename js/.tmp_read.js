const fs = require("fs");
const d = "d:/workspace/ComfyUI_windows_portable/ComfyUI/custom_nodes/MiniMaxRefDirector-ComfyUI/js/";
const read = (f, a, b) => {
  const lines = fs.readFileSync(d + f, "utf8").split(/\r?\n/);
  console.log("\n===== " + f + " " + a + "-" + Math.min(b, lines.length) + " =====");
  for (let i = a - 1; i < Math.min(b, lines.length); i++) console.log((i + 1) + ": " + lines[i]);
};
read("components/director/media.js", 630, 680);
read("components/director/media.js", 1035, 1070);
read("components/director/menus.js", 370, 445);
read("subject.js", 1, 25);
read("subject.js", 400, 430);
