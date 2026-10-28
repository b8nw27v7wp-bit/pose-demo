// headless-check.mjs — 用无头 Chrome + CDP 实际加载页面，检查 JS 报错与关键状态
// 运行：node web/test/headless-check.mjs [url]
//
// 为什么需要它：单元测试只覆盖纯逻辑，证明不了「页面还能打开、模型还能跑、profile 生效」。
// 这个脚本是 PLAN 里"无头环境不能替代真机"那条限制下，能做到的最强验证：
// 真的起浏览器、真的加载 wasm/model、真的读 window.__pose。

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  const { access } = await import('node:fs/promises');
  for (const p of CHROME_CANDIDATES) {
    try { await access(p); return p; } catch { /* next */ }
  }
  throw new Error('找不到 Chrome/Edge');
}

async function startChrome(bin, port) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pose-chk-'));
  const proc = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    'about:blank',
  ], { stdio: 'ignore' });
  return { proc, profile };
}

async function endpoint(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

/** 极简 CDP 客户端：够用即可，不引第三方依赖 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.sessionId = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /** 等到某个 CDP 事件（带超时） */
  waitFor(method, timeoutMs = 15000) {
    const seen = this.events.findIndex((e) => e.method === method);
    if (seen >= 0) { this.events.splice(seen, 1); return Promise.resolve(); }
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      const tick = setInterval(() => {
        const i = this.events.findIndex((e) => e.method === method);
        if (i >= 0) { this.events.splice(i, 1); clearInterval(tick); clearTimeout(t); resolve(); }
      }, 50);
    });
  }
}

async function main() {
  const url = process.argv[2] || 'http://127.0.0.1:8765/web/?src=/data/pose-test-vp8.webm';
  const port = 9333;

  const bin = await findChrome();
  const { proc, profile } = await startChrome(bin, port);
  const errors = [];
  let code = 0;

  try {
    const wsUrl = await endpoint(port);
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);

    // 浏览器级 endpoint 不能直接 Page.*，必须先 attach 到 page target 拿 sessionId
    const { targetInfos } = await cdp.send('Target.getTargets', {}, null);
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) throw new Error('没有可用的 page target');
    const { sessionId } = await cdp.send('Target.attachToTarget',
      { targetId: page.targetId, flatten: true }, null);
    cdp.sessionId = sessionId;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push(d.exception?.description || d.text);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        const text = m.params.entry.text || '';
        // favicon 404 与页面无关，不计入
        if (!/favicon\.ico/.test(text)) errors.push(text);
      }
    });

    await cdp.send('Page.navigate', { url });
    await cdp.waitFor('Page.loadEventFired', 15000);

    // 等模型加载 + 跑几帧
    for (let i = 0; i < 60; i++) {
      const ready = await cdp.eval('!!(window.__pose && window.__pose.state.frames > 5)');
      if (ready) break;
      await sleep(500);
    }

    const state = await cdp.eval(`(() => {
      const s = window.__pose ? window.__pose.state : null;
      const f = window.__pose ? window.__pose.lastFrame : null;
      return {
        hasApi: !!window.__pose,
        estimatorReady: s && s.estimatorReady,
        frames: s && s.frames,
        fps: s && s.fps,
        posture: f && f.actions && f.actions.posture,
        kpCount: f && f.persons[0] ? f.persons[0].kp.length : 0,
        scale: f && f.persons[0] ? f.persons[0].scale : null,
      };
    })()`);

    const profileEcho = await cdp.eval(`(() => {
      const el = document.getElementById('status');
      return el ? el.textContent : null;
    })()`);

    console.log('页面状态：', JSON.stringify(state, null, 2));
    console.log('状态栏：', profileEcho);
    console.log('JS 错误：', errors.length ? errors : '无');

    const ok = state.hasApi && state.estimatorReady && state.frames > 5
      && state.kpCount === 13 && errors.length === 0;
    console.log(ok ? '\n结果：通过' : '\n结果：失败');
    code = ok ? 0 : 1;
    ws.close();
  } finally {
    proc.kill();
    await sleep(500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  return code;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(String(e && e.stack || e));
  process.exit(1);
});
