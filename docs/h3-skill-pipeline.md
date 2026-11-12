# H3 技能注入与英文保真链路

> 数据模型、render_mode 语义与新增类别步骤见 `docs/skill-notes-design.md`。

```
① 分镜选择（seg.skills = {类别名: [key]}）
        ▼
② 后端渲染 skill_notes（/spa/skill_notes，唯一实现）
        ▼
③ H3 中文四字段（summary / detailed_description / overall_soundscape / non_diegetic_music）
        ▼
④ H3 英文提示词（翻译阶段掩码 <!技术词> → 译后还原）
```

- **① → ②**：分镜上只存「类别名 + 技能 key」。后端 `lib/skill_notes.py` 按类别
  `render_mode` 渲染注入块；服务端模式（api / ollama / llama-cpp）与网页桥接
  （deepseek / doubao / qianwen）共用这份文本，前端不再自己拼。
  - `camera` 运镜：风格 + 描述 + 写法指南 + 英文触发短语；
  - `term` 景别/镜头结构：中文名直接写入 + `name_en` 对照；
  - `example` 微表情：每镜挑一句示例自然融入，不写技能名；
  - `descriptive` 人物/打斗/特效：描述 + 参考短语自然融入；
  - `block` 风格/效果：整段内容近似原样附加。
  - 已删除的技能：渲染跳过并返回 warnings，界面提示，不中断生成。
- **② → ③**：通用模板 `resources/skills/h3-prompt-builder/prompt.md` 统一组装
  （`{{skills_guide}} / {{skill_notes}} / {{user_input}} / {{lang_note}} …`）。
  模板**不申明触发词写法**：`camera motion` 是否置首由用户写在全局提示词里。
- **③ → ④**：`protect_keywords=1` 的类别（内置为运镜）其技术词在 skill_notes 中
  写成 `<!slow push-in>`；翻译前掩码为占位符，译后只保留内文，因此英文阶段
  不会被翻译/改写。术语型（景别/镜头结构）走 `glossary`（中文名 → name_en）。
  纯英文提示词不翻译时也会剥离 `<!…>` 标记。

## 一、推荐格式（保证英文转化正确）

| 阶段 | 运镜（camera） | 景别（term） | 微表情（example） |
|---|---|---|---|
| ① 分镜选择 | `seg.skills["运镜"] = ["push_in"]` | `seg.skills["景别"] = ["wide"]` | `seg.skills["微表情"] = ["sigh"]` |
| ② skill_notes | `英文触发短语：<!slow push-in> / <!dolly in>` | `大远景（英文对照：extreme wide shot）` | `示例：长长地呼出一口气 / 垂首` |
| ③ H3 中文 | 中文运镜描写 + `<!slow push-in>` | 直接写「大远景」 | 中文示例句自然织入 |
| ④ H3 英文 | `slow push-in`（内文原样，标记剥除） | `extreme wide shot`（glossary） | 自然意译 |

关键原则：**技术词在 ② 阶段就以 `<!…>` 标记保护**，④ 阶段只做掩码与还原，
不做任何二次改写；触发词规则（例如 `camera motion` 放在开头）由全局提示词控制。

## 二、网页桥接分镜导入（DeepSeek / 豆包 / 千问）的封号风险分析

三种桥接站点共用同一导入流程与扩展链路（`payload.site` 路由）；豆包/千问暂不支持
扩展侧会话列表/删除，导入第一步手动粘贴会话链接或留空自动新建。
一键全自动导入已被移除，每个步骤由用户手动「执行 / 同步」。风险变化：

**显著降低的部分**
- 消息频率由人控制：不再连续发送 6+N 条消息，单步发送、间隔由用户决定。
- 不再批量新建会话：故事大纲复用用户选定的会话，分镜设计只新建 1 个会话，
  且跨步骤复用；「清理会话」改为用户手动触发的独立操作（删除会话是最可疑的
  行为之一，现在完全由用户决定是否执行）。
- 发送节奏不再机械：每步之间天然存在用户阅读、确认的时间差。

**仍然存在的部分（无法归零）**
- 自动化本质未变：扩展仍会在页面注入脚本（page-hook 拦截 fetch / SSE）、
  模拟输入与回车、读取回复 DOM。平台侧若检测注入脚本或非常规输入事件，
  手动模式同样可被识别。
- 请求特征：单条消息仍是「大段指令 + 要求 JSON 输出」的模式，与正常聊天
  分布不同。

**使用建议**
- 单次导入控制在 10 镜以内；两次「执行」之间留出数十秒以上的阅读间隔。
- 避免短时间内多轮「重跑某一步」；失败时先看日志与页面自检，不要连续重试。
- 不强制清理会话：让新会话自然留在账户里，反而更像正常使用。
- 需要大批量生成时优先考虑 LLM 设置里的 API / Ollama 等本地或服务端模式。

## 三、技能词典字段（SQLite skills / skill_categories）

- `skill_categories`：`name / description / sort / render_mode / protect_keywords`。
  新增类别只需选注入方式，无需改代码。
- `skills`：`name`（中文名）、`name_en`（英文对照）、`desc`（描述/片段内容）、
  `guide`（写法指南）、`examples`（分号分隔数组）、`group_name`（旧导演台分组）。
- 旧字段 `prompt / example / keyword / meta` 已在 v0→v1 移除；
  `render_mode / protect_keywords` 由 v1→v2 迁移补齐。
