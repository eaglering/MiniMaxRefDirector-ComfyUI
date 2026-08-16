import os
import folder_paths

def resolve_input_path(filename: str) -> str:
    """Resolve a relative file path to an absolute path.

    查找顺序：
    1. 绝对路径（存在则直接返回）
    2. ComfyUI 风格前缀：input/...、temp/...、output/...（带越界校验）
    3. 裸相对路径：先 input（向后兼容），再 output、temp
    4. 兜底：input/minimaxrefdirector/<basename>
    全部失败返回 ""。
    """
    if not filename:
        return ""
    if os.path.isabs(filename) and os.path.exists(filename):
        return filename

    _PREFIXED = {
        "input": folder_paths.get_input_directory,
        "temp": folder_paths.get_temp_directory,
        "output": folder_paths.get_output_directory,
    }
    for prefix, get_dir in _PREFIXED.items():
        if filename.startswith(prefix + "/") or filename.startswith(prefix + os.sep):
            rel = filename[len(prefix) + 1:]
            base_dir = os.path.realpath(get_dir())
            candidate = os.path.realpath(os.path.join(base_dir, rel))
            if os.path.commonpath((base_dir, candidate)) != base_dir:
                raise ValueError(f"Path escapes the ComfyUI {prefix!r} directory: {rel!r}")
            if os.path.isfile(candidate):
                return candidate
            raise FileNotFoundError(f"File not found in {prefix!r} directory: {rel!r}")

    for base_dir in (
        folder_paths.get_input_directory(),
        folder_paths.get_output_directory(),
        folder_paths.get_temp_directory(),
    ):
        candidate = os.path.join(base_dir, filename)
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)

    basename = os.path.basename(filename)
    fallback = os.path.join(folder_paths.get_input_directory(), "minimaxrefdirector", basename)
    if os.path.isfile(fallback):
        return os.path.abspath(fallback)
    return ""
