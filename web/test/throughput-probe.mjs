// throughput-probe.mjs — 页面吞吐/各阶段耗时探针（真模型、真视频）
//
// 运行：npm run serve（另开终端）
//   node web/test/throughput-probe.mjs [baseUrl] [选项]
//
// 选项：
//   --src      相对路径（默认 /eval-data/open/mot17/MOT17-05-FRCNN.mp4）
//   --profile  profile URL（默认不加载，用内置默认参数）
//   --multi    0|2|3|4（0 = 关多人；默认 3）
//   --hands    0|1（默认 1）
//   --objects  0|1（默认 0；onnx/mediapipe 后端由 profile 决定）
//   --fps      10|15|30（推理帧率上限；默认不改，用页面当前值）
//   --seconds  采样时长（默认 8）
//
// 输出一行 JSON：fps（应用自报）、frames/秒（实测处理速率）、各阶段 EMA 毫秒。
// 用途：判断瓶颈在姿态、手部、物体还是绘制；对比不同开关/帧率上限的吞吐。

import { openPage, sleep } from './cdp.mjs';

const DEFAULT_BASE = 'http://127.0.0.1:8765/web/';
const DEFAULT_SRC = '/eval-data/open/mot17/MOT17-05-FRCNN.mp4';

function parse(argv) {
  const o = {
    base: DEFAULT_BASE, src: DEFAULT_SRC, profile: '',
    multi: 3, hands: 1, objects: 0, fps: 0, seconds: 8,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (v) => Number(v);
    if (a === '--src') o.src = argv[++i];
    else if (a === '--profile') o.profile = argv[++i] || '';
    else if (a === '--multi') o.multi = num(argv[++i]);
    else if (a === '--hands') o.hands = num(argv[++i]);
    else if (a === '--objects') o.objects = num(argv[++i]);
    else if (a === '--fps') o.fps = num(argv[++i]);
    else if (a === '--seconds') o.seconds = num(argv[++i]);
    else if (!a.startsWith('--')) o.base = a;
  }
  o.base = o.base.replace(/\/?$/, '/');
  return o;
}

const opts = parse(process.argv.slice(2));
const params = new URLSearchParams();
if (opts.profile) params.set('profile', opts.profile);
params.set('src', opts.src);
const url = `${opts.base}?${params}`;

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

const expr = `(() => {
  const s = window.__pose && window.__pose.state;
  if (!s) return null;
  return {
    fps: s.fps, frames: s.frames, multiReady: s.multiReady, multiKey: s.multiKey || '',
    handReady: s.handReady, objectReady: s.objectReady, objectOn: s.objectOn,
    multiError: s.multiError || null, objectError: s.objectError || null,
    objectBackend: s.objectInfo ? s.objectInfo.backend : '',
    objectRunMs: s.objectInfo && s.objectInfo.runMs != null ? s.objectInfo.runMs : null,
    timing: s.timing || null,
  };
})()`;

async function main() {
  const { cdp, errors, close } = await openPage(url);
  let exitCode = 0;
  try {
    // 等 profile 真正生效再改开关：否则会先按默认参数把 mediapipe 物体检测建出来，
    // profile 里的 onnx 后端就再也不会生效（ensureObjectDetector 看到 objectReady 直接返回）。
    for (let i = 0; i < 40; i++) {
      const done = await cdp.eval('(() => !!(window.__pose && window.__pose.state.profileLoaded))()');
      if (done) break;
      await sleep(250);
    }
    // 先设帧率上限与开关（必须在模型加载/播放之前，避免白跑一轮）
    const ui = await cdp.eval(`(() => {
      const fps = document.getElementById('fpsCapSel');
      if (fps && ${opts.fps > 0}) { fps.value = '${opts.fps}'; fps.dispatchEvent(new Event('change')); }
      const chk = (id, on) => {
        const el = document.getElementById(id);
        if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change')); }
      };
      // 先改人数再开多人：chkMulti 的 change 会立刻按 select 的值建估算器
      const sel = document.getElementById('multiSel');
      if (sel && ${opts.multi > 0}) sel.value = '${Math.min(4, Math.max(1, opts.multi))}';
      chk('chkMulti', ${opts.multi > 0});
      chk('chkHands', ${opts.hands > 0});
      chk('chkObjects', ${opts.objects > 0});
      return { fps: fps && fps.value, multi: document.getElementById('chkMulti').checked };
    })()`);

    // 等模型就绪（多人/手部/物体都是懒加载）
    let s = null;
    for (let i = 0; i < 240; i++) {
      s = await cdp.eval(expr);
      // 模型加载失败时不要干等 2 分钟：把错误带出去，不然只会看到 fps=0
      if (s && opts.multi > 0 && s.multiError && !s.multiReady) {
        throw new Error(`多人模型加载失败：${s.multiError}`);
      }
      if (s && opts.objects > 0 && s.objectError && !s.objectReady) {
        throw new Error(`物体模型加载失败：${s.objectError}`);
      }
      const needMulti = opts.multi > 0 && !(s && s.multiReady);
      const needHand = opts.hands > 0 && !(s && s.handReady);
      const needObj = opts.objects > 0 && !(s && s.objectReady);
      if (!needMulti && !needHand && !needObj && s && s.frames >= 0) break;
      await sleep(500);
    }
    if (!s) throw new Error('页面状态不可读');

    // 从头播放；播完自动重播，保证采样窗口内一直有帧
    await cdp.eval(`(() => { const b = document.getElementById('btnReplay'); if (b) b.click(); return true; })()`);
    await sleep(1500);   // 预热（模型首帧、缓存）

    const samples = [];
    let frames = 0;
    let lastFrames = -1;
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < opts.seconds) {
      s = await cdp.eval(expr);
      if (!s) { await sleep(500); continue; }
      if (s.frames < lastFrames) {          // 视频回绕：帧计数归零，不把负增量算进去
        lastFrames = s.frames;
      } else if (lastFrames >= 0) {
        frames += s.frames - lastFrames;
      }
      lastFrames = s.frames;
      if (s.fps > 0) samples.push(s);
      if (await cdp.eval(`(() => { const v = document.getElementById('video'); return !!(v && v.ended); })()`)) {
        await cdp.eval(`(() => { const b = document.getElementById('btnReplay'); if (b) b.click(); return true; })()`);
        lastFrames = -1;
        await sleep(300);
      }
      await sleep(500);
    }
    const elapsed = (Date.now() - t0) / 1000;
    const tm = (k) => median(samples.map((x) => x.timing?.[k] ?? 0));
    const out = {
      fps_cap: Number(ui?.fps) || 0,
      multi: opts.multi, hands: opts.hands, objects: opts.objects,
      // 应用自报 fps（0.5s 窗口）与按帧增量算的实测处理速率
      fps: median(samples.map((x) => x.fps)),
      frames_per_s: Math.round((frames / elapsed) * 10) / 10,
      ms: {
        pose: tm('pose'), hands: tm('hands'), objects: tm('objects'),
        draw: tm('draw'), total: tm('total'),
      },
      samples: samples.length,
      multiKey: samples.length ? samples[samples.length - 1].multiKey : '',
      objectBackend: samples.length ? samples[samples.length - 1].objectBackend : '',
      // ONNX 后端在 worker 里跑，state.timing.objects 只测到提交耗时；这里给 session.run 本身的 EMA
      objectRunMs: samples.length ? samples[samples.length - 1].objectRunMs : null,
      errors: errors.filter((e) => !/favicon|Failed to load resource/i.test(e)).slice(0, 2),
    };
    console.log(JSON.stringify(out));
    exitCode = out.errors.length ? 1 : 0;
  } finally {
    await close();
  }
  // process.exit() 不会执行 finally：必须先把浏览器关掉再退出，否则每跑一次都漏一个
  // headless Chrome + ORT worker，下一次测量就在噪声里（实测会拖慢后续帧率）。
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
