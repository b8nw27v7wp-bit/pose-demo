// signals.js — L2 信号层
// 职责：把坐标变成**时间序列信号**（角度、比值、振荡），并做平滑与去抖。
// 这一层是"通用"的关键：动作判定只认这里的信号，不直接碰关键点。
// 定义与阈值说明见 docs/signals.md（那份文档是唯一真相）。

import { KPT, IDX, MP_INDEX } from './kpt.js';
import { resolveParams } from './params.js';
import {
  resolveRegions, scaleZones, pointInAnyZone, maxZoneOverlap, personBoxValidity,
} from './geometry.js';

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
  /**
   * @param {number} minMs 条件需连续成立的时长
   * @param {number} maxGapMs 允许的掉帧/遮挡间隔（默认 0 = 任一帧不成立就重计时）。
   *   只给「持续事件」用（如操作设备）：手腕被设备挡住一两帧不该让计时归零。
   */
  constructor(minMs = 300, maxGapMs = 0) {
    this.minMs = minMs;
    this.maxGapMs = maxGapMs;
    this.since = null;
    this.lastTrueTs = null;
    this.active = false;
    this.lastTs = 0;
  }

  update(cond, ts) {
    this.lastTs = ts;
    if (cond) {
      // maxGap 也要管「两次调用之间隔了多久」：人短暂丢失/引擎根本没被调用时，
      // 中间没有任何 cond=false 的帧，只在 false 分支检查 maxGap 会白续计时。
      // maxGapMs=0 时保持旧语义（不能每帧真值都重置）。
      if (this.maxGapMs > 0 && this.lastTrueTs !== null
        && ts - this.lastTrueTs > this.maxGapMs) {
        this.since = null;
        this.active = false;
      }
      this.lastTrueTs = ts;
      if (this.since === null) this.since = ts;
      this.active = ts - this.since >= this.minMs;
    } else if (this.since !== null && this.maxGapMs > 0
      && ts - this.lastTrueTs <= this.maxGapMs) {
      // 短暂掉帧：保持计时与 active 状态，等条件恢复后继续累计。
      // 间隔超过 maxGapMs 仍按中断处理，避免把两段独立动作粘成一段。
    } else {
      this.since = null;
      this.lastTrueTs = null;
      this.active = false;
    }
    return this.active;
  }

  get duration() { return this.since === null ? 0 : this.lastTs - this.since; }
  reset() { this.since = null; this.lastTrueTs = null; this.active = false; }
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
    // 设备区域是静态配置：构造时解析一次，逐帧只做归一化→像素换算。
    // 多边形 rois 非空时优先；全部非法时 valid=false（fail-closed）。
    this.regions = resolveRegions(p.arm.operating, 0, 0);
    this.kpFilter = new KpFilter(p.smoothing, p.visMin, p.occlusion.maxExtrapMs);
    this.angleOpts = { minCutoff: p.smoothing.angleCutoff, beta: p.smoothing.angleBeta };
    this.angleFilters = {};
    this.angleLast = {};       // 每个角度上一次的有效原始值（用于突变剔除）
    this.angleOutliers = {};   // 被剔除的帧数（诊断用）
    this.angleRejected = [];   // 本帧被剔除的角度名（动作层 → unreliable）
    this.angleJump = p.angleJump;
    this.sideHyst = p.sideHysteresis;
    this.prevKneeSide = null;  // 上一帧选中的腿/臂，供滞回使用
    this.prevElbowSide = null;
    this.scaleWin = new MedianWindow(p.scaleMedianFrames);
    this.scaleWorldWin = new MedianWindow(p.scaleMedianFrames);
    // 髋不可信时用肩宽换算躯干长；lastScale 记住最后一次可信的躯干长（肩也侧对镜头时兜底）
    this.shoulderToTorso = p.shoulderToTorso;
    this.lastScale = 0;
    this.upFilter2 = new OneEuro(p.smoothing.upright);
    this.upFilter3 = new OneEuro(p.smoothing.upright);
    this.upFilterHead2 = new OneEuro(p.smoothing.upright);
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
    this.angleLast = {};
    this.angleOutliers = {};
    this.angleRejected = [];
    this.prevKneeSide = null;
    this.prevElbowSide = null;
    this.scaleWin.reset();
    this.scaleWorldWin.reset();
    this.lastScale = 0;
    this.upFilter2.reset();
    this.upFilter3.reset();
    this.upFilterHead2.reset();
    this.velFilters = {};
    this.velState = {};
    this.wristHist = { L: [], R: [] };
    this.boneGuard.reset();
  }

  _smoothAngle(name, value, tSec) {
    if (!this.angleFilters[name]) this.angleFilters[name] = new OneEuro(this.angleOpts);
    // 单帧坏点剔除：挡住/漂移的关键点会让角度瞬间跳几十度。
    // 与上次**有效**值比较；超时（> maxDtMs）说明新值持续存在，接受它。
    // 注意：这里不沿用旧值冒充当前——返回 NaN，调用方按「本帧无角度」处理。
    const st = this.angleLast[name];
    if (Number.isFinite(value) && st && Number.isFinite(st.v)) {
      const dtMs = (tSec - st.t) * 1000;
      if (dtMs > 0 && dtMs <= this.angleJump.maxDtMs) {
        const rate = Math.abs(value - st.v) / (dtMs / 1000);
        if (rate > this.angleJump.maxRate) {
          this.angleOutliers[name] = (this.angleOutliers[name] || 0) + 1;
          this.angleRejected.push(name);
          return NaN;
        }
      }
    }
    if (Number.isFinite(value)) this.angleLast[name] = { v: value, t: tSec };
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
  update(person, ts, objects = []) {
    const tSec = ts / 1000;
    this.angleRejected = [];   // 本帧的坏点清单（逐帧重置）
    const C = this.params;
    const WC = C.world;
    const { kp, extrapolated } = this.kpFilter.run(person.kp, tSec);
    const P = (name) => kp[IDX[name]];
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    // 可见性门控：不可见的点算出来的几何量是垃圾，必须给 NaN（NaN 参与比较恒为 false）
    const V = (name) => P(name)[2] ?? 0;
    const VIS_MIN = this.visMin;
    // 肩/髋分开算：上半身构图里髋常在画面外，把两者取 min 会让每一帧都「躯干不可见」。
    const visShoulder = Math.min(V('shoulder_L'), V('shoulder_R'));
    const visHip = Math.min(V('hip_L'), V('hip_R'));
    const visTorso = Math.min(visShoulder, visHip);
    const visAnkle = Math.min(V('ankle_L'), V('ankle_R'));
    const visWristL = V('wrist_L');
    const visWristR = V('wrist_R');

    const shoulderMid = mid(P('shoulder_L'), P('shoulder_R'));
    const hipMid = mid(P('hip_L'), P('hip_R'));
    const ankleMid = mid(P('ankle_L'), P('ankle_R'));
    const nose = P('nose');

    // 尺度锚点：优先用躯干长（肩中点↔髋中点），滤波 + 中值平滑，异常时退回检测层的值。
    // 上半身构图里髋点不可信（模型是猜的，位置会随躯干一起漂），躯干长会忽大忽小；
    // 这时改用肩宽 × 人体比例（肩宽≈躯干长/1.4），它同样随距离缩放，量纲保持一致。
    let scale = Math.hypot(shoulderMid[0] - hipMid[0], shoulderMid[1] - hipMid[1]);
    if (visHip < this.minTorsoVis) {
      const shoulderW = Math.hypot(
        P('shoulder_L')[0] - P('shoulder_R')[0],
        P('shoulder_L')[1] - P('shoulder_R')[1],
      );
      if (shoulderW > 5) scale = shoulderW * this.shoulderToTorso;
      else if (this.lastScale > 0) scale = this.lastScale;
    } else if (scale > 5) {
      this.lastScale = scale;
    }
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

    // 直立度：优先用躯干轴（髋中点→肩中点），四点都得够可见（单点飘了，中点就在乱动）。
    // 上半身构图里髋不可见时退回「鼻尖→肩中点」：直立/端坐时鼻在肩上方，躺卧时两者接近水平，
    // 与躯干轴同向、同量纲。两条轴各自滤波，切换时不会出现台阶。
    const tvx = shoulderMid[0] - hipMid[0];
    const tvy = shoulderMid[1] - hipMid[1];
    const tlen2 = Math.hypot(tvx, tvy) || 1;
    let up2d = NaN;
    let upSource = 'none';
    if (visTorso >= VIS_MIN) {
      up2d = this.upFilter2.filter(-tvy / tlen2, tSec);
      upSource = 'torso';
    } else if (visShoulder >= VIS_MIN && V('nose') >= VIS_MIN) {
      const nx = nose[0] - shoulderMid[0];
      const ny = nose[1] - shoulderMid[1];
      const nl = Math.hypot(nx, ny) || 1;
      up2d = this.upFilterHead2.filter(-ny / nl, tSec);
      upSource = 'head';
    }
    let up3d = NaN;
    if (w3 && visTorso >= VIS_MIN) {
      if (torsoW) {
        const tlen3 = v3norm(torsoW) || 1;
        // 3D：躯干单位向量与重力轴（world −y，即 [0,-1,0]）的点积
        const raw = -(torsoW[0] * GRAVITY_DOWN[0] + torsoW[1] * GRAVITY_DOWN[1]
          + torsoW[2] * GRAVITY_DOWN[2]) / tlen3;
        if (Number.isFinite(raw)) up3d = this.upFilter3.filter(raw, tSec);
      }
    }
    // 注意：上半身退路只用 2D 的鼻→肩轴，不做 3D 版本。
    // 鼻尖在 3D 里明显位于肩平面之前（脸向前突出约 0.1m），世界坐标的「鼻→肩」向量
    // 天然带一个大 z 分量，点积会系统性偏低（实测直立人只有 0.62），比 2D 更不能代表直立度。
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
    // 2D 角同样要过可见性门控：看不见的点算出来的角度是垃圾（滤波又会把上一次的值留住），
    // 之前只有 3D 分支检查，结果「腿被桌子挡住」也能凑出一个膝角，姿态层据此判下蹲。
    const visAngle2d = {
      knee_L: visTri(['hip_L', 'knee_L', 'ankle_L']),
      knee_R: visTri(['hip_R', 'knee_R', 'ankle_R']),
      elbow_L: visTri(['shoulder_L', 'elbow_L', 'wrist_L']),
      elbow_R: visTri(['shoulder_R', 'elbow_R', 'wrist_R']),
      hip_L: visTri(['shoulder_L', 'hip_L', 'knee_L']),
      hip_R: visTri(['shoulder_R', 'hip_R', 'knee_R']),
    };
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
      // 2D：三点都够可见才算；否则给 NaN（滤波器喂 NaN 不会污染历史）
      const ok2d = visAngle2d[k];
      const a2 = this._smoothAngle(`2d:${k}`, ok2d ? raw2d[k] : NaN, tSec);
      angles2d[k] = ok2d ? a2 : NaN;
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

    // 膝角/肘角：只在「角度有效」的一侧里挑可见性最高的；选中的那侧无效就退回另一侧。
    // 带滞回：上一帧选中的一侧仍然有效时，另一侧要明显更可信（≥ sideHysteresis）才换。
    // 不设滞回时，两侧可见性在 0.7/0.72 之间抖动会让角度在两条腿之间来回跳。
    // （深蹲/俯卧撑计数下线后，换侧不再触发「中止半程」；选侧只影响后续信号。）
    const pickSide = (l, r, visL, visR, prevSide = null) => {
      const cand = [
        { side: 'L', v: l, vis: visL },
        { side: 'R', v: r, vis: visR },
      ].filter((c) => Number.isFinite(c.v));
      if (!cand.length) return { side: prevSide || 'L', v: NaN, vis: 0 };
      let best = cand[0];
      for (const c of cand) if (c.vis > best.vis) best = c;
      const prev = prevSide ? cand.find((c) => c.side === prevSide) : null;
      if (prev && best.side !== prev.side && best.vis - prev.vis < this.sideHyst) return prev;
      return best;
    };

    const kneeVisL = visOf(['hip_L', 'knee_L', 'ankle_L']);
    const kneeVisR = visOf(['hip_R', 'knee_R', 'ankle_R']);
    const elbowVisL = visOf(['shoulder_L', 'elbow_L', 'wrist_L']);
    const elbowVisR = visOf(['shoulder_R', 'elbow_R', 'wrist_R']);

    const kneeSel = pickSide(angles.knee_L, angles.knee_R, kneeVisL, kneeVisR, this.prevKneeSide);
    const elbowSel = pickSide(angles.elbow_L, angles.elbow_R, elbowVisL, elbowVisR, this.prevElbowSide);
    const kneeSide = kneeSel.side;
    const kneePick = kneeSel.v;
    const elbowSide = elbowSel.side;
    const elbowPick = elbowSel.v;
    // 诊断用的 2D/3D 版本必须跟随判定侧，否则导出的 knee_2d 可能来自另一条腿，
    // signal-compare / 阈值拟合会把两条腿的分布混在一起。
    // 判定侧在这一信号上没有值（例如 2D 角被判坏点）时才退回 pickSide 的独立选择。
    const sameSideKey = (side, key) => (side === 'L' ? `${key}_L` : `${key}_R`);
    const pickDiag = (side, pick, key, visL, visR, prev) => {
      const own = pick[sameSideKey(side, key)];
      if (Number.isFinite(own)) return own;
      return pickSide(pick[`${key}_L`], pick[`${key}_R`], visL, visR, prev).v;
    };
    const kneePick2d = pickDiag(kneeSide, angles2d, 'knee', kneeVisL, kneeVisR, this.prevKneeSide);
    const kneePick3d = pickDiag(kneeSide, angles3d, 'knee', kneeVisL, kneeVisR, this.prevKneeSide);
    const elbowPick2d = pickDiag(elbowSide, angles2d, 'elbow', elbowVisL, elbowVisR, this.prevElbowSide);
    const elbowPick3d = pickDiag(elbowSide, angles3d, 'elbow', elbowVisL, elbowVisR, this.prevElbowSide);
    this.prevKneeSide = kneeSide;
    this.prevElbowSide = elbowSide;

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
    const raised3dL = raisedTorso(elevTorsoL);
    const raised3dR = raisedTorso(elevTorsoR);
    // 逐侧、逐信号回退（docs/signals.md §一·五 规则 2）：
    // 3D 本帧有效就听 3D（俯拍时 2D 会把「前伸」当「举起」）；
    // 只有本帧 3D 无效（NaN：没有 world / 该侧世界点缺失 / 骨骼判不可靠）才退回 2D。
    const raisedSelL = Number.isFinite(elevTorsoL) ? raised3dL : raisedL;
    const raisedSelR = Number.isFinite(elevTorsoR) ? raised3dR : raisedR;

    // —— 操作设备（阀门/仪表）——
    // 判据是「手在设备区域 + 肩以下 + 臂没有自然垂着」。设备区域优先用检测器给出的
    // panel/valve/gauge 框（点到框边的距离），本帧没有框时退回 profile 里人工圈的
    // 归一化 ROI。两者都没有就不判：只剩「伸手」会把拿东西/扶栏杆算成操作。
    const opCfg = C.arm.operating;
    const frameW = Number(person.frame_w);
    const frameH = Number(person.frame_h);
    const hasFrame = frameW > 0 && frameH > 0;
    // 设备区域：构造时解析，逐帧只做归一化→像素。rois 非空时旧 roi 完全不参与。
    const regionCfg = this.regions;
    const pixelZones = (regionCfg.mode === 'polygon' && regionCfg.valid && hasFrame)
      ? scaleZones(regionCfg.normalizedZones, frameW, frameH) : [];
    const rectPx = (regionCfg.mode === 'rect' && regionCfg.valid && hasFrame)
      ? [
        regionCfg.rect.x * frameW, regionCfg.rect.y * frameH,
        (regionCfg.rect.x + regionCfg.rect.w) * frameW,
        (regionCfg.rect.y + regionCfg.rect.h) * frameH,
      ] : null;
    const roiUsable = regionCfg.mode === 'polygon' ? pixelZones.length > 0
      : (regionCfg.mode === 'rect' && !!rectPx);
    const inRect = (x, y) => !!rectPx && x >= rectPx[0] && x <= rectPx[2]
      && y >= rectPx[1] && y <= rectPx[3];
    // —— 设备检测框（可选）：有框时优先用「点到框的距离」，ROI 只作兜底 ——
    // 没有阀门/仪表模型时 equipmentLabels 为空，行为与旧版完全一致。
    const eqLabels = new Set((opCfg.equipmentLabels || [])
      .map((s) => String(s).toLowerCase()));
    const eqBoxes = (Array.isArray(objects) ? objects : [])
      .filter((o) => o && Array.isArray(o.box) && o.box.length >= 4
        && eqLabels.has(String(o.label ?? '').toLowerCase())
        && (o.score ?? 0) >= (opCfg.equipmentMinScore ?? 0.35))
      .map((o) => o.box);
    const hasEquipmentBox = eqBoxes.length > 0;
    // 配了设备类别但本帧没框时是否退回 ROI。false = 没有物体证据就不判（fail-closed）。
    const eqFallback = opCfg.equipmentFallbackRoi !== false;
    // 本帧到底有没有「设备证据」：检测框，或（允许时）可用的 ROI
    const hasEquipEvidence = hasEquipmentBox || (eqFallback && roiUsable);
    const eqMaxDist = (opCfg.equipmentMaxDist ?? 0.35) * scale;
    const distToBox = (x, y, b) => {
      const dx = x < b[0] ? b[0] - x : x > b[2] ? x - b[2] : 0;
      const dy = y < b[1] ? b[1] - y : y > b[3] ? y - b[3] : 0;
      return Math.hypot(dx, dy);
    };
    // 返回 {near, zone}：zone 只在多边形 ROI 命中时有值（矩形保持旧语义，不给假 id）。
    const pointNearEquipment = (x, y) => {
      if (hasEquipmentBox) return { near: eqBoxes.some((b) => distToBox(x, y, b) <= eqMaxDist), zone: null };
      if (!eqFallback) return { near: false, zone: null };
      if (regionCfg.mode === 'rect') return { near: inRect(x, y), zone: null };
      if (regionCfg.mode === 'polygon') {
        const z = pointInAnyZone(x, y, pixelZones);
        return { near: !!z, zone: z ? z.id : null };
      }
      return { near: false, zone: null };
    };
    const opSide = (wr, reachVal, elevVal, headNear, usable) => {
      const near = pointNearEquipment(wr[0], wr[1]);
      const ok = usable
        && visShoulder >= opCfg.minShoulderVis
        && !headNear
        && Number.isFinite(reachVal) && reachVal >= opCfg.minReachRoi
        && Number.isFinite(elevVal) && elevVal >= opCfg.minElev && elevVal <= opCfg.maxElev
        && near.near;
      // zone 只在真正成立时上报：否则「手在 zone 里但抬臂角不满足」会把诊断带偏。
      return { ok, zone: ok ? near.zone : null };
    };
    // 没有设备 ROI/检测框就不判：只剩「伸手」会把拿东西/扶栏杆误报成操作设备
    const opL = hasEquipEvidence
      ? opSide(wristL, reachL, elevL, headNearL, armUsableL) : { ok: false, zone: null };
    const opR = hasEquipEvidence
      ? opSide(wristR, reachR, elevR, headNearR, armUsableR) : { ok: false, zone: null };
    const operatingL = opL.ok;
    const operatingR = opR.ok;
    // 手被设备挡住时的兜底：肘在 ROI/检测框内、离肩够远、不是垂在身侧。
    // 肘比「整个人框在 ROI 里」更接近手臂在设备上，误报低得多。
    const opElbowSide = (elbow, elbowVis, sh) => {
      const near = pointNearEquipment(elbow[0], elbow[1]);
      const ok = elbowVis >= opCfg.minElbowVis
        && visShoulder >= opCfg.minShoulderVis
        && Number.isFinite(d2(elbow, sh)) && d2(elbow, sh) / scale >= opCfg.minElbowReach
        && Number.isFinite(elev(sh, elbow)) && elev(sh, elbow) >= opCfg.minElbowElev
        && elev(sh, elbow) <= opCfg.maxElev
        && near.near;
      return { ok, zone: ok ? near.zone : null };
    };
    const opElbowL = hasEquipEvidence
      ? opElbowSide(P('elbow_L'), V('elbow_L'), shL) : { ok: false, zone: null };
    const opElbowR = hasEquipEvidence
      ? opElbowSide(P('elbow_R'), V('elbow_R'), shR) : { ok: false, zone: null };
    const operatingElbowL = opElbowL.ok;
    const operatingElbowR = opElbowR.ok;
    const operatingAny = operatingL || operatingR || operatingElbowL || operatingElbowR;
    // 诊断：第一个命中的 zone；用设备框或矩形 ROI 时为 null。
    const operatingRoiZone = opL.zone || opR.zone || opElbowL.zone || opElbowR.zone || null;

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
    // 腕必须在肩高度附近：3D 方位角/抬臂角在走路时噪声很大，单看 3D 会把自然摆臂
    // 算成「前平举」（实测走路样例 41/60 帧误报）。自然下垂时腕在髋旁，约 1 个躯干长低于肩，
    // 这道 2D 物理门便宜且稳，和 3D 判据是互补关系而不是重复。
    const wristAtShoulder = (sh, wr) => wr[1] < sh[1] + 0.4 * scale;
    // 手臂要基本伸直：弯着胳膊横在胸前时 3D 方位角也像「平举」，但腕-肩距离只有 0.5~0.8。
    // 这里有 world 就用 3D 比值（前伸会 2D 透视缩短，2D 会把真平举也挡掉）。
    const reachForArm = (r3, r2) => (Number.isFinite(r3) ? r3 : r2);
    const armStraight = (side) => reachForArm(
      side === 'L' ? reach3dL : reach3dR,
      side === 'L' ? reachL : reachR,
    ) > azimCfg.minReach;
    const armFrontL = horizontal(elevTorsoL) && Math.abs(azimL) < azimCfg.frontMax
      && wristAtShoulder(shL, wristL) && armStraight('L');
    const armFrontR = horizontal(elevTorsoR) && Math.abs(azimR) < azimCfg.frontMax
      && wristAtShoulder(shR, wristR) && armStraight('R');
    const armSideL = horizontal(elevTorsoL) && Math.abs(azimL) > azimCfg.sideMin
      && wristAtShoulder(shL, wristL) && armStraight('L');
    const armSideR = horizontal(elevTorsoR) && Math.abs(azimR) > azimCfg.sideMin
      && wristAtShoulder(shR, wristR) && armStraight('R');

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
    // 髋不可见时髋点全是模型猜的，腕到「髋」的距离没有意义，直接不判叉腰。
    const onHips = wristsVisible && visHip >= VIS_MIN
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
    // 鼓掌门控：两腕在肩与髋之间（胸前），否则头顶合手也会被算。
    // 髋不可见时把「髋」放到肩下方一个躯干长处（scale 的几何定义），门控仍然成立。
    const ch = C.arm.chest;
    const hipY = visHip >= VIS_MIN ? hipMid[1] : shoulderMid[1] + scale;
    const chestHeight = wristsVisible
      && wristL[1] > shoulderMid[1] + ch.above * scale
      && wristL[1] < hipY + ch.below * scale
      && wristR[1] > shoulderMid[1] + ch.above * scale
      && wristR[1] < hipY + ch.below * scale;

    // 下半身是否足以判站/坐：膝角与腿竖直比都要有值（两者都隐含膝/踝可见）。
    const legsVisible = Number.isFinite(kneePick) && Number.isFinite(legVertical);
    // 只有上半身可用：肩、髋都可信（躯干轴成立），但膝/踝不足。
    // 这是「上半身直立/前倾」的唯一依据——没有髋就不猜躯干朝向（见 actions.buildPostures）。
    // 几何门：上半身框通常高于宽；横着的框多半是手臂/设备特写被模型凑成了人。
    // bbox 缺失（手搓信号/旧数据）时不设门，保持纯逻辑可测。
    const bb = person.bbox;
    const bh = Array.isArray(bb) && bb.length >= 4 ? bb[3] - bb[1] : NaN;
    const bw = Array.isArray(bb) && bb.length >= 4 ? bb[2] - bb[0] : NaN;
    const uprightBox = !(bw > 0 && bh > 0)
      || bh >= bw * C.upperBody.minAspect;
    const upperBody = Number.isFinite(uprightness)
      && visShoulder >= this.minTorsoVis
      && visHip >= VIS_MIN
      && !legsVisible
      && uprightBox;

    const score = person.score ?? 0;

    // —— 在设备旁（上下文事件）——
    // 人体框落在设备区域（检测框或 ROI，取重叠较大者）里的面积比例。只回答
    // 「人在设备区域里」，不要求手在设备上；和 operating 分开，避免把「站在旁边」
    // 直接算成「在操作」。
    const nearCfg = C.arm.nearEquipment;
    const nearValidity = personBoxValidity(
      person.bbox, frameW, frameH, visShoulder, visTorso, nearCfg.validity || {},
    );
    let nearEquipmentZone = null;
    let nearEquipmentSource = null;
    const nearOverlap = (() => {
      if (!Array.isArray(person.bbox) || person.bbox.length < 4) return NaN;
      const [x1, y1, x2, y2] = person.bbox;
      const area = Math.max(0, (x2 - x1) * (y2 - y1));
      if (!(area > 0)) return 0;
      const overlap = (b) => {
        const iw = Math.max(0, Math.min(x2, b[2]) - Math.max(x1, b[0]));
        const ih = Math.max(0, Math.min(y2, b[3]) - Math.max(y1, b[1]));
        return (iw * ih) / area;
      };
      const boxOverlap = hasEquipmentBox ? Math.max(...eqBoxes.map(overlap)) : NaN;
      // ROI 只在允许兜底、且知道帧尺寸时参与。fail-closed（equipmentFallbackRoi=false）
      // 时 ROI 完全不参与——这正是硬负例里「人走过 ROI 但没有任何设备框」不判的开关。
      let roiOverlap = NaN;
      let roiZone = null;
      let roiSource = null;
      if (eqFallback && hasFrame) {
        if (regionCfg.mode === 'rect' && rectPx) {
          roiOverlap = overlap(rectPx);
          roiSource = 'rect';
        } else if (regionCfg.mode === 'polygon' && pixelZones.length) {
          // 多边形用精确的「人体框 ∩ 多边形 / 人体框面积」，多 zone 取最大。
          const m = maxZoneOverlap([x1, y1, x2, y2], pixelZones);
          roiOverlap = m.ratio;
          roiZone = m.zone_id;
          roiSource = 'polygon';
        }
      }
      // 取两者的较大值（union），而不是「有框就只看框」：检测框只框住设备本体，
      // 人站在面板前时人体框与设备框的重叠常常远小于与 ROI 的重叠（refuel 实测
      // 50% 阈值下从 3/6 掉到 1/6）。fail-closed 时只有 boxOverlap。
      const cands = [boxOverlap, roiOverlap].filter((v) => Number.isFinite(v));
      if (!cands.length) return NaN;
      const best = Math.max(...cands);
      // 并列时优先标 equipment（设备框是更强的物体证据）。
      if (Number.isFinite(boxOverlap) && boxOverlap >= best - 1e-12) {
        nearEquipmentSource = 'equipment';
        nearEquipmentZone = null;
      } else {
        nearEquipmentSource = roiSource;
        nearEquipmentZone = roiZone;
      }
      return best;
    })();
    const nearEquipmentOn = Number.isFinite(nearOverlap)
      && nearOverlap >= nearCfg.minOverlap
      && visShoulder >= nearCfg.minShoulderVis
      && score >= this.minScore
      && (!nearCfg.requireUprightBox || uprightBox)
      && nearValidity.ok;

    // 有效锚点：肩必须在画面里；髋可见时也要求可信。
    // 上半身构图里髋在画面外，不能因为髋不可见就把整帧判成无效——那会让动作层一直冻结
    // （实测头~胸构图髋可见性≈0.15 → ok=false → 举手/挥手/抱臂全部不输出）。
    const visAnchor = visHip >= this.minTorsoVis ? visTorso : visShoulder;

    return {
      ts,
      ok: score >= this.minScore && visAnchor >= this.minTorsoVis,
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
      // 直立度用的是哪条轴：torso=躯干轴，head=鼻→肩（上半身构图），none=不可用
      uprightness_source: upSource,
      // 下半身证据是否足够；false 时站/坐不可判（但上半身朝向仍可判）
      legs_visible: legsVisible,
      // 肩+髋可信、膝/踝不足：动作层据此输出「上半身直立/前倾」，不冒充站/坐
      upper_body: upperBody,
      // 分组可见性：界面据此提示「下半身不在画面内」，不用再猜为什么没姿态
      vis: {
        shoulder: visShoulder, hip: visHip,
        knee: Math.min(V('knee_L'), V('knee_R')),
        ankle: visAnkle, nose: V('nose'),
      },
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
      // 本帧因角速度过大被剔除的角度名；动作层据此标 unreliable=angle_outlier
      angle_outliers: this.angleRejected.slice(),
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
        // 3D 版举手（只有 world 可用时有效，NaN 时 false）
        raised3d_L: raised3dL,
        raised3d_R: raised3dR,
        any_raised3d: raised3dL || raised3dR,
        // 判定用：逐侧「3D 有效用 3D，否则退回 2D」。
        // 动作层用这两个字段，不再只看 has_world（world 在、但某侧世界点坏掉时会漏判举手）。
        raised_sel_L: raisedSelL,
        raised_sel_R: raisedSelR,
        any_raised_sel: raisedSelL || raisedSelR,
        head_near_L: headNearL,
        head_near_R: headNearR,
        // 操作设备：手在设备 ROI 内，或肘在 ROI 内（手被设备挡住时的兜底）
        operating_L: operatingL,
        operating_R: operatingR,
        operating_elbow_L: operatingElbowL,
        operating_elbow_R: operatingElbowR,
        operating_any: operatingAny,
        // 在设备旁（上下文）：人体框与设备框/ROI 的重叠比例（取较大值） / 是否成立
        near_equipment: nearEquipmentOn,
        near_equipment_overlap: nearOverlap,
        // 多边形 ROI 的诊断：命中的 zone / 重叠最大的 zone / 证据来源
        operating_roi_zone_L: opL.zone,
        operating_roi_zone_R: opR.zone,
        operating_elbow_zone_L: opElbowL.zone,
        operating_elbow_zone_R: opElbowR.zone,
        operating_roi_zone: operatingRoiZone,
        near_equipment_zone: nearEquipmentZone,
        near_equipment_source: nearEquipmentSource,
        near_equipment_validity: nearValidity && nearValidity.enabled ? nearValidity : null,
        // 本帧的 operating 是否有设备检测框参与（诊断用；没有框时退回 ROI）
        operating_equipment: hasEquipmentBox,
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
        // 操作设备是否配置了可用设备 ROI（未配置时动作层不可用，界面据此标「不可用」）
        // mode/zones 供诊断：polygon 的 rois 全部非法时为 none/0。
        operating_roi: regionCfg.valid,
        operating_roi_mode: regionCfg.mode,
        operating_roi_zones: regionCfg.mode === 'polygon'
          ? regionCfg.normalizedZones.length : (regionCfg.mode === 'rect' ? 1 : 0),
        azimuth_L: azimL,
        azimuth_R: azimR,
        arm_front_L: armFrontL,
        arm_front_R: armFrontR,
        arm_side_L: armSideL,
        arm_side_R: armSideR,
        ratio_source: useRatios ? '3d-if-available' : '2d',
      },
      // 挥手：左右各自一份翻转次数与幅度。判定必须把「翻转」和「幅度」绑到同一条举起的臂，
      // 只取 max(amp) 会让「左手举着不动、右手在髋旁摆动」凑成挥手。
      wave: {
        L: waveL.flips, R: waveR.flips,
        amp: Math.max(waveL.amp, waveR.amp),
        amp_L: waveL.amp, amp_R: waveR.amp,
      },
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
