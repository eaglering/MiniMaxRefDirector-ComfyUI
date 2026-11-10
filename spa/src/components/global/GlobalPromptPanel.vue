<script setup>
// 全局参数 · 全局提示词面板（自 GlobalParams 迁移）
// 提示：camera_motion 关键词可手动写入全局提示词，作为全片运镜约束（优先于镜头选择）。
import { computed } from "vue";
import { useWorkspace } from "../../stores/workspace.js";

const ws = useWorkspace();
const globalPromptLen = computed(() => (ws.globalPrompt || "").length);
const dirty = () => ws.markDirty();
</script>

<template>
  <section class="mrd-card mrd-section">
    <h3 class="mrd-section-title"><el-icon><component :is="'Document'" /></el-icon>全局提示词</h3>
    <el-input
      v-model="ws.globalPrompt"
      type="textarea"
      :rows="10"
      maxlength="8000"
      show-word-limit
      resize="vertical"
      placeholder="作用于整个视频的条件提示词：锚定贯穿角色、物件与场景基调（写回 Subject 节点 global_prompt）"
      @input="dirty"
    />
    <div class="mrd-gp-meta">当前 {{ globalPromptLen }} 字</div>
    <el-alert type="info" :closable="false" show-icon class="mrd-gp-hint">
      <template #title>
        运镜关键词可手动写入：如「camera_motion：slow push-in / slow orbit」，将作为全片运镜约束，
        优先于各镜头的运镜选择（Camera Motion LoRA 的触发词 camera motion 会保持在提示词开头）。
      </template>
    </el-alert>
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
.mrd-gp-meta { margin-top: 8px; font-size: 11.5px; color: #6b7488; text-align: right; }
.mrd-gp-hint { margin-top: 10px; }
</style>
