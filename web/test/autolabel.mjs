#!/usr/bin/env node
// autolabel.mjs — 用当前规则生成**正例草稿** labels（R2 的采集中间步骤）
//
// 目的：把标注从「看视频写秒数」降到「改草稿」。
// 它只生成正例（当前规则判出来的姿态/手臂/计数），**永远不会生成反例**——
// `none` 段必须人工补，否则 precision 永远测不出来（见 docs/data-collection.md）。
//
// 用法：
//   node web/test/autolabel.mjs --input eval-data/a.jsonl
//   node web/test/autolabel.mjs --input a.frames.json --out a.labels.draft.json --merge-ms 500 --min-ms 300
//   node web/test/autolabel.mjs --input a.jsonl --profile web/profiles/fitness.json
//
// 与 R1 的 `evaluate.mjs --autolabel` 口径一致：合并 500ms 内的同动作命中，丢弃 <300ms 的碎片。
// 当前分支尚未合并 R1，所以先做成独立工具，不修改 evaluate.mjs。

import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { replay } from './evaluate.mjs';
import { profileParams } from '../js/params.js';
import { ACTION_CATALOG } from '../js/actions.js';
import { loadFrames } from './frame-io.mjs';

const POSTURES = ACTION_CATALOG.map((a) => a.id);
const ARM_FLAGS = ['armRaised', 'waving', 'crossed', 'onHips', 'armsOpen', 'bothHandsUp', 'handAtHead'];
const REPS = ['squat', 'pushup', 'clap'];

const round3 = (v) => Math.round(v * 1000) / 1000;

/** 布尔序列 → [startTs, endTs] 区间；合并短间隙、丢弃过短片段 */
export function rangesFrom(series, { mergeMs = 500, minMs = 300 } = {}) {
  const raw = [];
  let start = null;
  let last = null;
  for (const s of series) {
    if (s.on) {
      if (start === null) start = s.ts;
      last = s.ts;
    } else if (start !== null) {
      raw.push([start, last]);
      start = null;
      last = null;
    }
  }
  if (start !== null) raw.push([start, last]);
  const merged = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] - prev[1] <= mergeMs) prev[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged.filter(([a, b]) => b - a >= minMs);
}

/**
 * 计数周期：从相位进入 down 到计数 +1 为一次；相邻周期间隔 ≤ mergeMs 合并成一段，
 * 段的 count 是这几次之和（evaluate.mjs 的计数口径就是「段内期望次数」）。
 */
export function repSessions(timeline, action, { mergeMs = 500, minMs = 300 } = {}) {
  const cycles = [];
  let downTs = null;
  let prevCount = 0;
  let prevTs = null;
  for (const r of timeline) {
    const act = r.act;
    const phase = act && act.repPhase ? act.repPhase[action] : null;
    const count = act && act.reps ? act.reps[action] : 0;
    if (phase === 'down' && downTs === null) downTs = r.ts;
    if (count > prevCount) {
      cycles.push([downTs ?? prevTs ?? r.ts, r.ts]);
      prevCount = count;
      downTs = null;
    }
    if (phase !== 'down') downTs = null;
    prevTs = r.ts;
  }
  const sessions = [];
  let cur = null;
  for (const [a, b] of cycles) {
    if (cur && a - cur.end <= mergeMs) {
      cur.end = b;
      cur.count += 1;
    } else {
      if (cur) sessions.push(cur);
      cur = { start: a, end: b, count: 1 };
    }
  }
  if (cur) sessions.push(cur);
  return sessions.filter((s) => s.end - s.start >= minMs);
}

/** 时间基按整份素材统一：有 video_time 用秒，否则用 ts 毫秒 */
function segmentForRange(frames, hasVideo, action, t0, t1, extra = {}) {
  let first = null;
  let last = null;
  for (const f of frames) {
    if (!Number.isFinite(f.ts) || f.ts < t0 || f.ts > t1) continue;
    if (!first) first = f;
    last = f;
  }
  if (!first) return null;
  if (hasVideo && Number.isFinite(first.video_time) && Number.isFinite(last.video_time)
    && last.video_time >= first.video_time) {
    return { action, startSec: round3(first.video_time), endSec: round3(last.video_time), ...extra };
  }
  return { action, start: first.ts, end: last.ts, ...extra };
}

/**
 * 生成草稿 segments。
 * @returns {{segments: Array, timeline: Array}}
 */
export function autolabelFrames(frames, params = {}, { mergeMs = 500, minMs = 300 } = {}) {
  const timeline = replay(frames, params);
  const hasVideo = frames.length > 0 && frames.every((f) => Number.isFinite(f.video_time));
  const segments = [];
  const push = (action, t0, t1, extra) => {
    const seg = segmentForRange(frames, hasVideo, action, t0, t1, extra);
    if (seg) segments.push(seg);
  };

  for (const id of POSTURES) {
    const series = timeline.map((r) => ({
      ts: r.ts,
      on: !r.empty && !!r.act && r.act.postureId === id,
    }));
    for (const [a, b] of rangesFrom(series, { mergeMs, minMs })) push(id, a, b);
  }
  for (const flag of ARM_FLAGS) {
    const series = timeline.map((r) => ({
      ts: r.ts,
      on: !r.empty && !!r.act && !!r.act.flags && !!r.act.flags[flag],
    }));
    for (const [a, b] of rangesFrom(series, { mergeMs, minMs })) push(flag, a, b);
  }
  for (const action of REPS) {
    for (const s of repSessions(timeline, action, { mergeMs, minMs })) {
      push(action, s.start, s.end, { count: s.count });
    }
  }

  segments.sort((x, y) => {
    const a = x.startSec ?? x.start;
    const b = y.startSec ?? y.start;
    return a - b;
  });
  return { segments, timeline };
}

function defaultOutPath(input) {
  if (/\.frames\.(json|jsonl)$/i.test(input)) {
    return input.replace(/\.frames\.(json|jsonl)$/i, '.labels.draft.json');
  }
  if (/\.(json|jsonl)$/i.test(input)) return input.replace(/\.(json|jsonl)$/i, '.labels.draft.json');
  return `${input}.labels.draft.json`;
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('用法：node web/test/autolabel.mjs --input <frames.json|jsonl> [--out <labels.json>] [--profile <profile.json>] [--merge-ms 500] [--min-ms 300] [--json]');
    process.exitCode = 1;
    return;
  }
  const params = args.profile
    ? profileParams(JSON.parse(await readFile(args.profile, 'utf8')))
    : {};
  const mergeMs = Number.isFinite(Number(args['merge-ms'])) ? Number(args['merge-ms']) : 500;
  const minMs = Number.isFinite(Number(args['min-ms'])) ? Number(args['min-ms']) : 300;
  const frames = await loadFrames(args.input);
  if (!frames.length) {
    console.error(`没有读到帧：${args.input}`);
    process.exitCode = 1;
    return;
  }
  const { segments } = autolabelFrames(frames, params, { mergeMs, minMs });
  const draft = {
    name: `${path.basename(args.input).replace(/\.[^.]+$/, '')} 草稿`,
    source: 'web/test/autolabel.mjs（当前规则）',
    note: '自动生成的正例草稿：必须人工补 none / !动作 反例段、核对边界；计数类的 count 要改成实际期望次数。',
    segments,
  };
  const outPath = typeof args.out === 'string' ? args.out : defaultOutPath(args.input);

  if (args.json) {
    console.log(JSON.stringify(draft, null, 2));
  } else {
    // 草稿可以随时重生成；人工标注过的 *.labels.json 绝不能悄悄覆盖
    const exists = await access(outPath).then(() => true, () => false);
    if (!args.force && exists && !/\.draft\.json$/i.test(outPath)) {
      console.error(`拒绝覆盖非草稿文件：${outPath}`);
      console.error('换个 --out，或确认要覆盖时加 --force。');
      process.exitCode = 1;
      return;
    }
    const counts = {};
    for (const s of segments) counts[s.action] = (counts[s.action] || 0) + (s.count || 1);
    console.log(`帧数 ${frames.length}，草稿段 ${segments.length}`);
    console.log(Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  ') || '（没有判出任何正例）');
    await writeFile(outPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
    console.log(`已写入 ${outPath}`);
    console.log('下一步：补 none / !动作 反例段，按 docs/data-collection.md 填 manifest，再跑 evaluate.mjs');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
