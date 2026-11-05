// multi.js — 每人一条判定流水线
//
// 为什么要按 track_id 分实例：SignalEngine / ActionEngine 里全是**有记忆**的部件
// （One Euro 滤波器、Hold 计时、RepCounter 相位、换侧滞回）。两个人共用一套实例，
// A 的深蹲相位会被 B 的膝盖角度打断，计数和持续时长都会串。所以多人不是"循环调用
// 同一套引擎"，而是每人一份引擎。
//
// 纯逻辑（只 import signals/actions/track），Node 里可单测。

import { SignalEngine } from './signals.js';
import { ActionEngine } from './actions.js';
import { area } from './track.js';

/**
 * 把手部检测结果分给最近的人。
 *
 * 为什么必须分：手部模型是整帧跑的，返回的 21 点不带"这是谁的手"。不分的话，
 * 旁边那个人的握拳会被算进目标人的「拿取」阶段，两个人一起举手会互相触发。
 * 归属依据是手部 21 点的 wrist(0) 到该人左右腕关键点的距离，按躯干长归一化——
 * 用像素距离会在远近不同的人之间系统性地偏向离镜头近的那个。
 */
export function assignHands(persons, hands, { maxDist = 0.8 } = {}) {
  const out = new Map();
  for (const p of persons) {
    if (!p || !p.kp || !(p.scale > 0)) continue;
    out.set(p.track_id, { L: null, R: null, list: [] });
  }
  if (!Array.isArray(hands)) return out;

  for (const hd of hands) {
    if (!hd || !hd.kp || !hd.kp.length) continue;
    const [hx, hy] = hd.kp[0];
    let best = null;
    let bestD = Infinity;
    for (const p of persons) {
      if (!p.kp || !(p.scale > 0)) continue;
      // 3D 有效时腕点更准，但这里只需要屏幕上的位置，统一用 2D 像素
      for (const wi of [5, 6]) {
        const w = p.kp[wi];
        if (!w || !(w[2] >= 0.3)) continue;
        const d = Math.hypot(w[0] - hx, w[1] - hy) / p.scale;
        if (d < bestD) { bestD = d; best = p.track_id; }
      }
    }
    if (best == null || bestD > maxDist) continue;
    const slot = out.get(best);
    if (!slot) continue;
    slot.list.push(hd);
  }

  for (const slot of out.values()) {
    // 同一个人同一侧出现两只手（例如整帧把旁边那人的手也归过来）时保分高的那只
    for (const hd of slot.list) {
      const key = hd.handedness === 'Left' ? 'L' : hd.handedness === 'Right' ? 'R' : null;
      if (!key) continue;
      if (!slot[key] || (hd.score ?? 0) > (slot[key].score ?? 0)) slot[key] = hd;
    }
  }
  return out;
}

/**
 * 多人流水线容器：track_id → 一对独立的状态机。
 */
export class PersonPipelines {
  /**
   * @param {object} params resolveParams() 的结果（Profile 已合并）
   * @param {{gapMs?: number, maxPipelines?: number}} opts
   *        gapMs：同一 track 消失这么久再出现时重建状态机（避免用几秒前的滤波器状态续算）
   */
  constructor(params = {}, { gapMs = 1000, maxPipelines = 16 } = {}) {
    this.params = params;
    this.gapMs = gapMs;
    this.maxPipelines = maxPipelines;
    this.map = new Map();
    this.seq = 0;
  }

  ensure(trackId, ts) {
    let p = this.map.get(trackId);
    if (!p) {
      // 超过上限时淘汰最久未见的那条：长会话里人进人出，不清会无限增长
      if (this.map.size >= this.maxPipelines) {
        let oldest = null;
        for (const [id, v] of this.map) {
          if (!oldest || v.lastTs < oldest.v.lastTs) oldest = { id, v };
        }
        if (oldest) this.map.delete(oldest.id);
      }
      p = {
        track_id: trackId,
        seq: ++this.seq,
        sig: new SignalEngine(this.params),
        act: new ActionEngine(this.params),
        firstTs: ts,
        lastTs: ts,
        hands: { L: null, R: null },
      };
      this.map.set(trackId, p);
      return p;
    }
    // 长时间缺席后回来：旧滤波状态和旧计数相位都不该续上
    if (ts - p.lastTs > this.gapMs) {
      p.sig.reset();
      p.act.reset();
      p.hands = { L: null, R: null };
    }
    p.lastTs = ts;
    return p;
  }

  /**
   * @param {Array} persons 已带 track_id 的人（track.js 输出），按面积降序
   * @param {number} ts
   * @param {Map<number, {L:object|null, R:object|null}>} handsByTrack assignHands() 的结果
   * @returns {Array<{track_id:number, bbox:number[], score:number, sig:object, act:object, hands:object, age_ms:number}>}
   */
  update(persons, ts, handsByTrack = null) {
    const out = [];
    for (const p of persons || []) {
      if (!p || p.track_id == null) continue;
      const pipe = this.ensure(p.track_id, ts);
      const hands = handsByTrack?.get?.(p.track_id) || { L: null, R: null };
      pipe.hands = hands;
      const sig = pipe.sig.update(p, ts);
      const handState = {
        L: hands.L?.cls?.shape ?? null,
        R: hands.R?.cls?.shape ?? null,
      };
      const act = pipe.act.update(sig, ts, handState);
      out.push({
        track_id: p.track_id,
        bbox: p.bbox,
        score: p.score,
        age_ms: p.track_age_ms ?? Math.round(ts - pipe.firstTs),
        sig,
        act,
        hands,
        person: p,
      });
    }
    // 本帧没出现的人：状态保留（跟踪器还在 maxLostMs 内），只是不推进
    return out;
  }

  /** 丢弃跟踪器已放弃的 track（跟踪器 prune 之后调用） */
  prune(activeIds) {
    const keep = activeIds instanceof Set ? activeIds : new Set(activeIds);
    for (const id of [...this.map.keys()]) {
      if (!keep.has(id)) this.map.delete(id);
    }
  }

  reset() {
    for (const p of this.map.values()) {
      p.sig.reset();
      p.act.reset();
    }
    this.map.clear();
    this.seq = 0;
  }

  /** 主目标 = 画面里面积最大的那个人（保持单人的既有语义：UI 面板看这个人） */
  primary(results) {
    let best = null;
    for (const r of results || []) {
      if (!best || area(r.bbox) > area(best.bbox)) best = r;
    }
    return best;
  }

  size() {
    return this.map.size;
  }
}
