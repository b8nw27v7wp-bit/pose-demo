// ppe.js — 安全帽 / 手套（PPE）判定
//
// 判定对象不是"姿态"，是"人身上有没有那件东西"：属于目标检测 + 人-物空间关系，
// 所以这里只做几何归属和时序，不做任何识别——框从 objects.js 来。
//
// 三条语义必须写死，否则上线就是无穷申诉：
// 1. 看不见 ≠ 没戴。头/腕不可见、模型没配这个类别、整场没检出过任何正例，一律 unknown。
// 2. 单帧漏检不算违规。必须连续 missing 超过 minMs 才成立（默认 3 秒）。
// 3. 手套默认只报「疑似」（suspect），不进实时违规：手是运动目标、尺寸小、常被遮挡，
//    "没检出"和"没戴"在视觉上不可区分。要升级成违规必须由 profile 显式改 policy。
//
// 纯逻辑，Node 可单测。

import { headPointsFromRaw } from './geometry.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 标签匹配：不区分大小写；配置项按"完全相等或包含"匹配（例如 'safety_helmet' 包含 'helmet'）。
 * positive=true（默认）时负类（no_helmet / no_gloves / not_helmet…）永远不算正类：
 * 'no_helmet' 包含 'helmet'，不挡住的话模型一旦输出负类，会被当成"戴了安全帽"。
 * 匹配 noHelmet/noGlove 配置时传 positive:false。
 */
const NEGATIVE_LABEL = /^(no|not|without|non)[\s_-]+/;
export function matchLabel(label, list, { positive = true } = {}) {
  if (!label || !Array.isArray(list) || !list.length) return false;
  const s = String(label).toLowerCase().replace(/[\s-]+/g, '_');
  if (positive && NEGATIVE_LABEL.test(s)) return false;
  return list.some((raw) => {
    const t = String(raw).toLowerCase().replace(/[\s-]+/g, '_');
    return t && (s === t || s.includes(t));
  });
}

const boxCenter = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
const square = (cx, cy, half) => [cx - half, cy - half, cx + half, cy + half];

/**
 * 头部区域：
 * 1. 头面部关键点（眼/耳，鼻尖只作旧兜底）→ 方框；
 * 2. 鼻尖可见 → 旧方框（几何逐位保持不变）；
 * 3. 人框顶部 → visible=false。
 *
 * 背对/低头时鼻尖不可见但双耳通常可见，face 分支能把「看得见帽子」变成 worn/missing，
 * 而不是直接 unknown。旧导出没有 kp_head/kp_raw 时自动走鼻尖路径。
 *
 * @returns {{box:number[], source:'face'|'nose'|'bbox', visible:boolean, points?:number}}
 */
export function headBox(person, cfg = {}) {
  const scale = person.scale || 0;
  const visMin = cfg.visMin ?? 0.3;
  const halfBase = (cfg.headBoxScale ?? 0.55) * scale;
  const face = cfg.headFace || {};
  const faceOn = face.enabled !== false && halfBase > 0;

  if (faceOn) {
    // 只有完整的 9 点才用；短数组/坏数据不能挡住下面的 kp_raw 兜底。
    let pts = Array.isArray(person.kp_head) && person.kp_head.length >= 9 ? person.kp_head : null;
    // 兼容只带 33 点 raw 的调用方（测试/旧导出没有 kp_head 但有 kp_raw）。
    if (!pts && Array.isArray(person.kp_raw) && person.kp_raw.length >= 33) {
      pts = headPointsFromRaw(person.kp_raw, person.frame_w, person.frame_h);
    }
    if (pts && pts.length >= 9) {
      const fw = Number(person.frame_w);
      const fh = Number(person.frame_h);
      const cand = [];
      for (let i = 1; i < 9; i++) {
        const p = pts[i];
        if (!p || !isNum(p[0]) || !isNum(p[1])) continue;
        if ((p[2] ?? 0) < (face.visMin ?? visMin)) continue;
        if (fw > 0 && fh > 0) {
          const mx = 0.02 * fw;
          const my = 0.02 * fh;
          if (p[0] < -mx || p[0] > fw + mx || p[1] < -my || p[1] > fh + my) continue;
        }
        cand.push({ x: p[0], y: p[1], side: (i <= 3 || i === 7) ? 'L' : 'R' });
      }
      const hasL = cand.some((p) => p.side === 'L');
      const hasR = cand.some((p) => p.side === 'R');
      const both = face.bothSides !== false;
      if (cand.length >= (face.minPoints ?? 2) && (!both || (hasL && hasR))) {
        // 单帧坏点（尤其耳朵）会把中心拉走：先按均值剔离群点，再重算。
        const mx = cand.reduce((s, p) => s + p.x, 0) / cand.length;
        const my = cand.reduce((s, p) => s + p.y, 0) / cand.length;
        const maxD = (face.maxPointDist ?? 1.0) * scale;
        const kept = cand.filter((p) => (maxD > 0
          ? Math.hypot(p.x - mx, p.y - my) <= maxD : true));
        const keptL = kept.some((p) => p.side === 'L');
        const keptR = kept.some((p) => p.side === 'R');
        if (kept.length >= (face.minPoints ?? 2) && (!both || (keptL && keptR))) {
          const xs = kept.map((p) => p.x);
          const ys = kept.map((p) => p.y);
          const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
          if (spread >= (face.minSpread ?? 0.12) * scale) {
            const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
            const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
            const half = Math.max(
              halfBase * (face.halfMul ?? 1),
              Math.min(1.5 * halfBase, 0.6 * spread),
            );
            const shift = (face.shift ?? 0.25) * half;
            if (half > 0) {
              return {
                box: [cx - half, cy - half - shift, cx + half, cy + half],
                source: 'face',
                visible: true,
                points: kept.length,
              };
            }
          }
        }
      }
    }
  }

  const nose = person.kp?.[0];
  if (nose && nose[2] >= visMin && halfBase > 0) {
    // 鼻尖在头的中下部：往上抬 0.25 个半边长，让框覆盖额头与帽檐
    return { box: square(nose[0], nose[1] - 0.25 * halfBase, halfBase), source: 'nose', visible: true };
  }
  const b = person.bbox;
  if (Array.isArray(b) && b.length === 4) {
    const h = b[3] - b[1];
    const w = b[2] - b[0];
    const headH = 0.22 * h;
    const headW = 0.45 * w;
    const cx = (b[0] + b[2]) / 2;
    return {
      box: [cx - headW / 2, b[1], cx + headW / 2, b[1] + headH],
      source: 'bbox',
      visible: false,   // 人框顶部只是猜测，头可能根本不在画面里
    };
  }
  return { box: [0, 0, 0, 0], source: 'bbox', visible: false };
}

/** 手腕区域（每侧一个方框）；腕点不可见时 visible=false */
export function wristBox(person, side, cfg = {}) {
  const half = (cfg.gloveBoxScale ?? 0.45) * (person.scale || 0);
  const idx = side === 'L' ? 5 : 6;
  const w = person.kp?.[idx];
  const visMin = cfg.visMin ?? 0.3;
  if (!w || w[2] < visMin || half <= 0) return { box: [0, 0, 0, 0], visible: false, source: 'wrist' };
  return { box: square(w[0], w[1], half), visible: true, source: 'wrist' };
}

const boxValid = (b) => Array.isArray(b) && b.length >= 4 && b.slice(0, 4).every(isNum)
  && b[2] > b[0] && b[3] > b[1];

function kpBBox(kp) {
  if (!Array.isArray(kp) || kp.length < 21) return null;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const p of kp) {
    if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) continue;
    if (p[0] < x1) x1 = p[0];
    if (p[1] < y1) y1 = p[1];
    if (p[0] > x2) x2 = p[0];
    if (p[1] > y2) y2 = p[1];
  }
  return x1 === Infinity ? null : [x1, y1, x2, y2];
}

/**
 * 手部 21 点 → 手套区域。手 bbox 比腕点方框更贴合；四边再放宽一点，
 * 覆盖手套/袖口超出关键点的部分。
 * @returns {{box:number[], visible:boolean, source:'hand'|'none'}}
 */
export function handGloveBox(hand, cfg = {}) {
  const h = cfg.gloveHand || {};
  if (h.enabled === false || !hand) return { box: [0, 0, 0, 0], visible: false, source: 'none' };
  if (Number.isFinite(h.minScore) && h.minScore > 0 && (hand.score ?? 0) < h.minScore) {
    return { box: [0, 0, 0, 0], visible: false, source: 'none' };
  }
  const b = boxValid(hand.bbox) ? hand.bbox : kpBBox(hand.kp);
  if (!boxValid(b)) return { box: [0, 0, 0, 0], visible: false, source: 'none' };
  const pad = Math.max(0, Number(h.pad ?? 0.15)) * Math.max(b[2] - b[0], b[3] - b[1]);
  return {
    box: [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad],
    visible: true,
    source: 'hand',
  };
}

const handWrist = (hand) => (hand?.kp?.[0] && Array.isArray(hand.kp[0]) ? hand.kp[0] : null);
const handList = (hands) => {
  if (!hands) return [];
  if (Array.isArray(hands)) return hands;
  if (Array.isArray(hands.list) && hands.list.length) return hands.list;
  return [hands.L, hands.R].filter(Boolean);
};

/**
 * 每侧手套区域：优先已归属到该 track 的手（hands[side]），否则按最近姿态腕点
 * 从手列表里挑；都不行才退回腕点方框。
 *
 * `used` 是跨左右侧共享的 Set：同一只手不能被两侧各用一次。
 */
export function gloveRegion(person, side, cfg = {}, hands = null, used = null) {
  const h = cfg.gloveHand || {};
  const fallback = () => ({ ...wristBox(person, side, cfg), side_from: 'pose' });
  if (h.enabled === false) return fallback();

  const taken = used || new Set();
  let hand = null;
  let sideFrom = null;

  if (hands && !Array.isArray(hands) && hands[side] && !taken.has(hands[side])) {
    hand = hands[side];
    sideFrom = 'slot';
  } else {
    const list = handList(hands).filter((x) => x && !taken.has(x));
    const target = person.kp?.[side === 'L' ? 5 : 6];
    const visMin = cfg.visMin ?? 0.3;
    const scale = person.scale || 0;
    if (target && target[2] >= visMin && scale > 0) {
      let best = null;
      let bestD = Infinity;
      for (const cand of list) {
        const w = handWrist(cand);
        if (!w) continue;
        const d = Math.hypot(w[0] - target[0], w[1] - target[1]) / scale;
        if (d < bestD) { bestD = d; best = cand; }
      }
      if (best && bestD <= (h.maxWristDist ?? 0.8)) {
        hand = best;
        sideFrom = 'nearest_wrist';
      }
    }
    if (!hand) {
      const want = side === 'L' ? 'Left' : 'Right';
      const matching = list.filter((x) => x.handedness === want);
      if (matching.length === 1) {
        hand = matching[0];
        sideFrom = 'handedness';
      }
    }
  }

  if (hand) {
    const gb = handGloveBox(hand, cfg);
    if (gb.visible) {
      taken.add(hand);
      if (used) used.add(hand);
      return { ...gb, side_from: sideFrom };
    }
  }
  return fallback();
}

/** 该区域里分最高的匹配框（中心点落区 + 分数门槛） */
export function bestInRegion(objects, region, labels, minScore = 0.35, { positive = true } = {}) {
  let best = null;
  for (const o of objects || []) {
    if (!o || (o.score ?? 0) < minScore) continue;
    if (!matchLabel(o.label, labels, { positive })) continue;
    if (!Array.isArray(o.box) || o.box.length !== 4) continue;
    if (!inBox(boxCenter(o.box), region)) continue;
    if (!best || (o.score ?? 0) > (best.score ?? 0)) best = o;
  }
  return best;
}

/**
 * 单人 PPE 判定（不含时序）。
 * @param {object} person 统一 person 契约（需要 kp / scale / bbox）
 * @param {Array} objects objects.js 的输出 [{label, score, box}]
 * @param {object} cfg signals.ppe 参数
 * @param {{sawClasses?: {helmet:boolean, glove:boolean}}} ctx 本场是否出现过该类正例
 * @returns {{helmet:object, glove:{L:object, R:object}}}
 */
export function assessPpe(person, objects, cfg = {}, ctx = {}) {
  const minScore = cfg.minScore ?? 0.35;
  const classes = cfg.classes || {};
  const requirePositive = cfg.requirePositive !== false;
  const saw = ctx.sawClasses || { helmet: false, glove: false };
  const hands = ctx.hands || null;
  const usedHands = new Set();

  const head = headBox(person, cfg);
  const helmetLabels = classes.helmet || [];
  const noHelmetLabels = classes.noHelmet || [];
  let helmet;
  const hmeta = { box: head.box, source: head.source };
  if (!helmetLabels.length) {
    helmet = {
      state: 'unknown', reason: '未配置安全帽类别', reason_code: 'config_mismatch', ...hmeta,
    };
  } else if (!head.visible) {
    helmet = {
      state: 'unknown', reason: '头部不可见（背影/低头/出画）', reason_code: 'occluded', ...hmeta,
    };
  } else {
    const hit = bestInRegion(objects, head.box, helmetLabels, minScore);
    // 负类框是直接证据：模型明确检出"未戴安全帽"，比"没检出正类"更强
    const neg = !hit && noHelmetLabels.length
      ? bestInRegion(objects, head.box, noHelmetLabels, minScore, { positive: false }) : null;
    if (hit) helmet = { state: 'worn', reason: '检出安全帽', reason_code: null, ...hmeta, obj: hit };
    else if (neg) helmet = { state: 'missing', reason: '检出未戴安全帽', reason_code: null, ...hmeta, obj: neg };
    else if (requirePositive && !saw.helmet) helmet = {
      state: 'unknown', reason: '模型本场未检出过安全帽（先确认类别名/模型）', reason_code: 'no_positive', ...hmeta,
    };
    else helmet = { state: 'missing', reason: '头部可见但区域内无安全帽', reason_code: null, ...hmeta };
  }

  const gloveLabels = classes.glove || [];
  const noGloveLabels = classes.noGlove || [];
  const glove = {};
  for (const side of ['L', 'R']) {
    const wb = gloveRegion(person, side, cfg, hands, usedHands);
    if (!gloveLabels.length) {
      glove[side] = {
        state: 'unknown', reason: '未配置手套类别', reason_code: 'config_mismatch',
        box: wb.box, source: wb.source, side_from: wb.side_from,
      };
    } else if (!wb.visible) {
      glove[side] = {
        state: 'unknown', reason: '该侧腕不可见', reason_code: 'occluded',
        box: wb.box, source: wb.source, side_from: wb.side_from,
      };
    } else {
      const hit = bestInRegion(objects, wb.box, gloveLabels, minScore);
      const neg = !hit && noGloveLabels.length
        ? bestInRegion(objects, wb.box, noGloveLabels, minScore, { positive: false }) : null;
      const meta = { box: wb.box, source: wb.source, side_from: wb.side_from };
      if (hit) glove[side] = { state: 'worn', reason: '检出手套', reason_code: null, ...meta, obj: hit };
      else if (neg) glove[side] = { state: 'missing', reason: '检出未戴手套', reason_code: null, ...meta, obj: neg };
      else if (requirePositive && !saw.glove) glove[side] = {
        state: 'unknown', reason: '模型本场未检出过手套', reason_code: 'no_positive', ...meta,
      };
      else glove[side] = { state: 'missing', reason: '腕可见但区域内无手套', reason_code: null, ...meta };
    }
  }
  return { helmet, glove, head };
}

const alertFor = (streakMs, cfg = {}) => {
  const minMs = cfg.minMs ?? 3000;
  if (streakMs < minMs) return 'none';
  return (cfg.policy ?? 'suspect') === 'violation' ? 'violation' : 'suspect';
};

/**
 * 每人的 PPE 时序监视器：把"这一帧缺"变成"连续缺了多久"。
 * 和 Hold 的区别：unknown（看不见/模型没给正例）既不算违规，也不清零已积累的时长，
 * 而是暂停——人一转身帽子被挡住，不该让他已经积累的 2.9 秒重新开始。
 */
export class PpeMonitor {
  constructor(cfg = {}) {
    this.cfg = cfg;
    // 键优先用 track_uid，旧数据没有 uid 时退回 track_id。
    // 同一轨迹对象内 uid 不变，因此调用方重映射 track_id 时计时不会丢；
    // 但跟踪器 prune 后重建的是新 uid（linkAcrossIds 未实现），跨 id 的计时继承不在本版范围。
    this.tracks = new Map(); // track_uid ?? track_id -> { helmet:{since,streak}, glove:{L,R}, track_id, track_uid }
    this.saw = { helmet: false, glove: false };
    // requirePositive 的窗口化（R13-10）：positiveWindowMs=0 时保持旧行为（整场 sticky）。
    this.positiveWindowMs = Math.max(0, Number(cfg.positiveWindowMs ?? 0) || 0);
    this.minPositive = Math.max(1, Math.round(Number(cfg.minPositive ?? 3) || 1));
    this.positives = { helmet: [], glove: [] }; // 窗口内正例的 ts 列表
    this.lastTs = null;
    this.lastPositiveTs = null; // 上次记正例的帧时间（同一时刻的多人调用只计一次）
  }

  reset() {
    this.tracks.clear();
    this.saw = { helmet: false, glove: false };
    this.positives = { helmet: [], glove: [] };
    this.lastTs = null;
    this.lastPositiveTs = null;
  }

  /**
   * 丢弃跟踪器已放弃的 track（否则长会话里计时器只增不减）。
   * active 里既可能是 track_id（旧调用方）也可能是 track_uid（新调用方），
   * 只要命中 entry 记录过的任一 id 就保留，避免调用方还没改完时误删。
   */
  prune(activeIds) {
    const keep = activeIds instanceof Set ? activeIds : new Set(activeIds);
    for (const [key, e] of [...this.tracks]) {
      if (keep.has(key) || keep.has(e.track_id) || keep.has(e.track_uid)) continue;
      this.tracks.delete(key);
    }
  }

  /** 正例计数（窗口模式）：过期的 ts 先丢掉，再按窗口内数量更新 saw */
  refreshPositive(ts) {
    if (this.positiveWindowMs <= 0) return;
    const cutoff = ts - this.positiveWindowMs;
    for (const cls of ['helmet', 'glove']) {
      const arr = this.positives[cls];
      while (arr.length && arr[0] < cutoff) arr.shift();
      this.saw[cls] = arr.length >= this.minPositive;
    }
  }

  /** 统计本场是否真的检出过该类正例：模型类别名写错时，防止把全场判成"都没戴" */
  noteObjects(objects, ts = this.lastTs ?? 0) {
    const classes = this.cfg.classes || {};
    const t = Number.isFinite(ts) ? ts : (this.lastTs ?? 0);
    this.lastTs = t;
    const list = objects || [];
    if (this.positiveWindowMs > 0) {
      // 同一时刻只记一次：update() 是每帧每人调用一次，objects 还是检测间隔内
      // 复用的缓存框——按调用次数计数会把同一个框按「人数 × 帧数」重复累加，
      // minPositive=3 会在单个误匹配的一帧内被凑满，护栏等于没有。
      // 按「帧次」计数，minPositive 才是「窗口内至少 N 帧看到正例」。
      if (this.lastPositiveTs !== t) {
        this.lastPositiveTs = t;
        for (const cls of ['helmet', 'glove']) {
          if (list.some((o) => matchLabel(o.label, classes[cls] || []))) this.positives[cls].push(t);
        }
      }
      this.refreshPositive(t);
      return;
    }
    for (const o of list) {
      for (const cls of ['helmet', 'glove']) {
        // 旧行为：整场 sticky，一次正例永久解锁护栏
        if (!this.saw[cls] && matchLabel(o.label, classes[cls] || [])) this.saw[cls] = true;
      }
    }
  }

  entry(trackId, person = null) {
    const uid = person?.track_uid;
    // uid 优先：调用方把同一条轨迹的 track_id 重映射时，仍命中同一条计时器。
    // 不在这里做 linkAcrossIds 的跨 id 继承——该功能默认关闭，尚未实现；
    // 跟踪器 prune 后重新出现的人是新 uid，计时从 0 开始。
    const key = uid ?? trackId;
    let e = this.tracks.get(key);
    if (!e) {
      e = {
        helmet: { since: null, streak: 0 },
        glove: { L: { since: null, streak: 0 }, R: { since: null, streak: 0 } },
        track_id: trackId,
        track_uid: uid ?? null,
      };
      this.tracks.set(key, e);
    }
    // 同 uid 的 id 更新后保留最新 track_id，供 prune(activeIds) 的旧调用方匹配
    e.track_id = trackId;
    if (uid != null) e.track_uid = uid;
    return e;
  }

  /** 单条状态推进：missing 累计，worn 清零，unknown 暂停（保留进度、不推进） */
  step(slot, state, ts) {
    if (state === 'missing') {
      if (slot.since == null) slot.since = ts;
      slot.streak = Math.max(0, ts - slot.since);
    } else if (state === 'worn') {
      slot.since = null;
      slot.streak = 0;
    }
    // unknown：slot 原样保留
    return slot.streak;
  }

  /**
   * @returns {{helmet:{state,streak_ms,alert,reason,reason_code}, glove:{state,alert,streak_ms,reason,reason_code,L:object,R:object}}}
   */
  update(trackId, person, objects, ts, hands = null) {
    this.lastTs = ts;
    // 窗口模式先把过期正例清掉（没有新框的帧也要让护栏重新生效）
    this.refreshPositive(ts);
    this.noteObjects(objects, ts);
    const a = assessPpe(person, objects, this.cfg, { sawClasses: this.saw, hands });
    const e = this.entry(trackId, person);

    const hStreak = this.step(e.helmet, a.helmet.state, ts);
    const helmet = {
      state: a.helmet.state,
      reason: a.helmet.reason,
      reason_code: a.helmet.reason_code,
      streak_ms: Math.round(hStreak),
      alert: a.helmet.state === 'missing' ? alertFor(hStreak, this.cfg.helmet) : 'none',
      box: a.helmet.box,
      source: a.helmet.source,
    };

    const per = {};
    for (const side of ['L', 'R']) {
      const st = a.glove[side];
      const sStreak = this.step(e.glove[side], st.state, ts);
      per[side] = {
        state: st.state,
        reason: st.reason,
        reason_code: st.reason_code,
        streak_ms: Math.round(sStreak),
        alert: st.state === 'missing' ? alertFor(sStreak, this.cfg.glove) : 'none',
        box: st.box,
        source: st.source,
        side_from: st.side_from,
      };
    }
    // 两侧合并：任一侧 missing 就报该侧；都戴 = worn；否则 unknown。
    // 告警取更重的一侧：先 violation 后 suspect。按左右顺序取第一个非 none 会在
    // 「左手疑似、右手违规」时把违规降级成疑似。
    const states = [per.L.state, per.R.state];
    const glove = states.every((s) => s === 'worn') ? 'worn'
      : states.includes('missing') ? 'missing' : 'unknown';
    const gStreak = Math.max(per.L.streak_ms, per.R.streak_ms);
    const gAlert = [per.L.alert, per.R.alert].includes('violation') ? 'violation'
      : [per.L.alert, per.R.alert].includes('suspect') ? 'suspect' : 'none';
    // 合并后的 glove 也带 reason_code：取导致 unknown 的那一侧，便于导出后解释弃权原因
    const gReason = glove === 'unknown'
      ? (['L', 'R'].map((s) => per[s]).find((p) => p.state === 'unknown' && p.reason_code)?.reason_code ?? null)
      : null;

    return {
      helmet,
      glove: { state: glove, streak_ms: gStreak, alert: gAlert, reason_code: gReason, L: per.L, R: per.R },
    };
  }
}
