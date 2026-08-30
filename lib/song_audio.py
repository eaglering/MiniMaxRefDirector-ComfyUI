# -*- coding: utf-8 -*-
"""H3 Song Masked Audio Context（ComfyUI-H3-Motion-Context-MultiRef）辅助。

提供 master_audio 合成（把 director 补齐后的 audio_segments 拼成完整音频）、
context_length 吸附与第三方节点模块定位。被 guide.py 的段条件构建使用。
"""
import hashlib
import importlib.util
import json
import logging
import os
import sys

import folder_paths
import torch

from .path import resolve_input_path
from .video import _load_wav_audio

log = logging.getLogger(__name__)

# master_audio 合成缓存：{key: AUDIO dict}。guide_data 对象在同一个 prompt 内
# 复用（director 有缓存），按 id 键控避免每段重复读文件/重采样。
_MASTER_AUDIO_CACHE: dict = {}


def _snap_h3_run(n):
    """把 context_length 向下吸附到合法 H3 run（5/22/39/56...）；<5 视为 0。

    与 h3_song_audio_context._largest_h3_video_run 一致。guideStrength 通常为 22，
    吸附后为 5；0/5/22/39/56 本就是合法值，原样保留。
    """
    n = int(n)
    if n < 5:
        return 0
    return ((n - 5) // 17) * 17 + 5


def _get_song_audio_module():
    """定位并返回 ComfyUI-H3-Motion-Context-MultiRef 的 h3_song_audio_context 模块。

    ComfyUI 启动时会把 custom_nodes 下每个目录作为包导入，因此该包通常已在
    sys.modules 中（含 h3_song_audio_context 子模块）。其子模块含相对导入
    （from .h3_timing import ...），无法单文件加载，兜底按包加载以解析相对导入。
    """
    for mod in list(sys.modules.values()):
        f = getattr(mod, "__file__", None) or ""
        if "ComfyUI-H3-Motion-Context-MultiRef" in f.replace("\\", "/") \
                and hasattr(mod, "MiniMaxH3SongMaskedAVContext"):
            return mod

    root = os.path.join(folder_paths.base_path, "custom_nodes",
                        "ComfyUI-H3-Motion-Context-MultiRef")
    if not os.path.isdir(root):
        raise RuntimeError(
            "[MiniMaxRefGuide] song audio context requires "
            "ComfyUI-H3-Motion-Context-MultiRef. Clone the repo into custom_nodes "
            "and restart ComfyUI."
        )
    pkg_name = "ComfyUI-H3-Motion-Context-MultiRef"
    mod_name = pkg_name + ".h3_song_audio_context"
    if mod_name not in sys.modules:
        if pkg_name not in sys.modules:
            pkg_spec = importlib.util.spec_from_file_location(
                pkg_name, os.path.join(root, "__init__.py"))
            pkg = importlib.util.module_from_spec(pkg_spec)
            sys.modules[pkg_name] = pkg
            if pkg_spec.loader is not None:
                pkg_spec.loader.exec_module(pkg)
        spec = importlib.util.spec_from_file_location(
            mod_name, os.path.join(root, "h3_song_audio_context.py"))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        if spec.loader is not None:
            spec.loader.exec_module(mod)
    mod = sys.modules.get(mod_name)
    if mod is None or not hasattr(mod, "MiniMaxH3SongMaskedAVContext"):
        raise RuntimeError(
            "[MiniMaxRefGuide] could not load MiniMaxH3SongMaskedAVContext from "
            "ComfyUI-H3-Motion-Context-MultiRef. See the ComfyUI console for details."
        )
    return mod


def _resample_waveform(waveform, source_sr, target_sr):
    """把 [1, C, L] 波形重采样到 target_sr（torchaudio 优先，兜底线性插值）。"""
    if int(source_sr) == int(target_sr):
        return waveform
    try:
        import torchaudio.functional  # type: ignore[import]
        return torchaudio.functional.resample(waveform, source_sr, target_sr)
    except Exception:
        n = waveform.shape[-1]
        m = max(1, int(round(n * target_sr / source_sr)))
        return torch.nn.functional.interpolate(
            waveform, size=m, mode="linear", align_corners=False)


def _synthesize_master_audio(guide_data):
    """把补齐后的 audio_segments 合成为覆盖 [range_start, range_end) 的完整 AUDIO dict。

    audio_segments 由 director 的 _fill_audio_gaps 补齐为无缝序列，每段：
    - start      : 对应视频起始帧（绝对帧号）
    - length     : 覆盖的视频帧数
    - trimStart  : 音频文件内切割起始位置（帧）
    - silence    : 该段为补白空白段（True 时无源文件）
    - audioFile  : 源音频文件路径（silence 段无此字段）

    空白段填零，非空白段从源文件按 trimStart 切片；各段统一采样率后按绝对
    位置拼接。返回 {"waveform": [1, 2, L], "sample_rate": sr}；无音频段返回 None。
    """
    segments = guide_data.get("audio_segments") or []
    if not segments or all(s.get("silence") for s in segments):
        return None
    frame_rate = float(guide_data.get("frame_rate", 24))
    range_start = int(guide_data.get("range_start", 0))
    range_end = int(guide_data.get("range_end", 0))
    if range_end <= range_start:
        range_end = range_start + sum(int(s.get("length", 0)) for s in segments)
    total_frames = range_end - range_start
    if total_frames <= 0:
        return None

    try:
        content_fp = hashlib.sha1(
            json.dumps(segments, ensure_ascii=False, sort_keys=True,
                       default=str).encode("utf-8")).hexdigest()
    except Exception:
        content_fp = str(segments)
    cache_key = ("master_audio", content_fp, range_start, range_end, frame_rate)
    if cache_key in _MASTER_AUDIO_CACHE:
        return _MASTER_AUDIO_CACHE[cache_key]

    # 目标采样率：取第一个可用源文件的采样率（节点内部会再重采样到 audio_vae 采样率）
    target_sr = None
    loaded: dict = {}
    for s in segments:
        if s.get("silence"):
            continue
        path = s.get("audioFile") or ""
        if not path or path in loaded:
            continue
        resolved = resolve_input_path(path)
        if not resolved:
            log.warning(f"[MiniMaxRefGuide] master_audio source not found: {path!r}")
            continue
        try:
            loaded[path] = _load_wav_audio(resolved)
        except Exception:
            log.warning(f"[MiniMaxRefGuide] failed to load audio {path!r}",
                        exc_info=True)
            continue
        if target_sr is None:
            target_sr = int(loaded[path]["sample_rate"])
    if target_sr is None:
        log.warning("[MiniMaxRefGuide] master_audio: no audio source loaded, "
                    "treating as no audio")
        return None

    samples_per_frame = target_sr / frame_rate
    total_samples = max(1, int(round(total_frames * samples_per_frame)))
    out = torch.zeros(1, 2, total_samples, dtype=torch.float32)

    for s in segments:
        seg_start = int(s.get("start", 0))
        seg_len = int(s.get("length", 0))
        a = max(seg_start, range_start)
        b = min(seg_start + seg_len, range_end)
        if b <= a:
            continue
        n_frames = b - a
        pos_sample = int(round((a - range_start) * samples_per_frame))
        n_samples = int(round(n_frames * samples_per_frame))
        if pos_sample + n_samples > total_samples:
            n_samples = max(1, total_samples - pos_sample)
        if n_samples <= 0:
            continue

        if s.get("silence"):
            chunk = torch.zeros(1, 2, n_samples, dtype=torch.float32)
        else:
            path = s.get("audioFile") or ""
            audio = loaded.get(path)
            if audio is None:
                continue
            wav = audio["waveform"]  # [1, C, L]
            sr = int(audio["sample_rate"])
            # 段在源文件中的切割起点 = trimStart + 裁剪导致的帧偏移，再换算样本数
            clip_offset = a - seg_start
            start_sample = int(round((int(s.get("trimStart", 0)) + clip_offset)
                                     * sr / frame_rate))
            n_src = int(round(n_frames * sr / frame_rate))
            chunk = wav[..., start_sample:start_sample + n_src]
            if chunk.shape[1] == 1:
                chunk = chunk.repeat(1, 2, 1)
            if sr != target_sr:
                chunk = _resample_waveform(chunk, sr, target_sr)
            if chunk.shape[-1] < n_samples:
                chunk = torch.nn.functional.pad(chunk, (0, n_samples - chunk.shape[-1]))
            elif chunk.shape[-1] > n_samples:
                chunk = chunk[..., :n_samples]

        end = min(pos_sample + chunk.shape[-1], total_samples)
        out[..., pos_sample:end] = chunk[..., :end - pos_sample]

    master = {"waveform": out, "sample_rate": target_sr}
    if len(_MASTER_AUDIO_CACHE) > 32:
        _MASTER_AUDIO_CACHE.clear()
    _MASTER_AUDIO_CACHE[cache_key] = master
    return master
