<script setup>
// 网页分镜导入弹窗（DeepSeek / 豆包 / 千问）：两阶段（手动逐步模式，无一键全自动）
// 阶段一：选择桥接站点会话 —— 三站统一会话列表（后端 /spa/webchat/sessions：
//   DeepSeek 站内 API；豆包/千问扫描页面侧栏）；侧栏扫描失败时可手动粘贴
//   会话链接 / ID 兜底（可留空，导入时自动新建大纲会话）。
//   另支持「故事正文」模式：粘贴/读取整本书 → 自动新建会话分片注入后提取大纲，
//   忽略所选会话（原会话零污染）。
// 阶段二：步骤卡片（故事大纲 → 分镜设计 → 主体设计 → 首帧图 → 音频设计 → 批量转H3），
//   每步「执行」（在站点网页会话生成），成功后自动写入导演台（大纲仅缓存）；
//   或点红色「一键导入」自动依次执行全部步骤（步骤间随机等待模拟人为节奏）。
// 同步后 emit("sync", payload)，由 Storyboard.vue 分类型写入分镜 / 主体 / 音频 / H3。
// 会话删除三站均支持：DeepSeek 走站内 API；豆包/千问走页面 UI 流程（后端驱动实现）。
// 底部「结束会话」关闭大纲之后步骤新建的会话；「完成」只关闭弹窗。
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import {
  PROXY_SITES,
  SITE_LABELS,
  setCdpEndpoint,
  deepseekAttempt,
  deepseekCancel,
  deepseekListSessions,
} from "../../utils/llm.js";
import {
  IMPORT_STEPS,
  buildSyncPayload,
  cleanupImportSessions,
  closeStepSessions,
  createImportState,
  createImportToken,
  runAudioStep,
  runFirstframeStep,
  runH3Step,
  runOutlineStep,
  runStoryboardStep,
  runSubjectsStep,
} from "../../utils/deepseekImport.js";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "sync"]);

const ws = useWorkspace();
const cdpEndpoint = computed(() => (ws.llm.cdp_endpoint || "").trim());
const site = computed(() => PROXY_SITES[ws.llm.mode] || "");
const siteLabel = computed(() => SITE_LABELS[site.value] || site.value || "");
const isBridgeSite = computed(() => !!site.value);
// 会话列表/删除三站均支持（DeepSeek 走站内 API；豆包/千问走页面 UI 流程，后端驱动实现）
const supportsDelete = computed(() => !!site.value);

// ---- 阶段一：会话选择 ----
const phase = ref("select"); // select | run
const sessions = ref([]);
const loading = ref(false);
const loadError = ref("");
const keyword = ref("");
const selectedId = ref("");
// 手动兜底：粘贴会话链接（如 https://www.doubao.com/chat/xxx）或会话 ID
const manualInput = ref("");
const manualId = computed(() => {
  const raw = String(manualInput.value || "").trim();
  if (!raw) return "";
  const m = raw.match(/\/chat\/([0-9A-Za-z_-]+)/i) || raw.match(/\/a\/chat\/s\/([0-9A-Za-z_-]+)/i);
  if (m) return m[1];
  // 允许直接粘贴纯 ID
  return /^[0-9A-Za-z_-]{6,}$/.test(raw) ? raw : "";
});

// 故事正文模式：粘贴 / 读取整本书，大纲步骤改为「自动新建会话分片注入全文后提取」，
// 不使用所选会话 —— 原会话零污染。填了正文时会话选择被忽略。
const storyText = ref("");
const storyFileRef = ref(null);
const STORY_CHUNK_SIZE = 4000; // 与 deepseekImport.splitStoryChunks 的分片大小一致
const storyChunkCount = computed(() => {
  const t = storyText.value.trim();
  return t ? Math.max(1, Math.ceil(t.length / STORY_CHUNK_SIZE)) : 0;
});

function onStoryFile(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    storyText.value = String(reader.result || "").replace(/\r\n/g, "\n").trim();
    ElMessage.success(`已读取「${f.name}」（${storyText.value.length} 字）`);
  };
  reader.onerror = () => ElMessage.error("文件读取失败，请改用粘贴方式");
  reader.readAsText(f, "utf-8");
  e.target.value = "";
}

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return sessions.value;
  return sessions.value.filter((s) => (s.title || "").toLowerCase().includes(k));
});

async function loadSessions() {
  if (!isBridgeSite.value) return;
  setCdpEndpoint(cdpEndpoint.value);
  loading.value = true;
  loadError.value = "";
  try {
    sessions.value = await deepseekListSessions("", site.value, cdpEndpoint.value);
  } catch (e) {
    // 失败时同步清空残留列表：上次加载的结果不代表当前真实状态（如会话已被
    // 用户在站点里删光），保留会误导选择；错误提示由 loadError 呈现
    sessions.value = [];
    loadError.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

// 页面自检：CDP 连接状态 + 站点标签页里输入框/发送按钮是否可定位（DOM 改版排查）
const diagLoading = ref(false);
async function runDiag() {
  if (!isBridgeSite.value) {
    ElMessage.warning("当前 LLM 模式不支持网页桥接导入");
    return;
  }
  diagLoading.value = true;
  try {
    const d = await deepseekDiag("", cdpEndpoint.value);
    const lines = [];
    if (!d.connected) {
      lines.push(`CDP 连接：未连接${d.error ? `<br/>原因：${d.error}` : ""}`);
    } else {
      const entry = (d.sites || []).find((s) => s.id === site.value) || {};
      lines.push(`CDP 连接：已连接（${d.endpoint}）`);
      lines.push(`${siteLabel.value} 标签页：${entry.tabs ?? 0} 个`);
      const probes = entry.probes || [];
      if (!probes.length) {
        lines.push("该站点暂无打开的标签页（请先在调试 Chrome 中打开并登录站点网页）");
      }
      for (const p of probes) {
        if (p.error) {
          lines.push(`标签页探针失败：${p.error}`);
          continue;
        }
        lines.push(
          `页面：${(p.url || "").slice(0, 60)}<br/>` +
          `输入框：${p.inputFound ? `已找到（${p.inputKind || "?"}）` : "未找到"} · ` +
          `发送按钮：${p.sendButtonFound ? "已找到" : "未找到"} · ` +
          `回复区文本块：${p.assistantBlocks ?? 0} 个`
        );
        if (p.inputCandidates && p.inputCandidates.length) {
          lines.push(
            "输入框候选：" +
              p.inputCandidates
                .map((c) => `${c.tag}#${c.id || "-"}(${c.size})`)
                .join("、")
          );
        }
      }
    }
    await ElMessageBox.alert(lines.join("<br/>"), `${siteLabel.value} 页面自检`, {
      dangerouslyUseHTMLString: true,
      confirmButtonText: "知道了",
    });
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    diagLoading.value = false;
  }
}

function relTime(ts) {
  if (!ts) return "";
  const t = typeof ts === "number" ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
  if (!t || isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString();
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      phase.value = "select";
      selectedId.value = "";
      keyword.value = "";
      manualInput.value = "";
      resetRun();
      loadSessions();
    }
  }
);

// ---- 阶段二：步骤卡片（执行 / 同步）----
const stepState = reactive({}); // key → { status, synced, summary }
const logs = ref([]);
const runningStep = ref("");
const runError = ref("");
const tokenRef = ref(null);
const stateRef = ref(null);
const logBoxRef = ref(null);
const storyboardSynced = ref(false); // 分镜是否已同步（首帧同步依赖已有分镜）

const visibleSteps = IMPORT_STEPS;

function stepOf(key) {
  if (!stepState[key]) stepState[key] = { status: "idle", synced: false, summary: "" };
  return stepState[key];
}

const STEP_RUNNERS = {
  outline: (state, ctx) => runOutlineStep(state, ctx),
  storyboard: (state, ctx) => runStoryboardStep(state, ctx),
  subjects: (state, ctx) => runSubjectsStep(state, ctx),
  firstframe: (state, ctx) => runFirstframeStep(state, ctx),
  audio: (state, ctx) => runAudioStep(state, ctx),
  h3: (state, ctx) => runH3Step(state, ctx),
};

function canRun(key) {
  const st = (k) => stepState[k]?.status;
  if (runningStep.value) return false;
  if (key === "storyboard" || key === "subjects" || key === "audio") return st("outline") === "done";
  // 首帧 / H3 均按分镜序号回写，必须已有分镜写入导演台
  if (key === "firstframe" || key === "h3") return st("storyboard") === "done" && storyboardSynced.value;
  return true;
}
function runHint(key) {
  const st = (k) => stepState[k]?.status;
  if (runningStep.value) return "有步骤执行中";
  if ((key === "storyboard" || key === "subjects" || key === "audio") && st("outline") !== "done")
    return "请先执行「故事大纲」";
  if ((key === "firstframe" || key === "h3")) {
    if (st("storyboard") !== "done") return "请先执行「分镜设计」";
    if (!storyboardSynced.value) return "分镜尚未写入导演台（执行成功会自动写入）";
  }
  if (key === "outline") return "大纲仅缓存，作为后续步骤输入，不写入导演台";
  return "";
}

// 已用时 / 阶段轮询（让「长时间等待」可见）
const elapsed = ref(0);
let elapsedTimer = null;
const stageText = ref("");
const debugTail = ref([]);
let stageTimer = null;
const STAGE_LABELS = {
  queued: "已排队",
  tab_ready: "已连接站点标签页",
  tab_alive: "已确保页面可见（小窗）",
  go_home: "正在回到首页开新会话",
  home_ready: "已回到首页",
  navigating: "正在打开会话页面",
  nav_done: "会话页面已就绪",
  content_ready: "页面脚本已就绪",
  content_stale: "页面脚本过旧，已刷新",
  input_probe: "等待输入框就绪",
  write_start: "正在写入输入框",
  write_done: "写入完成，核对回读",
  enter_sent: "已回车提交",
  sent_check: "核对用户消息是否出现",
  send_retry: "重试发送（点击发送按钮）",
  send_ok: "已确认消息出现在页面，等待回复",
  stream_start: "回复生成中",
  stream_done: "回复生成完毕",
  replied: "已取回回复",
  reply_via_sse: "已取回回复（SSE 通道）",
  reply_via_dom: "已取回回复（DOM 兜底）",
  reply_not_json_yet: "回复未含 JSON，等待更完整正文",
  reply_not_json_timeout: "回复始终不含 JSON，交由前端追问",
  reply_error: "调用失败",
  no_signal: "90s 内无回复信号",
  no_input: "未找到输入框",
  write_failed: "写入输入框失败",
  send_failed: "发送失败",
  timeout: "等待超时",
  cancelled: "已取消",
  exception: "页面执行异常",
};

function startElapsed() {
  elapsed.value = 0;
  stageText.value = "";
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    elapsed.value += 1;
  }, 1000);
  clearInterval(stageTimer);
  stageTimer = setInterval(async () => {
    try {
      const d = await deepseekAttempt();
      const stages = (d && d.lastAttempt && d.lastAttempt.stages) || [];
      const last = stages[stages.length - 1];
      if (last) stageText.value = STAGE_LABELS[last.stage] || last.stage;
      else if (d && d.version) stageText.value = `扩展 v${d.version}（暂无阶段上报）`;
      debugTail.value = (d && d.debugTail) || [];
    } catch {
      // 忽略轮询失败
    }
  }, 3000);
}

function stopElapsed() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
  clearInterval(stageTimer);
  stageTimer = null;
}
onBeforeUnmount(stopElapsed);

function resetRun() {
  for (const k of Object.keys(stepState)) delete stepState[k];
  logs.value = [];
  runError.value = "";
  debugTail.value = [];
  runningStep.value = "";
  storyboardSynced.value = false;
  stateRef.value = null;
  autoRunning.value = false;
  autoCancelled.value = false;
}

// ---- H3 回复解析失败决策对话框（不自动追问，防站点风控封号）----
// runH3Step 解析失败/缺字段/疑似串轮时回调 askH3Fail，展示原始提示词与最后回复，
// 由用户决定「采纳 / 重试（重新发送一次纠正提示）/ 跳过该镜」。
const h3Fail = reactive({ visible: false, info: null, resolve: null });
function askH3Fail(info) {
  return new Promise((resolve) => {
    h3Fail.info = info;
    h3Fail.resolve = resolve;
    h3Fail.visible = true;
  });
}
function h3FailDecide(decision) {
  h3Fail.visible = false;
  const resolve = h3Fail.resolve;
  h3Fail.resolve = null;
  h3Fail.info = null;
  if (resolve) resolve(decision);
}
function h3FailClosed() {
  if (h3Fail.resolve) h3FailDecide("skip");
}

function hhmmss(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function addLog(level, msg) {
  logs.value.push({ level, msg, time: new Date().toLocaleTimeString() });
  nextTick(() => {
    if (logBoxRef.value) logBoxRef.value.scrollTop = logBoxRef.value.scrollHeight;
  });
}

function summarize(key, result) {
  if (key === "outline") {
    // 正文模式（故事导入）：无大纲 JSON，展示导入结果；会话模式展示大纲摘要
    if (storyText.value.trim()) {
      const cid = stateRef.value ? String(stateRef.value.sessionId || "") : "";
      return cid ? `故事已导入（会话 ${cid.slice(0, 8)}…）` : "故事已导入";
    }
    const o = result || {};
    return `${o.title || "(未命名)"} · 主体 ${(o.subjects || []).length} · 场景 ${(o.scenes || []).length}`;
  }
  if (key === "storyboard") return `${(result || []).length} 个镜头`;
  if (key === "subjects") return `${(result || []).length} 个主体`;
  if (key === "firstframe") return `更新 ${(result || []).length} 个镜头的帧提示词`;
  if (key === "audio") return `${(result || []).length} 条音频`;
  if (key === "h3") return `${(result || []).length} 个镜头已转 H3 提示词`;
  return "";
}

// 单步执行入口（手动点击）：守卫后真实执行
async function runStep(step) {
  if (autoRunning.value) return; // 一键导入进行中，禁止手动单步
  if (!canRun(step.key) || !isBridgeSite.value) return;
  await execStep(step);
}

// 真实执行（单步与一键导入共用；前置校验由调用方保证）
async function execStep(step) {
  const key = step.key;
  // 会话可留空：导入第一步自动新建大纲会话（三站均支持）
  if (!stateRef.value) {
    const segs = ws.timeline.segments || [];
    const fps = ws.widgets.frame_rate || 24;
    const digest = segs.length
      ? segs
          .map(
            (s, i) =>
              `${i + 1}. [约${Math.round((s.length || 0) / fps)}s] ${(
                s.prompt || s.h3PromptJson?.summary || ""
              ).slice(0, 60)}`
          )
          .join("\n")
      : "（当前时间线为空）";
    stateRef.value = createImportState({
      cdpEndpoint: cdpEndpoint.value,
      site: site.value,
      sessionId: selectedId.value || manualId.value,
      timelineDigest: digest,
      frameRate: fps,
      existingSubjects: ws.subjects.subjects || [],
      storyText: storyText.value,
    });
  }
  if (storyText.value && key === "outline") {
    addLog("info", "故事导入模式：将忽略所选会话，自动新建会话分片注入全文（后续步骤在此会话内继续）");
  }
  const state = stateRef.value;
  const token = createImportToken();
  tokenRef.value = token;
  runningStep.value = key;
  const st = stepOf(key);
  st.status = "running";
  runError.value = "";
  startElapsed();
  try {
    const result = await STEP_RUNNERS[key](state, { token, onLog: addLog, askH3Fail });
    st.status = "done";
    st.synced = false;
    st.summary = summarize(key, result);
    // 执行成功即自动写入导演台（大纲仅缓存，作为后续步骤输入）
    await autoSync(key, step);
  } catch (e) {
    st.status = "error";
    runError.value = e.message || String(e);
    addLog("error", runError.value);
  } finally {
    runningStep.value = "";
    stopElapsed();
    tokenRef.value = null;
  }
}

// 执行成功后自动写入导演台（大纲仅缓存不写入；分镜重复写入前确认，避免追加重复镜头）
async function autoSync(key, step) {
  if (key === "outline") return; // 大纲仅缓存，作为后续步骤输入
  if (!stateRef.value) return;
  if (key === "storyboard" && storyboardSynced.value) {
    try {
      await ElMessageBox.confirm(
        "分镜已写入过一次。重新执行后将把本次缓存的全部分镜作为新分镜追加到时间线（可能产生重复镜头）。继续？",
        "重复写入确认",
        { type: "warning", confirmButtonText: "继续追加", cancelButtonText: "取消" }
      );
    } catch {
      addLog("warn", "已取消写入：分镜仅缓存，可在「执行」后手动处理");
      return;
    }
  }
  const payload = buildSyncPayload(stateRef.value, key);
  if (!payload) return;
  emit("sync", payload);
  stepOf(key).synced = true;
  if (key === "storyboard") {
    storyboardSynced.value = true;
    stepOf("firstframe").synced = false;
  }
  addLog("success", `「${step.label}」已自动写入导演台`);
}

async function cleanupSessions() {
  if (!supportsDelete.value) {
    ElMessage.info(`${siteLabel.value} 网页版暂不支持自动化删除会话，请在该网页内手动管理`);
    return;
  }
  if (!stateRef.value || !stateRef.value.createdSessions.length) {
    ElMessage.info("本次导入尚未新建会话（大纲复用你选定的会话）");
    return;
  }
  try {
    await ElMessageBox.confirm(
      `删除本次导入新建的 ${stateRef.value.createdSessions.length} 个会话？删除后不可恢复。`,
      "清理会话",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "保留" }
    );
  } catch {
    return;
  }
  const n = await cleanupImportSessions(stateRef.value, addLog);
  ElMessage.success(n ? `已清理 ${n} 个会话` : "没有会话被删除（见日志）");
}

async function cancelStep() {
  if (tokenRef.value) tokenRef.value.cancelled = true;
  addLog("warn", "已请求取消，正在中止当前请求…");
  try {
    const n = await deepseekCancel();
    addLog("warn", `已向后端发送取消${n ? "，正在中止当前网页会话任务" : "（当前无进行中任务）"}`);
  } catch {
    addLog("warn", "取消指令发送失败，将在当前请求结束后中止");
  }
}

// ---- 一键导入：自动依次执行 1-6 步 ----
// 步骤间随机等待 2-6 秒模拟人为操作节奏，降低站点风控风险；
// 任一步失败（或用户取消）立即停止，失败原因/原文见上方日志。
const autoRunning = ref(false);
const autoCancelled = ref(false);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 可中断等待：等待期间点了「取消」立即返回 true
async function interruptibleSleep(ms) {
  const step = 200;
  for (let t = 0; t < ms; t += step) {
    if (autoCancelled.value) return true;
    await sleepMs(step);
  }
  return autoCancelled.value;
}

async function runAllSteps() {
  if (runningStep.value || autoRunning.value || !isBridgeSite.value) return;
  autoRunning.value = true;
  autoCancelled.value = false;
  addLog("info", `一键导入开始：将依次执行 ${visibleSteps.length} 个步骤，步骤间随机等待 2-6 秒模拟人为节奏`);
  try {
    for (const step of visibleSteps) {
      // 已完成的步骤直接跳过（不重新生成；需要重跑某一步时用该步的「执行」按钮）
      if (stepState[step.key]?.status === "done") {
        addLog("info", `「${step.label}」已完成，一键导入跳过该步`);
        continue;
      }
      const delay = 2000 + Math.floor(Math.random() * 4000); // 2-6s 随机
      addLog("info", `等待 ${Math.round(delay / 1000)}s 后执行「${step.label}」…`);
      if (await interruptibleSleep(delay)) {
        addLog("warn", "一键导入已取消");
        return;
      }
      await execStep(step);
      if (stepOf(step.key).status !== "done") {
        addLog("warn", `「${step.label}」未成功，一键导入已停止（原因见上方日志，确认后可手动重新执行该步或重新一键导入）`);
        return;
      }
    }
    addLog("success", "一键导入完成：全部步骤已执行并写入导演台");
  } finally {
    autoRunning.value = false;
    autoCancelled.value = false;
  }
}

// 取消：步骤执行中 → 中止当前请求；步骤间等待 → 直接停止整批
async function cancelRun() {
  if (autoRunning.value && !runningStep.value) {
    autoCancelled.value = true;
    addLog("warn", "已请求取消一键导入（当前处于步骤间等待）");
    return;
  }
  autoCancelled.value = true;
  await cancelStep();
}

function close() {
  if (runningStep.value) return;
  emit("update:modelValue", false);
}

// 底部按钮：「完成」只关闭弹窗；「结束会话」先关闭大纲之后步骤新建的会话再关闭
async function endSessionsAndClose() {
  if (runningStep.value) return;
  const state = stateRef.value;
  if (!state) {
    close();
    return;
  }
  const keep = String(state.sessionId || "");
  const targets = (state.createdSessions || []).filter((cid) => cid && cid !== keep);
  if (!supportsDelete.value) {
    ElMessage.info(`${siteLabel.value} 网页版暂不支持自动化关闭会话，请在该网页内手动管理`);
    close();
    return;
  }
  if (!targets.length) {
    ElMessage.info("没有需要关闭的会话（故事大纲会话保留）");
    close();
    return;
  }
  try {
    await ElMessageBox.confirm(
      `关闭「故事大纲」之后新建的 ${targets.length} 个会话？大纲会话会保留，删除后不可恢复。`,
      "结束会话",
      { type: "warning", confirmButtonText: "关闭会话", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  const { removed, total } = await closeStepSessions(state, addLog);
  if (removed) ElMessage.success(`已关闭 ${removed}/${total} 个会话（大纲会话保留）`);
  else ElMessage.warning("没有会话被关闭（原因见日志）");
  close();
}

function stepBadge(st) {
  if (st.status === "running") return { text: "执行中", cls: "running" };
  if (st.status === "error") return { text: "失败", cls: "error" };
  if (st.status === "done" && st.synced) return { text: "已写入", cls: "synced" };
  if (st.status === "done" || st.status === "warn") return { text: "已完成", cls: "done" };
  return { text: "未执行", cls: "idle" };
}

// 正文模式下步骤标签/提示改为「故事导入」语义（分镜等后续步骤在导入会话内继续）
function stepLabel(st) {
  if (st.key === "outline" && storyText.value.trim()) return "故事导入";
  return st.label;
}
function stepHint(st) {
  if (st.key === "outline" && storyText.value.trim()) {
    return `自动新建会话，${storyChunkCount.value} 条消息分片注入全文即完成（后续步骤在此会话内继续）`;
  }
  if (st.key === "storyboard" && storyText.value.trim()) {
    return "在故事会话内依据全文做分镜设计（不再依赖大纲）";
  }
  return st.hint;
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="phase === 'select' ? `${siteLabel} 分镜导入 · 选择会话` : `${siteLabel} 分镜导入 · 逐步执行`"
    :width="phase === 'select' ? 560 : 680"
    append-to-body
    :close-on-click-modal="phase === 'select' && !runningStep"
    :show-close="!runningStep"
    class="mrd-dsi-dialog"
    @update:model-value="v => (v ? null : close())"
  >
    <!-- 阶段一：会话选择 -->
    <div v-if="phase === 'select'" class="mrd-dsi-select">
      <div class="mrd-dsi-toolbar">
        <el-input v-model="keyword" placeholder="搜索会话标题…" clearable :prefix-icon="'Search'" class="mrd-dsi-search" />
        <el-button :icon="'Refresh'" :loading="loading" @click="loadSessions">刷新</el-button>
      </div>

      <el-alert
        v-if="!isBridgeSite"
        type="warning"
        :closable="false"
        show-icon
        title="当前 LLM 模式不支持网页桥接导入：请在「全局参数 → LLM 设置」切换为 DeepSeek / 豆包 / 千问代理后再导入"
        class="mrd-dsi-alert"
      />
      <el-alert
        v-else-if="loadError"
        type="error"
        :closable="false"
        show-icon
        :title="loadError"
        class="mrd-dsi-alert"
      />
      <el-alert
        v-else
        type="info"
        :closable="false"
        show-icon
        class="mrd-dsi-alert"
        title="选择一个包含你创作构想的会话：导入将在该会话内提取故事大纲，随后每个步骤由你手动「执行」，成功后自动写入导演台。若你已有完整故事文本，直接在下方「故事正文」粘贴或读入文件即可。建议控制导入频率，避免短时间高频自动化操作。"
      />

      <!-- 三站统一会话列表（后端拉取：DeepSeek 站内 API；豆包/千问扫描侧栏） -->
      <div v-if="isBridgeSite" class="mrd-dsi-list">
        <template v-if="loading">
          <div v-for="i in 6" :key="i" class="mrd-dsi-skeleton" />
        </template>
        <template v-else-if="filtered.length">
          <button
            v-for="s in filtered"
            :key="s.id"
            type="button"
            class="mrd-dsi-session"
            :class="{ selected: s.id === selectedId }"
            @click="selectedId = s.id"
          >
            <span class="mrd-dsi-session-title">{{ s.title || "（无标题会话）" }}</span>
            <span class="mrd-dsi-session-time">{{ relTime(s.updatedAt) }}</span>
          </button>
        </template>
        <el-empty v-else :description="loadError ? '会话列表加载失败' : '没有匹配的会话'" :image-size="72" />
      </div>

      <!-- 手动兜底：列表为空或扫描失败时粘贴会话链接 / ID -->
      <div v-if="isBridgeSite" class="mrd-dsi-manual">
        <el-input
          v-model="manualInput"
          :placeholder="`或手动粘贴 ${siteLabel} 会话链接 / ID（可选，留空且未选列表 = 自动新建会话）`"
          clearable
        />
        <div v-if="manualInput && !manualId" class="mrd-dsi-manual-err">
          无法从输入中识别会话 ID：请粘贴形如 /chat/&lt;id&gt; 的链接或直接填会话 ID
        </div>
      </div>

      <!-- 故事正文模式：整本书直接注入新会话，不需要先在大纲会话里铺对话 -->
      <div v-if="isBridgeSite" class="mrd-dsi-story">
        <div class="mrd-dsi-story-head">
          <span class="mrd-dsi-story-title">故事正文（可选）</span>
          <span class="mrd-dsi-story-hint">
            填入后步骤一改为「故事导入」：自动新建会话分片注入全文；步骤二直接依据全文做分镜设计。
          </span>
        </div>
        <el-input
          v-model="storyText"
          type="textarea"
          :rows="4"
          :placeholder="`粘贴整本故事书全文，或点右侧按钮读取 txt / md 文件…`"
        />
        <div class="mrd-dsi-story-actions">
          <input
            ref="storyFileRef"
            type="file"
            accept=".txt,.md,.markdown,text/plain"
            style="display: none"
            @change="onStoryFile"
          />
          <el-button size="small" @click="storyFileRef?.click()">读取 txt / md</el-button>
          <el-button v-if="storyText" size="small" text type="danger" @click="storyText = ''">清空</el-button>
          <span class="mrd-dsi-story-meta">
            {{ storyText.length }} 字<template v-if="storyChunkCount"> · 预计分 {{ storyChunkCount }} 条消息注入<template v-if="storyChunkCount > 15">（较多，请耐心等待）</template></template>
          </span>
        </div>
      </div>

      <div class="mrd-dsi-footer">
        <el-button class="mrd-dsi-diag" :loading="diagLoading" @click="runDiag">页面自检</el-button>
        <el-button @click="close">取消</el-button>
        <el-button
          type="primary"
          :disabled="!isBridgeSite"
          @click="phase = 'run'"
        >
          下一步：逐步导入
        </el-button>
      </div>
    </div>

    <!-- 阶段二：步骤卡片（执行 / 同步） -->
    <div v-else class="mrd-dsi-run">
      <div class="mrd-dsi-toolbar-row">
        <span class="mrd-dsi-toolbar-hint">每步「执行」在{{ siteLabel }}网页会话生成，成功后自动写入导演台（大纲仅缓存）</span>
        <div class="mrd-dsi-toolbar-btns">
          <el-button
            size="small"
            :icon="'Delete'"
            :disabled="!!runningStep || !supportsDelete"
            :title="supportsDelete ? '' : `${siteLabel} 暂不支持自动化删除会话`"
            @click="cleanupSessions"
          >清理会话</el-button>
          <el-button v-if="runningStep || autoRunning" size="small" type="danger" plain @click="cancelRun">取消执行</el-button>
          <el-button v-else size="small" @click="phase = 'select'">返回选会话</el-button>
          <el-button
            size="small"
            type="danger"
            :disabled="!!runningStep || autoRunning"
            title="依次自动执行 6 个步骤（步骤间随机等待，模拟人为节奏）"
            @click="runAllSteps"
          >一键导入</el-button>
        </div>
      </div>

      <div class="mrd-dsi-steps">
        <div v-for="(st, idx) in visibleSteps" :key="st.key" class="mrd-dsi-step" :class="{ running: runningStep === st.key }">
          <div class="mrd-dsi-step-head">
            <span class="mrd-dsi-step-idx">{{ idx + 1 }}</span>
            <div class="mrd-dsi-step-titles">
              <span class="mrd-dsi-step-label">{{ stepLabel(st) }}</span>
              <span class="mrd-dsi-step-hint">{{ stepHint(st) }}</span>
            </div>
            <span class="mrd-dsi-step-badge" :class="stepBadge(stepState[st.key] || {}).cls">
              {{ stepBadge(stepState[st.key] || {}).text }}
            </span>
          </div>
          <div v-if="(stepState[st.key] || {}).summary" class="mrd-dsi-step-summary">
            {{ stepState[st.key].summary }}
          </div>
          <div class="mrd-dsi-step-actions">
            <el-button
              size="small"
              type="primary"
              plain
              :disabled="!canRun(st.key) || autoRunning"
              :title="runHint(st.key)"
              @click="runStep(st)"
            >
              {{ stepState[st.key]?.status === "running" ? "执行中…" : "执行" }}
            </el-button>
          </div>
        </div>
      </div>

      <div class="mrd-dsi-elapsed" v-if="runningStep">已用时 {{ elapsed }}s<span v-if="stageText"> · {{ stageText }}</span></div>

      <div ref="logBoxRef" class="mrd-dsi-logbox">
        <div v-for="(l, i) in logs" :key="i" class="mrd-dsi-log" :class="`lv-${l.level}`">
          <span class="mrd-dsi-log-time">{{ l.time }}</span>
          <span class="mrd-dsi-log-msg">{{ l.msg }}</span>
        </div>
      </div>

      <details v-if="debugTail.length" class="mrd-dsi-debug" open>
        <summary>后台事件流水（最近 {{ debugTail.length }} 条）</summary>
        <div class="mrd-dsi-debug-body">
          <div v-for="(e, i) in debugTail" :key="i" class="mrd-dsi-debug-row">
            <span class="mrd-dsi-debug-time">{{ hhmmss(e.at) }}</span>
            <span class="mrd-dsi-debug-kind">{{ e.kind }}</span>
            <span class="mrd-dsi-debug-detail">{{ e.detail }}</span>
          </div>
        </div>
      </details>

      <el-alert v-if="runError" type="error" :closable="false" show-icon :title="runError" class="mrd-dsi-alert" />

      <div class="mrd-dsi-footer">
        <el-button :disabled="!!runningStep" @click="close">完成</el-button>
        <el-button type="danger" plain :disabled="!!runningStep" @click="endSessionsAndClose">
          结束会话
        </el-button>
      </div>
    </div>
  </el-dialog>

  <!-- H3 回复解析失败：展示原始提示词与最后回复，由用户决定采纳/重试/跳过 -->
  <el-dialog
    v-model="h3Fail.visible"
    title="H3 回复解析失败"
    width="680px"
    top="6vh"
    :close-on-click-modal="false"
    append-to-body
    @closed="h3FailClosed"
  >
    <el-alert
      type="warning"
      :closable="false"
      show-icon
      class="mrd-dsi-alert"
      :title="`镜头 ${h3Fail.info?.shotIndex}/${h3Fail.info?.total}：${h3Fail.info?.reason || ''}`"
      description="疑似风控时可「拉取会话最后回复」（读取会话里最后一条助手回复，不发送任何消息；若拉到的是上一镜的旧回复会被串轮检测拦下）。点「重试」则重发一次提示词（每点一次只重发一条，不会自动连发）。"
    />
    <div class="mrd-dsi-h3fail-block">
      <div class="mrd-dsi-h3fail-label">原始提示词</div>
      <pre class="mrd-dsi-h3fail-pre">{{ h3Fail.info?.prompt }}</pre>
    </div>
    <div class="mrd-dsi-h3fail-block">
      <div class="mrd-dsi-h3fail-label">站点最后回复</div>
      <pre class="mrd-dsi-h3fail-pre">{{ h3Fail.info?.reply }}</pre>
    </div>
    <template #footer>
      <el-button @click="h3FailDecide('skip')">跳过该镜</el-button>
      <el-button
        v-if="h3Fail.info?.canPull"
        type="success"
        plain
        @click="h3FailDecide('pull')"
      >
        拉取会话最后回复
      </el-button>
      <el-button type="warning" plain @click="h3FailDecide('retry')">
        {{ h3Fail.info?.reply ? "重试（重发一条纠正提示）" : "重试（重发该镜提示词）" }}
      </el-button>
      <el-button v-if="h3Fail.info?.reply" type="primary" @click="h3FailDecide('adopt')">
        采纳该回复
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mrd-dsi-select { display: flex; flex-direction: column; gap: 12px; }
.mrd-dsi-toolbar { display: flex; gap: 8px; }
.mrd-dsi-search { flex: 1; }
.mrd-dsi-alert { border-radius: 8px; }
.mrd-dsi-manual { display: flex; flex-direction: column; gap: 6px; }
.mrd-dsi-manual-err { font-size: 11px; color: #f87171; }
.mrd-dsi-story {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px dashed #2c3242;
  border-radius: 10px;
  background: #13161f;
}
.mrd-dsi-story-head { display: flex; flex-direction: column; gap: 2px; }
.mrd-dsi-story-title { font-size: 12px; font-weight: 600; color: #cbd5e1; }
.mrd-dsi-story-hint { font-size: 11px; color: #8a93a6; line-height: 1.5; }
.mrd-dsi-story-actions { display: flex; align-items: center; gap: 8px; }
.mrd-dsi-story-meta { font-size: 11px; color: #8a93a6; margin-left: auto; }
.mrd-dsi-list {
  max-height: 320px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px;
  border: 1px solid #222736;
  border-radius: 10px;
  background: #151821;
}
.mrd-dsi-skeleton {
  height: 44px;
  border-radius: 8px;
  background: linear-gradient(90deg, #1a1e29 25%, #232838 50%, #1a1e29 75%);
  background-size: 200% 100%;
  animation: mrd-dsi-shimmer 1.2s infinite;
}
@keyframes mrd-dsi-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.mrd-dsi-session {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
}
.mrd-dsi-session:hover { background: rgba(108, 92, 231, 0.08); transform: translateX(2px); }
.mrd-dsi-session.selected {
  border-color: #6c5ce7;
  background: rgba(108, 92, 231, 0.12);
  box-shadow: 0 0 0 1px rgba(108, 92, 231, 0.45);
}
.mrd-dsi-session-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: #e8eaf0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.mrd-dsi-session.selected .mrd-dsi-session-title { color: #fff; }
.mrd-dsi-session-time { flex: none; font-size: 11px; color: #6b7488; }
.mrd-dsi-footer { display: flex; justify-content: flex-end; gap: 8px; }
.mrd-dsi-diag { margin-right: auto; }
.mrd-dsi-elapsed { font-size: 11px; color: #6b7488; }

.mrd-dsi-run { display: flex; flex-direction: column; gap: 10px; }
.mrd-dsi-toolbar-row { display: flex; align-items: center; gap: 10px; }
.mrd-dsi-toolbar-hint { flex: 1; min-width: 0; font-size: 11.5px; color: #6b7488; }
.mrd-dsi-toolbar-btns { display: flex; align-items: center; gap: 8px; }

.mrd-dsi-steps { display: flex; flex-direction: column; gap: 8px; }
.mrd-dsi-step {
  padding: 10px 12px;
  border: 1px solid #222736;
  border-radius: 10px;
  background: #151821;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.mrd-dsi-step.running {
  border-color: #6c5ce7;
  box-shadow: 0 0 0 1px rgba(108, 92, 231, 0.4), 0 0 14px rgba(108, 92, 231, 0.15);
}
.mrd-dsi-step-head { display: flex; align-items: center; gap: 10px; }
.mrd-dsi-step-idx {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11.5px;
  font-weight: 700;
  color: #a78bfa;
  background: rgba(167, 139, 250, 0.12);
  border: 1px solid rgba(167, 139, 250, 0.35);
}
.mrd-dsi-step-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.mrd-dsi-step-label { font-size: 13px; font-weight: 600; color: #edeff5; }
.mrd-dsi-step-hint { font-size: 11px; color: #6b7488; }
.mrd-dsi-step-badge {
  flex: none;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 11px;
  border: 1px solid #2a3042;
  color: #6b7488;
}
.mrd-dsi-step-badge.running { color: #a78bfa; border-color: rgba(167, 139, 250, 0.5); background: rgba(167, 139, 250, 0.1); }
.mrd-dsi-step-badge.done { color: #4ade80; border-color: rgba(74, 222, 128, 0.4); background: rgba(74, 222, 128, 0.08); }
.mrd-dsi-step-badge.synced { color: #4ade80; border-color: #4ade80; background: rgba(74, 222, 128, 0.14); }
.mrd-dsi-step-badge.error { color: #f87171; border-color: rgba(248, 113, 113, 0.4); background: rgba(248, 113, 113, 0.08); }
.mrd-dsi-step-summary {
  margin: 8px 0 0 32px;
  font-size: 11.5px;
  color: #9aa3b2;
  padding: 6px 10px;
  border-radius: 7px;
  background: rgba(108, 92, 231, 0.07);
}
.mrd-dsi-step-actions { display: flex; gap: 8px; margin: 8px 0 0 32px; }

.mrd-dsi-logbox {
  max-height: 200px;
  min-height: 110px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid #222736;
  border-radius: 10px;
  background: #10131b;
  font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
  font-size: 11.5px;
  line-height: 1.65;
}
.mrd-dsi-log { display: flex; gap: 8px; }
.mrd-dsi-log-time { flex: none; color: #4b5366; }
.mrd-dsi-log-msg { word-break: break-all; }
.lv-info .mrd-dsi-log-msg { color: #9aa3b2; }
.lv-success .mrd-dsi-log-msg { color: #4ade80; }
.lv-warn .mrd-dsi-log-msg { color: #facc15; }
.lv-error .mrd-dsi-log-msg { color: #f87171; }

.mrd-dsi-debug {
  border: 1px solid #222736;
  border-radius: 10px;
  background: #0d1017;
  font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
  font-size: 11px;
}
.mrd-dsi-debug > summary {
  cursor: pointer;
  padding: 6px 10px;
  color: #8b93a7;
  user-select: none;
}
.mrd-dsi-debug-body { max-height: 160px; overflow: auto; padding: 0 10px 8px; }
.mrd-dsi-debug-row { display: flex; gap: 8px; line-height: 1.55; }
.mrd-dsi-debug-time { flex: none; color: #4b5366; }
.mrd-dsi-debug-kind { flex: none; color: #7c89d6; }
.mrd-dsi-debug-detail { color: #9aa3b2; word-break: break-all; }

/* H3 失败决策对话框：提示词 / 回复原文展示 */
.mrd-dsi-h3fail-block { margin-top: 10px; }
.mrd-dsi-h3fail-label {
  font-size: 12px;
  color: #8b93a7;
  margin-bottom: 4px;
}
.mrd-dsi-h3fail-pre {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.08);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "JetBrains Mono", Consolas, "Courier New", monospace;
  font-size: 11px;
  line-height: 1.55;
}
</style>
