<script setup>
// 全局参数 · LLM 设置面板（自 GlobalParams 迁移 + 豆包/千问网页桥接模式）
// 桥接三模式共用 CDP 端点配置：后端 Playwright（lib/webchat_cdp.py）附加用户
// 真实 Chrome（--remote-debugging-port=9222），不再依赖浏览器扩展。
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useWorkspace } from "../../stores/workspace.js";
import { fetchLlmFiles, fetchConfig, saveConfig } from "../../api/client.js";
import {
  setCdpEndpoint,
  webchatListBrowsers,
  webchatLaunch,
  webchatTestConnection,
  llamaServerStart,
  llamaServerStop,
  llamaServerStatus,
  llamaServerLog,
} from "../../utils/llm.js";

const ws = useWorkspace();

const LLM_MODES = [
  { value: "deepseek-proxy", label: "DeepSeek 代理" },
  { value: "doubao-proxy", label: "豆包代理" },
  { value: "qianwen-proxy", label: "千问代理" },
  { value: "llama-server", label: "llama-server" },
  { value: "api", label: "API" },
  { value: "ollama", label: "Ollama" },
];

// 桥接站点元数据（CDP 端点共用，站点仅决定目标网页与文案）
const BRIDGE_SITES = {
  "deepseek-proxy": {
    name: "DeepSeek",
    web: "https://chat.deepseek.com/",
    hint: "deepseek-proxy 由后端 Playwright 经 CDP 调用 chat.deepseek.com 网页会话（无需浏览器扩展）。选择浏览器后点「启动浏览器并打开 DeepSeek」即可：后端自动以调试参数拉起浏览器、打开站点网页（独立用户目录，首次需登录站点，之后 cookies 保留）。",
  },
  "doubao-proxy": {
    name: "豆包",
    web: "https://www.doubao.com/chat/",
    hint: "doubao-proxy 由后端 Playwright 经 CDP 调用豆包网页会话（会话地址 https://www.doubao.com/chat/）。点「启动浏览器并打开豆包」自动拉起并登录豆包网页后即可使用。",
  },
  "qianwen-proxy": {
    name: "千问",
    web: "https://www.qianwen.com/chat/",
    hint: "qianwen-proxy 由后端 Playwright 经 CDP 调用千问网页会话（会话地址 https://www.qianwen.com/chat/）。点「启动浏览器并打开千问」自动拉起并登录千问网页后即可使用。",
  },
};

// 兼容旧配置值 qwen-proxy / llama-cpp（llama-cpp 已由外部 llama-server 取代）
const NORMALIZED_MODE = (mode) =>
  mode === "qwen-proxy" ? "qianwen-proxy" : mode === "llama-cpp" ? "llama-server" : mode;

const ggufFiles = ref([]);
const mmprojFiles = ref([]);
const providers = ref([]);
const browsers = ref([]); // [{id,name,installed,path}]
const launching = ref(false);
const bridgeSyncing = ref(false);
const bridgeStatus = ref(null); // { connected, endpoint, error? } | null

// llama-server 启停状态（启动中轮询 /health；停止后停表）
const lsBusy = ref(false); // start/stop 请求进行中
const lsStatus = ref(null); // { running, loading, pid, endpoint, model, ... }
const lsLog = ref(""); // 日志尾部（失败时展示）
const lsTimer = ref(null);

async function refreshLsStatus() {
  try {
    const res = await llamaServerStatus();
    lsStatus.value = res.success !== false ? res : null;
  } catch { /* ignore */ }
}

function stopLsTimer() {
  if (lsTimer.value) { clearInterval(lsTimer.value); lsTimer.value = null; }
}

async function startLlamaServer() {
  if (lsBusy.value) return;
  lsBusy.value = true;
  lsLog.value = "";
  try {
    const res = await llamaServerStart({
      path: lsCfgPath.value || ws.llm.llama_server_path || "",
      ggufPath: ws.llm.gguf_path,
      mmprojPath: ws.llm.mmproj_path,
      port: Number(lsCfgPort.value) || 0,
    });
    lsStatus.value = res;
    ElMessage.success(`llama-server 已就绪：${res.model || ""}（${res.endpoint || ""}）`);
  } catch (e) {
    const msg = e.message || String(e);
    ElMessage.error(msg.split("\n")[0]);
    try {
      const logRes = await llamaServerLog(40);
      lsLog.value = logRes.log || "";
    } catch { /* ignore */ }
    await refreshLsStatus();
  } finally {
    lsBusy.value = false;
    // 启动失败/加载中持续轮询状态直至终态
    stopLsTimer();
    lsTimer.value = setInterval(async () => {
      await refreshLsStatus();
      const st = lsStatus.value;
      if (!st || (!st.loading && !st.running)) stopLsTimer();
    }, 2000);
  }
}

async function stopLlamaServer() {
  if (lsBusy.value) return;
  lsBusy.value = true;
  try {
    await llamaServerStop();
    lsStatus.value = null;
    ElMessage.success("llama-server 已停止（显存已释放）");
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    lsBusy.value = false;
    stopLsTimer();
    await refreshLsStatus();
  }
}

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
      // llama-server 进程配置（API 管理器维护，只读展示）
      const ls = res.config.llama_server || {};
      lsCfgPath.value = ls.path || "";
      lsCfgPort.value = Number(ls.port) || 8321;
      // LLM 设置全局默认：节点内空缺字段回落 spa_llm（跨工作流保存）
      const spa = res.config.spa_llm || {};
      for (const [k, v] of Object.entries(spa)) {
        if (v && !ws.llm[k]) ws.llm[k] = v;
      }
    }
  } catch { /* ignore */ }
  try {
    browsers.value = await webchatListBrowsers();
  } catch { /* ignore：探测失败时仍可选「自定义路径」 */ }
  // 进入面板即同步 CDP 端点给 llm.js 全局默认
  setCdpEndpoint(ws.llm.cdp_endpoint);
  // 旧存档模式名归一化（llama-cpp → llama-server）
  if (ws.llm.mode === "llama-cpp") {
    ws.llm.mode = "llama-server";
    ws.markDirty();
  }
  if (ws.llm.mode === "llama-server") await refreshLsStatus();
});

onUnmounted(stopLsTimer);

const bridgeSite = computed(() => BRIDGE_SITES[NORMALIZED_MODE(ws.llm.mode)] || null);
const isBridgeMode = computed(() => !!bridgeSite.value);

// API 管理器中的 llama-server 配置（路径/端口在 ComfyUI 设置里维护，此处只读展示）
const lsCfgPath = ref("");
const lsCfgPort = ref(8321);

// LLM 设置全局持久化（api_config.json 的 spa_llm 段）：节点内已设置的字段优先，
// 空缺字段回落全局默认；修改后防抖写回，跨工作流/刷新不丢失，无需每次重选。
let saveTimer = null;
async function persistLlmConfig() {
  try {
    const res = await fetchConfig();
    if (!res?.success) return;
    const config = res.config || {};
    config.spa_llm = {
      mode: ws.llm.mode || "",
      gguf_path: ws.llm.gguf_path || "",
      mmproj_path: ws.llm.mmproj_path || "",
      provider: ws.llm.provider || "",
      api_key: ws.llm.api_key || "",
      ollama_model: ws.llm.ollama_model || "",
      ollama_base_url: ws.llm.ollama_base_url || "",
      cdp_endpoint: ws.llm.cdp_endpoint || "",
      browser: ws.llm.browser || "",
      browser_path: ws.llm.browser === "custom" ? (ws.llm.browser_path || "") : "",
    };
    await saveConfig(config);
  } catch { /* 持久化失败不打扰用户（节点内存档仍会保存） */ }
}

function dirty() {
  ws.markDirty();
  if (isBridgeMode.value) setCdpEndpoint(ws.llm.cdp_endpoint);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistLlmConfig, 800);
}

// 一键启动调试浏览器并打开当前桥接站点（幂等；用户目录 = 项目 userdata/browser）
async function launchBrowser() {
  launching.value = true;
  try {
    setCdpEndpoint(ws.llm.cdp_endpoint);
    const res = await webchatLaunch({
      browser: ws.llm.browser === "custom" ? "" : ws.llm.browser,
      browserPath: ws.llm.browser === "custom" ? ws.llm.browser_path : "",
      site: ws.llm.mode,
      cdpEndpoint: ws.llm.cdp_endpoint,
    });
    if (res.endpoint && res.endpoint !== ws.llm.cdp_endpoint) {
      ws.llm.cdp_endpoint = res.endpoint;
      ws.markDirty();
      setCdpEndpoint(res.endpoint);
    }
    if (res.connected) {
      ElMessage.success(res.launched ? "浏览器已启动，CDP 已连接（独立用户目录，首次需登录站点）" : "调试浏览器已在运行，无需重复启动");
    } else {
      ElMessage.error((res.error || "启动失败").split("\n")[0]);
    }
    await testConnection();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    launching.value = false;
  }
}

// 测试 CDP 连接（真实连接一次，失败时返回后端给出的启动参数提示）
async function testConnection() {
  bridgeSyncing.value = true;
  try {
    const ep = (ws.llm.cdp_endpoint || "").trim();
    const st = await webchatTestConnection(ep);
    bridgeStatus.value = st;
    if (st.connected) {
      ElMessage.success(`CDP 已连接：${st.endpoint}`);
    } else {
      ElMessage.error((st.error || "无法连接浏览器调试端口").split("\n")[0]);
    }
  } catch (e) {
    bridgeStatus.value = { connected: false, error: e.message || String(e) };
    ElMessage.error(e.message || String(e));
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
      <!-- llama-server（外部 llama.cpp HTTP 服务端，替代进程内 llama-cpp-python） -->
      <template v-if="ws.llm.mode === 'llama-server'">
        <el-alert type="info" :closable="false" show-icon class="mrd-bridge-hint">
          <template #title>
            可执行文件与端口在 ComfyUI 设置 → MiniMaxRefDirector → API 管理器（llama-server 页）中配置并保存，
            此处自动使用，无需重复填写；GGUF / mmproj 模型在本页选择。
            生成时若未运行会自动拉起，空闲 5 分钟自动停止；工作流采样前也会自动停止以释放显存，无需手动管理。
            当前：{{ lsCfgPath || "（API 管理器中未配置路径）" }} · 端口 {{ lsCfgPort }}
          </template>
        </el-alert>
        <div class="mrd-field">
          <label>GGUF 模型（models/llm）</label>
          <el-select v-model="ws.llm.gguf_path" filterable allow-create clearable placeholder="选择或输入 GGUF 文件名" @change="dirty">
            <el-option v-for="f in ggufFiles" :key="f" :label="f" :value="f" />
          </el-select>
        </div>
        <div class="mrd-field">
          <label>mmproj 视觉投影器（传图分析需要）</label>
          <el-select v-model="ws.llm.mmproj_path" filterable allow-create clearable placeholder="选择或输入 mmproj 文件名（可空）" @change="dirty">
            <el-option v-for="f in mmprojFiles" :key="f" :label="f" :value="f" />
          </el-select>
        </div>
        <p v-if="!ggufFiles.length" class="mrd-field-hint">未在 models/llm 下发现 GGUF 文件，可手动输入文件名。</p>
        <div class="mrd-field">
          <label>
            服务控制&nbsp;&nbsp;-&nbsp;&nbsp; 
            <small class="mrd-ls-status">
              <template v-if="lsStatus?.running">运行中：{{ lsStatus.model }}（{{ lsStatus.endpoint }}）</template>
              <template v-else-if="lsStatus?.loading">模型加载中…</template>
              <template v-else>已停止</template>
            </small>
          </label>
          <div class="mrd-ds-row">
            <el-button type="primary" :loading="lsBusy" :disabled="lsStatus?.running" @click="startLlamaServer">启动</el-button>
            <el-button type="danger" plain :loading="lsBusy" :disabled="!lsStatus?.running && !lsStatus?.loading" @click="stopLlamaServer">停止</el-button>
          </div>
          <pre v-if="lsLog" class="mrd-ls-log">{{ lsLog }}</pre>
        </div>
      </template>

      <!-- api -->
      <template v-else-if="ws.llm.mode === 'api'">
        <el-alert type="info" :closable="false" show-icon class="mrd-bridge-hint">
          <template #title>
            服务商的接入点、模型列表与 API Key 在 ComfyUI 设置 → MiniMaxRefDirector → API 管理器 中配置（保存后全局生效）；
            此处的服务商选择与 API Key 为本工作流覆盖项，修改后会自动保存。
          </template>
        </el-alert>
        <div class="mrd-field">
          <label>服务商</label>
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
        <el-alert type="info" :closable="false" show-icon class="mrd-bridge-hint">
          <template #title>
            Ollama 服务地址默认 http://localhost:11434；模型标签与服务地址修改后会自动保存，无需每次重选。
          </template>
        </el-alert>
        <div class="mrd-field">
          <label>模型标签</label>
          <el-input v-model="ws.llm.ollama_model" placeholder="如 qwen2.5vl:7b（留空回落配置）" @change="dirty" />
        </div>
        <div class="mrd-field">
          <label>服务地址</label>
          <el-input v-model="ws.llm.ollama_base_url" placeholder="http://localhost:11434（留空用默认）" @change="dirty" />
        </div>
      </template>

      <!-- 网页桥接三模式（DeepSeek / 豆包 / 千问）：CDP 附加用户真实浏览器 -->
      <template v-else-if="isBridgeMode">
        <el-alert type="info" :closable="false" show-icon class="mrd-bridge-hint">
          <template #title>{{ bridgeSite.hint }}</template>
        </el-alert>
        <div class="mrd-field">
          <label>浏览器</label>
          <div class="mrd-ds-row">
            <el-select v-model="ws.llm.browser" placeholder="选择浏览器" @change="dirty">
              <el-option
                v-for="b in browsers"
                :key="b.id"
                :label="b.name + (b.installed ? '' : '（未检测到）')"
                :value="b.id"
                :disabled="!b.installed"
              />
              <el-option label="自定义路径…" value="custom" />
            </el-select>
            <el-button :loading="launching" type="primary" plain @click="launchBrowser">
              启动浏览器并打开{{ bridgeSite.name }}
            </el-button>
          </div>
          <el-input
            v-if="ws.llm.browser === 'custom'"
            v-model="ws.llm.browser_path"
            placeholder="浏览器可执行文件完整路径，如 C:\Program Files\...\chrome.exe"
            @change="dirty"
          />
          <p class="mrd-field-hint">
            启动使用独立用户目录（项目 userdata\browser），首次在里面登录站点后 cookies 会保留，
            之后无需重复登录；按钮可重复点击，已在运行时不会重复拉起。
          </p>
        </div>
        <div class="mrd-field">
          <label>调试端口（CDP）</label>
          <div class="mrd-ds-row">
            <el-input v-model="ws.llm.cdp_endpoint" placeholder="http://127.0.0.1:9222" @change="dirty">
              <template #prefix><el-icon><component :is="'Link'" /></el-icon></template>
            </el-input>
            <el-button :loading="bridgeSyncing" @click="testConnection">测试连接</el-button>
          </div>
          <p v-if="bridgeStatus" class="mrd-field-hint">
            CDP 状态：
            <span :class="bridgeStatus.connected ? 'mrd-ds-ok' : 'mrd-ds-bad'">
              {{ bridgeStatus.connected ? "已连接" : "未连接" }}
            </span>
            （H3 生成 / 翻译 / 分镜导入经此通道调用网页模型）
          </p>
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
.mrd-ls-status { color: #6b7488; }
.mrd-ls-log { max-height: 140px; overflow: auto; font-size: 10.5px; line-height: 14px; color: #f87171; background: rgba(248,113,113,0.06); border: 1px dashed rgba(248,113,113,0.35); border-radius: 4px; padding: 6px 8px; margin: 8px 0 0; white-space: pre-wrap; word-break: break-all; }
.mrd-ds-row .el-input { flex: 1; }
.mrd-ds-row .el-button { flex: none; }
.mrd-ds-ok { color: #4ade80; }
.mrd-ds-bad { color: #f87171; }
</style>
