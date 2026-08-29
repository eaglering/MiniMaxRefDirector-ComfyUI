"""MiniMaxRefCombine — 视频合并/保存节点（像素 + latent 双路径）。

- 像素路径：把 VAEDecode 的 IMAGE 帧与可选 AUDIO（audio 输入）合并编码为视频
  文件（原行为）。
- latent 路径：提供 latent 时启用。clip_audio 连接时把 joint H3 latent
  （视频+音频 NestedTensor）保存为 image_latent safetensors + sidecar meta +
  clip_audio wav（无损合并素材，音频统一走 clip_audio，不再保存 audio_latent），
  并以 clip_audio 为音轨；否则音轨按 audio 输入 → audio_vae 解码 latent 音频流
  兜底。视频帧：直接提供 images 时跳过 VAE 解码，否则用 video_vae 解码。

两条路径均输出 VHS_FILENAMES 4 元组 (filename, subfolder, type, full_path)，
与 guide.py ``_vhs_tuple_path`` 的解析约定一致，可直连 Guide 的 prev_tail。

实际编码逻辑复用 lib.video_combine.encode_frames_with_vhs：
优先调用 VideoHelperSuite 的 VideoCombine（完整支持 AUDIO / metadata /
多种容器格式），VHS 未安装或编码失败时回退到本地 ffmpeg（不含音频）。

latent 路径执行后通过 send_sync("minimax_ref_video_progress") 通知前端
（status="add_material"），携带视频路径 + image_latent/clip_audio 路径，
供素材条「无损合并」使用。
"""

import logging

from comfy_api.latest import io

from .lib import latent as latent_lib
from .lib.path import to_single_filename
from .lib.video_combine import (
    VIDEO_FORMATS,
    build_vhs_filenames,
    encode_frames_with_vhs,
)
from .guide import _send_progress

log = logging.getLogger(__name__)


def _trim_images_and_audio(images, audio, trim_frames, frame_rate):
    """帧头裁剪 + 按帧率同步裁音频头 + 音频过短跳过警告（像素路径原逻辑）。

    trim_frames 从解码帧头部裁掉 motion context 引导帧，并按帧率同步裁掉
    音频头部，保持 A/V 对齐。音频比裁剪窗口还短时跳过音频裁剪（避免负长度），
    帧数不足时跳过帧裁剪并告警。返回 (images, audio)。
    """
    if trim_frames > 0:
        if images is not None and int(images.shape[0]) > trim_frames:
            images = images[trim_frames:]
            if audio is not None:
                wave = audio["waveform"]
                sr = int(audio["sample_rate"])
                n = int(round(trim_frames / float(frame_rate) * sr))
                if wave.shape[-1] > n:
                    audio = {"waveform": wave[..., n:], "sample_rate": sr}
                else:
                    log.warning(
                        "trim_frames=%d: audio shorter than trim window "
                        "(%d samples); skip audio trim", trim_frames, int(wave.shape[-1]),
                    )
        else:
            have = 0 if images is None else int(images.shape[0])
            log.warning(
                "trim_frames=%d >= available frames %d; skip frame trim",
                trim_frames, have,
            )
    return images, audio


class MiniMaxRefCombine(io.ComfyNode):
    """合并解码后的 IMAGE 帧或 joint H3 latent 并保存，输出 VHS_FILENAMES。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MiniMaxRefCombine",
            display_name="MiniMax Ref Combine",
            category="minimaxrefdirector",
            description=(
                "双路径合并/保存节点。\n"
                "· 像素路径：IMAGE 帧（VAEDecode）+ 可选 AUDIO（audio 输入）→ VHS "
                "视频（原行为）。\n"
                "· latent 路径：提供 latent 时启用。clip_audio 连接时保存无损合并素材"
                "（image_latent + meta + clip_audio wav）并以 clip_audio "
                "为音轨；否则音轨按 audio 输入 → audio_vae 解码 latent 音频流兜底。"
                "视频帧：直接提供 images 时跳过 VAE 解码，否则用 video_vae 解码。\n"
                "输出 VHS_FILENAMES 供 MiniMaxRefGuide 的 prev_tail 输入使用。"
            ),
            inputs=[
                io.Image.Input(
                    "images",
                    optional=True,
                    tooltip="视频帧 [B,H,W,C]，通常来自 VAEDecode。与 latent 二选一。",
                ),
                io.Audio.Input(
                    "audio",
                    optional=True,
                    tooltip="可选音频轨。latent 路径下作为 clip_audio 之外的备用音轨"
                            "（用于预览视频）；像素路径下作为视频音轨。",
                ),
                io.Audio.Input(
                    "clip_audio",
                    optional=True,
                    tooltip="可选音频轨（本段分割音频，保真）。latent 路径下作为无损"
                            "合并素材音轨：连接时保存 image_latent + meta + clip_audio "
                            "wav，并优先作为 latent 路径音轨。",
                ),
                io.Latent.Input(
                    "latent",
                    optional=True,
                    tooltip="joint H3 latent（视频+音频 NestedTensor）。提供时走 latent 路径，"
                            "否则走像素路径。",
                ),
                io.Vae.Input(
                    "video_vae",
                    optional=True,
                    tooltip="视频 VAE：latent 路径下解码视频帧并编码视频。",
                ),
                io.Vae.Input(
                    "audio_vae",
                    optional=True,
                    tooltip="音频 VAE：latent 路径下无 clip_audio 且无 audio 输入时，"
                            "把 latent 音频流解码为音轨（VAE 重建有损，兜底用）。",
                ),
                io.Int.Input(
                    "context_frames",
                    default=39,
                    min=0,
                    step=17,
                    tooltip="该段的 context 引导帧数（H3 run 网格 5/22/39/56/...；"
                            "AV 对齐建议 39/90/141）。接 MiniMax Ref Guide 的 "
                            "context_frames 输出时自动取该段实际值；0 表示无 context。"
                            "写入 meta 供无损合并使用。",
                ),
                io.Int.Input(
                    "trim_frames",
                    default=0,
                    min=0,
                    step=1,
                    tooltip="像素路径下从解码帧头部裁掉的 motion context 引导帧数"
                            "（接 MiniMax Ref Guide 的 trim_frames 输出），并按帧率"
                            "同步裁掉音频头部保持 A/V 对齐。latent 路径不裁（保留完整"
                            "帧供无损合并衔接），仅在 meta 中记录。",
                ),
                io.Float.Input(
                    "frame_rate",
                    default=24.0,
                    min=1.0,
                    step=0.1,
                    tooltip="输出帧率。",
                ),
                io.Int.Input(
                    "loop_count",
                    default=0,
                    min=0,
                    step=1,
                    tooltip="gif 输出循环次数（0 = 不循环）。",
                ),
                io.String.Input(
                    "filename_prefix",
                    default="MiniMaxRef/combine",
                    tooltip="输出文件名前缀。",
                ),
                io.Combo.Input(
                    "format",
                    options=VIDEO_FORMATS,
                    default="video/h264-mp4",
                    tooltip="容器 / 编码格式。",
                ),
            ],
            outputs=[
                io.String.Output(
                    "Filename",
                    tooltip=(
                        "单个 Filename（形如 subfolder/filename，subfolder 为空时仅文件名），"
                        "直连 MiniMaxRefGuide 的 prev_tail。"
                    ),
                ),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # 强制每次 forLoop 迭代都重新执行（帧内容 / filename_prefix 随迭代变化）。
        return float("NaN")

    @classmethod
    def execute(cls, images=None, audio=None, clip_audio=None, latent=None,
                video_vae=None, audio_vae=None, context_frames=39,
                trim_frames=0, frame_rate=24.0, loop_count=0,
                filename_prefix="MiniMaxRef/combine", format="video/h264-mp4"):
        # 通知前端（始终发送）：携带视频 + latent 文件路径 + clip_audio
        # （供素材条「无损合并」）；有 clip_audio 时带 image_latent/meta 素材字段。
        payload: dict = {"status": "add_material", "type": "video"}

        image_lat, audio_lat = None, None
        if latent is not None:
            image_lat, audio_lat = latent_lib.split_joint_latent(latent)
        
        if images is None:
            if image_lat is None:
                raise ValueError("images and latent are both None")
            if video_vae is None:
                raise ValueError("images and video_vae are both None")
            images = latent_lib.decode_video_latent(video_vae, image_lat)

        if clip_audio is not None and latent is not None and image_lat is not None and audio_lat is not None:
            meta_data = {
                "frame_count": int(image_lat.shape[2]),
                "context_frames": int(context_frames),
                "trim_frames": int(trim_frames),
                "fps": float(frame_rate),
                "width": int(image_lat.shape[4]),
                "height": int(image_lat.shape[3]),
                "audio_steps": int(audio_lat.shape[3]),
                "video_vae": (
                    latent_lib.vae_display_name(video_vae) if video_vae is not None else ""
                ),
            }
            saved = latent_lib.save_image_latent_files(latent, meta_data, filename_prefix)
            payload["image_latent"] = saved["image_path"]
            payload["meta_file"] = saved["meta_path"]
            payload["meta"] = meta_data
            # 同段素材的 latent / clip_audio 共享同一递增编号，防止不同段互相覆盖
            save_id = saved.get("save_id")
            audio = clip_audio
            try:
                payload["clip_audio"] = latent_lib.save_audio_clip(
                    clip_audio, filename_prefix, save_id=save_id
                )["path"]
            except Exception:
                log.warning("failed to save clip_audio wav", exc_info=True)


        if audio is None:
            if audio_lat is None:
                raise ValueError("audio and latent are both None")
            if audio_vae is None:
                raise ValueError("audio and audio_vae are both None")
            try:
                wave, sr = latent_lib.decode_audio_latent(audio_vae, audio_lat)
                # 解码结果过短（<0.5s）说明 latent 音频流为空/无效：视为无音轨，
                # 不输出假静音（让 VHS 不 mux 音频轨）。
                if wave is not None and wave.shape[-1] >= max(1, int(sr) // 2):
                    audio = {"waveform": wave, "sample_rate": sr}
                else:
                    log.info(
                        "[MiniMaxRefCombine] audio latent decode produced too-short "
                        "waveform (%s), treating as no audio track",
                        tuple(wave.shape) if wave is not None else None)
            except Exception:
                log.warning(
                    "[MiniMaxRefCombine] failed to decode audio latent, "
                    "skipping audio track", exc_info=True)
        if audio is not None:
            w = audio.get("waveform")
            try:
                rms = float(w.float().pow(2).mean().sqrt()) if w is not None else 0.0
            except Exception:
                rms = -1.0
            log.info("[MiniMaxRefCombine] audio track: waveform=%s sample_rate=%s rms=%.4f",
                     tuple(w.shape) if w is not None else None,
                     audio.get("sample_rate"), rms)

        meta = encode_frames_with_vhs(
            images=images,
            audio=audio,
            frame_rate=frame_rate,
            loop_count=loop_count,
            filename_prefix=filename_prefix,
            format=format,
        )
        filenames = build_vhs_filenames(meta)
        filename = to_single_filename(filenames)
        ui = meta["ui"]

        if filenames is not None:
            payload["imageFile"] = filename

        # 诊断：记录发送的 payload 与执行上下文 node_id（排查第二条素材缺 latent）
        try:
            from comfy_execution.utils import get_executing_context
            _notify_ctx_node = getattr(get_executing_context(), "node_id", None)
        except Exception:
            _notify_ctx_node = None
        log.info(
            "[MiniMaxRefCombine] add_material send: imageFile=%s image_latent=%s "
            "clip_audio=%s ctx_node_id=%s",
            payload.get("imageFile"), payload.get("image_latent"),
            payload.get("clip_audio"), _notify_ctx_node,
        )
        _send_progress(payload)
        return io.NodeOutput(filename, ui=ui)


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefCombine": MiniMaxRefCombine,
}
