<script setup>
// 右侧 Tab1 分镜参数：
// 自动尾帧 / 引导强度(0/5/22/39/56/73/90/107) / 降噪强度 /
// 首帧图|上个分镜视频 / 尾帧图|下个分镜视频 / 首尾分镜参考（视频）
// 「上个/下个分镜视频」：来源存 seg.firstFrameSource / lastFrameSource，
//   保存时由 workspace 序列化物化为 imageFile / lastFrameFile（此处切换时亦即时物化）。
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import { uploadImage, uploadVideo, viewUrl } from "../../api/client.js";

const props = defineProps({
  segment: { type: Object, required: true },
  segments: { type: Array, required: true },
});
const ws = useWorkspace();

const GUIDE_STRENGTH_OPTIONS = [0, 5, 22, 39, 56, 73, 90, 107];
const uploading = ref("");

function dirty() {
  ws.markDirty();
}

const segIndex = computed(() => props.segments.indexOf(props.segment));
const prevSeg = computed(() => (segIndex.value > 0 ? props.segments[segIndex.value - 1] : null));
const nextSeg = computed(() =>
  segIndex.value >= 0 && segIndex.value < props.segments.length - 1 ? props.segments[segIndex.value + 1] : null
);

function ensureDenoise() {
  if (!props.segment.denoise || typeof props.segment.denoise !== "object") {
    props.segment.denoise = { enabled: false, alpha: 1.0, alpha_end: null, ramp: 0, seed: 0 };
  }
  return props.segment.denoise;
}
const denoise = computed(() => ensureDenoise());

// 首帧来源：image（上传图片）| prevVideo（上个分镜视频，存时物化为 imageFile）
const firstFrameSource = computed(() =>
  props.segment.firstFrameSource === "prevVideo" ? "prevVideo" : "image"
);
// 尾帧来源：image | nextVideo（物化为 lastFrameFile）
const lastFrameSource = computed(() =>
  props.segment.lastFrameSource === "nextVideo" ? "nextVideo" : "image"
);

function setFirstFrameSource(v) {
  if (v === "prevVideo") {
    const vid = prevSeg.value?.videoFile;
    if (!vid) {
      ElMessage.warning("上个分镜没有视频，请先在上个分镜添加首尾分镜参考视频");
      return;
    }
    props.segment.firstFrameSource = "prevVideo";
    props.segment.imageFile = vid;
  } else {
    props.segment.firstFrameSource = "image";
    // 若当前首帧是从上个分镜视频物化来的 → 清空，避免残留引用
    if (props.segment.imageFile && props.segment.imageFile === prevSeg.value?.videoFile) {
      props.segment.imageFile = "";
    }
  }
  dirty();
}

function setLastFrameSource(v) {
  if (v === "nextVideo") {
    const vid = nextSeg.value?.videoFile;
    if (!vid) {
      ElMessage.warning("下个分镜没有视频，请先在下个分镜添加首尾分镜参考视频");
      return;
    }
    props.segment.lastFrameSource = "nextVideo";
    props.segment.lastFrameFile = vid;
  } else {
    props.segment.lastFrameSource = "image";
    if (props.segment.lastFrameFile && props.segment.lastFrameFile === nextSeg.value?.videoFile) {
      props.segment.lastFrameFile = "";
    }
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

// ---- 图片上传（首帧 / 尾帧） ----
function pickImage(field) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    uploading.value = field;
    try {
      const r = await uploadImage(file);
      props.segment[field] = `${r.subfolder || "minimaxrefdirector"}/${r.name}`;
      // 切回图片来源
      if (field === "imageFile") props.segment.firstFrameSource = "image";
      else props.segment.lastFrameSource = "image";
      dirty();
    } catch (e) {
      ElMessage.error(`上传失败：${e.message || e}`);
    } finally {
      uploading.value = "";
    }
  };
  input.click();
}

// ---- 首尾分镜参考（视频） ----
function pickVideo() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "video/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    uploading.value = "videoFile";
    try {
      const r = await uploadVideo(file);
      props.segment.videoFile = `${r.subfolder || "minimaxrefdirector"}/${r.name}`;
      props.segment.type = "video";
      dirty();
    } catch (e) {
      ElMessage.error(`上传失败：${e.message || e}`);
    } finally {
      uploading.value = "";
    }
  };
  input.click();
}

function clearField(field) {
  props.segment[field] = "";
  if (field === "imageFile") props.segment.firstFrameSource = "image";
  if (field === "lastFrameFile") props.segment.lastFrameSource = "image";
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
      />
    </div>

    <!-- 引导强度 -->
    <div class="mrd-param-col">
      <div class="mrd-param-label">引导强度（context frames）</div>
      <el-select :model-value="guideValue()" @change="setGuide">
        <el-option v-for="v in GUIDE_STRENGTH_OPTIONS" :key="v" :label="String(v)" :value="v" />
      </el-select>
    </div>

    <!-- 降噪强度 -->
    <div class="mrd-param-col">
      <div class="mrd-param-label">
        降噪强度（denoise）
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

    <!-- 首帧图 / 上个分镜视频 -->
    <div class="mrd-param-col">
      <div class="mrd-param-label">首帧图 / 上个分镜视频</div>
      <el-segmented
        :model-value="firstFrameSource"
        :options="[
          { label: '首帧图', value: 'image' },
          { label: '上个分镜视频', value: 'prevVideo' },
        ]"
        size="small"
        @change="setFirstFrameSource"
      />
      <div v-if="firstFrameSource === 'image'" class="mrd-media-slot">
        <template v-if="segment.imageFile">
          <img :src="viewUrl(segment.imageFile)" alt="" />
          <div class="mrd-media-ops">
            <el-button size="small" text :loading="uploading === 'imageFile'" @click="pickImage('imageFile')">更换</el-button>
            <el-button size="small" text type="danger" @click="clearField('imageFile')">移除</el-button>
          </div>
        </template>
        <el-button v-else size="small" :loading="uploading === 'imageFile'" @click="pickImage('imageFile')">
          <el-icon><component :is="'Picture'" /></el-icon>&nbsp;添加首帧图
        </el-button>
      </div>
      <div v-else class="mrd-media-slot">
        <template v-if="segment.imageFile">
          <video :src="viewUrl(segment.imageFile)" controls muted preload="metadata" />
          <div class="mrd-media-ops">
            <span class="mrd-media-from">来自分镜 {{ segIndex }} 的参考视频</span>
            <el-button size="small" text type="danger" @click="clearField('imageFile')">取消引用</el-button>
          </div>
        </template>
        <el-button v-else size="small" disabled>上个分镜暂无视频</el-button>
      </div>
    </div>

    <!-- 尾帧图 / 下个分镜视频 -->
    <div class="mrd-param-col">
      <div class="mrd-param-label">尾帧图 / 下个分镜视频</div>
      <el-segmented
        :model-value="lastFrameSource"
        :options="[
          { label: '尾帧图', value: 'image' },
          { label: '下个分镜视频', value: 'nextVideo' },
        ]"
        size="small"
        @change="setLastFrameSource"
      />
      <div v-if="lastFrameSource === 'image'" class="mrd-media-slot">
        <template v-if="segment.lastFrameFile">
          <img :src="viewUrl(segment.lastFrameFile)" alt="" />
          <div class="mrd-media-ops">
            <el-button size="small" text :loading="uploading === 'lastFrameFile'" @click="pickImage('lastFrameFile')">更换</el-button>
            <el-button size="small" text type="danger" @click="clearField('lastFrameFile')">移除</el-button>
          </div>
        </template>
        <el-button v-else size="small" :loading="uploading === 'lastFrameFile'" @click="pickImage('lastFrameFile')">
          <el-icon><component :is="'PictureFilled'" /></el-icon>&nbsp;添加尾帧图
        </el-button>
      </div>
      <div v-else class="mrd-media-slot">
        <template v-if="segment.lastFrameFile">
          <video :src="viewUrl(segment.lastFrameFile)" controls muted preload="metadata" />
          <div class="mrd-media-ops">
            <span class="mrd-media-from">来自分镜 {{ segIndex + 2 }} 的参考视频</span>
            <el-button size="small" text type="danger" @click="clearField('lastFrameFile')">取消引用</el-button>
          </div>
        </template>
        <el-button v-else size="small" disabled>下个分镜暂无视频</el-button>
      </div>
    </div>

    <!-- 首尾分镜参考（视频） -->
    <div class="mrd-param-col">
      <div class="mrd-param-label">
        首尾分镜参考
        <el-tooltip placement="top" content="本分镜的参考视频：既作为自身首尾参考，也可被相邻分镜在「上个/下个分镜视频」中引用">
          <el-icon class="mrd-param-help"><component :is="'QuestionFilled'" /></el-icon>
        </el-tooltip>
      </div>
      <div class="mrd-media-slot">
        <template v-if="segment.videoFile">
          <video :src="viewUrl(segment.videoFile)" controls muted preload="metadata" />
          <div class="mrd-media-ops">
            <el-button size="small" text :loading="uploading === 'videoFile'" @click="pickVideo">更换</el-button>
            <el-button size="small" text type="danger" @click="clearField('videoFile')">移除</el-button>
          </div>
        </template>
        <el-button v-else size="small" :loading="uploading === 'videoFile'" @click="pickVideo">
          <el-icon><component :is="'VideoCamera'" /></el-icon>&nbsp;添加参考视频
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mrd-params { display: flex; flex-direction: column; gap: 14px; }
.mrd-param-row { display: flex; align-items: center; justify-content: space-between; }
.mrd-param-col { display: flex; flex-direction: column; gap: 6px; }
.mrd-param-label {
  font-size: 12px; color: #a9b1c3;
  display: flex; align-items: center; gap: 5px;
}
.mrd-param-help { color: #4b5266; cursor: help; }
.mrd-params :deep(.el-select) { width: 100%; }
.mrd-params :deep(.el-segmented) { width: 100%; }
.mrd-denoise-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mrd-denoise-cell { display: flex; flex-direction: column; gap: 3px; }
.mrd-denoise-cell > label { font-size: 11px; color: #6b7488; }
.mrd-denoise-cell :deep(.el-input-number) { width: 100%; }
.mrd-media-slot { display: flex; flex-direction: column; gap: 4px; }
.mrd-media-slot img, .mrd-media-slot video {
  width: 100%; max-height: 130px; object-fit: contain;
  border-radius: 8px; border: 1px solid #2a3042; background: #10131b;
}
.mrd-media-ops { display: flex; justify-content: center; align-items: center; gap: 6px; }
.mrd-media-from { font-size: 11px; color: #55607a; }
</style>
