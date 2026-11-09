// headless-multi.mjs — 多人 + 物体检测的端到端检查（真浏览器、真模型、真视频）
// 运行：node web/test/headless-multi.mjs [url]
// 默认用双人视频 data/pose-test-two.webm；serve.py 必须已在运行的那个端口上。
//
// 单测（multi-test.mjs）证明的是"逻辑按写的跑"；这个脚本证明的是
// "页面能打开、多人模型能建、视频里真的出现两条轨迹、物体检测能出框、零 JS 报错"。

import { openPage, sleep } from './cdp.mjs';

const URL_DEFAULT = 'http://127.0.0.1:8765/web/?src=/data/pose-test-two.webm';
const url = process.argv[2] || URL_DEFAULT;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const stateOf = `(() => {
  const s = window.__pose ? window.__pose.state : null;
  if (!s) return null;
  const verdicts = (s.lastResult && s.lastResult.verdicts) || [];
  return {
    estimatorReady: s.estimatorReady,
    frames: s.frames,
    multiOn: s.multiOn, multiReady: s.multiReady, multiError: s.multiError,
    objectOn: s.objectOn, objectReady: s.objectReady, objectError: s.objectError,
    tracks: s.tracks, pipes: s.pipes, verdicts: s.verdicts,
    objects: s.objects,
    posture: verdicts[0] && verdicts[0].act ? verdicts[0].act.postureId : null,
    ids: verdicts.map((v) => v.track_id),
    ppe: verdicts.map((v) => v.ppe ? { hat: v.ppe.helmet.state, hatAlert: v.ppe.helmet.alert, glove: v.ppe.glove.state } : null),
  };
})()`;

async function waitFor(cdp, expr, { timeout = 25000, label = '' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await cdp.eval(expr)) return true;
    await sleep(300);
  }
  if (label) console.log(`  ..  等待超时：${label}`);
  return false;
}

const { cdp, errors, close } = await openPage(url);

try {
  console.log(`\n[1] 默认（单人）路径 — ${url}`);
  const ready = await waitFor(cdp, 'window.__pose && window.__pose.state.frames > 20', {
    label: '模型就绪并跑满 20 帧',
  });
  check('模型就绪且跑满 20 帧', ready);
  const s0 = await cdp.eval(stateOf);
  check('默认多人关闭', s0 && s0.multiOn === false);
  check('默认物体检测关闭', s0 && s0.objectOn === false);
  check('单人道只产生一条判定', s0 && s0.verdicts === 1, `verdicts=${s0 && s0.verdicts}`);
  check('单人道 track_id 固定 0（不随检出顺序分叉）',
    !!(s0 && s0.ids.length === 1 && s0.ids[0] === 0), `ids=${s0 && s0.ids}`);
  check('单人道主目标有姿态判定', !!(s0 && s0.posture), `posture=${s0 && s0.posture}`);

  console.log('\n[2] 打开多人');
  await cdp.eval(`(() => {
    const el = document.getElementById('chkMulti');
    el.checked = true;
    el.dispatchEvent(new Event('change'));
    return true;
  })()`);
  // 素材只有 3 秒，等模型就绪 + 建多人估计器的时间里视频基本已经播完；
  // 播完后主循环不再出帧，tracks 会永远是 0。无条件重播一次再等轨迹
  // （重播会清空记录/跟踪器，之后重新检测；真机上换档后用户也要重播才能看到效果）。
  await cdp.eval(`(() => { document.getElementById('btnReplay').click(); return true; })()`);
  const multiOk = await waitFor(cdp,
    'window.__pose && window.__pose.state.multiReady && window.__pose.state.tracks > 0',
    { label: '多人模型加载并产生轨迹' });
  check('多人模型加载成功', multiOk);
  const s1 = await cdp.eval(stateOf);
  if (s1 && s1.multiError) console.log(`  ..  multiError=${s1.multiError}`);
  check('双人视频里至少 1 条轨迹', s1 && s1.tracks >= 1, `tracks=${s1 && s1.tracks}`);
  // 双人素材的两条轨迹：IMAGE 模式实测能返回 2 个人（VIDEO 模式恒为 1）
  const sawTwo = await waitFor(cdp,
    '(() => { const s = window.__pose && window.__pose.state; return !!(s && s.tracks >= 2); })()',
    { timeout: 15000, label: '出现第二条轨迹' });
  const s2 = await cdp.eval(stateOf);
  check('双人视频里出现 2 条轨迹', sawTwo && s2.tracks >= 2, `tracks=${s2 && s2.tracks}`);
  check('多人时每人一条独立判定', s2 && s2.verdicts >= 2, `verdicts=${s2 && s2.verdicts} ids=${s2 && s2.ids}`);
  check('每人一条流水线', s2 && s2.pipes >= 2, `pipes=${s2 && s2.pipes}`);

  console.log('\n[2b] 切到未声明感知开关的 profile');
  // 默认/健身档没有 perception 键。不能因为 resolveParams 补了 enabled=false
  // 就把用户手动打开的多人/物体静默关掉（启动时恢复的设置同理会丢）。
  await cdp.eval(`(() => {
    const el = document.getElementById('profileSel');
    el.value = 'default';
    el.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(1000);
  const s2b = await cdp.eval(stateOf);
  check('未声明 perception 的 profile 不清掉手动打开的多人',
    !!(s2b && s2b.multiOn && s2b.multiReady), `multi=${s2b && s2b.multiOn}/${s2b && s2b.multiReady}`);

  console.log('\n[3] 打开物体检测');
  // 素材只有 3 秒，前面的等待早就播完了；主循环在文件模式里发现 currentTime 没变就不再推理。
  // 重播一次，否则物体检测永远等不到帧（这不是检测器的问题）。
  await cdp.eval(`(() => { document.getElementById('btnReplay').click(); return true; })()`);
  await sleep(600);
  await cdp.eval(`(() => {
    const el = document.getElementById('chkObjects');
    el.checked = true;
    el.dispatchEvent(new Event('change'));
    return true;
  })()`);
  const objOk = await waitFor(cdp,
    '(() => { const s = window.__pose && window.__pose.state; return !!(s && (s.objectReady || s.objectError)); })()',
    { timeout: 25000, label: '物体检测器就绪或报错' });
  const s3 = await cdp.eval(stateOf);
  check('物体检测器就绪（模型可加载）', objOk && s3.objectReady, s3 && (s3.objectError || 'ready'));
  if (s3 && s3.objectReady) {
    const gotBoxes = await waitFor(cdp,
      '(() => { const s = window.__pose && window.__pose.state; return !!(s && s.objects > 0); })()',
      { timeout: 15000, label: '检测出至少一个框' });
    const s4 = await cdp.eval(stateOf);
    check('画面里检出物体（COCO 类别）', gotBoxes && s4.objects > 0, `objects=${s4 && s4.objects}`);
    const labels = await cdp.eval(`(() => {
      const s = window.__pose && window.__pose.state;
      const o = (s && s.lastResult && s.lastResult.objects) || [];
      return [...new Set(o.map((x) => x.label || ('#' + x.category)))];
    })()`);
    console.log(`  ..  检出的类别：${labels.join(', ') || '（无 label map）'}`);
    const ppe = await cdp.eval(`(() => {
      const s = window.__pose && window.__pose.state;
      const v = (s && s.lastResult && s.lastResult.verdicts) || [];
      return v.map((x) => x.ppe ? x.ppe.helmet.state : 'no-ppe');
    })()`);
    check('PPE 状态已产出（应为 unknown：COCO 无安全帽类别）',
      ppe.length > 0 && ppe.every((x) => x === 'unknown' || x === 'no-ppe'), ppe.join(','));
  }

  console.log('\n[4] 恢复单人');
  await cdp.eval(`(() => {
    const el = document.getElementById('chkMulti');
    el.checked = false;
    el.dispatchEvent(new Event('change'));
    return true;
  })()`);
  const backOk = await waitFor(cdp,
    '(() => { const s = window.__pose && window.__pose.state; return !!(s && !s.multiOn && s.verdicts <= 1); })()',
    { timeout: 12000, label: '回到单人' });
  check('关掉多人后回到单人道', backOk);

  console.log('\n[5] 切到 safety profile（开关由 profile 带起）');
  await cdp.eval(`(() => { document.getElementById('btnReplay').click(); return true; })()`);
  await sleep(500);
  await cdp.eval(`(() => {
    const el = document.getElementById('profileSel');
    el.value = 'safety';
    el.dispatchEvent(new Event('change'));
    return true;
  })()`);
  const profOk = await waitFor(cdp,
    '(() => { const s = window.__pose && window.__pose.state; return !!(s && s.multiOn && s.objectOn && s.multiReady && s.objectReady); })()',
    { timeout: 30000, label: 'profile 带起多人+物体检测' });
  const s5 = await cdp.eval(stateOf);
  check('profile 里声明的多人/物体开关自动生效', profOk, `multi=${s5 && s5.multiOn}/${s5 && s5.multiReady} obj=${s5 && s5.objectOn}/${s5 && s5.objectReady}`);
  // 素材只有 3 秒：模型建好后视频早已播完，必须边重播边等，否则读到的是最后一帧（可能只有 1 人）
  let rep = false;
  for (let i = 0; i < 10 && !rep; i++) {
    await cdp.eval(`(() => { const b = document.getElementById('btnReplay'); if (b) b.click(); return true; })()`);
    await sleep(1200);
    rep = await cdp.eval('(() => { const s = window.__pose && window.__pose.state; return !!(s && s.verdicts >= 2 && s.objects > 0); })()');
  }
  const s6 = await cdp.eval(stateOf);
  check('safety 档：多人判定 + 物体框同时成立', rep, `verdicts=${s6 && s6.verdicts} objects=${s6 && s6.objects}`);

  console.log('\n[6] JS 错误');
  const fatal = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check('无 JS 异常', fatal.length === 0, fatal.slice(0, 3).join(' | '));
} finally {
  await close();
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
