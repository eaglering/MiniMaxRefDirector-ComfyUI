from . import server  # registers /minimax_ref/api routes

from .subject import MiniMaxRefSubject
from .director import MiniMaxRefDirector
from .guide import MiniMaxRefGuide
from .combine import MiniMaxRefCombine
from .lib.utils import RefJoinString
from .lib.video import RefMergeVideosFromPaths
from .lib.audio import RefSaveAudio
from .lib.image import RefSaveImage
from .lib.hybrid import RefHybridLoader
from .lib.utils import RefPureVRAM

from comfy_api.latest import ComfyExtension, io
from typing_extensions import override

class PromptRelay(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            MiniMaxRefDirector,
            MiniMaxRefGuide,
            MiniMaxRefCombine,
            MiniMaxRefSubject,
            RefJoinString,
            RefMergeVideosFromPaths,
            RefSaveAudio,
            RefSaveImage,
            RefPureVRAM,
        ]

async def comfy_entrypoint() -> PromptRelay:
    return PromptRelay()
    
NODE_CLASS_MAPPINGS = {
    "MiniMaxRefSubject": MiniMaxRefSubject,
    "MiniMaxRefDirector": MiniMaxRefDirector,
    "MiniMaxRefGuide": MiniMaxRefGuide,
    "MiniMaxRefCombine": MiniMaxRefCombine,
    "MiniMaxRefMergeVideosFromPaths": RefMergeVideosFromPaths,
    "MiniMaxRefSaveImage": RefSaveImage,
    "MiniMaxRefSaveAudio": RefSaveAudio,
    "MiniMaxRefJoinString": RefJoinString,
    "MiniMaxRefHybridLoader": RefHybridLoader,
    "MiniMaxRefPureVRAM": RefPureVRAM
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefSubject": "MiniMax Subject",
    "MiniMaxRefDirector": "MiniMax Super Director",
    "MiniMaxRefGuide": "MiniMax Ref Guide",
    "MiniMaxRefCombine": "MiniMax Ref Combine",
    "MiniMaxRefMergeVideosFromPaths": "Merge Videos From Paths",
    "MiniMaxRefSaveImage": "Save Image",
    "MiniMaxRefSaveAudio": "Save Audio",
    "MiniMaxRefJoinString": "Join Strings",
    "MiniMaxRefHybridLoader": "MiniMax Ref Hybrid Loader",
    "MiniMaxRefPureVRAM": "MiniMax Ref Pure VRAM"
}

WEB_DIRECTORY = "./js"

# 若 server 模块导入时 PromptServer.instance 尚未就绪，其惰性收集的路由
# 会在本包导入完成后由 server._LazyRoutes.flush() 注册到 PromptServer。
try:
    from .server import _LazyRoutes
    _LazyRoutes.flush()
except Exception:
    pass

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']