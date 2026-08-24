"""MiniMaxRef video combine helpers.

视频合并/保存相关辅助函数，供节点层（combine_video.py 等）复用：

- trim_frames              裁剪：按帧数截取帧张量头部
- encode_frames_with_vhs   VHS 封装：优先 VideoCombine（含音频），回退本地 ffmpeg
- build_vhs_filenames      构造 VHS_FILENAMES 4 元组 (filename, subfolder, type, full_path)

4 元组约定与 guide.py ``_vhs_tuple_path`` 完全一致，可直连 MiniMaxRefGuide 的 prev_tail。
"""

import importlib.util
import logging
import os
import sys

import folder_paths
import torch

from .video import (
    encode_video_frames,
)

log = logging.getLogger(__name__)


def _ensure_vhs_importable() -> None:
    """让 ``videohelpersuite`` 可按顶层包导入（VHS 的 custom node 目录不在 sys.path 上）。

    ComfyUI 用完整路径注册自定义节点模块（如
    ``d:\\...\\ComfyUI-VideoHelperSuite.videohelpersuite.nodes``），且从不把节点目录
    加入 sys.path；若 VHS 未以 pip 包安装，顶层 ``import videohelpersuite`` 会
    ModuleNotFoundError，导致永远回退到本地 ffmpeg。这里在 custom_nodes 目录下
    找到 VHS 包目录并加入 sys.path。
    """
    if importlib.util.find_spec("videohelpersuite") is not None:
        return
    try:
        custom_nodes = folder_paths.folder_names_and_paths.get("custom_nodes", [[], set()])[0]
    except Exception:  # noqa: BLE001
        custom_nodes = []
    # 兜底：本项目位于 custom_nodes/<此节点>/lib 下，上一级上一级即 custom_nodes 根。
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if root not in custom_nodes:
        custom_nodes = list(custom_nodes) + [root]
    for base in custom_nodes:
        candidate = os.path.join(base, "ComfyUI-VideoHelperSuite")
        if os.path.isdir(candidate):
            sys.path.insert(0, candidate)
            return


# VideoHelperSuite 是软依赖：安装后启用完整能力（AUDIO / metadata / 多容器），
# 未安装时回退到本地 ffmpeg（不含音频）。
try:
    _ensure_vhs_importable()
    from videohelpersuite.nodes import VideoCombine, get_video_formats

    VIDEO_FORMATS = list(get_video_formats()[0]) or ["video/h264-mp4"]
except Exception as exc:  # noqa: BLE001 - VHS 是软依赖
    # 不静默：打印失败原因，便于区分“未安装”与“版本不兼容导致导入失败”。
    log.warning("[video_combine] VideoHelperSuite unavailable, "
                "using local ffmpeg fallback (no audio track): %r", exc)
    VideoCombine = None
    VIDEO_FORMATS = ["video/h264-mp4", "video/h264-mkv", "video/av1-mp4"]


def trim_frames(frames: torch.Tensor, max_frames: int | None) -> torch.Tensor:
    """按帧数截取帧张量头部；max_frames 非正或为空时原样返回。"""
    if frames is None:
        return frames
    if max_frames is not None and max_frames > 0 and frames.shape[0] > max_frames:
        return frames[:max_frames]
    return frames


# ── VHS 封装 ────────────────────────────────────────────────────────────

def resolve_output_full_path(filename: str, subfolder: str, ftype: str) -> str:
    """按 (filename, subfolder, type) 解析本地绝对路径，兼容新旧 ComfyUI。"""
    if ftype == "input":
        base = folder_paths.get_input_directory()
    elif ftype == "temp":
        base = folder_paths.get_temp_directory()
    else:
        base = folder_paths.get_output_directory()
    return os.path.abspath(os.path.join(base, subfolder or "", filename))


def encode_frames_with_vhs(
    images: torch.Tensor,
    audio: dict | None = None,
    frame_rate: float = 24.0,
    loop_count: int = 0,
    filename_prefix: str = "MiniMaxRef/combine",
    format: str = "video/h264-mp4",
    pingpong: bool = False,
    save_output: bool = True,
    prompt: dict | None = None,
    extra_pnginfo: dict | None = None,
) -> dict:
    """把 [B,H,W,C] 帧张量编码为视频文件。

    优先使用 VideoHelperSuite 的 VideoCombine（支持 AUDIO / metadata / 多容器）；
    VHS 未安装或编码失败时回退到本地 ffmpeg（忽略 AUDIO 输入）。

    返回 {"filename", "subfolder", "type", "full_path", "ui"}；
    ui 为 VideoCombine 的原始 UI（含 gifs）或 ffmpeg 回退时构造的等价结构。
    """
    # 帧输入保持原样流式传递（tensor 或一次性帧流均可）：
    # 不物化全部帧，显存峰值保持在单段解码水平（与 motion-context-multiref 一致）。
    # VHS 失败后由 encode_video_frames 的 ffmpeg 回退统一 reset 帧流再重放。
    vhs_error: Exception | None = None
    if VideoCombine is not None:
        try:
            vc = VideoCombine()
            out = vc.combine_video(
                frame_rate=float(frame_rate),
                loop_count=int(loop_count),
                images=images,
                filename_prefix=filename_prefix,
                format=format,
                pingpong=bool(pingpong),
                save_output=True,
                audio=audio,
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            ui_gifs = (out.get("ui") if isinstance(out, dict) else None)
            if not isinstance(ui_gifs, dict) or not ui_gifs.get("gifs"):
                # VHS 常见：batch 未完成时返回 {"ui": {"unfinished_batch": [True]}}，
                # 没有 gifs 键；或返回结构异常。显式抛错让下方统一记录原因。
                raise RuntimeError(
                    "VideoCombine returned no gifs (ui=%r, keys=%r)" % (
                        ui_gifs, list(out.keys()) if isinstance(out, dict) else type(out).__name__,
                    )
                )
            # ui["gifs"] 数组可能包含多个条目（如中间产物 + 最终文件），
            # 最后一个才是最终保存的文件（VHS 的 preview["fullpath"] 同样取 output_files[-1]）。
            preview = ui_gifs["gifs"][-1]
            filename = preview["filename"]
            subfolder = preview.get("subfolder", "")
            ftype = preview.get("type", "output")
            return {
                "filename": filename,
                "subfolder": subfolder,
                "type": ftype,
                "full_path": resolve_output_full_path(filename, subfolder, ftype),
                "ui": out["ui"],
            }
        except Exception as exc:  # noqa: BLE001
            vhs_error = exc
            log.warning("[video_combine] VideoCombine encode failed, "
                        "falling back to ffmpeg: %s", exc)

    if audio is not None:
        if vhs_error is not None:
            log.warning(
                "[video_combine] VideoCombine 失败（%s）回退到本地 ffmpeg："
                "ffmpeg 回退不含音轨。此处音频来自 audio_vae 解码的 latent "
                "（audio 输入为空时的自动行为）。", vhs_error,
            )
        else:
            log.warning(
                "[video_combine] VideoCombine 未返回结果，回退到本地 ffmpeg："
                "ffmpeg 回退不含音轨。此处音频来自 audio_vae 解码的 latent "
                "（audio 输入为空时的自动行为）。"
            )

    # try_vhs=False：本函数已尝试过 VideoCombine（上方），失败后直接走
    # ffmpeg 回退，避免二次 VHS 尝试重复消费一次性帧流。
    meta = encode_video_frames(images, float(frame_rate), filename_prefix, format, try_vhs=False)
    filename = meta["filename"]
    subfolder = meta.get("subfolder", "")
    ftype = meta.get("type", "output")
    full_path = resolve_output_full_path(filename, subfolder, ftype)
    ui = {
        "gifs": [
            {
                "filename": filename,
                "subfolder": subfolder,
                "type": ftype,
                "format": format,
                "fullpath": full_path,
            }
        ]
    }
    return {
        "filename": filename,
        "subfolder": subfolder,
        "type": ftype,
        "full_path": full_path,
        "ui": ui,
    }


def build_vhs_filenames(meta: dict) -> tuple:
    """从 encode_frames_with_vhs 的结果构造 VHS_FILENAMES 4 元组。

    (filename, subfolder, type, full_path) —— 与 guide.py ``_vhs_tuple_path`` 约定一致。
    """
    return (
        meta["filename"],
        meta.get("subfolder", ""),
        meta.get("type", "output"),
        meta["full_path"],
    )
