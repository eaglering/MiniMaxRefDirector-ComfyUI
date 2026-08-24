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
- 文本段（type=text 且 guideStrength > 0，即启用 motion context）：把上一段视频 prev_tail 的尾部帧作为
  motion context pinned 帧。
- 其他段不处理 prev_tail 视频。

通知机制（send_sync("minimax_ref_video_progress", ...)）：
- 当 prev_tail 传入（说明上一段视频已保存完成）时，通知前端把该视频加入素材条
  （status="add_material"，附带 VHS_FILENAMES / 路径 / VideoFromFile）。
- 当 guide_index 越界（>= len(timeline)，即 forLoop 多出的最后 1 轮，
  total = segment_count+1）时，只发送 add_material 通知并返回 ExecutionBlocker
  阻断采样链路，让 Easy-Use forLoop 正常结束（不抛异常）。
"""

import logging

import torch

from comfy_api.latest import io
from comfy_execution.graph import ExecutionBlocker

from .lib.llm import unload_llama_models
from .lib.motion_context import _apply_motion_context, _load_prev_tail_frames
from .lib.path import vhs_tuple_path
from .lib.song_audio import _get_song_audio_module, _snap_h3_run, _synthesize_master_audio

from .lib import h3 as h3lib
from .lib.image import load_image_tensor

log = logging.getLogger(__name__)

GuideData = io.Custom("GUIDE_DATA")
VhsFilenames = io.Custom("VHS_FILENAMES")
VhsFilename = io.Custom("VHS_FILENAME")

# guide_index 未连接时的自动取段计数器：{id(guide_data): next_index}
# Easy-Use forLoop 展开时，若循环体节点直接引用 forLoopStart 的输出，
# forLoopStart 会被复制进循环体并重新执行，导致 index 错乱（如 0,0,1,2）。
# 断开 guide_index 后由这里顺序取段，最可靠。
_guide_auto_index: dict = {}


def _send_progress(payload, director_node_id=None):
    """send_sync 通知 director 前端更新 video track（失败仅告警，不影响执行）。

    通知携带 director_node_id（由 Director 写入 guide_data["_director_node_id"]，
    调用方从 guide_data 取出后传入），前端 Director 组件据此精确过滤，
    避免 ComfyUI 工作台多 tab / 多节点同时监听同一事件时互相串收素材。
    """
    try:
        from server import PromptServer
    except ImportError:
        from comfy_api.latest import server as _comfy_server
        PromptServer = _comfy_server.PromptServer
    try:
        payload = dict(payload)
        if director_node_id is not None:
            payload["director_node_id"] = director_node_id
        else:
            # 兜底：旧版 guide_data（无 _director_node_id）时，附加当前执行节点 id
            # （Guide 节点 id），前端若无法匹配仍能拿到来源节点信息
            try:
                from comfy_execution.utils import get_executing_context
                ctx = get_executing_context()
                if ctx is not None and getattr(ctx, "node_id", None) is not None:
                    # forLoop 子图内执行时 node_id 是虚拟节点路径
                    # （如 "192.0.0.3.0.0.207"），归一为最后一段真实节点 id（"207"），
                    # 保证前端能按 graph 节点 id 匹配（否则子图内通知会被过滤丢弃）
                    raw_id = str(ctx.node_id)
                    payload["node_id"] = raw_id.rsplit(".", 1)[-1]
            except Exception:
                pass
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
                    tooltip="上一段生成完成的视频路径；文本段 guideStrength>0（启用 motion context）时作为 motion context 实现跨段衔接；收到时通知前端该段完成。",
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
                io.Boolean.Output(display_name="upscale"),
                io.Audio.Output(
                    display_name="clip_audio",
                    tooltip="H3 Song Masked Audio Context 从合成 master_audio 中按本段起始位置精确切出的音频片段（AUDIO）；无音频段时输出 None。",
                ),
                io.Int.Output(
                    display_name="context_frames",
                    tooltip="该段 H3 context 引导帧数（guideStrength 吸附到合法 H3 run 0/5/22/39/56...，"
                            "与 SongMaskedAVContext 的 context_length 一致）。接 MiniMax Ref Combine "
                            "的 context_frames 输入，供无损合并 meta 使用。",
                ),
            ],
        )

    @classmethod
    def execute(cls, guide_data=None, model=None, clip=None, video_vae=None, 
                audio_vae=None, prev_tail=None, seed=None, 
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
        idx = int(guide_index) if guide_index is not None else 0
        total = len(timeline)

        # 资源更新通知：把生成/合并的视频追加到对应 Director 前端素材条
        _director_id = guide_data.get("_director_node_id") if isinstance(guide_data, dict) else None
        if prev_tail:
            _send_progress({
                "status": "add_material",
                "type": "video",
                "imageFile": prev_tail
            }, director_node_id=_director_id)

        # 越界轮：MiniMaxRefDirector 故意把 segment_count+1 接到 forLoopStart.total，
        # 多出的这一轮只用于在 prev_tail 传入时发送 add_material 通知（见上方）。
        # 这里返回 ExecutionBlocker 阻断采样链路，让 forLoop 正常结束而不抛异常。
        if idx >= total:
            log.info(
                f"[MiniMaxRefGuide] guide_index={idx} out of range (0..{total - 1}); "
                f"final notify-only iteration, blocking outputs to end the loop."
            )
            return io.NodeOutput(ExecutionBlocker(None), ExecutionBlocker(None),
                                 ExecutionBlocker(None), ExecutionBlocker(None),
                                 ExecutionBlocker(None), ExecutionBlocker(None),
                                 ExecutionBlocker(None))
        
        entry = timeline[idx]
        upscale = entry.get("upscale", False)
        guide_strength = entry.get("guideStrength", 16)
        # 该段 H3 context 引导帧数（guideStrength 吸附到合法 H3 run 0/5/22/39/56...），
        # 同时作为 SongMaskedAVContext 的 context_length 与输出 context_frames 的值
        ctx_len = _snap_h3_run(guide_strength)
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

        try:
            unload_llama_models()
        except Exception as e:
            log.warning(f"[MiniMaxRefGuide] Failed to unload Llama models: {e}")

        # 基础条件：普通 refs（图片/视频/音频）Reference-to-video 编码
        cond, _neg_cond, latent, _frame_count = h3lib.build_segment_conditioning(
            clip, video_vae, audio_vae, prompt, width, height, length,
            images, videos, audios,
        )

        # H3 Song Masked Audio Context：把合成好的 master_audio（audioSegments 全片，
        # 含补白空白段）按本段起始位置精确切片写入 latent 音频流，并设置 noise_mask
        # （音频流全保护），返回 clip_audio。context_length 传 guideStrength 吸附后的
        # 合法 H3 run（0/5/22/39/56...）；视觉 pinned 帧仍由上方 motion context 路径负责。
        clip_audio = None
        if audio_vae is not None:
            master_audio = _synthesize_master_audio(guide_data)
            if master_audio is not None:
                try:
                    song_mod = _get_song_audio_module()
                    song_node = getattr(song_mod, "MiniMaxH3SongMaskedAVContext")
                    range_start = int(guide_data.get("range_start", 0))
                    seg_start_frames = int(entry.get("startFrames", 0))
                    clip_start_seconds = max(0.0,
                                             (seg_start_frames - range_start) / frame_rate)
                    latent, _song_trim, clip_audio = song_node().prepare(
                        latent, audio_vae, master_audio,
                        clip_start_seconds=clip_start_seconds,
                        context_length=ctx_len,
                        source_fps=frame_rate,
                        crop="disabled",
                    )
                    log.info(
                        f"[MiniMaxRefGuide] guide_index={idx} song masked audio context "
                        f"clip_start={clip_start_seconds:.3f}s context_length={ctx_len}")
                except Exception:
                    log.warning(
                        "[MiniMaxRefGuide] song masked audio context failed, "
                        "continuing without audio mask", exc_info=True)
                    clip_audio = None

        trim_frames: int = 0
        prev_is_video = False

        if entry.get("type") == "text":
            if prev_tail:
                prev_is_video = True
            elif entry.get("prevType") == "video":
                prev_tail = entry.get("prevImageFile", "")
                prev_is_video = True

        # 图片段 + imageFile：把静态图重复成 8 帧作为 motion context pinned 帧，
        # 让本段从该图开始运动（H3 节点会按 VAE 网格把帧数吸附到合法值，如 5 帧）。
        if entry.get("type") in ["text", "image", "video"] and entry.get("prevImageFile") and not prev_is_video:
            img_src = entry.get("prevImageFile")
            if isinstance(img_src, (tuple, list)):  # VHS_FILENAMES 元组
                img_src = vhs_tuple_path(img_src)
            img_frames = load_image_tensor(img_src)
            if img_frames is not None and img_frames.shape[0] >= 1:
                img_frames = img_frames.repeat(guide_strength, 1, 1, 1)  # [8, H, W, C]
                cond, trim_frames = _apply_motion_context(
                    cond, latent, video_vae, img_frames,
                    context_length=guide_strength, audio_vae=audio_vae,
                )
                log.info(f"[MiniMaxRefGuide] guide_index={idx} image motion context "
                         f"({img_frames.shape[0]} frames from {img_src})")
            else:
                log.warning(f"[MiniMaxRefGuide] guide_index={idx} image motion context "
                            f"skipped: failed to load image {img_src!r}")

        # 文本段 + guideStrength > 0（表示启用 motion context）：用 prev_tail 视频做跨段衔接
        if guide_strength > 0 and prev_tail and prev_is_video:
            log.info(f"[MiniMaxRefGuide] guide_index={idx} prev_tail={prev_tail}")
            frames = _load_prev_tail_frames(prev_tail)
            if frames is not None and frames.shape[0] >= 1:
                cond, trim_frames = _apply_motion_context(
                    cond, latent, video_vae, frames,
                    context_length=guide_strength, audio_vae=audio_vae,
                )
                log.info(f"[MiniMaxRefGuide] guide_index={idx} prev_tail motion context "
                         f"({frames.shape[0]} frames)")
            else:
                log.warning(
                    f"[MiniMaxRefGuide] guide_index={idx} prev_tail motion context "
                    f"skipped: {prev_tail} could not be decoded")

        return io.NodeOutput(cond, latent, trim_frames, frame_rate, upscale, clip_audio,
                             ctx_len)
