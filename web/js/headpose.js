// headpose.js — 头部朝向（yaw / pitch / roll）的纯函数实现。
//
// 输入是 MediaPipe Pose 的头部 9 点（`persons[].kp_head`，像素 + visibility）和可选的
// `kp_world`（33 点米制 3D）。**不依赖躯干/髋/膝**：只要头部点还在画面里，就能给出朝向，
// 用于设备特写、头~胸构图、只有半个头出镜的场景。
//
// 坐标与符号约定（全部按**受试者自身**的左右，和画面是否镜像无关）：
//   · yaw：正=受试者向自己的右侧转头，负=向自己的左侧，0=正前；单位度。
//   · pitch：负=抬头（向上看），正=低头（向下看），0=平视；单位度。
//   · roll：正=受试者左侧更低（头向自己的左侧倾），负=右侧更低；单位度。
//   · dir：front / left / right / up / down 及其组合（left_down 等），left/right 指受试者自身。
//
// 为什么按受试者而不是画面：页面默认水平镜像显示（`.stage.mirror`），但 kp 是原始视频
// 坐标；“画面左/右”在镜像后会反。用眼/耳关键点的解剖左右来定符号，镜像与否都不变。
//
// 默认只用 2D：Pose 的 world 面部点实测噪声很大（同一姿势 yaw 会跳 ±150°），`use3d`
// 只给需要实验的 profile。2D 的 yaw/pitch 是投影近似，不是标定过的解剖角，输出带
// `yaw_approx` / `pitch_approx`。3D yaw 取「头自身左右轴（眼/耳线）」相对相机像平面的
// 转角（先去掉 roll 分量）；不是鼻子相对眼线的偏移——那个量在刚体转头下不变。
// 3D pitch 用眼→耳中点的高差。
//
// 可信度门控（2026-11-20，实拍复核后加）：
//   · 眼对/耳对像素距离 < minPairPx → 角度置 null（远处小脸 1px 噪声就是十几度）。
//   · 鼻-眼垂直距离脱离解剖范围 → 整个头部样本不可信（角度置 null）。
//   · 眼对与耳对 yaw 差 > maxPairDisagree → 样本不可信（典型是背身/侧脸硬凑的点）。
//   · |roll| > maxRoll → roll 置 null。
//   · 耳对回退只给粗略 yaw，标 `2d_ear` / `yaw_approx`，`reliable.yaw=false`。

const EYE_L = [1, 2, 3];
const EYE_R = [4, 5, 6];
const NO = 0;
const EAR_L = 7;
const EAR_R = 8;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const deg = (rad) => (rad * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

/**
 * 取一个 2D 点。`p[2]` 缺失时按可见处理（1）——旧导出/手工数据可能只有 [x,y]；
 * 与 worldPoint 的口径保持一致，避免同一份数据 2D 全灭、3D 全信。
 */
function visiblePoint(kp, i, visMin) {
  const p = kp && kp[i];
  if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) return null;
  const v = isNum(p[2]) ? p[2] : 1;
  if (v < visMin) return null;
  return { x: p[0], y: p[1], v };
}

/** 一组点的可见性加权中心；一个都不可见返回 null。 */
function weightedCenter(kp, idxs, visMin) {
  let sx = 0; let sy = 0; let sw = 0; let n = 0;
  for (const i of idxs) {
    const p = visiblePoint(kp, i, visMin);
    if (!p) continue;
    const w = Math.max(p.v, 1e-3);
    sx += p.x * w; sy += p.y * w; sw += w; n += 1;
  }
  return n ? { x: sx / sw, y: sy / sw, n } : null;
}

function worldPoint(world, i, kp, visMin) {
  const p = world && world[i];
  if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1]) || !isNum(p[2])) return null;
  const hp = kp && kp[i];
  const vis = hp && isNum(hp[2]) ? hp[2] : 1;   // 旧数据没有 2D 可见性时按可见处理
  if (vis < visMin) return null;
  return { x: p[0], y: p[1], z: p[2], v: vis };
}

function worldCenter(world, idxs, kp, visMin) {
  let sx = 0; let sy = 0; let sz = 0; let sw = 0; let n = 0;
  for (const i of idxs) {
    const p = worldPoint(world, i, kp, visMin);
    if (!p) continue;
    const w = Math.max(p.v, 1e-3);
    sx += p.x * w; sy += p.y * w; sz += p.z * w; sw += w; n += 1;
  }
  return n ? { x: sx / sw, y: sy / sw, z: sz / sw, n } : null;
}

function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** roll：a=受试者右侧点，b=左侧点；返回度，正=左侧更低。 */
function rollOf(a, b) {
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) + Math.abs(dy) < 1e-9) return null;
  return deg(Math.atan2(dy, Math.abs(dx)));
}

/** 把 p 绕 center 旋转 -rollRad（去倾斜，让眼/耳线回到水平）。 */
function deRoll(p, center, rollDegVal) {
  if (!p || !center || !Number.isFinite(rollDegVal)) return p;
  const a = rad(-rollDegVal);
  const c = Math.cos(a); const s = Math.sin(a);
  const dx = p.x - center.x; const dy = p.y - center.y;
  return { x: center.x + c * dx - s * dy, y: center.y + s * dx + c * dy, v: p.v };
}

/**
 * 2D yaw 的归一化横向比值。
 * 去倾斜后，正面人像的 +x 指向**受试者左侧**（MediaPipe 的 left eye/ear 在原始图右侧）；
 * 取负号让正=受试者向右。
 * 耳对回退需要乘一个几何增益：耳距约为眼距的 2.4 倍，不补会把 yaw 压小一半以上。
 */
function lateralYaw(pair, nose, visMin, gain = 1) {
  if (!pair || !nose) return null;
  const roll = rollOf(pair.a, pair.b);
  const center = { x: (pair.a.x + pair.b.x) / 2, y: (pair.a.y + pair.b.y) / 2 };
  const half = dist2(pair.a, pair.b) / 2;
  if (!(half > 1e-6)) return null;
  const n = deRoll(nose, center, roll);
  return -clamp(((n.x - center.x) / half) * gain, -1, 1);
}

/** 鼻-眼垂直距离 / 眼距；正视时约 0.45，低头变大、抬头变小。 */
function pitchInfo(eyePair, nose) {
  if (!eyePair || !nose) return null;
  const roll = rollOf(eyePair.a, eyePair.b);
  const center = { x: (eyePair.a.x + eyePair.b.x) / 2, y: (eyePair.a.y + eyePair.b.y) / 2 };
  const eyeDist = dist2(eyePair.a, eyePair.b);
  if (!(eyeDist > 1e-6)) return null;
  const n = deRoll(nose, center, roll);
  const drop = (n.y - center.y) / eyeDist;
  return { drop, ratio: clamp((drop - 0.45) / 0.45, -1, 1) };
}

function normAngle180(a) {
  let v = a;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

function dirWord(yawDir, pitchDir) {
  if (!yawDir && !pitchDir) return null;
  // 某一轴被置空（如 yaw 因 pair_disagree 判不可用）时只报另一轴，
  // 不能拼出 'null_down' 这种非法标签（导出/UI 都会原样显示）。
  if (!yawDir) return pitchDir;
  if (!pitchDir) return yawDir;
  if (yawDir === 'front' && pitchDir === 'front') return 'front';
  if (yawDir === 'front') return pitchDir;
  if (pitchDir === 'front') return yawDir;
  return `${yawDir}_${pitchDir}`;
}

/**
 * 头部几何 → 原始角度。不做时间平滑/方向滞回（那两件事在 signals.js 做）。
 *
 * @param {number[][]|null} kpHead 9 点 [x,y,vis]，像素
 * @param {number[][]|null} kpWorld 33 点 [x,y,z]，米制（可缺）
 * @param {object} cfg 见 params.js `signals.head`
 * @returns {object} 角度可能为 null；`reliable` 逐轴说明幅度是否可信
 */
export function headPose(kpHead, kpWorld, cfg = {}) {
  const visMin = Number.isFinite(cfg.visMin) ? cfg.visMin : 0.3;
  const minPoints = Number.isFinite(cfg.minPoints) ? cfg.minPoints : 2;
  // 默认 2D。3D 只给实验 profile，见文件头。
  const use3d = cfg.use3d === true;
  const minPairPx = Number.isFinite(cfg.minPairPx) ? cfg.minPairPx : 10;
  const goodPairPx = Number.isFinite(cfg.goodPairPx) ? cfg.goodPairPx : 20;
  const noseDropMin = Number.isFinite(cfg.noseDropMin) ? cfg.noseDropMin : -0.3;
  const noseDropMax = Number.isFinite(cfg.noseDropMax) ? cfg.noseDropMax : 1.8;
  const maxRoll = Number.isFinite(cfg.maxRoll) ? cfg.maxRoll : 75;
  const maxPairDisagree = Number.isFinite(cfg.maxPairDisagree) ? cfg.maxPairDisagree : 105;
  const earYawGain = Number.isFinite(cfg.earYawGain) ? cfg.earYawGain : 2.4;
  const reasons = [];
  const out = {
    visible: false, points: 0, face_px: null, source: null,
    yaw_source: null, pitch_source: null, roll_source: null,
    confidence: 0,
    yaw: null, pitch: null, roll: null,
    yaw_approx: false, pitch_approx: false, roll_approx: false,
    reliable: { yaw: false, pitch: false, roll: false },
    yaw_2d: null, pitch_2d: null, roll_2d: null,
    yaw_3d: null, pitch_3d: null, roll_3d: null,
    pair: null, reasons,
  };
  if (!Array.isArray(kpHead) || kpHead.length < 9) {
    reasons.push('no_head_points');
    return out;
  }

  // 只有 [x,y] 的旧数据：按可见处理，但明确标出来。
  let visMissing = false;
  for (let i = 0; i < 9; i++) {
    const p = kpHead[i];
    if (Array.isArray(p) && isNum(p[0]) && isNum(p[1]) && !isNum(p[2])) visMissing = true;
  }
  if (visMissing) reasons.push('visibility_missing');

  const nose = visiblePoint(kpHead, NO, visMin);
  const eyeL = weightedCenter(kpHead, EYE_L, visMin);
  const eyeR = weightedCenter(kpHead, EYE_R, visMin);
  const earL = visiblePoint(kpHead, EAR_L, visMin);
  const earR = visiblePoint(kpHead, EAR_R, visMin);
  let points = 0;
  for (let i = 0; i < 9; i++) if (visiblePoint(kpHead, i, visMin)) points += 1;
  out.points = points;
  out.visible = points >= minPoints && (!!nose || (!!eyeL && !!eyeR) || (!!earL && !!earR));

  // —— 2D ——
  const eyePair = eyeL && eyeR && dist2(eyeL, eyeR) >= 2 ? { a: eyeR, b: eyeL, kind: 'eyes' } : null;
  const earPair = earL && earR && dist2(earL, earR) >= 2 ? { a: earR, b: earL, kind: 'ears' } : null;
  const pair = eyePair || earPair;
  out.pair = pair ? pair.kind : null;
  out.face_px = pair ? dist2(pair.a, pair.b) : null;
  if (!pair) reasons.push('no_face_pair');
  if (!nose) reasons.push('no_nose');

  const eyeYaw = lateralYaw(eyePair, nose, visMin, 1);
  const earYaw = lateralYaw(earPair, nose, visMin, earYawGain);
  const pi = pitchInfo(eyePair, nose);
  out.yaw_2d = pair ? (pair.kind === 'eyes' ? eyeYaw : earYaw) : null;
  out.pitch_2d = pi ? pi.ratio : null;
  out.roll_2d = pair ? rollOf(pair.a, pair.b) : null;

  // 眼对/耳对独立给出的 yaw 应该同向、量级接近。差太多说明是背身/侧脸/遮挡时
  // 模型硬凑的点（实拍里 0.1s 那帧眼对 yaw −64°、耳对 +90°，就是这种）。
  let pairDisagree = false;
  if (eyeYaw != null && earYaw != null) {
    const eyeDeg = deg(Math.asin(clamp(eyeYaw, -1, 1)));
    const earDeg = deg(Math.asin(clamp(earYaw, -1, 1)));
    if (Math.abs(eyeDeg - earDeg) > maxPairDisagree) {
      pairDisagree = true;
      reasons.push('pair_disagree');
    }
  }

  // 鼻-眼垂直距离的解剖范围。真实低头/抬头也在 1 附近；2.9 这种是鼻点落在背景上。
  let noseGeometryOk = true;
  if (pi && (pi.drop < noseDropMin || pi.drop > noseDropMax)) {
    noseGeometryOk = false;
    reasons.push('nose_geometry');
  }
  if (pi == null && nose) reasons.push('no_eye_geometry');

  const faceTooSmall = out.face_px != null && out.face_px < minPairPx;
  if (faceTooSmall) reasons.push('face_too_small');
  const rollExtreme2 = out.roll_2d != null && Math.abs(out.roll_2d) > maxRoll;
  if (rollExtreme2) reasons.push('roll_extreme');

  // 整个头部样本是否可信：尺度 + 鼻-眼几何。不可信时三轴都不给——
  // 否则会出现「yaw 置 null、roll 还照常输出」的半截结果。
  const sampleOk = !faceTooSmall && noseGeometryOk;
  const yaw2dOk = out.yaw_2d != null && sampleOk && !pairDisagree;
  const pitch2dOk = out.pitch_2d != null && sampleOk;
  const roll2dOk = out.roll_2d != null && sampleOk && !rollExtreme2;

  // —— 3D（world，可选）——
  // 默认不用。保留实现只给实验 profile：yaw 用鼻相对眼/耳中心的横向分量，
  // 横向轴取 world 眼线的水平投影，因此天然去掉 roll 对鼻点 x 的污染；
  // pitch 用眼→耳中点高差；roll 用眼/耳线。
  let yaw3 = null;
  let pitch3 = null;
  let roll3 = null;
  if (use3d) {
    const wEyeL = kpWorld ? worldCenter(kpWorld, EYE_L, kpHead, visMin) : null;
    const wEyeR = kpWorld ? worldCenter(kpWorld, EYE_R, kpHead, visMin) : null;
    const wEarL = kpWorld ? worldPoint(kpWorld, EAR_L, kpHead, visMin) : null;
    const wEarR = kpWorld ? worldPoint(kpWorld, EAR_R, kpHead, visMin) : null;
    const wNose = kpWorld ? worldPoint(kpWorld, NO, kpHead, visMin) : null;
    const wEyePair = wEyeL && wEyeR && dist3(wEyeL, wEyeR) > 1e-4 ? { a: wEyeR, b: wEyeL } : null;
    const wEarPair = wEarL && wEarR && dist3(wEarL, wEarR) > 1e-4 ? { a: wEarR, b: wEarL } : null;
    const wPair = wEyePair || wEarPair;
    if (wPair) {
      roll3 = rollOf(wPair.a, wPair.b);
      if (wNose) {
        // yaw 取「头自身左右轴」相对相机像平面的转角（world xz 平面，b=左侧点，a=右侧点）。
        // 真人转头是刚体旋转：眼/耳线跟着头一起转，鼻子相对眼线的几何不变——所以旧实现
        // 「鼻相对眼线的横向/前向分量」对刚性转头恒为 0（转 30°/60° 实测 yaw_3d≈0），
        // 只有「只挪鼻点」的非刚体夹具能出角度。左右轴的转角才是转头的真实观测。
        // roll 会把横向分量转到 y 上，先用 hypot 还原水平长度再取角（|roll|<90 时有效）。
        const latX = wPair.b.x - wPair.a.x;
        const latY = wPair.b.y - wPair.a.y;
        const latZ = wPair.b.z - wPair.a.z;
        const horizontal = Math.hypot(latX, latY);
        const dirX = (Math.sign(latX) || 1) * horizontal;
        if (horizontal > 1e-6) {
          yaw3 = -deg(Math.atan2(latZ, dirX));   // 正=受试者向右
        }
        // 缺鼻时三轴一律不给（与 2D 口径和文档承诺一致）：这里保留 wNose 守卫，
        // 即使左右轴的转向本身不依赖鼻点。
      }
      if (wEyeL && wEyeR && wEarL && wEarR) {
        // 低头时耳相对眼抬高（y 向下，耳 y 变小），用眼→耳向量估计 pitch。
        const eyeMid = { x: (wEyeL.x + wEyeR.x) / 2, y: (wEyeL.y + wEyeR.y) / 2, z: (wEyeL.z + wEyeR.z) / 2 };
        const earMid = { x: (wEarL.x + wEarR.x) / 2, y: (wEarL.y + wEarR.y) / 2, z: (wEarL.z + wEarR.z) / 2 };
        const vx = earMid.x - eyeMid.x;
        const vy = earMid.y - eyeMid.y;
        const vz = earMid.z - eyeMid.z;
        pitch3 = deg(Math.atan2(-vy, Math.hypot(vx, vz)));
      }
    }
    if (yaw3 == null && pitch3 == null && roll3 == null) reasons.push('no_world_3d');
    if (pitch3 == null) reasons.push('no_world_pitch');
  }

  // 诊断字段：3D 候选值（未过门控）。out.yaw/pitch/roll 可能是 2D，这里保留「同一帧算出了
  // 什么 3D 值」，供 profile 调 use3d 时对照；默认（非 use3d）为 null。
  out.yaw_3d = yaw3;
  out.pitch_3d = pitch3;
  out.roll_3d = roll3;

  const rollExtreme3 = roll3 != null && Math.abs(roll3) > maxRoll;
  if (rollExtreme3) reasons.push('roll_extreme');
  const useYaw3 = yaw3 != null && sampleOk && !pairDisagree;
  const usePitch3 = pitch3 != null && sampleOk;
  const useRoll3 = roll3 != null && sampleOk && !rollExtreme3;

  // 选源：3D 有效才用 3D；否则 2D（有耳对时标 2d_ear）。
  out.yaw = useYaw3 ? yaw3 : (yaw2dOk ? deg(Math.asin(clamp(out.yaw_2d, -1, 1))) : null);
  out.pitch = usePitch3 ? pitch3 : (pitch2dOk ? clamp(out.pitch_2d, -1, 1) * 45 : null);
  out.roll = useRoll3 ? roll3 : (roll2dOk ? out.roll_2d : null);

  const earFallback = pair?.kind === 'ears';
  out.yaw_source = out.yaw != null ? (useYaw3 ? '3d' : (earFallback ? '2d_ear' : '2d')) : null;
  out.pitch_source = out.pitch != null ? (usePitch3 ? '3d' : '2d') : null;
  out.roll_source = out.roll != null ? (useRoll3 ? '3d' : '2d') : null;
  out.source = out.yaw_source || out.pitch_source || out.roll_source || null;
  out.yaw_approx = out.yaw != null && out.yaw_source !== '3d';
  out.pitch_approx = out.pitch != null && out.pitch_source !== '3d';
  out.roll_approx = out.roll != null && out.roll_source !== '3d';

  // 2D 的 yaw/pitch 在侧脸/极端俯仰时会顶到 ±1（asin 后 ±90°/±45°），此时方向还能用，
  // magnitude 不可信：降置信并写明原因，别让 UI 把 ±90° 当成精确角。
  const yawSat = out.yaw != null && (
    (out.yaw_source === '3d' && Math.abs(out.yaw) >= 89.5)
    || (out.yaw_source !== '3d' && out.yaw_2d != null && Math.abs(out.yaw_2d) >= 0.95));
  if (yawSat) reasons.push('yaw_saturated');
  const pitchSat = out.pitch != null && out.pitch_source !== '3d'
    && out.pitch_2d != null && Math.abs(out.pitch_2d) >= 0.95;
  if (pitchSat) reasons.push('pitch_saturated');

  out.reliable.yaw = out.yaw != null && !yawSat && out.yaw_source !== '2d_ear';
  out.reliable.pitch = out.pitch != null && !pitchSat;
  out.reliable.roll = out.roll != null;

  // 置信度：点越多、眼对越可信、3D 越高；再乘尺度/门控惩罚。不是概率。
  let conf = clamp(points / 6, 0, 1);
  if (!pair) conf *= 0.45;
  else if (pair.kind === 'ears') conf *= 0.6;
  if (!nose) conf *= 0.7;
  if (out.face_px != null) conf *= clamp(out.face_px / goodPairPx, 0.15, 1);
  if (out.source !== '3d') conf *= 0.85;
  if (earFallback) conf *= 0.7;
  if (faceTooSmall) conf = Math.min(conf, 0.25);
  if (pairDisagree) conf *= 0.6;
  if (!noseGeometryOk) conf *= 0.6;
  if (rollExtreme2 || rollExtreme3) conf *= 0.85;
  if (yawSat) conf *= 0.75;
  if (pitchSat) conf *= 0.85;
  if (visMissing) conf *= 0.95;
  out.confidence = Math.round(clamp(conf, 0, 1) * 1000) / 1000;

  if (!out.visible) {
    if (points < minPoints) reasons.push('few_points');
  }
  out.reasons = [...new Set(reasons)];
  return out;
}

/**
 * 方向量化 + 滞回。角度可以是 null（那一轴就输出 null）。
 * prev 是上一帧的 {yawDir, pitchDir}；进入用 enter、退出用 exit，避免阈值附近抖动。
 *
 * 2D 用原始归一化量（0.3/0.18、0.25/0.12），3D 用度数（15°/8°、12°/6°）。
 * `source_yaw/source_pitch` 由 headPose 给出；缺省时按度数处理（兼容旧调用）。
 */
export function headDirection(pose, prev = {}, cfg = {}) {
  const yawEnter = Number.isFinite(cfg.yawEnter) ? cfg.yawEnter : 15;
  const yawExit = Number.isFinite(cfg.yawExit) ? cfg.yawExit : 8;
  const pitchEnter = Number.isFinite(cfg.pitchEnter) ? cfg.pitchEnter : 12;
  const pitchExit = Number.isFinite(cfg.pitchExit) ? cfg.pitchExit : 6;
  const yaw2dEnter = Number.isFinite(cfg.yaw2dEnter) ? cfg.yaw2dEnter : 0.3;
  const yaw2dExit = Number.isFinite(cfg.yaw2dExit) ? cfg.yaw2dExit : 0.18;
  const pitch2dEnter = Number.isFinite(cfg.pitch2dEnter) ? cfg.pitch2dEnter : 0.25;
  const pitch2dExit = Number.isFinite(cfg.pitch2dExit) ? cfg.pitch2dExit : 0.12;

  const axis = (value, prevDir, enter, exit) => {
    if (!Number.isFinite(value)) return null;
    const pos = prevDir === 'right' || prevDir === 'down';
    const neg = prevDir === 'left' || prevDir === 'up';
    const threshold = (pos || neg) ? exit : enter;
    if (pos) return value >= threshold ? prevDir : (value <= -enter ? 'neg' : 'front');
    if (neg) return value <= -threshold ? prevDir : (value >= enter ? 'pos' : 'front');
    if (value >= enter) return 'pos';
    if (value <= -enter) return 'neg';
    return 'front';
  };

  // 2D 角度是 asin 映射后的度数；sin(deg) 就是原始归一化量，用它套 2D 阈值。
  // 兼容两套字段名：headPose 输出用 yaw_source/pitch_source，signals 传 source_yaw/source_pitch。
  const sourceYaw = pose?.source_yaw !== undefined ? pose.source_yaw : pose?.yaw_source;
  const sourcePitch = pose?.source_pitch !== undefined ? pose.source_pitch : pose?.pitch_source;
  const yaw2dSource = sourceYaw === '2d' || sourceYaw === '2d_ear';
  const pitch2dSource = sourcePitch === '2d';

  let yawDir = null;
  if (Number.isFinite(pose?.yaw)) {
    const v = yaw2dSource ? Math.sin(rad(pose.yaw)) : pose.yaw;
    const d = axis(v, prev.yawDir, yaw2dSource ? yaw2dEnter : yawEnter,
      yaw2dSource ? yaw2dExit : yawExit);
    yawDir = d === 'pos' ? 'right' : d === 'neg' ? 'left' : d;
  } else if (Number.isFinite(pose?.yaw_2d) && sourceYaw === undefined) {
    // 兼容旧调用：只有原始 yaw_2d、没有 source 标记时按 2D 阈值。
    // 注意 source 显式为 null 时**不**回退——那是 headPose 的门控结论，
    // 绕过它会让被尺度/几何门挡掉的帧又按原始比值给出方向。
    const d = axis(pose.yaw_2d, prev.yawDir, yaw2dEnter, yaw2dExit);
    yawDir = d === 'pos' ? 'right' : d === 'neg' ? 'left' : d;
  }

  let pitchDir = null;
  if (Number.isFinite(pose?.pitch)) {
    const v = pitch2dSource ? clamp(pose.pitch / 45, -1, 1) : pose.pitch;
    const d = axis(v, prev.pitchDir, pitch2dSource ? pitch2dEnter : pitchEnter,
      pitch2dSource ? pitch2dExit : pitchExit);
    pitchDir = d === 'pos' ? 'down' : d === 'neg' ? 'up' : d;
  } else if (Number.isFinite(pose?.pitch_2d) && sourcePitch === undefined) {
    const d = axis(pose.pitch_2d, prev.pitchDir, pitch2dEnter, pitch2dExit);
    pitchDir = d === 'pos' ? 'down' : d === 'neg' ? 'up' : d;
  }

  return { yawDir, pitchDir, dir: dirWord(yawDir, pitchDir) };
}

/** 方向组合词；signals 层做去抖后要用同一套拼接规则。 */
export function headDirWord(yawDir, pitchDir) {
  return dirWord(yawDir, pitchDir);
}

/**
 * 方向去抖：候选方向要稳定 holdMs 才切换。
 * 首次获得方向立即生效（避免开局空窗）；丢失方向也先保持 holdMs 再置 null。
 * 只影响 UI/导出里的方向状态，不影响角度值和动作判定。
 */
export class DirectionHold {
  constructor() { this.state = {}; }

  reset() { this.state = {}; }

  update(axis, cand, tSec, holdMs = 200) {
    const st = this.state[axis] || (this.state[axis] = { cur: null, cand: null, since: 0 });
    if (!(holdMs > 0) || cand === st.cur) {
      st.cur = cand;
      st.cand = cand;
      st.since = tSec;
      return st.cur;
    }
    if (st.cur === null && cand !== null) {
      st.cur = cand;
      st.cand = cand;
      st.since = tSec;
      return st.cur;
    }
    if (cand !== st.cand) {
      st.cand = cand;
      st.since = tSec;
      return st.cur;
    }
    if ((tSec - st.since) * 1000 >= holdMs) {
      st.cur = cand;
      return st.cur;
    }
    return st.cur;
  }
}

export const HEAD_DIR_LABELS = {
  front: '正前', left: '左', right: '右', up: '上', down: '下',
  left_up: '左上', left_down: '左下', right_up: '右上', right_down: '右下',
};

function sourceLabel(head) {
  const set = new Set([head.yaw_source, head.pitch_source, head.roll_source].filter(Boolean));
  if (!set.size) return '—';
  return [...set].map((s) => (s === '3d' ? '3D' : s === '2d_ear' ? '2D耳' : '2D')).join('/');
}

/** 给 UI 用的一行摘要；不可见/点不足时说明原因。 */
export function headPoseText(head) {
  if (!head) return '—';
  if (head.disabled) return '已关闭';
  if (!head.visible) return head.points ? '头部点不足' : '头部不可见';
  const hasAngle = Number.isFinite(head.yaw) || Number.isFinite(head.pitch) || Number.isFinite(head.roll);
  if (!hasAngle) {
    if (head.reasons?.includes('face_too_small')) return '头部太小/太远';
    if (head.reasons?.includes('nose_geometry') || head.reasons?.includes('pair_disagree')) {
      return '头部几何不可用（遮挡/背身？）';
    }
    if (head.reasons?.includes('angle_outlier')) return '头部角度坏点';
    return '头部角度不可用';
  }
  const dir = HEAD_DIR_LABELS[head.dir] || null;
  const ang = [];
  if (Number.isFinite(head.yaw) && Math.abs(head.yaw) >= 1) {
    ang.push(`头向${head.yaw >= 0 ? '右' : '左'}${head.yaw_approx ? '≈' : ''}${Math.abs(head.yaw).toFixed(0)}°`);
  }
  if (Number.isFinite(head.pitch) && Math.abs(head.pitch) >= 1) {
    ang.push(`${head.pitch >= 0 ? '低' : '抬'}${head.pitch_approx ? '≈' : ''}${Math.abs(head.pitch).toFixed(0)}°`);
  }
  if (!ang.length && Number.isFinite(head.roll) && Math.abs(head.roll) >= 1) {
    ang.push(`倾${Math.abs(head.roll).toFixed(0)}°`);
  }
  const src = sourceLabel(head);
  const conf = Number.isFinite(head.confidence) ? `，置信 ${head.confidence.toFixed(2)}` : '';
  return `${dir || '—'}${ang.length ? ` · ${ang.join(' / ')}` : ''}（${src}，${head.points}点${conf}）`;
}
