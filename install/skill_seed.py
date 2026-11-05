"""镜头技能词典种子数据（install，仅首次建库时使用）。

技能定义（运镜/景别/镜头结构/微表情）的唯一静态来源：lib/skill_db.py 首次创建
skills.db 时读取本模块写入数据库，并写 .lock 标记；之后一律以数据库为准
（界面编辑 / 新增技能都落库），lock 存在则不再重复初始化。
lib/prompt.py 在数据库不可用时也会回退到本模块的 fallback_presets()。

本文件由原 lib/prompt.py 的预设迁移而来，双语字段结构与生成链路一致。
"""

import json


_CAMERA_MOTION_PRESETS = {'push_in': {'name_en': 'Push-in / Dolly-in',
             'name_zh': '推近 / 前移',
             'desc': 'The camera moves toward the subject or a point of interest, gradually '
                     'tightening the framing to increase tension or intimacy.',
             'examples': ['camera motion, slow push-in on the subject',
                          'camera motion, dolly-in gradually closing the distance',
                          'camera motion, a gentle push-in that ends on an intimate close-up']},
 'pull_back': {'name_en': 'Pull-back / Dolly-out',
               'name_zh': '拉远 / 后移',
               'desc': 'The camera retreats from the subject, widening the frame to reveal the '
                       'environment, scale or context.',
               'examples': ['camera motion, slow pull-back revealing the surroundings',
                            'camera motion, dolly-out widening into an establishing view',
                            'camera motion, a long pull-back that shows how small the subject is '
                            'in the scene']},
 'push_pull': {'name_en': 'Push + Pull',
               'name_zh': '推拉结合',
               'desc': 'A continuous move that combines a push-in with a pull-back (or the '
                       'reverse) within one shot, creating a dynamic in-and-out rhythm.',
               'examples': ['camera motion, push-in then pull-back in one flowing move',
                            'camera motion, a dolly-in that reverses into a slow dolly-out',
                            'camera motion, rhythmic push-and-pull around the subject']},
 'orbit': {'name_en': 'Orbit',
           'name_zh': '环绕',
           'desc': 'The camera circles around the subject on a partial or full arc, revealing it '
                   'from continuously changing angles.',
           'examples': ['camera motion, slow 360-degree orbit around the subject',
                        'camera motion, orbiting arc from the side to the front',
                        'camera motion, a full circular flight around the character']},
 'tracking': {'name_en': 'Tracking / Handheld',
              'name_zh': '跟拍 / 手持',
              'desc': 'The camera follows the subject laterally or from behind, moving in parallel '
                      'with its action (optionally with subtle handheld realism).',
              'examples': ['camera motion, tracking shot following the subject sideways',
                           'camera motion, handheld follow keeping pace with the movement',
                           'camera motion, a smooth tracking run alongside the character']},
 'aerial': {'name_en': 'Aerial / Drone',
            'name_zh': '航拍 / 无人机',
            'desc': 'A high-angle aerial or drone shot that establishes the scene, flies over it, '
                    'or descends toward a point of interest.',
            'examples': ['camera motion, aerial drone shot flying over the landscape',
                         'camera motion, high-angle drone descent toward the subject',
                         "camera motion, bird's-eye flyover establishing the area"]},
 'crane': {'name_en': 'Crane / Tilt',
           'name_zh': '升降 / 俯仰',
           'desc': 'Vertical camera movement: a crane shot rising or lowering, or a tilt sweeping '
                   'up or down to reframe the scene.',
           'examples': ['camera motion, crane shot rising above the scene',
                        'camera motion, slow tilt from the feet up to the face',
                        'camera motion, a lowering crane that settles at eye level']},
 'pan': {'name_en': 'Pan',
         'name_zh': '摇镜',
         'desc': 'The camera sweeps horizontally from a fixed position, scanning across the scene '
                 'or moving between subjects.',
         'examples': ['camera motion, slow pan across the full scene',
                      'camera motion, panning from one subject to another',
                      'camera motion, a measured left-to-right pan']},
 'close_up': {'name_en': 'Close-up / Macro',
              'name_zh': '特写 / 微距',
              'desc': 'Extreme close-up or macro framing that isolates a face, object, texture or '
                      'detail, filling the frame with it.',
              'examples': ["camera motion, extreme close-up on the subject's face",
                           'camera motion, macro shot of the detail in slow movement',
                           'camera motion, tight close-up holding on the object']}}

_MICRO_EXPRESSION_PRESETS = {'gaze_shift': {'name_en': 'Gaze shift',
                'name_zh': '视线游移',
                'examples': ['the eyes slide away for a moment before returning',
                             'a brief sideways wandering of the gaze, then it settles back',
                             'the look shifts off the other person, then comes back']},
 'glance_away': {'name_en': 'Glance away',
                 'name_zh': '别开视线',
                 'examples': ["briefly drops the gaze, unable to hold the other's eyes",
                              'the eyes escape downward for a heartbeat',
                              'looks away quickly at the end of the sentence']},
 'stare_hard': {'name_en': 'Fixed stare',
                'name_zh': '凝望',
                'examples': ['the eyes fix ahead, unblinking and still',
                             'a steady, unwavering stare that does not move',
                             'the gaze locks on and holds perfectly still']},
 'blink_slow': {'name_en': 'Slow blink',
                'name_zh': '缓眨',
                'examples': ['the eyes close and reopen slowly, deliberately',
                             'a single long, heavy blink, as if processing',
                             'blinks slowly while taking it in']},
 'brow_raise': {'name_en': 'Brow raise',
                'name_zh': '挑眉',
                'examples': ['one eyebrow lifts briefly in doubt',
                             'the brows rise a fraction, questioning',
                             'a quick raise of the brows in surprise']},
 'brow_furrow': {'name_en': 'Brow furrow',
                 'name_zh': '蹙眉',
                 'examples': ['the brows draw together in a faint frown',
                              'a small crease forms between the brows',
                              'the brows knit slightly, uncertain']},
 'one_brow_rise': {'name_en': 'One brow',
                   'name_zh': '单眉微挑',
                   'examples': ['the left brow arches alone, skeptical',
                                'a single eyebrow climbs, amused and wary',
                                'only one brow lifts, questioning the words']},
 'lip_press': {'name_en': 'Lip press',
               'name_zh': '抿唇',
               'examples': ['the lips press together into a thin line',
                            'a firm, tight press of the lips',
                            'the mouth sets in a hard, held line']},
 'lip_tighten': {'name_en': 'Lip tighten',
                 'name_zh': '嘴角绷紧',
                 'examples': ['the corners of the mouth tighten almost imperceptibly',
                              'a subtle clench at the corner of the mouth',
                              'the jaw beside the lips hardens for an instant']},
 'micro_smile': {'name_en': 'Fleeting smile',
                 'name_zh': '转瞬微笑',
                 'examples': ['a faint smile flickers across the lips and is gone',
                              'the mouth curves into a barely-there smile for an instant',
                              'a ghost of a smile passes over the face']},
 'lips_part': {'name_en': 'Lips part',
               'name_zh': '双唇微启',
               'examples': ['the lips part slightly as if to speak, then close',
                            'the mouth falls open a little in surprise',
                            'lips part a fraction, searching for words']},
 'lip_corner_twitch': {'name_en': 'Lip-corner twitch',
                       'name_zh': '嘴角微抽',
                       'examples': ['the corner of the mouth twitches once, almost a tic',
                                    'an involuntary twitch pulls at one side of the mouth',
                                    'one corner of the lips jerks, betraying the calm']},
 'breath_catch': {'name_en': 'Catch breath',
                  'name_zh': '屏息',
                  'examples': ['the breath catches for an instant',
                               'a small inward gasp, held still',
                               'breathing stops for a beat before it continues']},
 'exhale_sigh': {'name_en': 'Soft sigh',
                 'name_zh': '轻叹',
                 'examples': ['a long, quiet exhale releases the tension',
                              'lets out a soft, audible sigh',
                              'the shoulders fall with a slow breath out']},
 'swallow': {'name_en': 'Swallow',
             'name_zh': '吞咽',
             'examples': ['an audible swallow moves down the throat',
                          'the throat works in a nervous swallow',
                          'swallows hard before speaking']},
 'head_tilt': {'name_en': 'Head tilt',
               'name_zh': '头微倾',
               'examples': ['the head tilts a few degrees, considering',
                            'a slight cant of the head as doubt creeps in',
                            'the head inclines toward the other person']},
 'head_drop': {'name_en': 'Head drop',
               'name_zh': '低头',
               'examples': ['the chin dips, the eyes falling to the ground',
                            'the head lowers slowly, conceding',
                            'a small drop of the head in quiet defeat']},
 'turn_away': {'name_en': 'Turn away',
               'name_zh': '侧首回避',
               'examples': ['the face turns away by a fraction',
                            'half-turns the head, avoiding the confrontation',
                            'the gaze slides off to the side, away from the other']},
 'shoulder_tense': {'name_en': 'Shoulders tense',
                    'name_zh': '肩颈绷紧',
                    'examples': ['the shoulders stiffen almost unnoticeably',
                                 'a visible tightening of the neck and shoulders',
                                 'the shoulders draw up a little, guarded']},
 'hand_still': {'name_en': 'Hand control',
                'name_zh': '手部强抑',
                'examples': ['the hand freezes mid-gesture',
                             'fingers press together to keep from trembling',
                             'the hands stay rigidly still, held in check']}}

_SHOT_SIZE_PRESETS = {'extreme_wide': {'name_en': 'Extreme wide / Extreme long',
                  'name_zh': '大远景',
                  'desc': 'A very distant framing: the subject is tiny or part of the environment, '
                          'which dominates the frame.',
                  'examples': ['an extreme wide shot dwarfing the subject in the vast landscape',
                               'a wide establishing vista with the figure barely visible',
                               'extreme wide framing letting the environment swallow the '
                               'character']},
 'wide': {'name_en': 'Wide / Long',
          'name_zh': '远景',
          'desc': 'Full-length view with generous surroundings, placing the subject in its '
                  'context.',
          'examples': ['a wide shot of the figure crossing the square',
                       'a long shot showing the character against the full scenery',
                       'wide framing that keeps the whole body and its surroundings in view']},
 'full': {'name_en': 'Full shot',
          'name_zh': '全景',
          'desc': 'The whole subject fills the frame from head to toe; posture, costume and action '
                  'are fully visible.',
          'examples': ['a full shot of the character standing in the doorway',
                       'head-to-toe framing as they step forward',
                       'a full body shot capturing the entire gesture']},
 'medium_long': {'name_en': 'Medium long',
                 'name_zh': '中远景',
                 'desc': 'Framed from around the knees upward, keeping both the action and a sense '
                         'of the environment.',
                 'examples': ['a medium long shot from the knees up',
                              'knee-level framing as the character moves',
                              'a medium long composition that keeps the setting readable']},
 'cowboy': {'name_en': 'Cowboy shot',
            'name_zh': '牛仔镜头',
            'desc': 'Framed from mid-thigh up, a western-era medium framing that keeps the waist '
                    'and hands visible.',
            'examples': ['a cowboy shot framing the character from mid-thigh up',
                         'the classic cowboy shot as the two face each other',
                         'waist-up framing with the hands clearly in frame']},
 'medium': {'name_en': 'Medium',
            'name_zh': '中景',
            'desc': 'Framed from the waist up, balancing the subject with its setting.',
            'examples': ['a medium shot from the waist up',
                         'medium framing during the exchange',
                         'waist-up composition as the character gestures']},
 'medium_close_up': {'name_en': 'Medium close-up',
                     'name_zh': '中近景',
                     'desc': 'Framed from the chest up, favouring the face and shoulders while '
                             'keeping a hint of the background.',
                     'examples': ['a medium close-up favouring the face',
                                  'chest-up framing for the dialogue beat',
                                  'medium close-up catching the slight change of expression']},
 'close_up': {'name_en': 'Close-up',
              'name_zh': '特写',
              'desc': 'Framed from the shoulders up with the face dominant, isolating emotion and '
                      'intention.',
              'examples': ["a close-up on the character's face",
                           'shoulders-up framing holding the reaction',
                           'a tight close-up as the realization dawns']},
 'extreme_close_up': {'name_en': 'Extreme close-up',
                      'name_zh': '大特写',
                      'desc': 'A single feature - an eye, a mouth, a hand - or a detail fills the '
                              'frame.',
                      'examples': ['an extreme close-up of the eye widening',
                                   'a macro detail of the trembling fingers',
                                   'extreme close-up on the mouth as it speaks']}}

_FRAMING_PRESETS = {'over_the_shoulder': {'name_en': 'Over-the-shoulder',
                       'name_zh': '过肩',
                       'desc': "Shot from behind one person's shoulder toward the other, tying two "
                               'characters together in a conversation.',
                       'examples': ['over-the-shoulder framing past the listener toward the '
                                    'speaker',
                                    'an over-the-shoulder shot linking the two in dialogue',
                                    "looking past the shoulder at the other person's reaction"]},
 'two_shot': {'name_en': 'Two-shot',
              'name_zh': '双人同框',
              'desc': 'Both characters share the frame, showing the relationship and interaction '
                      'between them.',
              'examples': ['a two-shot of the pair facing each other',
                           'both characters in a single frame as they talk',
                           'a two-shot framing their closeness in one composition']},
 'insert': {'name_en': 'Insert',
            'name_zh': '插入镜头',
            'desc': 'An isolated cutaway detail - a hand, an object, a letter - that fills the '
                    'frame and carries meaning.',
            'examples': ['an insert of the hand tightening on the letter',
                         'a cutaway insert showing the watch face',
                         'an insert detail of the photo slipping into the pocket']},
 'establishing': {'name_en': 'Establishing',
                  'name_zh': '建立镜头',
                  'desc': 'An opening wide view that orients the audience to the location before '
                          'the action begins.',
                  'examples': ['an establishing shot of the street at dusk',
                               'a wide establishing view of the house before entering',
                               'open on an establishing wide that sets the place']}}

_CAMERA_MOTION_ZH = {'push_in': {'desc_zh': '机位向主体或兴趣点前移，画面逐渐收紧，增强张力或亲密感。',
             'examples_zh': ['镜头缓缓向人物推近，拉近彼此距离', '机位轻柔前推，收在一个亲密的近景上']},
 'pull_back': {'desc_zh': '机位自主体后退，视野逐渐张开，交代环境、比例与情境。',
               'examples_zh': ['镜头徐徐拉远，露出四周的环境', '机位后移成全景，衬出人物在场景中的渺小']},
 'push_pull': {'desc_zh': '同一镜头内先推后拉（或反之）的连贯运动，形成推拉相间的节奏。',
               'examples_zh': ['镜头先推近又拉远，一气呵成', '以推近开头，再缓缓拉回，带出往复的呼吸感']},
 'orbit': {'desc_zh': '机位沿人物作弧线环绕（半圈或整圈），不断变换观察角度。',
           'examples_zh': ['镜头绕着人物缓缓环绕一周', '从侧面绕到正前方的半环绕运镜']},
 'tracking': {'desc_zh': '机位与人物平行或跟随其后移动，同步其行进（可带轻微手持的真实感）。',
              'examples_zh': ['镜头横向跟拍，与人物并肩移动', '手持跟拍，始终跟上人物的步伐']},
 'aerial': {'desc_zh': '俯拍、航拍或无人机镜头，用于建立场景、飞掠而过或向兴趣点下降。',
            'examples_zh': ['无人机航拍，飞掠过整片场景', '高空镜头缓缓向目标人物下降']},
 'crane': {'desc_zh': '垂直方向的镜头运动：升降臂起落或俯仰扫动，用以重新构图画面。',
           'examples_zh': ['镜头从人物脚部缓缓仰起至面部', '升降臂升起，越过众人俯瞰全场']},
 'pan': {'desc_zh': '机位不动，镜头水平扫动，掠过场景或在主体之间移动。',
         'examples_zh': ['镜头水平缓摇，扫过整个场景', '从一个人物摇向另一个人物，带出两者的关联']},
 'close_up': {'desc_zh': '大特写或微距构图，将面孔、物体、质感或细节充满画面。',
              'examples_zh': ['镜头落在人物脸上，给出极近的特写', '以微距缓缓扫过物件的细节纹理']}}

_MICRO_EXPRESSION_ZH = {'gaze_shift': ['目光短暂滑开，旋即又落回原处', '视线游移了一瞬，再重新对上对方'],
 'glance_away': ['微微垂下眼帘，不敢直视对方', '话出口的瞬间，目光逃向别处'],
 'stare_hard': ['目光定定地望着前方，一眨不眨', '直直地凝视着那个方向，纹丝不动'],
 'blink_slow': ['眼睛缓缓闭上又睁开，似在消化什么', '缓慢而郑重地眨了一下眼'],
 'brow_raise': ['眉毛微微一挑，带出几分怀疑', '双眉短暂上扬，难掩意外'],
 'brow_furrow': ['眉头轻轻蹙起，隐有不安', '眉心聚起一丝褶皱，似有犹疑'],
 'one_brow_rise': ['只挑起一侧眉毛，半信半疑', '单边眉毛轻轻一扬，似笑非笑'],
 'lip_press': ['双唇抿成一条细线，强压着情绪', '嘴唇紧紧抿起，不发一言'],
 'lip_tighten': ['嘴角不自觉地绷紧了一下', '唇角的线条几乎不可察觉地收紧了'],
 'micro_smile': ['一丝淡笑掠过嘴角，转瞬即逝', '脸上浮起一个若有若无的浅笑，很快又淡去'],
 'lips_part': ['嘴唇微微张开，似要说些什么又止住', '双唇轻轻分开，难掩惊愕'],
 'lip_corner_twitch': ['一侧嘴角不自主地抽动了一下', '唇角的肌肉微微跳动，泄露了内心的波动'],
 'breath_catch': ['呼吸骤然一滞', '轻轻吸了一口气，屏住了片刻'],
 'exhale_sigh': ['长长地、轻轻地呼出一口气，像是卸下什么', '一声几不可闻的叹息轻轻落下'],
 'swallow': ['喉结紧张地滚动，咽了一下口水', '开口前，喉头先紧张地吞咽了一下'],
 'head_tilt': ['头微微一侧，似在斟酌对方的话', '头轻轻歪向一侧，带着几分探究'],
 'head_drop': ['头缓缓低下，目光落向地面', '低下头，像是默认了什么'],
 'turn_away': ['脸微微别开，回避这场对视', '侧过头去，避开了视线'],
 'shoulder_tense': ['肩颈不自觉地绷紧了一瞬', '肩膀微微耸起，带着防备'],
 'hand_still': ['伸出的手在半空顿住', '手指暗暗收紧，强压住颤抖']}

_SHOT_SIZE_ZH = {'extreme_wide': {'desc_zh': '极远取景：主体极小或融于广阔环境，画面以辽阔场景为主导。',
                  'examples_zh': ['以极大的远景，让渺小的人物立在辽阔的风景中', '镜头拉成壮阔的大远景，人物几乎只是景中的一个点']},
 'wide': {'desc_zh': '远景：全身入画且四周环境开阔，交代主体所处的情境。',
          'examples_zh': ['以远景呈现人物走过空旷广场的全貌', '远景镜头让整片场景与其中的人物同框']},
 'full': {'desc_zh': '全景：人物自头至脚恰好充满画面，动作与服饰完整可见。',
          'examples_zh': ['全景镜头，人物立在门口，全身入画', '镜头给出全身，完整捕捉他迈步的动作']},
 'medium_long': {'desc_zh': '中远景：自膝盖（或小腿）以上构图，兼顾动作与周遭环境。',
                 'examples_zh': ['中远景，人物自膝盖以上入画', '镜头落在膝部以上，让人物与场景同框']},
 'cowboy': {'desc_zh': '牛仔镜头：自大腿中部以上构图，源自西部片的半身取景，腰带与手部动作清晰可见。',
            'examples_zh': ['以牛仔镜头取景，人物自大腿以上入画', '两人对峙时，镜头用经典的牛仔镜头半身构图']},
 'medium': {'desc_zh': '中景：自腰部以上构图，人物与环境并重。',
            'examples_zh': ['中景镜头，人物腰部以上清晰入画', '用中景拍两人的交谈，兼顾表情与动作']},
 'medium_close_up': {'desc_zh': '中近景：自胸部以上构图，以面部与肩部为主，仍带一点背景气息。',
                     'examples_zh': ['中近景，镜头偏向人物的脸庞', '胸部以上的取景，恰好接住表情的细微变化']},
 'close_up': {'desc_zh': '特写：自肩部以上构图，面部占据画面主导，刻画情绪与意图。',
              'examples_zh': ['镜头推近，给人物面部一个特写', '肩部以上的构图，静静停在人物的神情上']},
 'extreme_close_up': {'desc_zh': '大特写：以眼睛、嘴唇、手等单一局部或细节充满画面。',
                      'examples_zh': ['大特写落在人物骤然睁大的眼睛上', '以极近的镜头扫过微微发抖的指尖']}}

_FRAMING_ZH = {'over_the_shoulder': {'desc_zh': '过肩：越过一人的肩头拍向另一人，将对话双方连入同一画面。',
                       'examples_zh': ['镜头越过对方的肩膀，望向说话的人', '过肩取景，把两人的对话拉进同一画面']},
 'two_shot': {'desc_zh': '双人同框：两位人物同处一画，呈现彼此的关系与互动。',
              'examples_zh': ['双人同框，两人面对面站定', '把两人一起收进画面，显出彼此的距离']},
 'insert': {'desc_zh': '插入镜头：以手、物件、信件等孤立细节充满画面作切出，承载潜台词。',
            'examples_zh': ['插入镜头：手在信纸上慢慢收紧', '切出一只手，悄悄把照片按回口袋']},
 'establishing': {'desc_zh': '建立镜头：开场以开阔视野交代地点，让人先明白身处何处再进入剧情。',
                  'examples_zh': ['开场先给黄昏街道的建立镜头', '以开阔的建立镜头交代这栋老宅，再进入室内']}}

# ── 展示名 / 分类映射 / 微表情中文描述（种子组装用）────────────────────────
# name 沿用前端胶囊展示名；微表情预设缺 desc，此处逐条补写克制的中文描述。
_MICRO_DESC = {
    "gaze_shift": "视线短暂离开原落点又游移回来，透露迟疑或分神。",
    "glance_away": "目光迅速避开对方或斜向别处，常见于回避与心虚。",
    "stare_hard": "目光死死锁定一个方向，一眨不眨，情绪高度专注或对峙。",
    "blink_slow": "一次缓慢而刻意的眨眼，节奏被拉长，似在消化或轻蔑。",
    "brow_raise": "眉毛短暂上扬，带出惊讶、怀疑或试探。",
    "brow_furrow": "眉头轻轻蹙起，透露困惑、担忧或不悦。",
    "one_brow_rise": "只挑起一侧眉毛，半信半疑或带一丝玩味。",
    "lip_press": "双唇抿紧成线，强压情绪或斟酌措辞。",
    "lip_tighten": "嘴角线条瞬间绷紧，克制的紧张或不满。",
    "micro_smile": "一丝浅笑掠过嘴角，转瞬即逝。",
    "lips_part": "双唇微微张开又止住，欲言又止或惊愕。",
    "lip_corner_twitch": "一侧嘴角不自主抽动，泄露内心的波动。",
    "breath_catch": "呼吸骤然一滞，被眼前的景象攫住。",
    "exhale_sigh": "一次轻而长的呼气，泄出疲惫或释然。",
    "swallow": "喉结轻滚咽了一下，紧张或下定了决心。",
    "head_tilt": "头部微微倾向一侧，打量或好奇。",
    "head_drop": "头部垂低下去，失落、羞愧或认命。",
    "turn_away": "头与上身别向别处，回避视线或结束对话。",
    "shoulder_tense": "肩部不自觉耸紧，戒备或用力支撑。",
    "hand_still": "原本在动的手骤然僵住，被什么惊住或按住了情绪。",
}
_MICRO_CATEGORY = {
    "gaze_shift": "eye", "glance_away": "eye", "stare_hard": "eye", "blink_slow": "eye",
    "brow_raise": "brow", "brow_furrow": "brow", "one_brow_rise": "brow",
    "lip_press": "mouth", "lip_tighten": "mouth", "micro_smile": "mouth",
    "lips_part": "mouth", "lip_corner_twitch": "mouth",
    "breath_catch": "breath", "exhale_sigh": "breath", "swallow": "breath",
    "head_tilt": "body", "head_drop": "body", "turn_away": "body",
    "shoulder_tense": "body", "hand_still": "body",
}
_CAMERA_LABELS = {
    "push_in": "推近 Push-in",
    "pull_back": "拉远 Pull-back",
    "push_pull": "推拉组合 Push+Pull",
    "orbit": "环绕 Orbit",
    "tracking": "跟拍 Tracking",
    "aerial": "航拍 Aerial",
    "crane": "升降 Crane",
    "pan": "横摇 Pan",
    "close_up": "特写 Close-up",
}
_SHOT_LABELS = {
    "extreme_wide": "大远景",
    "wide": "远景",
    "full": "全身",
    "medium_long": "中远景",
    "cowboy": "牛仔镜头",
    "medium": "中景",
    "medium_close_up": "中近景",
    "close_up": "近景",
    "extreme_close_up": "特写",
}
_FRAMING_LABELS = {
    "over_the_shoulder": "过肩镜头",
    "two_shot": "双人镜头",
    "insert": "插入镜头",
    "establishing": "定场镜头",
}
_MICRO_LABELS = {
    "gaze_shift": "眼神游移",
    "glance_away": "避开视线",
    "stare_hard": "凝视",
    "blink_slow": "缓慢眨眼",
    "brow_raise": "挑眉",
    "brow_furrow": "皱眉",
    "one_brow_rise": "单眉上挑",
    "lip_press": "抿唇",
    "lip_tighten": "嘴角绷紧",
    "micro_smile": "转瞬微笑",
    "lips_part": "唇微张",
    "lip_corner_twitch": "嘴角抽动",
    "breath_catch": "屏息",
    "exhale_sigh": "轻叹",
    "swallow": "吞咽",
    "head_tilt": "歪头",
    "head_drop": "垂头",
    "turn_away": "别过头",
    "shoulder_tense": "肩部紧绷",
    "hand_still": "手部僵住",
}

# spa/skills.json 的分组 id → 类别名（历史自定义词条迁移用）
GROUP_TO_CATEGORY = {
    "cameraMotions": "运镜",
    "shotSizes": "景别",
    "framings": "镜头结构",
    "expressions": "微表情",
}

# 类别名 → 生成链路指令构建用的字段名（lib/prompt.py _skill_presets 的 key）
CATEGORY_FIELD = {
    "运镜": "camera",
    "景别": "shotSize",
    "镜头结构": "framing",
    "微表情": "expression",
}


def _meta(**kw) -> str:
    """双语扩展信息打包为 JSON，存 skills.meta 列（生成链路注入用）。"""
    return json.dumps({k: v for k, v in kw.items() if v not in (None, "")}, ensure_ascii=False)


def _row(key, name, desc, prompt, example, keyword, meta) -> dict:
    return {"key": key, "name": name, "desc": desc, "prompt": prompt,
            "example": example, "keyword": keyword, "meta": meta}


def build_builtin_categories() -> list:
    """组装内置类别与技能行（首次建库种子，见 lib/skill_db.py）。"""
    camera = []
    for k in _CAMERA_LABELS:
        p = _CAMERA_MOTION_PRESETS[k]
        zh = _CAMERA_MOTION_ZH.get(k) or {}
        camera.append(_row(
            k, _CAMERA_LABELS[k],
            zh.get("desc_zh") or p.get("desc", ""),
            (p.get("examples") or [""])[0],
            (zh.get("examples_zh") or [""])[0],
            "camera motion",
            _meta(name_en=p.get("name_en"), name_zh=p.get("name_zh"),
                  desc_en=p.get("desc"), desc_zh=zh.get("desc_zh"),
                  examples_en=p.get("examples"), examples_zh=zh.get("examples_zh")),
        ))
    shot = []
    for k in _SHOT_LABELS:
        p = _SHOT_SIZE_PRESETS[k]
        zh = _SHOT_SIZE_ZH.get(k) or {}
        shot.append(_row(
            k, _SHOT_LABELS[k],
            zh.get("desc_zh") or p.get("desc", ""),
            (p.get("examples") or [""])[0],
            (zh.get("examples_zh") or [""])[0],
            "",
            _meta(name_en=p.get("name_en"), name_zh=p.get("name_zh"),
                  desc_en=p.get("desc"), desc_zh=zh.get("desc_zh"),
                  examples_en=p.get("examples"), examples_zh=zh.get("examples_zh")),
        ))
    framing = []
    for k in _FRAMING_LABELS:
        p = _FRAMING_PRESETS[k]
        zh = _FRAMING_ZH.get(k) or {}
        framing.append(_row(
            k, _FRAMING_LABELS[k],
            zh.get("desc_zh") or p.get("desc", ""),
            (p.get("examples") or [""])[0],
            (zh.get("examples_zh") or [""])[0],
            "",
            _meta(name_en=p.get("name_en"), name_zh=p.get("name_zh"),
                  desc_en=p.get("desc"), desc_zh=zh.get("desc_zh"),
                  examples_en=p.get("examples"), examples_zh=zh.get("examples_zh")),
        ))
    micro = []
    for k in _MICRO_LABELS:
        p = _MICRO_EXPRESSION_PRESETS.get(k) or {}
        zh_exs = list(_MICRO_EXPRESSION_ZH.get(k) or [])
        micro.append(_row(
            k, _MICRO_LABELS[k],
            _MICRO_DESC.get(k, ""),
            (p.get("examples") or [""])[0],
            zh_exs[0] if zh_exs else "",
            "",
            _meta(name_en=p.get("name_en"), name_zh=p.get("name_zh"),
                  desc_en=p.get("examples", [""])[0] if p.get("examples") else "",
                  desc_zh=_MICRO_DESC.get(k),
                  examples_en=p.get("examples"), examples_zh=zh_exs,
                  micro_category=_MICRO_CATEGORY.get(k)),
        ))
    return [
        {"name": "运镜", "field": "camera",
         "description": "镜头运动方式（H3 Camera Motion LoRA 触发词库，keyword 为 camera motion 前缀风格）",
         "skills": camera},
        {"name": "景别", "field": "shotSize",
         "description": "画面取景范围档位（大远景→大特写），同一镜头只用一种",
         "skills": shot},
        {"name": "镜头结构", "field": "framing",
         "description": "构图与镜头关系惯例：过肩/双人/插入/定场",
         "skills": framing},
        {"name": "微表情", "field": "expression",
         "description": "克制的面部与肢体表演细节，按镜头语义自然意译织入",
         "skills": micro},
    ]


def _preset_of(preset: dict, zh) -> dict:
    """把词典条目 + 中文本地化表合并为生成链路统一字段结构。"""
    zh = zh or {}
    if isinstance(zh, (list, tuple)):
        zh = {"examples_zh": list(zh)}
    return {
        "name_en": preset.get("name_en", ""),
        "name_zh": preset.get("name_zh", ""),
        "desc": preset.get("desc", ""),
        "desc_zh": zh.get("desc_zh", "") or preset.get("desc", ""),
        "examples": list(preset.get("examples") or []),
        "examples_zh": list(zh.get("examples_zh") or []),
    }


def fallback_presets() -> dict:
    """数据库不可用时的内置回退（与种子一致，供 lib/prompt.py 使用）。"""
    return {
        "camera": {k: _preset_of(v, _CAMERA_MOTION_ZH.get(k)) for k, v in _CAMERA_MOTION_PRESETS.items()},
        "shotSize": {k: _preset_of(v, _SHOT_SIZE_ZH.get(k)) for k, v in _SHOT_SIZE_PRESETS.items()},
        "framing": {k: _preset_of(v, _FRAMING_ZH.get(k)) for k, v in _FRAMING_PRESETS.items()},
        "expression": {
            k: dict(_preset_of(v, _MICRO_EXPRESSION_ZH.get(k)),
                    desc_zh=_MICRO_DESC.get(k) or v.get("name_zh", ""))
            for k, v in _MICRO_EXPRESSION_PRESETS.items()
        },
    }
