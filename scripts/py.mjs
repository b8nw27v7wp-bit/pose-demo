// py.mjs — 选一个可用的 Python 解释器执行脚本（本机只有 py.exe，没有 python）
//
// 背景：npm 脚本里直接写 python，在没有 python 命令的 Windows 上会 ENOENT
// （实测本机只有 C:\Windows\py.exe）。这里按平台顺序探测解释器，把参数原样
// 传下去；脚本自身的退出码原样返回，只有找不到解释器才报错。
//
// 用法：node scripts/py.mjs [-I] <脚本> [脚本参数...]
//   npm run serve        → node scripts/py.mjs serve.py
//   npm run fetch:data   → node scripts/py.mjs -I scripts/fetch-eval-data.py

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法：node scripts/py.mjs [-I] <脚本> [脚本参数...]');
  process.exit(2);
}

// Windows 上 py 启动器通常一定存在；其它平台优先 python3。
const candidates = process.platform === 'win32'
  ? ['py', 'python', 'python3']
  : ['python3', 'python', 'py'];

function tryRun(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    child.once('error', (e) => {
      // 只有「找不到可执行文件」才换下一个；权限等其它错误直接报出来
      done({ missing: e.code === 'ENOENT', code: 127, message: e.message });
    });
    child.once('close', (code, signal) => {
      done({ missing: false, code: code ?? (signal ? 1 : 0) });
    });
  });
}

const tried = [];
for (const cmd of candidates) {
  tried.push(cmd);
  const r = await tryRun(cmd);
  if (!r.missing) {
    if (r.code !== 0 && r.message) console.error(r.message);
    process.exit(r.code);
  }
}

console.error(`找不到 Python 解释器（试过：${tried.join(', ')}）。`
  + 'Windows 上可安装 Python 启动器后使用 py，或把 python 加入 PATH。');
process.exit(127);
