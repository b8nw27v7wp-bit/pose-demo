// handformat.js — 手部结果 → 统一结构（纯函数，无浏览器依赖，可在 Node 里单测）

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

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
    });
  }
  return out;
}
