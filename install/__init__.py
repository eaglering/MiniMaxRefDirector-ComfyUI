"""install 包：首次初始化资源（skills.db 技能词典数据库与 .lock 标记）。

镜头技能词典的静态定义已迁至 resources/skill_words/seed.json：
lib/skill_db.py 首次创建 skills.db 时读取它写入数据库并写 .lock 标记，
之后以数据库为准（界面编辑/新增都落库），lock 存在则不再初始化。
技能文档种子位于 resources/skill_docs/seed.json。
"""
