// handkp-metrics.mjs — 手部 21 点关键点的质量指标（纯函数，Node 可单测）
//
// 仓库里没有手部关键点真值，所以默认只能算「稳定性代理」：
//   - 抖动：相邻帧同名关节的位移 ÷ 手尺度。真实运动会抬高它，因此另给「静止对」子集
//     （手几乎不动、尺度几乎不变）——那才是噪声代理。
//   - 骨长 CV：同序列内每条骨长 / 手尺度，跨帧的变异系数。整段会混入手型变化与透视缩短
//     （手转出平面），所以同时给掌骨子集和「静止段」。
//   - 尺度 CV：腕→中指 MCP 的手尺度本身的变异。
// 有真值时另外给 PCK@α 与归一化 MPJPE（pck / mpjpe）。
//
// 所有距离按 s = ‖kp[0] − kp[9]‖ 归一，与 handshape.js 的手尺度同一口径。
// 这些数字**不是准确率**：没有 GT 就只有精度/稳定性代理。

import { HAND_CONNECTIONS } from '../js/kpt.js';

export const POINTS = 21;

// 掌骨（腕/MCP 之间）：手指articulation时相对刚性，整段 CV 比全骨干净一些。
export const PALM_BONES = [[0, 1], [0, 5], [5, 9], [9, 13], [13, 17], [0, 17]];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const okPt = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

export function handScale(kp) {
  if (!Array.isArray(kp) || kp.length < POINTS || !okPt(kp[0]) || !okPt(kp[9])) return NaN;
  const s = dist(kp[0], kp[9]);
  return Number.isFinite(s) && s > 0 ? s : NaN;
}

/** 每条 HAND_CONNECTIONS 骨的长度 ÷ 手尺度（尺度无关）。 */
export function normalizedBoneLengths(kp) {
  const s = handScale(kp);
  if (!Number.isFinite(s)) return HAND_CONNECTIONS.map(() => NaN);
  return HAND_CONNECTIONS.map(([a, b]) => (okPt(kp[a]) && okPt(kp[b]) ? dist(kp[a], kp[b]) / s : NaN));
}

// 同时接受导出契约（handedness / side_from）与 hand-bench 记录（side / src）。
const sideOf = (h) => {
  const s = h?.handedness ?? h?.side;
  return s === 'Left' || s === 'L' ? 'L' : s === 'Right' || s === 'R' ? 'R' : null;
};
const srcOf = (h) => h?.side_from ?? h?.src ?? 'none';

/**
 * 帧时间（毫秒）。timeMode: 'video' = video_time（秒）×1000；'ts' = ts（已是毫秒）。
 * hand-bench 的帧只有 `t`（秒），按顺序回退，避免读 bench JSON 时全部变成 NaN。
 */
export function frameTimeMs(frame, timeMode = 'ts') {
  if (!frame || typeof frame !== 'object') return NaN;
  if (timeMode === 'video' && Number.isFinite(frame.video_time)) return frame.video_time * 1000;
  if (Number.isFinite(frame.ts)) return frame.ts;
  if (Number.isFinite(frame.video_time)) return frame.video_time * 1000;
  if (Number.isFinite(frame.t)) return frame.t * 1000;
  return NaN;
}

/** 静止对：手几乎没动、尺度也没变。用于把真实运动从抖动里分开。 */
export function isStaticPair(a, b, { staticMove = 0.05, staticScale = 0.05 } = {}) {
  if (!a || !b || !(a.scale > 0) || !(b.scale > 0)) return false;
  const move = dist(a.kp[0], b.kp[0]) / b.scale;
  const dScale = Math.abs(b.scale / a.scale - 1);
  return move <= staticMove && dScale <= staticScale;
}

/** 最近秩分位数（对有限值排序后取值）。 */
export function percentile(values, q) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const pos = Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))));
  return a[pos];
}

export function summarize(values) {
  const a = values.filter(Number.isFinite);
  if (!a.length) return { n: 0, mean: NaN, median: NaN, p90: NaN };
  return {
    n: a.length,
    mean: a.reduce((x, y) => x + y, 0) / a.length,
    median: percentile(a, 0.5),
    p90: percentile(a, 0.9),
  };
}

function collectEntries(frames, { timeMode, trackMode }) {
  const entries = [];
  const anyFrames = new Set();
  const validFrames = new Set();
  const meta = {
    frames: frames.length,
    handsSeen: 0,
    withKp: 0,
    degenerate: 0,
    unassigned: 0,
    sourceHist: { roi: 0, wrist: 0, none: 0 },
    sideHist: { L: 0, R: 0 },
    fallbackMulti: false,
  };
  const MIN_SCALE = 5; // px；远景小手 / 侧对时尺度会退化

  const add = (h, track, t, fi) => {
    meta.handsSeen++;
    anyFrames.add(fi);
    const src = srcOf(h);
    meta.sourceHist[src] = (meta.sourceHist[src] || 0) + 1;
    const side = sideOf(h);
    const kp = h?.kp;
    const scale = handScale(kp);
    if (!Number.isFinite(t) || !side) { meta.unassigned++; return; }
    if (!Array.isArray(kp) || kp.length < POINTS || !(scale >= MIN_SCALE)) { meta.degenerate++; return; }
    meta.sideHist[side]++;
    meta.withKp++;
    validFrames.add(fi);
    entries.push({ t, kp, scale, side, src, track, fi });
  };

  const hasVerdicts = trackMode === 'multi' && frames.some((f) => Array.isArray(f.verdicts) && f.verdicts.length);
  if (trackMode === 'multi' && !hasVerdicts) meta.fallbackMulti = true;

  frames.forEach((f, fi) => {
    const t = frameTimeMs(f, timeMode);
    if (hasVerdicts) {
      for (const v of f.verdicts || []) {
        for (const h of v.hands || []) add(h, v.track_uid ?? v.track_id ?? 0, t, fi);
      }
    } else {
      for (const h of f.hands || []) add(h, null, t, fi);
    }
  });

  meta.framesWithAnyHand = anyFrames.size;
  meta.framesWithValidHand = validFrames.size;
  return { entries, meta };
}

/**
 * 按手序列分组：默认单人按侧别（L/R）；multi 按 `track|side` 并读 verdicts[].hands。
 * 时间排序后，相邻帧间隔 > gapMs 就断开（避免把长间隔两端的真实位移当成抖动）。
 */
export function buildSeries(frames, { timeMode = 'ts', trackMode = 'single', gapMs = 300 } = {}) {
  const { entries, meta } = collectEntries(frames, { timeMode, trackMode });
  const byKey = new Map();
  for (const e of entries) {
    const key = trackMode === 'multi' ? `${e.track ?? 0}|${e.side}` : e.side;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  const series = [];
  for (const [key, arr] of byKey) {
    arr.sort((a, b) => a.t - b.t);
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      series.push({ key, side: cur[0].side, track: cur[0].track, frames: cur, samples: cur.length });
      cur = [];
    };
    for (const e of arr) {
      if (cur.length && e.t - cur[cur.length - 1].t > gapMs) flush();
      cur.push(e);
    }
    flush();
  }
  meta.handsValid = entries.length;
  return { series, meta };
}

export function jitterStats(series, { staticMove = 0.05, staticScale = 0.05 } = {}) {
  const all = [];
  const stat = [];
  const perJointAll = Array.from({ length: POINTS }, () => []);
  const perJointStatic = Array.from({ length: POINTS }, () => []);
  let rawPairs = 0;
  let sourceSwitches = 0;
  let pairs = 0;
  let staticPairs = 0;

  for (const s of series) {
    const fs = s.frames;
    for (let i = 1; i < fs.length; i++) {
      rawPairs++;
      const a = fs[i - 1];
      const b = fs[i];
      // ROI 与整帧的输入分辨率不同，跨来源的位移不是同一把尺子量出来的，剔除。
      if (a.src !== b.src) { sourceSwitches++; continue; }
      if (!(a.scale > 0) || !(b.scale > 0)) continue;
      pairs++;
      const isStatic = isStaticPair(a, b, { staticMove, staticScale });
      if (isStatic) staticPairs++;
      for (let j = 0; j < POINTS; j++) {
        // 与 boneCV/pck/mpjpe 同口径：缺关节（null/非有限）跳过，不能整份评测崩掉。
        if (!okPt(a.kp[j]) || !okPt(b.kp[j])) continue;
        const d = dist(a.kp[j], b.kp[j]) / b.scale;
        if (!Number.isFinite(d)) continue;
        all.push(d);
        perJointAll[j].push(d);
        if (isStatic) { stat.push(d); perJointStatic[j].push(d); }
      }
    }
  }

  return {
    all: summarize(all),
    static: summarize(stat),
    perJointAll: perJointAll.map(summarize),
    perJointStatic: perJointStatic.map(summarize),
    rawPairs,
    pairs,
    staticPairs,
    sourceSwitches,
    jointSamples: all.length,
    staticJointSamples: stat.length,
  };
}

/** 连续静止帧组成的段（每个相邻对都通过 isStaticPair，且来源一致）。 */
function staticRuns(frames, { staticMove = 0.05, staticScale = 0.05, minFrames = 3 } = {}) {
  const runs = [];
  let cur = [];
  for (let i = 0; i < frames.length; i++) {
    const prev = frames[i - 1];
    const now = frames[i];
    const ok = i === 0 || (prev.src === now.src && isStaticPair(prev, now, { staticMove, staticScale }));
    if (ok) {
      cur.push(now);
    } else {
      if (cur.length >= minFrames) runs.push(cur);
      cur = [now];
    }
  }
  if (cur.length >= minFrames) runs.push(cur);
  return runs;
}

/**
 * 骨长 CV（std/mean）。默认用整段；staticOnly 时只在静止段内算——后者才是噪声代理。
 * palmOnly 用 PALM_BONES，少受手指articulation/透视缩短影响。
 */
export function boneCV(series, {
  palmOnly = false, staticOnly = false, staticMove = 0.05, staticScale = 0.05, minFrames = 3,
} = {}) {
  const bones = palmOnly ? PALM_BONES : HAND_CONNECTIONS;
  const perBone = new Map(bones.map(([a, b]) => [`${a}-${b}`, { a, b, values: [] }]));
  const values = [];
  let runsUsed = 0;

  for (const s of series) {
    const runs = staticOnly
      ? staticRuns(s.frames, { staticMove, staticScale, minFrames })
      : (s.frames.length >= minFrames ? [s.frames] : []);
    for (const run of runs) {
      runsUsed++;
      for (const [a, b] of bones) {
        const lens = run.map((f) => (okPt(f.kp[a]) && okPt(f.kp[b]) ? dist(f.kp[a], f.kp[b]) / f.scale : NaN));
        if (lens.some((x) => !Number.isFinite(x))) continue;
        const mean = lens.reduce((x, y) => x + y, 0) / lens.length;
        if (!(mean > 1e-9)) continue;
        const sd = Math.sqrt(lens.reduce((x, y) => x + (y - mean) ** 2, 0) / lens.length);
        // 相同输入的浮点求和会留下 ~1e-16 的 sd，夹成 0，避免「全常数却 CV>0」。
        const cv = sd / mean > 1e-12 ? sd / mean : 0;
        values.push(cv);
        perBone.get(`${a}-${b}`).values.push(cv);
      }
    }
  }

  return {
    summary: summarize(values),
    values,
    perBone: [...perBone.values()].map(({ a, b, values: v }) => ({ a, b, ...summarize(v) })),
    runsUsed,
  };
}

export function scaleCV(series, {
  staticOnly = false, staticMove = 0.05, staticScale = 0.05, minFrames = 3,
} = {}) {
  const values = [];
  let runsUsed = 0;
  for (const s of series) {
    const runs = staticOnly
      ? staticRuns(s.frames, { staticMove, staticScale, minFrames })
      : (s.frames.length >= minFrames ? [s.frames] : []);
    for (const run of runs) {
      runsUsed++;
      const sc = run.map((f) => f.scale).filter((x) => Number.isFinite(x) && x > 0);
      if (sc.length < minFrames) continue;
      const mean = sc.reduce((x, y) => x + y, 0) / sc.length;
      if (!(mean > 0)) continue;
      const sd = Math.sqrt(sc.reduce((x, y) => x + (y - mean) ** 2, 0) / sc.length);
      values.push(sd / mean > 1e-12 ? sd / mean : 0);
    }
  }
  return { ...summarize(values), runsUsed, values };
}

// —— 真值评分（本轮只提供能力，未采集 GT）——

const normSide = (s) => {
  if (s === 'Left' || s === 'L') return 'L';
  if (s === 'Right' || s === 'R') return 'R';
  return null;
};

/**
 * 真值格式（帧像素，MediaPipe 21 点顺序，t 单位秒）：
 *   { "schema": "handkp-gt v0", "hands": [ { "t": 1.25, "side": "Right", "kp": [[x,y], …] } ] }
 * 也接受 { frames: [ { t, hands:[…] } ] }。
 */
export function loadGT(obj) {
  const flat = [];
  if (Array.isArray(obj)) flat.push(...obj);
  else if (Array.isArray(obj?.hands)) flat.push(...obj.hands);
  else if (Array.isArray(obj?.frames)) {
    for (const f of obj.frames) {
      for (const h of f.hands || []) flat.push({ t: h.t ?? f.t ?? f.video_time, ...h });
    }
  }
  const hands = [];
  const skipped = [];
  for (const h of flat) {
    const kp = h?.kp;
    const s = handScale(kp);
    const side = normSide(h?.side ?? h?.handedness);
    if (!Number.isFinite(h?.t) || !Array.isArray(kp) || kp.length < POINTS || !Number.isFinite(s)) {
      skipped.push(h);
      continue;
    }
    hands.push({ t: h.t * 1000, side, kp });
  }
  return { hands, skipped };
}

/** 每条 GT 按时间最近（|Δt|≤tolMs）匹配一条预测；默认同侧。 */
export function matchGT(series, gtHands, { tolMs = 100, sideAny = false } = {}) {
  const preds = [];
  for (const s of series) for (const f of s.frames) preds.push({ t: f.t, side: f.side, kp: f.kp, track: f.track });
  const pairs = [];
  const unmatched = [];
  let sideMismatch = 0;
  for (const g of gtHands) {
    let best = null;
    let bestDt = Infinity;
    let sawOtherSide = false;
    for (const p of preds) {
      if (!sideAny && g.side && p.side !== g.side) { sawOtherSide = true; continue; }
      const dt = Math.abs(p.t - g.t);
      if (dt <= tolMs && dt < bestDt) { best = p; bestDt = dt; }
    }
    if (best) pairs.push({ gt: g, pred: best, dt: bestDt });
    else { unmatched.push(g); if (sawOtherSide) sideMismatch++; }
  }
  return { pairs, unmatched, sideMismatch };
}

// 与 evaluate.mjs:1228 同式；这里本地实现，避免评测器为一个区间估计去 import 整个评估器。
export function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** PCK@α：`‖p_i − g_i‖ / s_gt ≤ α` 的关节比例（用 GT 尺度归一）。 */
export function pck(pairs, alphas = [0.05, 0.10, 0.15]) {
  const hits = alphas.map(() => Array(POINTS).fill(0));
  const total = Array(POINTS).fill(0);
  let used = 0;
  for (const { gt, pred } of pairs) {
    const s = handScale(gt.kp);
    if (!Number.isFinite(s)) continue;
    used++;
    for (let i = 0; i < POINTS; i++) {
      if (!okPt(gt.kp[i]) || !okPt(pred.kp[i])) continue;
      total[i]++;
      const e = dist(gt.kp[i], pred.kp[i]) / s;
      alphas.forEach((a, k) => { if (e <= a) hits[k][i]++; });
    }
  }
  const grandTotal = total.reduce((x, y) => x + y, 0);
  return {
    pairs: used,
    jointSamples: grandTotal,
    alphas: alphas.map((a, k) => {
      const hit = hits[k].reduce((x, y) => x + y, 0);
      return { alpha: a, hit, total: grandTotal, rate: grandTotal ? hit / grandTotal : NaN, ci: wilson(hit, grandTotal) };
    }),
    perJoint: Array.from({ length: POINTS }, (_, i) => ({
      joint: i,
      total: total[i],
      rate: alphas.map((a, k) => (total[i] ? hits[k][i] / total[i] : NaN)),
    })),
  };
}

/** MPJPE：逐对平均关节误差；归一化（÷s_gt）与原始 px 各一份。 */
export function mpjpe(pairs) {
  const normMeans = [];
  const pxMeans = [];
  const jointSum = Array(POINTS).fill(0);
  const jointN = Array(POINTS).fill(0);
  const scaleRatios = [];
  let used = 0;
  for (const { gt, pred } of pairs) {
    const s = handScale(gt.kp);
    if (!Number.isFinite(s)) continue;
    used++;
    const sp = handScale(pred.kp);
    if (Number.isFinite(sp) && sp > 0) scaleRatios.push(sp / s);
    let sumN = 0;
    let sumPx = 0;
    let n = 0;
    for (let i = 0; i < POINTS; i++) {
      if (!okPt(gt.kp[i]) || !okPt(pred.kp[i])) continue;
      const d = dist(gt.kp[i], pred.kp[i]);
      sumN += d / s;
      sumPx += d;
      jointSum[i] += d / s;
      jointN[i]++;
      n++;
    }
    if (n) { normMeans.push(sumN / n); pxMeans.push(sumPx / n); }
  }
  return {
    pairs: used,
    norm: summarize(normMeans),
    px: summarize(pxMeans),
    perJoint: jointSum.map((s, i) => ({ joint: i, n: jointN[i], mean: jointN[i] ? s / jointN[i] : NaN })),
    scaleRatio: { n: scaleRatios.length, median: percentile(scaleRatios, 0.5) },
  };
}
