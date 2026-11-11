// accuracy-report.mjs — 把评估结果转成页面可读的 web/accuracy.json
//
// 为什么不让页面自己算：准确率必须来自「标注素材 + evaluate.mjs」，
// 页面只负责显示。这个脚本是两者之间唯一的转换点，保证：
//   1. 动作 id 与 ARM_ACTIONS 对齐（评估器用 flag 名，页面用 id）；
//   2. n 与 95%CI 原样带过去，界面才能先看样本量；
//   3. 合成样例 / 实拍素材的来源标记带过去，避免把自检当成准确率。
//
// 用法：
//   npm run accuracy                     # 读 eval-data/ → web/accuracy.json
//   node web/test/accuracy-report.mjs --dir eval-data --out web/accuracy.json --min-samples 20
//   node web/test/accuracy-report.mjs --dir eval-data/refuel/eval --profile web/profiles/refuel.json
//     ↑ 有 ROI/场景阈值的动作（如 operating）必须带 profile，否则回放时 ROI 缺失、operating 恒为 false

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARM_ACTIONS } from '../js/actions.js';
import { wilson } from './evaluate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_MIN_SAMPLES = 20;

/**
 * @param {object} evalReport evaluate.mjs --json 的输出
 * @param {{dir?:string, minSamples?:number, generatedAt?:string}} opts
 */
/**
 * 按动作把 summary 行合并成一行。多人素材每行带 track，同一动作会有多行；
 * 只按 action 建 Map 会让后一条覆盖前一条，页面显示的就是「最后一个 track 的准确率」。
 * 合并口径是池化 TP/FN/FP（不是平均各 track 的比率），n 与 Wilson 区间按合并后的样本量重算。
 */
function poolByAction(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r || typeof r.action !== 'string') continue;
    if (!groups.has(r.action)) groups.set(r.action, []);
    groups.get(r.action).push(r);
  }
  const by = new Map();
  for (const [action, list] of groups) {
    // 单行（单人素材/旧报告）：原样透传，CI 与 n 一个数都不动。
    if (list.length === 1) { by.set(action, list[0]); continue; }
    const b = { tp: 0, fn: 0, fp: 0 };
    for (const r of list) {
      b.tp += r.tp ?? 0;
      b.fn += r.fn ?? 0;
      b.fp += r.fp ?? 0;
    }
    const nRecall = b.tp + b.fn;
    const nPrecision = b.tp + b.fp;
    const recall = nRecall ? +(b.tp / nRecall).toFixed(3) : null;
    const precision = nPrecision ? +(b.tp / nPrecision).toFixed(3) : null;
    by.set(action, {
      tp: b.tp, fn: b.fn, fp: b.fp, nRecall, nPrecision, recall, precision,
      recallCI: nRecall ? wilson(b.tp, nRecall) : null,
      precisionCI: nPrecision ? wilson(b.tp, nPrecision) : null,
    });
  }
  return by;
}

export function buildAccuracyReport(evalReport, { dir = 'eval-data', minSamples = DEFAULT_MIN_SAMPLES, generatedAt = new Date().toISOString() } = {}) {
  const rows = Array.isArray(evalReport?.summary) ? evalReport.summary : [];
  const byFlag = poolByAction(rows);

  // 评估器的 summary 用 flag 名（armRaised），页面用动作 id（arm_raised）。
  // 在这里映射一次，页面就不需要知道两套命名。
  const actions = {};
  for (const a of ARM_ACTIONS) {
    const row = byFlag.get(a.flag);
    actions[a.id] = row ? {
      tp: row.tp ?? 0,
      fn: row.fn ?? 0,
      fp: row.fp ?? 0,
      nRecall: row.nRecall ?? 0,
      nPrecision: row.nPrecision ?? 0,
      recall: row.recall ?? null,
      precision: row.precision ?? null,
      recallCI: row.recallCI ?? null,
      precisionCI: row.precisionCI ?? null,
    } : null;
  }

  const clips = Array.isArray(evalReport?.clips) ? evalReport.clips : [];
  const names = clips.map((c) => c.clip || c.name).filter(Boolean);
  const text = clips.map((c) => `${c.clip || ''} ${c.note || ''}`).join(' ');
  // 合成样例只用于验证链路（README「开源验证素材」）。标出来，页面才不会把它当实拍准确率。
  const synthetic = /合成|make-sample/i.test(text);
  const noClips = clips.length === 0;

  return {
    generatedAt,
    source: {
      dir,
      clips: names,
      totalFrames: evalReport?.totalFrames ?? 0,
      synthetic,
      note: noClips ? '没有可评估的标注素材（eval-data 为空或没有 *.labels.json）'
        : synthetic ? '合成样例自检，不代表实拍准确率'
          : '来自标注素材的实测值',
    },
    minSamples,
    paramsHash: evalReport?.paramsHash ?? null,
    profile: evalReport?.profile ?? null,
    models: evalReport?.models ?? [],
    objects: evalReport?.objects ?? [],
    objectWarning: evalReport?.objectWarning ?? null,
    actions,
  };
}

function parseArgs(argv) {
  const out = {
    dir: 'eval-data', out: 'web/accuracy.json', minSamples: DEFAULT_MIN_SAMPLES,
    profile: null, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--min-samples') out.minSamples = Number(argv[++i]);
    // 有 ROI/场景阈值的动作（operating、refuel 类 profile）必须带 profile，
    // 否则评估器按默认参数回放，operating 恒为 false（ROI 不知道在哪）。
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log('用法：node web/test/accuracy-report.mjs [--dir eval-data] [--out web/accuracy.json] '
        + '[--min-samples 20] [--profile web/profiles/xxx.json]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }
  if (!out.dir) throw new Error('--dir 需要一个目录');
  if (!out.out) throw new Error('--out 需要一个文件');
  if (!Number.isFinite(out.minSamples) || out.minSamples < 1) throw new Error('--min-samples 必须是正整数');
  return out;
}

function runEvaluator(dir, profile = null) {
  const evalPath = path.join(ROOT, 'web/test/evaluate.mjs');
  const argv = [evalPath, '--dir', dir, '--json'];
  if (profile) argv.push('--profile', profile);
  return new Promise((resolve, reject) => {
    execFile(process.execPath, argv, {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      // 评估器在「有段失败」时也会退出码 2，但 JSON 仍完整；只有拿不到 JSON 才算失败。
      if (!stdout || !stdout.trim()) {
        reject(new Error(stderr?.trim() || err?.message || '评估器没有输出'));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`无法解析评估器输出：${e.message}\n${stdout.slice(0, 300)}`));
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evalReport = await runEvaluator(args.dir, args.profile);
  const report = buildAccuracyReport(evalReport, { dir: args.dir, minSamples: args.minSamples });
  const outPath = path.resolve(ROOT, args.out);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (!args.quiet) {
    const entries = Object.values(report.actions);
    const withData = entries.filter((r) => r && (r.nRecall > 0 || r.nPrecision > 0)).length;
    const enough = entries.filter((r) => r
      && ((r.recall != null && r.nRecall >= args.minSamples)
        || (r.precision != null && r.nPrecision >= args.minSamples))).length;
    console.log(`已写入 ${path.relative(ROOT, outPath)}`);
    console.log(`数据源：${report.source.dir}（${report.source.totalFrames} 帧，${report.source.note}）`);
    console.log(`有数据：${withData}/${entries.length} 个动作；样本充足（n≥${args.minSamples}）：${enough}/${entries.length}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
