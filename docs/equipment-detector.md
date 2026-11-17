# 阀门/仪表检测器：训练与接入

`operating` 的「物体证据」现在有两条：

1. **人工 ROI**（`signals.arm.operating.roi` 矩形或 `rois` 多边形）——固定机位圈出的设备区域；
2. **设备检测框**（`signals.arm.operating.equipmentLabels`）——自训 panel/valve/gauge 检测器。

仓库**不附带**训练好的权重（`web/models/` 不进 git），但训练数据构建、训练、导出、
sidecar、profile 接入与验收的完整流程在本仓库跑通过一遍。下面的数字来自 2026-11-11 的
冒烟模型：训练用的是 **同一段 58s refuel 演示片**的分镜框 + RF100 gauge 数据集，
属于同集验证，**不是泛化准确率**。

## 1. 现状（冒烟模型）

| 项 | 值 |
|---|---|
| 训练集 | `eval-data/equipment/ds-all/`：train 261（refuel 103 + RF100 158，含 22 张背景负例）/ val 38（refuel 13 + RF100 25） |
| 类别 | `panel` / `valve` / `gauge`（顺序即 `data.yaml` 的 names） |
| 模型 | YOLOv8n，416 输入，batch 16，50 epoch，CPU 约 0.30h |
| 验证集指标 | P 0.783 / R 0.694 / mAP50 **0.692** / mAP50-95 0.413 |
| panel | P 0.945 / R 1.0 / mAP50 0.995（val 13 个实例） |
| gauge | P 0.621 / R 0.388 / mAP50 0.39（val 237 个实例，RF100） |
| valve | **val 里 0 个实例**（两个留出分镜都没阀门），无法报指标 |
| 导出 | `web/models/equipment.onnx`（12.1MB，320 输入，输出 `[1,7,2100]`，opset 12） |
| sidecar | `web/models/equipment.onnx.json`（labels / inputSize / sha256 / data.yaml 哈希） |

实测检出情况（refuel，590 帧，`perception.objects.intervalMs=150`）：
310 帧有设备框，其中 panel 261 帧、valve 49 帧、**gauge 0 帧**（仪表太小，320/0.35 检不到）。
框的定位可用，但不是每帧都有；`equipmentFallbackRoi=true` 时必须依赖 ROI 兜底。

> 下面的脚本/数据集/报告都在 `eval-data/` 下，和 `record-clip.mjs` 一样**不进 git**
> （素材与训练产物体积大、含实拍影像）。仓库保留的是流程、参数和可复现命令；
> 换机器时要重新抽帧/圈框。

## 2. 采标

- 固定机位；每段 10–30s，覆盖白天/夜间、顺光/逆光、手挡/不挡。
- 每帧画框：`valve` / `gauge` / `panel`（按场景合并成 1–3 类）。
- 至少 100–300 帧有设备框；另采 50–100 帧无设备的空镜/特写作为负例。
- 框只框设备本体，不要框住整个机柜/整个画面。小目标（阀门手柄）建议 640 输入。

本次的做法（可复现）：

```bash
# 1) 抽帧 + 自动找分镜切点
.venv-ppe/Scripts/python.exe eval-data/equipment/extract_frames.py   # 每 0.5s 一帧 → frames/
# 2) 按分镜写框（labels_refuel.json：同一分镜机位静止，整段复用关键帧的框）
# 3) 生成 YOLO 数据集（留出 2 个分镜做 val）
.venv-ppe/Scripts/python.exe eval-data/equipment/build_dataset.py
```

分镜框定义在 `eval-data/equipment/labels_refuel.json`，画到帧上的核对图是
`eval-data/equipment/labels_check.jpg`（`verify_labels.py` 生成）。**这套框是代理按分镜圈的，
人工复核后才算标注**；先看核对图再训练。

补充真实仪表数据：RF100 `gauge-u2lwv` 的 parquet 转 YOLO（`gauge/convert.py`），
再和 refuel 分镜合并成 3 类数据集：

```bash
.venv-ppe/Scripts/python.exe eval-data/equipment/gauge/convert.py   # gauge/ds：183 张，class 0=gauge
.venv-ppe/Scripts/python.exe eval-data/equipment/build_combined.py   # ds-all：统一类号 2=gauge
```

## 3. 训练

沿用 PPE 的 Ultralytics 流程（依赖安装见 [`docs/ppe-training.md`](ppe-training.md)）。

```bash
.venv-ppe/Scripts/yolo.exe detect train \
  model=yolov8n.pt data=eval-data/equipment/ds-all/data.yaml \
  imgsz=416 epochs=50 batch=16 workers=4 \
  project=E:/pose-demo/eval-data/equipment/runs name=equipment exist_ok=True plots=False
```

> Ultralytics YOLOv8 权重是 **AGPL-3.0**；闭源商用要么买 Enterprise 授权，要么换
> Apache/BSD 许可的检测器。详见 `web/js/objects.js` 顶部注释。

## 4. 导出 ONNX + sidecar

```bash
.venv-ppe/Scripts/yolo.exe export \
  model=eval-data/equipment/runs/equipment/weights/best.pt \
  format=onnx imgsz=320 opset=12 simplify=True
cp eval-data/equipment/runs/equipment/weights/best.onnx web/models/equipment.onnx

# 类别顺序必须用训练时 data.yaml 的 names（panel, valve, gauge），不要手打乱序
node scripts/ppe-model-manifest.mjs web/models/equipment.onnx \
  --labels eval-data/equipment/ds-all/data.yaml --input-size 320
```

导出的默认输出是 `[1, 4+nc, N]`（本次 `[1, 7, 2100]`），`objects-onnx.js` 直接吃，
不需要 `nms=True`，也不需要额外改导出参数。

## 5. 接进 profile

完整示例见 [`web/profiles/refuel-equipment.json`](../web/profiles/refuel-equipment.json)：

```jsonc
{
  "params": {
    "perception": {
      "objects": {
        "enabled": true,
        "backend": "onnx",
        "model": "equipment.onnx",
        "inputSize": 320,
        "labels": ["panel", "valve", "gauge"],
        "scoreThreshold": 0.35,
        "intervalMs": 150
      }
    },
    "signals": {
      "arm": {
        "operating": {
          "roi": { "x": 0.42, "y": 0.08, "w": 0.56, "h": 0.86 }, // nearEquipment 仍用它兜底
          "equipmentLabels": ["panel", "valve", "gauge"],
          "equipmentMinScore": 0.35,
          "equipmentMaxDist": 0.7,
          "equipmentFallbackRoi": false        // 2026-11-16 起：没有设备框就不判
        },
        "nearEquipment": { "minOverlap": 0.5, "equipmentFallbackRoi": true }
      }
    }
  }
}
```

`operating.roi` 仍支持旧矩形；设备形状不是一个矩形时改用 `operating.rois`：

```jsonc
"rois": [
  { "id": "panel", "points": [[0.42,0.08],[0.70,0.08],[0.72,0.40],[0.56,0.50],[0.42,0.44]] },
  { "id": "gauge", "points": [[0.72,0.10],[0.98,0.10],[0.98,0.55],[0.78,0.60]] }
]
```

`rois` 非空时旧 `roi` 完全不参与；非空但点非法会 fail-closed（不会悄悄退回矩形）。
多边形坐标同样是归一化 0~1，多 zone 按「任一包含」判 operating、按「最大重叠」判
near_equipment。示例见 `web/profiles/refuel-polygon.json`。

判定顺序：

1. **operating**：本帧有 `equipmentLabels` 的检测框 → 腕/肘到框边距离 ≤
   `equipmentMaxDist × scale` 才算；有框时 ROI 不参与「手在设备上」这一步。
   本帧没有设备框 → 由 `equipmentFallbackRoi` 决定：`true` 退回人工 ROI，
   `false`（**fail-closed**，`refuel-equipment` / `refuel-equipment-strict` 从 2026-11-16 起）
   一律不判。params 里的全局默认仍是 `true`，但部署档不要依赖它——只靠 ROI 的 operating
   在 8 段硬负例里 6/8 段整段误报（见 §6.1）。
2. **near_equipment**：人体框与检测框的重叠、与 ROI 的重叠**取较大值**（union）。
   检测框只框设备本体，人站在面板前时与框的重叠常常远小于与 ROI 的重叠；
   只认框会把 refuel 的召回从 3/6 压到 1/6。它的兜底由独立开关
   `nearEquipment.equipmentFallbackRoi` 控制（默认 `null` = 跟随 `operating`；
   refuel-equipment 档显式设 `true`，否则会跟着 operating 一起整段消失）。
3. 两者都没有 → 不判。

`equipmentMaxDist` 的默认值是 0.35，但 refuel 图像上这个距离太紧：正例段掉到 1/6。
0.7（约 0.7 个躯干长）在 refuel 上调出来，换机位必须重扫；不要直接抄到别的场景。

refuel 档的保持参数是 `holds.operating=1500ms`、`operatingMaxGap=600ms`。maxGap 是
「两次有效观测之间最多允许多久」：CPU 回放的中位帧间隔 138ms、p90 365ms，300ms 会把
长正例段切碎；修正 Hold 的掉帧语义后重新校准到 600ms。

信号层导出 `operating_equipment`（本帧是否有设备检测框，注意它只表示「框在」，
不表示这次判定用了框）、`near_equipment_overlap`，便于排查。离线回放
（`evaluate.mjs`）会把每帧 `objects` 传给信号层，**必须带同一个 profile**。

## 6. 验收（本次实测）

同一份导出 `eval-data/incoming/refuel-equipment-full.jsonl`（590 帧，
`full`/CPU，页面真实播放后导出）上做同输入 A/B：

| profile | operating TP/FN/FP | near_equipment TP/FN/FP |
|---|---|---|
| `refuel.json`（只用 ROI） | 3 / 3 / 3 | 3 / 3 / 2 |
| `refuel-equipment.json`（ROI + 检测框，2026-11-16 起 fail-closed） | **3 / 3 / 2** | 3 / 3 / 2 |
| `equipment-only`（无 ROI，fail-closed） | 3 / 3 / 2 | 1 / 5 / 0 |

- 检测框把 ROI 的 3 个 FP 压到 2 个（9.29–12.91s 手套/阀门特写），召回不变（n=6 正例段）。
- `equipmentMaxDist` 扫描（同一份导出，operating）：0.35 → 1/5/1；0.5 → 1/5/1；
  0.7 → 3/3/2；0.9 → 3/3/3；1.5 → 3/3/4（FP 回来了）。0.7 是当前折中。
- `near_equipment` 的 union 改动是必要的：只认检测框时 1/5，union 后恢复到 ROI 档的 3/3/2。
- **硬负例**（6 段 MOT17 + 2 段姿态样例，整段 `!operating`）：
  ROI 规则此前 **6/8 段触发**；用 `equipment-only`（无 ROI、fail-closed）复跑，
  **8/8 段 0 触发**。检测器在这 8 段里确实在工作（mot17-04 有 296 个框、
  mot17-02 6 个、mot17-05 8 个，其余 0 个），不是「模型没跑」造成的假通过。
  配置：`eval-data/negative/equipment-only.json`（gitignored）。

### 6.1 2026-11-16：fail-closed 进默认档，反例误报归零

把 `equipmentFallbackRoi=false` 从 `equipment-only` 临时档提升到
`refuel-equipment.json` / `refuel-equipment-strict.json`，并给 `nearEquipment`
加了独立开关（`nearEquipment.equipmentFallbackRoi`，默认 `null` = 跟随 `operating`）：
`operating` 要求「有设备框才判」，这两个 profile 显式把 near 设为 `true`，
所以 `nearEquipment` 仍然可以退回 ROI。

同输入确定性 A/B（5fps，290 帧正例导出 `eq-check-2026-11-16.jsonl`）：

| profile | operating TP/FN/FP | nearEquipment TP/FN/FP |
|---|---|---|
| 旧档（fallback=true） | 4 / 2 / 3 | 4 / 2 / 3 |
| 新档（fail-closed） | 4 / 2 / 3 | 4 / 2 / 3 |

10fps / 580 帧导出（`refuel-det-baseline.jsonl`）上则从 4/2/5 变成 3/3/4：
fail-closed 会丢掉「整段没有确认框」的那个正例段，**采样率不同结论不同，只能同导出比较**。

反例：8 段（MOT17×6 + pose-two/walk）用 `refuel-equipment.json` 重新录制（带设备框，5fps）：

| profile | operating |
|---|---|
| 旧档（fallback=true） | 6/8 段整段误报 |
| 新档（fail-closed） | **0 段触发**；检测器仍有零星 gauge 误检（mot17-04 等 4 段共 73 个框），但没有变成 operating |

`refuel-equipment-strict.json` 正例 2/4/0 不变，反例同样 6 段 → 0。
`refuel.json`（只有 ROI、没有检测框）不受影响，仍是 6/8 段误报——它只适合固定机位演示；
部署/换机位请用 fail-closed 的检测器档，或按新机位重画 ROI。

代码：`web/js/params.js`（nearEquipment.equipmentFallbackRoi）、`web/js/signals.js`
（nearEquipment 用独立开关）；回归用例在 `web/test/operating-test.mjs` §[3b]。

**播放间差异必须先排除**：同一份代码 + 同一个 `refuel.json`，旧导出
（`eval-data/refuel/refuel-operating.jsonl`）回放是 5/1/3（R0.833/P0.625），新播放导出是 3/3/3。
姿势关键点/手部检出在两次播放之间不同，**不要跨导出比较指标**；
上面的 A/B 全部在同一份 JSONL 上重放。所有数字都在 Hold 修正后重测（真值帧间隔超过
`operatingMaxGap` 也重置），refuel 档 `operatingMaxGap=600ms`。

> 上表的录制走的是实时播放（`record-clip.mjs`），帧集合每次不同，所以只适合比较**判定层**
> （同一份 JSONL 换 profile）。要比较**感知层**（换检测模型、改 `inputSize`/`intervalMs`、
> 加 ROI 裁切）必须用 `scripts/deterministic-replay.mjs`：按固定媒体时间逐帧 seek，
> 同一素材两次回放的逐帧内容 sha256 相同（见 `docs/eval.md`「确定性回放」）。
> 2026-11-12 实测：油样片 5fps / 290 帧，两次回放 sha256 一致。
> 注意它给出的 operating 指标与实时导出不是一回事（采样率/框的落地帧都不同），
> 只能和**同参数的另一份确定性导出**比。

复现：

```bash
# 页面真实播放并导出（会用到 web/models/equipment.onnx + sidecar）
node eval-data/record-clip.mjs \
  http://127.0.0.1:8765/eval-data/refuel/oil-sample-demo.mp4 \
  http://127.0.0.1:8765/web/profiles/refuel-equipment.json refuel-equipment-full \
  http://127.0.0.1:8765/web/ full CPU

# 同输入 A/B
node web/test/evaluate.mjs --input eval-data/incoming/refuel-equipment-full.jsonl \
  --labels eval-data/refuel/refuel-operating.labels.json \
  --profile web/profiles/refuel.json --report eval-data/incoming/refuel-eq-roi.report.md
node web/test/evaluate.mjs --input eval-data/incoming/refuel-equipment-full.jsonl \
  --labels eval-data/refuel/refuel-operating.labels.json \
  --profile web/profiles/refuel-equipment.json --report eval-data/incoming/refuel-eq-final.report.md

# 硬负例：只认设备框（无 ROI、fail-closed），整段标 !operating
for n in mot17-02 mot17-04 mot17-05 mot17-09 mot17-10 mot17-13 pose-two pose-walk; do
  node web/test/evaluate.mjs --input "eval-data/incoming/neg-eq-$n.jsonl" \
    --labels "eval-data/negative/eval/$n.labels.json" \
    --profile eval-data/negative/equipment-only.json --report "eval-data/incoming/neg-eq-$n.report.md"
done
```

> 负例 JSONL 用 `record-clip.mjs` + `eval-data/negative/equipment-only.json` 重新录
> （旧导出没有 `objects`，检测框分支等于没有证据）。

最后再用现有回归确认链路没坏：

```bash
npm test
node web/test/headless-check.mjs
node web/test/headless-multi.mjs
```

## 7. 单段素材重训记录（2026-11-12，油样取样片）

按「只拿这一段素材重训」跑了一遍完整链路（切片 → 抽帧 → 分镜留出 → 训练 → 导出 → 整段识别测试）。
素材就是上面这段 58s 演示片的另一个文件副本（md5 相同），标签沿用 `labels_refuel.json` 的分镜框。

- 类别：`panel` / `valve`；**不含 gauge**——本片 gauge 只在 46.6–48.88 一个分镜出现，
  留作 val 后训练集 0 个实例，训了也学不会。
- 数据：train 94 / val 22（panel 60/13，valve 19/9）。val 分镜覆盖三类设备：
  37.0–41.4（panel）、44.56–46.6 与 48.88–51.04（valve）、46.6–48.88（panel+gauge）。
- 训练：YOLOv8n / 416 / 50 epoch / batch 16 / CPU，7.4 min。
- 验证：P 0.956 / R 0.5 / mAP50 0.497；**panel** P0.912 R1.0 mAP50 0.995；
  **valve** P1.0 **R0** mAP50 0——valve 在这段素材上没学到可迁移特征（19 个训练实例、
  分镜框偏粗，把软管排一起圈进去了）。
- 导出：`web/models/equipment-oilsample.onnx`（320，opset 12）+ sidecar；
  接入档 [`web/profiles/refuel-equipment-oilsample.json`](../web/profiles/refuel-equipment-oilsample.json)。

同一段素材整段播放 + 导出评估（`scripts/clip-recognition.mjs` → `evaluate.mjs`）：

| 档位 | 设备框命中采样 | operating TP/FN/FP | R / P |
|---|---|---|---|
| `refuel.json`（ROI） | — | 4/2/5 | 0.667 / 0.444 |
| `refuel-equipment.json`（旧三类模型） | 93/126（panel 82、valve 15） | 5/1/6 | 0.833 / 0.455 |
| `refuel-equipment-oilsample.json`（本片两类） | 90/124（panel 86、valve 4） | 5/1/4 | 0.833 / 0.556 |

三轮是三次独立播放（1549/1511/1428 帧），直接比会混入丢帧差异；另做了同集配对复核
（同一份导出分别用 ROI/设备档重放）：两份导出上设备框都把 operating 从 4/2/5 提到 5/1/6
（旧模型）或 5/1/4（新模型），即召回 +1 段、FP 持平或 −1。n=6 段，差异不显著。
完整报告、切片与截图在本机 `runs/oil-sample-2026-11-11/`（运行产物，不进 git）。
切片/识别测试工具：`scripts/slice-video.py`、`scripts/clip-recognition.mjs`。

## 8. 局限与下一步

- **同集验证**：训练框来自同一段 58s 演示片的分镜，val 也来自同一段视频；换机位/换人
  必须重标重训。当前数字只能说明链路通了。
- **valve 没有指标**：两个留出分镜不含阀门，valve 的 mAP 是缺失值，不是 0。
- **gauge 基本没检出**：320 输入、conf 0.35 下小仪表检不到；要提高输入尺寸/单独采标。
- **框不连续**：检测间隔 150ms + 异步推理，框会隔帧出现/消失。2026-11-12 起由
  `equipment.js` 的时序确认（`boxMinHits`/`boxMaxAgeMs`）兜底：同一位置要在两次不同检测里
  都命中才算证据，见 §9。
- 仍然需要**人体检测器**来区分「真手臂镜头」和「手部特写」；设备框只解决「设备在不在、
  手离设备多远」，不解决「画面里的人是不是完整的人」。
- 想真正考核：≥2 个机位 × 每个动作 20 个正例段 + 20 个反例段，按
  [`docs/annotation-kit.md`](annotation-kit.md) 走一遍，再报 recall/precision。

## 9. 设备框的时序确认与额外门（2026-11-12）

单帧误检 + 异步落地是 operating 误报的主要来源。现在设备框先过 `web/js/equipment.js`：

- **时序确认**：同一位置（IoU ≥0.3 或中心距 ≤0.75×框对角线）在两次**不同的检测**里都命中才确认；
  `objects_ts` 相同的重复帧不重复计数；超过 `boxMaxAgeMs`（默认 600ms）没再看到就过期。
  过期过滤在匹配**之前**：超龄轨迹不会因为这一次检测匹配上就续命到 hits=2
  （`update()` 只在有人的帧调用，漏检期间的旧轨迹以前正是这样绕过 `boxMinHits` 的）。
  与检测间隔的关系由 `validateParams()` 校验：配了 `equipmentLabels` 且 `boxMinHits>1` 时要求
  `boxMaxAgeMs >= perception.objects.intervalMs + 300`，非法组合在加载时报错。
- **ROI 约束**（`boxRequireInRoi`）：框必须与本工位 ROI 相交，挡背景里别人的阀门。
  refuel 的 159 个框里 105 个中心在 ROI 外，但绝大多数与 ROI 有重叠，所以用相交而不是中心在内。
- **人形门**（`requireUprightBox` / `requireValidity`）：横着的人体框（手/油枪特写被凑成躯干）
  不算人；默认关，精度优先档见 `web/profiles/refuel-equipment-strict.json`。
  `requireValidity` 打开时会**自动启用** `nearEquipment.validity` 那道门并导出
  `operating_validity`（只写 requireValidity 不再静默失效）。
- **握持/前臂**（`requireGrip` / `useForearm`）：默认关，原因见下表。

同一份 290 帧确定性导出（5fps）上的 A/B，基准是 `refuel-equipment.json`：

| 变体 | operating TP/FN/FP | R | 说明 |
|---|---|---|---|
| 基准（boxMinHits=2, boxRequireInRoi=true） | 4/2/3 | 0.667 | 时序确认在帧级过滤掉 5/153 个单帧误检框，段级不变 |
| boxMinHits=1（旧行为） | 4/2/3 | 0.667 | 本片没有「靠单帧框才成立」的段 |
| useForearm=true | 4/2/3 | 0.667 | 没有「腕在外、前臂在框内」的帧 |
| requireGrip=true | 4/2/3 | 0.667 | 肘兜底绕过握持门；手部模型只有 48/290 帧检出、8 次闭合手型检出（operating 帧里仅 1 帧） |
| requireUprightBox=true | **2/4/0** | 0.333 | 精度到 1.0，但挡掉 2 个真作业段 |
| elbowFallback=false | **1/5/0** | 0.167 | 肘兜底承担了大部分召回，不能关 |

结论：**时序确认 + ROI 约束进默认档**；人形门与握持门保留为 profile 选项，
必须按场景自己的标注重扫，不要直接抄 `refuel-equipment-strict.json` 的取舍。

诊断字段：`operating_boxes_raw/confirmed/used`、`operating_gate(_L/_R)`、
`operating_upright_box`，见 `docs/frame-schema.md`。`scripts/deterministic-replay.mjs`
在导出末尾还会打一行「设备框连续性」：有人帧数、检出/确认/使用帧数、闪烁次数、有框检测轮次。
其中 `confirmRate` 的分子是「本帧有新检出且确认态仍有效」的帧（`confirmedWithRawFrames`），
恒 ≤ 1；`confirmedFrames` 含 `maxAgeMs` 内沿用的帧，可以大于检出帧数。

**2026-11-12 确定性基线**（10fps / 580 帧 / CPU，`refuel-det-baseline.jsonl`，本机不进 git）：
operating 4TP/2FN/5FP（R0.667/P0.444），near_equipment 2/4/2；
设备框连续性：有人 366 帧、检出 316（0.863）、确认率 0.984（311/316）、确认态 325、参与判定 325、
闪烁 10 次、有框检测轮次 180。
同一导出两次回放 sha256 一致（`333409c6…`）。**采样率改了指标就会变**，这份只能和同 fps/同参数的导出比。

> 2026-11-12 审查修复后基线有变：过期过滤移到匹配**之前**（`equipment.js`），
> 有 3 帧（t≈21s/29s/42s）的「陈旧轨迹 + 一次新检出」不再算确认，确认态 328 → 325，
> 确认率 0.994 → 0.984。**段级指标不变**（operating 4/2/5、near_equipment 2/4/2）。
> 修复前的基线 sha 是 `aae4c098…`，两边的差异只在 `operating_boxes_confirmed/used`。

## 10. 下载素材切片与重训（2026-11-17）

用 `eval-data/airport-refuel/` 里下载的 10 段公开视频做了一次「切片 → 分镜标注 → 训练 → 留出测试」。
素材版权归原 UP 主，**仅限内部评测/研究**；切片、帧、标签、权重都在 `eval-data/`（不进 git），
仓库里只有流程和结论。本节脚本在 `eval-data/equipment/airport/`（同样不进 git）。

### 10.1 切片

选 4 段有设备/流程的素材，`scripts/slice-video.py --step 1.0`：

| 素材 | 时长 | 分镜 | 抽帧 | 用途 |
|---|---:|---:|---:|---|
| `b787_jar.mp4` | 613s | 23 | 613 | 加油车控制面板 + 仪表盘（284–364s） |
| `hydraulic_valve.mp4` | 153s | 17 | 153 | 液压取样阀特写（78–111s） |
| `a320_box.mp4` | 437s | 305 | 437 | 机上取样箱 + 红色阀门（208–217s） |
| `transformer_sample.mp4` | 237s | 55 | 237 | 完全留出，只做定性测试 |

本机没有 ffmpeg，切出来的 `clips/` 是 OpenCV mp4v（浏览器不能 `?src=` 回放）；
训练只用 `frames/`、`keyframes/`，浏览器测试直接用原始 mp4（b787 是 H.264）。

### 10.2 分镜标注

`labels_airport.json` 共 **7 个分镜 / 23 个唯一框**：panel 4、valve 7、gauge 12。
b787 的仪表先用 `HoughCircles` 找圆候选，再人工剔除误检（头盔、阀门手轮、金属圈都曾被检出）。
7 个分镜的关键帧核对图在 `eval-data/equipment/airport/check/`。

这是**代理标注**：同一分镜复用关键帧的框，镜头内机位基本静止。和 refuel 分镜框一样，
正式考核前必须逐帧复核，尤其 gauge 这种小目标——镜头移动几十像素，IoU 就掉到 0.5 以下。

### 10.3 数据集

`build_ds.py` 生成 `airport/ds/`：

| 集 | 标注帧 | 负例帧 | panel | valve | gauge |
|---|---:|---:|---:|---:|---:|
| train | 81 | 12 | 70 | 25 | 441 |
| val | 36 | 10 | 19 | 23 | 80 |

- train：b787 284–347s、hydraulic 78–82s / 105–111s、a320 208–214s；
- val：b787 348–364s、hydraulic 82–99s、a320 214–217s（按分镜留出，不跨集复用帧）；
- 负例：`zhicha-hevc.mp4`（厂区安全片）与 `c919-av1.mp4`（飞机外景）各抽 11 帧，
  按时间前后分到 train/val，标签为空。

### 10.4 训练与指标

YOLOv8n，CPU，50 epoch，`imgsz=416/640`：

| 输入 | 时间 | all P / R | all mAP50 | all mAP50-95 |
|---:|---:|---|---:|---:|
| 416 | 6.4 min | 0.533 / 0.387 | 0.392 | 0.119 |
| 640 | 15.0 min | 0.983 / 0.328 | 0.372 | 0.124 |

逐类（val 46 张，含 10 张负例）：

| 类别 | 416 P / R / mAP50 | 640 P / R / mAP50 | 实例数 |
|---|---|---|---:|
| panel | 0.795 / **1.0** / **0.995** | 0.949 / 0.985 / 0.99 | 19 |
| valve | 0.722 / 0.087 / 0.159 | 1.0 / 0 / 0.11 | 23 |
| gauge | 0.083 / 0.075 / 0.023 | 1.0 / 0 / 0.015 | 80 |

**怎么读这组数字**：

- **panel 可用**：416 输入就在 val 上 mAP50 0.995；640 把框的定位质量（mAP50-95）从 0.274
  提到 0.307。定性图上它能从 b787 的不锈钢面板跨到 a320 的白色取样箱。
- **valve/gauge 的 mAP 不能当成模型能力**：val 的框来自分镜中点关键帧，而这两类在 15–17s
  的镜头里相机/物体在动，小框很快对不上，IoU@0.5 判 TP 失败。对 b787 分镜做 Hough 复测：
  350s→362s 之间仪表中心漂移 **40–140px**，而仪表框高只有约 80px，后段帧的 IoU 直接掉到 0.5 以下。
  同一批留出帧上做定性推理，320 输入仍能每帧检出 4–7 个 gauge、a320 能检出 1–3 个 valve——
  **模型在检，是标注粒度不够**。
- **提高输入尺寸不是瓶颈**：640 没有提升 valve/gauge 的召回（都是 0），只改善 panel 定位。
  下一步应该做的是逐帧标注（或固定机位/缩短分镜），不是继续加输入尺寸。

### 10.5 端到端冒烟

把 416 模型导出 ONNX 320 + sidecar（`web/models/airport-equipment.onnx`，不进 git），
用 `eval-data/equipment/airport/airport-profile.json`（临时 profile，`equipmentFallbackRoi=false`）
在 b787 留出段 348–363s 跑 Demo：

```
422 帧 / 26.6 fps / 31 次采样
设备框：30 次采样有框；panel 30 次、gauge 累计 147 个框
operating 命中 2 次；nearEquipment 0 次；JS 错误 0
```

说明「ONNX → 浏览器物体检测 → operating 判据」这条链路在未参与训练的新素材上能跑通。
截图里设备框没有叠加显示（页面开关状态待查），但采样计数与离线推理一致，不是检测没跑。

### 10.6 复现

```bash
# 切片（无 ffmpeg 时 clips 是 mp4v，只影响回放，不影响帧）
.venv-ppe/Scripts/python.exe scripts/slice-video.py \
  eval-data/airport-refuel/b787_jar.mp4 eval-data/airport-refuel/slice/b787_jar --step 1.0

# 标签核对 + 建数据集
.venv-ppe/Scripts/python.exe eval-data/equipment/airport/check_labels.py
.venv-ppe/Scripts/python.exe eval-data/equipment/airport/build_ds.py

# 训练 / 留出定性测试
.venv-ppe/Scripts/yolo.exe detect train model=yolov8n.pt \
  data=E:/pose-demo/eval-data/equipment/airport/ds/data.yaml \
  imgsz=416 epochs=50 batch=16 device=cpu \
  project=E:/pose-demo/eval-data/equipment/airport/runs name=airport exist_ok=True plots=False
.venv-ppe/Scripts/python.exe eval-data/equipment/airport/predict_sheet.py \
  eval-data/equipment/airport/runs/airport/weights/best.pt 0.25 416
```

### 10.7 下一步

1. **逐帧标注 gauge/valve**：分镜级框只适合大类（panel）。gauge 建议固定机位、每帧或每 0.5s 标一次，
   或者先用 panel 框裁出 ROI 再标，保证框是真的跟着仪表走。
2. **补阀门的视角**：hydraulic 的 99–113s、116–120s 还有几种阀门姿态没进训练集。
   hydraulic 的 valve 只有 11 张训练帧（另有 a320 7 张），且 val 是不同焦距的特写。
3. **ROI 裁切推理**：gauge 只有 30–50px（1080p），全帧 320/416 下只剩 5–10px。即使训练好了，
   运行时也应先按 panel 框裁切再检测，否则分辨率不够。
4. **时序确认复用**：`equipment.js` 的 `boxMinHits/boxMaxAgeMs` 已经能压掉单帧误检；
   新模型接进去之前，先用同一份确定性导出做 A/B，不要直接替换 refuel 档的模型。
