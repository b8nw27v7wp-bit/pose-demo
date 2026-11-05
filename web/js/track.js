// track.js — 多人跟踪：把每帧独立的检测框接成稳定的 track_id
//
// 为什么必须有这一层：MediaPipe PoseLandmarker 的 VIDEO 模式只返回一个人（实测 numPoses=2
// 也没用，见 README「已知限制」），多人只能走 IMAGE 模式逐帧独立推理，帧间没有任何关联。
// 没有 id，每个人的状态机（计数、滞回、持续时长、PPE 计时）就分不开——两个人先后走过画面
// 会被当成同一个人，计数直接串。所以 id 不是显示用的装饰，是判定正确性的前提。
//
// 纯函数 + 贪心匹配，不依赖浏览器：Node 里能直接单测（web/test/multi-test.mjs）。

/** 框面积 */
export function area(b) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/** 交并比。任一侧退化（宽或高为 0）时返回 0，不返回 NaN——NaN 会让排序静默失序。 */
export function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const iw = x2 - x1;
  const ih = y2 - y1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const uni = area(a) + area(b) - inter;
  return uni > 0 ? inter / uni : 0;
}

export function center(b) {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

export function height(b) {
  return Math.max(0, b[3] - b[1]);
}

/** 两个归一化描述子的余弦相似度（0~1；任一侧缺失/全零返回 0） */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** 外观描述子做 EMA，避免单帧颜色因遮挡/姿态突变 */
function blendDesc(oldD, newD) {
  if (!oldD || oldD.length !== newD.length) return newD;
  const out = new Float32Array(newD.length);
  for (let i = 0; i < out.length; i++) out[i] = oldD[i] * 0.5 + newD[i] * 0.5;
  return out;
}

/** 小规模最优分配（最多 6 条轨迹 × 4 个检测）：穷举 + 允许跳过，找总分最大的配对 */
export function optimalAssign(scores, n, m) {
  let best = null;
  let bestScore = -Infinity;
  const pick = new Array(n).fill(-1);
  const used = new Array(m).fill(false);
  const rec = (i, score) => {
    if (i === n) {
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = pick.slice();
      }
      return;
    }
    // 这条轨迹本帧不配对
    pick[i] = -1;
    rec(i + 1, score);
    // 或者配一个还没被占用的检测
    for (let d = 0; d < m; d++) {
      if (used[d] || scores[i][d] < 0) continue;
      used[d] = true;
      pick[i] = d;
      rec(i + 1, score + scores[i][d]);
      used[d] = false;
    }
    pick[i] = -1;
  };
  rec(0, 0);
  return best;
}

/**
 * 多人跟踪器（贪心匹配 + 可选匀速运动模型 / 外观重连）
 *
 * 匹配代价同时用三条线索，缺一条都会出错：
 * - IoU：同一个人相邻帧必然重叠，最可靠；快速移动时可能变 0。
 * - 中心距离（按人体高度归一化）：IoU 为 0 时的兜底。用"身高"而不是像素，才能跨远近通用。
 * - 匀速预测：用轨迹最近的速度把框外推到当前帧。两人交叉/遮挡时，只比当前位置会把
 *   左右两人配反；比"预测位置"才能跟住各自的方向（MOT17 上 ID 切换主要来自这里）。
 * 另外加一条身高校验：同一个人身高不会突然翻倍或减半，用它挡掉"两个人一前一后换 id"。
 */
export class Tracker {
  constructor({
    maxLostMs = 1500, iouMin = 0.25, centerMax = 0.6,
    sizeRatioMin = 0.6, sizeRatioMax = 1.67,
    // 运动模型：motion=false 时退回纯 IoU/中心距离（默认关，MOT17 实测会变差）
    motion = false, velAlpha = 0.5, maxPredictMs = 500, maxSpeed = 3,
    // 只有"这一帧间隔明显大于平时的匹配间隔"（漏检/遮挡）才启用预测
    motionGapRatio = 1.5,
    // 轻量外观 ReID：desc 由调用方从图像 bbox 算好（归一化颜色直方图）
    // 默认关：MOT17 6 序列 A/B 实测 on 比 off 多约 10 次 ID 切换（颜色直方图在拥挤/远景里
    // 不够判别，会把旧轨迹接到错的人身上）。只保留"丢失后重连"用法，profile 可显式打开。
    appearance = false, appearMin = 0.82, appearWeight = 0.5,
    // 分配算法：greedy（默认）或 optimal（≤6×4 时穷举最大总分配）
    assignment = 'greedy',
  } = {}) {
    this.maxLostMs = maxLostMs;
    this.iouMin = iouMin;
    this.centerMax = centerMax;
    this.sizeRatioMin = sizeRatioMin;
    this.sizeRatioMax = sizeRatioMax;
    this.motion = motion;
    this.velAlpha = velAlpha;
    this.maxPredictMs = maxPredictMs;
    this.maxSpeed = maxSpeed; // 人体高度/秒
    this.motionGapRatio = motionGapRatio;
    this.appearance = appearance;
    this.appearMin = appearMin;
    this.appearWeight = appearWeight;
    this.assignment = assignment;
    this.nextId = 1;
    this.tracks = new Map(); // id -> { id, bbox, center, vel, desc, lastTs, matchDt, hits, firstTs }
  }

  reset() {
    this.nextId = 1;
    this.tracks.clear();
  }

  /** 丢掉超时未见的轨迹：人离场后状态机不该永远占着内存，也不该在他回来时"续上"计数 */
  prune(ts) {
    for (const [id, t] of this.tracks) {
      if (ts - t.lastTs > this.maxLostMs) this.tracks.delete(id);
    }
  }

  /** 按速度把框外推到 ts（限制预测时长；丢失太久就不能再相信旧速度） */
  predicted(track, ts) {
    const b = track.bbox;
    if (!this.motion || !track.vel) return b;
    const dt = Math.max(0, Math.min(this.maxPredictMs, ts - track.lastTs));
    if (dt <= 0) return b;
    const dx = track.vel[0] * dt;
    const dy = track.vel[1] * dt;
    return [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
  }

  /** 用最近一次匹配的位移更新速度（EMA + 限速）；丢失太久时位移不可信，不更新 */
  updateVelocity(track, det, ts) {
    if (!this.motion) return;
    const dt = ts - track.lastTs;
    if (!(dt > 0) || dt > 500) return;
    const [cx, cy] = center(det.bbox);
    const [px, py] = track.center || center(track.bbox);
    let vx = (cx - px) / dt;
    let vy = (cy - py) / dt;
    const h = height(track.bbox);
    if (h > 0) {
      const maxV = (this.maxSpeed * h) / 1000; // 高度/秒 → px/ms
      const sp = Math.hypot(vx, vy);
      if (sp > maxV && sp > 0) {
        vx = (vx / sp) * maxV;
        vy = (vy / sp) * maxV;
      }
    }
    const a = Math.max(0, Math.min(1, this.velAlpha));
    track.vel = track.vel
      ? [track.vel[0] * (1 - a) + vx * a, track.vel[1] * (1 - a) + vy * a]
      : [vx, vy];
  }

  /** 这一帧是否算"漏检后的重新关联"（间隔明显大于平时） */
  motionActive(track, ts) {
    if (!this.motion || !track.vel) return false;
    const normal = track.matchDt || 100;
    return ts - track.lastTs > Math.max(120, normal * this.motionGapRatio);
  }

  /** 轨迹相似度：<0 表示不可匹配 */
  similarity(track, det, ts) {
    const a = track.bbox;
    const b = det.bbox;
    const ha = height(a);
    const hb = height(b);
    if (ha <= 0 || hb <= 0) return -1;
    const ratio = hb / ha;
    if (ratio < this.sizeRatioMin || ratio > this.sizeRatioMax) return -1;

    const useMotion = this.motionActive(track, ts);
    const pred = useMotion ? this.predicted(track, ts) : a;
    const ovPred = iou(pred, b);
    const ovCur = iou(a, b);
    const ov = Math.max(ovCur, ovPred);
    // 外观只用于"丢失后的重新关联"，不参与正常帧的 IoU/中心打分：
    // 把颜色混进每一帧的匹配会扰动本来正确的 IoU 配对（MOT17 实测变差）。
    const hasApp = !!(this.appearance && track.desc && det.desc);
    const app = hasApp ? cosine(track.desc, det.desc) : 0;
    if (ov >= this.iouMin) {
      const motionBonus = useMotion && ovPred >= ovCur ? 0.3 : 0;
      return 1 + ov + motionBonus;
    }

    const [ax, ay] = center(a);
    const [px, py] = center(pred);
    const [bx, by] = center(b);
    const dist = Math.min(
      Math.hypot(ax - bx, ay - by),
      Math.hypot(px - bx, py - by),
    ) / ha; // 以身高为单位；当前中心与预测中心取近的那个
    if (dist <= this.centerMax) {
      return 1 - dist;
    }

    // 丢失后的外观重连：中心距离已经超出 gate，但颜色高度相似（例如被挡了几帧后
    // 从另一边出现）。限制在 maxLostMs 内，避免把很久以前的人硬接回来。
    if (hasApp && app >= this.appearMin
      && ts - track.lastTs <= this.maxLostMs) {
      return 0.5 + app;
    }
    return -1;
  }

  /**
   * @param {Array<{bbox:number[]}>} persons 本帧检测（无需 track_id）
   * @param {number} ts 毫秒时间戳
   * @returns {Array} 新数组，带 track_id / track_age_ms / is_new，按面积降序（第 0 个是最大的人）
   */
  update(persons, ts) {
    const dets = persons.filter((p) => p && Array.isArray(p.bbox) && area(p.bbox) > 0);
    const assigned = new Map(); // detIndex -> track

    // 全局贪心：所有 (轨迹, 检测) 配对按相似度从高到低分配。
    // 逐个轨迹各自取最优会在两人交叉时抢同一个框，换人更频繁。
    const trackList = [...this.tracks.values()];
    const scores = trackList.map(() => new Array(dets.length).fill(-1));
    const pairs = [];
    for (let ti = 0; ti < trackList.length; ti++) {
      for (let di = 0; di < dets.length; di++) {
        const s = this.similarity(trackList[ti], dets[di], ts);
        scores[ti][di] = s;
        if (s >= 0) pairs.push({ ti, di, s });
      }
    }
    if (this.assignment === 'optimal' && trackList.length <= 6 && dets.length <= 4) {
      // 小规模时穷举最大总分；贪心可能为了一个高分对牺牲两个正确对
      const pick = optimalAssign(scores, trackList.length, dets.length);
      for (let ti = 0; ti < pick.length; ti++) {
        if (pick[ti] >= 0) assigned.set(pick[ti], trackList[ti]);
      }
    } else {
      pairs.sort((a, b) => b.s - a.s);
      const takenTracks = new Set();
      for (const p of pairs) {
        if (takenTracks.has(p.ti) || assigned.has(p.di)) continue;
        takenTracks.add(p.ti);
        assigned.set(p.di, trackList[p.ti]);
      }
    }

    const out = [];
    for (let di = 0; di < dets.length; di++) {
      const det = dets[di];
      let tr = assigned.get(di);
      if (!tr) {
        tr = {
          id: this.nextId++, bbox: det.bbox, center: center(det.bbox),
          vel: null, desc: det.desc || null, lastTs: ts, hits: 0, firstTs: ts,
        };
        this.tracks.set(tr.id, tr);
      } else {
        // 先按"上一帧位置 → 本帧位置"更新速度，再覆盖位置
        this.updateVelocity(tr, det, ts);
        const gap = ts - tr.lastTs;
        // 记录平时的匹配间隔（漏检时的大间隔不拉高基线，否则下一次漏检就判不出来了）
        if (gap > 0 && gap <= (tr.matchDt || 100) * 3) {
          tr.matchDt = tr.matchDt ? tr.matchDt * 0.8 + gap * 0.2 : gap;
        }
        if (det.desc) tr.desc = tr.desc ? blendDesc(tr.desc, det.desc) : det.desc;
      }
      tr.bbox = det.bbox;
      tr.center = center(det.bbox);
      tr.hits += 1;
      tr.lastTs = ts;
      out.push({ ...det, track_id: tr.id, track_age_ms: Math.round(ts - tr.firstTs), is_new: tr.hits === 1 });
    }

    this.prune(ts);
    out.sort((a, b) => area(b.bbox) - area(a.bbox));
    return out;
  }
}
