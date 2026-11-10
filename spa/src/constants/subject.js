// ===== 主体常量：与 js/subject.js L1073-1122 逐项对齐 =====

export const SUBJECT_TYPES = ["Subject", "Picture", "Video", "Audio"];

export const SUBJECT_TYPE_LABELS = {
  Subject: "主体",
  Picture: "图片",
  Video: "视频",
  Audio: "音频",
};

export const REF_RELATIONSHIPS_SUBJECT = [
  { value: "fully_preserved", label: "fully preserved", desc: "被引用内容的既定角色被完全保留" },
  { value: "partially_preserved", label: "partially preserved", desc: "仍使用被引用内容，但部分既定特征被改变或仅部分保留" },
  { value: "attribute_transfer", label: "attribute transfer", desc: "被引用特征转移到另一个可识别的目标主体上" },
  { value: "weak_reference", label: "weak reference", desc: "仅保留风格、类别、构图或氛围上的大致相似" },
];

export const REF_RELATIONSHIPS_PV = REF_RELATIONSHIPS_SUBJECT;

export const REF_RELATIONSHIPS_AUDIO = [
  { value: "fully_copy", label: "fully copy", desc: "完整源音频作为目标视频的完整最终音轨" },
  { value: "partially_copy", label: "partially copy", desc: "仅复制时间线的一部分或选中的音频层，或复制后再增删替换其他声音" },
  { value: "reference", label: "reference", desc: "不直接复制信号，仅参考音色、节奏、音乐风格、对白内容或声音质感" },
  { value: "weak_reference", label: "weak reference", desc: "仅在类别或氛围上保留大致相似" },
];

export const REF_TYPE_RELATIONSHIPS = {
  Subject: REF_RELATIONSHIPS_SUBJECT,
  Picture: REF_RELATIONSHIPS_PV,
  Video: REF_RELATIONSHIPS_PV,
  Audio: REF_RELATIONSHIPS_AUDIO,
};

export function refDefaultRelationship(type) {
  const list = REF_TYPE_RELATIONSHIPS[type] || REF_RELATIONSHIPS_SUBJECT;
  return list[0].value;
}

// 类型 → 可上传的主媒体位
export const REF_TYPE_MEDIA = {
  Subject: { image: false, audio: false, video: false },
  Picture: { image: true, audio: false, video: false },
  Audio: { image: false, audio: true, video: false },
  Video: { image: false, audio: false, video: true },
};

// 类型 → 可 @ 引用的主体类型
export const REF_MENTION_TYPES = {
  Subject: ["Picture", "Video"],
  Picture: ["Picture"],
  Video: ["Picture", "Video"],
  Audio: ["Audio", "Subject"],
};

// 上传条（引用子主体）：父类型 → 可上传的子主体类型
export const REF_UPLOAD_CHILD_TYPES = {
  Subject: ["Picture", "Video", "Audio"],
  Picture: ["Picture"],
  Video: ["Picture", "Video"],
  Audio: ["Audio"],
};

export const REF_UPLOAD_CHILD_ACCEPT_TYPES = {
  Subject: ["image/*", "video/*"],
  Picture: ["image/*"],
  Video: ["image/*", "video/*"],
  Audio: ["audio/*"],
}

// 各类型子主体容量上限
export const REF_CHILD_CAP = { Picture: 9, Video: 3, Audio: 1 };

export function isChildSubject(s) {
  return !!(s && s.ownerUid);
}

// 分镜生效主体集合：全局为底，段级 subjectsOverride（被自定义主体的副本数组）
// 按 name 替换；override 中全局没有的追加。与 director.py 段级合并语义一致。
export function mergeSegmentSubjects(globalSubjects, override) {
  if (!Array.isArray(override) || !override.length) return globalSubjects || [];
  const g = globalSubjects || [];
  const ovByName = new Map();
  for (const s of override) {
    const n = (s && s.name ? String(s.name) : "").trim();
    if (n) ovByName.set(n, s);
  }
  const merged = g.map((s) => ovByName.get(String(s?.name || "").trim()) || s);
  const names = new Set(g.map((s) => String(s?.name || "").trim()));
  for (const [n, s] of ovByName) {
    if (!names.has(n)) merged.push(s);
  }
  return merged;
}

export function makeSubject(type = "Subject") {
  return {
    name: "",
    description: "",
    type,
    relationship: refDefaultRelationship(type),
    imageFile: "",
    imageB64: "",
    audioFile: "",
    audioB64: "",
    videoFile: "",
    videoB64: "",
    audioRef: "",
    retention: "",
    uid: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    ownerUid: "",
  };
}

// 子主体自动命名：t + 最小空闲号（与 subject.js nextChildName 对齐）
export function nextChildName(subjects, type) {
  const prefix = `t${type.toLowerCase()}`;
  const used = new Set(
    subjects.filter((s) => s.type === type && s.ownerUid).map((s) => (s.name || "").trim().toLowerCase())
  );
  let i = 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}
