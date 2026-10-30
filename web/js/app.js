// app.js — 组装层：输入源 → 感知（姿态 + 手部）→ 信号 → 动作 → 可视化/导出
import { createEstimator, detectVideo, toPersons, closeEstimator } from './pose.js';
import { createHandEstimator, detectHandsVideo, toHands, classifyHand, handsReady, closeHandEstimator } from './hands.js';
import { HandShapeStabilizer, SHAPE_LABELS } from './handshape.js';
import { SignalEngine } from './signals.js';
import { ActionEngine, ACTION_CATALOG, ARM_ACTIONS, REP_ACTIONS } from './actions.js';
import { resolveParams, profileParams, profileName as profileNameOf, paramsHash } from './params.js';
import { buildHardcase, HARDCASE_ACTIONS, HARDCASE_AFTER_MS, HARDCASE_BEFORE_MS } from './hardcase.js';
import { drawSkeleton, drawHand, clearCanvas } from './draw.js';

const $ = (id) => document.getElementById(id);
const videoEl = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const placeholder = $('placeholder');
const spark = $('spark');
const player = $('player');
const seek = $('seek');

const SETTINGS_KEY = 'pose-demo.settings.v1';
const CUSTOM_PROFILE = '__custom__';
// profile 下拉的固定项；自定义 URL 通过 ?profile= 或上次选择恢复
const PROFILES = [
  { id: 'default', label: '默认阈值', url: null },
  { id: 'fitness', label: '健身', url: '/web/profiles/fitness.json' },
];

const MAX_LOG = 20000;   // 评估需要整段素材，截断会让 recall 失真；20k 帧 ≈ 11 分钟 @30fps
// 溢出时按块丢弃（一次 splice 掉 10%），而不是每帧 shift()。
// shift() 在 20000 元素上是每帧 O(n) 的整体复制（实测 57~69 µs/帧），
// 从 600 提到 20000 时这个开销从"免费"变成了实打实的每帧成本。
const LOG_TRIM = Math.round(MAX_LOG * 0.1);
const SPARK_SPAN_MS = 5000;

// 推理帧率上限：默认 15fps。摄像头 30fps + rAF 60Hz 会对同一帧反复推理，白烧 CPU/GPU。
const inferInterval = () => 1000 / (Number($('fpsCapSel').value) || 15);

// profile：URL 参数 ?profile=/profiles/fitness.json，用于切场景时只换阈值不改代码
const profileUrl = new URLSearchParams(location.search).get('profile');
let activeParams = {};
let profileName = 'default';
// profile 可以声明它是在哪个模型档位下校准的（lite/full）。阈值与档位是绑定的：
// full 的关键点更稳，用 full 拟合的阈值拿到 lite 上可能就漏计（PLAN §13 R0）。
let profileModel = null;
// 实际跑起来的模型/后端：导出时写进 meta，否则事后无法判断数据出自哪一档
let activeModel = null;
let activeDelegate = null;
let signalEngine = new SignalEngine(activeParams);
let actionEngine = new ActionEngine(activeParams);

// 手势稳定器：左右手各一个，互不影响。streak/keepMs 从 params 读，profile 才能调
function makeShapeStable(params) {
  const cfg = resolveParams(params).signals.gesture;
  return {
    L: new HandShapeStabilizer(cfg),
    R: new HandShapeStabilizer(cfg),
    U: new HandShapeStabilizer(cfg),
  };
}
let shapeStable = makeShapeStable(activeParams);

/** 换参数要重建引擎：滤波器和计数器持有状态，只改字段会让它们停在上一次的参数上 */
function applyParams(params, name = 'default') {
  activeParams = params || {};
  profileName = name;
  signalEngine = new SignalEngine(activeParams);
  actionEngine = new ActionEngine(activeParams);
  shapeStable = makeShapeStable(activeParams);
  activeParamsHash = paramsHash(activeParams);
  squatCfg = resolveParams(activeParams).actions.reps.squat;
  updateSparkLegend();
  resetRuntime();
}

async function loadProfile(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    profileModel = typeof raw.model === 'string' && raw.model ? raw.model : null;
    applyParams(profileParams(raw), profileNameOf(raw, url));
    // 不要覆盖状态栏的输入状态；profile 名显示在工具条
    updateProfileTag();
    return true;
  } catch (e) {
    setStatus(`profile 加载失败：${e.message}`, 'err');
    return false;
  }
}

/**
 * 工具条上的 profile 标签：名字 + 声明的模型档位。
 * 档位不一致时标黄并给 title 说明 —— 不是错误（阈值仍能跑），但报告不能拿它当同一套阈值。
 */
function updateProfileTag() {
  const tag = $('profileTag');
  if (!tag) return;
  const label = profileName === 'default' ? '默认阈值' : profileName;
  const mismatch = !!(profileModel && activeModel && profileModel !== activeModel);
  tag.textContent = profileModel ? `${label} · ${profileModel}` : label;
  tag.hidden = false;
  tag.classList.toggle('warn', mismatch);
  tag.title = mismatch
    ? `profile 声明 model=${profileModel}，当前 ${activeModel}；阈值是按另一个档位校准的`
    : profileModel ? `阈值按 model=${profileModel} 校准` : '';
}

// —— profile 切换 -------------------------------------------------------
// 默认 + 固定 profile 来自 PROFILES；?profile= 或上次保存的 URL 作为「自定义」项。

function profileEntry(id) {
  if (id === CUSTOM_PROFILE && customProfileUrl) return { id, label: '自定义', url: customProfileUrl };
  return PROFILES.find((p) => p.id === id) || null;
}

function ensureCustomProfileOption(url) {
  customProfileUrl = url || null;
  const sel = $('profileSel');
  let opt = sel.querySelector(`option[value="${CUSTOM_PROFILE}"]`);
  if (!url) {
    if (opt) opt.remove();
    return;
  }
  if (!opt) {
    opt = document.createElement('option');
    opt.value = CUSTOM_PROFILE;
    sel.appendChild(opt);
  }
  opt.textContent = `自定义（${url.split('/').pop()}）`;
}

/**
 * 切换 profile：成功才更新 lastProfileId 并保存；失败恢复上一个选项与参数。
 * 切换会清空已记录的帧——参数变了，旧帧就不是同一套阈值下的数据了。
 */
async function switchProfile(id, { announce = true } = {}) {
  const sel = $('profileSel');
  const entry = profileEntry(id);
  if (!entry) return false;
  const prev = lastProfileId;
  if (announce) setStatus(`加载 profile：${entry.label}…`, 'busy');
  sel.disabled = true;
  let ok = true;
  if (entry.url) ok = await loadProfile(entry.url);
  else { profileModel = null; applyParams({}, 'default'); updateProfileTag(); }
  sel.disabled = false;
  if (!ok) {
    sel.value = prev;
    updateProfileTag();
    setStatus(`profile 加载失败，保留「${profileEntry(prev)?.label || prev}」`, 'err');
    return false;
  }
  lastProfileId = id;
  sel.value = id;
  saveSettings();
  if (announce) setStatus(`已切换 profile：${entry.label}（记录已清空）`, 'ok');
  return true;
}

/** 启动时决定用哪个 profile：URL 参数 > 上次保存 > 默认 */
async function initProfile() {
  const saved = readSettings().profile;
  const savedProfile = saved && typeof saved === 'object' ? saved : null;
  let id = 'default';
  if (profileUrl) {
    ensureCustomProfileOption(profileUrl);
    id = CUSTOM_PROFILE;
  } else if (savedProfile?.id === CUSTOM_PROFILE && savedProfile.url) {
    ensureCustomProfileOption(savedProfile.url);
    id = CUSTOM_PROFILE;
  } else if (savedProfile?.id && PROFILES.some((p) => p.id === savedProfile.id)) {
    id = savedProfile.id;
  }
  $('profileSel').value = id;
  if (id === 'default') {
    lastProfileId = 'default';
    applyParams({}, 'default');
    updateProfileTag();
  } else {
    await switchProfile(id, { announce: false });
  }
}

function updateSparkLegend() {
  const el = $('sparkThresh');
  if (el) el.textContent = `下阈 ${squatCfg.down}° / 上阈 ${squatCfg.up}°`;
}

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
let lastLogVideoTime = -1; // 上一次写进 frameLog 的 video_time（秒）
let videoWrapDetected = false; // 文件模式下检测到 currentTime 回退（循环回绕 / 手动拖回）
// —— 输入/设置状态 ——
let cameraFacing = 'user';      // 'user' | 'environment'
let cameraDeviceId = null;      // enumerateDevices 的 deviceId
let cameraDevices = [];         // 当前可用的 videoinput
let customProfileUrl = null;    // ?profile= 或上次保存的自定义 profile
let lastProfileId = 'default';  // 最近一次成功应用的 profile（失败时回退用）
let activeParamsHash = paramsHash({});
let squatCfg = resolveParams({}).actions.reps.squat;
let logDropped = 0;             // 超过 MAX_LOG 被裁掉的帧数（会话摘要要如实显示）
let seeking = false;            // 正在拖进度条：syncPlayer 不要覆盖用户拖动
let resumeAfterSeek = false;
let dragDepth = 0;
let profileReady = Promise.resolve(); // 启动时 profile 加载完成前不要开始输入

const show = { skeleton: true, hands: true, points: true, mirror: true };
const autoSrc = new URLSearchParams(location.search).get('src');
applyStoredSettings();

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

// —— 设置持久化 ---------------------------------------------------------
// 刷新页面不该丢掉模型/帧率/开关；隐私模式下 localStorage 可能抛错，读写都要兜底。
function readSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      model: $('modelSel').value,
      delegate: $('delegateSel').value,
      fps: $('fpsCapSel').value,
      skeleton: $('chkSkeleton').checked,
      hands: $('chkHands').checked,
      points: $('chkPoints').checked,
      mirror: $('chkMirror').checked,
      loop: $('chkLoop').checked,
      profile: { id: $('profileSel').value, url: customProfileUrl },
      cameraFacing,
      cameraDeviceId,
    }));
  } catch { /* 不持久化不影响运行 */ }
}

/** 把上次的选择写回控件；profile 由 initProfile() 在底部统一处理 */
function applyStoredSettings() {
  const s = readSettings();
  const pick = (id, v) => {
    const el = $(id);
    if (!el || v == null) return;
    const val = String(v);
    if ([...el.options].some((o) => o.value === val)) el.value = val;
  };
  pick('modelSel', s.model);
  pick('delegateSel', s.delegate);
  pick('fpsCapSel', s.fps);
  if (typeof s.skeleton === 'boolean') show.skeleton = s.skeleton;
  if (typeof s.hands === 'boolean') show.hands = s.hands;
  if (typeof s.points === 'boolean') show.points = s.points;
  if (typeof s.mirror === 'boolean') show.mirror = s.mirror;
  $('chkSkeleton').checked = show.skeleton;
  $('chkHands').checked = show.hands;
  $('chkPoints').checked = show.points;
  $('chkMirror').checked = show.mirror;
  stage.classList.toggle('mirror', show.mirror);
  if (typeof s.loop === 'boolean') $('chkLoop').checked = s.loop;
  if (s.cameraFacing === 'user' || s.cameraFacing === 'environment') cameraFacing = s.cameraFacing;
  if (typeof s.cameraDeviceId === 'string' && s.cameraDeviceId) cameraDeviceId = s.cameraDeviceId;
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
  // 加载期间锁住选择框：换模型/后端会重新建 estimator，连点会互相打架
  const modelSel = $('modelSel');
  const delegateSel = $('delegateSel');
  modelSel.disabled = true;
  delegateSel.disabled = true;

  try {
    const candidates = want === 'GPU' ? ['GPU', 'CPU'] : ['CPU'];
    let lastErr = null;
    for (const delegate of candidates) {
      try {
        await createEstimator({ model, delegate, runningMode: 'VIDEO', numPoses });
        estimatorReady = true;
        activeModel = model;
        activeDelegate = delegate;
        updateModelInfo();
        const mismatch = !!(profileModel && profileModel !== model);
        setStatus(
          `就绪 · ${model}/${delegate}${mismatch ? ` · ⚠ profile 需 ${profileModel}` : ''}`,
          mismatch ? 'busy' : 'ok',
        );
        updateProfileTag();
        resetRuntime();
        await initHands(delegate);
        if (autoSrc && !autoLoaded) {
          autoLoaded = true;
          useVideoSource(autoSrc, { loop: $('chkLoop').checked });
        }
        return true;
      } catch (e) {
        lastErr = e;
      }
    }
    // 不把 activeModel 清空：已经录下的帧仍属于上一档模型，导出的 meta 要如实写。
    // 工具条显示由 updateModelInfo() 依据 estimatorReady 决定。
    updateModelInfo();
    setStatus(`模型加载失败：${lastErr?.message || 'unknown'}`, 'err');
    return false;
  } finally {
    modelSel.disabled = false;
    delegateSel.disabled = false;
  }
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
  cancelHardcase();
  signalEngine.reset();
  actionEngine.reset();
  frameLog = [];
  sparkSamples = [];
  lastVideoTime = -1;
  lastLogVideoTime = -1;
  videoWrapDetected = false;
  logDropped = 0;
  seeking = false;
  resumeAfterSeek = false;
  lastInferTs = 0;
  handFails = 0;
  for (const k of Object.keys(shapeStable)) shapeStable[k].reset();
  renderReps({ squat: 0, pushup: 0, clap: 0, grasp: 0 });
  updateUI();
}

// —— 输入源 -------------------------------------------------------------

async function refreshCameraDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    cameraDevices = all.filter((d) => d.kind === 'videoinput');
  } catch {
    cameraDevices = [];
  }
  syncPlayer();
}

/** 有多个摄像头（桌面）或移动端（可切前后）才显示「切换摄像头」 */
function cameraCanSwitch() {
  return (!!window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
    || cameraDevices.length > 1;
}

// 摄像头一次只能起一条流：连点「切换摄像头」会并发两次 getUserMedia，
// 后一次把 currentStream 覆盖掉，前一条永远没人 stop（指示灯常亮、解码白跑）。
let cameraStarting = false;

async function startCamera(opts = {}) {
  if (cameraStarting) return;
  cameraStarting = true;
  const btn = $('btnCamera');
  const prevMode = mode;      // 失败时别连累已经在播的文件
  let assigned = false;       // 是否已经把摄像头流挂到 video 上（挂上后文件源就没了）
  try {
    await profileReady;
    stopStream();
    setStatus('摄像头启动中…', 'busy');
    btn.disabled = true;
    if (!(await ensureEstimator())) {
      if (prevMode === 'file' && videoEl.getAttribute('src')) return;
      stopLoop();
      videoEl.srcObject = null;
      mode = 'idle';
      setActiveInput(null);
      syncPlayer();
      return;
    }
    const facing = opts.facing || cameraFacing;
    // 摄像头按钮重开时沿用上次的 deviceId；显式切 facing 时不带 deviceId
    const deviceId = (opts.deviceId !== undefined && opts.deviceId !== null)
      ? opts.deviceId
      : (opts.facing ? null : cameraDeviceId);
    const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    const constraints = (withDevice) => ({
      audio: false,
      video: withDevice
        ? { ...base, deviceId: { exact: withDevice } }
        : { ...base, facingMode: facing },
    });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (e) {
      // 保存的 deviceId 可能已经不存在（换了设备/权限重置）：退回 facingMode
      if (!deviceId) throw e;
      cameraDeviceId = null;
      stream = await navigator.mediaDevices.getUserMedia(constraints(null));
    }
    currentStream = stream;
    videoEl.srcObject = stream;
    assigned = true;
    videoEl.loop = false;
    await videoEl.play();
    mode = 'camera';
    placeholder.hidden = true;
    setActiveInput('camera');
    const track = stream.getVideoTracks()[0];
    cameraDeviceId = track?.getSettings?.().deviceId || deviceId || null;
    cameraFacing = facing;
    await refreshCameraDevices();
    resetRuntime();
    ensureLoop();
    setStatus(`就绪 · 摄像头${cameraDevices.length > 1 ? ' · 可切换' : ''}`, 'ok');
    saveSettings();
    syncPlayer();
  } catch (e) {
    // 摄像头没起来、文件源一点没动：保持原视频和已录帧，只报错。
    // （之前这里无条件 resetRuntime()，会把用户已录的一段数据清空）
    if (!assigned && prevMode === 'file' && videoEl.getAttribute('src')) {
      setStatus(`摄像头不可用（${e.name}），原视频继续`, 'err');
      syncPlayer();
    } else {
      placeholder.hidden = false;
      placeholder.querySelector('p').textContent = `摄像头不可用（${e.name}）`;
      placeholder.querySelector('.hint').textContent = '检查浏览器权限后点「摄像头」重试';
      setStatus('摄像头不可用', 'err');
      setActiveInput(null);
      mode = 'idle';
      // 旧流已停：停循环、摘掉 srcObject，别让主循环继续拿停掉的流写帧
      stopLoop();
      videoEl.srcObject = null;
      // 不要 resetRuntime()：已经录到的帧仍然可以导出，清掉只会白丢数据
      syncPlayer();
    }
  } finally {
    cameraStarting = false;
    btn.disabled = false;
  }
}

/** 多个设备按 deviceId 轮换；单设备/移动端切 facingMode */
async function switchCamera() {
  if (mode !== 'camera') return;
  if (cameraDevices.length > 1) {
    const idx = cameraDevices.findIndex((d) => d.deviceId === cameraDeviceId);
    const next = cameraDevices[(idx + 1) % cameraDevices.length];
    await startCamera({ deviceId: next.deviceId, facing: cameraFacing });
  } else {
    await startCamera({ facing: cameraFacing === 'user' ? 'environment' : 'user' });
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

async function useVideoSource(src, { loop = false, revoke = null } = {}) {
  await profileReady;
  stopStream();
  if (!(await ensureEstimator())) {
    // 模型起不来时，正在播的原文件别跟着一起清掉
    if (mode === 'file' && videoEl.getAttribute('src')) {
      if (revoke) URL.revokeObjectURL(revoke);   // 新 blob 从没挂到 video 上，直接释放
      syncPlayer();
      return false;
    }
    stopLoop();
    videoEl.srcObject = null;
    mode = 'idle';
    setActiveInput(null);
    if (revoke) URL.revokeObjectURL(revoke);
    syncPlayer();
    return false;
  }
  videoEl.srcObject = null;
  if (revoke) {
    videoEl.addEventListener('loadstart', () => setTimeout(() => URL.revokeObjectURL(revoke), 5000), { once: true });
  }
  videoEl.src = src;
  videoEl.loop = loop;
  videoEl.onerror = () => failInput(`视频无法解码（code ${videoEl.error?.code ?? '?'}）`);

  // 必须先等元数据/首帧就绪再 play()，否则部分环境下 play() 会被 abort
  try {
    await waitForVideoReady(videoEl);
  } catch (e) {
    failInput(`视频加载失败：${e.message}`);
    return false;
  }
  try {
    await videoEl.play();
  } catch (e) {
    failInput(`视频播放被拒（${e.name}）`);
    return false;
  }
  mode = 'file';
  placeholder.hidden = true;
  setActiveInput('file');
  resetRuntime();
  ensureLoop();
  $('chkLoop').checked = !!loop;
  syncPlayer();
  const warmed = await warmUpPlayback();
  // 两种情况都不能用「就绪」盖掉已写好的错误状态：
  // 预热期间推理出错会 stopLoop()（rafId 变 null）；恢复播放被拒时 warmUpPlayback 返回 false。
  if (rafId !== null && warmed) setStatus('就绪 · 视频文件', 'ok');
  return true;
}

/**
 * 首帧预热：先停住播放，等第一帧推理出结果再放行。
 *
 * 单次播放 + 冷启动时第一帧推理要 1~2 秒（wasm/着色器编译），
 * 视频会在这段时间里自己跑到后半段：3 秒素材实测只记到 2~23 帧，
 * 帧数不够做任何按时间窗的分析，难例窗口也很快就过期（见 hardcaseAnchorTs）。
 * 暂停在首帧等结果，等于把预热挪到视频之外——素材一帧不少。
 * 推理挂了（超时 / loop 已停）就照常播放，不阻塞入口。
 * @returns {Promise<boolean>} false = 恢复播放被拒（状态栏已写错误，调用方别再覆盖）
 */
async function warmUpPlayback(timeoutMs = 6000) {
  if (videoEl.paused || videoEl.ended) return true;
  videoEl.pause();
  setStatus('视频已暂停，等第一帧分析完成…', 'busy');
  const t0 = performance.now();
  while (!frameLog.length && performance.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (videoEl.ended) return true;
  try {
    await videoEl.play();
    return true;
  } catch (e) {
    setStatus(`视频播放被拒（${e.name}）`, 'err');
    return false;
  }
}

async function useVideoFile(file) {
  await profileReady;
  const url = URL.createObjectURL(file);
  // 默认单次播放：一次导出只对应一遍视频，video_time 单调，秒数标注才唯一。
  // 用户可在播放条勾选循环；回绕后记录会停止（已有行为，播放条会显示状态）。
  const ok = await useVideoSource(url, { loop: $('chkLoop').checked, revoke: url });
  if (ok) setStatus(`就绪 · 视频文件 · ${file.name}`, 'ok');
  return ok;
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
  resetPlaceholder();
  placeholder.hidden = false;
  $('badgeNoPerson').hidden = true;
  $('badgeRes').hidden = true;
  if (canvas.width) clearCanvas(ctx, canvas.width, canvas.height);
  setActiveInput(null);
  // 清掉上一帧的判定结果，否则面板会一直显示停止前的姿态
  lastResult = null;
  updateUI();
  syncPlayer();
  // 释放模型，别让关掉的页面继续占显存/内存
  closeEstimator();
  closeHandEstimator();
  estimatorReady = false;
  handReady = false;
  // activeModel/activeDelegate 故意保留：已录的帧就是这两档模型产出的，
  // 停止后再导出仍要能写对 meta.model（否则事后分不清数据来自 lite 还是 full）。
  updateModelInfo();
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

/**
 * 是否继续把这一帧写进 frameLog。
 *
 * 文件模式下 currentTime 一旦回退（循环播放回绕，或用户把进度条拖回去），
 * 同一份导出里就会出现多段 video_time，秒数不再能唯一映射到某一帧
 * （evaluate.resolveRange 会直接拒绝 startSec/endSec）。这时立刻停止记录：
 * 保留已经记录的那一遍（单调、可评估），不清空、不静默改写；
 * 状态栏提示用户导出当前素材或重新录制单次播放。
 * 摄像头模式没有稳定的媒体时间，不适用。
 */
function mayLogFrame() {
  if (videoWrapDetected) return false;
  if (mode !== 'file') return true;
  const t = videoEl.currentTime;
  if (lastLogVideoTime >= 0 && t < lastLogVideoTime) {
    videoWrapDetected = true;
    setStatus('检测到视频回绕，已停止记录；请导出当前素材或重新录制单次播放', 'busy');
    return false;
  }
  lastLogVideoTime = t;
  return true;
}

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
    // 舞台是固定高度的取景窗（CSS 决定尺寸），不再按视频比例撑开：
    // 竖屏素材会把舞台压成一条窄柱，还会把整页拉高。视频与画布都用 object-fit: contain 居中。
    $('badgeRes').textContent = `${w} × ${h}`;
    $('badgeRes').hidden = false;
  }

  const persons = toPersons(res, w, h);
  let sig = null, act = null, target = null;

  // —— 手部要先于动作判定：拿取/持物需要「手是张开还是握紧」，姿态层给不了。
  // 手部模型失败不影响主体识别，hands 为空时这些动作一律不成立。
  let hands = [];
  if (show.hands && handReady) {
    try {
      const hr = detectHandsVideo(v, ts);
      hands = toHands(hr, w, h).map((hd) => {
        const cls = classifyHand(hd.kp);
        // 手势去抖：连续 N 帧命中才切换，否则「张开↔剪刀手」会来回闪
        const stable = shapeStable[hd.handedness === 'Left' ? 'L'
          : hd.handedness === 'Right' ? 'R' : 'U'].update(cls.shape, ts);
        // 中文名只从 handshape.js 的 SHAPE_LABELS 来（之前 app.js 又抄了一份 SHAPE_ZH）
        const label = SHAPE_LABELS[stable] || '—';
        return { ...hd, cls: { ...cls, shape: stable, label, raw: cls.shape } };
      });
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
    // 只把「稳定后」的手势传给动作层；未检出的手给 undefined，动作层据此不判拿取
    const handState = {
      L: hands.find((h) => h.handedness === 'Left')?.cls.shape ?? null,
      R: hands.find((h) => h.handedness === 'Right')?.cls.shape ?? null,
    };
    act = actionEngine.update(sig, ts, handState);
    $('badgeNoPerson').hidden = true;
  } else {
    clearCanvas(ctx, w, h);
    $('badgeNoPerson').hidden = false;
  }

  for (const hd of hands) drawHand(ctx, hd.kp, w, h, { alpha: 0.9 });

  if (mayLogFrame()) pushLog(ts, target, sig, act, persons.length, hands);
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
    // 视频/摄像头画面的时间（秒）。ts 是 performance.now，录完对不上人眼看到的时间；
    // 标注时按 video_time 写秒数最省事（见 docs/eval.md）。摄像头没有稳定的媒体时间，用 ts 折算。
    video_time: mode === 'file' ? Math.round(videoEl.currentTime * 1000) / 1000 : null,
    person_count: personCount,
    persons: p ? [{
      track_id: p.track_id,
      bbox: p.bbox.map(r1),
      kp_format: p.kp_format,
      kp: p.kp.map(([x, y, v]) => [r1(x), r1(y), r2(v)]),
      // 世界坐标（米制）：3D 抬臂角/举手判定依赖它。不导出的话，离线评估永远只能走 2D 分支，
      // 评估结果就和页面实际执行的规则不是一回事（见 evaluate.mjs 文件头）。
      kp_world: p.kp_world && p.kp_world.length
        ? p.kp_world.map(([x, y, z]) => [r2(x), r2(y), r2(z)]) : null,
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
      elev_torso_L: r1(sig.armPose.elev_torso_L),
      elev_torso_R: r1(sig.armPose.elev_torso_R),
      reach_head_L: r2(sig.armPose.reach_head_L),
      reach_head_R: r2(sig.armPose.reach_head_R),
      has_world: !!sig.armPose.has_world,
      hands_close: r2(sig.armPose.hands_close),
      // 拿取相关：伸出程度与水平方位角，拟合 extend/azimuth 阈值要靠这两列
      reach_L: r2(sig.armPose.reach_L),
      reach_R: r2(sig.armPose.reach_R),
      extend_L: !!sig.armPose.extend_L,
      extend_R: !!sig.armPose.extend_R,
      azimuth_L: r1(sig.armPose.azimuth_L),
      azimuth_R: r1(sig.armPose.azimuth_R),
      // —— R3：2D/3D 双份信号。离线对比「哪套在正/侧面更可分」必须两边都有，
      // 只导判定用的那一份，事后就没法回答「3D 到底有没有更好」。
      knee_2d: r1(sig.knee_pick_2d),
      knee_3d: r1(sig.knee_pick_3d),
      elbow_2d: r1(sig.elbow_pick_2d),
      elbow_3d: r1(sig.elbow_pick_3d),
      uprightness_2d: r2(sig.uprightness_2d),
      uprightness_3d: r2(sig.uprightness_3d),
      leg_vertical_2d: r2(sig.leg_vertical_2d),
      leg_vertical_3d: r2(sig.leg_vertical_3d),
      knee_vel: r1(sig.knee_vel),
      elbow_vel: r1(sig.elbow_vel),
      scale_world: r3(sig.scale_world),
      angle_source: sig.angle_source,
      extrapolated: sig.extrapolated,
      bones_ok: sig.world.bones,
    } : null,
    actions: act ? {
      posture: act.postureId,
      frozen: act.frozen,
      flags: act.flags,
      reps: act.reps,
      grasp_phase: act.repPhase?.grasp ?? null,
    } : null,
    hands: hands.map((hd) => ({
      handedness: hd.handedness,
      shape: hd.cls.shape,
      shape_raw: hd.cls.raw,
      score: r2(hd.score),
      orient: hd.orient,
      spread: hd.spread,
      bbox: hd.bbox.map(r1),
      kp: hd.kp.map(([x, y]) => [r1(x), r1(y)]),
    })),
  });
  // 溢出时一次丢一批，摊薄成本（每帧 shift 会变成 O(n)）
  if (frameLog.length > MAX_LOG) {
    const removed = frameLog.splice(0, LOG_TRIM);
    logDropped += removed.length;
  }
}

/**
 * 导出为 JSONL（一行一帧）。
 * 不整份 JSON.stringify：20000 帧实测会产生 40MB 字符串、峰值堆 184MB、阻塞主线程约 300ms。
 * 按块生成 Blob 分片，浏览器自己拼装，主线程只处理小块。
 * 格式与 evaluate.mjs 的 JSONL 输入兼容（首行是 meta，后续每行一帧）。
 */
/** 常规导出与难例导出共用的 meta 基底 */
function baseExportMeta() {
  return {
    exported_at: new Date().toISOString(),
    schema: 'frame.jsonl v0',
    kp_format: 'mediapipe33',
    hand_kp_format: 'mediapipe21',
    // 模型档位与后端：lite 和 full 的关键点噪声不同，阈值不能混用（PLAN §13 R0）。
    // 事后想回答"这份数据是哪套模型跑出来的"，只能靠这两行。
    model: activeModel,
    delegate: activeDelegate,
    hand_model: handReady ? 'hand_landmarker' : null,
    infer_fps: Number($('fpsCapSel').value) || null,
    fps: r1(fps),
    profile: profileName,
    profile_model: profileModel,
    // 参数指纹：比较两份数据是否同一套阈值，不需要 diff 整份 params
    params_hash: paramsHash(activeParams),
    params: activeParams,
    frame_count: frameLog.length,
  };
}

function downloadBlob(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** 分块生成 JSONL：20000 帧整份 stringify 会造成 40MB 字符串与主线程卡顿 */
function downloadJsonl(filename, meta, frames) {
  const CHUNK = 500;
  const parts = [`${JSON.stringify(meta)}\n`];
  for (let i = 0; i < frames.length; i += CHUNK) {
    let s = '';
    for (let j = i; j < Math.min(i + CHUNK, frames.length); j++) s += `${JSON.stringify(frames[j])}\n`;
    parts.push(s);
  }
  downloadBlob(filename, new Blob(parts, { type: 'application/x-ndjson' }));
}

function downloadJson(filename, obj) {
  downloadBlob(filename, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
}

function exportJSON() {
  if (!frameLog.length) {
    setStatus('没有可导出的帧', 'busy');
    return;
  }
  const span = frameLog.length > 1
    ? (frameLog[frameLog.length - 1].ts - frameLog[0].ts) / 1000
    : 0;
  downloadJsonl(`pose-frames-${Date.now()}.jsonl`,
    { ...baseExportMeta(), frame_count: frameLog.length }, frameLog);
  setStatus(`已导出 ${frameLog.length} 帧 / ${span.toFixed(1)}s`, 'ok');
}

// —— 难例闭环（R6）--------------------------------------------------------
// 点「判错了」→ 保留点击前 3s + 之后 2s 的帧，导出 JSONL + 草稿 label。
// 只导出帧不导出视频：可离线复现、体积小、不保存人像（PLAN §13.3 R6）。

let hardcasePending = null;

function initHardcaseSelect() {
  const sel = $('hardcaseSel');
  if (!sel || sel.options.length) return;
  const groups = new Map();
  for (const a of HARDCASE_ACTIONS) {
    if (!groups.has(a.group)) {
      const og = document.createElement('optgroup');
      og.label = a.group;
      sel.appendChild(og);
      groups.set(a.group, og);
    }
    const opt = document.createElement('option');
    opt.value = a.value;
    opt.textContent = a.label;
    groups.get(a.group).appendChild(opt);
  }
  sel.value = 'none';
}

function resetHardcaseButton() {
  const btn = $('btnHardcase');
  if (btn) { btn.disabled = false; btn.textContent = '判错了'; }
}

/**
 * 难例窗口的锚点。
 *
 * 默认就是点击时刻。但单次播放结束后帧不再增加，而窗口是 [点击−3s, 点击+2s]：
 * 播放结束 3 秒后再点「判错了」，窗口里一帧都没有，只能报「难例窗口内没有帧」。
 * 这时锚到最后记录的那帧，导出刚播完的一段——反例仍然落在它真正发生的时间上。
 * 返回 { ts, tail, ended }：
 *   tail=true 表示锚到了最后记录帧（不一定是播放结束——暂停、后台标签页停推理也会）；
 *   ended 只表示媒体真的播完了，用来决定提示语，不参与锚点选择。
 */
function hardcaseAnchorTs() {
  const now = performance.now();
  const last = frameLog[frameLog.length - 1];
  const ended = videoEl.ended
    || (Number.isFinite(videoEl.duration) && videoEl.currentTime >= videoEl.duration - 0.05);
  if (!last || now - last.ts <= HARDCASE_BEFORE_MS) return { ts: now, tail: false, ended };
  return { ts: last.ts, tail: true, ended };
}

function startHardcase() {
  if (hardcasePending) {
    setStatus('难例采样中，请稍候…', 'busy');
    return;
  }
  if (!frameLog.length) {
    setStatus('没有可导出的帧', 'busy');
    return;
  }
  const sel = $('hardcaseSel');
  const action = sel && sel.value ? sel.value : 'none';
  const last = frameLog[frameLog.length - 1];
  const detected = last && last.actions ? {
    posture: last.actions.posture,
    flags: last.actions.flags,
    reps: last.actions.reps,
  } : null;
  const anchor = hardcaseAnchorTs();
  hardcasePending = {
    clickTs: anchor.ts,
    clickedAt: performance.now(),
    tail: anchor.tail,
    videoEnded: anchor.ended,
    action,
    detected,
    timer: setTimeout(finishHardcase, HARDCASE_AFTER_MS),
  };
  const btn = $('btnHardcase');
  if (btn) { btn.disabled = true; btn.textContent = '采样中…'; }
  setStatus(`难例采样中（还需 ${(HARDCASE_AFTER_MS / 1000).toFixed(0)}s）…`, 'busy');
}

function finishHardcase() {
  const p = hardcasePending;
  if (!p) return;
  hardcasePending = null;
  resetHardcaseButton();
  const { frames, labels, meta } = buildHardcase(frameLog, p.clickTs, {
    action: p.action,
    detected: p.detected,
    baseMeta: baseExportMeta(),
    anchoredFrom: p.tail ? p.clickedAt : null,
    ended: p.videoEnded,
  });
  if (!frames.length) {
    setStatus('难例窗口内没有帧', 'busy');
    return;
  }
  const base = `hardcase-${Date.now()}`;
  downloadJsonl(`${base}.jsonl`, meta, frames);
  downloadJson(`${base}.labels.json`, labels);
  // 反例读起来别像正例：「期望「!onHips」」会被误解；动作名按下拉里的中文回显
  const expect = p.action === 'none' ? '不应出现（none）'
    : p.action === 'noArm' ? '不应出现任何手臂动作'
      : p.action.startsWith('!') ? `不应出现「${hardcaseActionName(p.action.slice(1))}」`
        : `期望「${hardcaseActionName(p.action)}」`;
  // 锚到尾部时要说清楚，否则用户会以为导出的是点击那一刻；
  // 只有媒体真的播完才说「视频已结束」，暂停/后台停推理时只说说锚到了最后记录帧
  const tail = p.tail
    ? (p.videoEnded ? '（视频已结束，导出最后一段）' : '（窗口锚到最后记录帧）')
    : '';
  setStatus(`已导出难例 ${frames.length} 帧 · ${expect}${tail}`, 'ok');
}

function cancelHardcase() {
  if (!hardcasePending) return;
  clearTimeout(hardcasePending.timer);
  hardcasePending = null;
  resetHardcaseButton();
}

/** 难例动作的中文名：下拉里选的是中文，状态栏回显也应该用中文，而不是裸 flag。 */
function hardcaseActionName(id) {
  const hit = ARM_ACTIONS.find((a) => a.flag === id)
    || ACTION_CATALOG.find((a) => a.id === id)
    || REP_ACTIONS.find((r) => r.id === id);
  return hit ? hit.name : id;
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

  g.font = '600 20px Bahnschrift, "DIN Alternate", Consolas, monospace';
  g.textBaseline = 'middle';
  for (const v of [60, 120, 180]) {
    const y = yOf(v);
    g.strokeStyle = 'rgba(27, 30, 25, .08)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, y); g.lineTo(W, y); g.stroke();
    g.fillStyle = '#6e746a';
    g.fillText(String(v), 2, y);
  }

  // 阈值线用琥珀色：与骨架的「中等置信」同一个语义色，不引入新颜色
  g.strokeStyle = 'rgba(168, 116, 26, .45)';
  g.setLineDash([6, 6]);
  for (const v of [squatCfg.down, squatCfg.up]) {
    if (!Number.isFinite(v)) continue;
    const y = yOf(v);
    g.beginPath(); g.moveTo(padL, y); g.lineTo(W, y); g.stroke();
  }
  g.setLineDash([]);

  if (sparkSamples.length < 2) return;

  const t0 = now - SPARK_SPAN_MS;
  const xOf = (t) => padL + ((t - t0) / SPARK_SPAN_MS) * (W - padL);

  g.strokeStyle = '#1b1e19';
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
    g.fillStyle = '#1b1e19';
    g.beginPath();
    g.arc(xOf(last[0]), yOf(last[1]), 4, 0, Math.PI * 2);
    g.fill();
  }
}

// —— 播放控制与输入状态 ------------------------------------------------

const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** 播放条/记录状态：只在文件模式显示；拖动进度时不要覆盖用户的滑块位置 */
function syncPlayer() {
  player.hidden = mode !== 'file';
  const switchBtn = $('btnSwitchCam');
  if (switchBtn) switchBtn.hidden = mode !== 'camera' || !cameraCanSwitch();
  if (mode !== 'file') return;

  const dur = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  const cur = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
  const playBtn = $('btnPlay');
  playBtn.textContent = videoEl.paused ? '▶' : '❚❚';
  playBtn.title = videoEl.paused ? '播放' : '暂停';
  if (!seeking) seek.value = dur > 0 ? String(Math.round((cur / dur) * 1000)) : '0';
  $('time').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;

  const rec = $('recState');
  rec.textContent = videoWrapDetected ? '记录已停止' : '记录中';
  rec.classList.toggle('stopped', videoWrapDetected);
  rec.title = videoWrapDetected
    ? '时间回退（循环/拖动）后已停止记录；点 ↺ 清空记录并从头播放'
    : '这一遍播放的每一帧都会写入导出记录';
}

async function togglePlay() {
  if (mode !== 'file') return;
  try {
    if (videoEl.paused) await videoEl.play();
    else videoEl.pause();
  } catch (e) {
    setStatus(`播放被拒（${e.name}）`, 'err');
  }
  syncPlayer();
}

/** 清空记录并从头播放：同时清掉回绕标记，让记录重新开始 */
function replayVideo() {
  if (mode !== 'file') return;
  resetRuntime();
  try { videoEl.currentTime = 0; } catch { /* metadata 还没就绪 */ }
  videoEl.play().catch((e) => setStatus(`播放被拒（${e.name}）`, 'err'));
  setStatus('已清空记录，从头播放', 'busy');
  syncPlayer();
}

function clearLog() {
  if (!frameLog.length && !sparkSamples.length) {
    setStatus('没有可清空的记录', 'busy');
    return;
  }
  resetRuntime();
  setStatus('已清空记录（计数与曲线一起重置）', 'ok');
}

function resetPlaceholder() {
  const p = placeholder.querySelector('p');
  const hint = placeholder.querySelector('.hint');
  if (p) p.textContent = '还没有输入画面';
  if (hint) hint.textContent = '点「摄像头」开始，或「上传视频」/拖入视频文件';
}

/** 输入失败：停循环、摘掉源、清空本次记录，回到空闲（状态栏保留具体错误） */
function failInput(message) {
  setStatus(message, 'err');
  stopLoop();
  videoEl.removeAttribute('src');
  videoEl.srcObject = null;
  mode = 'idle';
  lastResult = null;
  setActiveInput(null);
  resetPlaceholder();
  placeholder.hidden = false;
  resetRuntime();
}

function updateModelInfo() {
  const el = $('modelInfo');
  if (!el) return;
  // 停止后模型已释放（estimatorReady=false），但 activeModel 保留给导出元数据用
  el.textContent = estimatorReady && activeModel
    ? `${activeModel}/${activeDelegate || '?'}` : '—';
}

// —— UI -----------------------------------------------------------------

function renderReps(reps) {
  $('repSquat').textContent = reps.squat ?? 0;
  $('repPushup').textContent = reps.pushup ?? 0;
  $('repClap').textContent = reps.clap ?? 0;
  $('repGrasp').textContent = reps.grasp ?? 0;
}

function buildGrids() {
  $('postureChips').innerHTML = ACTION_CATALOG
    .map((a) => `<span class="chip" data-id="${a.id}">${a.name}</span>`)
    .join('');
  $('armGrid').innerHTML = ARM_ACTIONS
    .map((a) => `<div class="act" data-id="${a.id}"><span>${a.name}</span></div>`)
    .join('');
}

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
    if (el) el.classList.toggle('on', !!act?.flags?.[a.flag]);
  }

  // 手部：按 handedness 取（镜像只影响画面，不影响模型输出的左右手）
  const pick = (side) => (hands || []).find((h) => h.handedness === side);
  const hl = pick('Left');
  const hr = pick('Right');
  $('handL').textContent = hl ? hl.cls.label : '—';
  $('handR').textContent = hr ? hr.cls.label : '—';
  $('handLCard').classList.toggle('on', !!hl);
  $('handRCard').classList.toggle('on', !!hr);
  // 手掌侧对镜头时四指长度被压扁，手势不可靠 —— 明确提示，不要假装准
  const edge = (h) => !!(h && h.orient && h.orient.facing === 'edge');
  $('handLCard').classList.toggle('edge', edge(hl));
  $('handRCard').classList.toggle('edge', edge(hr));
  const orientText = (h) => (h ? `${h.orient.facing === 'front' ? '正面' : '侧对'}·张${h.spread}` : '—');
  $('handMeta').textContent = !show.hands ? '已关闭'
    : !handReady ? '模型未加载'
    : (hands && hands.length) ? `${hands.length} 只手 · ${orientText(hl || hr)}` : '未检出';

  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const rows = [
    ['膝角 °', sig ? r1(sig.knee_pick) : null],
    ['肘角 °', sig ? r1(sig.elbow_pick) : null],
    ['抬臂角 L/R', sig ? `${fmt(sig.armPose.elev_L, 0)} / ${fmt(sig.armPose.elev_R, 0)}` : null],
    // 3D 相对躯干的抬臂角：俯拍时以这一行为准（有 world 才显示数值）
    ['抬臂角3D L/R', sig ? `${fmt(sig.armPose.elev_torso_L, 0)} / ${fmt(sig.armPose.elev_torso_R, 0)}` : null],
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
  const recState = mode === 'idle' ? '未开始'
    : videoWrapDetected ? '记录已停止（时间回退）'
      : mode === 'camera' ? '记录中'
        : (videoEl.paused ? '已暂停' : '记录中');
  const dropped = logDropped ? ` · 已丢弃 ${logDropped} 帧（上限 ${MAX_LOG}）` : '';
  $('logInfo').textContent = frameLog.length
    ? `${frameLog.length} 帧 / ${span.toFixed(1)}s · ${recState}${dropped}`
    : (mode === 'idle' ? '—' : `0 帧 · ${recState}${dropped}`);
  $('logInfo').title = `profile=${profileName} · ${activeParamsHash} · 模型 ${activeModel ? `${activeModel}/${activeDelegate || '?'}` : '—'} · 上限 ${MAX_LOG} 帧`;

  // 无帧时导出/清空/难例都不该可点；难例采样中保持禁用直到 finishHardcase 复位
  $('btnExport').disabled = !frameLog.length;
  $('btnClearLog').disabled = !frameLog.length;
  $('btnHardcase').disabled = !frameLog.length || !!hardcasePending;

  // 曲线图例已有数值，这里给悬停说明当前门限与参数指纹
  $('signalMeta').title = `深蹲门限 下阈 ${squatCfg.down}° / 上阈 ${squatCfg.up}° · ${activeParamsHash}`;

  syncPlayer();
  drawSpark(performance.now());
}

// —— 事件绑定 -----------------------------------------------------------

buildGrids();

function hasFileDrag(e) {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}

function isVideoFile(file) {
  return !!file && ((file.type && file.type.startsWith('video/'))
    || /\.(mp4|webm|mov|m4v|ogv|ogg)$/i.test(file.name || ''));
}

$('btnCamera').addEventListener('click', () => startCamera());
$('btnSwitchCam').addEventListener('click', switchCamera);
$('btnStop').addEventListener('click', stopAll);
// 上传入口是真正的 button（键盘可达）；file input 只负责选择文件
$('btnUpload').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (ev) => {
  const f = ev.target.files?.[0];
  // 清空 value：否则连续选同一个文件不会再触发 change
  ev.target.value = '';
  if (f) await useVideoFile(f);
});

// 拖拽上传：整个画面区域都可以接收视频
stage.addEventListener('dragenter', (e) => {
  if (!hasFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  stage.classList.add('dragover');
});
stage.addEventListener('dragover', (e) => {
  if (!hasFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
stage.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) stage.classList.remove('dragover');
});
stage.addEventListener('drop', async (e) => {
  if (!hasFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  stage.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (!isVideoFile(file)) {
    setStatus('只支持视频文件', 'err');
    return;
  }
  await useVideoFile(file);
});
placeholder.addEventListener('click', () => $('fileInput').click());

// 播放条：视频事件 + 拖动进度（拖动时先暂停，松开后按原状态恢复）
for (const ev of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'durationchange', 'ended']) {
  videoEl.addEventListener(ev, syncPlayer);
}
$('btnPlay').addEventListener('click', togglePlay);
$('btnReplay').addEventListener('click', replayVideo);
$('chkLoop').addEventListener('change', () => {
  videoEl.loop = $('chkLoop').checked;
  saveSettings();
  syncPlayer();
});
seek.addEventListener('pointerdown', () => {
  if (mode !== 'file') return;
  seeking = true;
  resumeAfterSeek = !videoEl.paused;
  videoEl.pause();
});
seek.addEventListener('input', () => {
  if (mode !== 'file' || !Number.isFinite(videoEl.duration)) return;
  videoEl.currentTime = (Number(seek.value) / 1000) * videoEl.duration;
  syncPlayer();
});
const endSeek = () => {
  if (!seeking) return;
  seeking = false;
  syncPlayer();
  if (resumeAfterSeek) {
    resumeAfterSeek = false;
    videoEl.play().catch((e) => setStatus(`播放被拒（${e.name}）`, 'err'));
  }
};
seek.addEventListener('pointerup', endSeek);
seek.addEventListener('pointercancel', endSeek);
seek.addEventListener('change', endSeek);

$('modelSel').addEventListener('change', () => {
  saveSettings();
  if (mode !== 'idle') initEstimator();
});
$('delegateSel').addEventListener('change', () => {
  saveSettings();
  if (mode !== 'idle') initEstimator();
});
$('fpsCapSel').addEventListener('change', () => { lastInferTs = 0; saveSettings(); });
$('profileSel').addEventListener('change', (e) => switchProfile(e.target.value));
$('chkSkeleton').addEventListener('change', (e) => {
  show.skeleton = e.target.checked;
  saveSettings();
});
$('chkHands').addEventListener('change', async (e) => {
  show.hands = e.target.checked;
  saveSettings();
  if (show.hands && !handsReady()) await initHands($('delegateSel').value);
  updateUI();
});
$('chkPoints').addEventListener('change', (e) => {
  show.points = e.target.checked;
  saveSettings();
});
$('chkMirror').addEventListener('change', (e) => {
  show.mirror = e.target.checked;
  stage.classList.toggle('mirror', show.mirror);
  saveSettings();
});
$('btnReset').addEventListener('click', () => {
  actionEngine.reset();
  renderReps({ squat: 0, pushup: 0, clap: 0, grasp: 0 });
});
$('btnClearLog').addEventListener('click', clearLog);
$('btnExport').addEventListener('click', exportJSON);
$('btnHardcase').addEventListener('click', startHardcase);
initHardcaseSelect();
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
  // 难例闭环：返回摘要而不是整份帧，避免 CDP 传输大对象
  hardcaseInfo(action = 'none') {
    const last = frameLog[frameLog.length - 1];
    const detected = last && last.actions ? {
      posture: last.actions.posture,
      flags: last.actions.flags,
      reps: last.actions.reps,
    } : null;
    const r = buildHardcase(frameLog, hardcaseAnchorTs().ts, { action, detected });
    return {
      frames: r.frames.length,
      frameCount: r.meta.frame_count,
      segments: r.labels.segments,
      hardcase: r.meta.hardcase,
    };
  },
};

// 懒加载：页面打开不建模型，点「摄像头」或「上传视频」时才加载（省内存，多开标签页也不炸）
setStatus('待启动 · 点摄像头或上传视频', '');
// profile 先就绪再允许输入：参数变过之后记录才属于同一套阈值
profileReady = initProfile().catch((e) => {
  setStatus(`profile 初始化失败：${e.message}`, 'err');
});
profileReady.then(() => { if (autoSrc) ensureEstimator(); });
