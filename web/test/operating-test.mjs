// operating-test.mjs — operating 的判定门 / 设备框时序 / 握持 / 前臂 / 人形门
// 运行：node web/test/operating-test.mjs

import { SignalEngine } from '../js/signals.js';
import { validateParams } from '../js/params.js';

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

// 13 点骨架（KPT 顺序）。肩 [100,100]/[140,100]，髋 y=200 → scale=100。
// 左腕 [200,150]：reach≈1.12、抬臂角≈117°（水平偏下），正好落在 operating 的区间里。
const BASE = [
  [120, 50, 1],                                        // nose
  [100, 100, 1], [140, 100, 1],                        // shoulders
  [100, 150, 1], [130, 180, 1],                        // 左肘刻意离开设备框（否则肘兜底会命中）
  [200, 150, 1], [150, 250, 1],                        // wrists
  [100, 200, 1], [140, 200, 1],                        // hips
  [100, 300, 1], [140, 300, 1],                        // knees
  [100, 380, 1], [140, 380, 1],                        // ankles
];
const mkKp = (over = {}) => {
  const kp = BASE.map((p) => p.slice());
  for (const [i, v] of Object.entries(over)) kp[Number(i)] = v;
  return kp;
};
const mkPerson = (over = {}, { bbox = [80, 40, 160, 300], frameW = 1000, frameH = 1000 } = {}) => ({
  kp: mkKp(over), kp_raw: [], bbox, scale: 100, score: 0.9, track_id: 0,
  frame_w: frameW, frame_h: frameH,
});
const valve = (box, label = 'valve') => ({ label, score: 0.9, box });
const opParams = (operating = {}) => ({
  signals: { arm: { operating: {
    roi: { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
    equipmentLabels: ['valve'],
    equipmentMinScore: 0.3,
    ...operating,
  } } },
});

console.log('\n[1] 基本判定与 gate 诊断');
{
  const box = [180, 130, 220, 170];   // 左腕 [200,150] 在框内
  const se = new SignalEngine(opParams());
  const s = se.update(mkPerson(), 1000, [valve(box)], null, null);
  check('手在设备框内 → operating', s.arm.operating_any === true, `gate=${s.arm.operating_gate}`);
  check('命中时 gate=ok', s.arm.operating_gate === 'ok');
  check('本帧用了设备框', s.arm.operating_equipment === true && s.arm.operating_boxes_used === 1);

  const far = new SignalEngine(opParams({ equipmentMaxDist: 0.1 }))
    .update(mkPerson(), 1000, [valve([400, 400, 500, 500])], null, null);
  check('框远 → not_near', far.arm.operating_gate === 'not_near', far.arm.operating_gate);

  const high = new SignalEngine(opParams())
    .update(mkPerson({ 5: [200, 60, 1] }), 1000, [valve([180, 40, 220, 80])], null, null);
  // 汇总 gate 取「四条分支里走得最远的一关」：右臂没贴到框（not_near）会盖过左臂的 elev_low，
  // 所以逐侧原因要看 gate_L / gate_R（界面与离线排查就是读这两个字段）。
  check('手抬到肩以上 → 左臂 elev_low',
    high.arm.operating_any === false && high.arm.operating_gate_L === 'elev_low',
    `L=${high.arm.operating_gate_L} all=${high.arm.operating_gate}`);
}

console.log('\n[2] 设备框时序确认：单帧误检不算证据');
{
  const box = [180, 130, 220, 170];
  const se = new SignalEngine(opParams({ boxMinHits: 2, boxMaxAgeMs: 600, equipmentFallbackRoi: false }));
  const a = se.update(mkPerson(), 1000, [valve(box)], null, 1000);
  check('第一次检测只 pending，不参与判定', a.arm.operating_any === false && a.arm.operating_boxes_used === 0,
    `raw=${a.arm.operating_boxes_raw} used=${a.arm.operating_boxes_used}`);
  const b = se.update(mkPerson(), 1100, [valve(box)], null, 1000);
  check('同一 observationTs 的重复帧不确认', b.arm.operating_any === false);
  const c = se.update(mkPerson(), 1300, [valve(box)], null, 1300);
  check('第二次不同检测 → 确认并判定', c.arm.operating_any === true && c.arm.operating_boxes_confirmed === 1);
  const d = se.update(mkPerson(), 2200, [], null, 2200);
  check('超过 maxAgeMs → 过期（退回 ROI 兜底）', d.arm.operating_boxes_used === 0,
    `used=${d.arm.operating_boxes_used}`);
}

console.log('\n[3] ROI 约束：背景里的设备框不算');
{
  // ROI 只在左半屏；检测框在右半屏、手也在右半屏
  const p = mkPerson({ 5: [850, 150, 1], 3: [700, 130, 1] }, { bbox: [700, 40, 900, 300] });
  const boxes = [valve([800, 130, 900, 170])];
  const on = new SignalEngine(opParams({ boxRequireInRoi: true, equipmentFallbackRoi: false, roi: { x: 0, y: 0, w: 0.5, h: 1 } }))
    .update(p, 1000, boxes, null, null);
  check('框在 ROI 外 → 不参与（used=0）', on.arm.operating_boxes_used === 0,
    `used=${on.arm.operating_boxes_used}`);
  check('框被 ROI 挡掉后不判 operating', on.arm.operating_any === false);
  const off = new SignalEngine(opParams({ boxRequireInRoi: false, equipmentFallbackRoi: false, roi: { x: 0, y: 0, w: 0.5, h: 1 } }))
    .update(p, 1000, boxes, null, null);
  check('关掉 ROI 约束 → 照常判定', off.arm.operating_any === true);
}

console.log('\n[4] 前臂线段到框的距离');
{
  // 腕 [300,150] 离框 [180,130,220,170] 80px（>0.35×scale），但前臂穿过框
  // 左肘保持在 [100,150]（离框 80px，肘兜底不会命中），只把腕拉到框外
  const p = mkPerson({ 5: [300, 150, 1] });
  const boxes = [valve([180, 130, 220, 170])];
  const byPoint = new SignalEngine(opParams()).update(p, 1000, boxes, null, null);
  check('只看腕点 → not_near', byPoint.arm.operating_any === false, byPoint.arm.operating_gate);
  const bySeg = new SignalEngine(opParams({ useForearm: true })).update(p, 1000, boxes, null, null);
  check('腕点+前臂线段 → operating', bySeg.arm.operating_any === true, bySeg.arm.operating_gate);
}

console.log('\n[5] 握持门（requireGrip）');
{
  const box = [180, 130, 220, 170];
  const handsFist = { L: { cls: { shape: 'fist' } }, R: null };
  const handsOpen = { L: { cls: { shape: 'open' } }, R: null };
  const noHands = { L: null, R: null };
  const withFist = new SignalEngine(opParams({ requireGrip: true }))
    .update(mkPerson(), 1000, [valve(box)], handsFist, null);
  check('握拳 → 成立', withFist.arm.operating_any === true);
  const withOpen = new SignalEngine(opParams({ requireGrip: true }))
    .update(mkPerson(), 1000, [valve(box)], handsOpen, null);
  check('张开手掌 → no_grip', withOpen.arm.operating_any === false && withOpen.arm.operating_gate === 'no_grip',
    withOpen.arm.operating_gate);
  const missing = new SignalEngine(opParams({ requireGrip: true }))
    .update(mkPerson(), 1000, [valve(box)], noHands, null);
  check('没有手部数据 → fail-closed', missing.arm.operating_any === false);
  const off = new SignalEngine(opParams())
    .update(mkPerson(), 1000, [valve(box)], handsOpen, null);
  check('默认不要求握持（旧行为）', off.arm.operating_any === true);
}

console.log('\n[6] 人形门：横着的人体框不是人');
{
  const box = [180, 130, 220, 170];
  const wide = mkPerson({}, { bbox: [50, 100, 250, 160] });   // 200×60，横框
  const strict = new SignalEngine(opParams({ requireUprightBox: true }))
    .update(wide, 1000, [valve(box)], null, null);
  check('横框 → person_not_upright', strict.arm.operating_any === false
    && strict.arm.operating_gate === 'person_not_upright', strict.arm.operating_gate);
  const lax = new SignalEngine(opParams())
    .update(wide, 1000, [valve(box)], null, null);
  check('默认不启用 → 旧行为', lax.arm.operating_any === true);
  const tall = mkPerson({}, { bbox: [80, 40, 160, 300] });
  const ok = new SignalEngine(opParams({ requireUprightBox: true }))
    .update(tall, 1000, [valve(box)], null, null);
  check('正常竖框 → 不受影响', ok.arm.operating_any === true);
}

console.log('\n[7] 人形门：只写 requireValidity 也必须真的生效');
{
  const box = [180, 130, 220, 170];
  // 10×20 的框在 1000×1000 里：area_ratio 2e-4 < 0.003、height_ratio 0.02 < 0.15
  const tiny = mkPerson({}, { bbox: [80, 40, 90, 60] });
  // nearEquipment.validity.enabled 默认 false：只写 operating.requireValidity 时
  // personBoxValidity() 曾直接返回 ok=true，门静默失效（误报控制门不能静默）。
  const s = new SignalEngine(opParams({ requireValidity: true }))
    .update(tiny, 1000, [valve(box)], null, null);
  check('requireValidity + 默认 validity(disabled) → 过小人框不判 operating',
    s.arm.operating_any === false && s.arm.operating_gate === 'person_invalid',
    `gate=${s.arm.operating_gate}`);
  check('operating_validity 有值（门真的跑了，不是 null）',
    s.arm.operating_validity?.enabled === true && s.arm.operating_validity.ok === false,
    JSON.stringify(s.arm.operating_validity?.reasons));

  const ok = new SignalEngine(opParams({ requireValidity: true }))
    .update(mkPerson(), 1000, [valve(box)], null, null);
  check('正常人体框 → 仍判 operating', ok.arm.operating_any === true && ok.arm.operating_validity?.ok === true);
}

console.log('\n[8] 参数一致性：boxMaxAgeMs 必须覆盖检测间隔');
{
  const op = (extra = {}) => ({ equipmentLabels: ['valve'], ...extra });
  const bad = {
    signals: { arm: { operating: op({ boxMinHits: 2, boxMaxAgeMs: 600 }) } },
    perception: { objects: { intervalMs: 1000 } },
  };
  let err = null;
  try { validateParams(bad); } catch (e) { err = e; }
  check('intervalMs 1000 + 300 > boxMaxAgeMs 600 → 报配置错误', !!err, err?.message?.slice(0, 50));
  check('合法组合（150 / 600）通过',
    validateParams({ ...bad, perception: { objects: { intervalMs: 150 } } })
      .signals.arm.operating.boxMaxAgeMs === 600);
  check('没配 equipmentLabels 时不约束（不消费设备框）',
    validateParams({ signals: { arm: { operating: op({ equipmentLabels: [] }) } }, perception: { objects: { intervalMs: 1000 } } })
      .perception.objects.intervalMs === 1000);
  check('boxMinHits=1（关闭时序确认）时不约束',
    validateParams({ signals: { arm: { operating: op({ boxMinHits: 1 }) } }, perception: { objects: { intervalMs: 1000 } } })
      .signals.arm.operating.boxMinHits === 1);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
