"""分镜技能 → skill_notes 渲染（唯一实现）。

服务端生成的三种模式（api / ollama / llama-server，内部值 llama-cpp 兼容旧存档）
与三种浏览器桥接模式
（deepseek / doubao / qwen）共用本模块输出，前端不再拼装技能说明。

输入 selections 为分镜上保存的通用选择：``{类别名: [技能 key, ...]}``
（类别名 = skill_categories.name；技能 key = skills.key）。

输出：``{notes, protected, glossary, warnings}``
- notes:       注入 H3 生成提示词的结构化技能说明（按 render_mode 分节）
- protected:   被 ``<!...>`` 包裹的技术词原文（调试 / 前端提示用）
- glossary:    术语型（term）类别的 中文名 → name_en，供中文→英文翻译阶段对照
- warnings:    已删除 / 未知技能（跳过，不阻断生成）

技术词保护规则（用户确认）：
- 只有类别表里 ``protect_keywords=1`` 的类别（内置为「运镜」）才用
  ``<!技术词>`` 包裹；翻译阶段掩码、译后原样还原。
- **不做触发词申明**：``camera motion`` 等触发词写法由用户写在全局提示词里，
  本模块只输出技能条目本身（风格 / 指南 / 英文触发短语）。
"""

from __future__ import annotations

import logging
import re

from . import skill_db

log = logging.getLogger(__name__)

# 类别名 → 分节引导语（zh / en）
_SECTION_HEAD = {
    "camera": ("运镜方向", "Camera Motion"),
    "term": ("镜头语汇", "Shot Vocabulary"),
    "example": ("表演细节", "Performance Detail"),
    "descriptive": ("描述型技能", "Descriptive Skill"),
    "block": ("片段型技能", "Block Skill"),
}

# 技术词包裹标记：<!slow push-in>
_PROTECT_RE = re.compile(r"<!([^>]*)>")

# notes 内可读性上限：技能条目过多时提示（不截断，保证用户选择完整生效）
_MAX_ITEMS_WARN = 40


def _wrap_protected(text: str) -> str:
    """按需把技术词包成 <!...>；已包裹/空串原样返回。"""
    value = str(text or "").strip()
    if not value:
        return ""
    if _PROTECT_RE.fullmatch(value):
        return value
    return f"<!{value}>"


def _cat_mode(cat: dict) -> str:
    return str(cat.get("renderMode") or cat.get("render_mode") or "descriptive").lower()


def _cat_protect(cat: dict) -> bool:
    """关键词保护开关（list_all 输出 camelCase，DB 行可能是 snake_case）。"""
    return bool(cat.get("protectKeywords") if cat.get("protectKeywords") is not None
                else cat.get("protect_keywords"))


def _head(mode: str, category: str, lang: str) -> str:
    zh, en = _SECTION_HEAD.get(mode) or _SECTION_HEAD["descriptive"]
    if lang == "en":
        return f"## {en} · {category}"
    return f"## {zh} · {category}"


def _render_camera(cat: dict, skills: list[dict], lang: str) -> str:
    """运镜：风格 + 描述 + 写法指南 + 英文触发短语（受保护，不做触发词申明）。

    用户要求：所选技能**必须出现**（不允许选择性遗漏），因此这里明确要求
    每个所选风格的英文触发短语至少出现一次，可分配到不同 [Shot N]。
    """
    protected = _cat_protect(cat)
    lines = [_head("camera", cat["name"], lang)]
    if lang == "en":
        lines.append(
            "Every style listed below MUST appear (each English trigger phrase at least once) — "
            "never drop a selected style. Assign styles to [Shot N] beats by framing/action/mood; "
            "a shot may chain two styles when the movement calls for it, but avoid stacking "
            "near-duplicates. Weave each English trigger phrase into that shot's camera movement "
            "naturally; never translate or paraphrase it."
        )
    else:
        lines.append(
            "下列每一个风格都**必须出现**（每条英文触发短语至少用一次），不得遗漏或跳过；"
            "按景别/动作/情绪把风格分配到各 [Shot N]，一个镜头需要时可衔接两种风格，"
            "但不要堆叠近义重复。把英文触发短语自然写进对应镜头的运镜描写，不得翻译或改写。"
        )
    for s in skills:
        name = s.get("name") or s.get("key") or ""
        name_en = s.get("nameEn") or ""
        if lang == "en":
            lines.append(f"- {name}" + (f" ({name_en})" if name_en else ""))
        else:
            lines.append(f"- 风格：{name}" + (f"（{name_en}）" if name_en else ""))
        if s.get("desc"):
            lines.append(f"  - {s['desc']}")
        if s.get("guide"):
            lines.append(f"  - 写法指南：{s['guide']}")
        phrases = list(s.get("examples") or [])
        if phrases:
            rendered = [(_wrap_protected(p) if protected else str(p)) for p in phrases]
            label = "Trigger phrases" if lang == "en" else "英文触发短语"
            lines.append(f"  - {label}：{' / '.join(rendered)}")
    return "\n".join(lines)


def _render_term(cat: dict, skills: list[dict], lang: str) -> str:
    """术语：中文名直接写入镜头描述，英文阶段按 name_en 对照。"""
    lines = [_head("term", cat["name"], lang)]
    if lang == "en":
        lines.append(
            "Every term listed below MUST appear at least once (spread them across [Shot N] "
            "beats when several are selected); write it with its English term from the mapping. "
            "Rewrite any other wording from the user input to one of these terms."
        )
        for s in skills:
            lines.append(f"- {s.get('name') or s.get('key')} → {s.get('nameEn') or s.get('name')}")
        return "\n".join(lines)
    lines.append(
        "下列**每一个**中文名称都必须出现（选中多个时分配到不同 [Shot N]，不得遗漏），"
        "把中文名称**直接写入**镜头描述；用户输入中的其他说法一律改写为下列名称。"
        "英文翻译阶段按括号内的英文对照还原。"
    )
    for s in skills:
        name = s.get("name") or s.get("key") or ""
        name_en = s.get("nameEn") or ""
        lines.append(f"- {name}（英文对照：{name_en}）" if name_en else f"- {name}")
    return "\n".join(lines)


def _render_example(cat: dict, skills: list[dict], lang: str) -> str:
    """示例：每条 Cue 至少融入一句，不写技能名。"""
    lines = [_head("example", cat["name"], lang)]
    if lang == "en":
        lines.append(
            "EVERY cue listed below MUST contribute at least one example line, woven into the "
            "acting naturally (spread cues across [Shot N] beats); do not write the skill name "
            "as a tag and do not stack near-duplicates."
        )
        for s in skills:
            name = s.get("name") or s.get("key") or ""
            lines.append(f"- {name}: {' / '.join(str(x) for x in (s.get('examples') or []))}")
        return "\n".join(lines)
    lines.append(
        "下列**每一个** Cue 都至少融入一句示例，自然写进表演描写（多选时分配到不同 [Shot N]）；"
        "不写技能名，不要堆叠近义重复。"
    )
    for s in skills:
        name = s.get("name") or s.get("key") or ""
        desc = s.get("desc") or ""
        examples = [str(x) for x in (s.get("examples") or []) if str(x).strip()]
        lines.append(f"- Cue：{name}" + (f"（{desc}）" if desc and lang != "en" else ""))
        if examples:
            lines.append(f"  - 示例：{' / '.join(examples)}")
    return "\n".join(lines)


def _render_descriptive(cat: dict, skills: list[dict], lang: str) -> str:
    """描述型：desc + 参考短语自然融入（人物主体 / 打斗 / 特效等扩展类别）。"""
    protected = _cat_protect(cat)
    lines = [_head("descriptive", cat["name"], lang)]
    if lang == "en":
        lines.append(
            "EVERY selected entry below MUST be reflected in the shot description — none may be "
            "skipped. Merge them into the beats naturally; do not dump them as a list or invent "
            "content beyond the user's input."
        )
    else:
        lines.append(
            "下列**每一条**都必须体现在镜头描述里（人物外观 / 动作 / 特效等），不得遗漏；"
            "按镜头节拍自然融入，不要罗列成清单，也不要在用户输入之外编造设定。"
        )
    for s in skills:
        name = s.get("name") or s.get("key") or ""
        lines.append(f"- {name}" + (f"（{s['nameEn']}）" if s.get("nameEn") else ""))
        if s.get("desc"):
            lines.append(f"  - {s['desc']}")
        if s.get("guide"):
            lines.append(f"  - 写法指南：{s['guide']}")
        examples = [str(x) for x in (s.get("examples") or []) if str(x).strip()]
        if examples:
            rendered = [(_wrap_protected(p) if protected else p) for p in examples]
            lines.append(f"  - 参考短语：{' / '.join(rendered)}")
    return "\n".join(lines)


def _render_block(cat: dict, skills: list[dict], lang: str) -> str:
    """片段型：整段内容近似原样进入提示词（风格 / 特殊效果预置）。"""
    protected = _cat_protect(cat)
    lines = [_head("block", cat["name"], lang)]
    lines.append(
        "Append EVERY selected fragment below to the shot description, keeping their wording "
        "essentially unchanged; none may be skipped and none rewritten."
        if lang == "en" else
        "把下列**每一个**所选片段都按原意附加到镜头描述里，措辞基本保持原样，"
        "不得遗漏、不得改写。"
    )
    for s in skills:
        name = s.get("name") or s.get("key") or ""
        content = str(s.get("desc") or "").strip()
        if not content:
            content = "；".join(str(x) for x in (s.get("examples") or []) if str(x).strip())
        if not content:
            continue
        if protected:
            content = _wrap_protected(content)
        lines.append(f"- {name}：{content}")
    return "\n".join(lines)


_RENDERERS = {
    "camera": _render_camera,
    "term": _render_term,
    "example": _render_example,
    "descriptive": _render_descriptive,
    "block": _render_block,
}


def _normalize_selections(selections) -> dict[str, list[str]]:
    """入参容错：{类别名: [key]} / {类别名: "key"} / None → 去空去重的规范结构。"""
    out: dict[str, list[str]] = {}
    if not isinstance(selections, dict):
        return out
    for cat, keys in selections.items():
        cat_name = str(cat or "").strip()
        if not cat_name:
            continue
        if isinstance(keys, str):
            raw = [keys]
        elif isinstance(keys, (list, tuple, set)):
            raw = list(keys)
        else:
            continue
        seen, items = set(), []
        for k in raw:
            key = str(k or "").strip()
            if key and key not in seen:
                seen.add(key)
                items.append(key)
        if items:
            out[cat_name] = items
    return out


def render_skill_notes(selections, lang: str = "zh") -> dict:
    """把分镜上选择的技能渲染成注入块（服务端与桥接共用）。

    参数
        selections: {类别名: [技能 key, ...]}
        lang:       "zh"（默认，H3 中文阶段）/ "en"
    返回
        {notes, protected, glossary, warnings, required}
        required: 生成结果里必须原样出现的技能关键词（受保护技术词 + 术语名），
                  供前端做"所选技能必须出现"的校验与纠正追问。
    """
    sel = _normalize_selections(selections)
    result = {"notes": "", "protected": [], "glossary": {}, "warnings": [], "required": []}
    if not sel:
        return result

    try:
        data = skill_db.list_all()
    except Exception as exc:  # 数据库不可用时不阻断生成，但明确告知
        log.warning("[SPA] skill_dict unavailable while rendering notes: %s", exc)
        result["warnings"].append(f"技能词典不可用，已跳过技能注入：{exc}")
        return result

    cats = {c["name"]: c for c in data.get("categories") or []}
    cat_name_by_id = {c["id"]: c["name"] for c in cats.values()}
    by_cat: dict[str, dict[str, dict]] = {}
    for s in data.get("skills") or []:
        cat_name = cat_name_by_id.get(s.get("categoryId")) or ""
        if cat_name:
            by_cat.setdefault(cat_name, {})[s["key"]] = s

    sections: list[str] = []
    for cat_name, keys in sel.items():
        cat = cats.get(cat_name)
        if not cat:
            result["warnings"].append(f"类别已删除：{cat_name}")
            continue
        pool = by_cat.get(cat_name) or {}
        picked, missing = [], []
        for key in keys:
            skill = pool.get(key)
            if skill is None:
                missing.append(key)
            else:
                picked.append(skill)
        if missing:
            result["warnings"].append(
                f"类别「{cat_name}」中已删除的技能已跳过：{'、'.join(missing)}")
        if not picked:
            continue
        mode = _cat_mode(cat)
        renderer = _RENDERERS.get(mode) or _render_descriptive
        sections.append(renderer(cat, picked, lang))
        if mode == "term":
            # 术语对照表覆盖该类别全部词条（含用户输入里可能出现但未勾选的词）
            for s in pool.values():
                if s.get("name") and s.get("nameEn"):
                    result["glossary"][s["name"]] = s["nameEn"]
            # 所选术语必须按目标语言原样出现在结果里（可校验的硬性要求）
            for s in picked:
                term = (s.get("nameEn") or s.get("name")) if lang == "en" else (s.get("name") or s.get("nameEn"))
                if str(term or "").strip():
                    result["required"].append(str(term).strip())

    notes = "\n\n".join(s for s in sections if s.strip())
    result["notes"] = notes
    result["protected"] = [
        m.group(1).strip() for m in _PROTECT_RE.finditer(notes) if m.group(1).strip()
    ]
    # 受保护技术词（<!...> 内部原文）同样必须原样出现
    for term in result["protected"]:
        if term not in result["required"]:
            result["required"].append(term)
    if len(result["protected"]) > _MAX_ITEMS_WARN:
        result["warnings"].append(
            f"本次注入技术词 {len(result['protected'])} 条，建议精简所选技能以免稀释注意力")
    return result


def glossary_for_text(text: str) -> dict[str, str]:
    """术语型（term）类别中英对照，仅保留源文里出现的中文名（翻译阶段注入）。

    覆盖全部 term 类别词条（包含用户输入自带、但未勾选的词），不依赖 selections。
    """
    out: dict[str, str] = {}
    if not text:
        return out
    try:
        data = skill_db.list_all()
    except Exception:
        return out
    term_ids = {
        c["id"] for c in data.get("categories") or []
        if str(c.get("renderMode") or "").lower() == "term"
    }
    if not term_ids:
        return out
    for s in data.get("skills") or []:
        if s.get("categoryId") in term_ids and s.get("name") and s.get("nameEn"):
            if s["name"] in text:
                out[s["name"]] = s["nameEn"]
    return out


def resolve_legacy_selections(
    camera_motion="", expression="", shot_size="", framing="",
) -> dict[str, list[str]]:
    """旧 payload 字段（camera_motion / expression / shot_size / framing）→ selections。

    仅用于兼容尚未升级的调用方：按类别 render_mode 反查类别名，避免写死中文类别名。
    """
    pairs = {
        "camera": camera_motion,
        "example": expression,
        "term": [],
    }
    out: dict[str, list[str]] = {}
    try:
        cats = skill_db.list_all().get("categories") or []
    except Exception:
        return out
    by_mode: dict[str, list[str]] = {}
    for c in cats:
        by_mode.setdefault(str(c.get("renderMode") or "descriptive"), []).append(c["name"])

    def _keys(value) -> list[str]:
        if isinstance(value, str):
            return [value] if value.strip() else []
        if isinstance(value, (list, tuple)):
            return [str(x) for x in value if str(x or "").strip()]
        return []

    cam = _keys(camera_motion)
    if cam and by_mode.get("camera"):
        out[by_mode["camera"][0]] = cam
    expr = _keys(expression)
    if expr and by_mode.get("example"):
        out[by_mode["example"][0]] = expr
    # 景别 / 镜头结构都是 term 类：两个参数按 term 类别顺序分配（单类别时合并）
    terms = by_mode.get("term") or []
    sizes, frames = _keys(shot_size), _keys(framing)
    if terms and (sizes or frames):
        if len(terms) == 1:
            out[terms[0]] = sizes + frames
        else:
            if sizes:
                out[terms[0]] = sizes
            if frames:
                out[terms[1]] = frames
    return out
