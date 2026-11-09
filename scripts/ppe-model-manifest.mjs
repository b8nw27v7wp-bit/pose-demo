#!/usr/bin/env node
// ppe-model-manifest.mjs — 给 ONNX 检测器生成同名 sidecar（R11-3）
//
// 为什么需要：YOLO ONNX 没有 label map，类别名只能由 profile 按训练时 data.yaml 的
// **顺序**给出。数量写对、顺序写错时模型照常推理，只是类别张冠李戴（helmet 框被判成
// no_helmet），而且不会报错。sidecar 把导出时的 labels/输入尺寸/类别数/权重哈希固化下来，
// 浏览器加载时深比较，顺序不一致直接拒绝创建。
//
// 用法：
//   node scripts/ppe-model-manifest.mjs web/models/ppe_smoke.onnx --labels eval-data/ppe-yolo/data.yaml
//   node scripts/ppe-model-manifest.mjs web/models/ppe_smoke.onnx --labels helmet,no_helmet,glove
//   node scripts/ppe-model-manifest.mjs web/models/xxx.onnx --labels labels.txt --input-size 640
//   --out 指定输出；缺省是 <model>.json（ppe_smoke.onnx → ppe_smoke.onnx.json）
//
// 只读模型、只写 sidecar；不下载、不训练、不跑推理。sha256 对 ONNX 文件算一次。

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function usage() {
  return `用法：node scripts/ppe-model-manifest.mjs <model.onnx> --labels <data.yaml|labels.txt|a,b,c> [--input-size 320] [--out <file>]

  --labels       类别顺序来源：data.yaml（names）、每行一个名字的 txt、或逗号列表
  --input-size   导出 ONNX 时的 imgsz（默认 320；必须与训练/导出一致）
  --out          sidecar 输出路径（默认 <model>.json）
  --help         显示本帮助`;
}

/** 从 data.yaml 里读 names，不依赖 PyYAML（和 ppe-dataset-report.py 口径一致）。 */
export function parseYamlNames(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*names\s*:\s*(.*)$/);
    if (!m) continue;
    // 去掉行尾注释：`names:  # 9 类` 不能把下面的缩进列表当成缺省。
    const rest = m[1].replace(/(^|\s+)#.*$/, '').trim();
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const labels = rest.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      return labels.length ? labels : null;
    }
    if (rest.startsWith('{') && rest.endsWith('}')) {
      const labels = [...rest.matchAll(/:\s*([^,}]+)/g)].map((x) => x[1].trim().replace(/^['"]|['"]$/g, ''));
      return labels.length ? labels : null;
    }
    if (rest) return null;
    // 换行列表：
    // names:
    //   0: helmet
    //   ...
    // 或
    // names:
    //   - helmet
    const labels = [];
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      const item = raw.match(/^\s*-\s*(.+?)\s*$/);
      const keyed = raw.match(/^\s*\d+\s*:\s*(.+?)\s*$/);
      if (item || keyed) {
        labels.push((item ? item[1] : keyed[1]).trim().replace(/^['"]|['"]$/g, ''));
      } else if (raw.trim() && !/^\s+/.test(raw)) {
        break;
      }
    }
    return labels.length ? labels : null;
  }
  return null;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** @returns {Promise<{labels:string[], source:string, dataYamlHash?:string}>} */
export async function readLabels(arg) {
  const text = await readFile(arg, 'utf8').catch(() => null);
  // 看起来是路径（有分隔符或已知扩展名）却读不到：直接报错。
  // 不能退回「内联逗号列表」——否则 --labels 路径写错会生成一份 label 就是路径的
  // 单类 sidecar，并覆盖掉已有的正确 sidecar（web/models 不进 git，覆盖后无法恢复）。
  if (text == null && (/[\\/]/.test(String(arg)) || /\.(ya?ml|txt)$/i.test(String(arg)))) {
    throw new Error(`读不到 --labels 文件：${arg}`
      + '（检查路径；内联列表请用逗号分隔，如 helmet,no_helmet）');
  }
  if (text != null && /\.ya?ml$/i.test(arg)) {
    const labels = parseYamlNames(text);
    if (!labels) throw new Error(`从 ${arg} 读不到 names`);
    return { labels, source: arg, dataYamlHash: sha256(Buffer.from(text, 'utf8')) };
  }
  if (text != null && /\.txt$/i.test(arg)) {
    const labels = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!labels.length) throw new Error(`${arg} 里没有类别名`);
    return { labels, source: arg };
  }
  // 交给调用方的 else 分支再判断是不是文件（未知扩展名时按 YAML 内容猜一次）
  if (text != null) {
    const labels = parseYamlNames(text);
    if (labels) return { labels, source: arg, dataYamlHash: sha256(Buffer.from(text, 'utf8')) };
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length) return { labels: lines, source: arg };
  }
  const labels = String(arg).split(',').map((s) => s.trim()).filter(Boolean);
  if (!labels.length) throw new Error('--labels 不能为空');
  return { labels, source: 'inline' };
}

export function buildManifest({ labels, inputSize, modelPath, dataYamlHash, modelHash, exportedAt }) {
  const size = Number(inputSize);
  if (!Number.isInteger(size) || size <= 0) throw new Error(`inputSize 无效：${inputSize}`);
  if (!Array.isArray(labels) || !labels.length) throw new Error('labels 不能为空');
  const out = {
    labels,
    inputSize: size,
    numClasses: labels.length,
    sha256: modelHash,
    exportedAt: exportedAt || new Date().toISOString(),
  };
  if (dataYamlHash) out.dataYamlHash = dataYamlHash;
  if (modelPath) out.model = path.basename(modelPath);
  return out;
}

async function main(argv) {
  let model = null;
  let labelsArg = null;
  let inputSize = 320;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--labels') labelsArg = next();
    else if (a === '--input-size') inputSize = Number(next());
    else if (a === '--out') out = next();
    else if (a === '-h' || a === '--help') { console.log(usage()); return 0; }
    else if (a.startsWith('--')) throw new Error(`未知参数 ${a}\n\n${usage()}`);
    else if (!model) model = a;
    else throw new Error(`多余的参数：${a}`);
  }
  if (!model) throw new Error(`缺少模型路径\n\n${usage()}`);
  if (!labelsArg) throw new Error(`缺少 --labels\n\n${usage()}`);

  const bytes = await readFile(model);
  const modelHash = sha256(bytes);
  const { labels, source, dataYamlHash } = await readLabels(labelsArg);
  const manifest = buildManifest({
    labels,
    inputSize,
    modelPath: model,
    dataYamlHash,
    modelHash,
  });
  const outPath = out || `${model}.json`;
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`模型：${model}（${bytes.length} 字节）`);
  console.log(`类别：${labels.length} 类，来源 ${source}`);
  console.log(`  ${labels.map((l, i) => `${i}:${l}`).join('  ')}`);
  console.log(`sha256：${modelHash}`);
  if (dataYamlHash) console.log(`data.yaml sha256：${dataYamlHash}`);
  console.log(`已写入：${outPath}`);
  return 0;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error(`错误：${e?.message || e}`);
    process.exit(1);
  });
}
