// handkp-eval.mjs — 手部 21 点关键点质量评测（无真值代理 + 可选 GT PCK/MPJPE）
//
// 用法：
//   node web/test/handkp-eval.mjs --input <raw-export.jsonl>
//   node web/test/handkp-eval.mjs --input <raw-export.jsonl> --gt <handkp-gt.json>
//   node web/test/handkp-eval.mjs --self-test
//
// 没有 GT 时只报「精度/稳定性代理」：抖动（静止对）、骨长 CV（整段/掌骨/静止段）、尺度 CV。
// 这些不是准确率。有 GT 时另报 PCK@α 与归一化 MPJPE。
//
// 口径细节见 docs/signals.md「手部关键点质量」与 docs/frame-schema.md。

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadFrames, stripBom, videoTimeMonotonic } from './frame-io.mjs';
import {
  buildSeries, jitterStats, boneCV, scaleCV, loadGT, matchGT, pck, mpjpe, percentile,
} from './handkp-metrics.mjs';

const USAGE = `手部关键点质量评测

用法：
  node web/test/handkp-eval.mjs --input <jsonl|json> [选项]
  node web/test/handkp-eval.mjs --self-test

选项：
  --input <path>        导出帧（raw export JSONL，或补了 kp 的 hand-bench JSON）
  --gt <path>           可选关键点真值（handkp-gt v0）
  --time auto|video|ts  时间基；auto=video_time 单调则用 video，否则 ts（默认 auto）
  --track single|multi  单人按侧别分组；多人按 track_uid|side（默认 single）
  --max-gap-ms <n>      序列断开阈值（默认 300）
  --tol-ms <n>          GT 时间匹配容差（默认 100）
  --side-any            匹配 GT 时忽略左右侧
  --alpha <a,b,c>       PCK 阈值，单位=GT 手尺度（默认 0.05,0.10,0.15）
  --static-move <n>     静止对：腕点位移/手尺度上限（默认 0.05）
  --static-scale <n>    静止对：|Δ尺度|/尺度上限（默认 0.05）
  --json                stdout 输出纯 JSON（状态/警告走 stderr）
  --quiet               不输出 Markdown
  --self-test           跑内置自测
  -h, --help            显示本帮助`;

const num = (s, flag) => {
  const v = Number(s);
  if (!Number.isFinite(v)) throw new Error(`${flag} 需要数值，收到 ${s}`);
  return v;
};

function parseArgs(argv) {
  const out = {
    input: null,
    gt: null,
    time: 'auto',
    track: 'single',
    maxGapMs: 300,
    tolMs: 100,
    sideAny: false,
    alpha: [0.05, 0.1, 0.15],
    staticMove: 0.05,
    staticScale: 0.05,
    json: false,
    quiet: false,
    selfTest: false,
    help: false,
  };
  const need = (i, flag) => {
    if (i >= argv.length) throw new Error(`${flag} 缺少值`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--input': out.input = need(++i, a); break;
      case '--gt': out.gt = need(++i, a); break;
      case '--time': out.time = need(++i, a); break;
      case '--track': out.track = need(++i, a); break;
      case '--max-gap-ms': out.maxGapMs = num(need(++i, a), a); break;
      case '--tol-ms': out.tolMs = num(need(++i, a), a); break;
      case '--side-any': out.sideAny = true; break;
      case '--alpha': out.alpha = need(++i, a).split(',').map((s) => num(s.trim(), a)); break;
      case '--static-move': out.staticMove = num(need(++i, a), a); break;
      case '--static-scale': out.staticScale = num(need(++i, a), a); break;
      case '--json': out.json = true; break;
      case '--quiet': out.quiet = true; break;
      case '--self-test': out.selfTest = true; break;
      case '-h':
      case '--help': out.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  if (!['auto', 'video', 'ts'].includes(out.time)) throw new Error('--time 只能是 auto|video|ts');
  if (!['single', 'multi'].includes(out.track)) throw new Error('--track 只能是 single|multi');
  if (!out.alpha.length || out.alpha.some((x) => !(x > 0 && x < 1))) throw new Error('--alpha 必须在 0~1 之间');
  if (!(out.maxGapMs > 0)) throw new Error('--max-gap-ms 必须 > 0');
  if (!(out.tolMs >= 0)) throw new Error('--tol-ms 必须 >= 0');
  return out;
}

function resolveTimeMode(frames, mode) {
  if (mode !== 'auto') return mode;
  const allVideo = frames.length > 0 && frames.every((f) => Number.isFinite(f?.video_time));
  return allVideo && videoTimeMonotonic(frames) ? 'video' : 'ts';
}

const round4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null);
function clean(v) {
  if (typeof v === 'number') return round4(v);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  }
  return v;
}

function topWorst(perBone, n = 5) {
  return [...perBone]
    .filter((b) => b.n > 0)
    .sort((a, b) => b.median - a.median)
    .slice(0, n)
    .map((b) => ({ bone: `${b.a}-${b.b}`, n: b.n, median: b.median, p90: b.p90 }));
}

function buildReport(frames, opts, gt) {
  const timeMode = resolveTimeMode(frames, opts.time);
  if (opts.time === 'auto' && timeMode !== 'video') {
    console.error('提示：video_time 缺失或非单调，已退回 ts 时间基。');
  }
  const { series, meta } = buildSeries(frames, {
    timeMode,
    trackMode: opts.track,
    gapMs: opts.maxGapMs,
  });

  const jitter = jitterStats(series, { staticMove: opts.staticMove, staticScale: opts.staticScale });
  const boneAll = boneCV(series);
  const bonePalm = boneCV(series, { palmOnly: true });
  const boneStatic = boneCV(series, {
    staticOnly: true,
    staticMove: opts.staticMove,
    staticScale: opts.staticScale,
    minFrames: 3,
  });
  const scaleAll = scaleCV(series);
  const scaleStatic = scaleCV(series, {
    staticOnly: true,
    staticMove: opts.staticMove,
    staticScale: opts.staticScale,
    minFrames: 3,
  });

  const lengths = series.map((s) => s.samples);
  const report = {
    input: opts.input,
    timeMode,
    track: opts.track,
    maxGapMs: opts.maxGapMs,
    tolMs: opts.tolMs,
    staticMove: opts.staticMove,
    staticScale: opts.staticScale,
    coverage: {
      frames: meta.frames,
      framesWithAnyHand: meta.framesWithAnyHand,
      framesWithValidHand: meta.framesWithValidHand,
      handsSeen: meta.handsSeen,
      handsValid: meta.handsValid,
      degenerate: meta.degenerate,
      unassigned: meta.unassigned,
      sourceHist: meta.sourceHist,
      sideHist: meta.sideHist,
      fallbackMulti: meta.fallbackMulti,
    },
    series: {
      n: series.length,
      lengths,
      medianLength: percentile(lengths, 0.5),
    },
    jitter: {
      all: jitter.all,
      static: jitter.static,
      perJointAll: jitter.perJointAll,
      perJointStatic: jitter.perJointStatic,
      rawPairs: jitter.rawPairs,
      pairs: jitter.pairs,
      staticPairs: jitter.staticPairs,
      sourceSwitches: jitter.sourceSwitches,
      jointSamples: jitter.jointSamples,
      staticJointSamples: jitter.staticJointSamples,
    },
    boneCV: {
      all: boneAll.summary,
      palm: bonePalm.summary,
      static: boneStatic.summary,
      allRuns: boneAll.runsUsed,
      staticRuns: boneStatic.runsUsed,
      perBone: boneAll.perBone,
      worstBones: topWorst(boneAll.perBone),
      worstPalmBones: topWorst(bonePalm.perBone),
      worstStaticBones: topWorst(boneStatic.perBone),
    },
    scaleCV: { all: scaleAll, static: scaleStatic },
  };

  if (gt) {
    const matched = matchGT(series, gt.hands, { tolMs: opts.tolMs, sideAny: opts.sideAny });
    report.gt = {
      labeled: gt.hands.length,
      skipped: gt.skipped.length,
      matched: matched.pairs.length,
      unmatched: matched.unmatched.length,
      sideMismatch: matched.sideMismatch,
      pck: pck(matched.pairs, opts.alpha),
      mpjpe: mpjpe(matched.pairs),
    };
  }
  return report;
}

const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : '—');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');

function renderMarkdown(r) {
  const c = r.coverage;
  const j = r.jitter;
  const b = r.boneCV;
  const lines = [];
  lines.push('# 手部关键点质量（无真值代理）');
  lines.push('');
  lines.push('> **没有关键点真值 ⇒ 下面是稳定性/精度代理，不是准确率。**');
  lines.push(`> 输入：\`${r.input}\` · 时间基：${r.timeMode} · 分组：${r.track}`);
  lines.push('');
  lines.push('## 覆盖');
  lines.push('');
  lines.push('| 帧 | 有手帧 | 有效手帧 | 检出/有效手 | 退化 | 未归属 | 来源 roi/wrist/none |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(`| ${c.frames} | ${c.framesWithAnyHand} | ${c.framesWithValidHand} | ${c.handsSeen}/${c.handsValid} | ${c.degenerate} | ${c.unassigned} | ${c.sourceHist.roi || 0}/${c.sourceHist.wrist || 0}/${c.sourceHist.none || 0} |`);
  if (c.fallbackMulti) lines.push('\n> `--track multi` 但输入没有 `verdicts`，已退回整帧 `hands` 并按侧别分组。');
  lines.push('');
  lines.push('## 序列');
  lines.push('');
  lines.push(`手序列 **${r.series.n}** 条；每条帧数中位数 ${f2(r.series.medianLength)}（按 ${r.maxGapMs ?? 300}ms 间隔断开）。`);
  lines.push('');
  lines.push('## 抖动（相邻帧，同名关节位移 ÷ 手尺度）');
  lines.push('');
  lines.push('| 子集 | 对数 | 关节样本 | median | P90 |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| 全部（含真实运动，仅作上下文） | ${j.pairs} | ${j.jointSamples} | ${f4(j.all.median)} | ${f4(j.all.p90)} |`);
  lines.push(`| 静止对（噪声代理） | ${j.staticPairs} | ${j.staticJointSamples} | ${f4(j.static.median)} | ${f4(j.static.p90)} |`);
  lines.push('');
  lines.push(`剔除跨来源（ROI↔整帧）对 **${j.sourceSwitches}** 个（原始相邻对 ${j.rawPairs}）。`);
  if (j.staticPairs < 20) lines.push('> 静止对 < 20：静止抖动仅供参考，别当稳定指标。');
  if (j.perJointStatic?.length) {
    const worst = [...j.perJointStatic]
      .map((s, i) => ({ joint: i, ...s }))
      .filter((s) => s.n > 0)
      .sort((a, b2) => b2.median - a.median)
      .slice(0, 5);
    if (worst.length) {
      lines.push('');
      lines.push(`静止抖动最大的关节：${worst.map((s) => `${s.joint}:${f4(s.median)}`).join('，')}`);
    }
  }
  lines.push('');
  lines.push('## 骨长 CV（std/mean，尺度无关）');
  lines.push('');
  lines.push('| 口径 | 段数 | 骨样本 | median | P90 |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| 全骨（含手型变化/透视缩短，**不是纯噪声**） | ${b.allRuns} | ${b.all.n} | ${f4(b.all.median)} | ${f4(b.all.p90)} |`);
  lines.push(`| 掌骨子集 | ${b.allRuns} | ${b.palm.n} | ${f4(b.palm.median)} | ${f4(b.palm.p90)} |`);
  lines.push(`| 静止段（噪声代理） | ${b.staticRuns} | ${b.static.n} | ${f4(b.static.median)} | ${f4(b.static.p90)} |`);
  if (b.static.n) {
    lines.push('');
    lines.push(`静止段最不稳的骨：${b.worstStaticBones.slice(0, 5).map((x) => `${x.bone}:${f4(x.median)}`).join('，')}`);
  }
  lines.push('');
  lines.push('## 尺度 CV（腕→中指 MCP）');
  lines.push('');
  lines.push('| 子集 | 段数 | 样本 | median | P90 |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| 全部 | ${r.scaleCV.all.runsUsed} | ${r.scaleCV.all.n} | ${f4(r.scaleCV.all.median)} | ${f4(r.scaleCV.all.p90)} |`);
  lines.push(`| 静止段 | ${r.scaleCV.static.runsUsed} | ${r.scaleCV.static.n} | ${f4(r.scaleCV.static.median)} | ${f4(r.scaleCV.static.p90)} |`);

  if (r.gt) {
    const g = r.gt;
    lines.push('');
    lines.push('## GT（PCK / MPJPE）');
    lines.push('');
    lines.push(`标注 ${g.labeled} · 匹配 ${g.matched} · 未匹配 ${g.unmatched} · 跳过 ${g.skipped} · 侧别不匹配 ${g.sideMismatch}`);
    lines.push('');
    lines.push('| PCK | 命中/样本 | 比例 | Wilson 95% |');
    lines.push('|---|---|---|---|');
    for (const a of g.pck.alphas) {
      const [lo, hi] = a.ci;
      lines.push(`| @${a.alpha}·scale | ${a.hit}/${a.total} | ${f4(a.rate)} | ${f4(lo)}~${f4(hi)} |`);
    }
    lines.push('');
    lines.push(`MPJPE（归一化）：median ${f4(g.mpjpe.norm.median)} · mean ${f4(g.mpjpe.norm.mean)} · P90 ${f4(g.mpjpe.norm.p90)}`);
    lines.push(`MPJPE（px）：median ${f2(g.mpjpe.px.median)} · P90 ${f2(g.mpjpe.px.p90)} · 尺度比 ${f4(g.mpjpe.scaleRatio.median)}（预测/GT）`);
  }

  lines.push('');
  lines.push(`> 口径：全部按 s=‖kp[0]−kp[9]‖ 归一；静止对=腕位移 ≤${r.staticMove}·s 且 |Δs|/s ≤${r.staticScale}；`);
  lines.push('> 跨来源（roi/wrist）的相邻对已剔除。0.1px 导出量化给出约 0.001·s 的抖动地板。');
  return lines.join('\n');
}

// —— 自测 ——

function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  };

  const BASE = [
    [0, 0], [-30, 20], [-45, 40], [-55, 60], [-60, 80],
    [-20, 95], [-22, 120], [-24, 140], [-25, 160],
    [0, 100], [0, 125], [0, 145], [0, 165],
    [20, 95], [22, 120], [24, 140], [25, 160],
    [40, 90], [43, 112], [45, 130], [47, 148],
  ];
  const mkHand = () => BASE.map((p) => p.slice());
  const mapHand = (fn) => BASE.map((p) => fn(p.slice()));
  const mkFrame = (t, kp, { side = 'Right', src = 'roi' } = {}) => ({
    ts: t,
    video_time: t / 1000,
    hands: [{ handedness: side, side_from: src, score: 1, kp }],
  });
  const mkFrames = (ns, kp, opts) => ns.map((n) => mkFrame(n, kp.map((p) => p.slice()), opts));
  const seriesOf = (frames, opts = {}) =>
    buildSeries(frames, { timeMode: 'ts', gapMs: 300, ...opts }).series;
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

  console.log('\n[self-test 1] 刚性 / 平移 / 缩放');
  {
    const frames = mkFrames([0, 100, 200, 300, 400], mkHand());
    const j = jitterStats(seriesOf(frames));
    const b = boneCV(seriesOf(frames));
    const s = scaleCV(seriesOf(frames));
    check('一致帧：抖动为 0', j.all.median === 0 && j.all.p90 === 0);
    check('一致帧：骨长 CV 为 0', b.summary.median === 0);
    check('一致帧：尺度 CV 为 0', s.median === 0);

    const moved = mapHand(([x, y]) => [x + 300, y - 50]);
    const j2 = jitterStats(seriesOf(mkFrames([0, 100, 200, 300, 400], moved)));
    check('整体平移：归一后仍为 0', j2.all.median === 0);

    const scaled = mapHand(([x, y]) => [x * 1.7, y * 1.7]);
    const j3 = jitterStats(seriesOf(mkFrames([0, 100, 200, 300, 400], scaled)));
    const b3 = boneCV(seriesOf(mkFrames([0, 100, 200, 300, 400], scaled)));
    const s3 = scaleCV(seriesOf(mkFrames([0, 100, 200, 300, 400], scaled)));
    check('均匀放大 ×1.7：抖动/骨长/尺度 CV 都为 0',
      j3.all.median === 0 && b3.summary.median === 0 && s3.median === 0);
  }

  console.log('\n[self-test 2] 单关节噪声 / 形变');
  {
    const frames = [0, 100, 200, 300, 400].map((t, i) => {
      const kp = mkHand();
      kp[8][0] += i % 2 === 0 ? 0 : 2; // 交替 +2px
      return mkFrame(t, kp);
    });
    const j = jitterStats(seriesOf(frames));
    check('关节 8 抖动 = 2/100', near(j.perJointAll[8].median, 0.02, 1e-6), String(j.perJointAll[8].median));

    const frames2 = [0, 100, 200, 300, 400].map((t, i) => {
      const kp = mkHand();
      if (i === 2) kp[12][0] += 3;
      return mkFrame(t, kp);
    });
    const b = boneCV(seriesOf(frames2));
    const affected = b.perBone.filter((x) => x.n > 0 && x.median > 0);
    check('单关节形变只影响相邻骨', affected.length === 1 && affected[0].a === 11 && affected[0].b === 12,
      affected.map((x) => `${x.a}-${x.b}`).join(','));
  }

  console.log('\n[self-test 3] 分组 / 间隔 / 来源');
  {
    const sides = [0, 100, 200, 300].map((t, i) => mkFrame(t, mkHand(), { side: i % 2 ? 'Left' : 'Right' }));
    const s = seriesOf(sides);
    check('侧别交替拆成两序列', s.length === 2 && s.every((x) => x.frames.every((f) => f.side === x.key)));

    const gap = seriesOf([0, 100, 1000].map((t) => mkFrame(t, mkHand())));
    check('长间隔断开序列', gap.length === 2 && gap[0].samples === 2 && gap[1].samples === 1);

    const src = [0, 100, 200].map((t, i) => mkFrame(t, mkHand(), { src: i === 1 ? 'wrist' : 'roi' }));
    const j = jitterStats(seriesOf(src));
    check('跨来源对剔除并计数', j.rawPairs === 2 && j.sourceSwitches === 2 && j.pairs === 0,
      `raw=${j.rawPairs} sw=${j.sourceSwitches} pairs=${j.pairs}`);
  }

  console.log('\n[self-test 4] GT 评分');
  {
    const gt = loadGT({ schema: 'handkp-gt v0', hands: [{ t: 1.0, side: 'Right', kp: mkHand() }] });
    check('GT 读入 1 只手', gt.hands.length === 1 && gt.skipped.length === 0);

    const off = mkHand();
    off[5][0] += 8; // 0.08·scale
    const matched = matchGT(seriesOf([mkFrame(1000, off)]), gt.hands, { tolMs: 100 });
    check('GT 时间/侧别匹配', matched.pairs.length === 1);

    const p = pck(matched.pairs, [0.05, 0.1, 0.15]);
    check('PCK@0.05 = 20/21', p.alphas[0].hit === 20 && p.alphas[0].total === 21, `${p.alphas[0].hit}/${p.alphas[0].total}`);
    check('PCK@0.10 = 21/21', p.alphas[1].hit === 21 && p.alphas[1].total === 21, `${p.alphas[1].hit}/${p.alphas[1].total}`);
    const m = mpjpe(matched.pairs);
    check('MPJPE 归一化 = 0.08/21', near(m.norm.mean, 0.08 / 21, 1e-9), String(m.norm.mean));

    const shifted = mapHand(([x, y]) => [x + 5, y]);
    const m2 = mpjpe(matchGT(seriesOf([mkFrame(1000, shifted)]), gt.hands, { tolMs: 100 }).pairs);
    check('MPJPE：整体 +5px → 归一 0.05 / px 5',
      near(m2.norm.mean, 0.05, 1e-9) && near(m2.px.median ?? m2.px.mean, 5, 1e-9),
      `norm=${m2.norm.mean} px=${m2.px.median}`);
  }

  console.log('\n[self-test 5] 退化输入');
  {
    const short = mkFrame(0, mkHand().slice(0, 20));
    const zeroKp = mkHand();
    zeroKp[9] = [0, 0];
    const zero = mkFrame(100, zeroKp);
    const { series, meta } = buildSeries([short, zero], { timeMode: 'ts', gapMs: 300 });
    check('20 点 / 尺度 0 被跳过', meta.degenerate === 2 && series.length === 0 && meta.withKp === 0,
      `deg=${meta.degenerate} series=${series.length}`);
  }

  console.log('\n[self-test 6] 缺关节不崩');
  {
    const kp = mkHand();
    kp[8] = null;                       // 手尺度（kp[0]/kp[9]）仍有效，只有中指指尖缺失
    let j = null;
    let err = null;
    try { j = jitterStats(seriesOf([mkFrame(0, mkHand()), mkFrame(100, kp)])); } catch (e) { err = e; }
    check('缺关节：抖动统计跳过该关节而不是抛异常',
      !err && !!j && j.jointSamples === 20, err ? err.message : `samples=${j?.jointSamples}`);
  }

  console.log(`\nself-test：${pass} 通过，${fail} 失败`);
  return fail ? 1 : 0;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    return 1;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.selfTest) return selfTest();
  if (!opts.input) { console.error('缺少 --input\n'); console.error(USAGE); return 1; }

  let frames;
  try {
    frames = await loadFrames(opts.input);
  } catch (e) {
    console.error(`读取输入失败：${e.message}`);
    return 1;
  }
  if (!frames.length) { console.error(`没有读到帧：${opts.input}`); return 1; }

  let gt = null;
  if (opts.gt) {
    try {
      gt = loadGT(JSON.parse(stripBom(await readFile(opts.gt, 'utf8'))));
    } catch (e) {
      console.error(`读取 GT 失败：${e.message}`);
      return 1;
    }
    if (!gt.hands.length) { console.error('GT 里没有有效手（需要 21 点、非零尺度）'); return 1; }
  }

  const report = buildReport(frames, opts, gt);
  if (report.coverage.handsSeen > 0 && report.coverage.handsValid === 0) {
    console.error('输入里有手但没有可用 kp：hand-bench 记录需补 kp，或改用 raw export JSONL。');
    return 1;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(clean(report), null, 2)}\n`);
  } else if (!opts.quiet) {
    process.stdout.write(`${renderMarkdown(report)}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e?.stack || e);
      process.exit(1);
    });
}

export { parseArgs, buildReport, renderMarkdown };
