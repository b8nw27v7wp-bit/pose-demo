# 多人跟踪 · 物体检测 · PPE

2026-11-02 落地。这一层回答两个问题：**画面里有几个人、各自判什么**，以及**人身上有没有那件东西（安全帽/手套）**。

结论先说：多人是"每帧多框 + 自研 id"，物体检测是"另一条感知流水线"，PPE 是"几何归属 + 时间门槛"。三者都不改动作规则本身，只是把「一个人一条流水线」变成「N 个人 N 条」。

---

## 一、多人：为什么必须自己写跟踪

MediaPipe PoseLandmarker 的 **VIDEO 模式只返回一个人**（实测 `numPoses=2` 时 `max_persons` 恒为 1）。所以多人只能走 IMAGE 模式逐帧独立推理，代价是丢掉模型内部的帧间跟踪——id 得自己维护。

`web/js/track.js`

| 机制 | 取值 | 理由 |
|---|---|---|
| 匹配主线索 | IoU ≥ 0.25 | 同一人相邻帧必然重叠，最可靠 |
| 兜底 | 中心距离 ≤ 0.8×身高 | 快速移动时 IoU 可能变 0；用身高归一化才能跨远近通用。MOT17 4 序列 A/B：0.6→0.8 使 ID 切换 61→58，TopK 召回不变 |
| 身高校验 | 0.6 ~ 1.67 倍 | 同一个人身高不会突变，用它挡掉"一前一后换 id" |
| 丢失保留 | `maxLostMs` 1500 | 太短会频繁换 id（计数清零），太长会让旧状态续到新人身上 |

分配是**全局贪心**（所有配对按相似度排序后依次占位），不是每个轨迹各取最优——两人交叉时后者会抢同一个框，换人更频繁。

`web/js/multi.js`

- 每人一对独立的 `SignalEngine` + `ActionEngine`。这两个类里全是**有记忆**的部件（One Euro、Hold 计时、计数相位、换侧滞回），共用一套就会出现"A 的计数相位被 B 的角度信号打断"。
- 同一 track 缺席超过 `gapMs`（1000ms）回来时重建状态机：旧滤波状态和旧计数相位都不该续上。
- 手部按"手部 wrist(0) 到该人左右腕关键点的距离 / 躯干长"归属（`assignHands`），超出 0.8 直接丢弃。用像素距离会系统性偏向离镜头近的人。

### 实测（本机，无头 Chrome，data/pose-test-two.webm 470×540 / 3s）

| 项 | 结果 |
|---|---|
| VIDEO 模式 numPoses=2 | 恒 1 人（这是必须走 IMAGE 模式的原因） |
| IMAGE 模式 numPoses=3，detConf 0.5 | **1 人**（远处那个人被检出置信度过滤掉） |
| IMAGE 模式 numPoses=3，detConf 0.3 | **2 人**（CPU 与 GPU 一致），命中率稳定的时间点 0.28s / 1.48s / 2.68s |

所以多人估计器的 `detConf/presenceConf` 默认取 **0.3**，不是单人道的 0.5。这条差异写在 `pose.js` 里，改阈值前先看这里。
现在这两个值可以在 profile 的 `perception.multi.detConf/presenceConf` 里覆盖，用 `npm run eval:mot17` 对比召回/误检。

**远/小目标**：整帧缩到模型输入后远处的人只剩几十像素。`perception.multi.tiles: 2` 会把画面切成
2×2（`tileOverlap` 控制重叠）逐块推理再按 bbox 去重，等于把人放大。默认关（约 4 倍耗时）；
MOT17 实测对夜景/远景提升很大、对拥挤近景提升有限且误检上升，见 `docs/open-datasets.md` §四。

---

## 二、物体检测：另一条流水线

`web/js/objects.js`（适配层）→ `web/js/ppe.js`（判定）

- 两条后端，输出统一成 `{label, score, box:[x1,y1,x2,y2]}`，与 `person.bbox` 同口径，判定层不必区分来源：
  - `backend: "mediapipe"`（默认）：MediaPipe Tasks `ObjectDetector`，任何满足 Tasks 格式的 `.tflite` 都能换。先上 EfficientDet-Lite0（Apache-2.0，COCO 80 类）验证链路。
  - `backend: "onnx"`：`web/js/objects-onnx.js` + onnxruntime-web，吃 Ultralytics 导出的 YOLOv8 ONNX（`[1, 4+nc, N]`，逐类别 NMS）。给自训的安全帽/手套、阀门/仪表模型用，训练/导出步骤见 `docs/ppe-training.md` 与 `docs/equipment-detector.md`。设备类别还可以被 `operating` / `near_equipment` 用作物体证据（见 `docs/signals.md`）。
- **标签来源不同**：MediaPipe 从模型 label map（`categoryName`）读；ONNX 没有 label map，必须由 profile 的 `perception.objects.labels` 按训练时 `data.yaml` 的**顺序**给出。顺序写错不会报错，只会把类别张冠李戴——`headless-ppe-onnx.mjs` 会检查 `no_helmet` 有没有被当成 `helmet`。
- **ONNX 推理是异步的**：视频循环里不能 await（会卡住 rAF），`app.js` 用"同一时刻只跑一帧 + 上一帧结果"的方式，PPE 用到的框最多晚一帧；图片路径会 await。

### 三个实测坑（都写进了代码注释）

1. **GPU delegate 会 trap。** efficientdet_lite0 在 GPU 上 `createFromOptions` 成功，第一次推理从 wasm 抛 `RuntimeError: divide by zero`；更糟的是**这个 trap 会把整个 wasm 运行时搞坏**——之后在同一页面再建任何 MediaPipe 实例都会挂。因此：
   - `perception.objects.delegate` 默认 `CPU`（不跟工具栏的 GPU/CPU 走）；
   - `createObjectDetector` 建好后用一张纯黑小图**自检一次**，抛异常就降级，避免得到"能加载、永远不出框"的检测器。ONNX 后端同理，用 zeros 跑一次自检。
2. **官方模型源在国内不通**（`storage.googleapis.com` 连不上）。`scripts/fetch-assets.py` 改成每个模型多源，按序回退，efficientdet 首选 jsdelivr 镜像。
3. **onnxruntime-web 必须固定版本、本地放 wasm**。`web/vendor/` 不进 git，用 `node scripts/fetch-ort.mjs` 复制 `ort.wasm.bundle.min.mjs` + `ort-wasm-simd-threaded.wasm`；静态服务器没有 COOP/COEP，ORT 会自动退回单线程。

---

## 三、PPE：三条必须写死的语义

1. **看不见 ≠ 没戴。** 头/腕不可见、类别没配、整场没检出过正例，一律 `unknown`。
2. **单帧漏检不算违规。** 连续 `missing` 超过 `minMs`（默认 3s）才升级；`worn` 立即清零；`unknown` **暂停**计时（不清零）——人一转身帽子被挡住，不该让他已经积累的 2.9 秒重新开始。
3. **手套默认只报「疑似」。** 手是运动目标、尺寸小、常被遮挡，"没检出"与"没戴"在视觉上不可区分。要升级成违规必须在 profile 里显式写 `policy: "violation"`。

另外 `requirePositive: true` 是一道防误报的护栏：本场从未检出过该类正例时只报 `unknown`。模型类别名写错（例如模型里叫 `helmet_on`、配置里写 `helmet`）不会变成"全场都没戴"，而是"配置有问题"。

### 几何

| 区域 | 判定 | 兜底 |
|---|---|---|
| 头部 | 优先用 9 个头面部关键点（鼻/眼/耳，`persons[].kp_head`）定框：取可见眼/耳，左右两侧都要有点，按均值剔离群点，`half = max(headBoxScale×躯干长, 0.6×展宽)` 并向上覆盖帽檐 | 脸点不足/单侧 → 鼻尖 + `headBoxScale×躯干长`（旧几何）；鼻尖也不可见 → 人框顶部 22% 高、45% 宽，`visible=false` |
| 腕部/手套 | 优先手部 21 点 bbox + `gloveHand.pad`（默认 0.15）外扩；左右侧按最近姿态腕点绑定，不信任 handedness | 手未检出/未归属 → 腕点 + `gloveBoxScale×躯干长` 方框；腕不可见 → `unknown` |

头部 `source` 取 `face | nose | bbox`；手套每侧 `source` 取 `hand | wrist | none`，并带 `side_from`
（`slot | nearest_wrist | handedness | pose`）。这些字段会写进 `verdicts[].ppe`，便于离线审计。
旧导出没有 `kp_head` 时自动走鼻尖路径，行为与旧版一致。

归属判据是"检测框中心落在区域内"且分数 ≥ `minScore`。刻意不用 IoU：安全帽框通常比头部框小很多，IoU 会把正确的帽子判掉。

---

## 四、数据契约

`pushLog()` 每帧新增两个字段，**老字段完全不变**（`signals/actions` 仍是主目标的判定），所以旧流程不受影响。多人导出时 `persons[]` 是**全部判定人员**（每人一条，`[0]` 仍是主目标）；单人导出仍是 1 条。`persons[].kp_head`（可选，9 点）供 PPE 头部区域使用，旧导出没有它时退回鼻尖：

```json
{
  "persons": [ ... 全部判定人员 ... ],
  "signals": { ... }, "actions": { ... },
  "verdicts": [
    { "track_id": 2, "bbox": [...], "posture": "stand", "flags": {...}, "reps": {...},
      "ppe": { "helmet": {"state":"missing","alert":"violation","streak_ms":3200,
                           "source":"face","box":[200,80,280,160]},
               "glove":  {"state":"unknown","alert":"none","streak_ms":0,
                           "L":{"state":"worn","source":"hand","side_from":"slot"}} } }
  ],
  "objects": [ { "label": "person", "score": 0.87, "box": [38,10,202,515] } ]
}
```

多人时 `verdicts` 是**所有人**（含主目标），`signals/actions` 仍只是主目标。评估器已有逐 track 口径：按 `label.track`（uid 优先）回放，汇总按 `(track, action)` 出行，见 `docs/eval.md`「多人素材」。

---

## 五、怎么开

| 方式 | 操作 |
|---|---|
| 手动 | 工具栏勾「多人」（可选 2/3/4 人上限）、勾「物体」 |
| 场景档 | profile 里写 `perception.multi.enabled` / `perception.objects.enabled`，切档即生效 |
| 例子 | `web/profiles/safety.json`（安全合规档：多人 3 + 物体 + PPE，头盔 3s 升违规、手套只报疑似） |

`?profile=/web/profiles/safety.json` 直接进安全档。

### 单人道漏检补救（`perception.single.fallback`）

VIDEO 模式的检测阈值是 0.5，半身、贴边、被设备挡住的人经常整帧 0 人。补救打开后，
**仅在这一帧**用 IMAGE 模式（detConf 0.3）再检一次，按 `fallbackMinScore` 过滤后交给
同一条动作流水线；正常帧仍走 VIDEO 模式（模型内跟踪更稳），所以只在漏检帧多付一次推理。
IMAGE 估计器是懒加载的，建失败会记住失败、不每帧重试（与多人开关失败同一个坑）。

在 `eval-data/refuel/oil-sample-demo.mp4`（480×272 / 58s，大量半身与特写）上实测：
**无判定帧 772 → 546（−29%）**；代价是特写段会多出一些「手/设备被当成上半身」的误检
（2.0~5.6s 段 17 → 26 帧）。它提高的是**检出率**，不是动作正确率——动作数字仍须标注。

---

## 六、验证与已知限制

```bash
npm run test:multi     # 106 项：跟踪 id 稳定/防换 id/超时、流水线隔离、手部归属、PPE 语义与时序、face/hand 区域、平铺几何、运动/外观/最优分配
npm run serve -- 8799
node web/test/headless-multi.mjs "http://127.0.0.1:8799/web/?src=/data/pose-test-two.webm"
                       # 19 项：真模型真视频，双人轨迹、物体框、safety 档、零 JS 错误
node web/test/headless-ppe-onnx.mjs   # 自训 PPE ONNX：后端/labels/负类语义（见 docs/ppe-training.md）
npm run eval:mot17     # MOT17 gt 帧级评测：TopK 召回、ID 切换、动作触发率（见 docs/open-datasets.md §四）
node web/test/mot17-eval.mjs --rate 0.4 --fps 15   # 慢放逐帧：做 A/B 必须用这个（见下，fps 要固定）
```

### 跟踪 A/B 的测量噪声（重要）

实时播放评测时，25fps 视频 + 15fps 推理上限，应用每次丢的帧不同，**同一配置重复跑**
ID 切换会在 56~70 次之间跳（约 ±2 个百分点）。拿这种数字做小步调参会把噪声当成改进。

`--rate 0.4` 把视频降到 10fps，应用能处理每一帧；同一配置重复跑的结果稳定得多，但**不是完全确定**：
实测同配置多次总计 72/72/75/90/93 次切换，波动来自个别帧的跳过/GPU 负载。因此：
**A/B 必须串行、机器空闲时跑，并用 `--fps` 固定推理上限**（下表都是当时默认 15fps 下测得；
30fps 上限会在同一个视频帧内多处理几次，09 序列 25→29）。单臂最好重复 ≥2 次。
2026-11-04 用慢放逐帧（6 序列、约 800 对）复测：

| 配置 | ID 切换 |
|---|---|
| centerMax 0.6 + greedy + 3 人 | 72/797（9.0%） |
| centerMax 0.8 + greedy + 3 人（当前默认） | 72/810（8.9%） |
| centerMax 0.8 + greedy + 4 人 | 75/807（9.3%） |
| centerMax 0.8 + 外观重连 | 81/807（10.0%） |
| centerMax 0.8 + optimal 分配 | 82/818（10.0%） |

结论：外观重连/最优分配都略差；centerMax 0.6/0.8、3 人/4 人没有可测差异。
实时模式下的 ~15% 主要是**丢帧**造成的（同一序列 05 实时 18/157，慢放 18/280；切换次数没变，
对数翻倍），不是匹配规则的问题。想继续降 ID 切换，优先提推理吞吐/减少丢帧，而不是继续调门控。

### 吞吐：15fps 上限和物体检测是主要瓶颈

`web/test/throughput-probe.mjs`（`npm run probe:throughput`）真模型真视频测各阶段耗时
（`window.__pose.state.timing` 是 EMA 毫秒）。本机 i7-12700H + RTX 3050 无头 Chrome：

| 配置（MOT17-05，640×480） | 实测处理 | 每帧 total | pose | hands | objects |
|---|---:|---:|---:|---:|---:|
| 15fps 上限 · 多人3+手部 | **13.6 帧/s** | 33ms | 17.5 | 14.4 | – |
| 30fps 上限 · 多人3+手部（当前默认） | **25.3–26.4 帧/s** | 25–27ms | 12.6–13 | 12–13 | – |
| 30fps · 多人3·手部关 | 26.9 帧/s | 14.7ms | 14 | – | – |
| 30fps · 多人3+手部+ONNX 物体（worker） | **26.4 帧/s** | 25.4ms | 12.6 | 12 | 0.46（摊薄） |
| 30fps · 同上但 ORT 主线程（旧） | 8.2 帧/s | 43ms | 22 | 19 | 2.5（实际阻塞 ~100ms/帧） |
| 30fps · MediaPipe efficientdet（CPU，150ms 降频） | 18.3 帧/s | 43ms | 14.1 | 12 | 15.5（摊薄） |
| 30fps · 1080p（MOT17-02） | 25.6 帧/s | 28ms | 15.1 | 11.8 | – |

三个改动：

1. **默认推理上限 15fps → 30fps**。15fps 在 25/30fps 素材上丢掉约一半帧——这正是实时
   ID 切换虚高的原因。30fps 下应用能处理 25fps 素材的每一帧；弱机达不到上限会自然回落。
   工具栏仍可手动选 10/15/30。
2. **ORT 物体检测改到 Web Worker**（`ort.env.wasm.proxy = true`）。之前 wasm 同步占用主线程，
   姿态循环被拖到 9~11fps；worker 化后帧率恢复到 ~26fps。注意 proxy 会**转移**输入 buffer，
   每帧必须传一份拷贝（否则第二帧就报 `Tensor's size ... does not match data length(0)`）。
3. **物体检测降频**（`perception.objects.intervalMs`，默认 150ms）。PPE 是 3 秒级时序判定，
   不需要每帧检测；MediaPipe efficientdet 同步一次 ~54ms，降频后对象耗时摊薄到 ~21ms。
   ONNX worker 后端摊薄后只有 ~0.5ms，但降频仍能省 CPU。
4. **无人的帧跳过手部推理**：手只能归属到人，动作/PPE 都按人分组；04 夜景几乎每帧都没人，
   以前白跑 HandLandmarker ~13ms/帧。
5. **换 profile 会重建物体检测实例**（后端/模型可能从 mediapipe 变 onnx）。以前 `objectReady`
   还是 true 就直接沿用了旧后端。无头脚本在改开关前要等 `state.profileLoaded`，否则会先按
   默认参数把 mediapipe 检测器建出来，profile 里的 onnx 永远不生效（实测会把 28fps 测成 18fps）。

仍慢的场景：MediaPipe efficientdet（CPU 同步）在 30fps 下约 20fps（降频后）。PPE 建议直接用
ONNX 后端（~28fps）；efficientdet 只用于 COCO 通用物体演示。

> ONNX 的 `session.run` 在 worker 里实测约 **96ms/次**（`state.objectInfo.runMs`），
> 150ms 间隔约 2/3 占空比。`state.timing.objects` 只测到主线程提交（~0.5ms），
> 不能当推理成本——吞吐脚本会同时输出 `objectRunMs`。

**已实测**：双人视频 2 条轨迹 + 2 条独立判定；物体检测 4 个框（person/bus）；PPE 在 COCO 模型下全部 `unknown`（正确：COCO 没有安全帽类别，护栏生效）；无 JS 异常；自训 YOLOv8n 冒烟模型在浏览器里跑通 ONNX→PPE（helmet 判定 `worn`）。设备检测器（panel/valve/gauge）也在 refuel 58s 演示片上跑通 ONNX→`operating`：590 帧里 310 帧有设备框，页面无 JS 错误；同输入 A/B 让 `operating` 从 3/3/3 变成 3/3/2，8 段硬负例从 6/8 触发降到 0/8（`docs/equipment-detector.md`）。

**未验证**：

- 冒烟模型只有 623 张训练图、mAP50 0.40，和本项目机位差异大——PPE 的实拍准确率仍是 **0 个数字**。
- 多人时的速度：30fps 上限下，多人 3 + 手部约 26 帧/s；再开 ONNX 物体检测仍是 ~26（worker）；
  开 MediaPipe efficientdet 会掉到 ~16。帧率不足会加大 id 抖动，具体数字用 `npm run probe:throughput` 测。
- 手部 ROI 补检按预算给面积最大的前 `min(perception.multi.maxPersons, signals.hand.roi.maxPersonsPerFrame)`
  人做（主目标优先，默认 2 人；`scale < minScalePx` 跳过），其余人只有整帧检出的手。
- 多人 + PPE 的评估口径（按 track 的 recall/precision、跨机位退化）还没接进 `evaluate.mjs`。
- 一个人长时间离开再回来会拿到新 track_id，计数从 0 开始——这是刻意的（宁可重置，不续旧状态），但没有做长期 re-id。
