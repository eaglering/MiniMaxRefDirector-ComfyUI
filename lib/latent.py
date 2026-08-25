"""MiniMaxRef joint H3 latent 存取 / VAE 加载 / 音频工具。

复刻 ComfyUI-H3-Motion-Context-MultiRef 已验证的算法：
- _streams_from_latent（NestedTensor / tuple / list 拆分 video / audio）
- _decode_h3_video_cpu / _decode_h3_audio_cpu（VAE 解码到像素 / 波形）
- _pixel_frames（FRAME_PER_TOKEN=(1,4,4,4,4) 累计）

新增能力：
- save_image_latent_files：只保存 image_latent safetensors + sidecar meta json
  （素材音频统一走 clip_audio，不再保存 audio_latent）
- load_joint_latent_files：读回 image_latent（audio 可选，缺失时占位）重组 NestedTensor
- load_vae_by_name：按文件名加载 comfy.sd.VAE（复刻 nodes.VAELoader）
- vae_display_name：从 VAE 对象反查文件名（patcher.cached_patcher_init 兜底）
- save_audio_clip / load_audio_from_file：clip_audio（AUDIO）↔ wav 文件
- decode_video_latent / decode_audio_latent：latent → 像素帧 / 波形
"""

from __future__ import annotations

import json
import logging
import os

import torch

import comfy.model_management
import comfy.sd
import comfy.utils
import comfy.nested_tensor
import folder_paths

log = logging.getLogger(__name__)

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


def _next_joint_save_id(target_dir: str, base: str) -> int:
    """Comfy 风格递增编号：扫描目录中同批已有文件，返回最大编号 + 1。

    同一次保存的 image_latent / clip_audio / meta 共享同一编号
    （形如 image_latent_{base}_{n:05d}.safetensors），避免不同段/不同运行
    互相覆盖。编号规则参考 ComfyUI get_save_image_path：从已有文件名中
    解析前缀后的连续数字，取最大值 + 1。
    """
    prefixes = (
        "image_latent_%s_" % base,
        "audio_latent_%s_" % base,
        "audio_%s_" % base,
        "%s_" % base,
    )
    n = 0
    try:
        entries = os.listdir(target_dir)
    except OSError:
        return 1
    for fn in entries:
        for prefix in prefixes:
            if not fn.startswith(prefix):
                continue
            digits = ""
            for ch in fn[len(prefix):]:
                if ch.isdigit():
                    digits += ch
                else:
                    break
            if digits:
                n = max(n, int(digits))
            break
    return n + 1


def save_image_latent_files(
    latent: dict,
    meta: dict | None,
    filename_prefix: str,
) -> dict:
    """只保存 image_latent safetensors + sidecar meta json（无损合并素材）。

    素材音频统一走 clip_audio（wav），不再保存 audio_latent；
    合并读回时 audio 流以占位张量重建（内容不被消费）。
    输出到 ComfyUI output 目录，返回：
    {image_path, meta_path, subfolder, image_filename, meta_filename, prefix, save_id}
    """
    video, _audio = split_joint_latent(latent)
    subfolder, base = _split_prefix(filename_prefix)
    output_dir = folder_paths.get_output_directory()
    target_dir = os.path.join(output_dir, subfolder) if subfolder else output_dir
    os.makedirs(target_dir, exist_ok=True)

    # Comfy 风格递增编号：image / clip_audio / meta 共享同批编号，防止不同段互相覆盖
    save_id = _next_joint_save_id(target_dir, base)
    image_name = "image_latent_%s_%05d.safetensors" % (base, save_id)
    meta_name = "%s_%05d.meta.json" % (base, save_id)
    image_path = os.path.join(target_dir, image_name)
    meta_path = os.path.join(target_dir, meta_name)

    if _sf is not None:
        _sf.save_file({"latent": video.detach().to("cpu").contiguous()}, image_path)
    else:  # pragma: no cover
        torch.save({"latent": video.detach().cpu()}, image_path)

    payload = dict(meta or {})
    payload.setdefault("frame_count", int(video.shape[2]))
    payload.setdefault("width", int(video.shape[4]))
    payload.setdefault("height", int(video.shape[3]))
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    return {
        "image_path": image_path,
        "meta_path": meta_path,
        "subfolder": subfolder,
        "image_filename": image_name,
        "meta_filename": meta_name,
        "prefix": filename_prefix,
        "save_id": save_id,
    }


def load_joint_latent_files(image_path: str, audio_path: str | None = None) -> tuple[dict, dict]:
    """读回 image_latent + 可选 audio_latent，重组 NestedTensor 与 sidecar meta。

    audio_path 为 None / 空时（新素材只保存 image_latent + clip_audio），
    用占位 audio 张量重建 joint latent；占位内容在合并流程中不被消费。
    """
    if _sf is not None:
        video = _sf.load_file(image_path)["latent"]
        audio = (
            _sf.load_file(audio_path)["latent"]
            if audio_path else torch.zeros(
                (1, 32, 2, int(video.shape[2])), dtype=video.dtype
            )
        )
    else:  # pragma: no cover
        video = torch.load(image_path, map_location="cpu")["latent"]
        audio = (
            torch.load(audio_path, map_location="cpu")["latent"]
            if audio_path else torch.zeros(
                (1, 32, 2, int(video.shape[2])), dtype=video.dtype
            )
        )
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

def _finalize_video_frames(images: torch.Tensor) -> torch.Tensor:
    """把 VAE 解码输出规整为 [N,H,W,3] CPU float32（前 3 通道）。"""
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


def decode_video_latent(video_vae, video_latent: torch.Tensor) -> torch.Tensor:
    """video latent [1,24,T,H,W] → 像素帧 [N,H,W,C] CPU float32（前 3 通道）。"""
    return _finalize_video_frames(video_vae.decode(video_latent))


def decode_video_latent_frames(video_vae, video_latent: torch.Tensor) -> torch.Tensor:
    """H3 VAE 解码，输出直接写 CPU buffer；返回 [1,T,H,W,3]（与 sd.VAE.decode 一致）。

    comfy.sd.VAE.decode 对 comfy_has_chunked_io 的 VAE 会先预分配 GPU fp32 全尺寸
    output buffer（decode_output_shape），叠加 VAE 内部 tiled_decode 的 GPU fp16
    canvas：4K 单片 97 帧时两者合计 ≈ 14.4 GiB，16 GiB 卡必然 OOM（用户环境实测
    allocated 虚涨到 31 GiB）。这里绕过 sd.VAE.decode 的 GPU 预分配，直接把
    decode_temporal 的输出逐 chunk 写进 CPU buffer（decode_temporal 的 write_part
    用 copy_ 跨设备拷贝），GPU 峰值只剩 fp16 canvas + 单 chunk 激活。
    """
    vae = getattr(video_vae, "first_stage_model", None)
    if vae is None or not hasattr(vae, "decode_temporal"):
        # 非 H3 VAE：无全尺寸预分配问题，走原路径
        return video_vae.decode(video_latent)
    device = video_vae.device
    dtype = video_vae.vae_dtype
    with comfy.model_management.cuda_device_context(device):
        comfy.model_management.load_models_gpu(
            [video_vae.patcher], force_full_load=video_vae.disable_offload
        )
        z = video_latent.to(device=device, dtype=dtype)
        shape = tuple(vae.decode_output_shape(z.shape))
        buf = torch.empty(shape, dtype=torch.float32, device="cpu")
        with torch.no_grad():
            vae.decode(z, output_buffer=buf)
        del z
    return buf.movedim(1, -1)  # [1,3,T,H,W] -> [1,T,H,W,3]


def _auto_chunks_per_slice(video_latent: torch.Tensor, vae, max_canvas_bytes=None) -> int:
    """按 latent 分辨率自动选择每次 decode 的 chunk 数，限制 GPU fp16 canvas 大小。

    canvas ≈ 每片帧数 × 3ch × 2B(fp16) × H×W；每片帧数 ≈ chunks_per_slice ×
    clip_length（H3: 17 帧/chunk）。预算默认取显存总量 22%（16 GiB 卡 ≈ 3.5 GiB），
    m 收敛到 [3,8]（<3 无法满足 VAE 跨 chunk 交叉淡化，>8 解码开销收益递减）。
    """
    if max_canvas_bytes is None:
        max_canvas_bytes = max(1, int(comfy.model_management.get_total_memory() * 0.22))
    h = int(video_latent.shape[3]) * int(vae.vae_ratio)
    w = int(video_latent.shape[4]) * int(vae.vae_ratio)
    bytes_per_frame = max(1, 3 * h * w * 2)  # fp16 canvas 每帧字节
    fpc = max(1, int(vae.clip_length))
    max_frames = max(fpc, int(max_canvas_bytes / bytes_per_frame))
    return max(3, min(8, max_frames // fpc))


def iter_decode_video_latent(
    video_vae, video_latent: torch.Tensor, chunks_per_slice: int | None = None
):
    """按 VAE 时间 chunk 边界流式解码 video latent，与整段 decode 像素级一致。

    MiniMax H3 VAE 的 decode_temporal 以 tokens_chunk_size 个 token 为一片
    解码：每片读取 [i*5, i*5+7) 的 token（含 token_overlap 尾上文），输出
    clip_length 帧；且相邻两片在解码内部做 frame_overlap 帧交叉淡化。因此：

    - 单独解一个 chunk 会丢掉与前一 chunk 的交叉淡化（全局首 chunk 除外）；
    - 每片最后一个 chunk 的尾上文会被 padding，只有整段解码的最后一 chunk
      的 padding 才与完整上下文等价。

    本函数每次解码 chunks_per_slice 个 chunk（时间跨度有界），丢弃该片首
    chunk（未淡化；全局首 chunk 除外）与末 chunk（padding 上下文；整段末片
    除外），逐片拼回与整段 decode 完全一致的输出。任意时刻 GPU 只驻留
    chunks_per_slice 个 chunk 的时间跨度，CPU 只驻留一个分片的像素。

    :param chunks_per_slice: 每次 decode 的 chunk 数（>=3；越大单次显存越高、
                             解码开销越低，总开销约 m/(m-2) 倍）。None（默认）
                             按 latent 分辨率自动选取（_auto_chunks_per_slice），
                             保证 4K 长片单次 decode 的 GPU fp16 canvas 不超预算。
    :yield: (frame_start, frames)；frames 为 [N,H,W,3] CPU float32，
            frame_start 为该片首帧在整段输出中的绝对帧号。
    """
    vae = getattr(video_vae, "first_stage_model", None)
    if vae is None or not hasattr(vae, "tokens_chunk_size") or not hasattr(
        vae, "_decode_temporal_chunks"
    ):
        # 非 H3 VAE：无分片信息，退化为整段解码
        images = decode_video_latent(video_vae, video_latent)
        if int(images.shape[0]) > 0:
            yield 0, images
        return

    if chunks_per_slice:
        m = max(3, int(chunks_per_slice))
    else:
        m = _auto_chunks_per_slice(video_latent, vae)
        log.info(
            "latent: auto chunks_per_slice=%d (latent %dx%d -> %dx%d px)",
            m, int(video_latent.shape[3]), int(video_latent.shape[4]),
            int(video_latent.shape[3]) * int(vae.vae_ratio),
            int(video_latent.shape[4]) * int(vae.vae_ratio),
        )
    t = int(video_latent.shape[2])
    if t <= 0:
        return
    chunk = int(vae.tokens_chunk_size)
    fpc = int(vae.clip_length)
    if chunk <= 0 or fpc <= 0:
        images = decode_video_latent(video_vae, video_latent)
        if int(images.shape[0]) > 0:
            yield 0, images
        return

    _, num_chunks = vae._decode_temporal_chunks(t)
    stride = m - 2
    pos = 0
    a = 0
    while a < num_chunks:
        if a * chunk >= t:
            break
        is_final = a + m >= num_chunks
        # 末片必须覆盖全部剩余 token [a*5, t)：t 可能不是 5 的倍数（VAE 无
        # padding 时 t = 5*num_chunks + token_overlap），(a+m)*5 可能 < t。
        end = t if is_final else min(t, (a + m) * chunk)
        zs = video_latent[:, :, a * chunk : end]
        # 解码前清缓存碎片：ComfyUI 主进程可能残留其他模型的 reserved 池，
        # 不清理会导致 VAE 权重加载后的解码在碎片化的缓存池里反复 OOM。
        try:
            comfy.model_management.soft_empty_cache()
        except Exception:  # noqa: BLE001 - 尽力而为
            pass
        images = _finalize_video_frames(decode_video_latent_frames(video_vae, zs))
        n = int(images.shape[0])
        keep_lo = fpc if a > 0 else 0
        keep_hi = n if is_final else min(n, (m - 1) * fpc)
        if keep_hi > keep_lo:
            yield pos, images[keep_lo:keep_hi]
            pos += keep_hi - keep_lo
        del images, zs
        # 每片解码后立即清缓存，防止多次分片解码的 reserved 池累积膨胀
        # （VHS 双重解码 + 多片解码是用户环境 allocated 虚涨到 31 GiB 的主因）。
        try:
            comfy.model_management.soft_empty_cache()
        except Exception:  # noqa: BLE001 - 尽力而为
            pass
        if is_final:
            break
        a += stride


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

def save_audio_clip(audio: dict, filename_prefix: str, save_id: int | None = None) -> dict:
    """把 clip_audio（AUDIO dict）保存为 wav 到 output 目录。

    返回 {path, subfolder, filename}。
    save_id 传入时与 latent 文件共享同一递增编号（同段素材的一组文件），
    未传入时独立按目录已有文件递增，避免不同段互相覆盖。
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
    if save_id is None:
        save_id = _next_joint_save_id(target_dir, base)
    name = "audio_%s_%05d.wav" % (base, save_id)
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
