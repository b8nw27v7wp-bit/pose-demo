# 交接提示词：跟踪评测纠偏 + PPE 冒烟链路打通

> 复制下面整段给新会话。仓库：`E:\pose-demo`。所有改动**尚未提交**，先 `git status` / `git diff` 看清再动手。
> 更新时间：2026-11-04 傍晚（本地）。用户使用中文，直接给结论和数字。

---

## 你的任务（按优先级）

1. **跟踪**：MOT17 上继续降 ID 切换。注意——之前的 ~15% 基线**被丢帧放大了**，真正的匹配错误
   约 9%（慢放逐帧）。再调门控之前先看 §三 的测量口径，别拿实时数字做小步调参。
2. **PPE**：冒烟链路（数据→训练→ONNX→浏览器→PPE 判定）**已经打通**；下一步是扩数据/换机位重训，
   再把准确率数字做出来。见 §四、§五。
3. 保持单测（724 项）与无头检查全绿；**不要未经用户同意提交**。

## 先读这些文件（按顺序）

- `docs/open-datasets.md`：数据来源/许可、MOT17 评测口径、平铺检测、**测量噪声警告**。
- `docs/multi-and-objects.md`：多人跟踪、物体检测（双后端）、PPE 语义、慢放 A/B 结果。
- `docs/ppe-training.md`：PPE 数据→训练→ONNX→ORT Web 的完整步骤与冒烟模型指标。
- `web/test/mot17-eval.mjs`：MOT17 评测（`--rate 0.4` 慢放逐帧）。
- `web/js/track.js`、`web/js/params.js`：跟踪器与默认参数。
- `web/js/objects-onnx.js`、`web/js/objects.js`、`web/js/ppe.js`。
- `scripts/prepare-ppe-dataset.py`、`scripts/fetch-eval-data.py`、`scripts/fetch-ort.mjs`、`scripts/py.mjs`。

## 当前数据（都在 `eval-data/open/`，gitignored，约 278MB）

| 数据 | 内容 | 许可 |
|---|---|---|
| MOT17 6 条 FRCNN（02/04/05/09/10/13） | 299/300/180 帧 mp4 + `gt/gt.txt` | **CC BY-NC-SA 3.0 非商用** |
| PPE_detection | 200 图 / 2953 框 | Roboflow（多为 CC BY 4.0） |
| Safety-helmet | 338 图 / 1294 框（0=no_helmet、1=helmet） | MIT |
| construction-ppe | 337 图 / 1879 框 | MIT |

统一训练集（可重建，`py -I scripts/prepare-ppe-dataset.py`）：
`eval-data/ppe-smoke/{train,val}`（VOC）与 `eval-data/ppe-yolo/`（YOLO），**623 train / 252 val，
6126 框，9 类**：helmet, no_helmet, glove, no_glove, vest, no_vest, person, boots, no_boots。

## 一、已经完成的东西（不要重复造）

- `node web/test/mot17-eval.mjs`：帧级 TopK 召回/精确/ID 切换/碎片/动作触发率。
  - 默认实时播放；**A/B 必须加 `--rate 0.4` 并固定 `--fps 15`**（见 §三）。
  - Git Bash 会转义 `/web/...` 参数，自定义 profile 用完整 URL。
- `node web/test/mot17-eval.mjs --seq ... --rate 0.4 --fps 15` 单序列约 40s，6 序列约 4 分钟。
- 平铺检测 `perception.multi.tiles: 2`：夜景 04 TopK 0.3%→16.5%，02 23.3%→24.9%，默认关。
- **PPE 冒烟模型已训好**（`eval-data/ppe-runs/smoke/weights/best.pt|best.onnx`，不进 git），
  ONNX 已放到 `web/models/ppe_smoke.onnx`；ORT 运行时在 `web/vendor/ort/`（不进 git）。
- 浏览器 ONNX 后端：`web/js/objects-onnx.js`（letterbox→ORT→YOLOv8 解码→逐类别 NMS），
  `objects.js` 统一分派；`app.js` 视频循环里异步推理不 await（同一时刻只跑一帧）。
- profile：`web/profiles/safety-ppe.json`（onnx 后端 + 9 类 labels + no_helmet/no_glove 负类）。

## 二、跟踪：慢放逐帧 A/B 结果（关键，别再走回头路）

`--rate 0.4 --fps 15`，6 序列，约 800 对（表内数字都是 15fps 上限下测得，临时 profile 已删）：

| 配置 | ID 切换 |
|---|---|
| centerMax 0.6 + greedy + 3 人 | **72/797（9.0%）** |
| centerMax 0.8 + greedy + 3 人（当前默认） | **72/810（8.9%）** |
| centerMax 0.8 + greedy + 4 人 | 75/807（9.3%） |
| centerMax 0.8 + 外观重连（appearance on） | 81/807（10.0%） |
| centerMax 0.8 + optimal 分配 | 82/818（10.0%） |

- **centerMax 0.6/0.8 没有可测差异；3 人/4 人也没有**（4 人还更慢）。
- 外观重连、optimal 分配都略差（+9~10 次），**默认保持关 / greedy**。
- 实时模式同一配置重复跑会在 **56~70 次切换**之间跳（12.5%~15.4%），所以以前那张
  “预测优先 77/469、外观混入 79/458、motion 107/456”的表，方向和量级都要打折扣看待。
- 序列 05：实时 18/157 对，慢放 18/280 对——**切换次数没变，对数翻倍**。
  结论：实时的 ~15% 主要来自 25fps 视频 + 15fps 推理上限造成的丢帧，不是匹配规则。
- 再想降 ID 切换：优先**提吞吐/减少丢帧**（lite 模型、关手部、ROI、WebGPU），
  或者让跟踪器按“实际经过的视频时间”缩放门控；继续微调 centerMax/appearance 已无收益。

**本轮修掉的配置 bug**：`perception.multi.maxPersons` 以前完全没生效——`ensureMultiEstimator`
直接读工具栏 `multiSel`（固定默认 3），profile 写 4 也跑 3。现在 `applyParams` 在用户没保存过
人数选择时用 profile 值初始化 select；有保存值时以用户选择为准。`multiKey` 会显示实际 numPoses。

当前代码默认：`motion=false`、`appearance=false`、`assignment='greedy'`、`centerMax=0.8`、
`maxPersons=3`、`maxLostMs=1500`、**推理上限 30fps**（见 §二.5）。

## 二.5、吞吐：把丢帧这个根因先修掉（2026-11-04）

`npm run probe:throughput`（`web/test/throughput-probe.mjs`）测 `state.timing` 各阶段 EMA：

| 配置（MOT17-05，640×480） | 实测处理 |
|---|---:|
| 15fps 上限 · 多人3+手部 | 13.6 帧/s（pose 17.5ms + hands 14.4ms） |
| **30fps 上限 · 多人3+手部（新默认）** | **25.3–26.4 帧/s**（pose 12.6–13 + hands 12–13） |
| 30fps · 手部关 | 26.9 帧/s（14.7ms） |
| 30fps · ONNX 物体（worker，新） | 26.4 帧/s（objects 摊薄 0.46ms） |
| 30fps · ONNX 物体（主线程，旧） | 8.2 帧/s |
| 30fps · MediaPipe efficientdet CPU（150ms 降频） | 18.3 帧/s（objects 摊薄 15.5ms） |
| 30fps · 1080p（02） | 25.6 帧/s |

三个改动：
1. `index.html` 推理上限默认 **15 → 30fps**：15fps 在 25fps 素材上丢约一半帧。
2. `objects-onnx.js` 开 `ort.env.wasm.proxy = true`（Web Worker）。proxy 会**转移**输入
   buffer，每帧必须传 `new Float32Array(chw)` 拷贝（否则第二帧 `size 307200 ≠ 0`）。
3. 新增 `perception.objects.intervalMs=150`：物体检测降频，跳过时沿用上一帧框。
   MediaPipe efficientdet 仍是最慢的后端（~16fps），PPE 应走 ONNX。
4. 没有检出人的帧跳过手部推理（手只能归属到人；04 夜景以前每帧白跑 ~13ms）。
5. 换 profile 会重建物体检测实例（后端可能 mediapipe→onnx）。无头脚本改开关前要等
   `state.profileLoaded`，否则会先按默认参数建 mediapipe 检测器，profile 的 onnx 不生效
   （实测把 28fps 测成 18fps）。

实测工具新增 `state.timing`（pose/hands/objects/draw/total/samples），无头脚本可读；
ONNX 的 worker 内推理耗时看 `state.objectInfo.runMs`（~96ms/次，150ms 间隔约 2/3 占空比）。

### 本轮审核修复（2026-11-04）

- `objects.js` / `objects-onnx.js` 加创建代次：在途创建/关闭不会互相覆盖半成品实例，
  `meta` 与 `session` 原子安装；`detectOnnx` 先快照 session/meta，推理期间换模型会丢弃结果。
- `ensureObjectDetector` 返回 `'superseded'` 而不是 `false`：换 profile 期间旧创建结束，
  不再被调用方当成"加载失败"而把新 profile 的 `objects.enabled` 关掉。
- 异步物体推理先看 `objectBusy` 再调用（原来先提交再判断，会并发跑两次、丢弃的 promise
  没有 catch，rejection 变成页面 JS 错误）。
- `applyParams` 每次换 profile 都作废旧物体检测器（即使新 profile 关掉 objects），
  并在 numPoses/detConf/presenceConf 变化时重建多人估计器。
- `mot17-eval --fps` 校验值必须在页面选项里（10/15/30），否则直接报错，避免静默跑 30fps。
- `throughput-probe` / `headless-ppe-onnx` 先 `await close()` 再 `process.exit`（exit 不执行
  finally，会漏 headless Chrome）；headless-ppe 的默认 profile 跟随 base URL，profile 没生效时快速失败。
- `replayVideo` 在 seeked 之前不 play：拖动进度条后立刻点重播会被浏览器以 AbortError 拒绝，
  视频停在 0（headless-check 曾稳定复现）。

## 三、测量口径（很重要）

- 实时播放：应用最多 15fps 推理，25fps 视频每帧都可能被跳过；跳过哪帧取决于机器负载，
  **同一配置重复跑不可复现**。
- `--rate 0.4`：视频降到 10fps，应用能处理每一帧；评测按 25fps 帧号去重。A/B 都用它，
  并且必须用 `--fps 15` 固定推理上限——现在默认是 30fps，同一视频帧会被多处理几次
  （09 序列 25/159 → 29/169），不固定就没法和旧表比较。
- 它**不是完全确定**：同配置多次总计 72/72/75/90/93，个别帧跳过或 GPU 负载会放大差异。
  A/B 必须串行、机器空闲时跑（别同时跑吞吐探针），单臂重复 ≥2 次。
- gt 按画面裁剪，可见面积 <30% 转 ignore；TopK 默认 3。
- 跟踪器的时间戳仍用 `performance.now()`；慢放时帧间隔约 100ms（实时约 40~70ms），
  `maxLostMs` 覆盖的帧数不同。跨倍速比较绝对值要谨慎，同倍速 A/B 没问题。

## 四、PPE：链路已通，指标只够冒烟

- 训练：YOLOv8n@320，10 epoch，CPU 6.7 分钟；val mAP50 **0.40**
  （helmet 0.757 / no_helmet 0.531 / vest 0.722 / no_vest 0.372 / person 0.667 /
  boots 0.439 / glove 0.024 / no_glove 0.074 / no_boots 0.010）。
- 导出：ONNX 12.1MB，`opset=12 simplify=True`；复制到 `web/models/ppe_smoke.onnx`。
- 无头验证（`node web/test/headless-ppe-onnx.mjs`）：后端 onnx、9 类 labels 对齐、
  一张 val 图检出 `person×5 · helmet×1 · no_vest×3`，头盔判 `worn`，无 JS 错误。
- 手套/非正类基本没学会；数据量、机位差异、小目标都没解决，**没有任何实拍准确率**。
- **许可**：Ultralytics YOLO 权重/代码是 AGPL-3.0。冒烟验证可以；闭源商用前必须买 Enterprise
  或换 Apache/BSD 许可的检测器重训。MediaPipe .tflite 路线仍是 Apache-2.0，但 Model Maker
  在原生 Windows 装不上（tensorflow-text / tflite-support 无 Windows wheel）。

## 五、下一步建议

1. **PPE 数据**：用本项目实拍素材（安全帽/反光衣/手套）标注一轮，至少每类 500~1000 实例；
   640 输入或头部/腕部 ROI 二次检测；再训一次并做帧级 recall/precision。
2. **吞吐**：默认 30fps + ORT worker 后已能处理 25fps 素材的每一帧；下一步可测 30fps 摄像头
   （本轮只测了 25fps 视频），以及弱机/多标签页下的实际帧率。手部约占 12–13ms，若要上 60fps
   源可考虑把手指检测降到 15Hz（`hands` 降频）。
3. **跟踪**：如果一定要继续，先实现“按视频时间缩放门控”，用 `--rate 1` 的真实丢帧场景评测，
   并且每组配置至少跑 3 次取中位数。
4. 真实数据到位前，不要把冒烟模型写进任何“准确率”文案。

## 六、验证清单（开工/收尾都跑）

```bash
git status --short
npm test                              # 724 项（含 ONNX 解码 14 项）
npm run serve                         # 另开终端（当前 8765 已在跑）
node web/test/headless-check.mjs      # 通过
node web/test/headless-multi.mjs      # 19 项通过
node web/test/headless-ppe-onnx.mjs   # 需要 web/models/ppe_smoke.onnx + web/vendor/ort/
npm run probe:throughput -- --multi 3 --hands 1 --objects 1 --profile http://127.0.0.1:8765/web/profiles/safety-ppe.json
py -I scripts/prepare-ppe-dataset.py  # 训练数据可重建
npm run fetch:ort                     # 下载 ORT 运行时（固定 1.31.1）
```

## 七、未提交改动概览

- 本轮新增：`web/js/objects-onnx.js`、`web/profiles/safety-ppe.json`、`web/test/onnx-test.mjs`、
  `web/test/headless-ppe-onnx.mjs`、`web/test/throughput-probe.mjs`、`scripts/fetch-ort.mjs`、
  `docs/ppe-training.md`。
- 本轮改动：`web/js/app.js`（ONNX 异步推理、profile maxPersons、analyzeStill async、
  阶段耗时 `state.timing`、物体降频）、`web/js/objects.js`（双后端分派）、
  `web/js/objects-onnx.js`（worker proxy）、`web/js/params.js`（objects 后端字段/intervalMs、注释纠偏）、
  `web/js/track.js`（appearance 默认 false）、`web/index.html`（默认 30fps）、
  `web/test/mot17-eval.mjs`（`--rate` + 帧去重）、`.gitignore`、README/docs。
- 上一轮遗留的大量新增模块（track/multi/ppe/objects/tiles/accuracy/...）仍未提交。
- **没有提交任何 commit；不要替用户提交。**

## 一句话现状

跟踪：实时 ~15% 主要是丢帧造成的，慢放逐帧约 9%；centerMax/外观/optimal/人数上限都没有可测收益，
默认保持 greedy + appearance off + centerMax 0.8。PPE：623 图冒烟模型已训好（mAP50 0.40），
ONNX→ORT Web→PPE 判定链路在浏览器里跑通，下一步是实拍数据与准确率。
