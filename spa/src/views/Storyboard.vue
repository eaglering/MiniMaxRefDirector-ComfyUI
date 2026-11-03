<script setup>
// 导演台分镜页：三栏布局
// 左 ShotList / 中 PromptPanel + ExtraSubjects / 右 el-tabs（参数 / 预览）
import { computed, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspace } from "../stores/workspace.js";
import { genId, framesToSeconds } from "../utils/media.js";
import ShotList from "../components/storyboard/ShotList.vue";
import PromptPanel from "../components/storyboard/PromptPanel.vue";
import ExtraSubjects from "../components/storyboard/ExtraSubjects.vue";
import ShotParams from "../components/storyboard/ShotParams.vue";
import ShotPreview from "../components/storyboard/ShotPreview.vue";

const ws = useWorkspace();
const selectedId = ref("");
const rightTab = ref("params");
const rightDrawer = ref(false);

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
</script>

<template>
  <div class="mrd-storyboard">
    <ShotList
      :segments="segments"
      :selected-id="selected ? selected.id : ''"
      :display-mode="ws.widgets.display_mode"
      :frame-rate="ws.widgets.frame_rate"
      @select="id => (selectedId = id)"
      @change="ws.markDirty()"
      @add="addShot"
      @duplicate="duplicateShot"
      @remove="removeShot"
    />

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

    <!-- 右侧 Tabs：≥1100px 常驻；窄屏走抽屉 -->
    <div class="mrd-storyboard-right">
      <el-tabs v-model="rightTab" class="mrd-right-tabs">
        <el-tab-pane label="分镜参数" name="params">
          <ShotParams v-if="selected" :key="`sp-${selected.id}`" :segment="selected" :segments="segments" />
        </el-tab-pane>
        <el-tab-pane label="分镜预览" name="preview" lazy>
          <ShotPreview v-if="selected" :key="`sv-${selected.id}`" :segment="selected" :segments="segments" />
        </el-tab-pane>
      </el-tabs>
    </div>

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
  </div>
</template>

<style scoped>
.mrd-storyboard {
  height: 100%;
  display: flex;
  gap: 14px;
  min-height: 0;
}
.mrd-storyboard-center {
  flex: 1;
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
}
.mrd-open-right { display: none; }
.mrd-storyboard-right {
  width: 360px;
  flex: none;
  background: #151821;
  border: 1px solid #222736;
  border-radius: 10px;
  padding: 10px 14px 14px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.mrd-right-tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.mrd-right-tabs :deep(.el-tabs__content) { flex: 1; min-height: 0; overflow: auto; }

@media (max-width: 1100px) {
  .mrd-storyboard-right { display: none; }
  .mrd-open-right { display: inline-flex; margin-left: auto; }
}
@media (min-width: 1100px) and (max-width: 1440px) {
  .mrd-storyboard-right { width: 320px; }
}
</style>
