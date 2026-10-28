#!/usr/bin/env node
// make-sample.mjs — 生成一份「合成样例素材 + 标注」，用于演示和端到端自检评估工具
// 运行：node web/test/make-sample.mjs
// 产出：eval-data/sample.frames.json、eval-data/sample.labels.json
//
// 这是**合成数据**，不是实拍。它的用途只有两个：
//   1. 让 `node web/test/evaluate.mjs --dir eval-data` 在没有实拍素材时也能跑通
//   2. 当作 labels 文件写法的活样例（见 docs/eval.md）

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'eval-data');

const STAND = [
  [100, 50, 1],
  [90, 100, 1], [110, 100, 1],
  [85, 150, 1], [115, 150, 1],
  [80, 200, 1], [120, 200, 1],
  [92, 220, 1], [108, 220, 1],
  [90, 300, 1], [110, 300, 1],
  [88, 380, 1], [112, 380, 1],
];

function squatKp(t) {
  const hipY = 220 + 40 * t;
  const kneeX = 100 + 70 * t;
  const kneeY = 300 + 30 * t;
  return [
    [100, 50 + 40 * t, 1],
    [90, hipY - 120, 1], [110, hipY - 120, 1],
    [85, 150 + 40 * t, 1], [115, 150 + 40 * t, 1],
    [80, 200 + 40 * t, 1], [120, 200 + 40 * t, 1],
    [92, hipY, 1], [108, hipY, 1],
    [kneeX - 10, kneeY, 1], [kneeX + 10, kneeY, 1],
    [88, 380, 1], [112, 380, 1],
  ];
}

/** 一次开合跳式的举手：腕从髋抬到头顶再放下 */
function armKp(raise) {
  return STAND.map((p, i) => (i === 5 || i === 6)
    ? [p[0], p[1] - 180 * raise, 1]
    : p);
}

function lerp(a, b, t) { return a + (b - a) * t; }

const frames = [];
let t = 0;
const push = (kp) => {
  const xs = kp.map((p) => p[0]);
  const ys = kp.map((p) => p[1]);
  frames.push({
    ts: Math.round(t),
    person_count: 1,
    persons: [{
      track_id: 0,
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v * 10) / 10),
      kp_format: 'mediapipe33',
      kp: kp.map(([x, y, v]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10, v]),
      scale: 127,
      score: 0.94,
    }],
    signals: null,
    actions: null,
  });
};
const hold = (kp, ms) => { for (let i = 0; i < ms / 100; i++) { t += 100; push(kp); } };

// 0–2s  站立
hold(STAND, 2000);
const standEnd = t;

// 2–4s  一次完整深蹲（下 0.8s → 停 0.4s → 上 0.8s）
const squatStart = t;
for (let i = 1; i <= 8; i++) { t += 100; push(squatKp(lerp(0, 1, i / 8))); }
hold(squatKp(1), 400);
for (let i = 7; i >= 0; i--) { t += 100; push(squatKp(lerp(0, 1, i / 8))); }
const squatEnd = t;

// 4–5s  站立
hold(STAND, 1000);

// 5–7s  举手保持
const armStart = t;
for (let i = 1; i <= 5; i++) { t += 100; push(armKp(lerp(0, 1, i / 5))); }
hold(armKp(1), 1200);
const armEnd = t;
for (let i = 4; i >= 0; i--) { t += 100; push(armKp(lerp(0, 1, i / 5))); }

// 7–8s  站立
hold(STAND, 1000);

const labels = {
  name: 'sample（合成数据，非实拍）',
  source: 'web/test/make-sample.mjs',
  note: '合成姿态，仅用于验证评估链路。真实阈值必须用实拍素材拟合。',
  segments: [
    { action: 'stand', start: 500, end: standEnd - 100 },
    { action: 'squat', start: squatStart, end: squatEnd, count: 1, tol: 0 },
    { action: 'stand', start: squatEnd + 200, end: armStart - 100 },
    { action: 'armRaised', start: armStart + 400, end: armEnd },
  ],
};

await mkdir(OUT, { recursive: true });
const framesPath = path.join(OUT, 'sample.frames.json');
const labelsPath = path.join(OUT, 'sample.labels.json');
await writeFile(framesPath, JSON.stringify({
  exported_at: new Date().toISOString(),
  schema: 'frame.jsonl v0',
  kp_format: 'mediapipe33',
  frame_count: frames.length,
  frames,
}), 'utf8');
await writeFile(labelsPath, JSON.stringify(labels, null, 2), 'utf8');

console.log(`已写入 ${framesPath}（${frames.length} 帧 / ${(t / 1000).toFixed(1)}s）`);
console.log(`已写入 ${labelsPath}（${labels.segments.length} 段标注）`);
