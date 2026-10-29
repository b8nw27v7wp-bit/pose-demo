// eval-test.mjs — 离线评估工具的自测（不依赖浏览器、不依赖实拍素材）
// 运行：node web/test/eval-test.mjs
//
// 这里验证的是**评估器本身对不对**：给它一串已知答案的合成帧，它算出的 recall/precision/
// 计数误差必须符合预期，并且既不能把错的算成对的（抓漏），也不能把对的算成错的（抓错）。
// 它不验证真实场景精度——那需要实拍素材（PLAN §12.3 A）。

import {
  replay, evaluateClip, toTimeline, summarize, toMarkdown,
  autoLabelClip, loadFrames, parseSegment, pairsFromDir,
  wilson, postureConfusion, armCooccurrence, groupSummaries,
  evaluateGates, sweepVariants, diffSummary, compareSummaries, compareSegments,
  temporalStats,
} from './evaluate.mjs';
import { DEFAULT_PARAMS, profileParams, profileName, paramsHash } from '../js/params.js';
import { ARM_ACTIONS } from '../js/actions.js';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// —— 合成帧构造 ---------------------------------------------------------
// 直接产出 Demo 导出格式的记录，这样评估器和真实导出走同一条路径。

const STAND = [
  [100, 50, 1],
  [90, 100, 1], [110, 100, 1],
  [85, 150, 1], [115, 150, 1],
  [80, 200, 1], [120, 200, 1],
  [92, 220, 1], [108, 220, 1],
  [90, 300, 1], [110, 300, 1],
  [88, 380, 1], [112, 380, 1],
];

/**
 * 按深度 t 造蹲姿：0=站立，1=蹲到底。
 * 几何按真实深蹲来：躯干长保持 120（不拉长，否则 scale 会变），髋下沉、膝前移，踝不动。
 */
function squatKp(t) {
  const hipY = 220 + 40 * t;
  const shY = hipY - 120;
  const elbowY = 150 + 40 * t;
  const wristY = 200 + 40 * t;
  const kneeX = 100 + 70 * t;
  const kneeY = 300 + 30 * t;
  return [
    [100, 50 + 40 * t, 1],
    [90, shY, 1], [110, shY, 1],
    [85, elbowY, 1], [115, elbowY, 1],
    [80, wristY, 1], [120, wristY, 1],
    [92, hipY, 1], [108, hipY, 1],
    [kneeX - 10, kneeY, 1], [kneeX + 10, kneeY, 1],
    [88, 380, 1], [112, 380, 1],
  ];
}

function frame(ts, kp, score = 0.92) {
  const xs = kp.map((p) => p[0]);
  const ys = kp.map((p) => p[1]);
  return {
    ts: Math.round(ts),
    person_count: 1,
    persons: [{
      track_id: 0,
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      kp_format: 'mediapipe33',
      kp,
      scale: 127,
      score,
    }],
    signals: null,
    actions: null,
  };
}

const rep = (v) => (v ? 1 : 0);
void rep;

// 双臂上举的合成骨架：腕高于肩 40px（scale=120，举手余量 0.15·scale=18）
const RAISED = STAND.map((p) => [...p]);
RAISED[5] = [80, 60, 1];
RAISED[6] = [120, 60, 1];

/** 站 1s → 蹲 1s → 站起 1s，返回帧与结束时间；用于计数与自动标注的用例 */
function squatClip(n = 10) {
  const recs = [];
  let t = 0;
  for (let i = 0; i < n; i++) recs.push(frame(t += 100, STAND));
  for (let i = 0; i < n; i++) recs.push(frame(t += 100, squatKp(1)));
  for (let i = 0; i < n; i++) recs.push(frame(t += 100, STAND));
  return { recs, end: t };
}

/** 叉腰的合成骨架：腕贴髋 + 肘明显外张（只判腕距会把自然下垂也算成叉腰） */
const ONHIPS = STAND.map((p) => [...p]);
ONHIPS[3] = [30, 150, 1];
ONHIPS[4] = [170, 150, 1];

// —— 1. 静态姿态：标对了要给分，标错了要扣分 -----------------------------
console.log('\n[1] 静态姿态评估');
{
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(frame(i * 100, STAND));   // 6 秒站立
  const tl = replay(recs);
  const last = tl[tl.length - 1];
  check('复算出站立', last.act.postureId === 'stand', `posture=${last.act.postureId}`);

  const good = evaluateClip(recs, {
    segments: [{ action: 'stand', start: 1500, end: 5500 }],
  }, tl);
  check('标注正确 → 通过', good.segments[0].pass === true);

  const wrong = evaluateClip(recs, {
    segments: [{ action: 'lying', start: 1500, end: 5500 }],
  }, tl);
  check('标注错误 → 不通过（抓漏）', wrong.segments[0].pass === false);

  const noneWrong = evaluateClip(recs, {
    segments: [{ action: 'none', start: 1500, end: 5500 }],
  }, tl);
  check('站着却标"无动作" → 不通过（抓错）', noneWrong.segments[0].pass === false);
}

// —— 2. 重复计数：一次深蹲必须计 1 ---------------------------------------
console.log('\n[2] 深蹲计数评估');
{
  // 站立 1s → 蹲 1s → 站起 1s，共 3 秒，应计 1 次
  const recs = [];
  let t = 0;
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, squatKp(1)));
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));

  const tl = replay(recs);
  const sq = tl[tl.length - 1].act.reps.squat;
  check('复算出 1 次深蹲', sq === 1, `squat=${sq}`);

  const ok = evaluateClip(recs, { segments: [{ action: 'squat', start: 0, end: t, count: 1 }] }, tl);
  check('标 1 次 → 通过', ok.segments[0].pass === true, `got=${ok.segments[0].got}`);

  const bad = evaluateClip(recs, { segments: [{ action: 'squat', start: 0, end: t, count: 3 }] }, tl);
  check('标 3 次 → 不通过', bad.segments[0].pass === false, `got=${bad.segments[0].got}`);

  // 门控：蹲下去但腿变水平（像坐），不该计数
  const sitRecs = [];
  t = 0;
  for (let i = 0; i < 10; i++) sitRecs.push(frame(t += 100, STAND));
  for (let i = 0; i < 10; i++) {
    const kp = squatKp(1);
    // 把踝拉到和髋一样高 → leg_vertical ≈ 0（坐姿/腿水平）
    kp[11] = [88, kp[7][1], 1];
    kp[12] = [112, kp[8][1], 1];
    sitRecs.push(frame(t += 100, kp));
  }
  for (let i = 0; i < 10; i++) sitRecs.push(frame(t += 100, STAND));
  const sitTl = replay(sitRecs);
  check('腿水平的下蹲过程不计深蹲', sitTl[sitTl.length - 1].act.reps.squat === 0,
    `squat=${sitTl[sitTl.length - 1].act.reps.squat}`);
}

// —— 3. 汇总指标：命中与漏判要能区分 -------------------------------------
console.log('\n[3] 逐段判定');
{
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(frame(i * 100, STAND));
  const tl = replay(recs);

  const c1 = evaluateClip(recs, { name: 'a', segments: [{ action: 'stand', start: 1000, end: 2000 }] }, tl);
  const c2 = evaluateClip(recs, { name: 'b', segments: [{ action: 'lying', start: 3000, end: 4000 }] }, tl);

  check('stand 命中', c1.segments[0].pass === true);
  check('lying 漏判', c2.segments[0].pass === false);
}

// —— 4. 空帧 / 未检出人体不能崩 ------------------------------------------
console.log('\n[4] 边界');
{
  const recs = [
    frame(0, STAND),
    { ts: 100, person_count: 0, persons: [], signals: null, actions: null },
    frame(200, STAND),
  ];
  const tl = replay(recs);
  check('未检出人体的帧标记为空', tl[1].empty === true);
  check('未检出后仍能继续复算', tl[2].act && tl[2].act.postureId !== undefined);
}

// 5. profile 覆盖默认参数后确实生效 --------------------------------------
console.log('\n[5] profile 覆盖');
{
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(frame(i * 100, STAND));

  // 把站立门控的膝角阈值抬到 200（不可能达到）→ 站着也判不出站立
  const strict = {
    actions: { posture: { stand: { ...DEFAULT_PARAMS.actions.posture.stand, kneeGt: 200 } } },
  };
  const tl = replay(recs, strict);
  check('抬高阈值后站姿判不出', tl[tl.length - 1].act.postureId !== 'stand',
    `posture=${tl[tl.length - 1].act.postureId}`);

  const tlDefault = replay(recs);
  check('默认参数仍判出站立', tlDefault[tlDefault.length - 1].act.postureId === 'stand');
}

// —— 6. 时间写法：秒数 / 毫秒 / 帧号三种标注等价 --------------------------
console.log('\n[6] 标注时间基准');
{
  // 造带 video_time 的帧：每帧 100ms，第 i 帧 video_time = i*0.1
  const recs = [];
  for (let i = 0; i < 60; i++) {
    const f = frame(5000 + i * 100, STAND);   // ts 故意从 5000 起，与 video_time 不同基准
    f.video_time = +(i * 0.1).toFixed(2);
    recs.push(f);
  }
  const tl = replay(recs);

  const bySec = evaluateClip(recs, { segments: [{ action: 'stand', startSec: 1.0, endSec: 4.0 }] }, tl);
  check('秒数标注能命中站立', bySec.segments[0].pass === true);

  const bySecMiss = evaluateClip(recs, { segments: [{ action: 'lying', startSec: 1.0, endSec: 4.0 }] }, tl);
  check('秒数标注能判出漏判', bySecMiss.segments[0].pass === false);

  const byFrame = evaluateClip(recs, { segments: [{ action: 'stand', startFrame: 10, endFrame: 40 }] }, tl);
  check('帧号标注能命中站立', byFrame.segments[0].pass === true);

  // 无 video_time 时 startSec 退回「相对首帧偏移」，不应崩
  const plain = [];
  for (let i = 0; i < 60; i++) plain.push(frame(5000 + i * 100, STAND));
  const tlPlain = replay(plain);
  const fallback = evaluateClip(plain, { segments: [{ action: 'stand', startSec: 1.0, endSec: 4.0 }] }, tlPlain);
  check('无 video_time 时秒数仍可用（相对首帧）', fallback.segments[0].pass === true);
}

// —— 7. 时间线输出：给标注用，必须含判定与秒数 ---------------------------
console.log('\n[7] 时间线输出');
{
  const recs = [];
  for (let i = 0; i < 30; i++) {
    const f = frame(i * 100, STAND);
    f.video_time = +(i * 0.1).toFixed(2);
    recs.push(f);
  }
  const text = toTimeline(recs, replay(recs), 10);
  check('时间线含表头', text.includes('视频秒') && text.includes('姿态'));
  check('时间线行数受 --every 控制', text.split('\n').length === 5, `lines=${text.split('\n').length}`);
  check('时间线含判定结果', /stand|—/.test(text));
}

void rep;
// —— 8. 回归：代码审查发现的 10 条 ——
console.log('\n[8] 回归（审查修复）');
{
  // 8.1 profile 解包：{name, params} 与裸参数必须等价
  const wrapped = { name: 'fit', params: { actions: { posture: { stand: { kneeGt: 999 } } } } };
  check('profileParams 解开 params 包装',
    profileParams(wrapped).actions.posture.stand.kneeGt === 999);
  check('profileParams 接受裸参数',
    profileParams({ actions: { posture: { stand: { kneeGt: 1 } } } }).actions.posture.stand.kneeGt === 1);
  check('profileName 取 name', profileName(wrapped) === 'fit');
  check('profileName 缺省回退', profileName({}, 'x') === 'x');

  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(frame(i * 100, STAND));
  // 关键：用 profileParams 解包后的值喂 replay，必须真的影响判定
  const strict = replay(recs, profileParams(wrapped));
  check('解包后的 profile 真的生效', strict[strict.length - 1].act.postureId !== 'stand',
    `posture=${strict[strict.length - 1].act.postureId}`);

  // 8.2 FLAG_IDS 从 ARM_ACTIONS 派生：新增动作必须在可评估列表里
  const tl0 = replay(recs);
  for (const id of ['bothHandsUp', 'handAtHead']) {
    const r = evaluateClip(recs, { segments: [{ action: id, start: 0, end: 6000 }] }, tl0);
    check(`${id} 可被标注（不是未知动作）`, r.segments[0].type !== 'unknown',
      `type=${r.segments[0].type}`);
  }
  // 每个登记的手臂动作都必须能映射成 flag，否则评估器标注不了它
  for (const a of ARM_ACTIONS) {
    const r = evaluateClip(recs, { segments: [{ action: a.id, start: 0, end: 6000 }] }, tl0);
    check(`动作 ${a.id} 可被评估器识别`, r.segments[0].type !== 'unknown',
      `type=${r.segments[0].type}`);
  }

  // 8.3 precision 归因：none 段的误报要记到真正误报的动作上
  const c = evaluateClip(recs, {
    name: 'fp',
    segments: [{ action: 'stand', start: 0, end: 2000 }, { action: 'none', start: 2000, end: 5000 }],
  }, tl0);
  check('none 段记录了误报来源', Array.isArray(c.segments[1].fail?.falseAlarms)
    && c.segments[1].fail.falseAlarms.includes('stand'), `alarms=${JSON.stringify(c.segments[1].fail?.falseAlarms)}`);

  // 8.4 kp_world 透传：有 world 的导出必须让 replay 走 3D
  const withWorldFrames = recs.map((f) => ({
    ...f,
    persons: [{ ...f.persons[0], kp_world: new Array(33).fill([0, 0, 0]) }],
  }));
  const tlW = replay(withWorldFrames);
  check('导出带 kp_world → replay 的 has_world 为真', tlW[0].sig.armPose.has_world === true);
  check('不带 kp_world → has_world 为假', tl0[0].sig.armPose.has_world === false);
}

// —— 9. 输入格式：JSON / JSONL / 裸数组 ——
console.log('\n[9] 输入格式');
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evalfmt-'));
  const recs = [];
  for (let i = 0; i < 5; i++) recs.push(frame(i * 100, STAND));
  try {
    const jsonl = path.join(dir, 'a.jsonl');
    await writeFile(jsonl,
      `${JSON.stringify({ schema: 'frame.jsonl v0', frame_count: 5 })}\n`
      + recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    // 直接调 CLI 太重，这里验证解析逻辑经过 CLI 走：用 --timeline 的输出行数
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath,
      [path.join(process.cwd(), 'web/test/evaluate.mjs'), '--input', jsonl, '--timeline'],
      { encoding: 'utf8' });
    check('JSONL 能解析（不抛异常）', out.includes('帧数 5'), out.split('\n')[1] || '');
    check('JSONL 的 meta 行被跳过', !out.includes('(未检出)') || out.split('\n').length >= 5);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// —— 10. 目录配对：.jsonl 要认，manifest.json / 草稿 labels 不能当帧 ——
console.log('\n[10] pairsFromDir');
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evalpair-'));
  try {
    for (const [name, body] of [
      ['a.jsonl', '{"ts":0}\n'],
      ['a.labels.json', '{"segments":[]}'],
      ['b.frames.json', '{"frames":[]}'],
      ['b.labels.json', '{"segments":[]}'],
      ['c.jsonl', '{"ts":0}\n'],
      ['manifest.json', '{"version":1,"clips":[]}'],
      ['d.labels.draft.json', '{"segments":[]}'],
    ]) await writeFile(path.join(dir, name), body);

    const pairs = await pairsFromDir(dir);
    const names = pairs.map((p) => path.basename(p.frames)).sort();
    check('识别 .jsonl 帧', names.includes('a.jsonl'));
    check('识别 *.frames.json 帧', names.includes('b.frames.json'));
    check('manifest.json 不当帧', !names.includes('manifest.json'));
    check('labels.draft 不当帧', !names.includes('d.labels.draft.json'));
    check('同名 labels 正确配对', pairs.find((p) => p.frames.endsWith('a.jsonl'))?.labels
      === path.join(dir, 'a.labels.json'));
    check('没有同名 labels 也保留（由评估器报缺）', pairs.find((p) => p.frames.endsWith('c.jsonl'))?.labels === null);
    check('总对数正确', names.length === 3, names.join(','));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// —— 10. 参数指纹：同一套参数必须得到同一个指纹 ——
console.log('\n[10] 参数指纹');
{
  const a = paramsHash();
  check('默认参数指纹稳定', a === paramsHash({}), a);
  check('覆盖值等于默认 → 指纹不变', paramsHash({ signals: { visMin: DEFAULT_PARAMS.signals.visMin } }) === a);
  const x = { actions: { posture: { stand: { kneeGt: 200, minMs: 350 } } } };
  const y = { actions: { posture: { stand: { minMs: 350, kneeGt: 200 } } } };
  check('键顺序不同 → 指纹相同', paramsHash(x) === paramsHash(y));
  check('数值变一个 → 指纹就变', paramsHash(x) !== a);
  check('指纹格式可读', /^fnv1a:[0-9a-f]{8}$/.test(a), a);
}

// —— 11. 负例语法：!动作 / expect:false / noArm ——
console.log('\n[11] 负例语法');
{
  check('!动作 解析为反例', (() => {
    const p = parseSegment({ action: '!onHips' });
    return p.action === 'onHips' && p.expect === false;
  })());
  check('expect:false 等价', parseSegment({ action: 'onHips', expect: false }).expect === false);
  check('noArm 即使写 expect:true 也按反例', parseSegment({ action: 'noArm', expect: true }).expect === false);
  check('默认是正例', parseSegment({ action: 'stand' }).expect === true);

  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(frame(i * 100, STAND));
  const tl = replay(recs);

  const negHips = evaluateClip(recs, { segments: [{ action: '!onHips', start: 0, end: 6000 }] }, tl);
  check('站着没叉腰 → 反例通过', negHips.segments[0].pass === true, `pass=${negHips.segments[0].pass}`);

  const negStand = evaluateClip(recs, { segments: [{ action: '!stand', start: 1000, end: 5000 }] }, tl);
  check('站着却标 !stand → 不通过', negStand.segments[0].pass === false);
  check('反例误报归到 stand', negStand.segments[0].fail.falseAlarms.includes('stand'));

  const noArmOk = evaluateClip(recs, { segments: [{ action: 'noArm', start: 0, end: 6000 }] }, tl);
  check('noArm 允许站立 → 通过', noArmOk.segments[0].pass === true);

  const raised = recs.map((f) => ({ ...f, persons: [{ ...f.persons[0], kp: RAISED }] }));
  const tlRaised = replay(raised);
  check('举手的合成帧确实判出 armRaised', tlRaised[tlRaised.length - 1].act.flags.armRaised === true);
  const noArmBad = evaluateClip(raised, { segments: [{ action: 'noArm', start: 0, end: 6000 }] }, tlRaised);
  check('举着手标 noArm → 不通过', noArmBad.segments[0].pass === false);
  check('noArm 的误报归到 armRaised', noArmBad.segments[0].fail.falseAlarms.includes('armRaised'));
  check('noArm 不把站立算成误报', !noArmBad.segments[0].fail.falseAlarms.includes('stand'));

  // 单动作反例只把目标动作记成 FP，不牵连同时成立的 stand
  const hips = recs.map((f) => ({ ...f, persons: [{ ...f.persons[0], kp: ONHIPS }] }));
  const tlHips = replay(hips);
  check('叉腰的合成帧确实判出 onHips', tlHips[tlHips.length - 1].act.flags.onHips === true);
  const negHipsBad = evaluateClip(hips, { segments: [{ action: '!onHips', start: 0, end: 6000 }] }, tlHips);
  check('叉腰时标 !onHips → 不通过', negHipsBad.segments[0].pass === false);
  check('单动作反例只记 onHips 一个误报',
    JSON.stringify(negHipsBad.segments[0].fail.falseAlarms) === '["onHips"]',
    `alarms=${JSON.stringify(negHipsBad.segments[0].fail.falseAlarms)}`);
  check('不把 stand 的 precision 一起拉低',
    summarize([negHipsBad]).every((r) => r.action !== 'stand'));
}

// —— 12. 计数误报：反例段与 none 窗口都要归因 ——
console.log('\n[12] 计数误报归因');
{
  const { recs, end } = squatClip();
  const tl = replay(recs);

  const neg = evaluateClip(recs, { segments: [{ action: '!squat', start: 0, end }] }, tl);
  check('!squat 在真有一次深蹲时失败', neg.segments[0].pass === false && neg.segments[0].got === 1,
    `got=${neg.segments[0].got}`);
  const row = summarize([neg]).find((r) => r.action === 'squat');
  check('反例计数的增量记为 squat 的 FP', row?.fp === 1, `fp=${row?.fp}`);

  const noneClip = evaluateClip(recs, { segments: [{ action: 'none', start: 0, end }] }, tl);
  check('none 段记录窗口内的计数误报', noneClip.segments[0].repFalseAlarms?.squat === 1,
    `repFP=${JSON.stringify(noneClip.segments[0].repFalseAlarms)}`);
  const row2 = summarize([noneClip]).find((r) => r.action === 'squat');
  check('汇总把 none 窗口的乱计数记到 squat 的 FP', row2?.fp === 1, `fp=${row2?.fp}`);

  // 手臂反例不替计数背锅：!onHips 窗口里发生深蹲，不应算 squat 的 FP
  const armNeg = evaluateClip(recs, { segments: [{ action: '!onHips', start: 0, end }] }, tl);
  check('手臂反例不算计数的 FP', !armNeg.segments[0].repFalseAlarms,
    `repFP=${JSON.stringify(armNeg.segments[0].repFalseAlarms)}`);
}

// —— 13. 失败区间：起止、帧号、关键信号极值 ——
console.log('\n[13] 失败区间');
{
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(frame(i * 100, STAND));
  const tl = replay(recs);

  const fn = evaluateClip(recs, { segments: [{ action: 'lying', start: 2000, end: 4000 }] }, tl);
  const seg = fn.segments[0];
  check('漏判带上帧区间', seg.pass === false && Array.isArray(seg.fail.frames)
    && seg.fail.frames[1] >= seg.fail.frames[0], `frames=${JSON.stringify(seg.fail.frames)}`);
  check('失败区间带相对秒数', Number.isFinite(seg.fail.sec?.[0]) && Number.isFinite(seg.fail.sec?.[1]));
  check('失败区间带关键信号极值', Number.isFinite(seg.fail.signals?.uprightness?.min),
    `signals=${JSON.stringify(seg.fail.signals)}`);
  check('漏判记录当时实际判成什么', seg.fail.observed.includes('stand'),
    `observed=${JSON.stringify(seg.fail.observed)}`);

  const fp = evaluateClip(recs, { segments: [{ action: '!stand', start: 2000, end: 4000 }] }, tl);
  const s2 = fp.segments[0];
  check('误报带上帧区间与来源', s2.pass === false && Array.isArray(s2.fail.frames)
    && s2.fail.falseAlarms.includes('stand'));
  check('误报区间落在标注窗口内', s2.fail.sec[0] >= 1.9 && s2.fail.sec[1] <= 4.2,
    `sec=${JSON.stringify(s2.fail.sec)}`);
}

// —— 14. 自动标注草稿 ——
console.log('\n[14] 自动标注');
{
  const { recs } = squatClip();
  const tl = replay(recs);
  const draft = autoLabelClip(recs, tl, { name: 'auto' });

  check('草稿有名字与说明', draft.name === 'auto' && draft.note.includes('反例'));
  check('草稿含姿态段', draft.segments.some((s) => s.action === 'stand'));
  check('草稿含计数段且次数对', draft.segments.some((s) => s.action === 'squat' && s.count === 1),
    `seg=${JSON.stringify(draft.segments.filter((s) => s.action === 'squat'))}`);
  check('草稿只写正例（无反例段）', draft.segments.every((s) => !String(s.action).startsWith('!')
    && s.action !== 'none' && s.action !== 'noArm'));

  // 自评：草稿由当前规则生成，拿同一套规则打分必须全部通过（否则说明草稿的时间边界写错了）
  const self = evaluateClip(recs, draft, tl);
  const bad = self.segments.filter((s) => !s.pass);
  check('草稿自评全通过', bad.length === 0,
    `bad=${JSON.stringify(bad.map((b) => [b.action, b.type, b.want, b.got]))}`);
}

// —— 15. 元数据与报告回显 ——
console.log('\n[15] 元数据与报告');
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evalmeta-'));
  const recs = [];
  for (let i = 0; i < 5; i++) recs.push(frame(i * 100, STAND));
  try {
    const jsonl = path.join(dir, 'm.jsonl');
    const meta = {
      schema: 'frame.jsonl v0', model: 'full', delegate: 'GPU',
      profile: 'fitness', profile_model: 'lite', params_hash: 'fnv1a:deadbeef', frame_count: 5,
    };
    await writeFile(jsonl,
      `${JSON.stringify(meta)}\n${recs.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const loaded = await loadFrames(jsonl);
    check('JSONL 的 meta 被收进 frames.meta', loaded.meta?.model === 'full'
      && loaded.meta?.delegate === 'GPU' && loaded.meta?.params_hash === 'fnv1a:deadbeef');
    check('meta 行不进入帧数组', loaded.length === 5, `len=${loaded.length}`);

    const wrapped = path.join(dir, 'w.json');
    await writeFile(wrapped, JSON.stringify({ model: 'lite', frames: recs }), 'utf8');
    const loaded2 = await loadFrames(wrapped);
    check('{frames:[...]} 容器的 meta 也能读到', loaded2.meta?.model === 'lite' && loaded2.length === 5);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const recs2 = [];
  for (let i = 0; i < 60; i++) recs2.push(frame(i * 100, STAND));
  const tl = replay(recs2);
  const clip = evaluateClip(recs2, {
    name: 'r', camera: 'side', subject: '甲',
    segments: [{ action: 'lying', start: 1000, end: 4000 }],
  }, tl);
  const md = toMarkdown({
    clips: [clip], totalFrames: recs2.length, profile: 'p', profileModel: 'lite',
    models: ['full/GPU'], modelWarning: 'profile 声明 model=lite，数据实际为 full/GPU',
    summary: summarize([clip]), fit: null,
  });
  check('报告回显数据模型', md.includes('数据模型：full/GPU'));
  check('报告回显模型不一致警告', md.includes('⚠') && md.includes('model=lite'));
  check('报告带机位/受试', md.includes('机位 side') && md.includes('受试 甲'));
  check('报告含失败区间表', md.includes('关键信号（min/中位/max）') && md.includes('期望出现，实测未出现'));
}

// —— 16. --dir 必须能捡到 .jsonl（当前导出格式），并回显模型不一致 ——
console.log('\n[16] --dir 与 JSONL');
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evaldir-'));
  const recs = [];
  for (let i = 0; i < 30; i++) recs.push(frame(i * 100, STAND));
  try {
    const meta = { schema: 'frame.jsonl v0', model: 'full', delegate: 'GPU', frame_count: recs.length };
    await writeFile(path.join(dir, 'a.jsonl'),
      `${JSON.stringify(meta)}\n${recs.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    await writeFile(path.join(dir, 'a.labels.json'),
      JSON.stringify({ name: 'a', segments: [{ action: 'stand', start: 500, end: 2500 }] }), 'utf8');

    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath,
      [path.join(process.cwd(), 'web/test/evaluate.mjs'), '--dir', dir,
        '--profile', path.join(process.cwd(), 'web/profiles/fitness.json'), '--json', '--quiet'],
      { encoding: 'utf8' });
    const report = JSON.parse(out);
    check('--dir 能评估 .jsonl 素材', report.clips.length === 1 && report.clips[0].clip === 'a',
      `clips=${report.clips.length}`);
    check('报告带数据实际模型', report.models.includes('full/GPU'), `models=${JSON.stringify(report.models)}`);
    check('profile 与数据模型不一致时给出警告', typeof report.modelWarning === 'string'
      && report.modelWarning.includes('model=lite'), `warn=${report.modelWarning}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// —— 11. 负例语法：!动作 / expect:false ——
console.log('\n[11] 负例语法');
{
  const standRecs = [];
  for (let i = 0; i < 40; i++) standRecs.push(frame(i * 100, STAND));
  const tlStand = replay(standRecs);

  const bang = evaluateClip(standRecs, {
    segments: [{ action: '!stand', start: 500, end: 3000 }],
  }, tlStand);
  check('!stand 在站立段 → 不通过', bang.segments[0].pass === false);

  const expectFalse = evaluateClip(standRecs, {
    segments: [{ action: 'stand', expect: false, start: 500, end: 3000 }],
  }, tlStand);
  check('expect:false 等价于 !stand', expectFalse.segments[0].pass === false);

  const sumStand = summarize([bang]).find((r) => r.action === 'stand');
  check('反例失败记 FP，不记 FN/TP',
    sumStand.fp === 1 && sumStand.fn === 0 && sumStand.tp === 0, JSON.stringify(sumStand));
  check('反例不进 recall 分母', sumStand.recall === null);
  check('反例进 precision 分母', sumStand.precision === 0, `precision=${sumStand.precision}`);

  // 纯下蹲段：stand 不成立，!stand 应通过（TN）
  const squatRecs = [];
  for (let i = 0; i < 40; i++) squatRecs.push(frame(i * 100, squatKp(1)));
  const tlSquat = replay(squatRecs);
  const negPass = evaluateClip(squatRecs, {
    segments: [{ action: '!stand', start: 2000, end: 3500 }],
  }, tlSquat);
  check('!stand 在非站立段 → 通过', negPass.segments[0].pass === true);

  // 计数反例：!squat 期望 0 次
  const negRepOk = evaluateClip(standRecs, {
    segments: [{ action: '!squat', start: 0, end: 3000 }],
  }, tlStand);
  check('!squat 0 次 → 通过', negRepOk.segments[0].pass === true);

  const repRecs = [];
  let t = 0;
  for (let i = 0; i < 10; i++) repRecs.push(frame(t += 100, STAND));
  for (let i = 0; i < 10; i++) repRecs.push(frame(t += 100, squatKp(1)));
  for (let i = 0; i < 10; i++) repRecs.push(frame(t += 100, STAND));
  const tlRep = replay(repRecs);
  const negRepBad = evaluateClip(repRecs, {
    segments: [{ action: '!squat', start: 0, end: t }],
  }, tlRep);
  check('!squat 出现 1 次 → 不通过', negRepBad.segments[0].pass === false
    && negRepBad.segments[0].want === 0 && negRepBad.segments[0].got === 1,
  JSON.stringify(negRepBad.segments[0]));
  const sumRep = summarize([negRepBad]).find((r) => r.action === 'squat');
  check('计数反例失败记 FP', sumRep.fp === 1 && sumRep.fn === 0, JSON.stringify(sumRep));
}

// —— 17. Wilson 区间 ——
console.log('\n[17] Wilson 区间');
{
  check('n=0 → null', wilson(0, 0) === null);
  const w0 = wilson(0, 10);
  check('0/10 下界为 0', w0[0] === 0 && w0[1] > 0 && w0[1] < 0.5, `ci=${JSON.stringify(w0)}`);
  const w10 = wilson(10, 10);
  check('10/10 上界为 1', w10[1] === 1 && w10[0] > 0.5, `ci=${JSON.stringify(w10)}`);
  const narrow = wilson(5, 100), wide = wilson(5, 10);
  check('区间随 n 收窄', (narrow[1] - narrow[0]) < (wide[1] - wide[0]));
  check('区间不越界', [wilson(1, 3), wilson(2, 3), wilson(0, 100)].every(
    ([lo, hi]) => lo >= 0 && hi <= 1 && lo <= hi));
}

// —— 18. 汇总行带样本量与 CI ——
console.log('\n[18] 汇总的样本量');
{
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(frame(i * 100, STAND));
  const tl = replay(recs);
  const clip = evaluateClip(recs, { segments: [{ action: 'stand', start: 1000, end: 5000 }] }, tl);
  const row = summarize([clip]).find((r) => r.action === 'stand');
  check('row 带 recall 的 n', row.nRecall === 1, `n=${row.nRecall}`);
  check('row 带 precision 的 n', row.nPrecision === 1, `n=${row.nPrecision}`);
  check('row 带 recall CI', Array.isArray(row.recallCI) && row.recallCI.length === 2);
  check('row 带 precision CI', Array.isArray(row.precisionCI) && row.precisionCI.length === 2);
  check('n=1 时 CI 不会给出 1.00 的确定感', row.recallCI[0] < 0.5 && row.recallCI[1] === 1,
    `ci=${JSON.stringify(row.recallCI)}`);
}

// —— 19. 姿态混淆矩阵与手臂共现 ——
console.log('\n[19] 混淆矩阵');
{
  const recs = [];
  let t = 0;
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, squatKp(1)));
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));
  recs.push({ ts: t + 100, person_count: 0, persons: [], signals: null, actions: null });
  const tl = replay(recs);

  const labels = {
    segments: [
      { action: 'stand', start: 0, end: 900 },
      { action: 'squat_static', start: 1000, end: 2000 },
      { action: 'stand', start: 2100, end: 2900 },
      { action: 'none', start: 3000, end: 3900 },
      { action: '!stand', start: 3950, end: 4050 },
      { action: 'stand', start: 4000, end: 4200 },
    ],
  };
  const conf = postureConfusion(tl, labels, recs);
  const idx = (name) => conf.labels.indexOf(name);
  check('矩阵是 5×5 且标签固定', conf.labels.length === 5 && conf.matrix.length === 5
    && conf.matrix.every((r) => r.length === 5));
  check('统计到姿态帧', conf.frames > 0, `frames=${conf.frames}`);
  check('stand 行对角线最大', conf.matrix[idx('stand')][idx('stand')]
    >= Math.max(...conf.matrix[idx('stand')]));
  check('none 段被站姿误判会进入 none 行', conf.matrix[idx('none')][idx('stand')] > 0,
    `row=${JSON.stringify(conf.matrix[idx('none')])}`);
  check('!姿态 反例不计入真值', conf.negatedSkipped > 0, `skipped=${conf.negatedSkipped}`);
  check('未检出帧被跳过', conf.emptySkipped >= 1, `empty=${conf.emptySkipped}`);

  // 同一帧被标成两个姿态 → 冲突，跳过（这是标注错误，不是模型错误）
  const clash = postureConfusion(tl, {
    segments: [{ action: 'stand', start: 1000, end: 3000 }, { action: 'lying', start: 2000, end: 4000 }],
  }, recs);
  check('重叠标注记为冲突', clash.ambiguous > 0, `ambiguous=${clash.ambiguous}`);

  const raisedRecs = [];
  for (let i = 0; i < 30; i++) raisedRecs.push(frame(i * 100, RAISED));
  const arms = armCooccurrence(replay(raisedRecs));
  const ai = arms.labels.indexOf('armRaised');
  check('手臂共现对角线有计数', arms.matrix[ai][ai] > 0, `n=${arms.matrix[ai][ai]}`);
  check('共现矩阵与标签等长', arms.matrix.length === arms.labels.length);
}

// —— 20. 分组统计与门槛 ——
console.log('\n[20] 分组与门槛');
{
  const standRecs = [];
  for (let i = 0; i < 60; i++) standRecs.push(frame(i * 100, STAND));
  const squatRecs = [];
  for (let i = 0; i < 60; i++) squatRecs.push(frame(i * 100, squatKp(1)));
  const tlStand = replay(standRecs);
  const tlSquat = replay(squatRecs);
  const seg = (action) => ({ segments: [{ action, start: 0, end: 5000 }] });

  const cSide = evaluateClip(standRecs, { name: 'a', camera: 'side', ...seg('stand') }, tlStand);
  const cFront = evaluateClip(squatRecs, { name: 'b', camera: 'front', ...seg('stand') }, tlSquat);
  const cNoCam = evaluateClip(standRecs, { name: 'c', ...seg('stand') }, tlStand);

  const g = groupSummaries([cSide, cFront, cNoCam], 'camera');
  check('按机位分成三组（含未标注）', g.groups.length === 3,
    `groups=${g.groups.map((x) => x.name)}`);
  check('未标注组排在最后', g.groups[g.groups.length - 1].name === '(未标注)');
  const dStand = g.degradation.find((d) => d.action === 'stand');
  check('跨机位退化算出 recall 极差 1', dStand?.recallSpread === 1,
    `deg=${JSON.stringify(dStand)}`);
  check('未标注组不参与极差', dStand?.groups === 2, `groups=${dStand?.groups}`);

  const rows = summarize([cSide, cFront]);
  const gate = evaluateGates(rows, { minRecall: 0.9 });
  check('绝对门槛抓出 stand recall 0.5', !gate.passed
    && gate.violations.some((v) => v.action === 'stand' && v.metric === 'recall'));
  check('未配置门槛时默认通过', evaluateGates(rows, {}).configured === false
    && evaluateGates(rows, {}).passed === true);

  const base = { summary: [{ action: 'stand', recall: 1, precision: 1 }] };
  const bGate = evaluateGates(rows, { baseline: base, maxDrop: 0.05 });
  check('相对基线下降触发失败', !bGate.passed
    && bGate.violations.some((v) => v.kind === 'baseline' && v.metric === 'recall'),
    `v=${JSON.stringify(bGate.violations)}`);
  const bOk = evaluateGates(
    [{ action: 'stand', recall: 0.98, precision: 1, countErr: null }],
    { baseline: base, maxDrop: 0.05 },
  );
  check('下降未超过 maxDrop 时通过', bOk.passed === true);
}

// —— 21. 灵敏度扫描与 A/B 对比（纯函数） ——
console.log('\n[21] 灵敏度与对比');
{
  function standRecs() {
    const r = [];
    for (let i = 0; i < 60; i++) r.push(frame(i * 100, STAND));
    return r;
  }

  const s = sweepVariants({ actions: { reps: { squat: { down: 100 } } } }, 'actions.reps.squat.down');
  check('扫描基准值正确', s.baseValue === 100);
  check('扫描值为 ±10%/±20%', s.variants.map((v) => v.value).join(',') === '80,90,110,120',
    `vals=${s.variants.map((v) => v.value)}`);
  check('每个变体真的改了参数', s.variants.every((v) => v.params.actions.reps.squat.down === v.value));

  const st = sweepVariants({ signals: { gesture: { streak: 3 } } }, 'signals.gesture.streak');
  check('整数参数取整并去重', st.variants.map((v) => v.value).join(',') === '2,4',
    `vals=${st.variants.map((v) => v.value)}`);

  let threw = false;
  try { sweepVariants({}, 'actions.nope'); } catch { threw = true; }
  check('扫描不存在的键会报错', threw);

  const baseRows = [{ action: 'stand', recall: 1, precision: 1, countErr: 0 }];
  const changed = diffSummary(baseRows, [{ action: 'stand', recall: 0.5, precision: 1, countErr: 0 }]);
  check('只保留指标变化的动作', changed.length === 1 && changed[0].recallDelta === -0.5,
    `changed=${JSON.stringify(changed)}`);
  const forced = diffSummary(baseRows, [{ action: 'stand', recall: 1, precision: 1, countErr: 0 }], ['stand']);
  check('指定动作时没变化也列出', forced.length === 1 && forced[0].changed === false);

  const d = compareSummaries(
    [{ action: 'stand', recall: 1, precision: 1, countErr: 0 }],
    [{ action: 'stand', recall: 0.5, precision: 0.8, countErr: 1 }],
  );
  check('A/B 差值方向是 B−A', d[0].recallDelta === -0.5 && d[0].precisionDelta === -0.2
    && d[0].countErrDelta === 1, `d=${JSON.stringify(d[0])}`);

  const tlGood = replay(standRecs());
  const tlBad = replay(standRecs(), { actions: { posture: { stand: { kneeGt: 200 } } } });
  const labels = { segments: [{ action: 'stand', start: 0, end: 5000 }] };
  const cA = evaluateClip(standRecs(), labels, tlGood);
  const cB = evaluateClip(standRecs(), labels, tlBad);
  const ch = compareSegments([cA], [cB]);
  check('判定变化的段被抓到', ch.length === 1 && ch[0].aPass === true && ch[0].bPass === false,
    `changes=${JSON.stringify(ch)}`);
}

// —— 22. CLI：--compare / --sweep / 门槛 / 报告分区 ——
console.log('\n[22] CLI 集成');
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evalcli-'));
  const recs = [];
  for (let i = 0; i < 30; i++) recs.push(frame(i * 100, STAND));
  const framesFile = path.join(dir, 'a.json');
  const labelsFile = path.join(dir, 'a.labels.json');
  const pA = path.join(dir, 'pa.json');
  const pB = path.join(dir, 'pb.json');
  const script = path.join(process.cwd(), 'web/test/evaluate.mjs');
  try {
    await writeFile(framesFile, JSON.stringify({ frames: recs }), 'utf8');
    await writeFile(labelsFile, JSON.stringify({
      name: 'a', camera: 'side', segments: [{ action: 'stand', start: 500, end: 2500 }],
    }), 'utf8');
    await writeFile(pA, JSON.stringify({ name: 'A', params: {} }), 'utf8');
    await writeFile(pB, JSON.stringify({
      name: 'B', params: { actions: { posture: { stand: { kneeGt: 200 } } } },
    }), 'utf8');

    const { execFileSync } = await import('node:child_process');
    const run = (args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });

    const cmp = JSON.parse(run([
      '--input', framesFile, '--labels', labelsFile,
      '--compare', pA, pB, '--json', '--quiet',
    ]));
    const stand = cmp.deltas.find((d) => d.action === 'stand');
    check('CLI --compare 输出对比模式', cmp.mode === 'compare');
    check('CLI 对比出 stand recall 下降', stand?.recallA === 1 && stand?.recallB === 0
      && stand?.recallDelta === -1, `stand=${JSON.stringify(stand)}`);
    check('CLI 对比列出判定变化的段', cmp.changes.length >= 1, `changes=${cmp.changes.length}`);
    check('CLI 对比带两份参数指纹', /^fnv1a:/.test(cmp.a.paramsHash) && /^fnv1a:/.test(cmp.b.paramsHash));

    const sw = JSON.parse(run([
      '--input', framesFile, '--labels', labelsFile,
      '--sweep', 'actions.posture.stand.kneeGt', '--json', '--quiet',
    ]));
    check('CLI --sweep 产出四个变体', sw.sweep?.variants?.length === 4,
      `n=${sw.sweep?.variants?.length}`);
    const hit = sw.sweep.variants.find((v) => v.value === 180);
    check('CLI 扫描到 stand 阈值失效', hit?.deltas.some((d) => d.action === 'stand' && d.recallDelta === -1),
      `deltas=${JSON.stringify(hit?.deltas)}`);

    let status = 0;
    try {
      run(['--input', framesFile, '--labels', labelsFile, '--profile', pB,
        '--min-recall', '0.9', '--quiet']);
    } catch (e) { status = e.status; }
    check('门槛未达标退出码 2', status === 2, `status=${status}`);

    const md = run(['--input', framesFile, '--labels', labelsFile,
      '--sweep', 'actions.posture.stand.kneeGt', '--min-recall', '0.9']);
    check('报告含 95% 区间', md.includes('95%CI'));
    check('报告含混淆矩阵', md.includes('姿态混淆矩阵'));
    check('报告含分组统计', md.includes('分组统计 · 按机位') && md.includes('side'));
    check('报告含门槛', md.includes('## 门槛') && md.includes('全部达标'));
    check('报告含灵敏度扫描', md.includes('灵敏度扫描'));
    check('报告含时延与抖动', md.includes('事件时延') && md.includes('抖动'));
    check('对比 JSON 带时延/抖动', !!cmp.a.temporal && !!cmp.b.temporal);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// —— 23. 事件时延与抖动 ——
console.log('\n[23] 时延与抖动');
{
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(frame(i * 100, STAND));
  const tl = replay(recs);
  const clip = evaluateClip(recs, {
    name: 'lat',
    segments: [
      { action: 'stand', start: 0, end: 2000 },
      { action: 'stand', start: 2000, end: 4000 },
    ],
  }, tl);

  check('首段时延 > 0（Hold/streak 需要时间）', clip.segments[0].latencyMs > 0,
    `latency=${clip.segments[0].latencyMs}`);
  check('动作已成立时延为 0', clip.segments[1].latencyMs === 0,
    `latency=${clip.segments[1].latencyMs}`);
  check('clip 记录每个动作的状态段数', clip.activity.stand >= 1, `runs=${clip.activity.stand}`);

  const failClip = evaluateClip(recs, { segments: [{ action: 'lying', start: 0, end: 2000 }] }, tl);
  check('失败段没有时延', failClip.segments[0].latencyMs === undefined);

  const t = temporalStats([clip]);
  const standLat = t.latency.find((r) => r.action === 'stand');
  check('时延按段聚合（n=2）', standLat?.n === 2, `lat=${JSON.stringify(t.latency)}`);
  check('时延中位数在 [0, max] 内', standLat
    && standLat.medianMs >= 0 && standLat.medianMs <= standLat.maxMs,
    `lat=${JSON.stringify(standLat)}`);

  const standFlicker = t.flicker.find((r) => r.action === 'stand');
  const mins = clip.duration_s / 60;
  check('抖动按分钟折算', standFlicker?.perMinute === +(standFlicker.runs / mins).toFixed(2),
    `flicker=${JSON.stringify(standFlicker)}`);

  const { recs: sqRecs } = squatClip();
  const sqClip = evaluateClip(sqRecs, { segments: [] }, replay(sqRecs));
  check('深蹲过程把 stand 切成两段', sqClip.activity.stand === 2,
    `runs=${sqClip.activity.stand}`);
  check('深蹲静态姿态只触发一次', sqClip.activity.squat_static === 1,
    `runs=${sqClip.activity.squat_static}`);

  const raisedRecs = [];
  for (let i = 0; i < 30; i++) raisedRecs.push(frame(i * 100, RAISED));
  const armClip = evaluateClip(raisedRecs,
    { segments: [{ action: 'armRaised', start: 0, end: 3000 }] }, replay(raisedRecs));
  check('举手时延 > 0（Hold 300ms）', armClip.segments[0].latencyMs > 0,
    `latency=${armClip.segments[0].latencyMs}`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
