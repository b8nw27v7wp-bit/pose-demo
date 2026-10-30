// handshape.js — 手势分类（纯函数，只吃 21 个点，Node 里可直接单测）
// 21 点顺序（MediaPipe Hand）：0 腕 / 1-4 拇指 / 5-8 食指 / 9-12 中指 / 13-16 无名指 / 17-20 小指

import { angleDeg } from './signals.js';

// 每根手指的 [mcp, pip, dip, tip]
export const FINGERS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

export const SHAPE_LABELS = {
  fist: '握拳',
  open: '张开',
  victory: '剪刀手',
  pointing: '指方向',
  thumbs_up: '竖拇指',
  ok: 'OK',
  gun: '手枪',
  rock: '摇滚',
  unknown: '—',
};

// 可被标注/评估的手势（去掉表示「判不出」的 unknown）。
// 评估器的 labels 校验从这里派生，新增手势只需改 SHAPE_LABELS。
export const SHAPE_IDS = Object.keys(SHAPE_LABELS).filter((k) => k !== 'unknown');

/**
 * 手势去抖：连续 N 帧命中同一手势才切换。
 * 没有它，「张开」和「剪刀手」在阈值附近会来回闪（PLAN §12.1 的「手势偶尔串」就是它）。
 * 当前手势持续命中时保持；出现新的稳定手势才切换；判不出来时保留上一结果若干帧再清空。
 */
export class HandShapeStabilizer {
  constructor({ streak = 3, keepMs = 250 } = {}) {
    this.streak = streak;
    this.keepMs = keepMs;
    this.last = 'unknown';
    this.candidate = null;
    this.candidateCount = 0;
    this.lastSeenTs = 0;
  }

  update(shape, ts) {
    if (shape && shape !== 'unknown') {
      if (shape === this.last) {
        this.candidate = null;
        this.candidateCount = 0;
        this.lastSeenTs = ts;
        return this.last;
      }
      if (shape === this.candidate) this.candidateCount++;
      else { this.candidate = shape; this.candidateCount = 1; }

      if (this.candidateCount >= this.streak) {
        this.last = shape;
        this.candidate = null;
        this.candidateCount = 0;
        this.lastSeenTs = ts;
      }
      return this.last;
    }

    // 判不出来：中断候选计数。streak 必须是**连续**命中，
    // 否则 unknown 隔开的零散误判也能凑满（victory,victory,unknown,victory 就会切换）。
    this.candidate = null;
    this.candidateCount = 0;
    // 但短时间内保留上一次结果（手转个角度不该让面板闪成「—」）
    if (this.last !== 'unknown' && ts - this.lastSeenTs > this.keepMs) {
      this.last = 'unknown';
    }
    return this.last;
  }

  reset() {
    this.last = 'unknown';
    this.candidate = null;
    this.candidateCount = 0;
    this.lastSeenTs = 0;
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * 手指伸展：PIP 处夹角 > 150° 且指尖比 PIP 更远离腕。
 * 两个条件都要 —— 只用角度时，手背朝镜头会把弯曲判成伸直；只用距离时，手指斜指也会误判。
 */
function fingerExtended(kp, idxs) {
  const [, pip, , tip] = idxs;
  const a = angleDeg(kp[idxs[0]], kp[pip], kp[tip]);
  const dTip = dist(kp[tip], kp[0]);
  const dPip = dist(kp[pip], kp[0]);
  return Number.isFinite(a) && a > 150 && dTip > dPip * 1.12;
}

/** 拇指方向与四指不同，用 IP 处夹角 + 指尖离食指 MCP 的张开度判定。 */
function thumbExtended(kp, scale) {
  const a = angleDeg(kp[2], kp[3], kp[4]);
  const spread = dist(kp[4], kp[5]) / scale;
  return Number.isFinite(a) && a > 145 && spread > 0.55;
}

/**
 * @param {number[][]} kp 21 个点（像素坐标，内部按手的尺度归一）
 * @returns {{shape:string, label:string, fingers:Object, pinch:number, score:number}}
 */
export function classifyHand(kp) {
  if (!kp || kp.length < 21) {
    return { shape: 'unknown', label: SHAPE_LABELS.unknown, fingers: {}, pinch: NaN, score: 0 };
  }

  const scale = dist(kp[0], kp[9]) || 1;
  const ext = {
    thumb: thumbExtended(kp, scale),
    index: fingerExtended(kp, FINGERS.index),
    middle: fingerExtended(kp, FINGERS.middle),
    ring: fingerExtended(kp, FINGERS.ring),
    pinky: fingerExtended(kp, FINGERS.pinky),
  };
  const four = [ext.index, ext.middle, ext.ring, ext.pinky];
  const extendedCount = four.filter(Boolean).length;

  const pinch = dist(kp[4], kp[8]) / scale;          // 拇指尖 ↔ 食指尖
  const thumbUp = (kp[0][1] - kp[4][1]) / scale;     // 拇指尖比腕高多少（y 越小越高）

  let shape = 'unknown';
  if (pinch < 0.45 && ext.middle && ext.ring && ext.pinky) shape = 'ok';
  else if (ext.thumb && extendedCount === 0 && thumbUp > 0.35) shape = 'thumbs_up';
  else if (ext.index && ext.middle && !ext.ring && !ext.pinky) shape = 'victory';
  // 手枪：拇指 + 食指伸，其余三指弯（比「只有食指」好认，且是和 thumbs_up 区分开的）
  else if (ext.thumb && ext.index && !ext.middle && !ext.ring && !ext.pinky) shape = 'gun';
  // 摇滚：食指 + 小指伸，中指无名指弯
  else if (ext.index && !ext.middle && !ext.ring && ext.pinky) shape = 'rock';
  else if (ext.index && !ext.middle && !ext.ring && !ext.pinky) shape = 'pointing';
  else if (extendedCount === 0 && !ext.thumb) shape = 'fist';
  else if (extendedCount >= 4) shape = 'open';

  // 置信度：分类规则越"干净"越高，UI 用它灰显不可靠结果
  const clean = {
    fist: extendedCount === 0 && !ext.thumb,
    open: extendedCount >= 4,
    victory: ext.index && ext.middle && !ext.ring && !ext.pinky,
    pointing: ext.index && !ext.middle && !ext.ring && !ext.pinky,
    thumbs_up: ext.thumb && extendedCount === 0,
    ok: pinch < 0.45,
    gun: ext.thumb && ext.index && !ext.middle && !ext.ring && !ext.pinky,
    rock: ext.index && !ext.middle && !ext.ring && ext.pinky,
  }[shape];

  return { shape, label: SHAPE_LABELS[shape], fingers: ext, pinch, score: clean ? 1 : 0.5 };
}
