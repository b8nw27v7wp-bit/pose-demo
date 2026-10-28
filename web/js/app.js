// app.js — 组装层：输入源 → 感知（姿态 + 手部）→ 信号 → 动作 → 可视化/导出
import { createEstimator, detectVideo, toPersons, closeEstimator } from './pose.js';
import { createHandEstimator, detectHandsVideo, toHands, classifyHand, handsReady, closeHandEstimator } from './hands.js';
import { SignalEngine } from './signals.js';
import { ActionEngine, ACTION_CATALOG, ARM_ACTIONS } from './actions.js';
import { drawSkeleton, drawHand, clearCanvas } from './draw.js';

const $ = (id) => document.getElementById(id);
const videoEl = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const placeholder = $('placeholder');
const spark = $('spark');

const MAX_LOG = 600;
const SPARK_SPAN_MS = 5000;

// 推理帧率上限：默认 15fps。摄像头 30fps + rAF 60Hz 会对同一帧反复推理，白烧 CPU/GPU。
const inferInterval = () => 1000 / (Number($('fpsCapSel').value) || 15);

const signalEngine = new SignalEngine({ minCutoff: 1.0, beta: 0.05 });
const actionEngine = new ActionEngine();

let estimatorReady = false;
let handReady = false;
let mode = 'idle';
let rafId = null;
let lastVideoTime = -1;
let lastInferTs = 0;
let lastUiTs = 0;
let lastResult = null;
let frameLog = [];
let sparkSamples = [];
let fps = 0;
let fpsFrames = 0;
let fpsWindowTs = 0;
let currentStream = null;
let autoLoaded = false;
let lastTs = 0;          // MediaPipe 要求时间戳严格递增
let handFails = 0;       // 手部推理连续失败计数

const show = { skeleton: true, hands: true, points: true, mirror: true };
const autoSrc = new URLSearchParams(location.search).get('src');

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

// —— 模型 ---------------------------------------------------------------

let initPromise = null;

/** 懒加载：只有真的要跑输入时才建模型（页面一打开就建 GPU 上下文，多开几个标签页很吃内存） */
async function ensureEstimator() {
  if (estimatorReady) return true;
  if (!initPromise) {
    initPromise = initEstimator().finally(() => { initPromise = null; });
  }
  await initPromise;
  return estimatorReady;
}

async function initEstimator() {
  const model = $('modelSel').value;
  const want = $('delegateSel').value;
  // 注：MediaPipe PoseLandmarker 在 VIDEO 模式下只返回 1 个人（实测 max_persons=1，
  // 即使 numPoses=2；IMAGE 模式能返回多人）。真多人需要先跑 person detector 再逐框推理。
  const numPoses = 1;
  setStatus('模型加载中…', 'busy');
  estimatorReady = false;

  const candidates = want === 'GPU' ? ['GPU', 'CPU'] : ['CPU'];
  let lastErr = null;
  for (const delegate of candidates) {
    try {
      await createEstimator({ model, delegate, runningMode: 'VIDEO', numPoses });
      estimatorReady = true;
      setStatus(`就绪 · ${model}/${delegate}`, 'ok');
      resetRuntime();
      await initHands(delegate);
      if (autoSrc && !autoLoaded) {
        autoLoaded = true;
        useVideoSource(autoSrc);
      }
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  setStatus(`模型加载失败：${lastErr?.message || 'unknown'}`, 'err');
  return false;
}

async function initHands(delegate) {
  handReady = false;
  if (!show.hands) return;
  for (const d of delegate === 'GPU' ? ['GPU', 'CPU'] : ['CPU']) {
    try {
      await createHandEstimator({ delegate: d, runningMode: 'VIDEO', numHands: 2 });
      handReady = true;
      return;
    } catch { /* 手部模型失败不影响主体识别 */ }
  }
}

function resetRuntime() {
  signalEngine.reset();
  actionEngine.reset();
  frameLog = [];
  sparkSamples = [];
  lastVideoTime = -1;
  lastInferTs = 0;
  renderReps({ squat: 0, pushup: 0, clap: 0 });
  updateUI();
}

// —— 输入源 -------------------------------------------------------------

async function startCamera() {
  stopStream();
  setStatus('摄像头启动中…', 'busy');
  if (!(await ensureEstimator())) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    currentStream = stream;
    videoEl.srcObject = stream;
    videoEl.loop = false;
    await videoEl.play();
    mode = 'camera';
    placeholder.hidden = true;
    setActiveInput('camera');
    resetRuntime();
    ensureLoop();
    setStatus('就绪 · 摄像头', 'ok');
  } catch (e) {
    placeholder.hidden = false;
    placeholder.querySelector('p').textContent = `摄像头不可用（${e.name}）`;
    setStatus('摄像头不可用', 'err');
    setActiveInput(null);
  }
}

function stopStream() {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
}

function waitForVideoReady(el, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (el.readyState >= 2) return resolve();
    const cleanup = () => {
      el.removeEventListener('loadeddata', ok);
      el.removeEventListener('error', bad);
      clearTimeout(timer);
    };
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(`decode error code ${el.error?.code ?? '?'}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('metadata 超时')); }, timeoutMs);
    el.addEventListener('loadeddata', ok);
    el.addEventListener('error', bad);
  });
}

async function useVideoSource(src, { loop = true, revoke = null } = {}) {
  stopStream();
  if (!(await ensureEstimator())) return false;
  videoEl.srcObject = null;
  if (revoke) {
    videoEl.addEventListener('loadstart', () => setTimeout(() => URL.revokeObjectURL(revoke), 5000), { once: true });
  }
  videoEl.src = src;
  videoEl.loop = loop;
  videoEl.onerror = () => setStatus(`视频无法解码（code ${videoEl.error?.code ?? '?'}）`, 'err');

  // 必须先等元数据/首帧就绪再 play()，否则部分环境下 play() 会被 abort
  try {
    await waitForVideoReady(videoEl);
  } catch (e) {
    setStatus(`视频加载失败：${e.message}`, 'err');
    return false;
  }
  try {
    await videoEl.play();
  } catch (e) {
    setStatus(`视频播放被拒（${e.name}）`, 'err');
    return false;
  }
  mode = 'file';
  placeholder.hidden = true;
  setActiveInput('file');
  resetRuntime();
  ensureLoop();
  setStatus('就绪 · 视频文件', 'ok');
  return true;
}

async function useVideoFile(file) {
  const url = URL.createObjectURL(file);
  return useVideoSource(url, { loop: true, revoke: url });
}

function stopAll() {
  stopStream();
  stopLoop();
  // 先摘掉 src 再 revoke，否则会触发一次对已失效 blob 的加载
  if (videoEl.src && videoEl.src.startsWith('blob:')) {
    const old = videoEl.src;
    videoEl.removeAttribute('src');
    URL.revokeObjectURL(old);
  } else {
    videoEl.removeAttribute('src');
  }
  videoEl.srcObject = null;
  mode = 'idle';
  placeholder.hidden = false;
  $('badgeNoPerson').hidden = true;
  $('badgeRes').hidden = true;
  if (canvas.width) clearCanvas(ctx, canvas.width, canvas.height);
  setActiveInput(null);
  // 清掉上一帧的判定结果，否则面板会一直显示停止前的姿态
  lastResult = null;
  updateUI();
  // 释放模型，别让关掉的页面继续占显存/内存
  closeEstimator();
  closeHandEstimator();
  estimatorReady = false;
  handReady = false;
  setStatus('已停止（模型已释放）', '');
}

function stopLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function setActiveInput(kind) {
  $('btnCamera').classList.toggle('on', kind === 'camera');
}

function ensureLoop() {
  if (rafId === null) rafId = requestAnimationFrame(loop);
}

// —— 主循环 -------------------------------------------------------------

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!estimatorReady) return;

  const v = videoEl;
  if (!v.videoWidth || v.readyState < 2) return;

  const ts = Math.max(performance.now(), lastTs + 1);
  lastTs = ts;
  if (ts - lastInferTs < inferInterval()) return;
  if (mode === 'file' && v.currentTime === lastVideoTime) return;
  lastInferTs = ts;
  lastVideoTime = v.currentTime;

  let res;
  try {
    res = detectVideo(v, ts);
  } catch (e) {
    setStatus(`推理错误：${e.message}`, 'err');
    stopLoop();
    return;
  }

  const w = v.videoWidth, h = v.videoHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    stage.style.aspectRatio = `${w} / ${h}`;
    $('badgeRes').textContent = `${w} × ${h}`;
    $('badgeRes').hidden = false;
  }

  const persons = toPersons(res, w, h);
  let sig = null, act = null, target = null;

  if (persons.length) {
    // 目标人 = 画面里面积最大的那个人；其余人只画骨架不参与判定
    const area = (p) => (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]);
    target = persons[0];
    for (const p of persons) if (area(p) > area(target)) target = p;

    if (show.skeleton) {
      let first = true;
      for (const p of persons) {
        if (p === target) continue;
        drawSkeleton(ctx, p.kp_raw, w, h, { points: show.points, clear: first, alpha: 0.4 });
        first = false;
      }
      drawSkeleton(ctx, target.kp_raw, w, h, { points: show.points, clear: first });
    } else {
      clearCanvas(ctx, w, h);
    }

    sig = signalEngine.update(target, ts);
    act = actionEngine.update(sig, ts);
    $('badgeNoPerson').hidden = true;
  } else {
    clearCanvas(ctx, w, h);
    $('badgeNoPerson').hidden = false;
  }

  // —— 手部（独立模型，失败不影响主体）
  let hands = [];
  if (show.hands && handReady) {
    try {
      const hr = detectHandsVideo(v, ts);
      hands = toHands(hr, w, h).map((hd) => ({ ...hd, cls: classifyHand(hd.kp) }));
      for (const hd of hands) drawHand(ctx, hd.kp, w, h, { alpha: 0.9 });
      handFails = 0;
    } catch (e) {
      // 连续失败说明手部模型挂了：关掉它，别每帧都抛异常拖慢主循环
      if (++handFails > 30) {
        handReady = false;
        $('chkHands').checked = false;
        show.hands = false;
        setStatus('手部模型异常，已自动关闭', 'err');
      }
    }
  }

  pushLog(ts, target, sig, act, persons.length, hands);
  pushSpark(ts, sig ? sig.knee_pick : null);

  lastResult = { ts, persons, sig, act, hands };
  countFps(ts);

  if (ts - lastUiTs > 100) {
    updateUI();
    lastUiTs = ts;
  }
}

function countFps(ts) {
  fpsFrames++;
  if (!fpsWindowTs) fpsWindowTs = ts;
  const dt = ts - fpsWindowTs;
  if (dt >= 500) {
    fps = (fpsFrames * 1000) / dt;
    fpsFrames = 0;
    fpsWindowTs = ts;
    $('fps').textContent = fps.toFixed(0);
  }
}

// —— 记录与导出 ---------------------------------------------------------

function pushLog(ts, p, sig, act, personCount = 1, hands = []) {
  frameLog.push({
    ts: Math.round(ts),
    person_count: personCount,
    persons: p ? [{
      track_id: p.track_id,
      bbox: p.bbox.map(r1),
      kp_format: p.kp_format,
      kp: p.kp.map(([x, y, v]) => [r1(x), r1(y), r2(v)]),
      scale: r2(p.scale),
      score: r2(p.score),
    }] : [],
    signals: sig ? {
      knee: r1(sig.knee_pick),
      knee_side: sig.knee_side,
      elbow: r1(sig.elbow_pick),
      uprightness: r2(sig.uprightness),
      leg_vertical: r2(sig.leg_vertical),
      elev_L: r1(sig.armPose.elev_L),
      elev_R: r1(sig.armPose.elev_R),
      hands_close: r2(sig.armPose.hands_close),
    } : null,
    actions: act ? {
      posture: act.postureId,
      frozen: act.frozen,
      flags: act.flags,
      reps: act.reps,
    } : null,
    hands: hands.map((hd) => ({
      handedness: hd.handedness,
      shape: hd.cls.shape,
      score: r2(hd.score),
      bbox: hd.bbox.map(r1),
      kp: hd.kp.map(([x, y]) => [r1(x), r1(y)]),
    })),
  });
  if (frameLog.length > MAX_LOG) frameLog.shift();
}

function exportJSON() {
  if (!frameLog.length) {
    setStatus('没有可导出的帧', 'busy');
    return;
  }
  const payload = {
    exported_at: new Date().toISOString(),
    schema: 'frame.jsonl v0',
    kp_format: 'mediapipe33',
    hand_kp_format: 'mediapipe21',
    fps: r1(fps),
    frame_count: frameLog.length,
    frames: frameLog,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pose-frames-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// —— 角度曲线（校准阈值用）---------------------------------------------

function pushSpark(ts, v) {
  sparkSamples.push([ts, Number.isFinite(v) ? v : null]);
  while (sparkSamples.length && ts - sparkSamples[0][0] > SPARK_SPAN_MS) sparkSamples.shift();
}

function drawSpark(now) {
  const c = spark;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const padL = 34;
  g.clearRect(0, 0, W, H);

  const LO = 50, HI = 190;
  const yOf = (v) => H - ((Math.min(HI, Math.max(LO, v)) - LO) / (HI - LO)) * (H - 6) - 3;

  g.font = '20px ui-monospace, Consolas, monospace';
  g.textBaseline = 'middle';
  for (const v of [60, 120, 180]) {
    const y = yOf(v);
    g.strokeStyle = '#efeff2';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, y); g.lineTo(W, y); g.stroke();
    g.fillStyle = '#b0b0b5';
    g.fillText(String(v), 2, y);
  }

  g.strokeStyle = '#d9d9de';
  g.setLineDash([6, 6]);
  for (const v of [100, 150]) {
    const y = yOf(v);
    g.beginPath(); g.moveTo(padL, y); g.lineTo(W, y); g.stroke();
  }
  g.setLineDash([]);

  if (sparkSamples.length < 2) return;

  const t0 = now - SPARK_SPAN_MS;
  const xOf = (t) => padL + ((t - t0) / SPARK_SPAN_MS) * (W - padL);

  g.strokeStyle = '#1d1d1f';
  g.lineWidth = 3;
  g.lineJoin = 'round';
  g.beginPath();
  let started = false;
  for (const [t, v] of sparkSamples) {
    if (v === null) { started = false; continue; }
    const x = xOf(t), y = yOf(v);
    if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
  }
  g.stroke();

  const last = sparkSamples[sparkSamples.length - 1];
  if (last && last[1] !== null) {
    g.fillStyle = '#1d1d1f';
    g.beginPath();
    g.arc(xOf(last[0]), yOf(last[1]), 4, 0, Math.PI * 2);
    g.fill();
  }
}

// —— UI -----------------------------------------------------------------

function renderReps(reps) {
  $('repSquat').textContent = reps.squat ?? 0;
  $('repPushup').textContent = reps.pushup ?? 0;
  $('repClap').textContent = reps.clap ?? 0;
}

function buildGrids() {
  $('postureChips').innerHTML = ACTION_CATALOG
    .map((a) => `<span class="chip" data-id="${a.id}">${a.name}</span>`)
    .join('');
  $('armGrid').innerHTML = ARM_ACTIONS
    .map((a) => `<div class="act" data-id="${a.id}"><span>${a.name}</span></div>`)
    .join('');
}

const ARM_FLAG = {
  arm_raised: 'armRaised',
  wave: 'waving',
  crossed: 'crossed',
  hips: 'onHips',
  arms_open: 'armsOpen',
};

function updateUI() {
  const { sig, act, hands } = lastResult || {};

  const postureEl = $('posture');
  postureEl.textContent = act?.posture || (sig ? '未判定' : '—');
  postureEl.classList.toggle('dim', !act?.posture);

  if (act?.posture) {
    const secs = (act.postureMs / 1000).toFixed(1);
    $('postureMeta').textContent = act.frozen ? `保持 ${secs}s · 置信不足` : `持续 ${secs}s`;
  } else {
    $('postureMeta').textContent = sig ? '—' : '无画面';
  }

  for (const a of ACTION_CATALOG) {
    const el = document.querySelector(`#postureChips .chip[data-id="${a.id}"]`);
    if (el) el.classList.toggle('on', act?.postureId === a.id);
  }

  for (const a of ARM_ACTIONS) {
    const el = document.querySelector(`#armGrid .act[data-id="${a.id}"]`);
    if (el) el.classList.toggle('on', !!act?.flags?.[ARM_FLAG[a.id]]);
  }

  // 手部：按 handedness 取（镜像只影响画面，不影响模型输出的左右手）
  const pick = (side) => (hands || []).find((h) => h.handedness === side);
  const hl = pick('Left');
  const hr = pick('Right');
  $('handL').textContent = hl ? hl.cls.label : '—';
  $('handR').textContent = hr ? hr.cls.label : '—';
  $('handLCard').classList.toggle('on', !!hl);
  $('handRCard').classList.toggle('on', !!hr);
  $('handMeta').textContent = !show.hands ? '已关闭'
    : !handReady ? '模型未加载'
    : (hands && hands.length) ? `${hands.length} 只手` : '未检出';

  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const rows = [
    ['膝角 °', sig ? r1(sig.knee_pick) : null],
    ['肘角 °', sig ? r1(sig.elbow_pick) : null],
    ['抬臂角 L/R', sig ? `${fmt(sig.armPose.elev_L, 0)} / ${fmt(sig.armPose.elev_R, 0)}` : null],
    ['直立度', sig ? r2(sig.uprightness) : null],
    ['腿竖直比', sig ? r2(sig.leg_vertical) : null],
  ];
  $('angles').innerHTML = rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v === null || v === undefined ? '—' : v}</td></tr>`)
    .join('');

  $('signalMeta').textContent = sig
    ? `膝角取${sig.knee_side === 'L' ? '左' : '右'}腿 · 置信 ${r2(sig.score)}`
    : '—';

  if (act?.reps) renderReps(act.reps);
  $('repMeta').textContent = act
    ? `门控 深蹲${act.gates?.squat ? '✓' : '—'} 俯卧撑${act.gates?.pushup ? '✓' : '—'} 鼓掌${act.gates?.clap ? '✓' : '—'}`
    : '—';

  const span = frameLog.length > 1
    ? (frameLog[frameLog.length - 1].ts - frameLog[0].ts) / 1000
    : 0;
  $('logInfo').textContent = frameLog.length
    ? `${frameLog.length} 帧 / ${span.toFixed(1)}s`
    : '—';

  drawSpark(performance.now());
}

// —— 事件绑定 -----------------------------------------------------------

buildGrids();

$('btnCamera').addEventListener('click', startCamera);
$('btnStop').addEventListener('click', stopAll);
$('fileInput').addEventListener('change', async (ev) => {
  const f = ev.target.files?.[0];
  if (f) await useVideoFile(f);
});
$('modelSel').addEventListener('change', () => { if (mode !== 'idle') initEstimator(); });
$('delegateSel').addEventListener('change', () => { if (mode !== 'idle') initEstimator(); });
$('fpsCapSel').addEventListener('change', () => { lastInferTs = 0; });
$('chkSkeleton').addEventListener('change', (e) => { show.skeleton = e.target.checked; });
$('chkHands').addEventListener('change', async (e) => {
  show.hands = e.target.checked;
  if (show.hands && !handsReady()) await initHands($('delegateSel').value);
  updateUI();
});
$('chkPoints').addEventListener('change', (e) => { show.points = e.target.checked; });
$('chkMirror').addEventListener('change', (e) => {
  show.mirror = e.target.checked;
  stage.classList.toggle('mirror', show.mirror);
});
$('btnReset').addEventListener('click', () => {
  actionEngine.reset();
  renderReps({ squat: 0, pushup: 0, clap: 0 });
});
$('btnExport').addEventListener('click', exportJSON);
window.addEventListener('beforeunload', () => { stopStream(); closeEstimator(); closeHandEstimator(); });

// 页面切到后台就停推理，别在看不见的时候还在烧 GPU
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopLoop();
  } else if (mode !== 'idle' && estimatorReady) {
    ensureLoop();
  }
});

// 测试钩子
window.__pose = {
  get state() {
    return {
      estimatorReady, handReady, mode, fps: r1(fps), frames: frameLog.length, lastResult,
    };
  },
  get lastFrame() { return frameLog[frameLog.length - 1] || null; },
  get ui() {
    return {
      posture: $('posture').textContent,
      meta: $('postureMeta').textContent,
      handMeta: $('handMeta').textContent,
      handL: $('handL').textContent,
      handR: $('handR').textContent,
      signalMeta: $('signalMeta').textContent,
      repMeta: $('repMeta').textContent,
      logInfo: $('logInfo').textContent,
      postureChips: [...document.querySelectorAll('#postureChips .chip')].map((el) => ({ id: el.dataset.id, on: el.classList.contains('on') })),
      armActions: [...document.querySelectorAll('#armGrid .act')].map((el) => ({ id: el.dataset.id, on: el.classList.contains('on') })),
    };
  },
  initEstimator,
  startCamera,
  useVideoSource,
};

// 懒加载：页面打开不建模型，点「摄像头」或「上传视频」时才加载（省内存，多开标签页也不炸）
setStatus('待启动 · 点摄像头或上传视频', '');
if (autoSrc) ensureEstimator();
