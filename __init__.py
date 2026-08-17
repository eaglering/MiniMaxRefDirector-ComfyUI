from . import server  # registers /minimax_ref/api routes

from .subject import MiniMaxRefSubject
from .director import MiniMaxRefDirector
from .guide import MiniMaxRefGuide
from .lib.utils import RefJoinString
from .lib.video import RefMergeVideosFromPaths
from .lib.audio import RefSaveAudio
from .lib.image import RefSaveImage
from .lib.hybrid import RefHybridLoader

from comfy_api.latest import ComfyExtension, io
from typing_extensions import override

class PromptRelay(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            MiniMaxRefDirector,
            MiniMaxRefGuide,
            MiniMaxRefSubject,
            RefJoinString,
            RefMergeVideosFromPaths,
            RefSaveAudio,
            RefSaveImage,
        ]

async def comfy_entrypoint() -> PromptRelay:
    return PromptRelay()
    
NODE_CLASS_MAPPINGS = {
    "MiniMaxRefSubject": MiniMaxRefSubject,
    "MiniMaxRefDirector": MiniMaxRefDirector,
    "MiniMaxRefGuide": MiniMaxRefGuide,
    "MiniMaxRefMergeVideosFromPaths": RefMergeVideosFromPaths,
    "MiniMaxRefSaveImage": RefSaveImage,
    "MiniMaxRefSaveAudio": RefSaveAudio,
    "MiniMaxRefJoinString": RefJoinString,
    "MiniMaxRefHybridLoader": RefHybridLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefSubject": "MiniMax Subject",
    "MiniMaxRefDirector": "MiniMax Super Director",
    "MiniMaxRefGuide": "MiniMax Ref Guide",
    "MiniMaxRefMergeVideosFromPaths": "Merge Videos From Paths",
    "MiniMaxRefSaveImage": "Save Image",
    "MiniMaxRefSaveAudio": "Save Audio",
    "MiniMaxRefJoinString": "Join Strings",
    "MiniMaxRefHybridLoader": "MiniMax Ref Hybrid Loader"
}

WEB_DIRECTORY = "./js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']