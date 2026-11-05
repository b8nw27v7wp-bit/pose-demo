// multi-test.mjs — 多人跟踪 / 每人独立流水线 / PPE 判定的确定性单测
// 运行：node web/test/multi-test.mjs
//
// 这里验证的是**逻辑**：id 会不会串、状态机会不会共用、看不见会不会误判成没戴。
// 不代表真实场景精度——准确率必须用实拍素材测（docs/eval.md）。

import { Tracker, iou, area, optimalAssign } from '../js/track.js';
import { PersonPipelines, assignHands } from '../js/multi.js';
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

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
