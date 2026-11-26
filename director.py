import json
import os
import logging
import re
from comfy_api.latest import io

from .lib.audio import fill_audio_gaps
from .lib.image import calc_resolution
from .lib.prompt import build_h3_prompt, _translate_text_to_en
from .lib.skill_notes import glossary_for_text

GuideData = io.Custom("GUIDE_DATA")
SubjectData = io.Custom("SUBJECT_DATA")
SubjectConfig = io.Custom("SUBJECT_CONFIG")

log = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# 判断"非英文"：出现 CJK 字符即视为需要翻译成英文。
# 对白 <d>...</d> / 主体标签 <@...>、<#...> 以及双引号（含全角引号）包裹的内容
# 为禁止翻译片段（可能含中文），检测前先剥离，避免仅中文主体名/对白触发无谓的翻译调用。
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
# 引号保护：半角 "..." 与全角 \u201c...\u201d \u2018...\u2019（台词/标语/歌名等保持原语言）。
# 注意：不含半角单引号 '...'，避免与英文撇号（don't / it's）冲突。
_PROTECTED_FRAGMENT_RE = re.compile(
    r"<@[^>]*>|<#[^>]*>|<d>.*?</d>|\"[^\"]*\"|\u201c.*?\u201d|\u2018.*?\u2019",
    re.DOTALL,
)


def _persist_master_audio(audio: dict) -> dict | None:
    """把 master_audio（AUDIO dict）写入 input/whatdreamscost/，供 SPA「视频生成
    记录」登记回听。返回 {file_info, duration_s, sample_rate, size}；失败返回 None。

    写盘方式与 lib.audio.save_audio_to_temp_wav 一致（torchaudio 优先，
    soundfile 兜底），但落盘到持久目录（temp 目录会被 ComfyUI 清理）。
    """
    try:
        import datetime

        import torch

        waveform = audio.get("waveform")
        sample_rate = audio.get("sample_rate")
        if not isinstance(waveform, torch.Tensor) or sample_rate is None:
            return None
        wf = waveform[0] if waveform.dim() == 3 else waveform
        if wf.dim() != 2:
            return None

        import folder_paths

        out_dir = os.path.join(folder_paths.get_input_directory(), "whatdreamscost")
        os.makedirs(out_dir, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        name = f"master_audio_{ts}.wav"
        path = os.path.join(out_dir, name)
        n = 1
        while os.path.exists(path):
            name = f"master_audio_{ts}_{n}.wav"
            path = os.path.join(out_dir, name)
            n += 1
        try:
            import torchaudio  # type: ignore[import]

            torchaudio.save(path, wf.detach().cpu().float(), int(sample_rate))
        except Exception:
            import soundfile as sf  # type: ignore[import]

            sf.write(path, wf.detach().cpu().float().numpy().T, int(sample_rate))
        return {
            "file_info": {"filename": name, "subfolder": "whatdreamscost", "type": "input"},
            "duration_s": float(wf.shape[-1]) / float(sample_rate),
            "sample_rate": int(sample_rate),
            "size": os.path.getsize(path),
        }
    except Exception:
        log.warning("[MiniMaxRefDirector] failed to persist master_audio", exc_info=True)
        return None


def _needs_translate(prompt: str) -> bool:
    return bool(_CJK_RE.search(_PROTECTED_FRAGMENT_RE.sub("", prompt)))


def _spa_llm_opts() -> dict:
    """SPA「LLM 设置」面板的全局持久化配置（api_config.json 的 spa_llm 段）。"""
    try:
        from .api_config import api_config_manager

        cfg = api_config_manager.load_config() or {}
        spa = cfg.get("spa_llm") if isinstance(cfg.get("spa_llm"), dict) else {}
        spa = spa if isinstance(spa, dict) else {}
        return {k: str(v or "").strip() for k, v in spa.items() if str(v or "").strip()}
    except Exception:
        return {}


def _resolve_vlm_opts(opts: dict) -> dict:
    """补全段提示词翻译的 LLM 选项：节点 opts 缺失/不可用时回落 SPA 全局 LLM 设置。

    SPA 导演台工作流中 Subject 的 config 输入可能未连接（首帧 subgraph 不连），
    或节点档案里残留旧默认模式（deepseek-proxy）——此时用「LLM 设置」面板
    持久化的 spa_llm（llama-server / api / ollama 等），保证中文提示词仍能按
    用户当前选择的模式翻译为英文。节点显式配置且可用的字段始终优先。
    """
    merged = dict(opts or {})
    spa = _spa_llm_opts()
    spa_mode = str(spa.get("mode") or "").strip()
    if not spa_mode:
        return merged
    mode = str(merged.get("vlm_mode") or "").strip()
    node_usable = mode in ("llama-cpp", "llama-server", "llama-cpp-server") and bool(
        merged.get("gguf_path")
    )
    if not node_usable:
        # 节点未配置可用模式（空 / 残留网页桥接旧默认且无任何模型配置）：
        # 全局 spa_llm 优先，节点非空字段作补充（如 seed）
        out = {**spa, **{k: v for k, v in merged.items() if v}}
        out["vlm_mode"] = spa_mode
        return out
    # 节点已显式配置可用模式：仅补缺字段
    for k, v in spa.items():
        if not merged.get(k):
            merged[k] = v
    return merged


def _translate_prompt_to_en(prompt: str, opts: dict, glossary: dict | None = None) -> str:
    """段提示词含中文时，将保护片段替换为英文占位符后整段翻译为英文，再还原占位符。

    <@主体名> / <#主体名:对白> / <d>对白</d> 可能含中文，翻译前掩码为 MASKED_N
    英文占位符，模型看不到原文，从源头杜绝改写；翻译后按顺序原样还原。
    若模型破坏/丢失了占位符，则整体回退原文，保证对白/角色名不被污染。
    glossary: 术语型技能中英对照，注入翻译指令；None 时按源文自动提取。
    翻译失败时 _translate_text_to_en 内部回退原文，不抛异常。
    """
    # 1. 保护片段 → 英文占位符
    placeholders: dict[str, str] = {}

    def _repl(m: re.Match) -> str:
        token = f"MASKED_{len(placeholders)}"
        placeholders[token] = m.group(0)
        return token

    masked = _PROTECTED_FRAGMENT_RE.sub(_repl, prompt)
    # 2. 掩码后仍含中文才需要翻译（仅中文主体名/对白不会触发翻译）
    if not _CJK_RE.search(masked):
        return prompt
    # 3. 整段翻译为英文（subject_definitions / retention_analysis 等英文结构
    #    一并过模型，模型保持其英文原样，占位符被显式要求原样保留）
    if glossary is None:
        glossary = glossary_for_text(prompt)
    translated = _translate_text_to_en(
        masked,
        vlm_mode=str(opts.get("vlm_mode") or "llama-cpp"),
        options=opts,
        seed=int(opts.get("seed") or 42),
        glossary=glossary,
    )
    # 4. 占位符被模型删改 → 整体回退原文，避免对白/主体名丢失
    missing = [token for token in placeholders if token not in translated]
    if missing:
        return prompt
    for token, original in placeholders.items():
        translated = translated.replace(token, original)
    return translated


def director_inputs():
    """导演台输入 schema（历史导演台与 SPA 导演台共用，保证两节点输入严格一致）。"""
    return [
        SubjectConfig.Input(
            "config", optional=True,
            tooltip="Unified config from MiniMax Reference Subject (VLM opts + subject data).",
        ),
        io.Float.Input(
            "start_second", default=0.0, min=0.0, max=1000.0, step=0.01,
            tooltip="Start time in seconds of the timeline generation.",
        ),
        io.Float.Input(
            "end_second", default=5.0, min=0.0, max=1000.0, step=0.01,
            tooltip="End time in seconds of the timeline generation.",
        ),
        io.Float.Input(
            "duration_seconds", default=5.0, min=0.1, max=1000.0, step=0.01,
            tooltip="Total timeline duration in seconds (computed/synced from frames).",
        ),
        io.Int.Input(
            "start_frame", default=0, min=0, max=10000, step=1,
            tooltip="Start frame of the timeline generation.",
        ),
        io.Int.Input(
            "end_frame", default=120, min=1, max=10000, step=1,
            tooltip="End frame of the timeline generation.",
        ),
        io.Int.Input(
            "duration_frames", default=120, min=1, max=10000, step=1,
            tooltip="Total timeline length in pixel-space frames. Used by the editor for visual scale only.",
        ),
        io.String.Input(
            "timeline_data", default="",
            tooltip="JSON state of the timeline editor (auto-managed; do not edit by hand).",
        ),
        io.String.Input(
            "local_prompts", multiline=True, default="",
            tooltip="Auto-populated from the timeline editor.",
        ),
        io.String.Input(
            "segment_lengths", default="",
            tooltip="Auto-populated from the timeline editor (pixel-space frame counts).",
        ),
        io.Float.Input(
            "frame_rate", default=24, min=1, max=240, step=1, optional=True,
            tooltip="Frames per second — only affects how time is displayed in the timeline editor when time_units is set to 'seconds'.",
        ),
        io.Combo.Input(
            "display_mode", options=["frames", "seconds"], default="seconds", optional=True,
            tooltip="Display the ruler, segment ranges, length input, and total in frames or seconds. Internal storage is always pixel-space frames.",
        ),
        io.Combo.Input(
            "outpu_resolution",
            options=["1:1方形", "9:16竖屏", "16:9横屏", "3:2横屏", "2:3竖屏", "4:3横屏", "3:4竖屏", "21:9超宽"],
            default="16:9横屏", optional=True,
            tooltip="Target output aspect ratio. Width/height are calculated from million_pixels.",
        ),
        io.Float.Input(
            "million_pixels", default=0.6, min=0.1, max=4.0, step=0.1, optional=True,
            tooltip="Million pixels target. 1.0 MP ≈ 1024×1024.",
        ),
    ]


def director_outputs():
    """导演台输出 schema（历史导演台与 SPA 导演台共用，保证两节点输出严格一致）。"""
    return [
        GuideData.Output(display_name="guide_data"),
        io.Int.Output(display_name="segment_count"),
        io.Float.Output(display_name="frame_rate"),
        io.Audio.Output(
            display_name="master_audio",
            tooltip="完整音频：由补齐后的 audioSegments 合成为覆盖 [start,end) "
                    "的整轨波形（含空白段静音）。无音轨/全部静音时为 None。",
        ),
    ]


class MiniMaxRefDirector(io.ComfyNode):
    """Timeline director with resolution config and guide_data output for MiniMax pipelines."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxRefDirector",
            display_name="MiniMax Reference Director",
            category="minimaxrefdirector",
            description=(
                "Timeline director that combines prompt scheduling, subject data, "
                "resolution configuration, and prompt templates into a unified guide_data output."
            ),
            inputs=director_inputs(),
            outputs=director_outputs(),
        )

    @classmethod
    def execute(cls, config=None,
                start_second=0.0, end_second=5.0, duration_seconds=5.0,
                start_frame=0, end_frame=120, duration_frames=120, timeline_data="",
                local_prompts="", segment_lengths="", frame_rate=24,
                display_mode="seconds",  outpu_resolution="16:9横屏", million_pixels=0.6,
        ) -> io.NodeOutput:
        """Assemble guide_data from timeline, subjects, resolution, and prompt template."""
        # config 是可选输入：前端首帧 subgraph 中 director 不连接 config，需容错
        global_prompt = config.get("global_prompt", "") if config else ""
        subject_data = config.get("subject_data", {}) if config else {}
        subject = subject_data.get("subjects", []) if subject_data else []
        if not subject:
            subject = subject_data.get("subjects", []) if isinstance(subject_data, dict) else []

        if not timeline_data or not timeline_data.strip():
            raise ValueError("[MiniMaxRefDirector] timeline_data is required and must not be empty.")

        # --- Parse timeline segments ---
        tdata = {}
        try:
            tdata = json.loads(timeline_data) if timeline_data else {}
        except (json.JSONDecodeError, TypeError):
            log.warning("[MiniMaxRefDirector] Failed to parse timeline_data.")

        # --- Determine effective frame range based on display_mode ---
        if display_mode == "seconds":
            range_start = int(start_second * frame_rate)
            range_end = int(end_second * frame_rate)
        else:
            range_start = start_frame
            range_end = end_frame
        range_end = max(range_end, range_start + 1)
        duration_frames = int(range_end - range_start)

        audio_segments = tdata.get("audioSegments", None) if tdata.get("audioTrackEnabled", False) else None
        audio_segments = fill_audio_gaps(audio_segments, range_start, range_end)

        # --- Build timeline_data array for guide_data ---
        guide_timeline = []
        segment_count = 0
        timeline_segments = tdata.get("segments", [])
        timeline_data_len = len(timeline_segments)

        if timeline_data_len == 0:
            raise ValueError("[MiniMaxRefDirector] timeline_segments is required and must not be empty.")

        # 段提示词可能以中文编写（编辑器"中→"按钮生成）：下游 MiniMax 视频模型需要
        # 英文提示词，此处对含中文的段提示词调用 LLM 翻译为英文。opts 从 config 透传
        # （vlm_mode / gguf_path / mmproj_path / provider / api_key 等）；llama-server
        # 模式下翻译经外部 HTTP 服务完成，ComfyUI 进程无模型内存需要释放。
        vlm_opts = ((config or {}).get("opts") or {}) if config else {}
        vlm_opts = _resolve_vlm_opts(vlm_opts)
        for i, seg in enumerate(timeline_segments):
            dur = int(seg.get("length", 1))
            seg_start_frames = int(seg.get("start", 0))
            seg_end_frames = seg_start_frames + dur

            if seg_start_frames < range_start:
                seg_start_frames = range_start
            if seg_end_frames > range_end:
                seg_end_frames = range_end

            dur = seg_end_frames - seg_start_frames
            if dur <= 0:
                continue
            seg_audio = fill_audio_gaps(audio_segments, seg_start_frames, seg_end_frames)
            h3_prompt_json = seg.get("h3PromptJson", "")
            prev_seg = timeline_segments[i - 1] if i - 1 >= 0 else None
            next_seg = timeline_segments[i + 1] if i + 1 < timeline_data_len else None
            # 段级主体覆盖（SPA 分镜预览页按引用「自定义」）：seg.subjectsOverride
            # 为被覆盖主体（含其子主体）的副本数组；以全局 subject_data 为底，
            # 按 name 匹配替换，override 中全局没有的主体追加；缺失 / 空列表 /
            # 类型异常时回退全局（完全向后兼容，亦兼容旧"整体替换"数据）。
            seg_subject_data = subject_data
            _seg_override = seg.get("subjectsOverride")
            if isinstance(_seg_override, list) and _seg_override:
                _global_subjects = subject_data.get("subjects") if isinstance(subject_data, dict) else None
                if isinstance(_global_subjects, list):
                    _ov_by_name = {}
                    for _s in _seg_override:
                        if isinstance(_s, dict):
                            _n = str(_s.get("name") or "").strip()
                            if _n:
                                _ov_by_name[_n] = _s
                    _merged = []
                    _consumed = set()
                    for _g in _global_subjects:
                        if not isinstance(_g, dict):
                            _merged.append(_g)
                            continue
                        _gn = str(_g.get("name") or "").strip()
                        if _gn and _gn in _ov_by_name:
                            _merged.append(_ov_by_name[_gn])
                            _consumed.add(_gn)
                        else:
                            _merged.append(_g)
                    for _n, _s in _ov_by_name.items():
                        if _n not in _consumed:
                            _merged.append(_s)
                    seg_subject_data = {"subjects": _merged}
            prompt_res = build_h3_prompt(global_prompt=global_prompt, subject_data=seg_subject_data, 
                                         prompt_json=h3_prompt_json, previous_timeline_segment=prev_seg,
                                         timeline_segment=seg, next_timeline_segment=next_seg, seg_audio=seg_audio,
                                         frame_rate=frame_rate)
            # 非英文（含中文，且非仅出现在对白/主体标签中）的段提示词翻译为英文。
            if _needs_translate(prompt_res["prompt"]):
                log.info(
                    "[MiniMaxRefDirector] segment %d pre-translate prompt head: %s",
                    i, repr(prompt_res["prompt"][:160]),
                )
                prompt_res["prompt"] = _translate_prompt_to_en(prompt_res["prompt"], vlm_opts)
                log.info(
                    "[MiniMaxRefDirector] segment %d post-translate prompt head: %s",
                    i, repr(prompt_res["prompt"][:160]),
                )
            entry = {
                "prompt": prompt_res["prompt"],
                "subjects": prompt_res["subjects"],
                "images": prompt_res["images"],
                "audios": prompt_res["audios"],
                "videos": prompt_res["videos"],
                "prevImageFile": prompt_res["prevImageFile"],
                "prevType": prompt_res["prevType"],
                "durationFrames": dur,
                "startFrames": seg_start_frames,
                "type": seg.get("type", "text"),
                "imageFile": seg.get("imageFile", ""),
                "upscale": seg.get("upscale", False),
                "secondPass": seg.get("secondPass", False),
                "guideStrength": seg.get("guideStrength", 22),
                # 片段级降噪（seg.denoise = {enabled, alpha, alpha_end, ramp, seed}）；
                # Guide 在 motion context 路径开启时调用 ComfyUI-H3-Context-Noise
                "denoise": seg.get("denoise") or None,
            }
            guide_timeline.append(entry)
            segment_count += 1

        if segment_count == 0:
            raise ValueError("[MiniMaxRefDirector] No valid segments found in timeline_data.")

        # --- Resolve output resolution ---
        out_w, out_h = calc_resolution(outpu_resolution, million_pixels)

        # --- Assemble guide_data ---
        # 附带 Director 自身节点 id：Guide 节点执行时可借此把进度/素材通知关联回
        # 前端对应的 Director 节点，多 tab / 多实例时按节点精确过滤，避免串收。
        director_node_id = None
        try:
            from comfy_execution.utils import get_executing_context
            _ctx = get_executing_context()
            if _ctx is not None:
                director_node_id = getattr(_ctx, "node_id", None)
        except Exception:
            director_node_id = None
        guide_data = {
            "width": out_w,
            "height": out_h,
            "frame_rate": float(frame_rate),
            "range_start": int(range_start),
            "range_end": int(range_end),
            "global_prompt": global_prompt,
            "subject_data": subject,
            "timeline_data": guide_timeline,
            "audio_segments": audio_segments,
            "_director_node_id": director_node_id,
        }

        # --- Synthesize master audio（整轨完整音频，供下游 SaveAudio / 音频节点）---
        # 复用 Guide 同款合成（lib.song_audio._synthesize_master_audio，内容指纹缓存：
        # 同 prompt 内 Guide 再次合成时直接命中，不重复读文件/重采样）。无音轨时为空。
        master_audio = None
        if audio_segments:
            try:
                from .lib.song_audio import _synthesize_master_audio
                master_audio = _synthesize_master_audio(guide_data)
            except Exception:
                log.warning(
                    "[MiniMaxRefDirector] failed to synthesize master_audio, "
                    "outputting none", exc_info=True)
                master_audio = None

        # master_audio 落盘 + 登记 SPA「视频生成记录」（kind=master_audio；失败仅告警）。
        # 历史语义不变：master_audio 由补齐后的 audio_segments 合成，覆盖本次运行的
        # [start, end)（选择部分分镜时只含被选中段的音频窗口，空白段静音补齐）。
        if master_audio is not None:
            saved = _persist_master_audio(master_audio)
            if saved:
                try:
                    from .lib.records import build_record, append_record

                    rec = build_record(
                        "master_audio", None,
                        size=saved["size"],
                        director_node_id=str(director_node_id or ""),
                        prompt_excerpt=str(global_prompt or "")[:200],
                    )
                    rec["audio"] = saved["file_info"]
                    rec["meta"] = {
                        "duration_s": round(saved["duration_s"], 3),
                        "sample_rate": saved["sample_rate"],
                    }
                    append_record(rec)
                except Exception:
                    log.warning(
                        "[MiniMaxRefDirector] failed to record master_audio",
                        exc_info=True)

        log.info(
            f"[MiniMaxRefDirector] {segment_count} segments | timeline: {timeline_data} | "
            f"start_second: {start_second} | end_second: {end_second} | duration_seconds: {duration_seconds} | "
            f"start_frane: {start_frame} | end_frame: {end_frame} | duration_frames: {duration_frames} | "
            f"{out_w}×{out_h} ({outpu_resolution}, {million_pixels}MP) | "
            f"{len(subject)} subjects | {global_prompt} | audio_segments: {len(audio_segments)} | "
            f"master_audio: "
            f"{'ok' if master_audio is not None else 'none'}"
        )

        result = io.NodeOutput(guide_data, segment_count + 1, frame_rate, master_audio)
        return result


NODE_CLASS_MAPPINGS = {
    "MiniMaxRefDirector": MiniMaxRefDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefDirector": "MiniMax Super Director",
}
