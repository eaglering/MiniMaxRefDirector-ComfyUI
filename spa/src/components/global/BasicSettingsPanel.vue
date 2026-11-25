<script setup>
// 全局参数 · 基础设置面板（画幅 / 像素 / 时间单位 / 帧率 + 只读时间范围）
// 开始 / 结束 / 时长由分镜页时间线跨度自动计算（applySpanRange 写回
// widgets.start_second / end_second），此处仅展示、不可编辑。
import { computed } from "vue";
import { useWorkspace } from "../../stores/workspace.js";

const ws = useWorkspace();

const RESOLUTIONS = ["1:1方形", "9:16竖屏", "16:9横屏", "3:2横屏", "2:3竖屏", "4:3横屏", "3:4竖屏", "21:9超宽"];

function dirty() {
  ws.markDirty();
}

// 只读时间范围：按 display_mode 切换单位（秒 → start_second/end_second/
// duration_seconds；帧 → start_frame/end_frame/duration_frames）
const isFrames = computed(() => ws.widgets.display_mode === "frames");
const startVal = computed(() => Number(isFrames.value ? ws.widgets.start_frame : ws.widgets.start_second) || 0);
const endVal = computed(() => Number(isFrames.value ? ws.widgets.end_frame : ws.widgets.end_second) || 0);
const durationVal = computed(() => {
  if (isFrames.value) return Math.max(0, Number(ws.widgets.duration_frames) || 0);
  return Math.max(0, Number(ws.widgets.duration_seconds) || 0);
});

function fmt(v) {
  return `${v}${isFrames.value ? "帧" : "秒"}`;
}

// 帧率变更：秒为基准重算帧单位字段，保持秒/帧同步
function onFpsChange() {
  const fps = ws.widgets.frame_rate || 24;
  const s = Number(ws.widgets.start_second) || 0;
  const e = Number(ws.widgets.end_second) || 0;
  const sf = Math.round(s * fps);
  const ef = Math.round(e * fps);
  ws.widgets.start_frame = sf;
  ws.widgets.end_frame = Math.max(sf + 1, ef);
  ws.widgets.duration_frames = Math.max(1, ef - sf);
  ws.widgets.duration_seconds = Math.max(0, Math.round((e - s) * 100) / 100);
  dirty();
}
</script>

<template>
  <section class="mrd-card mrd-section">
    <h3 class="mrd-section-title"><el-icon><component :is="'Setting'" /></el-icon>基础设置</h3>
    <div class="mrd-form-grid">
      <div class="mrd-field">
        <label>输出画幅比例</label>
        <el-select v-model="ws.widgets.outpu_resolution" @change="dirty">
          <el-option v-for="r in RESOLUTIONS" :key="r" :label="r" :value="r" />
        </el-select>
      </div>
      <div class="mrd-field">
        <label>百万像素（Million Pixels）</label>
        <el-input-number
          v-model="ws.widgets.million_pixels"
          :min="0.1" :max="4" :step="0.1" :precision="1"
          controls-position="right"
          @change="dirty"
        />
      </div>
      <div class="mrd-field">
        <label>时间显示单位</label>
        <el-radio-group v-model="ws.widgets.display_mode" @change="dirty">
          <el-radio-button value="seconds">秒</el-radio-button>
          <el-radio-button value="frames">帧</el-radio-button>
        </el-radio-group>
      </div>
      <div class="mrd-field">
        <label>帧率（FPS）</label>
        <el-input-number
          v-model="ws.widgets.frame_rate"
          :min="1" :max="240" :step="1"
          controls-position="right"
          @change="onFpsChange"
        />
      </div>
    </div>
    <div class="mrd-form-grid mrd-time-grid">
      <div class="mrd-field">
        <label>开始（时间线跨度）</label>
        <div class="mrd-readonly-value">{{ fmt(startVal) }}</div>
      </div>
      <div class="mrd-field">
        <label>结束（时间线跨度）</label>
        <div class="mrd-readonly-value">{{ fmt(endVal) }}</div>
      </div>
      <div class="mrd-field">
        <label>时长</label>
        <div class="mrd-readonly-value">{{ fmt(durationVal) }}</div>
      </div>
      <div class="mrd-field"></div>
    </div>
    <div class="mrd-time-hint">
      开始 / 结束取自分镜页时间线跨度（秒与帧单位双写同步），时长随之计算，此页不可编辑。
    </div>
  </section>
</template>

<style scoped>
.mrd-section { padding: 18px 22px; }
.mrd-section-title {
  margin: 0 0 16px;
  font-size: 15px;
  font-weight: 600;
  color: #edeff5;
  display: flex;
  align-items: center;
  gap: 8px;
}
.mrd-section-title :deep(.el-icon) { color: #a78bfa; }
.mrd-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px 18px;
}
.mrd-field { display: flex; flex-direction: column; gap: 6px; }
.mrd-field > label { font-size: 12px; color: #a9b1c3; }
.mrd-time-grid { margin-top: 18px; padding-top: 16px; border-top: 1px dashed #2c3143; }
.mrd-readonly-value {
  padding: 5px 11px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid #2c3143;
  color: #c3c9d6;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.mrd-time-hint { margin-top: 10px; font-size: 12px; color: #6f7889; }
</style>
