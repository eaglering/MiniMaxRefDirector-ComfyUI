---
name: spa-director-vue3
overview: 新增 MiniMaxRefDirectorSPA 入口节点 + Vite/Vue3/Element Plus 单文件 SPA 导演台（四个页面：全局参数、主体管理、分镜编辑、生成记录），通过服务端按 node_id 暂存 state 并与 ComfyUI 页面经 WebSocket 回写 timeline_data，附带 MV3 浏览器扩展实现 deepseek-proxy，并新增服务端视频生成记录存储与合并接口对接。
design:
  styleKeywords:
    - Cinematic Dark Studio
    - Layered Cards
    - Neon Accent
    - Micro-animation
    - Professional Timeline
  fontSystem:
    fontFamily: PingFang SC
    heading:
      size: 20px
      weight: 600
    subheading:
      size: 14px
      weight: 600
    body:
      size: 13px
      weight: 400
  colorSystem:
    primary:
      - "#6C5CE7"
      - "#4D6BFE"
      - "#A78BFA"
    background:
      - "#0E1015"
      - "#151821"
      - "#1C202B"
      - "#232837"
    text:
      - "#EDEFF5"
      - "#A9B1C3"
      - "#6B7488"
    functional:
      - "#F5B544"
      - "#22C55E"
      - "#EF4444"
      - "#38BDF8"
todos:
  - id: spa-scaffold
    content: 搭建 spa/ 下 Vite+Vue3+Element Plus 暗色工程与 singlefile 构建配置，产出四菜单骨架页面
    status: completed
  - id: spa-backend-store
    content: 新增 lib/spa_store.py、lib/records.py 与 spa_server.py 的 push/state/save/skills/llm-files/page 路由
    status: completed
  - id: spa-entry-node
    content: 新增 spa_node.py 入口节点与 js/spa-node.js（目标选择、打开页面、send_sync 回写、防回环），并注册到 __init__.py
    status: completed
    dependencies:
      - spa-backend-store
  - id: spa-global-subjects
    content: 用 [subagent:code-explorer] 梳理 subject.js 后实现全局参数页与主体管理页（含四种 LLM 模式与 @ 提及）
    status: completed
    dependencies:
      - spa-scaffold
  - id: spa-storyboard
    content: 实现分镜页三栏：分镜列表右键类型切换、skill 多选、原生/H3 切换与翻译、额外主体、参数与预览 tab
    status: completed
    dependencies:
      - spa-global-subjects
  - id: spa-segment-subjects
    content: 用 [skill:lsp-code-analysis] 分析后为 director.py 增加段级 subjectsOverride 与 lastFrameFile 容错支持
    status: completed
    dependencies:
      - spa-storyboard
  - id: spa-records
    content: 实现生成记录页与多选合并/无损合并，并在 combine.py 与 merge 路由写入记录
    status: completed
    dependencies:
      - spa-backend-store
  - id: spa-deepseek-ext
    content: 新增 extension/ 下 MV3 DeepSeek 桥接扩展与 SPA 端 deepseek-proxy 调用及缺失提示
    status: completed
    dependencies:
      - spa-global-subjects
  - id: spa-build-verify
    content: 构建 js/spa/index.html，端到端验证打开、回写、旧工作流兼容与合并，补充扩展安装说明
    status: completed
    dependencies:
      - spa-entry-node
      - spa-segment-subjects
      - spa-records
      - spa-deepseek-ext
---

## Product Overview
在 ComfyUI 中新增一个「SPA 导演台」入口节点，点击后在新标签页打开独立的导演台页面，用于集中完成全局参数、主体、分镜与成片记录的管理；所有编辑结果最终写回图中已有的 MiniMax 超级导演节点的 timeline_data。

## Core Features
- **新入口节点**：节点内可选择目标「超级导演」节点（图中仅一个时自动选中），提供「打开导演台」按钮与同步状态提示；点击后在新标签页打开导演台页面。
- **顶部四个菜单**：
  1. 全局参数配置：基础设置（输出画幅比例、百万像素、时间显示单位 frames/seconds、帧率）；LLM 设置（llama-cpp、api、ollama、deepseek-proxy 四种方式，含模型/密钥/地址等对应字段）；全局提示词。
  2. 主体管理：与现有主体面板功能一致（新增/删除/排序，Subject / Picture / Video / Audio 四类，关系与保持度，图片/音频/视频上传与预览，描述中 @ 提及主体与对白），但不再包含 LLM 设置与全局提示词。
  3. 导演台分镜：
     - 左侧分镜列表：新增分镜、编辑时长、右键菜单切换文字/图片/视频分镜（含复制、删除）。
     - 中间上部提示词区：左列为运镜、微表情、镜头结构等可自定义勾选的 skill；右列为提示词输入，可切换「原生提示词 / H3 提示词」，原生模式下提供「翻译中/英 → H3 提示词」按钮。
     - 中间下部：额外主体选择（补充未被提示词提及的主体）。
     - 右侧两个 tab：① 分镜参数（自动尾帧、引导强度 0/5/22/39/56/73/90/107、降噪强度、首帧图、尾帧图、视频添加）；② 分镜预览（列出该分镜引用的主体，点击主体弹窗编辑更换图片与描述；支持「自定义主体 / 继承全局 / 向下继承到后续分镜」）。
  4. 视频生成记录：按时间倒序展示生成与合并产物（缩略图、时长、分辨率、时间、路径），支持多选后「合并视频」或「无损合并」。
- **数据一致性**：导演台读写的数据结构与现有 timeline_data 完全一致，旧工作流与现有节点面板不受影响；关闭或刷新标签页不丢编辑内容。
- **视觉**：深色电影工作台风格，顶栏固定四菜单，分镜页三栏布局，选中态与技能标签有明确高亮与过渡动效。


## Tech Stack
- **SPA**：Vue 3 + Vite + Element Plus（暗色主题）+ Vue Router（hash 模式）+ pinch 状态管理（Pinia 或 composable store）
- **单文件构建**：`vite-plugin-singlefile`，产物输出到 `js/spa/index.html`（JS/CSS 全内联），随 ComfyUI `WEB_DIRECTORY = "./js"`（`__init__.py:63`）静态路由提供，URL 形如 `/extensions/MiniMaxRefDirector-ComfyUI/spa/index.html`
- **后端**：沿用 `server.py` 的 `_LazyRoutes` + `API_PREFIX = "/minimax_ref/api"` 路由注册方式（`aiohttp`），新增独立 `spa_server.py` 被 `__init__.py` 导入
- **节点**：沿用 `ext_node.py` 的「纯前端交互节点」写法（`INPUT_TYPES` 空 / `RETURN_TYPES = ()` / `CATEGORY = "MiniMax Ref Director/Utils"`）
- **节点前端**：沿用 `js/ext-manager.js:1006` 的 `addDOMWidget` 挂按钮 + `api.addEventListener` 接收 `send_sync` 事件的既有机制（参考 `js/components/director/transfer.js:1091`）
- **浏览器扩展**：Chrome/Edge MV3（`extension/`），content script 注入 `chat.deepseek.com`，background 中继，SPA 通过 `chrome.runtime.sendMessage` + `externally_connectable` 调用

## Implementation Approach

### 1. 总体策略
新节点只做「入口 + 桥」，不引入第二份数据源。真正的数据仍然只存在 `MiniMaxRefDirector` 节点的 widget 里；SPA 与节点之间用服务端按 `director_node_id` 暂存的状态文件做中转，形成「节点 → 服务端 → SPA → 服务端 → 节点」的单向闭环，避免两套编辑器互相覆盖。

```mermaid
graph LR
A[入口节点 js/spa-node.js] -->|POST /spa/push| B[(spa/state/{node_id}.json)]
B -->|GET /spa/state| C[SPA 导演台]
C -->|POST /spa/save| B
B -->|send_sync minimax_ref_spa_state| A
A -->|回写 widget + properties| D[MiniMaxRefDirector 节点]
D --> E[director.py / guide 链路不变]
```

### 2. 关键决策与取舍
- **为什么用服务端暂存而非 BroadcastChannel**：新标签页与 ComfyUI 页面可能分属不同刷新周期，且用户会关掉再打开；落盘 + 按 node_id 索引可以做到「刷新不丢、可多节点并存」。代价是需要一次文件写，开销可忽略（KB 级 JSON，原子 replace）。
- **为什么不给 Director 节点加 widget**：`js/components/director/register.js:179-247` 用 `widgets_values.length` 选择 5 套 schema 表，新增 widget 会破坏旧工作流反序列化。入口节点使用独立 `node_id`，零兼容风险。
- **为什么段级主体用 `subjectsOverride`**：`director.py:167` 只从 `config` 取全局 `subject_data` 传给 `build_h3_prompt`。新增可选字段 `seg.subjectsOverride`（主体对象数组），存在时以 `{"subjects": seg.subjectsOverride}` 替换全局；缺失时回退全局，完全向后兼容。这样「每分镜独立主体 + 默认继承全局 + 向下继承」都在 timeline_data 内表达，不新增存储。
- **为什么不新建 LLM 后端**：`/llm/generate_prompt_json` 与 `/llm/generate_image_analysis` 已接受完整 opts（`vlm_mode/gguf_path/mmproj_path/provider/api_key/ollama_model/ollama_base_url`），SPA 直接复用，只需新增 gguf 文件列表端点。
- **deepseek-proxy 隔离**：作为 `vlm_mode` 的第四种取值，仅在浏览器扩展可用时启用；扩展缺失时前端明确提示并允许回退 ollama/api，不影响后端原有三条路径。

### 3. 性能与可靠性
- 状态文件按 node_id 分文件（`user/default/MiniMaxRefDirector/spa/state/{node_id}.json`），避免单文件热点；写入用 `tmp + os.replace` 原子替换。
- 生成记录写入 `video_records.json`，加 `threading.Lock` 串行化 + 上限 2000 条裁剪，防止长时间训练式运行膨胀；缩略图直接复用 `/view?` 与 `/minimax_ref/api/view_image`（`server.py:116`），不新产生副本。
- SPA 保存做 400~600ms 防抖，只提交变更后的完整 state（KB~百 KB 级）。合并/无损合并复用既有 `asyncio.to_thread` 封装（`server.py:881`），不阻塞事件循环。
- 防回环：节点回写时置 `node.__spaExternalUpdate = true`，在 `setTimeout(0)` 后清除；期间跳过自身 `commitChanges` 触发的反向保存。

## Implementation Notes
- 图片/音频/视频上传统一走 `/upload/image`（ComfyUI 原生，`subfolder="minimaxrefdirector"`，对齐 `js/subject.js:1349`）与现有 `/h3/upload_audio`（`server.py:788`）；预览 URL 用 `js/components/director/shared.js:76` 同款拼接规则（`/view?filename=..&type=..&subfolder=..`），SPA 内不能用 `api.apiURL`，改为由节点传入 `api_base`。
- `api_base` 通过打开 URL 的 query 传入（节点侧用 `api.apiURL("")` 计算，兼容 ComfyUI 子路径部署）；SPA 兜底 `new URL("../..", location.href)`。
- 不修改 `timeline_data` 既有字段语义；保存时保留未知字段（`...rest`），对齐 `js/components/director/editing.js:483`。
- skill 词库 key 必须与后端 `lib/prompt.py` 的 `_CAMERA_MOTION_PRESETS / _SHOT_SIZE_PRESETS / _FRAMING_PRESETS / _MICRO_EXPRESSION_PRESETS` 保持一致，直接取自 `js/components/director/shared.js:372-447`。
- 节点回写若存在 `node._timelineEditor`，调用其刷新方法（guarded）让旧面板同步；不存在则 `setDirtyCanvas(true, true)`。
- 构建产物 `js/spa/index.html` 必须入仓；`.gitignore` 仅忽略 `spa/node_modules`、`spa/dist`。
- 静态路由若被某些 ComfyUI 版本限制，回退方案：新增 `GET /minimax_ref/api/spa/page` 读文件返回 `text/html`，打开 URL 指向该路由（同一套前端代码无需改动）。

## Architecture Design

### 目录结构（新增/修改）
```
MiniMaxRefDirector-ComfyUI/
├── __init__.py                     # [MODIFY] 导入 spa_server；注册 MiniMaxRefDirectorSPA（含 PromptRelay.get_node_list）
├── spa_node.py                     # [NEW] 入口节点：无计算，仅占位供前端挂 UI
├── spa_server.py                   # [NEW] /spa/* 路由：push / state / save / skills / llm_files / page
├── server.py                       # [MODIFY] merge_videos、merge_latents 成功后写生成记录
├── combine.py                      # [MODIFY] 执行成功后调用 records.append_record(...)
├── director.py                     # [MODIFY] 段级 subjectsOverride 支持（缺失回退全局）
├── lib/spa_store.py                # [NEW] 状态/技能词库落盘与原子读写
├── lib/records.py                  # [NEW] 视频生成记录追加/读取/删除（锁 + 上限）
├── js/spa-node.js                  # [NEW] 入口节点 UI + 服务端推拉 + send_sync 回写 + 防回环
├── js/spa/index.html               # [NEW] 构建产物（单文件，入仓）
├── spa/                            # [NEW] Vue3 源码工程
│   ├── package.json                # 依赖：vue、element-plus、vue-router、pinia、vite、@vitejs/plugin-vue、vite-plugin-singlefile
│   ├── vite.config.js              # base "./"，outDir "../js/spa"，cssCodeSplit false，inlineDynamicImports，singlefile
│   ├── index.html                  # 挂载点 + 内联基础样式
│   └── src/
│       ├── main.js                 # createApp + ElementPlus(zhCn) + 暗色主题 + router
│       ├── App.vue                 # 顶栏四菜单 + <router-view> + 全局保存状态指示
│       ├── router/index.js         # hash 路由：/global、/subjects、/storyboard、/records
│       ├── api/client.js           # apiBase 解析 + state/save/upload/llm/records/merge 封装
│       ├── stores/timeline.js      # timeline_data 读写（对齐 parseInitial / commitChanges）
│       ├── stores/settings.js      # 全局参数、LLM 配置、自定义 skill 词库
│       ├── data/skills.js          # 运镜/景别/构图/微表情词条（与 shared.js 一致）
│       ├── utils/media.js          # viewUrl、上传、时长/帧换算
│       ├── views/GlobalParams.vue  # 页面 1
│       ├── views/Subjects.vue      # 页面 2
│       ├── views/Storyboard.vue    # 页面 3（三栏容器）
│       ├── views/Records.vue       # 页面 4
│       └── components/
│           ├── storyboard/ShotList.vue      # 左侧：新增/时长/右键类型菜单/删除/复制
│           ├── storyboard/PromptPanel.vue   # 中间上：skill 勾选 + 原生/H3 切换 + 翻译按钮
│           ├── storyboard/ExtraSubjects.vue # 中间下：额外主体选择（写 additionSubject）
│           ├── storyboard/ShotParams.vue    # 右侧 tab1：尾帧/引导强度/降噪/首尾帧/视频
│           ├── storyboard/ShotPreview.vue   # 右侧 tab2：主体卡片 + 弹窗编辑 + 继承勾选
│           └── subjects/SubjectEditor.vue   # 主体卡编辑（与主体管理页复用）
└── extension/                      # [NEW] MV3 DeepSeek 桥接扩展
    ├── manifest.json               # content_scripts 匹配 chat.deepseek.com；externally_connectable 放开本地端口
    ├── background.js               # 请求路由、tab 管理、超时与错误归一
    ├── content.js                  # 注入页面，填充输入框/触发发送/抓取回复
    └── README.md                   # 安装与扩展 ID 配置说明
```

### 数据契约（关键结构）
```js
// spa state（服务端暂存，一节点一文件）
{
  node_id: "12",
  timeline_data: "<timeline_data 原始 JSON 字符串>",
  widgets: { outpu_resolution, million_pixels, display_mode, frame_rate, start_second, end_second, guide_strength, inpaint_audio, override_audio },
  global_prompt: "",
  subjects: { subjects: [ /* 与 subject.js saveState 同构 */ ] },
  subject_node_id: "11",
  llm: { mode: "llama-cpp|api|ollama|deepseek-proxy", gguf_path, mmproj_path, provider, api_key, ollama_model, ollama_base_url, extension_id },
  updated_at: 1762...
}
```

```js
// 分镜段新增/使用的字段（均为可选，向后兼容）
{
  subjectsOverride: [ /* 主体对象数组；缺失=继承全局 */ ],
  guideStrength: 22,        // 0/5/22/39/56/73/90/107
  denoise: { enabled, alpha, alpha_end, ramp, seed },
  autoEndFrame: true,
  imageFile, videoFile,     // 首帧 / 视频
  lastFrameFile,            // 尾帧图（新增可选字段，director.py 映射为结束锚点图片）
  cameraMotions, expressions, shotSizes, framings,
  additionSubject: [name]
}
```

## Implementation Notes（执行约束）
1. `director.py` 改动只在 `build_h3_prompt` 调用处：`seg_subject = {"subjects": seg["subjectsOverride"]} if seg.get("subjectsOverride") else subject_data`，并对 `lastFrameFile` 做容错读取；其余逻辑零改动。
2. `js/spa-node.js` 必须处理「目标节点被删除/改名」：每次打开前重新扫描图中节点，找不到时提示并禁用按钮。
3. 回写 widget 复用 `js/components/director/editing.js:506` 的 `updateWidgetValue` 语义（同时写 `value`、`node.properties`、`onWidgetChanged`、`callback`），避免只改一处导致保存丢失。
4. 生成记录写入必须 `try/except` 包裹，任何异常只 `log.warning`，绝不阻断视频编码与合并主流程。
5. 扩展缺失时不抛异常阻塞界面，仅在 LLM 设置处展示可点击的「安装说明」链接（指向 `extension/README.md`）。



## Design Style
深色电影工作台（Cinematic Studio Dark）：以炭黑分层背景 + 冷调紫蓝主色 + 暖琥珀强调色，呈现专业剪辑/导演软件质感。顶部为固定 52px 菜单栏（四个一级菜单 + 右侧保存状态与节点信息），主区域卡片化分层，边界用 1px 低对比描边与柔和内阴影，避免大面积纯黑。

## Layout
- **顶栏**：左侧品牌标识「MiniMax 导演台」+ 目标节点编号徽标；中间四个菜单项（全局参数 / 主体管理 / 分镜 / 生成记录）横向平铺，选中项有下沿发光指示条；右侧实时保存状态（已保存/保存中/未连接）与「重新拉取」按钮。
- **全局参数页**：单列居中 960px，两张 `el-card` 分区（基础设置 2×2 栅格表单、LLM 设置 4 个 `el-radio-button` 切换后动态表单），底部通栏全局提示词 `el-input`（带字数统计）。
- **主体管理页**：左侧 320px 主体列表（`el-scrollbar` + 可拖拽卡片，缩略图 + 名称 + 类型标签），右侧详情表单（类型/关系/保持度/媒体上传拖拽区/描述 textarea 带 @ 提及下拉）。
- **分镜页**：三栏 `flex`，左 220px 竖向分镜条（编号、缩略图、时长 `el-input-number`、类型角标，右键 `el-dropdown` 弹出类型切换），中 `flex:1` 上提示词区（左 200px skill 多选胶囊，右 `el-segmented` 切换原生/H3 + 文本框 + 翻译按钮），中下额外主体选择器，右 360px `el-tabs`（参数 / 预览）。
- **记录页**：`el-table` 带缩略图列与多选，选中后底部悬浮操作栏出现「合并视频」「无损合并」按钮，合并中显示进度条。

## Interaction
- 所有编辑 500ms 防抖自动保存，顶栏状态点由灰转绿；失败转红并提供重试。
- 分镜切换有 160ms 淡入位移；skill 胶囊选中态填充主色并轻微上浮；主体卡片 hover 抬升并显示编辑角标。
- 弹窗统一 `el-dialog`，宽 720px，头部含主体名与类型标签，底部右对齐主次按钮。

## Responsiveness
- ≥1440px 三栏常驻；1100–1440px 右栏收窄至 320px；<1100px 左右栏折叠为 `el-drawer`，中间单栏优先。


## Agent Extensions
### SubAgent
- **code-explorer**
  - Purpose: 在实现主体管理页与分镜页前，逐项梳理 `js/subject.js` 的交互细节（类型-媒体联动表、@ 提及协议、子主体隐藏规则、去重与校验）与 `js/components/director/transfer.js` 中分镜参数的取值语义，形成 Vue 组件的行为对照清单。
  - Expected outcome: 输出一份可逐条核对的「subject.js 功能 → SPA 组件」映射表，确保主体管理页功能对等、不遗漏边界逻辑。

### Skill
- **lsp-code-analysis**
  - Purpose: 修改 `director.py`、`combine.py`、`server.py` 前做符号级影响分析（`build_h3_prompt` 的全部调用点、`_send_progress` 的消费方、`guide_data` 字段读取处），确认段级 `subjectsOverride` / `lastFrameFile` 与生成记录写入不会波及其他链路。
  - Expected outcome: 得到精确的调用点与影响范围清单，使后端改动仅落在必要位置并通过引用检查验证。
