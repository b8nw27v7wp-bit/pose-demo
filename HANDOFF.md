# 交接文档 · 2026-10-30（续作更新）

> 给下一个 session 的自包含说明。更细的设计见
> `C:\Users\18434\.claude\plans\parallel-giggling-crown.md`（前端计划）。

## 0. 工作区

- 目录：`E:\pose-demo\.claude\worktrees\handoff-continue-68ef56`
- 分支：`claude/handoff-continue-68ef56`
- 基线提交：`2bda49c feat: 手势帧级评估 + 注册表派生 + 难例反例导出`
- 上一轮的 10 个未提交文件（R4 工具 + 前端完善）已用
  `git diff --binary` → `git apply` 从 `agitated-colden-b193f4` 同步到本 worktree，
  **原 worktree 的那份副本仍在**（未提交、未删除），别在两个 worktree 里各改一份。
- 本 worktree 另外补了被 `.gitignore` 忽略的 `web/vendor/`（42M）与 `web/models/`（22M），
  否则 `app.js` 的 `import '../vendor/vision_bundle.mjs'` 直接失败、`window.__pose` 不存在，
  无头检查会报 `Cannot read properties of undefined (reading 'state')`。
- **仍未提交**（用户此前明确说「先不提交」）。当前共 11 个已修改文件 + `HANDOFF.md` 未跟踪。

## 1. 当前结论（TL;DR）

| 项 | 状态 |
|---|---|
| 后端单测 `npm test` | **531 全绿**（189 + 258 + 46 + 17 + 21） |
| `node --check`（app/headless/signals/actions/params） | 通过 |
| 无头 `headless-check.mjs` | **通过**（模型推理、播放条/进度/设置持久化/profile 切换/难例/布局 1440×900，零 JS 错误） |
| README Demo 操作说明 | **已补**（输入 / 播放条 / 数据面板 / 设置记忆） |
| 前端代码审核 | **已做**（4 条发现，全部修复并复验） |
| 判定数据检查 | **已做**（坐 vs 下蹲、挥手同侧、3D→2D 逐侧回退、2D 角度可见性门控，4 处修复） |
| 界面重设计 | **已做**（仪表/取景器方向；1440 / 1280 / 1024 / 390 截图检查，无头检查通过） |
| 人工浏览器 QA | **未做**（需要真摄像头/真拖拽） |
| 提交 | **未提交** |

## 2. 本轮（10-30 下午）做了什么

### 2.1 README

`README.md` 在「性能与资源」与「界面上的几个开关」之间新增
**「Demo 怎么用（输入 / 播放条 / 数据面板）」**：摄像头切换、拖拽/点选上传、播放条
（播放暂停/拖动/循环/重播）、回绕后记录停止的原因、20000 帧上限与丢弃数、
profile 下拉与「切换 profile 会清空记录」、「清空记录 vs 重置计数」、按钮禁用规则、
`localStorage` 设置记忆。同时把膝角曲线那条从写死的 100°/150° 改为「当前 profile 的上下阈」。

### 2.2 审核发现 + 修复（`/code-review`，重点状态回退/异步竞态）

1. **摄像头启动失败会清空已录帧**（`startCamera` catch 里无条件 `resetRuntime()`）。
   现在：文件正在播且摄像头流还没挂上（`assigned=false && prevMode==='file'`）时，
   保留播放与帧记录，只在状态栏报错；其余情况才走清理，且**不再 `resetRuntime()`**——
   已录帧仍可导出。无头实测：失败前 8 帧 → 失败后仍在增长（33 帧），mode 仍为 file。
2. **停止后导出丢失 model/delegate**（`stopAll()` 置空 activeModel/activeDelegate，
   `baseExportMeta()` 直接读它们）。现在保留这两个值给导出用，
   工具条 `#modelInfo` 改由 `estimatorReady && activeModel` 决定是否显示 `—`；
   `initEstimator` 失败分支也不再置空（帧仍属于上一档模型）。
3. **切换摄像头可并发起多条流**（`switchCamera` 无在途保护，后一次覆盖 `currentStream`，
   前一条流无人 `stop`）。新增模块级 `cameraStarting` 重入锁，`startCamera` 全程持有。
4. **模型初始化失败时旧视频被清状态**（`useVideoSource` 里 `ensureEstimator()` 失败分支）。
   现在若文件正在播就保持原状并释放新的 blob URL；否则才停循环/摘源。

### 2.3 判定数据修复（4 处）

用户要求「检查识别人体姿态动作时候参考的相关判定数据」后，用探针实测出 4 个问题并修复：

1. **坐姿被判成「下蹲」**：`squat_static` 只看膝角<110°+直立度，优先级又高于「坐」。
   `actions.posture.squat` 新增 `legVerticalGt: 0.85`（与计数门控同口径）；
   `--fit` 新增 `squat_static/leg_vertical` → 该键的映射。
2. **挥手混用左右手**：翻转取任一侧、幅度取两侧最大。`wave` 新增 `amp_L/amp_R`，
   `waving` 要求「同一条举起的臂」的翻转与幅度（走路摆臂 + 单手举起不再误报）。
3. **3D 失效不回退 2D**：动作层只看 `has_world`。信号层新增逐侧 `raised_sel_L/R`
   （3D 有效用 3D，NaN 才退回 2D），`armRaised` / `bothHandsUp` 改用它。
4. **2D 膝/肘角没有可见性门控**：腿被挡住时仍拿漂移/陈旧坐标算角。现在三点任一
   `visibility < visMin` → 该 2D 角给 NaN（不喂滤波器、不沿用旧值）。

对应单测：logic-test [6]/[9]/[13]/[17]/[21]，eval-test [28]。
注意 `params_hash` 因为参数变化而改变了（页面标题里可见），旧导出与新导出不可比指纹。

### 2.3 界面重设计（2026-10-30 傍晚）

方向：**测量仪器 / 取景器**。纯白底，界面颜色只表达确定性——状态绿/琥珀/红直接复用骨架的高/中/低置信配色，
不做装饰色；舞台是固定高度的深色取景窗，右侧是连续读数栏（不再堆四张卡片）。

- 结构：`web/index.html` 全量重写样式与面板结构。`.card` → `.mod`（发丝线分隔）；
  难例下拉与「判错了」从工具条移进「计数与记录」；顶栏压缩到 44px。
- 排版：数字/时间用 Bahnschrift（macOS 回退 DIN Alternate），中文用系统 UI 字体；
  正文字号 14px，面板数据 13.5–14px，姿态 36px；数据右对齐、等宽数字。
- 控件：开关改为自定义胶囊开关（背景圆点实现，不依赖 input 伪元素）；select 自定义箭头；
  「上传视频」改为真正的 `<button id="btnUpload">`（键盘可达），由 `app.js` 转给隐藏的 file input。
- 舞台：固定高度、`object-fit: contain`；**删除了 loop 里 `stage.style.aspectRatio = w/h` 的赋值**——
  它会把舞台压成竖屏视频的窄柱并把整页拉高。空状态加了取景十字圈。
- 响应式：>1080 两栏；≤1080 单栏 16:9；≤720 舞台 52vh、播放条隐藏时间/记录文字以免溢出。
- 其它：`drawSpark` 配色与字体同步新色板；`favicon.svg` 换成新标记；顶栏改为实色（滚动时不透字）。
- 无头检查新增三条断言：上传按钮能把点击转给 file input、文件模式下切换摄像头按钮隐藏、
  默认 profile 下标签不重复显示。

### 2.4 复验

```bash
npm test                                   # 531 通过，0 失败
node web/test/headless-check.mjs "http://127.0.0.1:8799/web/?src=/data/pose-test-vp8.webm"
# 结果：通过
```

另外用临时探针（`%TEMP%/pose-probe.mjs`，不在仓库里）在无头 Chrome 里实测了两条失败路径：
摄像头失败不再清空记录；点「停止」后 `#modelInfo` 显示 `—`，但 `logInfo.title`/导出仍保留 `lite/GPU`。

## 3. 仍未做（下一个 session 优先）

1. **人工浏览器 QA**（无头覆盖不到）：
   - 拖拽真实视频到画面；重复选同一文件；
   - 摄像头前后/多设备切换（真摄像头）；拔掉设备后回退；
   - 暂停→拖动→恢复；向后拖动后「记录已停止」；↺ 重播能恢复记录；
   - 勾选循环等一圈，确认记录停止提示；
   - 刷新页面，确认模型/帧率/开关/镜像/循环/profile 都被记住；
   - `?profile=/web/profiles/fitness.json` 自定义项能加载；故意写坏 URL 看回退；
   - 窄屏（<1000px）至少确认不崩。
2. **决定是否提交**：用户之前说「先不提交」；新 session 不要擅自提交。
3. 可选：把 `HANDOFF.md` 删除或移出仓库（未跟踪文件）。

### 已知风险 / 需要重点验证

- 摄像头相关的三条路径（成功、失败、切换）只有无头失败路径被实测过；成功路径需要真摄像头。
- `headless-check` 的 `frontend` 段会暂停/拖动/重播、切换镜像并写 localStorage；结束时视频在播放，
  profile 已切回默认。
- 播放条与工具栏新增控件在 1440×900 下已验证 `scrollHeight=900`；更窄宽度未验证。

## 4. 常用命令

```bash
cd E:/pose-demo/.claude/worktrees/handoff-continue-68ef56
npm test
py serve.py 8799
node web/test/headless-check.mjs "http://127.0.0.1:8799/web/?src=/data/pose-test-vp8.webm"
```

R4 手动检查：

```bash
node web/test/evaluate.mjs --dir eval-data --fit --fit-out /tmp/fit.json
node web/test/evaluate.mjs --dir eval-data --resample 15
node web/test/evaluate.mjs --dir eval-data --loso   # 需要 labels.subject 且 >=2 人
```

## 5. 约束与约定

- 工作区是 **worktree**；不要 `cd` 回主 checkout，不要在 `.claude/worktrees` 里重新初始化。
- 服务器默认 8765，多开时用 8799 并显式传给 headless，避免打到别的 checkout。
- `web/vendor/`、`web/models/` 不进 git；新 worktree 需要从别的 checkout 复制或跑 `scripts/fetch-assets.py`。
- `--fit-out` 的文件**不要**放进 `--dir` 目录（目录扫描会把 `.json` 当帧文件）。
- 评估口径：`--max-count-err` 是「每 20 次的绝对误差」；手势指标是帧级、弃权不进分母。
- 提交信息若需要，沿用仓库现有中文风格，并按系统提醒加 Co-Authored-By（仅在用户明确要求提交时）。
