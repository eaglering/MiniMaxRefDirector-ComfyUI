<script setup>
// 全局参数 · 技能文档面板（md 提示词模板，SQLite skill_docs 表）
// 四类二级分类（主体设计 / 音频设计 / 图片设计 / 分镜设计）+ 文档列表 + 编辑/预览双栏。
// 与「分镜技能」（镜头技能词条表）数据表独立。
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { marked } from "marked";
import {
  fetchSkillDocs, fetchSkillDoc, addSkillDoc, updateSkillDoc, deleteSkillDoc,
} from "../../api/client.js";

const DOC_CATEGORIES = ["主体设计", "音频设计", "图片设计", "分镜设计"];

// ---- 分类与列表 ----
const activeCat = ref("主体设计");
const docs = ref([]); // 当前分类列表（不含正文，summary 摘要）
const counts = ref({});
const loading = ref(false);

async function loadDocs() {
  loading.value = true;
  try {
    const res = await fetchSkillDocs();
    if (res.success) {
      counts.value = res.counts || {};
      const cat = activeCat.value;
      docs.value = (res.docs || []).filter((d) => d.category === cat);
      if (!docs.value.some((d) => d.id === activeId.value)) selectDoc(docs.value[0] || null);
    }
  } catch (e) {
    ElMessage.error(`技能文档加载失败：${e.message || e}`);
  } finally {
    loading.value = false;
  }
}

function switchCat(cat) {
  activeCat.value = cat;
  loadDocs();
}

// ---- 当前文档与编辑态 ----
const activeId = ref(0);
const current = ref(null); // { id, category, title, content, builtin, builtinKey }
const draftTitle = ref("");
const draftContent = ref("");
const dirty = ref(false);
const saving = ref(false);

async function selectDoc(doc) {
  if (!doc) { current.value = null; activeId.value = 0; return; }
  try {
    const res = await fetchSkillDoc({ id: doc.id });
    if (res.success && res.doc) {
      current.value = res.doc;
      activeId.value = res.doc.id;
      draftTitle.value = res.doc.title;
      draftContent.value = res.doc.content;
      dirty.value = false;
    }
  } catch (e) {
    ElMessage.error(`读取文档失败：${e.message || e}`);
  }
}

function onEdit() {
  dirty.value = true;
}

async function saveDoc() {
  if (!current.value || saving.value) return;
  if (!draftTitle.value.trim()) { ElMessage.warning("技能标题不能为空"); return; }
  saving.value = true;
  try {
    const res = await updateSkillDoc({
      id: current.value.id,
      category: current.value.category,
      title: draftTitle.value.trim(),
      content: draftContent.value,
    });
    if (!res.success) throw new Error(res.error || "保存失败");
    dirty.value = false;
    current.value.title = draftTitle.value.trim();
    current.value.content = draftContent.value;
    ElMessage.success("已保存");
    await loadDocs();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    saving.value = false;
  }
}

async function removeDoc() {
  if (!current.value) return;
  try {
    await ElMessageBox.confirm(
      `确定删除文档「${current.value.title}」？内置文档删除后可从文件库兜底读取，但库内修改会丢失。`,
      "删除文档",
      { type: "warning" }
    );
  } catch { return; }
  try {
    const res = await deleteSkillDoc(current.value.id);
    if (!res.success) throw new Error(res.error || "删除失败");
    ElMessage.success("已删除");
    current.value = null;
    activeId.value = 0;
    await loadDocs();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  }
}

// ---- 新增文档 ----
const addDialog = ref({ visible: false, title: "", saving: false });
async function submitAdd() {
  const d = addDialog.value;
  if (d.saving) return;
  if (!d.title.trim()) { ElMessage.warning("技能标题不能为空"); return; }
  d.saving = true;
  try {
    const res = await addSkillDoc({
      category: activeCat.value,
      title: d.title.trim(),
      content: `# ${d.title.trim()}\n\n`,
    });
    if (!res.success) throw new Error(res.error || "创建失败");
    d.visible = false;
    ElMessage.success(`文档「${d.title.trim()}」已创建`);
    await loadDocs();
    await selectDoc({ id: res.id });
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    d.saving = false;
  }
}

// ---- md 预览（本机自维护数据；渲染前做最小化 script 过滤）----
const previewHtml = computed(() => {
  const raw = draftContent.value || "";
  const safe = raw.replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*script[^>]*\/?\s*>/gi, "");
  return marked.parse(safe, { async: false, gfm: true, breaks: true });
});

function copyAll() {
  navigator.clipboard?.writeText(draftContent.value || "")
    .then(() => ElMessage.success("全文已复制"))
    .catch(() => ElMessage.error("复制失败（浏览器剪贴板不可用）"));
}

onMounted(loadDocs);
</script>

<template>
  <section class="mrd-card mrd-section mrd-docs">
    <div class="mrd-docs-head">
      <h3 class="mrd-section-title"><el-icon><component :is="'Notebook'" /></el-icon>技能文档</h3>
      <el-button type="primary" size="small" :icon="'Plus'" @click="addDialog.visible = true">新增文档</el-button>
    </div>
    <p class="mrd-docs-sub">
      可编辑的 md 提示词模板：主体管理的「生成提示词」与分镜导入流水线都从这里取文档。
      内置文档来自 install 初始化内容，可直接修改；带 <span class="mrd-docs-badge">内置</span> 徽标的是导入流水线按内置 key 引用的文档，建议保留标题与用途不变。
    </p>

    <!-- 二级分类 -->
    <div class="mrd-docs-cats">
      <button
        v-for="c in DOC_CATEGORIES" :key="c"
        class="mrd-docs-cat" :class="{ active: activeCat === c }"
        @click="switchCat(c)"
      >
        {{ c }}
        <i v-if="counts[c]" class="mrd-docs-count">{{ counts[c] }}</i>
      </button>
    </div>

    <!-- 文档列表 + 编辑/预览 -->
    <div class="mrd-docs-body">
      <aside class="mrd-docs-list">
        <button
          v-for="d in docs" :key="d.id"
          class="mrd-docs-item" :class="{ active: d.id === activeId }"
          @click="selectDoc(d)"
        >
          <span class="mrd-docs-item-title">
            {{ d.title }}
            <span v-if="d.builtin" class="mrd-docs-badge">内置</span>
          </span>
          <span class="mrd-docs-item-sum">{{ d.summary || "（空文档）" }}</span>
        </button>
        <div v-if="!docs.length && !loading" class="mrd-docs-empty">该分类暂无文档，点右上角「新增文档」</div>
      </aside>

      <div v-if="current" class="mrd-docs-editor">
        <div class="mrd-docs-editor-head">
          <el-input v-model="draftTitle" class="mrd-docs-title" placeholder="技能标题" @input="onEdit" />
          <span v-if="dirty" class="mrd-docs-dirty" title="有未保存修改">●</span>
          <div class="mrd-docs-ops">
            <el-button size="small" text :icon="'CopyDocument'" @click="copyAll">复制全文</el-button>
            <el-button size="small" text type="danger" :icon="'Delete'" @click="removeDoc">删除</el-button>
            <el-button size="small" type="primary" :loading="saving" :disabled="!dirty" @click="saveDoc">保存</el-button>
          </div>
        </div>
        <div class="mrd-docs-panes">
          <textarea
            v-model="draftContent"
            class="mrd-docs-md"
            spellcheck="false"
            placeholder="支持 Markdown：标题、列表、表格、代码块…"
            @input="onEdit"
          ></textarea>
          <div class="mrd-docs-preview" v-html="previewHtml"></div>
        </div>
      </div>
      <el-empty v-else class="mrd-docs-empty-main" description="选择左侧文档，或新增一篇" />
    </div>

    <!-- 新增文档弹窗 -->
    <el-dialog v-model="addDialog.visible" title="新增技能文档" width="480px" append-to-body>
      <div class="mrd-docs-field">
        <label>分类</label>
        <el-input :model-value="activeCat" disabled />
      </div>
      <div class="mrd-docs-field">
        <label>技能标题（同分类下不可重名）</label>
        <el-input v-model="addDialog.title" placeholder="如：krea2 主体四视图" @keyup.enter="submitAdd" />
      </div>
      <template #footer>
        <el-button @click="addDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="addDialog.saving" @click="submitAdd">创建</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.mrd-section { padding: 18px 22px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.mrd-docs-head { display: flex; align-items: center; justify-content: space-between; }
.mrd-section-title {
  margin: 0; font-size: 15px; font-weight: 600; color: #edeff5;
  display: flex; align-items: center; gap: 8px;
}
.mrd-section-title :deep(.el-icon) { color: #a78bfa; }
.mrd-docs-sub { margin: 8px 0 12px; font-size: 12px; color: #6b7488; line-height: 1.7; }
.mrd-docs-badge {
  font-size: 10px; color: #f0b46a; border: 1px solid rgba(240, 180, 106, 0.4);
  border-radius: 8px; padding: 0 5px; margin-left: 5px; flex: none;
}
.mrd-docs-cats { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.mrd-docs-cat {
  padding: 5px 16px; border-radius: 14px; border: 1px solid #2a3042;
  background: transparent; color: #a9b1c3; font-size: 12.5px; cursor: pointer;
  transition: all 0.18s ease;
}
.mrd-docs-cat:hover { color: #edeff5; border-color: #6c5ce7; }
.mrd-docs-cat.active {
  color: #fff; border-color: #6c5ce7;
  background: rgba(108, 92, 231, 0.18);
  box-shadow: 0 0 10px rgba(108, 92, 231, 0.25);
}
.mrd-docs-count {
  font-style: normal; display: inline-block; margin-left: 5px; padding: 0 5px;
  min-width: 14px; border-radius: 8px; font-size: 10.5px;
  background: rgba(255, 255, 255, 0.14);
}
.mrd-docs-body { flex: 1; min-height: 0; display: flex; gap: 14px; }
.mrd-docs-list {
  flex: none; width: 240px; overflow: auto;
  display: flex; flex-direction: column; gap: 4px;
  border-right: 1px dashed #2c3143; padding-right: 10px;
}
.mrd-docs-item {
  position: relative; text-align: left; border: none; background: none; cursor: pointer;
  padding: 8px 10px; border-radius: 8px; transition: background 0.15s ease;
  display: flex; flex-direction: column; gap: 3px;
}
.mrd-docs-item:hover { background: rgba(255, 255, 255, 0.05); }
.mrd-docs-item.active { background: rgba(108, 92, 231, 0.14); }
.mrd-docs-item.active::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px;
  border-radius: 2px; background: linear-gradient(180deg, #6c5ce7, #a78bfa);
}
.mrd-docs-item-title { font-size: 12.5px; color: #edeff5; display: flex; align-items: center; }
.mrd-docs-item-sum {
  font-size: 11px; color: #6b7488; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; max-width: 210px;
}
.mrd-docs-empty { font-size: 11.5px; color: #6b7488; padding: 12px 6px; }
.mrd-docs-editor { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.mrd-docs-editor-head { display: flex; align-items: center; gap: 10px; }
.mrd-docs-title { flex: 1; }
.mrd-docs-dirty { color: #f0b46a; font-size: 13px; }
.mrd-docs-ops { display: flex; gap: 4px; flex: none; }
.mrd-docs-panes {
  flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
}
.mrd-docs-md {
  flex: 1; min-height: 0; resize: none; border-radius: 8px;
  background: rgba(255, 255, 255, 0.04); border: 1px solid #2c3143; color: #c3c9d6;
  font-family: "JetBrains Mono", Consolas, monospace; font-size: 12px; line-height: 1.7;
  padding: 10px 12px; outline: none;
}
.mrd-docs-md:focus { border-color: #6c5ce7; }
.mrd-docs-preview {
  min-height: 0; overflow: auto; border-radius: 8px;
  background: rgba(255, 255, 255, 0.03); border: 1px dashed #2c3143;
  padding: 10px 14px; font-size: 12.5px; color: #c3c9d6; line-height: 1.75;
}
.mrd-docs-preview :deep(h1),
.mrd-docs-preview :deep(h2),
.mrd-docs-preview :deep(h3) { color: #edeff5; margin: 10px 0 6px; font-weight: 600; }
.mrd-docs-preview :deep(h1) { font-size: 15px; }
.mrd-docs-preview :deep(h2) { font-size: 13.5px; }
.mrd-docs-preview :deep(h3) { font-size: 12.5px; }
.mrd-docs-preview :deep(p) { margin: 6px 0; }
.mrd-docs-preview :deep(ul),
.mrd-docs-preview :deep(ol) { margin: 6px 0; padding-left: 20px; }
.mrd-docs-preview :deep(code) {
  font-family: "JetBrains Mono", Consolas, monospace; font-size: 11.5px;
  background: rgba(108, 92, 231, 0.12); border-radius: 4px; padding: 1px 5px;
}
.mrd-docs-preview :deep(pre) {
  background: rgba(0, 0, 0, 0.3); border: 1px solid #2c3143; border-radius: 6px;
  padding: 8px 10px; overflow: auto; margin: 8px 0;
}
.mrd-docs-preview :deep(pre code) { background: none; padding: 0; }
.mrd-docs-preview :deep(blockquote) {
  margin: 8px 0; padding: 4px 12px; border-left: 2px solid #6c5ce7;
  color: #a9b1c3; background: rgba(108, 92, 231, 0.06);
}
.mrd-docs-preview :deep(table) { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 11.5px; }
.mrd-docs-preview :deep(th),
.mrd-docs-preview :deep(td) { border: 1px solid #2c3143; padding: 4px 8px; text-align: left; }
.mrd-docs-preview :deep(th) { color: #a9b1c3; background: rgba(255, 255, 255, 0.04); }
.mrd-docs-preview :deep(hr) { border: none; border-top: 1px dashed #2c3143; margin: 10px 0; }
.mrd-docs-empty-main { flex: 1; align-self: center; }
.mrd-docs-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.mrd-docs-field > label { font-size: 12px; color: #a9b1c3; }
@media (max-width: 900px) {
  .mrd-docs-body { flex-direction: column; }
  .mrd-docs-list { width: 100%; border-right: none; border-bottom: 1px dashed #2c3143; padding: 0 0 10px; }
  .mrd-docs-panes { grid-template-columns: 1fr; }
}
</style>
