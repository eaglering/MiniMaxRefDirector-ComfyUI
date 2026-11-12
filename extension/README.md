# MiniMax Ref Director — Web Chat Bridge（浏览器扩展）

deepseek-proxy / doubao-proxy / qianwen-proxy 三种 LLM 模式共用的桥接扩展，两条通道并存：

1. **页面外部消息通道**：SPA 导演台页面（全局参数 → LLM 设置 → DeepSeek / 豆包 / 千问代理）
   通过 `chrome.runtime.sendMessage` 调用本扩展，完成 H3 提示词生成 / 翻译 / 分镜导入；
2. **ComfyUI WebSocket 直连通道**：扩展后台 Service Worker 主动连接 ComfyUI
   桥接端点并注册，ComfyUI 工作流执行期间后端 Python 随时下发 LLM 任务（H3 提示词、
   资源整理等），无需打开任何 ComfyUI 页面。

支持的站点（消息 `payload.site` 决定路由，缺省 deepseek）：

| site | 站点 | 会话地址 |
|---|---|---|
| `deepseek` | DeepSeek | https://chat.deepseek.com/ |
| `doubao` | 豆包 | https://www.doubao.com/chat/ |
| `qwen` | 千问 | https://www.qianwen.com/chat/ |

## 安装（Chrome / Edge）

1. 打开扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
2. 打开右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本目录（`extension/`）。
4. 加载完成后，在扩展卡片上复制 **ID**（形如 `abcdefghijklmnopabcdefghijklmnop`）。
5. 打开 ComfyUI 的 SPA 导演台 → 全局参数 → LLM 设置 → 选「DeepSeek / 豆包 / 千问代理」，粘贴扩展 ID。

## 非本机访问时补充授权

扩展默认只允许 `http://localhost/*` 与 `http://127.0.0.1/*` 的页面调用
（`manifest.json` → `externally_connectable.matches`）。若 ComfyUI 部署在其他地址
（如局域网 IP / 域名 / 反向代理），请把对应 origin 追加到 `matches` 后，在扩展
管理页点「重新加载」：

```json
"externally_connectable": {
  "matches": [
    "http://localhost/*",
    "http://127.0.0.1/*",
    "http://192.168.1.100/*"
  ]
}
```

## ComfyUI WebSocket 直连配置

- 默认连接 `ws://127.0.0.1:8188/minimax_ref/api/deepseek/bridge`，无需配置。
- ComfyUI 不在默认地址时，SPA 全局参数页填写桥接地址后经
  `deepseek/set_bridge_url` 消息写入 `chrome.storage.local`（key：`mrdBridgeUrl`），
  扩展会立即以新地址重连。
- 连接保活：20s 心跳 + 1 分钟 `chrome.alarms` 闹钟（MV3 SW 被回收后自动唤醒重连），
  断线按指数退避（1s → 30s 封顶）重连。
- 状态查询：`deepseek/bridge_status` 返回 `{ connected, url }`。

## 使用须知

- 使用前请在浏览器中**登录对应站点网页**（DeepSeek / 豆包 / 千问；扩展会复用
  已打开的站点标签页，没有则自动新开一个后台标签页）。
- `deepseek/complete` 默认每次先点「开启新对话」再发送，避免上下文污染；
  `session_mode: "reuse"` + `chat_id` 时导航到指定会话内发送（导入流水线使用）。
  会话页 URL 结构：DeepSeek `/a/chat/s/<id>`、豆包 `/chat/<id>`、千问 `/chat/<id>`。
- 请求超时上限约 4 分钟（MV3 Service Worker 存活期限制）。
- DeepSeek 页面结构变更可能导致填充失败；content.js 内置 textarea 与
  contenteditable 两套输入策略尽力兼容。
- 扩展缺失 / 未填 ID 时，SPA 不会崩溃，仅提示错误，可随时切回 llama-cpp /
  API / Ollama 模式。

## 文件结构

| 文件 | 作用 |
|---|---|
| `page-hook.js` | MAIN world、`document_start` 注入：hook `fetch`/XHR 捕获 `/api/v0/chat/completion` 的 SSE 流，把回复正文经 `window.postMessage` 交给 `content.js`（**回复判定主通道，不依赖 DOM 类名**） |
| `content.js` | 隔离世界：填充输入框 / 发送 / 会话管理（站内 API）/ 自检 `ds/probe` / 阶段上报 `ds/stage` |
| `background.js` | MV3 SW：外部消息路由、pending 表、ComfyUI WebSocket 直连（register / heartbeat / llm_task） |

> 回复获取顺序：SSE 流结束且有正文 → 直接返回；否则退回 DOM 文本块稳定检测；
> 两者在 90s 内都无信号则快速失败并提示（不再干等 4 分钟）。

## 消息协议

### 页面 → 扩展 background（`chrome.runtime.sendMessage(EXT_ID, {...}, cb)`）

通用外层：`{ source: "comfy-minimax-ref", type, id?, ... }`；
扩展响应：`{ source: "comfy-minimax-ref-ext", id, ok, data?, text?, error }`。

| type | 附加字段 | 说明 |
|---|---|---|
| `deepseek/complete` | `payload: { site?, system, prompt, expectJson, session_mode?, chat_id? }` | 生成完成。`session_mode:"reuse"` 时在 `chat_id` 会话内发送；`site` 决定目标网页 |
| `deepseek/list_sessions` | `payload: { site? }` | 列出站点会话（站内 API，仅 DeepSeek 支持；豆包/千问返回明确错误） |
| `deepseek/delete_session` | `chat_id`, `payload: { site? }` | 删除整个会话（仅 DeepSeek 支持） |
| `deepseek/set_bridge_url` | `url` | 配置 ComfyUI WS 桥接地址并立即重连 |
| `deepseek/bridge_status` | — | 查询 WS 桥接连接状态 |

### background ↔ content（`chrome.tabs.sendMessage`）

`ds/ping` / `ds/input_ready`（输入框就绪 + 当前 path）/ `ds/write`（只写入，回传
回读内容）/ `ds/enter`（回车 + 发送前基线）/ `ds/sent_check`（核验消息是否真的出现）/
`ds/click_send`（点发送按钮）/ `ds/check`（回复流状态快照）/ `ds/probe`（页面自检）/
`ds/list_sessions` / `ds/cancel`。

页面侧**不做任何定时等待**：所有计时、重试、轮询与结果判定都在 background SW
中完成（隐藏标签页的定时器会被 Chrome 节流甚至停摆，异步流程会永久挂起）。

### ComfyUI → 扩展（WebSocket `/minimax_ref/api/deepseek/bridge`）

- 扩展 → ComfyUI：`{type:"register", ext_version}`、`{type:"ping"}`（20s 心跳）、
  `{type:"llm_result", id, ok, text, error}`
- ComfyUI → 扩展：`{type:"llm_task", id, payload:{system, prompt, expect_json}}`、
  `{type:"pong"}`

## 站内 API 说明（content.js）

会话管理调用 chat.deepseek.com 站内接口（同源带 cookie，路径对齐
linuxfight/deepseek4free 逆向源码）：
`GET /api/v0/chat_session/fetch_page`（会话列表，分页）、
`POST /api/v0/chat_session/create`（body `{"agent":"chat"}`）、
`POST /api/v0/chat_session/delete`、`POST /api/v0/chat_session/update_title`、
`GET /api/v0/chat/history_messages?chat_session_id={id}`。若 DeepSeek 改版失效，
可在网页 DevTools → Network 面板核对真实端点后修改 content.js 顶部的 `DS_API` 常量。

**删除单条消息不可用**：DeepSeek 网页端界面没有该功能，站内也没有可用端点
（早期尝试过的 `/api/v0/chat/message/delete` 从未成功，已移除）。因此导入流程改为
“从源头不污染”：故事大纲先读取会话消息快照，再在**全新会话**内提取，原会话不会
新增任何消息；扩展也绝不会删除用户的整个会话。
