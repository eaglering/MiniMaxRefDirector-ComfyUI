from . import server  # registers /minimax_ref/api routes

from .subject import MiniMaxRefSubject
from .director import MiniMaxRefDirector
from .lib.utils import RefJoinString
from .lib.video import RefMergeVideosFromPaths
from .lib.audio import RefSaveAudio
from .lib.image import RefSaveImage

from comfy_api.latest import ComfyExtension, io
from typing_extensions import override

class PromptRelay(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            MiniMaxRefDirector,
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
    "MiniMaxRefMergeVideosFromPaths": RefMergeVideosFromPaths,
    "MiniMaxRefSaveImage": RefSaveImage,
    "MiniMaxRefSaveAudio": RefSaveAudio,
    "MiniMaxRefJoinString": RefJoinString,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefSubject": "MiniMax Subject",
    "MiniMaxRefDirector": "MiniMax Super Director",
    "MiniMaxRefMergeVideosFromPaths": "Merge Videos From Paths",
    "MiniMaxRefSaveImage": "Save Image",
    "MiniMaxRefSaveAudio": "Save Audio",
    "MiniMaxRefJoinString": "Join Strings",
}

WEB_DIRECTORY = "./js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']