<script setup>
// 左侧分镜列表：新增 / 时长编辑 / 右键菜单（复制·多选·删除）/
// 多选模式（卡片左下 checkbox，底部 全选·全不选·删除）/
// 长按 300ms 拖拽排序（连续时间轴，顺序即时间顺序，无空隙）
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({
  segments: { type: Array, required: true },
  selectedId: { type: String, default: "" },
  displayMode: { type: String, default: "seconds" },
  frameRate: { type: Number, default: 24 },
  showDeepseekImport: { type: Boolean, default: false },
  importSiteLabel: { type: String, default: "DeepSeek" },
});
const emit = defineEmits([
  "select", "change", "add", "duplicate", "remove", "deepseek-import",
  "apply-span", "apply-segment", "remove-many",
]);

const inSeconds = computed(() => props.displayMode === "seconds");

// 连续时间轴：重排所有 start（分镜顺序即时间顺序，无空隙）
function relayout() {
  let cursor = 0;
  for (const seg of props.segments) {
    seg.start = cursor;
    cursor += seg.length;
  }
}

// ---- 右键菜单（复制 / 多选 / 删除）----
const menu = ref({ visible: false, x: 0, y: 0, segId: "" });

function openMenu(e, seg) {
  if (dragActive) return;
  e.preventDefault();
  menu.value = { visible: true, x: e.clientX, y: e.clientY, segId: seg.id };
  setTimeout(() => document.addEventListener("pointerdown", onMenuOutside, true), 0);
}
function onMenuOutside(e) {
  if (e.target instanceof Element && e.target.closest(".mrd-shot-menu")) return;
  closeMenu();
}
function closeMenu() {
  menu.value.visible = false;
  document.removeEventListener("pointerdown", onMenuOutside, true);
}
function menuCopy() {
  const id = menu.value.segId;
  closeMenu();
  emit("duplicate", id);
}
function menuMulti() {
  closeMenu();
  multiMode.value = true;
  checked.value = [];
  // 勾选模式与 Ctrl 多选互斥
  ctxSel.value = [];
  ctxApplied.value = false;
}
function menuRemove() {
  const id = menu.value.segId;
  closeMenu();
  emit("remove", id);
}
onBeforeUnmount(closeMenu);

// ---- 勾选式多选（右键菜单进入；只做选择与删除，不联动全局参数）----
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
// 分镜被外部删除后同步清理勾选与 Ctrl 选中集
watch(
  () => props.segments.map((s) => s.id).join(","),
  (ids) => {
    const set = new Set(ids ? ids.split(",") : []);
    if (checked.value.some((id) => !set.has(id))) {
      checked.value = checked.value.filter((id) => set.has(id));
    }
    if (ctxSel.value.some((id) => !set.has(id))) {
      ctxSel.value = ctxSel.value.filter((id) => set.has(id));
    }
  }
);

const allChecked = computed(
  () => props.segments.length > 0 && checked.value.length === props.segments.length
);

// 全选 / 全不选合并为一个切换按钮；只改勾选状态，不更新全局开始/结束/时长
function toggleAll() {
  checked.value = allChecked.value ? [] : props.segments.map((s) => s.id);
}
function removeChecked() {
  if (!checked.value.length) return;
  emit("remove-many", [...checked.value]);
}

// ---- Ctrl 临时多选（独立于勾选式多选）----
// 仅用于：头部图标把选区跨度写入全局开始/结束（时长 = end - start 派生），
// 以及应用后的 disabled 视觉；不写 selectedId，避免右侧提示词面板跳动。
const ctxSel = ref([]);        // Ctrl 选中的分镜 id 集合
const ctxApplied = ref(false); // 已点击头部图标应用跨度（标题 n/m + 置灰）
const marquee = ref(null);     // 框选矩形 { x1, y1, x2, y2 }（视口坐标）

function isCtx(id) {
  return ctxSel.value.includes(id);
}
// 跨度计算：Start=最早选中分镜开始；End=最晚选中分镜结束（含未选中间隙）
function computeSpan(ids) {
  const sel = props.segments.filter((s) => ids.includes(s.id));
  if (!sel.length) return null;
  return {
    startFrame: Math.min(...sel.map((s) => s.start || 0)),
    endFrame: Math.max(...sel.map((s) => (s.start || 0) + (s.length || 0))),
  };
}
// Ctrl 选区变化即更新全局开始/结束/时长：非空 → 选中集跨度；空 → 全部分镜跨度
function applyCtxSpan() {
  const span = computeSpan(ctxSel.value);
  if (!span) return;
  emit("apply-span", span);
  ctxApplied.value = true;
}
function syncCtxSpan() {
  if (!ctxSel.value.length) {
    ctxApplied.value = false;
    emitSpanAll();
    return;
  }
  applyCtxSpan();
}
function toggleCtx(id) {
  const i = ctxSel.value.indexOf(id);
  if (i >= 0) ctxSel.value.splice(i, 1);
  else ctxSel.value.push(id);
  // 选择即更新，无需额外点击应用
  syncCtxSpan();
}
// 全部分镜跨度：Start=第一个分镜开始；End=最后一个分镜结束
function emitSpanAll() {
  if (!props.segments.length) return;
  emit("apply-span", {
    startFrame: Math.min(...props.segments.map((s) => s.start || 0)),
    endFrame: Math.max(...props.segments.map((s) => (s.start || 0) + (s.length || 0))),
  });
}
// 退出 Ctrl 多选：清空选中与置灰；全局开始/结束/时长 更新为包含所有分镜
function exitCtxMulti() {
  ctxSel.value = [];
  ctxApplied.value = false;
  emitSpanAll();
}
// 新增/删除分镜后刷新全局范围：局部选中 → 按选中集跨度；否则 → 全部分镜跨度
function refreshGlobalRange() {
  // 先清理已不存在的选中 id（批量删除等场景 watch 尚未触发）
  const idSet = new Set(props.segments.map((s) => s.id));
  if (ctxSel.value.some((id) => !idSet.has(id))) {
    ctxSel.value = ctxSel.value.filter((id) => idSet.has(id));
  }
  if (ctxSel.value.length) {
    const span = computeSpan(ctxSel.value);
    if (span) emit("apply-span", span);
    return;
  }
  emitSpanAll();
}
defineExpose({ refreshGlobalRange });
// 供模板引用（applyCtxSpan / exitCtxMulti 直接绑定到 Ctrl 多选底部条）

// ---- 长按拖拽排序 ----
const dragIndex = ref(-1);
const dropIndex = ref(-1);
let pressTimer = null;
let dragActive = false;
let suppressClick = false;
const LONG_PRESS_MS = 300;

function onPointerDown(e, i) {
  if (e.button !== 0 || menu.value.visible || dragActive) return;
  // checkbox / 时长输入等交互元素不触发拖拽
  if (e.target instanceof Element && e.target.closest(".mrd-shot-checkrow, .mrd-shot-dur, button, input, select, textarea")) return;
  // Ctrl 拖拽框选：与长按拖拽排序互斥（不启动 300ms 计时器）
  if ((e.ctrlKey || e.metaKey) && !multiMode.value) {
    startMarquee(e);
    return;
  }
  const startX = e.clientX;
  const startY = e.clientY;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    dragActive = true;
    suppressClick = true;
    dragIndex.value = i;
    dropIndex.value = i;
    document.body.classList.add("mrd-shotlist-dragging");
  }, LONG_PRESS_MS);
  const onMove = (ev) => {
    if (dragActive) {
      ev.preventDefault();
      updateDropIndex(ev.clientY);
    } else if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) {
      // 长按前移动距离过大 → 取消长按，按普通点击处理
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (dragActive) finishDrag();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

// 依据指针 Y 计算插入位置（卡片中线以上插到其前，以下插到其后）
function updateDropIndex(clientY) {
  const cards = document.querySelectorAll(".mrd-shotlist-items .mrd-shot-card");
  let idx = props.segments.length;
  for (let k = 0; k < cards.length; k++) {
    const r = cards[k].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { idx = k; break; }
  }
  dropIndex.value = idx;
}

function finishDrag() {
  dragActive = false;
  document.body.classList.remove("mrd-shotlist-dragging");
  const from = dragIndex.value;
  const to = dropIndex.value;
  if (from >= 0 && to >= 0 && to !== from && to !== from + 1) {
    const arr = props.segments;
    const [seg] = arr.splice(from, 1);
    arr.splice(to > from ? to - 1 : to, 0, seg);
    relayout();
    emit("change");
  }
  dragIndex.value = -1;
  dropIndex.value = -1;
  setTimeout(() => { suppressClick = false; }, 0);
}

// ---- Ctrl 拖拽框选 ----
let marqueeRaf = 0;
let marqueeCleanup = null;
function startMarquee(e) {
  const startX = e.clientX;
  const startY = e.clientY;
  marquee.value = { x1: startX, y1: startY, x2: startX, y2: startY };
  document.body.classList.add("mrd-shotlist-marqueeing");
  const baseSel = [...ctxSel.value]; // 框选结果与既有选中取并集
  let moved = false;
  let pendingUpdate = false;
  const onMove = (ev) => {
    if (pendingUpdate) return;
    pendingUpdate = true;
    marqueeRaf = requestAnimationFrame(() => {
      pendingUpdate = false;
      if (!marquee.value) return;
      marquee.value.x2 = ev.clientX;
      marquee.value.y2 = ev.clientY;
      if (!moved && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) {
        moved = true;
      }
      if (moved) {
        const hitIds = collectCardIdsInRect(marqueeRect());
        ctxSel.value = [...new Set([...baseSel, ...hitIds])];
      }
    });
  };
  const finish = () => {
    if (marqueeCleanup) { marqueeCleanup(); marqueeCleanup = null; }
    cancelAnimationFrame(marqueeRaf);
    marquee.value = null;
    // 框选结束抑制紧随的 click（避免把落点分镜再 toggle 一次 / 误退出多选）
    if (moved) {
      syncCtxSpan(); // 框选松手后按最终选区更新全局范围
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 50);
    }
  };
  marqueeCleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    document.body.classList.remove("mrd-shotlist-marqueeing");
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}
onBeforeUnmount(() => {
  if (marqueeCleanup) { marqueeCleanup(); marqueeCleanup = null; }
  cancelAnimationFrame(marqueeRaf);
  marquee.value = null;
});

function marqueeRect() {
  const m = marquee.value;
  return {
    left: Math.min(m.x1, m.x2),
    top: Math.min(m.y1, m.y2),
    right: Math.max(m.x1, m.x2),
    bottom: Math.max(m.y1, m.y2),
  };
}

// 收集与选框相交的卡片分镜 id（卡片 DOM 带 data-seg-id，不依赖顺序）
function collectCardIdsInRect(r) {
  const ids = [];
  const cards = document.querySelectorAll(".mrd-shotlist-items .mrd-shot-card[data-seg-id]");
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const overlap =
      rect.left < r.right && rect.right > r.left &&
      rect.top < r.bottom && rect.bottom > r.top;
    if (overlap) ids.push(card.getAttribute("data-seg-id"));
  }
  return ids;
}

function onCardClick(e, seg) {
  if (suppressClick) return;
  // Ctrl + 点击 = 切换 Ctrl 选中（勾选模式下不生效，checkbox 优先）
  if (e && (e.ctrlKey || e.metaKey) && !multiMode.value) {
    toggleCtx(seg.id);
    return;
  }
  if (multiMode.value) {
    toggleCheck(seg.id);
    return;
  }
  // 单选与 Ctrl 多选互不影响：普通点击仅切换单选（浅紫背景），不动多选状态
  emit("select", seg.id);
}

function addShot() {
  emit("add");
}

function durationValue(seg) {
  return inSeconds.value
    ? Math.round(((seg.length || 0) / (props.frameRate || 24)) * 100) / 100
    : seg.length;
}

function setDuration(seg, val) {
  if (val == null || isNaN(val)) return;
  const frames = inSeconds.value
    ? Math.max(1, Math.round(val * (props.frameRate || 24)))
    : Math.max(1, Math.round(val));
  seg.length = frames;
  relayout();
  emit("change");
  // 修改时长后同步全局开始/结束/时长：局部选中且该分镜在选中集内 → 按选中集跨度；
  // 否则（含全选/无选中）→ 按全部分镜跨度
  if (ctxSel.value.length) {
    if (!ctxSel.value.includes(seg.id)) return; // 不在选中集，选中范围不变
    applyCtxSpan();
    return;
  }
  emitSpanAll();
}
</script>

<template>
  <div class="mrd-shotlist">
    <div class="mrd-shotlist-head">
      <template v-if="multiMode">
        <span class="mrd-shotlist-title">已选择 {{ checked.length }}/{{ segments.length }} 个分镜</span>
        <el-button size="small" type="info" circle icon="CloseBold" title="退出多选" @click="exitMulti" />
      </template>
      <template v-else>
        <span class="mrd-shotlist-title">
          {{ ctxSel.length
            ? (ctxApplied ? `选中分镜 ${ctxSel.length}/${segments.length}` : `已选 ${ctxSel.length} 个分镜`)
            : `分镜（${segments.length}）` }}
        </span>
        <span class="mrd-shotlist-head-ops">
          <el-button size="small" type="primary" :icon="'Plus'" @click="addShot">
            <small>新增分镜</small>
          </el-button>
        </span>
      </template>
    </div>
    <el-button
      v-if="showDeepseekImport && !multiMode"
      class="mrd-shotlist-dsi"
      size="small"
      plain
      :icon="'ChatDotRound'"
      @click="emit('deepseek-import')"
    >{{ importSiteLabel }} 分镜导入</el-button>

    <el-scrollbar class="mrd-shotlist-scroll">
      <TransitionGroup name="mrd-shot" tag="div" class="mrd-shotlist-items">
        <div
          v-for="(seg, i) in segments"
          :key="seg.id"
          class="mrd-shot-card"
          :class="{
            selected: !multiMode && seg.id === selectedId,
            checked: multiMode && isChecked(seg.id),
            'ctx-on': !multiMode && isCtx(seg.id),
            'ctx-dim': !multiMode && ctxApplied && !isCtx(seg.id),
            dragging: dragIndex === i,
            dimmed: dragIndex >= 0 && dragIndex !== i,
            'drop-before': dragIndex >= 0 && dropIndex === i,
            'drop-after': dragIndex >= 0 && dropIndex === i + 1 && i === segments.length - 1,
          }"
          :data-seg-id="seg.id"
          @click="onCardClick($event, seg)"
          @contextmenu="openMenu($event, seg)"
          @pointerdown="onPointerDown($event, i)"
        >
          <div class="mrd-shot-card-line">
            <span class="mrd-shot-no">{{ i + 1 }}</span>
            <div class="mrd-shot-prompt">{{ (seg.prompt || seg.h3PromptJson?.summary || "（空分镜）").slice(0, 60) }}</div>
          </div>
          <div class="mrd-shot-card-line">
            <div v-if="multiMode" class="mrd-shot-checkrow" @click.stop>
              <el-checkbox
                :model-value="isChecked(seg.id)"
                size="small"
                @change="toggleCheck(seg.id)"
              />
            </div>
            <div class="mrd-shot-info">
              <el-input-number
                :model-value="durationValue(seg)"
                :min="inSeconds ? 0.1 : 1"
                :step="inSeconds ? 0.5 : 12"
                :precision="inSeconds ? 2 : 0"
                size="small"
                style="width:130px;"
                controls-position="right"
                @change="val => setDuration(seg, val)"
                @click.stop
              >
                <template #prefix>
                  {{ inSeconds ? "时长(s)" : "时长(帧)" }}
                </template>
              </el-input-number>
            </div>
          </div>
          <!-- <span class="mrd-shot-no">{{ i + 1 }}</span>
          <div class="mrd-shot-info">
            
            <div class="mrd-shot-dur" @click.stop>
              
            </div>
          </div>
          <div>
             -->
        </div>
      </TransitionGroup>
    </el-scrollbar>

    <!-- 多选底部工具条（全选/全不选合并为切换按钮；不联动全局参数） -->
    <div v-if="multiMode" class="mrd-shotlist-bulk">
      <el-button size="small" :type="allChecked ? 'primary' : 'default'" plain @click="toggleAll">
        {{ allChecked ? "全不选" : "全选" }}
      </el-button>
      <el-button size="small" type="danger" plain :disabled="!checked.length" @click="removeChecked">删除</el-button>
    </div>

    <!-- Ctrl 多选底部操作条：选择即更新全局范围，仅提供退出 -->
    <div v-if="!multiMode && ctxSel.length" class="mrd-shotlist-bulk">
      <el-button size="small" @click="exitCtxMulti()">退出多选</el-button>
    </div>

    <!-- 操作提示 -->
    <el-alert
      class="mrd-shotlist-tip"
      type="info"
      :closable="false"
    >
      <template #title>
        多选分镜：按住 Ctrl 左键点击或拖动框选分镜，选中即按选中范围更新全局开始/结束/时长，点击「退出多选」恢复全部分镜范围；右键菜单「多选」用于勾选分镜后批量删除。
      </template>
    </el-alert>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <!-- Ctrl 框选矩形 -->
      <div
        v-if="marquee"
        class="mrd-shot-marquee"
        :style="{
          left: Math.min(marquee.x1, marquee.x2) + 'px',
          top: Math.min(marquee.y1, marquee.y2) + 'px',
          width: Math.abs(marquee.x2 - marquee.x1) + 'px',
          height: Math.abs(marquee.y2 - marquee.y1) + 'px',
        }"
      />
      <div
        v-if="menu.visible"
        class="mrd-shot-menu"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @pointerdown.stop
        @contextmenu.prevent
      >
        <button type="button" @click="menuCopy">复制</button>
        <button type="button" @click="menuMulti">多选</button>
        <button type="button" class="danger" @click="menuRemove">删除</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.mrd-shotlist {
  /* 位于分镜页 el-splitter 首栏内：宽度由分栏拖拽决定 */
  width: 100%;
  box-sizing: border-box;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 0 8px;
}
.mrd-shotlist-head { display: flex; align-items: center; justify-content: space-between; flex: none; min-height: 24px; }
.mrd-shotlist-dsi {
  flex: none;
  width: 100%;
  border-style: dashed;
  color: #a78bfa;
  border-color: rgba(167, 139, 250, 0.45);
}
.mrd-shotlist-dsi:hover { color: #c4b5fd; border-color: #a78bfa; background: rgba(108, 92, 231, 0.08); }
.mrd-shotlist-title { font-size: 13px; font-weight: 600; color: #a9b1c3; }
.mrd-shotlist-head-ops { display: inline-flex; align-items: center; gap: 6px; }
.mrd-shotlist-scroll { flex: 1; min-height: 0; }
.mrd-shotlist-items { position: relative; }
.mrd-shot-card {
  position: relative;
  padding: 8px;
  background: #151821;
  border: 1px solid #222736;
  border-radius: 10px;
  cursor: pointer;
  margin-bottom: 8px;
  transition: border-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease;
}
.mrd-shot-card:hover { border-color: #313a52; transform: translateY(-1px); }
/* 单选（普通点击）：浅紫背景；Ctrl 多选选中态用紫色边框区分 */
.mrd-shot-card.selected {
  background: rgba(108, 92, 231, 0.18);
  border-color: rgba(108, 92, 231, 0.35);
}
.mrd-shot-card.checked {
  border-color: #22c55e;
  box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.45);
}
/* Ctrl 多选：选中高亮（与单选 selected 同视觉）/ 应用后未选中置灰 */
.mrd-shot-card.ctx-on {
  border-color: #6c5ce7;
  box-shadow: 0 0 0 1px rgba(108, 92, 231, 0.55), 0 6px 18px rgba(108, 92, 231, 0.18);
}
.mrd-shot-card.ctx-on .mrd-shot-no { color: #a78bfa; }
.mrd-shot-card.ctx-dim {
  opacity: 0.45;
  filter: grayscale(0.6);
}
/* Ctrl 框选矩形（Teleport 至 body） */
.mrd-shot-marquee {
  position: fixed;
  z-index: 2500;
  pointer-events: none;
  border: 1px dashed rgba(108, 92, 231, 0.9);
  background: rgba(108, 92, 231, 0.12);
  border-radius: 4px;
}
/* 拖拽状态视觉 */
.mrd-shot-card.dragging {
  opacity: 0.35;
  border-style: dashed;
  transform: scale(0.98);
}
.mrd-shot-card.dimmed { opacity: 0.85; }
.mrd-shot-card.drop-before { box-shadow: inset 0 3px 0 0 #6c5ce7; }
.mrd-shot-card.drop-after { box-shadow: inset 0 -3px 0 0 #6c5ce7; }
.mrd-shot-no {
  flex: none;
  min-width: 20px;
  padding-top: 2px;
  font-size: 13px;
  font-weight: 700;
  color: #6b7488;
  text-align: center;
}
.mrd-shot-card.selected .mrd-shot-no { color: #a78bfa; }
.mrd-shot-card.checked .mrd-shot-no { color: #22c55e; }
.mrd-shot-card-line { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 4px; }
.mrd-shot-info { flex: 1; display: flex; gap: 6px; align-items: center; justify-content: flex-end; }
.mrd-shot-prompt {
  font-size: 11.5px; color: #a9b1c3; line-height: 1.4;
  overflow: hidden; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  min-height: 32px; flex: 1;
}
.mrd-shot-dur { display: flex; align-items: center; gap: 6px; }
.mrd-shot-dur-label { font-size: 10.5px; color: #6b7488; flex: none; }
.mrd-shot-dur :deep(.el-input-number) { width: 84px; }
.mrd-shot-checkrow {
  /* 多选 checkbox：卡片左下方 */
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-height: 20px;
}
.mrd-shot-checkrow :deep(.el-checkbox__label) { font-size: 11px; color: #a9b1c3; }
/* 多选底部工具条 */
.mrd-shotlist-bulk {
  flex: none;
  display: flex;
  gap: 8px;
  padding: 6px 0 2px;
  border-top: 1px solid #222736;
}
.mrd-shotlist-bulk .el-button { flex: 1; margin-left: 0; }
/* 操作提示（紧凑小号） */
.mrd-shotlist-tip {
  flex: none;
  --el-alert-padding: 6px 10px;
}
.mrd-shotlist-tip :deep(.el-alert__title) {
  font-size: 11px;
  line-height: 1.5;
  white-space: normal;
}
/* 右键菜单（Teleport 至 body，scoped 属性仍生效） */
.mrd-shot-menu {
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
.mrd-shot-menu button {
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
.mrd-shot-menu button:hover { background: #262c3d; }
.mrd-shot-menu button.danger { color: #f87171; }
.mrd-shot-menu button.danger:hover { background: rgba(248, 113, 113, 0.12); }
.mrd-shot-enter-active { transition: all 0.18s ease; }
.mrd-shot-enter-from { opacity: 0; transform: translateX(-12px); }
.mrd-shot-leave-active { transition: all 0.15s ease; position: absolute; opacity: 0; }
</style>

<style>
/* 拖拽期间的全局反馈（非 scoped） */
body.mrd-shotlist-dragging {
  cursor: grabbing !important;
  user-select: none !important;
}
body.mrd-shotlist-dragging * { cursor: grabbing !important; }
/* Ctrl 框选期间禁用文本选择 */
body.mrd-shotlist-marqueeing {
  user-select: none !important;
  cursor: crosshair !important;
}
body.mrd-shotlist-marqueeing * { user-select: none !important; }
</style>
