"""MiniMaxRef Ext Manager：插件 / LoRA 依赖管理（前端工具节点）。

该节点本身无实际计算 —— 前端（js/ext-manager.js）在其节点体上挂
一个「打开管理面板」按钮，弹窗内展示当前工作流用到的全部自定义插件与
LoRA（顶栏附「重启 ComfyUI」软重启按钮，安装/更新后无需手动关窗口）。

- 已安装插件：显示 git 仓库来源，可一键 git pull 更新（需重启生效）；
- 工作流用到但本地缺失的插件：经 ComfyUI-Manager db 给出候选仓库，一键
  git clone 安装（需重启生效）；
- LoRA：本地 models/loras 目录比对；缺失项经 ModelScope 仓库文件列举与
  resolve 直链下载。

后端逻辑见 ext_mgmt.py（路由宿主 server.py,前缀 /minimax_ref/api/ext/*）。
"""


class MiniMaxRefExtManager:
    """打开插件 / LoRA 依赖管理面板（纯前端交互，执行无副作用）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "open_manager"
    CATEGORY = "MiniMax Ref Director/Utils"

    def open_manager(self):
        # 无实际计算：该节点仅作为管理面板入口存在于图中。
        return ()
