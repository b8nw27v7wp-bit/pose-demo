# 全量代码审核与文档同步（2026-11-17）

> **后续**：本文 C3~C8 的「记录/未处理」是当时快照；这些项已在同日接手轮处理，
> 结论与 A/B 见 `docs/round2-2026-11-17.md`。当前测试基线为 1152 项（16 套件）。

范围：`main` 分支当前工作区（`6209e98`，干净），包括 `web/js/*`、`web/test/*`、
`scripts/*`、`web/profiles/*`、`web/index.html`、`README.md`、`PLAN.md`、`docs/*.md`。
不包含 `web/vendor/`、`web/models/`、`data/`、`eval-data/`、`runs/` 与 `.venv*/`
（运行产物/权重/素材，不进 git）。

## 结论

- 没有发现崩溃、数据损坏或会让现有 1111 项回归直接失效的问题。
- 发现 **3 个可复现的代码缺口**：`evaluate.mjs` 的失败区间缺少新动作的关键信号映射；
  `signals.js` 在没有 `scale` 的旧数据上可能把尺度算成 `NaN`；工作区新增人物门的
  `gatePersonsByHand()` 读槽位方式错误，第二道门实际不执行。三者已修。
- 发现 **3 个行为级问题**，需要单独一轮 + 数据/浏览器验证，本轮只记录：
  整帧手部左右侧依赖 MediaPipe handedness、姿态估计器并发创建无代次保护、
  关闭物体检测后导出 meta 可能丢模型指纹。
- 文档与代码有 **10 处明确偏差**（动作数、准确率行数、测试数、数据集体积、
  手势稳定器作用域、`unknown` 语义、action 列表、PLAN 进度等），已全部同步。
- `PLAN.md` 自 2026-11-09 后没有记录 11-12~11-17 的改动，本轮新增 §19 现状快照，
  历史 §16/§17 保留为快照并加注。

## 验证基线

| 项 | 结果 |
|---|---|
| `git status --short` | 干净；`main` @ `6209e98` |
| `node --check` | 60 个 `.js/.mjs` 全部通过 |
| 全量单测 | **1111 项 / 0 失败**（15 个套件，逐项与 README 一致；geometry 58 项） |
| DOM id 交叉检查 | `app.js` 引用 59 个 id，`index.html` 全部存在；无悬空控件 |
| 页面级无头 | `headless-check` 通过（6 条 tooltip、7 行准确率、32 项难例下拉、零 JS 错误）；`headless-multi` 19/19 通过；`headless-ppe-onnx` 因本机缺 `eval-data/ppe-yolo/images/val` 未运行（既有环境问题，不是回归） |

## 发现总表

| # | 严重度 | 位置 | 问题 | 状态 |
|---|---|---|---|---|
| C1 | 中 | `web/test/evaluate.mjs` | 失败区间缺少 `oilSample` / `operating` / `nearEquipment` / 两个上半身姿态的信号映射，报告只剩时间没有证据 | 已修 |
| C2 | 中 | `web/js/signals.js` | 旧导出没有 `scale` 且几何退化时，`Math.max(person.scale, 1)` 产生 `NaN`，所有距离比值失效 | 已修 |
| C3 | 中 | `web/js/app.js` / `hands.js` / `multi.js` | 整帧手部左右侧仍按 MediaPipe `handedness` 填槽；普通视频（非自拍镜像）可能左右互换；ROI 补检已纠正，整帧路径没有 | 记录 |
| C4 | 中 | `web/js/pose.js` | `createEstimator` / `createMultiEstimator` 没有 `objects.js` 那样的 epoch；快速切模型/后端时旧实例可能泄漏或覆盖新实例 | 记录 |
| C5 | 低 | `web/js/app.js` | 导出 meta 的 `objects` 取决于当前 `objectOn`；录完后关掉物体检测再导出会丢模型指纹 | 记录 |
| C6 | 低 | `web/js/params.js` | `signals.grasp.releaseMs`、`actions.holds.handChest`、`signals.ppe.gloveHand.fallbackWrist` 无消费方 | 记录 |
| C7 | 低 | `web/js/params.js` | `perception.objects.roi.*`、`perception.multi.tileMode`、`signals.ppe.assignment` 是预留键，profile 写了不会生效 | 记录（注释已写“预留”） |
| C8 | 低 | `web/profiles/safety*.json` | `signals.track.maxLostMs=2000`，与默认 1500/PLAN §18.1 的约定不一致，没有 A/B 理由 | 记录 |
| C9 | 中 | `web/js/app.js` | 本轮工作区新增的 `gatePersonsByHand()` 从 `handsByTrack` 取到的是槽位 `{L,R,list}`，却用 `hs.length` 判断空，导致第二道人物门实际不执行 | 已修 |
| D1-D11 | 低 | README / PLAN / docs / IDEA | 动作数、准确率行数、测试数、数据集体积、手势稳定器作用域、unknown 语义、action 列表、进度记录等文档偏差 | 已修 |

## 代码问题说明

### C9 · 新增人物门的手部包含分支实际不执行（已修）

工作区新增的 `perception.personGate` 在 `app.js` 里由 `gatePersonsByHand()` 实现第二道门。
`handsByTrack` 的值是槽位 `{L, R, list}`，不是数组；原实现写：

```js
const hs = (handsByTrack && handsByTrack.get(p.track_id)) || ...
if (!hs?.length) continue;
```

槽位对象没有 `length`，所以正常路径每帧都 `continue`，第二道门没有生效。修法：

```js
const slot = handsByTrack?.get?.(p.track_id);
const hs = slot
  ? (Array.isArray(slot.list) && slot.list.length ? slot.list : [slot.L, slot.R].filter(Boolean))
  : (hands || []).filter((hd) => hd.owner_track_id === p.track_id);
```

验证：`node web/test/geometry-test.mjs` 58/58（纯函数门本身）；`headless-multi` 19/19
（开启 personGate 后双人轨迹仍为 2，未误杀）。手部包含分支的页面级效果还需要一段
「手+取样管」特写做 A/B，本轮没有该素材。

### C1 · 失败区间缺少新动作的关键信号（已修）

`SIGNALS_FOR` 是「报告里每个失败段展示哪些信号极值」的唯一映射。新增
`oil_sample` / `operating` / `near_equipment` 和上半身姿态时没有同步，导致这些动作的
FN/FP 段只有起止时间，没有 `min/中位/max`，无法判断「信号没到阈值」还是「阈值定错」。

修法：

- `SIGNAL_GETTERS` 增加 `near_equipment_overlap`；
- `SIGNALS_FOR` 增加 `upper_upright` / `upper_lean`（看 `uprightness`）、
  `oilSample`（`reach_head_*` + `azimuth_*`）、`operating`（`reach_*` + `elev_*`）、
  `nearEquipment`（`near_equipment_overlap`）。
- 验证：`node web/test/eval-test.mjs` 301/301 通过。

> 说明：`operating` 真正起决定作用的是 ROI/设备框命中与 gate（`not_near` /
> `no_grip` 等），这些是布尔/字符串，不是标量信号；失败段仍应结合导出帧的
> `signals.operating_gate*` 看。映射只负责把「手有没有伸到/抬到」的范围列出来。

### C2 · 缺 `scale` 时尺度变 NaN（已修）

旧导出/手搓帧没有 `person.scale` 时，`Math.max(undefined, 1)` 是 `NaN`；尺度进入所有
`距离 / scale` 信号后，`reach`、`hands_close`、`on_hips` 等全变 `NaN`，表现为「所有
手臂动作都不成立」。修法是先判断 `Number(person.scale)` 是否有限且 >0，否则退回 1。

这是防御性修复，不改变正常导出的结果；没有新增测试（正常路径已有 300 项逻辑单测覆盖）。

### C3 · 整帧手部左右侧依赖 handedness（记录，未改）

`hands.js` 明确写了：MediaPipe 的 `handedness` 假设输入是自拍镜像，普通视频会反过来。
腕部 ROI 补检已经用「检出腕点离哪个姿态腕点最近」纠正（`side_from='roi'`），但整帧
`toHands()` 仍直接写 `handedness`，`assignHands()` 也用它填 `slot.L/R`。影响：

- 左右手动作的逐侧 flag（`armRaisedL/R`、`reachingL/R`、`operatingL/R` 等）可能互换；
- 手势卡片的「左/右」可能互换；
- 聚合 flag（`armRaised`、`operating`）通常不受影响，除非判定本身依赖左右侧。

建议单独一轮：`assignHands` 用检出腕点到该人左右姿态腕点的距离决定槽位（ROI 路径已经
这么做），并补「handedness 标反」的回归；这会改变已发布指标，必须用实拍数据复跑
`npm run accuracy`，不要混在文档同步里顺手改。

### C4 · 姿态估计器并发创建（记录，未改）

`objects.js` 用 `epoch` 处理「创建期间被新请求取代」，`pose.js` 没有。快速切换
模型/后端时，两次 `createEstimator` 可能都完成，后完成的覆盖先完成的，先完成的那份
`landmarker` 没有 `close()`，占着 GPU/wasm 内存；`createMultiEstimator` 同理。
需要浏览器级回归（快速连点模型/后端），建议下一轮单独修。

### C5 · 导出 meta 的物体指纹（记录，未改）

`baseExportMeta()` 只在 `objectOn` 为真时写 `objects`。如果录完一段带设备框/PPE 的数据后
手动关掉「物体」再导出（或检测器自动失败后开关被关），meta 会丢 `modelHash` /
`labelsHash`，事后无法证明这份数据用的是哪个检测器。建议像 `activeModel` /
`activeHandModel` 一样保留 `lastObjectMeta` 快照。

### C6/C7 · 无消费方的参数键（记录）

- `signals.grasp.releaseMs`（注释说“张手后多久确认放下”）没有代码读取；
- `actions.holds.handChest` 没有代码读取；
- `signals.ppe.gloveHand.fallbackWrist` 没有代码读取（手未检出时总是退回腕点方框）；
- `perception.objects.roi.*`、`perception.multi.tileMode`、`signals.ppe.assignment`
  在 `params.js` 注释里已注明是预留键，本轮继续标注「预留」，不假装已生效。

建议下一轮二选一：实现并补单测，或删除键并在 docs 中说明。不要保留「写了但没用」的
配置项——这类静默失效比报错更难查。

### C8 · safety 档的 `maxLostMs`（记录）

`safety.json` / `safety-ppe.json` 设 `signals.track.maxLostMs=2000`，默认 1500；
PLAN §18.1 要求「统一回 1500 或写清差异理由」。没有实拍 A/B 前，本轮不改行为，
只在 PLAN §19 记录为待拍板项。

## 文档同步清单

| # | 文件 | 原内容 | 修正 |
|---|---|---|---|
| D1 | `README.md` 开头 | 2 姿态 + 13 手臂 + 1 上下文 + 8 手势 + 2 计数 | 按注册表写：2 静态姿态 + 2 上半身推断 + 6 面板手臂 + 3 隐藏可标注 + 5 已下线 + 1 上下文 + 8 手势 + 1 在用计数（拿取）+ 1 已下线计数（鼓掌） |
| D2 | `README.md` 准确率段 | 展开 6 项（5 个作业动作 + 在设备旁） | 展开 7 项（6 个面板手臂动作 + 在设备旁） |
| D3 | `README.md` 单测说明 | 动作提示 14 个动作 / 面板 5 个 | 15 个注册动作 / 面板 6 个 |
| D4 | `README.md` 无头检查 | 5 条 tooltip、6 行准确率 | 6 条 tooltip、7 行准确率 |
| D5 | `README.md` 开源素材 | `fetch:data` 约 280MB | 默认子集约 120MB，完整子集约 280MB（与 `docs/open-datasets.md` 一致） |
| D6 | `docs/signals.md` | 手势稳定器写「左右手各一个实例（全局 L/R/U）」 | 按 `track_id` 各一套 L/R/U（`TrackShapeStabilizers`），先归属再分类 |
| D6b | `docs/signals.md` | 逐侧 flag / 上半身可用动作清单漏项 | 补 `oilSampleL/R`、`operatingL/R`、油样取样 |
| D7 | `docs/frame-schema.md` | `unknown` 段写「动作层只区分闭合/非闭合」 | 已按 `openShapes/pointShapes/closedShapes` 分组；判不出时弃权 |
| D7b | `docs/frame-schema.md` | operating 保持窗只写 800ms | 注明默认 800ms、refuel 覆盖 1500ms |
| D8 | `docs/eval.md` | action 表漏 `oilSample`；计数没有标 `clap` 已下线；逐侧 flag 漏项；失败信号映射漏项 | 全部补齐，并与 `evaluate.mjs` 的 `SIGNALS_FOR` 对齐 |
| D9 | `docs/open-datasets.md` | 多处写「10 个动作」 | 改为「当前动作注册表里的动作」，不写死数量 |
| D10 | `IDEA.md` | 动作字典仍是站立/坐/蹲/躺/挥手/深蹲计数/俯卧撑计数 | 改为当前动作集，并注明已下线项 |
| D11 | `PLAN.md` | 自 11-09 后无进度记录，§16.2 的 11-05 快照易被误当现状 | 新增 §19 现状快照（注册表、1111 项、11-09~17 落地、阻塞项、预留键）；§16.2 加「11-05 快照，当前见 §19」 |

## 修改文件

- `web/js/signals.js`：缺 `scale` 时退回有限数。
- `web/js/app.js`：修复工作区新增 `gatePersonsByHand()` 的槽位读取 bug。
- `web/js/geometry.js`：删除未使用的 `PERSON_ANCHORS` 常量。
- `web/js/params.js` / `web/test/geometry-test.mjs`：本轮工作区已有的 personGate 参数与
  8 项纯函数测试（不是本次新增功能；审核后补文档、修手部包含分支）。
- `web/test/evaluate.mjs`：补失败区间信号映射。
- `web/js/actions.js`：修正「计数只剩鼓掌」的过期注释。
- `README.md`、`PLAN.md`、`IDEA.md`、`docs/frame-schema.md`、`docs/signals.md`、
  `docs/eval.md`、`docs/open-datasets.md`：文档同步（含新增 personGate 说明）。
- `docs/code-review-2026-11-17.md`（本文件）、`docs/round2-2026-11-17.md`（接手轮）。

## 回归结果

```text
node web/test/geometry-test.mjs      58 通过
node web/test/equipment-test.mjs     26 通过
node web/test/operating-test.mjs     34 通过
node web/test/sampling-test.mjs      15 通过
node web/test/logic-test.mjs        300 通过
node web/test/armhint-test.mjs       44 通过
node web/test/accuracy-test.mjs      37 通过
node web/test/eval-test.mjs         301 通过
node web/test/hardcase-test.mjs      46 通过
node web/test/autolabel-test.mjs     19 通过
node web/test/manifest-test.mjs      23 通过
node web/test/multi-test.mjs        106 通过
node web/test/onnx-test.mjs          31 通过
node web/test/ppe-test.mjs           52 通过
node web/test/ppe-eval.mjs --self-test 19 通过
合计 1111 项，0 失败
```

语法检查：60 个 `.js/.mjs` 通过 `node --check`。

页面级（serve.py 8799，本机无头 Chrome）：

```text
node web/test/headless-check.mjs "http://127.0.0.1:8799/web/?src=/data/pose-test-vp8.webm"
  → 通过：零 JS 错误、6 条动作 tooltip、7 行准确率、32 项难例下拉、1440×900 无滚动
node web/test/headless-multi.mjs "http://127.0.0.1:8799/web/?src=/data/pose-test-two.webm"
  → 19 / 19 通过
node web/test/headless-ppe-onnx.mjs
  → 未运行：本机缺 eval-data/ppe-yolo/images/val（既有环境问题，不是代码回归）
```

## 未覆盖 / 下一轮建议

1. **C3 手部左右侧**：先用一段已知左右手的实拍素材做 A/B，再决定是否把 `assignHands`
   改成「最近姿态腕点」；改完必须重跑 `npm run accuracy`。
2. **C4 估计器并发**：加 epoch + 快速切换的 headless 回归。
3. **C5 导出物体指纹**：加 `lastObjectMeta`，并补「录完关物体再导出」的断言。
4. **C6/C7 参数键**：实现或删除；删除会改变 `params_hash`，需在发布说明里写清。
5. **C8 maxLostMs**：用 MOT17 慢放做 1500/2000 A/B，再统一。
6. 页面级无头（`headless-check` / `headless-multi`）已在本轮通过；`headless-ppe-onnx`
   需要在有 `eval-data/ppe-yolo/images/val` 的机器上补跑。`npm run shots` 与
   `mot17-eval` 没有在本轮重跑。
