<script setup>
// 视频生成记录页：卡片式展示生成 / 合并产物；点击卡片按点击顺序多选，
// 无损合并 / 视频合并按该顺序执行；支持拖拽或点击上传视频并登记为记录
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  fetchRecords, deleteRecords, mergeVideos, mergeLatents, mergeLatentsStatus,
  viewUrl, uploadRecordVideo, uploadAudio,
} from "../api/client.js";
import { formatTime, formatDuration } from "../utils/media.js";

const records = ref([]);
const loading = ref(false);
const selection = ref([]); // 按用户点击顺序排列的选中记录
const merging = reactive({ active: false, kind: "", elapsed: 0 });
const preview = reactive({ visible: false, url: "", title: "", isAudio: false });
const uploading = ref(false);
const dragging = ref(false);
const fileInput = ref(null);

const KIND_LABELS = {
  generate: { label: "生成", type: "primary" },
  merge_video: { label: "合并", type: "warning" },
  merge_latent: { label: "无损合并", type: "success" },
  upload: { label: "上传", type: "info" },
  master_audio: { label: "整轨音频", type: "danger" },
};

// 无损合并方式（参考旧导演台历史逻辑）：
// 方案一 = 接缝音频淡化（fade_seconds，秒）；方案二 = 自定义主音频整轨替代
// （custom_audio，上传后整轨裁剪/补静音，无段间接缝，fade 不适用）
const mergeDlg = reactive({
  visible: false, mode: "fade", fadeSeconds: 1.0,
  audioName: "", audioFileName: "", audioUploading: false,
});
const mergeAudioInput = ref(null);

const _VIDEO_EXTS = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;

async function reload() {
  loading.value = true;
  try {
    const res = await fetchRecords(300);
    if (res.success) records.value = res.records || [];
    else ElMessage.error(res.error || "记录加载失败");
  } catch (e) {
    ElMessage.error(`记录加载失败：${e.message || e}`);
  } finally {
    loading.value = false;
  }
}
onMounted(reload);

// ---- 音频记录（master_audio 整轨）----
function isAudio(rec) {
  return rec.kind === "master_audio" || !!rec.audio;
}

function audioUrl(rec) {
  const a = rec.audio;
  if (!a) return "";
  if (typeof a === "object") return viewUrl(a.filename, a.subfolder || "", a.type || "input");
  const slash = a.lastIndexOf("/");
  if (slash >= 0) return viewUrl(a.slice(slash + 1), a.slice(0, slash), "input");
  return viewUrl(a, "", "input");
}

// 记录的视频预览地址：dict（{filename,subfolder,type}）或字符串（output 相对路径）
function videoUrl(rec) {
  const v = rec.video;
  if (!v) return "";
  if (typeof v === "object") return viewUrl(v.filename, v.subfolder || "", v.type || "input");
  const slash = v.lastIndexOf("/");
  if (slash >= 0) {
    return viewUrl(v.slice(slash + 1), v.slice(0, slash), "output");
  }
  return viewUrl(v, "", "output");
}

function fileLabel(rec) {
  const v = isAudio(rec) ? rec.audio : rec.video;
  if (typeof v === "object") return `${v.subfolder || ""}/${v.filename}`;
  return v || "-";
}

function durationText(rec) {
  if (isAudio(rec)) {
    const s = Number(rec.meta?.duration_s || 0);
    if (!s) return "-";
    return formatDuration(Math.round(s * (rec.meta?.sample_rate || 32000)), rec.meta?.sample_rate || 32000);
  }
  if (rec.duration_frames == null || !rec.fps) return "-";
  return formatDuration(rec.duration_frames, rec.fps);
}

function resolutionText(rec) {
  if (isAudio(rec)) {
    const sr = rec.meta?.sample_rate;
    return sr ? `${sr >= 1000 ? `${(sr / 1000).toFixed(sr % 1000 ? 1 : 0)}kHz` : `${sr}Hz`} 音频` : "音频";
  }
  if (rec.width && rec.height) return `${rec.width}×${rec.height}`;
  const m = rec.meta || {};
  if (m.width && m.height) return `${m.width}×${m.height}`;
  return "-";
}

function canLossless(rec) {
  return !!rec.image_latent;
}

const selectionLossless = computed(() => selection.value.filter(canLossless));

// ---- 顺序多选：点击卡片切换选中，selection 保持点击顺序 ----
function isSelected(rec) {
  return selection.value.some((r) => r.id === rec.id);
}

function orderIndex(rec) {
  return selection.value.findIndex((r) => r.id === rec.id) + 1;
}

function toggleSelect(rec) {
  const idx = selection.value.findIndex((r) => r.id === rec.id);
  if (idx >= 0) selection.value.splice(idx, 1);
  else selection.value.push(rec);
}

function clearSelection() {
  selection.value = [];
}

function openPreview(rec) {
  const url = isAudio(rec) ? audioUrl(rec) : videoUrl(rec);
  if (!url) {
    ElMessage.warning(isAudio(rec) ? "该记录没有音频文件" : "该记录没有视频文件");
    return;
  }
  preview.url = url;
  preview.isAudio = isAudio(rec);
  preview.title = `预览 · ${KIND_LABELS[rec.kind]?.label || rec.kind} · ${formatTime(rec.created_at)}`;
  preview.visible = true;
}

// ---- 拖拽 / 手动上传视频 ----
function triggerUpload() {
  fileInput.value?.click();
}

function onFileChosen(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  uploadFiles(files);
}

function onDragEnter(e) {
  e.preventDefault();
  dragging.value = true;
}

function onDragOver(e) {
  e.preventDefault();
}

function onDragLeave(e) {
  e.preventDefault();
  if (e.currentTarget === e.target) dragging.value = false;
}

function onDrop(e) {
  e.preventDefault();
  dragging.value = false;
  const files = Array.from(e.dataTransfer?.files || []).filter((f) => _VIDEO_EXTS.test(f.name));
  if (!files.length) {
    ElMessage.warning("请拖入视频文件（mp4/mov/mkv/webm/avi/m4v）");
    return;
  }
  uploadFiles(files);
}

async function uploadFiles(files) {
  uploading.value = true;
  let ok = 0;
  const errors = [];
  try {
    for (const f of files) {
      try {
        await uploadRecordVideo(f);
        ok += 1;
      } catch (e) {
        errors.push(`${f.name}：${e.message || e}`);
      }
    }
    if (ok) {
      ElMessage.success(`已上传 ${ok} 个视频并登记为记录`);
      await reload();
    }
    if (errors.length) ElMessage.error(errors.join("\n"));
  } finally {
    uploading.value = false;
  }
}

async function onDelete() {
  if (!selection.value.length) return;
  const losslessCount = selection.value.filter((r) => r.image_latent || r.clip_audio).length;
  const fileNote = losslessCount
    ? `其中 ${losslessCount} 条含无损素材，关联的 latent / wav / meta 中间文件将一并删除`
    : "无关联无损素材文件";
  try {
    await ElMessageBox.confirm(
      `确定删除 ${selection.value.length} 条记录？${fileNote}；生成视频文件保留（与旧导演台素材删除语义一致）。`,
      "删除记录",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await deleteRecords(selection.value.map((r) => r.id), true);
    ElMessage.success("已删除");
    clearSelection();
    reload();
  } catch (e) {
    ElMessage.error(`删除失败：${e.message || e}`);
  }
}

// ---- 普通合并（像素域 concat）：按点击顺序 ----
async function onMergeVideos() {
  if (selection.value.length < 2) {
    ElMessage.warning("请至少选择 2 条记录");
    return;
  }
  merging.active = true;
  merging.kind = "merge_video";
  try {
    const paths = selection.value.map(videoUrl).filter(Boolean);
    const res = await mergeVideos(paths);
    if (!res.success) throw new Error(res.error || "合并失败");
    ElMessage.success("合并完成，产物已加入记录与素材条");
    reload();
  } catch (e) {
    ElMessage.error(`合并失败：${e.message || e}`);
  } finally {
    merging.active = false;
  }
}

// ---- 无损合并（latent 像素域交叉淡化）：按点击顺序 ----
// 后台任务模式：POST 立即返回 job_id，前端每 2s 轮询状态直到 done/error，
// 悬浮栏实时显示已耗时（VAE 解码 + ffmpeg 编码长视频需数分钟）。
function openMergeDlg() {
  if (selectionLossless.value.length < 2) {
    ElMessage.warning("无损合并需要至少 2 条含 latent 的记录（生成时连接了 clip_audio）");
    return;
  }
  mergeDlg.visible = true;
}

function triggerMergeAudio() {
  mergeAudioInput.value?.click();
}

async function onMergeAudioChosen(e) {
  const file = (e.target.files || [])[0];
  e.target.value = "";
  if (!file) return;
  mergeDlg.audioUploading = true;
  try {
    const res = await uploadAudio(file);
    if (!res.success || !res.name) throw new Error(res.error || "上传失败");
    mergeDlg.audioName = res.name; // "whatdreamscost/<filename>"（服务端按此解析）
    mergeDlg.audioFileName = file.name;
    ElMessage.success(`音频已上传：${file.name}`);
  } catch (err) {
    ElMessage.error(`音频上传失败：${err.message || err}`);
  } finally {
    mergeDlg.audioUploading = false;
  }
}

function confirmMergeLatents() {
  mergeDlg.visible = false;
  if (mergeDlg.mode === "custom") {
    if (!mergeDlg.audioName) {
      ElMessage.warning("请先上传自定义主音频");
      return;
    }
    doMergeLatents({ custom_audio: mergeDlg.audioName });
  } else {
    doMergeLatents({ fade_seconds: mergeDlg.fadeSeconds });
  }
}

async function doMergeLatents(opts = {}) {
  const mats = selectionLossless.value;
  if (mats.length < 2) {
    ElMessage.warning("无损合并需要至少 2 条含 latent 的记录（生成时连接了 clip_audio）");
    return;
  }
  merging.active = true;
  merging.kind = "merge_latent";
  merging.elapsed = 0;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    merging.elapsed = Math.round((Date.now() - startedAt) / 1000);
  }, 1000);
  try {
    ElMessage.info(
      `无损合并已启动（共 ${mats.length} 段，接缝顺序即卡片上的序号顺序）：VAE 解码 + ffmpeg 编码长视频可能需要数分钟，此处显示实时耗时`,
      { duration: 8000 },
    );
    const materials = mats.map((r) => ({
      src: videoUrl(r),
      imageLatent: r.image_latent,
      audioLatent: null,
      clipAudio: r.clip_audio || "",
      meta: r.meta || null,
    }));
    const res = await mergeLatents(materials, opts);
    if (!res.success || !res.job_id) throw new Error(res.error || "合并任务启动失败");
    // 轮询后台任务（刷新页面后重新点合并会另起新任务，旧任务由服务端自行完成）
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await mergeLatentsStatus(res.job_id);
      if (!st.success) throw new Error(st.error || "合并任务状态查询失败");
      const job = st.job || {};
      if (job.state === "error") throw new Error(job.error || "无损合并失败");
      if (job.state === "done") {
        ElMessage.success(
          `无损合并完成（耗时 ${Math.round(job.took || merging.elapsed)}s），产物已加入记录与素材条`,
        );
        break;
      }
    }
    reload();
  } catch (e) {
    ElMessage.error(`无损合并失败：${e.message || e}`);
  } finally {
    clearInterval(timer);
    merging.active = false;
  }
}

onUnmounted(() => {
  dragging.value = false;
});
</script>

<template>
  <div class="mrd-records">
    <div class="mrd-records-toolbar">
      <div class="mrd-records-title">
        视频生成记录
        <span class="mrd-records-count">{{ records.length }} 条</span>
      </div>
      <div class="mrd-records-actions">
        <el-button size="small" type="primary" plain :icon="'Upload'" :loading="uploading" @click="triggerUpload">
          上传视频
        </el-button>
        <el-button size="small" :icon="'Refresh'" :loading="loading" @click="reload">刷新</el-button>
        <el-button size="small" type="danger" plain :disabled="!selection.length" @click="onDelete">
          删除所选
        </el-button>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept=".mp4,.mov,.mkv,.webm,.avi,.m4v,video/*"
        multiple
        style="display: none"
        @change="onFileChosen"
      />
    </div>

    <div
      class="mrd-records-grid"
      :class="{ dropping: dragging }"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <div v-if="!records.length && !loading" class="mrd-records-empty">
        暂无记录：生成 / 合并完成后自动登记，也可以把视频拖到这里上传
      </div>
      <div v-for="rec in records" :key="rec.id" class="mrd-rec-card" :class="{ selected: isSelected(rec) }">
        <span v-if="isSelected(rec)" class="mrd-rec-order">{{ orderIndex(rec) }}</span>
        <span class="mrd-rec-check"><el-icon><component :is="'Check'" /></el-icon></span>
        <div class="mrd-rec-thumb" :class="{ 'mrd-rec-thumb-audio': isAudio(rec) }" @click.stop="openPreview(rec)">
          <video v-if="!isAudio(rec) && videoUrl(rec)" :src="videoUrl(rec)" muted preload="metadata" />
          <el-icon v-else-if="isAudio(rec)" class="mrd-rec-nothumb"><component :is="'Headset'" /></el-icon>
          <el-icon v-else class="mrd-rec-nothumb"><component :is="'VideoCameraFilled'" /></el-icon>
          <span class="mrd-rec-play"><el-icon><component :is="'VideoPlay'" /></el-icon></span>
        </div>
        <div class="mrd-rec-body" @click="toggleSelect(rec)">
          <div class="mrd-rec-row">
            <el-button v-if="canLossless(rec)" size="small" link type="success">
              无损
            </el-button>
            <span class="mrd-rec-time">{{ formatTime(rec.created_at) }}</span>
          </div>
          <div class="mrd-rec-sub">
            时长：{{ durationText(rec) }} · {{ resolutionText(rec) }}
          </div>
          <div class="mrd-rec-file" :title="fileLabel(rec)">{{ fileLabel(rec) }}</div>
        </div>
      </div>
      <Transition name="mrd-fade">
        <div v-if="dragging" class="mrd-drop-hint">松开鼠标上传视频并登记为记录</div>
      </Transition>
    </div>

    <!-- 底部悬浮操作栏：合并按卡片上的序号（点击顺序）执行 -->
    <Transition name="mrd-fade">
      <div v-if="selection.length" class="mrd-records-floatbar">
        <span class="mrd-floatbar-info">
          已选 {{ selection.length }} 条（按序号顺序合并）
          <template v-if="selectionLossless.length"> · 含 latent {{ selectionLossless.length }} 条</template>
          <el-button link size="small" type="info" @click="clearSelection">清空</el-button>
        </span>
        <span v-if="merging.active" class="mrd-floatbar-busy">
          {{ merging.kind === "merge_latent"
            ? `无损合并进行中…（已 ${merging.elapsed}s，完成后自动刷新）`
            : "合并视频进行中…" }}
        </span>
        <el-button
          size="small"
          :loading="merging.active && merging.kind === 'merge_video'"
          :disabled="merging.active"
          :icon="'Picture'"
          @click="onMergeVideos"
        >合并视频</el-button>
        <el-button
          size="small"
          type="success"
          :loading="merging.active && merging.kind === 'merge_latent'"
          :disabled="merging.active || selectionLossless.length < 2"
          :icon="'MagicStick'"
          @click="openMergeDlg"
        >无损合并</el-button>
      </div>
    </Transition>

    <!-- 无损合并方式选择（参考旧导演台：方案一 接缝淡化 / 方案二 自定义整轨） -->
    <el-dialog v-model="mergeDlg.visible" title="无损合并方式" width="460px" append-to-body>
      <el-radio-group v-model="mergeDlg.mode" class="mrd-merge-mode">
        <div class="mrd-merge-option">
          <el-radio value="fade">接缝音频淡化（秒）</el-radio>
          <el-input-number
            v-if="mergeDlg.mode === 'fade'"
            v-model="mergeDlg.fadeSeconds" :min="0" :max="10" :step="0.5" size="small"
          />
          <p class="mrd-merge-desc">片段音频在接缝处交叉淡化拼接（默认 1 秒；0 为硬拼接）</p>
        </div>
        <el-divider style="margin:10px 0;"/>
        <div class="mrd-merge-option">
          <el-radio value="custom">自定义主音频整轨替代</el-radio>
          <p class="mrd-merge-desc">上传的音频作为整条音轨（长于视频裁剪、短则补静音），所有片段原音轨被替换，无接缝淡化</p>
          <div v-if="mergeDlg.mode === 'custom'" class="mrd-merge-audio">
            <el-button size="small" :loading="mergeDlg.audioUploading" @click="triggerMergeAudio">
              {{ mergeDlg.audioName ? "重新上传" : "上传音频" }}
            </el-button>
            <input
              ref="mergeAudioInput"
              type="file"
              accept=".wav,.flac,.mp3,audio/*"
              style="display: none"
              @change="onMergeAudioChosen"
            />
            <span v-if="mergeDlg.audioFileName" class="mrd-merge-audio-name" :title="mergeDlg.audioFileName">
              {{ mergeDlg.audioFileName }}
            </span>
            <span v-else class="mrd-merge-audio-name mrd-merge-audio-none">未选择音频</span>
          </div>
        </div>
      </el-radio-group>
      <template #footer>
        <el-button size="small" @click="mergeDlg.visible = false">取消</el-button>
        <el-button size="small" type="success" :disabled="mergeDlg.audioUploading" @click="confirmMergeLatents">
          开始合并
        </el-button>
      </template>
    </el-dialog>

    <!-- 预览弹窗 -->
    <el-dialog v-model="preview.visible" :title="preview.title" width="760px" append-to-body destroy-on-close>
      <audio v-if="preview.isAudio && preview.url" :src="preview.url" controls autoplay class="mrd-preview-audio" />
      <video v-else-if="preview.url" :src="preview.url" controls autoplay class="mrd-preview-video" />
    </el-dialog>
  </div>
</template>

<style scoped>
.mrd-records { height: 100%; display: flex; flex-direction: column; gap: 12px; position: relative; }
.mrd-records-toolbar { display: flex; align-items: center; justify-content: space-between; flex: none; }
.mrd-records-title { font-size: 14px; font-weight: 600; color: #edeff5; display: flex; align-items: center; gap: 8px; }
.mrd-records-count { font-size: 12px; font-weight: 400; color: #6b7488; }
.mrd-records-actions { display: flex; gap: 8px; }

/* 卡片网格 */
.mrd-records-grid {
  flex: 1; min-height: 0; overflow-y: auto;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px;
  align-content: start; padding: 4px 4px 60px;
  border-radius: 10px; position: relative;
}
.mrd-records-grid.dropping { outline: 2px dashed #4f7cff; outline-offset: -4px; }
.mrd-records-empty {
  grid-column: 1 / -1; padding: 48px 0; text-align: center;
  color: #6b7488; font-size: 13px;
}
.mrd-drop-hint {
  position: absolute; inset: 0; z-index: 10;
  display: flex; align-items: center; justify-content: center;
  background: rgba(16, 19, 27, 0.72);
  color: #9db6ff; font-size: 15px; font-weight: 600;
  border-radius: 10px; pointer-events: none;
}
.mrd-rec-card {
  position: relative;
  background: #141824; border: 1px solid #262c3d; border-radius: 10px;
  overflow: hidden; cursor: pointer; user-select: none;
  transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}
.mrd-rec-card:hover { border-color: #3a456b; transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35); }
.mrd-rec-card.selected { border-color: #4f7cff; box-shadow: 0 0 0 1px #4f7cff inset; }
.mrd-rec-thumb {
  position: relative; width: 100%; aspect-ratio: 16 / 9;
  background: #10131b; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
}
.mrd-rec-thumb video { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.mrd-rec-nothumb { color: #3d4459; font-size: 30px; }
.mrd-rec-play {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.35); opacity: 0;
  color: #fff; font-size: 26px; transition: opacity 0.15s ease;
}
.mrd-rec-thumb:hover .mrd-rec-play { opacity: 1; }
.mrd-rec-order {
  position: absolute; top: 6px; left: 6px; z-index: 3;
  width: 20px; height: 20px; border-radius: 50%;
  background: #4f7cff; color: #fff;
  font-size: 12px; font-weight: 700; line-height: 20px; text-align: center;
}
.mrd-rec-check {
  position: absolute; top: 6px; right: 6px; z-index: 3;
  width: 20px; height: 20px; border-radius: 50%;
  background: #4f7cff; color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; opacity: 0; transition: opacity 0.15s ease;
}
.mrd-rec-card.selected .mrd-rec-check { opacity: 1; }
.mrd-rec-body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 5px; }
.mrd-rec-row { display: flex; align-items: center; gap: 8px; }
.mrd-rec-time { font-size: 11px; color: #a9b1c3; margin-left: auto; }
.mrd-rec-sub { font-size: 11px; color: #8a93a8; display: flex; align-items: center; gap: 6px; }
.mrd-rec-file { font-size: 11px; color: #6b7488; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.mrd-records-floatbar {
  position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 12px;
  background: rgba(28, 32, 43, 0.92);
  backdrop-filter: blur(8px);
  border: 1px solid #313a52;
  border-radius: 12px;
  padding: 10px 18px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  z-index: 20;
}
.mrd-floatbar-info { font-size: 12.5px; color: #a9b1c3; display: flex; align-items: center; gap: 6px; }
.mrd-floatbar-busy { font-size: 12.5px; color: #7ee2a8; }
.mrd-preview-video { width: 100%; max-height: 60vh; border-radius: 8px; background: #000; }
.mrd-preview-audio { width: 100%; margin-top: 24px; }
.mrd-rec-thumb-audio video { display: none; }
.mrd-merge-mode { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; width: 100%; }
.mrd-merge-option { display: flex; flex-direction: column; gap: 6px; }
.mrd-merge-desc { margin: 5px 0 0; font-size: 11px; color: #61646b; line-height: 1.4; }
.mrd-merge-audio { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
.mrd-merge-audio-name {
  font-size: 12px; color: #a9b1c3;
  max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mrd-merge-audio-none { color: #6b7488; }
.mrd-fade-enter-active, .mrd-fade-leave-active { transition: opacity 0.18s ease; }
.mrd-fade-enter-from, .mrd-fade-leave-to { opacity: 0; }
</style>
