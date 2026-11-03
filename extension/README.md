# MiniMax Ref Director — DeepSeek Bridge（浏览器扩展）

deepseek-proxy LLM 模式的桥接扩展：SPA 导演台页面（全局参数 → LLM 设置 → DeepSeek 代理）
通过本扩展调用 chat.deepseek.com 的网页会话完成 H3 提示词生成 / 翻译，无需 API Key。

## 安装（Chrome / Edge）

1. 打开扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
2. 打开右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本目录（`extension/`）。
4. 加载完成后，在扩展卡片上复制 **ID**（形如 `abcdefghijklmnopabcdefghijklmnop`）。
5. 打开 ComfyUI 的 SPA 导演台 → 全局参数 → LLM 设置 → 选「DeepSeek 代理」，粘贴扩展 ID。

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

## 使用须知

- 使用前请在浏览器中**登录 chat.deepseek.com**（扩展会复用已打开的 DeepSeek
  标签页，没有则自动新开一个后台标签页）。
- 每次请求扩展会尽量先点「开启新对话」再发送，避免上下文污染。
- 请求超时上限约 4 分钟（MV3 Service Worker 存活期限制）。
- DeepSeek 页面结构变更可能导致填充失败；content.js 内置 textarea 与
  contenteditable 两套输入策略尽力兼容。
- 扩展缺失 / 未填 ID 时，SPA 不会崩溃，仅提示错误，可随时切回 llama-cpp /
  API / Ollama 模式。

## 消息协议

SPA（`spa/src/utils/llm.js`）→ 扩展 background：

```js
chrome.runtime.sendMessage(EXT_ID, {
  source: "comfy-minimax-ref",
  type: "deepseek/complete",
  id: "req1",
  payload: { system: "...", prompt: "...", expectJson: true },
}, cb);
```

扩展 → SPA 响应：`{ source: "comfy-minimax-ref-ext", id, ok, text, error }`。
