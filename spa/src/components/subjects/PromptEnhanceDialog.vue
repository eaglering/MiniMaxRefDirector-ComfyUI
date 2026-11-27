<script setup>
// 「提示词增强」弹窗（独立新增功能，与「生成提示词」SubjectPromptDialog 互不影响）：
// 技能池来自 resources/skill_enhances（seed.json 登记 md / script 技能），
// 支持按名称/描述/标签检索 + 标签 chips 筛选 + 多选（保持点击顺序）；
// 执行生成走服务端 /spa/prompt_enhance（md 注入 system → generate_text 全模式 →
// script 技能按顺序链式后处理 run(text, ctx)），结果支持复制 / 填入描述。
import { computed, onUnmounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import { fetchSkillEnhances, enhancePrompt } from "../../api/client.js";
import { SUBJECT_TYPE_LABELS } from "../../constants/subject.js";

const props = defineProps({
  subject: { type: Object, default: null }, // 主体卡片场景传入；分镜等场景可省略
  initialDescription: { type: String, default: "" }, // 非主体场景直接带入的描述
  title: { type: String, default: "" }, // 弹窗标题（缺省按主体名生成）
});
const emit = defineEmits(["apply"]);

const ws = useWorkspace();

const dlgTitle = computed(
  () => props.title
    || `提示词增强 · ${props.subject?.name
      || SUBJECT_TYPE_LABELS[props.subject?.type]
      || props.subject?.type
      || ""}`);

const visible = ref(false);
const state = reactive({
  skills: [],
  loading: false,
  keyword: "",
  activeTags: [], // 选中的标签 chips（多选，命中任一即通过）
  selectedIds: [], // 保持点击顺序
  desc: "",
  useGlobal: false, // 勾选后把「全局参数 → 全局提示词」附加到请求
  result: "",
  error: "",
  running: false,
  elapsed: "",
  timer: null,
});
let lastUseGlobal = false; // checkbox 状态跨打开记忆（会话内）

const allTags = computed(() => {
  const set = new Set();
  for (const s of state.skills) for (const t of s.tags || []) set.add(t);
  return [...set];
});

const filteredSkills = computed(() => {
  const kw = state.keyword.trim().toLowerCase();
  const tags = state.activeTags;
  return state.skills.filter((s) => {
    const tagHit = !tags.length || (s.tags || []).some((t) => tags.includes(t));
    if (!tagHit) return false;
    if (!kw) return true;
    const hay = `${s.name} ${s.description} ${(s.tags || []).join(" ")}`.toLowerCase();
    return hay.includes(kw);
  });
});

const selectedSet = computed(() => new Set(state.selectedIds));
const selectedSkills = computed(() =>
  state.selectedIds.map((id) => state.skills.find((s) => s.id === id)).filter(Boolean));
const selectedDocs = computed(() => selectedSkills.value.filter((s) => s.hasDoc).length);
const selectedScripts = computed(() => selectedSkills.value.filter((s) => s.hasScript).length);

async function open() {
  visible.value = true;
  state.desc = props.initialDescription || props.subject?.description || "";
  state.result = "";
  state.error = "";
  state.keyword = "";
  state.activeTags = [];
  state.selectedIds = [];
  state.elapsed = "";
  state.useGlobal = lastUseGlobal;
  await loadSkills();
}

async function loadSkills() {
  state.loading = true;
  try {
    const res = await fetchSkillEnhances();
    if (!res.success) throw new Error(res.error || "技能列表加载失败");
    state.skills = res.skills || [];
  } catch (e) {
    state.skills = [];
    ElMessage.error(`增强技能加载失败：${e.message || e}`);
  } finally {
    state.loading = false;
  }
}

function toggleTag(tag) {
  const i = state.activeTags.indexOf(tag);
  if (i >= 0) state.activeTags.splice(i, 1);
  else state.activeTags.push(tag);
}

function toggleSkill(id) {
  const i = state.selectedIds.indexOf(id);
  if (i >= 0) state.selectedIds.splice(i, 1);
  else state.selectedIds.push(id);
}

async function run() {
  if (state.running) return;
  if (!state.selectedIds.length) { ElMessage.warning("请至少选择一个增强技能"); return; }
  if (!state.desc.trim()) { ElMessage.warning("请输入描述"); return; }
  state.running = true;
  state.result = "";
  state.error = "";
  state.elapsed = "0s";
  lastUseGlobal = state.useGlobal;
  const startedAt = Date.now();
  state.timer = setInterval(() => {
    state.elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`;
  }, 1000);
  try {
    const llm = ws.llm || {};
    const res = await enhancePrompt({
      description: state.desc,
      skills: state.selectedIds,
      global_prompt: state.useGlobal ? (ws.globalPrompt || "") : "",
      subject_type: props.subject?.type || "",
      subject_name: props.subject?.name || "",
      llm: {
        mode: llm.mode || "llama-server",
        provider: llm.provider || "",
        api_key: llm.api_key || "",
        ollama_model: llm.ollama_model || "",
        ollama_base_url: llm.ollama_base_url || "",
        gguf_path: llm.gguf_path || "",
        mmproj_path: llm.mmproj_path || "",
      },
    });
    if (!res.success) throw new Error(res.error || "增强失败");
    state.result = String(res.text || "").trim() || "（模型返回为空）";
    if (selectedScripts.value.length) {
      ElMessage.success(`增强完成（已执行 ${res.applied_scripts?.length || 0} 个脚本技能）`);
    }
  } catch (e) {
    state.error = String(e.message || e);
  } finally {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.running = false;
  }
}

function copyResult() {
  navigator.clipboard?.writeText(state.result)
    .then(() => ElMessage.success("已复制"))
    .catch(() => ElMessage.error("复制失败（浏览器剪贴板不可用）"));
}

function applyToDescription() {
  if (!state.result.trim()) return;
  emit("apply", state.result.trim());
  ElMessage.success("已填入描述");
  visible.value = false;
}

onUnmounted(() => {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
});

defineExpose({ open });
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="dlgTitle"
    width="640px"
    append-to-body
    destroy-on-close
  >
    <div class="mrd-pe-dialog">
      <!-- 技能区 -->
      <div class="mrd-pe-row">
        <label>增强技能（来自 resources/skill_enhances；按名称 / 描述 / 标签检索）</label>
        <el-input
          v-model="state.keyword"
          size="small"
          clearable
          placeholder="搜索技能名称、描述或标签…"
          :prefix-icon="'Search'"
        />
        <div v-if="allTags.length" class="mrd-pe-tags">
          <span
            v-for="t in allTags" :key="t"
            class="mrd-pe-tag" :class="{ active: state.activeTags.includes(t) }"
            @click="toggleTag(t)"
          >{{ t }}</span>
        </div>
        <div v-loading="state.loading" class="mrd-pe-list">
          <div
            v-for="s in filteredSkills" :key="s.id"
            class="mrd-pe-item" :class="{ selected: selectedSet.has(s.id) }"
            @click="toggleSkill(s.id)"
          >
            <span class="mrd-pe-check"><el-icon v-if="selectedSet.has(s.id)"><component :is="'Check'" /></el-icon></span>
            <div class="mrd-pe-item-body">
              <div class="mrd-pe-item-name">
                {{ s.name }}
                <el-tag v-if="s.hasScript" size="small" type="warning" effect="dark">script</el-tag>
                <el-tag v-for="t in s.tags" :key="t" size="small" effect="plain">{{ t }}</el-tag>
              </div>
              <div class="mrd-pe-item-desc" :title="s.description">{{ s.description }}</div>
            </div>
          </div>
          <div v-if="!state.loading && !filteredSkills.length" class="mrd-pe-empty">
            {{ state.skills.length ? "没有匹配的技能（换个关键词或标签试试）" : "skill_enhances 技能池为空：往 resources/skill_enhances/ 放置 seed.json 与技能文件即可" }}
            <el-button v-if="state.skills.length" size="small" link type="primary" @click="loadSkills">重新加载</el-button>
          </div>
        </div>
        <p class="mrd-pe-sum">
          已选 {{ state.selectedIds.length }} 项 · 注入 md {{ selectedDocs }} / 脚本 {{ selectedScripts }}
          <span class="mrd-pe-sum-hint">md 技能作为生成指令；script 技能在生成后按选择顺序执行</span>
        </p>
      </div>

      <!-- 描述区 -->
      <div class="mrd-pe-row">
        <label>描述（原始提示词，可编辑）</label>
        <el-input
          v-model="state.desc" type="textarea" :rows="5"
          placeholder="主体外观 / 画面 / 声音需求描述"
        />
        <el-checkbox v-model="state.useGlobal" class="mrd-pe-global">
          全局提示词
          <span class="mrd-pe-global-hint">
            勾选后自动把「全局参数 → 全局提示词」附加到请求一并带到代理执行
          </span>
        </el-checkbox>
      </div>

      <!-- 操作区 -->
      <div class="mrd-pe-run">
        <el-button type="primary" :loading="state.running" @click="run">
          {{ state.running ? `生成中… ${state.elapsed}` : "执行生成" }}
        </el-button>
        <span class="mrd-pe-hint">走当前 LLM 设置（{{ ws.llm.mode }}），脚本技能在服务端统一执行</span>
      </div>

      <!-- 错误条 -->
      <div v-if="state.error" class="mrd-pe-error">生成失败：{{ state.error }}</div>

      <!-- 结果区 -->
      <div v-if="state.result" class="mrd-pe-row">
        <label>生成结果</label>
        <div class="mrd-pe-result">{{ state.result }}</div>
        <div class="mrd-pe-actions">
          <el-button size="small" :icon="'CopyDocument'" @click="copyResult">复制</el-button>
          <el-button size="small" type="primary" :icon="'Download'" @click="applyToDescription">填入描述</el-button>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.mrd-pe-dialog { display: flex; flex-direction: column; gap: 14px; }
.mrd-pe-row { display: flex; flex-direction: column; gap: 6px; }
.mrd-pe-row > label { font-size: 12px; color: #a9b1c3; }
.mrd-pe-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.mrd-pe-tag {
  font-size: 11px; padding: 2px 10px; border-radius: 10px; cursor: pointer;
  color: #a9b1c3; background: rgba(255, 255, 255, 0.05); border: 1px solid #2c3143;
  transition: all 0.15s ease; user-select: none;
}
.mrd-pe-tag:hover { border-color: #4f7cff; color: #c3c9d6; }
.mrd-pe-tag.active { background: #4f7cff; border-color: #4f7cff; color: #fff; }
.mrd-pe-list {
  min-height: 120px; max-height: 240px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid #262c3d; border-radius: 8px; padding: 6px;
  background: rgba(255, 255, 255, 0.02);
}
.mrd-pe-item {
  display: flex; gap: 8px; align-items: flex-start; cursor: pointer;
  padding: 6px 8px; border-radius: 6px; border: 1px solid transparent;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.mrd-pe-item:hover { background: rgba(255, 255, 255, 0.04); }
.mrd-pe-item.selected { background: rgba(79, 124, 255, 0.12); border-color: #4f7cff; }
.mrd-pe-check {
  flex: none; width: 16px; height: 16px; margin-top: 2px;
  border-radius: 4px; border: 1px solid #3a456b;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: #fff;
}
.mrd-pe-item.selected .mrd-pe-check { background: #4f7cff; border-color: #4f7cff; }
.mrd-pe-item-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mrd-pe-item-name { font-size: 12.5px; color: #edeff5; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mrd-pe-item-desc {
  font-size: 11px; color: #8a93a8; line-height: 1.5;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mrd-pe-empty { padding: 24px 0; text-align: center; font-size: 12px; color: #6b7488; }
.mrd-pe-sum { margin: 0; font-size: 11.5px; color: #a9b1c3; }
.mrd-pe-sum-hint { margin-left: 8px; font-size: 11px; color: #6b7488; }
.mrd-pe-global { margin-top: 2px; }
.mrd-pe-global-hint { font-size: 11px; color: #6b7488; margin-left: 2px; }
.mrd-pe-run { display: flex; align-items: center; gap: 12px; }
.mrd-pe-hint { font-size: 11.5px; color: #6b7488; }
.mrd-pe-error {
  border-radius: 6px; background: rgba(245, 108, 108, 0.12);
  border: 1px solid rgba(245, 108, 108, 0.5);
  padding: 8px 10px; font-size: 12px; color: #f56c6c;
  white-space: pre-wrap; word-break: break-word;
}
.mrd-pe-result {
  border-radius: 8px; background: rgba(255, 255, 255, 0.04);
  border: 1px solid #2c3143; padding: 10px 12px;
  font-size: 12.5px; color: #c3c9d6; line-height: 1.75;
  max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
.mrd-pe-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
