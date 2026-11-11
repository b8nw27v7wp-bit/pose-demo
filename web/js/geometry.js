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

/** 旧矩形 {x,y,w,h} → 合法矩形（负宽高翻正）；非法返回 null，不 clamp。 */
export function normalizeRect(roi) {
  if (!roi || typeof roi !== 'object') return null;
  let { x, y, w, h } = roi;
  if (![x, y, w, h].every(isNum) || w === 0 || h === 0) return null;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
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
