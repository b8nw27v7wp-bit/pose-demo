# 开源验证素材

本项目自己的实拍数据一直是空白（`PLAN.md` §12.2 根因 #1）。在做不到立即实拍的阶段，
用开源数据集能回答一类问题：**链路在真实画面上是不是还成立**（人能不能检出、多人能不能分开、
检测框对不对得上身体）。它回答不了另一类问题：**在你的机位/工装/光照下准不准**——那只能用自己拍的数据。

素材不进 git（体积 + 许可），用脚本下载子集，可复现：

```bash
npm run fetch:data                                  # 默认子集，约 120MB（本机完整子集约 280MB）
npm run fetch:data -- --mot17-frames 600 --helmet-images 120
npm run fetch:data -- --skip-mot17                  # 只要 PPE 图
```

等价的直接调用：`python scripts/fetch-eval-data.py ...`（Windows 上没有 `python` 命令时用 `py`）。

下载目标：`eval-data/open/`（已在 `.gitignore` 里），清单写 `eval-data/open/MANIFEST.json`。

---

## 一、选了什么，为什么

| 数据集 | 内容 | 许可 | 在这儿干什么 |
|---|---|---|---|
| [Lekim89/MOT17](https://hf-mirror.com/datasets/Lekim89/MOT17) | MOT17 原始结构（帧序列 + gt + 三份公共检测） | **CC BY-NC-SA 3.0（非商用）** | 多人跟踪：街上多人行走、交叉、出画，自带 gt 框 |
| [Chapian/PPE_detection](https://hf-mirror.com/datasets/Chapian/PPE_detection) | 9 类：boots / gloves / hardhat / no_boots / no_gloves / no_hardhat / no_vest / person / vest | Roboflow 导出，`data.yaml` 写 **CC BY 4.0** | **唯一带 gloves 与 no_gloves 的开源 PPE 源**，正好对应用户问的手套 |
| [phat06/Safety-helmet-dataset](https://hf-mirror.com/datasets/phat06/Safety-helmet-dataset) | 7,035 图 + YOLO 标注 | **MIT** | 安全帽的第二独立来源，用来看"换一份数据是否还成立" |
| [vikasaarna/roboflow-construction-ppe-fruwx](https://hf-mirror.com/datasets/vikasaarna/roboflow-construction-ppe-fruwx) | 4,460 图 + YOLO 标注 | **MIT** | 真实工地采集，分布与上面两份不同 |

**因为 gated 没能自动下载**（需要人工申请权限，值得申请）：

| 数据集 | 内容 | 许可 | 为什么值得申 |
|---|---|---|---|
| [ersace/IITU_Safety-Helmet_Dataset_v1.0](https://huggingface.co/datasets/ersace/IITU_Safety-Helmet_Dataset_v1.0) | 1,664 图，无人机 3~5m / 10~15m、0°/45°/90°、含夜间 | CC BY 4.0 | **俯拍 + 夜间**正好是工业机位的两种典型难例 |
| [IswaryaS/Aerial-PPE-Construction-Safety](https://huggingface.co/datasets/IswaryaS/Aerial-PPE-Construction-Safety) | 航拍 PPE | CC BY-NC-ND 4.0 | 塔吊/高机位视角 |

---

## 一·五、本机实际拿到的子集（2026-11-04，约 280MB）

`npm run fetch:data` 默认只下一部分。当前 `eval-data/open/` 的实际内容是：

| 数据集 | 本地文件 | 图片 / 标注 | 类别 | 能干什么 |
|---|---|---|---|---|
| MOT17（6 条 FRCNN 序列） | `mot17/*.mp4` + `img1/` + `gt/gt.txt` | **1319 帧 / gt 全有** | 标准 MOT 类别（1=行人） | 多人跟踪、gt 帧级评测 |
| MOT17-02 / 05 | 各 299 / 300 帧 | 拥挤街景 / 俯拍广场 | 同上 | 近景多人、交叉 |
| MOT17-04 / 09 / 10 / 13 | 各 180 帧 | 夜景商业街 / 广场 / 室内 / 夜景 | 同上 | 低光、远景、不同机位 |
| Chapian/PPE_detection | `PPE_detection/{train,test}/{images,labels}` | **200 / 200**，2953 框 | 9 类 | 手套/未戴手套的**冒烟**数据，带留出 test |
| phat06/Safety-helmet | `Safety-helmet-dataset/Phat_project-3/{train,valid,test}` | **338 / 338**，1294 框 | 2 类，**类别名未知** | 安全帽的跨来源冒烟 |
| vikasaarna/construction-ppe | `roboflow-construction-ppe-fruwx/data/{train,valid,test}` | **337 / 337**，1879 框 | 8 类 | 真实工地 PPE 冒烟 |

类别分布（`npm run report:ppe`，只读；train+valid+test 合计）：

```
PPE_detection (200 图)
  boots 330, gloves 203, hardhat 469, no_boots 156, no_gloves 400,
  no_hardhat 176, no_vest 471, person 622, vest 126

Safety-helmet (338 图)
  class 0: 364 框, class 1: 930 框   ← 没有 data.yaml，类别名未知

construction-ppe (337 图)
  boots 510, helmet 381, helmet on 79, no boots 31, no helmet 62,
  no vest 94, person 376, vest 346
```

**先看清三件事再谈训练：**

1. **construction-ppe 原来只有图、没有 label**（`fetch-eval-data.py` 之前只下图片）。
   现在图片和 label 成对下载；中断/限流后可用 `npm run fetch:data -- --repair-labels`
   只补缺的 label（本次补了 59 个）。
2. **Safety-helmet 的类别名没下来**。上游仓库没有 `data.yaml`，label 只有 `0/1`。
   抽一张画框目测：0 更像裸头、1 更像戴帽，但**不能拿目测当类别表**，训练前必须回源确认。
3. **241 / 282 / 200 张训练图仍然只够冒烟/微调**，不能据此承诺模型准确率。
   要训安全帽就下全量（7,035 张 / 4,460 张），要训手套得再找一份手套数据
   （当前 PPE_detection 有 203 个 glove 框）。

## 二、许可红线（先看清楚再决定拿来干什么）

- **MOT17 是非商用**（CC BY-NC-SA）。拿它做研究、做验证报告、做毕设没问题；
  一旦进商业交付或客户现场验收素材，就必须换成自有数据或商用许可数据。
- PPE 两份 MIT 的可以商用，但**数据集许可 != 模型许可 != 你对客户承诺的准确率**。
  用它们训出来的模型，交付前要在自己的机位上重测（`docs/eval.md` 的口径）。
- 下载子集 ≠ 拿到商用授权。要用于产品，逐个回原始站点核对许可原文。

---

## 三、这些素材能验什么、不能验什么

| 想验的 | 用哪份 | 能不能得出结论 |
|---|---|---|
| 多人骨架能不能同时出、id 稳不稳 | MOT17 合出来的 mp4 | 能（画面里天然多人、有交叉） |
| 遮挡/远景下人还能不能检出 | MOT17 远景/夜景序列 | 能出帧级数字：`npm run eval:mot17`（TopK 召回、ID 切换） |
| 站/坐/蹲/躺、举手/挥手/抱臂/叉腰/张开双臂/手在头部/伸手/持物/指向 | **全部不能产出准确率**（MOT17 全是行走；PPE 是静态图） | 这些数据里**没有动作标注**，只能统计"动作触发率"查明显误报；要数字只能自己拍 + 标 `docs/data-collection.md` |
| 安全帽/手套**模型训练** | Safety-helmet / construction / PPE_detection | 能训，但本机子集 241/282/200 张训练图只够冒烟/微调；见 §一·五 |
| 安全帽/手套**判定逻辑** | PPE 三份图 | 当前 COCO 模型认不出 helmet/glove，只能验链路；训完模型才谈得上数字 |
| 换机位/换人群是否退化 | 两份 MIT 源交叉 | 能（两份分布不同） |

一句话：**素材是"尺子的底片"，不是"准确率"**。没有动作标注、没有你自己的机位，
它只证明链路能跑，产不出那 10 个动作的 recall/precision。

---

## 四、用它们跑一遍

```bash
npm run serve -- 8799
node web/test/headless-open-data.mjs "http://127.0.0.1:8799/web/"   # 自动跑一遍并出数字
```

`headless-open-data.mjs` 对每段素材报：采样到的最大/中位人数、轨迹数、物体框数、fps、JS 错误。
它验证的是"链路能跑 + 画面里真的有多人"，**不产出 recall/precision**。

数据配没配齐、类别名有没有、每类多少框，用只读脚本单独看：

```bash
npm run report:ppe                               # 本机子集的图片/label/类别分布
```

### 实测（2026-11-04 复跑，本机无头 Chrome，safety 档 = 多人3 + 物体检测）

| 素材 | 分辨率/时长 | 帧数 | 人数 max/中位 | 轨迹 max | 框 max/中位 | fps |
|---|---|---|---|---|---|---|
| MOT17-02-FRCNN（拥挤街景） | 1920×1080 / 12s | 109 | 3 / 1 | 4 | 8 / 5 | 8.4 |
| MOT17-05-FRCNN（俯拍广场） | 1920×1080 / 12s | 102 | 2 / 1 | 5 | 6 / 4 | 8.8 |
| PPE 图（带人） | 640×640 | 单帧 | 2 | — | 3 | — |
| PPE 图（只有安全帽特写） | 640×640 | 单帧 | 0 | — | 1 框（COCO 认不出帽，只出 person 类别的邻近框） | — |
| 工地 PPE 图 | 640×640 | 单帧 | 1 | — | 3 | — |

帧数/fps 随模型预热与机器状态波动（上一轮同机同素材是 53/55 帧、3.7~5.2 fps），
**不要把这个数当成性能基准**；它只说明链路在真实 1080p 多人画面上能跑。

要点：

- 无头环境 fps 在 **3.7~8.8** 之间波动（1920×1080 + 图像模式多人 + 手部 + 物体同开），
  真机会好一些但别指望流畅；这个数不是性能基准。
- 人数中位数是 1、最大值 2~3：MOT17 里人时进时出，**这正是要验证的情形**（id 不能乱）。
- 物体框全部来自 COCO 80 类（person/bus 之类），**不是安全帽**。PPE 三份图现在只能证明"物体检测这条路能跑"，
  要出"戴没戴"必须先把 helmet/glove 模型训出来换进 `web/models/`。

### 这一轮实跑暴露并修掉的 4 个 bug（都是"只有真实数据才看得见"的）

1. **图片输入 + 多人 = 全空**：多人/物体模型是在视频主循环里懒加载的，图片路径没触发，
   `analyzeStill` 直接调 `detectMultiImage` → "not ready" 抛错 → 整张图零判定。修法：图片路径先 ensure。
2. **图片的物体检测模式不匹配**：检测器建在 VIDEO 模式，图片路径却调 `detectObjectsImage`（IMAGE 模式专用）→ 抛错被静默吞掉。
   改成 `detectObjectsVideo(img, ts)`。
3. **`state.objects` 永远 0**：图片路径把结果写在局部变量里，没写回 `lastObjects`，无头检查读不到。
4. **导出/日志的 `video_time` 记晚了**：`pushLog` 原来读推理结束后的 `currentTime`；多人推理一轮
   几十到几百毫秒，按帧对齐 gt 会系统性错位。改成用推理开始前记下的 `lastVideoTime`。

### MOT17 gt 帧级评测（`npm run eval:mot17`）

现在可以把 MOT17 的 gt 接进来，出帧级人框指标。它不是动作准确率，但能回答
"姿态模型 + 跟踪器在真实多人画面上到底检出多少人、id 稳不稳"，也是调 `detConf` / 平铺 / 跟踪阈值的依据。

```bash
npm run serve -- 8765                 # 另开一个终端
npm run eval:mot17                    # 6 条序列全跑，约 3 分钟
npm run eval:mot17 -- --seq MOT17-02-FRCNN --debug
npm run eval:mot17 -- --iou 0.3 --topk 3
npm run eval:mot17 -- --model heavy
# 指定 profile（Git Bash 会把 /web/... 开头的参数转成 Windows 路径，这里用完整 URL）
npm run eval:mot17 -- --profile http://127.0.0.1:8765/web/profiles/safety.json
```

指标口径（`web/test/mot17-eval.mjs`）：

- **召回/精确**：逐帧把 app 的 `verdicts` 框与 gt 的 class=1/conf=1 行人框按 IoU 贪心匹配。
  gt 先按画面裁剪；可见面积不足原框 30% 的行人转入 ignore（不算漏检、也不算误检）。
- **TopK 召回**：每帧只取 gt 面积最大的 K 人（默认 3），对应 app 的 `numPoses` 上限。
- **ID 切换 / 碎片轨迹**：同一 gt 人在相邻匹配帧之间 track_id 变化次数；一个 gt 人对应过 >1 个 app id 的个数。
- **动作触发率**：MOT17 没有动作标注，只统计各动作在"人-帧"里亮起的比例，用于发现明显误报，**不是准确率**。

2026-11-04 本机基线（full/GPU，`numPoses=3`，`detConf=0.3`，整帧推理）：

| 序列 | 帧 | TopK召回 | 精确 | 检出/帧 | Top1最佳IoU | ID切换/对数 |
|---|---|---|---|---|---|---|
| MOT17-02（拥挤街景） | 172 | 23.3% | 64.0% | 1.15 | 0.36 | 24/119 |
| MOT17-04（夜景商业街） | 105 | **0.3%** | 22.2% | **0.09** | 0.00 | 0/0 |
| MOT17-05（俯拍广场） | 174 | 29.5% | 80.7% | 1.22 | 0.26 | 13/157 |
| MOT17-09 | 105 | 26.3% | 83.7% | 1.23 | 0.48 | 16/100 |
| MOT17-10 | 105 | 23.5% | 70.5% | 1.00 | 0.49 | 9/71 |
| MOT17-13（夜景） | 105 | **4.2%** | 25.0% | 0.53 | 0.07 | 5/6 |
| **合计** | **766** | **19.4%** | **69.9%** | **0.92** | **0.28** | **67/453** |

- 原始召回（全人群）只有 3.1%：拥挤帧有几十人，app 最多 3 人，**这个数字天然低**，看 TopK 才有意义。
- **夜景是最大的失败场景**：04/13 整帧推理几乎检不出人（04 只有 9 个"人-帧"），不是跟踪器的问题。
- 动作触发率：举手 0.7%、双手高举 0.7%、叉腰 0.4%、手在头部 0.1%，其余 0.0%、判定冻结 1.7%。
  数值很低，只能说明"在行走人群上没有大面积误报"；检出的人少，不能当准确率。

> **这批数字是实时播放跑出来的，ID 切换的重复性很差。** 25fps 视频 + 15fps 推理上限，
> 每次丢的帧不同，同一配置重复跑会在 56~70 次切换之间跳（约 ±2 个百分点）。
> 做 A/B 必须加 `--rate 0.4` 慢放逐帧（应用能处理每一帧），复测结果见
> `docs/multi-and-objects.md` §六：centerMax 0.6/0.8、3 人/4 人都没有可测差异；
> 外观重连与 optimal 分配反而略差（+9~10 次）。实时数字里的 ~15% 主要来自丢帧：
> 序列 05 实时 18/157 对、慢放 18/280 对——**切换次数没变，是对数翻倍**。

### 平铺检测：把远处的人放大再推理（`perception.multi.tiles`）

整帧 1920×1080 缩到模型输入后，远处行人只剩几十像素——这是 04/13 检出率极低的主因。
`tiles=2` 把画面切成 2×2（默认 20% 重叠），逐块推理、坐标映射回整帧后按 bbox 去重，
等于把人放大 2 倍。默认关闭（成本约 4 倍），在 profile 里开：

```json
"perception": { "multi": { "enabled": true, "tiles": 2, "tileOverlap": 0.2 } }
```

同机对比（裁剪后的 gt；02 拥挤街景 / 04 夜景）：

| 配置 | 02 TopK | 02 精确 | 02 检出/帧 | 04 TopK | 04 精确 | 04 检出/帧 |
|---|---|---|---|---|---|---|
| full 整帧, detConf 0.3（默认） | 23.3% | 64.0% | 1.15 | 0.3% | 22.2% | 0.09 |
| full 2×2, detConf 0.3 | 24.9% | 43.3% | 2.58 | **16.5%** | 29.9% | 2.45 |
| full 2×2, detConf 0.4 | 22.2% | 44.7% | 2.33 | 14.7% | 38.7% | 1.74 |
| heavy 整帧, detConf 0.3 | 26.2% | 76.0% | 1.19 | 0.0% | 13.6% | 0.23 |
| full 整帧, detConf 0.15 | 27.9% | 58.2% | 1.53 | 1.0% | 13.2% | 0.90 |

结论：

- **平铺对夜景/远景增益巨大**（04 的 TopK 0.3% → 16.5%），代价是误检上升、耗时约 4 倍；
  拥挤近景 02 只提升 1.6 个点，精确率从 64% 掉到 43%。
- **降低 detConf 不是免费的**：0.15 让 02 的 TopK +4.6 点，但精确率 -5.8 点、ID 切换变多；
  04 仍然几乎不可用。默认保持 0.3。
- **heavy 模型**在 02 上更准（TopK +2.9、精确 +12），但更慢，04 仍然 0%——夜景不是换个模型能解决的。
- 平铺目前只做了跨块 bbox 去重，没有置信度校准/NMS；要进生产，先在自己的机位上验证开关和误检率。
- MOT17 是非商用许可，这些数字只用于研究与阈值校准，不能直接写进商业验收报告。


---

## 五、后续要接的事（没做）

1. ~~把 MOT17 的 gt 接进评测~~ → **已做**：`npm run eval:mot17`（见上）。
   现在的口径只有人框（TopK 召回/ID 切换），**动作层仍没有众包/自拍的帧级标注**，
   动作 recall/precision 不能从 MOT17 得到。
2. **PPE 模型**：
   - 训练数据要下全量，当前 241/282/200 张只够冒烟：
     `npm run fetch:data -- --helmet-images 1000 --site-images 1000`
   - **先确认 Safety-helmet 的类别名**（当前子集没有 `data.yaml`，只有 0/1）；
     construction 的 `no boots/no helmet/no vest` 与 PPE_detection 的 `no_boots/no_hardhat` 命名不一致，训练前要统一。
   - 训练路径二选一：
     a) **MediaPipe Model Maker** 训 EfficientDet-Lite0，导出的 `.tflite` 带 Tasks metadata，`objects.js` 能直接加载；
     b) **Ultralytics YOLO** 训练 + 导出 TFLite——**注意：Ultralytics 的 TFLite 没有 Tasks metadata，
        `objects.js` 加载不了**，需要在 JS 里自己写解码/NMS，或放到服务端。
   - 训完别忘了改 profile 的 `signals.ppe.classes`，并在自己机位上重测。
3. **动作数据（唯一能产出那 10 个动作准确率的路）**：现有开源素材都没有动作标注。
   自己按 `docs/data-collection.md` 每个动作拍 20~30 次、正/侧两个机位，Demo 导出 → 自动标注草稿 →
   人工补反例 → `npm run accuracy`，页面上的「准确率」才会从「未评估」变成实测值。
   Kinetics/UCF101/HMDB51 只有**片段级**标签（而且类目对不上这 10 个动作），要接也得先做帧级标注，成本不比自拍低。
