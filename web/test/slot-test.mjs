// slot-test.mjs — 估计器槽位的创建代次（pose.js 的并发保护）
// 运行：node web/test/slot-test.mjs
//
// 用可控 Promise 复现「两次创建并发、完成顺序不同」：旧实现会让后完成的实例
// 覆盖先完成的，且被覆盖的那份没有 close()。槽位必须做到：
//   - 只有最后一次请求的实例留在槽位上；
//   - 被取代的实例一定被 close()；
//   - close() 能作废在途创建。

import { EstimatorSlot, supersededError, isSuperseded } from '../js/slot.js';

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

console.log('[1] 同 key 复用 / 换 key 重建');
{
  const closed = [];
  const slot = new EstimatorSlot({ close: (x) => closed.push(x) });
  let built = 0;
  const make = (id) => async () => { built++; return { id }; };

  const a1 = await slot.acquire('a', make('a1'));
  const a2 = await slot.acquire('a', make('a2'));
  check('同 key 直接复用当前实例', a1 === a2 && built === 1, `built=${built}`);
  check('info 反映当前 key', slot.ready && slot.key === 'a');

  const b1 = await slot.acquire('b', make('b1'));
  check('换 key 建新实例', b1.id === 'b1');
  check('旧实例在新建前关闭一次', closed.length === 1 && closed[0] === a1, closed.map((x) => x.id).join(','));
  check('当前实例换成新 key', slot.current === b1 && slot.key === 'b');
}

console.log('\n[2] 并发创建：后完成的旧请求不能覆盖');
{
  const closed = [];
  const slot = new EstimatorSlot({ close: (x) => closed.push(x) });
  const dA = deferred();
  const dB = deferred();

  const pa = slot.acquire('a', async () => { await dA.promise; return { id: 'a' }; });
  const pb = slot.acquire('b', async () => { await dB.promise; return { id: 'b' }; });

  // B 先完成 → 成为当前实例
  dB.resolve();
  const b = await pb;
  check('后发请求先完成 → 成为当前实例', slot.current === b && slot.key === 'b');

  // A 后完成 → 必须自我释放并报 superseded
  dA.resolve();
  const ra = await settle(pa);
  check('旧请求完成时报 superseded（不当成加载失败）', !ra.ok && isSuperseded(ra.e), ra.ok ? '' : ra.e.message);
  check('旧请求的实例被关闭', closed.length === 1 && closed[0].id === 'a', closed.map((x) => x.id).join(','));
  check('当前实例仍是后发请求', slot.current === b && slot.key === 'b');
}

console.log('\n[3] 并发创建：先完成的旧请求也不能留下');
{
  const closed = [];
  const slot = new EstimatorSlot({ close: (x) => closed.push(x) });
  const dA = deferred();
  const dB = deferred();

  const pa = slot.acquire('a', async () => { await dA.promise; return { id: 'a' }; });
  const pb = slot.acquire('b', async () => { await dB.promise; return { id: 'b' }; });

  dA.resolve();
  const ra = await settle(pa);
  check('先完成但已被取代 → superseded', !ra.ok && isSuperseded(ra.e));
  check('先完成但已被取代 → 实例被关闭', closed.length === 1 && closed[0].id === 'a');
  check('槽位不会短暂装上旧实例', slot.current === null && slot.key === '');

  dB.resolve();
  const b = await pb;
  check('后发请求完成 → 正常安装', slot.current === b && slot.key === 'b');
}

console.log('\n[4] close() 作废在途创建');
{
  const closed = [];
  const slot = new EstimatorSlot({ close: (x) => closed.push(x) });
  const d = deferred();
  const p = slot.acquire('a', async () => { await d.promise; return { id: 'a' }; });

  slot.close();
  d.resolve();
  const r = await settle(p);
  check('关闭后完成的创建报 superseded', !r.ok && isSuperseded(r.e));
  check('关闭后完成的实例被释放，不装进槽位', closed.length === 1 && slot.current === null);
}

console.log('\n[5] 构建失败不污染槽位');
{
  const closed = [];
  const slot = new EstimatorSlot({ close: (x) => closed.push(x) });
  const old = await slot.acquire('a', async () => ({ id: 'old' }));
  const r = await settle(slot.acquire('b', async () => { throw new Error('模型文件缺失'); }));
  check('最新请求的原始错误原样抛出', !r.ok && r.e.message === '模型文件缺失');
  check('失败后槽位为空', !slot.ready && slot.key === '');
  check('失败前旧实例已按旧行为关闭', closed.length === 1 && closed[0] === old);
}

console.log('\n[6] 过期请求的失败不能盖住新请求');
{
  const slot = new EstimatorSlot({ close: () => {} });
  const dA = deferred();
  const dB = deferred();
  const pa = slot.acquire('a', async () => { await dA.promise; throw new Error('a 下载失败'); });
  const pb = slot.acquire('b', async () => { await dB.promise; return { id: 'b' }; });

  dB.resolve();
  const b = await pb;
  dA.reject(new Error('a 下载失败'));
  const ra = await settle(pa);
  check('过期请求失败 → superseded 而不是原始错误', !ra.ok && isSuperseded(ra.e), ra.ok ? '' : ra.e.message);
  check('新请求实例不受影响', slot.current === b && slot.key === 'b');
}

console.log('\n[7] supersededError 标记');
{
  const e = supersededError('x');
  check('supersededError 带 superseded/code', e.superseded === true && e.code === 'estimator_superseded');
  check('普通错误不误判', !isSuperseded(new Error('boom')) && !isSuperseded(null));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
