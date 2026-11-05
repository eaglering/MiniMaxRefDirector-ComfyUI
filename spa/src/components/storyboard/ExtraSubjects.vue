<script setup>
// 中间下部：额外主体选择（写入 seg.additionSubject）
// 提示词中未被 @ 提及、但希望参与本分镜绑定的主体。
import { computed } from "vue";
import { useWorkspace } from "../../stores/workspace.js";
import { SUBJECT_TYPE_LABELS, mergeSegmentSubjects } from "../../constants/subject.js";
import { viewUrl } from "../../api/client.js";

const props = defineProps({
  segment: { type: Object, required: true },
});
const ws = useWorkspace();

// 可候选：本分镜生效主体（全局 + 段级自定义副本按名合并）
const candidates = computed(() =>
  mergeSegmentSubjects(ws.subjects.subjects, props.segment.subjectsOverride).filter(
    (s) => (s.name || "").trim() !== ""
  )
);

// 本分镜提示词中已 @ 提及的主体名（无需重复勾选）
const mentionedNames = computed(() => {
  const text = `${props.segment.prompt || ""} ${props.segment.h3PromptJson?.detailed_description || ""} ${props.segment.h3PromptJson?.summary || ""}`;
  const names = new Set();
  for (const m of text.matchAll(/<@([^>]+)>/g)) names.add(m[1].trim());
  for (const m of text.matchAll(/<#([^:>]+)(?::[^>]*)?>/g)) names.add(m[1].trim());
  return names;
});

function selectedNames() {
  if (!Array.isArray(props.segment.additionSubject)) props.segment.additionSubject = [];
  return props.segment.additionSubject;
}

function toggle(name) {
  const arr = selectedNames();
  const idx = arr.indexOf(name);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(name);
  ws.markDirty();
}
</script>

<template>
  <div class="mrd-extra">
    <div class="mrd-extra-head">
      <span class="mrd-extra-title">额外主体</span>
      <span class="mrd-extra-hint">勾选未在提示词中提及、但需参与本分镜绑定的主体</span>
    </div>
    <el-scrollbar class="mrd-extra-scroll">
      <div class="mrd-extra-list">
        <button
          v-for="s in candidates"
          :key="s.uid"
          class="mrd-extra-item"
          :class="{
            on: selectedNames().includes(s.name),
            mentioned: mentionedNames.has((s.name || '').trim()),
          }"
          :title="mentionedNames.has((s.name || '').trim()) ? '已在提示词中提及' : s.description || s.name"
          @click="toggle(s.name)"
        >
          <img v-if="s.type === 'Picture' && s.imageFile" :src="viewUrl(s.imageFile)" alt="" />
          <video v-else-if="s.type === 'Video' && s.videoFile" :src="viewUrl(s.videoFile)" muted preload="metadata" />
          <span v-else class="mrd-extra-glyph" :data-type="s.type">{{ SUBJECT_TYPE_LABELS[s.type]?.[0] || "?" }}</span>
          <span class="mrd-extra-name">{{ s.name }}</span>
          <span v-if="mentionedNames.has((s.name || '').trim())" class="mrd-extra-mark">@</span>
        </button>
        <span v-if="!candidates.length" class="mrd-extra-empty">暂无主体，请先到「主体管理」页创建</span>
      </div>
    </el-scrollbar>
  </div>
</template>

<style scoped>
.mrd-extra {
  flex: none;
  background: #151821;
  border: 1px solid #222736;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 170px;
}
.mrd-extra-head { display: flex; align-items: baseline; gap: 10px; flex: none; }
.mrd-extra-title { font-size: 12px; font-weight: 600; color: #a9b1c3; }
.mrd-extra-hint { font-size: 11px; color: #55607a; }
.mrd-extra-scroll { min-height: 0; }
.mrd-extra-list { display: flex; flex-wrap: wrap; gap: 6px; }
.mrd-extra-item {
  position: relative;
  display: flex; align-items: center; gap: 6px;
  background: #1c202b;
  border: 1px solid #2a3042;
  color: #a9b1c3;
  border-radius: 999px;
  padding: 3px 12px 3px 5px;
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.mrd-extra-item:hover { border-color: #6c5ce7; }
.mrd-extra-item.on {
  background: rgba(108, 92, 231, 0.2);
  border-color: #6c5ce7;
  color: #edeff5;
}
.mrd-extra-item.mentioned { opacity: 0.55; }
.mrd-extra-item img, .mrd-extra-item video {
  width: 22px; height: 22px; border-radius: 50%; object-fit: cover; border: 1px solid #313a52;
}
.mrd-extra-glyph {
  width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: #262c3d; font-size: 11px; color: #a9b1c3;
}
.mrd-extra-mark { color: #22c55e; font-weight: 700; margin-left: -4px; }
.mrd-extra-empty { font-size: 11.5px; color: #55607a; }
</style>
