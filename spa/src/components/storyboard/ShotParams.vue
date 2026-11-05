<script setup>
// 右侧 Tab1 分镜参数：
// 自动尾帧 / 引导强度(0/5/22/39/56/73/90/107) / 降噪强度（H3 Context Taper Noise）/
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

// 噪声图样 / 网格模式选项（key 与节点 optional 参数枚举一致）
const NOISE_PATTERN_OPTIONS = [
  { value: "poc_chroma_blocks", label: "色度色块（推荐）" },
  { value: "gaussian_rgb", label: "高斯 RGB（实验）" },
  { value: "uniform_rgb", label: "均匀 RGB（实验）" },
];
const GRID_MODE_OPTIONS = [
  { value: "poc_36x64", label: "参考网格 36x64（推荐）" },
  { value: "block_size", label: "固定块大小" },
];

function dirty() {
  ws.markDirty();
}

// 降噪默认值（与 MiniMaxH3ContextTaperNoise 节点默认一致）
const DENOISE_DEFAULTS = {
  enabled: false,
  alpha: 0.45,
  alpha_end: 0.10,
  ramp: 3,
  seed: 0,
  pattern: "poc_chroma_blocks",
  grid_mode: "poc_36x64",
  block_size: 16,
};

// 非侵入式读取：denoise 仅在开关开启时存在（关闭即整块清除），不做逐键校验
const denoise = computed(() =>
  props.segment.denoise && typeof props.segment.denoise === "object"
    ? props.segment.denoise
    : null
);

// 开启：直接以默认值整块填充 seg.denoise；关闭：清除 denoise 数据
function setDenoiseEnabled(v) {
  if (v) {
    props.segment.denoise = { ...DENOISE_DEFAULTS, enabled: true };
  } else {
    delete props.segment.denoise;
  }
  dirty();
}

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
    <div class="mrd-param-row">
      <div class="mrd-param-label">引导强度</div>
      <el-select :model-value="guideValue()" size="small" @change="setGuide" style="width: 60px;">
        <el-option
          v-for="v in GUIDE_STRENGTH_OPTIONS"
          :key="v"
          :label="v"
          :value="v"
        />
      </el-select>
    </div>

    <!-- 降噪强度：MiniMaxH3ContextTaperNoise（tail_frames 由后端自动取 context 长度） -->
    <div class="mrd-param-col">
      <div class="mrd-param-row">
        <div class="mrd-param-label">
          接缝降噪
          <el-tooltip placement="top" content="对上一分镜尾部被 H3 Motion Context 钉住的帧注入锥形噪声：保留运动信息的同时迫使模型从主体参考重新合成外观，消除接缝处的色彩残留">
            <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
          </el-tooltip>
        </div>
        <el-switch
          size="small"
          :model-value="!!denoise?.enabled"
          @update:model-value="setDenoiseEnabled"
        />
      </div>
      <template v-if="denoise && denoise.enabled">
        <div class="mrd-denoise-grid">
          <div class="mrd-denoise-cell">
            <label>
              平铺强度 α
              <el-tooltip placement="top" content="整个注入窗口内统一的噪声强度（alpha）。0.45 为项目验证值；越低保留上一镜外观越多，越高越迫使模型回归主体参考">
                <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
              </el-tooltip>
            </label>
            <el-input-number v-model="denoise.alpha" :min="0" :max="1" :step="0.05" :precision="2" size="small" @change="dirty" />
          </div>
          <div class="mrd-denoise-cell">
            <label>
              接缝强度 α_end
              <el-tooltip placement="top" content="最后一帧（紧贴接缝处）的噪声强度（alpha_end），不应高于平铺强度。0.10 为项目验证值">
                <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
              </el-tooltip>
            </label>
            <el-input-number v-model="denoise.alpha_end" :min="0" :max="1" :step="0.05" :precision="2" size="small" @change="dirty" />
          </div>
          <div class="mrd-denoise-cell">
            <label>
              渐变帧数 ramp
              <el-tooltip placement="top" content="窗口末尾从平铺强度渐变到接缝强度的帧数（ramp_frames）。3 为验证值：0.333 / 0.217 / 0.100">
                <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
              </el-tooltip>
            </label>
            <el-input-number v-model="denoise.ramp" :min="1" :step="1" :precision="0" size="small" @change="dirty" />
          </div>
          <div class="mrd-denoise-cell">
            <label>
              噪声种子
              <el-tooltip placement="top" content="噪声图样的随机种子（seed），同一种子整段可复现">
                <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
              </el-tooltip>
            </label>
            <el-input-number v-model="denoise.seed" :min="0" :step="1" :precision="0" size="small" @change="dirty" />
          </div>
          <div class="mrd-denoise-cell">
            <label>
              噪声图样
              <el-tooltip placement="top" content="色度色块：6 色色度调色板方块（项目验证方案）；高斯/均匀 RGB 为实验选项，未经验证">
                <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
              </el-tooltip>
            </label>
            <el-select v-model="denoise.pattern" size="small" @change="dirty">
              <el-option v-for="o in NOISE_PATTERN_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
          </div>
          <div class="mrd-denoise-cell">
            <label>
              网格模式
              <el-tooltip placement="top" content="参考网格 36x64：逐位复现参考脚本（仅 576x1024 下等于 16px 块）；固定块大小：任意分辨率下保持块尺寸恒定">
                <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
              </el-tooltip>
            </label>
            <el-select v-model="denoise.grid_mode" size="small" @change="dirty">
              <el-option v-for="o in GRID_MODE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
          </div>
          <div v-if="denoise.grid_mode === 'block_size'" class="mrd-denoise-cell">
            <label>
              块大小（px）
              <el-tooltip placement="top" content="网格模式为「固定块大小」时的像素块边长（block_size）">
                <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
              </el-tooltip>
            </label>
            <el-input-number v-model="denoise.block_size" :min="1" :max="256" :step="1" :precision="0" size="small" @change="dirty" />
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
