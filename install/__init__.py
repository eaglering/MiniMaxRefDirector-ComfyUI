"""install 包：首次初始化资源（技能词典种子等）。

install/skill_seed.py 是镜头技能词典的唯一静态定义来源：
lib/skill_db.py 首次创建 skills.db 时读取它写入数据库并写 .lock 标记，
之后以数据库为准（界面编辑/新增都落库），lock 存在则不再初始化。
"""
