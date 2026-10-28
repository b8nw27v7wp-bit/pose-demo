# 数据契约 · frame.jsonl v0

所有感知模型（MediaPipe / RTMPose / 将来的任何模型）的输出都必须映射成这个结构。
下游的信号层、规则层、可视化、回放只认这个结构 —— **换模型只改 adapter，不动下游**。

## 一条记录

```jsonc
{
  "ts": 1585,                       // 毫秒，单调递增（浏览器用 performance.now，服务端用单调时钟）
  "persons": [
    {
      "track_id": 0,                // 无人跟踪时恒为 0
      "bbox": [20.2, 333, 101.9, 737],   // 像素 [x1,y1,x2,y2]
      "kp_format": "mediapipe33",   // 声明式：见下方格式表
      "kp": [[65.1, 342.2, 1], ...],// 13 个点，顺序见 kpt.js 的 KPT，像素坐标 + 置信度
      "scale": 127.22,              // 尺度锚点，像素：肩中点↔髋中点距离（躯干长）
      "score": 0.94                 // 该人的平均关键点置信度
    }
  ],
  "signals": {                      // 信号层输出（可重算，落盘便于回放与调试）
    "knee_avg": 162.9,
    "elbow_avg": 114.1,
    "uprightness": 1,               // 躯干直立度 cos，站立≈1，躺平≈0
    "leg_vertical": 1.29            // 踝中点在髋中点下方的距离 / scale
  },
  "actions": {                      // 规则层输出
    "posture": "stand",
    "flags": { "armRaised": false, "waving": false, "crossed": false, "onHips": false, "armsOpen": false },
    "reps": { "squat": 0, "pushup": 0, "clap": 0 }
  },
  "hands": [                        // 手部（可选，独立模型）
    {
      "handedness": "Left",         // 被识别者自己的左右手
      "shape": "open",              // fist|open|victory|pointing|thumbs_up|ok|unknown
      "score": 0.96,
      "bbox": [222, 114, 264, 150],
      "kp": [[x, y], ...]           // 21 点，mediapipe21
    }
  ]
}
```

## 三条硬规矩

1. **感知层不产出语义**。adapter 不知道「深蹲」是什么，只输出坐标。
2. **距离必须带尺度锚点**。任何跨机位可移植的距离都要写成 `距离 / scale`，禁止直接用像素阈值。
3. **kp_format 声明式**。转换表在 `kpt.js`，新增模型只需加一个映射，不写分支判断。

## 坐标与单位

| 量 | 单位 | 说明 |
|---|---|---|
| `kp[][0..1]` | 像素 | 相对原始视频分辨率（不是 CSS 尺寸），原点左上 |
| `kp[][2]` | 0~1 | 置信度；< 0.3 的点不参与滤波与角度计算 |
| `scale` | 像素 | 躯干长；这是**唯一**允许出现在距离阈值里的除数 |
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
        "profile":"fitness","params":{...},"fps":15.3,"frame_count":562}
后续每行：一条帧记录（上面那种结构）
```

为什么是 JSONL 而不是一个大 JSON 对象：20000 帧的整份 `JSON.stringify` 实测产生 40MB 字符串、
峰值堆 184MB、阻塞主线程约 300ms。按行导出后浏览器分块拼 Blob，主线程只处理 500 行一块。

`evaluate.mjs` 直接读这个格式（首行 meta 会被跳过），也兼容旧版 `{frames:[...]}` 与裸数组。

引擎侧落盘格式相同，一行一条（JSONL），便于 `jq` 与逐帧回放。

## persons 里的 kp_world

`kp_world` 是 MediaPipe 的米制世界坐标（33 点，原点在髋中心，y 轴向下为正）。

**必须导出**：动作层的举手判定在 `has_world` 为真时用 3D 抬臂角，为假时退回 2D。
漏掉 `kp_world` 会让离线评估永远走 2D，报告的结论就不是页面实际执行的规则。
