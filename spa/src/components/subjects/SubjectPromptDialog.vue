<script setup>
// 「生成提示词」弹窗：按卡片类型选技能文档 → 描述带入（可编辑）→ 执行生成。
// 结果只展示 + 复制 / 一键填入描述，默认不改动任何字段。
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import { fetchSkillDocs, fetchSkillDoc } from "../../api/client.js";
import { generateText } from "../../utils/llm.js";
import { SUBJECT_TYPE_LABELS } from "../../constants/subject.js";

const props = defineProps({
  subject: { type: Object, required: true },
});
const emit = defineEmits(["apply"]);

const ws = useWorkspace();

const visible = ref(false);
const CATEGORY_OF_TYPE = {
  Subject: "主体设计",
  Picture: "图片设计",
  Audio: "音频设计",
};
// 与 deepseekImport fillTemplate 同语义：命中替换，未提供清空
function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, key) =>
    key in vars ? String(vars[key] ?? "") : ""
  );
}

const state = reactive({
  docs: [],
  docId: null,
  desc: "",
  useGlobal: false, // 勾选后把「全局参数 → 全局提示词」附加到请求一并带到代理执行
  result: "",
  running: false,
  elapsed: "",
  timer: null,
});
// checkbox 状态跨打开记忆（模块级变量，仅会话内，不写入 timeline_data）
let lastUseGlobal = false;

const docSummary = computed(() => {
  const d = state.docs.find((x) => x.id === state.docId);
  return d?.summary || "";
});

async function open() {
  const category = CATEGORY_OF_TYPE[props.subject.type];
  if (!category) return;
  visible.value = true;
  state.docs = [];
  state.docId = null;
  state.desc = props.subject.description || "";
  state.result = "";
  state.elapsed = "";
  state.useGlobal = lastUseGlobal;
  try {
    const res = await fetchSkillDocs(category);
    if (res.success) {
      state.docs = res.docs || [];
      if (state.docs.length) state.docId = state.docs[0].id;
    }
  } catch (e) {
    ElMessage.error(`技能文档加载失败：${e.message || e}`);
  }
}

watch(visible, (v) => {
  if (!v && state.timer) { clearInterval(state.timer); state.timer = null; }
});

async function run() {
  if (state.running) return;
  if (!state.docId) { ElMessage.warning("请先选择技能文档"); return; }
  if (!state.desc.trim()) { ElMessage.warning("请输入描述"); return; }
  state.running = true;
  state.result = "";
  state.elapsed = "0s";
  lastUseGlobal = state.useGlobal;
  const startedAt = Date.now();
  state.timer = setInterval(() => {
    state.elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`;
  }, 1000);
  try {
    const res = await fetchSkillDoc({ id: state.docId });
    if (!res.success || !res.doc) throw new Error(res.error || "文档读取失败");
    const prompt = fillTemplate(res.doc.content, {
      description: state.desc,
      retention: props.subject.retention || "",
      type: SUBJECT_TYPE_LABELS[props.subject.type] || props.subject.type || "",
      duration: "",
    });
    // 勾选「全局提示词」：把全局参数页的全局提示词作为附加约束一并带入代理
    // 请求（附加在用户描述之后，不混入技能文档 system；全局提示词为空则忽略）
    let userPrompt = state.desc;
    const gp = (ws.globalPrompt || "").trim();
    if (state.useGlobal && gp) {
      userPrompt = `${state.desc}\n\n【全局提示词（全片约束，生成时请参考）】\n${gp}`;
    } else if (state.useGlobal && !gp) {
      ElMessage.warning("全局提示词为空，本次未附加（可在 全局参数 → 全局提示词 填写）");
    }
    const text = await generateText(ws.llm, { system: prompt, prompt: userPrompt });
    state.result = text.trim() || "（模型返回为空）";
  } catch (e) {
    ElMessage.error(`生成失败：${e.message || e}`);
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

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="visible" :title="`生成提示词 · ${subject.name || SUBJECT_TYPE_LABELS[subject.type] || subject.type}`" width="640px" append-to-body>
    <div class="mrd-sp-dialog">
      <div class="mrd-sp-row">
        <label>技能文档（{{ { Subject: "主体设计", Picture: "图片设计", Audio: "音频设计" }[subject.type] || "" }}）</label>
        <el-select v-model="state.docId" style="width: 100%" placeholder="选择技能文档" filterable>
          <el-option v-for="d in state.docs" :key="d.id" :value="d.id" :label="d.title + (d.builtin ? '（内置）' : '')" />
        </el-select>
        <p v-if="docSummary" class="mrd-sp-sum">{{ docSummary }}</p>
      </div>
      <div class="mrd-sp-row">
        <label>描述（可编辑；文档中的 description 变量会替换为此内容）</label>
        <el-input
          v-model="state.desc" type="textarea" :rows="5"
          placeholder="主体外观 / 画面 / 声音需求描述"
        />
        <el-checkbox v-model="state.useGlobal" class="mrd-sp-global">
          全局提示词
          <span class="mrd-sp-global-hint">
            勾选后自动把「全局参数 → 全局提示词」附加到请求一并带到代理执行
          </span>
        </el-checkbox>
      </div>
      <div class="mrd-sp-run">
        <el-button type="primary" :loading="state.running" @click="run">
          {{ state.running ? `生成中… ${state.elapsed}` : "执行生成" }}
        </el-button>
        <span class="mrd-sp-hint">走当前 LLM 设置（{{ ws.llm.mode }}）</span>
      </div>
      <div v-if="state.result" class="mrd-sp-row">
        <label>生成结果</label>
        <div class="mrd-sp-result">{{ state.result }}</div>
        <div class="mrd-sp-actions">
          <el-button size="small" :icon="'CopyDocument'" @click="copyResult">复制</el-button>
          <el-button size="small" type="primary" :icon="'Download'" @click="applyToDescription">填入描述</el-button>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.mrd-sp-dialog { display: flex; flex-direction: column; gap: 14px; }
.mrd-sp-row { display: flex; flex-direction: column; gap: 6px; }
.mrd-sp-row > label { font-size: 12px; color: #a9b1c3; }
.mrd-sp-sum { font-size: 11px; color: #6b7488; margin: 2px 0 0; line-height: 1.6; }
.mrd-sp-global { margin-top: 2px; }
.mrd-sp-global-hint { font-size: 11px; color: #6b7488; margin-left: 2px; }
.mrd-sp-run { display: flex; align-items: center; gap: 12px; }
.mrd-sp-hint { font-size: 11.5px; color: #6b7488; }
.mrd-sp-result {
  border-radius: 8px; background: rgba(255, 255, 255, 0.04);
  border: 1px solid #2c3143; padding: 10px 12px;
  font-size: 12.5px; color: #c3c9d6; line-height: 1.75;
  max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
.mrd-sp-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
