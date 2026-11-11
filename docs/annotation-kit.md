# 新素材接入与标注（operating / near_equipment）

这份文档解决一个问题：**仓库里只有一段 58s 的加油演示片**，`operating` 的 6 个正例段
全部来自它。要把准确率从「样本不足」变成可比较的数字，需要同场景的更多机位/人员/时段素材。
下面的流程把「新视频 → 可评估 JSONL → 标注 → 报告」固定下来。

> 所有素材、JSONL、标注、截图都在 `eval-data/` 下，`.gitignore` 已忽略；**不要把视频或
> 带人脸的截图提交进仓库**。

## 一、放素材

```text
eval-data/incoming/<scene>.mp4
```

`<scene>` 用机位/场景命名（如 `site-b`、`night-01`）。同一个 profile 对应同一个固定机位。

## 二、建 profile（设备 ROI 必须重画）

复制 `web/profiles/refuel.json` 为 `web/profiles/<scene>.json`，至少改：

```jsonc
{
  "name": "<scene>",
  "params": {
    "signals": {
      "arm": {
        "operating": {
          "roi": { "x": 0.42, "y": 0.08, "w": 0.56, "h": 0.86 }  // 按新机位重画
        }
      }
    }
  }
}
```

- ROI 是**归一化画面坐标**：设备（阀门/仪表/面板）在画面里的区域。换机位必须重画。
- 单个矩形用旧键 `roi: {x,y,w,h}`；设备形状不是一个矩形时用 `rois`（多边形/多区域）：

```jsonc
"operating": {
  "rois": [
    { "id": "panel", "points": [[0.42,0.08],[0.70,0.08],[0.72,0.40],[0.56,0.50],[0.42,0.44]] },
    { "id": "gauge", "points": [[0.72,0.10],[0.98,0.10],[0.98,0.55],[0.78,0.60]] }
  ]
}
```

  点按画面顺时针/逆时针写都可以，至少 3 个；`rois` **非空时旧 `roi` 完全不参与**。
  非空但点写错（越界/少于 3 点）会 fail-closed，不会悄悄退回矩形。本轮没有页面画图工具，
  坐标需要从截图/图像编辑器量（x/宽、y/高）。`web/profiles/refuel-polygon.json` 是一个
  与 refuel 矩形等价的最小示例。
- `nearEquipment.minOverlap` 默认 0.3；refuel 档用 0.5。新场景先用默认，评估后再调。
- 需要挡掉过小/满屏/大半出画的「人框」时，在 profile 里开 `nearEquipment.validity.enabled`；
  默认关闭，先用同一份导出做 A/B（`web/profiles/refuel-strict.json`）。
- 阈值默认值见 `docs/signals.md`；一次只改一个场景的 profile，不要改全局默认。

## 三、录成 JSONL（页面逐帧导出）

```bash
npm run serve                       # 另开终端；默认 8765
node eval-data/record-clip.mjs \
  http://127.0.0.1:8765/eval-data/incoming/site-b.mp4 \
  http://127.0.0.1:8765/web/profiles/site-b.json \
  site-b
```

产物：`eval-data/incoming/site-b.jsonl`（一行一帧，含 kp/信号/flags；`video_time` 是媒体秒数）。
脚本走的是真实页面：加载 profile → 播放到结束 → 点「导出」，所以和页面判定完全同路径。

## 四、接触表（人工看边界）

```bash
# 每秒一帧，抓成图片
node eval-data/refuel/grabframes.mjs 1 eval-data/incoming/site-b-sheets \
  http://127.0.0.1:8765/eval-data/incoming/site-b.mp4
# 拼成带时间戳的接触表
py -I eval-data/refuel/make_sheets.py eval-data/incoming/site-b-sheets eval-data/incoming/site-b-sheets
```

换场附近用 0.25s 再抓一次（把 `1` 换成 `"12.5,12.75,13,13.25"` 这样的列表）。

## 五、出草稿，再人工标

```bash
node web/test/evaluate.mjs --input eval-data/incoming/site-b.jsonl \
  --autolabel --out eval-data/incoming/site-b.labels.draft.json
```

草稿只含**正例**（规则自己判出来的段），**必须人工补反例**，否则 precision 恒为 1。
把草稿改名为 `site-b.labels.json`，按下面口径改：

### operating（在操作）

- 正例：能辨认出工人身体（头/躯干/反光背心），且手/臂在设备上持续 ≥2s。
- 反例：站立/走近/离开、空镜、标题页、**纯手/前臂/设备特写（没有躯干/背心）**。
- 用 `{"action":"!operating","startSec":...,"endSec":...}` 标反例；不要用 `none`
  （站着会被判成 `stand`，`none` 段必然失败，见 `docs/eval.md`）。

### near_equipment（在设备旁，上下文）

- 正例：人在设备 ROI 旁/内（人体框与 ROI 有重叠），**不要求手在设备上**；每段 ≥2s。
- 反例：纯手/设备特写、空镜、标题页；与 `operating` 分开标，不要互相替代。
- 它是上下文，不是「在操作」；报告里单独一行，不要把两者的 TP 相加当准确率。

### 边界

- 边界取**导出帧时间**（`video_time`），不要手填一个跨到相邻特写帧的秒数。
- 先按 1s 接触表定大段，再按 0.25s 复核换场。
- 同一段素材里 `operating` 和 `near_equipment` 可以各标一套；两套段互不覆盖也没关系。

## 六、评估

```bash
node web/test/evaluate.mjs --input eval-data/incoming/site-b.jsonl \
  --labels eval-data/incoming/site-b.labels.json \
  --profile web/profiles/site-b.json \
  --report eval-data/incoming/site-b.report.md
```

- 看 `逐段明细` 的 FP/FN，再决定改 ROI、阈值还是补标注；**不要只看一个总数**。
- 段级 n<20 仍不报百分比（页面口径）；要把 n 做上去，需要更多独立片段/机位。
- 生成页面准确率时，**一份报告只能对应一个 profile**：

```bash
node web/test/accuracy-report.mjs \
  --dir eval-data/incoming/eval \
  --profile web/profiles/site-b.json \
  --out web/accuracy.json
```

（`eval-data/incoming/eval/` 只放干净的 `<scene>.jsonl` + `<scene>.labels.json`，
不要把接触表/raw 诊断 JSON 放进去，评估器会把它们当帧文件。）

## 七、硬负例（非设备场景）

设备作业素材不够时，先把**非设备场景**当硬负例，检查 `operating` 是否只是「手在区域里」：

1. 建一个 `negative-control` profile：ROI 覆盖画面中部，沿用当前 operating 阈值。
2. 用 `record-clip.mjs` 录街景/走路/双人样例，整段标 `!operating`。
3. 用同一个 profile 跑 `evaluate --dir`；如果片段失败，就是 FP。

这些结果**不要**混进设备场景的 `accuracy.json`（ROI 不是设备，混在一起没有意义），
只作为「规则是否物体专用」的压力测试。只用 ROI 时 8 段里有 6 段触发；换成
`equipment-only`（只认设备检测框、`equipmentFallbackRoi=false`）后 **8/8 段 0 触发**，
细节和复现命令见 [`docs/equipment-detector.md`](equipment-detector.md) §6。

## 八、采够没有

- 每个动作、每个机位至少 **20 个正例段 + 20 个反例段**，再谈百分比。
- 至少覆盖：白天/夜间、顺光/逆光、不同身高体型、手被设备挡住、换场/空镜。
- 新增素材后跑 `manifest-check`（`docs/data-collection.md`）检查覆盖度。
- 设备检测器只能解决「设备在不在、手离设备多远」；「手/设备特写被误检成人」仍然需要
  **人体检测器**。接入示例（panel/valve/gauge ONNX）和同集冒烟指标见
  [docs/equipment-detector.md](equipment-detector.md)；新场景仍要重画 ROI、重标、
  重扫 `equipmentMaxDist`，不要直接套 refuel 的 0.7。
