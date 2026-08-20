# -*- coding: utf-8 -*-
"""H3 motion context 辅助（ComfyUI-H3-Motion-Context）。

提供 pinned 帧网格吸附、模块定位、prev_tail 视频帧解码与 motion context 叠加。
被 guide.py 的段条件构建使用。
"""
import importlib.util
import logging
import os
import sys

import folder_paths

try:
    from comfy_api.latest import VideoFromFile
except ImportError:  # pragma: no cover
    from comfy_api.latest._input_impl import VideoFromFile

from .path import resolve_input_path, vhs_tuple_path

log = logging.getLogger(__name__)

# 与 H3 motion context 节点一致的参数：VAE 编码时每 token 覆盖的像素帧数、
# 合法的 pinned 帧网格（节点会把 n 向下吸附到该网格）
_MC_FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
_MC_RUN_GRID = (124, 107, 90, 73, 56, 39, 22, 5, 1)


def _latent_video_capacity(latent):
    """段 latent 视频流实际覆盖的像素帧数（与 H3 motion context 的 frame_count 一致）。"""
    samples = latent.get("samples") if isinstance(latent, dict) else None
    if samples is None:
        return None
    if hasattr(samples, "unbind"):
        video = list(samples.unbind())[0]
    elif isinstance(samples, (tuple, list)):
        video = samples[0]
    else:
        return None
    if getattr(video, "ndim", 0) == 4:
        video = video.unsqueeze(0)
    latent_t = int(video.shape[2])
    return sum(_MC_FRAME_PER_TOKEN[k % 5] for k in range(latent_t))


def _safe_mc_frames(latent, requested, available):
    """在段 latent 覆盖帧数之内，取最接近 requested 的合法 motion context 帧数。

    H3 motion context 会把 n 向下吸附到 _MC_RUN_GRID，且要求 n < 段 latent 覆盖的
    像素帧数，否则会抛 "asked to pin ... frames into a ... frame clip"。
    """
    capacity = _latent_video_capacity(latent)
    n = min(int(requested), int(available))
    if capacity is None:
        return max(1, n)
    for g in _MC_RUN_GRID:  # 降序
        if g <= n and g < capacity:
            return g
    return 1  # 兜底：1 帧对任意合法 latent 均不越界


def _get_motion_context_module():
    """定位并返回 ComfyUI-H3-Motion-Context 的 nodes 模块（含 MiniMaxH3MotionContext）。

    ComfyUI 启动时会 import custom_nodes 下每个目录，因此该包（及其 nodes 子模块）
    通常已在 sys.modules 中。其 nodes.py 含相对导入（from .patch_layout ...），无法
    用 importlib 以单个文件方式加载，兜底按包加载以解析相对导入。
    """
    for mod in list(sys.modules.values()):
        f = getattr(mod, "__file__", None) or ""
        if "ComfyUI-H3-Motion-Context" in f.replace("\\", "/") \
                and hasattr(mod, "MiniMaxH3MotionContext"):
            return mod

    root = os.path.join(folder_paths.base_path, "custom_nodes",
                        "ComfyUI-H3-Motion-Context")
    if not os.path.isdir(root):
        raise RuntimeError(
            "[MiniMaxRefGuide] motion context requires ComfyUI-H3-Motion-Context. "
            "Clone https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context into "
            "custom_nodes and restart ComfyUI."
        )
    pkg_name = "ComfyUI-H3-Motion-Context"
    nodes_name = pkg_name + ".nodes"
    if nodes_name not in sys.modules:
        pkg_spec = importlib.util.spec_from_file_location(
            pkg_name, os.path.join(root, "__init__.py"))
        pkg = importlib.util.module_from_spec(pkg_spec)
        sys.modules[pkg_name] = pkg
        if pkg_spec.loader is not None:
            pkg_spec.loader.exec_module(pkg)
    mod = sys.modules.get(nodes_name)
    if mod is None or not hasattr(mod, "MiniMaxH3MotionContext"):
        raise RuntimeError(
            "[MiniMaxRefGuide] could not load MiniMaxH3MotionContext from "
            "ComfyUI-H3-Motion-Context. See the ComfyUI console for details."
        )
    return mod


def _load_prev_tail_frames(prev_tail, max_frames=56):
    """解码上一段视频，截取尾部至多 max_frames 帧，供 motion context 使用。

    兼容三种输入：
    - str：本地路径（VHS VideoCombine 的 filename / 绝对路径）
    - tuple/list：VHS_FILENAMES（(filename, subfolder, type[, path])）
    - comfy_api VideoFromFile 对象（ComfyUI 0.33+ 视频输入自动转换）
    """
    try:
        if isinstance(prev_tail, VideoFromFile):
            frames = prev_tail.get_components().images  # [N, H, W, C]
        elif isinstance(prev_tail, (tuple, list)) and len(prev_tail) >= 1:
            # vhs_tuple_path 在 get_annotated_filepath 解析失败时会退回原始相对路径，
            # 统一再走 resolve_input_path 兜底（input→output→temp），仍失败则明确告警。
            path = vhs_tuple_path(prev_tail)
            resolved = resolve_input_path(path)
            if not resolved:
                log.warning(f"[MiniMaxRefGuide] prev_tail video not found: {path!r}")
                return None
            frames = VideoFromFile(resolved).get_components().images
        elif isinstance(prev_tail, str):
            # 兼容相对 output 目录的路径（如 VHS 输出 "subfolder/xx.mp4"）：
            # 直接交给 VideoFromFile 会按 CWD 解析导致 FileNotFoundError，
            # 先用 resolve_input_path（裸相对路径依次尝试 input→output→temp）转绝对路径。
            path = resolve_input_path(prev_tail)
            if not path:
                log.warning(f"[MiniMaxRefGuide] prev_tail video not found: {prev_tail!r}")
                return None
            frames = VideoFromFile(path).get_components().images
        else:
            log.warning(f"[MiniMaxRefGuide] unsupported prev_tail type: "
                        f"{type(prev_tail).__name__}")
            return None
    except Exception:
        log.warning(f"[MiniMaxRefGuide] failed to load prev_tail video {prev_tail!r}",
                    exc_info=True)
        return None
    if frames.shape[0] > max_frames:
        frames = frames[-max_frames:]
    return frames


def _apply_motion_context(cond, latent, video_vae, context_frames,
                          context_length, audio_vae=None):
    """对段条件叠加 H3 motion context：把 pinned 帧钉到段头部作为 keyframes。

    context_frames: [N, H, W, C] 帧序列，节点只取其中尾部 n 帧并按当前段分辨率
    重采样（像素路径，可跨分辨率）。返回 (cond, trim_frames)，trim_frames 是
    ANCHOR_MODE=head 时需从最终解码结果头部裁掉的帧数。
    """
    m = _get_motion_context_module()
    node = getattr(m, "MiniMaxH3MotionContext")
    n = _safe_mc_frames(latent, context_length, context_frames.shape[0])
    cond, trim = node().apply(
        cond, video_vae, latent, str(n),
        context_frames=context_frames,
        audio_vae=audio_vae,
    )
    return cond, trim
