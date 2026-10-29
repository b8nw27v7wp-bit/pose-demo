// stats.js — 分布统计（纯函数，浏览器与 Node 通用）
// 只被评估/对比工具使用，不参与实时判定。
// R3 的验收是「同一动作正面/侧面分布重合度可量化」——这个文件提供那个量化口径。

export function mean(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return NaN;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

export function stdev(values) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
}

/** 线性插值分位数（p ∈ [0,1]） */
export function quantile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const q = Math.max(0, Math.min(1, p));
  const h = (v.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return v[lo] + (v[hi] - v[lo]) * (h - lo);
}

export function summarize(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) {
    return { n: 0, mean: NaN, sd: NaN, min: NaN, p5: NaN, p50: NaN, p95: NaN, max: NaN };
  }
  return {
    n: v.length,
    mean: mean(v),
    sd: stdev(v),
    min: Math.min(...v),
    p5: quantile(v, 0.05),
    p50: quantile(v, 0.5),
    p95: quantile(v, 0.95),
    max: Math.max(...v),
  };
}

/**
 * 直方图重合度（overlapping coefficient）：同一组 bin 上两分布密度逐 bin 取小后求和。
 * 1 = 分布完全重合，0 = 完全不重叠。bin 数少一点更稳（样本通常只有几百帧）。
 */
export function overlapCoefficient(a, b, bins = 20) {
  const A = a.filter(Number.isFinite);
  const B = b.filter(Number.isFinite);
  if (!A.length || !B.length) return NaN;
  const all = A.concat(B);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  if (!(hi > lo)) return 1;                      // 两边都是同一个常数
  const nb = Math.max(1, Math.floor(bins));
  const bin = (vals) => {
    const h = new Array(nb).fill(0);
    for (const v of vals) {
      const i = Math.min(nb - 1, Math.floor(((v - lo) / (hi - lo)) * nb));
      h[i] += 1 / vals.length;
    }
    return h;
  };
  const ha = bin(A);
  const hb = bin(B);
  let ovl = 0;
  for (let i = 0; i < nb; i++) ovl += Math.min(ha[i], hb[i]);
  return ovl;
}
