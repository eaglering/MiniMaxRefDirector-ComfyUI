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
    """定位并返回 ComfyUI-H3-Motion-Context-MultiRef 的 nodes 模块（含 MiniMaxH3MotionContext）。

    仅接受 MultiRef 变体：其 MiniMaxH3MotionContext.apply() 支持 encode_mode /
    anchor_mode / crop 显式参数，与 _apply_motion_context 的调用签名匹配；旧版
    ComfyUI-H3-Motion-Context 不支持这些参数，且目录名前缀被 MultiRef 包含，
    容易在 sys.modules 遍历时误命中，故直接排除。MultiRef 不存在时明确报错。
    ComfyUI 启动时会 import custom_nodes 下每个目录，因此该包（及其 nodes 子模块）
    通常已在 sys.modules 中。其 nodes.py 含相对导入（from .patch_layout ...），无法
    用 importlib 以单个文件方式加载，兜底按包加载以解析相对导入。
    """
    for mod in list(sys.modules.values()):
        f = getattr(mod, "__file__", None) or ""
        if "ComfyUI-H3-Motion-Context-MultiRef" in f.replace("\\", "/") \
                and hasattr(mod, "MiniMaxH3MotionContext"):
            return mod

    root = os.path.join(folder_paths.base_path, "custom_nodes",
                        "ComfyUI-H3-Motion-Context-MultiRef")
    if not os.path.isdir(root):
        raise RuntimeError(
            "[MiniMaxRefGuide] motion context requires ComfyUI-H3-Motion-Context-MultiRef. "
            "Clone https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context-MultiRef into "
            "custom_nodes and restart ComfyUI."
        )
    pkg_name = "ComfyUI-H3-Motion-Context-MultiRef"
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
            "ComfyUI-H3-Motion-Context-MultiRef. See the ComfyUI console for details."
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


def _load_prev_tail_latent_frames(context_latent, video_vae, max_frames=56):
    """从上一镜 joint latent 解码视频流，截取尾部至多 max_frames 帧。

    这是 context_latent 替代 prev_tail 的核心：上一段的最终 joint latent
    （KSampler 输出，未经落盘 mp4 / 视频编码压缩）直接在此解码为像素帧，
    跳过「先保存视频 → 再读文件解码」的一轮有损往返，抑制多次循环的噪点累积。

    兼容两种形态（split_joint_latent 均已支持）：
    - KSampler 输出：samples 为 NestedTensor；
    - MiniMaxH3MotionContextLoadLatent 输出：{"samples": [video, audio]} list。

    返回 (frames [N,H,W,C] | None, latent | None)：latent 供 motion context 的
    context_latent 音频流直切使用——仅当 latent 带有效音频流时才返回原对象
    （MultiRef 会拒绝无音频流的普通 latent），否则返回 None（视频帧仍可用，
    音频降级走 audio_vae）。视频流缺失/解码失败返回 (None, None)，
    由调用方降级到 prev_tail 或跳过。
    """
    try:
        from . import latent as latent_lib
        video_lat, audio_lat = latent_lib.split_joint_latent(context_latent)
        if video_lat.ndim == 4:
            video_lat = video_lat.unsqueeze(0)
        if video_lat.ndim != 5:
            log.warning(
                "[MiniMaxRefGuide] context_latent video stream has unsupported "
                "shape %s", tuple(getattr(video_lat, "shape", ())))
            return None, None
        # decode_video_latent_frames 走 CPU 流式缓冲防 OOM，输出 [1,T,H,W,3]
        decoded = latent_lib.decode_video_latent_frames(video_vae, video_lat)
        if getattr(decoded, "ndim", 0) == 5:
            decoded = decoded[0]  # [T,H,W,3] == [N,H,W,C]
        if decoded.shape[0] > max_frames:
            decoded = decoded[-max_frames:]
        audio_ok = (
            audio_lat is not None
            and getattr(audio_lat, "ndim", 0) >= 1
            and int(audio_lat.shape[-1]) > 0
        )
        pass_ctx = context_latent if audio_ok else None
        if not audio_ok:
            log.info(
                "[MiniMaxRefGuide] context_latent has no usable audio stream; "
                "audio context falls back to audio_vae path")
        return decoded, pass_ctx
    except Exception:
        log.warning(
            "[MiniMaxRefGuide] failed to decode context_latent video stream, "
            "falling back to prev_tail", exc_info=True)
        return None, None


def _get_h3_context_noise_module():
    """定位 ComfyUI-H3-Context-Noise 的 nodes 模块（降噪用），缺失返回 None。

    该插件提供两条与 H3 motion context 对应的加噪节点：
    - MiniMaxH3ContextTaperNoise        IMAGE -> IMAGE（context_frames 路径）
    - MiniMaxH3ContextLatentTaperNoise  LATENT -> LATENT（context_latent 路径，
      只接受 H3 AV 嵌套 latent，音频流保持原样）
    找不到时仅返回 None，调用方跳过降噪（行为等同未开启），不阻断执行。
    """
    for mod in list(sys.modules.values()):
        f = getattr(mod, "__file__", None) or ""
        if "ComfyUI-H3-Context-Noise" in f.replace("\\", "/"):
            return mod
    root = os.path.join(folder_paths.base_path, "custom_nodes",
                        "ComfyUI-H3-Context-Noise")
    if os.path.isdir(root):
        pkg_name = "ComfyUI-H3-Context-Noise"
        try:
            if pkg_name not in sys.modules:
                spec = importlib.util.spec_from_file_location(
                    pkg_name, os.path.join(root, "__init__.py"))
                pkg = importlib.util.module_from_spec(spec)
                sys.modules[pkg_name] = pkg
                if spec.loader is not None:
                    spec.loader.exec_module(pkg)
            mod = sys.modules.get(pkg_name + ".nodes")
            if mod is not None and hasattr(mod, "MiniMaxH3ContextTaperNoise"):
                return mod
        except Exception:
            log.warning(
                "[MiniMaxRefGuide] could not load ComfyUI-H3-Context-Noise "
                "(denoise skipped)", exc_info=True)
    return None


def _denoise_opts(seg_denoise: dict | None) -> dict | None:
    """规整片段级降噪参数；未启用返回 None（调用方跳过）。"""
    if not isinstance(seg_denoise, dict) or not seg_denoise.get("enabled"):
        return None
    return {
        "alpha": float(seg_denoise.get("alpha", 0.45)),
        "alpha_end": float(seg_denoise.get("alpha_end", 0.10)),
        "ramp": max(1, int(seg_denoise.get("ramp", 3) or 3)),
        "seed": int(seg_denoise.get("seed", 0) or 0),
    }


def _denoise_context_frames(frames, ctx_len, opts):
    """frames 路径降噪：MiniMaxH3ContextTaperNoise 对尾部 ctx_len 帧注入锥形噪声。

    调用方在把帧交给 H3 motion context 之前调用（H3 节点取尾部 n 帧钉住，
    因此 tail_frames=ctx_len 保证被钉的帧全部经过加噪处理）。失败时返回原帧。
    """
    mod = _get_h3_context_noise_module()
    if mod is None:
        log.warning("[MiniMaxRefGuide] denoise requested but ComfyUI-H3-Context-Noise "
                    "is not installed; skipping denoise")
        return frames
    try:
        node = getattr(mod, "MiniMaxH3ContextTaperNoise")()
        out, _schedule = node.inject(
            images=frames,
            tail_frames=int(ctx_len),
            alpha=opts["alpha"],
            alpha_end=opts["alpha_end"],
            ramp_frames=opts["ramp"],
            seed=opts["seed"],
        )
        log.info("[MiniMaxRefGuide] denoise(frames) tail=%d alpha=%.3f->%.3f ramp=%d",
                 int(ctx_len), opts["alpha"], opts["alpha_end"], opts["ramp"])
        return out
    except Exception:
        log.warning("[MiniMaxRefGuide] denoise(frames) failed, continuing with "
                    "original frames", exc_info=True)
        return frames


def _denoise_context_latent(ctx_latent, ctx_len, opts):
    """latent 路径降噪：MiniMaxH3ContextLatentTaperNoise 对视频流尾部加噪。

    只改视频流尾部 latent steps，音频流原样（插件语义）。tail_frames 需落在
    合法整步值（5/22/39/56...）→ 传 str(ctx_len)（ctx_len 本就吸附到该网格）。
    ramp_steps 由像素 ramp 换算（≈ 2/3 像素帧斜坡，插件校验配方 3→2）。
    失败时返回原 latent。
    """
    mod = _get_h3_context_noise_module()
    if mod is None:
        log.warning("[MiniMaxRefGuide] denoise requested but ComfyUI-H3-Context-Noise "
                    "is not installed; skipping denoise")
        return ctx_latent
    try:
        node = getattr(mod, "MiniMaxH3ContextLatentTaperNoise")()
        ramp_steps = max(1, int(round(opts["ramp"] * 2.0 / 3.0)))
        out, _schedule = node.inject(
            context_latent=ctx_latent,
            tail_frames=str(int(ctx_len)),
            alpha=opts["alpha"],
            alpha_end=opts["alpha_end"],
            ramp_steps=ramp_steps,
            seed=opts["seed"],
        )
        log.info("[MiniMaxRefGuide] denoise(latent) tail=%d alpha=%.3f->%.3f "
                 "ramp_steps=%d", int(ctx_len), opts["alpha"], opts["alpha_end"],
                 ramp_steps)
        return out
    except Exception:
        log.warning("[MiniMaxRefGuide] denoise(latent) failed, continuing with "
                    "original latent", exc_info=True)
        return ctx_latent


def _apply_motion_context(cond, latent, video_vae, context_frames,
                          context_length, audio_vae=None, context_latent=None):
    """对段条件叠加 H3 motion context：把 pinned 帧钉到段头部作为 keyframes。

    context_frames: [N, H, W, C] 帧序列，节点只取其中尾部 n 帧并按当前段分辨率
    重采样（像素路径，可跨分辨率）。返回 (cond, trim_frames)，trim_frames 是
    ANCHOR_MODE=head 时需从最终解码结果头部裁掉的帧数。

    context_latent: 上一镜的 joint H3 latent（含视频+音频流）。传给 MultiRef
    apply() 后其音频流被直接取尾（audio_src="latent"），免去 audio_vae 重建的
    二次失真；视频 keyframe 仍由 context_frames 像素帧编码（MultiRef 语义）。
    """
    m = _get_motion_context_module()
    node = getattr(m, "MiniMaxH3MotionContext")
    n = _safe_mc_frames(latent, context_length, context_frames.shape[0])
    # 适配 ComfyUI-H3-Motion-Context-MultiRef 签名：
    # apply(conditioning, vae, latent, context_frames, context_length,
    #       encode_mode, anchor_mode, crop, ...)
    # context_latent 需含 audio stream（无音频流的普通 latent 会被 MultiRef 拒绝，
    # 因此仅在确实传入时透传）。
    kwargs = {}
    if context_latent is not None:
        kwargs["context_latent"] = context_latent
    cond, trim = node().apply(
        cond, video_vae, latent, context_frames, int(n),
        encode_mode="video",
        anchor_mode="head",
        crop="disabled",
        audio_vae=audio_vae,
        **kwargs,
    )
    return cond, trim
