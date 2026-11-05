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

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARM_ACTIONS } from '../js/actions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_MIN_SAMPLES = 20;

/**
 * @param {object} evalReport evaluate.mjs --json 的输出
 * @param {{dir?:string, minSamples?:number, generatedAt?:string}} opts
 */
export function buildAccuracyReport(evalReport, { dir = 'eval-data', minSamples = DEFAULT_MIN_SAMPLES, generatedAt = new Date().toISOString() } = {}) {
  const rows = Array.isArray(evalReport?.summary) ? evalReport.summary : [];
  const byFlag = new Map(rows.map((r) => [r.action, r]));

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
    actions,
  };
}

function parseArgs(argv) {
  const out = { dir: 'eval-data', out: 'web/accuracy.json', minSamples: DEFAULT_MIN_SAMPLES, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--min-samples') out.minSamples = Number(argv[++i]);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log('用法：node web/test/accuracy-report.mjs [--dir eval-data] [--out web/accuracy.json] [--min-samples 20]');
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

function runEvaluator(dir) {
  const evalPath = path.join(ROOT, 'web/test/evaluate.mjs');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [evalPath, '--dir', dir, '--json'], {
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
  const evalReport = await runEvaluator(args.dir);
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
