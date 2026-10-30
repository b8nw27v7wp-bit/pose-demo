// hardcase-test.mjs — 难例导出（R6）的纯逻辑单测
// 运行：node web/test/hardcase-test.mjs
//
// 验证窗口边界、label 时间基（video_time vs ts）、meta、非法动作与反例语法（!动作 / noArm）。
// 不验证浏览器下载——那条链路复用「导出 JSON」的 Blob 代码，由无头冒烟覆盖接线。

import {
  extractWindow, buildHardcase, segmentFor, isValidHardcaseAction, HARDCASE_ACTIONS,
  HARDCASE_BEFORE_MS, HARDCASE_AFTER_MS,
} from '../js/hardcase.js';
import { ARM_ACTIONS, REP_ACTIONS, ACTION_CATALOG } from '../js/actions.js';

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
  // 下拉项必须覆盖注册表：§12.7 新增的 5 个手臂动作与 grasp 曾在 hardcase 里漏掉，
  // 判错了也存不下来。
  const values = new Set(HARDCASE_ACTIONS.map((a) => a.value));
  check('难例下拉包含每个姿态',
    ACTION_CATALOG.every((a) => values.has(a.id)),
    `missing=${ACTION_CATALOG.map((a) => a.id).filter((id) => !values.has(id))}`);
  check('难例下拉包含每个手臂动作',
    ARM_ACTIONS.every((a) => values.has(a.flag)),
    `missing=${ARM_ACTIONS.map((a) => a.flag).filter((f) => !values.has(f))}`);
  check('难例下拉包含每个计数动作',
    REP_ACTIONS.every((r) => values.has(r.id)),
    `missing=${REP_ACTIONS.map((r) => r.id).filter((id) => !values.has(id))}`);

  // P1-4：反例必须覆盖全部动作，否则「模型误判 X、其实没有 X」仍然写不出来。
  // 同一个动作的正例和反例都要在列表里，两者缺一都不算覆盖。
  const missingNeg = [
    ...ACTION_CATALOG.map((a) => a.id),
    ...ARM_ACTIONS.map((a) => a.flag),
    ...REP_ACTIONS.map((r) => r.id),
  ].filter((v) => !values.has(`!${v}`));
  check('每个姿态/手臂/计数动作都有 ! 反例', missingNeg.length === 0,
    `missing=${missingNeg}`);
  check('每个反例都有对应的正例',
    [...values].filter((v) => v.startsWith('!')).every((v) => values.has(v.slice(1))));
  check('反例项都有「不应出现」标签',
    HARDCASE_ACTIONS.filter((a) => a.value.startsWith('!'))
      .every((a) => a.label.startsWith('不应出现')),
    HARDCASE_ACTIONS.filter((a) => a.value.startsWith('!') && !a.label.startsWith('不应出现'))
      .map((a) => a.value).join(','));
  check('none 与 noArm 都在反例里',
    values.has('none') && values.has('noArm')
    && HARDCASE_ACTIONS.find((a) => a.value === 'none').group === '反例'
    && HARDCASE_ACTIONS.find((a) => a.value === 'noArm').group === '反例');
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

  // P1-4：反例语法与 evaluate.mjs 的 parseSegment 对齐。
  check('!onHips 合法', isValidHardcaseAction('!onHips'));
  check('!姿态 也合法', isValidHardcaseAction('!stand'));
  check('!计数 也合法', isValidHardcaseAction('!squat'));
  check('noArm 合法', isValidHardcaseAction('noArm'));
  check('!nope 非法', !isValidHardcaseAction('!nope'));
  check('!none 非法', !isValidHardcaseAction('!none'));
  check('!noArm 非法', !isValidHardcaseAction('!noArm'));
  check('!!onHips 非法', !isValidHardcaseAction('!!onHips'));
  check('空串非法', !isValidHardcaseAction(''));
  check('非字符串非法', !isValidHardcaseAction(null) && !isValidHardcaseAction(undefined));
  const empty = buildHardcase(frames, 100000, { action: 'squat' });
  check('空窗口 → 0 帧、无 label 段', empty.frames.length === 0 && empty.labels.segments.length === 0);
  check('segmentFor 空数组返回 null', segmentFor([], 'squat') === null);

  // 视频循环：video_time 回绕（2.9 → 0.1）时不能用秒数标
  const looped = [frameAt(0, 2.9), frameAt(33, 3.0), frameAt(66, 0.1)];
  const seg = segmentFor(looped, 'squat');
  check('video_time 回绕 → 退回 ts 毫秒', seg.start === 0 && seg.end === 66 && seg.startSec === undefined,
    JSON.stringify(seg));
}

// —— 5. 反例导出：action 原样写进 segment 与 meta ——
console.log('\n[5] 反例导出');
{
  const frames = Array.from({ length: 11 }, (_, i) => frameAt(i * 1000, i));
  const r = buildHardcase(frames, 5000, { action: '!onHips', now: 7 });
  check('!onHips 进 segment 且原样保留',
    r.labels.segments[0]?.action === '!onHips',
    JSON.stringify(r.labels.segments[0]));
  check('!onHips 进 meta', r.meta.hardcase.action === '!onHips');
  check('反例仍按正常窗口导出帧', r.frames.length === 6 && r.meta.frame_count === 6);

  const n = buildHardcase(frames, 5000, { action: 'noArm' });
  check('noArm 进 segment', n.labels.segments[0]?.action === 'noArm',
    JSON.stringify(n.labels.segments[0]));
  check('noArm 进 meta', n.meta.hardcase.action === 'noArm');

  // 反例不该被改写成 expect:false 对象：评估器认字符串写法，保持单一表示。
  check('反例段没有额外 expect 字段', r.labels.segments[0].expect === undefined);
}

// —— 6. 视频已结束：窗口锚到最后记录帧，note 要说清楚 ——
console.log('\n[6] 尾部锚点');
{
  const frames = Array.from({ length: 11 }, (_, i) => frameAt(i * 1000, i));
  // 点击时刻远在最后一帧之后（page 端的 hardcaseAnchorTs 会把锚点换成 last.ts，
  // 原始点击时刻通过 anchoredFrom 传进来）。不写清楚会被读成「点击那一刻的 3 秒」。
  const tail = buildHardcase(frames, 10000, {
    action: '!onHips', anchoredFrom: 13000, ended: true,
  });
  check('视频已结束时尾部锚点写进 note',
    /视频已结束/.test(tail.labels.note) && /实际点击 13000ms/.test(tail.labels.note),
    tail.labels.note);
  // 暂停 / 后台标签页停推理也会锚到尾部，但媒体没有播完，不能写「视频已结束」
  const paused = buildHardcase(frames, 10000, {
    action: '!onHips', anchoredFrom: 13000, ended: false,
  });
  check('只是停止出帧时不写「视频已结束」',
    !/视频已结束/.test(paused.labels.note) && /实际点击 13000ms/.test(paused.labels.note),
    paused.labels.note);
  check('暂停时仍说明窗口锚到最后记录帧', /窗口锚到最后记录帧/.test(paused.labels.note),
    paused.labels.note);
  check('尾部锚点仍导出窗口内的帧', tail.frames.length > 0, `frames=${tail.frames.length}`);
  const plain = buildHardcase(frames, 5000, { action: 'squat' });
  check('普通点击不写尾部提示', !/视频已结束/.test(plain.labels.note), plain.labels.note);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
