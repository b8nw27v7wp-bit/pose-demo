# pose-demo

通用人体姿态识别：浏览器端零安装的骨架感知 Demo + 可配置的动作识别引擎。

> **版本状态：初始版**（`package.json` `0.1.0`）。这是第一个可运行的版本：
> 浏览器端 Demo、信号/动作层、离线评估与采集工具链都在这份仓库里；多人实时跟踪已实现
> （IMAGE 模式多人推理 + 自研跟踪器 + 每人一套判定流水线，见 `docs/multi-and-objects.md`）。
> Python 服务端引擎与 YAML 规则仍只在 `PLAN.md` 的路线中，**本版没有实现**。
> 阈值是量级参考，尚未用实拍素材完成校准；具体验证范围见「初始版验证范围」。
> **动作集**：躺卧、深蹲/俯卧撑计数已下线（需要全身或地面机位，桌面摄像头判不了）；
> **蹲下已恢复**，需要膝/踝可见的全身构图，背对相机时优先用 3D 膝角（见「能识别什么」）。
> 当前注册表是 **3 个静态姿态 + 2 个上半身推断姿态 + 7 个面板手臂动作 + 3 个隐藏可标注
> 手臂动作 + 5 个已下线手臂动作 + 1 个上下文事件（在设备旁）+ 8 种手势 +
> 1 个在用计数（拿取）+ 1 个已下线计数（鼓掌）**。理由与恢复方式见「能识别什么」。

定位与设计见 `IDEA.md`，路线见 `PLAN.md`，数据契约与信号定义见 `docs/`。

## 跑起来

```bash
cd E:/pose-demo
npm run fetch:assets   # 首次：下载 MediaPipe js/wasm 与模型（约 95MB，不进 git）
npm run serve          # 多线程 + Range 支持，默认 8765
```

> 没有 npm 时直接跑 `python scripts/fetch-assets.py` / `python serve.py`。
> Windows 上若只有 `py` 而没有 `python` 命令，把 `python` 换成 `py` 即可；
> `npm run serve` / `fetch:assets` / `fetch:data` / `report:ppe` 会自动选可用解释器（`scripts/py.mjs`）。

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
  js/geometry.js        设备多边形 ROI / 人框有效性 / 头部关键点（纯函数，可单测）
  js/headpose.js        头部朝向 yaw/pitch/roll（只看鼻/眼/耳，不依赖躯干；含尺度/几何门控，纯函数可单测）
  js/bodyfacing.js      人体朝向 front/back/left/right（只看肩线/躯干，背对相机时把方位角换成身体坐标；纯函数可单测）
  js/handshape.js       手势分类（纯函数，可单测）
  js/signals.js         L2 信号层：One Euro、2D/3D 角度、Hold、RepCounter、骨骼一致性、遮挡外推
  js/stats.js           分布统计（分位 / 重合度，只给评估工具用）
  js/hardcase.js        难例窗口切分与草稿 label（纯函数；含 !动作 / noArm 反例选项）
  js/actions.js         动作字典（原语组合）
  js/draw.js            骨架 / 手部绘制
  js/app.js             组装：输入源 → 感知 → 信号 → 动作 → UI/导出
  profiles/             场景 profile（只写与默认阈值的差异）
  test/verify.html      自检页：?mode=image|video|hand，结果写进 window.__verifyResult
  test/geometry-test.mjs 多边形 ROI / 人框有效性 / 头部关键点的纯函数单测
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

**姿态**：站立 / 坐 / 蹲下 / 上半身直立 / 上半身前倾
（后两个只在「肩+髋可见、膝/踝不可见」时输出，是**上半身推断**，不等于站/坐；
蹲下需要膝/踝可见的全身构图，背对相机时用 3D 膝角；坐与蹲靠「髋是否明显下沉」区分）
**手臂**：操作设备（阀门/仪表）/ 伸手 / 持物 / 指向 / 举手
（张开双臂 / 双手高举 / 手在头部仍可判定与标注，但不在动作面板显示；
挥手 / 抱臂 / 叉腰 / 前平举 / 侧平举已下线——引擎历史数据仍可评估，界面与新增标注不再出现）
**上下文**：在设备旁（`near_equipment`，人体框与设备 ROI/检测框重叠；不要求手在设备上）
**手势**（每只手单独识别）：握拳 / 张开 / 剪刀手 / 指方向 / 竖拇指 / OK / 手枪 / 摇滚
**头部朝向**（`yaw` / `pitch` / `roll`）：只看头部鼻/眼/耳 9 点，**不依赖躯干、髋、膝**，
所以设备特写、头~胸构图、只有半个头出镜时也能输出。**符号按受试者自身**：`yaw` 正=向右，
`pitch` 正=低头，`roll` 正=左侧更低，与页面镜像无关。默认用 2D（Pose 的 world 面部点实测
噪声很大，同一姿势 yaw 会跳 ±150°；3D 只在 profile 显式 `use3d` 时启用）。2D 的 `yaw/pitch`
是近似度（导出标 `yaw_approx/pitch_approx`）。带可信度门控：眼对/耳对 < 10px、鼻-眼几何
异常、眼对与耳对 yaw 不一致、`|roll| > 75°` 时角度置 `null`；`reliable` 逐轴说明幅度是否
可信。方向给出正前 / 左 / 右 / 上 / 下及组合（如左下），阈值带滞回 + 200ms 去抖；面板
「信号」里显示「头部朝向」，导出在 `signals.head`。头部完全出画或可见点不足时输出
`visible=false`，不会拿躯干猜头；实拍里背身/帽檐帧的角度会被门控挡掉。profile 里的头部
阈值（`signals.head.*`）在加载时做值域校验：区间颠倒、enter ≤ exit、尺度门自相矛盾会
直接报错，不会让头部信号静默恒 null（与放油取样参数值域校验同一口径）。

**人体朝向**（`signals.body`：正对 / 背对 / 侧对）：只看肩线/躯干，**不看脸**——背身时
MediaPipe 仍可能给鼻/眼点很高的可见度，但头部几何不可信。优先用 3D world 肩线在水平面的
朝向（`yaw=0` 正对、`±180` 背对、`±90` 侧对），无 world 时退回「肩的左右顺序 + 肩宽/躯干长
投影比」（侧对时肩线被压扁）。这一层把 `azimuth_*`（相机方位，0°=朝镜头）换算成
`azimuth_body_*`（身体方位，0°=身体前方）：背身时「手在身体前方」在相机坐标里是 ±180°，
不换算会让油样取样漏判、让背身的前伸/指向判成朝后；侧身时同理（身体前方在相机 ±90°）。
画面顶部徽标区显示朝向徽标（与分辨率、姿态徽标并排，`space-between` 布局下靠右），
多人标签带「·背面 / ·侧对」，导出在 `signals.body` 与
`signals.azimuth_body_*`。朝向状态带 200ms 去抖；角色只用躯干，所以背身回头时
`body.facing=back` 与 `head.yaw` 有值并不矛盾。profile 里的阈值（`signals.bodyFacing.*`）
同样在加载时做值域校验（正面/背面区间不能重叠、肩宽比/鼻偏移/去抖值域）。

**计数**：拿取（鼓掌计数已下线）

**操作设备（阀门/仪表）** 是「持续在做」的事件，不是瞬时手势：任一侧手腕进入 profile 配置的
**设备 ROI**（或检测到的设备框附近）、手在肩以下、两肩可见，并且持续 ≥800ms 才成立
（允许 600ms 内的短暂遮挡——profile 可调；refuel 档按实测采样间隔从 300ms 调到 600ms，
手腕被面板挡住几帧不会把计时清零）。既没有 ROI 也没有设备框时
**不判**——只有「伸手」这一条弱证据，会把拿东西/扶栏杆误报成操作设备。
ROI 支持旧矩形 `roi: {x,y,w,h}` 和新的多边形/多区域 `rois: [{id, points}]`（归一化 0~1，
`rois` 非空时旧矩形不参与；非法配置 fail-closed）。示例见 `web/profiles/refuel.json`
（`?profile=/web/profiles/refuel.json`，保持窗 1500ms、肘兜底 `minElbowVis 0.21 /
minElbowReach 0.315`；563 帧复核导出上 TP5/FN1/FP3，段级 R 0.833 / P 0.625）和
`web/profiles/refuel-polygon.json`（与 refuel 矩形等价的多边形接线示例）。换机位必须重标重校。

> **2026-11-20 起以 `web/accuracy.json` 为准**：`npm run accuracy` 改为读 `eval-data/incoming`
> （递归）并带 `pilot-panel` profile，用当前 290 帧 5fps 导出 + 8 段硬负例；当前 operating
> 3TP/3FN/3FP（R .5 / P .5），near 4/2/3。上面的 5/1/3 与 3/3/2 都是 563 帧旧导出，两组数字不可混用。

**在设备旁（`near_equipment`）** 是独立的上下文事件，**不要**把它并进 `operating`：它只回答
「人在设备区域里」，人体框 ≥50% 落在 ROI/设备框内（refuel 档）、两肩可见、保持 1s。refuel 上它
自身 TP3/FN3/FP2（段级 R 0.5 / P 0.6），但补上了 `operating` 唯一漏掉的 20.4–23.9s
（手被设备挡住）——两个动作的并集覆盖 **6/6** 正例段。它也会在手套/设备特写被误检成人时
触发，所以只能当上下文，不能当「在操作」。profile 可选开 `nearEquipment.validity` 挡掉
过小/满屏/大半出画的「人框」（默认关闭；`web/profiles/refuel-strict.json` 是 A/B 用的实验档）。
同一份 563 帧 refuel 导出上，多边形档与 refuel 档的 operating/near_equipment TP/FN/FP 完全一致
（5/1/3、3/3/2）；strict 档也一致——该片段没有触发人框门，门的效果仍待更多特写素材验证。

**人物有效性门**（`perception.personGate`，默认开）是更低一层的护栏：低清晰度特写里
MediaPipe 会把「手 + 取样管/瓶子」补成一个完整的人（鼻/肩/髋可见度接近 1，但 bbox 是
62×599 的细长条），进而触发 `operating` 或上半身姿态。这里用两道几何门剔除：

1. 姿态几何：bbox 宽/高 < `minAspect`（细长条）、躯干长/框高 > `maxTorsoHeight`、
   关键点平均置信 < `minScore`，或双肩+双髋最低可见性 < `minAnchorVis`；
2. 手部包含：鼻/双肩/双髋里至少 `minAnchors` 个落在同一只手框（外扩 `expand`）内，
   或手框面积 ≥ 人体框的 `maxHandAreaRatio`。

另有一道**只作用于骨架绘制**的倒置门：髋中点高于肩中点（躯干倒置）的人不画骨架
（`perception.personGate.drawMinTorsoDrop=0`，水平/弯腰仍画）。它不参与动作判定——
逐帧剔除会打断 `Hold` 的连续帧，B787 面板实测把 `operating` 从 17 次采样打到 1 次；
需要连动作一起过滤的 profile 可显式打开 `minTorsoDrop`（默认 `null`）。

拿不到 bbox/kp/手数据时 **fail-open**（旧数据/测试夹具不因少字段被剔除）；profile 写
`perception.personGate.enabled=false` 可关闭。阈值来自 4 段真实人物素材 + light_tube
误检的对比（真实人物 0% 误杀），**换机位必须用自己的素材复核**——门只剔除几何上不可能的
「人」，不解决真正的遮挡/小目标漏检。没有手部检出、几何又像人的特写仍可能残留
（light_tube 225 帧里 2 帧）；要彻底消除需要物体检测的 `person` 证据或分割 mask，
当前残帧不参与 `operating`。

**PPE 几何**：头部区域优先用 9 个头面部关键点（鼻/眼/耳，`persons[].kp_head`），鼻尖不可见但耳朵
可见时仍能判；旧数据没有该字段时退回鼻尖。手套区域优先用手部 21 点 bbox，手未检出/未归属时
退回腕点方框。两条路径都会在 `verdicts[].ppe` 里写 `source`/`box`，便于离线审计。

**设备检测框**：profile 配 `operating.equipmentLabels` 并打开物体检测后，
`operating` 优先用「腕/肘到检测框边 ≤ `equipmentMaxDist·scale`」，ROI 只作检测不到时的兜底；
`near_equipment` 取「人体框与检测框重叠」和「与 ROI 重叠」的较大值（检测框只框设备本体，
只认框会把人站在面板前的正例压掉）。
仓库**不附带**训练好的权重，但完整链路已跑通：`web/profiles/refuel-equipment.json`
（panel/valve/gauge，ONNX 320）在同一份 refuel 导出上把 `operating` 从 ROI-only 的 3/3/3
变成 **3/3/2**，召回不变；2026-11-16 起该档默认 `equipmentFallbackRoi=false`
（没有设备框就不判），8 段街景/姿态硬负例从 6/8 触发降到 **0/8**，
`near_equipment` 由独立开关保持 3/3/2。
模型是用同一段 58s 演示片的分镜框训练的（同集冒烟，valve 无 val 实例、gauge 基本检不到），
**不能当泛化准确率**。训练、导出、sidecar 与验收见
[`docs/equipment-detector.md`](docs/equipment-detector.md)；信号导出带 `operating_equipment`
说明本帧是否有设备检测框（不代表这次判定一定用了框）。

> **本版不再判躺卧与深蹲/俯卧撑计数**（需要地面机位/周期计数）；**蹲下已恢复**。
> 蹲下需要膝、踝同时可见、机位能拍到全身或地面，桌面摄像头和上半身构图下判不了——
> 不是识别失败，是输入里没有这些证据，此时保持 `null`，不硬凑。背对相机的工人：
> 2D 膝角会被透视压扁（看起来接近伸直），信号层默认优先用 world 3D 膝角，所以背影机位
> 仍能判蹲下；判据是「膝角 20–135° + 腿竖直比 <0.8（髋明显下沉）+ 躯干不接近水平 +
> 髋不比膝高出太多」，见 `docs/signals.md` §三·八·八。**坐 vs 蹲**靠腿竖直比分：
> 坐在椅子上约 0.9~1.0（>0.8）→ 坐；深蹲/半蹲 0~0.7 → 蹲。低凳坐着髋同样很低，
> 纯姿态仍无法区分（已知歧义），需要 profile 收紧阈值或座椅证据。
> 背身时远侧腿常被挡住，`leg_vertical_pick` 只用可见性更高的一条腿。
> 躺卧/深蹲计数仍可从历史提交恢复（阈值键曾放在 `actions.posture` / `actions.reps`）。

**多人**（工具栏「多人」，或 profile 里 `perception.multi.enabled`）：同时判最多 4 个人，
每人一条独立的状态机（计数、滞回、持续时长互不干扰），画面里给每个人标 `#id + 姿态`。
多人走 IMAGE 模式逐帧推理 + 自研跟踪器（VIDEO 模式只回一个人），id 在丢失 1.5s 内保持不变。
实现与实测见 `docs/multi-and-objects.md`。

**物体检测 / PPE**（工具栏「物体」）：安全帽、手套这类"人身上有没有那件东西"不是姿态问题，
是目标检测 + 人-物空间关系。打开后：头部区域内有 `helmet` → 戴了；头可见但区域内没有 →
缺帽（连续 3s 才升为违规）；头/腕不可见 → `unknown`，**绝不判违规**。手套默认只报「疑似」，
理由见下文。两条后端：MediaPipe `.tflite`（类别名来自模型 label map）和自训 YOLOv8 → ONNX
（`perception.objects.backend='onnx'`，类别名由 profile 的 `labels` 按训练顺序给出），
训练/导出/接入见 `docs/ppe-training.md`。

**只有上半身在画面里时**（桌面摄像头最常见的构图）：站/坐/蹲缺少膝、踝证据，但肩+髋仍能给出
躯干朝向。此时姿态输出 **`upper_upright` 上半身直立** 或 **`upper_lean` 上半身前倾**，
面板同时标「仅上半身可见 · 推断」——它不是站/坐：坐着但躯干挺直也会命中上半身直立。
髋也看不到时不猜（显示「上半身 · 下半身不可见」）。手臂动作、手势和拿取计数照常工作：
尺度锚点自动改用肩宽，直立度改用鼻→肩轴（见 `docs/signals.md` §三·八）。想判站/坐就把摄像头
拉远到能拍到膝盖；膝/踝一旦可用，站/坐优先于上半身姿态。

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

已下线动作（挥手/抱臂/叉腰/前平举/侧平举）与鼓掌计数的判定、信号仍保留在引擎里，
见 `web/js/actions.js` 的 retired 标记；界面与新增标注不再出现它们。

手势面板还会提示**手掌朝向**：侧对镜头时四指被压扁、手势不可靠，卡片会显示虚线边框。
手势本身经过去抖（同一手势累计命中 3 次才切换，中间判不出的帧跳过），不会再「张开↔剪刀手」来回闪。

右侧「动作识别」面板按设备作业的关注点分层：**操作设备 / 油样取样 / 放油取样**是三张主卡
（一行一张；**每张卡右侧各有一盏指示灯**，对应动作触发时亮绿、未触发是灰灯、
当前条件下判不了是空心灯；灯左侧写 未触发 / 进行中 / 不可判），其余产品动作（伸手/持物/指向/举手）
按小格排在「其他动作」下，上下文事件「在设备旁」单独一行。姿态（当前姿态）与原始信号两块
**已从界面移除**——设备作业场景只看动作；判定数据仍完整记在每帧里，导出与回放不受影响。

三张主卡正下方是一个**「触发」文字框**（独立描边，紧跟卡片）：**只跟这三张主卡**，用文字列出
此刻是否触发与已持续时长，并保留最近 6 次已结束的触发（结束时间 + 持续时长）；没有触发时显示
「无触发」。伸手/指向/举手与上下文「在设备旁」是逐帧保持窗的瞬时动作，不放进这个框（否则
「最近触发」会被刷成噪声）。它只读 `act.flags`，不往画面上叠加任何框，判定口径仍然完全由
`actions.js` 决定。

**排版**：界面正文用思源黑体（Noto Sans SC，基准 15px，可回退微软雅黑/苹方），
站名「通用姿态识别」用宋体（Windows 宋体加粗 / macOS Songti SC）作为全页唯一的编辑性文字；
栏目标题 15–16px、核心动作卡 18px。页面与卡片都是纯白（`#ffffff`），层级只靠浅灰描边，
1440×900 下不产生整页滚动。
触发框随「新的一段记录」清空（停止、重播、切换 profile、清空记录）。

面板同时给出**判定条件与准确率**：悬停每个动作名可看判定依据、成立条件与已知误判；
面板下方一行按当前帧给提示（手部模型关闭/未加载/未检出、无 3D、设备 ROI/检测框缺失、置信不足）。
动作名前的**空心圆点**（主卡右侧写「不可判」）表示当前条件下这个动作根本判不了
（比如没开手部模型时的伸手/持物/指向），不是「还没做」。提示行会带**左右手粒度**
（如「左手举手」「右手指向」）；手势动作按具体手型判：
伸手只认「张开」，指向只认「指方向/手枪」，两者不再同时亮。文案与判据同源于
`web/js/armhint.js`，改判据时要一起改。

点面板右侧的**「准确率」**展开 8 项（7 个面板手臂动作 + 在设备旁）的**实测召回/精确率**（来自评估报告，见下文
「量化动作准确率」）。每个方向样本 <20 段（手势为帧）时不报百分比；没有报告或没有标注数据时显示「未评估」——
不拿规则自估或合成样例冒充实拍准确率。

## 试点范围（pilot-panel）

2026-11-20 起，对外演示/试点默认用 `web/profiles/pilot-panel.json`，把口径收敛到能拿证据的部分：

- **在范围内**：固定机位、单人、**panel** 设备 ROI 明确的 `operating` / `drain_sample` /
  `near_equipment`；姿态与上半身构图只作上下文。
- **不在范围内**：多人、8 类手势精度、PPE 准确率、头部角度精度、`oil_sample`、
  valve/gauge 作为主判据、跨机位/换人泛化。引擎仍会算这些信号，但不得写进验收。
- **当前证据**：`npm run accuracy` / `npm run eval` 固定读 `eval-data/incoming`（递归）并带
  `pilot-panel`；当前 583 帧、9 段（1 段 58s 正例演示 + 8 段硬负例）。operating
  3TP/3FN/3FP（R .5 / P .5），near 4/2/3（R .667 / P .571），**n<20，页面只显示「样本不足」**。
- **升级条件**：按 [`docs/data-collection.md`](docs/data-collection.md) 补 **2 人 × 2 机位、
  每个动作 ≥40 正/20 反**，带 `camera` / `subject` 字段，用 `deterministic-replay.mjs` 固定 fps
  复跑；头部角度另用 `web/test/headpose-eval.mjs` 报分档/弃权/MAE。达不到就不扩大承诺。

## 验证

```bash
npm test                            # 22 槽位 + 66 几何 + 90 头部朝向 + 14 头部角度评估 + 56 人体朝向 + 26 设备框 + 36 operating + 39 油样/放油取样 + 23 蹲下 + 334 逻辑 + 49 动作提示 + 37 准确率 + 338 评估器 + 46 难例 + 21 自动标注 + 27 清单 + 7 信号对比 + 133 多人 + 31 ONNX + 54 PPE + 25 PPE 评估 + 18 手部关键点；合计 1492 项
node web/test/slot-test.mjs         # 22 项：估计器槽位的同 key 复用、换 key 重建、并发创建先后完成都不覆盖、close 作废在途创建、失败不污染槽位、superseded 标记
node web/test/geometry-test.mjs     # 66 项：旧矩形规整（含归一化值域 fail-closed）、多边形配置/点内测试/面积/矩形裁剪、多 zone 最大重叠、resolveRegions 优先级与 fail-closed、人框有效性、头部 9 点换算、人物有效性门（细长条/躯干过长/躯干倒置的绘制门/锚点不可见、整块身体落在手框里、缺字段 fail-open）
node web/test/headpose-test.mjs     # 90 项：头部朝向 yaw/pitch/roll 的 2D 默认与 3D 显式开关（含 yaw_3d/pitch_3d/roll_3d 诊断字段与刚性转头）、受试者左右符号、侧倾、部分头点（缺鼻/单眼）、尺度门/鼻-眼几何门/眼耳一致性门/roll 上限门、缺 visibility（2D/3D 同口径）、耳对回退、2D/3D 阈值分开、方向滞回与去抖、单轴不可用不拼 null、UI 文案
node web/test/headpose-eval.mjs --self-test  # 14 项：头部角度分档评估、弃权/覆盖率（含角度为 null 但方向仍在去抖保持窗内时算弃权）、roll 容差、MAE/P90、秒/毫秒标注、未知分档报错、无 signals.head 警告
node web/test/bodyfacing-test.mjs   # 56 项：人体朝向的 2D 肩顺序/肩宽比/侧对鼻向/缺尺度不猜、3D 肩线 yaw 符号与边界、肩宽越界/鼻深矛盾的置信度惩罚；背身时相机方位角↔身体方位角换算、油样取样「手在身体前方」、背身指向/前平举用 body 口径、旧信号退回相机口径、profile 值域校验
node web/test/logic-test.mjs        # 334 项：角度/滤波/滞回/计数门控/姿态互斥（蹲下 vs 坐 vs 站立 vs 上半身直立/前倾）/置信冻结/手势分类/手势去抖（累计命中、unknown 跳过、无推帧间隔过期）/可见性门控/抱臂抗转身/手部映射/3D 与 2D 逐侧退回/挥手同侧/骨骼一致性/外推/自适应周期/统计/拿取阶段机（含 releaseMs 闭锁）/注册表 flag 一致/上半身构图/腕部 ROI/手归属/平举物理门/换侧滞回/角度突变剔除/不可靠原因/手-臂对应/手型与左右侧绑定/操作设备掉帧容忍（含引擎漏调用的大间隔）/设备框与 ROI 的 union/fail-closed/多边形 ROI/人框有效性/operating 不成立时不报 zone/头部时序与坏点门
node web/test/armhint-test.mjs      # 49 项：15 个动作的提示覆盖、手部关闭/未加载/未检出、无 3D/配置关闭、置信不足、多动作提示优先级、准确率文案（提示行与 tooltip）、左右手粒度、无画面时按 profile 标 ROI/检测框不可用（detector-only 还要求物体检测已开且就绪）、人框有效性文案
node web/test/accuracy-test.mjs     # 37 项：flag→id 映射、n/95%CI 保留、样本不足不报百分比（含段数与 TP/FN/FP）、未评估、合成来源标记、profile/数据源目录透传、档位边界、报告加载容错、参数指纹过期检测、多 track 池化
node web/test/eval-test.mjs         # 338 项：评估器自身对不对（反例语法、计数误报、失败区间、自动标注、混淆矩阵、分组、Wilson、门槛、扫描、A/B、时延、抖动、meta、目录配对与递归配对、hands replay、每 20 次计数误差、video_time 回绕、手势帧级指标/弃权/归属、仅 none 段的手势误报、分位→profile/LOSO/重采样、多人逐 track 与 label.track/uid、旧单人回归、物体模型指纹与跨模型 baseline 拒绝、多 track baseline/sweep/A-B、逐 track 抖动与姿态混淆矩阵、帧尺寸透传、objects 接线与 operating 离线回放、上下文事件不计入 noArm/none、kp_head/多边形回放、放油取样/头部朝向/operating 结构参数校验（含 2D/3D 量纲）、pilot-panel 口径、审核 P0 回归（多人段缺 track、按 track 拟合、baseline 回退与未匹配、多次拿取草稿、BOM JSONL））
node web/test/hardcase-test.mjs     # 46 项：前后窗口边界、video_time/ts 两种 label 时间基、非法动作、空窗口、!动作/noArm 反例导出、尾部锚点（区分播完与暂停）
node web/test/equipment-test.mjs    # 26 项：设备框时序确认/过期/重帧去重、线段到框距离、单人道主目标选择
node web/test/operating-test.mjs    # 36 项：operating 的 gate 诊断、框时序、ROI 约束、前臂/握持/人形门、nearEquipment 独立兜底开关、fail-closed 下的框有效期校验
node web/test/sampling-test.mjs     # 39 项：油样取样（oil_sample）与「手在头部」的边界、3D 方位角门、保持窗；放油取样（drain_sample）的蹲姿/双手靠拢/膝角上下限/单膝跪地不随可见度翻转/遮挡期间不拆成单手/接近站立需前倾
node web/test/crouch-test.mjs       # 23 项：蹲下姿态——背对相机时 2D 膝角被压扁、靠 3D 膝角判蹲；只有 2D 的深蹲；一条腿被挡时用单腿竖直延伸仍判蹲；站姿/单膝跪地/双腿不可见不判蹲；坐姿不被更高优先级吃掉；动作目录注册与 profile 阈值覆盖/值域校验
node web/test/autolabel-test.mjs    # 21 项：区间合并/丢弃、计数周期（含离场重计数与计数回退）、草稿内容与自评全通过、注册表覆盖
node web/test/manifest-test.mjs     # 27 项：清单字段与文件校验（含 heavy 档位）、覆盖度、计数与反例（上下文动作不记 none/noArm）、labels 解析失败、动作 id/flag 等价、清单骨架、注册表覆盖
node web/test/signal-compare-test.mjs  # 7 项：动作 id/flag 等价、反例窗口不进正例采样、三种时间写法
node web/test/multi-test.mjs        # 133 项：跟踪 id 稳定/防换 id/超时换 id（含先 prune 再匹配）、每人独立状态机与 gap 重置、流水线上限只淘汰过期项、手部归属（bbox 内/腕部外扩 + 次近人 margin + 整帧左右侧按腕点纠正）、逐 track 手势去抖隔离、ROI 预算与 minScalePx、PPE 标签/几何/unknown 语义/持续门槛、平铺几何、运动/外观/最优分配、物体框坐标（像素/归一化）、导出上限与 meta 接线、face/hand 区域
node web/test/onnx-test.mjs         # 31 项：YOLOv8 输出解码（[C,N]/[N,C]）、逐类别 NMS、letterbox 逆变换、形状/缺省参数校验、sidecar 类别顺序/inputSize/缺失校验、生成脚本的 --labels 路径/注释解析
node web/test/ppe-test.mjs          # 54 项：track_uid 稳定与旧数据回退、PPE 计时随 id 变化、requirePositive 窗口护栏（按帧去重）、reason_code（no_positive/config_mismatch/occluded/no_hand）、头部 face 区域、手套 hand 区域（含 fallbackWrist=false）、hands 透传、短 kp_head 兜底
node web/test/ppe-eval.mjs --self-test  # 25 项：PPE 事件评估骨架（多 track、unknown 暂停/弃权、label.track 中途进场与 uid 绑定、bbox 失配、段级 camera 分组、旧数据明确报错、告警事件按 clip 匹配）
node web/test/handkp-eval.mjs --self-test  # 18 项：手部 21 点质量评测（刚性/平移/缩放不变性、单关节噪声与形变、侧别/间隔/来源拆分、PCK/MPJPE、退化输入、缺关节不崩）
```

页面级（需要 serve.py 已启动）：

```bash
node web/test/headless-check.mjs    # 无头 Chrome 真加载页面：模型就绪、跑到帧、13 关键点、动作提示、准确率明细、零 JS 错误
node web/test/headless-check.mjs "http://127.0.0.1:8799/web/?src=/data/pose-test-vp8.webm"   # worktree/多开：显式换端口
node web/test/headless-multi.mjs "http://127.0.0.1:8799/web/?src=/data/pose-test-two.webm"  # 多人 + 物体检测 + 关物体后导出指纹（23 项）
node web/test/headless-pose-switch.mjs "http://127.0.0.1:8799/web/"  # 快速连切模型：先发请求被取代并释放，最终槽位是最后一次请求（11 项）
node scripts/pose-screenshots.mjs   # 用 data/ 现有素材跑姿态识别并截图：多人/单人图片与视频 + refuel 演示片，结果写到 runs/pose-test-<日期>/（截图含人脸，runs/ 不进 git）
node scripts/refuel-sampling-suite.mjs   # 加油/油样采样观察轮：8 段既有素材按 INDEX 的取样窗口跑 Demo，逐段记录动作/设备框并整页截图，输出 runs/refuel-sampling-suite-<日期>/（testset.json + report.md；可 --only 跑单段，素材版权见 eval-data/airport-refuel/INDEX.md）
node scripts/deterministic-replay.mjs <srcUrl> <profileUrl> <outName> --fps=10   # 确定性逐帧回放：固定媒体时间 seek，两次导出逐帧内容 sha256 一致（感知层 A/B 用，见 docs/eval.md）
node web/test/headless-ppe-onnx.mjs # 自训 PPE 冒烟模型：ONNX 后端加载、labels 对齐、no_helmet 不被当正类（需 web/models/ppe_smoke.onnx）
node web/test/throughput-probe.mjs  # 吞吐探针：应用自报 fps、实测帧/s、pose/hands/objects/draw 各阶段毫秒
node web/test/mot17-eval.mjs        # MOT17 gt 帧级评测：TopK 召回 / ID 切换 / 动作触发率（需先 npm run fetch:data）
node web/test/mot17-eval.mjs --rate 0.4   # 慢放逐帧：A/B 对比用（实时播放每次丢的帧不同，ID 切换会抖 ±10%）
```

> 端口冲突：`serve.py` 默认 8765，Windows 允许第二个进程静默绑定同一端口，
> 后起的那个收不到请求——页面测试会打到**别的 checkout 的旧代码**。多开时务必用 `py serve.py 8799`
> 并把 URL 传给 headless-check。

素材切片 / 抽帧（可选）：

```bash
# 先「看懂素材」：读编码（H.264/HEVC/AV1 都能解），按间隔抽帧拼成带时间戳的接触表。
# 输出 eval-data/incoming/_inspect/<文件名>/：frames/、sheet.jpg、manifest.json
npm run inspect -- eval-data/incoming/<素材>.mp4 --step 10 --max 24
# 只看某一段：--start 60 --end 120（秒）；--no-frames 只写接触表，不碰已有帧
# 解释器由 scripts/py-cv.mjs 自动探测（仓库 .venv-ppe/.venv → PATH 上的 py/python3/python），
# 不需要手动写 .venv-ppe/Scripts/python.exe；找不到装了 cv2 的 Python 时会给出建 venv 的命令。

.venv-ppe/Scripts/python.exe scripts/slice-video.py <video> <outDir> [--step 0.5]
# → clips/（按镜头切段）、frames/（每 0.5s）、keyframes/、sheets/（接触表）、manifest.json
# 同一个 outDir 换素材重跑会先删掉上一轮的 frames/clips/keyframes/sheets，不会新旧混集。
# 有 ffmpeg（PATH 或 pip install imageio-ffmpeg）时切片写 H.264+AAC，浏览器可直接 ?src= 回放、
# 讲解音保留；没有时用 OpenCV mp4v 兜底：无音轨，Chrome 不能播（OpenCV/VLC 可复核）。

node scripts/clip-recognition.mjs --clip /eval-data/refuel/oil-sample-demo.mp4 \
  --profile /web/profiles/refuel.json --out runs/clip-test --name refuel-roi --export
# → 整段播完并记录识别状态：动作/设备框变化时截图 + shots/ + <name>.md + <name>.html，
#   HTML 里时间线和截图在同一页，浏览器打开 runs/<run>/<name>.html 即可回看。
#   --export 收下 Demo 的 JSONL，可直接接 node web/test/evaluate.mjs 做离线评估
#   长片只看某一段：--start 55 --end 80（秒，时间戳仍是素材绝对时间；给了 --end 不算截断）。
#   --start 会先暂停、seek、清空起点前的记录再开播，导出只含这一段。
#   播放上限默认按素材时长 1.5×+30s；到上限没播完会在报告顶部标注截断并以非 0 退出，
#   明确只想要前段数据时加 --allow-truncate（或 --max-seconds N 指定上限）。
#   --export 下载失败同样非 0 退出，报告写明「后续 evaluate 没有输入」。
```

> 素材编码：抽帧（`npm run inspect` / `slice-video.py`）走 OpenCV，H.264、HEVC（`hvc1`/`hev1`）、
> AV1 都能解，和浏览器无关。识别链路走 Chrome `<video>`：AV1 是软解，通常直接可播；
> HEVC 需要系统装「HEVC 视频扩展」且机器支持硬件解码，远程/无 GPU 机器上可能报
> `MEDIA_ERR_SRC_NOT_SUPPORTED` / decode error。这时先转成 H.264 再跑：
> `ffmpeg -i in.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart out.mp4`。

> Git Bash（MSYS）会把 `/eval-data/...` 这类参数改写成 `D:\git\...`；传页面同源路径时加
> `MSYS_NO_PATHCONV=1`，否则页面会报「视频加载失败：decode error」。

浏览器自检（参数见 `web/test/verify.html`）：

- `.../verify.html?mode=image&model=full` 单张图，默认用 `data/pose-test.jpg`
  （图片没有时间窗，自检会把同一帧喂 12 次让 Hold/streak 收敛，否则姿态和手臂动作恒为 false；
  计数这类需要运动的动作在单帧上本来就不适用）
- `.../verify.html?mode=video&model=full&vid=/data/pose-test-vp8.webm`
- `.../verify.html?mode=image&poses=2&img=/data/pose-test-two.jpg` 多人（仅 IMAGE 模式有效）

## 开源验证素材（没人出镜时用）

自己的实拍没有之前，用开源数据集只能回答"链路在真实画面上还成不成立"，回答不了"在你的机位上准不准"。

```bash
npm run fetch:data                        # 下到 eval-data/open/（不进 git），默认子集约 120MB（完整子集约 280MB）
npm run report:ppe                        # 只读盘点：图片/label 配齐没、每类多少框、类别名有没有
npm run eval:mot17                        # MOT17 gt 帧级评测：TopK 召回 / ID 切换 / 动作触发率
node web/test/headless-open-data.mjs "http://127.0.0.1:8799/web/"   # 跑一遍并报人数/轨迹/框数
```

等价的直接调用：`python scripts/fetch-eval-data.py`、`python -I scripts/ppe-dataset-report.py`
（Windows 上没有 `python` 命令时用 `py`）。

四份数据（MOT17 多人视频、两份 MIT 安全帽/工地 PPE、一份带 gloves 与 no_gloves 的 PPE）、
许可红线（**MOT17 非商用**）、以及"哪份能验什么"见 `docs/open-datasets.md`。

**这些数据没有动作标注**：MOT17 全是行走，PPE 是静态图。它们能验多人跟踪与 PPE 检测，
**不能产出举手/张开双臂/双手高举/手在头部/伸手/持物/指向的准确率**——
那需要自己拍并标注（见下文），或用带帧级动作标签的数据。

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
node web/test/evaluate.mjs --dir eval-data --sweep actions.reps.clap.down

# 8. 把准确率回显到 Demo（页面「动作识别」→「准确率」）
npm run accuracy                    # 读 eval-data/incoming（递归）+ pilot-panel → 写 web/accuracy.json
#    等价于：
#    node web/test/accuracy-report.mjs --dir eval-data/incoming --recursive \
#      --profile web/profiles/pilot-panel.json --out web/accuracy.json
# 9. 头部角度分档评估（没有真值时只报覆盖率/弃权；有 yawDeg 等真值时加报 MAE）
node web/test/headpose-eval.mjs --input <frames.jsonl> --labels <head.labels.json> --report head.md
```

页面只显示**这个文件里的实测值**，不自己估。手臂动作按**标注段**计样本（TP/FN/FP 都是一个段是否命中），
每个方向样本 <20 段时不报百分比（n=1 的 100% 会骗人）；手势是帧级指标。
没有报告或没有标注数据时显示「未评估」。合成样例会被标成「合成样例自检」，不会冒充实拍准确率。

`npm run accuracy` / `npm run eval` 的默认口径（2026-11-20 起）是 **`eval-data/incoming` 递归 + `pilot-panel`**：
当前包含 290 帧 58s 演示导出（`eq-check-2026-11-16.jsonl`，labels 用同一段视频的
`eq-check-2026-11-16.labels.json`）和 8 段 `incoming/neg-eq` 硬负例。`web/accuracy.json` 的
`paramsHash` 与 `pilot-panel` 一致；页面只有在选同一个 profile 时才不应提示“参数指纹过期”。
这份 labels 是 58s 演示片的标注，当前工作区从旧目录复制同名副本：

```bash
cp eval-data/refuel/refuel-operating.labels.json \
   eval-data/incoming/eq-check-2026-11-16.labels.json
```

新机位/新素材不要复制；按 `docs/data-collection.md` 重新标注并在 labels 顶层写 `camera`/`subject`。

带设备 ROI/场景阈值的素材（如 `operating`）必须把同一个 profile 传给评估器，否则回放时没有 ROI：

```bash
node web/test/accuracy-report.mjs \
  --dir eval-data/incoming --recursive \
  --profile web/profiles/pilot-panel.json \
  --out web/accuracy.json
```

跨机位时把 `camera` 写进 labels（clip 级或段级）；评估报告的 `groups.camera` 会按机位分组并给出跨组退化。
`--dir` 可重复，`--recursive` 只返回有同名 `.labels.json` 的配对；`eval-data` 里的视频/训练图不会被当成评估样本。

`autolabel` 只生成正例；反例必须人工补，否则 precision 恒为 1（见 `docs/data-collection.md` §六）。
新素材（新机位/新人员）的接入、ROI 重画、接触表复核与 `near_equipment` 标注口径见
[`docs/annotation-kit.md`](docs/annotation-kit.md)。仓库目前没有第二段设备作业视频；
只用 ROI 的 `refuel.json` 在 8 段非设备素材（MOT17 街景 + 姿态样例）的硬负例里
**6 段触发** `operating`（如 MOT17-05 57/102 帧、走路样例 10/20 帧）——它证明这条规则是
「手/肘在矩形区域 + 抬臂角」，没有物体证据，不能靠调阈值变成设备专用判据。
`refuel-equipment.json` 已改为 fail-closed（必须有设备框），同一批反例 **0 段触发**。
清单校验的退出码：0 达标 / 2 覆盖不足 / 1 清单有错，可直接进 CI。
`--max-count-err` 的单位是**每 20 次的绝对误差**（验收口径）：20 次里错 1 次记 1，多算一倍或完全漏数是 20。

报告按顺序包含：每动作 recall/precision（带 **Wilson 95% 区间和样本量 n**，手臂动作的 n 是段数，手势是帧数）、门槛、
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
- `!动作`（如「不应出现：举手」）：只否定这一个动作，站立不受影响——**单动作误报用这个**；
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
复制 `web/profiles/refuel.json` 改成本场景的值，然后：

```bash
# 页面：http://127.0.0.1:8765/web/?profile=/web/profiles/refuel.json
# 评估：node web/test/evaluate.mjs --dir eval-data --profile web/profiles/refuel.json
```

profile 只写与默认值的差异，未写的键沿用默认。导出的 JSON 会带 `profile`、`params`、
`params_hash`、`model`、`delegate`，所以任何一份数据都能查到它是在哪套阈值、哪一档模型下产生的。

profile 还可以写 `"model": "lite"` 声明阈值校准所用的姿态模型档位。当前模型与声明不一致时，
工具条上的 profile 标签会标黄；评估时如果数据的 `model` 与 profile 的 `model` 不一致，
报告头部会给出警告 —— 各档（full / heavy / lite）的关键点噪声不同，阈值不能混用。
示例：某个 profile 声明 `"model": "lite"` 而页面跑的是 `full`，工具条标签会标黄，
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
| 推理帧率上限 | **30 fps** | 10/15/30 可选。15fps 在 25/30fps 素材上会丢约一半帧（ID 切换被放大）；实测 full/GPU + 多人 3 + 手部在 30fps 上限下约 26 帧/s、每帧 28ms。弱机达不到上限会自然回落 |
| 手部补检 | 仅在漏检时 | 全身/远景下整帧检不到手，会对每只漏检的手多做一次裁图推理；两只都检出时不额外开销 |
| 模型加载 | **懒加载** | 打开页面不建模型，点「摄像头」/「上传视频/图片」才加载 |
| 后台暂停 | 开 | 标签页切到后台自动停推理（`visibilitychange`） |
| 停止按钮 | 释放模型 | 点「停止」会 `close()` 掉姿态与手部模型（手部的 VIDEO / IMAGE 两个实例都关），并停掉 rAF |

**注意**：这个 demo 里没有任何训练，全是推理。所谓"训练量大"不存在；
真正吃资源的是**同时开着多个标签页**，每个标签页都持有自己的 GPU 上下文、
一个姿态模型和两个手部实例（整帧 + 腕部补检）。
一个页面 30fps（实测 ~26 帧/s，每帧约 28ms）占的 CPU/GPU 明显高于 15fps；
开 5 个页面就是 5 倍。长时间挂机时可在工具栏把上限降到 10/15fps。

## Demo 怎么用（输入 / 播放条 / 数据面板）

**输入**

- 「摄像头」开摄像头。桌面有多个摄像头时工具条出现「切换摄像头」，按 `deviceId` 轮换；
  手机（触屏）切前后置。上次用的设备会记住，设备拔掉后自动退回默认摄像头。
- 「上传视频/图片」或**直接把文件拖到画面区域**；点画面中间的提示区也能打开文件选择。
  重复选同一个文件也会重新加载。
- **图片**是单帧判定：同一帧会在信号/动作层重复喂 12 次，让 Hold/streak 收敛后再显示
  （否则姿态和手臂动作恒为 false）。姿态、手臂动作、手势都可用；
  **计数需要运动，单张图片上不会出现**。图片模式不记录帧，导出与「判错了」不可用。
  `?src=/data/pose-test.jpg` 也可以直接打开一张图。

**文件模式的播放条**（画面底部）

- ▶ / ❚❚ 播放暂停。拖进度条时先暂停，松手后按拖动前的状态恢复。
- 「循环」勾选后播到底回绕；**回绕或向后拖动会让记录停止**（显示「记录已停止」），
  因为一次导出里 `video_time` 必须单调。点 ↺ 会清空记录并从 0 重新播放。
- 「记录中 / 记录已停止」就是当前能不能导出。上限 20000 帧（≈11 分钟 @30fps），
  超出按批丢弃，数据面板会显示丢弃了多少帧。

**数据面板 / 记录**

- profile 下拉在「默认阈值 / 加油作业 / 安全合规」之间切换。`?profile=...` 或上次的自定义 URL
  会作为「自定义」项出现。**切换 profile 会清空已记录帧**——阈值变了，旧帧不属于同一套参数。
- 「计数与记录」模块（拿取计数、重置计数、导出 JSON、「判错了」、「清空记录」）**已从界面移除**。
  记录本身不变：帧仍按上限写入内存并参与导出/回放；这些控件的 id 保留在隐藏容器
  `#legacyControls` 里，供 `scripts/*.mjs` 与 `web/test/headless-check.mjs` 按 id 驱动，
  新代码不要依赖它们，用 `window.__pose` 的 API。
- 每帧的不可靠原因（低置信 / 外推 / 骨骼异常 / 角度坏点）不再在界面单列，仍随帧记录导出；
  这是**这一帧结论的可靠性**，不是动作（含义见 `docs/signals.md` §三·九）。

**设置记忆**：模型、后端、帧率、骨架/手部/关键点、镜像、循环、profile、摄像头（设备与前后）
都存在 `localStorage` 的 `pose-demo.settings.v1` 里，刷新页面后恢复。

## 界面上的几个开关

- **骨架 / 关键点**：关键点关掉只剩连线，弱机或录制时更清爽
- **多人**：同时判 2/3/4 个人。每多一人多一次姿态推理，且走 IMAGE 模式（无模型内跟踪），
  帧率会明显下降；打开后右侧多一块「人员」列表，画面里每人一个 `#id` 标签
- **物体**：打开物体检测（PPE 的前提）。默认用 EfficientDet-Lite0（COCO 80 类）验证链路，
  所以 PPE 会全部显示 `帽? / 手套?`——COCO 里没有安全帽类别，这是正确的「unknown」，
  不是 bug。换自训模型后才会出现 `帽✓ / 缺帽`。模型默认走 CPU：GPU delegate 实测会 trap
- **镜像**：自拍习惯，关掉后左右与你本人一致（角度判定不受影响，角度是几何量）
- **信号面板已移除**：膝角/肘角/抬臂角 2D 与 3D/直立度/腿竖直比不再在界面显示，但仍逐帧记录在
  导出数据与 `__pose.lastFrame.signals` 里（看原始数用导出的 JSONL）。膝角参与「蹲下」姿态
  （蹲下用 3D 膝角 + 腿竖直比 + 髋-膝高度差；深蹲/俯卧撑计数已下线），肘角不驱动任何动作判定；
  阈值拟合仍走 `evaluate.mjs --fit`。

## 初始版验证范围

以下结论来自当前仓库的自动化测试、合成样例与样例视频；**不代表实拍准确率**。

- 几何单测 **66/66**：旧矩形规整、多边形点内测试/面积/矩形裁剪、多 zone 最大重叠、
  `resolveRegions` 优先级与 fail-closed、人框有效性、头部 9 点换算、人物有效性门
  （细长条/躯干过长/躯干水平或倒置/锚点不可见、整块身体落在手框里、缺字段 fail-open）
- 逻辑单测 **334/334**：角度/滤波/滞回/计数门控/姿态互斥（蹲下 vs 坐 vs 站立 vs 上半身直立/前倾）/置信冻结/手势分类/
  手势去抖（累计命中、unknown 跳过、无推帧间隔过期）/可见性门控/抱臂抗转身/手部映射/3D 与 2D 逐侧退回/挥手同侧/骨骼一致性/外推/自适应周期/
  上半身构图/腕部 ROI/手-臂对应/换侧滞回/角度突变剔除/不可靠原因/手型与左右侧绑定/多边形 ROI/人框有效性
- 动作提示单测 **49/49**：15 个注册动作的 tooltip 全覆盖（面板只显示当前 7 个）；手部模型关闭/未加载/未检出、无 3D、
  配置关闭 3D、置信不足各有提示；无画面时也按 profile 标出 operating 的 ROI 不可用；多动作同时亮时按可信度最低的那个讲；
  提示行与 tooltip 都能带出实测准确率或「未评估」，并标出是哪只手。
  无头页面确认 7 条动作 tooltip、提示行与准确率明细（8 行）真的渲染，且 1440×900 仍无整页滚动
- 头部朝向 **90/90** + 角度评估自测 **14/14**：2D/3D 符号、尺度/几何/眼耳一致性/roll 门控、耳对回退、
  方向滞回与去抖、缺 visibility；角度评估的分档/弃权/覆盖率/MAE/秒与毫秒标注。**全部是合成几何，没有实拍角度真值**。
- 人体朝向 **56/56**：2D 肩左右顺序 / 肩宽比 / 侧对鼻向 / 缺尺度不猜；3D 肩线 yaw 的
  front/back/left/right 与 45°/135° 边界、肩宽越界与鼻深矛盾的置信度惩罚；背身时
  `azimuth`（相机）与 `azimuth_body`（身体）的换算、油样取样「手在身体前方」、背身指向/前平举、
  旧信号退回相机口径、profile 值域校验。**合成几何 + 3D 一致率在 3 段实拍导出上抽检，没有背身动作真值**。
- 蹲下姿态 **23/23**：背对相机时 2D 膝角 ≈168°（看着接近伸直）、3D 膝角 52°，仍判蹲下；只有 2D 的深蹲；
  一条腿被挡时用单腿竖直延伸仍判蹲；站姿/单膝跪地/双腿不可见不判蹲；坐姿不被更高优先级吃掉；
  `crouch` 已进动作目录，profile 覆盖阈值与值域校验生效。
  离线回放本机导出 `transformer-crouch-seg2.jsonl`（transformer_sample.mp4 75–115s；
  `eval-data/` 不入库，meta 记录 full/CPU、推理 30fps / 记录 5fps；200 帧 / 183 person-frame）：
  判出 17 帧 `crouch`（75.7–77.9s、96.3–97.1s），
  `leg_vertical_pick` 中位 0.37、膝角中位 56°、直立度中位 0.69。
  浏览器 30fps 实播与 5fps 回放的滤波时间基不同，引用以
  `node web/test/evaluate.mjs --input eval-data/incoming/transformer-crouch-seg2.jsonl --timeline` 为准。
  **没有背身蹲姿的人工段级真值**；这条素材里背身帧只有 2 帧。坐 vs 蹲（低凳）的歧义仍存在。
- 手部关键点质量 **18/18**（自测，**不是准确率**）：刚性/平移/缩放不变性、单关节噪声与形变、
  侧别/间隔/跨来源拆分、PCK/MPJPE、退化输入、缺关节不崩。仓库里没有手部关键点真值，
  无真值时代理指标（抖动/骨长 CV/尺度 CV）的实测见 `docs/signals.md`「手部关键点质量」。
- 准确率单测 **37/37**：评估报告 flag→动作 id 映射、n/95%CI 原样保留、样本不足不报百分比但保留段数/TP/FN/FP、
  没有数据写「未评估」、合成来源标记、档位边界、报告加载的 404/格式错误/网络异常容错、
  参数指纹不一致时标记报告过期
- 评估器单测 **338/338**：反例语法、计数误报、失败区间、自动标注、混淆矩阵、分组、Wilson 区间、
  门槛、灵敏度扫描、A/B、时延与抖动、`video_time` 回绕、手势帧级指标/弃权/归属、
  分位→profile、LOSO、帧率重采样、多人逐 track 回放与 `label.track` 绑定、旧单人数据回归
- 难例/自动标注/清单单测 **46 + 21 + 27**：窗口边界、两种 label 时间基、反例导出、
  区间合并、草稿自评、清单字段与覆盖度、`heavy` 档位、动作 id/flag 等价
- 图片模式：单张真人全身照 → 33 关键点，置信度 0.935，膝角 163.1°、直立度 1.000、腿竖直比 1.33
- 视频模式：样例视频 146 帧连续推理，姿态判定「站立」，无 JS 报错，帧记录符合
  `docs/frame-schema.md`（`scale` 127.22px 与导出的 `signals.scale` 一致）
- 上半身构图：把样例视频裁到头~胸（髋以下出画）后重放，60/60 帧 `ok=true`，
  举手等手臂动作正常输出（逻辑单测 [26] 覆盖同一场景）
- 全身手部：样例视频里整帧 HandLandmarker **0/18 帧**检出手；腕点 ROI 补检后
  **18/18 帧**检出双手。真页面 30fps 限速下 2 只手/帧、fps≈28.8，UI 显示「张开 / 指方向」。
  多人时手部按「离哪个姿态腕点最近」归属到各 track（`multi.js` 的 `assignHands`），
  不再只保留目标人的手；腕部 ROI 补检按预算给面积最大的前 N 人做（主目标优先，
  `signals.hand.roi.maxPersonsPerFrame`，默认 2；`minScalePx` 以下跳过）
- 单人路径手部接线：无头页面在样例视频上确认 `verdicts` 能挂上检出的手
  （`handsByTrack` 曾在单人模式为 null，伸手/持物/指向/拿取在默认单人道恒为 false；已修）
- 已下线动作（挥手/抱臂/叉腰/前平举/侧平举）的判定与信号仍留在引擎里，用于历史数据评估与误判排查；
  界面、难例下拉与新增标注只覆盖当前动作集（见 `web/js/actions.js` 的 retired 标记）
- 稳健性：左右侧选择 0.15 可见性滞回；单帧角速度 > 1500°/s 判坏点。
  导出与界面给出 `unreliable` 原因（低置信/外推/骨骼异常/角度坏点）。
  换侧中止半程随深蹲/俯卧撑计数一起下线，`side_switched` 不再产出
- 多人：IMAGE 模式 `poses=2` 在双人图上返回 2 个框；**VIDEO 模式恒为 1 人**（模型限制，
  见 `docs/signals.md` §七）
- profile 生效：无头 Chrome 加载 `?profile=...`，把站立门控膝角抬到 200° 后姿态变 null，
  恢复后为「站立」
- 评估器：合成样例 3/3 段通过；故意标错时正确判失败；`replay` 带 `hands` 后
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
- 页面级无头回归（`headless-check.mjs`）：模型就绪、视频帧、3D 分支、36 项难例下拉、
  「判错了」导出、触发框、`azimuth_body_source` 导出字段与姿态徽标 title、1440×900 无滚动、
  零 JS 错误全部通过

## 已知限制（需要实机或实拍才能消除）

- **真实动作准确率没有数字**：举手/伸手/持物/指向/操作设备/在设备旁、拿取计数、8 种手势的识别率目前只有合成信号
  单测和评估器自测，**没有任何带逐帧标注的实拍素材跑过**（2026-11-18 的采样观察轮只记录「能输出什么」，
  不算准确率，见下一条）。这正是 `docs/eval.md` 与
  `docs/data-collection.md` 要解决的问题，也是本版最大的空白。
  页面上的「准确率」因此只显示「未评估 / 样本不足(n=…)」，跑完 `npm run accuracy` 才会变成实测值；
  当前 pilot 报告 operating/near 的 n=6/7，仍显示「样本不足」，要到 n≥20 才显示百分比；
  这是刻意设计，不是没接上。
- 摄像头实时路径没有在自动化里跑过（无头浏览器无法给摄像头）。
- 帧率数字来自无头环境，不代表真机；请在自己机器上开 DevTools 看。
- 跨机位阈值漂移幅度、不同身高体型的泛化都没有数据。
- 真机 / 非 Chrome 浏览器：页面级回归只在无头 Chrome + 1440×900 下跑过。
- 手势准确率：只有度量口径与工具（合成帧自测覆盖），8 种手势在实拍上的 recall/precision
  仍是 0 个数字；侧对帧占比也不知道。
- **多人只在双人样例视频上验证过"能出 2 条轨迹"**：速度（每多一人多一次推理）、3 人以上、
  交叉遮挡下的 id 稳定性都没有量化；多人时手部 ROI 补检按预算给前 N 人做（默认 2 人）。
- **PPE 冒烟模型已训好，但精度不够考核**：623 train / 252 val、9 类、YOLOv8n@320 训 10 epoch，
  val mAP50 0.40（helmet 0.76、person 0.67、vest 0.72、no_helmet 0.53；glove/no_boots 接近 0）。
  训练→导出 ONNX→浏览器 ORT→PPE 判定这条链路已跑通（`npm run check:ppe`），但数据量、机位差异、
  小目标都还没解决，**没有任何实拍准确率**。判定逻辑（看不见≠没戴、连续 3s、手套只报疑似）有单测，
  但"准不准"仍未知。见 `docs/ppe-training.md`。
- **设备检测器只是同集冒烟**：panel/valve/gauge 用 refuel 同一段 58s 演示片的分镜框 +
  RF100 gauge 训练，val mAP50 0.692（panel 0.995 / gauge 0.39 / **valve 没有 val 实例**），
  gauge 在 320/0.35 下基本检不到。同一份导出上它能把 `operating` 的 1 个特写 FP 压掉、
  8 段硬负例 8/8 不触发，但换机位/换人完全没有验证；模型不进 git（`web/models/`），
  训练与接入见 `docs/equipment-detector.md`。2026-11-17 另用 `eval-data/airport-refuel/`
  的下载素材做了跨分镜重训：panel 的 val mAP50 0.99、浏览器端能稳定出框；
  valve/gauge 的 val 指标被「分镜框套整段运动镜头」拖低（仪表 12s 内漂移 40–140px），
  定性推理仍能检出。见 `docs/equipment-detector.md` §10。
- **2026-11-18 加油采样观察轮**：`scripts/refuel-sampling-suite.mjs` 把 8 段既有素材在无头 Chrome 里
  实播一遍（素材窗口见 `eval-data/airport-refuel/INDEX.md`）。`operating` + 设备框在演示片、B787 面板、
  A320 取样箱、液压阀上都有输出；但 `oil_sample` 在 B787 举罐 / 军航举瓶上 **0 命中**，
  `drain_sample` 在变压器深蹲取样上 **0 命中**（83% 采样腿不可见，有膝角读数的 94 次里 75 次 <60°，
  被规则的下限有意排除）。另记录 2 次瞬时误报（面板前抬手触发 `oil_sample` 1 次；仪器特写被凑成人后
  触发「举手/双手高举」1 次）。截图与逐次采样在 `runs/refuel-sampling-suite-2026-11-18/`（不进 git）。
  2026-11-19 补：误检骨架加了**只作用于绘制**的倒置门（`personGate.drawMinTorsoDrop=0`），
  设备/手部特写不再画倒置骨架；动作判定不受影响（逐帧剔除会打断 Hold）。前后对比见
  `runs/refuel-sampling-suite-2026-11-18-gated/`。
- **头部朝向默认是 2D 投影近似**：`yaw/pitch` 不是标定过的解剖角（导出标
  `yaw_approx`/`pitch_approx`），侧脸接近 90° 时符号和幅度都不可靠。已加可信度门控
  （眼对/耳对 <10px、鼻-眼几何异常、眼耳 yaw 不一致、`|roll|>75°` 时角度置 `null`）：
  实拍 6 段素材、1143 个 person-frame 里约一半帧三轴为 `null`——远处小脸、背身、帽檐帧
  本来就不该给伪角度。门控不能证明脸朝向相机；头点来自人物检测，设备/工件被误检成人时
  也会给头朝向，需结合 `reliable`/`reasons`/`confidence` 判断。Pose 的 world 面部点
  实测噪声很大，3D 只在 profile 显式 `use3d` 时启用。
- **背对相机**：人体朝向由肩线/躯干判（`signals.body`），不靠脸；背身时头部角度被门控
  置 `null` 是刻意弃权。背身的前伸/指向/油样取样改用 `azimuth_body`（身体坐标），但背身时
  手常被身体挡住，手部模型与腕点可用性仍是主要瓶颈。2D 退回的朝向只有粗档
  （0/±90/180），幅值不要当精确角度；3D 肩线在遮挡/低清晰度特写下也会抖，看 `confidence`
  与 `reasons`。没有专门的背身动作素材做真值评估。

- 物体检测的 GPU delegate 对该模型会 trap（wasm divide by zero，且会污染整个运行时），
  默认走 CPU；换自训模型后需要自己验证能否上 GPU。
- 多人**姿态/手势**已能按 track 评估（`evaluate.mjs` 的逐 track 回放与 labels 的 `track` 字段）；
  多人 **PPE 事件**的 recall/precision 还没接进主报告（先用独立的 PPE 评估工具）。
- 单人道有**漏检补救**（`perception.single.fallback`，默认开）：VIDEO 模式整帧 0 人时用
  IMAGE 模式 0.3 再检一次。refuel 样例（大量半身/特写）无判定帧 772 → 546，但特写段会多
  少量把「手/设备」当上半身的误检。它只提高检出率，不改变动作判定；数字见
  `docs/multi-and-objects.md` §五。
- Python 服务端引擎、YAML 规则、RTSP 多路不在本版内，见 `PLAN.md`。

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
| onnxruntime-web（PPE ONNX 后端） | MIT |
| Ultralytics YOLOv8n（**仅用于训练冒烟 PPE 模型**，权重与代码） | **AGPL-3.0** |
| `data/` 下的测试图片与视频 | 由 COCO 数据集样本（经 Ultralytics assets 仓库）裁剪而来，仅用于本地功能验证，不随产品分发 |

另外提醒：Ultralytics 自家的 YOLO 系列是 AGPL-3.0。本项目**只在 PPE 冒烟训练/导出时使用**
（`docs/ppe-training.md`），运行时产物 `ppe_smoke.onnx` 只是验证链路；闭源商用前必须处理许可
（购买 Ultralytics Enterprise，或换 Apache/BSD 许可的检测器重训）。
