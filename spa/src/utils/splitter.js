// el-splitter 面板尺寸记忆：拖拽结束把百分比数组写入 localStorage，重进页面恢复
import { reactive } from "vue";

export function useSplitterMemory(key, fallback) {
  const sizes = reactive(load());

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      if (
        Array.isArray(v) &&
        v.length === fallback.length &&
        v.every((n) => typeof n === "number" && n >= 0)
      ) {
        return v.slice();
      }
    } catch {}
    return fallback.slice();
  }

  function onResizeEnd(index, next) {
    // 面板数量变化时（如窄屏隐藏右栏）不写入，避免破坏记忆
    if (!Array.isArray(next) || next.length !== fallback.length) return;
    sizes.splice(0, sizes.length, ...next);
    try {
      localStorage.setItem(key, JSON.stringify([...sizes]));
    } catch {}
  }

  return { sizes, onResizeEnd };
}
