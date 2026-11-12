// pose-screenshots.mjs — 用仓库里现有素材跑一遍姿态识别，把界面截图 + 逐项判定结果
// 存到一个新文件夹（默认 runs/pose-test-<日期>/）。runs/ 已被 .gitignore 忽略：
// 截图里有真人影像，按 docs/annotation-kit.md 的约定不进 git。
//
// 用法：
//   npm run serve                                  # 另开一个终端
//   node scripts/pose-screenshots.mjs [baseUrl] [outDir]
//     baseUrl 默认 http://127.0.0.1:8765
//     outDir  默认 runs/pose-test-YYYY-MM-DD
//
// 素材（全部是仓库里已有的）：
//   data/pose-test.jpg          单人图片
//   data/pose-test-two.jpg      双人图片（多人模式）
//   data/pose-test-vp8.webm     单人视频
//   data/pose-test-two.webm     双人视频（多人模式）
//   eval-data/refuel/oil-sample-demo.mp4  加油作业演示片（refuel profile，判 operating）
//
// 输出：每个用例一张整页 PNG；report.json 存逐项判定；report.md 汇总给人看。

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, sleep } from '../web/test/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = (process.argv[2] || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const stamp = new Date().toISOString().slice(0, 10);
const outDir = path.resolve(process.argv[3] || path.join(HERE, '..', 'runs', `pose-test-${stamp}`));

const SETTINGS_KEY = 'pose-demo.settings.v1';
const BASE_SETTINGS = {
  model: 'full', delegate: 'GPU', fps: '30',
  skeleton: true, hands: true, points: true, mirror: false, loop: false,
  profile: { id: 'default', url: null },
};

const CASES = [
  {
    id: '01-image-single', title: '单人图片', kind: 'image',
    url: '/web/?src=/data/pose-test.jpg',
    settings: { multi: false },
    wait: '!!(__pose.state.lastResult && __pose.state.lastResult.act)',
    expect: (s) => (s.last?.persons || 0) >= 1 && !!s.last?.posture,
  },
  {
    id: '02-image-two-multi', title: '双人图片（多人模式）', kind: 'image',
    url: '/web/?src=/data/pose-test-two.jpg',
    settings: { multi: true, multiMax: '2' },
    wait: '!!(__pose.state.lastResult && (__pose.state.lastResult.verdicts || []).length >= 2)',
    expect: (s) => (s.last?.verdicts?.length || 0) >= 2,
    timeout: 60000,
  },
  {
    id: '03-video-single', title: '单人视频', kind: 'video',
    url: '/web/?src=/data/pose-test-vp8.webm',
    settings: { multi: false },
    wait: '__pose.state.estimatorReady && __pose.state.frames > 20',
    settleMs: 1500,
    expect: (s) => (s.frames || 0) > 20 && (s.last?.kp || 0) >= 13,
  },
  {
    id: '04-video-two-multi', title: '双人视频（多人模式）', kind: 'video',
    url: '/web/?src=/data/pose-test-two.webm',
    settings: { multi: true, multiMax: '2' },
    wait: '__pose.state.multiReady && __pose.state.frames > 15 && __pose.state.verdicts >= 1',
    settleMs: 2000,
    expect: (s) => (s.last?.verdicts?.length || 0) >= 1,
    timeout: 60000,
  },
  {
    id: '05-refuel-operating', title: '加油作业演示片（refuel profile）', kind: 'refuel',
    url: '/web/?profile=/web/profiles/refuel.json&src=/eval-data/refuel/oil-sample-demo.mp4',
    settings: { multi: false },
    wait: '__pose.state.estimatorReady && __pose.state.frames > 20',
    waitOperating: true,
    expect: (s) => s.armsOn?.includes('operating'),
    timeout: 90000,
  },
];

const waitUntil = async (cdp, expr, { timeout = 60000, interval = 250 } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await cdp.eval(expr)) return true;
    } catch { /* 页面导航/模型加载中，下一轮再试 */ }
    await sleep(interval);
  }
  return false;
};

const SNAPSHOT_EXPR = `(() => {
  const st = window.__pose.state;
  const ui = window.__pose.ui;
  const src = window.__pose.lastFrame || st.lastResult || null;
  const flagsOn = (f) => Object.entries(f || {}).filter(([, v]) => v).map(([k]) => k);
  // 视频帧的 hands 是数组；图片判定（lastVerdicts）的是 {L,R,list}，长度要分开算
  const handCount = (h) => (Array.isArray(h)
    ? h.length
    : (h && h.list ? h.list.length : (h ? [h.L, h.R].filter(Boolean).length : 0)));
  const verdicts = (src && src.verdicts ? src.verdicts : []).map((v) => ({
    track_id: v.track_id,
    posture: v.act ? (v.act.postureId || null) : (v.posture || null),
    flags: flagsOn(v.act ? v.act.flags : v.flags),
    hands: handCount(v.hands),
  }));
  const sig = (src && src.signals) || (src && src.act ? src.sig : null);
  // angle_source：视频帧是字符串（"3d"/"2d"/"blocked"），图片判定是逐关节的对象
  const angleSrc = sig && sig.angle_source
    ? (typeof sig.angle_source === 'string'
      ? sig.angle_source
      : Object.entries(sig.angle_source).map(([k, x]) => k + ':' + x).join(' '))
    : null;
  return {
    mode: st.mode,
    estimatorReady: !!st.estimatorReady,
    handReady: !!st.handReady,
    frames: st.frames,
    fps: st.fps,
    profileLoaded: !!st.profileLoaded,
    multiOn: !!st.multiOn,
    multiReady: !!st.multiReady,
    tracks: st.tracks,
    verdicts: st.verdicts,
    status: (document.getElementById('status') || {}).textContent || '',
    postureUi: ui.posture,
    postureMeta: ui.meta,
    handMeta: ui.handMeta,
    handL: ui.handL,
    handR: ui.handR,
    armHint: ui.armHint,
    repMeta: ui.repMeta,
    logInfo: ui.logInfo,
    postureChipsOn: ui.postureChips.filter((c) => c.on).map((c) => c.id),
    armsOn: ui.armActions.filter((a) => a.on).map((a) => a.id),
    armsNa: ui.armActions.filter((a) => a.na).map((a) => a.id),
    last: src ? {
      time: src.video_time == null ? null : src.video_time,
      posture: (src.actions && src.actions.posture) || (src.act && src.act.postureId) || null,
      persons: (src.persons || []).length,
      kp: src.persons && src.persons[0] && src.persons[0].kp ? src.persons[0].kp.length : 0,
      hands: (src.hands || []).length,
      flags: flagsOn(src.actions ? src.actions.flags : (src.act && src.act.flags)),
      verdicts,
      signals: sig ? {
        has_world: !!sig.has_world,
        angle_source: angleSrc,
        bones_ok: sig.bones_ok === undefined ? null : !!sig.bones_ok,
        legs_visible: sig.legs_visible === undefined ? null : !!sig.legs_visible,
        upper_body: sig.upper_body === undefined ? null : !!sig.upper_body,
        knee: sig.knee === undefined ? null : sig.knee,
        uprightness: sig.uprightness === undefined ? null : sig.uprightness,
        unreliable: (src.actions && src.actions.unreliable) || (src.act && src.act.unreliable) || [],
      } : null,
    } : null,
  };
})()`;

async function setSettings(cdp, extra) {
  const merged = { ...BASE_SETTINGS, ...extra };
  const json = JSON.stringify(merged);
  await cdp.eval(`localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, ${JSON.stringify(json)}); true`);
}

async function navigate(cdp, url) {
  cdp.events.length = 0;
  await cdp.send('Page.navigate', { url: base + url });
  await cdp.waitFor('Page.loadEventFired', 30000);
}

async function pauseVideo(cdp) {
  try {
    await cdp.eval('(() => { const v = document.querySelector("video"); if (v) v.pause(); return 1; })()');
  } catch { /* 图片模式没有 video，忽略 */ }
}

async function screenshot(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(r.data, 'base64'));
}

async function playVideo(cdp) {
  try {
    await cdp.eval('(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); return 1; })()');
  } catch { /* ignore */ }
}

async function runCase(cdp, c, errMark) {
  const t0 = Date.now();
  await setSettings(cdp, c.settings || {});
  await navigate(cdp, c.url);

  // 等模型加载 + 该用例的判定条件
  const ready = await waitUntil(cdp, c.wait, { timeout: c.timeout || 60000 });

  if (c.kind === 'video') {
    await playVideo(cdp);
    await sleep(c.settleMs || 1500);
    await pauseVideo(cdp);
    await sleep(400);
  } else if (c.kind === 'refuel') {
    await playVideo(cdp);
    // 播到第一个 operating 正例（6.2s 起，保持 1500ms）；没出现就等满超时后照现状截图
    await waitUntil(cdp, '(() => { const a = __pose.ui.armActions.find((x) => x.id === "operating"); return !!a && a.on; })()',
      { timeout: c.timeout || 90000 });
    await pauseVideo(cdp);
    await sleep(400);
  } else {
    await sleep(600);   // 图片：analyzeStill 内部已经把同一帧喂过 12 次
  }

  const snap = await cdp.eval(SNAPSHOT_EXPR);
  const file = `${c.id}.png`;
  await screenshot(cdp, path.join(outDir, file));
  const pass = !!(c.expect && c.expect(snap));
  return {
    id: c.id,
    title: c.title,
    source: c.url,
    screenshot: file,
    elapsedMs: Date.now() - t0,
    waitedFor: c.wait,
    ready,
    pass,
    state: snap,
    errors: cdpErrors(cdp).slice(errMark),
  };
}

function cdpErrors(cdp) {
  return cdp.pageErrors || [];
}

function mdReport(results, meta) {
  const lines = [];
  lines.push(`# 姿态识别测试结果`, '');
  lines.push(`- 时间：${meta.startedAt}`);
  lines.push(`- 服务：${meta.base}`);
  lines.push(`- 模型：full / GPU（默认），截图 1440×900 整页`);
  lines.push(`- 通过：${results.filter((r) => r.pass).length} / ${results.length}`, '');
  lines.push('| 用例 | 素材 | 结果 | 关键判定 |', '| --- | --- | --- | --- |');
  for (const r of results) {
    const s = r.state;
    const arms = (s.armsOn || []).join(', ') || '—';
    const key = [
      `姿态 ${s.postureUi || '—'}`,
      `手臂 ${arms}`,
      s.multiOn ? `track ${s.tracks} / verdicts ${(s.last?.verdicts || []).length}` : '',
      s.last?.time != null ? `t=${s.last.time.toFixed(2)}s` : '',
      `帧 ${s.frames}`,
    ].filter(Boolean).join(' · ');
    lines.push(`| ${r.id} | ${r.source} | ${r.pass ? '✅ PASS' : '❌ FAIL'} | ${key} |`);
  }
  lines.push('');
  for (const r of results) {
    const s = r.state;
    lines.push(`## ${r.id} — ${r.title}`, '');
    // runCase 抛异常时 screenshot 是 null，直接插进 ![]() 会生成指向 null 的坏图
    lines.push(r.screenshot ? `![](${r.screenshot})` : '（本用例无截图）', '');
    lines.push(`- 截图：${r.screenshot || '—'}`);
    lines.push(`- 素材：${r.source}`);
    lines.push(`- 用时：${(r.elapsedMs / 1000).toFixed(1)}s`);
    lines.push(`- 结果：${r.pass ? 'PASS' : 'FAIL'}（等待条件 ${r.ready ? '已满足' : '超时'}）`);
    lines.push(`- 姿态：${s.postureUi || '—'} / 判定 id：${s.last?.posture || '—'}；meta：${s.postureMeta || '—'}`);
    lines.push(`- 手臂动作：${(s.armsOn || []).join(', ') || '—'}；不可判：${(s.armsNa || []).join(', ') || '—'}`);
    lines.push(`- 手势：左手 ${s.handL || '—'}；右手 ${s.handR || '—'}；提示：${s.armHint || '—'}`);
    const v = s.last?.verdicts || [];
    if (v.length) {
      lines.push(`- 逐人：${v.map((x) => `#${x.track_id} ${x.posture || '—'}${x.flags.length ? ` [${x.flags.join(',')}]` : ''}（手 ${x.hands}）`).join('；')}`);
    }
    if (s.last?.signals) {
      const g = s.last.signals;
      lines.push(`- 信号：角度源 ${g.angle_source || '—'}；3D ${g.has_world ? '有' : '无'}；骨骼 ${g.bones_ok == null ? '—' : (g.bones_ok ? '正常' : '异常')}；腿可见 ${g.legs_visible == null ? '—' : (g.legs_visible ? '是' : '否')}；上半身 ${g.upper_body == null ? '—' : (g.upper_body ? '是' : '否')}`);
      if (g.unreliable?.length) lines.push(`- 不可靠原因：${g.unreliable.join(', ')}`);
    }
    lines.push(`- 状态栏：${s.status || '—'}`);
    if (r.errors?.length) lines.push(`- JS 错误：\n\n\`\`\`\n${r.errors.join('\n')}\n\`\`\``);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const { cdp, errors, close } = await openPage(`${base}/web/`, { width: 1440, height: 900 });
  // openPage 已经把错误事件收集到 errors；把它挂到 cdp 上，便于按用例切分
  cdp.pageErrors = errors;
  const results = [];
  try {
    for (const c of CASES) {
      const errMark = errors.length;
      process.stdout.write(`▶ ${c.id} … `);
      try {
        const r = await runCase(cdp, c, errMark);
        results.push(r);
        console.log(`${r.pass ? 'PASS' : 'FAIL'} · 姿态 ${r.state.postureUi} · 手臂 ${(r.state.armsOn || []).join(',') || '—'} · ${(r.elapsedMs / 1000).toFixed(1)}s`);
      } catch (e) {
        results.push({
          id: c.id, title: c.title, source: c.url, screenshot: null,
          elapsedMs: 0, ready: false, pass: false, state: {}, errors: [e.message],
        });
        console.log(`ERROR ${e.message}`);
      }
    }
  } finally {
    await close();
  }

  const meta = { startedAt, base, outDir };
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ meta, results }, null, 2));
  await writeFile(path.join(outDir, 'report.md'), mdReport(results, meta));
  console.log(`\n截图与报告：${outDir}`);
  const failed = results.filter((r) => !r.pass);
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
