"""MiniMaxRefDirectorSPA — SPA 导演台节点。

前端（js/spa-node.js）在节点体上挂「打开导演台」按钮：
- 目标由用户在下拉中选择（默认本节点），SPA 保存后回写所选节点的 timeline_data
  与全局参数 widget，同时落盘暂存（lib/spa_store.py）。

执行时输出与历史导演台（MiniMaxRefDirector）完全一致：
guide_data / segment_count / frame_rate / master_audio，
输入输出 schema 与执行逻辑均直接复用 director.py，保证行为一致。
timeline_data widget 为空时回退读取本节点的磁盘暂存状态（SPA 页保存即落盘）。
"""

import json
import logging

from comfy_api.latest import io

from .director import MiniMaxRefDirector, director_inputs, director_outputs
from .lib import spa_store

log = logging.getLogger(__name__)


def _executing_node_id() -> str:
    """当前正在执行的节点 id（用于定位本节点的磁盘暂存状态）。"""
    try:
        from comfy_execution.utils import get_executing_context
        ctx = get_executing_context()
        return str(getattr(ctx, "node_id", "")) if ctx is not None else ""
    except Exception:
        return ""


def _has_segments(timeline_data: str) -> bool:
    """timeline_data 里是否已有分镜段（执行前置校验）。"""
    if not (timeline_data or "").strip():
        return False
    try:
        t = json.loads(timeline_data) if isinstance(timeline_data, str) else timeline_data
        return bool(isinstance(t, dict) and (t.get("segments") or []))
    except Exception:
        return False


def _empty_timeline_message(nid: str) -> str:
    """空数据错误提示：附磁盘暂存概况，便于定位数据在哪个节点编号下。"""
    lines = []
    try:
        import folder_paths
        from pathlib import Path
        d = Path(folder_paths.get_user_directory()) / "default" / "MiniMaxRefDirector" / "spa" / "state"
        for p in sorted(d.glob("*.json")):
            try:
                st = json.loads(p.read_text(encoding="utf-8"))
                t = st.get("timeline_data")
                t = json.loads(t) if isinstance(t, str) else t
                seg = len((t or {}).get("segments") or [])
                upd = st.get("updated_at")
                import time as _t
                when = _t.strftime("%m-%d %H:%M", _t.localtime(upd / 1000)) if isinstance(upd, (int, float)) else "?"
                lines.append(f"#{st.get('node_id', p.stem)}：{seg} 段（更新于 {when}）")
            except Exception:
                continue
    except Exception:
        pass
    hint = f"（磁盘暂存概况：{'；'.join(lines) or '无'}）" if lines else ""
    return (
        f"[MiniMaxRefDirectorSPA] 节点 #{nid or '?'} 没有可执行的时间线数据。"
        "请在 SPA 节点上点「打开导演台」（下拉选择目标节点）编辑并保存，"
        f"确保数据保存在本节点编号下。{hint}"
    )


def _fallback_config(state: dict) -> dict | None:
    """从磁盘暂存状态构造 config（opts + subject_data + global_prompt）。

    SPA 节点的 config 输入未连接 Subject 节点时，subject_data 为空 →
    build_h3_subject_bindings 找不到任何主体名 → <@名字> 降级为裸文本、
    subject_definitions / retention_analysis 恒为空。与 timeline_data 兜底
    同思路：用暂存状态里的主体与 LLM 设置补齐执行所需配置。
    """
    subs = state.get("subjects") or {}
    if not (isinstance(subs, dict) and (subs.get("subjects") or [])):
        return None
    llm = state.get("llm") or {}
    opts = {
        "vlm_mode": str(llm.get("mode") or "llama-cpp"),
        "gguf_path": str(llm.get("gguf_path") or ""),
        "mmproj_path": str(llm.get("mmproj_path") or ""),
        "provider": str(llm.get("provider") or ""),
        "api_key": str(llm.get("api_key") or ""),
        "ollama_model": str(llm.get("ollama_model") or ""),
        "ollama_base_url": str(llm.get("ollama_base_url") or ""),
    }
    return {
        "opts": opts,
        "subject_data": subs,
        "global_prompt": str(state.get("global_prompt") or ""),
    }


class MiniMaxRefDirectorSPA(io.ComfyNode):
    """SPA 导演台节点：输入/输出与 MiniMaxRefDirector 严格一致（复用其执行逻辑）。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefDirectorSPA",
            display_name="MiniMax Director SPA",
            category="minimaxrefdirector",
            description=(
                "SPA-based timeline director. Edits land on the selected target node's "
                "widgets (default: this node). Outputs are identical to MiniMaxRefDirector: "
                "guide_data / segment_count / frame_rate / master_audio. "
                "Self-sufficient: timeline / subjects / LLM settings come from SPA saves "
                "(widgets + disk state); the config input is optional legacy wiring."
            ),
            inputs=director_inputs(),
            outputs=director_outputs(),
        )

    @classmethod
    def execute(cls, config=None,
                start_second=0.0, end_second=5.0, duration_seconds=5.0,
                start_frame=0, end_frame=120, duration_frames=120, timeline_data="",
                local_prompts="", segment_lengths="", frame_rate=24,
                display_mode="seconds", outpu_resolution="16:9横屏", million_pixels=0.6,
        ) -> io.NodeOutput:
        """直接复用历史导演台的执行逻辑，保证输出一致（含 master_audio 合成）。"""
        timeline_data = str(timeline_data or "")
        nid = _executing_node_id()
        state = None
        if not timeline_data.strip():
            # widget 为空 → 回退磁盘暂存（SPA 页保存必然落盘；widget 回写可能未到达，
            # 例如保存时 ComfyUI 页面未开，或工作流里刚替换的新节点尚未回写）
            if nid:
                state = spa_store.load_state(nid) or {}
                td = state.get("timeline_data")
                if td:
                    timeline_data = td if isinstance(td, str) else json.dumps(td, ensure_ascii=False)
                    log.info(
                        "[MiniMaxRefDirectorSPA] timeline_data widget 为空，已回退磁盘暂存状态（节点 #%s）",
                        nid,
                    )
            if not _has_segments(timeline_data):
                raise ValueError(_empty_timeline_message(nid))
        cfg_subj = ((config or {}).get("subject_data") or {}).get("subjects") if isinstance(config, dict) else None
        if not cfg_subj:
            # config 输入未连接 Subject 节点（或其 subject_data 为空）→ 主体数据 /
            # LLM 设置回退磁盘暂存。设计语义：SPA 节点自足——数据一律来自 SPA 保存
            # （本节点 widget / 磁盘暂存 / 镜像），不依赖 config 连线；混合工作流中
            # Subject 的 config 连接的是旧导演台节点，与 SPA 节点无关。
            # 否则 <@主体名> 全部找不到、subject_definitions / retention_analysis 恒为空。
            if state is None and nid:
                state = spa_store.load_state(nid) or {}
            fb = _fallback_config(state or {})
            if fb:
                config = fb
                log.info(
                    "[MiniMaxRefDirectorSPA] config 主体数据为空，已回退磁盘暂存的主体数据与 LLM 设置（节点 #%s）",
                    nid,
                )
        return MiniMaxRefDirector.execute(
            config=config,
            start_second=start_second, end_second=end_second,
            duration_seconds=duration_seconds,
            start_frame=start_frame, end_frame=end_frame,
            duration_frames=duration_frames,
            timeline_data=timeline_data,
            local_prompts=local_prompts,
            segment_lengths=segment_lengths,
            frame_rate=frame_rate,
            display_mode=display_mode,
            outpu_resolution=outpu_resolution,
            million_pixels=million_pixels,
        )
