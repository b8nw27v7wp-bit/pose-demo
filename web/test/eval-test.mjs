// eval-test.mjs — 离线评估工具的自测（不依赖浏览器、不依赖实拍素材）
// 运行：node web/test/eval-test.mjs
//
// 这里验证的是**评估器本身对不对**：给它一串已知答案的合成帧，它算出的 recall/precision/
// 计数误差必须符合预期，并且既不能把错的算成对的（抓漏），也不能把对的算成错的（抓错）。
// 它不验证真实场景精度——那需要实拍素材（PLAN §12.3 A）。

import { replay, evaluateClip, toTimeline, pairsFromDir, summarize } from './evaluate.mjs';
import { DEFAULT_PARAMS, profileParams, profileName } from '../js/params.js';
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
  check('ARM_ACTIONS 每个动作都能映射成 flag',
    ARM_ACTIONS.every((a) => ['arm_raised', 'both_up', 'wave', 'crossed', 'hips', 'arms_open', 'hand_head'].includes(a.id)));

  // 8.3 precision 归因：none 段的误报要记到真正误报的动作上
  const c = evaluateClip(recs, {
    name: 'fp',
    segments: [{ action: 'stand', start: 0, end: 2000 }, { action: 'none', start: 2000, end: 5000 }],
  }, tl0);
  check('none 段记录了误报来源', Array.isArray(c.segments[1].falseAlarms)
    && c.segments[1].falseAlarms.includes('stand'), `alarms=${JSON.stringify(c.segments[1].falseAlarms)}`);

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

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
