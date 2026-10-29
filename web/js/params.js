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
    // —— 3D（worldLandmarks）——
    // 默认只开「语义与 2D 直接可比」的两类：关节角、直立度。
    // legVertical / ratios 的量纲相对 2D 有系统性偏移（3D 腿长/躯干 ≈2.0，2D 约 1.3），
    // 先保持 2D 判定、把它们以 *_3d 信号导出，等 R4 用数据重拟合阈值后再切（见 docs/signals.md §一·五）。
    world: {
      enabled: true,          // 总开关；false 时所有信号退回 2D
      angles: true,           // knee_L/R、elbow_L/R、hip_L/R 有 world 时用 3D 夹角
      uprightness: true,      // 躯干向量与重力轴的点积（抗相机倾斜）
      legVertical: false,     // 3D 腿竖直比（量纲与 2D 不同，R4 再开）
      ratios: false,          // reach / hands_close / head / onHips 的距离比值改用世界距离
      // 骨骼长度一致性：每条肢体在 world 下的长度做个体中位数，当前帧偏离 > tolerance 判不可靠。
      // 比 visibility 更能抓住「手在背后、腕点漂到别处」。
      boneCheck: { enabled: true, windowFrames: 60, minSamples: 10, tolerance: 0.2 },
    },
    // 一阶差分：角速度（度/秒）
    velocity: { minCutoff: 3.0, beta: 0.05, minDtMs: 8, maxDtMs: 500 },
    // 短时遮挡外推：可见性掉下去但不超过这个时长时，按最后速度外推并标记 extrapolated
    occlusion: { maxExtrapMs: 300 },
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
      // 手臂伸出：腕到肩距离 / scale。自然下垂实测 ≈0.84，前伸约 1.5+
      extend: { minReach: 1.25, minElev: 30 },
      // 3D 水平方位角：0°=正前方，±90°=正侧方。用来区分前平举与侧平举。
      // 必须配合「手臂接近水平」才有效：手自然下垂时水平分量接近 0，方位角是噪声
      azimuth: { frontMax: 35, sideMin: 55, minElev: 60, maxElev: 120 },
      // 持物：手闭合且臂未伸出
      carry: { maxReach: 1.2 },
    },
    hand: {
      // 判定为「握住」的手势。ok/gun 是捏取，也算能拿东西
      closedShapes: ['fist', 'ok'],
    },
    grasp: {
      // 拿取状态机的时间窗
      reachToGraspMs: 1500,   // 伸手后多久内合手才算拿取
      minPhaseMs: 120,        // 每阶段最短持续，滤掉单帧抖动
      releaseMs: 200,         // 张手后多久确认「放下」
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
      reach: 250, carry: 300, point: 250,
    },
    // adaptiveMs：有历史后，用「半程时长中位数 × adaptiveMinRatio」替代固定 minCycleMs。
    // 挥手/快速深蹲不再被固定周期判成抖动，慢动作也不会因此漏计（见 docs/signals.md §二）。
    // 没有历史时门槛放宽到 minCycleMs × adaptiveBootstrapRatio，否则真实的快节奏
    // （鼓掌半程约 200ms）第一次就被拒，永远攒不出历史。
    reps: {
      squat: { down: 100, up: 150, minCycleMs: 600, minHalfMs: 120, adaptiveMs: true, adaptiveWindow: 5, adaptiveMinRatio: 0.5, adaptiveBootstrapRatio: 0.5 },
      pushup: { down: 90, up: 150, minCycleMs: 500, minHalfMs: 120, adaptiveMs: true, adaptiveWindow: 5, adaptiveMinRatio: 0.5, adaptiveBootstrapRatio: 0.5 },
      clap: { down: 0.45, up: 1.0, minCycleMs: 400, minHalfMs: 100, adaptiveMs: true, adaptiveWindow: 5, adaptiveMinRatio: 0.5, adaptiveBootstrapRatio: 0.5 },
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
