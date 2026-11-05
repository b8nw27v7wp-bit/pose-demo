// objects-onnx.js — YOLOv8 ONNX 物体检测后端（onnxruntime-web）
//
// 为什么有这条后端：MediaPipe Tasks 只吃 .tflite，而本机（原生 Windows）装不上
// MediaPipe Model Maker（tensorflow-text / tflite-support 没有 Windows wheel），
// 自训安全帽/手套模型只能走「Ultralytics 训练 → 导出 ONNX → 浏览器 ORT」。
//
// 输入输出口径与 objects.js 的 MediaPipe 后端一致：{label, score, box:[x1,y1,x2,y2]}（像素）。
// 上层（ppe.js / app.js）不关心是哪条后端。
//
// 依赖（都不进 git，用 scripts/fetch-ort.mjs 下载）：
//   web/vendor/ort/ort.wasm.bundle.min.mjs
//   web/vendor/ort/ort-wasm-simd-threaded.wasm
//   web/models/ppe_smoke.onnx
//
// 模型格式：Ultralytics `yolo export format=onnx` 的默认输出，[1, 4+nc, N]，
// 框已解码成 cx,cy,w,h（输入图像素坐标），类别分数是 sigmoid 后的概率。
// 若是 [1, N, 4+nc]（少数导出工具/自定义导出），下面按维度自动识别。

const DEFAULT_INPUT = 320;
const PAD_VALUE = 114;          // YOLO 训练/导出时的 letterbox 填充色

let ort = null;
let session = null;
let currentKey = '';
let lastError = null;
let runMs = 0;   // 单次 session.run 的 EMA（毫秒）：代理到 worker 后主线程测不到推理耗时
// 创建/关闭的代次：并发创建或关闭时，晚到的旧创建不能覆盖新实例（会泄漏 ORT worker）。
let epoch = 0;

// 当前模型的元信息（session 建好后填）
let meta = {
  model: '', inputW: DEFAULT_INPUT, inputH: DEFAULT_INPUT,
  labels: [], numClasses: 0, outputName: '', outC: 0, outN: 0, nMajor: false,
  scoreThreshold: 0.35, iouThreshold: 0.45, maxResults: 8,
};

// 预处理用的画布/缓冲区，逐帧复用（每帧 new 一次 ImageData 会有 GC 抖动）
let canvas = null;
let ctx2d = null;
let rgba = null;
let chw = null;

const asset = (p) => new URL(p, import.meta.url).href;

async function loadOrt() {
  if (ort) return ort;
  try {
    ort = await import('../vendor/ort/ort.wasm.bundle.min.mjs');
  } catch (e) {
    throw new Error(`onnxruntime-web 未安装（web/vendor/ort/）。先跑 node scripts/fetch-ort.mjs。原始错误：${e?.message || e}`);
  }
  ort.env.wasm.wasmPaths = asset('../vendor/ort/');
  // 没有 COOP/COEP 头时没有 SharedArrayBuffer，多线程会直接抛错；退回单线程。
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  ort.env.wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  // 用 worker 跑 wasm：proxy=false 时推理同步占用主线程 ~100ms/帧，姿态的 rAF 循环
  // 会被拖到 10fps 以下（实测 28fps → 9.4fps）。proxy=true 把 ORT 放进 Web Worker，
  // 主线程只收结果；代价是多一次线程间拷贝。
  ort.env.wasm.proxy = true;
  return ort;
}

function ensureBuffers(w, h) {
  if (canvas && canvas.width === w && canvas.height === h) return;
  canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  rgba = null;
  chw = new Float32Array(3 * w * h);
}

/**
 * letterbox：保持长宽比缩放到输入尺寸，居中填充 114（与 Ultralytics 的 letterbox 一致）。
 * 返回 scale/pad，用于把输出框映射回原图像素坐标。
 */
function letterbox(source, sw, sh, w, h) {
  const scale = Math.min(w / sw, h / sh);
  const nw = Math.max(1, Math.round(sw * scale));
  const nh = Math.max(1, Math.round(sh * scale));
  const padX = Math.floor((w - nw) / 2);
  const padY = Math.floor((h - nh) / 2);
  ctx2d.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`;
  ctx2d.fillRect(0, 0, w, h);
  ctx2d.drawImage(source, 0, 0, sw, sh, padX, padY, nw, nh);
  return { scale, padX, padY, nw, nh };
}

/** 画布 → CHW float32（0~255 → 0~1），RGB 顺序。 */
function toChw(w, h) {
  rgba = ctx2d.getImageData(0, 0, w, h);
  const src = rgba.data;
  const plane = w * h;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    const r = src[p] / 255;
    const g = src[p + 1] / 255;
    const b = src[p + 2] / 255;
    chw[i] = r;
    chw[plane + i] = g;
    chw[plane * 2 + i] = b;
  }
  return chw;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter || 1);
}

/** 逐类别 NMS：安全帽和人的框天然重叠，跨类别一起抑制会把 person 吃掉。 */
function nms(list, thr, maxResults) {
  const byClass = new Map();
  for (const o of list) {
    if (!byClass.has(o.category)) byClass.set(o.category, []);
    byClass.get(o.category).push(o);
  }
  const kept = [];
  for (const group of byClass.values()) {
    group.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const cand of group) {
      if (picked.some((k) => iou(k.box, cand.box) >= thr)) continue;
      picked.push(cand);
      if (picked.length >= maxResults) break;
    }
    kept.push(...picked);
  }
  kept.sort((a, b) => b.score - a.score);
  return kept.slice(0, maxResults);
}

/**
 * YOLOv8 检测头解码（纯函数，便于单测）。
 * @param {Float32Array} data 输出张量
 * @param {number[]} dims 输出维度，[1, 4+nc, N] 或 [1, N, 4+nc]
 * @param {{labels:string[], scoreThreshold:number, iouThreshold:number, maxResults:number}} cfg
 * @param {{scale:number, padX:number, padY:number}} letter
 * @param {number} sw 原图宽
 * @param {number} sh 原图高
 */
export function decodeYolo(data, dims, cfg, letter, sw, sh) {
  if (!Array.isArray(dims) || dims.length !== 3) throw new Error(`输出维度不是 3 维：${dims}`);
  const labels = cfg.labels || [];
  const scoreThreshold = cfg.scoreThreshold ?? 0.35;
  const iouThreshold = cfg.iouThreshold ?? 0.45;
  const maxResults = cfg.maxResults ?? Infinity;
  const a = dims[1];
  const b = dims[2];
  // 类别维度 = 4 + 类别数。真实模型 N 远大于 C，但单测里可能只有 2~4 个候选框，
  // 所以优先用 labels 的长度认；不知道 labels 时才退回「较小的一维是 C」。
  const knownC = labels.length ? labels.length + 4 : 0;
  let outC;
  let outN;
  let nMajor;
  if (knownC && (a === knownC || b === knownC)) {
    outC = knownC;
    nMajor = b === knownC;
    outN = nMajor ? a : b;
  } else if (a <= b) {
    outC = a;
    outN = b;
    nMajor = false;
  } else {
    outC = b;
    outN = a;
    nMajor = true;
  }
  const numClasses = outC - 4;
  if (numClasses <= 0) throw new Error(`输出通道数 ${outC} 不像 YOLO 检测头`);
  if (labels.length > numClasses) {
    throw new Error(`labels 有 ${labels.length} 类，模型只有 ${numClasses} 类`);
  }
  const at = nMajor
    ? (i, c) => data[i * outC + c]
    : (i, c) => data[c * outN + i];

  const { scale, padX, padY } = letter;
  const out = [];
  for (let i = 0; i < outN; i++) {
    let best = 0;
    let bestC = -1;
    for (let c = 0; c < numClasses; c++) {
      const s = at(i, 4 + c);
      if (s > best) { best = s; bestC = c; }
    }
    if (bestC < 0 || best < scoreThreshold) continue;
    const cx = at(i, 0);
    const cy = at(i, 1);
    const bw = at(i, 2);
    const bh = at(i, 3);
    // letterbox 逆变换：先减 padding，再除以缩放
    const x1 = (cx - bw / 2 - padX) / scale;
    const y1 = (cy - bh / 2 - padY) / scale;
    const x2 = (cx + bw / 2 - padX) / scale;
    const y2 = (cy + bh / 2 - padY) / scale;
    const box = [
      Math.max(0, Math.min(sw, x1)), Math.max(0, Math.min(sh, y1)),
      Math.max(0, Math.min(sw, x2)), Math.max(0, Math.min(sh, y2)),
    ];
    if (box[2] - box[0] < 1 || box[3] - box[1] < 1) continue;
    out.push({ category: bestC, label: labels[bestC] || null, score: best, box });
  }
  return nms(out, iouThreshold, maxResults);
}

/**
 * 建/换 ONNX 检测器。
 * @param {{model?:string, labels?:string[], inputSize?:number,
 *          scoreThreshold?:number, iouThreshold?:number, maxResults?:number}} opts
 */
export async function createOnnxDetector(opts = {}) {
  const {
    model = 'ppe_smoke.onnx',
    labels = [],
    inputSize = DEFAULT_INPUT,
    scoreThreshold = 0.35,
    iouThreshold = 0.45,
    maxResults = 8,
  } = opts;
  const w = Number(inputSize) || DEFAULT_INPUT;
  const key = `${model}|${w}|${labels.join(',')}|${scoreThreshold}|${iouThreshold}|${maxResults}`;
  if (session && key === currentKey) return session;

  // 新创建作废更早的创建；closeOnnxDetector() 也会 +1，让在途创建放弃
  const myEpoch = ++epoch;
  const lib = await loadOrt();
  if (myEpoch !== epoch) throw new Error('ONNX 检测器创建被新的请求取代');
  releaseSession();

  let s;
  try {
    s = await lib.InferenceSession.create(asset(`../models/${model}`), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  } catch (e) {
    lastError = e?.message || String(e);
    throw new Error(`PPE/物体模型加载失败（models/${model}）：${lastError}。`
      + '先训练并导出 ONNX（见 docs/ppe-training.md），再把 best.onnx 复制到 web/models/。');
  }
  if (myEpoch !== epoch) {
    try { s.release?.(); } catch { /* ignore */ }
    throw new Error('ONNX 检测器创建被新的请求取代');
  }

  // 输出形状：[1, 4+nc, N] 或 [1, N, 4+nc]
  const outName = s.outputNames[0];
  const numClasses = labels.length || 0;
  // 先在局部对象里填元信息，自检通过后再和 session 一起原子安装：
  // 否则自检期间 detectOnnx 可能拿到"新 meta + 旧 session"。
  const m = {
    model, inputW: w, inputH: w, labels, numClasses,
    outputName: outName, outC: 0, outN: 0, nMajor: false,
    scoreThreshold, iouThreshold, maxResults,
  };

  // 自检：zeros 跑一次。模型算子不支持/形状不对时，create 会成功、run 才抛，
  // 不先跑一次会得到「加载成功、永远不出框」的检测器（和 MediaPipe GPU delegate 同一个坑）。
  ensureBuffers(w, w);
  const zeros = new Float32Array(3 * w * w);
  try {
    const res = await s.run({ [s.inputNames[0]]: new lib.Tensor('float32', zeros, [1, 3, w, w]) });
    const o = res[outName];
    const d = Array.from(o.dims);
    // 用 decodeYolo 走一遍维度/类别数校验（阈值调到不可能命中，只看形状）
    decodeYolo(o.data, d, {
      labels, scoreThreshold: 1.1, iouThreshold, maxResults: 0,
    }, { scale: 1, padX: 0, padY: 0 }, w, w);
    const nMajor = labels.length ? d[2] === labels.length + 4 : d[1] > d[2];
    m.outC = nMajor ? d[2] : d[1];
    m.outN = nMajor ? d[1] : d[2];
    m.nMajor = nMajor;
    if (!numClasses) m.numClasses = m.outC - 4;
  } catch (e) {
    lastError = e?.message || String(e);
    try { s.release?.(); } catch { /* ignore */ }
    throw new Error(`模型自检失败（${model}）：${lastError}`);
  }
  if (myEpoch !== epoch) {
    try { s.release?.(); } catch { /* ignore */ }
    throw new Error('ONNX 检测器创建被新的请求取代');
  }

  session = s;
  meta = m;
  currentKey = key;
  lastError = null;
  return session;
}

/** 单帧推理。source 可以是 <video>/<img>/<canvas>，w/h 是它的显示像素尺寸。 */
export async function detectOnnx(source, sw, sh) {
  // 先快照 session/meta：推理期间可能切 profile，模块级变量会被换掉
  const s = session;
  const m = meta;
  if (!s) throw new Error('onnx detector not ready');
  if (!(sw > 0 && sh > 0)) throw new Error(`无效的画面尺寸：${sw}×${sh}`);
  const { inputW, inputH } = m;
  ensureBuffers(inputW, inputH);
  const letter = letterbox(source, sw, sh, inputW, inputH);
  // proxy 模式下 ORT 会把输入 buffer **转移**给 worker（原 buffer 被 detach，length 变 0），
  // 所以必须每帧传一份拷贝；不能复用 chw（实测第二帧就抛 size 307200 ≠ 0）。
  const data = toChw(inputW, inputH);
  const input = ort.env.wasm.proxy ? new Float32Array(data) : data;
  const tensor = new ort.Tensor('float32', input, [1, 3, inputH, inputW]);
  const runEpoch = epoch;
  const tRun = performance.now();
  const res = await s.run({ [s.inputNames[0]]: tensor });
  const dt = performance.now() - tRun;
  runMs = runMs ? runMs * 0.8 + dt * 0.2 : dt;
  // 推理期间被关闭/被新模型替换：结果属于旧模型，不能拿新 meta 去解码（会串类别/输出名）
  if (runEpoch !== epoch) throw new Error('ONNX 检测器在推理期间被替换');
  const out = res[m.outputName];
  if (!out) throw new Error(`模型输出里没有 ${m.outputName}`);
  return decodeYolo(out.data, out.dims, m, letter, sw, sh);
}

/** 本帧同步返回的"是否就绪"信息（给 app.js 的 state 用）。 */
export function onnxInfo() {
  return {
    ready: !!session,
    backend: 'onnx',
    key: currentKey,
    model: meta.model,
    labels: meta.labels.slice(),
    inputSize: meta.inputW,
    numClasses: meta.numClasses,
    runMs: Math.round(runMs * 10) / 10,
    error: lastError,
  };
}

function releaseSession() {
  if (session) {
    try { session.release?.(); } catch { /* ignore */ }
    session = null;
  }
  currentKey = '';
  runMs = 0;
}

export function closeOnnxDetector() {
  epoch++;          // 让在途的 createOnnxDetector 自检后放弃安装
  releaseSession();
}
