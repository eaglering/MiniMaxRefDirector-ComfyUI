"""网页会话站点驱动包（每站一文件）。

文件布局：
- shared.py      SSE 解析 + 纯函数助手（热重载阈值可调）
- pagescripts.py 页面侧 JS 常量（输入框定位/发送核对/会话扫描等）
- base.py        BaseSiteDriver 公共链路（打开会话/发送消息/获取消息/删除会话）
- deepseek.py    DeepSeek 驱动（站内 API 会话列表/删除）
- doubao.py      豆包驱动（侧栏锚点扫描；更多按钮 → Ctrl+D 删除）
- qwen.py        千问驱动（data-session-id 元素；UI 删除流程；可信键盘写入）

热重载（免重启 ComfyUI）：reload_drivers() 按依赖序重载全部模块并原地重建
注册表；spa_server 的 POST {API_PREFIX}/spa/webchat/reload 调用之。外壳
webchat_cdp.py 经 ``from . import webchat_cdp_driver as _driver_pkg`` 绑定
包对象（importlib.reload 原地更新，引用始终有效）。
"""

from __future__ import annotations

import importlib
import sys

from .base import BaseSiteDriver, _CancelledError  # noqa: F401

# 注册表：站点 id → 驱动类（reload_drivers 原地重建）
DRIVERS: dict[str, type[BaseSiteDriver]] = {}

# 重载顺序：shared/pagescripts（被 base/站点模块 import）→ base → 各站点
_SUBMODULES = ("shared", "pagescripts", "base", "deepseek", "doubao", "qwen")


def _rebuild_registry() -> None:
    # 先确保三个站点模块已导入（重启后未调用过 get_class 时它们不在 sys.modules，
    # 直接读 sys.modules 会 KeyError；相对导入兼容任意 __name__ 形式，
    # 例如 ComfyUI 以文件路径加载本包时 __name__ 为绝对路径而非 "lib.webchat_cdp_driver"）
    from . import deepseek, doubao, qwen  # noqa: F401
    DRIVERS.clear()
    DRIVERS["deepseek"] = sys.modules[f"{__name__}.deepseek"].DeepseekDriver
    DRIVERS["doubao"] = sys.modules[f"{__name__}.doubao"].DoubaoDriver
    DRIVERS["qwen"] = sys.modules[f"{__name__}.qwen"].QwenDriver


def _ensure_loaded() -> None:
    if not DRIVERS:
        _rebuild_registry()


def get_class(site_id: str) -> type[BaseSiteDriver]:
    """按站点 id 取驱动类（调用方传入 SITES 配置实例化）。"""
    _ensure_loaded()
    return DRIVERS[site_id]


def reload_drivers() -> list:
    """热重载全部驱动模块，返回重载的模块全名列表。"""
    # 未导入的子模块先补齐导入（避免重启后直接调 reload 漏掉站点模块）
    from . import deepseek, doubao, qwen  # noqa: F401
    reloaded = []
    for name in _SUBMODULES:
        full = f"{__name__}.{name}"
        mod = sys.modules.get(full)
        if mod is not None:
            importlib.reload(mod)
            reloaded.append(full)
    _rebuild_registry()
    return reloaded
