// hardcase.js — 难例闭环的纯逻辑（不碰 DOM，Node 可单测）
//
// 页面上的「判错了」按钮：把点击前 3s + 之后 2s 的**帧**导出，并附一条草稿 label。
// 为什么导出帧而不是视频：离线可复现、体积极小、不保存人像（PLAN §13.3 R6）。
// 导出的帧保留原始 ts / video_time，所以草稿 label 可以直接被 evaluate.mjs 读取。

export const HARDCASE_BEFORE_MS = 3000;
export const HARDCASE_AFTER_MS = 2000;

// value 必须与 evaluate.mjs 支持的 labels.action 一致：
// 姿态 id / 手臂 flag / 计数名 / none。
export const HARDCASE_ACTIONS = [
  { group: '反例', value: 'none', label: '不应出现（none）' },
  { group: '姿态', value: 'stand', label: '站立' },
  { group: '姿态', value: 'sit', label: '坐' },
  { group: '姿态', value: 'squat_static', label: '下蹲' },
  { group: '姿态', value: 'lying', label: '躺卧' },
  { group: '手臂', value: 'armRaised', label: '举手' },
  { group: '手臂', value: 'waving', label: '挥手' },
  { group: '手臂', value: 'crossed', label: '抱臂' },
  { group: '手臂', value: 'onHips', label: '叉腰' },
  { group: '手臂', value: 'armsOpen', label: '张开双臂' },
  { group: '手臂', value: 'bothHandsUp', label: '双手高举' },
  { group: '手臂', value: 'handAtHead', label: '手在头部' },
  { group: '计数', value: 'squat', label: '深蹲' },
  { group: '计数', value: 'pushup', label: '俯卧撑' },
  { group: '计数', value: 'clap', label: '鼓掌' },
];

const VALID_ACTIONS = new Set(HARDCASE_ACTIONS.map((a) => a.value));

export function isValidHardcaseAction(action) {
  return VALID_ACTIONS.has(action);
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
 * @param {Array} frames 页面帧缓存（frameLog）
 * @param {number} clickTs 点击时刻（performance.now，与帧 ts 同基准）
 * @param {object} opts action / beforeMs / afterMs / detected / baseMeta / now
 * @returns {{frames: Array, labels: object, meta: object}}
 */
export function buildHardcase(frames, clickTs, {
  action = 'none',
  beforeMs = HARDCASE_BEFORE_MS,
  afterMs = HARDCASE_AFTER_MS,
  detected = null,
  baseMeta = {},
  now = Date.now(),
} = {}) {
  if (!isValidHardcaseAction(action)) throw new Error(`未知难例动作：${action}`);
  const win = extractWindow(frames, clickTs, beforeMs, afterMs);
  const seg = segmentFor(win, action);
  const note = [
    `点击时刻 ${Math.round(clickTs)}ms`,
    `窗口 ${win.length} 帧`,
    detected
      ? `当时判定 ${detected.posture ?? '—'}，计数 蹲${detected.reps?.squat ?? 0}/俯${detected.reps?.pushup ?? 0}/掌${detected.reps?.clap ?? 0}`
      : '无判定',
  ].join('；');
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
