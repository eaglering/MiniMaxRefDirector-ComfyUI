from . import server  # registers /minimax_ref/api routes

from .minimax_ref_subject import MiniMaxRefSubject
from .minimax_ref_director import MiniMaxRefDirector
from .minimax_ref_director_guide import MiniMaxRefDirectorGuide
from .minimax_ref_prompt_enhance import MinimaxRefPromptEnhance
from .minimax_ref_tools import (
    MiniMaxRefJoinString,
    MiniMaxRefMergeVideosFromPaths,
    MiniMaxRefSaveAudio,
    MiniMaxRefSaveImage,
)
from comfy_api.latest import ComfyExtension, io
from typing_extensions import override

class PromptRelay(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            MiniMaxRefDirector,
            MiniMaxRefDirectorGuide,
            MiniMaxRefSubject,
            MinimaxRefPromptEnhance,
            MiniMaxRefMergeVideosFromPaths,
            MiniMaxRefSaveImage,
            MiniMaxRefSaveAudio,
            MiniMaxRefJoinString,
        ]

async def comfy_entrypoint() -> PromptRelay:
    return PromptRelay()
    
NODE_CLASS_MAPPINGS = {
    "MiniMaxRefSubject": MiniMaxRefSubject,
    "MiniMaxRefDirector": MiniMaxRefDirector,
    "MiniMaxRefDirectorGuide": MiniMaxRefDirectorGuide,
    "MiniMaxRefPromptEnhance": MinimaxRefPromptEnhance,
    "MiniMaxRefMergeVideosFromPaths": MiniMaxRefMergeVideosFromPaths,
    "MiniMaxRefSaveImage": MiniMaxRefSaveImage,
    "MiniMaxRefSaveAudio": MiniMaxRefSaveAudio,
    "MiniMaxRefJoinString": MiniMaxRefJoinString,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxRefSubject": "MiniMax Subject",
    "MiniMaxRefDirector": "MiniMax Super Director",
    "MiniMaxRefDirectorGuide": "MiniMax Super Director Guide",
    "MiniMaxRefPromptEnhance": "MiniMax Ref Prompt Enhance",
    "MiniMaxRefMergeVideosFromPaths": "MiniMaxRef Merge Videos From Paths",
    "MiniMaxRefSaveImage": "MiniMaxRef Save Image",
    "MiniMaxRefSaveAudio": "MiniMaxRef Save Audio",
    "MiniMaxRefJoinString": "MiniMaxRef Join Strings",
}

WEB_DIRECTORY = "./js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']