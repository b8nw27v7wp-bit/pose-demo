// sampling-test.mjs — 油样取样（oil_sample）：举瓶到眼前对光检查
// 运行：node web/test/sampling-test.mjs
//
// 这个动作和 hand_head 共用「腕靠近鼻尖」的距离判据，区别是：
//   1) 信号层多一道「手在身体前方」（3D 方位角 ≤ signals.arm.sampling.maxAzimuth）；
//   2) 动作层保持窗更长（actions.holds.oilSample=1000ms，hand_head 是 350ms）。
// 所以这里重点测「两个动作的边界」，而不是重复测距离判据。

import { SignalEngine } from '../js/signals.js';
import { ActionEngine } from '../js/actions.js';

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

// 13 点骨架（KPT 顺序）。鼻尖 [120,50]、肩 [100,100]/[140,100]，scale=100。
// 腕默认在身侧下方 [200,150]（不是取样姿势）。
const BASE = [
  [120, 50, 1],
  [100, 100, 1], [140, 100, 1],
  [100, 150, 1], [130, 180, 1],
  [200, 150, 1], [150, 250, 1],
  [100, 200, 1], [140, 200, 1],
  [100, 300, 1], [140, 300, 1],
  [100, 380, 1], [140, 380, 1],
];
const mkKp = (over = {}) => {
  const kp = BASE.map((p) => p.slice());
  for (const [i, v] of Object.entries(over)) kp[Number(i)] = v;
  return kp;
};
const mkPerson = (over = {}, { bbox = [80, 40, 160, 300], frameW = 1000, frameH = 1000 } = {}) => ({
  kp: mkKp(over), kp_raw: [], bbox, scale: 100, score: 0.9, track_id: 0,
  frame_w: frameW, frame_h: frameH,
});
// 左腕举到眼前（离鼻尖 5px，高于肩）——取样姿势
const AT_EYE = { 5: [125, 55, 1] };

function makeEngines(params = {}) {
  const se = new SignalEngine(params);
  const ae = new ActionEngine(params);
  return {
    se,
    ae,
    feed(person, ts) {
      const sig = se.update(person, ts, [], null, null);
      return ae.update(sig, ts, null);
    },
  };
}

console.log('\n[1] 举到眼前并保持 1s → oil_sample 成立');
{
  const { feed } = makeEngines();
  let out = null;
  for (let ts = 1000; ts <= 2000; ts += 100) out = feed(mkPerson(AT_EYE), ts);
  check('保持 1000ms → oil_sample=true', out.flags.oilSample === true, JSON.stringify(out.flags.oilSample));
  check('逐侧 flag 指到举起的那只手', out.flags.oilSampleL === true && out.flags.oilSampleR === false);
}

console.log('\n[2] 保持不足 1s → 不成立（比 hand_head 的 350ms 严格）');
{
  const { feed } = makeEngines();
  let out = null;
  for (let ts = 1000; ts <= 1500; ts += 100) out = feed(mkPerson(AT_EYE), ts);
  check('保持 500ms → oil_sample=false', out.flags.oilSample === false);
  check('同一时刻 hand_head 已成立（它只要 350ms）', out.flags.handAtHead === true);
}

console.log('\n[3] 手垂在身侧 → 不成立');
{
  const { feed } = makeEngines();
  let out = null;
  for (let ts = 1000; ts <= 2500; ts += 100) out = feed(mkPerson(), ts);
  check('腕离鼻尖远 → oil_sample=false', out.flags.oilSample === false);
}

console.log('\n[4] 腕靠近鼻尖但低于肩 → 不成立');
{
  const { feed } = makeEngines();
  // 腕在肩下 70px（超过 aboveShoulder 的 50px 门限）、离鼻尖仍很近（低头凑近手臂的样子）
  const low = { 5: [125, 170, 1], 0: [120, 175, 1] };
  let out = null;
  for (let ts = 1000; ts <= 2500; ts += 100) out = feed(mkPerson(low), ts);
  check('腕不明显高于肩 → oil_sample=false', out.flags.oilSample === false);
}

console.log('\n[5] 阈值来自参数（profile 可覆盖）');
{
  // 把保持窗调到 300ms，同样 500ms 的保持就该成立
  const { feed } = makeEngines({ actions: { holds: { oilSample: 300 } } });
  let out = null;
  for (let ts = 1000; ts <= 1500; ts += 100) out = feed(mkPerson(AT_EYE), ts);
  check('holds.oilSample=300 → 500ms 即成立', out.flags.oilSample === true);

  // 距离门收紧到 0.02 躯干长（2px）后，离鼻尖 5px 的姿势不再成立
  const tight = makeEngines({ signals: { arm: { sampling: { maxHeadDist: 0.02 } } } });
  let out2 = null;
  for (let ts = 1000; ts <= 2500; ts += 100) out2 = tight.feed(mkPerson(AT_EYE), ts);
  check('sampling.maxHeadDist 收紧 → 不成立', out2.flags.oilSample === false);
}

console.log('\n[6] 3D 方位角门：手在身前才算，侧后方不算');
{
  // 2D 骨架固定在「腕贴鼻尖」，只换 world 里腕的位置——这样距离判据恒过，
  // 单独检验「手在身体前方」这道门（这是 oil_sample 与 hand_head 的唯一区别）。
  const mkWorld = (wristL) => {
    const w = new Array(33).fill(null).map(() => [0, 0, 0]);
    w[23] = [-0.1, 0, 0]; w[24] = [0.1, 0, 0];
    w[11] = [-0.16, -0.48, 0]; w[12] = [0.16, -0.48, 0];
    w[0] = [0, -0.62, 0];
    w[13] = [-0.2, -0.3, 0]; w[15] = wristL;
    w[14] = [0.2, -0.3, 0]; w[16] = [0.2, 0.3, 0];
    return w;
  };
  const withWorld = (world) => ({ ...mkPerson(AT_EYE), kp_world: world });
  const run = (world) => {
    const { feed } = makeEngines();
    let out = null;
    for (let ts = 1000; ts <= 2200; ts += 100) out = feed(withWorld(world), ts);
    return out;
  };
  // 腕在肩前方（z 负）偏内侧：方位角 ≈ +48°
  const front = run(mkWorld([-0.05, -0.6, -0.1]));
  check('手在身前 → 成立', front.flags.oilSample === true, `azim≈48°`);
  // 腕在肩侧后方：方位角 ≈ 146°，距离判据仍然通过
  const side = run(mkWorld([-0.12, -0.6, 0.06]));
  check('手在侧后方 → 不成立（方位角门）', side.flags.oilSample === false);
}

console.log('\n[7] 不变量：oil_sample 成立时 hand_head 必然成立');
{
  const { feed } = makeEngines();
  let out = null;
  for (let ts = 1000; ts <= 2200; ts += 100) out = feed(mkPerson(AT_EYE), ts);
  check('oilSample=true 时 handAtHead=true（前者是后者的子集）',
    out.flags.oilSample === true && out.flags.handAtHead === true);
}

console.log('\n[8] 掉帧容忍：500ms 内的断续不重置计时，超时则重新计时');
{
  // 1s 保持窗 + 500ms 容忍：1000/1100 命中、1200 断一帧、1300 恢复 → 仍应在 2000 成立
  const { feed } = makeEngines();
  const hit = mkPerson(AT_EYE);
  const miss = mkPerson();   // 手放下来
  feed(hit, 1000); feed(hit, 1100); feed(miss, 1200);
  let a = null;
  for (let ts = 1300; ts <= 2000; ts += 100) a = feed(hit, ts);
  check('断 100ms 后继续累计 → 成立', a.flags.oilSample === true);

  // 中断 800ms（> maxGap 500）后再命中：必须重新计时
  const e2 = makeEngines();
  e2.feed(hit, 1000); e2.feed(hit, 1100);
  e2.feed(miss, 1200); e2.feed(miss, 2000);   // 间隔 900ms > 500
  const b = e2.feed(hit, 2100);
  check('中断超过 maxGap → 重新计时，不成立', b.flags.oilSample === false);
}

console.log('\n[9] 动作字典与提示覆盖');
{
  // 新动作必须在 ARM_ACTIONS 里、flag 与引擎输出对得上（manifest-test 也查这一条）
  const { ARM_ACTIONS, ARM_FLAG_IDS } = await import('../js/actions.js');
  const a = ARM_ACTIONS.find((x) => x.id === 'oil_sample');
  check('oil_sample 已登记，flag=oilSample', !!a && a.flag === 'oilSample');
  check('flag 在 ARM_FLAG_IDS 里', ARM_FLAG_IDS.includes('oilSample'));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
