# PPE 冒烟模型：数据 → 训练 → ONNX → 浏览器

这份文档记录**自训 PPE 检测器**这条路：为什么不用 MediaPipe Model Maker、
数据怎么统一、怎么训练/导出、以及浏览器里怎么接（`web/js/objects-onnx.js`）。

> 结论先行：875 张图（623 train / 252 val）只够验证链路。
> 冒烟模型的指标**不能**当作 PPE 判定准确率，正式考核要用本项目实拍素材重新标注训练。

## 1. 为什么不是 MediaPipe Model Maker

`mediapipe-model-maker` 在原生 Windows 装不上（2026-11 实测）：

- 依赖 `tensorflow-text`：PyPI 没有 Windows wheel；
- `tflite-support` / `tensorflow-addons`：同样没有 Windows wheel；
- 本机 WSL 没有发行版、没有 Docker。

所以自训模型走 **Ultralytics YOLOv8n → ONNX → onnxruntime-web**。

> ⚠️ **许可**：Ultralytics YOLO 代码与官方权重是 **AGPL-3.0**。只用于冒烟验证/研究没问题；
> 闭源商用要么购买 Ultralytics Enterprise 授权，要么换 Apache/BSD 许可的检测器
> （例如 RT-DETR 官方权重、或自训的 SSD/MobileNet）。MediaPipe 的 .tflite 路线
> 仍是 Apache-2.0，但 Model Maker 在 Windows 上跑不了。

## 2. 数据

来源、许可与字段见 `docs/open-datasets.md`。统一后的数据集由
`scripts/prepare-ppe-dataset.py` 生成（可重建，不进 git）。

**类别映射只从显式台账 `eval-data/open/sources.json` 读**，代码里没有硬编码的
`HELMET_MAP`。第一次先生成骨架，再逐条回源确认（尤其 Safety-helmet 的 `0/1`，
禁止目测——映射反了会让 helmet/no_helmet 整体翻转）：

```bash
py -I scripts/prepare-ppe-dataset.py --init-sources   # 生成按 data.yaml 名字预填的骨架
# 编辑 eval-data/open/sources.json：空字符串 = 未确认
py -I scripts/prepare-ppe-dataset.py --strict         # 缺映射直接退出非 0，不写输出
py -I scripts/prepare-ppe-dataset.py                  # 非 strict：未映射的 class id 跳过并报告
```

产物：

| 目录 | 格式 | 用途 |
|---|---|---|
| `eval-data/ppe-smoke/train` `val` | Pascal VOC（`images/` + `annotations/`） | 原始统一标注（Model Maker 曾用；无头检查也从这里读 gt） |
| `eval-data/ppe-yolo/images` `labels` + `data.yaml` | YOLO | Ultralytics 训练 |

类别（顺序固定，改数据必须同步改 profile 的 `labels`）：

```
0 helmet  1 no_helmet  2 glove  3 no_glove  4 vest
5 no_vest 6 person    7 boots  8 no_boots
```

## 3. 环境

用 `uv` 建一个独立 venv（Python 3.11；`.venv*/` 已 gitignore）：

```bash
uv venv .venv-ppe --python 3.11
uv pip install --python .venv-ppe/Scripts/python.exe ultralytics onnx onnxsim onnxruntime
```

验证：

```bash
.venv-ppe/Scripts/python.exe -I -c "import torch, ultralytics; print(torch.__version__, ultralytics.__version__)"
```

CPU 训练即可（本机 RTX 3050 没装 CUDA torch，`device=cpu`）。

## 4. 训练冒烟模型

```bash
.venv-ppe/Scripts/yolo.exe detect train \
  data=eval-data/ppe-yolo/data.yaml model=yolov8n.pt \
  imgsz=320 epochs=10 batch=8 device=cpu workers=2 \
  project=E:/pose-demo/eval-data/ppe-runs name=smoke exist_ok=True plots=False
```

- 预训练权重从 GitHub 下载（约 6MB）；下载失败可用 `model=yolov8n.yaml` 从零训，
  同样能验证链路（精度更差）。
- `project` 必须写**绝对路径**：Ultralytics 会把相对路径再拼到自己的 `runs_dir` 下
  （实测 `project=eval-data/ppe-runs` 落到 `runs/detect/eval-data/ppe-runs/`）。
- 本机 i7-12700H / CPU：623 张图 × 10 epoch ≈ **6.7 分钟**（2.4 it/s）。
- 产物：`eval-data/ppe-runs/smoke/weights/best.pt`（不进 git）。

### 冒烟模型实测（2026-11-04，252 张 val）

| 类别 | 实例 | P | R | mAP50 |
|---|---:|---:|---:|---:|
| all | 2142 | 0.604 | 0.359 | **0.400** |
| helmet | 485 | 0.703 | 0.724 | 0.757 |
| no_helmet | 272 | 0.749 | 0.426 | 0.531 |
| vest | 120 | 0.592 | 0.708 | 0.722 |
| no_vest | 238 | 0.586 | 0.340 | 0.372 |
| person | 337 | 0.607 | 0.662 | 0.667 |
| boots | 214 | 0.688 | 0.340 | 0.439 |
| glove | 88 | 1.000 | 0.000 | 0.024 |
| no_glove | 235 | 0.510 | 0.030 | 0.074 |
| no_boots | 153 | 0.000 | 0.000 | 0.010 |

头盔/反光衣/person 已经能用；手套（目标小、实例少）和非正类里的 `no_boots` 基本没学会。
这正是"只验证链路"的预期结果，**不能**拿来当 PPE 准确率。

## 5. 导出 ONNX

```bash
.venv-ppe/Scripts/yolo.exe export \
  model=eval-data/ppe-runs/smoke/weights/best.pt \
  format=onnx imgsz=320 opset=12 simplify=True
# 产物：eval-data/ppe-runs/smoke/weights/best.onnx（12.1MB，导出约 3.5s）
cp eval-data/ppe-runs/smoke/weights/best.onnx web/models/ppe_smoke.onnx
```

输出形状是 `[1, 4+nc, N]`（`objects-onnx.js` 也兼容 `[1, N, 4+nc]`）。

## 6. 导出 sidecar 与浏览器校验（R11-3）

ONNX 没有 label map。类别名只能由 profile 按训练时 `data.yaml` 的顺序给出，
**数量写对、顺序写错时模型照常推理，只是类别张冠李戴**（`helmet` 框被判成 `no_helmet`），
而且不会报错。所以导出后必须生成一份同名 sidecar：

```bash
# 从 data.yaml 读顺序（推荐）
node scripts/ppe-model-manifest.mjs web/models/ppe_smoke.onnx \
  --labels eval-data/ppe-yolo/data.yaml --input-size 320

# 产物：web/models/ppe_smoke.onnx.json
# 也可以直接给逗号列表或每行一个名字的 txt：
node scripts/ppe-model-manifest.mjs web/models/x.onnx --labels helmet,no_helmet,glove
```

sidecar 字段：

```jsonc
{
  "labels": ["helmet", "no_helmet", "glove", "..."], // 顺序 = 训练时 data.yaml 的 names
  "inputSize": 320,        // 必须与导出 imgsz 一致
  "numClasses": 9,         // 必须等于 labels.length，也等于模型输出通道数 - 4
  "sha256": "…",           // 对 .onnx 文件算一次（只暴露，不在浏览器重复算）
  "exportedAt": "2026-11-05T…",
  "dataYamlHash": "…"      // 从 data.yaml 生成时有
}
```

浏览器端（`objects-onnx.js`）在 `createOnnxDetector()` 里：

- 加载同目录同名 sidecar（`ppe_smoke.onnx` → `ppe_smoke.onnx.json`）；
- `labels` 深比较（顺序敏感），不一致打印**第一处差异**并拒绝创建；
- 校验 `inputSize`、`numClasses`；模型自重检后再核对输出通道数；
- `requireManifest` 默认 `true`：sidecar 缺失即失败。确需加载旧模型时显式传
  `requireManifest:false`（只放宽「缺失」，内容不一致仍然失败）；
- `onnxInfo()` 暴露 `modelHash` 与 `manifest: {ok, path, numClasses, sha256, …}`。

本机冒烟模型 `web/models/ppe_smoke.onnx` 的 sidecar 已按上述命令生成（9 类 / 320）；
重新导出模型后必须重新生成。注意浏览器**不重算权重哈希**：只换了权重、类别数/顺序/输入
尺寸都没变时，旧 sidecar 仍会被接受（不会拒绝加载），但 `meta.objects.modelHash` 会是旧
权重的值，跨模型比较会被误导。sidecar 是导出产物的伴生文件，和 `web/models/*.onnx`
一样不进 git。

## 7. 浏览器运行时（onnxruntime-web）

`web/vendor/` 与 `web/models/` 都不进 git，需要按需下载：

```bash
node scripts/fetch-ort.mjs          # 固定 1.31.1，复制 wasm 运行时到 web/vendor/ort/
```

固定版本而不是 CDN：14MB wasm 走同源更快，也避免跨域与离线问题。
没有 COOP/COEP 头时没有 `SharedArrayBuffer`，`objects-onnx.js` 自动退回单线程 wasm
（`numThreads=1`）。

## 8. 页面接入

- `web/js/objects-onnx.js`：letterbox 预处理 → ORT 推理 → YOLOv8 解码 → 逐类别 NMS
  → `{label, score, box}`（原图像素坐标）。
- `web/js/objects.js`：`createObjectDetector({backend:'onnx'})` 分派到 ONNX；
  `detectObjects()` 对 MediaPipe 同步返回、对 ONNX 返回 Promise。
- `web/js/app.js`：视频循环里 ONNX 推理**不 await**（同一时刻只跑一帧），PPE 用到的框
  最多晚一帧；图片路径会 `await`。
- `web/profiles/safety-ppe.json`：`objects.backend='onnx'`、`model='ppe_smoke.onnx'`、
  9 类 `labels`；PPE 语义里 `no_helmet/no_glove` 作为负类证据。

冒烟检查（需要 8765 端口静态服务）：

```bash
node web/test/headless-ppe-onnx.mjs
```

它会挑一张同时含 `helmet` 与 `no_helmet` 的验证图，检查：后端是 onnx、模型就绪、
labels 数对上、检出框非空、`no_helmet` 没被当成 helmet 正例。

## 9. PPE 身份绑定与护栏窗口（R13-2 / R13-10）

### 9.1 `track_uid`：换 `track_id` 不等于换人

跟踪器超时后会发新的 `track_id`（慢放实测约 8.9% 的帧对）。PPE 的「连续缺帽 3 秒」
如果按 `track_id` 计时，一次真实违规会被切成多段，永远升不到 violation。

- `web/js/track.js` 在轨迹首建时分配单调递增的 `track_uid`，之后随 track 带出，
  **不参与匹配、不随 `track_id` 变化**；`track_id` 的分配与匹配逻辑完全没改（A/B 基线不变）。
- `web/js/ppe.js` 的 `PpeMonitor.tracks` 以 `track_uid ?? track_id` 为键；旧导出没有
  `track_uid` 时自动退回 `track_id`，行为与之前一致。
- `prune()` 同时接受 `track_id` 和 `track_uid`，调用方还没改完也不会误删计时器。
- 导出契约（`docs/frame-schema.md`）：`persons[]` / `verdicts[]` 都带可选 `track_uid`。

**`linkAcrossIds` 未实现（默认 `false`）。** 目前没有「新 id 在 `reidWindowMs` 内按中心距离/
外观接回旧 uid」的逻辑。`track_uid` 在同一个轨迹对象生命周期内稳定，是将来 re-id 的锚点；
跟踪器 `prune()` 丢弃轨迹后重新出现的同一个人会得到新 uid、PPE 计时从 0 开始。
开启跨 id 继承前必须先做审计日志（把 A 的违规算到 B 头上是责任风险），见 PLAN §18.4 D8。

### 9.2 `requirePositive` 窗口化

旧行为（`positiveWindowMs=0`，默认）是整场 sticky：全场任何一人任何时刻检出过一次
正例，护栏对该类永久失效。类别名写错但偶尔误匹配时，会从「全场 unknown」直接翻成
「全场 missing」。

```jsonc
// web/profiles/*.json 的 signals.ppe（新键默认关闭/现行为）
{
  "positiveWindowMs": 0,   // 0 = 现行为（整场 sticky）；>0 = 只统计最近 N ms 的正例
  "minPositive": 3         // 窗口内至少 N 次正例才算「模型确实认识这个类」
}
```

- 正例按**帧次**计数：同一时刻的多人调用/同一批缓存框只记一次。按调用次数累加会让
  `minPositive=3` 在单人单帧内被凑满，护栏形同虚设。
- 窗口内正例不足时维持 `unknown`，`missing` 计时**暂停不清零**（与原语义一致）。
- 默认参数下 `state/alert/streak_ms` 与旧实现逐位一致（`multi-test.mjs` + `ppe-test.mjs`）。
- `unknown` 额外带 `reason_code`：`no_positive`（正例不足）/ `config_mismatch`（类别没配）/
  `occluded`（头/腕不可见）。原有可读 `reason` 文案保留，供 UI 显示。

## 10. PPE 事件评估（R13-1 骨架）

独立工具 `web/test/ppe-eval.mjs`（不改 `evaluate.mjs`）：

```bash
node web/test/ppe-eval.mjs --input clip.jsonl --labels clip.labels.json
node web/test/ppe-eval.mjs --dir eval-data --report eval-data/ppe-report.md
node web/test/ppe-eval.mjs --dir eval-data --min-ppe-recall 0.9 --max-ppe-fa-per-hour 1
node web/test/ppe-eval.mjs --self-test        # 合成帧自测，不需要素材
```

labels 段（与 `docs/eval.md` 同一份文件，段之间按 `action` 区分）：

```jsonc
{ "action": "ppe", "target": "helmet", "expect": "missing",
  "track": 7, "startSec": 3.0, "endSec": 9.0, "camera": "front", "subject": "甲" }
```

- `target`：`helmet` / `glove`；`expect`：`worn` / `missing` / `unknown`。
- `track` 优先匹配 `track_uid`（跨 id 稳定），旧标注可直接写 `track_id`；在**整个段**内
  逐帧查找，人晚于段起点进场也能绑上。
  `track` 缺省时：有 `bbox` 按段内最早 IoU > 0.05 的帧绑定，一直找不到记为 `bbox_not_found`
  （不静默按「任一人」计分）；每帧只有一个人则直接绑定；否则按「任一人」统计并标记
  `ambiguous`（报告单列）。
- `camera` 取段级一致值（没有就用 clip 级）；段分组与告警事件共用同一口径，
  所以把 camera 只写在段上也能正确算误报/小时。
- 指标：per target × camera 的段级混淆矩阵 + recall/precision（Wilson 95%）、
  unknown 弃权率、告警时延（中位数/均值）、告警事件真/假与误报/小时。
  标签要求 worn/missing 而模型给 unknown 时只记弃权，不计入 FN/FP。
- `--min-ppe-recall` 检查 **missing 事件 recall**；未达标退出码 2。
  `--max-ppe-fa-per-hour` 检查误报事件/小时；超出退出码 2。
- **旧数据不会静默算 0**：没有 `verdicts[]`、`verdicts[]` 没有 `ppe`、或所有帧只有
  一个 verdict（导出只含主目标）都会明确报错/告警。

## 11. 已知限制

- 只有 623 张训练图，来源以 Roboflow 的施工场景为主，和本项目机位差异大；
  冒烟模型在实拍画面上的漏检/误检会很明显。
- 320 输入对远处的小安全帽不友好；正式训练建议 640 或切 ROI（腕部手部补检已有类似做法）。
- CPU wasm 单线程在 320×320 上约几十毫秒/帧；打开物体检测会明显拉低主循环帧率，
  正式部署前应测 `fps` 并考虑 WebGPU EP（需 `ort.webgpu.bundle.min.mjs` + jsep wasm）。
- YOLO 权重 AGPL-3.0，商用前必须处理许可（见 §1）。
