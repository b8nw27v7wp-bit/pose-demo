#!/usr/bin/env node
// headpose-eval.mjs — 头部朝向的角度分档评估（独立工具）
//
// 为什么单独一个工具：头部朝向是辅助信号，口径不是动作 TP/FN/FP，而是
// 「这一段的 yaw/pitch/roll 分档对不对、没把握时有没有弃权、有真值时的角度 MAE」。
// 它直接读 Demo 导出的 signals.head，不重新跑模型；换了 headpose.js 后先重新导出再跑。
//
// 用法：
//   node web/test/headpose-eval.mjs --input clip.jsonl --labels clip.labels.json
//   node web/test/headpose-eval.mjs --input clip.jsonl --labels clip.labels.json --report head.md --json
//   node web/test/headpose-eval.mjs --self-test
//
// labels 段：{ action:"head", startSec/endSec 或 start/end(ms),
//             yaw:"left|right|front|any", pitch:"up|down|front|any",
//             roll:"left|right|level|any",
//             yawDeg?, pitchDeg?, rollDeg? }
// roll 的 left/right 按受试者自身：left = 受试者左侧更低（roll > +tol）。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadFrames, stripBom, frameTs, videoTimeMonotonic } from './frame-io.mjs';

export const AXES = {
  yaw: ['left', 'right', 'front'],
  pitch: ['up', 'down', 'front'],
  roll: ['left', 'right', 'level'],
};

const BIN_ALIASES = {
  yaw: { l: 'left', r: 'right', straight: 'front', center: 'front', centre: 'front' },
  pitch: { down: 'down', up: 'up', level: 'front', straight: 'front', center: 'front', centre: 'front' },
  roll: { l: 'left', r: 'right', level: 'level', straight: 'level', center: 'level', centre: 'level' },
};

const isAny = (v) => v == null || v === 'any' || v === '*';

/** 分档名规整；未知值直接抛错，避免把拼写错误静默算成某一类。 */
export function normBin(axis, value) {
  if (isAny(value)) return 'any';
  const s = String(value).trim().toLowerCase();
  const v = BIN_ALIASES[axis]?.[s] ?? s;
  if (!AXES[axis].includes(v)) {
    throw new Error(`未知 ${axis} 分档：${value}（可用 ${AXES[axis].join(' / ')} / any）`);
  }
  return v;
}

function makeStats() {
  return {
    n: 0, covered: 0, abstain: 0, correct: 0,
    bins: Object.fromEntries(AXES.yaw.map(() => [])),
    confusion: {},
  };
}

// bins 的 key 因轴不同，单独初始化
function statsFor(axis) {
  const st = makeStats();
  st.bins = Object.fromEntries(AXES[axis].map((b) => [b, { n: 0, covered: 0, correct: 0 }]));
  return st;
}

function prediction(head, axis, rollTolDeg) {
  if (!head || head.disabled) return null;
  // 先看角度本身，再看方向：角度为 null（门控/坏点/不可见）时 yaw_dir/pitch_dir 可能仍在
  // DirectionHold 的 dirHoldMs（默认 200ms）保持窗里，那是上一次的输出，不是本帧的——
  // 按「有输出」计会让弃权率/覆盖率系统性偏低，而这个工具的口径恰恰是弃权率。
  if (axis === 'yaw') {
    if (!Number.isFinite(head.yaw)) return null;
    if (head.yaw_dir) return head.yaw_dir;
    return head.yaw >= 15 ? 'right' : head.yaw <= -15 ? 'left' : 'front';
  }
  if (axis === 'pitch') {
    if (!Number.isFinite(head.pitch)) return null;
    if (head.pitch_dir) return head.pitch_dir;
    return head.pitch >= 12 ? 'down' : head.pitch <= -12 ? 'up' : 'front';
  }
  if (!Number.isFinite(head.roll)) return null;
  return head.roll > rollTolDeg ? 'left' : head.roll < -rollTolDeg ? 'right' : 'level';
}

function valueOf(head, axis) {
  if (!head) return NaN;
  return axis === 'roll' ? head.roll : head[axis];
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const quantile = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) * p)];
};

function segmentBounds(seg, idx, videoOk) {
  const hasSec = Number.isFinite(seg.startSec) || Number.isFinite(seg.endSec);
  if (hasSec) {
    if (!Number.isFinite(seg.startSec) || !Number.isFinite(seg.endSec)) {
      throw new Error(`第 ${idx + 1} 段 startSec/endSec 必须同时给出`);
    }
    if (!videoOk) {
      throw new Error(`第 ${idx + 1} 段用 startSec/endSec，但导出的 video_time 非单调（视频循环过）；`
        + '改用 start/end 毫秒标注');
    }
    return { startMs: seg.startSec * 1000, endMs: seg.endSec * 1000, useVideo: true };
  }
  if (!Number.isFinite(seg.start) || !Number.isFinite(seg.end)) {
    throw new Error(`第 ${idx + 1} 段缺 startSec/endSec 或 start/end(ms)`);
  }
  return { startMs: seg.start, endMs: seg.end, useVideo: false };
}

/** 一帧在标注时间基下的时间（毫秒）。 */
function segmentTime(frame, useVideo) {
  if (useVideo) {
    return Number.isFinite(frame?.video_time) ? frame.video_time * 1000 : NaN;
  }
  return frameTs(frame);
}

/**
 * 纯函数：frames 是 Demo 导出（必须带 signals.head），labelsDoc 是带 head 段的 labels。
 * 返回每个轴的分档混淆、覆盖率、弃权率、可选 MAE。
 */
export function evaluateHead(frames, labelsDoc, { rollTolDeg = 10 } = {}) {
  const segs = Array.isArray(labelsDoc) ? labelsDoc : (labelsDoc?.segments || []);
  const videoOk = videoTimeMonotonic(frames);
  const stats = { yaw: statsFor('yaw'), pitch: statsFor('pitch'), roll: statsFor('roll') };
  const errors = { yaw: [], pitch: [], roll: [] };
  const warnings = [];
  let matchedFrames = 0;
  let coveredAny = 0;
  let seenHead = false;
  if (!segs.some((s) => !s?.action || s.action === 'head')) {
    warnings.push('labels 里没有 action:"head" 的段；这个工具不会评估动作段');
  }

  segs.forEach((seg, idx) => {
    if (seg?.action && seg.action !== 'head') return;
    const expect = {
      yaw: normBin('yaw', seg.yaw),
      pitch: normBin('pitch', seg.pitch),
      roll: normBin('roll', seg.roll),
    };
    if (Object.values(expect).every((v) => v === 'any')) {
      warnings.push(`第 ${idx + 1} 段三轴都是 any，忽略`);
      return;
    }
    const { startMs, endMs, useVideo } = segmentBounds(seg, idx, videoOk);
    const selected = frames.filter((f) => {
      const t = segmentTime(f, useVideo);
      return Number.isFinite(t) && t >= startMs && t <= endMs;
    });
    if (!selected.length) {
      warnings.push(`第 ${idx + 1} 段 ${seg.startSec ?? seg.start}–${seg.endSec ?? seg.end} 内没有帧`);
      return;
    }
    for (const f of selected) {
      matchedFrames += 1;
      const head = f.signals?.head;
      if (head) seenHead = true;
      let coveredThisFrame = false;
      for (const axis of ['yaw', 'pitch', 'roll']) {
        if (expect[axis] === 'any') continue;
        const st = stats[axis];
        const bin = st.bins[expect[axis]];
        st.n += 1;
        bin.n += 1;
        const pred = prediction(head, axis, rollTolDeg);
        if (pred == null) {
          st.abstain += 1;
          continue;
        }
        st.covered += 1;
        bin.covered += 1;
        coveredThisFrame = true;
        const key = `${expect[axis]}->${pred}`;
        st.confusion[key] = (st.confusion[key] || 0) + 1;
        if (pred === expect[axis]) {
          st.correct += 1;
          bin.correct += 1;
        }
        const truth = seg[`${axis}Deg`];
        const value = valueOf(head, axis);
        if (Number.isFinite(truth) && Number.isFinite(value)) errors[axis].push(Math.abs(value - truth));
      }
      if (coveredThisFrame) coveredAny += 1;
    }
  });

  if (matchedFrames && !seenHead) {
    warnings.push('所有帧都没有 signals.head：这是旧导出，或导出时 head 未接入；先重新导出再评估');
  }

  const summarizeAxis = (axis) => {
    const st = stats[axis];
    const rates = {};
    for (const b of AXES[axis]) {
      const x = st.bins[b];
      rates[b] = {
        ...x,
        abstain: x.n - x.covered,
        recall: x.n ? +(x.correct / x.n).toFixed(3) : null,        // 端到端：弃权算错
        accuracy: x.covered ? +(x.correct / x.covered).toFixed(3) : null, // 只在有输出时
      };
    }
    const err = errors[axis];
    return {
      n: st.n,
      covered: st.covered,
      abstain: st.abstain,
      correct: st.correct,
      recall: st.n ? +(st.correct / st.n).toFixed(3) : null,
      accuracy: st.covered ? +(st.correct / st.covered).toFixed(3) : null,
      abstainRate: st.n ? +(st.abstain / st.n).toFixed(3) : null,
      bins: rates,
      confusion: st.confusion,
      mae: mean(err) != null ? +mean(err).toFixed(2) : null,
      absErrP90: quantile(err, 0.9) != null ? +quantile(err, 0.9).toFixed(2) : null,
      nErr: err.length,
    };
  };

  return {
    name: labelsDoc?.name ?? null,
    camera: labelsDoc?.camera ?? null,
    subject: labelsDoc?.subject ?? null,
    rollTolDeg,
    frames: matchedFrames,
    coveredAny,
    abstainAny: matchedFrames - coveredAny,
    coverage: matchedFrames ? +(coveredAny / matchedFrames).toFixed(3) : null,
    axes: { yaw: summarizeAxis('yaw'), pitch: summarizeAxis('pitch'), roll: summarizeAxis('roll') },
    warnings,
  };
}

export function headToMarkdown(report) {
  const lines = [];
  lines.push(`# 头部朝向评估 · ${report.name || '(未命名)'}`, '');
  if (report.camera || report.subject) {
    lines.push(`- 机位：${report.camera || '—'} · 受试：${report.subject || '—'}`);
  }
  lines.push(`- 帧数：${report.frames}；有任一轴输出：${report.coveredAny}；覆盖率：`
    + `${report.coverage == null ? '—' : `${Math.round(report.coverage * 100)}%`}`);
  lines.push(`- roll 水平容差：±${report.rollTolDeg}°`, '');
  for (const axis of ['yaw', 'pitch', 'roll']) {
    const a = report.axes[axis];
    lines.push(`## ${axis}`, '');
    lines.push('| 期望 | n | 有输出 | 弃权 | 正确 | recall（弃权算错） | accuracy（有输出时） |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const b of AXES[axis]) {
      const x = a.bins[b];
      if (!x.n) continue;
      lines.push(`| ${b} | ${x.n} | ${x.covered} | ${x.abstain} | ${x.correct} | `
        + `${x.recall == null ? '—' : x.recall} | ${x.accuracy == null ? '—' : x.accuracy} |`);
    }
    lines.push('');
    lines.push(`合计：n=${a.n}，有输出=${a.covered}，弃权=${a.abstain}（${a.abstainRate == null ? '—' : `${Math.round(a.abstainRate * 100)}%`}），`
      + `recall=${a.recall ?? '—'}，accuracy=${a.accuracy ?? '—'}，MAE=${a.mae ?? '—'}°（P90=${a.absErrP90 ?? '—'}°，n=${a.nErr}）`, '');
    const conf = Object.entries(a.confusion).sort();
    if (conf.length) {
      lines.push('混淆：' + conf.map(([k, v]) => `${k}×${v}`).join('，'), '');
    }
  }
  if (report.warnings.length) {
    lines.push('## 警告', '');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = {
    input: null, labels: null, report: null, json: false,
    rollTolDeg: 10, selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') out.input = argv[++i];
    else if (a === '--labels') out.labels = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--roll-tol') out.rollTolDeg = Number(argv[++i]);
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  if (!(out.rollTolDeg >= 0)) throw new Error('--roll-tol 必须是非负数');
  return out;
}

function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  const head = (o = {}) => ({
    disabled: false, visible: true,
    yaw_dir: 'front', pitch_dir: 'front', roll: 0,
    yaw: 0, pitch: 0, ...o,
  });
  const frames = [
    { video_time: 0.0, signals: { head: head({ yaw_dir: 'right', yaw: 30, roll: 3 }) } },
    { video_time: 0.2, signals: { head: head({ yaw_dir: 'right', yaw: 25, roll: 4 }) } },
    { video_time: 0.4, signals: { head: head({ yaw_dir: 'left', yaw: -20, roll: -2 }) } },
    { video_time: 0.6, signals: { head: head({ yaw_dir: null, yaw: null }) } },
    { video_time: 0.8, signals: { head: head({ yaw_dir: 'left', yaw: -25, roll: 30 }) } },
  ];
  const labels = {
    name: 'self',
    segments: [{
      action: 'head', startSec: 0, endSec: 1,
      yaw: 'right', pitch: 'front', roll: 'level',
      yawDeg: 30, pitchDeg: 0, rollDeg: 0,
    }],
  };
  const r = evaluateHead(frames, labels, { rollTolDeg: 10 });
  check('帧数覆盖 5 帧', r.frames === 5, String(r.frames));
  check('yaw n=5 / 有输出 4 / 弃权 1', r.axes.yaw.n === 5 && r.axes.yaw.covered === 4
    && r.axes.yaw.abstain === 1, JSON.stringify({ n: r.axes.yaw.n, c: r.axes.yaw.covered, a: r.axes.yaw.abstain }));
  check('yaw 端到端 recall=2/5', r.axes.yaw.recall === 0.4, String(r.axes.yaw.recall));
  check('yaw 有输出时 accuracy=2/4', r.axes.yaw.accuracy === 0.5, String(r.axes.yaw.accuracy));
  check('yaw 分档计数', r.axes.yaw.bins.right.n === 5 && r.axes.yaw.bins.right.correct === 2);
  check('roll 水平容差内算 level', r.axes.roll.bins.level.correct === 4, String(r.axes.roll.bins.level.correct));
  check('roll 30° 判 left（期望 level → 错）', r.axes.roll.confusion['level->left'] === 1);
  check('yaw MAE 只算有真值的输出帧', r.axes.yaw.nErr === 4 && r.axes.yaw.mae != null,
    `nErr=${r.axes.yaw.nErr} mae=${r.axes.yaw.mae}`);
  check('任一轴有输出的覆盖率=5/5', r.coverage === 1, String(r.coverage));
  check('yaw 轴覆盖率=4/5', r.axes.yaw.covered / r.axes.yaw.n === 0.8,
    String(r.axes.yaw.covered / r.axes.yaw.n));

  const labelsMs = { segments: [{ action: 'head', start: 0, end: 500, yaw: 'right', pitch: 'any', roll: 'any' }] };
  const r2 = evaluateHead(frames, labelsMs, { rollTolDeg: 10 });
  check('start/end 毫秒标注可用', r2.frames === 3, String(r2.frames));
  check('未知分档抛错', (() => { try { normBin('yaw', 'sideways'); return false; } catch { return true; } })());
  const noHead = evaluateHead(frames.map((f) => ({ video_time: f.video_time, signals: null })), labels, {});
  check('没有 signals.head 时给警告', noHead.warnings.some((w) => w.includes('signals.head')));

  // 去抖保持窗：角度已被门控/坏点置 null，但 yaw_dir 还是旧方向（DirectionHold 默认保持
  // 200ms）。这种帧必须算弃权，不能算「有输出」，否则弃权率会被系统性低估。
  const heldFrames = [
    { video_time: 0.0, signals: { head: head({ yaw_dir: 'left', yaw: -20 }) } },
    { video_time: 0.2, signals: { head: head({ yaw_dir: 'left', yaw: null }) } },
  ];
  const heldLabels = {
    segments: [{ action: 'head', startSec: 0, endSec: 1, yaw: 'left', pitch: 'any', roll: 'any' }],
  };
  const rHeld = evaluateHead(heldFrames, heldLabels, { rollTolDeg: 10 });
  check('角度为 null 但方向仍在去抖保持窗内 → 弃权',
    rHeld.axes.yaw.n === 2 && rHeld.axes.yaw.covered === 1 && rHeld.axes.yaw.abstain === 1,
    JSON.stringify({ n: rHeld.axes.yaw.n, covered: rHeld.axes.yaw.covered, abstain: rHeld.axes.yaw.abstain }));
  console.log(`\nself-test：${pass} 通过，${fail} 失败`);
  return fail ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
  if (!args.input || !args.labels) {
    console.log('用法：node web/test/headpose-eval.mjs --input <frames.jsonl> --labels <labels.json> '
      + '[--report out.md] [--json] [--roll-tol 10]');
    console.log('      node web/test/headpose-eval.mjs --self-test');
    return args.help ? 0 : 1;
  }
  const frames = await loadFrames(args.input);
  const labelsDoc = JSON.parse(stripBom(await readFile(args.labels, 'utf8')));
  const report = evaluateHead(frames, labelsDoc, { rollTolDeg: args.rollTolDeg });
  if (args.report) {
    await writeFile(args.report, `${headToMarkdown(report)}\n`, 'utf8');
    // --json 时 stdout 只留 JSON；状态行走 stderr。
    (args.json ? console.error : console.log)(`已写入 ${args.report}`);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (!args.report) console.log(headToMarkdown(report));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
