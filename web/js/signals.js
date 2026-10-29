// signals.js — L2 信号层
// 职责：把坐标变成**时间序列信号**（角度、比值、振荡），并做平滑与去抖。
// 这一层是"通用"的关键：动作判定只认这里的信号，不直接碰关键点。
// 定义与阈值说明见 docs/signals.md（那份文档是唯一真相）。

import { KPT, IDX, MP_INDEX } from './kpt.js';
import { resolveParams } from './params.js';

/** One Euro 滤波器：静止时不抖、快速动作不拖尾。 */
export class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.05, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, tSec) {
    if (!Number.isFinite(x)) return this.xPrev ?? NaN;
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x; this.tPrev = tSec; this.dxPrev = 0;
      return x;
    }
    const dt = Math.max(tSec - this.tPrev, 1e-3);
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuro.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuro.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;

    this.xPrev = xHat; this.dxPrev = dxHat; this.tPrev = tSec;
    return xHat;
  }

  reset() { this.xPrev = null; this.tPrev = null; this.dxPrev = 0; }
}

/** 三点夹角（度），b 为顶点。返回 NaN 表示不可用。 */
export function angleDeg(a, b, c) {
  if (!a || !b || !c) return NaN;
  const v1x = a[0] - b[0], v1y = a[1] - b[1];
  const v2x = c[0] - b[0], v2y = c[1] - b[1];
  const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-6 || n2 < 1e-6) return NaN;
  let cos = (v1x * v2x + v1y * v2y) / (n1 * n2);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** 三维两点夹角（度），用于 worldLandmarks。 */
export function angleDeg3(a, b, c) {
  if (!a || !b || !c) return NaN;
  const v1 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const v2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const n1 = Math.hypot(...v1), n2 = Math.hypot(...v2);
  if (n1 < 1e-9 || n2 < 1e-9) return NaN;
  let cos = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (n1 * n2);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** 带最短持续时间的状态判定（信号层原语 state）。 */
export class Hold {
  constructor(minMs = 300) { this.minMs = minMs; this.since = null; this.active = false; this.lastTs = 0; }

  update(cond, ts) {
    this.lastTs = ts;
    if (cond) {
      if (this.since === null) this.since = ts;
      this.active = ts - this.since >= this.minMs;
    } else {
      this.since = null;
      this.active = false;
    }
    return this.active;
  }

  get duration() { return this.since === null ? 0 : this.lastTs - this.since; }
  reset() { this.since = null; this.active = false; }
}

/**
 * 滞回周期计数器（信号层原语 rep）。
 * 下阈与上阈不共用一条线，否则信号在阈值附近抖动会连发。
 */
export class RepCounter {
  constructor({ down = 100, up = 150, minCycleMs = 600, minHalfMs = 120 } = {}) {
    this.down = down; this.up = up;
    this.minCycleMs = minCycleMs; this.minHalfMs = minHalfMs;
    this.phase = 'up';
    this.tDown = null;
    this.count = 0;
  }

  update(value, ts) {
    if (!Number.isFinite(value)) return this.count;
    if (this.phase === 'up') {
      if (value < this.down) { this.phase = 'down'; this.tDown = ts; }
    } else if (value > this.up && this.tDown !== null) {
      const dur = ts - this.tDown;
      if (dur >= Math.max(this.minHalfMs, this.minCycleMs)) {
        this.count++;
        this.phase = 'up';
        this.tDown = null;
      } else if (dur >= this.minHalfMs) {
        // 半程时间够但整周期太短：视为抖动，不计数，回位
        this.phase = 'up';
        this.tDown = null;
      }
    }
    return this.count;
  }

  /** 门控失效时调用：回到初始相位，避免把一次「坐下」记成一次深蹲 */
  abort() { this.phase = 'up'; this.tDown = null; }

  reset() { this.count = 0; this.phase = 'up'; this.tDown = null; }
}

/**
 * 有序阶段状态机（信号层原语 sequence，见 PLAN §5.2）。
 *
 * 「拿取」不是一个瞬时手势，而是一串有序阶段：伸手 → 合手 → 抬起。
 * 用多个独立 Hold 拼不出来——Hold 不知道「先后顺序」，也不会在超时后复位。
 *
 * @param {string[]} phases 阶段名，按期望顺序
 * @param {{minPhaseMs?:number, maxPhaseMs?:number, completeAt?:string}} opts
 *   minPhaseMs：每阶段最短持续，滤单帧抖动
 *   maxPhaseMs：每阶段最长持续时间，超时回到第一阶段（防止卡死在中间阶段）
 *   completeAt：走到这个阶段就算完成一次并回到第一阶段
 */
export class PhaseSequence {
  constructor(phases, { minPhaseMs = 120, maxPhaseMs = 1500, completeAt = null } = {}) {
    if (!phases || !phases.length) throw new Error('PhaseSequence 需要至少一个阶段');
    this.phases = phases;
    this.minPhaseMs = minPhaseMs;
    this.maxPhaseMs = maxPhaseMs;
    this.completeAt = completeAt || phases[phases.length - 1];
    this.reset();
  }

  reset() {
    this.index = 0;
    this.enteredAt = 0;
    this.count = 0;
    // started：当前阶段是否真的被观察到过。没有它，「没伸手直接合手」也会被当成阶段推进。
    this.started = false;
    // done：刚完成一次，必须回到第一阶段才能再次计数，否则握着手不动会逐帧累加。
    this.done = false;
  }

  /** 当前阶段名 */
  get phase() { return this.phases[this.index]; }

  /**
   * @param {string|null} observed 本帧观察到的阶段（null = 什么都不成立）
   * @param {number} ts 毫秒
   * @returns {{phase:string, count:number, completed:boolean}}
   */
  update(observed, ts) {
    // 阶段超时：复位到开头，防止「伸手后一直没合手」永久卡在中间阶段
    if (this.started && ts - this.enteredAt > this.maxPhaseMs) {
      this.index = 0;
      this.started = false;
      this.enteredAt = ts;
      this.done = false;
    }

    if (this.done) {
      // 闭锁：要重新看到第一阶段（例如手重新张开再伸）才允许下一次
      if (observed === this.phases[0]) {
        this.done = false;
        this.started = true;
        this.enteredAt = ts;
      }
      return { phase: this.phase, count: this.count, completed: false };
    }

    if (observed === this.phase) {
      if (!this.started) { this.started = true; this.enteredAt = ts; }
      return { phase: this.phase, count: this.count, completed: false };
    }

    let completed = false;
    if (this.started && this.phases[this.index + 1] === observed
      && ts - this.enteredAt >= this.minPhaseMs) {
      this.index++;
      this.enteredAt = ts;
      if (this.phase === this.completeAt) {
        this.count++;
        completed = true;
        this.index = 0;
        this.started = false;
        this.done = true;
      }
    }

    return { phase: this.phase, count: this.count, completed };
  }
}

/** 关键点滤波器组：每个点两个一维滤波器（x/y）。 */class KpFilter {
  constructor(opts, visMin = 0.3) {
    this.opts = opts;
    this.visMin = visMin;
    this.fx = {}; this.fy = {};
  }

  run(kp, tSec) {
    return kp.map(([x, y, v], i) => {
      const name = KPT[i];
      if (!this.fx[name]) { this.fx[name] = new OneEuro(this.opts); this.fy[name] = new OneEuro(this.opts); }
      if (v < this.visMin) {
        // 低置信度：保持上一次的滤波值（没有历史才用原始值）。
        // 之前直接返回原始坐标，等于把抖动原封不动喂给角度计算。
        const px = this.fx[name].xPrev;
        const py = this.fy[name].yPrev;
        return [Number.isFinite(px) ? px : x, Number.isFinite(py) ? py : y, v];
      }
      return [this.fx[name].filter(x, tSec), this.fy[name].filter(y, tSec), v];
    });
  }

  reset() { this.fx = {}; this.fy = {}; }
}

/** 固定长度中值滤波：抑制尺度锚点的单帧跳变 */
class MedianWindow {
  constructor(n = 5) { this.n = n; this.buf = []; }
  push(v) {
    if (!Number.isFinite(v) || v <= 0) return this.value();
    this.buf.push(v);
    if (this.buf.length > this.n) this.buf.shift();
    return this.value();
  }
  value() {
    if (!this.buf.length) return NaN;
    const s = [...this.buf].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  reset() { this.buf = []; }
}

/**
 * 信号引擎：吃 person 对象，产出 sig 对象（全部为标量或布尔，时间序列由调用方保存）。
 */
export class SignalEngine {
  constructor(params = {}) {
    const p = resolveParams(params).signals;
    this.params = p;
    this.kpFilter = new KpFilter(p.smoothing, p.visMin);
    this.angleOpts = { minCutoff: p.smoothing.angleCutoff, beta: p.smoothing.angleBeta };
    this.angleFilters = {};
    this.scaleWin = new MedianWindow(p.scaleMedianFrames);
    this.upFilter = new OneEuro(p.smoothing.upright);
    this.wristHist = { L: [], R: [] };
    this.minScore = p.minScore;
    this.visMin = p.visMin;
    this.minTorsoVis = p.minTorsoVis;
  }

  reset() {
    this.kpFilter.reset();
    this.angleFilters = {};
    this.scaleWin.reset();
    this.upFilter.reset();
    this.wristHist = { L: [], R: [] };
  }

  _smoothAngle(name, value, tSec) {
    if (!this.angleFilters[name]) this.angleFilters[name] = new OneEuro(this.angleOpts);
    return this.angleFilters[name].filter(value, tSec);
  }

  /**
   * @param {object} person toPersons() 产出的单人对象
   * @param {number} ts 毫秒时间戳
   */
  update(person, ts) {
    const tSec = ts / 1000;
    const C = this.params;
    const kp = this.kpFilter.run(person.kp, tSec);
    const P = (name) => kp[IDX[name]];
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    // 可见性门控：不可见的点算出来的几何量是垃圾，必须给 NaN（NaN 参与比较恒为 false）
    const V = (name) => P(name)[2] ?? 0;
    const VIS_MIN = this.visMin;
    const visTorso = Math.min(V('shoulder_L'), V('shoulder_R'), V('hip_L'), V('hip_R'));
    const visAnkle = Math.min(V('ankle_L'), V('ankle_R'));
    const visWristL = V('wrist_L');
    const visWristR = V('wrist_R');

    const shoulderMid = mid(P('shoulder_L'), P('shoulder_R'));
    const hipMid = mid(P('hip_L'), P('hip_R'));
    const ankleMid = mid(P('ankle_L'), P('ankle_R'));

    // 尺度锚点：滤波 + 中值平滑后的躯干长，异常时退回检测层的值
    let scale = Math.hypot(shoulderMid[0] - hipMid[0], shoulderMid[1] - hipMid[1]);
    scale = this.scaleWin.push(scale);
    if (!(scale > 5)) scale = Math.max(person.scale, 1);

    // 直立度：躯干四点都得够可见（单点飘了，中点就在乱动）
    const tvx = shoulderMid[0] - hipMid[0];
    const tvy = shoulderMid[1] - hipMid[1];
    const tlen = Math.hypot(tvx, tvy) || 1;
    const uprightness = visTorso >= VIS_MIN ? this.upFilter.filter(-tvy / tlen, tSec) : NaN;

    // 腿的竖直延伸：踝不可见就不给值。站立≈1.3~1.8，躺平≈0
    const legVertical = visAnkle >= VIS_MIN ? (ankleMid[1] - hipMid[1]) / scale : NaN;

    const raw = {
      knee_L: angleDeg(P('hip_L'), P('knee_L'), P('ankle_L')),
      knee_R: angleDeg(P('hip_R'), P('knee_R'), P('ankle_R')),
      elbow_L: angleDeg(P('shoulder_L'), P('elbow_L'), P('wrist_L')),
      elbow_R: angleDeg(P('shoulder_R'), P('elbow_R'), P('wrist_R')),
      hip_L: angleDeg(P('shoulder_L'), P('hip_L'), P('knee_L')),
      hip_R: angleDeg(P('shoulder_R'), P('hip_R'), P('knee_R')),
    };
    const angles = {};
    for (const [k, v] of Object.entries(raw)) angles[k] = this._smoothAngle(k, v, tSec);

    const visOf = (names) => names.reduce((s, n) => s + (P(n)[2] ?? 0), 0) / names.length;
    const pick = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2
      : Number.isFinite(a) ? a : b);

    // 计数用的膝角/肘角：只在「角度有效」的一侧里挑可见性最高的；选中的那侧无效就退回另一侧
    const pickSide = (l, r, visL, visR) => {
      const cand = [
        { side: 'L', v: l, vis: visL },
        { side: 'R', v: r, vis: visR },
      ].filter((c) => Number.isFinite(c.v));
      cand.sort((a, b) => b.vis - a.vis);
      return cand.length ? cand[0] : { side: 'L', v: NaN, vis: 0 };
    };

    const kneeSel = pickSide(angles.knee_L, angles.knee_R,
      visOf(['hip_L', 'knee_L', 'ankle_L']), visOf(['hip_R', 'knee_R', 'ankle_R']));
    const elbowSel = pickSide(angles.elbow_L, angles.elbow_R,
      visOf(['shoulder_L', 'elbow_L', 'wrist_L']), visOf(['shoulder_R', 'elbow_R', 'wrist_R']));

    const kneeSide = kneeSel.side;
    const kneePick = kneeSel.v;
    const elbowSide = elbowSel.side;
    const elbowPick = elbowSel.v;

    // 举手：腕高于肩（按尺度归一，不按像素），腕不可见就不算
    const raisedMargin = C.arm.raisedMargin;
    const raisedL = visWristL >= VIS_MIN && P('wrist_L')[1] < P('shoulder_L')[1] - raisedMargin * scale;
    const raisedR = visWristR >= VIS_MIN && P('wrist_R')[1] < P('shoulder_R')[1] - raisedMargin * scale;

    // 挥手：800ms 内腕部水平往返次数 + 幅度门限（都是尺度归一后的量）
    const waveL = this._oscillation('L', visWristL >= VIS_MIN ? P('wrist_L')[0] / scale : NaN, ts);
    const waveR = this._oscillation('R', visWristR >= VIS_MIN ? P('wrist_R')[0] / scale : NaN, ts);

    // —— 手臂信号：肩→腕的方向与相对位置，全部尺度归一
    const wristL = P('wrist_L'), wristR = P('wrist_R');
    const shL = P('shoulder_L'), shR = P('shoulder_R');
    const hipL = P('hip_L'), hipR = P('hip_R');
    const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

    // 抬臂角：0°=手在肩正上方，90°=水平，180°=自然下垂
    const elev = (sh, wr) => {
      const vx = wr[0] - sh[0], vy = wr[1] - sh[1];
      const n = Math.hypot(vx, vy) || 1;
      const cos = -vy / n;
      return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    };
    const elevL = visWristL >= VIS_MIN ? elev(shL, wristL) : NaN;
    const elevR = visWristR >= VIS_MIN ? elev(shR, wristR) : NaN;
    const reachL = visWristL >= VIS_MIN ? d2(wristL, shL) / scale : NaN;
    const reachR = visWristR >= VIS_MIN ? d2(wristR, shR) / scale : NaN;
    const handsClose = (visWristL >= VIS_MIN && visWristR >= VIS_MIN) ? d2(wristL, wristR) / scale : NaN;

    // —— 3D 信号（worldLandmarks，米制）：抗机位俯仰
    // 2D 抬臂角把「俯拍时的前伸」和「真实抬臂」混在一起；3D 相对躯干就分得开。
    const w3 = person.kp_world && person.kp_world.length >= 33 ? person.kp_world : null;
    const W3 = (name) => (w3 ? w3[MP_INDEX[name]] : null);
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const norm = (a) => Math.hypot(...a);
    const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

    let elevTorsoL = NaN, elevTorsoR = NaN;
    if (w3) {
      // 躯干轴：髋中点 → 肩中点。用世界坐标算，等于把摄像机姿态抵消掉
      const shM = unit([(W3('shoulder_L')[0] + W3('shoulder_R')[0]) / 2,
        (W3('shoulder_L')[1] + W3('shoulder_R')[1]) / 2,
        (W3('shoulder_L')[2] + W3('shoulder_R')[2]) / 2]);
      const hipM = [(W3('hip_L')[0] + W3('hip_R')[0]) / 2,
        (W3('hip_L')[1] + W3('hip_R')[1]) / 2,
        (W3('hip_L')[2] + W3('hip_R')[2]) / 2];
      const torso = unit(sub(shM, hipM));           // 指向头侧
      const elevTorso = (sh, wr) => {
        const v = unit(sub(wr, sh));
        // 0° = 臂沿躯干指向上，90° = 与躯干垂直（水平外展），180° = 沿躯干向下
        const cos = dot(v, torso);
        return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      };
      if (visWristL >= VIS_MIN) elevTorsoL = elevTorso(W3('shoulder_L'), W3('wrist_L'));
      if (visWristR >= VIS_MIN) elevTorsoR = elevTorso(W3('shoulder_R'), W3('wrist_R'));
    }

    // 手在头部附近：腕到鼻尖够近，**且腕不低于肩太多**（走路时手臂前摆会经过脸前，只判距离会误报）
    const nose = P('nose');
    const reachHeadL = (visWristL >= VIS_MIN && (V('nose') ?? 0) >= VIS_MIN)
      ? d2(wristL, nose) / scale : NaN;
    const reachHeadR = (visWristR >= VIS_MIN && (V('nose') ?? 0) >= VIS_MIN)
      ? d2(wristR, nose) / scale : NaN;
    const headNearL = Number.isFinite(reachHeadL) && reachHeadL < C.arm.head.maxDist
      && wristL[1] < shL[1] + C.arm.head.aboveShoulder * scale;   // 不能明显低于肩
    const headNearR = Number.isFinite(reachHeadR) && reachHeadR < C.arm.head.maxDist
      && wristR[1] < shR[1] + C.arm.head.aboveShoulder * scale;

    // 3D 抬臂角判定举手：比 2D 稳，但只在 world 可用时生效
    const raisedTorso = (v) => Number.isFinite(v) && v < C.arm.elevTorso.raised;

    // —— 伸手 / 指向 / 持物（拿取动作的基础信号）
    // 伸出 = 腕离肩足够远且不是自然下垂。用 reach（已按 scale 归一）而不是像素。
    const extendCfg = C.arm.extend;
    const extendedL = Number.isFinite(reachL) && reachL > extendCfg.minReach && elevL > extendCfg.minElev;
    const extendedR = Number.isFinite(reachR) && reachR > extendCfg.minReach && elevR > extendCfg.minElev;

    // 3D 水平方位角：肩→腕在水平面上的朝向。0°=正前方（朝镜头），±180°=正后方。
    // 世界坐标 z 轴指向屏幕内，所以 atan2(x, -z) 得到「相对身体正前方」的偏角。
    let azimL = NaN, azimR = NaN;
    if (w3) {
      const azimuth = (sh, wr) => {
        const v = sub(wr, sh);
        return (Math.atan2(v[0], -v[2]) * 180) / Math.PI;
      };
      if (visWristL >= VIS_MIN) azimL = azimuth(W3('shoulder_L'), W3('wrist_L'));
      if (visWristR >= VIS_MIN) azimR = azimuth(W3('shoulder_R'), W3('wrist_R'));
    }
    const azimCfg = C.arm.azimuth;
    // 方位角只在手臂接近水平时才有意义：自然下垂时水平分量≈0，atan2 出来的是噪声。
    // 实测过没这道门控时，走路视频里 armFront 一直是 true。
    const horizontal = (elevT) => Number.isFinite(elevT)
      && elevT > azimCfg.minElev && elevT < azimCfg.maxElev;
    const armFrontL = horizontal(elevTorsoL) && Math.abs(azimL) < azimCfg.frontMax;
    const armFrontR = horizontal(elevTorsoR) && Math.abs(azimR) < azimCfg.frontMax;
    const armSideL = horizontal(elevTorsoL) && Math.abs(azimL) > azimCfg.sideMin;
    const armSideR = horizontal(elevTorsoR) && Math.abs(azimR) > azimCfg.sideMin;

    // 抱臂：两腕的左右顺序相对肩膀翻转（用顺序而不是固定符号，人转身背对镜头也成立）
    const shOrder = Math.sign(shL[0] - shR[0]) || 1;
    const wrOrder = Math.sign(wristL[0] - wristR[0]) || 1;
    const wristsVisible = visWristL >= VIS_MIN && visWristR >= VIS_MIN;
    const crossed = wristsVisible
      && wrOrder !== shOrder
      && Math.abs(wristL[1] - shoulderMid[1]) < C.arm.crossed.ySpan * scale
      && Math.abs(wristR[1] - shoulderMid[1]) < C.arm.crossed.ySpan * scale;
    // 叉腰：腕贴髋 **且肘外张**。
    // 只判腕贴髋会把「手自然下垂」也算进来——站着时腕本来就在髋旁边（实测 0.19·scale）。
    // 真叉腰时肘会明显离开身体中线，用肘到肩-髋连线的横向偏移区分。
    const elbowOut = (sh, hip, el) => {
      const vx = hip[0] - sh[0], vy = hip[1] - sh[1];
      const n = Math.hypot(vx, vy) || 1;
      // 点到直线的距离，再按 scale 归一
      return Math.abs(((el[0] - sh[0]) * vy - (el[1] - sh[1]) * vx) / n) / scale;
    };
    /**
     * 肘不可见时的三态：可见 → 必须外张；不可见 → 不拿漂移坐标投票，退回只看腕贴髋。
     * 之前无脑用 P('elbow_*')：遮挡时 MediaPipe 给漂移坐标（甚至 (0,0)），
     * 既会把真叉腰判成假（漏判），也会把自然下垂判成真（误报）。
     */
    const onHipsSide = (sh, hip, el, wr, elVis) => {
      if (!(d2(wr, hip) < C.arm.onHips.maxDist * scale)) return false;
      if (elVis < VIS_MIN) return true;     // 肘看不到 → 不因此否定
      return elbowOut(sh, hip, el) > C.arm.onHips.elbowFlare;
    };
    const onHips = wristsVisible
      && onHipsSide(shL, hipL, P('elbow_L'), wristL, V('elbow_L'))
      && onHipsSide(shR, hipR, P('elbow_R'), wristR, V('elbow_R'));
    // 张开双臂：两侧都接近水平且伸得够远
    const ow = C.arm.openWide;
    const armsOpen = Number.isFinite(elevL) && Number.isFinite(elevR)
      && elevL > ow.minElev && elevL < ow.maxElev
      && elevR > ow.minElev && elevR < ow.maxElev
      && reachL > ow.minReach && reachR > ow.minReach;
    // 鼓掌门控：两腕在肩与髋之间（胸前），否则头顶合手也会被算
    const ch = C.arm.chest;
    const chestHeight = wristsVisible
      && wristL[1] > shoulderMid[1] + ch.above * scale
      && wristL[1] < hipMid[1] + ch.below * scale
      && wristR[1] > shoulderMid[1] + ch.above * scale
      && wristR[1] < hipMid[1] + ch.below * scale;

    const score = person.score ?? 0;

    return {
      ts,
      ok: score >= this.minScore && visTorso >= this.minTorsoVis,
      score,
      kp,
      scale,
      bbox: person.bbox,
      angles,
      knee_avg: pick(angles.knee_L, angles.knee_R),
      elbow_avg: pick(angles.elbow_L, angles.elbow_R),
      knee_pick: kneePick,
      knee_side: kneeSide,
      elbow_pick: elbowPick,
      uprightness,
      leg_vertical: legVertical,
      shoulder_y: shoulderMid[1],
      hip_y: hipMid[1],
      ankle_y: ankleMid[1],
      arm: {
        raised_L: raisedL,
        raised_R: raisedR,
        both_raised: raisedL && raisedR,
        any_raised: raisedL || raisedR,
        // 3D 版举手（只有 world 可用时有效，NaN 时下游自然不成立）
        raised3d_L: raisedTorso(elevTorsoL),
        raised3d_R: raisedTorso(elevTorsoR),
        any_raised3d: raisedTorso(elevTorsoL) || raisedTorso(elevTorsoR),
        head_near_L: headNearL,
        head_near_R: headNearR,
      },
      armPose: {
        elev_L: elevL,
        elev_R: elevR,
        elev_torso_L: elevTorsoL,
        elev_torso_R: elevTorsoR,
        reach_L: reachL,
        reach_R: reachR,
        reach_head_L: reachHeadL,
        reach_head_R: reachHeadR,
        hands_close: handsClose,
        crossed,
        on_hips: onHips,
        open_wide: armsOpen,
        chest_height: chestHeight,
        has_world: !!w3,
        extend_L: extendedL,
        extend_R: extendedR,
        azimuth_L: azimL,
        azimuth_R: azimR,
        arm_front_L: armFrontL,
        arm_front_R: armFrontR,
        arm_side_L: armSideL,
        arm_side_R: armSideR,
      },
      wave: { L: waveL.flips, R: waveR.flips, amp: Math.max(waveL.amp, waveR.amp) },
    };
  }

  _oscillation(side, xNorm, ts) {
    const W = this.params.wave;
    const h = this.wristHist[side];
    if (!Number.isFinite(xNorm)) {
      // 腕不可见：清空窗口并报告"没在挥"，不要拿旧数据继续判
      h.length = 0;
      return { flips: 0, amp: 0 };
    }
    h.push([ts, xNorm]);
    while (h.length && ts - h[0][0] > W.windowMs) h.shift();

    let flips = 0;
    let lastSign = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < h.length; i++) {
      min = Math.min(min, h[i][1]);
      max = Math.max(max, h[i][1]);
      if (i === 0) continue;
      const dx = h[i][1] - h[i - 1][1];
      if (Math.abs(dx) < W.deadzone) continue;   // 死区：滤掉关键点微抖
      const s = Math.sign(dx);
      if (lastSign !== 0 && s !== lastSign) flips++;
      lastSign = s;
    }
    return { flips, amp: Number.isFinite(min) ? max - min : 0 };
  }
}
