// signal-compare-test.mjs — 动作筛选段匹配的确定性单测
// 运行：node web/test/signal-compare-test.mjs

import { buildRanges } from './signal-compare.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const frames = [];

console.log('\n[1] 正例段匹配');
{
  const labels = [
    { action: 'stand', start: 0, end: 1000 },
    { action: 'arm_raised', start: 2000, end: 3000 },
  ];
  check('id 写法直接匹配', buildRanges(labels, 'stand', frames).length === 1);
  // labels 写注册表 id、命令行写 flag（或反过来）必须等价，否则一个都匹配不上。
  const byId = buildRanges(labels, 'arm_raised', frames);
  const byFlag = buildRanges(labels, 'armRaised', frames);
  check('arm_raised 与 armRaised 等价（按 id 查）', byId.length === 1, JSON.stringify(byId));
  check('arm_raised 与 armRaised 等价（按 flag 查）', byFlag.length === 1, JSON.stringify(byFlag));
}

console.log('\n[2] 反例窗口不是正例采样');
{
  const labels = [
    { action: '!armRaised', start: 0, end: 1000 },
    { action: 'armRaised', start: 2000, end: 3000, expect: false },
    { action: 'none', start: 4000, end: 5000 },
  ];
  for (const a of ['armRaised', 'arm_raised']) {
    check(`反例段不进 ${a} 的取样区间`, buildRanges(labels, a, frames).length === 0,
      JSON.stringify(buildRanges(labels, a, frames)));
  }
}

console.log('\n[3] 三种时间写法');
{
  const labels = [
    { action: 'stand', start: 100, end: 200 },
    { action: 'stand', startSec: 1, endSec: 2 },
    { action: 'stand', startFrame: 10, endFrame: 20 },
  ];
  const r = buildRanges(labels, 'stand', frames);
  // 没有 video_time 且首帧没有 ts：startSec 那段无法映射 → 丢弃，其余两段保留。
  check('毫秒与帧序号段都保留', r.length === 2, JSON.stringify(r));
  check('帧序号段 kind=frame', r.some((x) => x.kind === 'frame' && x.lo === 10 && x.hi === 20));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
