// hardcase-test.mjs — 难例导出（R6）的纯逻辑单测
// 运行：node web/test/hardcase-test.mjs
//
// 验证窗口边界、label 时间基（video_time vs ts）、meta 与非法动作。
// 不验证浏览器下载——那条链路复用「导出 JSON」的 Blob 代码，由无头冒烟覆盖接线。

import {
  extractWindow, buildHardcase, segmentFor, isValidHardcaseAction,
  HARDCASE_BEFORE_MS, HARDCASE_AFTER_MS,
} from '../js/hardcase.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const frameAt = (ts, videoTime = null) => ({
  ts, video_time: videoTime, persons: [], signals: null, actions: null,
});

// —— 1. 窗口边界 ——
console.log('\n[1] extractWindow');
{
  const frames = Array.from({ length: 11 }, (_, i) => frameAt(i * 1000));
  const win = extractWindow(frames, 5000);
  check('前后默认 3000/2000', HARDCASE_BEFORE_MS === 3000 && HARDCASE_AFTER_MS === 2000);
  check('闭区间包含两端', win.length === 6 && win[0].ts === 2000 && win[5].ts === 7000,
    `n=${win.length} [${win[0]?.ts}, ${win[win.length - 1]?.ts}]`);
  check('窗口外的帧不进来', !win.some((f) => f.ts === 1000 || f.ts === 8000));
  check('非法 clickTs 返回空', extractWindow(frames, NaN).length === 0);
  check('空帧列表不崩', extractWindow([], 1000).length === 0);
}

// —— 2. 视频文件：label 用 video_time ——
console.log('\n[2] video_time 时间基');
{
  const frames = Array.from({ length: 11 }, (_, i) => frameAt(i * 1000, i));
  const r = buildHardcase(frames, 5000, { action: 'squat', now: 123 });
  check('帧数正确', r.frames.length === 6 && r.meta.frame_count === 6);
  check('label 起点/终点取实际帧的秒数', r.labels.segments[0].startSec === 2
    && r.labels.segments[0].endSec === 7,
  JSON.stringify(r.labels.segments[0]));
  check('label 动作原样保留', r.labels.segments[0].action === 'squat');
  check('meta 带 hardcase 记录', r.meta.hardcase.action === 'squat'
    && r.meta.hardcase.before_ms === 3000 && r.meta.hardcase.after_ms === 2000);
  check('name 可追溯到点击', r.labels.name === 'hardcase-123');
}

// —— 3. 摄像头：label 用 ts 毫秒 ——
console.log('\n[3] ts 时间基');
{
  const frames = Array.from({ length: 11 }, (_, i) => frameAt(i * 1000, null));
  const r = buildHardcase(frames, 5000, { action: 'none' });
  const seg = r.labels.segments[0];
  check('用 start/end 毫秒', seg.start === 2000 && seg.end === 7000 && seg.startSec === undefined,
    JSON.stringify(seg));
  check('none 是合法动作', isValidHardcaseAction('none'));
}

// —— 4. 决策与非法输入 ——
console.log('\n[4] 校验');
{
  const frames = [frameAt(0, 0), frameAt(1000, 1)];
  const det = { posture: 'stand', reps: { squat: 0, pushup: 0, clap: 0 } };
  const r = buildHardcase(frames, 500, { action: 'stand', detected: det });
  check('detected 进 meta', r.meta.hardcase.detected.posture === 'stand');
  check('detected 进 note', r.labels.note.includes('stand'));
  check('未知动作抛错', (() => {
    try { buildHardcase(frames, 500, { action: 'not_an_action' }); return false; } catch { return true; }
  })());
  const empty = buildHardcase(frames, 100000, { action: 'squat' });
  check('空窗口 → 0 帧、无 label 段', empty.frames.length === 0 && empty.labels.segments.length === 0);
  check('segmentFor 空数组返回 null', segmentFor([], 'squat') === null);

  // 视频循环：video_time 回绕（2.9 → 0.1）时不能用秒数标
  const looped = [frameAt(0, 2.9), frameAt(33, 3.0), frameAt(66, 0.1)];
  const seg = segmentFor(looped, 'squat');
  check('video_time 回绕 → 退回 ts 毫秒', seg.start === 0 && seg.end === 66 && seg.startSec === undefined,
    JSON.stringify(seg));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
