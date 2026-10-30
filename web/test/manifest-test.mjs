// manifest-test.mjs — R2 采集清单校验与覆盖度统计的单测
// 运行：node web/test/manifest-test.mjs

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  validateManifest, coverageReport, buildManifestSkeleton, DEFAULT_THRESHOLDS, ACTIONS,
} from './manifest-check.mjs';
import { ARM_ACTIONS, REP_ACTIONS } from '../js/actions.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const dir = await mkdtemp(path.join(os.tmpdir(), 'pose-manifest-'));
const labels = {
  segments: [
    { action: 'stand', start: 0, end: 1000 },
    { action: 'stand', start: 1200, end: 2000 },
    { action: 'squat', start: 3000, end: 4000, count: 3 },
    { action: 'none', start: 5000, end: 6000 },
    { action: 'noArm', start: 7000, end: 8000 },
    { action: '!onHips', start: 9000, end: 9500 },
  ],
};
for (const n of ['a', 'b']) {
  await writeFile(path.join(dir, `${n}.frames.json`), '{"frames":[]}');
  await writeFile(path.join(dir, `${n}.labels.json`), JSON.stringify(labels));
}

const manifest = {
  version: 1,
  clips: [
    { clip: 'a.frames.json', labels: 'a.labels.json', camera: 'front', subject: 'A', lighting: 'front', model: 'full', fps: 30 },
    { clip: 'b.frames.json', labels: 'b.labels.json', camera: 'side', subject: 'B', lighting: 'back', model: 'lite', fps: 15 },
  ],
};

// —— 1. 清单校验 ——
console.log('\n[1] validateManifest');
{
  const v = await validateManifest(manifest, dir);
  check('合法清单无错误', v.errors.length === 0, v.errors.join('; '));
  check('帧与 labels 文件都存在', v.clips.length === 2);

  const badCamera = structuredClone(manifest);
  badCamera.clips[0].camera = 'top';
  check('非法机位报错', (await validateManifest(badCamera, dir)).errors.some((e) => /camera/.test(e)));

  const badFps = structuredClone(manifest);
  badFps.clips[0].fps = 0;
  check('非法帧率报错', (await validateManifest(badFps, dir)).errors.some((e) => /fps/.test(e)));

  const missing = structuredClone(manifest);
  missing.clips[0].labels = 'nope.labels.json';
  check('labels 不存在报错', (await validateManifest(missing, dir)).errors.some((e) => /labels/.test(e)));

  const dup = structuredClone(manifest);
  dup.clips[1].clip = dup.clips[0].clip;
  check('重复 clip 报错', (await validateManifest(dup, dir)).errors.some((e) => /重复/.test(e)));

  const noLabels = structuredClone(manifest);
  delete noLabels.clips[0].labels;
  check('缺 labels 字段报错', (await validateManifest(noLabels, dir)).errors.some((e) => /缺少 labels/.test(e)));

  check('默认门槛是 40/20/2/2',
    DEFAULT_THRESHOLDS.minPos === 40 && DEFAULT_THRESHOLDS.minNeg === 20
    && DEFAULT_THRESHOLDS.minSubjects === 2 && DEFAULT_THRESHOLDS.minCameras === 2);

  // 覆盖度报表的动作清单必须覆盖注册表：§12.7 新增的 5 个手臂动作与 grasp
  // 曾在 manifest-check 里漏掉，标注它们会被当成「未知动作」。
  check('覆盖度清单包含每个手臂动作',
    ARM_ACTIONS.every((a) => ACTIONS.includes(a.flag)),
    `missing=${ARM_ACTIONS.map((a) => a.flag).filter((f) => !ACTIONS.includes(f))}`);
  check('覆盖度清单包含每个计数动作',
    REP_ACTIONS.every((r) => ACTIONS.includes(r.id)),
    `missing=${REP_ACTIONS.map((r) => r.id).filter((id) => !ACTIONS.includes(id))}`);
}

// —— 2. 覆盖度 ——
console.log('\n[2] coverageReport');
{
  const cov = await coverageReport(manifest, dir, {
    actions: ['stand', 'squat'], minPos: 2, minNeg: 1, minSubjects: 2, minCameras: 2,
  });
  const stand = cov.rows.find((r) => r.action === 'stand');
  const squat = cov.rows.find((r) => r.action === 'squat');
  check('stand：2 段/人 × 2 份素材', stand.pos === 4 && stand.segs === 4, JSON.stringify(stand));
  check('stand：none 反例 2 段', stand.neg === 2);
  check('squat：计数按 count 求和（3 × 2）', squat.pos === 6 && squat.segs === 2, JSON.stringify(squat));
  check('每动作人物/机位齐全', stand.subjects.length === 2 && stand.cameras.length === 2
    && squat.subjects.length === 2 && squat.cameras.length === 2);
  check('整体达标', cov.ok === true && cov.rows.every((r) => r.ok));

  const strict = await coverageReport(manifest, dir, {
    actions: ['stand'], minPos: 5, minNeg: 1, minSubjects: 2, minCameras: 2,
  });
  check('门槛抬高后不达标', strict.ok === false && strict.rows[0].ok === false);

  const arm = await coverageReport(manifest, dir, {
    actions: ['onHips'], minPos: 0, minNeg: 1, minSubjects: 1, minCameras: 1,
  });
  // none(2) + noArm(2) + !onHips(2)
  check('noArm / !动作 只记对应动作的反例', arm.rows[0].neg === 6, `neg=${arm.rows[0].neg}`);

  await writeFile(path.join(dir, 'c.labels.json'),
    JSON.stringify({ segments: [{ action: 'moonwalk', start: 0, end: 100 }] }));
  const unknown = await coverageReport({
    clips: [{ clip: 'a.frames.json', labels: 'c.labels.json', camera: 'front', subject: 'A', model: 'full' }],
  }, dir, { actions: ['stand'] });
  check('未知动作被单独列出', unknown.unknownActions.includes('moonwalk'),
    JSON.stringify(unknown.unknownActions));
}

// —— 3. 清单骨架 ——
console.log('\n[3] buildManifestSkeleton');
{
  const skeleton = await buildManifestSkeleton(dir);
  check('扫到两份帧文件', skeleton.clips.length === 2, `n=${skeleton.clips.length}`);
  check('自动配对同名 labels', skeleton.clips.every((c) => c.labels && c.labels.endsWith('.labels.json')));
  check('元数据留空待填', skeleton.clips.every((c) => c.camera === null && c.fps === null));
}

await rm(dir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
