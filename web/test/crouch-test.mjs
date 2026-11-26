// crouch-test.mjs — 蹲下姿态（含背对相机的工人）的确定性单测
// 运行：node web/test/crouch-test.mjs
//
// 为什么单独测：蹲下需要膝/踝证据，背身机位下 2D 膝角会被透视压扁（看起来接近伸直），
// 必须靠 world 3D 膝角 + 腿竖直比 + 髋-膝高度差一起判。这里用合成骨架验证：
//   1) 背身 + 3D 膝角弯、2D 膝角直 → 判「蹲下」；
//   2) 只有 2D 的深蹲也能判；
//   3) 站姿 / 单膝跪地 / 腿不可见 → 不判蹲下；
//   4) 坐姿不会被更高优先级的蹲下吃掉；profile 覆盖阈值生效。

import { SignalEngine } from '../js/signals.js';
import { ActionEngine, ACTION_CATALOG, POSTURE_IDS } from '../js/actions.js';
import { validateParams } from '../js/params.js';

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

// 13 点骨架（KPT 顺序）。默认背对相机：受试者左肩在画面左侧（x 更小）。
const kpOf = (over = {}) => {
  const kp = [
    [100, 50, 1],                         // nose
    [80, 100, 1], [120, 100, 1],          // shoulders（背身）
    [80, 150, 1], [120, 150, 1],          // elbows
    [80, 200, 1], [120, 200, 1],          // wrists
    [90, 200, 1], [110, 200, 1],          // hips（站姿）
    [90, 300, 1], [110, 300, 1],          // knees
    [90, 380, 1], [110, 380, 1],          // ankles
  ];
  // 复制覆盖点：调用方会就地改可见性（如把腿设成不可见），不能污染共享的夹具对象。
  for (const [i, v] of Object.entries(over)) kp[Number(i)] = v.slice();
  return kp;
};

// world（米制，y 向下）：背对相机 = 左肩在 world -x。
// 蹲下时膝在髋前方（+z，远离相机）且略高于髋；站立时膝在髋下方。
const mkWorld = ({ squat = false } = {}) => {
  const w = new Array(33).fill(null).map(() => [0, 0, 0]);
  w[0] = [0, -0.62, 0.08];                    // 鼻子远离相机（背身）
  w[11] = [-0.16, -0.48, 0]; w[12] = [0.16, -0.48, 0];
  w[23] = [-0.1, 0, 0]; w[24] = [0.1, 0, 0];
  if (squat) {
    // 膝向前（+z）且略高于髋：3D 膝角明显弯曲；踝仍在髋下方。
    w[25] = [-0.1, -0.05, 0.25]; w[26] = [0.1, -0.05, 0.25];
    w[27] = [-0.1, 0.35, 0.05]; w[28] = [0.1, 0.35, 0.05];
  } else {
    w[25] = [-0.1, 0.45, 0.05]; w[26] = [0.1, 0.45, 0.05];
    w[27] = [-0.1, 0.85, 0]; w[28] = [0.1, 0.85, 0];
  }
  w[13] = [-0.2, -0.05, 0]; w[15] = [-0.2, 0.35, 0];
  w[14] = [0.2, -0.05, 0]; w[16] = [0.2, 0.35, 0];
  return w;
};

// 背身蹲下的 2D 投影：髋明显下沉（踝-髋竖直距离 / 躯干长 ≈0.56），
// 但膝只比髋低一点、踝在正下方 → 2D 膝角看起来接近伸直（≈168°）。
const SQUAT_KP_2D = {
  7: [90, 280, 1], 8: [110, 280, 1],
  9: [95, 320, 1], 10: [105, 320, 1],
  11: [90, 380, 1], 12: [110, 380, 1],
};

const person = (kp, world, extra = {}) => ({
  kp, kp_raw: [], kp_world: world || [], bbox: [50, 20, 150, 400],
  scale: 100, score: 0.92, track_id: 0, frame_w: 1000, frame_h: 1000, ...extra,
});

function run(kp, world, params = {}, n = 14) {
  const se = new SignalEngine(params);
  const ae = new ActionEngine(params);
  let sig = null;
  let act = null;
  for (let i = 1; i <= n; i++) {
    const ts = 1000 + i * 100;
    sig = se.update(person(kp, world), ts);
    act = ae.update(sig, ts);
  }
  return { sig, act };
}

console.log('\n[1] 背对相机 + 3D 膝角弯：2D 看着直，仍判蹲下');
{
  const { sig, act } = run(kpOf(SQUAT_KP_2D), mkWorld({ squat: true }));
  check('人体朝向 = back', sig.body.facing === 'back', `facing=${sig.body.facing}`);
  check('膝角用的是 3D', sig.angle_source.knee_L === '3d', `src=${sig.angle_source.knee_L}`);
  check('2D 膝角看起来接近伸直', sig.knee_pick_2d > 160, `knee_2d=${sig.knee_pick_2d?.toFixed(1)}`);
  check('3D 膝角判为弯曲', sig.knee_pick < 130, `knee=${sig.knee_pick?.toFixed(1)}`);
  check('腿证据可用', sig.legs_visible === true);
  check('髋-膝高度差为正（髋在膝下方）', sig.hip_knee_drop > 0, `drop=${sig.hip_knee_drop?.toFixed(2)}`);
  check('姿态 = 蹲下', act.postureId === 'crouch', `posture=${act.postureId}`);
}

console.log('\n[2] 只有 2D 的深蹲：不用 world 也能判蹲下');
{
  const kp = kpOf({
    7: [90, 260, 1], 8: [110, 260, 1],
    9: [30, 300, 1], 10: [170, 300, 1],
    11: [90, 330, 1], 12: [110, 330, 1],
  });
  const { sig, act } = run(kp, null);
  check('2D 膝角明显弯曲', sig.knee_pick < 130, `knee=${sig.knee_pick?.toFixed(1)}`);
  check('髋明显下沉（腿竖直比 <0.8）', sig.leg_vertical < 0.8, `leg=${sig.leg_vertical?.toFixed(2)}`);
  check('2D 下仍判蹲下', act.postureId === 'crouch', `posture=${act.postureId}`);
}

console.log('\n[3] 背对相机的站姿 / 单膝跪地 / 腿不可见 → 不判蹲下');
{
  const stand = run(kpOf(), mkWorld({ squat: false }));
  check('站姿 → 站立', stand.act.postureId === 'stand', `posture=${stand.act.postureId}`);
  check('站姿膝角接近伸直', stand.sig.knee_pick > 150, `knee=${stand.sig.knee_pick?.toFixed(1)}`);

  // 单膝跪地：膝弯但髋远高于膝（3D 髋-膝差远小于 -0.8）
  const kneelKp = kpOf({
    7: [90, 200, 1], 8: [110, 200, 1],
    9: [90, 300, 1], 10: [110, 300, 1],
    11: [90, 380, 1], 12: [110, 380, 1],
  });
  const kneelWorld = mkWorld({ squat: false });
  kneelWorld[25] = [-0.1, 0.45, 0.15]; kneelWorld[26] = [0.1, 0.45, 0.15];
  kneelWorld[27] = [-0.1, 0.85, 0.0]; kneelWorld[28] = [0.1, 0.85, 0.0];
  const kneel = run(kneelKp, kneelWorld);
  check('单膝跪地不是蹲下', kneel.act.postureId !== 'crouch', `posture=${kneel.act.postureId}`);

  // 腿不可见（膝/踝可见性低于门限）：没有腿证据，绝不判蹲下
  const hidden = kpOf(SQUAT_KP_2D);
  hidden[9][2] = 0.1; hidden[10][2] = 0.1;
  hidden[11][2] = 0.1; hidden[12][2] = 0.1;
  const noLegs = run(hidden, mkWorld({ squat: true }));
  check('腿不可见 → legs_visible=false', noLegs.sig.legs_visible === false);
  check('腿不可见 → 不判蹲下', noLegs.act.postureId !== 'crouch', `posture=${noLegs.act.postureId}`);

  // 背身时远侧腿常被近侧腿挡住：一条腿不可见，仍应能判蹲下（用可见的那条）。
  const oneLegKp = kpOf(SQUAT_KP_2D);
  oneLegKp[9][2] = 0.05; oneLegKp[11][2] = 0.05;   // 左膝/左踝被挡
  const oneLeg = run(oneLegKp, mkWorld({ squat: true }));
  check('一条腿被挡 → 单腿竖直延伸取右腿', oneLeg.sig.leg_vertical_pick_side === 'R',
    `side=${oneLeg.sig.leg_vertical_pick_side}`);
  check('一条腿被挡 → 仍判蹲下', oneLeg.act.postureId === 'crouch',
    `posture=${oneLeg.act.postureId}`);
}

console.log('\n[4] 坐姿不被更高优先级的蹲下吃掉');
{
  // 与 logic-test [6] 同一口径：坐在椅子上腿竖直比 0.9（>0.8）→ 蹲下不成立，归「坐」。
  const sig = {
    ok: true, knee_pick: 90, elbow_pick: 170, uprightness: 0.9, leg_vertical: 0.9,
    legs_visible: true, hip_knee_drop: 0,
    arm: {}, armPose: {}, wave: { L: 0, R: 0, amp: 0 }, extrapolated: [],
  };
  const ae = new ActionEngine();
  let act = null;
  for (let i = 1; i <= 12; i++) act = ae.update(sig, 1000 + i * 100);
  check('坐姿 → 坐', act.postureId === 'sit', `posture=${act.postureId}`);
}

console.log('\n[5] 注册表 / 导出与 profile 覆盖');
{
  check('crouch 已登记动作目录', ACTION_CATALOG.some((a) => a.id === 'crouch'));
  check('POSTURE_IDS 含 crouch', POSTURE_IDS.includes('crouch'));
  check('crouch 名称是「蹲下」', ACTION_CATALOG.find((a) => a.id === 'crouch')?.name === '蹲下');

  // profile 把蹲下的膝角上限收紧到 40°：当前 3D 膝角约 52° → 不再判蹲下
  const strict = run(kpOf(SQUAT_KP_2D), mkWorld({ squat: true }),
    { actions: { posture: { crouch: { kneeLt: 40 } } } });
  check('profile 收紧 kneeLt 后不判蹲下', strict.act.postureId !== 'crouch',
    `posture=${strict.act.postureId} knee=${strict.sig.knee_pick?.toFixed(1)} `
    + `legs=${strict.sig.legs_visible} upper=${strict.sig.upper_body}`);

  const throws = (over) => {
    try { validateParams(over); return false; } catch { return true; }
  };
  check('legVerticalLt 越界 → 加载时报错',
    throws({ actions: { posture: { crouch: { legVerticalLt: 5 } } } }));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
