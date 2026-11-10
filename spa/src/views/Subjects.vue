<script setup>
// 主体管理页：功能与 js/subject.js 对等（无 LLM 设置与全局提示词）
import { computed, nextTick, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspace } from "../stores/workspace.js";
import {
  SUBJECT_TYPES, SUBJECT_TYPE_LABELS, makeSubject, isChildSubject,
} from "../constants/subject.js";
import SubjectCard from "../components/subjects/SubjectCard.vue";

const ws = useWorkspace();
const activeTab = ref("Subject");
const listRef = ref(null);
const dragActive = ref(false);

const subjects = computed(() => ws.subjects.subjects);

// 当前 tab 下可见主体（排除引用子主体）
const visibleOfTab = computed(() =>
  subjects.value.filter((s) => !isChildSubject(s) && s.type === activeTab.value)
);
const visibleCount = computed(() => subjects.value.filter((s) => !isChildSubject(s)).length);

function addSubject() {
  subjects.value.unshift(makeSubject(activeTab.value));
  ws.markDirty();
  nextTick(() => {
    listRef.value?.scrollTo?.({ top: listRef.value.scrollHeight, behavior: "smooth" });
  });
}

function canRemove() {
  return visibleCount.value > 1;
}

async function onRemove(subj) {
  if (!canRemove()) {
    ElMessage.warning("至少保留一个主体");
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确定删除主体「${subj.name || "(未命名)"}」？其引用资源（子主体）将一并删除。`,
      "删除主体",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return;
  }
  // 级联删除子主体
  for (let i = subjects.value.length - 1; i >= 0; i--) {
    const s = subjects.value[i];
    if (s === subj || (s.ownerUid && s.ownerUid === subj.uid)) {
      subjects.value.splice(i, 1);
    }
  }
  ws.markDirty();
}

// ---- 整页文件拖放：识别类型 → 新建卡片并上传主媒体 ----
function detectKind(file) {
  const t = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (t.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/.test(name)) return "Picture";
  if (t.startsWith("video/") || /\.(mp4|mov|mkv|webm|avi|m4v)$/.test(name)) return "Video";
  if (t.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a|aac)$/.test(name)) return "Audio";
  return null;
}

async function onDrop(e) {
  dragActive.value = false;
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  const { uploadImage, uploadAudio, uploadVideo } = await import("../api/client.js");
  for (const file of files) {
    const type = detectKind(file);
    if (!type) {
      ElMessage.warning(`无法识别文件类型：${file.name}`);
      continue;
    }
    const subj = makeSubject(type);
    try {
      if (type === "Picture") {
        const r = await uploadImage(file);
        subj.imageFile = `${r.subfolder || "minimaxrefdirector"}/${r.name}`;
      } else if (type === "Audio") {
        const r = await uploadAudio(file);
        subj.audioFile = r.name || r.path || "";
      } else {
        const r = await uploadVideo(file);
        subj.videoFile = `${r.subfolder || "minimaxrefdirector"}/${r.name}`;
      }
      subjects.value.push(subj);
      activeTab.value = type;
    } catch (err) {
      ElMessage.error(`上传 ${file.name} 失败：${err.message || err}`);
    }
  }
  ws.markDirty();
}

function onDragOver(e) {
  e.preventDefault();
  dragActive.value = true;
}
function onDragLeave() {
  dragActive.value = false;
}
</script>

<template>
  <div
    class="mrd-subjects"
    :class="{ 'drag-active': dragActive }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div class="mrd-subjects-toolbar">
      <div class="mrd-subjects-tabs">
        <button
          v-for="t in SUBJECT_TYPES"
          :key="t"
          class="mrd-type-tab"
          :class="{ active: activeTab === t }"
          @click="activeTab = t"
        >
          {{ SUBJECT_TYPE_LABELS[t] }}
          <i v-if="subjects.filter((s) => !isChildSubject(s) && s.type === t).length" class="mrd-type-count">
            {{ subjects.filter((s) => !isChildSubject(s) && s.type === t).length }}
          </i>
        </button>
      </div>
      <div class="mrd-subjects-actions">
        <span class="mrd-drop-hint">支持拖放图片 / 音频 / 视频到页面直接新建</span>
        <el-button type="primary" size="small" :icon="'Plus'" @click="addSubject">新增{{ SUBJECT_TYPE_LABELS[activeTab] }}</el-button>
      </div>
    </div>

    <div ref="listRef" class="mrd-subjects-list">
      <TransitionGroup name="mrd-fade">
        <SubjectCard
          v-for="subj in visibleOfTab"
          :key="subj.uid"
          :subject="subj"
          :subjects="subjects"
          :can-remove="true"
          @change="ws.markDirty()"
          @remove="onRemove"
        />
      </TransitionGroup>
      <el-empty v-if="!visibleOfTab.length" description="暂无主体，点击右上角新增或拖放文件" />
    </div>
  </div>
</template>

<style scoped>
.mrd-subjects {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  outline: none;
}
.mrd-subjects.drag-active {
  outline: 2px dashed #6c5ce7;
  outline-offset: -6px;
  border-radius: 12px;
  background: rgba(108, 92, 231, 0.04);
}
.mrd-subjects-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.mrd-subjects-tabs { display: flex; gap: 4px; background: #151821; border: 1px solid #262c3d; border-radius: 8px; padding: 3px; }
.mrd-type-tab {
  position: relative;
  border: none; background: none; cursor: pointer;
  color: #a9b1c3; font-size: 12.5px;
  padding: 5px 16px; border-radius: 6px;
  transition: all 0.15s ease;
}
.mrd-type-tab:hover { color: #edeff5; }
.mrd-type-tab.active { background: linear-gradient(135deg, #6c5ce7, #4d6bfe); color: #fff; }
.mrd-type-count {
  font-style: normal;
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  min-width: 14px;
  border-radius: 8px;
  font-size: 10.5px;
  background: rgba(255, 255, 255, 0.14);
}
.mrd-subjects-actions { display: flex; align-items: center; gap: 14px; }
.mrd-drop-hint { font-size: 11.5px; color: #6b7488; }
.mrd-subjects-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(500px, 100%), 1fr));
  gap: 10px;
  align-content: start;
  padding-right: 4px;
}
</style>
