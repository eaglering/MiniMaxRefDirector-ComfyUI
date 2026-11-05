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

function addShot() {
  const seg = defaultSegment();
  segments.value.push(seg);
  selectedId.value = seg.id;
  ws.markDirty();
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
}

function relayout() {
  let cursor = 0;
  for (const seg of segments.value) {
    seg.start = cursor;
    cursor += seg.length;
  }
}

const totalSeconds = computed(() =>
  framesToSeconds(
    segments.value.reduce((a, s) => a + (s.length || 0), 0),
    ws.widgets.frame_rate
  )
);

// ---- DeepSeek 分镜导入结果写入 ----
function emptyH3() {
  return { summary: "", detailed_description: "", overall_soundscape: "", non_diegetic_music: "" };
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

function onDeepseekImported(result) {
  const fps = ws.widgets.frame_rate || 24;
  let added = 0;
  let firstNewId = "";

  for (const shot of result.segments || []) {
    const seg = defaultSegment();
    seg.length = secondsToFrames(
      Number(shot.duration_seconds) > 0 ? Number(shot.duration_seconds) : 5,
      fps
    );
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
    segments.value.push(seg);
    if (!firstNewId) firstNewId = seg.id;
    added++;
  }

  let subjectsAdded = 0;
  for (const c of result.characters || []) if (upsertSubject(c, "Subject")) subjectsAdded++;
  for (const sc of result.scenes || []) if (upsertSubject(sc, "Picture")) subjectsAdded++;
  for (const a of result.audios || []) if (upsertSubject(a, "Audio")) subjectsAdded++;

  relayout();
  if (firstNewId) selectedId.value = firstNewId;
  ws.markDirty();
  ws.saveNow();
  if (subjectsAdded) {
    ElMessage.info(`已写入 ${added} 个分镜与 ${subjectsAdded} 个主体条目（主体管理页查看）`);
  }
}
</script>

<template>
  <el-splitter class="mrd-storyboard" @resize-end="mainSplit.onResizeEnd">
    <!-- 分镜列表 -->
    <el-splitter-panel :size="mainSplit.sizes[0]" min="180px" collapsible>
      <ShotList
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
        @deepseek-import="showDeepseekImport = true"
      />
    </el-splitter-panel>

    <!-- 中间：提示词区 / 额外主体 / 状态行 -->
    <el-splitter-panel :size="mainSplit.sizes[1]" min="640px" collapsible>
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
    <el-splitter-panel v-if="!isNarrow" :size="mainSplit.sizes[2]" min="180px" collapsible>
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
  <DeepseekImportDialog v-model="showDeepseekImport" @completed="onDeepseekImported" />
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
