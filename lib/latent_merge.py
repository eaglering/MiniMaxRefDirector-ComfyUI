"""MiniMaxRef 素材条「无损合并」：latent 像素域交叉淡化 + 音频拼接 + VHS 编码。

照搬 ComfyUI-H3-Motion-Context-MultiRef h3_streaming_vhs.py 已验证算法：
- _seam_overlaps / _generated_frame_generator：按 b_n / context_length_n 计算
  重叠，alpha=linspace(0,1,ov+2)[1:-1] 交叉淡化，tail 保留
- _assemble_av_audio：按 sample_boundary_from_frames 绝对帧边界落位，后续段
  覆盖前段尾部受保护 context 重叠（保留生成侧音频 feather）
- _OneShotFrameSequence：惰性帧流（段数少 / 内存充裕时降级为全量 list）

音频来源按用户确认的策略逐段选择：clip_audio（AUDIO dict / wav 文件）优先，
否则把 audio_latent 经 audio_vae 解码；各段最终拼接为 master_audio 随视频
一起编码。

编码复用 lib.video_combine.encode_frames_with_vhs（VHS 优先，ffmpeg 回退）。
"""

from __future__ import annotations

import gc
import logging

import torch

import comfy.model_management

from . import latent as latent_lib
from . import timing

try:
    import torchaudio  # type: ignore[import]
except Exception:  # pragma: no cover
    torchaudio = None

log = logging.getLogger(__name__)

FPS = 24.0


def _release_decode_memory():
    gc.collect()
    try:
        comfy.model_management.soft_empty_cache()
    except Exception:  # noqa: BLE001 - 尽力而为
        pass


# ── 音频辅助（照搬 MultiRef existing_video_extension）────────────────────

def _stereo_first_batch(waveform, label):
    if getattr(waveform, "ndim", 0) != 3:
        raise ValueError(
            "merge_latents: %s waveform must be [B,C,L], got %s"
            % (label, tuple(getattr(waveform, "shape", ())))
        )
    waveform = waveform[:1]
    channels = int(waveform.shape[1])
    if channels == 1:
        return waveform.repeat(1, 2, 1)
    if channels == 2:
        return waveform
    raise ValueError(
        "merge_latents: %s has %d channels. Downmix multichannel audio to "
        "stereo before merging." % (label, channels)
    )


def _resample_waveform(waveform, source_sr, target_sr, label):
    source_sr = int(source_sr)
    target_sr = int(target_sr)
    if source_sr == target_sr:
        return waveform
    if torchaudio is None:
        raise RuntimeError(
            "merge_latents: %s is %d Hz but %d Hz is required and torchaudio "
            "is unavailable" % (label, source_sr, target_sr)
        )
    return torchaudio.functional.resample(waveform, source_sr, target_sr)


def _conform_waveform_length(waveform, want, label, max_fractional_change=0.005):
    """把解码/容器时长的微小偏差对正到精确 AV 时间轴（照搬 MultiRef）。

    偏差 ≤0.5% 时用有理数重采样，杜绝静音缝隙；过大直接报错。
    """
    want = int(want)
    have = int(waveform.shape[-1])
    if have == want:
        return waveform
    if want <= 0 or have <= 0:
        raise ValueError(
            "merge_latents: %s has invalid sample length %d -> %d"
            % (label, have, want)
        )
    fractional_change = abs(want - have) / float(want)
    if fractional_change > float(max_fractional_change):
        raise ValueError(
            "merge_latents: %s differs from the exact timeline by %.3f%% "
            "(%d -> %d samples), too large for AV timebase conformance"
            % (label, fractional_change * 100.0, have, want)
        )
    from fractions import Fraction

    ratio = Fraction(want, have).limit_denominator(10000)
    if torchaudio is not None:
        conformed = torchaudio.functional.resample(
            waveform, int(ratio.denominator), int(ratio.numerator)
        )
    else:  # pragma: no cover - torchaudio 通常可用
        conformed = torch.nn.functional.interpolate(
            waveform, size=want, mode="linear", align_corners=False
        )
    got = int(conformed.shape[-1])
    if got != want:
        conformed = torch.nn.functional.interpolate(
            conformed, size=want, mode="linear", align_corners=False
        )
    log.info(
        "merge_latents: time-conformed %s %d -> %d samples (%.4f%%)",
        label, have, want, (want - have) / float(have) * 100.0,
    )
    return conformed


# ── 视频交叉淡化（照搬 MultiRef h3_streaming_vhs）────────────────────────

def _seam_overlaps(raw_frames, contexts, overlap):
    """返回每个接缝的交叉淡化重叠帧数。"""
    overlaps = [0] * len(raw_frames)
    write_frame = int(raw_frames[0])
    overlap = max(0, int(overlap))
    for i in range(1, len(raw_frames)):
        ov = min(overlap, int(contexts[i]), write_frame)
        overlaps[i] = ov
        write_frame += int(raw_frames[i]) - int(contexts[i])
    return overlaps


def _yield_segments_and_hold(segments, hold_frames):
    """产出除最后 hold_frames 外的所有帧，并返回保留的 CPU tail（仅此帧历史留到下一缝）。"""
    segments = [seg for seg in segments if seg is not None and int(seg.shape[0]) > 0]
    total = sum(int(seg.shape[0]) for seg in segments)
    hold = max(0, min(int(hold_frames), total))
    emit = total - hold
    remainders = []

    for seg in segments:
        n = int(seg.shape[0])
        take = min(n, emit)
        if take > 0:
            for frame in seg[:take]:
                yield frame
            emit -= take
        if take < n:
            remainders.append(seg[take:])

    if emit != 0:
        raise RuntimeError("merge_latents: internal frame accounting error")
    if hold == 0:
        return None
    if not remainders:
        raise RuntimeError("merge_latents: failed to retain requested seam tail")
    if len(remainders) == 1:
        tail = remainders[0].detach().to(device="cpu", dtype=torch.float32).clone()
    else:
        tail = torch.cat(remainders, dim=0).detach().to(device="cpu", dtype=torch.float32)
    if int(tail.shape[0]) != hold:
        raise RuntimeError(
            "merge_latents: retained %d frames, expected %d"
            % (int(tail.shape[0]), hold)
        )
    return tail.contiguous()


def _generated_frame_generator(video_vae, videos, raw_frames, contexts, overlap, log_prefix):
    """逐段解码并交叉淡化，流式产出像素帧（与 MultiRef 同缝数学）。"""
    seam_ovs = _seam_overlaps(raw_frames, contexts, overlap)
    tail = None

    for i, video_latent in enumerate(videos):
        video_t, _audio_t = latent_lib.split_joint_latent(video_latent)
        decoded = latent_lib.decode_video_latent(video_vae, video_t)
        if int(decoded.shape[0]) != int(raw_frames[i]):
            raise RuntimeError(
                "%s: Clip %d video decode produced %d frames; expected %d"
                % (log_prefix, i + 1, int(decoded.shape[0]), int(raw_frames[i]))
            )

        if i == 0:
            segments = [decoded]
        else:
            ctx = int(contexts[i])
            ov = int(seam_ovs[i])
            if ov > 0:
                if tail is None or int(tail.shape[0]) != ov:
                    raise RuntimeError(
                        "%s: seam %d retained tail mismatch (%s != %d)"
                        % (log_prefix, i, 0 if tail is None else int(tail.shape[0]), ov)
                    )
                dst = decoded[ctx - ov : ctx]
                alpha = torch.linspace(
                    0.0, 1.0, ov + 2, dtype=torch.float32, device="cpu"
                )[1:-1].view(-1, 1, 1, 1)
                tail.mul_(1.0 - alpha).add_(dst * alpha)
                del dst, alpha
                segments = [tail, decoded[ctx:]]
            else:
                segments = [decoded[ctx:]]
                tail = None

        next_hold = int(seam_ovs[i + 1]) if i + 1 < len(videos) else 0
        new_tail = yield from _yield_segments_and_hold(segments, next_hold)
        tail = new_tail
        del decoded, segments, new_tail
        _release_decode_memory()

    if tail is not None:
        raise RuntimeError("%s: unflushed seam tail after final clip" % log_prefix)


class _OneShotFrameSequence:
    """VHS 惰性帧流门面：先探测首帧，再恰好迭代一次（照搬 MultiRef）。"""

    def __init__(self, frame_count, generator_factory):
        self._frame_count = int(frame_count)
        self._generator_factory = generator_factory
        self._generator = None
        self._first = None
        self._primed = False
        self._iterated = False

    def __len__(self):
        return self._frame_count

    def _prime(self):
        if self._primed:
            return
        self._generator = iter(self._generator_factory())
        try:
            self._first = next(self._generator)
        except StopIteration as exc:
            raise RuntimeError("merge_latents: frame stream produced no frames") from exc
        self._primed = True

    def __getitem__(self, index):
        if int(index) != 0:
            raise IndexError(
                "merge_latents: frame stream only supports the first-frame probe"
            )
        self._prime()
        return self._first

    def __iter__(self):
        if self._iterated:
            raise RuntimeError("merge_latents: frame stream is one-shot")
        self._prime()
        self._iterated = True
        first = self._first
        self._first = None
        yield first
        yield from self._generator


# ── 音频组装 ──────────────────────────────────────────────────────────────

def _decode_segment_audio(audio_vae, clip_audio, audio_latent):
    """逐段音频来源：clip_audio（AUDIO dict）优先，否则 decode audio_latent。

    返回 (waveform [1,2,L] float32 CPU, sample_rate int)。
    """
    if clip_audio is not None:
        wave = clip_audio.get("waveform")
        sr = int(clip_audio.get("sample_rate") or 0)
        if wave is None or sr <= 0:
            raise ValueError("merge_latents: invalid clip_audio dict")
        wave = wave.detach().to(device="cpu", dtype=torch.float32)
        return _stereo_first_batch(wave, "clip_audio"), sr
    if audio_vae is None:
        raise ValueError(
            "merge_latents: segment has no clip_audio and no audio_vae to "
            "decode audio_latent"
        )
    return latent_lib.decode_audio_latent(audio_vae, audio_latent)


def _assemble_av_audio(audio_vae, seg_audios, raw_frames, contexts, fps=FPS):
    """把各段音频按绝对帧边界拼成 master_audio。

    seg_audios: list[(waveform [1,2,L], sr) | None]，与 raw_frames 等长；
    None 段表示静音（该段无任何音频来源）。
    后续段携带完整的受保护 context 前缀，覆盖前段尾部（保留生成侧音频 feather）。
    """
    if not seg_audios:
        return None

    if audio_vae is not None:
        audio_sr = latent_lib.vae_sample_rate(audio_vae)
    else:
        audio_sr = next((int(a[1]) for a in seg_audios if a is not None), 44100)

    final_frames = int(raw_frames[0]) + sum(
        int(raw_frames[i]) - int(contexts[i]) for i in range(1, len(raw_frames))
    )
    total_samples = timing.sample_boundary_from_frames(final_frames, audio_sr, fps)
    audio_out = torch.empty((1, 2, total_samples), dtype=torch.float32, device="cpu")

    # base 段：完整波形放开头
    base = seg_audios[0]
    if base is None:
        wave = torch.zeros((1, 2, 1), dtype=torch.float32)
        base_sr = audio_sr
    else:
        wave, base_sr = base
        wave = _resample_waveform(wave, base_sr, audio_sr, "segment 0 audio")
    want = timing.sample_boundary_from_frames(int(raw_frames[0]), audio_sr, fps)
    wave = _conform_waveform_length(wave, want, "segment 0 audio").detach().to(
        device="cpu", dtype=torch.float32
    )
    audio_out[..., :want].copy_(wave[..., :want])
    del wave
    _release_decode_memory()

    cumulative_frames = int(raw_frames[0])
    for i in range(1, len(raw_frames)):
        item = seg_audios[i]
        if item is None:
            wave = torch.zeros((1, 2, 1), dtype=torch.float32)
            got_sr = audio_sr
        else:
            wave, got_sr = item
            wave = _resample_waveform(wave, got_sr, audio_sr, "segment %d audio" % i)

        ext_start_frame = cumulative_frames - int(contexts[i])
        ext_end_frame = ext_start_frame + int(raw_frames[i])
        ext_start_sample = timing.sample_boundary_from_frames(ext_start_frame, audio_sr, fps)
        ext_end_sample = timing.sample_boundary_from_frames(ext_end_frame, audio_sr, fps)
        expected = ext_end_sample - ext_start_sample
        wave = _conform_waveform_length(
            wave, expected, "segment %d full audio" % i
        ).detach().to(device="cpu", dtype=torch.float32)

        if ext_start_sample < 0 or ext_end_sample > total_samples:
            raise RuntimeError(
                "merge_latents: segment %d audio maps outside final timeline" % i
            )
        audio_out[..., ext_start_sample:ext_end_sample].copy_(wave[..., :expected])
        cumulative_frames = ext_end_frame
        del wave
        _release_decode_memory()

    if cumulative_frames != final_frames:
        raise RuntimeError(
            "merge_latents: audio timeline ended at frame %d, expected %d"
            % (cumulative_frames, final_frames)
        )
    return {"waveform": audio_out, "sample_rate": audio_sr}


# ── 顶层合并入口 ──────────────────────────────────────────────────────────

def merge_latents_to_video(
    video_vae,
    audio_vae,
    videos,
    clip_audios,
    raw_frames,
    contexts,
    overlap,
    filename_prefix,
    frame_rate=24.0,
    format="video/h264-mp4",
    lazy=True,
    prompt=None,
    extra_pnginfo=None,
):
    """像素域交叉淡化拼接 + 音频（clip_audio 优先 / audio_latent 兜底）+ 视频编码。

    :param videos: list[joint latent dict]（每段 NestedTensor，与 raw_frames 等长）
    :param clip_audios: list[AUDIO dict | None]，clip_audio 优先，None 表示无
    :param raw_frames:  list[int] 每段 b_n（H3 run）
    :param contexts:    list[int] 每段 context_length_n
    :param overlap:     交叉淡化重叠帧数（建议 = contexts[0]）
    :param lazy:        惰性帧流（True）还是全量 list（False，内存充裕时更快）
    :return: {"filename","subfolder","type","full_path","ui","frame_count"}
    """
    if len(videos) < 2:
        raise ValueError("merge_latents: need at least 2 segments, got %d" % len(videos))
    if not (len(videos) == len(raw_frames) == len(contexts)):
        raise ValueError(
            "merge_latents: length mismatch videos=%d raw_frames=%d contexts=%d"
            % (len(videos), len(raw_frames), len(contexts))
        )

    # 音频：逐段 clip_audio 优先，否则 audio_latent 解码
    seg_audios = []
    for i, video_latent in enumerate(videos):
        clip_audio = clip_audios[i] if i < len(clip_audios) else None
        _, audio_latent = latent_lib.split_joint_latent(video_latent)
        if clip_audio is None and audio_vae is not None:
            try:
                wave, sr = latent_lib.decode_audio_latent(audio_vae, audio_latent)
                seg_audios.append((_stereo_first_batch(wave, "segment %d audio" % i), sr))
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "merge_latents: segment %d audio decode failed (%s); treating as silent",
                    i, exc,
                )
                seg_audios.append(None)
        elif clip_audio is not None:
            seg_audios.append(_decode_segment_audio(audio_vae, clip_audio, audio_latent))
        else:
            seg_audios.append(None)

    audio = _assemble_av_audio(audio_vae, seg_audios, raw_frames, contexts)

    # 视频帧流：惰性帧流仅在 VHS 可用时启用（VHS 兼容 Sequence 探测）；
    # ffmpeg 回退路径需要完整帧张量，此时降级为全量 list 解码。
    total_frames = int(raw_frames[0]) + sum(
        int(raw_frames[i]) - int(contexts[i]) for i in range(1, len(raw_frames))
    )

    from .video_combine import VideoCombine, encode_frames_with_vhs

    use_lazy = bool(lazy) and VideoCombine is not None
    if use_lazy:
        images = _OneShotFrameSequence(
            total_frames,
            lambda: _generated_frame_generator(
                video_vae, videos, raw_frames, contexts, overlap, "merge_latents"
            ),
        )
    else:
        frame_list = list(
            _generated_frame_generator(
                video_vae, videos, raw_frames, contexts, overlap, "merge_latents"
            )
        )
        images = torch.stack(frame_list, dim=0)

    meta = encode_frames_with_vhs(
        images=images,
        audio=audio,
        frame_rate=float(frame_rate),
        loop_count=0,
        filename_prefix=filename_prefix,
        format=format,
        pingpong=False,
        save_output=True,
        prompt=prompt,
        extra_pnginfo=extra_pnginfo,
    )
    meta["frame_count"] = total_frames
    return meta
