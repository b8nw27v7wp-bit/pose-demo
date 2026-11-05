// draw.js — 骨架绘制。按置信度分三档着色，不做花哨效果。

import { POSE_CONNECTIONS, HAND_CONNECTIONS } from './kpt.js';

const COLORS = {
  high: '#2f8f5b',
  mid: '#b07d18',
  low: '#b23b2e',
  joint: '#1d1d1f',
  jointLow: '#c7c7cc',
  hand: '#e8e8ed',
};

function tone(vis) {
  if (vis >= 0.7) return COLORS.high;
  if (vis >= 0.4) return COLORS.mid;
  return COLORS.low;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} kp33 MediaPipe 33 点（归一化坐标 + visibility）
 * @param {number} w 画布宽（像素）
 * @param {number} h 画布高
 * @param {{points?: boolean, clear?: boolean, alpha?: number}} opts
 *        points=false 只画连线；clear=false 时叠加绘制（多人场景用）；alpha 控制整条骨架透明度
 */
export function drawSkeleton(ctx, kp33, w, h, { points = true, clear = true, alpha = 1 } = {}) {
  if (!kp33) return;

  if (clear) ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';

  for (const [a, b] of POSE_CONNECTIONS) {
    const pa = kp33[a], pb = kp33[b];
    if (!pa || !pb) continue;
    const vis = Math.min(pa.visibility ?? 0, pb.visibility ?? 0);
    if (vis < 0.2) continue;

    ctx.strokeStyle = tone(vis);
    ctx.globalAlpha = (vis >= 0.7 ? 0.95 : 0.55) * alpha;
    ctx.lineWidth = vis >= 0.7 ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(pa.x * w, pa.y * h);
    ctx.lineTo(pb.x * w, pb.y * h);
    ctx.stroke();
  }

  ctx.globalAlpha = alpha;
  if (!points) { ctx.globalAlpha = 1; return; }
  for (let i = 0; i < kp33.length; i++) {
    const p = kp33[i];
    if (!p || (p.visibility ?? 0) < 0.2) continue;
    const good = (p.visibility ?? 0) >= 0.7;
    ctx.fillStyle = good ? COLORS.joint : COLORS.jointLow;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, good ? 3 : 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function clearCanvas(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
}

/**
 * 画物体检测框（像素坐标，与 person.bbox 同口径）。
 * 工程风：细线 + 左上角小标签，不用彩色填充（多人多框时会糊住画面）。
 */
export function drawBoxes(ctx, items, { color = '#1d1d1f', alpha = 0.75, showLabel = true } = {}) {
  if (!Array.isArray(items) || !items.length) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'top';
  for (const it of items) {
    const b = it.box;
    if (!Array.isArray(b) || b.length !== 4) continue;
    ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
    if (!showLabel) continue;
    const text = `${it.label || `#${it.category ?? '?'}`} ${Math.round((it.score ?? 0) * 100)}%`;
    const tw = ctx.measureText(text).width;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#fff';
    ctx.fillRect(b[0], Math.max(0, b[1] - 16), tw + 8, 16);
    ctx.fillStyle = color;
    ctx.fillText(text, b[0] + 4, Math.max(0, b[1] - 15));
    ctx.globalAlpha = alpha;
  }
  ctx.restore();
}

/** 在框外上方写一个短标签（track_id + 姿态），多人时用来区分"哪条数据是谁的" */
export function drawTrackLabel(ctx, x, y, text, { color = '#1d1d1f', bg = 'rgba(255,255,255,0.88)' } = {}) {
  if (!text) return;
  ctx.save();
  ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'top';
  const tw = ctx.measureText(text).width;
  const ty = Math.max(0, y - 18);
  ctx.fillStyle = bg;
  ctx.fillRect(x, ty, tw + 10, 18);
  ctx.fillStyle = color;
  ctx.fillText(text, x + 5, ty + 3);
  ctx.restore();
}

/**
 * 画手部 21 点（叠加在骨架之上，用中性蓝灰区分身体）
 * @param {number[][]} kp21 像素坐标 [x, y, z]
 */
export function drawHand(ctx, kp21, w, h, { alpha = 1 } = {}) {
  if (!kp21 || kp21.length < 21) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = COLORS.hand;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(kp21[a][0], kp21[a][1]);
    ctx.lineTo(kp21[b][0], kp21[b][1]);
    ctx.stroke();
  }
  ctx.fillStyle = COLORS.hand;
  for (const p of kp21) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
