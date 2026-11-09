// ppe-test.mjs — R13-2 track_uid + R13-10 requirePositive 窗口化
// 运行：node web/test/ppe-test.mjs
//
// 只测纯逻辑（track.js / ppe.js），不需要浏览器、模型或视频。
// 旧行为（无 uid、positiveWindowMs=0）必须逐位不变：multi-test.mjs 仍在跑同一组断言。

import { Tracker } from '../js/track.js';
import { PpeMonitor, headBox, wristBox, assessPpe } from '../js/ppe.js';
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

const W = 640;
const H = 480;
function mkPerson({ cx = 320, cy = 240, s = 120, vis = 1, uid } = {}) {
  const kp = Array.from({ length: 13 }, () => [0, 0, 0]);
  kp[0] = [cx, cy - 0.15 * s, vis];            // 鼻
  kp[1] = [cx - 0.3 * s, cy - 0.1 * s, vis];   // 左肩
  kp[2] = [cx + 0.3 * s, cy - 0.1 * s, vis];
  kp[5] = [cx - 0.45 * s, cy + 0.2 * s, vis];  // 左腕
  kp[6] = [cx + 0.45 * s, cy + 0.2 * s, vis];
  kp[7] = [cx - 0.2 * s, cy + 0.5 * s, vis];
  kp[8] = [cx + 0.2 * s, cy + 0.5 * s, vis];
  kp[9] = [cx - 0.2 * s, cy + 0.5 * s, vis];
  kp[10] = [cx + 0.2 * s, cy + 0.5 * s, vis];
  const p = {
    bbox: [cx - 0.4 * s, cy - 0.6 * s, cx + 0.4 * s, cy + 1.4 * s],
    kp, scale: s, score: 0.9,
  };
  if (uid !== undefined) p.track_uid = uid;
  return p;
}
const label = (name, box) => ({ label: name, score: 0.9, box });

// —— 1. track_uid ——
console.log('\n[1] Tracker 分配 track_uid');
{
  const tr = new Tracker();
  const A = mkPerson({ cx: 160 });
  const B = mkPerson({ cx: 500 });
  const o1 = tr.update([A, B], 1000);
  const uA = o1.find((p) => p.bbox[0] < 320).track_uid;
  const uB = o1.find((p) => p.bbox[0] > 320).track_uid;
  const idA = o1.find((p) => p.bbox[0] < 320).track_id;
  check('每条轨迹都有数字 track_uid', Number.isInteger(uA) && Number.isInteger(uB));
  check('两人 uid 不同', uA !== uB, `${uA}/${uB}`);

  const o2 = tr.update([mkPerson({ cx: 165 }), mkPerson({ cx: 495 })], 1100);
  check('同一人跨帧 uid 不变', o2.find((p) => p.bbox[0] < 320).track_uid === uA);
  check('同一人跨帧 track_id 不变', o2.find((p) => p.bbox[0] < 320).track_id === idA);

  const firstId = tr.nextId;
  tr.reset();
  const o3 = tr.update([A], 2000);
  check('reset 后 track_id 仍从 1 开始（A/B 基线不变）', o3[0].track_id === 1);
  check('reset 后 uid 继续单调，不复用', o3[0].track_uid > Math.max(uA, uB),
    `uid=${o3[0].track_uid}, nextId=${firstId}`);
}

// —— 2. PPE 计时按 uid 绑定 ——
console.log('\n[2] PpeMonitor 按 track_uid 绑定（R13-2）');
{
  const cfg = resolveParams({}).signals.ppe;
  const p = mkPerson({ uid: 7 });
  const h = headBox(p, cfg);
  const helmet = label('helmet', h.box);

  const mon = new PpeMonitor(cfg);
  mon.update(1, p, [helmet], 1000);             // track_id=1, uid=7，戴帽
  const m1 = mon.update(1, p, [], 2000);        // 缺帽起点
  check('缺帽开始计时', m1.helmet.state === 'missing' && m1.helmet.streak_ms === 0);
  const m2 = mon.update(1, p, [], 5000);        // 3.0s
  check('uid 稳定时 3s 升违规', m2.helmet.alert === 'violation', `${m2.helmet.streak_ms}ms`);

  // 跟踪器超时后发新 track_id：同一 uid 的计时不能清零
  const m3 = mon.update(2, { ...p, track_uid: 7 }, [], 5200);
  check('track_id 变化、uid 不变 → 计时连续', m3.helmet.streak_ms >= 3200 && m3.helmet.alert === 'violation',
    `${m3.helmet.streak_ms}ms`);
  check('tracks 以 uid 为键，不因新 id 多一条', mon.tracks.size === 1 && mon.tracks.has(7),
    [...mon.tracks.keys()].join(','));

  // 旧数据没有 track_uid：退回 track_id
  const old = mkPerson();
  const monOld = new PpeMonitor(cfg);
  monOld.update(11, old, [helmet], 1000);
  const o1 = monOld.update(11, old, [], 2000);
  const o2 = monOld.update(11, old, [], 5000);
  check('无 uid 的旧数据回退到 track_id', o2.helmet.alert === 'violation', `${o2.helmet.streak_ms}ms`);
  const o3 = monOld.update(12, old, [], 5100);
  check('无 uid 时换 track_id 仍从 0 计时（保持旧语义）', o3.helmet.streak_ms === 0);

  // prune：调用方可能还在传 track_id，也可能已经改传 uid
  mon.prune(new Set([2]));
  check('prune(track_id) 能保住同条轨迹', mon.tracks.has(7));
  mon.prune(new Set([7]));
  check('prune(track_uid) 也成立', mon.tracks.has(7));
  mon.prune(new Set(['nothing']));
  check('prune 未命中则丢弃', mon.tracks.size === 0);
}

// —— 3. requirePositive 窗口化 ——
console.log('\n[3] requirePositive 窗口化（R13-10）');
{
  const base = resolveParams({}).signals.ppe;
  const p = mkPerson({ uid: 1 });
  const h = headBox(p, base);
  const helmet = label('helmet', h.box);

  // 默认参数 = 旧行为：一次正例整场 sticky
  const legacy = new PpeMonitor(base);
  legacy.update(1, p, [helmet], 1000);
  const l1 = legacy.update(1, p, [], 1100);
  const l2 = legacy.update(1, p, [], 2500);
  const l3 = legacy.update(1, p, [], 4200);
  check('默认参数：1.4s 不告警', l2.helmet.alert === 'none' && l2.helmet.streak_ms === 1400,
    `${l2.helmet.streak_ms}ms`);
  check('默认参数：≥3s violation（与旧行为逐位一致）',
    l3.helmet.alert === 'violation' && l3.helmet.streak_ms === 3100, `${l3.helmet.streak_ms}ms`);
  const l4 = legacy.update(1, p, [], 100000);
  check('默认参数：一次正例永久解锁护栏', l4.helmet.state === 'missing',
    `${l4.helmet.state}/${l4.helmet.reason_code}`);

  // 窗口化：一次误匹配不再永久解锁
  const cfg = { ...base, positiveWindowMs: 5000, minPositive: 3 };
  check('默认 minPositive=3', new PpeMonitor(base).minPositive === 3);
  const win = new PpeMonitor(cfg);
  win.update(1, p, [helmet], 1000);                    // 1 次误匹配
  const w1 = win.update(1, p, [], 2000);
  check('窗口内正例不足 → unknown，而不是 missing',
    w1.helmet.state === 'unknown' && w1.helmet.reason_code === 'no_positive',
    `${w1.helmet.state}/${w1.helmet.reason_code}`);
  const w2 = win.update(1, p, [], 7000);
  check('一次误匹配没有永久解锁护栏', w2.helmet.state === 'unknown');

  // 窗口内达到 minPositive 才解锁
  const win2 = new PpeMonitor(cfg);
  win2.update(2, p, [helmet], 3000);
  win2.update(2, p, [helmet], 4000);
  win2.update(2, p, [helmet], 5000);
  const w3 = win2.update(2, p, [], 6000);
  check('窗口内 3 次正例 → missing', w3.helmet.state === 'missing', `${w3.helmet.state}`);
  const w4 = win2.update(2, p, [], 8000);
  check('继续 missing 时计时累计', w4.helmet.state === 'missing' && w4.helmet.streak_ms === 2000,
    `${w4.helmet.streak_ms}ms`);
  // 头不可见 → unknown 暂停，不清零
  const w5 = win2.update(2, mkPerson({ uid: 1, vis: 0.05 }), [], 9000);
  check('unknown 暂停计时、不清零',
    w5.helmet.state === 'unknown' && w5.helmet.streak_ms >= 2000, `${w5.helmet.streak_ms}ms`);
  const w6 = win2.update(2, p, [], 11000);             // 窗口已过（最近正例 5000）
  check('窗口过期 → 回到 unknown（护栏重新生效）',
    w6.helmet.state === 'unknown' && w6.helmet.reason_code === 'no_positive');

  // 同一时刻的多人调用不能重复计数：app 每帧对每个判定人员调用一次 update，
  // objects 还是检测间隔内复用的同一批框。按调用次数计数会让 minPositive 形同虚设。
  const dedupe = new PpeMonitor(cfg);
  dedupe.update(1, p, [helmet], 1000);
  dedupe.update(2, p, [helmet], 1000);
  dedupe.update(3, p, [helmet], 1000);
  check('同一时刻的同一个框只计一帧（不按人数凑满 minPositive）',
    dedupe.saw.helmet === false, JSON.stringify(dedupe.saw));
  const perFrame = new PpeMonitor(cfg);
  perFrame.update(1, p, [helmet], 1000);
  perFrame.update(1, p, [helmet], 1100);
  perFrame.update(1, p, [helmet], 1200);
  check('连续 3 帧正例才解锁护栏（minPositive=3）',
    perFrame.saw.helmet === true, JSON.stringify(perFrame.saw));

  // minPositive 可配
  const one = new PpeMonitor({ ...cfg, positiveWindowMs: 1000, minPositive: 1 });
  one.update(3, p, [helmet], 1000);
  const wOne = one.update(3, p, [], 1500);
  check('minPositive=1 时一次正例即可解锁', wOne.helmet.state === 'missing');
}

// —— 4. reason_code ——
console.log('\n[4] unknown 的 reason_code');
{
  const cfg = resolveParams({}).signals.ppe;
  const p = mkPerson();
  const noClass = assessPpe(p, [], { ...cfg, classes: { ...cfg.classes, helmet: [] } },
    { sawClasses: { helmet: true, glove: true } });
  check('未配置类别 → config_mismatch', noClass.helmet.reason_code === 'config_mismatch');
  check('原有 reason 文案保留', /未配置/.test(noClass.helmet.reason), noClass.helmet.reason);

  const blind = assessPpe(mkPerson({ vis: 0.05 }), [], cfg,
    { sawClasses: { helmet: true, glove: true } });
  check('头部不可见 → occluded', blind.helmet.reason_code === 'occluded');

  const never = assessPpe(p, [], cfg, { sawClasses: { helmet: false, glove: false } });
  check('没有正例 → no_positive', never.helmet.reason_code === 'no_positive');

  const g = assessPpe(mkPerson({ vis: 0.05 }), [], cfg, { sawClasses: { helmet: true, glove: true } });
  check('腕不可见 → occluded（手套）', g.glove.L.reason_code === 'occluded');
  const gw = wristBox(p, 'L', cfg);
  const worn = assessPpe(p, [label('glove', gw.box)], cfg, { sawClasses: { helmet: true, glove: true } });
  check('worn/missing 的 reason_code 为 null', worn.glove.L.reason_code === null);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
