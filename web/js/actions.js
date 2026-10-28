// actions.js — 动作字典
// 每个动作 = 信号层原语（Hold / RepCounter）的组合。加动作只改这个文件（引擎侧改 YAML）。
// 阈值全部来自 params.js（可由 profile 覆盖），不在这里写常数（见 PLAN §12.3 B）。

import { Hold, RepCounter } from './signals.js';
import { resolveParams } from './params.js';

/**
 * 互斥的静态姿态。prio 大者优先；streak 要求连续命中帧数，避免姿态在两个标签间闪烁。
 * 判定条件从参数构造，所以改阈值不需要改这里的逻辑。
 */
export function buildPostures(actions) {
  const { posture } = actions;
  return [
    {
      id: 'lying', name: '躺卧', prio: 40,
      minMs: posture.lying.minMs, streak: posture.lying.streak,
      cond: (s) => s.uprightness < posture.lying.uprightnessLt
        && s.leg_vertical < posture.lying.legVerticalLt,
    },
    {
      id: 'squat_static', name: '下蹲', prio: 30,
      minMs: posture.squat.minMs, streak: posture.squat.streak,
      cond: (s) => s.knee_pick < posture.squat.kneeLt
        && s.uprightness > posture.squat.uprightnessGt,
    },
    {
      id: 'sit', name: '坐', prio: 20,
      minMs: posture.sit.minMs, streak: posture.sit.streak,
      cond: (s) => s.knee_pick > posture.sit.kneeGt
        && s.knee_pick < posture.sit.kneeLt
        && s.uprightness > posture.sit.uprightnessGt
        && s.leg_vertical < posture.sit.legVerticalLt,
    },
    {
      id: 'stand', name: '站立', prio: 10,
      minMs: posture.stand.minMs, streak: posture.stand.streak,
      cond: (s) => s.uprightness > posture.stand.uprightnessGt
        && s.knee_pick > posture.stand.kneeGt
        && s.leg_vertical > posture.stand.legVerticalGt,
    },
  ];
}

export class ActionEngine {
  constructor(params = {}) {
    const cfg = resolveParams(params);
    this.cfg = cfg.actions;
    this.waveCfg = cfg.signals.wave;
    // 深蹲门控：躯干仍接近竖直 + 踝明显在髋下方。
    // 少了这个门，从站到坐的过程中膝角也会穿过 100°，一次坐下会被记成一次深蹲。
    // 俯卧撑门控：身体接近水平，否则站着弯一下手臂也会被数。
    this.postures = buildPostures(this.cfg);
    this.postureHolds = new Map(this.postures.map((p) => [p.id, new Hold(p.minMs)]));
    this.streaks = new Map(this.postures.map((p) => [p.id, 0]));
    this.armHold = new Hold(this.cfg.holds.arm);
    this.waveHold = new Hold(this.cfg.holds.wave);
    this.crossedHold = new Hold(this.cfg.holds.crossed);
    this.hipsHold = new Hold(this.cfg.holds.hips);
    this.openHold = new Hold(this.cfg.holds.open);
    this.upHold = new Hold(this.cfg.holds.bothHandsUp);
    this.headHold = new Hold(this.cfg.holds.handFace);
    this.reps = {
      squat: new RepCounter(this.cfg.reps.squat),
      pushup: new RepCounter(this.cfg.reps.pushup),
      clap: new RepCounter(this.cfg.reps.clap),
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
    this.upHold.reset();
    this.headHold.reset();
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
          bothHandsUp: false, handAtHead: false,
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
    for (const p of this.postures) {
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
    // 举手优先用 3D（相对躯干）判定：俯拍时 2D 抬臂角会把「前伸」误当「举起」。
    // has_world 为假时退回 2D，行为与之前一致。
    const ap = s.armPose || {};
    const waveCfg = this.waveCfg;
    const raisedNow = ap.has_world ? s.arm.any_raised3d : s.arm.any_raised;
    const armRaised = this.armHold.update(raisedNow, ts);
    // 挥手也走同一套举手判定：之前单独用 2D 的 any_raised，会导出
    // armRaised=false 而 waving=true ——「挥手必然蕴含举手」这条不变量不能破。
    const waving = this.waveHold.update(
      raisedNow && (s.wave.L >= waveCfg.minFlips || s.wave.R >= waveCfg.minFlips)
        && s.wave.amp > waveCfg.minAmp,
      ts,
    );

    // —— 手臂姿态（抱臂 / 叉腰 / 张开双臂 / 双手高举 / 手在头部附近）
    const crossed = this.crossedHold.update(!!ap.crossed, ts);
    const onHips = this.hipsHold.update(!!ap.on_hips, ts);
    const armsOpen = this.openHold.update(!!ap.open_wide, ts);
    // 双手高举：两边都举起，才算「欢呼/投降」式，和单臂举手区分开
    const bothRaisedNow = ap.has_world
      ? (s.arm.raised3d_L && s.arm.raised3d_R)
      : (s.arm.raised_L && s.arm.raised_R);
    const bothHandsUp = this.upHold.update(bothRaisedNow, ts);
    // 手在头部附近：扶额/摸头/敬礼一类，动作本身不重要，重要的是「手不在躯干平面」
    const handAtHead = this.headHold.update(s.arm.head_near_L || s.arm.head_near_R, ts);

    // —— 计数类
    const squatGate = s.leg_vertical > this.cfg.gates.squat.legVerticalGt
      && s.uprightness > this.cfg.gates.squat.uprightnessGt;
    const squatCount = squatGate ? this.reps.squat.update(s.knee_pick, ts) : (this.reps.squat.abort(), this.reps.squat.count);

    const pushupGate = s.uprightness < this.cfg.gates.pushup.uprightnessLt;
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
      flags: {
        armRaised, waving, crossed, onHips, armsOpen, bothHandsUp, handAtHead,
      },
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
  { id: 'both_up', name: '双手高举' },
  { id: 'wave', name: '挥手' },
  { id: 'crossed', name: '抱臂' },
  { id: 'hips', name: '叉腰' },
  { id: 'arms_open', name: '张开双臂' },
  { id: 'hand_head', name: '手在头部' },
];
