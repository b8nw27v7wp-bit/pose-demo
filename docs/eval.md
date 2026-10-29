# 评估与阈值拟合

PLAN §12.3 的 A（评估集）与 B（阈值拟合）落地在这份文档 + `web/test/evaluate.mjs`。
**没有这一步，"动作不准"永远是感觉，不是数字。**

## 一轮完整流程

```bash
# 1. 录素材（这一步只能人来做：摄像头前做动作，录屏或用 Demo 上传视频）
#    Demo 里点「导出」得到 .jsonl（一行一帧），放到 eval-data/a.jsonl

# 2. 生成标注草稿：正例由当前规则给出，人只改边界
node web/test/evaluate.mjs --input eval-data/a.jsonl --autolabel --out eval-data/a.labels.draft.json

# 3. 改草稿 → 正式 labels（见下）
#    对着 --timeline 改边界、删误报，**补反例段**
node web/test/evaluate.mjs --input eval-data/a.jsonl --timeline --every 5

# 4. 复算 + 打分
node web/test/evaluate.mjs --dir eval-data --report eval-data/report.md

# 5. 看报告：每动作 recall/precision、失败区间、关键信号极值
node web/test/evaluate.mjs --dir eval-data --min-recall 0.9 --min-precision 0.85 --max-count-err 1
# 6. 未达标退出码 2，可直接进 CI
```

不带 `--dir` 也可以单段跑：

```bash
node web/test/evaluate.mjs --input eval-data/a.jsonl --labels eval-data/a.labels.json --json
```

`--dir` 同时认 `.json`（旧版 `{frames}` 容器）和 `.jsonl`（当前导出格式）；
`*.labels.json` 与 `*.labels.draft.json` 不会被当成帧文件。

想先确认工具本身是好的，用合成样例（**不是实拍，不能用来定阈值**）：

```bash
node web/test/make-sample.mjs
node web/test/evaluate.mjs --dir eval-data
```

## 报告包含什么

按顺序：

1. **按动作汇总**：TP / FN / FP、recall 与 precision（Wilson 95% 区间 + n）、计数误差
2. **门槛**：配置了 `--min-recall` / `--min-precision` / `--max-count-err` / `--baseline` 时
3. **姿态混淆矩阵** + **手臂共现矩阵**
4. **分组统计**（按 `camera` / `subject`）与跨组退化
5. **事件时延与抖动**
6. **逐段明细与失败区间**
7. **灵敏度扫描**（`--sweep`）
8. **信号分位**（`--fit`）

只想看汇总和失败段时，前 6 项就是一轮完整评估的全部输出；后两项按需开启。

## 自动生成标注草稿

```bash
node web/test/evaluate.mjs --input eval-data/a.jsonl --autolabel --out eval-data/a.labels.draft.json
```

- **只产出正例**：姿态、手臂 flag、计数周期（计数段带 `count`，起点取进入 down 相位那一帧）。
- 合并窗口 500 ms、丢弃短于 300 ms 的碎片，把 Hold/streak 造成的 1~2 帧断裂接回去。
- **反例必须人工补**：`none` / `!动作` / `noArm`。规则不知道"当时其实在做什么"，
  自动生成反例等于拿自己的判断给自己的准确率打分。
- 草稿自评应当全通过（同一套规则生成、同一套规则打分）。如果出现失败，说明草稿的时间边界写错了，
  先修 `autoLabelClip`，不要改阈值。

## labels 文件格式

```json
{
  "name": "squat-side-01",
  "camera": "side",
  "subject": "甲",
  "lighting": "顺光",
  "note": "自拍 · 侧面 · 3 米",
  "segments": [
    { "action": "stand",  "startSec": 0.0,  "endSec": 2.0 },
    { "action": "squat",  "startSec": 2.1,  "endSec": 5.0, "count": 3, "tol": 0 },
    { "action": "stand",  "startSec": 5.2,  "endSec": 7.0 },
    { "action": "armRaised", "startFrame": 70, "endFrame": 92 },
    { "action": "!onHips", "startSec": 7.5, "endSec": 9.0 },
    { "action": "noArm",   "startSec": 9.0, "endSec": 12.0 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `startSec` / `endSec` | **推荐**。视频播放秒数，与导出帧的 `video_time` 同基准 |
| `start` / `end` | 毫秒，与 frames 的 `ts` 同基准（`performance.now`），非必要别用 |
| `startFrame` / `endFrame` | 帧序号（0 起，frames 数组下标） |
| `action` | 见下表；加 `!` 前缀表示反例 |
| `expect` | 可选布尔。`false` 等价于 `!动作`；显式写 `true` 不能把 `none`/`noArm` 变成正例 |
| `count` | 仅计数类：这段时间内**期望**完成几次 |
| `tol` | 仅计数类：允许误差，正例默认 1；反例默认 0 |
| `camera` / `subject` / `lighting` / `note` | 可选。报告逐段回显；`camera`/`subject` 是后续分组统计与留一人验证的键 |

三种时间写法按 `startSec` → `start` → `startFrame` 的优先级取。

### action 取值

| 类别 | 取值 |
|---|---|
| 姿态 | `stand` / `sit` / `squat_static` / `lying` |
| 手臂 | `armRaised` / `waving` / `crossed` / `onHips` / `armsOpen` / `bothHandsUp` / `handAtHead` |
| 计数 | `squat` / `pushup` / `clap` |
| 复合反例 | `none` —— 姿态和手臂都不得出现（人不在场 / 完全无动作） |
| 手臂反例 | `noArm` —— 姿态不限，但不得出现任何手臂动作 |
| 单动作反例 | `!动作` 或 `expect:false` —— 只要求这一个动作不出现 |

**反例是 precision 的唯一来源。** 只标正例，报告里的 precision 永远是 1，等于没测。

反例怎么写，取决于你想声明什么：

| 想声明 | 写法 | 说明 |
|---|---|---|
| 站着但没叉腰 | `{"action":"!onHips", "startSec":..,"endSec":..}` | 只否定叉腰；站立本身不算错误 |
| 站着手臂自然下垂 | `{"action":"noArm", ...}` | 姿态任意，但不能有任何手臂动作 |
| 这段时间什么都没做（人不在场/静止） | `{"action":"none", ...}` | **注意**：站着会被判成 `stand`，`none` 段必然失败。它适合空镜/无人，不适合"人在场但没动作" |
| 坐下过程中不许计深蹲 | `{"action":"!squat", ...}` | 计数反例：期望 0 次，多计一次就是 1 个 FP |
| 站立时乱计数也要算 | 标 `none` 段 | `none` 窗口内的计数增量会让该段失败，并归到对应动作的 FP |

`none` 与 `noArm` 的差别：`noArm` 不把站立/坐下当成错误，也不追究计数；`none` 什么都不允许，并把窗口内的计数误报算进去。

## 指标口径

- **每个动作单独报** recall / precision，不报总体准确率（会被容易的动作稀释，PLAN §12.4）
- 计数类报**每 N 次的误差**，不报"准确率"
- recall 只统计正例段；precision 的 FP 来自反例段（`!动作` / `none` / `noArm`）以及 `none` 窗口内的乱计数
- 反例段**不参与**阈值分位拟合（它描述的是"不该出现"的状态，不是动作本身的信号分布）
- 跨机位按 labels 的 `camera` 字段分组报告（正面 vs 侧面差多少），跨人按 `subject`

### 置信区间（Wilson 95%）

每个 recall / precision 后面都带 `[下界–上界] (n)`：

- n 小或比例接近 0/1 时，正态近似的区间会越界，Wilson 不会。
- 段与段之间**并不独立**（同一段视频里高度相关），所以这是近似。
  但它能阻止"3 段素材 → 100%"这种自我欺骗：3 段里全对，区间大约是 `[0.44–1.00]`。
- `n` 是 recall 的 TP+FN、precision 的 TP+FP。**先看 n，再看比例。**

### 混淆矩阵与手臂共现

- **姿态**是互斥的，报告里给出**帧级混淆矩阵**：行是标注，列是判定，对角线是判对，最后一列是行召回。
- 真值来源：正例姿态段 → 该姿态；`none` 段 → `none`；`!姿态` 段**不参与**（它只否认一个姿态，
  其余姿态是什么并不知道）。同一帧被两个不同姿态段覆盖 → 标为**冲突**并跳过，这是标注错误，不算模型错。
- **手臂**是多标签（可以同时成立，例如挥手必然同时是举手），做不了混淆矩阵，
  因此给出**共现矩阵**：`matrix[i][j]` = 第 i、j 个动作同时为真的帧数。它回答"哪些动作总是一起报"。
- 手势（R7）还没有评估语法，暂不进入矩阵。

### 分组统计

labels 里写 `camera` / `subject`，报告会分别给出：

- 每组一张按动作的汇总表（带 CI）；
- **跨组退化**：每个动作在各组之间的 recall / precision 极差。
  只统计有名字的组；`(未标注)` 不参与极差，否则等于拿未知当对照组。
- 只有一个组、或全是 `(未标注)` 时，这一节不渲染。

## 报告里的失败区间

每个失败段都带证据，不用先看视频就能判断问题出在哪一层：

| 证据 | 回答什么 |
|---|---|
| 起止秒 + 帧号 | 回放时直接跳到这一帧 |
| 关键信号的 min / 中位 / max | 信号根本没到阈值，还是阈值定错了 |
| 漏判的 `observed` | 当时实际判成了什么（常见是串判到相邻姿态） |
| 误报的 `falseAlarms` | `!动作` 只记该动作（不牵连同时成立的 stand）；`noArm` 记抢占的手臂 flag；`none` 记所有在跳的姿态/flag。汇总时 FP 记到它们头上 |

关键信号按动作选：姿态看 `uprightness / knee / leg_vertical`，抬臂看 `elev_* / elev_torso_*`，
抱臂/鼓掌看 `hands_close`，叉腰看 `reach_*`。完整映射见 `evaluate.mjs` 的 `SIGNALS_FOR`。

## 事件时延与抖动

报告里的 `## 事件时延与抖动` 回答两个问题：

- **时延**：正例段的标签起点 → 该动作第一次判定为真，单位 ms。段开始时已经成立记 0。
  姿态类大多为 0（标注起点时动作往往已经成立），真正有含义的是事件类（倒地、举手、挥手）。
  只统计**通过**的正例段：漏判没有「首次为真」，反例也没有起点。
- **抖动**：该动作从 off 变 on 的次数 ÷ 已标注素材总分钟数。
  翻转次数与标注无关，所以没标注的动作也能看出抖不抖；一次误报也会计入翻转。

注意：

- 时延和抖动按**动作**汇总，不按机位拆；分组看 recall/precision 就够了。
- 抖动统计的是整段素材，不只是标注段。
- 翻转的合并语义：连续 on 采样永远合并，off 间隙 ≤ `mergeMs` 才接回去。
  （之前默认 `mergeMs=0` 会把每一帧 on 都拆成一个区间；判定只用 overlap 所以看不出来，
  但翻转次数会直接失真——这是加抖动指标时暴露出来的 bug，已修。）

## 阈值拟合（B 阶段）

```bash
node web/test/evaluate.mjs --dir eval-data --fit --report eval-data/report.md
```

报告最后一节是**按标注动作段分组**的信号分位。举例：

- 深蹲下阈 `down`：看 `squat_baseline/knee` 的 **P5**（蹲到底那部分的最小角度）
- 深蹲上阈 `up`：看 `stand/knee` 的 **P5**（站直时的最低角度）
- 两个阈值不要贴着分位写，各留 10~15° 余量，否则滤波器稍慢一点就漏计

拟合出来的值写进 profile（`web/profiles/*.json` 的 `params` 段），不要改源码。

## 用 profile 跑

```bash
# 评估时套用 profile
node web/test/evaluate.mjs --dir eval-data --profile web/profiles/fitness.json

# 页面上套用
http://127.0.0.1:8765/web/?profile=/web/profiles/fitness.json
```

profile 只写**与默认值的差异**，其余走 `web/js/params.js` 的 `DEFAULT_PARAMS`。
导出 JSON 里会带上 `profile`、`params` 与 `params_hash`，便于事后确认"这份数据是哪套阈值跑出来的"。

### profile 的 model 字段

profile 可以声明这套阈值是在哪个姿态模型档位下校准的：

```json
{ "name": "fitness", "model": "lite", "params": { ... } }
```

- `lite` 与 `full` 的关键点噪声不同，**用 full 拟合的阈值拿到 lite 上可能漏计**。
- 页面加载后，若 profile 声明与实际运行的模型不一致，工具条上的 profile 标签会标黄并在状态栏提示。
- 评估时若数据 meta 里的 `model` 与 profile 的 `model` 不一致，报告头部会给出警告。
  这不是错误（仍然能跑），但此时报告里的数字不能当成"这套阈值在目标档位上的表现"。

## 门槛（可直接进 CI）

```bash
# 绝对门槛
node web/test/evaluate.mjs --dir eval-data --min-recall 0.9 --min-precision 0.85 --max-count-err 1

# 相对基线：任何动作比上次下降超过 0.05 就失败
node web/test/evaluate.mjs --dir eval-data --json > base.json
node web/test/evaluate.mjs --dir eval-data --baseline base.json --max-drop 0.05
```

- 只判定**有数据**的动作（recall/precision 为 null 的跳过），否则只有误报、没有正例的动作会永远失败。
- 未达标：报告里列出门槛表，进程退出码 **2**（和「有段没通过」一致）。
- `--baseline` 读的是 `--json` 导出的报告（需要 `summary` 数组）。
- **别把基线文件放进 `--dir` 目录**：目录扫描会把任何 `.json` 当成帧文件，空文件会直接报错。
- 基线只比较 recall / precision 的下降；计数误差用 `--max-count-err` 的绝对上限。

## profile A/B 对比

```bash
node web/test/evaluate.mjs --dir eval-data \
  --compare web/profiles/a.json web/profiles/b.json --report eval-data/ab.md
```

- 同一批帧只读一次，换参数重放两遍；**Δ = B − A**。
- 报告含两套参数指纹、每动作指标差、以及**判定发生变化的段**（哪一段从通过变失败）。
- 这是信息性对比，不设退出码门槛；要卡门槛请对选定 profile 用上面的单次评估。
- `--compare` 不接受 `--profile` / `--fit` / `--sweep` / 门槛参数，避免「以为生效了其实没生效」。

## 灵敏度扫描

```bash
node web/test/evaluate.mjs --dir eval-data --sweep actions.reps.squat.down
node web/test/evaluate.mjs --dir eval-data --sweep actions.posture.stand.kneeGt --sweep-actions stand
```

- 把该数值参数扰动 ±10% / ±20%，每个值完整重放一遍，报出**指标发生变化的动作**。
- 整数参数会取整并去重（`streak=3` 的 ±10% 都回到 3，不会拿同一个值跑两遍）。
- 只列有变化的动作；`--sweep-actions` 可强制列出指定动作。
- 代价是 N 倍重放（基准 + 4 个变体 ≈ 5 倍评估时间），长素材上要有心理准备。
- 用途：找出「一动就崩」的脆弱阈值。掉得最多的阈值应该先回头看信号本身，而不是继续调数。

## 已知限制

- 评估复算是**离线**的：滤波与短窗状态跨帧保留，但如果导出时中途「停止」过，滤波会重置，起止时间会偏；
  录素材时一口气录完，中间别停。
- `replay()` 依赖导出里的 `persons[0].kp`（像素坐标）。如果导出被截断（旧版本 `MAX_LOG=600`），
  长视频的尾部会缺帧；当前版本上限 20000 帧。
- 合成样例（`make-sample.mjs`）只验证链路，不构成任何准确率结论。

## 录素材时先知道这几件事

这几条是跑合成数据时暴露出来的，直接影响你怎么录、怎么标：

1. **自然下垂的手可能被判成「叉腰」**。`on_hips` 判据是「腕到同侧髋 < 0.65·scale」，
   而人站着时手本来就在髋旁边。合成站姿的腕距髋只有 0.19·scale，直接命中。
   录的时候注意手臂放松位置，标注时把「站着没叉腰」标成反例段 `{"action":"!onHips"}`（或整段 `noArm`），
   否则这个动作的 precision 永远算不准。**不要**用 `none`：站着一定会被判成 `stand`，`none` 段必然失败。
2. **`--timeline` 是你标注时的主工具**，不是评估工具。录完先跑：
   ```bash
   node web/test/evaluate.mjs --input eval-data/a.jsonl --timeline --every 5
   ```
   表里有视频秒数、膝角、直立度、抬臂角、当前姿态、计数和手臂标志，
   对着播放器数秒就能写出 labels，不用猜。
3. **视频秒比 `ts` 好用**。导出帧带 `video_time`（视频播放秒数），labels 就写 `startSec`/`endSec`。
   `ts` 是 `performance.now`，只适合同一进程内复算，不适合人对时间。
4. **一次录一个动作，中间留 1~2 秒纯站姿**。动作之间有干净的「无动作」间隔，
   才能区分「漏判」和「判定粘住没复位」——这两者的修法完全不同。
5. **反例比正例重要**。只录「抱臂」不录「站着没抱臂」，precision 永远是 1，等于没测。
