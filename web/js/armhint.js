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
const WORLD_ACTIONS = new Set(['arm_front', 'arm_side', 'point']);

// 同时亮多个动作时，提示优先给「可信度最低」的那个：
// 指向/持物只有弱证据，挥手比静态动作更容易漏，静态动作放最后。
const ACTIVE_PRIORITY = [
  'point', 'carry', 'wave', 'reach', 'hand_head', 'hips',
  'crossed', 'arms_open', 'both_up', 'arm_raised', 'arm_front', 'arm_side',
];

// 单手动作的逐侧 flag。提示行用它把「举手」说成「左手举手」，
// 而不是只给一个左右不分的聚合标签。双侧同时成立时不加前缀。
const SIDE_FLAGS = {
  arm_raised: ['armRaisedL', 'armRaisedR'],
  wave: ['wavingL', 'wavingR'],
  reach: ['reachingL', 'reachingR'],
  point: ['pointingL', 'pointingR'],
  hand_head: ['handAtHeadL', 'handAtHeadR'],
  carry: ['carryingL', 'carryingR'],
};

export const DEFAULT_HINT = '悬停动作名：查看判定条件与已知误判';

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
 * @returns {{
 *   byId: Record<string,{na:boolean, why:string, title:string}>,
 *   line: string,
 *   hands: {state:'off'|'loading'|'none'|'ok', title:string}
 * }}
 */
export function explainArmActions({
  sig = null, act = null, hands = null, handOn = false, handReady = false, imageMode = false,
  accuracyById = null,
} = {}) {
  const handCount = Array.isArray(hands) ? hands.length : 0;
  const hasWorld = !!sig?.armPose?.has_world;
  const worldConfigured = sig?.world?.enabled !== false;
  const hipVis = sig?.vis?.hip;
  const hipHidden = Number.isFinite(hipVis) && hipVis < 0.3;
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
    if (id === 'wave' && imageMode) reasons.push('单帧图片没有时间窗');
    return reasons.join('；');
  };

  const byId = {};
  for (const a of ARM_ACTIONS) {
    const note = ARM_NOTES[a.id];
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
        ? '无 3D：前/侧平举、指向不可用，举手降级为 2D'
        : '3D 已关闭：前/侧平举、指向不可用，举手按 2D 判');
      if (hipHidden) missing.push('髋不可见：叉腰不判');
      if (imageMode) missing.push('单帧图片：挥手不适用');
      line = missing.length ? missing.join(' · ') : DEFAULT_HINT;
    }
  }

  return { byId, line, hands: handsInfo };
}
