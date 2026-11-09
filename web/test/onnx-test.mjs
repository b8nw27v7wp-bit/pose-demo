// onnx-test.mjs — YOLOv8 ONNX 解码/NMS/letterbox 逆变换的确定性单测
// 运行：node web/test/onnx-test.mjs
//
// 这里只验证**几何与解码**，不碰 onnxruntime-web（浏览器里跑，见
// web/test/headless-ppe-onnx.mjs）。模型真实输出是否对，要靠无头检查。

import {
  decodeYolo, createOnnxDetector, verifyOnnxManifest, loadOnnxManifest, manifestPathFor,
} from '../js/objects-onnx.js';
import { readLabels, parseYamlNames } from '../../scripts/ppe-model-manifest.mjs';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const LABELS = ['helmet', 'no_helmet', 'person'];
const CFG = { labels: LABELS, scoreThreshold: 0.4, iouThreshold: 0.45, maxResults: 8 };
const ID = { scale: 1, padX: 0, padY: 0 };

/** 4 个候选框 × 7 通道（cx,cy,w,h, 3 类），按 [C,N] 或 [N,C] 排布 */
const ANCHORS = [
  // cx, cy, w, h, helmet, no_helmet, person
  [100, 100, 40, 40, 0.90, 0.05, 0.01], // 头盔（会被 i1 重叠抑制）
  [101, 101, 40, 40, 0.80, 0.02, 0.00], // 同一位置的第二个预测
  [220, 220, 40, 40, 0.02, 0.85, 0.01], // 未戴安全帽
  [300, 300, 20, 20, 0.10, 0.20, 0.30], // 全部低于阈值
];

function pack(anchors, major = 'c') {
  const N = anchors.length;
  const C = anchors[0].length;
  const data = new Float32Array(C * N);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < C; c++) {
      if (major === 'c') data[c * N + i] = anchors[i][c];
      else data[i * C + c] = anchors[i][c];
    }
  }
  const dims = major === 'c' ? [1, C, N] : [1, N, C];
  return { data, dims };
}

console.log('[1] YOLOv8 输出解码');
{
  const { data, dims } = pack(ANCHORS, 'c');
  const out = decodeYolo(data, dims, CFG, ID, 320, 320);
  check('[C,N] 两个类别各出一条', out.length === 2, JSON.stringify(out.map((o) => o.label)));
  const hat = out.find((o) => o.label === 'helmet');
  const bare = out.find((o) => o.label === 'no_helmet');
  check('helmet 分数取最大类', hat && Math.abs(hat.score - 0.9) < 1e-6);
  check('helmet 框是 cx±w/2', hat && hat.box.join(',') === '80,80,120,120', hat?.box.join(','));
  check('no_helmet 标签没串到 helmet', bare && Math.abs(bare.score - 0.85) < 1e-6);
  check('低分框被阈值滤掉', !out.some((o) => o.score < 0.4));
}
{
  const { data, dims } = pack(ANCHORS, 'n');
  const out = decodeYolo(data, dims, CFG, ID, 320, 320);
  check('[N,C] 排布得到同样结果', out.length === 2
    && out.find((o) => o.label === 'helmet')?.box.join(',') === '80,80,120,120');
}

console.log('[2] 逐类别 NMS');
{
  // 同一位置上 helmet 与 no_helmet 各一条：跨类别不能互相抑制
  const data = pack([
    [100, 100, 40, 40, 0.9, 0.7, 0.0],
    [100, 100, 40, 40, 0.6, 0.8, 0.0],
  ]).data;
  const out = decodeYolo(data, [1, 7, 2], { ...CFG, scoreThreshold: 0.3 }, ID, 320, 320);
  check('跨类别重叠都保留', out.length === 2, out.map((o) => o.label).join(','));
  const data2 = pack([
    [100, 100, 40, 40, 0.9, 0.0, 0.0],
    [104, 100, 40, 40, 0.85, 0.0, 0.0],
  ]).data;
  const out2 = decodeYolo(data2, [1, 7, 2], CFG, ID, 320, 320);
  check('同类别高度重叠只留高分', out2.length === 1 && Math.abs(out2[0].score - 0.9) < 1e-6);
}

console.log('[3] letterbox 逆变换');
{
  // 原图 640×480 → 320 输入：scale=0.5，nw=320，nh=240，上下各 pad 40
  const letter = { scale: 0.5, padX: 0, padY: 40 };
  const data = new Float32Array([160, 160, 100, 100, 0.9, 0, 0]);
  const out = decodeYolo(data, [1, 7, 1], CFG, letter, 640, 480);
  check('框映射回原图坐标', out[0].box.join(',') === '220,140,420,340', out[0].box.join(','));
}
{
  // 框超出原图时被裁剪
  const data = new Float32Array([10, 10, 40, 40, 0.9, 0, 0]);
  const out = decodeYolo(data, [1, 7, 1], CFG, ID, 320, 320);
  check('越界框按原图裁剪', out[0].box[0] === 0 && out[0].box[1] === 0);
}

console.log('[4] 形状校验');
{
  let threw = false;
  try { decodeYolo(new Float32Array(10), [1, 10], CFG, ID, 320, 320); } catch { threw = true; }
  check('非 3 维输出报错', threw);
  threw = false;
  try {
    // 真实量级的候选框数：N=100 >> C，layout 不会认错；labels 5 类 > 模型 3 类
    const { data, dims } = pack(Array.from({ length: 100 }, () => [0, 0, 0, 0, 0, 0, 0]));
    decodeYolo(data, dims, { ...CFG, labels: [...LABELS, 'vest', 'no_vest'] }, ID, 320, 320);
  } catch (e) { threw = /labels/.test(e.message); }
  check('labels 多于模型类别报错', threw);
}

console.log('[5] 缺省参数');
{
  // 只给 dims 不给 labels/阈值/maxResults：不能抛，也不能因为 slice(0, undefined) 返回空
  const anchors = Array.from({ length: 100 }, () => [0, 0, 0, 0, 0, 0, 0]);
  anchors[0] = [100, 100, 40, 40, 0.9, 0, 0];
  const { data, dims } = pack(anchors);
  const out = decodeYolo(data, dims, {}, ID, 320, 320);
  check('缺省 cfg 也能解码', out.length === 1, JSON.stringify(out.map((o) => o.label)));
  check('没有 labels 时标签为 null（不按 index 猜）', out[0]?.label === null);
}

console.log('[6] sidecar 校验（R11-3）');
{
  const manifest = {
    labels: ['helmet', 'no_helmet', 'person'],
    inputSize: 320,
    numClasses: 3,
    sha256: 'deadbeef',
    exportedAt: '2026-11-05T00:00:00.000Z',
  };
  const good = verifyOnnxManifest(manifest, { labels: [...LABELS], inputSize: 320 });
  check('正确 sidecar 通过', good.ok, good.error || '');
  check('通过时返回 labels/numClasses', good.numClasses === 3 && good.labels[1] === 'no_helmet');

  const order = verifyOnnxManifest(manifest, {
    labels: ['no_helmet', 'helmet', 'person'], inputSize: 320,
  });
  check('数量相同、顺序错 → 失败', !order.ok);
  check('错误消息定位第一处差异', /第 0 个/.test(order.error || ''), order.error);

  const count = verifyOnnxManifest(manifest, {
    labels: [...LABELS, 'vest'], inputSize: 320,
  });
  check('labels 数量不一致 → 失败', !count.ok && /数量/.test(count.error || ''), count.error);

  const size = verifyOnnxManifest(manifest, { labels: [...LABELS], inputSize: 640 });
  check('inputSize 不一致 → 失败', !size.ok && /inputSize/.test(size.error || ''), size.error);

  const broken = verifyOnnxManifest({ ...manifest, numClasses: 9 }, { labels: [...LABELS], inputSize: 320 });
  check('sidecar 自身 numClasses 与 labels 矛盾 → 失败', !broken.ok);

  const missing = await loadOnnxManifest('nope.onnx', {
    fetchImpl: async () => ({ status: 404, ok: false }),
  });
  check('缺 sidecar 被识别为 missing', missing.ok === false && missing.reason === 'missing');

  const loaded = await loadOnnxManifest('ppe_smoke.onnx', {
    fetchImpl: async (url) => {
      check('sidecar 与模型同目录同名', url === manifestPathFor('ppe_smoke.onnx')
        && /ppe_smoke\.onnx\.json$/.test(url), url);
      return { status: 200, ok: true, json: async () => manifest };
    },
  });
  check('正确 sidecar 可加载', loaded.ok && loaded.manifest.sha256 === 'deadbeef');

  const err = await loadOnnxManifest('ppe_smoke.onnx', {
    fetchImpl: async () => { throw new Error('network down'); },
  });
  check('取 sidecar 网络错误可解释', err.ok === false && err.reason === 'fetch_error');

  // create 阶段就失败：不进入 ORT 创建/推理（Node 里也能测）
  let createErr = null;
  try {
    await createOnnxDetector({
      model: 'fake.onnx',
      labels: ['no_helmet', 'helmet', 'person'],
      loadManifest: async () => ({ ok: true, manifest }),
    });
  } catch (e) { createErr = e.message; }
  check('create 阶段拒绝类别顺序错', /第 0 个/.test(createErr || ''), createErr);

  createErr = null;
  try {
    await createOnnxDetector({
      model: 'fake.onnx',
      labels: [...LABELS],
      loadManifest: async () => ({ ok: false, reason: 'missing' }),
    });
  } catch (e) { createErr = e.message; }
  check('requireManifest 默认 true：缺 sidecar 在 create 阶段失败',
    /sidecar/.test(createErr || '') && /ppe-model-manifest/.test(createErr || ''), createErr);
}

console.log('[7] sidecar 生成脚本：--labels 来源');
{
  // 路径写错必须报错，不能把路径当内联单类——否则会生成一份 label 就是路径的 sidecar，
  // 并覆盖掉已有的正确 sidecar（web/models 不进 git，覆盖后无法恢复）。
  let err = null;
  try { await readLabels('definitely-missing.yaml'); } catch (e) { err = e.message; }
  check('缺 labels 文件 → 明确报错（不当内联）', /读不到 --labels 文件/.test(err || ''), err);

  const inline = await readLabels('helmet,no_helmet,glove');
  check('逗号列表 → 内联标签', inline.source === 'inline' && inline.labels.length === 3,
    JSON.stringify(inline.labels));

  check('names 行尾注释不影响缩进列表',
    JSON.stringify(parseYamlNames('names:  # 3 类\n  0: helmet\n  1: no_helmet\n'))
      === '["helmet","no_helmet"]');
  check('names 行尾注释不影响内联列表',
    JSON.stringify(parseYamlNames("names: ['a','b']  # x")) === '["a","b"]');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
