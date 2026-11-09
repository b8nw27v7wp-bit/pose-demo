#!/usr/bin/env node
// ppe-eval.mjs — PPE 事件级评估（R13-1 骨架，独立工具，不改 evaluate.mjs）
//
// 为什么单独一个工具：evaluate.mjs 读的是主目标 signals/actions；PPE 的事件语义是
// 「某个人在这段时间该戴/不该戴，系统是否在 minMs 后报警」。两者共用 labels 文件格式，
// 但指标口径不同（事件 recall/precision、unknown 弃权、告警时延、误报/小时）。
// PLAN §18.1 明确先独立跑通，再决定是否并入主报告。
//
// 用法：
//   node web/test/ppe-eval.mjs --input clip.jsonl --labels clip.labels.json
//   node web/test/ppe-eval.mjs --dir eval-data --report eval-data/ppe-report.md
//   node web/test/ppe-eval.mjs --dir eval-data --min-ppe-recall 0.9 --max-ppe-fa-per-hour 1
//   node web/test/ppe-eval.mjs --self-test
//
// 输入：Demo 导出的 JSON/{frames}/JSONL；每帧的 verdicts[] 必须带 ppe。
// labels 段：{ action:"ppe", target:"helmet"|"glove", expect:"worn"|"missing"|"unknown",
//             track?, startSec/endSec | start/end(ms) | startFrame/endFrame,
//             camera?, subject?, bbox? }
//
// 旧数据（没有 verdicts、或 verdicts 只有主目标）不会被静默算成 0：直接报错或醒目告警。

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadFrames, stripBom, frameTs, videoTimeMonotonic } from './frame-io.mjs';

export const TARGETS = ['helmet', 'glove'];
export const STATES = ['worn', 'missing', 'unknown'];

/** Wilson 95% 区间；与 evaluate.mjs 同口径，但这里独立实现，避免改那个文件。 */
export function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [+Math.max(0, center - half).toFixed(3), +Math.min(1, center + half).toFixed(3)];
}

/**
 * labels 文件除 segments 外还有 camera/subject/name 等元信息，frame-io 的 loadLabels
 * 只返回数组会把它们丢掉（报告分组就全变成文件名）。这里保留整份文档。
 */
async function loadLabelDoc(file) {
  const obj = JSON.parse(stripBom(await readFile(file, 'utf8')));
  if (Array.isArray(obj)) return { segments: obj };
  if (!obj || !Array.isArray(obj.segments)) throw new Error(`${file} 里没有 segments[]`);
  return obj;
}

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};
const mean = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

/** 段级多数状态；平票回退 unknown（保守：宁可弃权，不猜） */
export function majorityState(states) {
  if (!states.length) return null;
  const c = { worn: 0, missing: 0, unknown: 0 };
  for (const s of states) if (s in c) c[s]++;
  const max = Math.max(c.worn, c.missing, c.unknown);
  const winners = STATES.filter((s) => c[s] === max);
  return winners.length === 1 ? winners[0] : 'unknown';
}

const ppeOf = (v, target) => (target === 'helmet' ? v?.ppe?.helmet : v?.ppe?.glove);
const idKey = (v) => v?.track_uid ?? v?.track_id;
const lockKey = (lock) => (lock ? (lock.uid ?? lock.id) : null);
const iou = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter || 1);
};

/**
 * 按 labels 选择帧区间。返回 {indices, startTs, endTs, unit}。
 * startSec 只允许在 video_time 单调时使用（循环播放会让秒数回绕）。
 */
export function selectFrames(frames, seg) {
  const sec = Number.isFinite(seg.startSec) && Number.isFinite(seg.endSec);
  const ms = Number.isFinite(seg.start) && Number.isFinite(seg.end);
  const fr = Number.isInteger(seg.startFrame) && Number.isInteger(seg.endFrame);
  if (sec) {
    if (!videoTimeMonotonic(frames)) {
      throw new Error('video_time 非单调（循环播放/拖动过）：该段不能用 startSec/endSec，请改用 start/end(ms) 或 startFrame');
    }
    const idx = [];
    for (let i = 0; i < frames.length; i++) {
      const vt = frames[i]?.video_time;
      if (Number.isFinite(vt) && vt >= seg.startSec && vt <= seg.endSec) idx.push(i);
    }
    return { indices: idx, unit: 'sec' };
  }
  if (ms) {
    const idx = [];
    for (let i = 0; i < frames.length; i++) {
      const t = frameTs(frames[i]);
      if (Number.isFinite(t) && t >= seg.start && t <= seg.end) idx.push(i);
    }
    return { indices: idx, unit: 'ms' };
  }
  if (fr) {
    const idx = [];
    for (let i = Math.max(0, seg.startFrame); i <= Math.min(frames.length - 1, seg.endFrame); i++) idx.push(i);
    return { indices: idx, unit: 'frame' };
  }
  throw new Error('段缺少时间范围：需要 startSec/endSec、start/end 或 startFrame/endFrame');
}

const IOU_MIN = 0.05;

/**
 * 在段内任意一帧里找 track：uid 优先（跨 id 稳定，文档口径），找不到再退回 track_id。
 * 逐帧扫描而不是只看「第一个有 verdicts 的帧」——人常常在段开始后才进入画面，
 * 只看首帧会误报 track_not_found。
 */
function findTrack(frames, indices, want) {
  for (const i of indices) {
    const vs = frames[i]?.verdicts;
    if (!Array.isArray(vs)) continue;
    for (const v of vs) {
      if (v?.track_uid != null && v.track_uid === want) {
        return { uid: v.track_uid, id: v.track_id ?? null };
      }
    }
  }
  for (const i of indices) {
    const vs = frames[i]?.verdicts;
    if (!Array.isArray(vs)) continue;
    for (const v of vs) {
      if (v?.track_id === want) return { uid: v.track_uid ?? null, id: v.track_id };
    }
  }
  return null;
}

/** 段内最早能按 bbox 绑定的那一帧（逐帧找，避免人晚进场时静默失败）。 */
function findBboxTrack(frames, indices, bbox) {
  for (const i of indices) {
    const vs = frames[i]?.verdicts;
    if (!Array.isArray(vs)) continue;
    let best = null;
    let bestIou = IOU_MIN;
    for (const v of vs) {
      const ov = iou(bbox, v?.bbox);
      if (ov > bestIou) { bestIou = ov; best = v; }
    }
    if (best) return { uid: best.track_uid ?? null, id: best.track_id };
  }
  return null;
}

/**
 * 把一段标签绑定到 track：
 * - track 指定 → 段内任意一帧按 track_uid 匹配（优先），再退回 track_id；
 * - 无 track、有 bbox → 段内最早与 bbox IoU > 0.05 的那个人；一直找不到 → method='bbox_missing'
 *   （不静默降级成「任一人」，否则段会被按错误的人计分）；
 * - 无 track、每帧只有一个人 → 直接绑这个唯一目标；
 * - 否则 → 任一人（method='any'，单列 ambiguous）。
 * @returns {{method:string, lock:{uid:number|null,id:number|null}|null, obs:Array, lostFrames:number}}
 */
export function bindSegment(frames, indices, seg) {
  const firstWith = indices.find((i) => Array.isArray(frames[i]?.verdicts) && frames[i].verdicts.length);
  const vs0 = firstWith == null ? [] : frames[firstWith].verdicts;

  let lock = null;
  let method = 'any';
  if (Number.isFinite(seg.track)) {
    lock = findTrack(frames, indices, seg.track);
    method = 'track';
  } else if (Array.isArray(seg.bbox) && seg.bbox.length === 4) {
    lock = findBboxTrack(frames, indices, seg.bbox);
    method = lock ? 'bbox' : 'bbox_missing';
  } else {
    let single = true;
    for (const i of indices) {
      const n = frames[i]?.verdicts?.length || 0;
      if (n > 1) { single = false; break; }
    }
    if (single && vs0.length === 1) {
      lock = { uid: vs0[0].track_uid ?? null, id: vs0[0].track_id };
      method = 'single';
    }
  }

  const obs = [];
  let lostFrames = 0;
  for (const i of indices) {
    const vs = frames[i]?.verdicts;
    if (!Array.isArray(vs) || !vs.length) continue;
    let matched = [];
    if (method === 'any') matched = vs;
    else if (lock?.uid != null) matched = vs.filter((v) => v?.track_uid === lock.uid);
    else if (lock?.id != null) matched = vs.filter((v) => v?.track_id === lock.id);
    if (!matched.length) { lostFrames++; continue; }
    obs.push({ idx: i, ts: frameTs(frames[i]), verdicts: matched });
  }
  return { method, lock, obs, lostFrames };
}

/** 每帧 → 该 target 的观测状态（any 模式下按 expect 取「有人满足」优先）。 */
function observe(bound, target, expect) {
  const out = [];
  for (const o of bound.obs) {
    const states = o.verdicts.map((v) => ppeOf(v, target)).filter(Boolean);
    if (!states.length) continue;
    let state;
    if (bound.method === 'any' && states.length > 1) {
      const ss = states.map((s) => s.state);
      if (expect !== 'unknown' && ss.includes(expect)) state = expect;
      else state = majorityState(ss);
    } else {
      state = states[0].state;
    }
    const first = states.find((s) => s.state === state) || states[0];
    out.push({
      ts: o.ts,
      state,
      alert: first.alert ?? 'none',
      streak_ms: first.streak_ms ?? 0,
      reason_code: first.reason_code ?? null,
    });
  }
  return out;
}

function bump(map, key, field) {
  map[key] = (map[key] || 0) + (field || 1);
}

/**
 * 核心评估。clips: [{frames, labels, name?, camera?, subject?}]
 * @returns 报告对象（JSON 可序列化）
 */
export function evaluatePpe(clips, opts = {}) {
  const warnings = [];
  const segments = [];
  let frameCount = 0;
  let framesWithVerdicts = 0;
  let framesWithPpe = 0;
  let maxVerdicts = 0;
  let personsOnlyMain = false;

  for (const clip of clips) {
    for (const f of clip.frames || []) {
      frameCount++;
      const vs = f?.verdicts;
      if (!Array.isArray(vs) || !vs.length) continue;
      framesWithVerdicts++;
      maxVerdicts = Math.max(maxVerdicts, vs.length);
      if (vs.some((v) => v?.ppe)) framesWithPpe++;
      if (Array.isArray(f?.persons) && f.persons.length > vs.length) personsOnlyMain = true;
    }
  }
  if (!frameCount) throw new Error('没有帧数据');
  if (!framesWithVerdicts) {
    throw new Error('数据里没有 verdicts[]：这是旧导出（只含主目标），PPE 事件评估需要每帧 verdicts[]。'
      + '请用最新页面重新导出（打开多人/物体检测）。');
  }
  if (!framesWithPpe) {
    throw new Error('verdicts[] 没有 ppe 字段：导出时物体检测/PPE 没开，无法评估。');
  }
  if (framesWithVerdicts < frameCount) {
    warnings.push(`${frameCount - framesWithVerdicts} 帧没有 verdicts[]（旧帧），已跳过`);
  }
  if (personsOnlyMain || maxVerdicts <= 1) {
    warnings.push('所有帧只有 1 个 verdict（或 persons 多于 verdicts）：如果素材里有多人，'
      + '说明导出只含主目标，多 track PPE 事件无法评估；本次结果按单目标解释。');
  }

  // 每个 clip 的总时长（用于误报/小时）
  const clipHours = new Map();
  for (const clip of clips) {
    const ts = (clip.frames || []).map(frameTs).filter(Number.isFinite);
    const dur = ts.length > 1 ? Math.max(...ts) - Math.min(...ts) : 0;
    clipHours.set(clip, dur / 3600000);
  }

  // 每个 clip 的有效 camera：段级 camera 一致时用它（docs 的写法就是把 camera 写在段上），
  // 不一致才退回 clip 级并告警。段和告警事件必须共用同一个 camera —— 否则事件会落到以
  // clip 名命名的影子组里，真实组误报恒为 0、perHour 恒为 null，门槛永远不触发。
  const effCamera = new Map();
  for (const clip of clips) {
    const allSegs = clip.labels?.segments || clip.labels || [];
    const segCams = new Set(allSegs
      .filter((s) => s && s.action === 'ppe' && s.camera)
      .map((s) => s.camera));
    const clipLevel = clip.labels?.camera ?? clip.camera ?? clip.name ?? '未标注';
    if (segCams.size === 1) effCamera.set(clip, [...segCams][0]);
    else {
      if (segCams.size > 1) {
        warnings.push(`${clip.name || 'clip'} 的段 camera 不一致（${[...segCams].join('/')}），`
          + `按 clip 级 camera=${clipLevel} 分组`);
      }
      effCamera.set(clip, clipLevel);
    }
  }
  for (const clip of clips) {
    const allSegs = clip.labels?.segments || clip.labels || [];
    for (const seg of allSegs) {
      if (!seg || seg.action !== 'ppe') continue;
      if (!TARGETS.includes(seg.target)) {
        warnings.push(`忽略未知 target=${seg.target} 的段（${clip.name || 'clip'}）`);
        continue;
      }
      if (!STATES.includes(seg.expect)) {
        warnings.push(`忽略未知 expect=${seg.expect} 的段（${clip.name || 'clip'}）`);
        continue;
      }
      const camera = effCamera.get(clip);
      const subject = seg.subject ?? clip.labels?.subject ?? clip.subject ?? null;
      const base = {
        clip: clip.name ?? null, camera, subject, target: seg.target, expect: seg.expect,
        track: seg.track ?? null, cameraLabel: seg.camera ?? null,
        label: seg.name || seg.note || null,
      };
      let selection;
      try {
        selection = selectFrames(clip.frames, seg);
      } catch (e) {
        segments.push({ ...base, status: 'error', error: e.message, predicted: null });
        warnings.push(`${base.clip || 'clip'} 的段无法定位时间：${e.message}`);
        continue;
      }
      if (!selection.indices.length) {
        segments.push({ ...base, status: 'no_frames', predicted: null, nFrames: 0 });
        warnings.push(`${base.clip || 'clip'} ${seg.target}/${seg.expect} 段内没有帧`);
        continue;
      }
      const bound = bindSegment(clip.frames, selection.indices, seg);
      if (bound.method === 'track' && !bound.lock) {
        segments.push({ ...base, status: 'track_not_found', predicted: null });
        warnings.push(`${base.clip || 'clip'} 的 ${seg.target} 段内找不到 track=${seg.track}`
          + '（按 uid 优先、再按 track_id 查了整个段）');
        continue;
      }
      if (bound.method === 'bbox_missing') {
        segments.push({ ...base, status: 'bbox_not_found', predicted: null });
        warnings.push(`${base.clip || 'clip'} 的 ${seg.target} 段 bbox 与段内任何人都不重合`
          + `（IoU ≤ ${IOU_MIN}），段不会被计分`);
        continue;
      }
      const obs = observe(bound, seg.target, seg.expect);
      if (!obs.length) {
        segments.push({ ...base, status: 'no_data', predicted: null, bound: bound.method });
        warnings.push(`${base.clip || 'clip'} ${seg.target} 段内没有该 target 的 ppe 状态（track 丢失或对象未导出）`);
        continue;
      }
      const predicted = majorityState(obs.map((o) => o.state));
      const startTs = frameTs(clip.frames[selection.indices[0]]);
      const endTs = frameTs(clip.frames[selection.indices[selection.indices.length - 1]]);
      let latency = null;
      if (seg.expect === 'missing') {
        const hit = obs.find((o) => o.alert && o.alert !== 'none');
        if (hit && Number.isFinite(startTs) && Number.isFinite(hit.ts)) latency = Math.max(0, hit.ts - startTs);
      }
      segments.push({
        ...base,
        status: 'ok',
        predicted,
        method: bound.method,
        ambiguous: bound.method === 'any',
        locked: lockKey(bound.lock),
        nFrames: selection.indices.length,
        nObserved: obs.length,
        lostFrames: bound.lostFrames,
        startTs, endTs,
        latencyMs: latency,
        maxStreakMs: Math.max(0, ...obs.map((o) => Number(o.streak_ms) || 0)),
        states: obs.reduce((m, o) => { m[o.state] = (m[o.state] || 0) + 1; return m; }, {}),
      });
    }
  }

  // —— 每 target × camera 的事件混淆 ——
  const groups = new Map();
  const groupOf = (target, camera) => {
    const k = `${target}|${camera}`;
    if (!groups.has(k)) {
      groups.set(k, {
        target, camera,
        nSegments: 0, nPredicted: 0, ambiguousSegments: 0, noDataSegments: 0, abstained: 0,
        confusion: Object.fromEntries(STATES.map((s) => [s, { tp: 0, fn: 0, fp: 0 }])),
        latencies: [],
        alertEvents: { total: 0, true: 0, false: 0 },
        hours: 0,
      });
    }
    return groups.get(k);
  };
  for (const s of segments) {
    const g = groupOf(s.target, s.camera);
    g.nSegments++;
    if (s.status !== 'ok') { g.noDataSegments++; continue; }
    g.nPredicted++;
    if (s.ambiguous) g.ambiguousSegments++;
    // 弃权口径：标签要求 definite（worn/missing）而模型给 unknown 时只记弃权，
    // 不算 FN、也不算 unknown 的 FP——与报告头「unknown 是弃权」一致。
    // 标签要求 unknown 而模型给 definite 时，仍算该 definite 状态的 FP（无依据的断言）。
    if (s.predicted === 'unknown' && s.expect !== 'unknown') {
      g.abstained++;
    } else {
      for (const c of STATES) {
        if (s.expect === c) {
          if (s.predicted === c) g.confusion[c].tp++;
          else g.confusion[c].fn++;
        } else if (s.predicted === c) {
          g.confusion[c].fp++;
        }
      }
    }
    if (s.latencyMs != null) g.latencies.push(s.latencyMs);
  }

  // 时长只分给真实出现过的 target×camera 组（不凭空造空组）。
  // 分母是该 camera 下所有 clip 的时长，两个 target 共用。
  for (const g of groups.values()) {
    for (const clip of clips) {
      if (effCamera.get(clip) === g.camera) g.hours += clipHours.get(clip) || 0;
    }
  }

  // —— 告警事件 → 误报/小时 ——
  // 每条 track 的 alert 连续帧合成一个事件（间隔 ≤1s 视为同一段）。
  const events = [];
  for (const clip of clips) {
    const camera = effCamera.get(clip);
    const open = new Map(); // `${target}|${key}` -> event
    for (const f of clip.frames || []) {
      const ts = frameTs(f);
      if (!Number.isFinite(ts)) continue;
      for (const v of f?.verdicts || []) {
        const key = idKey(v);
        if (key == null) continue;
        for (const target of TARGETS) {
          const p = ppeOf(v, target);
          if (!p || p.alert === 'none' || p.alert == null) continue;
          const ek = `${target}|${key}`;
          const e = open.get(ek);
          if (e && ts - e.endTs <= 1000) e.endTs = ts;
          else {
            const ne = { target, camera, key, startTs: ts, endTs: ts, true: false };
            events.push(ne);
            open.set(ek, ne);
          }
        }
      }
    }
  }
  const missingSegs = segments.filter((s) => s.status === 'ok' && s.expect === 'missing');
  for (const e of events) {
    for (const s of missingSegs) {
      if (s.target !== e.target || s.camera !== e.camera) continue;
      if (e.endTs < s.startTs || e.startTs > s.endTs) continue;
      if (s.locked != null && e.key !== s.locked) continue;
      e.true = true;
      break;
    }
  }
  for (const e of events) {
    const g = groupOf(e.target, e.camera);
    g.alertEvents.total++;
    g.alertEvents[e.true ? 'true' : 'false']++;
  }

  // —— 汇总 ——
  const outGroups = [];
  for (const g of groups.values()) {
    const confusion = {};
    for (const c of STATES) {
      const b = g.confusion[c];
      const nRecall = b.tp + b.fn;
      const nPrecision = b.tp + b.fp;
      const recall = nRecall ? +(b.tp / nRecall).toFixed(3) : null;
      const precision = nPrecision ? +(b.tp / nPrecision).toFixed(3) : null;
      confusion[c] = {
        tp: b.tp, fn: b.fn, fp: b.fp,
        recall, recallCI: recall == null ? null : wilson(b.tp, nRecall),
        precision, precisionCI: precision == null ? null : wilson(b.tp, nPrecision),
        nRecall, nPrecision,
      };
    }
    // 弃权 = 模型给出 unknown 的段（含标签本来就要求 unknown 的 TP），保持旧口径的分子。
    const abstainN = g.confusion.unknown.tp + g.abstained;
    outGroups.push({
      target: g.target,
      camera: g.camera,
      nSegments: g.nSegments,
      nPredicted: g.nPredicted,
      ambiguousSegments: g.ambiguousSegments,
      noDataSegments: g.noDataSegments,
      abstained: g.abstained,
      confusion,
      unknownAbstainRate: g.nPredicted ? +(abstainN / g.nPredicted).toFixed(3) : null,
      alertLatencyMs: {
        n: g.latencies.length,
        mean: mean(g.latencies),
        median: median(g.latencies),
      },
      alertEvents: {
        ...g.alertEvents,
        perHour: g.hours > 0 ? +(g.alertEvents.false / g.hours).toFixed(2) : null,
      },
      hours: +g.hours.toFixed(4),
    });
  }
  outGroups.sort((a, b) => a.target.localeCompare(b.target) || a.camera.localeCompare(b.camera));

  return {
    frames: frameCount,
    clips: clips.length,
    segments: segments.length,
    warnings,
    groups: outGroups,
    detail: segments,
  };
}

// —— CLI ---------------------------------------------------------------

const USAGE = `用法:
  node web/test/ppe-eval.mjs --input <frames.json|jsonl> --labels <labels.json> [--report <out.md>] [--json]
  node web/test/ppe-eval.mjs --dir <目录> [--report <out.md>] [--json]
  node web/test/ppe-eval.mjs --self-test

  --input / --labels   单段素材
  --dir                目录：*.frames.json 或 *.jsonl 配同名 *.labels.json
  --report <file>      写 Markdown 报告
  --json               打印 JSON（不加 --report 时到 stdout）
  --min-ppe-recall R   每个 target×camera 的 missing 事件 recall 下限；未达标退出码 2
  --max-ppe-fa-per-hour N  每个 target×camera 的误报事件/小时上限；超出退出码 2
  --self-test          合成帧自测（不读文件）
  --quiet              不打印 Markdown（只保留退出码/--report）

labels 段：{ action:"ppe", target:"helmet"|"glove", expect:"worn"|"missing"|"unknown",
            track?, startSec/endSec | start/end(ms) | startFrame/endFrame, camera?, subject?, bbox? }`;

function parseArgs(argv) {
  const out = {
    input: null, labels: null, dir: null, report: null,
    minRecall: null, maxFa: null, json: false, quiet: false, selfTest: false, help: false,
  };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} 需要数值：${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--input') out.input = next();
    else if (a === '--labels') out.labels = next();
    else if (a === '--dir') out.dir = next();
    else if (a === '--report') out.report = next();
    else if (a === '--min-ppe-recall') out.minRecall = num(next(), '--min-ppe-recall');
    else if (a === '--max-ppe-fa-per-hour') out.maxFa = num(next(), '--max-ppe-fa-per-hour');
    else if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`未知参数 ${a}\n\n${USAGE}`);
  }
  if (out.minRecall != null && (out.minRecall < 0 || out.minRecall > 1)) {
    throw new Error('--min-ppe-recall 必须在 0~1 之间');
  }
  if (out.maxFa != null && out.maxFa < 0) throw new Error('--max-ppe-fa-per-hour 不能为负');
  return out;
}

async function clipsFromDir(dir) {
  const files = await readdir(dir);
  const frameFiles = files.filter((f) => (
    (f.endsWith('.frames.json') || f.endsWith('.jsonl')) && !f.endsWith('.labels.json')
  ));
  const clips = [];
  for (const f of frameFiles) {
    const base = f.endsWith('.frames.json') ? f.slice(0, -'.frames.json'.length) : f.slice(0, -'.jsonl'.length);
    const labelsName = `${base}.labels.json`;
    if (!files.includes(labelsName)) {
      clips.push({ name: base, frames: await loadFrames(path.join(dir, f)), labels: null });
      continue;
    }
    clips.push({
      name: base,
      frames: await loadFrames(path.join(dir, f)),
      labels: await loadLabelDoc(path.join(dir, labelsName)),
    });
  }
  return clips;
}

function fmtPct(x) {
  return x == null ? '—' : `${(x * 100).toFixed(1)}%`;
}

export function reportMarkdown(rep, opts = {}) {
  const lines = [];
  lines.push('# PPE 事件评估（R13-1 骨架）', '');
  lines.push(`- 帧数：${rep.frames}；clip：${rep.clips}；段：${rep.segments}`);
  lines.push('- 口径：段级多数状态；`unknown` 是弃权——标签要求 worn/missing 而模型给 unknown 时只记弃权，'
    + '不算 FN 也不算 FP（计入「unknown 弃权率」）。事件 recall/precision 来自 per target × camera 的'
    + '混淆矩阵；区间为 Wilson 95%（段之间相关，近似）。');
  lines.push('- 误报/小时按整个 clip 时长统计：未标注时段的告警也会计入 FP（保守），'
    + '所以标注覆盖不全时该数字只会偏高，不会偏低。');
  if (rep.warnings.length) {
    lines.push('', '## 告警');
    for (const w of rep.warnings) lines.push(`- ⚠ ${w}`);
  }
  lines.push('', '## 每 target × camera', '');
  lines.push('| target | camera | 段(n) | worn R/P | missing R/P | unknown R/P | unknown 弃权率 | 告警时延(ms) | 误报/小时 | n |');
  lines.push('|---|---|---:|---|---|---|---|---|---|---:|');
  for (const g of rep.groups) {
    const rp = (c) => {
      const x = g.confusion[c];
      return x.recall == null && x.precision == null ? '—'
        : `${fmtPct(x.recall)} / ${fmtPct(x.precision)}`;
    };
    lines.push(`| ${g.target} | ${g.camera} | ${g.nSegments} | ${rp('worn')} | ${rp('missing')} | ${rp('unknown')}`
      + ` | ${fmtPct(g.unknownAbstainRate)} | ${g.alertLatencyMs.median ?? '—'}`
      + ` | ${g.alertEvents.perHour ?? '—'} | ${g.alertEvents.total} |`);
  }
  lines.push('', '### 事件计数与区间', '');
  for (const g of rep.groups) {
    lines.push(`**${g.target} / ${g.camera}**（预测 ${g.nPredicted} 段，ambiguous ${g.ambiguousSegments}，`
      + `弃权 ${g.abstained}，无数据 ${g.noDataSegments}）`, '');
    for (const c of STATES) {
      const x = g.confusion[c];
      const ci = (v) => (v == null ? '—' : `[${v[0]}, ${v[1]}]`);
      lines.push(`- ${c}: TP ${x.tp} / FN ${x.fn} / FP ${x.fp}；recall ${fmtPct(x.recall)} ${ci(x.recallCI)} (n=${x.nRecall})`
        + `；precision ${fmtPct(x.precision)} ${ci(x.precisionCI)} (n=${x.nPrecision})`);
    }
    lines.push(`- 告警事件：${g.alertEvents.true} 真 / ${g.alertEvents.false} 假（共 ${g.alertEvents.total}）；`
      + `时延 n=${g.alertLatencyMs.n}，mean ${g.alertLatencyMs.mean ?? '—'}ms，median ${g.alertLatencyMs.median ?? '—'}ms`);
    lines.push('');
  }
  const problems = [];
  for (const g of rep.groups) {
    if (opts.minRecall != null && g.confusion.missing.nRecall > 0
      && g.confusion.missing.recall < opts.minRecall) {
      problems.push(`${g.target}/${g.camera}: missing recall ${fmtPct(g.confusion.missing.recall)} < ${fmtPct(opts.minRecall)}`);
    }
    if (opts.maxFa != null && g.alertEvents.perHour != null
      && g.alertEvents.perHour > opts.maxFa) {
      problems.push(`${g.target}/${g.camera}: 误报 ${g.alertEvents.perHour}/h > ${opts.maxFa}/h`);
    }
  }
  if (problems.length) {
    lines.push('## 未达标', '');
    for (const p of problems) lines.push(`- ✗ ${p}`);
  }
  return `${lines.join('\n')}\n`;
}

// —— 合成自测 -----------------------------------------------------------

function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
  };
  const frame = (ts, verdicts) => ({ ts, video_time: ts / 1000, verdicts });
  const ppe = (state, alert = 'none', streak = 0) => ({
    state, alert, streak_ms: streak, reason_code: state === 'unknown' ? 'no_positive' : null,
  });
  const V = (id, uid, helmet, bbox = [0, 0, 100, 200], glove = ppe('unknown')) => ({
    track_id: id, track_uid: uid, bbox, ppe: { helmet, glove },
  });

  console.log('[self-test 1] 多 track + id 切换 + missing 事件');
  {
    const frames = [];
    for (let k = 0; k <= 9; k++) {
      const ts = k * 1000;
      // uid 7：0~2s 戴帽；3s 起缺帽；id 在 5s 时从 1 变成 2（模拟跟踪器超时）
      const st7 = ts < 3000 ? ppe('worn') : ppe('missing', ts >= 6000 ? 'violation' : 'none', Math.max(0, ts - 3000));
      const id7 = ts < 5000 ? 1 : 2;
      frames.push(frame(ts, [
        V(id7, 7, st7, [0, 0, 100, 200]),
        V(3, 8, ppe('worn'), [300, 0, 400, 200]),
      ]));
    }
    const labels = {
      camera: 'front',
      segments: [
        { action: 'ppe', target: 'helmet', expect: 'worn', track: 7, start: 0, end: 2500 },
        { action: 'ppe', target: 'helmet', expect: 'missing', track: 7, start: 3000, end: 9000 },
      ],
    };
    const rep = evaluatePpe([{ name: 'syn', frames, labels }]);
    const g = rep.groups.find((x) => x.target === 'helmet' && x.camera === 'front');
    check('worn 事件命中', g.confusion.worn.recall === 1 && g.confusion.worn.precision === 1);
    check('missing 事件命中（跨 id 仍绑到 uid）',
      g.confusion.missing.recall === 1 && g.confusion.missing.precision === 1,
      JSON.stringify(g.confusion.missing));
    check('告警时延 = 3s', g.alertLatencyMs.median === 3000, String(g.alertLatencyMs.median));
    check('没有误报事件', g.alertEvents.false === 0, JSON.stringify(g.alertEvents));
    check('id 切换段仍归到同一条 track', rep.detail[1].locked === 7 && rep.detail[1].method === 'track');
  }

  console.log('[self-test 2] unknown 弃权与负类混淆');
  {
    const frames = [];
    for (let k = 0; k <= 6; k++) {
      const ts = k * 1000;
      frames.push(frame(ts, [
        V(5, 50, ppe(k < 2 ? 'unknown' : (k < 4 ? 'missing' : 'worn')), [0, 0, 100, 200],
          ppe(k < 2 ? 'unknown' : (k < 4 ? 'missing' : 'worn'))),
      ]));
    }
    const labels = {
      camera: 'side',
      segments: [
        { action: 'ppe', target: 'helmet', expect: 'unknown', track: 5, start: 0, end: 1500 },
        // 标称 worn，实际 missing：既漏 worn，也误报 missing
        { action: 'ppe', target: 'helmet', expect: 'worn', track: 5, start: 2000, end: 3500 },
        // 标称 missing，实际 worn
        { action: 'ppe', target: 'helmet', expect: 'missing', track: 5, start: 4000, end: 6000 },
      ],
    };
    const rep = evaluatePpe([{ name: 'syn2', frames, labels }]);
    const g = rep.groups.find((x) => x.target === 'helmet' && x.camera === 'side');
    check('unknown 段正确弃权', g.confusion.unknown.tp === 1 && g.confusion.unknown.recall === 1);
    check('worn 与 missing 互相当 FP/FN',
      g.confusion.worn.fn === 1 && g.confusion.missing.fp === 1
      && g.confusion.missing.fn === 1 && g.confusion.worn.fp === 1,
      JSON.stringify({ worn: g.confusion.worn, missing: g.confusion.missing }));
    check('unknown 弃权率 = 1/3', g.unknownAbstainRate === 0.333, String(g.unknownAbstainRate));
  }

  console.log('[self-test 3] label.track 缺省时的绑定');
  {
    const frames = [];
    for (let k = 0; k <= 4; k++) {
      const ts = k * 1000;
      frames.push(frame(ts, [
        V(1, 11, ppe('worn'), [0, 0, 80, 200]),
        V(2, 22, ppe('missing'), [300, 0, 400, 200]),
      ]));
    }
    const labels = {
      camera: 'gate',
      segments: [
        // 无 track、有 bbox：按段内最早的 IoU 绑到第二个人
        { action: 'ppe', target: 'helmet', expect: 'missing', bbox: [300, 0, 400, 200], start: 0, end: 4000 },
        // 无 track、无 bbox、多人：按任一人统计并标记 ambiguous
        { action: 'ppe', target: 'helmet', expect: 'worn', start: 0, end: 1000 },
      ],
    };
    const rep = evaluatePpe([{ name: 'syn3', frames, labels }]);
    const bboxSeg = rep.detail[0];
    const anySeg = rep.detail[1];
    check('bbox 绑定到 IoU 最大的人', bboxSeg.method === 'bbox' && bboxSeg.locked === 22, JSON.stringify(bboxSeg));
    check('bbox 段预测 missing', bboxSeg.predicted === 'missing');
    check('多人无 track 段标记 ambiguous 并按任一人统计',
      anySeg.method === 'any' && anySeg.ambiguous === true && anySeg.predicted === 'worn');
  }

  console.log('[self-test 4] 旧数据必须报错，不静默算 0');
  {
    let threw = false;
    try {
      evaluatePpe([{ name: 'old', frames: [{ ts: 0, persons: [{}] }], labels: null }]);
    } catch (e) { threw = /verdicts/.test(e.message); }
    check('没有 verdicts[] → 明确报错', threw);

    const rep = evaluatePpe([{
      name: 'single',
      frames: [frame(0, [V(1, null, ppe('worn'))]), frame(1000, [V(1, null, ppe('worn'))])],
      labels: { camera: 'x', segments: [{ action: 'ppe', target: 'helmet', expect: 'worn', start: 0, end: 1000 }] },
    }]);
    check('只有主目标时给出降级告警', rep.warnings.some((w) => /单目标|主目标/.test(w)), rep.warnings.join(' | '));
  }

  console.log('[self-test 5] 段级 camera / 晚进场 track / bbox 失配');
  {
    const frames = [];
    for (let k = 0; k <= 9; k++) {
      const ts = k * 1000;
      const vs = [V(1, 11, ppe('worn'), [0, 0, 80, 200])];
      if (k >= 3) {
        vs.push(V(2, 7, ppe('missing', ts >= 6000 ? 'violation' : 'none', Math.max(0, ts - 3000)),
          [300, 0, 400, 200]));
      }
      frames.push(frame(ts, vs));
    }
    // 只写段级 camera（docs 的写法），没有 clip 级 camera：段与事件必须落到同一个组。
    const labels = {
      segments: [
        // uid 7 在 3s 才进场；段从 0s 开始也必须能绑上（逐帧扫描整个段）
        { action: 'ppe', target: 'helmet', expect: 'missing', track: 7, start: 0, end: 9000, camera: 'gate' },
        { action: 'ppe', target: 'helmet', expect: 'worn', track: 11, start: 0, end: 2000, camera: 'gate' },
        // bbox 与任何人都不重合 → 明确 bbox_not_found，而不是静默按「任一人」计分
        { action: 'ppe', target: 'helmet', expect: 'worn', bbox: [900, 900, 950, 950], start: 0, end: 1000, camera: 'gate' },
      ],
    };
    const rep = evaluatePpe([{ name: 'syn5', frames, labels }]);
    const gates = rep.groups.filter((g) => g.camera === 'gate');
    check('段级 camera 一致 → 段与事件同一组（没有 clip 名影子组）',
      gates.length === 1 && rep.groups.every((g) => g.camera === 'gate'),
      rep.groups.map((g) => g.camera).join(','));
    check('段级 camera 下事件能命中 missing 段、perHour 可算',
      gates[0].alertEvents.total === 1 && gates[0].alertEvents.true === 1
      && gates[0].alertEvents.perHour != null, JSON.stringify(gates[0].alertEvents));
    check('track 在段中途才出现也能绑定',
      rep.detail[0].status === 'ok' && rep.detail[0].locked === 7, JSON.stringify(rep.detail[0]));
    check('bbox 完全失配 → bbox_not_found（不静默按任一人）',
      rep.detail[2].status === 'bbox_not_found', JSON.stringify(rep.detail[2]));
  }

  console.log('[self-test 6] 弃权不计入 FN/FP');
  {
    const rep = evaluatePpe([{
      name: 'syn6',
      frames: [frame(0, [V(1, 11, ppe('unknown'), [0, 0, 100, 200])])],
      labels: {
        camera: 'x',
        segments: [{ action: 'ppe', target: 'helmet', expect: 'worn', track: 11, start: 0, end: 0 }],
      },
    }]);
    const g = rep.groups[0];
    check('标签 worn、预测 unknown → 只记弃权（不计 FN/FP）',
      g.abstained === 1 && g.confusion.worn.fn === 0 && g.confusion.worn.nRecall === 0
      && g.confusion.unknown.fp === 0, JSON.stringify({ abstained: g.abstained, worn: g.confusion.worn }));
    check('弃权率 = 1', g.unknownAbstainRate === 1, String(g.unknownAbstainRate));
  }

  console.log(`\nself-test：${pass} 通过，${fail} 失败`);
  return fail ? 1 : 0;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.selfTest) return selfTest();

  let clips;
  if (opts.dir) {
    clips = await clipsFromDir(opts.dir);
    if (!clips.length) throw new Error(`${opts.dir} 下没有 *.frames.json / *.jsonl`);
  } else {
    if (!opts.input || !opts.labels) throw new Error(`需要 --input 与 --labels\n\n${USAGE}`);
    clips = [{
      name: path.basename(opts.input),
      frames: await loadFrames(opts.input),
      labels: await loadLabelDoc(opts.labels),
    }];
  }
  if (opts.dir) {
    const before = clips.length;
    clips = clips.filter((c) => {
      if (c.labels) return true;
      console.warn(`[warn] 跳过 ${c.name}：没有同名 labels 文件（不能静默算 0）`);
      return false;
    });
    if (!clips.length) throw new Error(`--dir 下的 ${before} 个帧文件都没有 labels，无法评估`);
    // 目录里常混有旧的/非 PPE 的导出：明确跳过并说明原因，不让它把整批评估拖挂。
    const withPpe = clips.filter((c) => (c.frames || []).some(
      (f) => Array.isArray(f?.verdicts) && f.verdicts.some((v) => v?.ppe),
    ));
    for (const c of clips) {
      if (!withPpe.includes(c)) {
        console.warn(`[warn] 跳过 ${c.name}：没有带 ppe 的 verdicts[]（旧导出或未开物体检测）`);
      }
    }
    clips = withPpe;
    if (!clips.length) {
      throw new Error('--dir 下的帧文件都没有带 ppe 的 verdicts[]：旧导出无法评估 PPE 事件（不是 0 分）');
    }
  } else if (!clips[0].labels) {
    throw new Error(`${clips[0].name} 没有 labels；PPE 事件评估必须有标注（不能静默算 0）`);
  }

  const rep = evaluatePpe(clips, opts);
  const md = reportMarkdown(rep, opts);
  if (opts.report) {
    await writeFile(opts.report, md, 'utf8');
    if (!opts.quiet) console.log(`报告：${opts.report}`);
  }
  if (opts.json) console.log(JSON.stringify(rep, null, 2));
  else if (!opts.quiet && !opts.report) console.log(md);

  let bad = false;
  for (const g of rep.groups) {
    if (opts.minRecall != null && g.confusion.missing.nRecall > 0
      && g.confusion.missing.recall < opts.minRecall) bad = true;
    if (opts.maxFa != null && g.alertEvents.perHour != null && g.alertEvents.perHour > opts.maxFa) bad = true;
  }
  return bad ? 2 : 0;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error(`错误：${e?.message || e}`);
    process.exit(1);
  });
}
