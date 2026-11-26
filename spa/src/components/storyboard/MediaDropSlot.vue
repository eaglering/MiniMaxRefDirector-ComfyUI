<script setup>
// 通用拖拽上传槽位：拖拽/点击上传 → ComfyUI input（uploadImage/uploadVideo），
// 内置预览与移除。首帧图/首帧参考视频/尾帧图/尾帧参考视频/参考视频共用。
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { uploadImage, uploadVideo, viewUrl } from "../../api/client.js";

const props = defineProps({
  modelValue: { type: String, default: "" }, // 文件 key：subfolder/name
  type: { type: String, default: "image" }, // image | video
  label: { type: String, default: "" },
  hint: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue"]);

const dragging = ref(false);
const uploading = ref(false);
const inputRef = ref(null);

const accept = computed(() => (props.type === "video" ? "video/*" : "image/*"));
// 旧数据里 imageFile 可能被物化成视频（上个分镜视频引用），按扩展名自动切换预览方式
const isVideoPreview = computed(
  () => props.type === "video" || /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(props.modelValue || "")
);

function pick() {
  inputRef.value?.click();
}

async function handleFiles(files) {
  const file = files && files[0];
  if (!file) return;
  const ok = props.type === "video" ? file.type.startsWith("video/") : file.type.startsWith("image/");
  if (!ok) {
    ElMessage.warning(props.type === "video" ? "请上传视频文件" : "请上传图片文件");
    return;
  }
  uploading.value = true;
  try {
    const r = props.type === "video" ? await uploadVideo(file) : await uploadImage(file);
    emit("update:modelValue", `${r.subfolder || "minimaxrefdirector"}/${r.name}`);
  } catch (e) {
    ElMessage.error(`上传失败：${e.message || e}`);
  } finally {
    uploading.value = false;
  }
}

function onDrop(e) {
  dragging.value = false;
  handleFiles(e.dataTransfer?.files);
}
function onChange(e) {
  handleFiles(e.target.files);
  e.target.value = "";
}
function remove() {
  emit("update:modelValue", "");
}
</script>

<template>
  <div
    class="mrd-drop"
    :class="{ drag: dragging, filled: !!modelValue, uploading }"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
    @click="!modelValue && pick()"
  >
    <template v-if="modelValue">
      <video v-if="isVideoPreview" :src="viewUrl(modelValue)" controls muted preload="metadata" />
      <img v-else :src="viewUrl(modelValue)" alt="" />
      <div class="mrd-drop-ops" @click.stop>
        <el-button size="small" text :loading="uploading" @click="pick">更换</el-button>
        <el-button size="small" text type="danger" @click="remove">移除</el-button>
      </div>
    </template>
    <template v-else>
      <div class="mrd-drop-empty">
        <el-icon class="mrd-drop-icon"><component :is="type === 'video' ? 'VideoCamera' : 'Picture'" /></el-icon>
        <div class="mrd-drop-label">{{ label || (type === "video" ? "拖入视频，或点击上传" : "拖入图片，或点击上传") }}</div>
        <div v-if="hint" class="mrd-drop-hint">{{ hint }}</div>
        <div v-if="uploading" class="mrd-drop-hint">上传中…</div>
      </div>
    </template>
    <input ref="inputRef" type="file" :accept="accept" hidden @change="onChange" />
  </div>
</template>

<style scoped>
.mrd-drop {
  position: relative;
  width: 100%;
  min-height: 84px;
  border: 1px dashed #2a3042;
  border-radius: 10px;
  background: #10131b;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
  overflow: hidden;
}
.mrd-drop:hover { border-color: #4d5680; }
.mrd-drop.drag {
  border-color: #6c5ce7;
  background: rgba(108, 92, 231, 0.08);
  box-shadow: inset 0 0 0 1px rgba(108, 92, 231, 0.45);
}
.mrd-drop.filled { cursor: default; padding: 6px; flex-direction: column; gap: 4px; }
.mrd-drop img,
.mrd-drop video {
  width: 100%;
  max-height: 130px;
  object-fit: contain;
  border-radius: 6px;
  background: #0d1017;
  pointer-events: none;
}
.mrd-drop video { pointer-events: auto; }
.mrd-drop-ops { display: flex; justify-content: center; gap: 6px; }
.mrd-drop-empty { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 12px 8px; }
.mrd-drop-icon { font-size: 20px; color: #4b5266; }
.mrd-drop.drag .mrd-drop-icon { color: #8f7ff0; }
.mrd-drop-label { font-size: 11.5px; color: #6b7488; }
.mrd-drop-hint { font-size: 10.5px; color: #4b5366; }
</style>
