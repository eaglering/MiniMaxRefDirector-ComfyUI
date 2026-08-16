import math

from comfy.comfy_types import List
import torch

import comfy.model_management
import comfy.nested_tensor
import comfy.utils
import node_helpers
import nodes
from comfy_api.latest import ComfyExtension, io

from .image import calc_resolution


CANVAS_MULTIPLE = 32
VAE_SPATIAL_RATIO = 16
FPS = 24
AUDIO_LATENT_FPS = 40

# one frame at 24fps, rounded onto the 40Hz audio latent grid
IMAGE_AUDIO_T = round(AUDIO_LATENT_FPS / FPS)

def _image_av_latent(width, height):
    """T=1 video latent paired with the minimum audio stream."""
    device = comfy.model_management.intermediate_device()
    video = torch.zeros(
        [1, 24, 1, height // VAE_SPATIAL_RATIO, width // VAE_SPATIAL_RATIO],
        device=device,
    )
    audio = torch.zeros([1, 32, 2, IMAGE_AUDIO_T], device=device)
    return {"samples": comfy.nested_tensor.NestedTensor((video, audio))}


def _resize(image, width, height, crop):
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", crop)
    return samples.movedim(1, -1)

def generate_first_frame(image_paths: List[str], width: int, height: int, prompt: str):
    latent = _image_av_latent(width, height)

    ref_items = []   # tokenizer presentation, in request order
    ref_blocks = []  # DiT payload, same order
    for img in (image_paths or {}).values():
        if img is None:
            continue
        if vae is None:
            raise ValueError("MiniMaxH3TextToImage needs a vae to encode reference images")
        h, w = img.shape[1], img.shape[2]
        # aspect-preserving scale (down only) to the output's pixel area
        scale = min(1.0, math.sqrt((width * height) / (w * h)))
        tw = max(CANVAS_MULTIPLE, round(w * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        th = max(CANVAS_MULTIPLE, round(h * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        resized = _resize(img[:1], tw, th, "disabled")
        ref_items.append({"type": "image", "data": resized})
        ref_blocks.append({
            "kind": "image",
            "latent_h": th // VAE_SPATIAL_RATIO,
            "latent_w": tw // VAE_SPATIAL_RATIO,
            "latent": vae.encode(resized),
        })

    tokens = clip.tokenize(prompt, minimax_ref_items=ref_items)
    cond = clip.encode_from_tokens_scheduled(tokens)
    if ref_blocks:
        cond = node_helpers.conditioning_set_values(cond, {"minimax_refs": ref_blocks})
    return io.NodeOutput(cond, latent)