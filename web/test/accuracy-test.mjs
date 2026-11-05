// accuracy-test.mjs — 动作准确率的口径与转换（纯函数，不依赖浏览器）
// 运行：node web/test/accuracy-test.mjs
//
// 验证的是「数字从评估报告到界面这一步没有走样」：flag→id 映射、n/CI 保留、
// 样本不足不报百分比、没有数据不编数字。不验证识别本身准不准——那要实拍标注。

import {
  accuracyFor, formatAccuracy, accuracyTier, accuracyStale, loadAccuracyReport, MIN_SAMPLES,
} from '../js/accuracy.js';
import { buildAccuracyReport } from './accuracy-report.mjs';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const evalReport = {
  totalFrames: 900,
  paramsHash: 'fnv1a:test',
  profile: '默认阈值',
  models: ['full/GPU'],
  summary: [
    {
      action: 'armRaised', tp: 40, fn: 5, fp: 3,
      nRecall: 45, nPrecision: 48,
      recall: 0.89, precision: 0.93,
      recallCI: [0.77, 0.95], precisionCI: [0.82, 0.98],
    },
    { action: 'stand', tp: 1, fn: 0, fp: 0, nRecall: 1, nPrecision: 1, recall: 1, precision: 1 },
  ],
  clips: [{ clip: 'a', note: '实拍' }, { clip: 'b', note: '' }],
};

// —— 1. 评估报告 → 页面报告 ——
console.log('\n[1] 报告转换');
const rep = buildAccuracyReport(evalReport, {
  dir: 'eval-data', minSamples: 20, generatedAt: '2026-01-01T00:00:00.000Z',
});
check('flag → 动作 id', rep.actions.arm_raised?.recall === 0.89 && rep.actions.arm_raised?.nRecall === 45);
check('n 与 CI 原样保留',
  rep.actions.arm_raised?.recallCI?.[0] === 0.77 && rep.actions.arm_raised?.nPrecision === 48);
check('未出现的动作是 null', rep.actions.wave === null && rep.actions.point === null);
check('12 个手臂动作全部列出', Object.keys(rep.actions).length === 12);
check('实拍素材不标合成', rep.source.synthetic === false && !/不代表实拍/.test(rep.source.note));
check('minSamples / 参数指纹带入', rep.minSamples === 20 && rep.paramsHash === 'fnv1a:test');

const synth = buildAccuracyReport({
  ...evalReport, clips: [{ clip: 'sample（合成数据，非实拍）', note: '' }],
});
check('合成素材标 synthetic', synth.source.synthetic === true && /不代表实拍/.test(synth.source.note));

const empty = buildAccuracyReport({ summary: [], clips: [], totalFrames: 0 });
check('空素材 → 全部 null 且注明',
  Object.values(empty.actions).every((v) => v === null) && /没有可评估/.test(empty.source.note));

// —— 2. 界面文案 ——
console.log('\n[2] 文案与档位');
const row = rep.actions.arm_raised;
const f = formatAccuracy(row, { minSamples: 20 });
check('样本足够 → 报召回/精确', f.short.includes('召89%') && f.short.includes('精93%'), f.short);
check('召回 0.89 < 0.9 → warn', f.level === 'warn');
check('long 带 n 与 95%CI',
  f.long.includes('n=45') && f.long.includes('95%CI') && f.long.includes('n=48'), f.long);

const good = formatAccuracy({ ...row, recall: 0.95, precision: 0.9 }, { minSamples: 20 });
check('达到验收线 → good', good.level === 'good');
const bad = formatAccuracy({ ...row, recall: 0.6, precision: 0.9 }, { minSamples: 20 });
check('明显偏低 → bad', bad.level === 'bad');
const few = formatAccuracy({ ...row, nRecall: 3, nPrecision: 3 }, { minSamples: 20 });
check('样本不足 → 不报百分比',
  few.short.includes('样本不足') && few.level === 'none' && !few.short.includes('%'), few.short);

const none = formatAccuracy(null);
check('无数据 → 未评估', none.short === '未评估' && none.level === 'none', none.short);
check('未评估讲清怎么生成', /npm run accuracy/.test(none.long));

const onlyRecall = formatAccuracy({ ...row, precision: null, nPrecision: 0 }, { minSamples: 20 });
check('没有反例段 → 只报召回', onlyRecall.short === '召89%' && onlyRecall.level === 'warn', onlyRecall.short);
check('合成来源写进 long',
  formatAccuracy({ ...row, recall: 0.95, precision: 0.9 }, { synthetic: true }).long.includes('合成样例'));

check('默认样本门槛是 20', MIN_SAMPLES === 20);

// —— 3. 档位边界 ——
console.log('\n[3] accuracyTier');
check('两个方向都不可用 → none',
  accuracyTier(null, null, { recallUsable: false, precisionUsable: false }) === 'none');
check('召回 0.9 + 精确 0.85 → good', accuracyTier(0.9, 0.85) === 'good');
check('召回未测、精确 0.6 → bad', accuracyTier(null, 0.6) === 'bad');
check('召回 0.8、精确未测 → warn', accuracyTier(0.8, null) === 'warn');

// —— 4. 查询与加载 ——
console.log('\n[4] 查询与加载');
check('accuracyFor 命中', accuracyFor(rep, 'arm_raised') === rep.actions.arm_raised);
check('accuracyFor 缺失 → null', accuracyFor(rep, 'nope') === null && accuracyFor(null, 'x') === null);
check('参数指纹不一致 → 报告过期', accuracyStale(rep, 'fnv1a:other') === true);
check('参数指纹一致 → 不过期', accuracyStale(rep, 'fnv1a:test') === false);
check('缺报告/缺指纹 → 不判过期', accuracyStale(null, 'fnv1a:x') === false);

const okFetch = async () => ({ ok: true, json: async () => rep });
const loaded = await loadAccuracyReport({ url: 'http://x/accuracy.json', fetchImpl: okFetch });
check('加载有效报告', loaded?.actions?.arm_raised?.recall === 0.89);

const miss = async () => ({ ok: false, json: async () => rep });
check('404 → null', await loadAccuracyReport({ url: 'http://x/a.json', fetchImpl: miss }) === null);

const malformed = async () => ({ ok: true, json: async () => ({ nope: 1 }) });
check('格式不对 → null',
  await loadAccuracyReport({ url: 'http://x/a.json', fetchImpl: malformed }) === null);

const boom = async () => { throw new Error('net'); };
check('网络异常 → null',
  await loadAccuracyReport({ url: 'http://x/a.json', fetchImpl: boom }) === null);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
