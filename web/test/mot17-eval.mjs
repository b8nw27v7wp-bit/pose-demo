// mot17-eval.mjs — 用 MOT17 的 gt 评估「多人姿态 + 跟踪」的帧级指标
// 运行：npm run serve -- 8765   # 另开一个终端
//       node web/test/mot17-eval.mjs [baseUrl] [--seq MOT17-02-FRCNN,...] [--topk 3] [--iou 0.5]
//                                      [--rate 0.4] [--fps 15] [--profile URL] [--model full]
//
// 回答两个问题：画面里的人框能不能对上 gt？同一个人的 track_id 会不会乱跳？
// **不回答动作准确率**——MOT17 只有人框标注，没有举手/挥手等动作标签。
//
// 指标口径：
// - 召回/精确：逐帧把 app 的 verdicts 框与 gt 的 class=1/conf=1 行人框按 IoU 贪心匹配。
//   MOT17 拥挤帧有几十人，而 app 最多 numPoses（默认 3）人，所以**原始召回天然很低**；
//   这不是跟踪器坏了，是"姿态模型不是人群检测器"（docs/open-datasets.md 已写）。
// - TopK 召回：每帧只取 gt 里面积最大的 K 个人（默认 3），衡量"画面里最显眼的几个人"。
// - ID 切换：同一 gt id 在相邻两个匹配帧之间 app track_id 变化次数 / 相邻匹配对数。
// - 碎片轨迹：一个 gt id 对应过 >1 个 app track_id 的个数。
//
// 对齐：scripts/fetch-eval-data.py 把前 N 帧按 25fps 合成 mp4，所以
//   gt 帧号 = round(video_time * 25) + 1。改合成 fps 时这里要同步（VIDEO_FPS）。
//
// 注意：MOT17 许可是 CC BY-NC-SA 3.0（非商用）。这里的数字只用于研究与阈值校准。

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, sleep } from './cdp.mjs';
import { ARM_ACTIONS } from '../js/actions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'eval-data', 'open', 'mot17');
const VIDEO_FPS = 25;
const DEFAULT_BASE = 'http://127.0.0.1:8765/web/';

function parseArgs(argv) {
  const out = {
    base: DEFAULT_BASE, seqs: [], topk: 3, iou: 0.5,
    profile: '/web/profiles/safety.json', model: null, debug: false,
    // 播放倍速：1 = 实时。默认 1；做 A/B 时用 0.4，让视频帧率(10fps)低于推理上限(15fps)，
    // 应用能处理**每一帧**，两次运行评测的帧集合一致——否则 25fps 视频只跑到 ~14fps，
    // 每次丢的帧不同，ID 切换会在 13%~17% 之间乱跳（实测同配置三次 70/59/56）。
    rate: 1,
    // 推理帧率上限（页面工具栏）。null = 用页面默认；A/B 时要固定，否则改默认值会让
    // 新老结果不可比（30fps 上限在慢放时会在同一视频帧内多处理几次）。
    fps: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seq') out.seqs = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--topk') out.topk = Math.max(1, Number(argv[++i]) || 3);
    else if (a === '--iou') out.iou = Number(argv[++i]) || 0.5;
    else if (a === '--profile') out.profile = String(argv[++i] || out.profile);
    else if (a === '--model') out.model = String(argv[++i] || '').trim() || null;
    else if (a === '--rate') out.rate = Math.min(1, Math.max(0.1, Number(argv[++i]) || 1));
    else if (a === '--fps') out.fps = Math.max(1, Number(argv[++i]) || 0) || null;
    else if (a === '--debug') out.debug = true;
    else if (!a.startsWith('--')) out.base = a;
  }
  out.base = out.base.replace(/\/?$/, '/');
  return out;
}

const opts = parseArgs(process.argv.slice(2));

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const uni = area(a) + area(b) - inter;
  return uni > 0 ? inter / uni : 0;
}

/** 贪心按 IoU 从高到低配对（每个人/每个框最多用一次） */
function matchFrame(gts, dets, thr) {
  const pairs = [];
  for (let gi = 0; gi < gts.length; gi++) {
    for (let di = 0; di < dets.length; di++) {
      const v = iou(gts[gi].bbox, dets[di].bbox);
      if (v >= thr) pairs.push({ gi, di, v });
    }
  }
  pairs.sort((a, b) => b.v - a.v);
  const ug = new Set();
  const ud = new Set();
  const matches = [];
  for (const p of pairs) {
    if (ug.has(p.gi) || ud.has(p.di)) continue;
    ug.add(p.gi);
    ud.add(p.di);
    matches.push(p);
  }
  return { matches, ug, ud };
}

/**
 * gt.txt → 每帧 {targets, ignore}
 * targets = class 1 + conf 1（标准 MOT 行人）；ignore = 其它类（static person/distractor 等），
 * 落在 ignore 框里的误检不算 FP，和 MOT 评测的口径一致。
 *
 * 框按图像边界裁剪：MOT17 的 gt 会包含大面积在画面外的行人（例如 x<0），
 * 姿态模型只能看到画面内那部分，不裁剪就会把"画面外的人"算成漏检。
 * 可见面积不足原框 30% 的行人转进 ignore（不参与召回、也不算误检）。
 */
function parseGt(text, { w = 0, h = 0 } = {}) {
  const targets = new Map();
  const ignore = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = line.split(',').map(Number);
    const [frame, id, x, y, bw, bh, conf, cls] = p;
    if (!Number.isFinite(frame) || !(bw > 0) || !(bh > 0)) continue;
    let box = [x, y, x + bw, y + bh];
    let target = cls === 1 && conf === 1;
    if (w > 0 && h > 0) {
      const clipped = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(w, box[2]), Math.min(h, box[3])];
      const visible = Math.max(0, clipped[2] - clipped[0]) * Math.max(0, clipped[3] - clipped[1]);
      if (target && visible / (bw * bh) < 0.3) target = false;
      box = clipped;
      if (box[2] <= box[0] || box[3] <= box[1]) continue;
    }
    const map = target ? targets : ignore;
    if (!map.has(frame)) map.set(frame, []);
    map.get(frame).push({ id, bbox: box });
  }
  return { targets, ignore };
}

function evaluate(summary, gt, { topk, iouThr }) {
  let frames = 0;
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let topTp = 0;
  let topFn = 0;
  let gtTotal = 0;
  let detTotal = 0;
  let bestTop1 = 0;
  const details = [];
  const gtSeq = new Map();     // gt id -> [{frame, appId}]
  let pairs = 0;
  let switches = 0;
  let lastFrame = -1;

  for (const row of summary) {
    if (row.video_time == null || !Number.isFinite(row.video_time)) continue;
    const frame = Math.round(row.video_time * VIDEO_FPS) + 1;
    // 慢放（--rate 0.4）时 currentTime 连续推进，应用可能在同一个 25fps 帧边界内
    // 处理两次；去重，否则同一帧被计两次，TP/对数都会被放大。
    if (frame === lastFrame) continue;
    lastFrame = frame;
    const gts = gt.targets.get(frame);
    if (!gts) continue;
    const ign = gt.ignore.get(frame) || [];
    const dets = (row.verdicts || []).filter((d) => Array.isArray(d.bbox) && d.bbox.length === 4);
    frames++;
    gtTotal += gts.length;
    detTotal += dets.length;

    const top1 = gts.reduce((a, b) => (area(b.bbox) > area(a.bbox) ? b : a));
    bestTop1 += dets.reduce((m, d) => Math.max(m, iou(top1.bbox, d.bbox)), 0);
    if (opts.debug && details.length < 4) {
      const top = [...gts].sort((a, b) => area(b.bbox) - area(a.bbox)).slice(0, 3);
      details.push({ frame, t: row.video_time, gtCount: gts.length, dets,
        top: top.map((g) => ({
          id: g.id, box: g.bbox.map((v) => Math.round(v)),
          best: Math.max(0, ...dets.map((d) => iou(g.bbox, d.bbox))),
        })) });
    }

    const m = matchFrame(gts, dets, iouThr);
    tp += m.matches.length;
    fn += gts.length - m.matches.length;
    // FP：没对上目标的检测框；落在 ignore 框里的不算（MOT 的标准做法）
    for (let di = 0; di < dets.length; di++) {
      if (m.ud.has(di)) continue;
      if (ign.some((g) => iou(dets[di].bbox, g.bbox) >= iouThr)) continue;
      fp++;
    }

    const top = [...gts].sort((a, b) => area(b.bbox) - area(a.bbox)).slice(0, topk);
    const mt = matchFrame(top, dets, iouThr);
    topTp += mt.matches.length;
    topFn += top.length - mt.matches.length;

    for (const p of m.matches) {
      const g = gts[p.gi];
      const d = dets[p.di];
      if (!gtSeq.has(g.id)) gtSeq.set(g.id, []);
      gtSeq.get(g.id).push({ frame, appId: d.track_id });
    }
  }

  let frag = 0;
  for (const list of gtSeq.values()) {
    list.sort((a, b) => a.frame - b.frame);
    if (new Set(list.map((x) => x.appId)).size > 1) frag++;
    for (let i = 1; i < list.length; i++) {
      pairs++;
      if (list[i].appId !== list[i - 1].appId) switches++;
    }
  }

  return {
    frames, tp, fn, fp, topTp, topFn,
    recall: tp / (tp + fn || 1),
    precision: tp / (tp + fp || 1),
    topRecall: topTp / (topTp + topFn || 1),
    matchedGt: gtSeq.size,
    frag, pairs, switches,
    gtAvg: gtTotal / (frames || 1),
    detAvg: detTotal / (frames || 1),
    bestTop1: bestTop1 / (frames || 1),
    details,
  };
}

async function discover() {
  const list = [];
  let names = [];
  try { names = await readdir(DIR); } catch { /* 目录不存在 */ }
  for (const f of names) {
    if (!f.toLowerCase().endsWith('.mp4')) continue;
    const seq = f.slice(0, -4);
    const base = path.join(DIR, seq, 'val', seq);
    const gtPath = path.join(base, 'gt', 'gt.txt');
    if (!(await exists(gtPath))) continue;
    if (opts.seqs.length && !opts.seqs.includes(seq)) continue;
    list.push({ seq, mp4: path.join(DIR, f), gtPath, infoPath: path.join(base, 'seqinfo.ini') });
  }
  return list.sort((a, b) => a.seq.localeCompare(b.seq));
}

async function imageSize(infoPath) {
  try {
    const text = await readFile(infoPath, 'utf8');
    const w = Number(/imWidth\s*=\s*(\d+)/.exec(text)?.[1]) || 0;
    const h = Number(/imHeight\s*=\s*(\d+)/.exec(text)?.[1]) || 0;
    return { w, h };
  } catch {
    return { w: 0, h: 0 };
  }
}

/**
 * 动作触发率：MOT17 行人没有动作标注，这里只能统计"每个人-帧"里各动作亮起的比例。
 * 它不是准确率；用途是发现明显误报（例如举人在走路却 20% 的帧亮着举手）。
 */
function actionStats(summary) {
  let verdicts = 0;
  let frozen = 0;
  const counts = new Map();
  for (const row of summary) {
    for (const v of row.verdicts || []) {
      if (!v.flags) continue;
      verdicts++;
      if (v.frozen) frozen++;
      for (const [k, val] of Object.entries(v.flags)) {
        if (val === true) counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  }
  return { verdicts, frozen, counts };
}

async function runSeq(item) {
  const url = `${opts.base}?profile=${encodeURIComponent(opts.profile)}&src=/eval-data/open/mot17/${encodeURIComponent(item.seq)}.mp4`;
  const { cdp, errors, close } = await openPage(url);
  try {
    // 1. 等多人模型就绪（懒加载，首次要建 IMAGE 实例）
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = await cdp.eval('(() => !!(window.__pose && window.__pose.state.multiReady))()');
      if (!ready) await sleep(500);
    }
    if (!ready) return { seq: item.seq, error: '多人模型未就绪', errors };

    // 1b. 按需切换模型档位（lite/full/heavy）并等两个 estimator 重建完成
    if (opts.model) {
      const switched = await cdp.eval(`(() => {
        const el = document.getElementById('modelSel');
        if (!el) return null;
        if (el.value !== ${JSON.stringify(opts.model)}) {
          el.value = ${JSON.stringify(opts.model)};
          el.dispatchEvent(new Event('change'));
        }
        return el.value;
      })()`);
      if (switched !== opts.model) {
        return { seq: item.seq, error: `模型切换失败（${switched}）`, errors };
      }
      let rebuilt = false;
      for (let i = 0; i < 240 && !rebuilt; i++) {
        rebuilt = await cdp.eval('(() => { const s = window.__pose.state; return !!(s.estimatorReady && s.multiReady); })()');
        if (!rebuilt) await sleep(500);
      }
      if (!rebuilt) return { seq: item.seq, error: `模型 ${opts.model} 重建超时`, errors };
    }

    // 2. 关掉物体检测：这里只评跟踪，少一条 CPU 推理链能让日志更密
    await cdp.eval(`(() => {
      const el = document.getElementById('chkObjects');
      if (el && el.checked) { el.checked = false; el.dispatchEvent(new Event('change')); }
      return true;
    })()`);
    await sleep(600);

    // 2b. 固定推理帧率上限（不指定就用页面默认；改默认值后要显式传，A/B 才可比）
    if (opts.fps) {
      const applied = await cdp.eval(`(() => {
        const el = document.getElementById('fpsCapSel');
        if (!el) return null;
        const want = '${opts.fps}';
        // select 只有固定几个选项：value 不在里面时浏览器会把 value 置空，
        // inferInterval() 再回落到 30——A/B 会静默跑在错误的帧率上。
        if (![...el.options].some((o) => o.value === want)) return { error: 'no-option', value: el.value };
        el.value = want;
        el.dispatchEvent(new Event('change'));
        return { value: el.value };
      })()`);
      if (!applied || applied.error || applied.value !== String(opts.fps)) {
        return { seq: item.seq, error: `--fps ${opts.fps} 不在页面上限选项里（${applied?.value ?? '?'}）`, errors };
      }
    }

    // 3. 慢放后再从头播放（顺序不能反：先点播放再设倍速，会先按 1x 处理几帧）
    if (opts.rate < 1) {
      await cdp.eval(`(() => { const v = document.getElementById('video'); v.playbackRate = ${opts.rate}; return v.playbackRate; })()`);
    }
    await cdp.eval(`(() => { document.getElementById('btnReplay').click(); return true; })()`);
    let last = -1;
    let still = 0;
    for (let i = 0; i < 320; i++) {
      const s = await cdp.eval(`(() => {
        const v = document.getElementById('video');
        const st = window.__pose && window.__pose.state;
        return { f: st ? st.frames : 0, ended: !!(v && v.ended), dur: v ? v.duration : 0 };
      })()`);
      if (s.f > last) { last = s.f; still = 0; } else still++;
      if (s.ended && still >= 2) break;
      if (!s.dur && still > 20) break;     // 视频没播起来
      if (still > 40) break;                // 10s 没有新帧
      await sleep(250);
    }

    const summary = await cdp.eval('window.__pose.frameSummary');
    const multiKey = await cdp.eval('window.__pose.state.multiKey || ""');
    return {
      seq: item.seq, summary: Array.isArray(summary) ? summary : [], multiKey, errors,
    };
  } finally {
    await close();
  }
}

async function main() {
  const items = await discover();
  if (!items.length) {
    console.log(`没有找到 MOT17 素材（${DIR}）。先跑：npm run fetch:data -- --mot17-seqs ...`);
    process.exit(1);
  }

  console.log(`MOT17 帧级评估：${items.length} 条序列 · IoU≥${opts.iou} · TopK=${opts.topk}`
    + ` · 帧对齐 ${VIDEO_FPS}fps · profile=${opts.profile}`
    + (opts.rate < 1 ? ` · 慢放 ${opts.rate}x（逐帧）` : '')
    + (opts.model ? ` · model=${opts.model}` : '') + '\n');
  const head = ['序列', '帧', 'TP', 'FN', 'FP', '召回', '精确', 'TopK召回', 'ID切换/对数', '碎片轨迹', 'GT轨迹'];
  console.log(head.join('\t'));

  const total = {
    frames: 0, tp: 0, fn: 0, fp: 0, topTp: 0, topFn: 0,
    pairs: 0, switches: 0, frag: 0, matchedGt: 0, gtAvg: 0, detAvg: 0, bestTop1: 0,
  };
  const actionTotal = { verdicts: 0, frozen: 0, counts: new Map() };
  let failed = 0;
  for (const item of items) {
    const dims = await imageSize(item.infoPath);
    const gt = parseGt(await readFile(item.gtPath, 'utf8'), dims);
    let r;
    try {
      r = await runSeq(item);
    } catch (e) {
      r = { seq: item.seq, error: e.message };
    }
    if (r.error) {
      failed++;
      console.log(`${item.seq}\t${r.error}`);
      continue;
    }
    const m = evaluate(r.summary, gt, { topk: opts.topk, iouThr: opts.iou });
    for (const k of Object.keys(total)) {
      // 平均值字段按帧加权，不能直接加
      if (k === 'gtAvg' || k === 'detAvg' || k === 'bestTop1') continue;
      total[k] += m[k];
    }
    total.gtAvg += m.gtAvg * m.frames;
    total.detAvg += m.detAvg * m.frames;
    total.bestTop1 += m.bestTop1 * m.frames;
    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    console.log([
      item.seq, m.frames, m.tp, m.fn, m.fp, pct(m.recall), pct(m.precision),
      pct(m.topRecall), `${m.switches}/${m.pairs}`, m.frag, m.matchedGt,
    ].join('\t'));
    console.log(`  gt/帧 ${m.gtAvg.toFixed(2)} · 检出/帧 ${m.detAvg.toFixed(2)}`
      + ` · Top1最佳IoU ${m.bestTop1.toFixed(2)}`
      + (r.multiKey ? ` · estimator ${r.multiKey}` : ''));
    const act = actionStats(r.summary);
    actionTotal.verdicts += act.verdicts;
    actionTotal.frozen += act.frozen;
    for (const [k, n] of act.counts) actionTotal.counts.set(k, (actionTotal.counts.get(k) || 0) + n);
    if (act.verdicts) {
      const tops = ARM_ACTIONS
        .map((a) => ({ name: a.name, n: act.counts.get(a.flag) || 0 }))
        .filter((x) => x.n > 0)
        .sort((x, y) => y.n - x.n)
        .slice(0, 3)
        .map((x) => `${x.name} ${(x.n / act.verdicts * 100).toFixed(1)}%`);
      console.log(`  动作触发（前 3）：${tops.join(' · ') || '无'}`);
    }
    if (opts.debug) {
      for (const d of m.details) {
        console.log(`  [debug] gt帧 ${d.frame} t=${d.t}s：gt ${d.gtCount} 人 / det ${d.dets.length} 人`);
        for (const g of d.top) {
          console.log(`    gt#${g.id} box=${g.box.join(',')} bestIoU=${g.best.toFixed(2)}`);
        }
        for (const dd of d.dets.slice(0, 3)) {
          console.log(`    det#${dd.track_id} box=${dd.bbox.map((v) => Math.round(v)).join(',')}`);
        }
      }
    }
    const fatal = (r.errors || []).filter((e) => !/favicon|Failed to load resource/i.test(e));
    if (fatal.length) console.log(`  JS: ${fatal.slice(0, 2).join(' | ')}`);
  }

  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  console.log('\n合计：'
    + `帧 ${total.frames} · TP ${total.tp} / FN ${total.fn} / FP ${total.fp}`
    + ` · 召回 ${pct(total.tp / (total.tp + total.fn || 1))}`
    + ` · 精确 ${pct(total.tp / (total.tp + total.fp || 1))}`
    + ` · TopK召回 ${pct(total.topTp / (total.topTp + total.topFn || 1))}`
    + ` · ID切换 ${total.switches}/${total.pairs}`
    + ` · 碎片轨迹 ${total.frag}/${total.matchedGt}`);
  console.log(`平均：gt/帧 ${(total.gtAvg / (total.frames || 1)).toFixed(2)}`
    + ` · 检出/帧 ${(total.detAvg / (total.frames || 1)).toFixed(2)}`
    + ` · Top1最佳IoU ${(total.bestTop1 / (total.frames || 1)).toFixed(2)}`);
  if (actionTotal.verdicts) {
    const rate = (n) => `${(n / actionTotal.verdicts * 100).toFixed(1)}%`;
    console.log('\n动作触发率（MOT17 没有动作标注；分母 = 人-帧，只用于发现明显误报）：');
    console.log('  ' + ARM_ACTIONS
      .map((a) => `${a.name} ${rate(actionTotal.counts.get(a.flag) || 0)}`).join(' · '));
    console.log(`  判定冻结（低置信）${rate(actionTotal.frozen)}`);
  }
  console.log('说明：原始召回受 numPoses 上限（默认 3）限制，拥挤序列天然很低；'
    + 'TopK 召回看的是画面里最显眼的几个人。这些数字只用于调跟踪/检出阈值，不是动作准确率。');
  process.exit(failed === items.length ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
