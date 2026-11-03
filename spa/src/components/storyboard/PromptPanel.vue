<script setup>
// 中间上部：提示词区
// 左：skill 多选胶囊（运镜/景别/镜头结构/微表情 + 自定义）+ 原生提示词输入
// 中：两个生成按钮（中文 H3 / 英文 H3）
// 右：H3 提示词四段输入
// 原生与 H3 输入框均支持 @ / # 主体提及（overlay 高亮），与旧版一致。
import { computed, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { SKILL_GROUPS } from "../../data/skills.js";
import { useWorkspace } from "../../stores/workspace.js";
import { generateH3Prompt } from "../../utils/llm.js";
import { saveSkills } from "../../api/client.js";
import { framesToSeconds } from "../../utils/media.js";
import { REF_MENTION_TYPES, mergeSegmentSubjects } from "../../constants/subject.js";
import MentionTextarea from "../subjects/MentionTextarea.vue";

const props = defineProps({
  segment: { type: Object, required: true },
});
const ws = useWorkspace();

const translating = ref(""); // "" | "zh" | "en"
const customInput = reactive({ visible: false, group: "", value: "" });

// 合并内置 + 自定义词条
const groups = computed(() =>
  SKILL_GROUPS.map((g) => ({
    ...g,
    items: [...g.items, ...(ws.customSkills[g.id] || [])],
  }))
);

// 提及候选：本分镜生效主体（全局 + 段级自定义副本按名合并）
const mentionCandidates = computed(() =>
  mergeSegmentSubjects(ws.subjects.subjects, props.segment.subjectsOverride)
);
const mentionTypes = computed(() => {
  // 汇总所有类型可提及集合（不按单一父类型限制）
  const all = new Set();
  for (const arr of Object.values(REF_MENTION_TYPES)) arr.forEach((t) => all.add(t));
  return [...all];
});

function segSkills(field) {
  return props.segment?.[field] || [];
}

function toggleSkill(field, key) {
  const arr = props.segment[field] || (props.segment[field] = []);
  const idx = arr.indexOf(key);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(key);
  ws.markDirty();
}

async function addCustomSkill(groupId) {
  const label = (customInput.value || "").trim();
  if (!label) {
    customInput.visible = false;
    return;
  }
  const key = `custom_${Date.now().toString(36)}`;
  if (!Array.isArray(ws.customSkills[groupId])) ws.customSkills[groupId] = [];
  ws.customSkills[groupId].push({ key, label, title: "" });
  customInput.value = "";
  customInput.visible = false;
  ws.markDirty();
  try {
    const res = await saveSkills(JSON.parse(JSON.stringify(ws.customSkills)));
    if (res.success) Object.assign(ws.customSkills, res.skills);
  } catch {
    ElMessage.warning("自定义词条已生效，但持久化失败");
  }
}

// ---- H3 提示词四段 ----
const H3_FIELDS = [
  { key: "summary", label: "概要 summary", rows: 3 },
  { key: "detailed_description", label: "详细描述 detailed_description", rows: 6 },
  { key: "overall_soundscape", label: "整体声景 overall_soundscape", rows: 2 },
  { key: "non_diegetic_music", label: "非剧情音乐 non_diegetic_music", rows: 2 },
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
async function generateH3(lang) {
  const seg = props.segment;
  if (!(seg.prompt || "").trim()) {
    ElMessage.warning("请先输入原生提示词");
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
      expression_catalog: (ws.customSkills.expressions || []),
      shot_size: seg.shotSizes || [],
      framing: seg.framings || [],
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
  <div class="mrd-prompt-panel">
    <!-- 左：skill + 原生提示词 -->
    <div class="mrd-native-col">
      <div class="mrd-skills">
        <div class="mrd-skills-head">
          <span>镜头技能</span>
          <el-tooltip content="选中后随生成请求携带，由 LLM 分配到各 [Shot N]；不选 = 由模型自由决定" placement="bottom">
            <el-icon class="mrd-skills-help"><component :is="'QuestionFilled'" /></el-icon>
          </el-tooltip>
        </div>
        <el-scrollbar class="mrd-skills-scroll">
          <div v-for="g in groups" :key="g.id" class="mrd-skill-group">
            <div class="mrd-skill-group-title">{{ g.label }}</div>
            <div class="mrd-skill-pills">
              <button
                v-for="it in g.items"
                :key="it.key"
                class="mrd-skill-pill"
                :class="{ on: segSkills(g.id).includes(it.key) }"
                :title="it.title || it.label"
                @click="toggleSkill(g.id, it.key)"
              >{{ it.label }}</button>
              <button class="mrd-skill-pill add" title="添加自定义词条" @click="customInput.visible = !customInput.visible; customInput.group = g.id">＋</button>
              <div v-if="customInput.visible && customInput.group === g.id" class="mrd-skill-custom">
                <el-input
                  v-model="customInput.value"
                  size="small"
                  placeholder="自定义词条名称"
                  @keyup.enter="addCustomSkill(g.id)"
                />
                <el-button size="small" type="primary" @click="addCustomSkill(g.id)">保存</el-button>
              </div>
            </div>
          </div>
        </el-scrollbar>
      </div>

      <div class="mrd-native-input">
        <div class="mrd-col-title">
          原生提示词
          <span class="mrd-col-hint">输入 @ 或 # 可引用主体</span>
        </div>
        <MentionTextarea
          :model-value="segment.prompt"
          :rows="8"
          placeholder="原生分镜提示词（可中文，支持 <@主体> / <#主体:对白> / <d>对白</d> 标签）；生成时会自动翻译"
          :candidates="mentionCandidates"
          :allowed-types="mentionTypes"
          only-referencable
          @update:model-value="v => { segment.prompt = v; ws.markDirty(); }"
        />
      </div>
    </div>

    <!-- 中：生成按钮 -->
    <div class="mrd-gen-col">
      <el-button
        size="small"
        type="primary"
        :loading="translating === 'zh'"
        :disabled="!!translating && translating !== 'zh'"
        :icon="'MagicStick'"
        class="mrd-gen-btn"
        @click="generateH3('zh')"
      >生成中文H3<br/>提示词（中）</el-button>
      <el-button
        size="small"
        type="primary"
        :loading="translating === 'en'"
        :disabled="!!translating && translating !== 'en'"
        :icon="'MagicStick'"
        class="mrd-gen-btn"
        @click="generateH3('en')"
      >生成英文H3<br/>提示词（英）</el-button>
    </div>

    <!-- 右：H3 提示词四段 -->
    <div class="mrd-h3-col">
      <div class="mrd-col-title">
        H3 提示词
        <span class="mrd-col-hint">输入 @ 或 # 可引用主体</span>
      </div>
      <el-scrollbar class="mrd-h3-scroll">
        <div class="mrd-h3-fields">
          <div v-for="f in H3_FIELDS" :key="f.key" class="mrd-h3-field">
            <label>{{ f.label }}</label>
            <MentionTextarea
              :model-value="h3[f.key]"
              :rows="f.rows"
              :placeholder="f.key === 'summary' ? '本分镜概要' : ''"
              :candidates="mentionCandidates"
              :allowed-types="mentionTypes"
              only-referencable
              @update:model-value="v => { h3[f.key] = v; ws.markDirty(); }"
            />
          </div>
        </div>
      </el-scrollbar>
    </div>
  </div>
</template>

<style scoped>
.mrd-prompt-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 10px;
  min-height: 0;
}
/* 左列：技能 + 原生提示词 */
.mrd-native-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.mrd-skills {
  flex: 1;
  min-height: 90px;
  display: flex;
  flex-direction: column;
  background: #151821;
  border: 1px solid #222736;
  border-radius: 10px;
  padding: 10px;
  min-height: 0;
  overflow: hidden;
}
.mrd-skills-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; font-weight: 600; color: #a9b1c3;
  margin-bottom: 8px; flex: none;
}
.mrd-skills-help { color: #4b5266; cursor: help; }
.mrd-skills-scroll { flex: 1; min-height: 0; }
.mrd-skill-group { margin-bottom: 10px; }
.mrd-skill-group-title { font-size: 11px; color: #6b7488; margin-bottom: 5px; letter-spacing: 0.5px; }
.mrd-skill-pills { display: flex; flex-wrap: wrap; gap: 5px; }
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

.mrd-native-input {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mrd-col-title {
  font-size: 12px; font-weight: 600; color: #a9b1c3;
  display: flex; align-items: center; gap: 8px;
}
.mrd-col-hint { font-size: 10.5px; font-weight: 400; color: #55607a; }
.mrd-native-input .mrd-mention-wrap, .mrd-native-input :deep(.mrd-mention-wrap) { flex: 1; }

/* 中列：生成按钮 */
.mrd-gen-col {
  flex: none;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
  padding: 0 2px;
}
.mrd-gen-btn {
  height: auto;
  min-height: 56px;
  padding: 6px 12px;
  line-height: 1.5;
  white-space: normal;
  text-align: center;
}

/* 右列：H3 四段 */
.mrd-h3-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}
.mrd-h3-scroll { flex: 1; min-height: 0; }
.mrd-h3-fields { display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }
.mrd-h3-field { display: flex; flex-direction: column; gap: 4px; }
.mrd-h3-field > label { font-size: 11.5px; color: #6b7488; }
</style>
