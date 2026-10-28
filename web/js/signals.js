// signals.js — L2 信号层
// 职责：把坐标变成**时间序列信号**（角度、比值、振荡），并做平滑与去抖。
// 这一层是"通用"的关键：动作判定只认这里的信号，不直接碰关键点。
// 定义与阈值说明见 docs/signals.md（那份文档是唯一真相）。

import { KPT, IDX } from './kpt.js';

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

/** 关键点滤波器组：每个点两个一维滤波器（x/y）。 */
class KpFilter {
  constructor(opts) {
    this.opts = opts;
    this.fx = {}; this.fy = {};
  }

  run(kp, tSec) {
    return kp.map(([x, y, v], i) => {
      const name = KPT[i];
      if (!this.fx[name]) { this.fx[name] = new OneEuro(this.opts); this.fy[name] = new OneEuro(this.opts); }
      if (v < 0.3) {
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
  constructor({ minCutoff = 1.0, beta = 0.05, angleCutoff = 1.5, angleBeta = 0.02 } = {}) {
    this.kpFilter = new KpFilter({ minCutoff, beta });
    this.angleOpts = { minCutoff: angleCutoff, beta: angleBeta };
    this.angleFilters = {};
    this.scaleWin = new MedianWindow(5);
    this.upFilter = new OneEuro({ minCutoff: 1.5, beta: 0.02 });
    this.wristHist = { L: [], R: [] };
    this.minScore = 0.45;
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
    const kp = this.kpFilter.run(person.kp, tSec);
    const P = (name) => kp[IDX[name]];
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    // 可见性门控：不可见的点算出来的几何量是垃圾，必须给 NaN（NaN 参与比较恒为 false）
    const V = (name) => P(name)[2] ?? 0;
    const VIS_MIN = 0.3;
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
    const raisedL = visWristL >= VIS_MIN && P('wrist_L')[1] < P('shoulder_L')[1] - 0.15 * scale;
    const raisedR = visWristR >= VIS_MIN && P('wrist_R')[1] < P('shoulder_R')[1] - 0.15 * scale;

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

    // 抱臂：两腕的左右顺序相对肩膀翻转（用顺序而不是固定符号，人转身背对镜头也成立）
    const shOrder = Math.sign(shL[0] - shR[0]) || 1;
    const wrOrder = Math.sign(wristL[0] - wristR[0]) || 1;
    const wristsVisible = visWristL >= VIS_MIN && visWristR >= VIS_MIN;
    const crossed = wristsVisible
      && wrOrder !== shOrder
      && Math.abs(wristL[1] - shoulderMid[1]) < 1.1 * scale
      && Math.abs(wristR[1] - shoulderMid[1]) < 1.1 * scale;
    // 叉腰：两腕各自贴近同侧髋
    const onHips = wristsVisible
      && d2(wristL, hipL) < 0.65 * scale && d2(wristR, hipR) < 0.65 * scale;
    // 张开双臂：两侧都接近水平且伸得够远
    const armsOpen = Number.isFinite(elevL) && Number.isFinite(elevR)
      && elevL > 55 && elevL < 125 && elevR > 55 && elevR < 125
      && reachL > 0.9 && reachR > 0.9;
    // 鼓掌门控：两腕在肩与髋之间（胸前），否则头顶合手也会被算
    const chestHeight = wristsVisible
      && wristL[1] > shoulderMid[1] - 0.2 * scale
      && wristL[1] < hipMid[1] + 0.3 * scale
      && wristR[1] > shoulderMid[1] - 0.2 * scale
      && wristR[1] < hipMid[1] + 0.3 * scale;

    const score = person.score ?? 0;

    return {
      ts,
      ok: score >= this.minScore && visTorso >= 0.4,
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
      },
      armPose: {
        elev_L: elevL,
        elev_R: elevR,
        reach_L: reachL,
        reach_R: reachR,
        hands_close: handsClose,
        crossed,
        on_hips: onHips,
        open_wide: armsOpen,
        chest_height: chestHeight,
      },
      wave: { L: waveL.flips, R: waveR.flips, amp: Math.max(waveL.amp, waveR.amp) },
    };
  }

  _oscillation(side, xNorm, ts) {
    const h = this.wristHist[side];
    if (!Number.isFinite(xNorm)) {
      // 腕不可见：清空窗口并报告"没在挥"，不要拿旧数据继续判
      h.length = 0;
      return { flips: 0, amp: 0 };
    }
    h.push([ts, xNorm]);
    while (h.length && ts - h[0][0] > 800) h.shift();

    let flips = 0;
    let lastSign = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < h.length; i++) {
      min = Math.min(min, h[i][1]);
      max = Math.max(max, h[i][1]);
      if (i === 0) continue;
      const dx = h[i][1] - h[i - 1][1];
      if (Math.abs(dx) < 0.10) continue;        // 死区：滤掉关键点微抖
      const s = Math.sign(dx);
      if (lastSign !== 0 && s !== lastSign) flips++;
      lastSign = s;
    }
    return { flips, amp: Number.isFinite(min) ? max - min : 0 };
  }
}
