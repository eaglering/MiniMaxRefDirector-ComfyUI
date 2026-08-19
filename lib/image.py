import torch
import logging
from node_helpers import pillow
from PIL import Image, ImageOps
import numpy as np

from comfy_api.latest import io, UI
from .path import resolve_input_path

log = logging.getLogger(__name__)

# Aspect ratio presets: (width_ratio, height_ratio)
RESOLUTION_PRESETS = {
    "1:1方形":   (1, 1),
    "9:16竖屏":  (9, 16),
    "16:9横屏":  (16, 9),
    "3:2横屏":   (3, 2),
    "2:3竖屏":   (2, 3),
    "4:3横屏":   (4, 3),
    "3:4竖屏":   (3, 4),
    "21:9超宽":  (21, 9),
}

def calc_resolution(preset: str, million_pixels: float, divide_by=32) -> tuple[int, int]:
    """Calculate width/height from aspect ratio and target megapixels.

    Computes the long side first: long = sqrt(total_pixels * long_ratio / short_ratio),
    snaps it to divide_by, then derives the short side from the snapped long side.
    Uses round-half-up to avoid Python's banker's rounding.
    """
    ratios = RESOLUTION_PRESETS.get(preset, RESOLUTION_PRESETS["16:9横屏"])
    w_ratio, h_ratio = ratios
    total_pixels = million_pixels * 1_000_000

    if total_pixels <= 0:
        return divide_by, divide_by

    def snap(v: float) -> int:
        """Round-half-up and snap to nearest multiple of divide_by."""
        return max(divide_by, int(v / divide_by + 0.5) * divide_by)

    if w_ratio >= h_ratio:
        # Landscape or square: width is the long side
        w = (total_pixels * w_ratio / h_ratio) ** 0.5
        w = snap(w)
        h = snap(w * h_ratio / w_ratio)
    else:
        # Portrait: height is the long side
        h = (total_pixels * h_ratio / w_ratio) ** 0.5
        h = snap(h)
        w = snap(h * w_ratio / h_ratio)

    return int(w), int(h)


def has_image(image) -> bool:
    """Check whether the image is valid (not None and not an empty tensor)."""
    if image is None:
        return False
    if hasattr(image, "numel") and image.numel() == 0:
        return False
    return True

def load_image_tensor(filepath: str) -> torch.Tensor|None:
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
        log.warning(f"[MiniMaxRefDirector] Failed to load image {filepath}: {e}")
        return None

def tensor_to_base64(image) -> str:
    """Convert a ComfyUI image tensor [B, H, W, C] (float 0-1) to a JPEG base64 data URL."""
    import base64 as _b64
    import io as _io
    from PIL import Image as _PILImage

    img = image[0].float().clamp(0, 1).cpu().numpy()
    img = (img * 255).round().astype("uint8")
    pil_img = _PILImage.fromarray(img, mode="RGB")
    buf = _io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=92)
    return "data:image/jpeg;base64," + _b64.b64encode(buf.getvalue()).decode("ascii")

class RefSaveImage(io.ComfyNode):
    """Save images to the ComfyUI output directory."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefSaveImage",
            display_name="MiniMaxRef Save Image",
            category="minimaxrefdirector",
            description=(
                "Saves the input images to the ComfyUI output directory "
                "(ComfyUI/output) with the given filename prefix."
            ),
            inputs=[
                io.String.Input(
                    "filename_prefix",
                    default="Tenz",
                    tooltip=(
                        "The filename prefix for the saved files. "
                        "Images are saved to the ComfyUI output directory."
                    ),
                ),
                io.Image.Input("images", tooltip="The images to save."),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
            outputs=[io.Image.Output(display_name="images", tooltip="The saved images.")],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Force execution on every iteration so a changing filename_prefix
        # (e.g. from MiniMaxRefJoinString inside a loop) is picked up each pass.
        return float("NaN")

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