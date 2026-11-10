<script setup>
// 全局参数配置页：左侧菜单 + 右侧详情
// 菜单：基础设置 / LLM 设置 / 全局提示词 / 分镜技能
import { computed, onMounted, ref } from "vue";
import { useWorkspace } from "../stores/workspace.js";
import BasicSettingsPanel from "../components/global/BasicSettingsPanel.vue";
import LlmSettingsPanel from "../components/global/LlmSettingsPanel.vue";
import GlobalPromptPanel from "../components/global/GlobalPromptPanel.vue";
import SkillDictPanel from "../components/global/SkillDictPanel.vue";

const ws = useWorkspace();

const MENU = [
  { key: "basic", label: "基础设置", icon: "Setting" },
  { key: "llm", label: "LLM 设置", icon: "MagicStick" },
  { key: "prompt", label: "全局提示词", icon: "Document" },
  { key: "skills", label: "分镜技能", icon: "Grid" },
];
const active = ref("basic");
const activePanel = computed(
  () => ({ basic: BasicSettingsPanel, llm: LlmSettingsPanel, prompt: GlobalPromptPanel, skills: SkillDictPanel })[active.value]
);

onMounted(() => {
  // 分镜技能面板依赖词典数据，进入页面即预热
  ws.loadSkillDict();
});
</script>

<template>
  <div class="mrd-global">
    <aside class="mrd-global-nav">
      <button
        v-for="m in MENU"
        :key="m.key"
        class="mrd-global-nav-item"
        :class="{ active: active === m.key }"
        @click="active = m.key"
      >
        <el-icon :size="15"><component :is="m.icon" /></el-icon>
        <span>{{ m.label }}</span>
      </button>
    </aside>
    <div class="mrd-global-detail">
      <transition name="mrd-fade" mode="out-in">
        <component :is="activePanel" :key="active" />
      </transition>
    </div>
  </div>
</template>

<style scoped>
.mrd-global {
  width: 100%;
  min-height: calc(100vh - 24px);
  display: flex;
  gap: 18px;
  align-items: stretch;
}
.mrd-global-nav {
  flex: none;
  width: 200px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 8px;
  border-radius: 12px;
  background: #1a1d29;
  border: 1px solid #262c3d;
  position: sticky;
  top: 12px;
}
.mrd-global-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: none;
  border-radius: 9px;
  background: none;
  color: #a9b1c3;
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
  transition: color 0.18s ease, background 0.18s ease;
}
.mrd-global-nav-item:hover { color: #edeff5; background: rgba(255, 255, 255, 0.04); }
.mrd-global-nav-item.active {
  color: #edeff5;
  background: rgba(167, 139, 250, 0.14);
}
.mrd-global-nav-item.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: linear-gradient(180deg, #6c5ce7, #a78bfa);
  box-shadow: 0 0 8px rgba(167, 139, 250, 0.7);
}
.mrd-global-nav-item :deep(.el-icon) { color: inherit; }
.mrd-global-nav-item.active :deep(.el-icon) { color: #a78bfa; }

.mrd-global-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.mrd-fade-enter-active,
.mrd-fade-leave-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.mrd-fade-enter-from,
.mrd-fade-leave-to { opacity: 0; transform: translateY(4px); }
</style>
