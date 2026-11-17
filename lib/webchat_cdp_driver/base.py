"""BaseSiteDriver：站点驱动纯接口（不含任何具体实现）。

本模块只定义三站驱动必须遵守的契约：
- 抽象方法签名（每个站点驱动自己完整实现，互不共享代码）
- 通道级常量与数据形状（NO_SIGNAL_S / NOT_JSON_GRACE_S / sse_state / _CancelledError）

页面 JS、元素选择器、SSE 协议解析、会话/发送/读取流程全部在各站点驱动
（deepseek.py / doubao.py / qwen.py）内独立实现——修改某个站点的常量或选择器
不影响其他站点。新增站点：新建驱动文件继承本类实现全部抽象方法，
并在 __init__.py 注册。
"""

from __future__ import annotations

from typing import Any

# 通道级阈值（回复判定，与扩展 NO_SIGNAL_MS / 宽限一致；站点无关的行为契约）
NO_SIGNAL_S = 90.0        # 无任何回复信号快失败
NOT_JSON_GRACE_S = 20.0   # SSE 结束但正文不像 JSON 的宽限期
MAX_TEXT = 200_000        # SSE 文本累积上限（各驱动解析实现共用此上限）


class _CancelledError(RuntimeError):
    """内部哨兵：用户点「取消」时由驱动抛出，外壳 _complete 统一转为「已取消」。"""


def sse_state() -> dict[str, Any]:
    """SSE 累积状态的数据形状（外壳 _attach_sse 创建，驱动 get_reply 只读）。"""
    return {"active": False, "text": "", "done": False, "finished": False}


class BaseSiteDriver:
    """站点驱动接口。全部方法由各站点驱动独立实现。"""

    # SSE 回复解析器标识（本驱动的 parse_sse_body 实现协议；仅作说明用途）
    parse_mode: str = "generic"
    # 会话列表来源："sidebar"=UI 扫描侧栏；"ui"=页面元素扫描（历史保留说明）
    session_source: str = "sidebar"
    # 是否支持自动化删除会话
    supports_delete: bool = False

    def __init__(self, cfg: dict[str, Any]) -> None:
        self.cfg = cfg

    @property
    def site_id(self) -> str:
        return self.cfg["id"]

    @property
    def name(self) -> str:
        return self.cfg["name"]

    # ---- 抽象方法（每站点独立实现） ----

    async def inject_helpers(self, page: Any) -> None:
        """注入本站点页面 JS 助手（幂等；goto 重置页面上下文后需重新调用）。"""
        raise NotImplementedError

    def parse_sse_body(self, body: str, state: dict) -> None:
        """解析一段 SSE 文本，按本站点协议累积正文到 state。"""
        raise NotImplementedError

    async def open_session(self, mgr: Any, page: Any, chat_id: str = "") -> str:
        """打开会话（chat_id 空 = 首页/新会话）→ 返回当前 URL 解析出的 chat_id。"""
        raise NotImplementedError

    async def list_sessions(self, mgr: Any, page: Any) -> list:
        """获取会话列表 → [{id, title, updatedAt}]。"""
        raise NotImplementedError

    async def close_session(self, mgr: Any, page: Any, chat_id: str = "") -> dict:
        """删除会话（不支持时抛 RuntimeError 说明需手动管理）。"""
        raise NotImplementedError

    async def send_prompt(self, mgr: Any, page: Any, text: str, cancelled) -> dict:
        """发送消息（写入 + 提交 + 核验）→ get_reply 所需基线状态。失败/取消抛异常。"""
        raise NotImplementedError

    async def get_reply(
        self,
        mgr: Any,
        page: Any,
        baseline: dict,
        expect_json: bool,
        timeout_s: float,
        cancelled,
    ) -> dict:
        """获取消息 → {ok, text, chat_id, error}；取消抛 _CancelledError。"""
        raise NotImplementedError
