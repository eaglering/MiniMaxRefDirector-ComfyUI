# MiniMaxRefDirector-ComfyUI

**v3.0.0** — 面向 MiniMax H3 Reference-to-Video 的「导演式」多段分镜工作流。

ComfyUI 自定义节点包：在时间线上编排多段镜头，用 VLM 自动撰写分镜提示词，绑定参考图 / 参考视频 / 参考音频，逐段生成视频并跨段衔接（motion context），最终按顺序合并输出。

---

## 特性

- **时间线导演（Timeline Editor）**：在 Director 节点内直接编排多段时间线，每段独立设置提示词、时长、镜头、参考素材，所见即所得。
- **VLM 智能提示词写作**：可选多种 VLM 服务（API 或本地 llama-cpp），根据画面描述自动生成分镜提示词；输出语言跟随你的输入（中文输入出中文，英文输入出英文）。
- **MiniMax H3 Reference-to-Video**：为 H3 视频生成提供 reference 条件（参考图 / 参考视频 / 参考音频）。
- **Hybrid Loader**：`fl2va`（高质量基底）+ `ref2va`（参考条件覆盖）混合加载，兼顾质量与参考跟随。
- **视频素材条**：
  - 生成视频自动回填到素材条；
  - 拖拽上传本地文件；
  - 多选后**按选中顺序**合并视频；
  - 多 Tab / 多工作流互不干扰（按节点隔离存储）。
- **API 配置面板**：在 ComfyUI Settings 中可视化配置多家服务商。

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/<your-repo>/MiniMaxRefDirector-ComfyUI.git
cd MiniMaxRefDirector-ComfyUI
pip install -r requirements.txt   # 仅 av 一个额外依赖，其余由 ComfyUI 自带
```

重启 ComfyUI 后即可在节点列表中看到本包全部节点。

> 提示：前端 JS 改动后需强制刷新浏览器（Ctrl+F5）；后端 Python 改动需重启 ComfyUI；`prompt/` 下的提示词模板每次调用时读取，即时生效。

## 节点

| 节点类名 | 功能 |
| --- | --- |
| `MiniMaxRefDirector` | 时间线导演：管理多段分镜时间线，汇总参考素材与全局配置，输出 `guide_data` |
| `MiniMaxRefGuide` | 分镜引导：在循环（如 Easy-Use forLoop）中逐段取出 `guide_data`，构建 H3 的 positive conditioning 与 latent |
| `MiniMaxRefSubject` | 主体分析：配置 VLM，分析/绑定视频中的主体，输出 subject 参考数据 |
| `MiniMaxRefJoinString` | 字符串拼接 / 模板占位符替换，用于组装提示词模板 |
| `MiniMaxRefMergeVideosFromPaths` | 按给定顺序合并多个视频文件（ffmpeg 拼接） |
| `MiniMaxRefSaveImage` | 保存图像到输出目录 |
| `MiniMaxRefSaveAudio` | 保存音频到输出目录 |
| `MiniMaxRefHybridLoader` | fl2va + ref2va 混合加载器：加载基底模型并叠加参考条件覆盖 |
| `MiniMaxRefPureVRAM` | 清理 VRAM / 卸载模型，防止长时间批量生成导致显存耗尽 |

## 使用流程

1. 打开示例工作流 `workflow/MinimaxH3 V3 示例.json`（或从节点列表手动搭建）。
2. 在 `MiniMaxRefDirector` 中打开时间线编辑器：添加素材（拖拽或上传）、编排分段、设置时长与镜头语言。
3. 在 `MiniMaxRefSubject` 中配置主体分析与 VLM（如需自动生成提示词）。
4. `MiniMaxRefGuide` 置于循环内，逐段取出 `guide_data` 构建 conditioning，送入 H3 采样器生成视频。
5. 生成结果自动回填 Director 素材条；多选素材后可**按选中顺序**合并，得到完整成片。

> 推荐搭配 [ComfyUI-H3-Motion-Context](https://github.com/niuro3/ComfyUI-H3-Motion-Context) 使用，以实现跨段 motion context 衔接（相邻段尾部画面作为下一段参考）。

## 提示词模板

| 文件 | 说明 |
| --- | --- |
| `prompt/minimaxh3_custom_ref2v_prompt_writing.txt` | 自定义写作提示词：交给 VLM 按给定结构生成分镜 JSON |
| `prompt/minimaxh3_official_ref2v_prompt_writing.txt` | 官方写作提示词：使用官方推荐的提示词策略 |

模板为纯文本，可在不改代码的前提下调整提示词策略（**输出语言跟随用户输入**、标点跟随输出语言等规则已内建）。

## API 配置

进入 ComfyUI **Settings** → 打开「API Manager / API 配置」面板：

- 选择服务商（智谱 GLM、Moonshot、通义 Qwen、豆包 Doubao、OpenAI 兼容等），填写 API Key。
- 节点侧 `api_provider` 下拉会自动同步已配置的服务商。
- VLM 模式可选：
  - **API**：走云端 VLM 服务；
  - **llama-cpp / transformers**：本地部署视觉模型（需自备模型文件）。

## 目录结构

```
MiniMaxRefDirector-ComfyUI/
├── __init__.py            # 节点注册
├── director.py            # 时间线导演节点
├── guide.py               # 分镜引导节点
├── subject.py             # 主体分析节点
├── server.py              # 后端 API（素材上传、视频合并、VLM 分析等）
├── api_config.py          # API 服务商配置
├── lib/                   # 辅助节点与核心逻辑（prompt / h3 / video / audio / image / llm / hybrid / utils）
├── js/                    # 前端 UI（时间线编辑器、素材条、API 配置面板等）
├── prompt/                # 提示词模板
├── workflow/              # 示例工作流
├── requirements.txt       # 依赖（av）
└── pyproject.toml
```

## 更新日志

### v3.0.0

- 全面重构为 MiniMax H3 Reference-to-Video 流程：
  - 新增时间线导演（Timeline Editor），多段分镜编排。
  - 新增 Hybrid Loader（fl2va + ref2va 混合加载）。
  - 新增视频素材条：生成视频自动回填、拖拽上传、按选中顺序合并。
  - 新增 subject 主体分析与 VLM 提示词写作。
  - 提示词输出语言跟随用户输入（中文/英文）。
  - 多 Tab / 多工作流素材隔离，互不干扰。
  - 节点 API 收敛为 `MiniMaxRef*` 系列，配置集中于 Settings 面板。

### v2.1.0

- 早期版本：基于 MiniMax 早期参考视频流程的导演节点与配置面板（已被 v3 取代，历史代码见 `.bk` 备份文件）。

## 免责声明

本项目为社区开源实现，与 MiniMax 官方无关联。使用请遵守各服务商 API 服务条款与相关法律法规。
