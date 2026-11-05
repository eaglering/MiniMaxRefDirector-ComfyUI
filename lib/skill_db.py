"""镜头技能词典的 SQLite 存储。

库文件：user/default/MiniMaxRefDirector/spa/skills.db（对齐 spa_store 布局）。
两张表：
    skill_categories(id, name UNIQUE, description, sort)   类别名 + 类别描述
    skills(id, category_id FK, name, key UNIQUE, desc, prompt,
           example, keyword, meta, builtin, created_at)

初始化（install 语义）：
- 首次连接（skills.db.lock 不存在）时执行 install/skill_seed.py 的种子写入
  （4 类别 + 42 条内置技能 + spa/skills.json 历史自定义词条迁移），成功后写
  skills.db.lock；之后 lock 存在即不再初始化，数据库是唯一数据源（界面编辑 /
  新增技能都落库，不会被种子覆盖）。

读取接口：
- list_all()：全量（categories / skills，含 meta JSON）
- category_presets()：生成链路用的四类预设（lib/prompt.py _skill_presets 消费）
- skill_keys_text()：注入分镜模板 {{skill_keys}} 的 key 清单

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

import folder_paths

from ..install.skill_seed import GROUP_TO_CATEGORY, build_builtin_categories
from . import spa_store

log = logging.getLogger(__name__)

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

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
    name        TEXT NOT NULL,
    key         TEXT NOT NULL UNIQUE,
    desc        TEXT NOT NULL DEFAULT '',
    prompt      TEXT NOT NULL DEFAULT '',
    example     TEXT NOT NULL DEFAULT '',
    keyword     TEXT NOT NULL DEFAULT '',
    meta        TEXT NOT NULL DEFAULT '',
    builtin     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category_id);
"""

# key 只允许小写字母数字下划线（内置 key 皆如此）；自动生成时做同样约束
_KEY_RE = re.compile(r"^[a-z0-9_]{1,64}$")


def _db_path() -> Path:
    user_dir = Path(folder_paths.get_user_directory())
    d = user_dir / "default" / "MiniMaxRefDirector" / "spa"
    d.mkdir(parents=True, exist_ok=True)
    return d / "skills.db"


def _lock_path() -> Path:
    """初始化标记：存在即视为已初始化（首次建库成功后写入）。"""
    return _db_path().with_name(_db_path().name + ".lock")


def _connect() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(str(_db_path()), check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA foreign_keys=ON")
            _conn.executescript(_SCHEMA)
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
        for s in cat.get("skills") or []:
            conn.execute(
                "INSERT OR IGNORE INTO skills(category_id, name, key, desc, prompt, example,"
                " keyword, meta, builtin, created_at) VALUES(?,?,?,?,?,?,?,?,1,?)",
                (cat_id, s["name"], s["key"], s.get("desc") or "", s.get("prompt") or "",
                 s.get("example") or "", s.get("keyword") or "", s.get("meta") or "",
                 int(time.time() * 1000)),
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
                "INSERT OR IGNORE INTO skills(category_id, name, key, desc, prompt, example,"
                " keyword, meta, builtin, created_at) VALUES(?,?,?,?,?,?,?,?,'0',?)",
                (cat_id, label, key, str(it.get("title") or ""), "", "", "", "",
                 int(time.time() * 1000)),
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
                "desc": r["desc"],
                "prompt": r["prompt"],
                "example": r["example"],
                "keyword": r["keyword"],
                "meta": r["meta"] or "",
                "builtin": bool(r["builtin"]),
            }
            for r in conn.execute("SELECT * FROM skills ORDER BY id")
        ]
        return {"categories": cats, "skills": skills}


def category_presets() -> dict:
    """生成链路四类预设（lib/prompt.py _skill_presets 消费）。

    返回 {"camera"/"shotSize"/"framing"/"expression": {key: {
        name_en, name_zh, desc(英), desc_zh, examples(英), examples_zh }}}
    双语信息存于 skills.meta（install 种子写入）；界面新增的技能按
    desc/prompt/example 推导（desc→desc_zh，prompt→desc_en/examples[0] 等）。
    """
    field_of_category = {"运镜": "camera", "景别": "shotSize",
                         "镜头结构": "framing", "微表情": "expression"}
    data = list_all()
    cat_name = {c["id"]: c["name"] for c in data["categories"]}
    out: dict[str, dict] = {f: {} for f in field_of_category.values()}
    for s in data["skills"]:
        cat = cat_name.get(s["categoryId"]) or ""
        field = field_of_category.get(cat)
        if not field:
            continue
        try:
            meta = json.loads(s["meta"]) if s["meta"] else {}
        except Exception:
            meta = {}
        if not isinstance(meta, dict):
            meta = {}
        name = s["name"] or s["key"]
        out[field][s["key"]] = {
            "name_en": meta.get("name_en") or name,
            "name_zh": meta.get("name_zh") or name,
            "desc": meta.get("desc_en") or s["prompt"] or s["desc"],
            "desc_zh": meta.get("desc_zh") or s["desc"] or name,
            "examples": meta.get("examples_en") or ([s["prompt"]] if s["prompt"] else []),
            "examples_zh": meta.get("examples_zh") or ([s["example"]] if s["example"] else []),
        }
    return out


def skill_keys_text() -> str:
    """生成注入分镜模板的 key 清单（按类别分组，<!类别名称:技能名称> 格式说明）。"""
    data = list_all()
    cat_name = {c["id"]: c["name"] for c in data["categories"]}
    lines = []
    for c in data["categories"]:
        names = [s["name"] for s in data["skills"] if s["categoryId"] == c["id"]]
        if names:
            lines.append(f"- {c['name']}：{'、'.join(names)}")
    if not lines:
        return "（技能词典为空）"
    return (
        "可选技能词典（**非必选**：是否使用、用哪个，由你按镜头语义决定，不必全部出现；"
        "在 prompt 正文中引用技能时使用 `<!类别名称:技能名称>` 格式，如 `<!运镜:推近 Push-in>`）：\n"
        + "\n".join(lines)
    )


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


def add_skill(payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("技能名称不能为空")
    desc = str(payload.get("desc") or "").strip()
    if not desc:
        raise ValueError("技能描述不能为空")
    cat_id = int(payload.get("categoryId") or payload.get("category_id") or 0)
    with _lock:
        conn = _connect()
        if not conn.execute("SELECT 1 FROM skill_categories WHERE id=?", (cat_id,)).fetchone():
            raise ValueError(f"技能类别不存在：{cat_id}")
        key = str(payload.get("key") or "").strip().lower() or _gen_key(name, conn)
        if not _KEY_RE.match(key):
            raise ValueError(f"非法 key：{key}（仅允许小写字母/数字/下划线）")
        if conn.execute("SELECT 1 FROM skills WHERE key=?", (key,)).fetchone():
            raise ValueError(f"key 已存在：{key}")
        cur = conn.execute(
            "INSERT INTO skills(category_id, name, key, desc, prompt, example, keyword,"
            " meta, builtin, created_at) VALUES(?,?,?,?,?,?,?,?,'0',?)",
            (cat_id, name, key, desc,
             str(payload.get("prompt") or desc),
             str(payload.get("example") or ""),
             str(payload.get("keyword") or ""),
             "",
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
            "desc": str(payload.get("desc") if payload.get("desc") is not None else row["desc"]),
            "prompt": str(payload.get("prompt") if payload.get("prompt") is not None else row["prompt"]),
            "example": str(payload.get("example") if payload.get("example") is not None else row["example"]),
            "keyword": str(payload.get("keyword") if payload.get("keyword") is not None else row["keyword"]),
        }
        if not fields["name"]:
            raise ValueError("技能名称不能为空")
        # key 与 builtin 不可改（内置 key 与生成链路一一对应）
        conn.execute(
            "UPDATE skills SET name=?, desc=?, prompt=?, example=?, keyword=? WHERE id=?",
            (fields["name"], fields["desc"], fields["prompt"], fields["example"],
             fields["keyword"], skill_id),
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
            raise ValueError("内置技能不可删除（可修改其描述/提示词/案例）")
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


def skill_dict_snapshot() -> dict:
    """对外暴露的只读快照（含 key 文本），供接口层直接返回。"""
    data = list_all()
    data["skillKeysText"] = skill_keys_text()
    return data


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
