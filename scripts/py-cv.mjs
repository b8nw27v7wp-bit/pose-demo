// py-cv.mjs — 选一个装了 OpenCV 的 Python 执行脚本（跨平台，不写死 venv 路径）。
//
// 与 py.mjs 的区别：py.mjs 只要找到任意 Python 就跑；视频工具（video-sheet.py）
// 需要 cv2，系统 Python 往往没有。这里先探测仓库里的 venv，再回退到 PATH 上的
// py/python3/python，用 `-c "import cv2"` 逐个验证，第一个可用的执行目标脚本。
//
// 用法：node scripts/py-cv.mjs [-I] <脚本> [脚本参数...]
//   npm run inspect        → node scripts/py-cv.mjs -I scripts/video-sheet.py
//
// 找不到时给出建 venv + 装 opencv 的命令（和 docs/ppe-training.md 一致）。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法：node scripts/py-cv.mjs [-I] <脚本> [脚本参数...]');
  process.exit(2);
}

const venvs = process.platform === 'win32'
  ? ['.venv-ppe/Scripts/python.exe', '.venv/Scripts/python.exe']
  : ['.venv-ppe/bin/python', '.venv/bin/python'];
const commands = process.platform === 'win32'
  ? ['py', 'python3', 'python']
  : ['python3', 'python'];
const candidates = [
  ...(process.env.PYTHON ? [process.env.PYTHON] : []),
  ...venvs.map((p) => path.join(ROOT, p)),
  ...commands,
];

/**
 * @param {{quiet?:boolean, timeoutMs?:number}} opts
 *   timeoutMs=0 表示不设超时（真实运行用：长素材跑几分钟是正常的，20s 会把它杀掉）。
 */
function tryRun(cmd, argv, { quiet = true, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: quiet ? 'ignore' : 'inherit' });
    let settled = false;
    let t = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (t) clearTimeout(t);
      resolve(r);
    };
    child.once('error', (e) => done({ missing: e.code === 'ENOENT', code: 127, message: e.message }));
    // 探测卡住（损坏的 venv / 网络路径）不能把 npm script 挂死。
    // 只给探活设超时：真实运行套 20s 会把 video-sheet.py 在第 20 秒杀掉（退出码 124）。
    if (timeoutMs > 0) {
      t = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        done({ missing: false, code: 124, message: 'timeout' });
      }, timeoutMs);
    }
    child.once('close', (code, signal) => {
      done({ missing: false, code: code ?? (signal ? 1 : 0) });
    });
  });
}

// 探活必须与真实运行使用同一组解释器选项：带 -I 时用户 site-packages 不在 sys.path 里，
// 不带 -I 探活通过、真实运行却 ModuleNotFoundError（按提示重装也不会好）。
const isolated = args[0] === '-I';
const probeArgs = isolated ? ['-I', '-c', 'import cv2'] : ['-c', 'import cv2'];

const tried = [];
for (const cmd of candidates) {
  const probe = await tryRun(cmd, probeArgs);
  tried.push(cmd);
  if (probe.missing || probe.code !== 0) continue;
  const r = await tryRun(cmd, args, { quiet: false, timeoutMs: 0 });
  process.exit(r.code ?? 1);
}

console.error(
  '找不到装了 OpenCV 的 Python（试过：' + tried.join(', ') + '）。\n'
  + 'Windows：\n'
  + '  uv venv .venv-ppe --python 3.11\n'
  + '  uv pip install --python .venv-ppe/Scripts/python.exe opencv-python numpy\n'
  + 'macOS/Linux：\n'
  + '  uv venv .venv-ppe --python 3.11\n'
  + '  uv pip install --python .venv-ppe/bin/python opencv-python numpy\n'
  + '也可以先设置环境变量 PYTHON 指向一个有 cv2 的解释器。',
);
process.exit(127);
