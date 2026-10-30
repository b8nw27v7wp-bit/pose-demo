// hardcase.js — 难例闭环的纯逻辑（不碰 DOM，Node 可单测）
//
// 页面上的「判错了」按钮：把点击前 3s + 之后 2s 的**帧**导出，并附一条草稿 label。
// 为什么导出帧而不是视频：离线可复现、体积极小、不保存人像（PLAN §13.3 R6）。
// 导出的帧保留原始 ts / video_time，所以草稿 label 可以直接被 evaluate.mjs 读取。

import { ACTION_CATALOG, ARM_ACTIONS, REP_ACTIONS } from './actions.js';

export const HARDCASE_BEFORE_MS = 3000;
export const HARDCASE_AFTER_MS = 2000;

// 下拉项从动作注册表派生（js/actions.js），不手抄。
// value 必须与 evaluate.mjs 支持的 labels.action 一致：姿态 id / 手臂 flag / 计数名 / none / noArm / !动作。
//
// 为什么需要 `!动作`（P1-4）：之前只有 none 这一个反例，而 none 的语义是
// 「姿态和手臂都不许出现」——人站着时必然失败，还会连带把 stand 的 precision 拉低。
// 模型误判「叉腰」但其实没有时，用户需要表达「只是不应出现叉腰」而不是「整帧空镜」。
// noArm 再补上一种常见情形：姿态不限（站/坐都行），但任何手臂动作都不应出现。
//
// evaluate.mjs 的 parseSegment 已支持这两种写法：
//   "!动作" → { action:"动作", expect:false }（等价于显式写 expect:false）
//   "noArm" → 姿态不限，但不得出现任何手臂动作
// 所以这里只需要产出正确的 labels.action，评估器不用改。
export const HARDCASE_ACTIONS = [
  { group: '反例', value: 'none', label: '不应出现（none：姿态和手臂都不许有）' },
  { group: '反例', value: 'noArm', label: '不应出现任何手臂动作（noArm）' },
  // 每个已注册动作都有正例与反例两个选项；反例单独成组放在前面，方便误判时先选。
  ...ACTION_CATALOG.map((a) => ({
    group: '反例 · 动作', value: `!${a.id}`, label: `不应出现：${a.name}`,
  })),
  ...ARM_ACTIONS.map((a) => ({
    group: '反例 · 动作', value: `!${a.flag}`, label: `不应出现：${a.name}`,
  })),
  ...REP_ACTIONS.map((r) => ({
    group: '反例 · 动作', value: `!${r.id}`, label: `不应出现：${r.name}`,
  })),
  ...ACTION_CATALOG.map((a) => ({ group: '姿态', value: a.id, label: a.name })),
  ...ARM_ACTIONS.map((a) => ({ group: '手臂', value: a.flag, label: a.name })),
  ...REP_ACTIONS.map((r) => ({ group: '计数', value: r.id, label: r.name })),
];

// 可加 `!` 前缀的「已注册动作」：姿态 id、手臂 flag、计数 id。
// none / noArm 不在这个集合里，所以 `!none`、`!noArm` 会被拒绝——
// 它们本身就是反例，再加负号没有意义，也说明调用方搞错了语义。
const REGISTERED_ACTIONS = new Set([
  ...ACTION_CATALOG.map((a) => a.id),
  ...ARM_ACTIONS.map((a) => a.flag),
  ...REP_ACTIONS.map((r) => r.id),
]);

const NEG_PREFIX = '!';
const SPECIAL_ACTIONS = new Set(['none', 'noArm']);

/**
 * 合法难例动作：
 * - 已注册的正例动作（姿态 id / 手臂 flag / 计数 id）；
 * - 'none'（空镜/无人）、'noArm'（姿态不限、无手臂动作）；
 * - '!<已注册动作>'（反例）。
 * 拒绝：'!unknown'、'!!x'、'!none'、'!noArm'、空串/非字符串。
 * 与 evaluate.mjs 的 parseSegment 保持同一套语法，导出后可直接被评估器读取。
 */
export function isValidHardcaseAction(action) {
  if (typeof action !== 'string' || action === '') return false;
  if (SPECIAL_ACTIONS.has(action)) return true;
  if (action.startsWith(NEG_PREFIX)) {
    return REGISTERED_ACTIONS.has(action.slice(NEG_PREFIX.length));
  }
  return REGISTERED_ACTIONS.has(action);
}

/** 点击时刻前后 [clickTs−before, clickTs+after] 的帧（闭区间）。 */
export function extractWindow(frames, clickTs, beforeMs = HARDCASE_BEFORE_MS, afterMs = HARDCASE_AFTER_MS) {
  if (!Number.isFinite(clickTs)) return [];
  const lo = clickTs - beforeMs;
  const hi = clickTs + afterMs;
  return (frames || []).filter((f) => Number.isFinite(f && f.ts) && f.ts >= lo && f.ts <= hi);
}

/**
 * 草稿 label 的时间基：
 * - 有 video_time（视频文件）→ startSec/endSec，与 evaluate.mjs 的口径一致；
 * - 没有（摄像头）→ start/end 毫秒，与帧的 ts 同基准。
 * 两端都取窗口内**实际帧**的时间，而不是 clickTs±窗口，避免把不存在的帧标进去。
 */
export function segmentFor(windowFrames, action) {
  if (!windowFrames.length) return null;
  const first = windowFrames[0];
  const last = windowFrames[windowFrames.length - 1];
  const hasVideo = windowFrames.every((f) => Number.isFinite(f.video_time));
  // 视频循环时 video_time 会回绕（endSec < startSec），这种窗口不能用秒数标，退回 ts。
  if (hasVideo && last.video_time >= first.video_time) {
    return {
      action,
      startSec: Math.round(first.video_time * 1000) / 1000,
      endSec: Math.round(last.video_time * 1000) / 1000,
    };
  }
  return { action, start: first.ts, end: last.ts };
}

/**
 * 组装难例导出。
 * action 原样写进 segment 和 meta.hardcase.action：
 * 反例 `!动作` 与 noArm 都不改写成 expect:false 对象——
 * evaluate.mjs 的 parseSegment 直接认这两种字符串写法，保持单一表示。
 * @param {Array} frames 页面帧缓存（frameLog）
 * @param {number} clickTs 窗口锚点（performance.now，与帧 ts 同基准）
 * @param {object} opts action / beforeMs / afterMs / detected / baseMeta / now /
 *   anchoredFrom（窗口锚到最后记录帧时传真实点击时刻）/
 *   ended（媒体确实播完了；只有它决定 note 里写不写「视频已结束」）
 * @returns {{frames: Array, labels: object, meta: object}}
 */
export function buildHardcase(frames, clickTs, {
  action = 'none',
  beforeMs = HARDCASE_BEFORE_MS,
  afterMs = HARDCASE_AFTER_MS,
  detected = null,
  baseMeta = {},
  now = Date.now(),
  anchoredFrom = null,
  ended = false,
} = {}) {
  if (!isValidHardcaseAction(action)) throw new Error(`未知难例动作：${action}`);
  const win = extractWindow(frames, clickTs, beforeMs, afterMs);
  const seg = segmentFor(win, action);
  const note = [
    `点击时刻 ${Math.round(clickTs)}ms`,
    // 锚到最后记录帧时写清楚，不写会被误读成「点击那一刻的 3 秒」；
    // 「视频已结束」只在媒体真的播完时才加——暂停/后台停推理也会锚到尾部
    anchoredFrom === null ? null
      : `${ended ? '视频已结束，' : ''}窗口锚到最后记录帧（实际点击 ${Math.round(anchoredFrom)}ms）`,
    `窗口 ${win.length} 帧`,
    detected
      ? `当时判定 ${detected.posture ?? '—'}，计数 蹲${detected.reps?.squat ?? 0}/俯${detected.reps?.pushup ?? 0}/掌${detected.reps?.clap ?? 0}`
      : '无判定',
  ].filter((s) => s !== null).join('；');
  const labels = {
    name: `hardcase-${now}`,
    source: 'Demo「判错了」按钮',
    note,
    segments: seg ? [seg] : [],
  };
  const meta = {
    ...baseMeta,
    frame_count: win.length,
    hardcase: {
      click_ts: Math.round(clickTs),
      before_ms: beforeMs,
      after_ms: afterMs,
      action,
      detected,
    },
  };
  return { frames: win, labels, meta };
}
