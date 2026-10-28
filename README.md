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
  js/pose.js            L1 姿态适配：MediaPipe Pose → 统一 frame 契约
  js/hands.js           L1 手部适配：MediaPipe Hand（21 点/手）
  js/handshape.js       手势分类（纯函数，可单测）
  js/signals.js         L2 信号层：One Euro、角度、抬臂角、Hold、RepCounter
  js/actions.js         动作字典（原语组合）
  js/draw.js            骨架 / 手部绘制
  js/app.js             组装：输入源 → 感知 → 信号 → 动作 → UI/导出
  test/verify.html      自检页：?mode=image|video|hand，结果写进 window.__verifyResult
  test/logic-test.mjs   信号层/动作层/手势分类的确定性单测
  vendor/               MediaPipe js + wasm（本地，离线可用）
  models/               pose_landmarker_full/lite、hand_landmarker
docs/                   数据契约、信号定义
data/                   测试素材（单人/双人图与视频）
serve.py                本地静态服务器
```

## 能识别什么

**姿态**：站立 / 坐 / 下蹲 / 躺卧
**手臂**：举手 / 挥手 / 抱臂 / 叉腰 / 张开双臂
**手势**（每只手单独识别）：握拳 / 张开 / 剪刀手 / 指方向 / 竖拇指 / OK
**计数**：深蹲 / 俯卧撑 / 鼓掌

手臂动作只用姿态骨架就能判（肩、肘、腕三点 + 归一化位置），不需要手部模型；
手势需要手部 21 点，所以「手部」开关关掉时手势面板会显示「已关闭」。

## 验证

```bash
node web/test/logic-test.mjs        # 78 项：角度/滤波/滞回/计数门控/姿态互斥/置信冻结/手势分类/可见性门控/抱臂抗转身/手部映射
```

浏览器自检（需要 server 已启动，参数见 `web/test/verify.html`）：

- `.../verify.html?mode=image&model=full` 单张图，默认用 `data/pose-test.jpg`
- `.../verify.html?mode=video&model=full&vid=/data/pose-test-vp8.webm`
- `.../verify.html?mode=image&poses=2&img=/data/pose-test-two.jpg` 多人（仅 IMAGE 模式有效）

## 加一个动作

能用已有原语表达的动作，**不需要写代码**（引擎侧加一个 YAML）。Demo 侧在 `js/actions.js` 的
`POSTURES` 或 `ActionEngine.update()` 里加一条判定，然后在 `ACTION_CATALOG` 里登记以便显示。
阈值一律用角度和比值，不要用像素。

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
- 逻辑单测 41/41（阈值抖动不连发、过快周期不计数、坐下不算深蹲、站立弯肘不算俯卧撑、低置信冻结、挥手幅度门限）
- 多人：IMAGE 模式 `poses=2` 在双人图上返回 2 个框；**VIDEO 模式恒为 1 人**（模型限制，已写进 `docs/signals.md`）

未验证（需要实机/实拍）：

- 摄像头实时路径（无头浏览器无法给摄像头）
- 真实深蹲/俯卧撑/挥手/躺卧的识别率与计数准确性（目前只过了合成信号单测）
- 帧率：无头环境测得的数字不代表真机，请在自己机器上开 DevTools 看
- 跨机位阈值漂移幅度
