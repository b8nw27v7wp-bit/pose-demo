// accuracy.js — 动作准确率的读取与展示口径
//
// 为什么单独一层：页面上显示的「准确率」只能来自**标注数据上的评估结果**，
// 不能由规则自己估。这里只做两件事：读评估器生成的 accuracy.json、把
// recall/precision + 样本量 n 翻译成界面文案。没有数据时明确写「未评估」，
// 绝不拿合成样例或逻辑单测冒充实拍准确率（见 docs/eval.md）。
//
// 文件由 `npm run accuracy`（web/test/accuracy-report.mjs）从 evaluate.mjs 的
// --json 输出生成，格式见该脚本。

/** 每个方向的样本量低于这个数就不报百分比：n=1 的 100% 只会误导人。 */
export const MIN_SAMPLES = 20;

const pct = (v) => `${Math.round(v * 100)}%`;

const ciText = (ci) => (Array.isArray(ci) && ci.length === 2
  ? `${Math.round(ci[0] * 100)}–${Math.round(ci[1] * 100)}%`
  : null);

/**
 * 读取 accuracy.json。文件不存在（404）、格式不对、网络失败都返回 null，
 * 页面照常工作，只是所有动作显示「未评估」。
 */
export async function loadAccuracyReport({
  url = new URL('../accuracy.json', import.meta.url),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' && data.actions && typeof data.actions === 'object'
      ? data : null;
  } catch {
    return null;
  }
}

/** 从报告里取某个动作的指标；没有数据返回 null。 */
export function accuracyFor(report, actionId) {
  const row = report?.actions?.[actionId];
  return row && typeof row === 'object' ? row : null;
}

/**
 * 报告是否和当前参数不是同一套。阈值/hand shape 分组改过之后，
 * 旧报告里的召回/精确率就不再代表当前规则——页面必须提示重跑，而不是继续当真。
 */
export function accuracyStale(report, currentHash) {
  return !!(report?.paramsHash && currentHash && report.paramsHash !== currentHash);
}

/**
 * 颜色档位：达到 PLAN 的验收线（recall ≥0.9、precision ≥0.85）为 good；
 * 明显低于（recall <0.75 或 precision <0.7）为 bad；其余 warn。
 * 只评估**样本足够**的方向，没测的方向不参与。
 */
export function accuracyTier(recall, precision, { recallUsable = recall != null, precisionUsable = precision != null } = {}) {
  const r = recallUsable ? recall : null;
  const p = precisionUsable ? precision : null;
  if (r == null && p == null) return 'none';
  if ((r != null && r < 0.75) || (p != null && p < 0.7)) return 'bad';
  const good = (r == null || r >= 0.9) && (p == null || p >= 0.85);
  return good ? 'good' : 'warn';
}

/**
 * 把一条指标翻译成界面文案。
 * short 给动作列表和提示行（很短）；long 给 tooltip（带 n、95%CI、数据源说明）。
 *
 * @param {object|null} row accuracy.json 里的单动作指标
 * @param {{minSamples?:number, synthetic?:boolean}} opts
 */
export function formatAccuracy(row, { minSamples = MIN_SAMPLES, synthetic = false } = {}) {
  if (!row) {
    return {
      short: '未评估',
      long: `未评估：没有该动作的标注数据（n=0）。按 docs/data-collection.md 采集并标注后，`
        + '运行 npm run accuracy 生成报告。',
      level: 'none', recall: null, precision: null,
    };
  }

  const nR = row.nRecall ?? 0;
  const nP = row.nPrecision ?? 0;
  // 分开判断：召回有 100 帧、精确只有 2 帧反例时，只能报召回。
  const recallUsable = row.recall != null && nR >= minSamples;
  const precisionUsable = row.precision != null && nP >= minSamples;

  const bits = [];
  const detail = [];
  if (recallUsable) {
    bits.push(`召${pct(row.recall)}`);
    const ci = ciText(row.recallCI);
    detail.push(`召回 ${pct(row.recall)}${ci ? `（95%CI ${ci}，n=${nR}）` : `（n=${nR}）`}`);
  } else if (row.recall != null) {
    detail.push(`召回样本不足（n=${nR} < ${minSamples}）`);
  }
  if (precisionUsable) {
    bits.push(`精${pct(row.precision)}`);
    const ci = ciText(row.precisionCI);
    detail.push(`精确 ${pct(row.precision)}${ci ? `（95%CI ${ci}，n=${nP}）` : `（n=${nP}）`}`);
  } else if (row.precision != null) {
    detail.push(`精确样本不足（n=${nP} < ${minSamples}）`);
  } else {
    detail.push('精确未测（没有反例段）');
  }

  if (!bits.length) {
    return {
      short: `样本不足(n=${Math.max(nR, nP)})`,
      long: `样本不足：${detail.join(' · ')}；每个方向至少 ${minSamples} 个样本才报百分比`,
      level: 'none', recall: row.recall, precision: row.precision,
    };
  }

  return {
    short: bits.join(' · '),
    long: detail.join(' · ')
      + (synthetic ? ' · 合成样例自检，不代表实拍准确率' : ' · 来自标注素材的实测值'),
    level: accuracyTier(row.recall, row.precision, { recallUsable, precisionUsable }),
    recall: row.recall,
    precision: row.precision,
  };
}
