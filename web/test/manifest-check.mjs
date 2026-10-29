#!/usr/bin/env node
// manifest-check.mjs — R2 采集清单的校验与覆盖度报告
//
// manifest.json 记录每段素材的元数据（机位/人物/光照/模型/帧率），覆盖度从 labels 里算。
// 它回答的是「采够没有」，不是「准不准」——准不准交给 evaluate.mjs。
//
// 用法：
//   node web/test/manifest-check.mjs                         # 默认读 eval-data/manifest.json
//   node web/test/manifest-check.mjs --manifest eval-data/manifest.json --json
//   node web/test/manifest-check.mjs --actions stand,squat --min-pos 40 --min-neg 20
//   node web/test/manifest-check.mjs --init --dir eval-data  # 扫帧文件生成清单骨架
//
// 退出码：0 达标 / 2 覆盖不足 / 1 清单或文件有错。可直接进 CI。

import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadLabels } from './frame-io.mjs';
import { ACTION_CATALOG } from '../js/actions.js';

export const CAMERAS = ['front', 'side', 'oblique', 'close'];
export const LIGHTING = ['front', 'back', 'low', 'side', 'mixed', 'unknown'];
export const MODELS = ['full', 'lite'];
export const POSTURES = ACTION_CATALOG.map((a) => a.id);
export const ARM_LABEL_ACTIONS = [
  'armRaised', 'waving', 'crossed', 'onHips', 'armsOpen', 'bothHandsUp', 'handAtHead',
];
export const REP_ACTIONS = ['squat', 'pushup', 'clap'];
export const ACTIONS = [...POSTURES, ...ARM_LABEL_ACTIONS, ...REP_ACTIONS];

export const DEFAULT_THRESHOLDS = {
  minPos: 40, minNeg: 20, minSubjects: 2, minCameras: 2,
};

const exists = async (p) => {
  try { await access(p); return true; } catch { return false; }
};
const asString = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * 校验清单结构、字段与文件是否存在。
 * 视频文件缺失只警告（体积大，可能不在本机）；帧/labels 缺失是错误（无法复跑）。
 */
export async function validateManifest(manifest, baseDir, { requireFiles = true } = {}) {
  const errors = [];
  const warnings = [];
  const clips = [];
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.clips)) {
    return { errors: ['manifest 缺少 clips 数组'], warnings, clips };
  }
  const seen = new Set();
  for (let i = 0; i < manifest.clips.length; i++) {
    const c = manifest.clips[i] || {};
    const where = `clips[${i}]`;
    const name = asString(c.clip);
    if (!name) errors.push(`${where} 缺少 clip`);
    if (name && seen.has(name)) errors.push(`${where} clip 重复：${name}`);
    if (name) seen.add(name);

    if (!CAMERAS.includes(asString(c.camera))) {
      errors.push(`${where} camera 必须是 ${CAMERAS.join('/')}，实际「${asString(c.camera)}」`);
    }
    if (!asString(c.subject)) errors.push(`${where} 缺少 subject`);
    const lighting = asString(c.lighting);
    if (!lighting) errors.push(`${where} 缺少 lighting`);
    else if (!LIGHTING.includes(lighting)) warnings.push(`${where} lighting「${lighting}」不在建议值 ${LIGHTING.join('/')} 内`);
    if (!MODELS.includes(asString(c.model))) {
      errors.push(`${where} model 必须是 ${MODELS.join('/')}，实际「${asString(c.model)}」`);
    }
    if (!Number.isFinite(Number(c.fps)) || Number(c.fps) <= 0) errors.push(`${where} fps 必须是正数`);

    if (requireFiles && name) {
      const framesPath = path.resolve(baseDir, name);
      if (!(await exists(framesPath))) errors.push(`${where} 帧文件不存在：${framesPath}`);
      if (c.labels) {
        const labelsPath = path.resolve(baseDir, asString(c.labels));
        if (!(await exists(labelsPath))) errors.push(`${where} labels 文件不存在：${labelsPath}`);
        else if (name) {
          const base = name.replace(/\.frames\.(json|jsonl)$/i, '').replace(/\.(json|jsonl)$/i, '');
          if (asString(c.labels) !== `${base}.labels.json`) {
            warnings.push(`${where} labels 文件名与帧不同名前缀（建议 ${base}.labels.json）`);
          }
        }
      } else {
        errors.push(`${where} 缺少 labels（没有标注就无法算覆盖度）`);
      }
      if (c.video) {
        const videoPath = path.resolve(baseDir, asString(c.video));
        if (!(await exists(videoPath))) warnings.push(`${where} 视频不在本机：${videoPath}`);
      }
    }
    clips.push({ ...c, clip: name, labels: asString(c.labels) });
  }
  return { errors, warnings, clips };
}

/**
 * 覆盖度：每个动作的正例样本数、段数、反例段、人物/机位/模型集合。
 * 正例样本数：计数类按 count 求和，其余按段数（一段=一次）。
 * 反例：none 对所有动作都算反例；noArm 只对手臂动作算；!动作 / expect:false 对指定动作算。
 */
export async function coverageReport(manifest, baseDir, opts = {}) {
  const {
    actions = ACTIONS,
    minPos = DEFAULT_THRESHOLDS.minPos,
    minNeg = DEFAULT_THRESHOLDS.minNeg,
    minSubjects = DEFAULT_THRESHOLDS.minSubjects,
    minCameras = DEFAULT_THRESHOLDS.minCameras,
  } = opts;
  const rows = Object.fromEntries(actions.map((a) => [a, {
    action: a,
    pos: 0,
    segs: 0,
    neg: 0,
    subjects: new Set(),
    cameras: new Set(),
    models: new Set(),
  }]));
  const subjectsAll = new Set();
  const camerasAll = new Set();
  const unknownActions = new Set();
  const clips = (manifest && manifest.clips) || [];

  for (const c of clips) {
    const subject = asString(c.subject);
    const camera = asString(c.camera);
    if (subject) subjectsAll.add(subject);
    if (camera) camerasAll.add(camera);
    if (!c.labels) continue;
    let segments;
    try {
      segments = await loadLabels(path.resolve(baseDir, asString(c.labels)));
    } catch {
      continue;   // 文件缺失已由 validateManifest 报错
    }
    for (const seg of segments) {
      const raw = asString(seg && seg.action);
      if (!raw) continue;
      if (raw === 'none') {
        for (const row of Object.values(rows)) row.neg += 1;
        continue;
      }
      if (raw === 'noArm') {
        for (const a of ARM_LABEL_ACTIONS) if (rows[a]) rows[a].neg += 1;
        continue;
      }
      const negated = raw.startsWith('!');
      const action = negated ? raw.slice(1) : raw;
      const row = rows[action];
      if (!row) {
        // 合法但不在 --actions 范围内的动作静默跳过；只有真正不认识的名字才提示
        if (!ACTIONS.includes(action)) unknownActions.add(raw);
        continue;
      }
      const isNeg = negated || seg.expect === false;
      if (isNeg) { row.neg += 1; continue; }
      row.segs += 1;
      row.pos += REP_ACTIONS.includes(action) && Number.isFinite(Number(seg.count))
        ? Number(seg.count) : 1;
      if (subject) row.subjects.add(subject);
      if (camera) row.cameras.add(camera);
      if (c.model) row.models.add(c.model);
    }
  }

  const outRows = actions.map((a) => {
    const r = rows[a];
    const ok = r.pos >= minPos && r.neg >= minNeg
      && r.subjects.size >= minSubjects && r.cameras.size >= minCameras;
    return {
      action: a,
      pos: r.pos,
      segs: r.segs,
      neg: r.neg,
      subjects: [...r.subjects].sort(),
      cameras: [...r.cameras].sort(),
      models: [...r.models].sort(),
      ok,
    };
  });
  const ok = outRows.every((r) => r.ok)
    && subjectsAll.size >= minSubjects && camerasAll.size >= minCameras;
  return {
    rows: outRows,
    totals: {
      clips: clips.length,
      subjects: [...subjectsAll].sort(),
      cameras: [...camerasAll].sort(),
    },
    thresholds: { minPos, minNeg, minSubjects, minCameras },
    unknownActions: [...unknownActions],
    ok,
  };
}

/** 扫目录里的帧文件，配对同名 labels，生成待填的清单骨架 */
export async function buildManifestSkeleton(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const clips = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name;
    if (/\.labels(\.draft)?\.json$/i.test(name)) continue;
    const isFrames = /\.frames\.(json|jsonl)$/i.test(name) || /\.jsonl$/i.test(name);
    if (!isFrames) continue;
    const base = name.replace(/\.frames\.(json|jsonl)$/i, '').replace(/\.(json|jsonl)$/i, '');
    const labels = (await exists(path.join(dir, `${base}.labels.json`)))
      ? `${base}.labels.json` : null;
    clips.push({
      clip: name,
      labels,
      video: null,
      camera: null,
      subject: null,
      lighting: null,
      model: null,
      fps: null,
      note: 'TODO：填写 camera/subject/lighting/model/fps',
    });
  }
  clips.sort((a, b) => a.clip.localeCompare(b.clip));
  return { version: 1, clips };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function fmtSet(arr) {
  return arr.length ? arr.join(',') : '—';
}

function printReport(manifestPath, validation, coverage) {
  const lines = [];
  lines.push('# 采集覆盖度');
  lines.push('');
  lines.push(`manifest：\`${manifestPath}\`（${coverage.totals.clips} 段素材）`);
  const t = coverage.thresholds;
  lines.push(`门槛：每动作正例 ≥${t.minPos}、反例 ≥${t.minNeg}、人物 ≥${t.minSubjects}、机位 ≥${t.minCameras}`);
  lines.push('');
  lines.push('| 动作 | 样本数 | 段数 | 反例段 | 人物 | 机位 | 模型 | 达标 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of coverage.rows) {
    lines.push(`| ${r.action} | ${r.pos} | ${r.segs} | ${r.neg} | ${fmtSet(r.subjects)} | ${fmtSet(r.cameras)} | ${fmtSet(r.models)} | ${r.ok ? '✅' : '❌'} |`);
  }
  lines.push('');
  lines.push(`整体：人物 ${fmtSet(coverage.totals.subjects)}（${coverage.totals.subjects.length}），机位 ${fmtSet(coverage.totals.cameras)}（${coverage.totals.cameras.length}）`);
  if (coverage.unknownActions.length) {
    lines.push(`未知动作（未参与统计）：${coverage.unknownActions.join(', ')}`);
  }
  if (validation.errors.length) {
    lines.push('');
    lines.push('## 清单错误');
    for (const e of validation.errors) lines.push(`- ${e}`);
  }
  if (validation.warnings.length) {
    lines.push('');
    lines.push('## 警告');
    for (const w of validation.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  lines.push(coverage.ok ? '结论：达标' : '结论：未达标（见上表 ❌）');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = typeof args.dir === 'string' ? args.dir : 'eval-data';

  if (args.init) {
    const outPath = typeof args.out === 'string' ? args.out : path.join(dir, 'manifest.json');
    if (!args.force && await exists(outPath)) {
      console.error(`已存在 ${outPath}，不覆盖（需要覆盖请加 --force）`);
      process.exitCode = 1;
      return;
    }
    const skeleton = await buildManifestSkeleton(dir);
    await writeFile(outPath, `${JSON.stringify(skeleton, null, 2)}\n`, 'utf8');
    console.log(`已扫描 ${dir}，生成 ${skeleton.clips.length} 条待填条目：${outPath}`);
    console.log('请填写 camera/subject/lighting/model/fps 后再运行本工具；labels 为 null 的条目先跑 autolabel。');
    return;
  }

  const manifestPath = typeof args.manifest === 'string' ? args.manifest : path.join(dir, 'manifest.json');
  const baseDir = path.dirname(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    console.error(`读不到或解析不了 ${manifestPath}：${e.message}`);
    console.error('可以先运行：node web/test/manifest-check.mjs --init --dir eval-data');
    process.exitCode = 1;
    return;
  }

  const actions = typeof args.actions === 'string'
    ? String(args.actions).split(',').map((s) => s.trim()).filter(Boolean)
    : ACTIONS;
  const intOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const thresholds = {
    minPos: intOr(args['min-pos'], DEFAULT_THRESHOLDS.minPos),
    minNeg: intOr(args['min-neg'], DEFAULT_THRESHOLDS.minNeg),
    minSubjects: intOr(args['min-subjects'], DEFAULT_THRESHOLDS.minSubjects),
    minCameras: intOr(args['min-cameras'], DEFAULT_THRESHOLDS.minCameras),
  };

  const validation = await validateManifest(manifest, baseDir);
  const coverage = await coverageReport(manifest, baseDir, { actions, ...thresholds });

  if (args.json) {
    console.log(JSON.stringify({ manifest: manifestPath, validation, coverage }, null, 2));
  } else {
    console.log(printReport(manifestPath, validation, coverage));
  }
  if (validation.errors.length) process.exitCode = 1;
  else if (!coverage.ok) process.exitCode = 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
