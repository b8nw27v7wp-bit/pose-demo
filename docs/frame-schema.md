# 数据契约 · frame.jsonl v0

所有感知模型（MediaPipe / RTMPose / 将来的任何模型）的输出都必须映射成这个结构。
下游的信号层、规则层、可视化、回放只认这个结构 —— **换模型只改 adapter，不动下游**。

## 一条记录

```jsonc
{
  "ts": 1585,                       // 毫秒，单调递增（浏览器用 performance.now，服务端用单调时钟）
  "video_time": 0.93,               // 媒体播放秒数；摄像头为 null。单次播放内单调，用于写 labels 的 startSec/endSec
  "persons": [
    {
      "track_id": 0,                // 无人跟踪时恒为 0
      "bbox": [20.2, 333, 101.9, 737],   // 像素 [x1,y1,x2,y2]
      "kp_format": "mediapipe33",   // 声明式：见下方格式表
      "kp": [[65.1, 342.2, 1], ...],// 13 个点，顺序见 kpt.js 的 KPT，像素坐标 + 置信度
      "kp_world": [[0.02, -0.48, 0.1], ...], // 可选：MediaPipe worldLandmarks，33 点米制 3D
      "scale": 127.22,              // 尺度锚点，像素：肩中点↔髋中点距离（躯干长）
      "score": 0.94                 // 该人的平均关键点置信度
    }
  ],
  "signals": {                      // 信号层输出（可重算，落盘便于回放与调试）
    "knee": 162.9,                  // 判定实际使用的膝角（有 world 时可能是 3D）
    "knee_2d": 162.9,               // 2D 对照（R3 起与 3D 并行导出）
    "knee_3d": 175.1,
    "uprightness": 1,               // 躯干直立度 cos，站立≈1，躺平≈0
    "uprightness_2d": 1,
    "uprightness_3d": 0.99,
    "leg_vertical": 1.29,           // 踝中点在髋中点下方的距离 / scale
    "leg_vertical_2d": 1.29,
    "leg_vertical_3d": 1.91,        // 注意：3D 用 scale_world，量纲与 2D 不同
    "scale_world": 0.48,            // 世界躯干长（米）
    "knee_vel": -12.4,              // 角速度（度/秒）
    "angle_source": { "knee_L": "3d", "knee_R": "3d", "elbow_L": "2d", "...": "..." },
    "extrapolated": [],             // 本帧按最后速度外推的点
    "bones_ok": { "foreArm_L": true, "thigh_R": false, "...": true }
  },
  "actions": {                      // 规则层输出
    "posture": "stand",
    "flags": {
      "armRaised": false, "bothHandsUp": false, "waving": false, "crossed": false,
      "onHips": false, "armsOpen": false, "handAtHead": false,
      "reaching": false, "carrying": false, "pointing": false,
      "armFront": false, "armSide": false
    },
    "reps": { "squat": 0, "pushup": 0, "clap": 0, "grasp": 0 }
  },
  "hands": [                        // 手部（可选，独立模型）
    {
      "handedness": "Left",         // 被识别者自己的左右手
      "shape": "open",              // 稳定后的手势（见 handshape.js）：
                                    // fist|open|victory|pointing|thumbs_up|ok|gun|rock|unknown
      "shape_raw": "open",          // 本帧原始分类，未过 HandShapeStabilizer
      "score": 0.96,
      "orient": { "side": 0.1, "flat": 0.7, "facing": "front" },  // facing: front|edge|unknown
      "spread": 42.5,               // 食指-小指扇开角（度），只作辅助
      "bbox": [222, 114, 264, 150],
      "kp": [[x, y], ...]           // 21 点，mediapipe21
    }
  ]
}
```

> `hands[].shape` 是**稳定后**的结果，动作层（以及离线 `replay`）看到的就是它；
> `shape_raw` 保留逐帧分类，用于复查稳定器是否把结果拖慢。
> `unknown` 表示判不出来，不是「张开」——但动作层目前只区分「闭合/非闭合」，这一点见已知限制。
> 离线评估器的手势指标（`action:"gesture"`）读的也是 `shape`；`orient.facing === "edge"`（手掌侧对）
> 的帧会被当作弃权，不计入手势 recall 的分母（`docs/eval.md`）。

## 三条硬规矩

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
| `kp_world[][0..2]` | 米 | MediaPipe worldLandmarks：原点髋中心，**y 向下为正** |
| `scale` | 像素 | 躯干长；2D 距离阈值的除数（保持像素以兼容既有数据） |
| `scale_world` | 米 | 世界躯干长；3D 距离/比值的除数 |
| `ts` | 毫秒 | 单调递增；同一帧内所有字段共用 |

## kp_format 对照

| kp_format | 点数 | 来源 | 备注 |
|---|---|---|---|
| `mediapipe33` | 33（内部取 13） | MediaPipe PoseLandmarker | 浏览器 Demo 默认 |
| `coco17` | 17 | RTMPose / ViTPose | 服务端引擎用 |
| `halpe26` | 26 | RTMPose Halpe | 含颈、髋，判弯腰更好 |

内部统一骨架 = `KPT` 的 13 点（COCO-17 子集）：鼻、双肩、双肘、双腕、双髋、双膝、双踝。
新增格式时在 `kpt.js` 的 `MP_INDEX` 旁加一张映射表即可。

## 记录与导出

Demo 里最多保留 20000 帧（`app.js` 的 `MAX_LOG`，溢出时按块丢弃 10%），导出为 **JSONL**：

```
第一行：{"exported_at":"...","schema":"frame.jsonl v0","kp_format":"mediapipe33",
        "model":"lite","delegate":"GPU","hand_model":"hand_landmarker","infer_fps":15,
        "profile":"fitness","profile_model":"lite","params_hash":"fnv1a:1a2b3c4d",
        "params":{...},"fps":14.4,"frame_count":562}
后续每行：一条帧记录（上面那种结构）
```

难例导出（页面「判错了」）用同一格式，meta 额外带：

```jsonc
"hardcase": {
  "click_ts": 123456.7,       // performance.now，与帧 ts 同基准
  "before_ms": 3000,          // 窗口 = 点击前 3s + 之后 2s
  "after_ms": 2000,
  "action": "squat",          // 用户选的动作：正例动作 id/flag、none、noArm、或 !动作（反例）
  "detected": { "posture": "stand", "flags": {...}, "reps": {...} }  // 点击时的判定快照
}
```

> `action` 原样写进草稿 label 的 `segments[].action`。`none` = 整帧空镜（姿态和手臂都不许有）；
> `!onHips` = 只是不应出现叉腰（站着是允许的）；`noArm` = 姿态不限但不能有手臂动作。
> 三种反例的差别见 `docs/eval.md`。

配套的 `hardcase-*.labels.json` 与普通 labels 相同（`startSec/endSec` 或 `start/end`），
可直接被 `evaluate.mjs` 读取。

### meta 字段（首行，只增不改）

| 字段 | 含义 | 为什么必须记 |
|---|---|---|
| `schema` | 契约版本，当前 `frame.jsonl v0` | 解析器据此分支；只加可选字段不升版本 |
| `model` | 姿态模型档位 `lite` / `full` | 两档关键点噪声不同，阈值不能混用 |
| `delegate` | `GPU` / `CPU` | 同一档位在不同后端下结果也可能有细微差异 |
| `hand_model` | 手部模型文件名；未加载为 `null` | 手势结论要能追溯到手部模型 |
| `infer_fps` | 推理帧率上限（10/15/30） | 15 fps 下最短持续时间的量化粒度与 30 fps 不同 |
| `profile` / `profile_model` | profile 名 / 它声明校准所用的模型档位 | 判断阈值是否被用在错误的档位上 |
| `params_hash` | 生效参数的 FNV-1a 指纹 | 比较两份数据是否同一套阈值，不用 diff 整份 params |
| `params` | profile 的差分覆盖项（不是全量） | 事后能还原改了哪些键 |
| `fps` / `frame_count` | 实测帧率 / 帧数 | 数据完整性检查 |

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

引擎侧落盘格式相同，一行一条（JSONL），便于 `jq` 与逐帧回放。

## persons 里的 kp_world

`kp_world` 是 MediaPipe 的米制世界坐标（33 点，原点在髋中心，y 轴向下为正）。

**必须导出**：动作层的举手判定在 `has_world` 为真时用 3D 抬臂角，为假时退回 2D。
漏掉 `kp_world` 会让离线评估永远走 2D，报告的结论就不是页面实际执行的规则。
