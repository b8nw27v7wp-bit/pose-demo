// equipment-test.mjs — 设备框时序过滤 / 线段到框距离 / 单人道主目标选择
// 运行：node web/test/equipment-test.mjs

import { EquipmentBoxTracker } from '../js/equipment.js';
import { pointBoxDistance, segmentBoxDistance } from '../js/geometry.js';
import { pickSingleTarget } from '../js/multi.js';

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
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= tol;

const valve = (box) => ({ label: 'valve', box });

console.log('\n[1] 时序确认：单帧误检不算设备证据');
{
  const t = new EquipmentBoxTracker({ minHits: 2, maxAgeMs: 600 });
  const objs = [valve([10, 10, 100, 100])];
  let r = t.update(objs, 1000, 1000);
  check('第一次检测只记 pending', r.confirmed === 0 && r.pending === 1 && r.bypass === false, JSON.stringify(r));
  check('未确认的框不返回', r.boxes.length === 0);

  // 两次检测之间 app 会反复沿用同一批框：observationTs 相同，不能重复计数
  r = t.update(objs, 1100, 1000);
  check('同一 observationTs 的重复帧不重复计数', r.confirmed === 0, JSON.stringify(r));

  r = t.update(objs, 1200, 1200);
  check('第二次不同的检测 → 确认', r.confirmed === 1 && r.boxes.length === 1);

  r = t.update([], 2000, 2000);
  check('超过 maxAgeMs 没再看到 → 过期', r.confirmed === 0 && r.boxes.length === 0);
}

console.log('\n[1b] 过期过滤在匹配之前：超龄轨迹不能靠这一次匹配「续命」');
{
  // SignalEngine 只在有人的帧调用 update：漏检/多人缺席期间轨迹不会被清理，
  // 人回来后第一次检测若先匹配再过期，旧轨迹会从 hits=1 变成 2，minHits 形同 1。
  const t = new EquipmentBoxTracker({ minHits: 2, maxAgeMs: 200 });
  const objs = [valve([10, 10, 100, 100])];
  t.update(objs, 0, 0);
  let r = t.update(objs, 500, 500);
  check('间隔 500ms > maxAgeMs 200（中间无 update）→ 不得确认',
    r.confirmed === 0 && r.pending === 1, JSON.stringify(r));

  const t2 = new EquipmentBoxTracker({ minHits: 2, maxAgeMs: 600 });
  t2.update(objs, 0, 0);
  r = t2.update(objs, 500, 500);
  check('间隔 500ms 在 maxAgeMs 600 内（中间无 update）→ 仍算续上', r.confirmed === 1,
    JSON.stringify(r));
}

console.log('\n[2] 无时序信息时不过滤（旧导出 / 单张图片）');
{
  const t = new EquipmentBoxTracker({ minHits: 2 });
  const r = t.update([valve([10, 10, 100, 100])], 1000, null);
  check('observationTs=null → 直接返回', r.bypass === true && r.boxes.length === 1);
  const r2 = t.update([valve([10, 10, 100, 100])], 1100, null);
  check('连续两帧 null 也不累积状态', r2.bypass === true && r2.boxes.length === 1);
}

console.log('\n[3] 匹配：同位置续上、别的位置另起、标签不混');
{
  const t = new EquipmentBoxTracker({ minHits: 2, maxAgeMs: 800 });
  t.update([valve([10, 10, 100, 100])], 1000, 1000);
  let r = t.update([valve([12, 12, 102, 102])], 1200, 1200);
  check('轻微抖动仍算同一位置', r.confirmed === 1, JSON.stringify(r));

  const t2 = new EquipmentBoxTracker({ minHits: 2 });
  t2.update([valve([10, 10, 100, 100])], 1000, 1000);
  r = t2.update([valve([300, 300, 400, 400])], 1200, 1200);
  check('远处另一个框不会继承命中', r.confirmed === 0 && r.pending === 2, JSON.stringify(r));

  const t3 = new EquipmentBoxTracker({ minHits: 2 });
  t3.update([valve([10, 10, 100, 100])], 1000, 1000);
  r = t3.update([{ label: 'panel', box: [10, 10, 100, 100] }], 1200, 1200);
  check('不同标签不互相匹配', r.confirmed === 0, JSON.stringify(r));
}

console.log('\n[4] 确认后短暂漏检仍算在（maxAgeMs 内）');
{
  const t = new EquipmentBoxTracker({ minHits: 2, maxAgeMs: 600 });
  t.update([valve([10, 10, 100, 100])], 1000, 1000);
  t.update([valve([10, 10, 100, 100])], 1200, 1200);
  const r = t.update([], 1500, 1500);
  check('漏检一帧（300ms 内）仍有框', r.confirmed === 1 && r.boxes.length === 1);
}

console.log('\n[5] 旧行为：minHits=1 等价于不做时序确认');
{
  const t = new EquipmentBoxTracker({ minHits: 1 });
  const r = t.update([valve([10, 10, 100, 100])], 1000, 1000);
  check('第一次检测就确认', r.confirmed === 1 && r.boxes.length === 1);
}

console.log('\n[6] 点到框 / 线段到框的距离');
{
  const box = [10, 10, 20, 20];
  check('点在框内 → 0', pointBoxDistance(15, 15, box) === 0);
  check('点在外 → 欧氏距离', near(pointBoxDistance(5, 15, box), 5));
  check('线段不接触 → 到框边距离', near(segmentBoxDistance([0, 15], [5, 15], box), 5));
  check('线段穿过框 → 0（两端都在框外也认）', segmentBoxDistance([0, 15], [30, 15], box) === 0);
  check('线段擦过角 → 0', segmentBoxDistance([20, 20], [30, 30], box) === 0);
  check('线段远离 → 角到线段距离', near(segmentBoxDistance([30, 30], [40, 40], box), Math.hypot(10, 10), 1e-6));
  check('非法输入 → NaN', Number.isNaN(segmentBoxDistance([0, 0], [1, 1], [1, 2])));
}

console.log('\n[7] 单人道主目标选择');
{
  // area: A=400×400 最大；B 躯干长最大；C 是横框（宽>高）
  const A = { bbox: [0, 0, 400, 400], scale: 50 };
  const B = { bbox: [0, 0, 100, 200], scale: 120 };
  const C = { bbox: [0, 0, 300, 60], scale: 80 };
  const persons = [A, B, C];
  check('largest（默认）按面积', pickSingleTarget(persons) === A);
  check('torso 按躯干长', pickSingleTarget(persons, 'torso') === B);
  check('upright 跳过横框', pickSingleTarget(persons, 'upright') === A);
  const onlyWide = [{ bbox: [0, 0, 300, 60], scale: 10 }, { bbox: [0, 0, 100, 50], scale: 20 }];
  check('upright 全是横框时退回面积', pickSingleTarget(onlyWide, 'upright')?.scale === 10);
  check('空数组 → null', pickSingleTarget([], 'torso') === null);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
