// clip-recognition.mjs — 用无头 Chrome 把一个视频从头播到尾，记录识别状态并截图。
//
// 用法（先 npm run serve）：
//   node scripts/clip-recognition.mjs \
//     --clip /eval-data/refuel/oil-sample-demo.mp4 \
//     --profile /web/profiles/refuel.json \
//     --out runs/oil-sample-2026-11-11/test/refuel-roi \
//     --name refuel-roi --export
//
// --clip / --profile 是页面同源的绝对 URL 路径（serve.py 的根目录是仓库根）。
// --export 会点「导出 JSON」，把浏览器下载的 JSONL 收进 --out（供 evaluate.mjs 离线评估）。
// --max-seconds N   播放上限（默认按素材时长 1.5×+30s，至少 60s）；到上限没播完会
//                   在报告里标注截断并以非 0 退出，除非再加 --allow-truncate。
// --allow-truncate  明确接受「只播了一部分」的数据，退出码仍为 0。
// --export 下载失败同样以非 0 退出，并在 <name>.md 顶部写明原因。
//
// 输出：
//   <out>/<name>.json          逐次采样的状态（时间、姿态、动作、设备框）
//   <out>/<name>.md            人读报告（截图 + 时间线）
//   <out>/shots/*.png          整页截图（动作/设备框状态变化时 + 每 10s）
//   <out>/<name>.frames.jsonl  可选：Demo 导出的帧（--export）

import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openPage, sleep } from '../web/test/cdp.mjs';

const args = {
  base: 'http://127.0.0.1:8765',
  clip: '/eval-data/refuel/oil-sample-demo.mp4',
  profile: '/web/profiles/refuel.json',
  out: 'runs/clip-test',
  name: 'clip',
  export: false,
  maxSeconds: null,
  allowTruncate: false,
  width: 1440,
  height: 900,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const next = () => process.argv[++i];
  if (a === '--base') args.base = next();
  else if (a === '--clip') args.clip = next();
  else if (a === '--profile') args.profile = next();
  else if (a === '--out') args.out = next();
  else if (a === '--name') args.name = next();
  else if (a === '--export') args.export = true;
  else if (a === '--max-seconds') args.maxSeconds = Number(next());
  else if (a === '--allow-truncate') args.allowTruncate = true;
  else if (a === '--width') args.width = Number(next());
  else if (a === '--height') args.height = Number(next());
  else if (a === '-h' || a === '--help') {
    console.log('用法见文件头注释'); process.exit(0);
  } else throw new Error(`未知参数 ${a}`);
}
const base = args.base.replace(/\/+$/, '');
const outDir = path.resolve(args.out);
const shotsDir = path.join(outDir, 'shots');
// 重跑时先清掉上一次的截图和浏览器下载：否则两轮文件混在同一目录，
// 报告里的截图链接会指到旧时间点。
await rm(shotsDir, { recursive: true, force: true });
await mkdir(shotsDir, { recursive: true });
// --name 是用户输入，不能拼进正则（'refuel(roi)' 会 SyntaxError，'.*' 会误删全部）。
const ownFrames = `${args.name}.frames.jsonl`;
for (const f of await readdir(outDir).catch(() => [])) {
  if (/^pose-frames-.*\.jsonl$/.test(f) || f === ownFrames) {
    await rm(path.join(outDir, f), { force: true });
  }
}

const STATE_EXPR = `(() => {
  const st = window.__pose.state;
  const f = window.__pose.lastFrame;
  const v = document.querySelector('video');
  const flags = (f && f.actions && f.actions.flags) || {};
  const objs = (f && f.objects) || [];
  const by = {};
  for (const o of objs) by[o.label || '?'] = (by[o.label || '?'] || 0) + 1;
  return {
    t: v ? (Number.isFinite(v.currentTime) ? Math.round(v.currentTime * 1000) / 1000 : null) : null,
    dur: v && Number.isFinite(v.duration) ? Math.round(v.duration * 1000) / 1000 : null,
    paused: v ? v.paused : null,
    ended: v ? v.ended : null,
    frames: st.frames,
    fps: st.fps,
    estimatorReady: !!st.estimatorReady,
    profileLoaded: !!st.profileLoaded,
    objectOn: !!st.objectOn,
    objectReady: !!st.objectReady,
    objectError: st.objectError || null,
    objects: objs.length,
    objectTags: by,
    persons: (f && f.persons ? f.persons.length : 0),
    posture: (f && f.actions && f.actions.posture) || null,
    operating: !!flags.operating,
    nearEquipment: !!flags.nearEquipment,
    armsOn: Object.keys(flags).filter((k) => flags[k] && k !== 'operating' && k !== 'nearEquipment'),
    status: (document.getElementById('status') || {}).textContent || '',
  };
})()`;

const waitUntil = async (cdp, expr, timeout = 60000, interval = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await cdp.eval(expr)) return true; } catch { /* navigating */ }
    await sleep(interval);
  }
  return false;
};

const screenshot = async (cdp, file) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(r.data, 'base64'));
};

const safeTag = (s) => s.replace(/[^\w一-龥.-]+/g, '_').slice(0, 60);

const pages = await openPage(`${base}/web/`, { width: args.width, height: args.height });
const { cdp, errors, close } = pages;
const samples = [];
const shots = [];
let exported = null;

try {
  // 下载目录：导出的 JSONL 直接落进 --out
  if (args.export) {
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: outDir, eventsEnabled: true,
    }, null);
  }

  // 截图用固定设置：不镜像、骨架/关键点/手部全开。localStorage 是页面级设置，
  // 不写的话默认 mirror=true，截图里的面板文字是反的。
  await cdp.eval(`localStorage.setItem('pose-demo.settings.v1', ${JSON.stringify(JSON.stringify({
    model: 'full', delegate: 'GPU', fps: '30',
    skeleton: true, hands: true, points: true, mirror: false, loop: false,
    multi: false, profile: { id: 'default', url: null },
  }))}); true`);

  cdp.events.length = 0;
  const url = `${base}/web/?profile=${encodeURIComponent(args.profile)}&src=${encodeURIComponent(args.clip)}`;
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor('Page.loadEventFired', 30000);

  const ready = await waitUntil(cdp, '__pose.state.estimatorReady && __pose.state.profileLoaded && __pose.state.frames > 3', 60000);
  if (!ready) {
    const diag = await cdp.eval(`(() => {
      const st = window.__pose ? window.__pose.state : null;
      const v = document.querySelector('video');
      return {
        hasPose: !!window.__pose,
        ready: st && st.estimatorReady, profileLoaded: st && st.profileLoaded,
        frames: st && st.frames, mode: st && st.mode,
        status: (document.getElementById('status') || {}).textContent,
        video: v ? { readyState: v.readyState, paused: v.paused, dur: v.duration, t: v.currentTime } : null,
        loc: location.href,
      };
    })()`).catch((e) => ({ evalError: e.message }));
    throw new Error(`模型/profile 未就绪：${JSON.stringify(diag)}`);
  }
  // 物体检测是懒加载的（loop() 第一帧才 ensureObjectDetector）：不等就绪就开播，
  // 前几秒 objectSamples=0、截图里没有设备框，和带 --export 的运行不可比。
  // ROI 档 objectOn=false，条件立刻为真。
  const objReady = await waitUntil(cdp, '!__pose.state.objectOn || __pose.state.objectReady || __pose.state.objectError', 60000);
  if (!objReady) console.warn('[clip-recognition] 物体模型 60s 内未就绪，开头几秒的采样可能缺少设备框');
  await cdp.eval('(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); return 1; })()');

  // 播放上限按素材时长给余量（默认 1.5×+30s，至少 60s），不再固定 180s 静默截断。
  // 未知时长（流/元数据未就绪）退回 180s 估算。
  const durSec = await cdp.eval('(() => { const v = document.querySelector("video"); return v && Number.isFinite(v.duration) ? v.duration : null; })()');
  const maxSec = Number.isFinite(args.maxSeconds) && args.maxSeconds > 0
    ? args.maxSeconds
    : Math.max(60, (Number.isFinite(durSec) ? durSec : 180) * 1.5 + 30);
  const maxMs = maxSec * 1000;

  const startedAt = Date.now();
  let prev = null;
  let lastShotAt = -999;
  let lastPeriodic = -999;
  let objectTagSeen = '';
  let shotIdx = 0;
  let hitLimit = false;

  while (true) {
    if (Date.now() - startedAt >= maxMs) { hitLimit = true; break; }
    const s = await cdp.eval(STATE_EXPR);
    s.wall = Math.round((Date.now() - startedAt) / 100) / 10;
    samples.push(s);

    const take = (tag) => {
      shotIdx += 1;
      const file = path.join(shotsDir, `${String(shotIdx).padStart(2, '0')}_t${(s.t || 0).toFixed(2)}_${safeTag(tag)}.png`);
      shots.push({ i: shotIdx, t: s.t, tag, file: path.relative(outDir, file).replace(/\\/g, '/') });
      return screenshot(cdp, file);
    };

    const tags = [];
    if (s.operating && !prev?.operating) tags.push('operating-on');
    if (!s.operating && prev?.operating) tags.push('operating-off');
    if (s.nearEquipment && !prev?.nearEquipment) tags.push('near-on');
    const tagKey = Object.keys(s.objectTags).sort().join(',');
    if (tagKey && tagKey !== objectTagSeen) { tags.push(`objects-${tagKey}`); objectTagSeen = tagKey; }

    if (tags.length && shots.length < 16) {
      await take(tags.join('_'));
      lastShotAt = s.t || 0;
    } else if (!tags.length && (s.t || 0) - lastPeriodic >= 10 && shots.length < 16) {
      await take('sample');
      lastPeriodic = s.t || 0;
      lastShotAt = s.t || 0;
    }

    prev = s;
    if (s.ended) break;
    if (s.dur && s.t != null && s.t >= s.dur - 0.15) {
      await sleep(800);
      break;
    }
    await sleep(400);
  }

  // 收尾：暂停 + 最后状态 + 最后一帧截图
  await cdp.eval('(() => { const v = document.querySelector("video"); if (v) v.pause(); return 1; })()');
  await sleep(400);
  const final = await cdp.eval(STATE_EXPR);
  samples.push({ ...final, wall: Math.round((Date.now() - startedAt) / 100) / 10, final: true });
  shotIdx += 1;
  const finalFile = path.join(shotsDir, `${String(shotIdx).padStart(2, '0')}_t${(final.t || 0).toFixed(2)}_final.png`);
  await screenshot(cdp, finalFile);
  shots.push({ i: shotIdx, t: final.t, tag: 'final', file: path.relative(outDir, finalFile).replace(/\\/g, '/') });

  // 到上限退出但没播到片尾 = 数据截断。最终帧离片尾 0.5s 内算正常收尾。
  const truncated = hitLimit
    && !(Number.isFinite(final.dur) && Number.isFinite(final.t) && final.t >= final.dur - 0.5);
  if (truncated) {
    console.warn(`[clip-recognition] 播放到上限 ${maxSec.toFixed(0)}s 仍未播完`
      + `（t=${final.t ?? '?'}s / ${final.dur ?? '?'}s）：帧数据被截断，evaluate 的 recall 结论不可信。`
      + ' 可用 --max-seconds 放长，或 --allow-truncate 明确接受。');
  }

  let exportError = null;
  if (args.export) {
    const before = new Set((await readdir(outDir)).filter((f) => /^pose-frames-.*\.jsonl$/.test(f)));
    const clicked = await cdp.eval('(() => { const b = document.getElementById("btnExport"); if (b) b.click(); return !!b; })()');
    let got = null;
    if (!clicked) {
      exportError = '页面里没有 #btnExport，无法导出帧';
    } else {
      for (let i = 0; i < 80; i++) {
        const now = (await readdir(outDir)).filter((f) => /^pose-frames-.*\.jsonl$/.test(f) && !before.has(f));
        if (now.length) { got = now[0]; break; }
        await sleep(250);
      }
    }
    if (got) {
      const target = path.join(outDir, `${args.name}.frames.jsonl`);
      await copyFile(path.join(outDir, got), target);
      exported = path.relative(outDir, target).replace(/\\/g, '/');
    } else if (!exportError) {
      exportError = `点击导出后 20s 内没有新 JSONL 落进 ${outDir}`;
    }
    if (exportError) console.warn(`[clip-recognition] --export 失败：${exportError}`);
  }

  // 导出 meta（模型/objects 指纹）留给报告
  let meta = null;
  if (exported) {
    const { readFile } = await import('node:fs/promises');
    const first = (await readFile(path.join(outDir, exported), 'utf8')).split('\n')[0];
    try { meta = JSON.parse(first); } catch { meta = null; }
  }

  const operating = samples.filter((s) => s.operating);
  const near = samples.filter((s) => s.nearEquipment);
  const withObjects = samples.filter((s) => s.objects > 0);
  const labelCounts = {};
  for (const s of withObjects) for (const [k, v] of Object.entries(s.objectTags)) labelCounts[k] = (labelCounts[k] || 0) + v;

  const summary = {
    name: args.name,
    clip: args.clip,
    profile: args.profile,
    startedAt: new Date().toISOString(),
    durationSec: final.dur,
    coveredSec: final.t,
    maxSeconds: Math.round(maxSec),
    truncated,
    samples: samples.length,
    frames: final.frames,
    fps: final.fps,
    operatingSamples: operating.length,
    nearSamples: near.length,
    objectSamples: withObjects.length,
    objectLabelCounts: labelCounts,
    exported,
    exportError,
    meta: meta ? {
      model: meta.model, delegate: meta.delegate, profile: meta.profile,
      params_hash: meta.params_hash, frame_count: meta.frame_count, fps: meta.fps,
      objects: meta.objects,
    } : null,
    errors: errors.slice(0, 5),
  };
  await writeFile(path.join(outDir, `${args.name}.json`),
    JSON.stringify({ summary, samples, shots }, null, 2));

  const md = [];
  md.push(`# 识别测试 · ${args.name}`, '');
  if (truncated) {
    md.push(`> ⚠️ 只覆盖到 t=${final.t ?? '?'}s / ${final.dur ?? '?'}s（播放上限 ${Math.round(maxSec)}s）：`
      + '帧数据被截断，后续 evaluate 算出的 recall 不可信。', '');
  }
  if (exportError) md.push(`> ⚠️ 帧导出失败：${exportError}。后续 evaluate 没有输入。`, '');
  md.push(`- 素材：\`${args.clip}\``);
  md.push(`- profile：\`${args.profile}\``);
  md.push(`- 时长：${final.dur ?? '?'}s；记录 ${final.frames} 帧（${final.fps ?? '?'} fps）`);
  md.push(`- 采样：${samples.length} 次；operating 命中 ${operating.length} 次；nearEquipment 命中 ${near.length} 次`);
  md.push(`- 设备框：${withObjects.length} 次采样有框 ${JSON.stringify(labelCounts)}`);
  if (summary.meta) {
    md.push(`- 导出 meta：model ${summary.meta.model || '—'}/${summary.meta.delegate || '—'}，profile ${summary.meta.profile || '—'}，${summary.meta.frame_count} 帧，${summary.meta.fps} fps`);
    if (summary.meta.objects) {
      // app.js 写的 objects 是扁平对象（backend/model/inputSize/modelHash/labelsHash/manifestOk），
      // 不是 modules 数组——按 modules 读会恒为 undefined，报告里只剩「—」。
      const o = summary.meta.objects;
      md.push(`- 物体模型：${o.backend || '—'}/${o.model || '—'}@${o.inputSize ?? '?'} `
        + `sha256:${(o.modelHash || '—').slice(0, 8)} labels:${o.labelsHash || '—'}`
        + (o.manifestOk === false ? ' · sidecar 校验失败' : ''));
    }
  }
  if (exported) md.push(`- 帧导出：\`${exported}\``);
  if (errors.length) md.push(`- JS 错误：${errors.length} 条（见 json）`);
  // 时间线只保留状态变化和每 3s 一行，避免 145 行表格淹没结论
  md.push('', '## 时间线', '', '| t | 姿态 | operating | near | 设备框 | 截图 |', '| --- | --- | --- | --- | --- | --- |');
  let shown = -999;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const prevS = samples[i - 1];
    const changed = !prevS
      || s.operating !== prevS.operating || s.nearEquipment !== prevS.nearEquipment
      || JSON.stringify(s.objectTags) !== JSON.stringify(prevS.objectTags)
      || s.posture !== prevS.posture;
    if (!changed && (s.t || 0) - shown < 3) continue;
    shown = s.t || 0;
    const shot = shots.find((x) => Math.abs((x.t || 0) - (s.t || 0)) < 0.05);
    md.push(`| ${s.t ?? '—'}s | ${s.posture || '—'} | ${s.operating ? '✓' : ''} | ${s.nearEquipment ? '✓' : ''} | ${s.objects ? JSON.stringify(s.objectTags) : ''} | ${shot ? `[${shot.tag}](${shot.file})` : ''} |`);
  }
  md.push('', '## 截图', '');
  for (const sh of shots) {
    md.push(`### ${sh.tag} @ ${sh.t}s`, '', `![](${sh.file})`, '');
  }
  await writeFile(path.join(outDir, `${args.name}.md`), md.join('\n'));

  console.log(JSON.stringify({
    name: args.name, frames: final.frames, fps: final.fps,
    samples: samples.length, operatingSamples: operating.length, nearSamples: near.length,
    objectSamples: withObjects.length, objectLabelCounts: labelCounts,
    shots: shots.length, exported, exportError, truncated, errors: errors.length,
  }, null, 0));

  // 截断或导出失败都不能悄悄 exit 0：调用方（人/脚本）要能发现这批数据不完整。
  if (exportError) process.exitCode = 1;
  else if (truncated && !args.allowTruncate) process.exitCode = 1;
} finally {
  await close();
}
