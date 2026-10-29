# pose-demo

通用人体姿态识别：浏览器端零安装的骨架感知 Demo + 可配置的动作识别引擎。
定位与设计见 `IDEA.md`，计划见 `PLAN.md`，数据契约与信号定义见 `docs/`。

## 跑起来

```bash
cd E:/pose-demo
python scripts/fetch-assets.py   # 首次：下载 MediaPipe js/wasm 与模型（约 63MB，不进 git）
python serve.py                  # 多线程 + Range 支持，默认 8765
```

然后浏览器打开 **http://127.0.0.1:8765/web/**

- 点「摄像头」→ 允许摄像头权限，实时出骨架
- 或点「上传视频」选一个本地视频文件
- 或直接 `http://127.0.0.1:8765/web/?src=/data/pose-test-vp8.webm` 加载自带测试片段

> 别用 `python -m http.server`：它单线程且不支持 Range，浏览器同时加载 14MB wasm 和视频时会互相阻塞，
> 表现为视频一直 `readyState=0`。`serve.py` 就是为这个写的。

## 目录

```
web/                    浏览器 Demo（纯静态，无构建链）
  index.html            界面
  js/kpt.js             关键点格式定义（纯数据，Node 可导入）
  js/params.js          阈值参数的唯一定义处（profile 只写差分）
  js/pose.js            L1 姿态适配：MediaPipe Pose → 统一 frame 契约
  js/hands.js           L1 手部适配：MediaPipe Hand（21 点/手）
  js/handshape.js       手势分类（纯函数，可单测）
  js/signals.js         L2 信号层：One Euro、角度、抬臂角、Hold、RepCounter
  js/actions.js         动作字典（原语组合）
  js/draw.js            骨架 / 手部绘制
  js/app.js             组装：输入源 → 感知 → 信号 → 动作 → UI/导出
  profiles/             场景 profile（只写与默认阈值的差异）
  test/verify.html      自检页：?mode=image|video|hand，结果写进 window.__verifyResult
  test/logic-test.mjs   信号层/动作层/手势分类的确定性单测
  test/evaluate.mjs     离线评估与阈值拟合（导出帧 → recall/precision）
  test/eval-test.mjs    评估器自身的单测
  test/make-sample.mjs  生成合成样例 + labels（评估链路自检用）
  test/headless-check.mjs  无头 Chrome 真加载页面，检查 JS 错误与状态
  vendor/               MediaPipe js + wasm（本地，离线可用）
  models/               pose_landmarker_full/lite、hand_landmarker
docs/                   数据契约、信号定义、评估流程
data/                   测试素材（单人/双人图与视频）
eval-data/              评估素材与标注（自拍内容，已被 .gitignore 排除）
serve.py                本地静态服务器
```

## 能识别什么

**姿态**：站立 / 坐 / 下蹲 / 躺卧
**手臂**：举手 / 双手高举 / 挥手 / 抱臂 / 叉腰 / 张开双臂 / 手在头部附近 / 伸手 / 持物 / 指向 / 前平举 / 侧平举
**手势**（每只手单独识别）：握拳 / 张开 / 剪刀手 / 指方向 / 竖拇指 / OK / 手枪 / 摇滚
**计数**：深蹲 / 俯卧撑 / 鼓掌 / 拿取

手臂动作只用姿态骨架就能判（肩、肘、腕三点 + 归一化位置），不需要手部模型；
手势需要手部 21 点，所以「手部」开关关掉时手势面板会显示「已关闭」。

**拿取（伸开手 → 握紧）和持物需要手部模型**：姿态层只有腕的位置，没有手的开合。
手部关掉或没检出时，这两个动作恒为 `false` —— 宁可漏判，也不把「没检出」当成「手是空的」。
拿取是**有序阶段**（`PhaseSequence`）：先伸手、再合手才计一次；没先伸手就合手、或伸手后
超时没合手，都不计数。

手臂判定有两处细节值得知道：

- **举手优先用 3D（相对躯干）判定**。MediaPipe 提供 `worldLandmarks`（米制、原点在髋中心），
  用它算「肩→腕」与躯干轴的夹角，能抵消机位俯仰。俯拍时手向前伸，2D 会误判成举手，3D 不会。
  没有 world 数据时自动退回 2D，行为与之前一致。
- **真叉腰要求腕贴髋且肘外张**。只看「腕到髋的距离」会把自然下垂的手算成叉腰
  （站着时腕本来就在髋旁，实测 0.19·scale）。

手势面板还会提示**手掌朝向**：侧对镜头时四指被压扁、手势不可靠，卡片会显示虚线边框。
手势本身经过 3 帧去抖，不会再「张开↔剪刀手」来回闪。

## 验证

```bash
npm test                            # 78 项逻辑单测 + 14 项评估器单测
node web/test/logic-test.mjs        # 78 项：角度/滤波/滞回/计数门控/姿态互斥/置信冻结/手势分类/可见性门控/抱臂抗转身/手部映射
node web/test/eval-test.mjs         # 21 项：评估器自身对不对（标对给分、标错扣分、计数差、未检出人体、profile 覆盖、三种时间写法、时间线）
```

页面级（需要 serve.py 已启动）：

```bash
node web/test/headless-check.mjs    # 无头 Chrome 真加载页面：模型就绪、跑到帧、13 关键点、零 JS 错误
```

浏览器自检（参数见 `web/test/verify.html`）：

- `.../verify.html?mode=image&model=full` 单张图，默认用 `data/pose-test.jpg`
- `.../verify.html?mode=video&model=full&vid=/data/pose-test-vp8.webm`
- `.../verify.html?mode=image&poses=2&img=/data/pose-test-two.jpg` 多人（仅 IMAGE 模式有效）

## 量化动作准确率（重要）

「动作判得准不准」必须用数据回答，不能靠感觉。完整流程见 `docs/eval.md`，最短路径：

```bash
# 1. Demo 里录一段视频并点「导出」，得到 .jsonl（一行一帧），放到 eval-data/a.jsonl
node web/test/evaluate.mjs --input eval-data/a.jsonl --timeline --every 5
# 2. 写 eval-data/a.labels.json（用 startSec/endSec 写视频秒数）
# 3. 打分
node web/test/evaluate.mjs --dir eval-data --report eval-data/report.md
# 4. 拟合阈值（按标注动作段分组给分位）
node web/test/evaluate.mjs --dir eval-data --fit --profile web/profiles/fitness.json
```

导出帧带 `video_time`（视频播放秒数），所以标注直接写视频里看到的秒数，不用换算 `performance.now`。

没有实拍素材时，可以用合成样例先把链路跑通（**合成数据不能用来定阈值**）：

```bash
node web/test/make-sample.mjs && node web/test/evaluate.mjs --dir eval-data
```

## 切换场景 / 调阈值

阈值全部在 `web/js/params.js` 的 `DEFAULT_PARAMS`。要改一个场景的阈值，**不要改源码**，
复制 `web/profiles/fitness.json` 改成本场景的值，然后：

```bash
# 页面：http://127.0.0.1:8765/web/?profile=/web/profiles/fitness.json
# 评估：node web/test/evaluate.mjs --dir eval-data --profile web/profiles/fitness.json
```

profile 只写与默认值的差异，未写的键沿用默认。导出的 JSON 会带 `profile` 和 `params`，
所以任何一份数据都能查到它是在哪套阈值下产生的。

## 加一个动作

能用已有原语表达的动作，**不需要写代码**（引擎侧加一个 YAML）。Demo 侧在 `js/actions.js` 的
`buildPostures()` 或 `ActionEngine.update()` 里加一条判定，然后在 `ACTION_CATALOG` / `ARM_ACTIONS`
里登记以便显示。**登记后还要在 `web/test/evaluate.mjs` 的 `ARM_ID_TO_FLAG` 里加映射**，
否则这个动作无法被评估器标注（`FLAG_IDS` 从那里派生）。
阈值一律用角度和比值，不要用像素，并且写进 `js/params.js` 而不是直接写在判定里。

## 性能与资源（默认就是省电档）

这台机器上曾经因为负载跑死过一次，所以默认值是按"能长时间开着"配的：

| 项 | 默认 | 说明 |
|---|---|---|
| 姿态模型 | **lite** | full 更准但更吃 GPU，需要时在工具条切 |
| 推理帧率上限 | **15 fps** | 10/15/30 可选。手部 + 姿态两个模型都在跑时，30fps 是双倍开销 |
| 模型加载 | **懒加载** | 打开页面不建模型，点「摄像头」/「上传视频」才加载 |
| 后台暂停 | 开 | 标签页切到后台自动停推理（`visibilitychange`） |
| 停止按钮 | 释放模型 | 点「停止」会 `close()` 掉两个模型并停掉 rAF，状态显示"模型已释放" |

**注意**：这个 demo 里没有任何训练，全是推理。所谓"训练量大"不存在；
真正吃资源的是**同时开着多个标签页**，每个标签页都持有自己的 GPU 上下文和两个模型。
一个页面 15fps 大概占单核一小部分；开 5 个页面就是 5 倍。

## 界面上的几个开关

- **骨架 / 关键点**：关键点关掉只剩连线，弱机或录制时更清爽
- **镜像**：自拍习惯，关掉后左右与你本人一致（角度判定不受影响，角度是几何量）
- **膝角曲线**：右下曲线是最近 5 秒的膝角信号 + 100°/150° 阈值线，**这是校准阈值用的**。
  做几次深蹲，看曲线在多少度到底、多少度站直，再把 `actions.js` 里的 down/up 改成实测值。

## 已验证 / 未验证

已验证（2026-10-28 实测）：

- 图片模式：单张真人全身照 → 33 关键点，置信度 0.935，膝角 163.1°、直立度 1.000、腿竖直比 1.33
- 视频模式：146 帧连续推理，姿态判定「站立」，无 JS 报错，帧记录符合 `docs/frame-schema.md`（`scale` 127.22px 与信号面板一致）
- 推理限速生效：rAF 60Hz 下稳定在 ~28 FPS，不再对同一帧重复推理
- 逻辑单测 111/111（阈值抖动不连发、过快周期不计数、坐下不算深蹲、站立弯肘不算俯卧撑、低置信冻结、挥手幅度门限、可见性门控、抱臂抗转身）
- 手部扩展：3D 抬臂角（含 world 与无 world 两条路径）、手在头部（含走路前摆反例）、手势去抖、手枪/摇滚、朝向与张开度
- 手臂扩展：双手高举与单臂举手的区分、自然下垂不算叉腰、肘外张才算叉腰
- 多人：IMAGE 模式 `poses=2` 在双人图上返回 2 个框；**VIDEO 模式恒为 1 人**（模型限制，已写进 `docs/signals.md`）
- 参数层：默认值参数化后 78 项单测全绿，说明行为未变
- profile 生效：无头 Chrome 加载 `?profile=...`，把站立门控膝角抬到 200° 后姿态变 null，恢复后为「站立」
- 评估器：合成样例 4/4 段通过；故意标错时正确判失败（自测 21/21）
- 导出帧带 `video_time`（实测视频 3 秒、帧上 0.93s，与 `ts` 确实是不同基准）
- 布局：1440×900 下 `scrollHeight=900`、无滚动、无卡片截断，profile 标签正常

未验证（需要实机/实拍）：

- 摄像头实时路径（无头浏览器无法给摄像头）
- **真实深蹲/俯卧撑/挥手/躺卧的识别率与计数准确性**：目前只有合成信号单测和评估器的自测，
  **没有任何实拍素材跑过** —— 这正是 `docs/eval.md` 要做的事，也是当前最大的空白
- 帧率：无头环境测得的数字不代表真机，请在自己机器上开 DevTools 看
- 跨机位阈值漂移幅度

## 许可

本项目代码以 **MIT** 许可发布，全文见 `LICENSE`。

Copyright (c) 2026 王宇 (b8nw27v7wp-bit)

依赖组件的许可是各自的，商用前请自行复核：

| 组件 | 许可 |
|---|---|
| MediaPipe Tasks Vision（`@mediapipe/tasks-vision`，含 PoseLandmarker / HandLandmarker 权重） | Apache-2.0 |
| `data/` 下的测试图片与视频 | 由 COCO 数据集样本（经 Ultralytics assets 仓库）裁剪而来，仅用于本地功能验证，不随产品分发 |

另外提醒：Ultralytics 自家的 YOLO 系列是 AGPL-3.0，本项目没有使用；若要换成 YOLO-pose，闭源商用需要买授权。
