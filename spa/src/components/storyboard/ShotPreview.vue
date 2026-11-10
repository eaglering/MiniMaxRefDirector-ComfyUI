<script setup>
// 右侧 Tab2 分镜预览：
// - 引用主体预览卡片；点击弹窗编辑（替换图片、编辑描述等，与主体管理一致）
// - 按引用逐个「自定义」：开启后该主体在本分镜拥有独立副本（深拷贝进
//   seg.subjectsOverride，与其子主体一起），后端生成时按名字替换全局主体；
//   关闭即删除副本，恢复跟随全局
import { computed, reactive } from "vue";
import { ElMessage } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import { isChildSubject, SUBJECT_TYPE_LABELS, mergeSegmentSubjects } from "../../constants/subject.js";
import { viewUrl } from "../../api/client.js";
import SubjectCard from "../subjects/SubjectCard.vue";

const props = defineProps({
  segment: { type: Object, required: true },
  segments: { type: Array, default: () => [] },
});
const ws = useWorkspace();

const dialog = reactive({ visible: false, uid: "" });

const globalSubjects = computed(() => ws.subjects.subjects);

// 段级覆盖数组（仅含被自定义的主体及其子主体副本）
const overrideList = computed(() =>
  Array.isArray(props.segment.subjectsOverride) ? props.segment.subjectsOverride : []
);

// 本分镜生效主体集合：全局为底，override 按名字替换；override 新名主体追加
const effectiveSubjects = computed(() =>
  mergeSegmentSubjects(globalSubjects.value, overrideList.value)
);

// 提示词中引用的主体名集合
const mentionedNames = computed(() => {
  const seg = props.segment;
  const text = `${seg.prompt || ""} ${seg.h3PromptJson?.detailed_description || ""} ${seg.h3PromptJson?.summary || ""}`;
  const names = new Set();
  for (const m of text.matchAll(/<@([^>]+)>/g)) names.add(m[1].trim());
  for (const m of text.matchAll(/<#([^:>]+)(?::[^>]*)?>/g)) names.add(m[1].trim());
  for (const n of seg.additionSubject || []) names.add(String(n).trim());
  return names;
});

// 只展示"被引用"的主体：prompt/H3 中以 <@名字> / <#名字> 出现，或已在
// additionSubject 里；已开启本分镜自定义的副本始终显示（便于编辑）。
const visibleSubjects = computed(() =>
  effectiveSubjects.value.filter((s) => !isChildSubject(s) && (isReferenced(s) || isCustom(s)))
);

function dirty() {
  ws.markDirty();
}

// 某主体是否已开启本分镜自定义
function isCustom(s) {
  return overrideList.value.some((o) => o.uid === s.uid);
}

// 开启自定义：深拷贝该主体 + 其子主体进 override
function enableCustom(s, notify = true) {
  if (!Array.isArray(props.segment.subjectsOverride)) props.segment.subjectsOverride = [];
  const ov = props.segment.subjectsOverride;
  if (ov.some((o) => o.uid === s.uid)) return;
  ov.push(JSON.parse(JSON.stringify(s)));
  for (const c of globalSubjects.value) {
    if (c.ownerUid === s.uid) ov.push(JSON.parse(JSON.stringify(c)));
  }
  if (notify) ElMessage.info(`已为「${s.name || "未命名"}」创建本分镜独立副本`);
  dirty();
}

// 关闭自定义：移除该主体及其子主体副本
function disableCustom(s) {
  const ov = props.segment.subjectsOverride;
  if (!Array.isArray(ov)) return;
  const rm = new Set([s.uid]);
  for (const o of ov) if (o.ownerUid === s.uid) rm.add(o.uid);
  const next = ov.filter((o) => !rm.has(o.uid));
  if (next.length) props.segment.subjectsOverride = next;
  else delete props.segment.subjectsOverride;
  dirty();
}

function onToggleCustom(s, v) {
  if (v) enableCustom(s);
  else disableCustom(s);
}

// 点击卡片：未自定义时自动创建副本再编辑（避免误改全局）
function openEditor(s) {
  if (!isCustom(s)) enableCustom(s, true);
  dialog.uid = s.uid;
  dialog.visible = true;
}

const editingSubject = computed(() => effectiveSubjects.value.find((s) => s.uid === dialog.uid));

function thumb(s) {
  if (s.imageFile) return viewUrl(s.imageFile);
  if (s.videoFile) return viewUrl(s.videoFile);
  return "";
}

function isReferenced(s) {
  return mentionedNames.value.has((s.name || "").trim());
}
</script>

<template>
  <div class="mrd-preview">
    <div class="mrd-preview-hint mrd-card">
      默认继承全局主体；对某个引用开启「自定义」后，该主体仅在本分镜使用独立副本（含其引用资源），适合「小孩子成长过程」等同一主体跨分镜变化——每个阶段分镜单独开启并编辑即可。
    </div>

    <!-- 主体卡片 -->
    <el-scrollbar class="mrd-preview-scroll">
      <div class="mrd-preview-grid">
        <div
          v-for="s in visibleSubjects"
          :key="s.uid"
          class="mrd-preview-card"
          :class="{ referenced: isReferenced(s), custom: isCustom(s) }"
        >
          <div class="mrd-preview-thumb">
            <img v-if="thumb(s)" :src="thumb(s)" alt="" />
            <span v-else class="mrd-preview-glyph" :data-type="s.type">{{ SUBJECT_TYPE_LABELS[s.type]?.[0] || "?" }}</span>
            <span v-if="isReferenced(s)" class="mrd-preview-ref">引用</span>
            <span v-if="isCustom(s)" class="mrd-preview-custom">自定义</span>
          </div>
          <div class="mrd-preview-name">{{ s.name || "(未命名)" }}</div>
          <div class="mrd-preview-desc">{{ (s.description || "").slice(0, 40) }}</div>
          <div class="mrd-preview-foot">
            <el-switch
              size="small"
              :model-value="isCustom(s)"
              @change="v => onToggleCustom(s, v)"
            />
            <span class="mrd-preview-edit" @click="openEditor(s)">
              <el-icon><component :is="'EditPen'" /></el-icon> 编辑
            </span>
          </div>
        </div>
      </div>
      <el-empty
        v-if="!visibleSubjects.length"
        description="本分镜暂无引用主体：在提示词中用 <@名字> 引用后在此显示"
        :image-size="70"
      />
    </el-scrollbar>

    <!-- 编辑弹窗 -->
    <el-dialog
      v-model="dialog.visible"
      :title="editingSubject ? `编辑主体：${editingSubject.name || '(未命名)'}${isCustom(editingSubject) ? '（本分镜副本）' : ''}` : '编辑主体'"
      width="720px"
      append-to-body
      destroy-on-close
    >
      <SubjectCard
        v-if="editingSubject"
        :subject="editingSubject"
        :subjects="effectiveSubjects"
        :can-remove="false"
        compact
        @change="dirty"
      />
      <template #footer>
        <el-button type="primary" @click="dialog.visible = false">完成</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.mrd-preview { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; }
.mrd-preview-hint {
  padding: 10px 12px; flex: none;
  font-size: 11.5px; color: #6b7488; line-height: 1.6;
}
.mrd-preview-scroll { flex: 1; min-height: 0; }
.mrd-preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }
.mrd-preview-card {
  background: #151821;
  border: 1px solid #222736;
  border-radius: 10px;
  padding: 8px;
  cursor: pointer;
  transition: border-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease;
  display: flex; flex-direction: column; gap: 5px;
}
.mrd-preview-card:hover {
  border-color: #6c5ce7;
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
}
.mrd-preview-card.referenced { border-color: #2c5a3f; }
.mrd-preview-card.custom { border-color: #6c5ce7; }
.mrd-preview-thumb {
  position: relative;
  width: 100%; aspect-ratio: 4/3;
  border-radius: 8px; overflow: hidden;
  background: #1c202b;
  display: flex; align-items: center; justify-content: center;
}
.mrd-preview-thumb img { width: 100%; height: 100%; object-fit: cover; }
.mrd-preview-glyph { font-size: 20px; font-weight: 700; color: #3d4459; }
.mrd-preview-ref {
  position: absolute; top: 4px; left: 4px;
  font-size: 10px; padding: 1px 6px;
  background: rgba(34, 197, 94, 0.85);
  color: #fff; border-radius: 4px;
}
.mrd-preview-custom {
  position: absolute; top: 4px; right: 4px;
  font-size: 10px; padding: 1px 6px;
  background: rgba(108, 92, 231, 0.9);
  color: #fff; border-radius: 4px;
}
.mrd-preview-name { font-size: 12.5px; font-weight: 600; color: #edeff5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrd-preview-desc { font-size: 10.5px; color: #6b7488; line-height: 1.4; min-height: 28px; overflow: hidden; }
.mrd-preview-foot {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: #a78bfa;
}
.mrd-preview-edit { display: flex; align-items: center; gap: 3px; }
</style>
