# 评估与阈值拟合

PLAN §12.3 的 A（评估集）与 B（阈值拟合）落地在这份文档 + `web/test/evaluate.mjs`。
**没有这一步，"动作不准"永远是感觉，不是数字。**

## 一轮完整流程

```bash
# 1. 录素材（这一步只能人来做：摄像头前做动作，录屏或用 Demo 上传视频）
#    Demo 里点「导出 JSON」得到 frames 文件

# 2. 标注（见下）
#    eval-data/a.frames.json  +  eval-data/a.labels.json

# 3. 复算 + 打分
node web/test/evaluate.mjs --dir eval-data --report eval-data/report.md

# 4. 看图消费：按动作的 recall / precision / 计数误差，以及失败段
```

不带 `--dir` 也可以单段跑：

```bash
node web/test/evaluate.mjs --input eval-data/a.frames.json --labels eval-data/a.labels.json --json
```

想先确认工具本身是好的，用合成样例（**不是实拍，不能用来定阈值**）：

```bash
node web/test/make-sample.mjs
node web/test/evaluate.mjs --dir eval-data
```

## labels 文件格式

```json
{
  "name": "squat-side-01",
  "source": "自拍 · 侧面 · 3 米",
  "segments": [
    { "action": "stand",  "startSec": 0.0,  "endSec": 2.0 },
    { "action": "squat",  "startSec": 2.1,  "endSec": 5.0, "count": 3, "tol": 0 },
    { "action": "stand",  "startSec": 5.2,  "endSec": 7.0 },
    { "action": "armRaised", "startFrame": 70, "endFrame": 92 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `startSec` / `endSec` | **推荐**。视频播放秒数，与导出帧的 `video_time` 同基准 |
| `start` / `end` | 毫秒，与 frames 的 `ts` 同基准（`performance.now`），非必要别用 |
| `startFrame` / `endFrame` | 帧序号（0 起，frames 数组下标） |
| `action` | 见下表 |
| `count` | 仅计数类：这段时间内**期望**完成几次 |
| `tol` | 仅计数类：允许误差，默认 1 |

三种时间写法按 `startSec` → `start` → `startFrame` 的优先级取。

### action 取值

| 类别 | 取值 |
|---|---|
| 姿态 | `stand` / `sit` / `squat_static` / `lying` |
| 手臂 | `armRaised` / `bothHandsUp` / `waving` / `crossed` / `onHips` / `armsOpen` / `handAtHead` / `reaching` / `carrying` / `pointing` / `armFront` / `armSide` |
| 计数 | `squat` / `pushup` / `clap` / `grasp` |

动作名也接受 `ARM_ACTIONS` 里的 id（`arm_raised` / `reach` / `carry` / `point` …），
两种写法等价，评估器内部会归一。
| 反例 | `none` —— 这段时间内**不应**出现任何姿态或手臂动作（用来量误报） |

`none` 是 precision 的唯一来源。只标正例，报告里的 precision 永远是 1，没有意义。

## 指标口径

- **每个动作单独报** recall / precision，不报总体准确率（会被容易的动作稀释，PLAN §12.4）
- 计数类报**每 N 次的误差**，不报"准确率"
- recall 只统计标了该动作的段；precision 的分母包含 `none` 段里出现的误报
- 跨机位要分开跑，并在报告里对比（正面 vs 侧面差多少）

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
导出 JSON 里会带上 `profile` 与 `params`，便于事后确认"这份数据是哪套阈值跑出来的"。

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
   录的时候注意手臂放松位置，标注时也把「站着没叉腰」当成反例段（`action: "none"` 或额外标一段 `onHips` 的反例），
   否则这个动作的 precision 永远算不准。
2. **`--timeline` 是你标注时的主工具**，不是评估工具。录完先跑：
   ```bash
   node web/test/evaluate.mjs --input eval-data/a.frames.json --timeline --every 5
   ```
   表里有视频秒数、膝角、直立度、抬臂角、当前姿态、计数和手臂标志，
   对着播放器数秒就能写出 labels，不用猜。
3. **视频秒比 `ts` 好用**。导出帧带 `video_time`（视频播放秒数），labels 就写 `startSec`/`endSec`。
   `ts` 是 `performance.now`，只适合同一进程内复算，不适合人对时间。
4. **一次录一个动作，中间留 1~2 秒纯站姿**。动作之间有干净的「无动作」间隔，
   才能区分「漏判」和「判定粘住没复位」——这两者的修法完全不同。
5. **反例比正例重要**。只录「抱臂」不录「站着没抱臂」，precision 永远是 1，等于没测。
