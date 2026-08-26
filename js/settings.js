import { app } from "../../scripts/app.js";
import { APIConfigManager } from "./apiConfigManager.js";
import { t } from "./i18n.js";

// 新版 ComfyUI (0.3.x+) 通过 app.registerExtension 的 settings 字段注册设置项，
// 不再支持旧的 app.ui.settings.addSetting({ type: 函数 }) 形式。
app.registerExtension({
  name: "MiniMaxRefDirector.Settings",
  settings: [
    {
      id: "MiniMaxRefDirector.APIConfig",
      name: t("MiniMax API Manager"),
      category: ["MiniMaxRefDirector", t("API Configuration")],
      tooltip: t("ApiConfigTooltip"),
      type: () => {
        const row = document.createElement("tr");
        row.className = "minimax-ref-settings-row";

        const labelCell = document.createElement("td");
        labelCell.className = "comfy-menu-label";
        row.appendChild(labelCell);

        const buttonCell = document.createElement("td");
        const button = document.createElement("button");
        button.textContent = t("Open API Manager");
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
