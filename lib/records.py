"""视频生成记录存储：生成 / 合并产物统一登记，供 SPA「视频生成记录」页展示。

落盘：user/default/MiniMaxRefDirector/video_records.json
    [{id, kind, created_at, video, image_latent, meta_file, meta, clip_audio,
      director_node_id, prompt_excerpt, duration_frames, fps, width, height, size}]

线程安全（threading.Lock），上限 2000 条自动裁剪（新记录插头部）。
所有公开函数不抛异常 —— 记录失败只 log.warning，绝不阻断视频编码主流程。
"""

from __future__ import annotations

import itertools
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import folder_paths

log = logging.getLogger(__name__)

MAX_RECORDS = 2000
_lock = threading.Lock()
_counter = itertools.count(1)


def _records_path() -> Path:
    user_dir = Path(folder_paths.get_user_directory())
    p = user_dir / "default" / "MiniMaxRefDirector" / "video_records.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _load_all_unlocked() -> list[dict]:
    p = _records_path()
    if not p.is_file():
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        log.warning("[Records] failed to load video_records.json", exc_info=True)
        return []


def _save_all_unlocked(records: list[dict]) -> None:
    p = _records_path()
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(records[:MAX_RECORDS], f, ensure_ascii=False)
    os.replace(tmp, p)


def append_record(record: dict) -> dict | None:
    """追加一条生成/合并记录。record 字段见模块 docstring；异常时仅告警。"""
    try:
        rec = dict(record or {})
        rec.setdefault("id", f"r{int(time.time() * 1000)}_{next(_counter)}")
        rec.setdefault("created_at", int(time.time() * 1000))
        with _lock:
            records = _load_all_unlocked()
            records.insert(0, rec)
            _save_all_unlocked(records)
        return rec
    except Exception:
        log.warning("[Records] append_record failed", exc_info=True)
        return None


def list_records(limit: int = 200, offset: int = 0) -> list[dict]:
    try:
        with _lock:
            records = _load_all_unlocked()
        return records[offset: offset + max(1, limit)]
    except Exception:
        log.warning("[Records] list_records failed", exc_info=True)
        return []


def delete_records(ids: list[str]) -> int:
    try:
        id_set = {str(i) for i in (ids or [])}
        with _lock:
            records = _load_all_unlocked()
            kept = [r for r in records if str(r.get("id")) not in id_set]
            removed = len(records) - len(kept)
            if removed:
                _save_all_unlocked(kept)
        return removed
    except Exception:
        log.warning("[Records] delete_records failed", exc_info=True)
        return 0


def build_record(kind: str, video_file: Any, *, image_latent: str = "",
                 meta_file: str = "", meta: dict | None = None,
                 clip_audio: str = "", director_node_id: str = "",
                 prompt_excerpt: str = "", duration_frames: int | None = None,
                 fps: float | None = None, width: int | None = None,
                 height: int | None = None, size: int | None = None) -> dict:
    """构造一条标准记录（不落盘），便于调用方补字段后统一 append。"""
    m = meta if isinstance(meta, dict) else {}
    return {
        "id": f"r{int(time.time() * 1000)}_{next(_counter)}_{uuid.uuid4().hex[:6]}",
        "kind": kind,  # generate | merge_video | merge_latent
        "created_at": int(time.time() * 1000),
        "video": video_file,  # {filename, subfolder, type} 或字符串路径
        "image_latent": image_latent,
        "meta_file": meta_file,
        "meta": m,
        "clip_audio": clip_audio,
        "director_node_id": director_node_id,
        "prompt_excerpt": (prompt_excerpt or "")[:200],
        "duration_frames": duration_frames if duration_frames is not None else m.get("frame_count"),
        "fps": fps if fps is not None else m.get("fps"),
        "width": width if width is not None else m.get("width"),
        "height": height if height is not None else m.get("height"),
        "size": size,
    }
