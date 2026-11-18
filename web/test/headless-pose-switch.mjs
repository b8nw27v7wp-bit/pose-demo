// headless-pose-switch.mjs — 姿态估计器并发创建（C4）的浏览器级回归
// 运行：node scripts/py.mjs serve.py 8799
//       node web/test/headless-pose-switch.mjs "http://127.0.0.1:8799/web/"
//
// 纯函数单测（slot-test.mjs）验证代次逻辑本身；这里验证 pose.js 真的接上了：
// 连续两次 createEstimator / createMultiEstimator，先发的必须自我释放并报 superseded，
// 最终槽位是最后一次请求的模型，且没有 JS 异常。

import { openPage } from './cdp.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8765/web/';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const { cdp, errors, close } = await openPage(url);

try {
  console.log(`\n[1] 单人估计器：full → lite 并发创建 — ${url}`);
  const single = await cdp.eval(`(async () => {
    const m = await import('/web/js/pose.js');
    m.closeEstimator();
    const t0 = performance.now();
    const p1 = m.createEstimator({ model: 'full', delegate: 'CPU', runningMode: 'VIDEO', numPoses: 1 });
    const p2 = m.createEstimator({ model: 'lite', delegate: 'CPU', runningMode: 'VIDEO', numPoses: 1 });
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    const info = m.estimatorInfo();
    m.closeEstimator();
    return {
      ms: Math.round(performance.now() - t0),
      first: r1.status === 'rejected' ? {
        superseded: m.isSuperseded(r1.reason), message: r1.reason && r1.reason.message,
      } : { superseded: false },
      second: r2.status,
      info,
      closedReady: m.estimatorInfo().ready,
    };
  })()`);
  check('先发请求被取代（superseded，不是加载失败）', single.first.superseded, single.first.message);
  check('后发请求创建成功', single.second === 'fulfilled');
  check('最终槽位是后发模型 lite', /^lite\\|CPU\\|/.test(single.info.key), `key=${single.info.key}`);
  check('closeEstimator 后槽位为空', single.closedReady === false);
  console.log(`  ..  用时 ${single.ms}ms`);

  console.log('\n[2] 多人估计器：full → lite 并发创建');
  const multi = await cdp.eval(`(async () => {
    const m = await import('/web/js/pose.js');
    m.closeMultiEstimator();
    const p1 = m.createMultiEstimator({ model: 'full', delegate: 'CPU', numPoses: 3 });
    const p2 = m.createMultiEstimator({ model: 'lite', delegate: 'CPU', numPoses: 3 });
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    const info = m.multiEstimatorInfo();
    m.closeMultiEstimator();
    return {
      first: r1.status === 'rejected' ? {
        superseded: m.isSuperseded(r1.reason), message: r1.reason && r1.reason.message,
      } : { superseded: false },
      second: r2.status,
      info,
      closedReady: m.multiEstimatorInfo().ready,
    };
  })()`);
  check('先发多人请求被取代', multi.first.superseded, multi.first.message);
  check('后发多人请求创建成功', multi.second === 'fulfilled');
  check('最终多人槽位是 lite', /^lite\\|CPU\\|/.test(multi.info.key), `key=${multi.info.key}`);
  check('closeMultiEstimator 后槽位为空', multi.closedReady === false);

  console.log('\n[3] 在途创建时关闭：不能再安装到槽位');
  const closed = await cdp.eval(`(async () => {
    const m = await import('/web/js/pose.js');
    m.closeEstimator();
    const p = m.createEstimator({ model: 'lite', delegate: 'CPU', runningMode: 'VIDEO', numPoses: 1 });
    m.closeEstimator();
    const r = await Promise.allSettled([p]);
    return {
      rejected: r[0].status === 'rejected',
      superseded: r[0].status === 'rejected' && m.isSuperseded(r[0].reason),
      ready: m.estimatorInfo().ready,
      key: m.estimatorInfo().key,
    };
  })()`);
  check('关闭后在途创建报 superseded', closed.rejected && closed.superseded);
  check('槽位保持为空、没有残留 key', closed.ready === false && closed.key === '');

  console.log('\n[4] JS 错误');
  const fatal = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check('无 JS 异常', fatal.length === 0, fatal.slice(0, 3).join(' | '));
} finally {
  await close();
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
