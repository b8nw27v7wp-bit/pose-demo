// playback-long.mjs — 长素材「导入后播一会儿就卡住」的回归检查。
//
// 背景：`useVideoFile` 用的是 blob URL。早先的实现在 loadstart 之后 5s 调
// URL.revokeObjectURL —— 小文件这时整段已经读进内存，看不出问题；大素材要边播边
// 按 range 补读，URL 一失效就 waiting → readyState 2 → MEDIA_ERR_NETWORK，
// 画面冻在那一帧、识别帧数不再增长（实测 43MB/232s 的 720p 素材卡在 18.6s）。
// 这个脚本就是盯这一条：文件入口导入后，帧数与视频时间必须一起往前走。
//
// 需要「大到必须边播边补读」的素材（小文件测不出来）。生成一次即可（约 43MB）：
//   ffmpeg -stream_loop 3 -i eval-data/refuel/oil-sample-demo.mp4 -vf scale=1280:720 \
//     -c:v libx264 -preset veryfast -b:v 1500k -an -movflags +faststart \
//     eval-data/.tmp-long-720p.mp4
//
// 用法（先 npm run serve）：
//   node web/test/playback-long.mjs                                # 用默认素材
//   node web/test/playback-long.mjs <视频绝对路径> [观察秒数]
//
// 判定：观察期内视频没暂停/播完时，帧数连续 STALL_SEC 秒不增长 → FAIL（退出码 1）；
// 视频时间推进到 STALL_AFTER_SEC 之后仍无停滞 → PASS。

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CLIP = path.join(ROOT, 'eval-data/.tmp-long-720p.mp4');
const STALL_SEC = 6;          // 连续这么久没有新帧就判卡住（推理间隔 ~35ms，正常不会出现）
const STALL_AFTER_SEC = 20;   // 视频时间越过这个点还没停，才算过了历史故障位（18.6s）

const argFile = process.argv[2];
const file = path.resolve(/^\d+$/.test(argFile || '') ? DEFAULT_CLIP : (argFile || DEFAULT_CLIP));
const totalSec = Number(/^\d+$/.test(argFile || '') ? argFile : (process.argv[3] || 45));

if (!existsSync(file)) {
  console.error(`找不到测试素材：${file}\n见本文件头注释里的 ffmpeg 生成命令。`);
  process.exit(2);
}

const probe = `(() => {
  const s = window.__pose ? window.__pose.state : null;
  const v = document.getElementById('video');
  return {
    t: Math.round(v.currentTime * 100) / 100,
    rs: v.readyState, paused: v.paused, ended: v.ended,
    err: v.error ? v.error.code : null,
    frames: s ? s.frames : -1,
    status: (document.getElementById('status') || {}).textContent || '',
  };
})()`;

const { cdp, errors, close } = await openPage('http://127.0.0.1:8765/web/');
let failed = null;
try {
  await sleep(1500);
  await cdp.send('DOM.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  console.log(`素材：${file}`);

  const t0 = Date.now();
  let prev = null;
  let stuckFor = 0;
  let maxT = 0;
  console.log('elapsed   videoT  frames  dFrames  rs  status');
  for (;;) {
    const s = await cdp.eval(probe);
    const el = (Date.now() - t0) / 1000;
    const d = prev ? s.frames - prev.frames : 0;
    maxT = Math.max(maxT, s.t || 0);
    console.log(`${el.toFixed(1).padStart(6)}s  ${String(s.t).padStart(7)}  f=${String(s.frames).padStart(5)}  +${String(d).padStart(4)}  rs=${s.rs}${s.paused ? ' PAUSED' : ''}${s.err ? ` ERR=${s.err}` : ''}  ${s.status}`);

    if (s.err) { failed = `视频报错 code ${s.err}（${s.status}）`; break; }
    if (d === 0 && !s.paused && !s.ended && s.t > 0.5) stuckFor += 1.5; else if (d > 0) stuckFor = 0;
    if (stuckFor >= STALL_SEC) { failed = `视频时间停在 ${s.t}s、帧数停在 ${s.frames}，连续 ${stuckFor}s 没有新帧`; break; }
    prev = s;
    if (el > totalSec || s.ended) break;
    await sleep(1500);
  }

  const fin = await cdp.eval(probe);
  if (!failed && maxT < STALL_AFTER_SEC) failed = `观察期内只播到 ${maxT}s，没越过 ${STALL_AFTER_SEC}s（素材太短或没播起来）`;
  if (!failed && errors.length) failed = `页面有 JS 错误：${errors[0]}`;
  console.log(`\n最终：t=${fin.t}s，${fin.frames} 帧，err=${fin.err ?? 'none'}`);
  console.log(failed ? `FAIL：${failed}` : `PASS：播到 ${fin.t}s / ${fin.frames} 帧，无停滞`);
} finally {
  await close();
}
process.exit(failed ? 1 : 0);
