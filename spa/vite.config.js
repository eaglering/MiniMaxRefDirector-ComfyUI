import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteSingleFile } from "vite-plugin-singlefile";
import http from "node:http";

// ComfyUI 后端地址（dev 模式下所有后端请求经 vite 代理转发）
// 可用环境变量覆盖：COMFY_URL=http://127.0.0.1:8188 npm run dev
const COMFY_URL = process.env.COMFY_URL || "http://127.0.0.1:8188";

// 需要代理到 ComfyUI 的路径前缀（SPA 的 API / 媒体 / 静态资源）
const PROXY_PREFIXES = [
  "/minimax_ref",
  "/view",
  "/upload",
  "/extensions",
  "/api",
  "/prompt",
  "/history",
  "/queue",
  "/object_info",
  "/embeddings",
];

// 开发模式：vite dev server（热更新），后端请求代理到 ComfyUI；
// 访问 http://localhost:5173/?node_id=<节点ID> 即可联调（不带 node_id 时默认 dev）。
// 生产构建：单文件 ../js/spa/index.html（JS/CSS 全内联），随 ComfyUI WEB_DIRECTORY 提供。
export default defineConfig(({ command }) => ({
  // dev 用根路径（便于代理/热更新），构建用相对路径（单文件内联）
  base: command === "build" ? "./" : "/",
  plugins: [vue(), viteSingleFile()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: Object.fromEntries(
      PROXY_PREFIXES.map((p) => [
        p,
        {
          target: COMFY_URL,
          changeOrigin: true,
          ws: true,
          // ComfyUI 的 origin_only_middleware 会比对 Host 与 Origin：
          // dev 页面 Origin 是 127.0.0.1:5173，与 Host(:8188) 不一致即 403。
          // 代理层把 Origin 重写为目标地址，等价于同源访问。
          headers: { origin: COMFY_URL },
          // 禁用 keep-alive 连接复用：Node 19+ 的全局 agent 默认 keepAlive，
          // aiohttp 服务端 keepalive 超时后单方面关闭连接，代理复用半关闭的
          // 空闲连接发起新请求会导致请求永久悬挂（表现为 /view 媒体一直加载、
          // 无任何报错，重启 vite dev server 清空连接池后才恢复）。
          // 本地回环新建 TCP 连接成本极低，keepAlive:false 是最稳妥的修复。
          agent: new http.Agent({ keepAlive: false, maxSockets: 256 }),
          timeout: 60_000,
          proxyTimeout: 60_000,
          // 代理错误日志：econnreset / socket hang up 等一目了然
          configure: (proxy, _opts) => {
            proxy.on("error", (err, req) => {
              console.warn(
                `[vite-proxy] ${req?.url || "?"} -> ${COMFY_URL} error: ${err.code || ""} ${err.message}`
              );
            });
          },
        },
      ])
    ),
  },
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
}));
