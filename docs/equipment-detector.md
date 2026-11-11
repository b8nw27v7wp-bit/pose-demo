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
          "roi": { "x": 0.42, "y": 0.08, "w": 0.56, "h": 0.86 }, // 检测不到时的兜底
          "equipmentLabels": ["panel", "valve", "gauge"],
          "equipmentMinScore": 0.35,
          "equipmentMaxDist": 0.7,
          "equipmentFallbackRoi": true
        },
        "nearEquipment": { "minOverlap": 0.5 }
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
   本帧没有设备框 → 退回人工 ROI（`equipmentFallbackRoi=true`，默认）。
   `equipmentFallbackRoi=false` 是 **fail-closed**：没有框就一律不判，用于硬负例/无 ROI 场景。
2. **near_equipment**：人体框与检测框的重叠、与 ROI 的重叠**取较大值**（union）。
   检测框只框设备本体，人站在面板前时与框的重叠常常远小于与 ROI 的重叠；
   只认框会把 refuel 的召回从 3/6 压到 1/6。fail-closed 时只认检测框。
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
| `refuel-equipment.json`（ROI + 检测框） | **3 / 3 / 2** | 3 / 3 / 2 |
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

**播放间差异必须先排除**：同一份代码 + 同一个 `refuel.json`，旧导出
（`eval-data/refuel/refuel-operating.jsonl`）回放是 5/1/3（R0.833/P0.625），新播放导出是 3/3/3。
姿势关键点/手部检出在两次播放之间不同，**不要跨导出比较指标**；
上面的 A/B 全部在同一份 JSONL 上重放。所有数字都在 Hold 修正后重测（真值帧间隔超过
`operatingMaxGap` 也重置），refuel 档 `operatingMaxGap=600ms`。

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

## 7. 局限与下一步

- **同集验证**：训练框来自同一段 58s 演示片的分镜，val 也来自同一段视频；换机位/换人
  必须重标重训。当前数字只能说明链路通了。
- **valve 没有指标**：两个留出分镜不含阀门，valve 的 mAP 是缺失值，不是 0。
- **gauge 基本没检出**：320 输入、conf 0.35 下小仪表检不到；要提高输入尺寸/单独采标。
- **框不连续**：检测间隔 150ms + 异步推理，框会隔帧出现/消失；ROI 兜底和 union 是必要的。
- 仍然需要**人体检测器**来区分「真手臂镜头」和「手部特写」；设备框只解决「设备在不在、
  手离设备多远」，不解决「画面里的人是不是完整的人」。
- 想真正考核：≥2 个机位 × 每个动作 20 个正例段 + 20 个反例段，按
  [`docs/annotation-kit.md`](annotation-kit.md) 走一遍，再报 recall/precision。
