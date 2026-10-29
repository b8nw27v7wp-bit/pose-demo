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
