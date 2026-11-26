// bodyfacing.js — 人体朝向（正面 / 背面 / 侧对）的纯函数实现。
//
// 为什么单独一层：背对相机时，MediaPipe 仍可能给鼻/眼点很高的可见度（实拍背身样例
// 0.99），但头部几何不可信（headpose.js 的尺度/鼻-眼/眼耳一致性门会把它挡住）。
// 能不能判「这个人是背面」，最稳的证据是**躯干**：肩线在水平面的朝向，以及 2D 下
// 肩宽/躯干长的投影比（侧对时肩线被压扁）。
//
// 用途：把哪些本来是「相机方位」的信号换算成**受试者自身方位**——
//   · 油样取样（oil_sample）要求「手在身体前方」，背身时手在身体前方 = 远离相机；
//   · 指向 / 前平举：背身时「前伸」在相机坐标里是 ±180°，原来的判据会漏掉。
//
// 坐标与符号约定（与 signals.js 的方位角同一套）：
//   · yaw = 0  正对相机；
//   · yaw = ±180 背对相机；
//   · yaw > 0  受试者面向**画面右**，yaw < 0 面向画面左；单位度。
//   · 只描述「面向哪边」，不是解剖角；镜像显示不影响，推理输入本身不镜像。
//
// 两条证据：
//   1. 3D（优先）：world 肩线（受试者左肩→右肩）在相机水平面的朝向。
//      世界坐标 x 向右、z 指向屏幕内（见 signals.js 方位角注释），所以
//      yaw = atan2(s_z, s_x)。正对镜头时左肩在画面右 → s_x > 0 → yaw≈0；
//      背对时左肩在画面左 → yaw≈±180。这条不依赖脸，也不依赖画面镜像。
//   2. 2D（退回）：肩的左右顺序 + 肩宽/躯干长。正/背由顺序定（正对时左肩在画面右），
//      侧对由「肩线投影被压扁」定；侧对朝哪边再用鼻尖相对肩中线的偏移定。
//      2D 的左右顺序假设推理输入未被镜像——页面 `.stage.mirror` 只作用于显示，不作用于 kp。
//
// 纯函数，Node 可单测；时间上的朝向去抖在 signals.js（DirectionHold）。

import { IDX, MP_INDEX } from './kpt.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const deg = (rad) => (rad * 180) / Math.PI;

// 下标统一从 kpt.js 取（这里只留短名方便读）：骨架顺序改了不会静默错位。
// K = 内部 13 点（signals.js 已算好），MP = MediaPipe Pose 33 点（kp_world）。
const K = {
  nose: IDX.nose, shL: IDX.shoulder_L, shR: IDX.shoulder_R,
  hipL: IDX.hip_L, hipR: IDX.hip_R,
};
const MP = {
  nose: MP_INDEX.nose, shL: MP_INDEX.shoulder_L, shR: MP_INDEX.shoulder_R,
  hipL: MP_INDEX.hip_L, hipR: MP_INDEX.hip_R,
};

export const BODY_FACING_LABELS = {
  front: '正面',
  back: '背面',
  left: '面向画面左',
  right: '面向画面右',
  side: '侧对',
  unknown: '—',
};

const point2 = (kp, i) => {
  const p = kp && kp[i];
  return Array.isArray(p) && isNum(p[0]) && isNum(p[1]) ? p : null;
};
const vis = (kp, i) => {
  const p = kp && kp[i];
  return Array.isArray(p) && isNum(p[2]) ? p[2] : 0;
};
const finite3 = (p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]) && isNum(p[2]);

/** |yaw| 落在哪一档；side 只在 45°<|yaw|<135° 时给出。 */
function classify(yaw, frontMax, backMin) {
  const a = Math.abs(yaw);
  if (a <= frontMax) return { facing: 'front', side: null };
  if (a >= backMin) return { facing: 'back', side: null };
  return { facing: yaw > 0 ? 'right' : 'left', side: yaw > 0 ? 'right' : 'left' };
}

function emptyOut() {
  return {
    facing: 'unknown',
    yaw: null,
    yaw_source: null,
    confidence: 0,
    side: null,
    shoulder_ratio: null,
    width_ratio: null,
    reasons: [],
  };
}

/**
 * 人体朝向。
 *
 * @param {number[][]|null} kp 13 点 [x,y,vis]，像素（KPT 顺序，signals.js 已算好）
 * @param {number[][]|null} kpWorld 33 点 [x,y,z]，米制（可缺）
 * @param {object} cfg 见 params.js `signals.bodyFacing`
 *   scale：2D 肩宽归一化用的躯干长（像素）。signals.js 已算好，直接传入；
 *          缺省时函数会尝试用髋点算，髋也不可见则 2D 只能给 unknown（不猜侧对）。
 * @returns {{facing:'front'|'back'|'left'|'right'|'side'|'unknown',
 *            yaw:number|null, yaw_source:'3d'|'2d'|null, confidence:number,
 *            side:'left'|'right'|null, shoulder_ratio:number|null, width_ratio:number|null,
 *            reasons:string[]}}
 */
export function bodyFacing(kp, kpWorld, cfg = {}) {
  const out = emptyOut();
  if (cfg.enabled === false) {
    out.reasons.push('disabled');
    return out;
  }
  const visMin = Number.isFinite(cfg.visMin) ? cfg.visMin : 0.3;
  const frontMax = Number.isFinite(cfg.frontMax) ? cfg.frontMax : 45;
  const backMin = Number.isFinite(cfg.backMin) ? cfg.backMin : 135;
  const sideRatio = Number.isFinite(cfg.sideRatio) ? cfg.sideRatio : 0.3;
  const sideNoseRatio = Number.isFinite(cfg.sideNoseRatio) ? cfg.sideNoseRatio : 0.08;

  const shL = point2(kp, K.shL);
  const shR = point2(kp, K.shR);
  if (!shL || !shR) {
    out.reasons.push('no_shoulders');
    return out;
  }
  const visL = vis(kp, K.shL);
  const visR = vis(kp, K.shR);
  const shVis = Math.min(visL, visR);
  if (shVis < visMin) {
    out.reasons.push('low_shoulder_vis');
    return out;
  }

  // —— 2D 肩宽 / 躯干长（两种证据都用来做置信度与侧对判据）——
  let scale = Number.isFinite(cfg.scale) && cfg.scale > 1e-6 ? cfg.scale : null;
  const hipL = point2(kp, K.hipL);
  const hipR = point2(kp, K.hipR);
  if (scale == null && hipL && hipR && Math.min(vis(kp, K.hipL), vis(kp, K.hipR)) >= visMin) {
    const shMidY = (shL[1] + shR[1]) / 2;
    const hipMidY = (hipL[1] + hipR[1]) / 2;
    const shMidX = (shL[0] + shR[0]) / 2;
    const hipMidX = (hipL[0] + hipR[0]) / 2;
    const torso = Math.hypot(shMidX - hipMidX, shMidY - hipMidY);
    if (torso > 1e-6) scale = torso;
  }
  const sep = Math.abs(shL[0] - shR[0]);
  if (scale != null) out.shoulder_ratio = sep / scale;

  // —— 3D：world 肩线在水平面的朝向 ——
  const w = Array.isArray(kpWorld) && kpWorld.length >= 33 ? kpWorld : null;
  const wShL = w ? w[MP.shL] : null;
  const wShR = w ? w[MP.shR] : null;
  const wHipL = w ? w[MP.hipL] : null;
  const wHipR = w ? w[MP.hipR] : null;
  const worldOk = !!(w && finite3(wShL) && finite3(wShR));
  if (worldOk) {
    const sx = wShL[0] - wShR[0];
    const sz = wShL[2] - wShR[2];
    const horizontal = Math.hypot(sx, sz);
    if (horizontal > 1e-6) {
      const yaw = deg(Math.atan2(sz, sx));
      out.yaw = Math.round(yaw * 10) / 10;
      out.yaw_source = '3d';
      const c = classify(yaw, frontMax, backMin);
      out.facing = c.facing;
      out.side = c.side;

      // 肩宽 / 躯干长（world）：模型正常时约 0.32~0.68；越界说明肩线或躯干估计不可信。
      let conf = clamp(shVis, 0, 1) * 0.95;
      if (finite3(wHipL) && finite3(wHipR)) {
        const shMid = [(wShL[0] + wShR[0]) / 2, (wShL[1] + wShR[1]) / 2, (wShL[2] + wShR[2]) / 2];
        const hipMid = [(wHipL[0] + wHipR[0]) / 2, (wHipL[1] + wHipR[1]) / 2, (wHipL[2] + wHipR[2]) / 2];
        const torso = Math.hypot(shMid[0] - hipMid[0], shMid[1] - hipMid[1], shMid[2] - hipMid[2]);
        if (torso > 1e-6) {
          const widthRatio = Math.hypot(sx, wShL[1] - wShR[1], sz) / torso;
          out.width_ratio = Math.round(widthRatio * 1000) / 1000;
          if (widthRatio < 0.25 || widthRatio > 1.25) {
            conf *= 0.6;
            out.reasons.push('shoulder_width_outlier');
          }
        }
        // 次要证据：鼻子相对肩中线的深度。正对时鼻更靠近相机（世界 z 更小），
        // 背对时更远。只用来降置信，不推翻肩线——头可能转过去看别处。
        if (vis(kp, K.nose) >= visMin && finite3(w[MP.nose])) {
          const cue = (w[MP.nose][2] - shMid[2]) / Math.max(torso, 1e-6);
          const expectBack = out.facing === 'back';
          const strong = Math.abs(cue) >= 0.12;
          const disagree = strong && ((expectBack && cue < 0) || (!expectBack && cue > 0));
          if (disagree) {
            conf *= 0.75;
            out.reasons.push('nose_depth_disagree');
          }
        }
      } else {
        conf *= 0.8;
        out.reasons.push('no_world_hips');
      }
      out.confidence = Math.round(clamp(conf, 0, 1) * 1000) / 1000;
      return out;
    }
    out.reasons.push('world_degenerate');
  }

  // —— 2D 退回：肩的左右顺序 + 肩宽投影比 ——
  if (scale == null) {
    // 没有尺度就无法区分「正对但站得远/肩窄」和「侧对」——不猜。
    out.reasons.push('no_scale');
    return out;
  }
  if (sep / scale < sideRatio) {
    // 侧对：鼻尖相对肩中线的横向偏移给出朝哪边。鼻子也不可见时只报「侧对」。
    const nose = point2(kp, K.nose);
    const midX = (shL[0] + shR[0]) / 2;
    if (nose && vis(kp, K.nose) >= visMin) {
      const dx = nose[0] - midX;
      if (Math.abs(dx) >= sideNoseRatio * scale) {
        out.facing = dx > 0 ? 'right' : 'left';
        out.side = out.facing;
        out.yaw = dx > 0 ? 90 : -90;
        out.yaw_source = '2d';
      } else {
        out.facing = 'side';
      }
    } else {
      out.facing = 'side';
    }
    out.confidence = Math.round(clamp(shVis * 0.5, 0, 1) * 1000) / 1000;
  } else {
    // 正/背：正对镜头时受试者左肩在画面右（推理输入不镜像）。
    const front = shL[0] > shR[0];
    out.facing = front ? 'front' : 'back';
    out.yaw = front ? 0 : 180;
    out.yaw_source = '2d';
    out.confidence = Math.round(clamp(shVis * 0.6, 0, 1) * 1000) / 1000;
  }
  return out;
}

/** 给 UI 用的一行摘要（不含原因；原因在 body.reasons）。 */
export function bodyFacingText(body) {
  if (!body) return '—';
  const label = BODY_FACING_LABELS[body.facing] || '—';
  if (Number.isFinite(body.yaw)) {
    const src = body.yaw_source === '3d' ? '' : '≈';
    return `${label} ${src}${Math.round(body.yaw)}°`;
  }
  return label;
}
