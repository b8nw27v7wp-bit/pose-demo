// geometry.js — 区域/多边形几何（纯函数，Node 可单测）
//
// 两件事：
// 1. 设备 ROI：旧矩形 {x,y,w,h} 与新的多边形 rois[] 统一成「像素 zone」，供
//    operating（点在区域内）与 near_equipment（人体框与区域的面积重叠）共用。
// 2. 人框有效性 / 头部关键点：给 signals 与 ppe 提供可测的几何小工具。
//
// 约定：
// - 配置里的多边形点是归一化画面坐标 [[x,y],...]，0~1；运行时用 scaleZones 换成像素。
// - 多边形要求简单（非自交）；点序不限；边界算内部。
// - rois 非空但全部非法时 fail-closed：不静默退回旧 roi。
// - 没有 frame_w/frame_h 时无法把归一化坐标换成像素，多边形视为不可用（不猜）。

import { HEAD_KPT } from './kpt.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 归一化坐标的容差（浮点写 0.9999999 不算越界）。 */
const UNIT_TOL = 1e-6;

/**
 * 旧矩形 {x,y,w,h} → 合法矩形（负宽高翻正）；非法返回 null，不 clamp。
 *
 * 矩形坐标是**归一化** 0~1（与多边形同口径）。越界多半是手滑：把 0.56 写成 56
 * 以前会静默把 ROI 放大 100 倍、覆盖整个画面，operating 于是恒真。多边形那条路
 * 已经 fail-closed，这里必须一致：值域不对就返回 null，不试图猜测意图。
 */
export function normalizeRect(roi) {
  if (!roi || typeof roi !== 'object') return null;
  let { x, y, w, h } = roi;
  if (![x, y, w, h].every(isNum) || w === 0 || h === 0) return null;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  if (x < -UNIT_TOL || y < -UNIT_TOL || w <= UNIT_TOL || h <= UNIT_TOL) return null;
  if (x + w > 1 + UNIT_TOL || y + h > 1 + UNIT_TOL) return null;
  return { x, y, w, h };
}

/** 旧矩形 → 像素/归一化 box [x1,y1,x2,y2]。 */
export function rectToBox(rect) {
  const r = normalizeRect(rect);
  return r ? [r.x, r.y, r.x + r.w, r.y + r.h] : null;
}

const pointOf = (p) => (Array.isArray(p) ? p : (p && typeof p === 'object' ? [p.x, p.y] : null));

/** 校验一个多边形点集；返回 [[x,y],...] 或 null。 */
function validPoints(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const out = [];
  for (const raw of points) {
    const p = pointOf(raw);
    if (!p || !isNum(p[0]) || !isNum(p[1])) return null;
    // 归一化坐标必须落在画面内；越界多半是 0.42 手滑写成 42，直接判非法而不是悄悄放大。
    if (p[0] < -1e-6 || p[0] > 1 + 1e-6 || p[1] < -1e-6 || p[1] > 1 + 1e-6) return null;
    out.push([p[0], p[1]]);
  }
  return out;
}

/**
 * rois → [{id, points}]。非法 zone 直接丢弃；调用方用 resolveRegions 判断
 * 「原始 rois 非空但没有任何合法 zone」并 fail-closed。
 */
export function normalizeZones(rois) {
  if (!Array.isArray(rois)) return [];
  const out = [];
  rois.forEach((z, i) => {
    if (!z || typeof z !== 'object' || z.enabled === false) return;
    const points = validPoints(z.points ?? z.polygon);
    if (!points) return;
    out.push({
      id: typeof z.id === 'string' && z.id ? z.id : `zone_${i}`,
      points,
    });
  });
  return out;
}

/** 归一化 zone → 像素 zone；frame 尺寸非法时返回 []。 */
export function scaleZones(zones, frameW, frameH) {
  const fw = Number(frameW);
  const fh = Number(frameH);
  if (!(fw > 0 && fh > 0)) return [];
  return (zones || []).map((z) => ({
    id: z.id,
    points: z.points.map(([x, y]) => [x * fw, y * fh]),
  }));
}

/** 是否配置了可用的设备区域：旧 roi 合法，或至少一个合法 polygon zone。 */
export function hasRegionConfig(operatingCfg = {}) {
  const rois = operatingCfg?.rois;
  if (Array.isArray(rois) && rois.length > 0) return normalizeZones(rois).length > 0;
  return !!normalizeRect(operatingCfg?.roi);
}

/** 多边形 bbox；无有效点返回 null。 */
export function polygonBBox(points) {
  if (!Array.isArray(points) || !points.length) return null;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const raw of points) {
    const p = pointOf(raw);
    if (!p || !isNum(p[0]) || !isNum(p[1])) continue;
    if (p[0] < x1) x1 = p[0];
    if (p[1] < y1) y1 = p[1];
    if (p[0] > x2) x2 = p[0];
    if (p[1] > y2) y2 = p[1];
  }
  return x1 === Infinity ? null : [x1, y1, x2, y2];
}

/** 鞋带公式面积（绝对值）。 */
export function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = pointOf(points[i]);
    const b = pointOf(points[(i + 1) % n]);
    if (!a || !b || !isNum(a[0]) || !isNum(a[1]) || !isNum(b[0]) || !isNum(b[1])) return 0;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

const EPS = 1e-9;
const onSegment = (p, a, b) => {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > EPS) return false;
  return p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS
    && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
};

/** 点在多边形内（射线法）；边界点算内部。 */
export function pointInPolygon(x, y, points) {
  if (!isNum(x) || !isNum(y) || !Array.isArray(points) || points.length < 3) return false;
  const p = [x, y];
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = pointOf(points[j]);
    const b = pointOf(points[i]);
    if (!a || !b) continue;
    if (onSegment(p, a, b)) return true;
    const crosses = (b[1] > y) !== (a[1] > y)
      && x < ((a[0] - b[0]) * (y - b[1])) / (a[1] - b[1]) + b[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

/** 点在任一 zone 内；返回第一个命中的 {id,index}，否则 null。 */
export function pointInAnyZone(x, y, zones) {
  for (let i = 0; i < (zones || []).length; i++) {
    const z = zones[i];
    if (z && pointInPolygon(x, y, z.points)) return { id: z.id, index: i };
  }
  return null;
}

/** 用矩形 [x1,y1,x2,y2] 裁剪多边形（Sutherland–Hodgman）。 */
export function clipPolygonToRect(points, rect) {
  const r = Array.isArray(rect) && rect.length >= 4 ? rect : rectToBox(rect);
  if (!r || !Array.isArray(points) || points.length < 3) return [];
  const [x1, y1, x2, y2] = r;
  if (!(x2 > x1 && y2 > y1)) return [];

  let poly = points.map((p) => pointOf(p)).filter(Boolean);
  if (poly.length < 3) return [];

  const clip = (inside, intersect) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i];
      const prev = poly[(i + poly.length - 1) % poly.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur));
      }
    }
    poly = out;
  };

  const ix = (a, b, x) => {
    const t = (x - a[0]) / (b[0] - a[0]);
    return [x, a[1] + t * (b[1] - a[1])];
  };
  const iy = (a, b, y) => {
    const t = (y - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), y];
  };

  clip((p) => p[0] >= x1, (a, b) => ix(a, b, x1));
  clip((p) => p[0] <= x2, (a, b) => ix(a, b, x2));
  clip((p) => p[1] >= y1, (a, b) => iy(a, b, y1));
  clip((p) => p[1] <= y2, (a, b) => iy(a, b, y2));
  return poly.length >= 3 ? poly : [];
}

/** 矩形 ∩ 多边形面积（像素²）。 */
export function rectPolygonIntersectionArea(rect, points) {
  const r = Array.isArray(rect) && rect.length >= 4 ? rect : rectToBox(rect);
  if (!r) return 0;
  const inter = clipPolygonToRect(points, r);
  return inter.length >= 3 ? polygonArea(inter) : 0;
}

/** 交集面积 / 矩形面积；矩形面积为 0 返回 0。 */
export function rectPolygonOverlapRatio(rect, points) {
  const r = Array.isArray(rect) && rect.length >= 4 ? rect : rectToBox(rect);
  if (!r) return 0;
  const area = Math.max(0, (r[2] - r[0]) * (r[3] - r[1]));
  if (!(area > 0)) return 0;
  const ratio = rectPolygonIntersectionArea(r, points) / area;
  return Math.max(0, Math.min(1, ratio));
}

/** 多个 zone 与矩形重叠的最大值；返回 {ratio, zone_id, index}。 */
export function maxZoneOverlap(rect, zones) {
  const r = Array.isArray(rect) && rect.length >= 4 ? rect : rectToBox(rect);
  if (!r) return { ratio: NaN, zone_id: null, index: -1 };
  let best = { ratio: -1, zone_id: null, index: -1 };
  (zones || []).forEach((z, i) => {
    if (!z || !Array.isArray(z.points)) return;
    const ratio = rectPolygonOverlapRatio(r, z.points);
    if (ratio > best.ratio) best = { ratio, zone_id: z.id ?? null, index: i };
  });
  if (best.ratio < 0) return { ratio: NaN, zone_id: null, index: -1 };
  return best;
}

/**
 * 把配置解析成可用的区域。rois 非空时完全忽略旧 roi；全部非法时 fail-closed。
 * @returns {{mode:'none'|'rect'|'polygon', valid:boolean, usable:boolean,
 *            rect:object|null, rectPx:number[]|null,
 *            zones:Array<{id:string,points:number[][]}>, normalizedZones:Array}}
 */
export function resolveRegions(operatingCfg = {}, frameW, frameH) {
  const fw = Number(frameW);
  const fh = Number(frameH);
  const hasFrame = fw > 0 && fh > 0;
  const rois = operatingCfg?.rois;

  if (Array.isArray(rois) && rois.length > 0) {
    const normalized = normalizeZones(rois);
    const valid = normalized.length > 0;
    const usable = valid && hasFrame;
    return {
      mode: 'polygon',
      valid,
      usable,
      rect: null,
      rectPx: null,
      zones: usable ? scaleZones(normalized, fw, fh) : [],
      normalizedZones: normalized,
    };
  }

  const rect = normalizeRect(operatingCfg?.roi);
  if (!rect) {
    return { mode: 'none', valid: false, usable: false, rect: null, rectPx: null, zones: [], normalizedZones: [] };
  }
  const rectPx = hasFrame ? [rect.x * fw, rect.y * fh, (rect.x + rect.w) * fw, (rect.y + rect.h) * fh] : null;
  return {
    mode: 'rect',
    valid: true,
    usable: hasFrame,
    rect,
    rectPx,
    zones: [],
    normalizedZones: [],
  };
}

/**
 * 人体框有效性门（near_equipment 用）。默认 enabled:false，逐位保持旧行为。
 * bbox/frame 缺失时只跳过能算的门，不凭空判失败。
 */
export function personBoxValidity(bbox, frameW, frameH, visShoulder, visTorso, cfg = {}) {
  if (cfg?.enabled !== true) {
    return {
      enabled: false, ok: true, known: false,
      area_ratio: null, height_ratio: null, in_frame: null,
      shoulder_vis: null, torso_vis: null, reasons: [],
    };
  }

  const reasons = [];
  const out = {
    enabled: true, ok: false, known: false,
    area_ratio: null, height_ratio: null, in_frame: null,
    shoulder_vis: Number.isFinite(visShoulder) ? visShoulder : null,
    torso_vis: Number.isFinite(visTorso) ? visTorso : null,
    reasons,
  };

  if (!Array.isArray(bbox) || bbox.length < 4 || !bbox.slice(0, 4).every(isNum)) {
    reasons.push('bbox_invalid');
    return out;
  }
  const [x1, y1, x2, y2] = bbox;
  const bw = Math.max(0, x2 - x1);
  const bh = Math.max(0, y2 - y1);
  if (!(bw > 0 && bh > 0)) {
    reasons.push('bbox_invalid');
    return out;
  }

  const fw = Number(frameW);
  const fh = Number(frameH);
  if (fw > 0 && fh > 0) {
    out.known = true;
    const bboxArea = bw * bh;
    out.area_ratio = bboxArea / (fw * fh);
    out.height_ratio = bh / fh;
    const iw = Math.max(0, Math.min(x2, fw) - Math.max(x1, 0));
    const ih = Math.max(0, Math.min(y2, fh) - Math.max(y1, 0));
    out.in_frame = (iw * ih) / bboxArea;

    if (Number.isFinite(cfg.minAreaRatio) && out.area_ratio < cfg.minAreaRatio) reasons.push('too_small');
    if (Number.isFinite(cfg.maxAreaRatio) && out.area_ratio > cfg.maxAreaRatio) reasons.push('too_large');
    if (Number.isFinite(cfg.minHeightRatio) && out.height_ratio < cfg.minHeightRatio) reasons.push('too_small');
    if (Number.isFinite(cfg.maxHeightRatio) && out.height_ratio > cfg.maxHeightRatio) reasons.push('too_large');
    if (Number.isFinite(cfg.minInFrame) && out.in_frame < cfg.minInFrame) reasons.push('out_of_frame');
  }

  if (Number.isFinite(cfg.minShoulderVis) && Number.isFinite(visShoulder)
    && visShoulder < cfg.minShoulderVis) reasons.push('low_shoulder');
  if (Number.isFinite(cfg.minTorsoVis) && Number.isFinite(visTorso)
    && visTorso < cfg.minTorsoVis) reasons.push('low_torso');

  // 去重（面积/高度可能同时触发 too_small），保持诊断顺序稳定。
  out.reasons = [...new Set(reasons)];
  out.ok = out.reasons.length === 0;
  return out;
}

const PERSON_ANCHORS_HEAD = [0, 1, 2, 7, 8]; // 鼻尖 + 双肩 + 双髋（手部包含门）

/**
 * 姿态人物有效性门（perception.personGate）。
 *
 * 低清晰度特写里 MediaPipe 会把「手 + 取样管」补成一个人：鼻子/双肩/双髋可见度都很高，
 * 但 bbox 可能是 62×599 的细长条，躯干比 bbox 还长。真人不会出现这些几何。
 * 判定只使用姿态本身（不依赖手部模型），缺 bbox/kp 时 fail-open——旧数据/测试夹具
 * 不因为少字段被判掉。
 */
export function personPlausibility(person, frameW, frameH, cfg = {}) {
  const enabled = cfg?.enabled !== false;
  const out = {
    enabled, ok: true, known: false, reasons: [],
    aspect: null, torso_h: null, torso_drop: null, anchor_vis: null, score: null,
  };
  if (!enabled) return out;

  const bbox = person?.bbox;
  if (!Array.isArray(bbox) || bbox.length < 4 || !bbox.slice(0, 4).every(isNum)) return out;
  const bw = bbox[2] - bbox[0];
  const bh = bbox[3] - bbox[1];
  if (!(bw > 0 && bh > 0)) return out;
  const kp = person?.kp;
  if (!Array.isArray(kp) || kp.length < 9) return out;
  const shL = kp[1], shR = kp[2], hipL = kp[7], hipR = kp[8];
  if (![shL, shR, hipL, hipR].every((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]))) return out;

  out.known = true;
  out.score = isNum(person.score) ? person.score : null;
  out.aspect = bw / bh;
  const shMid = [(shL[0] + shR[0]) / 2, (shL[1] + shR[1]) / 2];
  const hipMid = [(hipL[0] + hipR[0]) / 2, (hipL[1] + hipR[1]) / 2];
  const torso = Math.hypot(shMid[0] - hipMid[0], shMid[1] - hipMid[1]);
  out.torso_h = torso / bh;
  // 图像 y 向下：髋中点 y 大于肩中点 y 才算「髋在肩下」。设备特写被补成的人
  // 经常整条躯干水平甚至倒置（髋在肩上），这是与真人区分度最高的几何信号。
  out.torso_drop = torso > 1e-6 ? (hipMid[1] - shMid[1]) / torso : null;
  const vis = [shL[2], shR[2], hipL[2], hipR[2]].filter(isNum);
  out.anchor_vis = vis.length ? Math.min(...vis) : null;

  if (out.score != null && Number.isFinite(cfg.minScore) && out.score < cfg.minScore) {
    out.reasons.push('low_score');
  }
  if (out.anchor_vis != null && Number.isFinite(cfg.minAnchorVis) && out.anchor_vis < cfg.minAnchorVis) {
    out.reasons.push('low_anchor_vis');
  }
  if (Number.isFinite(cfg.minAspect) && out.aspect < cfg.minAspect) out.reasons.push('bbox_too_narrow');
  if (Number.isFinite(cfg.maxAspect) && out.aspect > cfg.maxAspect) out.reasons.push('bbox_too_wide');
  if (Number.isFinite(cfg.maxTorsoHeight) && out.torso_h > cfg.maxTorsoHeight) {
    out.reasons.push('torso_too_long');
  }
  if (out.torso_drop == null) {
    out.reasons.push('torso_degenerate');
  } else if (Number.isFinite(cfg.minTorsoDrop) && out.torso_drop < cfg.minTorsoDrop) {
    out.reasons.push('torso_not_vertical');
  }
  out.ok = out.reasons.length === 0;
  return out;
}

/**
 * 手部包含门：真人整块身体（鼻/肩/髋）不会落在同一只手的 bbox 里。
 * 低清晰度特写里「手 + 取样管」被补成的人会满足下面任一条：
 *   - 至少 minAnchors 个锚点落在手框（外扩 expand）内；
 *   - 手框面积 ≥ 人体框的 maxHandAreaRatio；
 *   - 全部关键点几乎都在手框里（minAllKp）。
 * 没有手数据/缺字段时不做判定（fail-open）。
 */
/**
 * 骨架绘制门（与动作判定分离）：设备/工件特写被补成的人多是倒置躯干，动作层的
 * Hold 需要连续帧，不能逐帧剔除，所以只在绘制时用 `drawMinTorsoDrop` 挡掉。
 * 返回 true=可以画（缺字段 fail-open）。cfg 用 perception.personGate。
 */
export function personDisplayable(person, frameW, frameH, cfg = {}) {
  if (!cfg || cfg.enabled === false) return true;
  const drawDrop = Object.prototype.hasOwnProperty.call(cfg, 'drawMinTorsoDrop')
    ? cfg.drawMinTorsoDrop
    : 0;
  return personPlausibility(person, frameW, frameH, { ...cfg, minTorsoDrop: drawDrop }).ok;
}

export function personCoveredByHand(person, hands, cfg = {}) {
  const out = { enabled: cfg?.enabled !== false, covered: false, known: false, reasons: [],
    anchors_inside: null, hand_area_ratio: null, kp_inside: null };
  if (!out.enabled) return out;
  const bbox = person?.bbox;
  const kp = person?.kp;
  if (!Array.isArray(bbox) || bbox.length < 4 || !Array.isArray(kp) || kp.length < 9) return out;
  if (!Array.isArray(hands) || !hands.length) return out;

  const bw = bbox[2] - bbox[0];
  const bh = bbox[3] - bbox[1];
  if (!(bw > 0 && bh > 0)) return out;
  const personArea = bw * bh;
  const expand = Number.isFinite(cfg.expand) ? cfg.expand : 0.15;
  const minAnchors = Number.isFinite(cfg.minAnchors) ? cfg.minAnchors : 4;
  const maxRatio = Number.isFinite(cfg.maxHandAreaRatio) ? cfg.maxHandAreaRatio : 0.5;
  const minAllKp = Number.isFinite(cfg.minAllKp) ? cfg.minAllKp : 9;

  out.known = true;
  out.anchors_inside = 0;
  out.hand_area_ratio = 0;
  out.kp_inside = 0;
  for (const hand of hands) {
    const hb = hand?.bbox;
    if (!Array.isArray(hb) || hb.length < 4 || !hb.slice(0, 4).every(isNum)) continue;
    const hw = hb[2] - hb[0];
    const hh = hb[3] - hb[1];
    if (!(hw > 0 && hh > 0)) continue;
    const box = [hb[0] - hw * expand, hb[1] - hh * expand, hb[2] + hw * expand, hb[3] + hh * expand];
    const inside = (p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1])
      && p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];
    const anchors = PERSON_ANCHORS_HEAD.filter((i) => inside(kp[i])).length;
    const all = kp.filter((p) => inside(p)).length;
    const ratio = (hw * hh) / personArea;
    out.anchors_inside = Math.max(out.anchors_inside, anchors);
    out.kp_inside = Math.max(out.kp_inside, all);
    out.hand_area_ratio = Math.max(out.hand_area_ratio, ratio);
    if (anchors >= minAnchors) out.reasons.push('anchors_in_hand');
    if (ratio >= maxRatio) out.reasons.push('hand_covers_body');
    if (all >= minAllKp) out.reasons.push('all_kp_in_hand');
  }
  out.reasons = [...new Set(out.reasons)];
  out.covered = out.reasons.length > 0;
  return out;
}

/** MediaPipe 33 点 raw → 9 个头部点（像素 + visibility）；数据不足返回 null。 */
export function headPointsFromRaw(raw33, frameW, frameH) {
  const fw = Number(frameW);
  const fh = Number(frameH);
  if (!Array.isArray(raw33) || raw33.length < 33 || !(fw > 0 && fh > 0)) return null;
  const out = [];
  for (let i = 0; i < HEAD_KPT.length; i++) {
    const p = raw33[i];
    if (!p || !isNum(p.x) || !isNum(p.y)) return null;
    out.push([p.x * fw, p.y * fh, p.visibility ?? 0]);
  }
  return out;
}

/** 点到线段的最短距离。 */
function pointSegmentDistance(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

/** 两条线段是否相交（含端点接触）。 */
function segmentsIntersect(p1, p2, p3, p4) {
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // 共线/端点接触：用点到线段距离判断
  return pointSegmentDistance(p1, p3, p4) < 1e-9 || pointSegmentDistance(p2, p3, p4) < 1e-9
    || pointSegmentDistance(p3, p1, p2) < 1e-9 || pointSegmentDistance(p4, p1, p2) < 1e-9;
}

/** 点到轴对齐矩形的距离（框内为 0）。 */
export function pointBoxDistance(x, y, box) {
  if (!isNum(x) || !isNum(y) || !Array.isArray(box) || box.length < 4) return NaN;
  const dx = x < box[0] ? box[0] - x : x > box[2] ? x - box[2] : 0;
  const dy = y < box[1] ? box[1] - y : y > box[3] ? y - box[3] : 0;
  return Math.hypot(dx, dy);
}

/**
 * 线段（腕→肘）到轴对齐矩形的距离；相交为 0。
 * 用途：手被面板挡住时腕点会漂，但前臂仍然贴着设备——比只看腕点稳。
 * 非相交情况下，线段与凸多边形的最近距离一定在「线段端点 → 矩形」或
 * 「矩形顶点 → 线段」上取得，所以取这 6 个候选的最小值即可。
 */
export function segmentBoxDistance(a, b, box) {
  if (!Array.isArray(a) || !Array.isArray(b) || !Array.isArray(box) || box.length < 4) return NaN;
  const x1 = box[0]; const y1 = box[1]; const x2 = box[2]; const y2 = box[3];
  const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  const inside = (p) => p[0] >= x1 && p[0] <= x2 && p[1] >= y1 && p[1] <= y2;
  if (inside(a) || inside(b)) return 0;
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return 0;
  }
  let best = Math.min(pointBoxDistance(a[0], a[1], box), pointBoxDistance(b[0], b[1], box));
  for (const c of corners) best = Math.min(best, pointSegmentDistance(c, a, b));
  return best;
}
