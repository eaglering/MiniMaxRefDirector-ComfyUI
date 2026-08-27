import { app } from "../../scripts/app.js";
import { t } from "./i18n.js";

const API_PREFIX = "/minimax_ref/api";

export class APIConfigManager {
  constructor() {
    this.config = null;
    this.dialog = null;
    this.activeIdx = 0;
  }

  _toast(severity, summary, detail) {
    try {
      app.extensionManager?.toast?.add({
        severity,
        summary,
        detail: detail || "",
        life: 3000,
      });
    } catch {
      alert(`${summary}: ${detail || ""}`);
    }
  }

  async loadConfig() {
    const resp = await fetch(`${API_PREFIX}/config`);
    let data;
    try {
      data = await resp.json();
    } catch {
      throw new Error(t("Server responded with an error (HTTP {status})", { status: resp.status }));
    }
    if (!data.success) {
      throw new Error(data.error || t("Failed to load configuration"));
    }
    this.config = data.config;
  }

  async saveConfig() {
    const resp = await fetch(`${API_PREFIX}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: this.config }),
    });
    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.error || t("Failed to save"));
    }
  }

  open() {
    if (this.dialog) {
      this.closeDialog();
    }
    this.loadConfig()
      .then(() => this.render())
      .catch((e) => this._toast("error", t("Failed to load configuration"), e.message));
  }

  closeDialog() {
    if (this.dialog) {
      try {
        this.dialog.close();
      } catch {
        // ignore
      }
      this.dialog.remove();
      this.dialog = null;
    }
  }

  render() {
    const dialog = document.createElement("dialog");
    dialog.className = "minimax-api-manager-dialog";
    dialog.style.width = "720px";
    dialog.style.maxWidth = "92vw";
    dialog.style.maxHeight = "85vh";
    dialog.style.border = "1px solid #555";
    dialog.style.borderRadius = "8px";
    dialog.style.background = "#1e1e1e";
    dialog.style.color = "#eee";
    dialog.style.padding = "0";
    dialog.style.overflow = "hidden";

    // ---- header ----
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.padding = "12px 16px";
    header.style.background = "#2a2a2a";
    header.style.borderBottom = "1px solid #444";

    const title = document.createElement("h2");
    title.textContent = t("MiniMax API Manager");
    title.style.margin = "0";
    title.style.fontSize = "16px";
    header.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.type = "button";
    closeBtn.style.background = "transparent";
    closeBtn.style.border = "none";
    closeBtn.style.color = "#aaa";
    closeBtn.style.fontSize = "18px";
    closeBtn.style.cursor = "pointer";
    closeBtn.onclick = () => this.closeDialog();
    header.appendChild(closeBtn);

    // ---- content ----
    const content = document.createElement("div");
    content.style.padding = "16px";
    content.style.overflowY = "auto";
    content.style.maxHeight = "calc(85vh - 120px)";

    const tabs = document.createElement("div");
    tabs.style.display = "flex";
    tabs.style.flexWrap = "wrap";
    tabs.style.gap = "8px";
    tabs.style.marginBottom = "16px";
    tabs.style.borderBottom = "1px solid #444";
    tabs.style.paddingBottom = "8px";

    const panel = document.createElement("div");

    const refreshTabs = () => {
      tabs.innerHTML = "";
      this.config.services.forEach((svc, idx) => {
        const tab = document.createElement("button");
        tab.textContent = svc.name || svc.id;
        tab.type = "button";
        tab.style.padding = "6px 12px";
        tab.style.cursor = "pointer";
        tab.style.border = "1px solid #555";
        tab.style.borderRadius = "4px";
        tab.style.background = idx === this.activeIdx ? "#3a86ff" : "#2a2a2a";
        tab.style.color = idx === this.activeIdx ? "#fff" : "#ddd";
        tab.onclick = () => {
          this.activeIdx = idx;
          refreshTabs();
          renderPanel();
        };
        tabs.appendChild(tab);
      });
    };

    const renderPanel = () => {
      panel.innerHTML = "";
      const svc = this.config.services[this.activeIdx];
      if (!svc) return;

      panel.appendChild(
        this._row(
          t("Provider name"),
          this._input(svc.name, (v) => (svc.name = v))
        )
      );
      panel.appendChild(
        this._row(t("Base URL"), this._input(svc.base_url, null, true))
      );
      panel.appendChild(
        this._row(
          t("API Key"),
          this._input(svc.api_key || "", (v) => (svc.api_key = v), false, "password")
        )
      );
      panel.appendChild(
        this._row(
          t("Default LLM"),
          this._modelSelect(
            svc.llm_models,
            this.config.current.llm.service === svc.id
              ? this.config.current.llm.model
              : "",
            (v) => {
              this.config.current.llm = { service: svc.id, model: v };
            }
          )
        )
      );
      panel.appendChild(
        this._row(
          t("Default VLM"),
          this._modelSelect(
            svc.vlm_models,
            this.config.current.vlm.service === svc.id
              ? this.config.current.vlm.model
              : "",
            (v) => {
              this.config.current.vlm = { service: svc.id, model: v };
            }
          )
        )
      );

      const help = document.createElement("div");
      help.style.marginTop = "12px";
      help.style.fontSize = "12px";
      help.style.color = "#aaa";
      help.textContent = t("ApiKeyHint");
      panel.appendChild(help);
    };

    content.appendChild(tabs);
    content.appendChild(panel);

    // ---- footer ----
    const footer = document.createElement("div");
    footer.style.display = "flex";
    footer.style.justifyContent = "flex-end";
    footer.style.gap = "10px";
    footer.style.padding = "12px 16px";
    footer.style.background = "#2a2a2a";
    footer.style.borderTop = "1px solid #444";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = t("Cancel");
    cancelBtn.type = "button";
    cancelBtn.className = "p-button p-component p-button-secondary";
    cancelBtn.style.cursor = "pointer";
    cancelBtn.onclick = () => this.closeDialog();
    footer.appendChild(cancelBtn);

    const saveBtn = document.createElement("button");
    saveBtn.textContent = t("Save");
    saveBtn.type = "button";
    saveBtn.className = "p-button p-component p-button-primary";
    saveBtn.style.cursor = "pointer";
    saveBtn.onclick = async () => {
      try {
        await this.saveConfig();
        this.closeDialog();
        this._toast("success", t("Saved successfully"), t("API configuration saved"));
      } catch (e) {
        this._toast("error", t("Failed to save"), e.message);
      }
    };
    footer.appendChild(saveBtn);

    dialog.appendChild(header);
    dialog.appendChild(content);
    dialog.appendChild(footer);

    document.body.appendChild(dialog);
    dialog.showModal();
    this.dialog = dialog;

    // 点击遮罩（backdrop）关闭
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) {
        this.closeDialog();
      }
    });

    refreshTabs();
    renderPanel();
  }

  _row(label, control) {
    const row = document.createElement("div");
    row.style.marginBottom = "12px";
    const lbl = document.createElement("label");
    lbl.textContent = label;
    lbl.style.display = "block";
    lbl.style.marginBottom = "4px";
    lbl.style.color = "#ddd";
    row.appendChild(lbl);
    row.appendChild(control);
    return row;
  }

  _input(value, onChange, readonly = false, type = "text") {
    const input = document.createElement("input");
    input.type = type;
    input.value = value || "";
    input.readOnly = readonly;
    input.style.width = "100%";
    input.style.padding = "6px";
    input.style.boxSizing = "border-box";
    input.style.background = readonly ? "#222" : "#1a1a1a";
    input.style.color = "#eee";
    input.style.border = "1px solid #555";
    input.style.borderRadius = "4px";
    if (onChange) input.onchange = (e) => onChange(e.target.value);
    return input;
  }

  _modelSelect(models, selected, onChange) {
    const select = document.createElement("select");
    select.style.width = "100%";
    select.style.padding = "6px";
    select.style.background = "#1a1a1a";
    select.style.color = "#eee";
    select.style.border = "1px solid #555";
    select.style.borderRadius = "4px";

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = t("Select Model");
    select.appendChild(empty);

    (models || []).forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      if (m === selected) opt.selected = true;
      select.appendChild(opt);
    });

    select.onchange = (e) => onChange(e.target.value);
    return select;
  }
}
