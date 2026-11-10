"""镜头技能词典的 SQLite 存储。

库文件：install/skills.db（随插件存放）。
两张表：
    skill_categories(id, name UNIQUE, description, sort)   类别名 + 类别描述
    skills(id, category_id FK, key UNIQUE, name, name_en, desc,
           guide, examples, group_name, builtin, created_at)

字段按类别使用（三段链路「原始提示词 → H3 中文 → H3 英文」）：
- 运镜：guide = Camera Motion LoRA 写法指南；examples = 英文触发短语数组。
- 景别 / 镜头结构：name 中文名直接写入提示词；name_en 供英文阶段对照。
- 微表情：examples = 中文示例数组（最终使用）；group_name = eye/brow/mouth/
  breath/body 分组（旧导演台筛选用）。

初始化与迁移：
- 首次连接（skills.db.lock 不存在）时执行 install/skill_seed.py 的种子写入。
- 旧库（含 prompt/example/keyword/meta 列，user_version=0）在事务内重建为
  新结构并回填 name_en/examples/group_name；内置词条内容以新种子为准，
  用户自定义词条按类别映射保留。迁移成功后 PRAGMA user_version=1。
- .lock 存在即不再重新播种，数据库是唯一数据源。

读取接口：
- list_all()：全量（categories / skills，examples 已解析为数组）
- category_presets()：生成链路用的四类预设（lib/prompt.py _skill_presets 消费）

CRUD 全部走进程内锁串行；数据量 <100 行，查询一次全量。
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import threading
import time
from pathlib import Path

from ..install.skill_seed import (
    CATEGORY_FIELD,
    GROUP_TO_CATEGORY,
    build_builtin_categories,
    builtin_skill_rows,
)
from . import spa_store

log = logging.getLogger(__name__)

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

_SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS skill_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    sort        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS skills (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES skill_categories(id) ON DELETE CASCADE,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    name_en     TEXT NOT NULL DEFAULT '',
    desc        TEXT NOT NULL DEFAULT '',
    guide       TEXT NOT NULL DEFAULT '',
    examples    TEXT NOT NULL DEFAULT '[]',
    group_name  TEXT NOT NULL DEFAULT '',
    builtin     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category_id);
"""

# key 只允许小写字母数字下划线（内置 key 皆如此）；自动生成时做同样约束
_KEY_RE = re.compile(r"^[a-z0-9_]{1,64}$")

# 内置类别 → 新增/编辑时的字段规则（None 表示该字段不要求）
#   name_en：英文标准写法必填（英文翻译阶段对照）
#   examples_label：examples 数组必填时的字段说明
_CATEGORY_RULES = {
    "运镜": {"name_en": False, "examples_label": "英文触发短语（如 slow push-in，多个用分号分隔）"},
    "景别": {"name_en": True, "examples_label": None},
    "镜头结构": {"name_en": True, "examples_label": None},
    "微表情": {"name_en": False, "examples_label": "中文示例（多个用分号分隔，如 轻叹；垂首）"},
}


def _db_path() -> Path:
    # 数据库随插件存放：项目根下的 install/ 目录（skill_db.py 位于 lib/，根为其上级）
    d = Path(__file__).resolve().parent.parent / "install"
    d.mkdir(parents=True, exist_ok=True)
    return d / "skills.db"


def _lock_path() -> Path:
    """初始化标记：存在即视为已初始化（首次建库成功后写入）。"""
    return _db_path().with_name(_db_path().name + ".lock")


def _table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def _parse_examples(raw: str | None) -> list[str]:
    """examples 列（JSON 数组文本）→ 字符串数组；坏数据容错为空数组。"""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return []
    if isinstance(data, list):
        return [str(x) for x in data if str(x).strip()]
    return []


def _migrate_v0_to_v1(conn: sqlite3.Connection) -> None:
    """旧结构（prompt/example/keyword/meta 列）→ 新结构，事务内重建 skills 表。

    - 内置词条：key 命中新种子时直接使用种子新内容（README 运镜指南等）。
    - 自定义词条：从旧列与 meta JSON 回填 name_en / examples / group_name。
    - 同步刷新四个内置类别的描述（运镜类别描述含 LoRA 触发词核心规则）。
    """
    cols = _table_columns(conn, "skills")
    if not cols or "meta" not in cols:
        # 已是新结构（或表不存在），仅确保版本号
        conn.execute(f"PRAGMA user_version={_SCHEMA_VERSION}")
        return
    cat_name_by_id = {
        int(r["id"]): r["name"]
        for r in conn.execute("SELECT id, name FROM skill_categories").fetchall()
    }
    seed_rows = builtin_skill_rows()
    conn.execute("ALTER TABLE skills RENAME TO skills_v0")
    conn.execute(
        """CREATE TABLE skills (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            category_id INTEGER NOT NULL REFERENCES skill_categories(id) ON DELETE CASCADE,
            key         TEXT NOT NULL UNIQUE,
            name        TEXT NOT NULL,
            name_en     TEXT NOT NULL DEFAULT '',
            desc        TEXT NOT NULL DEFAULT '',
            guide       TEXT NOT NULL DEFAULT '',
            examples    TEXT NOT NULL DEFAULT '[]',
            group_name  TEXT NOT NULL DEFAULT '',
            builtin     INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL DEFAULT 0
        )"""
    )
    rows = conn.execute("SELECT * FROM skills_v0").fetchall()
    for r in rows:
        try:
            meta = json.loads(r["meta"]) if r["meta"] else {}
            if not isinstance(meta, dict):
                meta = {}
        except Exception:
            meta = {}
        cat_name = cat_name_by_id.get(int(r["category_id"])) or ""
        builtin = bool(r["builtin"])
        seed = seed_rows.get(r["key"]) if builtin else None
        if seed is not None:
            name = seed["name"]
            name_en = seed["name_en"]
            desc = seed["desc"]
            guide = seed["guide"]
            examples = list(seed["examples"])
            group = seed["group_name"]
        else:
            name = r["name"]
            name_en = str(meta.get("name_en") or "")
            desc = r["desc"] or ""
            guide = ""
            if cat_name == "运镜":
                examples = [str(x) for x in (meta.get("examples_en") or []) if str(x).strip()]
            elif cat_name == "微表情":
                examples = [str(x) for x in (meta.get("examples_zh") or []) if str(x).strip()]
            else:
                examples = []
            group = str(meta.get("micro_category") or "")
        conn.execute(
            "INSERT OR REPLACE INTO skills(category_id, key, name, name_en, desc, guide,"
            " examples, group_name, builtin, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (int(r["category_id"]), r["key"], name, name_en, desc, guide,
             json.dumps(examples, ensure_ascii=False), group,
             1 if builtin else 0, int(r["created_at"] or 0)),
        )
    conn.execute("DROP TABLE skills_v0")
    # 刷新内置类别描述（老库的运镜描述不含触发词规则）
    for cat in build_builtin_categories():
        conn.execute(
            "UPDATE skill_categories SET description=? WHERE name=?",
            (cat["description"], cat["name"]),
        )
    conn.execute(f"PRAGMA user_version={_SCHEMA_VERSION}")
    log.info("[SPA] skill dict schema migrated v0 -> v1 (%d rows kept)", len(rows))


def _connect() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(str(_db_path()), check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA foreign_keys=ON")
            _conn.executescript(_SCHEMA)
            try:
                version = int(_conn.execute("PRAGMA user_version").fetchone()[0])
                if version < _SCHEMA_VERSION:
                    with _conn:
                        _migrate_v0_to_v1(_conn)
            except Exception:
                log.warning("[SPA] skill dict schema migration failed", exc_info=True)
            # .lock 存在 → 已初始化过，不再跑种子（避免覆盖用户的库内编辑）
            if not _lock_path().exists():
                try:
                    _seed_builtin()
                    _migrate_custom_json()
                    _conn.commit()
                    _lock_path().write_text(
                        f"initialized {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
                        "delete this file to re-run install seeding\n",
                        encoding="utf-8",
                    )
                    log.info("[SPA] skill dict initialized -> %s", _lock_path())
                except Exception:
                    _conn.rollback()
                    log.warning("[SPA] skill dict seed/migrate failed", exc_info=True)
        return _conn


def _seed_builtin() -> None:
    """install/skill_seed.py 的内置类别 + 技能写入（key 唯一，存在即跳过）。"""
    conn = _connect()
    for sort, cat in enumerate(build_builtin_categories()):
        cur = conn.execute("SELECT id FROM skill_categories WHERE name=?", (cat["name"],))
        row = cur.fetchone()
        if row is None:
            cur = conn.execute(
                "INSERT INTO skill_categories(name, description, sort) VALUES(?,?,?)",
                (cat["name"], cat.get("description") or "", sort),
            )
            cat_id = int(cur.lastrowid or 0)
        else:
            cat_id = int(row["id"])
            conn.execute(
                "UPDATE skill_categories SET description=? WHERE id=?",
                (cat.get("description") or "", cat_id),
            )
        for s in cat.get("skills") or []:
            conn.execute(
                "INSERT OR IGNORE INTO skills(category_id, key, name, name_en, desc, guide,"
                " examples, group_name, builtin, created_at) VALUES(?,?,?,?,?,?,?,?,1,?)",
                (cat_id, s["key"], s["name"], s.get("name_en") or "", s.get("desc") or "",
                 s.get("guide") or "", json.dumps(s.get("examples") or [], ensure_ascii=False),
                 s.get("group_name") or "", int(time.time() * 1000)),
            )


def _migrate_custom_json() -> None:
    """把 spa/skills.json 的历史自定义词条迁入（builtin=0，key 冲突跳过）。"""
    try:
        custom = spa_store.load_skills()
    except Exception:
        return
    if not custom:
        return
    conn = _connect()
    cat_ids = {r["name"]: int(r["id"]) for r in
               conn.execute("SELECT id, name FROM skill_categories").fetchall()}
    for group, items in custom.items():
        cat_name = GROUP_TO_CATEGORY.get(str(group))
        cat_id = cat_ids.get(cat_name) if cat_name else None
        if not cat_id:
            continue
        for it in items or []:
            if not isinstance(it, dict):
                continue
            key = str(it.get("key") or "").strip()
            label = str(it.get("label") or "").strip()
            if not key or not label:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO skills(category_id, key, name, name_en, desc, guide,"
                " examples, group_name, builtin, created_at) VALUES(?,?,?,'',?,'','[]','','0',?)",
                (cat_id, key, label, str(it.get("title") or ""), int(time.time() * 1000)),
            )


# ---------------- 查询 ----------------

def list_all() -> dict:
    with _lock:
        conn = _connect()
        cats = [
            {"id": int(r["id"]), "name": r["name"], "description": r["description"],
             "sort": int(r["sort"])}
            for r in conn.execute(
                "SELECT id, name, description, sort FROM skill_categories ORDER BY sort, id")
        ]
        skills = [
            {
                "id": int(r["id"]),
                "categoryId": int(r["category_id"]),
                "name": r["name"],
                "key": r["key"],
                "nameEn": r["name_en"],
                "desc": r["desc"],
                "guide": r["guide"],
                "examples": _parse_examples(r["examples"]),
                "groupName": r["group_name"],
                "builtin": bool(r["builtin"]),
            }
            for r in conn.execute("SELECT * FROM skills ORDER BY id")
        ]
        return {"categories": cats, "skills": skills}


def category_presets() -> dict:
    """生成链路四类预设（lib/prompt.py _skill_presets 消费）。

    返回 {
      "camera":     {key: {name_zh, name_en, desc_zh, guide, examples(英文触发短语)}},
      "shotSize":   {key: {name_zh, name_en}},
      "framing":    {key: {name_zh, name_en}},
      "expression": {key: {name_zh, name_en, desc_zh, examples_zh, group}},
    }
    界面新增的技能按 desc/nameEn/examples/groupName 推导。
    """
    field_of_category = dict(CATEGORY_FIELD)
    data = list_all()
    cat_name = {c["id"]: c["name"] for c in data["categories"]}
    out: dict[str, dict] = {f: {} for f in field_of_category.values()}
    for s in data["skills"]:
        cat = cat_name.get(s["categoryId"]) or ""
        field = field_of_category.get(cat)
        if not field:
            continue
        name = s["name"] or s["key"]
        if field == "camera":
            out[field][s["key"]] = {
                "name_zh": name,
                "name_en": s["nameEn"] or name,
                "desc_zh": s["desc"] or name,
                "guide": s["guide"] or "",
                "examples": list(s["examples"] or []),
            }
        elif field in ("shotSize", "framing"):
            out[field][s["key"]] = {
                "name_zh": name,
                "name_en": s["nameEn"] or name,
            }
        elif field == "expression":
            out[field][s["key"]] = {
                "name_zh": name,
                "name_en": s["nameEn"] or name,
                "desc_zh": s["desc"] or name,
                "examples_zh": list(s["examples"] or []),
                "group": s["groupName"] or "body",
            }
    return out


# ---------------- 写操作 ----------------

def _gen_key(name: str, conn: sqlite3.Connection) -> str:
    """由 name 自动生成 key：ASCII 词连下划线；纯中文等无法 slug 时用 hash 兜底。"""
    slug = re.sub(r"[^a-z0-9]+", "_", str(name).lower()).strip("_")
    if not slug:
        import hashlib
        slug = "s_" + hashlib.md5(str(name).encode("utf-8")).hexdigest()[:8]
    base, i = slug, 1
    while conn.execute("SELECT 1 FROM skills WHERE key=?", (slug,)).fetchone():
        if not _KEY_RE.match(slug):
            raise ValueError(f"非法 key：{slug}")
        slug = f"{base}_{i}"
        i += 1
        if i > 50:
            raise ValueError("key 生成冲突过多，请换一个名称")
    return slug


def _normalize_examples(value) -> list[str]:
    """examples 入参归一化：list / 分号（; ；）或换行分隔的字符串 → 去空数组。"""
    if value is None:
        return []
    if isinstance(value, str):
        parts = re.split(r"[;；\n]", value)
        items = [p.strip() for p in parts]
    elif isinstance(value, (list, tuple)):
        items = [str(x).strip() for x in value]
    else:
        raise ValueError("examples 格式错误：应为数组或分号分隔的字符串")
    return [x for x in items if x]


def _category_rule(cat_name: str) -> dict:
    return _CATEGORY_RULES.get(cat_name) or {"name_en": False, "examples_label": None}


def _validate_by_category(cat_name: str, name: str, name_en: str, examples: list[str]) -> None:
    """按类别校验新增/编辑字段（自定义类别只要求名称）。"""
    rule = _category_rule(cat_name)
    if rule.get("name_en") and not name_en:
        raise ValueError(f"类别「{cat_name}」必须填写英文写法（name_en，用于英文翻译对照）")
    label = rule.get("examples_label")
    if label and not examples:
        raise ValueError(f"类别「{cat_name}」必须填写{label}")


def _cat_name(conn: sqlite3.Connection, cat_id: int) -> str:
    row = conn.execute("SELECT name FROM skill_categories WHERE id=?", (cat_id,)).fetchone()
    return row["name"] if row else ""


def add_skill(payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("技能名称不能为空")
    cat_id = int(payload.get("categoryId") or payload.get("category_id") or 0)
    with _lock:
        conn = _connect()
        if not conn.execute("SELECT 1 FROM skill_categories WHERE id=?", (cat_id,)).fetchone():
            raise ValueError(f"技能类别不存在：{cat_id}")
        cat_name = _cat_name(conn, cat_id)
        name_en = str(payload.get("nameEn") or payload.get("name_en") or "").strip()
        desc = str(payload.get("desc") or "").strip()
        guide = str(payload.get("guide") or "").strip()
        examples = _normalize_examples(payload.get("examples"))
        _validate_by_category(cat_name, name, name_en, examples)
        key = str(payload.get("key") or "").strip().lower() or _gen_key(name, conn)
        if not _KEY_RE.match(key):
            raise ValueError(f"非法 key：{key}（仅允许小写字母/数字/下划线）")
        if conn.execute("SELECT 1 FROM skills WHERE key=?", (key,)).fetchone():
            raise ValueError(f"key 已存在：{key}")
        cur = conn.execute(
            "INSERT INTO skills(category_id, key, name, name_en, desc, guide, examples,"
            " group_name, builtin, created_at) VALUES(?,?,?,?,?,?,?,?,'0',?)",
            (cat_id, key, name, name_en, desc, guide,
             json.dumps(examples, ensure_ascii=False),
             str(payload.get("groupName") or payload.get("group_name") or ""),
             int(time.time() * 1000)),
        )
        conn.commit()
        return {"id": int(cur.lastrowid or 0), "key": key}


def update_skill(payload: dict) -> dict:
    skill_id = int(payload.get("id") or 0)
    if not skill_id:
        raise ValueError("缺少技能 id")
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT * FROM skills WHERE id=?", (skill_id,)).fetchone()
        if row is None:
            raise ValueError(f"技能不存在：{skill_id}")
        fields = {
            "name": str(payload.get("name") or row["name"]).strip(),
            "name_en": str(payload.get("nameEn") if payload.get("nameEn") is not None
                           else (payload.get("name_en") if payload.get("name_en") is not None
                                 else row["name_en"])).strip(),
            "desc": str(payload.get("desc") if payload.get("desc") is not None else row["desc"]),
            "guide": str(payload.get("guide") if payload.get("guide") is not None else row["guide"]),
            "group_name": str(payload.get("groupName") if payload.get("groupName") is not None
                              else row["group_name"]),
        }
        if payload.get("examples") is not None:
            examples = _normalize_examples(payload.get("examples"))
        else:
            examples = _parse_examples(row["examples"])
        if not fields["name"]:
            raise ValueError("技能名称不能为空")
        cat_name = _cat_name(conn, int(row["category_id"]))
        _validate_by_category(cat_name, fields["name"], fields["name_en"], examples)
        # key 与 builtin 不可改（内置 key 与生成链路一一对应）
        conn.execute(
            "UPDATE skills SET name=?, name_en=?, desc=?, guide=?, examples=?, group_name=?"
            " WHERE id=?",
            (fields["name"], fields["name_en"], fields["desc"], fields["guide"],
             json.dumps(examples, ensure_ascii=False), fields["group_name"], skill_id),
        )
        conn.commit()
        return {"id": skill_id}


def delete_skill(payload: dict) -> dict:
    skill_id = int(payload.get("id") or 0)
    if not skill_id:
        raise ValueError("缺少技能 id")
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT builtin FROM skills WHERE id=?", (skill_id,)).fetchone()
        if row is None:
            raise ValueError(f"技能不存在：{skill_id}")
        if row["builtin"]:
            raise ValueError("内置技能不可删除（可修改其名称/英文写法/指南/示例）")
        conn.execute("DELETE FROM skills WHERE id=?", (skill_id,))
        conn.commit()
        return {"id": skill_id}


def add_category(payload: dict) -> dict:
    """新增类别（自定义技能分组用）。"""
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("类别名称不能为空")
    with _lock:
        conn = _connect()
        if conn.execute("SELECT 1 FROM skill_categories WHERE name=?", (name,)).fetchone():
            raise ValueError(f"类别已存在：{name}")
        cur = conn.execute(
            "INSERT INTO skill_categories(name, description, sort) VALUES(?,?,?)",
            (name, str(payload.get("description") or ""), int(payload.get("sort") or 99)),
        )
        conn.commit()
        return {"id": int(cur.lastrowid or 0), "name": name}


BATCH_ADD_MAX = 200  # 单次批量导入上限（超出提示分批，避免一次性长事务）


def batch_add_skills(payload: dict) -> dict:
    """批量导入技能词条。

    payload: { categoryId?: int, newCategory?: str,
               items: [ {name, nameEn?, desc?, guide?, examples?, key?} ] }
    - 可选先建新类别（newCategory，同名已存在则复用）。
    - 逐条复用 add_skill（独立失败，不影响已入库条目），收集失败原因。
    返回 {added: int, failed: [{name, error}], total: int}
    """
    raw_items = payload.get("items") or []
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("导入内容为空")
    if len(raw_items) > BATCH_ADD_MAX:
        raise ValueError(f"单次最多导入 {BATCH_ADD_MAX} 条，请分批导入")

    cat_id = int(payload.get("categoryId") or 0)
    new_cat = str(payload.get("newCategory") or "").strip()
    if new_cat:
        try:
            cat_id = int(add_category({"name": new_cat})["id"])
        except ValueError as e:
            # 同名类别已存在 → 复用现有类别
            if "已存在" in str(e):
                with _lock:
                    row = _connect().execute(
                        "SELECT id FROM skill_categories WHERE name=?", (new_cat,)
                    ).fetchone()
                if not row:
                    raise
                cat_id = int(row["id"])
            else:
                raise
    if not cat_id:
        raise ValueError("请选择类别或填写新类别")

    added, failed = 0, []
    for i, item in enumerate(raw_items):
        name = str(item.get("name") or "").strip() if isinstance(item, dict) else str(item).strip()
        try:
            if not isinstance(item, dict):
                raise ValueError(f"第 {i + 1} 行格式错误")
            add_skill({**item, "categoryId": cat_id})
            added += 1
        except ValueError as e:
            failed.append({"name": name or f"第 {i + 1} 行", "error": str(e)})
        except Exception as e:  # 单条异常不中断批次
            failed.append({"name": name or f"第 {i + 1} 行", "error": str(e)})
    return {"added": added, "failed": failed, "total": len(raw_items)}


def skill_dict_snapshot() -> dict:
    """对外暴露的只读快照，供接口层直接返回。"""
    return list_all()


def close() -> None:
    """进程退出时关闭连接（ComfyUI 重载节点时调用亦可）。"""
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
