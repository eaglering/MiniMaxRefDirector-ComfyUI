"""MiniMaxRefDirectorSPA — SPA 导演台入口节点（纯前端交互，执行无副作用）。

前端（js/spa-node.js）在节点体上挂「打开导演台」按钮：
- 选择图中已有的 MiniMaxRefDirector（超级导演）节点作为数据目标；
- 点击后把该节点当前 widget 状态推送到 /minimax_ref/api/spa/push，
  并在新标签页打开单文件 SPA（js/spa/index.html）；
- SPA 保存时后端 send_sync("minimax_ref_spa_state")，前端监听并回写
  目标节点的 timeline_data 与全局参数 widget。
"""


class MiniMaxRefDirectorSPA:
    """打开 SPA 导演台页面（编辑结果写回图中已有的超级导演节点）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "open_spa"
    CATEGORY = "MiniMax Ref Director"

    def open_spa(self):
        # 无实际计算：该节点仅作为 SPA 导演台入口存在于图中。
        return ()
