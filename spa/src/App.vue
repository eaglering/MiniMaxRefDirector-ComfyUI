<script setup>
import { computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWorkspace } from "./stores/workspace.js";

const ws = useWorkspace();
const route = useRoute();
const router = useRouter();

const menus = [
  { path: "/global", label: "全局参数", icon: "Setting" },
  { path: "/subjects", label: "主体管理", icon: "Avatar" },
  { path: "/storyboard", label: "分镜", icon: "Film" },
  { path: "/records", label: "生成记录", icon: "VideoCamera" },
];

const statusText = computed(() => {
  switch (ws.saveStatus) {
    case "saving": return "保存中…";
    case "saved": return "已保存";
    case "error": return "保存失败";
    case "offline": return "未连接";
    default: return "待编辑";
  }
});

const statusClass = computed(() => `mrd-status mrd-status--${ws.saveStatus}`);

onMounted(() => {
  ws.load();
});

function onMenu(path) {
  router.push(path);
}
</script>

<template>
  <div class="mrd-app">
    <header class="mrd-topbar">
      <div class="mrd-brand">
        <span class="mrd-brand-mark">M</span>
        <span class="mrd-brand-name">MiniMax 导演台</span>
        <el-tag v-if="ws.nodeId" size="small" effect="dark" class="mrd-node-tag">节点 {{ ws.nodeId }}</el-tag>
      </div>
      <nav class="mrd-menus">
        <button
          v-for="m in menus"
          :key="m.path"
          class="mrd-menu-item"
          :class="{ active: route.path === m.path }"
          @click="onMenu(m.path)"
        >
          <el-icon :size="15"><component :is="m.icon" /></el-icon>
          <span>{{ m.label }}</span>
        </button>
      </nav>
      <div class="mrd-topbar-right">
        <span :class="statusClass">
          <i class="mrd-status-dot" />{{ statusText }}
        </span>
        <el-button size="small" text :icon="'Refresh'" @click="ws.saveNow()">立即保存</el-button>
      </div>
    </header>

    <main class="mrd-main">
      <el-alert
        v-if="ws.loadError"
        type="error"
        :title="ws.loadError"
        :closable="false"
        show-icon
        style="max-width: 720px; margin: 40px auto"
      />
      <router-view v-else v-show="ws.loaded" />
      <div v-if="!ws.loaded && !ws.loadError" class="mrd-boot">
        <el-icon class="is-loading" :size="28"><Loading /></el-icon>
        <span>正在加载导演台数据…</span>
      </div>
    </main>
  </div>
</template>

<style scoped>
.mrd-topbar {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 18px;
  background: linear-gradient(180deg, #171b26 0%, #12151d 100%);
  border-bottom: 1px solid #262c3d;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  position: relative;
  z-index: 10;
}
.mrd-brand { display: flex; align-items: center; gap: 10px; }
.mrd-brand-mark {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 15px; color: #fff;
  background: linear-gradient(135deg, #6c5ce7 0%, #4d6bfe 100%);
  box-shadow: 0 0 14px rgba(108, 92, 231, 0.45);
}
.mrd-brand-name { font-size: 15px; font-weight: 600; letter-spacing: 1px; }
.mrd-node-tag { background: #232837; border-color: #2a3042; color: #a9b1c3; }

.mrd-menus { display: flex; gap: 4px; flex: 1; height: 100%; }
.mrd-menu-item {
  position: relative;
  display: flex; align-items: center; gap: 7px;
  padding: 0 18px; height: 100%;
  background: none; border: none; cursor: pointer;
  color: #a9b1c3; font-size: 13.5px;
  transition: color 0.18s ease, background 0.18s ease;
}
.mrd-menu-item:hover { color: #edeff5; background: rgba(255, 255, 255, 0.04); }
.mrd-menu-item.active { color: #fff; }
.mrd-menu-item.active::after {
  content: "";
  position: absolute; left: 14px; right: 14px; bottom: 0; height: 2px;
  border-radius: 2px 2px 0 0;
  background: linear-gradient(90deg, #6c5ce7, #a78bfa);
  box-shadow: 0 0 10px rgba(167, 139, 250, 0.8);
}

.mrd-topbar-right { display: flex; align-items: center; gap: 12px; }
.mrd-status { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6b7488; }
.mrd-status-dot { width: 7px; height: 7px; border-radius: 50%; background: #4b5266; display: inline-block; }
.mrd-status--saving { color: #f5b544; }
.mrd-status--saving .mrd-status-dot { background: #f5b544; animation: mrd-pulse 1s infinite; }
.mrd-status--saved { color: #22c55e; }
.mrd-status--saved .mrd-status-dot { background: #22c55e; box-shadow: 0 0 6px rgba(34, 197, 94, 0.7); }
.mrd-status--error { color: #ef4444; }
.mrd-status--error .mrd-status-dot { background: #ef4444; }
@keyframes mrd-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

.mrd-boot {
  height: 100%;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  color: #6b7488; font-size: 13px; letter-spacing: 1px;
}
</style>
