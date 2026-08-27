# MiniMaxRefDirector-ComfyUI


**v3.1.3** — 面向 MiniMax H3 Reference-to-Video 的「导演式」多段分镜工作流。

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

> 推荐搭配 [ComfyUI-H3-Motion-Context-MultiRef](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context-MultiRef) 使用，以实现跨段 motion context 衔接（相邻段尾部画面作为下一段参考）。v3.1.1 起仅依赖 MultiRef 变体，旧版 `ComfyUI-H3-Motion-Context` 需从 `custom_nodes` 中移除或改名为 `.disable`。

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

### v3.1.3

- 修复 LLM 生成中文提示词偶发报错：`parse_generated_json` 改为 `json.loads(..., strict=False)`，允许 JSON 字符串值内出现未转义的控制字符（模型直接写原始换行/制表符），不再报 `Invalid control character at: ...`。
- 中文提示词输出语言强制：生成 prompt 末尾追加 `## Output Language` 强制指令（中/英文模板分别约束），中文模板的示例与语言规则同步改为中文，避免模型被模板中的英文正文/示例带偏——点「中」按钮后仍输出英文的问题。

### v3.1.2

- 提示词输入框关键词高亮：时间线编辑器与主体卡片的全部 prompt textarea（Segment Prompt、summary / detailed_description / overall_soundscape / non_diegetic_music、保留描述、H3 预览）支持 `<@主体>`、`<#主体:对白>`、`<d>...</d>` 彩色高亮，所见即所得。
- 保留描述（段级覆盖）弹窗允许引用 `relation:none`（仅引用）的主体；左右 prompt 中仍保持禁用。
- 生成提示词时间戳位置规则强化：`At MM:SS.mmm` 必须紧跟所属 `[Shot N]` 标记之后，禁止前置，避免模型生成"时间戳在镜头标记前"的错误写法。
- 翻译保护增强：
  - 双引号（含全角 `"…"` / `'…'`）包裹的内容在翻译时保持原语言，不做占位掩码，杜绝改写（单引号 `'` 不参与保护，避免与英文撇号冲突）。
  - 翻译模板明确：引号内台词/标语/歌名等逐字保留。
- 视频素材去除"下载/投屏"按钮：`controlsList="nodownload noremoteplayback"` + `disablePictureInPicture`；并隐藏 360 等浏览器视频扩展注入的悬浮操作层。

### v3.1.1

- 修复 motion context 模块误命中：`_get_motion_context_module()` 此前按目录名前缀匹配，可能加载旧版 `ComfyUI-H3-Motion-Context`，其 `MiniMaxH3MotionContext.apply()` 缺少 `encode_mode` 参数，运行时报 `TypeError: apply() got an unexpected keyword argument 'encode_mode'`。
- 现在仅匹配 **`ComfyUI-H3-Motion-Context-MultiRef`**（其 `apply()` 支持 `encode_mode` / `anchor_mode` / `crop` 显式参数），MultiRef 不存在时抛出明确错误提示，不再尝试兼容旧版。

### v3.1.0

- 修复音频链路误判：当时间线音频段越界、全为补白空白段、或源音频文件加载失败时，不再合成全零静音音轨，正确视为「无音频」——避免生成结果出现「无声 + 被标记无损（image_latent）」的错误分支。
- 修复 `master_audio` 缓存误命中：缓存键由对象 id 改为内容指纹（sha1），消除 forLoop / 跨 prompt 场景下复用旧音频合成的隐患。
- 新增轻量诊断日志：Guide / Director 输出 `audio_segments` 段数，便于排查音频链路。

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
