<script setup>
// 全局参数配置页：基础设置 / LLM 设置（四种模式）/ 全局提示词
import { computed, onMounted, ref } from "vue";
import { useWorkspace } from "../stores/workspace.js";
import { fetchLlmFiles, fetchConfig } from "../api/client.js";

const ws = useWorkspace();

const RESOLUTIONS = ["1:1方形", "9:16竖屏", "16:9横屏", "3:2横屏", "2:3竖屏", "4:3横屏", "3:4竖屏", "21:9超宽"];
const LLM_MODES = [
  { value: "llama-cpp", label: "llama-cpp" },
  { value: "api", label: "API" },
  { value: "ollama", label: "Ollama" },
  { value: "deepseek-proxy", label: "DeepSeek 代理" },
];

const ggufFiles = ref([]);
const mmprojFiles = ref([]);
const providers = ref([]);

onMounted(async () => {
  try {
    const res = await fetchLlmFiles();
    if (res.success) {
      ggufFiles.value = res.gguf || [];
      mmprojFiles.value = res.mmproj || [];
    }
  } catch { /* ignore */ }
  try {
    const res = await fetchConfig();
    if (res.success && res.config) {
      const services = res.config.services || {};
      providers.value = Object.values(services)
        .filter((s) => s && s.id)
        .map((s) => ({ id: s.id, name: s.name || s.id }));
    }
  } catch { /* ignore */ }
});

const isDeepseek = computed(() => ws.llm.mode === "deepseek-proxy");
const globalPromptLen = computed(() => (ws.globalPrompt || "").length);

function dirty() {
  ws.markDirty();
}
</script>

<template>
  <div class="mrd-global">
    <!-- 基础设置 -->
    <section class="mrd-card mrd-section">
      <h3 class="mrd-section-title"><el-icon><component :is="'Setting'" /></el-icon>基础设置</h3>
      <div class="mrd-form-grid">
        <div class="mrd-field">
          <label>输出画幅比例</label>
          <el-select v-model="ws.widgets.outpu_resolution" @change="dirty">
            <el-option v-for="r in RESOLUTIONS" :key="r" :label="r" :value="r" />
          </el-select>
        </div>
        <div class="mrd-field">
          <label>百万像素（Million Pixels）</label>
          <el-input-number
            v-model="ws.widgets.million_pixels"
            :min="0.1" :max="4" :step="0.1" :precision="1"
            controls-position="right"
            @change="dirty"
          />
        </div>
        <div class="mrd-field">
          <label>时间显示单位</label>
          <el-radio-group v-model="ws.widgets.display_mode" @change="dirty">
            <el-radio-button value="seconds">秒</el-radio-button>
            <el-radio-button value="frames">帧</el-radio-button>
          </el-radio-group>
        </div>
        <div class="mrd-field">
          <label>帧率（FPS）</label>
          <el-input-number
            v-model="ws.widgets.frame_rate"
            :min="1" :max="240" :step="1"
            controls-position="right"
            @change="dirty"
          />
        </div>
      </div>
    </section>

    <!-- LLM 设置 -->
    <section class="mrd-card mrd-section">
      <h3 class="mrd-section-title"><el-icon><component :is="'MagicStick'" /></el-icon>LLM 设置</h3>
      <el-radio-group v-model="ws.llm.mode" class="mrd-llm-modes" @change="dirty">
        <el-radio-button v-for="m in LLM_MODES" :key="m.value" :value="m.value">{{ m.label }}</el-radio-button>
      </el-radio-group>

      <div class="mrd-llm-form">
        <!-- llama-cpp -->
        <template v-if="ws.llm.mode === 'llama-cpp'">
          <div class="mrd-field">
            <label>GGUF 模型（models/llm）</label>
            <el-select v-model="ws.llm.gguf_path" filterable allow-create clearable placeholder="选择或输入 GGUF 文件名" @change="dirty">
              <el-option v-for="f in ggufFiles" :key="f" :label="f" :value="f" />
            </el-select>
          </div>
          <div class="mrd-field">
            <label>mmproj 视觉投影器</label>
            <el-select v-model="ws.llm.mmproj_path" filterable allow-create clearable placeholder="选择或输入 mmproj 文件名" @change="dirty">
              <el-option v-for="f in mmprojFiles" :key="f" :label="f" :value="f" />
            </el-select>
          </div>
          <p v-if="!ggufFiles.length" class="mrd-field-hint">未在 models/llm 下发现 GGUF 文件，可手动输入文件名。</p>
        </template>

        <!-- api -->
        <template v-else-if="ws.llm.mode === 'api'">
          <div class="mrd-field">
            <label>服务商（API 管理器）</label>
            <el-select v-model="ws.llm.provider" filterable allow-create placeholder="如 glm / kimi / qwen / doubao" @change="dirty">
              <el-option v-for="p in providers" :key="p.id" :label="`${p.name} (${p.id})`" :value="p.id" />
            </el-select>
          </div>
          <div class="mrd-field">
            <label>API Key（留空回落 API 管理器配置）</label>
            <el-input v-model="ws.llm.api_key" type="password" show-password placeholder="可选" @change="dirty" />
          </div>
        </template>

        <!-- ollama -->
        <template v-else-if="ws.llm.mode === 'ollama'">
          <div class="mrd-field">
            <label>模型标签</label>
            <el-input v-model="ws.llm.ollama_model" placeholder="如 qwen2.5vl:7b（留空回落配置）" @change="dirty" />
          </div>
          <div class="mrd-field">
            <label>服务地址</label>
            <el-input v-model="ws.llm.ollama_base_url" placeholder="http://localhost:11434（留空用默认）" @change="dirty" />
          </div>
        </template>

        <!-- deepseek-proxy -->
        <template v-else>
          <div class="mrd-field">
            <label>浏览器扩展 ID</label>
            <el-input v-model="ws.llm.extension_id" placeholder="DeepSeek 桥接扩展的 ID（chrome://extensions 查看）" @change="dirty">
              <template #prefix><el-icon><component :is="'Link'" /></el-icon></template>
            </el-input>
          </div>
          <el-alert type="info" :closable="false" show-icon class="mrd-deepseek-hint">
            <template #title>
              deepseek-proxy 通过本仓库附带的浏览器扩展（extension/ 目录）调用 chat.deepseek.com。
              请先「加载已解压的扩展程序」安装，再将扩展 ID 填到上方。未安装时翻译 / H3 生成将回退失败提示。
            </template>
          </el-alert>
        </template>
      </div>
    </section>

    <!-- 全局提示词 -->
    <section class="mrd-card mrd-section">
      <h3 class="mrd-section-title"><el-icon><component :is="'Document'" /></el-icon>全局提示词</h3>
      <el-input
        v-model="ws.globalPrompt"
        type="textarea"
        :rows="7"
        maxlength="8000"
        show-word-limit
        resize="vertical"
        placeholder="作用于整个视频的条件提示词：锚定贯穿角色、物件与场景基调（写回 Subject 节点 global_prompt）"
        @input="dirty"
      />
      <div class="mrd-gp-meta">当前 {{ globalPromptLen }} 字</div>
    </section>
  </div>
</template>

<style scoped>
.mrd-global {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.mrd-section { padding: 18px 22px; }
.mrd-section-title {
  margin: 0 0 16px;
  font-size: 15px;
  font-weight: 600;
  color: #edeff5;
  display: flex;
  align-items: center;
  gap: 8px;
}
.mrd-section-title :deep(.el-icon) { color: #a78bfa; }
.mrd-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px 18px;
}
.mrd-field { display: flex; flex-direction: column; gap: 6px; }
.mrd-field > label { font-size: 12px; color: #a9b1c3; }
.mrd-field-hint { font-size: 11.5px; color: #6b7488; margin: 2px 0 0; }
.mrd-llm-modes { margin-bottom: 16px; }
.mrd-llm-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 18px; align-items: start; }
.mrd-deepseek-hint { grid-column: 1 / -1; }
.mrd-gp-meta { margin-top: 8px; font-size: 11.5px; color: #6b7488; text-align: right; }
</style>
