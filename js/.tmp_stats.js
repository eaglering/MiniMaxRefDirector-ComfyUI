const fs = require("fs");
const path = "d:/workspace/ComfyUI_windows_portable/ComfyUI/custom_nodes/MiniMaxRefDirector-ComfyUI/js/components/director/";
for (const f of fs.readdirSync(path)) {
  if (!f.endsWith(".js")) continue;
  const s = fs.readFileSync(path + f, "utf8");
  const lines = s.split(/\r?\n/);
  let mx = 0, mi = -1;
  lines.forEach((l, i) => { if (l.length > mx) { mx = l.length; mi = i + 1; } });
  console.log(f + ": lines=" + lines.length + " bytes=" + Buffer.byteLength(s) + " maxLine=" + mx + "@" + mi);
}
