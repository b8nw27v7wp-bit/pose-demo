// eval-test.mjs — 离线评估工具的自测（不依赖浏览器、不依赖实拍素材）
// 运行：node web/test/eval-test.mjs
//
// 这里验证的是**评估器本身对不对**：给它一串已知答案的合成帧，它算出的 recall/precision/
// 计数误差必须符合预期，并且既不能把错的算成对的（抓漏），也不能把对的算成错的（抓错）。
// 它不验证真实场景精度——那需要实拍素材（PLAN §12.3 A）。

import {
  replay, personsFromFrame, evaluateClip, toTimeline, summarize, toMarkdown,
  autoLabelClip, loadFrames, parseSegment, pairsFromDir,
  wilson, postureConfusion, armCooccurrence, groupSummaries,
  evaluateGates, sweepVariants, diffSummary, compareSummaries, compareSegments,
  temporalStats, gestureFrames, gestureSummary, gestureSummaryIfAny,
  fitToParams, resampleFrames, FIT_MIN_SAMPLES,
  objectsInfo, objectModelChange, formatObject,
} from './evaluate.mjs';
import { DEFAULT_PARAMS, mergeParams, profileParams, profileName, paramsHash } from '../js/params.js';
import { SignalEngine } from '../js/signals.js';
import { ActionEngine } from '../js/actions.js';
import { videoTimeMonotonic } from './frame-io.mjs';
import { ARM_ACTIONS, REP_ACTIONS, POSTURE_IDS } from '../js/actions.js';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
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

/** 腕位（index 5/6，胸前 y=200）：open=0 两手合 0.33·scale，open=1 张开 1.33·scale */
function clapKp(open) {
  const dx = 20 + 60 * open;
  return STAND.map((p, i) => (i === 5 || i === 6)
    ? [100 + (i === 5 ? -dx : dx), 200, 1]
    : p);
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

/** 站 1s → 张开两手 1s（渐变，穿过 down/up 两个阈值）→ 放下 1s；应计 1 次鼓掌 */
function clapClip(n = 8) {
  const recs = [];
  let t = 0;
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));
  for (let i = 1; i <= n; i++) recs.push(frame(t += 100, clapKp(i / n)));
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));
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
    segments: [{ action: 'sit', start: 1500, end: 5500 }],
  }, tl);
  check('标注错误 → 不通过（抓漏）', wrong.segments[0].pass === false);

  const noneWrong = evaluateClip(recs, {
    segments: [{ action: 'none', start: 1500, end: 5500 }],
  }, tl);
  check('站着却标"无动作" → 不通过（抓错）', noneWrong.segments[0].pass === false);
}

// —— 2. 重复计数：一次鼓掌必须计 1 ---------------------------------------
console.log('\n[2] 鼓掌计数评估');
{
  // 站 1s（合手）→ 张开两手 1s → 放下 1s，应计 1 次
  const recs = [];
  let t = 0;
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));
  for (let i = 1; i <= 8; i++) recs.push(frame(t += 100, clapKp(i / 8)));
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));

  const tl = replay(recs);
  const sq = tl[tl.length - 1].act.reps.clap;
  check('复算出 1 次鼓掌', sq === 1, `clap=${sq}`);

  const ok = evaluateClip(recs, { segments: [{ action: 'clap', start: 0, end: t, count: 1 }] }, tl);
  check('标 1 次 → 通过', ok.segments[0].pass === true, `got=${ok.segments[0].got}`);

  const bad = evaluateClip(recs, { segments: [{ action: 'clap', start: 0, end: t, count: 3 }] }, tl);
  check('标 3 次 → 不通过', bad.segments[0].pass === false, `got=${bad.segments[0].got}`);

  // 门控：手抬到胸前才算鼓掌。两腕垂在髋高度时开合不该计数。
  const lowRecs = [];
  t = 0;
  for (let i = 0; i < 10; i++) lowRecs.push(frame(t += 100, STAND));
  for (let i = 1; i <= 8; i++) {
    const dx = 20 + 60 * (i / 8);
    const low = STAND.map((p, k) => ((k === 5 || k === 6) ? [100 + (k === 5 ? -dx : dx), 380, 1] : p));
    lowRecs.push(frame(t += 100, low));
  }
  for (let i = 0; i < 10; i++) lowRecs.push(frame(t += 100, STAND));
  const lowTl = replay(lowRecs);
  check('两腕在髋高度开合不计鼓掌', lowTl[lowTl.length - 1].act.reps.clap === 0,
    `clap=${lowTl[lowTl.length - 1].act.reps.clap}`);
}

// —— 3. 汇总指标：命中与漏判要能区分 -------------------------------------
console.log('\n[3] 逐段判定');
{
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(frame(i * 100, STAND));
  const tl = replay(recs);

  const c1 = evaluateClip(recs, { name: 'a', segments: [{ action: 'stand', start: 1000, end: 2000 }] }, tl);
  const c2 = evaluateClip(recs, { name: 'b', segments: [{ action: 'sit', start: 3000, end: 4000 }] }, tl);

  check('stand 命中', c1.segments[0].pass === true);
  check('sit 漏判', c2.segments[0].pass === false);
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

  const bySecMiss = evaluateClip(recs, { segments: [{ action: 'sit', startSec: 1.0, endSec: 4.0 }] }, tl);
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

  // near_equipment 是上下文事件，不是手臂动作：它成立时 noArm 仍应通过，
  // 也不该被记进 noArm 的误报来源（否则「站在设备旁不动」会被当成手臂误报）。
  {
    // ROI 只盖住人物框上部（不与腕/肘重叠）：near_equipment 成立，但 operating 的
    // 手/肘判据不成立，才能单独验证「上下文事件不算手臂动作」。
    const roi = { x: 0, y: 0, w: 1, h: 0.3 };
    const params = {
      signals: { arm: { operating: { roi }, nearEquipment: { minOverlap: 0.2 } } },
      actions: { holds: { nearEquipment: 1000 } },
    };
    const recsNear = [];
    for (let i = 0; i < 40; i++) {
      recsNear.push({ ...frame(i * 100, STAND), frame_w: 400, frame_h: 400 });
    }
    const tlNear = replay(recsNear, params);
    const last = tlNear[tlNear.length - 1];
    check('合成帧：near_equipment 成立', last.act.flags.nearEquipment === true);
    check('合成帧：除上下文外没有手臂动作',
      !Object.entries(last.act.flags).some(([k, v]) => k !== 'nearEquipment' && v));
    const noArmNear = evaluateClip(
      recsNear, { segments: [{ action: 'noArm', start: 0, end: 3900 }] }, tlNear,
    );
    check('near_equipment 不算 noArm 误报', noArmNear.segments[0].pass === true,
      JSON.stringify(noArmNear.segments[0].fail?.falseAlarms));
  }

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
  const { recs, end } = clapClip();
  const tl = replay(recs);

  const neg = evaluateClip(recs, { segments: [{ action: '!clap', start: 0, end }] }, tl);
  check('!clap 在真有一次鼓掌时失败', neg.segments[0].pass === false && neg.segments[0].got === 1,
    `got=${neg.segments[0].got}`);
  const row = summarize([neg]).find((r) => r.action === 'clap');
  check('反例计数的增量记为 clap 的 FP', row?.fp === 1, `fp=${row?.fp}`);

  const noneClip = evaluateClip(recs, { segments: [{ action: 'none', start: 0, end }] }, tl);
  check('none 段记录窗口内的计数误报', noneClip.segments[0].repFalseAlarms?.clap === 1,
    `repFP=${JSON.stringify(noneClip.segments[0].repFalseAlarms)}`);
  const row2 = summarize([noneClip]).find((r) => r.action === 'clap');
  check('汇总把 none 窗口的乱计数记到 clap 的 FP', row2?.fp === 1, `fp=${row2?.fp}`);

  // 手臂反例不替计数背锅：!onHips 窗口里发生鼓掌，不应算 clap 的 FP
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

  const fn = evaluateClip(recs, { segments: [{ action: 'sit', start: 2000, end: 4000 }] }, tl);
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
  const { recs } = clapClip();
  const tl = replay(recs);
  const draft = autoLabelClip(recs, tl, { name: 'auto' });

  check('草稿有名字与说明', draft.name === 'auto' && draft.note.includes('反例'));
  check('草稿含姿态段', draft.segments.some((s) => s.action === 'stand'));
  check('草稿含计数段且次数对', draft.segments.some((s) => s.action === 'clap' && s.count === 1),
    `seg=${JSON.stringify(draft.segments.filter((s) => s.action === 'clap'))}`);
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

    // 单行 JSONL 只有 meta（空导出）时不能把 meta 当成一帧喂给信号层。
    const metaOnly = path.join(dir, 'meta-only.jsonl');
    await writeFile(metaOnly, `${JSON.stringify(meta)}\n`, 'utf8');
    const loaded3 = await loadFrames(metaOnly);
    check('只有 meta 的单行 JSONL 不当成帧',
      loaded3.length === 0 && loaded3.meta?.model === 'full', `len=${loaded3.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const recs2 = [];
  for (let i = 0; i < 60; i++) recs2.push(frame(i * 100, STAND));
  const tl = replay(recs2);
  const clip = evaluateClip(recs2, {
    name: 'r', camera: 'side', subject: '甲',
    segments: [{ action: 'sit', start: 1000, end: 4000 }],
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

  // 计数反例：!clap 期望 0 次
  const negRepOk = evaluateClip(standRecs, {
    segments: [{ action: '!clap', start: 0, end: 3000 }],
  }, tlStand);
  check('!clap 0 次 → 通过', negRepOk.segments[0].pass === true);

  const repRecs = [];
  let t = 0;
  for (let i = 0; i < 10; i++) repRecs.push(frame(t += 100, STAND));
  for (let i = 1; i <= 8; i++) repRecs.push(frame(t += 100, clapKp(i / 8)));
  for (let i = 0; i < 10; i++) repRecs.push(frame(t += 100, STAND));
  const tlRep = replay(repRecs);
  const negRepBad = evaluateClip(repRecs, {
    segments: [{ action: '!clap', start: 0, end: t }],
  }, tlRep);
  check('!clap 出现 1 次 → 不通过', negRepBad.segments[0].pass === false
    && negRepBad.segments[0].want === 0 && negRepBad.segments[0].got === 1,
  JSON.stringify(negRepBad.segments[0]));
  const sumRep = summarize([negRepBad]).find((r) => r.action === 'clap');
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
  // 逐帧下蹲（0.25 → 1）：真实下蹲不是单帧跳变；信号层现在会剔除
  // 单帧 >80° 的膝角跳变（坏点保护），直接 STAND→squatKp(1) 会被延迟 2~3 帧。
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, squatKp(Math.min(1, (i + 1) / 4))));
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));
  for (let i = 0; i < 10; i++) recs.push(frame(t += 100, STAND));
  recs.push({ ts: t + 100, person_count: 0, persons: [], signals: null, actions: null });
  const tl = replay(recs);

  const labels = {
    segments: [
      { action: 'stand', start: 0, end: 900 },
      { action: 'none', start: 1000, end: 1900 },
      { action: 'stand', start: 2100, end: 2900 },
      { action: 'none', start: 3000, end: 3900 },
      { action: '!stand', start: 3950, end: 4050 },
      { action: 'stand', start: 4000, end: 4200 },
    ],
  };
  const conf = postureConfusion(tl, labels, recs);
  const idx = (name) => conf.labels.indexOf(name);
  // 标签从注册表派生（站/坐/上半身直立/上半身前倾 + none），新增姿态时这里自动跟上
  const confN = POSTURE_IDS.length + 1;
  check(`矩阵是 ${confN}×${confN} 且标签覆盖注册表姿态 + none`,
    conf.labels.length === confN && conf.matrix.length === confN
    && conf.matrix.every((r) => r.length === confN)
    && POSTURE_IDS.every((id) => conf.labels.includes(id))
    && conf.labels.includes('none'), `labels=${conf.labels}`);
  check('统计到姿态帧', conf.frames > 0, `frames=${conf.frames}`);
  check('stand 行对角线最大', conf.matrix[idx('stand')][idx('stand')]
    >= Math.max(...conf.matrix[idx('stand')]),
  `row=${JSON.stringify(conf.matrix[idx('stand')])} labels=${conf.labels}`);
  check('none 段被站姿误判会进入 none 行', conf.matrix[idx('none')][idx('stand')] > 0,
    `row=${JSON.stringify(conf.matrix[idx('none')])}`);
  check('!姿态 反例不计入真值', conf.negatedSkipped > 0, `skipped=${conf.negatedSkipped}`);
  check('未检出帧被跳过', conf.emptySkipped >= 1, `empty=${conf.emptySkipped}`);

  // 同一帧被标成两个姿态 → 冲突，跳过（这是标注错误，不是模型错误）
  const clash = postureConfusion(tl, {
    segments: [{ action: 'stand', start: 1000, end: 3000 }, { action: 'sit', start: 2000, end: 4000 }],
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

  const s = sweepVariants({ actions: { holds: { arm: 300 } } }, 'actions.holds.arm');
  check('扫描基准值正确', s.baseValue === 300);
  check('扫描值为 ±10%/±20%', s.variants.map((v) => v.value).join(',') === '240,270,330,360',
    `vals=${s.variants.map((v) => v.value)}`);
  check('每个变体真的改了参数', s.variants.every((v) => v.params.actions.holds.arm === v.value));

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

  const failClip = evaluateClip(recs, { segments: [{ action: 'sit', start: 0, end: 2000 }] }, tl);
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

  const { recs: sqRecs } = clapClip();
  const sqClip = evaluateClip(sqRecs, { segments: [] }, replay(sqRecs));
  // 鼓掌不改变姿态：站姿应是一整段（深蹲下线后不再有「蹲下把 stand 切开」的语义）
  check('鼓掌全程保持站立 → stand 只有一段', sqClip.activity.stand === 1,
    `runs=${sqClip.activity.stand}`);
  check('鼓掌过程不再产生已下线的姿态档', !('squat_static' in sqClip.activity),
    `keys=${Object.keys(sqClip.activity)}`);

  const raisedRecs = [];
  for (let i = 0; i < 30; i++) raisedRecs.push(frame(i * 100, RAISED));
  const armClip = evaluateClip(raisedRecs,
    { segments: [{ action: 'armRaised', start: 0, end: 3000 }] }, replay(raisedRecs));
  check('举手时延 > 0（Hold 300ms）', armClip.segments[0].latencyMs > 0,
    `latency=${armClip.segments[0].latencyMs}`);
}

// —— 24. 手部 replay：导出的 hands 必须进动作层 ——
// 回归 §12.7：replay 曾经不把 hands 传给 ActionEngine，导致
// reaching/carrying/pointing/grasp 在离线评估里恒为 false（正例必然 FN、反例必然通过）。
console.log('\n[24] 手部 replay');
{
  // 左腕远离肩 → extend_L 为真（与页面同一条信号）
  const extended = STAND.map((p) => [...p]);
  extended[5] = [-160, 60, 1];
  const recs = [];
  for (let i = 0; i < 20; i++) recs.push(frame(i * 100, extended));
  const withHands = (shape, handedness = 'Left') => recs.map((f) => ({
    ...f, hands: [{ handedness, shape }],
  }));

  const openTl = replay(withHands('open'));
  check('导出带 hands(open) → replay 判出 reaching',
    openTl[openTl.length - 1].act.flags.reaching === true,
    `reaching=${openTl[openTl.length - 1].act.flags.reaching}`);

  const noHandsTl = replay(recs);
  check('没有 hands 字段 → reaching 不成立（与页面「手部未加载」一致）',
    noHandsTl[noHandsTl.length - 1].act.flags.reaching === false);

  const emptyTl = replay(recs.map((f) => ({ ...f, hands: [] })));
  check('hands 为空数组 → reaching 不成立',
    emptyTl[emptyTl.length - 1].act.flags.reaching === false);

  const unknownTl = replay(withHands('open', 'unknown'));
  check('handedness=unknown 不参与左右手 → reaching 不成立',
    unknownTl[unknownTl.length - 1].act.flags.reaching === false);

  // 伸手(open) → 合手(fist) → 拿取计 1（PhaseSequence）
  const seq = [];
  for (let i = 0; i < 12; i++) {
    seq.push({ ...frame(i * 100, extended), hands: [{ handedness: 'Left', shape: 'open' }] });
  }
  for (let i = 0; i < 12; i++) {
    seq.push({ ...frame(1200 + i * 100, extended), hands: [{ handedness: 'Left', shape: 'fist' }] });
  }
  const graspTl = replay(seq);
  check('导出带 hands(open→fist) → replay 计 1 次拿取',
    graspTl[graspTl.length - 1].act.reps.grasp === 1,
    `grasp=${graspTl[graspTl.length - 1].act.reps.grasp}`);

  // 自动标注也要能产出这些动作（此前 FLAG_IDS 有名字但永远不成立）
  const draft = autoLabelClip(recs.map((f) => ({
    ...f, hands: [{ handedness: 'Left', shape: 'open' }],
  })), openTl, { name: 'hands' });
  check('autolabel 能为 hands 动作产出 reaching 段',
    draft.segments.some((s) => s.action === 'reaching'),
    JSON.stringify(draft.segments.map((s) => s.action)));

  // 注册表：每个手臂动作都必须有 flag，每个计数动作都必须能被标注
  check('每个手臂动作都注册了 flag',
    ARM_ACTIONS.every((a) => typeof a.flag === 'string' && a.flag));
  for (const r of REP_ACTIONS) {
    const res = evaluateClip(recs, {
      segments: [{ action: r.id, start: 0, end: 2000, count: 0 }],
    }, replay(recs));
    check(`计数动作 ${r.id} 可被评估器识别`, res.segments[0].type === 'rep',
      `type=${res.segments[0].type}`);
  }
}

// —— 25. 计数误差口径：每 20 次（PLAN §13.4） ——
// 旧口径是「每次的平均绝对误差」：want 10/got 20 与 want 3/got 0 都只有 1.0，
// --max-count-err 1 会把「多算一倍」和「完全漏数」都放过去。
console.log('\n[25] 计数误差口径（每 20 次）');
{
  const repClip = (...pairs) => ({
    segments: pairs.map(([want, got]) => ({
      type: 'rep', action: 'clap', expect: true, want, got, pass: Math.abs(got - want) <= 1,
    })),
  });

  const doubled = summarize([repClip([10, 20])]).find((r) => r.action === 'clap');
  check('want 10 / got 20（多算一倍）→ 每 20 次误差 20', doubled.countErr === 20,
    `countErr=${doubled.countErr}`);
  check('多算一倍在 maxCountErr=1 时门槛失败',
    !evaluateGates([doubled], { maxCountErr: 1 }).passed);

  const missed = summarize([repClip([3, 0])]).find((r) => r.action === 'clap');
  check('want 3 / got 0（完全漏数）→ 每 20 次误差 20', missed.countErr === 20,
    `countErr=${missed.countErr}`);
  check('完全漏数在 maxCountErr=1 时门槛失败',
    !evaluateGates([missed], { maxCountErr: 1 }).passed);

  // 两段各 10 次，只错 1 次：|0| + |1| = 1，1/20 * 20 = 1
  const oneOff = summarize([repClip([10, 10], [10, 11])]).find((r) => r.action === 'clap');
  check('20 次里错 1 次 → 每 20 次误差 1', oneOff.countErr === 1, `countErr=${oneOff.countErr}`);
  check('20 次里错 1 次在 maxCountErr=1 时通过',
    evaluateGates([oneOff], { maxCountErr: 1 }).passed);
}

// —— 26. video_time 回绕：循环播放的导出不能再用秒数标注 ——
console.log('\n[26] video_time 回绕');
{
  // 两圈播放：每圈 10 帧 video_time 0.0~0.9（从 0 重来），ts 一直单调。
  const wrapRecs = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let i = 0; i < 10; i++) {
      const f = frame(5000 + (cycle * 10 + i) * 100, STAND);
      f.video_time = +(i * 0.1).toFixed(2);
      wrapRecs.push(f);
    }
  }
  const wrapTl = replay(wrapRecs);

  let err = null;
  try {
    evaluateClip(wrapRecs, { segments: [{ action: 'stand', startSec: 0.2, endSec: 0.7 }] }, wrapTl);
  } catch (e) { err = e; }
  check('回绕素材用 startSec 标注会报错', !!err && /回绕/.test(err.message)
    && /start\/end/.test(err.message), err?.message);

  // 同一份素材改用 ts（start/end）→ 正常评估
  const byTs = evaluateClip(wrapRecs, { segments: [{ action: 'stand', start: 5000, end: 6800 }] }, wrapTl);
  check('回绕素材改用 start/end（ts）能正常评估', byTs.segments[0].pass === true,
    `pass=${byTs.segments[0].pass}`);

  // 草稿必须产出 ts 而不是秒数，否则 evaluate 会拒绝它
  const draft = autoLabelClip(wrapRecs, wrapTl, { name: 'wrap' });
  check('回绕素材的草稿用 start/end（ts）',
    draft.segments.length > 0 && draft.segments.every((s) => Number.isFinite(s.start)
      && Number.isFinite(s.end) && s.startSec === undefined && s.endSec === undefined),
    `seg=${JSON.stringify(draft.segments[0])}`);
  const self = evaluateClip(wrapRecs, draft, wrapTl);
  check('回绕素材的草稿能被 evaluate 解析', self.segments.every((s) => s.type !== 'unknown'));

  check('单调 video_time → true', videoTimeMonotonic([
    { video_time: 0 }, { video_time: 0.1 }, { video_time: 0.2 },
  ]) === true);
  check('回绕 video_time → false', videoTimeMonotonic([
    { video_time: 0 }, { video_time: 0.1 }, { video_time: 0 }, { video_time: 0.1 },
  ]) === false);
  check('含 null 的 video_time → 忽略后仍判单调', videoTimeMonotonic([
    { video_time: null }, { video_time: 0.1 }, { video_time: undefined }, { video_time: 0.2 },
  ]) === true);
  check('没有 video_time → 不适用，返回 true', videoTimeMonotonic([{ ts: 0 }, { ts: 100 }]) === true);
}

// —— 27. 手势评估（R7）：帧级指标、弃权、侧对门控、手-人归属 ——
// 手势不是动作层的布尔 flag：它的单位是「帧 × 手」，且要先做归属与侧对门控。
// 这里的合成帧只有 21 点手部结果的稳定 shape（导出里就是它），不跑手势分类器。
console.log('\n[27] 手势评估');
{
  // 手 bbox 中心默认落在 STAND 的人体框内；x=500 则落在框外（用于归属测试）
  const hand = (side, shape, { x = 100, y = 220, facing = 'front' } = {}) => ({
    handedness: side, shape, score: 0.9,
    bbox: [x - 20, y - 20, x + 20, y + 20],
    orient: { facing },
  });
  const hf = (ts, hands) => ({ ...frame(ts, STAND), hands });
  const gseg = (o) => ({ action: 'gesture', start: 0, end: 1900, ...o });
  const evalG = (recs, seg, timeline = replay(recs)) => evaluateClip(recs, { segments: [seg] }, timeline).segments[0];

  // 20 帧里 18 帧握拳、2 帧张开
  const clip = Array.from({ length: 20 }, (_, i) => hf(i * 100, [hand('Left', i < 18 ? 'fist' : 'open')]));
  const pos = evalG(clip, gseg({ hand: 'L', shape: 'fist' }));
  check('正例：20 帧可判定，命中 18', pos.type === 'gesture' && pos.stats.decided === 20
    && pos.stats.hits === 18, JSON.stringify(pos.stats));
  check('正例：命中率 0.9 ≥ 默认 0.5 → 通过', pos.pass === true);
  check('手势段不进按动作汇总', summarize([{ segments: [pos] }]).length === 0);

  const strict = evalG(clip, gseg({ hand: 'L', shape: 'fist', minRatio: 0.95 }));
  check('minRatio 覆盖生效：0.9 < 0.95 → 失败', strict.pass === false);

  const psum = gestureSummary([{ segments: [pos] }]);
  const fistRow = psum.shapes.find((r) => r.shape === 'fist');
  check('汇总：recall 0.9、precision 1', fistRow && fistRow.recall === 0.9
    && fistRow.precision === 1, JSON.stringify(fistRow));

  // unknown 与侧对都不进分母：10 帧拳、5 帧 unknown、5 帧拳但侧对
  const mixed = Array.from({ length: 20 }, (_, i) => {
    const shape = i >= 10 && i < 15 ? 'unknown' : 'fist';
    const facing = i >= 15 ? 'edge' : 'front';
    return hf(i * 100, [hand('Left', shape, { facing })]);
  });
  const m = evalG(mixed, gseg({ hand: 'L', shape: 'fist' }));
  check('unknown 与侧对不进分母', m.stats.decided === 10 && m.stats.hits === 10
    && m.stats.unknown === 5 && m.stats.edge === 5 && m.pass === true, JSON.stringify(m.stats));
  const msum = gestureSummary([{ segments: [m] }]);
  check('弃权率 = 10 / 20', msum.shapes[0].abstainRate === 0.5,
    `abstainRate=${msum.shapes[0].abstainRate}`);

  // 反例段的「已判定」帧同样进弃权率分母：10 帧 unknown + 10 帧判成 open（非目标手势）。
  // 旧口径只把正例段的 decided 计入分母，这里会得到 10/(0+10)=1.0。
  const negMixed = Array.from({ length: 20 }, (_, i) => hf(i * 100, [hand('Left', i < 10 ? 'unknown' : 'open')]));
  const nm = evalG(negMixed, gseg({ hand: 'L', shape: 'fist', expect: false }));
  const nms = gestureSummary([{ segments: [nm] }]);
  check('反例段的已判定帧进弃权率分母（10/20）', nms.shapes[0].abstainRate === 0.5,
    `abstainRate=${nms.shapes[0].abstainRate}, stats=${JSON.stringify(nm.stats)}`);

  // hand 选择：左手张开 + 右手握拳
  const both = Array.from({ length: 10 }, (_, i) => hf(i * 100, [hand('Left', 'open'), hand('Right', 'fist')]));
  const anyRes = evalG(both, gseg({ hand: 'any', shape: 'fist', end: 900 }));
  check('hand=any：任一侧命中即可', anyRes.stats.decided === 10 && anyRes.stats.hits === 10);
  const lRes = evalG(both, gseg({ hand: 'L', shape: 'fist', end: 900 }));
  check('hand=L：只看左手 → 命中 0、失败', lRes.stats.hits === 0 && lRes.stats.decided === 10
    && lRes.pass === false);

  // 反例：窗口内确实有 18 帧拳（另 2 帧是张开的，不算误报）
  const neg = evalG(clip, gseg({ hand: 'L', shape: 'fist', expect: false }));
  check('反例：18 帧出现拳 → active 18、失败', neg.stats.active === 18 && neg.pass === false,
    JSON.stringify(neg.stats));
  const nsum = gestureSummary([{ segments: [pos] }, { segments: [neg] }]);
  check('反例激活拉低 precision（18/36）', nsum.shapes[0].precision === 0.5,
    `precision=${nsum.shapes[0].precision}`);

  // none 段：窗口里判定出手势 → 记 FP，但 none 段本身仍通过（3 帧不到姿态 Hold）
  const noneClip = Array.from({ length: 3 }, (_, i) => hf(i * 100, [hand('Left', 'fist')]));
  const noneRes = evaluateClip(noneClip, { segments: [{ action: 'none', start: 0, end: 200 }] }, replay(noneClip));
  const noneSeg = noneRes.segments[0];
  check('none 段：手势激活记 FP，段仍通过', noneSeg.pass === true
    && noneSeg.gestureFalseAlarms?.fist === 3, JSON.stringify(noneSeg.gestureFalseAlarms));
  check('none 的手势误报进 precision', gestureSummary([noneRes])
    .shapes.find((r) => r.shape === 'fist')?.fp === 3);
  // 只有 none 段的素材也要生成手势小节：否则这段误报在报告里彻底消失
  const noneOnly = gestureSummaryIfAny([noneRes]);
  check('仅 none 段也能生成手势汇总', noneOnly?.shapes.find((r) => r.shape === 'fist')?.fp === 3,
    JSON.stringify(noneOnly));
  check('仅 none 段的汇总没有 gesture 段', noneOnly?.segments === 0);

  // 归属：手在人体框外
  const outside = Array.from({ length: 5 }, (_, i) => hf(i * 100, [hand('Left', 'fist', { x: 500 })]));
  const ores = evalG(outside, { action: 'gesture', hand: 'L', shape: 'fist', start: 0, end: 400 });
  check('框外的手 → 未归属、不进分母', ores.stats.unattributed === 5 && ores.stats.decided === 0
    && ores.pass === false, JSON.stringify(ores.stats));
  const oattr = gestureFrames(outside).stats;
  check('归属统计：5 只手全部未归属', oattr.hands === 5 && oattr.attributed === 0
    && oattr.unattributed === 5, JSON.stringify(oattr));

  // 没有 hands 字段：不能静默通过
  const bare = Array.from({ length: 5 }, (_, i) => frame(i * 100, STAND));
  const miss = evalG(bare, { action: 'gesture', hand: 'L', shape: 'fist', start: 0, end: 400 });
  check('没有 hands 字段 → 明确失败', miss.pass === false && /hands/.test(miss.error || ''), miss.error);

  // 写错 shape / hand
  const badShape = evalG(clip, gseg({ hand: 'L', shape: 'nope' }));
  check('未知 shape → 失败并提示', badShape.pass === false && /未知手势/.test(badShape.error || ''), badShape.error);
  const badHand = evalG(clip, gseg({ hand: 'X', shape: 'fist' }));
  check('非法 hand → 失败并提示', badHand.pass === false && /非法 hand/.test(badHand.error || ''), badHand.error);

  // 门槛
  const gFail = evaluateGates([], { gestureRows: psum, minGestureRecall: 0.95 });
  check('手势 recall 门槛触发违规', !gFail.passed
    && gFail.violations.some((v) => v.metric === 'gestureRecall'));
  const gAbstain = evaluateGates([], { gestureRows: msum, maxGestureAbstain: 0.2 });
  check('弃权率门槛触发违规', !gAbstain.passed
    && gAbstain.violations.some((v) => v.metric === 'gestureAbstain'));
  const gMissing = evaluateGates([], { gestureRows: null, maxGestureAbstain: 0.2 });
  check('没有手势数据时门槛报 missing', !gMissing.passed
    && gMissing.violations[0].kind === 'missing');

  // 报告：只在有手势标注时出现小节
  const md = toMarkdown({
    mode: 'single', clips: [], totalFrames: 0, summary: [], groups: {},
    gates: { configured: false }, confusion: null, temporal: null, sweep: null, fit: null,
    gestures: psum,
  });
  check('报告含手势小节', md.includes('## 手势（帧级）') && md.includes('| fist |'));
  // 仅 none 段（没有 gesture 段）也要把误报列出来
  const mdNone = toMarkdown({
    mode: 'single', clips: [], totalFrames: 0, summary: [], groups: {},
    gates: { configured: false }, confusion: null, temporal: null, sweep: null, fit: null,
    gestures: noneOnly,
  });
  check('仅 none 段时报告仍列出手势误报',
    mdNone.includes('## 手势（帧级）') && mdNone.includes('| fist |')
    && /没有 gesture 段/.test(mdNone), mdNone);
  const mdPlain = toMarkdown({
    mode: 'single', clips: [], totalFrames: 0, summary: [], groups: {},
    gates: { configured: false }, confusion: null, temporal: null, sweep: null, fit: null,
    gestures: null,
  });
  check('没有手势标注时不出空小节', !mdPlain.includes('## 手势'));

  // 时间线多两列
  const tlText = toTimeline(noneClip, replay(noneClip), 1);
  check('时间线含手L/手R 列', tlText.includes('手L') && tlText.includes('手R'));
  check('时间线行数不变', tlText.split('\n').length === 5, `lines=${tlText.split('\n').length}`);

  // CLI 接线：--json 带 gestures，门槛未达标时退出码 2
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evalgesture-'));
  try {
    const framesFile = path.join(dir, 'g.frames.json');
    const labelsFile = path.join(dir, 'g.labels.json');
    await writeFile(framesFile, JSON.stringify({ frames: clip }), 'utf8');
    await writeFile(labelsFile, JSON.stringify({
      name: 'g',
      segments: [{ action: 'gesture', hand: 'L', shape: 'fist', start: 0, end: 1900 }],
    }), 'utf8');
    const { execFileSync } = await import('node:child_process');
    const cli = path.join(process.cwd(), 'web/test/evaluate.mjs');
    const out = execFileSync(process.execPath,
      [cli, '--input', framesFile, '--labels', labelsFile, '--json'], { encoding: 'utf8' });
    const rep = JSON.parse(out);
    check('CLI --json 含手势汇总', rep.gestures?.shapes?.[0]?.shape === 'fist'
      && rep.gestures.shapes[0].recall === 0.9, JSON.stringify(rep.gestures?.shapes?.[0]));
    let code = 0;
    try {
      execFileSync(process.execPath,
        [cli, '--input', framesFile, '--labels', labelsFile, '--min-gesture-recall', '0.95', '--quiet'],
        { encoding: 'utf8' });
    } catch (e) { code = e.status; }
    check('CLI 手势门槛未达标 → 退出码 2', code === 2, `code=${code}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}


// —— 28. R4 拟合工具：分位→profile、LOSO、帧率敏感性 ——
// 这些工具不依赖实拍数据；这里用已知答案的合成帧验证「翻译方向」和「留一人流程」，
// 不验证真实阈值是否好用（那需要 R2 的数据）。
console.log('\n[28] R4 拟合工具');
{
  // 分位 → profile：方向约定见 evaluate.fitToParams 的注释
  const fit = {
    'stand/knee': { n: 50, p5: 160, p50: 168, p95: 175 },
    'sit/knee': { n: 30, p5: 70, p50: 100, p95: 130 },
    'stand/uprightness': { n: 50, p5: 0.9, p50: 0.95, p95: 0.98 },
    'sit/uprightness': { n: 30, p5: 0.6, p50: 0.7, p95: 0.8 },
    'stand/leg_vertical': { n: 50, p5: 0.95, p50: 1.0, p95: 1.1 },
    'sit/leg_vertical': { n: 30, p5: 0.4, p50: 0.6, p95: 0.8 },
    'clap_baseline/hands_close': { n: 20, p5: 0.3, p50: 0.45, p95: 0.6 },
    'armRaised/elev_torso_L': { n: 30, p5: 20, p50: 30, p95: 40 },
    // 单臂动作：另一侧是「放下/未伸出」的高位/低位，拟合必须排除它
    'armRaised/elev_torso_R': { n: 30, p5: 150, p50: 160, p95: 170 },
    'reaching/reach_L': { n: 30, p5: 1.4, p50: 1.6, p95: 1.9 },
    'reaching/reach_R': { n: 30, p5: 0.8, p50: 0.9, p95: 1.0 },
  };
  const fp = fitToParams(fit, { margin: 0.1 });
  const P = fp.params;
  check('姿态下限型：stand.kneeGt = P5 − 10%', P.actions?.posture?.stand?.kneeGt === 144,
    `got=${P.actions?.posture?.stand?.kneeGt}`);
  check('sit 区间同时拟合', P.actions?.posture?.sit?.kneeGt === 63
    && P.actions?.posture?.sit?.kneeLt === 143);
  check('uprightness 按比例留余量', P.actions?.posture?.stand?.uprightnessGt === 0.81);
  check('stand.legVerticalGt = P5 − 10%',
    P.actions?.posture?.stand?.legVerticalGt === 0.855,
    `got=${P.actions?.posture?.stand?.legVerticalGt}`);
  check('clap 比例阈值成对', P.actions?.reps?.clap?.down === 0.27
    && P.actions?.reps?.clap?.up === 0.66);
  check('elevTorso.raised 取两侧较低 P95（上限型，排除下垂臂）',
    P.signals?.arm?.elevTorso?.raised === 44, `got=${P.signals?.arm?.elevTorso?.raised}`);
  check('extend.minReach 取两侧较高 P5（下限型，排除未伸出的臂）',
    P.signals?.arm?.extend?.minReach === 1.26, `got=${P.signals?.arm?.extend?.minReach}`);
  check('分位来源可追溯', fp.sources.length > 0 && fp.sources.every((s) => s.n >= FIT_MIN_SAMPLES));
  // 已下线的姿态/计数（躺卧、下蹲、俯卧撑）不再出现在拟合结果里
  check('拟合结果不含已下线动作',
    !P.actions?.posture?.squat && !P.actions?.posture?.lying
    && !P.actions?.reps?.squat && !P.actions?.reps?.pushup && !P.actions?.gates,
    `actions=${JSON.stringify(Object.keys(P.actions || {}))}`);

  const tight = fitToParams({ 'stand/knee': { n: 20, p5: 160, p95: 175 } }, { margin: 0.05 });
  check('margin 可调（5%）', tight.params.actions?.posture?.stand?.kneeGt === 152);

  const thin = fitToParams({ 'stand/knee': { n: FIT_MIN_SAMPLES - 1, p5: 160, p95: 175 } });
  check('样本不足不采用', !thin.params.actions && thin.warnings.length === 0,
    `params=${JSON.stringify(thin.params)}`);

  const bad = fitToParams({
    'clap_baseline/hands_close': { n: 20, p5: 0.9, p95: 0.3 },
  });
  check('down >= up 时整对跳过并告警',
    !bad.params.actions?.reps?.clap && bad.warnings.some((w) => /clap/.test(w)),
    bad.warnings.join('；'));

  const merged = mergeParams(
    { signals: { arm: { extend: { minReach: 1.2 } } } },
    { signals: { arm: { onHips: { maxDist: 0.6 } } } },
  );
  check('mergeParams 深合并、后者覆盖前者',
    merged.signals.arm.extend.minReach === 1.2 && merged.signals.arm.onHips.maxDist === 0.6);

  // 重采样：10 帧 @10fps → 5fps 保留 5 帧；高帧率不丢；video_time 时间基
  const recs = Array.from({ length: 10 }, (_, i) => frame(i * 100, STAND));
  recs.meta = { model: 'lite' };
  const rs = resampleFrames(recs, 5);
  check('10fps → 5fps 保留 5 帧', rs.length === 5 && rs[0] === recs[0] && rs[4] === recs[8],
    `n=${rs.length}`);
  check('重采样保留 meta', rs.meta?.model === 'lite');
  check('目标帧率高于源帧率时不丢帧', resampleFrames(recs, 60).length === 10);
  const vrecs = recs.map((r, i) => ({ ...r, video_time: i * 0.1 }));
  check('video_time 时间基同样抽帧', resampleFrames(vrecs, 5).length === 5);
  const center = resampleFrames([{ ts: 0 }, { ts: 50 }, { ts: 200 }], 5);
  check('首帧无条件保留、间隔不足的帧丢弃', center.length === 2 && center[1].ts === 200);
  // 目标帧率 = 源帧率时必须是 no-op；video_time 三位小数取整后间隔可能是 66ms
  const rounded = [0, 0.067, 0.133, 0.2].map((v, i) => ({ ts: i * 67, video_time: v }));
  check('同帧率重采样不丢帧（时间戳取整）', resampleFrames(rounded, 15).length === 4,
    `n=${resampleFrames(rounded, 15).length}`);

  // LOSO 门槛（不依赖 CLI）
  const gLoso = evaluateGates([], {
    loso: { folds: [{ subject: 'X', deltas: [{ action: 'stand', recallDelta: -0.5, precisionDelta: -0.2 }] }] },
    maxLosoDrop: 0.1,
  });
  check('LOSO 退化超限 → 门槛违规', !gLoso.passed
    && gLoso.violations.filter((v) => v.kind === 'loso').length === 2,
    JSON.stringify(gLoso.violations));

  // CLI：两个 subject，A 的「深蹲」被标成 stand（构造退化），B 是正常站姿
  const { execFileSync } = await import('node:child_process');
  const cli = path.join(process.cwd(), 'web/test/evaluate.mjs');
  const runCli = (...argv) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [cli, ...argv], { encoding: 'utf8' }), err: '' };
    } catch (e) {
      return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
    }
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evalr4-'));
  try {
    const writeClip = async (name, kp, subject) => {
      const frames = Array.from({ length: 20 }, (_, i) => frame(i * 100, kp));
      await writeFile(path.join(dir, `${name}.frames.json`), JSON.stringify({ frames }), 'utf8');
      await writeFile(path.join(dir, `${name}.labels.json`), JSON.stringify({
        name, subject, camera: 'front',
        segments: [{ action: 'stand', start: 0, end: 1900 }],
      }), 'utf8');
    };
    await writeClip('a', squatKp(1), 'A');
    await writeClip('b', STAND, 'B');
    // subject 不是字符串：既不能当受试（不会出现在 subjects 里），也不能进训练集
    await writeClip('c', STAND, 1);

    const losoRes = runCli('--dir', dir, '--loso', '--json');
    const lrep = JSON.parse(losoRes.out);
    check('LOSO 按 subject 生成 fold', lrep.loso?.folds?.length === 2,
      JSON.stringify(lrep.loso?.subjects));
    check('非字符串 subject 不参与 LOSO',
      !lrep.loso?.subjects?.includes(1) && (lrep.loso?.warnings || []).some((w) => /没有 subject/.test(w)),
      JSON.stringify(lrep.loso?.warnings));
    check('每个 fold 都有训练/留出/Δ', (lrep.loso?.folds || []).every((f) => Array.isArray(f.train)
      && Array.isArray(f.heldout) && Array.isArray(f.deltas)));
    const foldA = lrep.loso?.folds?.find((f) => f.subject === 'A');
    const standDelta = foldA?.deltas?.find((d) => d.action === 'stand');
    check('留出 A 相对训练集退化 → Δ = −1', standDelta?.recallDelta === -1,
      JSON.stringify(standDelta));

    const gateRes = runCli('--dir', dir, '--loso', '--max-loso-drop', '0', '--json');
    const grep = JSON.parse(gateRes.out);
    check('--max-loso-drop 进入门槛并触发违规',
      grep.gates?.thresholds?.maxLosoDrop === 0
      && (grep.gates?.violations || []).some((v) => v.kind === 'loso'),
      JSON.stringify(grep.gates?.violations));

    // 拟合结果写到 --dir 之外：目录扫描会把任何 .json 当帧文件（docs/eval.md 的提醒）
    const fitOut = path.join(os.tmpdir(), `evalr4-fit-${Date.now()}.json`);
    try {
      const fitRes = runCli('--dir', dir, '--fit', '--fit-out', fitOut, '--json');
      const frep = JSON.parse(fitRes.out);
      check('--fit 报告带自动转换结果',
        Number.isFinite(frep.fitProfile?.params?.actions?.posture?.stand?.kneeGt),
        JSON.stringify(frep.fitProfile?.params));
      const fitRaw = JSON.parse(await readFile(fitOut, 'utf8'));
      check('--fit-out 写出可被 profileParams 读取的 profile',
        typeof profileParams(fitRaw).actions?.posture?.stand?.kneeGt === 'number',
        JSON.stringify(fitRaw));
      check('拟合 profile 带 model 与复核提示',
        typeof fitRaw.name === 'string' && /复核/.test(fitRaw.note || ''));
    } finally {
      await rm(fitOut, { force: true }).catch(() => {});
    }

    const rres = runCli('--dir', dir, '--resample', '5', '--json');
    const rrep = JSON.parse(rres.out);
    check('--resample 减少帧数并给出 Δ',
      rrep.resample?.framesAfter < rrep.resample?.framesBefore
      && Array.isArray(rrep.resample?.deltas),
      JSON.stringify(rrep.resample && {
        before: rrep.resample.framesBefore, after: rrep.resample.framesAfter, n: rrep.resample.deltas.length,
      }));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  // 重采样 + 帧序号标注：必须明确拒绝
  const dir2 = await mkdtemp(path.join(os.tmpdir(), 'evalr4sf-'));
  try {
    const frames = Array.from({ length: 20 }, (_, i) => frame(i * 100, STAND));
    await writeFile(path.join(dir2, 'c.frames.json'), JSON.stringify({ frames }), 'utf8');
    await writeFile(path.join(dir2, 'c.labels.json'), JSON.stringify({
      name: 'c', subject: 'C', segments: [{ action: 'stand', startFrame: 0, endFrame: 19 }],
    }), 'utf8');
    const res = runCli('--dir', dir2, '--resample', '5');
    check('--resample 遇到 startFrame 标注报错', res.code === 1 && /startFrame/.test(res.err),
      `code=${res.code} err=${res.err.slice(0, 120)}`);
  } finally {
    await rm(dir2, { recursive: true, force: true }).catch(() => {});
  }
}


// —— 29. 多人评估（R12-1）：逐 track 回放、label.track、手势归属与旧数据回归 ——
// 合成帧：A 挥手、B 站立。A 的挥手必须只算在 A 头上；B 的 !waving 不能被 A 污染。
console.log('\n[29] 多人评估口径');
{
  const shiftKp = (kp, dx) => kp.map(([x, y, v]) => [x + dx, y, v]);
  const mkPerson = (kp, track_id, bbox = null, scale = 127) => {
    const xs = kp.map((p) => p[0]);
    const ys = kp.map((p) => p[1]);
    return {
      track_id, kp_format: 'mediapipe33', kp, scale, score: 0.9,
      bbox: bbox || [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    };
  };
  const multiFrame = (ts, people, { hands = null } = {}) => {
    const f = { ts: Math.round(ts), person_count: people.length, persons: people, signals: null, actions: null };
    if (hands) f.hands = hands;
    return f;
  };
  const A_BASE = shiftKp(STAND, 0);
  const B_BASE = shiftKp(STAND, 400);
  // A：左腕举到肩上并左右摆（waving 需要「举手 + 水平方向翻转」两个条件）。
  const waveKp = (i) => A_BASE.map((p, idx) => (idx === 5
    ? [100 + (i % 2 ? 40 : -40), 60, 1]
    : p));
  const mf = Array.from({ length: 40 }, (_, i) => multiFrame(i * 100, [
    mkPerson(waveKp(i), 0), mkPerson(B_BASE, 1),
  ]));

  const tl = replay(mf);
  check('多人 replay 带逐 track 时间线', tl.tracks instanceof Map && tl.tracks.size === 2
    && tl.tracks.get(0).length === mf.length, `tracks=${tl.tracks && tl.tracks.size}`);
  const lastA = tl.tracks.get(0)[tl.tracks.get(0).length - 1];
  const lastB = tl.tracks.get(1)[tl.tracks.get(1).length - 1];
  check('A 判出挥手、B 没有', lastA.act.flags.waving === true && lastB.act.flags.waving === false,
    `A=${lastA.act.flags.waving} B=${lastB.act.flags.waving}`);

  const labels = {
    segments: [
      { action: 'waving', track: 0, startFrame: 20, endFrame: 39 },
      { action: '!waving', track: 1, startFrame: 0, endFrame: 39 },
      { action: 'stand', track: 1, startFrame: 5, endFrame: 39 },
    ],
  };
  const ev = evaluateClip(mf, labels, tl);
  check('A 的 waving 正例 → 命中（recall=1）', ev.segments[0].pass === true
    && ev.segments[0].track === 0, JSON.stringify(ev.segments[0]));
  check('B 的 !waving → 通过（不被 A 污染）', ev.segments[1].pass === true
    && ev.segments[1].track === 1, JSON.stringify(ev.segments[1]));
  check('B 的 stand 正例 → 通过', ev.segments[2].pass === true, JSON.stringify(ev.segments[2]));

  const rows = summarize([ev]);
  const aWave = rows.find((r) => r.track === 0 && r.action === 'waving');
  const bStand = rows.find((r) => r.track === 1 && r.action === 'stand');
  check('汇总按 track 出行并带 n', aWave && aWave.nRecall === 1 && aWave.recall === 1
    && bStand && bStand.nRecall === 1, JSON.stringify(rows.map((r) => [r.track, r.action, r.nRecall])));

  // label.track 绑定：同一段 waving 标到 B 头上 → 应漏判（B 没挥手）
  const wrong = evaluateClip(mf, {
    segments: [{ action: 'waving', track: 1, startFrame: 20, endFrame: 39 }],
  }, tl);
  check('label.track 绑定错人 → 漏判', wrong.segments[0].pass === false
    && wrong.segments[0].track === 1, JSON.stringify(wrong.segments[0]));
  const missing = evaluateClip(mf, {
    segments: [{ action: 'waving', track: 9, startFrame: 20, endFrame: 39 }],
  }, tl);
  check('label.track 指向不存在的 track → 明确报错', missing.segments[0].pass === false
    && /没有 track 9/.test(missing.segments[0].error || ''), missing.segments[0].error);

  // label.track 写 uid（跨 id 稳定）：要能查回 track_id，而不是报「没有 track」
  const mfUid = mf.map((f, i) => multiFrame(i * 100, [
    { ...mkPerson(waveKp(i), 0), track_uid: 70 },
    { ...mkPerson(B_BASE, 1), track_uid: 71 },
  ]));
  const tlUid = replay(mfUid);
  const uidSeg = evaluateClip(mfUid, {
    segments: [{ action: 'waving', track: 70, startFrame: 20, endFrame: 39 }],
  }, tlUid);
  check('label.track 写 uid → 查回 track_id（与 ppe-eval 同口径）',
    uidSeg.segments[0].pass === true && uidSeg.segments[0].track === 0,
    JSON.stringify(uidSeg.segments[0]));

  // —— 多 track 汇总不再按 action 互相覆盖（baseline / sweep / A-B）——
  const curRows = [
    { action: 'waving', track: 0, recall: 0.16, precision: 1 },
    { action: 'waving', track: 1, recall: 0.2, precision: 1 },
  ];
  const baseDoc = { summary: [
    { action: 'waving', track: 0, recall: 1.0, precision: 1 },
    { action: 'waving', track: 1, recall: 0.2, precision: 1 },
  ] };
  const gateB = evaluateGates(curRows, { baseline: baseDoc, maxDrop: 0.05 });
  check('baseline 按 (track, action) 比对：track0 的 1.0→0.16 会被拦下',
    gateB.passed === false
    && gateB.violations.some((v) => v.action === 'waving' && v.track === 0),
    JSON.stringify(gateB.violations));
  const dRows = diffSummary([
    { action: 'waving', track: 0, recall: 0.5 },
    { action: 'waving', track: 1, recall: 0.9 },
  ], curRows);
  check('sweep 差异保留两条 track（不互相覆盖）',
    dRows.length === 2 && dRows.some((r) => r.track === 0) && dRows.some((r) => r.track === 1),
    JSON.stringify(dRows.map((r) => [r.action, r.track])));
  const cmpRows = compareSummaries(baseDoc.summary, curRows);
  check('A/B 对比保留两条 track',
    cmpRows.length === 2 && cmpRows.every((r) => r.action === 'waving'),
    JSON.stringify(cmpRows.map((r) => [r.action, r.track])));

  // —— activity/抖动逐 track 统计：主目标每帧换人也不能把两人拼成一条 ——
  const altFrames = Array.from({ length: 40 }, (_, i) => {
    const big = i % 2 === 0;
    return multiFrame(i * 100, [
      mkPerson(waveKp(i), 0, big ? [100, 50, 400, 400] : [100, 50, 160, 400]),
      mkPerson(B_BASE, 1, big ? [400, 50, 660, 400] : [400, 50, 900, 400]),
    ]);
  });
  const altTl = replay(altFrames);
  check('主目标确实每帧切换（测试前提）', altTl.primaryTrack.slice(0, 2).join(',') === '0,1',
    String(altTl.primaryTrack.slice(0, 4)));
  const altEv = evaluateClip(altFrames, { segments: [] }, altTl);
  check('activity 逐 track 统计：主目标切换不产生抖动假象', altEv.activity.waving <= 2,
    `runs=${altEv.activity.waving}`);

  // —— 姿态混淆矩阵：段写 track 时用那个人的时间线 ——
  const sitKp = STAND.map((p, idx) => (idx === 9 ? [152, 250, 1]
    : idx === 10 ? [168, 250, 1] : idx === 11 ? [155, 310, 1] : idx === 12 ? [171, 310, 1] : p));
  const sitFrames = Array.from({ length: 40 }, (_, i) => multiFrame(i * 100, [
    mkPerson(sitKp, 0), mkPerson(B_BASE, 1),
  ]));
  const sitTl = replay(sitFrames);
  const confSit = postureConfusion(sitTl, {
    segments: [{ action: 'sit', track: 0, startFrame: 0, endFrame: 39 }],
  }, sitFrames);
  const liSit = confSit.labels.indexOf('sit');
  const liStand = confSit.labels.indexOf('stand');
  check('姿态混淆矩阵按段的 track 取预测（不是每帧主目标）',
    confSit.matrix[liSit][liSit] > confSit.frames * 0.8
    && confSit.matrix[liSit][liSit] > confSit.matrix[liSit][liStand],
    JSON.stringify(confSit.matrix[liSit]));

  // —— 手势归属：每人的手只进自己 track 的分母 ——
  const handAt = (side, shape, cx, y = 220) => ({
    handedness: side, shape, score: 0.9,
    orient: { facing: 'front' },
    bbox: [cx - 10, y - 20, cx + 10, y + 20],
  });
  const gframes = Array.from({ length: 6 }, (_, i) => multiFrame(i * 100, [
    mkPerson(A_BASE, 0), mkPerson(B_BASE, 1),
  ], { hands: [handAt('Left', 'fist', 100), handAt('Right', 'open', 500)] }));
  const gfA = gestureFrames(gframes, { track: 0 });
  const gfB = gestureFrames(gframes, { track: 1 });
  check('手势按 track 归属：A 只看左拳', gfA.states[4].L.status === 'decided'
    && gfA.states[4].L.shapes[0] === 'fist' && gfA.states[4].R.status === 'noHand',
    JSON.stringify(gfA.states[4]));
  check('手势按 track 归属：B 只看右张开', gfB.states[4].R.status === 'decided'
    && gfB.states[4].R.shapes[0] === 'open' && gfB.states[4].L.status === 'noHand',
    JSON.stringify(gfB.states[4]));
  const gfDefault = gestureFrames(gframes);
  // 缺省口径只看主目标（面积相同取先出现的 A）；B 的手算「未归属」而不是主目标的右手。
  check('缺省 track → 主目标（先出现且面积相同取第一个）', gfDefault.states[4].L.shapes[0] === 'fist'
    && gfDefault.states[4].R.status === 'unattributed', JSON.stringify(gfDefault.states[4]));

  // 两人框重叠：手落在重叠区且离两人中心一样近 → 次近人 margin 不足 → 弃权
  const pA = { track_id: 0, bbox: [0, 0, 200, 400], kp: [[0, 0, 1]], scale: 100 };
  const pB = { track_id: 1, bbox: [120, 0, 320, 400], kp: [[0, 0, 1]], scale: 100 };
  const amb = gestureFrames([multiFrame(0, [
    { ...pA }, { ...pB },
  ], { hands: [handAt('Left', 'fist', 160)] })]);
  check('重叠区手：次近人 margin 不足 → 未归属', amb.stats.unattributed === 1
    && amb.states[0].L.status === 'unattributed', JSON.stringify(amb.stats));
  const nearA = gestureFrames([multiFrame(0, [
    { ...pA }, { ...pB },
  ], { hands: [handAt('Left', 'fist', 130)] })], { track: 0 });
  check('margin 足够 → 归给最近的人', nearA.stats.attributed === 1
    && nearA.states[0].L.status === 'decided', JSON.stringify(nearA.stats));

  // —— 旧单人数据回归：新 replay 必须与旧算法逐位一致；JSONL 往返指标不变 ——
  const samplePath = path.join(process.cwd(), 'eval-data', 'sample.frames.json');
  const labelsPath = path.join(process.cwd(), 'eval-data', 'sample.labels.json');
  const sampleFrames = await loadFrames(samplePath);
  const sampleLabels = JSON.parse(await readFile(labelsPath, 'utf8'));
  const legacyReplay = (frames) => {
    const se = new SignalEngine({});
    const ae = new ActionEngine({});
    const handState = (f) => {
      if (!Array.isArray(f.hands)) return null;
      const shape = (side) => f.hands.find((h) => h && h.handedness === side)?.shape ?? null;
      return { L: shape('Left'), R: shape('Right') };
    };
    return frames.map((f) => {
      const p = f.persons && f.persons[0];
      if (!p) return { ts: f.ts, empty: true, sig: null };
      const person = {
        track_id: p.track_id ?? 0, bbox: p.bbox, kp: p.kp,
        kp_world: Array.isArray(p.kp_world) && p.kp_world.length >= 33 ? p.kp_world : null,
        hands: handState(f), scale: p.scale, score: p.score, kp_format: p.kp_format,
      };
      const sig = se.update(person, f.ts);
      return { ts: f.ts, empty: false, sig, act: ae.update(sig, f.ts, person.hands) };
    });
  };
  const singleTl = replay(sampleFrames);
  const legacyTl = legacyReplay(sampleFrames);
  check('旧单人 sample 走旧路径（没有 tracks 挂载）', !(singleTl.tracks instanceof Map)
    && singleTl.length === sampleFrames.length, `len=${singleTl.length}`);
  const sigFingerprint = (r) => JSON.stringify({
    empty: r.empty,
    posture: r.act?.postureId ?? null,
    flags: r.act?.flags ?? null,
    reps: r.act?.reps ?? null,
    knee: r.sig?.knee_pick ?? null,
    upright: r.sig?.uprightness ?? null,
    elev: r.sig ? [r.sig.armPose.elev_L, r.sig.armPose.elev_R] : null,
  });
  check('旧单人 replay 与旧算法逐位一致',
    singleTl.map(sigFingerprint).join('|') === legacyTl.map(sigFingerprint).join('|'));

  const singleSum = summarize([evaluateClip(sampleFrames, sampleLabels, singleTl)]);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'evalmulti-'));
  try {
    const jsonl = path.join(tmpDir, 'sample.jsonl');
    const meta = {
      schema: 'frame.jsonl v0', model: 'full', delegate: 'GPU',
      export_mode: 'single', log_limit: 20000, frame_count: sampleFrames.length,
    };
    await writeFile(jsonl, [JSON.stringify(meta), ...sampleFrames.map((f) => JSON.stringify(f))].join('\n'), 'utf8');
    const loadedFrames = await loadFrames(jsonl);
    check('JSONL meta 透传 log_limit / export_mode',
      loadedFrames.meta?.log_limit === 20000 && loadedFrames.meta?.export_mode === 'single',
      JSON.stringify(loadedFrames.meta));
    const loadedSum = summarize([evaluateClip(loadedFrames, sampleLabels, replay(loadedFrames))]);
    check('旧单人 JSONL 指标逐位不变',
      JSON.stringify(loadedSum) === JSON.stringify(singleSum),
      `rows=${loadedSum.length}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// —— [R13-3] 物体模型指纹 ------------------------------------------------
{
  const h = (ch) => ch.repeat(64);
  const loaded = [
    { meta: { objects: { backend: 'onnx', model: 'ppe_smoke.onnx', inputSize: 320, modelHash: h('a'), labelsHash: 'l1' } } },
    { meta: { objects: { backend: 'onnx', model: 'ppe_smoke.onnx', inputSize: 320, modelHash: h('a'), labelsHash: 'l1' } } },
  ];
  const info = objectsInfo(loaded);
  check('物体模型去重（同一套只报一次）', info.models.length === 1 && info.hashes.length === 1);
  check('报告头带 backend/model/尺寸/哈希', /onnx\/ppe_smoke\.onnx @320 sha256:aaaaaaaaaaaa labels:l1/.test(formatObject(info.models[0])),
    formatObject(info.models[0]));

  const two = objectsInfo([loaded[0], { meta: { objects: { backend: 'onnx', model: 'other.onnx', inputSize: 640, modelHash: h('b') } } }]);
  check('两套物体模型 → 警告', two.models.length === 2 && /不能跨模型合并/.test(two.warning || ''), two.warning || '');
  check('相同 modelHash → 不阻断 baseline', objectModelChange([h('a')], { objects: [{ modelHash: h('a') }] }) === null);
  const change = objectModelChange([h('b')], { objects: [{ modelHash: h('a') }] });
  check('不同 modelHash → 拒绝并提示 --allow-model-change', !!change && /--allow-model-change/.test(change.message),
    change?.message);
  check('旧报告没有 objects 段 → 不阻断', objectModelChange([h('b')], {}) === null);
  check('当前没有指纹 → 不阻断', objectModelChange([], { objects: [{ modelHash: h('a') }] }) === null);

  // meta 透传：JSONL 首行的 objects 必须进 frames.meta，否则评估器永远看不到指纹
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'evalobj-'));
  try {
    const file = path.join(tmp, 'obj.jsonl');
    const meta = {
      schema: 'frame.jsonl v0', frame_count: 0,
      objects: { backend: 'onnx', model: 'm.onnx', inputSize: 320, modelHash: h('c'), labelsHash: 'x' },
    };
    await writeFile(file, JSON.stringify(meta) + '\n', 'utf8');
    const fr = await loadFrames(file);
    check('meta 透传 objects（R13-3）', fr.meta?.objects?.modelHash === h('c'), JSON.stringify(fr.meta));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  // —— operating 的离线回放：导出必须带帧尺寸 ——
  // ROI 是归一化坐标，回放时没有 frame_w/frame_h 就无法换算像素，operating 恒为 false。
  const opFrame = (dims = true) => ({
    ts: 1000, video_time: 1,
    persons: [{
      track_id: 0, bbox: [0, 0, 1, 1], kp: STAND, scale: 100, score: 0.9,
      ...(dims ? { frame_w: 500, frame_h: 500 } : {}),
    }],
  });
  const opParams = { signals: { arm: { operating: { roi: { x: 0.1, y: 0.3, w: 0.2, h: 0.2 } } } } };
  check('personsFromFrame 保留帧尺寸', personsFromFrame(opFrame())[0].frame_w === 500);
  const opTl = replay([opFrame()], opParams);
  check('有帧尺寸 → operating 可离线回放', opTl[0].sig.arm.operating_any === true,
    `any=${opTl[0].sig.arm.operating_any}`);
  const noDimTl = replay([opFrame(false)], opParams);
  check('缺帧尺寸 → 不猜（operating=false）', noDimTl[0].sig.arm.operating_any === false);

  // 多边形 ROI 与旧矩形走同一套离线回放；rois 非空时旧 roi 不参与。
  const polyParams = {
    signals: { arm: { operating: {
      rois: [{ id: 'panel', points: [[0.1, 0.3], [0.3, 0.3], [0.3, 0.5], [0.1, 0.5]] }],
    } } },
  };
  const polyTl = replay([opFrame()], polyParams);
  check('多边形 ROI 离线回放', polyTl[0].sig.arm.operating_any === true
    && polyTl[0].sig.arm.operating_roi_zone === 'panel');
  const polyNoDim = replay([opFrame(false)], polyParams);
  check('多边形 ROI 缺帧尺寸 → false', polyNoDim[0].sig.arm.operating_any === false);

  const headFrame = {
    ...opFrame(),
    persons: [{ ...opFrame().persons[0], kp_head: Array.from({ length: 9 }, () => [320, 220, 0.9]) }],
  };
  check('personsFromFrame 保留 kp_head',
    personsFromFrame(headFrame)[0].kp_head?.length === 9);

  // 离线回放也要把 frames[].objects 传给信号层，否则有设备检测框的 profile 在评估器里失效
  const eqFrame = {
    ...opFrame(),
    objects: [{ label: 'valve', score: 0.9, box: [50, 150, 150, 250] }],
  };
  const eqParams = {
    signals: { arm: { operating: {
      roi: null, equipmentLabels: ['valve'], equipmentMinScore: 0.3,
    } } },
  };
  const eqTl = replay([eqFrame], eqParams);
  check('离线回放把 objects 传给信号层', eqTl[0].sig.arm.operating_any === true,
    `any=${eqTl[0].sig.arm.operating_any}`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
