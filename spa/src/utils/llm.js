// ===== LLM 调用分发：网页桥接（deepseek / doubao / qianwen）走后端 CDP 通道，其余走服务端 =====
// 网页桥接实现：lib/webchat_cdp.py（Playwright connect_over_cdp 附加用户真实 Chrome），
// SPA 经 HTTP /spa/webchat/* 调用，不再依赖浏览器扩展（extension/ 仅保留向后兼容）。
import { generatePromptJson, getJSON, postJSON } from "../api/client.js";

// vlm_mode → 桥接站点（qianwen-proxy 为对外名，qwen-proxy 兼容旧配置）
export const PROXY_SITES = {
  "deepseek-proxy": "deepseek",
  "doubao-proxy": "doubao",
  "qianwen-proxy": "qwen",
  "qwen-proxy": "qwen",
};

export const SITE_LABELS = { deepseek: "DeepSeek", doubao: "豆包", qwen: "千问" };

// CDP 端点（全局默认）：由设置面板 / 导入弹窗在打开时同步（setCdpEndpoint）。
// 未设置时后端使用默认 http://127.0.0.1:9222。
let _cdpEndpoint = "";
export function setCdpEndpoint(endpoint) {
  _cdpEndpoint = String(endpoint || "").trim();
}
function cdpEndpointOf(opts) {
  const ep = String((opts && (opts.cdpEndpoint ?? opts.cdp_endpoint)) || "").trim();
  return ep || _cdpEndpoint;
}

// 统一 complete 调用（带超时中断）
async function webchatComplete({
  site = "deepseek",
  system = "",
  prompt = "",
  expectJson = false,
  sessionMode = "new",
  chatId = "",
  cdpEndpoint = "",
  timeoutMs = 300_000,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const data = await postJSON("/spa/webchat/complete", {
      site,
      system,
      prompt,
      expect_json: expectJson,
      session_mode: sessionMode,
      chat_id: chatId,
      cdp_endpoint: cdpEndpoint || _cdpEndpoint,
    });
    return {
      ok: !!data.ok,
      text: String(data.text || ""),
      chat_id: String(data.chatId || ""),
      error: String(data.error || ""),
    };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return {
      ok: false,
      text: "",
      chat_id: "",
      error: aborted ? `网页会话请求超时（${Math.round(timeoutMs / 1000)}s）` : e.message || String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function throwCompleteError(resp, site) {
  const label = SITE_LABELS[site] || site;
  const hint = /超时/.test(resp?.error || "")
    ? "（可点「页面自检」确认 Chrome 调试端口与站点登录状态）"
    : "";
  throw new Error(`${resp?.error || `${label} 桥接调用失败`}${hint}`);
}

/**
 * 生成 H3 提示词 JSON。
 * @param {object} opts LLM 配置 {mode, gguf_path, mmproj_path, provider, api_key,
 *   ollama_model, ollama_base_url, cdp_endpoint}
 * @param {object} payload {prompt, duration_seconds, lang, image_path,
 *   skill_notes, selections, chat_id}
 * @returns {Promise<{success:boolean, json_data?:object, error?:string}>}
 */
// 所选技能必须出现（三通道共用校验）：逐条校验关键词在 detailed_description 中，
// 缺失时用 retryFn(missing) 纠正重试一次，仍缺则返回 stillMissing（不静默吞掉）
async function ensureRequiredTerms(json_data, required, retryFn) {
  const req = Array.isArray(required)
    ? required.map((t) => String(t || "").trim()).filter(Boolean)
    : [];
  const missingTerms = (json) =>
    req.filter((t) => !String(json?.detailed_description || "").includes(t));
  let stillMissing = missingTerms(json_data);
  if (stillMissing.length && retryFn) {
    try {
      const j2 = await retryFn(stillMissing);
      if (j2) json_data = j2;
    } catch {
      // 重试失败：保留首次结果，下面如实告警
    }
    stillMissing = missingTerms(json_data);
  }
  return { json_data, stillMissing };
}

// 技能缺失纠正追问的公共文案
function requiredTermsCorrectionPrompt(missing) {
  return (
    "\n\n上一次输出漏掉了以下必选技能，它们必须原样出现在 detailed_description 中：\n" +
    missing.map((t) => `- ${t}`).join("\n") +
    "\n请重新输出完整 JSON（保持原有镜头内容，只补上这些技能带来的动作/术语/运镜描写）。"
  );
}

export async function generateH3Prompt(opts, payload) {
  const mode = opts?.mode || "llama-server";
  const site = PROXY_SITES[mode];
  if (site) {
    return webChatGenerateH3(opts, payload, site);
  }
  // 服务端三种模式：显式透传 opts（llama-server 为新模式名，后端归一化旧值 llama-cpp）
  const body = {
    ...payload,
    vlm_mode: mode === "api" ? "api" : mode === "ollama" ? "ollama" : "llama-server",
    gguf_path: opts.gguf_path || "",
    mmproj_path: opts.mmproj_path || "",
    provider: opts.provider || "",
    api_key: opts.api_key || "",
    ollama_model: opts.ollama_model || "",
    ollama_base_url: opts.ollama_base_url || "",
  };
  const resp = await generatePromptJson(body);
  if (!resp?.success) return resp;
  // 前端兜底清洗（后端 prompt.py 已做 normalize；旧后端/重试路径可能漏网）
  resp.json_data = normalizeH3Json(resp.json_data);
  // 服务端模式同样做 required_terms 校验（与网页通道一致，缺失纠正重试一次）
  if (Array.isArray(payload?.required_terms) && payload.required_terms.length) {
    const { json_data, stillMissing } = await ensureRequiredTerms(
      resp.json_data,
      payload.required_terms,
      async (missing) => {
        const r = await generatePromptJson({
          ...body,
          prompt: String(payload.prompt || "") + requiredTermsCorrectionPrompt(missing),
        });
        return r?.success ? normalizeH3Json(r.json_data) : null;
      },
    );
    resp.json_data = json_data;
    if (stillMissing.length) {
      resp.warning = `以下所选技能未出现在生成结果中：${stillMissing.join("、")}（可重新生成或手动补充）`;
    }
  }
  return resp;
}

// H3 提示词生成（网页桥接通道）——与后端 generate_h3_prompt 的产出结构对齐。
// 写作规则单一来源：h3-writing-guide（DB 技能文档，前端经 /spa/skill_doc 拉取），
// 本常量只保留网页通道特有规则（JSON-only / 标签格式 / 语言跟随 / 受保护片段）。
// 不预设技能类别，也不申明触发词写法（触发词规则由用户在全局提示词中自行申明）。
export const WEB_CHAT_H3_SYSTEM = `You are a video prompt engineer. Convert the user's native-language shot description into an H3 prompt JSON object with EXACTLY these keys:
{"summary": string, "detailed_description": string, "overall_soundscape": string, "non_diegetic_music": string}
Rules:
- Respond with ONLY the JSON object, no markdown fences, no extra text.
- Wrap EVERY mentioned character/subject name as <@名字> (e.g. <@阿婆>) and never leave a subject name unwrapped; preserve existing <@Name> / <#Name:dialogue> / <d>dialogue</d> tags verbatim.
- Tag format is strict: no whitespace right after <@ / <# / <! or right before >, and the name/content separator must be a half-width colon ":" (never the full-width "："). Correct: <#李四:你好！>; wrong: <# 李四：你好！ >.
- IMPORTANT: All four JSON field values (summary, detailed_description, overall_soundscape, non_diegetic_music) MUST be written in the SAME language as the input shot description — Chinese input MUST produce Chinese output, English input MUST produce English output. Never switch to a different language on your own; this rule overrides the language of this instruction.
- Fragments wrapped as <!...> (e.g. <!slow push-in>) are protected technical keywords: keep the inner text verbatim in its original language/spelling, keep the <!...> wrapper in this stage, and never translate, reorder, or paraphrase them. Each such phrase must appear at least once.`;

// 写作指南缓存（60s TTL）：一键导入逐镜追问时不重复拉取；面板里改完文档最多 1 分钟生效
let _h3GuideCache = { at: 0, text: "" };
const H3_GUIDE_TTL_MS = 60_000;

function _cleanGuideText(text) {
  // 剥掉文件头的中文维护注释（> 开头的引用块），避免稀释模型注意力
  return String(text || "").replace(/^(?:>[^\n]*\n)+/, "").trim();
}

export async function buildWebChatH3System() {
  const now = Date.now();
  if (_h3GuideCache.text && now - _h3GuideCache.at < H3_GUIDE_TTL_MS) {
    return WEB_CHAT_H3_SYSTEM + "\n\n## Four-Field Writing Guide\n" + _h3GuideCache.text;
  }
  let guide = "";
  try {
    // /spa/skill_doc 返回 {success, doc: {...}}，正文嵌在 doc 字段
    const resp = await getJSON(`/spa/skill_doc?key=${encodeURIComponent("h3-writing-guide")}`);
    const content = resp?.doc?.content ?? resp?.content ?? "";
    if (content) guide = _cleanGuideText(content);
  } catch (e) {
    // 指南拉取失败：只用核心规则，不断链（后端未重启 / 文档被删时会出现）
    console.warn("[MRD] 写作指南拉取失败，网页通道 H3 仅使用核心规则：", e?.message || e);
  }
  _h3GuideCache = { at: now, text: guide };
  if (guide) {
    console.info(`[MRD] 网页通道 H3 system 已注入写作指南（${guide.length} 字符，60s 缓存）`);
  }
  return guide
    ? WEB_CHAT_H3_SYSTEM + "\n\n## Four-Field Writing Guide\n" + guide
    : WEB_CHAT_H3_SYSTEM;
}
// 旧名保留，避免外部脚本引用失效
const DEEPSEEK_H3_SYSTEM = WEB_CHAT_H3_SYSTEM;
void DEEPSEEK_H3_SYSTEM;

function h3Brief(text, n = 120) {
  return String(text || "").replace(/\s+/g, " ").slice(0, n);
}

// 宽松解析：抓到的文本可能是 DOM 兜底内容，前面会带「已深度思考（用时 12 秒）」
// 之类的页面文字，或包在 ```json 围栏里。直接 JSON.parse 必然失败（整步全灭），
// 统一走 parseJsonBlock：剥围栏 + 取首个 { 到最后一个 } 再解析。
function parseH3(text) {
  try {
    const obj = parseJsonBlock(text);
    if (!(obj && typeof obj === "object" && !Array.isArray(obj))) return null;
    // 标签格式清洗（模型偶发输出「<@ 张三>」「<#李四：你好 >」）：
    // 去括号内首尾空格、全角「：」统一为半角（后端主体绑定只认半角冒号）
    for (const k of ["summary", "detailed_description", "overall_soundscape", "non_diegetic_music"]) {
      if (typeof obj[k] === "string") obj[k] = normalizeH3Tags(obj[k]);
    }
    return obj;
  } catch {
    return null;
  }
}

// H3 标签格式清洗：与后端 lib/prompt.py normalize_h3_tags 同构
// - 括号内首尾空格去除（<@Name> 的英文名内部空格保留）
// - <#名字:内容> / <！技术词:内容> 的分隔冒号统一为半角 ":"，前后空格去除
export function normalizeH3Tags(text) {
  return String(text || "").replace(/<([@#!])\s*([^>\n]*?)\s*>/g, (m, mark, inner) => {
    if (mark === "@") return `<@${inner}>`;
    const idx = Math.min(
      ...[inner.indexOf(":"), inner.indexOf("：")].filter((p) => p >= 0).concat(Infinity)
    );
    if (!Number.isFinite(idx)) return `<${mark}${inner}>`;
    return `<${mark}${inner.slice(0, idx).trim()}:${inner.slice(idx + 1).trim()}>`;
  });
}

// 整份 H3 JSON 的四字段标签清洗
export function normalizeH3Json(json) {
  if (!json || typeof json !== "object") return json;
  for (const k of ["summary", "detailed_description", "overall_soundscape", "non_diegetic_music"]) {
    if (typeof json[k] === "string") json[k] = normalizeH3Tags(json[k]);
  }
  return json;
}

// 旧名兼容：deepseek 桥接入口
export async function deepseekGenerateH3(opts, payload) {
  return webChatGenerateH3(opts, payload, "deepseek");
}

// 网页会话桥接（deepseek / doubao / qwen）：技能注入块由后端 /spa/skill_notes 渲染后传入
export async function webChatGenerateH3(opts, payload, site = "deepseek") {
  const label = SITE_LABELS[site] || site;
  const cdpEndpoint = cdpEndpointOf(opts);
  const system = await buildWebChatH3System();
  const parts = [];
  if (payload?.duration_seconds) parts.push(`Duration: ${payload.duration_seconds}s.`);
  // 技能注入块（后端唯一渲染源）；旧调用方未传 skill_notes 时按 selections 提示
  if (payload?.skill_notes) parts.push(`Skill notes:\n${payload.skill_notes}`);
  else if (payload?.selections) parts.push(`Selected skills: ${JSON.stringify(payload.selections)}`);
  parts.push(`Shot description:\n${payload?.prompt || ""}`);

  // 同一批 H3 转换共用一个会话：首镜走新会话，后续镜头传入 chat_id 直接追问，
  // 避免每镜都回首页开新会话（11 镜 = 11 个会话，慢且易中途失败）。
  // 自建会话（调用方未传 chat_id，如单镜「转H3提示词」）在结束后立即删除；
  // 批量导入传入的会话由导入流水线自行管理生命周期。
  const createdHere = !String(payload?.chat_id || "");
  let sessionChat = String(payload?.chat_id || "");
  const cleanupSession = async () => {
    if (createdHere && sessionChat) {
      const cid = sessionChat;
      sessionChat = "";
      try {
        await deepseekDeleteSession("", cid, site, cdpEndpoint);
      } catch (e) {
        console.warn(`[MRD] ${label} 会话删除失败（不影响生成结果）：`, e?.message || e);
      }
    }
  };
  const ask = async (extra) => {
    const prompt = parts.join("\n") + (extra || "");
    if (sessionChat) {
      const text = await deepseekCompleteInSession("", {
        site,
        system,
        prompt,
        chatId: sessionChat,
        expectJson: true,
        cdpEndpoint,
      });
      return { text: String(text || ""), chatId: sessionChat };
    }
    const resp = await webchatComplete({
      site,
      system,
      prompt,
      expectJson: true,
      cdpEndpoint,
    });
    if (!resp.ok) throw new Error(resp.error || `${label} 桥接调用失败`);
    return { text: resp.text, chatId: resp.chat_id };
  };

  let text = "";
  // finally 兜底：任何出口（成功 / 各类失败）都先清掉自建会话再返回
  try {
  try {
    const r = await ask("");
    text = r.text;
    if (r.chatId) sessionChat = r.chatId;
  } catch (e) {
    return { success: false, error: e.message || String(e), chatId: sessionChat };
  }
  let json_data = parseH3(text);
  if (!json_data) {
    // 自动追问一次（只纠正格式，不改镜头内容）
    try {
      const r2 = await ask(
        "\n\n上一次的回复不是合法 JSON。请只输出一个 JSON 对象，" +
          "键为 summary / detailed_description / overall_soundscape / non_diegetic_music，" +
          "不要任何解释、不要 Markdown 围栏之外的内容。"
      );
      text = r2.text;
      if (r2.chatId) sessionChat = r2.chatId;
    } catch (e) {
      return { success: false, error: e.message || String(e), chatId: sessionChat };
    }
    json_data = parseH3(text);
  }
  if (!json_data) {
    return {
      success: false,
      error: `${label} 返回内容无法解析为 H3 JSON（原文摘录：${h3Brief(text)}…）`,
      chatId: sessionChat,
    };
  }
  const missing = ["summary", "detailed_description"].filter((k) => !String(json_data[k] || "").trim());
  if (missing.length) {
    return { success: false, error: `H3 JSON 缺少字段：${missing.join("、")}`, chatId: sessionChat };
  }
  // 所选分镜技能必须出现（不是选择性出现）：三通道共用校验
  const terms = await ensureRequiredTerms(json_data, payload?.required_terms, async (missing) => {
    const r3 = await ask(requiredTermsCorrectionPrompt(missing));
    const j2 = parseH3(r3.text);
    if (r3.chatId) sessionChat = r3.chatId;
    return j2;
  });
  json_data = terms.json_data;
  const stillMissing = terms.stillMissing;
    return {
      success: true,
      json_data,
      chatId: sessionChat,
      warning: stillMissing.length
        ? `以下所选技能未出现在生成结果中：${stillMissing.join("、")}（可重新生成或手动补充）`
        : "",
    };
  } finally {
    await cleanupSession();
  }
}

// ---------------- 网页会话通道（后端 /spa/webchat/*，分镜导入流水线用） ----------------
// 保留旧函数名与签名（第一参数为历史 extensionId，已忽略），调用方零改动迁移。

// 兼容旧调用：能力检测恒真（通道在服务端，无需浏览器扩展）
export function deepseekAvailable() {
  return true;
}

// 在指定站点网页会话内完成一次生成 → { ok, text, chat_id, error }
export function deepseekComplete(
  _extensionId,
  { system, prompt, expectJson = false, site = "deepseek", cdpEndpoint = "", timeoutMs = 300000 } = {}
) {
  return webchatComplete({ site, system, prompt, expectJson, cdpEndpoint, timeoutMs });
}

// 列出指定站点的全部会话 → [{ id, title, updatedAt }]
// DeepSeek 走站内 API；豆包/千问由后端 UI 扫描会话侧栏
export async function deepseekListSessions(_extensionId, site = "deepseek", cdpEndpoint = "") {
  try {
    const q = new URLSearchParams({ site });
    const ep = cdpEndpoint || _cdpEndpoint;
    if (ep) q.set("cdpEndpoint", ep);
    const data = await getJSON(`/spa/webchat/sessions?${q.toString()}`);
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch (e) {
    throw new Error(e.message || "获取会话列表失败");
  }
}

// 删除整个会话（导入结束后清理本次新建的会话）→ { chatId }
// 仅 DeepSeek 支持；豆包/千问由后端返回明确错误
export async function deepseekDeleteSession(_extensionId, chatId, site = "deepseek", cdpEndpoint = "") {
  const data = await postJSON("/spa/webchat/session/delete", {
    site,
    chat_id: chatId,
    cdp_endpoint: cdpEndpoint || _cdpEndpoint,
  });
  if (!data.success) throw new Error(data.error || "删除会话失败");
  return { chatId };
}

// 在指定会话内完成一次生成（session_mode: "reuse"，后端导航到该会话）
export async function deepseekCompleteInSession(
  _extensionId,
  { system = "", prompt = "", chatId = "", expectJson = false, site = "deepseek", cdpEndpoint = "", timeoutMs = 300_000 } = {}
) {
  const resp = await webchatComplete({
    site, system, prompt, expectJson, sessionMode: "reuse", chatId, cdpEndpoint, timeoutMs,
  });
  if (!resp.ok) throwCompleteError(resp, site);
  return resp.text;
}

// 在全新会话内完成一次生成（后端先回站点首页再发送，首页发送自动新建会话）。
// 返回 { text, chatId }：chatId 从发送后的页面 URL 解析，供后续步骤复用该会话。
export async function deepseekCompleteNewSession(
  _extensionId,
  { system = "", prompt = "", expectJson = false, site = "deepseek", cdpEndpoint = "", timeoutMs = 300_000 } = {}
) {
  const resp = await webchatComplete({
    site, system, prompt, expectJson, sessionMode: "new", cdpEndpoint, timeoutMs,
  });
  if (!resp.ok) throwCompleteError(resp, site);
  return { text: resp.text, chatId: resp.chat_id };
}

// 页面自检：CDP 连接状态 + 三站标签页与页面定位状态，便于快速排查
export async function deepseekDiag(_extensionId, cdpEndpoint = "") {
  const q = new URLSearchParams();
  const ep = cdpEndpoint || _cdpEndpoint;
  if (ep) q.set("cdpEndpoint", ep);
  const data = await getJSON(`/spa/webchat/diag${q.toString() ? `?${q.toString()}` : ""}`);
  if (!data.success) throw new Error(data.error || "自检失败");
  return data;
}

// 轻量查询最近一次生成请求的阶段流水（无副作用，运行中轮询用）
// CDP 通道的阶段流水在后端进程内，暂不暴露：恒返回空对象
export async function deepseekAttempt() {
  return {};
}

// 取消：后端在下一轮询点中止当前网页会话任务
export async function deepseekCancel() {
  try {
    const data = await postJSON("/spa/webchat/cancel", {});
    return data.cancelled ? 1 : 0;
  } catch {
    return 0;
  }
}

// CDP 连接测试 → { connected, endpoint, error? }
export async function webchatTestConnection(cdpEndpoint = "") {
  const q = new URLSearchParams();
  const ep = cdpEndpoint || _cdpEndpoint;
  if (ep) q.set("cdpEndpoint", ep);
  const data = await getJSON(`/spa/webchat/status${q.toString() ? `?${q.toString()}` : ""}`);
  return { connected: !!data.connected, endpoint: data.endpoint || ep, error: data.error || "" };
}

// 探测本机可用浏览器（设置面板「浏览器」下拉框数据源）
export async function webchatListBrowsers() {
  const data = await getJSON("/spa/webchat/browsers");
  return Array.isArray(data.browsers) ? data.browsers : [];
}

// 一键启动调试浏览器（幂等）：独立用户目录在后端 userdata/browser，
// site 传 vlm_mode（deepseek-proxy 等，后端自动归一化）时自动打开对应站点首页。
export async function webchatLaunch({ browser = "", browserPath = "", site = "", cdpEndpoint = "" } = {}) {
  return postJSON("/spa/webchat/launch", {
    browser,
    browser_path: browserPath,
    site,
    cdp_endpoint: cdpEndpoint || _cdpEndpoint,
  });
}

// 旧接口兼容：扩展 WS 桥接已弃用
export async function deepseekSetBridgeUrl() {
  return { ok: true, deprecated: true };
}
export async function deepseekBridgeStatus(_extensionId, cdpEndpoint = "") {
  return webchatTestConnection(cdpEndpoint);
}

// 纯文本生成（技能文档「生成提示词」等场景）：system=技能文档全文，
// prompt=渲染后的用户描述。返回原始文本，解析交给调用方。
export async function generateText(opts, { system = "", prompt = "", image_path = "" } = {}) {
  const mode = opts?.mode || "llama-server";
  const isProxy = mode.endsWith("-proxy");
  const body = {
    prompt,
    system,
    image_path,
    vlm_mode: isProxy ? mode : (mode === "api" ? "api" : mode === "ollama" ? "ollama" : "llama-server"),
    gguf_path: opts.gguf_path || "",
    mmproj_path: opts.mmproj_path || "",
    provider: opts.provider || "",
    api_key: opts.api_key || "",
    ollama_model: opts.ollama_model || "",
    ollama_base_url: opts.ollama_base_url || "",
  };
  const res = await postJSON("/llm/generate_text", body);
  if (!res?.success) throw new Error(res?.error || "生成失败");
  return String(res.text || "");
}

// ---------------- llama-server 进程管理（设置面板手动启停） ----------------

// 启动（先卸载 ComfyUI 显存模型再拉起进程，就绪轮询在服务端）→ { running, model, ... }
export function llamaServerStart({ path = "", ggufPath = "", mmprojPath = "", port = 0 } = {}) {
  return postJSON("/llm/llama_server/start", {
    path,
    gguf_path: ggufPath,
    mmproj_path: mmprojPath,
    port,
  });
}

// 停止并回收进程
export function llamaServerStop() {
  return postJSON("/llm/llama_server/stop", {});
}

// 当前状态 → { running, loading, pid, endpoint, model, mmproj, port }
export function llamaServerStatus() {
  return getJSON("/llm/llama_server/status");
}

// 启动日志尾部（失败排查）
export function llamaServerLog(lines = 60) {
  return getJSON(`/llm/llama_server/log?lines=${encodeURIComponent(lines)}`);
}

// 剥离 markdown 围栏并解析 JSON（流水线各步产出统一为 JSON 代码块）
// 从 start 起找配对闭合括号（跳过字符串字面量）；找不到返回 -1。
// 用于容忍 JSON 前后的解释文字（如千问回复 JSON 后的「需要我…吗？」尾巴），
// 以及尾部文字本身含花括号导致 lastIndexOf 误判的情况。
function matchBracket(s, start) {
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (!depth) return i;
    }
  }
  return -1;
}

export function parseJsonBlock(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  // 1) 整体直接解析（无前后缀文字的最常见情形）
  try {
    return JSON.parse(body);
  } catch {}
  // 2) 平衡扫描：逐个 { / [ 起点取配对闭合段尝试解析，
  //    自动跳过 JSON 前后的解释文字与追问尾巴
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = matchBracket(body, i);
    if (end < 0) continue;
    try {
      return JSON.parse(body.slice(i, end + 1));
    } catch {
      // 该段不是合法 JSON（可能是文字示例），继续找下一个候选
    }
  }
  // 3) 兜底：首 { 到末 } 截取（旧行为）
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(body.slice(first, last + 1));
  throw new Error("回复中未找到完整 JSON");
}
