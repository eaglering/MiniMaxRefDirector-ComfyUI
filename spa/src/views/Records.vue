<script setup>
// 视频生成记录页：生成 / 合并产物列表，多选后普通合并或无损合并
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  fetchRecords, deleteRecords, mergeVideos, mergeLatents, viewUrl, apiBase,
} from "../api/client.js";
import { formatTime, formatDuration } from "../utils/media.js";

const records = ref([{
  id: 1,
  kind: "generate",
  created_at: "2025-06-01T12:34:56+08:00",
  duration_frames: 120,
  fps: 30,
  width: 1920,
  height: 1080,
  video: "output/test.mp4",
  image_latent: "output/test.png",
  clip_audio: "output/test.wav",
  meta: {
    width: 1920,
    height: 1080,
  },
}, {
  id: 2,
  kind: "generate",
  created_at: "2025-06-01T12:34:56+08:00",
  duration_frames: 120,
  fps: 30,
  width: 1920,
  height: 1080,
  video: "output/test.mp4",
  image_latent: "output/test.png",
  clip_audio: "output/test.wav",
  meta: {
    width: 1920,
    height: 1080,
  },
}, {
  id: 3,
  kind: "generate",
  created_at: "2025-06-01T12:34:56+08:00",
  duration_frames: 120,
  fps: 30,
  width: 1920,
  height: 1080,
  video: "output/test.mp4",
  image_latent: "output/test.png",
  clip_audio: "output/test.wav",
  meta: {
    width: 1920,
    height: 1080,
  },
}]);
const loading = ref(false);
const selection = ref([]);
const merging = reactive({ active: false, kind: "" });
const preview = reactive({ visible: false, url: "", title: "" });

const KIND_LABELS = {
  generate: { label: "生成", type: "primary" },
  merge_video: { label: "合并", type: "warning" },
  merge_latent: { label: "无损合并", type: "success" },
};

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
// onMounted(reload);

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

function durationText(rec) {
  if (rec.duration_frames == null || !rec.fps) return "-";
  return formatDuration(rec.duration_frames, rec.fps);
}

function resolutionText(rec) {
  if (rec.width && rec.height) return `${rec.width}×${rec.height}`;
  const m = rec.meta || {};
  if (m.width && m.height) return `${m.width}×${m.height}`;
  return "-";
}

function canLossless(rec) {
  return !!rec.image_latent;
}

const selectionLossless = computed(() => selection.value.filter(canLossless));

function onSelectionChange(rows) {
  selection.value = rows;
}

function openPreview(rec) {
  const url = videoUrl(rec);
  if (!url) {
    ElMessage.warning("该记录没有视频文件");
    return;
  }
  preview.url = url;
  preview.title = `预览 · ${rec.kind} · ${formatTime(rec.created_at)}`;
  preview.visible = true;
}

async function onDelete() {
  if (!selection.value.length) return;
  try {
    await ElMessageBox.confirm(`确定删除 ${selection.value.length} 条记录（不删除视频文件本身）？`, "删除记录", {
      confirmButtonText: "删除", cancelButtonText: "取消", type: "warning",
    });
  } catch {
    return;
  }
  try {
    await deleteRecords(selection.value.map((r) => r.id));
    ElMessage.success("已删除");
    reload();
  } catch (e) {
    ElMessage.error(`删除失败：${e.message || e}`);
  }
}

// ---- 普通合并（像素域 concat） ----
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

// ---- 无损合并（latent 像素域交叉淡化） ----
async function onMergeLatents() {
  const mats = selectionLossless.value;
  if (mats.length < 2) {
    ElMessage.warning("无损合并需要至少 2 条含 latent 的记录（生成时连接了 clip_audio）");
    return;
  }
  merging.active = true;
  merging.kind = "merge_latent";
  try {
    const materials = mats.map((r) => ({
      src: videoUrl(r),
      imageLatent: r.image_latent,
      audioLatent: null,
      clipAudio: r.clip_audio || "",
      meta: r.meta || null,
    }));
    const res = await mergeLatents(materials, { fade_seconds: 1.0 });
    if (!res.success) throw new Error(res.error || "无损合并失败");
    ElMessage.success("无损合并完成，产物已加入记录与素材条");
    reload();
  } catch (e) {
    ElMessage.error(`无损合并失败：${e.message || e}`);
  } finally {
    merging.active = false;
  }
}
</script>

<template>
  <div class="mrd-records">
    <div class="mrd-records-toolbar">
      <div class="mrd-records-title">
        视频生成记录
        <span class="mrd-records-count">{{ records.length }} 条</span>
      </div>
      <div class="mrd-records-actions">
        <el-button size="small" :icon="'Refresh'" :loading="loading" @click="reload">刷新</el-button>
        <el-button size="small" type="danger" plain :disabled="!selection.length" @click="onDelete">
          删除所选
        </el-button>
      </div>
    </div>

    <el-table
      :data="records"
      v-loading="loading"
      class="mrd-records-table"
      height="100%"
      @selection-change="onSelectionChange"
      empty-text="暂无记录：生成或合并完成后自动登记"
    >
      <el-table-column type="selection" width="44" />
      <el-table-column label="预览" width="130">
        <template #default="{ row }">
          <div class="mrd-rec-thumb" @click="openPreview(row)">
            <video v-if="videoUrl(row)" :src="videoUrl(row)" muted preload="metadata" />
            <el-icon v-else class="mrd-rec-nothumb"><component :is="'VideoCameraFilled'" /></el-icon>
            <span class="mrd-rec-play"><el-icon><component :is="'VideoPlay'" /></el-icon></span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="KIND_LABELS[row.kind]?.type || 'info'" effect="dark">
            {{ KIND_LABELS[row.kind]?.label || row.kind }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时间" width="160">
        <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="时长" width="90">
        <template #default="{ row }">{{ durationText(row) }}</template>
      </el-table-column>
      <el-table-column label="分辨率" width="110">
        <template #default="{ row }">{{ resolutionText(row) }}</template>
      </el-table-column>
      <el-table-column label="无损素材" width="90">
        <template #default="{ row }">
          <el-tag v-if="canLossless(row)" size="small" type="success" effect="plain">latent ✓</el-tag>
          <el-tag v-else size="small" type="info" effect="plain">无</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="文件" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="mrd-rec-file">{{ typeof row.video === "object" ? `${row.video.subfolder || ""}/${row.video.filename}` : row.video || "-" }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="openPreview(row)">预览</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 底部悬浮操作栏 -->
    <Transition name="mrd-fade">
      <div v-if="selection.length" class="mrd-records-floatbar">
        <span class="mrd-floatbar-info">
          已选 {{ selection.length }} 条
          <template v-if="selectionLossless.length">（含 latent {{ selectionLossless.length }} 条）</template>
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
          @click="onMergeLatents"
        >无损合并</el-button>
      </div>
    </Transition>

    <!-- 预览弹窗 -->
    <el-dialog v-model="preview.visible" :title="preview.title" width="760px" append-to-body destroy-on-close>
      <video v-if="preview.url" :src="preview.url" controls autoplay class="mrd-preview-video" />
    </el-dialog>
  </div>
</template>

<style scoped>
.mrd-records { height: 100%; display: flex; flex-direction: column; gap: 12px; position: relative; }
.mrd-records-toolbar { display: flex; align-items: center; justify-content: space-between; flex: none; }
.mrd-records-title { font-size: 14px; font-weight: 600; color: #edeff5; display: flex; align-items: center; gap: 8px; }
.mrd-records-count { font-size: 12px; font-weight: 400; color: #6b7488; }
.mrd-records-actions { display: flex; gap: 8px; }
.mrd-records-table { flex: 1; min-height: 0; background-color: #10131b; }
.mrd-rec-thumb {
  position: relative; width: 110px; height: 62px;
  border-radius: 6px; overflow: hidden;
  background: #10131b; border: 1px solid #262c3d;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.mrd-rec-thumb video { width: 100%; height: 100%; object-fit: cover; }
.mrd-rec-nothumb { color: #3d4459; font-size: 22px; }
.mrd-rec-play {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.35); opacity: 0;
  color: #fff; font-size: 22px; transition: opacity 0.15s ease;
}
.mrd-rec-thumb:hover .mrd-rec-play { opacity: 1; }
.mrd-rec-file { font-size: 11.5px; color: #a9b1c3; }
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
.mrd-floatbar-info { font-size: 12.5px; color: #a9b1c3; }
.mrd-preview-video { width: 100%; max-height: 60vh; border-radius: 8px; background: #000; }
</style>
