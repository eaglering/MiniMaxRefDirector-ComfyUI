"""MiniMaxRefCombine — 视频合并/保存节点（像素 + latent 双路径）。

- 像素路径：把 VAEDecode 的 IMAGE 帧与 VAEDecodeAudio 的 AUDIO 合并编码为
  视频文件（原行为）。
- latent 路径：把 joint H3 latent（视频+音频 NestedTensor）保存为
  image_latent / audio_latent 两个 safetensors + sidecar meta（无损合并素材）；
  接入 video_vae / audio_vae 时解码帧并编码视频；audio（clip_audio）优先作为
  音轨，否则用 audio_vae 解码的音频。

两条路径均输出 VHS_FILENAMES 4 元组 (filename, subfolder, type, full_path)，
与 guide.py ``_vhs_tuple_path`` 的解析约定一致，可直连 Guide 的 prev_tail。

实际编码逻辑复用 lib.video_combine.encode_frames_with_vhs：
优先调用 VideoHelperSuite 的 VideoCombine（完整支持 AUDIO / metadata /
多种容器格式），VHS 未安装或编码失败时回退到本地 ffmpeg（不含音频）。

latent 路径执行后通过 send_sync("minimax_ref_video_progress") 通知前端
（status="add_material"），携带视频路径 + image_latent/audio_latent/clip_audio
路径，供素材条「无损合并」使用。
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
                "· 像素路径：IMAGE 帧（VAEDecode）+ 可选 AUDIO → VHS 视频（原行为）。\n"
                "· latent 路径：joint H3 latent（视频+音频）→ 保存 image_latent / "
                "audio_latent safetensors + meta（供「无损合并」使用）；接入 video_vae "
                "时解码帧并编码视频；audio（clip_audio）优先作为音轨，否则用 audio_vae "
                "解码音频。\n"
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
                    tooltip="可选音频轨（clip_audio）：latent 路径下优先作为音轨，"
                            "通常来自 MiniMaxH3SongMaskedAVContext 的 clip_audio 输出。",
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
                    tooltip="音频 VAE：latent 路径下无 audio 输入时，把音频流解码为音轨。",
                ),
                io.Boolean.Input(
                    "save_latent",
                    default=True,
                    tooltip="latent 路径下保存 image_latent / audio_latent safetensors + meta，"
                            "供素材条「无损合并」使用。",
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
                io.Boolean.Input(
                    "pingpong",
                    default=False,
                    tooltip="A-B-A 往返播放帧。",
                ),
                io.Boolean.Input(
                    "save_output",
                    default=True,
                    tooltip="是否把视频保存到磁盘。",
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
    def execute(cls, images=None, audio=None, latent=None, video_vae=None,
                audio_vae=None, save_latent=True, context_frames=39,
                trim_frames=0, frame_rate=24.0, loop_count=0,
                filename_prefix="MiniMaxRef/combine", format="video/h264-mp4",
                pingpong=False, save_output=True, prompt=None, extra_pnginfo=None):
        if latent is not None:
            return cls._execute_latent(
                latent=latent,
                audio=audio,
                video_vae=video_vae,
                audio_vae=audio_vae,
                save_latent=save_latent,
                context_frames=context_frames,
                trim_frames=trim_frames,
                frame_rate=frame_rate,
                loop_count=loop_count,
                filename_prefix=filename_prefix,
                format=format,
                pingpong=pingpong,
                save_output=save_output,
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )

        # ── 像素路径（原行为） ──────────────────────────────────────────
        if not save_output:
            return io.NodeOutput("", ui={"gifs": []})

        # motion context 引导帧：解码帧头部 trim_frames 帧为 pinned context
        # 延续，单段输出时裁掉；按帧率同步裁掉音频头部，保持 A/V 对齐。
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

        meta = encode_frames_with_vhs(
            images=images,
            audio=audio,
            frame_rate=frame_rate,
            loop_count=loop_count,
            filename_prefix=filename_prefix,
            format=format,
            pingpong=pingpong,
            save_output=True,
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
        )
        value = to_single_filename(build_vhs_filenames(meta))
        return io.NodeOutput(value, ui=meta["ui"])

    # ── latent 路径 ──────────────────────────────────────────────────────

    @classmethod
    def _execute_latent(cls, latent, audio, video_vae, audio_vae, save_latent,
                        context_frames, trim_frames, frame_rate, loop_count,
                        filename_prefix, format, pingpong, save_output,
                        prompt, extra_pnginfo):
        video, audio_lat = latent_lib.split_joint_latent(latent)

        meta_data = {
            "frame_count": int(video.shape[2]),
            "context_frames": int(context_frames),
            "trim_frames": int(trim_frames),
            "fps": float(frame_rate),
            "width": int(video.shape[4]),
            "height": int(video.shape[3]),
            "audio_steps": int(audio_lat.shape[3]),
            "video_vae": (
                latent_lib.vae_display_name(video_vae) if video_vae is not None else ""
            ),
            "audio_vae": (
                latent_lib.vae_display_name(audio_vae) if audio_vae is not None else ""
            ),
        }

        saved = None
        if save_latent:
            saved = latent_lib.save_joint_latent_files(latent, meta_data, filename_prefix)

        # 音轨：clip_audio（audio 输入）优先，否则 audio_vae 解码音频流
        out_audio = audio
        if out_audio is None and audio_vae is not None:
            wave, sr = latent_lib.decode_audio_latent(audio_vae, audio_lat)
            out_audio = {"waveform": wave, "sample_rate": sr}

        clip_audio_path = None
        if out_audio is not None:
            try:
                clip_audio_path = latent_lib.save_audio_clip(out_audio, filename_prefix)["path"]
            except Exception:
                log.warning("failed to save clip_audio wav", exc_info=True)

        filenames = None
        ui = {"gifs": []}
        if video_vae is not None and save_output:
            frames = latent_lib.decode_video_latent(video_vae, video)
            meta = encode_frames_with_vhs(
                images=frames,
                audio=out_audio,
                frame_rate=frame_rate,
                loop_count=loop_count,
                filename_prefix=filename_prefix,
                format=format,
                pingpong=pingpong,
                save_output=True,
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            filenames = build_vhs_filenames(meta)
            ui = meta["ui"]

        # 通知前端：携带视频 + latent 文件路径（供素材条「无损合并」）
        payload = {"status": "add_material", "type": "video"}
        if filenames is not None:
            payload["imageFile"] = to_single_filename(filenames)
        if saved is not None:
            payload["image_latent"] = saved["image_path"]
            payload["audio_latent"] = saved["audio_path"]
            payload["meta_file"] = saved["meta_path"]
            payload["meta"] = meta_data
        if clip_audio_path:
            payload["clip_audio"] = clip_audio_path
        _send_progress(payload)

        return io.NodeOutput(to_single_filename(filenames), ui=ui)


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefCombine": MiniMaxRefCombine,
}
