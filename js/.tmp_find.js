const fs = require("fs");
const dirs = [
  "d:/workspace/ComfyUI_windows_portable/ComfyUI/custom_nodes/MiniMaxRefDirector-ComfyUI/js/components/director/",
  "d:/workspace/ComfyUI_windows_portable/ComfyUI/custom_nodes/MiniMaxRefDirector-ComfyUI/js/"
];
const files = [];
for (const d of dirs) {
  for (const f of fs.readdirSync(d)) {
    if (f.endsWith(".js")) files.push(d + f);
  }
}
console.log("===== genId 模式 =====");
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  const lines = s.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (/Date\.now\(\)\.toString\(\) \+ Math\.random\(\)\.toString\(36\)\.substr\(2, 5\)/.test(l)) {
      console.log(f.split("/").pop() + ":" + (i + 1) + ": " + l.trim().slice(0, 110));
    }
  });
}
console.log("\n===== /view? URL 拼接 =====");
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  const lines = s.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (/apiURL\(`\/view\?/.test(l)) {
      console.log(f.split("/").pop() + ":" + (i + 1) + ": " + l.trim().slice(0, 150));
    }
  });
}
console.log("\n===== FormData/upload 上传 =====");
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  const lines = s.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (/FormData\(\)/.test(l)) {
      console.log(f.split("/").pop() + ":" + (i + 1) + ": " + l.trim().slice(0, 110));
    }
  });
}
