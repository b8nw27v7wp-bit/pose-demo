// params.js — 阈值参数的唯一定义处
// 为什么单独一层：校准（PLAN §12.3 B/D）必须能把拟合出来的阈值写进 profile 并生效。
// 阈值散落在 signals.js / actions.js 里，拟合结果就只能改源码，无法比较、无法回滚。
//
// profile 文件的格式 = 本结构的一个子集（只写要覆盖的键），见 web/profiles/ 与 docs/eval.md。
// 所有默认值都是"量级参考"，必须用自己的校准数据替换（docs/signals.md §四）。

export const DEFAULT_PARAMS = {
  signals: {
    // 平滑（单位：Hz）
    smoothing: {
      minCutoff: 1.0, beta: 0.05, dCutoff: 1.0,
      angleCutoff: 1.5, angleBeta: 0.02,
      upright: { minCutoff: 1.5, beta: 0.02 },
    },
    scaleMedianFrames: 5,
    visMin: 0.3,          // 单点可见性低于此值 → 依赖它的信号给 NaN
    minScore: 0.45,       // 人体平均置信度低于此值 → ok=false，动作层冻结
    minTorsoVis: 0.4,     // 肩/髋四点最低可见性
    wave: {
      windowMs: 800,      // 挥手判定回看窗口
      deadzone: 0.10,     // 相邻帧水平位移小于此值（单位 scale）不计翻转
      minFlips: 3,        // 窗口内最少方向翻转次数
      minAmp: 0.25,       // 窗口内最小水平幅度（单位 scale）
    },
    arm: {
      raisedMargin: 0.15,             // 腕高于肩多少 scale 算举手
      crossed: { ySpan: 1.1 },        // 两腕都在肩中点 ±ySpan·scale 内
      // 叉腰：腕贴髋 + 肘外张。少了肘外张这道门，手自然下垂也会命中（腕本来就在髋旁边）
      onHips: { maxDist: 0.65, elbowFlare: 0.22 },
      openWide: { minElev: 55, maxElev: 125, minReach: 0.9 },
      chest: { above: -0.2, below: 0.3 }, // 胸前高度区间（相对肩中点 / 髋中点，单位 scale）
      // 腕到鼻尖 / scale，小于此值算「手在头部附近」。
      // aboveShoulder：腕最多低于肩多少 scale；走路时手臂前摆会经过脸前，只判距离会误报。
      head: { maxDist: 0.55, aboveShoulder: 0.5 },
      // 3D 抬臂角（相对躯干）：0°=手在躯干延长线上（举起），90°=水平，180°=沿身体下垂
      elevTorso: { raised: 75 },
    },
    gesture: {
      streak: 3,        // 手势要连续命中几帧才切换（治「张开→剪刀手」来回闪）
    },
  },

  actions: {
    posture: {
      lying: { minMs: 450, streak: 4, uprightnessLt: 0.45, legVerticalLt: 0.8 },
      squat: { minMs: 350, streak: 4, kneeLt: 110, uprightnessGt: 0.45 },
      sit: { minMs: 450, streak: 5, kneeGt: 55, kneeLt: 135, uprightnessGt: 0.5, legVerticalLt: 1.05 },
      stand: { minMs: 350, streak: 4, uprightnessGt: 0.8, kneeGt: 150, legVerticalGt: 0.8 },
    },
    holds: {
      arm: 300, wave: 150, crossed: 400, hips: 400, open: 400,
      handFace: 350, handChest: 350, bothHandsUp: 350,
    },
    reps: {
      squat: { down: 100, up: 150, minCycleMs: 600, minHalfMs: 120 },
      pushup: { down: 90, up: 150, minCycleMs: 500, minHalfMs: 120 },
      clap: { down: 0.45, up: 1.0, minCycleMs: 400, minHalfMs: 100 },
    },
    gates: {
      squat: { legVerticalGt: 0.85, uprightnessGt: 0.6 },
      pushup: { uprightnessLt: 0.6 },
    },
  },
};

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlain(out[k]) && isPlain(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** 把 profile 覆盖项合到默认参数上。未给出的键保持默认，便于 profile 只写差分。 */
export function resolveParams(overrides = {}) {
  return deepMerge(DEFAULT_PARAMS, overrides);
}

/**
 * profile 文件的解包：文件形如 {name, note, params:{...}}，也接受裸的参数对象。
 * 页面（app.js）与评估器（evaluate.mjs）必须走同一个函数——
 * 曾经只有页面解包、CLI 没有，导致 `--profile` 静默用默认阈值却仍显示已应用。
 */
export function profileParams(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return isPlain(raw.params) ? raw.params : raw;
}

/** profile 的显示名 */
export function profileName(raw, fallback = 'default') {
  return (raw && typeof raw.name === 'string' && raw.name) || fallback;
}

/** 稳定序列化：键按字典序排列，保证"同一组参数、不同写法"得到同一个字符串。 */
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? String(v);
}

/**
 * 参数指纹（FNV-1a 32 位）。
 * 为什么需要：导出里带一份完整 params 又大又难比，事后想确认"两份数据是不是同一套阈值"
 * 只能人工 diff。指纹让"同阈值"变成一次字符串比较（PLAN §13 R0）。
 */
export function paramsHash(overrides = {}) {
  const s = stableStringify(resolveParams(overrides));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a:${(h >>> 0).toString(16).padStart(8, '0')}`;
}
