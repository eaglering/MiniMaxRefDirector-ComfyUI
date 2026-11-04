// ===== DeepSeek 分镜导入流水线 =====
// 在用户选定的 DeepSeek 会话内用 story-design skill 提取故事大纲（利用会话完整
// 上下文），随后删除本次新增的 skill 输入与模型返回（恢复会话原状）；分镜设计在
// 一个全新会话内完成（发送后从页面 URL 取得新会话 id），主体设计 / 首帧图提示词 /
// 音频设计在该新会话内依次进行；H3 转换复用本项目自身的 deepseekGenerateH3 链路
// （与「分镜属性 → H3 生成」按钮同一套提示词）。全部经浏览器扩展桥接
// chat.deepseek.com，不使用 llama-cpp。
//
// skills 词库为本项目 resources/skills（后端 /spa/skill_library）。

import { fetchSkillLibrary } from "../api/client.js";
import {
  deepseekCompleteInSession,
  deepseekCompleteNewSession,
  deepseekDeleteMessages,
  deepseekGenerateH3,
  deepseekReadSession,
  parseJsonBlock,
} from "./llm.js";

// 进度步骤（与 DeepseekImportDialog 的 el-steps 一一对应）
export const IMPORT_STEPS = [
  { key: "outline", label: "故事大纲" },
  { key: "clean", label: "清理会话" },
  { key: "storyboard", label: "分镜设计" },
  { key: "subjects", label: "主体设计" },
  { key: "firstframe", label: "首帧图提示词" },
  { key: "audio", label: "音频设计" },
  { key: "h3", label: "H3 转换" },
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

// 单次会话内生成并解析 JSON（失败时附带原文摘录，便于排查）
async function genJsonInSession(extId, chatId, prompt) {
  const text = await deepseekCompleteInSession(extId, { prompt, chatId, expectJson: true });
  try {
    return parseJsonBlock(text);
  } catch (e) {
    throw new Error(
      `DeepSeek 返回内容无法解析为 JSON（${e.message}）。原文摘录：${String(text).slice(0, 160)}…`
    );
  }
}

/**
 * 运行 DeepSeek 分镜导入流水线。
 *
 * @param {object} opts
 *   - extensionId: string            DeepSeek 桥接扩展 ID
 *   - sessionId: string              用户选定的 DeepSeek 会话 id
 *   - timelineDigest: string         当前时间线摘要（供 storyboard-design 的 {{timeline_digest}}）
 *   - existingSubjects: array        现有主体（character-design 的 {{characters}}）
 *   - token: { cancelled: boolean }  取消令牌
 *   - onStep(key, status)            步骤状态回调：running | done | warn | error
 *   - onLog(level, msg)              日志回调：info | success | warn | error
 *   - onH3Progress(done, total)      H3 循环进度回调
 * @returns {Promise<object>} { title, logline, story, characters, scenes, audios, segments }
 */
export async function runDeepseekImport(opts) {
  const {
    extensionId,
    sessionId,
    timelineDigest = "（当前时间线为空）",
    existingSubjects = [],
    token = null,
    onStep = () => {},
    onLog = () => {},
    onH3Progress = () => {},
  } = opts;

  const extId = String(extensionId || "").trim();
  if (!extId) throw new Error("未配置 DeepSeek 桥接扩展 ID（全局参数 → LLM 设置）");

  const existingDigest = existingSubjects.length
    ? existingSubjects.map((s) => `- ${s.name || "(未命名)"}：${(s.description || "").slice(0, 80)}`).join("\n")
    : "（暂无已有主体）";

  // ---------- 1. 故事大纲：在选定会话内提取（利用完整上下文） ----------
  onStep("outline", "running");
  onLog("info", "读取所选会话消息快照…");
  const snapshot = await deepseekReadSession(extId, sessionId);
  const keepCount = snapshot.count || 0;
  onLog("info", `会话共 ${keepCount} 条消息，提取故事大纲（DeepSeek 生成通常 30-90s）…`);

  const storyTpl = await loadSkill("story-design");
  const outlinePrompt = fillTemplate(storyTpl, {
    input:
      "（提取指令）请通读本会话上方的全部对话内容，按你的任务要求提取用户想拍的故事。" +
      "以用户表达的内容为准；对话中未被用户采纳的方案不要写入。",
  });
  const outline = await genJsonInSession(extId, sessionId, outlinePrompt);
  if (!outline || !outline.story) throw new Error("故事大纲提取失败：返回 JSON 缺少 story 字段");
  onLog(
    "success",
    `大纲完成：${outline.title || "(未命名)"} · 场景 ${(outline.scenes || []).length} 处 · 主体 ${(outline.subjects || []).length} 个`
  );
  onStep("outline", "done");

  // ---------- 2. 清理会话（删除本次新增的两条消息，恢复原状） ----------
  checkCancelled(token);
  onStep("clean", "running");
  try {
    const del = await deepseekDeleteMessages(extId, sessionId, { keepCount });
    onLog("success", `已删除本次新增的 ${del.deleted ?? "?"} 条消息，原会话恢复原状`);
    onStep("clean", "done");
  } catch (e) {
    onStep("clean", "warn");
    onLog("warn", `${e.message || e}（不影响导入，请稍后在 DeepSeek 页面手动删除）`);
  }

  // ---------- 3. 分镜设计（新会话；发送后从页面 URL 取得会话 id） ----------
  checkCancelled(token);
  onStep("storyboard", "running");
  onLog("info", "新建 DeepSeek 会话并进行分镜设计（storyboard-design，通常 40-120s）…");
  const sbTpl = await loadSkill("storyboard-design");
  const sbPrompt = fillTemplate(sbTpl, {
    input: storyDigest(outline),
    timeline_digest: timelineDigest,
    frame_rate: opts.frameRate || 24,
  });
  const sbResp = await deepseekCompleteNewSession(extId, { prompt: sbPrompt, expectJson: true });
  const chatId = sbResp.chatId;
  if (!chatId) {
    throw new Error("分镜设计已完成，但未能从页面取得新会话 id（无法继续后续步骤，请重试）");
  }
  onLog("success", `新会话 ${chatId.slice(0, 8)}… 已建立`);
  const sb = parseJsonBlock(sbResp.text);
  const shots = Array.isArray(sb.segments) && sb.segments.length
    ? sb.segments
    : (Array.isArray(sb) ? sb : null);
  if (!shots) throw new Error("分镜提取失败：返回 JSON 缺少 segments 数组");
  onLog("success", `分镜设计完成：${shots.length} 个镜头`);
  onStep("storyboard", "done");

  // ---------- 4. 主体设计（character-design → 主体页签） ----------
  checkCancelled(token);
  onStep("subjects", "running");
  onLog("info", "主体设计（character-design，通常 30-90s）…");
  const charTpl = await loadSkill("character-design");
  const charPrompt = fillTemplate(charTpl, {
    input: `${storyDigest(outline)}\n\n大纲列出的出场主体：\n${castDigest(outline)}`,
    characters: existingDigest,
    timeline_digest: shotListDigest(shots),
  });
  const charRes = await genJsonInSession(extId, chatId, charPrompt);
  const characters = Array.isArray(charRes.subjects) ? charRes.subjects : [];
  onLog("success", `主体设计完成：${characters.length} 个主体`);
  onStep("subjects", "done");

  // ---------- 5. 首帧图提示词（firstframe-design，补齐缺失的镜头） ----------
  checkCancelled(token);
  onStep("firstframe", "running");
  const missing = shots
    .map((s, i) => ({ i, s }))
    .filter(({ s }) => !(s.first_frame_prompt && String(s.first_frame_prompt).trim()));
  if (!missing.length) {
    onLog("success", "分镜表已包含首/尾帧提示词");
    onStep("firstframe", "done");
  } else {
    onLog("info", `补齐 ${missing.length} 个镜头的首/尾帧图提示词…`);
    const ffTpl = await loadSkill("firstframe-design");
    const ffPrompt = fillTemplate(ffTpl, {
      input: missing
        .map(({ i, s }) => `镜头 ${i + 1}：${(s.prompt || "").slice(0, 160)}`)
        .join("\n"),
    });
    const ff = await genJsonInSession(extId, chatId, ffPrompt);
    const fills = Array.isArray(ff.segments) ? ff.segments : [];
    for (const f of fills) {
      const idx = (f.index || 0) - 1;
      if (shots[idx]) {
        if (f.first_frame_prompt) shots[idx].first_frame_prompt = f.first_frame_prompt;
        if (f.last_frame_prompt) shots[idx].last_frame_prompt = f.last_frame_prompt;
      }
    }
    const still = shots.filter((s) => !s.first_frame_prompt).length;
    if (still) {
      onStep("firstframe", "warn");
      onLog("warn", `${still} 个镜头仍缺首帧提示词（导入后可在分镜中手动补充）`);
    } else {
      onLog("success", "首/尾帧图提示词补齐完成");
      onStep("firstframe", "done");
    }
  }

  // ---------- 6. 音频设计（audio-design → 音频页签） ----------
  checkCancelled(token);
  onStep("audio", "running");
  onLog("info", "音频设计（audio-design）…");
  const audioTpl = await loadSkill("audio-design");
  const audioPrompt = fillTemplate(audioTpl, {
    input: storyDigest(outline),
    timeline_digest: shotListDigest(shots),
  });
  const audioRes = await genJsonInSession(extId, chatId, audioPrompt);
  const audios = Array.isArray(audioRes.subjects) ? audioRes.subjects : [];
  onLog("success", `音频设计完成：${audios.length} 条`);
  onStep("audio", "done");

  // ---------- 7. H3 转换（复用本项目「分镜属性 → H3 生成」的链路与提示词） ----------
  checkCancelled(token);
  onStep("h3", "running");
  onLog("info", `H3 提示词转换，共 ${shots.length} 镜（每镜独立新会话）…`);
  const h3Results = new Array(shots.length).fill(null);
  for (let i = 0; i < shots.length; i++) {
    checkCancelled(token);
    const s = shots[i];
    const res = await deepseekGenerateH3(
      { mode: "deepseek-proxy", extension_id: extId },
      {
        prompt: s.prompt || "",
        duration_seconds: s.duration_seconds,
        camera_motion: Array.isArray(s.camera_motions) ? s.camera_motions : [],
        shot_size: Array.isArray(s.shot_sizes) ? s.shot_sizes : [],
        framing: Array.isArray(s.framings) ? s.framings : [],
        expression: Array.isArray(s.expressions) ? s.expressions : [],
      }
    );
    if (res && res.success && res.json_data) {
      h3Results[i] = res.json_data;
      onLog("success", `镜头 ${i + 1}/${shots.length} H3 转换完成`);
    } else {
      h3Results[i] = null;
      onLog("error", `镜头 ${i + 1}/${shots.length} H3 转换失败：${(res && res.error) || "未知错误"}`);
    }
    onH3Progress(i + 1, shots.length);
  }
  const okCount = h3Results.filter(Boolean).length;
  if (!okCount) throw new Error("所有镜头的 H3 转换均失败");
  if (okCount < shots.length) {
    onStep("h3", "warn");
    onLog("warn", `${shots.length - okCount} 个镜头 H3 转换失败（导入后可在分镜属性中单独重试）`);
  } else {
    onLog("success", "H3 转换全部完成");
    onStep("h3", "done");
  }

  return {
    title: outline.title || "",
    logline: outline.logline || "",
    story: outline.story || "",
    characters,
    scenes: Array.isArray(outline.scenes) ? outline.scenes : [],
    audios,
    segments: shots.map((s, i) => ({
      ...s,
      h3: h3Results[i] || null,
    })),
  };
}
