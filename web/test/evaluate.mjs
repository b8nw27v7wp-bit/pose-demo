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
//
// 输入是 Demo 导出的 JSON（{ frames: [...] }）。labels 文件见 docs/eval.md。
// 这个工具只复算、不改任何素材：评估结果和 Demo 现场看到的应当一致，不一致就是 export 或契约有 bug。

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignalEngine } from '../js/signals.js';
import { ActionEngine, ARM_ACTIONS } from '../js/actions.js';
import { resolveParams, profileParams, profileName } from '../js/params.js';

// —— 参数 ---------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    dir: null, input: null, labels: null, report: null, profile: null,
    fit: false, json: false, quiet: false, timeline: false, every: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dir') out.dir = next();
    else if (a === '--input') out.input = next();
    else if (a === '--labels') out.labels = next();
    else if (a === '--report') out.report = next();
    else if (a === '--profile') out.profile = next();
    else if (a === '--fit') out.fit = true;
    else if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--timeline') out.timeline = true;
    else if (a === '--every') out.every = Math.max(1, Number(next()) || 1);
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`未知参数 ${a}`);
  }
  return out;
}

const USAGE = `用法:
  node web/test/evaluate.mjs --input <frames.json> --labels <labels.json>
  node web/test/evaluate.mjs --dir <目录> [--profile <profile.json>] [--fit] [--report <out.md>] [--json]
  node web/test/evaluate.mjs --input <frames.json> --timeline [--every N]

  --timeline  逐帧打印信号与判定，用于对着视频做标注（不是评估）
  --every N   配合 --timeline，每 N 帧打一行（默认 1）

labels 文件格式见 docs/eval.md。`;

// —— 输入读取 -----------------------------------------------------------

/** 接受三种输入：Demo 导出（{frames}）、裸数组（frames）、JSONL（一行一条） */
function normalizeFrames(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.frames)) return raw.frames;
  if (raw && Array.isArray(raw.records)) return raw.records;
  throw new Error('无法识别的帧文件：需要 {frames:[...]}、[...] 或 JSONL');
}

function parseJsonl(text) {
  const objs = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  // Demo 的 JSONL 首行是 meta（带 schema/exported_at、没有 persons）；
  // 其余的才是帧记录。整份都当帧会把 meta 喂给信号层。
  return objs.filter((o) => o && (Array.isArray(o.persons) || Array.isArray(o.frames)));
}

/**
 * 读帧文件。三种格式都要支持：
 *   Demo 导出 {frames:[...]} / 裸数组 [...] / JSONL（一行一条）
 * 判断依据是**整份文件能否解析成一个 JSON 值**，而不是首字符——
 * JSONL 的每行以 { 开头，只看首字符会把合法 JSONL 送进 JSON.parse 而抛异常。
 */
async function loadFrames(file) {
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
      return normalizeFrames(raw);
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

/** 动作序列 → 连续为真的区间（合并相邻且间隔不超过 mergeMs 的命中） */
function activeRanges(series, mergeMs = 0) {
  const ranges = [];
  let cur = null;
  for (const { ts, on } of series) {
    if (!on) {
      if (cur) { ranges.push(cur); cur = null; }
      continue;
    }
    if (cur && ts - cur[1] <= mergeMs) cur[1] = ts;
    else { if (cur) ranges.push(cur); cur = [ts, ts]; }
  }
  if (cur) ranges.push(cur);
  return ranges;
}

// —— 评估单段素材 -------------------------------------------------------

const POSTURE_IDS = ['stand', 'sit', 'squat_static', 'lying'];
const REP_IDS = ['squat', 'pushup', 'clap'];
/**
 * 手臂 flag 列表**从 ARM_ACTIONS 派生**，不手抄。
 * 手抄过一次，新增 bothHandsUp/handAtHead 时就漏了——标注这两个动作会得到「未知动作名」，
 * 而这正是本轮新增、最需要被度量的两个。
 */
const ARM_ID_TO_FLAG = {
  arm_raised: 'armRaised', both_up: 'bothHandsUp', wave: 'waving',
  crossed: 'crossed', hips: 'onHips', arms_open: 'armsOpen', hand_head: 'handAtHead',
};
const FLAG_IDS = ARM_ACTIONS.map((a) => ARM_ID_TO_FLAG[a.id]).filter(Boolean);

/**
 * 一段素材评估。labels.segments 每段声明：
 *   { action, start, end, count?, tol? }
 *   action 可以是姿态 id（stand/sit/squat_static/lying）、手臂 flag（armRaised/...）、
 *   rep 名（squat/pushup/clap），或 'none'（这段时间内不应有任何动作）。
 */
export function evaluateClip(frames, labels, timeline) {
  const segments = labels.segments || [];
  const span = frames.length ? frames[frames.length - 1].ts - frames[0].ts : 0;

  const seriesOf = (action) => {
    if (POSTURE_IDS.includes(action)) {
      return timeline.map((r) => ({ ts: r.ts, on: !r.empty && r.act.postureId === action }));
    }
    if (FLAG_IDS.includes(action)) {
      return timeline.map((r) => ({ ts: r.ts, on: !r.empty && !!r.act.flags[action] }));
    }
    if (action === 'none') {
      return timeline.map((r) => ({
        ts: r.ts,
        on: !r.empty && (!!r.act.postureId || Object.values(r.act.flags).some(Boolean)),
      }));
    }
    return null;
  };

  /**
   * 一个时间段内**哪个**动作被误判成立（按帧计数，取最多的那个）。
   * `none` 段必须能回答这个问题，否则误报只能记在 none 头上，
   * 各动作的 precision 永远是 1，等于没测精度（docs/eval.md 承诺的是归到动作）。
   */
  const culprits = (range) => {
    const tally = new Map();
    for (const r of timeline) {
      if (r.empty || r.ts < range[0] || r.ts > range[1]) continue;
      if (r.act.postureId) tally.set(r.act.postureId, (tally.get(r.act.postureId) || 0) + 1);
      for (const f of FLAG_IDS) {
        if (r.act.flags[f]) tally.set(f, (tally.get(f) || 0) + 1);
      }
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };

  const results = [];
  for (const seg of segments) {
    const range = resolveRange(seg, frames);
    const action = seg.action;

    if (REP_IDS.includes(action)) {
      // 计数类：比较该时间段内的增量与标注次数
      const inside = timeline.filter((r) => r.ts >= range[0] && r.ts <= range[1] && !r.empty);
      const base = timeline.filter((r) => r.ts < range[0] && !r.empty).pop();
      const got = inside.length
        ? (inside[inside.length - 1].act.reps[action] - (base ? base.act.reps[action] : 0))
        : 0;
      const want = seg.count ?? 1;
      results.push({
        type: 'rep', action, range, want, got,
        pass: Math.abs(got - want) <= (seg.tol ?? 1),
      });
      continue;
    }

    const series = seriesOf(action);
    if (!series) {
      results.push({ type: 'unknown', action, range, pass: false, error: '未知动作名' });
      continue;
    }
    const ranges = activeRanges(series);
    const hit = ranges.some((r) => overlaps(r, range));
    // none 段失败时记下误报的是哪个动作，汇总时才能把 FP 归到它头上
    const falseAlarms = (action === 'none' && hit) ? culprits(range) : null;
    results.push({
      type: 'state', action, range, want: action !== 'none', got: hit,
      pass: hit === (action !== 'none'), falseAlarms,
    });
  }

  return {
    clip: labels.name || labels.clip || null,
    frames: frames.length,
    duration_s: +(span / 1000).toFixed(2),
    segments: results,
  };
}

// —— 汇总 ---------------------------------------------------------------

function summarize(clipResults) {
  const byAction = new Map();
  const bump = (action) => {
    if (!byAction.has(action)) byAction.set(action, { tp: 0, fn: 0, fp: 0, repAbs: 0, repN: 0 });
    return byAction.get(action);
  };
  for (const c of clipResults) {
    for (const s of c.segments) {
      const b = bump(s.action);
      if (s.type === 'rep') {
        b.repAbs += Math.abs(s.got - s.want);
        b.repN += s.want;
        if (s.pass) b.tp++; else b.fn++;
      } else if (s.action === 'none') {
        // none 段：自己不计 precision（没有「应有的正例」），
        // 把这次误报归给它实际误报的那个动作，否则每个动作的 precision 恒为 1。
        if (s.got) {
          const hit = s.falseAlarms && s.falseAlarms.length ? s.falseAlarms : [null];
          for (const a of hit) {
            if (a === null) { b.fp++; continue; }   // 归不了因才记在 none 自己头上
            bump(a).fp++;
          }
        }
      } else {
        if (s.got) b.tp++; else b.fn++;
      }
    }
  }
  const rows = [];
  for (const [action, b] of [...byAction.entries()].sort()) {
    const recall = b.tp + b.fn > 0 ? b.tp / (b.tp + b.fn) : null;
    const precision = b.tp + b.fp > 0 ? b.tp / (b.tp + b.fp) : null;
    rows.push({
      action,
      tp: b.tp, fn: b.fn, fp: b.fp,
      recall: recall === null ? null : +recall.toFixed(3),
      precision: precision === null ? null : +precision.toFixed(3),
      countErr: b.repN ? +(b.repAbs / b.repN).toFixed(2) : null,
    });
  }
  return rows;
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
      let range;
      try { range = resolveRange(seg, frames); } catch { continue; }
      // 计数段的电平均值同样要统计：深蹲下阈就看这一段里膝角的低分位
      const bucket = REP_IDS.includes(seg.action) ? `${seg.action}_baseline` : seg.action;
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

// —— 报告 ---------------------------------------------------------------

function toMarkdown(report) {
  const lines = [];
  lines.push('# 姿态动作评估报告', '');
  lines.push(`- 素材：${report.clips.length} 段，共 ${report.totalFrames} 帧`);
  lines.push(`- profile：${report.profile || '默认阈值'}`);
  lines.push(`- 生成时间：${new Date().toISOString()}`, '');

  lines.push('## 按动作汇总', '');
  lines.push('| 动作 | TP | FN | FP | recall | precision | 计数误差/次 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of report.summary) {
    lines.push(`| ${r.action} | ${r.tp} | ${r.fn} | ${r.fp} | ${r.recall ?? '—'} | ${r.precision ?? '—'} | ${r.countErr ?? '—'} |`);
  }
  lines.push('');

  lines.push('## 逐段明细', '');
  for (const c of report.clips) {
    const bad = c.segments.filter((s) => !s.pass);
    lines.push(`### ${c.clip || '(未命名)'} — ${c.duration_s}s / ${c.frames} 帧`);
    lines.push(`通过 ${c.segments.length - bad.length}/${c.segments.length}`);
    for (const s of bad) {
      const t = `[${(s.range[0] / 1000).toFixed(2)}–${(s.range[1] / 1000).toFixed(2)}s]`;
      lines.push(`- ✗ ${s.action} ${t} ${s.type === 'rep' ? `期望 ${s.want} 次，得到 ${s.got}` : '未按标注出现'}`);
    }
    lines.push('');
  }

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
      '> 分位是「这段数据里 95% 的帧都低于此值」，不是阈值本身——阈值要靠留余量。', '');
  }
  return lines.join('\n');
}

// —— 主流程 -------------------------------------------------------------

async function pairsFromDir(dir) {
  const files = await readdir(dir);
  const framesFiles = files.filter((f) => /\.(frames\.)?json$/i.test(f) && !/\.labels\.json$/i.test(f));
  const pairs = [];
  for (const f of framesFiles) {
    const base = f.replace(/\.frames\.json$/i, '').replace(/\.json$/i, '');
    const labelName = files.find((l) => l === `${base}.labels.json`);
    if (labelName) pairs.push({ frames: path.join(dir, f), labels: path.join(dir, labelName) });
    else pairs.push({ frames: path.join(dir, f), labels: null });
  }
  return pairs.sort((a, b) => a.frames.localeCompare(b.frames));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.dir && !args.input)) {
    console.log(USAGE);
    return args.help ? 0 : 1;
  }

  let params = {};
  let profileLabel = null;
  if (args.profile) {
    const raw = JSON.parse(await readFile(args.profile, 'utf8'));
    params = profileParams(raw);
    profileLabel = `${profileName(raw, path.basename(args.profile))}（${args.profile}）`;
  }

  // 标注辅助模式：不做评估，只把逐帧信号打出来
  if (args.timeline) {
    if (!args.input) throw new Error('--timeline 需要 --input <frames.json>');
    const frames = await loadFrames(args.input);
    const lines = [];
    lines.push(`# 逐帧时间线 · ${path.basename(args.input)}`);
    lines.push(`帧数 ${frames.length}，profile ${profileLabel || '默认阈值'}`, '');
    lines.push(toTimeline(frames, replay(frames, params), args.every));
    const text = lines.join('\n');
    console.log(text);
    if (args.report) {
      await writeFile(args.report, text, 'utf8');
      console.log(`\n已写入 ${args.report}`);
    }
    return 0;
  }

  let pairs;
  if (args.dir) pairs = await pairsFromDir(args.dir);
  else pairs = [{ frames: args.input, labels: args.labels }];
  if (!pairs.length) throw new Error('没有找到任何帧文件');

  const clips = [];
  const timelines = [];
  const clipLabels = [];
  const clipFrames = [];
  let totalFrames = 0;

  for (const pair of pairs) {
    const frames = await loadFrames(pair.frames);
    totalFrames += frames.length;
    const timeline = replay(frames, params);
    timelines.push(timeline);
    if (!pair.labels) {
      if (!args.quiet) console.error(`跳过评估（无 labels）：${pair.frames}`);
      clipLabels.push(null);
      clipFrames.push(frames);
      continue;
    }
    const labels = await loadLabels(pair.labels);
    if (!labels.name) labels.name = path.basename(pair.frames);
    clips.push(evaluateClip(frames, labels, timeline));
    clipLabels.push(labels);
    clipFrames.push(frames);
  }

  const report = {
    profile: profileLabel,
    totalFrames,
    clips,
    summary: summarize(clips),
    fit: args.fit ? fitThresholds(clipLabels, timelines, clipFrames) : null,
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

  const anyFail = clips.some((c) => c.segments.some((s) => !s.pass));
  return anyFail ? 2 : 0;
}

// 只有直接运行时才走 CLI；被单测 import 时只暴露函数
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(String(e && e.stack || e));
    process.exit(1);
  });
}
