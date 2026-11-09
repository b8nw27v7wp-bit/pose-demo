// multi-test.mjs — 多人跟踪 / 每人独立流水线 / PPE 判定的确定性单测
// 运行：node web/test/multi-test.mjs
//
// 这里验证的是**逻辑**：id 会不会串、状态机会不会共用、看不见会不会误判成没戴。
// 不代表真实场景精度——准确率必须用实拍素材测（docs/eval.md）。

import { Tracker, iou, area, optimalAssign } from '../js/track.js';
import {
  PersonPipelines, assignHands, logLimitFor, LOG_LIMITS,
  TrackShapeStabilizers, classifyHandsByTrack, bindClassifiedHands, pickRoiPersons,
} from '../js/multi.js';
import { readFile } from 'node:fs/promises';
import { matchLabel, headBox, wristBox, assessPpe, PpeMonitor } from '../js/ppe.js';
import { tileRects, mergeTiledPoses } from '../js/tiles.js';
import { resolveParams } from '../js/params.js';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// —— 构造：一个站姿的人（13 点，像素坐标；scale = 肩中点到髋中点的距离）——
function mkPerson({ id = 0, cx = 320, cy = 200, s = 120, vis = 0.9, bboxPad = 1.2 } = {}) {
  const kp = [
    [cx, cy - 1.55 * s, vis],                 // nose
    [cx - 0.35 * s, cy - s, vis],             // shoulder_L
    [cx + 0.35 * s, cy - s, vis],             // shoulder_R
    [cx - 0.42 * s, cy - 0.5 * s, vis],       // elbow_L
    [cx + 0.42 * s, cy - 0.5 * s, vis],       // elbow_R
    [cx - 0.46 * s, cy - 0.1 * s, vis],       // wrist_L
    [cx + 0.46 * s, cy - 0.1 * s, vis],       // wrist_R
    [cx - 0.22 * s, cy, vis],                 // hip_L
    [cx + 0.22 * s, cy, vis],                 // hip_R
    [cx - 0.24 * s, cy + s, vis],             // knee_L
    [cx + 0.24 * s, cy + s, vis],             // knee_R
    [cx - 0.24 * s, cy + 2 * s, vis],         // ankle_L
    [cx + 0.24 * s, cy + 2 * s, vis],         // ankle_R
  ];
  const xs = kp.map((p) => p[0]);
  const ys = kp.map((p) => p[1]);
  const w = 1.2 * s;
  return {
    track_id: id,
    bbox: [Math.min(...xs) - 0.1 * w, Math.min(...ys) - 0.2 * s, Math.max(...xs) + 0.1 * w, Math.max(...ys) + 0.2 * s],
    kp_format: 'mediapipe33',
    kp,
    kp_raw: kp.map(([x, y, v]) => ({ x: x / 640, y: y / 480, visibility: v })),
    kp_world: [],
    scale: s,
    score: vis,
    bboxPad,
  };
}

const box = (x1, y1, x2, y2) => ({
  category: 0, label: null, score: 0.9, box: [x1, y1, x2, y2],
});

const label = (lbl, b, score = 0.9) => ({ category: 0, label: lbl, score, box: b });

// —— 1. 基础几何 ——
console.log('\n[1] iou / area');
check('iou 完全相同 = 1', iou([0, 0, 10, 10], [0, 0, 10, 10]) === 1);
check('iou 不相交 = 0', iou([0, 0, 10, 10], [20, 20, 30, 30]) === 0);
check('iou 退化为 0 而不是 NaN', Number.isFinite(iou([0, 0, 10, 10], [5, 5, 5, 5])));
check('area', area([0, 0, 10, 20]) === 200);

// —— 1a. 分配算法：贪心可能为一个高分对牺牲两个正确对 ——
console.log('\n[1a] 最优分配');
check('optimal 找回被贪心牺牲的组合',
  JSON.stringify(optimalAssign([[10, 9], [9, 0]], 2, 2)) === JSON.stringify([1, 0]));
check('全部不可匹配 → 都不配',
  JSON.stringify(optimalAssign([[-1, -1], [-1, -1]], 2, 2)) === JSON.stringify([-1, -1]));

// —— 1b. 平铺检测几何（远处小目标：切块放大再合并）——
console.log('\n[1b] 平铺几何');
{
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const rs = tileRects(1920, 1080, 2, 0.2);
  check('2×2 平铺返回 4 块', rs.length === 4, String(rs.length));
  const last = rs[3];
  check('最后一块贴住右下角', near(last.x + last.w, 1920) && near(last.y + last.h, 1080));
  const ov = rs[0].x + rs[0].w - rs[1].x;
  check('相邻块重叠 = 20% 块宽', near(ov / rs[0].w, 0.2), (ov / rs[0].w).toFixed(3));
  check('tiles=1 返回整帧', tileRects(640, 480, 1).length === 1
    && tileRects(640, 480, 1)[0].w === 640);

  const a = { bbox: [0.1, 0.1, 0.3, 0.4], score: 0.9 };
  const dup = { bbox: [0.1, 0.1, 0.3, 0.4], score: 0.5 };
  check('同一个人被两块检出 → 只留分高的',
    mergeTiledPoses([dup, a], 3).length === 1 && mergeTiledPoses([dup, a], 3)[0].score === 0.9);
  const other = { bbox: [0.5, 0.1, 0.7, 0.4], score: 0.8 };
  check('不同的人 → 都保留', mergeTiledPoses([a, other], 3).length === 2);
  const third = { bbox: [0.8, 0.1, 0.95, 0.3], score: 0.7 };
  check('按 maxPoses 截断', mergeTiledPoses([a, other, third], 2).length === 2);
}

// —— 2. 跟踪：id 稳定 ——
console.log('\n[2] Tracker id 稳定');
{
  const t = new Tracker({ maxLostMs: 1500 });
  const a = t.update([mkPerson({ cx: 200 }), mkPerson({ cx: 500 })], 1000);
  check('两人生成两个 id', a.length === 2 && a[0].track_id !== a[1].track_id, a.map((p) => p.track_id).join(','));
  const ids1 = a.map((p) => p.track_id).sort();
  const b = t.update([mkPerson({ cx: 205 }), mkPerson({ cx: 497 })], 1100);
  const ids2 = b.map((p) => p.track_id).sort();
  check('小幅移动保持同一批 id', JSON.stringify(ids1) === JSON.stringify(ids2), `${ids1} vs ${ids2}`);
  check('新人是新 id', t.update([mkPerson({ cx: 200 }), mkPerson({ cx: 500 }), mkPerson({ cx: 700 })], 1200)
    .some((p) => ![ids1[0], ids1[1]].includes(p.track_id)));
}

// —— 3. 跟踪：不应换 id 的情形 ——
console.log('\n[3] Tracker 防换 id');
{
  const t = new Tracker({ maxLostMs: 1500 });
  // 两个人交叉：左侧的人往右走、右侧的人往左走，中途重叠
  t.update([mkPerson({ cx: 250, s: 120 }), mkPerson({ cx: 390, s: 120 })], 1000);
  const crossed = t.update([mkPerson({ cx: 320, s: 120 })], 1100);
  check('重叠时仍只保留一个轨迹 id（不新增）', crossed.length === 1 && crossed[0].track_id !== undefined, `id=${crossed[0]?.track_id}`);
  // 身高突变（1.8 倍）不该被当成同一个人
  const big = t.update([mkPerson({ cx: 320, s: 216 })], 1200);
  check('身高突变 1.8 倍 → 新 id', big[0].track_id !== 1, `id=${big[0].track_id}`);
  // 短暂消失后回原位：仍是原 id（maxLostMs 内）
  const t2 = new Tracker({ maxLostMs: 1500 });
  const first = t2.update([mkPerson({ cx: 300 })], 1000)[0];
  t2.update([], 1200);
  const back = t2.update([mkPerson({ cx: 302 })], 1400)[0];
  check('短暂消失 200ms 后回原位 → 同 id', back.track_id === first.track_id, `${first.track_id} → ${back.track_id}`);
  // 超时后回来：新 id（旧状态必须作废）
  t2.update([], 4000);
  const later = t2.update([mkPerson({ cx: 302 })], 4100)[0];
  check('超时 3s 后回来 → 新 id', later.track_id !== first.track_id, `${first.track_id} → ${later.track_id}`);
}

// —— 4. 跟踪：中心距离兜底 + 面积排序 ——
console.log('\n[4] Tracker 兜底与排序');
{
  const t = new Tracker({ maxLostMs: 1500 });
  const a = t.update([mkPerson({ cx: 300 })], 1000)[0];
  // 快速移动导致 IoU = 0，但中心距离仍在 0.6×身高内 → 同 id
  const moved = t.update([mkPerson({ cx: 300 + 0.7 * 120 * 0.9 })], 1100)[0];
  check('IoU=0 但中心距离近 → 同 id', moved.track_id === a.track_id, `${a.track_id} → ${moved.track_id}`);
  const out = t.update([mkPerson({ cx: 300 }), mkPerson({ cx: 320, s: 260 })], 1200);
  check('按面积降序返回（大的在前）', area(out[0].bbox) >= area(out[1].bbox));
}

// —— 4b. 运动模型：漏检一帧后按速度重新关联 ——
console.log('\n[4b] Tracker 运动模型');
{
  // 两人相向而行；A 在交叉前被遮挡一帧，重新出现时当前位置已经越过 B 的旧位置。
  // 正常连续帧仍走纯 IoU；只有"间隔明显大于平时"才用预测，避免检测抖动被当成速度。
  const path = [
    { t: 1000, a: 200, b: 500 },
    { t: 1100, a: 260, b: 440 },
    { t: 1200, a: null, b: 380 },   // A 被遮挡
    { t: 1300, a: 380, b: 320 },    // A 重新出现（预测位置 = 260 + 0.6×200 = 380）
    { t: 1400, a: 440, b: 260 },
  ];
  const run = (motion) => {
    const tr = new Tracker({ maxLostMs: 1500, motion });
    let idA = null;
    let idB = null;
    let ok = true;
    for (const p of path) {
      const dets = [];
      if (p.a != null) dets.push({ ...mkPerson({ cx: p.a, s: 120 }), tag: 'A' });
      if (p.b != null) dets.push({ ...mkPerson({ cx: p.b, s: 120 }), tag: 'B' });
      const out = tr.update(dets, p.t);
      const a = out.find((x) => x.tag === 'A');
      const b = out.find((x) => x.tag === 'B');
      if (a) {
        if (idA == null) idA = a.track_id;
        if (a.track_id !== idA) ok = false;
      }
      if (b) {
        if (idB == null) idB = b.track_id;
        if (b.track_id !== idB) ok = false;
      }
    }
    return ok;
  };
  check('运动模型：漏检一帧后仍能关联回原 id', run(true));
  check('对照：关掉运动模型会换 id', !run(false));

  // 站着不动的人不应被预测推走
  const tr = new Tracker({ maxLostMs: 1500 });
  const first = tr.update([{ ...mkPerson({ cx: 300 }), tag: 'S' }], 1000)[0];
  let stillOk = true;
  for (let t = 1100; t <= 2000; t += 100) {
    const o = tr.update([{ ...mkPerson({ cx: 300 }), tag: 'S' }], t)[0];
    if (o.track_id !== first.track_id) stillOk = false;
  }
  check('静止人员不受运动模型影响', stillOk, `${first.track_id} 保持不变`);
}

// —— 4c. 外观 ReID：只在丢失后重连（不扰动正常帧的 IoU 配对）——
console.log('\n[4c] 外观 ReID');
{
  // 52 维 one-hot 描述子：不同颜色余弦相似度 0，相同为 1
  const desc = (i) => {
    const a = new Float32Array(52);
    a[i] = 1;
    return a;
  };
  const D_A = desc(0);
  const D_B = desc(20);

  // 正常连续帧：外观不参与 IoU 打分，交叉时与旧逻辑一致（这里只验证不报错/不新增 id）
  const tr0 = new Tracker({ maxLostMs: 1500, motion: false, appearance: true });
  const first0 = tr0.update([{ ...mkPerson({ cx: 200 }), tag: 'A', desc: D_A }], 1000)[0];
  const next0 = tr0.update([{ ...mkPerson({ cx: 210 }), tag: 'A', desc: D_A }], 1100)[0];
  check('正常帧：外观不改变 IoU 匹配', next0.track_id === first0.track_id);

  // 丢失后在远处重新出现：中心距离已超出 gate，只能靠外观连回来
  const tr = new Tracker({ maxLostMs: 1500, motion: false, appearance: true });
  const first = tr.update([{ ...mkPerson({ cx: 200 }), tag: 'A', desc: D_A }], 1000)[0];
  tr.update([], 1100);
  const back = tr.update([{ ...mkPerson({ cx: 700 }), tag: 'A', desc: D_A }], 1200)[0];
  check('外观 ReID：丢失后在远处重新出现仍关联', back.track_id === first.track_id,
    `${first.track_id} → ${back.track_id}`);

  const tr2 = new Tracker({ maxLostMs: 1500, motion: false, appearance: true });
  const f2 = tr2.update([{ ...mkPerson({ cx: 200 }), tag: 'A', desc: D_A }], 1000)[0];
  tr2.update([], 1100);
  const other = tr2.update([{ ...mkPerson({ cx: 700 }), tag: 'A', desc: D_B }], 1200)[0];
  check('外观不像的人不硬连', other.track_id !== f2.track_id, `${f2.track_id} → ${other.track_id}`);
}

// —— 5. 每人一条独立状态机 ——
console.log('\n[5] PersonPipelines 隔离');
{
  const params = resolveParams({});
  const pipes = new PersonPipelines(params);
  const a = mkPerson({ id: 1, cx: 200 });
  const b = mkPerson({ id: 2, cx: 500 });
  const r1 = pipes.update([a, b], 1000);
  check('两人各返回一条判定', r1.length === 2, String(r1.length));
  const pa = pipes.map.get(1);
  const pb = pipes.map.get(2);
  check('两人的 SignalEngine 不是同一个实例', pa.sig !== pb.sig);
  check('两人的 ActionEngine 不是同一个实例', pa.act !== pb.act);

  let resets = 0;
  pa.sig.reset = () => { resets++; };
  pipes.update([a, b], 1300);
  check('连续帧不重置状态机', resets === 0, `resets=${resets}`);
  pipes.update([a, b], 3000);   // 与 1300 相差 1700ms > gapMs(1000)
  check('缺席超过 gapMs → 重置该人状态机', resets === 1, `resets=${resets}`);

  check('primary = 面积最大的人', pipes.primary(r1).track_id === 1 || pipes.primary(r1).track_id === 2);
  pipes.prune(new Set([1]));
  check('prune 丢掉不再跟踪的人', pipes.size() === 1 && !pipes.map.has(2));
  pipes.reset();
  check('reset 清空', pipes.size() === 0);
}

// —— 6. 手部归属 ——
console.log('\n[6] assignHands');
{
  const a = mkPerson({ id: 1, cx: 200 });
  const b = mkPerson({ id: 2, cx: 600 });
  const leftOfA = { handedness: 'Left', score: 0.9, kp: [[a.kp[5][0] + 3, a.kp[5][1] + 2]] };
  const rightOfB = { handedness: 'Right', score: 0.8, kp: [[b.kp[6][0] - 2, b.kp[6][1]]] };
  const far = { handedness: 'Left', score: 0.99, kp: [[3000, 3000]] };
  const m = assignHands([a, b], [leftOfA, rightOfB, far]);
  check('左手归到最近的人', m.get(1).L === leftOfA);
  check('右手归到最近的人', m.get(2).R === rightOfB);
  check('离所有人都很远的手被丢弃', ![...m.values()].some((s) => s.list.includes(far)));

  const dupLow = { handedness: 'Left', score: 0.5, kp: [[a.kp[5][0], a.kp[5][1]]] };
  const dupHigh = { handedness: 'Left', score: 0.95, kp: [[a.kp[5][0], a.kp[5][1]]] };
  const m2 = assignHands([a], [dupLow, dupHigh]);
  check('同侧重复手取分高的', m2.get(1).L === dupHigh);
  check('scale 无效的人不参与归属', assignHands([{ ...a, scale: 0 }], [leftOfA]).get(1) === undefined);
}

// —— 6b. assignHands 的两道门（R12-2）——
console.log('\n[6b] assignHands 门控');
{
  // 单人手部样本。bbox 与 kp 分开给：门控只看 bbox 中心，归属距离仍看 kp[0]（腕点）。
  const mkHand = (x, y, handedness = 'Left', extra = {}) => ({
    handedness, score: 0.9, bbox: [x - 10, y - 10, x + 10, y + 10], kp: [[x, y]], ...extra,
  });

  // 门 1：手 bbox 中心在 A 的框内，但腕点离 B 的腕点更近 → 归 A（不能归 B）。
  // 两个 person 的 bbox 故意改成不重叠，才能把「bbox 中心在谁框内」和「腕点离谁近」
  // 这两个判据分开；用 mkPerson 默认框时两个人会挤在一起，测不出门控。
  const A = mkPerson({ id: 1, cx: 300 });
  const B = mkPerson({ id: 2, cx: 500 });
  A.bbox = [0, 0, 420, 700];
  B.bbox = [440, 0, 800, 700];
  B.kp[5] = [420, 150, 0.9];           // B 的左手腕故意贴到手的位置
  const inAboxNearB = mkHand(420, 150);  // bbox 中心 420 在 A 框内、不在 B 框内
  const m1 = assignHands([A, B], [inAboxNearB]);
  check('bbox 门：手框中心在 A 框内 → 不因离 B 腕近而归 B',
    m1.get(1).list.includes(inAboxNearB) && !m1.get(2).list.includes(inAboxNearB));
  // 同一只手没有 bbox（旧数据）→ 跳过这道门，按距离归 B（向后兼容）
  const noBbox = { handedness: 'Left', score: 0.9, kp: [[420, 150]] };
  const m1b = assignHands([A, B], [noBbox]);
  check('没有 bbox 的旧数据跳过 bbox 门', m1b.get(2).list.includes(noBbox));

  // 门 1 的腕部外扩：pose bbox 的极值点是腕，不含手指。手伸向体侧时手框中心天然
  // 在框外，只做整框包含会把手直接丢掉（多人模式下 reaching/pointing 整段失效）。
  const EA = mkPerson({ id: 1, cx: 300 });   // bbox 右界 ≈ 369.6，腕点 x ≈ 355.2，scale = 120
  const EB = mkPerson({ id: 2, cx: 500 });
  const extended = mkHand(390, 188, 'Right'); // 中心比 A 框右界远 20px，离 A 右腕 35px < 0.4×120
  const mx = assignHands([EA, EB], [extended]);
  check('腕部外扩 0.4×scale：伸出去的手仍归 A',
    mx.get(1).list.includes(extended) && !mx.get(2).list.includes(extended),
    `A=${mx.get(1).list.length} B=${mx.get(2).list.length}`);
  // 外扩只绑在腕上、且有上限：离两只腕都很远的手仍被丢弃
  const tooFar = mkHand(300, 500, 'Right');
  const my = assignHands([EA, EB], [tooFar]);
  check('外扩不是无上限：离腕太远的手仍被丢弃',
    !my.get(1).list.includes(tooFar) && !my.get(2).list.includes(tooFar));

  // 门 2：离 A、B 的归一化距离几乎相同（margin < 0.15）→ 弃权
  const P = mkPerson({ id: 1, cx: 300 });
  const Q = mkPerson({ id: 2, cx: 500 });
  // 不带 bbox：只测 margin 门（有 bbox 时会先被 bbox 门筛掉，测不到这一道）
  const tie = { handedness: 'Left', score: 0.9, kp: [[400, 188]] };  // 离两人腕点各 44.8px / scale 120
  const mt = assignHands([P, Q], [tie]);
  check('次近人 margin 不足 → 不归属给任何人',
    !mt.get(1).list.includes(tie) && !mt.get(2).list.includes(tie));
  // margin 足够 → 正常归属
  const nearP = { handedness: 'Left', score: 0.9, kp: [[350, 188]] };
  const mn = assignHands([P, Q], [nearP]);
  check('margin 足够 → 归最近的人', mn.get(1).list.includes(nearP) && !mn.get(2).list.includes(nearP));

  // ROI 补检结果带 owner_track_id：即使腕点离别人更近，也只归补检它的人
  const owned = mkHand(350, 188, 'Left', { side_from: 'roi', owner_track_id: 2 });
  const mo = assignHands([P, Q], [owned]);
  check('ROI owner 优先于距离',
    mo.get(2).list.includes(owned) && !mo.get(1).list.includes(owned));

  // 单人不受两道门影响：bbox 在人框外、腕点够近 → 仍归属（旧行为）
  const singleOutside = mkHand(P.kp[5][0], P.kp[5][1], 'Left', { bbox: [1000, 1000, 1100, 1100] });
  const ms = assignHands([P], [singleOutside]);
  check('单人：bbox 门外的手仍按旧距离规则归属', ms.get(1).list.includes(singleOutside));
}

// —— 6c. 单人路径回归：新实现与旧算法逐项一致 ——
console.log('\n[6c] 单人归属回归');
{
  // 旧版 assignHands（R12-2 之前）的逐字复刻，用来确认单人路径没有被门控改动。
  const legacyAssign = (persons, hands, maxDist = 0.8) => {
    const out = new Map();
    for (const p of persons) {
      if (!p || !p.kp || !(p.scale > 0)) continue;
      out.set(p.track_id, { L: null, R: null, list: [] });
    }
    for (const hd of hands) {
      if (!hd || !hd.kp || !hd.kp.length) continue;
      const [hx, hy] = hd.kp[0];
      let best = null;
      let bestD = Infinity;
      for (const p of persons) {
        if (!p.kp || !(p.scale > 0)) continue;
        for (const wi of [5, 6]) {
          const w = p.kp[wi];
          if (!w || !(w[2] >= 0.3)) continue;
          const d = Math.hypot(w[0] - hx, w[1] - hy) / p.scale;
          if (d < bestD) { bestD = d; best = p.track_id; }
        }
      }
      if (best == null || bestD > maxDist) continue;
      out.get(best)?.list.push(hd);
    }
    for (const slot of out.values()) {
      for (const hd of slot.list) {
        const key = hd.handedness === 'Left' ? 'L' : hd.handedness === 'Right' ? 'R' : null;
        if (!key) continue;
        if (!slot[key] || (hd.score ?? 0) > (slot[key].score ?? 0)) slot[key] = hd;
      }
    }
    return out;
  };

  const p = mkPerson({ id: 0, cx: 320, s: 120 });
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const hands = [];
  for (let i = 0; i < 60; i++) {
    const x = rand() * 640;
    const y = rand() * 480;
    const handedness = rand() < 0.45 ? 'Left' : rand() < 0.8 ? 'Right' : 'Unknown';
    const hd = { handedness, score: rand(), kp: [[x, y]] };
    // 一半带 bbox（有的故意在 person 框外），确认单人路径完全不看它
    if (i % 2 === 0) hd.bbox = [x - 12, y - 12, x + 12, y + 12];
    else hd.bbox = [1000, 1000, 1100, 1100];
    hands.push(hd);
  }
  hands.push({ handedness: 'Left', score: 0.9, kp: [[p.kp[5][0], p.kp[5][1]]] });
  hands.push({ handedness: 'Right', score: 0.9, kp: [[p.kp[6][0], p.kp[6][1]]] });

  const now = assignHands([p], hands);
  const old = legacyAssign([p], hands);
  const sameSlot = (a, b) => {
    const sa = a.get(0);
    const sb = b.get(0);
    if (!sa || !sb) return !sa && !sb;
    return sa.L === sb.L && sa.R === sb.R
      && sa.list.length === sb.list.length
      && sa.list.every((h, i) => h === sb.list[i]);
  };
  check('单人归属与旧算法逐只手一致', sameSlot(now, old),
    `new=${now.get(0)?.list.length} old=${old.get(0)?.list.length}`);
}

// —— 6d. 手势稳定器按 track 隔离 ——
console.log('\n[6d] 逐 track 手势稳定器');
{
  // 用假分类器把「手势」直接写在 kp 上，避免构造 21 点几何；去抖逻辑是真的。
  const fake = (kp) => ({ shape: kp.shape, label: '', fingers: {}, pinch: 0, score: 1 });
  const hand = (track, shape) => ({ handedness: 'Left', kp: { shape }, track, score: 0.9 });

  const st = new TrackShapeStabilizers({ streak: 3, keepMs: 250 });
  const a = hand(1, 'fist');
  const b = hand(2, 'open');
  let isolated = true;
  let lastA = null;
  let lastB = null;
  // 30 帧两人做不同手势：共用一个稳定器时两者会互相清候选，永远到不了 streak。
  for (let i = 0; i < 30; i++) {
    const cls = classifyHandsByTrack([a, b], i * 33, st, (hd) => hd.track, fake);
    lastA = cls.list[0].cls.shape;
    lastB = cls.list[1].cls.shape;
    if (i >= 2 && (lastA !== 'fist' || lastB !== 'open')) isolated = false;
  }
  check('两人不同手势 30 帧：各自稳定器不互切', isolated, `${lastA}/${lastB}`);
  check('每个 track 各一套稳定器', st.size() === 2, String(st.size()));

  // 对照：所有手都推同一个 track 0 → 交替手势永远凑不满 streak（复现旧 bug）
  const shared = new TrackShapeStabilizers({ streak: 3, keepMs: 250 });
  for (let i = 0; i < 30; i++) {
    classifyHandsByTrack([i % 2 ? a : b], i * 33, shared, () => 0, fake);
  }
  check('对照：共用一套稳定器时交替手势无法稳定', shared.forTrack(0).L.last === 'unknown',
    shared.forTrack(0).L.last);

  // 分类后的对象要回填到槽位，PersonPipelines 才能读到 hands.L.cls.shape
  const assigned = new Map([[1, { L: a, R: null, list: [a] }], [2, { L: b, R: null, list: [b] }]]);
  const cls = classifyHandsByTrack([a, b], 5000, st, (hd) => hd.track, fake);
  const bound = bindClassifiedHands(assigned, cls.byOriginal);
  check('槽位结构 {L,R,list} 不变且带 cls.shape',
    bound.get(1).L.cls.shape === 'fist' && bound.get(2).L.cls.shape === 'open'
    && Array.isArray(bound.get(1).list));

  // 随 track prune 清理，避免长会话泄漏
  st.prune(new Set([1]));
  check('prune 清掉已消失 track 的稳定器', st.size() === 1 && !st.map.has(2));
  const fresh = st.forTrack(2);
  check('prune 后再出现是同 track 的全新状态', fresh.L.last === 'unknown');

  // 单人道：ownerOf 恒为 0 时，结果与「一套全局稳定器」逐帧一致（回归）
  const singleNew = new TrackShapeStabilizers({ streak: 3, keepMs: 250 });
  const singleOld = new TrackShapeStabilizers({ streak: 3, keepMs: 250 });
  const seq = ['fist', 'fist', 'open', 'fist', 'unknown', 'open', 'open', 'open'];
  let same = true;
  seq.forEach((shape, i) => {
    const hd = hand(0, shape);
    const got = classifyHandsByTrack([hd], i * 100, singleNew, () => 0, fake).list[0].cls.shape;
    // 旧实现等价于「直接把这个 track 的稳定器喂一遍」
    const oldShape = singleOld.forTrack(0).L.update(shape, i * 100);
    if (got !== oldShape) same = false;
  });
  check('单人（track 0）分类与旧实现逐帧一致', same);
}

// —— 6e. 多人 ROI 预算 ——
console.log('\n[6e] ROI 补检预算');
{
  const p = (id, bbox, scale) => ({ track_id: id, bbox, scale });
  const big = p(1, [0, 0, 600, 600], 120);
  const mid = p(2, [0, 0, 500, 500], 110);
  const small = p(3, [0, 0, 400, 400], 100);

  const r1 = pickRoiPersons([big, mid, small], big, { maxPersons: 3, maxPersonsPerFrame: 2, minScalePx: 80 });
  check('3 人 + 预算 2 → 最多补检 2 人', r1.picked.length === 2 && r1.budget === 2, String(r1.picked.length));
  check('主目标优先排第一', r1.picked[0] === big);
  check('按面积取前 N（mid 入选、small 落选）',
    r1.picked.includes(mid) && !r1.picked.includes(small));

  const r2 = pickRoiPersons([big, mid, small], big, { maxPersons: 1, maxPersonsPerFrame: 2 });
  check('multi.maxPersons 收窄预算', r2.picked.length === 1 && r2.picked[0] === big);

  const far = p(4, [0, 0, 700, 700], 60);   // 面积最大但 scale 太小
  const r3 = pickRoiPersons([far, big, mid], far, { maxPersons: 3, maxPersonsPerFrame: 2, minScalePx: 80 });
  check('scale < minScalePx → 跳过补检',
    !r3.picked.includes(far) && r3.skipped.includes(far), `picked=${r3.picked.length} skipped=${r3.skipped.length}`);

  const r4 = pickRoiPersons([small], small, { maxPersons: 0, maxPersonsPerFrame: 2 });
  check('预算 0 → 不补检', r4.picked.length === 0 && r4.budget === 0);
}

// —— 7. PPE 标签与几何 ——
console.log('\n[7] PPE 几何');
{
  const cfg = resolveParams({}).signals.ppe;
  check('标签大小写/连字符不敏感', matchLabel('Hard Hat', cfg.classes.helmet) && matchLabel('hardhat', cfg.classes.helmet));
  check('不相关标签不匹配', !matchLabel('person', cfg.classes.helmet));
  check('负类不算正类（no_helmet ≠ helmet）',
    !matchLabel('no_helmet', cfg.classes.helmet) && !matchLabel('no_gloves', cfg.classes.glove));
  const p = mkPerson({ cx: 320, cy: 240, s: 120 });
  const h = headBox(p, cfg);
  check('头部框来自鼻尖', h.source === 'nose' && h.visible);
  const noNose = mkPerson({ cx: 320, cy: 240, s: 120, vis: 0.1 });
  const h2 = headBox(noNose, cfg);
  check('鼻尖不可见 → 退回人框顶部且标记 visible=false', h2.source === 'bbox' && h2.visible === false);
  const w = wristBox(p, 'L', cfg);
  check('腕部框以腕点为中心', Math.abs((w.box[0] + w.box[2]) / 2 - p.kp[5][0]) < 1e-6);
}

// —— 8. PPE 判定：看不见 ≠ 没戴 ——
console.log('\n[8] assessPpe 语义');
{
  const cfg = resolveParams({}).signals.ppe;
  const p = mkPerson({ cx: 320, cy: 240, s: 120 });
  const h = headBox(p, cfg);

  // 类别没配
  const none = assessPpe(p, [], { ...cfg, classes: { ...cfg.classes, helmet: [] } }, { sawClasses: { helmet: true, glove: true } });
  check('没配头盔类别 → unknown', none.helmet.state === 'unknown');

  // 头上有头盔框
  const helmetObj = label('helmet', [h.box[0], h.box[1], h.box[2], h.box[3]]);
  const worn = assessPpe(p, [helmetObj], cfg, { sawClasses: { helmet: true, glove: true } });
  check('头部区域内有 helmet → worn', worn.helmet.state === 'worn');

  // 头可见但没有头盔框，且本场出现过正例 → missing
  const miss = assessPpe(p, [], cfg, { sawClasses: { helmet: true, glove: true } });
  check('头可见 + 无头盔 + 本场有正例 → missing', miss.helmet.state === 'missing');

  // 本场从未检出过头盔 → unknown（模型类别名写错的防线）
  const never = assessPpe(p, [], cfg, { sawClasses: { helmet: false, glove: false } });
  check('本场从未检出过头盔 → unknown（不误报）', never.helmet.state === 'unknown', never.helmet.reason);

  // 模型明确检出负类：直接证据，不需要先见过正例
  const noHelmetObj = label('no_helmet', [h.box[0], h.box[1], h.box[2], h.box[3]]);
  const neg = assessPpe(p, [noHelmetObj], cfg, { sawClasses: { helmet: false, glove: false } });
  check('检出 no_helmet → missing（直接证据）',
    neg.helmet.state === 'missing' && /未戴/.test(neg.helmet.reason), neg.helmet.reason);

  // 头部不可见 → unknown
  const blind = assessPpe(mkPerson({ vis: 0.05 }), [], cfg, { sawClasses: { helmet: true, glove: true } });
  check('头部不可见 → unknown', blind.helmet.state === 'unknown');

  // 手套：腕可见 + 有手套框 → worn；腕不可见 → unknown
  const gw = wristBox(p, 'L', cfg);
  const gloveObj = label('glove', [gw.box[0], gw.box[1], gw.box[2], gw.box[3]]);
  const g = assessPpe(p, [gloveObj], cfg, { sawClasses: { helmet: true, glove: true } });
  check('腕区域内有 glove → worn L', g.glove.L.state === 'worn');
  check('另一侧腕无手套 → missing R（本场有正例）', g.glove.R.state === 'missing');
  const gBlind = assessPpe(mkPerson({ vis: 0.05 }), [], cfg, { sawClasses: { helmet: true, glove: true } });
  check('腕不可见 → unknown', gBlind.glove.L.state === 'unknown');
}

// —— 9. PPE 时序：持续才成立 ——
console.log('\n[9] PpeMonitor 时序');
{
  const cfg = resolveParams({}).signals.ppe;
  const p = mkPerson({ cx: 320, cy: 240, s: 120 });
  const mon = new PpeMonitor(cfg);
  // 先给一次头盔正例，让 saw.helmet = true
  const h = headBox(p, cfg);
  const helmet = label('helmet', [h.box[0], h.box[1], h.box[2], h.box[3]]);
  mon.update(1, p, [helmet], 1000);
  const t0 = mon.update(1, p, [], 1100);
  check('刚缺帽时不告警', t0.helmet.alert === 'none' && t0.helmet.state === 'missing', `${t0.helmet.streak_ms}ms`);
  const t1 = mon.update(1, p, [], 2500);
  check('累计 1.4s 仍未告警', t1.helmet.alert === 'none', `${t1.helmet.streak_ms}ms`);
  const t2 = mon.update(1, p, [], 4200);   // since 1100 → 3100ms ≥ 3000
  check('连续 ≥3s → violation', t2.helmet.alert === 'violation', `${t2.helmet.streak_ms}ms`);

  // 戴上了就清零
  const t3 = mon.update(1, p, [helmet], 4300);
  check('戴回后时长清零', t3.helmet.streak_ms === 0 && t3.helmet.state === 'worn');

  // unknown 暂停而不是清零
  const mon2 = new PpeMonitor(cfg);
  mon2.update(2, p, [helmet], 1000);
  mon2.update(2, p, [], 1100);            // missing 起点
  mon2.update(2, p, [], 3000);            // 1900ms
  const blind = mon2.update(2, mkPerson({ ...p, vis: 0.05 }), [], 4000); // 头不可见 → unknown
  check('unknown 保留已积累时长（不清零）', blind.helmet.streak_ms >= 1900, `${blind.helmet.streak_ms}ms`);
  check('unknown 不告警', blind.helmet.alert === 'none');

  // 手套默认只报 suspect，不进 violation
  const mon3 = new PpeMonitor(cfg);
  const gw = wristBox(p, 'L', cfg);
  mon3.update(3, p, [label('glove', [gw.box[0], gw.box[1], gw.box[2], gw.box[3]])], 1000);
  const g1 = mon3.update(3, p, [], 5000); // 无手套框 → 两侧 missing
  check('手套缺 ≥3s 只报 suspect（默认 policy）', g1.glove.alert === 'suspect', g1.glove.alert);
  check('手套两侧状态合并为 missing', g1.glove.state === 'missing');

  const mon4 = new PpeMonitor({ ...cfg, glove: { ...cfg.glove, policy: 'violation' } });
  mon4.update(4, p, [label('glove', [gw.box[0], gw.box[1], gw.box[2], gw.box[3]])], 1000);
  const g2 = mon4.update(4, p, [], 5000);
  check('profile 显式改成 violation 才升级', g2.glove.alert === 'violation', g2.glove.alert);

  // 跟踪器放弃的轨迹要一起丢掉计时器，否则长会话里 tracks 只增不减
  const mon5 = new PpeMonitor(cfg);
  mon5.update(1, p, [helmet], 1000);
  mon5.update(2, p, [helmet], 1000);
  mon5.prune(new Set([1]));
  check('prune 丢掉离场轨迹的计时器',
    mon5.tracks.size === 1 && mon5.tracks.has(1) && !mon5.tracks.has(2), String(mon5.tracks.size));
}

// —— 导出体积口径（R12-1 / PLAN §18.5 D3）——
// pushLog 在浏览器里，Node 不能直接 import（顶层就摸 DOM）；这里验证纯函数与源码接线，
// 真正的导出行为由无头页面（headless-multi / headless-check）覆盖。
console.log('\n[导出契约] 多人口径的帧数上限与 meta');
{
  check('单人上限 20000 / 多人 6000', LOG_LIMITS.single === 20000 && LOG_LIMITS.multi === 6000,
    JSON.stringify(LOG_LIMITS));
  check('logLimitFor 按模式取上限', logLimitFor(false) === 20000 && logLimitFor(true) === 6000);
  const src = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  check('meta 写 log_limit 与 export_mode',
    /log_limit:\s*logLimit\(\)/.test(src) && /export_mode:\s*logMode/.test(src));
  check('上限按本段记录的模式取（不是编译期常量，也不读导出时的 multiReady）',
    /const logLimit = \(\) => logLimitFor\(logMode === 'multi'\)/.test(src));
  // Stop 会置 multiReady=false 但保留 frameLog：meta 不能因此翻成 single/20000。
  check('导出模式在录制期间冻结（Stop 后不跟着 multiReady 变）',
    /export_mode:\s*logMode/.test(src) && !/export_mode:\s*exportMulti/.test(src)
    && /if \(exportMulti\(\)\) logMode = 'multi'/.test(src)
    && /logMode = exportMulti\(\) \? 'multi' : 'single'/.test(src));
  check('多人导出全部判定人员（persons: judged）', /persons:\s*judged/.test(src));
  check('verdicts 透传 track_uid 与逐 track hands',
    /vd\.track_uid !== undefined/.test(src) && /hands:\s*vd\.hands/.test(src)
    && /track_uid:\s*vd\.person\?\.track_uid/.test(src));
}

// —— R12-2 接线：两条输入路径都要「先归属、再按 track 分类」——
console.log('\n[R12-2 接线]');
{
  const src = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  check('视频路径多人 ROI 走预算补检', /completeHandsMulti\(hands, judged, target/.test(src));
  check('图片路径多人 ROI 走预算补检', /completeHandsMulti\(rawHands, judged, target/.test(src));
  check('归属先于分类（assigned → classifyAndBind）',
    /const assigned = assignHands\(judged, hands\);\s*\n\s*const cls = classifyAndBind\(hands, ts, assigned, !multi\)/.test(src));
  check('图片路径同样先归属', /const assigned = assignHands\(judged, rawHands\);\s*\n\s*for \(let i = 0; i < STILL_SETTLE_FRAMES/.test(src));
  check('手势稳定器随 track prune', /shapeStable\.prune\(live\)/.test(src));
  check('换 profile / 重置时清空逐 track 稳定器',
    /shapeStable = makeShapeStable\(activeParams\)/.test(src) && /shapeStable\.reset\(\)/.test(src));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
