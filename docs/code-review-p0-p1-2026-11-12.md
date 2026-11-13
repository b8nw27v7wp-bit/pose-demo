# P0/P1 改动代码审查（2026-11-12）

审查对象：工作区未提交的改动（确定性回放 + 设备框时序确认 + operating 新增门）。

```
web/js/equipment.js                 新增  设备框时序确认
web/js/geometry.js                  新增  点到框 / 线段到框距离
web/js/signals.js                   修改  operating 门、gate 诊断、ROI 约束
web/js/multi.js                     修改  单人道主目标选择
web/js/params.js                    修改  新参数默认值
web/js/app.js                       修改  ?det=1 回归模式、objects_ts、主目标选择
scripts/deterministic-replay.mjs    新增  确定性逐帧回放
web/test/evaluate.mjs               修改  回放接 objects_ts / grip hands
web/test/cdp.mjs                    修改  导航失败显式报错
web/profiles/refuel-equipment*.json 修改/新增  boxRequireInRoi / strict 档
docs/*、README、package.json         文档与测试链
```

**结论**：没有发现崩溃、数据损坏或主链路回归。8 项发现中 3 项会改变判定语义（中危），
5 项是指标 / 文档 / 离线一致性问题。建议按 1 → 3 的顺序先修中危项。

## 审查时已核验

| 项 | 结果 |
|---|---|
| `npm test` | 1051 项全过 |
| `headless-check.mjs` | 通过，零 JS 错误 |
| `headless-multi.mjs` | 19 / 19 |
| `headless-open-data.mjs` | 通过 |
| `npm run shots` | 5 / 5 |
| 确定性基线 `refuel-det-baseline`（580 帧 / 10fps） | 两次回放 sha256 一致：`aae4c0988d24fc50e49ef34f149ea7a14ab4cd8e02f9dd423139c0ed40604a55` |
| `refuel-equipment-strict.json` | 5fps 导出上复现 2TP/4FN/0FP；10fps 上 2/4/2（文档已注明 5fps） |
| `openPage` 服务未启动 | 报 `net::ERR_CONNECTION_REFUSED（先运行 npm run serve）`，不再伪装成 SecurityError |
| `headless-ppe-onnx.mjs` | 未跑通：缺 `eval-data/ppe-yolo/images/val`（既有环境问题，与本次改动无关） |

---

## 发现总表

| # | 严重度 | 位置 | 摘要 | 状态 |
|---|---|---|---|---|
| 1 | 中 | `web/js/equipment.js:86` | 先匹配后过期，超龄轨迹仍会被确认 | 已修 |
| 2 | 中 | `web/js/signals.js:989` | `requireValidity` 在 validity 未启用时静默失效 | 已修 |
| 3 | 中 | `web/js/params.js:126` | `boxMaxAgeMs` 必须大于 `objects.intervalMs`，无校验/文档 | 已修 |
| 4 | 低 | `scripts/deterministic-replay.mjs:76` | `confirmRate` 可大于 1（基线 1.038） | 已修 |
| 5 | 低 | `scripts/deterministic-replay.mjs:21` | 示例的站内 profile 路径在 Git Bash 下必然失败 | 已修 |
| 6 | 低 | `web/js/params.js:127` | 注释「中心在内」与实现「相交」不符 | 已修 |
| 7 | 低 | `docs/signals.md:233` | 「闭合手型 8 帧」实际是 8 次检出 / 1 帧 | 已修 |
| 8 | 低（PLAUSIBLE） | `web/test/evaluate.mjs:339` | 离线 grip 按 handedness 绑手，与页面最近腕点不一致 | 已修 |

---

## 1. [中] 设备框：过期过滤在匹配之后，超龄轨迹仍会被确认

**位置**：`web/js/equipment.js:86`（`update()` 的 `fresh` 分支），过期过滤在 `:114`。

**现象**：`update()` 先用 `this.tracks` 做匹配、把 `hits += 1`，最后才按
`tsMs - lastSeen > maxAgeMs` 过滤。于是超过 `boxMaxAgeMs` 的轨迹只要这一次检测能匹配上，
仍会从 hits=1 变成 2，直接进入 `confirmed`。这与文件头注释「超过 maxAgeMs 没再看到就作废」
以及 `params.js` 的说明不一致。

**为什么真实可达**：`SignalEngine.update()` 只在有人的帧调用。单人道漏检、或多人模式某个
track 暂时缺席（< `PersonPipelines` 的 1000ms gap）时，中间帧不会推进这个 tracker，轨迹
就没有机会被过期。人回来后第一次检测即可确认——不需要「两次新鲜观测」，`minHits=2` 形同 1。

**复现**：

```bash
node -e '
import("./web/js/equipment.js").then(({EquipmentBoxTracker}) => {
  const t = new EquipmentBoxTracker({ minHits: 2, maxAgeMs: 200 });
  t.update([{ label: "valve", box: [0,0,10,10] }], 0, 0);
  const r = t.update([{ label: "valve", box: [0,0,10,10] }], 500, 500);
  console.log(r.confirmed);   // 1 —— 期望 0（500ms > maxAgeMs 200）
});'
```

**建议修复**：在 `fresh` 分支做匹配**之前**先执行过期过滤：

```js
if (fresh) {
  this.lastObservationTs = observationTs;
  this.tracks = this.tracks.filter((t) => tsMs - t.lastSeen <= this.maxAgeMs);
  // ...再匹配/新建
}
```

（如果产品上希望「无人帧期间框仍算存在」，应把这段语义写进注释与测试，而不是由调用时序
隐式决定。）

**验收**：`web/test/equipment-test.mjs` 增加一条：两次观测间隔 > `maxAgeMs`、中间不调用
`update`，第二次不得确认；同时现有「maxAge 内漏检仍算在」用例保持通过。

---

## 2. [中] `requireValidity` 在 validity 未启用时静默失效

**位置**：`web/js/signals.js:989`（`validityBlocked`），配置默认值在 `web/js/params.js`
（`operating.requireValidity: false`，阈值来自 `signals.arm.nearEquipment.validity`）。

**现象**：`personBoxValidity()` 在 `cfg.enabled !== true` 时直接返回 `ok: true`。所以
profile 只写 `operating.requireValidity: true`、没有打开 `nearEquipment.validity.enabled`
时，人形门完全不生效；`operating_validity` 导出为 `null`，也没有日志或状态栏提示。

**实际影响**：这是为挡「手/油枪特写被凑成躯干」加的安全门。配置者以为开了，实际没开——
属于静默失效，而不是行为错误。对一个误报控制门来说，静默比报错更危险。

**建议修复**（二选一）：

1. `requireValidity: true` 时自动把 `validity.enabled` 当作 true（在 `signals.js` 里判断
   `opCfg.requireValidity || validity.enabled`），并让 `operating_validity` 在 requireValidity
   打开时始终导出；或
2. profile 加载时校验：`requireValidity === true && nearEquipment.validity.enabled !== true`
   直接报配置错误（`applyParams` / `initProfile` 里 throw 或状态栏红字）。

**验收**：新增单测——`requireValidity: true` + 默认 validity（disabled）时，过小人框不得
判 `operating`；或在配置错误路径上断言明确报错。

**相关文档**：`docs/signals.md` 的 operating 选项表、`docs/equipment-detector.md` §9。

---

## 3. [中] `boxMaxAgeMs` 与 `objects.intervalMs` 没有约束关系

**位置**：`web/js/params.js:126`（`boxMaxAgeMs: 600`）、`perception.objects.intervalMs`
（默认 150）；消费方 `web/js/equipment.js`。

**现象**：时序确认要求同一位置在 `maxAgeMs` 内累计两次命中。但两个参数独立配置：
`intervalMs` 是检测频率，`boxMaxAgeMs` 是框的有效期。当 `intervalMs >= boxMaxAgeMs` 时，
两次检测之间的普通帧会先把轨迹过期，下一次检测又从 hits=1 开始，设备框几乎永远无法确认。

**实测**（60 帧 / 5fps / `refuel-equipment.json`，仅把 `intervalMs` 改成 1000）：

| intervalMs | 确认态帧 | 参与判定帧 |
|---|---|---|
| 150（默认） | 328 / 366（10fps 580 帧基线） | 328 |
| 1000 | **4 / 30** | 4 |

复现：

```bash
node -e '
const fs=require("fs");
const p=JSON.parse(fs.readFileSync("web/profiles/refuel-equipment.json","utf8"));
p.name="refuel-eq-interval1000";
p.params.perception.objects.intervalMs=1000;
fs.writeFileSync("eval-data/incoming/profiles/interval1000.json", JSON.stringify(p,null,2));'

node scripts/deterministic-replay.mjs \
  http://127.0.0.1:8765/eval-data/refuel/oil-sample-demo.mp4 \
  http://127.0.0.1:8765/eval-data/incoming/profiles/interval1000.json verify-interval \
  --fps=5 --max-frames=60 --model=full --delegate=CPU
# 输出末尾的「设备框：… 确认态 4 帧」
```

**建议修复**：在 profile 加载时校验 `intervalMs < boxMaxAgeMs`（留出推理延迟余量，建议
`boxMaxAgeMs >= intervalMs + 300`），不满足时报配置错误；或者在 `EquipmentBoxTracker`
文档与 `docs/signals.md` 里写成硬约束。不要静默自动放大 `maxAge`——那会让「框在不在」的
语义随配置漂移。

**验收**：非法组合在 `npm test`（params 校验单测）或页面加载时明确失败；合法组合回放结果
与当前基线一致。

---

## 4. [低] `confirmRate` 可以大于 1

**位置**：`scripts/deterministic-replay.mjs:76`（`equipmentStats`）。

**现象**：`confirmedFrames` 统计「确认态仍有效」的帧，包含 `maxAgeMs` 内沿用、没有新检出的
帧；`rawFrames` 是新检出帧。前者可能大于后者。

**证据**：`eval-data/incoming/refuel-det-baseline.meta.json`

```json
{ "rawFrames": 316, "confirmedFrames": 328, "confirmRate": 1.038 }
```

**建议修复**：定义为「raw>0 且 confirmed>0 的帧 / rawFrames」：

```js
let confirmedWithRaw = 0;
if (raw > 0 && (f.signals.operating_boxes_confirmed || 0) > 0) confirmedWithRaw++;
// confirmRate = rawFrames ? confirmedWithRaw / rawFrames : null
```

同一份基线算出来是 314/316 = 0.994。`rawRate` 的分母是有人帧、`rawFrames` 只来自
`signals` 非空的帧，不会 >1，可保持不变。

**验收**：meta 里 `confirmRate <= 1`；重新导出的基线值与旧值只在这一项上变化。

---

## 5. [低] 头部示例的站内 profile 路径在 Git Bash 下必然失败

**位置**：`scripts/deterministic-replay.mjs:21`（头部示例），配套说明在 `:27`
「可以是完整 URL，也可以是以 / 开头的站内路径」。

**现象**：Git Bash 的 MSYS 路径转换会把 `/web/profiles/refuel-equipment.json` 改写成
`D:/.../web/profiles/refuel-equipment.json`；脚本随后命中 `looksMangled()` 分支并 `exit 2`。
仓库主平台是 Windows，示例照抄即失败。

**复现**（Git Bash）：

```bash
node scripts/deterministic-replay.mjs \
  http://127.0.0.1:8765/eval-data/refuel/oil-sample-demo.mp4 \
  /web/profiles/refuel-equipment.json det-x
# profile 被 shell 转成了 Windows 路径：D:/.../web/profiles/refuel-equipment.json
```

**建议修复**：示例统一改成完整 URL；或改成不带前导斜杠的 `web/profiles/...`（不会被
MSYS 改写）。同时把「支持以 / 开头的站内路径」改成「Windows Git Bash 下请传完整 URL 或
不带前导斜杠的路径」。保留 `looksMangled()` 报错（它已经挡住了一次静默 404）。

**验收**：文档里的两条示例在 Git Bash 下都能直接跑通。

---

## 6. [低] `boxRequireInRoi` 注释与实现不符

**位置**：`web/js/params.js:127` 注释；实现 `web/js/signals.js` 的 `eqInRoi`。

**现象**：注释写「有 ROI 时，框中心必须落在 ROI 内才算本工位的设备」；实现是
「框与 ROI 矩形/多边形**相交**即通过」。对边界附近的框，两者判断相反。

实际数据：refuel 导出里 159 个设备框有 105 个中心在 ROI 外，但多数与 ROI 有重叠——这也正是
当初从「中心在内」改成「相交」的原因（见 `docs/signals.md` 选项表）。

**建议修复**：把注释改成与实现一致，并补一句为什么要用相交（ROI 是手圈的设备区域，
检测框常常跨在边界上）。

**验收**：`params.js` 注释、`docs/signals.md`、`docs/equipment-detector.md` §9 三处口径一致。

---

## 7. [低] 「闭合手型 8 帧」数字错误

**位置**：`docs/signals.md:233`。

> 手部模型在这段素材上只有 48/290 帧检出、闭合手型 8 帧，**requireGrip 目前不可用**。

**实际**：8 是 fist 的**手部检出次数**（同一帧左右手各算一次）；`operating` 帧里带闭合手型
的只有 **1 帧**。按「8 帧」估算 requireGrip 的召回代价会严重低估。

**建议修复**：改成「48/290 帧检出、8 次闭合手型检出（operating 帧里仅 1 帧）」，或直接
只写「operating 帧里仅 1 帧带闭合手型」。

**验收**：数字可由 `refuel-p0-a.jsonl` 重新统计复现（统计脚本可参考审查时用的
`hands`/`signals.operating_any` 过滤）。

---

## 8. [低，PLAUSIBLE] 离线 grip 手部归属与页面不一致

**位置**：`web/test/evaluate.mjs:339`（`replaySingle` 的 `gripHands`）。

**现象**：页面单人道用 `assignHands()` 按「手到哪个姿态腕点最近」绑手（代码注释明确说
不信任 `handedness`）；`replaySingle` 新增的 `gripHands` 却按 `h.handedness` 取左右手。
开启 `requireGrip` 时，同一份导出在页面与评估器上可能对同一条手臂给出不同的握持结论。

**复现思路**：找一份导出的手 `handedness` 与最近腕点相反的帧，分别用页面与
`evaluate.mjs` 跑同一 profile（`requireGrip: true`），比较 `operating_gate` / `operating`。
现有 5fps 导出上 `requireGrip` 的段级指标没变化（肘兜底占主导），所以这条没有在本次审查中
直接复现，标 PLAUSIBLE。

**建议修复**：`replaySingle` 也调用一次 `assignHands([person], hands)`（页面同一函数），
再用槽位里的 `cls.shape` 喂 `SignalEngine`；多人路径已经这么做了。

**验收**：新增单测/回放用例：handedness 标反时，页面与 `replaySingle` 的
`operating_grip_L/R` 一致。

---

## 修复顺序建议

1. **#1**（过期匹配）—— 直接影响「单帧误检不算证据」这条 P0 语义。
2. **#2**（requireValidity 静默失效）—— 误报控制门不能静默。
3. **#3**（maxAge / interval 约束）—— 防止按 CPU 预算调参时整条设备证据失效。
4. #4、#5（回放脚本的指标与示例）—— 都是测量链路的一部分，顺手修。
5. #6、#7（文档口径）。
6. #8（离线一致性）—— 涉及 `requireGrip` 的 A/B，优先级最低。

## 回归命令（修完必须全跑）

```bash
npm test
node web/test/headless-check.mjs
node web/test/headless-multi.mjs
node scripts/pose-screenshots.mjs http://127.0.0.1:8765 runs/pose-test-$(date +%F)
```

确定性基线（两次 sha256 必须一致；若 #1/#4 改变了判定/导出，基线会变，需重新生成并记录）：

```bash
node scripts/deterministic-replay.mjs \
  http://127.0.0.1:8765/eval-data/refuel/oil-sample-demo.mp4 \
  http://127.0.0.1:8765/web/profiles/refuel-equipment.json refuel-det-baseline \
  --fps=10 --model=full --delegate=CPU
```

设备框 A/B（同一份导出、同一 profile，只改被验证的开关）：

```bash
node web/test/evaluate.mjs \
  --input eval-data/incoming/refuel-det-baseline.jsonl \
  --labels eval-data/refuel/refuel-operating.labels.json \
  --profile web/profiles/refuel-equipment.json
```

## 参考

- 判定门与 A/B 表：`docs/signals.md`「操作设备（operating）」
- 检测器现状与 A/B：`docs/equipment-detector.md` §6、§9
- 确定性回放：`docs/eval.md`「确定性回放（感知层 A/B）」
- 数据契约：`docs/frame-schema.md`（`objects_ts`、`operating_gate*`、`operating_boxes_*`）
- 现有基线（本机、不进 git）：`eval-data/incoming/refuel-det-baseline.{jsonl,meta.json,report.md}`、
  `eval-data/incoming/refuel-p0-a.jsonl`（5fps A/B 源）

---

## 修复记录（2026-11-12 实施）

| # | 改法 | 落点 | 单测 |
|---|---|---|---|
| 1 | `fresh` 分支在匹配**之前**按 `tsMs - lastSeen > maxAgeMs` 清轨迹；末尾的过滤保留，兜住「重复沿用同一批框」的帧 | `web/js/equipment.js` | `equipment-test.mjs` [1b]：500ms 间隔 >200 不确认；500ms <600 仍确认 |
| 2 | `requireValidity` 打开时传 `{...nearEquipment.validity, enabled:true}`，`operating_validity` 随之非空（采用方案 1：自动启用） | `web/js/signals.js` | `operating-test.mjs` [7]：只写 requireValidity 时过小人框 → `person_invalid` |
| 3 | 新增 `validateParams()`：`equipmentLabels` 非空且 `boxMinHits>1` 时要求 `boxMaxAgeMs >= intervalMs + 300`，否则抛错。页面 `applyParams`（先校验再落地）、评估器 `readProfile`、回放脚本预检三处调用 | `web/js/params.js`、`web/js/app.js`、`web/test/evaluate.mjs`、`scripts/deterministic-replay.mjs` | `operating-test.mjs` [8]：非法组合报错；默认 / 无设备类别 / boxMinHits=1 三种组合不误报 |
| 4 | 新增 `confirmedWithRawFrames`，`confirmRate` 改用它（恒 ≤1）；`confirmedFrames` 保留旧口径并注明可 > rawFrames | `scripts/deterministic-replay.mjs`、`docs/eval.md`、`docs/equipment-detector.md` | 老基线复算：316 检出 → 314/316 = **0.994**（旧口径 1.038） |
| 5 | 头部示例改完整 URL，并写明 Git Bash 下不要传以 `/` 开头的路径 | `scripts/deterministic-replay.mjs` | — |
| 6 | 注释改为「相交」并补理由（ROI 是手圈设备区域，框常跨边界） | `web/js/params.js` | — |
| 7 | 改为「8 次闭合手型检出（同一帧左右手各算一次；operating 帧里仅 1 帧）」 | `docs/signals.md`、`docs/equipment-detector.md` | — |
| 8 | `replaySingle` 新增 `gripHandsForSingle()`：`assignHands([person], hands)` 的槽位喂 `SignalEngine`；`ActionEngine` 仍用旧的整帧 `handState`，不动已发布的动作指标 | `web/test/evaluate.mjs` | `eval-test.mjs`：贴腕握拳 → operating；远离腕点的手不算这个人的 |

回归结果：

| 检查 | 结果 |
|---|---|
| `npm test` | 全过（12 个套件，0 失败） |
| `headless-check.mjs` | 通过，0 JS 错误（含 profile 切换） |
| `headless-multi.mjs` | 19/19 |
| `npm run shots` | 5/5 |
| 离线 A/B（老导出 `refuel-det-baseline.jsonl` + `refuel-equipment.json`） | 与修复前的 `refuel-det-baseline.report.md` 汇总段**逐字一致** |
| 确定性回放（10fps / 580 帧 / CPU ×2） | 两次逐帧内容 sha256 一致：`333409c6…f59bfd`。确认态 328 → **325**、确认率 0.994 → **0.984**；段级指标不变（operating 4/2/5、near_equipment 2/4/2） |

`#1` 确实改变了导出（旧基线 `aae4c098…` → 新 `333409c6…`），差异只在 3 帧的
`operating_boxes_confirmed/used`（t≈21s / 29s / 42s）：这 3 帧是「陈旧轨迹 + 一次新检出」，
修复后按设计不再确认。检出帧数、有人帧数、检测轮次与闪烁次数都不变。
