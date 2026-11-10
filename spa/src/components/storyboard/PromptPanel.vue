<script setup>
// 提示词区：el-splitter 可折叠拖拽分栏
// 左栏（纵向）：镜头技能（SQLite 技能词典，悬停显示描述，弹窗新增技能）/ 用户提示词
// 右栏：H3 提示词四段（detailed_description 右侧带「自定义全局提示词」开关）
import { computed, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import { useSplitterMemory } from "../../utils/splitter.js";
import { generateH3Prompt } from "../../utils/llm.js";
import { addSkillDict, addSkillCategory, batchAddSkillDict } from "../../api/client.js";
import { framesToSeconds } from "../../utils/media.js";
import { REF_MENTION_TYPES, mergeSegmentSubjects } from "../../constants/subject.js";
import PromptEditor from "../common/PromptEditor.vue";

const props = defineProps({
  segment: { type: Object, required: true },
});
const ws = useWorkspace();

// 分栏尺寸记忆（左右分栏 / 左栏内部纵向，拖拽后写 localStorage）
const hSplit = useSplitterMemory("mrd-prompt-split-h", [46, 54]);
const vSplit = useSplitterMemory("mrd-prompt-split-v", [40, 60]);

const translating = ref(""); // "" | "zh" | "en"

// 技能组：只来自 SQLite 技能词典（workspace.loadSkillDict），无内置回退
const groups = computed(() => ws.skillGroups);

// 提及候选：本分镜生效主体（全局 + 段级自定义副本按名合并）
const mentionCandidates = computed(() =>
  mergeSegmentSubjects(ws.subjects.subjects, props.segment.subjectsOverride)
);
const mentionTypes = computed(() => {
  const all = new Set();
  for (const arr of Object.values(REF_MENTION_TYPES)) arr.forEach((t) => all.add(t));
  return [...all];
});

function segSkills(field) {
  return props.segment?.[field] || [];
}

// field="" 的自定义类别没有对应 segment 字段，统一写进 segment.extraSkills
function toggleSkill(group, key) {
  const field = group.field || "extraSkills";
  const arr = props.segment[field] || (props.segment[field] = []);
  const idx = arr.indexOf(key);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(key);
  ws.markDirty();
}

// ---- 新增技能弹窗（按类别动态字段：nameEn/guide/examples） ----
// 类别规则与后端 lib/skill_db.py _CATEGORY_RULES 对齐：
//   运镜=名称+英文触发短语（指南可选）；景别/镜头结构=中文名+英文写法；
//   微表情=名称+中文示例数组；自定义类别=名称+描述。
const CATEGORY_RULES = {
  "运镜": { needNameEn: false, needExamples: true, showGuide: true, exLabel: "英文触发短语", exZh: false },
  "景别": { needNameEn: true, needExamples: false, showGuide: false, exLabel: "", exZh: false },
  "镜头结构": { needNameEn: true, needExamples: false, showGuide: false, exLabel: "", exZh: false },
  "微表情": { needNameEn: false, needExamples: true, showGuide: false, exLabel: "中文示例", exZh: true },
};
const addDialog = reactive({
  visible: false,
  categoryId: null,
  name: "",
  nameEn: "",
  desc: "",
  guide: "",
  examples: "",
  newCategory: "",
  saving: false,
});

const addDialogRules = computed(() => {
  const cat = ws.skillDict.categories.find((c) => c.id === addDialog.categoryId);
  return (cat && CATEGORY_RULES[cat.name]) || { needNameEn: false, needExamples: false, showGuide: false, exLabel: "", exZh: false };
});

function openAddDialog(group) {
  addDialog.categoryId = group?.categoryId ?? null;
  addDialog.name = "";
  addDialog.nameEn = "";
  addDialog.desc = "";
  addDialog.guide = "";
  addDialog.examples = "";
  addDialog.newCategory = "";
  addDialog.visible = true;
}

async function submitAddSkill() {
  if (addDialog.saving) return;
  if (!addDialog.name.trim()) {
    ElMessage.warning("名称为必填（中文名直接写入提示词）");
    return;
  }
  if (addDialogRules.value.needNameEn && !addDialog.nameEn.trim()) {
    ElMessage.warning("该类别必须填写英文写法（英文翻译阶段对照）");
    return;
  }
  if (addDialogRules.value.needExamples && !addDialog.examples.trim()) {
    ElMessage.warning(`该类别必须填写${addDialogRules.value.exLabel}（分号分隔）`);
    return;
  }
  addDialog.saving = true;
  try {
    let categoryId = addDialog.categoryId;
    const newCat = addDialog.newCategory.trim();
    if (newCat) {
      const catRes = await addSkillCategory({ name: newCat });
      if (!catRes.success) throw new Error(catRes.error || "新增类别失败");
      categoryId = catRes.id;
    }
    if (!categoryId) {
      ElMessage.warning("请选择类别");
      return;
    }
    const res = await addSkillDict({
      categoryId,
      name: addDialog.name.trim(),
      nameEn: addDialog.nameEn.trim(),
      desc: addDialog.desc.trim(),
      guide: addDialog.guide.trim(),
      examples: addDialog.examples.trim(),
    });
    if (!res.success) throw new Error(res.error || "新增技能失败");
    await ws.loadSkillDict(true);
    addDialog.visible = false;
    ElMessage.success(`技能「${addDialog.name.trim()}」已入库`);
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    addDialog.saving = false;
  }
}

// ---- 技能词典批量导入（每行一条：名称 | 英文写法 | 示例1；示例2 | 描述(可选)） ----
const batchDialog = reactive({
  visible: false,
  categoryId: null,
  newCategory: "",
  text: "",
  saving: false,
});

function openBatchDialog(group) {
  batchDialog.categoryId = group?.categoryId ?? null;
  batchDialog.newCategory = "";
  batchDialog.text = "";
  batchDialog.visible = true;
}

const batchItems = computed(() => {
  const out = [];
  for (const line of batchDialog.text.split(/\r?\n/)) {
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

async function submitBatchImport() {
  if (batchDialog.saving) return;
  if (!batchDialog.newCategory.trim() && !batchDialog.categoryId) {
    ElMessage.warning("请选择类别或填写新类别");
    return;
  }
  if (!batchItems.value.length) {
    ElMessage.warning("未解析到有效词条（每行格式：名称 | 英文写法 | 示例1；示例2 | 描述）");
    return;
  }
  batchDialog.saving = true;
  try {
    const res = await batchAddSkillDict({
      categoryId: batchDialog.categoryId || 0,
      newCategory: batchDialog.newCategory.trim(),
      items: batchItems.value,
    });
    if (!res.success) throw new Error(res.error || "批量导入失败");
    await ws.loadSkillDict(true);
    batchDialog.visible = false;
    if (res.failed?.length) {
      const f = res.failed[0];
      ElMessage.warning(
        `导入完成：成功 ${res.added} 条，失败 ${res.failed.length} 条；首条失败「${f.name}」：${f.error}`
      );
    } else {
      ElMessage.success(`批量导入完成：新增 ${res.added} 条技能`);
    }
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    batchDialog.saving = false;
  }
}

// ---- H3 提示词四段 ----
const H3_FIELDS = [
  { key: "summary", label: "summary", minHeight: 56 },
  { key: "detailed_description", label: "detailed_description", minHeight: 132 },
  { key: "overall_soundscape", label: "overall_soundscape", minHeight: 56 },
  { key: "non_diegetic_music", label: "non_diegetic_music", minHeight: 56 },
];

function ensureH3() {
  if (!props.segment.h3PromptJson || typeof props.segment.h3PromptJson !== "object") {
    props.segment.h3PromptJson = {
      summary: "",
      detailed_description: "",
      overall_soundscape: "",
      non_diegetic_music: "",
    };
  }
  return props.segment.h3PromptJson;
}

const h3 = computed(() => ensureH3());

// ---- 原生 → H3 生成（中 / 英） ----
// 点「转H3提示词」时才使用分镜技能：把该镜头所选技能的词典内容渲染成注入块
// （对齐后端 generate_h3_prompt 的四类指令块，转化方法与旧导演台一致）。
function buildSkillNotes() {
  const seg = props.segment;
  const cats = new Map(ws.skillDict.categories.map((c) => [c.id, c.name]));
  const byCat = {};
  for (const s of ws.skillDict.skills || []) {
    const cat = cats.get(s.categoryId);
    if (cat) (byCat[cat] = byCat[cat] || []).push(s);
  }
  const pick = (cat, keys) => (byCat[cat] || []).filter((s) => (keys || []).includes(s.key));
  const lines = [];
  const cam = pick("运镜", seg.cameraMotions || []);
  if (cam.length) {
    lines.push("## 运镜方向");
    for (const s of cam) {
      lines.push(`- 风格：${s.name}（${s.nameEn || s.name}）`);
      if (s.desc) lines.push(`  - ${s.desc}`);
      if (s.guide) lines.push(`  - 写法指南：${s.guide}`);
      if (s.examples?.length) {
        lines.push(`  - 英文触发短语（原样保留，与触发词 camera motion 连用）：${s.examples.join(" / ")}`);
      }
    }
    lines.push(
      "- 触发词 camera motion 必须位于运镜短语开头，写成「中文运镜描写（camera motion, <英文触发短语>）」；英文短语不得翻译或改写。"
    );
  }
  const sizes = pick("景别", seg.shotSizes || []);
  if (sizes.length) {
    lines.push("## 景别方向");
    for (const s of sizes) {
      lines.push(`- 档位：${s.name}（英文阶段对照：${s.nameEn || s.name}）——把中文名直接写入镜头描述`);
    }
  }
  const framings = pick("镜头结构", seg.framings || []);
  if (framings.length) {
    lines.push("## 构图与镜头关系方向");
    for (const s of framings) {
      lines.push(`- 关系：${s.name}（英文阶段对照：${s.nameEn || s.name}）——仅当内容适用时把中文名直接写入该镜头`);
    }
  }
  const exprs = pick("微表情", seg.expressions || []);
  if (exprs.length) {
    lines.push("## 微表情与表演方向");
    for (const s of exprs) {
      lines.push(`- Cue：${s.name}（${s.nameEn || s.name}）`);
      if (s.examples?.length) {
        lines.push(`  - 中文示例（每镜挑一句自然融入，不写技能名）：${s.examples.join(" / ")}`);
      } else if (s.desc) {
        lines.push(`  - 按含义自然展开：${s.desc}`);
      }
    }
  }
  return lines.join("\n");
}

async function generateH3(lang) {
  const seg = props.segment;
  if (!(seg.prompt || "").trim()) {
    ElMessage.warning("请先输入用户提示词");
    return;
  }
  translating.value = lang;
  try {
    const payload = {
      prompt: seg.prompt,
      image_path: seg.imageFile || "",
      duration_seconds: framesToSeconds(seg.length, ws.widgets.frame_rate),
      lang,
      camera_motion: seg.cameraMotions || [],
      expression: seg.expressions || [],
      // 微表情 catalog：技能词典加载后用 DB 词条（含 desc），否则回退旧自定义词库
      expression_catalog:
        (ws.skillGroups.find((g) => g.label === "微表情")?.items || []).map((s) => ({
          key: s.key, label: s.label, title: s.desc || "",
        })) || ws.customSkills.expressions || [],
      shot_size: seg.shotSizes || [],
      framing: seg.framings || [],
      // 技能词典注入块（deepseek-proxy 路径使用；服务端路径由 generate_h3_prompt 注入）
      skill_notes: buildSkillNotes(),
    };
    const res = await generateH3Prompt(ws.llm, payload);
    if (!res.success) {
      ElMessage.error(res.error || "H3 提示词生成失败");
      return;
    }
    const data = res.json_data || {};
    h3.value.summary = data.summary ?? h3.value.summary;
    h3.value.detailed_description = data.detailed_description ?? h3.value.detailed_description;
    h3.value.overall_soundscape = data.overall_soundscape ?? h3.value.overall_soundscape;
    h3.value.non_diegetic_music = data.non_diegetic_music ?? h3.value.non_diegetic_music;
    ws.markDirty();
    ElMessage.success(lang === "zh" ? "中文 H3 提示词已生成" : "英文 H3 提示词已生成");
  } catch (e) {
    ElMessage.error(`生成失败：${e.message || e}`);
  } finally {
    translating.value = "";
  }
}
</script>

<template>
  <el-splitter class="mrd-prompt-panel" @resize-end="hSplit.onResizeEnd">
    <!-- 左栏：镜头技能 / 用户提示词（纵向分栏，可折叠拖拽） -->
    <el-splitter-panel :size="hSplit.sizes[0]" :min="28" collapsible>
      <el-splitter layout="vertical" @resize-end="vSplit.onResizeEnd">
        <el-splitter-panel :size="vSplit.sizes[0]" :min="12" collapsible>
          <div class="mrd-skills">
            <div class="mrd-skills-head">
              <span>镜头技能</span>
              <el-tooltip content="选中后随生成请求携带，由 LLM 分配到各 [Shot N]；不选 = 由模型自由决定" placement="bottom">
                <el-icon class="mrd-skills-help"><component :is="'QuestionFilled'" /></el-icon>
              </el-tooltip>
              <span class="mrd-skills-head-gap"></span>
              <el-button size="small" text type="primary" @click="openBatchDialog()">批量导入</el-button>
            </div>
            <el-scrollbar class="mrd-skills-scroll">
              <div v-if="!groups.length" class="mrd-skill-empty">
                {{ ws.skillDict.loading ? "技能词典加载中…" : "技能词典为空或加载失败（重启后端后重试）" }}
              </div>
              <div v-for="g in groups" :key="g.id" class="mrd-skill-group">
                <div class="mrd-skill-group-title">
                  {{ g.label }}
                  <span v-if="g.description" class="mrd-skill-group-desc">{{ g.description }}</span>
                </div>
                <div class="mrd-skill-pills">
                  <el-tooltip
                    v-for="it in g.items"
                    :key="it.key"
                    effect="dark"
                    placement="top"
                    :show-after="250"
                  >
                    <template #content>
                      <div class="mrd-skill-tip">
                        <div class="mrd-skill-tip-name">{{ it.label }}</div>
                        <div v-if="it.desc" class="mrd-skill-tip-desc">{{ it.desc }}</div>
                        <div v-if="it.nameEn" class="mrd-skill-tip-kw">英文：{{ it.nameEn }}</div>
                        <div v-if="it.guide" class="mrd-skill-tip-ex">指南：{{ it.guide }}</div>
                        <div v-if="it.examples && it.examples.length" class="mrd-skill-tip-ex">
                          例：{{ it.examples.join("；") }}
                        </div>
                      </div>
                    </template>
                    <button
                      class="mrd-skill-pill"
                      :class="{ on: segSkills(g.field || 'extraSkills').includes(it.key) }"
                      @click="toggleSkill(g, it.key)"
                    >{{ it.label }}</button>
                  </el-tooltip>
                  <button class="mrd-skill-pill add" title="新增技能（入库到技能词典）" @click="openAddDialog(g)">＋</button>
                </div>
              </div>
            </el-scrollbar>
          </div>
        </el-splitter-panel>
        
        <el-splitter-panel :size="vSplit.sizes[1]" :min="30" collapsible>
          <div class="mrd-native-card">
            <div class="mrd-col-title">
              <div class="mrd-col-title-left">
                用户提示词
                <span class="mrd-col-hint">输入 @ 可引用主体</span>
              </div>
              <el-button
                  size="small"
                  type="primary"
                  :loading="translating === 'zh'"
                  :disabled="!!translating && translating !== 'zh'"
                  :icon="'MagicStick'"
                  @click="generateH3('zh')"
                >转H3提示词</el-button>
            </div>
            <!-- 输入框下边框：左低右高，中间曲线连接（fill 与编辑器背景同色，视觉上是下边框本身） -->
            <div class="mrd-curve-shell">
              <PromptEditor
                :model-value="segment.prompt"
                :allow-hash="false"
                placeholder="原生分镜提示词（可中文，支持 <@主体> 标签）；生成时会自动翻译"
                :candidates="mentionCandidates"
                :allowed-types="mentionTypes"
                only-referencable
                @update:model-value="v => { segment.prompt = v; ws.markDirty(); }"
              />
            </div>
          </div>
        </el-splitter-panel>
      </el-splitter>
    </el-splitter-panel>

    <!-- 右栏：H3 提示词 -->
    <el-splitter-panel :size="hSplit.sizes[1]" :min="28" collapsible>
      <div class="mrd-h3-card">
      <div class="mrd-h3-head">
        <span class="mrd-col-title">H3 提示词</span>
        <span class="mrd-col-hint">输入 @ 或 # 可引用主体</span>
      </div>
      <el-scrollbar class="mrd-h3-scroll">
        <div class="mrd-h3-body">
          <div v-for="f in H3_FIELDS" :key="f.key" class="mrd-h3-section">
            <div class="mrd-h3-label-row">
              <label class="mrd-h3-label">{{ f.label }}</label>
              <el-tooltip
                v-if="f.key === 'detailed_description'"
                content="开启后该镜头生成与预览不再拼接全局提示词（detailed_description 完全由本镜头内容驱动）"
                placement="top"
              >
                <label class="mrd-h3-switch" :class="{ on: !!segment.h3NoGlobalPrompt }">
                  <el-switch
                    size="small"
                    :model-value="!!segment.h3NoGlobalPrompt"
                    @change="v => { segment.h3NoGlobalPrompt = !!v; ws.markDirty(); }"
                  />
                  自定义全局提示词
                </label>
              </el-tooltip>
            </div>
            <PromptEditor
              :model-value="h3[f.key]"
              :min-height="f.minHeight"
              :candidates="mentionCandidates"
              :allowed-types="mentionTypes"
              only-referencable
              @update:model-value="v => { h3[f.key] = v; ws.markDirty(); }"
            />
          </div>
        </div>
      </el-scrollbar>
      </div>
    </el-splitter-panel>
  </el-splitter>

  <!-- 新增技能弹窗 -->
    <el-dialog v-model="addDialog.visible" title="新增镜头技能" width="440px" append-to-body>
      <div class="mrd-add-skill-form">
        <div class="mrd-add-skill-row">
          <span class="mrd-add-skill-label">类别</span>
          <el-select v-model="addDialog.categoryId" placeholder="选择类别" style="flex:1">
            <el-option
              v-for="c in ws.skillDict.categories"
              :key="c.id"
              :label="c.name"
              :value="c.id"
            />
          </el-select>
        </div>
        <div class="mrd-add-skill-row">
          <span class="mrd-add-skill-label">新类别</span>
          <el-input v-model="addDialog.newCategory" size="small" placeholder="留空则使用上面选中的类别；填写则创建新类别" />
        </div>
        <div class="mrd-add-skill-row">
          <span class="mrd-add-skill-label">名称</span>
          <el-input v-model="addDialog.name" placeholder="中文名直接写入提示词，如「大远景」「轻叹」" />
        </div>
        <div class="mrd-add-skill-row">
          <span class="mrd-add-skill-label">英文写法</span>
          <el-input
            v-model="addDialog.nameEn"
            :placeholder="addDialogRules.needNameEn ? '必填：英文标准写法（如 extreme wide shot / two-shot）' : '可选：英文写法（供英文翻译阶段对照）'"
          />
        </div>
        <div class="mrd-add-skill-row">
          <span class="mrd-add-skill-label">描述</span>
          <el-input v-model="addDialog.desc" type="textarea" :rows="2" placeholder="悬停胶囊时展示的技能描述（可选）" />
        </div>
        <div v-if="addDialogRules.showGuide" class="mrd-add-skill-row">
          <span class="mrd-add-skill-label">写法指南</span>
          <el-input v-model="addDialog.guide" type="textarea" :rows="2" placeholder="可选：星级 / 强度 / 方向写法，如「★★★ 最稳。建议 slow push-in / dolly in」" />
        </div>
        <div v-if="addDialogRules.needExamples || addDialogRules.showGuide" class="mrd-add-skill-row">
          <span class="mrd-add-skill-label">示例</span>
          <el-input
            v-model="addDialog.examples"
            type="textarea"
            :rows="2"
            :placeholder="addDialogRules.needExamples
              ? (addDialogRules.exZh ? '必填：中文示例（分号分隔），如「长长地呼出一口气；轻叹一声」' : '必填：英文触发短语（分号分隔），如 slow push-in；dolly in')
              : '可选：英文触发短语（分号分隔）'"
          />
        </div>
      </div>
      <template #footer>
        <el-button @click="addDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="addDialog.saving" @click="submitAddSkill">保存到词典</el-button>
      </template>
    </el-dialog>

  <!-- 技能词典批量导入弹窗 -->
  <el-dialog v-model="batchDialog.visible" title="批量导入镜头技能" width="520px" append-to-body>
    <div class="mrd-add-skill-form">
      <div class="mrd-add-skill-row">
        <span class="mrd-add-skill-label">类别</span>
        <el-select v-model="batchDialog.categoryId" placeholder="选择类别" style="flex:1" clearable>
          <el-option
            v-for="c in ws.skillDict.categories"
            :key="c.id"
            :label="c.name"
            :value="c.id"
          />
        </el-select>
      </div>
      <div class="mrd-add-skill-row">
        <span class="mrd-add-skill-label">新类别</span>
        <el-input v-model="batchDialog.newCategory" size="small" placeholder="留空则使用上面选中的类别；填写则创建新类别（同名复用）" />
      </div>
      <div class="mrd-add-skill-row">
        <span class="mrd-add-skill-label">词条</span>
        <el-input
          v-model="batchDialog.text"
          type="textarea"
          :rows="10"
          placeholder="每行一条：名称 | 英文写法 | 示例1；示例2 | 描述(可选)&#10;以 | 或 Tab 分隔；# 开头为注释行&#10;例：大远景 | extreme wide shot&#10;例：轻叹 | Soft sigh | 长长地呼出一口气；轻叹一声&#10;例：慢速推近 | | slow push-in | 缓慢向前推进"
        />
      </div>
      <div class="mrd-batch-preview">
        已解析 <b>{{ batchItems.length }}</b> 条有效词条（名称必填；英文写法/示例按类别必填）
      </div>
    </div>
    <template #footer>
      <el-button @click="batchDialog.visible = false">取消</el-button>
      <el-button type="primary" :loading="batchDialog.saving" :disabled="!batchItems.length" @click="submitBatchImport">
        导入 {{ batchItems.length || "" }} 条
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mrd-prompt-panel {
  flex: 1;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
/* 分隔条暗色化：拖拽线 + 折叠箭头（左右分栏与左栏纵向分栏共用） */
.mrd-prompt-panel :deep(.el-splitter-bar__dragger:before) { background-color: #2a3042; }
.mrd-prompt-panel :deep(.el-splitter-bar__dragger:hover:not(.is-disabled):before),
.mrd-prompt-panel :deep(.el-splitter-bar__dragger-active:before) { background-color: #6c5ce7; }
.mrd-prompt-panel :deep(.el-splitter-bar__collapse-icon) {
  background: #2a3042;
  color: #a9b1c3;
}
.mrd-prompt-panel :deep(.el-splitter-bar__collapse-icon:hover) { background-color: #6c5ce7; }
.mrd-skills {
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: #151821;
  padding: 10px 0;
  overflow: hidden;
}
.mrd-skills-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; font-weight: 600; color: #a9b1c3;
  margin-bottom: 8px; flex: none; padding: 0 10px;
}
.mrd-skills-head-gap { flex: 1; }
.mrd-batch-preview { font-size: 11px; color: #6b7488; }
.mrd-batch-preview b { color: #a9b1c3; }
.mrd-skills-help { color: #4b5266; cursor: help; }
.mrd-skills-scroll { flex: 1; min-height: 0; }
.mrd-skill-empty { font-size: 11px; color: #4b5366; padding: 8px 2px; }
.mrd-skill-group { margin-bottom: 10px; }
.mrd-skill-group-title { font-size: 11px; color: #6b7488; margin-bottom: 5px; 
  letter-spacing: 0.5px; padding: 0 10px; }
.mrd-skill-group-desc { font-size: 10px; color: #4b5366; margin-left: 6px; letter-spacing: 0; }
.mrd-skill-tip { max-width: 260px; line-height: 1.5; }
.mrd-skill-tip-name { font-weight: 600; color: #0f1831; }
.mrd-skill-tip-desc { color: #a4abb9; margin-top: 2px; }
.mrd-skill-tip-kw { color: #8f7ff0; margin-top: 2px; }
.mrd-skill-tip-ex { color: #77809a; margin-top: 2px; font-style: italic; }
.mrd-skill-pills { display: flex; flex-wrap: wrap; gap: 5px; padding: 5px 10px; }
.mrd-skill-pill {
  border: 1px solid #2a3042;
  background: #1c202b;
  color: #a9b1c3;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.mrd-skill-pill:hover { border-color: #6c5ce7; color: #edeff5; transform: translateY(-1px); }
.mrd-skill-pill.on {
  background: linear-gradient(135deg, #6c5ce7, #4d6bfe);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 2px 8px rgba(108, 92, 231, 0.4);
}
.mrd-skill-pill.add { padding: 3px 8px; color: #6b7488; }
.mrd-skill-custom { display: flex; gap: 4px; width: 100%; margin-top: 4px; }

.mrd-native-card {
  flex: 1;
  height: 100%;
  box-sizing: border-box;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #151821;
  padding: 10px 0;
}
.mrd-col-title {
  font-size: 12px; font-weight: 600; color: #a9b1c3;
  display: flex; align-items: center; gap: 8px; padding: 0 10px;
}
.mrd-col-title-left { 
  flex: 1;
}
.mrd-col-hint { font-size: 10.5px; font-weight: 400; color: #55607a; }
.mrd-curve-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* 编辑器去掉下边框，由下方 SVG 曲线充当底边 */
.mrd-curve-shell :deep(.mrd-cm-host) {
  border: none;
  background: #10131b;
}
.mrd-curve-edge {
  flex: none;
  width: 100%;
  height: 22px;
  display: block;
  margin-top: -1px;
  pointer-events: none;
}
.mrd-curve-fill { fill: #151923; }
.mrd-curve-line {
  fill: none;
  stroke: #2a3042;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  transition: stroke 0.15s ease;
}
.mrd-curve-shell:focus-within .mrd-curve-line { stroke: #6c5ce7; }
.mrd-native-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 2px;
}
.mrd-curve-caption { font-size: 10.5px; color: #55607a; }
.mrd-gen-actions { flex: none; display: flex; gap: 8px; }

/* 右列：H3 卡片 */
.mrd-h3-card {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #151821;
  height: 100%;
}
.mrd-h3-head { flex: none; display: flex; align-items: baseline; gap: 8px; padding-top: 10px; }
.mrd-h3-scroll { flex: 1; min-height: 0; }
.mrd-h3-body { display: flex; flex-direction: column; padding-right: 4px; }
.mrd-h3-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
  border-bottom: 1px dashed #222736;
}
.mrd-h3-section:last-child { border-bottom: none; padding-bottom: 4px; }
.mrd-h3-label-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-left: 10px; }
.mrd-h3-switch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: #6b7488;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s ease;
}
.mrd-h3-switch.on { color: #8f7ff0; }
/* 新增技能弹窗 */
.mrd-add-skill-form { display: flex; flex-direction: column; gap: 10px; }
.mrd-add-skill-row { display: flex; align-items: flex-start; gap: 10px; }
.mrd-add-skill-label {
  flex: none;
  width: 52px;
  padding-top: 6px;
  font-size: 12px;
  color: #a9b1c3;
  text-align: right;
}
.mrd-h3-label {
  font-size: 11px;
  color: #6b7488;
  letter-spacing: 0.3px;
  font-family: ui-monospace, inherit;
}
/* H3 内嵌编辑器去边框，视觉上合并为一个整体 */
.mrd-h3-section :deep(.mrd-cm-host) {
  border: none;
  background: #10131b;
  border-radius: 4px;
}
.mrd-h3-section :deep(.mrd-cm-host:focus-within) { border: none; box-shadow: inset 0 0 0 1px rgba(108, 92, 231, 0.45); }
</style>
