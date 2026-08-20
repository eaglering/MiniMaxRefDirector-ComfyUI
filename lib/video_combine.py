"""MiniMaxRef video combine helpers.

视频合并/保存相关辅助函数，供节点层（combine_video.py 等）复用：

- split_video_streams  拆流：探测视频流信息，可选把音频轨提取为 AUDIO dict
- decode_video_frames  解码：视频文件 → [B,H,W,C] 帧张量
- trim_video_file      裁剪：按帧数裁剪视频文件（ffmpeg）
- trim_frames          裁剪：按帧数截取帧张量头部
- align_audio_to_duration / align_audio_to_frames  音频对齐：截断 / 补零
- encode_frames_with_vhs   VHS 封装：优先 VideoCombine（含音频），回退本地 ffmpeg
- build_vhs_filenames      构造 VHS_FILENAMES 4 元组 (filename, subfolder, type, full_path)

4 元组约定与 guide.py ``_vhs_tuple_path`` 完全一致，可直连 MiniMaxRefGuide 的 prev_tail。
"""

import logging
import os

import folder_paths
import torch
import torch.nn.functional as F

from dataclasses import dataclass

from .video import (
    encode_video_frames,
    ffmpeg_extract_audio,
    ffprobe_info,
    trim_video_with_ffmpeg,
)

log = logging.getLogger(__name__)

# VideoHelperSuite 是软依赖：安装后启用完整能力（AUDIO / metadata / 多容器），
# 未安装时回退到本地 ffmpeg（不含音频）。
try:
    from videohelpersuite.nodes import VideoCombine, get_video_formats

    VIDEO_FORMATS = list(get_video_formats()[0]) or ["video/h264-mp4"]
except Exception:  # noqa: BLE001 - VHS 是软依赖
    VideoCombine = None
    VIDEO_FORMATS = ["video/h264-mp4", "video/h264-mkv", "video/av1-mp4"]


# ── 拆流 ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class VideoSplit:
    """视频文件的流信息与（可选）提取出的音频轨。"""

    video_path: str
    has_video: bool
    has_audio: bool
    width: int | None
    height: int | None
    fps: float | None
    duration: float | None
    frame_count: int | None
    audio: dict | None = None  # ComfyUI AUDIO dict（waveform + sample_rate）


def split_video_streams(video_path: str, extract_audio: bool = True) -> VideoSplit:
    """探测视频文件流信息，并按需提取音频轨为 AUDIO dict。

    音频提取失败（ffmpeg 缺失 / 文件无音频轨）时 audio 为 None，不抛异常。
    """
    info = ffprobe_info(video_path)
    audio: dict | None = None
    if extract_audio and info.get("has_audio"):
        try:
            audio = ffmpeg_extract_audio(video_path)
        except Exception as exc:  # noqa: BLE001 - 音频提取失败仅告警
            log.warning("[video_combine] failed to extract audio from %r: %s",
                        video_path, exc)
    return VideoSplit(
        video_path=video_path,
        has_video=bool(info.get("has_video")),
        has_audio=bool(info.get("has_audio")),
        width=info.get("width"),
        height=info.get("height"),
        fps=info.get("fps"),
        duration=info.get("duration"),
        frame_count=info.get("frame_count"),
        audio=audio,
    )


# ── 解码 ────────────────────────────────────────────────────────────────

def decode_video_frames(video_path: str, max_frames: int | None = None) -> torch.Tensor | None:
    """把视频文件解码为 [B,H,W,C] float 帧张量，可限制帧数。

    与 guide.py ``_load_prev_tail_frames`` 使用同一解码路径（comfy_api VideoFromFile），
    解码失败返回 None（不抛异常，便于节点做降级处理）。
    """
    if not video_path or not os.path.isfile(video_path):
        log.warning("[video_combine] decode_video_frames: file not found %r", video_path)
        return None
    try:
        try:
            from comfy_api.latest import VideoFromFile
        except ImportError:  # pragma: no cover - 兼容旧版 comfy_api
            from comfy_api.latest._input_impl import VideoFromFile

        frames = VideoFromFile(video_path).get_components().images
    except Exception as exc:  # noqa: BLE001
        log.warning("[video_combine] failed to decode %r: %s", video_path, exc)
        return None
    if frames is None or frames.shape[0] == 0:
        return None
    if max_frames is not None and max_frames > 0 and frames.shape[0] > max_frames:
        frames = frames[:max_frames]
    return frames


# ── 裁剪 ────────────────────────────────────────────────────────────────

def trim_frames(frames: torch.Tensor, max_frames: int | None) -> torch.Tensor:
    """按帧数截取帧张量头部；max_frames 非正或为空时原样返回。"""
    if frames is None:
        return frames
    if max_frames is not None and max_frames > 0 and frames.shape[0] > max_frames:
        return frames[:max_frames]
    return frames


def trim_video_file(video_path: str, frame_count: int) -> str:
    """把视频文件裁剪到 frame_count 帧，返回新文件路径（原文件保留）。

    frame_count <= 0 时返回原路径。裁剪失败（ffmpeg 缺失 / 无法探测 fps）抛
    RuntimeError，附带可操作提示。

    底层 ``trim_video_with_ffmpeg`` 采用 stream copy（快但受关键帧对齐影响，
    可能保留多于目标帧数），因此裁剪后探测帧数仍超限时，自动改用 re-encode
    精确裁剪（-frames:v），保证输出帧数不超出目标。
    """
    if frame_count <= 0:
        return video_path
    trimmed = trim_video_with_ffmpeg(video_path, frame_count)
    if trimmed is None:
        raise RuntimeError(
            "[video_combine] cannot trim video to {0} frames: "
            "FFmpeg/FFprobe not installed or frame rate undetectable.".format(frame_count)
        )
    actual = ffprobe_info(trimmed).get("frame_count")
    if actual is not None and actual > frame_count:
        log.info("[video_combine] stream-copy trim kept %s frames (target %s), "
                 "re-encoding for exact frame count", actual, frame_count)
        try:
            trimmed = _reencode_exact_frames(trimmed, frame_count)
        except Exception as exc:  # noqa: BLE001
            log.warning("[video_combine] exact re-encode trim failed (%s); "
                        "returning stream-copy result", exc)
    return trimmed


def _reencode_exact_frames(video_path: str, frame_count: int) -> str:
    """用 ffmpeg re-encode 把视频精确裁剪到 frame_count 帧（-frames:v）。"""
    import subprocess
    import tempfile

    from .video import get_ffmpeg_path

    ffmpeg = get_ffmpeg_path("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("[video_combine] FFmpeg not found for exact trim.")

    output_fd, output_path = tempfile.mkstemp(
        suffix=_output_suffix(video_path),
        dir=folder_paths.get_temp_directory(),
    )
    os.close(output_fd)
    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-map", "0:v:0",
        "-frames:v", str(int(frame_count)),
        "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
        "-an",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        try:
            os.unlink(output_path)
        except OSError:
            pass
        raise RuntimeError(
            "[video_combine] exact re-encode trim failed:\n"
            + result.stderr.decode(errors="replace")[-600:]
        )
    return output_path


def _output_suffix(path: str) -> str:
    """取路径扩展名（含点），兜底 .mp4。"""
    ext = os.path.splitext(path)[1].lower()
    return ext if ext in (".mp4", ".mov", ".mkv", ".webm", ".avi") else ".mp4"


# ── 音频对齐 ────────────────────────────────────────────────────────────

def align_audio_to_duration(audio: dict | None, duration_seconds: float) -> dict | None:
    """把 AUDIO dict 对齐到指定时长：音频过长截断尾部，过短补零（静音）。

    返回新的 dict，不改动输入。audio 为 None 或 duration 无效时原样返回。
    waveform 布局为 [B, C, N]。
    """
    if audio is None:
        return None
    if not duration_seconds or duration_seconds <= 0:
        return audio
    waveform = audio.get("waveform")
    sample_rate = audio.get("sample_rate")
    if not isinstance(waveform, torch.Tensor) or sample_rate is None:
        return audio

    target = max(1, round(float(duration_seconds) * int(sample_rate)))
    current = waveform.shape[-1]
    if current > target:
        log.info("[video_combine] align audio: trimming %s → %s samples", current, target)
        waveform = waveform[..., :target]
    elif current < target:
        log.info("[video_combine] align audio: padding %s → %s samples", current, target)
        waveform = F.pad(waveform, (0, target - current))
    return {"waveform": waveform, "sample_rate": int(sample_rate)}


def align_audio_to_frames(audio: dict | None, frame_count: int, fps: float) -> dict | None:
    """把 AUDIO dict 对齐到 frame_count / fps 对应的视频时长。"""
    if audio is None or frame_count <= 0 or not fps or fps <= 0:
        return audio
    return align_audio_to_duration(audio, frame_count / float(fps))


# ── VHS 封装 ────────────────────────────────────────────────────────────

def resolve_output_full_path(filename: str, subfolder: str, ftype: str) -> str:
    """按 (filename, subfolder, type) 解析本地绝对路径，兼容新旧 ComfyUI。"""
    if ftype == "input":
        base = folder_paths.get_input_directory()
    elif ftype == "temp":
        base = folder_paths.get_temp_directory()
    else:
        base = folder_paths.get_output_directory()
    return os.path.abspath(os.path.join(base, subfolder or "", filename))


def encode_frames_with_vhs(
    images: torch.Tensor,
    audio: dict | None = None,
    frame_rate: float = 24.0,
    loop_count: int = 0,
    filename_prefix: str = "MiniMaxRef/combine",
    format: str = "video/h264-mp4",
    pingpong: bool = False,
    save_output: bool = True,
    prompt: dict | None = None,
    extra_pnginfo: dict | None = None,
) -> dict:
    """把 [B,H,W,C] 帧张量编码为视频文件。

    优先使用 VideoHelperSuite 的 VideoCombine（支持 AUDIO / metadata / 多容器）；
    VHS 未安装或编码失败时回退到本地 ffmpeg（忽略 AUDIO 输入）。

    返回 {"filename", "subfolder", "type", "full_path", "ui"}；
    ui 为 VideoCombine 的原始 UI（含 gifs）或 ffmpeg 回退时构造的等价结构。
    """
    if VideoCombine is not None:
        try:
            vc = VideoCombine()
            out = vc.combine_video(
                frame_rate=float(frame_rate),
                loop_count=int(loop_count),
                images=images,
                filename_prefix=filename_prefix,
                format=format,
                pingpong=bool(pingpong),
                save_output=True,
                audio=audio,
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            preview = out["ui"]["gifs"][0]
            filename = preview["filename"]
            subfolder = preview.get("subfolder", "")
            ftype = preview.get("type", "output")
            return {
                "filename": filename,
                "subfolder": subfolder,
                "type": ftype,
                "full_path": resolve_output_full_path(filename, subfolder, ftype),
                "ui": out["ui"],
            }
        except Exception as exc:  # noqa: BLE001
            log.warning("[video_combine] VideoCombine encode failed, "
                        "falling back to ffmpeg: %s", exc)

    if audio is not None:
        log.warning("[video_combine] ffmpeg fallback 忽略 AUDIO 输入。")

    meta = encode_video_frames(images, float(frame_rate), filename_prefix, format)
    filename = meta["filename"]
    subfolder = meta.get("subfolder", "")
    ftype = meta.get("type", "output")
    full_path = resolve_output_full_path(filename, subfolder, ftype)
    ui = {
        "gifs": [
            {
                "filename": filename,
                "subfolder": subfolder,
                "type": ftype,
                "format": format,
                "fullpath": full_path,
            }
        ]
    }
    return {
        "filename": filename,
        "subfolder": subfolder,
        "type": ftype,
        "full_path": full_path,
        "ui": ui,
    }


def build_vhs_filenames(meta: dict) -> tuple:
    """从 encode_frames_with_vhs 的结果构造 VHS_FILENAMES 4 元组。

    (filename, subfolder, type, full_path) —— 与 guide.py ``_vhs_tuple_path`` 约定一致。
    """
    return (
        meta["filename"],
        meta.get("subfolder", ""),
        meta.get("type", "output"),
        meta["full_path"],
    )
