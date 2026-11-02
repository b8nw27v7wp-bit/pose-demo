// handroi.js — 腕部 ROI 的几何（纯函数，无浏览器依赖，可在 Node 里单测）
//
// 全身/远景构图里手只有几十像素，整帧 HandLandmarker 几乎检不到；以姿态腕点为中心
// 裁一小块放大再推理是标准做法。这里只放「框怎么取」和「坐标怎么回映射」，
// 真正的推理与 canvas 在 hands.js。

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 以腕点为中心取一个正方形 ROI，并整体挪进画面内（不改变大小）。
 *
 * 为什么不在画面外补黑边：drawImage 的源矩形越界时，规格允许裁剪并按比例调整目标矩形，
 * 映射会变得难以复现。整体平移保证裁出的图与 box 一一对应。
 *
 * @param {{x:number,y:number,scale:number}} wrist 腕点（整帧像素）与躯干尺度
 * @param {{mul?:number,minPx?:number,maxPx?:number}} cfg
 * @param {{w:number,h:number}} [frame] 整帧尺寸
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function wristRoiBox(wrist, cfg = {}, frame = null) {
  const { mul = 1.8, minPx = 64, maxPx = 480 } = cfg;
  const scale = wrist?.scale;
  if (!Number.isFinite(scale) || !(scale > 0)) return null;

  let size = clamp(scale * mul, minPx, maxPx);
  const fw = frame?.w;
  const fh = frame?.h;
  if (Number.isFinite(fw) && fw > 0) size = Math.min(size, fw);
  if (Number.isFinite(fh) && fh > 0) size = Math.min(size, fh);
  if (!(size > 0)) return null;

  const x = Number.isFinite(fw) ? clamp(wrist.x - size / 2, 0, fw - size) : wrist.x - size / 2;
  const y = Number.isFinite(fh) ? clamp(wrist.y - size / 2, 0, fh - size) : wrist.y - size / 2;
  return { x, y, w: size, h: size };
}

/**
 * 把「以裁剪图为坐标系」的手部结果平移到整帧坐标。
 * 裁剪图归一化坐标已由 toHands(res, box.w, box.h) 换成裁剪图内的像素。
 */
export function offsetHand(hand, dx, dy) {
  return {
    ...hand,
    kp: hand.kp.map(([x, y, z]) => [x + dx, y + dy, z]),
    bbox: [hand.bbox[0] + dx, hand.bbox[1] + dy, hand.bbox[2] + dx, hand.bbox[3] + dy],
  };
}

/**
 * 裁图里检出的手属于哪一侧：比较它的腕点到该人所有姿态腕点的距离，取最近的那个。
 * 手靠得近时（双手在胸前），裁右腕的框里可能只检出左手——只有靠这个归属判断才能发现。
 * @returns {'L'|'R'|null}
 */
export function nearestWristSide(x, y, wrists) {
  let best = null;
  let bestD = Infinity;
  for (const q of wrists || []) {
    const d = Math.hypot(q.x - x, q.y - y);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best ? best.side : null;
}

/** 从 (side,x,y,vis) 列表里挑出需要补检的腕点（可见性够、没有同名 side） */
export function wristsToRetry(wrists, haveSides, visMin = 0.3) {
  return wrists.filter((w) => !haveSides.has(w.side) && (w.vis ?? 0) >= visMin);
}
