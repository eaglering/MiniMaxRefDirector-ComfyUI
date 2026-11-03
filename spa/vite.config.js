import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteSingleFile } from "vite-plugin-singlefile";

// 单文件构建：产物 ../js/spa/index.html（JS/CSS 全内联），
// 随 ComfyUI WEB_DIRECTORY = "./js" 静态路由提供。
export default defineConfig({
  base: "./",
  plugins: [vue(), viteSingleFile()],
  build: {
    outDir: "../js/spa",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 10_000,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
