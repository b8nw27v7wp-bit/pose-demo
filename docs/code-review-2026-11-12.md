# 新增脚本代码审查（2026-11-12）

范围：油样取样片任务里新增、尚未提交的代码。基线 `3f6213f` + 工作区改动。

| 文件 | 状态 | 说明 |
|---|---|---|
| `scripts/slice-video.py` | 新增 | 视频按镜头切片、抽帧、关键帧、接触表 |
| `scripts/clip-recognition.mjs` | 新增 | 整段播放 + 识别状态采样 + 截图 + 导出 JSONL |
| `scripts/pose-screenshots.mjs` | 新增 | 内置素材的 5 个识别截图用例 |
| `web/profiles/refuel-equipment-oilsample.json` | 新增 | 本片两类设备模型接入档 |
| `package.json` / `README.md` / `docs/equipment-detector.md` | 修改 | `npm run shots`、用法与重训记录 |

审查方式：逐行读代码 + 打开周边实现（`web/js/app.js`、`web/test/cdp.mjs`、`evaluate.mjs`、
导出 JSONL）+ 对照实际产物（`runs/oil-sample-2026-11-11/`、`runs/pose-test-2026-11-11/`）。
本轮审查**没有修改任何代码**。

## 结论

- 11 条发现，都是脚本/报告/数据完整性问题；没有发现会让当前 58s 流程直接产错模型的问题。
- 优先级最高的是 **R1（报告模型指纹读错）**、**R2（长素材静默截断）**、
  **R4（重跑混入旧帧）**、**R5（`--name` 正则误删）**：前两条会让测试结论不可信，
  后两条会在换素材重跑时污染数据/误删文件。
- `refuel-equipment-oilsample.json` 的 labels 与 `equipment-oilsample.onnx.json` sidecar
  顺序一致（`panel, valve`），README 的命令与 `MSYS_NO_PATHCONV` 说明与实测吻合，未见问题。

## 发现清单

| ID | 严重度 | 位置 | 问题 |
|---|---|---|---|
| R1 | 高 | `scripts/clip-recognition.mjs:275` | 报告读错 `objects` 元数据结构，模型指纹永远显示「—」 |
| R2 | 高 | `scripts/clip-recognition.mjs:164` | 固定 180s 上限静默截断长素材 |
| R3 | 中 | `scripts/slice-video.py:173` | 抽帧把整段图像常驻内存且从未使用 |
| R4 | 中 | `scripts/slice-video.py:149` | 重跑不清空旧 frames/clips/keyframes/sheets |
| R5 | 中 | `scripts/clip-recognition.mjs:56` | `--name` 未转义拼进 RegExp，可崩溃/误删 |
| R6 | 中 | `scripts/clip-recognition.mjs:151` | 只有 `--export` 才等设备模型就绪 |
| R7 | 中 | `scripts/clip-recognition.mjs:220` | `--export` 下载失败仍 exit 0 |
| R8 | 中 | `scripts/slice-video.py:174` | `--step 0` / 负数导致死循环 |
| R9 | 中 | `scripts/slice-video.py:84` | VideoWriter 未检查 `isOpened()` |
| R10 | 低 | `scripts/pose-screenshots.mjs:258` | 失败用例生成 `![](null)` 坏图 |
| R11 | 低 | `scripts/slice-video.py:79` | mp4v 无音轨，Chrome 不能 `?src=` 回放 |

---

## R1 · 报告读错 objects 元数据结构（高）

`scripts/clip-recognition.mjs` 报告段：

```js
if (summary.meta.objects) {
  md.push(`- 物体模型：${(summary.meta.objects.modules || []).map((m) =>
    `${m.backend}/${m.model}@${m.input_size} sha256:${(m.sha256 || '').slice(0, 8)}`).join('、') || '—'}`);
}
```

导出 JSONL 首行的 `objects` 实际是**扁平对象**（`web/js/app.js` 写入）：

```json
{"backend":"onnx","model":"equipment-oilsample.onnx","inputSize":320,
 "modelHash":"f2fbe29c…","labelsHash":"fnv1a:dc53d733","manifestOk":true}
```

没有 `modules`、没有 `input_size`/`sha256`。因此 `summary.meta.objects.modules` 恒为
undefined，每份 `refuel-equipment*.md` 都打印「物体模型：—」。实测
`runs/oil-sample-2026-11-11/test/refuel-oilsample/refuel-oilsample.md` 第 9 行就是「—」，
尽管首行 meta 里有完整的 `modelHash`。

**影响**：识别测试报告无法自证用的是哪个 ONNX/标签顺序，A/B 报告不可审计。

**建议**：

```js
const o = summary.meta.objects;
md.push(`- 物体模型：${o.backend}/${o.model}@${o.inputSize} `
  + `sha256:${(o.modelHash || '').slice(0, 8)} labels:${o.labelsHash || '—'}`
  + (o.manifestOk === false ? ' · sidecar 校验失败' : ''));
```

## R2 · 固定 180s 上限静默截断长素材（高）

```js
while (Date.now() - startedAt < 180000) { ... }
```

超过 3 分钟的素材：循环因时间到而退出，随后无条件进入收尾（暂停、最后截图、导出）。
`final.dur` 仍是完整时长，报告写「时长 240s」，但 `frames.jsonl` 只覆盖前 180s；
脚本不打印任何截断警告，`evaluate.mjs` 会拿半段数据算 recall。

**影响**：对长素材的识别测试结论会系统性偏乐观/偏悲观且不可察觉。

**建议**：读 metadata 后按 `dur + 余量` 生成上限（例如 `Math.max(60, dur * 1.5 + 30) * 1000`），
或加 `--max-seconds` 并在触发上限时：

- `console.warn` + 在 `summary.truncated = true`；
- 报告顶部显著标注「只覆盖到 t=180s」；
- 退出码非 0（除非显式允许）。

## R3 · 抽帧把整段图像常驻内存（中）

```python
frames = []
while t < duration:
    img = grabframe(cap, t)
    if img is not None:
        save_frame(p, img)
        frames.append((round(t, 2), img))   # 之后从未使用
```

`frames` 在后面完全没有被读取（`manifest` 用的是 `nframes`）。内存随抽帧数线性增长：
1 小时 1080p 素材按 0.5s ≈ 7200 帧 × 约 6MB ≈ 43GB。

**建议**：删掉 `frames` 列表与 append，只写盘。

## R4 · 重跑不清空旧帧/旧切片（中）

`scripts/slice-video.py:149` 只 `os.makedirs(outdir)`，不清理 `frames/`、`clips/`、
`keyframes/`、`sheets/`。同一个 `outDir` 换素材重跑时，旧文件留下来且 `manifest.json`
不会提及。

复现：先用 120s 素材跑一次，再用 58s 素材跑同一目录 → `frames/f_120.00.jpg` 等仍在。
`eval-data/equipment/oilsample/build_ds.py` 用 `glob(f_*.jpg)` 读帧，会把两段视频混进
同一个训练集，且不会有任何报错。

**建议**：开始写之前清空工具自己管理的四个子目录（或整目录先写临时目录，成功后再替换）。
如果担心误删用户文件，至少删除 `frames/f_*.jpg`、`clips/*.mp4`、`keyframes/*_key.jpg`、
`sheets/*.jpg` 这些本工具生成的文件。

## R5 · `--name` 未转义拼进 RegExp（中）

```js
new RegExp(`^${args.name}\\.frames\\.jsonl$`).test(f)
```

- `--name 'refuel(roi)'` → `SyntaxError`，脚本启动即退出；
- `--name '.*'` → `^.*\.frames\.jsonl$`，`rm` 会删掉 outDir 里**所有** `*.frames.jsonl`。

**建议**：

```js
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const targetRe = new RegExp(`^${escapeRe(args.name)}\\.frames\\.jsonl$`);
```

或者根本不用正则：`f === `${args.name}.frames.jsonl`` 字符串比较。

## R6 · 只有 `--export` 才等设备模型就绪（中）

```js
if (args.export) {
  await waitUntil(cdp, '!__pose.state.objectOn || __pose.state.objectReady || ...', 60000);
}
```

物体检测是懒加载的（`web/js/app.js` 的 `loop()` 第一帧才 `ensureObjectDetector()`）。
只截图/只统计而不传 `--export` 时，视频先开播，12MB ONNX 几秒后才就绪：前几秒
`objectSamples=0`、截图无设备框，统计结果与带 `--export` 的运行不可比。

**建议**：把这段等待移出 `if (args.export)`（ROI 档 `objectOn` 为 false，天然 immediate 返回）：

```js
await waitUntil(cdp, '!__pose.state.objectOn || __pose.state.objectReady || __pose.state.objectError', 60000);
```

## R7 · `--export` 下载失败仍 exit 0（中）

`got` 为 null 时只是跳过复制，`exported` 保持 null，后续照常生成报告并成功退出。

**建议**：`!got` 时把 `summary.exportError` 写进报告并以非 0 退出（或至少
`console.warn`），并在 `<name>.md` 顶部写「帧导出失败：后续 evaluate 无输入」。

## R8 · `--step 0` / 负数死循环（中）

```python
t = 0.0
while t < duration:
    ...
    t += args.step
```

`--step 0` 时 `t` 永远不变，反复读同一帧、写同名文件，进程挂死；负数同理。

**建议**：argparse 后校验：

```python
if args.step <= 0:
    raise SystemExit("--step 必须 > 0")
```

## R9 · VideoWriter 未检查 `isOpened()`（中）

```python
writer = cv2.VideoWriter(path, fourcc, fps, size)
```

编码器不可用（如某些 Linux 构建没有 mp4v）或路径不可写时，`write()` 静默失败，
而 `written += 1` 仍会累加，manifest 声称每段写了 65 帧等。

**建议**：创建后检查 `writer.isOpened()`，失败直接抛错并指明编码器/路径；结束时
如果 `written == 0` 也视为失败。

## R10 · 失败用例生成 `![](null)` 坏图（低）

`runCase` 抛异常时 `screenshot: null`；`mdReport` 无条件：

```js
lines.push(`![](${r.screenshot})`);
...
lines.push(`- 截图：${r.screenshot}`);
```

**建议**：

```js
lines.push(r.screenshot ? `![](${r.screenshot})` : '（本用例无截图）');
```

## R11 · mp4v 切片浏览器不可播且无音轨（低）

`cv2.VideoWriter_fourcc(*"mp4v")` → MPEG-4 Part 2，Chrome `<video>` 不支持；
`VideoWriter` 也不写音轨。因此切出来的 `shot_*.mp4` 不能通过 Demo 的 `?src=` 回放
（会报 decode error），培训视频的讲解音也丢失。当前产物用 OpenCV/VLC 复核没问题，
但不要把它们当成「可直接网页回放」的切片。

**建议**：若需要浏览器回放/留音，改用 ffmpeg 导出 H.264 + AAC（例如
`imageio-ffmpeg`），OpenCV 写入只作为无 ffmpeg 时的兜底，并在 README 注明。

---

## 审查过、未发现问题的部分

- `web/profiles/refuel-equipment-oilsample.json`：`labels` 与 `data.yaml`/sidecar 都是
  `["panel","valve"]`；`equipmentLabels` 一致；`model: "full"` 与实测一致。
- `README.md` 新增的命令、产物路径、`MSYS_NO_PATHCONV=1` 说明与本次实测一致。
- `docs/equipment-detector.md` §7 的数字与最终产物一致（三轮 1549/1511/1428 帧，
  paired replay 见 `runs/oil-sample-2026-11-11/test/*/*.roi-replay.md`）。
- `package.json` 的 `"shots"` 入口拼写正确。

## 修复顺序与验收

建议顺序：R1 → R2 → R5 → R4 → R6 → R7 → R3 → R8 → R9 → R10 → R11。

修完后的验证：

```bash
# 静态与页面
npm test
node web/test/headless-check.mjs

# 1) 切片：同一 outDir 换一段更短素材重跑，frames/ 里不应残留旧时间戳
.venv-ppe/Scripts/python.exe scripts/slice-video.py <clipA> runs/tmp-slice
.venv-ppe/Scripts/python.exe scripts/slice-video.py <clipB> runs/tmp-slice
ls runs/tmp-slice/frames

# 2) 参数边界：应立即报错而不是挂死
.venv-ppe/Scripts/python.exe scripts/slice-video.py <clip> runs/tmp-slice --step 0

# 3) 识别测试：报告里应出现物体模型 sha256；--name 含正则字符不应崩溃
MSYS_NO_PATHCONV=1 node scripts/clip-recognition.mjs \
  --clip /eval-data/refuel/oil-sample-demo.mp4 \
  --profile /web/profiles/refuel-equipment-oilsample.json \
  --out runs/tmp-clip --name 'refuel(roi)' --export
grep "物体模型" runs/tmp-clip/*.md

# 4) --export 失败路径：临时把下载目录设成只读，脚本应非 0 退出并写明原因
```

> 注意：`runs/`、`eval-data/`、`web/models/` 都不进 git；本次报告只记录问题，
> 没有改动任何被审查的代码。

---

## 修复记录（2026-11-12）

R1–R11 已全部修复，分支 `fix/code-review-2026-11-12`（基于 `fix/video-import-playback`）。

| ID | 修法 | 验证 |
|---|---|---|
| R1 | 按 app.js 实际写入的扁平 `objects` 渲染（backend/model/inputSize/modelHash/labelsHash/manifestOk），sidecar 校验失败会标出 | 58s 素材整段播放 + `--export`：报告第 9 行输出 `onnx/equipment-oilsample.onnx@320 sha256:f2fbe29c labels:fnv1a:dc53d733` |
| R2 | 上限改为 `max(60, 时长×1.5+30)` 秒，可用 `--max-seconds N` 覆盖；触发上限时 `console.warn`、`summary.truncated=true`、报告顶部标注覆盖到 t=…、非 0 退出（`--allow-truncate` 表示明确接受） | 58s 素材 + `--max-seconds 20`：报告顶部标注「t=20.8s / 58s」，exit 1；默认上限 117s 完整播放 exit 0 |
| R3 | 删除 `frames` 常驻列表，抽帧只写盘 | 3s 样例跑通 |
| R4 | 写之前按通配清理 `frames/f_*.jpg`、`clips/*.mp4`、`keyframes/*_key.jpg`、`sheets/*.jpg`，删除数量写进 manifest/stdout | 同一 outDir 先用 `--step 0.5` 再用 `--step 2.0`：帧只剩 `f_000.00/f_002.00`，`cleared_previous_files=10` |
| R5 | `--name` 不再拼正则，改为字符串相等比较 | `--name 'refuel(roi)'` / `'refuel(equip)'` 两次整段运行均正常，产物名带括号 |
| R6 | 物体模型就绪等待移出 `--export`，所有运行都等；超时给出警告 | 无 `--export` 的 20s 运行也有设备框采样（27/41），说明播放前已等模型 |
| R7 | 导出失败写入 `summary.exportError` + 报告顶部警示 + 非 0 退出；`#btnExport` 缺失单独报错 | 代码检查；失败路径需只读目录复核 |
| R8 | argparse 后校验 `--step > 0`、`--clip-fps > 0` | `--step 0` 立即 `--step 必须 > 0`，exit 1 |
| R9 | `VideoWriter.isOpened()` 失败直接报错；某段写 0 帧也视为失败 | 代码检查（本机 mp4v 可用，未触发） |
| R10 | 失败用例报告写「（本用例无截图）」而不是 `![](null)` | 代码检查 |
| R11 | 优先 ffmpeg 写 H.264+AAC（PATH / imageio-ffmpeg，`--ffmpeg` 可指定），OpenCV mp4v 仅作兜底并打印警告；manifest 记 `clip_encoder` | 本机无 ffmpeg，已验证兜底路径与警告；H.264 路径需装 ffmpeg 后复核 |

验证方式：`node --check` 两个 mjs、`python -m py_compile` slice-video、`npm test`（exit 0）、
`node web/test/headless-check.mjs "http://127.0.0.1:8799/web/?src=/data/pose-test-vp8.webm"`（通过、零 JS 错误），
以及上面 R1/R2/R4/R5/R6/R8 的真机跑。

仍未覆盖：R7 的导出失败路径（需要只读下载目录）、R9 的编码器失败分支（本机 mp4v 可用）、
R11 的 ffmpeg H.264 分支（本机没有 ffmpeg）、R2 的超长素材默认上限（本次用 `--max-seconds` 触发截断）。
