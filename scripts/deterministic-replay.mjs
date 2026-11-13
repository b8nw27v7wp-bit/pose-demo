// deterministic-replay.mjs — 按固定媒体时间逐帧跑一遍页面，导出可复现的 JSONL。
//
// 为什么需要它：实时播放时浏览器按 rAF 抽样，同一段 58s 素材三次播放记录 1549 / 1511 /
// 1428 帧（见 docs/equipment-detector.md §6）。抽到哪些帧每次都不同，所以感知层的改动
// （换模型、加裁切、改检测间隔）没有任何可比较的基线；跨导出的指标差异里混着抽样差异。
//
// 这个脚本改成「seek 到 t = k / fps → 等 seeked → __pose.step() → 下一帧」：
//   · 帧集合由 fps 与素材时长唯一决定；
//   · 页面在 ?det=1 下用**媒体时间**做 ts（不是墙钟），Hold / 滤波 / tracker 的计时可复现；
//   · 每帧末尾 await 物体推理，ONNX 的框不会因为机器快慢落到不同帧上。
// 同一份素材 + 同一套代码/参数，两次运行的**逐帧内容**应当逐字节相同（脚本会打印 sha256，
// 可直接对比；首行 meta 含导出时间戳，不参与哈希）。实测同一份素材两次回放逐帧一致。
//
// 用法：
//   npm run serve                                     # 另开一个终端
//   node scripts/deterministic-replay.mjs <src> <profile> <outName> [选项]
//
//   例：
//   node scripts/deterministic-replay.mjs \
//     http://127.0.0.1:8765/eval-data/refuel/oil-sample-demo.mp4 \
//     http://127.0.0.1:8765/web/profiles/refuel-equipment.json refuel-det
//
//   <src> / <profile> 传**完整 URL**，或**不带前导斜杠**的站内路径（web/profiles/x.json）。
//   不要在 Windows Git Bash 下传以 / 开头的路径：MSYS 会把它改写成 D:/... 或
//   C:/Program Files/Git/...，拼进 URL 就是 404（脚本会拦下并报错，见 looksMangled）。
//   <outName> 写到 eval-data/incoming/<outName>.jsonl（eval-data/ 不进 git）。
//
// 选项：
//   --base=<url>       默认 http://127.0.0.1:8765
//   --model=<档位>     lite | full | heavy，默认 full
//   --delegate=<后端>  GPU | CPU，默认 CPU（确定性优先；GPU 结果可能随驱动浮动）
//   --fps=<n>          采样帧率（媒体时间网格），默认 10
//   --max-frames=<n>   只跑前 n 帧（调试用），默认不限制
//   --expect-hash=<sha256>  与导出的 sha256 比对，不一致则退出码 1（回归用）
//
// 输出：
//   eval-data/incoming/<outName>.jsonl       评估器直接能读的帧导出
//   eval-data/incoming/<outName>.meta.json   本次配置 + sha256 + 帧数（A/B 留档）

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openPage, sleep } from '../web/test/cdp.mjs';
import { profileParams, validateParams } from '../web/js/params.js';

/**
 * 设备框连续性统计（不需要真值）：检出率、确认率、闪烁次数、检测轮次。
 * 换检测器 / 改 inputSize / 改 intervalMs 时先看这张表，不用等人工标框。
 * 旧导出没有 operating_boxes_* 字段时返回 null。
 */
function equipmentStats(frames) {
  const has = frames.some((f) => f && f.signals && f.signals.operating_boxes_raw !== undefined);
  if (!has) return null;
  let personFrames = 0;
  let rawFrames = 0;
  let confirmedFrames = 0;
  let confirmedWithRaw = 0;
  let usedFrames = 0;
  let flicker = 0;
  let prev = null;
  const boxObservations = new Set();
  for (const f of frames) {
    if (!f || !f.signals) continue;
    if ((f.person_count || 0) > 0) personFrames++;
    const raw = f.signals.operating_boxes_raw || 0;
    if (raw > 0) rawFrames++;
    if ((f.signals.operating_boxes_confirmed || 0) > 0) confirmedFrames++;
    // confirmRate 的分子必须与分母同口径（都以「本帧有新检出」为前提）：
    // confirmedFrames 含 maxAgeMs 内沿用、没有新检出的帧，拿它当分子会出现 1.038 这种值。
    if (raw > 0 && (f.signals.operating_boxes_confirmed || 0) > 0) confirmedWithRaw++;
    if ((f.signals.operating_boxes_used || 0) > 0) usedFrames++;
    if (raw > 0 && f.objects_ts != null) boxObservations.add(f.objects_ts);
    if (prev !== null && (raw > 0) !== prev) flicker++;
    prev = raw > 0;
  }
  return {
    frames: frames.length,
    personFrames,
    rawFrames,
    // 确认态帧：含 maxAgeMs 内沿用、本帧没有新检出的帧，可以大于 rawFrames。
    confirmedFrames,
    // 新检出且确认态有效的帧：confirmRate 的分子，恒 <= rawFrames。
    confirmedWithRawFrames: confirmedWithRaw,
    usedFrames,
    rawRate: personFrames ? Math.round((rawFrames / personFrames) * 1000) / 1000 : null,
    confirmRate: rawFrames ? Math.round((confirmedWithRaw / rawFrames) * 1000) / 1000 : null,
    flicker,
    boxObservations: boxObservations.size,
  };
}

// —— 参数 ——
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flags = new Map(argv.filter((a) => a.startsWith('--')).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : 'true'];
}));

const rawSrc = positional[0];
const rawProfile = positional[1];
const outName = positional[2];
if (!rawSrc || !rawProfile || !outName) {
  console.error('用法：node scripts/deterministic-replay.mjs <src> <profile> <outName> [--base=...] [--model=full] [--delegate=CPU] [--fps=10]');
  process.exit(2);
}

const base = (flags.get('base') || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const model = flags.get('model') || 'full';
const delegate = flags.get('delegate') || 'CPU';
const fps = Number(flags.get('fps') || 10);
const maxFrames = Number(flags.get('max-frames') || 0) || Infinity;
const expectHash = flags.get('expect-hash') || null;
if (!(fps > 0)) {
  console.error(`--fps 无效：${flags.get('fps')}`);
  process.exit(2);
}

// Git Bash 的 MSYS 路径转换会把 `/web/profiles/x.json` 变成 `D:/.../web/profiles/x.json`，
// 拼进 URL 后变成一个 404 的畸形地址——profile 静默退回默认参数，回放结果看起来正常但阈值全错。
// 这种情况宁可直接报错，让用户传完整 URL。
const looksMangled = (u) => /^[A-Za-z]:[\\/]/.test(u) || u.startsWith('\\\\');
for (const [name, raw] of [['src', rawSrc], ['profile', rawProfile]]) {
  if (looksMangled(raw)) {
    console.error(`${name} 被 shell 转成了 Windows 路径：${raw}\n`
      + `请传完整 URL（例如 http://127.0.0.1:8765/web/profiles/refuel.json），`
      + 'Git Bash 下以 / 开头的参数会被自动改写。');
    process.exit(2);
  }
}

// 站内路径（不带前导斜杠）与完整 URL 都接受；以 / 开头的路径在 Unix 下也成立，
// Git Bash 会先把它改写成 Windows 路径，上面的 looksMangled() 已经挡住那种情况。
const abs = (u) => (/^https?:\/\//i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);
const src = abs(rawSrc);
const profile = abs(rawProfile);

// 预检：素材与 profile 都必须真的可达。profile 404 时页面会静默退回默认阈值，
// 那样的导出比"跑失败"更危险——数字看上去正常，实际不是这套参数算出来的。
for (const [name, u] of [['素材', src], ['profile', profile]]) {
  const res = await fetch(u, { method: 'HEAD' }).catch((e) => ({ ok: false, status: e.message }));
  if (!res.ok) {
    console.error(`${name}不可达：${u}（${res.status}）`);
    process.exit(2);
  }
}
// profile 参数一致性：页面里 applyParams 抛错只会表现为 profileLoaded 一直为 false，
// 这里要在开浏览器之前就把非法组合（如 boxMaxAgeMs 覆盖不了 objects.intervalMs）报出来。
{
  const res = await fetch(profile, { cache: 'no-cache' }).catch((e) => ({ ok: false, status: e.message }));
  if (res.ok) {
    let raw = null;
    try {
      raw = await res.json();
    } catch (e) {
      console.error(`profile 不是合法 JSON：${profile}（${e.message}）`);
      process.exit(2);
    }
    try {
      validateParams(profileParams(raw));
    } catch (e) {
      console.error(`profile 参数非法：${profile}\n${e.message}`);
      process.exit(2);
    }
  }
}

const outDir = path.resolve('eval-data/incoming');
const dlDir = path.join(outDir, `dl-${outName}`);
await rm(dlDir, { recursive: true, force: true });
await mkdir(dlDir, { recursive: true });

const url = `${base}/web/?det=1&profile=${encodeURIComponent(profile)}`;
console.log(`▶ 打开 ${url}`);
console.log(`  素材 ${src}`);
console.log(`  模型 ${model}/${delegate} · 采样 ${fps}fps`);
const { cdp, errors, close } = await openPage(url, { width: 1280, height: 800 });
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir }).catch(() => {});

let meta = null;
try {
  // 模型/后端要在加载素材前定好：useVideoSource 里会建估计器
  const st0 = await cdp.eval(`(() => {
    const m = document.getElementById('modelSel');
    if (m) { m.value = ${JSON.stringify(model)}; m.dispatchEvent(new Event('change')); }
    const d = document.getElementById('delegateSel');
    if (d) { d.value = ${JSON.stringify(delegate)}; d.dispatchEvent(new Event('change')); }
    return { det: __pose.state.detReplay, profileLoaded: __pose.state.profileLoaded, model: ${JSON.stringify(model)}, delegate: ${JSON.stringify(delegate)} };
  })()`);
  if (!st0.det) throw new Error('页面没有进入确定性回放模式（URL 少 ?det=1）');

  console.log('▶ 加载素材 …');
  const loaded = await cdp.eval(`__pose.useVideoSource(${JSON.stringify(src)})`);
  if (!loaded) throw new Error('useVideoSource 返回 false（素材加载/模型初始化失败）');

  // det 模式没有 rAF，物体/多人模型不会自己建；须显式触发后再开始计数
  const prepared = await cdp.eval('__pose.prepare()');
  if (prepared?.objectError) throw new Error(`物体检测器初始化失败：${prepared.objectError}`);
  if (prepared?.multiError) throw new Error(`多人估计器初始化失败：${prepared.multiError}`);

  // 等估计器、profile 与**所有感知模型**就绪再开始。物体检测器是懒加载的：
  // 不等它，前几帧有没有 PPE/objects 取决于 12MB ONNX 什么时候加载完——同样的输入
  // 两次回放会在头几帧上不同（实测 ppe 一个有一个没有）。
  for (let i = 0; i < 1200; i++) {
    const st = await cdp.eval(`(() => {
      const v = document.querySelector('video');
      const s = __pose.state;
      return {
        ready: s.estimatorReady,
        profile: s.profileLoaded,
        objects: s.objectOn ? s.objectReady : true,
        multi: s.multiOn ? s.multiReady : true,
        objectError: s.objectError || null,
        multiError: s.multiError || null,
        hasVideo: !!v && v.videoWidth > 0,
        duration: v && Number.isFinite(v.duration) ? v.duration : null,
        w: v ? v.videoWidth : 0, h: v ? v.videoHeight : 0,
      };
    })()`);
    if (st.objectError) throw new Error(`物体检测器初始化失败：${st.objectError}`);
    if (st.multiError) throw new Error(`多人估计器初始化失败：${st.multiError}`);
    if (st.ready && st.profile && st.objects && st.multi && st.hasVideo && st.duration > 0) {
      meta = { ...st };
      break;
    }
    await sleep(250);
  }
  if (!meta) throw new Error('等待估计器/视频元数据超时');

  // 暂停：det 模式没有 rAF 循环，这里暂停只是防止 play() 自动推进媒体时间
  await cdp.eval('(() => { const v = document.querySelector("video"); v.pause(); return v.paused; })()');

  // 取样点是 (k+0.5)/fps，所以最后一个 k 必须让 t 仍落在时长内
  const total = Math.min(maxFrames, Math.floor(meta.duration * fps));
  console.log(`▶ 时长 ${meta.duration.toFixed(2)}s · ${meta.w}×${meta.h} · 计划 ${total} 帧`);

  const t0 = Date.now();
  let advanced = 0;
  let skipped = 0;
  for (let k = 0; k < total; k++) {
    // 取样点放在网格**中间**（(k+0.5)/fps）而不是 k/fps：正好落在源视频帧边界上时，
    // 解码器可能按浮点误差选前后两帧（实测 5.4s 两次回放拿到了不同帧，关键点差 3px）。
    const t = Math.round(((k + 0.5) / fps) * 1000) / 1000;
    // seek → 等 seeked → 再等两帧 rAF：seeked 只保证位置更新，硬件解码交给合成器是异步的
    const seek = await cdp.eval(`(async () => {
      const v = document.querySelector('video');
      if (!v) return { ok: false, reason: 'no video' };
      if (Math.abs(v.currentTime - ${t}) > 1e-4) {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => { if (done) return; done = true; v.removeEventListener('seeked', onSeeked); resolve(); };
          const onSeeked = () => { requestAnimationFrame(() => requestAnimationFrame(finish)); };
          v.addEventListener('seeked', onSeeked);
          v.currentTime = ${t};
          setTimeout(finish, 10000);
        });
      }
      return { ok: true, t: v.currentTime, ready: v.readyState };
    })()`);
    if (!seek?.ok) throw new Error(`seek 到 ${t}s 失败：${seek?.reason || 'unknown'}`);
    const step = await cdp.eval('__pose.step()');
    if (step.added > 0) advanced++;
    else skipped++;
    if ((k + 1) % 50 === 0 || k === total - 1) {
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ${k + 1}/${total} · 记录 ${advanced} · 跳过 ${skipped} · ${el}s · t=${step.video_time?.toFixed(2)}s 人 ${step.persons} 框 ${step.objects}`);
    }
  }

  if (skipped) {
    // 取样点是严格递增的媒体时间，正常情况下不该有帧被跳过；有就说明 seek 没生效，
    // 这份导出缺帧，不能当基线用。
    console.error(`✗ ${skipped} 帧没有推进（seek 后 currentTime 未变化？），导出缺帧`);
    process.exitCode = 1;
  }

  // 导出：与 record-clip.mjs 同一条路径（点导出按钮 → 下载 JSONL）
  const frames = await cdp.eval('__pose.state.frames');
  if (!frames) throw new Error('没有记录到任何帧');
  await cdp.eval(`document.getElementById('btnExport').click()`);
  let downloaded = null;
  for (let i = 0; i < 60; i++) {
    const files = (await readdir(dlDir)).filter((f) => f.endsWith('.jsonl'));
    if (files.length) { downloaded = path.join(dlDir, files[0]); break; }
    await sleep(500);
  }
  if (!downloaded) throw new Error('没有拿到导出 JSONL');
  const jsonl = await readFile(downloaded);
  const outPath = path.join(outDir, `${outName}.jsonl`);
  await writeFile(outPath, jsonl);

  const text = jsonl.toString('utf8');
  const lines = text.trim().split('\n');
  // 首行是 meta，里面有 exported_at（导出时刻），天然每次不同；逐帧内容才是要比较的对象。
  const payload = lines.slice(1).join('\n');
  const hash = createHash('sha256').update(payload).digest('hex');
  const fullHash = createHash('sha256').update(jsonl).digest('hex');

  // 设备框连续性（无真值也能算）：检出帧比例、确认/使用帧比例、闪烁次数。
  // 用途：换检测器/改 inputSize/intervalMs 时，先看「框稳不稳」，不用等人工标框。
  const parsedFrames = lines.slice(1).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  const eqStats = equipmentStats(parsedFrames);
  const summary = {
    script: 'deterministic-replay',
    createdAt: new Date().toISOString(),
    src, profile, base, model, delegate, fps,
    durationSec: meta.duration,
    video: { width: meta.w, height: meta.h },
    steps: total,
    recorded: lines.length - 1,   // 第一行是 meta
    skipped,
    // sha256 只算逐帧内容（不含首行 meta）；首行带 exported_at，每次导出必然不同
    sha256: hash,
    sha256_full: fullHash,
    jsonl: outPath,
    equipment: eqStats,
  };
  await writeFile(path.join(outDir, `${outName}.meta.json`), JSON.stringify(summary, null, 2));

  console.log(`\n✓ 导出 ${outPath} · ${lines.length - 1} 帧`);
  console.log(`  sha256 ${hash}  （逐帧内容；不含首行 meta 的 exported_at）`);
  if (eqStats) {
    console.log(`  设备框：有人 ${eqStats.personFrames} 帧 · 检出 ${eqStats.rawFrames}（${eqStats.rawRate ?? '—'}）`
      + ` · 确认率 ${eqStats.confirmRate ?? '—'}（检出帧里确认态有效的比例）`
      + ` · 确认态 ${eqStats.confirmedFrames} 帧（含 maxAgeMs 内沿用，可高于检出）`
      + ` · 参与判定 ${eqStats.usedFrames} · 闪烁 ${eqStats.flicker} 次`
      + ` · 有框检测轮次 ${eqStats.boxObservations}`);
  }
  if (errors.length) console.log(`  页面错误 ${errors.length} 条（前 3）：${errors.slice(0, 3).join(' | ')}`);

  if (expectHash && expectHash !== hash) {
    console.error(`\n✗ sha256 不一致：期望 ${expectHash}，实际 ${hash}`);
    process.exitCode = 1;
  }
} finally {
  await close();
  await rm(dlDir, { recursive: true, force: true }).catch(() => {});
}

process.exit(process.exitCode || 0);
