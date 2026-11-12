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

// 13 点顺序（见 kpt.js / signals.js）：nose, shoulder L/R, elbow L/R, wrist L/R, hip L/R, knee L/R, ankle L/R
// 腕是 index 5/6，y=200；躯干长（肩中点→髋中点）= 120，即 scale。
/** 一次鼓掌：两腕从分开（腕距 1.33·scale）合到胸前（0.33·scale）再分开 */
function clapKp(open) {
  const dx = 20 + 60 * open;   // 20px（合）~ 80px（张）→ 腕距 40~160
  return STAND.map((p, i) => (i === 5 || i === 6)
    ? [100 + (i === 5 ? -dx : dx), 200, 1]
    : p);
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

// 2–4s  一次完整鼓掌（张开 0.8s → 停 0.3s → 合拢 0.8s → 停 0.3s）
for (let i = 1; i <= 8; i++) { t += 100; push(clapKp(lerp(0, 1, i / 8))); }
hold(clapKp(1), 300);
for (let i = 7; i >= 0; i--) { t += 100; push(clapKp(lerp(0, 1, i / 8))); }
hold(clapKp(0), 300);
const clapEnd = t;

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
  note: '合成姿态，仅用于验证评估链路。真实阈值必须用实拍素材拟合。鼓掌计数已下线，不再标注。',
  // 鼓掌计数已下线：中间这段合掌动作保留（合成信号仍可用于回归），但不再标注
  segments: [
    { action: 'stand', start: 500, end: standEnd - 100 },
    { action: 'stand', start: clapEnd + 200, end: armStart - 100 },
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
