// headless-open-data.mjs — 用开源素材跑一遍链路，出"能不能跑"的数字
// 运行：node web/test/headless-open-data.mjs [baseUrl]
//   baseUrl 默认 http://127.0.0.1:8765/web/（先 python serve.py 8765）
//
// 它回答：这段真实画面里，姿态模型能同时检出几个人？跟踪器给出几条轨迹？物体检测出几个框？
// 它不回答：准确率（recall/precision）。那需要标注与自己的机位，见 docs/eval.md。
//
// 素材由 scripts/fetch-eval-data.py 下载到 eval-data/open/；缺文件会跳过而不是失败。

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OPEN = path.join(ROOT, 'eval-data', 'open');

const base = (process.argv[2] || 'http://127.0.0.1:8765/web/').replace(/\/?$/, '/');
const url = (params) => `${base}?${params}`;

const stateExpr = `(() => {
  const s = window.__pose && window.__pose.state;
  if (!s) return null;
  const f = s.lastResult || {};
  return {
    frames: s.frames, fps: s.fps, multiReady: s.multiReady, objectReady: s.objectReady,
    verdicts: (f.verdicts || []).length,
    persons: (f.persons || []).length,
    tracks: s.tracks, objects: s.objects,
    posture: (f.verdicts && f.verdicts[0] && f.verdicts[0].act) ? f.verdicts[0].act.postureId : null,
  };
})()`;

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function sample(cdp, ms = 12000, step = 400) {
  const t0 = Date.now();
  const rows = [];
  let lastFrames = -1;
  let still = 0;
  while (Date.now() - t0 < ms) {
    const s = await cdp.eval(stateExpr);
    if (s && s.frames > 0) rows.push(s);
    // 只在这帧数不再增长（播完了）时重播——每轮都点 replay 会把 frameLog 清空，
    // 采到的 frames 永远是 1~3，那是最初一版踩过的坑。
    if (s && s.frames === lastFrames) still++;
    else still = 0;
    lastFrames = s ? s.frames : lastFrames;
    if (still >= 2) {
      await cdp.eval(`(() => { const b = document.getElementById('btnReplay'); if (b) b.click(); return true; })()`);
      still = 0;
      lastFrames = -1;
      await sleep(600);
    }
    await sleep(step);
  }
  return rows.filter((r) => r.frames > 0);
}

async function runVideo(file) {
  const name = path.basename(file);
  const { cdp, errors, close } = await openPage(url(`profile=/web/profiles/safety.json&src=/eval-data/open/mot17/${name}`));
  try {
    // 等模型 + 跑起来（多人模型是懒加载的，第一次要建 IMAGE 实例）
    for (let i = 0; i < 60; i++) {
      const s = await cdp.eval(stateExpr);
      if (s && s.multiReady && s.frames > 5) break;
      // 视频被停在 0 帧时补一次 play()：自动播放策略/首帧事件都可能让它不自己开始
      if (s && s.frames === 0 && s.fps !== undefined) {
        await cdp.eval(`(() => { const v = document.getElementById('video'); if (v && v.paused) v.play().catch(() => {}); return true; })()`);
      }
      await sleep(500);
    }
    const rows = await sample(cdp);
    const persons = rows.map((r) => r.verdicts || r.persons);
    const objs = rows.map((r) => r.objects);
    const fatal = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
    return {
      name,
      frames: rows.length ? Math.max(...rows.map((r) => r.frames)) : 0,
      personsMax: Math.max(0, ...persons),
      personsMedian: median(persons),
      tracks: Math.max(0, ...rows.map((r) => r.tracks)),
      objectsMax: Math.max(0, ...objs),
      objectsMedian: median(objs),
      fps: rows.length ? rows[rows.length - 1].fps : 0,
      posture: rows.length ? rows[rows.length - 1].posture : null,
      errors: fatal.slice(0, 2),
    };
  } finally {
    await close();
  }
}

async function runImage(file) {
  const name = path.basename(file);
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const { cdp, errors, close } = await openPage(url(`profile=/web/profiles/safety.json&src=/${rel}`));
  try {
    for (let i = 0; i < 40; i++) {
      const s = await cdp.eval(stateExpr);
      if (s && s.objects !== null && s.persons >= 0 && s.multiReady) break;
      await sleep(500);
    }
    await sleep(1200);
    const s = await cdp.eval(stateExpr);
    const fatal = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
    return {
      name,
      persons: s ? (s.verdicts || s.persons) : 0,
      objects: s ? s.objects : 0,
      posture: s ? s.posture : null,
      errors: fatal.slice(0, 2),
    };
  } finally {
    await close();
  }
}

async function main() {
  const videosDir = path.join(OPEN, 'mot17');
  const videos = [];
  if (await exists(videosDir)) {
    for (const f of await readdir(videosDir)) if (f.toLowerCase().endsWith('.mp4')) videos.push(path.join(videosDir, f));
  }
  if (!videos.length) {
    console.log(`没有找到视频素材（${videosDir}）。先跑：python scripts/fetch-eval-data.py`);
    process.exit(1);
  }

  // PPE 图片：各来源抽第一张，验证"图像输入 + 物体检测"这条路
  const images = [];
  for (const sub of ['PPE_detection/train/images', 'Safety-helmet-dataset', 'roboflow-construction-ppe-fruwx']) {
    const dir = path.join(OPEN, sub);
    if (!(await exists(dir))) continue;
    const walk = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { const got = await walk(p); if (got) return got; }
        else if (/\.(jpe?g|png)$/i.test(e.name)) return p;
      }
      return null;
    };
    const first = await walk(dir);
    if (first) images.push(first);
  }

  console.log(`\n视频素材 ${videos.length} 段，图片素材 ${images.length} 张，base=${base}\n`);
  let bad = 0;
  console.log('素材\t\t\t\t帧\t人数max\t人数中位\t轨迹\t框max\t框中位\tfps\t姿态');
  for (const v of videos) {
    const r = await runVideo(v);
    console.log(`${r.name}\t${r.frames}\t${r.personsMax}\t\t${r.personsMedian}\t\t${r.tracks}\t${r.objectsMax}\t${r.objectsMedian}\t${r.fps}\t${r.posture || '-'}`);
    if (r.errors.length) console.log(`  JS: ${r.errors.join(' | ')}`);
    if (!r.frames) { bad++; console.log('  FAIL 一个帧都没跑起来'); }
  }
  for (const img of images) {
    const r = await runImage(img);
    console.log(`[图] ${r.name}: 人 ${r.persons} · 框 ${r.objects} · 姿态 ${r.posture || '-'}`);
    if (r.errors.length) console.log(`  JS: ${r.errors.join(' | ')}`);
  }

  console.log('\n说明：人数/框数是采样到的最大与中位值，不是准确率；轨迹数是跟踪器当前活着的轨迹数。');
  process.exit(bad ? 1 : 0);
}

main();
