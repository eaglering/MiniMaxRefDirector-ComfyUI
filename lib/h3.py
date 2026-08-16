import math

from comfy.comfy_types import List
import torch

import comfy.model_management
import comfy.model_sampling
import comfy.nested_tensor
import comfy.utils
import node_helpers
import nodes
from comfy_api.latest import ComfyExtension, io, UI

from .image import calc_resolution, load_image_tensor


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

class RefGenerateImage(io.ComfyNode):
    """Sample a single first-frame image and save it to the ComfyUI output directory."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="RefGenerateImage",
            display_name="MiniMaxRef Generate Image",
            category="minimaxrefdirector",
            description=(
                "Sample a single first-frame image from the H3 model (with sigma shift) "
                "and save it to the ComfyUI output directory. The saved image's "
                "filename is returned so the frontend can write it back to the segment."
            ),
            inputs=[
                io.Model.Input("model", tooltip="UNet model used to sample the latent."),
                io.Clip.Input("clip"),
                io.Vae.Input("vae", tooltip="VAE used to encode reference images and decode the sampled latent."),
                io.Combo.Input(
                    "output_resolution",
                    options=["1:1方形", "9:16竖屏", "16:9横屏", "3:2横屏", "2:3竖屏", "4:3横屏", "3:4竖屏", "21:9超宽"],
                    default="16:9横屏", optional=True,
                    tooltip="Target output aspect ratio. Width/height are calculated from million_pixels.",
                ),
                io.Float.Input(
                    "million_pixels", default=0.6, min=0.1, max=4.0, step=0.1, optional=True,
                    tooltip="Million pixels target. 1.0 MP ≈ 1024×1024.",
                ),
                io.String.Input("prompt", multiline=True, dynamic_prompts=True),
                io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff, step=1),
                io.Int.Input("steps", default=20, min=1, max=100, step=1),
                io.Float.Input("cfg", default=5.5, min=0.0, max=100.0, step=0.1),
                io.Combo.Input(
                    "sampler_name",
                    options=["euler", "euler_ancestral", "heun", "heunpp2", "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_sde", "dpmpp_sde_gpu", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_2m_sde_gpu", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddim", "uni_pc", "uni_pc_bh2"],
                    default="euler",
                ),
                io.Combo.Input(
                    "scheduler",
                    options=["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"],
                    default="beta",
                ),
                io.Float.Input("denoise", default=1.0, min=0.0, max=1.0, step=0.01),
                io.Float.Input("shift_video", default=12.0, min=0.01, max=100.0, step=0.01),
                io.Float.Input("shift_audio", default=3.0, min=0.01, max=100.0, step=0.01),
                io.String.Input("filename_prefix", default="minimaxrefdirector/firstframe"),
                io.Autogrow.Input(
                    "ref_images",
                    optional=True,
                    template=io.Autogrow.TemplatePrefix(
                        input=io.String.Input("ref_image", tooltip="Reference image, scaled (down only) to the output's pixel area"),
                        prefix="ref_image_",
                        min=0,
                        max=9,
                    ),
                ),
            ],
            outputs=[io.Image.Output(display_name="images", tooltip="The saved first-frame image.")],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Force execution on every iteration so a changing filename_prefix
        # (e.g. from MiniMaxRefJoinString inside a loop) is picked up each pass.
        return float("NaN")

    @classmethod
    def execute(cls, model, clip, vae, output_resolution="16:9横屏", million_pixels=0.6, prompt="",
                seed=0, steps=20, cfg=5.5, sampler_name="euler", scheduler="beta", denoise=1.0,
                shift_video=12.0, shift_audio=3.0, filename_prefix="minimaxrefdirector/firstframe",
                ref_images=None) -> io.NodeOutput:
        if model is None:
            raise ValueError("RefGenerateImage needs a model to sample")
        if vae is None:
            raise ValueError("RefGenerateImage needs a vae to decode the latent")

        width, height = calc_resolution(output_resolution, million_pixels)
        latent = _image_av_latent(width, height)

        ref_items = []   # tokenizer presentation, in request order
        ref_blocks = []  # DiT payload, same order
        for image_path in (ref_images or {}).values():
            if not image_path:
                continue
            img = load_image_tensor(image_path)
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

        # negative conditioning：空文本
        neg_tokens = clip.tokenize("")
        neg_cond = clip.encode_from_tokens_scheduled(neg_tokens)

        # sigma shift（复刻 MiniMaxH3SigmaShift：video 驱动采样 sigma，audio 交给 DiT）
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

        # KSampler 采样 → VAEDecode
        samples = nodes.KSampler().sample(
            m, int(seed), int(steps), float(cfg), sampler_name, scheduler,
            cond, neg_cond, latent, denoise=float(denoise),
        )[0]
        images = nodes.VAEDecode().decode(vae, samples)[0]

        # 保存首帧图片，filename 通过 ui 返回
        ui = UI.ImageSaveHelper.get_save_images_ui(
            images=images,
            filename_prefix=filename_prefix,
            cls=cls,
        )
        return io.NodeOutput(images, ui=ui)
