
import torch
import logging
from node_helpers import pillow
from PIL import Image, ImageOps
import numpy as np

from .path import resolve_input_path

log = logging.getLogger(__name__)

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
