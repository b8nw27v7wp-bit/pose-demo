// geometry-test.mjs — 区域/多边形/人框有效性的纯函数自测
// 运行：node web/test/geometry-test.mjs

import {
  normalizeRect, rectToBox, normalizeZones, scaleZones, hasRegionConfig,
  polygonBBox, polygonArea, pointInPolygon, pointInAnyZone,
  clipPolygonToRect, rectPolygonIntersectionArea, rectPolygonOverlapRatio,
  maxZoneOverlap, resolveRegions, personBoxValidity, headPointsFromRaw,
  personPlausibility, personCoveredByHand,
} from '../js/geometry.js';

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
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= tol;

console.log('\n[1] 旧矩形');
{
  const r = normalizeRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  check('正常矩形原样保留', r.x === 0.1 && r.y === 0.2 && r.w === 0.3 && r.h === 0.4);
  const neg = normalizeRect({ x: 0.5, y: 0.5, w: -0.2, h: -0.3 });
  check('负宽高翻正', near(neg.x, 0.3) && near(neg.y, 0.2) && near(neg.w, 0.2) && near(neg.h, 0.3),
    JSON.stringify(neg));
  check('零面积/NaN/null 拒绝',
    normalizeRect({ x: 0, y: 0, w: 0, h: 1 }) === null
    && normalizeRect({ x: 0, y: 0, w: NaN, h: 1 }) === null
    && normalizeRect(null) === null);
  const b = rectToBox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  check('rectToBox', near(b[0], 0.1) && near(b[1], 0.2) && near(b[2], 0.4) && near(b[3], 0.6));
}

console.log('\n[2] 多边形配置');
{
  const z = normalizeZones([
    { points: [[0, 0], [1, 0], [1, 1]] },
    { id: 'gauge', points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.4 }] },
    { id: 'bad', points: [[0, 0], [1, 0]] },
    { id: 'off', enabled: false, points: [[0, 0], [1, 0], [1, 1]] },
    { id: 'outside', points: [[0, 0], [2, 0], [2, 1]] },
  ]);
  check('保留合法 zone 并补默认 id', z.length === 2 && z[0].id === 'zone_0' && z[1].id === 'gauge');
  check('保留配置顺序', z[0].points[0][0] === 0 && z[1].points[0][0] === 0.2);
  const sc = scaleZones(z, 100, 200);
  check('scaleZones 按帧尺寸换算', near(sc[1].points[2][0], 40) && near(sc[1].points[2][1], 80),
    JSON.stringify(sc[1].points));
  check('scaleZones 缺帧尺寸返回空', scaleZones(z, 0, 200).length === 0);
}

console.log('\n[3] 点在多边形内');
{
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  check('内部', pointInPolygon(5, 5, sq));
  check('外部', !pointInPolygon(15, 5, sq));
  check('边', pointInPolygon(0, 5, sq));
  check('顶点', pointInPolygon(0, 0, sq));
  const tri = [[0, 0], [10, 0], [0, 10]];
  check('三角形内', pointInPolygon(2, 2, tri));
  check('三角形外', !pointInPolygon(8, 8, tri));
  const concave = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  check('凹多边形内', pointInPolygon(2, 2, concave));
  check('凹口外', !pointInPolygon(8, 8, concave));
  check('pointInAnyZone 返回第一个 id',
    pointInAnyZone(5, 5, [{ id: 'a', points: sq }, { id: 'b', points: sq }])?.id === 'a');
}

console.log('\n[4] bbox / 面积');
{
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const b = polygonBBox(sq);
  check('矩形 bbox', b[0] === 0 && b[1] === 0 && b[2] === 10 && b[3] === 10);
  check('矩形面积', near(polygonArea(sq), 100));
  check('三角形面积', near(polygonArea([[0, 0], [10, 0], [0, 10]]), 50));
  check('bbox 无点 → null', polygonBBox([]) === null);
}

console.log('\n[5] 矩形 ∩ 多边形');
{
  const rect = [0, 0, 10, 10];
  check('多边形完全在矩形内 → 面积比 0.36',
    near(rectPolygonOverlapRatio(rect, [[2, 2], [8, 2], [8, 8], [2, 8]]), 0.36));
  check('半重叠 → 0.5',
    near(rectPolygonOverlapRatio(rect, [[5, 0], [15, 0], [15, 10], [5, 10]]), 0.5));
  check('不相交 → 0',
    near(rectPolygonOverlapRatio(rect, [[20, 20], [30, 20], [30, 30], [20, 30]]), 0));
  check('多边形包住矩形 → 1',
    near(rectPolygonOverlapRatio(rect, [[-5, -5], [15, -5], [15, 15], [-5, 15]]), 1));
  check('零面积矩形 → 0', rectPolygonOverlapRatio([0, 0, 0, 10], [[0, 0], [1, 0], [1, 1]]) === 0);
  check('裁剪结果面积 = 50',
    near(rectPolygonIntersectionArea(rect, [[5, 0], [15, 0], [15, 10], [5, 10]]), 50));
  check('clip 空结果', clipPolygonToRect([[20, 20], [30, 20], [30, 30]], rect).length === 0);
}

console.log('\n[6] 多 zone 最大重叠');
{
  const rect = [0, 0, 10, 10];
  const m = maxZoneOverlap(rect, [
    { id: 'half', points: [[5, 0], [15, 0], [15, 10], [5, 10]] },
    { id: 'full', points: [[0, 0], [10, 0], [10, 10], [0, 10]] },
  ]);
  check('取最大并返回 zone id', m.zone_id === 'full' && near(m.ratio, 1), JSON.stringify(m));
  const empty = maxZoneOverlap(rect, []);
  check('空 zone → NaN', Number.isNaN(empty.ratio) && empty.zone_id === null);
  const bad = maxZoneOverlap(null, [{ id: 'x', points: [[0, 0], [1, 0], [1, 1]] }]);
  check('非法矩形 → NaN', Number.isNaN(bad.ratio));
}

console.log('\n[7] resolveRegions');
{
  const rectCfg = { roi: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } };
  const r = resolveRegions(rectCfg, 100, 200);
  check('rect mode + 像素框', r.mode === 'rect' && r.valid && r.usable
    && near(r.rectPx[0], 10) && near(r.rectPx[1], 40) && near(r.rectPx[2], 40) && near(r.rectPx[3], 120),
    JSON.stringify(r.rectPx));

  const polyCfg = { rois: [{ id: 'a', points: [[0, 0], [1, 0], [1, 1], [0, 1]] }] };
  const p = resolveRegions(polyCfg, 50, 80);
  check('polygon mode', p.mode === 'polygon' && p.valid && p.usable && p.zones.length === 1);
  check('zone 像素换算', near(p.zones[0].points[2][0], 50) && near(p.zones[0].points[2][1], 80));

  const over = resolveRegions({ roi: { x: 0, y: 0, w: 1, h: 1 }, rois: polyCfg.rois }, 50, 50);
  check('rois 优先于 roi', over.mode === 'polygon');

  const emptyRois = resolveRegions({ roi: { x: 0, y: 0, w: 1, h: 1 }, rois: [] }, 50, 50);
  check('空 rois 回退旧 roi', emptyRois.mode === 'rect' && emptyRois.valid);

  const bad = resolveRegions({ rois: [{ points: [[0, 0], [1, 0]] }] }, 50, 50);
  check('非空非法 rois fail-closed', bad.mode === 'polygon' && bad.valid === false
    && bad.usable === false && bad.zones.length === 0);

  const noFrame = resolveRegions(polyCfg, 0, 0);
  check('缺帧尺寸：配置有效但不可用', noFrame.valid && !noFrame.usable && noFrame.zones.length === 0);

  check('hasRegionConfig 识别 rect/polygon',
    hasRegionConfig(rectCfg) && hasRegionConfig(polyCfg)
    && !hasRegionConfig({ rois: [{ points: [[0, 0], [1, 0]] }] })
    && !hasRegionConfig({}));
}

console.log('\n[8] 人框有效性');
{
  const cfg = {
    enabled: true,
    minAreaRatio: 0.003, maxAreaRatio: 0.9,
    minHeightRatio: 0.15, maxHeightRatio: 1.5,
    minInFrame: 0.5, minShoulderVis: 0.4, minTorsoVis: 0.3,
  };
  const off = personBoxValidity([0, 0, 1, 1], 500, 500, 0.9, 0.9, { enabled: false });
  check('默认关闭 → ok 且 enabled=false', off.enabled === false && off.ok === true);

  const good = personBoxValidity([50, 100, 150, 300], 500, 500, 0.9, 0.9, cfg);
  check('合法人框 → ok', good.ok && good.known && near(good.height_ratio, 0.4),
    JSON.stringify(good.reasons));

  const small = personBoxValidity([0, 0, 10, 10], 500, 500, 0.9, 0.9, cfg);
  check('过小 → too_small', !small.ok && small.reasons.includes('too_small'), small.reasons.join(','));

  const large = personBoxValidity([0, 0, 490, 490], 500, 500, 0.9, 0.9, cfg);
  check('满屏 → too_large', !large.ok && large.reasons.includes('too_large'), large.reasons.join(','));

  const out = personBoxValidity([-400, 100, 100, 300], 500, 500, 0.9, 0.9, cfg);
  check('大半出画 → out_of_frame', !out.ok && out.reasons.includes('out_of_frame')
    && near(out.in_frame, 0.2), JSON.stringify(out));

  const torso = personBoxValidity([50, 100, 150, 300], 500, 500, 0.9, 0.1, cfg);
  check('低躯干可见度 → low_torso', !torso.ok && torso.reasons.includes('low_torso'));

  const noDim = personBoxValidity([0, 0, 10, 10], 0, 0, 0.9, 0.9, cfg);
  check('缺帧尺寸跳过尺寸门', noDim.ok && noDim.known === false);

  const invalid = personBoxValidity([0, 0, 0, 10], 500, 500, 0.9, 0.9, cfg);
  check('非法 bbox → bbox_invalid', !invalid.ok && invalid.reasons.includes('bbox_invalid'));
}

console.log('\n[9] 头部关键点');
{
  const raw = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.8 }));
  raw[7] = { x: 0.25, y: 0.2, visibility: 0.9 };
  raw[8] = { x: 0.75, y: 0.2, visibility: 0.7 };
  const h = headPointsFromRaw(raw, 200, 100);
  check('9 点像素换算', h.length === 9 && near(h[7][0], 50) && near(h[7][1], 20) && near(h[7][2], 0.9));
  check('短数组 → null', headPointsFromRaw(raw.slice(0, 10), 200, 100) === null);
  check('缺帧尺寸 → null', headPointsFromRaw(raw, 0, 100) === null);
}

console.log('\n[10] 人物有效性门（personGate）');
{
  // 2026-11-17 light_tube 实测误检：手+取样管被补成「人」。bbox 62×599，躯干 183px
  const fake = {
    bbox: [382.2, 47.7, 444.4, 646.4], score: 0.64,
    kp: [
      [413, 60, 0.90], [393, 250, 1.00], [415, 250, 0.98], [400, 300, 0.96],
      [410, 320, 0.04], [405, 400, 0.67], [418, 420, 0.02], [400, 433, 1.00],
      [406, 433, 0.99], [402, 480, 0.71], [408, 500, 0.15], [401, 540, 0.66],
      [407, 560, 0.18],
    ],
  };
  const cfg = { enabled: true, minScore: 0.55, minAnchorVis: 0.4, minAspect: 0.12, maxTorsoHeight: 1.4 };
  const fp = personPlausibility(fake, 480, 853, cfg);
  check('细长取样管 → bbox_too_narrow', !fp.ok && fp.reasons.includes('bbox_too_narrow'),
    `aspect=${fp.aspect.toFixed(3)}`);
  check('躯干/框高指标导出', near(fp.torso_h, 0.306, 0.01), String(fp.torso_h));

  // 同一份数据在不启用门时逐位放行（profile 可关闭）
  check('enabled=false 时放行', personPlausibility(fake, 480, 853, { ...cfg, enabled: false }).ok);

  // 真实人物（b787 346.9s，1920×1080）：593×1596，肩宽 380，躯干约 522
  const real = {
    bbox: [1473.4, 359.2, 2052.7, 1955.4], score: 0.84,
    kp: [
      [1821.7, 412.9, 1.00], [1908.4, 575.2, 1.00], [1531.2, 617.4, 1.00],
      [2052.7, 806.1, 0.73], [1473.4, 921.3, 0.58], [1935.4, 854.4, 0.65],
      [1671.9, 945.7, 0.61], [1883.7, 1107.4, 0.85], [1637.4, 1124.0, 0.87],
      [1843.4, 1394.1, 0.49], [1642.7, 1349.2, 0.32], [1835.8, 1824.1, 0.31],
      [1640.7, 1818.4, 0.22],
    ],
  };
  const rp = personPlausibility(real, 1920, 1080, cfg);
  check('真实人物放行', rp.ok, rp.reasons.join(','));

  // 缺 bbox/kp → fail-open（旧数据/测试夹具不因少字段被剔除）
  check('缺 bbox/kp fail-open', personPlausibility({ score: 0.2 }, 100, 100, cfg).ok
    && personPlausibility({ bbox: [0, 0, 10, 10], score: 0.2 }, 100, 100, cfg).ok);

  // 手部包含：整块身体落在手框里 → covered；真人的小范围手框 → 不 covered
  const handCfg = { enabled: true, expand: 0.15, minAnchors: 4, maxHandAreaRatio: 0.5, minAllKp: 9 };
  const covered = personCoveredByHand(fake, [{ bbox: [370, 35, 455, 655] }], handCfg);
  check('手框覆盖全身 → covered', covered.covered && covered.reasons.includes('anchors_in_hand'),
    JSON.stringify(covered.reasons));
  const notCovered = personCoveredByHand(real, [{ bbox: [1735.3, 853.8, 1880.7, 977.2] }], handCfg);
  check('真人手框小 → 不 covered', !notCovered.covered, JSON.stringify(notCovered));
  check('没有手数据 fail-open', !personCoveredByHand(fake, [], handCfg).covered
    && !personCoveredByHand(fake, null, handCfg).covered);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
