<script setup>
// 音频切割对话框：展示完整音频波形，拖拽起止手柄调整裁剪窗口，
// 未选中区间遮罩，实时显示切割时长/音频时长（分:秒），确定回写 trimStart/length（秒）
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { drawWaveform, formatMinSec } from "../../utils/audio.js";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  segment: { type: Object, default: null },
  frameRate: { type: Number, default: 24 },
});
const emit = defineEmits(["update:modelValue", "confirm"]);

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

const fps = computed(() => props.frameRate || 24);
const totalSecs = computed(() =>
  (props.segment?.audioDurationFrames || 0) / fps.value
);
// 裁剪窗口（秒）：进入对话框时用当前 trimStart/length 初始化
const win = ref({ start: 0, end: 0 });

watch(visible, (v) => {
  if (v && props.segment) {
    const rate = fps.value;
    win.value = {
      start: (props.segment.trimStart || 0) / rate,
      end: ((props.segment.trimStart || 0) + (props.segment.length || 0)) / rate,
    };
    nextTick(drawFull);
  }
});

// 波形绘制（完整源音频）
const waveRef = ref(null);
function drawFull() {
  const canvas = waveRef.value;
  if (!canvas) return;
  drawWaveform(canvas, props.segment?.waveformPeaks || [], "#a78bfa", 0.3);
}

// ---- 手柄拖拽（pointer 事件；百分比窗口，宽度自适应）----
const trackRef = ref(null);
const MIN_WIN = 0.05; // 最小切割时长 0.05s
let dragSide = ""; // "start" | "end"

function pctToSecs(pct) {
  const total = Math.max(0.001, totalSecs.value);
  return Math.max(0, Math.min(1, pct)) * total;
}
function secsToPct(s) {
  const total = Math.max(0.001, totalSecs.value);
  return Math.max(0, Math.min(1, s / total));
}

function startDrag(side, e) {
  dragSide = side;
  document.body.classList.add("mrd-cut-dragging");
  const onMove = (ev) => {
    const rect = trackRef.value?.getBoundingClientRect();
    if (!rect) return;
    const s = pctToSecs((ev.clientX - rect.left) / rect.width);
    const w = win.value;
    if (side === "start") {
      w.start = Math.max(0, Math.min(s, w.end - MIN_WIN));
    } else {
      w.end = Math.min(totalSecs.value, Math.max(s, w.start + MIN_WIN));
    }
  };
  const finish = () => {
    dragSide = "";
    document.body.classList.remove("mrd-cut-dragging");
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

onBeforeUnmount(() => {
  document.body.classList.remove("mrd-cut-dragging");
});

const cutSecs = computed(() => Math.max(0, win.value.end - win.value.start));

function onConfirm() {
  if (!props.segment) return;
  if (cutSecs.value < 0.01) return;
  emit("confirm", {
    trimStartSecs: win.value.start,
    lengthSecs: cutSecs.value,
  });
  visible.value = false;
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="`切割音频 — ${segment?.fileName || ''}`"
    width="640px"
    append-to-body
    class="mrd-cut-dialog"
  >
    <div class="mrd-cut-body">
      <!-- 完整波形 + 遮罩 + 手柄 -->
      <div ref="trackRef" class="mrd-cut-track">
        <canvas ref="waveRef" class="mrd-cut-wave"></canvas>
        <!-- 左侧未选中遮罩 -->
        <div
          class="mrd-cut-mask"
          :style="{ left: 0, width: secsToPct(win.start) * 100 + '%' }"
        />
        <!-- 右侧未选中遮罩 -->
        <div
          class="mrd-cut-mask"
          :style="{
            left: secsToPct(win.end) * 100 + '%',
            width: (1 - secsToPct(win.end)) * 100 + '%',
          }"
        />
        <!-- 起始手柄 -->
        <div
          class="mrd-cut-handle"
          :class="{ active: dragSide === 'start' }"
          :style="{ left: secsToPct(win.start) * 100 + '%' }"
          @pointerdown.prevent="startDrag('start', $event)"
        >
          <span class="mrd-cut-grip" />
        </div>
        <!-- 结束手柄 -->
        <div
          class="mrd-cut-handle"
          :class="{ active: dragSide === 'end' }"
          :style="{ left: secsToPct(win.end) * 100 + '%' }"
          @pointerdown.prevent="startDrag('end', $event)"
        >
          <span class="mrd-cut-grip" />
        </div>
      </div>

      <!-- 时长展示（遮罩下方实时更新） -->
      <div class="mrd-cut-dur">
        切割时长 <b>{{ formatMinSec(cutSecs) }}</b>
        <span class="mrd-cut-dur-sep">/</span>
        音频时长 <b>{{ formatMinSec(totalSecs) }}</b>
        <span class="mrd-cut-range">
          （{{ formatMinSec(win.start) }} → {{ formatMinSec(win.end) }}）
        </span>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="cutSecs < 0.01" @click="onConfirm">确定</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mrd-cut-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mrd-cut-track {
  position: relative;
  height: 120px;
  border-radius: 10px;
  background: rgba(34, 39, 54, 0.6);
  border: 1px solid #222736;
  overflow: hidden;
  user-select: none;
}
.mrd-cut-wave {
  display: block;
  width: 100%;
  height: 100%;
}
.mrd-cut-mask {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.55);
  pointer-events: none;
  transition: none;
}
.mrd-cut-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 12px;
  transform: translateX(-50%);
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}
.mrd-cut-grip {
  width: 4px;
  height: 70%;
  border-radius: 2px;
  background: #a78bfa;
  box-shadow: 0 0 6px rgba(108, 92, 231, 0.6);
  transition: width 0.12s ease, background 0.12s ease;
}
.mrd-cut-handle:hover .mrd-cut-grip,
.mrd-cut-handle.active .mrd-cut-grip {
  width: 6px;
  background: #c4b5fd;
}
.mrd-cut-dur {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12.5px;
  color: #6b7488;
}
.mrd-cut-dur b {
  color: #d7dbe6;
  font-size: 13px;
  font-weight: 600;
}
.mrd-cut-dur-sep { color: #3a4358; }
.mrd-cut-range { font-size: 11px; }
</style>

<style>
/* 拖拽手柄期间禁用文本选择 */
body.mrd-cut-dragging {
  cursor: ew-resize !important;
  user-select: none !important;
}
body.mrd-cut-dragging * { cursor: ew-resize !important; }
/* 切割弹窗暗色化（append-to-body，需全局样式） */
.el-dialog.mrd-cut-dialog {
  background: #1c202b;
  border: 1px solid #2a3042;
}
</style>
