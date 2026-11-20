// headpose-test.mjs — 头部朝向（yaw/pitch/roll）纯函数自测
// 运行：node web/test/headpose-test.mjs

import {
  headPose, headDirection, headPoseText, HEAD_DIR_LABELS, DirectionHold, headDirWord,
} from '../js/headpose.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (v, target, tol) => Number.isFinite(v) && Math.abs(v - target) <= tol;

// 9 点顺序：0 鼻；1~3 左眼；4~6 右眼；7 左耳；8 右耳。
// 注意左右眼坐标要按 MediaPipe 的**解剖**含义：受试者左眼在原始图右侧（x 更大）。
// 旧测试把 EYE_L 放画面左侧，等于埋了一个镜像约定，测不出镜像/符号问题。
function head2d({
  nose = [100, 89], eyeL = [110, 80], eyeR = [90, 80],
  earL = [130, 85], earR = [70, 85],
  noseVis = 1, eyeVis = 1, earVis = 1,
} = {}) {
  return [
    [nose[0], nose[1], noseVis],
    [eyeL[0], eyeL[1], eyeVis], [eyeL[0], eyeL[1], eyeVis], [eyeL[0], eyeL[1], eyeVis],
    [eyeR[0], eyeR[1], eyeVis], [eyeR[0], eyeR[1], eyeVis], [eyeR[0], eyeR[1], eyeVis],
    [earL[0], earL[1], earVis], [earR[0], earR[1], earVis],
  ];
}

function world33({
  nose = [0, 0.02, -0.06], eyeL = [0.03, 0, 0], eyeR = [-0.03, 0, 0],
  earL = [0.08, 0, 0.05], earR = [-0.08, 0, 0.05],
} = {}) {
  const w = Array.from({ length: 33 }, () => [0, 0, 0]);
  w[0] = nose;
  w[1] = eyeL; w[2] = eyeL; w[3] = eyeL;
  w[4] = eyeR; w[5] = eyeR; w[6] = eyeR;
  w[7] = earL; w[8] = earR;
  return w;
}

const cfg = { visMin: 0.3, minPoints: 2 };

console.log('\n[1] 2D 正前');
{
  const h = headPose(head2d(), null, cfg);
  check('可见且 9 点', h.visible && h.points === 9);
  check('眼对像素距离 = face_px', near(h.face_px, 20, 0.01), String(h.face_px));
  check('yaw≈0', near(h.yaw_2d, 0, 0.02), String(h.yaw_2d));
  check('pitch_2d≈0', near(h.pitch_2d, 0, 0.02), String(h.pitch_2d));
  check('roll≈0', near(h.roll_2d, 0, 1), String(h.roll_2d));
  check('2D 源 + 近似标记', h.source === '2d' && h.yaw_source === '2d'
    && h.yaw_approx === true && h.pitch_approx === true);
  check('三轴幅度可信', h.reliable.yaw && h.reliable.pitch && h.reliable.roll);
  const d = headDirection(h, {}, cfg);
  check('方向=正前', d.dir === 'front', JSON.stringify(d));
}

console.log('\n[2] 2D 受试者向右 / 向左（+x 是受试者左侧）');
{
  const right = headPose(head2d({ nose: [95, 89] }), null, cfg);
  check('鼻偏向受试者右侧（画面左）→ yaw>0', right.yaw > 20, String(right.yaw));
  check('方向=右', headDirection(right, {}, cfg).dir === 'right');
  const left = headPose(head2d({ nose: [105, 89] }), null, cfg);
  check('鼻偏向受试者左侧（画面右）→ yaw<0', left.yaw < -20, String(left.yaw));
  check('方向=左', headDirection(left, {}, cfg).dir === 'left');
}

console.log('\n[3] 2D 侧倾（受试者左侧更低）');
{
  const h = headPose(head2d({ eyeL: [110, 84], eyeR: [90, 76], earL: [130, 89], earR: [70, 81] }), null, cfg);
  check('左眼更低 → roll>2', h.roll_2d > 2, String(h.roll_2d));
}

console.log('\n[4] 2D 默认（world 在也不用）+ 3D 显式开关');
{
  const d2 = headPose(head2d(), world33(), cfg);
  check('默认 source=2d（Pose world 面部点噪声大）', d2.source === '2d', d2.source);
  check('2D yaw/pitch 标近似', d2.yaw_approx === true && d2.pitch_approx === true);
  const h = headPose(head2d(), world33(), { ...cfg, use3d: true });
  check('source=3d', h.source === '3d', h.source);
  check('yaw≈0', near(h.yaw, 0, 1), String(h.yaw));
  check('pitch≈0', near(h.pitch, 0, 1), String(h.pitch));
  check('roll≈0', near(h.roll, 0, 1), String(h.roll));
  check('3D 不标近似', h.yaw_approx === false && h.pitch_approx === false);
  // 诊断字段：开了 use3d 才有 3D 候选值；默认 2D 时保持 null（不拿 3D 值冒充）。
  check('3D 候选值写入 yaw_3d/pitch_3d/roll_3d（默认 2D 时仍为 null）',
    near(h.yaw_3d, 0, 1) && near(h.pitch_3d, 0, 1) && near(h.roll_3d, 0, 1)
    && d2.yaw_3d === null && d2.pitch_3d === null && d2.roll_3d === null,
    `${h.yaw_3d}/${h.pitch_3d}/${h.roll_3d}`);
}

console.log('\n[5] 3D 受试者向右 / 向左（刚性转头）');
{
  // 真人转头是刚体旋转：眼/耳/鼻一起绕竖直轴转。只看「鼻子相对眼线的偏移」时这个量
  // 在刚体旋转下不变（旧实现因此恒为 0）；必须取头自身左右轴相对相机像平面的转角。
  const rigid = (deg) => {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a); const s = Math.sin(a);
    const r = (p) => [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
    return {
      nose: r([0, 0.02, -0.06]), eyeL: r([0.03, 0, 0]), eyeR: r([-0.03, 0, 0]),
      earL: r([0.08, 0, 0.05]), earR: r([-0.08, 0, 0.05]),
    };
  };
  const right = headPose(head2d(), world33(rigid(30)), { ...cfg, use3d: true });
  check('刚体右转 30° → yaw≈30', near(right.yaw, 30, 1), String(right.yaw));
  check('方向=右', headDirection(right, {}, cfg).dir === 'right');
  const left = headPose(head2d(), world33(rigid(-30)), { ...cfg, use3d: true });
  check('刚体左转 30° → yaw≈-30', near(left.yaw, -30, 1), String(left.yaw));
  check('方向=左', headDirection(left, {}, cfg).dir === 'left');
  // 反向回归：只挪鼻点、眼/耳不动不是转头，yaw 不应跟着变（旧实现会给出 ±26°）。
  const noseOnly = headPose(head2d(), world33({ nose: [-0.03, 0.02, -0.06] }), { ...cfg, use3d: true });
  check('只挪鼻点（非刚体）不产生 yaw', near(noseOnly.yaw, 0, 1), String(noseOnly.yaw));
}

console.log('\n[6] 3D 低头 / 抬头（耳相对眼抬高/降低）');
{
  const down = headPose(head2d(), world33({ earL: [0.08, -0.03, 0.05], earR: [-0.08, -0.03, 0.05] }), { ...cfg, use3d: true });
  check('耳高于眼 → pitch>20°', down.pitch > 20, String(down.pitch));
  check('方向=下', headDirection(down, {}, cfg).dir === 'down');
  const up = headPose(head2d(), world33({ earL: [0.08, 0.03, 0.05], earR: [-0.08, 0.03, 0.05] }), { ...cfg, use3d: true });
  check('耳低于眼 → pitch<-20°', up.pitch < -20, String(up.pitch));
  check('方向=上', headDirection(up, {}, cfg).dir === 'up');
}

console.log('\n[7] 3D 侧倾');
{
  const h = headPose(head2d(), world33({
    eyeL: [0.03, 0.01, 0], eyeR: [-0.03, 0, 0],
    earL: [0.08, 0.01, 0.05], earR: [-0.08, 0, 0.05],
  }), { ...cfg, use3d: true });
  check('左侧更低 → roll>2', h.roll > 2, String(h.roll));
}

console.log('\n[8] 头部点部分可见');
{
  const noNose = headPose(head2d({ noseVis: 0 }), world33(), { ...cfg, use3d: true });
  check('只缺鼻：仍可见', noNose.visible && noNose.points === 8);
  check('yaw 为 null（缺鼻不能定左右）', noNose.yaw === null);
  check('pitch/roll 仍可用（3D 眼-耳几何不依赖鼻）',
    Number.isFinite(noNose.pitch) && Number.isFinite(noNose.roll));
  check('原因含 no_nose', noNose.reasons.includes('no_nose'));
  const oneEye = head2d();
  oneEye[4][2] = 0; oneEye[5][2] = 0; oneEye[6][2] = 0; oneEye[7][2] = 0; oneEye[8][2] = 0;
  const h2 = headPose(oneEye, null, cfg);
  check('只有单侧眼 → 没有 face pair', h2.pair === null && h2.reasons.includes('no_face_pair'));
  const empty = headPose([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], null, cfg);
  check('全部不可见 → visible=false', !empty.visible && empty.points === 0);
}

console.log('\n[9] 尺度门：远处小脸不给角度');
{
  const tiny = head2d({
    nose: [100, 81], eyeL: [101, 80], eyeR: [99, 80], earL: [103, 85], earR: [97, 85],
  });
  const h = headPose(tiny, null, cfg);
  check('face_px=2', near(h.face_px, 2, 0.01), String(h.face_px));
  check('三轴都为 null', h.yaw === null && h.pitch === null && h.roll === null);
  check('原因含 face_too_small', h.reasons.includes('face_too_small'));
  check('置信压到 ≤0.25', h.confidence <= 0.25, String(h.confidence));
  check('逐轴 reliable=false', !h.reliable.yaw && !h.reliable.pitch && !h.reliable.roll);
  check('方向层不绕过门控（source_yaw=null 时不看原始 yaw_2d）',
    headDirection(h, {}, cfg).dir === null);
}

console.log('\n[10] 鼻-眼几何门：鼻点离脸太远');
{
  const h = headPose(head2d({ nose: [100, 140] }), null, cfg);
  check('drop 3.0 超出范围 → 三轴都为 null',
    h.yaw === null && h.pitch === null && h.roll === null);
  check('原因含 nose_geometry', h.reasons.includes('nose_geometry'));
  const ok = headPose(head2d({ nose: [100, 100] }), null, cfg);
  check('drop 1.0 仍在范围内（低头）', Number.isFinite(ok.pitch) && ok.pitch > 0, String(ok.pitch));
}

console.log('\n[11] 眼对/耳对 yaw 不一致门');
{
  // 眼对给 +30°，耳中点被拉到鼻子左侧后耳对给 -90°：两个线索互相矛盾 → 样本不可信。
  const asym = head2d({ nose: [95, 89], earL: [100, 85], earR: [80, 85] });
  const h = headPose(asym, null, cfg);
  check('yaw 置 null', h.yaw === null);
  check('原因含 pair_disagree', h.reasons.includes('pair_disagree'));
  check('pitch/roll 不受影响', Number.isFinite(h.pitch) && Number.isFinite(h.roll));
}

console.log('\n[12] roll 上限门');
{
  const rolled = head2d({
    eyeL: [110, 150], eyeR: [90, 60], earL: [130, 150], earR: [70, 60], nose: [100, 105],
  });
  const h = headPose(rolled, null, cfg);
  check('|roll| 77° → roll=null', h.roll === null, String(h.roll));
  check('原因含 roll_extreme', h.reasons.includes('roll_extreme'));
}

console.log('\n[13] 缺 visibility 的旧数据');
{
  const noVis = head2d().map(([x, y]) => [x, y]);
  const h = headPose(noVis, null, cfg);
  check('按可见处理，仍能出角度', h.visible && Number.isFinite(h.yaw));
  check('原因含 visibility_missing', h.reasons.includes('visibility_missing'));
  const h3 = headPose(noVis, world33(), { ...cfg, use3d: true });
  check('2D/3D 缺 visibility 口径一致（都按可见）',
    h3.visible && Number.isFinite(h3.yaw) && h3.yaw_source === '3d');
}

console.log('\n[14] 耳对回退：只给粗略 yaw，不给 pitch');
{
  const earOnly = head2d({ nose: [95, 89] });
  for (let i = 1; i <= 6; i++) earOnly[i][2] = 0;
  const h = headPose(earOnly, null, cfg);
  check('pair=ears', h.pair === 'ears');
  check('yaw 用 2d_ear 源', h.yaw_source === '2d_ear' && h.yaw_approx === true);
  check('yaw 幅度接近眼对（几何增益）', h.yaw > 20, String(h.yaw));
  check('方向=右', headDirection(h, {}, cfg).dir === 'right');
  check('pitch 为 null（2D 耳对没有 pitch 基线）', h.pitch === null);
  check('reliable.yaw=false（只是粗略方向）', h.reliable.yaw === false);
  check('原因含 no_eye_geometry', h.reasons.includes('no_eye_geometry'));
}

console.log('\n[15] 方向滞回 + 2D/3D 阈值分开');
{
  const c = { yawEnter: 15, yawExit: 8 };
  check('已向右，10° 保持右', headDirection({ yaw: 10, source_yaw: '3d' }, { yawDir: 'right' }, c).yawDir === 'right');
  check('已向右，5° 回正前', headDirection({ yaw: 5, source_yaw: '3d' }, { yawDir: 'right' }, c).yawDir === 'front');
  check('已向右，-16° 切左', headDirection({ yaw: -16, source_yaw: '3d' }, { yawDir: 'right' }, c).yawDir === 'left');
  check('已向左，-10° 保持左', headDirection({ yaw: -10, source_yaw: '3d' }, { yawDir: 'left' }, c).yawDir === 'left');
  const both = headDirection({ yaw: 30, pitch: 20, source_yaw: '3d', source_pitch: '3d' }, {}, {});
  check('组合方向=right_down', both.dir === 'right_down', JSON.stringify(both));

  // 2D 阈值用原始归一化量：sin(16.26°)=0.28 < 0.3 → front；
  // 同一角度按 3D 度数阈值 15° → right。旧代码的 2D 阈值是死代码，这里锁住行为。
  check('2D raw 0.28 < 0.3 → 正前', headDirection({ yaw: 16.26, source_yaw: '2d' }, {}, {}).yawDir === 'front');
  check('3D 16.26° > 15° → 右', headDirection({ yaw: 16.26, source_yaw: '3d' }, {}, {}).yawDir === 'right');
  check('缺 source 时按旧行为（度数）', headDirection({ yaw: 16.26 }, {}, {}).yawDir === 'right');
  check('旧调用只有 yaw_2d 时仍可判方向',
    headDirection({ yaw_2d: 0.5 }, {}, {}).yawDir === 'right');
  // pitch：11.5° → raw 0.2556 > 0.25 → down；3D 度数 11.5 < 12 → front。
  check('2D pitch raw 0.256 > 0.25 → 下', headDirection({ pitch: 11.5, source_pitch: '2d' }, {}, {}).pitchDir === 'down');
  check('3D pitch 11.5° < 12° → 正前', headDirection({ pitch: 11.5, source_pitch: '3d' }, {}, {}).pitchDir === 'front');
}

console.log('\n[16] UI 文案');
{
  check('方向中文表完整', HEAD_DIR_LABELS.front === '正前' && HEAD_DIR_LABELS.right_down === '右下');
  const front = headPose(head2d(), null, cfg);
  check('可见文案带方向与点数', /正前/.test(headPoseText({ ...front, ...headDirection(front, {}, cfg) })));
  const right = headPose(head2d({ nose: [95, 89] }), null, cfg);
  const text = headPoseText({ ...right, ...headDirection(right, {}, cfg) });
  check('2D yaw 文案用受试者方向并标≈', /头向右≈/.test(text), text);
  check('不可见文案', headPoseText(headPose(null, null, cfg)) === '头部不可见');
  const tiny = headPose(head2d({
    nose: [100, 81], eyeL: [101, 80], eyeR: [99, 80], earL: [103, 85], earR: [97, 85],
  }), null, cfg);
  check('小脸文案', headPoseText({ ...tiny, dir: null }) === '头部太小/太远');
  const bad = headPose(head2d({ nose: [100, 140] }), null, cfg);
  check('几何不可用文案', /头部几何不可用/.test(headPoseText({ ...bad, dir: null })));
}

console.log('\n[17] 方向去抖');
{
  const h = new DirectionHold();
  check('首次获得方向立即生效', h.update('yaw', 'right', 0, 200) === 'right');
  check('候选变化先保持旧方向', h.update('yaw', 'left', 0.100, 200) === 'right');
  check('稳定不足 200ms 仍保持', h.update('yaw', 'left', 0.250, 200) === 'right');
  check('稳定满 200ms 才切换', h.update('yaw', 'left', 0.310, 200) === 'left');
  check('丢失方向也先保持', h.update('yaw', null, 0.400, 200) === 'left');
  check('丢失满 200ms 后置 null', h.update('yaw', null, 0.610, 200) === null);
  const off = new DirectionHold();
  check('holdMs=0 时立即切换',
    off.update('yaw', 'right', 0, 0) === 'right' && off.update('yaw', 'left', 0.010, 0) === 'left');
  h.reset();
  check('reset 后重新立即生效', h.update('yaw', 'left', 1.000, 200) === 'left');
}

console.log('\n[方向词：单轴不可用不拼 null]');
{
  // yaw 因 pair_disagree 被置空但 pitch 有效时，旧实现返回 'null_down'，
  // 导出/UI 都会原样显示「头部 null_down」。
  check('yaw=null、pitch=down → down', headDirWord(null, 'down') === 'down',
    String(headDirWord(null, 'down')));
  check('pitch=null、yaw=left → left', headDirWord('left', null) === 'left');
  check('两轴都 null → null', headDirWord(null, null) === null);
  check('合法组合保持不变',
    headDirWord('right', 'down') === 'right_down' && headDirWord('front', 'up') === 'up'
    && headDirWord('front', 'front') === 'front');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
