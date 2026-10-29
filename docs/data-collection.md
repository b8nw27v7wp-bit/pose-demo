# 采集与标注协议（R2）

这份文档只回答一件事：**怎样采一批数据，能支撑"动作判得准不准"的结论。**
没有它，`evaluate.mjs` 能算出数字，但数字的样本量、机位、人和反例都说不清，结论不成立。

> 采集前先确认：`docs/signals.md` 的 3D/2D 开关、`docs/eval.md` 的报告口径没有变化。
> 采集后第一件事是跑 `web/test/manifest-check.mjs`，不是先看准确率。

## 一、完成标准（硬门槛）

`web/test/manifest-check.mjs` 按下面的门槛判定"达标"：

| 维度 | 门槛 | 说明 |
|---|---|---|
| 每个动作正例 | ≥ 40 | 计数类按 `count` 求和，其余按标注段数 |
| 每个动作反例 | ≥ 20 | 含 `none` 段与 `!动作` 反例段 |
| 人物 | ≥ 2 人 | 必须有一个**没有参与调参**的人（留一验证） |
| 机位 | ≥ 2 个 | 至少正面 + 侧面 |
| 模型档位 | 记录 `full` / `lite` | 录制用 full + 30fps；量化时另跑 lite/15fps |

低于这个量，报告里的百分比没有统计意义。**反例不够时，precision 恒为 1，等于没测。**

## 二、设备与录制设置

- 手机或摄像头均可；固定机位（三脚架/靠墙），**不要手持**。
- 分辨率 1080p，帧率 30fps；录制时 Demo 选 `full` + `30 fps`。
- 人必须**完整入画**：头顶留一点空间，脚不能出画；距离见下表。
- 一次只录一个动作序列，动作之间留 **1~2 秒纯站姿**。
- 整段一口气录完，中途不要点「停止」：停止会重置滤波，后续帧的起止时间会偏（`docs/eval.md`）。

## 三、机位

| 机位 | 距离 | 要求 | 为什么 |
|---|---|---|---|
| `front` 正面 | 2.5~3 m | 镜头与胸同高，正对 | 正面看蹲是髋下沉，不是膝角 |
| `side` 侧面 | 2.5~3 m | 正侧，包含动作方向 | 侧面看蹲是膝角，是计数主用机位 |
| `oblique` 45° | 2.5~3 m | 斜前方 | 验证两种原语的过渡区 |
| `close` 近景 | 1.5 m | 上半身/全身 | 检查关键点精度与手部动作 |

机位值在 manifest 里只能写这四种（校验器会拒绝其他值）。

## 四、光照

| 光照 | 怎么拍 | 记录值 |
|---|---|---|
| 顺光 | 光源在镜头后方 | `front` |
| 逆光 | 窗户/灯在人物背后 | `back` |
| 弱光 | 关掉主灯，只留环境光 | `low` |
| 侧光 | 光源从一侧 | `side` |
| 混合 | 室内灯 + 窗光 | `mixed` |

弱光和逆光是关键点抖动的主要外部来源；三种至少各录一段（同一动作、同一机位）。

## 五、动作清单与次数

每个「人 × 机位」组合，每个动作录 **10~15 次**；2 人 × 2 机位 → 每动作 ≥40 次正例。

| 类别 | 动作 | 标注 action | 备注 |
|---|---|---|---|
| 姿态 | 站立 / 坐 / 下蹲 / 躺卧 | `stand` / `sit` / `squat_static` / `lying` | 每个姿态保持 2 s 以上 |
| 手臂 | 举手 / 挥手 / 抱臂 / 叉腰 / 张开双臂 / 双手高举 / 手在头部 | `armRaised` / `waving` / `crossed` / `onHips` / `armsOpen` / `bothHandsUp` / `handAtHead` | 每个动作做 2~3 s |
| 计数 | 深蹲 / 俯卧撑 / 鼓掌 | `squat` / `pushup` / `clap` | 一次一段，段内 `count` 写实际次数 |

**变形执行**（每个动作 5~10 次）也要录，并在 labels 里如实标：幅度更小、速度更快/更慢、手臂换一侧。
它们决定阈值留多少余量，不是"脏数据"。

## 六、反例（比正例更重要）

反例决定 precision。每个反例至少 5 次、2 个机位：

| 正例 | 容易混淆的反例 | 反例怎么标 |
|---|---|---|
| 举手 | 伸手拿高处东西 | `!armRaised` 或 `none` |
| 手在头部 | 摸头发 / 扶眼镜 / 走路手臂前摆 | `!handAtHead` |
| 叉腰 | 手插口袋 / 手自然下垂 | `!onHips` |
| 抱臂 | 抱文件夹 / 双手交叉放在身前 | `!crossed` |
| 鼓掌 | 双手合十 / 抱臂 | `!clap` |
| 深蹲 | 坐下 / 弯腰捡东西 / 单膝跪地 | `!squat` |
| 挥手 | 走路摆臂 / 整理头发 | `!waving` |
| 站立 | 靠墙 / 一只手撑桌 | `none`（如果连姿态也不该成立） |

标注语法（与 `docs/eval.md` 一致）：

- `none`：这段**不应出现任何姿态或手臂动作**（最严格的反例）；
- `!动作` 或 `expect: false`：这段该动作**不应成立**，其他动作不限；
- `noArm`：姿态不限，但不许有手臂动作（用于坐着但没叉腰）。

> 当前分支的评估器只原生支持 `none`、`!动作`、`expect:false`；`noArm` 的完整统计在 R1 合并后生效，
> manifest 校验器已经能识别并按手臂动作计反例。

## 七、文件命名与目录

```
eval-data/
  squat-side-A-01.mp4              原始视频（不入 git）
  squat-side-A-01.frames.jsonl     页面导出的帧（不入 git）
  squat-side-A-01.labels.json      人工标注（不入 git，除非你愿意共享）
  hardcase-<ts>.jsonl              判错了导出的难例
  hardcase-<ts>.labels.json
  manifest.json                    元数据清单（进 git，便于追踪进度）
```

命名建议：`<动作>-<机位>-<受试者>-<序号>`。同一条素材的帧与 labels 必须同名前缀。

## 八、manifest 字段

复制 `eval-data/manifest.example.json` 为 `eval-data/manifest.json`（或先跑 `--init`）：

```jsonc
{
  "version": 1,
  "clips": [
    {
      "clip": "squat-side-A-01.frames.jsonl",  // 必需，相对 manifest 所在目录
      "labels": "squat-side-A-01.labels.json", // 必需，覆盖度从它算
      "video": "squat-side-A-01.mp4",          // 可选，缺失只警告
      "camera": "side",                        // front|side|oblique|close
      "subject": "A",                          // 受试者编号，不是姓名
      "lighting": "front",                     // front|back|low|side|mixed|unknown
      "model": "full",                         // full|lite
      "fps": 30,
      "note": "深蹲 12 次，含 3 次半蹲变形"
    }
  ]
}
```

不要写姓名/身份证等身份信息；`subject` 用编号即可。

## 九、完整流程

```bash
# 0. 录之前：确认工具链是最新的
npm test

# 1. 录完，在 Demo 里导出帧（.jsonl），放进 eval-data/
# 2. 生成正例草稿
node web/test/autolabel.mjs --input eval-data/squat-side-A-01.frames.jsonl

# 3. 对着时间线改草稿，补 none / !动作 反例段
node web/test/evaluate.mjs --input eval-data/squat-side-A-01.frames.jsonl --timeline --every 5

# 4. 生成/更新清单，填 camera/subject/lighting/model/fps
node web/test/manifest-check.mjs --init --dir eval-data
#    已有 manifest.json 时手工追加条目

# 5. 检查采集是否达标（退出码 0 达标 / 2 覆盖不足 / 1 清单有错）
node web/test/manifest-check.mjs --manifest eval-data/manifest.json

# 6. 达标后再打分
node web/test/evaluate.mjs --dir eval-data --report eval-data/report.md
```

`--autolabel` 只生成正例，**不会生成 `none`**；反例必须人工补。草稿的 `count` 默认是实际计到的次数，
仍需按视频核对。

## 十、常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 只录正例，不录反例 | precision 永远是 1 | 每个动作至少 20 段反例 |
| 只用自己一个人 | 阈值拟合到自己身上，换人崩 | 至少两个人，留一人验证 |
| 只用一个机位 | 侧视/正视的差异被掩盖 | 正面 + 侧面各一组 |
| 动作之间不停顿 | 无法区分"漏判"和"没复位" | 每次动作后 1~2 s 纯站姿 |
| 录制中途点停止 | 滤波重置，起止时间偏 | 一口气录完 |
| 用 lite 录、用 full 调阈值 | 两档噪声不同，阈值不通用 | manifest 记录 model/fps，两个档位都跑 |
| 用合成样例定阈值 | `sample.*` 是链路自检，不是实拍 | 只用来验证工具，不产出准确率结论 |
| 帧文件被截断 | 长视频尾部缺帧，recall 失真 | 当前上限 20000 帧（约 11 分钟 @30fps），分段录 |

## 十一、隐私

- 视频与帧只存本地，不入 git（`.gitignore` 已排除 `eval-data/*`；manifest 只保留元数据）。
- 帧文件只含坐标与置信度，不含画面；但仍可能通过姿态识别到人，按敏感数据管理。
- 导出给外部时先脱敏：去掉 `subject` 的对应关系表，只保留编号。
