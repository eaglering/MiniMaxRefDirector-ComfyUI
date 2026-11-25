"""llama-server 进程管理器（llama.cpp 官方 HTTP 服务端，OpenAI 兼容接口）。

替代进程内 llama-cpp-python 推理：
- 模型加载在外部 llama-server 进程（subprocess 启动，GGUF + 可选 mmproj 多模态），
  ComfyUI 主进程只做 ``POST /v1/chat/completions`` HTTP 调用，彻底避免进程内
  推理与 torch 抢占显存/RAM 导致 OOM；
- 串行策略：设置面板「启动/停止」按钮手动控制生命周期；生成链路（lib/llm）可经
  ``ensure_running()`` 按需自动拉起（不卸载 ComfyUI 显存模型），空闲
  ``_IDLE_STOP_S`` 秒后由看门狗线程自动停止，把显存还给 ComfyUI；手动启动的
  实例不参与空闲回收。手动 ``start()`` 前自动调用
  ``comfy.model_management.unload_all_models()`` 卸载 ComfyUI 已加载的显存模型
  ——这是唯一的自动串行点；
- 日志：stdout/stderr 追加写 ``user/default/MiniMaxRefDirector/llama-server.log``，
  ``tail_log()`` 供面板查看启动失败原因。

线程模型：start/stop 由 HTTP 路由（asyncio to_thread）与设置面板调用，全程持
模块锁串行化；生成调用（lib/llm.generate_prompt_with_llama）经 _LLM_INFER_LOCK
与全局 LLM 请求串行，并只在服务运行时放行。
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from typing import Any

import folder_paths

log = logging.getLogger(__name__)

# 进程状态（受 _LOCK 保护；同一时刻至多一个 llama-server）
_LOCK = threading.Lock()
_PROC: subprocess.Popen | None = None
_PORT: int = 0
_MODEL_BASENAME: str = ""
_MMPROJ_BASENAME: str = ""

# 按需启停：_AUTO_STARTED=True 表示当前实例由生成链路自动拉起，空闲看门狗
# 会在其闲置超过 _IDLE_STOP_S 后自动停止；手动启动的实例不参与回收。
IDLE_STOP_S = 300.0
_AUTO_STARTED: bool = False
_LAST_USE: float = 0.0
_WATCHDOG_STARTED: bool = False

DEFAULT_PORT = 8321
HEALTH_TIMEOUT_S = 180.0  # 大 GGUF 首次加载可能较慢


def _log_path() -> str:
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "MiniMaxRefDirector")
    except Exception:
        base = os.path.join(os.path.expanduser("~"), ".minimaxrefdirector")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "llama-server.log")


def endpoint(port: int | None = None) -> str:
    p = int(port or _PORT or DEFAULT_PORT)
    return f"http://127.0.0.1:{p}"


def _unload_comfyui_models() -> None:
    """卸载 ComfyUI 已加载的显存模型（串行运行的核心点；失败仅告警不阻断）。"""
    try:
        import comfy.model_management

        comfy.model_management.unload_all_models()
        log.info("[llama-server] 已卸载 ComfyUI 显存模型（串行运行）")
    except Exception as e:  # pragma: no cover - 独立运行/单元测试时可能不可用
        log.warning("[llama-server] 卸载 ComfyUI 模型失败（忽略继续）：%s", e)


def _health_ok(port: int, timeout: float = 2.0) -> bool:
    """llama-server /health：200=就绪，503=加载中，连接失败=未启动。"""
    try:
        req = urllib.request.Request(f"{endpoint(port)}/health", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as e:
        return False  # 503：模型加载中
    except Exception:
        return False


def _alive(proc: subprocess.Popen | None) -> bool:
    return proc is not None and proc.poll() is None


def status() -> dict:
    """当前状态：{running, pid, endpoint, model, mmproj, port}。

    running 以"进程存活且 /health 就绪"为准；进程在但健康检查未通过时附
    loading 提示（大模型首次加载可达数十秒）。
    """
    with _LOCK:
        proc, port = _PROC, _PORT
        model, mmproj = _MODEL_BASENAME, _MMPROJ_BASENAME
    return _status_of(proc, port, model, mmproj)


def _status_of(proc, port, model, mmproj) -> dict:
    """由给定进程状态构建状态字典（无锁版本）。

    供 status()（锁外）与 start()（持锁返回就绪状态）共用——threading.Lock
    不可重入，start() 持锁期间调用 status() 会永久自锁（曾因此卡死整个
    ComfyUI 事件循环），持锁路径必须走本函数。
    """
    alive = _alive(proc)
    healthy = _health_ok(port) if (alive and port) else False
    return {
        "running": bool(alive and healthy),
        "loading": bool(alive and not healthy),
        "pid": proc.pid if alive else None,
        "endpoint": endpoint(port) if alive else "",
        "model": model if alive else "",
        "mmproj": mmproj if alive else "",
        "port": port if alive else None,
    }


def tail_log(n: int = 40) -> str:
    """读取 llama-server 日志尾部（启动失败排查用）。"""
    try:
        with open(_log_path(), "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        return "".join(lines[-int(n):])
    except OSError:
        return ""


def _terminate(proc: subprocess.Popen, timeout: float = 8.0) -> None:
    """terminate → 超时 kill，尽力回收子进程。"""
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=timeout)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def resolve_model_file(path: str) -> str:
    """解析 GGUF / mmproj 文件路径。

    前端下拉只传文件名（basename，来自 models/llm 扫描），而 start() 需要
    完整路径——此处按「原样 → 工作目录 → models/llm 注册目录」顺序解析，
    传完整路径时原样返回，避免"文件明明存在却报不存在"。
    """
    p = (path or "").strip()
    if not p or os.path.isfile(p):
        return p
    name = os.path.basename(p)
    candidates: list[str] = []
    try:
        candidates.extend(folder_paths.get_folder_paths("llm"))
    except KeyError:
        pass
    for d in (*[os.path.join(folder_paths.models_dir, n) for n in ("llm", "LLM")], os.getcwd()):
        if d and d not in candidates:
            candidates.append(d)
    for d in candidates:
        cand = os.path.join(d, name)
        if os.path.isfile(cand):
            return cand
    return p  # 未解析到：返回原值，让 start() 的校验报出原路径


def start(
    path: str,
    gguf_path: str,
    mmproj_path: str = "",
    port: int = DEFAULT_PORT,
    ctx: int = 8192,
    ngl: int = 999,
    timeout_s: float = HEALTH_TIMEOUT_S,
    auto: bool = False,
    unload_comfy: bool = True,
) -> dict:
    """启动 llama-server（已在运行时先停止旧实例——换模型必须重启进程）。

    Args:
        path: llama-server 可执行文件路径（用户在设置面板手动配置）
        gguf_path: 主模型 GGUF 完整路径
        mmproj_path: 视觉投影 GGUF（可选；传图分析必需）
        port: 监听端口（默认 8321）
        ctx: 上下文长度（-c）；ngl: GPU 层数（-ngl 999 = 全部进 GPU）
        auto: True = 由生成链路自动拉起（参与空闲自动回收）；
            False = 用户手动启动（不回收）
        unload_comfy: 是否先卸载 ComfyUI 已加载的显存模型（自动拉起时传 False，
            避免工作流执行中途释放模型导致重载开销）

    Returns:
        status() 的就绪状态 dict。

    Raises:
        ValueError: 路径/模型文件不存在
        RuntimeError: 启动超时或进程立即退出（附日志尾部）
    """
    path = (path or "").strip()
    gguf_path = resolve_model_file(gguf_path)
    mmproj_path = resolve_model_file(mmproj_path)
    if not path:
        raise ValueError("缺少 llama-server 可执行文件路径：请在设置面板配置")
    if not os.path.isfile(path):
        raise ValueError(f"llama-server 可执行文件不存在：{path}")
    if not gguf_path or not os.path.isfile(gguf_path):
        raise ValueError(f"主模型 GGUF 不存在：{gguf_path or '（未选择）'}")
    if mmproj_path and not os.path.isfile(mmproj_path):
        raise ValueError(f"视觉投影 mmproj 不存在：{mmproj_path}")
    port = int(port or DEFAULT_PORT)

    with _LOCK:
        global _PROC, _PORT, _MODEL_BASENAME, _MMPROJ_BASENAME, _AUTO_STARTED
        _AUTO_STARTED = bool(auto)
        # 已在运行：换模型/换端口必须重启进程，同配置则直接复用
        if _alive(_PROC):
            same = (
                _PORT == port
                and _MODEL_BASENAME == os.path.basename(gguf_path)
                and _MMPROJ_BASENAME == os.path.basename(mmproj_path)
            )
            if same and _health_ok(port):
                log.info("[llama-server] 已在运行且模型一致，复用现有实例（pid=%s）", _PROC.pid)
                return _status_of(_PROC, _PORT, _MODEL_BASENAME, _MMPROJ_BASENAME)
            log.info("[llama-server] 重启实例（模型/端口配置变更）")
            _terminate(_PROC)
            _PROC = None

        if unload_comfy:
            _unload_comfyui_models()

        # 启动命令：llama-server -m <gguf> [--mmproj <mmproj>] --port <p> -c <ctx> -ngl <ngl>
        cmd = [
            path, "-m", gguf_path,
            "--port", str(port),
            "-c", str(ctx),
            "-ngl", str(ngl),
            "--host", "127.0.0.1",
        ]
        if mmproj_path:
            cmd += ["--mmproj", mmproj_path]

        log_path = _log_path()
        log.info("[llama-server] 启动：%s（日志：%s）", " ".join(cmd[:2]) + " ...", log_path)
        logf = open(log_path, "a", encoding="utf-8", errors="replace")
        try:
            logf.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} start (port {port}) =====\n")
            logf.flush()
            flags = 0
            if os.name == "nt":
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            _PROC = subprocess.Popen(
                cmd, stdout=logf, stderr=subprocess.STDOUT,
                creationflags=flags, cwd=os.path.dirname(path) or None,
            )
        finally:
            # 句柄交给子进程；父进程关闭自身副本避免 Windows 文件占用
            logf.close()
        _PORT = port
        _MODEL_BASENAME = os.path.basename(gguf_path)
        _MMPROJ_BASENAME = os.path.basename(mmproj_path) if mmproj_path else ""

        # /health 轮询就绪；进程提前退出立即报错
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if _PROC.poll() is not None:
                _PROC = None
                raise RuntimeError(
                    f"llama-server 启动失败（进程立即退出，退出码见日志）：\n{tail_log(30)}"
                )
            if _health_ok(port):
                log.info(
                    "[llama-server] 就绪：%s（model=%s mmproj=%s pid=%s）",
                    endpoint(port), _MODEL_BASENAME, _MMPROJ_BASENAME or "无", _PROC.pid,
                )
                return _status_of(_PROC, _PORT, _MODEL_BASENAME, _MMPROJ_BASENAME)
            time.sleep(1.0)
        # 超时：回收进程
        _terminate(_PROC)
        _PROC = None
        raise RuntimeError(
            f"llama-server 启动超时（{int(timeout_s)}s 内 /health 未就绪）：\n{tail_log(30)}"
        )


def stop() -> dict:
    """停止 llama-server 并回收进程。"""
    with _LOCK:
        global _PROC, _PORT, _MODEL_BASENAME, _MMPROJ_BASENAME
        proc = _PROC
        _PROC = None
        _PORT = 0
        _MODEL_BASENAME = ""
        _MMPROJ_BASENAME = ""
    if proc is not None and proc.poll() is None:
        log.info("[llama-server] 停止（pid=%s）", proc.pid)
        _terminate(proc)
    elif proc is None:
        # 兜底：ComfyUI 重启后句柄丢失，但旧 llama-server 进程可能仍在
        log.info("[llama-server] 无运行中的实例句柄")
    return {"running": False, "stopped": proc is not None}


def mark_activity() -> None:
    """记录一次生成调用（刷新空闲计时）。"""
    global _LAST_USE
    _LAST_USE = time.monotonic()


def _idle_watchdog() -> None:
    """空闲回收看门狗：自动拉起的实例闲置超过 IDLE_STOP_S 后自动停止。

    手动启动的实例（_AUTO_STARTED=False）不受影响；每 15s 检查一次，
    进程自行退出或被用户手动停止时自然退出循环。
    """
    global _AUTO_STARTED
    while True:
        time.sleep(15.0)
        with _LOCK:
            alive = _alive(_PROC)
            auto = _AUTO_STARTED
        if not alive:
            _AUTO_STARTED = False
            continue
        if not auto:
            continue
        idle = time.monotonic() - _LAST_USE
        if _LAST_USE <= 0.0:
            idle = 0.0  # 刚拉起还未使用，不回收
        if idle >= IDLE_STOP_S:
            with _LOCK:
                proc = _PROC
            pid = str(proc.pid) if proc is not None else ""
            log.info("[llama-server] 空闲 %ds，自动停止以释放显存（pid=%s）",
                     int(idle), pid)
            stop()
            _AUTO_STARTED = False


def _ensure_watchdog() -> None:
    global _WATCHDOG_STARTED
    if not _WATCHDOG_STARTED:
        _WATCHDOG_STARTED = True
        threading.Thread(
            target=_idle_watchdog, name="mrd-llama-idle", daemon=True
        ).start()


def ensure_running(gguf_path: str = "", mmproj_path: str = "") -> dict:
    """按需拉起 llama-server（生成链路专用；已运行/加载中则直接复用）。

    可执行文件路径与端口取 API 管理器「llama-server」页配置（api_config.json）；
    GGUF / mmproj 由调用方传入（SPA 的 LLM 设置），走 resolve_model_file 解析。
    自动拉起的实例 unload_comfy=False（不卸载 ComfyUI 显存模型）并参与空闲
    自动回收（IDLE_STOP_S 秒无请求后自动停止）。

    Returns:
        status() 形态的状态 dict（running=True 表示可用）。

    Raises:
        ValueError/RuntimeError: 未配置路径 / 模型缺失 / 启动失败（附日志尾部）。
    """
    global _LAST_USE
    st = status()
    if st.get("running"):
        mark_activity()
        _ensure_watchdog()
        return st
    if st.get("loading"):
        # 已在加载中：等待就绪，避免 start() 误判"模型变更"而重启
        deadline = time.monotonic() + HEALTH_TIMEOUT_S
        while time.monotonic() < deadline:
            st = status()
            if st.get("running"):
                mark_activity()
                _ensure_watchdog()
                return st
            if not st.get("loading"):
                break
            time.sleep(1.0)
        raise RuntimeError(
            "llama-server 正在加载模型，稍后重试；或直接访问 "
            + str(st.get("endpoint") or "")
        )

    cfg_ls = {}
    try:
        from ..api_config import api_config_manager

        cfg_ls = dict(api_config_manager.load_config().get("llama_server") or {})
    except Exception:
        pass
    path = str(cfg_ls.get("path") or "").strip()
    if not path:
        raise ValueError(
            "未配置 llama-server 可执行文件路径：请在 ComfyUI 设置 → "
            "MiniMaxRefDirector → API 管理器（llama-server 页）填写，"
            "或在 SPA「LLM 设置」手动启动"
        )
    _LAST_USE = time.monotonic()
    st = start(
        path,
        gguf_path,
        mmproj_path,
        int(cfg_ls.get("port") or 0) or DEFAULT_PORT,
        auto=True,
        unload_comfy=False,
    )
    _ensure_watchdog()
    return st
