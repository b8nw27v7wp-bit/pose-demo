// cdp.mjs — 无头 Chrome 的最小 CDP 工具（起浏览器、attach、eval、收 JS 错误）
//
// headless-check.mjs 里原本内联了这一套；多人/物体检测的端到端检查（headless-multi.mjs）
// 需要同一套能力，所以抽到这里。headless-check 暂不改造，避免动到已经稳定的回归脚本。

import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function findChrome() {
  const { access } = await import('node:fs/promises');
  for (const p of CHROME_CANDIDATES) {
    try { await access(p); return p; } catch { /* next */ }
  }
  throw new Error('找不到 Chrome/Edge');
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startChrome(bin, port) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pose-multi-'));
  const proc = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    // 无头默认禁止自动播放：?src= 自动加载的视频会停在 readyState=3 不播，
    // 采样就全是 0 帧（比"页面挂了"更难查）。
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });
  return { proc, profile };
}

async function endpoint(port, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

export class CDP {
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

  /** 等一个 CDP 事件。返回 true=等到，false=超时（超时不再静默成功）。 */
  waitFor(method, timeoutMs = 15000) {
    const seen = this.events.findIndex((e) => e.method === method);
    if (seen >= 0) { this.events.splice(seen, 1); return Promise.resolve(true); }
    return new Promise((resolve) => {
      const t = setTimeout(() => { clearInterval(tick); resolve(false); }, timeoutMs);
      const tick = setInterval(() => {
        const i = this.events.findIndex((e) => e.method === method);
        if (i >= 0) { this.events.splice(i, 1); clearInterval(tick); clearTimeout(t); resolve(true); }
      }, 50);
    });
  }
}

/** 起浏览器 → attach 到页面 → 开 Runtime/Log → 返回 {cdp, errors, close} */
export async function openPage(url, { width = 1440, height = 900 } = {}) {
  const port = await freePort();
  const bin = await findChrome();
  const { proc, profile } = await startChrome(bin, port);
  const errors = [];
  const wsUrl = await endpoint(port);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);

  const { targetInfos } = await cdp.send('Target.getTargets', {}, null);
  const page = targetInfos.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, null);
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
      if (!/favicon\.ico/.test(text)) errors.push(text);
    }
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  // 导航失败必须当场报出来：否则页面停在 about:blank，后续 localStorage / __pose
  // 全部抛 SecurityError，看起来像应用坏了（实测 pose-screenshots 0/5 就是服务没起）。
  const nav = await cdp.send('Page.navigate', { url });
  if (nav?.errorText) {
    throw new Error(`无法打开 ${url}：${nav.errorText}（本地服务没起来？先运行 npm run serve）`);
  }
  if (!(await cdp.waitFor('Page.loadEventFired', 20000))) {
    throw new Error(`等待 ${url} 加载超时`);
  }
  const hasApp = await cdp.eval('typeof window.__pose !== "undefined"').catch(() => false);
  if (!hasApp) {
    throw new Error(`页面已打开但没有 __pose（${url}）：确认 http 服务的根目录是仓库根目录（npm run serve）`);
  }

  const close = async () => {
    try { ws.close(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    const { rm } = await import('node:fs/promises');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  return { cdp, errors, close };
}
