<script setup>
// 提及高亮输入框（与旧版 highlight.js + subject.js attachMention / transfer.js pickSubject 协议一致）
// - overlay 镜像层高亮：<@主体> 蓝 / <#主体:对白> 绿 / <d>对白</d> 黄
// - 输入 @ → 弹主体候选菜单，插入 <@主体名>
// - 输入 # → 弹主体候选菜单，插入 <#主体名:对话内容>（对白可继续编辑）
// - 触发条件：光标前 query 不含空格/>/@/#；已闭合标签后的触发符不响应
import { computed, nextTick, ref } from "vue";
import { SUBJECT_TYPE_LABELS } from "../../constants/subject.js";
import { viewUrl } from "../../api/client.js";

const MENU_H = 240;

const props = defineProps({
  modelValue: { type: String, default: "" },
  placeholder: { type: String, default: "" },
  rows: { type: Number, default: 4 },
  // 候选主体（含子主体）
  candidates: { type: Array, default: () => [] },
  // 允许提及的类型（REF_MENTION_TYPES[type]）
  allowedTypes: { type: Array, default: () => [] },
  // 排除自身 uid
  excludeUid: { type: String, default: "" },
  // 仅允许可引用主体（relationship 非空；旧版 transfer.js 规则，纯引用子主体不可提及）
  onlyReferencable: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue"]);

const textareaRef = ref(null);
const showMenu = ref(false);
const activeIdx = ref(0);
const query = ref("");
const trigger = ref("@");
const menuPos = ref({ top: 0, left: 0 });

// 可见候选（类型 + 可引用性 + 名称匹配）
const filtered = computed(() => {
  const q = query.value.toLowerCase();
  return props.candidates.filter(
    (s) =>
      s.uid !== props.excludeUid &&
      (props.allowedTypes.length === 0 || props.allowedTypes.includes(s.type)) &&
      (!props.onlyReferencable || (s.relationship && s.relationship !== "none")) &&
      (s.name || "").trim() !== "" &&
      (s.name || "").toLowerCase().includes(q)
  );
});

// ---- 高亮层 HTML ----
const HL_RE = /(<@[^>]*>|<#[^>]*>|<d>[\s\S]*?<\/d>)/g;

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const highlightHtml = computed(() => {
  const text = props.modelValue || "";
  let out = "";
  let last = 0;
  HL_RE.lastIndex = 0;
  let m;
  while ((m = HL_RE.exec(text))) {
    out += escHtml(text.slice(last, m.index));
    const tok = m[0];
    const cls = tok.startsWith("<@") ? "hl-at" : tok.startsWith("<#") ? "hl-hash" : "hl-d";
    out += `<span class="hl ${cls}">${escHtml(tok)}</span>`;
    last = HL_RE.lastIndex;
  }
  out += escHtml(text.slice(last));
  // 尾部换行占位，保证 pre 与 textarea 滚动高度一致
  return out + "\n";
});

function syncScroll(e) {
  const pre = textareaRef.value?.parentElement?.querySelector("pre");
  if (pre) {
    pre.scrollTop = e.target.scrollTop;
    pre.scrollLeft = e.target.scrollLeft;
  }
}

// ---- 输入与提及检测 ----
function onInput(e) {
  const el = e.target;
  emit("update:modelValue", el.value);
  detectMention(el);
}

function detectMention(el) {
  const pos = el.selectionStart;
  if (el.selectionStart !== el.selectionEnd) {
    showMenu.value = false;
    return;
  }
  const before = el.value.slice(0, pos);
  // @ 或 # 触发，query 不含空格 / 触发符 / 闭合符
  const m = before.match(/([@#])([^@#\s>]*)$/);
  if (!m) {
    showMenu.value = false;
    return;
  }
  // 已闭合标签后的触发符不响应（与原实现一致）
  const prevChar = before.slice(0, before.length - m[0].length).slice(-1);
  if (prevChar === ">" || (m[1] === "#" && prevChar === "<")) {
    showMenu.value = false;
    return;
  }
  trigger.value = m[1];
  query.value = m[2];
  activeIdx.value = 0;
  showMenu.value = true;
  positionMenu();
}

// fixed 定位（teleport 到 body，避免被滚动容器裁剪）：优先输入框下方，放不下则上方
function positionMenu() {
  const el = textareaRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const belowFits = r.bottom + MENU_H + 8 <= window.innerHeight;
  menuPos.value = {
    top: belowFits ? r.bottom + 4 : Math.max(8, r.top - MENU_H - 4),
    left: Math.min(Math.max(8, r.left), window.innerWidth - 260),
  };
}

function accept(item) {
  const el = textareaRef.value;
  if (!el) return;
  const pos = el.selectionStart;
  const before = el.value.slice(0, pos);
  const m = before.match(/([@#])([^@#\s>]*)$/);
  if (!m) return;
  const start = pos - m[0].length;
  const name = (item.name || "").trim();
  const tag = trigger.value === "@" ? `<@${name}>` : `<#${name}:对话内容>`;
  const next = el.value.slice(0, start) + tag + el.value.slice(pos);
  emit("update:modelValue", next);
  showMenu.value = false;
  nextTick(() => {
    const caret = start + tag.length;
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}

function onKeydown(e) {
  if (!showMenu.value || filtered.value.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIdx.value = (activeIdx.value + 1) % filtered.value.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIdx.value = (activeIdx.value - 1 + filtered.value.length) % filtered.value.length;
  } else if (e.key === "Enter") {
    e.preventDefault();
    accept(filtered.value[activeIdx.value]);
  } else if (e.key === "Escape") {
    showMenu.value = false;
  }
}

function onBlur() {
  setTimeout(() => (showMenu.value = false), 120);
}

function thumb(s) {
  if (s.type === "Picture" && s.imageFile) return viewUrl(s.imageFile);
  if (s.type === "Video" && s.videoFile) return viewUrl(s.videoFile);
  return "";
}
</script>

<template>
  <div class="mrd-mention-wrap" :style="{ height: `${rows * 22 + 16}px` }">
    <pre class="mrd-mention-pre" aria-hidden="true" v-html="highlightHtml"></pre>
    <textarea
      ref="textareaRef"
      class="mrd-mention-ta"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
      @keydown="onKeydown"
      @blur="onBlur"
      @scroll="syncScroll"
    />
    <Teleport to="body">
      <div
        v-if="showMenu && filtered.length"
        class="mrd-mention-menu"
        :style="{ top: `${menuPos.top}px`, left: `${menuPos.left}px` }"
      >
        <div
          v-for="(item, i) in filtered"
          :key="item.uid"
          class="mrd-mention-item"
          :class="{ active: i === activeIdx }"
          :title="trigger === '@' ? `插入 <@${item.name}>` : `插入 <#${item.name}:对话内容>`"
          @mousedown.prevent
          @click="accept(item)"
        >
          <img v-if="thumb(item)" class="mrd-mention-thumb" :src="thumb(item)" alt="" />
          <span v-else class="mrd-mention-glyph" :data-type="item.type">{{ SUBJECT_TYPE_LABELS[item.type]?.[0] || "?" }}</span>
          <span class="mrd-mention-name">{{ item.name }}</span>
          <span class="mrd-mention-type">{{ SUBJECT_TYPE_LABELS[item.type] || item.type }}</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.mrd-mention-wrap {
  position: relative;
  width: 100%;
  min-height: 0;
}
.mrd-mention-pre,
.mrd-mention-ta {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 8px 10px;
  font-size: 12.5px;
  line-height: 1.76;
  font-family: inherit;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  border-radius: 6px;
  border: 1px solid #2a3042;
}
.mrd-mention-pre {
  pointer-events: none;
  overflow: hidden;
  z-index: 1;
  color: #edeff5;
  background: #151923;
  scrollbar-gutter: stable;
}
.mrd-mention-ta {
  z-index: 2;
  background: transparent;
  color: transparent;
  caret-color: #edeff5;
  resize: none;
  outline: none;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  transition: border-color 0.15s ease;
}
.mrd-mention-ta:focus { border-color: #6c5ce7; }
.mrd-mention-ta::selection { background: rgba(79, 195, 247, 0.25); }
.mrd-mention-ta::placeholder { color: #8a8a8a; opacity: 1; }
.mrd-mention-ta:disabled { opacity: 0.5; }
.mrd-mention-pre :deep(.hl) { border-radius: 2px; }
.mrd-mention-pre :deep(.hl-at) { color: #4fc3f7; background: rgba(79, 195, 247, 0.14); }
.mrd-mention-pre :deep(.hl-hash) { color: #a5d6a7; background: rgba(165, 214, 167, 0.13); }
.mrd-mention-pre :deep(.hl-d) { color: #ffd54f; background: rgba(255, 213, 79, 0.13); }

.mrd-mention-menu {
  position: fixed;
  z-index: 3000;
  min-width: 240px;
  max-height: 240px;
  overflow: auto;
  background: #1c202b;
  border: 1px solid #313a52;
  border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  padding: 4px;
}
.mrd-mention-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s ease;
}
.mrd-mention-item:hover, .mrd-mention-item.active { background: rgba(108, 92, 231, 0.25); }
.mrd-mention-thumb { width: 22px; height: 22px; border-radius: 4px; object-fit: cover; }
.mrd-mention-glyph {
  width: 22px; height: 22px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  background: #262c3d; font-size: 11px; color: #a9b1c3;
}
.mrd-mention-name { color: #edeff5; font-size: 12.5px; flex: 1; }
.mrd-mention-type { color: #6b7488; font-size: 11px; }
</style>
