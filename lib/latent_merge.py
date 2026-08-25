"""MiniMaxRef 素材条「无损合并」：latent 像素域交叉淡化 + 音频拼接 + VHS 编码。

照搬 ComfyUI-H3-Motion-Context-MultiRef h3_streaming_vhs.py 已验证算法：
- _seam_overlaps / _generated_frame_generator：按 b_n / context_length_n 计算
  重叠，alpha=linspace(0,1,ov+2)[1:-1] 交叉淡化，tail 保留
- _assemble_av_audio：按 sample_boundary_from_frames 绝对帧边界落位，后续段
  覆盖前段尾部受保护 context 重叠（保留生成侧音频 feather）
- _OneShotFrameSequence：惰性帧流（段数少 / 内存充裕时降级为全量 list）

音频来源按用户确认的策略：各段统一携带 clip_audio（AUDIO dict / wav 文件），
最终拼接为 master_audio 随视频一起编码。audio_latent 经 audio_vae 解码的兜底
分支保留（audio_vae=None 时跳过），但当前合并入口统一传 None（素材不再保存
audio_latent，音轨全部来自 clip_audio）。

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


def _vram_log(tag: str) -> None:
    """GPU 显存诊断日志（尽力而为，无 GPU 时静默）。"""
    if not torch.cuda.is_available():
        return
    try:
        free_b, total_b = torch.cuda.mem_get_info()
        log.info(
            "[merge] %s: torch_alloc=%.2f GiB, torch_reserved=%.2f GiB, "
            "cuda_free=%.2f GiB / %.2f GiB",
            tag,
            torch.cuda.memory_allocated() / 2**30,
            torch.cuda.memory_reserved() / 2**30,
            free_b / 2**30,
            total_b / 2**30,
        )
    except Exception:  # noqa: BLE001 - 尽力而为
        pass


def _release_all_models(tag: str) -> None:
    """卸载 ComfyUI 跟踪的全部模型并清缓存，为解码腾出整卡显存。

    合并前调用可驱逐生成阶段残留的 H3 大模型（例如 10B DiT 权重，
    否则仅 5GB VAE 加载就会触发 torch 的 OOM）。
    """
    gc.collect()
    try:
        comfy.model_management.unload_all_models()
    except Exception:  # noqa: BLE001 - 尽力而为
        pass
    try:
        comfy.model_management.soft_empty_cache()
    except Exception:  # noqa: BLE001 - 尽力而为
        pass
    _vram_log(tag)


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


def _generated_frame_generator(
    video_vae, videos, raw_frames, contexts, overlap, log_prefix,
    chunks_per_slice: int | None = None,
):
    """逐段流式解码 + 交叉淡化，边解码边出帧（内存有界）。

    与旧版（整段解码 + _yield_segments_and_hold）像素级一致：接缝 alpha=
    linspace(0,1,ov+2)[1:-1]、tail 保留帧数完全不变；只是每段内部改为按 VAE
    chunk 边界分片流式解码（latent_lib.iter_decode_video_latent），任意时刻
    GPU 只驻留 chunks_per_slice 个 chunk 的时间跨度（None 时按分辨率自动选取），
    CPU 只驻留一个分片像素 + 接缝窗口，长素材不再整段驻留显存/内存。
    """
    seam_ovs = _seam_overlaps(raw_frames, contexts, overlap)
    tail = None

    for i, video_latent in enumerate(videos):
        video_t, _audio_t = latent_lib.split_joint_latent(video_latent)
        expected = int(raw_frames[i])
        ctx = int(contexts[i]) if i > 0 else 0
        ov = int(seam_ovs[i])
        next_hold = int(seam_ovs[i + 1]) if i + 1 < len(videos) else 0

        blend_src = []            # 接缝窗口 [ctx-ov, ctx) 的 ov 帧（CPU）
        blend_done = (i == 0)     # 第 1 段没有 context，无需缝合
        seen = 0                  # 本段解码产出的总帧数
        clip_tail = []            # 滚动保留最后 next_hold 帧（CPU）
        hold_n = 0

        def _emit(frame):
            nonlocal hold_n
            clip_tail.append(frame.detach().to("cpu", dtype=torch.float32))
            hold_n += 1
            if hold_n > next_hold:
                yield clip_tail.pop(0)
                hold_n -= 1

        def _blend_and_emit():
            """把 tail 与 blend_src（[ctx-ov, ctx) 帧）交叉淡化后经 _emit 输出。"""
            nonlocal blend_done, tail
            if ov > 0:
                if tail is None or int(tail.shape[0]) != ov:
                    raise RuntimeError(
                        "%s: seam %d retained tail mismatch (%s != %d)"
                        % (
                            log_prefix,
                            i + 1,
                            0 if tail is None else int(tail.shape[0]),
                            ov,
                        )
                    )
                dst = torch.stack(blend_src, dim=0)
                if int(dst.shape[0]) != ov:
                    raise RuntimeError(
                        "%s: seam %d blend window has %d frames; expected %d "
                        "(context exceeds clip length)" % (
                            log_prefix, i + 1, int(dst.shape[0]), ov
                        )
                    )
                alpha = torch.linspace(
                    0.0, 1.0, ov + 2, dtype=torch.float32, device="cpu"
                )[1:-1].view(-1, 1, 1, 1)
                tail.mul_(1.0 - alpha).add_(dst * alpha)
                del dst, alpha
                for f in tail:
                    yield from _emit(f)
            else:
                tail = None
            del blend_src[:]
            blend_done = True

        for frame_start, frames in latent_lib.iter_decode_video_latent(
            video_vae, video_t, chunks_per_slice=chunks_per_slice
        ):
            for j in range(int(frames.shape[0])):
                p = frame_start + j
                if p >= expected:
                    break
                seen += 1
                if blend_done:
                    yield from _emit(frames[j])
                    continue
                if p < ctx - ov:
                    continue          # 前文重复 context 帧，丢弃
                if p < ctx:
                    blend_src.append(frames[j].detach().to("cpu", dtype=torch.float32))
                    if len(blend_src) > ov:
                        blend_src.pop(0)
                    continue
                # p == ctx：开始输出本段，先缝合 tail 与解码帧 [ctx-ov, ctx)
                yield from _blend_and_emit()
                yield from _emit(frames[j])
            del frames

        if not blend_done:
            # 整段都是 context（ctx >= expected）：p 到不了 ctx，接缝淡化
            # 从未触发；旧算法此处 segments=[blended]、decoded[ctx:] 为空，
            # 仍照常输出淡化后的 tail。
            yield from _blend_and_emit()

        if seen != expected:
            raise RuntimeError(
                "%s: Clip %d video decode produced %d frames; expected %d"
                % (log_prefix, i + 1, seen, expected)
            )
        tail = torch.stack(clip_tail, dim=0) if (next_hold > 0 and clip_tail) else None
        del clip_tail, blend_src
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

    def reset(self):
        """重置一次性状态，允许 ffmpeg 回退重放帧流（VHS 消费/失败后恢复）。

        video.py 的 ffmpeg 回退路径会调用 _replay_frame_input，依赖此方法
        重置后重新流式解码，避免 one-shot 错误导致合并中断。重置同时清一次
        GPU 缓存池：VHS 尝试可能已解码部分帧（常规/tiled 双路径），回退重放
        前清场，防止两轮解码的 reserved 池叠加（用户环境 allocated 虚涨到
        31 GiB 的主因之一）。
        """
        self._generator = None
        self._first = None
        self._primed = False
        self._iterated = False
        _release_decode_memory()


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
    audio_vae=None,
    chunks_per_slice: int | None = None,
):
    """像素域交叉淡化拼接 + 音频（clip_audio；audio_vae 兜底可选）+ 视频编码。

    :param audio_vae: 音频 VAE（可选）；段无 clip_audio 时兜底解码 audio_latent，
        当前合并入口统一传 None（素材携带 clip_audio，不保存 audio_latent）
    :param videos: list[joint latent dict]（每段 NestedTensor，与 raw_frames 等长）
    :param clip_audios: list[AUDIO dict | None]，clip_audio 优先，None 表示无
    :param raw_frames:  list[int] 每段 b_n（H3 run）
    :param contexts:    list[int] 每段 context_length_n
    :param overlap:     交叉淡化重叠帧数（建议 = contexts[0]）
    :param lazy:        惰性帧流（True）还是全量 list（False，内存充裕时更快）
    :param chunks_per_slice: 每次 decode 的 chunk 数（>=3）。None（默认）按 latent
        分辨率自动选取，控制单次 decode 的 GPU 驻留（4K 长片防 OOM）。
    :return: {"filename","subfolder","type","full_path","ui","frame_count"}
    """
    if len(videos) < 2:
        raise ValueError("merge_latents: need at least 2 segments, got %d" % len(videos))
    if not (len(videos) == len(raw_frames) == len(contexts)):
        raise ValueError(
            "merge_latents: length mismatch videos=%d raw_frames=%d contexts=%d"
            % (len(videos), len(raw_frames), len(contexts))
        )

    # 合并前清场：驱逐生成阶段残留的 H3 大模型，给 VAE 解码腾出整卡显存
    _release_all_models("start")

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

    # 音频已组装到 CPU，清场腾出显存给视频解码（audio_vae 当前入口恒为 None）
    _release_all_models("after audio")

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
                video_vae, videos, raw_frames, contexts, overlap, "merge_latents",
                chunks_per_slice=chunks_per_slice,
            ),
        )
    else:
        frame_list = list(
            _generated_frame_generator(
                video_vae, videos, raw_frames, contexts, overlap, "merge_latents",
                chunks_per_slice=chunks_per_slice,
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
    # 合并完成，卸载 VAE 恢复干净状态（ComfyUI 需要时自动重载）
    _release_all_models("done")
    return meta
