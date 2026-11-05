// tiles.js — 平铺检测的几何（纯函数，Node 可单测）
//
// 为什么单独一层：pose.js 顶部 import 了浏览器专用的 vision_bundle，
// Node 里不能直接导入。把"切块 / 去重"这些纯几何放在这里，单测才能跑。

/**
 * 平铺窗口：多人场景里人只有几十像素高，整帧缩到模型输入后不可检测。
 * 把画面切成 n×n 块、块间留 overlap，逐块检测再合并，等于把人放大后再送进模型。
 * 返回像素矩形。
 */
export function tileRects(w, h, tiles = 2, overlap = 0.2) {
  const n = Math.max(1, Math.min(4, Math.floor(tiles) || 1));
  if (n === 1) return [{ x: 0, y: 0, w, h }];
  const f = Math.max(0, Math.min(0.5, Number(overlap) || 0));
  // 相邻块重叠 = f × 块边长：n 块总覆盖 = n·tw - (n-1)·f·tw = w
  const tw = w / (n - (n - 1) * f);
  const th = h / (n - (n - 1) * f);
  const sx = (w - tw) / (n - 1);
  const sy = (h - th) / (n - 1);
  const out = [];
  for (let ry = 0; ry < n; ry++) {
    for (let rx = 0; rx < n; rx++) out.push({ x: rx * sx, y: ry * sy, w: tw, h: th });
  }
  return out;
}

const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const uni = area(a) + area(b) - inter;
  return uni > 0 ? inter / uni : 0;
}

/**
 * 合并各平铺块的检测：同一个人会落在重叠区/相邻块里被检出两次。
 * 按可见度从高到低保留，IoU > 0.5 视为同一人；最后按 maxPoses 截断。
 * @param {Array<{bbox:number[], score:number}>} poses bbox 为全图归一化坐标
 */
export function mergeTiledPoses(poses, maxPoses = 3) {
  const sorted = [...(poses || [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const kept = [];
  for (const p of sorted) {
    if (kept.some((k) => iou(k.bbox, p.bbox) > 0.5)) continue;
    kept.push(p);
    if (kept.length >= maxPoses) break;
  }
  return kept;
}
