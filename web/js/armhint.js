// armhint.js — 「动作与手势」面板的准确度提示
//
// 为什么单独一层：一个动作判没判出来，取决于**运行条件**（手部模型是否开着、
// 本帧有没有 3D world、髋在不在画面里、是不是单帧图片），而不是动作本身。
// 这些条件不写出来，用户会把「判不了」当成「没做」，或者把 2D 近似当成结论。
//
// 这里只解读已有信号，不改变任何判定：动作层仍然只认 signals.js + actions.js。
// 提示文案要随判定逻辑一起改——每条 note 的 need/caveat 都对着实际的判据写。

import { ARM_ACTIONS } from './actions.js';

/**
 * 每个动作的判定依据、成立条件、已知误判/漏判。
 * basis 说明「拿什么判」，need 说明「要满足什么」，caveat 说明「什么情况下会错」。
 * 这里不写准确率数字：实测值由 accuracy.js 从评估报告读，没有数据就显示「未评估」。
 */
export const ARM_NOTES = {
  arm_raised: {
    basis: '3D 抬臂角（相对躯干）优先，该侧无 3D 时退回 2D 腕高于肩',
    need: '任一侧肩、腕可见，保持 300ms',
    caveat: '无 3D 时俯拍/正视会把「手向前伸」判成举手；手腕没抬到肩附近（举到一半）不算',
  },
  both_up: {
    basis: '两侧举手同时成立',
    need: '两侧肩、腕都可见，保持 350ms',
    caveat: '一侧被遮挡时只会算单臂举手；和「举手」同时亮是包含关系，不是重复误判',
  },
  wave: {
    basis: '同一条举起的臂：腕部水平往返的翻转次数 + 幅度',
    need: '800ms 内方向反转 ≥3 次、水平幅度 >0.25 躯干长，且该侧仍算举手，保持 150ms',
    caveat: '慢挥、幅度小、举着不动都不会命中；单帧图片没有时间窗，不可能判出',
  },
  crossed: {
    basis: '两腕的左右顺序相对肩膀翻转',
    need: '双腕可见、都在肩高 ±1.1 躯干内，保持 400ms',
    caveat: '双手在身前交叠（抱文件夹）也会命中；手腕被身体挡住时漏判',
  },
  hips: {
    basis: '腕贴同侧髋 + 肘外张（肘不可见时只看腕）',
    need: '双腕可见、髋可见，保持 400ms',
    caveat: '手插口袋、手扶腰侧可能误判；髋出画（上半身构图）时完全不判',
  },
  arms_open: {
    basis: '两侧抬臂角 + 腕-肩距离',
    need: '两侧抬臂角 55°~125°、手臂伸到 >0.9 躯干长，保持 400ms',
    caveat: '侧对镜头时手臂投影变短会漏判；弯腰/前伸的透视可能凑成张开',
  },
  hand_head: {
    basis: '腕到鼻尖距离 + 腕不低于肩',
    need: '腕到鼻尖 <0.55 躯干长且不明显低于肩，保持 350ms',
    caveat: '摸头发/扶眼镜/接电话是目标动作；走路时手臂前摆经过脸前仍可能误报',
  },
  oil_sample: {
    basis: '腕到鼻尖距离 + 腕不低于肩 + 手在身体前方（3D 方位角）',
    need: '腕到鼻尖 <0.55 躯干长、不明显低于肩、方位角 ≤60°，保持 1000ms',
    caveat: '和「手在头部」的区别只有「手在身前」+ 更长的保持窗；没有 3D 时退化成纯距离判据，摸头/扶眼镜也会命中；单手举瓶、双手捧瓶都能判，但手在身体侧后方看样瓶会漏判',
  },
  reach: {
    basis: '手臂伸出 + 手部模型判为「张开」',
    need: '腕-肩 >1.25 躯干长、抬臂角 >30°，且该侧手被判为「张开」(open)，保持 250ms',
    caveat: '手部模型关闭/未检出/手型判不出时不判；握拳、指方向、剪刀手都不算伸手',
  },
  carry: {
    basis: '手部模型判为握拳/OK + 手臂未伸出',
    need: '任一手被判为握拳/OK、两臂腕-肩都 <1.2 躯干长，保持 300ms',
    caveat: '没有物体检测：空手握拳、扶栏杆也会命中；手型判不出时不判',
  },
  operating: {
    basis: '腕进设备 ROI（矩形或多边形，强证据），或肘进 ROI（手被设备挡住时的兜底）',
    need: '腕在 ROI 内、腕-肩 >0.65、抬臂角 90°~179°、双肩可见；或肘在 ROI 内、肘-肩 >0.35、抬臂角 60°~179°，保持 800ms（允许 300ms 内短暂遮挡）',
    caveat: '没有设备 ROI 或检测框时不判；profile 配了 equipmentLabels 且有检测框时优先用框（腕/肘到框 ≤equipmentMaxDist），没有框的帧退回 ROI；ROI 是人工区域，设备模型不进 git；自然垂手/手和肘都被挡住时可能误判/漏判',
  },
  near_equipment: {
    basis: '人体框与设备 ROI/检测框重叠（上下文事件，不要求手在设备上）',
    need: '人体框面积 ≥30% 落在 ROI/设备框内、两肩可见、人体框竖直，保持 1000ms',
    caveat: '只说明「人在设备旁」，不能当「在操作」；没有 ROI/检测框时不判；有检测框时取「与框重叠」和「与 ROI 重叠」的较大值（fail-closed 时只认框）；设备/手特写被检出成人时仍可能误报；profile 可开人体框有效性门（挡过小/满屏/大半出画）',
  },
  point: {
    basis: '手臂伸出 + 该侧手判为「指方向/手枪」+ 3D 方位角朝前/侧',
    need: '需要 3D world；腕-肩 >1.25 躯干长、手臂接近水平且基本伸直，手型为 pointing/gun，保持 250ms',
    caveat: '无 3D 时不可用（方位角算不出）；只有「指方向/手枪」手型才算，张开手掌算伸手；手型判不出或侧对镜头时不判',
  },
  arm_front: {
    basis: '3D 水平方位角 + 抬臂角',
    need: '需要 3D world 坐标；手臂接近水平、基本伸直、腕在肩高附近，保持 300ms',
    caveat: '无 3D 时完全不可用；快速摆臂仍可能短暂命中',
  },
  arm_side: {
    basis: '3D 水平方位角 + 抬臂角',
    need: '需要 3D world 坐标；手臂接近水平、基本伸直、腕在肩高附近，保持 300ms',
    caveat: '无 3D 时完全不可用；侧对镜头时方位角退化，容易漏判',
  },
};

const ID_TO_FLAG = Object.fromEntries(ARM_ACTIONS.map((a) => [a.id, a.flag]));
const NAME = Object.fromEntries(ARM_ACTIONS.map((a) => [a.id, a.name]));

// 依赖手部模型的三个动作。手部关掉/未加载时它们恒为 false，
// 面板必须标成「不可用」而不是「没做」。
const HAND_ACTIONS = new Set(['reach', 'carry', 'point']);

// 没有 3D world 就完全无法判定（方位角是 NaN）。和「降级」区分开：
// 举手降级成 2D 仍然能判，只是更容易错。
const WORLD_ACTIONS = new Set(['point']);

// 同时亮多个动作时，提示优先给「可信度最低」的那个：
// 指向/持物只有弱证据，静态动作放最后。只列面板上看得见的动作——
// 已下线/隐藏的动作即使引擎判出，也不该在提示行里出现。
const ACTIVE_PRIORITY = ['point', 'carry', 'operating', 'oil_sample', 'near_equipment', 'reach', 'arm_raised'];

// 单手动作的逐侧 flag。提示行用它把「举手」说成「左手举手」，
// 而不是只给一个左右不分的聚合标签。双侧同时成立时不加前缀。
const SIDE_FLAGS = {
  arm_raised: ['armRaisedL', 'armRaisedR'],
  reach: ['reachingL', 'reachingR'],
  point: ['pointingL', 'pointingR'],
  carry: ['carryingL', 'carryingR'],
  operating: ['operatingL', 'operatingR'],
  oil_sample: ['oilSampleL', 'oilSampleR'],
};

export const DEFAULT_HINT = '悬停动作名：查看判定条件与已知误判';

/**
 * operating 的生效阈值来自 profile（可能覆盖默认值），提示里不能写死 800ms/0.35，
 * 否则换了 profile 后 tooltip 与真实判定不一致。
 */
function nearEquipmentNeed(cfg, holds) {
  if (!cfg) return ARM_NOTES.near_equipment.need;
  const pct = Number.isFinite(Number(cfg.minOverlap)) ? Math.round(Number(cfg.minOverlap) * 100) : '?';
  const hold = Number.isFinite(Number(holds?.nearEquipment)) ? Number(holds.nearEquipment) : 1000;
  const upright = cfg.requireUprightBox !== false ? '、人体框竖直' : '';
  const valid = cfg.validity?.enabled
    ? `、人框有效（高 ${Math.round(Number(cfg.validity.minHeightRatio ?? 0) * 100)}%~`
      + `${Math.round(Number(cfg.validity.maxHeightRatio ?? 1.5) * 100)}%、出画 ≤`
      + `${Math.round((1 - Number(cfg.validity.minInFrame ?? 0)) * 100)}%）`
    : '';
  return `人体框面积 ≥${pct}% 落在 ROI/设备框内、两肩可见${upright}${valid}，保持 ${hold}ms`;
}

function operatingNeed(cfg, holds) {
  if (!cfg) return ARM_NOTES.operating.need;
  const num = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '?';
    // 至少保留 3 位小数再裁掉末尾 0：0.315 不能被四舍五入成 0.32，90 也不能被裁成 9
    return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  };
  const hold = Number.isFinite(Number(holds?.operating)) ? Number(holds.operating) : 800;
  const gap = Number.isFinite(Number(holds?.operatingMaxGap)) ? Number(holds.operatingMaxGap) : 0;
  return `腕在 ROI/设备框内、腕-肩 >${num(cfg.minReachRoi)}、抬臂角 ${num(cfg.minElev)}°~${num(cfg.maxElev)}°、双肩可见；`
    + `或肘在 ROI/设备框内、肘-肩 >${num(cfg.minElbowReach)}、抬臂角 ${num(cfg.minElbowElev)}°~${num(cfg.maxElev)}°，`
    + `保持 ${hold}ms（允许 ${gap}ms 内短暂遮挡）`;
}

/**
 * 生成动作面板的提示。
 *
 * @param {object} ctx
 * @param {object|null} ctx.sig SignalEngine.update() 的信号（没有画面时为 null）
 * @param {object|null} ctx.act ActionEngine.update() 的结果
 * @param {Array|null} ctx.hands 本帧检出的手（[] 表示开了模型但没检出）
 * @param {boolean} ctx.handOn 手部开关是否打开（show.hands）
 * @param {boolean} ctx.handReady 手部模型是否真的加载好了
 * @param {boolean} ctx.imageMode 是否单帧图片输入（没有时间窗）
 * @param {Record<string,{short:string,long:string}>|null} ctx.accuracyById 动作 id → 准确率文案
 *   （accuracy.js 的 formatAccuracy 输出）。tooltip 里带 long，当前动作的提示行里带 short；
 *   没有报告时是「未评估」，也照样显示——不把「没测过」藏起来。
 * @param {boolean|null} ctx.operatingRoi 当前 profile 是否配置了设备 ROI。
 *   这是静态配置，不能等 sig.armPose.operating_roi（要跑完一帧才有）；
 *   传 null/undefined 时才退回 sig。
 * @param {boolean|null} ctx.objectOn 物体检测开关是否打开；detector-only profile
 *   （没有 ROI、只配 equipmentLabels）下，检测器没开/没就绪同样判不了。
 * @param {boolean|null} ctx.objectReady 物体检测模型是否真的加载好了。
 * @param {object|null} ctx.operatingCfg 当前生效的 signals.arm.operating（profile 可覆盖默认值）
 * @param {object|null} ctx.operatingHolds 当前生效的 actions.holds（含 operating / operatingMaxGap）
 * @param {object|null} ctx.nearEquipmentCfg 当前生效的 signals.arm.nearEquipment
 * @param {object|null} ctx.nearEquipmentHolds 当前生效的 actions.holds（含 nearEquipment）
 * @returns {{
 *   byId: Record<string,{na:boolean, why:string, title:string}>,
 *   line: string,
 *   hands: {state:'off'|'loading'|'none'|'ok', title:string}
 * }}
 */
export function explainArmActions({
  sig = null, act = null, hands = null, handOn = false, handReady = false, imageMode = false,
  accuracyById = null, operatingRoi = null, operatingCfg = null, operatingHolds = null,
  nearEquipmentCfg = null, nearEquipmentHolds = null, objectOn = null, objectReady = null,
} = {}) {
  const handCount = Array.isArray(hands) ? hands.length : 0;
  const hasWorld = !!sig?.armPose?.has_world;
  const worldConfigured = sig?.world?.enabled !== false;
  const lowConfidence = !!sig && !sig.ok;

  // —— 每种动作「当前是否根本判不了」以及原因（只放稳定条件，避免逐帧闪烁）
  const naReason = (id) => {
    const reasons = [];
    if (HAND_ACTIONS.has(id)) {
      if (!handOn) reasons.push('手部模型已关闭');
      else if (!handReady) reasons.push('手部模型未加载');
    }
    // 指向同时依赖手部模型和 3D 方位角：两个原因都要能同时报出来，
    // 不能在第一个分支里 return（否则「手部开着但没 3D」会被当成可用）。
    if (WORLD_ACTIONS.has(id) && sig && !hasWorld) {
      reasons.push(worldConfigured ? '本帧没有 3D world 坐标' : '配置已关闭 3D（world.enabled=false）');
    }
    // 操作设备必须有设备证据：人工 ROI 或设备检测框，两者都没有时才标「不可用」。
    // 只认 ROI 会把 detector-only profile（无 ROI、equipmentLabels 有值）误标成不可用。
    if (id === 'operating' || id === 'near_equipment') {
      // 优先用 profile 的静态配置；没有画面时也能正确标「不可用」
      const roiConfigured = operatingRoi ?? sig?.armPose?.operating_roi;
      const eqConfigured = Array.isArray(operatingCfg?.equipmentLabels)
        && operatingCfg.equipmentLabels.length > 0;
      if (roiConfigured === false && !eqConfigured) {
        reasons.push('未配置设备 ROI/检测框（profile 的 operating.roi / operating.rois 或 equipmentLabels）');
      } else if (roiConfigured !== true && eqConfigured) {
        // 没有 ROI，设备证据只能来自检测框：检测器没开/没加载时同样不可用。
        if (objectOn === false) reasons.push('物体检测已关闭（设备框来源）');
        else if (objectReady === false) reasons.push('物体检测未加载（设备框来源）');
      }
    }
    return reasons.join('；');
  };

  const byId = {};
  for (const a of ARM_ACTIONS) {
    const note = a.id === 'operating'
      ? { ...ARM_NOTES.operating, need: operatingNeed(operatingCfg, operatingHolds) }
      : a.id === 'near_equipment'
        ? { ...ARM_NOTES.near_equipment, need: nearEquipmentNeed(nearEquipmentCfg, nearEquipmentHolds) }
        : ARM_NOTES[a.id];
    const why = naReason(a.id);
    const acc = accuracyById?.[a.id];
    const parts = [`${a.name}（依据：${note.basis}）`, `条件：${note.need}`, `误判/漏判：${note.caveat}`];
    if (acc) parts.push(`准确率：${acc.long || acc.short}`);
    if (why) parts.push(`当前不可用：${why}`);
    byId[a.id] = { na: !!why, why, title: parts.join(' · ') };
  }

  // —— 手部状态：元信息里的「未检出」必须解释清楚，否则会被当成「手是空的」
  const handsInfo = !handOn
    ? { state: 'off', title: '手部模型已关闭：伸手/持物/指向/拿取不判' }
    : !handReady
      ? { state: 'loading', title: '手部模型未加载：伸手/持物/指向/拿取不判' }
      : handCount === 0
        ? { state: 'none', title: '本帧未检出手：手出画/太小/侧对镜头/被遮挡都会这样；伸手/持物/指向/拿取不判（≠手是空的）' }
        : { state: 'ok', title: '手部已检出：伸手/持物/指向/拿取参与判定' };

  // —— 没有画面 / 置信不足：先把结论本身讲清楚，不再谈单个动作
  let line = '';
  if (!sig) {
    line = '';
  } else if (lowConfidence) {
    line = '置信不足（<0.45）：动作判定冻结，先调光线/距离/遮挡';
  } else {
    const activeId = ACTIVE_PRIORITY.find((id) => !!act?.flags?.[ID_TO_FLAG[id]]);
    if (activeId) {
      // 当前有动作亮着：先给实测准确率（来自标注数据），再讲这个动作最可能错在哪。
      // 准确率缺失时 accuracyById 里是「未评估」，照样显示——不把「没测过」藏起来。
      const acc = accuracyById?.[activeId];
      const sideFlags = SIDE_FLAGS[activeId];
      const l = sideFlags ? !!act?.flags?.[sideFlags[0]] : false;
      const r = sideFlags ? !!act?.flags?.[sideFlags[1]] : false;
      const side = l && !r ? '左手' : r && !l ? '右手' : '';
      line = `${side}${NAME[activeId]}：${acc ? `准确率 ${acc.short} · ` : ''}${ARM_NOTES[activeId].caveat}`;
    } else {
      const missing = [];
      if (!handOn) missing.push('手部模型关闭：伸手/持物/指向/拿取不判');
      else if (!handReady) missing.push('手部模型未加载：伸手/持物/指向/拿取不判');
      else if (handCount === 0) missing.push('手未检出：伸手/持物/指向/拿取不判（≠手是空的）');
      if (!hasWorld) missing.push(worldConfigured
        ? '无 3D：指向不可用，举手降级为 2D'
        : '3D 已关闭：指向不可用，举手按 2D 判');
      line = missing.length ? missing.join(' · ') : DEFAULT_HINT;
    }
  }

  return { byId, line, hands: handsInfo };
}
