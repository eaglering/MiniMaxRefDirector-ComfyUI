<script setup>
// 主体编辑卡：与 js/subject.js 的主体卡功能对等
// （媒体上传 / 关系 / 描述@提及 / 保持度 / 引用子主体上传条 / 级联删除）
import { computed, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  REF_TYPE_RELATIONSHIPS, REF_TYPE_MEDIA, REF_MENTION_TYPES, REF_UPLOAD_CHILD_ACCEPT_TYPES, 
  REF_UPLOAD_CHILD_TYPES, REF_CHILD_CAP, SUBJECT_TYPE_LABELS,
  refDefaultRelationship, nextChildName, isChildSubject,
} from "../../constants/subject.js";
import { uploadImage, uploadAudio, uploadVideo, viewUrl } from "../../api/client.js";
import PromptEditor from "../common/PromptEditor.vue";
import { el } from "element-plus/es/locale/index.mjs";
import { Picture, VideoCameraFilled, Microphone } from "@element-plus/icons-vue";

const props = defineProps({
  subject: { type: Object, required: true },
  subjects: { type: Array, required: true }, // 全部主体（含子主体），供提及与子主体管理
  canRemove: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
  border: { type: Boolean, default: true },
});
const emit = defineEmits(["change", "remove"]);

const uploading = ref(false);
const uploadRef = ref(null); // el-upload 实例（失败项清除用）
const audioEl = ref(null);
const playing = ref(false);
const dialogVisible = ref(false);
const dialogFile = ref({});

const relationships = computed(() => REF_TYPE_RELATIONSHIPS[props.subject.type] || []);
const media = computed(() => REF_TYPE_MEDIA[props.subject.type] || {});
const mentionTypes = computed(() => REF_MENTION_TYPES[props.subject.type] || []);
const childTypes = computed(() => REF_UPLOAD_CHILD_TYPES[props.subject.type] || []);
const childAcceptTypes = computed(() => REF_UPLOAD_CHILD_ACCEPT_TYPES[props.subject.type] || []);
const children = computed(() =>
  props.subjects.filter((s) => isChildSubject(s) && s.ownerUid === props.subject.uid)
);
const nameMissing = computed(() => !(props.subject.name || "").trim());
const descVisible = computed(() => (props.subject.relationship || "") !== "");
// Subject 卡：普通引用资源条过滤掉 Audio（音频走「参考音频」独立行）
const barChildTypes = computed(() =>
  props.subject.type === "Subject" ? childTypes.value.filter((t) => t !== "Audio") : childTypes.value
);
const audioRefSubject = computed(() =>
  props.subject.type === "Subject"
    ? children.value.find((c) => c.type === "Audio")
    : null
);

function changed() {
  emit("change");
}

function childrenOfType(type) {
  return children.value.filter((c) => c.type === type);
}

function childCapLeft(type) {
  return childrenOfType(type).length < (REF_CHILD_CAP[type] ?? 9);
}

// ---- 主媒体上传 / 移除 ----
async function onPickMainMedia() {
  const kind = props.subject.type === "Picture" ? "image" : props.subject.type === "Audio" ? "audio" : "video";
  const accept = kind === "image" ? "image/*" : kind === "audio" ? "audio/*" : "video/*";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    uploading.value = true;
    try {
      if (kind === "image") {
        const r = await uploadImage(file);
        props.subject.imageFile = `${r.subfolder || "minimaxrefdirector"}/${r.name}`;
        props.subject.imageB64 = "";
      } else if (kind === "audio") {
        const r = await uploadAudio(file);
        props.subject.audioFile = r.name || r.path || "";
        props.subject.audioB64 = "";
      } else {
        const r = await uploadVideo(file);
        props.subject.videoFile = `${r.subfolder || "minimaxrefdirector"}/${r.name}`;
        props.subject.videoB64 = "";
      }
      changed();
    } catch (e) {
      ElMessage.error(`上传失败：${e.message || e}`);
    } finally {
      uploading.value = false;
    }
  };
  input.click();
}

function clearMainMedia() {
  if (props.subject.type === "Picture") {
    props.subject.imageFile = "";
    props.subject.imageB64 = "";
  } else if (props.subject.type === "Audio") {
    props.subject.audioFile = "";
    props.subject.audioB64 = "";
    stopAudio();
  } else if (props.subject.type === "Video") {
    props.subject.videoFile = "";
    props.subject.videoB64 = "";
  }
  changed();
}

function toggleAudio() {
  const el = audioEl.value;
  if (!el) return;
  if (playing.value) {
    el.pause();
  } else {
    el.play().catch(() => ElMessage.warning("音频播放失败"));
  }
}

function stopAudio() {
  playing.value = false;
  if (audioEl.value) audioEl.value.pause();
}

// ---- 参考音频播放（Subject 卡）----
const refAudioEl = ref(null);
const refPlaying = ref(false);
function toggleRefAudio() {
  const el = refAudioEl.value;
  if (!el) return;
  if (refPlaying.value) el.pause();
  else el.play().catch(() => ElMessage.warning("音频播放失败"));
}
function stopRefAudio() {
  refPlaying.value = false;
  if (refAudioEl.value) refAudioEl.value.pause();
}

// ---- 引用子主体上传条 ----
function pickChild(type) {
  const accept = type === "Picture" ? "image/*" : type === "Video" ? "video/*" : "audio/*";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    uploading.value = true;
    try {
      let fileKey = "";
      if (type === "Picture") {
        const r = await uploadImage(file);
        fileKey = `${r.subfolder || "minimaxrefdirector"}/${r.name}`;
      } else if (type === "Video") {
        const r = await uploadVideo(file);
        fileKey = `${r.subfolder || "minimaxrefdirector"}/${r.name}`;
      } else {
        const r = await uploadAudio(file);
        fileKey = r.name || r.path || "";
      }
      const child = {
        name: nextChildName(props.subjects, type),
        description: "",
        type,
        relationship: "",
        imageFile: type === "Picture" ? fileKey : "",
        imageB64: "",
        audioFile: type === "Audio" ? fileKey : "",
        audioB64: "",
        videoFile: type === "Video" ? fileKey : "",
        videoB64: "",
        audioRef: "",
        retention: "",
        uid: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        ownerUid: props.subject.uid,
      };
      props.subjects.push(child);
      // Subject 父卡上传音频子主体 → 回写 audioRef
      if (type === "Audio" && props.subject.type === "Subject") {
        props.subject.audioRef = child.name;
      }
      changed();
    } catch (e) {
      ElMessage.error(`上传失败：${e.message || e}`);
    } finally {
      uploading.value = false;
    }
  };
  input.click();
}

function removeChild(child) {
  if (child === audioRefSubject.value) stopRefAudio();
  const idx = props.subjects.indexOf(child);
  if (idx >= 0) props.subjects.splice(idx, 1);
  if (props.subject.audioRef === child.name) props.subject.audioRef = "";
  changed();
}

// 点击子主体缩略图 → 在描述光标处插入 <@名>（childMentionInto 语义）
function insertChildMention(child) {
  // relationship 为空（纯引用卡）时先恢复默认关系，使描述行可见
  if (!(props.subject.relationship || "").trim()) {
    props.subject.relationship = refDefaultRelationship(props.subject.type);
  }
  const tag = `<@${(child.name || "").trim()}>`;
  props.subject.description = (props.subject.description || "") + tag;
  changed();
}

function childMediaUrl(child) {
  if (child.type === "Picture") return child.imageFile ? viewUrl(child.imageFile) : "";
  if (child.type === "Video") return child.videoFile ? viewUrl(child.videoFile) : "";
  return child.audioFile ? viewUrl(child.audioFile) : "";
}

// ---- el-upload file-list：引用资源列表（Subject 卡的 Audio 走「参考音频」独立行）----
const barChildren = computed(() =>
  children.value.filter((c) => c.type !== "Audio" || props.subject.type !== "Subject")
);
const childFileList = computed(() =>
  barChildren.value.map((c) => {
    const file = c.imageFile || c.videoFile || c.audioFile || "";
    return {
      name: c.name,
      filename: file ? file.split("/").pop() : "",
      uid: c.uid,
      type: c.type,
      url: childMediaUrl(c) || undefined,
      status: "success",
    };
  })
);

function mimeToChildType(file) {
  const t = String(file.type || "");
  if (t.startsWith("image/")) return "Picture";
  if (t.startsWith("video/")) return "Video";
  if (t.startsWith("audio/")) return "Audio";
  return "";
}

// el-upload 自定义上传：按 mime 判定子主体类型并上传（不再需要按类型的上传按钮）
async function uploadChildFile(option) {
  const file = option.file;
  const type = mimeToChildType(file);
  if (!type || !barChildTypes.value.includes(type)) {
    rejectChildUpload(option, "该主体类型不支持此文件类型");
    return;
  }
  if (!childCapLeft(type)) {
    rejectChildUpload(option, `${SUBJECT_TYPE_LABELS[type]} 数量已达上限（${REF_CHILD_CAP[type] ?? 9}）`);
    return;
  }
  uploading.value = true;
  try {
    let fileKey = "";
    if (type === "Picture") {
      const r = await uploadImage(file);
      fileKey = `${r.subfolder || "minimaxrefdirector"}/${r.name}`;
    } else if (type === "Video") {
      const r = await uploadVideo(file);
      fileKey = `${r.subfolder || "minimaxrefdirector"}/${r.name}`;
    } else {
      const r = await uploadAudio(file);
      fileKey = r.name || r.path || "";
    }
    const child = {
      name: nextChildName(props.subjects, type),
      description: "",
      type,
      relationship: "",
      imageFile: type === "Picture" ? fileKey : "",
      imageB64: "",
      audioFile: type === "Audio" ? fileKey : "",
      audioB64: "",
      videoFile: type === "Video" ? fileKey : "",
      videoB64: "",
      audioRef: "",
      retention: "",
      uid: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      ownerUid: props.subject.uid,
    };
    props.subjects.push(child);
    // Subject 父卡上传音频子主体 → 回写 audioRef
    if (type === "Audio" && props.subject.type === "Subject") {
      props.subject.audioRef = child.name;
    }
    option.onSuccess?.(child);
    changed();
  } catch (e) {
    // 错误提示与失败项清理统一交给 on-error 钩子，避免重复弹窗
    option.onError?.(e);
  } finally {
    uploading.value = false;
  }
}

// el-upload on-remove：按 uid 找到子主体并级联删除
function onChildRemove(file) {
  const child = children.value.find((c) => c.uid === file.uid);
  if (child) removeChild(child);
}

// el-upload on-error：上传失败自动移除失败项（否则 children 未变 → file-list prop 不刷新，失败卡残留）
function onChildError(err, file) {
  if (file) uploadRef.value?.handleRemove?.(file);
  ElMessage.error(`上传失败：${err?.message || err}`);
}

// 类型不符/超上限等前置校验失败：同步移除内部 uploading 项（未走 onError 的分支）
function rejectChildUpload(option, message) {
  ElMessage.warning(message);
  if (option?.file) uploadRef.value?.handleRemove?.(option.file);
}

// el-upload on-preview：点击卡片在描述中插入 <@名> 提及
function onChildClick(file) {
  const child = children.value.find((c) => c.uid === file.uid);
  if (child) insertChildMention(child);
}

function onChildPreview(file) {
  dialogFile.value = file;
  dialogVisible.value = true;
}

function removeSelf() {
  emit("remove", props.subject);
}
</script>

<template>
  <div class="mrd-subj-card" :class="{ compact, 'mrd-card': border }">
    <div class="mrd-subj-row">
      <div class="mrd-subj-col">
        <label class="mrd-subj-label">名称</label>
        <el-input
          v-model="subject.name"
          class="mrd-subj-input"
          :class="{ 'name-missing': nameMissing }"
          maxlength="128"
          size="small"
          placeholder="主体名称（用于 @ 引用）"
          @input="changed"
        >
          <template #suffix>
            <el-button
              v-if="canRemove"
              size="small"
              type="danger"
              text
              title="删除该主体（级联删除其引用资源）"
              @click="removeSelf"
            >删除主体</el-button>
          </template>
        </el-input>
      </div>
      <div class="mrd-subj-col">
        <label class="mrd-subj-label">关系</label>
        <el-select
          v-model="subject.relationship"
          class="mrd-subj-input"
          size="small"
          @change="changed"
        >
          <el-option v-for="r in relationships" :key="r.value" :value="r.value" :title="r.desc">
            {{ r.label }}
          </el-option>
        </el-select>
      </div>
    </div>

    <!-- 主媒体位 -->
    <div v-if="media.image || media.audio || media.video" class="mrd-subj-row">
      <label class="mrd-subj-label">
        {{ media.image ? "参考图" : media.audio ? "音频" : "视频" }}
      </label>
      <div class="mrd-subj-media">
        <template v-if="media.image">
          <div v-if="subject.imageFile || subject.imageB64" class="mrd-subj-thumb">
            <img :src="subject.imageB64 || viewUrl(subject.imageFile)" alt="" @click="onPickMainMedia" />
            <div class="mrd-subj-thumb-ops">
              <el-button size="small" text @click="onPickMainMedia">更换</el-button>
              <el-button size="small" text type="danger" @click="clearMainMedia">移除</el-button>
            </div>
          </div>
          <el-button v-else size="small" :loading="uploading" @click="onPickMainMedia">上传图片</el-button>
        </template>
        <template v-else-if="media.audio">
          <div v-if="subject.audioFile || subject.audioB64" class="mrd-subj-audio">
            <el-button size="small" circle @click="toggleAudio">
              <el-icon><component :is="playing ? 'VideoPause' : 'VideoPlay'" /></el-icon>
            </el-button>
            <span class="mrd-subj-file">{{ subject.audioFile || "audio" }}</span>
            <el-button size="small" text @click="onPickMainMedia">更换</el-button>
            <el-button size="small" text type="danger" @click="clearMainMedia">移除</el-button>
            <audio ref="audioEl" :src="subject.audioB64 || viewUrl(subject.audioFile)" @ended="playing = false" @pause="playing = false" @play="playing = true" hidden />
          </div>
          <el-button v-else size="small" :loading="uploading" @click="onPickMainMedia">上传音频</el-button>
        </template>
        <template v-else>
          <div v-if="subject.videoFile || subject.videoB64" class="mrd-subj-thumb video">
            <video :src="subject.videoB64 || viewUrl(subject.videoFile)" controls muted preload="metadata" />
            <div class="mrd-subj-thumb-ops">
              <el-button size="small" text @click="onPickMainMedia">更换</el-button>
              <el-button size="small" text type="danger" @click="clearMainMedia">移除</el-button>
            </div>
          </div>
          <el-button v-else size="small" :loading="uploading" @click="onPickMainMedia">上传视频</el-button>
        </template>
      </div>
    </div>

    <!-- Subject 参考音频行（上传后点击按钮播放/暂停） -->
    <div v-if="subject.type === 'Subject'" class="mrd-subj-row">
      <label class="mrd-subj-label">参考音频</label>
      <div class="mrd-subj-media">
        <template v-if="audioRefSubject">
          <el-button size="small" circle @click="toggleRefAudio" :title="refPlaying ? '暂停播放' : '播放参考音频'">
            <el-icon><component :is="refPlaying ? 'VideoPause' : 'VideoPlay'" /></el-icon>
          </el-button>
          <span class="mrd-subj-file">{{ audioRefSubject.name }}<template v-if="audioRefSubject.audioFile"> · {{ audioRefSubject.audioFile.split("/").pop() }}</template></span>
          <el-button size="small" text type="danger" @click="removeChild(audioRefSubject)">移除</el-button>
          <audio
            ref="refAudioEl"
            :src="childMediaUrl(audioRefSubject)"
            @ended="refPlaying = false"
            @pause="refPlaying = false"
            @play="refPlaying = true"
            hidden
          />
        </template>
        <el-button v-else size="small" :loading="uploading" @click="pickChild('Audio')">上传参考音频</el-button>
      </div>
    </div>

    <!-- 描述（@ 仅引用本主体的引用资源；# 不触发引用） -->
    <div v-if="descVisible" class="mrd-subj-row">
      <label class="mrd-subj-label">描述</label>
      <PromptEditor
        style="height:106px"
        :model-value="subject.description"
        :min-height="compact ? 48 : 92"
        placeholder="主体外观 / 身份定义；输入 @ 可引用本主体的引用资源（图片 / 视频等）"
        :candidates="children"
        :allowed-types="mentionTypes"
        :exclude-uid="subject.uid"
        :allow-hash="false"
        fill
        @update:model-value="v => { subject.description = v; changed(); }"
      />
    </div>

    <!-- 保持度（@ 引用任意主体；# 不触发引用） -->
    <div v-if="descVisible" class="mrd-subj-row">
      <label class="mrd-subj-label">保持度</label>
      <PromptEditor
        style="height:60px"
        :model-value="subject.retention"
        :min-height="compact ? 44 : 56"
        placeholder="需要跨分镜保持的具体特征，如 the young man's short wavy brown hair...；输入 @ 可引用主体"
        :candidates="subjects"
        :allowed-types="mentionTypes"
        :exclude-uid="subject.uid"
        :allow-hash="false"
        fill
        @update:model-value="v => { subject.retention = v; changed(); }"
      />
    </div>

    <!-- 引用资源上传条（el-upload file-list：上传 / 列表展示 / 移除；点击卡片插入 <@名>） -->
    <div v-if="barChildTypes.length" class="mrd-subj-row">
      <label class="mrd-subj-label">引用资源</label>
      <div class="mrd-subj-children">
        <el-upload
          ref="uploadRef"
          class="mrd-subj-uploader"
          list-type="picture-card"
          :accept="childAcceptTypes.join(',')"
          multiple
          :limit="6"
          :file-list="childFileList"
          :http-request="uploadChildFile"
          :on-error="onChildError"
        >
          <el-icon><Plus /></el-icon>
          <template #file="{ file }">
            <div @click="onChildClick(file)" style="width:100%">
              <img v-if="file.type=='Picture'" class="el-upload-list__item-thumbnail" :src="file.url" alt="" />
              <video
                v-if="file.type=='Video'"
                class="el-upload-list__item-thumbnail"
                :src="file.url"
              />
              <div v-if="file.type=='Audio'" class="el-upload-list__item-audio">
                <el-icon size="12"><Headset /></el-icon>
              </div>
              <div class="el-upload-list__item-title">{{ file.name }}</div>
              <div class="el-upload-list__item-type">
                <template v-if="file.type=='Video'">
                  <el-icon size="12"><VideoCamera /></el-icon>
                </template>
              </div>
              <span class="el-upload-list__item-actions">
                <span
                  class="el-upload-list__item-preview"
                  @click.stop="onChildPreview(file)"
                >
                  <el-icon size="16"><zoom-in /></el-icon>
                </span>
                <span
                  class="el-upload-list__item-delete"
                  @click.stop="onChildRemove(file)"
                >
                  <el-icon size="16"><Delete /></el-icon>
                </span>
              </span>
            </div>
          </template>
        </el-upload>
      </div>
    </div>
    <el-dialog v-model="dialogVisible">
      <template #header>
        <span>主体【{{ dialogFile.name }}】 · {{ dialogFile.filename }}</span>  
      </template>
      <div class="mrd-dialog-content">
        <img v-if="dialogFile.type=='Picture'" w-full :src="dialogFile.url" alt="Preview" />
        <video v-if="dialogFile.type=='Video' || dialogFile.type=='Audio'" w-full :src="dialogFile.url" alt="Preview" controls />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.mrd-subj-card { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.mrd-subj-card.compact { padding: 10px 12px; gap: 8px; }
.mrd-subj-badge {
  flex: none;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: #262c3d;
  color: #a9b1c3;
  border: 1px solid #313a52;
}
.mrd-subj-badge[data-type="Subject"] { color: #a78bfa; border-color: #4a3f8f; }
.mrd-subj-badge[data-type="Picture"] { color: #38bdf8; border-color: #1e4e66; }
.mrd-subj-badge[data-type="Video"] { color: #f5b544; border-color: #6b501d; }
.mrd-subj-badge[data-type="Audio"] { color: #22c55e; border-color: #1e5c37; }
.mrd-subj-input :deep(.el-input__wrapper), .mrd-subj-input :deep(.el-select__wrapper) {
  background: #151923;
}
.mrd-subj-input.name-missing :deep(.el-input__wrapper) { border: solid 1px #ef4444; }
.mrd-subj-row { display: flex; gap: 10px; align-items: flex-start; }
.mrd-subj-row :deep(.mrd-cm-host) { flex: 1; min-width: 0; }
.mrd-subj-col { flex: 1; display: flex; gap: 10px; }
.mrd-subj-label {
  flex: none;
  width: 58px;
  padding-top: 6px;
  font-size: 12px;
  color: #6b7488;
  text-align: right;
}
.mrd-subj-select {
  flex: 1;
  background: #151923;
  color: #edeff5;
  border: 1px solid #2a3042;
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 12.5px;
  outline: none;
}
.mrd-subj-media { flex: 1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 30px; }
.mrd-subj-file { font-size: 12px; color: #a9b1c3; word-break: break-all; }
.mrd-subj-thumb { position: relative; width: 120px; }
.mrd-subj-thumb img, .mrd-subj-thumb video { width: 120px; height: 84px; object-fit: cover; border-radius: 6px; border: 1px solid #2a3042; display: block; cursor: pointer; }
.mrd-subj-thumb-ops { display: flex; justify-content: center; gap: 2px; margin-top: 2px; }
.mrd-subj-audio { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.mrd-subj-children { flex: 1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* el-upload 引用资源卡（深色适配） */
.mrd-subj-uploader :deep(.el-upload--picture-card) {
  background: #151923;
  border: 1px dashed #2a3042;
  width: 64px;
  height: 64px;
  border-radius: 6px;
}
.mrd-subj-uploader :deep(.el-upload--picture-card:hover) { border-color: #6c5ce7; }
.mrd-subj-uploader :deep(.el-upload-list--picture-card .el-upload-list__item) {
  background: #151923;
  border: 1px solid #2a3042;
  border-radius: 6px;
  width: 64px;
  height: 64px;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.mrd-subj-uploader :deep(.el-upload-list--picture-card .el-upload-list__item:hover) { border-color: #6c5ce7; }
.mrd-subj-uploader :deep(.el-upload-list--picture-card .el-upload-list__item-type) {
  position: absolute;
  top: 0;
  left: 2px;
  color: rgba(255, 255, 255, 0.65);
}
.mrd-subj-uploader :deep(.el-upload-list--picture-card .el-upload-list__item-title) { 
  color: #fff;
  font-size: 10px;
  text-align: center;
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background-color: rgba(0, 0, 0, 0.25);
}
.mrd-subj-uploader :deep(.el-upload-list--picture-card .el-upload-list__item-audio) {
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: #1e4e66;
} 
.mrd-subj-uploader :deep(.el-upload-list__item-name) { display: none; }
.mrd-subj-child-thumbs { display: flex; gap: 8px; flex-wrap: wrap; }
.mrd-subj-child {
  position: relative;
  width: 64px; height: 64px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid #2a3042;
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.15s ease;
  background: #151923;
  display: flex; align-items: center; justify-content: center;
}
.mrd-subj-child:hover { border-color: #6c5ce7; transform: translateY(-2px); }
.mrd-subj-child img, .mrd-subj-child video { width: 100%; height: 100%; object-fit: cover; }
.mrd-subj-child-audio { font-size: 11px; color: #a9b1c3; padding: 4px; text-align: center; word-break: break-all; }
.mrd-subj-child-x {
  position: absolute; top: 2px; right: 2px;
  width: 18px; height: 18px;
  border: none; border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  color: #fff; font-size: 12px; line-height: 1;
  cursor: pointer; display: none;
}
.mrd-subj-child:hover .mrd-subj-child-x { display: block; }
.mrd-dialog-content { padding-top: 10px; }
.mrd-dialog-content img, .mrd-dialog-content video, .mrd-dialog-content audio { width: 100%; height: 100%; object-fit: contain; }
</style>
