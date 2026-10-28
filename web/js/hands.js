// hands.js — 手部感知：MediaPipe HandLandmarker（每只手 21 点）
// 手势分类在 handshape.js（纯函数，可 Node 单测），这里只负责推理与格式转换。

import { FilesetResolver, HandLandmarker } from '../vendor/vision_bundle.mjs';
import { HAND_CONNECTIONS } from './kpt.js';

export { HAND_CONNECTIONS };
export { FINGERS, SHAPE_LABELS, classifyHand } from './handshape.js';

let vision = null;
let landmarker = null;
let currentKey = '';

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
  if (landmarker && key === currentKey) return landmarker;

  if (!vision) vision = await FilesetResolver.forVisionTasks(asset('../vendor/wasm'));
  if (landmarker) {
    try { landmarker.close(); } catch { /* ignore */ }
    landmarker = null;
  }

  landmarker = await HandLandmarker.createFromOptions(vision, {
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
  currentKey = key;
  return landmarker;
}

export function handsReady() { return !!landmarker; }

/** 释放 GPU/内存 */
export function closeHandEstimator() {
  if (landmarker) {
    try { landmarker.close(); } catch { /* ignore */ }
    landmarker = null;
  }
  currentKey = '';
}

export function detectHandsVideo(video, tsMs) {
  if (!landmarker) throw new Error('hand estimator not ready');
  return landmarker.detectForVideo(video, tsMs);
}

export function detectHandsImage(image) {
  if (!landmarker) throw new Error('hand estimator not ready');
  return landmarker.detect(image);
}

/**
 * MediaPipe 手部结果 → 统一结构
 * 实现放在 handformat.js（纯函数，可 Node 单测），这里只做转出。
 */
export { toHands } from './handformat.js';
