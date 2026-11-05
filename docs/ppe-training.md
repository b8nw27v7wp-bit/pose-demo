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
`scripts/prepare-ppe-dataset.py` 生成（可重建，不进 git）：

```bash
py -I scripts/prepare-ppe-dataset.py
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

## 6. 浏览器运行时（onnxruntime-web）

`web/vendor/` 与 `web/models/` 都不进 git，需要按需下载：

```bash
node scripts/fetch-ort.mjs          # 固定 1.31.1，复制 wasm 运行时到 web/vendor/ort/
```

固定版本而不是 CDN：14MB wasm 走同源更快，也避免跨域与离线问题。
没有 COOP/COEP 头时没有 `SharedArrayBuffer`，`objects-onnx.js` 自动退回单线程 wasm
（`numThreads=1`）。

## 7. 页面接入

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

## 8. 已知限制

- 只有 623 张训练图，来源以 Roboflow 的施工场景为主，和本项目机位差异大；
  冒烟模型在实拍画面上的漏检/误检会很明显。
- 320 输入对远处的小安全帽不友好；正式训练建议 640 或切 ROI（腕部手部补检已有类似做法）。
- CPU wasm 单线程在 320×320 上约几十毫秒/帧；打开物体检测会明显拉低主循环帧率，
  正式部署前应测 `fps` 并考虑 WebGPU EP（需 `ort.webgpu.bundle.min.mjs` + jsep wasm）。
- YOLO 权重 AGPL-3.0，商用前必须处理许可（见 §1）。
