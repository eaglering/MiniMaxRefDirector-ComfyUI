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
  // vite dev（热更新）：后端请求统一走 vite.config.js 的 server.proxy
  if (import.meta.env.DEV) return "/";
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

// 导出基础请求助手：llm.js 的 /spa/webchat/* 通道复用（与下方端点同规则）
export async function getJSON(path) {
  return request(path);
}

export async function postJSON(path, body) {
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

// 运行 / 取消工作流：经后端 send_sync 转发到 ComfyUI 页面执行
// （run = 工作流页面运行按钮；cancel = 中断当前执行）。需 ComfyUI 页面在线。
export function execWorkflow(action) {
  return postJSON("/spa/exec", { action });
}
export function saveState(nodeId, state, mirrorNodeId = "") {
  // mirrorNodeId：SPA 节点自身编号 —— 保存目标为旧导演节点时，同时落盘一份到
  // SPA 节点编号下（后端 spa_save 处理），保证 SPA 节点执行时磁盘兜底可取。
  const body = { node_id: nodeId, state };
  if (mirrorNodeId && String(mirrorNodeId) !== String(nodeId)) body.mirror_node_id = String(mirrorNodeId);
  return postJSON("/spa/save", body);
}
export function fetchLlmFiles() {
  return getJSON("/spa/llm_files");
}
export function fetchRecords(limit = 200) {
  return getJSON(`/spa/records?limit=${limit}`);
}
export function deleteRecords(ids, deleteFiles = false) {
  return postJSON("/spa/records/delete", { ids, delete_files: deleteFiles });
}
export function fetchConfig() {
  return getJSON("/config");
}
export function saveConfig(config) {
  return postJSON("/config", { config });
}

// ===== FastDirector-Desktop skill 词库（deepseek 分镜导入用） =====
// 无 name 时返回词库清单；有 name 时返回该 skill 的 prompt.md 全文
// （skill_keys 注入已废弃：storyboard-design 不再写入技能清单）
export function fetchSkillLibrary(name = "") {
  return getJSON(`/spa/skill_library${name ? `?name=${encodeURIComponent(name)}` : ""}`);
}

// ===== 镜头技能词典（SQLite：类别 + 技能 CRUD）=====
export function fetchSkillDict() {
  return getJSON("/spa/skill_dict");
}
export function addSkillDict(payload) {
  return postJSON("/spa/skill_dict/add", payload);
}
export function updateSkillDict(payload) {
  return postJSON("/spa/skill_dict/update", payload);
}
export function deleteSkillDict(id) {
  return postJSON("/spa/skill_dict/delete", { id });
}
export function addSkillCategory(payload) {
  return postJSON("/spa/skill_dict/category/add", payload);
}
export function updateSkillCategory(payload) {
  return postJSON("/spa/skill_dict/category/update", payload);
}
export function batchAddSkillDict(payload) {
  return postJSON("/spa/skill_dict/batch_add", payload);
}
// 技能选择 → skill_notes（后端唯一渲染源；服务端与网页桥接共用）
export function fetchSkillNotes(selections, lang = "zh") {
  return postJSON("/spa/skill_notes", { selections, lang });
}

// ===== 技能文档（md 提示词模板，SQLite skill_docs 表）=====
export function fetchSkillDocs(category = "") {
  return getJSON(`/spa/skill_docs${category ? `?category=${encodeURIComponent(category)}` : ""}`);
}
export function fetchSkillDoc({ id = 0, key = "" } = {}) {
  const q = [];
  if (id) q.push(`id=${id}`);
  if (key) q.push(`key=${encodeURIComponent(key)}`);
  return getJSON(`/spa/skill_doc?${q.join("&")}`);
}
export function addSkillDoc(payload) {
  return postJSON("/spa/skill_docs/add", payload);
}
export function updateSkillDoc(payload) {
  return postJSON("/spa/skill_docs/update", payload);
}
export function deleteSkillDoc(id) {
  return postJSON("/spa/skill_docs/delete", { id });
}

// ===== LLM（复用现有端点，显式传 opts） =====
export function generatePromptJson(payload) {
  return postJSON("/llm/generate_prompt_json", payload);
}
export function generateImageAnalysis(payload) {
  return postJSON("/llm/generate_image_analysis", payload);
}
// 纯文本生成（技能文档「生成提示词」等场景；system=文档内容，prompt=渲染后描述）
export function generateText(payload) {
  return postJSON("/llm/generate_text", payload);
}

// ===== 合并 =====
// 上传视频并登记为生成记录（视频生成记录页拖拽/手动上传，存 input/whatdreamscost/）
export async function uploadRecordVideo(file) {
  const body = new FormData();
  body.append("file", file);
  const resp = await fetch(url("/spa/records/upload_video"), { method: "POST", body });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.success) {
    throw new Error(data.error || `上传失败 (HTTP ${resp.status})`);
  }
  return data;
}

export function mergeVideos(paths) {
  return postJSON("/h3/merge_videos", { paths, source: "spa" });
}
export function mergeLatents(materials, opts = {}) {
  return postJSON("/h3/merge_latents", { materials, source: "spa", ...opts });
}
// 无损合并后台任务状态轮询（POST 立即返回 job_id，长任务不占用 HTTP 请求）
export function mergeLatentsStatus(jobId) {
  return getJSON(`/h3/merge_latents/status?job_id=${encodeURIComponent(jobId)}`);
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
