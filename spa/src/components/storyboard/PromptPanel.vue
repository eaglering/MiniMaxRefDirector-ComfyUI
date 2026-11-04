<script setup>
// 中间上部：提示词区（左右两列）
// 左列：技能胶囊 + 用户提示词（CodeMirror，仅 @ 触发；右下角曲线装饰 + 中/英 H3 生成按钮）
// 右列：H3 提示词四段（同一容器内连续排列，整体占满高度，超出滚动；支持 @ 与 #）
import { computed, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { SKILL_GROUPS } from "../../data/skills.js";
import { useWorkspace } from "../../stores/workspace.js";
import { generateH3Prompt } from "../../utils/llm.js";
import { saveSkills } from "../../api/client.js";
import { framesToSeconds } from "../../utils/media.js";
import { REF_MENTION_TYPES, mergeSegmentSubjects } from "../../constants/subject.js";
import PromptEditor from "../common/PromptEditor.vue";

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
    <!-- 左列：技能 + 用户提示词 -->
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
            fill
            :min-height="120"
            :allow-hash="false"
            placeholder="原生分镜提示词（可中文，支持 <@主体> 标签）；生成时会自动翻译"
            :candidates="mentionCandidates"
            :allowed-types="mentionTypes"
            only-referencable
            @update:model-value="v => { segment.prompt = v; ws.markDirty(); }"
          />
        </div>
      </div>
    </div>

    <!-- 右列：H3 提示词（整体一个容器） -->
    <div class="mrd-h3-card">
      <div class="mrd-h3-head">
        <span class="mrd-col-title">H3 提示词</span>
        <span class="mrd-col-hint">输入 @ 或 # 可引用主体</span>
      </div>
      <el-scrollbar class="mrd-h3-scroll">
        <div class="mrd-h3-body">
          <div v-for="f in H3_FIELDS" :key="f.key" class="mrd-h3-section">
            <label class="mrd-h3-label">{{ f.label }}</label>
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
/* 左列 */
.mrd-native-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.mrd-skills {
  flex: none;
  max-height: 270px;
  display: flex;
  flex-direction: column;
  background: #151821;
  border: 1px solid #222736;
  border-radius: 10px;
  padding: 10px;
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

.mrd-native-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #151821;
  border: 1px solid #222736;
  border-radius: 10px;
  padding: 10px;
}
.mrd-col-title {
  font-size: 12px; font-weight: 600; color: #a9b1c3;
  display: flex; align-items: center; gap: 8px;
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
  border-radius: 6px 6px 0 0;
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
  border: 1px solid #222736;
  border-radius: 10px;
  padding: 10px;
  height: 100%;
}
.mrd-h3-head { flex: none; display: flex; align-items: baseline; gap: 8px; }
.mrd-h3-scroll { flex: 1; min-height: 0; }
.mrd-h3-body { display: flex; flex-direction: column; padding-right: 4px; }
.mrd-h3-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0 10px;
  border-bottom: 1px dashed #222736;
}
.mrd-h3-section:last-child { border-bottom: none; padding-bottom: 4px; }
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
