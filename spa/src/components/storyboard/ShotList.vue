<script setup>
// 左侧分镜列表：新增 / 时长编辑 / 复制 / 删除（默认全部文字分镜）
import { computed } from "vue";

const props = defineProps({
  segments: { type: Array, required: true },
  selectedId: { type: String, default: "" },
  displayMode: { type: String, default: "seconds" },
  frameRate: { type: Number, default: 24 },
  showDeepseekImport: { type: Boolean, default: false },
});
const emit = defineEmits(["select", "change", "add", "duplicate", "remove", "deepseek-import"]);

const inSeconds = computed(() => props.displayMode === "seconds");

// 连续时间轴：重排所有 start（分镜顺序即时间顺序，无空隙）
function relayout() {
  let cursor = 0;
  for (const seg of props.segments) {
    seg.start = cursor;
    cursor += seg.length;
  }
}

function select(seg) {
  emit("select", seg.id);
}

function addShot() {
  emit("add");
}

function durationValue(seg) {
  return inSeconds.value
    ? Math.round(((seg.length || 0) / (props.frameRate || 24)) * 100) / 100
    : seg.length;
}

function setDuration(seg, val) {
  if (val == null || isNaN(val)) return;
  const frames = inSeconds.value
    ? Math.max(1, Math.round(val * (props.frameRate || 24)))
    : Math.max(1, Math.round(val));
  seg.length = frames;
  relayout();
  emit("change");
}

function onCopy(seg) {
  emit("duplicate", seg.id);
}

function onRemove(seg) {
  emit("remove", seg.id);
}
</script>

<template>
  <div class="mrd-shotlist">
    <div class="mrd-shotlist-head">
      <span class="mrd-shotlist-title">分镜（{{ segments.length }}）</span>
      <el-button size="small" type="primary" :icon="'Plus'" @click="addShot">添加</el-button>
    </div>
    <el-button
      v-if="showDeepseekImport"
      class="mrd-shotlist-dsi"
      size="small"
      plain
      :icon="'ChatDotRound'"
      @click="emit('deepseek-import')"
    >DeepSeek 分镜导入</el-button>

    <el-scrollbar class="mrd-shotlist-scroll">
      <TransitionGroup name="mrd-shot">
        <div
          v-for="(seg, i) in segments"
          :key="seg.id"
          class="mrd-shot-card"
          :class="{ selected: seg.id === selectedId }"
          @click="select(seg)"
        >
          <span class="mrd-shot-no">{{ i + 1 }}</span>
          <div class="mrd-shot-info">
            <div class="mrd-shot-prompt">{{ (seg.prompt || seg.h3PromptJson?.summary || "（空分镜）").slice(0, 60) }}</div>
            <div class="mrd-shot-dur" @click.stop>
              <span class="mrd-shot-dur-label">{{ inSeconds ? "时长(s)" : "时长(帧)" }}</span>
              <el-input-number
                :model-value="durationValue(seg)"
                :min="inSeconds ? 0.1 : 1"
                :step="inSeconds ? 0.5 : 12"
                :precision="inSeconds ? 2 : 0"
                size="small"
                controls-position="right"
                @change="val => setDuration(seg, val)"
                @click.stop
              />
              <span class="mrd-shot-ops">
                <el-button size="small" text :icon="'CopyDocument'" title="复制分镜" @click.stop="onCopy(seg)" />
                <el-button size="small" text type="danger" :icon="'Delete'" title="删除分镜" @click.stop="onRemove(seg)" />
              </span>
            </div>
          </div>
        </div>
      </TransitionGroup>
    </el-scrollbar>
  </div>
</template>

<style scoped>
.mrd-shotlist {
  width: 240px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.mrd-shotlist-head { display: flex; align-items: center; justify-content: space-between; flex: none; }
.mrd-shotlist-dsi {
  flex: none;
  width: 100%;
  border-style: dashed;
  color: #a78bfa;
  border-color: rgba(167, 139, 250, 0.45);
}
.mrd-shotlist-dsi:hover { color: #c4b5fd; border-color: #a78bfa; background: rgba(108, 92, 231, 0.08); }
.mrd-shotlist-title { font-size: 13px; font-weight: 600; color: #a9b1c3; }
.mrd-shotlist-scroll { flex: 1; min-height: 0; }
.mrd-shot-card {
  position: relative;
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px;
  background: #151821;
  border: 1px solid #222736;
  border-radius: 10px;
  cursor: pointer;
  margin-bottom: 8px;
  transition: border-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease;
}
.mrd-shot-card:hover { border-color: #313a52; transform: translateY(-1px); }
.mrd-shot-card.selected {
  border-color: #6c5ce7;
  box-shadow: 0 0 0 1px rgba(108, 92, 231, 0.55), 0 6px 18px rgba(108, 92, 231, 0.18);
}
.mrd-shot-no {
  flex: none;
  min-width: 20px;
  padding-top: 2px;
  font-size: 13px;
  font-weight: 700;
  color: #6b7488;
  text-align: center;
}
.mrd-shot-card.selected .mrd-shot-no { color: #a78bfa; }
.mrd-shot-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.mrd-shot-prompt {
  font-size: 11.5px; color: #a9b1c3; line-height: 1.4;
  overflow: hidden; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  min-height: 32px;
}
.mrd-shot-dur { display: flex; align-items: center; gap: 6px; }
.mrd-shot-dur-label { font-size: 10.5px; color: #6b7488; flex: none; }
.mrd-shot-dur :deep(.el-input-number) { width: 84px; }
.mrd-shot-ops { display: flex; align-items: center; margin-left: auto; }
.mrd-shot-ops :deep(.el-button) { padding: 4px; }
.mrd-shot-enter-active { transition: all 0.18s ease; }
.mrd-shot-enter-from { opacity: 0; transform: translateX(-12px); }
.mrd-shot-leave-active { transition: all 0.15s ease; position: absolute; opacity: 0; }
</style>
