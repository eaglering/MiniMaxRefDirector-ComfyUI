"""MiniMaxRefGuide — per-segment 条件引导节点。

放在 Easy-Use forLoop 内使用：
- guide_data  ← MiniMaxRefDirector.guide_data
- guide_index ← easy forLoopStart 的 index（0-based）
- prev_tail   ← 上一段视频（VHS VideoCombine 的 Filenames 输出），实现跨段衔接

节点从 guide_data.timeline_data 中取出 guide_index 对应段，合并 MiniMax H3
Reference-to-video 功能（图片/视频/音频 refs + 上一段视频 prev_tail 作为参考视频），
输出 positive conditioning 与 latent，视频采样/解码/保存全部由外部节点完成
（KSampler → VAEDecode → VHS VideoCombine；model/clip/vae 由外部自行接入）。

通知机制（send_sync("minimax_ref_video_progress", ...)）：
- 当 prev_tail 传入（VHS_FILENAMES，说明上一段视频已保存完成）时，通知前端
  更新该段 video track（status="done"，附带上一段视频的 filename/subfolder/type）。
- 当 guide_index 越界（>= len(timeline)，即 forLoop 循环结束轮）时，发送
  status="exception" 通知并抛出异常，让 Easy-Use forLoop 结束循环。
"""

import logging
import os

import folder_paths
from comfy_api.latest import io
from comfy_execution.graph import ExecutionBlocker

from .lib import h3 as h3lib

log = logging.getLogger(__name__)

GuideData = io.Custom("GUIDE_DATA")
VhsFilenames = io.Custom("VHS_FILENAMES")
VhsFilename = io.Custom("VHS_FILENAME")


def _vhs_tuple_path(item):
    """(filename, subfolder, type[, path]) → 本地绝对路径。"""
    if len(item) >= 4 and item[3]:
        return item[3]
    filename = item[0]
    subfolder = item[1] if len(item) > 1 else ""
    ftype = item[2] if len(item) > 2 else "output"
    try:
        return folder_paths.get_annotated_filepath(filename, subfolder, ftype)
    except Exception:
        return filename


def _vhs_paths(prev_tail):
    """把 VHS_FILENAMES / VHS_FILENAME / 路径字符串解析为本地绝对路径列表。"""
    if not prev_tail:
        return []
    if isinstance(prev_tail, str):
        return [prev_tail]
    if isinstance(prev_tail, (list, tuple)):
        # VHS_FILENAMES: (bool_save_output, [full_paths])
        if len(prev_tail) == 2 and isinstance(prev_tail[0], bool) and isinstance(prev_tail[1], list):
            return [p for p in prev_tail[1] if isinstance(p, str)]
        # 纯字符串列表
        if prev_tail and isinstance(prev_tail[0], str):
            return list(prev_tail)
        # 每项是 (filename, subfolder, type[, path]) 元组
        paths = []
        for item in prev_tail:
            if isinstance(item, str):
                paths.append(item)
            elif isinstance(item, (list, tuple)):
                paths.append(_vhs_tuple_path(item))
        return paths
    if isinstance(prev_tail, (list, tuple)):
        return [_vhs_tuple_path(prev_tail)]
    return []


def _path_to_meta(path):
    """本地绝对路径 → (filename, subfolder, type)，用于前端展示链接。"""
    filename = os.path.basename(path)
    out_root = folder_paths.get_output_directory()
    try:
        subfolder = os.path.dirname(os.path.relpath(path, out_root))
    except Exception:
        subfolder = ""
    if subfolder == ".":
        subfolder = ""
    return {"filename": filename, "subfolder": subfolder, "type": "output"}


def _vhs_meta(prev_tail):
    """从 prev_tail 提取第一段视频的 (filename, subfolder, type)，无则返回 None。"""
    if not prev_tail:
        return None
    # VHS_FILENAMES: (bool_save_output, [full_paths])
    if isinstance(prev_tail, (list, tuple)) and len(prev_tail) == 2 \
            and isinstance(prev_tail[0], bool) and isinstance(prev_tail[1], list):
        for p in prev_tail[1]:
            if isinstance(p, str):
                return _path_to_meta(p)
        return None
    # VHS_FILENAME: (filename, subfolder, type[, path])
    if isinstance(prev_tail, (list, tuple)) and len(prev_tail) >= 3 \
            and all(isinstance(x, str) for x in prev_tail[:3]):
        return {"filename": prev_tail[0], "subfolder": prev_tail[1], "type": prev_tail[2]}
    # 裸路径字符串
    if isinstance(prev_tail, str):
        return _path_to_meta(prev_tail)
    return None


def _send_progress(payload):
    """send_sync 通知 director 前端更新 video track（失败仅告警，不影响执行）。"""
    try:
        from server import PromptServer
    except ImportError:
        from comfy_api.latest import server as _comfy_server
        PromptServer = _comfy_server.PromptServer
    try:
        PromptServer.instance.send_sync("minimax_ref_video_progress", payload)
    except Exception:
        log.warning("[MiniMaxRefGuide] failed to send progress notification", exc_info=True)


class MiniMaxRefGuide(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefGuide",
            display_name="MiniMax Ref Guide",
            category="minimaxrefdirector",
            description=(
                "按 guide_index 从 director 的 guide_data 中取一段，合并 MiniMax H3 "
                "Reference-to-video 功能构建 positive conditioning 与 latent。视频采样/解码/保存"
                "由你自己连接 KSampler → VAEDecode → VHS VideoCombine 完成（model/clip/vae 自行接入）。"
                "放在 Easy-Use forLoop 内，guide_index 接 forLoopStart 的 index；当上一段视频"
                "（prev_tail, VHS_FILENAMES）传入时通知 director 前端更新 video track；"
                "guide_index 越界时发送 exception 通知并抛异常结束循环。"
            ),
            inputs=[
                GuideData.Input("guide_data",
                                tooltip="MiniMaxRefDirector 输出的 guide_data。"),
                io.Int.Input("guide_index", default=0, min=0, step=1,
                             tooltip="0-based 段索引，接 easy forLoopStart 的 index。"),
                io.Model.Input("model", optional=True,
                               tooltip="采样模型（透传保留，供外部采样链路使用；sigma shift 请自行处理）。"),
                io.Clip.Input("clip", optional=True,
                              tooltip="条件编码必需（positive）。"),
                io.Vae.Input("video_vae", optional=True,
                             tooltip="latent 与参考视频编码必需。"),
                io.Vae.Input("audio_vae", optional=True,
                             tooltip="有参考音频时必需。"),
                io.MultiType.Input(
                    "prev_tail",
                    types=[VhsFilenames, VhsFilename],
                    optional=True,
                    tooltip="上一段生成完成的视频（VHS VideoCombine 的 Filenames 输出），作为参考视频实现跨段衔接；收到时通知前端该段完成。",
                ),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Latent.Output(display_name="latent"),
            ],
        )

    @classmethod
    def execute(cls, guide_data=None, guide_index=0, model=None, clip=None, video_vae=None,
                audio_vae=None, prev_tail=None) -> io.NodeOutput:
        """按 guide_index 取段 → 条件编码 → 输出 positive/latent；并按 prev_tail/越界发送通知。"""
        if not isinstance(guide_data, dict) or not guide_data.get("timeline_data"):
            raise ValueError("[MiniMaxRefGuide] guide_data is required "
                             "(connect MiniMaxRefDirector's guide_data output).")

        timeline = guide_data["timeline_data"]
        idx = int(guide_index)
        total = len(timeline)

        # 循环结束轮：guide_index 越界 → 发送 exception 通知并抛异常结束 Easy-Use forLoop
        if idx >= total:
            log.info(f"[MiniMaxRefGuide] guide_index={idx} >= {total} -> send exception, end loop")
            _send_progress({
                "seg_no": total,
                "total": total,
                "status": "exception",
                "message": "loop_end",
            })
            raise ValueError(
                f"[MiniMaxRefGuide] guide_index {idx} out of range (0..{total - 1}); "
                f"forLoop iteration end (seg_count={total + 1})."
            )

        entry = timeline[idx]

        # prev_tail 已传入（上一段视频保存完成）→ 通知前端更新 video track
        prev_paths = _vhs_paths(prev_tail)
        if prev_paths:
            meta = _vhs_meta(prev_tail) or {}
            _send_progress({
                "seg_no": idx,  # 上一段（0-based idx-1）的 1-based 编号
                "total": total,
                "status": "done",
                **meta,
            })
            log.info(f"[MiniMaxRefGuide] guide_index={idx} received prev_tail -> notify segment {idx} done")

        # 尾帧：阻断本轮迭代（等价于 forLoop continue，直接进入下一轮）
        if entry.get("is_end_frame"):
            log.info(f"[MiniMaxRefGuide] guide_index={idx} is an END frame -> skip iteration")
            return io.NodeOutput(*([ExecutionBlocker(None)] * 2))
        """
                        "prompt": prompt,
                "subjects": seg.get("subjects", ""),
                "images": seg.get("images", []),
                "audios": seg.get("audios", []),
                "videos": seg.get("videos", []),
                "duration_frames": dur,
                "type": seg.get("type", "text"),
                "imageFile": seg.get("imageFile", ""),
                "autoEndFrame": seg.get("autoEndFrame", False),
                "motionContext": seg.get("motionContext", False)
                """
        prompt = entry.get("prompt", "")
        width = int(guide_data.get("width", 1024))
        height = int(guide_data.get("height", 576))
        length = int(entry.get("duration_frames", 0))
        if length <= 0:
            raise ValueError(f"[MiniMaxRefGuide] segment {idx} has invalid duration_frames={length}.")

        images = entry.get("images") or []
        videos = entry.get("videos") or []
        audios = entry.get("audios") or []

        # prev_tail → 追加为参考视频（跨段衔接 / Reference to video）
        if prev_paths:
            videos = [*videos, *({"label": "prev_tail", "src": p} for p in prev_paths)]
            log.info(f"[MiniMaxRefGuide] guide_index={idx} appended prev_tail refs: {prev_paths}")

        if clip is None:
            raise ValueError("[MiniMaxRefGuide] needs a CLIP input to encode positive conditioning.")
        if video_vae is None:
            raise ValueError("[MiniMaxRefGuide] needs a VIDEO_VAE input to prepare the latent.")

        if entry.get("type") == "image" and entry.get("imageFile"):
            #将图片做成8帧视频
        # 使用motion context 处理
            return io.NodeOutput(None, None)
        cond, _neg_cond, latent, _frame_count = h3lib.build_segment_conditioning(
            clip, video_vae, audio_vae, prompt, width, height, length,
            images, videos, audios,
        )

        return io.NodeOutput(cond, latent)
