// signals.js — L2 信号层
// 职责：把坐标变成**时间序列信号**（角度、比值、振荡），并做平滑与去抖。
// 这一层是"通用"的关键：动作判定只认这里的信号，不直接碰关键点。
// 定义与阈值说明见 docs/signals.md（那份文档是唯一真相）。

import { KPT, IDX, MP_INDEX } from './kpt.js';
import { resolveParams } from './params.js';

// MediaPipe worldLandmarks：米制、原点在髋中心、**y 向下为正**（docs/signals.md §一·五）。
// 重力方向向量因此是 [0,1,0]；「竖直向上」是 [0,-1,0]。
const GRAVITY_DOWN = [0, 1, 0];

/** 参与骨骼长度一致性的肢体（world 下的两点间距离）。 */
export const BONE_SEGMENTS = [
  ['upperArm_L', 'shoulder_L', 'elbow_L'],
  ['foreArm_L', 'elbow_L', 'wrist_L'],
  ['upperArm_R', 'shoulder_R', 'elbow_R'],
  ['foreArm_R', 'elbow_R', 'wrist_R'],
  ['thigh_L', 'hip_L', 'knee_L'],
  ['shin_L', 'knee_L', 'ankle_L'],
  ['thigh_R', 'hip_R', 'knee_R'],
  ['shin_R', 'knee_R', 'ankle_R'],
];

const ANGLE_KEYS = ['knee_L', 'knee_R', 'elbow_L', 'elbow_R', 'hip_L', 'hip_R'];

const finite3 = (p) => Array.isArray(p)
  && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);

const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3norm = (a) => Math.hypot(a[0], a[1], a[2]);
const v3mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

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
 *
 * adaptiveMs=true 时（默认，见 params.js）：
 * 有历史后，用**半程时长中位数**替代固定的 minCycleMs —— 快动作不再被当抖动，
 * 慢动作也不会因为周期长得多而被拒。仍保留 minHalfMs 作为绝对下限，防微抖。
 */
export class RepCounter {
  constructor({
    down = 100, up = 150, minCycleMs = 600, minHalfMs = 120,
    adaptiveMs = false, adaptiveWindow = 5, adaptiveMinRatio = 0.5,
    adaptiveBootstrapRatio = 0.5,
  } = {}) {
    this.down = down; this.up = up;
    this.minCycleMs = minCycleMs; this.minHalfMs = minHalfMs;
    this.adaptiveMs = adaptiveMs;
    this.adaptiveWindow = Math.max(1, adaptiveWindow);
    this.adaptiveMinRatio = adaptiveMinRatio;
    this.adaptiveBootstrapRatio = adaptiveBootstrapRatio;
    this.phase = 'up';
    this.tDown = null;
    this.count = 0;
    this.halves = [];
  }

  /** 最近若干次下-上（半程）时长的中位数；没有历史返回 NaN */
  get medianHalfMs() {
    return this.halves.length ? median(this.halves) : NaN;
  }

  /**
   * 本半程至少要多久才算数。
   * 有历史：中位数 × ratio（最小不低于 minHalfMs）。
   * 没历史：不能直接用 minCycleMs —— 真实快动作（鼓掌）第一次就会被永久拒绝、
   * 永远攒不出历史。冷启动放宽到 minCycleMs × bootstrapRatio 仍高于纯抖动。
   */
  get minHalfNeeded() {
    const med = this.medianHalfMs;
    if (this.adaptiveMs && Number.isFinite(med)) {
      return Math.max(this.minHalfMs, med * this.adaptiveMinRatio);
    }
    if (this.adaptiveMs) {
      return Math.max(this.minHalfMs, this.minCycleMs * this.adaptiveBootstrapRatio);
    }
    return Math.max(this.minHalfMs, this.minCycleMs);
  }

  update(value, ts) {
    if (!Number.isFinite(value)) return this.count;
    if (this.phase === 'up') {
      if (value < this.down) { this.phase = 'down'; this.tDown = ts; }
    } else if (value > this.up && this.tDown !== null) {
      const dur = ts - this.tDown;
      if (dur >= this.minHalfNeeded) {
        this.count++;
        this.halves.push(dur);
        if (this.halves.length > this.adaptiveWindow) this.halves.shift();
        this.phase = 'up';
        this.tDown = null;
      } else if (dur >= this.minHalfMs) {
        // 比历史节奏明显过快：视为抖动，不计数，回位（不写入历史，避免把抖动学成节奏）
        this.phase = 'up';
        this.tDown = null;
      }
    }
    return this.count;
  }

  /** 门控失效时调用：回到初始相位，避免把一次「坐下」记成一次深蹲 */
  abort() { this.phase = 'up'; this.tDown = null; }

  reset() { this.count = 0; this.phase = 'up'; this.tDown = null; this.halves = []; }
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

/**
 * 关键点滤波器组：每个点两个一维滤波器（x/y）。
 * 可见性掉到阈值以下时：
 *  - 遮挡不超过 maxExtrapMs：按最后一帧速度**常速度外推**，并标记该点 extrapolated；
 *  - 超过：退回「保持上一次滤波值」，不再外推。
 * 外推点参与的计数由动作层冻结（signals.extrapolated → 不推进 RepCounter）。
 */
export class KpFilter {
  constructor(opts, visMin = 0.3, maxExtrapMs = 300) {
    this.opts = opts;
    this.visMin = visMin;
    this.maxExtrapMs = maxExtrapMs;
    this.fx = {}; this.fy = {};
    this.lastGoodT = {};
  }

  run(kp, tSec) {
    const out = [];
    const extrapolated = [];
    kp.forEach(([x, y, v], i) => {
      const name = KPT[i];
      if (!this.fx[name]) { this.fx[name] = new OneEuro(this.opts); this.fy[name] = new OneEuro(this.opts); }
      const fx = this.fx[name];
      const fy = this.fy[name];
      if (v < this.visMin) {
        // 低置信度：不喂滤波器（否则把噪声写进历史）
        const px = fx.xPrev;
        const py = fy.xPrev;
        if (!Number.isFinite(px) || !Number.isFinite(py)) { out.push([x, y, v]); return; }
        const lastT = this.lastGoodT[name];
        const gapMs = lastT == null ? Infinity : (tSec - lastT) * 1000;
        if (lastT != null && gapMs <= this.maxExtrapMs) {
          const dt = tSec - lastT;
          out.push([px + fx.dxPrev * dt, py + fy.dxPrev * dt, v]);
          extrapolated.push(name);
        } else {
          out.push([px, py, v]);
        }
        return;
      }
      this.lastGoodT[name] = tSec;
      out.push([fx.filter(x, tSec), fy.filter(y, tSec), v]);
    });
    return { kp: out, extrapolated };
  }

  reset() { this.fx = {}; this.fy = {}; this.lastGoodT = {}; }
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
    return median(this.buf);
  }
  reset() { this.buf = []; }
}

/**
 * 骨骼长度一致性（world 米制）。
 * 每条肢体维护最近 windowFrames 帧长度的中位数；攒够 minSamples 帧后，
 * 当前帧长度偏离中位数超过 tolerance → 该肢不可靠。
 * 目的不是量身高，而是抓「腕点漂到别处」这类 visibility 抓不到的坏点。
 */
export class BoneLengthGuard {
  constructor({ windowFrames = 60, minSamples = 10, tolerance = 0.2 } = {}) {
    this.windowFrames = windowFrames;
    this.minSamples = minSamples;
    this.tolerance = tolerance;
    this.hist = {};
  }

  /**
   * @param {(name:string)=>number[]|null} W 世界坐标取点函数
   * @returns {{lengths:object, medians:object, reliable:object, armed:object}}
   */
  update(W) {
    const lengths = {};
    const medians = {};
    const reliable = {};
    const armed = {};
    for (const [bone, a, b] of BONE_SEGMENTS) {
      const pa = W(a);
      const pb = W(b);
      const len = (finite3(pa) && finite3(pb)) ? v3norm(v3sub(pa, pb)) : NaN;
      const h = this.hist[bone] || (this.hist[bone] = []);
      const med = median(h);
      const isArmed = h.length >= this.minSamples && Number.isFinite(med) && med > 1e-6;
      if (Number.isFinite(len) && len > 1e-6) {
        // armed 之后只把「在容差内」的长度写进历史：坏点不能把中位数一起带跑，
        // 否则持续漂移 60 帧后会把错的当成新的「正常长度」。
        const withinTol = !isArmed || Math.abs(len / med - 1) <= this.tolerance;
        if (withinTol) {
          h.push(len);
          if (h.length > this.windowFrames) h.shift();
        }
      }
      const medNow = median(h);
      const armedNow = h.length >= this.minSamples && Number.isFinite(medNow) && medNow > 1e-6;
      armed[bone] = armedNow;
      lengths[bone] = len;
      medians[bone] = medNow;
      // 未攒够样本时不否定（冷启动不能把所有信号打成 NaN）；
      // 攒够后：本帧点缺失或长度偏离中位数超过 tolerance → 不可靠。
      reliable[bone] = !armedNow
        || (Number.isFinite(len) && Math.abs(len / medNow - 1) <= this.tolerance);
    }
    return { lengths, medians, reliable, armed };
  }

  reset() { this.hist = {}; }
}

/**
 * 信号引擎：吃 person 对象，产出 sig 对象（全部为标量或布尔，时间序列由调用方保存）。
 */
export class SignalEngine {
  constructor(params = {}) {
    const p = resolveParams(params).signals;
    this.params = p;
    this.kpFilter = new KpFilter(p.smoothing, p.visMin, p.occlusion.maxExtrapMs);
    this.angleOpts = { minCutoff: p.smoothing.angleCutoff, beta: p.smoothing.angleBeta };
    this.angleFilters = {};
    this.scaleWin = new MedianWindow(p.scaleMedianFrames);
    this.scaleWorldWin = new MedianWindow(p.scaleMedianFrames);
    this.upFilter2 = new OneEuro(p.smoothing.upright);
    this.upFilter3 = new OneEuro(p.smoothing.upright);
    this.velCfg = p.velocity;
    this.velFilters = {};
    this.velState = {};
    this.wristHist = { L: [], R: [] };
    this.boneGuard = new BoneLengthGuard(p.world.boneCheck);
    this.minScore = p.minScore;
    this.visMin = p.visMin;
    this.minTorsoVis = p.minTorsoVis;
  }

  reset() {
    this.kpFilter.reset();
    this.angleFilters = {};
    this.scaleWin.reset();
    this.scaleWorldWin.reset();
    this.upFilter2.reset();
    this.upFilter3.reset();
    this.velFilters = {};
    this.velState = {};
    this.wristHist = { L: [], R: [] };
    this.boneGuard.reset();
  }

  _smoothAngle(name, value, tSec) {
    if (!this.angleFilters[name]) this.angleFilters[name] = new OneEuro(this.angleOpts);
    return this.angleFilters[name].filter(value, tSec);
  }

  /** 一阶差分 = 角速度（度/秒）。间隔越界或值无效时给 NaN（速度不保持旧值）。 */
  _velocity(name, value, ts) {
    if (!this.velState[name]) this.velState[name] = { v: null, t: null };
    const st = this.velState[name];
    let raw = NaN;
    if (Number.isFinite(value) && st.t != null && st.v != null) {
      const dt = ts - st.t;
      if (dt >= this.velCfg.minDtMs && dt <= this.velCfg.maxDtMs) {
        raw = ((value - st.v) * 1000) / dt;
      }
    }
    if (Number.isFinite(value)) { st.v = value; st.t = ts; }
    if (!Number.isFinite(raw)) return NaN;
    if (!this.velFilters[name]) {
      this.velFilters[name] = new OneEuro({ minCutoff: this.velCfg.minCutoff, beta: this.velCfg.beta });
    }
    return this.velFilters[name].filter(raw, ts / 1000);
  }

  /**
   * @param {object} person toPersons() 产出的单人对象
   * @param {number} ts 毫秒时间戳
   */
  update(person, ts) {
    const tSec = ts / 1000;
    const C = this.params;
    const WC = C.world;
    const { kp, extrapolated } = this.kpFilter.run(person.kp, tSec);
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

    // —— worldLandmarks（米制 3D）：有则优先，无则逐信号退回 2D ——
    const w3 = WC.enabled && person.kp_world && person.kp_world.length >= 33
      ? person.kp_world : null;
    const Wp = (name) => (w3 ? w3[MP_INDEX[name]] : null);
    const boneOn = !!w3 && WC.boneCheck.enabled;
    const bone = boneOn
      ? this.boneGuard.update(Wp)
      : { lengths: {}, medians: {}, reliable: {}, armed: {} };
    const boneOk = (name) => !boneOn || bone.reliable[name] !== false;
    const armOk = (side) => boneOk(`upperArm_${side}`) && boneOk(`foreArm_${side}`);
    const legOk = (side) => boneOk(`thigh_${side}`) && boneOk(`shin_${side}`);
    const armBlocked = (side) => boneOn && !armOk(side);

    let torsoW = null;
    let hipMidW = null;
    let ankleMidW = null;
    let scaleWorld = NaN;
    if (w3) {
      const sLW = Wp('shoulder_L'), sRW = Wp('shoulder_R');
      const hLW = Wp('hip_L'), hRW = Wp('hip_R');
      if (finite3(sLW) && finite3(sRW) && finite3(hLW) && finite3(hRW)) {
        const shMidW = v3mid(sLW, sRW);
        hipMidW = v3mid(hLW, hRW);
        const tv = v3sub(shMidW, hipMidW);
        const tlen = v3norm(tv);
        if (tlen > 1e-6) {
          torsoW = tv;
          const filtered = this.scaleWorldWin.push(tlen);
          scaleWorld = Number.isFinite(filtered) ? filtered : tlen;
        }
      }
      const aLW = Wp('ankle_L'), aRW = Wp('ankle_R');
      if (finite3(aLW) && finite3(aRW)) ankleMidW = v3mid(aLW, aRW);
    }

    // 直立度：躯干四点都得够可见（单点飘了，中点就在乱动）
    const tvx = shoulderMid[0] - hipMid[0];
    const tvy = shoulderMid[1] - hipMid[1];
    const tlen2 = Math.hypot(tvx, tvy) || 1;
    const up2d = this.upFilter2.filter(visTorso >= VIS_MIN ? -tvy / tlen2 : NaN, tSec);
    let up3d = NaN;
    if (w3 && torsoW && visTorso >= VIS_MIN) {
      const tlen3 = v3norm(torsoW) || 1;
      // 3D：躯干单位向量与重力轴（world −y，即 [0,-1,0]）的点积
      const raw = -(torsoW[0] * GRAVITY_DOWN[0] + torsoW[1] * GRAVITY_DOWN[1]
        + torsoW[2] * GRAVITY_DOWN[2]) / tlen3;
      if (Number.isFinite(raw)) up3d = this.upFilter3.filter(raw, tSec);
    }
    const uprightness = (WC.uprightness && Number.isFinite(up3d)) ? up3d : up2d;

    // 腿的竖直延伸：2D 用像素 scale；3D 用世界竖直投影 / 世界躯干长。
    // 注意量纲不同（站立时 3D 约 2.0、2D 约 1.3），默认不切换，见 params.js world.legVertical。
    const leg2d = visAnkle >= VIS_MIN ? (ankleMid[1] - hipMid[1]) / scale : NaN;
    let leg3d = NaN;
    if (w3 && hipMidW && ankleMidW && Number.isFinite(scaleWorld) && scaleWorld > 1e-6
      && visAnkle >= VIS_MIN && legOk('L') && legOk('R')) {
      // 踝-髋向量在重力轴（world y 向下）上的投影 / 世界躯干长
      const drop = (ankleMidW[0] - hipMidW[0]) * GRAVITY_DOWN[0]
        + (ankleMidW[1] - hipMidW[1]) * GRAVITY_DOWN[1]
        + (ankleMidW[2] - hipMidW[2]) * GRAVITY_DOWN[2];
      const raw = drop / scaleWorld;
      if (Number.isFinite(raw)) leg3d = raw;
    }
    const legVertical = (WC.legVertical && Number.isFinite(leg3d)) ? leg3d : leg2d;

    // —— 关节角：有 world 用 3D，无则退回 2D ——
    const raw2d = {
      knee_L: angleDeg(P('hip_L'), P('knee_L'), P('ankle_L')),
      knee_R: angleDeg(P('hip_R'), P('knee_R'), P('ankle_R')),
      elbow_L: angleDeg(P('shoulder_L'), P('elbow_L'), P('wrist_L')),
      elbow_R: angleDeg(P('shoulder_R'), P('elbow_R'), P('wrist_R')),
      hip_L: angleDeg(P('shoulder_L'), P('hip_L'), P('knee_L')),
      hip_R: angleDeg(P('shoulder_R'), P('hip_R'), P('knee_R')),
    };
    const visTri = (names) => names.every((n) => (V(n) ?? 0) >= VIS_MIN);
    const angleW = (a, b, c) => {
      const pa = Wp(a), pb = Wp(b), pc = Wp(c);
      return (finite3(pa) && finite3(pb) && finite3(pc)) ? angleDeg3(pa, pb, pc) : NaN;
    };
    const raw3d = {
      knee_L: (legOk('L') && visTri(['hip_L', 'knee_L', 'ankle_L']))
        ? angleW('hip_L', 'knee_L', 'ankle_L') : NaN,
      knee_R: (legOk('R') && visTri(['hip_R', 'knee_R', 'ankle_R']))
        ? angleW('hip_R', 'knee_R', 'ankle_R') : NaN,
      elbow_L: (armOk('L') && visTri(['shoulder_L', 'elbow_L', 'wrist_L']))
        ? angleW('shoulder_L', 'elbow_L', 'wrist_L') : NaN,
      elbow_R: (armOk('R') && visTri(['shoulder_R', 'elbow_R', 'wrist_R']))
        ? angleW('shoulder_R', 'elbow_R', 'wrist_R') : NaN,
      hip_L: (legOk('L') && visTri(['shoulder_L', 'hip_L', 'knee_L']))
        ? angleW('shoulder_L', 'hip_L', 'knee_L') : NaN,
      hip_R: (legOk('R') && visTri(['shoulder_R', 'hip_R', 'knee_R']))
        ? angleW('shoulder_R', 'hip_R', 'knee_R') : NaN,
    };
    // 骨骼长度不一致时，这一侧的坐标本身就不可信 → NaN，
    // 不退回 2D（2D 用的是同一批坏点，退回只会把错误藏起来）。
    const blocked = {
      knee_L: boneOn && !legOk('L'),
      knee_R: boneOn && !legOk('R'),
      elbow_L: boneOn && !armOk('L'),
      elbow_R: boneOn && !armOk('R'),
      hip_L: boneOn && !legOk('L'),
      hip_R: boneOn && !legOk('R'),
    };
    const angles = {};
    const angles2d = {};
    const angles3d = {};
    const angleSource = {};
    for (const k of ANGLE_KEYS) {
      // 2D 保持旧行为：低可见时滤波器保持上一次值
      const a2 = this._smoothAngle(`2d:${k}`, raw2d[k], tSec);
      angles2d[k] = a2;
      // 3D 不保持旧值：本帧没有有效 world 点就不给数，避免拿陈旧 3D 冒充当前
      const a3 = (w3 && Number.isFinite(raw3d[k]))
        ? this._smoothAngle(`3d:${k}`, raw3d[k], tSec) : NaN;
      angles3d[k] = a3;
      let v = NaN;
      let src = 'none';
      if (blocked[k]) {
        src = 'blocked';
      } else if (WC.angles && Number.isFinite(a3)) {
        v = a3; src = '3d';
      } else if (Number.isFinite(a2)) {
        v = a2; src = '2d';
      }
      angles[k] = v;
      angleSource[k] = src;
    }

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

    const kneeVisL = visOf(['hip_L', 'knee_L', 'ankle_L']);
    const kneeVisR = visOf(['hip_R', 'knee_R', 'ankle_R']);
    const elbowVisL = visOf(['shoulder_L', 'elbow_L', 'wrist_L']);
    const elbowVisR = visOf(['shoulder_R', 'elbow_R', 'wrist_R']);

    const kneeSel = pickSide(angles.knee_L, angles.knee_R, kneeVisL, kneeVisR);
    const elbowSel = pickSide(angles.elbow_L, angles.elbow_R, elbowVisL, elbowVisR);
    const kneeSide = kneeSel.side;
    const kneePick = kneeSel.v;
    const elbowSide = elbowSel.side;
    const elbowPick = elbowSel.v;
    const kneePick2d = pickSide(angles2d.knee_L, angles2d.knee_R, kneeVisL, kneeVisR).v;
    const kneePick3d = pickSide(angles3d.knee_L, angles3d.knee_R, kneeVisL, kneeVisR).v;
    const elbowPick2d = pickSide(angles2d.elbow_L, angles2d.elbow_R, elbowVisL, elbowVisR).v;
    const elbowPick3d = pickSide(angles3d.elbow_L, angles3d.elbow_R, elbowVisL, elbowVisR).v;

    // 角速度（度/秒），用选中的那一侧
    const vel = {};
    for (const k of ANGLE_KEYS) vel[k] = this._velocity(k, angles[k], ts);
    const kneeVel = kneeSide === 'L' ? vel.knee_L : vel.knee_R;
    const elbowVel = elbowSide === 'L' ? vel.elbow_L : vel.elbow_R;

    // 举手：腕高于肩（按尺度归一，不按像素），腕不可见或该臂骨骼不可靠就不算
    const raisedMargin = C.arm.raisedMargin;
    const armUsableL = !armBlocked('L') && visWristL >= VIS_MIN;
    const armUsableR = !armBlocked('R') && visWristR >= VIS_MIN;
    const raisedL = armUsableL && P('wrist_L')[1] < P('shoulder_L')[1] - raisedMargin * scale;
    const raisedR = armUsableR && P('wrist_R')[1] < P('shoulder_R')[1] - raisedMargin * scale;

    // 挥手：800ms 内腕部水平往返次数 + 幅度门限（都是尺度归一后的量）
    const waveL = this._oscillation('L', armUsableL ? P('wrist_L')[0] / scale : NaN, ts);
    const waveR = this._oscillation('R', armUsableR ? P('wrist_R')[0] / scale : NaN, ts);

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
    const elevL = armUsableL ? elev(shL, wristL) : NaN;
    const elevR = armUsableR ? elev(shR, wristR) : NaN;
    const reach2dL = armUsableL ? d2(wristL, shL) / scale : NaN;
    const reach2dR = armUsableR ? d2(wristR, shR) / scale : NaN;
    const handsClose2d = (armUsableL && armUsableR) ? d2(wristL, wristR) / scale : NaN;

    // —— 3D 距离比值（米制）：与分辨率、投影都无关；量纲需重拟合，默认不参与判定
    const distW = (a, b) => {
      const pa = Wp(a), pb = Wp(b);
      return (finite3(pa) && finite3(pb)) ? v3norm(v3sub(pa, pb)) : NaN;
    };
    const ratioW = (d) => (w3 && Number.isFinite(scaleWorld) && scaleWorld > 1e-6)
      ? d / scaleWorld : NaN;
    const reach3dL = (!armBlocked('L')) ? ratioW(distW('wrist_L', 'shoulder_L')) : NaN;
    const reach3dR = (!armBlocked('R')) ? ratioW(distW('wrist_R', 'shoulder_R')) : NaN;
    const handsClose3d = (!armBlocked('L') && !armBlocked('R'))
      ? ratioW(distW('wrist_L', 'wrist_R')) : NaN;
    const wristHip2dL = armUsableL ? d2(wristL, hipL) / scale : NaN;
    const wristHip2dR = armUsableR ? d2(wristR, hipR) / scale : NaN;
    const wristHip3dL = (!armBlocked('L')) ? ratioW(distW('wrist_L', 'hip_L')) : NaN;
    const wristHip3dR = (!armBlocked('R')) ? ratioW(distW('wrist_R', 'hip_R')) : NaN;

    const useRatios = WC.ratios;
    const pickRatio = (v3, v2) => (useRatios && Number.isFinite(v3)) ? v3 : v2;
    const reachL = pickRatio(reach3dL, reach2dL);
    const reachR = pickRatio(reach3dR, reach2dR);
    const handsClose = pickRatio(handsClose3d, handsClose2d);
    const wristHipL = pickRatio(wristHip3dL, wristHip2dL);
    const wristHipR = pickRatio(wristHip3dR, wristHip2dR);

    // —— 3D 信号（worldLandmarks，米制）：抗机位俯仰
    // 2D 抬臂角把「俯拍时的前伸」和「真实抬臂」混在一起；3D 相对躯干就分得开。
    const sub3 = v3sub;
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const unit3 = (a) => { const n = v3norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

    let elevTorsoL = NaN, elevTorsoR = NaN;
    if (w3) {
      // 躯干轴：髋中点 → 肩中点。用世界坐标算，等于把摄像机姿态抵消掉
      const torso = torsoW ? unit3(torsoW) : null;
      const elevTorso = (sh, wr) => {
        const v = unit3(sub3(wr, sh));
        // 0° = 臂沿躯干指向上，90° = 与躯干垂直（水平外展），180° = 沿躯干向下
        const cos = dot3(v, torso);
        return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      };
      if (torso) {
        const shLW = Wp('shoulder_L'), wrLW = Wp('wrist_L');
        const shRW = Wp('shoulder_R'), wrRW = Wp('wrist_R');
        if (armUsableL && finite3(shLW) && finite3(wrLW)) elevTorsoL = elevTorso(shLW, wrLW);
        if (armUsableR && finite3(shRW) && finite3(wrRW)) elevTorsoR = elevTorso(shRW, wrRW);
      }
    }

    // 手在头部附近：腕到鼻尖够近，**且腕不低于肩太多**（走路时手臂前摆会经过脸前，只判距离会误报）
    const nose = P('nose');
    const head2dL = (armUsableL && (V('nose') ?? 0) >= VIS_MIN) ? d2(wristL, nose) / scale : NaN;
    const head2dR = (armUsableR && (V('nose') ?? 0) >= VIS_MIN) ? d2(wristR, nose) / scale : NaN;
    const head3dL = (!armBlocked('L') && (V('nose') ?? 0) >= VIS_MIN)
      ? ratioW(distW('wrist_L', 'nose')) : NaN;
    const head3dR = (!armBlocked('R') && (V('nose') ?? 0) >= VIS_MIN)
      ? ratioW(distW('wrist_R', 'nose')) : NaN;
    const reachHeadL = pickRatio(head3dL, head2dL);
    const reachHeadR = pickRatio(head3dR, head2dR);
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
        if (!finite3(sh) || !finite3(wr)) return NaN;
        const v = sub3(wr, sh);
        return (Math.atan2(v[0], -v[2]) * 180) / Math.PI;
      };
      if (visWristL >= VIS_MIN) azimL = azimuth(Wp('shoulder_L'), Wp('wrist_L'));
      if (visWristR >= VIS_MIN) azimR = azimuth(Wp('shoulder_R'), Wp('wrist_R'));
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
    const wristsVisible = armUsableL && armUsableR;
    const crossed = wristsVisible
      && wrOrder !== shOrder
      && Math.abs(wristL[1] - shoulderMid[1]) < C.arm.crossed.ySpan * scale
      && Math.abs(wristR[1] - shoulderMid[1]) < C.arm.crossed.ySpan * scale;
    // 叉腰：腕贴髋 **且肘外张**。
    // 只判腕贴髋会把「手自然下垂」也算进来——站着时腕本来就在髋旁边（实测 0.19·scale）。
    // 真叉腰时肘会明显离开身体中线，用肘到肩-髋连线的横向偏移区分。
    const elbowOut2d = (sh, hip, el) => {
      const vx = hip[0] - sh[0], vy = hip[1] - sh[1];
      const n = Math.hypot(vx, vy) || 1;
      // 点到直线的距离，再按 scale 归一
      return Math.abs(((el[0] - sh[0]) * vy - (el[1] - sh[1]) * vx) / n) / scale;
    };
    const elbowOut3d = (shName, hipName, elName) => {
      const sh = Wp(shName), hip = Wp(hipName), el = Wp(elName);
      if (!finite3(sh) || !finite3(hip) || !finite3(el) || !(scaleWorld > 1e-6)) return NaN;
      const ax = hip[0] - sh[0], ay = hip[1] - sh[1], az = hip[2] - sh[2];
      const bx = el[0] - sh[0], by = el[1] - sh[1], bz = el[2] - sh[2];
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const alen = Math.hypot(ax, ay, az) || 1;
      return Math.hypot(cx, cy, cz) / alen / scaleWorld;
    };
    /**
     * 肘不可见时的三态：可见 → 必须外张；不可见 → 不拿漂移坐标投票，退回只看腕贴髋。
     * 之前无脑用 P('elbow_*')：遮挡时 MediaPipe 给漂移坐标（甚至 (0,0)），
     * 既会把真叉腰判成假（漏判），也会把自然下垂判成真（误报）。
     */
    const onHipsSide = (side, sh, hip, el, elVis) => {
      if (armBlocked(side)) return false;
      // 用 pickRatio 选好的值：ratios=true 但本帧没有 world 时它会退回 2D
      const dist = side === 'L' ? wristHipL : wristHipR;
      if (!(dist < C.arm.onHips.maxDist)) return false;
      if (elVis < VIS_MIN) return true;     // 肘看不到 → 不因此否定
      const flare3 = useRatios
        ? elbowOut3d(`shoulder_${side}`, `hip_${side}`, `elbow_${side}`) : NaN;
      const flare = Number.isFinite(flare3) ? flare3 : elbowOut2d(sh, hip, el);
      return flare > C.arm.onHips.elbowFlare;
    };
    const onHips = wristsVisible
      && onHipsSide('L', shL, hipL, P('elbow_L'), V('elbow_L'))
      && onHipsSide('R', shR, hipR, P('elbow_R'), V('elbow_R'));
    // 张开双臂：两侧都接近水平且伸得够远。
    // 有 world 且启用 ratios 时，抬臂角也换 3D（elev_torso 与 2D elev 同为 0~180，0=向上）
    const ow = C.arm.openWide;
    const elevCmpL = (useRatios && Number.isFinite(elevTorsoL)) ? elevTorsoL : elevL;
    const elevCmpR = (useRatios && Number.isFinite(elevTorsoR)) ? elevTorsoR : elevR;
    const armsOpen = Number.isFinite(elevCmpL) && Number.isFinite(elevCmpR)
      && elevCmpL > ow.minElev && elevCmpL < ow.maxElev
      && elevCmpR > ow.minElev && elevCmpR < ow.maxElev
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
      scale_world: scaleWorld,
      bbox: person.bbox,
      angles,
      angles2d,
      angles3d,
      angle_source: angleSource,
      knee_avg: pick(angles.knee_L, angles.knee_R),
      elbow_avg: pick(angles.elbow_L, angles.elbow_R),
      knee_pick: kneePick,
      knee_side: kneeSide,
      knee_pick_2d: kneePick2d,
      knee_pick_3d: kneePick3d,
      elbow_pick: elbowPick,
      elbow_side: elbowSide,
      elbow_pick_2d: elbowPick2d,
      elbow_pick_3d: elbowPick3d,
      knee_vel: kneeVel,
      elbow_vel: elbowVel,
      angles_vel: vel,
      uprightness,
      uprightness_2d: up2d,
      uprightness_3d: up3d,
      leg_vertical: legVertical,
      leg_vertical_2d: leg2d,
      leg_vertical_3d: leg3d,
      shoulder_y: shoulderMid[1],
      hip_y: hipMid[1],
      ankle_y: ankleMid[1],
      // 短时遮挡按最后速度外推的点；动作层在这期间冻结计数
      extrapolated: extrapolated.slice(),
      extrapolated_any: extrapolated.length > 0,
      world: {
        has_world: !!w3,
        enabled: !!WC.enabled,
        scale: scaleWorld,
        bones: boneOn ? { ...bone.reliable } : null,
        bone_lengths: boneOn ? { ...bone.medians } : null,
        bone_armed: boneOn ? { ...bone.armed } : null,
      },
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
        reach_2d_L: reach2dL,
        reach_2d_R: reach2dR,
        reach_3d_L: reach3dL,
        reach_3d_R: reach3dR,
        reach_head_L: reachHeadL,
        reach_head_R: reachHeadR,
        reach_head_2d_L: head2dL,
        reach_head_2d_R: head2dR,
        reach_head_3d_L: head3dL,
        reach_head_3d_R: head3dR,
        hands_close: handsClose,
        hands_close_2d: handsClose2d,
        hands_close_3d: handsClose3d,
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
        ratio_source: useRatios ? '3d-if-available' : '2d',
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
