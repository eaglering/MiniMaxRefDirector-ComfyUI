import os
import av
import torch
import logging
import tempfile
import folder_paths
import torch.nn.functional as F

from pathlib import Path
from typing import Any, Mapping
from comfy_api.latest import io, UI

logger = logging.getLogger(__name__)

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

class RefSaveAudio(io.ComfyNode):
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
            category="minimaxrefdirector",
            inputs=[
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
                io.Audio.Input("audio", tooltip="The audio to save."),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
            outputs=[io.Audio.Output("audio", tooltip="The saved audio.")],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Force execution on every iteration so a changing filename_prefix
        # (e.g. from MiniMaxRefJoinString inside a loop) is picked up each pass.
        return float("NaN")

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
