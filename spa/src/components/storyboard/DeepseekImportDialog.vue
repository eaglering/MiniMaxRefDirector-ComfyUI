<script setup>
// DeepSeek 分镜导入弹窗：两阶段（手动逐步模式，无一键全自动）
// 阶段一：选择 chat.deepseek.com 会话（列表 / 搜索 / 刷新）
// 阶段二：步骤卡片（故事大纲 → 分镜设计 → 主体设计 → 首帧图 → 音频设计），
//   每步独立「执行」（在 DeepSeek 会话生成，仅缓存）与「同步」（写入导演台）。
//   H3 转换不属于导入流程；由用户在分镜属性里按需点「转H3提示词」。
// 同步后 emit("sync", payload)，由 Storyboard.vue 分类型写入分镜 / 主体 / 音频。
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import { deepseekAttempt, deepseekCancel, deepseekDiag, deepseekListSessions } from "../../utils/llm.js";
import {
  IMPORT_STEPS,
  buildSyncPayload,
  cleanupImportSessions,
  createImportState,
  createImportToken,
  runAudioStep,
  runFirstframeStep,
  runOutlineStep,
  runStoryboardStep,
  runSubjectsStep,
} from "../../utils/deepseekImport.js";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "sync"]);

const ws = useWorkspace();
const extId = computed(() => (ws.llm.extension_id || "").trim());
const isDeepseek = computed(() => ws.llm.mode === "deepseek-proxy");

// ---- 阶段一：会话选择 ----
const phase = ref("select"); // select | run
const sessions = ref([]);
const loading = ref(false);
const loadError = ref("");
const keyword = ref("");
const selectedId = ref("");

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return sessions.value;
  return sessions.value.filter((s) => (s.title || "").toLowerCase().includes(k));
});

async function loadSessions() {
  if (!extId.value) {
    loadError.value = "未配置 DeepSeek 桥接扩展 ID：请到「全局参数 → LLM 设置」填写";
    return;
  }
  loading.value = true;
  loadError.value = "";
  try {
    sessions.value = await deepseekListSessions(extId.value);
  } catch (e) {
    loadError.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

// 页面自检：确认 DeepSeek 标签页里输入框/发送按钮是否可定位（DOM 改版排查）
const diagLoading = ref(false);
async function runDiag() {
  if (!extId.value) {
    ElMessage.warning("请先填写 DeepSeek 桥接扩展 ID（全局参数 → LLM 设置）");
    return;
  }
  diagLoading.value = true;
  try {
    const d = await deepseekDiag(extId.value);
    const p = d.probe || {};
    const lines = [
      `扩展版本：v${d.version || "未知"}${d.version && d.version < "1.4.7" ? "（过旧，请在 chrome://extensions 重新加载扩展）" : ""}`,
      `标签页：${d.tabUrl || "（未找到 chat.deepseek.com 标签页）"}`,
      `DeepSeek 标签页共 ${(d.tabs || []).length} 个`,
      `content 脚本就绪：${d.contentReady ? "是" : "否"}`,
      `页面可见性：${p.visibility || "?"}${p.wasDiscarded ? "（曾被内存节省丢弃）" : ""}`,
      `输入框：${p.inputFound ? `已找到（${p.inputKind || "?"}）` : "未找到"}`,
      `发送按钮：${p.sendButtonFound ? "已找到" : "未找到"}`,
      `回复区文本块：${p.assistantBlocks ?? 0} 个`,
      `回复流钩子：${p.hookInstalled ? "已注入" : "未注入"}`,
      `WS 桥接：${d.bridge && d.bridge.connected ? "已连接" : "未连接"}`,
    ];
    await ElMessageBox.alert(lines.join("<br/>"), "DeepSeek 页面自检", {
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
};

function canRun(key) {
  const st = (k) => stepState[k]?.status;
  if (runningStep.value) return false;
  if (key === "storyboard" || key === "subjects" || key === "audio") return st("outline") === "done";
  if (key === "firstframe") return st("storyboard") === "done";
  return true;
}
function canSync(key) {
  if (runningStep.value) return false;
  const s = stepState[key];
  if (!s || (s.status !== "done" && s.status !== "warn")) return false;
  if (key === "outline") return false; // 大纲仅缓存，作为后续步骤输入
  if (key === "firstframe") return storyboardSynced.value;
  return true;
}
function runHint(key) {
  const st = (k) => stepState[k]?.status;
  if (runningStep.value) return "有步骤执行中";
  if ((key === "storyboard" || key === "subjects" || key === "audio") && st("outline") !== "done")
    return "请先执行「故事大纲」";
  if (key === "firstframe") {
    if (st("storyboard") !== "done") return "请先执行「分镜设计」";
    if (!storyboardSynced.value) return "请先同步分镜，再同步首帧提示词";
  }
  if (key === "outline") return "大纲仅缓存，作为后续步骤输入，无需同步";
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
  tab_ready: "已连接 DeepSeek 标签页",
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
      const d = await deepseekAttempt(extId.value);
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
}

function hhmmss(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function copyDebug() {
  let diag = null;
  try {
    diag = await deepseekDiag(extId.value);
  } catch (e) {
    diag = { error: String(e.message || e) };
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    steps: JSON.parse(JSON.stringify(stepState)),
    spaLogs: logs.value.map((l) => `${l.time} [${l.level}] ${l.msg}`),
    backgroundEvents: (debugTail.value || []).map((e) => `${hhmmss(e.at)} ${e.kind} ${e.detail}`),
    diag,
  };
  const text = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("调试日志已复制到剪贴板，直接粘贴发我即可");
  } catch {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `deepseek-import-debug-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    ElMessage.success("调试日志已下载为 JSON 文件");
  }
}

function addLog(level, msg) {
  logs.value.push({ level, msg, time: new Date().toLocaleTimeString() });
  nextTick(() => {
    if (logBoxRef.value) logBoxRef.value.scrollTop = logBoxRef.value.scrollHeight;
  });
}

function summarize(key, result) {
  if (key === "outline") {
    const o = result || {};
    return `${o.title || "(未命名)"} · 主体 ${(o.subjects || []).length} · 场景 ${(o.scenes || []).length}`;
  }
  if (key === "storyboard") return `${(result || []).length} 个镜头（未同步）`;
  if (key === "subjects") return `${(result || []).length} 个主体`;
  if (key === "firstframe") return `更新 ${(result || []).length} 个镜头的帧提示词`;
  if (key === "audio") return `${(result || []).length} 条音频`;
  return "";
}

async function runStep(step) {
  const key = step.key;
  if (!canRun(key) || !selectedId.value) return;
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
      extensionId: extId.value,
      sessionId: selectedId.value,
      timelineDigest: digest,
      frameRate: fps,
      existingSubjects: ws.subjects.subjects || [],
    });
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
    const result = await STEP_RUNNERS[key](state, { token, onLog: addLog });
    st.status = "done";
    st.synced = false;
    st.summary = summarize(key, result);
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

async function syncStep(step) {
  const key = step.key;
  if (!canSync(key) || !stateRef.value) return;
  if (key === "storyboard" && storyboardSynced.value) {
    try {
      await ElMessageBox.confirm(
        "分镜已同步过一次。再次同步将把本次缓存的全部分镜作为新分镜追加到时间线（可能产生重复镜头）。继续？",
        "重复同步确认",
        { type: "warning", confirmButtonText: "继续追加", cancelButtonText: "取消" }
      );
    } catch {
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
  addLog("success", `「${step.label}」已同步到导演台`);
}

async function cleanupSessions() {
  if (!stateRef.value || !stateRef.value.createdSessions.length) {
    ElMessage.info("本次导入尚未新建 DeepSeek 会话（大纲复用你选定的会话）");
    return;
  }
  try {
    await ElMessageBox.confirm(
      `删除本次导入新建的 ${stateRef.value.createdSessions.length} 个 DeepSeek 会话？删除后不可恢复。`,
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
    const n = await deepseekCancel(extId.value);
    addLog("warn", `已向扩展发送取消（挂起请求 ${n} 个），页面侧等待也会立即停止`);
  } catch {
    addLog("warn", "扩展未响应取消指令（可能为旧版本），将在当前请求结束后中止");
  }
}

function close() {
  if (runningStep.value) return;
  emit("update:modelValue", false);
}

function stepBadge(st) {
  if (st.status === "running") return { text: "执行中", cls: "running" };
  if (st.status === "error") return { text: "失败", cls: "error" };
  if (st.status === "done" && st.synced) return { text: "已同步", cls: "synced" };
  if (st.status === "done" || st.status === "warn") return { text: "已完成", cls: "done" };
  return { text: "未执行", cls: "idle" };
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="phase === 'select' ? 'DeepSeek 分镜导入 · 选择会话' : 'DeepSeek 分镜导入 · 逐步执行'"
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
        v-if="!isDeepseek"
        type="warning"
        :closable="false"
        show-icon
        title="当前 LLM 模式不是 DeepSeek 代理：请在「全局参数 → LLM 设置」切换后再导入"
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
        title="选择一个包含你创作构想的 DeepSeek 会话：导入将在该会话内提取故事大纲（该会话会新增 2 条消息），随后每个步骤由你手动「执行 / 同步」逐步确认。建议控制导入频率，避免短时间高频自动化操作。"
      />

      <div class="mrd-dsi-list">
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
        <el-empty v-else description="没有匹配的会话" :image-size="72" />
      </div>

      <div class="mrd-dsi-footer">
        <el-button class="mrd-dsi-diag" :loading="diagLoading" @click="runDiag">页面自检</el-button>
        <el-button @click="close">取消</el-button>
        <el-button type="primary" :disabled="!selectedId || !isDeepseek" @click="phase = 'run'">
          下一步：逐步导入
        </el-button>
      </div>
    </div>

    <!-- 阶段二：步骤卡片（执行 / 同步） -->
    <div v-else class="mrd-dsi-run">
      <div class="mrd-dsi-toolbar-row">
        <span class="mrd-dsi-toolbar-hint">每步先「执行」在 DeepSeek 生成，确认后再「同步」写入导演台</span>
        <div class="mrd-dsi-toolbar-btns">
          <el-button size="small" :icon="'Delete'" :disabled="!!runningStep" @click="cleanupSessions">清理会话</el-button>
          <el-button v-if="runningStep" size="small" type="danger" plain @click="cancelStep">取消执行</el-button>
          <el-button v-else size="small" @click="phase = 'select'">返回选会话</el-button>
          <el-button link type="info" size="small" @click="copyDebug">复制调试日志</el-button>
        </div>
      </div>

      <div class="mrd-dsi-steps">
        <div v-for="(st, idx) in IMPORT_STEPS" :key="st.key" class="mrd-dsi-step" :class="{ running: runningStep === st.key }">
          <div class="mrd-dsi-step-head">
            <span class="mrd-dsi-step-idx">{{ idx + 1 }}</span>
            <div class="mrd-dsi-step-titles">
              <span class="mrd-dsi-step-label">{{ st.label }}</span>
              <span class="mrd-dsi-step-hint">{{ st.hint }}</span>
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
              :disabled="!canRun(st.key)"
              :title="runHint(st.key)"
              @click="runStep(st)"
            >
              {{ stepState[st.key]?.status === "running" ? "执行中…" : "执行" }}
            </el-button>
            <el-button
              size="small"
              type="success"
              plain
              :disabled="!canSync(st.key)"
              @click="syncStep(st)"
            >
              同步
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
    </div>
  </el-dialog>
</template>

<style scoped>
.mrd-dsi-select { display: flex; flex-direction: column; gap: 12px; }
.mrd-dsi-toolbar { display: flex; gap: 8px; }
.mrd-dsi-search { flex: 1; }
.mrd-dsi-alert { border-radius: 8px; }
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
</style>
