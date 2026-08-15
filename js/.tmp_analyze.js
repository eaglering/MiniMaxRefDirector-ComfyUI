const fs = require("fs");
const d = "d:/workspace/ComfyUI_windows_portable/ComfyUI/custom_nodes/MiniMaxRefDirector-ComfyUI/js/components/director/";
const files = ["dom.js", "state.js", "media.js", "menus.js", "editing.js", "interaction.js", "render.js", "settings.js", "audio.js"];
for (const f of files) {
  const s = fs.readFileSync(d + f, "utf8");
  const lines = s.split(/\r?\n/);
  console.log("===== " + f + " (lines=" + lines.length + ") =====");
  // import 区（前 15 行）
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    console.log("  " + lines[i]);
  }
  // export 行
  lines.forEach((l, i) => {
    if (/^\s*export\s+(const|function|let|class|\{)/.test(l) || /^\s*export default/.test(l)) {
      console.log("  EX " + (i + 1) + ": " + l.trim().slice(0, 200));
    }
  });
}
// 统计重复模式
console.log("===== DUPLICATE PATTERNS =====");
const all = {};
for (const f of files) {
  const s = fs.readFileSync(d + f, "utf8");
  all[f] = s;
}
const patterns = [
  ["genId 模式", /Date\.now\(\)\.toString\(\) \+ Math\.random\(\)\.toString\(36\)\.substr\(2, 5\)/g],
  ["hideWidget 定义", /function hideWidget\(/g],
  ["showWidget 定义", /function showWidget\(/g],
  ["fetch(", /fetch\(/g],
  ["api\.fetchApi|api\.api", /api\.(fetchApi|api)/g],
  ["createElement", /createElement\(/g],
  ["innerHTML", /innerHTML/g],
  ["/view\\?", /\/view\?/g],
  ["debounce", /debounce/g],
  ["setTimeout", /setTimeout/g],
];
for (const [name, re] of patterns) {
  let total = 0;
  const per = {};
  for (const f of files) {
    const c = (all[f].match(re) || []).length;
    per[f] = c;
    total += c;
  }
  console.log(name + ": total=" + total + " " + JSON.stringify(per));
}
