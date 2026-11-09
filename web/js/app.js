// app.js — 组装层：输入源 → 感知（姿态 + 手部）→ 信号 → 动作 → 可视化/导出
import {
  createEstimator, detectVideo, toPersons, closeEstimator,
  createMultiEstimator, detectMultiImage, detectMultiTiled, closeMultiEstimator, multiEstimatorInfo,
} from './pose.js';
import { createHandEstimator, detectHandsVideo, detectHandsNearWrists, toHands, handsReady, closeHandEstimator } from './hands.js';
import { wristsToRetry } from './handroi.js';
import { SignalEngine } from './signals.js';
import { ActionEngine, ACTION_CATALOG, ARM_ACTIONS, REP_ACTIONS } from './actions.js';
import { explainArmActions, DEFAULT_HINT } from './armhint.js';
import { loadAccuracyReport, accuracyFor, formatAccuracy, accuracyStale } from './accuracy.js';
import { resolveParams, profileParams, profileName as profileNameOf, paramsHash } from './params.js';
import { buildHardcase, HARDCASE_ACTIONS, HARDCASE_AFTER_MS, HARDCASE_BEFORE_MS } from './hardcase.js';
import { drawSkeleton, drawHand, drawBoxes, drawTrackLabel, clearCanvas } from './draw.js';
import { Tracker, area } from './track.js';
import {
  PersonPipelines, assignHands, logLimitFor,
  TrackShapeStabilizers, classifyHandsByTrack, bindClassifiedHands, pickRoiPersons,
} from './multi.js';
import { PpeMonitor } from './ppe.js';
import {
  createObjectDetector, detectObjects, closeObjectDetector, objectInfo,
} from './objects.js';


const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const videoEl = $('video');
const photoEl = $('photo');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const placeholder = $('placeholder');
const player = $('player');
const seek = $('seek');

const SETTINGS_KEY = 'pose-demo.settings.v1';
const CUSTOM_PROFILE = '__custom__';
// profile 下拉的固定项；自定义 URL 通过 ?profile= 或上次选择恢复
const PROFILES = [
  { id: 'default', label: '默认阈值', url: null },
  { id: 'fitness', label: '健身', url: '/web/profiles/fitness.json' },
  // 工业/安全场景：多人 + 物体检测 + PPE。开关本身也写在 profile 里，
  // 所以换到这个档不用再手动勾「多人」「物体」。
  { id: 'safety', label: '安全合规', url: '/web/profiles/safety.json' },
];

// 帧数上限按导出模式取：单人 20000（整段素材，截断会让 recall 失真），
// 多人 6000（每帧含全部 persons 的关键点，体积随人数线性增长；PLAN §18.5 D3）。
// 模式在运行时切换（工具栏），所以上限要动态取，不能只算一次。
const exportMulti = () => multiOn && multiReady;
// 本段记录使用的导出模式：录制期间只升不降，Stop 释放模型后不再跟着变。
// 否则「多人录完 → 停止 → 导出」会把实际按 6000 截断的帧标成单人 20000，
// 评估器据此判断「帧被截断是否正常」时就会误判。
let logMode = 'single';
const logLimit = () => logLimitFor(logMode === 'multi');
// 溢出时按块丢弃（一次 splice 掉上限的 10%），而不是每帧 shift()。
// shift() 在 20000 元素上是每帧 O(n) 的整体复制（实测 57~69 µs/帧），
// 从 600 提到 20000 时这个开销从"免费"变成了实打实的每帧成本。
const logTrim = () => Math.round(logLimit() * 0.1);

// 推理帧率上限：默认 30fps。摄像头 30fps + rAF 60Hz 会对同一帧反复推理，白烧 CPU/GPU；
// 但 15fps 在 25/30fps 素材上会丢掉约一半帧（ID 切换被放大，见 docs/multi-and-objects.md）。
// 实测本机 full/GPU + 多人 3 + 手部：15fps 上限 → 处理 13.6 帧/s；30fps 上限 → 26 帧/s。
// 弱机达不到上限时会自然回落到推理速度，不需要手动降档。
const inferInterval = () => 1000 / (Number($('fpsCapSel').value) || 30);

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
// 手部模型是否在本会话里成功加载过。停止/切换输入后 handReady 会变成 false，
// 但已记录的帧仍是用它产出的，导出 meta 必须保留这个信息（同 activeModel 的理由）。
let activeHandModel = null;
// 每人一条判定流水线：SignalEngine / ActionEngine 里全是有记忆的部件（滤波、滞回、计数相位），
// 两个人共用一套会互相打断。单人道仍然只有一条（track_id 固定 0），行为与以前一致。
let pipelines = new PersonPipelines(activeParams);
let tracker = new Tracker(resolveParams(activeParams).signals.track);
let ppeMonitor = new PpeMonitor(resolveParams(activeParams).signals.ppe);
// 多人感知参数（平铺检测的块数等）；换 profile 时同步，逐帧直接读
let multiCfg = resolveParams(activeParams).perception.multi;
let objectCfg = resolveParams(activeParams).perception.objects;
let lastObjectTs = 0;   // 物体检测的最小间隔门控（见 params.objects.intervalMs）
let multiNumPoses = 3;
// 感知层开关：默认关，保持"单人 + 无物体检测"的原行为（多开两个模型很吃 GPU）
let multiOn = false;
let objectOn = false;
let objectReady = false;
let multiReady = false;
let multiCfgKey = '';   // 建多人估计器时用的 numPoses|detConf|presenceConf，profile 变了要重建
let objectError = null;
let multiError = null;
let objectBusy = false;   // ONNX 后端同一时刻只允许一帧在推理（见 loop()）
let objectGen = 0;        // 物体检测器代次：换 profile/关开关时 +1，作废在途的创建与推理
let replaySeq = 0;        // 重播代次：快速连点时只让最后一次的 seek→play 生效
let profileLoaded = false;   // initProfile() 完成（无头脚本等它再改开关，避免抢跑用默认参数建模型）
let multiMaxFromSettings = false;   // 用户保存过多人数选择后，profile 不再覆盖它

// 每帧各阶段的耗时（EMA，毫秒）：吞吐优化不能靠猜，state.timing 暴露给无头脚本。
const stageMs = { pose: 0, hands: 0, objects: 0, draw: 0, total: 0, n: 0 };
const ema = (old, v) => old + (v - old) * 0.15;
let lastObjects = [];
let lastVerdicts = [];


// 手势稳定器：**按 track_id 各一套** L/R/U。streak 是连续命中计数，全局一套时
// A 的手势会推着 B 的状态走（PLAN §16.3 R12-2）；单人道固定用 track 0，行为不变。
// streak/keepMs 从 params 读，profile 才能调。
function makeShapeStable(params) {
  return new TrackShapeStabilizers(resolveParams(params).signals.gesture);
}
let shapeStable = makeShapeStable(activeParams);

/** 换参数要重建引擎：滤波器和计数器持有状态，只改字段会让它们停在上一次的参数上 */
function applyParams(params, name = 'default') {
  activeParams = params || {};
  profileName = name;
  const resolved = resolveParams(activeParams);
  // 换参数必须重建：滤波器和计数器持有状态，只改字段会让它们停在上一次的参数上
  pipelines = new PersonPipelines(activeParams);
  tracker = new Tracker(resolved.signals.track);
  ppeMonitor = new PpeMonitor(resolved.signals.ppe);
  multiCfg = resolved.perception.multi;
  objectCfg = resolved.perception.objects;
  shapeStable = makeShapeStable(activeParams);
  activeParamsHash = paramsHash(activeParams);
  // 场景档可以声明"这个场景需要多人/物体检测"：profile 里写 perception.multi.enabled
  // 就直接把开关带上，否则每一次换场景都要人工记得勾两个复选框。
  //
  // 必须看**原始 profile**，不能看 resolveParams() 的结果：resolveParams 会把默认值
  // 补进 perception.multi.enabled=false，于是任何 profile（包括启动时加载的默认档）
  // 都会把用户上次保存的开关静默关掉。
  const declared = activeParams.perception || {};
  if (typeof declared.multi?.enabled === 'boolean') multiOn = declared.multi.enabled;
  if (typeof declared.objects?.enabled === 'boolean') objectOn = declared.objects.enabled;
  if (objectOn) lastObjectTs = 0;
  // 换 profile 可能换物体后端/模型（mediapipe ↔ onnx）：旧实例必须重建，否则
  // objectReady 还是 true，ensureObjectDetector 会直接返回旧后端（和 maxPersons 同类的坑）。
  // 不管新旧 profile 是否开物体检测都作废旧实例：profile 可能把 objects 从开改成关，
  // 旧实例留着会让下次勾选直接复用旧后端/旧标签（ensureObjectDetector 看到 ready 就返回）。
  invalidateObjectDetector();
  if (objectOn && mode !== 'idle') ensureObjectDetector().catch(() => {});
  // profile 里的 maxPersons 之前完全没生效：ensureMultiEstimator 直接读工具栏 select，
  // 而 select 固定默认 3，profile 写 4 也跑 3（MOT17 A/B 因此白跑）。这里在没有
  // 用户保存过选择时，用 profile 的值初始化 select；有保存值时以用户选择为准。
  const wantMax = Number(declared.multi?.maxPersons) || 0;
  if (wantMax && !multiMaxFromSettings) {
    const el = $('multiSel');
    const v = String(Math.min(4, Math.max(1, wantMax)));
    if ([...el.options].some((o) => o.value === v)) el.value = v;
  }
  // numPoses/detConf/presenceConf 是建模型时固化的：profile 改了这些值，估计器必须重建，
  // 否则界面上显示新 profile，多人推理还在用旧的人数上限/检测阈值。
  if (multiOn && multiReady && multiCfgKey && desiredMultiKey() !== multiCfgKey) {
    closeMultiEstimator();
    multiReady = false;
    multiCfgKey = '';
    if (mode !== 'idle') ensureMultiEstimator().catch(() => {});
  }
  $('chkMulti').checked = multiOn;
  $('chkObjects').checked = objectOn;
  $('multiSel').hidden = !multiOn;
  handRoiCfg = resolved.signals.hand.roi;
  handVisMin = resolved.signals.visMin;
  resetRuntime();
  // 阈值变了，准确率报告可能过期：重算提示文案里的参数指纹比对
  refreshAccuracy();
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

let estimatorReady = false;
let handReady = false;
// 动作准确率：只来自标注数据上的评估报告（web/accuracy.json，npm run accuracy 生成）。
// 没有报告时 accuracyById 全是「未评估」——不拿规则自估冒充实测值。
let accuracyReport = null;
let accuracyById = {};
let mode = 'idle';
let rafId = null;
let lastVideoTime = -1;
let lastInferTs = 0;
let lastUiTs = 0;
let lastResult = null;
let frameLog = [];
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
// 腕部 ROI 补检参数：每帧都要用，不能在主循环里 deepMerge 一次参数树
let handRoiCfg = resolveParams({}).signals.hand.roi;
let handVisMin = resolveParams({}).signals.visMin;
let logDropped = 0;             // 超过当前模式上限被裁掉的帧数（会话摘要要如实显示）
let seeking = false;            // 正在拖进度条：syncPlayer 不要覆盖用户拖动
let resumeAfterSeek = false;
let dragDepth = 0;
let profileReady = Promise.resolve(); // 启动时 profile 加载完成前不要开始输入
// 输入代次：摄像头/视频/图片的启动都要等模型或首帧，多个 await 之间用户可能已经换了输入。
// 每个入口先领一个 token，await 回来发现不是最新的一代就放弃——否则旧任务会覆盖新源，
// 或者旧任务的失败分支把刚加载好的新源一起清掉。
let inputSeq = 0;

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
      multi: $('chkMulti').checked,
      multiMax: $('multiSel').value,
      objects: $('chkObjects').checked,
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
  // 多人/物体：模型是懒加载的，这里只恢复开关状态，真正的实例在第一次推理前建
  if (typeof s.multi === 'boolean') multiOn = s.multi;
  if (typeof s.objects === 'boolean') objectOn = s.objects;
  if (s.multiMax) {
    const el = $('multiSel');
    if ([...el.options].some((o) => o.value === String(s.multiMax))) {
      el.value = String(s.multiMax);
      multiMaxFromSettings = true;
    }
  }
  $('chkMulti').checked = multiOn;
  $('chkObjects').checked = objectOn;
  $('multiSel').hidden = !multiOn;
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
          // ?src= 也可以指向图片（用于自检 / 分享单张素材）
          if (/\.(jpe?g|png|webp|gif|bmp|avif)(\?|$)/i.test(autoSrc)) useImageSource(autoSrc);
          else useVideoSource(autoSrc, { loop: $('chkLoop').checked });
        }
        return true;
      } catch (e) {
        lastErr = e;
      }
    }
    // 不把 activeModel 清空：已经录下的帧仍属于上一档模型，导出的 meta 要如实写。
    // 工具条显示由 updateModelInfo() 依据 estimatorReady 决定。
    updateModelInfo();
    // 新增模型档位时最容易踩的坑：models/ 里没有对应 .task（不进 git）。
    // 错误信息里直接给出补救命令，别让用户对着 404 猜。
    setStatus(`模型加载失败：${lastErr?.message || 'unknown'} · 先运行 scripts/fetch-assets.py`, 'err');
    return false;
  } finally {
    modelSel.disabled = false;
    delegateSel.disabled = false;
  }
}

// 手部初始化做串行化：快速开关「手部」会并发两次 createHandEstimator，
// 两边都看到槽位为空、各建一个实例，后一个覆盖前一个，前一个的显存就泄漏了。
let handsInitPromise = null;

async function initHands(delegate) {
  if (handsInitPromise) return handsInitPromise;
  handsInitPromise = doInitHands(delegate).finally(() => { handsInitPromise = null; });
  return handsInitPromise;
}

async function doInitHands(delegate) {
  handReady = false;
  if (!show.hands) {
    // 手部关闭时要真的把实例放掉，否则换模型后旧的 VIDEO/IMAGE 实例仍各占一份显存。
    closeHandEstimator();
    return;
  }
  for (const d of delegate === 'GPU' ? ['GPU', 'CPU'] : ['CPU']) {
    try {
      await createHandEstimator({ delegate: d, runningMode: 'VIDEO', numHands: 2 });
      // 建模型期间用户可能已经关掉手部（或又换了输入）：关掉就释放，别留下实例。
      if (!show.hands) { closeHandEstimator(); return; }
      handReady = true;
      activeHandModel = 'hand_landmarker';
      // ROI 补检需要独立的 IMAGE 实例（VIDEO 实例用于整帧追踪，混用会把裁图当成下一帧）。
      // 建不起来不致命：退回纯整帧检测，只是远景手部动作会漏。
      try {
        await createHandEstimator({
          delegate: d, runningMode: 'IMAGE', numHands: 1,
          detConf: 0.3, presenceConf: 0.3,
        });
      } catch { /* ROI 补检不可用 */ }
      if (!show.hands) { closeHandEstimator(); return; }
      handReady = handsReady('VIDEO');
      return;
    } catch { /* 手部模型失败不影响主体识别 */ }
  }
}

// —— 感知层开关：多人 / 物体检测 -------------------------------------------
// 懒加载，理由同姿态模型：页面一打开就建 GPU 上下文，多开几个标签页很吃内存。

let multiInitPromise = null;
/** 当前参数/工具栏下，多人估计器应有的配置指纹。profile 切换后与 multiCfgKey 比对。 */
function desiredMultiKey() {
  const cfg = resolveParams(activeParams).perception.multi;
  const numPoses = Math.max(1, Math.min(4, Number($('multiSel')?.value) || cfg.maxPersons));
  return `${numPoses}|${cfg.detConf}|${cfg.presenceConf}`;
}

async function ensureMultiEstimator() {
  if (multiReady) return true;
  if (multiInitPromise) return multiInitPromise;
  multiInitPromise = (async () => {
    const model = $('modelSel').value;
    const want = $('delegateSel').value;
    const cfg = resolveParams(activeParams).perception.multi;
    const numPoses = Number($('multiSel')?.value) || cfg.maxPersons;
    multiNumPoses = Math.max(1, Math.min(4, numPoses | 0));
    for (const delegate of (want === 'GPU' ? ['GPU', 'CPU'] : ['CPU'])) {
      try {
        await createMultiEstimator({
          model, delegate, numPoses,
          detConf: cfg.detConf, presenceConf: cfg.presenceConf,
        });
        multiReady = multiEstimatorInfo().ready;
        if (multiReady) {
          multiCfgKey = `${multiNumPoses}|${cfg.detConf}|${cfg.presenceConf}`;
          multiError = null;
          return true;
        }
      } catch (e) {
        multiError = e.message;
      }
    }
    setStatus(`多人模型加载失败：${multiError || 'unknown'}`, 'err');
    return false;
  })().finally(() => { multiInitPromise = null; });
  return multiInitPromise;
}

let objectInitPromise = null;

/** 关掉物体检测并作废所有在途操作（创建/推理）。换 profile、关开关、换 delegate 都走这里。 */
function invalidateObjectDetector() {
  objectGen++;
  closeObjectDetector();
  objectReady = false;
  objectBusy = false;
  objectError = null;   // 旧配置的失败信息不要挂到新配置上
  lastObjects = [];     // 旧检测框不能留到新后端/新 profile 里
}

async function ensureObjectDetector() {
  if (objectReady) return true;
  if (objectInitPromise) return objectInitPromise;
  const gen = objectGen;
  objectInitPromise = (async () => {
    const cfg = resolveParams(activeParams).perception.objects;
    // 用 profile 声明的 delegate，不跟工具栏的 GPU/CPU：物体检测模型对 GPU delegate 敏感，
    // 不支持时会 trap 掉整个 wasm 运行时（连带姿态/手部一起挂），必须由模型自己声明。
    try {
      await createObjectDetector({
        backend: cfg.backend,
        model: cfg.model, delegate: cfg.delegate,
        maxResults: cfg.maxResults, scoreThreshold: cfg.scoreThreshold,
        labels: cfg.labels, inputSize: cfg.inputSize, iouThreshold: cfg.iouThreshold,
        requireManifest: cfg.requireManifest,
        runningMode: 'VIDEO',
      });
      if (gen !== objectGen) {
        // 创建期间 profile/开关变了：这是旧配置的实例，关掉；返回 'superseded' 而不是 false，
        // 调用方不能把它当成"加载失败"去关掉新 profile 声明的物体检测。
        invalidateObjectDetector();
        return 'superseded';
      }
      objectReady = objectInfo().ready;
      if (objectReady) { objectError = null; return true; }
    } catch (e) {
      if (gen !== objectGen) return 'superseded';   // 旧代次的失败不影响新配置
      objectError = e.message;
    }
    setStatus(`物体检测不可用：${objectError || 'unknown'}`, 'err');
    return false;
  })().finally(() => { objectInitPromise = null; });
  return objectInitPromise;
}

function resetRuntime() {
  cancelHardcase();
  pipelines.reset();
  tracker.reset();
  ppeMonitor.reset();
  lastVerdicts = [];
  lastObjects = [];
  frameLog = [];
  lastVideoTime = -1;
  lastObjectTs = 0;
  for (const k of Object.keys(stageMs)) stageMs[k] = 0;
  lastLogVideoTime = -1;
  videoWrapDetected = false;
  logDropped = 0;
  seeking = false;
  resumeAfterSeek = false;
  lastInferTs = 0;
  handFails = 0;
  // 新的一段记录：按当前判定路径定模式（之后只升不降，见 logMode 的说明）
  logMode = exportMulti() ? 'multi' : 'single';
  shapeStable.reset();
  // 引擎和计数都重置了，上一帧的判定结果就不再属于这套参数/输入：
  // 不清掉的话，暂停中的视频或切换 profile 后面板会继续显示旧结论。
  lastResult = null;
  renderReps({ clap: 0, grasp: 0 });
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
  const token = ++inputSeq;
  // 用户显式点了摄像头：不要再让 ?src= 的自动素材在模型就绪后反过来顶掉摄像头。
  if (autoSrc) autoLoaded = true;
  try {
    await profileReady;
    if (token !== inputSeq) return;
    stopStream();
    setStatus('摄像头启动中…', 'busy');
    btn.disabled = true;
    if (!(await ensureEstimator())) {
      if (token !== inputSeq) return;
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
    // 等权限/设备期间用户可能已经改选了视频或图片：新输入优先，别把它顶掉。
    if (token !== inputSeq) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    // 摄像头真的起来了才清掉图片：失败时原来的画面还在
    clearPhoto();
    currentStream = stream;
    // 摘掉上一次文件源的 src（可能是已 revoke 的 blob），否则 srcObject 结束后
    // 元素可能又去加载那个失效地址。
    videoEl.removeAttribute('src');
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
    // 已有更新的输入在启动：这次失败与新输入无关，不要把新输入的状态清掉。
    if (token !== inputSeq) return;
    // 摄像头没起来、文件源一点没动：保持原视频和已录帧，只报错。
    // （之前这里无条件 resetRuntime()，会把用户已录的一段数据清空）
    const keepCurrent = !assigned && ((prevMode === 'file' && videoEl.getAttribute('src'))
      || (prevMode === 'image' && !photoEl.hidden));
    if (keepCurrent) {
      setStatus(`摄像头不可用（${e.name}），原画面继续`, 'err');
      syncPlayer();
    } else {
      clearPhoto();
      placeholder.hidden = false;
      placeholder.querySelector('p').textContent = `摄像头不可用（${e.name}）`;
      placeholder.querySelector('.hint').textContent = '检查浏览器权限后点「摄像头」重试';
      setStatus('摄像头不可用', 'err');
      setActiveInput(null);
      mode = 'idle';
      // 已经拿到的流必须在这里停掉：play() 失败/权限中途变化时若不 stopStream，
      // 摄像头指示灯会一直亮着，直到下一次操作。
      stopStream();
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
  const token = ++inputSeq;
  // 显式输入优先于 ?src= 的自动加载：手动选了视频后，别再让自动素材在模型就绪时顶掉它。
  autoLoaded = true;
  const stale = () => token !== inputSeq;
  await profileReady;
  if (stale()) {
    if (revoke) URL.revokeObjectURL(revoke);   // 还没挂到 video 上，直接释放
    return false;
  }
  stopStream();
  if (!(await ensureEstimator())) {
    if (stale()) {
      if (revoke) URL.revokeObjectURL(revoke);
      return false;
    }
    // 模型起不来时，正在播的原文件 / 正在看的图片别跟着一起清掉
    if ((mode === 'file' && videoEl.getAttribute('src')) || (mode === 'image' && !photoEl.hidden)) {
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
  if (stale()) {
    if (revoke) URL.revokeObjectURL(revoke);
    return false;
  }
  videoEl.srcObject = null;
  if (revoke) {
    videoEl.addEventListener('loadstart', () => setTimeout(() => URL.revokeObjectURL(revoke), 5000), { once: true });
  }
  videoEl.src = src;
  videoEl.loop = loop;
  // 出错回调也绑定到这一代输入：旧源的 error 不能清掉用户刚选中的新源。
  videoEl.onerror = () => {
    if (!stale()) failInput(`视频无法解码（code ${videoEl.error?.code ?? '?'}）`);
  };

  // 必须先等元数据/首帧就绪再 play()，否则部分环境下 play() 会被 abort
  try {
    await waitForVideoReady(videoEl);
  } catch (e) {
    if (!stale()) failInput(`视频加载失败：${e.message}`);
    return false;
  }
  if (stale()) { if (revoke) URL.revokeObjectURL(revoke); return false; }
  try {
    await videoEl.play();
  } catch (e) {
    if (!stale()) failInput(`视频播放被拒（${e.name}）`);
    return false;
  }
  if (stale()) return false;
  // 视频已经能播了再撤掉图片，加载失败时保持原画面
  clearPhoto();
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
  if (token === inputSeq && rafId !== null && warmed) setStatus('就绪 · 视频文件', 'ok');
  return token === inputSeq;
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

// —— 图片输入 -------------------------------------------------------------
// 单张图片没有时间窗，而姿态/手臂判定里的 Hold、streak 都要求「持续了多久」。
// 只判一帧会全部输出 false（看起来像「识别不出来」）。这里把同一帧在信号层/动作层
// 重复喂 12 次（合成 100ms 步长）让它们收敛，再显示结果。
// 需要运动的动作（挥手、鼓掌/拿取计数）在单张图上本来就不适用，不会凭空出现。
const STILL_SETTLE_FRAMES = 12;
let photoUrl = null;

function isImageFile(f) {
  if (!f) return false;
  if (f.type) return f.type.startsWith('image/');
  return /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name || '');
}

/** 退出图片模式：隐藏并释放图片 URL，视频元素恢复显示 */
function clearPhoto() {
  photoEl.hidden = true;
  photoEl.removeAttribute('src');
  videoEl.hidden = false;
  if (photoUrl) {
    URL.revokeObjectURL(photoUrl);
    photoUrl = null;
  }
}

/**
 * 手势分类 + 去抖：实时与静态两条路径共用。
 * **必须在 assignHands() 之后调用**（顺序反了就会用错人的稳定器，见 PLAN §16.3 R12-2）。
 * 单人道 ownerOf 恒为 0（与旧版全局一套稳定器逐位一致）；多人的未归属手不做去抖——
 * 它们不进任何人的动作层，只是整帧绘制/导出用。
 */
function classifyAndBind(rawHands, ts, assigned, single) {
  const ownerByHand = new Map();
  for (const [trackId, slot] of assigned) {
    for (const hd of slot.list || []) ownerByHand.set(hd, trackId);
  }
  const ownerOf = single
    ? () => 0
    : (hd) => (ownerByHand.has(hd) ? ownerByHand.get(hd) : null);
  const cls = classifyHandsByTrack(rawHands, ts, shapeStable, ownerOf);
  return { hands: cls.list, handsByTrack: bindClassifiedHands(assigned, cls.byOriginal) };
}

/**
 * 轻量外观描述子（跟踪用）：bbox 中部 2×2 网格的色相直方图 + 灰色格。
 * 不跑深度学习 ReID——只给轨迹匹配加一个小权重，并用于"丢失后颜色高度相似"的重连。
 * 16×32 采样 + 52 维，单帧 ≤3 人，开销可忽略。
 */
const descCanvas = document.createElement('canvas');
const descCtx = descCanvas.getContext('2d', { willReadFrequently: true });
const DESC_W = 16;
const DESC_H = 32;
const DESC_BINS = 12;

function appearanceDescriptor(source, person) {
  const W = source.videoWidth || source.naturalWidth || 0;
  const H = source.videoHeight || source.naturalHeight || 0;
  if (!W || !H || !person) return null;
  const bbox = person.bbox;
  if (!Array.isArray(bbox)) return null;

  // 优先用肩/髋围出的躯干框：bbox 会混入头部背景、腿和地面，躯干颜色更稳定。
  const kp = person.kp || [];
  const torso = [kp[1], kp[2], kp[7], kp[8]].filter((p) => p && p[2] >= 0.25);
  let sx;
  let sy;
  let sw;
  let sh;
  if (torso.length >= 3) {
    const xs = torso.map((p) => p[0]);
    const ys = torso.map((p) => p[1]);
    const x1 = Math.min(...xs);
    const x2 = Math.max(...xs);
    const y1 = Math.min(...ys);
    const y2 = Math.max(...ys);
    const padX = (x2 - x1) * 0.15;
    const padY = (y2 - y1) * 0.10;
    sx = Math.floor(x1 - padX);
    sy = Math.floor(y1 - padY);
    sw = Math.ceil(x2 - x1 + padX * 2);
    sh = Math.ceil(y2 - y1 + padY * 2);
  } else {
    // 躯干点不可见：退回 bbox 中部（去掉头/脚）
    const bw = bbox[2] - bbox[0];
    const bh = bbox[3] - bbox[1];
    sx = Math.floor(bbox[0]);
    sy = Math.floor(bbox[1] + 0.20 * bh);
    sw = Math.floor(bw);
    sh = Math.floor(bh * 0.55);
  }
  if (!(sw >= 6 && sh >= 6)) return null;
  sx = Math.max(0, Math.min(W - 1, sx));
  sy = Math.max(0, Math.min(H - 1, sy));
  sw = Math.min(W - sx, sw);
  sh = Math.min(H - sy, sh);
  if (sw < 4 || sh < 4) return null;

  descCanvas.width = DESC_W;
  descCanvas.height = DESC_H;
  let px;
  try {
    descCtx.drawImage(source, sx, sy, sw, sh, 0, 0, DESC_W, DESC_H);
    px = descCtx.getImageData(0, 0, DESC_W, DESC_H).data;
  } catch {
    return null;
  }

  const out = new Float32Array(4 * (DESC_BINS + 1));
  const halfW = DESC_W / 2;
  const halfH = DESC_H / 2;
  for (let y = 0; y < DESC_H; y++) {
    for (let x = 0; x < DESC_W; x++) {
      const i = (y * DESC_W + x) * 4;
      const r = px[i] / 255;
      const g = px[i + 1] / 255;
      const b = px[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      const s = max > 0 ? d / max : 0;
      let h = 0;
      if (d > 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      const cell = (y >= halfH ? 2 : 0) + (x >= halfW ? 1 : 0);
      const base = cell * (DESC_BINS + 1);
      if (s >= 0.18) {
        const bin = Math.min(DESC_BINS - 1, Math.floor((h / 360) * DESC_BINS));
        out[base + bin] += s;
        out[base + DESC_BINS] += 1 - s;
      } else {
        out[base + DESC_BINS] += 1;
      }
    }
  }
  for (let c = 0; c < 4; c++) {
    const base = c * (DESC_BINS + 1);
    let sum = 0;
    for (let k = 0; k <= DESC_BINS; k++) sum += out[base + k];
    if (sum > 0) for (let k = 0; k <= DESC_BINS; k++) out[base + k] /= sum;
  }
  return out;
}

/**
 * 只保留目标人的手。多人画面里 `hands` 会混进别人的手，
 * 而动作层只认目标人——不筛的话「张开/握拳」可能取到旁边那个人的手。
 * 判定口径：整帧检出要求腕点离目标腕点足够近；ROI 补检本来就是按目标腕点裁的，直接保留。
 */
function handsOfTarget(list, target) {
  if (!target) return [];
  const wl = target.kp[5];
  const wr = target.kp[6];
  const maxD = 2 * Math.max(target.scale, 1);
  return list.filter((hd) => {
    if (hd.side_from === 'roi') return true;
    const [x, y] = hd.kp[0];
    return Math.hypot(x - wl[0], y - wl[1]) < maxD || Math.hypot(x - wr[0], y - wr[1]) < maxD;
  });
}

const nearHand = (a, b) => Math.hypot(a.kp[0][0] - b.kp[0][0], a.kp[0][1] - b.kp[0][1]) < 8;

/**
 * 整帧漏检的手用姿态腕点补检（实时与静态共用）。
 * ownerTrackId 非空时给补检结果打上归属，assignHands 会据此只分给这个人。
 */
function completeHands(fullHands, target, source, w, h, ownerTrackId = null) {
  if (!target || !handsReady('IMAGE')) return fullHands;
  // 注意 handedness 是 'Left'/'Right'，腕点侧是 'L'/'R'，必须换算后再比较，
  // 否则每一侧都会被当成「没检出」而重复补检（多人画面上会多出两只手）。
  const have = new Set(fullHands
    .map((x) => (x.handedness === 'Left' ? 'L' : x.handedness === 'Right' ? 'R' : ''))
    .filter(Boolean));
  const wrists = [
    { side: 'L', x: target.kp[5][0], y: target.kp[5][1], vis: target.kp[5][2], scale: target.scale },
    { side: 'R', x: target.kp[6][0], y: target.kp[6][1], vis: target.kp[6][2], scale: target.scale },
  ];
  const retry = wristsToRetry(wrists, have, handVisMin);
  if (!retry.length) return fullHands;
  const added = detectHandsNearWrists(source, retry, handRoiCfg, { w, h }, wrists);
  if (ownerTrackId != null) for (const hd of added) hd.owner_track_id = ownerTrackId;
  return fullHands.concat(added);
}

/**
 * 多人：按预算给面积最大的前 N 人做腕部 ROI 补检（主目标优先）。
 * 预算 = min(perception.multi.maxPersons, signals.hand.roi.maxPersonsPerFrame)；
 * scale < minScalePx 的人跳过（远景裁太小，放大也没信息，属正常跳过而非错误）。
 * 结果按「腕点距离 < 8px 视为同一只手」并回整帧列表，同一个 ROI 结果不会归属给两个人
 * （每条结果带 owner_track_id，见 assignHands）。
 */
function completeHandsMulti(fullHands, judged, target, source, w, h) {
  if (!handsReady('IMAGE')) return fullHands;
  const { picked } = pickRoiPersons(judged, target, {
    maxPersons: multiCfg.maxPersons,
    maxPersonsPerFrame: handRoiCfg.maxPersonsPerFrame,
    minScalePx: handRoiCfg.minScalePx,
  });
  // 「已检出」必须用与最终归属同一套判据（assignHands），否则会出现
  // 「补检时以为 A 已有这只手、归属时又判给别人」→ A 这一侧既没有手也没补检。
  // 先按整帧归属一次，直接取每个人的槽位；ROI 结果按 owner_track_id 并回。
  const preAssigned = assignHands(judged, fullHands);
  for (const person of picked) {
    const own = preAssigned.get(person.track_id)?.list || [];
    for (const hd of completeHands(own, person, source, w, h, person.track_id)) {
      if (!fullHands.some((x) => nearHand(x, hd))) fullHands.push(hd);
    }
  }
  return fullHands;
}

/** 单张图片：推理一次，然后在信号/动作层收敛后绘制 */
async function analyzeStill(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  canvas.width = w;
  canvas.height = h;
  $('badgeRes').textContent = `${w} × ${h}`;
  $('badgeRes').hidden = false;

  const ts = performance.now();
  const multiRes = multiOn
    ? (multiCfg.tiles > 1
      ? detectMultiTiled(img, w, h, {
        tiles: multiCfg.tiles, overlap: multiCfg.tileOverlap, maxPoses: multiNumPoses,
      })
      : detectMultiImage(img))
    : detectVideo(img, ts);
  const persons = toPersons(multiRes, w, h)
    .map((p, i) => ({ ...p, track_id: i, track_age_ms: 0 }));
  let target = null;
  if (persons.length) {
    target = persons[0];
    for (const p of persons) if (area(p.bbox) > area(target.bbox)) target = p;
  }
  // 单张图没有时间窗：多人时全部判（各自独立状态机），单人时只判主目标。
  // 单人道固定用 track_id 0：帧内序号随检出顺序变，状态机会在 0/1 之间来回分叉。
  if (target && !multiOn) target.track_id = 0;
  const judged = multiOn && persons.length ? persons : (target ? [target] : []);

  let rawHands = [];
  if (show.hands && handReady) {
    try { rawHands = toHands(detectHandsVideo(img, ts), w, h); } catch { /* 手部失败不影响姿态 */ }
    if (multiOn) {
      // 多人：按预算给前 N 人（主目标优先）补检，结果并回整帧列表再按人归属
      completeHandsMulti(rawHands, judged, target, img, w, h);
    } else {
      // 单人：先按目标人筛，再补检；只保留主目标的手（导出/绘制/判定都只该有他的）。
      // 以前把别人的手留在这里，lastResult/导出会把旁边那个人的手算进目标人。
      rawHands = completeHands(handsOfTarget(rawHands, target), target, img, w, h);
    }
  }

  // 物体检测（图片是单帧：检测器建在 VIDEO 模式，用 detectForVideo 走同一实例；
  // 注意不能调 detectObjectsImage——那是给 IMAGE 模式实例用的，混用会抛错并被静默吞掉）
  let objects = [];
  if (objectOn && objectReady) {
    const gen = objectGen;
    try {
      const det = await detectObjects(img, ts + 1, w, h);
      // ONNX 推理期间可能切了 profile/关了开关：旧代次的结果/错误都不要再写回
      if (gen === objectGen && objectOn) {
        objects = det;
        lastObjects = objects;   // state.objects 读的是它；不写回去，无头检查会永远是 0
      }
    } catch (e) {
      if (gen === objectGen) objectError = e.message;   // 留给 UI/自检，别静默
    }
  }

  let sig = null;
  let act = null;
  let hands = [];
  let verdicts = [];
  if (judged.length) {
    // 归属只依赖手/人几何，与合成时间戳无关：先算一次，再逐帧分类。
    // 顺序必须是「先归属、再分类」——手势稳定器按 track 隔离（PLAN §16.3 R12-2）。
    const assigned = assignHands(judged, rawHands);
    for (let i = 0; i < STILL_SETTLE_FRAMES; i++) {
      const t = ts + i * 100;
      const cls = classifyAndBind(rawHands, t, assigned, !multiOn);
      hands = cls.hands;
      // 单人也必须走一遍归属：ActionEngine 拿的是「每个人每只手」的 map，
      // 之前单人模式传 null，导致伸手/持物/指向/拿取在默认单人道里永远不成立。
      verdicts = pipelines.update(judged, t, cls.handsByTrack);
    }
    const primaryV = pipelines.primary(verdicts);
    sig = primaryV ? primaryV.sig : null;
    act = primaryV ? primaryV.act : null;
    const ppeById = new Map();
    if (objectOn && objectReady) {
      for (const vd of verdicts) ppeById.set(vd.track_id, ppeMonitor.update(vd.track_id, vd.person, objects, ts));
    }
    lastVerdicts = verdicts.map((vd) => ({
      track_id: vd.track_id,
      track_uid: vd.person?.track_uid ?? vd.track_uid,
      bbox: vd.bbox, sig: vd.sig, act: vd.act, hands: vd.hands,
      ppe: ppeById.get(vd.track_id) || null,
    }));
    if (show.skeleton) {
      let first = true;
      for (const p of persons) {
        drawSkeleton(ctx, p.kp_raw, w, h, {
          points: show.points, clear: first, alpha: p === target ? 1 : 0.4,
        });
        first = false;
      }
    } else {
      clearCanvas(ctx, w, h);
    }
    if (objects.length) drawBoxes(ctx, objects);
    for (const vd of lastVerdicts) {
      if (!multiOn) break;
      const ppe = vd.ppe;
      const hat = ppe ? (ppe.helmet.alert !== 'none' ? '缺帽!' : ppe.helmet.state === 'worn' ? '帽✓' : '帽?') : '';
      const glove = ppe ? (ppe.glove.alert !== 'none' ? '手套!' : ppe.glove.state === 'worn' ? '手套✓' : '手套?') : '';
      drawTrackLabel(ctx, vd.bbox[0], vd.bbox[1],
        `#${vd.track_id} ${vd.act?.postureId || '—'}${hat ? ` · ${hat}` : ''}${glove ? ` ${glove}` : ''}`);
    }
    for (const hd of hands) drawHand(ctx, hd.kp, w, h, { alpha: 0.9 });
    $('badgeNoPerson').hidden = true;
  } else {
    clearCanvas(ctx, w, h);
    $('badgeNoPerson').hidden = false;
  }

  lastResult = {
    ts, persons, sig, act, hands,
    verdicts: lastVerdicts, objects, primaryId: lastVerdicts.length ? pipelines.primary(verdicts)?.track_id ?? null : null,
  };
  updateUI();
}

/**
 * 图片源（本地文件或 ?src= 的 URL）。
 * @param {string} src
 * @param {{revoke?: string|null}} opts revoke = 需要在本函数结束后释放的 blob URL
 */
async function useImageSource(src, { revoke = null } = {}) {
  const token = ++inputSeq;
  autoLoaded = true;   // 手动选择的图片同样优先于 ?src= 自动加载
  const stale = () => token !== inputSeq;
  await profileReady;
  if (stale()) {
    if (revoke) URL.revokeObjectURL(revoke);
    return false;
  }
  // 先把模型和图片都准备好，再停当前输入：图片选择/解码失败时，
  // 正在播的视频或摄像头不该被无辜停掉（旧代码在解码前就 stopLoop，失败后画面还在但推理没了）。
  if (!(await ensureEstimator())) {
    if (stale()) {
      if (revoke) URL.revokeObjectURL(revoke);
      return false;
    }
    if (revoke) URL.revokeObjectURL(revoke);
    setStatus('模型加载失败，无法分析图片', 'err');
    return false;
  }
  if (stale()) {
    if (revoke) URL.revokeObjectURL(revoke);
    return false;
  }
  // 多人 / 物体检测是懒加载的：主循环只在视频路径里触发它们，图片路径必须自己建好，
  // 否则 analyzeStill 里的 detectMultiImage / detectObjects 会抛 "not ready"，
  // 表现就是"图片能加载但一个判定都没有"（实测过）。
  if (multiOn && !multiReady && !(await ensureMultiEstimator())) {
    multiOn = false;
    $('chkMulti').checked = false;
    $('multiSel').hidden = true;
    setStatus('多人模型不可用，本张图按单人分析', 'err');
  }
  if (objectOn && !objectReady && (await ensureObjectDetector()) === false) {
    objectOn = false;
    $('chkObjects').checked = false;
    setStatus('物体检测不可用，本张图不做物体判定', 'err');
  }
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    if (revoke) URL.revokeObjectURL(revoke);
    if (!stale()) setStatus('图片加载失败', 'err');
    return false;
  }
  if (stale()) {
    if (revoke) URL.revokeObjectURL(revoke);
    return false;
  }

  stopStream();
  stopLoop();
  clearPhoto();
  photoUrl = revoke || null;
  photoEl.src = src;
  photoEl.hidden = false;
  videoEl.pause();
  videoEl.srcObject = null;
  videoEl.removeAttribute('src');
  videoEl.hidden = true;
  mode = 'image';
  placeholder.hidden = true;
  setActiveInput('file');
  resetRuntime();
  syncPlayer();
  try {
    await analyzeStill(img);
  } catch (e) {
    setStatus(`图片分析失败：${e.message}`, 'err');
    return false;
  }
  if (token === inputSeq) setStatus('就绪 · 图片（单帧判定，无时间窗）', 'ok');
  return token === inputSeq;
}

async function useImageFile(file) {
  await profileReady;
  const url = URL.createObjectURL(file);
  const ok = await useImageSource(url, { revoke: url });
  if (ok) setStatus(`就绪 · 图片 · ${file.name}（单帧判定）`, 'ok');
  return ok;
}

function stopAll() {
  // 让还在等模型/首帧的输入任务作废，别在「已停止」之后又挂上新画面。
  ++inputSeq;
  stopStream();
  stopLoop();
  clearPhoto();
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
  closeMultiEstimator();
  invalidateObjectDetector();
  estimatorReady = false;
  handReady = false;
  multiReady = false;
  objectBusy = false;
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
  const tLoop = performance.now();

  // 多人估算器是懒加载的：刚勾上开关时它可能还在建。建好之前先按单人跑，
  // 否则每一帧都会因为 detectMultiImage 抛错把主循环停掉。
  // 建失败必须关掉开关：否则这里每一帧都会重试一次建模型（实测会持续打印错误并拖慢主循环）。
  if (multiOn && !multiReady && !multiInitPromise) {
    ensureMultiEstimator().then((ok) => {
      if (ok || !multiOn) return;
      multiOn = false;
      $('chkMulti').checked = false;
      $('multiSel').hidden = true;
      saveSettings();
    });
  }
  if (objectOn && !objectReady && !objectInitPromise) {
    ensureObjectDetector().then((ok) => {
      if (ok !== false || !objectOn) return;   // 'superseded' 交给新配置，不算失败
      objectOn = false;
      $('chkObjects').checked = false;
      saveSettings();
    });
  }
  const multi = multiOn && multiReady;
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;

  let res;
  const tPose = performance.now();
  try {
    // 多人走 IMAGE 模式：VIDEO 模式的跟踪器只会锁定一个人（实测 numPoses=2 也没用）
    res = multi
      ? (multiCfg.tiles > 1
        ? detectMultiTiled(v, w, h, {
          tiles: multiCfg.tiles, overlap: multiCfg.tileOverlap, maxPoses: multiNumPoses,
        })
        : detectMultiImage(v))
      : detectVideo(v, ts);
  } catch (e) {
    setStatus(`推理错误：${e.message}`, 'err');
    stopLoop();
    return;
  }
  const poseMs = performance.now() - tPose;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    // 舞台是固定高度的取景窗（CSS 决定尺寸），不再按视频比例撑开：
    // 竖屏素材会把舞台压成一条窄柱，还会把整页拉高。视频与画布都用 object-fit: contain 居中。
    $('badgeRes').textContent = `${w} × ${h}`;
    $('badgeRes').hidden = false;
  }

  // 感知：姿态（1 人或多人的稳定 id）+ 物体（可选）
  const personsRaw = toPersons(res, w, h);
  let persons;
  if (multi) {
    // 外观描述子要在 tracker.update 之前算（拿到本帧 bbox 才能裁图）
    if (tracker.appearance) {
      for (const p of personsRaw) p.desc = appearanceDescriptor(v, p);
    }
    persons = tracker.update(personsRaw, ts);
  } else {
    // 单人道保持旧语义：不做跟踪，track_id 用帧内序号，只判面积最大的那个人
    persons = personsRaw.map((p, i) => ({ ...p, track_id: i, track_age_ms: 0 }));
  }

  // 判谁：单人道只判主目标（其余人只画骨架），多人道所有人都判
  let judged = persons;
  if (!multi) {
    const main = persons.slice().sort((a, b) => area(b.bbox) - area(a.bbox))[0] || null;
    // 单人道固定 track_id 0（与 PersonPipelines 的注释一致）：帧内序号随检出顺序变，
    // 两人同框时主目标会在 0/1 两条流水线之间来回切，Hold/滤波/计数全部被打断。
    if (main) main.track_id = 0;
    judged = main ? [main] : [];
  }
  const target = judged.slice().sort((a, b) => area(b.bbox) - area(a.bbox))[0] || null;

  // 物体检测：PPE 的前提。失败就关掉开关，别每帧抛异常拖慢主循环。
  // ONNX 后端是异步的（wasm 推理），这里**不能 await**：loop() 是 rAF 回调，await 会
  // 让推理和姿态链串行。改成"上一帧结果 + 同一时刻只跑一次"，PPE 用到的框最多晚一帧。
  const tObj = performance.now();
  // 物体检测按 intervalMs 降频（PPE 是秒级时序判定）。跳过时沿用 lastObjects。
  if (objectOn && objectReady && ts - lastObjectTs >= (objectCfg.intervalMs || 0)) {
    lastObjectTs = ts;
    const fail = (e) => {
      objectOn = false;
      objectReady = false;
      $('chkObjects').checked = false;
      setStatus(`物体检测失败，已关闭：${e.message}`, 'err');
      lastObjects = [];
    };
    try {
      // 必须先看 objectBusy 再调用：ONNX 的 detectObjects 在返回 Promise 之前就同步做了
      // letterbox/CHW 并提交 session.run。先调用后判断会让上一次推理还在飞时又开一次，
      // 被丢弃的 promise 没有 catch，rejection 会变成页面 JS 错误。
      if (objectBusy) {
        // 上一次推理还没回来，这一帧跳过（沿用上一帧的框）
      } else {
        const detGen = objectGen;
        const det = detectObjects(v, ts, w, h);
        if (det && typeof det.then === 'function') {
          objectBusy = true;
          det.then((o) => {
            // 推理期间换了 profile / 关了开关：结果属于旧代次，丢掉
            if (detGen === objectGen && objectOn) lastObjects = o;
          }).catch((e) => {
            if (detGen === objectGen) fail(e);
          }).finally(() => {
            if (detGen === objectGen) objectBusy = false;
          });
        } else {
          lastObjects = det;
        }
      }
    } catch (e) {
      fail(e);
    }
  } else if (!objectOn) {
    lastObjects = [];
  }
  const objMs = performance.now() - tObj;

  // —— 手部要先于动作判定：拿取/持物需要「手是张开还是握紧」，姿态层给不了。
  // 手部模型失败不影响主体识别，hands 为空时这些动作一律不成立。
  let hands = [];
  let handsByTrack = null;
  const tHands = performance.now();
  // 没有检出任何人时手部推理没有消费者：手只能归属到人，动作/PPE 都按人分组。
  // 夜景/空镜头里跑 HandLandmarker 纯属白烧 ~13ms/帧（04 序列几乎每帧都是这种情况）。
  if (show.hands && handReady && judged.length) {
    try {
      hands = toHands(detectHandsVideo(v, ts), w, h);
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
    // 整帧漏检的手用姿态腕点补检。全身/远景构图里手只有几十像素，整帧 HandLandmarker
    // 实测 0 命中；腕点裁一块放大后同一模型能稳定检出。只在漏检且腕点可见时才付这次推理。
    if (multi) {
      // 多人：按预算给面积最大的前 N 人补检（主目标优先，见 completeHandsMulti）
      completeHandsMulti(hands, judged, target, v, w, h);
    } else {
      hands = completeHands(handsOfTarget(hands, target), target, v, w, h);
    }
    // 单人也必须归属：否则 ActionEngine 拿到的是空手，伸手/持物/指向/拿取恒为 false。
    // 顺序必须是「先归属、再分类」：手势稳定器按 track 隔离（PLAN §16.3 R12-2）。
    const assigned = assignHands(judged, hands);
    const cls = classifyAndBind(hands, ts, assigned, !multi);
    hands = cls.hands;
    handsByTrack = cls.handsByTrack;
  }
  const handsMs = performance.now() - tHands;

  // 判定：每人一条独立流水线
  const verdicts = pipelines.update(judged, ts, handsByTrack);
  if (multi) {
    // 跟踪器已经 prune 过超时轨迹：流水线/PPE 计时器不能继续留着（长会话里会无限增长，
    // 而且旧 id 的 PPE 计时会在新人拿到新 id 后仍然占着内存）
    const live = new Set(tracker.tracks.keys());
    pipelines.prune(live);
    ppeMonitor.prune(live);
    // 逐 track 的手势稳定器同样要清：人离开画面后 track 不会回来，留着只会让
    // 长会话的 Map 只增不减（单人道只有 track 0，不受影响）。
    shapeStable.prune(live);
  }
  const primaryV = pipelines.primary(verdicts);
  const sig = primaryV ? primaryV.sig : null;
  const act = primaryV ? primaryV.act : null;

  // PPE：只看检测框与人的几何关系，看不见一律 unknown（见 ppe.js 头注释）
  const ppeById = new Map();
  if (objectOn && objectReady) {
    for (const vd of verdicts) ppeById.set(vd.track_id, ppeMonitor.update(vd.track_id, vd.person, lastObjects, ts));
  }
  lastVerdicts = verdicts.map((vd) => ({
    track_id: vd.track_id,
    // 稳定标识由 track.js 产出（物体线加）；这里只透传，不分配。
    track_uid: vd.person?.track_uid ?? vd.track_uid,
    bbox: vd.bbox,
    sig: vd.sig,
    act: vd.act,
    hands: vd.hands,
    ppe: ppeById.get(vd.track_id) || null,
  }));

  const tDraw = performance.now();
  if (judged.length) {
    if (show.skeleton) {
      // 先画非主目标（淡），最后画主目标（实）：主目标永远在最上层
      let first = true;
      for (const p of judged) {
        if (p === target) continue;
        drawSkeleton(ctx, p.kp_raw, w, h, { points: show.points, clear: first, alpha: 0.45 });
        first = false;
      }
      for (const p of persons) {
        if (judged.includes(p)) continue;
        drawSkeleton(ctx, p.kp_raw, w, h, { points: show.points, clear: first, alpha: 0.25 });
        first = false;
      }
      drawSkeleton(ctx, target.kp_raw, w, h, { points: show.points, clear: first });
    } else {
      clearCanvas(ctx, w, h);
    }
    $('badgeNoPerson').hidden = true;
  } else {
    clearCanvas(ctx, w, h);
    $('badgeNoPerson').hidden = false;
  }

  if (objectOn && objectReady && lastObjects.length) drawBoxes(ctx, lastObjects);

  // 多人时给每个人标 id + 姿态 + PPE：否则画面上几条骨架分不清哪条是哪条
  if (multi) {
    for (const vd of lastVerdicts) {
      const ppe = vd.ppe;
      const hat = ppe ? (ppe.helmet.alert !== 'none' ? '缺帽!' : ppe.helmet.state === 'worn' ? '帽✓' : '帽?') : '';
      const glove = ppe ? (ppe.glove.alert !== 'none' ? '手套!' : ppe.glove.state === 'worn' ? '手套✓' : '手套?') : '';
      const label = `#${vd.track_id} ${vd.act?.postureId || '—'}${hat ? ` · ${hat}` : ''}${glove ? ` ${glove}` : ''}`;
      drawTrackLabel(ctx, vd.bbox[0], vd.bbox[1], label, {
        // lastVerdicts 是 verdicts 的副本，对象引用永远不相等；按 id 比才认得出主目标
        color: vd.track_id === primaryV?.track_id ? '#1d1d1f' : '#6b6b70',
      });
    }
  }

  for (const hd of hands) drawHand(ctx, hd.kp, w, h, { alpha: 0.9 });
  const drawMs = performance.now() - tDraw;

  if (mayLogFrame()) {
    // persons 必须是**判定人员**（多人=judged 全体，单人=主目标），不是画面里所有人：
    // 单人走的还是旧路径，其余人只画骨架，不应进导出。
    pushLog(ts, target, sig, act, persons.length, hands, {
      verdicts: lastVerdicts, objects: lastObjects, ppeById, persons: judged,
    });
  }

  lastResult = { ts, persons, sig, act, hands, verdicts: lastVerdicts, objects: lastObjects, primaryId: primaryV?.track_id ?? null };

  // 阶段耗时只做 EMA，不逐帧存：state.timing 给无头吞吐脚本读，UI 不展示。
  stageMs.pose = ema(stageMs.pose, poseMs);
  stageMs.hands = ema(stageMs.hands, handsMs);
  stageMs.objects = ema(stageMs.objects, objMs);
  stageMs.draw = ema(stageMs.draw, drawMs);
  stageMs.total = ema(stageMs.total, performance.now() - tLoop);
  stageMs.n++;
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

/**
 * 导出用的单手记录。动作层内部的手带 `cls` 等临时字段，这里只挑契约里的字段。
 * 与帧级 `hands[]` 同结构（docs/frame-schema.md）。
 */
function exportHand(hd) {
  return {
    handedness: hd.handedness,
    shape: hd.cls?.shape ?? hd.shape ?? null,
    shape_raw: hd.cls?.raw ?? hd.shape_raw ?? null,
    score: r2(hd.score),
    orient: hd.orient,
    spread: hd.spread,
    bbox: Array.isArray(hd.bbox) ? hd.bbox.map(r1) : null,
    kp: Array.isArray(hd.kp) ? hd.kp.map(([x, y]) => [r1(x), r1(y)]) : null,
  };
}

/**
 * 导出用的人记录。单人路径与旧版逐字段一致；多人时每个判定人员一条。
 * `track_uid` 是轨迹内部的稳定 uid（同一轨迹对象内不变；跨 track_id 的继承尚未实现）：
 * 有就透传，没有就不写（只增可选字段）。
 */
function exportPerson(p) {
  return {
    track_id: p.track_id,
    ...(p.track_uid !== undefined ? { track_uid: p.track_uid } : {}),
    bbox: p.bbox.map(r1),
    kp_format: p.kp_format,
    kp: p.kp.map(([x, y, v]) => [r1(x), r1(y), r2(v)]),
    // 世界坐标（米制）：3D 抬臂角/举手判定依赖它。不导出的话，离线评估永远只能走 2D 分支，
    // 评估结果就和页面实际执行的规则不是一回事（见 evaluate.mjs 文件头）。
    kp_world: p.kp_world && p.kp_world.length
      ? p.kp_world.map(([x, y, z]) => [r2(x), r2(y), r2(z)]) : null,
    scale: r2(p.scale),
    score: r2(p.score),
  };
}

function pushLog(ts, p, sig, act, personCount = 1, hands = [], extra = null) {
  // 这一帧走的是多人判定路径就锁定为 multi（录制中切换也只升不降，
  // 保证 meta 与按 6000 截断的 frameLog 一致）
  if (exportMulti()) logMode = 'multi';
  const logPersons = extra?.persons || (p ? [p] : []);
  frameLog.push({
    ts: Math.round(ts),
    // 视频/摄像头画面的时间（秒）。ts 是 performance.now，录完对不上人眼看到的时间；
    // 标注时按 video_time 写秒数最省事（见 docs/eval.md）。摄像头没有稳定的媒体时间，用 ts 折算。
    // 用推理**开始前**记下的 lastVideoTime，而不是此刻的 currentTime：推理是同步阻塞的，
    // 多人/物体模型一轮要几十到几百毫秒，读此刻的时间会让日志比实际分析的帧晚好几帧，
    // 离线按帧对齐 gt（web/test/mot17-eval.mjs）会系统性错位。
    video_time: mode === 'file' ? Math.round(lastVideoTime * 1000) / 1000 : null,
    person_count: personCount,
    // 多人时是全部判定人员（每人带 kp/kp_world/scale/score），单人时仍是 1 个元素、字段不变。
    // 迁移旧数据的工具不需要知道模式：只看数组长度即可。
    persons: logPersons.map(exportPerson),
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
      unreliable: act.unreliable ?? [],
    } : null,
    hands: hands.map(exportHand),
    // —— 多人与物体（新增字段；老数据没有它，评估器按"没有多人信息"处理）——
    // persons[0] 仍是主目标，signals/actions 仍是主目标的判定，老流程与评估器完全不受影响。
    // 几何统一放在 persons[]（按 track_id 关联），verdicts 里不重复存 kp/scale；
    // hands 是「该 track 被归属到的手」，与帧级 hands 同结构。
    verdicts: (extra?.verdicts || []).map((vd) => ({
      track_id: vd.track_id,
      ...(vd.track_uid !== undefined ? { track_uid: vd.track_uid } : {}),
      bbox: vd.bbox.map(r1),
      posture: vd.act?.postureId ?? null,
      frozen: !!vd.act?.frozen,
      flags: vd.act?.flags ?? null,
      reps: vd.act?.reps ?? null,
      hands: vd.hands
        ? (vd.hands.list || [vd.hands.L, vd.hands.R].filter(Boolean)).map(exportHand)
        : [],
      ppe: vd.ppe ? {
        helmet: {
          state: vd.ppe.helmet.state, alert: vd.ppe.helmet.alert, streak_ms: vd.ppe.helmet.streak_ms,
          ...(vd.ppe.helmet.reason ? { reason: vd.ppe.helmet.reason } : {}),
          ...(vd.ppe.helmet.reason_code ? { reason_code: vd.ppe.helmet.reason_code } : {}),
        },
        glove: {
          state: vd.ppe.glove.state, alert: vd.ppe.glove.alert, streak_ms: vd.ppe.glove.streak_ms,
          ...(vd.ppe.glove.reason_code ? { reason_code: vd.ppe.glove.reason_code } : {}),
        },
      } : null,
    })),
    objects: (extra?.objects || []).map((o) => ({
      label: o.label, score: r2(o.score), box: o.box.map(r1),
    })),
  });
  // 溢出时一次丢一批，摊薄成本（每帧 shift 会变成 O(n)）。
  // 正常溢出只丢 10%；如果上限刚从 20000 切到 6000，len 远大于 limit+trim，
  // 这时一次丢到 limit-trim，避免要花几十帧才降到新上限（UI 的丢弃计数照样累加）。
  const limit = logLimit();
  const trim = logTrim();
  if (frameLog.length > limit) {
    const drop = frameLog.length > limit + trim ? frameLog.length - (limit - trim) : trim;
    const removed = frameLog.splice(0, Math.min(drop, frameLog.length));
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
  // 物体模型指纹（PLAN §17 R13-3）：PPE 指标跨模型不可比，baseline 用它拒绝跨模型比较。
  // 关闭物体检测时为 null；MediaPipe 后端没有 sidecar，modelHash 为 null。
  const oi = objectOn ? objectInfo() : null;
  return {
    exported_at: new Date().toISOString(),
    schema: 'frame.jsonl v0',
    kp_format: 'mediapipe33',
    hand_kp_format: 'mediapipe21',
    // 模型档位与后端：lite 和 full 的关键点噪声不同，阈值不能混用（PLAN §13 R0）。
    // 事后想回答"这份数据是哪套模型跑出来的"，只能靠这两行。
    model: activeModel,
    delegate: activeDelegate,
    // 用 activeHandModel 而不是 handReady：点过「停止」后模型已释放，
    // 但已记录的帧仍是手部模型产出的，导出时不能把这份来源丢掉。
    hand_model: activeHandModel,
    infer_fps: Number($('fpsCapSel').value) || null,
    fps: r1(fps),
    profile: profileName,
    profile_model: profileModel,
    // 参数指纹：比较两份数据是否同一套阈值，不需要 diff 整份 params
    params_hash: paramsHash(activeParams),
    params: activeParams,
    frame_count: frameLog.length,
    // 多人口径的帧数上限与本次导出走的是哪条判定路径（PLAN §18.5 D3）。
    // 评估器据此判断「帧被截断」是否正常：多人 6000 是为了控制体积，不是数据丢失。
    log_limit: logLimit(),
    export_mode: logMode,
    objects: oi ? {
      backend: objectCfg.backend ?? null,
      model: objectCfg.model ?? null,
      inputSize: objectCfg.inputSize ?? null,
      modelHash: oi.modelHash ?? null,
      // 类别顺序错了比模型错了更难查：把顺序本身也指纹化（evaluate 的 baseline 校验会用）
      labelsHash: Array.isArray(objectCfg.labels) && objectCfg.labels.length
        ? paramsHash({ labels: objectCfg.labels }) : null,
      manifestOk: oi.manifest?.ok ?? null,
    } : null,
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
  const seq = ++replaySeq;
  // 拖动进度条后立刻点重播时，上一个 seek 还在飞行；直接 play() 会被浏览器以
  // AbortError 拒绝，视频停在 0 不动（headless-check 里能稳定复现）：
  // 先等 currentTime=0 的 seek 落定，再 play；期间再次点重播则放弃这一次。
  seeking = false;
  resumeAfterSeek = false;
  resetRuntime();
  try { videoEl.currentTime = 0; } catch { /* metadata 还没就绪 */ }
  const play = () => {
    if (seq !== replaySeq) return;
    videoEl.play().catch((e) => {
      if (seq !== replaySeq) return;
      setStatus(`播放被拒（${e.name}）`, 'err');
    });
    setStatus('已清空记录，从头播放', 'busy');
    syncPlayer();
  };
  if (videoEl.seeking) {
    const done = () => {
      videoEl.removeEventListener('seeked', done);
      clearTimeout(timer);
      play();
    };
    const timer = setTimeout(done, 400);   // seek 事件丢失时兜底
    videoEl.addEventListener('seeked', done);
  } else {
    play();
  }
}

function clearLog() {
  if (!frameLog.length) {
    setStatus('没有可清空的记录', 'busy');
    return;
  }
  resetRuntime();
  setStatus('已清空记录（计数一起重置）', 'ok');
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
  stopStream();
  stopLoop();
  clearPhoto();
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

// 准确率只显示评估报告里的实测值：没有报告/样本不足都明确写出来。
// 每次报告变化才重算，不放进逐帧 updateUI。
function refreshAccuracy() {
  const opts = {
    minSamples: accuracyReport?.minSamples,
    synthetic: !!accuracyReport?.source?.synthetic,
  };
  const items = ARM_ACTIONS.map((a) => {
    const f = formatAccuracy(accuracyFor(accuracyReport, a.id), opts);
    accuracyById[a.id] = f;   // {short,long,level}：提示行用 short，tooltip 用 long
    return { a, f };
  });
  renderAccuracy(items);
}

function renderAccuracy(items) {
  const box = $('accList');
  if (!box) return;
  const rows = items.map(({ a, f }) => `<div class="acc-item" title="${esc(f.long)}">`
    + `<span class="an">${esc(a.name)}</span>`
    + `<span class="av ${f.level}">${esc(f.short)}</span></div>`).join('');
  const src = accuracyReport?.source;
  // 参数改过（阈值/手型分组）而报告没重跑：数字仍能看，但必须标明不是当前规则测的。
  const stale = accuracyStale(accuracyReport, activeParamsHash);
  const sourceNote = !accuracyReport
    ? '没有准确率报告：运行 npm run accuracy 生成 web/accuracy.json（读取 eval-data 的标注素材）。'
    : `${src?.dir || 'eval-data'} · ${src?.totalFrames ?? 0} 帧 · ${src?.note || ''}`
      + (stale ? ` · 注意：报告参数 ${accuracyReport.paramsHash} 与当前 ${activeParamsHash} 不一致，改阈值后要重跑 npm run accuracy` : '');
  box.innerHTML = rows
    + `<div class="acc-note">${esc(sourceNote)}</div>`
    + '<div class="acc-note">口径：逐帧召回 / 精确；每个方向样本 ≥20 才报百分比，'
    + '「未评估」= 没有标注数据。手部「未检出」时伸手/持物/指向不判，也不计入准确率。</div>';
}

function updateUI() {
  const { sig, act, hands } = lastResult || {};

  const postureEl = $('posture');
  // 只有上半身在画面里时，站/坐判不了（缺膝、踝）。这不是「没识别」，
  // 而是信息不足——明确写出来，别让用户以为模型挂了。
  const upperOnly = !!(sig && sig.ok && !Number.isFinite(sig.leg_vertical));
  postureEl.textContent = act?.posture
    || (sig ? (sig.ok ? (upperOnly ? '上半身' : '未判定') : '置信不足') : '—');
  postureEl.classList.toggle('dim', !act?.posture);

  if (act?.posture) {
    const secs = (act.postureMs / 1000).toFixed(1);
    $('postureMeta').textContent = act.frozen ? `保持 ${secs}s · 置信不足` : `持续 ${secs}s`;
  } else if (sig && !sig.ok) {
    $('postureMeta').textContent = `画面内置信 ${r2(sig.score)} · 人体太小/光线不足/被遮挡`;
  } else if (upperOnly) {
    $('postureMeta').textContent = '下半身不可见（出画/遮挡），站/坐无法判定';
  } else {
    $('postureMeta').textContent = sig ? '—'
      : (mode === 'idle' ? '无画面' : mode === 'image' ? '—' : '等待下一帧');
  }

  for (const a of ACTION_CATALOG) {
    const el = document.querySelector(`#postureChips .chip[data-id="${a.id}"]`);
    if (el) el.classList.toggle('on', act?.postureId === a.id);
  }

  // 动作判不判得出来取决于运行条件（手部模型 / 3D / 髋是否入镜 / 单帧），
  // 把这些条件和已知误判写进面板，避免用户把「判不了」当成「没做」。
  const armHints = explainArmActions({
    sig, act, hands,
    handOn: show.hands,
    handReady,
    imageMode: mode === 'image',
    accuracyById,
  });

  for (const a of ARM_ACTIONS) {
    const el = document.querySelector(`#armGrid .act[data-id="${a.id}"]`);
    if (!el) continue;
    const hint = armHints.byId[a.id];
    const on = !!act?.flags?.[a.flag];
    el.classList.toggle('on', on);
    // 空心点 = 当前条件下这个动作根本判不了（不是还没做）
    el.classList.toggle('na', !!hint?.na && !on);
    el.title = hint?.title || '';
  }
  // 有画面但没检出人：不是「没做动作」，是根本没得判；无画面时则提示怎么查条件
  const hintLine = armHints.line || (mode === 'idle' ? DEFAULT_HINT : '未检测到人：动作不判');
  $('armHint').textContent = hintLine;
  $('armHint').title = hintLine;

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
  // 「未检出」不是「手是空的」：写清楚原因，以及哪些动作会因此不判
  $('handMeta').title = armHints.hands.title;
  const noHandTitle = armHints.hands.state === 'off' || armHints.hands.state === 'loading'
    ? armHints.hands.title
    : '本帧未检出这只手：手出画/太小/侧对镜头/被遮挡';
  $('handLCard').title = hl ? '' : noHandTitle;
  $('handRCard').title = hr ? '' : noHandTitle;

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

  // 下半身是否入镜：髋/膝/踝任一不可见就提示。用户据此知道该退后还是换机位，
  // 而不是对着一个空姿态反复试。
  const vis = sig?.vis;
  const lowerHidden = !!vis && (vis.hip < 0.4 || vis.knee < 0.3 || vis.ankle < 0.3);
  // 判定不可靠的原因：让用户知道这一帧别太当真，而不是把误判当成结论
  const UNRELIABLE = {
    low_confidence: '低置信', extrapolated: '外推',
    bone_blocked: '骨骼异常', angle_outlier: '角度坏点',
  };
  const unrel = (act?.unreliable || []).map((r) => UNRELIABLE[r] || r);
  $('signalMeta').textContent = sig
    ? `膝角取${sig.knee_side === 'L' ? '左' : '右'}腿 · 置信 ${r2(sig.score)}`
      + `${lowerHidden ? ' · 下半身不可见' : ''}${unrel.length ? ` · 不可靠：${unrel.join('/')}` : ''}`
    : '—';

  if (act?.reps) renderReps(act.reps);
  $('repMeta').textContent = act
    ? `门控 鼓掌${act.gates?.clap ? '✓' : '—'}`
    : '—';

  // —— 人员列表（多人 / PPE）——
  // 只有开了多人或物体检测才显示：单人无 PPE 时这块没有信息量，显示出来只是噪声。
  const showPeople = multiOn || objectOn;
  $('peopleMod').hidden = !showPeople;
  if (showPeople) {
    const nameOf = (id) => ACTION_CATALOG.find((a) => a.id === id)?.name || id || '—';
    const rows = (lastVerdicts || []).map((vd) => {
      const ppe = vd.ppe;
      const bad = [];
      const good = [];
      if (ppe) {
        const h = ppe.helmet;
        if (h.alert !== 'none') bad.push(`缺帽 ${Math.round(h.streak_ms / 1000)}s`);
        else if (h.state === 'worn') good.push('帽✓');
        else good.push('帽?');
        const g = ppe.glove;
        if (g.alert === 'violation') bad.push(`缺手套 ${Math.round(g.streak_ms / 1000)}s`);
        else if (g.alert === 'suspect') bad.push(`手套疑似 ${Math.round(g.streak_ms / 1000)}s`);
        else if (g.state === 'worn') good.push('手套✓');
        else good.push('手套?');
      }
      const cls = bad.length ? 'warn' : (good.length ? 'ok' : '');
      return `<div class="person"><span class="pid">#${vd.track_id}</span>`
        + `<span class="pstate">${nameOf(vd.act?.postureId)}</span>`
        + `<span class="pbadge ${cls}">${(bad.length ? bad : good).join(' · ') || '—'}</span></div>`;
    }).join('');
    $('peopleList').innerHTML = rows
      || '<div class="person"><span class="pid">—</span><span class="pstate">未检出</span><span class="pbadge">—</span></div>';
    const alerts = (lastVerdicts || []).filter((v) => v.ppe
      && (v.ppe.helmet.alert !== 'none' || v.ppe.glove.alert !== 'none')).length;
    const objMeta = objectOn
      ? (objectReady ? ` · ${lastObjects.length} 框` : ' · 检测模型未就绪')
      : '';
    $('peopleMeta').textContent = `${(lastVerdicts || []).length} 人${objMeta}${alerts ? ` · 告警 ${alerts}` : ''}`;
  }

  const span = frameLog.length > 1
    ? (frameLog[frameLog.length - 1].ts - frameLog[0].ts) / 1000
    : 0;
  const recState = mode === 'idle' ? '未开始'
    : mode === 'image' ? '单帧判定'
      : videoWrapDetected ? '记录已停止（时间回退）'
        : mode === 'camera' ? '记录中'
          : (videoEl.paused ? '已暂停' : '记录中');
  const dropped = logDropped ? ` · 已丢弃 ${logDropped} 帧（上限 ${logLimit()}）` : '';
  $('logInfo').textContent = frameLog.length
    ? `${frameLog.length} 帧 / ${span.toFixed(1)}s · ${recState}${dropped}`
    : (mode === 'idle' ? '—' : `0 帧 · ${recState}${dropped}`);
  $('logInfo').title = `profile=${profileName} · ${activeParamsHash} · 模型 ${activeModel ? `${activeModel}/${activeDelegate || '?'}` : '—'} · 上限 ${logLimit()} 帧`;

  // 无帧时导出/清空/难例都不该可点；难例采样中保持禁用直到 finishHardcase 复位
  $('btnExport').disabled = !frameLog.length;
  $('btnClearLog').disabled = !frameLog.length;
  $('btnHardcase').disabled = !frameLog.length || !!hardcasePending;

  // 曲线图例已有数值，这里给悬停说明当前门限与参数指纹
  $('signalMeta').title = `参数指纹 ${activeParamsHash}`;

  syncPlayer();
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

/** 文件入口统一分发：图片走单帧判定，视频走播放/记录 */
async function useAnyFile(file) {
  if (isImageFile(file)) return useImageFile(file);
  if (isVideoFile(file)) return useVideoFile(file);
  setStatus('只支持视频或图片文件', 'err');
  return false;
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
  if (f) await useAnyFile(f);
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
  await useAnyFile(file);
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
  // 换档后其它实例也是旧档位的：一起放掉，下次用到时按新档重建
  closeMultiEstimator();
  multiReady = false;
  if (mode !== 'idle') {
    initEstimator();
    if (multiOn) ensureMultiEstimator();
  }
});
$('delegateSel').addEventListener('change', () => {
  saveSettings();
  closeMultiEstimator();
  invalidateObjectDetector();
  multiReady = false;
  if (mode !== 'idle') {
    initEstimator();
    if (multiOn) ensureMultiEstimator();
    if (objectOn) ensureObjectDetector();
  }
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
  if (!show.hands) {
    // 关掉手部就别再让实例占显存；下次打开时重新加载。
    closeHandEstimator();
    handReady = false;
    activeHandModel = null;
  } else if (!handsReady()) {
    await initHands($('delegateSel').value);
  }
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

// 多人：切换会重建跟踪器与每人的状态机（id 从 1 重新开始），否则旧 track 的计数会串到新人身上
$('chkMulti').addEventListener('change', async (e) => {
  multiOn = e.target.checked;
  $('multiSel').hidden = !multiOn;
  saveSettings();
  resetRuntime();
  if (multiOn) {
    const ok = await ensureMultiEstimator();
    setStatus(ok ? '多人已开：每人一条独立判定流水线' : '多人模型不可用，已退回单人', ok ? 'ok' : 'err');
    if (!ok) { multiOn = false; $('chkMulti').checked = false; $('multiSel').hidden = true; }
  } else {
    closeMultiEstimator();
    multiReady = false;
    setStatus('已切回单人（VIDEO 模式）', '');
  }
  updateUI();
});

$('multiSel').addEventListener('change', async () => {
  saveSettings();
  if (!multiOn) return;
  closeMultiEstimator();
  multiReady = false;
  resetRuntime();
  const ok = await ensureMultiEstimator();
  if (!ok) setStatus('多人模型重建失败', 'err');
  updateUI();
});

// 物体检测：PPE 的前提。模型没下载时这里会失败并给出补救命令，不影响姿态与动作
$('chkObjects').addEventListener('change', async (e) => {
  objectOn = e.target.checked;
  saveSettings();
  resetRuntime();
  if (objectOn) {
    lastObjectTs = 0;
    const ok = await ensureObjectDetector();
    if (ok === 'superseded') {
      // 创建期间 profile/开关变过：新配置的 ensure 会接手，别把开关关掉
      updateUI();
      return;
    }
    setStatus(ok ? '物体检测已开' : '物体检测不可用（模型或后端问题）', ok ? 'ok' : 'err');
    if (ok === false) { objectOn = false; $('chkObjects').checked = false; }
  } else {
    invalidateObjectDetector();
    lastObjects = [];
    setStatus('物体检测已关', '');
  }
  updateUI();
});
$('btnReset').addEventListener('click', () => {
  for (const p of pipelines.map.values()) p.act.reset();
  renderReps({ clap: 0, grasp: 0 });
});
$('btnAccuracy').addEventListener('click', () => {
  const box = $('accList');
  const open = box.hidden;
  box.hidden = !open;
  $('btnAccuracy').setAttribute('aria-expanded', String(open));
  $('btnAccuracy').classList.toggle('on', open);
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
  } else if (mode !== 'idle' && mode !== 'image' && estimatorReady) {
    // 图片模式没有时间序列，不需要 rAF 主循环。
    ensureLoop();
  }
});

// 测试钩子
window.__pose = {
  get state() {
    return {
      estimatorReady, handReady, mode, fps: r1(fps), frames: frameLog.length, lastResult,
      // 多人 / 物体检测（无头检查断言用）
      multiOn, multiReady, objectOn, objectReady, multiError, objectError,
      multiKey: multiEstimatorInfo().key, multiTiles: multiCfg.tiles,
      profileLoaded,
      tracks: tracker.tracks.size, pipes: pipelines.size(), verdicts: lastVerdicts.length,
      objects: lastObjects.length,
      // 物体检测后端/类别分布：无头 PPE 检查断言用（onnx 后端没有 label map，
      // 只能靠这里确认 labels 顺序接对了）
      objectInfo: objectInfo(),
      objectTags: lastObjects.reduce((m, o) => {
        const k = o.label || '?';
        m[k] = (m[k] || 0) + 1;
        return m;
      }, {}),
      // 各阶段耗时（EMA，毫秒）：web/test/throughput-probe.mjs 用
      timing: {
        pose: r2(stageMs.pose), hands: r2(stageMs.hands), objects: r2(stageMs.objects),
        draw: r2(stageMs.draw), total: r2(stageMs.total), samples: stageMs.n,
      },
    };
  },
  get lastFrame() { return frameLog[frameLog.length - 1] || null; },
  // 离线评估用：只导出评估需要的轻量字段（video_time + 每人框/flags），
  // 不带 kp/signals 等大字段。MOT17 gt 只需要框；flags 用来统计动作触发率
  // （没有动作标注，只能发现明显误报）。web/test/mot17-eval.mjs 读它。
  get frameSummary() {
    return frameLog.map((f) => ({
      video_time: f.video_time,
      verdicts: (f.verdicts || []).map((v) => ({
        track_id: v.track_id,
        bbox: v.bbox,
        flags: v.flags || null,
        frozen: !!v.frozen,
        posture: v.posture ?? null,
      })),
    }));
  },
  get ui() {
    return {
      posture: $('posture').textContent,
      meta: $('postureMeta').textContent,
      handMeta: $('handMeta').textContent,
      handL: $('handL').textContent,
      handR: $('handR').textContent,
      armHint: $('armHint').textContent,
      accuracyItems: document.querySelectorAll('#accList .acc-item').length,
      accuracyLoaded: !!accuracyReport,
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
// 准确率先渲染「未评估」，报告到了再刷新；报告只影响文案，不阻塞模型加载
refreshAccuracy();
loadAccuracyReport().then((r) => {
  accuracyReport = r;
  refreshAccuracy();
  updateUI();
});
// profile 先就绪再允许输入：参数变过之后记录才属于同一套阈值
profileReady = initProfile().catch((e) => {
  setStatus(`profile 初始化失败：${e.message}`, 'err');
}).finally(() => { profileLoaded = true; });
profileReady.then(() => { if (autoSrc) ensureEstimator(); });
