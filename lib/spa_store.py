"""SPA 导演台状态的落盘存储。

目录结构（对齐 api_config.py 的 user/default/MiniMaxRefDirector 布局）：
    user/default/MiniMaxRefDirector/
        spa/state/{director_node_id}.json   # 每个导演节点一份暂存状态

写入全部走 tmp + os.replace 原子替换，进程内加锁串行化。
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from pathlib import Path
from typing import Any

import folder_paths

log = logging.getLogger(__name__)

_lock = threading.Lock()

# node_id 只允许字母数字与少量分隔符，防止路径穿越
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,128}$")


def _spa_dir() -> Path:
    user_dir = Path(folder_paths.get_user_directory())
    cfg_dir = user_dir / "default" / "MiniMaxRefDirector" / "spa"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    return cfg_dir


def _state_path(node_id: str) -> Path:
    if not _SAFE_ID_RE.match(str(node_id or "")):
        raise ValueError(f"invalid node_id: {node_id!r}")
    return _spa_dir() / "state" / f"{node_id}.json"


def _atomic_write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def load_state(node_id: str) -> dict | None:
    """读取某导演节点的暂存状态；不存在返回 None。"""
    with _lock:
        p = _state_path(node_id)
        if not p.is_file():
            return None
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            log.warning("[SPA] failed to load state %s", p, exc_info=True)
            return None


def save_state(node_id: str, state: dict) -> dict:
    """保存状态（原子替换），自动补 node_id / updated_at。"""
    state = dict(state or {})
    state["node_id"] = str(node_id)
    state.setdefault("updated_at", _now_ms())
    with _lock:
        _atomic_write(_state_path(node_id), state)
    return state


def delete_state(node_id: str) -> None:
    with _lock:
        try:
            _state_path(node_id).unlink(missing_ok=True)
        except Exception:
            log.warning("[SPA] failed to delete state for %s", node_id, exc_info=True)


def _now_ms() -> int:
    import time
    return int(time.time() * 1000)
