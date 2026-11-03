// ===== skill 词库：key 与后端 lib/prompt.py 预设及 js/components/director/shared.js 完全一致 =====

export const CAMERA_MOTIONS = [
  { key: "push_in", label: "推近 Push-in" },
  { key: "pull_back", label: "拉远 Pull-back" },
  { key: "push_pull", label: "推拉组合 Push+Pull" },
  { key: "orbit", label: "环绕 Orbit" },
  { key: "tracking", label: "跟拍 Tracking" },
  { key: "aerial", label: "航拍 Aerial" },
  { key: "crane", label: "升降 Crane" },
  { key: "pan", label: "横摇 Pan" },
  { key: "close_up", label: "特写 Close-up" },
];

export const SHOT_SIZES = [
  { key: "extreme_wide", label: "大远景" },
  { key: "wide", label: "远景" },
  { key: "full", label: "全身" },
  { key: "medium_long", label: "中远景" },
  { key: "cowboy", label: "牛仔镜头" },
  { key: "medium", label: "中景" },
  { key: "medium_close_up", label: "中近景" },
  { key: "close_up", label: "近景" },
  { key: "extreme_close_up", label: "特写" },
];

export const FRAMINGS = [
  { key: "over_the_shoulder", label: "过肩镜头" },
  { key: "two_shot", label: "双人镜头" },
  { key: "insert", label: "插入镜头" },
  { key: "establishing", label: "定场镜头" },
];

export const MICRO_EXPRESSIONS = [
  { key: "gaze_shift", label: "眼神游移", category: "eye" },
  { key: "glance_away", label: "避开视线", category: "eye" },
  { key: "stare_hard", label: "凝视", category: "eye" },
  { key: "blink_slow", label: "缓慢眨眼", category: "eye" },
  { key: "brow_raise", label: "挑眉", category: "brow" },
  { key: "brow_furrow", label: "皱眉", category: "brow" },
  { key: "one_brow_rise", label: "单眉上挑", category: "brow" },
  { key: "lip_press", label: "抿唇", category: "mouth" },
  { key: "lip_tighten", label: "嘴角绷紧", category: "mouth" },
  { key: "micro_smile", label: "转瞬微笑", category: "mouth" },
  { key: "lips_part", label: "唇微张", category: "mouth" },
  { key: "lip_corner_twitch", label: "嘴角抽动", category: "mouth" },
  { key: "breath_catch", label: "屏息", category: "breath" },
  { key: "exhale_sigh", label: "轻叹", category: "breath" },
  { key: "swallow", label: "吞咽", category: "breath" },
  { key: "head_tilt", label: "歪头", category: "body" },
  { key: "head_drop", label: "垂头", category: "body" },
  { key: "turn_away", label: "别过头", category: "body" },
  { key: "shoulder_tense", label: "肩部紧绷", category: "body" },
  { key: "hand_still", label: "手部僵住", category: "body" },
];

export const SKILL_GROUPS = [
  { id: "cameraMotions", label: "运镜", items: CAMERA_MOTIONS },
  { id: "shotSizes", label: "景别", items: SHOT_SIZES },
  { id: "framings", label: "镜头结构", items: FRAMINGS },
  { id: "expressions", label: "微表情", items: MICRO_EXPRESSIONS },
];

// segment 字段名 → skill 组 id 映射（写回 timeline_data 的字段名）
// shotSizes 在现有数据中写作 shotSizes；framings 为扩展字段（...rest 保留）。
export const SEGMENT_SKILL_FIELDS = {
  cameraMotions: "cameraMotions",
  shotSizes: "shotSizes",
  framings: "framings",
  expressions: "expressions",
};
