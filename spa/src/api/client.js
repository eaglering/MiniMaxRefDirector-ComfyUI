// ===== API 客户端：apiBase 由入口节点通过 URL query 传入 =====
// 兼容 ComfyUI 子路径部署：节点侧用 api.apiURL("") 计算（形如 "/ComfyUI/"），
// SPA 兜底按当前页面相对路径推导。

function resolveApiBase() {
  const params = new URLSearchParams(location.search);
  const q = params.get("api_base");
  if (q !== null && q !== undefined) {
    try {
      return new URL(q, location.href).pathname.replace(/\/?$/, "/");
    } catch {
      /* ignore */
    }
  }
  // 页面位于 /extensions/<node>/spa/index.html → ComfyUI 根为 ../../../
  return new URL("../../..", location.href).pathname.replace(/\/?$/, "/");
}

export const apiBase = resolveApiBase();

const PREFIX = "minimax_ref/api";

function url(path) {
  return `${apiBase}${PREFIX}${path}`;
}

async function request(path, options = {}) {
  const resp = await fetch(url(path), options);
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const data = await resp.json();
      if (data && data.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return resp.json();
}

async function getJSON(path) {
  return request(path);
}

async function postJSON(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// ===== Spa state =====
export function fetchState(nodeId) {
  return getJSON(`/spa/state?node_id=${encodeURIComponent(nodeId)}`);
}
export function saveState(nodeId, state) {
  return postJSON("/spa/save", { node_id: nodeId, state });
}
export function fetchSkills() {
  return getJSON("/spa/skills");
}
export function saveSkills(skills) {
  return postJSON("/spa/skills", { skills });
}
export function fetchLlmFiles() {
  return getJSON("/spa/llm_files");
}
export function fetchRecords(limit = 200) {
  return getJSON(`/spa/records?limit=${limit}`);
}
export function deleteRecords(ids) {
  return postJSON("/spa/records/delete", { ids });
}
export function fetchConfig() {
  return getJSON("/config");
}

// ===== LLM（复用现有端点，显式传 opts） =====
export function generatePromptJson(payload) {
  return postJSON("/llm/generate_prompt_json", payload);
}
export function generateImageAnalysis(payload) {
  return postJSON("/llm/generate_image_analysis", payload);
}

// ===== 合并 =====
export function mergeVideos(paths) {
  return postJSON("/h3/merge_videos", { paths, source: "spa" });
}
export function mergeLatents(materials, opts = {}) {
  return postJSON("/h3/merge_latents", { materials, source: "spa", ...opts });
}

// ===== 媒体 =====
// 与 js/subject.js uploadFile 对齐：走 ComfyUI 原生 /upload/image。
export async function uploadImage(file, subfolder = "minimaxrefdirector") {
  const body = new FormData();
  body.append("image", file);
  body.append("subfolder", subfolder);
  body.append("overwrite", "true");
  const resp = await fetch(`${apiBase}upload/image`, { method: "POST", body });
  if (!resp.ok) throw new Error(`上传失败 (HTTP ${resp.status})`);
  const data = await resp.json();
  return data; // { name, subfolder, type }
}

export async function uploadAudio(file) {
  const body = new FormData();
  body.append("file", file);
  const resp = await fetch(url("/h3/upload_audio"), { method: "POST", body });
  if (!resp.ok) throw new Error(`音频上传失败 (HTTP ${resp.status})`);
  return resp.json();
}

// 视频也走 /upload/image（ComfyUI 对 input 上传通用，subject.js 的视频主体同款做法）
export function uploadVideo(file, subfolder = "minimaxrefdirector") {
  return uploadImage(file, subfolder);
}

// ===== 视图 URL（与 shared.js viewUrl 同规则） =====
export function viewUrl(fileKey, subfolder = "", type = "input") {
  const slash = fileKey.lastIndexOf("/");
  const fn = slash >= 0 ? fileKey.slice(slash + 1) : fileKey;
  const sf = slash >= 0 ? fileKey.slice(0, slash) : subfolder;
  return `${apiBase}view?filename=${encodeURIComponent(fn)}&type=${type}&subfolder=${encodeURIComponent(sf)}`;
}
