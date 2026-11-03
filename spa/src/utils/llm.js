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
  const resp = await deepseekComplete(extId, {
    system: DEEPSEEK_H3_SYSTEM,
    prompt: parts.join("\n"),
    expectJson: true,
  });
  if (!resp.ok) {
    return { success: false, error: resp.error || "DeepSeek 桥接调用失败" };
  }
  let json_data = null;
  try {
    const text = String(resp.text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
    json_data = JSON.parse(text);
  } catch {
    return { success: false, error: "DeepSeek 返回内容无法解析为 H3 JSON" };
  }
  return { success: true, json_data };
}
