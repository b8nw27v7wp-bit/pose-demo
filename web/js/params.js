// params.js — 阈值参数的唯一定义处
// 为什么单独一层：校准（PLAN §12.3 B/D）必须能把拟合出来的阈值写进 profile 并生效。
// 阈值散落在 signals.js / actions.js 里，拟合结果就只能改源码，无法比较、无法回滚。
//
// profile 文件的格式 = 本结构的一个子集（只写要覆盖的键），见 web/profiles/ 与 docs/eval.md。
// 所有默认值都是"量级参考"，必须用自己的校准数据替换（docs/signals.md §四）。

export const DEFAULT_PARAMS = {
  signals: {
    // 平滑（单位：Hz）
    smoothing: {
      minCutoff: 1.0, beta: 0.05, dCutoff: 1.0,
      angleCutoff: 1.5, angleBeta: 0.02,
      upright: { minCutoff: 1.5, beta: 0.02 },
    },
    scaleMedianFrames: 5,
    // 左右侧选择滞回：另一侧的可信度要高出这么多才换侧。
    // 不设滞回时，两侧可见性在阈值附近抖动会让膝角/肘角在两条腿之间来回跳。
    // 深蹲/俯卧撑计数下线后不再有「换侧中止半程」，换侧只影响后续信号选哪一侧。
    sideHysteresis: 0.15,
    // 关节角突变剔除：角速度超过 maxRate（度/秒）且间隔不超过 maxDtMs 时，
    // 视为单帧坏点（不给滤波器、也不沿用旧值冒充当前）。持续超过 maxDtMs 才接受新值。
    // 用「角速度」而不是固定角度：100ms 内跳 100° 是 1000°/s（真实快速下蹲量级），
    // 33ms 内跳 100° 是 3000°/s（坏点量级）—— 同一个角度差在两种帧率下含义完全不同。
    angleJump: { maxRate: 1500, maxDtMs: 250 },
    visMin: 0.3,          // 单点可见性低于此值 → 依赖它的信号给 NaN
    minScore: 0.45,       // 画面内关键点平均置信度低于此值 → ok=false，动作层冻结
    minTorsoVis: 0.4,     // 肩/髋四点最低可见性
    // 髋不可信（上半身构图 / 贴身机位）时，用肩宽换算躯干长：torso ≈ shoulderWidth × 此值。
    // 实测（MediaPipe world）肩宽 0.315m / 躯干长 0.489m ≈ 1.55；2D 正面视角会更小，
    // 取 1.4 折中。只影响尺度归一化，阈值仍按躯干长拟合。
    shoulderToTorso: 1.4,
    // —— 3D（worldLandmarks）——
    // 默认只开「语义与 2D 直接可比」的两类：关节角、直立度。
    // legVertical / ratios 的量纲相对 2D 有系统性偏移（3D 腿长/躯干 ≈2.0，2D 约 1.3），
    // 先保持 2D 判定、把它们以 *_3d 信号导出，等 R4 用数据重拟合阈值后再切（见 docs/signals.md §一·五）。
    world: {
      enabled: true,          // 总开关；false 时所有信号退回 2D
      angles: true,           // knee_L/R、elbow_L/R、hip_L/R 有 world 时用 3D 夹角
      uprightness: true,      // 躯干向量与重力轴的点积（抗相机倾斜）
      legVertical: false,     // 3D 腿竖直比（量纲与 2D 不同，R4 再开）
      ratios: false,          // reach / hands_close / head / onHips 的距离比值改用世界距离
      // 骨骼长度一致性：每条肢体在 world 下的长度做个体中位数，当前帧偏离 > tolerance 判不可靠。
      // 比 visibility 更能抓住「手在背后、腕点漂到别处」。
      boneCheck: { enabled: true, windowFrames: 60, minSamples: 10, tolerance: 0.2 },
    },
    // 一阶差分：角速度（度/秒）
    velocity: { minCutoff: 3.0, beta: 0.05, minDtMs: 8, maxDtMs: 500 },
    // 短时遮挡外推：可见性掉下去但不超过这个时长时，按最后速度外推并标记 extrapolated
    occlusion: { maxExtrapMs: 300 },
    // 上半身姿态的几何门：人体上半身框通常「高于宽」。横着的框多半是手臂/设备特写
    // 被模型当成人（refuel 样例实测：手+油枪特写 bbox 220×147、scale 100，被凑成躯干）。
    // minAspect = 高/宽 的下限；bbox 缺失时不设门。
    upperBody: { minAspect: 0.9 },
    wave: {
      windowMs: 800,      // 挥手判定回看窗口
      deadzone: 0.10,     // 相邻帧水平位移小于此值（单位 scale）不计翻转
      minFlips: 3,        // 窗口内最少方向翻转次数
      minAmp: 0.25,       // 窗口内最小水平幅度（单位 scale）
    },
    arm: {
      raisedMargin: 0.15,             // 腕高于肩多少 scale 算举手
      crossed: { ySpan: 1.1 },        // 两腕都在肩中点 ±ySpan·scale 内
      // 叉腰：腕贴髋 + 肘外张。少了肘外张这道门，手自然下垂也会命中（腕本来就在髋旁边）
      onHips: { maxDist: 0.65, elbowFlare: 0.22 },
      openWide: { minElev: 55, maxElev: 125, minReach: 0.9 },
      chest: { above: -0.2, below: 0.3 }, // 胸前高度区间（相对肩中点 / 髋中点，单位 scale）
      // 腕到鼻尖 / scale，小于此值算「手在头部附近」。
      // aboveShoulder：腕最多低于肩多少 scale；走路时手臂前摆会经过脸前，只判距离会误报。
      head: { maxDist: 0.55, aboveShoulder: 0.5 },
      // 油样取样（举瓶到眼前对光检查）：在 head 的距离判据上加一道「手在身体前方」。
      // 摸头/扶眼镜是从侧后方靠近，3D 方位角大；取样是对着光看，手在面前。
      // 没有 3D 时方位角是 NaN，退回纯距离判据（与 hand_head 同口径）——宁可少一层
      // 区分度，也不要把动作整段判掉。maxHeadDist 单位同 head.maxDist（腕-鼻尖 / 躯干长）。
      sampling: { maxHeadDist: 0.55, maxAzimuth: 60 },
      // 3D 抬臂角（相对躯干）：0°=手在躯干延长线上（举起），90°=水平，180°=沿身体下垂
      elevTorso: { raised: 75 },
      // 手臂伸出：腕到肩距离 / scale。自然下垂实测 ≈0.84，前伸约 1.5+
      extend: { minReach: 1.25, minElev: 30 },
      // 3D 水平方位角：0°=正前方，±90°=正侧方。用来区分前平举与侧平举。
      // 必须配合「手臂接近水平」才有效：手自然下垂时水平分量接近 0，方位角是噪声
      // minReach：平举时手臂必须基本伸直（3D 腕-肩距离 / 躯干长）。弯着胳膊横在胸前
      // （走路/抱臂）会被 3D 方位角算成水平，但 reach 只有 0.5~0.8，用这道门挡掉。
      azimuth: { frontMax: 35, sideMin: 55, minElev: 60, maxElev: 120, minReach: 0.85 },
      // 持物：手闭合且臂未伸出
      carry: { maxReach: 1.2 },
      // 操作设备（阀门/仪表）：手在设备区域内、肩以下、不是自然下垂。
      // roi 是归一化画面坐标 {x,y,w,h}（0~1）；固定机位把它设成阀门/面板区域。
      // **roi=null 时这个动作不判**：没有设备位置就只剩「伸手」这一条弱证据，
      // 在普通视频里会把拿东西/扶栏杆误报成操作设备（宁可弃权）。
      // minElev=90：0°=手在肩上方，90°=水平，180°=正下方；操作阀门多在 90~180。
      // minShoulderVis 用两肩最低可见度挡住「只看到一只手臂」的误检。
      operating: {
        minReachRoi: 0.65,
        minElev: 90,
        maxElev: 179,
        minShoulderVis: 0.4,
        // 手被设备挡住时用肘兜底：肘在 ROI 内、离肩够远、不是垂在身侧。
        // 肘比整个人框更接近「手臂在设备上」，误报比「人在 ROI 里」低得多。
        minElbowVis: 0.3,
        minElbowReach: 0.35,
        minElbowElev: 60,
        // 肘兜底总开关。2026-11-12 实测油样片：110 个 operating 帧里 67 个是「只有肘」成立的，
        // 80 个连手都没检出——这条兜底在 refuel 上承担了大部分召回，也承担了大部分误报。
        elbowFallback: true,
        // 只有腕点不可用（真的被挡住）时才允许肘兜底。
        // 默认 false（旧行为）；打开后，手可见但张开的帧不会再被肘兜底判成操作。
        elbowFallbackHideWrist: false,
        roi: null,
        // 多边形/多区域 ROI：rois 非空时完全忽略上面的 roi（换机位按设备形状圈）。
        // 每个 zone: { id, points: [[x,y],...] }，归一化 0~1；未配置时保持旧行为。
        rois: [],
        // 设备检测框（可选）：物体检测器输出这些类别时，优先用「腕/肘到框的距离」，
        // ROI 只作检测不到时的兜底。空数组 = 只用 ROI（当前默认，因为还没有阀门模型）。
        equipmentLabels: [],
        equipmentMinScore: 0.35,
        // 点到检测框边缘的距离 / scale；框内为 0。0.35 ≈ 躯干长的 35%。
        equipmentMaxDist: 0.35,
        // 配了 equipmentLabels 但本帧没检出设备框时，是否退回人工 ROI。
        // true（默认）= 旧行为：检测器漏检时仍靠 ROI 判，召回稳，但**没有物体证据**
        //   （硬负例里只要 ROI 里有人走过就会命中；实测见 docs/equipment-detector.md §6）。
        // false = 失败即不判（fail-closed）：这一帧没有设备框就 both operating / near_equipment
        //   都不成立。这是「物体证据」真正生效的开关，代价是检测器漏检直接变 FN。
        equipmentFallbackRoi: true,
        // —— 设备框的时序确认（equipment.js）——
        // 单帧误检不能立刻变成「设备证据」：同一位置要在**两次不同的检测**里都命中才算确认。
        // 1 = 关闭时序确认（旧行为）。检测器隔帧出框/单帧误检多时，2 是性价比最高的一档。
        boxMinHits: 2,
        // 确认过的框消失超过这么久才作废；与 actions.holds 的 maxGap 分工：
        // 这里管「框在不在」，maxGap 管「动作信号断了几帧还算连续」。
        // 硬约束（validateParams 校验）：配了 equipmentLabels 且 boxMinHits>1 时，
        // 必须 boxMaxAgeMs >= perception.objects.intervalMs + 300。检测间隔比框有效期还长时，
        // 两次检测之间的普通帧会先把轨迹过期，下一次检测又从 hits=1 开始，框永远确认不了。
        boxMaxAgeMs: 600,
        // 有 ROI 时，检测框必须与本工位 ROI **相交**才算设备：
        // 背景里别人的阀门/仪表被检出时，不能拿来给当前操作员当证据。
        // 用「相交」而不是「框中心在内」：ROI 是手圈的设备区域，检测框常常跨在边界上，
        // 中心在 ROI 外但压在设备上的框同样有效（refuel 实测 159 个框里 105 个中心在 ROI 外）。
        // 默认关（逐位保持旧行为）；固定机位 + 有 ROI 的场景在 profile 里打开。
        // ROI 未配置或没有帧尺寸时这道门自动跳过（无法换算像素）。
        // 注意：框被 ROI 挡掉后，仍然按 equipmentFallbackRoi 决定要不要退回 ROI。
        boxRequireInRoi: false,
        // 用「腕→肘线段到框的距离」代替「腕点到框的距离」：
        // 手被面板挡住时腕点会漂到设备外，前臂仍然贴着设备。默认关，按场景打开。
        useForearm: false,
        // operating 必须握持（手型属于 signals.hand.closedShapes）：
        // 走过去/扶着东西时手掌是张开的。没有手部数据时判不成立（fail-closed）。
        requireGrip: false,
        // 人形门：人体框面积/高度/出画/肩髋可见性不合格时不判 operating。
        // 阈值复用 signals.arm.nearEquipment.validity（同一套几何门）；
        // 专门挡「手/油枪特写被凑成躯干」这一类误检。
        requireValidity: false,
        // 人形门的另一半：人体框必须「高于宽」（上限用 signals.upperBody.minAspect）。
        // 横着的框多半是手臂/设备特写被模型凑成了人（refuel 实测 220×147、159×59）。
        // refuel 演示片上会更严格：25/66 个 operating 帧的框低于 0.9，按段看是否真掉召回再开。
        requireUprightBox: false,
      },
      // 在设备旁（上下文事件）：只回答「人站在设备区域里」，**不要**把它并进 operating。
      // 曾经把「人体框与 ROI 重叠」当 operating 的兜底，refuel 上 233/249 条判定都成立，太宽。
      // 单独作为两级事件后，它可以补「手被设备挡住」时的上下文，但不代表在操作。
      // minOverlap：人体框面积落在 ROI 内的比例；minShoulderVis：挡掉只检出手臂/设备的特写误检。
      nearEquipment: {
        minOverlap: 0.3,
        minShoulderVis: 0.4,
        // 人体框竖直门：挡掉横向的手臂/设备特写；但也会挡掉「只见手臂」的真作业镜头。
        // refuel 演示片可关掉换取召回，代价是特写误报会变多（见 docs/signals.md）。
        requireUprightBox: true,
        // 人体框有效性门（默认关，保持旧行为）：挡掉过小/满屏/大半出画的「人框」。
        // person.bbox 由全部 33 点取极值，含不可见/出画点，in_frame 天生偏低，
        // 所以 minInFrame 默认只取 0.5；不要在没修 bbox 的前提下收紧。
        validity: {
          enabled: false,
          minAreaRatio: 0.003, maxAreaRatio: 0.9,
          minHeightRatio: 0.15, maxHeightRatio: 1.5,
          minInFrame: 0.5,
          minShoulderVis: 0.4, minTorsoVis: 0.3,
        },
      },
    },
    hand: {
      // 判定为「握住」的手势。ok/gun 是捏取，也算能拿东西
      closedShapes: ['fist', 'ok'],
      // 手型分组（颗粒度：不只分「握没握」，还用具体手势）。
      // 伸手只认张开的手掌；指向只认食指伸出的「指方向 / 手枪」。
      // 指向姿势以前被当成「非闭合」从而同时点亮伸手，这里把两者分开。
      openShapes: ['open'],
      pointShapes: ['pointing', 'gun'],
      // 腕部 ROI 补检：整帧漏检时，以姿态腕点为中心裁一块放大后重检。
      // 全身构图里手只有几十像素，整帧检测实测 0 命中；补检后同一模型 100% 命中。
      // mul = 框边长 / 躯干长；maxCenterOffset = 检出腕点离框中心的最大偏移（占框边长）。
      // 归属判据不是这个偏移量，而是「检出腕点离哪个姿态腕点最近」（hands.js 里做），
      // 这里只是排除离裁图中心太远的框（基本是另一只手/背景）。
      roi: {
        mul: 1.8, minPx: 64, maxPx: 480, maxCenterOffset: 0.6,
        // R12-2：每帧最多给几个人做 ROI 补检（每多一人多一次推理）。默认 2。
        maxPersonsPerFrame: 2,
        // 人的 scale（躯干长，像素）低于此值时不补检：远景裁出来的框全是背景，补检只会烧推理。
        minScalePx: 80,
      },
    },
    grasp: {
      // 拿取状态机的时间窗
      reachToGraspMs: 1500,   // 伸手后多久内合手才算拿取
      minPhaseMs: 120,        // 每阶段最短持续，滤掉单帧抖动
      releaseMs: 200,         // 张手后多久确认「放下」
    },
    gesture: {
      streak: 3,        // 手势要连续命中几帧才切换（治「张开→剪刀手」来回闪）
      // 稳定状态保持多久由 HandShapeStabilizer 的 keepMs（默认 250ms）决定；
      // 之前这里加过一个 edgeKeepMs，但没有任何代码读它，已删除。
    },
    // —— 多人跟踪（track.js）——
    // maxLostMs：人短暂被挡/检出失败时保留 track_id 的时长。太短会频繁换 id（计数清零），
    // 太长会让同一个人在画面里换位后仍占着旧 id 的状态。
    // motion/velAlpha/maxPredictMs：匀速运动模型。两人交叉时只比当前位置容易配反，
    // 用轨迹速度把框外推到当前帧再比。maxPredictMs 限制丢失后还能相信旧速度多久。
    track: {
      maxLostMs: 1500, iouMin: 0.25,
      // 中心距离兜底 gate（单位：身高）。实时播放的 4 序列 A/B 曾显示 0.6→0.8 略好，
      // 但那个测量受丢帧影响，同配置重复跑 ID 切换会在 56~70 之间跳；用 --rate 0.4
      // 慢放逐帧复测（6 序列约 800 对）0.6 与 0.8 都是 72 次，**没有差异**。
      // 保留 0.8：对快速移动/丢帧更宽容，代价是换人时更容易接错一点点。
      centerMax: 0.8,
      // 运动模型默认关：MOT17 A/B 实测（72→107 次切换）反而更差——检测框抖动会被
      // 当成速度。代码保留，profile 可开（motion: true）做对比。
      motion: false, velAlpha: 0.5, maxPredictMs: 500, maxSpeed: 3, motionGapRatio: 1.5,
      // 轻量外观 ReID：bbox 中部 2×2 网格的色相直方图。代码保留，默认关：
      // 慢放逐帧 6 序列 A/B：off 72/810 vs on 81/807，颜色直方图在拥挤/远景里
      // 不够判别，反而会接错人。要试可 profile 里开。
      appearance: false, appearMin: 0.82, appearWeight: 0.5,
    },
    // —— PPE（安全帽/手套，ppe.js）——
    // classes 是**标签名**，必须与检测模型的 label map 对上；写错时 requirePositive
    // 会把全场判成 unknown，而不是「都没戴」——这是刻意的防误报设计。
    ppe: {
      classes: {
        helmet: ['helmet', 'hard_hat', 'hardhat', 'safety_helmet'],
        glove: ['glove', 'gloves', 'hand_glove'],
        // 负类只作为"直接证据"用：模型明确检出没戴，比"没检出正类"更强。
        // 注意 matchLabel 会把 no_/not_/without_ 开头的标签排除出正类匹配。
        noHelmet: ['no_helmet', 'no_hardhat', 'no helmet'],
        noGlove: ['no_glove', 'no_gloves'],
      },
      minScore: 0.35,
      visMin: 0.3,
      headBoxScale: 0.55,   // 头部区域半边长 / 躯干长
      gloveBoxScale: 0.45,  // 腕部区域半边长 / 躯干长
      // 头部区域优先用 9 个脸/耳关键点（kp_head）：鼻尖不可见但耳朵可见时仍能判。
      // 旧导出/测试没有 kp_head 时自动退回鼻尖与旧几何。
      headFace: {
        enabled: true,
        visMin: 0.3,
        minPoints: 2,
        minSpread: 0.12,     // × scale：太窄的两点不足以定中心
        maxPointDist: 1.0,   // × scale：剔除漂移的耳朵
        bothSides: true,     // 左右两侧都要有点；单侧容易把中心拉偏
        shift: 0.25,         // × half：向上覆盖额头/帽檐
        halfMul: 1.0,        // × headBoxScale
      },
      // 手套区域优先用手部 21 点 bbox；手没检出/没归属时退回腕点方框。
      gloveHand: {
        enabled: true,
        pad: 0.15,           // × hand bbox 长边
        minScore: 0,         // hand.score 是 handedness 置信度，不是检出置信度
        maxWristDist: 0.8,   // × scale，与 assignHands 的 maxDist 一致
        fallbackWrist: true,
      },
      // 本场从未检出过该类正例 → 只报 unknown。模型类别名写错时防止满屏误报。
      requirePositive: true,
      // R13-5：物体框归属给人的方式（预留，物体线尚未接线，本轮只加键）。
      // 目标：'center' = 物体框中心落在人的头/腕区域；'exclusive' = 一人一物约束。
      assignment: 'center',
      // R13-10：「本场有正例」的收紧口径。0 = 旧行为（整场 sticky）；
      // >0 时只看最近 positiveWindowMs 内是否至少出现 minPositive 次正例。
      positiveWindowMs: 0,
      minPositive: 3,
      helmet: { minMs: 3000, policy: 'violation' },  // 连续缺失多久算违规
      // 手套默认只报「疑似」：手小、常被遮挡，「没检出」与「没戴」不可区分，
      // 直接进实时违规就是无穷申诉。要升级成违规必须在这里显式改 policy。
      glove: { minMs: 3000, policy: 'suspect' },
    },
  },

  // —— 感知层档位（perception）——
  // 和阈值分开：这两个开关改变的是"跑几个模型"，不是"怎么判"。
  perception: {
    // 多人：关闭时保持原行为（VIDEO 模式 + 只判画面里最大的人）。
    // 打开后改为 IMAGE 模式逐帧独立推理 + 自研跟踪器，代价是每多一个人多一次推理。
    // detConf/presenceConf 默认 0.3（不是单人道 0.5）：远处/被挡的人置信度天然低，
    // 实测同一张双人图 0.5 只回 1 人、0.3 回 2 人。用 mot17-eval 调这两个值时，
    // 把结果和 profile 一起记下来（docs/open-datasets.md）。
    // tiles > 1 时把画面切成 n×n 块分别推理再合并（块间重叠 tileOverlap）：
    // 远处小目标在整帧缩放下会消失，平铺等于把人放大。成本 n² 倍推理，默认关。
    multi: {
      enabled: false, maxPersons: 3, detConf: 0.3, presenceConf: 0.3,
      tiles: 1, tileOverlap: 0.2,
      // R12-3：平铺策略。'off' = 只看 tiles；'always' = 每帧平铺；
      // 'auto' 预留给「连续 N 帧检出 <1 人时启用平铺一段」的自适应逻辑（本轮只加键）。
      tileMode: 'off',
    },
    // 单人道漏检补救：VIDEO 模式没检出人时，用 IMAGE 模式（detConf 0.3）在同一帧补检一次。
    // VIDEO 模式的模型内跟踪在正常帧上更稳，所以只在漏检帧付这次推理，不替换主路径。
    // 典型收益：半身/贴边/小目标（工人被设备挡住一半）从 0 人变成能判上半身动作。
    // fallbackMinScore 用 toPersons 的平均可见度（画面内点）过滤「把设备当人」的误检。
    single: {
      fallback: true,
      fallbackMinScore: 0.45,
      // 单人道主目标：largest（默认，面积最大）| torso（躯干长最大）| upright（优先高宽比正常）
      // 近景/特写里「面积最大的人」可能是被凑成人的手和设备；换机位前不要凭感觉改。
      target: 'largest',
      targetMinAspect: 0.9,
    },

    objects: {
      enabled: false,                 // 物体检测（PPE 需要它；默认关，省 GPU）
      // backend：'mediapipe' = Tasks .tflite（自带 label map）；'onnx' = 自训 YOLOv8
      // 导出的 ONNX（ORT Web 推理，类别名必须由下面的 labels 按训练时的顺序给出）。
      backend: 'mediapipe',
      model: 'efficientdet_lite0.tflite',
      // 默认 CPU：efficientdet_lite0 的 GPU delegate 实测在第一次推理就从 wasm 抛
      // "divide by zero"，而且会把这个 wasm 运行时搞坏（之后再建任何实例都挂）。
      // 换自训模型并确认支持 GPU 后，再在 profile 里显式写 'GPU'。
      delegate: 'CPU',
      maxResults: 8,
      scoreThreshold: 0.35,
      // 以下只对 onnx 后端生效
      labels: [],                     // 类别名，顺序 = 训练时 data.yaml 的 names 顺序
      inputSize: 320,                 // 导出 ONNX 时的 imgsz（letterbox 到正方形）
      iouThreshold: 0.45,             // 逐类别 NMS 的 IoU 阈值
      // 物体检测的最小间隔。PPE 是 3 秒级时序判定，不需要每帧都检：
      // MediaPipe/efficientdet 同步推理一次 ~54ms，30fps 下每帧跑会把吞吐从 28fps
      // 拖到 11fps；150ms（约 6.7Hz）足够，主循环只跳过检测、沿用上一帧的框。
      intervalMs: 150,
      // R13-1：没有模型清单（类别顺序/输入尺寸/许可）时拒绝加载自训权重，
      // 避免「权重换了、类别顺序没换」静默产出错误标签。物体线读这个键。
      requireManifest: true,
      // R13-3：只在物体 ROI 内推理（预留，物体线尚未接线，本轮只加键）。
      // source：'head'|'person'；expand 为 bbox 外扩倍数；minPx 是 ROI 最小边长
      // （太小就退回整帧），maxPerFrame 限制每帧 ROI 数（成本上限）。
      roi: { enabled: false, source: 'head', expand: 1.5, minPx: 96, maxPerFrame: 4 },
    },
  },

  actions: {
    posture: {
      // 只保留站/坐：躺卧与下蹲需要膝、踝同时可见，桌面机位/上半身构图判不了。
      sit: { minMs: 450, streak: 5, kneeGt: 55, kneeLt: 135, uprightnessGt: 0.5, legVerticalLt: 1.05 },
      stand: { minMs: 350, streak: 4, uprightnessGt: 0.8, kneeGt: 150, legVerticalGt: 0.8 },
      // 上半身构图（肩+髋可见、膝/踝不可见）：只判躯干朝向，不冒充站/坐。
      // uprightGt 以上是「上半身直立」，之下到 leanGt 之间是「上半身前倾」；
      // leanGt 以下（躯干接近水平或倒置）不判：可能是躺卧，也可能是髋点漂移。
      // 这两个 id 是**推断**，界面会标「仅上半身可见 · 推断」。
      upper: { minMs: 350, streak: 4, uprightGt: 0.75, leanGt: 0.0 },
    },
    holds: {
      arm: 300, wave: 150, crossed: 400, hips: 400, open: 400,
      handFace: 350, handChest: 350, bothHandsUp: 350,
      reach: 250, carry: 300, point: 250,
      // 操作设备是「持续在做」的事件：800ms 才成立，单帧伸手不计。
      // operatingMaxGap：允许 300ms 内的短暂掉帧/遮挡不重置计时（手腕常被面板挡住）。
      operating: 800,
      // 按实际采样间隔校准：两次有效观测间隔超过它会重置（引擎漏调用也算）。
      // refuel 档用 600ms（回放中位帧间隔 138ms / p90 365ms），300ms 会把长正例段切碎。
      operatingMaxGap: 300,
      // 在设备旁是上下文事件：1s 才成立，避免走过/路过时闪一下
      nearEquipment: 1000,
      // 油样取样是「持续在看」的事件：看一次样瓶通常 2~5s，取 1s 避免抬手擦汗/扶眼镜
      // 这类瞬时动作命中；比 handFace(350ms) 长，是因为它要表达「在做作业」而不是「手在头边」。
      oilSample: 1000,
      // 取样时腕点常被样瓶/自己的手挡住，逐帧判定会断续（实测公开素材上相邻命中间隔
      // 100~500ms）。和 operatingMaxGap 同一套理由：短暂掉帧不重新计时。
      // 不能更大——两段独立动作（看一次、放下、再看）之间的间隔通常 >1s，粘连就失去意义。
      oilSampleMaxGap: 500,
      // 前/侧平举原本是瞬时布尔：走路摆臂会被 3D 方位角的噪声凑成「前平举」，
      // 实测 45 帧里断续命中 41 帧、最长一段仅 250ms。加保持窗把瞬时误报滤掉。
      front: 300, side: 300,
    },
    // adaptiveMs：有历史后，用「半程时长中位数 × adaptiveMinRatio」替代固定 minCycleMs。
    // 挥手/快速鼓掌不再被固定周期判成抖动，慢动作也不会因此漏计（见 docs/signals.md §二）。
    // 没有历史时门槛放宽到 minCycleMs × adaptiveBootstrapRatio，否则真实的快节奏
    // （鼓掌半程约 200ms）第一次就被拒，永远攒不出历史。
    reps: {
      clap: { down: 0.45, up: 1.0, minCycleMs: 400, minHalfMs: 100, adaptiveMs: true, adaptiveWindow: 5, adaptiveMinRatio: 0.5, adaptiveBootstrapRatio: 0.5 },
    },
  },
};

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlain(out[k]) && isPlain(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** 把 profile 覆盖项合到默认参数上。未给出的键保持默认，便于 profile 只写差分。 */
export function resolveParams(overrides = {}) {
  return deepMerge(DEFAULT_PARAMS, overrides);
}

/** 设备框时序确认的推理耗时余量（ms）：boxMaxAgeMs 至少要覆盖 intervalMs + 这个值。 */
export const BOX_MAX_AGE_MARGIN_MS = 300;

/**
 * 参数一致性校验：非法组合在**加载时**报错，而不是让判定静默失效。
 *
 * 目前只有一条硬约束——设备框的时序确认要求框的有效期覆盖检测间隔：
 *   `equipmentLabels` 非空 且 `boxMinHits > 1` 时，`boxMaxAgeMs >= objects.intervalMs + 300`。
 * 违反时，两次检测之间的普通帧会先把轨迹过期，下一次检测又从 hits=1 开始，框永远累计不到
 * `minHits`，operating 会整段丢掉设备证据（审查实测 intervalMs=1000：确认态 328/366 → 4/30）。
 * 300ms 是 ONNX 推理耗时量级；不静默自动放大 maxAge——那会让「框在不在」的语义随配置漂移。
 *
 * 只约束「时序确认真的在用」的组合：没配设备类别、或 boxMinHits=1 时不消费这两条时间。
 *
 * @param {object} overrides profile 覆盖项（与 resolveParams 同一口径）
 * @throws {Error} 组合非法时
 * @returns {object} 合并后的完整参数
 */
export function validateParams(overrides = {}) {
  const resolved = resolveParams(overrides);
  const op = resolved.signals?.arm?.operating || {};
  const labels = Array.isArray(op.equipmentLabels) ? op.equipmentLabels : [];
  const minHits = Number(op.boxMinHits);
  const maxAge = Number(op.boxMaxAgeMs);
  const interval = Number(resolved.perception?.objects?.intervalMs);
  if (!labels.length || !(minHits > 1) || !Number.isFinite(maxAge) || !Number.isFinite(interval)) {
    return resolved;
  }
  const minMaxAge = interval + BOX_MAX_AGE_MARGIN_MS;
  if (maxAge < minMaxAge) {
    throw new Error(
      `参数组合非法：signals.arm.operating.boxMaxAgeMs=${maxAge} 必须 >= `
      + `perception.objects.intervalMs（${interval}）+ ${BOX_MAX_AGE_MARGIN_MS} = ${minMaxAge}。`
      + ' 检测间隔不短于框有效期时，两次检测之间的帧会先把设备框过期，'
      + ' boxMinHits 永远累计不到，operating 会丢掉设备证据。',
    );
  }
  return resolved;
}

/**
 * 合并两份覆盖项（后者覆盖前者），不注入默认值。
 * 用于「profile + 自动拟合结果」这类叠加场景：拟合只写它算出来的键，
 * 其余仍由 profile/默认值决定（R4 的 `--fit-out` 与 LOSO 都走这里）。
 */
export function mergeParams(base = {}, over = {}) {
  return deepMerge(base, over);
}

/**
 * profile 文件的解包：文件形如 {name, note, params:{...}}，也接受裸的参数对象。
 * 页面（app.js）与评估器（evaluate.mjs）必须走同一个函数——
 * 曾经只有页面解包、CLI 没有，导致 `--profile` 静默用默认阈值却仍显示已应用。
 */
export function profileParams(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return isPlain(raw.params) ? raw.params : raw;
}

/** profile 的显示名 */
export function profileName(raw, fallback = 'default') {
  return (raw && typeof raw.name === 'string' && raw.name) || fallback;
}

/** 稳定序列化：键按字典序排列，保证"同一组参数、不同写法"得到同一个字符串。 */
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? String(v);
}

/**
 * 参数指纹（FNV-1a 32 位）。
 * 为什么需要：导出里带一份完整 params 又大又难比，事后想确认"两份数据是不是同一套阈值"
 * 只能人工 diff。指纹让"同阈值"变成一次字符串比较（PLAN §13 R0）。
 */
export function paramsHash(overrides = {}) {
  const s = stableStringify(resolveParams(overrides));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a:${(h >>> 0).toString(16).padStart(8, '0')}`;
}
