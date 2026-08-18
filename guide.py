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
- 当 prev_tail 传入（说明上一段视频已保存完成）时，通知前端把该视频加入素材条
  （status="add_material"，附带 VHS_FILENAMES / 路径 / VideoFromFile）。
- 当 guide_index 越界（>= len(timeline)，即 forLoop 多出的最后 1 轮，
  total = segment_count+1）时，只发送 add_material 通知并返回 ExecutionBlocker
  阻断采样链路，让 Easy-Use forLoop 正常结束（不抛异常）。
"""

import importlib.util
import logging
import os
import sys

import folder_paths
from comfy_api.latest import io
from comfy_execution.graph import ExecutionBlocker

from .lib.llm import unload_llama_models
from .lib.path import resolve_input_path

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


def _load_prev_tail_frames(prev_tail, max_frames=56):
    """解码上一段视频，截取尾部至多 max_frames 帧，供 motion context 使用。

    兼容三种输入：
    - str：本地路径（VHS VideoCombine 的 filename / 绝对路径）
    - tuple/list：VHS_FILENAMES（(filename, subfolder, type[, path])）
    - comfy_api VideoFromFile 对象（ComfyUI 0.33+ 视频输入自动转换）
    """
    try:
        if isinstance(prev_tail, VideoFromFile):
            frames = prev_tail.get_components().images  # [N, H, W, C]
        elif isinstance(prev_tail, (tuple, list)) and len(prev_tail) >= 1:
            # _vhs_tuple_path 在 get_annotated_filepath 解析失败时会退回原始相对路径，
            # 统一再走 resolve_input_path 兜底（input→output→temp），仍失败则明确告警。
            path = _vhs_tuple_path(prev_tail)
            resolved = resolve_input_path(path)
            if not resolved:
                log.warning(f"[MiniMaxRefGuide] prev_tail video not found: {path!r}")
                return None
            frames = VideoFromFile(resolved).get_components().images
        elif isinstance(prev_tail, str):
            # 兼容相对 output 目录的路径（如 VHS 输出 "subfolder/xx.mp4"）：
            # 直接交给 VideoFromFile 会按 CWD 解析导致 FileNotFoundError，
            # 先用 resolve_input_path（裸相对路径依次尝试 input→output→temp）转绝对路径。
            path = resolve_input_path(prev_tail)
            if not path:
                log.warning(f"[MiniMaxRefGuide] prev_tail video not found: {prev_tail!r}")
                return None
            frames = VideoFromFile(path).get_components().images
        else:
            log.warning(f"[MiniMaxRefGuide] unsupported prev_tail type: "
                        f"{type(prev_tail).__name__}")
            return None
    except Exception:
        log.warning(f"[MiniMaxRefGuide] failed to load prev_tail video {prev_tail!r}",
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
                "（prev_tail）传入时通知 director 前端把视频加入素材条；guide_index 越界"
                "（total=segment_count+1 的最后一轮）时仅发通知并阻断输出，正常结束循环。"
            ),
            inputs=[
                GuideData.Input("guide_data",
                                tooltip="MiniMaxRefDirector 输出的 guide_data。"),
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
                io.Int.Input("context_length", optional=True, default=22, min=0, step=1,
                    tooltip="尾帧参考帧数。"
                ),
                io.Int.Input("seed", optional=True, default=0, min=0, step=1,
                    tooltip="随机种子，透传给外部 KSampler 以复现每段生成；"
                    "本节点仅记录并在日志中展示。"),
                io.Int.Input("guide_index", optional=True, default=None, min=0, step=1,
                    tooltip="0-based 段索引，接 easy forLoopStart 的 index。"
                    "建议断开此输入，节点会自动按 guide_data 段顺序取段，"
                    "避免 Easy-Use 循环展开导致的 index 错乱（如 0,0,1）。"),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Latent.Output(display_name="latent"),
                io.Int.Output(display_name="trim_frames"),
                io.Float.Output(display_name="frame_rate"),
            ],
        )

    @classmethod
    def execute(cls, guide_data=None, model=None, clip=None, video_vae=None, 
                audio_vae=None, prev_tail=None, context_length=22, seed=None, 
                guide_index=None) -> io.NodeOutput:
        """按 guide_index 取段 → 条件编码 → 输出 positive/latent；并按 prev_tail/越界发送通知。

        guide_index 未连接（None）时自动按 timeline 段顺序取段（模块级计数器，
        以 id(guide_data) 键控，同一 prompt 内递增，跨 prompt 自动重置）。
        """
        if not isinstance(guide_data, dict) or not guide_data.get("timeline_data"):
            raise ValueError("[MiniMaxRefGuide] guide_data is required "
                             "(connect MiniMaxRefDirector's guide_data output).")

        timeline = guide_data.get("timeline_data", [])
        frame_rate = float(guide_data.get("frame_rate", 24))
        idx = int(guide_index)
        total = len(timeline)

        # 资源更新通知
        if prev_tail:
            _send_progress({
                "status": "add_material",
                "type": "video",
                "imageFile": prev_tail
            })

        # 越界轮：MiniMaxRefDirector 故意把 segment_count+1 接到 forLoopStart.total，
        # 多出的这一轮只用于在 prev_tail 传入时发送 add_material 通知（见上方）。
        # 这里返回 ExecutionBlocker 阻断采样链路，让 forLoop 正常结束而不抛异常。
        if idx >= total:
            log.info(
                f"[MiniMaxRefGuide] guide_index={idx} out of range (0..{total - 1}); "
                f"final notify-only iteration, blocking outputs to end the loop."
            )
            return io.NodeOutput(ExecutionBlocker(None), ExecutionBlocker(None),
                                 ExecutionBlocker(None), ExecutionBlocker(None))
        
        entry = timeline[idx]
        prompt = entry.get("prompt", "")
        width = int(guide_data.get("width", 1024))
        height = int(guide_data.get("height", 576))
        length = int(entry.get("durationFrames", 0))
        if length <= 0:
            raise ValueError(f"[MiniMaxRefGuide] segment {idx} has invalid durationFrames={length}.")

        images = entry.get("images") or []
        videos = entry.get("videos") or []
        audios = entry.get("audios") or []

        if clip is None:
            raise ValueError("[MiniMaxRefGuide] needs a CLIP input to encode positive conditioning.")
        if video_vae is None:
            raise ValueError("[MiniMaxRefGuide] needs a VIDEO_VAE input to prepare the latent.")

        log.info(f"[MiniMaxRefGuide] guide_index={idx} prompt={prompt} "
                 f"images={images} videos={videos} audios={audios} seed={seed}")

        unload_llama_models()
        # 基础条件：普通 refs（图片/视频/音频）Reference-to-video 编码
        cond, _neg_cond, latent, _frame_count = h3lib.build_segment_conditioning(
            clip, video_vae, audio_vae, prompt, width, height, length,
            images, videos, audios,
        )

        trim_frames: int = 0
        # 图片段 + imageFile：把静态图重复成 8 帧作为 motion context pinned 帧，
        # 让本段从该图开始运动（H3 节点会按 VAE 网格把帧数吸附到合法值，如 5 帧）。
        if entry.get("type") == "image" and entry.get("imageFile"):
            img_src = entry["imageFile"]
            if isinstance(img_src, (tuple, list)):  # VHS_FILENAMES 元组
                img_src = _vhs_tuple_path(img_src)
            img_frames = load_image_tensor(img_src)
            if img_frames is not None and img_frames.shape[0] >= 1:
                img_frames = img_frames.repeat(context_length, 1, 1, 1)  # [8, H, W, C]
                cond, trim_frames = _apply_motion_context(
                    cond, latent, video_vae, img_frames,
                    context_length=context_length, audio_vae=audio_vae,
                )
                log.info(f"[MiniMaxRefGuide] guide_index={idx} image motion context "
                         f"({img_frames.shape[0]} frames from {img_src})")
            else:
                log.warning(f"[MiniMaxRefGuide] guide_index={idx} image motion context "
                            f"skipped: failed to load image {img_src!r}")
        
        use_motion_context = False
        if entry.get("type") == "video" and entry.get("imageFile"):
            prev_tail = entry.get("imageFile")
            use_motion_context = True

        if entry.get("type") == "text" and entry.get("motionContext"):
            prev_tail = entry.get("prevImageFile") if not prev_tail else prev_tail
            use_motion_context = True

        # 文本段 + motionContext：用 prev_tail 视频，motion context 处理
        if use_motion_context and prev_tail:
            log.info(f"[MiniMaxRefGuide] guide_index={idx} prev_tail={prev_tail}")
            frames = _load_prev_tail_frames(prev_tail)
            if frames is not None and frames.shape[0] >= 1:
                cond, trim_frames = _apply_motion_context(
                    cond, latent, video_vae, frames,
                    context_length=context_length, audio_vae=audio_vae,
                )
                log.info(f"[MiniMaxRefGuide] guide_index={idx} prev_tail motion context "
                         f"({frames.shape[0]} frames)")
            else:
                log.warning(
                    f"[MiniMaxRefGuide] guide_index={idx} prev_tail motion context "
                    f"skipped: {prev_tail} could not be decoded")

        # 3) 其他段：不处理 prev_tail，直接输出普通条件
        return io.NodeOutput(cond, latent, trim_frames, frame_rate)
