<script setup>
// 全局参数 · 分镜技能词典管理面板（运镜/景别/镜头结构/微表情 + 自定义类别）
// 按类别动态字段：运镜=名称+英文写法+指南+英文触发短语；景别/镜头结构=中文名+英文写法；
// 微表情=名称+中文示例数组；自定义类别=名称+描述。支持新增 / 编辑 / 删除 / 批量导入。
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import {
  addSkillDict, addSkillCategory, batchAddSkillDict, deleteSkillDict, updateSkillDict,
} from "../../api/client.js";

const ws = useWorkspace();

// 类别字段规则（与后端 lib/skill_db.py _CATEGORY_RULES 对齐）
const CATEGORY_RULES = {
  "运镜": { needNameEn: false, needExamples: true, exLabel: "英文触发短语（分号分隔，如 slow push-in；dolly in）", showGuide: true, exLang: "en" },
  "景别": { needNameEn: true, needExamples: false, showGuide: false },
  "镜头结构": { needNameEn: true, needExamples: false, showGuide: false },
  "微表情": { needNameEn: false, needExamples: true, exLabel: "中文示例（分号分隔，如 长长地呼出一口气；轻叹一声）", showGuide: false, exLang: "zh" },
};

const activeCatId = ref(null);
const activeCat = computed(() =>
  ws.skillDict.categories.find((c) => c.id === activeCatId.value)
  || ws.skillDict.categories[0]
  || null
);
const rules = computed(() =>
  (activeCat.value && CATEGORY_RULES[activeCat.value.name]) || { needNameEn: false, needExamples: false, showGuide: false }
);
const isBuiltin = computed(() => !!(activeCat.value && CATEGORY_RULES[activeCat.value.name]));

const catSkills = computed(() =>
  activeCat.value ? ws.skillDict.skills.filter((s) => s.categoryId === activeCat.value.id) : []
);

onMounted(() => ws.loadSkillDict());

// ---- 表格列（按类别动态）----
const columns = computed(() => {
  const name = activeCat.value?.name || "";
  const cols = [{ prop: "name", label: "名称" }];
  if (isBuiltin.value) cols.push({ prop: "nameEn", label: "英文写法" });
  if (name === "运镜") cols.push({ prop: "guide", label: "写法指南" });
  if (name === "运镜" || name === "微表情") cols.push({ prop: "examples", label: name === "运镜" ? "触发短语" : "中文示例" });
  if (!isBuiltin.value) cols.push({ prop: "desc", label: "描述" });
  return cols;
});

function cellText(row, prop) {
  if (prop === "examples") return (row.examples || []).join(" / ") || "—";
  return row[prop] || "—";
}

// ---- 新增 / 编辑弹窗（按类别动态字段）----
const dialog = reactive({
  visible: false,
  editing: null, // 编辑时为词条对象
  categoryId: null,
  name: "",
  nameEn: "",
  desc: "",
  guide: "",
  examples: "", // 分号分隔
  saving: false,
});

const dialogRules = computed(() => {
  const cat = ws.skillDict.categories.find((c) => c.id === dialog.categoryId);
  return (cat && CATEGORY_RULES[cat.name]) || { needNameEn: false, needExamples: false, showGuide: false };
});
const dialogIsBuiltin = computed(() => {
  const cat = ws.skillDict.categories.find((c) => c.id === dialog.categoryId);
  return !!(cat && CATEGORY_RULES[cat.name]);
});

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
    if (!s || s.startsWith("#")) continue; // 空行 / 注释行跳过
    const parts = s.split(/\t|\|/).map((x) => x.trim());
    const name = parts[0] || "";
    if (!name) continue;
    out.push({
      name,
      nameEn: parts[1] || "",
      examples: parts[2] || "",
      desc: parts[3] || "",
    });
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
    const res = await batchAddSkillDict({
      categoryId: batch.categoryId,
      items: batchItems.value,
    });
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
      运镜类保留 Camera Motion LoRA 触发词库（触发词 camera motion 必须置于提示词开头）；
      景别与镜头结构直接使用中文名称；微表情使用中文示例数组。
    </p>

    <div class="mrd-skill-tabs">
      <button
        v-for="c in ws.skillDict.categories" :key="c.id"
        class="mrd-skill-tab" :class="{ active: activeCat?.id === c.id }"
        @click="activeCatId = c.id"
      >{{ c.name }}</button>
      <div class="mrd-skill-actions">
        <el-button size="small" :icon="'Plus'" @click="openAdd">添加技能</el-button>
        <el-button size="small" :icon="'Upload'" @click="openBatch">批量导入</el-button>
      </div>
    </div>

    <p v-if="activeCat?.description" class="mrd-skill-cat-desc">{{ activeCat.description }}</p>

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

    <!-- 新增 / 编辑弹窗 -->
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
      <div v-if="dialogIsBuiltin" class="mrd-field">
        <label>英文写法{{ dialogRules.needNameEn ? "（必填，英文翻译阶段对照）" : "（可选）" }}</label>
        <el-input v-model="dialog.nameEn" placeholder="如：extreme wide shot / two-shot / Soft sigh" />
      </div>
      <div v-if="!dialogIsBuiltin || dialogRules.showGuide" class="mrd-field">
        <label>描述{{ dialogIsBuiltin ? "（可选）" : "" }}</label>
        <el-input v-model="dialog.desc" placeholder="一句话说明" />
      </div>
      <div v-if="dialogRules.showGuide" class="mrd-field">
        <label>写法指南（可选：星级 / 强度 / 方向写法）</label>
        <el-input v-model="dialog.guide" type="textarea" :rows="2" placeholder="如：★★★ 最稳。建议写法：slow push-in / dolly in；更舒缓加 slow。" />
      </div>
      <div v-if="dialogRules.needExamples || dialogRules.showGuide" class="mrd-field">
        <label v-if="dialogRules.needExamples">{{ dialogRules.exLabel }}</label>
        <label v-else>英文触发短语（可选，分号分隔）</label>
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
.mrd-skill-actions { margin-left: auto; display: flex; gap: 8px; }
.mrd-skill-cat-desc {
  margin: 0 0 10px; font-size: 11.5px; color: #8b93a7; line-height: 1.7;
  padding: 8px 12px; border-radius: 8px; background: rgba(108, 92, 231, 0.08);
}
.mrd-skill-table { width: 100%; }
.mrd-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.mrd-field > label { font-size: 12px; color: #a9b1c3; }
.mrd-field-hint { font-size: 11.5px; color: #6b7488; margin: 4px 0 0; }
</style>
