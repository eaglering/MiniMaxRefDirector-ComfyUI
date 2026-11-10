<script setup>
// 导演台分镜页：el-splitter 三栏可拖拽/折叠分栏（分镜 | 提示词区 | 参数+预览）。
// 镜头技能 / 用户提示词 / H3 提示词 在 PromptPanel 内部亦为可折叠拖拽分栏；
// 分镜参数 / 分镜预览 为右侧纵向分栏，窄屏（<1100px）收起走抽屉。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspace } from "../stores/workspace.js";
import { useSplitterMemory } from "../utils/splitter.js";
import { genId, framesToSeconds, secondsToFrames } from "../utils/media.js";
import { makeSubject } from "../constants/subject.js";
import ShotList from "../components/storyboard/ShotList.vue";
import PromptPanel from "../components/storyboard/PromptPanel.vue";
import ExtraSubjects from "../components/storyboard/ExtraSubjects.vue";
import ShotParams from "../components/storyboard/ShotParams.vue";
import ShotPreview from "../components/storyboard/ShotPreview.vue";
import DeepseekImportDialog from "../components/storyboard/DeepseekImportDialog.vue";

const ws = useWorkspace();
const selectedId = ref("");
const rightTab = ref("params");
const rightDrawer = ref(false);
const showDeepseekImport = ref(false);

// 窄屏（<1100px）隐藏右侧分栏，改用抽屉
const isNarrow = ref(window.matchMedia("(max-width: 1100px)").matches);
let mqHandler = null;
onMounted(() => {
  const mq = window.matchMedia("(max-width: 1100px)");
  mqHandler = (e) => (isNarrow.value = e.matches);
  mq.addEventListener("change", mqHandler);
});
onBeforeUnmount(() => {
  const mq = window.matchMedia("(max-width: 1100px)");
  if (mqHandler) mq.removeEventListener("change", mqHandler);
});

// 分栏尺寸记忆（拖拽后写 localStorage，重进页面恢复；size/min/max 数值均为百分比）
const mainSplit = useSplitterMemory("mrd-sb-split-main", [15, 70, 15]);
const rightSplit = useSplitterMemory("mrd-sb-split-right", [55, 45]);

const isDeepseek = computed(() => ws.llm.mode === "deepseek-proxy");

const segments = computed(() => ws.timeline.segments);

const selected = computed(() =>
  segments.value.find((s) => s.id === selectedId.value) || segments.value[0]
);

function ensureSelection() {
  if (!selected.value) {
    selectedId.value = "";
    return;
  }
  if (selected.value.id !== selectedId.value) {
    selectedId.value = selected.value.id;
  }
}
ensureSelection();

function defaultSegment() {
  const last = segments.value[segments.value.length - 1];
  const start = last ? last.start + last.length : 0;
  return {
    id: genId(),
    start,
    length: 120,
    prompt: "",
    type: "text",
    autoEndFrame: true,
    h3PromptJson: { summary: "", detailed_description: "", overall_soundscape: "", non_diegetic_music: "" },
    cameraMotions: [],
    expressions: [],
    shotSizes: [],
    framings: [],
    retention: {},
    additionSubject: [],
    imageFile: "",
    videoFile: "",
    lastFrameFile: "",
  };
}

const shotListRef = ref(null);

function addShot() {
  const seg = defaultSegment();
  segments.value.push(seg);
  selectedId.value = seg.id;
  ws.markDirty();
  shotListRef.value?.refreshGlobalRange();
}

async function duplicateShot(id) {
  const src = segments.value.find((s) => s.id === id);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = genId();
  const idx = segments.value.indexOf(src);
  segments.value.splice(idx + 1, 0, copy);
  relayout();
  selectedId.value = copy.id;
  ws.markDirty();
  shotListRef.value?.refreshGlobalRange();
  ElMessage.success("已复制分镜");
}

async function removeShot(id) {
  if (segments.value.length <= 1) {
    ElMessage.warning("至少保留一个分镜");
    return;
  }
  const seg = segments.value.find((s) => s.id === id);
  if (!seg) return;
  try {
    await ElMessageBox.confirm(
      `确定删除分镜「${(seg.prompt || seg.h3PromptJson?.summary || "").slice(0, 30) || "空分镜"}」？`,
      "删除分镜",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return;
  }
  const idx = segments.value.findIndex((s) => s.id === id);
  segments.value.splice(idx, 1);
  relayout();
  if (selectedId.value === id) {
    selectedId.value = segments.value[Math.min(idx, segments.value.length - 1)]?.id || "";
  }
  ws.markDirty();
  shotListRef.value?.refreshGlobalRange();
}

function relayout() {
  let cursor = 0;
  for (const seg of segments.value) {
    seg.start = cursor;
    cursor += seg.length;
  }
}

// ---- 多选联动：全局参数 / 批量删除 ----
// 跨度计算（含未选中间隙）：Start=最早选中分镜开始；End=最晚选中分镜结束
// 全局范围更新提示节流（Ctrl 选择/增删分镜可能连续触发，避免消息刷屏）
let lastRangeToastAt = 0;
function notifyRangeUpdated(prefix, s, e) {
  const now = Date.now();
  if (now - lastRangeToastAt < 800) return;
  lastRangeToastAt = now;
  ElMessage.success(`${prefix}: Start ${s}s / End ${e}s / 时长 ${Math.round((e - s) * 100) / 100}s`);
}
// 时间范围写回：秒/帧双单位同步（节点端 start_frame/end_frame/duration_frames
// 在 display_mode=frames 时是权威输入，必须一并更新）
function syncRangeWidgets(startFrame, endFrame) {
  const fps = ws.widgets.frame_rate || 24;
  const sf = Math.round(startFrame);
  const ef = Math.max(sf + 1, Math.round(endFrame));
  const s = framesToSeconds(sf, fps);
  const e = framesToSeconds(ef, fps);
  ws.widgets.start_second = s;
  ws.widgets.end_second = e;
  ws.widgets.duration_seconds = Math.max(0, Math.round((e - s) * 100) / 100);
  ws.widgets.start_frame = sf;
  ws.widgets.end_frame = ef;
  ws.widgets.duration_frames = Math.max(1, ef - sf);
  ws.markDirty();
  return { s, e };
}
function applySpanRange({ startFrame, endFrame }) {
  const { s, e } = syncRangeWidgets(startFrame, endFrame);
  notifyRangeUpdated("已按选中分镜更新全局", s, e);
}
// 全不选：使用单个选中分镜的 Start/End
function applySegmentRange(id) {
  const seg = segments.value.find((s) => s.id === id);
  if (!seg) return;
  const { s, e } = syncRangeWidgets(seg.start || 0, (seg.start || 0) + (seg.length || 0));
  notifyRangeUpdated("已按当前分镜更新全局", s, e);
}
async function removeMany(ids) {
  const set = new Set(ids || []);
  if (!set.size) return;
  if (set.size >= segments.value.length) {
    ElMessage.warning("至少保留一个分镜");
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${set.size} 个分镜？`,
      "批量删除分镜",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return;
  }
  for (let i = segments.value.length - 1; i >= 0; i--) {
    if (set.has(segments.value[i].id)) segments.value.splice(i, 1);
  }
  relayout();
  if (set.has(selectedId.value)) {
    selectedId.value = segments.value[0]?.id || "";
  }
  ws.markDirty();
  shotListRef.value?.refreshGlobalRange();
  ElMessage.success(`已删除 ${set.size} 个分镜`);
}

const totalSeconds = computed(() =>
  framesToSeconds(
    segments.value.reduce((a, s) => a + (s.length || 0), 0),
    ws.widgets.frame_rate
  )
);

// ---- DeepSeek 分镜导入结果写入（手动逐步「同步」）----
function emptyH3() {
  return { summary: "", detailed_description: "", overall_soundscape: "", non_diegetic_music: "" };
}

// 单个分镜 shot → segment 的公共字段映射（storyboard 同步与首次新增共用）
function applyShotToSegment(seg, shot) {
  seg.prompt = String(shot.prompt || "");
  if (Array.isArray(shot.camera_motions)) seg.cameraMotions = shot.camera_motions.filter(Boolean);
  if (Array.isArray(shot.shot_sizes)) seg.shotSizes = shot.shot_sizes.filter(Boolean);
  if (Array.isArray(shot.framings)) seg.framings = shot.framings.filter(Boolean);
  if (Array.isArray(shot.expressions)) seg.expressions = shot.expressions.filter(Boolean);
  // 首/尾帧提示词：自定义字段（parseInitial 保留未知字段，供后续首尾帧图生成使用）
  if (shot.first_frame_prompt) seg.firstFramePrompt = String(shot.first_frame_prompt);
  if (shot.last_frame_prompt) seg.lastFramePrompt = String(shot.last_frame_prompt);
  // 跨镜头衔接引导强度（分镜参数 guideStrength，缺省 22）
  if (typeof shot.guide_strength === "number") seg.guideStrength = shot.guide_strength;
  if (shot.h3) {
    seg.h3PromptJson = {
      summary: String(shot.h3.summary || ""),
      detailed_description: String(shot.h3.detailed_description || ""),
      overall_soundscape: String(shot.h3.overall_soundscape || ""),
      non_diegetic_music: String(shot.h3.non_diegetic_music || ""),
    };
  } else {
    seg.h3PromptJson = emptyH3();
  }
}

// 主体同名更新、否则新增（与 skills 的「同名会被更新覆盖」约定一致）
function upsertSubject(entry, type) {
  const name = String(entry.name || "").trim();
  if (!name) return false;
  const list = ws.subjects.subjects;
  let target = list.find(
    (s) => !s.ownerUid && s.type === type && String(s.name || "").trim() === name
  );
  if (!target) {
    target = makeSubject(type);
    list.push(target);
  }
  target.name = name;
  if (entry.description) target.description = String(entry.description);
  if (entry.retention) target.retention = String(entry.retention);
  if (entry.relationship) target.relationship = String(entry.relationship);
  if (entry.audioRef) target.audioRef = String(entry.audioRef);
  return true;
}

function afterSyncWrites(firstNewId) {
  relayout();
  if (firstNewId) selectedId.value = firstNewId;
  ws.markDirty();
  shotListRef.value?.refreshGlobalRange();
  ws.saveNow();
}

// DeepseekImportDialog 的分类型同步载荷：
//   { type: "storyboard", segments }   追加新分镜
//   { type: "subjects", characters, scenes }
//   { type: "firstframe", frames }     按 index 回写已有分镜的帧提示词
//   { type: "audio", audios }
function onDeepseekSync(payload) {
  const type = payload && payload.type;
  if (type === "storyboard") {
    const fps = ws.widgets.frame_rate || 24;
    let added = 0;
    let firstNewId = "";
    for (const shot of payload.segments || []) {
      const seg = defaultSegment();
      seg.length = secondsToFrames(
        Number(shot.duration_seconds) > 0 ? Number(shot.duration_seconds) : 5,
        fps
      );
      applyShotToSegment(seg, shot);
      segments.value.push(seg);
      if (!firstNewId) firstNewId = seg.id;
      added++;
    }
    afterSyncWrites(firstNewId);
    if (added) ElMessage.success(`已同步 ${added} 个分镜`);
  } else if (type === "subjects") {
    let added = 0;
    for (const c of payload.characters || []) if (upsertSubject(c, "Subject")) added++;
    for (const sc of payload.scenes || []) if (upsertSubject(sc, "Picture")) added++;
    afterSyncWrites("");
    if (added) ElMessage.success(`已同步 ${added} 个主体条目（主体管理页查看）`);
    else ElMessage.info("本次没有产生新的主体条目");
  } else if (type === "firstframe") {
    let updated = 0;
    for (const f of payload.frames || []) {
      const seg = segments.value[f.index - 1];
      if (!seg) continue;
      if (f.first_frame_prompt) seg.firstFramePrompt = String(f.first_frame_prompt);
      if (f.last_frame_prompt) seg.lastFramePrompt = String(f.last_frame_prompt);
      updated++;
    }
    ws.markDirty();
    ws.saveNow();
    if (updated) ElMessage.success(`已回写 ${updated} 个分镜的首/尾帧提示词`);
    else ElMessage.info("没有可回写的分镜（请先同步分镜）");
  } else if (type === "audio") {
    let added = 0;
    for (const a of payload.audios || []) if (upsertSubject(a, "Audio")) added++;
    afterSyncWrites("");
    if (added) ElMessage.success(`已同步 ${added} 条音频条目`);
    else ElMessage.info("本次没有产生新的音频条目");
  }
}
</script>

<template>
  <el-splitter class="mrd-storyboard" @resize-end="mainSplit.onResizeEnd">
    <!-- 分镜列表 -->
    <el-splitter-panel v-model:size="mainSplit.sizes[0]" :min="240" collapsible>
      <ShotList
        ref="shotListRef"
        :segments="segments"
        :selected-id="selected ? selected.id : ''"
        :display-mode="ws.widgets.display_mode"
        :frame-rate="ws.widgets.frame_rate"
        :show-deepseek-import="isDeepseek"
        @select="id => (selectedId = id)"
        @change="ws.markDirty()"
        @add="addShot"
        @duplicate="duplicateShot"
        @remove="removeShot"
        @apply-span="applySpanRange"
        @apply-segment="applySegmentRange"
        @remove-many="removeMany"
        @deepseek-import="showDeepseekImport = true"
      />
    </el-splitter-panel>

    <!-- 中间：提示词区 / 额外主体 / 状态行 -->
    <el-splitter-panel v-model:size="mainSplit.sizes[1]" :min="640" collapsible>
      <div class="mrd-storyboard-center">
        <template v-if="selected">
          <PromptPanel :key="`p-${selected.id}`" :segment="selected" />
          <ExtraSubjects :key="`e-${selected.id}`" :segment="selected" />
          <div class="mrd-storyboard-meta">
            分镜 {{ segments.indexOf(selected) + 1 }}/{{ segments.length }} · 总时长约 {{ totalSeconds }}s · 保存后自动写回节点
            <el-button size="small" text type="primary" class="mrd-open-right" @click="rightDrawer = true">
              <el-icon><component :is="'Setting'" /></el-icon> 参数/预览
            </el-button>
          </div>
        </template>
        <el-empty v-else description="添加第一个分镜开始创作" />
      </div>
    </el-splitter-panel>

    <!-- 右侧：分镜参数 / 分镜预览（纵向分栏，可折叠拖拽；窄屏走抽屉） -->
    <el-splitter-panel v-if="!isNarrow" v-model:size="mainSplit.sizes[2]" :min="280" collapsible>
      <div class="mrd-storyboard-right">
        <el-tabs v-model="rightTab" type="border-card" class="mrd-right-tabs">
          <el-tab-pane label="分镜参数" name="params">
            <ShotParams v-if="selected" :key="`sp-${selected.id}`" :segment="selected" :segments="segments" />
          </el-tab-pane>
          <el-tab-pane label="分镜预览" name="preview" lazy>
            <ShotPreview v-if="selected" :key="`sv-${selected.id}`" :segment="selected" :segments="segments" />
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-splitter-panel>
  </el-splitter>

  <!-- 窄屏抽屉：分镜参数 / 预览 -->
  <el-drawer v-model="rightDrawer" title="分镜参数 / 预览" size="420px" append-to-body>
    <el-tabs v-model="rightTab">
      <el-tab-pane label="分镜参数" name="params">
        <ShotParams v-if="selected" :segment="selected" :segments="segments" />
      </el-tab-pane>
      <el-tab-pane label="分镜预览" name="preview" lazy>
        <ShotPreview v-if="selected" :segment="selected" :segments="segments" />
      </el-tab-pane>
    </el-tabs>
  </el-drawer>

  <!-- DeepSeek 分镜导入（仅 deepseek-proxy 模式可见入口） -->
  <DeepseekImportDialog v-model="showDeepseekImport" @sync="onDeepseekSync" />
</template>

<style scoped>
.mrd-storyboard {
  height: 100%;
  min-height: 0;
}
/* 分隔条暗色化：拖拽线 + 折叠箭头（主分栏与右侧纵向分栏共用） */
.mrd-storyboard :deep(.el-splitter-bar__dragger:before) { background-color: #2a3042; }
.mrd-storyboard :deep(.el-splitter-bar__dragger:hover:not(.is-disabled):before),
.mrd-storyboard :deep(.el-splitter-bar__dragger-active:before) { background-color: #6c5ce7; }
.mrd-storyboard :deep(.el-splitter-bar__collapse-icon) {
  background: #2a3042;
  color: #a9b1c3;
}
.mrd-storyboard :deep(.el-splitter-bar__collapse-icon:hover) { background-color: #6c5ce7; }

.mrd-storyboard-center {
  height: 100%;
  box-sizing: border-box;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.mrd-storyboard-meta {
  flex: none;
  font-size: 11.5px;
  color: #55607a;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
}
.mrd-open-right { display: none; }
.mrd-storyboard-right {
  height: 100%;
  background: #151821;
  min-height: 0;
}
.mrd-storyboard-right :deep(.el-tabs) { background-color: #151821; border: none; }
.mrd-storyboard-right :deep(.el-tabs__header) { background-color: #272a33; border-bottom: solid 1px #2a3042; }
.mrd-storyboard-right :deep(.el-tabs__item.is-active) { background-color: #151821; border-right-color: #2a3042; border-left-color: #2a3042; margin-left: 0; }
.mrd-right-pane {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.mrd-right-pane-title {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: #a9b1c3;
  padding: 2px 2px 6px;
}
.mrd-right-pane-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

@media (max-width: 1100px) {
  .mrd-open-right { display: inline-flex; margin-left: auto; }
}
</style>
