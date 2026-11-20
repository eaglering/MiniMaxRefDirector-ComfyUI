"""镜头技能词典 + 技能文档的 SQLite 存储。

库文件：install/skills.db（随插件存放）。
三张表：
    skill_categories(id, name UNIQUE, description, sort, render_mode)
    skills(id, category_id FK, key UNIQUE, name, name_en, desc,
           examples, group_name, builtin, created_at)
    skill_docs(id, category, title, content, builtin_key UNIQUE, builtin, sort,
               created_at, updated_at)   —— md 提示词模板（主体/音频/图片/分镜设计）

字段按类别使用（三段链路「原始提示词 → H3 中文 → H3 英文」）：
- term 类别：name 中文名直接写入提示词；name_en 供英文阶段对照。
- example 类别：examples = 中文示例数组（生成时挑一句织入）；group_name 为展示分组。
- descriptive / block 类别：desc 与内容按 render_mode 语义注入。

初始化：
- 首次连接（install/skills.db.lock 不存在）时写入种子：内置技能类别与词条
  （install/skill_seed.py）+ 技能文档（install/skill_docs/seed.json，
  缺失时回落 resources/skills）。
- .lock 存在即不再播种，数据库是唯一数据源；删库重建请同时删除 .lock。
- 建表全部 IF NOT EXISTS；旧结构（含 protect_keywords / guide 列、camera 注入方式）
  由 _migrate_legacy_schema() 在连接时自动迁移。
- 内置词条（builtin=1）的内容随种子升级：名称/对照/描述/示例以种子为准自动刷新。

读取接口：
- list_all()：全量（categories / skills，examples 已解析为数组）

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
    BUILTIN_CATEGORY_RENDER,
    RENDER_MODES,
    build_builtin_categories,
)

log = logging.getLogger(__name__)

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS skill_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    sort        INTEGER NOT NULL DEFAULT 0,
    render_mode TEXT NOT NULL DEFAULT 'descriptive'
);
CREATE TABLE IF NOT EXISTS skills (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES skill_categories(id) ON DELETE CASCADE,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    name_en     TEXT NOT NULL DEFAULT '',
    desc        TEXT NOT NULL DEFAULT '',
    examples    TEXT NOT NULL DEFAULT '[]',
    group_name  TEXT NOT NULL DEFAULT '',
    builtin     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category_id);
CREATE TABLE IF NOT EXISTS skill_docs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    builtin_key TEXT NOT NULL DEFAULT '',
    builtin     INTEGER NOT NULL DEFAULT 0,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(category, title)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_docs_key
    ON skill_docs(builtin_key) WHERE builtin_key <> '';
CREATE INDEX IF NOT EXISTS idx_skill_docs_category ON skill_docs(category);
"""

# 技能文档二级分类（固定枚举：不做自由增删，避免「分类标识」歧义）
DOC_CATEGORIES = ("主体设计", "音频设计", "图片设计", "分镜设计")

# resources/skills 文件态文档 → (分类, 标题[, 相对 resources/skills 的文件路径])，
# 作为 DB 缺失时的播种与运行期兜底；未给路径时按 <key>/prompt.md 解析。
_RESOURCE_DOCS = {
    "character-design": ("分镜设计", "主体设计指南（角色 / 场景）"),
    "firstframe-design": ("分镜设计", "首帧 / 尾帧图提示词设计"),
    "audio-design": ("分镜设计", "音频设计指南（配音 / 音效 / 音乐）"),
    "story-design": ("分镜设计", "故事大纲提取"),
    "storyboard-design": ("分镜设计", "分镜设计"),
    "h3-prompt-builder": ("分镜设计", "H3 提示词主模板"),
    "h3-writing-guide": ("分镜设计", "H3 四字段写作指南",
                         "h3-prompt-builder/h3-writing-guide.md"),
    "h3-translate-to-en": ("分镜设计", "H3 中英翻译模板",
                           "h3-prompt-builder/prompt_translate_to_en.md"),
}

# seed.json 内置文档的分类随版本演进的幂等迁移：builtin_key → 期望分类。
# 每次进程连接后与 DB 对齐一次（seed 只在首次建库生效，老库靠这里归位）。
_DOC_CATEGORY_MIGRATIONS = {
    "character-sheet": "分镜设计",  # 主体设定（外貌/服装/道具一致性）
    "ambience-foley": "分镜设计",   # 底噪 / 环境音 / 拟音设计
}


def _resource_doc_path(key: str) -> Path:
    """内置 key 对应的文件态正文路径（resources/skills 相对路径）。"""
    meta = _RESOURCE_DOCS.get(key) or ()
    rel = meta[2] if len(meta) > 2 else f"{key}/prompt.md"
    return Path(__file__).resolve().parent.parent / "resources" / "skills" / rel

# key 只允许小写字母数字下划线（内置 key 皆如此）；自动生成时做同样约束
_KEY_RE = re.compile(r"^[a-z0-9_]{1,64}$")

# 注入方式（render_mode）→ 新增/编辑技能时的字段要求。
# 校验按类别配置的 render_mode 而非类别名，新增类别无需改代码。
_RENDER_MODE_RULES = {
    "term": {"name_en": True, "examples_label": None},
    "example": {"name_en": False, "examples_label": "示例（多个用分号分隔）"},
    "descriptive": {"name_en": False, "examples_label": None},
    "block": {"name_en": False, "examples_label": "内容片段（也可写在描述里）"},
}


def _db_path() -> Path:
    # 数据库随插件存放：项目根下的 install/ 目录（skill_db.py 位于 lib/，根为其上级）
    d = Path(__file__).resolve().parent.parent / "install"
    d.mkdir(parents=True, exist_ok=True)
    return d / "skills.db"


def _lock_path() -> Path:
    """初始化标记：存在即视为已初始化（首次建库成功后写入）。"""
    return _db_path().with_name(_db_path().name + ".lock")


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


def _seed_skill_docs() -> None:
    """技能文档首次播种：install/skill_docs/seed.json 清单（正文相对清单目录）。

    种子缺失或读取失败只告警，不影响启动；resources/skills 文件态内置文档由
    ``_sync_builtin_docs`` 负责（每次进程连接后同步一次）。INSERT OR IGNORE，
    用户已改过的文档不会被覆盖。
    """
    # 由 _connect() 在连接就绪后调用：直接复用全局连接（不能再走 _connect 递归）
    global _conn
    conn = _conn
    if conn is None:
        return
    root = Path(__file__).resolve().parent.parent
    now = int(time.time() * 1000)
    seed_dir = root / "install" / "skill_docs"
    manifest = seed_dir / "seed.json"
    added = 0
    if manifest.is_file():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8-sig"))
            items = data.get("docs") if isinstance(data, dict) else None
            for i, item in enumerate(items or []):
                key = str(item.get("key") or "").strip()
                category = str(item.get("category") or "").strip()
                title = str(item.get("title") or "").strip()
                fname = str(item.get("file") or "").strip()
                if not (key and category and title and fname):
                    log.warning("[SPA] skill_docs seed 条目缺字段，已跳过：%s", item)
                    continue
                if category not in DOC_CATEGORIES:
                    log.warning("[SPA] skill_docs seed 分类非法（%s），已跳过：%s", category, title)
                    continue
                path = seed_dir / fname
                if not path.is_file():
                    log.warning("[SPA] skill_docs 文档文件缺失：%s", path)
                    continue
                content = path.read_text(encoding="utf-8-sig")
                cur = conn.execute(
                    "INSERT OR IGNORE INTO skill_docs(category, title, content, builtin_key,"
                    " builtin, sort, created_at, updated_at) VALUES(?,?,?,?,1,?,?,?)",
                    (category, title, content, key, i, now, now),
                )
                added += 1 if cur.rowcount else 0
        except Exception:
            log.warning("[SPA] skill_docs seed.json 解析失败", exc_info=True)
    conn.commit()
    log.info("[SPA] skill_docs seeded (%d docs)", added)


# 内置文档每进程只同步一次（避免每次 DB 访问都读 8 份文件）
_builtin_docs_synced = False


def _sync_builtin_docs() -> None:
    """resources/skills 内置文档 ↔ DB 同步（每次进程连接后执行一次）。

    - DB 缺行（新装 / 新增内置文档 / 用户在面板删过）→ 从文件补种；
    - 行存在且从未在面板编辑过（updated_at == created_at）→ 内容随文件升级，
      保证出厂文档修复/优化后老库也能拿到；
    - 用户编辑过的行（updated_at > created_at）→ 永不覆盖，DB 是唯一数据源。
    """
    global _conn, _builtin_docs_synced
    if _builtin_docs_synced:
        return
    conn = _conn
    if conn is None:
        return
    _builtin_docs_synced = True
    now = int(time.time() * 1000)
    changed = 0
    for i, name in enumerate(_RESOURCE_DOCS):
        category, title = (_RESOURCE_DOCS[name][0], _RESOURCE_DOCS[name][1])
        md = _resource_doc_path(name)
        if not md.is_file():
            continue
        try:
            content = md.read_text(encoding="utf-8-sig")
        except Exception:
            log.warning("[SPA] 读取 skill 文档失败：%s", md, exc_info=True)
            continue
        row = conn.execute(
            "SELECT id, content, created_at, updated_at FROM skill_docs WHERE builtin_key=?",
            (name,),
        ).fetchone()
        if row is None:
            conn.execute(
                "INSERT OR IGNORE INTO skill_docs(category, title, content, builtin_key,"
                " builtin, sort, created_at, updated_at) VALUES(?,?,?,?,1,?,?,?)",
                (category, title, content, name, 100 + i, now, now),
            )
            changed += 1
        else:
            # 分类随代码演进而迁移（幂等）：内容是否用户编辑过都不影响分类归位
            if row["category"] != category:
                conn.execute(
                    "UPDATE skill_docs SET category=? WHERE id=?", (category, row["id"])
                )
                changed += 1
            if row["updated_at"] == row["created_at"] and (row["content"] or "") != content:
                conn.execute(
                    "UPDATE skill_docs SET content=?, updated_at=? WHERE id=?",
                    (content, now, row["id"]),
                )
                changed += 1
    # seed.json 内置文档的分类迁移（_DOC_CATEGORY_MIGRATIONS）
    for key, category in _DOC_CATEGORY_MIGRATIONS.items():
        cur = conn.execute(
            "UPDATE skill_docs SET category=? WHERE builtin_key=? AND category<>?",
            (category, key, category),
        )
        changed += cur.rowcount if cur.rowcount > 0 else 0
    if changed:
        conn.commit()
        log.info("[SPA] builtin skill docs synced (%d updated)", changed)


def _migrate_legacy_schema(conn: sqlite3.Connection) -> None:
    """旧结构一次性迁移（仅当检测到 legacy 列时执行，避免覆盖用户后续编辑）：

    - render_mode='camera' → 'term'；
    - 删除 skill_categories.protect_keywords 与 skills.guide 列
      （SQLite < 3.35 不支持 DROP COLUMN 时保留列，但代码不再读写）；
    - 内置词条内容随种子全量刷新（name / name_en / desc / examples 以种子为准）。
    """
    cat_cols = {r[1] for r in conn.execute("PRAGMA table_info(skill_categories)")}
    skill_cols = {r[1] for r in conn.execute("PRAGMA table_info(skills)")}
    legacy = "protect_keywords" in cat_cols or "guide" in skill_cols
    if not legacy and "render_mode" in cat_cols:
        legacy = conn.execute(
            "SELECT 1 FROM skill_categories WHERE render_mode='camera' LIMIT 1"
        ).fetchone() is not None
    if not legacy:
        return
    log.info("[SPA] skill dict legacy schema detected, migrating...")
    if "render_mode" in cat_cols:
        conn.execute("UPDATE skill_categories SET render_mode='term' WHERE render_mode='camera'")
    # 内置词条随种子刷新（仅 builtin=1；此时 guide 列可能仍存在，一并清空）
    for cat in build_builtin_categories():
        for s in cat["skills"]:
            sets = ["name=?", "name_en=?", "desc=?", "examples=?"]
            args: list = [s["name"], s["name_en"], s["desc"],
                          json.dumps(s.get("examples") or [], ensure_ascii=False)]
            if "guide" in skill_cols:
                sets.append("guide=''")
            args.append(s["key"])
            conn.execute(
                f"UPDATE skills SET {', '.join(sets)} WHERE key=? AND builtin=1", args)
    for table, col in (("skill_categories", "protect_keywords"), ("skills", "guide")):
        if col in {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}:
            try:
                conn.execute(f"ALTER TABLE {table} DROP COLUMN {col}")
            except Exception:
                log.warning("[SPA] 删除 %s.%s 列失败（旧版 SQLite），保留列但不再使用",
                            table, col, exc_info=True)
    conn.commit()
    log.info("[SPA] skill dict legacy schema migrated")


def _connect() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(str(_db_path()), check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA foreign_keys=ON")
            _conn.executescript(_SCHEMA)
            _migrate_legacy_schema(_conn)
            _sync_builtin_docs()
            # .lock 存在 → 已初始化过，不再跑种子（避免覆盖用户的库内编辑）。
            # 技能词条与技能文档共用这一个标记：删库重建时一并联动的只有它。
            if not _lock_path().exists():
                try:
                    _seed_builtin()
                    _seed_skill_docs()
                    _conn.commit()
                    _lock_path().write_text(
                        f"initialized {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
                        "delete this file to re-run install seeding\n",
                        encoding="utf-8",
                    )
                    log.info("[SPA] skill dict initialized -> %s", _lock_path())
                except Exception:
                    _conn.rollback()
                    log.warning("[SPA] skill dict seed failed", exc_info=True)
        return _conn


def _seed_builtin() -> None:
    """install/skill_seed.py 的内置类别 + 技能写入（key 唯一，存在即跳过）。"""
    conn = _connect()
    for sort, cat in enumerate(build_builtin_categories()):
        cur = conn.execute("SELECT id FROM skill_categories WHERE name=?", (cat["name"],))
        row = cur.fetchone()
        if row is None:
            cur = conn.execute(
                "INSERT INTO skill_categories(name, description, sort, render_mode)"
                " VALUES(?,?,?,?)",
                (cat["name"], cat.get("description") or "", sort,
                 cat.get("render_mode") or "descriptive"),
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
                "INSERT OR IGNORE INTO skills(category_id, key, name, name_en, desc,"
                " examples, group_name, builtin, created_at) VALUES(?,?,?,?,?,?,?,1,?)",
                (cat_id, s["key"], s["name"], s.get("name_en") or "", s.get("desc") or "",
                 json.dumps(s.get("examples") or [], ensure_ascii=False),
                 s.get("group_name") or "", int(time.time() * 1000)),
            )


# ---------------- 查询 ----------------

def list_all() -> dict:
    with _lock:
        conn = _connect()
        cats = [
            {
                "id": int(r["id"]),
                "name": r["name"],
                "description": r["description"],
                "sort": int(r["sort"]),
                "renderMode": r["render_mode"] or "descriptive",
            }
            for r in conn.execute(
                "SELECT id, name, description, sort, render_mode"
                " FROM skill_categories ORDER BY sort, id")
        ]
        skills = [
            {
                "id": int(r["id"]),
                "categoryId": int(r["category_id"]),
                "name": r["name"],
                "key": r["key"],
                "nameEn": r["name_en"],
                "desc": r["desc"],
                "examples": _parse_examples(r["examples"]),
                "groupName": r["group_name"],
                "builtin": bool(r["builtin"]),
            }
            for r in conn.execute("SELECT * FROM skills ORDER BY id")
        ]
        return {"categories": cats, "skills": skills}


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


def _category_row(conn: sqlite3.Connection, cat_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT id, name, description, sort, render_mode"
        " FROM skill_categories WHERE id=?", (cat_id,)
    ).fetchone()


def _validate_by_category(cat: dict, name_en: str, examples: list[str], desc: str = "") -> None:
    """按类别注入方式（render_mode）校验新增/编辑字段。

    camera / example / block 需要内容型字段，term 需要英文写法；
    descriptive 只要求名称（名称在调用方校验）。类别名不做判断，新增类别无需改代码。
    """
    cat_name = cat.get("name") or ""
    mode = cat.get("render_mode") or "descriptive"
    rule = _RENDER_MODE_RULES.get(mode) or _RENDER_MODE_RULES["descriptive"]
    if rule.get("name_en") and not name_en:
        raise ValueError(f"类别「{cat_name}」为术语型（term），必须填写英文写法 name_en")
    if mode == "block":
        if not (desc.strip() or examples):
            raise ValueError(f"类别「{cat_name}」为片段型（block），必须填写描述或内容片段")
        return
    label = rule.get("examples_label")
    if label and not examples:
        raise ValueError(f"类别「{cat_name}」必须填写{label}")


def add_skill(payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("技能名称不能为空")
    cat_id = int(payload.get("categoryId") or payload.get("category_id") or 0)
    with _lock:
        conn = _connect()
        cat_row = _category_row(conn, cat_id)
        if cat_row is None:
            raise ValueError(f"技能类别不存在：{cat_id}")
        name_en = str(payload.get("nameEn") or payload.get("name_en") or "").strip()
        desc = str(payload.get("desc") or "").strip()
        examples = _normalize_examples(payload.get("examples"))
        _validate_by_category(dict(cat_row), name_en, examples, desc)
        key = str(payload.get("key") or "").strip().lower() or _gen_key(name, conn)
        if not _KEY_RE.match(key):
            raise ValueError(f"非法 key：{key}（仅允许小写字母/数字/下划线）")
        if conn.execute("SELECT 1 FROM skills WHERE key=?", (key,)).fetchone():
            raise ValueError(f"key 已存在：{key}")
        cur = conn.execute(
            "INSERT INTO skills(category_id, key, name, name_en, desc, examples,"
            " group_name, builtin, created_at) VALUES(?,?,?,?,?,?,?,'0',?)",
            (cat_id, key, name, name_en, desc,
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
            "group_name": str(payload.get("groupName") if payload.get("groupName") is not None
                              else row["group_name"]),
        }
        if payload.get("examples") is not None:
            examples = _normalize_examples(payload.get("examples"))
        else:
            examples = _parse_examples(row["examples"])
        if not fields["name"]:
            raise ValueError("技能名称不能为空")
        cat_row = _category_row(conn, int(row["category_id"]))
        if cat_row is None:
            raise ValueError("技能所属类别已不存在，请先重建类别")
        _validate_by_category(dict(cat_row), fields["name_en"], examples, fields["desc"])
        # key 与 builtin 不可改（内置 key 与生成链路一一对应）
        conn.execute(
            "UPDATE skills SET name=?, name_en=?, desc=?, examples=?, group_name=?"
            " WHERE id=?",
            (fields["name"], fields["name_en"], fields["desc"],
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
            raise ValueError("内置技能不可删除（可修改其名称/英文写法/描述/示例）")
        conn.execute("DELETE FROM skills WHERE id=?", (skill_id,))
        conn.commit()
        return {"id": skill_id}


def _normalize_render_mode(value) -> str:
    mode = str(value or "descriptive").strip().lower()
    if mode not in RENDER_MODES:
        raise ValueError(f"未知注入方式：{mode}（可选：{', '.join(RENDER_MODES)}）")
    return mode


def add_category(payload: dict) -> dict:
    """新增类别（自定义技能分组用）：名称 + 注入方式。"""
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("类别名称不能为空")
    mode = _normalize_render_mode(
        payload.get("renderMode") if payload.get("renderMode") is not None
        else payload.get("render_mode"))
    with _lock:
        conn = _connect()
        if conn.execute("SELECT 1 FROM skill_categories WHERE name=?", (name,)).fetchone():
            raise ValueError(f"类别已存在：{name}")
        cur = conn.execute(
            "INSERT INTO skill_categories(name, description, sort, render_mode)"
            " VALUES(?,?,?,?)",
            (name, str(payload.get("description") or ""), int(payload.get("sort") or 99),
             mode),
        )
        conn.commit()
        return {"id": int(cur.lastrowid or 0), "name": name, "renderMode": mode}


def update_category(payload: dict) -> dict:
    """编辑类别：描述 / 注入方式 / 排序（内置类别名称不可改）。"""
    cat_id = int(payload.get("id") or 0)
    if not cat_id:
        raise ValueError("缺少类别 id")
    with _lock:
        conn = _connect()
        row = _category_row(conn, cat_id)
        if row is None:
            raise ValueError(f"类别不存在：{cat_id}")
        name = str(payload.get("name") or row["name"]).strip()
        if not name:
            raise ValueError("类别名称不能为空")
        if name != row["name"]:
            if row["name"] in BUILTIN_CATEGORY_RENDER:
                raise ValueError("内置类别不可重命名（分镜选择按类别名存储）")
            if conn.execute("SELECT 1 FROM skill_categories WHERE name=?", (name,)).fetchone():
                raise ValueError(f"类别已存在：{name}")
        mode = _normalize_render_mode(
            payload.get("renderMode") if payload.get("renderMode") is not None
            else (payload.get("render_mode") if payload.get("render_mode") is not None
                  else row["render_mode"]))
        desc = str(payload.get("description") if payload.get("description") is not None
                   else row["description"])
        sort = int(payload.get("sort") if payload.get("sort") is not None else row["sort"])
        conn.execute(
            "UPDATE skill_categories SET name=?, description=?, sort=?, render_mode=?"
            " WHERE id=?",
            (name, desc, sort, mode, cat_id),
        )
        conn.commit()
        return {"id": cat_id, "name": name, "renderMode": mode}


BATCH_ADD_MAX = 200  # 单次批量导入上限（超出提示分批，避免一次性长事务）


def batch_add_skills(payload: dict) -> dict:
    """批量导入技能词条。

    payload: { categoryId?: int, newCategory?: str,
               items: [ {name, nameEn?, desc?, examples?, key?} ] }
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


# ---------------- 技能文档（md 提示词模板） ----------------

def _norm_doc_category(value) -> str:
    category = str(value or "").strip()
    if category not in DOC_CATEGORIES:
        raise ValueError(f"未知分类：{category or '(空)'}（可选：{' / '.join(DOC_CATEGORIES)}）")
    return category


def _doc_summary(content: str, limit: int = 120) -> str:
    """取正文首段摘要（去 md 标记，列表接口不返回全文）。"""
    for line in str(content or "").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("```"):
            continue
        s = re.sub(r"^[>\-*\d.\s]+", "", s)
        if s:
            return s[:limit]
    return ""


def _doc_row_dict(row: sqlite3.Row, with_content: bool = True) -> dict:
    data = {
        "id": int(row["id"]),
        "category": row["category"],
        "title": row["title"],
        "builtinKey": row["builtin_key"],
        "builtin": bool(row["builtin"]),
        "sort": int(row["sort"]),
        "updatedAt": int(row["updated_at"] or 0),
        "summary": _doc_summary(row["content"]),
    }
    if with_content:
        data["content"] = row["content"]
        data["createdAt"] = int(row["created_at"] or 0)
    return data


def list_docs(category: str = "") -> dict:
    """技能文档列表：不做分类过滤时返回全部（按分类 + sort + id 排序）。"""
    cat = _norm_doc_category(category) if str(category or "").strip() else ""
    with _lock:
        conn = _connect()
        if cat:
            rows = conn.execute(
                "SELECT * FROM skill_docs WHERE category=? ORDER BY sort, id", (cat,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM skill_docs ORDER BY category, sort, id"
            ).fetchall()
        counts = {c: 0 for c in DOC_CATEGORIES}
        for r in conn.execute("SELECT category, COUNT(*) AS n FROM skill_docs GROUP BY category"):
            if r["category"] in counts:
                counts[r["category"]] = int(r["n"])
        return {
            "categories": list(DOC_CATEGORIES),
            "counts": counts,
            "docs": [_doc_row_dict(r, with_content=False) for r in rows],
        }


def get_doc(doc_id: int = 0, key: str = "") -> dict:
    """按 id 或内置 key 取文档全文。

    key 在 DB 中不存在时回落 resources/skills/<key>/prompt.md（保证导入流水线
    即使用户删了文档也不断链）。
    """
    doc_id = int(doc_id or 0)
    key = str(key or "").strip()
    if not doc_id and not key:
        raise ValueError("缺少文档 id 或 key")
    with _lock:
        conn = _connect()
        row = None
        if doc_id:
            row = conn.execute("SELECT * FROM skill_docs WHERE id=?", (doc_id,)).fetchone()
        elif key:
            row = conn.execute(
                "SELECT * FROM skill_docs WHERE builtin_key=?", (key,)
            ).fetchone()
        if row is not None:
            return _doc_row_dict(row)
    if key:
        meta = _RESOURCE_DOCS.get(key)
        md = _resource_doc_path(key)
        if md.is_file():
            return {
                "id": 0,
                "category": (meta or ("分镜设计", ""))[0],
                "title": (meta or ("", key))[1] or key,
                "builtinKey": key,
                "builtin": True,
                "sort": 0,
                "updatedAt": 0,
                "summary": "",
                "content": md.read_text(encoding="utf-8-sig"),
                "createdAt": 0,
                "fromFile": True,
            }
    raise ValueError(f"文档不存在：{doc_id or key}")


def add_doc(payload: dict) -> dict:
    category = _norm_doc_category(payload.get("category"))
    title = str(payload.get("title") or "").strip()
    if not title:
        raise ValueError("技能标题不能为空")
    content = str(payload.get("content") or "")
    now = int(time.time() * 1000)
    with _lock:
        conn = _connect()
        if conn.execute(
            "SELECT 1 FROM skill_docs WHERE category=? AND title=?", (category, title)
        ).fetchone():
            raise ValueError(f"该分类下已存在同名文档：{title}")
        cur = conn.execute(
            "INSERT INTO skill_docs(category, title, content, builtin_key, builtin, sort,"
            " created_at, updated_at) VALUES(?,?,?,'',0,?,?,?)",
            (category, title, content, int(payload.get("sort") or 999), now, now),
        )
        conn.commit()
        return {"id": int(cur.lastrowid or 0), "category": category, "title": title}


def update_doc(payload: dict) -> dict:
    doc_id = int(payload.get("id") or 0)
    if not doc_id:
        raise ValueError("缺少文档 id")
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT * FROM skill_docs WHERE id=?", (doc_id,)).fetchone()
        if row is None:
            raise ValueError(f"文档不存在：{doc_id}")
        category = _norm_doc_category(
            payload.get("category") if payload.get("category") is not None else row["category"]
        )
        title = str(payload.get("title") if payload.get("title") is not None
                    else row["title"]).strip()
        if not title:
            raise ValueError("技能标题不能为空")
        content = str(payload.get("content") if payload.get("content") is not None
                      else row["content"])
        if (category, title) != (row["category"], row["title"]):
            if conn.execute(
                "SELECT 1 FROM skill_docs WHERE category=? AND title=? AND id<>?",
                (category, title, doc_id),
            ).fetchone():
                raise ValueError(f"该分类下已存在同名文档：{title}")
        conn.execute(
            "UPDATE skill_docs SET category=?, title=?, content=?, updated_at=? WHERE id=?",
            (category, title, content, int(time.time() * 1000), doc_id),
        )
        conn.commit()
        return {"id": doc_id, "category": category, "title": title}


def delete_doc(payload: dict) -> dict:
    doc_id = int(payload.get("id") or 0)
    if not doc_id:
        raise ValueError("缺少文档 id")
    with _lock:
        conn = _connect()
        if not conn.execute("SELECT 1 FROM skill_docs WHERE id=?", (doc_id,)).fetchone():
            raise ValueError(f"文档不存在：{doc_id}")
        conn.execute("DELETE FROM skill_docs WHERE id=?", (doc_id,))
        conn.commit()
        return {"id": doc_id}


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
