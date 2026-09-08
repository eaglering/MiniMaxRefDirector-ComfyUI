"""插件 / LoRA 依赖管理(后端逻辑,路由宿主在 server.py)。

本模块只提供同步工作函数,由 server handler 通过 ``asyncio.to_thread``
调用,避免 git clone / git pull / ModelScope 下载等阻塞操作冻结
aiohttp 事件循环。

能力清单:
- 本地插件扫描:枚举 ``custom_nodes`` 目录 + 从 ``sys.modules`` 里收集
  每个插件注册的 ``NODE_CLASS_MAPPINGS``,得到 class -> 插件目录倒排;
- 缺失插件仓库候选:惰性读取 ComfyUI-Manager 的 ``custom-node-list.json``
  (根 db + ``node_db/{dev,new,forked,legacy}``),按 node class 名与
  条目 title/id 的归一化文本做包含匹配,返回候选 git URL;
- git 安装 / 更新:``git clone --depth 1`` 到 custom_nodes /
  ``git -C <dir> pull``(带超时与输出截断,失败安全报错);
- LoRA:本地 ``loras`` 目录文件目录(相对路径);缺失项经 ModelScope 下载
  —— 按 ``owner/name``(或模型页 URL)列举 repo 文件、选定文件后走
  ``resolve`` 直链流式下载到 ``models/loras``。

ModelScope 接口(已实测核实):
- 文件列举:GET https://modelscope.cn/api/v1/models/{owner}/{name}/repo/files
  ?Recursive=true&Revision=master → ``Data.Files[].{Name,Path,Size,Type}``
- 下载直链:GET https://modelscope.cn/models/{owner}/{name}/resolve/{rev}/{path}
  (底层 302 到 OSS,HTTP 客户端跟随重定向即可)
说明:ModelScope 的全局模型搜索接口(``/api/v1/dolphin/models`` 等 POST 形态)
经现网实测(2026-09)已全部下线/404 且无公开替代,故 ``ms_search`` 采取
「候选端点顺序尝试 + Bing ``site:modelscope.cn/models`` 兜底提取仓库 URL +
失败降级(degraded)」的多路策略;前端在接口不可用时引导打开 ModelScope
官方搜索页并粘贴模型链接 / ID(走文件列举与下载,功能不受影响)。
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.parse
import urllib.request

log = logging.getLogger("minimax_ref.ext_mgmt")

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
CUSTOM_NODES_DIR = os.path.dirname(_THIS_DIR)
if os.path.basename(CUSTOM_NODES_DIR) != "custom_nodes":
    # 兼容非标准安装布局(仍以 ComfyUI 根/custom_nodes 为锚)
    _anchor = os.path.join(os.path.dirname(CUSTOM_NODES_DIR), "custom_nodes")
    if os.path.isdir(_anchor):
        CUSTOM_NODES_DIR = _anchor

_CM_DIR = os.path.join(CUSTOM_NODES_DIR, "ComfyUI-Manager")
_CM_DB_REL = (
    "custom-node-list.json",
    os.path.join("node_db", "dev", "custom-node-list.json"),
    os.path.join("node_db", "new", "custom-node-list.json"),
    os.path.join("node_db", "legacy", "custom-node-list.json"),
    os.path.join("node_db", "forked", "custom-node-list.json"),
)
_CM_DB_LOCK = threading.Lock()
_CM_DB_CACHE: list[dict] | None = None

_GIT_TIMEOUT = 120  # clone/pull 上限秒
_HTTP_TIMEOUT = 30
_UA = "MiniMaxRefDirector-ExtMgmt/3.1.9"
# 网页兜底搜索用浏览器 UA(部分站点拒绝通用爬虫 UA)
_UA_BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
               "AppleWebKit/537.36 (KHTML, like Gecko) "
               "Chrome/124.0.0.0 Safari/537.36")

# 已执行过「安装/更新」等待重启的标记(进程内)
_pending_restart = {"flag": False}


def loras_dir() -> str:
    """LoRA 目标目录(models/loras,首选已注册路径第一项)。"""
    try:
        import folder_paths
        for d in folder_paths.get_folder_paths("loras"):
            if os.path.isdir(d):
                return d
        return os.path.join(folder_paths.models_dir, "loras")
    except Exception:
        return os.path.join(os.path.dirname(CUSTOM_NODES_DIR), "models", "loras")


# ---------------------------------------------------------------------------
# 本地插件扫描
# ---------------------------------------------------------------------------


def module_class_index() -> dict[str, list[str]]:
    """folder -> [node class,...]:遍历 sys.modules 收集已注册的插件 class。

    依赖 ComfyUI 启动时各 custom node 包的 ``NODE_CLASS_MAPPINGS`` 已注入
    sys.modules(ComfyUI 在加载阶段执行)。只统计 ``__file__`` 位于
    custom_nodes/<folder>/ 下的模块,不 import 任何第三方包。
    """
    index: dict[str, list[str]] = {}
    cn = os.path.abspath(CUSTOM_NODES_DIR)
    for mod in list(sys.modules.values()):
        try:
            path = getattr(mod, "__file__", None)
        except Exception:
            continue
        if not path:
            continue
        path = os.path.abspath(path)
        if not path.startswith(cn + os.sep):
            continue
        # 取 custom_nodes 下第一级目录作为插件目录：模块可能位于
        # 插件深层子目录(py/ nodes/ modules/…),dirname 的 basename 会错判,
        # 一律以相对路径的首段为准；直接位于根目录的文件不算插件目录。
        _rel = os.path.relpath(path, cn)
        if os.sep not in _rel:
            continue
        folder = _rel.split(os.sep, 1)[0]
        mappings = getattr(mod, "NODE_CLASS_MAPPINGS", None)
        if isinstance(mappings, dict):
            classes = index.setdefault(folder, [])
            for c in mappings:
                if c not in classes:
                    classes.append(c)
    return index


# --------------------------------------------------------------------------
# 文本证据归属：class 名在插件源码里的字面量命中
# --------------------------------------------------------------------------
# 模块反查(sys.modules / __module__ 落点)依赖加载顺序与 sys.modules 状态,
# 曾出现 MiniMaxRefGuide、Power Lora Loader (rgthree) 被误算进
# ComfyUI-Easy-Use —— 而 Easy-Use 源码里根本没有这些名字。
# 规则：注册节点 key / 类名必然出现在其插件源码(映射表/类定义)中,因此直接
# 拿 class 名去各插件目录 .py 源码里按文本查找归属,命中行带注册/定义
# 上下文(NODE_CLASS_MAPPINGS / NODE_NAME / get_name 等)时加权。
_PY_SUFFIX = ".py"
# 说明性文件不参与源码证据打分：自身模块注释会「提及」别家 key 造成污染
_TEXT_EXCLUDE_FILES = {"ext_mgmt.py", "server.py"}
_REG_KEY_LINE = re.compile(
    r"NODE_CLASS_MAPPINGS|NODE_DISPLAY_NAME_MAPPINGS|CLASS_MAPPINGS|"
    r"NODE_NAME|get_name\(|register_node|DisplayName|display_name|"
    r"^\s*class\s", re.I)

# 源码文本索引缓存: {key: 各目录 mtime 签名, data: {folder: 全部 .py 拼接文本}}
_scan_text_cache: dict = {}


def _strip_trailing_tag(name: str) -> str:
    """去掉常见 "(xxx)" 尾部标记得到基名: 'Power Lora Loader (rgthree)' →
    'Power Lora Loader'(该写法插件用 get_name() 拼接注册 key,源码无全名)。"""
    m = re.match(r"^(.+?)\s*\([^()]*\)$", name)
    return m.group(1) if m else name


def _text_index() -> dict:
    """custom_nodes 下各插件目录全部 .py 源码拼接文本(mtime 签名变化时重建)。"""
    sig: list = []
    try:
        entries = sorted(os.listdir(CUSTOM_NODES_DIR))
    except OSError:
        return {}
    for name in entries:
        p = os.path.join(CUSTOM_NODES_DIR, name)
        if not os.path.isdir(p) or name.startswith("."):
            continue
        if name.endswith((".disabled", ".backup", ".bak")):
            continue
        try:
            sig.append((name, os.path.getmtime(p)))
        except OSError:
            continue
    key = tuple(sig)
    if _scan_text_cache.get("key") == key:
        return _scan_text_cache.get("data", {})
    index: dict[str, str] = {}
    for name, _ in sig:
        parts: list[str] = []
        root = os.path.join(CUSTOM_NODES_DIR, name)
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames
                           if not d.startswith(".") and d != "__pycache__"]
            for fn in filenames:
                if not fn.endswith(_PY_SUFFIX):
                    continue
                if fn in _TEXT_EXCLUDE_FILES:
                    continue
                try:
                    with open(os.path.join(dirpath, fn), "r",
                              encoding="utf-8", errors="ignore") as fh:
                        parts.append(fh.read())
                except OSError:
                    continue
        if parts:
            index[name] = "\n".join(parts)
    _scan_text_cache["key"] = key
    _scan_text_cache["data"] = index
    return index


def _text_scores(names: list[str]) -> dict:
    """{class -> {插件目录: 加权命中分}}。

    全部 class 名(含基名)编译成单一正则,对每个插件目录文本扫描一次:
    命中行含注册/定义上下文 ×8,普通命中 ×1;同目录同名封顶防通用名拖慢。
    """
    names = [n for n in names if isinstance(n, str) and n]
    if not names:
        return {}
    idx = _text_index()
    if not idx:
        return {}
    alias: dict[str, str] = {}
    for n in names:
        alias[n] = n
        base = _strip_trailing_tag(n)
        if base and base != n and len(base) >= 3 and base not in alias:
            alias[base] = n
    # 分支按长度降序: 完整名含尾部标记时优先整体匹配
    union = re.compile(
        "|".join(re.escape(p) for p in sorted(alias, key=len, reverse=True)))
    out: dict = {n: {} for n in names}
    for folder, text in idx.items():
        if not text:
            continue
        per: dict[str, int] = {}
        for m in union.finditer(text):
            c = alias.get(m.group(0))
            if c is None:
                continue
            s = per.get(c, 0)
            if s >= 999:
                continue
            ln0 = text.rfind("\n", 0, m.start()) + 1
            ln1 = text.find("\n", m.end())
            if ln1 == -1:
                ln1 = len(text)
            line = text[ln0:ln1].lstrip()
            # 注释/docstring 行只是"提及"该名字,不是注册证据,一律普通分
            if line.startswith(("#", '"""', "'''")):
                per[c] = s + 1
            else:
                per[c] = s + (8 if _REG_KEY_LINE.search(line) else 1)
        for c, s in per.items():
            out.setdefault(c, {})[folder] = s
    return out


def text_ownership(names: list[str]) -> dict:
    """class -> 插件目录: 源码文本命中唯一最高分者;打平或无命中不出现在结果。"""
    out: dict[str, str] = {}
    for c, fs in _text_scores(names).items():
        if not fs:
            continue
        top = max(fs.values())
        winners = [f for f, s in fs.items() if s == top]
        if len(winners) == 1:
            out[c] = winners[0]
    return out


# 纯前端 UI 节点(ComfyUI 画布内置,无后端 class,不存在"缺失插件"一说)。
_FRONTEND_UI_CLASSES = {
    "Note", "MarkdownNote", "Reroute", "PrimitiveNode", "Bookmark",
    "Webcam", "StringPrimitive", "ImagePrimitive", "LatentPrimitive",
    "SeedPrimitive", "FloatPrimitive", "IntPrimitive",
}


def class_ownership() -> tuple[dict[str, str], set[str]]:
    """class -> 插件目录 与 内置 class 集合(提高已装插件识别率)。

    ComfyUI 会把全部已加载节点(内置 + 自定义)合并进 ``nodes.NODE_CLASS_MAPPINGS``
    (import 时懒加载,进程内已有缓存)。据此按 class 的定义模块 ``__module__``
    反查 ``sys.modules`` 中 ``__file__`` 落点:

    - ``custom_nodes/<folder>/`` 下 → 归属该插件目录(class 定义在子模块的插件
      也能被识别,弥补 module_class_index 只统计模块级 NODE_CLASS_MAPPINGS 的盲区);
    - custom_nodes 之外(nodes.py / comfy_extras 等) → 内置节点集合,与缺失无关。

    任何异常均静默降级为 module_class_index() 的结果,保证旧版可用。
    """
    class_folder: dict[str, str] = {}
    for folder, cs in module_class_index().items():
        for c in cs:
            class_folder.setdefault(c, folder)
    builtin: set[str] = set()
    try:
        import nodes  # ComfyUI 启动阶段已加载,命中 sys.modules 缓存,无副作用
    except Exception:
        return class_folder, builtin
    try:
        mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", None)
        if not isinstance(mappings, dict):
            return class_folder, builtin
        cn = os.path.abspath(CUSTOM_NODES_DIR)
        for cname, obj in mappings.items():
            if not isinstance(cname, str) or not cname:
                continue
            mod_name = getattr(obj, "__module__", None)
            mod = sys.modules.get(mod_name) if mod_name else None
            try:
                fpath = os.path.abspath(mod.__file__) if mod \
                    and getattr(mod, "__file__", None) else ""
            except Exception:
                fpath = ""
            if fpath.startswith(cn + os.sep):
                # 类定义在 custom_nodes 深层子模块时,以相对路径首段(=插件目录)归属;
                # 与 module_class_index 的判定保持一致,避免 setdefault 抢占错名。
                _rel = os.path.relpath(fpath, cn)
                class_folder.setdefault(cname, _rel.split(os.sep, 1)[0])
            elif fpath:
                # 定义在 ComfyUI 本体(nodes.py / comfy_extras/...) → 内置
                builtin.add(cname)
    except Exception:
        pass
    # ---- 文本证据归属(最可靠): 拿 class 名去插件源码里查 ----
    # 注册 key/类名必然出现在其插件源码的映射表或类定义中;而模块反查依赖
    # sys.modules/__module__ 落点,加载顺序或同 key 抢占会误判(历史:
    # MiniMaxRefGuide、Power Lora Loader (rgthree) 都被算进
    # ComfyUI-Easy-Use,而 Easy-Use 源码里根本没有这些名字)。
    text_map = text_ownership(list(class_folder.keys()))
    for c, folder in text_map.items():
        class_folder[c] = folder  # 覆盖模块反查结果
    # ---- 本项目注册表强制归属 ----
    # 归属以本项目 __init__.py 声明的 NODE_CLASS_MAPPINGS 为准：即使外部
    # 模块反查 / sys.modules 遍历把同名 key 归到别的插件（历史上出现过
    # MiniMaxRefGuide 被误算进 ComfyUI-Easy-Use），也强制算回本项目目录。
    self_folder = os.path.basename(_THIS_DIR)  # MiniMaxRefDirector-ComfyUI
    init_file = os.path.join(_THIS_DIR, "__init__.py")
    for _m in list(sys.modules.values()):
        try:
            if os.path.abspath(getattr(_m, "__file__", "") or "") != init_file:
                continue
        except Exception:
            continue
        _mappings = getattr(_m, "NODE_CLASS_MAPPINGS", None)
        if isinstance(_mappings, dict):
            for _c in _mappings:
                if isinstance(_c, str) and _c:
                    class_folder[_c] = self_folder  # 覆盖误判
        break
    return class_folder, builtin


def debug_class_origin(cname: str) -> dict:
    """dump 单个 class 的归属判定全过程（面板「扫描诊断」详情 / 排障用）。

    - exporters:sys.modules 中哪些模块的 NODE_CLASS_MAPPINGS 导出了该 key
      （模块名 + __file__，用于发现同名 key 被谁抢占）；
    - mapped:nodes.NODE_CLASS_MAPPINGS 里该 key 类的 __module__ 与模块文件
      是否落在 custom_nodes 下；
    - class_folder_now / builtin_now:强制归属修正后的最终判定。
    """
    cn = os.path.abspath(CUSTOM_NODES_DIR)
    res: dict = {"class": cname}
    exporters: list[dict] = []
    for mod_name, mod in list(sys.modules.items()):
        try:
            mappings = getattr(mod, "NODE_CLASS_MAPPINGS", None)
        except Exception:
            continue
        if isinstance(mappings, dict) and cname in mappings:
            try:
                fpath = os.path.abspath(getattr(mod, "__file__", "") or "")
            except Exception:
                fpath = ""
            exporters.append({"module": mod_name, "file": fpath})
    res["exporters"] = exporters
    try:
        import nodes  # 已加载,命中缓存无副作用
        obj = nodes.NODE_CLASS_MAPPINGS.get(cname)
        if obj is not None:
            mn = getattr(obj, "__module__", None)
            mf = ""
            if mn:
                m = sys.modules.get(mn)
                if m is not None:
                    try:
                        mf = os.path.abspath(getattr(m, "__file__", "") or "")
                    except Exception:
                        pass
            res["mapped"] = {
                "module": mn,
                "module_file": mf,
                "under_custom_nodes": bool(mf) and mf.startswith(cn + os.sep),
            }
        else:
            res["mapped"] = None
    except Exception as e:
        res["mapped_error"] = str(e)
    # 文本证据(加权命中明细,归属排障直接看这里)
    scores = _text_scores([cname])
    res["text_scores"] = scores.get(cname, {})
    res["text_ownership"] = text_ownership([cname]).get(cname)
    cf, bi = class_ownership()
    res["class_folder_now"] = cf.get(cname)
    res["builtin_now"] = cname in bi
    return res


def installed_dirs() -> list[str]:
    """custom_nodes 下已存在的插件目录名(排除文件/.disabled/点目录)。"""
    out: list[str] = []
    try:
        for name in sorted(os.listdir(CUSTOM_NODES_DIR)):
            p = os.path.join(CUSTOM_NODES_DIR, name)
            if os.path.isdir(p) and not name.startswith(".") \
                    and not name.endswith(".disabled"):
                out.append(name)
    except OSError:
        pass
    return out


def is_git_repo(folder: str) -> bool:
    return os.path.isdir(os.path.join(CUSTOM_NODES_DIR, folder, ".git"))


def git_repo_url(folder: str) -> str | None:
    """读取 remote origin URL(只读 config,不触发网络)。"""
    cfg = os.path.join(CUSTOM_NODES_DIR, folder, ".git", "config")
    try:
        with open(cfg, "r", encoding="utf-8", errors="ignore") as f:
            text = f.read()
        m = re.search(r'\[remote\s+"origin"\]\s*\n(?:.*\n)*?\s*url\s*=\s*(\S+)', text)
        if m:
            return m.group(1).strip()
    except OSError:
        pass
    return None


def _run_git(args: list[str], cwd: str | None = None) -> tuple[int, str]:
    """执行 git,返回 (returncode, 截断后的合并输出)。"""
    git = shutil.which("git")
    if not git:
        raise RuntimeError("未找到 git 可执行文件,请先安装 Git 并加入 PATH")
    try:
        proc = subprocess.run(
            [git] + args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"git {' '.join(args[:2])} 超时(>{_GIT_TIMEOUT}s),请稍后重试")
    text = (proc.stdout or "") + "\n" + (proc.stderr or "")
    text = text.strip()
    if len(text) > 2000:
        text = text[:2000] + f"\n…(输出截断,共 {len(text)} 字符)"
    return proc.returncode, text


# ---------------------------------------------------------------------------
# ComfyUI-Manager db(仓库 URL 搜索源)
# ---------------------------------------------------------------------------


def _load_cm_db() -> list[dict]:
    """惰性读取并缓存 CM 的 custom-node-list.json(进程内一次)。"""
    global _CM_DB_CACHE
    if _CM_DB_CACHE is not None:
        return _CM_DB_CACHE
    with _CM_DB_LOCK:
        if _CM_DB_CACHE is not None:
            return _CM_DB_CACHE
        entries: list[dict] = []
        seen: set[str] = set()
        for rel in _CM_DB_REL:
            p = os.path.join(_CM_DIR, rel)
            try:
                with open(p, "r", encoding="utf-8", errors="ignore") as f:
                    data = json.load(f)
            except (OSError, json.JSONDecodeError):
                continue
            for item in data.get("custom_nodes") or []:
                if not isinstance(item, dict):
                    continue
                key = str(item.get("reference") or item.get("title") or "")
                if not key or key in seen:
                    continue
                seen.add(key)
                entries.append(item)
        _CM_DB_CACHE = entries
        log.info("cm db loaded: %d entries", len(entries))
        return _CM_DB_CACHE


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def _entry_repo(entry: dict) -> str:
    ref = entry.get("reference") or ""
    if ref:
        return str(ref)
    files = entry.get("files") or []
    for f in files:
        s = str(f)
        if s.startswith(("http://", "https://")) and "github.com" in s:
            return s
    return ""


# 已知 H3 生态:node class 直命中其仓库目录名,免模糊匹配噪音。
# (LBH-123-AI 的 latent upscaler 是 H3 工作流配套,示例 workflow 会引用)
_H3_ALIAS = {
    "MiniMaxH3MotionContext": "ComfyUI-H3-Motion-Context-MultiRef",
    "MiniMaxH3MotionContextLoadLatent": "ComfyUI-H3-Motion-Context-MultiRef",
    "MiniMaxH3MotionContextSaveLatent": "ComfyUI-H3-Motion-Context-MultiRef",
    "MiniMaxH3ContextTaperNoise": "ComfyUI-H3-Context-Noise",
    "MiniMaxH3ContextLatentTaperNoise": "ComfyUI-H3-Context-Noise",
    "MMH3TemporalSplitParamsV10": "Comfyui_Minimax_h3_latent_Upscaler",
    "MMH3SplitUpscale": "Comfyui_Minimax_h3_latent_Upscaler",
}

# 配套仓库兜底:即使 ComfyUI-Manager db 未收录,缺失的 class 也能给出 git 地址一键安装。
_KNOWN_REPOS: dict[str, dict] = {
    "ComfyUI-H3-Motion-Context-MultiRef": {
        "title": "ComfyUI-H3-Motion-Context-MultiRef",
        "author": "seitanism",
        "reference": "https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef",
    },
    "ComfyUI-H3-Context-Noise": {
        "title": "ComfyUI-H3-Context-Noise",
        "author": "seitanism",
        "reference": "https://github.com/seitanism/ComfyUI-H3-Context-Noise",
    },
    "Comfyui_Minimax_h3_latent_Upscaler": {
        "title": "Comfyui_Minimax_h3_latent_Upscaler（LBH-123-AI）",
        "author": "LBH-123-AI",
        "reference": "https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler",
    },
}


def repo_candidates_for_class(node_class: str, limit: int = 3) -> list[dict]:
    """按 class 名在 CM db 中找候选仓库(优先已知别名直命中,再归一化模糊)。"""
    if not node_class:
        return []
    q = _norm(node_class)
    alias_folder = _H3_ALIAS.get(node_class)
    alias_norm = _norm(alias_folder) if alias_folder else ""
    scored: list[tuple[int, dict, str]] = []
    for entry in _load_cm_db():
        repo = _entry_repo(entry)
        if not repo:
            continue
        title = _norm(entry.get("title") or "")
        eid = _norm(entry.get("id") or "")
        ref = _norm(os.path.basename(repo.rstrip("/")))
        # 别名命中:repo 名 == 别名 → 直接返回该条
        if alias_norm and ref == alias_norm:
            return [{
                "title": str(entry.get("title") or ""),
                "author": str(entry.get("author") or ""),
                "reference": repo,
            }]
        if not (title or eid or ref):
            continue
        # 模糊匹配:class 名常含插件品牌前缀(如 MiniMaxH3MotionContext),
        # 仓库名/标题双向包含;要求共同子串 >=4 避免 'context'→'TEX' 这类噪声。
        score = 0
        for token in (title, eid, ref):
            if not token:
                continue
            if q in token:
                score += max(2, min(len(q), len(token)) // 3)
            elif token in q and len(token) >= 4:
                score += max(2, len(token) // 2)
        if score > 0:
            scored.append((score, entry, repo))
    # db 未收录但属于本项目已知配套仓库 → 用内置 repo 兜底(保证可一键安装)。
    if alias_folder and alias_folder in _KNOWN_REPOS:
        return [_KNOWN_REPOS[alias_folder]]
    scored.sort(key=lambda x: -x[0])
    return [
        {
            "title": str(e.get("title") or ""),
            "author": str(e.get("author") or ""),
            "reference": repo,
        }
        for _, e, repo in scored[:limit]
    ]


def repo_candidates_for_folder(folder: str, limit: int = 2) -> list[dict]:
    """按已装目录名在 CM db 中找其上游仓库 URL(用于展示「更新」来源)。"""
    q = _norm(folder)
    out: list[dict] = []
    for entry in _load_cm_db():
        repo = _entry_repo(entry)
        if not repo:
            continue
        ref = _norm(os.path.basename(repo.rstrip("/")))
        title = _norm(entry.get("title") or "")
        if q and (q in ref or ref in q or q in title or title in q):
            out.append({
                "title": str(entry.get("title") or ""),
                "author": str(entry.get("author") or ""),
                "reference": repo,
            })
            if len(out) >= limit:
                break
    return out


# ---------------------------------------------------------------------------
# 模型目录清单(按类型)
# ---------------------------------------------------------------------------

# ComfyUI folder_paths 注册的模型类型(与前端分组、下载目标一一对应)
MODEL_TYPES: tuple[str, ...] = (
    "loras", "checkpoints", "diffusion_models", "unet", "vae",
)


def models_root_dir() -> str:
    """ComfyUI ``models`` 根目录(folder_paths.models_dir)。"""
    try:
        import folder_paths
        return folder_paths.models_dir
    except Exception:
        return os.path.join(os.path.dirname(CUSTOM_NODES_DIR), "models")


def models_dir_for(model_type: str = "loras") -> str:
    """某模型类型根目录(models/<type>,首选已注册路径第一项)。

    model_type 仅接受 MODEL_TYPES 内的 key;非法/空值回退 ``loras``。
    """
    mt = (model_type or "loras").strip().lower()
    if mt not in MODEL_TYPES:
        mt = "loras"
    try:
        import folder_paths
        for d in folder_paths.get_folder_paths(mt):
            if os.path.isdir(d):
                return d
        return os.path.join(folder_paths.models_dir, mt)
    except Exception:
        return os.path.join(os.path.dirname(CUSTOM_NODES_DIR), "models", mt)


def model_catalog(model_type: str = "loras") -> list[dict]:
    """某模型类型目录下所有模型文件(递归,相对路径)。"""
    mt = (model_type or "loras").strip().lower()
    if mt not in MODEL_TYPES:
        mt = "loras"
    out: list[dict] = []
    seen: set[str] = set()
    roots = [models_dir_for(mt)]
    try:
        import folder_paths
        roots = list(folder_paths.get_folder_paths(mt)) or roots
    except Exception:
        pass
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in sorted(filenames):
                ext = os.path.splitext(fn)[1].lower()
                if ext not in (".safetensors", ".ckpt", ".pt", ".pth"):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, fn), root)
                rel = rel.replace("\\", "/")
                if rel in seen:
                    continue
                seen.add(rel)
                try:
                    size = os.path.getsize(os.path.join(dirpath, fn))
                except OSError:
                    size = 0
                out.append({"name": rel, "size": size})
    return out


def lora_catalog() -> list[dict]:
    """兼容封装:loras 目录下所有模型文件。"""
    return model_catalog("loras")


def lora_exists(name: str) -> bool:
    base = os.path.basename(name.replace("\\", "/"))
    for item in model_catalog("loras"):
        if item["name"] == name or os.path.basename(item["name"]) == base:
            return True
    return False


# ---------------------------------------------------------------------------
# git 安装 / 更新
# ---------------------------------------------------------------------------


def _repo_folder_name(url: str) -> str:
    name = url.rstrip("/").rsplit("/", 1)[-1]
    if name.endswith(".git"):
        name = name[:-4]
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", name)
    if not name:
        raise ValueError(f"无法从仓库 URL 解析目录名: {url}")
    return name


_SETUP_TIMEOUT = 900  # 依赖安装 / install.bat 上限秒
_SETUP_TEXT_MAX = 1500  # 单步安装输出保留字符数

_python_exe: str | None = None  # find_python 结果缓存


def find_python() -> str:
    """定位用于安装 Python 依赖的解释器路径(带进程内缓存)。

    查找顺序：
    1. 当前进程 ``sys.executable``——本插件运行在 ComfyUI 的 Python 进程内
       (portable: ``ComfyUI_windows_portable\\python_embeded\\python.exe``；
       venv / 系统 Python 同理)，用它安装依赖与 ComfyUI 运行环境完全一致；
    2. 沿 ``custom_nodes`` 向上探测 ``python_embeded\\python.exe``(portable 布局)；
    3. PATH 中的 ``python`` / ``python3``；
    全部落空时抛 ``RuntimeError`` 提示手动执行。
    """
    global _python_exe
    if _python_exe:
        return _python_exe
    cand = ""
    exe = (sys.executable or "").strip()
    if exe and os.path.basename(exe).lower().startswith("python"):
        cand = exe
    if not cand:
        # ComfyUI_windows_portable/python_embeded/python.exe 位于 custom_nodes
        # 上两级目录;从 custom_nodes 起向上探测最多 3 层
        start = os.path.abspath(CUSTOM_NODES_DIR)
        for _ in range(3):
            probe = os.path.join(start, "python_embeded", "python.exe")
            if os.path.isfile(probe):
                cand = probe
                break
            parent = os.path.dirname(start)
            if parent == start:
                break
            start = parent
    if not cand:
        for name in ("python", "python3"):
            w = shutil.which(name)
            if w:
                cand = w
                break
    if not cand or not os.path.isfile(cand):
        raise RuntimeError(
            "未找到 python.exe，请手动在插件目录执行 "
            "pip install -r requirements.txt")
    _python_exe = cand
    return cand


def _clip(text: str, limit: int = _SETUP_TEXT_MAX) -> str:
    text = (text or "").strip().replace("\r\n", "\n")
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…(截断,共 {len(text)} 字符)"


def _run_cmd(args: list[str], cwd: str,
             timeout: int = _SETUP_TIMEOUT) -> tuple[int, str]:
    """执行依赖安装命令,返回 (rc, 截断文本)。

    stdin 置空(DEVNULL)以避免 install.bat 里的 ``pause`` 等待按键而挂起。
    """
    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        proc = subprocess.run(
            args, cwd=cwd, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace", env=env,
        )
    except subprocess.TimeoutExpired:
        return -1, f"执行超时(>{timeout}s),已中止"
    text = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
    return proc.returncode, text


def _auto_setup_deps(dest: str) -> list[str]:
    """仓库根存在 requirements.txt / install.bat 时自动执行,返回中文描述行。

    依赖安装失败不向上抛(插件代码已更新,不应让整次更新报错),仅记入描述与日志。
    """
    notes: list[str] = []
    req = os.path.join(dest, "requirements.txt")
    if os.path.isfile(req):
        try:
            py = find_python()
        except RuntimeError as e:
            notes.append(str(e))
        else:
            log.info("ext update: pip install -r %s (py=%s)", req, py)
            rc, text = _run_cmd([py, "-m", "pip", "install", "-r", req],
                                cwd=dest)
            if rc == 0:
                tail = " ".join((text or "").splitlines()[-2:]).strip()
                notes.append("已自动安装依赖 requirements.txt"
                             + (f"：{_clip(tail, 220)}" if tail else ""))
            else:
                notes.append("requirements.txt 安装失败："
                             + (_clip(text, 300) or "pip 无输出"))
                log.warning("ext update: pip install failed: %s", text[:500])
    bat = os.path.join(dest, "install.bat")
    if os.path.isfile(bat):
        log.info("ext update: run install.bat in %s", dest)
        comspec = os.environ.get("COMSPEC") or "cmd.exe"
        rc, text = _run_cmd([comspec, "/c", "install.bat"], cwd=dest)
        if rc == 0:
            notes.append("已自动执行 install.bat")
        else:
            notes.append(f"install.bat 执行失败(exit {rc})："
                         + (_clip(text, 300) or "无输出"))
            log.warning("ext update: install.bat failed: %s", text[:500])
    return notes


def install_plugin(url: str) -> dict:
    """git clone 到 custom_nodes/<repo名>。失败安全;成功标记待重启。"""
    if not url or not url.startswith(("http://", "https://", "git@", "ssh://")):
        raise ValueError("需要 git 仓库 URL(http/https/ssh)")
    folder = _repo_folder_name(url)
    dest = os.path.join(CUSTOM_NODES_DIR, folder)
    if os.path.exists(dest):
        raise RuntimeError(
            f"目录 {folder} 已存在,请先更新而不是重复安装")
    os.makedirs(CUSTOM_NODES_DIR, exist_ok=True)
    code, text = _run_git(["clone", "--depth", "1", url, dest])
    if code != 0 or not os.path.isdir(dest):
        # 清理可能产生的半成品
        shutil.rmtree(dest, ignore_errors=True)
        raise RuntimeError(f"git clone 失败:\n{text or '(无输出)'}")
    _pending_restart["flag"] = True
    return {"folder": folder, "output": text or "cloned"}


def update_plugin(folder: str) -> dict:
    """git -C <folder> pull；仅当确实拉到新代码时,自动执行仓库根
    requirements.txt / install.bat,并置待重启标记。

    返回 {"folder", "changed", "auto", "output"}：
    - changed=False → 已是最新,无需任何后续处理;
    - changed=True  → 已拉取新代码(自动安装失败不会使整体报错,结果在描述里)。
    非 git 仓库/本地改动冲突时报错不强制。
    """
    if not folder or os.path.basename(folder) != folder or folder.startswith("."):
        raise ValueError("非法的插件目录名")
    dest = os.path.join(CUSTOM_NODES_DIR, folder)
    if not os.path.isdir(dest):
        raise RuntimeError(f"插件目录不存在: {folder}")
    if not is_git_repo(folder):
        raise RuntimeError(
            f"{folder} 不是 git 仓库(可能是手动放置/压缩包安装),无法 git 更新")
    # pull 前记录 HEAD,用于判断是否真的拉到了新提交
    before = ""
    try:
        _, b = _run_git(["rev-parse", "HEAD"], cwd=dest)
        before = (b or "").strip()
    except RuntimeError:
        before = ""
    code, text = _run_git(["pull", "--ff-only"], cwd=dest)
    if code != 0:
        raise RuntimeError(
            f"git pull 失败(本地可能有改动,请手动处理):\n{text or '(无输出)'}")
    after = ""
    try:
        _, a = _run_git(["rev-parse", "HEAD"], cwd=dest)
        after = (a or "").strip()
    except RuntimeError:
        after = ""
    changed = bool(before and after and before != after)
    auto: list[str] = []
    if changed:
        auto = _auto_setup_deps(dest)
        _pending_restart["flag"] = True
    if changed:
        out = "已拉取到新代码"
        if auto:
            out += "，" + "；".join(auto)
        else:
            out += "（仓库无 requirements.txt / install.bat,无需自动安装）"
        if text and "already up to date" not in text.lower():
            out += "\n" + text
    else:
        out = "已是最新版本,未拉取到新代码"
        if text:
            out += "\n" + text
    return {"folder": folder, "changed": changed,
            "auto": auto, "output": _clip(out, 2000)}


def install_plugin_deps(folder: str) -> dict:
    """手动安装某已装插件的运行依赖：requirements.txt + install.bat(如有)。

    与 update_plugin 拉新后的自动步骤共用 _auto_setup_deps；
    只要仓库根存在二者之一即置待重启标记。返回 {"folder","deps","output"}：
    deps=False → 仓库根没有 requirements.txt / install.bat,无需安装。
    """
    if not folder or os.path.basename(folder) != folder or folder.startswith("."):
        raise ValueError("非法的插件目录名")
    dest = os.path.join(CUSTOM_NODES_DIR, folder)
    if not os.path.isdir(dest):
        raise RuntimeError(f"插件目录不存在: {folder}")
    has_any = (os.path.isfile(os.path.join(dest, "requirements.txt"))
               or os.path.isfile(os.path.join(dest, "install.bat")))
    notes = _auto_setup_deps(dest)
    if has_any:
        _pending_restart["flag"] = True
    if not notes:
        return {"folder": folder, "deps": False,
                "output": "仓库根没有 requirements.txt / install.bat,无需安装"}
    return {"folder": folder, "deps": True, "output": "；".join(notes)}


def pending_restart() -> bool:
    return bool(_pending_restart["flag"])


def clear_pending_restart() -> None:
    _pending_restart["flag"] = False


def restart_comfyui() -> bool:
    """软重启 ComfyUI：与 ComfyUI-Manager 一致,用 ``os.execv`` 原地以相同解释器/
    参数重启当前进程——不弹新窗口、无新旧进程并存期,端口立即让出。

    - 启动命令尽量复刻当前进程（``sys.executable + sys.argv``，cwd 保持），因此
      ``--listen / --port / --gpu-device`` 等参数自动保留;同时移除由外层
      run_*.bat 注入的 ``--windows-standalone-build`` 启动器标记(与 Manager 相同);
    - 为保证 aiohttp 先把「重启已调度」响应送回前端,execv 由 2 秒定时器触发;
    - execv 意外失败时自动降级为「后台拉起新进程 + 结束当前进程」。
    """
    try:
        cwd = os.getcwd()
        try:
            import folder_paths
            # 入口脚本（main.py）为相对路径但当前 cwd 不在 ComfyUI 根时回退，
            # 避免重启找不到入口
            if (sys.argv and os.path.basename(sys.argv[0]) == "main.py"
                    and not os.path.isfile(sys.argv[0])):
                cwd = folder_paths.base_path
        except Exception:
            pass
        cmd = [sys.executable] + [
            a for a in sys.argv if a != "--windows-standalone-build"]
        log.info("[ext_mgmt] restart scheduled: argv=%s cwd=%s", cmd, cwd)

        def _restart():
            try:
                os.chdir(cwd)
            except OSError:
                pass
            log.info("[ext_mgmt] restarting ComfyUI now...")
            try:
                os.execv(sys.executable, cmd)
            except Exception as e:
                log.warning("[ext_mgmt] execv failed (%s), fallback to spawn+exit", e)
                try:
                    subprocess.Popen(cmd, cwd=cwd, close_fds=True)
                except Exception as e2:
                    log.warning("[ext_mgmt] spawn fallback failed: %s", e2)
                    return
                os._exit(0)

        threading.Timer(2.0, _restart).start()
        return True
    except Exception:
        log.warning("[ext_mgmt] failed to schedule restart", exc_info=True)
        return False


def pip_install_package(pkg: str = "llama-cpp-python", extra_args: str = "") -> dict:
    """以当前解释器执行 ``python -m pip install [extra_args] pkg`` 并返回结果。

    同步阻塞、由 server 经 ``asyncio.to_thread`` 调用（pip 可能耗时数分钟，
    期间不冻结 aiohttp 事件循环）。extra_args 按空白切分（覆盖常见
    ``--extra-index-url`` / ``-i`` 等用法）；输出截尾返回便于前端展示。

    llama-cpp-python 且未填附加参数时（默认按钮场景）**不走裸 pip**，改走
    ``lib.llm.auto_install_llama_cpp()``：已能 import 直接成功；未装则从
    JamePeng/llama-cpp-python GitHub release 下载与平台/Python/CUDA 匹配的
    预编译 wheel 以 ``--no-deps`` 安装 —— PyPI 没有 Windows 预编译 wheel，
    源码编译极易失败；且裸 pip 的全量依赖解析会访问配置的镜像/代理，在网络
    受限环境即便已装也会误报失败。填了附加参数则按原逻辑执行，尊重用户指定
    的索引 / 镜像源。
    """
    if pkg.replace("_", "-").lower() == "llama-cpp-python" and not (extra_args or "").strip():
        from .lib import llm as _llm  # 延迟导入：仅默认按钮路径需要
        try:
            res = _llm.auto_install_llama_cpp()
        except Exception as e:
            log.warning("[ext_mgmt] auto install llama-cpp-python failed: %s", e, exc_info=True)
            return {"ok": False, "tail": str(e), "cmd": "auto wheel (GitHub release)"}
        return {"ok": bool(res.get("ok")), "tail": res.get("tail", ""),
                "cmd": "auto wheel (GitHub release)"}
    cmd = [sys.executable, "-m", "pip", "install",
           "--disable-pip-version-check", "--no-input"]
    if extra_args and extra_args.strip():
        cmd.extend(extra_args.strip().split())
    cmd.append(pkg)
    try:
        cp = subprocess.run(cmd, capture_output=True, text=True,
                            errors="replace", timeout=None)
        tail = ((cp.stdout or "") + (cp.stderr or ""))[-4000:]
        log.info("[ext_mgmt] pip install rc=%s pkg=%s", cp.returncode, pkg)
        return {"ok": cp.returncode == 0, "tail": tail, "cmd": " ".join(cmd)}
    except Exception as e:
        log.warning("[ext_mgmt] pip install failed: %s", e, exc_info=True)
        return {"ok": False, "tail": str(e), "cmd": " ".join(cmd)}


def llama_cpp_status() -> dict:
    """探测当前解释器 llama-cpp-python 的安装状态(面板 Python 依赖区展示)。

    - ok=False → 未安装或导入失败(前端红色提示,可点「安装」自动下载 wheel);
    - ok=True  → version 为版本号;gpu: True=CUDA 版 / False=CPU 版 / None=未知。
    """
    import importlib.util
    if importlib.util.find_spec("llama_cpp") is None:
        return {"ok": False, "version": None, "gpu": None, "error": None}
    try:
        import llama_cpp  # noqa: F401  (进程内模块缓存,仅首次扫描有一次 import 开销)
    except Exception as e:
        return {"ok": False, "version": None, "gpu": None, "error": str(e)}
    ver = str(getattr(llama_cpp, "__version__", "") or "")
    gpu: bool | None = None
    try:
        gpu = bool(llama_cpp.llama_supports_gpu_offload())
    except Exception:
        gpu = None  # 旧版 API 缺失,视为未知
    return {"ok": True, "version": ver or "?", "gpu": gpu, "error": None}


# ---------------------------------------------------------------------------
# 文件资源引用(LLM·GGUF / vae_approx)存在性判定
# ---------------------------------------------------------------------------
# 这些资源不落在 models/<MODEL_TYPES> 的固定类型目录,目录语义各自不同:
# - llm → models/llm 等 folder_paths 'llm' 已注册目录(GGUF / onnx / bin 等);
# - vae_approx → models/vae_approx(TAE / TinyAutoEncoder 预览近似 VAE)。
# 图像 / 视频 / 音频等 input 素材资源不再做引用检测。
# 前端运行时从各节点 widget 值收集 {kind, name},scan 对每项做存在性判定,
# 缺失项在面板红色展示(仅提示,不提供替换入口)。

FILE_KINDS: tuple[str, ...] = ("llm", "vae_approx")
_LLM_EXTS = (".gguf", ".bin", ".onnx", ".safetensors", ".ckpt", ".pt", ".pth")
# vae_approx：TAE / TinyAutoEncoder 等「模型预览近似 VAE」，放 models/vae_approx
#（KJNodes ModelPreviewOverrideKJ 的 tiny_vae、WanVideoWrapper 的 TAE 加载等）
_VAE_APPROX_EXTS = (".safetensors", ".ckpt", ".pt", ".pth")
_FILE_KIND_EXTS: dict[str, tuple[str, ...]] = {
    "llm": _LLM_EXTS,
    "vae_approx": _VAE_APPROX_EXTS,
}
# llm / vae_approx 目录文件索引缓存:{root: (签名, exts, {相对名: 绝对路径})}
_resource_index: dict = {}


def _kind_roots(kind: str) -> list[str]:
    """某资源 kind 的可能存放根目录(存在性判定用)。

    仅 llm / vae_approx 两类:目录来自 folder_paths 注册的同名模型目录,
    未注册时兜底 models/<kind>。
    """
    roots: list[str] = []
    try:
        import folder_paths
        for d in folder_paths.get_folder_paths(kind):
            if d:
                roots.append(d)
    except Exception:
        pass
    if not roots:
        roots.append(os.path.join(models_root_dir(), kind))
    return roots


def _index_dir_files(root: str, exts: tuple[str, ...]) -> dict[str, str]:
    """目录内文件索引 {相对名(/) -> 绝对路径},带 mtime 签名缓存。"""
    try:
        sig = (os.path.getmtime(root), os.path.getsize(root))
    except OSError:
        return {}
    prev = _resource_index.get(root)
    if prev and prev["sig"] == sig and prev["exts"] == exts:
        return prev["data"]
    out: dict[str, str] = {}
    if os.path.isdir(root):
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fn in filenames:
                if fn.lower().endswith(exts):
                    rel = os.path.relpath(
                        os.path.join(dirpath, fn), root).replace("\\", "/")
                    out.setdefault(rel, os.path.join(dirpath, fn))
    _resource_index[root] = {"sig": sig, "exts": exts, "data": out}
    return out


def scan_file_refs(refs: list[dict] | None) -> list[dict]:
    """资源引用存在性判定。refs: [{kind, name}](仅 llm / vae_approx)。

    匹配优先级:绝对路径原样 → 目录内相对路径(含子目录) → 目录内 basename
    (大小写不敏感)。返回每行:{kind, name, exists, localPath}。
    """
    if not refs:
        return []
    rows: dict[tuple[str, str], dict] = {}
    for r in refs:
        if not isinstance(r, dict):
            continue
        kind = str(r.get("kind") or "").strip().lower()
        if kind not in FILE_KINDS:
            continue
        name = str(r.get("name") or "").strip()
        if not name or len(name) > 500 \
                or name.lower().startswith(("http://", "https://")):
            continue
        key = (kind, name)
        if key not in rows:
            rows[key] = {"kind": kind, "name": name,
                         "exists": False, "localPath": None}

    for (kind, name), row in rows.items():
        roots = _kind_roots(kind)
        exts = _FILE_KIND_EXTS[kind]
        norm = name.replace("\\", "/")
        base = norm.rsplit("/", 1)[-1]
        found = ""
        if os.path.isabs(name):
            if os.path.isfile(name):
                row["exists"] = True
                row["localPath"] = name
            continue
        # 1) 目录内相对路径(含子目录;拒绝 .. / 绝对前缀越界)
        for root in roots:
            if norm.startswith(("..", "/", "\\")):
                continue
            cand = os.path.normpath(
                os.path.join(root, *norm.split("/")))
            if os.path.isfile(cand):
                found = cand
                break
        # 2) basename 递归匹配(大小写不敏感,适配引用名与目录内文件名差异)
        if not found:
            for root in roots:
                if not os.path.isdir(root):
                    continue
                for rel, abs_path in _index_dir_files(root, exts).items():
                    if rel.rsplit("/", 1)[-1].lower() == base.lower():
                        found = abs_path
                        break
                if found:
                    break
        if found:
            row["exists"] = True
            row["localPath"] = found
    return list(rows.values())


def _class_source_clue(cname: str) -> dict | None:
    """custom_nodes 下源码含该 class 的目录线索(class 未注册时解释用)。

    返回 {"folder", "disabled"}:disabled=True 表示该目录被改名 ``.disabled``
    停用;否则目录存在但 class 未被加载(如 __init__ import 报错 / 未启用),
    前端据此提示用户,而不是只显示一句"未匹配到仓库"。
    """
    if not cname or len(cname) < 3:
        return None
    for folder in sorted(_text_index()):
        if cname in (_text_index()[folder] or ""):
            return {"folder": folder, "disabled": False}
    try:
        entries = sorted(os.listdir(CUSTOM_NODES_DIR))
    except OSError:
        return None
    for name in entries:
        if not name.endswith(".disabled") or not os.path.isdir(
                os.path.join(CUSTOM_NODES_DIR, name)):
            continue
        for dirpath, dirnames, filenames in os.walk(
                os.path.join(CUSTOM_NODES_DIR, name)):
            dirnames[:] = [d for d in dirnames if d != "__pycache__"]
            for fn in filenames:
                if not fn.endswith(_PY_SUFFIX):
                    continue
                try:
                    with open(os.path.join(dirpath, fn), "r",
                              encoding="utf-8", errors="ignore") as fh:
                        if cname in fh.read():
                            return {"folder": name, "disabled": True}
                except OSError:
                    continue
    return None


# ---------------------------------------------------------------------------
# 扫描主入口
# ---------------------------------------------------------------------------


def scan_payload(node_classes: list[str] | None,
                 lora_names: list[str] | None,
                 widget_values: list[str] | None = None,
                 model_refs: list[dict] | None = None,
                 file_refs: list[dict] | None = None) -> dict:
    """汇总一次扫描结果(供前端管理面板渲染)。

    入参是前端从当前工作流 LiteGraph 图里收集的:
    - node_classes:去重后的节点 class(含 ComfyUI 内置节点,后端会过滤);
    - model_refs:去重后的模型引用 [{name, type}],type ∈ MODEL_TYPES
      (前端按 loader/widget 归属类型,避免 diffusion/unet/vae 误入 loras);
    - lora_names / widget_values:旧版兼容参数,仅在缺少 model_refs 时
      启用并全部按 loras 处理(保持历史行为)。
    """
    classes = list(dict.fromkeys(str(c) for c in (node_classes or []) if c))
    _MODEL_EXTS = (".safetensors", ".ckpt", ".pt", ".pth")

    # ---- 收集各类型引用 ----
    refs_by_type: dict[str, list[str]] = {t: [] for t in MODEL_TYPES}
    if model_refs:
        for r in model_refs:
            if not isinstance(r, dict):
                continue
            name = str(r.get("name") or "").strip()
            typ = str(r.get("type") or "").strip().lower()
            if not name:
                continue
            if typ not in MODEL_TYPES:
                typ = "loras"  # 未知类型按 loras 容错,不丢弃引用
            if name not in refs_by_type[typ]:
                refs_by_type[typ].append(name)
    else:
        # 旧版前端兼容:lora_names + widget_values 全部按 loras 处理
        cat_names = {i["name"] for i in model_catalog("loras")}
        cat_base = {i["name"].rsplit("/", 1)[-1]: i["name"]
                    for i in model_catalog("loras")}
        for n in (lora_names or []):
            s = str(n).strip()
            if s and s not in refs_by_type["loras"]:
                refs_by_type["loras"].append(s)
        for v in (widget_values or []):
            s = str(v).strip()
            if not s or s in refs_by_type["loras"]:
                continue
            matched = s if s in cat_names \
                else cat_base.get(s.replace("\\", "/").rsplit("/", 1)[-1])
            if matched:
                if matched not in refs_by_type["loras"]:
                    refs_by_type["loras"].append(matched)
            elif re.search(r"\.(safetensors|ckpt|pt|pth)$", s, re.I) \
                    or ("/" in s and "." in s.replace("\\", "/").rsplit("/", 1)[-1]):
                # 形似模型文件引用但 loras 目录中不存在 → 作为「缺失」候选展示
                if s not in refs_by_type["loras"]:
                    refs_by_type["loras"].append(s)

    folder_classes = module_class_index()
    class_folder, builtin = class_ownership()

    used: dict[str, dict] = {}
    missing: list[dict] = []
    trace: dict[str, str] = {}  # class -> 归属原因(便于排查扫描结果)
    for c in classes:
        # ComfyUI 内置节点 / 纯前端 UI 节点:不参与插件缺失判定
        if c in builtin:
            trace[c] = "builtin"
            continue
        if c in _FRONTEND_UI_CLASSES:
            trace[c] = "ui"
            continue
        folder = class_folder.get(c)
        if folder:
            trace[c] = f"plugin:{folder}"
            u = used.setdefault(folder, {"folder": folder, "classes": []})
            if c not in u["classes"]:
                u["classes"].append(c)
        else:
            trace[c] = "missing"
            missing.append({
                "nodeClass": c,
                "candidates": repo_candidates_for_class(c),
                "source": _class_source_clue(c),
            })

    installed = []
    for folder in installed_dirs():
        git = is_git_repo(folder)
        url = git_repo_url(folder) if git else None
        if not url:
            cand = repo_candidates_for_folder(folder)
            url = cand[0]["reference"] if cand else None
        classes_in = folder_classes.get(folder, [])
        installed.append({
            "folder": folder,
            "git": git,
            "updatable": git,  # 可更新 = git 仓库(点击时实际执行 pull)
            "repoUrl": url,
            "classCount": len(classes_in),
            "used": folder in used,
            # 提供 requirements.txt / install.bat → 前端展示「安装依赖」按钮
            "deps": (os.path.isfile(os.path.join(CUSTOM_NODES_DIR, folder, "requirements.txt"))
                     or os.path.isfile(os.path.join(CUSTOM_NODES_DIR, folder, "install.bat"))),
        })

    # ---- 各类型存在性判定(每类型独立 catalog + 相对路径解析) ----
    models: dict[str, list[dict]] = {}
    for t in MODEL_TYPES:
        cat = model_catalog(t)
        cat_names = {i["name"] for i in cat}
        cat_basenames: dict[str, str] = {}
        cat_stems: dict[str, str] = {}
        for i in cat:
            bn = i["name"].replace("\\", "/").rsplit("/", 1)[-1]
            cat_basenames.setdefault(bn, i["name"])
            stem = bn
            for e in _MODEL_EXTS:
                if stem.lower().endswith(e):
                    stem = stem[: -len(e)]
                    break
            cat_stems.setdefault(stem, i["name"])

        def _resolve(value: str) -> str | None:
            """引用值 → 目录内真实相对路径(name / basename / stem 三级匹配)。"""
            if value in cat_names:
                return value
            base = value.replace("\\", "/").rsplit("/", 1)[-1]
            if base in cat_basenames:
                return cat_basenames[base]
            if value in cat_stems:
                return cat_stems[value]
            if base in cat_stems:
                return cat_stems[base]
            return None

        root = models_dir_for(t)
        rows: list[dict] = []
        for n in refs_by_type[t]:
            resolved = _resolve(n)
            local_path = None
            if resolved:
                local_path = os.path.normpath(
                    os.path.join(root, resolved.replace("/", os.sep)))
            rows.append({"name": n, "exists": bool(resolved),
                         "localPath": local_path})
        models[t] = rows

    files: dict[str, list[dict]] = {k: [] for k in FILE_KINDS}
    for row in scan_file_refs(file_refs):
        files.setdefault(row["kind"], []).append(row)

    return {
        "plugins": installed,
        "usedPlugins": sorted(used.values(), key=lambda x: x["folder"]),
        "missingPlugins": missing,
        "models": models,
        "files": files,
        "pendingRestart": pending_restart(),
        "customNodesDir": CUSTOM_NODES_DIR,
        "trace": trace,
        "llamaCpp": llama_cpp_status(),
    }


# ---------------------------------------------------------------------------
# ModelScope 下载
# ---------------------------------------------------------------------------


def _ms_request(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
        return resp.read()


def parse_model_scope_id(text: str) -> str:
    """把模型页链接或 owner/name 解析为规范 model_id。"""
    t = (text or "").strip()
    if not t:
        raise ValueError("请填写 ModelScope 模型 ID(owner/name)或模型页链接")
    m = re.search(r"modelscope\.cn/models/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)", t)
    if m:
        return m.group(1)
    m = re.match(r"^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$", t)
    if m:
        return t
    if "/" not in t and not re.match(r"^https?://", t):
        # 只给了一个名称(如 mystic)：没有 owner 前缀无法定位仓库
        search_url = "https://modelscope.cn/search?search=" \
            + urllib.parse.quote(t)
        raise ValueError(
            f"“{text}”不是模型 ID：ModelScope 模型须用 owner/name 或模型页链接"
            "标识(如 QWen/Qwen2.5-7B)。仅知道名称时，请先在官网搜索 "
            f"{search_url} ，复制结果页的模型链接再粘贴到这里")
    raise ValueError(
        f"无法解析 ModelScope 模型: {text}。请填写 owner/name 或 "
        "https://modelscope.cn/models/<owner>/<name> 模型页链接")


def ms_repo_files(model_id: str, recursive: bool = True,
                  revision: str = "master") -> list[dict]:
    """列举 ModelScope 仓库文件,返回 [{name,path,size,type}]。"""
    mid = parse_model_scope_id(model_id)
    owner, name = mid.split("/", 1)
    url = (f"https://modelscope.cn/api/v1/models/"
           f"{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}/repo/files"
           f"?Recursive={'true' if recursive else 'false'}"
           f"&Revision={urllib.parse.quote(revision)}")
    try:
        raw = _ms_request(url)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ModelScope 文件列举失败(HTTP {e.code}): {mid}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"ModelScope 文件列举失败(网络错误): {e.reason}")
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        raise RuntimeError(f"ModelScope 返回异常内容(非 JSON): {mid}")
    if not data.get("Success") or data.get("Code") not in (200, "200", None):
        raise RuntimeError(f"ModelScope 返回错误: {data.get('Message') or data.get('Code')}")
    files = []
    for f in data.get("Data", {}).get("Files", []) or []:
        files.append({
            "name": str(f.get("Name") or ""),
            "path": str(f.get("Path") or ""),
            "size": int(f.get("Size") or 0),
            "type": str(f.get("Type") or ""),
        })
    return files


# ---------------------------------------------------------------------------
# ModelScope 全局搜索(尽力而为 + 降级)
# ---------------------------------------------------------------------------
# 现网实测(2026-09):dolphin/models 等公开搜索端点已 404 下线。这里先顺序
# 尝试历史上可用的 POST 端点(将来恢复即自动生效),再回退 Bing 站点搜索
# 提取 modelscope.cn/models 仓库 URL;全部失败返回 degraded=True 交由前端
# 引导用户打开官方搜索页手填模型 ID。

_DOLPHIN_ENDPOINTS = (
    "https://modelscope.cn/api/v1/dolphin/models",
    "https://www.modelscope.cn/api/v1/dolphin/models",
)
_SEARCH_TIMEOUT = 12


def _find_model_list(data):
    """宽容遍历响应定位模型列表(兼容多套历史返回结构)。"""
    if not isinstance(data, dict):
        return None
    d = data.get("Data")
    if isinstance(d, dict):
        for key in ("Models", "List"):
            if isinstance(d.get(key), list):
                return d[key]
        m = d.get("Model")
        if isinstance(m, dict) and isinstance(m.get("Models"), list):
            return m["Models"]
    for key in ("Models", "List"):
        if isinstance(data.get(key), list):
            return data[key]
    return None


def _norm_model_item(it: dict) -> dict | None:
    """条目 -> {modelId,title,owner,description,url}。"""
    if not isinstance(it, dict):
        return None
    mid = str(it.get("Path") or it.get("ModelId") or it.get("Id") or "").strip().strip("/")
    if "/" not in mid:
        return None
    owner, name = mid.split("/", 1)
    if not (owner and name):
        return None
    title = str(it.get("ChineseName") or it.get("EnglishName") or it.get("Name") or mid)
    desc = str(it.get("Desc") or it.get("Description") or "")
    if len(desc) > 120:
        desc = desc[:120] + "…"
    return {
        "modelId": mid,
        "title": title,
        "owner": owner,
        "description": desc,
        "url": "https://modelscope.cn/models/" + mid,
    }


def _search_dolphin(query: str, limit: int) -> list[dict] | None:
    """顺序尝试 dolphin POST 端点;任一返回可解析列表即停。失败返回 None。"""
    body = json.dumps({
        "Name": query,
        "PageNumber": 1,
        "PageSize": limit,
        "SortBy": "Default",
        "Target": "",
        "SingleCriterion": [],
    }).encode()
    for url in _DOLPHIN_ENDPOINTS:
        try:
            req = urllib.request.Request(
                url, data=body,
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": _UA_BROWSER,
                    "Accept": "application/json",
                    "Origin": "https://modelscope.cn",
                    "Referer": "https://modelscope.cn/",
                })
            with urllib.request.urlopen(req, timeout=_SEARCH_TIMEOUT) as resp:
                raw = resp.read()
            data = json.loads(raw.decode("utf-8", errors="replace"))
        except Exception:
            continue
        items = _find_model_list(data)
        if not items:
            continue
        out: list[dict] = []
        seen: set[str] = set()
        for it in items:
            r = _norm_model_item(it)
            if r and r["modelId"] not in seen:
                seen.add(r["modelId"])
                out.append(r)
            if len(out) >= limit:
                break
        if out:
            return out
    return None


def _decode_ck_url(href: str) -> str | None:
    """解码 Bing 的 /ck/a 跳转参数(u=a1<base64>)。"""
    m = re.search(r"[?&]u=a1([A-Za-z0-9+/=]+)", href)
    if not m:
        return None
    try:
        import base64
        return base64.urlsafe_b64decode(m.group(1) + "==").decode("utf-8", "ignore")
    except Exception:
        return None


def _search_bing(query: str, limit: int) -> list[dict] | None:
    """Bing 站点搜索兜底:site:modelscope.cn/models 提取仓库 URL。"""
    url = ("https://www.bing.com/search?q="
           + urllib.parse.quote(f"site:modelscope.cn/models {query}"))
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA_BROWSER})
        with urllib.request.urlopen(req, timeout=_SEARCH_TIMEOUT) as resp:
            html = resp.read(2_000_000).decode("utf-8", "ignore")
    except Exception:
        return None
    out: list[dict] = []
    seen: set[str] = set()
    for href in re.findall(r'href="(https?://[^"]+)"', html):
        target = href
        if "bing.com/ck/a" in target or "bing.com/ck/a" in href:
            target = _decode_ck_url(href) or target
        m = re.search(r"modelscope\.cn/models/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)", target)
        if not m:
            continue
        mid = m.group(1)
        if mid in seen:
            continue
        seen.add(mid)
        out.append({
            "modelId": mid,
            "title": mid,
            "owner": mid.split("/", 1)[0],
            "description": "",
            "url": "https://modelscope.cn/models/" + mid,
        })
        if len(out) >= limit:
            break
    return out or None


def ms_search(query: str, limit: int = 10) -> dict:
    """按关键词搜索 ModelScope 模型仓库。

    返回 ``{"results": [...], "degraded": bool}``;搜索端点全不可用或零命中时
    degraded=True(不抛错),由前端引导手填模型 ID / 打开官方搜索页。
    """
    query = (query or "").strip()
    if not query:
        raise ValueError("请输入搜索关键词")
    qshort = query[:60]
    log.info("ms_search query=%r", qshort)
    results = _search_dolphin(qshort, limit)
    if not results:
        results = _search_bing(qshort, limit)
    if not results:
        return {"results": [], "degraded": True}
    return {"results": results, "degraded": False}


def ms_download_file(model_id: str, file_path: str,
                     target_dir: str = "", subdir: str = "") -> dict:
    """流式下载 ModelScope 文件到 models/<target_dir>[/仓库内子目录],返回落盘信息。

    ``target_dir`` 为相对 ComfyUI ``models`` 根目录的保存路径(如 ``loras``、
    ``loras/xx``),留空回退 ``loras``;``file_path`` 可含仓库内子目录(如
    ``weights/lora.safetensors``):目标目录保留该相对结构(白名单字符、总深度
    ≤5 层、拒绝 ``..``/绝对路径),ComfyUI 可按原相对路径引用;已存在同路径且
    非空时跳过不重复下载。
    """
    mid = parse_model_scope_id(model_id)
    if not file_path or not file_path.strip():
        raise ValueError("请选择要下载的文件")
    fpath = file_path.strip().lstrip("/")
    if re.search(r"(\.\.|[:*?\"<>|])", fpath) or "\\" in fpath:
        raise ValueError("非法文件路径")
    owner, name = mid.split("/", 1)
    url = (f"https://modelscope.cn/models/{urllib.parse.quote(owner)}/"
           f"{urllib.parse.quote(name)}/resolve/master/{fpath}")

    def _safe_parts(path: str) -> list[str]:
        parts = []
        for p in re.split(r"[/\\]", path or ""):
            if not p or p in (".", ".."):
                continue
            p = re.sub(r"[^A-Za-z0-9_.-]", "_", p)
            if p:
                parts.append(p)
        return parts[:5]

    # target_dir 允许带 "models/" 前缀(用户视角);显式拒绝绝对路径与越界
    td = str(target_dir or "").strip().replace("\\", "/").strip("/")
    if td.lower() == "models":
        td = ""
    elif td.lower().startswith("models/"):
        td = td[len("models/"):]
    if re.match(r"^[A-Za-z]:", td) or td.startswith("/"):
        raise ValueError("保存路径请填写相对 models/ 的路径")
    parts = (_safe_parts(td) + _safe_parts(subdir)
             + _safe_parts(os.path.dirname(fpath)))[:5]
    if not parts:
        parts = ["loras"]
    dest_dir = os.path.join(models_root_dir(), *parts)
    os.makedirs(dest_dir, exist_ok=True)
    base_name = os.path.basename(fpath)
    rel_name = "/".join(parts + [base_name])
    final = os.path.join(dest_dir, base_name)
    if os.path.exists(final) and os.path.getsize(final) > 0:
        return {"name": rel_name, "path": final, "size": os.path.getsize(final),
                "skipped": True}
    tmp = final + ".download"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            total = 0
            with open(tmp, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    total += len(chunk)
            if total == 0:
                raise RuntimeError("ModelScope 下载返回空文件")
        os.replace(tmp, final)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ModelScope 下载失败(HTTP {e.code}): {fpath}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"ModelScope 下载失败(网络错误): {e.reason}")
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return {"name": rel_name, "path": final, "size": total, "skipped": False}
