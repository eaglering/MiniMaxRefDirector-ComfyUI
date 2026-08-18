"""MiniMaxRefGuide — per-segment 条件引导节点。

放在 Easy-Use forLoop 内使用：
- guide_data  ← MiniMaxRefDirector.guide_data
- guide_index ← easy forLoopStart 的 index（0-based）
- prev_tail   ← 上一段视频（VHS VideoCombine 的 Filenames 输出），供 motion context 实现跨段衔接

节点从 guide_data.timeline_data 中取出 guide_index 对应段，合并 MiniMax H3
Reference-to-video 功能（图片/视频/音频 refs），输出 positive conditioning 与 latent，
视频采样/解码/保存全部由外部节点完成（KSampler → VAEDecode → VHS VideoCombine；
model/clip/vae 由外部自行接入）。

跨段衔接使用 H3 motion context（ComfyUI-H3-Motion-Context）：
- 图片段（type=image 且带 imageFile）：把图片做成 8 帧视频，作为 motion context
  pinned 帧（节点按 VAE 网格吸附到 5 帧）。
- 文本段（type=text 且开启 motionContext）：把上一段视频 prev_tail 的尾部帧作为
  motion context pinned 帧。
- 其他段不处理 prev_tail 视频。

通知机制（send_sync("minimax_ref_video_progress", ...)）：
- 当 prev_tail 传入（VHS_FILENAMES，说明上一段视频已保存完成）时，通知前端
  更新该段 video track（status="done"，附带上一段视频的 filename/subfolder/type）。
- 当 guide_index 越界（>= len(timeline)，即 forLoop 循环结束轮）时，发送
  status="exception" 通知并抛出异常，让 Easy-Use forLoop 结束循环。
"""

import importlib.util
import logging
import os
import sys

import folder_paths
from comfy_api.latest import io
from comfy_execution.graph import ExecutionBlocker

from .lib import h3 as h3lib
from .lib.image import load_image_tensor

try:
    from comfy_api.latest import VideoFromFile
except ImportError:  # pragma: no cover
    from comfy_api.latest._input_impl import VideoFromFile

log = logging.getLogger(__name__)

GuideData = io.Custom("GUIDE_DATA")
VhsFilenames = io.Custom("VHS_FILENAMES")
VhsFilename = io.Custom("VHS_FILENAME")

# guide_index 未连接时的自动取段计数器：{id(guide_data): next_index}
# Easy-Use forLoop 展开时，若循环体节点直接引用 forLoopStart 的输出，
# forLoopStart 会被复制进循环体并重新执行，导致 index 错乱（如 0,0,1,2）。
# 断开 guide_index 后由这里顺序取段，最可靠。
_guide_auto_index: dict = {}


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


# ---- H3 motion context 辅助（ComfyUI-H3-Motion-Context） -------------------

# 与 H3 motion context 节点一致的参数：VAE 编码时每 token 覆盖的像素帧数、
# 合法的 pinned 帧网格（节点会把 n 向下吸附到该网格）
_MC_FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
_MC_RUN_GRID = (124, 107, 90, 73, 56, 39, 22, 5, 1)


def _latent_video_capacity(latent):
    """段 latent 视频流实际覆盖的像素帧数（与 H3 motion context 的 frame_count 一致）。"""
    samples = latent.get("samples") if isinstance(latent, dict) else None
    if samples is None:
        return None
    if hasattr(samples, "unbind"):
        video = list(samples.unbind())[0]
    elif isinstance(samples, (tuple, list)):
        video = samples[0]
    else:
        return None
    if getattr(video, "ndim", 0) == 4:
        video = video.unsqueeze(0)
    latent_t = int(video.shape[2])
    return sum(_MC_FRAME_PER_TOKEN[k % 5] for k in range(latent_t))


def _safe_mc_frames(latent, requested, available):
    """在段 latent 覆盖帧数之内，取最接近 requested 的合法 motion context 帧数。

    H3 motion context 会把 n 向下吸附到 _MC_RUN_GRID，且要求 n < 段 latent 覆盖的
    像素帧数，否则会抛 "asked to pin ... frames into a ... frame clip"。
    """
    capacity = _latent_video_capacity(latent)
    n = min(int(requested), int(available))
    if capacity is None:
        return max(1, n)
    for g in _MC_RUN_GRID:  # 降序
        if g <= n and g < capacity:
            return g
    return 1  # 兜底：1 帧对任意合法 latent 均不越界


def _get_motion_context_module():
    """定位并返回 ComfyUI-H3-Motion-Context 的 nodes 模块（含 MiniMaxH3MotionContext）。

    ComfyUI 启动时会 import custom_nodes 下每个目录，因此该包（及其 nodes 子模块）
    通常已在 sys.modules 中。其 nodes.py 含相对导入（from .patch_layout ...），无法
    用 importlib 以单个文件方式加载，兜底按包加载以解析相对导入。
    """
    for mod in list(sys.modules.values()):
        f = getattr(mod, "__file__", None) or ""
        if "ComfyUI-H3-Motion-Context" in f.replace("\\", "/") \
                and hasattr(mod, "MiniMaxH3MotionContext"):
            return mod

    root = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                        "ComfyUI-H3-Motion-Context")
    if not os.path.isdir(root):
        raise RuntimeError(
            "[MiniMaxRefGuide] motion context requires ComfyUI-H3-Motion-Context. "
            "Clone https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context into "
            "custom_nodes and restart ComfyUI."
        )
    pkg_name = "ComfyUI-H3-Motion-Context"
    nodes_name = pkg_name + ".nodes"
    if nodes_name not in sys.modules:
        pkg_spec = importlib.util.spec_from_file_location(
            pkg_name, os.path.join(root, "__init__.py"))
        pkg = importlib.util.module_from_spec(pkg_spec)
        sys.modules[pkg_name] = pkg
        if pkg_spec.loader is not None:
            pkg_spec.loader.exec_module(pkg)
    mod = sys.modules.get(nodes_name)
    if mod is None or not hasattr(mod, "MiniMaxH3MotionContext"):
        raise RuntimeError(
            "[MiniMaxRefGuide] could not load MiniMaxH3MotionContext from "
            "ComfyUI-H3-Motion-Context. See the ComfyUI console for details."
        )
    return mod


def _load_prev_tail_frames(path, max_frames=56):
    """解码上一段视频，截取尾部至多 max_frames 帧，供 motion context 使用。"""
    try:
        frames = VideoFromFile(path).get_components().images  # [N, H, W, C]
    except Exception:
        log.warning(f"[MiniMaxRefGuide] failed to load prev_tail video {path!r}",
                    exc_info=True)
        return None
    if frames.shape[0] > max_frames:
        frames = frames[-max_frames:]
    return frames


def _apply_motion_context(cond, latent, video_vae, context_frames,
                          context_length, audio_vae=None):
    """对段条件叠加 H3 motion context：把 pinned 帧钉到段头部作为 keyframes。

    context_frames: [N, H, W, C] 帧序列，节点只取其中尾部 n 帧并按当前段分辨率
    重采样（像素路径，可跨分辨率）。返回 (cond, trim_frames)，trim_frames 是
    ANCHOR_MODE=head 时需从最终解码结果头部裁掉的帧数。
    """
    m = _get_motion_context_module()
    node = getattr(m, "MiniMaxH3MotionContext")
    n = _safe_mc_frames(latent, context_length, context_frames.shape[0])
    cond, trim = node().apply(
        cond, video_vae, latent, str(n),
        context_frames=context_frames,
        audio_vae=audio_vae,
    )
    return cond, trim


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
                io.Int.Input("guide_index", optional=True, default=None, min=0, step=1,
                             tooltip="0-based 段索引，接 easy forLoopStart 的 index。"
                             "建议断开此输入，节点会自动按 guide_data 段顺序取段，"
                             "避免 Easy-Use 循环展开导致的 index 错乱（如 0,0,1）。"),
                io.Int.Input("seed", default=-1, min=-1, step=1,
                             tooltip="采样种子（-1 表示随机）。传入后用于后续采样链路，实现跨段可复现。"),
                io.Model.Input("model", optional=True,
                               tooltip="采样模型（透传保留，供外部采样链路使用；sigma shift 请自行处理）。"),
                io.Clip.Input("clip", optional=True,
                              tooltip="条件编码必需（positive）。"),
                io.Vae.Input("video_vae", optional=True,
                             tooltip="latent 与参考视频编码必需。"),
                io.Vae.Input("audio_vae", optional=True,
                             tooltip="有参考音频时必需。"),
                io.String.Input(
                    "prev_tail",
                    optional=True,
                    tooltip="上一段生成完成的视频路径；文本段开启 motionContext 时作为 motion context 实现跨段衔接；收到时通知前端该段完成。",
                ),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Latent.Output(display_name="latent"),
                io.Float.Output(display_name="frame_rate"),
            ],
        )

    @classmethod
    def execute(cls, guide_data=None, guide_index=None, seed=-1, model=None, clip=None,
                video_vae=None, audio_vae=None, prev_tail=None) -> io.NodeOutput:
        """按 guide_index 取段 → 条件编码 → 输出 positive/latent；并按 prev_tail/越界发送通知。

        guide_index 未连接（None）时自动按 timeline 段顺序取段（模块级计数器，
        以 id(guide_data) 键控，同一 prompt 内递增，跨 prompt 自动重置）。
        """
        if not isinstance(guide_data, dict) or not guide_data.get("timeline_data"):
            raise ValueError("[MiniMaxRefGuide] guide_data is required "
                             "(connect MiniMaxRefDirector's guide_data output).")

        timeline = guide_data.get("timeline_data")
        frame_rate = float(guide_data["frame_rate"])
        idx = int(guide_index)
        total = len(timeline)

        # 防御：guide_index 越界。Director 的 segment_count 已输出精确段数，
        # 正常循环（total=段数）不会走到这里；触发说明 forLoop 接线/段数配置有误。
        if idx >= total:
            log.warning(f"[MiniMaxRefGuide] guide_index={idx} >= {total} -> out of range")
            # _send_progress({
            #     "seg_no": total,
            #     "total": total,
            #     "status": "exception",
            #     "message": "loop_end",
            # })
            raise ValueError(
                f"[MiniMaxRefGuide] guide_index {idx} out of range (0..{total - 1}); "
                f"check forLoopStart.total is connected to MiniMaxRefDirector's segment_count."
            )

        entry = timeline[idx]
        # prev_tail 已传入（上一段视频保存完成）→ 通知前端更新 video track
        if prev_tail:
            # meta = _vhs_meta(prev_tail) or {}
            # _send_progress({
            #     "seg_no": idx,  # 上一段（0-based idx-1）的 1-based 编号
            #     "total": total,
            #     "status": "done",
            #     **meta,
            # })
            log.info(f"[MiniMaxRefGuide] guide_index={idx} received prev_tail -> notify segment {idx} done")

        prompt = entry.get("prompt", "")
        width = int(guide_data.get("width", 1024))
        height = int(guide_data.get("height", 576))
        length = int(entry.get("duration_frames", 0))
        if length <= 0:
            raise ValueError(f"[MiniMaxRefGuide] segment {idx} has invalid duration_frames={length}.")

        images = entry.get("images") or []
        videos = entry.get("videos") or []
        audios = entry.get("audios") or []

        if clip is None:
            raise ValueError("[MiniMaxRefGuide] needs a CLIP input to encode positive conditioning.")
        if video_vae is None:
            raise ValueError("[MiniMaxRefGuide] needs a VIDEO_VAE input to prepare the latent.")

        log.info(f"[MiniMaxRefGuide] guide_index={idx} seed={seed} prompt={prompt} "
                 f"images={images} videos={videos} audios={audios}")

        # 基础条件：普通 refs（图片/视频/音频）Reference-to-video 编码
        cond, _neg_cond, latent, _frame_count = h3lib.build_segment_conditioning(
            clip, video_vae, audio_vae, prompt, width, height, length,
            images, videos, audios,
        )

        # 文本段 + motionContext：用 prev_tail 视频，motion context 处理
        if entry.get("type") == "text" and prev_tail and entry.get("motionContext"):
            frames = _load_prev_tail_frames(prev_tail)
            if frames is not None and frames.shape[0] >= 1:
                cond, _trim = _apply_motion_context(
                    cond, latent, video_vae, frames,
                    context_length="22", audio_vae=audio_vae,
                )
                log.info(f"[MiniMaxRefGuide] guide_index={idx} prev_tail motion context "
                         f"({frames.shape[0]} frames)")
            else:
                log.warning(
                    f"[MiniMaxRefGuide] guide_index={idx} prev_tail motion context "
                    f"skipped: {prev_tail} could not be decoded")

        # 3) 其他段：不处理 prev_tail，直接输出普通条件
        return io.NodeOutput(cond, latent, frame_rate)
