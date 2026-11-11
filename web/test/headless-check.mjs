// headless-check.mjs — 用无头 Chrome + CDP 实际加载页面，检查 JS 报错与关键状态
// 运行：node web/test/headless-check.mjs [url]
//
// 为什么需要它：单元测试只覆盖纯逻辑，证明不了「页面还能打开、模型还能跑、profile 生效」。
// 这个脚本是 PLAN 里"无头环境不能替代真机"那条限制下，能做到的最强验证：
// 真的起浏览器、真的加载 wasm/model、真的读 window.__pose。

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ARM_ACTIONS } from '../js/actions.js';

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

/** 让系统分配一个空闲端口：写死端口时，本机其它 Chrome/另一个 checkout 的检查会串到一起。 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
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
  const port = await freePort();

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
        const entry = m.params.entry || {};
        const text = entry.text || '';
        const url = entry.url || '';
        // favicon 404 与页面无关；accuracy.json 是可选报告（npm run accuracy 才生成），
        // 没有它页面显示「未评估」是设计行为，不该让回归挂掉。
        if (!/favicon\.ico/.test(text) && !/\/accuracy\.json/.test(url)) errors.push(text);
      }
    });

    // 固定 1440×900：布局（尤其工具栏新增控件）必须在这个尺寸下不产生滚动
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.navigate', { url });
    await cdp.waitFor('Page.loadEventFired', 15000);

    // 等模型加载 + 跑几帧（>20 帧才跨过骨骼一致性的 minSamples=10，才能验证 3D 不会被误判掉）
    for (let i = 0; i < 60; i++) {
      const ready = await cdp.eval('!!(window.__pose && window.__pose.state.frames > 20)');
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
        // R3：确认页面真的走了 3D 分支，而不是悄悄退回 2D
        hasWorld: f && f.signals ? f.signals.has_world : null,
        knee: f && f.signals ? f.signals.knee : null,
        knee2d: f && f.signals ? f.signals.knee_2d : null,
        knee3d: f && f.signals ? f.signals.knee_3d : null,
        scaleWorld: f && f.signals ? f.signals.scale_world : null,
        angleSource: f && f.signals ? f.signals.angle_source : null,
        extrapolated: f && f.signals ? f.signals.extrapolated : null,
        bonesOk: f && f.signals ? f.signals.bones_ok : null,
      };
    })()`);

    // 本轮前端：播放条、进度、设置持久化（在难例测试前跑，结束后用重播恢复帧）
    const frontend = await cdp.eval(`(async () => {
      const $ = (id) => document.getElementById(id);
      const video = $('video');
      const player = $('player');
      const seek = $('seek');
      const playBtn = $('btnPlay');
      const log = $('logInfo');
      const profile = $('profileSel');
      const tag = $('profileTag');

      const wasPaused = video.paused;
      playBtn.click();
      const afterFirst = video.paused;
      playBtn.click();
      const afterSecond = video.paused;

      // 拖动进度：先暂停，避免触发「回绕停止记录」；随后点重播清空并从 0 开始
      video.pause();
      seek.value = '500';
      seek.dispatchEvent(new Event('input', { bubbles: true }));
      const mid = video.currentTime;
      const dur = video.duration;
      $('btnReplay').click();
      // 冷启动 / 视频播完后再 seek 到 0 时，Chrome 会重新缓冲（readyState 回到 HAVE_METADATA）。
      // 固定等 1.6s 在慢机上会读到 0 帧；这里轮询到有帧为止（最多 5s）。
      for (let i = 0; i < 25 && window.__pose.state.frames === 0; i++) {
        await new Promise((r) => setTimeout(r, 200));
      }
      // 无头环境偶发：ended 后 seek 回 0 停在 readyState=1 不再推进（真机上不会）。
      // 兜底重新 load 一次，仍然没帧才让断言失败。
      if (window.__pose.state.frames === 0) {
        video.load();
        video.play().catch(() => {});
        for (let i = 0; i < 25 && window.__pose.state.frames === 0; i++) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // 设置持久化：切换镜像后应写入 localStorage
      const mirror = $('chkMirror');
      const beforeMirror = mirror.checked;
      mirror.click();
      const saved = JSON.parse(localStorage.getItem('pose-demo.settings.v1') || '{}');
      mirror.click();

      // 上传入口是 button，必须真的把点击转给隐藏的 file input（键盘可达）
      const fileInput = $('fileInput');
      let uploadClicks = 0;
      const spy = (e) => { uploadClicks++; e.preventDefault(); };
      fileInput.addEventListener('click', spy, { once: true });
      $('btnUpload').click();
      fileInput.removeEventListener('click', spy);

      return {
        uploadWired: uploadClicks === 1,
        switchCamHidden: getComputedStyle($('btnSwitchCam')).display === 'none',
        profileTagDisplay: getComputedStyle(tag).display,
        playerVisible: !player.hidden,
        seekMax: seek.max,
        wasPaused, afterFirst, afterSecond,
        mid, dur,
        framesAfterReplay: window.__pose.state.frames,
        settingsSaved: saved.mirror === !beforeMirror,
        profileOptions: profile.options.length,
        profileTagBefore: tag.textContent,
        logText: log.textContent,
        logTitle: log.title,
      };
    })()`);

    // R6：控件接好没有 + 难例窗口能切出帧和草稿 label
    const hardcase = await cdp.eval(`(() => {
      const sel = document.getElementById('hardcaseSel');
      const btn = document.getElementById('btnHardcase');
      const info = window.__pose && window.__pose.hardcaseInfo
        ? window.__pose.hardcaseInfo('clap') : null;
      return {
        hasSelect: !!sel, options: sel ? sel.options.length : 0, value: sel ? sel.value : null,
        hasButton: !!btn, frames: info && info.frames,
        segment: info && info.segments && info.segments[0],
        action: info && info.hardcase && info.hardcase.action,
      };
    })()`);

    // 布局：1440×900 下不能出现整页滚动（PLAN §7.2 的约束）
    const layout = await cdp.eval(`(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      viewport: innerHeight,
    }))()`);

    // R6 端到端：真点一次「判错了」，等 2s 采样窗口结束，按钮要复位、状态要报告导出
    try { await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' }); } catch { /* 旧版本 CDP 可能不支持 */ }
    const clickStart = await cdp.eval(`(() => {
      const sel = document.getElementById('hardcaseSel');
      const btn = document.getElementById('btnHardcase');
      sel.value = 'clap';
      btn.click();
      return { disabled: btn.disabled, text: btn.textContent };
    })()`);
    await sleep(2500);
    const clickEnd = await cdp.eval(`(() => {
      const btn = document.getElementById('btnHardcase');
      return {
        disabled: btn.disabled,
        text: btn.textContent,
        status: (document.getElementById('status') || {}).textContent || '',
      };
    })()`);

    // 动作准确度提示：每个动作一条 tooltip，面板上有一行当前提示（armhint.js）。
    // 必须放在「清空记录」之前——清空后 lastResult 归零，提示行会变回「—」。
    const armHint = await cdp.eval(`(() => {
      const el = document.getElementById('armHint');
      const acts = [...document.querySelectorAll('#armGrid .act')];
      return {
        hasHint: !!el,
        line: el ? el.textContent.trim() : null,
        count: acts.length,
        titled: acts.filter((a) => /条件：/.test(a.title || '')).length,
        na: acts.filter((a) => a.classList.contains('na')).map((a) => a.dataset.id),
      };
    })()`);

    // 准确率明细：默认收起，点「准确率」展开每个手臂动作一行；再点收起（布局断言要在收起后）
    const accuracyUi = await cdp.eval(`(() => {
      const btn = document.getElementById('btnAccuracy');
      const box = document.getElementById('accList');
      btn.click();
      const open = !box.hidden;
      const items = [...box.querySelectorAll('.acc-item')].map((el) => ({
        name: el.querySelector('.an')?.textContent || '',
        value: el.querySelector('.av')?.textContent || '',
        title: el.title || '',
      }));
      btn.click();
      return {
        hasBtn: !!btn, open, hiddenAfter: box.hidden, count: items.length,
        filled: items.filter((i) => i.name && i.value).length,
        titled: items.filter((i) => /n=|样本不足|未评估/.test(i.title)).length,
        hint: document.getElementById('armHint').textContent,
      };
    })()`);

    // 单人道的动作引擎也必须拿到手：之前 handsByTrack=null，伸手/持物/指向在默认单人道
    // 永远不成立。这里在真人视频上确认「判定结果里能挂上检出的手」。
    const handWiring = await cdp.eval(`(async () => {
      let withHands = 0;
      let verdicts = 0;
      for (let i = 0; i < 12; i++) {
        const vs = (window.__pose.state.lastResult || {}).verdicts || [];
        verdicts = Math.max(verdicts, vs.length);
        withHands = Math.max(withHands, vs.filter((v) => v.hands && (v.hands.L || v.hands.R)).length);
        if (withHands) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      return { handReady: !!window.__pose.state.handReady, verdicts, withHands };
    })()`);

    // 数据面板：清空记录 + profile 切换
    const panel = await cdp.eval(`(async () => {
      const $ = (id) => document.getElementById(id);
      const tag = $('profileTag');
      $('btnClearLog').click();
      const clearedFrames = window.__pose.state.frames;

      const profile = $('profileSel');
      profile.value = 'fitness';
      profile.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 40; i++) {
        if (/fitness/.test(tag.textContent || '')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const profileTagFitness = tag.textContent;

      profile.value = 'default';
      profile.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 40; i++) {
        if (/默认/.test(tag.textContent || '')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        clearedFrames,
        profileTagFitness,
        profileTagDefault: tag.textContent,
      };
    })()`);

    const profileEcho = await cdp.eval(`(() => {
      const el = document.getElementById('status');
      return el ? el.textContent : null;
    })()`);

    console.log('页面状态：', JSON.stringify(state, null, 2));
    console.log('播放/设置：', JSON.stringify(frontend));
    console.log('难例控件：', JSON.stringify(hardcase));
    console.log('难例点击：', JSON.stringify({ clickStart, clickEnd }));
    console.log('面板/profile：', JSON.stringify(panel));
    console.log('准确率：', JSON.stringify(accuracyUi));
    console.log('手部接线：', JSON.stringify(handWiring));
    console.log('动作提示：', JSON.stringify(armHint));
    console.log('布局：', JSON.stringify(layout));
    console.log('状态栏：', profileEcho);
    console.log('JS 错误：', errors.length ? errors : '无');

    const ok = state.hasApi && state.estimatorReady && state.frames > 5
      && state.kpCount === 13 && errors.length === 0
      && frontend.playerVisible === true
      && Number(frontend.seekMax) === 1000
      && frontend.wasPaused !== frontend.afterFirst
      && frontend.afterSecond === frontend.wasPaused
      && frontend.dur > 0 && Math.abs(frontend.mid - frontend.dur * 0.5) < 0.6
      && frontend.framesAfterReplay > 0
      && frontend.settingsSaved === true
      && frontend.uploadWired === true
      && frontend.switchCamHidden === true
      && frontend.profileTagDisplay === 'none'
      && frontend.profileOptions >= 2
      && /帧/.test(frontend.logText) && /profile=/.test(frontend.logTitle)
      && panel.clearedFrames === 0
      && /fitness/.test(panel.profileTagFitness) && /默认/.test(panel.profileTagDefault)
      && armHint.hasHint && armHint.count === ARM_ACTIONS.length && armHint.titled === ARM_ACTIONS.length
      && !!armHint.line && armHint.line !== '—'
      && accuracyUi.hasBtn && accuracyUi.open === true && accuracyUi.hiddenAfter === true
      && accuracyUi.count === ARM_ACTIONS.length
      && accuracyUi.filled === ARM_ACTIONS.length && accuracyUi.titled === ARM_ACTIONS.length
      && !!accuracyUi.hint
      && (!handWiring.handReady || handWiring.withHands > 0)
      && hardcase.options >= 10 && hardcase.hasButton && hardcase.frames > 0
      && hardcase.segment && hardcase.action === 'clap'
      && clickStart.disabled === true && clickEnd.disabled === false
      && clickEnd.text === '判错了' && /已导出难例/.test(clickEnd.status)
      && layout.scrollHeight <= layout.viewport + 1;
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
