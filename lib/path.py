import os
import folder_paths

def resolve_input_path(filename: str) -> str:
    """Resolve a relative file path under the ComfyUI input directory to an absolute path."""
    if not filename:
        return ""
    if os.path.isabs(filename) and os.path.exists(filename):
        return filename
    candidate = os.path.join(folder_paths.get_input_directory(), filename)
    if os.path.exists(candidate):
        return os.path.abspath(candidate)
    basename = os.path.basename(filename)
    fallback = os.path.join(folder_paths.get_input_directory(), "minimaxrefdirector", basename)
    if os.path.exists(fallback):
        return os.path.abspath(fallback)
    return ""