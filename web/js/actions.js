// actions.js — 动作字典
// 每个动作 = 信号层原语（Hold / RepCounter）的组合。加动作只改这个文件（引擎侧改 YAML）。
// 阈值是"量级参考"，必须用自己的校准数据替换（见 PLAN §6、docs/signals.md）。

import { Hold, RepCounter } from './signals.js';

// 互斥的静态姿态。prio 大者优先；streak 要求连续命中帧数，避免姿态在两个标签间闪烁。
const POSTURES = [
  {
    id: 'lying', name: '躺卧', prio: 40, minMs: 450, streak: 4,
    cond: (s) => s.uprightness < 0.45 && s.leg_vertical < 0.8,
  },
  {
    id: 'squat_static', name: '下蹲', prio: 30, minMs: 350, streak: 4,
    cond: (s) => s.knee_pick < 110 && s.uprightness > 0.45,
  },
  {
    id: 'sit', name: '坐', prio: 20, minMs: 450, streak: 5,
    cond: (s) => s.knee_pick > 55 && s.knee_pick < 135 && s.uprightness > 0.5 && s.leg_vertical < 1.05,
  },
  {
    id: 'stand', name: '站立', prio: 10, minMs: 350, streak: 4,
    cond: (s) => s.uprightness > 0.8 && s.knee_pick > 150 && s.leg_vertical > 0.8,
  },
];

// 深蹲门控：躯干仍接近竖直 + 踝明显在髋下方。
// 少了这个门，从站到坐的过程中膝角也会穿过 100°，一次坐下会被记成一次深蹲。
const SQUAT_GATE = (s) => s.leg_vertical > 0.85 && s.uprightness > 0.6;
// 俯卧撑门控：身体接近水平，否则站着弯一下手臂也会被数。
const PUSHUP_GATE = (s) => s.uprightness < 0.6;

export class ActionEngine {
  constructor() {
    this.postureHolds = new Map(POSTURES.map((p) => [p.id, new Hold(p.minMs)]));
    this.streaks = new Map(POSTURES.map((p) => [p.id, 0]));
    this.armHold = new Hold(300);
    this.waveHold = new Hold(150);
    this.crossedHold = new Hold(400);
    this.hipsHold = new Hold(400);
    this.openHold = new Hold(400);
    this.reps = {
      squat: new RepCounter({ down: 100, up: 150, minCycleMs: 600 }),
      pushup: new RepCounter({ down: 90, up: 150, minCycleMs: 500 }),
      clap: new RepCounter({ down: 0.45, up: 1.0, minCycleMs: 400, minHalfMs: 100 }),
    };
    this.postureSince = null;
    this.last = null;
  }

  reset() {
    for (const h of this.postureHolds.values()) h.reset();
    for (const k of this.streaks.keys()) this.streaks.set(k, 0);
    this.armHold.reset();
    this.waveHold.reset();
    this.crossedHold.reset();
    this.hipsHold.reset();
    this.openHold.reset();
    this.reps.squat.reset();
    this.reps.pushup.reset();
    this.reps.clap.reset();
    this.postureSince = null;
    this.last = null;
  }

  /**
   * @param {object} s SignalEngine.update() 产出的信号
   * @param {number} ts 毫秒
   */
  update(s, ts) {
    // 置信度不足：冻结状态，不推进计数，也不清空姿态（否则会闪）
    if (!s.ok) {
      const prev = this.last;
      return {
        posture: prev?.posture ?? null,
        postureId: prev?.postureId ?? null,
        postureMs: prev ? ts - (this.postureSince ?? ts) : 0,
        frozen: true,
        flags: prev?.flags ?? {
          armRaised: false, waving: false, crossed: false, onHips: false, armsOpen: false,
        },
        reps: {
          squat: this.reps.squat.count,
          pushup: this.reps.pushup.count,
          clap: this.reps.clap.count,
        },
        gates: prev?.gates ?? { squat: false, pushup: false, clap: false },
        repPhase: {
          squat: this.reps.squat.phase,
          pushup: this.reps.pushup.phase,
          clap: this.reps.clap.phase,
        },
      };
    }

    // —— 静态姿态：连续命中 + 最短持续，然后按优先级取一个
    const candidates = [];
    for (const p of POSTURES) {
      const hit = p.cond(s);
      const streak = hit ? (this.streaks.get(p.id) || 0) + 1 : 0;
      this.streaks.set(p.id, streak);
      const held = this.postureHolds.get(p.id).update(hit, ts);
      if (held && streak >= p.streak) candidates.push(p);
    }
    candidates.sort((a, b) => b.prio - a.prio);
    const posture = candidates[0] || null;

    if (posture) {
      if (this.last?.postureId !== posture.id) this.postureSince = ts;
    } else {
      this.postureSince = null;
    }

    // —— 举手 / 挥手
    const armRaised = this.armHold.update(s.arm.any_raised, ts);
    const waving = this.waveHold.update(
      s.arm.any_raised && (s.wave.L >= 3 || s.wave.R >= 3) && s.wave.amp > 0.25,
      ts,
    );

    // —— 手臂姿态（抱臂 / 叉腰 / 张开双臂）
    const ap = s.armPose || {};
    const crossed = this.crossedHold.update(!!ap.crossed, ts);
    const onHips = this.hipsHold.update(!!ap.on_hips, ts);
    const armsOpen = this.openHold.update(!!ap.open_wide, ts);

    // —— 计数类
    const squatGate = SQUAT_GATE(s);
    const squatCount = squatGate ? this.reps.squat.update(s.knee_pick, ts) : (this.reps.squat.abort(), this.reps.squat.count);

    const pushupGate = PUSHUP_GATE(s);
    const pushupCount = pushupGate ? this.reps.pushup.update(s.elbow_pick, ts) : (this.reps.pushup.abort(), this.reps.pushup.count);

    // 鼓掌：两腕距离的周期，且必须在胸前高度、且不是抱臂（抱臂时两腕也很近，会误入低值）
    const clapGate = !!ap.chest_height && !ap.crossed;
    const clapCount = clapGate
      ? this.reps.clap.update(ap.hands_close, ts)
      : (this.reps.clap.abort(), this.reps.clap.count);

    const out = {
      posture: posture ? posture.name : null,
      postureId: posture ? posture.id : null,
      postureMs: posture ? ts - this.postureSince : 0,
      frozen: false,
      flags: { armRaised, waving, crossed, onHips, armsOpen },
      reps: { squat: squatCount, pushup: pushupCount, clap: clapCount },
      gates: { squat: squatGate, pushup: pushupGate, clap: clapGate },
      repPhase: {
        squat: this.reps.squat.phase,
        pushup: this.reps.pushup.phase,
        clap: this.reps.clap.phase,
      },
    };
    this.last = out;
    return out;
  }
}

export const ACTION_CATALOG = [
  { id: 'stand', name: '站立', kind: '姿态' },
  { id: 'sit', name: '坐', kind: '姿态' },
  { id: 'squat_static', name: '下蹲', kind: '姿态' },
  { id: 'lying', name: '躺卧', kind: '姿态' },
];

export const ARM_ACTIONS = [
  { id: 'arm_raised', name: '举手' },
  { id: 'wave', name: '挥手' },
  { id: 'crossed', name: '抱臂' },
  { id: 'hips', name: '叉腰' },
  { id: 'arms_open', name: '张开双臂' },
];
