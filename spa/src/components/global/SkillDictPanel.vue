<script setup>
// 全局参数 · 分镜技能词典管理面板
// 类别驱动（render_mode 决定注入方式与必填字段），可无限扩展：
//   camera 运镜 / term 术语 / example 示例 / descriptive 描述 / block 片段
// protect_keywords=1 的类别，其技术词在 skill_notes 中用 <!技术词> 保护（如运镜）
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import {
  addSkillDict, addSkillCategory, batchAddSkillDict, deleteSkillDict,
  updateSkillDict, updateSkillCategory,
} from "../../api/client.js";

const ws = useWorkspace();

// 注入方式规则（与后端 lib/skill_db.py _RENDER_MODE_RULES 对齐）
const RENDER_MODE_RULES = {
  camera: {
    needNameEn: false, needExamples: true, showGuide: true, exLang: "en",
    exLabel: "英文触发短语（分号分隔，如 slow push-in；dolly in）",
  },
  term: { needNameEn: true, needExamples: false, showGuide: false },
  example: {
    needNameEn: false, needExamples: true, showGuide: false, exLang: "zh",
    exLabel: "示例（分号分隔，如 长长地呼出一口气；轻叹一声）",
  },
  descriptive: {
    needNameEn: false, needExamples: false, showGuide: true, exLang: "en",
    exLabel: "参考短语（可选，分号分隔）",
  },
  block: { needNameEn: false, needExamples: false, showGuide: false },
};
const RENDER_MODE_OPTIONS = [
  { value: "descriptive", label: "描述型 · 人物/打斗/特效等，自然融入" },
  { value: "camera", label: "运镜型 · 英文触发短语（建议开启关键词保护）" },
  { value: "term", label: "术语型 · 中文名 + 英文对照（景别/构图）" },
  { value: "example", label: "示例型 · 每镜挑一句示例（微表情）" },
  { value: "block", label: "片段型 · 整段内容近似原样（风格/效果）" },
];
const MODE_LABEL = { camera: "运镜", term: "术语", example: "示例", descriptive: "描述", block: "片段" };

const activeCatId = ref(null);
const activeCat = computed(() =>
  ws.skillDict.categories.find((c) => c.id === activeCatId.value)
  || ws.skillDict.categories[0]
  || null
);
const activeMode = computed(() => activeCat.value?.renderMode || "descriptive");
const rules = computed(() => RENDER_MODE_RULES[activeMode.value] || RENDER_MODE_RULES.descriptive);

const catSkills = computed(() =>
  activeCat.value ? ws.skillDict.skills.filter((s) => s.categoryId === activeCat.value.id) : []
);

onMounted(() => ws.loadSkillDict());

// ---- 表格列（按注入方式动态）----
const columns = computed(() => {
  const mode = activeMode.value;
  const cols = [{ prop: "name", label: "名称" }, { prop: "nameEn", label: "英文写法" }];
  cols.push({ prop: "desc", label: mode === "block" ? "内容片段" : "描述" });
  if (mode === "camera" || mode === "descriptive") cols.push({ prop: "guide", label: "写法指南" });
  if (mode === "camera" || mode === "example" || mode === "descriptive") {
    cols.push({ prop: "examples", label: mode === "example" ? "示例" : "短语" });
  }
  return cols;
});

function cellText(row, prop) {
  if (prop === "examples") return (row.examples || []).join(" / ") || "—";
  return row[prop] || "—";
}

// ---- 类别新增 / 编辑 ----
const catDialog = reactive({
  visible: false, editing: null, name: "", description: "",
  renderMode: "descriptive", protectKeywords: false, saving: false,
});

function openCategory(editing = null) {
  catDialog.editing = editing;
  catDialog.name = editing?.name || "";
  catDialog.description = editing?.description || "";
  catDialog.renderMode = editing?.renderMode || "descriptive";
  catDialog.protectKeywords = !!editing?.protectKeywords;
  catDialog.visible = true;
}

async function submitCategory() {
  if (catDialog.saving) return;
  if (!catDialog.name.trim()) {
    ElMessage.warning("类别名称不能为空");
    return;
  }
  catDialog.saving = true;
  try {
    const payload = {
      name: catDialog.name.trim(),
      description: catDialog.description.trim(),
      renderMode: catDialog.renderMode,
      protectKeywords: catDialog.protectKeywords,
    };
    const res = catDialog.editing
      ? await updateSkillCategory({ id: catDialog.editing.id, ...payload })
      : await addSkillCategory(payload);
    if (!res.success) throw new Error(res.error || "保存类别失败");
    await ws.loadSkillDict(true);
    catDialog.visible = false;
    ElMessage.success(catDialog.editing ? "类别已更新" : `类别「${catDialog.name.trim()}」已创建`);
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    catDialog.saving = false;
  }
}

// ---- 技能新增 / 编辑 ----
const dialog = reactive({
  visible: false, editing: null, categoryId: null,
  name: "", nameEn: "", desc: "", guide: "", examples: "", saving: false,
});

const dialogMode = computed(() => {
  const cat = ws.skillDict.categories.find((c) => c.id === dialog.categoryId);
  return cat?.renderMode || "descriptive";
});
const dialogRules = computed(() => RENDER_MODE_RULES[dialogMode.value] || RENDER_MODE_RULES.descriptive);

function openAdd() {
  dialog.editing = null;
  dialog.categoryId = activeCat.value?.id ?? null;
  dialog.name = "";
  dialog.nameEn = "";
  dialog.desc = "";
  dialog.guide = "";
  dialog.examples = "";
  dialog.visible = true;
}

function openEdit(row) {
  dialog.editing = row;
  dialog.categoryId = row.categoryId;
  dialog.name = row.name || "";
  dialog.nameEn = row.nameEn || "";
  dialog.desc = row.desc || "";
  dialog.guide = row.guide || "";
  dialog.examples = (row.examples || []).join("；");
  dialog.visible = true;
}

async function submitDialog() {
  if (dialog.saving) return;
  if (!dialog.name.trim()) {
    ElMessage.warning("名称不能为空");
    return;
  }
  if (dialogRules.value.needNameEn && !dialog.nameEn.trim()) {
    ElMessage.warning("该类别必须填写英文写法（英文翻译阶段对照）");
    return;
  }
  if (dialogRules.value.needExamples && !dialog.examples.trim()) {
    ElMessage.warning(`该类别必须填写${dialogRules.value.exLabel}`);
    return;
  }
  dialog.saving = true;
  try {
    const payload = {
      categoryId: dialog.categoryId,
      name: dialog.name.trim(),
      nameEn: dialog.nameEn.trim(),
      desc: dialog.desc.trim(),
      guide: dialog.guide.trim(),
      examples: dialog.examples.trim(),
    };
    const res = dialog.editing
      ? await updateSkillDict({ id: dialog.editing.id, ...payload })
      : await addSkillDict(payload);
    if (!res.success) throw new Error(res.error || "保存失败");
    await ws.loadSkillDict(true);
    dialog.visible = false;
    ElMessage.success(dialog.editing ? "技能已更新" : `技能「${dialog.name.trim()}」已入库`);
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    dialog.saving = false;
  }
}

async function removeSkill(row) {
  try {
    await ElMessageBox.confirm(`确定删除技能「${row.name}」？`, "删除技能", { type: "warning" });
  } catch {
    return;
  }
  try {
    const res = await deleteSkillDict(row.id);
    if (!res.success) throw new Error(res.error || "删除失败");
    await ws.loadSkillDict(true);
    ElMessage.success("已删除");
  } catch (e) {
    ElMessage.error(e.message || String(e));
  }
}

// ---- 批量导入（每行：名称 | 英文写法 | 示例1；示例2 | 描述(可选)）----
const batch = reactive({ visible: false, categoryId: null, text: "", saving: false });

function openBatch() {
  batch.categoryId = activeCat.value?.id ?? null;
  batch.text = "";
  batch.visible = true;
}

const batchItems = computed(() => {
  const out = [];
  for (const line of batch.text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const parts = s.split(/\t|\|/).map((x) => x.trim());
    const name = parts[0] || "";
    if (!name) continue;
    out.push({ name, nameEn: parts[1] || "", examples: parts[2] || "", desc: parts[3] || "" });
  }
  return out;
});

async function submitBatch() {
  if (batch.saving) return;
  if (!batch.categoryId) {
    ElMessage.warning("请选择类别");
    return;
  }
  if (!batchItems.value.length) {
    ElMessage.warning("未解析到有效词条（每行格式：名称 | 英文写法 | 示例1；示例2 | 描述）");
    return;
  }
  batch.saving = true;
  try {
    const res = await batchAddSkillDict({ categoryId: batch.categoryId, items: batchItems.value });
    if (!res.success) throw new Error(res.error || "批量导入失败");
    await ws.loadSkillDict(true);
    batch.visible = false;
    if (res.failed?.length) {
      const f = res.failed[0];
      ElMessage.warning(`导入完成：成功 ${res.added} 条，失败 ${res.failed.length} 条；首条失败「${f.name}」：${f.error}`);
    } else {
      ElMessage.success(`批量导入完成：新增 ${res.added} 条技能`);
    }
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    batch.saving = false;
  }
}
</script>

<template>
  <section class="mrd-card mrd-section">
    <h3 class="mrd-section-title"><el-icon><component :is="'Grid'" /></el-icon>分镜技能</h3>
    <p class="mrd-skill-sub">
      技能按「注入方式」进入 skill_notes：运镜用英文触发短语，术语型直接写中文名并在英文阶段
      按对照还原，示例型每镜挑一句，描述/片段型自然融入镜头描述。开启「关键词保护」的类别
      （内置为运镜）其技术词会以 &lt;!技术词&gt; 包裹，翻译阶段原样保留。
      触发词写法（如 camera motion 置于开头）请在全局提示词中自行申明。
    </p>

    <div class="mrd-skill-tabs">
      <button
        v-for="c in ws.skillDict.categories" :key="c.id"
        class="mrd-skill-tab" :class="{ active: activeCat?.id === c.id }"
        @click="activeCatId = c.id"
      >
        {{ c.name }}
        <span v-if="c.protectKeywords" class="mrd-skill-tab-badge">保护</span>
      </button>
      <div class="mrd-skill-actions">
        <el-button size="small" :icon="'Plus'" @click="openCategory(null)">新建类别</el-button>
        <el-button size="small" :icon="'EditPen'" :disabled="!activeCat" @click="openCategory(activeCat)">编辑类别</el-button>
        <el-button size="small" :icon="'Plus'" @click="openAdd">添加技能</el-button>
        <el-button size="small" :icon="'Upload'" @click="openBatch">批量导入</el-button>
      </div>
    </div>

    <p v-if="activeCat" class="mrd-skill-cat-desc">
      <el-tag size="small" effect="plain">{{ MODE_LABEL[activeMode] || activeMode }}</el-tag>
      <el-tag v-if="activeCat.protectKeywords" size="small" effect="plain" type="warning">关键词保护</el-tag>
      <span v-if="activeCat.description">{{ activeCat.description }}</span>
    </p>

    <el-table :data="catSkills" size="small" class="mrd-skill-table" :key="activeCat?.id">
      <el-table-column
        v-for="col in columns" :key="col.prop"
        :prop="col.prop" :label="col.label" :min-width="col.prop === 'guide' ? 240 : 130"
      >
        <template #default="{ row }">{{ cellText(row, col.prop) }}</template>
      </el-table-column>
      <el-table-column label="" width="130" align="right">
        <template #default="{ row }">
          <el-button size="small" text :icon="'Edit'" @click="openEdit(row)" />
          <el-button size="small" text type="danger" :icon="'Delete'" :disabled="row.builtin" @click="removeSkill(row)" />
        </template>
      </el-table-column>
      <template #empty>
        {{ ws.skillDict.loading ? "技能词典加载中…" : "该类别暂无技能" }}
      </template>
    </el-table>

    <!-- 类别弹窗：注入方式 / 关键词保护 -->
    <el-dialog v-model="catDialog.visible" :title="catDialog.editing ? '编辑类别' : '新建类别'" width="480px" append-to-body>
      <div class="mrd-field">
        <label>类别名称（分镜选择按类别名存储，重命名会影响已有选择）</label>
        <el-input v-model="catDialog.name" placeholder="如：人物主体 / 打斗 / 特效" />
      </div>
      <div class="mrd-field">
        <label>注入方式</label>
        <el-select v-model="catDialog.renderMode" style="width: 100%">
          <el-option v-for="m in RENDER_MODE_OPTIONS" :key="m.value" :label="m.label" :value="m.value" />
        </el-select>
      </div>
      <div class="mrd-field mrd-field-row">
        <label>关键词保护（技术词用 &lt;!…&gt; 包裹，翻译阶段原样保留）</label>
        <el-switch v-model="catDialog.protectKeywords" />
      </div>
      <div class="mrd-field">
        <label>类别说明（可选，展示于分镜技能区）</label>
        <el-input v-model="catDialog.description" type="textarea" :rows="2" />
      </div>
      <template #footer>
        <el-button @click="catDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="catDialog.saving" @click="submitCategory">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新增 / 编辑技能弹窗 -->
    <el-dialog v-model="dialog.visible" :title="dialog.editing ? '编辑技能' : '添加技能'" width="560px" append-to-body>
      <div class="mrd-field">
        <label>类别</label>
        <el-select v-model="dialog.categoryId" :disabled="!!dialog.editing" style="width: 100%">
          <el-option v-for="c in ws.skillDict.categories" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </div>
      <div class="mrd-field">
        <label>名称（中文名直接写入提示词）</label>
        <el-input v-model="dialog.name" placeholder="如：大远景 / 双人镜头 / 轻叹 / 推近 Push-in" />
      </div>
      <div class="mrd-field">
        <label>英文写法{{ dialogRules.needNameEn ? "（必填，英文翻译阶段对照）" : "（可选）" }}</label>
        <el-input v-model="dialog.nameEn" placeholder="如：extreme wide shot / two-shot / Soft sigh" />
      </div>
      <div class="mrd-field">
        <label>描述{{ dialogMode === "block" ? "（片段型：整段内容会近似原样进入提示词）" : "（可选，悬停提示 / 融入说明）" }}</label>
        <el-input v-model="dialog.desc" :type="dialogMode === 'block' ? 'textarea' : 'text'" :rows="2" placeholder="一句话说明" />
      </div>
      <div v-if="dialogRules.showGuide" class="mrd-field">
        <label>写法指南（可选：星级 / 强度 / 方向写法）</label>
        <el-input v-model="dialog.guide" type="textarea" :rows="2" placeholder="如：★★★ 最稳。建议写法：slow push-in / dolly in；更舒缓加 slow。" />
      </div>
      <div v-if="dialogRules.needExamples || dialogRules.showGuide" class="mrd-field">
        <label>{{ dialogRules.exLabel || "参考短语（可选，分号分隔）" }}</label>
        <el-input v-model="dialog.examples" type="textarea" :rows="2"
          :placeholder="dialogRules.exLang === 'zh' ? '长长地呼出一口气；轻叹一声' : 'slow push-in；dolly in；push in'" />
      </div>
      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="dialog.saving" @click="submitDialog">保存</el-button>
      </template>
    </el-dialog>

    <!-- 批量导入弹窗 -->
    <el-dialog v-model="batch.visible" title="批量导入技能" width="640px" append-to-body>
      <div class="mrd-field">
        <label>导入到类别</label>
        <el-select v-model="batch.categoryId" style="width: 100%">
          <el-option v-for="c in ws.skillDict.categories" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </div>
      <div class="mrd-field">
        <label>词条文本（每行一条：名称 | 英文写法 | 示例1；示例2 | 描述(可选)，# 开头为注释）</label>
        <el-input v-model="batch.text" type="textarea" :rows="8" placeholder="大远景 | extreme wide shot&#10;轻叹 | Soft sigh | 长长地呼出一口气；轻叹一声&#10;慢速推近 | | slow push-in | 缓慢向前推进" />
      </div>
      <p v-if="batchItems.length" class="mrd-field-hint">已解析 {{ batchItems.length }} 条词条</p>
      <template #footer>
        <el-button @click="batch.visible = false">取消</el-button>
        <el-button type="primary" :loading="batch.saving" @click="submitBatch">导入</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.mrd-section { padding: 18px 22px; }
.mrd-section-title {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
  color: #edeff5;
  display: flex;
  align-items: center;
  gap: 8px;
}
.mrd-section-title :deep(.el-icon) { color: #a78bfa; }
.mrd-skill-sub { margin: 0 0 14px; font-size: 12px; color: #6b7488; line-height: 1.7; }
.mrd-skill-tabs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.mrd-skill-tab {
  padding: 5px 14px; border-radius: 14px; border: 1px solid #2a3042;
  background: transparent; color: #a9b1c3; font-size: 12.5px; cursor: pointer;
  transition: all 0.18s ease;
}
.mrd-skill-tab:hover { color: #edeff5; border-color: #6c5ce7; }
.mrd-skill-tab.active {
  color: #fff; border-color: #6c5ce7;
  background: rgba(108, 92, 231, 0.18);
}
.mrd-skill-tab-badge {
  margin-left: 5px; font-size: 10px; color: #f0b46a;
  border: 1px solid rgba(240, 180, 106, 0.4); border-radius: 8px; padding: 0 5px;
}
.mrd-skill-actions { margin-left: auto; display: flex; gap: 8px; }
.mrd-skill-cat-desc {
  margin: 0 0 10px; font-size: 11.5px; color: #8b93a7; line-height: 1.7;
  padding: 8px 12px; border-radius: 8px; background: rgba(108, 92, 231, 0.08);
  display: flex; align-items: center; gap: 8px;
}
.mrd-skill-table { width: 100%; }
.mrd-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.mrd-field-row { flex-direction: row; align-items: center; justify-content: space-between; }
.mrd-field > label { font-size: 12px; color: #a9b1c3; }
.mrd-field-hint { font-size: 11.5px; color: #6b7488; margin: 4px 0 0; }
</style>
