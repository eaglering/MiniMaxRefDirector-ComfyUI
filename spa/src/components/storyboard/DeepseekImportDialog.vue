<script setup>
// DeepSeek 分镜导入弹窗：两阶段
// 阶段一：选择 chat.deepseek.com 会话（列表 / 搜索 / 刷新）
// 阶段二：导入进度（步骤条 + H3 进度 + 滚动日志 + 取消）
// 完成后 emit("completed", result)，由 Storyboard.vue 写入分镜 / 主体 / 音频。
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import { deepseekAttempt, deepseekCancel, deepseekDiag, deepseekListSessions } from "../../utils/llm.js";
import { IMPORT_STEPS, createImportToken, runDeepseekImport } from "../../utils/deepseekImport.js";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "completed"]);

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
      `扩展版本：v${d.version || "未知"}${d.version && d.version < "1.3.4" ? "（过旧，请在 chrome://extensions 重新加载扩展）" : ""}`,
      `标签页：${d.tabUrl || "（未找到 chat.deepseek.com 标签页）"}`,
      `DeepSeek 标签页共 ${(d.tabs || []).length} 个：${
        (d.tabs || []).map((t) => `#${t.id}${t.active ? "（当前）" : t.discarded ? "（已丢弃）" : ""}${t.url}`).join("、") || "-"
      }${(d.tabs || []).length > 1 ? "——建议关掉多余标签页，只留一个，避免填错页" : ""}`,
      `content 脚本就绪：${d.contentReady ? "是" : "否"}`,
      `输入框：${p.inputFound ? `已找到（${p.inputKind || "?"}）` : "未找到"}`,
      `输入框候选：${
        (p.inputCandidates || [])
          .map((c) => `${c.tag}${c.id ? `#${c.id}` : ""}${c.placeholder ? `“${c.placeholder}”` : ""} ${c.size}（${c.score} 分）`)
          .join("；") || "无"
      }`,
      `发送按钮：${p.sendButtonFound ? `已找到${p.sendButtonLabel ? `（${p.sendButtonLabel}）` : ""}` : "未找到"}`,
      `回复区文本块：${p.assistantBlocks ?? 0} 个`,
      `回复流钩子：${p.hookInstalled ? "已注入" : "未注入"}` +
        `${p.sseActive ? "（最近一次流进行中）" : ""}${p.sseDone ? `（已捕获 ${p.sseChars} 字符）` : ""}`,
      `WS 桥接：${d.bridge && d.bridge.connected ? "已连接" : "未连接"}（${(d.bridge && d.bridge.url) || "-"}）`,
    ];
    if (d.lastAttempt) {
      lines.push("", `最近一次生成：${d.lastAttempt.promptChars} 字符 / ${d.lastAttempt.sessionMode}`);
      for (const s of d.lastAttempt.stages || []) {
        const t = new Date(s.at).toLocaleTimeString();
        lines.push(`· ${t} ${s.stage}${s.detail ? `（${s.detail}）` : ""}`);
      }
    }
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

// ---- 阶段二：导入进度 ----
const stepStatus = reactive({}); // key → running | done | warn | error
const logs = ref([]); // { level, time, msg }
const h3Done = ref(0);
const h3Total = ref(0);
const running = ref(false);
const runError = ref("");
const tokenRef = ref(null);
const logBoxRef = ref(null);

// 已用时：让「长时间等待」可见，避免误判卡死
const elapsed = ref(0);
let elapsedTimer = null;
// 当前阶段（轮询扩展的 ds/stage 流水）
const stageText = ref("");
let stageTimer = null;
const STAGE_LABELS = {
  queued: "已排队",
  tab_ready: "已连接 DeepSeek 标签页",
  go_home: "正在回到首页开新会话",
  navigating: "正在打开会话页面",
  nav_done: "会话页面已就绪",
  fill_start: "打开会话 / 定位页面",
  fill_sent: "已派发填充任务",
  input_ready: "已找到输入框",
  written: "已写入输入框",
  sent: "已发送，等待回复",
  stream_start: "回复生成中",
  stream_done: "回复生成完毕",
  replied: "已取回回复",
  reply_via_sse: "已取回回复（SSE 通道）",
  reply_via_dom: "已取回回复（DOM 兜底）",
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
  const extId = (ws.llm.extension_id || "").trim();
  clearInterval(stageTimer);
  stageTimer = setInterval(async () => {
    try {
      const d = await deepseekAttempt(extId);
      const stages = (d && d.lastAttempt && d.lastAttempt.stages) || [];
      const last = stages[stages.length - 1];
      if (last) stageText.value = STAGE_LABELS[last.stage] || last.stage;
      else if (d && d.version) stageText.value = `扩展 v${d.version}（暂无阶段上报）`;
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
  for (const k of Object.keys(stepStatus)) delete stepStatus[k];
  logs.value = [];
  h3Done.value = 0;
  h3Total.value = 0;
  runError.value = "";
}

function addLog(level, msg) {
  logs.value.push({ level, msg, time: new Date().toLocaleTimeString() });
  nextTick(() => {
    if (logBoxRef.value) logBoxRef.value.scrollTop = logBoxRef.value.scrollHeight;
  });
}

function stepElStatus(key) {
  const st = stepStatus[key];
  if (st === "running") return "process";
  if (st === "error") return "error";
  if (st === "done" || st === "warn") return "finish";
  return "wait";
}

function stepDesc(key) {
  const st = stepStatus[key];
  if (st === "running") return "进行中…";
  if (st === "warn") return "部分完成";
  if (st === "done") return "已完成";
  return "";
}

const h3Percent = computed(() =>
  h3Total.value ? Math.round((h3Done.value / h3Total.value) * 100) : 0
);

async function startImport() {
  if (!selectedId.value || running.value) return;
  phase.value = "run";
  running.value = true;
  runError.value = "";
  startElapsed();
  const token = createImportToken();
  tokenRef.value = token;

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

  try {
    const result = await runDeepseekImport({
      extensionId: extId.value,
      sessionId: selectedId.value,
      timelineDigest: digest,
      frameRate: fps,
      existingSubjects: ws.subjects.subjects || [],
      token,
      onStep: (key, status) => {
        stepStatus[key] = status;
      },
      onLog: addLog,
      onH3Progress: (d, t) => {
        h3Done.value = d;
        h3Total.value = t;
      },
    });
    addLog("success", "导入流水线完成，正在写入导演台…");
    emit("completed", result);
    ElMessage.success(`DeepSeek 分镜导入完成：${result.segments.length} 个分镜`);
    running.value = false;
    stopElapsed();
    emit("update:modelValue", false);
  } catch (e) {
    running.value = false;
    stopElapsed();
    runError.value = e.message || String(e);
    addLog("error", runError.value);
  }
}

async function cancelImport() {
  if (tokenRef.value) tokenRef.value.cancelled = true;
  addLog("warn", "已请求取消，正在中止当前请求…");
  try {
    const n = await deepseekCancel(extId.value);
    addLog("warn", `已向扩展发送取消（挂起请求 ${n} 个），页面侧等待也会立即停止`);
  } catch {
    // 旧版扩展无此消息类型：仍会在当前请求结束后由令牌中止
    addLog("warn", "扩展未响应取消指令（可能为旧版本），将在当前请求结束后中止");
  }
}

function close() {
  if (running.value) return;
  emit("update:modelValue", false);
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="phase === 'select' ? 'DeepSeek 分镜导入 · 选择会话' : 'DeepSeek 分镜导入 · 执行中'"
    :width="phase === 'select' ? 560 : 660"
    append-to-body
    :close-on-click-modal="phase === 'select' && !running"
    :show-close="!running"
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
        title="选择一个包含你创作构想的 DeepSeek 会话：导入将在该会话内提取故事大纲，完成后自动恢复会话原状，并在新会话中完成分镜 / 主体 / 音频 / 首帧 / H3 全套提取。"
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
        <el-button type="primary" :disabled="!selectedId || !isDeepseek" @click="startImport">
          开始导入
        </el-button>
      </div>
    </div>

    <!-- 阶段二：执行进度 -->
    <div v-else class="mrd-dsi-run">
      <div class="mrd-dsi-run-grid">
        <el-steps direction="vertical" :space="44" class="mrd-dsi-steps">
          <el-step
            v-for="st in IMPORT_STEPS"
            :key="st.key"
            :title="st.label"
            :status="stepElStatus(st.key)"
            :description="stepDesc(st.key)"
          />
        </el-steps>

        <div class="mrd-dsi-run-side">
          <div class="mrd-dsi-h3box">
            <div class="mrd-dsi-h3-label">H3 循环转换</div>
            <el-progress
              type="dashboard"
              :percentage="h3Percent"
              :width="108"
              :color="h3Percent >= 100 ? '#4ade80' : '#6c5ce7'"
            >
              <template #default>
                <span class="mrd-dsi-h3-count">{{ h3Done }}/{{ h3Total || "–" }}</span>
                <span class="mrd-dsi-h3-sub">分镜</span>
              </template>
            </el-progress>
          </div>
          <el-button v-if="running" type="danger" plain @click="cancelImport">取消导入</el-button>
          <el-button v-else type="primary" @click="close">关闭</el-button>
          <div class="mrd-dsi-elapsed">
            已用时 {{ elapsed }}s<span v-if="stageText"> · {{ stageText }}</span>
          </div>
        </div>
      </div>

      <div ref="logBoxRef" class="mrd-dsi-logbox">
        <div v-for="(l, i) in logs" :key="i" class="mrd-dsi-log" :class="`lv-${l.level}`">
          <span class="mrd-dsi-log-time">{{ l.time }}</span>
          <span class="mrd-dsi-log-msg">{{ l.msg }}</span>
        </div>
      </div>

      <el-alert
        v-if="runError"
        type="error"
        :closable="false"
        show-icon
        :title="runError"
        class="mrd-dsi-alert"
      />
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

.mrd-dsi-run { display: flex; flex-direction: column; gap: 12px; }
.mrd-dsi-run-grid { display: flex; gap: 18px; align-items: stretch; }
.mrd-dsi-steps { flex: 1; min-width: 0; }
.mrd-dsi-steps :deep(.el-step__title) { font-size: 13px; color: #a9b1c3; }
.mrd-dsi-steps :deep(.el-step__title.is-process) { color: #edeff5; font-weight: 600; }
.mrd-dsi-steps :deep(.el-step__title.is-finish) { color: #c3c9d9; }
.mrd-dsi-steps :deep(.el-step__description) { font-size: 11px; }
.mrd-dsi-steps :deep(.el-step__head.is-finish .el-step__icon) {
  animation: mrd-dsi-pop 0.28s ease;
}
@keyframes mrd-dsi-pop {
  0% { transform: scale(0.7); }
  60% { transform: scale(1.12); }
  100% { transform: scale(1); }
}
.mrd-dsi-run-side {
  flex: none;
  width: 170px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}
.mrd-dsi-h3box { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.mrd-dsi-h3-label { font-size: 12px; color: #a9b1c3; }
.mrd-dsi-h3-count { font-size: 16px; font-weight: 700; color: #edeff5; }
.mrd-dsi-h3-sub { font-size: 10.5px; color: #6b7488; margin-left: 4px; }
.mrd-dsi-logbox {
  max-height: 220px;
  min-height: 120px;
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
</style>
