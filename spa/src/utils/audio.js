// ===== 音轨工具：波形提取 / m:ss 格式化 / 裁剪区间播放 =====
// 波形与历史节点 js/components/director/media.js _extractAudioOnClient 同算法：
// decodeAudioData 后对 channelData 逐段取绝对值最大值，共 200 个 0~1 峰值。
import { viewUrl } from "../api/client.js";

const PEAK_COUNT = 200;

// 懒创建 AudioContext（浏览器要求用户手势后才能出声；decode 不受限制）
let audioCtx = null;
function getCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

// AudioBuffer 缓存（key = 音频 URL）：避免切换 Tab / 重复播放反复解码
const bufferCache = new Map();

function fetchBuffer(url) {
  if (!bufferCache.has(url)) {
    const p = (async () => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`音频加载失败 (HTTP ${resp.status})`);
      const arr = await resp.arrayBuffer();
      return await getCtx().decodeAudioData(arr);
    })().catch((e) => {
      bufferCache.delete(url);
      throw e;
    });
    bufferCache.set(url, p);
  }
  return bufferCache.get(url);
}

// 项 → 音频 URL：优先服务端文件 key（audioFile），否则本地 blob（刚上传未回填时）
export function audioUrlOf(seg) {
  if (seg.audioFile) return viewUrl(seg.audioFile);
  if (seg._blobUrl) return seg._blobUrl;
  return "";
}

export function getSegmentBuffer(seg) {
  const url = audioUrlOf(seg);
  if (!url) return Promise.reject(new Error("音频尚未就绪"));
  return fetchBuffer(url);
}

// 从本地 File 提取（解码结果 + 峰值）：上传后立即出波形，无需等服务端
export async function decodeFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await getCtx().decodeAudioData(arrayBuffer);
  return { audioBuffer, peaks: extractPeaks(audioBuffer) };
}

export function extractPeaks(audioBuffer) {
  const channelData = audioBuffer.getChannelData(0);
  const peaks = [];
  const step = Math.floor(channelData.length / PEAK_COUNT) || 1;
  for (let i = 0; i < PEAK_COUNT; i++) {
    let max = 0;
    const base = i * step;
    for (let j = 0; j < step; j++) {
      const val = Math.abs(channelData[base + j] || 0);
      if (val > max) max = val;
    }
    peaks.push(max);
  }
  // 归一化：不同响度的音频都能撑满波形高度（0 峰值留 0）
  const top = Math.max(...peaks);
  if (top > 0) for (let i = 0; i < peaks.length; i++) peaks[i] = peaks[i] / top;
  return peaks;
}

// ---- 帧语义（与历史节点一致：start/length/trimStart/audioDurationFrames 均为帧）----
// 有效波形 = 源 peaks 按 [trimStart, trimStart+length] / audioDurationFrames 比例切片
export function slicePeaks(peaks, trimStart, length, total) {
  if (!Array.isArray(peaks) || !peaks.length) return [];
  if (!total || total <= 0) return peaks;
  const from = Math.max(0, Math.min(1, (trimStart || 0) / total));
  const to = Math.max(from, Math.min(1, ((trimStart || 0) + (length || 0)) / total));
  const i0 = Math.floor(from * peaks.length);
  const i1 = Math.max(i0 + 1, Math.round(to * peaks.length));
  return peaks.slice(i0, i1);
}

// canvas 波形绘制（竖条，dpr 适配；供音轨卡片与切割对话框共用）
export function drawWaveform(canvas, peaks, color = "#a78bfa", base = 0.22) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!peaks || !peaks.length) {
    ctx.fillStyle = "rgba(169,177,195,0.25)";
    ctx.fillRect(0, h / 2 - 1, w, 2);
    return;
  }
  const n = peaks.length;
  const gap = 1;
  const barW = Math.max(1, (w - gap * (n - 1)) / n);
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const v = Math.max(0.03, Math.min(1, peaks[i]));
    const bh = Math.max(2, v * (h - 4));
    const x = i * (barW + gap);
    const y = (h - bh) / 2;
    ctx.globalAlpha = base + (1 - base) * v;
    ctx.fillRect(x, y, barW, bh);
  }
  ctx.globalAlpha = 1;
}

// ---- 播放：只播裁剪区间 [trimStart, trimStart+length] → 秒 ----
let activeSource = null;
let activeOnEnd = null;

export function stopSegmentPlayback() {
  if (activeSource) {
    try { activeSource.onended = null; activeSource.stop(); } catch { /* ignore */ }
    activeSource.disconnect();
    activeSource = null;
  }
  const cb = activeOnEnd;
  activeOnEnd = null;
  if (cb) cb();
}

// 返回 Promise<void>：播放完成（或被新播放打断）后 resolve
export async function playSegment(seg, frameRate) {
  stopSegmentPlayback();
  const buffer = await getSegmentBuffer(seg);
  // 等待期间可能已被新的播放请求抢占
  if (activeSource) return;
  const ctx = getCtx();
  if (ctx.state === "suspended") await ctx.resume();
  const fps = frameRate || 24;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const offset = (seg.trimStart || 0) / fps;
  const duration = Math.max(0.05, (seg.length || 0) / fps);
  return new Promise((resolve) => {
    activeOnEnd = resolve;
    source.onended = () => {
      if (activeSource === source) {
        activeSource = null;
        activeOnEnd = null;
        resolve();
      }
    };
    source.start(0, offset, duration);
    activeSource = source;
  });
}

// ---- m:ss 格式化（分:秒，秒取整）----
export function formatMinSec(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
