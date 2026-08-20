"""MiniMaxRef joint H3 latent 存取 / VAE 加载 / 音频工具。

复刻 ComfyUI-H3-Motion-Context-MultiRef 已验证的算法：
- _streams_from_latent（NestedTensor / tuple / list 拆分 video / audio）
- _decode_h3_video_cpu / _decode_h3_audio_cpu（VAE 解码到像素 / 波形）
- _pixel_frames（FRAME_PER_TOKEN=(1,4,4,4,4) 累计）

新增能力：
- save_joint_latent_files：保存 image_latent / audio_latent 两个 safetensors
  + sidecar meta json（VAE 文件名、帧数、context、fps、分辨率）
- load_joint_latent_files：读回并重组 NestedTensor
- load_vae_by_name：按文件名加载 comfy.sd.VAE（复刻 nodes.VAELoader）
- vae_display_name：从 VAE 对象反查文件名（patcher.cached_patcher_init 兜底）
- save_audio_clip / load_audio_from_file：clip_audio（AUDIO）↔ wav 文件
- decode_video_latent / decode_audio_latent：latent → 像素帧 / 波形
"""

from __future__ import annotations

import json
import os

import torch

import comfy.sd
import comfy.utils
import comfy.nested_tensor
import folder_paths

try:
    import safetensors.torch as _sf  # type: ignore[import]
except Exception:  # pragma: no cover - ComfyUI 自带 safetensors
    _sf = None

FRAME_PER_TOKEN = (1, 4, 4, 4, 4)


# ── joint latent 拆分 ────────────────────────────────────────────────────

def split_joint_latent(latent: dict) -> tuple[torch.Tensor, torch.Tensor]:
    """把 H3 联合 latent 拆分为 (video [1,24,T,H,W], audio [1,32,2,T])。

    兼容 NestedTensor / tuple / list（照搬 MultiRef _streams_from_latent）。
    """
    samples = latent["samples"]
    if hasattr(samples, "unbind"):
        parts = list(samples.unbind())
    elif isinstance(samples, (tuple, list)):
        parts = list(samples)
    else:
        raise ValueError(
            "expected a MiniMax H3 AV latent (nested video/audio pair), got %r"
            % type(samples)
        )
    if len(parts) < 2:
        raise ValueError("H3 AV latent contains no audio stream: %r" % type(parts[0]))
    video, audio = parts[0], parts[1]
    if video.ndim == 4:  # 未加 batch 的 [C,T,H,W]
        video = video.unsqueeze(0)
    if audio.ndim == 3:  # 未加 batch 的 [C,2,T]
        audio = audio.unsqueeze(0)
    if video.ndim != 5 or audio.ndim != 4:
        raise ValueError(
            "unexpected latent shapes: video %s, audio %s"
            % (tuple(video.shape), tuple(audio.shape))
        )
    return video, audio


def rebuild_joint_latent(video: torch.Tensor, audio: torch.Tensor) -> dict:
    """用 NestedTensor 重组联合 latent dict（照搬 MultiRef 节点输出格式）。"""
    return {"samples": comfy.nested_tensor.NestedTensor((video, audio))}


# ── 帧数 / 元数据工具 ────────────────────────────────────────────────────

def pixel_frames(latent_t: int) -> int:
    """H3 视频 latent 的 token 数 → 解码后像素帧数（FRAME_PER_TOKEN 累计）。"""
    return int(sum(FRAME_PER_TOKEN[k % len(FRAME_PER_TOKEN)] for k in range(int(latent_t))))


def vae_display_name(vae: object) -> str:
    """尽力从 VAE 对象反查文件名（第三方节点可能设置 vae.filename）。

    兜底：nodes.VAELoader 加载时会把 (vae_path, metadata, None) 缓存在
    vae.patcher.cached_patcher_init[1]，从中提取 basename。
    """
    name = getattr(vae, "filename", None)
    if isinstance(name, str) and name:
        return os.path.basename(name)
    try:
        cached = getattr(getattr(vae, "patcher", None), "cached_patcher_init", None)
        if cached and len(cached) > 1 and cached[1] and isinstance(cached[1][0], str):
            path = cached[1][0]
            if path:
                return os.path.basename(path)
    except Exception:
        pass
    return ""


def load_vae_by_name(name: str):
    """按文件名加载 comfy.sd.VAE（复刻 nodes.VAELoader 逻辑）。"""
    if not name:
        raise ValueError("VAE filename is empty; cannot load VAE")
    vae_path = None
    for resolver in (folder_paths.get_full_path_or_raise, folder_paths.get_full_path):
        try:
            vae_path = resolver("vae", name)
            if vae_path and os.path.isfile(vae_path):
                break
        except Exception:
            vae_path = None
    if not vae_path or not os.path.isfile(vae_path):
        raise ValueError(
            "VAE '%s' not found in ComfyUI/models/vae" % name
        )
    sd = comfy.utils.load_torch_file(vae_path)
    vae = comfy.sd.VAE(sd=sd)
    vae.throw_exception_if_invalid()
    return vae


def vae_sample_rate(vae: object, fallback: int = 44100) -> int:
    """VAE 输出采样率：优先 audio_sample_rate_output，回退 audio_sample_rate。"""
    for attr in ("audio_sample_rate_output", "audio_sample_rate"):
        value = getattr(vae, attr, None)
        if value:
            return int(value)
    return int(fallback)


# ── latent 文件存取 ──────────────────────────────────────────────────────

def _split_prefix(filename_prefix: str) -> tuple[str, str]:
    """把 "Tenz/audio" 拆成 (subfolder="Tenz", filename="audio")。"""
    norm = str(filename_prefix or "MiniMaxRef").replace("\\", "/").strip("/")
    if "/" in norm:
        sub, base = norm.rsplit("/", 1)
        return sub, base or "latent"
    return "", norm or "latent"


def save_joint_latent_files(
    latent: dict,
    meta: dict | None,
    filename_prefix: str,
) -> dict:
    """保存 joint latent 为 image/audio 两个 safetensors + sidecar meta json。

    输出到 ComfyUI output 目录，返回：
    {image_path, audio_path, meta_path, subfolder, image_filename,
     audio_filename, meta_filename, prefix}
    """
    video, audio = split_joint_latent(latent)
    subfolder, base = _split_prefix(filename_prefix)
    output_dir = folder_paths.get_output_directory()
    target_dir = os.path.join(output_dir, subfolder) if subfolder else output_dir
    os.makedirs(target_dir, exist_ok=True)

    image_name = "image_latent_%s.safetensors" % base
    audio_name = "audio_latent_%s.safetensors" % base
    meta_name = "%s.meta.json" % base
    image_path = os.path.join(target_dir, image_name)
    audio_path = os.path.join(target_dir, audio_name)
    meta_path = os.path.join(target_dir, meta_name)

    if _sf is not None:
        _sf.save_file({"latent": video.detach().to("cpu").contiguous()}, image_path)
        _sf.save_file({"latent": audio.detach().to("cpu").contiguous()}, audio_path)
    else:  # pragma: no cover
        torch.save({"latent": video.detach().cpu()}, image_path)
        torch.save({"latent": audio.detach().cpu()}, audio_path)

    payload = dict(meta or {})
    payload.setdefault("frame_count", int(video.shape[2]))
    payload.setdefault("audio_steps", int(audio.shape[3]))
    payload.setdefault("width", int(video.shape[4]))
    payload.setdefault("height", int(video.shape[3]))
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    return {
        "image_path": image_path,
        "audio_path": audio_path,
        "meta_path": meta_path,
        "subfolder": subfolder,
        "image_filename": image_name,
        "audio_filename": audio_name,
        "meta_filename": meta_name,
        "prefix": filename_prefix,
    }


def load_joint_latent_files(image_path: str, audio_path: str) -> tuple[dict, dict]:
    """读回 joint latent（重组 NestedTensor）与 sidecar meta。"""
    if _sf is not None:
        video = _sf.load_file(image_path)["latent"]
        audio = _sf.load_file(audio_path)["latent"]
    else:  # pragma: no cover
        video = torch.load(image_path, map_location="cpu")["latent"]
        audio = torch.load(audio_path, map_location="cpu")["latent"]
    meta: dict = {}
    meta_path = os.path.splitext(image_path)[0].replace("image_latent_", "") + ".meta.json"
    if not os.path.isfile(meta_path):
        # 兜底：meta 与 image 同目录同 basename
        meta_path = os.path.join(
            os.path.dirname(image_path),
            os.path.basename(image_path).replace("image_latent_", "").replace(".safetensors", "") + ".meta.json",
        )
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as fh:
                meta = json.load(fh)
        except Exception:
            meta = {}
    return rebuild_joint_latent(video, audio), meta


# ── VAE 解码 ─────────────────────────────────────────────────────────────

def decode_video_latent(video_vae, video_latent: torch.Tensor) -> torch.Tensor:
    """video latent [1,24,T,H,W] → 像素帧 [N,H,W,C] CPU float32（前 3 通道）。"""
    images = video_vae.decode(video_latent)
    if getattr(images, "ndim", 0) == 5 and int(images.shape[0]) == 1:
        images = images[0]
    if getattr(images, "ndim", 0) != 4:
        raise ValueError(
            "expected [N,H,W,C] frames after video decode, got %s"
            % (tuple(images.shape),)
        )
    if int(images.shape[-1]) in (3, 4):
        images = images[..., :3]
    elif int(images.shape[1]) in (3, 4):
        images = images.movedim(1, -1)[..., :3]
    else:
        raise ValueError(
            "unexpected frame channel layout: %s" % (tuple(images.shape),)
        )
    return images.detach().to("cpu", torch.float32).contiguous()


def decode_audio_latent(audio_vae, audio_latent: torch.Tensor) -> tuple[torch.Tensor, int]:
    """audio latent [1,32,2,T] → (waveform [1,2,L] CPU float32, sample_rate)。

    照搬 MultiRef _decode_h3_audio_cpu：decode → movedim(-1,1) → std 归一化。
    """
    waveform = audio_vae.decode(audio_latent).movedim(-1, 1)
    std = torch.std(waveform, dim=[1, 2], keepdim=True) * 5.0
    std[std < 1.0] = 1.0
    waveform = waveform / std
    sr = vae_sample_rate(audio_vae)
    return waveform.detach().to("cpu", torch.float32), sr


# ── 音频文件工具（clip_audio 透传）───────────────────────────────────────

def save_audio_clip(audio: dict, filename_prefix: str) -> dict:
    """把 clip_audio（AUDIO dict）保存为 wav 到 output 目录。

    返回 {path, subfolder, filename}。
    """
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate") or 0)
    if waveform is None or sample_rate <= 0:
        raise ValueError("invalid clip_audio AUDIO dict")
    if waveform.dim() == 3:
        waveform = waveform[0]  # [B,C,L] -> [C,L]
    if waveform.dim() != 2:
        raise ValueError("unexpected waveform shape: %s" % tuple(waveform.shape))

    subfolder, base = _split_prefix(filename_prefix)
    output_dir = folder_paths.get_output_directory()
    target_dir = os.path.join(output_dir, subfolder) if subfolder else output_dir
    os.makedirs(target_dir, exist_ok=True)
    name = "audio_%s.wav" % base
    path = os.path.join(target_dir, name)

    wave_np = waveform.detach().to("cpu", dtype=torch.float32).numpy()
    try:
        import soundfile as sf  # type: ignore[import]
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("soundfile is required to save clip_audio wav") from exc
    sf.write(path, wave_np.T, sample_rate)
    return {"path": path, "subfolder": subfolder, "filename": name}


def load_audio_from_file(path: str) -> dict:
    """读音频文件 → AUDIO dict {"waveform":[1,C,L], "sample_rate":sr}。"""
    if not path or not os.path.isfile(path):
        raise ValueError("audio file not found: %s" % path)
    try:
        import soundfile as sf  # type: ignore[import]
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("soundfile is required to load clip_audio") from exc
    data, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    waveform = torch.from_numpy(data.T).unsqueeze(0)
    return {"waveform": waveform, "sample_rate": int(sample_rate)}
