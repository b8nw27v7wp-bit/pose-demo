// frame-io.mjs — 评估工具的共用输入（Node 专用）
// 兼容三种导出格式：{frames:[...]}、裸数组、JSONL（首行 meta）。

import { readFile } from 'node:fs/promises';

export async function loadFrames(path) {
  const text = await readFile(path, 'utf8');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (Array.isArray(obj)) return obj;
      if (Array.isArray(obj.frames)) return obj.frames;
    } catch {
      // 首行是 meta 的 JSONL：整份不是合法 JSON → 往下按行解析
    }
  }
  const frames = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try { rec = JSON.parse(s); } catch { continue; }
    if (Array.isArray(rec)) frames.push(...rec);
    else if (rec && Array.isArray(rec.frames)) frames.push(...rec.frames);
    else if (rec && typeof rec.ts === 'number') frames.push(rec);
  }
  return frames;
}

export async function loadLabels(path) {
  const obj = JSON.parse(await readFile(path, 'utf8'));
  return Array.isArray(obj) ? obj : (obj.segments || []);
}

/** 一帧的时间（毫秒）：优先 ts；video_time 是秒，转成毫秒补偿 */
export function frameTs(frame) {
  if (Number.isFinite(frame.ts)) return frame.ts;
  if (Number.isFinite(frame.video_time)) return frame.video_time * 1000;
  return NaN;
}

/**
 * 帧序列里的 video_time 是否单调递增（整份导出是否只有一次视频播放）。
 *
 * 页面默认循环播放上传的视频，frameLog 会把多次循环写进同一份导出：
 * video_time 每圈从 0 重来，而 ts 一直单调。这时「第 3 秒」在导出里有多个候选帧，
 * 用 startSec/endSec 标注会静默落到第一次循环——评估结果看着正常，实际评错了区间。
 * 各工具共用这个判定：非单调时必须退回 ts（start/end）或拒绝秒数标注。
 *
 * 规则：忽略 null / 非数值；只要出现后一帧 video_time < 前一帧就返回 false。
 * 没有任何 video_time 时返回 true（不适用，按 ts 处理）。
 */
export function videoTimeMonotonic(frames) {
  let prev = null;
  for (const f of frames || []) {
    const v = f && f.video_time;
    if (!Number.isFinite(v)) continue;
    if (prev !== null && v < prev) return false;
    prev = v;
  }
  return true;
}
