// ===== 网页分镜导入流水线（手动逐步模式；站点无关）=====
// 不提供一键全自动导入：每个步骤（故事大纲 → 分镜设计 → 主体设计 → 首帧图
// 提示词 → 音频设计）由用户逐步「执行」。
// - 「执行」= 在桥接站点的网页会话内生成该步骤结果，缓存到 ImportState；
//   成功后由 DeepseekImportDialog 自动写入 workspace（大纲仅缓存不写入）。
// - 某步返回内容无法解析为 JSON 时：完整原文打印到浏览器控制台（F12 可查），
//   步骤置为失败，由用户确认后手动重新「执行」——不自动追问重发。
// 分镜设计不再注入任何技能清单（skill_keys 已废弃）；H3 转换不属于导入流程，
// 由用户在分镜属性里按需点「转H3提示词」。
// 会话 id 跨步骤复用：故事大纲在用户选定会话内提取（豆包/千问可手动填会话
// 链接/ID 或留空自动新建），其余步骤在分镜设计新建的会话内追问；是否删除本次
// 新建会话改为「清理会话」独立操作（三站均支持，默认不自动删除）。
// 全部经后端 Playwright CDP 桥接（deepseek / doubao / qianwen），不使用 llama-cpp。
//
// skills 词库为本项目 resources/skills（后端 /spa/skill_library）。

import { fetchSkillDoc, fetchSkillLibrary } from "../api/client.js";
import {
  buildWebChatH3System,
  deepseekCompleteInSession,
  deepseekCompleteNewSession,
  deepseekDeleteSession,
  normalizeH3Json,
  parseH3Lenient,
  parseJsonBlock,
  webchatLastReply,
} from "./llm.js";

// 导入步骤（与 DeepseekImportDialog 的步骤卡片一一对应）
export const IMPORT_STEPS = [
  { key: "outline", label: "故事大纲", hint: "在所选会话内提取故事大纲（仅缓存，作为后续步骤输入）" },
  { key: "storyboard", label: "分镜设计", hint: "新建会话生成分镜列表（不含技能清单）" },
  { key: "subjects", label: "主体设计", hint: "生成角色 / 场景主体条目" },
  { key: "firstframe", label: "首帧图提示词", hint: "补齐缺失镜头的首/尾帧提示词（需先执行分镜设计）" },
  { key: "audio", label: "音频设计", hint: "生成音频条目" },
  { key: "h3", label: "批量转H3提示词", hint: "把分镜逐镜转为 H3 提示词（不注入技能指南 / skill_notes）" },
];

// 取消令牌：dialog 的「取消」按钮置 token.cancelled = true（并调 deepseekCancel）
export function createImportToken() {
  return { cancelled: false };
}

function checkCancelled(token) {
  if (token && token.cancelled) throw new Error("导入已取消");
}

// 技能文档读取：DB（全局参数 → 技能文档，可编辑）优先，缺失回落文件库
// （resources/skills）。内置 key 与 resources/skills 目录同名（story-design 等）。
async function loadSkill(name) {
  try {
    const res = await fetchSkillDoc({ key: name });
    if (res.success && res.doc?.content) return res.doc.content;
  } catch { /* DB 未就绪或文档不存在 → 回落文件库 */ }
  const res = await fetchSkillLibrary(name);
  if (!res.success || !res.prompt) {
    throw new Error(res.error || `skill 词库缺失：${name}（技能文档与 resources/skills/${name}/prompt.md 均不存在）`);
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

// 拟人节奏助手：连续多轮自动化请求之间随机等待，降低站点风控触发率
// （豆包实测：高频连发约 4 条后开始静默吞消息）
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const humanGap = (minS, maxS) => sleepMs((minS + Math.random() * (maxS - minS)) * 1000);
// 单次生成预算放宽到 480s：容纳后端"疑似风控 → 冷却 45-75s → 自动重试一次"
// 单次网页生成的前端超时：必须大于后端最坏耗时（timeout_s 上限 600s 触发不到，
// 但风控冷却重试的预算是 timeout_s + 180s ≈ 660s）。前端先超时断连会让后端
// 白跑一整轮，浏览器侧只会看到连接被掐断（ERR_EMPTY_RESPONSE）。
const LONG_TIMEOUT_MS = 720_000;

// 疑似站点风控的错误特征（与后端 _RISK_ERROR_WORDS 保持一致）：
// 发送被静默拒绝（发送未生效）或发送后长时间无回复流（未检测到）。
// 此类失败时弹窗提供「拉取会话最后回复」补救选项。
const RISK_HINTS = ["未检测到", "发送未生效"];

// 解析 JSON；失败时把完整原文打印到浏览器控制台（方便调试），抛错终止——
// 不自动追问重发，由用户在导入弹窗手动决定是否重新「执行」。
function parseJsonOrFail(text, { onLog, what = "DeepSeek" }) {
  try {
    return parseJsonBlock(text);
  } catch (e) {
    // 完整原文进控制台（导入弹窗日志只放摘要，避免超长）
    console.log(
      `[MRD 导入] ${what} 原始回复（${String(text || "").length} 字，可复制此行下方内容排查）：\n`,
      text
    );
    onLog &&
      onLog(
        "warn",
        `${what}的回复无法解析为 JSON（${e.message}）。完整原文已打印到浏览器控制台（F12），` +
          `确认内容后可手动重新「执行」（开头：「${head(text)}…」）`
      );
    throw new Error(
      `${what}返回内容无法解析为 JSON（${e.message}）。完整原文已打印到浏览器控制台，请检查后手动重新执行`
    );
  }
}

// 单次会话内生成并解析 JSON（失败抛错，原文见浏览器控制台）
async function genJsonInSession(state, chatId, prompt, what = "网页会话", onLog = null) {
  const text = await deepseekCompleteInSession("", {
    prompt, chatId, expectJson: true, site: state.site, cdpEndpoint: state.cdp,
    timeoutMs: LONG_TIMEOUT_MS,
  });
  return parseJsonOrFail(text, { what, onLog });
}

/**
 * 创建导入步骤共享状态。
 * @param {object} opts
 *   - cdpEndpoint: string          CDP 端点（后端 Playwright 附加用户 Chrome；空 = 后端默认）
 *   - site: string                 桥接站点（deepseek / doubao / qwen）
 *   - sessionId: string            用户选定的会话 id（会话模式的大纲提取用；空 = 自动新建）
 *   - storyText: string            故事正文（正文模式：自动新建会话分片注入全文后提取大纲，
 *                                  忽略 sessionId，避免污染原会话）
 *   - timelineDigest: string       当前时间线摘要
 *   - frameRate: number            帧率
 *   - existingSubjects: array      现有主体
 */
export function createImportState(opts = {}) {
  return {
    cdp: String(opts.cdpEndpoint || "").trim(),
    site: String(opts.site || "deepseek"),
    sessionId: String(opts.sessionId || ""),
    storyText: String(opts.storyText || "").trim(),
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

// 故事正文分片大小：豆包/千问输入框对超长文本有限制，按段落边界切成约 4000 字/片
const STORY_CHUNK_SIZE = 4000;

function splitStoryChunks(text, size = STORY_CHUNK_SIZE) {
  const paras = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const chunks = [];
  let cur = "";
  const pushCur = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const p of paras) {
    if (!p.trim()) continue;
    if (p.length > size) {
      // 超长单段：硬切，避免单条消息超限
      pushCur();
      for (let i = 0; i < p.length; i += size) {
        chunks.push(p.slice(i, i + size).trim());
      }
      continue;
    }
    if (cur && (cur.length + 1 + p.length) > size) pushCur();
    cur = cur ? `${cur}\n${p}` : p;
  }
  pushCur();
  return chunks;
}

/**
 * 大纲提取 · 故事正文模式：自动新建会话，把整本书分片注入（每片让模型只回
 * 「已收到」，不污染上下文语义），全部发完后再发提取指令，产出与会话模式
 * 相同的大纲 JSON。全程在**新会话**内进行，不污染用户原会话。
 */
async function runOutlineFromText(state, storyText, { token = null, onLog = () => {} }) {
  const chunks = splitStoryChunks(storyText);
  if (!chunks.length) throw new Error("故事正文为空，无法注入");
  const total = chunks.length;
  const estMin = Math.round((total * 12 + 60) / 60);
  onLog("info", `故事正文模式：自动新建会话，全文 ${storyText.length} 字将分 ${total} 条消息注入（预计 ${estMin} 分钟左右）…`);

  // 首片：新会话发出，从返回 chatId 建立会话
  const firstPrompt =
    `我接下来会分 ${total} 条消息发送一部完整故事的全文。` +
    `每收到一条只回复「已收到」三个字，不要分析、不要总结、不要展开；` +
    `等我明确说全文发送完毕并给出任务指令后，再开始正式任务。\n\n` +
    `【第 1/${total} 部分】\n${chunks[0]}`;
  const firstResp = await deepseekCompleteNewSession("", {
    prompt: firstPrompt,
    expectJson: false,
    site: state.site,
    cdpEndpoint: state.cdp,
    timeoutMs: LONG_TIMEOUT_MS,
  });
  if (!firstResp.chatId) {
    throw new Error("已发送第 1 条正文，但未能取得新会话 id（无法继续注入，请重试）");
  }
  const chatId = firstResp.chatId;
  state.sessionId = chatId;
  if (!state.createdSessions.includes(chatId)) state.createdSessions.push(chatId);
  onLog("info", `已新建故事会话 ${chatId.slice(0, 8)}…（1/${total} 条已发送）`);

  // 第 2..N 片：同会话逐条追问（片间随机等待，避免高频触发站点风控）
  for (let i = 1; i < total; i++) {
    checkCancelled(token);
    const gap = 3 + Math.floor(Math.random() * 6); // 3-9s 拟人间隔
    onLog("info", `等待 ${gap}s 后发送第 ${i + 1} 条正文…`);
    await humanGap(3, 9);
    const reply = await deepseekCompleteInSession("", {
      prompt: `【第 ${i + 1}/${total} 部分】\n${chunks[i]}\n（收到后只回复「已收到」，继续等待）`,
      chatId,
      expectJson: false,
      site: state.site,
      cdpEndpoint: state.cdp,
      timeoutMs: LONG_TIMEOUT_MS,
    });
    const brief = String(reply || "").replace(/\s+/g, "");
    if (brief.length > 30) {
      onLog("warn", `第 ${i + 1} 条正文后模型回复了较长内容（未只回「已收到」），已继续注入；若后续提取偏离全文可手动重跑`);
    }
    onLog("info", `已发送 ${i + 1}/${total} 条正文`);
  }

  checkCancelled(token);
  // 全部发送完毕 → 提取指令（与会话模式同一个 story-design 模板）
  onLog("info", "全文注入完毕，正在提取故事大纲（网页生成通常 30-90s）…");
  const storyTpl = await loadSkill("story-design");
  const extractPrompt = fillTemplate(storyTpl, {
    input:
      `（提取指令）前面 ${total} 条消息合起来是完整故事全文，现已全部发送完毕。` +
      `请通读全文，按你的任务要求提取用户想拍的故事并输出任务要求的 JSON；` +
      `以故事正文为准，不要遗漏主线与关键人物。` +
      `特别注意：全文中的台词、字幕、音效/环境音、运镜、微表情等制作要素必须逐场原样保留，` +
      `台词保留原句全文与说话人，一句都不许丢；无台词的场次显式写「无台词」。`,
  });
  const outlineText = await deepseekCompleteInSession("", {
    prompt: extractPrompt,
    chatId,
    expectJson: true,
    site: state.site,
    cdpEndpoint: state.cdp,
    timeoutMs: LONG_TIMEOUT_MS,
  });
  const outline = parseJsonOrFail(outlineText, { what: "故事大纲", onLog });
  return finishOutline(state, outline, onLog);
}

/**
 * 步骤 1：故事大纲 —— 两种输入模式：
 * - 正文模式（填了故事正文）：自动新建会话，分片注入全文后提取（不污染原会话）；
 * - 会话模式：在用户选定会话内提取（利用会话完整上下文）；
 *   未选定会话（豆包/千问手动模式可留空）时自动新建会话并记录到 createdSessions。
 * 结果仅缓存到 state.outline，不写入导演台。
 */
export async function runOutlineStep(state, { token = null, onLog = () => {} } = {}) {
  checkCancelled(token);
  const storyText = String(state.storyText || "").trim();
  if (storyText) {
    return runOutlineFromText(state, storyText, { token, onLog });
  }
  onLog("info", "在所选会话内提取故事大纲（网页生成通常 30-90s）…");
  const storyTpl = await loadSkill("story-design");
  const outlinePrompt = fillTemplate(storyTpl, {
    input:
      "（提取指令）请通读本会话上方的全部对话内容，按你的任务要求提取用户想拍的故事。" +
      "以用户表达的内容为准；对话中未被用户采纳的方案不要写入。" +
      "特别注意：对话中的台词、字幕、音效/环境音、运镜、微表情等制作要素必须逐场原样保留，" +
      "台词保留原句全文与说话人，一句都不许丢；无台词的场次显式写「无台词」。",
  });
  if (!state.sessionId) {
    // 手动模式未填会话：自动新建大纲会话（后续步骤在同会话/分镜会话内追问）
    const resp = await deepseekCompleteNewSession("", {
      prompt: outlinePrompt,
      expectJson: true,
      site: state.site,
      cdpEndpoint: state.cdp,
      timeoutMs: LONG_TIMEOUT_MS,
    });
    if (!resp.chatId) {
      throw new Error("大纲已生成，但未能从页面取得新会话 id（无法继续后续步骤，请重试）");
    }
    state.sessionId = resp.chatId;
    state.createdSessions.push(resp.chatId);
    onLog("info", `已自动新建大纲会话 ${resp.chatId.slice(0, 8)}…`);
    const outline = parseJsonOrFail(resp.text, { what: "故事大纲", onLog });
    return finishOutline(state, outline, onLog);
  }
  const outlineText = await deepseekCompleteInSession("", {
    prompt: outlinePrompt,
    chatId: state.sessionId,
    expectJson: true,
    site: state.site,
    cdpEndpoint: state.cdp,
    timeoutMs: LONG_TIMEOUT_MS,
  });
  const outline = parseJsonOrFail(outlineText, { what: "故事大纲", onLog });
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
  if (!state.outline) throw new Error("请先执行「故事大纲」步骤");
  checkCancelled(token);
  onLog("info", "新建会话并进行分镜设计（storyboard-design，通常 40-120s）…");
  const sbTpl = await loadSkill("storyboard-design");
  const sbPrompt = fillTemplate(sbTpl, {
    input: storyDigest(state.outline),
    timeline_digest: state.timelineDigest,
    frame_rate: state.frameRate,
  });
  const sbResp = await deepseekCompleteNewSession("", {
    prompt: sbPrompt,
    expectJson: true,
    site: state.site,
    cdpEndpoint: state.cdp,
    timeoutMs: LONG_TIMEOUT_MS,
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
  const sb = parseJsonOrFail(sbResp.text, { what: "分镜设计", onLog });
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
  const charRes = await genJsonInSession(state, chatId, charPrompt, "主体设计", onLog);
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
  const ff = await genJsonInSession(state, chatId, ffPrompt, "首帧图提示词", onLog);
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
  const audioRes = await genJsonInSession(state, chatId, audioPrompt, "音频设计", onLog);
  state.audios = Array.isArray(audioRes.subjects) ? audioRes.subjects : [];
  onLog("success", `音频设计完成：${state.audios.length} 条`);
  return state.audios;
}

/**
 * 步骤 6：批量分镜转 H3 提示词（不注入 skills guide / skill_notes）。
 * 会话轮换策略：新开会话 → 随机咨询 1-3 个分镜 → 关闭该会话 → 再开新会话，
 * 循环直到全部转换（降低单会话高频连发触发站点风控的概率）。
 * 解析失败 / 缺字段 / 疑似串轮时**不自动追问**，弹出对话框展示原始提示词与
 * 最后回复，由用户决定「采纳 / 重试 / 跳过」；重试必须用户逐次确认。
 * 结果写回 state.shots[i].h3。
 */
export async function runH3Step(
  state,
  { token = null, onLog = () => {}, askH3Fail = null } = {}
) {
  if (!Array.isArray(state.shots) || !state.shots.length) {
    throw new Error("请先执行「分镜设计」步骤");
  }
  const total = state.shots.length;
  // 写作指南整批只拉取一次（60s 缓存），注入每镜的 system
  const system = await buildWebChatH3System();
  onLog("info", `批量转换 ${total} 个镜头为 H3 提示词（新开会话 → 随机 1-3 镜 → 关闭会话 → 轮换）…`);
  // 会话轮换状态：chatId 为空表示下次发送要开新会话
  let chatId = "";
  let usedInSession = 0;
  let sessionQuota = 1 + Math.floor(Math.random() * 3); // 本会话计划 1-3 镜
  // 关闭当前会话；删除失败则保留 id 到 createdSessions，供「清理会话」重试
  const closeSession = async () => {
    if (!chatId) return;
    const cid = chatId;
    chatId = "";
    usedInSession = 0;
    sessionQuota = 1 + Math.floor(Math.random() * 3);
    try {
      await deepseekDeleteSession("", cid, state.site, state.cdp);
      onLog("info", `已关闭会话 ${cid.slice(0, 8)}…`);
    } catch (e) {
      if (!state.createdSessions.includes(cid)) state.createdSessions.push(cid);
      onLog("warn", `关闭会话 ${cid.slice(0, 8)}… 失败（稍后可用「清理会话」重试）：${e.message || e}`);
    }
  };
  // 发送一镜：有会话在同会话追问；无会话则新开会话（首镜即新会话首条消息）
  const askShot = async (prompt) => {
    checkCancelled(token);
    if (chatId) {
      const text = await deepseekCompleteInSession("", {
        site: state.site,
        system,
        prompt,
        chatId,
        expectJson: true,
        cdpEndpoint: state.cdp,
        timeoutMs: LONG_TIMEOUT_MS,
      });
      usedInSession += 1;
      return text;
    }
    const resp = await deepseekCompleteNewSession("", {
      site: state.site,
      system,
      prompt,
      expectJson: true,
      cdpEndpoint: state.cdp,
      timeoutMs: LONG_TIMEOUT_MS,
    });
    if (!resp.chatId) {
      throw new Error("已发送但未能取得新会话 id（无法继续会话轮换）");
    }
    chatId = resp.chatId;
    usedInSession = 1;
    onLog("info", `已开新会话 ${resp.chatId.slice(0, 8)}…（本会话计划 ${sessionQuota} 镜）`);
    return resp.text;
  };
  // 纠正追问提示（仅在用户点「重试」后发送）
  const H3_RETRY_NOTE =
    "\n\n上一次的回复不是合法的 H3 JSON（或缺 summary / detailed_description 字段，" +
    "或是上一次提问的残留内容）。请针对本次 Shot description 重新输出：只输出一个 JSON 对象，" +
    "键为 summary / detailed_description / overall_soundscape / non_diegetic_music，" +
    "不要任何解释文字、不要 Markdown 围栏之外的内容。";
  const toH3 = (obj) =>
    // 标签格式清洗：模型偶发输出「<@ 张三>」「<#李四：你好 >」等畸形标签，
    // 不清洗会破坏主体绑定与 chip 渲染（parseH3Lenient 内已清洗，此处幂等兜底）
    normalizeH3Json({
      summary: String(obj.summary || ""),
      detailed_description: String(obj.detailed_description || ""),
      overall_soundscape: String(obj.overall_soundscape || ""),
      non_diegetic_music: String(obj.non_diegetic_music || ""),
    });
  // 宽松解析与单镜转换共用同一入口（llm.js parseH3Lenient）：
  // 常规提取 → 去尾逗号 → 全角标点修复，成功后统一做标签清洗
  const parseLenient = parseH3Lenient;
  const failed = [];
  for (let i = 0; i < total; i++) {
    checkCancelled(token);
    // 会话轮换：上一镜已用满本会话配额（随机 1-3 镜）→ 关闭当前会话，本镜开新会话。
    // 放在循环开头，覆盖成功 / 跳过 / 失败等所有 continue 路径
    if (chatId && usedInSession >= sessionQuota) {
      const gap = 3 + Math.floor(Math.random() * 4);
      onLog("info", `会话已用满 ${sessionQuota} 镜，等待 ${gap}s 后关闭并开新会话…`);
      await humanGap(3, 7);
      await closeSession();
    }
    // 镜间随机等待 4-10s（拟人节奏）：会话轮换已分散单会话连发压力，
    // 间隔相应缩短；被吞的镜头由后端风控冷却重试兜底
    if (i > 0) {
      const gap = 4 + Math.floor(Math.random() * 7);
      onLog("info", `等待 ${gap}s 后处理镜头 ${i + 1}…`);
      await humanGap(4, 10);
    }
    const shot = state.shots[i];
    const sec = Number(shot.duration_seconds) > 0 ? Number(shot.duration_seconds) : 5;
    const prompt = `Duration: ${sec}s.\nShot description:\n${shot.prompt || ""}`;
    let reply = "";
    try {
      reply = await askShot(prompt);
    } catch (e) {
      // 发送层面失败弹窗由用户决定（不自动重发）：
      // - 疑似风控：可「拉取会话最后回复」——发送可能已上屏但回复流未捕获，
      //   从 DOM 读最后一条助手回复（不发送任何消息），拉到的旧回复由串轮检测拦截
      // - 重试 = 重发该镜提示词（内容未上屏或未获回复时，不构成重复内容）
      const isRisk = !!e?.risk || RISK_HINTS.some((w) => String(e?.message || "").includes(w));
      let reason = isRisk
        ? `疑似站点风控（发送未生效 / 未检测到回复）：${e?.message || e}`
        : `发送失败：${e?.message || e}`;
      console.log(`[MRD 导入] 镜头 ${i + 1} ${reason}`);
      if (!askH3Fail) {
        failed.push(`#${i + 1} ${reason}`);
        onLog("warn", `镜头 ${i + 1} ${reason}`);
        continue;
      }
      let decided = false;
      while (!decided) {
        const decision = await askH3Fail({
          shotIndex: i + 1,
          total,
          reason,
          prompt,
          reply: "",
          canPull: isRisk,
        });
        if (decision === "pull") {
          onLog("info", "拉取会话最后回复（不发送任何消息）…");
          const r = await webchatLastReply({
            site: state.site,
            chatId,
            cdpEndpoint: state.cdp,
          });
          if (r.ok && String(r.text || "").trim()) {
            reply = r.text;
            decided = true; // 拿到回复 → 进入解析决策循环（串轮检测拦截陈旧内容）
          } else {
            reason = r.ok ? "拉取完成，但会话中没有回复内容" : `拉取失败：${r.error}`;
            onLog("warn", `镜头 ${i + 1} ${reason}`);
          }
        } else if (decision === "retry") {
          try {
            reply = await askShot(prompt);
            decided = true;
          } catch (e2) {
            reason = `重试仍失败：${e2?.message || e2}`;
            onLog("warn", `镜头 ${i + 1} ${reason}`);
          }
        } else {
          // skip / 关闭对话框
          failed.push(`#${i + 1} 已跳过（${reason}）`);
          onLog("warn", `镜头 ${i + 1} 已跳过`);
          decided = true;
        }
      }
      if (!reply) continue;
    }
    // 解析 + 用户决策循环：任何重发都必须经用户确认（防风控封号）
    const prev = i > 0 ? state.shots[i - 1]?.h3 : null;
    let obj = null;
    for (;;) {
      obj = parseLenient(reply);
      const dup =
        obj && prev &&
        String(obj.detailed_description || "").trim() === prev.detailed_description;
      const badFields =
        obj && !(String(obj.summary || "").trim() && String(obj.detailed_description || "").trim());
      if (obj && !dup && !badFields) break;
      const reason = !obj
        ? "回复无法解析为 H3 JSON"
        : dup
          ? "结果与上一镜完全相同（疑似串轮残留）"
          : "H3 JSON 缺少 summary / detailed_description 字段";
      console.log(`[MRD 导入] 镜头 ${i + 1} ${reason}：\n`, reply);
      if (!askH3Fail) {
        // 无对话框环境：不自动追问，保守记失败
        failed.push(`#${i + 1} ${reason}`);
        onLog("warn", `镜头 ${i + 1} ${reason}（完整原文已打印到浏览器控制台）`);
        obj = null;
        break;
      }
      const decision = await askH3Fail({
        shotIndex: i + 1,
        total,
        reason,
        prompt,
        reply,
      });
      if (decision === "adopt") {
        if (!obj) {
          onLog("warn", `镜头 ${i + 1}：回复中未找到 JSON 结构，无法采纳（已按失败处理）`);
          failed.push(`#${i + 1} 采纳失败：回复中无 JSON 结构`);
          obj = null;
        }
        // 缺字段时按现状采纳（缺失字段置空），由用户在导演台手动补
        break;
      }
      if (decision === "retry") {
        try {
          reply = await askShot(prompt + H3_RETRY_NOTE);
        } catch (e) {
          onLog("warn", `镜头 ${i + 1} 重试发送失败：${e.message || e}`);
        }
        continue;
      }
      // skip / 关闭对话框
      failed.push(`#${i + 1} 已跳过（${reason}）`);
      obj = null;
      break;
    }
    if (!obj) continue;
    shot.h3 = toH3(obj);
    onLog("info", `镜头 ${i + 1}/${total} 已转换`);
  }
  // 批量结束：关闭最后一个会话（无残留会话时为 no-op）
  await closeSession();
  const ok = state.shots.filter((s) => s.h3).length;
  if (!ok) throw new Error(`全部镜头转换失败（${failed.length} 个，详见控制台与日志）`);
  if (failed.length) onLog("warn", `${failed.length} 个镜头未转换：${failed.join("；")}`);
  onLog("success", `批量 H3 转换完成：${ok}/${total} 个镜头`);
  return state.shots.filter((s) => s.h3);
}

/**
 * 组装某一步骤的同步载荷（交由调用方写入 workspace）。
 * type: storyboard | subjects | firstframe | audio | h3
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
    case "h3":
      return {
        type: "h3",
        items: state.shots
          .map((s, i) => ({ index: i + 1, h3: s.h3 }))
          .filter((it) => it.h3 && typeof it.h3 === "object"),
      };
    default:
      return null; // outline 仅缓存，无同步载荷
  }
}

/**
 * 清理本次导入新建的会话（「清理会话」独立按钮；删除失败只告警）。
 * @returns {Promise<number>} 成功删除的会话数
 */
export async function cleanupImportSessions(state, onLog = () => {}) {
  let removed = 0;
  for (const cid of state.createdSessions) {
    try {
      await deepseekDeleteSession("", cid, state.site, state.cdp);
      removed += 1;
    } catch (e) {
      onLog("warn", `删除会话 ${String(cid).slice(0, 8)}… 失败：${e.message || e}`);
    }
  }
  state.createdSessions = state.createdSessions.slice(removed);
  if (removed) onLog("success", `已清理本次新建的 ${removed} 个会话`);
  return removed;
}

/**
 * 「结束会话」：只关闭「故事大纲」之后步骤新建的会话（大纲会话保留）。
 * createdSessions 里第一个自动新建的通常就是大纲会话（state.sessionId）；
 * 用户自选会话时大纲不在其中，则全部关闭。
 * @returns {Promise<{removed:number,total:number}>}
 */
export async function closeStepSessions(state, onLog = () => {}) {
  const keep = String(state.sessionId || "");
  const targets = (state.createdSessions || []).filter((cid) => cid && cid !== keep);
  let removed = 0;
  for (const cid of targets) {
    try {
      await deepseekDeleteSession("", cid, state.site, state.cdp);
      removed += 1;
      state.createdSessions = state.createdSessions.filter((x) => x !== cid);
    } catch (e) {
      onLog("warn", `关闭会话 ${String(cid).slice(0, 8)}… 失败：${e.message || e}`);
    }
  }
  if (removed) onLog("success", `已关闭大纲之后新建的 ${removed} 个会话（大纲会话保留）`);
  return { removed, total: targets.length };
}
