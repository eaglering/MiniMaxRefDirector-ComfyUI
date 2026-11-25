"""llama-server 进程管理器（llama.cpp 官方 HTTP 服务端，OpenAI 兼容接口）。

替代进程内 llama-cpp-python 推理：
- 模型加载在外部 llama-server 进程（subprocess 启动，GGUF + 可选 mmproj 多模态），
  ComfyUI 主进程只做 ``POST /v1/chat/completions`` HTTP 调用，彻底避免进程内
  推理与 torch 抢占显存/RAM 导致 OOM；
- 串行策略（用户选定「手动启停」）：设置面板「启动/停止」按钮控制生命周期，
  不做空闲自动回收；``start()`` 前自动调用
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
) -> dict:
    """启动 llama-server（已在运行时先停止旧实例——换模型必须重启进程）。

    Args:
        path: llama-server 可执行文件路径（用户在设置面板手动配置）
        gguf_path: 主模型 GGUF 完整路径
        mmproj_path: 视觉投影 GGUF（可选；传图分析必需）
        port: 监听端口（默认 8321）
        ctx: 上下文长度（-c）；ngl: GPU 层数（-ngl 999 = 全部进 GPU）

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
        global _PROC, _PORT, _MODEL_BASENAME, _MMPROJ_BASENAME
        # 已在运行：换模型/换端口必须重启进程，同配置则直接复用
        if _alive(_PROC):
            same = (
                _PORT == port
                and _MODEL_BASENAME == os.path.basename(gguf_path)
                and _MMPROJ_BASENAME == os.path.basename(mmproj_path)
            )
            if same and _health_ok(port):
                log.info("[llama-server] 已在运行且模型一致，复用现有实例（pid=%s）", _PROC.pid)
                return status()
            log.info("[llama-server] 重启实例（模型/端口配置变更）")
            _terminate(_PROC)
            _PROC = None

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
                return status()
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
