# 信号层定义 · signals v0.1

**这份文档是唯一真相**。当前实现是浏览器端 `web/js/signals.js`；本版**没有**服务端引擎
（Python 引擎见 `PLAN.md` 的路线）。将来实现服务端时，算法必须与这里一致，否则同一个动作
在 Demo 和引擎里会给出不同的起止时间。

> **v0.1（初始版）**：包含 3D（`worldLandmarks`）信号、骨骼长度一致性、角速度、
> 短时遮挡外推、自适应周期，以及「何时用 3D、何时退回 2D」的规则（§一·五）。
> 帧契约是 `v0`（只加可选字段，见 `docs/frame-schema.md`）。

信号 = **时间序列**，不是单帧布尔。所有判定都必须能看到「过去 N 毫秒发生了什么」。

## 一、基础量

| 信号 | 定义 | 取值范围 | 用途 |
|---|---|---|---|
| `angle(a,b,c)` | 三点夹角，b 为顶点；任一点缺失或边长≈0 时返回 NaN | 0~180° | 膝角、肘角、髋角 |
| `angle_3d(a,b,c)` | 同上，但用 `worldLandmarks` 的米制 3D 坐标 | 0~180° | 有 world 时的首选 |
| `scale` | 肩中点↔髋中点的欧氏距离；髋不可信时用肩宽×1.4 代替（§三·八） | 像素 | **2D 距离的除数**（保持不变，历史数据的量纲） |
| `scale_world` | 肩中点↔髋中点的世界距离 | 米 | **3D 距离的除数**，与分辨率、投影无关 |
| `ratio(a,b)` | 两点距离 / `scale` | 无量纲 | 手-物距离、伸展程度 |
| `uprightness` | 躯干向量（髋中点→肩中点）与画面「上」方向的夹角余弦；髋不可见时退回鼻尖→肩中点（§三·八） | -1~1 | 站立≈1，躺平≈0，倒立≈-1 |
| `uprightness_3d` | 躯干单位向量与重力轴（world −y）的点积 | -1~1 | 相机倾斜时仍可用 |
| `leg_vertical` | (踝中点 y − 髋中点 y) / `scale` | 无量纲 | 站立≈1.3~1.8，躺平≈0 |
| `leg_vertical_3d` | (踝−髋) 在重力轴上的投影 / `scale_world` | 无量纲 | 站立≈1.8~2.0，**量纲与 2D 不同** |
| `knee_vel` / `elbow_vel` | 选中侧角速度（一阶差分） | 度/秒 | 区分「快速往返」与「抖动」 |
| `extrapolated` | 本帧按最后速度外推的关键点名单 | 名称数组 | 外推期间冻结计数 |

**诊断字段**（随信号对象一起给出，不参与阈值）：

| 字段 | 含义 |
|---|---|
| `uprightness_source` | 直立度用的轴：`torso`（躯干） / `head`（上半身构图，鼻→肩） / `none` |
| `vis` | `{shoulder, hip, knee, ankle, nose}` 分组可见性；界面据此提示「下半身不可见」 |
| `angle_outliers` | 本帧因角速度过大被剔除的**关节/姿态**角度名（动作层转成 `unreliable: angle_outlier`）。头部 `head:*` 不进这个清单（没有动作依赖它），只记在 `signals.head.reasons` |

为什么全部用角度和比值：**角度天然与尺度、距离、分辨率无关**，这是跨机位、跨人体尺寸唯一能复用的量。
像素阈值换一个摄像头就失效，别用。

> `scale` 保持像素是**有意的向后兼容**：已有导出与阈值都按像素比拟合。
> 3D 侧使用独立的 `scale_world`（米），两者不混用。

## 一·五、3D 信号与退回规则

`worldLandmarks` 是 MediaPipe 给的**米制 3D 坐标**：33 点、原点在髋中心、
**y 向下为正**（实测鼻 y≈−0.62、踝 y≈+0.63）。

### 取值顺序（每条信号独立判断）

1. **有 `kp_world` 且本帧该链条的世界点有限** → 用 3D；
2. **没有 world，或本帧世界点无效/可见性不足** → 退回同一信号的 2D 实现；
3. **world 存在但骨骼长度一致性判该肢不可靠** → **NaN，不退回 2D**。
   2D 用的是同一批坏点，退回只会把错误藏起来。

2D 与 3D 分别有自己的 One Euro 滤波器，不共用历史：混用会让「3D 偶尔丢一帧」
变成信号台阶。3D 侧**不保持旧值**（本帧没有有效世界点就不给数），避免陈旧值冒充当前。

举手的 3D 判定同样按这条规则**逐侧**回退：`raised_sel_L/R` 在本帧该侧 3D 有效时直接采用
3D（`elev_torso`），3D 无效（无 world、该侧世界点缺失、骨骼判不可靠）时才退回 2D。
只在 `has_world` 为真时整体改用 3D，会在「world 在、某侧世界点坏掉」时把举手整个丢掉。

### 每个信号族的开关（`params.signals.world`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；false 时全部退回 2D |
| `angles` | `true` | 膝角/肘角/髋角用 3D 夹角 |
| `uprightness` | `true` | 躯干与重力轴点积 |
| `legVertical` | **`false`** | 3D 腿竖直比。**量纲不同**（站立 3D≈1.9 vs 2D≈1.3），现有 `leg_vertical` 阈值直接切换会误判，需用实拍数据重拟合后再开 |
| `ratios` | **`false`** | `reach` / `hands_close` / 手-头距离 / 手腕-髋距离改用世界距离 / `scale_world`。同样需要重拟合 |
| `boneCheck` | `{enabled:true, windowFrames:60, minSamples:10, tolerance:0.2}` | 见下 |

为什么脚/比值默认仍是 2D：**3D 更好不等于现有阈值在 3D 下仍然成立**。
`leg_vertical` 与距离比值的量纲会整体偏移，切换必须同时换阈值（用 `--fit` 重拟合）。
在此之前，3D 版本以 `*_3d` 字段并行导出，用 `web/test/signal-compare.mjs` 量化后再决定。

### 骨骼长度一致性

每条肢体（上臂/前臂/大腿/小腿）维护最近 `windowFrames` 帧的**世界长度中位数**；
攒够 `minSamples` 帧后（armed），当前帧长度偏离中位数超过 `tolerance`（20%）→ 该肢不可靠。

- 不可靠的肢体：依赖它的 3D 角、手臂信号、腿竖直比给 NaN；
- 未攒够样本（冷启动）**不否定任何信号**，否则前 10 帧什么都判不出来；
- 比 `visibility` 更能抓住「手在背后、腕点漂到别处」——这类点可见性经常仍是 1。

### 角速度

对**选中的**角度信号做一阶差分：`v = (angle_t − angle_{t−1}) / Δt`，单位度/秒。
Δt 超出 `[minDtMs, maxDtMs]` 给 NaN；速度再做一次 One Euro（`minCutoff=3`）。
当前只导出、不单独参与判定——它的用途是判断「这个动作是否快到 `Hold`/滞回跟不上」。

### 短时遮挡外推

某点可见性 < `visMin` 时：

- 距最后一次好帧 ≤ `occlusion.maxExtrapMs`（300 ms）：按最后速度**常速度外推**，
  该点进入 `extrapolated`；
- 超过：退回「保持上一次滤波值」，不再外推。

动作层在 `extrapolated` 命中时**冻结相关计数**（不推进、不 abort），见 §六。

## 二、原语

| 原语 | 语义 | 参数 | 实现要求 |
|---|---|---|---|
| `state`（`Hold`） | 信号越阈并**保持**一段时间才算成立 | `minMs` | 单帧命中一律不算 |
| `rep`（`RepCounter`） | 滞回周期计数 | `down`, `up`, `minHalfMs`, `adaptiveMs`, `adaptiveMinRatio` | 下阈/上阈不共用一条线；有历史后按半程中位数判周期（见下） |
| `sequence`（`PhaseSequence`） | 有序阶段组合 | `phases`, `minPhaseMs`, `maxPhaseMs`, `completeAt` | 见 §二「sequence」；不是简单的 `max_gap` |

> **本版没有实现** `in_roi` / `near` / `absence` / `cooldown` 四个原语。
> Demo 目前用不到它们；实现 Python 引擎或扩展动作时再补，不要假设它们在 `signals.js` 里存在。

> **Hold 的断档口径**：`maxGapMs` 表示「允许条件暂时不成立多久」，只给持续事件用
> （`operating` / `oilSample` / `drainSample`）。其余动作的 Hold 用
> `actions.holds.maxCallGap`（默认 500ms）检查**两次真值更新之间**的断档：遮挡期间
> tracker 仍保留 track，但该 track 连续几帧没有判定时，中间没有 `cond=false` 的帧；
> 不检查调用间隔，未满的 Hold 会在 900ms 遮挡后回来时直接成立（`reach→fist` 可凭空 +1 拿取）。
> `cond=false` 仍立即重置，不受 `maxCallGap` 放宽。

### `sequence`：有序阶段（拿取的地基）

`Hold` 只知道「持续了多久」，不知道「先后顺序」；`RepCounter` 只知道「上下穿越」，不知道中间要多一步合手。
「拿取东西」恰恰是**有序多阶段**：伸手 → 合手 → （可选）抬起。

`PhaseSequence(phases, {minPhaseMs, maxPhaseMs, completeAt, releaseMs})`：

- 只有观察到**当前阶段**，才允许前进到下一阶段（`started` 标志）——
  没有这道判断，「手本来就是握着的」会直接凑满阶段
- 每阶段最短持续 `minPhaseMs`，滤单帧抖动
- 每阶段最长 `maxPhaseMs`，超时回到第一阶段 —— 否则「伸了手但一直没合手」会永久卡在中间
- 走到 `completeAt` 计一次，然后**闭锁**：必须重新观察到第一阶段才允许下一次计数，
  否则握着手不动会逐帧累加
- `releaseMs`：闭锁解除前，第一阶段要**连续**观察到这么久（默认 0 = 单帧即可，保持旧行为）。
  拿取用它防「松开一瞬又合上」多计一次（`signals.grasp.releaseMs=200`）。

**为什么不用两个 Hold 串联**：Hold 之间没有先后关系，也没有「完成一次后闭锁」的概念，
拼出来的计数一定会在持续动作上连发。

### 拿取（`grasp`）= reach → grasp

| 阶段 | 判据 |
|---|---|
| `reach` | 手臂伸出（`reach > extend.minReach` 且 `elev > extend.minElev`）**且手张开** |
| `grasp` | 手臂仍伸出 **且手闭合**（`fist` / `ok`） |
| 超时 | 伸手后 `reachToGraspMs` 内没合手 → 复位，本次不计 |

**手部数据缺失时拿取一律不成立。** 不能把「手没被检出」当成「手是空的」——
那会把整段没有手部模型的数据都判成「伸着空手」。

## 三·六、手臂扩展信号

| 信号 | 定义 | 用途 |
|---|---|---|
| `extend_L/R` | `reach > 1.25` 且 `elev > 30°` | 伸手、指向、拿取的基础判据 |
| `azimuth_L/R` | 3D：肩→腕在水平面的方位角，0°=正前（朝镜头），±90°=正侧 | 诊断；旧口径 |
| `azimuth_body_L/R` | 同上减去 `body.yaw`：0°=**身体**正前，±180°=身体正后；无可信人体朝向时为 `NaN` | 背身/侧身时的「手在身体前方」（取样、前伸、指向） |
| `arm_front_L/R` | 抬臂角 ∈ (60°,120°) 且 \|相机方位角\| < 35° 且腕接近肩高且手臂基本伸直 | 前平举（相机口径） |
| `arm_front_body_L/R` | 与上同判据，方位角换成 `azimuth_body`；无人体朝向时逐位等于相机版本 | 前平举/指向（身体口径） |
| `arm_side_L/R` | 抬臂角 ∈ (60°,120°) 且 \|方位角\| > 55° 且腕接近肩高且手臂基本伸直 | 侧平举（左右对称，不需要身体口径） |

**方位角必须配「手臂接近水平」**：自然下垂时水平分量≈0，`atan2` 出来的是纯噪声。
实测（`data/pose-test-vp8.webm` 走路视频）没这道门控时 `armFront` 一直是 `true`。
除此之外还有两道物理门和一个保持窗（实测走路样例 41/60 帧 → 0/63 帧）：

- **2D 腕点接近肩高**（`wristY < shoulderY + 0.4·scale`）：自然下垂时腕在髋旁，必然被挡。
- **手臂基本伸直**：3D 腕-肩距离 / 躯干长 > `azimuth.minReach`(0.85)。弯臂横在胸前只有 0.5~0.8，
  3D 方位角也会像平举，但伸直度能分开。有 world 时用 3D（前伸在 2D 会透视缩短）。
- **300ms 保持窗**（`actions.holds.front` / `side`）：走路摆臂的瞬时命中只持续约 250ms。

### 操作设备（`operating`）

「人正在操作阀门/仪表」不是瞬时手势，是一个**持续事件**。判据是姿态 + 设备区域
（人工 ROI，或检测器给出的 panel/valve/gauge 框）：

| 条件 | 阈值 | 说明 |
|---|---|---|
| 设备 ROI | profile `signals.arm.operating.roi = {x,y,w,h}`（旧矩形）或 `rois = [{id, points:[[x,y],...]}]`（多边形/多区域，归一化 0~1） | **未配置 ROI/检测框时不判**：只剩「伸手」，会拿东西/扶栏杆误报。矩形与多边形同为归一化 0~1，越界（如把 0.56 写成 56）或超出画面都判非法，不静默放大。`rois` 非空时完全忽略旧 `roi`；非空但全部 zone 非法 → fail-closed（不退回矩形） |
| 设备检测框 | profile `operating.equipmentLabels` + 物体检测 | 有框时**优先**：腕/肘到框边 ≤ `equipmentMaxDist·scale`；ROI 只作检测不到时的兜底。默认 0.35，refuel 档实测 0.35/0.5 太紧（正例 1/6），调成 0.7 |
| 腕在设备区域 | 有检测框：到框边 ≤ `equipmentMaxDist·scale`；无框：像素坐标落在 ROI 内 | 设备区域来自检测框或人工 ROI |
| 腕-肩距离 | > 0.65 躯干长 | 手臂不是自然垂在身侧 |
| 抬臂角 | 90°~179° | 0°=手在肩上方，90°=水平，180°=正下方；手不能举到肩上 |
| 两肩可见 | min(肩 L/R 可见性) ≥ 0.4 | 挡住「只检出一只手臂」的误检 |
| 肘兜底 | 肘在设备区域（检测框/ROI）内、可见性 ≥0.3、肘-肩 >0.35、抬臂角 60°~179° | 手被设备挡住、腕不可用时 |
| 保持 | ≥ 800ms（`actions.holds.operating`） | 单帧伸手不算「在做」；profile 可覆盖 |
| 掉帧容忍 | 默认 ≤ 300ms（`actions.holds.operatingMaxGap`）；refuel 档 600ms | 手腕被面板挡住几帧不重置计时；两次成立帧之间超过 maxGap（人短暂丢失、引擎漏调用）同样重置，不会把漏掉的间隔算成连续。maxGap 要按实际采样间隔校准：refuel CPU 回放中位 138ms / p90 365ms，300ms 会把长正例段切碎 |

> 示例 profile `web/profiles/refuel.json` 覆盖为：`minElbowVis 0.21`、`minElbowReach 0.315`、
> `holds.operating 1500ms`、`operatingMaxGap 600ms`。这是在 58s 演示片的 6 正/7 反复核标注上
> **同集调参**的结果；Hold 修正为「真值帧间隔超过 maxGap 也重置」后重新校准了 maxGap。
> 当前代码+参数在 563 帧复核导出上：operating TP5/FN1/FP3（段级 R 0.833 / P 0.625）。
> 2026-11-20 起 `npm run accuracy` 用 `pilot-panel`（panel-only）+ 290 帧 5fps 导出 +
> 8 段硬负例：operating 3/3/3（R .5 / P .5），near 4/2/3；n<20，页面只显示「样本不足」。
> 两组数字来自不同导出/fps，不可混用。
> 样本很少、没有留出集，换机位必须重标重校；不要把它当全局默认。

设备检测器已经接进判据（`docs/equipment-detector.md`），但仓库**不附带**训练好的权重：
`web/profiles/refuel-equipment.json` 是接入示例（panel/valve/gauge，ONNX 320），
`web/profiles/refuel.json` 仍只用 ROI。有 `equipmentLabels` 的检测框时，信号层用
「点到框边的距离」而不是「点在 ROI 内」，导出 `operating_equipment=true`。
`operating.equipmentFallbackRoi=false` 是 fail-closed：没有框就一律不判（硬负例/无 ROI 场景用）；
**2026-11-16 起 `refuel-equipment.json` 与 `refuel-equipment-strict.json` 默认开**——
只靠 ROI 的 `operating` 在 8 段硬负例里 6/8 段整段误报，见 `docs/equipment-detector.md` §6。
`nearEquipment` 的 `nearEquipment.equipmentFallbackRoi` 默认是 `null`（跟随 `operating`）；
profile 里显式设 `true` 可以让它在 `operating` fail-closed 时仍走 ROI 兜底，否则上下文事件会整段消失。

refuel 冒烟实测（同一份 590 帧导出，`operatingMaxGap=600`）：ROI-only `operating` 3/3/3，
ROI + 检测框 **3/3/2**（检测框把 9.2–12.9s 特写误报压掉，召回不变）；无 ROI 的 detector-only 也是 3/3/2。
模型是用同一段视频的分镜框训练的，**同集，不是泛化准确率**；valve 在 val 集里没有实例，
gauge 在 320/0.35 下基本检不到。换机位必须重标重训并重扫 `equipmentMaxDist`。

**设备框的时序确认与额外门（2026-11-12 加）**。检测器给的是逐帧独立的框，单帧误检直接
变成「设备证据」是误报的主要来源。`web/js/equipment.js` 先把框做成有记忆的证据，再进判定：

| 选项 | 默认 | 作用 |
|---|---|---|
| `boxMinHits` | 2 | 同一位置要在**两次不同的检测**里都命中才算确认。`objects_ts` 相同的重复帧不重复计数（app 在两次检测之间沿用上一帧结果）。1 = 关闭时序确认 |
| `boxMaxAgeMs` | 600 | 确认过的框消失超过这么久才作废。**过期过滤在匹配之前**：间隔超过 maxAgeMs 的旧轨迹不会因为这一次检测匹配上就续命到 hits=2（漏检/多人缺席期间 `update()` 不会被调用，旧实现里这正是 minHits 失效的路径）|
| `boxRequireInRoi` | false | 框必须与本工位 ROI **相交**才算设备证据（挡背景里别人的阀门）。用相交而不是中心在内：refuel 159 个框里 105 个中心在 ROI 外、但多数与 ROI 有重叠 |
| `useForearm` | false | 用「腕→肘线段到框的距离」代替「腕点到框」，手被面板挡住时更稳 |
| `requireGrip` | false | 手型必须属于 `signals.hand.closedShapes`（fist/ok）；没有手部数据 = 不成立 |
| `requireUprightBox` | false | 人体框必须「高于宽」（`signals.upperBody.minAspect`），挡「手/油枪特写被凑成躯干」 |
| `requireValidity` | false | 复用 `nearEquipment.validity` 的面积/高度/出画/可见性门。打开时**自动启用**这道门：不必（也不该指望）同时写 `nearEquipment.validity.enabled: true`，否则 `personBoxValidity()` 会直接返回 `ok:true`，门静默失效 |
| `elbowFallback` | true | 肘兜底总开关 |
| `elbowFallbackHideWrist` | false | 只有腕点不可用（真被挡住）时才允许肘兜底 |

时序确认只对**新导出**生效：判定需要 `objects_ts`（该批框是哪次检测产生的）。旧导出没有这个
字段、单张图片路径也传 `null`，此时**不过滤**，逐位保持引入本模块前的行为。

判定失败时导出 `operating_gate`（汇总）与 `operating_gate_L/R`（逐侧），取值：
`ok` / `no_equipment` / `no_arm` / `no_elbow` / `low_shoulder` / `head_near` / `person_invalid` /
`person_not_upright` / `reach_low` / `elev_low` / `elev_high` / `not_near` / `no_grip`。
汇总取四条分支里**走得最远**的那一关（`not_near` 比 `elev_low` 更具体），所以逐侧原因要看 `_L/_R`。
另有 `operating_boxes_raw/confirmed/used` 三段计数与 `operating_upright_box`，离线一眼能看出
FN 是「没人/没设备」还是「手没够到」。

同一份 290 帧确定性导出（5fps，`scripts/deterministic-replay.mjs`）上的 A/B
（基准 `refuel-equipment.json`：operating 4TP/2FN/3FP）：

| 变体 | operating TP/FN/FP | 结论 |
|---|---|---|
| `boxMinHits=1`（旧行为） | 4/2/3 | 时序确认在本片不改段级结果；帧级过滤掉 5/153 个单帧误检框 |
| `boxRequireInRoi=true` | 4/2/3 | 本片所有框都与 ROI 相交，零成本护栏 |
| `useForearm=true` | 4/2/3 | 本片没有「腕在外、前臂在框内」的帧 |
| `requireGrip=true` | 4/2/3 | 肘兜底绕过了握持门；只在腕成立的分支上加门，指标不变 |
| `requireUprightBox=true` | **2/4/0** | FP 清零，但也会挡掉 2 个真作业段（上身构图/仪表特写） |
| `elbowFallback=false` | **1/5/0** | 肘兜底承担了大部分召回，不能关 |
| `elbowFallbackHideWrist=true` | 4/2/3 | 肘-only 的帧本来腕就不可用，等价于旧行为 |

> 结论：时序确认、ROI 约束、前臂/握持门是**零成本或低成本护栏**；人形门是明确的
> 精度/召回折中（见 `web/profiles/refuel-equipment-strict.json`），默认档不要换。
> 手部模型在这段素材上只有 48/290 帧检出、8 次闭合手型检出（同一帧左右手各算一次，
> 不是 8 帧；`operating` 帧里仅 1 帧带闭合手型），**requireGrip 目前不可用**。

**参数一致性**：`boxMaxAgeMs` 与检测间隔由 `validateParams()`（`web/js/params.js`）校验。
配了 `equipmentLabels` 且 `boxMinHits>1` 时要求 `boxMaxAgeMs >= perception.objects.intervalMs + 300`
（300ms 是推理耗时余量），否则页面加载 profile、评估器 `--profile`、确定性回放都会直接报错。
不满足时两次检测之间的普通帧会先把轨迹过期，框永远累计不到 `boxMinHits`
（审查实测 `intervalMs=1000`：确认态从 328/366 掉到 4/30）。

**多边形/多区域 ROI**（`operating.rois`）：每个 zone 是归一化点集 `[[x,y],...]`，至少 3 点、
简单（非自交）、0~1；`id` 可选。`rois` 非空时优先于旧 `roi`，多区域按「任一包含」判 operating，
`near_equipment` 按「人体框与区域的最大重叠比例」判（不做面积求和）。缺 `frame_w/frame_h`
时无法换算像素，多边形视为不可用（fail-closed）。诊断字段：`operating_roi_zone`（命中的 zone id）、
`near_equipment_zone`、`near_equipment_source`（`equipment|rect|polygon`）、
`armPose.operating_roi_mode/zones`。示例见 `web/profiles/refuel-polygon.json`（与 refuel 矩形等价）。

离线评估（`evaluate.mjs`）回放这条判据时，导出的人必须带 `frame_w/frame_h`（已导出）；
缺这两个字段时 ROI 无法换算像素，`operating` 会弃权为 false。

### 在设备旁（`near_equipment`，上下文）

它**不是**「在操作」：只回答「人站在设备区域里」，用来补 `operating` 在「手被设备挡住」时的上下文。
不要把它并进 `operating`（曾经的 body-overlap 兜底在 refuel 上 233/249 条判定都成立，太宽）。

| 条件 | 默认 | 说明 |
|---|---|---|
| 区域 | `operating.roi` / `operating.rois` 和/或 `operating.equipmentLabels` 的检测框 | 两者都没有时不判；多边形按「人体框 ∩ 多边形 / 人体框面积」精确计算，多 zone 取最大 |
| 重叠 | 人体框面积 ≥ `nearEquipment.minOverlap`(0.3) 落在区域里 | refuel 档用 0.5 |
| 有检测框时 | 取「与检测框重叠」和「与 ROI 重叠」的**较大值**（union） | 检测框只框设备本体，人站在面板前与框的重叠很小；只认框会把 refuel 从 3/6 压到 1/6 |
| fail-closed | `nearEquipment.equipmentFallbackRoi`：默认 `null` 跟随 `operating`；显式 `true` 时不受 `operating` 的 fail-closed 影响，显式 `false` 时只认检测框 | 没有框且开关为 false → 不判，ROI 完全不参与 |
| 两肩可见 | ≥ `nearEquipment.minShoulderVis`(0.4) | 挡掉只检出手臂/设备的特写 |
| 人体框竖直 | `requireUprightBox=true` 时 h ≥ 0.9·w | 挡横向特写；关掉会提高召回、也增加特写误报 |
| 人框有效性（可选） | `nearEquipment.validity.enabled=true` 时：面积/高度比例、出画比例、肩/躯干可见度 | 默认**关闭**，逐位保持旧行为；挡过小/满屏/大半出画的特写。`person.bbox` 由全部 33 点取极值，`minInFrame` 默认只取 0.5 |
| 保持 | ≥ `actions.holds.nearEquipment`(1000ms) | 上下文事件，不是单帧 |

refuel 演示片（refuel 档）：自身 TP3/FN3/FP2（段级 R 0.5 / P 0.6），补上 `operating` 唯一漏掉的
20.4–23.9s；两个动作并集覆盖 6/6 正例段。剩下的 FP 是 9.2–12.7s / 24.1–24.3s 的特写误检。
接上检测框后（`refuel-equipment` 档）`near_equipment` 仍是 3/3/2——union 是特意保留的：
只认检测框会掉到 1/5，而 `operating` 一侧已经由检测框压掉了一个 FP。

`nearEquipment.validity` 是人框有效性门（默认关）：`minAreaRatio / maxAreaRatio / minHeightRatio /
maxHeightRatio / minInFrame / minShoulderVis / minTorsoVis`。关闭时信号逐位不变；开启后
`sig.arm.near_equipment_validity` 给出 `{enabled, ok, area_ratio, height_ratio, in_frame,
shoulder_vis, torso_vis, reasons}`，`near_equipment` 额外要求 `ok`。示例见
`web/profiles/refuel-strict.json`（只用于同输入 A/B，不是新默认）。

2026-11-11 同一份 563 帧 refuel 导出上的 A/B：`refuel-polygon.json`（单区多边形＝旧矩形）
与 `refuel.json` 的 operating/near_equipment TP/FN/FP **完全一致**（operating 5/1/3，
near_equipment 3/3/2），证明多边形接线没有改变旧语义；`refuel-strict.json` 也一致——
这段素材里的人框都通过了有效性门，所以门没有触发。它主要作为硬负例/特写护栏，
需要更多特写素材才能量化收益。

### 油样取样（`oil_sample`，2026-11-13 加）

机场加油特有动作：**手持取样瓶/取样管举到眼前对光看水/杂质**。判据分两层：

| 层 | 条件 | 参数 |
|---|---|---|
| 信号（瞬时） | 腕到鼻尖 < `maxHeadDist` 躯干长、腕不明显低于肩、**手在身体前方**（`azimuth_body` 的 \|az\| ≤ `maxAzimuth`；无人体朝向时退回相机方位角） | `signals.arm.sampling.{maxHeadDist,maxAzimuth}`，默认 0.55 / 60° |
| 动作（保持窗） | 上面这条持续 1000ms | `actions.holds.oilSample`，默认 1000 |

和 `hand_head` 的关系：共用「腕靠近鼻尖」的距离判据，区别只有两点——多一道「手在身体前方」
（摸头/扶眼镜是从侧后方靠近，方位角大；看样瓶是对着光，手在面前），以及更长的保持窗
（350ms → 1000ms，避免抬手擦汗/扶眼镜命中）。「身前」用 `azimuth_body`（见 §三·八·七）：
背对相机时身体前方是相机 ±180°，侧对时是 ±90°，只看相机方位角会把这些姿势判成「手在身后」。
**没有 3D / 没有可信人体朝向时方位角是 NaN，退化成纯距离判据**，此时它和 `hand_head` 只差保持窗。

**实测（2026-11-13，`eval-data/airport-refuel/` 的 4 段公开取样素材，共 150s）：召回 0/4。**
不是判据写错，是姿态层在这些画面上看不到动作：

| 片段 | 正例窗内「有人且腕-鼻距可算」的帧 | 结果 |
|---|---|---|
| a320 | 2 / 220 帧 | 0 TP |
| light | 5 / 420 帧 | 0 TP |
| b787 | 3 / 130 帧 | 0 TP，另在 21s 处 1 FP（人站在面板前抬手扶耳机） |
| mil | 0 / 30 帧 | 0 TP |

原因是机位：这几段都是**近景/手持**，取样时人脸低下去凑近样瓶，**手被样瓶整个挡住**，
姿态模型给不出可用的腕点——一帧里连腕-鼻距都算不出来，1s 保持窗自然攒不够。
反过来，唯一命中过的时刻（b787 21s）恰好是「手抬到脸边」，说明判据本身是灵敏的，
缺的是**能看见手**的机位。

更根本的一条：**这条判据的核心假设（手举到脸前）和真实取样姿势不一致**。看 b787 的取样帧，
人是把**样瓶**举到脸前，手还在胸腹高度——腕-鼻距本来就不小。四段素材上分别统计
`reach` / `elev` / `hands_close`，正例窗和反例窗的中位数互相矛盾（同一段正例里 `elev`
中位 179°，即手臂朝下，说明模型对看不见的手臂在乱猜），**没有哪组姿态特征能稳定分开两者**。
所以别指望在这些画面上重调阈值就能出召回：要么按第二节的要求拍（全身、固定机位），
要么走物体检测（给取样瓶训练检测框）。

限制：

- 只有姿态骨架，没有物体检测：空手举到眼前也会命中；样瓶本身检不出。
  真要提精度，方向是给「取样瓶」训练一个检测框（复用 `operating` 的设备框那套），
  用「腕到瓶框的距离」替代「腕到鼻尖的距离」——那样手被挡住也能判。
- 单手举瓶、双手捧瓶都能判（任一侧成立即可，逐侧给 `oilSampleL/R`）；
  手在身体侧后方看样瓶（有人习惯斜着举）会漏判。
- 3D 可用时方位角门能挡掉一部分摸头误报；近景素材的 world 时有时无，实际经常走 2D 退化路径。
- 阈值必须用**甲方机位**素材校准：本节的 0.55 / 60° / 1000ms 只是先验值，没有在这 4 段上调过。

### 放油取样（`drain_sample`，2026-11-18 加）

变压器/设备放油取样：**半蹲在放油阀旁，双手在阀口与接油盆之间**（单膝跪地时支撑腿
通常落在半蹲角内，见下）。和 `oil_sample` 是两种流程——后者是「把样瓶举到眼前对光看」，
腕靠近鼻尖；这里手在胸腹以下、靠近地面，双手靠拢在同一作业点。
复用 `oil_sample` 会整段漏判（实测见下）。

| 层 | 条件 | 参数 |
|---|---|---|
| 信号（瞬时） | 双侧腕可见且**低于肩**（抬臂角 ≥100°，0°=向上/180°=下垂）；两腕距离 ≤1.3 躯干长；**任一条腿**膝角在 **60°–120°**；膝角 110°–120° 时还要上半身前倾（uprightness ≤0.8）；膝不可用时退回明显前倾（≤0.2） | `signals.arm.drain.{minElev,maxHandsClose,minKnee,maxKnee,weakKneeFrom,maxLeanUpright,maxUpright}`，默认 100 / 1.3 / 60 / 120 / 110 / 0.8 / 0.2 |
| 动作（保持窗） | 上面这条持续 1000ms，允许 900ms 内的短暂遮挡 | `actions.holds.{drainSample,drainSampleMaxGap}`，默认 1000 / 900 |

没有加「手在身体前方」的 3D 方位角门：蹲姿+俯拍下双手在体前会被 3D 判成侧向，
加了会整段漏判。代价是没有物体证据，纯姿态规则天然会混入其他「低手 + 蹲姿」活动，
所以 **`minKnee` 是标定出来的场景约束**：同一段素材里，深蹲/跪坐（膝角 27–55°）是
「针管取样/清洗试管」，半蹲在阀口接油是 74–160°。如果现场确实有人以深跪姿势接油，
把 `minKnee` 降到 0–40；同场景的针管取样/深蹲也会一起放进来，必须补对应反例。

膝角**取「任一条 available 腿落在区间内」，不复用 `kneePick`**。后者按髋-膝-踝三点
可见度选腿：单膝跪地时跪腿约 45–52°、支撑腿约 80–160°，遮挡会让选中的腿来回换，
同一姿势在检出/漏检之间跳。改为「任一条腿成立」后，只要两条腿都可见，结果就与哪条腿
更清晰无关；跪腿低于 `minKnee` 时不算蹲证据，所以默认档支持的是「支撑腿处在半蹲角」
的跪姿，不覆盖只以深跪腿接油的场景。

深跪/跪姿接油的 profile 覆盖示例（必须同时标该场景的深蹲/针管作业反例）：

```json
{
  "name": "deep-kneel-drain",
  "params": {
    "signals": { "arm": { "drain": { "minKnee": 0, "weakKneeFrom": 90 } } }
  }
}
```

`maxKnee` 上限从 140 收紧到 120：140° 只是轻微屈膝，站立双手拎低桶/端盆
（抬臂角约 170°、两腕靠拢、膝约 130°）会满足全部条件。收紧后在 7 个标注窗口上
事件指标不变（仍 3/3），帧级 recall 0.62→0.60。110–120° 这段是弱证据，
额外要求上半身前倾（`uprightness ≤0.8`）：站姿躯干直立（≈0.9）不会仅因微屈膝命中。

**实测（2026-11-18，`transformer_sample.mp4` 7 个 10fps 确定性窗口，共 1400 帧）：**

人工按 1s/0.5s 接触表逐段复核，标出 3 段正例（阀口 + 接油盆）和 5 个反例窗口
（清洗油样瓶、针管取样/排气泡、调压器取样、传递试管）。结果（当前默认参数）：

| 指标 | 结果 |
|---|---|
| 事件级 TP / FP / FN | **3 / 0 / 0** |
| 事件级 precision / recall | **1.00 / 1.00** |
| 帧级 precision / recall | **1.00 / 0.60**（122 TP / 0 FP / 82 FN） |

逐窗口：

| 窗口 | 内容 | 预测事件 | 标签 |
|---|---|---|---|
| 15–35s | 阀口接油 → 洗瓶 | 16.9–18.4 | 1 正例 / 1 反例 |
| 40–60s | 阀口操作 + 端盆 + 回阀口 | 41.3–50.8、58.0–59.0 | 2 正例 / 1 反例 |
| 70–90s | 针管取样 | 无 | 反例 |
| 95–115s | 针管排气泡 | 无 | 反例 |
| 125–145s | 调压器取油/螺栓 | 无 | 反例 |
| 165–185s | 试管传递/清洗 | 无 | 反例 |
| 195–215s | 试管清洗 | 无 | 反例 |

帧级 recall 0.60：正例里有很多帧单侧腕点被盆/阀门挡住，规则按“双侧腕”要求会弃权；
事件级仍是 3/3，因为 900ms 的掉帧容忍把断续接上了。40–60s 的第二段正例是单膝跪地，
支撑腿在 80–117° 时命中、膝角升到 148–163° 的帧被 `maxKnee` 拒掉，所以只剩 58.0–59.0s
这一段。

限制：

- **标签是本次人工复核的近似边界，不是正式真值**；7 个窗口都来自同一段素材、同一机位，
  **没有跨场景留出**。这组数字只能说明规则在这段素材上可用，不能当泛化精度。
- 事件样本只有 3 个正例，置信区间很宽；5 个反例窗口都是「其他取样动作」，不是随机负例。
- 手被接油盆/阀门挡住时腕点消失；900ms 是上限，再长会把两次独立动作粘起来。
- 没有「阀门/接油盆」物体检测：蹲下系鞋带、低处搬东西仍是潜在误报。
  下一步应接设备框，用「腕到阀/盆框的距离」替代纯姿态。
- 膝角对俯拍敏感；换机位必须重新标定 `minKnee/maxKnee`。
- 默认档不支持「只以深跪腿接油」（跪腿 <60° 不算蹲证据）；该场景要把 `minKnee`
  降到 0–40，并用 profile 覆盖，同时接受同场景深蹲/针管作业的误报。
- 膝角 120° 以内、双手在低处且上身前倾的站立作业仍可能命中；120–140° 的样本
  在本次反例集里没有，「站立微屈膝」只能靠 `maxKnee=120` 挡住。

## 三·七、持物与指向

- **持物 `carrying`**：手被判为握拳/OK（`closedShapes`）且两臂都没伸出（`reach < carry.maxReach`）。
  端着东西走路就是这种姿势；手举得很远则是拿取过程，不算持物。
- **指向 `pointing`**：单臂伸出、**该侧手判为「指方向/手枪」**（`pointShapes`），
  且**同一条臂**朝向接近水平（`arm_front_body` 或 `arm_side`；前者按受试者自身前方，
  背身时用 `arm_front_body` 才不会漏判）。手型与左右侧都绑定：
  「左手张开前伸、右手比划」不再能凑出指向；无 3D 时该动作不可用。
- **伸手 `reaching`**：臂伸出 **且该侧手判为「张开」**（`openShapes`）；
  握拳/OK、指方向、剪刀手都不算伸手。手的状态必须来自**伸出的那条臂**——另一侧手张开不能替它成立。
- **拿取 `grasp`**：`PhaseSequence(['reach','grasp'])`，先伸手（open）再合手（fist/OK）才计一次（见 §二）。
  完成后要连续张开 `signals.grasp.releaseMs`（默认 200ms）才允许下一次，抖动不会多计。

手型分组在 `params.signals.hand`：`openShapes` / `pointShapes` / `closedShapes`。
判不出手型（`unknown`、侧对镜头）时这些动作弃权，不拿旧结果硬判。

这四个动作（伸手/持物/指向/拿取）依赖手部模型。手部关掉或未检出时它们恒为 `false`，
这是刻意的降级：**宁可漏判，不要拿姿态去猜手的开合**。

动作输出同时给**聚合 flag** 和**逐侧 flag**（`reachingL/R`、`pointingL/R`、`armRaisedL/R`、
`wavingL/R`、`handAtHeadL/R`、`carryingL/R`、`oilSampleL/R`、`operatingL/R`）。聚合 flag
保持旧语义，评估器/标签不受影响；逐侧 flag 供界面说明「是哪只手」，也为后续按手拆准确率留好导出字段。

这些条件与已知误判会显示在 Demo 的「动作识别」面板：悬停动作名看 tooltip，面板下方一行
按当前帧提示能力缺失（手部模型/3D/髋/单帧）或当前动作最可能错在哪（`web/js/armhint.js`）。

### 取哪一侧：`knee_pick` / `elbow_pick`

计数**不能**用左右平均：单侧被遮挡时平均会被拉向不可用的一侧，导致角度虚高、永远数不到。
实现取「髋-膝-踝」三点可见性之和更高的一侧，输出为 `knee_pick`，并在 `knee_side` 里标出取的是哪条腿。
UI 上要显示这一点，否则用户会怀疑「为什么我蹲了他没数」。

## 三、平滑与去抖（顺序不能变）

1. **One Euro 滤波**（每关键点 x/y 各一个）：`minCutoff=1.0, beta=0.05`。
   比滑动平均好：静止时不抖、快速动作不拖尾。
   置信度 < 0.3 的点**不喂滤波器**，避免把噪声写进历史。
2. **角度信号再滤一次**（`minCutoff=1.5, beta=0.02`）：关键点平滑后角度仍会抖 1~2°，
   而阈值判定对 1° 的抖动很敏感（尤其滞回的上阈）。
   2D 角在三点中任一点可见性 < `visMin` 时直接给 **NaN**（该帧不喂滤波器，也不沿用上一次的值）：
   否则腿被桌子挡住、脚出画时，会拿漂移坐标或陈旧值凑出一个膝角，姿态层据此判成「下蹲」。
3. **尺度锚点做 5 帧中值滤波**：单帧关键点跳变会让 `scale` 突变，进而让所有 ratio 类信号跳变。
   3D 的 `scale_world` 同样做中值滤波，但它不替代像素 `scale`。
4. **2D / 3D 各自一套滤波器**：同一条信号不要在两套实现之间来回喂同一个滤波器，
   否则「3D 丢一帧退回 2D」会变成台阶；3D 侧不保持旧值。
5. **滞回**：下阈/上阈必须分开（保持窗 300ms / 遮挡容忍 150ms 这类成对参数）。共用一条线会在阈值附近连发。
6. **最短持续**：`Hold` 默认 300~500ms；姿态还要求连续命中 4~5 帧（`streak`），防止标签闪烁。
7. **自适应周期**：`RepCounter` 记住最近 `adaptiveWindow`(5) 次半程时长，
   有历史后门槛 = `max(minHalfMs, 中位数 × adaptiveMinRatio)`；
   冷启动（无历史）门槛 = `max(minHalfMs, minCycleMs × adaptiveBootstrapRatio)`。
   纯抖动不会进入历史，所以历史越跑越准；固定 `minCycleMs` 只在关闭 `adaptiveMs` 时使用。
8. **冷却**：同类事件 500ms 内不重复。
9. **左右侧选择滞回**：膝角/肘角每帧从左右两侧里挑一侧（选可见性高的）。
   上一帧那一侧仍然有效时，另一侧要高出 `sideHysteresis`(0.15) 才换。
   不设滞回时，两侧可见性在阈值附近抖动会让角度在两条腿之间来回跳。
   深蹲/俯卧撑计数下线后**没有基于膝/肘角的计数**，所以不再有「换侧中止半程」，
   `side_switched` 也不再产出；换侧只影响后续信号选哪一侧。
10. **角度突变剔除**：与上一次有效值相比，角速度 > `angleJump.maxRate`(1500°/s)
    且间隔 ≤ `maxDtMs`(250ms) 时，本帧视为坏点：**不给滤波器、也不沿用旧值冒充当前**（返回 NaN）。
    用角速度而不是固定角度，是因为 100ms 内跳 100°（1000°/s，快速下蹲）和
    33ms 内跳 100°（3000°/s，坏点）是两回事。持续超过 250ms 的值才接受。

**自检口径**：静止站立时膝角信号的峰峰值应 ≤ 8°。超过说明平滑参数没调好，先调参数再谈判定。

## 三·五、置信度门控

`ok = 画面内关键点平均置信 ≥ 0.45 且 有效锚点可见性 ≥ 0.4`

- **平均置信只统计画面内的点**。33 点里画面外的腿/脚本来就没有可见度，全量平均会把
  「上半身构图」整帧判成低置信（实测头~胸构图 0.63，修正后 0.85）。画面内点少于 5 个时退回全量平均。
- **有效锚点**：髋可见（≥ `minTorsoVis`）时取肩/髋四点最低可见性；髋不可见时只要求肩。
  上半身构图里髋在画面外，旧口径会让 `ok` 恒为 false，动作层整段冻结。
- `ok=false` 时动作层**冻结**：保持上一个姿态、不推进计数、不清空状态。
  直接清空会让姿态在遮挡时反复闪；继续判定则会用垃圾坐标把计数打乱。

## 三·八、上半身构图（髋/腿在画面外）

桌面摄像头最常见的画面是「头、肩、手臂可见，髋以下出画」。这一节定义哪些信号改用什么锚点，
其余量（角度、比值）的量纲与阈值都不变。

| 信号 | 常规锚点 | 髋不可信时（`visHip < minTorsoVis`） |
|---|---|---|
| `scale` | 肩中点↔髋中点 | 肩宽 × `signals.shoulderToTorso`（默认 1.4） |
| `uprightness` | 髋中点→肩中点（2D/3D） | **仅 2D** 鼻尖→肩中点 |
| `ok` 的锚点 | 肩/髋四点 `min` | 肩两点 `min` |
| `chest_height` 的下界 | 髋中点 y | 肩中点 y + `scale`（髋的几何位置） |
| `on_hips` | 腕贴髋 + 肘外张 | **恒为 false**（髋是模型猜的，判了只会误报） |
| 膝角 / 肘角 / 腿竖直比 | 原规则 | 不变；膝/踝不可见时仍为 NaN |

为什么 `uprightness` 的退路不做 3D：鼻尖在 3D 里位于肩平面之前（脸向前突出约 0.1m），
世界坐标的「鼻→肩」向量带一个大 z 分量，直立人被算成 0.62；2D 投影更接近「画面里是否竖着」。

**姿态结果**：只有上半身、但肩+髋仍可见时，站/坐/蹲仍缺少膝、踝证据，`posture` 不冒充站/坐/蹲，
而是输出 **`upper_upright` 上半身直立**（`uprightness > 0.75`）或 **`upper_lean` 上半身前倾**
（`0 < uprightness ≤ 0.75`）；页面标「仅上半身可见 · 推断」。髋也不可见时 `posture` 保持 `null`，
页面显示「上半身 · 下半身不可见（出画/遮挡），站/坐无法判定」——这是信息不足，不是识别失败。
手臂动作（操作设备 / 油样取样 / 伸手 / 持物 / 指向 / 举手）和拿取计数照常工作；已下线动作的底层信号仍在，见 §六·五。

## 三·八·五、人物有效性门（personGate）

低清晰度/近景特写里 MediaPipe 会把「手 + 取样管/瓶子」补成一个完整的人，随后进入信号层
（上半身直立、operating 等）造成误报。`perception.personGate` 在**信号层之前**做两道
几何门，默认开启：

| 门 | 判据 | 参数 |
|---|---|---|
| 姿态几何 | bbox 宽/高 < `minAspect`（细长条）、躯干长/框高 > `maxTorsoHeight`、平均置信 < `minScore`、双肩+双髋最低可见性 < `minAnchorVis` | `perception.personGate.*` |
| 手部包含 | 鼻/双肩/双髋至少 `minAnchors` 个落在同一只手框（外扩 `expand`）内，或手框面积 ≥ 人体框 `maxHandAreaRatio` | `perception.personGate.hand.*` |
| 骨架绘制 | 髋中点不得高于肩中点（倒置躯干不画；水平/弯腰仍画） | `perception.personGate.drawMinTorsoDrop`（默认 0；null 关闭） |

- 缺 bbox/kp/手数据时 **fail-open**：旧导出和测试夹具不会因为少字段被剔除。
- 被剔除的人不进入 `persons[]` / `verdicts[]` / 动作判定；带 `owner_track_id` 的手会
  一并过滤，未归属的整帧手部原始检出仍可能留在帧级 `hands[]` 里（不再归属给被剔除的人）。
- 单人道里腕点被取样管挡住时 `assignHands` 会放弃归属；手部包含门会退而用**整帧手**
  判定，否则「手+取样管」正好漏掉。多人只用手部归属到该 track 的结果，避免拿别人的手误杀。
- 阈值来自 4 段真实人物 + light_tube 误检的对比（真实人物 0% 误杀），**换机位必须用
  自己的素材复核**；profile 可写 `perception.personGate.enabled=false` 关闭。
- 这是误报护栏，不提高小目标/遮挡的召回；单张图片路径只做姿态几何门，不做手部包含门。
- **残余**：既没有手部检出、几何又像人的特写仍可能通过（light_tube 225 帧里 2 帧）。
  仅凭姿态无法区分，要彻底消除需要物体检测的 `person` 证据或分割 mask；当前只在
  采样窗口里短暂出现，不参与 `operating`。
- **2026-11-18 补**：机场素材观察轮（`runs/refuel-sampling-suite-2026-11-18/`）里，
  设备/工件特写被补成人的误检大多是「髋点在肩上」（drop < 0，躯干倒置）。这道门只用于
  **绘制骨架**（`drawMinTorsoDrop=0`）：动作判定仍用完整人物列表，因为逐帧剔除会打断
  `Hold` 的连续帧——B787 面板实测 `operating` 从 17 次采样掉到 1 次。水平/弯腰（drop≈0）
  仍画。少数几何上直立的误检（如 A320 取样箱 194.75s、218.75s）仍会漏过，需要手部检出
  或物体模型补证。真实人物里只有躯干被检成倒置的帧（A320 188.0s）不画骨架——那一帧的
  骨架本来就是倒的。

## 三·八·六、头部朝向（head）

设备特写、头~胸构图、只有半个头出镜时，躯干/髋/膝可能完全不可见，姿态层判不了站/坐；
但头部的鼻/眼/耳（`persons[].kp_head`）还在。`signals.head` 只吃这 9 点（加可选的
`kp_world`），**不依赖躯干、髋、膝**，因此这些构图下仍能给出头部朝向；尺度/几何门
不通过时角度为 `null`，但不会因为躯干不可见而整段没有头信号。

| 字段 | 含义 |
|---|---|
| `visible` / `points` | 头部点是否够用；可见的头部点数（9 点中）。`visible` 只表示“有头点”，角度可能因门控为 `null` |
| `face_px` | 实际使用的眼对/耳对像素距离；小于 `minPairPx` 时角度置 `null` |
| `source` | 本帧首选取源：`2d` / `2d_ear` / `3d` / `null`；逐轴看 `yaw_source` / `pitch_source` / `roll_source` |
| `confidence` | 0~1，点数、尺度、眼对质量、门控惩罚的乘积；不是概率 |
| `yaw` / `pitch` / `roll` | 角度（度），可为 `null`；符号见下。2D 是近似度，配 `yaw_approx` / `pitch_approx` / `roll_approx` |
| `reliable` | `{yaw,pitch,roll}`：幅度是否可信。饱和、耳对回退时为 `false`；方向仍可能可用 |
| `yaw_2d` / `pitch_2d` / `roll_2d` | 2D 原始量：`yaw_2d` 归一化到约 [-1,1]，`pitch_2d` 是以正视 0.45 眼距为基线的归一化值，`roll_2d` 是**度**（约 -90~90，不是比值）；诊断用 |
| `yaw_dir` / `pitch_dir` / `dir` | 量化方向：`left/right/front`、`up/down/front`，`dir` 为组合（`left_down` 等），left/right 指受试者自身 |
| `reasons` | `no_head_points` / `few_points` / `no_face_pair` / `no_nose` / `no_eye_geometry` / `face_too_small` / `nose_geometry` / `pair_disagree` / `roll_extreme` / `yaw_saturated` / `pitch_saturated` / `visibility_missing` / `angle_outlier`；开了 `use3d` 时还可能有 `no_world_3d` / `no_world_pitch` |

**符号**：全部按**受试者自身**的左右，和页面是否镜像无关。`yaw` 正=受试者向自己的右侧
转头，负=左；`pitch` 正=低头，负=抬头；`roll` 正=受试者左侧更低（向自己的左侧倾），
负=右侧更低。`dir` 的 left/right 同样是受试者自身。页面默认水平镜像显示
（`.stage.mirror`），但 kp 是原始视频坐标；统一用解剖左右才不会在镜像后反。

> **2026-11-20 符号变更**：此前的 `signals.head.yaw` 用原始画面右为正；现在改为受试者
> 右为正。旧导出重放时按旧语义，不要和新数据混在一起做统计。

**2D（默认）**：眼/耳线给 `roll`；把鼻/眼/耳去倾斜后，鼻相对脸中心（眼或耳中点）的
水平偏移除以脸半宽给 `yaw_2d`，再 `asin` 成近似度数；鼻-眼垂直距离 / 眼距给
`pitch_2d`（正视基线 0.45），按 ±45° 线性映射成近似度数并标 `pitch_approx=true`。
耳对回退乘 `earYawGain`（默认 2.4，耳距约为眼距的 2.4 倍），并标 `2d_ear`、
`yaw_approx=true`、`reliable.yaw=false`；2D 耳对不给 pitch（没有眼距基线）。
**3D（可选，profile 显式 `use3d`）**：`yaw` 取「头自身左右轴（眼/耳线）」相对相机像平面的
转角——先按 roll 把横向分量还原到水平面，再取 `atan2(latZ, |lat|)`（正=受试者向右）。
**不能**用鼻子相对眼线的横向/前向分量：真人转头是刚体旋转，眼线跟着转、鼻子相对眼线的几何
不变，那个量在转 30°/60° 时都≈0（2026-11-20 审核发现并改正；旧测试只挪鼻点，掩盖了问题）。
`pitch` 用眼→耳中点高差；`roll` 用眼/耳线。缺鼻时 yaw 仍为 `null`（与 2D 口径一致）。
2026-11-19 在 B787/变压器实拍上复核发现 Pose 的 world **面部**点噪声很大（同一姿势 yaw 在
±150° 之间跳），所以默认不用 3D；保留实现只给需要实验的 profile。2D 的 yaw/pitch 是投影
近似，不是标定过的解剖角。

**可信度门控**（2026-11-20 实拍复核后加）：门控不是“调阈值”，是承认 Pose 的头部点
在背身、帽檐、远处小脸时并不可信。6 段 refuel/B787/A320/变压器素材、1143 个
person-frame 的实测：眼距中位只有 6.3 px，63% < 10 px；未加门控时 39% 帧 yaw 饱和、
42% pitch 饱和。背身/帽檐样例（0.1s，戴安全帽和耳罩、看不到脸）仍给 visibility 0.99、
yaw −64° / pitch 45° / 置信 0.72；加门控后三轴全 `null`、置信 0.16。

| 门 | 默认 | 行为 |
|---|---|---|
| 尺度 | `minPairPx=10` / `goodPairPx=20` | 眼对/耳对 < 10 px → 三轴 `null` + `face_too_small`；置信按 `face_px/20` 衰减 |
| 鼻-眼几何 | `noseDropMin=-0.3` / `noseDropMax=1.8` | 去倾斜后 `(鼻y-眼中心y)/眼距` 越界 → 三轴 `null` + `nose_geometry`（背身样例是 2.9） |
| 眼耳一致性 | `maxPairDisagree=105°` | 眼对与耳对独立 yaw 差 > 105° → `yaw=null` + `pair_disagree`（实拍 P90≈105°，背身样例 154°） |
| roll 上限 | `maxRoll=75°` | `abs(roll)` 越界 → `roll=null` + `roll_extreme` |
| 旧数据 | — | `kp_head` 只有 `[x,y]` 时按可见处理，并标 `visibility_missing` |

profile 里的这些阈值在加载时（`validateParams`）做值域校验：`noseDropMax` 必须大于
`noseDropMin`、四组滞回里 enter 必须严格大于 exit（`yawEnter/yawExit`、
`pitchEnter/pitchExit`、`yaw2dEnter/yaw2dExit`、`pitch2dEnter/pitch2dExit`），且
**量纲对得上**——3D 两组是度（0–90），2D 两组是归一化量（0–1），把度数写进 2D 键、
或写成负数都会直接报错（否则 2D 永远达不到阈值，方向恒 `front`）。另有
`goodPairPx > 0` 且不小于 `minPairPx`、`maxPairDisagree` 在 0–180、`dirHoldMs ≥ 0`、
`minPoints` 是 1–9 的整数。写错时直接抛错，而不是让三轴静默恒 `null`（区间颠倒）或
方向逐帧翻转（enter ≤ exit）——和放油取样参数值域校验同一口径。

门控后约一半的 person-frame 三轴全 `null`。这是刻意的：那些帧的角度是噪声，宁可没有。
`headPoseText` 会把“太小/几何不可用/坏点”直接写出来，不给伪精度。

**部分可见**：缺鼻时 yaw 为 `null`（不能定左右）；3D 下眼-耳几何仍可给 pitch/roll，
2D 下没有眼距基线，pitch 也为 `null`。只有单侧眼/耳时没有 face pair，角度为 `null`，
只报告 `visible/points`；头部完全出画时 `visible=false`，绝不拿躯干/肩去猜头。

**方向滞回 + 去抖**：2D 用原始归一化量 `yaw2dEnter/yaw2dExit`（0.3/0.18）、
`pitch2dEnter/pitch2dExit`（0.25/0.12）；3D 用度数 `yawEnter/yawExit`（15°/8°）、
`pitchEnter/pitchExit`（12°/6°）。方向再经 `dirHoldMs`（默认 200 ms）去抖：首次获得
方向立即生效，切换/丢失要稳定 200 ms。方向只影响 UI/导出，不参与动作 Hold。
某一轴被门控置空（如 yaw 因 `pair_disagree` 不可用）时，方向词只报另一轴（`down`），
不会拼出 `null_down` 这种导出/UI 都非法的标签；两轴都不可用时为 `null`。
头部角度与关节角共用 One Euro 平滑和角速度坏点门（单帧 >1500°/s 判 `angle_outlier`，
不沿用旧值），不像旧版只平滑不剔坏点。但头部坏点只写进 `head.reasons`，**不**进
`signals.angle_outliers`：后者是「动作层 unreliable」的输入，而没有任何动作依赖头部角度，
混进去会把姿势完全正常的帧也标成「角度坏点」。

**限制**：门控只能挡住“明显不对”的样本，不能证明脸朝向相机；背身/侧脸/帽檐/口罩仍有
落在门控内侧的可能。没有专用人脸模型，Pose 的头部点来自人物检测，设备/工件被误检成
人时也会给头朝向——看 `reliable`、`reasons`、`confidence`，不要只看 `dir`。2D 的
yaw/pitch 是投影近似、未用实拍真值校准，只适合方向和量级；侧脸接近 90° 时符号和幅度
都不可靠，门控会尽量把它置 `null`。3D 面部点噪声大，除非自己用实拍验证过，否则不要
打开 `use3d`。这不是动作识别，只是朝向信号；需要「低头看设备」之类的动作时，在动作层
基于 `head.pitch/dir` 再加保持窗，并先看 `reliable`。

## 三·八·七、人体朝向（body：正面 / 背面 / 侧对）

背对相机时，MediaPipe 仍可能给鼻/眼点很高的可见度（实拍背身样例 0.99），但头部几何
不可信（§三·八·六 的门控会挡住）。**能不能判「这个人是背面」，最稳的证据是躯干**：
肩线在水平面的朝向，以及 2D 下肩宽/躯干长的投影比（侧对时肩线被压扁）。`signals.body`
只吃 `persons[].kp`（肩/髋/鼻）和可选的 `kp_world`，不看脸、不依赖膝/踝。

| 字段 | 含义 |
|---|---|
| `enabled` | 配置是否启用；关闭时 `facing='unknown'` |
| `facing` | 去抖后的朝向：`front` / `back` / `left` / `right` / `side` / `unknown`。`left/right` = 面向**画面**左/右；`side` = 侧对但鼻子不可见、定不了朝哪边 |
| `facing_raw` | 本帧未去抖的分类（排障用；UI/导出用 `facing`） |
| `yaw` | 度。0=正对镜头，±180=背对；正=面向画面右，负=左。可为 `null`（2D 侧对且无鼻、或数据不足） |
| `yaw_source` | `3d`（world 肩线）/ `2d`（肩顺序+肩宽比，幅值是粗档 0/±90/180）/ `null` |
| `confidence` | 0~1，肩点可见性、world 肩宽/躯干长是否在正常范围、鼻深是否与肩线矛盾；不是概率。低于 `minConfidence`（默认 0.35）时只报告朝向，**不参与方位角换算**（退回相机口径，宁可不用也别用坏肩线） |
| `side` | 侧对时的朝向 `left/right`，其余为 `null` |
| `shoulder_ratio` | 2D 肩宽 / 躯干长（侧对判据；实测侧面 P90≈0.27、正面 P50≈0.51） |
| `width_ratio` | 3D 肩宽 / 躯干长（正常约 0.32~0.68；越界只降置信，不推翻朝向） |
| `reasons` | `no_shoulders` / `low_shoulder_vis` / `no_scale` / `world_degenerate` / `no_world_hips` / `shoulder_width_outlier` / `nose_depth_disagree` / `disabled` |

**符号**：`yaw` 与 §三·八·六 的头部朝向不同——头部 yaw 是**受试者自身**的转头方向，
人体朝向的 yaw 是**受试者面向相机画面哪一边**。0/±180 的含义是「正面/背面」，
±90 是「侧对」。与方位角（§三·六）使用同一套相机水平面坐标。

**3D（优先）**：世界坐标 x 向右、z 指向屏幕内。肩线 = 受试者左肩→右肩，`yaw=atan2(s_z,s_x)`。
正对镜头时左肩在画面右 → `s_x>0` → yaw≈0；背对时左肩在画面左 → yaw≈±180。
这条不依赖脸，也不依赖画面镜像。实测在 419 个 person-frame 上与 2D 肩左右顺序的一致率约 99%
（只在 `|yaw|` 明显落在正面/背面档时比较）。额外用「鼻子相对肩中线的深度」做次要证据：
正对时鼻子更靠近相机、背对时更远；矛盾只降置信，不推翻肩线（头可能转过去看别处）。

**2D 退回**（无 world / world 肩点不可信）：肩宽投影比 = `|x_L−x_R| / scale`。
比值 < `sideRatio`（默认 0.3）判侧对，再用鼻尖相对肩中线的横向偏移定 `left/right`；
否则按肩的左右顺序判 `front/back`（正对时受试者左肩在画面右）。**输入不镜像**：
页面 `.stage.mirror` 只翻转显示，`kp` 始终是原始视频坐标。没有 `scale` 且髋点不可见时
直接 `unknown`——不从肩宽反推躯干长（那会把任意肩宽都判成正/背面）。

**朝向去抖**：`facing` 经过 `DirectionHold`（`holdMs` 默认 200ms）；`yaw` 仍是原始值，
下游按连续角换算。朝向状态只影响 UI/导出与下面这些信号，不参与动作 Hold。

### 背对/侧对时用身体坐标的「前方」

| 信号 | 定义 | 用途 |
|---|---|---|
| `armPose.azimuth_L/R` | 相机方位角：肩→腕，0°=朝镜头，±180°=远离镜头 | 诊断/旧口径 |
| `armPose.azimuth_body_L/R` | **受试者自身**方位角 = `azimuth − body.yaw`（归一到 ±180°）；没有可信 yaw 时为 `NaN` | 油样取样「手在身体前方」、背身的前伸/指向 |
| `armPose.arm_front_body_L/R` | 与 `arm_front_*` 同判据，但方位角用 `azimuth_body` | 前平举/指向；背身时前进方向与相机相反 |
| `arm.sample_L/R` | 油样取样的瞬时判据；「手在身体前方」**优先用 `azimuth_body`**，无人体朝向时退回相机方位角 | oil_sample |

为什么必须换算：背对相机时「身体前方」在相机坐标里是 ±180°。不换算会把「手在身前」判成
「手在身后」（油样取样漏判），把「往前伸/指向」判成朝后（指向漏判）。侧对同理：
身体前方在相机 ±90°，旧的 `|azim|<35°` 永远不成立。没有 world 时 `azimuth_body` 为 `NaN`，
油样取样退回纯距离判据（与旧行为一致，不因缺朝向把动作整段判掉）。

**限制**：这条信号只判「躯干面向哪边」，不判头转向、不判眼睛看哪；背身回头时
`body.facing=back` 但 `head.yaw` 可能仍有值，两者不矛盾。2D 退回的 yaw 只有粗档
（0/±90/180），幅值不要当真。world 肩线在人物被遮挡/低清晰度特写时也会抖，
看 `confidence` 与 `reasons`；`shoulder_width_outlier` 是「肩线或躯干估计坏了」的提示。
`yaw` 本身**没有时间平滑**（只有 `facing` 做了 200ms 去抖），抖动会直接进入
`azimuth_body_*`；指向/前平举的保持窗只有 250–300ms，背身素材若断续命中，先查肩线抖动
再调阈值。
多人时每人一套独立状态：

```json
"body": {
  "enabled": true, "facing": "back", "facing_raw": "back",
  "yaw": 176.3, "yaw_source": "3d", "confidence": 0.89,
  "side": null, "shoulder_ratio": 0.21, "width_ratio": 0.57,
  "reasons": []
}
```

## 三·八·八、蹲下姿态（crouch，2026-11-26 恢复）

**为什么单独一节**：蹲下需要膝/踝证据，而背对相机的工人正好是最难的一种——2D 膝角会被
透视压扁（实测合成背身深蹲：3D 膝角 52°，2D 膝角 ≈168°，看起来像站直）。所以蹲下判定
**默认优先用 world 3D 膝角**，2D 只在没有 world 时退回；再加腿竖直比和髋-膝高度差。

| 信号 | 含义 | 默认门 |
|---|---|---|
| `knee_pick` | 判定用的膝角（有 world 用 3D，否则 2D；按可见性选腿） | `20° < knee < 135°` |
| `leg_vertical_pick` | **单腿**竖直延伸：两侧都可见时取可见性更高的一条（背身时远侧腿常被挡住）。缺字段的手搓信号退回 `leg_vertical` | `< 0.8`（髋明显下沉） |
| `uprightness` | 躯干与竖直方向的 cos | `> 0.2`（排除躺卧/躯干水平） |
| `hip_knee_drop` | 髋-膝高度差 / 躯干长；**正 = 髋在膝下方（蹲）**，负 = 髋在膝上方 | `> -0.8`（排除单膝跪地/弓步） |

**为什么是 `leg_vertical < 0.8` 而不是「>0.8」**：`leg_vertical` 是踝-髋竖直距离 / 躯干长。
站立约 1.3~1.8，坐在椅子上约 0.9~1.0（≈小腿长），深蹲/半蹲时髋明显下沉。
用 `evaluate.mjs` 的 `replay()` 回放 `transformer_sample.mp4` 75–115s 的 5fps 导出
（`eval-data/incoming/transformer-crouch-seg2.jsonl`，200 帧 / 183 person-frame）：
判出的 17 帧 `crouch` 里，`leg_vertical_pick` 中位 **0.37**（p10 −0.09、p90 0.45）、
膝角中位 56°（p10 46°、p90 80°）、直立度中位 0.69（0.62–0.72）；两侧平均的
`leg_vertical` 在这 17 帧里只有 7 帧有值。旧的「>0.85」门会把这些真蹲全部挡掉。
所以蹲下的判据改成「膝弯 + 髋明显下沉」，坐在椅子上（>0.8）自然被排除。
低凳坐着髋同样很低，几何上仍无法与蹲分开——已知歧义。

**背身遮挡**：从背后看，远侧腿常被近侧腿挡住。`legs_visible`（两侧平均的
`leg_vertical` + 膝角）会因此为 false，但 `leg_vertical_pick` 只用可见性更高的一条腿；
`knee_pick`、`hip_knee_drop` 也逐侧退回（2D/3D 各自选可见的一侧）。
所以「一条腿被挡、另一条腿可见」的背身工人仍能判蹲下；两条腿都不可见才弃权。
`leg_vertical_pick_side` 导出实际用了哪条腿，便于排障。

`hip_knee_drop` 是 2026-11-26 新增的诊断信号，同时导出 2D/3D（`hip_knee_drop_2d/_3d`）：
3D 用世界坐标在重力轴上的投影（背身时 2D 投影更容易骗人），2D 用
`(髋中点 y − 膝中点 y) / scale`。它只用于排除跪姿，不用于区分「坐」——
坐在椅子上的髋-膝高度差同样接近 0，纯姿态无法与平行蹲分开。

优先级：`蹲下 (25) > 坐 (20) > 站立 (10)`。反过来蹲会被「坐」吃掉（两者膝角区间重叠）。
深跪/跪姿接油（髋远高于膝）被 `hip_knee_drop` 排除，不算蹲下。

**量纲注意**：`leg_vertical_pick` 始终是 2D（像素 / 2D 躯干长），crouch 的
`legVerticalLt=0.8` 也按 2D 标定。若 profile 打开 `signals.world.legVertical`，
两侧平均的 `leg_vertical` 会换成 3D（站立约 2.0），但 crouch 仍优先用 2D 的 pick——
换机位/换量纲时要重标这个阈值，不能直接套用 0.8。

**验证**：`web/test/crouch-test.mjs` 用背身合成骨架覆盖「2D 看似伸直、3D 膝角弯曲」的
背相机场景，以及站姿、单膝跪地、单腿被挡、双腿不可见、坐姿不被吃掉、profile 覆盖阈值。
离线回放（同一份本机导出，`eval-data/` 不入库；JSONL 的 meta 记录了导出条件：
model full / CPU、推理 30fps、记录 5fps、profile refuel）：

```bash
node web/test/evaluate.mjs --input eval-data/incoming/transformer-crouch-seg2.jsonl --timeline
```

200 帧 / 183 person-frame，判出 **17 帧** `crouch`，集中在 75.7–77.9s 与 96.3–97.1s；
这些帧 `leg_vertical_pick` 中位 0.37、膝角中位 56°、直立度中位 0.69、
`hip_knee_drop` 中位 0.02（p10 −0.22、p90 0.26），与蹲下的物理量级一致。
浏览器 30fps 实播与 5fps 导出回放的滤波时间基不同，帧数/数值会有差异；引用时以这条回放命令为准。
**没有背身蹲姿的人工段级真值**（该素材背身帧只有 2 帧），阈值仍需按甲方机位重标。

## 三·九、判定不可靠的原因（误差识别）

动作层的每帧输出带 `unreliable` 数组；页面在数据面板显示「不可靠：…」，导出 JSONL 里也有这一列。
它描述的不是动作，而是**这一帧结论的可靠性**：

| 值 | 含义 | 对判定的影响 |
|---|---|---|
| `low_confidence` | 置信门控失败（§三·五） | 动作层冻结，沿用上一帧结论 |
| `extrapolated` | 有短时遮挡外推点（§一·五） | 相关计数冻结 |
| `bone_blocked` | 骨骼长度一致性判某肢不可靠 | 相关 3D 信号为 NaN，手臂动作可能不成立 |
| `angle_outlier` | 本帧角度因角速度过大被剔除（§三 第 10 条）；头部 `head:yaw` / `head:pitch` / `head:roll` 共用同一道门 | 该角度为 NaN/`null`，依赖它的判定本帧不成立；头部帧的 `head.reasons` 会带 `angle_outlier`，但**不**把整帧标成 `unreliable`（头部角度不参与动作判定） |

界面同时显示画面内置信与「下半身不可见」，用来区分「人不可信」和「画面里没有腿」。
这几项都是**弃权**，不是猜测：宁可这一帧不判，也不让坏点把计数带偏。

## 四、当前阈值（量级参考，必须用自己的校准数据替换）

> **阈值的唯一出处是 `web/js/params.js` 的 `DEFAULT_PARAMS`**，本表只解释「为什么是这些量级」。
> 调阈值不要改本表、也不要改代码：复制 `web/profiles/refuel.json` 写差分，
> 然后用 `web/test/evaluate.mjs --fit` 从实拍数据取分位（见 `docs/eval.md`）。
> 本表与代码不一致时，以代码为准。

| 信号 | 阈值 | 依据 | params 路径 |
|---|---|---|---|
| 膝角 站立 | > 150° | 解剖学伸直约 175~180°，留抖动余量 | `actions.posture.stand.kneeGt` |
| 膝角 蹲下 | 20°~135° | 深蹲底部约 40~100°，半蹲约 100~135°；3D 优先（背身 2D 会被压扁） | `actions.posture.crouch.knee*` |
| 膝角 坐 | 55~135° | 坐姿膝屈约 90° | `actions.posture.sit.knee*` |
| 肘角 俯卧撑底（已下线） | < 90° | 肘屈到底约 60~90° | 信号仍导出，不再驱动判定 |
| 肘角 伸直（已下线） | > 150° | | 信号仍导出，不再驱动判定 |
| `uprightness` 站立 | > 0.8 | cos 值；0.8≈36° 以内 | `actions.posture.stand.uprightnessGt` |
| `uprightness` 躺卧（已下线） | < 0.45 | 躯干近水平 | 上半身构图里仍用于判「站/坐都不可判」 |
| `uprightness` 上半身直立 | > 0.75 | 躯干偏离竖直 < ≈41° | `actions.posture.upper.uprightGt` |
| `uprightness` 上半身前倾 | 0 ~ 0.75 | 前倾；≤0（躯干水平/倒置）不判，可能是躺卧或髋点漂移 | `actions.posture.upper.leanGt` |
| 上半身框高宽比 | ≥ 0.9 | 上半身框通常高于宽；横向大框多半是手臂/设备特写被凑成人（refuel 实测 220×147） | `signals.upperBody.minAspect` |
| 头部可见 | 头部 9 点中 ≥2 点可见，且鼻/眼对/耳对至少一个 | 只有鼻+单眼时能确认「有头」，但定不了左右朝向 | `signals.head.minPoints` / `visMin` |
| 头部方向 | 2D：yaw 0.3/0.18、pitch 0.25/0.12（原始归一化量）；3D：yaw 15°/8°、pitch 12°/6°（度） | 阈值附近抖动用滞回，再过 `dirHoldMs=200ms` 去抖；方向只是状态，不参与动作 Hold | `signals.head.*` |
| 头部角度门控 | 眼对/耳对 ≥10px；鼻-眼 drop ∈ [-0.3, 1.8]；眼耳 yaw 差 ≤105°；`abs(roll) ≤ 75°` | 任一越界 → 对应轴（或三轴）置 `null`，不输出伪角度 | `signals.head.minPairPx/noseDrop*/maxPairDisagree/maxRoll` |
| 头部角速度坏点 | >1500°/s 且间隔 ≤250ms | 与关节角同一道门；本帧 `head.yaw/pitch/roll` 为 `null`，`reasons` 带 `angle_outlier` | `signals.angleJump.*` |
| 人体朝向 | 3D 肩线：\|yaw\|≤45° 正面、≥135° 背面；2D 肩宽/躯干长 <0.3 侧对，鼻偏移 ≥0.08·scale 定左右 | 肩点可见性 ≥0.3；world 肩宽/躯干长越界或鼻深矛盾只降置信；置信 <0.35 不参与方位角换算；facing 去抖 200ms | `signals.bodyFacing.{visMin,frontMax,backMin,sideRatio,sideNoseRatio,minConfidence,holdMs}` |
| `leg_vertical` 站立 | > 0.8 | 踝明显在髋下方 | `actions.posture.stand.legVerticalGt` |
| `leg_vertical_pick` 蹲下 | < 0.8 | 深蹲/半蹲时髋明显下沉（0~0.7）；坐椅约 0.9~1.0、站立 1.3+ | 与坐的分界；低凳坐着是已知歧义 |
| `hip_knee_drop` 蹲下 | > -0.8 | 髋比膝高出太多是单膝跪地/弓步，不是蹲下；3D 优先 | `actions.posture.crouch.hipKneeDropGt` |
| `leg_vertical` 躺卧（已下线） | < 0.8 且 `uprightness` < 0.45 | 两个条件必须同时满足 | — |
| 骨骼长度偏离 | > 20% 判不可靠 | 模型估计值的正常波动约 5~10%；20% 已明显是漂移 | `signals.world.boneCheck.tolerance` |
| 骨骼样本数 | ≥ 10 帧才启用 | 太少的中位数本身不可信 | `signals.world.boneCheck.minSamples` |
| 遮挡外推 | ≤ 300 ms | 超过 0.3 s 的常速度假设不成立 | `signals.occlusion.maxExtrapMs` |
| `knee_vel` / `elbow_vel` | 只导出，不设阈值 | 速度阈值的用途是判断 Hold 是否跟得上 | `signals.velocity` |
| 关节角突变 | > 1500°/s 且间隔 ≤ 250 ms | 33 ms 内跳 110°≈3333°/s（坏点）；100 ms 内跳 100°=1000°/s（真实下蹲） | `signals.angleJump.maxRate` / `maxDtMs` |
| 左右侧滞回 | 0.15 | 另一侧可见性要高出 0.15 才换侧，防两侧抖动 | `signals.sideHysteresis` |
| 上半身尺度换算 | 肩宽 × 1.4 | 髋不可信时用肩宽估躯干长；实测肩宽/躯干长 ≈1.25~1.55 | `signals.shoulderToTorso` |
| 人物有效性门 | bbox 宽/高 ≥0.12、躯干/框高 ≤1.4、锚点可见性 ≥0.4、手框覆盖全身；骨架另要求髋不低于肩 | 低清晰度特写里「手+取样管」被补成人的几何特征；真实人物 0% 误杀（4 段本机素材；2026-11-18 机场素材复核：站立/坐/蹲 0.75~1.0，误检多为负值） | `perception.personGate.*` / `drawMinTorsoDrop` |
| 前/侧平举保持 | 300 ms | 走路摆臂的瞬时命中只持续 ~250 ms | `actions.holds.front` / `side` |
| 前/侧平举伸直度 | 3D 腕-肩距离 / 躯干长 > 0.85 | 弯臂横在胸前约 0.5~0.8，必须基本伸直才算平举 | `signals.arm.azimuth.minReach` |
| 腕部 ROI | 1.8 × 躯干长（64~480 px） | 全身构图手只有几十像素，放大后再检；中心归属另行判定 | `signals.hand.roi.mul` / `minPx` / `maxPx` |

## 五、姿态互斥规则

**当前有蹲下 / 坐 / 站 / 上半身直立 / 上半身前倾五个姿态**（躺卧已下线，见 README 能力清单的说明）。
命中时按优先级取一个；上半身姿态只在膝/踝不可用时参与竞争，所以不会盖掉站/坐/蹲：

```
蹲下 (25) > 坐 (20) > 站立 (10) > 上半身直立 (6) > 上半身前倾 (5)
```

优先级高的更「具体」也更「危险」，误判代价更小。

「坐」要求 `leg_vertical < 1.05`，且膝角落在 55°~135°；站要求膝角 > 150° 且腿竖直比 > 0.8；
蹲下的判据见 §三·八·八。下半身不可见时三者都无法成立，姿态输出 `null` —— 这是信息不足，不是识别失败。
蹲下的优先级高于坐：坐与蹲的膝角/直立度量级相同，只能靠腿竖直比分；反过来蹲会被「坐」吃掉。
代价是坐在椅子上（腿竖直比同样 >0.8）可能被判成蹲下，纯姿态无法区分。

## 六、门控（为什么计数要加门）

> 鼓掌计数已下线；下面的门控实现仍保留在引擎里，用于历史数据回放与误判排查。

- **鼓掌**：吃 `hands_close`（两腕距离 / 躯干长）的周期，但必须 `chest_height`（两腕在肩与髋之间）
  且**不是抱臂**。少了后两道门，抱臂、头顶合手、整理衣领都会被数成鼓掌。
- ~~深蹲计数~~ / ~~俯卧撑~~：需要全身或地面机位，已下线。膝角仍驱动**蹲下姿态**
  （§三·八·八，不是计数）；肘角只作为信号导出，不再驱动任何判定。
  将来重开深蹲计数时，门控可参考 `leg_vertical < 0.8 且 uprightness > 0.2`（与姿态同口径）。
- 门控失效时调用 `RepCounter.abort()` 把相位复位，而不是暂停计数 ——
  暂停会让「下到底 → 坐下 → 再站起」被补记一次。
- **短时遮挡外推期间例外：冻结而不是 abort**。`extrapolated` 命中的帧只跳过
  `update()`，相位与计数都保持；外推结束后从原相位继续。按动作只冻结用到的点：
  当前保留的是鼓掌（已下线）——看两腕（`wrist_L` / `wrist_R`）；深蹲/俯卧撑的冻结已下线。

## 六·五、手臂信号与手部手势

### 手臂信号（用姿态骨架，不需要手部模型）

> 这一节是**信号**（坐标/角度/比值）。动作层的 `reaching` / `carrying` / `pointing` / `grasp`
> 还需要手部开合状态，手部模型关掉时它们恒为 `false`，见 §三·七。
>
> `crossed` / `on_hips` / `hands_close` / `arm_front_*` / `arm_side_*` / `wave.*` 仍由信号层输出，
> 但对应动作（抱臂/叉腰/鼓掌/前平举/侧平举/挥手）已下线：保留它们是为了历史数据回放与误判排查，
> 界面与新增标注只覆盖当前动作集。
>
> 背对/侧对相机时，「前」有两种口径：`azimuth_L/R` / `arm_front_*` 是**相机**口径
> （0°=朝镜头），`azimuth_body_*` / `arm_front_body_*` 是**身体**口径（0°=身体前方，
> 由 §三·八·七 的 `body.yaw` 换算）。动作层用身体口径；没有可信人体朝向时两者相同。

| 信号 | 定义 | 用途 |
|---|---|---|
| `elev_L/R` | 肩→腕向量与「上」方向的夹角，0°=手在肩正上方，90°=水平，180°=下垂 | 举手、张开双臂 |
| `reach_L/R` | 肩到腕的距离 / `scale`（`ratios=true` 时改世界距离 / `scale_world`） | 区分「手贴身体」和「手伸出去」 |
| `hands_close` | 两腕距离 / `scale`（同上可切 3D） | 鼓掌的周期信号（已下线） |
| `crossed` | 两腕**左右顺序相对肩膀翻转**，且两腕都在肩中点 ±1.1·scale 高度内 | 抱臂（已下线）。用顺序而不是固定符号，人转身背对镜头也成立 |
| `on_hips` | 腕贴同侧髋 < 0.65·scale **且肘外张 > 0.22·scale**（肘不可见时只看腕） | 叉腰（已下线）。少了肘外张，自然下垂的手会被误判 |
| `open_wide` | 两侧 elev ∈ [55°,125°] 且 reach > 0.9（`ratios=true` 时 elev 用 3D 抬臂角） | 张开双臂 |
| `chest_height` | 两腕都在肩与髋之间 | 鼓掌门控 |

**门控**（已下线动作，保留实现）：鼓掌必须 `chest_height && !crossed`。抱臂时两腕也很近，只用「两腕距离」会把抱臂算成鼓掌。
鼓掌计数用 `RepCounter`：`down=0.45`（合掌）、`up=1.0`（分开）、`minCycleMs=400`。

**挥手（`waving`，已下线）**：翻转次数与幅度必须来自**同一条举起的臂**。`wave.L/R` 是左右腕的翻转次数，
`wave.amp_L/amp_R` 是对应侧的幅度，判定只看「该侧举起」的那一份。
只取两侧最大幅度时，「左手举着不动、右手在髋旁摆动」会被凑成挥手（走路视频里就会误报）。

### 手部（MediaPipe HandLandmarker，每只手 21 点）

点位：0 腕，1-4 拇指（CMC/MCP/IP/TIP），5-8 食指，9-12 中指，13-16 无名指，17-20 小指。
手部尺度 = 腕(0) ↔ 中指 MCP(9) 的距离。

**腕部 ROI 补检**：全身/远景构图里手只有几十像素，整帧 HandLandmarker 实测 **0/18 帧**检出手，
导致伸手/持物/指向/拿取和全部手势永远不成立。现在整帧漏检、且姿态腕点可见时，
以腕点为中心裁一块（1.8×躯干长，64~480px）放大到 320×320，用**独立的 IMAGE 实例**复检；
同一批素材 18/18 帧检出双手。两个实例必须分开：VIDEO 实例用于整帧跟踪，
把裁图喂给它会被当成视频的下一帧。只用漏检时才付这次推理。

- **侧别**：ROI 结果的 handedness 由「裁的是哪只腕」决定，不采信 MediaPipe 的 handedness
  （它假设输入是自拍镜像，普通视频会反过来）。裁右腕却检出左手时，按「检出腕点离哪个姿态腕点最近」丢弃。
  **整帧结果同样纠正**：归属到某个人后，按检出腕点到该人左右姿态腕点的距离填 `L/R`；
  原始模型值留在 `handedness_raw`，导出里带 `side_from`（`wrist` / `roi`）。两侧腕点都不可见时保留模型输出，不猜。
  这样逐侧 flag、手势稳定器和离线回放看到的是同一套左右侧。
- **多人**：整帧检出的手按「腕点离哪个人的姿态腕点最近（按躯干长归一化）」归属到各 track
  （`multi.js` 的 `assignHands`，阈值 0.8×scale），每人只拿自己的手；两人靠得很近时仍可能归属错。
  腕部 ROI 补检按预算给面积最大的前 `min(perception.multi.maxPersons, signals.hand.roi.maxPersonsPerFrame)`
  人做（主目标优先，默认 2 人）；`scale < signals.hand.roi.minScalePx` 的人跳过，属正常跳过而非失败。

**朝向 `orient`**：手势只在手掌大致正对镜头时可靠，侧对时四指长度被压扁。
`orient.facing = 'edge'` 时 UI 用手部卡片虚线边框提示「这个结果别信」。
判据是「食指 MCP ↔ 小指 MCP」的横向宽度 / 掌长，比值 < 0.55 记为侧对。
这是一个**可靠性提示，不是语义判定**——不参与任何手势规则。

**张开度 `spread`**：食指与小指指尖相对腕部的夹角（度）。手掌张开时大、握拳/并拢时小。
同样**只作辅助信息**，不参与手势判定：手指弯曲时指尖也会偏离掌轴，
单靠它分不开「张开」和「四指并拢前伸」。手势判定仍以 `handshape.js` 的伸直规则为准。

手指伸直判定要**两个条件同时满足**：

1. PIP 处夹角 > 150°
2. 指尖到腕的距离 > PIP 到腕的距离 × 1.12

只用角度时，手背朝镜头会把弯曲判成伸直；只用距离时，手指斜指也会误判。

拇指单独处理：IP 处夹角 > 145° 且拇指尖到食指 MCP 的张开度 > 0.55（拇指的方向和四指不同，套四指规则会一直判成弯）。

手势规则（按顺序判定，先命中先返回）：

| 手势 | 规则 |
|---|---|
| OK | 拇指尖↔食指尖 < 0.45·scale，且中/无名/小指伸直 |
| 竖拇指 | 拇指伸直、四指全弯、拇指尖比腕高 0.35·scale 以上 |
| 剪刀手 | 食指+中指伸直，无名+小指弯 |
| 手枪 | 拇指+食指伸直，中/无名/小指弯 |
| 摇滚 | 食指+小指伸直，中指与无名指弯 |
| 指方向 | 只有食指伸直 |
| 握拳 | 四指全弯且拇指不伸直 |
| 张开 | 四指全伸直 |

一个都不满足时返回 `unknown`，UI 显示「—」——**不要硬给一个最像的标签**，宁可空着。

### 手势去抖（`HandShapeStabilizer`）

`classifyHand()` 是逐帧的纯函数，结果会在阈值附近闪（「张开→剪刀手」来回跳）。
`HandShapeStabilizer` 要求同一个手势**累计命中 `streak`（默认 3）次**才切换；中间夹 `unknown`
的帧跳过、不清零计数。但两次命中间隔超过 `keepMs`（默认 250ms）就整体过期：结果回到 `unknown`，
半途候选一并丢弃（冷启动时 `last` 恒为 `unknown`，同样按 `keepMs` 过期）。
「间隔」按 `update()` 的调用时间算，包括这只手完全没检出、调用方一帧都没推的那段时间——
过期检查在 `update()` 开头，而不是只在 `unknown` 分支里（否则静默间隔里的候选会一直存活）。

关键口径：**`unknown` 只在 `keepMs` 窗口内跳过、不清零**。手被遮挡或侧对镜头的一两帧会判成 `unknown`，
若把它算作「不连续」而清零，手型明明稳定也永远切不过去——同一段素材（transformer 取样，10fps）
上实测：

| 口径 | 敢判（/26 标注） | 判对 | 弃权 | 手型切换次数 |
|---|---|---|---|---|
| `unknown` 清零（旧） | 18 | 17 | 8 | 7 |
| `unknown` 跳过（现） | 21 | 20 | 5 | 8 |

弃权率从 31% 降到 19%，精度不变差（26 个标注点上 94.4% → 95.2%，样本小，别当验收指标）。
**门槛评估仍需同时看弃权率**（`--max-gesture-abstain`）——只看精度会高估这套判定。
注：上表是审核前的口径（过期只在 `unknown` 帧触发）。2026-11-26 修掉「手完全没检出、
调用方不推帧」的静默间隔后，过期按 `update()` 的调用时间算；连续检出（间隔 ≤ keepMs）时结果不变，
手长时间出画再回来的片段会先弃权、重新攒 `streak`。
**低帧率注意**：推理间隔大于 `keepMs`（低于 4fps）时每帧都会先过期，手势永远锁不住；
部署到低帧率设备时 `keepMs` 要跟着放大（当前是稳定器默认值，未暴露成配置项，需要改默认值/代码）。

防闪烁的原始保证没有丢：换成**另一个手势**就清零，交替手势（A、B、A、B…）凑不够累计命中。

- 每个 `track_id` 各一套 L/R/U 稳定器（`TrackShapeStabilizers`）；单人道固定用 track 0，
  多人时**先归属、再分类**，A 的命中不会推进 B 的计数。`app.js` 里的
  `shapeStable` 就是这个映射，不是全局的 `L/R/U` 三个实例。
- 首帧不切换：冷启动时先显示「—」正确，而不是把第 1 帧的噪声当成手势
- 单帧异常不会打掉已稳定的手势

### 手部关键点质量（无真值代理）

仓库里**没有**手部关键点真值，所以下面这些是**稳定性/精度代理，不是准确率**。
`node web/test/handkp-eval.mjs --input <raw-export.jsonl>` 计算；加 `--gt` 可接真值算
PCK@α / 归一化 MPJPE（真值格式见 `docs/frame-schema.md`「handkp-gt v0」）。

口径：全部按手尺度 `s = ‖kp[0] − kp[9]‖`（腕→中指 MCP）归一。

- **抖动**：相邻帧同名关节位移 ÷ s。真实运动也会抬高它，所以另给**静止对**子集
  （腕点位移 ≤0.05·s 且 |Δs|/s ≤5%）——静止抖动才是噪声代理。
- **骨长 CV**：每条骨的 `‖kp[a]−kp[b]‖/s` 跨帧的 std/mean。整段会混入手型变化与透视缩短，
  **不是纯噪声**；看「静止段」或同素材 A/B，别跨素材比。掌骨子集相对刚性，可作辅助。
- **尺度 CV**：s 本身的变异。
- 跨来源（ROI 补检 `roi` ↔ 整帧 `wrist`）的相邻对**剔除**：两者输入分辨率不同，不是同一把尺子。

本轮在 `transformer_sample` 的 10fps 导出（200 帧 / 223 手）上实测（2026-11-26，**单段未标注素材**）：

| 指标 | 值 | 样本 |
|---|---|---|
| 静止抖动 median / P90 | 0.039 / 0.096 | 13 对 / 273 关节样本 |
| 静止段骨长 CV median | 0.018 | 63 骨样本 / 3 段 |
| 整段骨长 CV median（含形变） | 0.194 | 294 骨样本 |
| 尺度 CV（整段 / 静止段） | 0.093 / 0.003 | 14 / 3 段 |
| 跨来源相邻对 | 28 / 204 | — |

静止对只有 13 个，**别当稳定指标**；用途是同一素材 A/B 回归，不是验收。

### 手臂信号扩展

| 信号 | 定义 | 用途 |
|---|---|---|
| `elev_torso_L/R` | **3D** 抬臂角：肩→腕向量与世界坐标躯干轴（髋中点→肩中点）的夹角 | 抗机位俯仰 |
| `reach_head_L/R` | 腕到鼻尖距离 / scale | 手在头部附近 |
| `both_hands_up` | 两侧都举起（3D 可用时用 3D 判定） | 双手高举，与单臂举手区分 |

**为什么要有 3D 抬臂角**：2D 的 `elev` 把「俯拍时的手臂前伸」和「真实抬臂」混为一谈——
俯拍时手向前伸，投影里腕也在肩上方，2D 判成举手。
`elev_torso` 用 `worldLandmarks`（米制、原点在髋中心、y 负方向为上）算相对躯干的夹角，
把摄像机姿态抵消掉。**只有 `has_world=true` 时有效**，否则给 NaN，动作层自动退回 2D。

阈值：`elev_torso < 75°` 记为举起（`arm.elevTorso.raised`）。

### 3D 比值的双份导出

`reach` / `hands_close` / 手-头距离 / 手腕-髋距离都有 `*_2d` 与 `*_3d` 两份，
判定用哪份由 `signals.world.ratios` 决定（默认 2D）。导出帧里两份都在，
所以同一段素材可以离线比较「换 3D 后正/侧面分布是否更一致」：

```bash
node web/test/signal-compare.mjs --a front.frames.json --b side.frames.json --action squat
```

`--action` 会自动找同名 `front.labels.json` / `side.labels.json`；没有 labels 时只做全帧分布对比。
动作匹配与评估器同口径：`arm_raised` 与 `armRaised`（id/flag）等价，`!动作` 与
`expect:false` 的反例窗口**不参与**正例采样（否则均值/分位被反例污染）。
输出每套信号的分布与**跨素材重合度**（1=完全重合），以及 2D/3D 的差值。
重合度高不代表信号正确，它只回答「换机位后分布漂不漂」，必须和 recall/precision 一起看。

## 七、已知限制

- **3D 不是真值，是模型估计值**。`worldLandmarks` 的抖动可能大于 2D 投影，尤其在手部/肢体末端。
  所以验收不是「改完 3D 就算数」，而是在实拍素材上比较 2D / 3D 的静止峰峰值与跨机位重合度
  （`signal-compare.mjs`），允许按信号分别选。默认只开了语义直接可比的角与直立度；
  `leg_vertical` 与距离比值需要重拟合阈值后再切。
- **骨骼长度一致性有冷启动**：前 `minSamples`(10) 帧不否定任何肢体；单帧深度估计跳变若恰好
  落在中位数窗口里，会短暂把正常肢判成不可靠。阈值 20% 是量级参考，需用实拍统计校准。
- 侧视 vs 正视：侧面看蹲是膝角，正面看蹲是髋下沉量。同一动作不同机位要不同原语，
  这不是缺陷，写进 profile 的 `camera` 段。
- **背对相机**：`body.facing` 由肩线/躯干判（不看脸），头部朝向在背身时会被门控置 `null`
  （这是刻意弃权，不是识别失败）。背身的「前伸/指向/手在身体前方」靠 `azimuth_body` 修正；
  但背身时手常被身体挡住，手部模型和腕点的可用性仍是主要瓶颈。2D 退回只给粗档朝向，
  不要拿它的 yaw 当精确角度。多人时每人独立判朝向。
- **蹲下**：需要膝/踝可见的全身构图，上半身构图下保持 `null`（信息不足，不是失败）。
  背身时 2D 膝角会被透视压扁，优先用 world 3D 膝角；缺 world 且 2D 投影恰好接近伸直时会漏判。
  「坐 vs 蹲」靠髋是否明显下沉（`leg_vertical_pick < 0.8`），低凳坐着几何上与蹲几乎相同，
  会被判成蹲下；反过来深蹲但躯干完全竖直也可能被归到坐/空。阈值必须按甲方机位重标。
- 遮挡/出画：关键点置信度掉到 0.3 以下时该点退出计算，角度会变 NaN，
  此时 `state` 判为不成立（宁可漏判）。≤300ms 的外推只用于**保持连续性**，不用于计数。
- 手部精细动作（拧、插、拔）不在本层能力范围，需要手部关键点模型。
- **腕部 ROI 补检（§六·五）解决的是「看不见手」，不保证手型准确**：远景/侧对时手势仍会退化为
  `unknown`；左手/右手由姿态腕点纠正在 ROI 与整帧两条路径上统一执行，不采信 MediaPipe 在
  「自拍镜像输入」假设下的 handedness（原始值见 `handedness_raw`）。
- **单张图片没有时间窗**：页面把同一帧重复喂 12 次让 Hold/streak 收敛，姿态、手臂动作、手势可用；
  计数这类需要运动的动作在单帧上不成立（也不应假装成立）。
- **只有上半身**时站/坐/蹲/躺都缺少膝、踝证据，`posture` 不猜站/坐/蹲；肩+髋可见时只输出
  `upper_upright` / `upper_lean`（页面标「推断」），髋也不可见时为 `null`。坐姿但躯干挺直会命中
  上半身直立——这是「躯干朝向」，不是「站立」。
- **多人**：MediaPipe PoseLandmarker 在 **VIDEO 模式只返回 1 个人**（实测 `numPoses=2` 时
  30 帧的 `max_persons` 恒为 1；**IMAGE 模式能返回多人**，同一张双人图 `poses=2` 得到 2 个框）。
  所以多人判定走 IMAGE 模式逐帧推理 + 自研跟踪器（`track.js`），每人一套独立的信号/动作状态机
  （`multi.js` 的 `PersonPipelines`），而不是 VIDEO 模式的单人结果。
  多人画面里的手部按腕点距离归属到各 track；整帧漏检时的腕部 ROI 补检按预算给面积最大的
  前 N 人做（主目标优先，默认 2 人），避免每多一人就多付一次推理。
