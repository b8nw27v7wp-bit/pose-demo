// objects.js — 物体检测适配层（L1 感知的另一条流水线）
//
// 为什么单独一层：PPE（安全帽/手套）、设备状态（夹子/轮挡/阀门）都不是姿态问题，
// 它们要的是"画面上有没有这个物体、在哪"。靠 33 点关键点判不出来，也不该判。
// 这一层只输出 {label, score, box}，不做任何语义——判定在 ppe.js / 事件层。
//
// 模型选型：MediaPipe Tasks ObjectDetector（Apache-2.0），任何满足 Tasks 格式的
// .tflite 都能直接换（先 efficientdet_lite0 验证链路，再换自训的安全帽/手套模型）。
// 第二条后端是 ONNX（objects-onnx.js，onnxruntime-web），给自训 YOLOv8 用：
// 原生 Windows 装不上 MediaPipe Model Maker，自训只能走 Ultralytics→ONNX。
// **注意 Ultralytics YOLOv8 权重是 AGPL-3.0**：冒烟验证可以，闭源商用要么买
// Enterprise 授权，要么换 Apache/BSD 许可的检测器（例如 RT-DETR 的官方权重）。
//
// 标签从模型的 label map 里来（categoryName）。模型没带 label map 时是 null：
// 那时只能看 index，PPE 判定会退化成 unknown——这是刻意的，不要按 index 猜类别。
// ONNX 没有 label map，标签由 profile 的 perception.objects.labels 按类别顺序给出。

import { FilesetResolver, ObjectDetector } from '../vendor/vision_bundle.mjs';

let vision = null;
let detector = null;
let currentKey = '';
let lastError = null;
let usedDelegate = null;

// 'mediapipe' | 'onnx'；onnx 的模型实例在 objects-onnx.js 里单独管
let backend = 'mediapipe';
let onnxMod = null;
// 创建/关闭代次：切换后端时，晚到的旧创建不能再把 backend/detector 改回去
let epoch = 0;

const checkEpoch = (myEpoch) => {
  if (myEpoch !== epoch) throw new Error('物体检测创建被新的请求取代');
};

const asset = (p) => new URL(p, import.meta.url).href;

/**
 * 建好后自检一次。
 *
 * 为什么需要：GPU delegate 对模型算子有要求，不支持时不是在 createFromOptions 报错，
 * 而是在**第一次推理**时从 wasm 里抛 "RuntimeError: divide by zero"（实测 efficientdet_lite0
 * 必现，CPU 正常）。只按 create 成功与否判断，会得到一个"能加载、永远不出框"的检测器。
 * 自检用一张纯黑小图，只关心抛不抛异常，不关心结果。
 */
function selfTest(det, runningMode) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 32, 32);
  if (runningMode === 'VIDEO') det.detectForVideo(c, 1);
  else det.detect(c);
}

/**
 * 创建/切换物体检测器。
 * @param {{backend?:'mediapipe'|'onnx', model?:string, delegate?:'GPU'|'CPU',
 *          maxResults?:number, scoreThreshold?:number, runningMode?:'VIDEO'|'IMAGE',
 *          allowCpuFallback?:boolean, labels?:string[], inputSize?:number,
 *          iouThreshold?:number}} opts
 */
export async function createObjectDetector(opts = {}) {
  const myEpoch = ++epoch;
  const { backend: want = 'mediapipe' } = opts;
  if (want === 'onnx') {
    // 先把 backend 标成 onnx：创建失败时 objectInfo 也要如实报告 onnx 和错误，
    // 而不是继续指向一个已经被关掉的 mediapipe 检测器（errors 会被吞掉）。
    backend = 'onnx';
    try {
      onnxMod = onnxMod || await import('./objects-onnx.js');
      checkEpoch(myEpoch);
      closeMediapipe();
      await onnxMod.createOnnxDetector(opts);
      checkEpoch(myEpoch);
    } catch (e) {
      lastError = e?.message || String(e);
      throw e;
    }
    lastError = null;
    return onnxMod.onnxInfo();
  }

  const {
    model = 'efficientdet_lite0.tflite',
    delegate = 'GPU',
    maxResults = 8,
    scoreThreshold = 0.35,
    runningMode = 'VIDEO',
    allowCpuFallback = true,
  } = opts;
  const key = `${model}|${delegate}|${maxResults}|${scoreThreshold}|${runningMode}`;
  if (backend === 'mediapipe' && detector && key === currentKey) return detector;

  // 切回 mediapipe 时先把 backend 标回来：如果这里创建失败，objectInfo 也要如实报告
  // mediapipe（而不是继续指向已经关掉的 onnx），否则下一次创建成功后 detectObjects
  // 还会走 onnx 分支，得到一个"永远 not ready"的检测器。
  backend = 'mediapipe';
  if (!vision) vision = await FilesetResolver.forVisionTasks(asset('../vendor/wasm'));
  checkEpoch(myEpoch);
  closeOnnxDetector();
  closeMediapipe();

  const candidates = allowCpuFallback && delegate !== 'CPU' ? [delegate, 'CPU'] : [delegate];
  let lastErr = null;
  for (const d of candidates) {
    let det = null;
    try {
      det = await ObjectDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: asset(`../models/${model}`), delegate: d },
        runningMode,
        maxResults,
        scoreThreshold,
      });
      selfTest(det, runningMode);
    } catch (e) {
      if (myEpoch !== epoch) {
        try { det?.close(); } catch { /* ignore */ }
        throw new Error('物体检测创建被新的请求取代');
      }
      lastErr = e?.message || String(e);
      try { det?.close(); } catch { /* ignore */ }
      det = null;
      continue;
    }
    detector = det;
    usedDelegate = d;
    currentKey = key;
    lastError = null;
    return detector;
  }

  lastError = lastErr;
  // 最常见的原因是模型文件没下载（web/models/ 不进 git）。把可操作的话放在错误里，
  // 否则页面上只会看到 "Failed to fetch" 之类的无信息报错。
  throw new Error(`物体检测模型加载失败（models/${model}，delegate 试过 ${candidates.join('/')}）：`
    + `${lastError}。先跑 python scripts/fetch-assets.py，或把自训的 .tflite 放进 web/models/。`);
}

export function objectInfo() {
  if (backend === 'onnx') {
    if (onnxMod) return onnxMod.onnxInfo();
    return { ready: false, backend: 'onnx', key: '', error: lastError, delegate: null };
  }
  return { ready: !!detector, backend: 'mediapipe', key: currentKey, error: lastError, delegate: usedDelegate };
}

function closeMediapipe() {
  if (detector) {
    try { detector.close(); } catch { /* ignore */ }
    detector = null;
  }
  currentKey = '';
  usedDelegate = null;
}

function closeOnnxDetector() {
  if (onnxMod) onnxMod.closeOnnxDetector();
}

export function closeObjectDetector() {
  epoch++;          // 在途创建看到代次变化后会自行放弃/释放
  closeMediapipe();
  closeOnnxDetector();
  backend = 'mediapipe';
}

export function detectObjectsVideo(source, tsMs) {
  if (backend !== 'mediapipe' || !detector) throw new Error('mediapipe object detector not ready');
  return detector.detectForVideo(source, tsMs);
}

export function detectObjectsImage(source) {
  if (backend !== 'mediapipe' || !detector) throw new Error('mediapipe object detector not ready');
  return detector.detect(source);
}

/**
 * 统一检测入口。
 * MediaPipe 同步返回数组；ONNX 需要 fetch 式推理，返回 Promise。调用方按
 * `typeof ret?.then === 'function'` 区分，别在视频循环里无脑 await（会卡住 rAF）。
 * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} source
 * @param {number} tsMs 视频时间戳（MediaPipe 需要；ONNX 不用）
 * @param {number} w 画布宽
 * @param {number} h 画布高
 * @returns {Array|Promise<Array>} [{category,label,score,box}]
 */
export function detectObjects(source, tsMs, w, h) {
  if (backend === 'onnx') {
    if (!onnxMod) throw new Error('onnx object detector not ready');
    return onnxMod.detectOnnx(source, w, h);
  }
  if (!detector) throw new Error('物体检测器未就绪');
  return toObjects(detector.detectForVideo(source, tsMs), w, h);
}

/**
 * 结果 → [{category, label, score, box:[x1,y1,x2,y2]}]（像素）
 * box 用左上/右下两点的形式，与 person.bbox 同口径：判定层不必区分来源。
 */
export function toObjects(result, w, h) {
  const list = result?.detections;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    const bb = d.boundingBox;
    if (!bb) continue;
    const x1 = bb.originX * w;
    const y1 = bb.originY * h;
    const x2 = (bb.originX + bb.width) * w;
    const y2 = (bb.originY + bb.height) * h;
    const cat = d.categories?.[0] || {};
    out.push({
      category: cat.index ?? -1,
      // 没有 label map 时 categoryName 是空串：给 null，别用 "类别0" 假装知道
      label: cat.categoryName || cat.displayName || null,
      score: cat.score ?? 0,
      box: [x1, y1, x2, y2],
    });
  }
  return out;
}

/** 本场是否检出过某个标签（PPE 的 requirePositive 依赖它） */
export function countByLabel(objects, matcher) {
  let n = 0;
  for (const o of objects || []) if (matcher(o.label)) n++;
  return n;
}
