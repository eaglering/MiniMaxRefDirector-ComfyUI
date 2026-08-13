import { app } from "../../scripts/app.js";
import { APIConfigManager } from "./apiConfigManager.js";

// 新版 ComfyUI (0.3.x+) 通过 app.registerExtension 的 settings 字段注册设置项，
// 不再支持旧的 app.ui.settings.addSetting({ type: 函数 }) 形式。
app.registerExtension({
  name: "MiniMaxRefDirector.Settings",
  settings: [
    {
      id: "MiniMaxRefDirector.APIConfig",
      name: "MiniMax API 管理器",
      category: ["MiniMaxRefDirector", "API 配置"],
      tooltip:
        "配置 MiniMax Ref Director 各服务商（GLM / Kimi / Qwen / Doubao / xFlow / Ollama）的 API Key 与默认 LLM / VLM 模型",
      type: () => {
        const row = document.createElement("tr");
        row.className = "minimax-ref-settings-row";

        const labelCell = document.createElement("td");
        labelCell.className = "comfy-menu-label";
        row.appendChild(labelCell);

        const buttonCell = document.createElement("td");
        const button = document.createElement("button");
        button.textContent = "打开 API 管理器";
        button.className = "p-button p-component p-button-secondary";
        button.type = "button";
        button.onclick = () => {
          new APIConfigManager().open();
        };
        buttonCell.appendChild(button);
        row.appendChild(buttonCell);
        return row;
      },
    },
  ],
});
