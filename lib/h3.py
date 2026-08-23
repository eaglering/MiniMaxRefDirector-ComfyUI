import math
import logging
import torch

import comfy.model_management
import comfy.model_sampling
import comfy.nested_tensor
import comfy.utils
import node_helpers
import nodes

try:
    from comfy_api.latest import VideoFromFile
except ImportError:  # pragma: no cover
    from comfy_api.latest._input_impl import VideoFromFile

from .image import load_image_tensor
from .video import _load_wav_audio

log = logging.getLogger(__name__)

CANVAS_MULTIPLE = 32
VAE_SPATIAL_RATIO = 16
FPS = 24
AUDIO_LATENT_FPS = 40

# ref video canvas 缩放（复刻 nodes_minimax_h3 常量）
BASE_SHORT_EDGE = 768
MAX_PIXELS = 768 * 1344

def _resize(image, width, height, crop):
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", crop)
    return samples.movedim(1, -1)

# ============ 参考视频生成（复刻官方 MiniMaxH3ReferenceToVideo 采样链路） ============


def align_frame_count(n):
    while n % 17 != 5:
        n += 1
    return n


def video_latent_t(frame_count):
    if frame_count <= 5:
        return 2
    return ((frame_count - 5) // 17) * 5 + 2


def temporal_shape(length):
    frame_count = align_frame_count(max(5, length))
    duration = frame_count / FPS
    return frame_count, video_latent_t(frame_count), round(duration * AUDIO_LATENT_FPS)


def _empty_av_latent(width, height, length):
    """T=N 视频 latent + 对应长度音频 latent（与官方 _empty_av_latent 一致）。"""
    frame_count, latent_t, audio_t = temporal_shape(length)
    device = comfy.model_management.intermediate_device()
    video = torch.zeros(
        [1, 24, latent_t, height // VAE_SPATIAL_RATIO, width // VAE_SPATIAL_RATIO],
        device=device,
    )
    audio = torch.zeros([1, 32, 2, audio_t], device=device)
    return {"samples": comfy.nested_tensor.NestedTensor((video, audio))}, frame_count


def adapt_canvas(width, height):
    """短边 768 的等比 canvas（复刻官方，防止 ref video 被过度缩放）。"""
    ratio = width / height
    if ratio >= 1.0:
        nom_w, nom_h = BASE_SHORT_EDGE * ratio, BASE_SHORT_EDGE
    else:
        nom_w, nom_h = BASE_SHORT_EDGE, BASE_SHORT_EDGE / ratio
    if nom_w * nom_h > MAX_PIXELS:
        s = math.sqrt(MAX_PIXELS / (nom_w * nom_h))
        nom_w, nom_h = nom_w * s, nom_h * s
    return (
        max(CANVAS_MULTIPLE, round(nom_w / CANVAS_MULTIPLE) * CANVAS_MULTIPLE),
        max(CANVAS_MULTIPLE, round(nom_h / CANVAS_MULTIPLE) * CANVAS_MULTIPLE),
    )


def _encode_ref_audio(audio_vae, audio):
    """参考音频 → audio_vae latent（复刻官方 _encode_ref_audio）。"""
    waveform = audio["waveform"]  # [B, C, L]
    sr = audio["sample_rate"]
    vae_sr = getattr(audio_vae, "audio_sample_rate", 32000)
    if sr != vae_sr:
        try:
            import torchaudio  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError("torchaudio is required to resample reference audio") from exc
        waveform = torchaudio.functional.resample(waveform, sr, vae_sr)
    z = audio_vae.encode(waveform[:1].movedim(1, -1))  # [1, 32, 2, T]
    return z, z.shape[-1]


def apply_sigma_shift(model, shift_video, shift_audio):
    """对模型 clone 应用 MiniMax H3 sigma shift（video 驱动采样 sigma，audio 交给 DiT）。

    抽出来供 guide 节点复用。
    """
    m = model.clone()

    class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingDiscreteFlow, comfy.model_sampling.CONST):
        pass

    original = m.get_model_object("model_sampling")
    model_sampling = ModelSamplingAdvanced(model.model.model_config)
    model_sampling.set_parameters(shift=shift_video)
    if hasattr(original, "noise_scale"):
        model_sampling.set_noise_scale(original.noise_scale)
    m.add_object_patch("model_sampling", model_sampling)

    to = m.model_options["transformer_options"] = m.model_options.get("transformer_options", {}).copy()
    to["minimax_h3_sigma_shift_video"] = shift_video
    to["minimax_h3_sigma_shift_audio"] = shift_audio
    return m


def build_segment_conditioning(
    clip,
    video_vae,
    audio_vae,
    prompt,
    width,
    height,
    length,
    pictures=None,
    videos=None,
    audios=None,
    negative_prompt="",
):
    """构建 H3 参考视频条件编码：图/视频/音频 refs 全部编码进条件与 latent。

    返回 (cond, neg_cond, latent, frame_count)。供 guide 节点复用，输出
    positive/negative/latent 让用户自己接 KSampler 等节点完成采样。

    bind 数据（build_h3_subject_bindings 产出）中 pictures/videos/audios 为
    [{label, src}]（src 为文件路径）；director 的 guide_data 中则是纯字符串
    路径列表，两种形态都兼容。
    """
    if clip is None:
        raise ValueError("build_segment_conditioning needs a clip to encode the prompt")
    if video_vae is None:
        raise ValueError("build_segment_conditioning needs a video vae")

    latent, frame_count = _empty_av_latent(width, height, length)

    ref_items = []   # tokenizer presentation, in request order
    ref_blocks = []  # DiT payload, same order

    def _src_of(item):
        """兼容 {label, src} 字典与纯字符串路径两种 ref 元素形态。"""
        return item.get("src", "") if isinstance(item, dict) else (item or "")

    # --- 参考图 ---
    for pic in pictures or []:
        src = _src_of(pic)
        if not src:
            continue
        img = load_image_tensor(src)
        if img is None:
            log.warning("skipped unavailable reference image: %r", src)
            continue
        h, w = img.shape[1], img.shape[2]
        scale = min(1.0, math.sqrt((width * height) / (w * h)))
        tw = max(CANVAS_MULTIPLE, round(w * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        th = max(CANVAS_MULTIPLE, round(h * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        resized = _resize(img[:1], tw, th, "disabled")
        ref_items.append({"type": "image", "data": resized})
        ref_blocks.append({
            "kind": "image",
            "latent_h": th // VAE_SPATIAL_RATIO,
            "latent_w": tw // VAE_SPATIAL_RATIO,
            "latent": video_vae.encode(resized),
        })

    # --- 参考视频（复刻官方 ref_videos 处理） ---
    for vid in videos or []:
        src = _src_of(vid)
        if not src:
            continue
        frames = VideoFromFile(src).get_components().images  # [N, H, W, C]
        vh, vw = frames.shape[1], frames.shape[2]
        cw, ch = adapt_canvas(vw, vh)
        if vw * vh < cw * ch:  # 不放大，退回原始分辨率对齐
            cw = max(CANVAS_MULTIPLE, round(vw / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
            ch = max(CANVAS_MULTIPLE, round(vh / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        fr = _resize(frames, cw, ch, "disabled")
        if fr.shape[0] > frame_count:
            fr = fr[:frame_count]
        n = fr.shape[0]
        if n < 5:
            raise ValueError("MiniMax H3 reference videos need at least 5 frames (~0.2s at 24 fps)")
        while n % 17 != 5:
            n -= 1
        fr = fr[:n]
        z = video_vae.encode(fr)
        sample_idx = list(range(0, fr.shape[0], FPS // 2))
        qwen_frames = fr[sample_idx]
        ref_items.append({
            "type": "video",
            "data": qwen_frames,
            "timestamps": [i / 2.0 for i in range(len(sample_idx))],
        })
        ref_blocks.append({
            "kind": "video",
            "latent_t": z.shape[2],
            "latent_h": ch // VAE_SPATIAL_RATIO,
            "latent_w": cw // VAE_SPATIAL_RATIO,
            # 官方 ref block 结构要求带 ref_audio_t（PackedLayout 对 video 也访问该键）；
            # 本节点参考视频不配对音频，置 0 即可，kind 保持 "video"。
            "ref_audio_t": 0,
            "latent": z,
        })

    # --- 参考音频 ---
    for aud in audios or []:
        src = _src_of(aud)
        if not src:
            continue
        if audio_vae is None:
            raise ValueError("build_segment_conditioning needs audio_vae when reference audios are provided")
        audio = _load_wav_audio(src)
        audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, audio)
        ref_items.append({"type": "audio"})
        ref_blocks.append({"kind": "audio", "ref_audio_t": ref_audio_t, "audio_latent": audio_latent})

    # --- 条件编码 ---
    tokens = clip.tokenize(prompt, minimax_ref_items=ref_items)
    cond = clip.encode_from_tokens_scheduled(tokens)
    if ref_blocks:
        cond = node_helpers.conditioning_set_values(cond, {"minimax_refs": ref_blocks})

    # negative conditioning
    neg_tokens = clip.tokenize(negative_prompt)
    neg_cond = clip.encode_from_tokens_scheduled(neg_tokens)

    return cond, neg_cond, latent, frame_count


def generate_segment_video(
    model,
    clip,
    video_vae,
    audio_vae,
    prompt,
    width,
    height,
    length,
    pictures=None,
    videos=None,
    audios=None,
    seed=0,
    steps=8,
    cfg=1,
    sampler_name="euler",
    scheduler="simple",
    denoise=1.0,
    shift_video=12.0,
    shift_audio=3.0,
    negative_prompt="",
):
    """参考生成视频：构建条件 → sigma shift → 采样 → 解码，返回帧序列 [N,H,W,C]。

    bind 数据（build_h3_subject_bindings 产出）中 pictures/videos/audios 均为
    [{label, src}]，src 为文件路径。
    """
    if model is None:
        raise ValueError("generate_segment_video needs a model to sample")

    cond, neg_cond, latent, frame_count = build_segment_conditioning(
        clip, video_vae, audio_vae, prompt, width, height, length,
        pictures, videos, audios, negative_prompt,
    )

    m = apply_sigma_shift(model, shift_video, shift_audio)

    # KSampler 采样 → VAEDecode → 帧序列
    samples = nodes.KSampler().sample(
        m, int(seed), int(steps), float(cfg), sampler_name, scheduler,
        cond, neg_cond, latent, denoise=float(denoise),
    )[0]
    images = nodes.VAEDecode().decode(video_vae, samples)[0]
    return images
