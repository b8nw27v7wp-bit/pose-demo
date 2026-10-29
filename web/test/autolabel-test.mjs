// autolabel-test.mjs — R2 草稿标注工具的单测
// 运行：node web/test/autolabel-test.mjs
//
// 验证：区间合并/丢弃、计数周期合并、真实样例上的草稿内容，
// 以及「草稿自评全通过」——同一套规则生成的草稿，评估器必须判它全对。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rangesFrom, repSessions, autolabelFrames } from './autolabel.mjs';
import { replay, evaluateClip } from './evaluate.mjs';
import { loadFrames } from './frame-io.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// —— 1. 区间合并与丢弃 ——
console.log('\n[1] rangesFrom');
{
  const series = [
    { ts: 0, on: true }, { ts: 100, on: true },
    { ts: 200, on: false },
    { ts: 300, on: true }, { ts: 400, on: true },
    { ts: 500, on: false },
    { ts: 2000, on: true }, { ts: 2100, on: false },
  ];
  const merged = rangesFrom(series, { mergeMs: 500, minMs: 300 });
  check('≤mergeMs 的间隙合并', merged.length === 1 && merged[0][0] === 0 && merged[0][1] === 400,
    JSON.stringify(merged));
  const short = rangesFrom([{ ts: 0, on: true }, { ts: 100, on: false }], { mergeMs: 500, minMs: 300 });
  check('短于 minMs 的片段丢弃', short.length === 0);
  const kept = rangesFrom([
    { ts: 0, on: true }, { ts: 200, on: true }, { ts: 400, on: true }, { ts: 500, on: false },
  ], { mergeMs: 500, minMs: 300 });
  check('达到 minMs 的片段保留', kept.length === 1 && kept[0][1] === 400, JSON.stringify(kept));
  check('从未成立 → 空', rangesFrom([{ ts: 0, on: false }]).length === 0);
}

// —— 2. 计数周期 ——
console.log('\n[2] repSessions');
{
  const timeline = [
    { ts: 0, act: { repPhase: { squat: 'down' }, reps: { squat: 0 } } },
    { ts: 500, act: { repPhase: { squat: 'down' }, reps: { squat: 0 } } },
    { ts: 1000, act: { repPhase: { squat: 'up' }, reps: { squat: 1 } } },
    { ts: 2000, act: { repPhase: { squat: 'down' }, reps: { squat: 1 } } },
    { ts: 3000, act: { repPhase: { squat: 'up' }, reps: { squat: 2 } } },
  ];
  const split = repSessions(timeline, 'squat', { mergeMs: 500, minMs: 300 });
  check('两次间隔大于 mergeMs → 两段', split.length === 2
    && split[0].count === 1 && split[1].count === 1, JSON.stringify(split));
  const merged = repSessions(timeline, 'squat', { mergeMs: 1500, minMs: 300 });
  check('放宽 mergeMs → 合成一段，count 累加', merged.length === 1 && merged[0].count === 2,
    JSON.stringify(merged));
  const noReps = repSessions([{ ts: 0, act: null }], 'squat');
  check('没有计数 → 空', Array.isArray(noReps) && noReps.length === 0);
}

// —— 3. 合成样例上的草稿 ——
console.log('\n[3] sample.frames.json');
{
  const frames = await loadFrames(path.join(ROOT, 'eval-data/sample.frames.json'));
  const { segments, timeline } = autolabelFrames(frames, {});
  const by = (a) => segments.filter((s) => s.action === a);
  check('产出正例段', segments.length > 0, `n=${segments.length}`);
  check('含 stand', by('stand').length >= 1);
  check('含 squat 且 count ≥1', by('squat').length === 1 && by('squat')[0].count === 1);
  check('含 armRaised', by('armRaised').length >= 1);
  check('绝不生成 none', by('none').length === 0);
  check('时间基为 ts 毫秒（样例无 video_time）',
    segments.every((s) => Number.isFinite(s.start) && Number.isFinite(s.end)), JSON.stringify(segments[0]));
  // 草稿自评：同一套规则 → 必须全通过
  const labels = { name: 'draft', segments };
  const evalTimeline = replay(frames, {});
  const res = evaluateClip(frames, labels, evalTimeline);
  const bad = res.segments.filter((s) => !s.pass);
  check('草稿自评全通过', bad.length === 0, bad.length ? JSON.stringify(bad.slice(0, 3)) : `${res.segments.length} 段`);
  check('timeline 与帧数一致', timeline.length === frames.length);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
