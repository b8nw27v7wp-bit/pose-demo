# 交接文档 · 2026-10-30

> 给下一个 session 的自包含说明。读这一份就够了；更细的设计见
> `C:\Users\18434\.claude\plans\parallel-giggling-crown.md`（前端计划）。

## 0. 工作区

- 目录：`E:\pose-demo\.claude\worktrees\agitated-colden-b193f4`
- 分支：`claude/agitated-colden-b193f4`
- HEAD：`2bda49c feat: 手势帧级评估 + 注册表派生 + 难例反例导出`
- 上一批改动（手势评估/注册表/难例/审核修复）已由用户提交在 `2bda49c`。
- **当前有 10 个已修改文件**（R4 工具 + 前端完善，见 §2/§3），另有本文件 `HANDOFF.md` 是未跟踪的新文件。用户此前的指示是「先不提交」，新 session 不要擅自 commit/push。

## 1. 当前结论（TL;DR）

| 项 | 状态 |
|---|---|
| 后端单测 `npm test` | **521 全绿**（180 逻辑 + 257 评估 + 46 难例 + 17 自动标注 + 21 清单） |
| `node --check`（evaluate/eval-test/app/headless） | 通过 |
| 无头浏览器 `headless-check.mjs` | **通过**（真 Chrome、模型推理、播放条、profile 切换、清空记录、布局 1440×900 无滚动、零 JS 错误） |
| R4 阈值拟合工具 | 已完成，R4 状态在 PLAN 里是 `🟡 工具✅ / 实拍拟合⏳` |
| Demo 前端（播放/输入 + 数据面板/profile） | **代码已完成并通过无头检查**；人工 QA 与 README 操作说明未做 |
| 提交 | **未提交** |

## 2. 本轮已完成：R4 工具 + 审核修复

### 2.1 新增 CLI 能力（`web/test/evaluate.mjs`）

| 参数 | 作用 |
|---|---|
| `--fit --fit-out <file> --margin R` | 分位 → profile 覆盖项；只翻译有信号来源、方向明确的阈值；冲突整对跳过并告警 |
| `--loso` | 按 `labels.subject` 留一人：训练集拟合 → 留出者重放 → Δ = 留出 − 训练 |
| `--max-loso-drop R` | 留一人退化门槛（配合 `--loso`，超限退出码 2） |
| `--resample <fps>` | 重采样后评估，报告帧数与指标 Δ；`startFrame/endFrame` 标注会被拒绝 |

新增纯函数：`fitToParams`、`resampleFrames`、`FIT_MIN_SAMPLES`；`web/js/params.js` 新增 `mergeParams`。

### 2.2 R4 审核修掉的 5 个 bug

1. `signals.arm.elevTorso.raised` 取两侧 **较低** P95（原来取 max，单臂举手时下垂臂也被算作举起）；
2. `signals.arm.extend.minReach` 取两侧 **较高** P5（原来取 min，单臂伸手时另一只手臂也越过阈值）；
3. `resampleFrames` 容差从 `1e-6` 改为步长 5%（同帧率+时间戳取整时会丢帧）；
4. LOSO 训练集只收非空字符串 `subject`（数字 subject 曾只训练、不留出）；
5. 未标 squat 时不再误报「缺一侧分位」。

对应测试在 `web/test/eval-test.mjs` 的 `[28] R4 拟合工具`（257 项评估器测试包含它）。

### 2.3 文档

- `PLAN.md`：R4 状态、进度表、「仍未做」、测试计数 521。
- `docs/eval.md`：`--loso/--fit-out/--resample` 用法、映射表、弃权率口径、尾部锚点说明。
- `docs/data-collection.md`：强调 `labels.subject` 是 LOSO 前提。
- `README.md`：R4 命令示例与测试计数（521）。

## 3. 本轮进行中：Demo 前端（代码已完成，待人工 QA）

用户明确选的范围：**① 播放与输入体验；② 数据面板与 profile**。
暗色模式/移动端/aria/DPR **不在本轮**。

### 3.1 已实现

**播放与输入体验**

- 文件模式底部播放条：播放/暂停、拖动进度、时间、循环、重播（清空记录并从头播放）、记录状态。
- 拖拽视频到画面区域上传；点击占位区打开文件选择；重复选同一文件可再触发。
- 摄像头切换：多设备按 `deviceId` 轮换；单设备/移动端切 `facingMode`；保存上次设备。
- 设置持久化（`localStorage` 键 `pose-demo.settings.v1`）：模型/后端/帧率/骨架/手部/关键点/镜像/循环/profile/摄像头。
- 记录/导出反馈：`logInfo` 显示帧数、时长、记录状态、超上限丢弃数；导出成功状态提示。
- 「清空记录」与「重置计数」区分：前者清帧+计数+曲线，后者只清计数。
- 摄像头/文件加载失败会停循环、摘源、回到空闲，并保留错误状态。

**数据面板与 profile**

- 工具条新增 profile 下拉：默认阈值 / 健身 / `?profile=` 自定义；切换会清空记录（参数变了）。
- 膝角曲线阈值线改成从当前 params 读取（不再写死 100/150），图例随 profile 更新。
- 顶栏新增「模型 lite/GPU」；`logInfo.title` 带 profile/hash/model/上限。
- 无帧时导出/清空/难例按钮禁用；难例采样中保持禁用。

### 3.2 关键代码位置

- `web/index.html`：播放条（`#player/#btnPlay/#seek/#chkLoop/#btnReplay/#recState`）、`#profileSel`、`#btnSwitchCam`、`#modelInfo`、`#btnClearLog`、`#sparkThresh`，以及内联样式（`.player` / `.stage.dragover` / `.hint-row`）。
- `web/js/app.js` 新增/改动：
  - 设置：`readSettings`/`saveSettings`/`applyStoredSettings`
  - profile：`profileEntry`/`ensureCustomProfileOption`/`switchProfile`/`initProfile`/`updateSparkLegend`
  - 播放：`fmtTime`/`syncPlayer`/`togglePlay`/`replayVideo`
  - 记录：`clearLog`/`resetPlaceholder`/`failInput`/`updateModelInfo`
  - 摄像头：`startCamera(opts)`/`switchCamera`/`refreshCameraDevices`/`cameraCanSwitch`
  - `pushLog` 增加 `logDropped`；`updateUI` 增加记录状态/按钮禁用/标题；`exportJSON` 增加成功状态。
- `web/test/headless-check.mjs`：新增 `frontend`（播放条/进度/设置持久化）与 `panel`（清空记录/profile 切换）两段 CDP 断言，并加入总 `ok`。

### 3.3 未做（下一个 session 优先）

1. **README 操作说明**：在「界面上的几个开关」附近补一段 Demo 操作（播放条、拖拽、profile、设置记忆、清空记录、回绕停止记录）。计划里列了但还没写。
2. **人工浏览器 QA**（无头覆盖不到）：
   - 拖拽一个真实视频到画面；
   - 摄像头前后/多设备切换（需要真摄像头）；
   - 暂停→拖动→恢复；向后拖动后「记录已停止」；点 ↺ 重播能恢复记录；
   - 勾选循环并等一圈，确认记录停止提示；
   - 刷新页面，确认模型/帧率/开关/镜像/循环/profile 都被记住；
   - `?profile=/web/profiles/fitness.json` 自定义项能加载；
   - 窄屏（<1000px）至少要确认不崩（布局优化不在本轮）。
3. **前端 diff 的代码审核**：R4 与上一批已审过；这一轮的 `app.js` 前端改动尚未走正式 review（可再用 `/code-review`，重点看状态回退/异步竞态）。
4. **决定是否提交**：用户之前说「先不提交」；新 session 不要擅自提交。
5. 可选：把 `HANDOFF.md` 删除或移出仓库（它是本次交接新增的未跟踪文件）。

### 3.4 已知风险 / 需要重点验证

- `failInput` 是最后加的失败清理路径，正常路径已过无头，但**失败路径没有自动测试**（可用不存在的视频 URL 或坏文件手测）。
- 摄像头切换、拖拽、循环回绕、20000 帧裁剪、刷新后的设置恢复都**没有自动覆盖**。
- `headless-check` 的 `frontend` 段会在测试中暂停/拖动/重播、切换镜像并写 localStorage；它结束时视频在播放，profile 已切回默认。
- 播放条与工具栏新增控件在 1440×900 下已验证 `scrollHeight=900`；更窄宽度未验证。

## 4. 常用命令

```bash
cd E:/pose-demo/.claude/worktrees/agitated-colden-b193f4
npm test
py serve.py 8799
node web/test/headless-check.mjs "http://127.0.0.1:8799/web/?src=/data/pose-test-vp8.webm"
```

R4 手动检查：

```bash
node web/test/evaluate.mjs --dir eval-data --fit --fit-out /tmp/fit.json
node web/test/evaluate.mjs --dir eval-data --resample 15
# LOSO 需要 labels.subject 且 >=2 人；样例数据没有，会明确报错
node web/test/evaluate.mjs --dir eval-data --loso
```

## 5. 约束与约定

- 工作区是 **worktree**；不要 `cd` 回主 checkout，不要在 `.claude/worktrees` 里重新初始化。
- 服务器默认 8765，但多开时用 8799 并显式传给 headless，避免打到别的 checkout。
- `--fit-out` 的文件**不要**放进 `--dir` 目录（目录扫描会把 `.json` 当帧文件）。
- 评估口径：`--max-count-err` 是「每 20 次的绝对误差」；手势指标是帧级、弃权不进分母。
- 提交信息若需要，沿用仓库现有中文风格，并按系统提醒加 Co-Authored-By（仅在用户明确要求提交时）。
