// ===== LLM 调用分发：deepseek-proxy 走浏览器扩展桥接，其余走服务端 =====
import { generatePromptJson } from "../api/client.js";

/**
 * 生成 H3 提示词 JSON。
 * @param {object} opts LLM 配置 {mode, gguf_path, mmproj_path, provider, api_key,
 *   ollama_model, ollama_base_url, extension_id}
 * @param {object} payload {prompt, duration_seconds, lang, camera_motion, expression,
 *   shot_size, framing, image_path, expression_catalog}
 * @returns {Promise<{success:boolean, json_data?:object, error?:string}>}
 */
export async function generateH3Prompt(opts, payload) {
  const mode = opts?.mode || "llama-cpp";
  if (mode === "deepseek-proxy") {
    return deepseekGenerateH3(opts, payload);
  }
  // 服务端三种模式：显式透传 opts
  const body = {
    ...payload,
    vlm_mode: mode === "api" ? "api" : mode === "ollama" ? "ollama" : "llama-cpp",
    gguf_path: opts.gguf_path || "",
    mmproj_path: opts.mmproj_path || "",
    provider: opts.provider || "",
    api_key: opts.api_key || "",
    ollama_model: opts.ollama_model || "",
    ollama_base_url: opts.ollama_base_url || "",
  };
  return generatePromptJson(body);
}

// ---------------- deepseek-proxy 浏览器扩展桥接 ----------------
// 协议（extension/ MV3，externally_connectable）：
//   SPA → 扩展 background: chrome.runtime.sendMessage(EXT_ID, {
//     source: "comfy-minimax-ref", type: "deepseek/complete", id, payload }, cb)
//   扩展 → SPA: { source: "comfy-minimax-ref-ext", id, ok, text, error }

let _reqSeq = 0;

export function deepseekAvailable(extensionId) {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime && !!extensionId;
  } catch {
    return false;
  }
}

export function deepseekComplete(extensionId, { system, prompt, expectJson = false, timeoutMs = 300000 }) {
  return new Promise((resolve) => {
    if (!deepseekAvailable(extensionId)) {
      resolve({ ok: false, error: "未配置 DeepSeek 桥接扩展 ID 或浏览器不支持" });
      return;
    }
    const id = `req${++_reqSeq}`;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: "DeepSeek 请求超时" });
      }
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(
        extensionId,
        { source: "comfy-minimax-ref", type: "deepseek/complete", id, payload: { system, prompt, expectJson } },
        (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: `扩展不可用：${chrome.runtime.lastError.message}` });
            return;
          }
          resolve(resp && typeof resp === "object" ? resp : { ok: false, error: "扩展返回异常" });
        }
      );
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: `扩展调用失败：${e.message || e}` });
    }
  });
}

// H3 提示词生成模板（对齐后端 generate_h3_prompt 的产出结构）
const DEEPSEEK_H3_SYSTEM = `You are a video prompt engineer. Convert the user's native-language shot description into an H3 prompt JSON object with EXACTLY these keys:
{"summary": string, "detailed_description": string, "overall_soundscape": string, "non_diegetic_music": string}
Rules:
- Respond with ONLY the JSON object, no markdown fences, no extra text.
- Preserve any <@Name> / <#Name:dialogue> / <d>dialogue</d> tags verbatim.
- detailed_description must break the shot into [Shot 1], [Shot 2] ... beats with timestamps.
- Write in the same language style as the input unless told otherwise.`;

function h3Brief(text, n = 120) {
  return String(text || "").replace(/\s+/g, " ").slice(0, n);
}

// 宽松解析：抓到的文本可能是 DOM 兜底内容，前面会带「已深度思考（用时 12 秒）」
// 之类的页面文字，或包在 ```json 围栏里。直接 JSON.parse 必然失败（整步全灭），
// 统一走 parseJsonBlock：剥围栏 + 取首个 { 到最后一个 } 再解析。
function parseH3(text) {
  try {
    const obj = parseJsonBlock(text);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

export async function deepseekGenerateH3(opts, payload) {
  const extId = (opts?.extension_id || "").trim();
  if (!deepseekAvailable(extId)) {
    return { success: false, error: "deepseek-proxy 未配置：请在全局参数页填写 DeepSeek 桥接扩展 ID" };
  }
  const parts = [];
  if (payload?.duration_seconds) parts.push(`Duration: ${payload.duration_seconds}s.`);
  if (payload?.camera_motion?.length) parts.push(`Camera motions: ${payload.camera_motion.join(", ")}.`);
  if (payload?.shot_size?.length) parts.push(`Shot sizes: ${payload.shot_size.join(", ")}.`);
  if (payload?.framing?.length) parts.push(`Framing: ${payload.framing.join(", ")}.`);
  if (payload?.expression?.length) parts.push(`Micro expressions: ${payload.expression.join(", ")}.`);
  parts.push(`Shot description:\n${payload?.prompt || ""}`);

  // 同一批 H3 转换共用一个会话：首镜走新会话，后续镜头传入 chat_id 直接追问，
  // 避免每镜都回首页开新会话（11 镜 = 11 个会话，慢且易中途失败）。
  let sessionChat = String(payload?.chat_id || "");
  const ask = async (extra) => {
    const prompt = parts.join("\n") + (extra || "");
    if (sessionChat) {
      const text = await deepseekCompleteInSession(extId, {
        system: DEEPSEEK_H3_SYSTEM,
        prompt,
        chatId: sessionChat,
        expectJson: true,
      });
      return { text: String(text || ""), chatId: sessionChat };
    }
    const resp = await deepseekComplete(extId, {
      system: DEEPSEEK_H3_SYSTEM,
      prompt,
      expectJson: true,
    });
    if (!resp.ok) throw new Error(resp.error || "DeepSeek 桥接调用失败");
    return { text: String(resp.text || ""), chatId: resp.chat_id || "" };
  };

  let text = "";
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
      error: `DeepSeek 返回内容无法解析为 H3 JSON（原文摘录：${h3Brief(text)}…）`,
      chatId: sessionChat,
    };
  }
  const missing = ["summary", "detailed_description"].filter((k) => !String(json_data[k] || "").trim());
  if (missing.length) {
    return { success: false, error: `H3 JSON 缺少字段：${missing.join("、")}`, chatId: sessionChat };
  }
  return { success: true, json_data, chatId: sessionChat };
}

// ---------------- deepseek-proxy 会话管理（分镜导入流水线用） ----------------
// 协议（extension/ MV3，与 background.js 对应）：
//   页面 → 扩展: chrome.runtime.sendMessage(EXT_ID, { source, type, id, ... })
//   扩展 → 页面: { source: "comfy-minimax-ref-ext", id, ok, data?, text?, error }

// 通用外部消息：带超时与错误包装
function extSend(extensionId, msg, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    if (!deepseekAvailable(extensionId)) {
      resolve({ ok: false, error: "未配置 DeepSeek 桥接扩展 ID 或浏览器不支持" });
      return;
    }
    const id = `req${++_reqSeq}`;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: "DeepSeek 扩展响应超时" });
      }
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(
        extensionId,
        { source: "comfy-minimax-ref", id, ...msg },
        (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: `扩展不可用：${chrome.runtime.lastError.message}` });
            return;
          }
          resolve(resp && typeof resp === "object" ? resp : { ok: false, error: "扩展返回异常" });
        }
      );
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: `扩展调用失败：${e.message || e}` });
    }
  });
}

function unwrapData(resp) {
  if (!resp || !resp.ok) return null;
  return resp.data ?? null;
}

// 列出 chat.deepseek.com 的全部会话 → [{ id, title, updatedAt }]
export async function deepseekListSessions(extensionId) {
  const resp = await extSend(extensionId, { type: "deepseek/list_sessions" });
  const data = unwrapData(resp);
  if (!data) throw new Error(resp?.error || "获取会话列表失败");
  return Array.isArray(data) ? data : [];
}

// 删除整个会话（导入结束后清理本次新建的会话）→ { chatId }
export async function deepseekDeleteSession(extensionId, chatId) {
  const resp = await extSend(extensionId, { type: "deepseek/delete_session", chat_id: chatId }, 30_000);
  if (!resp.ok) throw new Error(resp?.error || "删除会话失败");
  return { chatId };
}

// 在指定会话内完成一次生成（session_mode: "reuse"，扩展负责导航到该会话）
export async function deepseekCompleteInSession(
  extensionId,
  { system = "", prompt = "", chatId = "", expectJson = false, timeoutMs = 300_000 }
) {
  const resp = await extSend(
    extensionId,
    {
      type: "deepseek/complete",
      payload: { system, prompt, expectJson, session_mode: "reuse", chat_id: chatId },
    },
    timeoutMs
  );
  if (!resp.ok) {
    const hint = /超时/.test(resp?.error || "")
      ? "（可点「页面自检」确认输入框/发送按钮是否可定位）"
      : "";
    throw new Error(`${resp?.error || "DeepSeek 桥接调用失败"}${hint}`);
  }
  return String(resp.text || "");
}

// 在全新会话内完成一次生成（扩展先回首页、点「开启新对话」再发送）。
// 返回 { text, chatId }：chatId 从发送后的页面 URL 解析，供后续步骤复用该会话。
export async function deepseekCompleteNewSession(
  extensionId,
  { system = "", prompt = "", expectJson = false, timeoutMs = 300_000 }
) {
  const resp = await extSend(
    extensionId,
    {
      type: "deepseek/complete",
      payload: { system, prompt, expectJson, session_mode: "new" },
    },
    timeoutMs
  );
  if (!resp.ok) {
    const hint = /超时/.test(resp?.error || "")
      ? "（可点「页面自检」确认输入框/发送按钮是否可定位）"
      : "";
    throw new Error(`${resp?.error || "DeepSeek 桥接调用失败"}${hint}`);
  }
  return { text: String(resp.text || ""), chatId: String(resp.chat_id || "") };
}

// 页面自检：返回 DeepSeek 标签页与页面定位状态，便于快速排查
export async function deepseekDiag(extensionId) {
  const resp = await extSend(extensionId, { type: "deepseek/diag" }, 60_000);
  if (!resp.ok) throw new Error(resp?.error || "自检失败");
  return resp.data || {};
}

// 轻量查询最近一次生成请求的阶段流水（无副作用，运行中轮询用）
export async function deepseekAttempt(extensionId) {
  const resp = await extSend(extensionId, { type: "deepseek/attempt" }, 8_000);
  return resp.ok ? resp.data || {} : {};
}

// 取消：让扩展立即中止所有挂起的生成请求（等待回复中的内容脚本也会停）
export async function deepseekCancel(extensionId) {
  const resp = await extSend(extensionId, { type: "deepseek/cancel" }, 10_000);
  return resp.ok ? (resp.data && resp.data.cancelled) || 0 : 0;
}

// 配置扩展的 ComfyUI WS 桥接地址（后端执行期通道）
export function deepseekSetBridgeUrl(extensionId, url) {
  return extSend(extensionId, { type: "deepseek/set_bridge_url", url }, 15_000);
}

// 查询扩展的 WS 桥接连接状态 → { connected, url }
export async function deepseekBridgeStatus(extensionId) {
  const resp = await extSend(extensionId, { type: "deepseek/bridge_status" }, 15_000);
  return resp.ok ? resp.data || {} : { connected: false, error: resp.error };
}

// 剥离 markdown 围栏并解析 JSON（流水线各步产出统一为 JSON 代码块）
export function parseJsonBlock(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? body.slice(first, last + 1) : body;
  return JSON.parse(candidate);
}
