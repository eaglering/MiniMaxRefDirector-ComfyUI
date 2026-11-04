// ===== DeepSeek 分镜导入流水线 =====
// 在用户选定的 DeepSeek 会话内用 story-design skill 提取故事大纲（利用会话完整
// 上下文），随后删除本次新增的 skill 输入与模型返回（恢复会话原状），新建一个
// 会话依次完成分镜 / 主体 / 场景 / 音频 / 首帧提示词，再逐镜循环 h3-prompt-convert
// 完成 H3 四字段转换。全部经浏览器扩展桥接 chat.deepseek.com，不使用 llama-cpp。
//
// skills 词库来自 FastDirector-Desktop resources/skills（后端 /spa/skill_library）。

import { fetchSkillLibrary } from "../api/client.js";
import {
  deepseekComplete,
  deepseekCompleteInSession,
  deepseekDeleteMessages,
  deepseekNewSession,
  deepseekReadSession,
  parseJsonBlock,
} from "./llm.js";

// 进度步骤（与 DeepseekImportDialog 的 el-steps 一一对应）
export const IMPORT_STEPS = [
  { key: "outline", label: "故事大纲" },
  { key: "clean", label: "清理会话并新建" },
  { key: "storyboard", label: "分镜提取" },
  { key: "subjects", label: "主体与场景" },
  { key: "audio", label: "音频设计" },
  { key: "firstframe", label: "首帧提示词" },
  { key: "h3", label: "H3 循环转换" },
];

// 取消令牌：dialog 的「取消」按钮置 token.cancelled = true
export function createImportToken() {
  return { cancelled: false };
}

function checkCancelled(token) {
  if (token && token.cancelled) throw new Error("导入已取消");
}

async function loadSkill(name) {
  const res = await fetchSkillLibrary(name);
  if (!res.success || !res.prompt) {
    throw new Error(res.error || `skill 词库缺失：${name}（请安装 ComfyUI-FastDirector-Desktop）`);
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
 *   - timelineDigest: string         当前时间线摘要（供 skills 的 {{timeline_digest}}）
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

  const charactersDigest = existingSubjects.length
    ? existingSubjects.map((s) => `- ${s.name || "(未命名)"}：${(s.description || "").slice(0, 80)}`).join("\n")
    : "（暂无已有主体）";

  // ---------- 1. 故事大纲（在选定会话内，利用完整上下文） ----------
  onStep("outline", "running");
  onLog("info", "读取所选会话消息快照…");
  const snapshot = await deepseekReadSession(extId, sessionId);
  const keepCount = snapshot.count || 0;
  onLog("info", `会话共 ${keepCount} 条消息，发送 story-design 提取大纲（DeepSeek 生成通常 30-90s）…`);

  const storyTpl = await loadSkill("story-design");
  const outlinePrompt = fillTemplate(storyTpl, {
    input:
      "（提取指令）请通读本会话上方的全部对话内容，把其中用户的创作构想与故事素材" +
      "按你的角色规范整理输出：以对话中用户表达的故事为准，不要推翻用户设定；" +
      "若内容零散则补全为完整可拍的故事。",
  });
  const outline = await genJsonInSession(extId, sessionId, outlinePrompt);
  if (!outline || !outline.story) throw new Error("故事大纲提取失败：返回 JSON 缺少 story 字段");
  onLog("success", `大纲完成：${outline.title || "(未命名)"} · ${outline.logline || ""}`);
  onStep("outline", "done");

  // ---------- 2. 清理会话并新建 ----------
  checkCancelled(token);
  onStep("clean", "running");
  let cleanWarned = false;
  try {
    const del = await deepseekDeleteMessages(extId, sessionId, { keepCount });
    onLog("success", `已删除本次新增的 ${del.deleted ?? "?"} 条消息，原会话恢复原状`);
  } catch (e) {
    cleanWarned = true;
    onLog("warn", `${e.message || e}（不影响导入，请稍后在 DeepSeek 页面手动删除）`);
  }
  onLog("info", "新建 DeepSeek 会话…");
  const newSession = await deepseekNewSession(extId);
  const chatId = newSession.id;
  onLog("success", `新会话已创建（${chatId.slice(0, 8)}…）`);
  onStep("clean", cleanWarned ? "warn" : "done");

  // ---------- 3. 分镜提取 ----------
  checkCancelled(token);
  onStep("storyboard", "running");
  onLog("info", "在新会话内进行分镜设计（storyboard-design，通常 40-120s）…");
  const sbTpl = await loadSkill("storyboard-design");
  const sbPrompt = fillTemplate(sbTpl, {
    input: storyDigest(outline),
    timeline_digest: timelineDigest,
    frame_rate: opts.frameRate || 24,
  });
  const sb = await genJsonInSession(extId, chatId, sbPrompt);
  const shots = Array.isArray(sb.segments) && sb.segments.length
    ? sb.segments
    : (Array.isArray(sb) ? sb : null);
  if (!shots) throw new Error("分镜提取失败：返回 JSON 缺少 segments 数组");
  onLog("success", `分镜提取完成：${shots.length} 个镜头`);
  onStep("storyboard", "done");

  // ---------- 4. 主体与场景 ----------
  checkCancelled(token);
  onStep("subjects", "running");
  onLog("info", "角色设计（character-design）…");
  const charTpl = await loadSkill("character-design");
  const charPrompt = fillTemplate(charTpl, {
    input: storyDigest(outline),
    characters: charactersDigest,
    timeline_digest: shotListDigest(shots),
  });
  const charRes = await genJsonInSession(extId, chatId, charPrompt);
  const characters = Array.isArray(charRes.subjects) ? charRes.subjects : [];
  onLog("success", `角色设计完成：${characters.length} 个主体`);

  checkCancelled(token);
  onLog("info", "场景设计（scene-design）…");
  const sceneTpl = await loadSkill("scene-design");
  const scenePrompt = fillTemplate(sceneTpl, {
    input: storyDigest(outline),
    timeline_digest: shotListDigest(shots),
  });
  const sceneRes = await genJsonInSession(extId, chatId, scenePrompt);
  const scenes = Array.isArray(sceneRes.subjects) ? sceneRes.subjects : [];
  onLog("success", `场景设计完成：${scenes.length} 个场景/道具`);
  onStep("subjects", "done");

  // ---------- 5. 音频设计 ----------
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

  // ---------- 6. 首帧提示词 ----------
  checkCancelled(token);
  onStep("firstframe", "running");
  const missing = shots
    .map((s, i) => ({ i, s }))
    .filter(({ s }) => !(s.first_frame_prompt && String(s.first_frame_prompt).trim()));
  if (!missing.length) {
    onLog("success", "分镜表已包含首/尾帧提示词");
    onStep("firstframe", "done");
  } else {
    onLog("info", `补齐 ${missing.length} 个镜头的首/尾帧提示词…`);
    const ffPrompt =
      "请基于本会话上方的分镜表，为下列镜头补写 first_frame_prompt / last_frame_prompt " +
      "（必须包含环境描述：地点、陈设、天气、光线方向与背景空间关系；相邻镜头首尾衔接）。\n" +
      missing.map(({ i, s }) => `镜头 ${i + 1}：${(s.prompt || "").slice(0, 120)}`).join("\n") +
      '\n\n只输出一个 JSON 代码块：{"segments":[{"index":1,"first_frame_prompt":"…","last_frame_prompt":"…"}]}';
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
      onLog("success", "首/尾帧提示词补齐完成");
      onStep("firstframe", "done");
    }
  }

  // ---------- 7. H3 循环转换（每镜独立新对话，避免上下文污染） ----------
  checkCancelled(token);
  onStep("h3", "running");
  onLog("info", `H3 提示词转换（h3-prompt-convert），共 ${shots.length} 镜…`);
  const h3Tpl = await loadSkill("h3-prompt-convert");
  const h3Results = new Array(shots.length).fill(null);
  for (let i = 0; i < shots.length; i++) {
    checkCancelled(token);
    const s = shots[i];
    const controls = [];
    if (s.duration_seconds) controls.push(`时长约束：${s.duration_seconds} 秒`);
    if (Array.isArray(s.camera_motions) && s.camera_motions.length)
      controls.push(`运镜：${s.camera_motions.join(", ")}`);
    if (Array.isArray(s.shot_sizes) && s.shot_sizes.length)
      controls.push(`景别：${s.shot_sizes.join(", ")}`);
    if (Array.isArray(s.framings) && s.framings.length)
      controls.push(`构图：${s.framings.join(", ")}`);
    const input =
      `${s.prompt || ""}` +
      (controls.length ? `\n（${controls.join("；")}）` : "") +
      (s.first_frame_prompt ? `\n（首帧参考：${s.first_frame_prompt.slice(0, 120)}）` : "");
    const prompt = fillTemplate(h3Tpl, { input });
    try {
      const resp = await deepseekComplete(extId, { system: "", prompt, expectJson: true });
      if (!resp.ok) throw new Error(resp.error || "DeepSeek 桥接调用失败");
      h3Results[i] = parseJsonBlock(resp.text);
      onLog("success", `镜头 ${i + 1}/${shots.length} H3 转换完成`);
    } catch (e) {
      h3Results[i] = { error: e.message || String(e) };
      onLog("error", `镜头 ${i + 1}/${shots.length} H3 转换失败：${e.message || e}`);
    }
    onH3Progress(i + 1, shots.length);
  }
  const okCount = h3Results.filter((r) => r && r.h3).length;
  if (!okCount) throw new Error("所有镜头的 H3 转换均失败");
  if (okCount < shots.length) {
    onStep("h3", "warn");
    onLog("warn", `${shots.length - okCount} 个镜头 H3 转换失败（导入后可单独重试）`);
  } else {
    onLog("success", "H3 循环转换全部完成");
    onStep("h3", "done");
  }

  return {
    title: outline.title || "",
    logline: outline.logline || "",
    story: outline.story || "",
    characters,
    scenes,
    audios,
    segments: shots.map((s, i) => ({
      ...s,
      h3: h3Results[i] && h3Results[i].h3 ? h3Results[i].h3 : null,
      h3Cn: h3Results[i] && h3Results[i].cn ? h3Results[i].cn : "",
      h3En: h3Results[i] && h3Results[i].en ? h3Results[i].en : "",
    })),
  };
}
