// ============================================================
// MiniMax Ref - 插件 / LoRA 依赖管理（Ext Manager）
//
// 「MiniMax Ref Ext Manager」工具节点：节点体挂「打开管理面板」按钮，
// 点击弹出可拖拽/缩放的管理面板（复用 components/director/modal.js 的
// RefModal）。面板展示当前工作流用到的自定义插件与模型引用：
//   - 已安装插件 → 一键 git pull 更新（需重启生效）；ComfyUI 内置 /
//     纯前端 UI 节点不会误报「缺失」；
//   - 工作流用到但本地缺失的插件 → 后端从 ComfyUI-Manager db 给出候选
//     仓库，一键 git clone 安装（需重启生效）；
//   - 模型引用按类型分组（LoRA / Checkpoint / Diffusion Model / UNet /
//     VAE，对应 models/<type> 目录）；缺失项经 ModelScope 仓库文件列举与
//     resolve 直链下载，落盘到对应类型目录。
// 后端路由：/minimax_ref/api/ext/*（见 ext_mgmt.py / server.py）。
// ============================================================
import { h, render } from "./vendor/preact.module.js";
import { useEffect, useState } from "./vendor/hooks.module.js";
import htm from "./vendor/htm.module.js";
import { t } from "./i18n.js";
import { RefModal } from "./components/director/modal.js";

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const html = htm.bind(h);

const EVT_OPEN = "minimax-ref:open-ext-manager";
const API_PREFIX = "minimax_ref/api/ext/";
const NODE_NAME = "MiniMaxRefExtManager";

function apiBase() {
  return (api && api.api_base) || "/";
}

async function callApi(path, payload) {
  const res = await fetch(apiBase() + API_PREFIX + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_e) {
    /* ignore */
  }
  if (!res.ok || !body || body.success !== true) {
    const msg = (body && (body.error || body.detail)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

function collectGraph() {
  const nodeClasses = [];
  const modelRefs = [];
  const seenClass = new Set();
  const seenRef = new Set();
  const MODEL_RE = /\.(safetensors|ckpt|pt|pth)\s*$/i;
  // widget 名 → 模型类型（loader 专用输入），与后端 MODEL_TYPES 一致
  const WNAME_TYPE = {
    lora_name: "loras",
    ckpt_name: "checkpoints",
    checkpoint_name: "checkpoints",
    unet_name: "unet",
    vae_name: "vae",
    model_name: "diffusion_models",
    diffusion_model_name: "diffusion_models",
  };
  // 值自带 models/ 子目录前缀（如 checkpoints/x.safetensors）时可直接判定
  const PREFIX_TYPE = [
    [/^loras?\//i, "loras"],
    [/^checkpoints?\//i, "checkpoints"],
    [/^diffusion_models?\//i, "diffusion_models"],
    [/^unet\//i, "unet"],
    [/^vae\//i, "vae"],
  ];
  // 依据节点 type / widget 名判定模型类型；无法判定的不收集（避免噪音与误归 LoRA）
  function classifyModel(type, wname, value) {
    for (const [re, mt] of PREFIX_TYPE) {
      if (re.test(value)) return mt;
    }
    const t = String(type || "");
    if (/^Lora|LoraLoader|Lora\b/i.test(t)) return "loras";
    if (/CheckpointLoader/i.test(t)) return "checkpoints";
    if (/DiffusionModel/i.test(t)) return "diffusion_models";
    if (/UNETLoader/i.test(t)) return "unet";
    if (/VAELoader/i.test(t)) return "vae";
    return WNAME_TYPE[wname] || null;
  }
  const g = app.graph;
  if (g && Array.isArray(g.nodes)) {
    for (const n of g.nodes) {
      if (!n) continue;
      const type = n.type || n.comfyClass || "";
      if (type && !seenClass.has(type)) {
        seenClass.add(type);
        nodeClasses.push(type);
      }
      if (!Array.isArray(n.widgets)) continue;
      for (const w of n.widgets) {
        if (!w) continue;
        // 从 widget 值中解析模型文件引用。字符串值直接取；另兼容「对象型」
        // slot widget——rgthree Power Lora Loader 每个槽位的值形如
        // {on, lora, strength}，仅收集 on !== false 的启用槽位（关闭的槽位
        // 不生效，不收集），其余对象值（如 header widget）忽略。
        const raw = w.value;
        const cands = [];
        if (typeof raw === "string") {
          cands.push(raw);
        } else if (
          raw && typeof raw === "object" &&
          typeof raw.lora === "string" && raw.on !== false
        ) {
          cands.push(raw.lora);
        }
        for (const v of cands) {
          if (!v || typeof v !== "string" || v.length > 400) continue;
          if (!MODEL_RE.test(v)) continue; // 只收集形似模型文件的值
          const wname = String((w && w.name) || "").toLowerCase();
          const mtype = classifyModel(type, wname, v);
          if (!mtype) continue;
          // 去掉已知类型目录前缀并统一分隔符，便于与 models/<type> 目录比对
          const clean = v.replace(/\\/g, "/").replace(
            /^(loras?|checkpoints?|diffusion_models?|unet|vae)\//i, "");
          if (!clean || !MODEL_RE.test(clean)) continue;
          const key = mtype + "\x00" + clean;
          if (!seenRef.has(key)) {
            seenRef.add(key);
            modelRefs.push({ name: clean, type: mtype });
          }
        }
      }
    }
  }
  // ---- 收集文件资源引用(LLM·GGUF / vae_approx),供缺失展示 ----
  const FILE_EXT_KIND = {
    ".gguf": "llm", ".bin": "llm", ".onnx": "llm",
  };
  // widget 值 → 归一相对路径或 null(仅字符串值;图像/视频/音频等其它形态不再识别)
  const normFileValue = (raw) => {
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s) return null;
    return { v: s };
  };
  const fileRefs = [];
  const seenFile = new Map(); // kind + "\x00" + 归一值 → true
  if (g && Array.isArray(g.nodes)) {
    for (const n of g.nodes) {
      if (!n || !Array.isArray(n.widgets)) continue;
      const type = String(n.type || n.comfyClass || "");
      for (const w of n.widgets) {
        const norm = normFileValue(w && w.value);
        if (!norm || !norm.v || norm.v.length > 500) continue;
        const v = norm.v;
        if (/^https?:/i.test(v)) continue;
        const dot = v.lastIndexOf(".");
        const ext = dot > 0 ? v.slice(dot).toLowerCase() : "";
        let kind = FILE_EXT_KIND[ext] || null;
        if (!kind && MODEL_RE.test(v)) {
          // 模型型文件(.safetensors/.ckpt/.pt/.pth)未被 model_refs 分类器收走
          // (非 loras/checkpoints/… 固定目录 loader)时,按 widget/节点名兜底:
          // tiny_vae / TAE 预览(近似)VAE → models/vae_approx
          const wn = String((w && w.name) || "").toLowerCase();
          const tn = String(type || "").toLowerCase();
          if (wn === "tiny_vae" || /tiny_vae|vae_approx|tinyautoencoder/.test(wn) ||
              /tae|tinyautoencoder/.test(tn)) {
            kind = "vae_approx";
          }
        }
        if (!kind) continue;
        const key = kind + "\x00" + v;
        if (seenFile.has(key)) continue;
        seenFile.set(key, true);
        fileRefs.push({ kind, name: v });
      }
    }
  }
  return {
    node_classes: nodeClasses,
    model_refs: modelRefs,
    file_refs: fileRefs,
  };
}

function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  if (bytes > 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

// 通用 action 按钮（loading 时禁用并显示进行中文本）
function ActBtn({ onClick, children, title, busy, disabled }) {
  return html`
    <button
      style=${{
        background: "linear-gradient(180deg,#2e3c52,#26313f)",
        color: "#d7dce4",
        border: "1px solid #3f4d61",
        borderRadius: "4px",
        fontSize: "11px",
        padding: "1px 8px",
        cursor: busy || disabled ? "default" : "pointer",
        opacity: busy || disabled ? "0.45" : "1",
        flexShrink: "0",
      }}
      title=${title || ""}
      disabled=${busy || disabled}
      onClick=${(e) => { e.stopPropagation(); if (!busy && !disabled && onClick) onClick(); }}
    >${children}${busy ? "…" : ""}</button>`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_e) {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_e2) {
    return false;
  }
}

function shortRepo(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/+$/, "");
  } catch (_e) {
    return url;
  }
}

// 外链(新标签打开仓库页)
function RepoLink({ url, children, title }) {
  if (!url) return null;
  return html`<a
    href=${url}
    target="_blank"
    rel="noreferrer noopener"
    title=${title || url}
    onClick=${(e) => e.stopPropagation()}
    style=${{
      color: "#60a5fa", fontSize: "10px", textDecoration: "none", cursor: "pointer",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      maxWidth: "150px", flexShrink: "0",
    }}
  >${children || url}</a>`;
}

// 复制按钮(带“已复制”瞬时反馈)
function CopyBtn({ text, small }) {
  const [copied, setCopied] = useState(false);
  const base = {
    flexShrink: "0", cursor: "pointer", border: "1px solid #3a4150", borderRadius: "3px",
    background: copied ? "rgba(52,211,153,0.18)" : "#242a35",
    color: copied ? "#34d399" : "#8a93a3",
    fontSize: small ? "9px" : "10px",
    lineHeight: "14px", padding: "0 5px",
  };
  return html`<button
    title=${t("ExtCopyUrl")}
    style=${base}
    onClick=${(e) => {
      e.stopPropagation();
      copyText(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    }}
  >${copied ? t("ExtCopied") : "⧉"}</button>`;
}

// 已装插件行:首行 状态点+目录名(✓=当前工作流用到)+[更新][安装依赖],
// 次行 github 地址链接+复制(或来源未知)。
// 「更新」= git pull(拉到新代码时自动重装依赖);「安装依赖」= 手动执行
// requirements.txt / install.bat(仓库提供时;非 git 手动安装也能装)。
function PluginRow({ p, pending, update, depsInstall }) {
  const repo = p.repoUrl || "";
  return html`<div style=${{ display: "flex", flexDirection: "column", gap: "1px", padding: "2px 3px", borderRadius: "3px", background: p.used ? "rgba(52,211,153,0.08)" : "transparent" }}>
    <div style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
      <span style=${{ width: "7px", height: "7px", borderRadius: "50%", background: p.used ? "#34d399" : "#8a93a3", flexShrink: 0, boxShadow: p.used ? "0 0 4px #34d399" : "none" }}></span>
      <span title=${p.folder} style=${{ flex: "0 1 auto", fontSize: "11px", color: p.used ? "#d7dce4" : "#8a93a3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${p.folder}${p.used ? " ✓" : ""}</span>
      <span style=${{ flex: "1 1 auto" }}></span>
      ${
        p.deps
          ? html`<${ActBtn} busy=${pending["deps:" + p.folder]} onClick=${() => depsInstall(p.folder)} title=${t("ExtDepsTitle")}>${t("ExtInstallDeps")}</${ActBtn}>`
          : null
      }
      ${
        p.updatable && repo
          ? html`<${ActBtn} busy=${pending["update:" + p.folder]} onClick=${() => update(p.folder, repo)} title=${repo}>${t("ExtUpdate")}</${ActBtn}>`
          : p.git
            ? html`<span style=${{ fontSize: "9px", color: "#8a93a3", border: "1px solid #3a4150", borderRadius: "3px", padding: "0 4px", lineHeight: "13px", flexShrink: "0" }}>git</span>`
            : null
      }
    </div>
    <div style=${{ display: "flex", alignItems: "center", gap: "4px", paddingLeft: "12px" }}>
      ${
        repo
          ? html`<${RepoLink} url=${repo}>${shortRepo(repo)}</${RepoLink}><${CopyBtn} text=${repo} small=${true} />`
          : html`<span title=${t("ExtSrcUnknown")} style=${{ fontSize: "10px", color: "#8a93a3", fontStyle: "italic" }}>${t("ExtSrcUnknown")}</span>`
      }
    </div>
  </div>`;
}

// 缺失插件行:候选仓库 select(可见 github 地址)+ 打开/复制/安装;
// 带 source 线索时(custom_nodes 里已有同名源码目录但未加载/.disabled)先提示
function MissingRow({ mp, pending, install }) {
  const [ref, setRef] = useState(
    mp.candidates && mp.candidates.length ? mp.candidates[0].reference : ""
  );
  const src = mp.source || null;
  const srcLine = src
    ? html`<div style=${{
        display: "flex", alignItems: "center", gap: "4px",
        fontSize: "9px", color: src.disabled ? "#fbbf24" : "#60a5fa",
        borderLeft: "2px solid " + (src.disabled ? "#fbbf24" : "#60a5fa"),
        paddingLeft: "6px", wordBreak: "break-all",
      }}>
        ${src.disabled ? t("ExtClueDisabled") : t("ExtCluePresent")}
        <span style=${{ fontFamily: "monospace" }}>${src.folder}</span>
      </div>`
    : null;
  if (!mp.candidates || !mp.candidates.length) {
    return html`<div style=${{ display: "flex", flexDirection: "column", gap: "2px", border: "1px solid rgba(248,113,113,0.2)", borderRadius: "4px", padding: "3px 4px" }}>
      <div style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span title=${mp.nodeClass} style=${{ color: "#f87171", fontSize: "11px", flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "200px" }}>${mp.nodeClass}</span>
        <span style=${{ fontSize: "10px", color: "#8a93a3" }}>${t("ExtNoCandidate")}</span>
      </div>
      ${srcLine}
    </div>`;
  }
  const pick = () => mp.candidates.find((c) => c.reference === ref) || mp.candidates[0];
  return html`<div style=${{ display: "flex", flexDirection: "column", gap: "2px", border: "1px solid rgba(248,113,113,0.25)", borderRadius: "4px", padding: "3px 4px" }}>
    ${srcLine}
    <div style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
      <span title=${mp.nodeClass} style=${{ color: "#f87171", fontSize: "11px", flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "200px" }}>${mp.nodeClass}</span>
      <span style=${{ flex: "1 1 auto" }}></span>
      <${ActBtn} busy=${pending["install:" + ref]} onClick=${() => install(pick())}>${t("ExtInstall")}</${ActBtn}>
    </div>
    <div style=${{ display: "flex", alignItems: "center", gap: "4px", paddingLeft: "8px" }}>
      <select
        value=${ref}
        onInput=${(e) => setRef(e.target.value)}
        style=${{
          flex: "1 1 auto", minWidth: "0", background: "#242a35", color: "#d7dce4",
          border: "1px solid #3a4150", borderRadius: "3px", fontSize: "10px", maxWidth: "230px",
        }}
        title=${ref}
      >${mp.candidates.map((c) => html`<option value=${c.reference}>${(c.title || c.reference) + (c.author ? " · " + c.author : "")}</option>`)}</select>
      <${RepoLink} url=${ref}>${t("ExtOpenRepo")}</${RepoLink}>
      <${CopyBtn} text=${ref} />
    </div>
  </div>`;
}

// 缺失模型行：行尾「搜索下载」按钮 → 内联关键词搜索 ModelScope →
// 候选仓库 → 列出模型文件 → 下载到 models/<mtype>（保留仓库内子目录）
function MissingModelRow({ m, mtype, pending, onDownload }) {
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState(
    () =>
      String(m.name || "")
        .replace(/\.(safetensors|ckpt|pt|pth)\s*$/i, "")
        .split("/")
        .pop() || ""
  );
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null); // null=未搜索 | 数组
  const [degraded, setDegraded] = useState(false);
  const [selId, setSelId] = useState(null); // 当前选中候选 modelId
  const [files, setFiles] = useState(null); // null=未列 | 数组
  const [err, setErr] = useState("");

  async function doSearch() {
    const q = kw.trim();
    if (!q) return;
    // 输入已是 owner/name 或 modelscope.cn 模型页链接时,直接按 ID 列文件
    // (不走关键词搜索——在线关键词搜索链路当前时常不可用,ID 直连可靠)
    const looksLikeId =
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(q) ||
      /modelscope\.cn\/models\//i.test(q);
    if (looksLikeId) {
      setSearching(true);
      setErr("");
      setResults(null);
      setDegraded(false);
      setFiles(null);
      setSelId(q);
      try {
        const b = await callApi("ms_files", { model_id: q });
        const fs = (b.files || []).filter(
          (f) => /\.(safetensors|ckpt|pt|pth)$/i.test(f.name) && f.type !== "tree"
        );
        setFiles(fs);
        if (!fs.length) setErr(t("ExtNoModelInRepo"));
      } catch (e2) {
        setErr(e2.message || String(e2));
      } finally {
        setSearching(false);
      }
      return;
    }
    setSearching(true);
    setErr("");
    setResults(null);
    setDegraded(false);
    setFiles(null);
    setSelId(null);
    try {
      const b = await callApi("ms_search", { query: q });
      setResults(b.results || []);
      setDegraded(!!b.degraded);
    } catch (e2) {
      setErr(e2.message || String(e2));
    } finally {
      setSearching(false);
    }
  }

  async function pickRepo(r) {
    setSelId(r.modelId);
    setFiles(null);
    setErr("");
    try {
      const b = await callApi("ms_files", { model_id: r.modelId });
      const fs = (b.files || []).filter(
        (f) => /\.(safetensors|ckpt|pt|pth)$/i.test(f.name) && f.type !== "tree"
      );
      setFiles(fs);
      if (!fs.length) setErr(t("ExtNoModelInRepo"));
    } catch (e2) {
      setErr(e2.message || String(e2));
    }
  }

  const openMsSearch = () => {
    const q = kw.trim();
    window.open(
      "https://modelscope.cn/search?search=" + encodeURIComponent(q || m.name),
      "_blank"
    );
  };

  return html`<div style=${{ display: "flex", flexDirection: "column", gap: "2px", paddingBottom: "2px" }}>
    <div style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
      <span style=${{ width: "7px", height: "7px", borderRadius: "50%", background: "#f87171", flexShrink: 0, boxShadow: "0 0 4px #f87171" }}></span>
      <span title=${m.name + (mtype ? "（models/" + mtype + "）" : "")} style=${{ fontSize: "11px", color: "#f87171", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "0 1 auto", maxWidth: "190px" }}>${m.name}</span>
      <span style=${{ fontSize: "10px", color: "#f87171", flexShrink: 0 }}>${t("ExtMissing")}</span>
      <span style=${{ flex: "1 1 auto" }}></span>
      <${ActBtn} title=${t("ExtSearchMs")} onClick=${() => setOpen((o) => !o)}>
        ${open ? "▾" : t("ExtSearchMs")}
      </${ActBtn}>
    </div>
    ${
      open
        ? html`<div style=${{ marginLeft: "13px", display: "flex", flexDirection: "column", gap: "4px", border: "1px solid rgba(96,165,250,0.3)", borderRadius: "4px", padding: "4px", background: "rgba(96,165,250,0.05)" }}>
            <div style=${{ display: "flex", alignItems: "center", gap: "4px" }}>
              <input
                value=${kw}
                onInput=${(e) => setKw(e.target.value)}
                onKeyDown=${(e) => { if (e.key === "Enter") doSearch(); }}
                style=${{
                  flex: "1 1 auto", minWidth: "80px", background: "#242a35", color: "#d7dce4",
                  border: "1px solid #3a4150", borderRadius: "3px", fontSize: "11px", padding: "1px 6px",
                }}
                placeholder=${t("ExtMsKwPlaceholder")}
              />
              <${ActBtn} onClick=${doSearch} busy=${searching}>${searching ? t("ExtSearching") : t("ExtSearchMs")}</${ActBtn}>
            </div>
            ${err ? html`<div style=${{ fontSize: "10px", color: "#f87171", wordBreak: "break-all" }}>${err}</div>` : null}
            ${!searching && results && results.length === 0
              ? html`<div style=${{ fontSize: "10px", color: "#8a93a3", display: "flex", flexDirection: "column", gap: "3px" }}>
                  <span>${degraded ? t("ExtMsDegraded") : t("ExtNoRepoFound")}</span>
                  <span><a href="#" style=${{ color: "#60a5fa" }} onClick=${(e) => { e.preventDefault(); openMsSearch(); }}>${t("ExtOpenMsSearch")} ↗</a></span>
                </div>`
              : null}
            ${results && results.length
              ? html`<div style=${{ fontSize: "10px", color: "#8a93a3" }}>${t("ExtPickRepo")}</div>
                <div style=${{ display: "flex", flexDirection: "column", gap: "1px", maxHeight: "120px", overflowY: "auto" }}>
                  ${results.map(
                    (r) => html`<div
                      key=${r.modelId}
                      onClick=${() => pickRepo(r)}
                      title=${r.description || r.url}
                      style=${{
                        display: "flex", alignItems: "center", gap: "5px", cursor: "pointer",
                        background: selId === r.modelId ? "rgba(96,165,250,0.18)" : "transparent",
                        borderRadius: "3px", padding: "1px 3px",
                      }}
                    >
                      <span style=${{
                        width: "6px", height: "6px", borderRadius: "50%", flexShrink: 0,
                        background: selId === r.modelId ? "#60a5fa" : "#3a4150",
                      }}></span>
                      <span style=${{ fontSize: "11px", color: selId === r.modelId ? "#d7dce4" : "#c3cad6", flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${r.title || r.modelId}</span>
                      <span style=${{ fontSize: "10px", color: "#8a93a3", flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${r.modelId}</span>
                      <a href=${r.url} target="_blank" rel="noreferrer noopener" style=${{ color: "#60a5fa", fontSize: "10px", textDecoration: "none", flexShrink: 0 }} onClick=${(e) => e.stopPropagation()}>↗</a>
                    </div>`
                  )}
                </div>`
              : null}
            ${selId && files
              ? html`<div style=${{ display: "flex", flexDirection: "column", gap: "2px", maxHeight: "140px", overflowY: "auto", borderTop: "1px dashed rgba(96,165,250,0.25)", paddingTop: "3px" }}>
                  ${files.map(
                    (f) => html`<div key=${mtype + ":" + f.path} style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <span title=${f.path} style=${{ fontSize: "11px", color: "#d7dce4", flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${f.name}</span>
                      <span style=${{ fontSize: "10px", color: "#8a93a3", flexShrink: 0 }}>${fmtSize(f.size)}</span>
                      <${ActBtn} busy=${pending["mdl:" + mtype + ":" + selId + ":" + f.path]} onClick=${() => onDownload(selId, f.path, mtype)}>${t("ExtDownload")}</${ActBtn}>
                    </div>`
                  )}
                </div>`
              : null}
          </div>`
        : null
    }
  </div>`;
}

// 文件资源行：存在=绿点；缺失=红点(仅提示,不提供替换操作)
function FileAssetRow({ a }) {
  return html`
    <div style=${{ display: "flex", alignItems: "center", gap: "6px", padding: "1px 2px" }}>
      <span style=${{
        width: "7px", height: "7px", borderRadius: "50%", flexShrink: 0,
        background: a.exists ? "#34d399" : "#f87171",
        boxShadow: a.exists ? "0 0 4px #34d399" : "0 0 4px #f87171",
      }}></span>
      <span title=${a.localPath || a.name} style=${{
        fontSize: "11px", color: a.exists ? "#c3cad6" : "#f87171",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        flex: "0 1 auto", maxWidth: "210px",
      }}>${a.name}</span>
      <span style=${{ fontSize: "10px", flexShrink: 0, color: a.exists ? "#34d399" : "#f87171" }}>${a.exists ? t("ExtOk") : t("ExtMissing")}</span>
      <span style=${{ flex: "1 1 auto" }}></span>
    </div>
    ${!a.exists && a.localPath
      ? html`<div style=${{ fontSize: "9px", color: "#8a93a3", paddingLeft: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${a.localPath}</div>`
      : null}
  `;
}

// 模型类型分组元数据(type 与后端 MODEL_TYPES 一致,顺序即展示顺序)
const MODEL_GROUPS = [
  { type: "loras", labelKey: "ExtTypeLoras" },
  { type: "checkpoints", labelKey: "ExtTypeCheckpoints" },
  { type: "diffusion_models", labelKey: "ExtTypeDiffusionModels" },
  { type: "unet", labelKey: "ExtTypeUnet" },
  { type: "vae", labelKey: "ExtTypeVae" },
];

// 文件资源分组(与后端 FILE_KINDS 一致,顺序即展示顺序)
const FILE_GROUPS = [
  { kind: "llm", labelKey: "ExtFileLlm", noteKey: "ExtFileDirLlm" },
  { kind: "vae_approx", labelKey: "ExtFileVaeApprox", noteKey: "ExtFileDirVaeApprox" },
];

// ---------------- 主面板组件 ----------------
function ExtManagerRoot() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(""); // 操作反馈（成功/失败）
  // 进行中操作标记：install:<url> / update:<folder> / download:<path>
  const [pending, setPending] = useState({});
  const [msModelId, setMsModelId] = useState("");
  const [msFiles, setMsFiles] = useState(null); // null=未浏览
  const [msBusy, setMsBusy] = useState(false);
  const [msTarget, setMsTarget] = useState("loras"); // 手填区下载保存路径(相对 models/)
  const [rsBusy, setRsBusy] = useState(false); // 重启按钮进行中（弹窗顶栏）
  // llama-cpp-python 自动安装（Python 依赖区常驻；从 GitHub release 自动下载
  // 匹配的预编译 wheel，无需附加 pip 参数）
  const [pipBusy, setPipBusy] = useState(false);
  const [pipTail, setPipTail] = useState(""); // pip 输出尾部
  const [showTrace, setShowTrace] = useState(false); // 扫描归属诊断折叠

  async function refresh() {
    setBusy(true);
    setStatus("");
    try {
      const cg = collectGraph();
      const body = await callApi("scan", cg);
      setData(body.data || null);
    } catch (e) {
      setStatus("扫描失败：" + (e.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onOpen = () => {
      setMsFiles(null);
      setMsModelId("");
      setStatus("");
      refresh();
      setOpen(true);
    };
    window.addEventListener(EVT_OPEN, onOpen);
    return () => window.removeEventListener(EVT_OPEN, onOpen);
  }, []);

  async function runAct(key, path, payload, okText) {
    setPending((p) => ({ ...p, [key]: true }));
    setStatus("");
    try {
      const body = await callApi(path, payload);
      const extra = body.data ? (body.data.output || body.data.folder || body.data.name || "") : "";
      setStatus(okText + (extra ? "：" + String(extra) : ""));
      // 装/卸后刷新（补 plugin/lora 状态）
      await refresh();
    } catch (e) {
      setStatus("操作失败：" + (e.message || e));
    } finally {
      setPending((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
    }
  }

  const install = (ref) =>
    runAct("install:" + ref.reference, "install", { url: ref.reference }, "安装完成");
  const update = (folder, url) =>
    runAct("update:" + folder, "update", { folder }, "更新完成");
  const depsInstall = (folder) =>
    runAct("deps:" + folder, "deps_install", { folder }, "依赖安装完成");
  const clearRestart = async () => {
    try {
      await callApi("clear_restart", {});
      await refresh();
    } catch (_e) {
      /* ignore */
    }
  };
  const listMsFiles = async () => {
    if (!msModelId.trim()) {
      setStatus("请先填写 ModelScope 模型 ID / 链接");
      return;
    }
    setMsBusy(true);
    setStatus("");
    try {
      const body = await callApi("ms_files", { model_id: msModelId.trim() });
      const files = (body.files || []).filter(
        (f) => /\.(safetensors|ckpt|pt|pth)$/i.test(f.name) && f.type !== "tree"
      );
      setMsFiles(files);
      if (!files.length) setStatus("该仓库未找到 .safetensors / .ckpt 等模型文件");
    } catch (e) {
      setStatus("列举失败：" + (e.message || e));
    } finally {
      setMsBusy(false);
    }
  };
  const downloadMs = (f) =>
    runAct(
      "dl:" + (msTarget || "loras") + ":" + f.path,
      "ms_download",
      {
        model_id: msModelId.trim(),
        file_path: f.path,
        target_dir: msTarget || "loras",
      },
      "下载完成"
    );
  // 缺失模型行内搜索下载：modelId + 仓库内文件路径 + 目标模型类型
  // （后端按 model_type 落盘到 models/<type>[/仓库内子目录]）
  const downloadTo = (modelId, filePath, modelType) =>
    runAct(
      "mdl:" + (modelType || "loras") + ":" + modelId + ":" + filePath,
      "ms_download",
      {
        model_id: modelId,
        file_path: filePath,
        model_type: modelType || "loras",
      },
      "下载完成"
    );
  // 软重启：后端拉起同参新进程后自动退出（成功后进程短暂不可用，勿再 refresh）
  const doRestart = async () => {
    if (!window.confirm("确定要重启 ComfyUI 吗？正在进行的任务会被中断。")) return;
    setRsBusy(true);
    setStatus("");
    try {
      const b = await callApi("restart", {});
      const scheduled = !!(b.data && b.data.scheduled);
      setStatus(scheduled ? t("ExtRestartDoing") : "重启指令发送失败，请手动重启。");
    } catch (e) {
      setStatus("重启失败：" + (e.message || e));
    } finally {
      setRsBusy(false);
    }
  };
  // llama-cpp-python pip 安装（Python 依赖区常驻；耗时请求由后端 to_thread 执行）
  const pipInstall = async () => {
    if (pipBusy) return;
    setPipBusy(true);
    setStatus("");
    setPipTail("");
    try {
      const b = await callApi("pip_install", { pkg: "llama-cpp-python" });
      const d = b.data || {};
      const tail = (d.tail || "").trim();
      const head = d.ok ? t("ExtPipOk") : t("ExtPipFail");
      setPipTail(head + (tail ? "\n" + tail : ""));
      setStatus(head + "：llama-cpp-python");
    } catch (e) {
      setPipTail("");
      setStatus("pip 安装失败：" + (e.message || e));
    } finally {
      setPipBusy(false);
    }
  };

  // 「详情」：拉取后端对该 class 的完整归属判定链路（归属排障用）
  const debugClassDetail = async (c) => {
    try {
      const b = await callApi("debug_class", { c });
      window.alert(JSON.stringify(b.data || b, null, 2));
    } catch (e) {
      window.alert("详情获取失败：" + (e.message || e));
    }
  };

  const plugins = data ? data.plugins || [] : [];
  const missingPlugins = data ? data.missingPlugins || [] : [];
  const models = (data && data.models) || {};
  const modelTotal = MODEL_GROUPS.reduce(
    (sum, g) => sum + ((models[g.type] || []).length || 0), 0
  );

  return html`
    <${RefModal}
      open=${open}
      title=${t("ExtManagerTitle")}
      width=${880}
      height=${640}
      onClose=${() => setOpen(false)}
      help=${t("ExtManagerHint")}
    >
      <div style=${{ display: "flex", flexDirection: "column", gap: "6px", minHeight: 0, flex: "1 1 auto" }}>
        <div style=${{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <${ActBtn} onClick=${refresh} busy=${busy}>${t("ExtScanBtn")}</${ActBtn}>
          <${ActBtn} onClick=${doRestart} busy=${rsBusy} title=${t("ExtRestartBtnHint")}>${t("ExtRestartBtn")}</${ActBtn}>
          <span style=${{ fontSize: "10px", color: "#8a93a3", wordBreak: "break-all" }}>
            ${data ? data.customNodesDir : ""}
          </span>
          ${data && data.pendingRestart
            ? html`<span style=${{ color: "#fbbf24", fontSize: "11px" }}>${t("ExtRestartHint")}
                <a href="#" style=${{ color: "#fbbf24" }} onClick=${(e) => { e.preventDefault(); clearRestart(); }}>${t("ExtDismiss")}</a>
              </span>`
            : null}
        </div>

        ${busy
          ? html`<div style=${{ fontSize: "11px", color: "#60a5fa" }}>${t("ExtScanning")}</div>`
          : status
            ? html`<div style=${{ fontSize: "11px", color: status.startsWith("操作失败") || status.startsWith("扫描失败") || status.startsWith("列举失败") || status.startsWith("替换失败") || status.startsWith("pip 安装失败") ? "#f87171" : "#34d399", wordBreak: "break-all" }}>${status}</div>`
            : null}

        <div style=${{ display: "flex", flex: "1 1 auto", gap: "12px", minHeight: "0", flexWrap: "wrap" }}>
          <!-- 左侧：插件（整列独立滚动，标题固定） -->
          <section style=${{ flex: "1 1 46%", minWidth: "300px", minHeight: "0", display: "flex", flexDirection: "column", gap: "4px" }}>
            <div style=${{ fontSize: "12px", fontWeight: 600, color: "#d7dce4", borderBottom: "1px solid #3a4150", paddingBottom: "2px", flexShrink: "0" }}>
              ${t("ExtPlugins")}（${plugins.length}）
            </div>
            <div style=${{ flex: "1 1 auto", minHeight: "0", overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px" }}>
              ${missingPlugins.length
                ? html`<div style=${{ fontSize: "11px", color: "#f87171" }}>${t("ExtMissingPlugins")}：</div>
                  <div style=${{ display: "flex", flexDirection: "column", gap: "3px" }}>
                    ${missingPlugins.map(
                      (mp) => html`<${MissingRow} key=${mp.nodeClass} mp=${mp} pending=${pending} install=${install} />`
                    )}
                  </div>`
                : null}

              <div style=${{ fontSize: "11px", color: "#34d399" }}>${t("ExtWorkflowUsed")}（${plugins.filter((p) => p.used).length}）：</div>
              <div style=${{ display: "flex", flexDirection: "column", gap: "2px", border: "1px solid #333c49", borderRadius: "4px", padding: "3px" }}>
                ${plugins
                  .filter((p) => p.used)
                  .map((p) => html`<${PluginRow} key=${p.folder} p=${p} pending=${pending} update=${update} depsInstall=${depsInstall} />`)}
              </div>
              <div style=${{ fontSize: "11px", color: "#60a5fa" }}>${t("ExtPyDeps")}：</div>
              <div style=${{ display: "flex", flexDirection: "column", gap: "4px", border: "1px dashed #3a5a8a", borderRadius: "4px", padding: "4px 5px", background: "rgba(96,165,250,0.05)" }}>
                <div style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style=${{ fontSize: "10px", color: "#60a5fa", flexShrink: "0", fontFamily: "monospace" }}>llama-cpp-python</span>
                  ${data && data.llamaCpp
                    ? data.llamaCpp.ok
                      ? html`<span
                          title=${data.llamaCpp.gpu === false ? t("ExtLlamaCpuHint") : ""}
                          style=${{
                            fontSize: "9px", flexShrink: "0", borderRadius: "3px", padding: "0 4px", lineHeight: "13px",
                            color: data.llamaCpp.gpu === false ? "#fbbf24" : "#34d399",
                            border: "1px solid " + (data.llamaCpp.gpu === false ? "rgba(251,191,36,0.4)" : "rgba(52,211,153,0.4)"),
                          }}
                        >v${data.llamaCpp.version || "?"} · ${data.llamaCpp.gpu === true ? t("ExtLlamaCuda") : data.llamaCpp.gpu === false ? t("ExtLlamaCpu") : "GPU:?"}</span>`
                      : html`<span style=${{ fontSize: "9px", flexShrink: "0", color: "#f87171", border: "1px solid rgba(248,113,113,0.4)", borderRadius: "3px", padding: "0 4px", lineHeight: "13px" }}>${t("ExtLlamaMissing")}</span>`
                    : null}
                  <span style=${{ flex: "1 1 auto" }}></span>
                  <${ActBtn} onClick=${pipInstall} busy=${pipBusy} title=${t("ExtPipHint")}>${t("ExtPipInstall")}</${ActBtn}>
                </div>
                ${pipBusy
                  ? html`<div style=${{ fontSize: "10px", color: "#60a5fa" }}>${t("ExtPipBusy")}</div>`
                  : pipTail
                    ? html`<div style=${{ maxHeight: "72px", overflowY: "auto", fontSize: "9px", color: pipTail.startsWith(t("ExtPipOk")) ? "#34d399" : "#f87171", wordBreak: "break-all", whiteSpace: "pre-wrap", lineHeight: "13px", opacity: "0.95" }}>${pipTail}</div>`
                    : null}
              </div>
              <!-- 扫描归属诊断：当前工作流各节点 class 的归属（builtin/ui 省略） -->
              ${data && data.trace
                ? (() => {
                    const entries = Object.entries(data.trace).filter(
                      ([, r]) => r !== "builtin" && r !== "ui"
                    );
                    if (!entries.length) return null;
                    return html`
                      <div title=${t("ExtDebugHint")} style=${{ border: "1px solid #333c49", borderRadius: "4px", padding: "2px 4px", marginTop: "1px" }}>
                        <div
                          style=${{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", userSelect: "none" }}
                          onClick=${() => setShowTrace((s) => !s)}
                        >
                          <span style=${{ fontSize: "10px", color: "#8a93a3" }}>${t("ExtDebug")}（${entries.length}）</span>
                          <span style=${{ flex: "1 1 auto" }}></span>
                          <span style=${{ fontSize: "9px", color: "#8a93a3" }}>${showTrace ? "▾" : "▸"}</span>
                        </div>
                        ${showTrace
                          ? html`<div style=${{ maxHeight: "130px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "1px", paddingTop: "2px", borderTop: "1px dashed #333c49" }}>
                              ${entries.map(
                                ([c, reason]) => html`<div key=${c} style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
                                  <span title=${c} style=${{ fontSize: "9px", color: "#c3cad6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "0 1 auto", maxWidth: "200px" }}>${c}</span>
                                  <span style=${{ flex: "1 1 auto" }}></span>
                                  <span style=${{ fontSize: "9px", flexShrink: "0", color: reason === "missing" ? "#f87171" : "#34d399" }}>${reason}</span>
                                  <a
                                    href="#"
                                    title=${t("ExtDebugHint")}
                                    style=${{ fontSize: "9px", color: "#8a93a3", textDecoration: "none", flexShrink: "0", border: "1px solid #3a4150", borderRadius: "2px", padding: "0 3px", lineHeight: "12px", cursor: "pointer" }}
                                    onClick=${(e) => { e.preventDefault(); e.stopPropagation(); debugClassDetail(c); }}>${t("ExtDebugDetail")}</a>
                                </div>`
                              )}
                            </div>`
                          : null}
                      </div>`;
                  })()
                : null}
            </div>
          </section>

          <!-- 右侧：工作流模型引用（按类型分组）+ ModelScope 手填下载 -->
          <section style=${{ flex: "1 1 46%", minWidth: "300px", minHeight: "0", display: "flex", flexDirection: "column", gap: "4px" }}>
            <div style=${{ fontSize: "12px", fontWeight: 600, color: "#d7dce4", borderBottom: "1px solid #3a4150", paddingBottom: "2px", flexShrink: "0" }}>
              ${t("ExtModelRefs")}（${modelTotal}）
            </div>

            <!-- ModelScope 手填下载：常驻顶部，避免引用为空/很长时被挤到面板底部 -->
            <div style=${{ flexShrink: "0", display: "flex", flexDirection: "column", gap: "3px", border: "1px solid #3a4150", borderRadius: "4px", padding: "4px 5px", background: "rgba(96,165,250,0.06)" }}>
              <div style=${{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
                <input
                  value=${msModelId}
                  onInput=${(e) => setMsModelId(e.target.value)}
                  onKeyDown=${(e) => { if (e.key === "Enter") listMsFiles(); }}
                  placeholder=${t("ExtMsPlaceholder")}
                  style=${{
                    flex: "1 1 auto", minWidth: "120px", background: "#242a35", color: "#d7dce4",
                    border: "1px solid #3a4150", borderRadius: "3px", fontSize: "11px", padding: "2px 6px",
                  }}
                />
                <${ActBtn} onClick=${listMsFiles} busy=${msBusy}>${t("ExtMsList")}</${ActBtn}>
                <a
                  href="#"
                  title=${t("ExtOpenMsSearch")}
                  style=${{ color: "#60a5fa", fontSize: "10px", textDecoration: "none", flexShrink: 0, alignSelf: "center" }}
                  onClick=${(e) => {
                    e.preventDefault();
                    window.open(
                      "https://modelscope.cn/search?search=" +
                        encodeURIComponent(msModelId.trim() || ""),
                      "_blank"
                    );
                  }}
                >${t("ExtOpenMsSearch")} ↗</a>
              </div>
              <div style=${{ display: "flex", gap: "4px", alignItems: "center" }}>
                <span style=${{ fontSize: "10px", color: "#8a93a3", flexShrink: "0", fontFamily: "monospace" }}>models/</span>
                <input
                  value=${msTarget}
                  onInput=${(e) => setMsTarget(e.target.value)}
                  title=${t("ExtMsSaveTo")}
                  placeholder=${t("ExtMsSaveTo")}
                  style=${{
                    flex: "1 1 auto", minWidth: "0", background: "#242a35", color: "#d7dce4",
                    border: "1px solid #3a4150", borderRadius: "3px", fontSize: "11px", padding: "2px 6px",
                  }}
                />
              </div>
              ${msFiles
                ? html`<div style=${{ minHeight: "0", maxHeight: "130px", overflowY: "auto", borderTop: "1px dashed rgba(96,165,250,0.25)", paddingTop: "3px", display: "flex", flexDirection: "column", gap: "2px" }}>
                    ${msFiles.map(
                      (f) => html`<div key=${f.path} style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style=${{ fontSize: "11px", color: "#d7dce4", flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title=${f.path}>${f.name}</span>
                        <span style=${{ fontSize: "10px", color: "#8a93a3", flexShrink: "0" }}>${fmtSize(f.size)}</span>
                        <${ActBtn} busy=${pending["dl:" + (msTarget || "loras") + ":" + f.path]} onClick=${() => downloadMs(f)}>${t("ExtDownload")}</${ActBtn}>
                      </div>`
                    )}
                    <div style=${{ fontSize: "10px", color: "#8a93a3" }}>${t("ExtMsHint")}</div>
                  </div>`
                : html`<div style=${{ fontSize: "10px", color: "#8a93a3", lineHeight: "14px", opacity: "0.9" }}>${t("ExtMsEmpty")}</div>`}
            </div>

            <!-- 引用分组（整体滚动） -->
            <div style=${{ flex: "1 1 auto", minHeight: "0", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              ${MODEL_GROUPS.map(
                (grp) => {
                  const rows = models[grp.type] || [];
                  if (!rows.length) return null;
                  return html`
                    <div key=${grp.type} style=${{ display: "flex", flexDirection: "column", gap: "2px", minHeight: "0" }}>
                      <div style=${{ display: "flex", alignItems: "center", gap: "6px", borderBottom: "1px dashed #333c49", paddingBottom: "1px" }}>
                        <span style=${{ fontSize: "11px", color: "#60a5fa", fontWeight: 600, flexShrink: "0" }}>${t(grp.labelKey)}</span>
                        <span style=${{ fontSize: "9px", color: "#8a93a3", flexShrink: "0" }}>models/${grp.type}</span>
                        <span style=${{ flex: "1 1 auto" }}></span>
                        <span style=${{ fontSize: "10px", color: "#8a93a3", flexShrink: "0" }}>${t("ExtRefs")} ${rows.length} · ${t("ExtMissingN")} ${rows.filter((r) => !r.exists).length}</span>
                      </div>
                      <div style=${{ display: "flex", flexDirection: "column", gap: "1px", border: "1px solid #333c49", borderRadius: "4px", padding: "2px 3px" }}>
                        ${rows.map(
                          (r) =>
                            r.exists
                              ? html`<div key=${r.name} style=${{ display: "flex", flexDirection: "column", gap: "0px", padding: "1px 2px" }}>
                                  <div style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
                                    <span style=${{ width: "7px", height: "7px", borderRadius: "50%", background: "#34d399", flexShrink: 0, boxShadow: "0 0 4px #34d399" }}></span>
                                    <span title=${r.name} style=${{ fontSize: "11px", color: "#d7dce4", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto" }}>${r.name}</span>
                                    <span style=${{ fontSize: "10px", color: "#34d399", flexShrink: "0" }}>${t("ExtOk")}</span>
                                  </div>
                                  ${r.localPath
                                    ? html`<div title=${t("ExtLocalPath") + "：" + r.localPath} style=${{ fontSize: "9px", color: "#8a93a3", paddingLeft: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${r.localPath}</div>`
                                    : null}
                                </div>`
                              : html`<${MissingModelRow} key=${r.name} m=${r} mtype=${grp.type} pending=${pending} onDownload=${downloadTo} />`
                        )}
                      </div>
                    </div>`;
                }
              )}
              ${FILE_GROUPS.map(
                (grp) => {
                  const rows = (data && data.files && data.files[grp.kind]) || [];
                  if (!rows.length) return null;
                  const missingN = rows.filter((r) => !r.exists).length;
                  return html`
                    <div key=${grp.kind} style=${{ display: "flex", flexDirection: "column", gap: "2px", minHeight: "0" }}>
                      <div style=${{ display: "flex", alignItems: "center", gap: "6px", borderBottom: "1px dashed #333c49", paddingBottom: "1px" }}>
                        <span style=${{ fontSize: "11px", color: "#60a5fa", fontWeight: 600, flexShrink: "0" }}>${t(grp.labelKey)}</span>
                        <span style=${{ fontSize: "9px", color: "#8a93a3", flexShrink: "0" }}>${t(grp.noteKey)}</span>
                        <span style=${{ flex: "1 1 auto" }}></span>
                        <span style=${{ fontSize: "10px", color: "#8a93a3", flexShrink: "0" }}>${t("ExtRefs")} ${rows.length} · ${t("ExtMissingN")} ${missingN}</span>
                      </div>
                      <div style=${{ display: "flex", flexDirection: "column", gap: "1px", border: "1px solid #333c49", borderRadius: "4px", padding: "2px 3px" }}>
                        ${rows.map(
                          (r) => html`<${FileAssetRow} key=${grp.kind + ":" + r.name} a=${r} />`
                        )}
                      </div>
                    </div>`;
                }
              )}
            </div>
          </section>
        </div>
      </div>
    </${RefModal}>
  `;
}

let rootHost = null;
function ensureHost() {
  if (!rootHost) {
    rootHost = document.createElement("div");
    rootHost.id = "minimax-ref-ext-manager-host";
    document.body.appendChild(rootHost);
    render(html`<${ExtManagerRoot} />`, rootHost);
  }
}

function openManager() {
  ensureHost();
  window.dispatchEvent(new Event(EVT_OPEN));
}

// 节点体按钮（addDOMWidget 挂 DOM button）
function addManagerButton(node) {
  try {
    const container = document.createElement("div");
    container.style.cssText =
      "padding:4px 6px;min-width:200px;";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = t("ExtOpenBtn");
    btn.title = t("ExtOpenBtnHint");
    btn.style.cssText =
      "cursor:pointer;background:linear-gradient(180deg,#2e3c52,#26313f);" +
      "color:#d7dce4;border:1px solid #3f4d61;border-radius:5px;padding:5px 8px;" +
      "font-size:12px;white-space:nowrap;width:100%;text-align:center;user-select:none;";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openManager();
    });
    container.appendChild(btn);
    const widget = node.addDOMWidget("ext_manager_btn", "ext_manager_btn", container, {
      getValue() {
        return "";
      },
      setValue() {
        /* noop */
      },
      hideOnZoom: false,
    });
    widget.label = "";
    widget.serialize = false;
  } catch (err) {
    console.error("[MiniMaxRefExtManager] addDOMWidget failed", err);
  }
}

app.registerExtension({
  name: "MiniMaxRef ExtManager",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== NODE_NAME) return;
    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const r = orig ? orig.apply(this, args) : undefined;
      try {
        addManagerButton(this);
      } catch (err) {
        console.error("[MiniMaxRefExtManager] hook failed", err);
      }
      return r;
    };
  },
});
