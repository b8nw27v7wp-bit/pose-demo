// pose.js — L1 感知适配层
// 职责：把 MediaPipe PoseLandmarker 的输出映射成统一数据契约（见 docs/frame-schema.md）。
// 本文件不含任何语义判定，只输出坐标、置信度、尺度锚点。

import { FilesetResolver, PoseLandmarker } from '../vendor/vision_bundle.mjs';
import { KPT, MP_INDEX, POSE_CONNECTIONS, IDX } from './kpt.js';
import { tileRects, mergeTiledPoses } from './tiles.js';

// 关键点格式定义在 kpt.js（纯数据，可被 Node 单测导入），这里只做转出
export { KPT, MP_INDEX, POSE_CONNECTIONS };

let vision = null;
let landmarker = null;
let currentKey = '';

const asset = (p) => new URL(p, import.meta.url).href;

/**
 * 创建/切换姿态估计器。模型或 delegate 变化时会重建实例。
 * @param {{model?: 'full'|'heavy'|'lite', delegate?: 'GPU'|'CPU', runningMode?: 'VIDEO'|'IMAGE', numPoses?: number}} opts
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

// —— 多人估计器（IMAGE 模式）—— -------------------------------------------------
// 为什么要单开一个实例：VIDEO 模式的跟踪器只会锁定一个人（实测 numPoses=2 时
// max_persons 恒为 1），多人必须走 IMAGE 模式逐帧独立推理 —— 代价是丢掉模型内部的
// 帧间跟踪，所以 track_id 由我们自己维护（track.js）。两个实例共用同一份 wasm 运行时，
// 不会重复下载。
let multiLandmarker = null;
let multiKey = '';

export async function createMultiEstimator(opts = {}) {
  const {
    model = 'full', delegate = 'GPU', numPoses = 3,
    // 0.3 而不是单人道默认的 0.5：多人场景里远处那个人置信度天然低，
    // 实测同一张双人图 detConf=0.5 只回 1 人、0.3 回 2 人（docs 里记了这一条）。
    detConf = 0.3, presenceConf = 0.3,
  } = opts;
  const key = `${model}|${delegate}|${numPoses}|${detConf}|${presenceConf}`;
  if (multiLandmarker && key === multiKey) return multiLandmarker;

  if (!vision) vision = await FilesetResolver.forVisionTasks(asset('../vendor/wasm'));
  closeMultiEstimator();

  multiLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: asset(`../models/pose_landmarker_${model}.task`), delegate },
    runningMode: 'IMAGE',   // 关键：IMAGE 模式才会返回多个人
    numPoses: Math.max(1, Math.min(4, numPoses | 0)),
    minPoseDetectionConfidence: detConf,
    minPosePresenceConfidence: presenceConf,
  });
  multiKey = key;
  return multiLandmarker;
}

export function multiEstimatorInfo() {
  return { ready: !!multiLandmarker, key: multiKey };
}

export function closeMultiEstimator() {
  if (multiLandmarker) {
    try { multiLandmarker.close(); } catch { /* ignore */ }
    multiLandmarker = null;
  }
  multiKey = '';
}

/** IMAGE 模式下 detect() 可以直接吃 HTMLVideoElement / canvas / ImageBitmap，取当前帧 */
export function detectMultiImage(source) {
  if (!multiLandmarker) throw new Error('multi estimator not ready');
  return multiLandmarker.detect(source);
}

/**
 * 平铺版多人检测（IMAGE 模式）。块内检测 → 坐标映射回整帧 → 去重。
 * 成本是 n² 次推理：tiles=2 约 4 倍耗时，只在"远/小目标多人"场景打开。
 * 切块/去重几何在 tiles.js（纯函数，Node 可单测）。
 */
export function detectMultiTiled(source, w, h, { tiles = 2, overlap = 0.2, maxPoses = 3 } = {}) {
  if (!multiLandmarker) throw new Error('multi estimator not ready');
  const rects = tileRects(w, h, tiles, overlap);
  if (rects.length === 1) return multiLandmarker.detect(source);

  let canvas = tiledCanvas;
  if (!canvas) canvas = tiledCanvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const poses = [];

  for (const r of rects) {
    const tw = Math.max(1, Math.round(r.w));
    const th = Math.max(1, Math.round(r.h));
    canvas.width = tw;
    canvas.height = th;
    ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, tw, th);
    const res = multiLandmarker.detect(canvas);
    const lms = res?.landmarks || [];
    for (let i = 0; i < lms.length; i++) {
      const lm = lms[i];
      if (!lm || lm.length < 33) continue;
      // 映射回整帧归一化坐标；visibility 等其余字段原样保留
      const mapped = lm.map((p) => ({ ...p, x: (r.x + p.x * r.w) / w, y: (r.y + p.y * r.h) / h }));
      const xs = mapped.map((p) => p.x);
      const ys = mapped.map((p) => p.y);
      const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const score = mapped.reduce((s, p) => s + (p.visibility ?? 0), 0) / mapped.length;
      poses.push({ landmarks: mapped, worldLandmarks: res.worldLandmarks?.[i] || [], bbox, score });
    }
  }

  const kept = mergeTiledPoses(poses, Math.max(1, maxPoses));
  return {
    landmarks: kept.map((p) => p.landmarks),
    worldLandmarks: kept.map((p) => p.worldLandmarks),
  };
}

let tiledCanvas = null;


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

    // 平均置信度只统计**画面内**的点：上半身构图里，画面外的腿/脚本来就没有可见度，
    // 用 33 点全量平均会把整帧判成低置信（实测头~胸构图 0.63 → ok=false → 动作全冻结）。
    // 画面内点太少（<5，人体大部分出画）时退回全量平均，避免用一两个点代表整个人。
    const inFrame = raw.filter((p) => p.x >= -0.02 && p.x <= 1.02 && p.y >= -0.02 && p.y <= 1.02);
    const meanVis = (pts) => pts.reduce((s, p) => s + (p.visibility ?? 0), 0) / pts.length;
    const vis = meanVis(inFrame.length >= 5 ? inFrame : raw);

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
