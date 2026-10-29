#!/usr/bin/env node
// evaluate.mjs — 离线评估与阈值拟合（PLAN §12.3 的 A 与 B）
//
// 为什么需要它：Demo 的「导出 JSON」里已经有全部关键点，但从导出到「这个动作准不准」之间没有桥。
// 没有这座桥，改阈值就只能靠感觉，改完也不知道是变好还是变坏（PLAN §12.2 根因 #1）。
//
// 用法：
//   node web/test/evaluate.mjs --input clips/a.json --labels labels/a.json
//   node web/test/evaluate.mjs --dir eval-data            # 目录下 *.frames.json 配同名 *.labels.json
//   node web/test/evaluate.mjs --dir eval-data --report out.md
//   node web/test/evaluate.mjs --dir eval-data --fit      # 用标好的数据算阈值分位（B 阶段）
//   node web/test/evaluate.mjs --dir eval-data --profile web/profiles/fitness.json
//   node web/test/evaluate.mjs --input a.jsonl --autolabel --out a.labels.json   # 生成标注草稿
//
// 输入是 Demo 导出的 JSON（{ frames: [...] }）。labels 文件见 docs/eval.md。
// 这个工具只复算、不改任何素材：评估结果和 Demo 现场看到的应当一致，不一致就是 export 或契约有 bug。

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignalEngine } from '../js/signals.js';
import { ActionEngine, ARM_ACTIONS } from '../js/actions.js';
import { resolveParams, profileParams, profileName, paramsHash } from '../js/params.js';

// —— 参数 ---------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    dir: null, input: null, labels: null, report: null, profile: null, out: null,
    compare: null, baseline: null, sweep: null, sweepActions: null,
    minRecall: null, minPrecision: null, maxCountErr: null, maxDrop: 0.05,
    fit: false, json: false, quiet: false, timeline: false, autolabel: false, every: 1,
  };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} 需要数值：${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dir') out.dir = next();
    else if (a === '--input') out.input = next();
    else if (a === '--labels') out.labels = next();
    else if (a === '--report') out.report = next();
    else if (a === '--profile') out.profile = next();
    else if (a === '--out') out.out = next();
    else if (a === '--compare') out.compare = [next(), next()];
    else if (a === '--baseline') out.baseline = next();
    else if (a === '--sweep') out.sweep = next();
    else if (a === '--sweep-actions') out.sweepActions = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--min-recall') out.minRecall = num(next(), '--min-recall');
    else if (a === '--min-precision') out.minPrecision = num(next(), '--min-precision');
    else if (a === '--max-count-err') out.maxCountErr = num(next(), '--max-count-err');
    else if (a === '--max-drop') out.maxDrop = num(next(), '--max-drop');
    else if (a === '--fit') out.fit = true;
    else if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--timeline') out.timeline = true;
    else if (a === '--autolabel') out.autolabel = true;
    else if (a === '--every') out.every = Math.max(1, Number(next()) || 1);
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`未知参数 ${a}`);
  }
  for (const k of ['minRecall', 'minPrecision']) {
    if (out[k] !== null && (out[k] < 0 || out[k] > 1)) throw new Error(`--${k === 'minRecall' ? 'min-recall' : 'min-precision'} 必须在 0~1 之间`);
  }
  if (out.maxCountErr !== null && out.maxCountErr < 0) throw new Error('--max-count-err 不能为负');
  return out;
}

const USAGE = `用法:
  node web/test/evaluate.mjs --input <frames.json> --labels <labels.json>
  node web/test/evaluate.mjs --dir <目录> [--profile <profile.json>] [--fit] [--report <out.md>] [--json]
  node web/test/evaluate.mjs --input <frames.json> --timeline [--every N]
  node web/test/evaluate.mjs --input <frames.json> --autolabel [--out <labels.json>]
  node web/test/evaluate.mjs --dir <目录> --compare <A.json> <B.json> [--json] [--report <out.md>]
  node web/test/evaluate.mjs --dir <目录> --sweep <a.b.c> [--sweep-actions <a,b>]

  --timeline        逐帧打印信号与判定，用于对着视频做标注（不是评估）
  --every N         配合 --timeline，每 N 帧打一行（默认 1）
  --autolabel       按当前规则生成 labels 草稿（只含正例，反例仍需人工补）
  --out             配合 --autolabel，写入文件；不给则打印到 stdout
  --compare A B     同一批素材跑两套 profile，输出指标差与判定变化的段
  --sweep <key>     数值参数 ±10%/±20% 的灵敏度扫描，如 actions.reps.squat.down
  --sweep-actions   只列出这几个动作的扫描结果（默认只列发生变化的）
  --min-recall R    每个有数据的动作 recall 下限（0~1），未达标退出码 2
  --min-precision P 同上，precision 下限
  --max-count-err E 计数误差上限（每 N 次）
  --baseline <报告> 用 --json 导出的旧报告做基线，下降超过 --max-drop（默认 0.05）即失败

labels 文件格式见 docs/eval.md。反例写法：{\"action\":\"onHips\",\"expect\":false} 或 \"!onHips\"；
\"none\" = 姿态和手臂都不许出现；\"noArm\" = 姿态不限，但不许有手臂动作。`;

// —— 输入读取 -----------------------------------------------------------

/** 接受三种输入：Demo 导出（{frames}）、裸数组（frames）、JSONL（一行一条） */
function normalizeFrames(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.frames)) return raw.frames;
  if (raw && Array.isArray(raw.records)) return raw.records;
  throw new Error('无法识别的帧文件：需要 {frames:[...]}、[...] 或 JSONL');
}

// meta 行（首行）里对评估有意义的字段。profile_model 与数据实际 model 不一致时报告要警告。
const META_KEYS = [
  'schema', 'exported_at', 'kp_format', 'hand_kp_format',
  'model', 'delegate', 'hand_model', 'infer_fps',
  'profile', 'profile_model', 'params_hash', 'params',
  'fps', 'frame_count',
];

function metaFrom(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const k of META_KEYS) if (obj[k] !== undefined) out[k] = obj[k];
  return Object.keys(out).length ? out : null;
}

/** 数组上加一个非元素属性，调用方不用改签名就能拿到 meta（JSON.stringify 不会带它）。 */
function attachMeta(frames, meta) {
  if (meta) frames.meta = meta;
  return frames;
}

function parseJsonl(text) {
  const objs = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  // Demo 的 JSONL 首行是 meta（带 schema/exported_at、没有 persons）；
  // 其余的才是帧记录。整份都当帧会把 meta 喂给信号层。
  const metaRow = objs.find((o) => o && !Array.isArray(o.persons)
    && (o.schema !== undefined || o.frame_count !== undefined));
  const frames = objs.filter((o) => o && Array.isArray(o.persons));
  return attachMeta(frames, metaFrom(metaRow));
}

/**
 * 读帧文件。三种格式都要支持：
 *   Demo 导出 {frames:[...]} / 裸数组 [...] / JSONL（一行一条）
 * 判断依据是**整份文件能否解析成一个 JSON 值**，而不是首字符——
 * JSONL 的每行以 { 开头，只看首字符会把合法 JSONL 送进 JSON.parse 而抛异常。
 * 返回的数组带 `meta` 属性（有的话），报告用它回显数据出自哪套模型/阈值。
 */
export async function loadFrames(file) {
  const text = await readFile(file, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${file}: 空文件`);

  if (trimmed.startsWith('[')) {
    return normalizeFrames(JSON.parse(trimmed));
  }

  if (trimmed.startsWith('{')) {
    try {
      const raw = JSON.parse(trimmed);
      // 单条帧记录（带 kp_format）不是容器
      if (raw && !Array.isArray(raw.frames) && !Array.isArray(raw) && raw.kp_format !== undefined) return [raw];
      return attachMeta(normalizeFrames(raw), metaFrom(raw));
    } catch (e) {
      // 整体解析失败但有多行 → 当 JSONL 处理
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length > 1) return parseJsonl(text);
      throw e;
    }
  }

  return parseJsonl(text);
}

async function loadLabels(file) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  if (Array.isArray(raw)) return { segments: raw, clips: undefined };
  if (!Array.isArray(raw.segments)) throw new Error(`${file}: 缺少 segments 数组`);
  return raw;
}

// —— 复算：帧记录 → 信号 → 动作 -----------------------------------------

/**
 * 导出记录里的 persons[0] 已经是统一契约，直接喂给信号层（从 kp 重算，不用 export 里的 signals）。
 * kp_world 必须一起带上：动作层用 has_world 在 2D/3D 之间选，漏了它评估就永远走 2D，
 * 和页面上的判定不是同一套规则。
 */
function personFromFrame(frame) {
  const p = frame.persons && frame.persons[0];
  if (!p) return null;
  return {
    track_id: p.track_id ?? 0,
    bbox: p.bbox,
    kp: p.kp,
    kp_world: Array.isArray(p.kp_world) && p.kp_world.length >= 33 ? p.kp_world : null,
    scale: p.scale,
    score: p.score,
    kp_format: p.kp_format,
  };
}

/**
 * 逐帧复算。同一段素材必须用**同一个** SignalEngine/ActionEngine 实例，
 * 否则滤波与短时窗每帧重置，动作永远出不来。
 */
export function replay(frames, params = {}) {
  const se = new SignalEngine(params);
  const ae = new ActionEngine(params);
  const out = [];
  for (const f of frames) {
    const person = personFromFrame(f);
    if (!person) {
      out.push({ ts: f.ts, empty: true, postureId: null, frozen: true, flags: {}, reps: null, sig: null });
      continue;
    }
    const sig = se.update(person, f.ts);
    const act = ae.update(sig, f.ts);
    out.push({ ts: f.ts, empty: false, sig, act });
  }
  return out;
}

// —— 时间段运算 ---------------------------------------------------------

/**
 * labels 段的时间写法，按优先级：
 *   startSec / endSec      —— 视频秒数（对着播放器读数，最直观）
 *   start / end            —— 毫秒（与 frames.ts 同基准，即 performance.now）
 *   startFrame / endFrame  —— 帧序号（0 起，按 frames 数组下标）
 * 返回 [startMs, endMs]，统一换成 ts 基准。
 */
function resolveRange(seg, frames) {
  const at = (i) => frames[Math.min(Math.max(i, 0), frames.length - 1)];

  if (Number.isFinite(seg.startSec) && Number.isFinite(seg.endSec)) {
    // 优先用视频时间；没有 video_time 时退回 ts 相对首帧的偏移
    const hasVideo = frames.some((f) => Number.isFinite(f.video_time));
    if (hasVideo) {
      const t0 = frames[0].ts;
      const toTs = (sec) => {
        const hit = frames.find((f) => Number.isFinite(f.video_time) && f.video_time >= sec);
        return hit ? hit.ts : frames[frames.length - 1].ts;
      };
      return [Math.max(toTs(seg.startSec), t0), toTs(seg.endSec)];
    }
    const t0 = frames[0].ts;
    return [t0 + seg.startSec * 1000, t0 + seg.endSec * 1000];
  }

  if (Number.isFinite(seg.start) && Number.isFinite(seg.end)) return [seg.start, seg.end];

  if (Number.isFinite(seg.startFrame) && Number.isFinite(seg.endFrame)) {
    const s = at(seg.startFrame)?.ts;
    const e = at(seg.endFrame)?.ts;
    if (Number.isFinite(s) && Number.isFinite(e)) return [s, e];
  }

  throw new Error(`label 段缺少时间范围：${JSON.stringify(seg)}`);
}

const overlaps = (a, b) => a[0] <= b[1] && b[0] <= a[1];

/**
 * 动作序列 → 连续为真的区间。
 * 连续的 on 采样**永远合并**；中间断了 off 的，只有间隔不超过 mergeMs 才接回去。
 * 之前只看 `ts - cur[1] <= mergeMs`，默认 mergeMs=0 时每帧都会断开成一个区间——
 * 判定只用 overlap 所以看不出来，但「翻转次数」这类统计会直接失真。
 */
function activeRanges(series, mergeMs = 0) {
  const ranges = [];
  let cur = null;
  let lastOnTs = null;
  let prevTs = null;
  for (const { ts, on } of series) {
    if (on) {
      const prevWasOn = prevTs !== null && lastOnTs === prevTs;
      if (cur && (prevWasOn || ts - lastOnTs <= mergeMs)) {
        cur[1] = ts;
      } else {
        if (cur) ranges.push(cur);
        cur = [ts, ts];
      }
      lastOnTs = ts;
    }
    // 不在 off 时立刻关闭：短于 mergeMs 的 off 间隙要能被下一次 on 接回去
    prevTs = ts;
  }
  if (cur) ranges.push(cur);
  return ranges;
}

// —— 评估单段素材 -------------------------------------------------------

const POSTURE_IDS = ['stand', 'sit', 'squat_static', 'lying'];
const REP_IDS = ['squat', 'pushup', 'clap', 'grasp'];
/**
 * 手臂 flag 列表**从 ARM_ACTIONS 派生**，不手抄。
 * 手抄过一次，新增 bothHandsUp/handAtHead 时就漏了——标注这两个动作会得到「未知动作名」，
 * 而这正是本轮新增、最需要被度量的两个。
 */
const ARM_ID_TO_FLAG = {
  arm_raised: 'armRaised', both_up: 'bothHandsUp', wave: 'waving',
  crossed: 'crossed', hips: 'onHips', arms_open: 'armsOpen', hand_head: 'handAtHead',
  reach: 'reaching', carry: 'carrying', point: 'pointing',
  arm_front: 'armFront', arm_side: 'armSide',
};
const FLAG_IDS = ARM_ACTIONS.map((a) => ARM_ID_TO_FLAG[a.id]).filter(Boolean);

// —— 段语义：正例 / 反例 -------------------------------------------------
// PLAN §13 R1：没有反例语法，「站着没叉腰」就写不出来，手臂的 precision 永远测不了。

const NEG_PREFIX = '!';
const NO_ACTIVITY = 'none';
const NO_ARM = 'noArm';

/**
 * 解析段的语义：
 *   action                   → 期望出现
 *   "!action" / expect:false → 期望不出现（反例）
 *   "none"                   → 姿态和手臂都不得出现（人不在场 / 完全无动作）
 *   "noArm"                  → 姿态不限，但不得出现任何手臂动作
 * `none` / `noArm` 本质是反例，写 expect:true 也不改变。
 */
/** 标注里的动作名可以是 ARM_ACTIONS 的 id，也可以是内部 flag 名，两者都接受 */
const canonical = (action) => ARM_ID_TO_FLAG[action] || action;

export function parseSegment(seg) {
  let action = String(seg.action ?? '');
  let expect = seg.expect === undefined ? true : !!seg.expect;
  if (action.startsWith(NEG_PREFIX)) { action = action.slice(NEG_PREFIX.length); expect = false; }
  if (action === NO_ACTIVITY || action === NO_ARM) expect = false;
  return { action: canonical(action), expect };
}

/** 某个动作在时间线上的逐帧真值序列。返回 null 表示不认识这个动作名。 */
function seriesOf(timeline, action) {
  if (POSTURE_IDS.includes(action)) {
    return timeline.map((r) => ({ ts: r.ts, on: !r.empty && r.act.postureId === action }));
  }
  if (FLAG_IDS.includes(action)) {
    return timeline.map((r) => ({ ts: r.ts, on: !r.empty && !!r.act.flags[action] }));
  }
  if (action === NO_ACTIVITY) {
    return timeline.map((r) => ({
      ts: r.ts,
      on: !r.empty && (!!r.act.postureId || Object.values(r.act.flags).some(Boolean)),
    }));
  }
  if (action === NO_ARM) {
    return timeline.map((r) => ({ ts: r.ts, on: !r.empty && Object.values(r.act.flags).some(Boolean) }));
  }
  return null;
}

/** 某计数动作在时间窗内的增量（用窗口前一帧做基线，避免跨段算错）。 */
function repDelta(timeline, action, range) {
  const inside = timeline.filter((r) => r.ts >= range[0] && r.ts <= range[1] && !r.empty);
  if (!inside.length) return 0;
  const base = timeline.filter((r) => r.ts < range[0] && !r.empty).pop();
  return inside[inside.length - 1].act.reps[action] - (base ? base.act.reps[action] : 0);
}

/** 时间窗内所有计数动作的非零增量。`none` 段用它把乱计数归到具体动作。 */
function repDeltas(timeline, range) {
  const out = {};
  for (const id of REP_IDS) {
    const n = repDelta(timeline, id, range);
    if (n > 0) out[id] = n;
  }
  return out;
}

/**
 * 一个时间段内**哪个**动作被误判成立（按帧计数，从多到少）。
 * 反例段必须能回答这个问题，否则误报只能记在 none 头上，
 * 各动作的 precision 永远是 1，等于没测精度（docs/eval.md 承诺的是归到动作）。
 */
function culprits(timeline, range, includePosture = true) {
  const tally = new Map();
  for (const r of timeline) {
    if (r.empty || r.ts < range[0] || r.ts > range[1]) continue;
    if (includePosture && r.act.postureId) tally.set(r.act.postureId, (tally.get(r.act.postureId) || 0) + 1);
    for (const f of FLAG_IDS) {
      if (r.act.flags[f]) tally.set(f, (tally.get(f) || 0) + 1);
    }
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

// —— 失败区间的证据 -----------------------------------------------------
// 只说"这个动作没判出来"不够用：要知道当时信号在什么范围，
// 才能区分"信号根本没到阈值"和"阈值定错了"。

const SIGNAL_GETTERS = {
  knee: (s) => s.knee_pick,
  elbow: (s) => s.elbow_pick,
  uprightness: (s) => s.uprightness,
  leg_vertical: (s) => s.leg_vertical,
  elev_L: (s) => s.armPose.elev_L,
  elev_R: (s) => s.armPose.elev_R,
  elev_torso_L: (s) => s.armPose.elev_torso_L,
  elev_torso_R: (s) => s.armPose.elev_torso_R,
  reach_L: (s) => s.armPose.reach_L,
  reach_R: (s) => s.armPose.reach_R,
  reach_head_L: (s) => s.armPose.reach_head_L,
  reach_head_R: (s) => s.armPose.reach_head_R,
  hands_close: (s) => s.armPose.hands_close,
  wave_flips: (s) => Math.max(s.wave.L, s.wave.R),
  wave_amp: (s) => s.wave.amp,
};

/** 每个动作判定真正依赖的信号。报错时只打这几列，避免整张信号表淹没有用信息。 */
const SIGNALS_FOR = {
  stand: ['uprightness', 'knee', 'leg_vertical'],
  squat_static: ['knee', 'uprightness'],
  sit: ['knee', 'uprightness', 'leg_vertical'],
  lying: ['uprightness', 'leg_vertical'],
  armRaised: ['elev_L', 'elev_R', 'elev_torso_L', 'elev_torso_R'],
  bothHandsUp: ['elev_L', 'elev_R', 'elev_torso_L', 'elev_torso_R', 'reach_L', 'reach_R'],
  waving: ['elev_L', 'elev_R', 'wave_flips', 'wave_amp'],
  crossed: ['hands_close', 'elev_L', 'elev_R'],
  onHips: ['reach_L', 'reach_R', 'hands_close'],
  armsOpen: ['elev_L', 'elev_R', 'reach_L', 'reach_R'],
  handAtHead: ['reach_head_L', 'reach_head_R'],
  squat: ['knee'],
  pushup: ['elbow', 'uprightness'],
  clap: ['hands_close'],
  [NO_ARM]: ['elev_L', 'elev_R', 'hands_close', 'reach_L', 'reach_R'],
};

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

function sigStats(timeline, range, names) {
  const buckets = Object.fromEntries(names.map((n) => [n, []]));
  for (const r of timeline) {
    if (r.empty || !r.sig || r.ts < range[0] || r.ts > range[1]) continue;
    for (const n of names) {
      const v = SIGNAL_GETTERS[n]?.(r.sig);
      if (Number.isFinite(v)) buckets[n].push(v);
    }
  }
  const out = {};
  for (const [n, arr] of Object.entries(buckets)) {
    if (!arr.length) { out[n] = null; continue; }
    const s = [...arr].sort((a, b) => a - b);
    out[n] = { min: round1(s[0]), p50: round1(s[Math.floor(s.length / 2)]), max: round1(s[s.length - 1]) };
  }
  return out;
}

/** 区间在素材里的位置：帧序号 + 视频秒数（没有 video_time 时给相对首帧秒数）。 */
function rangeContext(frames, range) {
  const t0 = frames.length ? frames[0].ts : 0;
  let i0 = frames.findIndex((f) => f.ts >= range[0]);
  if (i0 < 0) i0 = Math.max(frames.length - 1, 0);
  let i1 = i0;
  for (let i = i0; i < frames.length && frames[i].ts <= range[1]; i++) i1 = i;
  const v0 = Number.isFinite(frames[i0]?.video_time) ? frames[i0].video_time : null;
  const v1 = Number.isFinite(frames[i1]?.video_time) ? frames[i1].video_time : null;
  return {
    frames: [i0, i1],
    sec: [
      Math.round(((range[0] - t0) / 1000) * 100) / 100,
      Math.round(((range[1] - t0) / 1000) * 100) / 100,
    ],
    video: (v0 !== null || v1 !== null) ? [v0, v1] : null,
  };
}

/**
 * 一段素材评估。labels.segments 每段声明：
 *   { action, start/startSec/startFrame..., count?, tol?, expect? }
 *   action 可以是姿态 id、手臂 flag、rep 名、`none`、`noArm`，或加 `!` 前缀表示反例。
 * 反例段的 pass = 整个窗口内都没有出现该动作。
 */
export function evaluateClip(frames, labels, timeline) {
  const segments = labels.segments || [];
  const span = frames.length ? frames[frames.length - 1].ts - frames[0].ts : 0;

  const results = [];
  for (const seg of segments) {
    const range = resolveRange(seg, frames);
    const { action, expect } = parseSegment(seg);
    const ctx = rangeContext(frames, range);

    if (REP_IDS.includes(action)) {
      // 计数类：正例比较增量与期望次数；反例（!squat）期望 0，多出来的都算 FP
      const got = repDelta(timeline, action, range);
      const want = expect ? (seg.count ?? 1) : 0;
      const tol = seg.tol ?? (expect ? 1 : 0);
      const pass = Math.abs(got - want) <= tol;
      const r = { type: 'rep', action, expect, range, want, got, pass };
      if (!pass) r.fail = { ...ctx, signals: sigStats(timeline, range, SIGNALS_FOR[action]) };
      results.push(r);
      continue;
    }

    const series = seriesOf(timeline, action);
    if (!series) {
      results.push({
        type: 'unknown', action, expect, range, pass: false,
        error: `未知动作名 ${action}`, fail: ctx,
      });
      continue;
    }

    const intervals = activeRanges(series);
    const hits = intervals.filter((r) => overlaps(r, range));
    const hit = hits.length > 0;
    // none 声称「什么都不该发生」，所以窗口内的计数增量也要算误报。
    // 手臂反例（!onHips）不背这个锅：它只声明手臂状态，不声明有没有深蹲。
    const repFalseAlarms = action === NO_ACTIVITY ? repDeltas(timeline, range) : null;
    const repViolated = !!repFalseAlarms && Object.values(repFalseAlarms).some((n) => n > 0);
    const pass = expect ? hit : (!hit && !repViolated);
    const r = { type: 'state', action, expect, range, want: expect, got: hit, pass };
    if (repFalseAlarms) r.repFalseAlarms = repFalseAlarms;
    // 事件时延：标签起点 → 该动作在段内第一次为真。段开始时已经为真则记 0。
    // 只对通过的正例有意义：漏判没有"首次为真"，反例不设起点。
    if (expect && hit) r.latencyMs = Math.max(0, hits[0][0] - range[0]);

    if (!pass) {
      r.fail = {
        ...ctx,
        signals: sigStats(timeline, range, SIGNALS_FOR[action] || ['uprightness', 'knee']),
      };
      if (expect) {
        // 漏判：当时实际判成了什么，比「没出现」更有信息量（常见是串判到相邻姿态）
        r.fail.observed = culprits(timeline, range, true);
      } else if (action === NO_ACTIVITY) {
        // none 声称「什么都不该发生」：所有在跳的动作/姿态都算误报
        r.fail.falseAlarms = culprits(timeline, range, true);
      } else if (action === NO_ARM) {
        // noArm 只追究手臂，站立不算它的错
        r.fail.falseAlarms = culprits(timeline, range, false);
      } else {
        // 单动作反例（!onHips）：只有它自己算误报。
        // 把同时成立的 stand 也记成 FP，会把 stand 的 precision 一起拉低 —— 那并不是 stand 判错了。
        r.fail.falseAlarms = [action];
      }
    }

    results.push(r);
  }

  // 每个动作在整段素材里的「状态段数」（off→on 次数），用于抖动统计。
  // 与标注无关：只统计模型自己报了多少次，所以没标注的动作也能看出抖不抖。
  const activity = {};
  for (const id of [...POSTURE_IDS, ...FLAG_IDS]) {
    activity[id] = activeRanges(seriesOf(timeline, id)).length;
  }

  return {
    clip: labels.name || labels.clip || null,
    camera: labels.camera ?? null,
    subject: labels.subject ?? null,
    lighting: labels.lighting ?? null,
    note: labels.note ?? null,
    frames: frames.length,
    duration_s: +(span / 1000).toFixed(2),
    activity,
    segments: results,
  };
}

// —— 汇总 ---------------------------------------------------------------

/**
 * Wilson 95% 置信区间（比例）。为什么不用 ±1.96·√(p(1-p)/n)：
 * n 小或 p 接近 0/1 时正态近似会给出小于 0 或大于 1 的边界，Wilson 不会。
 * 注意：段与段之间不是独立伯努利试验（同一段视频里高度相关），这是**近似**，
 * 但比裸点估计诚实——3 段素材报 100% 时，区间会明说"你什么也不知道"。
 */
export function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [
    +Math.max(0, center - half).toFixed(3),
    +Math.min(1, center + half).toFixed(3),
  ];
}

/**
 * 汇总成每动作一行。反例的误报归到**实际误报的动作**上，不记在 `none`/`noArm` 头上，
 * 否则每个动作的 precision 恒为 1（PLAN §13 R1）。
 * 计数误报有两个来源：`!squat` 这类反例段（got 直接记 FP），以及 `none` 段窗口内的增量。
 */
export function summarize(clipResults) {
  const byAction = new Map();
  const bump = (action) => {
    if (!byAction.has(action)) byAction.set(action, { tp: 0, fn: 0, fp: 0, repAbs: 0, repN: 0 });
    return byAction.get(action);
  };
  for (const c of clipResults) {
    for (const s of c.segments) {
      if (s.type === 'unknown') continue;   // 标错动作名不算漏判，单独由报告列出
      if (s.type === 'rep') {
        if (s.expect) {
          const b = bump(s.action);
          b.repAbs += Math.abs(s.got - s.want);
          b.repN += s.want;
          if (s.pass) b.tp++; else b.fn++;
        } else if (s.got > 0) {
          // 反例计数段：多出来的每一次都是误报
          bump(s.action).fp += s.got;
        }
        continue;
      }
      if (!s.expect) {
        // 反例行本身不为空（noArm/none 不是动作）；只有归不了因时才记在它头上
        if (s.got) {
          const hit = s.fail?.falseAlarms?.length ? s.fail.falseAlarms : [null];
          for (const a of hit) {
            if (a === null) bump(s.action).fp++;
            else bump(a).fp++;
          }
        }
        for (const [a, n] of Object.entries(s.repFalseAlarms || {})) {
          if (n > 0) bump(a).fp += n;
        }
        continue;
      }
      if (s.got) bump(s.action).tp++; else bump(s.action).fn++;
    }
  }
  const rows = [];
  for (const [action, b] of [...byAction.entries()].sort()) {
    const nRecall = b.tp + b.fn;
    const nPrecision = b.tp + b.fp;
    const recall = nRecall > 0 ? +(b.tp / nRecall).toFixed(3) : null;
    const precision = nPrecision > 0 ? +(b.tp / nPrecision).toFixed(3) : null;
    rows.push({
      action,
      tp: b.tp, fn: b.fn, fp: b.fp,
      nRecall, nPrecision,
      recall, recallCI: recall === null ? null : wilson(b.tp, nRecall),
      precision, precisionCI: precision === null ? null : wilson(b.tp, nPrecision),
      countErr: b.repN ? +(b.repAbs / b.repN).toFixed(2) : null,
    });
  }
  return rows;
}

// —— 混淆矩阵与共现 -----------------------------------------------------
// 姿态是互斥的，可以做真混淆矩阵；手臂 flag 是多标签（可以同时成立），
// 做不了混淆矩阵，改成「共现矩阵」——它回答的是「哪些手臂动作总是一起报」。

const AMBIGUOUS = '__ambiguous__';

function countTimelineFrames(timeline, range) {
  let n = 0;
  for (const r of timeline) if (r.ts >= range[0] && r.ts <= range[1]) n++;
  return n;
}

/**
 * 帧级姿态混淆矩阵。真值只来自**姿态标注段**：
 *   - 正例姿态段 → 该姿态
 *   - `none` 段    → 'none'（它声明姿态和手臂都不许出现）
 *   - `!姿态` 段   → **不参与**（它只否认一个姿态，其余姿态是什么并不知道）
 * 同一帧被两个不同姿态段覆盖 → 标为冲突并跳过（这是标注错误，不是模型错误）。
 */
export function postureConfusion(timeline, labels, frames) {
  const labelsList = [...POSTURE_IDS, 'none'];
  const idx = new Map(labelsList.map((v, i) => [v, i]));
  const matrix = labelsList.map(() => labelsList.map(() => 0));
  const truth = new Array(timeline.length).fill(null);
  let negatedSkipped = 0;

  const assign = (range, value) => {
    for (let i = 0; i < timeline.length; i++) {
      const r = timeline[i];
      if (r.ts < range[0] || r.ts > range[1]) continue;
      if (truth[i] === null) truth[i] = value;
      else if (truth[i] !== value) truth[i] = AMBIGUOUS;
    }
  };

  for (const seg of labels.segments || []) {
    const { action, expect } = parseSegment(seg);
    const isPosture = POSTURE_IDS.includes(action);
    const isNone = action === NO_ACTIVITY;
    if (!isPosture && !isNone) continue;
    let range;
    try { range = resolveRange(seg, frames); } catch { continue; }
    if (isNone) { assign(range, 'none'); continue; }
    if (!expect) { negatedSkipped += countTimelineFrames(timeline, range); continue; }
    assign(range, action);
  }

  let counted = 0;
  let emptySkipped = 0;
  let ambiguous = 0;
  for (let i = 0; i < timeline.length; i++) {
    if (truth[i] === null) continue;
    if (truth[i] === AMBIGUOUS) { ambiguous++; continue; }
    const r = timeline[i];
    if (r.empty || !r.act) { emptySkipped++; continue; }
    const pred = POSTURE_IDS.includes(r.act.postureId) ? r.act.postureId : 'none';
    matrix[idx.get(truth[i])][idx.get(pred)]++;
    counted++;
  }

  return {
    labels: labelsList, matrix, frames: counted,
    emptySkipped, ambiguous, negatedSkipped,
    labeledFrames: counted + emptySkipped + ambiguous,
  };
}

export function mergeConfusions(list) {
  const labelsList = [...POSTURE_IDS, 'none'];
  const matrix = labelsList.map(() => labelsList.map(() => 0));
  const out = { labels: labelsList, matrix, frames: 0, emptySkipped: 0, ambiguous: 0, negatedSkipped: 0, labeledFrames: 0 };
  for (const c of list) {
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) matrix[i][j] += c.matrix[i][j];
    }
    out.frames += c.frames;
    out.emptySkipped += c.emptySkipped;
    out.ambiguous += c.ambiguous;
    out.negatedSkipped += c.negatedSkipped;
    out.labeledFrames += c.labeledFrames;
  }
  return out;
}

/** 手臂 flag 共现矩阵：matrix[i][j] = 第 i、j 个 flag 同时为真的帧数。 */
export function armCooccurrence(timeline) {
  const labels = [...FLAG_IDS];
  const matrix = labels.map(() => labels.map(() => 0));
  let frames = 0;
  for (const r of timeline) {
    if (r.empty || !r.act) continue;
    frames++;
    const on = [];
    for (let i = 0; i < labels.length; i++) if (r.act.flags[labels[i]]) on.push(i);
    for (const i of on) for (const j of on) matrix[i][j]++;
  }
  return { labels, matrix, frames };
}

export function mergeArms(list) {
  const labels = [...FLAG_IDS];
  const matrix = labels.map(() => labels.map(() => 0));
  let frames = 0;
  for (const a of list) {
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) matrix[i][j] += a.matrix[i][j];
    }
    frames += a.frames;
  }
  return { labels, matrix, frames };
}

// —— 分组统计 -----------------------------------------------------------

/**
 * 按 clip 上的某个字段（camera/subject）分组汇总。没有该字段的段归入"(未标注)"。
 * 跨组退化只统计**有名字的组**：把"未标注"混进来算极差，等于拿未知当对照组。
 */
export function groupSummaries(clips, key) {
  const buckets = new Map();
  for (const c of clips) {
    const name = (typeof c[key] === 'string' && c[key]) ? c[key] : '(未标注)';
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(c);
  }
  const groups = [...buckets.entries()]
    .map(([name, cs]) => ({ name, clips: cs.length, summary: summarize(cs) }))
    .sort((a, b) => {
      if (a.name === '(未标注)') return 1;
      if (b.name === '(未标注)') return -1;
      return a.name.localeCompare(b.name);
    });

  const named = groups.filter((g) => g.name !== '(未标注)');
  const degradation = [];
  if (named.length >= 2) {
    const actions = [...new Set(named.flatMap((g) => g.summary.map((r) => r.action)))].sort();
    for (const action of actions) {
      const rows = named.map((g) => g.summary.find((r) => r.action === action)).filter(Boolean);
      const recalls = rows.map((r) => r.recall).filter((v) => v !== null);
      const precisions = rows.map((r) => r.precision).filter((v) => v !== null);
      if (recalls.length >= 2 || precisions.length >= 2) {
        degradation.push({
          action,
          groups: rows.length,
          recallSpread: recalls.length >= 2 ? +(Math.max(...recalls) - Math.min(...recalls)).toFixed(3) : null,
          precisionSpread: precisions.length >= 2 ? +(Math.max(...precisions) - Math.min(...precisions)).toFixed(3) : null,
        });
      }
    }
  }
  return { key, groups, degradation };
}

/**
 * 事件时延与抖动（R1 的最后两项）。
 * - 时延：正例段「标签起点 → 该动作第一次为真」的毫秒数；段开始时已经为真记 0。
 *   姿态类大多为 0（标注起点时动作往往已成立），真正有含义的是事件类（倒地、举手）。
 * - 抖动：动作从 off 变 on 的次数 ÷ 已标注素材总分钟数。一个连续状态段算一次翻转。
 *   只统计模型自己报了多少次，与标注无关，所以没标注的动作也能看出抖不抖。
 */
export function temporalStats(clips) {
  const totalMs = clips.reduce((s, c) => s + (Number.isFinite(c.duration_s) ? c.duration_s * 1000 : 0), 0);
  const minutes = totalMs / 60000;
  const runs = new Map();
  const labeled = new Set();
  const latencies = new Map();

  for (const c of clips) {
    for (const [action, n] of Object.entries(c.activity || {})) {
      runs.set(action, (runs.get(action) || 0) + n);
    }
    for (const s of c.segments) {
      if (!s.expect || !(POSTURE_IDS.includes(s.action) || FLAG_IDS.includes(s.action))) continue;
      labeled.add(s.action);
      if (Number.isFinite(s.latencyMs)) {
        if (!latencies.has(s.action)) latencies.set(s.action, []);
        latencies.get(s.action).push(s.latencyMs);
      }
    }
  }

  const actions = new Set([...runs.keys(), ...labeled]);
  const flicker = [...actions]
    .map((action) => {
      const n = runs.get(action) || 0;
      return {
        action,
        runs: n,
        perMinute: minutes > 0 ? +(n / minutes).toFixed(2) : null,
      };
    })
    .filter((r) => r.runs > 0 || labeled.has(r.action))
    .sort((a, b) => (b.perMinute ?? -1) - (a.perMinute ?? -1) || a.action.localeCompare(b.action));

  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  const at = (arr, q) => arr[Math.min(arr.length - 1, Math.max(0, Math.ceil(q * arr.length) - 1))];
  const latency = [...latencies.entries()].map(([action, arr]) => {
    const s = sorted(arr);
    const median = s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    return {
      action,
      n: s.length,
      medianMs: Math.round(median),
      p95Ms: Math.round(at(s, 0.95)),
      maxMs: Math.round(s[s.length - 1]),
    };
  }).sort((a, b) => b.n - a.n || a.action.localeCompare(b.action));

  return { minutes: +minutes.toFixed(3), flicker, latency };
}

/** 逐帧表：标注时对着视频看，比凭空猜时间点可靠得多 */
export function toTimeline(frames, timeline, every = 1) {
  const lines = [];
  lines.push('| 视频秒 | 帧 | 膝角 | 肘角 | 直立 | 腿竖 | 抬臂L/R | 抬臂3D | 姿态 | 计数(蹲/俯/掌) | 手臂 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  const flagNames = ['armRaised', 'waving', 'crossed', 'onHips', 'armsOpen', 'bothHandsUp', 'handAtHead'];
  for (let i = 0; i < timeline.length; i += every) {
    const r = timeline[i];
    const f = frames[i];
    const sec = Number.isFinite(f?.video_time) ? f.video_time.toFixed(2)
      : f ? ((f.ts - frames[0].ts) / 1000).toFixed(2) : '—';
    if (r.empty) {
      lines.push(`| ${sec} | ${i} | — | — | — | — | — | (未检出) | — | — |`);
      continue;
    }
    const s = r.sig;
    const n = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
    const on = flagNames.filter((k) => r.act.flags[k]).map((k) => k).join('+') || '—';
    lines.push(`| ${sec} | ${i} | ${n(s.knee_pick)} | ${n(s.elbow_pick)} | ${n(s.uprightness, 2)}`
      + ` | ${n(s.leg_vertical, 2)} | ${n(s.armPose.elev_L)}/${n(s.armPose.elev_R)}`
      + ` | ${s.armPose.has_world ? `${n(s.armPose.elev_torso_L)}/${n(s.armPose.elev_torso_R)}` : '无'}`
      + ` | ${r.act.postureId || '—'}`
      + ` | ${r.act.reps.squat}/${r.act.reps.pushup}/${r.act.reps.clap} | ${on} |`);
  }
  return lines.join('\n');
}

// —— B 阶段：阈值分位拟合 -----------------------------------------------

const quantile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return +s[i].toFixed(1);
};

/**
 * 每个信号按**标注动作段**分组给出分位（PLAN §12.3 B）。
 * 关键点：深蹲的下阈要取「蹲到底」那段的低分位，上阈取「站直」段的高分位；
 * 拿全体帧的分位去定阈值，等于把蹲和站混在一起，定出来的值没有意义。
 */
function fitThresholds(labelsByClip, timelines, framesByClip) {
  const SIGNALS = {
    knee: (s) => s.knee_pick,
    elbow: (s) => s.elbow_pick,
    uprightness: (s) => s.uprightness,
    leg_vertical: (s) => s.leg_vertical,
    elev_L: (s) => s.armPose.elev_L,
    elev_R: (s) => s.armPose.elev_R,
    // 3D 抬臂角：接 RTMPose 等世界坐标不在髋心的适配器时，这条才是定阈值的依据
    elev_torso_L: (s) => s.armPose.elev_torso_L,
    elev_torso_R: (s) => s.armPose.elev_torso_R,
    reach_head_L: (s) => s.armPose.reach_head_L,
    reach_head_R: (s) => s.armPose.reach_head_R,
    reach_L: (s) => s.armPose.reach_L,
    reach_R: (s) => s.armPose.reach_R,
    hands_close: (s) => s.armPose.hands_close,
  };

  const groups = new Map();   // `${action}/${signal}` → number[]
  const push = (key, v) => {
    if (!Number.isFinite(v)) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  };

  for (let i = 0; i < timelines.length; i++) {
    const timeline = timelines[i];
    const labels = labelsByClip[i];
    const frames = framesByClip[i];
    if (!labels || !frames) continue;
    for (const seg of labels.segments || []) {
      // 反例段不能用来定阈值：它描述的是「不该出现」的状态，不是动作本身的信号分布。
      // 混进来会把 P5/P95 拉向反例（例如 `!onHips` 里自然下垂的臂距）。
      const parsed = parseSegment(seg);
      if (!parsed.expect) continue;
      let range;
      try { range = resolveRange(seg, frames); } catch { continue; }
      // 计数段的分位同样要统计：深蹲下阈就看这一段里膝角的低分位
      const bucket = REP_IDS.includes(parsed.action) ? `${parsed.action}_baseline` : parsed.action;
      for (const r of timeline) {
        if (r.empty || !r.sig || r.ts < range[0] || r.ts > range[1]) continue;
        for (const [name, get] of Object.entries(SIGNALS)) push(`${bucket}/${name}`, get(r.sig));
      }
    }
  }

  const out = {};
  for (const [key, vals] of [...groups.entries()].sort()) {
    out[key] = {
      n: vals.length,
      p5: quantile(vals, 0.05),
      p50: quantile(vals, 0.5),
      p95: quantile(vals, 0.95),
      min: quantile(vals, 0),
      max: quantile(vals, 1),
    };
  }
  return out;
}

// —— 门槛 ---------------------------------------------------------------

function baselineRows(raw) {
  const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.summary) ? raw.summary : null);
  if (!rows) throw new Error('baseline 需要评估报告里的 summary 数组（用 --json 导出的报告）');
  return new Map(rows.filter((r) => r && typeof r.action === 'string').map((r) => [r.action, r]));
}

/**
 * 门槛判定（PLAN §13 R1）。两类：
 *   绝对门槛：每个**有数据**的动作都要达到 minRecall / minPrecision / 计数误差上限
 *   相对基线：任何动作相对 baseline 下降超过 maxDrop 也算失败
 * recall/precision 为 null 的动作不参与判定，否则只有 FP 没有正例的动作会永远失败。
 */
export function evaluateGates(summary, opts = {}) {
  const {
    minRecall = null, minPrecision = null, maxCountErr = null, maxDrop = 0.05, baseline = null,
  } = opts;
  const violations = [];
  for (const row of summary || []) {
    if (row.recall !== null && Number.isFinite(minRecall) && row.recall < minRecall) {
      violations.push({ action: row.action, metric: 'recall', value: row.recall, threshold: minRecall, kind: 'min' });
    }
    if (row.precision !== null && Number.isFinite(minPrecision) && row.precision < minPrecision) {
      violations.push({ action: row.action, metric: 'precision', value: row.precision, threshold: minPrecision, kind: 'min' });
    }
    if (row.countErr !== null && Number.isFinite(maxCountErr) && row.countErr > maxCountErr) {
      violations.push({ action: row.action, metric: 'countErr', value: row.countErr, threshold: maxCountErr, kind: 'max' });
    }
  }
  if (baseline) {
    const base = baselineRows(baseline);
    for (const row of summary || []) {
      const b = base.get(row.action);
      if (!b) continue;
      for (const metric of ['recall', 'precision']) {
        if (row[metric] === null || row[metric] === undefined || b[metric] === null || b[metric] === undefined) continue;
        const floor = +(b[metric] - maxDrop).toFixed(3);
        if (row[metric] < floor) {
          violations.push({
            action: row.action, metric, value: row[metric],
            threshold: floor, baseline: b[metric], kind: 'baseline',
          });
        }
      }
    }
  }
  const configured = Number.isFinite(minRecall) || Number.isFinite(minPrecision)
    || Number.isFinite(maxCountErr) || !!baseline;
  return {
    configured,
    passed: violations.length === 0,
    thresholds: { minRecall, minPrecision, maxCountErr, maxDrop, baseline: !!baseline },
    violations,
  };
}

// —— 灵敏度扫描 ---------------------------------------------------------

function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== 'object') throw new Error(`--sweep 的路径不存在：${key}`);
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

/**
 * 生成阈值扰动参数集：±10% / ±20%。整数参数取整**并去重**
 * ——streak=3 的 ±10% 都会四舍五入回 3，不能拿同一个值跑两遍冒充敏感性。
 */
export function sweepVariants(baseParams, key, factors = [-0.2, -0.1, 0.1, 0.2]) {
  const base = resolveParams(baseParams);
  const value = getPath(base, key);
  if (!Number.isFinite(value)) throw new Error(`--sweep 的键必须是数值：${key}`);
  const seen = new Set([value]);
  const variants = [];
  for (const factor of factors) {
    const raw = value * (1 + factor);
    const v = Number.isInteger(value) ? Math.round(raw) : +raw.toFixed(3);
    if (seen.has(v)) continue;
    seen.add(v);
    const params = JSON.parse(JSON.stringify(base));
    setPath(params, key, v);
    variants.push({ factor, value: v, params });
  }
  return { key, baseValue: value, variants };
}

function deltaOrNull(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? +(b - a).toFixed(3) : null;
}

/** 扰动后的指标 vs 基准，只保留发生变化的行（或 --sweep-actions 指定的行）。 */
export function diffSummary(baseRows, rows, actionsFilter = null) {
  const base = new Map(baseRows.map((r) => [r.action, r]));
  const byAction = new Map(rows.map((r) => [r.action, r]));
  const actions = [...new Set([...baseRows, ...rows].map((r) => r.action))].sort();
  return actions.map((action) => {
    const r = byAction.get(action);
    const b = base.get(action) || {};
    // 变体里整行消失（例如误报被压到 0）也是一种变化，不能静默丢掉
    if (!r) {
      return {
        action, recall: null, recallDelta: null, precision: null, precisionDelta: null,
        countErr: null, countErrDelta: null, changed: true, removed: true,
      };
    }
    const d = {
      action,
      recall: r.recall, recallDelta: deltaOrNull(b.recall, r.recall),
      precision: r.precision, precisionDelta: deltaOrNull(b.precision, r.precision),
      countErr: r.countErr, countErrDelta: deltaOrNull(b.countErr, r.countErr),
    };
    d.changed = [d.recallDelta, d.precisionDelta, d.countErrDelta]
      .some((x) => x !== null && Math.abs(x) > 1e-9);
    return d;
  }).filter((r) => (actionsFilter ? actionsFilter.includes(r.action) : r.changed));
}

// —— profile 对比 -------------------------------------------------------

export function compareSummaries(aRows, bRows) {
  const actions = [...new Set([...aRows, ...bRows].map((r) => r.action))].sort();
  const aMap = new Map(aRows.map((r) => [r.action, r]));
  const bMap = new Map(bRows.map((r) => [r.action, r]));
  return actions.map((action) => {
    const a = aMap.get(action) || {};
    const b = bMap.get(action) || {};
    const row = {
      action,
      recallA: a.recall ?? null, recallB: b.recall ?? null, recallDelta: deltaOrNull(a.recall, b.recall),
      precisionA: a.precision ?? null, precisionB: b.precision ?? null, precisionDelta: deltaOrNull(a.precision, b.precision),
      countErrA: a.countErr ?? null, countErrB: b.countErr ?? null, countErrDelta: deltaOrNull(a.countErr, b.countErr),
    };
    row.changed = [row.recallDelta, row.precisionDelta, row.countErrDelta]
      .some((x) => x !== null && Math.abs(x) > 1e-9);
    return row;
  });
}

/** 同一批素材、同一份 labels，逐段比较两份参数下的判定是否变化。 */
export function compareSegments(clipsA, clipsB) {
  const out = [];
  for (let i = 0; i < clipsA.length; i++) {
    const a = clipsA[i];
    const b = clipsB[i];
    if (!a || !b) continue;
    const n = Math.max(a.segments.length, b.segments.length);
    for (let j = 0; j < n; j++) {
      const sa = a.segments[j];
      const sb = b.segments[j];
      if (!sa || !sb || sa.pass === sb.pass) continue;
      out.push({
        clip: a.clip,
        action: sa.action,
        sec: sa.fail?.sec ?? sb.fail?.sec ?? null,
        aPass: sa.pass,
        bPass: sb.pass,
        aGot: sa.got,
        bGot: sb.got,
      });
    }
  }
  return out;
}

// —— 报告 ---------------------------------------------------------------

const fmtSec = (v) => (Number.isFinite(v) ? v.toFixed(2) : '?');

function intervalLabel(s) {
  if (s.fail?.video && Number.isFinite(s.fail.video[0])) {
    return `${fmtSec(s.fail.video[0])}–${fmtSec(s.fail.video[1])}s`;
  }
  return s.fail?.sec ? `≈${fmtSec(s.fail.sec[0])}–${fmtSec(s.fail.sec[1])}s` : '?';
}

/** 失败区间里关键信号的 min/中位/max：判断「信号没到阈值」还是「阈值定错」的依据 */
function signalLabel(signals) {
  if (!signals) return '—';
  const parts = [];
  for (const [k, v] of Object.entries(signals)) {
    if (!v) continue;
    parts.push(`${k} ${v.min}/${v.p50}/${v.max}`);
  }
  return parts.length ? parts.join(' · ') : '—';
}

function expectationText(s) {
  if (s.type === 'rep') return `期望 ${s.want} 次，实测 ${s.got} 次`;
  if (s.type === 'unknown') return `未知动作名 ${s.action}`;
  return s.expect ? '期望出现，实测未出现' : '期望不出现，实测出现';
}

function evidenceText(s) {
  if (!s.expect) {
    const parts = [];
    if (s.fail?.falseAlarms?.length) parts.push(s.fail.falseAlarms.join(', '));
    for (const [a, n] of Object.entries(s.repFalseAlarms || {})) {
      if (n > 0) parts.push(`${a}×${n}`);
    }
    return parts.length ? parts.join(', ') : '—';
  }
  if (s.fail?.observed) return s.fail.observed.join(', ') || '—';
  return '—';
}

const fmtRate = (p, ci, n) => {
  if (p === null || p === undefined) return '—';
  const c = ci ? `${ci[0].toFixed(2)}–${ci[1].toFixed(2)}` : '?';
  return `${p} [${c}] (${n})`;
};

const fmtDelta = (d) => (d === null || d === undefined ? '—' : (d > 0 ? `+${d}` : `${d}`));
const fmtPct = (f) => `${f > 0 ? '+' : ''}${(f * 100).toFixed(0)}%`;

function renderGates(gates, lines) {
  if (!gates?.configured) return;
  const t = gates.thresholds;
  const rules = [];
  if (Number.isFinite(t.minRecall)) rules.push(`recall ≥ ${t.minRecall}`);
  if (Number.isFinite(t.minPrecision)) rules.push(`precision ≥ ${t.minPrecision}`);
  if (Number.isFinite(t.maxCountErr)) rules.push(`计数误差 ≤ ${t.maxCountErr}`);
  if (t.baseline) rules.push(`相对 baseline 下降 ≤ ${t.maxDrop}`);
  lines.push('## 门槛', '', `- ${rules.join('；')}`);
  lines.push(gates.passed ? '- ✅ 全部达标' : `- ❌ ${gates.violations.length} 项未达标`, '');
  if (gates.violations.length) {
    lines.push('| 动作 | 指标 | 实测 | 门槛 | 来源 |');
    lines.push('|---|---|---|---|---|');
    for (const v of gates.violations) {
      const src = v.kind === 'baseline' ? `baseline ${v.baseline}` : v.kind === 'min' ? '绝对门槛' : '上限';
      lines.push(`| ${v.action} | ${v.metric} | ${v.value} | ${v.threshold} | ${src} |`);
    }
    lines.push('');
  }
}

function renderConfusion(conf, lines) {
  if (!conf) return;
  const p = conf.postures;
  lines.push('## 姿态混淆矩阵（帧级）', '');
  if (!p || !p.frames) {
    lines.push('没有可用的姿态标注帧（只标了手臂/计数时不会生成）。', '');
  } else {
    lines.push(`行 = 标注，列 = 判定，共 ${p.frames} 帧；对角线是判对。`, '');
    lines.push(`| 标注 \\ 判定 | ${p.labels.join(' | ')} | 合计 | 行召回 |`);
    lines.push(`|---|${p.labels.map(() => '---').join('|')}|---|---|`);
    for (let i = 0; i < p.labels.length; i++) {
      const row = p.matrix[i];
      const total = row.reduce((s, v) => s + v, 0);
      const rec = total ? (row[i] / total).toFixed(2) : '—';
      lines.push(`| ${p.labels[i]} | ${row.join(' | ')} | ${total} | ${rec} |`);
    }
    lines.push('');
    lines.push(`> 跳过：未检出 ${p.emptySkipped} 帧，标注冲突 ${p.ambiguous} 帧，`
      + `\`!姿态\` 反例 ${p.negatedSkipped} 帧。冲突帧是标注错误（同一帧被标成两个姿态），不算模型错。`, '');
  }

  const a = conf.arms;
  if (a && a.frames) {
    lines.push('## 手臂共现（帧级）', '');
    lines.push(`matrix[i][j] = 第 i、j 个动作同时为真的帧数（共 ${a.frames} 帧）。`
      + '手臂是多标签、可以同时成立，不能做混淆矩阵。', '');
    lines.push(`| | ${a.labels.join(' | ')} |`);
    lines.push(`|---|${a.labels.map(() => '---').join('|')}|`);
    for (let i = 0; i < a.labels.length; i++) {
      lines.push(`| ${a.labels[i]} | ${a.matrix[i].join(' | ')} |`);
    }
    lines.push('');
  }
}

function renderGroups(groups, lines) {
  for (const [key, title] of [['camera', '机位'], ['subject', '受试']]) {
    const g = groups?.[key];
    if (!g || !g.groups.length) continue;
    // 全是"(未标注)"时不渲染：一整个分组表只有一行"(未标注)"，纯噪声
    if (!g.groups.some((x) => x.name !== '(未标注)')) continue;
    lines.push(`## 分组统计 · 按${title}`, '');
    for (const group of g.groups) {
      lines.push(`### ${group.name}（${group.clips} 段）`, '');
      lines.push('| 动作 | recall [95%CI] (n) | precision [95%CI] (n) | 计数误差 |');
      lines.push('|---|---|---|---|');
      for (const r of group.summary) {
        lines.push(`| ${r.action} | ${fmtRate(r.recall, r.recallCI, r.nRecall)}`
          + ` | ${fmtRate(r.precision, r.precisionCI, r.nPrecision)} | ${r.countErr ?? '—'} |`);
      }
      lines.push('');
    }
    if (g.degradation.length) {
      lines.push(`### 跨${title}退化`, '');
      lines.push('| 动作 | recall 极差 | precision 极差 | 组数 |');
      lines.push('|---|---|---|---|');
      for (const d of g.degradation) {
        lines.push(`| ${d.action} | ${d.recallSpread ?? '—'} | ${d.precisionSpread ?? '—'} | ${d.groups} |`);
      }
      lines.push('', '> 只统计有名字的组；"(未标注)"不参与极差，否则等于拿未知当对照组。', '');
    }
  }
}

function renderTemporal(t, lines) {
  if (!t || (!t.latency.length && !t.flicker.length)) return;
  lines.push('## 事件时延与抖动', '');
  lines.push(`已标注素材总时长 ${t.minutes} 分钟。`, '');

  lines.push('### 事件时延（标签起点 → 首次判定为真）', '');
  if (!t.latency.length) {
    lines.push('没有通过的正例段，无法测时延。', '');
  } else {
    lines.push('| 动作 | n | 中位 ms | P95 ms | 最大 ms |');
    lines.push('|---|---|---|---|---|');
    for (const r of t.latency) {
      lines.push(`| ${r.action} | ${r.n} | ${r.medianMs} | ${r.p95Ms} | ${r.maxMs} |`);
    }
    lines.push('', '> 姿态类多为 0：标注段起点时动作往往已经成立。真正有含义的是事件类（倒地、举手、挥手）。', '');
  }

  lines.push('### 抖动（状态翻转次数）', '');
  if (!t.flicker.length) {
    lines.push('没有可统计的动作。', '');
  } else {
    lines.push('| 动作 | 翻转次数 | 次/分钟 |');
    lines.push('|---|---|---|');
    for (const r of t.flicker) {
      lines.push(`| ${r.action} | ${r.runs} | ${r.perMinute ?? '—'} |`);
    }
    lines.push('', '> 翻转 = 该动作从 off 变为 on 的次数（一个连续状态段算一次）。数值越大判定越不稳。', '');
  }
}

function renderSweep(sweep, lines) {
  if (!sweep) return;
  lines.push(`## 灵敏度扫描 · \`${sweep.key}\`（基准 ${sweep.baseValue}）`, '');
  if (!sweep.variants.length) {
    lines.push('该参数 ±10%/±20% 取整后与原值相同，没有可扫描的变体。', '');
    return;
  }
  const rows = [];
  for (const v of sweep.variants) for (const d of v.deltas) rows.push({ v, d });
  if (!rows.length) {
    lines.push('±20% 内没有任何动作的指标发生变化。', '');
    return;
  }
  lines.push('| 值 | 倍率 | 动作 | recall | Δ | precision | Δ | 计数误差 | Δ |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const { v, d } of rows) {
    const action = d.removed ? `${d.action}（消失）` : d.action;
    lines.push(`| ${v.value} | ${fmtPct(v.factor)} | ${action}`
      + ` | ${d.recall ?? '—'} | ${fmtDelta(d.recallDelta)}`
      + ` | ${d.precision ?? '—'} | ${fmtDelta(d.precisionDelta)}`
      + ` | ${d.countErr ?? '—'} | ${fmtDelta(d.countErrDelta)} |`);
  }
  lines.push('', '> 只列出指标发生变化的动作；未列出表示该扰动没有影响。', '');
}

export function toMarkdown(report) {
  if (report.mode === 'compare') return toCompareMarkdown(report);
  const lines = [];
  lines.push('# 姿态动作评估报告', '');
  lines.push(`- 素材：${report.clips.length} 段，共 ${report.totalFrames} 帧`);
  lines.push(`- profile：${report.profile || '默认阈值'}`);
  if (report.paramsHash) lines.push(`- 参数指纹：${report.paramsHash}`);
  if (report.profileModel) lines.push(`- profile 声明模型：${report.profileModel}`);
  if (report.models?.length) lines.push(`- 数据模型：${report.models.join('、')}`);
  if (report.modelWarning) lines.push(`- ⚠ **${report.modelWarning}**`);
  lines.push(`- 生成时间：${new Date().toISOString()}`, '');

  lines.push('## 按动作汇总', '');
  lines.push('| 动作 | TP | FN | FP | recall [95%CI] (n) | precision [95%CI] (n) | 计数误差/次 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of report.summary) {
    lines.push(`| ${r.action} | ${r.tp} | ${r.fn} | ${r.fp}`
      + ` | ${fmtRate(r.recall, r.recallCI, r.nRecall)}`
      + ` | ${fmtRate(r.precision, r.precisionCI, r.nPrecision)} | ${r.countErr ?? '—'} |`);
  }
  lines.push('',
    '> recall 只统计正例段；precision 的 FP 来自反例段（`!动作` / `none` / `noArm`）以及 `none` 窗口内的乱计数。',
    '> 区间是 Wilson 95%，段之间并不独立，所以是近似——但 n=3 时它不会让你以为 100% 是真的。', '');

  renderGates(report.gates, lines);
  renderConfusion(report.confusion, lines);
  renderGroups(report.groups, lines);
  renderTemporal(report.temporal, lines);

  lines.push('## 逐段明细', '');
  for (const c of report.clips) {
    const bad = c.segments.filter((s) => !s.pass);
    lines.push(`### ${c.clip || '(未命名)'} — ${c.duration_s}s / ${c.frames} 帧`);
    const meta = [
      c.camera && `机位 ${c.camera}`,
      c.subject && `受试 ${c.subject}`,
      c.lighting && `光照 ${c.lighting}`,
      c.note && `备注 ${c.note}`,
    ].filter(Boolean).join(' · ');
    if (meta) lines.push(meta);
    lines.push(`通过 ${c.segments.length - bad.length}/${c.segments.length}`);
    if (bad.length) {
      lines.push('', '| 动作 | 期望/实测 | 区间 | 帧 | 关键信号（min/中位/max） | 实际出现 / 误报来源 |');
      lines.push('|---|---|---|---|---|---|');
      for (const s of bad) {
        lines.push(`| ${s.action} | ${expectationText(s)} | ${intervalLabel(s)}`
          + ` | ${s.fail?.frames ? s.fail.frames.join('–') : '—'}`
          + ` | ${signalLabel(s.fail?.signals)} | ${evidenceText(s)} |`);
      }
    }
    lines.push('');
  }

  renderSweep(report.sweep, lines);

  if (report.fit) {
    lines.push('## 信号分位 · 按标注动作段分组（用于替换手写阈值）', '');
    lines.push('| 动作 / 信号 | n | P5 | P50 | P95 | min | max |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const [k, v] of Object.entries(report.fit)) {
      lines.push(`| ${k} | ${v.n} | ${v.p5} | ${v.p50} | ${v.p95} | ${v.min} | ${v.max} |`);
    }
    lines.push('',
      '> 怎么用：深蹲的 `down` 取 `squat_static/knee` 的 P95 附近（蹲到底的角度），',
      '> `up` 取 `stand/knee` 的 P5 附近（站直的最低角）。留 10~15° 余量，不要贴着分位写。',
      '> 分位是「这段数据里 95% 的帧都低于此值」，不是阈值本身——阈值要靠留余量。',
      '> 反例段不参与分位计算。', '');
  }
  return lines.join('\n');
}

export function toCompareMarkdown(report) {
  const lines = [];
  lines.push('# profile 对比', '');
  lines.push(`- A：${report.a.label || '默认阈值'} · ${report.a.paramsHash}`);
  lines.push(`- B：${report.b.label || '默认阈值'} · ${report.b.paramsHash}`);
  if (report.a.models?.length) lines.push(`- 数据模型：${report.a.models.join('、')}`);
  if (report.a.modelWarning) lines.push(`- ⚠ **A：${report.a.modelWarning}**`);
  if (report.b.modelWarning) lines.push(`- ⚠ **B：${report.b.modelWarning}**`);
  lines.push(`- 素材：${report.totalFrames} 帧 / ${report.clipCount} 段标注`);
  lines.push(`- 生成时间：${new Date().toISOString()}`, '');

  lines.push('## 指标差异（Δ = B − A）', '');
  lines.push('| 动作 | recall A | B | Δ | precision A | B | Δ | 计数误差 A | B | Δ |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const d of report.deltas) {
    lines.push(`| ${d.action} | ${d.recallA ?? '—'} | ${d.recallB ?? '—'} | ${fmtDelta(d.recallDelta)}`
      + ` | ${d.precisionA ?? '—'} | ${d.precisionB ?? '—'} | ${fmtDelta(d.precisionDelta)}`
      + ` | ${d.countErrA ?? '—'} | ${d.countErrB ?? '—'} | ${fmtDelta(d.countErrDelta)} |`);
  }
  lines.push('');

  lines.push('## 判定变化的段', '');
  if (!report.changes.length) {
    lines.push('没有段的判定发生变化。', '');
  } else {
    lines.push('| 素材 | 动作 | 区间 | A | B |');
    lines.push('|---|---|---|---|---|');
    for (const c of report.changes) {
      const sec = c.sec ? `≈${fmtSec(c.sec[0])}–${fmtSec(c.sec[1])}s` : '—';
      const fmt = (pass, got) => `${pass ? '通过' : '失败'}${typeof got === 'number' ? ` (${got})` : ''}`;
      lines.push(`| ${c.clip || '(未命名)'} | ${c.action} | ${sec} | ${fmt(c.aPass, c.aGot)} | ${fmt(c.bPass, c.bGot)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// —— 标注草稿（PLAN §13 R1）---------------------------------------------
// 人工标注最贵的部分不是判断对错，而是「在时间轴上把起止秒数写出来」。
// 这一步交给当前规则生成，人只改边界、删误报、补反例。

/** 区间 → labels 的时间写法：有 video_time 用秒（对着播放器好读），否则用 ts 毫秒。 */
function timeFields(frames, startTs, endTs) {
  const withVideo = frames.filter((f) => Number.isFinite(f.video_time));
  if (withVideo.length) {
    const secAt = (ts) => {
      const hit = withVideo.find((f) => f.ts >= ts) || withVideo[withVideo.length - 1];
      return Math.round(hit.video_time * 100) / 100;
    };
    return { startSec: secAt(startTs), endSec: secAt(endTs) };
  }
  return { start: Math.round(startTs), end: Math.round(endTs) };
}

/**
 * 按当前规则生成 labels 草稿。**只产出正例**：姿态、手臂 flag、计数周期。
 * 反例（`none` / `!动作` / `noArm`）必须人工补 —— 规则不知道「当时其实在做什么」，
 * 自动生成反例等于用自己的判断给自己的准确率打分。
 *
 * 合并窗口 500 ms 是为了把 Hold/streak 造成的 1~2 帧断裂接回去；短于 minMs 的碎片直接丢。
 */
export function autoLabelClip(frames, timeline, { name = null, mergeMs = 500, minMs = 300 } = {}) {
  const segments = [];
  const add = (action, a, b, extra = {}) => {
    if (!(b > a)) return;
    segments.push({ action, ...timeFields(frames, a, b), ...extra });
  };

  for (const id of POSTURE_IDS) {
    for (const [a, b] of activeRanges(seriesOf(timeline, id), mergeMs)) {
      if (b - a >= minMs) add(id, a, b);
    }
  }
  for (const id of FLAG_IDS) {
    for (const [a, b] of activeRanges(seriesOf(timeline, id), mergeMs)) {
      if (b - a >= minMs) add(id, a, b);
    }
  }
  for (const id of REP_IDS) {
    let prev = null;
    for (let i = 0; i < timeline.length; i++) {
      const r = timeline[i];
      if (r.empty) { prev = null; continue; }
      const n = r.act.reps[id];
      if (prev !== null && n > prev) {
        // 周期起点 = 最近一次进入 down 相位的那帧；终点 = 计数的这一帧
        let start = i;
        for (let j = i; j >= 0; j--) {
          if (timeline[j].empty) break;
          const phase = timeline[j].act.repPhase?.[id];
          if (phase === 'down') start = j;
          else if (phase === 'up' && j < i) break;
        }
        add(id, timeline[start].ts, r.ts, { count: n - prev });
      }
      prev = n;
    }
  }

  const startOf = (s) => (Number.isFinite(s.startSec) ? s.startSec * 1000 : (s.start ?? 0));
  segments.sort((a, b) => startOf(a) - startOf(b));

  return {
    name: name || null,
    source: 'autolabel draft',
    generated_at: new Date().toISOString(),
    model: frames.meta?.model ?? null,
    note: '正例由当前规则自动生成，边界需人工校正；反例（none / !动作 / noArm）必须人工补，否则 precision 恒为 1。',
    segments,
  };
}

// —— 主流程 -------------------------------------------------------------

export async function pairsFromDir(dir) {
  const files = await readdir(dir);
  // 帧文件既可能是 .json（旧版 {frames} 容器）也可能是 .jsonl（当前导出格式）；
  // 排除 labels 与 autolabel 草稿，否则它们会被当成帧文件读进来。
  // 之前只认 .json，导致 README 里「导出 .jsonl 到 eval-data 再 --dir」的流程静默跳过全部素材。
  const isFrames = (f) => /\.(frames\.)?(json|jsonl)$/i.test(f)
    && !/\.labels(\.draft)?\.json$/i.test(f)
    // manifest.json / report.json 是清单与报告，不是素材（docs/data-collection.md）
    && !/^manifest([._-].*)?\.json$/i.test(f)
    && !/^report([._-].*)?\.json$/i.test(f);
  const baseOf = (f) => f
    .replace(/\.frames\.(json|jsonl)$/i, '')
    .replace(/\.(json|jsonl)$/i, '');
  const pairs = [];
  for (const f of files.filter(isFrames)) {
    const base = baseOf(f);
    const labelName = files.find((l) => l === `${base}.labels.json`);
    if (labelName) pairs.push({ frames: path.join(dir, f), labels: path.join(dir, labelName) });
    else pairs.push({ frames: path.join(dir, f), labels: null });
  }
  return pairs.sort((a, b) => a.frames.localeCompare(b.frames));
}

async function readProfile(file) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const params = profileParams(raw);
  const name = profileName(raw, path.basename(file));
  return {
    file,
    name,
    label: `${name}（${file}）`,
    model: typeof raw.model === 'string' && raw.model ? raw.model : null,
    params,
    hash: paramsHash(params),
  };
}

const DEFAULT_PROFILE = {
  file: null, name: 'default', label: null, model: null, params: {}, hash: paramsHash({}),
};

/** 读素材与标注。帧只读一次：A/B 对比和灵敏度扫描都在内存里换参数重放。 */
async function loadPairs(args) {
  const pairs = args.dir
    ? await pairsFromDir(args.dir)
    : [{ frames: args.input, labels: args.labels }];
  if (!pairs.length) throw new Error('没有找到任何帧文件');
  const loaded = [];
  for (const pair of pairs) {
    const frames = await loadFrames(pair.frames);
    let labels = null;
    if (pair.labels) {
      labels = await loadLabels(pair.labels);
      if (!labels.name) labels.name = path.basename(pair.frames);
    } else if (!args.quiet) {
      console.error(`跳过评估（无 labels）：${pair.frames}`);
    }
    loaded.push({ path: pair.frames, frames, labels, meta: frames.meta || null });
  }
  return loaded;
}

/** 用一组参数跑完整评估。confusion=false 时跳过混淆矩阵（扫描只需要 summary）。 */
function runEvaluation(loaded, params, { confusion = true } = {}) {
  const clips = [];
  const timelines = [];
  const clipLabels = [];
  const clipFrames = [];
  const confusions = [];
  const arms = [];
  let totalFrames = 0;
  for (const item of loaded) {
    totalFrames += item.frames.length;
    if (!item.labels) continue;
    const timeline = replay(item.frames, params);
    clips.push(evaluateClip(item.frames, item.labels, timeline));
    if (confusion) {
      confusions.push(postureConfusion(timeline, item.labels, item.frames));
      arms.push(armCooccurrence(timeline));
    }
    timelines.push(timeline);
    clipLabels.push(item.labels);
    clipFrames.push(item.frames);
  }
  return {
    clips, timelines, clipLabels, clipFrames, totalFrames,
    confusion: confusion ? { postures: mergeConfusions(confusions), arms: mergeArms(arms) } : null,
    temporal: temporalStats(clips),
  };
}

function modelInfo(loaded, profile) {
  const metas = loaded.map((i) => i.meta).filter(Boolean);
  const models = [...new Set(metas.filter((m) => m.model).map((m) => `${m.model}/${m.delegate ?? '?'}`))];
  const warning = profile.model && models.length && !models.some((m) => m.startsWith(`${profile.model}/`))
    ? `profile 声明 model=${profile.model}，数据实际为 ${models.join('、')}；这套阈值可能不适用`
    : null;
  return { models, warning };
}

/** 灵敏度扫描：同一批素材，逐个扰动值重放。只保留指标有变化的动作（或 --sweep-actions 指定的）。 */
function runSweep(loaded, profile, args, baseSummary = null) {
  const { key, baseValue, variants } = sweepVariants(profile.params, args.sweep);
  // 基准指标直接复用主评估的结果，不再重放一遍
  const baseRows = baseSummary || summarize(runEvaluation(loaded, profile.params, { confusion: false }).clips);
  const results = variants.map((v) => {
    const summary = summarize(runEvaluation(loaded, v.params, { confusion: false }).clips);
    return {
      factor: v.factor,
      value: v.value,
      summary,
      deltas: diffSummary(baseRows, summary, args.sweepActions),
    };
  });
  return { key, baseValue, baseSummary: baseRows, variants: results };
}

async function runSingle(args, loaded, profile) {
  const run = runEvaluation(loaded, profile.params);
  const gatesWanted = args.minRecall !== null || args.minPrecision !== null
    || args.maxCountErr !== null || !!args.baseline;
  // 空素材 + 门槛 = 假通过。宁可报错，也不要让 CI 在"什么都没测"时给绿灯。
  if (gatesWanted && !run.clips.length) throw new Error('门槛需要带 labels 的素材');
  if (args.sweep && !run.clips.length) throw new Error('--sweep 需要带 labels 的素材');
  const { models, warning } = modelInfo(loaded, profile);
  if (warning && !args.quiet) console.error(`⚠ ${warning}`);

  let baseline = null;
  if (args.baseline) baseline = JSON.parse(await readFile(args.baseline, 'utf8'));

  const summary = summarize(run.clips);
  const report = {
    mode: 'single',
    profile: profile.label,
    profileModel: profile.model,
    paramsHash: profile.hash,
    models,
    modelWarning: warning,
    totalFrames: run.totalFrames,
    clips: run.clips,
    summary,
    confusion: run.confusion,
    temporal: run.temporal,
    groups: {
      camera: groupSummaries(run.clips, 'camera'),
      subject: groupSummaries(run.clips, 'subject'),
    },
    gates: evaluateGates(summary, {
      minRecall: args.minRecall,
      minPrecision: args.minPrecision,
      maxCountErr: args.maxCountErr,
      maxDrop: args.maxDrop,
      baseline,
    }),
    sweep: args.sweep ? runSweep(loaded, profile, args, summary) : null,
    fit: args.fit ? fitThresholds(run.clipLabels, run.timelines, run.clipFrames) : null,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!args.quiet) {
    console.log(toMarkdown(report));
  }
  if (args.report) {
    await writeFile(args.report, toMarkdown(report), 'utf8');
    console.log(`\n已写入 ${args.report}`);
  }

  const anyFail = run.clips.some((c) => c.segments.some((s) => !s.pass));
  const gateFail = report.gates.configured && !report.gates.passed;
  return (anyFail || gateFail) ? 2 : 0;
}

async function runCompare(args, loaded, a, b) {
  const runA = runEvaluation(loaded, a.params);
  const runB = runEvaluation(loaded, b.params);
  if (!runA.clips.length) throw new Error('--compare 需要带 labels 的素材（没有可比较的段）');
  const infoA = modelInfo(loaded, a);
  const infoB = modelInfo(loaded, b);
  for (const w of [infoA.warning && `A：${infoA.warning}`, infoB.warning && `B：${infoB.warning}`]) {
    if (w && !args.quiet) console.error(`⚠ ${w}`);
  }
  const summaryA = summarize(runA.clips);
  const summaryB = summarize(runB.clips);
  const report = {
    mode: 'compare',
    a: {
      label: a.label, model: a.model, paramsHash: a.hash,
      models: infoA.models, modelWarning: infoA.warning,
      summary: summaryA, confusion: runA.confusion, temporal: runA.temporal,
    },
    b: {
      label: b.label, model: b.model, paramsHash: b.hash,
      models: infoB.models, modelWarning: infoB.warning,
      summary: summaryB, confusion: runB.confusion, temporal: runB.temporal,
    },
    totalFrames: runA.totalFrames,
    clipCount: runA.clips.length,
    deltas: compareSummaries(summaryA, summaryB),
    changes: compareSegments(runA.clips, runB.clips),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!args.quiet) {
    console.log(toCompareMarkdown(report));
  }
  if (args.report) {
    await writeFile(args.report, toCompareMarkdown(report), 'utf8');
    console.log(`\n已写入 ${args.report}`);
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.dir && !args.input)) {
    console.log(USAGE);
    return args.help ? 0 : 1;
  }
  if (args.out && !args.autolabel) throw new Error('--out 只用于 --autolabel');
  if (args.sweepActions && !args.sweep) throw new Error('--sweep-actions 需要配合 --sweep');
  if (args.compare) {
    const unsupported = [
      args.profile && '--profile',
      args.sweep && '--sweep',
      args.sweepActions && '--sweep-actions',
      args.baseline && '--baseline',
      args.fit && '--fit',
      args.minRecall !== null && '--min-recall',
      args.minPrecision !== null && '--min-precision',
      args.maxCountErr !== null && '--max-count-err',
    ].filter(Boolean);
    if (unsupported.length) {
      throw new Error(`--compare 是信息性的对比，不支持：${unsupported.join('、')}`);
    }
  }

  if (args.compare) {
    if (args.compare.some((f) => !f)) throw new Error('--compare 需要两个 profile 路径');
    const loaded = await loadPairs(args);
    return runCompare(args, loaded,
      await readProfile(args.compare[0]), await readProfile(args.compare[1]));
  }

  const profile = args.profile ? await readProfile(args.profile) : DEFAULT_PROFILE;
  const params = profile.params;

  // 标注草稿：只复算 + 导出正例段，不做评估
  if (args.autolabel) {
    if (!args.input) throw new Error('--autolabel 需要 --input <frames 文件>');
    const frames = await loadFrames(args.input);
    const draft = autoLabelClip(frames, replay(frames, params), {
      name: path.basename(args.input).replace(/\.[^.]+$/, ''),
    });
    const text = `${JSON.stringify(draft, null, 2)}\n`;
    if (args.out) {
      await writeFile(args.out, text, 'utf8');
      console.log(`已写入 ${args.out}（${draft.segments.length} 段草稿；反例仍需人工补）`);
    } else {
      console.log(text);
    }
    return 0;
  }

  // 标注辅助模式：不做评估，只把逐帧信号打出来
  if (args.timeline) {
    if (!args.input) throw new Error('--timeline 需要 --input <frames.json>');
    const frames = await loadFrames(args.input);
    const lines = [];
    lines.push(`# 逐帧时间线 · ${path.basename(args.input)}`);
    lines.push(`帧数 ${frames.length}，profile ${profile.label || '默认阈值'}`, '');
    lines.push(toTimeline(frames, replay(frames, params), args.every));
    const text = lines.join('\n');
    console.log(text);
    if (args.report) {
      await writeFile(args.report, text, 'utf8');
      console.log(`\n已写入 ${args.report}`);
    }
    return 0;
  }

  const loaded = await loadPairs(args);
  return runSingle(args, loaded, profile);
}

// 只有直接运行时才走 CLI；被单测 import 时只暴露函数
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(String(e && e.stack || e));
    process.exit(1);
  });
}

