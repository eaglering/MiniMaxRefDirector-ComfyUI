// ===== 网页分镜导入流水线（手动逐步模式；站点无关）=====
// 不再提供一键全自动导入：每个步骤（故事大纲 → 分镜设计 → 主体设计 → 首帧图
// 提示词 → 音频设计）独立「执行」「同步」，由用户逐步确认后再写入导演台。
// - 「执行」= 在桥接站点的网页会话内生成该步骤结果，仅缓存到 ImportState；
// - 「同步」= 由调用方（DeepseekImportDialog）把缓存结果写入 workspace。
// 分镜设计不再注入任何技能清单（skill_keys 已废弃）；H3 转换不属于导入流程，
// 由用户在分镜属性里按需点「转H3提示词」。
// 会话 id 跨步骤复用：故事大纲在用户选定会话内提取（豆包/千问可手动填会话
// 链接/ID 或留空自动新建），其余步骤在分镜设计新建的会话内追问；是否删除本次
// 新建会话改为「清理会话」独立操作（仅 DeepSeek 支持，默认不自动删除）。
// 全部经浏览器扩展桥接（deepseek / doubao / qianwen），不使用 llama-cpp。
//
// skills 词库为本项目 resources/skills（后端 /spa/skill_library）。

import { fetchSkillLibrary } from "../api/client.js";
import {
  deepseekCompleteInSession,
  deepseekCompleteNewSession,
  deepseekDeleteSession,
  parseJsonBlock,
} from "./llm.js";

// 导入步骤（与 DeepseekImportDialog 的步骤卡片一一对应）
export const IMPORT_STEPS = [
  { key: "outline", label: "故事大纲", hint: "在所选会话内提取故事大纲（仅缓存，作为后续步骤输入）" },
  { key: "storyboard", label: "分镜设计", hint: "新建会话生成分镜列表（不含技能清单）" },
  { key: "subjects", label: "主体设计", hint: "生成角色 / 场景主体条目" },
  { key: "firstframe", label: "首帧图提示词", hint: "补齐缺失镜头的首/尾帧提示词（需先同步分镜）" },
  { key: "audio", label: "音频设计", hint: "生成音频条目" },
];

// 取消令牌：dialog 的「取消」按钮置 token.cancelled = true（并调 deepseekCancel）
export function createImportToken() {
  return { cancelled: false };
}

function checkCancelled(token) {
  if (token && token.cancelled) throw new Error("导入已取消");
}

async function loadSkill(name) {
  const res = await fetchSkillLibrary(name);
  if (!res.success || !res.prompt) {
    throw new Error(res.error || `skill 词库缺失：${name}（resources/skills/${name}/prompt.md）`);
  }
  return res.prompt;
}

// {{key}} 占位符替换：命中的替换，未提供的清空
function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, key) =>
    key in vars ? String(vars[key] ?? "") : ""
  );
}

function shotListDigest(segments) {
  return (segments || [])
    .map((s, i) => `${i + 1}. [${s.duration_seconds || "?"}s] ${(s.prompt || "").slice(0, 80)}`)
    .join("\n");
}

function storyDigest(outline) {
  const parts = [];
  if (outline.title) parts.push(`剧名：${outline.title}`);
  if (outline.logline) parts.push(`梗概：${outline.logline}`);
  if (outline.story) parts.push(`剧情：\n${outline.story}`);
  return parts.join("\n");
}

// 大纲中的出场主体清单 → 主体设计的参考输入
function castDigest(outline) {
  const list = Array.isArray(outline.subjects) ? outline.subjects : [];
  if (!list.length) return "（大纲未列出主体，请从剧情中自行归纳）";
  return list
    .map((s) => `- ${s.name || "(未命名)"}（${s.type || "Character"}）：${(s.description || "").slice(0, 80)}`)
    .join("\n");
}

function head(text, n = 60) {
  return String(text || "").replace(/\s+/g, " ").slice(0, n);
}

// 解析 JSON；失败时在同一会话内追问一次（只纠正格式，不改任务）。
async function parseJsonOrRetry(text, { reask, onLog, what = "DeepSeek" }) {
  try {
    return parseJsonBlock(text);
  } catch {
    onLog &&
      onLog(
        "warn",
        `${what}的回复不是合法 JSON（开头：「${head(text)}…」，共 ${String(text || "").length} 字），自动追问一次…`
      );
    const text2 = await reask(
      `上一次的回复不是合法 JSON（开头：「${head(text)}…」）。` +
        "请严格只输出一个 JSON 代码块：不要解释、不要前后缀文字、不要省略字段。"
    );
    try {
      return parseJsonBlock(text2);
    } catch (e2) {
      throw new Error(
        `${what}返回内容无法解析为 JSON（${e2.message}）。原文摘录：${head(text2, 160)}…`
      );
    }
  }
}

// 单次会话内生成并解析 JSON（失败自动追问一次）
async function genJsonInSession(extId, chatId, prompt, what = "网页会话", onLog = null, site = "deepseek") {
  const text = await deepseekCompleteInSession(extId, { prompt, chatId, expectJson: true, site });
  return parseJsonOrRetry(text, {
    what,
    onLog,
    reask: (hint) =>
      deepseekCompleteInSession(extId, { prompt: `${prompt}\n\n${hint}`, chatId, expectJson: true, site }),
  });
}

/**
 * 创建导入步骤共享状态。
 * @param {object} opts
 *   - extensionId: string          桥接扩展 ID
 *   - site: string                 桥接站点（deepseek / doubao / qwen）
 *   - sessionId: string            用户选定的会话 id（故事大纲提取用；空 = 自动新建）
 *   - timelineDigest: string       当前时间线摘要
 *   - frameRate: number            帧率
 *   - existingSubjects: array      现有主体
 */
export function createImportState(opts = {}) {
  return {
    extId: String(opts.extensionId || "").trim(),
    site: String(opts.site || "deepseek"),
    sessionId: String(opts.sessionId || ""),
    timelineDigest: opts.timelineDigest || "（当前时间线为空）",
    frameRate: opts.frameRate || 24,
    existingSubjects: opts.existingSubjects || [],
    createdSessions: [],   // 本次导入新建的会话 id（「清理会话」按钮统一删除）
    storyboardChatId: "",  // 分镜设计新建的会话（后续步骤复用）
    outline: null,
    shots: [],
    characters: [],
    audios: [],
  };
}

/**
 * 步骤 1：故事大纲 —— 在用户选定会话内提取（利用会话完整上下文）。
 * 未选定会话（豆包/千问手动模式可留空）时自动新建会话并记录到 createdSessions。
 * 结果仅缓存到 state.outline，不写入导演台。
 */
export async function runOutlineStep(state, { token = null, onLog = () => {} } = {}) {
  if (!state.extId) throw new Error("未配置桥接扩展 ID（全局参数 → LLM 设置）");
  checkCancelled(token);
  onLog("info", "在所选会话内提取故事大纲（网页生成通常 30-90s）…");
  const storyTpl = await loadSkill("story-design");
  const outlinePrompt = fillTemplate(storyTpl, {
    input:
      "（提取指令）请通读本会话上方的全部对话内容，按你的任务要求提取用户想拍的故事。" +
      "以用户表达的内容为准；对话中未被用户采纳的方案不要写入。",
  });
  if (!state.sessionId) {
    // 手动模式未填会话：自动新建大纲会话（后续步骤在同会话/分镜会话内追问）
    const resp = await deepseekCompleteNewSession(state.extId, {
      prompt: outlinePrompt,
      expectJson: true,
      site: state.site,
    });
    if (!resp.chatId) {
      throw new Error("大纲已生成，但未能从页面取得新会话 id（无法继续后续步骤，请重试）");
    }
    state.sessionId = resp.chatId;
    state.createdSessions.push(resp.chatId);
    onLog("info", `已自动新建大纲会话 ${resp.chatId.slice(0, 8)}…`);
    const outline = await parseJsonOrRetry(resp.text, {
      what: "故事大纲",
      onLog,
      reask: (hint) =>
        deepseekCompleteInSession(state.extId, {
          prompt: `${outlinePrompt}\n\n${hint}`,
          chatId: state.sessionId,
          expectJson: true,
          site: state.site,
        }),
    });
    return finishOutline(state, outline, onLog);
  }
  const outlineText = await deepseekCompleteInSession(state.extId, {
    prompt: outlinePrompt,
    chatId: state.sessionId,
    expectJson: true,
    site: state.site,
  });
  const outline = await parseJsonOrRetry(outlineText, {
    what: "故事大纲",
    onLog,
    reask: (hint) =>
      deepseekCompleteInSession(state.extId, {
        prompt: `${outlinePrompt}\n\n${hint}`,
        chatId: state.sessionId,
        expectJson: true,
        site: state.site,
      }),
  });
  return finishOutline(state, outline, onLog);
}

function finishOutline(state, outline, onLog) {
  if (!outline || !outline.story) throw new Error("故事大纲提取失败：返回 JSON 缺少 story 字段");
  state.outline = outline;
  onLog(
    "success",
    `大纲完成：${outline.title || "(未命名)"} · 场景 ${(outline.scenes || []).length} 处 · 主体 ${(outline.subjects || []).length} 个`
  );
  return outline;
}

/**
 * 步骤 2：分镜设计 —— 新建会话（发送后从页面 URL 取得会话 id）。
 * 不注入任何技能清单（skill_keys 已废弃）。结果缓存到 state.shots。
 */
export async function runStoryboardStep(state, { token = null, onLog = () => {} } = {}) {
  if (!state.extId) throw new Error("未配置桥接扩展 ID（全局参数 → LLM 设置）");
  if (!state.outline) throw new Error("请先执行「故事大纲」步骤");
  checkCancelled(token);
  onLog("info", "新建会话并进行分镜设计（storyboard-design，通常 40-120s）…");
  const sbTpl = await loadSkill("storyboard-design");
  const sbPrompt = fillTemplate(sbTpl, {
    input: storyDigest(state.outline),
    timeline_digest: state.timelineDigest,
    frame_rate: state.frameRate,
  });
  const sbResp = await deepseekCompleteNewSession(state.extId, {
    prompt: sbPrompt,
    expectJson: true,
    site: state.site,
  });
  const chatId = sbResp.chatId;
  if (!chatId) {
    throw new Error("分镜设计已完成，但未能从页面取得新会话 id（无法继续后续步骤，请重试）");
  }
  onLog("success", `新会话 ${chatId.slice(0, 8)}… 已建立`);
  if (!state.storyboardChatId) {
    state.storyboardChatId = chatId;
    state.createdSessions.push(chatId);
  }
  const sb = await parseJsonOrRetry(sbResp.text, {
    what: "分镜设计",
    onLog,
    reask: (hint) =>
      deepseekCompleteInSession(state.extId, {
        prompt: `${sbPrompt}\n\n${hint}`,
        chatId,
        expectJson: true,
        site: state.site,
      }),
  });
  const shots = Array.isArray(sb.segments) && sb.segments.length
    ? sb.segments
    : (Array.isArray(sb) ? sb : null);
  if (!shots) throw new Error("分镜提取失败：返回 JSON 缺少 segments 数组");
  state.shots = shots;
  onLog("success", `分镜设计完成：${shots.length} 个镜头`);
  return shots;
}

/**
 * 步骤 3：主体设计（character-design）。结果缓存到 state.characters。
 */
export async function runSubjectsStep(state, { token = null, onLog = () => {} } = {}) {
  if (!state.outline) throw new Error("请先执行「故事大纲」步骤");
  checkCancelled(token);
  onLog("info", "主体设计（character-design，通常 30-90s）…");
  const chatId = state.storyboardChatId || state.sessionId;
  const existingDigest = state.existingSubjects.length
    ? state.existingSubjects.map((s) => `- ${s.name || "(未命名)"}：${(s.description || "").slice(0, 80)}`).join("\n")
    : "（暂无已有主体）";
  const charTpl = await loadSkill("character-design");
  const charPrompt = fillTemplate(charTpl, {
    input: `${storyDigest(state.outline)}\n\n大纲列出的出场主体：\n${castDigest(state.outline)}`,
    characters: existingDigest,
    timeline_digest: shotListDigest(state.shots),
  });
  const charRes = await genJsonInSession(state.extId, chatId, charPrompt, "主体设计", onLog, state.site);
  state.characters = Array.isArray(charRes.subjects) ? charRes.subjects : [];
  onLog("success", `主体设计完成：${state.characters.length} 个主体`);
  return state.characters;
}

/**
 * 步骤 4：首帧图提示词（firstframe-design，补齐缺失的镜头）。
 * 结果直接更新 state.shots（同步时按 index 回写已有分镜）。
 */
export async function runFirstframeStep(state, { token = null, onLog = () => {} } = {}) {
  if (!state.shots.length) throw new Error("请先执行「分镜设计」步骤");
  checkCancelled(token);
  const missing = state.shots
    .map((s, i) => ({ i, s }))
    .filter(({ s }) => !(s.first_frame_prompt && String(s.first_frame_prompt).trim()));
  if (!missing.length) {
    onLog("success", "分镜表已包含首/尾帧提示词");
    return [];
  }
  onLog("info", `补齐 ${missing.length} 个镜头的首/尾帧图提示词…`);
  const chatId = state.storyboardChatId || state.sessionId;
  const ffTpl = await loadSkill("firstframe-design");
  const ffPrompt = fillTemplate(ffTpl, {
    input: missing
      .map(({ i, s }) => `镜头 ${i + 1}：${(s.prompt || "").slice(0, 160)}`)
      .join("\n"),
  });
  const ff = await genJsonInSession(state.extId, chatId, ffPrompt, "首帧图提示词", onLog, state.site);
  const fills = Array.isArray(ff.segments) ? ff.segments : [];
  const updated = [];
  for (const f of fills) {
    const idx = (f.index || 0) - 1;
    if (state.shots[idx]) {
      if (f.first_frame_prompt) state.shots[idx].first_frame_prompt = f.first_frame_prompt;
      if (f.last_frame_prompt) state.shots[idx].last_frame_prompt = f.last_frame_prompt;
      updated.push({ index: idx + 1, first: !!f.first_frame_prompt, last: !!f.last_frame_prompt });
    }
  }
  const still = state.shots.filter((s) => !s.first_frame_prompt).length;
  if (still) {
    onLog("warn", `${still} 个镜头仍缺首帧提示词（同步后可在分镜中手动补充）`);
  } else {
    onLog("success", "首/尾帧图提示词补齐完成");
  }
  return updated;
}

/**
 * 步骤 5：音频设计（audio-design）。结果缓存到 state.audios。
 */
export async function runAudioStep(state, { token = null, onLog = () => {} } = {}) {
  if (!state.outline) throw new Error("请先执行「故事大纲」步骤");
  checkCancelled(token);
  onLog("info", "音频设计（audio-design）…");
  const chatId = state.storyboardChatId || state.sessionId;
  const audioTpl = await loadSkill("audio-design");
  const audioPrompt = fillTemplate(audioTpl, {
    input: storyDigest(state.outline),
    timeline_digest: shotListDigest(state.shots),
  });
  const audioRes = await genJsonInSession(state.extId, chatId, audioPrompt, "音频设计", onLog, state.site);
  state.audios = Array.isArray(audioRes.subjects) ? audioRes.subjects : [];
  onLog("success", `音频设计完成：${state.audios.length} 条`);
  return state.audios;
}

/**
 * 组装某一步骤的同步载荷（交由调用方写入 workspace）。
 * type: storyboard | subjects | firstframe | audio
 */
export function buildSyncPayload(state, stepKey) {
  switch (stepKey) {
    case "storyboard":
      return {
        type: "storyboard",
        segments: state.shots.map((s) => ({ ...s })),
      };
    case "subjects":
      return {
        type: "subjects",
        characters: state.characters,
        scenes: Array.isArray(state.outline?.scenes) ? state.outline.scenes : [],
      };
    case "firstframe":
      return {
        type: "firstframe",
        frames: state.shots
          .map((s, i) => ({
            index: i + 1,
            first_frame_prompt: s.first_frame_prompt || "",
            last_frame_prompt: s.last_frame_prompt || "",
          }))
          .filter((f) => f.first_frame_prompt || f.last_frame_prompt),
      };
    case "audio":
      return { type: "audio", audios: state.audios };
    default:
      return null; // outline 仅缓存，无同步载荷
  }
}

/**
 * 清理本次导入新建的 DeepSeek 会话（「清理会话」独立按钮；删除失败只告警）。
 * @returns {Promise<number>} 成功删除的会话数
 */
export async function cleanupImportSessions(state, onLog = () => {}) {
  let removed = 0;
  for (const cid of state.createdSessions) {
    try {
      await deepseekDeleteSession(state.extId, cid, state.site);
      removed += 1;
    } catch (e) {
      onLog("warn", `删除会话 ${String(cid).slice(0, 8)}… 失败：${e.message || e}`);
    }
  }
  state.createdSessions = state.createdSessions.slice(removed);
  if (removed) onLog("success", `已清理本次新建的 ${removed} 个会话`);
  return removed;
}
