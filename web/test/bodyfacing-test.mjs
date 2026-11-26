// bodyfacing-test.mjs — 人体朝向（正面/背面/侧对）纯函数 + 信号层接线自测
// 运行：node web/test/bodyfacing-test.mjs
//
// 覆盖：
//   1) 2D 退回判据：肩左右顺序、肩宽投影比、侧对时鼻尖方向、缺尺度/缺肩点不猜；
//   2) 3D 肩线判据：front/back/left/right、yaw 符号、置信度惩罚（肩宽越界、鼻深不一致）；
//   3) 信号层：背对相机时相机方位角 ≈180°，受试者自身方位角 ≈0°；
//      油样取样（「手在身体前方」）按身体坐标判，背身时相机的「身后」才是身体前方；
//   4) 动作层：指向/前平举用 arm_front_body_*，没有该字段的旧信号退回相机版本；
//   5) profile 值域校验。

import { bodyFacing, bodyFacingText } from '../js/bodyfacing.js';
import { SignalEngine } from '../js/signals.js';
import { ActionEngine } from '../js/actions.js';
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
const near = (a, b, tol = 1) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// 13 点骨架（KPT 顺序）。默认正面：受试者左肩在画面右（x 更大）。
// 躯干长 = 肩中线 y=100 → 髋中线 y=200，即 100px；肩宽 40px → 比值 0.4。
const baseKp = (over = {}) => {
  const kp = [
    [100, 50, 1],                         // 0 nose
    [120, 100, 1], [80, 100, 1],          // 1/2 shoulders
    [110, 150, 1], [90, 150, 1],          // 3/4 elbows
    [105, 200, 1], [95, 200, 1],          // 5/6 wrists
    [110, 200, 1], [90, 200, 1],          // 7/8 hips
    [110, 300, 1], [90, 300, 1],          // 9/10 knees
    [110, 380, 1], [90, 380, 1],          // 11/12 ankles
  ];
  for (const [i, v] of Object.entries(over)) kp[Number(i)] = v;
  return kp;
};

// world：肩线按 yaw 旋转（0=正面，±180=背面，+90=面向画面右）。
// 世界 x 向右、z 指向屏幕内；鼻子/腕可按需覆盖。
const mkWorld = ({ yaw = 0, noseZ = undefined, wristL = null, wristR = null } = {}) => {
  const w = new Array(33).fill(null).map(() => [0, 0, 0]);
  const rad = (yaw * Math.PI) / 180;
  const sx = 0.16 * Math.cos(rad);
  const sz = 0.16 * Math.sin(rad);
  w[11] = [sx, -0.48, sz];        // shoulder L
  w[12] = [-sx, -0.48, -sz];      // shoulder R
  w[23] = [-0.1, 0, 0]; w[24] = [0.1, 0, 0];
  // 鼻子深度只用于置信度：正面朝镜头（z 更小），背面远离镜头。
  w[0] = [0, -0.62, noseZ ?? (Math.abs(yaw) > 90 ? 0.1 : -0.1)];
  if (wristL) w[15] = wristL;
  if (wristR) w[16] = wristR;
  return w;
};

console.log('\n[1] 2D 退回：肩左右顺序 + 肩宽投影比');
{
  const cfg = { scale: 100 };
  const front = bodyFacing(baseKp(), null, cfg);
  check('正对（左肩在画面右）→ front', front.facing === 'front', `facing=${front.facing}`);
  check('2D yaw=0', front.yaw === 0 && front.yaw_source === '2d');
  check('肩宽比 = 0.4', near(front.shoulder_ratio, 0.4, 1e-6));

  const back = bodyFacing(baseKp({ 1: [80, 100, 1], 2: [120, 100, 1] }), null, cfg);
  check('背对（左肩在画面左）→ back', back.facing === 'back', `facing=${back.facing}`);
  check('2D yaw=180', back.yaw === 180);

  // 侧对：肩线投影被压扁（10/100 = 0.1 < 0.3），鼻子偏向面向的一侧
  const right = bodyFacing(baseKp({
    0: [130, 50, 1], 1: [105, 100, 1], 2: [95, 100, 1],
  }), null, cfg);
  check('侧对 + 鼻子在右 → right', right.facing === 'right', `facing=${right.facing}`);
  check('侧对 yaw=+90', right.yaw === 90 && right.side === 'right');

  const left = bodyFacing(baseKp({
    0: [70, 50, 1], 1: [105, 100, 1], 2: [95, 100, 1],
  }), null, cfg);
  check('侧对 + 鼻子在左 → left', left.facing === 'left');
  check('侧对 yaw=-90', left.yaw === -90);

  const sideNoNose = bodyFacing(baseKp({
    0: [100, 50, 0], 1: [105, 100, 1], 2: [95, 100, 1],
  }), null, cfg);
  check('侧对但鼻子不可见 → side（不猜左右）', sideNoNose.facing === 'side');
  check('侧对无鼻不给 yaw', sideNoNose.yaw === null);

  const noScale = bodyFacing(baseKp(), null, {});
  // 髋点可见时函数会自己算躯干长；把髋也去掉才真正「没有尺度」
  const trulyNoScale = bodyFacing(baseKp({
    7: [110, 200, 0], 8: [90, 200, 0],
  }), null, {});
  check('没有躯干长尺度 → unknown（不从肩宽反推）', trulyNoScale.facing === 'unknown'
    && trulyNoScale.reasons.includes('no_scale'));
  check('髋可见时可用髋距自算尺度', noScale.facing === 'front', `facing=${noScale.facing}`);

  check('缺肩点 → unknown + no_shoulders',
    bodyFacing([[100, 50, 1]], null, cfg).reasons.includes('no_shoulders'));
  check('肩点不可见 → unknown + low_shoulder_vis',
    bodyFacing(baseKp({ 1: [120, 100, 0.1] }), null, cfg).reasons.includes('low_shoulder_vis'));
}

console.log('\n[2] 3D 肩线：正面 / 背面 / 左 / 右');
{
  const kp = baseKp();
  const front = bodyFacing(kp, mkWorld({ yaw: 0 }), { scale: 100 });
  check('yaw=0 → front', front.facing === 'front' && near(front.yaw, 0), `yaw=${front.yaw}`);
  check('用 3D 源', front.yaw_source === '3d');
  check('肩宽/躯干长有值', Number.isFinite(front.width_ratio), `ratio=${front.width_ratio}`);

  const back = bodyFacing(kp, mkWorld({ yaw: 180 }), { scale: 100 });
  check('yaw=180 → back', back.facing === 'back' && near(Math.abs(back.yaw), 180));

  const right = bodyFacing(kp, mkWorld({ yaw: 90 }), { scale: 100 });
  check('yaw=+90 → right', right.facing === 'right' && near(right.yaw, 90));

  const left = bodyFacing(kp, mkWorld({ yaw: -90 }), { scale: 100 });
  check('yaw=-90 → left', left.facing === 'left' && near(left.yaw, -90));

  // 视角边界：|yaw|=frontMax 算正面，|yaw|=backMin 算背面
  check('yaw=45 → front（边界含）', bodyFacing(kp, mkWorld({ yaw: 45 }), { scale: 100 }).facing === 'front');
  check('yaw=135 → back（边界含）', bodyFacing(kp, mkWorld({ yaw: 135 }), { scale: 100 }).facing === 'back');

  // 世界肩点不可见时退回 2D
  const lowVis = bodyFacing(baseKp({ 1: [120, 100, 0.1], 2: [80, 100, 0.1] }),
    mkWorld({ yaw: 180 }), { scale: 100 });
  check('肩点不可见 → 不采信 3D', lowVis.yaw_source === null && lowVis.facing === 'unknown');

  // 肩宽/躯干长越界 → 置信度下调并记原因
  const wide = mkWorld({ yaw: 0 });
  wide[11] = [1.2, -0.48, 0]; wide[12] = [-1.2, -0.48, 0];
  const wideOut = bodyFacing(kp, wide, { scale: 100 });
  check('world 肩宽明显越界 → 降置信 + shoulder_width_outlier',
    wideOut.reasons.includes('shoulder_width_outlier') && wideOut.confidence < 0.7,
    `conf=${wideOut.confidence}`);

  // 鼻子深度与肩线结论矛盾 → 只降置信，不推翻朝向
  // noseZ=0.5 是「鼻子比肩远」，与 front（正面）矛盾，但头可能转过去，肩线仍是主证据。
  const disagree = bodyFacing(kp, mkWorld({ yaw: 0, noseZ: 0.5 }), { scale: 100 });
  check('鼻深与肩线矛盾时仍采信肩线（front）', disagree.facing === 'front',
    `facing=${disagree.facing}`);
  check('鼻深矛盾降置信并记原因',
    disagree.reasons.includes('nose_depth_disagree') && disagree.confidence < 0.95,
    `conf=${disagree.confidence}`);
}

console.log('\n[3] 信号层：背对相机时把相机方位角换算成身体方位角');
{
  // 背对镜头、左腕举在身体前方（远离相机 = 世界 z 正方向）。
  // 2D：左肩在画面左；腕贴鼻尖、高于肩；scale=100。
  const kp = baseKp({
    0: [100, 50, 1],
    1: [80, 100, 1], 2: [120, 100, 1],
    3: [85, 130, 1], 5: [105, 55, 1],
    7: [90, 200, 1], 8: [110, 200, 1],
  });
  const person = (wristL) => ({
    kp, kp_raw: [], kp_world: mkWorld({ yaw: 180, wristL }), bbox: [60, 40, 140, 400],
    scale: 100, score: 0.9, track_id: 0, frame_w: 1000, frame_h: 1000,
  });

  const ahead = new SignalEngine().update(person([-0.16, -0.6, 0.2]), 1000);
  check('人体朝向 = back', ahead.body.facing === 'back', `facing=${ahead.body.facing}`);
  check('相机方位角 ≈ ±180°（手远离相机）', near(Math.abs(ahead.armPose.azimuth_L), 180, 5),
    `azim=${ahead.armPose.azimuth_L}`);
  check('身体方位角 ≈ 0°（手在身体前方）', near(ahead.armPose.azimuth_body_L, 0, 5),
    `azim_body=${ahead.armPose.azimuth_body_L}`);
  check('背身 + 手在身前 → 油样取样成立', ahead.arm.sample_L === true);

  const behind = new SignalEngine().update(person([-0.16, -0.6, -0.2]), 1000);
  check('手朝相机（身体后方）→ 相机方位角 ≈ 0°', near(behind.armPose.azimuth_L, 0, 5),
    `azim=${behind.armPose.azimuth_L}`);
  check('手朝相机（身体后方）→ 身体方位角 ≈ ±180°', near(Math.abs(behind.armPose.azimuth_body_L), 180, 5),
    `azim_body=${behind.armPose.azimuth_body_L}`);
  check('背身 + 手在身后 → 油样取样不成立', behind.arm.sample_L === false);

  // 正面朝向时两者相同
  const kpFront = baseKp({
    0: [100, 50, 1],
    1: [120, 100, 1], 2: [80, 100, 1],
    3: [115, 130, 1], 5: [105, 55, 1],
  });
  const front = new SignalEngine().update({
    kp: kpFront, kp_raw: [], kp_world: mkWorld({ yaw: 0, wristL: [0.16, -0.6, -0.2] }),
    bbox: [60, 40, 140, 400], scale: 100, score: 0.9, track_id: 0, frame_w: 1000, frame_h: 1000,
  }, 1000);
  check('正面时身体方位角 = 相机方位角',
    near(front.armPose.azimuth_body_L, front.armPose.azimuth_L, 1e-6),
    `azim=${front.armPose.azimuth_L}`);
  check('正面 + 手在身前 → 取样成立', front.arm.sample_L === true);

  // 没有 world（无 3D 方位角）时退回纯距离判据，不因缺少人体朝向而判掉
  const noWorld = new SignalEngine().update({
    kp, kp_raw: [], kp_world: [], bbox: [60, 40, 140, 400],
    scale: 100, score: 0.9, track_id: 0, frame_w: 1000, frame_h: 1000,
  }, 1000);
  check('无 world → 2D 仍判 body=back', noWorld.body.facing === 'back');
  check('无 world → 方位角为 NaN，取样按距离判', Number.isNaN(noWorld.armPose.azimuth_L)
    && noWorld.arm.sample_L === true);

  // 上半身构图（髋不可见）+ 没有 world：signal 层的 scale 会退回「肩宽 × 1.4」，
  // 拿它去算肩宽比是循环论证（恒 ≈0.71）。此时必须给 unknown，而不是硬判正/背面。
  const upperOnly = new SignalEngine().update({
    kp: baseKp({ 7: [90, 200, 0], 8: [110, 200, 0] }),
    kp_raw: [], kp_world: [], bbox: [60, 40, 140, 240],
    scale: 100, score: 0.9, track_id: 0, frame_w: 1000, frame_h: 1000,
  }, 1000);
  check('髋不可见 + 无 world → body unknown（不从肩宽反推）',
    upperOnly.body.facing === 'unknown' && upperOnly.body.reasons.includes('no_scale'),
    `facing=${upperOnly.body.facing} reasons=${upperOnly.body.reasons}`);

  // 朝向置信度不足：只报告朝向，不拿去换算方位角（退回相机口径）
  const strict = new SignalEngine({ signals: { bodyFacing: { minConfidence: 0.99 } } });
  const lowConf = strict.update(person([-0.16, -0.6, 0.2]), 1000);
  check('朝向置信不足 → azimuth_body 为 NaN', Number.isNaN(lowConf.armPose.azimuth_body_L));
  check('朝向置信不足 → 取样退回相机口径（不成立）', lowConf.arm.sample_L === false);
  check('朝向本身仍然报告', lowConf.body.facing === 'back');
}

console.log('\n[4] 动作层：背身的前伸/指向用身体前方的「前」');
{
  const mkSig = (o = {}) => ({
    ok: true, knee_pick: 170, elbow_pick: 170, uprightness: 0.95, leg_vertical: 1.3,
    arm: {
      any_raised: false, any_raised3d: false, raised_L: false, raised_R: false,
      raised3d_L: false, raised3d_R: false, head_near_L: false, head_near_R: false,
    },
    armPose: {
      elev_L: 90, elev_R: 170, elev_torso_L: 90, elev_torso_R: 170,
      reach_L: 1.6, reach_R: 0.84, reach_head_L: 2, reach_head_R: 2,
      hands_close: 2.0, crossed: false, on_hips: false, open_wide: false,
      chest_height: false, has_world: true,
      extend_L: true, extend_R: false,
      azimuth_L: 180, azimuth_R: 0,
      azimuth_body_L: 0, azimuth_body_R: 180,
      arm_front_L: false, arm_front_R: false,
      arm_front_body_L: true, arm_front_body_R: false,
      arm_side_L: false, arm_side_R: false,
    },
    wave: { L: 0, R: 0, amp: 0 },
    ...o,
  });
  const hands = (l, r) => ({ L: l, R: r });
  const run = (sig, n = 5) => {
    const ae = new ActionEngine();
    let t = 0; let r = null;
    for (let i = 0; i < n; i++) r = ae.update(sig, t += 100, hands('pointing', null));
    return r;
  };

  const backReach = run(mkSig());
  check('背身：手在身体前方（相机 180°）→ 指向成立', backReach.flags.pointing === true);
  check('背身：臂伸出 → 前平举成立', backReach.flags.armFront === true);

  // 同样的相机方位（180°=远离相机），但身体朝向是正面时它是「身后」——不能算前平举。
  const behind = run(mkSig({
    armPose: {
      ...mkSig().armPose,
      arm_front_L: false, arm_front_body_L: false,
    },
  }));
  check('身体前方不在相机正前方 → 不算前平举', behind.flags.armFront === false);
  check('同一帧也不算指向', behind.flags.pointing === false);

  // 旧信号对象没有 arm_front_body_*：退回相机版本（旧行为）
  const legacyPose = { ...mkSig().armPose };
  delete legacyPose.arm_front_body_L;
  delete legacyPose.arm_front_body_R;
  const legacy = run(mkSig({ armPose: { ...legacyPose, arm_front_L: true } }));
  check('旧信号没有 arm_front_body → 退回相机版本', legacy.flags.pointing === true
    && legacy.flags.armFront === true);
}

console.log('\n[5] UI 文案与 profile 值域校验');
{
  check('正面文案', bodyFacingText({ facing: 'front', yaw: 3, yaw_source: '3d' }).startsWith('正面'));
  check('背面文案', bodyFacingText({ facing: 'back', yaw: 178, yaw_source: '3d' }).startsWith('背面'));
  check('2D 文案标近似', bodyFacingText({ facing: 'back', yaw: 180, yaw_source: '2d' }).includes('≈'));
  check('未知朝向不编角度', bodyFacingText({ facing: 'unknown', yaw: null }) === '—');

  const throws = (over) => {
    try { validateParams(over); return false; } catch { return true; }
  };
  check('frontMax >= backMin → 加载时报错', throws({ signals: { bodyFacing: { frontMax: 140 } } }));
  check('sideRatio <= 0 → 报错', throws({ signals: { bodyFacing: { sideRatio: 0 } } }));
  check('holdMs < 0 → 报错', throws({ signals: { bodyFacing: { holdMs: -1 } } }));
  check('enabled=false 时不校验其余阈值',
    !throws({ signals: { bodyFacing: { enabled: false, frontMax: 999 } } }));
  check('合法覆盖 → 通过', !throws({ signals: { bodyFacing: { frontMax: 40, backMin: 140 } } }));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
