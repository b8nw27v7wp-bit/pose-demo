// handformat.js — 手部结果 → 统一结构（纯函数，无浏览器依赖，可在 Node 里单测）

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * 手部朝向：手势只在「掌心朝镜头」时可靠，侧对/背对时四指长度会被压扁。
 * 用拇指 MCP(2) 相对「腕→中指MCP」轴的有符号横向偏移判断：
 *   正 = 手掌朝一个方向，负 = 朝另一个方向。不做「左/右掌」的语义猜测，
 *   只给出一个可比的标量 + 是否侧对（侧对时判定应当降权）。
 */
export function handOrientation(kp) {
  if (!kp || kp.length < 21) return { side: 0, flat: 0, facing: 'unknown' };
  const w = kp[0], m = kp[9], t = kp[2];
  const vx = m[0] - w[0], vy = m[1] - w[1];
  const n = Math.hypot(vx, vy) || 1;
  const rx = t[0] - w[0], ry = t[1] - w[1];
  // 拇指 MCP 在掌轴法向上的投影 / 掌长
  const side = (rx * vy - ry * vx) / n / n;
  // 掌宽：食指 MCP(5) ↔ 小指 MCP(17)，与掌长的比值越大越像是张开手面朝镜头
  const width = dist(kp[5], kp[17]) / n;
  return { side: +side.toFixed(3), flat: +width.toFixed(3), facing: width > 0.55 ? 'front' : 'edge' };
}

/**
 * 手指张开度（度）：各指尖相对掌轴（腕→中指MCP）的扇开角，取「最外侧两指」的夹角。
 * 注意这**不是**「手指是否伸直」：伸直判定在 handshape.js 里。
 * 用最外侧两张开而不是四指平均，是因为弯曲的手指也会偏离掌轴，
 * 平均会把「握拳」算得很开；手掌真正张开时，食指与小指的夹角最大。
 */
export function spreadRatio(kp) {
  if (!kp || kp.length < 21) return NaN;
  const w = kp[0];
  const ang = (tip) => {
    const v = [tip[0] - w[0], tip[1] - w[1]];
    const n = Math.hypot(...v);
    if (n < 1e-6) return NaN;
    return Math.atan2(v[1], v[0]) * 180 / Math.PI;
  };
  const a = ang(kp[8]);     // 食指
  const b = ang(kp[20]);    // 小指
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  let d = Math.abs(a - b);
  if (d > 180) d = 360 - d;
  return +d.toFixed(1);
}

/**
 * MediaPipe 手部结果 → 统一结构
 * @param {{landmarks: Array, handednesses: Array}} result
 * @returns {Array<{handedness:'Left'|'Right'|'unknown', score:number, kp:number[][], bbox:number[], scale:number}>}
 */
export function toHands(result, w, h) {
  if (!result || !result.landmarks) return [];
  const out = [];
  for (let i = 0; i < result.landmarks.length; i++) {
    const raw = result.landmarks[i];
    if (!raw || raw.length < 21) continue;
    const kp = raw.map((p) => [p.x * w, p.y * h, p.z ?? 0]);
    const xs = kp.map((p) => p[0]);
    const ys = kp.map((p) => p[1]);
    const hand = result.handednesses?.[i]?.[0];
    out.push({
      // 拿不到 handedness 时给 unknown，别默认成右手（会误导 UI）
      handedness: hand?.categoryName === 'Left' ? 'Left'
        : hand?.categoryName === 'Right' ? 'Right' : 'unknown',
      score: hand?.score ?? 0,
      kp,
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      scale: dist(kp[0], kp[9]) || 1,   // 腕 → 中指 MCP，手的尺度基准
      orient: handOrientation(kp),
      spread: spreadRatio(kp),
    });
  }
  return out;
}
