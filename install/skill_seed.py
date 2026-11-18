"""镜头技能词典种子数据（install，仅首次建库/迁移时使用）。

技能定义（运镜/景别/镜头结构/微表情）的唯一静态来源：lib/skill_db.py 首次创建
skills.db 时读取本模块写入数据库，并写 .lock 标记；之后一律以数据库为准
（界面编辑 / 新增技能都落库），lock 存在则不再重复初始化。

内置类别只声明「注入方式」（render_mode）：
- 运镜 → term（中文名直写提示词 + name_en 英文对照，翻译阶段按 glossary 还原；
- 景别 / 镜头结构 → term（同上）
- 微表情 → example（每镜挑一句示例自然融入）
自定义类别（人物主体 / 打斗 / 特效 / 风格…）在界面创建时选择注入方式即可，
渲染与校验逻辑见 lib/skill_notes.py 与 lib/skill_db.py。

字段精简原则（按三段链路「原始提示词 → H3 中文 → H3 英文」的实际使用）：
- 运镜：name（纯中文名，如「推近」）+ name_en（英文对照，如 "Push-in / Dolly-in"）
  + desc（中文一句话）。无 guide、examples 恒为空数组。
- 景别 / 镜头结构：仅 name（中文名直接写入提示词，如「大远景」「双人镜头」）+
  name_en（英文阶段对照映射，保证翻译为 extreme wide shot / two shot 而非泛化词）。
- 微表情：name（如「轻叹」）+ name_en + desc + examples（中文示例数组，最终使用）
  + group_name（eye/brow/mouth/breath/body，供旧导演台分组筛选）。
"""

# ── 运镜（Camera Motion，中文名直写提示词；name_en 供英文阶段对照）─────────────
_CAMERA_MOTION = {
    "push_in": {
        "name": "推近",
        "name_en": "Push-in / Dolly-in",
        "desc": "机位向主体或兴趣点前移，画面逐渐收紧，增强张力或亲密感。",
    },
    "pull_back": {
        "name": "拉远",
        "name_en": "Pull-back / Dolly-out",
        "desc": "机位自主体后退，视野逐渐张开，交代环境、比例与情境。",
    },
    "push_pull": {
        "name": "推拉组合",
        "name_en": "Push + Pull",
        "desc": "同一镜头内先推后拉（或反之）的连贯运动，形成推拉相间的节奏。",
    },
    "orbit": {
        "name": "环绕",
        "name_en": "Orbit",
        "desc": "机位沿人物作弧线环绕（半圈或整圈），不断变换观察角度。",
    },
    "tracking": {
        "name": "跟拍",
        "name_en": "Tracking / Handheld",
        "desc": "机位与人物平行或跟随其后移动，同步其行进（可带轻微手持的真实感）。",
    },
    "aerial": {
        "name": "航拍",
        "name_en": "Aerial / Drone",
        "desc": "俯拍、航拍或无人机镜头，用于建立场景、飞掠而过或向兴趣点下降。",
    },
    "crane": {
        "name": "升降",
        "name_en": "Crane / Tilt",
        "desc": "垂直方向的镜头运动：升降臂起落或俯仰扫动，用以重新构图画面。",
    },
    "pan": {
        "name": "横摇",
        "name_en": "Pan",
        "desc": "机位不动，镜头水平扫动，掠过场景或在主体之间移动。",
    },
    "close_up": {
        "name": "特写",
        "name_en": "Close-up / Macro",
        "desc": "大特写或微距构图，将面孔、物体、质感或细节充满画面。",
    },
}

# 运镜类别说明（写进 skill_categories.description，仅作界面说明）
CAMERA_CATEGORY_DESC = (
    "运镜方式词条（中文名直写提示词，英文阶段按英文对照还原）。"
    "分镜 / H3 提示词中的运镜描写用自然语言即可，此处词条供导演台按镜头勾选。"
)

# ── 景别（中文名直接写入提示词；name_en 供英文阶段对照）────────────────────
_SHOT_SIZE = {
    "extreme_wide": {"name": "大远景", "name_en": "extreme wide shot"},
    "wide": {"name": "远景", "name_en": "wide shot"},
    "full": {"name": "全身", "name_en": "full shot"},
    "medium_long": {"name": "中远景", "name_en": "medium long shot"},
    "cowboy": {"name": "牛仔镜头", "name_en": "cowboy shot"},
    "medium": {"name": "中景", "name_en": "medium shot"},
    "medium_close_up": {"name": "中近景", "name_en": "medium close-up"},
    "close_up_shot": {"name": "近景", "name_en": "close-up"},
    "extreme_close_up": {"name": "特写", "name_en": "extreme close-up"},
}
SHOT_SIZE_CATEGORY_DESC = "画面取景范围档位（大远景→特写），同一镜头只用一种；提示词中直接写入中文名称。"

# ── 镜头结构（中文名直接写入提示词；name_en 供英文阶段对照）────────────────
_FRAMING = {
    "over_the_shoulder": {"name": "过肩镜头", "name_en": "over-the-shoulder shot"},
    "two_shot": {"name": "双人镜头", "name_en": "two-shot"},
    "insert": {"name": "插入镜头", "name_en": "insert shot"},
    "establishing": {"name": "定场镜头", "name_en": "establishing shot"},
}
FRAMING_CATEGORY_DESC = "构图与镜头关系惯例：过肩/双人/插入/定场；提示词中直接写入中文名称。"

# ── 微表情（name=展示名；examples=中文示例数组，最终使用；group_name=分组）─
_MICRO_EXPRESSION = {
    "gaze_shift": {"name": "眼神游移", "name_en": "Gaze shift", "group": "eye",
                   "desc": "视线短暂离开原落点又游移回来，透露迟疑或分神。",
                   "examples": ["目光短暂滑开，旋即又落回原处", "视线游移了一瞬，再重新对上对方"]},
    "glance_away": {"name": "避开视线", "name_en": "Glance away", "group": "eye",
                    "desc": "目光迅速避开对方或斜向别处，常见于回避与心虚。",
                    "examples": ["微微垂下眼帘，不敢直视对方", "话出口的瞬间，目光逃向别处"]},
    "stare_hard": {"name": "凝视", "name_en": "Fixed stare", "group": "eye",
                   "desc": "目光死死锁定一个方向，一眨不眨，情绪高度专注或对峙。",
                   "examples": ["目光定定地望着前方，一眨不眨", "直直地凝视着那个方向，纹丝不动"]},
    "blink_slow": {"name": "缓慢眨眼", "name_en": "Slow blink", "group": "eye",
                   "desc": "一次缓慢而刻意的眨眼，节奏被拉长，似在消化或轻蔑。",
                   "examples": ["眼睛缓缓闭上又睁开，似在消化什么", "缓慢而郑重地眨了一下眼"]},
    "brow_raise": {"name": "挑眉", "name_en": "Brow raise", "group": "brow",
                   "desc": "眉毛短暂上扬，带出惊讶、怀疑或试探。",
                   "examples": ["眉毛微微一挑，带出几分怀疑", "双眉短暂上扬，难掩意外"]},
    "brow_furrow": {"name": "皱眉", "name_en": "Brow furrow", "group": "brow",
                    "desc": "眉头轻轻蹙起，透露困惑、担忧或不悦。",
                    "examples": ["眉头轻轻蹙起，隐有不安", "眉心聚起一丝褶皱，似有犹疑"]},
    "one_brow_rise": {"name": "单眉上挑", "name_en": "One brow", "group": "brow",
                      "desc": "只挑起一侧眉毛，半信半疑或带一丝玩味。",
                      "examples": ["只挑起一侧眉毛，半信半疑", "单边眉毛轻轻一扬，似笑非笑"]},
    "lip_press": {"name": "抿唇", "name_en": "Lip press", "group": "mouth",
                  "desc": "双唇抿紧成线，强压情绪或斟酌措辞。",
                  "examples": ["双唇抿成一条细线，强压着情绪", "嘴唇紧紧抿起，不发一言"]},
    "lip_tighten": {"name": "嘴角绷紧", "name_en": "Lip tighten", "group": "mouth",
                    "desc": "嘴角线条瞬间绷紧，克制的紧张或不满。",
                    "examples": ["嘴角不自觉地绷紧了一下", "唇角的线条几乎不可察觉地收紧了"]},
    "micro_smile": {"name": "转瞬微笑", "name_en": "Fleeting smile", "group": "mouth",
                    "desc": "一丝浅笑掠过嘴角，转瞬即逝。",
                    "examples": ["一丝淡笑掠过嘴角，转瞬即逝", "脸上浮起一个若有若无的浅笑，很快又淡去"]},
    "lips_part": {"name": "唇微张", "name_en": "Lips part", "group": "mouth",
                  "desc": "双唇微微张开又止住，欲言又止或惊愕。",
                  "examples": ["嘴唇微微张开，似要说些什么又止住", "双唇轻轻分开，难掩惊愕"]},
    "lip_corner_twitch": {"name": "嘴角抽动", "name_en": "Lip-corner twitch", "group": "mouth",
                          "desc": "一侧嘴角不自主抽动，泄露内心的波动。",
                          "examples": ["一侧嘴角不自主地抽动了一下", "唇角的肌肉微微跳动，泄露了内心的波动"]},
    "breath_catch": {"name": "屏息", "name_en": "Catch breath", "group": "breath",
                     "desc": "呼吸骤然一滞，被眼前的景象攫住。",
                     "examples": ["呼吸骤然一滞", "轻轻吸了一口气，屏住了片刻"]},
    "exhale_sigh": {"name": "轻叹", "name_en": "Soft sigh", "group": "breath",
                    "desc": "一次轻而长的呼气，泄出疲惫或释然。",
                    "examples": ["长长地、轻轻地呼出一口气，像是卸下什么", "一声几不可闻的叹息轻轻落下"]},
    "swallow": {"name": "吞咽", "name_en": "Swallow", "group": "breath",
                "desc": "喉结轻滚咽了一下，紧张或下定了决心。",
                "examples": ["喉结紧张地滚动，咽了一下口水", "开口前，喉头先紧张地吞咽了一下"]},
    "head_tilt": {"name": "歪头", "name_en": "Head tilt", "group": "body",
                  "desc": "头部微微倾向一侧，打量或好奇。",
                  "examples": ["头微微一侧，似在斟酌对方的话", "头轻轻歪向一侧，带着几分探究"]},
    "head_drop": {"name": "垂头", "name_en": "Head drop", "group": "body",
                  "desc": "头部垂低下去，失落、羞愧或认命。",
                  "examples": ["头缓缓低下，目光落向地面", "低下头，像是默认了什么"]},
    "turn_away": {"name": "别过头", "name_en": "Turn away", "group": "body",
                  "desc": "头与上身别向别处，回避视线或结束对话。",
                  "examples": ["脸微微别开，回避这场对视", "侧过头去，避开了视线"]},
    "shoulder_tense": {"name": "肩部紧绷", "name_en": "Shoulders tense", "group": "body",
                       "desc": "肩部不自觉耸紧，戒备或用力支撑。",
                       "examples": ["肩颈不自觉地绷紧了一瞬", "肩膀微微耸起，带着防备"]},
    "hand_still": {"name": "手部僵住", "name_en": "Hand control", "group": "body",
                   "desc": "原本在动的手骤然僵住，被什么惊住或按住了情绪。",
                   "examples": ["伸出的手在半空顿住", "手指暗暗收紧，强压住颤抖"]},
}
MICRO_CATEGORY_DESC = "克制的面部与肢体表演细节；生成时从中文示例数组中挑一句自然织入，不写技能名。"

# spa/skills.json 的分组 id → 类别名（历史自定义词条迁移用）
GROUP_TO_CATEGORY = {
    "cameraMotions": "运镜",
    "shotSizes": "景别",
    "framings": "镜头结构",
    "expressions": "微表情",
}

# 类别名 → 生成链路旧字段名（legacy 兼容：lib/skill_notes.py resolve_legacy_selections
# 用它把旧 payload 的 camera_motion / shot_size / framing 反查到对应类别）
CATEGORY_FIELD = {
    "运镜": "camera",
    "景别": "shotSize",
    "镜头结构": "framing",
    "微表情": "expression",
}

# ── 注入方式（skill_categories.render_mode）────────────────────────────────
# 决定该类别技能如何进入 skill_notes：
#   term        术语类：中文名直接写入镜头描述，英文阶段按 name_en 对照（运镜 / 景别 / 镜头结构）
#   example     示例类：从示例数组挑一句自然融入，不写技能名（微表情）
#   descriptive 描述类：desc + 示例短语自然融入（人物主体 / 打斗 / 特效等扩展类别）
#   block       片段类：整段内容近似原样进入提示词（风格 / 特殊效果预置）
RENDER_MODES = ("term", "example", "descriptive", "block")

# 内置类别 → render_mode（旧 camera 模式已移除，运镜与景别/镜头结构同为 term）
BUILTIN_CATEGORY_RENDER = {
    "运镜": "term",
    "景别": "term",
    "镜头结构": "term",
    "微表情": "example",
}


def _skill_row(key: str, data: dict, group: str = "") -> dict:
    """组装一条技能行（examples 为数组，入库时序列化为 JSON）。"""
    return {
        "key": key,
        "name": data.get("name") or key,
        "name_en": data.get("name_en") or "",
        "desc": data.get("desc") or "",
        "examples": list(data.get("examples") or []),
        "group_name": group,
    }


def build_builtin_categories() -> list:
    """组装内置类别与技能行（首次建库种子，见 lib/skill_db.py）。"""
    camera = [_skill_row(k, d) for k, d in _CAMERA_MOTION.items()]
    shot = [_skill_row(k, d) for k, d in _SHOT_SIZE.items()]
    framing = [_skill_row(k, d) for k, d in _FRAMING.items()]
    micro = [_skill_row(k, d, group=d.get("group") or "") for k, d in _MICRO_EXPRESSION.items()]
    cats = [
        {"name": "运镜", "field": "camera",
         "render_mode": "term",
         "description": CAMERA_CATEGORY_DESC, "skills": camera},
        {"name": "景别", "field": "shotSize",
         "render_mode": "term",
         "description": SHOT_SIZE_CATEGORY_DESC, "skills": shot},
        {"name": "镜头结构", "field": "framing",
         "render_mode": "term",
         "description": FRAMING_CATEGORY_DESC, "skills": framing},
        {"name": "微表情", "field": "expression",
         "render_mode": "example",
         "description": MICRO_CATEGORY_DESC, "skills": micro},
    ]
    # skills.key 全局唯一（跨类别也不得重名，否则后入库的会被 INSERT OR IGNORE 静默吞掉）
    seen: dict = {}
    for cat in cats:
        for s in cat["skills"]:
            prev = seen.get(s["key"])
            if prev:
                raise ValueError(
                    f"skill_seed 内置技能 key 重名：{s['key']}（{prev} / {cat['name']}）")
            seen[s["key"]] = cat["name"]
    return cats
