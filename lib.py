
import os
import logging
import numpy as np
import torch
from PIL import Image, ImageOps
import av
from node_helpers import pillow
from comfy_api.latest import io

import folder_paths

log = logging.getLogger(__name__)

def find_index(arr, func):
    for i, x in enumerate(arr):
        if func(x):
            return i
    return -1


def resolve_input_path(filename: str) -> str:
    """Resolve a relative file path under the ComfyUI input directory to an absolute path."""
    if not filename:
        return ""
    if os.path.isabs(filename) and os.path.exists(filename):
        return filename
    candidate = os.path.join(folder_paths.get_input_directory(), filename)
    if os.path.exists(candidate):
        return os.path.abspath(candidate)
    basename = os.path.basename(filename)
    fallback = os.path.join(folder_paths.get_input_directory(), "minimaxrefdirector", basename)
    if os.path.exists(fallback):
        return os.path.abspath(fallback)
    return ""


def load_image_tensor(filepath: str) -> torch.Tensor:
    """Load an image file and return as float32 tensor."""
    try:
        img = pillow(Image.open, resolve_input_path(filepath))
        img = pillow(ImageOps.exif_transpose, img)
        if img.mode == "I":
            img = img.point(lambda i: i * (1 / 255))
        image = img.convert("RGB")
        image = np.array(image).astype(np.float32) / 255.0

        return torch.from_numpy(image)[None,]
    except Exception as e:
        log.warning(f"[MiniMaxRefDirectorGuide] Failed to load image {filepath}: {e}")
        return torch.zeros((64, 64), dtype=torch.float32)

def load_audio_tensor(filepath: str) -> dict:
    with av.open(filepath) as af:
        if not af.streams.audio:
            raise ValueError("No audio stream found in the file.")

        stream = af.streams.audio[0]
        sr = stream.codec_context.sample_rate
        n_channels = stream.channels

        frames = []
        length = 0
        for frame in af.decode(streams=stream.index):
            buf = torch.from_numpy(frame.to_ndarray())
            if buf.shape[0] != n_channels:
                buf = buf.view(-1, n_channels).t()

            frames.append(buf)
            length += buf.shape[1]

        if not frames:
            raise ValueError("No audio frames decoded.")

        wav = torch.cat(frames, dim=1)
        wav = _f32_pcm(wav)
        return {"waveform": wav.unsqueeze(0), "sample_rate": sr}

def _f32_pcm(wav: torch.Tensor) -> torch.Tensor:
    """Convert audio to float 32 bits PCM format."""
    if wav.dtype.is_floating_point:
        return wav
    elif wav.dtype == torch.int16:
        return wav.float() / (2 ** 15)
    elif wav.dtype == torch.int32:
        return wav.float() / (2 ** 31)
    raise ValueError(f"Unsupported wav dtype: {wav.dtype}")

def seconds_to_mmssmmm(seconds: float) -> str:
    """Convert float seconds to MM:SS.mmm format string.

    Example: 0.04 -> "00:00.040", 3.0 -> "00:03.000", 65.5 -> "01:05.500".
    """
    total_seconds = max(0.0, seconds)
    minutes = int(total_seconds // 60)
    secs = int(total_seconds % 60)
    millis = int(round((total_seconds - int(total_seconds)) * 1000))
    return f"{minutes:02d}:{secs:02d}.{millis:03d}"
