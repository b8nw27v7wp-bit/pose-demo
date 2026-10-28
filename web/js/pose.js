// pose.js — L1 感知适配层
// 职责：把 MediaPipe PoseLandmarker 的输出映射成统一数据契约（见 docs/frame-schema.md）。
// 本文件不含任何语义判定，只输出坐标、置信度、尺度锚点。

import { FilesetResolver, PoseLandmarker } from '../vendor/vision_bundle.mjs';
import { KPT, MP_INDEX, POSE_CONNECTIONS, IDX } from './kpt.js';

// 关键点格式定义在 kpt.js（纯数据，可被 Node 单测导入），这里只做转出
export { KPT, MP_INDEX, POSE_CONNECTIONS };

let vision = null;
let landmarker = null;
let currentKey = '';

const asset = (p) => new URL(p, import.meta.url).href;

/**
 * 创建/切换姿态估计器。模型或 delegate 变化时会重建实例。
 * @param {{model?: 'full'|'lite', delegate?: 'GPU'|'CPU', runningMode?: 'VIDEO'|'IMAGE', numPoses?: number}} opts
 */
export async function createEstimator(opts = {}) {
  const {
    model = 'full',
    delegate = 'GPU',
    runningMode = 'VIDEO',
    numPoses = 1,
    detConf = 0.5,
    presenceConf = 0.5,
    trackingConf = 0.5,
  } = opts;
  const key = `${model}|${delegate}|${runningMode}|${numPoses}|${detConf}|${presenceConf}|${trackingConf}`;
  if (landmarker && key === currentKey) return landmarker;

  if (!vision) {
    vision = await FilesetResolver.forVisionTasks(asset('../vendor/wasm'));
  }
  if (landmarker) {
    try { landmarker.close(); } catch { /* ignore */ }
    landmarker = null;
  }

  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: asset(`../models/pose_landmarker_${model}.task`),
      delegate,
    },
    runningMode,
    numPoses,
    minPoseDetectionConfidence: detConf,
    minPosePresenceConfidence: presenceConf,
    minTrackingConfidence: trackingConf,
  });
  currentKey = key;
  return landmarker;
}

export function estimatorInfo() {
  return { ready: !!landmarker, key: currentKey };
}

/** 释放 GPU/内存：停止输入或切模型前调用 */
export function closeEstimator() {
  if (landmarker) {
    try { landmarker.close(); } catch { /* ignore */ }
    landmarker = null;
  }
  currentKey = '';
}

export function detectVideo(video, tsMs) {
  if (!landmarker) throw new Error('estimator not ready');
  return landmarker.detectForVideo(video, tsMs);
}

export function detectImage(image) {
  if (!landmarker) throw new Error('estimator not ready');
  return landmarker.detect(image);
}

/** 尺度锚点：肩中点与髋中点的像素距离（躯干长）。全部距离类信号都除以它。 */
function torsoScalePx(kp) {
  const ls = kp[IDX.shoulder_L], rs = kp[IDX.shoulder_R];
  const lh = kp[IDX.hip_L], rh = kp[IDX.hip_R];
  const sx = (ls[0] + rs[0]) / 2, sy = (ls[1] + rs[1]) / 2;
  const hx = (lh[0] + rh[0]) / 2, hy = (lh[1] + rh[1]) / 2;
  return Math.hypot(sx - hx, sy - hy);
}

/**
 * MediaPipe 结果 → 统一 person 对象数组
 * @returns {Array<{track_id:number,bbox:number[],kp_format:string,kp:number[][],
 *                  kp_raw:object[],kp_world:number[][],scale:number,score:number}>}
 */
export function toPersons(result, w, h) {
  if (!result || !result.landmarks) return [];
  const out = [];
  for (let i = 0; i < result.landmarks.length; i++) {
    const raw = result.landmarks[i];
    if (!raw || raw.length < 33) continue;

    const kp = KPT.map((name) => {
      const p = raw[MP_INDEX[name]];
      return [p.x * w, p.y * h, p.visibility ?? 0];
    });

    const xs = raw.map((p) => p.x * w);
    const ys = raw.map((p) => p.y * h);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

    const world = result.worldLandmarks && result.worldLandmarks[i]
      ? result.worldLandmarks[i].map((p) => [p.x, p.y, p.z])
      : [];

    const vis = raw.reduce((s, p) => s + (p.visibility ?? 0), 0) / raw.length;

    out.push({
      track_id: i,
      bbox,
      kp_format: 'mediapipe33',
      kp,
      kp_raw: raw,
      kp_world: world,
      scale: torsoScalePx(kp),
      score: vis,
    });
  }
  return out;
}
