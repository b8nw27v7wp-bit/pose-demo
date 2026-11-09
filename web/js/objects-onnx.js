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
//
// R11-3：类别顺序不能靠 profile 和训练时"碰巧一致"。导出时用
// `scripts/ppe-model-manifest.mjs` 生成同名 sidecar `web/models/<model>.json`，
// 加载时深比较 labels、校验 inputSize/numClasses；不一致直接拒绝创建（不进入推理）。
// `cfg.requireManifest` 默认 true：没有 sidecar 就失败；确需兼容旧模型时显式传 false。

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

/** ONNX 同名 sidecar 的 URL：ppe_smoke.onnx → ppe_smoke.onnx.json */
export function manifestPathFor(model) {
  return asset(`../models/${model}.json`);
}

/**
 * 纯函数：把 sidecar 与运行时配置做深比较。返回 {ok, labels, numClasses} 或 {ok:false, error}。
 * 错误消息给出**第一处差异**（类别顺序错时定位到第几个），不打印整份数组。
 */
export function verifyOnnxManifest(manifest, { labels = [], inputSize = DEFAULT_INPUT } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'sidecar 不是 JSON 对象' };
  }
  const mlabels = manifest.labels;
  if (!Array.isArray(mlabels) || !mlabels.length) {
    return { ok: false, error: 'sidecar 缺少 labels（应为非空数组）' };
  }
  const mNum = Number(manifest.numClasses);
  if (!Number.isInteger(mNum) || mNum <= 0) {
    return { ok: false, error: `sidecar 的 numClasses 无效：${manifest.numClasses}` };
  }
  if (mNum !== mlabels.length) {
    return {
      ok: false,
      error: `sidecar 自相矛盾：numClasses=${mNum}，labels 有 ${mlabels.length} 个`,
    };
  }
  const mSize = Number(manifest.inputSize);
  if (!Number.isFinite(mSize) || mSize <= 0) {
    return { ok: false, error: `sidecar 的 inputSize 无效：${manifest.inputSize}` };
  }
  if (mSize !== Number(inputSize)) {
    return { ok: false, error: `inputSize 不一致：sidecar=${mSize}，运行时=${inputSize}` };
  }
  if (labels.length) {
    if (labels.length !== mlabels.length) {
      return {
        ok: false,
        error: `labels 数量不一致：sidecar ${mlabels.length} 类，profile ${labels.length} 类`,
      };
    }
    for (let i = 0; i < labels.length; i++) {
      if (String(labels[i]) !== String(mlabels[i])) {
        return {
          ok: false,
          // 顺序错是最危险的：数量相同、模型照跑，只是类别张冠李戴
          error: `labels 第 ${i} 个不一致（顺序错会张冠李戴）：sidecar="${mlabels[i]}"，profile="${labels[i]}"`,
        };
      }
    }
  }
  return { ok: true, labels: mlabels.map(String), numClasses: mNum };
}

/**
 * 加载 sidecar。fetch 可注入（Node 单测用假 fetch，不碰 ORT / 文件系统）。
 * @returns {{ok:true, manifest:object, url:string}|{ok:false, reason:string, url:string, error?:string}}
 */
export async function loadOnnxManifest(model, { fetchImpl = globalThis.fetch } = {}) {
  const url = manifestPathFor(model);
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'no_fetch', url, error: '当前环境没有 fetch' };
  }
  let res;
  try {
    res = await fetchImpl(url, { cache: 'no-cache' });
  } catch (e) {
    return { ok: false, reason: 'fetch_error', url, error: e?.message || String(e) };
  }
  if (res?.status === 404) return { ok: false, reason: 'missing', url };
  if (!res?.ok) {
    return { ok: false, reason: 'http_error', url, error: `HTTP ${res?.status ?? '?'}` };
  }
  try {
    const manifest = await res.json();
    return { ok: true, manifest, url };
  } catch (e) {
    return { ok: false, reason: 'invalid_json', url, error: e?.message || String(e) };
  }
}

function manifestError(loaded, model) {
  if (loaded.reason === 'missing') {
    return `缺少 ONNX 模型 sidecar（models/${model}.json）。`
      + `先运行 node scripts/ppe-model-manifest.mjs web/models/${model} --labels <data.yaml 或逗号列表> 生成；`
      + '确需加载旧模型可显式传 requireManifest:false。';
  }
  return `ONNX 模型 sidecar 加载失败（models/${model}.json）：${loaded.error || loaded.reason}`;
}

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
 *          scoreThreshold?:number, iouThreshold?:number, maxResults?:number,
 *          requireManifest?:boolean,
 *          loadManifest?:Function}} opts
 *        requireManifest 默认 true：sidecar 缺失即失败。显式 false 只放宽"缺失"，
 *        sidecar 存在但内容不一致仍然抛错（错误的类别顺序比没有 sidecar 更危险）。
 */
export async function createOnnxDetector(opts = {}) {
  const {
    model = 'ppe_smoke.onnx',
    labels = [],
    inputSize = DEFAULT_INPUT,
    scoreThreshold = 0.35,
    iouThreshold = 0.45,
    maxResults = 8,
    requireManifest = true,
    loadManifest = null,
    fetchImpl = globalThis.fetch,
  } = opts;
  const manifestLoader = loadManifest || ((m) => loadOnnxManifest(m, { fetchImpl }));
  const w = Number(inputSize) || DEFAULT_INPUT;
  const key = `${model}|${w}|${labels.join(',')}|${scoreThreshold}|${iouThreshold}|${maxResults}|m${requireManifest ? 1 : 0}`;
  if (session && key === currentKey) return session;

  // 新创建作废更早的创建；closeOnnxDetector() 也会 +1，让在途创建放弃
  const myEpoch = ++epoch;

  // —— R11-3：先校验 sidecar，再付 ORT 加载/推理的代价 ——
  let effectiveLabels = labels;
  let manifestInfo = {
    ok: false, required: !!requireManifest, path: `${model}.json`,
  };
  const loaded = await manifestLoader(model);
  // sidecar 加载是 await：期间可能已有更新的创建取代本代次。
  // 必须在任何副作用（lastError / releaseSession）之前放弃，否则会把新一代
  // 刚装好的会话拆掉（objectReady 仍是 true，但下一次推理直接抛错）。
  if (myEpoch !== epoch) throw new Error('ONNX 检测器创建被新的请求取代');
  if (!loaded.ok) {
    if (requireManifest) {
      lastError = manifestError(loaded, model);
      releaseSession();   // 旧 session 的类别顺序同样不可信，不能让 objectInfo 继续显示 ready
      throw new Error(lastError);
    }
    manifestInfo.error = loaded.error || loaded.reason;
  } else {
    const v = verifyOnnxManifest(loaded.manifest, { labels, inputSize: w });
    if (!v.ok) {
      lastError = `ONNX 模型 sidecar 校验失败（models/${model}.json）：${v.error}`;
      releaseSession();
      throw new Error(lastError);
    }
    // profile 没写 labels 时用 sidecar 的（sidecar 是导出时写下的真实顺序）
    effectiveLabels = labels.length ? labels : v.labels;
    manifestInfo = {
      ok: true,
      required: !!requireManifest,
      path: `${model}.json`,
      numClasses: v.numClasses,
      sha256: loaded.manifest.sha256 ?? null,
      exportedAt: loaded.manifest.exportedAt ?? null,
    };
  }

  if (myEpoch !== epoch) throw new Error('ONNX 检测器创建被新的请求取代');
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
  const numClasses = effectiveLabels.length || 0;
  // 先在局部对象里填元信息，自检通过后再和 session 一起原子安装：
  // 否则自检期间 detectOnnx 可能拿到"新 meta + 旧 session"。
  const m = {
    model, inputW: w, inputH: w, labels: effectiveLabels, numClasses,
    outputName: outName, outC: 0, outN: 0, nMajor: false,
    scoreThreshold, iouThreshold, maxResults,
    modelHash: manifestInfo.sha256 ?? null,
    manifest: manifestInfo,
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
      labels: effectiveLabels, scoreThreshold: 1.1, iouThreshold, maxResults: 0,
    }, { scale: 1, padX: 0, padY: 0 }, w, w);
    const nMajor = effectiveLabels.length ? d[2] === effectiveLabels.length + 4 : d[1] > d[2];
    m.outC = nMajor ? d[2] : d[1];
    m.outN = nMajor ? d[1] : d[2];
    m.nMajor = nMajor;
    const actualClasses = m.outC - 4;
    // sidecar 的 numClasses 是这个模型真正的类别数；与输出张量对不上说明文件/配置错配。
    if (manifestInfo.ok && actualClasses !== manifestInfo.numClasses) {
      throw new Error(`模型输出类别数与 sidecar 不一致：sidecar=${manifestInfo.numClasses}，模型=${actualClasses}`);
    }
    m.numClasses = actualClasses;
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
    modelHash: meta.modelHash ?? null,
    manifest: meta.manifest ? { ...meta.manifest } : { ok: false, required: true },
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
