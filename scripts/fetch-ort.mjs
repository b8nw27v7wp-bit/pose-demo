// fetch-ort.mjs — 下载 onnxruntime-web 的运行时文件到 web/vendor/ort/（不进 git）
//
// 为什么不用 CDN：web/vendor/ 整个目录被 .gitignore，但页面运行时需要同源的 .wasm
// （加载 14MB wasm 走 CDN 会引入跨域/离线问题），所以固定版本、本地复制。
//
// 用法：
//   node scripts/fetch-ort.mjs [版本]     # 默认 1.31.1
//
// 产物：
//   web/vendor/ort/ort.wasm.bundle.min.mjs   （wasm 后端）
//   web/vendor/ort/ort-wasm-simd-threaded.mjs（wasmPaths 动态 import 的加载器）
//   web/vendor/ort/ort-wasm-simd-threaded.wasm

import { mkdir, copyFile, rm, readdir } from 'node:fs/promises';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'vendor', 'ort');
const TMP = path.join(ROOT, 'eval-data', '.ort-pack');

const version = process.argv[2] || '1.31.1';
// 版本号会拼进 shell 命令，先校验，别让 argv 里的 `;`/`&` 变成命令
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`版本号格式不对：${version}（示例：1.31.1）`);
  process.exit(1);
}
const FILES = [
  'ort.wasm.bundle.min.mjs',
  'ort-wasm-simd-threaded.mjs',   // 运行时按 wasmPaths 动态 import 的加载器
  'ort-wasm-simd-threaded.wasm',
];

async function main() {
  await mkdir(TMP, { recursive: true });
  await mkdir(OUT, { recursive: true });
  try {
    // Windows 上 npm 是 .cmd：execFileSync 不能直接 spawn（EINVAL/ENOENT），走 shell
    console.log(`npm pack onnxruntime-web@${version} → ${TMP}`);
    const packed = execSync(`npm pack onnxruntime-web@${version} --silent`, {
      cwd: TMP, encoding: 'utf8', shell: true,
    }).trim().split(/\r?\n/).pop();

    execFileSync('tar', ['-xzf', packed], { cwd: TMP });
    const dist = path.join(TMP, 'package', 'dist');
    const have = new Set(await readdir(dist));
    for (const f of FILES) {
      if (!have.has(f)) throw new Error(`onnxruntime-web@${version} 里没有 dist/${f}`);
      await copyFile(path.join(dist, f), path.join(OUT, f));
      console.log(`  → web/vendor/ort/${f}`);
    }
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
  console.log(`完成：web/vendor/ort/（${FILES.join(' + ')}）`);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
