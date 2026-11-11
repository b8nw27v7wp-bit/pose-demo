// multi.js — 每人一条判定流水线
//
// 为什么要按 track_id 分实例：SignalEngine / ActionEngine 里全是**有记忆**的部件
// （One Euro 滤波器、Hold 计时、RepCounter 相位、换侧滞回）。两个人共用一套实例，
// A 的深蹲相位会被 B 的膝盖角度打断，计数和持续时长都会串。所以多人不是"循环调用
// 同一套引擎"，而是每人一份引擎。
//
// 纯逻辑（只 import signals/actions/track/handshape），Node 里可单测。

import { SignalEngine } from './signals.js';
import { ActionEngine } from './actions.js';
import { area } from './track.js';
import { HandShapeStabilizer, classifyHand, SHAPE_LABELS } from './handshape.js';

// 导出帧数上限（PLAN §18.5 D3）：多人每帧含全部 persons 的关键点，60MB 级导出不现实；
// 6000 帧 ≈ 3.3 分钟 @30fps，够做逐 track 的短片段评估。单人维持 20000。
export const LOG_LIMITS = { single: 20000, multi: 6000 };

/** 按导出模式取帧数上限。multi=true 表示本帧走的是多人判定路径。 */
export const logLimitFor = (multi) => (multi ? LOG_LIMITS.multi : LOG_LIMITS.single);

/** 手框中心；没有 bbox 的旧数据返回 null（调用方据此跳过 bbox 门） */
function handCenter(hd) {
  const b = hd?.bbox;
  if (!Array.isArray(b) || b.length < 4) return null;
  const [x1, y1, x2, y2] = b;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return [(x1 + x2) / 2, (y1 + y2) / 2];
}

const inBox = (b, x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/**
 * 门 1 的判据：手框中心落在该 person 的框内，或离该人的腕点 ≤ 0.4×scale。
 *
 * pose bbox 由 33 个姿态点取极值，最远端只到腕（不含手指）：手伸向体侧时手框
 * 中心天然在框外，只做整框包含会把手丢掉。腕距外扩是「绑在腕上」的，不是整框
 * 外扩——腕点本身不在本人框内说明它是外推/不可信的，此时不外扩，避免把 A 的手
 * 判给 B。旧数据没有手框时跳过这道门（返回 true）。
 */
function handOwnedByPerson(hd, p) {
  const c = handCenter(hd);
  if (!c) return true;
  if (!Array.isArray(p.bbox)) return false;
  if (inBox(p.bbox, c[0], c[1])) return true;
  const r = 0.4 * (p.scale > 0 ? p.scale : 0);
  for (const wi of [5, 6]) {
    const w = p.kp?.[wi];
    if (!w || !(w[2] >= 0.3)) continue;
    if (!inBox(p.bbox, w[0], w[1])) continue;
    if (Math.hypot(w[0] - c[0], w[1] - c[1]) <= r) return true;
  }
  return false;
}

/**
 * 按 track 的手势稳定器：track_id → {L,R,U}。
 *
 * 手势去抖（HandShapeStabilizer）是有记忆的 streak 计数。全局只有一套实例时，
 * A 连续握拳会推着 B 的握拳候选计数走——两人做不同手势时，B 的稳定结果会被 A 带偏
 * （PLAN §16.3 R12-2）。单人道固定用 track 0，行为与旧版逐位一致。
 */
export class TrackShapeStabilizers {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.map = new Map();
  }

  forTrack(trackId) {
    let s = this.map.get(trackId);
    if (!s) {
      s = {
        L: new HandShapeStabilizer(this.cfg),
        R: new HandShapeStabilizer(this.cfg),
        U: new HandShapeStabilizer(this.cfg),
      };
      this.map.set(trackId, s);
    }
    return s;
  }

  /** 跟踪器放弃的 track 一并丢掉，避免长会话里只增不减 */
  prune(activeIds) {
    const keep = activeIds instanceof Set ? activeIds : new Set(activeIds);
    for (const id of [...this.map.keys()]) if (!keep.has(id)) this.map.delete(id);
  }

  reset() {
    for (const s of this.map.values()) {
      s.L.reset();
      s.R.reset();
      s.U.reset();
    }
    this.map.clear();
  }

  size() {
    return this.map.size;
  }
}

const handSideKey = (hd) => (hd?.handedness === 'Left' ? 'L' : hd?.handedness === 'Right' ? 'R' : 'U');

/**
 * 整帧手部的手势分类 + 按 track 去抖。**必须在 assignHands() 之后调用**：
 * 不先归属就无法知道每只手该推进谁的稳定器。
 *
 * @param {Array} hands 原始手（整帧）
 * @param {number} ts
 * @param {TrackShapeStabilizers} stabilizers
 * @param {(hd:object)=>number|null} ownerOf 手 → track_id；null 表示没有归属
 * @param {Function} [classify] 手势分类器（单测可注入假分类器）
 * @returns {{list:Array, byOriginal:Map<object,object>}} 分类后的整帧列表 + 原手→新手映射
 */
export function classifyHandsByTrack(hands, ts, stabilizers, ownerOf, classify = classifyHand) {
  const byOriginal = new Map();
  const list = (hands || []).map((hd) => {
    const cls = classify(hd.kp);
    const trackId = ownerOf ? ownerOf(hd) : 0;
    let shape = cls.shape;
    if (trackId != null && stabilizers) {
      const stable = stabilizers.forTrack(trackId);
      shape = stable[handSideKey(hd)].update(cls.shape, ts);
    }
    const out = { ...hd, cls: { ...cls, shape, label: SHAPE_LABELS[shape] || '—', raw: cls.shape } };
    byOriginal.set(hd, out);
    return out;
  });
  return { list, byOriginal };
}

/**
 * 把 assignHands() 的槽位重新绑定到分类后的手对象。
 * 槽位结构 {L,R,list} 不变，PersonPipelines 读的仍是 hands.L.cls.shape。
 */
export function bindClassifiedHands(handsByTrack, byOriginal) {
  const out = new Map();
  if (!handsByTrack) return out;
  for (const [trackId, slot] of handsByTrack) {
    out.set(trackId, {
      L: byOriginal.get(slot.L) || null,
      R: byOriginal.get(slot.R) || null,
      list: (slot.list || []).map((h) => byOriginal.get(h) || h),
    });
  }
  return out;
}

/**
 * 每帧给哪些人做腕部 ROI 补检（纯函数，预算可单测）。
 *
 * 按面积降序取前 budget 人（budget = min(multi.maxPersons, roi.maxPersonsPerFrame)），
 * 主目标优先排在最前。scale < minScalePx 的人跳过：远景裁出来的框太小，放大也没有信息，
 * 这是正常跳过而不是错误。跳过的人仍占一个预算名额（口径：先按面积选人，再看尺度）。
 *
 * @returns {{picked:Array, skipped:Array, budget:number}}
 */
export function pickRoiPersons(persons, target, {
  maxPersons = 2, maxPersonsPerFrame = 2, minScalePx = 0,
} = {}) {
  const budget = Math.max(0, Math.min(maxPersons || 0, maxPersonsPerFrame || 0));
  const valid = (persons || []).filter((p) => p && Array.isArray(p.bbox));
  const sorted = valid.slice().sort((a, b) => area(b.bbox) - area(a.bbox));
  const top = [];
  if (budget > 0 && target && sorted.includes(target)) top.push(target);
  for (const p of sorted) {
    if (top.length >= budget) break;
    if (!top.includes(p)) top.push(p);
  }
  const picked = top.filter((p) => (p.scale ?? 0) >= minScalePx);
  const skipped = top.filter((p) => !picked.includes(p));
  return { picked, skipped, budget };
}

/**
 * 把手部检测结果分给最近的人。
 *
 * 为什么必须分：手部模型是整帧跑的，返回的 21 点不带"这是谁的手"。不分的话，
 * 旁边那个人的握拳会被算进目标人的「拿取」阶段，两个人一起举手会互相触发。
 * 归属依据是手部 21 点的 wrist(0) 到该人左右腕关键点的距离，按躯干长归一化——
 * 用像素距离会在远近不同的人之间系统性地偏向离镜头近的那个。
 *
 * 多人（有效 persons > 1）另有两道门，宁可弃权也不猜：
 *   1) 手框中心落在候选 person 的框内，或离其（在框内的）腕点 ≤0.4×scale
 *      （pose bbox 只到腕、不含手指，手伸出去时中心天然在框外；旧数据没有
 *      手框时跳过这道门）；
 *   2) 最近与次近人的归一化距离差必须 ≥ minMargin（默认 0.15）。
 * ROI 补检结果带 owner_track_id 时直接归给 owner，不受这两道门影响。
 * 单人（有效 persons == 1）完全走旧逻辑，输出与改动前一致。
 */
export function assignHands(persons, hands, { maxDist = 0.8, minMargin = 0.15 } = {}) {
  const out = new Map();
  const valid = [];
  for (const p of persons || []) {
    if (!p || !p.kp || !(p.scale > 0)) continue;
    valid.push(p);
    out.set(p.track_id, { L: null, R: null, list: [] });
  }
  if (!Array.isArray(hands)) return out;

  // 单人保持旧行为（没有 bbox 门与次近人门）：单人路径的输出已被无头检查逐帧比对。
  const multi = valid.length > 1;

  for (const hd of hands) {
    if (!hd || !hd.kp || !hd.kp.length) continue;
    const [hx, hy] = hd.kp[0];

    // ROI 补检结果带 owner_track_id：这是用谁的腕点裁出来的，就只属于谁。
    // 不设这道门时，A 的补检结果会因「离 B 的腕点更近」被抢走，甚至被两个人各用一次。
    const owner = hd.owner_track_id;
    if (owner != null) {
      const slot = out.get(owner);
      if (slot) slot.list.push(hd);
      continue;
    }

    // 每个人的归一化距离（取左右腕中更近的那个）。归一化才不会被远近不同的
    // 人体尺寸系统性带偏（像素距离会偏向离镜头近的人）。
    const cand = [];
    for (const p of valid) {
      let bestD = Infinity;
      // 3D 有效时腕点更准，但这里只需要屏幕上的位置，统一用 2D 像素
      for (const wi of [5, 6]) {
        const w = p.kp[wi];
        if (!w || !(w[2] >= 0.3)) continue;
        const d = Math.hypot(w[0] - hx, w[1] - hy) / p.scale;
        if (d < bestD) bestD = d;
      }
      if (Number.isFinite(bestD)) cand.push({ track_id: p.track_id, d: bestD, person: p });
    }
    if (!cand.length) continue;

    let pool = cand;
    if (multi) {
      // 门 1：手框中心落在该 person 的框内，或离该人的腕点不超过 0.4×scale。
      // 后者是必要的：pose bbox 由 33 个姿态点取极值，最远端只到腕（不含手指），
      // 手伸向体侧时手框中心天然在框外；只做整框包含会把手直接丢掉（多人模式下
      // reaching/pointing 整段失效）。它是「绑在腕上」的外扩、不是整框外扩：
      // 腕点本身不在本人框内（外推/不可信）时不外扩，A 的手不会被判给 B。
      // 两个人框重叠区的歧义仍由门 2 的次近人 margin 判弃权。
      pool = cand.filter(({ person: p }) => handOwnedByPerson(hd, p));
      if (!pool.length) continue;
    }

    pool.sort((a, b) => a.d - b.d);
    const best = pool[0];
    if (!(best.d <= maxDist)) continue;
    // 门 2：与次近人的归一化距离差足够大才归属；否则宁可弃权，不要猜。
    // 两人靠得近时（肩并肩、交叉遮挡）这是唯一能避免「A 的手算给 B」的判据。
    if (multi && pool.length > 1 && pool[1].d - best.d < minMargin) continue;

    const slot = out.get(best.track_id);
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
   * @param {Array<{label:string, score:number, box:number[]}>} objects 本帧物体检测框
   *   （operating 有 equipmentLabels 时用它判断手/肘是否在设备框附近）
   * @returns {Array<{track_id:number, bbox:number[], score:number, sig:object, act:object, hands:object, age_ms:number}>}
   */
  update(persons, ts, handsByTrack = null, objects = []) {
    const out = [];
    for (const p of persons || []) {
      if (!p || p.track_id == null) continue;
      const pipe = this.ensure(p.track_id, ts);
      const hands = handsByTrack?.get?.(p.track_id) || { L: null, R: null };
      pipe.hands = hands;
      const sig = pipe.sig.update(p, ts, objects);
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
