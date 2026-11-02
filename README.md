# pose-demo

通用人体姿态识别：浏览器端零安装的骨架感知 Demo + 可配置的动作识别引擎。

> **版本状态：初始版**（`package.json` `0.1.0`）。这是第一个可运行的版本：
> 浏览器端 Demo、信号/动作层、离线评估与采集工具链都在这份仓库里；
> Python 服务端引擎、YAML 规则与多人实时跟踪仍只在 `PLAN.md` 的路线中，**本版没有实现**。
> 阈值是量级参考，尚未用实拍素材完成校准；具体验证范围见「初始版验证范围」。

定位与设计见 `IDEA.md`，路线见 `PLAN.md`，数据契约与信号定义见 `docs/`。

## 跑起来

```bash
cd E:/pose-demo
python scripts/fetch-assets.py   # 首次：下载 MediaPipe js/wasm 与模型（约 95MB，不进 git）
python serve.py                  # 多线程 + Range 支持，默认 8765
```

然后浏览器打开 **http://127.0.0.1:8765/web/**

- 点「摄像头」→ 允许摄像头权限，实时出骨架
- 或点「上传视频/图片」选本地视频或图片（图片是单帧判定，见「Demo 怎么用」）
- 或直接 `http://127.0.0.1:8765/web/?src=/data/pose-test-vp8.webm` 加载自带测试片段；
  `?src=/data/pose-test.jpg` 可直接打开一张图

> 别用 `python -m http.server`：它单线程且不支持 Range，浏览器同时加载 14MB wasm 和视频时会互相阻塞，
> 表现为视频一直 `readyState=0`。`serve.py` 就是为这个写的。

## 目录

```
web/                    浏览器 Demo（纯静态，无构建链）
  index.html            界面
  js/kpt.js             关键点格式定义（纯数据，Node 可导入）
  js/params.js          阈值参数的唯一定义处（profile 只写差分）
  js/pose.js            L1 姿态适配：MediaPipe Pose → 统一 frame 契约
  js/hands.js           L1 手部适配：MediaPipe Hand（21 点/手）+ 腕部 ROI 补检
  js/handroi.js         腕部 ROI 的几何（纯函数，可单测）
  js/handshape.js       手势分类（纯函数，可单测）
  js/signals.js         L2 信号层：One Euro、2D/3D 角度、Hold、RepCounter、骨骼一致性、遮挡外推
  js/stats.js           分布统计（分位 / 重合度，只给评估工具用）
  js/hardcase.js        难例窗口切分与草稿 label（纯函数；含 !动作 / noArm 反例选项）
  js/actions.js         动作字典（原语组合）
  js/draw.js            骨架 / 手部绘制
  js/app.js             组装：输入源 → 感知 → 信号 → 动作 → UI/导出
  profiles/             场景 profile（只写与默认阈值的差异）
  test/verify.html      自检页：?mode=image|video|hand，结果写进 window.__verifyResult
  test/logic-test.mjs   信号层/动作层/手势分类的确定性单测
  test/evaluate.mjs     离线评估与阈值拟合（导出帧 → recall/precision）
  test/eval-test.mjs    评估器自身的单测
  test/signal-compare.mjs  2D/3D 信号分布与跨机位重合度对比
  test/hardcase-test.mjs   难例窗口与草稿 label 的单测
  test/autolabel.mjs       用当前规则生成正例草稿 labels
  test/manifest-check.mjs  采集清单校验与覆盖度报告
  test/frame-io.mjs        评估工具共用的帧/labels 读取
  test/make-sample.mjs  生成合成样例 + labels（评估链路自检用）
  test/headless-check.mjs  无头 Chrome 真加载页面，检查 JS 错误与状态
  vendor/               MediaPipe js + wasm（本地，离线可用）
  models/               pose_landmarker_full/heavy/lite、hand_landmarker（不进 git）
docs/                   数据契约、信号定义、采集协议、评估流程、插图提示词
data/                   测试素材（单人/双人图与视频）
eval-data/              评估素材与标注（自拍内容，已被 .gitignore 排除）
serve.py                本地静态服务器
```

## 能识别什么

**姿态**：站立 / 坐 / 下蹲 / 躺卧
**手臂**：举手 / 双手高举 / 挥手 / 抱臂 / 叉腰 / 张开双臂 / 手在头部附近 / 伸手 / 持物 / 指向 / 前平举 / 侧平举
**手势**（每只手单独识别）：握拳 / 张开 / 剪刀手 / 指方向 / 竖拇指 / OK / 手枪 / 摇滚
**计数**：深蹲 / 俯卧撑 / 鼓掌 / 拿取

**只有上半身在画面里时**（桌面摄像头最常见的构图）：站/坐/蹲/躺缺少膝、踝证据，
姿态会显示「上半身 · 下半身不可见（出画/遮挡），站/坐无法判定」——这是信息不足，不是识别失败。
手臂动作、手势和鼓掌计数照常工作：尺度锚点自动改用肩宽，直立度改用鼻→肩轴
（见 `docs/signals.md` §三·八）。想判站/坐就把摄像头拉远到能拍到膝盖。

手臂动作大多只用姿态骨架就能判（肩、肘、腕三点 + 归一化位置）；
**伸手 / 持物 / 指向 / 拿取例外**：它们需要「手是张开还是握紧」，依赖手部模型。
手部关掉或没检出时，这 4 个动作恒为 `false` —— 宁可漏判，也不把「没检出」当成「手是空的」。
手势需要手部 21 点，所以「手部」开关关掉时手势面板会显示「已关闭」。

**全身/远景构图**里手只有几十像素，整帧 HandLandmarker 实测**一只都检不到**（样例视频 0/18 帧）。
本版用姿态腕点裁一块（边长 = 躯干长 × 1.8，至少 64px）放大再检，
同一模型在同样素材上 18/18 帧检出双手。只在整帧漏检且腕点可见时才会多付这一次推理，
因此 8 个手势与伸手/持物/指向/拿取在全身镜头下才真正可用。

**拿取（伸开手 → 握紧）是有序阶段**（`PhaseSequence`）：先伸手、再合手才计一次；没先伸手就合手、或伸手后
超时没合手，都不计数。

手臂判定有两处细节值得知道：

- **举手优先用 3D（相对躯干）判定**。MediaPipe 提供 `worldLandmarks`（米制、原点在髋中心），
  用它算「肩→腕」与躯干轴的夹角，能抵消机位俯仰。俯拍时手向前伸，2D 会误判成举手，3D 不会。
  没有 world 数据时自动退回 2D，与纯 2D 判定一致。
- **真叉腰要求腕贴髋且肘外张**。只看「腕到髋的距离」会把自然下垂的手算成叉腰
  （站着时腕本来就在髋旁，实测 0.19·scale）。

手势面板还会提示**手掌朝向**：侧对镜头时四指被压扁、手势不可靠，卡片会显示虚线边框。
手势本身经过 3 帧去抖，不会再「张开↔剪刀手」来回闪。

## 验证

```bash
npm test                            # 225 逻辑 + 259 评估器 + 46 难例 + 18 自动标注 + 23 清单 = 571 项
node web/test/logic-test.mjs        # 225 项：角度/滤波/滞回/计数门控/姿态互斥（含坐 vs 下蹲）/置信冻结/手势分类/可见性门控/抱臂抗转身/手部映射/3D 与 2D 逐侧退回/挥手同侧/骨骼一致性/外推/自适应周期/统计/拿取阶段机/注册表 flag 一致/上半身构图/腕部 ROI/手归属/平举物理门/换侧滞回/角度突变剔除/不可靠原因/手-臂对应
node web/test/eval-test.mjs         # 259 项：评估器自身对不对（反例语法、计数误报、失败区间、自动标注、混淆矩阵、分组、Wilson、门槛、扫描、A/B、时延、抖动、meta、目录配对、hands replay、每 20 次计数误差、video_time 回绕、手势帧级指标/弃权/归属、仅 none 段的手势误报、分位→profile（含下蹲腿竖直比）/LOSO/重采样）
node web/test/hardcase-test.mjs     # 46 项：前后窗口边界、video_time/ts 两种 label 时间基、非法动作、空窗口、!动作/noArm 反例导出、尾部锚点（区分播完与暂停）
node web/test/autolabel-test.mjs    # 18 项：区间合并/丢弃、计数周期、草稿内容与自评全通过、注册表覆盖
node web/test/manifest-test.mjs     # 23 项：清单字段与文件校验（含 heavy 档位）、覆盖度、计数与反例、动作 id/flag 等价、清单骨架、注册表覆盖
```

页面级（需要 serve.py 已启动）：

```bash
node web/test/headless-check.mjs    # 无头 Chrome 真加载页面：模型就绪、跑到帧、13 关键点、零 JS 错误
node web/test/headless-check.mjs "http://127.0.0.1:8799/web/?src=/data/pose-test-vp8.webm"   # worktree/多开：显式换端口
```

> 端口冲突：`serve.py` 默认 8765，Windows 允许第二个进程静默绑定同一端口，
> 后起的那个收不到请求——页面测试会打到**别的 checkout 的旧代码**。多开时务必用 `py serve.py 8799`
> 并把 URL 传给 headless-check。

浏览器自检（参数见 `web/test/verify.html`）：

- `.../verify.html?mode=image&model=full` 单张图，默认用 `data/pose-test.jpg`
  （图片没有时间窗，自检会把同一帧喂 12 次让 Hold/streak 收敛，否则姿态和手臂动作恒为 false；
  挥手与计数这类需要运动的动作在单帧上本来就不适用）
- `.../verify.html?mode=video&model=full&vid=/data/pose-test-vp8.webm`
- `.../verify.html?mode=image&poses=2&img=/data/pose-test-two.jpg` 多人（仅 IMAGE 模式有效）

## 量化动作准确率（重要）

「动作判得准不准」必须用数据回答，不能靠感觉。采集协议见 `docs/data-collection.md`，
评估口径见 `docs/eval.md`，最短路径：

```bash
# 1. Demo 里录一段视频并点「导出」，得到 .jsonl（一行一帧），放到 eval-data/a.jsonl
# 2. 生成标注草稿（只含正例，反例仍需人工补）
node web/test/autolabel.mjs --input eval-data/a.jsonl        # 独立工具，写 a.labels.draft.json（相邻计数并成一段并累加 count）
node web/test/evaluate.mjs --input eval-data/a.jsonl --autolabel --out eval-data/a.labels.draft.json   # 内置开关（动作清单相同，计数段逐次输出 count:1）
# 3. 对着时间线改边界，补 none / !动作 / noArm 反例段，另存为 a.labels.json
node web/test/evaluate.mjs --input eval-data/a.jsonl --timeline --every 5
#    手势段写法见 docs/eval.md §手势段：{"action":"gesture","hand":"L","shape":"fist",...}
# 4. 生成清单并填元数据，检查是否采够
node web/test/manifest-check.mjs --init --dir eval-data
node web/test/manifest-check.mjs --manifest eval-data/manifest.json
# 4. 打分
node web/test/evaluate.mjs --dir eval-data --report eval-data/report.md
# 5. 拟合阈值（按标注动作段分组给分位；--fit-out 直接写成 profile）
node web/test/evaluate.mjs --dir eval-data --fit --margin 0.1 --fit-out web/profiles/fitness-fit.json
# 5b. 留一人验证（labels 必须填 subject，至少 2 人；退化超限退出码 2）
node web/test/evaluate.mjs --dir eval-data --loso --max-loso-drop 0.1
# 5c. 帧率敏感性（15 fps 验收：看 Hold / 最短半程是否失效）
node web/test/evaluate.mjs --dir eval-data --resample 15
# 6. 门槛（可选，未达标退出码 2，可直接进 CI）
node web/test/evaluate.mjs --dir eval-data --min-recall 0.9 --min-precision 0.85 --max-count-err 1
# 7. 两套 profile 对比 / 单参数灵敏度
node web/test/evaluate.mjs --dir eval-data --compare web/profiles/a.json web/profiles/b.json
node web/test/evaluate.mjs --dir eval-data --sweep actions.reps.squat.down
```

`autolabel` 只生成正例；反例必须人工补，否则 precision 恒为 1（见 `docs/data-collection.md` §六）。
清单校验的退出码：0 达标 / 2 覆盖不足 / 1 清单有错，可直接进 CI。
`--max-count-err` 的单位是**每 20 次的绝对误差**（验收口径）：20 次里错 1 次记 1，多算一倍或完全漏数是 20。

报告按顺序包含：每动作 recall/precision（带 **Wilson 95% 区间和样本量 n**）、门槛、
**留一人验证（LOSO）**、**帧率敏感性**、**姿态混淆矩阵**、**手臂共现矩阵**、
**按机位/受试分组与跨组退化**、**事件时延与抖动**、失败区间、灵敏度扫描、
**建议 profile 覆盖（`--fit-out`）**、阈值分位。只有一行数字的报告没有用——先看 n，再看比例。

- `--loso` 用训练集拟合阈值、测留出者，报 Δ = 留出 − 训练；`--max-loso-drop` 可卡门槛。
- `--fit-out` 只翻译有信号来源的阈值（姿态门限、squat/clap/pushup 计数、抬臂/伸手），
  `onHips/head/carry` 与方位角仍需人工复核；输出文件不要放进 `--dir` 目录。
- `--resample <fps>` 会改变帧序号，`startFrame/endFrame` 标注会被拒绝。
- `--compare` 是信息性对比（Δ = B − A），会列出判定发生变化的段，不设退出码门槛。
- `--sweep` 会把参数扰动 ±10%/±20% 后完整重放，代价约为 5 倍评估时间。
- `--baseline <旧报告.json>` 可以卡「比上次不准就失败」，`--max-drop` 默认 0.05。

导出帧带 `video_time`（视频播放秒数），单次播放时标注直接写视频里看到的秒数，不用换算 `performance.now`。
页面检测到 `video_time` 回绕（循环播放或手动拖回）会**停止继续记录**并提示；旧的多圈导出里秒数不唯一，
评估器会要求改用 `start/end`（ts）或重新录制单次播放的素材。
报告里的失败段会带起止秒、帧号、关键信号的 min/中位/max，以及漏判时"实际判成了什么"。

没有实拍素材时，可以用合成样例先把链路跑通（**合成数据不能用来定阈值**）：

```bash
node web/test/make-sample.mjs && node web/test/evaluate.mjs --dir eval-data
```

### 2D / 3D 信号对比

`worldLandmarks` 是模型估计值，**不一定比 2D 准**。要不要在某条信号上切 3D，必须用数据回答：

```bash
node web/test/signal-compare.mjs --a eval-data/front.frames.json --b eval-data/side.frames.json --action squat
```

`--action` 会自动找同名 `<base>.labels.json`；没有 labels 时只做全帧分布对比，不筛选动作。
输出每条信号的分布（n、均值±SD、P5/P50/P95）和**跨素材重合度**（1=完全重合），
以及同一信号族 2D / 3D 的重合度差值。差值 > 0 表示 3D 换机位后更一致。
默认判定只用 3D 角度与直立度；`leg_vertical` 与距离比值的 3D 版本已并行导出，
等阈值重拟合后再通过 profile 打开（`signals.world.legVertical` / `signals.world.ratios`）。

### 难例闭环

页面上判错时，先在工具条的下拉里选“应该是什么”，或从「反例」里选“不应该出现”，再点 **判错了**：

- 正例（姿态/手臂/计数）：导出正例段；
- `!动作`（如「不应出现：叉腰」）：只否定这一个动作，站立不受影响——**单动作误报用这个**；
- `none`：整帧空镜（姿态和手臂都不许有），人站着时必然失败，不要拿它表达单动作误报；
- `noArm`：姿态不限，但任何手臂动作都不应出现。

1. 继续录 2 秒（点击前 3 秒的帧本来就在缓存里）；
2. 视频已经播完（或点击时距离最后一帧超过 3 秒）也没关系：窗口自动锚到**最后记录的那一段**，
   状态栏会写「视频已结束，导出最后一段」，草稿 `labels.note` 里也记着实际点击时刻；
3. 自动下载两个文件：`hardcase-<ts>.jsonl`（帧）和 `hardcase-<ts>.labels.json`（草稿 label）；
4. 把这两个文件放进 `eval-data/`，先按 `docs/eval.md` 改一下草稿边界，再跑全量报告。

只导出帧不导出视频：可离线复现、体积小、不保存人像。导出帧保留原始 `ts` / `video_time`，
所以草稿 label 直接就是评估器认识的格式。

## 切换场景 / 调阈值

阈值全部在 `web/js/params.js` 的 `DEFAULT_PARAMS`。要改一个场景的阈值，**不要改源码**，
复制 `web/profiles/fitness.json` 改成本场景的值，然后：

```bash
# 页面：http://127.0.0.1:8765/web/?profile=/web/profiles/fitness.json
# 评估：node web/test/evaluate.mjs --dir eval-data --profile web/profiles/fitness.json
```

profile 只写与默认值的差异，未写的键沿用默认。导出的 JSON 会带 `profile`、`params`、
`params_hash`、`model`、`delegate`，所以任何一份数据都能查到它是在哪套阈值、哪一档模型下产生的。

profile 还可以写 `"model": "lite"` 声明阈值校准所用的姿态模型档位。当前模型与声明不一致时，
工具条上的 profile 标签会标黄；评估时如果数据的 `model` 与 profile 的 `model` 不一致，
报告头部会给出警告 —— 各档（full / heavy / lite）的关键点噪声不同，阈值不能混用。
现有 `web/profiles/fitness.json` 声明的是 `lite`；默认模型已是 `full`，选中它时标签会标黄，
这是提醒你「这套阈值不是按 full 校准的」，不是错误。

## 加一个动作

本版只有浏览器 Demo：加动作要改 `js/actions.js`（引擎侧的 YAML 规则还没有实现，见 `PLAN.md`）。
在 `buildPostures()` 或 `ActionEngine.update()` 里加一条判定，然后登记到**唯一注册表**：

- 姿态 → `ACTION_CATALOG`（`{id, name, kind}`）
- 手臂 → `ARM_ACTIONS`（必须带 `flag`，即 `ActionEngine.update()` 输出里的布尔字段名）
- 计数 → `REP_ACTIONS`（`{id, name}`）

评估器的 `FLAG_IDS` / `REP_IDS`、自动标注、清单覆盖度、难例下拉、`--timeline` 列都从注册表派生，
不需要再改任何工具。登记后跑 `npm test`，一致性断言会检查每个动作都被评估/采集/难例覆盖。
阈值一律用角度和比值，不要用像素，并且写进 `js/params.js` 而不是直接写在判定里。

## 性能与资源（默认 full，其余按省电配）

姿态模型默认用 `full`：`lite` 的骨架（尤其下半身和遮挡）明显更差，而用户反馈的"动作识别不出来"
大多是从 lite 的噪声开始的。其余默认值仍按"能长时间开着"配：

| 项 | 默认 | 说明 |
|---|---|---|
| 姿态模型 | **full** | 三档：`full`（默认，准确度/速度平衡）、`heavy`（最准、最慢）、`lite`（省电，骨架精度明显更差）。阈值按档位校准，换档后旧 profile 可能不准 |
| 推理帧率上限 | **15 fps** | 10/15/30 可选。手部 + 姿态两个模型都在跑时，30fps 是双倍开销 |
| 手部补检 | 仅在漏检时 | 全身/远景下整帧检不到手，会对每只漏检的手多做一次裁图推理；两只都检出时不额外开销 |
| 模型加载 | **懒加载** | 打开页面不建模型，点「摄像头」/「上传视频/图片」才加载 |
| 后台暂停 | 开 | 标签页切到后台自动停推理（`visibilitychange`） |
| 停止按钮 | 释放模型 | 点「停止」会 `close()` 掉姿态与手部模型（手部的 VIDEO / IMAGE 两个实例都关），并停掉 rAF |

**注意**：这个 demo 里没有任何训练，全是推理。所谓"训练量大"不存在；
真正吃资源的是**同时开着多个标签页**，每个标签页都持有自己的 GPU 上下文、
一个姿态模型和两个手部实例（整帧 + 腕部补检）。
一个页面 15fps 大概占单核一小部分；开 5 个页面就是 5 倍。

## Demo 怎么用（输入 / 播放条 / 数据面板）

**输入**

- 「摄像头」开摄像头。桌面有多个摄像头时工具条出现「切换摄像头」，按 `deviceId` 轮换；
  手机（触屏）切前后置。上次用的设备会记住，设备拔掉后自动退回默认摄像头。
- 「上传视频/图片」或**直接把文件拖到画面区域**；点画面中间的提示区也能打开文件选择。
  重复选同一个文件也会重新加载。
- **图片**是单帧判定：同一帧会在信号/动作层重复喂 12 次，让 Hold/streak 收敛后再显示
  （否则姿态和手臂动作恒为 false）。姿态、手臂动作、手势都可用；
  **挥手和计数需要运动，单张图片上不会出现**。图片模式不记录帧，导出与「判错了」不可用。
  `?src=/data/pose-test.jpg` 也可以直接打开一张图。

**文件模式的播放条**（画面底部）

- ▶ / ❚❚ 播放暂停。拖进度条时先暂停，松手后按拖动前的状态恢复。
- 「循环」勾选后播到底回绕；**回绕或向后拖动会让记录停止**（显示「记录已停止」），
  因为一次导出里 `video_time` 必须单调。点 ↺ 会清空记录并从 0 重新播放。
- 「记录中 / 记录已停止」就是当前能不能导出。上限 20000 帧（≈11 分钟 @30fps），
  超出按批丢弃，数据面板会显示丢弃了多少帧。

**数据面板**

- profile 下拉在「默认阈值 / 健身 / 自定义」之间切换。`?profile=...` 或上次的自定义 URL
  会作为「自定义」项出现。**切换 profile 会清空已记录帧**——阈值变了，旧帧不属于同一套参数。
- 「清空记录」清空帧 + 计数 + 曲线；「重置计数」只清计数。
- 信号行会显示「不可靠：低置信 / 外推 / 换侧 / 骨骼异常 / 角度坏点」——这是**这一帧结论的可靠性**，
  不是动作。看误判时先看它：不可靠帧里的结论不要当真（含义见 `docs/signals.md` §三·九）。
- 没有帧时导出 / 清空 / 「判错了」都禁用；难例采样期间「判错了」保持禁用，避免重复点。

**设置记忆**：模型、后端、帧率、骨架/手部/关键点、镜像、循环、profile、摄像头（设备与前后）
都存在 `localStorage` 的 `pose-demo.settings.v1` 里，刷新页面后恢复。

## 界面上的几个开关

- **骨架 / 关键点**：关键点关掉只剩连线，弱机或录制时更清爽
- **镜像**：自拍习惯，关掉后左右与你本人一致（角度判定不受影响，角度是几何量）
- **膝角曲线**：右下曲线是最近 5 秒的膝角信号 + 当前 profile 的下阈/上阈阈值线，**这是校准阈值用的**。
  做几次深蹲，看曲线在多少度到底、多少度站直，再把实测值写进 profile 的 `actions.reps.squat.down/up`
  （`web/profiles/`，不要改源码）。

## 初始版验证范围

以下结论来自当前仓库的自动化测试、合成样例与样例视频；**不代表实拍准确率**。

- 逻辑单测 **225/225**：角度/滤波/滞回/计数门控/姿态互斥（含坐 vs 下蹲）/置信冻结/手势分类/
  可见性门控/抱臂抗转身/手部映射/3D 与 2D 逐侧退回/挥手同侧/骨骼一致性/外推/自适应周期/
  上半身构图/腕部 ROI/手-臂对应/换侧滞回/角度突变剔除/不可靠原因
- 评估器单测 **259/259**：反例语法、计数误报、失败区间、自动标注、混淆矩阵、分组、Wilson 区间、
  门槛、灵敏度扫描、A/B、时延与抖动、`video_time` 回绕、手势帧级指标/弃权/归属、
  分位→profile、LOSO、帧率重采样
- 难例/自动标注/清单单测 **46 + 18 + 23**：窗口边界、两种 label 时间基、反例导出、
  区间合并、草稿自评、清单字段与覆盖度、`heavy` 档位、动作 id/flag 等价
- 图片模式：单张真人全身照 → 33 关键点，置信度 0.935，膝角 163.1°、直立度 1.000、腿竖直比 1.33
- 视频模式：样例视频 146 帧连续推理，姿态判定「站立」，无 JS 报错，帧记录符合
  `docs/frame-schema.md`（`scale` 127.22px 与信号面板一致）
- 上半身构图：把样例视频裁到头~胸（髋以下出画）后重放，60/60 帧 `ok=true`，
  前平举等手臂动作正常输出（逻辑单测 [26] 覆盖同一场景）
- 全身手部：样例视频里整帧 HandLandmarker **0/18 帧**检出手；腕点 ROI 补检后
  **18/18 帧**检出双手。真页面 30fps 限速下 2 只手/帧、fps≈28.8，UI 显示「张开 / 指方向」。
  多人图上只保留目标人的手；双手靠近时按「离哪个姿态腕点最近」判归属
- 前/侧平举：走路摆臂的误报在加「2D 腕高接近肩 + 手臂基本伸直（3D reach > 0.85）
  + 300ms 保持窗」三道门后为 **0/63 帧**；合成数据的真正前/侧平举仍能判出（单测 [24]）
- 稳健性：左右侧选择 0.15 可见性滞回；换侧时计数半程中止；单帧角速度 > 1500°/s 判坏点。
  导出与界面给出 `unreliable` 原因（低置信/外推/换侧/骨骼异常/角度坏点）
- 多人：IMAGE 模式 `poses=2` 在双人图上返回 2 个框；**VIDEO 模式恒为 1 人**（模型限制，
  见 `docs/signals.md` §七）
- profile 生效：无头 Chrome 加载 `?profile=...`，把站立门控膝角抬到 200° 后姿态变 null，
  恢复后为「站立」
- 评估器：合成样例 4/4 段通过；故意标错时正确判失败；`replay` 带 `hands` 后
  `reaching` / `carrying` / `pointing` / `grasp` 与拿取计数可被离线度量
- 动作清单统一由 `js/actions.js` 注册表派生：评估器、自动标注、清单覆盖度、难例下拉、
  `--timeline` 列一致
- `video_time` 回绕：页面检测到回绕停止记录；评估器拒绝秒数标注并提示改用 `start/end`；
  自动标注在回绕素材上退回 `ts`
- 难例下拉支持 `!动作` / `noArm`，单个动作的误报可以直接回流
- 手势评估（**只有口径与工具，没有实拍数字**）：labels 支持 `gesture` 段，报告给出每种手势的
  帧级 recall/precision、`unknown`/侧对/未归属/未检出的弃权率与手-人归属率
- 单次播放不丢开头：视频先暂停等第一帧推理完成再播放（冷启动首帧要 1~2 秒）。
  3 秒测试素材实测 44 帧，`--timeline`/难例/评估都能拿到整段
- 页面级无头回归（`headless-check.mjs`）：模型就绪、视频帧、3D 分支、42 项难例下拉、
  「判错了」导出、1440×900 无滚动、零 JS 错误全部通过

## 已知限制（需要实机或实拍才能消除）

- **真实动作准确率没有数字**：深蹲/俯卧撑/挥手/躺卧/手势的识别率与计数准确性目前只有合成信号
  单测和评估器自测，**没有任何实拍素材跑过**。这正是 `docs/eval.md` 与
  `docs/data-collection.md` 要解决的问题，也是本版最大的空白。
- 摄像头实时路径没有在自动化里跑过（无头浏览器无法给摄像头）。
- 帧率数字来自无头环境，不代表真机；请在自己机器上开 DevTools 看。
- 跨机位阈值漂移幅度、不同身高体型的泛化都没有数据。
- 真机 / 非 Chrome 浏览器：页面级回归只在无头 Chrome + 1440×900 下跑过。
- 手势准确率：只有度量口径与工具（合成帧自测覆盖），8 种手势在实拍上的 recall/precision
  仍是 0 个数字；侧对帧占比也不知道。
- Python 服务端引擎、YAML 规则、多人跟踪不在本版内，见 `PLAN.md`。

## 插图

README 头图、汇报封面的生成提示词（含负面词、配色与后期清单）见
[docs/illustration-prompt.md](docs/illustration-prompt.md)。

## 许可

本项目代码以 **MIT** 许可发布，全文见 `LICENSE`。

Copyright (c) 2026 王宇 (b8nw27v7wp-bit)

依赖组件的许可是各自的，商用前请自行复核：

| 组件 | 许可 |
|---|---|
| MediaPipe Tasks Vision（`@mediapipe/tasks-vision`，含 PoseLandmarker / HandLandmarker 权重） | Apache-2.0 |
| `data/` 下的测试图片与视频 | 由 COCO 数据集样本（经 Ultralytics assets 仓库）裁剪而来，仅用于本地功能验证，不随产品分发 |

另外提醒：Ultralytics 自家的 YOLO 系列是 AGPL-3.0，本项目没有使用；若要换成 YOLO-pose，闭源商用需要买授权。
