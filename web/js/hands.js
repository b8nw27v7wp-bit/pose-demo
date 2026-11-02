// hands.js — 手部感知：MediaPipe HandLandmarker（每只手 21 点）
// 手势分类在 handshape.js（纯函数，可 Node 单测），这里只负责推理与格式转换。
//
// 两个实例按 runningMode 分开：
//   VIDEO  整帧追踪（正常输入）
//   IMAGE  只给「腕部 ROI 裁剪图」用 —— 全身出镜时手只有几十像素，整帧检测常常一只都检不到；
//          用姿态腕点裁一小块放大再检，命中率从 0/18 提到 18/18（实测，见 README）。
// 共用一个实例会把裁图当成视频的下一帧，跟踪状态（ROI、速度）会串，所以必须分开。

import { FilesetResolver, HandLandmarker } from '../vendor/vision_bundle.mjs';
import { HAND_CONNECTIONS } from './kpt.js';
import { toHands } from './handformat.js';
import { wristRoiBox, offsetHand, nearestWristSide } from './handroi.js';

export { HAND_CONNECTIONS };
export { FINGERS, SHAPE_LABELS, classifyHand } from './handshape.js';
// 页面与 verify.html 都从这里拿 toHands，别改成只从 handformat 导出
export { toHands };

let vision = null;
const slots = new Map();   // runningMode -> { landmarker, key }

const asset = (p) => new URL(p, import.meta.url).href;

export async function createHandEstimator(opts = {}) {
  const {
    delegate = 'GPU',
    runningMode = 'VIDEO',
    numHands = 2,
    detConf = 0.5,
    presenceConf = 0.5,
    trackingConf = 0.5,
  } = opts;
  const key = `${delegate}|${runningMode}|${numHands}|${detConf}|${presenceConf}|${trackingConf}`;
  const slot = slots.get(runningMode);
  if (slot && key === slot.key) return slot.landmarker;

  if (!vision) vision = await FilesetResolver.forVisionTasks(asset('../vendor/wasm'));
  if (slot?.landmarker) {
    try { slot.landmarker.close(); } catch { /* ignore */ }
    // 必须在建新实例前移出 map：createFromOptions 失败时，旧的（已 close 的）
    // 实例若还留在 slots 里，handsReady() 会返回 true，主循环随后每帧调用已释放的
    // 实例并抛异常，最终把整个手部功能自动关掉。
    slots.delete(runningMode);
  }

  const landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: asset('../models/hand_landmarker.task'),
      delegate,
    },
    runningMode,
    numHands,
    minHandDetectionConfidence: detConf,
    minHandPresenceConfidence: presenceConf,
    minTrackingConfidence: trackingConf,
  });
  slots.set(runningMode, { landmarker, key });
  return landmarker;
}

export function handsReady(runningMode = 'VIDEO') {
  return !!slots.get(runningMode)?.landmarker;
}

/** 释放全部实例（两个模式都要关，漏一个就白占一份显存） */
export function closeHandEstimator() {
  for (const s of slots.values()) {
    try { s.landmarker.close(); } catch { /* ignore */ }
  }
  slots.clear();
}

function requireLandmarker(runningMode) {
  const lm = slots.get(runningMode)?.landmarker;
  if (!lm) throw new Error('hand estimator not ready');
  return lm;
}

export function detectHandsVideo(video, tsMs) {
  return requireLandmarker('VIDEO').detectForVideo(video, tsMs);
}

export function detectHandsImage(image) {
  return requireLandmarker('IMAGE').detect(image);
}

// ROI 裁图统一放大到 320×320：手在裁图里至少占一两百像素，模型才分得清手指。
// 复用同一块 canvas，避免每帧分配。
let roiCanvas = null;
let roiCtx = null;

/**
 * 腕部 ROI 手部检测：对每个需要补检的手，用姿态腕点裁一块放大再检。
 *
 * 为什么需要：全身/远景构图里手只有 30~80 像素，整帧 HandLandmarker 实测 0 命中；
 * 裁到腕点附近放大后同一模型 100% 命中。副作用是每次补检多一次推理——
 * 所以只在整帧漏检、且腕点可见时才做。
 *
 * @param {HTMLVideoElement|HTMLCanvasElement} source 整帧画面
 * @param {Array<{side:'L'|'R', x:number, y:number, vis:number}>} wrists 需补检的腕点
 * @param {{mul?:number,minPx?:number,maxPx?:number,maxCenterOffset?:number}} cfg
 * @param {{w:number,h:number}} frame 整帧尺寸
 * @param {Array} [allWrists] 该人的全部腕点（含已检出的那一侧）。
 *   用来确认「裁图里检出的这只手」确实是所裁那一侧：双手靠得近时，裁右腕的框里
 *   很可能只检出左手。判据是检出腕点离哪个姿态腕点最近，而不是固定偏移阈值。
 * @returns {Array} 与 toHands 同结构，坐标为整帧像素；handedness 由腕点所在侧决定
 */
export function detectHandsNearWrists(source, wrists, cfg, frame, allWrists = wrists) {
  const lm = slots.get('IMAGE')?.landmarker;
  if (!lm || !wrists.length) return [];
  if (!roiCanvas) {
    roiCanvas = document.createElement('canvas');
    roiCanvas.width = 320;
    roiCanvas.height = 320;
    roiCtx = roiCanvas.getContext('2d');
  }
  const out = [];
  for (const w of wrists) {
    const box = wristRoiBox(w, cfg, frame);
    if (!box) continue;
    roiCtx.clearRect(0, 0, roiCanvas.width, roiCanvas.height);
    roiCtx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, roiCanvas.width, roiCanvas.height);
    let res;
    try { res = lm.detect(roiCanvas); } catch { continue; }
    const hands = toHands(res, box.w, box.h);
    if (!hands.length) continue;
    // 只收离裁图中心最近的一只：手靠得近时裁图里可能同时出现另一只手
    let best = null;
    let bestD = Infinity;
    for (const h of hands) {
      const d = Math.hypot(h.kp[0][0] - box.w / 2, h.kp[0][1] - box.h / 2);
      if (d < bestD) { bestD = d; best = h; }
    }
    if (!best || bestD > (cfg.maxCenterOffset ?? 0.6) * box.w) continue;

    // 检出的是哪只手：比较检出腕点到该人所有姿态腕点的距离。
    // 与所裁腕点不是同一个侧就别收——否则「裁右腕、检出左手」会被标成右手。
    const side = nearestWristSide(box.x + best.kp[0][0], box.y + best.kp[0][1], allWrists);
    if (side !== w.side) continue;

    out.push({
      ...offsetHand(best, box.x, box.y),
      // 侧别采信姿态腕点：MediaPipe 的 handedness 假设自拍镜像输入，
      // 上传的普通视频会被反过来，用腕点归一化后就不受这条约定影响。
      handedness: w.side === 'L' ? 'Left' : 'Right',
      side_from: 'roi',
    });
  }
  return out;
}
