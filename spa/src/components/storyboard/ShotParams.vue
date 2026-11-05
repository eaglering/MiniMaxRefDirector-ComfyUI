<script setup>
// 右侧 Tab1 分镜参数：
// 自动尾帧 / 引导强度(0/5/22/39/56/73/90/107) / 降噪强度 /
// 首帧图 + 首帧参考视频（两个独立拖拽上传组件，互不关联）/
// 尾帧图 + 尾帧参考视频（同理）/ 首尾分镜参考（视频，拖拽上传）
// 保存时由 workspace 序列化：firstFrameVideo/lastFrameVideo 优先物化为
// imageFile / lastFrameFile（后端只消费这两个文件名字段）。
import { computed } from "vue";
import { useWorkspace } from "../../stores/workspace.js";
import MediaDropSlot from "./MediaDropSlot.vue";

const props = defineProps({
  segment: { type: Object, required: true },
  segments: { type: Array, required: true },
});
const ws = useWorkspace();

const GUIDE_STRENGTH_OPTIONS = [0, 5, 22, 39, 56, 73, 90, 107];

function dirty() {
  ws.markDirty();
}

function ensureDenoise() {
  if (!props.segment.denoise || typeof props.segment.denoise !== "object") {
    props.segment.denoise = { enabled: false, alpha: 1.0, alpha_end: null, ramp: 0, seed: 0 };
  }
  return props.segment.denoise;
}
const denoise = computed(() => ensureDenoise());

function guideValue() {
  return props.segment.guideStrength ?? 22;
}
function setGuide(v) {
  props.segment.guideStrength = v;
  dirty();
}

// 上传/移除首尾帧图时清掉旧的相邻视频引用声明，避免序列化时被覆盖
function setImageFile(v) {
  props.segment.imageFile = v;
  if (v) props.segment.firstFrameSource = "image";
  dirty();
}
function setLastFrameFile(v) {
  props.segment.lastFrameFile = v;
  if (v) props.segment.lastFrameSource = "image";
  dirty();
}
function setFirstFrameVideo(v) {
  props.segment.firstFrameVideo = v;
  dirty();
}
function setLastFrameVideo(v) {
  props.segment.lastFrameVideo = v;
  dirty();
}
function setVideoFile(v) {
  props.segment.videoFile = v;
  if (v) props.segment.type = "video";
  dirty();
}
</script>

<template>
  <div class="mrd-params">
    <!-- 自动尾帧 -->
    <div class="mrd-param-row">
      <div class="mrd-param-label">
        自动尾帧
        <el-tooltip placement="top" content="开启后以下一分镜作为本分镜的结束锚点（画面衔接）">
          <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
        </el-tooltip>
      </div>
      <el-switch
        :model-value="!!segment.autoEndFrame"
        @update:model-value="v => { segment.autoEndFrame = v; dirty(); }"
        size="small"
      />
    </div>

    <!-- 引导强度 -->
    <div class="mrd-param-col">
      <div class="mrd-param-label">引导强度</div>
      <el-radio-group :model-value="guideValue()" @change="setGuide" size="small">
        <el-radio-button v-for="v in GUIDE_STRENGTH_OPTIONS" :key="v" :label="v">{{ v }}</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 降噪强度 -->
    <div class="mrd-param-col">
      <div class="mrd-param-row">
        <div class="mrd-param-label">
          降噪强度
        </div>
        <el-switch
          size="small"
          :model-value="!!denoise.enabled"
          @update:model-value="v => { denoise.enabled = v; dirty(); }"
        />
      </div>
      <template v-if="denoise.enabled">
        <div class="mrd-denoise-grid">
          <div class="mrd-denoise-cell">
            <label>起始 α</label>
            <el-input-number v-model="denoise.alpha" :min="0" :max="1" :step="0.05" size="small" controls-position="right" @change="dirty" />
          </div>
          <div class="mrd-denoise-cell">
            <label>结束 α</label>
            <el-input-number v-model="denoise.alpha_end" :min="0" :max="1" :step="0.05" size="small" controls-position="right" @change="dirty" />
          </div>
          <div class="mrd-denoise-cell">
            <label>渐变 ramp</label>
            <el-input-number v-model="denoise.ramp" :min="0" :max="1" :step="0.05" size="small" controls-position="right" @change="dirty" />
          </div>
          <div class="mrd-denoise-cell">
            <label>种子</label>
            <el-input-number v-model="denoise.seed" :min="0" :step="1" size="small" controls-position="right" @change="dirty" />
          </div>
        </div>
      </template>
    </div>

    <!-- 首帧图 / 首帧参考视频：两个独立拖拽上传组件，互不关联 -->
    <div class="mrd-param-col">
      <div class="mrd-param-label">首帧图</div>
      <MediaDropSlot
        :model-value="segment.imageFile || ''"
        type="image"
        label="拖入首帧参考图，或点击上传"
        @update:model-value="setImageFile"
      />
    </div>
    <div class="mrd-param-col">
      <div class="mrd-param-label">
        首帧引导视频
        <el-tooltip placement="top" content="分镜运行时作为本分镜的引导视频（imageFile）">
          <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
        </el-tooltip>
      </div>
      <MediaDropSlot
        :model-value="segment.firstFrameVideo || ''"
        type="video"
        label="拖入首帧引导视频，或点击上传"
        @update:model-value="setFirstFrameVideo"
      />
    </div>

    <!-- 尾帧图 / 尾帧参考视频：同理独立 -->
    <div class="mrd-param-col">
      <div class="mrd-param-label">尾帧图</div>
      <MediaDropSlot
        :model-value="segment.lastFrameFile || ''"
        type="image"
        label="拖入尾帧参考图，或点击上传"
        @update:model-value="setLastFrameFile"
      />
    </div>
    <div class="mrd-param-col">
      <div class="mrd-param-label">
        尾帧引导视频
        <el-tooltip placement="top" content="分镜运行时作为本分镜的结束锚点（lastFrameFile）">
          <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
        </el-tooltip>
      </div>
      <MediaDropSlot
        :model-value="segment.lastFrameVideo || ''"
        type="video"
        label="拖入尾帧引导视频，或点击上传"
        @update:model-value="setLastFrameVideo"
      />
    </div>

    <!-- 首尾分镜参考（视频） -->
    <div class="mrd-param-col">
      <div class="mrd-param-label">
        首尾分镜参考
        <el-tooltip placement="top" content="本分镜的参考视频：既作为自身首尾参考，也可被相邻分镜引用">
          <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
        </el-tooltip>
      </div>
      <MediaDropSlot
        :model-value="segment.videoFile || ''"
        type="video"
        label="拖入参考视频，或点击上传"
        @update:model-value="setVideoFile"
      />
    </div>
  </div>
</template>

<style scoped>
.mrd-params { display: flex; flex-direction: column; gap: 14px; padding-right: 8px; }
.mrd-param-row { display: flex; align-items: center; justify-content: space-between; }
.mrd-param-col { display: flex; flex-direction: column; gap: 6px; }
.mrd-param-label {
  font-size: 12px; color: #a9b1c3;
  display: flex; align-items: center; gap: 5px;
}
.mrd-param-help { color: #4b5266; cursor: help; }
.mrd-params :deep(.el-select) { width: 100%; }
.mrd-denoise-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.mrd-denoise-cell { display: flex; flex-direction: column; gap: 3px; }
.mrd-denoise-cell > label { font-size: 11px; color: #6b7488; }
.mrd-denoise-cell :deep(.el-input-number) { width: 100%; }
</style>
