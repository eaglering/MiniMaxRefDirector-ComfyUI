// ===== 媒体与时间工具 =====

export const genId = () => Date.now().toString() + Math.random().toString(36).substr(2, 5);
export const genUid = genId;

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// 帧长 → 时长秒（按帧率）
export function framesToSeconds(frames, frameRate) {
  return Math.round(((frames || 0) / (frameRate || 24)) * 100) / 100;
}

export function secondsToFrames(seconds, frameRate) {
  return Math.max(1, Math.round((seconds || 0) * (frameRate || 24)));
}

export function formatDuration(frames, frameRate) {
  const s = framesToSeconds(frames, frameRate);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m > 0 ? `${m}m${r.toFixed(1)}s` : `${r.toFixed(1)}s`;
}

export function formatTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 文件大小格式化
export function formatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
