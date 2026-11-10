<script setup>
// 全局参数 · LLM 设置面板（自 GlobalParams 迁移 + 新增豆包/千问浏览器桥接模式）
// 桥接三模式共用扩展 ID / 桥接地址配置，仅站点文案与入口不同。
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import { fetchLlmFiles, fetchConfig } from "../../api/client.js";
import { deepseekBridgeStatus, deepseekSetBridgeUrl } from "../../utils/llm.js";

const ws = useWorkspace();

const LLM_MODES = [
  { value: "deepseek-proxy", label: "DeepSeek 代理" },
  { value: "doubao-proxy", label: "豆包代理" },
  { value: "qwen-proxy", label: "千问代理" },
  { value: "llama-cpp", label: "llama-cpp" },
  { value: "api", label: "API" },
  { value: "ollama", label: "Ollama" },
];

// 桥接站点元数据（扩展 ID / 桥接地址共用，站点仅决定目标网页与文案）
const BRIDGE_SITES = {
  "deepseek-proxy": {
    name: "DeepSeek",
    web: "https://chat.deepseek.com/",
    hint: "deepseek-proxy 通过本仓库附带的浏览器扩展（extension/ 目录）调用 chat.deepseek.com。请先「加载已解压的扩展程序」安装，再将扩展 ID 填到上方，点击「打开 DeepSeek 网页」完成登录。未安装时翻译 / H3 生成将回退失败提示。",
  },
  "doubao-proxy": {
    name: "豆包",
    web: "https://www.doubao.com/",
    hint: "doubao-proxy 通过浏览器扩展调用 www.doubao.com 网页版豆包。使用与 DeepSeek 桥接同一个扩展（需更新到支持多站点的版本），填写扩展 ID 并登录豆包网页后即可使用。",
  },
  "qwen-proxy": {
    name: "千问",
    web: "https://tongyi.aliyun.com/",
    hint: "qwen-proxy 通过浏览器扩展调用通义千问网页版（tongyi.aliyun.com）。使用与 DeepSeek 桥接同一个扩展（需更新到支持多站点的版本），填写扩展 ID 并登录千问网页后即可使用。",
  },
};

const ggufFiles = ref([]);
const mmprojFiles = ref([]);
const providers = ref([]);
const bridgeSyncing = ref(false);
const bridgeStatus = ref(null); // { connected, url } | null

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

const bridgeSite = computed(() => BRIDGE_SITES[ws.llm.mode] || null);
const isBridgeMode = computed(() => !!bridgeSite.value);

const defaultBridgeUrl = computed(() =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/minimax_ref/api/deepseek/bridge`
);

function dirty() {
  ws.markDirty();
}

function openBridgeWeb() {
  if (!bridgeSite.value) return;
  window.open(bridgeSite.value.web, "_blank", "noopener");
  ElMessage.info(`请确保已在浏览器中登录${bridgeSite.value.name}网页`);
}

async function syncBridgeUrl() {
  const extId = (ws.llm.extension_id || "").trim();
  if (!extId) {
    ElMessage.warning("请先填写桥接扩展 ID");
    return;
  }
  bridgeSyncing.value = true;
  try {
    const url = (ws.llm.bridge_url || "").trim() || defaultBridgeUrl.value;
    const res = await deepseekSetBridgeUrl(extId, url);
    if (res && res.ok) {
      ws.llm.bridge_url = url;
      ws.markDirty();
      ElMessage.success(`桥接地址已同步到扩展：${url}`);
    } else {
      ElMessage.error(`同步失败：${(res && res.error) || "扩展不可用"}`);
    }
    const st = await deepseekBridgeStatus(extId);
    bridgeStatus.value = st && !st.error ? st : { connected: false };
  } finally {
    bridgeSyncing.value = false;
  }
}
</script>

<template>
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

      <!-- 浏览器桥接三模式（DeepSeek / 豆包 / 千问） -->
      <template v-else-if="isBridgeMode">
        <div class="mrd-field">
          <label>浏览器扩展 ID</label>
          <div class="mrd-ds-row">
            <el-input v-model="ws.llm.extension_id" placeholder="桥接扩展的 ID（chrome://extensions 查看）" @change="dirty">
              <template #prefix><el-icon><component :is="'Link'" /></el-icon></template>
            </el-input>
          </div>
        </div>
        <div class="mrd-field">
          <label>ComfyUI 桥接地址（WS，留空用当前页面地址）</label>
          <div class="mrd-ds-row">
            <el-input v-model="ws.llm.bridge_url" :placeholder="defaultBridgeUrl" @change="dirty" />
            <el-button :loading="bridgeSyncing" @click="syncBridgeUrl">同步到扩展</el-button>
          </div>
          <p v-if="bridgeStatus" class="mrd-field-hint">
            扩展 WS 桥接状态：
            <span :class="bridgeStatus.connected ? 'mrd-ds-ok' : 'mrd-ds-bad'">
              {{ bridgeStatus.connected ? "已连接" : "未连接" }}
            </span>
            （ComfyUI 工作流执行期间的 H3 生成 / 资源整理经此通道调用网页模型）
          </p>
        </div>
        <el-alert type="info" :closable="false" show-icon class="mrd-bridge-hint">
          <template #title>{{ bridgeSite.hint }}</template>
        </el-alert>
        <div>
          <el-button plain type="primary" :icon="'Position'" :title="`打开${bridgeSite.name}网页并登录`" @click="openBridgeWeb">
            打开{{ bridgeSite.name }}网页
          </el-button>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
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
.mrd-field { display: flex; flex-direction: column; gap: 6px; }
.mrd-field > label { font-size: 12px; color: #a9b1c3; }
.mrd-field-hint { font-size: 11.5px; color: #6b7488; margin: 2px 0 0; }
.mrd-llm-modes { margin-bottom: 16px; }
.mrd-llm-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 14px 18px; align-items: start; }
.mrd-bridge-hint { grid-column: 1 / -1; }
.mrd-ds-row { display: flex; gap: 8px; align-items: center; }
.mrd-ds-row .el-input { flex: 1; }
.mrd-ds-row .el-button { flex: none; }
.mrd-ds-ok { color: #4ade80; }
.mrd-ds-bad { color: #f87171; }
</style>
