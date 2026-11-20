// refuel-sampling-suite.mjs — 「加油 / 油样采样」一轮观察测试集：
// 用仓库里已有的机场加油素材，在无头 Chrome 里逐段跑 Demo，记录逐次判定并截图。
//
// 用法（先 npm run serve，另开终端）：
//   node scripts/refuel-sampling-suite.mjs [outDir] [--base URL] [--only id1,id2]
//     outDir 默认 runs/refuel-sampling-suite-YYYY-MM-DD
//     --only 只跑指定用例（逗号分隔的 id 前缀也可以）
//     --report-only 不重跑素材，只按现有 report.json 重写 report.md
//
// 输出：
//   <out>/testset.json         本轮测试集（素材、窗口、profile、预期）
//   <out>/report.md            人读报告（汇总表 + 逐用例时间线 + 截图）
//   <out>/report.json          逐用例的完整采样与截图索引
//   <out>/shots/<case>/*.png   整页截图（画面 + 骨架 + 手 + 设备框 + 动作面板）
//
// 素材全部来自 eval-data/（不进 git；版权归原 UP 主，仅限内部评测/研究）。
// 窗口按 eval-data/airport-refuel/INDEX.md 标注的取样时刻选取。
// 注意：这些片段是「看效果」的观察轮，不是指标考核——素材里没有逐帧标注，
// 结论只说明「这一段目前能输出什么」，不能当 recall/precision。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, sleep } from '../web/test/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let base = 'http://127.0.0.1:8765';
let outArg = null;
let only = null;
let reportOnly = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--base') base = process.argv[++i];
  else if (a === '--out') outArg = process.argv[++i];
  else if (a === '--only') only = process.argv[++i].split(',').map((x) => x.trim()).filter(Boolean);
  else if (a === '--report-only') reportOnly = true;
  else if (!a.startsWith('--')) outArg = a;
  else throw new Error(`未知参数 ${a}`);
}
base = base.replace(/\/+$/, '');
const stamp = new Date().toISOString().slice(0, 10);
const outDir = path.resolve(outArg || path.join(HERE, '..', 'runs', `refuel-sampling-suite-${stamp}`));
const shotsRoot = path.join(outDir, 'shots');

const SETTINGS = {
  model: 'full', delegate: 'GPU', fps: '30',
  skeleton: true, hands: true, points: true, mirror: false, loop: false,
  multi: false, profile: { id: 'default', url: null },
};

const AIRPORT_PROFILE = '/eval-data/equipment/airport/airport-profile.json';
const REFUEL_EQUIP_PROFILE = '/web/profiles/refuel-equipment.json';

// checks 只放「素材/文档能支撑」的硬条件；其余一律作为观察项写进报告。
// personMin：至少多少次采样里有人；equipmentMin：至少多少次采样有设备框；
// flag：至少出现一次的动作 flag；equipmentLabel：至少出现一次的设备类别。
const CASES = [
  {
    id: '01-oil-sample-demo',
    title: '加油作业演示片（整段）',
    src: '/eval-data/refuel/oil-sample-demo.mp4',
    profile: REFUEL_EQUIP_PROFILE,
    start: 0, end: 58,
    expected: '演示片已标注 6 个 operating 正例段；refuel-equipment 档在文档记录里能命中 5 段（TP5/FN1/FP3）。',
    checks: { personMin: 5, equipmentMin: 5, flag: 'operating' },
  },
  {
    id: '02-b787-jar',
    title: 'B787 地勤举玻璃取样罐对光检查（04:55–05:20）',
    src: '/eval-data/airport-refuel/b787_jar.mp4',
    profile: AIRPORT_PROFILE,
    start: 295, end: 320,
    expected: '真实取样动作，人举罐到眼前；INDEX 提示 oil_sample 判据在这里本来就难成立（手被罐挡住/离脸远），本轮看姿态、手部与设备框能给出什么。',
    checks: { personMin: 3 },
  },
  {
    id: '03-b787-panel',
    title: 'B787 操作面板（05:48–06:03，设备模型文档的留出段）',
    src: '/eval-data/airport-refuel/b787_jar.mp4',
    profile: AIRPORT_PROFILE,
    start: 348, end: 363,
    expected: 'docs/equipment-detector.md §10.5 的冒烟段：panel 框应稳定出现，operating 有过命中。',
    checks: { personMin: 3, equipmentMin: 5, equipmentLabel: 'panel' },
  },
  {
    id: '04-a320-sampling-box',
    title: 'A320 打开 SAMPLING BOX 取瓶（03:10–03:45）',
    src: '/eval-data/airport-refuel/a320_box.mp4',
    profile: AIRPORT_PROFILE,
    start: 190, end: 225,
    expected: '机坪近景，人只出现在约 40% 的帧；看设备框与「在设备旁」在换机位素材上的表现。',
    checks: { personMin: 3 },
  },
  {
    id: '05-mil-bottle',
    title: '军航士兵举透明样瓶对光（01:55–02:25）',
    src: '/eval-data/airport-refuel/mil_bottle.mp4',
    profile: AIRPORT_PROFILE,
    start: 115, end: 145,
    expected: 'INDEX 提醒剪辑较碎、正例只有约 3 秒；看姿态/手部在军航场景的可用性，设备模型大概率不命中。',
    checks: { personMin: 3 },
  },
  {
    id: '06-transformer-drain',
    title: '变压器蹲姿取样（01:00–01:40，含针管取样/阀门操作）',
    src: '/eval-data/airport-refuel/transformer_sample.mp4',
    profile: AIRPORT_PROFILE,
    start: 60, end: 100,
    expected: '放油阀贴近地面，工人只能深蹲/跪姿作业（这一段字幕也出现「取针管油样」）。看 drain_sample 要的「半蹲 60–120° + 双手靠拢」在真实深蹲机位上是否成立。',
    checks: { personMin: 5 },
  },
  {
    id: '07-hydraulic-valve',
    title: '空客液压油取样培训：冲洗取样阀（01:18–01:48）',
    src: '/eval-data/airport-refuel/hydraulic_valve.mp4',
    profile: AIRPORT_PROFILE,
    start: 78, end: 108,
    expected: '只有手与阀门/设备，没有完整人物；作为「人体姿态不该乱判」的对照，设备框是主要观察项。',
    checks: {},
  },
  {
    id: '08-jet-microbial',
    title: 'HY-LiTE 微生物采样检测（0:00–0:30）',
    src: '/eval-data/airport-refuel/jet_microbial.mp4',
    profile: AIRPORT_PROFILE,
    start: 0, end: 30,
    expected: '实验室手部流程，人物基本不在画面里；作为手部/设备特写的阴性对照。',
    checks: {},
  },
];

const FLAG_LABELS = {
  operating: '操作设备', oilSample: '油样取样', drainSample: '放油取样',
  reaching: '伸手', carrying: '持物', pointing: '指向', armRaised: '举手',
  nearEquipment: '在设备旁', armsOpen: '张开双臂', bothHandsUp: '双手高举',
  handAtHead: '手在头部',
};

const STATE_EXPR = `(() => {
  const st = window.__pose.state;
  const f = window.__pose.lastFrame;
  const v = document.querySelector('video');
  const flags = (f && f.actions && f.actions.flags) || {};
  const on = Object.keys(flags).filter((k) => flags[k]);
  const objs = (f && f.objects) || [];
  const tags = {};
  for (const o of objs) tags[o.label || '?'] = (tags[o.label || '?'] || 0) + 1;
  const hands = (f && f.hands) || [];
  const persons = (f && f.persons) || [];
  const sig = (f && f.signals) || {};
  // 与页面 personDisplayable 同口径（drawMinTorsoDrop=0）：髋不低于肩才画骨架。
  const drawable = persons.filter((p) => {
    const kp = p.kp || [];
    if (kp.length < 9) return true;
    const sh = [(kp[1][0] + kp[2][0]) / 2, (kp[1][1] + kp[2][1]) / 2];
    const hm = [(kp[7][0] + kp[8][0]) / 2, (kp[7][1] + kp[8][1]) / 2];
    const torso = Math.hypot(sh[0] - hm[0], sh[1] - hm[1]);
    return !(torso > 1e-6) || (hm[1] - sh[1]) / torso >= 0;
  }).length;
  return {
    t: v && Number.isFinite(v.currentTime) ? Math.round(v.currentTime * 1000) / 1000 : null,
    dur: v && Number.isFinite(v.duration) ? Math.round(v.duration * 1000) / 1000 : null,
    paused: v ? v.paused : null,
    ended: v ? v.ended : null,
    readyState: v ? v.readyState : null,
    frames: st.frames, fps: st.fps,
    estimatorReady: !!st.estimatorReady, profileLoaded: !!st.profileLoaded,
    objectOn: !!st.objectOn, objectReady: !!st.objectReady, objectError: st.objectError || null,
    posture: f && f.actions ? f.actions.posture : null,
    flags: on,
    persons: persons.length,
    drawable,
    hands: hands.map((h) => ({ side: h.handedness || null, shape: h.shape || null })),
    objects: objs.length,
    objectTags: tags,
    sig: {
      legs_visible: sig.legs_visible === undefined ? null : !!sig.legs_visible,
      upper_body: sig.upper_body === undefined ? null : !!sig.upper_body,
      knee: sig.knee === undefined ? null : sig.knee,
      head: sig.head || null,
      operating_gate: sig.operating_gate || null,
      operating_boxes_used: sig.operating_boxes_used ?? null,
      near_overlap: sig.near_equipment_overlap ?? null,
    },
    status: (document.getElementById('status') || {}).textContent || '',
  };
})()`;

const waitUntil = async (cdp, expr, { timeout = 60000, interval = 250 } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await cdp.eval(expr)) return true; } catch { /* 导航/加载中 */ }
    await sleep(interval);
  }
  return false;
};

const screenshot = async (cdp, file) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(r.data, 'base64'));
};

const safeTag = (s) => s.replace(/[^\w一-龥.-]+/g, '_').slice(0, 60);

async function navigate(cdp, url) {
  cdp.events.length = 0;
  const nav = await cdp.send('Page.navigate', { url });
  if (nav?.errorText) throw new Error(`导航失败 ${url}：${nav.errorText}`);
  if (!(await cdp.waitFor('Page.loadEventFired', 30000))) throw new Error(`加载超时 ${url}`);
  const hasApp = await cdp.eval('typeof window.__pose !== "undefined"').catch(() => false);
  if (!hasApp) throw new Error(`页面没有 __pose（${url}）：确认服务根目录是仓库根`);
}

async function seekAndReset(cdp, start) {
  const r = await cdp.eval(`new Promise((resolve) => {
    const v = document.querySelector('video');
    if (!v) return resolve({ ok: false, reason: 'no video' });
    v.pause();
    let done = false;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      v.removeEventListener('seeked', onSeeked);
      resolve({ ok: !timedOut && Math.abs(v.currentTime - ${start}) <= 0.6, t: v.currentTime, reason: timedOut ? 'timeout' : 'seeked' });
    };
    const onSeeked = () => requestAnimationFrame(() => requestAnimationFrame(() => finish(false)));
    v.addEventListener('seeked', onSeeked);
    v.currentTime = ${start};
    setTimeout(() => finish(true), 15000);
  })`);
  if (!r?.ok) throw new Error(`seek 到 ${start}s 失败（currentTime=${r?.t ?? '?'}，${r?.reason || 'unknown'}）`);
  // clearLog = resetRuntime：清帧记录、回绕标记与 Hold/tracker 残留
  const cleared = await cdp.eval(`(() => {
    const b = document.getElementById('btnClearLog');
    if (b && !b.disabled) b.click();
    return { frames: __pose.state.frames };
  })()`);
  if (cleared && cleared.frames > 0) throw new Error(`清空起始点前的记录失败（仍有 ${cleared.frames} 帧）`);
}

function segments(samples, keyFn, tOf, { minGap = 1.2 } = {}) {
  const out = [];
  let cur = null;
  for (const s of samples) {
    const keys = keyFn(s);
    const t = tOf(s);
    if (t == null) continue;
    for (const k of keys) {
      let seg = cur && cur[k];
      if (!seg) {
        seg = { key: k, start: t, end: t, n: 0 };
        out.push(seg);
        if (!cur) cur = {};
        cur[k] = seg;
      }
      if (t - seg.end > minGap) {
        // 断开太久：新起一段
        seg = { key: k, start: t, end: t, n: 0 };
        out.push(seg);
        cur[k] = seg;
      }
      seg.end = t;
      seg.n += 1;
    }
    // 本轮没出现的 key 关掉
    if (cur) for (const k of Object.keys(cur)) {
      if (!keys.includes(k)) delete cur[k];
    }
  }
  return out;
}

function summarizeCase(c, samples, shots, meta) {
  const withT = samples.filter((s) => s.t != null);
  const fps = samples.length ? samples[samples.length - 1].fps : null;
  const frames = samples.length ? Math.max(...samples.map((s) => s.frames || 0)) : 0;
  const personSamples = withT.filter((s) => s.persons > 0).length;
  const drawableSamples = withT.filter((s) => s.drawable > 0).length;
  const equipmentSamples = withT.filter((s) => s.objects > 0).length;
  const labelCounts = {};
  for (const s of withT) for (const [k, v] of Object.entries(s.objectTags || {})) {
    labelCounts[k] = (labelCounts[k] || 0) + v;
  }
  const flagSamples = {};
  for (const s of withT) for (const f of s.flags || []) flagSamples[f] = (flagSamples[f] || 0) + 1;
  const postureSamples = {};
  for (const s of withT) if (s.posture) postureSamples[s.posture] = (postureSamples[s.posture] || 0) + 1;
  const headSamples = withT.filter((s) => s.sig && s.sig.head && s.sig.head.visible).length;
  const headDirs = {};
  for (const s of withT) {
    const d = s.sig && s.sig.head && s.sig.head.visible ? s.sig.head.dir : null;
    if (d) headDirs[d] = (headDirs[d] || 0) + 1;
  }
  const handShapes = {};
  for (const s of withT) for (const h of s.hands || []) {
    handShapes[h.shape || '—'] = (handShapes[h.shape || '—'] || 0) + 1;
  }
  const flagSegs = segments(withT, (s) => (s.flags || []).filter((f) => f === 'operating' || f === 'nearEquipment' || f === 'oilSample' || f === 'drainSample'), (s) => s.t);
  const postureSegs = segments(withT, (s) => (s.posture ? [s.posture] : []), (s) => s.t);

  const checks = [];
  const add = (label, ok) => checks.push({ label, ok });
  add(`链路跑通（处理 ${frames} 帧）`, frames > 20);
  if (c.checks.personMin) add(`人物采样 ≥ ${c.checks.personMin}（实际 ${personSamples}）`, personSamples >= c.checks.personMin);
  if (c.checks.equipmentMin) add(`设备框采样 ≥ ${c.checks.equipmentMin}（实际 ${equipmentSamples}）`, equipmentSamples >= c.checks.equipmentMin);
  if (c.checks.flag) add(`出现「${FLAG_LABELS[c.checks.flag] || c.checks.flag}」`, (flagSamples[c.checks.flag] || 0) > 0);
  if (c.checks.equipmentLabel) add(`出现设备类别 ${c.checks.equipmentLabel}`, (labelCounts[c.checks.equipmentLabel] || 0) > 0);

  return {
    ...meta,
    samples: withT.length,
    frames, fps,
    personSamples,
    personRatio: withT.length ? personSamples / withT.length : 0,
    drawableSamples,
    equipmentSamples,
    labelCounts,
    flagSamples,
    postureSamples,
    headSamples,
    headDirs,
    handShapes,
    flagSegs,
    postureSegs,
    checks,
    pass: checks.every((x) => x.ok),
    errors: meta.errors || [],
    truncated: meta.truncated || false,
  };
}

async function runCase(cdp, c, pageErrors) {
  const t0 = Date.now();
  const caseDir = path.join(shotsRoot, c.id);
  await mkdir(caseDir, { recursive: true });
  await cdp.eval(`localStorage.setItem('pose-demo.settings.v1', ${JSON.stringify(JSON.stringify(SETTINGS))}); true`);

  const url = `${base}/web/?profile=${encodeURIComponent(c.profile)}&src=${encodeURIComponent(c.src)}`;
  const errMark = pageErrors.length;
  await navigate(cdp, url);

  const ready = await waitUntil(cdp, '__pose.state.estimatorReady && __pose.state.profileLoaded && __pose.state.frames > 2', { timeout: 90000 });
  if (!ready) {
    const diag = await cdp.eval(`(() => {
      const v = document.querySelector('video');
      return {
        hasPose: !!window.__pose,
        ready: __pose.state.estimatorReady, profileLoaded: __pose.state.profileLoaded,
        frames: __pose.state.frames,
        status: (document.getElementById('status') || {}).textContent,
        video: v ? { readyState: v.readyState, dur: v.duration, t: v.currentTime } : null,
      };
    })()`).catch((e) => ({ evalError: e.message }));
    throw new Error(`模型/profile 未就绪：${JSON.stringify(diag)}`);
  }
  // 物体检测懒加载：等它就绪再 seek，避免开头几秒没有设备框
  await waitUntil(cdp, '!__pose.state.objectOn || __pose.state.objectReady || __pose.state.objectError', { timeout: 90000 });

  await seekAndReset(cdp, c.start);
  await cdp.eval('(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); return 1; })()');

  const samples = [];
  const shots = [];
  let prev = null;
  let lastShotT = -999;
  let lastPeriodicT = -999;
  let lastProgressWall = Date.now();
  let lastT = -1;
  let truncated = false;
  const maxWallMs = Math.max(120000, (c.end - c.start) * 3500 + 90000);

  const takeShot = async (s, tag) => {
    const file = path.join(caseDir, `${String(shots.length + 1).padStart(2, '0')}_t${(s.t || 0).toFixed(2)}_${safeTag(tag)}.png`);
    await screenshot(cdp, file);
    shots.push({ t: s.t, tag, file: path.relative(outDir, file).replace(/\\/g, '/') });
    lastShotT = s.t || 0;
  };

  while (true) {
    const s = await cdp.eval(STATE_EXPR);
    s.wall = Math.round((Date.now() - t0) / 100) / 10;
    samples.push(s);

    if (s.t != null && s.t > lastT + 0.01) { lastT = s.t; lastProgressWall = Date.now(); }

    const flagKey = [...(s.flags || [])].sort().join(',');
    const objKey = Object.keys(s.objectTags || {}).sort().join(',');
    const prevFlagKey = prev ? [...(prev.flags || [])].sort().join(',') : null;
    const prevObjKey = prev ? Object.keys(prev.objectTags || {}).sort().join(',') : null;
    const tag = [];
    if (!prev) tag.push('start');
    if (prev && s.posture !== prev.posture) tag.push(`posture-${s.posture || 'none'}`);
    if (prev && flagKey !== prevFlagKey) {
      const added = (s.flags || []).filter((f) => !(prev.flags || []).includes(f));
      const removed = (prev.flags || []).filter((f) => !(s.flags || []).includes(f));
      if (added.length) tag.push(`on-${added.join('+')}`);
      if (removed.length) tag.push(`off-${removed.join('+')}`);
    }
    if (prev && objKey !== prevObjKey && objKey) tag.push(`objects-${objKey}`);
    if (prev && s.persons !== prev.persons) tag.push(`persons-${s.persons}`);

    if (tag.length && shots.length < 12) {
      await takeShot(s, tag.join('_'));
    } else if ((s.t || 0) - lastPeriodicT >= 6 && shots.length < 12) {
      await takeShot(s, 'sample');
      lastPeriodicT = s.t || 0;
    }

    prev = s;
    if (s.ended) break;
    if (s.t != null && s.t >= c.end - 0.2) break;
    if (Date.now() - lastProgressWall > 30000) {
      truncated = true;
      console.warn(`  ! 视频 ${30}s 没有推进（t=${s.t}）：提前收尾`);
      break;
    }
    if (Date.now() - t0 > maxWallMs) {
      truncated = true;
      console.warn(`  ! 超过墙钟上限 ${Math.round(maxWallMs / 1000)}s（t=${s.t}）：提前收尾`);
      break;
    }
    await sleep(350);
  }

  await cdp.eval('(() => { const v = document.querySelector("video"); if (v) v.pause(); return 1; })()');
  await sleep(400);
  const final = await cdp.eval(STATE_EXPR);
  if (final.t != null && (shots.length === 0 || (final.t || 0) - lastShotT > 1.5)) {
    await takeShot(final, 'final');
  }
  samples.push(final);

  const meta = {
    id: c.id, title: c.title, src: c.src, profile: c.profile,
    start: c.start, end: c.end, expected: c.expected,
    elapsedMs: Date.now() - t0,
    truncated,
    errors: pageErrors.slice(errMark),
  };
  const summary = summarizeCase(c, samples, shots, meta);
  await writeFile(path.join(caseDir, 'samples.json'), JSON.stringify({ summary, samples, shots }, null, 2));
  return { summary, samples, shots };
}

function fmtT(t) {
  if (t == null) return '—';
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function fmtRanges(segs) {
  if (!segs.length) return '—';
  return segs.map((g) => `${fmtT(g.start)}–${fmtT(g.end)}`).join('、');
}

function mdReport(results, meta) {
  const lines = [];
  lines.push('# 加油 / 油样采样 · 一轮观察测试集', '');
  lines.push(`- 时间：${meta.startedAt}`);
  lines.push(`- 服务：${meta.base}`);
  lines.push(`- 模型：MediaPipe Pose full / GPU，手部开，截图 1440×900 整页、未镜像`);
  lines.push(`- 素材：\`eval-data/\` 里的机场加油素材（版权归原 UP 主，仅限内部评测/研究）`);
  lines.push(`- 性质：**观察轮**。素材没有逐帧标注，下面的命中只说明「这一段目前能输出什么」，不是 recall / precision。`, '');

  lines.push('## 汇总', '');
  lines.push('| 用例 | 素材窗口 | 人物采样 | 可画骨架 | 设备框 | 关键动作（采样数） | 硬检查 | 截图 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    const s = r.summary;
    const key = ['operating', 'oilSample', 'drainSample', 'nearEquipment']
      .filter((f) => s.flagSamples[f]).map((f) => `${FLAG_LABELS[f]} ${s.flagSamples[f]}`).join('，') || '—';
    lines.push(`| ${r.summary.id} | ${fmtT(s.start)}–${fmtT(s.end)} | ${s.personSamples}/${s.samples}（${(s.personRatio * 100).toFixed(0)}%） | ${s.drawableSamples} | ${s.equipmentSamples} 次 ${s.labelCounts && Object.keys(s.labelCounts).length ? JSON.stringify(s.labelCounts) : ''} | ${key} | ${s.pass ? '✅ PASS' : '❌ FAIL'} | ${r.shots.length} 张 |`);
  }
  lines.push('');

  for (const r of results) {
    const s = r.summary;
    lines.push(`## ${s.id} — ${s.title}`, '');
    lines.push(`- 素材：\`${s.src}\`，窗口 ${fmtT(s.start)}–${fmtT(s.end)}（${(s.end - s.start).toFixed(0)}s）`);
    lines.push(`- profile：\`${s.profile}\``);
    lines.push(`- 预期：${s.expected}`);
    lines.push(`- 观察：处理 ${s.frames} 帧（${s.fps ?? '?'} fps），采样 ${s.samples} 次；人物 ${s.personSamples} 次（${(s.personRatio * 100).toFixed(0)}%），其中可画骨架 ${s.drawableSamples} 次；设备框 ${s.equipmentSamples} 次${Object.keys(s.labelCounts || {}).length ? `（${Object.entries(s.labelCounts).map(([k, v]) => `${k} ${v}`).join('、')}）` : ''}`);
    const post = Object.entries(s.postureSamples || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，') || '—';
    lines.push(`- 姿态采样：${post}`);
    const hd = Object.entries(s.headDirs || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，') || '—';
    lines.push(`- 头部朝向：可见 ${s.headSamples ?? 0} 次${hd !== '—' ? `（${hd}）` : ''}`);
    // 只展示动作目录里的 flag；operatingL/R、drainSampleL/R 这类逐侧字段留在 report.json 里
    const acts = Object.entries(s.flagSamples || {})
      .filter(([k]) => FLAG_LABELS[k])
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${FLAG_LABELS[k]} ${v}`).join('，') || '—';
    lines.push(`- 动作命中：${acts}`);
    if (s.flagSegs.length) {
      lines.push(`- 动作区间：${s.flagSegs.map((g) => `${FLAG_LABELS[g.key] || g.key} ${fmtT(g.start)}–${fmtT(g.end)}`).join('；')}`);
    }
    if (s.postureSegs.length) {
      lines.push(`- 姿态区间：${s.postureSegs.map((g) => `${g.key} ${fmtT(g.start)}–${fmtT(g.end)}`).join('；')}`);
    }
    const hs = Object.entries(s.handShapes || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，');
    if (hs) lines.push(`- 手势采样：${hs}`);
    lines.push(`- 用时：${(s.elapsedMs / 1000).toFixed(1)}s${s.truncated ? '（**未播完，提前收尾**）' : ''}`);
    lines.push(`- 硬检查：${s.checks.map((x) => `${x.ok ? '✅' : '❌'} ${x.label}`).join('；')}`);
    if (s.errors?.length) lines.push(`- JS 错误：${s.errors.slice(0, 5).join(' / ')}`);
    lines.push('');
    for (const shot of r.shots) {
      lines.push(`### ${shot.tag} @ ${fmtT(shot.t)}`, '');
      lines.push(`![](${shot.file})`, '');
    }
  }

  lines.push('## 怎么读这一轮', '');
  lines.push('- **人物采样**是「这一帧里 MediaPipe 检出了人」的比例；设备框是自训 ONNX（panel/valve/gauge）的原始输出，不是人工 ROI。');
  lines.push('- 机场 profile（`eval-data/equipment/airport/airport-profile.json`）的 ROI 是按 b787 分镜画的（画面左上 0–75%×0–55%），换到 a320/变压器/军航机位后 ROI 不再对应，`operating`/`在设备旁` 只能当作对照看。');
  lines.push('- `oil_sample`（举瓶到眼前）和 `drain_sample`（蹲姿双手在阀口）都是「持续动作」，需要连续帧；特写/遮挡多时会漏，属预期。');
  lines.push('- 模型 `airport-equipment.onnx` 是在同一批素材的分镜框上训练的（同集冒烟），**不是泛化准确率**；截图只用于内部看效果，不要外发。');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  await mkdir(outDir, { recursive: true });
  // --report-only：不改截图/采样，只按当前模板重写 report.md（调报告文案时用）
  if (reportOnly) {
    const { meta, results } = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8'));
    await writeFile(path.join(outDir, 'report.md'), mdReport(results, meta));
    console.log(`已重写 ${path.join(outDir, 'report.md')}`);
    return;
  }
  const startedAt = new Date().toISOString();
  const cases = only
    ? CASES.filter((c) => only.some((o) => c.id === o || c.id.startsWith(o)))
    : CASES;
  if (!cases.length) throw new Error(`--only 没有匹配到用例：${only.join(',')}`);
  await writeFile(path.join(outDir, 'testset.json'), JSON.stringify({
    startedAt, base,
    profileNotes: {
      [AIRPORT_PROFILE]: '机场设备冒烟档：airport-equipment.onnx + b787 分镜 ROI（equipmentFallbackRoi=false）',
      [REFUEL_EQUIP_PROFILE]: 'refuel 演示片档：equipment.onnx + 演示片 ROI',
    },
    cases,
  }, null, 2));

  const { cdp, errors, close } = await openPage(`${base}/web/`, { width: 1440, height: 900 });
  const results = [];
  try {
    for (const c of cases) {
      process.stdout.write(`▶ ${c.id} ${c.title} … `);
      try {
        const r = await runCase(cdp, c, errors);
        results.push(r);
        const s = r.summary;
        console.log(`${s.pass ? 'PASS' : 'FAIL'} · 人物 ${s.personSamples}/${s.samples} · 设备框 ${s.equipmentSamples} · ${(s.elapsedMs / 1000).toFixed(1)}s · ${r.shots.length} 张`);
      } catch (e) {
        console.log(`ERROR ${e.message}`);
        results.push({
          summary: {
            id: c.id, title: c.title, src: c.src, profile: c.profile, start: c.start, end: c.end,
            expected: c.expected, samples: 0, frames: 0, personSamples: 0, personRatio: 0,
            drawableSamples: 0,
            equipmentSamples: 0, labelCounts: {}, flagSamples: {}, postureSamples: {},
            headSamples: 0, headDirs: {}, handShapes: {},
            flagSegs: [], postureSegs: [], checks: [{ label: `运行失败：${e.message}`, ok: false }],
            pass: false, errors: [e.message], elapsedMs: 0, truncated: false,
          },
          samples: [], shots: [],
        });
      }
    }
  } finally {
    await close();
  }

  const meta = { startedAt, base, outDir };
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ meta, results }, null, 2));
  await writeFile(path.join(outDir, 'report.md'), mdReport(results, meta));
  const failed = results.filter((r) => !r.summary.pass);
  console.log(`\n截图与报告：${outDir}`);
  console.log(`硬检查通过 ${results.length - failed.length}/${results.length}`);
  // 任一用例 FAIL/ERROR 都不能算成功：CI 里必须能靠退出码发现回归。
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
