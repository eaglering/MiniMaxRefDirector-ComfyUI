<script setup>
// 左栏音轨列表：上传音频 / 波形卡片 / 裁剪区间播放 / 时长展示（分:秒）/
// 右键菜单（切割·复制·多选·删除，交互与分镜 ShotList 一致）/
// 数据写入 ws.timeline.audioSegments，字段与历史节点音频轨道完全一致（时间均为帧）
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import { genId, framesToSeconds } from "../../utils/media.js";
import { uploadImage } from "../../api/client.js";
import {
  decodeFile, drawWaveform, formatMinSec,
  playSegment, slicePeaks, stopSegmentPlayback,
} from "../../utils/audio.js";
import AudioCutDialog from "./AudioCutDialog.vue";

const ws = useWorkspace();
const audioSegs = computed(() => ws.timeline.audioSegments);
const fps = computed(() => ws.widgets.frame_rate || 24);

const cutSecs = (seg) => framesToSeconds(seg.length, fps.value);
const totalSecs = (seg) => framesToSeconds(seg.audioDurationFrames, fps.value);

// 连续时间轴：重排所有 start（音轨顺序即时间顺序，无空隙）
function relayout() {
  let cursor = 0;
  for (const seg of audioSegs.value) {
    seg.start = cursor;
    cursor += seg.length;
  }
}

// ---- 上传音频 ----
const pickRef = ref(null);
const ACCEPT = "audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac";

function pickFiles() {
  pickRef.value?.click?.();
}

async function onPickFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  await handleFiles(files);
}

function isAudio(file) {
  return file.type.startsWith("audio/") ||
    /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(file.name || "");
}

async function handleFiles(files) {
  for (const file of files) {
    if (!isAudio(file)) {
      ElMessage.warning(`无法识别的音频文件：${file.name}`);
      continue;
    }
    try {
      // 本地解码：即时出波形与总帧（与历史节点客户端提取同算法）
      const { audioBuffer, peaks } = await decodeFile(file);
      const clipFrames = Math.max(1, Math.ceil(audioBuffer.duration * fps.value));
      const seg = {
        id: genId(),
        type: "audio",
        start: 0,
        length: clipFrames,
        trimStart: 0,
        audioDurationFrames: clipFrames,
        audioFile: "",
        fileName: file.name,
        waveformPeaks: peaks,
        fileSize: file.size,
        _uploading: true,
        _blobUrl: URL.createObjectURL(file),
      };
      audioSegs.value.push(seg);
      relayout();
      ws.markDirty();
      // 后台上传：回填 audioFile 文件 key（后端按此定位 input 中的文件）
      try {
        const up = await uploadImage(file, "minimaxrefdirector");
        seg.audioFile = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
      } catch (err) {
        console.error("[SPA] audio upload failed", err);
        ElMessage.error(`音频上传失败：${file.name}`);
      }
      seg._uploading = false;
      ws.markDirty();
    } catch (err) {
      console.error("[SPA] audio decode failed", err);
      ElMessage.error(`音频解码失败：${file.name}`);
    }
  }
}

// ---- 波形绘制（有效区间切片）----
const canvasEls = new Map();
function setCanvasRef(el, seg) {
  if (el) {
    canvasEls.set(seg.id, el);
    drawCardWave(seg);
  } else {
    canvasEls.delete(seg.id);
  }
}
function drawCardWave(seg) {
  const canvas = canvasEls.get(seg.id);
  if (!canvas) return;
  const peaks = slicePeaks(
    seg.waveformPeaks, seg.trimStart || 0, seg.length || 0, seg.audioDurationFrames || 0
  );
  drawWaveform(canvas, peaks);
}
// 项增删 / 切割回写 / 波形就绪后重绘
watch(
  () => audioSegs.value.map(
    (s) => `${s.id}:${s.trimStart}:${s.length}:${s.audioDurationFrames}:${(s.waveformPeaks || []).length}`
  ).join("|"),
  () => nextTick(() => audioSegs.value.forEach(drawCardWave))
);

// ---- 播放（裁剪区间；同时只播一项）----
const playingId = ref("");

async function togglePlay(seg) {
  if (playingId.value === seg.id) {
    stopSegmentPlayback();
    playingId.value = "";
    return;
  }
  playingId.value = seg.id;
  try {
    await playSegment(seg, fps.value);
  } catch (err) {
    console.error("[SPA] audio play failed", err);
    ElMessage.error(err?.message || "播放失败");
  }
  if (playingId.value === seg.id) playingId.value = "";
}

onBeforeUnmount(() => {
  stopSegmentPlayback();
  closeMenu();
});

// ---- 右键菜单（切割 / 复制 / 多选 / 删除）----
const menu = ref({ visible: false, x: 0, y: 0, segId: "" });

function openMenu(e, seg) {
  e.preventDefault();
  menu.value = { visible: true, x: e.clientX, y: e.clientY, segId: seg.id };
  setTimeout(() => document.addEventListener("pointerdown", onMenuOutside, true), 0);
}
function onMenuOutside(e) {
  if (e.target instanceof Element && e.target.closest(".mrd-at-menu")) return;
  closeMenu();
}
function closeMenu() {
  menu.value.visible = false;
  document.removeEventListener("pointerdown", onMenuOutside, true);
}
function menuSeg() {
  return audioSegs.value.find((s) => s.id === menu.value.segId);
}
function menuCut() {
  const seg = menuSeg();
  closeMenu();
  if (seg) openCutDialog(seg);
}
function menuCopy() {
  const seg = menuSeg();
  closeMenu();
  if (seg) duplicateAudio(seg);
}
function menuMulti() {
  closeMenu();
  multiMode.value = true;
  checked.value = [];
}
function menuRemove() {
  const seg = menuSeg();
  closeMenu();
  if (seg) removeAudio(seg);
}

// ---- 切割对话框 ----
const cut = ref({ visible: false, segId: "" });
function openCutDialog(seg) {
  cut.value = { visible: true, segId: seg.id };
}
function onCutConfirm({ trimStartSecs, lengthSecs }) {
  const seg = audioSegs.value.find((s) => s.id === cut.value.segId);
  if (!seg) return;
  const rate = fps.value;
  let trimStart = Math.round((trimStartSecs || 0) * rate);
  let length = Math.round((lengthSecs || 0) * rate);
  const total = seg.audioDurationFrames || 0;
  trimStart = Math.max(0, Math.min(trimStart, Math.max(0, total - 1)));
  length = Math.max(1, Math.min(length, total - trimStart));
  seg.trimStart = trimStart;
  seg.length = length;
  relayout();
  ws.markDirty();
  ElMessage.success(
    `已切割：${formatMinSec(framesToSeconds(length, rate))} / ${formatMinSec(framesToSeconds(total, rate))}`
  );
}

// ---- 复制 / 删除 ----
function duplicateAudio(src) {
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = genId();
  delete copy._blobUrl;
  const idx = audioSegs.value.indexOf(src);
  audioSegs.value.splice(idx + 1, 0, copy);
  relayout();
  ws.markDirty();
  ElMessage.success("已复制音频");
}

async function removeAudio(seg) {
  try {
    await ElMessageBox.confirm(
      `确定删除音频「${seg.fileName || "未命名"}」？`,
      "删除音频",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return;
  }
  const idx = audioSegs.value.indexOf(seg);
  if (idx >= 0) audioSegs.value.splice(idx, 1);
  relayout();
  if (playingId.value === seg.id) {
    stopSegmentPlayback();
    playingId.value = "";
  }
  ws.markDirty();
}

async function removeMany(ids) {
  const set = new Set(ids || []);
  if (!set.size) return;
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${set.size} 个音频？`,
      "批量删除音频",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return;
  }
  for (let i = audioSegs.value.length - 1; i >= 0; i--) {
    if (set.has(audioSegs.value[i].id)) audioSegs.value.splice(i, 1);
  }
  relayout();
  if (set.has(playingId.value)) {
    stopSegmentPlayback();
    playingId.value = "";
  }
  ws.markDirty();
  ElMessage.success(`已删除 ${set.size} 个音频`);
}

// ---- 勾选式多选（右键菜单进入；与分镜一致）----
const multiMode = ref(false);
const checked = ref([]);

function isChecked(id) {
  return checked.value.includes(id);
}
function toggleCheck(id) {
  const i = checked.value.indexOf(id);
  if (i >= 0) checked.value.splice(i, 1);
  else checked.value.push(id);
}
function exitMulti() {
  multiMode.value = false;
  checked.value = [];
}
// 音频被外部（如重载）移除后同步清理勾选
watch(
  () => audioSegs.value.map((s) => s.id).join(","),
  (ids) => {
    const set = new Set(ids ? ids.split(",") : []);
    if (checked.value.some((id) => !set.has(id))) {
      checked.value = checked.value.filter((id) => set.has(id));
    }
  }
);
// 全部删光则自动退出多选
watch(
  () => audioSegs.value.length,
  (n) => {
    if (multiMode.value && !n) exitMulti();
  }
);

const allChecked = computed(
  () => audioSegs.value.length > 0 && checked.value.length === audioSegs.value.length
);

function toggleAll() {
  checked.value = allChecked.value ? [] : audioSegs.value.map((s) => s.id);
}
function removeChecked() {
  if (!checked.value.length) return;
  removeMany([...checked.value]);
}

// ---- 卡片点击（多选模式勾选 / 普通模式打开切割）----
function onCardClick(_e, seg) {
  if (multiMode.value) {
    toggleCheck(seg.id);
  } else {
    openCutDialog(seg);
  }
}
</script>

<template>
  <div class="mrd-audiotrack">
    <div class="mrd-at-head">
      <template v-if="multiMode">
        <span class="mrd-at-title">已选择 {{ checked.length }}/{{ audioSegs.length }} 个音频</span>
        <el-button size="small" type="info" circle icon="CloseBold" title="退出多选" @click="exitMulti" />
      </template>
      <template v-else>
        <span class="mrd-at-title">音轨（{{ audioSegs.length }}）</span>
        <span class="mrd-at-head-ops">
          <el-button size="small" type="primary" :icon="'Plus'" @click="pickFiles">
            <small>上传音频</small>
          </el-button>
        </span>
      </template>
    </div>
    <input
      ref="pickRef"
      type="file"
      :accept="ACCEPT"
      multiple
      hidden
      @change="onPickFiles"
    />

    <el-scrollbar class="mrd-at-scroll">
      <TransitionGroup name="mrd-at" tag="div" class="mrd-at-items">
        <div
          v-for="(seg, i) in audioSegs"
          :key="seg.id"
          class="mrd-at-card"
          :class="{
            checked: multiMode && isChecked(seg.id),
            playing: playingId === seg.id,
          }"
          :data-seg-id="seg.id"
          @click="onCardClick($event, seg)"
          @contextmenu="openMenu($event, seg)"
        >
          <div class="mrd-at-line">
            <span class="mrd-at-no">{{ i + 1 }}</span>
            <div class="mrd-at-name" :title="seg.fileName">{{ seg.fileName || "（未命名音频）" }}</div>
            <span v-if="seg._uploading" class="mrd-at-up">上传中…</span>
          </div>
          <canvas class="mrd-at-wave" :ref="el => setCanvasRef(el, seg)"></canvas>
          <div class="mrd-at-line mrd-at-playrow">
            <div v-if="multiMode" class="mrd-at-checkrow" @click.stop>
              <el-checkbox
                :model-value="isChecked(seg.id)"
                size="small"
                @change="toggleCheck(seg.id)"
              />
            </div>
            <button
              type="button"
              class="mrd-at-play"
              :title="playingId === seg.id ? '停止' : '播放'"
              @click.stop="togglePlay(seg)"
            >
              <span v-if="playingId === seg.id" class="mrd-at-stop" />
              <span v-else class="mrd-at-tri" />
            </button>
            <span class="mrd-at-dur">
              切割时长 {{ formatMinSec(cutSecs(seg)) }} / 音频时长 {{ formatMinSec(totalSecs(seg)) }}
            </span>
          </div>
        </div>
      </TransitionGroup>
      <el-empty
        v-if="!audioSegs.length"
        description="上传音频开始配乐"
        :image-size="72"
      />
    </el-scrollbar>

    <!-- 多选底部工具条（与分镜一致：全选/全不选合并切换 + 批量删除） -->
    <div v-if="multiMode" class="mrd-at-bulk">
      <el-button size="small" :type="allChecked ? 'primary' : 'default'" plain @click="toggleAll">
        {{ allChecked ? "全不选" : "全选" }}
      </el-button>
      <el-button size="small" type="danger" plain :disabled="!checked.length" @click="removeChecked">删除</el-button>
    </div>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <div
        v-if="menu.visible"
        class="mrd-at-menu"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @pointerdown.stop
        @contextmenu.prevent
      >
        <button type="button" @click="menuCut">切割</button>
        <button type="button" @click="menuCopy">复制</button>
        <button type="button" @click="menuMulti">多选</button>
        <button type="button" class="danger" @click="menuRemove">删除</button>
      </div>
    </Teleport>

    <!-- 切割对话框 -->
    <AudioCutDialog
      v-model="cut.visible"
      :segment="audioSegs.find(s => s.id === cut.segId)"
      :frame-rate="fps"
      @confirm="onCutConfirm"
    />
  </div>
</template>

<style scoped>
.mrd-audiotrack {
  width: 100%;
  box-sizing: border-box;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 0 8px;
}
.mrd-at-head { display: flex; align-items: center; justify-content: space-between; flex: none; min-height: 24px; }
.mrd-at-title { font-size: 13px; font-weight: 600; color: #a9b1c3; }
.mrd-at-head-ops { display: inline-flex; align-items: center; gap: 6px; }
.mrd-at-scroll { flex: 1; min-height: 0; }
.mrd-at-items { position: relative; }
.mrd-at-card {
  position: relative;
  padding: 8px;
  background: #151821;
  border: 1px solid #222736;
  border-radius: 10px;
  cursor: pointer;
  margin-bottom: 8px;
  transition: border-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease;
}
.mrd-at-card:hover { border-color: #313a52; transform: translateY(-1px); }
.mrd-at-card.checked {
  border-color: #22c55e;
  box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.45);
}
.mrd-at-card.playing {
  border-color: rgba(108, 92, 231, 0.55);
  box-shadow: 0 0 0 1px rgba(108, 92, 231, 0.45), 0 6px 18px rgba(108, 92, 231, 0.15);
}
.mrd-at-line { display: flex; align-items: center; gap: 8px; }
.mrd-at-no {
  flex: none;
  min-width: 20px;
  font-size: 13px;
  font-weight: 700;
  color: #6b7488;
  text-align: center;
}
.mrd-at-card.checked .mrd-at-no { color: #22c55e; }
.mrd-at-name {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: #a9b1c3;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mrd-at-up { flex: none; font-size: 10.5px; color: #a78bfa; }
.mrd-at-wave {
  display: block;
  width: 100%;
  height: 36px;
  margin: 6px 0 4px;
  border-radius: 6px;
  background: rgba(34, 39, 54, 0.5);
}
.mrd-at-playrow { margin-top: 2px; }
.mrd-at-checkrow {
  display: flex;
  align-items: center;
  min-height: 20px;
}
.mrd-at-checkrow :deep(.el-checkbox__label) { font-size: 11px; color: #a9b1c3; }
.mrd-at-play {
  flex: none;
  width: 24px;
  height: 24px;
  box-sizing: border-box;
  border: 1px solid #6c5ce7;
  border-radius: 50%;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s ease, box-shadow 0.15s ease;
}
.mrd-at-play:hover { background: rgba(108, 92, 231, 0.2); box-shadow: 0 0 0 3px rgba(108, 92, 231, 0.15); }
.mrd-at-tri {
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 4.5px 0 4.5px 7px;
  border-color: transparent transparent transparent #a78bfa;
  margin-left: 1.5px;
}
.mrd-at-stop {
  width: 8px;
  height: 8px;
  border-radius: 1.5px;
  background: #a78bfa;
}
.mrd-at-dur {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: #6b7488;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 多选底部工具条 */
.mrd-at-bulk {
  flex: none;
  display: flex;
  gap: 8px;
  padding: 6px 0 2px;
  border-top: 1px solid #222736;
}
.mrd-at-bulk .el-button { flex: 1; margin-left: 0; }
/* 右键菜单（Teleport 至 body，scoped 属性仍生效） */
.mrd-at-menu {
  position: fixed;
  z-index: 3000;
  min-width: 96px;
  padding: 4px;
  background: #1c202b;
  border: 1px solid #2a3042;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
}
.mrd-at-menu button {
  appearance: none;
  border: none;
  background: transparent;
  color: #d7dbe6;
  font-size: 12px;
  text-align: left;
  padding: 6px 10px;
  border-radius: 5px;
  cursor: pointer;
}
.mrd-at-menu button:hover { background: #262c3d; }
.mrd-at-menu button.danger { color: #f87171; }
.mrd-at-menu button.danger:hover { background: rgba(248, 113, 113, 0.12); }
.mrd-at-enter-active { transition: all 0.18s ease; }
.mrd-at-enter-from { opacity: 0; transform: translateX(-12px); }
.mrd-at-leave-active { transition: all 0.15s ease; position: absolute; opacity: 0; }
</style>
