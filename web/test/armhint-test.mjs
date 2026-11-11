// armhint-test.mjs — 「动作与手势」准确度提示（纯函数，不依赖浏览器）
// 运行：node web/test/armhint-test.mjs
//
// 验证的是「提示与判定条件对得上」：哪些动作在当前条件下根本判不了、
// 手部未检出时提示怎么写、同时亮多个动作时讲哪一个。
// 不验证识别准确率——那需要实拍数据（docs/eval.md）。

import { ARM_ACTIONS } from '../js/actions.js';
import { explainArmActions, ARM_NOTES, DEFAULT_HINT } from '../js/armhint.js';

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

const sig = (o = {}) => ({
  ok: true,
  armPose: { has_world: true },
  world: { enabled: true },
  vis: { hip: 0.9 },
  ...o,
});
const act = (flags = {}) => ({ flags });
const hands = (n = 1) => Array.from({ length: n }, () => ({}));
const allReady = (o = {}) => ({
  sig: sig(), act: act(), hands: hands(1), handOn: true, handReady: true, ...o,
});

// —— 1. 注册表覆盖与默认状态 ——
console.log('\n[1] 注册表覆盖');
const base = explainArmActions(allReady());
check('每个手臂动作都有提示', ARM_ACTIONS.every((a) => ARM_NOTES[a.id]));
check('每条提示都带依据/条件/误判', ARM_ACTIONS.every((a) => {
  const t = base.byId[a.id]?.title || '';
  return t.includes('依据：') && t.includes('条件：') && t.includes('误判/漏判：');
}));
check('全部可用且无动作 → 默认提示', base.line === DEFAULT_HINT, base.line);
check('手部已检出 → 状态 ok', base.hands.state === 'ok');
check('无画面不输出提示', explainArmActions({}).line === '');

// —— 2. 置信不足：先讲冻结 ——
console.log('\n[2] 置信不足');
const low = explainArmActions(allReady({ sig: sig({ ok: false }), hands: [] }));
check('低置信 → 提示冻结', low.line.includes('置信不足') && low.line.includes('冻结'), low.line);

// —— 3. 手部模型：关闭 / 未加载 / 未检出 ——
console.log('\n[3] 手部模型状态');
const off = explainArmActions(allReady({ handOn: false, handReady: false, hands: [] }));
check('手部关闭 → 伸手/持物/指向不可用',
  ['reach', 'carry', 'point'].every((id) => off.byId[id].na));
check('手部关闭 → 举手不受影响', off.byId.arm_raised.na === false);
check('手部关闭 → 提示写明', off.line.includes('手部模型关闭'), off.line);
check('手部关闭 → 手部说明', off.hands.state === 'off' && off.hands.title.includes('不判'));
check('不可用原因进 tooltip', off.byId.reach.title.includes('当前不可用：手部模型已关闭'));

const loading = explainArmActions(allReady({ handOn: true, handReady: false, hands: [] }));
check('手部未加载 → 不可用', loading.byId.reach.na === true && loading.line.includes('未加载'), loading.line);

const none = explainArmActions(allReady({ hands: [] }));
check('手部开启但未检出 → 不算「不可用」', none.byId.reach.na === false);
check('未检出 → 提示写明不判', none.line.includes('手未检出'), none.line);
check('未检出 ≠ 手是空的', none.hands.state === 'none' && none.hands.title.includes('≠手是空的'));

// —— 4. 3D / 单帧 / 髋可见性 ——
console.log('\n[4] 运行条件');
const noWorld = explainArmActions(allReady({ sig: sig({ armPose: { has_world: false } }) }));
check('无 3D → 前/侧平举与指向不可用', noWorld.byId.arm_front.na && noWorld.byId.arm_side.na && noWorld.byId.point.na);
check('无 3D → 举手仍可判（降级 2D）', noWorld.byId.arm_raised.na === false);
check('无 3D → 提示写明', noWorld.line.includes('前/侧平举、指向不可用'), noWorld.line);

const worldOff = explainArmActions(allReady({
  sig: sig({ armPose: { has_world: false }, world: { enabled: false } }),
}));
check('3D 被配置关闭 → 原因是配置',
  worldOff.byId.arm_front.why.includes('world.enabled=false'));

// 操作设备必须先在 profile 里圈出设备 ROI；没有 ROI 时标「不可用」，不拿伸手去猜
const noRoi = explainArmActions(allReady({
  sig: sig({ armPose: { has_world: true, operating_roi: false } }),
}));
check('未配置设备 ROI → 操作设备不可用',
  noRoi.byId.operating.na && noRoi.byId.operating.why.includes('ROI'), noRoi.byId.operating.why);
check('未配置设备 ROI → 在设备旁也不可用',
  noRoi.byId.near_equipment.na && noRoi.byId.near_equipment.why.includes('ROI'),
  noRoi.byId.near_equipment.why);
const hasRoi = explainArmActions(allReady({
  sig: sig({ armPose: { has_world: true, operating_roi: true } }),
}));
check('配置 ROI 后操作设备可用', hasRoi.byId.operating.na === false);
check('配置 ROI 后在设备旁可用', hasRoi.byId.near_equipment.na === false);

// 没有画面时 sig 为 null：ROI 是否配置是 profile 的静态条件，不能等一帧跑完才标
const noRoiNoSig = explainArmActions({ operatingRoi: false });
check('无画面也按 profile 标 operating 不可用',
  noRoiNoSig.byId.operating.na && noRoiNoSig.byId.operating.why.includes('ROI'),
  noRoiNoSig.byId.operating.why);
const hasRoiNoSig = explainArmActions({ operatingRoi: true });
check('无画面但已配置 ROI → operating 可用', hasRoiNoSig.byId.operating.na === false);

// detector-only profile：没有 ROI，但配了设备检测类别，同样算「有设备证据」
const eqOnlyNoSig = explainArmActions({
  operatingRoi: false,
  operatingCfg: { equipmentLabels: ['panel', 'valve', 'gauge'] },
});
check('无 ROI 但配了设备检测框 → operating 可用',
  eqOnlyNoSig.byId.operating.na === false, eqOnlyNoSig.byId.operating.why);
check('无 ROI 但配了设备检测框 → 在设备旁可用',
  eqOnlyNoSig.byId.near_equipment.na === false, eqOnlyNoSig.byId.near_equipment.why);

// detector-only 还要求物体检测真的开着/加载好，否则设备证据永远不可能出现
const eqOnlyOff = explainArmActions({
  operatingRoi: false,
  operatingCfg: { equipmentLabels: ['panel'] },
  objectOn: false,
  objectReady: true,
});
check('无 ROI 且物体检测关闭 → operating 不可用',
  eqOnlyOff.byId.operating.na && eqOnlyOff.byId.operating.why.includes('物体检测已关闭'),
  eqOnlyOff.byId.operating.why);
const eqOnlyLoading = explainArmActions({
  operatingRoi: false,
  operatingCfg: { equipmentLabels: ['panel'] },
  objectOn: true,
  objectReady: false,
});
check('无 ROI 且物体检测未加载 → 在设备旁不可用',
  eqOnlyLoading.byId.near_equipment.na && eqOnlyLoading.byId.near_equipment.why.includes('未加载'),
  eqOnlyLoading.byId.near_equipment.why);
const eqOnlyReady = explainArmActions({
  operatingRoi: false,
  operatingCfg: { equipmentLabels: ['panel'] },
  objectOn: true,
  objectReady: true,
});
check('无 ROI 且物体检测就绪 → operating 可用', eqOnlyReady.byId.operating.na === false);

// tooltip 必须反映 profile 覆盖后的生效阈值，不能写死默认 800ms/0.35
const opCfg = {
  roi: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
  minReachRoi: 0.65, minElev: 90, maxElev: 179, minShoulderVis: 0.4,
  minElbowVis: 0.21, minElbowReach: 0.315, minElbowElev: 60,
};
const opHolds = { operating: 1500, operatingMaxGap: 300 };
const tuned = explainArmActions({ operatingRoi: true, operatingCfg: opCfg, operatingHolds: opHolds });
check('tooltip 用生效的 operating 阈值（0.315/1500ms/300ms）',
  tuned.byId.operating.title.includes('0.315')
  && tuned.byId.operating.title.includes('1500ms')
  && tuned.byId.operating.title.includes('300ms')
  && tuned.byId.operating.title.includes('90°'),
  tuned.byId.operating.title);
const defaultNote = explainArmActions({ operatingRoi: true });
check('未传生效配置时 tooltip 仍写默认 800ms', defaultNote.byId.operating.title.includes('800ms'));

const nearCfg = { minOverlap: 0.5, minShoulderVis: 0.4, requireUprightBox: true };
const nearHolds = { nearEquipment: 1000 };
const nearTuned = explainArmActions({
  operatingRoi: true, nearEquipmentCfg: nearCfg, nearEquipmentHolds: nearHolds,
});
check('在设备旁 tooltip 用生效阈值（50%/1000ms）',
  nearTuned.byId.near_equipment.title.includes('≥50%')
  && nearTuned.byId.near_equipment.title.includes('1000ms'),
  nearTuned.byId.near_equipment.title);
const nearValid = explainArmActions({
  operatingRoi: true,
  nearEquipmentCfg: {
    ...nearCfg,
    validity: { enabled: true, minHeightRatio: 0.2, maxHeightRatio: 1.5, minInFrame: 0.5 },
  },
  nearEquipmentHolds: nearHolds,
});
check('开启人框有效性时 tooltip 写明几何门',
  nearValid.byId.near_equipment.title.includes('人框有效'),
  nearValid.byId.near_equipment.title);

const img = explainArmActions(allReady({ imageMode: true }));
check('单帧 → 挥手不可用', img.byId.wave.na && img.byId.wave.why.includes('单帧'));
check('单帧 → 提示写明', img.line.includes('单帧图片'), img.line);

const lowHip = explainArmActions(allReady({ sig: sig({ vis: { hip: 0.1 } }) }));
check('髋不可见 → 提示叉腰不判', lowHip.line.includes('叉腰不判'), lowHip.line);
check('髋不可见不把叉腰标成结构不可用', lowHip.byId.hips.na === false);

// —— 5. 同时亮多个动作：讲可信度最低的那个 ——
console.log('\n[5] 当前动作优先级');
const wav = explainArmActions(allReady({ act: act({ armRaised: true, waving: true }) }));
check('举手 + 挥手 → 讲挥手', wav.line.startsWith('挥手：'), wav.line);
check('挥手提示讲翻转/幅度', wav.line.includes('慢挥') || wav.line.includes('方向反转'));

const pt = explainArmActions(allReady({ act: act({ reaching: true, pointing: true }) }));
check('伸手 + 指向 → 讲指向', pt.line.startsWith('指向：'), pt.line);
check('指向提示写明要指方向/手枪', pt.line.includes('指方向/手枪'), pt.line);

const side = explainArmActions(allReady({ act: act({ pointing: true, pointingL: true }) }));
check('提示行带左右手粒度', side.line.startsWith('左手指向：'), side.line);

const withAcc = explainArmActions(allReady({
  act: act({ armRaised: true }),
  accuracyById: { arm_raised: { short: '召95% · 精90%', long: '召回 95%（95%CI 88–98%，n=120）' } },
}));
check('提示行带实测准确率', withAcc.line.startsWith('举手：准确率 召95% · 精90%'), withAcc.line);
check('tooltip 也带准确率', withAcc.byId.arm_raised.title.includes('准确率：召回 95%'));

const noAcc = explainArmActions(allReady({
  act: act({ armRaised: true }),
  accuracyById: { arm_raised: { short: '未评估', long: '未评估：没有该动作的标注数据（n=0）' } },
}));
check('未评估也明说', noAcc.line.startsWith('举手：准确率 未评估'), noAcc.line);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
