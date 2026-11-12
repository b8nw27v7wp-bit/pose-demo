// actions.js — 动作字典
// 每个动作 = 信号层原语（Hold / RepCounter）的组合。加动作只改这个文件（引擎侧改 YAML）。
// 阈值全部来自 params.js（可由 profile 覆盖），不在这里写常数（见 PLAN §12.3 B）。

import { Hold, RepCounter, PhaseSequence } from './signals.js';
import { resolveParams } from './params.js';

// 手臂动作的完整 flag 集合。冻结帧和正常帧都用同一份，避免新增字段时只补一处，
// 界面/导出在低置信帧里读到 undefined（曾经导致「置信不足时动作全灭」）。
const EMPTY_FLAGS = {
  armRaised: false, waving: false, crossed: false, onHips: false, armsOpen: false,
  bothHandsUp: false, handAtHead: false, reaching: false, carrying: false,
  pointing: false, armFront: false, armSide: false,
  // 左右手粒度：聚合 flag 保留，新增逐侧 flag 供界面/导出说明「是哪只手」
  armRaisedL: false, armRaisedR: false,
  wavingL: false, wavingR: false,
  reachingL: false, reachingR: false,
  pointingL: false, pointingR: false,
  handAtHeadL: false, handAtHeadR: false,
  carryingL: false, carryingR: false,
  operating: false, operatingL: false, operatingR: false,
  nearEquipment: false,
};

/**
 * 互斥的静态姿态。prio 大者优先；streak 要求连续命中帧数，避免姿态在两个标签间闪烁。
 * 判定条件从参数构造，所以改阈值不需要改这里的逻辑。
 */
export function buildPostures(actions) {
  const { posture } = actions;
  // 只保留「站 / 坐」两种静态姿态。
  // 躺卧、下蹲需要膝/踝同时可见且机位能拍到全身或地面，桌面摄像头与上半身构图下
  // 判不了（不是识别失败，是信息不足）。与其留着一个恒为 null 的档位，
  // 不如把姿态集合收敛到能在常见机位稳定判定的范围，见 README「初始版验证范围」。
  return [
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
    // —— 只有上半身时（桌面摄像头最常见的构图）——
    // 膝/踝不可见时站/坐没有证据，但肩+髋仍然能给出躯干朝向。
    // 这里输出的是**上半身**直立/前倾，不是站/坐：坐着但躯干挺直也会命中「上半身直立」。
    // 优先级低于站/坐：腿一旦可用，这两个就不参与竞争。界面必须写明「推断」。
    {
      id: 'upper_upright', name: '上半身直立', prio: 6,
      minMs: posture.upper.minMs, streak: posture.upper.streak,
      cond: (s) => s.upper_body && Number.isFinite(s.uprightness)
        && s.uprightness > posture.upper.uprightGt,
    },
    {
      id: 'upper_lean', name: '上半身前倾', prio: 5,
      minMs: posture.upper.minMs, streak: posture.upper.streak,
      cond: (s) => s.upper_body && Number.isFinite(s.uprightness)
        && s.uprightness <= posture.upper.uprightGt
        && s.uprightness > posture.upper.leanGt,
    },
  ];
}

export class ActionEngine {
  constructor(params = {}) {
    const cfg = resolveParams(params);
    this.cfg = cfg.actions;
    this.waveCfg = cfg.signals.wave;
    this.graspCfg = cfg.signals.grasp;
    this.closedShapes = new Set(cfg.signals.hand.closedShapes);
    this.openShapes = new Set(cfg.signals.hand.openShapes);
    this.pointShapes = new Set(cfg.signals.hand.pointShapes);
    this.carryCfg = cfg.signals.arm.carry;
    // 姿态只有站/坐；计数只剩鼓掌（深蹲/俯卧撑已下线，见 buildPostures 的说明）。
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
    this.reachHold = new Hold(this.cfg.holds.reach);
    this.carryHold = new Hold(this.cfg.holds.carry);
    this.pointHold = new Hold(this.cfg.holds.point);
    this.frontHold = new Hold(this.cfg.holds.front);
    this.sideHold = new Hold(this.cfg.holds.side);
    // 操作设备是持续事件：800ms 才成立，允许短暂遮挡（见 params.actions.holds.operating）
    this.operatingHold = new Hold(this.cfg.holds.operating, this.cfg.holds.operatingMaxGap);
    // 在设备旁是上下文事件：1s 才成立；和 operating 分开，不互相替代
    this.nearEquipmentHold = new Hold(this.cfg.holds.nearEquipment);
    // 拿取 = 伸手 → 合手 → 收回/抬起。手部状态由调用方逐帧传入（见 update 的 hands 参数）
    this.graspSeq = new PhaseSequence(['reach', 'grasp'], {
      minPhaseMs: this.graspCfg.minPhaseMs,
      maxPhaseMs: this.graspCfg.reachToGraspMs,
      completeAt: 'grasp',
    });
    this.graspCount = 0;
    this.graspPhase = 'idle';
    this.reps = {
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
    this.reachHold.reset();
    this.carryHold.reset();
    this.pointHold.reset();
    this.frontHold.reset();
    this.sideHold.reset();
    this.operatingHold.reset();
    this.nearEquipmentHold.reset();
    this.graspSeq.reset();
    this.graspCount = 0;
    this.graspPhase = 'idle';
    this.reps.clap.reset();
    this.postureSince = null;
    this.last = null;
  }

  /**
   * @param {object} s SignalEngine.update() 产出的信号
   * @param {number} ts 毫秒
   * @param {{L?:string|null, R?:string|null}} [hands] 每只手当前的稳定手势
   *   （fist/open/victory/pointing/thumbs_up/ok/gun/rock），缺失表示该手未检出。
   *   伸手/持物/指向按 signals.hand.openShapes/pointShapes/closedShapes 分组判定，
   *   判不出手型时宁可弃权，也不拿「非闭合」当「张开」。
   */
  update(s, ts, hands = null) {
    // 置信度不足：冻结状态，不推进计数，也不清空姿态（否则会闪）
    if (!s.ok) {
      const prev = this.last;
      return {
        posture: prev?.posture ?? null,
        postureId: prev?.postureId ?? null,
        postureMs: prev ? ts - (this.postureSince ?? ts) : 0,
        frozen: true,
        flags: prev?.flags ?? { ...EMPTY_FLAGS },
        reps: {
          clap: this.reps.clap.count,
          grasp: this.graspCount,
        },
        gates: prev?.gates ?? { clap: false },
        countBlocked: prev?.countBlocked ?? { clap: false },
        // 判定不可靠的原因：界面/导出据此提示「这一帧别太当真」
        unreliable: ['low_confidence', ...(s.extrapolated_any ? ['extrapolated'] : [])],
        repPhase: {
          clap: this.reps.clap.phase,
          grasp: this.graspPhase,
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
    // 「哪一档可用」由信号层逐侧决定（raised_sel_*）：本帧 3D 有效用 3D，
    // 3D 无效（无 world / 该侧世界点缺失）才退回 2D。只看 has_world 会在
    // 「world 在、某侧世界点坏掉」时把举手整个丢掉。
    const ap = s.armPose || {};
    const arm = s.arm || {};
    const waveCfg = this.waveCfg;
    const wv = s.wave || {};
    const sideRaised = (side) => {
      const sel = side === 'L' ? arm.raised_sel_L : arm.raised_sel_R;
      if (sel === true || sel === false) return sel;
      // 兼容手搓的信号对象（单测/旧导出）：没有逐侧字段时按旧的整体口径
      const from3d = side === 'L' ? arm.raised3d_L : arm.raised3d_R;
      const from2d = side === 'L' ? arm.raised_L : arm.raised_R;
      if (from3d === undefined && from2d === undefined) return !!arm.any_raised;
      return ap.has_world ? !!from3d : !!from2d;
    };
    const raisedL = sideRaised('L');
    const raisedR = sideRaised('R');
    const raisedNow = raisedL || raisedR;
    const armRaised = this.armHold.update(raisedNow, ts);
    // 挥手也走同一套举手判定：之前单独用 2D 的 any_raised，会导出
    // armRaised=false 而 waving=true ——「挥手必然蕴含举手」这条不变量不能破。
    // 翻转次数与幅度必须来自**同一条举起的臂**：只取两侧 max(amp) 时，
    // 「左手举着不动、右手在髋旁摆动」会凑成挥手。
    const ampOf = (side) => Number(side === 'L' ? wv.amp_L ?? wv.amp : wv.amp_R ?? wv.amp);
    const waveL = raisedL && (wv.L ?? 0) >= waveCfg.minFlips && ampOf('L') > waveCfg.minAmp;
    const waveR = raisedR && (wv.R ?? 0) >= waveCfg.minFlips && ampOf('R') > waveCfg.minAmp;
    const waving = this.waveHold.update(waveL || waveR, ts);

    // —— 手臂姿态（抱臂 / 叉腰 / 张开双臂 / 双手高举 / 手在头部附近）
    const crossed = this.crossedHold.update(!!ap.crossed, ts);
    const onHips = this.hipsHold.update(!!ap.on_hips, ts);
    const armsOpen = this.openHold.update(!!ap.open_wide, ts);
    // 双手高举：两边都举起，才算「欢呼/投降」式，和单臂举手区分开
    // （同一套逐侧选择，避免一侧 3D 无效就把双手高举整体判掉）
    const bothHandsUp = this.upHold.update(raisedL && raisedR, ts);
    // 手在头部附近：扶额/摸头/敬礼一类，动作本身不重要，重要的是「手不在躯干平面」
    const handAtHead = this.headHold.update(s.arm.head_near_L || s.arm.head_near_R, ts);

    // —— 伸手 / 指向 / 持物 / 拿取
    // 这些判定需要「手是张开还是握紧」，而姿态层只有腕的位置。
    // hands 由调用方逐帧传入（手部模型的结果），缺失时这些动作一律不成立——
    // 宁可漏判，也不要把「手没被检出」当成「手是空的」。
    // 手型按具体类别取，而不是只分「闭合/非闭合」：
    // 伸手=open，指向=pointing/gun，持物/拿取=fist/ok。判不出（unknown/侧对）就弃权。
    const shapeL = hands?.L ?? null;
    const shapeR = hands?.R ?? null;
    const closedL = !!hands && this.closedShapes.has(shapeL);
    const closedR = !!hands && this.closedShapes.has(shapeR);
    const openL = !!hands && this.openShapes.has(shapeL);
    const openR = !!hands && this.openShapes.has(shapeR);
    const pointL = !!hands && this.pointShapes.has(shapeL);
    const pointR = !!hands && this.pointShapes.has(shapeR);
    const anyClosed = closedL || closedR;
    const extendedL = !!ap.extend_L;
    const extendedR = !!ap.extend_R;

    // 手必须和**伸出的那条臂**对应：只看 anyOpen 时，
    // 「左臂伸出但手没检出，右手在身侧张开」会被误判成伸手。
    const reachOpenL = extendedL && openL;
    const reachOpenR = extendedR && openR;
    const reachOpen = reachOpenL || reachOpenR;
    const reachClosedL = extendedL && closedL;
    const reachClosedR = extendedR && closedR;
    const reachClosed = reachClosedL || reachClosedR;

    // 伸手：臂伸出且手判为张开（指向/握拳都不算，它们各有自己的动作）
    const reaching = this.reachHold.update(reachOpen, ts);
    // 持物：手闭合且臂没有明显伸出（端着/拿着东西的自然姿势）
    const carrying = this.carryHold.update(anyClosed
      && (ap.reach_L ?? 0) < this.carryCfg.maxReach
      && (ap.reach_R ?? 0) < this.carryCfg.maxReach, ts);
    // 指向：伸出那条臂的手**判为指方向/手枪**，且**同一条臂**朝正面/侧面。
    // 以前只看「手被检出 + 任一臂朝前/侧」：张开手掌也算指向，还会出现
    // 「左臂伸出、右手做侧平举」把指向凑出来。现在手型与左右侧都绑定。
    const pointArmL = extendedL && pointL && (ap.arm_front_L || ap.arm_side_L);
    const pointArmR = extendedR && pointR && (ap.arm_front_R || ap.arm_side_R);
    const pointing = this.pointHold.update(pointArmL || pointArmR, ts);

    // 前/侧平举：信号层是瞬时布尔，这里补一个保持窗。
    // 走路摆臂时 3D 方位角的噪声会断续命中，实测最长一段只有 250ms；
    // 不加保持窗，界面会一直闪「前平举」。
    const armFront = this.frontHold.update(!!(ap.arm_front_L || ap.arm_front_R), ts);
    const armSide = this.sideHold.update(!!(ap.arm_side_L || ap.arm_side_R), ts);
    // 操作设备（阀门/仪表）：手在设备区域/明显前伸，保持 800ms 才算「在做」
    const operating = this.operatingHold.update(!!(s.arm?.operating_any), ts);
    // 在设备旁：人体框与 ROI 重叠，保持 1s；它不要求手在设备上
    const nearEquipment = this.nearEquipmentHold.update(!!(s.arm?.near_equipment), ts);

    // 拿取状态机：reach（伸手且手张开）→ grasp（手合上）。两次都成立才算一次拿取。
    // 仍按「伸出的那条臂」取手的状态，避免另一只手的开合推进阶段机。
    const observed = reachOpen ? 'reach'
      : (reachClosed ? 'grasp' : null);
    const step = this.graspSeq.update(observed, ts);
    this.graspPhase = step.phase;
    this.graspCount = step.count;

    // —— 计数类（只剩鼓掌；深蹲/俯卧撑计数已随姿态一起下线）
    // 短时遮挡外推期间冻结计数：外推坐标是猜的，拿来数必然出错。
    const ext = new Set(s.extrapolated || []);
    const clapBlocked = ext.has('wrist_L') || ext.has('wrist_R');

    // 鼓掌：两腕距离的周期，且必须在胸前高度、且不是抱臂（抱臂时两腕也很近，会误入低值）
    const clapGate = !!ap.chest_height && !ap.crossed;
    const clapCount = clapBlocked ? this.reps.clap.count
      : clapGate ? this.reps.clap.update(ap.hands_close, ts) : (this.reps.clap.abort(), this.reps.clap.count);

    const out = {
      posture: posture ? posture.name : null,
      postureId: posture ? posture.id : null,
      postureMs: posture ? ts - this.postureSince : 0,
      frozen: false,
      flags: {
        armRaised, waving, crossed, onHips, armsOpen, bothHandsUp, handAtHead,
        reaching, carrying, pointing, armFront, armSide,
        // 逐侧粒度：界面用它说「左手举手」，导出也能按手拆准确率
        armRaisedL: armRaised && raisedL,
        armRaisedR: armRaised && raisedR,
        wavingL: waving && waveL,
        wavingR: waving && waveR,
        reachingL: reaching && reachOpenL,
        reachingR: reaching && reachOpenR,
        pointingL: pointing && pointArmL,
        pointingR: pointing && pointArmR,
        handAtHeadL: handAtHead && !!s.arm.head_near_L,
        handAtHeadR: handAtHead && !!s.arm.head_near_R,
        carryingL: carrying && closedL,
        carryingR: carrying && closedR,
        operating,
        operatingL: operating && !!s.arm?.operating_L,
        operatingR: operating && !!s.arm?.operating_R,
        nearEquipment,
      },
      reps: { clap: clapCount, grasp: this.graspCount },
      gates: { clap: clapGate },
      countBlocked: { clap: clapBlocked },
      // 判定不可靠的原因：界面/导出据此提示「这一帧别太当真」
      unreliable: [
        ...(s.extrapolated_any ? ['extrapolated'] : []),
        ...(s.world?.bones && Object.values(s.world.bones).some((v) => v === false)
          ? ['bone_blocked'] : []),
        ...(s.angle_outliers?.length ? ['angle_outlier'] : []),
      ],
      repPhase: {
        clap: this.reps.clap.phase,
        grasp: this.graspPhase,
      },
    };
    this.last = out;
    return out;
  }
}

// —— 动作注册表（唯一来源）——————————————————————————————————————————
// 页面、评估器、自动标注、清单校验、难例导出都从这里派生，不许各自再抄一份。
// 之前 evaluate/app/autolabel/manifest/hardcase 各抄了一份动作列表，
// 结果 §12.7 新增的 5 个手臂动作和 grasp 在 3 个工具里被漏掉（评估/采集/难例都看不到它们）。
// 新增动作：在 ARM_ACTIONS 里加一条（含 flag）或在 REP_ACTIONS 里加一条，其余自动生效。
export const ACTION_CATALOG = [
  { id: 'stand', name: '站立', kind: '姿态' },
  { id: 'sit', name: '坐', kind: '姿态' },
  // 上半身构图专用：膝/踝不可见时只凭肩+髋判躯干朝向，不是站/坐的替代（见 buildPostures）
  { id: 'upper_upright', name: '上半身直立', kind: '姿态' },
  { id: 'upper_lean', name: '上半身前倾', kind: '姿态' },
];
export const POSTURE_IDS = ACTION_CATALOG.map((a) => a.id);

// flag = ActionEngine.update() 输出里的布尔字段名；labels/评估器用这个键。
// hidden：引擎仍判定、导出/历史评估仍可用，但动作面板不显示（演示动作）。
// retired：已下线——界面与新标注都不再出现，只保留给历史数据评估（删掉会让旧 label
//          变成 unknown）。不要把 retired 条目放进任何「新增标注」的下拉里。
// context：不是手臂动作，是上下文事件；面板单独一行显示，不混进动作网格。
export const ARM_ACTIONS = [
  { id: 'operating', name: '操作设备', flag: 'operating' },
  { id: 'reach', name: '伸手', flag: 'reaching' },
  { id: 'carry', name: '持物', flag: 'carrying' },
  { id: 'point', name: '指向', flag: 'pointing' },
  { id: 'arm_raised', name: '举手', flag: 'armRaised' },
  // 上下文事件：说明「人在设备旁」，不说明手在设备上
  { id: 'near_equipment', name: '在设备旁', flag: 'nearEquipment', context: true },
  // 不在面板显示，但仍可评估/标注
  { id: 'arms_open', name: '张开双臂', flag: 'armsOpen', hidden: true },
  { id: 'both_up', name: '双手高举', flag: 'bothHandsUp', hidden: true },
  { id: 'hand_head', name: '手在头部', flag: 'handAtHead', hidden: true },
  // 已下线：仅保留给历史数据
  { id: 'wave', name: '挥手', flag: 'waving', retired: true },
  { id: 'crossed', name: '抱臂', flag: 'crossed', retired: true },
  { id: 'hips', name: '叉腰', flag: 'onHips', retired: true },
  { id: 'arm_front', name: '前平举', flag: 'armFront', retired: true },
  { id: 'arm_side', name: '侧平举', flag: 'armSide', retired: true },
];
// 动作面板网格显示哪些；准确率列表比网格多一个「在设备旁」（上下文事件也要看准确率）
export const ARM_UI_ACTIONS = ARM_ACTIONS
  .filter((a) => !a.context && !a.hidden && !a.retired);
export const ARM_CONTEXT_ACTIONS = ARM_ACTIONS.filter((a) => a.context);
export const ARM_VISIBLE_ACTIONS = ARM_ACTIONS.filter((a) => !a.hidden && !a.retired);
// 新增标注（难例下拉、自动标注草稿）可选的集合：不含 retired
export const ARM_LABEL_ACTIONS = ARM_ACTIONS.filter((a) => !a.retired);
export const ARM_FLAG_IDS = ARM_ACTIONS.map((a) => a.flag);
export const ARM_ID_TO_FLAG = Object.fromEntries(ARM_ACTIONS.map((a) => [a.id, a.flag]));

// 计数类：RepCounter（或 PhaseSequence）维护计数，labels 用 id + count。
export const REP_ACTIONS = [
  { id: 'grasp', name: '拿取' },
  // 鼓掌计数已下线：界面不再显示，历史 label 仍可评估
  { id: 'clap', name: '鼓掌', retired: true },
];
export const REP_UI_ACTIONS = REP_ACTIONS.filter((r) => !r.retired);
export const REP_IDS = REP_ACTIONS.map((r) => r.id);
