"""MiniMaxRef director timeline timing helpers.

MultiRef 分段时间公式的参数化实现：每个素材段独立给定时长 a_n（秒）与
context 帧数 c_n（引导帧数），逐段计算：

    b_n              = max(5, round(a_n * fps)) + (5 - max(5, round(a_n * fps)) % 17) % 17
    cap_n            = (b_n - (b_n % 2)) // 2
    ctx_req          = max(5, min(c_n, cap_n))
    context_length_n = ctx_req - ((ctx_req - 5) % 17)
    e_n              = (b_n - context_length_n) / fps

其中 b_n 是 H3 视频 run（5, 22, 39, 56, 73, ...），context_length_n 是
≤ cap_n 的 H3 run，e_n 是该段的有效输出时长（秒）。段起始时间 = 前段
effective_seconds 的累计。

同时提供 MultiRef h3_timing 同款工具（largest_h3_video_run /
is_exact_av_boundary / sample_boundary_from_frames / crossfade_plan 等），
供节点元数据、无损合并 API 与 latent 音频落位复用。
"""

from dataclasses import dataclass

FPS = 24
AUDIO_LATENT_HZ = 40


# ── H3 run 网格工具（与 ComfyUI-H3-Motion-Context-MultiRef/h3_timing.py 一致）──

def largest_h3_video_run(frames: int) -> int:
    """不大于 frames 的最大 H3 视频 run：5, 22, 39, 56, 73, ..."""
    n = int(frames)
    if n < 5:
        return 0
    return 5 + ((n - 5) // 17) * 17


def is_h3_video_run(frames: int) -> bool:
    """是否为原生 H3 视频 run（5, 22, 39, ...）。"""
    n = int(frames)
    return n >= 5 and (n - 5) % 17 == 0


def is_exact_av_boundary(frames: int) -> bool:
    """24 fps 帧边界是否恰好落在 H3 40 Hz 音频网格上（39, 90, 141, ...）。"""
    return (int(frames) * AUDIO_LATENT_HZ) % FPS == 0


def video_runs_through(limit: int = 243) -> list[int]:
    """5, 22, 39, ... 到 limit 为止的所有 H3 视频 run。"""
    out = []
    n = 5
    while n <= int(limit):
        out.append(n)
        n += 17
    return out


def preferred_av_runs_through(limit: int = 243) -> list[int]:
    """端点同时落在 40 Hz 音频网格上的 H3 run（39, 90, 141, ...）。"""
    return [n for n in video_runs_through(limit) if is_exact_av_boundary(n)]


def snap_av_context_length(requested: int, available: int, target_frames: int) -> int:
    """把请求的 context 帧数吸附为精确的 AV 网格 run（照搬 MultiRef）。

    联合 H3 AV prefix 必须同时满足：
      1) 精确视频 run：5, 22, 39, 56, 73, ...
      2) 端点恰好落在 24 fps / 40 Hz 共享网格：39, 90, 141, 192, ...
    cap = min(requested, available, target_frames - 1)，从 cap 向下找
    最大的 AV run；< 39 时报错（无法构成精确 AV 接缝）。
    """
    cap = min(int(requested), int(available), int(target_frames) - 1)
    run = largest_h3_video_run(cap)
    while run >= 5 and not is_exact_av_boundary(run):
        run = largest_h3_video_run(run - 1)
    if run < 39:
        raise ValueError(
            "snap_av_context_length: need at least 39 usable source frames for "
            "an exact H3 video+audio context boundary at 24 fps / 40 Hz"
        )
    return run


def sample_boundary_from_frames(frame_position: int, sample_rate: int, fps: int = FPS) -> int:
    """帧边界在绝对视频时间轴上的最近 PCM 样本位置。"""
    return int(round(int(frame_position) / float(fps) * int(sample_rate)))


def sample_boundary_from_seconds(seconds: float, sample_rate: int) -> int:
    """时间边界在绝对时间轴上的最近 PCM 样本位置。"""
    return int(round(float(seconds) * int(sample_rate)))


def sample_span_for_frame_interval(
    start_frame: int, frame_count: int, sample_rate: int, fps: int = FPS
) -> int:
    """帧区间覆盖的 PCM 样本数（绝对边界换算，避免相对取整漂移）。"""
    start = sample_boundary_from_frames(start_frame, sample_rate, fps)
    end = sample_boundary_from_frames(int(start_frame) + int(frame_count), sample_rate, fps)
    return end - start


def crossfade_plan(context_frames: int, requested_crossfade: int) -> tuple[int, int]:
    """返回 (blend 前保留的 context 帧, 有效交叉淡化重叠帧)。

    重叠总是 context 的*最后*若干帧，因此较短的视觉淡化不会重放较长
    context 的旧部分。
    """
    n = max(0, int(context_frames))
    effective = min(n, max(0, int(requested_crossfade)))
    return n - effective, effective


# ── 参数化分段计划 ──────────────────────────────────────────────────────

@dataclass(frozen=True)
class SegmentPlan:
    """单个素材段的参数化时间计划。"""

    duration_seconds: float   # a_n：用户指定的段时长（秒）
    total_frames: int         # b_n：H3 视频 run（5, 22, 39, ...）
    context_frames: int       # context_length_n：≤ cap_n 的 H3 run
    effective_seconds: float  # e_n = (b_n - context_length_n) / fps（有效输出秒数）
    start_seconds: float = 0.0  # 段起始时间（前段 effective_seconds 累计）


def compute_segment_plan(a_seconds: float, c_frames: int, fps: int = FPS) -> SegmentPlan:
    """按参数化公式计算单个分段计划。

    :param a_seconds: 段时长（秒），> 0
    :param c_frames:  段 context 引导帧数（≥ 0，按 H3 run 向下吸附）
    :param fps:       视频帧率，默认 24
    """
    a = max(0.0, float(a_seconds))
    base = max(5, int(round(a * int(fps))))
    total_frames = base + (5 - base % 17) % 17
    cap = (total_frames - total_frames % 2) // 2
    ctx_req = max(5, min(int(c_frames), cap))
    context_frames = ctx_req - (ctx_req - 5) % 17
    effective_seconds = (total_frames - context_frames) / float(fps)
    return SegmentPlan(
        duration_seconds=a,
        total_frames=total_frames,
        context_frames=context_frames,
        effective_seconds=round(effective_seconds, 6),
    )


def compute_clip_starts(plans: list[SegmentPlan]) -> list[SegmentPlan]:
    """累计各段有效时长，填充每段的 start_seconds（起始时间）。

    段起始时间 = 前段有效时长的累计：clip_start_seconds_n = Σ_{k<n} e_k。
    """
    out: list[SegmentPlan] = []
    acc = 0.0
    for plan in plans:
        out.append(SegmentPlan(
            duration_seconds=plan.duration_seconds,
            total_frames=plan.total_frames,
            context_frames=plan.context_frames,
            effective_seconds=plan.effective_seconds,
            start_seconds=round(acc, 6),
        ))
        acc += plan.effective_seconds
    return out
