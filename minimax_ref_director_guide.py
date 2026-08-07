import json
import os
import logging
import numpy as np
import torch
import av
from node_helpers import pillow
from PIL import Image, ImageOps
import folder_paths
from comfy_api.latest import io

GuideData = io.Custom("GUIDE_DATA")

log = logging.getLogger(__name__)


def _resolve_input_path(filename: str) -> str:
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


def _load_image_tensor(filepath: str) -> torch.Tensor:
    """Load an image file and return as float32 tensor."""
    try:
        img = pillow(Image.open, _resolve_input_path(filepath))
        img = pillow(ImageOps.exif_transpose, img)
        if img.mode == "I":
            img = img.point(lambda i: i * (1 / 255))
        image = img.convert("RGB")
        image = np.array(image).astype(np.float32) / 255.0

        return torch.from_numpy(image)[None,]
    except Exception as e:
        log.warning(f"[MiniMaxRefDirectorGuide] Failed to load image {filepath}: {e}")
        return torch.zeros((64, 64), dtype=torch.float32)


def _load_audio_tensor(filepath: str) -> dict:
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
        wav = f32_pcm(wav)
        return {"waveform": wav.unsqueeze(0), "sample_rate": sr}

def f32_pcm(wav: torch.Tensor) -> torch.Tensor:
    """Convert audio to float 32 bits PCM format."""
    if wav.dtype.is_floating_point:
        return wav
    elif wav.dtype == torch.int16:
        return wav.float() / (2 ** 15)
    elif wav.dtype == torch.int32:
        return wav.float() / (2 ** 31)
    raise ValueError(f"Unsupported wav dtype: {wav.dtype}")

class MiniMaxRefDirectorGuide(io.ComfyNode):
    """Extracts segment-specific data from MiniMaxRefDirector's guide_data by seg_index,
    loading subject reference images as [H,W,C] tensors and audio as waveform tensors."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefDirectorGuide",
            display_name="MiniMax Reference Director Guide",
            category="minimaxrefdirector",
            description=(
                "Given a guide_data from MiniMax Reference Director and a segment index, "
                "loads all referenced subject images/audio as tensors and outputs the segment prompt."
            ),
            inputs=[
                GuideData.Input(
                    "guide_data",
                    tooltip="Connect from MiniMax Reference Director's guide_data output.",
                ),
                io.Image.Input(
                    "first_frame", optional=True,
                    tooltip="Use first frame input if it's not set",
                ),
                io.Int.Input(
                    "seg_index", default=0, min=0, max=1000, step=1,
                    tooltip="Index of the timeline segment to extract (0-based).",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="image0", tooltip="Reference image0."),
                io.Image.Output(display_name="image1", tooltip="Reference image1."),
                io.Image.Output(display_name="image2", tooltip="Reference image2."),
                io.Image.Output(display_name="image3", tooltip="Reference image3."),
                io.Image.Output(display_name="image4", tooltip="Reference image4."),
                io.Image.Output(display_name="image5", tooltip="Reference image5."),
                io.Image.Output(display_name="image6", tooltip="Reference image6."),
                io.Image.Output(display_name="image7", tooltip="Reference image7."),
                io.Image.Output(display_name="image8", tooltip="Reference image8."),
                io.Audio.Output(display_name="audio0", tooltip="Reference audio0."),
                io.Audio.Output(display_name="audio1", tooltip="Reference audio1."),
                io.Audio.Output(display_name="audio2", tooltip="Reference audio2."),
                io.Int.Output(display_name="width", tooltip="Output width from global config."),
                io.Int.Output(display_name="height", tooltip="Output height from global config."),
                io.Int.Output(display_name="length", tooltip="Frame count."),
                io.Float.Output(display_name="frame_rate", tooltip="Frame rate from global config."),
                io.String.Output(display_name="prompt", tooltip="Fully assembled prompt for the selected segment."),
            ],
        )

    @classmethod
    def execute(cls, guide_data=None, first_frame=None, seg_index=0) -> io.NodeOutput:
        """Extract segment-level data and load all referenced subject images/audio."""

        if guide_data is None:
            raise ValueError("[MiniMaxRefDirectorGuide] guide_data is required and must not be empty.")

        # gdata = {}
        # try:
        #     gdata = json.loads(guide_data) if guide_data else {}
        # except (json.JSONDecodeError, TypeError):
        #     log.warning("[MiniMaxRefDirectorGuide] Failed to parse guide_data.")

        # --- Parse global config ---
        out_w = int(guide_data.get("width", 1920))
        out_h = int(guide_data.get("height", 1080))
        fps = float(guide_data.get("frame_rate", 24))
        subjects = guide_data.get("subjects", []) or []
        timeline = guide_data.get("timeline_data", []) or []

        segment_count = len(timeline)
        if segment_count == 0:
            raise ValueError("[MiniMaxRefDirectorGuide] guide_data.timeline_data is required and must not be empty.")

        # --- Clamp seg_index ---
        idx = max(0, min(int(seg_index), segment_count - 1))

        # --- Extract segment data ---
        seg = timeline[idx]
        prompt = str(seg.get("prompt", ""))
        subject_index = seg.get("subject_index", [])
        duration_frames = seg.get("duration_frames", 0)
        frame_refer = seg.get("first_frame", "").strip()
        if frame_refer or first_frame is not None:
            index = len(subject_index) + 1
            prompt = prompt.replace("{first_frame}", f"[Shot 1]在目标视频的0.00秒处，<Picture {index}>被完整引用。\n[Shot 2]", 1)
        else:
            prompt = prompt.replace("{first_frame}", "")
        if isinstance(subject_index, int):
            subject_index = [subject_index]
        subject_index = list(subject_index)

        # --- Load all referenced subject images as [C, H, W] tensors ---
        images = []
        audios = []

        for sid in subject_index:
            if 0 <= sid < len(subjects):
                subj = subjects[sid]

                # Load image
                image_path = _resolve_input_path(str(subj.get("imageFile", "")))
                if image_path and os.path.exists(image_path):
                    img_tensor = _load_image_tensor(image_path)
                    images.append(img_tensor)

                # Load audio if available
                audio_path = _resolve_input_path(str(subj.get("audioFile", "")))
                if audio_path and os.path.exists(audio_path):
                    audio_tensor = _load_audio_tensor(audio_path)
                    audios.append(audio_tensor)

        subject_index_str = json.dumps(subject_index, ensure_ascii=False)
        if frame_refer:
            images.append(_load_image_tensor(frame_refer))
        elif first_frame is not None:
            images.append(first_frame)

        # Pad/truncate images to match 10 output slots
        while len(images) < 9:
            images.append(None)
            # images.append(torch.zeros((out_h, out_w, 3), dtype=torch.float32))
        images = images[:9]

        # Pad/truncate audios to match 3 output slots
        while len(audios) < 3:
            audios.append(None)
            # audios.append({"waveform": torch.zeros(1, 2, 44100, dtype=torch.float32), "sample_rate": 44100})
        audios = audios[:3]

        log.info(
            f"[MiniMaxRefDirectorGuide] seg_index={idx}/{segment_count} | "
            f"subject_index={subject_index_str} | images={len(images)} audios={len(audios)} | "
            f"{out_w}×{out_h} @ {fps}fps | length={duration_frames}"
        )
        return io.NodeOutput(
            *images,
            *audios,
            out_w,
            out_h,
            duration_frames,
            fps,
            prompt,
        )


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefDirectorGuide": MiniMaxRefDirectorGuide,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefDirectorGuide": "MiniMax Reference Director Guide",
}
