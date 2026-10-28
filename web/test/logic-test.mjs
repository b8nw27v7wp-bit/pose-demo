// logic-test.mjs — 信号层与动作层的确定性单测（不依赖浏览器、不依赖摄像头）
// 运行：node web/test/logic-test.mjs
//
// 说明：这里验证的是**判定逻辑**（角度、滤波、滞回、计数门控、姿态互斥、置信冻结），
// 用人工构造的骨架/信号序列，不代表真实场景精度。真实精度必须用实拍素材校准。

import { angleDeg, OneEuro, Hold, RepCounter, SignalEngine } from '../js/signals.js';
import { ActionEngine } from '../js/actions.js';
import { classifyHand } from '../js/handshape.js';
import { toHands } from '../js/handformat.js';

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

  const se4 = new SignalEngine();
  const hips = se4.update(person(base([95, 215, 1], [105, 215, 1])), 1000);
  check('两腕贴髋 → 叉腰', hips.armPose.on_hips === true);

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

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
