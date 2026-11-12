# 分镜技能库与 skill_notes 设计

本文说明「分镜技能 → skill_notes → H3 提示词 → 英文」的完整链路，以及新增技能类别时的接入步骤。
目标是**新增类别不改代码**：人物主体、打斗、特效、风格等只需在界面里选一种「注入方式」并填词条。

## 1. 数据模型

`install/skills.db`（SQLite，`install/skill_seed.py` 首次建库种子）：

```sql
skill_categories(id, name UNIQUE, description, sort, render_mode, protect_keywords)
skills(id, category_id, key, name, name_en, desc, guide, examples, group_name, builtin, created_at)
```

- `name`：中文名。分镜选择以**类别名**为键存储（`seg.skills = { 类别名: [key] }`），重命名类别会影响已有选择。
- `examples`：分号分隔的 JSON 数组（英文触发短语 / 中文示例 / 参考短语，随注入方式而定）。
- `protect_keywords`：关键词保护开关，1 = 该类别技术词在 skill_notes 中用 `<!技术词>` 包裹（内置「运镜」=1）。
- `PRAGMA user_version`：v2（v1→v2 只为类别表补 `render_mode / protect_keywords` 并映射内置四类）。

## 2. 注入方式（render_mode）

| render_mode | 适用 | skill_notes 输出 | 翻译阶段 |
| --- | --- | --- | --- |
| `camera` | 运镜（LoRA 触发短语） | 风格名 + 描述 + 写法指南 + 英文触发短语 | 短语被 `<!…>` 保护，原样保留；**不做触发词申明** |
| `term` | 景别 / 镜头结构 | 中文名直接写入镜头描述 + 英文对照 | 由 glossary 映射到 `name_en` |
| `example` | 微表情 | 每镜挑一句示例自然融入，不写技能名 | 正常意译 |
| `descriptive` | 人物主体 / 打斗 / 特效 | 描述 + 参考短语自然融入画面或动作 | 正常意译 |
| `block` | 风格 / 效果预置 | 整段内容近似原样附加 | 受保护时原样保留 |

必填字段（前后端一致，`lib/skill_db.py::_RENDER_MODE_RULES`）：

- `camera`：`name` + `examples`（英文触发短语）
- `term`：`name` + `nameEn`
- `example`：`name` + `examples`
- `descriptive`：仅 `name`（`desc/guide/examples` 可选）
- `block`：`name` + `desc` 或 `examples`（整段内容）

## 3. skill_notes 生成（唯一实现）

`lib/skill_notes.py::render_skill_notes(selections, lang) -> {notes, protected, glossary, warnings}`

- 输入 `selections = {类别名: [key]}`；类别按 `sort` 输出分节，节内条目按选择顺序。
- 未找到的类别 / 已删除的技能：写入 `warnings` 并跳过，**不中断生成**。
- `glossary`：所有 `term` 类别词条（中文名 → `name_en`），含未被勾选但可能出现在用户输入里的词。
- `protected`：本次注入的 `<!…>` 技术词列表（供调试与前端提示）。

对外接口：`POST /minimax_ref/api/spa/skill_notes`，body `{selections, lang}`，返回同上。
服务端三种模式（api / ollama / llama-cpp）与三种网页桥接（deepseek / doubao / qianwen）共用这一份文本：

- 服务端路径：前端发 `selections`，`server.py` 透传，`generate_h3_prompt` 现渲染（或直接用前端传来的 `skill_notes`）。
- 桥接路径：前端先取 `/spa/skill_notes`，再把 `skill_notes` 放进桥接 payload。

## 4. H3 提示词模板

`resources/skills/h3-prompt-builder/prompt.md`（`lib/prompt.py::_load_h3_builder_template` 读取并缓存）：

占位符 `{{skills_guide}} {{skill_notes}} {{image_note}} {{lang_note}} {{duration_note}} {{user_input}}`。
模板只描述「如何把技能条目融入四字段 JSON」，**不写任何触发词规则**——`camera motion` 等触发词怎么写由用户写在全局提示词里。

桥接侧系统提示（`spa/src/utils/llm.js::WEB_CHAT_H3_SYSTEM`）与模板保持同一语义：`<!…>` 片段原样保留、不输出技能名标签、不编造内容。

## 5. 技术词保真（中文 → 英文）

1. H3 中文阶段：`<!slow push-in>` 原样写入 `detailed_description`。
2. 翻译前：`lib/prompt.py::_mask_protected` / `director.py::_PROTECTED_FRAGMENT_RE` 把 `<!…>`、`<@…>`、`<#…>`、`<d>…</d>`、引号内容替换为 PUA 占位符。
3. 翻译指令：注入 `glossary`（术语型中英对照）；声明 `<!…>` 内文不得改写。
4. 翻译后：`unmask_protected_text` 还原，`<!…>` 只保留内文（标记不进最终提示词）。占位符丢失则整段回退原文，避免污染。
5. 旧 payload 字段（`camera_motion / expression / shot_size / framing`）已废弃：仅在 `skill_notes`、`selections` 都为空时由 `resolve_legacy_selections` 反查类别名转换一次。

## 6. 前端与旧导演台

- SPA：`seg.skills` 通用 map；`workspace.skillGroups` 输出 `categoryName / renderMode / protectKeywords`；技能胶囊与「新增技能」表单按 renderMode 动态渲染；`SkillDictPanel` 支持新建/编辑类别（注入方式、关键词保护）。
- 旧导演台：`shared.js::loadSkillDict` 同时填充 `SKILL_GROUPS`（动态类别）与四个旧数组；`parseInitial` 把旧四字段迁移进 `seg.skills`；`transfer.js` 读写 `seg.skills`，内置四段胶囊保留，其余类别动态追加；H3 请求改发 `selections`。
- DeepSeek 分镜导入仍可能返回旧字段（`camera_motions` 等），`Storyboard.applyShotToSegment` 会映射为内置类别名后写入 `seg.skills`。
- 旧导演台「导入微表情词库」仍只写 localStorage：这类词条不在数据库中，生成时会被当作已删除技能跳过（有 warning）。需要长期使用时请改用分镜技能面板的「添加技能 / 批量导入」入库。

## 7. 新增一个类别的步骤（无需改代码）

1. 全局参数 → 分镜技能 → 新建类别，填名称，选择注入方式，按需开启关键词保护。
2. 在类别内添加/批量导入词条（按注入方式的必填字段填写）。
3. 分镜页技能区会自动出现该类别，选中后即写入 `seg.skills[类别名]`。
4. 转 H3 时后端渲染出对应分节；翻译阶段按 `term` glossary 或 `<!…>` 保护保持关键词。

## 8. 排查

| 现象 | 检查 |
| --- | --- |
| 技能没有出现在分镜区 | `/spa/skill_dict` 是否返回该类别；`render_mode` 是否合法（五种之一） |
| 生成时提示「已删除技能」 | 该 key 已从词典删除：重新勾选或清理 `seg.skills` |
| 英文里技术词被改写 | 类别是否开启关键词保护；skill_notes 是否被手工覆盖 |
| 中文名没译成标准英文 | `term` 类别词条是否填了 `nameEn` |
