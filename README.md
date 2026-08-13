# MiniMaxRefDirector-ComfyUI

**v2.1.0** — MiniMax 导演台参考图生视频工作流。提供可视化时间线编辑器、多主体管理、基于 VLM 的智能提示词增强，以及尾帧自动转首帧参考、循环内尾帧跳过（continue）功能。

## 目录

- [节点概览](#节点概览)
- [安装](#安装)
- [更新日志](#更新日志)
- [模型准备](#模型准备)
- [节点详解](#节点详解)
  - [MiniMax Reference Subject](#minimax-reference-subject)
  - [MiniMax Reference Director](#minimax-reference-director)
  - [MiniMax Reference Director Guide](#minimax-reference-director-guide)
  - [MiniMax Ref Prompt Enhance](#minimax-ref-prompt-enhance) 调试节点
- [工作流连接](#工作流连接)
- [依赖](#依赖)
- [常见问题](#常见问题)

---

## 节点概览

| 节点 | 类别 | 功能 |
|------|------|------|
| **MiniMax Reference Subject** | `minimax` | 可视化配置最多 9 个主体（名称、描述、参考图、音频） |
| **MiniMax Reference Director** | `minimax` | 时间线编辑器，整合分镜提示词、主体数据、尾帧标记和分辨率配置 |
| **MiniMax Reference Director Guide** | `minimaxrefdirector` | 按分镜索引提取段数据，调用 VLM 增强提示词，输出主体图片/音频张量，支持尾帧跳过与自动拼接 |
| **MiniMax Ref Prompt Enhance** | `minimaxrefdirector/prompt` | 独立 VLM 节点：输入图片/文本，输出 JSON 格式的镜头描述与占位符映射 |

---

## 更新日志

### v2.1.0

- **尾帧循环跳过（continue）**：`Guide` 节点遇到 `is_end_frame` 尾帧段时返回 `ExecutionBlocker`，直接跳过当前 Easy-Use 循环迭代（跳过提示词生成/视频生成/保存等所有下游节点），循环索引照常递增进入下一段。
- **尾帧自动拼接**：若当前段的下一个 segment 是尾帧且带有首帧图片，`Guide` 自动将该图片作为当前段「末帧」参考加载，并写入提示词：
  - `detailed_description` 追加 `[Shot x] At MM:SS.mmm <Picture n> fully_preserved.`（时间戳为当前段结束时刻，不受尾帧段时长影响）
  - `subject_definitions` 追加 `<Picture n> is the last frame of [Shot x].`
  - `retention_analysis` 追加 `<Picture n> ([Shot x] last frame): fully_preserved.`
- **Guide 节点升级**：`prompt_enhance` 由布尔开关升级为三模式（`Basic` / `Enhanced` / `Pre-formatted`）；新增 `seed` 参数及 `raw_prompt` / `pre_formatted` 输出。
- 新增示例工作流：`workflow/MiniMax H3 Reference Director 2.1.json`。

### v2.0.0

- 可视化时间线编辑器、多主体管理、VLM 提示词增强、尾帧自动转首帧参考。

---

## 安装

### 方式一：通过 ComfyUI Manager（推荐）

在 ComfyUI Manager 中搜索 `MiniMaxRefDirector` 并安装。

### 方式二：手动安装

```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/your-org/MiniMaxRefDirector-ComfyUI.git
cd MiniMaxRefDirector-ComfyUI
pip install -r requirements.txt
```

---

## 模型准备

节点需要 VLM（视觉语言模型）作为 **text_encoder** 来进行提示词增强。将模型文件放置到 `ComfyUI/models/text_encoders/` 目录。

### 支持模型

| clip_type | 推荐模型 | HuggingFace Repo |
|-----------|----------|-------------------|
| `qwen3vl` | Qwen3-VL-8B-Instruct | `Qwen/Qwen3-VL` |
| `gemma` | Gemma 3 4B | `google/gemma-3-4b-it` |

### 放置方式

**方式 A：仅 safetensors 文件（推荐，自动下载配置）**

将 `.safetensors` 文件放入 `text_encoders/`

```
ComfyUI/models/text_encoders/
└── qwen3vl_8b_fp8_scaled.safetensors
```

---

## 节点详解

### MiniMax Reference Subject

可视化主体管理节点，支持 1-9 个主体，每个主体可配置名称、描述、参考图片和参考音频。

#### 输入

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `subject_data` | STRING | `""` | UI 自动管理的 JSON 状态（手动修改不推荐） |
| `subject_count` | INT | `1` | 活跃主体数量（1-9），控制 UI 显示的主体会话卡数 |

#### 输出

| 参数 | 类型 | 说明 |
|------|------|------|
| `subject_data` | SUBJECT_DATA | 结构化主体数据，供下游节点使用 |

#### 主体字段

每个主体包含：
- **name**（名称）：最多 128 字符
- **description**（描述）：最多 1024 字符
- **imageFile**（参考图）：自动解析为绝对路径
- **audioFile**（音频）：自动解析为绝对路径

---

### MiniMax Reference Director

可视化时间线编辑器，整合分镜排期、主体注入和分辨率配置，输出统一的 `guide_data`。

#### 输入

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `subject_data` | SUBJECT_DATA | — | 从 MiniMax Reference Subject 连接 |
| `global_prompt` | STRING | `""` | 全局提示词，锚定贯穿全片的人物、场景等 |
| `start_second` | FLOAT | `0.0` | 时间线起始（秒） |
| `end_second` | FLOAT | `5.0` | 时间线结束（秒） |
| `duration_seconds` | FLOAT | `5.0` | 总时长（秒） |
| `start_frame` | INT | `0` | 起始帧 |
| `end_frame` | INT | `120` | 结束帧 |
| `duration_frames` | INT | `120` | 总帧数（编辑器视觉尺度参考） |
| `prompt_template` | STRING | `""` | 提示词模板路径（空则使用默认 `prompt/minimax_ref2v_template.txt`；需含 `{user_prompt}` 占位符） |
| `timeline_data` | STRING | `""` | 时间线编辑器 JSON 状态（UI 自动管理） |
| `local_prompts` | STRING | `""` | 分镜提示词列表（UI 自动填充） |
| `segment_lengths` | STRING | `""` | 分镜帧数列表（UI 自动填充） |
| `frame_rate` | FLOAT | `24` | 帧率（影响时间显示和像素计算） |
| `display_mode` | COMBO | `seconds` | 时间轴显示模式（`frames` / `seconds`） |
| `outpu_resolution` | COMBO | `16:9横屏` | 输出宽高比预设（1:1/9:16/16:9/3:2/2:3/4:3/3:4/21:9） |
| `million_pixels` | FLOAT | `0.6` | 目标像素数（百万），用于计算最终分辨率 |

#### 输出

| 参数 | 类型 | 说明 |
|------|------|------|
| `guide_data` | GUIDE_DATA | 整合的时间线数据，含分辨率、主体、分镜信息 |
| `segment_count` | INT | 时间线分镜总数 |

#### 时间线编辑器 UI

- 拖拽分镜边界调整时长
- 每个分镜可填写独立提示词
- 支持图片轨道（分镜首帧参考图）
- 支持 `@` 符号引用主体

---

### MiniMax Reference Director Guide

从 `guide_data` 中按 `seg_index` 提取单个分镜数据，调用 VLM 进行智能提示词增强，输出主体参考图/音频张量和最终提示词。

#### 输入

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `guide_data` | GUIDE_DATA | — | 从 MiniMax Reference Director 连接 |
| `first_frame` | IMAGE | 可选 | 首帧图片输入（未在时间线中设置时使用） |
| `clip` | CLIP | 可选 | 本地 CLIP 模型（从 CLIP Loader 连接），`vlm_mode=clip` 时使用 |
| `vlm_mode` | COMBO | `clip` | VLM 后端选择：`clip`=本地 CLIP / `llama-cpp`=本地 GGUF（需 `gguf_name`）/ `api`=云端 API |
| `gguf_name` | COMBO | 第一个可用 | 本地 GGUF VLM 模型（如 Qwen3-VL），放在 `models/llm`，通过 llama-cpp-python 加载（`vlm_mode=llama-cpp` 时使用） |
| `mmproj_name` | COMBO | `None` | 视觉投影器（mmproj）GGUF（多模态模型需要，`None` 为纯文本模式） |
| `api_provider` | COMBO | `GLM` | 云端 API 提供商（`GLM` / `Kimi` / `Qwen` / `Doubao`），GLM-4V-Flash 完全免费（`vlm_mode=api` 时使用） |
| `api_key` | STRING | `""` | API Key，留空则读取环境变量（`ZHIPU_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY` / `ARK_API_KEY`） |
| `seed` | INT | `42` | 随机种子（高级参数） |
| `last_refer_mode` | BOOLEAN | `false` | 是否使用上一段的首帧作为当前段参考 |
| `prompt_enhance` | COMBO | `Basic` | 增强模式：`Basic`=标准生成 \| `Enhanced`=润色并补充环境音/运镜/BGM \| `Pre-formatted`=按预格式化 JSON 解析（不调用 VLM） |
| `seg_index` | INT | `0` | 分镜索引（0-based），提取第 N 个分镜 |

> 每个分镜可在时间线编辑器内单独覆盖 `prompt_enhance` 模式（`Default` 表示跟随节点全局设置）。
>
> **VLM 模式选择**：由 `vlm_mode` 下拉框显式选择——`api`=云端 API（无需本地模型，速度快）；`llama-cpp`=本地 GGUF（`gguf_name`，通过 llama-cpp-python 加载，`mmproj_name` 提供视觉能力）；`clip`=本地 CLIP（需连接 `clip` 输入或配置 `clip_name`）。所选模式缺少模型时会给出明确错误提示。

#### 输出

| 参数 | 类型 | 说明 |
|------|------|------|
| `image0`-`image8` | IMAGE | 9 路主体参考图（不足时输出 None） |
| `audio0`-`audio2` | AUDIO | 3 路主体参考音频（不足时输出 None） |
| `width` | INT | 输出宽度 |
| `height` | INT | 输出高度 |
| `length` | INT | 当前分镜帧数 |
| `frame_rate` | FLOAT | 帧率 |
| `prompt` | STRING | 组装后的完整提示词 |
| `raw_prompt` | STRING | VLM 原始输出提示词 |
| `pre_formatted` | STRING | 预格式化 JSON 形式提示词 |

#### 提示词增强流程（`prompt_enhance=Basic` / `Enhanced`）

1. 选择 VLM 后端（`vlm_mode`）：`api` 走云端 API（`api_provider`）/ `llama-cpp` 走本地 GGUF（llama-cpp-python，`gguf_name`）/ `clip` 走本地 CLIP（`clip` 输入或 `clip_name`）
2. 调用 VLM 生成：详见 [MiniMax Ref Prompt Enhance](#minimax-ref-prompt-enhance)
3. 解析 `mapping`，构建 `subject_definitions` 和 `retention_analysis`
4. 替换占位符为实际主体名称
5. 与 `global_prompt` 拼接输出最终提示词

#### 云端 API（`vlm_mode=api`）

内置 OpenAI 兼容接口，支持以下提供商（均通过 `api_provider` 选择）：

| 提供商 | 模型 | 免费情况 | 环境变量 |
|--------|------|----------|----------|
| **GLM（智谱）** | `glm-4v-flash` | **完全免费** | `ZHIPU_API_KEY` |
| **Kimi（月之暗面）** | `moonshot-v1-8k-vision-preview` | 新账户送 ¥15 试用余额（约 50 万 tokens） | `MOONSHOT_API_KEY` |
| **Qwen（阿里云百炼）** | `qwen-vl-plus` | 新用户每模型 100 万 tokens 免费，90 天有效 | `DASHSCOPE_API_KEY` |
| **Doubao（火山方舟）** | `doubao-1.5-vision-pro-32k` | 新用户送 50~200 万 tokens 免费额度 | `ARK_API_KEY` |

- `api_key` 输入留空时自动读取对应环境变量（推荐，避免 API Key 明文写入工作流）
- 首帧图片会以 JPEG base64 data URL 传给云端模型，输出与本地 GGUF/CLIP 完全同构的 JSON
- API 调用失败（密钥缺失 / HTTP 错误 / JSON 解析失败）会抛出带明确原因的错误

#### 本地 GGUF（llama-cpp-python，`vlm_mode=llama-cpp`）

在本地通过 llama-cpp-python 加载 GGUF 视觉模型（与云端 API 相比无需联网、无额度限制，但更慢，取决于显卡）。支持 llama.cpp 生态的多模态模型（如 Qwen3-VL 系列的 `.gguf` + `mmproj`）。

- **模型放置**：GGUF 与 mmproj 文件放入 `ComfyUI/models/llm/` 目录（节点首次使用会自动注册该目录）
- **手动安装**（节点不会自动下载安装）：首次使用时会检测 `llama-cpp-python` 是否已安装；未安装则不会自动安装，而是在控制台输出提示（含下载链接与步骤），请按以下步骤手动安装：
  1. 打开 https://github.com/JamePeng/llama-cpp-python/releases 下载最新 release 中的预编译 wheel
  2. 选择与你的环境匹配的文件（形如 `llama_cpp_python-0.3.46+cu131-cp313-cp313-win_amd64.whl`），匹配三项：
     - `win_amd64`：Windows x64 平台
     - `cp313`：Python 版本（= Python 3.13；控制台提示会给出本机的 `cpXXX` 标签）
     - `cu131`：CUDA 版本（控制台提示会给出本机 torch 的 `cuXXX` 标签，优先选择相同的，没有则任意 `cu` 版本均可）
  3. 在 `ComfyUI_windows_portable` 目录下用自带的 python 安装：
     ```
     python_embeded\python.exe -m pip install <下载的 .whl 文件路径>
     ```
  4. 安装完成后重启 ComfyUI
- **无 mmproj 时**：`mmproj_name` 选 `None` 则纯文本模式（不分析首帧图片，日志会给出提示）

#### 尾帧行为

- **跳过（continue）**：当前分镜是尾帧（`is_end_frame`）时，`Guide` 对全部输出返回 `ExecutionBlocker`，跳过该轮 Easy-Use 循环迭代中所有下游节点，循环照常进入下一轮。
- **自动拼接（end frame）**：下一个分镜是尾帧且带有首帧图片时，`Guide` 将该图片作为当前分镜的末帧参考加载，并以 `[Shot x] At MM:SS.mmm <Picture n> fully_preserved.` 形式写入 `detailed_description`（同时写入 `subject_definitions` / `retention_analysis`）。时间戳为当前分镜的结束时刻，仅由前面分镜与当前分镜时长决定，不受尾帧段时长影响。

> 注意：若 Easy-Use 循环的 `forLoopEnd`/`whileLoopEnd` 还携带来自生成链的累积值（如上一段末帧），被跳过的轮次会因 `ExecutionBlocker` 传染而卡死循环，需经 Easy-Use 的懒节点 `easy ifElse`（`on_true`/`on_false`）中转。

---

### MiniMax Ref Prompt Enhance

独立的 VLM 节点，支持纯文本或图+文模式，生成结构化的镜头描述和占位符映射 JSON。

#### 输入

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `clip_name` | COMBO | 第一个可用 | text_encoder 模型（`vlm_mode=clip` 时使用） |
| `clip_type` | COMBO | `qwen3vl` | 模型类型（`qwen3vl` / `minimax` / `gemma`） |
| `vlm_mode` | COMBO | `clip` | VLM 后端选择：`clip`=本地 CLIP / `llama-cpp`=本地 GGUF（需 `gguf_name`）/ `api`=云端 API |
| `gguf_name` | COMBO | 第一个可用 | 本地 GGUF VLM 模型（`vlm_mode=llama-cpp` 时使用） |
| `mmproj_name` | COMBO | `None` | 视觉投影器（mmproj）GGUF（多模态模型需要，`None` 为纯文本模式） |
| `api_provider` | COMBO | `GLM` | 云端 API 提供商（`GLM` / `Kimi` / `Qwen` / `Doubao`，`vlm_mode=api` 时使用） |
| `api_key` | STRING | `""` | API Key，留空则读取环境变量 |
| `image` | IMAGE | 可选 | 首帧图片（不连接则为纯文本模式） |
| `last_prompt` | STRING | `""` | 上一段提示词（可选，提供上下文连续性） |
| `prompt` | STRING | `""` | 用户新输入的提示词 |
| `duration` | FLOAT | `5.0` | 视频总时长（秒） |
| `fps` | FLOAT | `24.0` | 帧率 |
| `enhance` | COMBO | `Basic` | 生成模式：`Basic`=标准生成 \| `Enhanced`=润色并补充环境音/运镜/BGM \| `Pre-formatted`=按预格式化 JSON 解析（不调用 VLM） |

**高级参数**（`advanced=True`）：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `max_length` | INT | `512` | 生成最大 token 数（降低可加速） |
| `do_sample` | BOOLEAN | `true` | 随机采样开关 |
| `temperature` | FLOAT | `0.1` | 采样温度 |
| `top_k` | INT | `32` | Top-K 采样 |
| `top_p` | FLOAT | `0.9` | Top-P 采样 |
| `min_p` | FLOAT | `0.0` | Min-P 采样 |
| `repetition_penalty` | FLOAT | `1.0` | 重复惩罚 |
| `seed` | INT | `42` | 随机种子 |
| `presence_penalty` | FLOAT | `0.0` | 存在惩罚 |
| `thinking` | BOOLEAN | `false` | 思考模式（需模型支持） |
| `use_default_template` | BOOLEAN | `true` | 使用模型内置 system prompt |

#### 输出

| 参数 | 类型 | 说明 |
|------|------|------|
| `JSON` | STRING | 完整 JSON（含 detailed_description / overall_soundscape / non_diegetic_music / mapping） |
| `detailed_description` | STRING | 格式化镜头描述（含时间戳和占位符） |
| `mapping` | STRING | 占位符→实际文本映射 JSON |

#### 输出 JSON 结构

```json
{
  "detailed_description": "[Shot 1] 0:00-1.50 镜头从远景缓慢推近...{{ROLE_0}}站在窗前...",
  "overall_soundscape": "城市环境音，远处车辆行驶声，微风",
  "non_diegetic_music": "轻柔的钢琴旋律",
  "mapping": {
    "ROLE_0": "穿着黑色大衣的男人",
    "ROLE_0_DIALOGUE_0": "今天天气真好"
  }
}
```

#### 占位符说明

| 占位符 | 含义 |
|--------|------|
| `{{ROLE_N}}` | 第 N 个角色（N 从 0 开始） |
| `{{ROLE_N_DIALOGUE_M}}` | 第 N 个角色的第 M 句对话（陈述句形式） |

**注意**：`detailed_description` 中的对话必须使用陈述句（如"他说他今天很忙"），禁止放入原始对话文本。实际对话内容通过 `mapping` 中的占位符关联。

---

## 工作流连接

内置示例工作流：`workflow/MiniMax H3 Reference Director 2.1.json`（在 ComfyUI 中通过 Load 导入）。

推荐连接顺序：

```
MiniMax Reference Subject ──→ MiniMax Reference Director ──→ MiniMax Reference Director Guide
                                      │                              │
                                      │                              ├── image0..8 → Video Model
                                      │                              ├── audio0..2 → Video Model
                                      │                              └── prompt     → Video Model
                                      │
                                      └── segment_count（分段数，驱动循环）
```

### 典型用法

1. **定义主体**：在 `MiniMax Reference Subject` 中填好角色名称、描述、参考图
2. **编辑时间线**：在 `MiniMax Reference Director` 的 UI 中拖拽分镜、填写提示词（用 `@` 引用主体），可标记尾帧段（`is_end_frame`）
3. **生成增强提示词**：`MiniMax Reference Director Guide` 设置 `prompt_enhance` 为 `Basic`/`Enhanced`，自动调用 VLM 增强描述并替换占位符；尾帧段会被自动跳过，且自动拼接下一尾帧段的末帧参考
4. **手动使用增强节点**：也可跳过 Director，直接在 `MiniMax Ref Prompt Enhance` 中输入图片和文本进行增强

---

## 依赖

核心依赖（`pyproject.toml`）：

- `ComfyUI` (comfy-api)
- `torch`
- `numpy`
- `Pillow`
- `kornia`

可选依赖：

- `torchaudio` — 音频文件加载

---

## 常见问题

### Q: 提示词生成太慢

- 降低 `max_length` 参数（默认 512 对大多数 JSON 输出足够）
- 关闭 `do_sample`（采样）使用贪心解码
- 使用 FP8 量化模型（如 `qwen3vl_8b_fp8_scaled`）

### Q: config.json 找不到

模型配置文件缺失时会尝试从 HuggingFace Hub 自动下载。确保：

1. 安装了 `huggingface_hub`：`pip install huggingface_hub`
2. 网络可访问 HuggingFace
3. 或手动将 `config.json` / `tokenizer.json` 放在与 `.safetensors` 同目录或同名子目录下

### Q: CUDA out of memory

- 生成完成后会自动清理显存（`torch.cuda.empty_cache()`）
- 尝试更小的模型（如 `google/gemma-3-4b-it`）
- 降低 `max_length`

### Q: JSON 解析失败

VLM 输出格式异常时会自动回退，将原始文本作为 `detailed_description`。检查 `prompt` 输入是否清晰描述了期望的镜头内容。

### Q: Windows 兼容性

- 已排除 vLLM（不支持 Windows），使用 ComfyUI 原生 CLIP 加载
