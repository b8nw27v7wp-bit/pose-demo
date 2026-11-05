// headless-ppe-onnx.mjs — 冒烟检查：自训 YOLOv8 ONNX 能不能在页面里跑通 PPE 链路
//
// 运行：npm run serve（另开终端）后
//   node web/test/headless-ppe-onnx.mjs [baseUrl] [--img 相对路径]
//
// 它回答的是"链路通不通"，不是精度：
//   profile 是 onnx 后端？模型就绪？labels 顺序对上？检出框里有 helmet/no_helmet？
//   no_helmet 有没有被 PPE 层误当成 helmet？
//
// 素材默认从 eval-data/ppe-yolo/images/val 里挑一张含 no_helmet 标注的图
// （ppe-smoke/val/annotations 里有同名 VOC xml，可只读解析做对照）。

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMG_DIR = path.join(ROOT, 'eval-data', 'ppe-yolo', 'images', 'val');
const ANN_DIR = path.join(ROOT, 'eval-data', 'ppe-smoke', 'val', 'annotations');
const DEFAULT_BASE = 'http://127.0.0.1:8765/web/';

const argv = process.argv.slice(2);
let base = DEFAULT_BASE;
let imgRel = '';
let profileArg = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--img') imgRel = argv[++i] || '';
  else if (argv[i] === '--profile') profileArg = argv[++i] || '';
  else if (!argv[i].startsWith('--')) base = argv[i];
}
base = base.replace(/\/?$/, '/');
// 默认 profile 必须跟着 base 走：写死 127.0.0.1:8765 时，换端口/SSH 转发/局域网访问
// 会变成跨域（serve.py 没有 CORS 头），然后干等 120 秒才报"未就绪"。
const profile = profileArg || new URL('profiles/safety-ppe.json', base).href;

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/** 挑一张同时含 no_helmet 与 helmet 的验证图：能同时验证正/负类标签。 */
async function pickImage() {
  if (imgRel) return { name: path.basename(imgRel), rel: imgRel.replace(/^\/+/, '') };
  let names = [];
  try { names = await readdir(IMG_DIR); } catch { /* 数据没下 */ }
  names = names.filter((f) => /\.(jpe?g|png)$/i.test(f));
  for (const n of names) {
    const xml = path.join(ANN_DIR, n.replace(/\.[^.]+$/, '.xml'));
    if (!(await exists(xml))) continue;
    const text = await readFile(xml, 'utf8');
    if (text.includes('<name>no_helmet</name>') && text.includes('<name>helmet</name>')) {
      return { name: n, rel: `eval-data/ppe-yolo/images/val/${n}`, xml: text };
    }
  }
  const first = names[0];
  if (!first) return null;
  const xml = path.join(ANN_DIR, first.replace(/\.[^.]+$/, '.xml'));
  return {
    name: first,
    rel: `eval-data/ppe-yolo/images/val/${first}`,
    xml: (await exists(xml)) ? await readFile(xml, 'utf8') : '',
  };
}

function gtCounts(xml) {
  const out = {};
  for (const m of xml.matchAll(/<name>([^<]+)<\/name>/g)) out[m[1]] = (out[m[1]] || 0) + 1;
  return out;
}

const stateExpr = `(() => {
  const s = window.__pose && window.__pose.state;
  if (!s) return null;
  const v = (s.lastResult && s.lastResult.verdicts) || [];
  return {
    frames: s.frames, objectOn: s.objectOn, objectReady: s.objectReady,
    profileLoaded: s.profileLoaded, objectError: s.objectError,
    objectInfo: s.objectInfo || null,
    objects: s.objects, objectTags: s.objectTags || {},
    ppe: v.map((x) => ({
      id: x.track_id,
      helmet: x.ppe ? x.ppe.helmet : null,
      glove: x.ppe ? x.ppe.glove : null,
    })),
  };
})()`;

async function main() {
  const pick = await pickImage();
  if (!pick) {
    console.log(`没有找到 PPE 验证图（${IMG_DIR}）。先跑：py -I scripts/prepare-ppe-dataset.py`);
    return 1;
  }
  const gt = gtCounts(pick.xml || '');
  const url = `${base}?profile=${encodeURIComponent(profile)}&src=/${encodeURIComponent(pick.rel).replace(/%2F/g, '/')}`;
  console.log(`图片：${pick.name}`);
  if (Object.keys(gt).length) {
    console.log(`gt：${Object.entries(gt).map(([k, n]) => `${k}×${n}`).join(' · ')}`);
  }
  console.log(`profile：${profile}\n`);

  const { cdp, errors, close } = await openPage(url);
  try {
    let s = null;
    let ready = false;
    for (let i = 0; i < 240; i++) {
      s = await cdp.eval(stateExpr);
      if (s && s.objectInfo && s.objectInfo.ready) { ready = true; break; }
      if (s && s.objectError) break;
      // profile 已生效但物体检测是关的（profile 没加载成功/没声明 objects）：别干等 2 分钟
      if (s && s.profileLoaded && !s.objectOn) break;
      await sleep(500);
    }
    // 就绪后再等分析完成（图片路径的分析是异步的）
    for (let i = 0; i < 40 && ready; i++) {
      s = await cdp.eval(stateExpr);
      if (s && (s.objects > 0 || Object.keys(s.objectTags || {}).length)) break;
      await sleep(250);
    }

    const fatal = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
    const info = s?.objectInfo || {};
    console.log(`后端：${info.backend || '?'} · 模型：${info.model || '?'} · 输入 ${info.inputSize || '?'}`
      + ` · 类别 ${info.numClasses ?? '?'} · ready=${info.ready}`);
    if (info.error) console.log(`模型错误：${info.error}`);
    if (!ready) {
      console.log('FAIL 物体检测模型未就绪');
      if (fatal.length) console.log(`JS: ${fatal.slice(0, 3).join(' | ')}`);
      return 1;
    }
    if (info.backend !== 'onnx') {
      console.log(`FAIL 后端应为 onnx，实际 ${info.backend}（profile 没生效？）`);
      return 1;
    }
    if (s.objectError) console.log(`运行时错误：${s.objectError}`);
    const tags = s.objectTags || {};
    console.log(`检出 ${s.objects} 框：${Object.entries(tags).map(([k, n]) => `${k}×${n}`).join(' · ') || '无'}`);
    for (const p of s.ppe || []) {
      const fmt = (x) => (x ? `${x.state}/${x.alert}${x.label ? `(${x.label})` : ''}` : '-');
      console.log(`  #${p.id} 头盔 ${fmt(p.helmet)} · 手套 ${fmt(p.glove)}`);
    }

    // 负类语义：如果模型检出 no_helmet，PPE 不能把它算成 helmet 正例。
    const ppeOk = (s.ppe || []).every((p) => !p.helmet || p.helmet.state !== 'worn'
      || !(p.helmet.label || '').startsWith('no_'));
    if (!ppeOk) console.log('FAIL no_helmet 被当成了 helmet 正例');
    if (!s.objects) console.log('FAIL 一个物体框都没检出（模型/预处理/labels 顺序？）');
    if (fatal.length) console.log(`JS: ${fatal.slice(0, 3).join(' | ')}`);
    // 返回码而不是 process.exit：exit 不会执行 finally，浏览器会漏在后台
    return (!s.objects || !ppeOk) ? 1 : 0;
  } finally {
    await close();
  }
}

main().then((code) => process.exit(code || 0)).catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
