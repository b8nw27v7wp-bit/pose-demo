# 数据契约 · frame.jsonl v0

所有感知模型的输出都必须映射成这个结构。下游的信号层、规则层、可视化、回放只认这个结构 ——
**换模型只改 adapter，不动下游**。

> 当前初始版只接了 **MediaPipe Pose（`mediapipe33`）**；RTMPose / ViTPose / Halpe 的映射表
> 是计划中的扩展，`kpt.js` 里还没有。本文其余字段在当前实现里都已生效。

## 一条记录

```jsonc
{
  "ts": 1585,                       // 毫秒，单调递增（当前实现用 performance.now；服务端将来用单调时钟）
  "video_time": 0.93,               // 媒体播放秒数；摄像头为 null。单次播放内单调，用于写 labels 的 startSec/endSec
  "objects_ts": 900,                // 可选：本帧 objects 是哪次检测产生的（毫秒）。设备框的时序确认靠它
                                    // 区分「新检测」与「两次检测之间沿用的上一帧结果」；旧导出没有 → 不过滤
  // 多人模式导出**全部判定人员**（每人一条）；单人模式仍是 1 个元素，字段不变。
  // 每条记录里的 signals/actions 仍是主目标（面积最大者）的判定。
  "persons": [
    {
      "track_id": 0,                // 无人跟踪时恒为 0
      "track_uid": 7,               // 可选：本条轨迹的 uid（同一轨迹对象生命周期内不变；跨 id 继承尚未实现）
      "bbox": [20.2, 333, 101.9, 737],   // 像素 [x1,y1,x2,y2]
      "kp_format": "mediapipe33",   // 声明式：见下方格式表
      "kp": [[65.1, 342.2, 1], ...],// 13 个点，顺序见 kpt.js 的 KPT，像素坐标 + 置信度
      "kp_head": [[65.1, 300.2, 0.99], ...], // 可选：9 个头部点（鼻/眼/耳，顺序见 kpt.js 的 HEAD_KPT），像素 + 可见度；旧导出没有它时 PPE 退回鼻尖
      "kp_world": [[0.02, -0.48, 0.1], ...], // 可选：MediaPipe worldLandmarks，33 点米制 3D
      "scale": 127.22,              // 尺度锚点，像素：肩中点↔髋中点距离（躯干长）
      "score": 0.94,                // 该人画面内关键点的平均置信度（出画的点不计入）
      "frame_w": 484, "frame_h": 272 // 可选：帧尺寸。operating 的归一化 ROI 离线回放需要它
    }
  ],
  "signals": {                      // 信号层输出（可重算，落盘便于回放与调试）
    "knee": 162.9,                  // 判定实际使用的膝角（有 world 时可能是 3D）
    "knee_2d": 162.9,               // 2D 对照（与 3D 并行导出）
    "knee_3d": 175.1,
    "uprightness": 1,               // 躯干直立度 cos，站立≈1，躺平≈0
    "uprightness_2d": 1,
    "uprightness_3d": 0.99,
    "leg_vertical": 1.29,           // 踝中点在髋中点下方的距离 / scale
    "leg_vertical_2d": 1.29,
    "leg_vertical_3d": 1.91,        // 注意：3D 用 scale_world，量纲与 2D 不同
    "scale_world": 0.48,            // 世界躯干长（米）
    "legs_visible": true,           // 膝角与腿竖直比是否都有值（false = 站/坐不可判）
    "upper_body": false,            // 肩+髋可信、腿不足：动作层据此判上半身直立/前倾
    "knee_vel": -12.4,              // 角速度（度/秒）
    "angle_source": { "knee_L": "3d", "knee_R": "3d", "elbow_L": "2d", "...": "..." },
    "extrapolated": [],             // 本帧按最后速度外推的点
    "bones_ok": { "foreArm_L": true, "thigh_R": false, "...": true },
    // 操作设备：ROI 是否配置 + 手/肘判据的逐侧原始布尔（动作层的 operating 还要过 800ms 保持窗）
    "operating_roi": true,
    "operating_L": false, "operating_R": true,
    "operating_elbow_L": false, "operating_elbow_R": false,
    "operating_any": true,
    "operating_equipment": false,   // 本帧是否有设备检测框（false=operating 退回 ROI）
    // 设备框的三段计数：raw=检测器本帧检出 → confirmed=通过时序确认 → used=过 ROI 后参与判定
    "operating_boxes_raw": 1, "operating_boxes_confirmed": 1, "operating_boxes_used": 1,
    // 为什么没判成 operating：ok/no_equipment/no_arm/no_elbow/low_shoulder/head_near/
    // person_invalid/person_not_upright/reach_low/elev_low/elev_high/not_near/no_grip
    "operating_gate": "not_near", "operating_gate_L": "not_near", "operating_gate_R": "no_arm",
    "operating_upright_box": true,
    "operating_validity": null,     // 开启 requireValidity 时为 {enabled,ok,area_ratio,...,reasons}（门会自动启用）
    // 多边形/多区域 ROI 的诊断（rect/旧导出为 null/0）
    "operating_roi_mode": "polygon",   // none|rect|polygon
    "operating_roi_zones": 2,
    "operating_roi_zone": "panel",     // 本帧腕/肘命中的 zone id；用设备框时为 null
    // 在设备旁（上下文）：人体框落在「设备框或 ROI」里的比例（取较大值）/ 是否成立（≥minOverlap 且两肩可见）
    "near_equipment": false,
    "near_equipment_overlap": 0.42,
    "near_equipment_zone": "panel",    // 多边形 ROI 重叠最大的 zone id
    "near_equipment_source": "polygon",// equipment|rect|polygon|null
    "near_equipment_validity": null    // 开启 validity 时为 {enabled,ok,area_ratio,...,reasons}
  },
  "actions": {                      // 规则层输出
    "posture": "stand",             // stand|sit|upper_upright|upper_lean；连髋都不可见时为 null。躺卧/下蹲已下线
    "flags": {
      "armRaised": false, "bothHandsUp": false, "waving": false, "crossed": false,
      "onHips": false, "armsOpen": false, "handAtHead": false, "oilSample": false,
      "reaching": false, "carrying": false, "operating": false, "pointing": false,
      "armFront": false, "armSide": false,
      // 逐侧粒度：单手动作额外给出是哪只手；聚合 flag 保持旧语义
      "armRaisedL": false, "armRaisedR": false,
      "wavingL": false, "wavingR": false,
      "reachingL": false, "reachingR": false,
      "pointingL": false, "pointingR": false,
      "handAtHeadL": false, "handAtHeadR": false,
      "oilSampleL": false, "oilSampleR": false,
      "carryingL": false, "carryingR": false,
      "operatingL": false, "operatingR": false,
      "nearEquipment": false
    },
    "reps": { "clap": 0, "grasp": 0 },   // 深蹲/俯卧撑计数已下线
    // 判定不可靠的原因（不是动作）：低置信 / 外推 / 骨骼异常 / 角度坏点
    // （side_switched 随深蹲/俯卧撑计数一起下线，不再产出）
    // 含义与对判定的影响见 docs/signals.md §三·九
    "unreliable": []
  },
  "hands": [                        // 手部（可选，独立模型）
    {
      "handedness": "Left",         // 被识别者自己的左右手；腕部 ROI 补检时由腕点所在侧决定
                                    // （MediaPipe 的 handedness 假设自拍镜像输入，普通视频会反过来）
      "shape": "open",              // 稳定后的手势（见 handshape.js）：
                                    // fist|open|victory|pointing|thumbs_up|ok|gun|rock|unknown
      "shape_raw": "open",          // 本帧原始分类，未过 HandShapeStabilizer
      "score": 0.96,
      "orient": { "side": 0.1, "flat": 0.7, "facing": "front" },  // facing: front|edge|unknown
      "spread": 42.5,               // 食指-小指扇开角（度），只作辅助
      "bbox": [222, 114, 264, 150],
      "kp": [[x, y], ...]           // 21 点，mediapipe21
    }
  ],
  // —— 可选：多人 / 物体检测（关闭时为空数组）——
  // 只有打开「多人」或「物体」时才有内容；老数据没有这两个字段，评估器按"无"处理。
  "verdicts": [                     // 每人的判定（含主目标）；主目标的判定同时在上面 signals/actions 里
    {
      "track_id": 2,                // 跟踪器给的稳定 id（丢失 1.5s 内不变；超时后是新 id）
      "track_uid": 7,               // 可选：与 persons[] 同源，原样透传；缺失表示导出侧还没有 uid
      "bbox": [20.2, 333, 101.9, 737],
      "posture": "stand",
      "frozen": false,
      "flags": { "armRaised": false, "...": false },
      "reps": { "clap": 0, "grasp": 0 },   // 深蹲/俯卧撑计数已下线
      // 该 track 被归属到的手（与帧级 hands 同结构；没有就是空数组）。
      // 几何（kp/scale）只在 persons[] 里存一份，这里不重复。
      "hands": [ { "handedness": "Left", "shape": "fist", "...": "..." } ],
      "ppe": {                      // 物体检测关闭时为 null
        "helmet": { "state": "missing",   // worn|missing|unknown
                    "alert": "violation", // none|suspect|violation（missing 持续 ≥ minMs 才升级）
                    "streak_ms": 3200,    // 连续 missing 的累计时长；unknown 时暂停不清零
                    "reason": "未戴",      // 可选：人可读原因（旧版就有）
                    "reason_code": "config_mismatch", // 可选：no_positive|config_mismatch|occluded
                    "source": "face",      // 可选：face|nose|bbox（头部区域来源）
                    "box": [200, 80, 280, 160] }, // 可选：头部区域像素框
        "glove":  { "state": "unknown", "alert": "none", "streak_ms": 0,
                    "reason_code": "occluded",
                    // 可选：逐侧几何诊断；没有手时 source=wrist
                    "L": { "state": "worn", "alert": "none", "streak_ms": 0,
                           "source": "hand", "side_from": "slot", "box": [90, 200, 130, 240] },
                    "R": { "state": "unknown", "alert": "none", "streak_ms": 0,
                           "source": "wrist", "side_from": "pose", "box": [150, 200, 190, 240] } }
      }
    }
  ],
  "objects": [                      // 物体检测原始输出（像素框，与 person.bbox 同口径）
    { "label": "person", "score": 0.87, "box": [38, 10, 202, 515] }  // label 来自模型 label map，可能为 null
  ]
}
```

> `hands[].shape` 是**稳定后**的结果，动作层（以及离线 `replay`）看到的就是它；
> `shape_raw` 保留逐帧分类，用于复查稳定器是否把结果拖慢。
> 手势去抖（`HandShapeStabilizer`）按 `track_id` 隔离：每一帧先把手归属到人，再推进
> 该 track 自己的 L/R/U 稳定器，避免 A 的连续手势把 B 的候选计数带满（R12-2）。
> 单人道固定用 track 0，结果与旧版逐位一致；多人时未归属到任何人的手只有 `shape_raw`，
> `shape` 不做去抖（它们不进任何人的动作层）。
> `unknown` 表示判不出来，不是「张开」——但动作层目前只区分「闭合/非闭合」，这一点见已知限制。
> 离线评估器的手势指标（`action:"gesture"`）读的也是 `shape`；`orient.facing === "edge"`（手掌侧对）
> 的帧会被当作弃权，不计入手势 recall 的分母（`docs/eval.md`）。
>
> 全身/远景构图里整帧检不到手时，页面会用姿态腕点裁图补检（`web/js/handroi.js`）；
> 这类结果的 `handedness` 由腕点所在侧决定，不采信模型在「自拍镜像输入」假设下的输出。
> 多人时补检按面积给前 `min(perception.multi.maxPersons, signals.hand.roi.maxPersonsPerFrame)`
> 人做（主目标优先），`scale < signals.hand.roi.minScalePx` 的人跳过；每条补检结果在内部带
> `owner_track_id`，只归属给裁出它的那个人（不进导出），同一 ROI 结果不会被两个人各用一次。
> `actions.unreliable` 是逐帧的可靠性标记，不是动作。看失败段时先看它，
> 用来区分「动作没做出来」和「这一帧被判为不可靠（弃权）」。

## 四条硬规矩

1. **感知层不产出语义**。adapter 不知道「深蹲」是什么，只输出坐标。
2. **距离必须带尺度锚点**。2D 距离写成 `距离 / scale`，3D 距离写成 `距离 / scale_world`，
   禁止直接用像素阈值，也禁止把两种 scale 混用。
3. **kp_format 声明式**。转换表在 `kpt.js`，新增模型只需加一个映射，不写分支判断。
4. **3D 是可选的**。有 `kp_world` 时信号层可走 3D，没有就退回 2D（`docs/signals.md` §一·五）；
   下游不允许假设 world 一定存在。

## 坐标与单位

| 量 | 单位 | 说明 |
|---|---|---|
| `kp[][0..1]` | 像素 | 相对原始视频分辨率（不是 CSS 尺寸），原点左上 |
| `kp[][2]` | 0~1 | 置信度；< 0.3 的点不参与滤波与角度计算 |
| `kp_head[][0..1]` | 像素 | 可选：9 个头部点（鼻/眼/耳），供 PPE 头部区域使用 |
| `kp_head[][2]` | 0~1 | 头部点的 MediaPipe visibility |
| `kp_world[][0..2]` | 米 | MediaPipe worldLandmarks：原点髋中心，**y 向下为正** |
| `scale` | 像素 | 躯干长；2D 距离阈值的除数（保持像素以兼容既有数据） |
| `scale_world` | 米 | 世界躯干长；3D 距离/比值的除数 |
| `ts` | 毫秒 | 单调递增；同一帧内所有字段共用 |

## kp_format 对照

| kp_format | 点数 | 来源 | 状态 |
|---|---|---|---|
| `mediapipe33` | 33（内部取 13） | MediaPipe PoseLandmarker | **已实现**，浏览器 Demo 默认 |
| `coco17` | 17 | RTMPose / ViTPose | 计划中（`kpt.js` 尚无映射表） |
| `halpe26` | 26 | RTMPose Halpe | 计划中（含颈、髋，判弯腰更好） |

内部统一骨架 = `KPT` 的 13 点（COCO-17 子集）：鼻、双肩、双肘、双腕、双髋、双膝、双踝。
新增格式时在 `kpt.js` 的 `MP_INDEX` 旁加一张映射表即可。

## 记录与导出

帧数上限按导出模式取（`multi.js` 的 `LOG_LIMITS`）：**单人 20000 帧，多人 6000 帧**
（多人每帧含全部 persons 的关键点，体积随人数线性增长；PLAN §18.5 D3）。溢出时按块丢弃 10%。
上限与实际模式写进 meta 的 `log_limit` / `export_mode`，评估器据此判断帧被截断是否正常。
导出为 **JSONL**：

```
第一行：{"exported_at":"...","schema":"frame.jsonl v0","kp_format":"mediapipe33",
        "model":"full","delegate":"GPU","hand_model":"hand_landmarker","infer_fps":15,
        "profile":"refuel","profile_model":"full","params_hash":"fnv1a:1a2b3c4d",
        "params":{...},"fps":14.4,"frame_count":562,
        "log_limit":20000,"export_mode":"single",
        "objects":{"backend":"onnx","model":"ppe_smoke.onnx","inputSize":320,
                   "modelHash":"9f2c…","labelsHash":"fnv1a:1a2b","manifestOk":true}}
后续每行：一条帧记录（上面那种结构）
```

难例导出（页面「判错了」）用同一格式，meta 额外带：

```jsonc
"hardcase": {
  "click_ts": 123456.7,       // performance.now，与帧 ts 同基准
  "before_ms": 3000,          // 窗口 = 点击前 3s + 之后 2s
  "after_ms": 2000,
  "action": "grasp",          // 用户选的动作：正例动作 id/flag、none、noArm、或 !动作（反例）
  "detected": { "posture": "stand", "flags": {...}, "reps": {...} }  // 点击时的判定快照
}
```

> `action` 原样写进草稿 label 的 `segments[].action`。`none` = 整帧空镜（姿态和手臂都不许有）；
> `!armRaised` = 只是不应出现举手（站着是允许的）；`noArm` = 姿态不限但不能有手臂动作。
> 三种反例的差别见 `docs/eval.md`。

配套的 `hardcase-*.labels.json` 与普通 labels 相同（`startSec/endSec` 或 `start/end`），
可直接被 `evaluate.mjs` 读取。

### meta 字段（首行，只增不改）

| 字段 | 含义 | 为什么必须记 |
|---|---|---|
| `schema` | 契约版本，当前 `frame.jsonl v0` | 解析器据此分支；只加可选字段不升版本 |
| `model` | 姿态模型档位 `full` / `heavy` / `lite` | 各档关键点噪声不同，阈值不能混用 |
| `delegate` | `GPU` / `CPU` | 同一档位在不同后端下结果也可能有细微差异 |
| `hand_model` | 手部模型文件名；未加载为 `null` | 手势结论要能追溯到手部模型 |
| `infer_fps` | 推理帧率上限（10/15/30） | 15 fps 下最短持续时间的量化粒度与 30 fps 不同 |
| `profile` / `profile_model` | profile 名 / 它声明校准所用的模型档位 | 判断阈值是否被用在错误的档位上 |
| `params_hash` | 生效参数的 FNV-1a 指纹 | 比较两份数据是否同一套阈值，不用 diff 整份 params |
| `params` | profile 的差分覆盖项（不是全量） | 事后能还原改了哪些键 |
| `fps` / `frame_count` | 实测帧率 / 帧数 | 数据完整性检查 |
| `log_limit` | 本次导出允许保留的最大帧数（单人 20000 / 多人 6000） | 帧数达到上限时是设计内截断，不是导出失败。按录制时的模式写，点「停止」后再导出也不会变 |
| `export_mode` | `single` / `multi` | 决定 `persons[]` 是 1 人还是全部判定人员；评估器据此分组。录制期间冻结（一旦出现多人判定帧即为 `multi`） |
| `objects` | 物体检测后端/模型/输入尺寸/权重哈希/类别哈希/清单是否通过；关闭时为 `null` 或缺省 | PPE 指标跨模型不可比；`--baseline` 用它拒绝跨模型比较。MediaPipe 后端没有 sidecar，`modelHash` 为 `null` |

`params_hash` 由 `params.js` 的 `paramsHash()` 生成：先 `resolveParams()` 合并默认值，再按键排序序列化后哈希。
**同样的参数写成不同的键顺序，指纹必须相同**；数值变一个，指纹就变。

为什么是 JSONL 而不是一个大 JSON 对象：20000 帧的整份 `JSON.stringify` 实测产生 40MB 字符串、
峰值堆 184MB、阻塞主线程约 300ms。按行导出后浏览器分块拼 Blob，主线程只处理 500 行一块。

`evaluate.mjs` 直接读这个格式：首行 meta 会被收进 `frames.meta`（不参与信号复算），
报告里回显 `model`/`delegate`，并在 `profile_model` 与数据实际模型不一致时警告。
也兼容旧版 `{frames:[...]}` 与裸数组。

**`video_time` 必须单调**（单次播放内）：labels 的 `startSec/endSec` 按它映射到帧。
页面检测到回绕（循环播放或手动拖回）会停止继续记录；旧的多圈导出里 `evaluate.resolveRange`
会拒绝秒数标注，要求改用 `start/end`（ts），自动标注也会在回绕素材上退回 `ts`。
摄像头录制的 `video_time` 为 `null`，标注一律用 `ts`。

将来的服务端引擎应使用同一落盘格式（一行一条 JSONL），便于 `jq` 与逐帧回放；本版只有浏览器侧实现。

## persons 里的 kp_world

`kp_world` 是 MediaPipe 的米制世界坐标（33 点，原点在髋中心，y 轴向下为正）。

**必须导出**：动作层的举手判定在 `has_world` 为真时用 3D 抬臂角，为假时退回 2D。
漏掉 `kp_world` 会让离线评估永远走 2D，报告的结论就不是页面实际执行的规则。

## 多人记录的口径

- `meta.export_mode = "multi"` 时 `persons[]` 是**全部判定人员**（不是只有主目标）；
  `signals` / `actions` 仍只描述主目标，逐人结果看 `verdicts[]`。
- 几何（`kp` / `kp_head` / `kp_world` / `scale` / `score`）**只在 `persons[]` 里存一份**；
  `verdicts[]` 通过 `track_id` 关联，不重复存，避免导出体积翻倍。`kp_head` 可选
  （9 点），旧导出没有它时 PPE 头部区域退回鼻尖。
- `verdicts[].hands` 是该 track 被归属到的手（与帧级 `hands[]` 同结构）；
  帧级 `hands[]` 仍是整帧检出的全部手，供归属与手势评估重算。
- `track_id` 在跟踪器丢失超过 1.5s 后会变化；`track_uid`（若存在）由跟踪器在轨迹创建时分配，
  **同一轨迹对象生命周期内稳定**，但跟踪器超时后重建的是新 uid（跨 id 的 `linkAcrossIds` 尚未实现）。
  导出层只透传、不分配；评估器按 `track_id` 分组，`label.track` 优先按 `track_uid` 解析
  （找不到再退回 `track_id`），PPE 计时也用它做跨 id 的关联锚点。
- 单人模式（`export_mode = "single"`）`persons[]` 恒为 1 个元素、字段不变；
  `verdicts[]` 只多出可选字段：`hands`（没有手时为空数组）、`track_uid`（有才写）、
  `ppe.*.reason/reason_code`（有才写），旧字段与旧版逐字一致。
