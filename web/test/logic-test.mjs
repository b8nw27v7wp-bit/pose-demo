// logic-test.mjs — 信号层与动作层的确定性单测（不依赖浏览器、不依赖摄像头）
// 运行：node web/test/logic-test.mjs
//
// 说明：这里验证的是**判定逻辑**（角度、滤波、滞回、计数门控、姿态互斥、置信冻结），
// 用人工构造的骨架/信号序列，不代表真实场景精度。真实精度必须用实拍素材校准。

import { angleDeg, angleDeg3, OneEuro, Hold, RepCounter, PhaseSequence, SignalEngine, KpFilter, BoneLengthGuard } from '../js/signals.js';
import { ActionEngine, ARM_ACTIONS } from '../js/actions.js';
import { classifyHand, HandShapeStabilizer } from '../js/handshape.js';
import { toHands, handOrientation, spreadRatio } from '../js/handformat.js';
import { summarize, quantile, overlapCoefficient } from '../js/stats.js';

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

const near = (a, b, tol = 0.5) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// —— 1. 角度 ——
console.log('\n[1] angleDeg');
check('直角', near(angleDeg([0, 0], [1, 0], [1, 1]), 90));
check('平角', near(angleDeg([0, 0], [1, 0], [2, 0]), 180));
check('缺参返回 NaN', Number.isNaN(angleDeg(null, [1, 0], [2, 0])));
check('零长度返回 NaN', Number.isNaN(angleDeg([1, 0], [1, 0], [2, 0])));

// —— 2. One Euro 滤波 ——
console.log('\n[2] OneEuro 平滑');
{
  const f = new OneEuro({ minCutoff: 1.0, beta: 0.05 });
  const noisy = [];
  const out = [];
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  for (let i = 0; i < 120; i++) {
    const v = 100 + rand() * 10;
    noisy.push(v);
    out.push(f.filter(v, i / 30));
  }
  const std = (a) => {
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };
  const sIn = std(noisy.slice(10));
  const sOut = std(out.slice(10));
  check('噪声被压低', sOut < sIn * 0.5, `in=${sIn.toFixed(2)} out=${sOut.toFixed(2)}`);
}

// —— 3. Hold 最短持续 ——
console.log('\n[3] Hold');
{
  const h = new Hold(400);
  check('0ms 未激活', h.update(true, 0) === false);
  check('200ms 未激活', h.update(true, 200) === false);
  check('500ms 激活', h.update(true, 500) === true);
  check('duration 用外部时间戳', near(h.duration, 500, 1), `duration=${h.duration}`);
  check('条件断开即失活', h.update(false, 600) === false);
  check('重新计时', h.update(true, 700) === false && h.update(true, 800) === false);
}

// —— 4. RepCounter 滞回 / 最小周期 / abort ——
console.log('\n[4] RepCounter');
{
  const rc = new RepCounter({ down: 100, up: 150, minCycleMs: 600 });
  rc.update(170, 0); rc.update(90, 300); rc.update(160, 900);
  check('正常一次计 1', rc.count === 1, `count=${rc.count}`);

  const rc2 = new RepCounter({ down: 100, up: 150, minCycleMs: 600 });
  let t = 0;
  for (let i = 0; i < 40; i++) { t += 33; rc2.update(i % 2 ? 95 : 110, t); }
  check('阈值附近抖动不计数', rc2.count === 0, `count=${rc2.count}`);

  const rc3 = new RepCounter({ down: 100, up: 150, minCycleMs: 600 });
  rc3.update(170, 0); rc3.update(90, 100); rc3.update(160, 250);
  check('过快周期不计数', rc3.count === 0, `count=${rc3.count}`);

  const rc4 = new RepCounter({ down: 100, up: 150, minCycleMs: 600 });
  let tt = 0;
  for (let r = 0; r < 3; r++) {
    rc4.update(170, tt); rc4.update(90, tt + 300); rc4.update(160, tt + 1000); tt += 1200;
  }
  check('三次连续计 3', rc4.count === 3, `count=${rc4.count}`);

  const rc5 = new RepCounter({ down: 100, up: 150, minCycleMs: 600 });
  rc5.update(170, 0); rc5.update(90, 300);
  rc5.abort();
  rc5.update(160, 900);
  check('abort 后不误计', rc5.count === 0, `count=${rc5.count}`);
}

// —— 5. SignalEngine：站姿 / 卧姿 的骨架几何 ——
console.log('\n[5] SignalEngine 几何');
const standKp = [
  [100, 50, 1],
  [90, 100, 1], [110, 100, 1],
  [85, 150, 1], [115, 150, 1],
  [80, 200, 1], [120, 200, 1],
  [92, 220, 1], [108, 220, 1],
  [90, 300, 1], [110, 300, 1],
  [88, 380, 1], [112, 380, 1],
];
const lieKp = [
  [60, 210, 1],
  [100, 200, 1], [100, 220, 1],
  [150, 200, 1], [150, 220, 1],
  [200, 200, 1], [200, 220, 1],
  [200, 200, 1], [200, 220, 1],
  [280, 200, 1], [280, 220, 1],
  [350, 200, 1], [350, 220, 1],
];
const person = (kp, score = 0.9) => ({ kp, kp_raw: [], bbox: [0, 0, 1, 1], scale: 100, score, track_id: 0 });

{
  const se = new SignalEngine();
  const s = se.update(person(standKp), 1000);
  check('站姿直立度≈1', near(s.uprightness, 1, 0.05), `uprightness=${s.uprightness.toFixed(3)}`);
  check('站姿腿竖直比≈1.33', near(s.leg_vertical, 1.33, 0.1), `leg_vertical=${s.leg_vertical.toFixed(2)}`);
  check('站姿膝角≈180', near(s.knee_pick, 180, 3), `knee=${s.knee_pick.toFixed(1)}`);
  check('站姿尺度=躯干长', near(s.scale, 120, 3), `scale=${s.scale.toFixed(1)}`);
  check('站姿 ok=true', s.ok === true);

  const se2 = new SignalEngine();
  const s2 = se2.update(person(lieKp), 1000);
  check('卧姿直立度≈0', near(s2.uprightness, 0, 0.1), `uprightness=${s2.uprightness.toFixed(3)}`);
  check('卧姿腿竖直比≈0', Math.abs(s2.leg_vertical) < 0.3, `leg_vertical=${s2.leg_vertical.toFixed(2)}`);

  const se3 = new SignalEngine();
  const low = se3.update(person(standKp, 0.2), 1000);
  check('低置信度 ok=false', low.ok === false, `score=${low.score}`);
}

// —— 6. ActionEngine：姿态需要连续帧 + 最短持续 ——
console.log('\n[6] 姿态判定');
{
  const se = new SignalEngine();
  const ae = new ActionEngine();
  let act = null;
  for (let i = 0; i < 2; i++) act = ae.update(se.update(person(standKp), 1000 + i * 100), 1000 + i * 100);
  check('2 帧不出姿态', act.postureId === null, `posture=${act.posture}`);

  for (let i = 2; i <= 10; i++) act = ae.update(se.update(person(standKp), 1000 + i * 100), 1000 + i * 100);
  check('连续 1 秒 → 站立', act.postureId === 'stand', `posture=${act.posture}`);
  check('姿态持续时长 > 0', act.postureMs > 0, `postureMs=${act.postureMs}`);

  const se2 = new SignalEngine();
  const ae2 = new ActionEngine();
  let act2 = null;
  for (let i = 0; i <= 10; i++) act2 = ae2.update(se2.update(person(lieKp), 1000 + i * 100), 1000 + i * 100);
  check('卧姿 → 躺卧', act2.postureId === 'lying', `posture=${act2.posture}`);

  // 注册表一致性：ARM_ACTIONS.flag 是页面、评估器、难例导出共用的键名。
  // 写错一个字母不会报错，只会让这个动作在 UI/评估里永远为 false——手抄时代就这么漏过。
  // 这里直接对着 ActionEngine 的真实输出校验；冻结分支用的是另一份 flags 字面量，一并覆盖。
  const seFlag = new SignalEngine();
  const live = new ActionEngine().update(seFlag.update(person(standKp), 5000), 5000);
  const frozen = new ActionEngine()
    .update(seFlag.update(person(standKp, 0.2), 5200), 5200);
  const missingFlag = ARM_ACTIONS
    .filter((a) => !(a.flag in live.flags) || !(a.flag in frozen.flags))
    .map((a) => a.flag);
  check('每个 ARM_ACTIONS.flag 都是 act.flags 的键（含冻结分支）',
    missingFlag.length === 0, `missing=${missingFlag}`);
}

// —— 7. 计数门控：坐下不能被记成深蹲 ——
console.log('\n[7] 计数门控');
const mkSig = (o = {}) => ({
  ok: true,
  knee_pick: 170,
  elbow_pick: 170,
  uprightness: 0.95,
  leg_vertical: 1.3,
  arm: { any_raised: false, both_raised: false },
  armPose: {
    elev_L: 170, elev_R: 170, reach_L: 0.6, reach_R: 0.6, hands_close: 2.0,
    crossed: false, on_hips: false, open_wide: false, chest_height: false,
  },
  wave: { L: 0, R: 0, amp: 0 },
  ...o,
});
{
  const ae = new ActionEngine();
  let t = 0;
  ae.update(mkSig(), t);
  ae.update(mkSig({ knee_pick: 90 }), t += 300);
  const r = ae.update(mkSig({ knee_pick: 165 }), t += 700);
  check('站立深蹲计 1', r.reps.squat === 1, `squat=${r.reps.squat}`);
  check('门控为真', r.gates.squat === true);

  const ae2 = new ActionEngine();
  let t2 = 0;
  ae2.update(mkSig({ leg_vertical: 0.6 }), t2);
  ae2.update(mkSig({ knee_pick: 90, leg_vertical: 0.6 }), t2 += 300);
  const r2 = ae2.update(mkSig({ knee_pick: 165, leg_vertical: 0.6 }), t2 += 700);
  check('坐下不计深蹲', r2.reps.squat === 0, `squat=${r2.reps.squat}`);
  check('坐下门控为假', r2.gates.squat === false);

  const ae3 = new ActionEngine();
  let t3 = 0;
  ae3.update(mkSig(), t3);
  ae3.update(mkSig({ elbow_pick: 80 }), t3 += 300);
  const r3 = ae3.update(mkSig({ elbow_pick: 165 }), t3 += 700);
  check('站立弯肘不算俯卧撑', r3.reps.pushup === 0, `pushup=${r3.reps.pushup}`);

  const ae4 = new ActionEngine();
  let t4 = 0;
  ae4.update(mkSig({ uprightness: 0.2 }), t4);
  ae4.update(mkSig({ uprightness: 0.2, elbow_pick: 80 }), t4 += 300);
  const r4 = ae4.update(mkSig({ uprightness: 0.2, elbow_pick: 165 }), t4 += 700);
  check('卧姿弯肘 → 俯卧撑 1', r4.reps.pushup === 1, `pushup=${r4.reps.pushup}`);
}

// —— 8. 低置信度冻结 ——
console.log('\n[8] 置信冻结');
{
  const ae = new ActionEngine();
  let t = 0;
  let r = null;
  for (let i = 0; i < 10; i++) r = ae.update(mkSig(), t += 100);
  check('先进入站立', r.postureId === 'stand');
  const before = r.reps.squat;
  const frozen = ae.update(mkSig({ ok: false, knee_pick: 80 }), t += 300);
  check('置信不足标记 frozen', frozen.frozen === true);
  check('冻结时保持原姿态', frozen.postureId === 'stand', `posture=${frozen.posture}`);
  check('冻结时计数不推进', frozen.reps.squat === before, `squat=${frozen.reps.squat}`);
  check('冻结时沿用上次门控', JSON.stringify(frozen.gates) === JSON.stringify(r.gates),
    `frozen=${JSON.stringify(frozen.gates)} prev=${JSON.stringify(r.gates)}`);
}

// —— 9. 挥手需要幅度 ——
console.log('\n[9] 挥手');
{
  const ae = new ActionEngine();
  let t = 0;
  let r = null;
  for (let i = 0; i < 6; i++) {
    r = ae.update(mkSig({
      arm: { any_raised: true, both_raised: false },
      wave: { L: 4, R: 0, amp: 0.05 },
    }), t += 100);
  }
  check('幅度不足不算挥手', r.flags.waving === false, `waving=${r.flags.waving}`);

  const ae2 = new ActionEngine();
  let t2 = 0;
  let r2 = null;
  for (let i = 0; i < 6; i++) {
    r2 = ae2.update(mkSig({
      arm: { any_raised: true, both_raised: false },
      wave: { L: 4, R: 0, amp: 0.6 },
    }), t2 += 100);
  }
  check('幅度足够算挥手', r2.flags.waving === true, `waving=${r2.flags.waving}`);
  check('举手同时成立', r2.flags.armRaised === true);
}

// —— 10. 手臂信号：抱臂 / 叉腰 / 张开双臂 / 抬手角 ——
console.log('\n[10] 手臂信号');
{
  // 基础站姿：腕自然下垂在髋附近
  const base = (wl, wr) => [
    [100, 50, 1],
    [90, 100, 1], [110, 100, 1],
    [85, 150, 1], [115, 150, 1],
    wl, wr,
    [92, 220, 1], [108, 220, 1],
    [90, 300, 1], [110, 300, 1],
    [88, 380, 1], [112, 380, 1],
  ];

  const se = new SignalEngine();
  const down = se.update(person(base([80, 210, 1], [120, 210, 1])), 1000);
  check('自然下垂抬臂角≈180', near(down.armPose.elev_L, 180, 12), `elev_L=${down.armPose.elev_L.toFixed(0)}`);
  check('自然下垂不算张开', down.armPose.open_wide === false);
  check('自然下垂不算举手', down.arm.any_raised === false);

  const se2 = new SignalEngine();
  const up = se2.update(person(base([85, 20, 1], [115, 20, 1])), 1000);
  check('腕在肩上 → 举手', up.arm.any_raised === true);
  check('腕在肩上抬臂角≈0', near(up.armPose.elev_L, 0, 15), `elev_L=${up.armPose.elev_L.toFixed(0)}`);

  const se3 = new SignalEngine();
  // 约定：这份合成骨架是"背对镜头"（肩 L 在画面左侧 x 更小），
  // 所以抱臂 = 两腕顺序相对肩膀翻转 → 腕 L 跑到右侧
  const cross = se3.update(person(base([120, 160, 1], [80, 160, 1])), 1000);
  check('两腕顺序相对肩膀翻转 → 抱臂', cross.armPose.crossed === true);

  // 手自然下垂：腕就在髋旁（旧判据会误判成叉腰），但肘没有外张 → 不算叉腰
  const se4 = new SignalEngine();
  const hang = se4.update(person(base([95, 215, 1], [105, 215, 1])), 1000);
  check('手自然下垂 → 不算叉腰', hang.armPose.on_hips === false);

  // 真叉腰：腕贴髋 **且肘外张**（肘的 x 明显离开肩-髋连线）
  const se4b = new SignalEngine();
  const hipsKp = base([95, 215, 1], [105, 215, 1]);
  hipsKp[3] = [60, 165, 1];   // 左肘外张
  hipsKp[4] = [140, 165, 1];  // 右肘外张
  const hips = se4b.update(person(hipsKp), 1000);
  check('腕贴髋 + 肘外张 → 叉腰', hips.armPose.on_hips === true);

  const se5 = new SignalEngine();
  const wide = se5.update(person(base([-20, 100, 1], [220, 100, 1])), 1000);
  check('两臂平举外伸 → 张开双臂', wide.armPose.open_wide === true, `elev=${wide.armPose.elev_L.toFixed(0)} reach=${wide.armPose.reach_L.toFixed(2)}`);
}

// —— 11. 手势分类（合成 21 点手）——
console.log('\n[11] 手势分类');
{
  // 造一只 21 点的手：wrist(0) + 四指(mcp,pip,dip,tip) + 拇指(1-4)
  function buildHand({ index = false, middle = false, ring = false, pinky = false, thumb = 'in' }) {
    const mcp = { index: [0.35, -1.0], middle: [0.05, -1.05], ring: [-0.25, -1.0], pinky: [-0.5, -0.85] };
    const base = { index: 5, middle: 9, ring: 13, pinky: 17 };
    const ext = { index, middle, ring, pinky };
    const kp = new Array(21).fill(null);
    kp[0] = [0, 0];
    for (const f of ['index', 'middle', 'ring', 'pinky']) {
      const m = mcp[f];
      const i0 = base[f];
      let pip, dip, tip;
      if (ext[f]) {
        pip = [m[0], m[1] - 0.35]; dip = [m[0], m[1] - 0.6]; tip = [m[0], m[1] - 0.85];
      } else {
        pip = [m[0], m[1] - 0.25]; dip = [pip[0] + 0.02, pip[1] - 0.12]; tip = [dip[0] + 0.02, dip[1] + 0.15];
      }
      kp[i0] = m; kp[i0 + 1] = pip; kp[i0 + 2] = dip; kp[i0 + 3] = tip;
    }
    if (thumb === 'out') {
      kp[1] = [0.3, -0.3]; kp[2] = [0.55, -0.55]; kp[3] = [0.8, -0.75]; kp[4] = [1.0, -0.9];
    } else if (thumb === 'ok') {
      kp[1] = [0.3, -0.35]; kp[2] = [0.5, -0.55]; kp[3] = [0.55, -0.7];
      kp[4] = [kp[8][0] + 0.03, kp[8][1] + 0.03];   // 拇指尖贴住食指尖
    } else {
      kp[1] = [0.3, -0.35]; kp[2] = [0.45, -0.5]; kp[3] = [0.4, -0.62]; kp[4] = [0.38, -0.75];
    }
    return kp;
  }

  const cases = [
    ['fist', { }],
    ['open', { index: true, middle: true, ring: true, pinky: true, thumb: 'out' }],
    ['victory', { index: true, middle: true }],
    ['pointing', { index: true }],
    ['thumbs_up', { thumb: 'out' }],
    ['ok', { middle: true, ring: true, pinky: true, thumb: 'ok' }],
  ];
  for (const [want, spec] of cases) {
    const got = classifyHand(buildHand(spec));
    check(`合成手 → ${want}`, got.shape === want, `got=${got.shape} fingers=${JSON.stringify(got.fingers)}`);
  }
}

// —— 12. 鼓掌计数（两腕距离的周期）——
console.log('\n[12] 鼓掌');
{
  const chest = (hc) => mkSig({
    armPose: {
      elev_L: 90, elev_R: 90, reach_L: 0.7, reach_R: 0.7, hands_close: hc,
      crossed: false, on_hips: false, open_wide: false, chest_height: true,
    },
  });
  const ae = new ActionEngine();
  let t = 0;
  ae.update(chest(1.4), t);
  ae.update(chest(0.3), t += 200);       // 合掌
  const r = ae.update(chest(1.4), t += 500); // 分开
  check('一次鼓掌计 1', r.reps.clap === 1, `clap=${r.reps.clap}`);
  check('鼓掌门控为真', r.gates.clap === true);

  // 胸前以外（头顶合手）不计数
  const ae2 = new ActionEngine();
  let t2 = 0;
  const overhead = (hc) => mkSig({
    armPose: {
      elev_L: 10, elev_R: 10, reach_L: 0.8, reach_R: 0.8, hands_close: hc,
      crossed: false, on_hips: false, open_wide: false, chest_height: false,
    },
  });
  ae2.update(overhead(1.4), t2);
  ae2.update(overhead(0.3), t2 += 200);
  const r2 = ae2.update(overhead(1.4), t2 += 500);
  check('非胸前高度不计数', r2.reps.clap === 0, `clap=${r2.reps.clap}`);

  // 抱臂时两腕也很近，不能被当成鼓掌
  const crossedSig = (hc) => mkSig({
    armPose: {
      elev_L: 100, elev_R: 100, reach_L: 0.3, reach_R: 0.3, hands_close: hc,
      crossed: true, on_hips: false, open_wide: false, chest_height: true,
    },
  });
  const ae3 = new ActionEngine();
  let t3 = 0;
  ae3.update(crossedSig(1.4), t3);
  ae3.update(crossedSig(0.3), t3 += 200);
  const r3 = ae3.update(crossedSig(1.4), t3 += 500);
  check('抱臂不计鼓掌', r3.reps.clap === 0 && r3.gates.clap === false, `clap=${r3.reps.clap} gate=${r3.gates.clap}`);
}

// —— 13. 可见性门控：看不见的点不能参与计算 ——
console.log('\n[13] 可见性门控');
{
  const withVis = (kp, visMap) => kp.map((p, i) => {
    const name = ['nose', 'shoulder_L', 'shoulder_R', 'elbow_L', 'elbow_R', 'wrist_L', 'wrist_R',
      'hip_L', 'hip_R', 'knee_L', 'knee_R', 'ankle_L', 'ankle_R'][i];
    return visMap[name] !== undefined ? [p[0], p[1], visMap[name]] : p;
  });

  // 踝不可见：leg_vertical 必须为 NaN（否则深蹲门控会拿垃圾坐标判 true）
  const se = new SignalEngine();
  const s = se.update(person(withVis(standKp, { ankle_L: 0.05, ankle_R: 0.05 })), 1000);
  check('踝不可见 → leg_vertical=NaN', Number.isNaN(s.leg_vertical), `leg_vertical=${s.leg_vertical}`);
  const ae = new ActionEngine();
  const r = ae.update({ ...mkSig({ leg_vertical: NaN }), ok: true }, 1000);
  check('leg_vertical=NaN → 深蹲门控为假', r.gates.squat === false);

  // 腕不可见：举手/抱臂/鼓掌都不能成立
  const se2 = new SignalEngine();
  const s2 = se2.update(person(withVis(standKp, { wrist_L: 0.05, wrist_R: 0.05 })), 1000);
  check('腕不可见 → 不算举手', s2.arm.any_raised === false);
  check('腕不可见 → elev=NaN', Number.isNaN(s2.armPose.elev_L), `elev=${s2.armPose.elev_L}`);
  check('腕不可见 → 不算抱臂', s2.armPose.crossed === false);
  check('腕不可见 → 不算鼓掌高度', s2.armPose.chest_height === false);
}

// —— 14. 抱臂判定要抗转身 ——
console.log('\n[14] 抱臂抗转身');
{
  // 面朝镜头：被识别者的左手出现在画面右侧（x 更大）
  const facing = (wl, wr) => [
    [100, 50, 1], [110, 100, 1], [90, 100, 1], [115, 150, 1], [85, 150, 1], wl, wr,
    [108, 220, 1], [92, 220, 1], [110, 300, 1], [90, 300, 1], [112, 380, 1], [88, 380, 1],
  ];
  const seA = new SignalEngine();
  const normal = seA.update(person(facing([120, 160, 1], [80, 160, 1])), 1000);
  check('面朝镜头·正常 → 不算抱臂', normal.armPose.crossed === false);

  const seB = new SignalEngine();
  const crossA = seB.update(person(facing([80, 160, 1], [120, 160, 1])), 1000);
  check('面朝镜头·交叉 → 抱臂', crossA.armPose.crossed === true);

  // 背对镜头：被识别者的左手出现在画面左侧（x 更小）
  const back = (wl, wr) => [
    [100, 50, 1], [90, 100, 1], [110, 100, 1], [85, 150, 1], [115, 150, 1], wl, wr,
    [92, 220, 1], [108, 220, 1], [90, 300, 1], [110, 300, 1], [88, 380, 1], [112, 380, 1],
  ];
  const seC = new SignalEngine();
  const backNormal = seC.update(person(back([80, 160, 1], [120, 160, 1])), 1000);
  check('背对镜头·正常 → 不算抱臂', backNormal.armPose.crossed === false);

  const seD = new SignalEngine();
  const backCross = seD.update(person(back([120, 160, 1], [80, 160, 1])), 1000);
  check('背对镜头·交叉 → 抱臂', backCross.armPose.crossed === true);
}

// —— 15. knee_pick 单侧无效时回退 ——
console.log('\n[15] knee_pick 回退');
{
  // 左腿三点重合 → 左膝角 NaN；右腿正常
  const brokenLeft = [
    [100, 50, 1],
    [90, 100, 1], [110, 100, 1],
    [85, 150, 1], [115, 150, 1],
    [80, 200, 1], [120, 200, 1],
    [92, 220, 1], [108, 220, 1],
    [92, 220, 1], [110, 300, 1],   // 左膝 = 左髋（重合）
    [92, 220, 1], [112, 380, 1],   // 左踝也重合
  ];
  const se = new SignalEngine();
  const s = se.update(person(brokenLeft), 1000);
  check('左膝无效 → knee_pick 取右腿', s.knee_side === 'R' && Number.isFinite(s.knee_pick),
    `side=${s.knee_side} knee=${Number.isFinite(s.knee_pick) ? s.knee_pick.toFixed(1) : 'NaN'}`);
}

// —— 16. 手部结果映射（handedness 缺失不能默认成右手）——
console.log('\n[16] 手部结果映射');
{
  const mkResult = (handednesses) => ({
    landmarks: [Array.from({ length: 21 }, (_, i) => ({ x: i * 0.01, y: i * 0.02, z: 0 }))],
    handednesses,
  });

  const left = toHands(mkResult([[{ categoryName: 'Left', score: 0.91 }]]), 1000, 1000);
  check('Left 原样映射', left.length === 1 && left[0].handedness === 'Left', `got=${left[0]?.handedness}`);
  check('score 透传', Math.abs(left[0].score - 0.91) < 1e-6);
  check('kp 换算成像素', Math.abs(left[0].kp[1][0] - 10) < 1e-6 && Math.abs(left[0].kp[1][1] - 20) < 1e-6);
  check('scale = 腕↔中指MCP 距离', Math.abs(left[0].scale - Math.hypot(90, 180)) < 1e-6, `scale=${left[0].scale.toFixed(1)}`);

  const right = toHands(mkResult([[{ categoryName: 'Right', score: 0.8 }]]), 1000, 1000);
  check('Right 原样映射', right[0].handedness === 'Right');

  const missing = toHands(mkResult(undefined), 1000, 1000);
  check('handedness 缺失 → unknown', missing[0].handedness === 'unknown', `got=${missing[0].handedness}`);

  const empty = toHands({ landmarks: [[{ x: 0, y: 0 }]] }, 1000, 1000);
  check('点数不足 21 的手被跳过', empty.length === 0);
}

// —— 17. 三维夹角 + 3D 抬臂角（抗俯仰）——
console.log('\n[17] 3D 信号');
{
  check('3D 直角', near(angleDeg3([1, 0, 0], [0, 0, 0], [0, 1, 0]), 90));
  check('3D 零向量返回 NaN', Number.isNaN(angleDeg3([0, 0, 0], [0, 0, 0], [1, 0, 0])));

  // 带 world 的站姿：手臂自然下垂（腕在肩下方），3D 抬臂角应接近 180°
  const withWorld = (kp, world) => ({ ...person(kp), kp_world: world });
  const mkW = (over = {}) => {
    const w = new Array(33).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
    const set = (i, x, y, z) => { w[i] = { x, y, z }; };
    // 躯干：hip 在 y=0，肩在 y=-0.48（世界坐标 y 向下为正）
    set(23, -0.1, 0, 0); set(24, 0.1, 0, 0);
    set(11, -0.16, -0.48, 0); set(12, 0.16, -0.48, 0);
    set(0, 0, -0.62, 0);
    // 左臂自然下垂：腕在肩正下方
    set(13, -0.2, -0.25, 0); set(15, -0.2, 0.05, 0);
    // 右臂举起：腕在肩正上方
    set(14, 0.2, -0.75, 0); set(16, 0.2, -1.05, 0);
    for (const [k, v] of Object.entries(over)) set(Number(k), v[0], v[1], v[2]);
    return w.map((p) => [p.x, p.y, p.z]);
  };
  const se = new SignalEngine();
  const s = se.update(withWorld(standKp, mkW()), 1000);
  check('有 world → has_world=true', s.armPose.has_world === true);
  check('自然下垂 3D 抬臂角 ≈180°', near(s.armPose.elev_torso_L, 180, 20), `L=${s.armPose.elev_torso_L.toFixed(0)}`);
  check('举起 3D 抬臂角 ≈0°', near(s.armPose.elev_torso_R, 0, 20), `R=${s.armPose.elev_torso_R.toFixed(0)}`);
  check('右臂举起 → raised3d_R', s.arm.raised3d_R === true);
  check('左臂下垂 → 不 raised3d_L', s.arm.raised3d_L === false);

  // 没有 world 时不崩，has_world=false，下游退回 2D
  const se2 = new SignalEngine();
  const s2 = se2.update(person(standKp), 1000);
  check('无 world → has_world=false', s2.armPose.has_world === false);
  check('无 world → 3D 抬臂角 NaN', Number.isNaN(s2.armPose.elev_torso_L));
}

// —— 18. 手在头部附近 ——
console.log('\n[18] 手在头部');
{
  const base = (wl, wr) => [
    [100, 50, 1],
    [90, 100, 1], [110, 100, 1],
    [85, 150, 1], [115, 150, 1],
    wl, wr,
    [92, 220, 1], [108, 220, 1],
    [90, 300, 1], [110, 300, 1],
    [88, 380, 1], [112, 380, 1],
  ];
  const se = new SignalEngine();
  // 腕贴近鼻尖（鼻在 [100,50]，scale≈120，阈值 0.85·scale≈102px）
  const near2 = se.update(person(base([120, 60, 1], [110, 210, 1])), 1000);
  check('腕贴近鼻尖 → head_near_L', near2.arm.head_near_L === true,
    `reach=${near2.armPose.reach_head_L?.toFixed(2)}`);
  check('另一只手自然下垂 → 不 head_near_R', near2.arm.head_near_R === false);

  const se2 = new SignalEngine();
  const far = se2.update(person(base([80, 210, 1], [120, 210, 1])), 1000);
  check('手在髋旁 → 不在头部', far.arm.head_near_L === false);

  // 走路时手臂前摆经过脸前：腕离鼻尖不远，但明显低于肩 → 不能算「手在头部」
  const se3 = new SignalEngine();
  const swing = se3.update(person(base([105, 150, 1], [95, 210, 1])), 1000);
  check('走路前摆（腕低于肩）→ 不算手在头部', swing.arm.head_near_R === false,
    `reach=${swing.armPose.reach_head_R?.toFixed(2)}`);
}

// —— 18b. 双手高举 ——
console.log('\n[18b] 双手高举');
{
  const both = (wl, wr) => [
    [100, 50, 1],
    [90, 100, 1], [110, 100, 1],
    [85, 150, 1], [115, 150, 1],
    wl, wr,
    [92, 220, 1], [108, 220, 1],
    [90, 300, 1], [110, 300, 1],
    [88, 380, 1], [112, 380, 1],
  ];
  const mkSig = (o = {}) => ({
    ok: true, knee_pick: 170, elbow_pick: 170, uprightness: 0.95, leg_vertical: 1.3,
    arm: { any_raised: true, raised_L: true, raised_R: true, raised3d_L: true, raised3d_R: true, head_near_L: false, head_near_R: false },
    armPose: {
      elev_L: 10, elev_R: 10, elev_torso_L: 10, elev_torso_R: 10,
      reach_L: 0.6, reach_R: 0.6, hands_close: 2.0,
      crossed: false, on_hips: false, open_wide: false, chest_height: false, has_world: false,
    },
    wave: { L: 0, R: 0, amp: 0 },
    ...o,
  });

  const ae = new ActionEngine();
  let t = 0;
  let r = null;
  for (let i = 0; i < 8; i++) r = ae.update(mkSig(), t += 100);
  check('双臂都举起 → bothHandsUp', r.flags.bothHandsUp === true);

  // 只举一只手不算双手高举
  const ae2 = new ActionEngine();
  let t2 = 0;
  let r2 = null;
  for (let i = 0; i < 8; i++) {
    r2 = ae2.update(mkSig({
      arm: { any_raised: true, raised_L: true, raised_R: false, raised3d_L: true, raised3d_R: false, head_near_L: false, head_near_R: false },
    }), t2 += 100);
  }
  check('只举一手 → 不算双手高举', r2.flags.bothHandsUp === false);
  check('只举一手 → 仍算举手', r2.flags.armRaised === true);
}

// —— 19. 手势抗抖（连续帧才切换）——
console.log('\n[19] 手势去抖');
{
  const st = new HandShapeStabilizer({ streak: 3, keepMs: 250 });
  check('首帧不切换', st.update('open', 0) === 'unknown');
  check('第 2 帧不切换', st.update('open', 100) === 'unknown');
  check('第 3 帧切换', st.update('open', 200) === 'open');

  // 单帧误判不能把稳定手势打掉
  check('单帧异常保持原手势', st.update('victory', 300) === 'open');
  check('异常消失仍是原手势', st.update('open', 400) === 'open');

  // 连续 3 帧新手势才切换
  st.update('victory', 500);
  st.update('victory', 600);
  check('新手势连续 3 帧 → 切换', st.update('victory', 700) === 'victory');

  // 判不出来时短暂保持，超过 keepMs 才清空
  check('判不出来短时保持', st.update('unknown', 800) === 'victory');
  check('超过 keepMs 清空', st.update('unknown', 1100) === 'unknown');
}

// —— 20. 新手势 / 朝向 / 张开度 ——
console.log('\n[20] 手部信号扩展');
{
  function buildHand({ index = false, middle = false, ring = false, pinky = false, thumb = 'in' }) {
    const mcp = { index: [0.35, -1.0], middle: [0.05, -1.05], ring: [-0.25, -1.0], pinky: [-0.5, -0.85] };
    const base = { index: 5, middle: 9, ring: 13, pinky: 17 };
    const ext = { index, middle, ring, pinky };
    const kp = new Array(21).fill(null);
    kp[0] = [0, 0];
    for (const f of ['index', 'middle', 'ring', 'pinky']) {
      const m = mcp[f];
      const i0 = base[f];
      let pip, dip, tip;
      if (ext[f]) {
        pip = [m[0], m[1] - 0.35]; dip = [m[0], m[1] - 0.6]; tip = [m[0], m[1] - 0.85];
      } else {
        pip = [m[0], m[1] - 0.25]; dip = [pip[0] + 0.02, pip[1] - 0.12]; tip = [dip[0] + 0.02, dip[1] + 0.15];
      }
      kp[i0] = m; kp[i0 + 1] = pip; kp[i0 + 2] = dip; kp[i0 + 3] = tip;
    }
    if (thumb === 'out') {
      kp[1] = [0.3, -0.3]; kp[2] = [0.55, -0.55]; kp[3] = [0.8, -0.75]; kp[4] = [1.0, -0.9];
    } else {
      kp[1] = [0.3, -0.35]; kp[2] = [0.45, -0.5]; kp[3] = [0.4, -0.62]; kp[4] = [0.38, -0.75];
    }
    return kp;
  }

  check('拇指+食指 → 手枪', classifyHand(buildHand({ index: true, thumb: 'out' })).shape === 'gun');
  check('食指+小指 → 摇滚', classifyHand(buildHand({ index: true, pinky: true })).shape === 'rock');
  check('手枪不比竖拇指误命中', classifyHand(buildHand({ index: true, thumb: 'out' })).shape !== 'thumbs_up');

  // 朝向：手掌正对镜头 vs 侧对
  const flat = buildHand({ index: true, middle: true, ring: true, pinky: true, thumb: 'out' });
  const o = handOrientation(flat);
  check('张开手 → 有朝向标量', Number.isFinite(o.side));
  check('朝向含 facing 字段', ['front', 'edge'].includes(o.facing), `facing=${o.facing}`);

  // 张开度：食指与小指的扇开夹角。用「真实握拳」几何——蜷进掌心，指尖收向腕部
  const openHand = buildHand({ index: true, middle: true, ring: true, pinky: true, thumb: 'out' });
  const fistHand = buildHand({});
  // 握拳：把四点指尖收拢到掌心（腕上方一点），这是真实握拳的样子
  const palm = [0, -0.55];
  for (const tip of [8, 12, 16, 20]) {
    fistHand[tip] = [palm[0] + (fistHand[tip][0] - palm[0]) * 0.15, palm[1] + (fistHand[tip][1] - palm[1]) * 0.15];
  }
  const spreadOpen = spreadRatio(openHand);
  const spreadFist = spreadRatio(fistHand);
  check('张开手比握拳扇开更大', spreadOpen > spreadFist, `open=${spreadOpen}° fist=${spreadFist}°`);

  // toHands 要透传新字段
  const res = toHands({
    landmarks: [Array.from({ length: 21 }, (_, i) => ({ x: i * 0.01, y: i * 0.02, z: 0 }))],
    handednesses: [[{ categoryName: 'Left', score: 0.9 }]],
  }, 1000, 1000);
  check('toHands 含 orient', !!res[0].orient);
  check('toHands 含 spread', Number.isFinite(res[0].spread));
}

// —— 21. 回归：代码审查发现 ——
console.log('\n[21] 回归（审查修复）');
{
  // 21.1 叉腰：肘被遮挡时不能因为"测不出"就否定真叉腰
  const mk = (elbow, vis) => [
    [100, 50, 1],
    [90, 100, 1], [110, 100, 1],
    [elbow[0], elbow[1], vis], [140, 165, 1],
    [95, 215, 1], [105, 215, 1],
    [92, 220, 1], [108, 220, 1],
    [90, 300, 1], [110, 300, 1],
    [88, 380, 1], [112, 380, 1],
  ];
  const hipsVisible = new SignalEngine().update(person(mk([60, 165], 1)), 1000);
  check('真叉腰（肘可见）→ on_hips', hipsVisible.armPose.on_hips === true);
  // 左肘被遮挡且坐标漂到中线：不能因此判成"不是叉腰"
  const hipsOccluded = new SignalEngine().update(person(mk([95, 180], 0.1)), 1000);
  check('真叉腰但肘被遮挡 → 仍判叉腰（不因测不出而否定）',
    hipsOccluded.armPose.on_hips === true);

  // 21.2 举手/挥手一致性：挥手必须蕴含举手（同一套 2D/3D 选择）
  const mkSig = (o = {}) => ({
    ok: true, knee_pick: 170, elbow_pick: 170, uprightness: 0.95, leg_vertical: 1.3,
    arm: {
      any_raised: true, any_raised3d: false, raised_L: true, raised_R: true,
      raised3d_L: false, raised3d_R: false, head_near_L: false, head_near_R: false,
    },
    armPose: {
      elev_L: 170, elev_R: 170, elev_torso_L: 95, elev_torso_R: 95,
      reach_L: 0.6, reach_R: 0.6, hands_close: 2.0,
      crossed: false, on_hips: false, open_wide: false, chest_height: false, has_world: true,
    },
    wave: { L: 4, R: 0, amp: 0.6 },
    ...o,
  });
  const ae = new ActionEngine();
  let t = 0; let r = null;
  for (let i = 0; i < 8; i++) r = ae.update(mkSig(), t += 100);
  check('3D 未举手 + 2D 举手 → armRaised=false（以 3D 为准）', r.flags.armRaised === false);
  check('挥手也以 3D 为准 → waving=false（不再出现挥手不举手）', r.flags.waving === false);

  // 3D 也举手时，挥手正常成立
  const ae2 = new ActionEngine();
  let t2 = 0; let r2 = null;
  for (let i = 0; i < 8; i++) {
    r2 = ae2.update(mkSig({
      arm: {
        any_raised: true, any_raised3d: true, raised_L: true, raised_R: true,
        raised3d_L: true, raised3d_R: true, head_near_L: false, head_near_R: false,
      },
      armPose: { ...mkSig().armPose, elev_torso_L: 10, elev_torso_R: 10 },
    }), t2 += 100);
  }
  check('3D 举手 + 挥手 → 两者都成立', r2.flags.armRaised === true && r2.flags.waving === true);

  // 21.3 手势去抖：unknown 必须中断 streak
  const st = new HandShapeStabilizer({ streak: 3, keepMs: 1000 });
  st.update('open', 0); st.update('open', 100); st.update('open', 200);
  st.update('victory', 300); st.update('victory', 400);
  st.update('unknown', 500);
  check('unknown 中断候选计数（非连续命中不切换）', st.update('victory', 600) === 'open');

  // keepMs 内 unknown 保持原手势，超过则清空
  const st2 = new HandShapeStabilizer({ streak: 3, keepMs: 250 });
  st2.update('fist', 0); st2.update('fist', 100); st2.update('fist', 200);
  check('keepMs 内 unknown 保持上一手势', st2.update('unknown', 400) === 'fist');
  check('超 keepMs 的 unknown 清空', st2.update('unknown', 600) === 'unknown');

  // 21.4 visMin 参数真的影响滤波门控
  const lowVis = new SignalEngine({ signals: { visMin: 0.95 } });
  const s = lowVis.update(person(withVis0(standKp, 0.5)), 1000);
  check('visMin 提高后低可见点被当作不可见', Number.isNaN(s.leg_vertical) || Number.isNaN(s.uprightness),
    `leg=${s.leg_vertical} up=${s.uprightness}`);
}

function withVis0(kp, v) {
  return kp.map((p) => [p[0], p[1], v]);
}

// —— 22. 拿取 / 伸手 / 持物 / 指向 ——
console.log('\n[22] 拿取与手臂扩展');
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
      chest_height: false, has_world: false,
      extend_L: true, extend_R: false, azimuth_L: 0, azimuth_R: 170,
      arm_front_L: true, arm_front_R: false, arm_side_L: false, arm_side_R: false,
    },
    wave: { L: 0, R: 0, amp: 0 },
    ...o,
  });
  const hands = (l, r) => ({ L: l, R: r });

  // 伸手：臂伸出 + 手张开
  const ae = new ActionEngine();
  let t = 0; let r;
  for (let i = 0; i < 5; i++) r = ae.update(mkSig(), t += 100, hands('open', null));
  check('臂伸出 + 手张开 → 伸手', r.flags.reaching === true);

  // 握着拳时不叫「伸手」（那是持物/拿取）
  const ae2 = new ActionEngine();
  let t2 = 0; let r2;
  for (let i = 0; i < 5; i++) r2 = ae2.update(mkSig(), t2 += 100, hands('fist', null));
  check('臂伸出但握拳 → 不算伸手', r2.flags.reaching === false);
  check('臂伸出但握拳 → 不算持物（臂伸太远）', r2.flags.carrying === false);

  // 持物：手闭合 + 臂没伸出
  const ae3 = new ActionEngine();
  let t3 = 0; let r3;
  const carried = mkSig({
    armPose: {
      ...mkSig().armPose,
      reach_L: 0.9, extend_L: false, elev_L: 160,
      arm_front_L: false, arm_side_L: false,
    },
  });
  for (let i = 0; i < 6; i++) r3 = ae3.update(carried, t3 += 100, hands('fist', null));
  check('手闭合 + 臂未伸出 → 持物', r3.flags.carrying === true);

  // 指向：臂伸出 + 朝向水平
  const ae4 = new ActionEngine();
  let t4 = 0; let r4;
  for (let i = 0; i < 6; i++) r4 = ae4.update(mkSig(), t4 += 100, hands('pointing', null));
  check('臂伸出 + 指示手势 → 指向', r4.flags.pointing === true);

  // 拿取 = 伸手 → 合手，两次条件都成立才计 1
  const ae5 = new ActionEngine();
  let t5 = 0; let r5;
  for (let i = 0; i < 6; i++) r5 = ae5.update(mkSig(), t5 += 100, hands('open', null));   // 伸手
  for (let i = 0; i < 6; i++) r5 = ae5.update(mkSig(), t5 += 100, hands('fist', null));   // 合手
  check('伸手 → 合手 → 计 1 次拿取', r5.reps.grasp === 1, `grasp=${r5.reps.grasp}`);
  check('拿取相位回到起点', r5.repPhase.grasp === 'reach' || r5.repPhase.grasp === 'grasp'
    || r5.repPhase.grasp === 'idle', `phase=${r5.repPhase.grasp}`);

  // 直接合手（没有先伸手）不算拿取
  const ae6 = new ActionEngine();
  let t6 = 0; let r6;
  for (let i = 0; i < 10; i++) r6 = ae6.update(mkSig(), t6 += 100, hands('fist', null));
  check('没有先伸手就合手 → 不计拿取', r6.reps.grasp === 0, `grasp=${r6.reps.grasp}`);

  // 伸手后超时没合手 → 状态机复位，之后合手也不计
  const ae7 = new ActionEngine();
  let t7 = 0; let r7;
  for (let i = 0; i < 5; i++) r7 = ae7.update(mkSig(), t7 += 100, hands('open', null));
  t7 += 3000;   // 超过 reachToGraspMs
  for (let i = 0; i < 5; i++) r7 = ae7.update(mkSig(), t7 += 100, hands('fist', null));
  check('伸手后超时再合手 → 不计拿取', r7.reps.grasp === 0, `grasp=${r7.reps.grasp}`);

  // 手部未检出时，所有依赖手的动作都不成立（不能把"没检出"当"手是空的"）
  const ae8 = new ActionEngine();
  let t8 = 0; let r8;
  for (let i = 0; i < 8; i++) r8 = ae8.update(mkSig(), t8 += 100, null);
  check('无手部数据 → 不判伸手', r8.flags.reaching === false);
  check('无手部数据 → 不判持物', r8.flags.carrying === false);
  check('无手部数据 → 不判拿取', r8.reps.grasp === 0);

  // 前平举 / 侧平举
  const frontSig = mkSig({
    armPose: { ...mkSig().armPose, arm_front_L: true, arm_side_L: false },
  });
  const ae9 = new ActionEngine();
  let t9 = 0; let r9;
  for (let i = 0; i < 3; i++) r9 = ae9.update(frontSig, t9 += 100, hands('open', null));
  check('方位角在正前方 → 前平举', r9.flags.armFront === true);
  check('方位角在正前方 → 不是侧平举', r9.flags.armSide === false);
}

// —— 23. PhaseSequence 原语（拿取状态机的地基）——
console.log('\n[23] PhaseSequence');
{
  const seq = new PhaseSequence(['reach', 'grasp'], { minPhaseMs: 100, maxPhaseMs: 1000, completeAt: 'grasp' });
  check('初始在阶段 0', seq.phase === 'reach');
  seq.update('reach', 0);
  check('阶段内不前进', seq.phase === 'reach' && seq.count === 0);
  const a = seq.update('grasp', 50);
  check('未满 minPhaseMs 不前进', a.phase === 'reach', `phase=${a.phase}`);
  const b = seq.update('grasp', 200);
  check('满 minPhaseMs 且进入终态 → 完成一次', b.count === 1 && b.completed === true, `count=${b.count}`);
  check('完成后回到第一阶段', b.phase === 'reach');

  // 超时复位：一直停在 reach 不动，超过 maxPhaseMs 后要能被新一轮识别
  const seq2 = new PhaseSequence(['reach', 'grasp'], { minPhaseMs: 100, maxPhaseMs: 500, completeAt: 'grasp' });
  seq2.update('reach', 0);
  seq2.update('reach', 600);      // 超时
  const c = seq2.update('grasp', 800);
  check('超时复位后重新伸手→合手仍能完成', c.phase === 'reach', `phase=${c.phase}`);

  // 乱序不前进
  const seq3 = new PhaseSequence(['reach', 'grasp'], { minPhaseMs: 0, maxPhaseMs: 2000, completeAt: 'grasp' });
  seq3.update('reach', 0);
  const d = seq3.update(null, 100);
  check('观察到 null 不前进', d.count === 0);
}

// —— 24. 前平举 / 侧平举：方位角必须配「手臂接近水平」——
console.log('\n[24] 平举方位');
{
  const kp = [
    [100, 50, 1],
    [90, 100, 1], [110, 100, 1],
    [85, 150, 1], [115, 150, 1],
    [80, 200, 1], [120, 200, 1],
    [92, 220, 1], [108, 220, 1],
    [90, 300, 1], [110, 300, 1],
    [88, 380, 1], [112, 380, 1],
  ];
  const mkWorld = (wristL, wristR) => {
    const w = new Array(33).fill(null).map(() => [0, 0, 0]);
    w[23] = [-0.1, 0, 0]; w[24] = [0.1, 0, 0];
    w[11] = [-0.16, -0.48, 0]; w[12] = [0.16, -0.48, 0];
    w[0] = [0, -0.62, 0];
    w[13] = [-0.25, -0.4, 0]; w[15] = wristL;
    w[14] = [0.25, -0.4, 0]; w[16] = wristR;
    return w;
  };
  const person2 = (world) => ({ kp, kp_world: world, kp_raw: [], bbox: [0, 0, 1, 1], scale: 120, score: 0.92 });

  // 自然下垂：腕在肩正下方 → 水平分量≈0，方位角无意义
  const hang = new SignalEngine().update(person2(mkWorld([-0.16, 0.0, 0], [0.16, 0.0, 0])), 1000);
  check('自然下垂 → 不算前平举', hang.armPose.arm_front_L === false,
    `elev_torso=${hang.armPose.elev_torso_L?.toFixed(0)}`);
  check('自然下垂 → 不算侧平举', hang.armPose.arm_side_L === false);

  // 侧平举：臂水平、朝正侧方（x 方向外展）
  const side = new SignalEngine().update(person2(mkWorld([-0.62, -0.48, 0], [0.62, -0.48, 0])), 1000);
  check('水平侧展 → 侧平举', side.armPose.arm_side_L === true,
    `azim=${side.armPose.azimuth_L?.toFixed(0)} elev=${side.armPose.elev_torso_L?.toFixed(0)}`);
  check('水平侧展 → 不是前平举', side.armPose.arm_front_L === false);

  // 前平举：臂水平、朝正前方（z 负方向）
  const front = new SignalEngine().update(person2(mkWorld([-0.16, -0.48, -0.5], [0.16, -0.8, -0.5])), 1000);
  check('水平前伸 → 前平举', front.armPose.arm_front_L === true,
    `azim=${front.armPose.azimuth_L?.toFixed(0)} elev=${front.armPose.elev_torso_L?.toFixed(0)}`);
}

// —— 22. R3：3D 信号（角度 / 直立度 / 腿竖直 / 比值）与 2D 退回 ——
console.log('\n[22] R3 3D 信号');
{
  // world 站姿（米制，y 向下为正）：
  // 髋 y=0、肩 y=-0.48、膝 y=0.45、踝 y=0.86
  const mkWorld = (over = {}) => {
    const w = new Array(33).fill(null).map(() => [0, 0, 0]);
    const set = (i, x, y, z) => { w[i] = [x, y, z]; };
    set(23, -0.10, 0, 0); set(24, 0.10, 0, 0);
    set(11, -0.18, -0.48, 0); set(12, 0.18, -0.48, 0);
    set(0, 0, -0.62, 0);
    set(13, -0.20, -0.05, 0); set(15, -0.20, 0.35, 0);
    set(14, 0.20, -0.05, 0); set(16, 0.20, 0.35, 0);
    set(25, -0.10, 0.45, 0); set(27, -0.10, 0.86, 0);
    set(26, 0.10, 0.45, 0); set(28, 0.10, 0.86, 0);
    for (const [k, v] of Object.entries(over)) set(Number(k), v[0], v[1], v[2]);
    return w;
  };
  // 2D 弯膝（膝角≈98°），world 里是伸直的（≈180°）——两者必须能区分
  const bendKp = standKp.map((p) => [...p]);
  bendKp[9] = [160, 300, 1];

  const seW = new SignalEngine();
  const sW = seW.update({ ...person(bendKp), kp_world: mkWorld() }, 1000);
  check('有 world → 膝角用 3D（≈180°）', near(sW.knee_pick, 180, 2), `knee=${sW.knee_pick?.toFixed(1)}`);
  check('2D 对照仍是弯膝（≈98°）', near(sW.knee_pick_2d, 98, 6), `2d=${sW.knee_pick_2d?.toFixed(1)}`);
  check('angle_source 标出用了 3d', sW.angle_source.knee_L === '3d', sW.angle_source.knee_L);
  check('sources 三份都导出', Number.isFinite(sW.knee_pick_3d) && Number.isFinite(sW.scale_world));

  const se2 = new SignalEngine();
  const s2 = se2.update(person(bendKp), 1000);
  check('无 world → 退回 2D', near(s2.knee_pick, 98, 6) && s2.angle_source.knee_L === '2d',
    `knee=${s2.knee_pick?.toFixed(1)} src=${s2.angle_source.knee_L}`);

  // 世界坐标里躯干水平（肩与髋同高、沿 z 前伸），2D 却是站姿 → 3D 应判 0
  const sLie = new SignalEngine().update({
    ...person(standKp),
    kp_world: mkWorld({ 11: [-0.18, 0, -0.48], 12: [0.18, 0, -0.48] }),
  }, 1000);
  check('躯干世界水平 → 直立度 0', near(sLie.uprightness, 0, 0.05), `up=${sLie.uprightness?.toFixed(3)}`);
  check('2D 对照仍是直立 ≈1', near(sLie.uprightness_2d, 1, 0.05));

  // leg_vertical：3D 量纲与 2D 不同，默认不切换，profile 可开
  const sLeg = new SignalEngine().update({ ...person(standKp), kp_world: mkWorld() }, 1000);
  check('默认 leg_vertical 仍用 2D', near(sLeg.leg_vertical, sLeg.leg_vertical_2d, 1e-6),
    `chosen=${sLeg.leg_vertical?.toFixed(2)} 2d=${sLeg.leg_vertical_2d?.toFixed(2)}`);
  check('3D 腿竖直比已导出（≈1.79）', near(sLeg.leg_vertical_3d, 1.79, 0.05), `${sLeg.leg_vertical_3d?.toFixed(2)}`);
  const sLegOn = new SignalEngine({ signals: { world: { legVertical: true } } })
    .update({ ...person(standKp), kp_world: mkWorld() }, 1000);
  check('profile 开 legVertical → 用 3D', near(sLegOn.leg_vertical, 1.79, 0.05),
    `${sLegOn.leg_vertical?.toFixed(2)}`);

  // 距离比值默认 2D，3D 版本并行导出（R4 用来决定是否切换）
  const sR = new SignalEngine().update({ ...person(standKp), kp_world: mkWorld() }, 1000);
  check('默认 reach 用 2D 比值', sR.armPose.reach_L === sR.armPose.reach_2d_L);
  check('3D 比值已导出', near(sR.armPose.reach_3d_L, 1.73, 0.1), `${sR.armPose.reach_3d_L?.toFixed(2)}`);

  // 开了 ratios 但没有 world：必须退回 2D，而不是全判 false/NaN
  const sNoW = new SignalEngine({ signals: { world: { ratios: true } } })
    .update(person(standKp), 1000);
  check('ratios=true 且无 world → 仍退回 2D', sNoW.armPose.reach_L === sNoW.armPose.reach_2d_L
    && Number.isFinite(sNoW.armPose.reach_L));
}

// —— 23. R3：骨骼长度一致性 ——
console.log('\n[23] 骨骼长度一致性');
{
  const mkWorld = (over = {}) => {
    const w = new Array(33).fill(null).map(() => [0, 0, 0]);
    const set = (i, x, y, z) => { w[i] = [x, y, z]; };
    set(23, -0.10, 0, 0); set(24, 0.10, 0, 0);
    set(11, -0.18, -0.48, 0); set(12, 0.18, -0.48, 0);
    set(0, 0, -0.62, 0);
    set(13, -0.20, -0.05, 0); set(15, -0.20, 0.35, 0);
    set(14, 0.20, -0.05, 0); set(16, 0.20, 0.35, 0);
    set(25, -0.10, 0.45, 0); set(27, -0.10, 0.86, 0);
    set(26, 0.10, 0.45, 0); set(28, 0.10, 0.86, 0);
    for (const [k, v] of Object.entries(over)) set(Number(k), v[0], v[1], v[2]);
    return w;
  };
  const se = new SignalEngine();
  let s = null;
  for (let i = 0; i < 12; i++) {
    s = se.update({ ...person(standKp), kp_world: mkWorld() }, 1000 + i * 33);
  }
  check('样本够 → 骨骼进入 armed', s.world.bone_armed.foreArm_L === true && s.world.bones.foreArm_L === true);

  // 左腕世界坐标漂到脚踝位置（visibility 仍是 1）→ 前臂长度偏离中位数 >20%
  s = se.update({ ...person(standKp), kp_world: mkWorld({ 15: [-0.2, 0.9, 0] }) }, 1400);
  check('腕点漂移 → 前臂不可靠', s.world.bones.foreArm_L === false);
  check('该侧肘角给 NaN（不退回 2D）', Number.isNaN(s.angles.elbow_L));
  check('该侧手臂信号给 NaN', Number.isNaN(s.armPose.elev_L) && Number.isNaN(s.armPose.reach_L));
  check('另一侧不受影响', Number.isFinite(s.angles.elbow_R) && Number.isFinite(s.armPose.reach_R));
}

// —— 24. R3：遮挡外推 / 角速度 / 自适应周期 ——
console.log('\n[24] 遮挡外推与周期');
{
  // 24.1 短时遮挡：常速度外推并标记，超过窗口退回保持
  const kf = new KpFilter({ minCutoff: 1, beta: 0.05 }, 0.3, 300);
  const at = (x, v) => {
    const k = standKp.map((p) => [...p]);
    k[5] = [x, 200, v];
    return k;
  };
  kf.run(at(80, 1), 0);
  kf.run(at(90, 1), 0.1);
  const last = kf.run(at(100, 1), 0.2);
  const ex = kf.run(at(100, 0), 0.3);
  check('短时遮挡 → 标记 extrapolated', ex.extrapolated.includes('wrist_L'));
  check('外推沿用最后速度方向', ex.kp[5][0] > last.kp[5][0],
    `${last.kp[5][0].toFixed(1)} → ${ex.kp[5][0].toFixed(1)}`);
  const stale = kf.run(at(100, 0), 0.7);   // 距最后好帧 500ms > 300ms
  check('超过 maxExtrapMs → 不再外推', !stale.extrapolated.includes('wrist_L'));

  // 24.2 角速度：膝角 180° → 98°，100ms 内，速度必须为负
  const se = new SignalEngine({ signals: { world: { enabled: false } } });
  const bend = standKp.map((p) => [...p]);
  bend[9] = [160, 300, 1];
  se.update(person(standKp), 0);
  const sv = se.update(person(bend), 100);
  check('膝角速度符号为负', sv.knee_vel < 0, `${sv.knee_vel?.toFixed(0)} deg/s`);
  check('速度量级合理（>50°/s）', Math.abs(sv.knee_vel) > 50);

  // 24.3 自适应周期
  const rc = new RepCounter({
    down: 100, up: 150, minCycleMs: 600, minHalfMs: 120,
    adaptiveMs: true, adaptiveWindow: 5, adaptiveMinRatio: 0.5,
  });
  rc.update(90, 0); rc.update(170, 300);      // 冷启动门槛 600×0.5=300 → 计 1
  rc.update(90, 600); rc.update(170, 900);    // 计 2，历史 [300,300]
  rc.update(90, 1200); rc.update(170, 1450);  // 250ms ≥ max(120,150) → 计 3
  check('有历史后按中位数放行更快的半程', rc.count === 3, `count=${rc.count}, med=${rc.medianHalfMs}`);
  rc.update(90, 3000); rc.update(170, 3140);  // 140ms：≥120 但 <150 → 抖动
  check('比历史节奏明显过快 → 不计数', rc.count === 3, `count=${rc.count}`);

  const slow = new RepCounter({
    down: 100, up: 150, minCycleMs: 600, minHalfMs: 120,
    adaptiveMs: true, adaptiveWindow: 5, adaptiveMinRatio: 0.5,
  });
  slow.update(90, 0); slow.update(170, 1000);   // 历史 [1000]
  slow.update(90, 1500); slow.update(170, 1900); // 400ms < 1000×0.5
  check('比历史节奏快一倍以上 → 拒绝', slow.count === 1, `count=${slow.count}`);

  // 24.4 外推期间冻结计数（不是暂停相位，更不是 abort）
  const seSig = new SignalEngine();
  const base = seSig.update(person(standKp), 0);
  const mk = (knee, ext, t) => ({
    ...base, ts: t, knee_pick: knee, knee_side: 'L',
    leg_vertical: 1.5, uprightness: 0.9, extrapolated: ext,
  });
  const ae = new ActionEngine();
  ae.update(mk(90, [], 0), 0);
  const r1 = ae.update(mk(170, [], 1500), 1500);
  check('无外推 → 正常计 1', r1.reps.squat === 1, `squat=${r1.reps.squat}`);
  const ae2 = new ActionEngine();
  ae2.update(mk(90, [], 0), 0);
  const r2 = ae2.update(mk(170, ['ankle_L', 'knee_L', 'hip_L'], 1500), 1500);
  check('外推期间不计数', r2.reps.squat === 0 && r2.countBlocked.squat === true,
    `squat=${r2.reps.squat} blocked=${r2.countBlocked.squat}`);
}

// —— 25. 分布统计（R3 正/侧面重合度的口径）——
console.log('\n[25] 分布统计');
{
  check('quantile 线性插值', near(quantile([1, 2, 3, 4], 0.5), 2.5, 1e-9));
  check('quantile 空数组 → NaN', Number.isNaN(quantile([], 0.5)));
  check('同一分布重合度 = 1', near(overlapCoefficient([1, 2, 3], [1, 2, 3]), 1, 1e-9));
  check('完全分离分布重合度 ≈ 0', overlapCoefficient([0, 1], [100, 101]) < 0.2);
  const st = summarize([1, 2, 3, 4]);
  check('summarize n / 均值 / 分位', st.n === 4 && near(st.mean, 2.5, 1e-9) && near(st.p50, 2.5, 1e-9));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
