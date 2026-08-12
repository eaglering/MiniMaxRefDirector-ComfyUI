from __future__ import annotations

import glob
import io as _io
import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Mapping, Optional

import folder_paths
import torch
import torch.nn.functional as F
from comfy_api.latest import Input, InputImpl, Types, io, UI
from comfy.utils import ProgressBar

logger = logging.getLogger(__name__)

_FFMPEG_INSTALL_URL = "https://ffmpeg.org/download.html"
_VIDEO_EXTENSIONS = frozenset({".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"})


# ═══════════════════════════════════════════════════════════════════════════
# Inline helpers (originally from ComfyUI-Easy-Media utils/audio.py & utils/video.py)
# ═══════════════════════════════════════════════════════════════════════════

# ── audio helpers ──────────────────────────────────────────────────────────

def save_audio_to_temp_wav(audio: Mapping[str, Any]) -> Path | None:
    """Serialize the first batch of a ComfyUI AUDIO value to a temporary WAV file."""
    waveform = audio.get("waveform")
    sample_rate = audio.get("sample_rate")
    if not isinstance(waveform, torch.Tensor) or sample_rate is None:
        return None
    if waveform.dim() == 3:
        waveform = waveform[0]
    if waveform.dim() != 2:
        return None

    def temporary_path() -> Path:
        file_descriptor, raw_path = tempfile.mkstemp(
            prefix="easy_media_audio_",
            suffix=".wav",
            dir=folder_paths.get_temp_directory(),
        )
        os.close(file_descriptor)
        return Path(raw_path)

    output = temporary_path()
    try:
        import torchaudio  # type: ignore[import]

        torchaudio.save(str(output), waveform.cpu().float(), int(sample_rate))
        return output
    except Exception:
        output.unlink(missing_ok=True)

    output = temporary_path()
    try:
        import soundfile as sf  # type: ignore[import]

        sf.write(str(output), waveform.cpu().float().numpy().T, int(sample_rate))
        return output
    except Exception:
        output.unlink(missing_ok=True)
        return None


def match_audio_sample_rates(
    waveform_1: torch.Tensor,
    sample_rate_1: int,
    waveform_2: torch.Tensor,
    sample_rate_2: int,
) -> tuple[torch.Tensor, torch.Tensor, int]:
    """Resample the lower-rate waveform to the higher sample rate."""
    if sample_rate_1 == sample_rate_2:
        return waveform_1, waveform_2, sample_rate_1

    try:
        import torchaudio  # type: ignore[import]
    except ImportError as exc:
        raise RuntimeError("Merging audio with different sample rates requires torchaudio.") from exc

    if sample_rate_1 > sample_rate_2:
        logger.info("Resampling audio2 from %sHz to %sHz for merging.", sample_rate_2, sample_rate_1)
        return (
            waveform_1,
            torchaudio.functional.resample(waveform_2, sample_rate_2, sample_rate_1),
            sample_rate_1,
        )

    logger.info("Resampling audio1 from %sHz to %sHz for merging.", sample_rate_1, sample_rate_2)
    return (
        torchaudio.functional.resample(waveform_1, sample_rate_1, sample_rate_2),
        waveform_2,
        sample_rate_2,
    )


def merge_two_audio(audio1: dict | None, audio2: dict | None, merge_method: str = "add") -> dict | None:
    """Merge two AUDIO dicts, matching ComfyUI's core AudioMerge behavior."""
    if audio1 is None and audio2 is None:
        return None
    if audio1 is None:
        return audio2
    if audio2 is None:
        return audio1
    if merge_method not in {"add", "mean", "subtract", "multiply"}:
        raise ValueError(f"Unsupported audio merge method: {merge_method}")

    waveform_1 = audio1["waveform"]
    waveform_2 = audio2["waveform"]
    sample_rate_1 = int(audio1["sample_rate"])
    sample_rate_2 = int(audio2["sample_rate"])

    waveform_1, waveform_2, output_sample_rate = match_audio_sample_rates(
        waveform_1,
        sample_rate_1,
        waveform_2,
        sample_rate_2,
    )

    length_1 = waveform_1.shape[-1]
    length_2 = waveform_2.shape[-1]

    if length_1 == 0 or length_2 == 0:
        return {"waveform": waveform_1, "sample_rate": output_sample_rate}

    if length_2 > length_1:
        logger.info(
            "Audio merge: Trimming audio2 from %s to %s samples to match audio1 length.",
            length_2,
            length_1,
        )
        waveform_2 = waveform_2[..., :length_1]
    elif length_2 < length_1:
        logger.info(
            "Audio merge: Padding audio2 from %s to %s samples to match audio1 length.",
            length_2,
            length_1,
        )
        waveform_2 = F.pad(waveform_2, (0, length_1 - length_2))

    if merge_method == "add":
        waveform = waveform_1 + waveform_2
    elif merge_method == "subtract":
        waveform = waveform_1 - waveform_2
    elif merge_method == "multiply":
        waveform = waveform_1 * waveform_2
    else:
        waveform = (waveform_1 + waveform_2) / 2

    max_val = waveform.abs().max()
    if max_val > 1.0:
        waveform = waveform / max_val

    return {"waveform": waveform, "sample_rate": output_sample_rate}


# ── video helpers ──────────────────────────────────────────────────────────

def _video_output_suffix(path: str) -> str:
    """Return a standard video suffix, ignoring ComfyUI URL-style annotations."""
    clean_path = path.split("?", 1)[0].split("&", 1)[0]
    suffix = os.path.splitext(clean_path)[1].lower()
    if suffix in _VIDEO_EXTENSIONS:
        return suffix
    return ".mp4"


def get_ffmpeg_path(name: str = "ffmpeg") -> str | None:
    """Find FFmpeg/ffprobe executable, with Windows-specific fallbacks."""
    ffmpeg = shutil.which(name) or shutil.which(f"{name}.exe")
    if ffmpeg:
        return ffmpeg
    if os.name == "nt":
        for path in (
            r"C:\ffmpeg\bin\{}.exe".format(name),
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\{}\bin\{}.exe".format(name, name)),
        ):
            if os.path.isfile(path):
                return path
    return None


def video_input_to_local_file(
    video: Any,
    suffix: str = ".mp4",
    save_kwargs: dict[str, Any] | None = None,
) -> tuple[str, list[str]]:
    """Return a local video file path, serializing non-file VIDEO inputs to temp."""
    temp_files: list[str] = []
    try:
        source = video.get_stream_source()
    except (AttributeError, NotImplementedError, RuntimeError, TypeError, ValueError):
        source = None

    if isinstance(source, str) and os.path.isfile(source):
        return source, temp_files
    if isinstance(source, _io.BytesIO):
        source.seek(0)
        output_fd, output_path = tempfile.mkstemp(
            suffix=suffix,
            dir=folder_paths.get_temp_directory(),
        )
        try:
            os.write(output_fd, source.read())
        finally:
            os.close(output_fd)
        temp_files.append(output_path)
        return output_path, temp_files

    output_fd, output_path = tempfile.mkstemp(
        suffix=suffix,
        dir=folder_paths.get_temp_directory(),
    )
    os.close(output_fd)
    try:
        kwargs = save_kwargs or {}
        video.save_to(output_path, **kwargs)
    except Exception:
        try:
            os.unlink(output_path)
        except OSError:
            pass
        raise
    temp_files.append(output_path)
    return output_path, temp_files


@dataclass(frozen=True)
class MergeSpec:
    width: int
    height: int
    fps: Fraction
    has_audio: bool
    sample_rate: int | None
    channels: int | None


def extract_merge_spec(video: Any) -> MergeSpec:
    """Extract a MergeSpec from a VideoInput object for compatibility checks."""
    components = video.get_components()
    fps: Fraction = components.frame_rate
    width, height = video.get_dimensions()

    audio = components.audio
    if audio is None:
        has_audio = False
        sample_rate = None
        channels = None
    else:
        has_audio = True
        if isinstance(audio, dict):
            sample_rate = int(audio.get("sample_rate") or 0)
            waveform = audio.get("waveform")
            channels = int(waveform.shape[1]) if waveform is not None else None
        else:
            sample_rate = None
            channels = None

    return MergeSpec(
        width=width,
        height=height,
        fps=fps,
        has_audio=has_audio,
        sample_rate=sample_rate,
        channels=channels,
    )


def validate_merge_compatibility(specs: list[MergeSpec]) -> None:
    """Raise ValueError if the given specs are not all merge-compatible."""
    if not specs:
        raise ValueError("At least one video is required")

    baseline = specs[0]
    labels = ("width", "height", "fps", "has_audio", "sample_rate", "channels")
    for index, spec in enumerate(specs[1:], start=2):
        for label in labels:
            baseline_val = getattr(baseline, label)
            spec_val = getattr(spec, label)
            if baseline_val != spec_val:
                raise ValueError(
                    f"Video {index} is incompatible: '{label}' mismatch "
                    f"(expected {baseline_val!r}, got {spec_val!r})"
                )


def ffmpeg_concat(
    input_paths: list[str],
    output_path: str,
    progress_callback: "callable[[str], None] | None" = None,
) -> bool:
    """Concatenate video files using FFmpeg concat demuxer."""
    ffmpeg = get_ffmpeg_path("ffmpeg")
    if not ffmpeg:
        return False

    list_fd, list_path = tempfile.mkstemp(suffix=".txt")
    try:
        with os.fdopen(list_fd, "w", encoding="utf-8") as f:
            for p in input_paths:
                escaped = p.replace("\\", "\\\\").replace("'", "\\'")
                f.write(f"file '{escaped}'\n")

        base_cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", list_path]

        if progress_callback:
            progress_callback("FFmpeg concat (stream copy)…")
        result = subprocess.run(
            base_cmd + ["-c", "copy", output_path],
            capture_output=True,
        )

        if result.returncode == 0:
            return True

        logger.warning(
            "[ffmpeg_concat] stream copy failed (rc=%d), retrying with re-encode. "
            "stderr: %s",
            result.returncode,
            result.stderr.decode(errors="replace")[-400:],
        )

        if progress_callback:
            progress_callback("FFmpeg concat (re-encoding)…")
        result2 = subprocess.run(
            base_cmd + [
                "-c:v", "libx264", "-preset", "fast",
                "-c:a", "aac",
                output_path,
            ],
            capture_output=True,
        )
        if result2.returncode != 0:
            raise RuntimeError(
                f"FFmpeg concat failed:\n{result2.stderr.decode(errors='replace')[-600:]}"
            )
        return True
    finally:
        try:
            os.unlink(list_path)
        except OSError:
            pass


def _parse_rate(value: str | None) -> Fraction | None:
    if not value:
        return None
    if "/" in value:
        num, denom = value.split("/", 1)
        try:
            numerator = int(num)
            denominator = int(denom)
        except ValueError:
            return None
        if denominator > 0 and numerator > 0:
            return Fraction(numerator, denominator)
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    if parsed <= 0:
        return None
    return Fraction(parsed).limit_denominator(100000)


def _parse_positive_float(value: str | None) -> float | None:
    if value in (None, "", "N/A"):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed <= 0:
        return None
    return parsed


def _parse_video_stream(stream: dict) -> "tuple[int | None, int | None, float | None, Fraction | None, int | None]":
    """Extract width, height, fps, and frame count from a video stream dict."""
    width = int(stream["width"]) if stream.get("width") else None
    height = int(stream["height"]) if stream.get("height") else None
    fps_fraction = _parse_rate(stream.get("avg_frame_rate")) or _parse_rate(stream.get("r_frame_rate"))
    fps = float(fps_fraction) if fps_fraction is not None else None
    raw_frame_count = stream.get("nb_read_frames") or stream.get("nb_frames")
    frame_count = None
    if raw_frame_count not in (None, "N/A"):
        try:
            frame_count = int(raw_frame_count)
        except (TypeError, ValueError):
            frame_count = None
    return width, height, fps, fps_fraction, frame_count


def ffprobe_info(path: str) -> dict[str, Any]:
    """Return basic media info (duration, has_video, has_audio, width, height, fps) via ffprobe."""
    ffprobe = get_ffmpeg_path("ffprobe")
    if not ffprobe:
        return {}
    result = subprocess.run(
        [
            ffprobe, "-v", "error",
            "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames",
            "-of", "json",
            path,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {}
    try:
        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        codec_types = {s.get("codec_type") for s in streams}
        duration_str = data.get("format", {}).get("duration")

        width = height = fps = frame_count = None
        fps_fraction = None
        for stream in streams:
            if stream.get("codec_type") == "video":
                width, height, fps, fps_fraction, frame_count = _parse_video_stream(stream)
                break

        duration = _parse_positive_float(duration_str)
        if frame_count is None and duration is not None and fps:
            frame_count = max(1, round(duration * fps))

        return {
            "duration": duration,
            "has_video": "video" in codec_types,
            "has_audio": "audio" in codec_types,
            "width": width,
            "height": height,
            "fps": fps,
            "fps_fraction": fps_fraction,
            "frame_count": frame_count,
        }
    except Exception:
        return {}


def trim_video_with_ffmpeg(
    input_path: str,
    frame_count: int,
    progress_callback: "callable[[str], None] | None" = None,
) -> str | None:
    """Trim a video to ``frame_count`` frames based on its detected fps."""
    if frame_count <= 0:
        return None

    ffmpeg = get_ffmpeg_path("ffmpeg")
    if not ffmpeg or not os.path.isfile(input_path):
        return None

    fps = ffprobe_info(input_path).get("fps")
    if not isinstance(fps, (int, float)) or fps <= 0:
        return None

    duration = frame_count / float(fps)
    suffix = _video_output_suffix(input_path)
    output_fd, output_path = tempfile.mkstemp(
        suffix=suffix,
        dir=folder_paths.get_temp_directory(),
    )
    os.close(output_fd)

    base_cmd = [
        ffmpeg,
        "-y",
        "-t",
        f"{duration:.6f}",
        "-i",
        input_path,
        "-map",
        "0",
    ]

    if progress_callback:
        progress_callback(f"FFmpeg trim to {frame_count} frames ({duration:.3f}s)…")

    result = subprocess.run(
        base_cmd + ["-c", "copy", "-avoid_negative_ts", "make_zero", output_path],
        capture_output=True,
    )
    if result.returncode == 0:
        return output_path

    logger.warning(
        "[trim_video_with_ffmpeg] stream copy failed (rc=%d), retrying with re-encode. "
        "stderr: %s",
        result.returncode,
        result.stderr.decode(errors="replace")[-400:],
    )

    result2 = subprocess.run(
        base_cmd + [
            "-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac",
            output_path,
        ],
        capture_output=True,
    )
    if result2.returncode == 0:
        return output_path

    try:
        os.unlink(output_path)
    except OSError:
        pass
    raise RuntimeError(
        f"FFmpeg trim failed:\n{result2.stderr.decode(errors='replace')[-600:]}"
    )


def ffmpeg_supports_xfade() -> bool:
    """Return True if the installed FFmpeg build includes the xfade filter (requires 4.3+)."""
    for name in ("ffmpeg", "ffmpeg-full"):
        ffmpeg = get_ffmpeg_path(name)
        if not ffmpeg:
            continue
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and "xfade" in result.stdout:
            return True
    return False


def ffmpeg_replace_audio(
    video_path: str,
    audio_path: str,
    output_path: str,
) -> bool:
    """Replace (or add) the audio track of a video file using FFmpeg stream copy."""
    ffmpeg = get_ffmpeg_path("ffmpeg")
    if not ffmpeg:
        return False

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-i", audio_path,
        "-c:v", "copy",
        "-c:a", "aac",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-shortest",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"FFmpeg replace-audio failed:\n{result.stderr.decode(errors='replace')[-600:]}"
        )
    return True


def _load_wav_audio(path: str) -> dict:
    try:
        import soundfile as sf  # type: ignore[import]

        data, sample_rate = sf.read(path, dtype="float32", always_2d=True)
        waveform = torch.from_numpy(data.T).unsqueeze(0)
        return {"waveform": waveform, "sample_rate": int(sample_rate)}
    except Exception:
        try:
            import torchaudio  # type: ignore[import]

            waveform, sample_rate = torchaudio.load(path)
            return {"waveform": waveform.unsqueeze(0), "sample_rate": int(sample_rate)}
        except Exception as exc:
            raise RuntimeError("Failed to load extracted audio with soundfile or torchaudio.") from exc


def ffmpeg_extract_audio(video_path: str) -> dict | None:
    """Extract a video's audio track to a ComfyUI AUDIO dict using FFmpeg."""
    ffmpeg = get_ffmpeg_path("ffmpeg")
    if not ffmpeg:
        return None
    if not os.path.isfile(video_path):
        return None

    tmp_fd, audio_path = tempfile.mkstemp(suffix=".wav", dir=folder_paths.get_temp_directory())
    os.close(tmp_fd)
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        video_path,
        "-vn",
        "-acodec",
        "pcm_s16le",
        audio_path,
    ]
    try:
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode != 0:
            logger.warning(
                "[ffmpeg_extract_audio] FFmpeg audio extraction failed: %s",
                result.stderr.decode("utf-8", errors="replace").strip()[-600:],
            )
            return None
        return _load_wav_audio(audio_path)
    except Exception as exc:
        logger.warning("[ffmpeg_extract_audio] FFmpeg audio extraction error: %s", exc)
        return None
    finally:
        try:
            os.unlink(audio_path)
        except OSError:
            pass

# ── Helpers ──────────────────────────────────────────────────────────────

def _save_audio_to_temp_wav(audio: dict) -> str | None:
    """Backward-compatible wrapper for the shared AUDIO serializer."""
    path = save_audio_to_temp_wav(audio)
    return str(path) if path is not None else None


def _replace_video_audio_with_ffmpeg(source_video: Input.Video, audio: dict, tag: str) -> Input.Video:
    """Mux ``audio`` onto ``source_video`` without copying file-backed VIDEO inputs first."""
    ext = Types.VideoContainer.get_extension(Types.VideoContainer.AUTO)
    video_path: str | None = None
    video_temp_files: list[str] = []
    audio_path: str | None = None
    output_path: str | None = None
    completed = False
    try:
        video_path, video_temp_files = video_input_to_local_file(
            source_video,
            suffix=f".{ext}",
            save_kwargs={
                "format": Types.VideoContainer.AUTO,
                "codec": Types.VideoCodec.AUTO,
            },
        )
        audio_path = _save_audio_to_temp_wav(audio)
        if audio_path is None:
            raise ValueError(f"{tag} could not serialize the AUDIO input.")

        output_ext = os.path.splitext(video_path)[1] or f".{ext}"
        output_fd, output_path = tempfile.mkstemp(
            suffix=output_ext,
            dir=folder_paths.get_temp_directory(),
        )
        os.close(output_fd)
        if not ffmpeg_replace_audio(video_path, audio_path, output_path):
            raise RuntimeError(f"{tag} requires FFmpeg to attach the AUDIO input.")
        completed = True
        return InputImpl.VideoFromFile(output_path)
    except (ValueError, RuntimeError):
        raise
    except Exception as exc:
        raise RuntimeError(f"{tag} failed to attach the AUDIO input with FFmpeg.") from exc
    finally:
        for path in [*video_temp_files, audio_path]:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        if output_path and not completed:
            try:
                os.unlink(output_path)
            except OSError:
                pass


def _attach_video_audio_with_ffmpeg(
    source_video: Input.Video,
    audio: dict,
    audio_mode: str,
    tag: str,
) -> Input.Video:
    """Merge or override the source audio track with the supplied AUDIO input."""
    if audio_mode not in {"merge", "override"}:
        raise ValueError(f"{tag} unsupported audio mode: {audio_mode!r}.")

    output_audio = audio
    if audio_mode == "merge":
        original_audio = _extract_audio_with_ffmpeg(source_video)
        output_audio = merge_two_audio(original_audio, audio, "add")
        if output_audio is None:
            raise ValueError(f"{tag} could not prepare audio for merging.")

    return _replace_video_audio_with_ffmpeg(source_video, output_audio, tag)


def _video_to_local_file(video: Input.Video) -> "tuple[str | None, list[str]]":
    """Return a local file path for ffmpeg, creating temp files when needed."""
    temp_files: list[str] = []
    try:
        source = video.get_stream_source()
    except (AttributeError, RuntimeError, ValueError, TypeError):
        source = None

    if isinstance(source, str) and os.path.isfile(source):
        return source, temp_files
    if isinstance(source, _io.BytesIO):
        source.seek(0)
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp4", dir=folder_paths.get_temp_directory())
        try:
            os.write(tmp_fd, source.read())
        finally:
            os.close(tmp_fd)
        temp_files.append(tmp_path)
        return tmp_path, temp_files

    ext = Types.VideoContainer.get_extension(Types.VideoContainer.AUTO)
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".{ext}", dir=folder_paths.get_temp_directory())
    os.close(tmp_fd)
    try:
        video.save_to(tmp_path, format=Types.VideoContainer.AUTO, codec=Types.VideoCodec.AUTO)
    except Exception as exc:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        logger.warning("[MiniMaxRefMergeVideosFromPaths] Failed to serialize VIDEO for FFmpeg: %s", exc)
        return None, temp_files
    temp_files.append(tmp_path)
    return tmp_path, temp_files


def _extract_audio_with_ffmpeg(video: Input.Video) -> "dict | None":
    source_path, temp_files = _video_to_local_file(video)
    if source_path is None:
        return None

    try:
        return ffmpeg_extract_audio(source_path)
    finally:
        for path in temp_files:
            try:
                os.unlink(path)
            except OSError:
                pass


def _extract_audio_waveform(audio: object) -> "tuple[torch.Tensor | None, int | None]":
    """Return (waveform, sample_rate) from a ComfyUI audio dict, or (None, None)."""
    if not isinstance(audio, dict):
        return None, None
    waveform = audio.get("waveform")
    sr = audio.get("sample_rate")
    return waveform, int(sr) if sr is not None else None


def _collect_video_components(
    videos: list,
    has_audio: bool,
) -> "tuple[torch.Tensor, dict | None]":
    """Extract and concatenate image frames (and optionally audio) from video objects."""
    all_images: list[torch.Tensor] = []
    all_waveforms: list[torch.Tensor] = []
    sample_rate: int | None = None

    for video in videos:
        components = video.get_components()
        all_images.append(components.images)
        if has_audio and components.audio is not None:
            waveform, sr = _extract_audio_waveform(components.audio)
            if waveform is not None:
                all_waveforms.append(waveform)
            if sample_rate is None and sr is not None:
                sample_rate = sr

    merged_audio: dict | None = None
    if has_audio and all_waveforms:
        merged_audio = {"waveform": torch.cat(all_waveforms, dim=2), "sample_rate": sample_rate}

    return torch.cat(all_images, dim=0), merged_audio


def _tensor_merge_video_files(
    sources: list[str],
    total: int,
    progress: "callable[[int, str], None]",
):
    """Load video files and merge them frame-by-frame using torch.cat (tensor fallback)."""
    progress(total, "Loading clips for tensor merge…")
    videos = []
    for i, source in enumerate(sources, start=1):
        progress(total, f"Loading clip {i}/{total}")
        videos.append(InputImpl.VideoFromFile(source))

    specs = [extract_merge_spec(v) for v in videos]
    validate_merge_compatibility(specs)

    progress(total + 1, "Merging frames…")
    merged_images, merged_audio = _collect_video_components(videos, specs[0].has_audio)

    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=merged_images,
            audio=merged_audio,
            frame_rate=specs[0].fps,
        )
    )


def _parse_path_list(paths: "str | list[str]") -> list[str]:
    """Parse a newline/comma-separated path string into a list of non-empty paths."""
    lines = paths if isinstance(paths, list) else paths.replace(",", "\n").splitlines()
    return [line.strip() for line in lines if line.strip()]


def _log_ffmpeg_unavailable_hint(tag: str, need_xfade: bool = False) -> None:
    """Log an actionable install hint when FFmpeg (or xfade) is not available."""
    import shutil
    if not shutil.which("ffmpeg"):
        logger.warning(
            "%s FFmpeg not installed — using tensor fallback (slower). "
            "Install FFmpeg for faster video processing: %s",
            tag, _FFMPEG_INSTALL_URL,
        )
    elif need_xfade and not ffmpeg_supports_xfade():
        logger.warning(
            "%s xfade filter not available in this FFmpeg build (requires FFmpeg 4.3+) — "
            "Upgrade to a full FFmpeg build: %s",
            tag, _FFMPEG_INSTALL_URL,
        )


def _trim_video_to_frame_count(
    source: str,
    frame_count: int,
    tag: str,
    progress: "callable[[str], None] | None" = None,
) -> str:
    """Trim source when requested, raising if the requested trim cannot be performed."""
    if frame_count <= 0:
        return source
    try:
        trimmed = trim_video_with_ffmpeg(source, frame_count, progress_callback=progress)
    except RuntimeError as exc:
        raise RuntimeError(f"{tag} failed to trim merged video to {frame_count} frames.") from exc
    if trimmed is None:
        raise RuntimeError(
            f"{tag} cannot trim to {frame_count} frames. "
            "Install FFmpeg/FFprobe and ensure the merged video has a detectable frame rate."
        )
    return trimmed


def _resolve_video_path(raw: str) -> str | _io.BytesIO:
    """Resolve a raw path string to a local file path or BytesIO buffer.

    Supported formats:
    - HTTP/HTTPS URL
    - ``input/<filename>`` — file in ComfyUI input directory
    - ``temp/<filename>`` — file in ComfyUI temp directory
    - ``output/<filename>`` — file in ComfyUI output directory
    - Absolute file path
    - ComfyUI annotated path (filename[subfolder][type]) via folder_paths
    - Bare filename resolved against output then temp directories
    """
    raw = raw.strip()
    if not raw:
        raise ValueError("Empty path string")

    # URL
    if raw.startswith(("http://", "https://")):
        with urllib.request.urlopen(raw, timeout=30) as resp:  # noqa: S310
            return _io.BytesIO(resp.read())

    # ComfyUI-style prefixed paths: temp/<file> or output/<file>
    _PREFIXED = {
        "input": folder_paths.get_input_directory,
        "temp": folder_paths.get_temp_directory,
        "output": folder_paths.get_output_directory,
    }
    for prefix, get_dir in _PREFIXED.items():
        if raw.startswith(prefix + "/") or raw.startswith(prefix + os.sep):
            rel = raw[len(prefix) + 1:]
            base_dir = os.path.realpath(get_dir())
            candidate = os.path.realpath(os.path.join(base_dir, rel))
            if os.path.commonpath((base_dir, candidate)) != base_dir:
                raise ValueError(f"Path escapes the ComfyUI {prefix!r} directory: {rel!r}")
            if os.path.isfile(candidate):
                return candidate
            raise FileNotFoundError(f"File not found in {prefix!r} directory: {rel!r}")

    # Absolute path
    if os.path.isabs(raw) and os.path.isfile(raw):
        return raw

    # ComfyUI annotated path
    try:
        annotated = folder_paths.get_annotated_filepath(raw)
        if os.path.isfile(annotated):
            return annotated
    except Exception:
        pass

    # Bare filename: check output, temp, then input directories
    for base_dir in (
        folder_paths.get_output_directory(),
        folder_paths.get_temp_directory(),
        folder_paths.get_input_directory(),
    ):
        candidate = os.path.join(base_dir, raw)
        if os.path.isfile(candidate):
            return candidate

    raise FileNotFoundError(f"Cannot resolve video path: {raw!r}")


def _expand_comfy_video_path_patterns(raw_paths: list[str]) -> list[str]:
    """Expand recursive glob patterns under ComfyUI input/output/temp directories."""
    prefix_dirs = {
        "input": folder_paths.get_input_directory,
        "temp": folder_paths.get_temp_directory,
        "output": folder_paths.get_output_directory,
    }
    expanded: list[str] = []
    for raw in raw_paths:
        matched_prefix = next(
            (prefix for prefix in prefix_dirs if raw.startswith(prefix + "/") or raw.startswith(prefix + os.sep)),
            None,
        )
        if matched_prefix is None:
            expanded.append(raw)
            continue

        relative_pattern = raw[len(matched_prefix) + 1:]
        if not glob.has_magic(relative_pattern):
            expanded.append(raw)
            continue

        base_dir = os.path.realpath(prefix_dirs[matched_prefix]())
        absolute_pattern = os.path.abspath(os.path.join(base_dir, relative_pattern))
        if os.path.commonpath((base_dir, absolute_pattern)) != base_dir:
            raise ValueError(
                f"Path pattern escapes the ComfyUI {matched_prefix!r} directory: {relative_pattern!r}"
            )

        matches = []
        for match in sorted(glob.glob(absolute_pattern, recursive=True)):
            resolved_match = os.path.realpath(match)
            if os.path.commonpath((base_dir, resolved_match)) == base_dir and os.path.isfile(resolved_match):
                matches.append(resolved_match)
        if not matches:
            raise FileNotFoundError(f"No video files match path pattern: {raw!r}")
        expanded.extend(matches)
    return expanded


def _get_video_fps(video_path: str) -> "float | None":
    """Get video frame rate using ffprobe.  Returns ``None`` when undetectable."""
    import json as _json
    import shutil as _shutil
    import subprocess as _subprocess

    if not _shutil.which("ffprobe"):
        return None
    try:
        proc = _subprocess.run(
            [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_format", "-show_streams", video_path,
            ],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            return None
        info = _json.loads(proc.stdout)
        for stream in info.get("streams", []):
            if stream.get("codec_type") == "video":
                fps_str = stream.get("r_frame_rate", "")
                if "/" in fps_str:
                    num_s, den_s = fps_str.split("/", 1)
                    try:
                        den = int(den_s)
                        if den != 0:
                            return int(num_s) / den
                    except (ValueError, TypeError):
                        pass
                try:
                    return float(fps_str)
                except (ValueError, TypeError):
                    pass
        return None
    except Exception:
        return None


def _reencode_video_to_fps(src_path: str, target_fps: float, dst_path: str) -> bool:
    """Re-encode *src_path* to *target_fps* using ffmpeg (h264+aac)."""
    import shutil as _shutil
    import subprocess as _subprocess

    if not _shutil.which("ffmpeg"):
        return False
    try:
        proc = _subprocess.run(
            [
                "ffmpeg", "-y", "-i", src_path,
                "-r", str(target_fps),
                "-c:v", "libx264", "-preset", "fast",
                "-c:a", "aac",
                dst_path,
            ],
            capture_output=True, text=True, timeout=300,
        )
        return proc.returncode == 0 and os.path.isfile(dst_path)
    except Exception:
        return False


def _normalize_video_fps_list(
    resolved: "list[str]",
    temp_files: "list[str]",
    tag: str,
) -> "list[str]":
    """Ensure all videos share the same fps (first video's fps is the reference).

    Videos whose fps cannot be detected are left unchanged (best-effort).
    Re-encoded copies are appended to *temp_files* so they get cleaned up later.
    """
    if len(resolved) < 2:
        return resolved

    ref_fps = _get_video_fps(resolved[0])
    if ref_fps is None:
        return resolved

    normalized: list[str] = [resolved[0]]
    for i in range(1, len(resolved)):
        cur_fps = _get_video_fps(resolved[i])
        if cur_fps is not None and abs(cur_fps - ref_fps) < 0.01:
            normalized.append(resolved[i])
            continue

        ext = os.path.splitext(resolved[i])[1] or ".mp4"
        tmp_fd, tmp_path = tempfile.mkstemp(
            suffix=ext, dir=folder_paths.get_temp_directory(),
        )
        os.close(tmp_fd)
        if cur_fps is not None and _reencode_video_to_fps(resolved[i], ref_fps, tmp_path):
            logger.info(
                "%s fps mismatch – re-encoded clip %d (%.2f → %.2f)",
                tag, i + 1, cur_fps, ref_fps,
            )
            temp_files.append(tmp_path)
            normalized.append(tmp_path)
        else:
            logger.warning(
                "%s cannot determine or re-encode fps for clip %d; "
                "merging may fail if specifications differ.",
                tag, i + 1,
            )
            normalized.append(resolved[i])
    return normalized


# ── Node ──────────────────────────────────────────────────────────────────

class MiniMaxRefMergeVideosFromPaths(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefMergeVideosFromPaths",
            display_name="Merge Videos From Paths",
            category="minimaxrefdirector",
            description=(
                "Load and concatenate videos from a list of file paths or URLs. "
                "Supports ComfyUI input/temp/output paths and subdirectory globs, absolute local paths, and HTTP(S) URLs. "
                "All clips must share the same fps, dimensions, and audio configuration."
            ),
            inputs=[
                io.String.Input(
                    "paths",
                    force_input=True,
                    multiline=True,
                    default="",
                    tooltip=(
                        "One path per line (or comma-separated). "
                        "Accepts ComfyUI input/output/temp paths (including subdirectories and ** globs), "
                        "absolute paths, or URLs."
                    ),
                ),
                io.Int.Input(
                    "frame_count",
                    default=-1,
                    min=-1,
                    step=1,
                    tooltip="Maximum frames to keep after merging. Use -1 to keep all frames.",
                ),
                io.Combo.Input(
                    "audio_mode",
                    options=["merge", "override"],
                    default="merge",
                    tooltip="Merge the AUDIO input with the video's existing audio, or override it.",
                ),
                io.Audio.Input(
                    "audio",
                    optional=True,
                    tooltip="Optional audio to replace or add to the final merged VIDEO using FFmpeg.",
                ),
            ],
            hidden=[io.Hidden.unique_id],
            outputs=[
                io.Video.Output(display_name="VIDEO"),
            ],
        )

    @classmethod
    def execute(
        cls,
        paths: str,
        frame_count: int = -1,
        audio_mode: str = "merge",
        audio: Optional[dict] = None,
    ) -> io.NodeOutput:
        raw_paths = _expand_comfy_video_path_patterns(_parse_path_list(paths))
        if len(raw_paths) == 0:
            raise ValueError("At least 1 video path is required.")

        total = len(raw_paths)
        pbar = ProgressBar(total + 2)

        def _progress(step: int, _msg: str) -> None:
            pbar.update_absolute(step, total + 2)

        def _cleanup_owned(paths_to_clean: set[str], keep: str | None = None) -> None:
            for path in paths_to_clean:
                if path == keep:
                    continue
                try:
                    os.unlink(path)
                except OSError:
                    pass

        def _finalize_video(
            video: Input.Video,
            message: str,
            owned_paths: set[str] | None = None,
            final_path: str | None = None,
        ) -> io.NodeOutput:
            paths_to_clean = owned_paths or set()
            if audio is not None:
                try:
                    video = _attach_video_audio_with_ffmpeg(
                        video,
                        audio,
                        audio_mode,
                        "[MiniMaxRefMergeVideosFromPaths]",
                    )
                finally:
                    _cleanup_owned(paths_to_clean)
                    paths_to_clean.clear()
            else:
                _cleanup_owned(paths_to_clean, keep=final_path)
                paths_to_clean.clear()
            _progress(total + 2, message)
            return io.NodeOutput(video)

        if len(raw_paths) == 1:
            _progress(0, f"Loading single video: {raw_paths[0]}")
            owned_paths: set[str] = set()
            try:
                source = _resolve_video_path(raw_paths[0])
                if isinstance(source, _io.BytesIO):
                    source.seek(0)
                    ext = os.path.splitext(raw_paths[0])[1] or ".mp4"
                    tmp_fd, tmp_path = tempfile.mkstemp(suffix=ext, dir=folder_paths.get_temp_directory())
                    os.write(tmp_fd, source.read())
                    os.close(tmp_fd)
                    source = tmp_path
                    owned_paths.add(tmp_path)

                _progress(1, "Trimming …")
                final_path: str = source
                if frame_count > 0:
                    try:
                        final_path = _trim_video_to_frame_count(
                            source,
                            frame_count,
                            "[MiniMaxRefMergeVideosFromPaths]",
                            progress=lambda msg: _progress(1, msg),
                        )
                    except RuntimeError as exc:
                        logger.warning(
                            "[MiniMaxRefMergeVideosFromPaths] trim skipped (%s) — "
                            "returning full-length video.", exc,
                        )
                        final_path = source
                if final_path != source:
                    owned_paths.add(final_path)

                _progress(2, "Loading video tensor …")
                merged_video = InputImpl.VideoFromFile(final_path)
                return _finalize_video(
                    merged_video,
                    "Done — loaded single video",
                    owned_paths=owned_paths,
                    final_path=final_path,
                )
            except Exception:
                _cleanup_owned(owned_paths)
                raise

        _progress(0, f"Resolving {total} paths…")
        resolved: list[str | _io.BytesIO] = []
        temp_files: list[str] = []
        for i, raw in enumerate(raw_paths, start=1):
            _progress(i - 1, f"Resolving {i}/{total}: {raw}")
            try:
                source = _resolve_video_path(raw)
            except (FileNotFoundError, ValueError) as exc:
                raise ValueError(f"Clip {i}: {exc}") from exc

            if isinstance(source, _io.BytesIO):
                source.seek(0)
                ext = os.path.splitext(raw)[1] or ".mp4"
                tmp_fd, tmp_path = tempfile.mkstemp(suffix=ext, dir=folder_paths.get_temp_directory())
                os.write(tmp_fd, source.read())
                os.close(tmp_fd)
                source = tmp_path
                temp_files.append(tmp_path)

            resolved.append(source)

        # --- Normalize fps so all clips share a common frame rate ---
        resolved_str: list[str] = []  # all items are guaranteed strings at runtime
        for p in resolved:
            if isinstance(p, str):
                resolved_str.append(p)
        resolved_str = _normalize_video_fps_list(
            resolved_str, temp_files, "[MiniMaxRefMergeVideosFromPaths]",
        )
        resolved = resolved_str  # type: ignore[assignment]

        string_paths = [p for p in resolved if isinstance(p, str)]
        ext = os.path.splitext(string_paths[0])[1] if string_paths else ".mp4"
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=ext, dir=folder_paths.get_temp_directory())
        os.close(tmp_fd)
        generated_outputs = {tmp_path}

        tag = "[MiniMaxRefMergeVideosFromPaths]"

        try:
            # --- FFmpeg concat (stream copy preferred, fastest) ---
            try:
                _progress(total, f"Merging {total} clips via FFmpeg…")
                success = ffmpeg_concat(
                    resolved,
                    tmp_path,
                    progress_callback=lambda msg: _progress(total, msg),
                )
                if success:
                    logger.info("%s backend=ffmpeg-concat (stream copy), transition=none ✓", tag)
                    trimmed_path = _trim_video_to_frame_count(
                        tmp_path,
                        frame_count,
                        tag,
                        progress=lambda msg: _progress(total + 1, msg),
                    )
                    if trimmed_path != tmp_path:
                        generated_outputs.add(trimmed_path)
                    tmp_path = trimmed_path
                    merged_video = InputImpl.VideoFromFile(tmp_path)
                    return _finalize_video(
                        merged_video,
                        f"Done — merged {total} clips",
                        owned_paths=generated_outputs,
                        final_path=tmp_path,
                    )
                _log_ffmpeg_unavailable_hint(tag)
            except RuntimeError as exc:
                logger.warning(
                    "%s ffmpeg concat failed: %s — falling back to tensor merge.", tag, exc
                )

            # --- Slow fallback: tensor-based merge ---
            logger.info("%s backend=tensor-merge, transition=none (ffmpeg unavailable)", tag)
            merged_video = _tensor_merge_video_files(resolved, total, _progress)
            return _finalize_video(
                merged_video,
                f"Done — merged {total} clips",
                owned_paths=generated_outputs,
            )
        finally:
            _cleanup_owned(generated_outputs)
            for f in temp_files:
                try:
                    os.unlink(f)
                except OSError:
                    pass

class MiniMaxRefSaveImage(io.ComfyNode):
    """Save images to the ComfyUI output directory."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefSaveImage",
            display_name="MiniMaxRef Save Image",
            category="minimax",
            description=(
                "Saves the input images to the ComfyUI output directory "
                "(ComfyUI/output) with the given filename prefix."
            ),
            inputs=[
                io.Image.Input("images", tooltip="The images to save."),
                io.String.Input(
                    "filename_prefix",
                    default="Tenz",
                    tooltip=(
                        "The filename prefix for the saved files. "
                        "Images are saved to the ComfyUI output directory."
                    ),
                ),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
            outputs=[io.Image.Output(display_name="images", tooltip="The saved images.")],
        )

    @classmethod
    def execute(cls, images, filename_prefix="Tenz") -> io.NodeOutput:
        if images is None:
            return io.NodeOutput(None)
        return io.NodeOutput(
            images,
            ui=UI.ImageSaveHelper.get_save_images_ui(
                images=images,
                filename_prefix=filename_prefix,
                cls=cls,
            ),
        )


class MiniMaxRefSaveAudio(io.ComfyNode):
    """Save audio to the ComfyUI output directory."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefSaveAudio",
            search_aliases=[
                "save audio", "export audio", "output audio", "write audio",
                "flac", "mp3", "opus",
            ],
            display_name="MiniMaxRef Save Audio",
            description=(
                "Saves the input audio to the ComfyUI output directory "
                "(ComfyUI/output) with the given filename prefix."
            ),
            category="minimax",
            inputs=[
                io.Audio.Input("audio", tooltip="The audio to save."),
                io.String.Input(
                    "filename_prefix",
                    default="Tenz/audio",
                    tooltip=(
                        "The prefix for the file to save. "
                        "Audio is saved to the ComfyUI output directory."
                    ),
                ),
                io.DynamicCombo.Input(
                    "format",
                    options=[
                        io.DynamicCombo.Option("flac", []),
                        io.DynamicCombo.Option("mp3", [
                            io.Combo.Input(
                                "quality",
                                options=["V0", "128k", "320k"],
                                default="V0",
                            ),
                        ]),
                        io.DynamicCombo.Option("opus", [
                            io.Combo.Input(
                                "quality",
                                options=["64k", "96k", "128k", "192k", "320k"],
                                default="128k",
                            ),
                        ]),
                    ],
                    tooltip="The file format in which to save the audio.",
                ),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
            outputs=[io.Audio.Output("audio", tooltip="The saved audio.")],
        )

    @classmethod
    def execute(cls, audio, filename_prefix: str, format: dict) -> io.NodeOutput:
        if audio is None:
            return io.NodeOutput(None)
        file_format = format.get("format", "flac")
        quality = format.get("quality", None)
        if quality:
            ui = UI.AudioSaveHelper.get_save_audio_ui(
                audio,
                filename_prefix=filename_prefix,
                cls=cls,
                format=file_format,
                quality=quality,
            )
        else:
            ui = UI.AudioSaveHelper.get_save_audio_ui(
                audio,
                filename_prefix=filename_prefix,
                cls=cls,
                format=file_format,
            )
        return io.NodeOutput(audio, ui=ui)


class MiniMaxRefJoinString(io.ComfyNode):
    """Replace placeholders in an expression with up to 4 fixed values.

    Example:
        value1 = "内容1", value2 = 2, value3 = 3.5, value4 = "内容4"
        expression = "{value1}/{value2}/{value3}/{value4}"
        output = "内容1/2/3.5/内容4"

    Values accept STRING, INT or FLOAT. Unused placeholders can simply be
    left out of the expression, and unconnected inputs are substituted as
    empty strings.
    """

    @classmethod
    def define_schema(cls):
        value_types = [io.String, io.Int, io.Float]
        return io.Schema(
            node_id="MiniMaxRefJoinString",
            display_name="MiniMaxRef Join Strings",
            category="minimax",
            search_aliases=["join", "concatenate", "combine", "merge strings", "template"],
            description=(
                "Replaces {value1}..{value4} placeholders in an expression with "
                "the connected values (STRING, INT or FLOAT). Placeholders left "
                "out of the expression are ignored; unconnected inputs become "
                "empty strings."
            ),
            inputs=[
                io.MultiType.Input(
                    "value1",
                    value_types,
                    optional=True,
                    tooltip="First value. Accepts STRING, INT or FLOAT.",
                ),
                io.MultiType.Input(
                    "value2",
                    value_types,
                    optional=True,
                    tooltip="Second value. Accepts STRING, INT or FLOAT.",
                ),
                io.MultiType.Input(
                    "value3",
                    value_types,
                    optional=True,
                    tooltip="Third value. Accepts STRING, INT or FLOAT.",
                ),
                io.MultiType.Input(
                    "value4",
                    value_types,
                    optional=True,
                    tooltip="Fourth value. Accepts STRING, INT or FLOAT.",
                ),
                io.String.Input(
                    "expression",
                    default="{value1}/{value2}/{value3}/{value4}",
                    multiline=False,
                    tooltip=(
                        "Expression with {value1}..{value4} placeholders that get "
                        "replaced by the connected values."
                    ),
                ),
            ],
            is_output_node=True,
            outputs=[
                io.String.Output("output", tooltip="The substituted string."),
            ],
        )

    @classmethod
    def execute(
        cls,
        value1: io.MultiType.Type = None,
        value2: io.MultiType.Type = None,
        value3: io.MultiType.Type = None,
        value4: io.MultiType.Type = None,
        expression: str = "",
    ) -> io.NodeOutput:
        print(f"[MiniMaxRefJoinString] execute: value1={value1!r}, value2={value2!r}, value3={value3!r}, value4={value4!r}, expression={expression!r}")
        values = {
            "value1": "" if value1 is None else str(value1),
            "value2": "" if value2 is None else str(value2),
            "value3": "" if value3 is None else str(value3),
            "value4": "" if value4 is None else str(value4),
        }
        try:
            return io.NodeOutput(expression.format(**values))
        except KeyError as exc:
            raise ValueError(
                f"MiniMaxRefJoinString: expression references unknown placeholder "
                f"{exc}. Available placeholders: {sorted(values)}"
            ) from exc