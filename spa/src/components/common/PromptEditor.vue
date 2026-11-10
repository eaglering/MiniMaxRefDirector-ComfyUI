<script setup>
// CodeMirror 6 提示词编辑器（替代旧版 highlight overlay textarea）
// - <@主体> / <#主体:对白> 渲染为「缩略图 + 名称」chip（replace widget）
// - 双击 chip 打开引用编辑浮层：可修改对白（# 标签）、删除引用
// - 退格 / Delete 紧邻 chip 时整体删除该引用
// - <d>对白</d> 保留文本并高亮
// - 输入 @（可选 #）弹出主体候选菜单，插入对应标签（连续引用不再需要先输空格）
// 协议与旧版 highlight.js / transfer.js pickSubject 一致。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder } from "@codemirror/view";
import { SUBJECT_TYPE_LABELS } from "../../constants/subject.js";
import { viewUrl } from "../../api/client.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  placeholder: { type: String, default: "" },
  candidates: { type: Array, default: () => [] },
  allowedTypes: { type: Array, default: () => [] },
  excludeUid: { type: String, default: "" },
  onlyReferencable: { type: Boolean, default: false },
  allowHash: { type: Boolean, default: true },
  readonly: { type: Boolean, default: false },
  // fill=true：占满父容器高度并内部滚动；false：随内容自动增高
  fill: { type: Boolean, default: false },
  minHeight: { type: Number, default: 88 },
});
const emit = defineEmits(["update:modelValue"]);

const hostRef = ref(null);
const viewRef = ref(null);

const showMenu = ref(false);
const activeIdx = ref(0);
const query = ref("");
const trigger = ref("@");
const mentionStart = ref(0);
const menuPos = ref({ top: 0, left: 0 });
const MENU_H = 244;

// chip 引用编辑浮层
const chipEdit = reactive({
  visible: false,
  from: 0,
  to: 0,
  name: "",
  dialogue: "",
  isHash: false,
  left: 8,
  top: 8,
  thumb: "",
});

// ---- 候选过滤 ----
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

// ---- 主体标签 widget ----
function thumbOf(subject) {
  if (!subject) return "";
  if (subject.type === "Picture" && subject.imageFile) return viewUrl(subject.imageFile);
  if (subject.type === "Video" && subject.videoFile) return viewUrl(subject.videoFile);
  if (subject.imageFile) return viewUrl(subject.imageFile);
  return "";
}

class SubjectChip extends WidgetType {
  constructor(name, dialogue, isHash, candidates, onEdit, from, to) {
    super();
    this.name = name;
    this.dialogue = dialogue || "";
    this.isHash = !!isHash;
    this.onEdit = onEdit;
    // 双击编辑弹窗直接使用 token 的精确 from/to（posAtDOM 对 replace widget 返回
    // 的位置不稳定，会导致总是弹出最后一个引用的编辑浮层）
    this.from = from;
    this.to = to;
    const s = (candidates || []).find((x) => (x.name || "").trim() === name);
    this.thumb = thumbOf(s);
    this.type = s?.type || "";
  }
  eq(other) {
    return other.name === this.name && other.dialogue === this.dialogue && other.thumb === this.thumb;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-subj-chip";
    wrap.title = this.dialogue
      ? `<#${this.name}:${this.dialogue}>（双击编辑对白）`
      : `<@${this.name}>（双击编辑引用）`;
    if (this.thumb) {
      const img = document.createElement("img");
      img.src = this.thumb;
      img.alt = "";
      wrap.appendChild(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "cm-subj-chip-glyph";
      ph.textContent = SUBJECT_TYPE_LABELS[this.type]?.[0] || "@";
      wrap.appendChild(ph);
    }
    const nm = document.createElement("span");
    nm.className = "cm-subj-chip-name";
    nm.textContent = this.name;
    wrap.appendChild(nm);
    if (this.dialogue) {
      const dg = document.createElement("span");
      dg.className = "cm-subj-chip-dialogue";
      dg.textContent = this.dialogue;
      wrap.appendChild(dg);
    }
    // 双击编辑引用（改对白 / 删除）；chip 设 user-select:none，单击仍可定位光标
    wrap.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 回传 widget 自身（含 from/to），不再用 posAtDOM 反推
      this.onEdit?.(this);
    });
    return wrap;
  }
  // 不忽略事件：单击可定位光标（chip 前后），双击由自身监听阻断
  ignoreEvent() {
    return false;
  }
}

const TOKEN_RE = /<@([^>\n]*)>|<#([^:>\n]*)(?::([^>\n]*))?>|<!([^:>\n]*)(?::([^>\n]*))?>|<d>([\s\S]*?)<\/d>/g;

function buildDeco(view) {
  const text = view.state.doc.toString();
  const decos = [];
  const atomic = [];
  TOKEN_RE.lastIndex = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const from = m.index;
    const to = from + m[0].length;
    if (m[0].startsWith("<@")) {
      decos.push(Decoration.replace({
        widget: new SubjectChip((m[1] || "").trim(), "", false, props.candidates, handleChipEdit, from, to),
      }).range(from, to));
      atomic.push(Decoration.replace({}).range(from, to));
    } else if (m[0].startsWith("<#")) {
      decos.push(Decoration.replace({
        widget: new SubjectChip((m[2] || "").trim(), (m[3] || "").trim(), true, props.candidates, handleChipEdit, from, to),
      }).range(from, to));
      atomic.push(Decoration.replace({}).range(from, to));
    } else if (m[0].startsWith("<!")) {
      // <!镜头结构:定场镜头> 指令标签：保留原文本，绿色系 mark 高亮（区别于 <d> 黄色与主体 chip）
      decos.push(Decoration.mark({ class: "cm-shot-tag" }).range(from, to));
    } else {
      decos.push(Decoration.mark({ class: "cm-d-tag" }).range(from, to));
    }
  }
  return { decorations: Decoration.set(decos, true), atomic: Decoration.set(atomic, true) };
}

const decoPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      const built = buildDeco(view);
      this.decorations = built.decorations;
      this.atomic = built.atomic;
    }
    update(u) {
      // 每次 update 重建：文本量小，且候选（缩略图）变化时也能刷新
      const built = buildDeco(u.view);
      this.decorations = built.decorations;
      this.atomic = built.atomic;
    }
  },
  { decorations: (v) => v.decorations }
);

// 主体 chip 作为原子范围：光标不进入标签内部
const atomicRanges = EditorView.atomicRanges.of(
  (view) => view.plugin(decoPlugin)?.atomic || Decoration.none
);

// ---- 退格 / Delete 整体删除 chip ----
function chipEndingAt(view, pos) {
  let found = null;
  view.plugin(decoPlugin)?.atomic.between(0, view.state.doc.length, (from, to) => {
    if (to === pos && from < to) found = { from, to };
  });
  return found;
}

function chipStartingAt(view, pos) {
  let found = null;
  view.plugin(decoPlugin)?.atomic.between(0, view.state.doc.length, (from, to) => {
    if (from === pos && from < to) found = { from, to };
  });
  return found;
}

function deleteChipBackward(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const r = chipEndingAt(view, sel.head);
  if (!r) return false;
  view.dispatch({ changes: { from: r.from, to: r.to }, selection: { anchor: r.from } });
  return true;
}

function deleteChipForward(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const r = chipStartingAt(view, sel.head);
  if (!r) return false;
  view.dispatch({ changes: { from: r.from, to: r.to }, selection: { anchor: r.from } });
  return true;
}

const chipKeymap = keymap.of([
  { key: "Backspace", run: deleteChipBackward },
  { key: "Delete", run: deleteChipForward },
]);

const darkTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "#edeff5",
      fontSize: "12.5px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "inherit",
      lineHeight: "1.75",
      overflow: "auto",
    },
    ".cm-content": {
      padding: "8px 10px",
      caretColor: "#edeff5",
      minHeight: "0",
    },
    ".cm-line": { padding: "0 2px" },
    ".cm-placeholder": { color: "#8a8a8a" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(79, 195, 247, 0.22)",
    },
    ".cm-d-tag": {
      color: "#ffd54f",
      backgroundColor: "rgba(255, 213, 79, 0.12)",
      borderRadius: "2px",
    },
    // <!镜头结构:定场镜头> 指令标签（绿色系，与 <d> 黄色区分）
    ".cm-shot-tag": {
      color: "#4ade80",
      backgroundColor: "rgba(74, 222, 128, 0.12)",
      borderRadius: "2px",
    },
  },
  { dark: true }
);

// ---- 提及检测 ----
function positionMenu(view, head) {
  const coords = view.coordsAtPos(head);
  let top = 0;
  let left = 8;
  if (coords) {
    const belowFits = coords.bottom + MENU_H + 8 <= window.innerHeight;
    top = belowFits ? coords.bottom + 4 : Math.max(8, coords.top - MENU_H - 4);
    left = Math.min(Math.max(8, coords.left), window.innerWidth - 268);
  }
  menuPos.value = { top, left };
}

function detectMention(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) {
    showMenu.value = false;
    return;
  }
  const head = sel.head;
  const from = Math.max(0, head - 160);
  const before = view.state.sliceDoc(from, head);
  const re = props.allowHash ? /([@#])([^@#\s>]*)$/ : /(@)([^@\s>]*)$/;
  const m = before.match(re);
  if (!m) {
    showMenu.value = false;
    return;
  }
  // 仅当触发符是手动输入标签起始（`<@` / `<#`）时不弹菜单；
  // 紧跟在已闭合标签后的新触发符（如 `<@张三>@`）必须正常响应。
  const prevChar = before.slice(0, before.length - m[0].length).slice(-1);
  if (prevChar === "<") {
    showMenu.value = false;
    return;
  }
  trigger.value = m[1];
  query.value = m[2];
  mentionStart.value = head - m[0].length;
  activeIdx.value = 0;
  showMenu.value = true;
  positionMenu(view, head);
}

function accept(item) {
  const view = viewRef.value;
  if (!view) return;
  const name = (item.name || "").trim();
  const tag = trigger.value === "@" ? `<@${name}>` : `<#${name}:对话内容>`;
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: mentionStart.value, to: head, insert: tag },
    selection: { anchor: mentionStart.value + tag.length },
    scrollIntoView: true,
  });
  showMenu.value = false;
  view.focus();
}

// ---- chip 引用编辑 ----
// chip 参数为 SubjectChip widget 实例（dblclick 回传），from/to 为 token 精确位置
function handleChipEdit(chip) {
  const view = viewRef.value;
  if (!view || !chip || typeof chip.from !== "number" || typeof chip.to !== "number") return;
  const text = view.state.doc.toString();
  // 快照校验：widget 可能已过期（文本被外部改写），区段内容不再是标签则放弃
  const seg = text.slice(chip.from, chip.to);
  const mHash = /^<#([^:>\n]*)(?::([^>\n]*))?>$/.exec(seg);
  const mAt = /^<@([^>\n]*)>$/.exec(seg);
  const isHash = !!mHash;
  const m = isHash ? mHash : mAt;
  if (!m) return;
  const name = (m[1] || "").trim();
  const rect = chip.dom?.getBoundingClientRect?.() || {
    left: window.innerWidth / 2 - 140,
    top: window.innerHeight / 2 - 60,
    bottom: window.innerHeight / 2,
  };
  const POP_H = isHash ? 168 : 116;
  const belowFits = rect.bottom + POP_H + 8 <= window.innerHeight;
  chipEdit.visible = true;
  chipEdit.from = chip.from;
  chipEdit.to = chip.to;
  chipEdit.name = name;
  chipEdit.dialogue = isHash ? (m[2] || "") : "";
  chipEdit.isHash = isHash;
  chipEdit.thumb = thumbOf(props.candidates.find((x) => (x.name || "").trim() === name));
  chipEdit.left = Math.min(Math.max(8, rect.left), window.innerWidth - 300);
  chipEdit.top = belowFits ? rect.bottom + 6 : Math.max(8, rect.top - POP_H - 6);
  showMenu.value = false;
  return true;
}

function saveChipEdit() {
  const view = viewRef.value;
  if (!view) return;
  const name = chipEdit.name;
  const dialogue = (chipEdit.dialogue || "").trim();
  // 后端 <#name:dialogue> 解析要求对白非空；清空时降级为主体引用
  const tag = chipEdit.isHash && dialogue ? `<#${name}:${dialogue}>` : `<@${name}>`;
  view.dispatch({
    changes: { from: chipEdit.from, to: chipEdit.to, insert: tag },
    selection: { anchor: chipEdit.from + tag.length },
    scrollIntoView: true,
  });
  chipEdit.visible = false;
  view.focus();
}

function deleteChipRef() {
  const view = viewRef.value;
  if (!view) return;
  const { from, to } = chipEdit;
  view.dispatch({ changes: { from, to }, selection: { anchor: from } });
  chipEdit.visible = false;
  view.focus();
}

function createEditor(el) {
  const startState = EditorState.create({
    doc: props.modelValue || "",
    extensions: [
      chipKeymap,
      EditorView.lineWrapping,
      darkTheme,
      decoPlugin,
      atomicRanges,
      placeholder(props.placeholder || ""),
      EditorState.readOnly.of(props.readonly),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          emit("update:modelValue", u.state.doc.toString());
        }
        if (u.docChanged || u.selectionSet) detectMention(u.view);
      }),
      EditorView.domEventHandlers({
        keydown(e) {
          if (!showMenu.value || !filtered.value.length) return false;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            activeIdx.value = (activeIdx.value + 1) % filtered.value.length;
            return true;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            activeIdx.value = (activeIdx.value - 1 + filtered.value.length) % filtered.value.length;
            return true;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            accept(filtered.value[activeIdx.value]);
            return true;
          }
          if (e.key === "Escape") {
            showMenu.value = false;
            return true;
          }
          return false;
        },
        blur() {
          setTimeout(() => (showMenu.value = false), 120);
          return false;
        },
      }),
    ],
  });
  viewRef.value = new EditorView({ state: startState, parent: el });
}

onMounted(() => {
  if (hostRef.value) createEditor(hostRef.value);
});

onBeforeUnmount(() => {
  viewRef.value?.destroy();
  viewRef.value = null;
});

// 外部写入同步（切换分镜 / 生成 H3 结果回填）
watch(
  () => props.modelValue,
  (val) => {
    const view = viewRef.value;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (val !== cur) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: val || "" } });
    }
  }
);

// 候选变化时触发一次 update 以重建装饰（缩略图可能刚上传/替换）
watch(
  () => props.candidates,
  () => {
    const view = viewRef.value;
    if (!view) return;
    view.dispatch({ selection: { anchor: view.state.selection.main.head } });
  },
  { deep: true }
);

function onMenuClick(item) {
  accept(item);
}

function thumb(s) {
  return thumbOf(s);
}
</script>

<template>
  <div class="mrd-cm-host" :class="{ 'mrd-cm-host--fill': fill }" :style="{ minHeight: `${minHeight}px` }">
    <div ref="hostRef" class="mrd-cm-inner"></div>
    <Teleport to="body">
      <div
        v-if="showMenu && filtered.length"
        class="mrd-mention-menu"
        :style="{ top: `${menuPos.top}px`, left: `${menuPos.left}px` }"
      >
        <div
          v-for="(item, i) in filtered"
          :key="item.uid || item.name"
          class="mrd-mention-item"
          :class="{ active: i === activeIdx }"
          :title="trigger === '@' ? `插入 <@${item.name}>` : `插入 <#${item.name}:对话内容>`"
          @mousedown.prevent
          @click="onMenuClick(item)"
        >
          <img v-if="thumb(item)" class="mrd-mention-thumb" :src="thumb(item)" alt="" />
          <span v-else class="mrd-mention-glyph" :data-type="item.type">{{ SUBJECT_TYPE_LABELS[item.type]?.[0] || "?" }}</span>
          <span class="mrd-mention-name">{{ item.name }}</span>
          <span class="mrd-mention-type">{{ SUBJECT_TYPE_LABELS[item.type] || item.type }}</span>
        </div>
      </div>

      <!-- chip 引用编辑浮层 -->
      <template v-if="chipEdit.visible">
        <div class="mrd-chip-mask" @click="chipEdit.visible = false"></div>
        <div
          class="mrd-chip-pop"
          :style="{ top: `${chipEdit.top}px`, left: `${chipEdit.left}px` }"
          @mousedown.stop
          @click.stop
        >
          <div class="mrd-chip-pop-head">
            <img v-if="chipEdit.thumb" :src="chipEdit.thumb" alt="" />
            <span v-else class="mrd-chip-pop-glyph">@</span>
            <span class="mrd-chip-pop-name">{{ chipEdit.name }}</span>
          </div>
          <div v-if="chipEdit.isHash" class="mrd-chip-pop-body">
            <label>对话内容</label>
            <el-input
              v-model="chipEdit.dialogue"
              size="small"
              placeholder="该主体的对白内容"
              @keyup.enter="saveChipEdit"
            />
          </div>
          <div class="mrd-chip-pop-actions">
            <el-button size="small" text type="danger" @click="deleteChipRef">删除引用</el-button>
            <span class="mrd-chip-pop-gap"></span>
            <el-button size="small" @click="chipEdit.visible = false">取消</el-button>
            <el-button size="small" type="primary" @click="saveChipEdit">确定</el-button>
          </div>
        </div>
      </template>
    </Teleport>
  </div>
</template>

<style scoped>
.mrd-cm-host {
  position: relative;
  width: 100%;
  box-sizing: border-box;
  background: #151923;
  border: 1px solid #2a3042;
  border-radius: 6px;
  overflow: hidden;
  transition: border-color 0.15s ease;
}
.mrd-cm-host:focus-within { border-color: #6c5ce7; }
.mrd-cm-host--fill { flex: 1; min-height: 0; display: flex; }
.mrd-cm-inner { width: 100%; height: 100%; min-height: 0; }
.mrd-cm-host--fill .mrd-cm-inner :deep(.cm-editor) { height: 100%; }
.mrd-cm-host--fill .mrd-cm-inner :deep(.cm-scroller) { overflow: auto; }

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

/* chip 引用编辑浮层 */
.mrd-chip-mask { position: fixed; inset: 0; z-index: 2998; background: transparent; }
.mrd-chip-pop {
  position: fixed;
  z-index: 2999;
  width: 280px;
  background: #1c202b;
  border: 1px solid #313a52;
  border-radius: 10px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.6);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mrd-chip-pop-head { display: flex; align-items: center; gap: 8px; }
.mrd-chip-pop-head img { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; }
.mrd-chip-pop-glyph {
  width: 26px; height: 26px; border-radius: 50%;
  background: rgba(108, 92, 231, 0.5); color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 12px;
}
.mrd-chip-pop-name { color: #edeff5; font-size: 13px; font-weight: 600; }
.mrd-chip-pop-body { display: flex; flex-direction: column; gap: 4px; }
.mrd-chip-pop-body > label { font-size: 11px; color: #6b7488; }
.mrd-chip-pop-actions { display: flex; align-items: center; gap: 6px; }
.mrd-chip-pop-gap { flex: 1; }
</style>
