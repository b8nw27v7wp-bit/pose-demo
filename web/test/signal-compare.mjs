#!/usr/bin/env node
// signal-compare.mjs — 2D / 3D 信号分布对比（R3 验收工具）
//
// R3 的退出条件不是「改完了」，而是「同一动作正面/侧面分布重合度可量化」，
// 并且要能回答「3D 到底比 2D 好吗」。这个工具就做这一件事：
// 输入两份导出帧（例如正面 / 侧面），按标注动作段截取，逐帧复算信号，
// 输出每套信号在两份素材上的分布，以及**跨素材重合度**（1=完全重合）。
//
// 用法：
//   node web/test/signal-compare.mjs --a eval-data/front.frames.json --b eval-data/side.frames.json
//   node web/test/signal-compare.mjs --a a.jsonl --b b.jsonl --action squat \
//        --labels-a a.labels.json --labels-b b.labels.json --report eval-data/compare.md
//   node web/test/signal-compare.mjs --a ... --b ... --signals knee,uprightness,leg_vertical --json
//
// 注意：重合度高不代表信号正确（两个错误但一致的分布也会重合）。
// 它回答的是「换机位后分布是否漂移」，必须和 recall/precision 一起看。

import { readFile, writeFile } from 'node:fs/promises';
import { SignalEngine } from '../js/signals.js';
import { profileParams } from '../js/params.js';
import { summarize, overlapCoefficient } from '../js/stats.js';
import { loadFrames, loadLabels as readLabels, frameTs } from './frame-io.mjs';

const loadLabels = async (p) => (p ? readLabels(p) : null);

// —— 信号取值表：默认只列 R3 关心的几族，每族都带 2D / 3D 两份 ——
const SIGNALS = {
  knee: (s) => s.knee_pick,
  knee_2d: (s) => s.knee_pick_2d,
  knee_3d: (s) => s.knee_pick_3d,
  elbow: (s) => s.elbow_pick,
  elbow_2d: (s) => s.elbow_pick_2d,
  elbow_3d: (s) => s.elbow_pick_3d,
  uprightness: (s) => s.uprightness,
  uprightness_2d: (s) => s.uprightness_2d,
  uprightness_3d: (s) => s.uprightness_3d,
  leg_vertical: (s) => s.leg_vertical,
  leg_vertical_2d: (s) => s.leg_vertical_2d,
  leg_vertical_3d: (s) => s.leg_vertical_3d,
  reach_L: (s) => s.armPose.reach_L,
  reach_L_2d: (s) => s.armPose.reach_2d_L,
  reach_L_3d: (s) => s.armPose.reach_3d_L,
  reach_R: (s) => s.armPose.reach_R,
  reach_R_2d: (s) => s.armPose.reach_2d_R,
  reach_R_3d: (s) => s.armPose.reach_3d_R,
  hands_close: (s) => s.armPose.hands_close,
  hands_close_2d: (s) => s.armPose.hands_close_2d,
  hands_close_3d: (s) => s.armPose.hands_close_3d,
  elev_L: (s) => s.armPose.elev_L,
  elev_torso_L: (s) => s.armPose.elev_torso_L,
  knee_vel: (s) => s.knee_vel,
  elbow_vel: (s) => s.elbow_vel,
};

const DEFAULT_SIGNALS = [
  'knee', 'knee_2d', 'knee_3d',
  'uprightness', 'uprightness_2d', 'uprightness_3d',
  'leg_vertical', 'leg_vertical_2d', 'leg_vertical_3d',
];

// 2D / 3D 配对（用于输出「换 3D 后跨机位重合度变化」）
const PAIRS = [
  { family: 'knee', a: 'knee_2d', b: 'knee_3d' },
  { family: 'elbow', a: 'elbow_2d', b: 'elbow_3d' },
  { family: 'uprightness', a: 'uprightness_2d', b: 'uprightness_3d' },
  { family: 'leg_vertical', a: 'leg_vertical_2d', b: 'leg_vertical_3d' },
  { family: 'reach_L', a: 'reach_L_2d', b: 'reach_L_3d' },
  { family: 'reach_R', a: 'reach_R_2d', b: 'reach_R_3d' },
  { family: 'hands_close', a: 'hands_close_2d', b: 'hands_close_3d' },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function fmt(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

function fmtStats(s, digits = 2) {
  if (!s.n) return 'n=0';
  return `${fmt(s.mean, digits)}±${fmt(s.sd, digits)} [${fmt(s.p5, digits)}/${fmt(s.p50, digits)}/${fmt(s.p95, digits)}]`;
}

/** 注意：读帧/读 labels 的实现在 frame-io.mjs，与 autolabel 共用 */

/**
 * 把 labels 段换成可比较的区间。
 * 三种时间写法必须分开处理：
 *  - startSec/endSec：视频秒。导出里 ts 是 performance.now（不是从 0 开始），
 *    不能直接乘 1000 去和 ts 比；有 video_time 时按 video_time 比，否则按相对首帧的 ts。
 *  - start/end：毫秒，与 ts 同基准。
 *  - startFrame/endFrame：帧序号。
 */
function buildRanges(labels, action, frames) {
  const ranges = [];
  if (!labels || !action) return ranges;
  const hasVideo = frames.some((f) => Number.isFinite(f.video_time));
  const t0 = frameTs(frames[0]);
  for (const seg of labels) {
    if (seg.action !== action) continue;
    if (Number.isFinite(seg.startSec) && Number.isFinite(seg.endSec)) {
      const lo = seg.startSec * 1000;
      const hi = seg.endSec * 1000;
      ranges.push(hasVideo ? { kind: 'video', lo, hi }
        : (Number.isFinite(t0) ? { kind: 'ts', lo: t0 + lo, hi: t0 + hi } : null));
    } else if (Number.isFinite(seg.start) && Number.isFinite(seg.end)) {
      ranges.push({ kind: 'ts', lo: seg.start, hi: seg.end });
    } else if (Number.isFinite(seg.startFrame) && Number.isFinite(seg.endFrame)) {
      ranges.push({ kind: 'frame', lo: seg.startFrame, hi: seg.endFrame });
    }
  }
  return ranges.filter(Boolean);
}

/**
 * 复算一份素材，按 action（可选）截取信号值。
 * 注意：滤波跨帧保留，所以分段截取只是**取样**，不是从段首重新起算——
 * 与 evaluate.mjs 的 replay 口径一致。
 */
function collect(frames, labels, params, action, warmup) {
  const engine = new SignalEngine(params);
  const values = Object.fromEntries(Object.keys(SIGNALS).map((k) => [k, []]));
  const ranges = buildRanges(labels, action, frames);
  const useLabels = !!(labels && action);
  let seen = 0;
  let kept = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const person = frame.persons && frame.persons[0];
    const ts = frameTs(frame);
    if (!person || !Number.isFinite(ts)) continue;
    const sig = engine.update(person, ts);
    seen++;
    if (seen <= warmup) continue;
    if (useLabels) {
      const inside = ranges.some((r) => {
        if (r.kind === 'frame') return i >= r.lo && i <= r.hi;
        if (r.kind === 'video') {
          return Number.isFinite(frame.video_time)
            && frame.video_time * 1000 >= r.lo && frame.video_time * 1000 <= r.hi;
        }
        return ts >= r.lo && ts <= r.hi;
      });
      if (!inside) continue;
    }
    kept++;
    for (const [k, get] of Object.entries(SIGNALS)) values[k].push(get(sig));
  }
  return { values, kept, seen, ranges: ranges.length, filtered: useLabels };
}

function buildReport({ aPath, bPath, action, A, B, signalNames, pairs }) {
  const lines = [];
  lines.push('# 信号分布对比（2D / 3D）');
  lines.push('');
  lines.push(`- A：\`${aPath}\`（取样帧 ${A.kept}）`);
  lines.push(`- B：\`${bPath}\`（取样帧 ${B.kept}）`);
  if (action) {
    const note = (!A.filtered || !B.filtered) ? '；缺少 labels → 该侧未筛选' : '';
    lines.push(`- 动作筛选：\`${action}\`（A 匹配段 ${A.ranges}，B 匹配段 ${B.ranges}${note}）`);
  }
  lines.push('');
  lines.push('> 重合度 = 直方图重叠系数（1 完全重合，0 完全不重叠）。');
  lines.push('> 它只回答「换机位分布漂不漂」，不回答「信号对不对」，必须和 recall/precision 一起看。');
  lines.push('');
  lines.push('## 逐信号');
  lines.push('');
  lines.push('| 信号 | A n | A 均值±SD [P5/P50/P95] | B n | B 均值±SD [P5/P50/P95] | 重合度 |');
  lines.push('|---|---|---|---|---|---|');
  for (const name of signalNames) {
    const sa = summarize(A.values[name] || []);
    const sb = summarize(B.values[name] || []);
    const ovl = overlapCoefficient(A.values[name] || [], B.values[name] || []);
    lines.push(`| ${name} | ${sa.n} | ${fmtStats(sa)} | ${sb.n} | ${fmtStats(sb)} | ${fmt(ovl, 3)} |`);
  }
  const available = pairs.filter((p) => signalNames.includes(p.a) && signalNames.includes(p.b));
  if (available.length) {
    lines.push('');
    lines.push('## 2D vs 3D：跨素材重合度');
    lines.push('');
    lines.push('差值 > 0 表示 3D 在换机位后分布更一致（更抗视角）；< 0 表示 3D 反而更差。');
    lines.push('');
    lines.push('| 信号族 | 2D 重合度 | 3D 重合度 | 差值（3D−2D） |');
    lines.push('|---|---|---|---|');
    for (const p of available) {
      const ovl2 = overlapCoefficient(A.values[p.a] || [], B.values[p.a] || []);
      const ovl3 = overlapCoefficient(A.values[p.b] || [], B.values[p.b] || []);
      lines.push(`| ${p.family} | ${fmt(ovl2, 3)} | ${fmt(ovl3, 3)} | ${fmt(ovl3 - ovl2, 3)} |`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.a || !args.b) {
    console.error('用法：node web/test/signal-compare.mjs --a A.frames.json --b B.frames.json [--action squat] [--labels-a ..] [--labels-b ..] [--signals knee,uprightness] [--profile ..] [--warmup 15] [--report out.md] [--json]');
    process.exitCode = 1;
    return;
  }
  const signalNames = args.signals
    ? String(args.signals).split(',').map((s) => s.trim()).filter((s) => SIGNALS[s])
    : DEFAULT_SIGNALS;
  if (!signalNames.length) {
    console.error(`没有可识别的信号名。可用：${Object.keys(SIGNALS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const params = args.profile
    ? profileParams(JSON.parse(await readFile(args.profile, 'utf8')))
    : {};
  const warmup = Number.isFinite(Number(args.warmup)) ? Number(args.warmup) : 15;

  const [framesA, framesB, labelsA, labelsB] = await Promise.all([
    loadFrames(args.a),
    loadFrames(args.b),
    loadLabels(args['labels-a']),
    loadLabels(args['labels-b']),
  ]);
  const action = typeof args.action === 'string' ? args.action : null;

  const A = collect(framesA, labelsA, params, action, warmup);
  const B = collect(framesB, labelsB, params, action, warmup);
  const report = buildReport({ aPath: args.a, bPath: args.b, action, A, B, signalNames, pairs: PAIRS });

  if (args.json) {
    const out = {
      a: args.a,
      b: args.b,
      action,
      signals: Object.fromEntries(signalNames.map((name) => [name, {
        a: summarize(A.values[name] || []),
        b: summarize(B.values[name] || []),
        overlap: overlapCoefficient(A.values[name] || [], B.values[name] || []),
      }])),
      pairs: PAIRS.filter((p) => signalNames.includes(p.a) && signalNames.includes(p.b)).map((p) => ({
        family: p.family,
        overlap_2d: overlapCoefficient(A.values[p.a] || [], B.values[p.a] || []),
        overlap_3d: overlapCoefficient(A.values[p.b] || [], B.values[p.b] || []),
      })),
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(report);
  }
  if (args.report) {
    await writeFile(args.report, report, 'utf8');
    console.log(`报告已写入 ${args.report}`);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
