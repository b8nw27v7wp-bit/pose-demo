# 全量代码审核（2026-11-20）

范围：`web/js/`（18 个模块）、`web/test/`（评估器与工具链）、`scripts/`（mjs / py）、`serve.py`。
方法：7 个只读子代理分模块审核，主会话逐条对照磁盘当前代码复核；能构造输入的直接复现。
不包含：`web/vendor/`（第三方打包产物）、`web/models/`、`eval-data/`、`runs/`。
**复核列**：✅ = 主会话已对代码复核或复现；🔁 = 子代理已复现，主会话只核了代码路径。

## 结论

- 自动化基线没有回归：`npm test` **1312 项 / 0 失败**（含本次新增的头部参数校验与头部评估自测）。
- 发现 **8 个 P0**（会崩或让评估/判定静默给出错误结论），其中 `evaluate.mjs` 的
  `segmentTrack` 未声明变量已用最小用例复现为 `ReferenceError`。
- 发现 **25 个 P1**（功能可用性 / 指标可信度）与 **10 个 P2**（低危/一致性），
  另有 7 项需要实拍或实跑才能定性，单列在 §五。
- 本轮审核期间**没有修改**上表列出的任何代码；只修了此前一轮审核确认的 5 项（§一）。

## 一、本次会话已修（不在待办里）

| # | 位置 | 修复 |
|---|---|---|
| F1 | `web/test/headpose-eval.mjs` | 弃权改为按角度判：`yaw/pitch` 为 `null` 的帧算弃权，不再被 `dirHoldMs` 保持窗里的旧方向算成「有输出」；新增 1 项自测 |
| F2 | `web/js/signals.js` | `_smoothAngle(..., {record:false})`：头部坏点只进 `head.reasons`，不再进动作层 `angleOutliers`（整帧被标 `unreliable`） |
| F3 | `web/js/headpose.js` | 补上 `yaw_3d/pitch_3d/roll_3d` 诊断字段（原来声明后从不赋值） |
| F4 | `docs/signals.md` | `roll_2d` 量纲改正（是度，不是归一化量）；头部坏点与动作层的关系写明 |
| F5 | `web/js/params.js` | 新增 `validateHeadParams`：鼻-眼区间、尺度门、roll/一致性上限、滞回对（含 2D/3D 量纲与符号）在加载时报错 |
| F6 | `README.md` / `docs/*` | 计数与口径同步（1312 项） |

## 二、P0 必修（会崩、或让评估/判定静默给出错误结论）

> **2026-11-20 当日已修**：P0-1 ~ P0-8 全部修复并各配回归测试，`npm test` 1322 项全绿；
> 修复内容与测试见 §七。下表保留审核时的原始描述。

| # | 位置 | 问题 | 失败场景 | 复核 |
|---|---|---|---|---|
| P0-1 | `web/test/evaluate.mjs:989` | `segmentTrack` 给未声明的 `id` 赋值（`let id` 只在 `seg.track` 分支内） | 多人导出（`export_mode:"multi"`）里任一段不写 `track`（文档说可选）→ `ReferenceError: id is not defined`，整次评估直接退出；`postureConfusion` 同一函数。已用最小 timeline 复现 | ✅ |
| P0-2 | `web/test/ppe-eval.mjs:460` | 告警事件只按 target/camera/时间窗匹配，不校验 clip | 同 camera 的两段素材 ts 区间天然重叠：A 段误报被 B 段 missing 标注判成真报，误报数/每小时误报假达标 | ✅ |
| P0-3 | `web/test/evaluate.mjs:1626` | `fitThresholds` 不看 `segments[].track`，恒取主目标时间线 | 多人素材 `--fit/--fit-out` 与 `--loso` 用别人的信号拟合阈值，写出方向/幅度错误的 profile | ✅ |
| P0-4 | `web/test/evaluate.mjs:1820` | baseline 键是 `action\0track`，无 action-only 回退 | 当前多人报告带 track、旧 baseline 不带 → 一条都不比，`passed=true` 假绿（`docs/eval.md:543` 承诺应按动作比对） | ✅ |
| P0-5 | `web/test/evaluate.mjs:2549` | 拿取计数段回溯靠 `phase === 'grasp'`，但 PhaseSequence 计数同帧已把 index 归零，`repPhase` 永远报 `'reach'` | 多次拿取的自动标注草稿全部从素材第一帧起算，段重叠、自评失败 | ✅ |
| P0-6 | `web/test/evaluate.mjs:214` | catch 分支把未去 BOM 的原文交给 `parseJsonl` | Notepad「UTF-8 with BOM」另存的 `.jsonl` 整份读取失败（`Unexpected token '﻿'`） | ✅ |
| P0-7 | `web/js/headpose.js:292` | 3D yaw 的横向轴取自随头转动的眼线；刚性转头时它等于鼻子相对眼线的固定几何 | 头真实转 30°/60°，`yaw_3d` 仍约 0，却标 `source='3d'`、`reliable.yaw=true`、方向恒 front；只有「只挪鼻点」的测试夹具能出角度。已复现 | ✅ |
| P0-8 | `web/js/params.js:663` | `validateParams` 不校验 `signals.arm.operating` 的结构类型 | profile 写 `operating: null`（或 `equipmentLabels: "panel"`）能加载，首个检出人的帧上 `SignalEngine` 构造抛 TypeError，页面停止推理 | ✅ |

## 三、P1 建议修（功能可用性 / 指标可信度）

| # | 位置 | 问题 | 失败场景 | 复核 |
|---|---|---|---|---|
| P1-1 | `web/js/app.js:1191` | 单人道「已检出」用 2×scale 判，最终归属 `assignHands` 用 0.8×scale | 落在两者之间的手被判「不用补检」又被归属丢弃，该侧伸手/指向/拿取整段失效 | ✅ |
| P1-2 | `web/js/app.js:1246` | ROI 补检与整帧手 8px 去重只按腕点、不看 owner | 整帧路径把手归给 B 时，A 的 ROI 检出被丢弃；B 槽里留着 A 的手 | ✅ |
| P1-3 | `web/js/app.js:1774` | 手部连续失败自动关闭时不 `closeHandEstimator()` | 实例仍在 → 重新勾选时 `handsReady()` 为真、`initHands` 跳过，手部再也回不来 | ✅ |
| P1-4 | `web/js/app.js:705` | `resetRuntime()` 不推进物体检测代次 | 重播/切输入/清空时，上一段在途的 ONNX 结果写回 `lastObjects`，旧框进入新一段导出与设备确认 | ✅ |
| P1-5 | `web/js/app.js:1340` | `analyzeStill` 的 `await detectObjects` 之后没有输入/参数代次校验 | 分析图片期间切输入/切 profile，旧图仍执行 12 次 `pipelines.update` 并覆盖 `lastResult/lastVerdicts`、画到新画面 | 🔁 |
| P1-6 | `web/js/app.js:207` | 多人估计器创建期间切 profile，重建条件要求 `multiReady` | 创建完成后按旧 cfg 写 `multiCfgKey`，本次 applyParams 已跳过重建，旧人数上限/检测阈值一直生效 | ✅ |
| P1-7 | `web/js/handroi.js:54` | `nearestWristSide` 不筛可见性（`wristSideFor` 筛了） | 被遮挡腕点抢走归属，裁对侧的 ROI 结果被当「裁错侧」丢弃 | ✅ |
| P1-8 | `web/js/headpose.js:143` | `dirWord(null,'down')` 返回 `'null_down'` | yaw 被 `pair_disagree` 置空但 pitch 有效时，`signals.head.dir` 导出非法标签，UI 显示「头部 null_down」 | ✅ |
| P1-9 | `web/js/armhint.js:220` | 只检查是否有 ROI，不看 `equipmentFallbackRoi` | pilot-panel（ROI + fail-closed）关掉物体检测时 operating 恒 false，面板仍标可用、不提示原因 | ✅ |
| P1-10 | `web/js/actions.js:88` | 除 operating/oil/drain 外的 Hold 用 `maxGapMs=0`，不感知 `update()` 断档 | 遮挡 900ms（tracker 1.5s 内保留 track、gapMs=1000 不重置）后回来，未满的 Hold 直接成立；reach→fist 可凭空 +1 拿取 | ✅ |
| P1-11 | `web/js/app.js:1530` | `stopAll()` 不清 `lastVerdicts` | 停止后人员列表仍显示停止前的人与 PPE 告警 | ✅ |
| P1-12 | `web/js/app.js:2900` | 关闭手部时 `activeHandModel = null` | 已录帧的导出 `meta.hand_model` 丢失来源（与 `stopAll` 特意保留的约定相反） | ✅ |
| P1-13 | `web/js/hands.js:25` | 创建/关闭没有代次保护 | 首次加载手部时点「停止」，返回后仍安装实例并设 `handReady=true`，形成「模型已释放但实例还在」 | ✅ |
| P1-14 | `web/js/app.js:1205` | 单人道 ROI 补检不看 `hand.roi.minScalePx` | 远景小目标每帧白跑两次手部推理；多人路径反而会跳过 | ✅ |
| P1-15 | `scripts/py-cv.mjs:41` | 20s 探活超时也套在真实运行上 | 长素材的 `video-sheet.py` 第 20 秒被杀（退出码 124），产物只写一半且无提示 | ✅ |
| P1-16 | `scripts/py-cv.mjs:59` | probe 不带 `-I`，实跑带 `-I` | opencv 装在 user site-packages 时 probe 过、实跑 ModuleNotFoundError，按提示重装也不会好 | ✅ |
| P1-17 | `web/test/cdp.mjs:121` | `openPage()` 失败路径不关 Chrome / 不删临时 profile | serve 没起时每次失败漏一个 headless Chrome 与一份 `%TEMP%` profile；成功路径 kill 后立刻 rm 也可能 EBUSY | ✅ |
| P1-18 | `web/test/headless-pose-switch.mjs:45` | 正则 `/^lite\\|CPU\\|/` 有空分支，`.test()` 恒真 | 槽位并发逻辑改坏，两条断言照样 PASS（第 69 行同样） | ✅ |
| P1-19 | `scripts/fetch-eval-data.py:258` | 失败只打 `[skip]`；MANIFEST 记「想要」的帧数 | 部分帧失败 → mp4 截断、manifest 声称完整、exit 0，后续 mot17 帧号错位 | ✅ |
| P1-20 | `scripts/prepare-ppe-dataset.py:456` | 先删旧产物再处理，split 缺失静默跳过，0 产出只 warn | strict 模式下先毁掉旧数据集再得到空目录，返回 0 | ✅ |
| P1-21 | `web/test/autolabel.mjs:67` | `repSessions` 不处理 `r.empty`，`prevCount` 不重置 | 多人回放主目标离场 >1s（计数归零）后，返回的前 N 次拿取不进草稿 | ✅ |
| P1-22 | `web/test/signal-compare.mjs:125` | 只比 `seg.action`，不排除 `expect:false`、不归一 id/flag | 反例窗口被当成正例采样，均值/分位污染；写 `arm_raised` 时匹配恒 0 | ✅ |
| P1-23 | `web/test/ppe-eval.mjs:646` | `nRecall > 0` 才判门槛 | 有 missing 标签但全部绑定失败（`track_not_found`）→ 从未评估却 exit 0（第 893 行同样） | ✅ |
| P1-24 | `web/test/manifest-check.mjs:143` | labels 读取/解析的 catch-all 吞掉语法错误 | 截断的 labels 使该 clip 正反例全为 0；覆盖不足时退出 2（「未达标」）而不是 1（「文件有错」） | ✅ |
| P1-25 | `web/js/params.js:668` | 「框有效期覆盖检测间隔」只在 `boxMinHits > 1` 时校验（既有问题） | minHits=1 + interval 1000 + maxAge 600 + fail-closed：两次检测间约 400ms 无框证据，operating Hold 每周期清零，动作永不成立 | ✅ |

## 四、P2 低危 / 一致性

| # | 位置 | 问题 |
|---|---|---|
| P2-1 | `web/test/evaluate.mjs:1040` | 反例计数段遇计数器重置（`got<0`）被判失败；反例只应要求「窗口内没有新增」 |
| P2-2 | `web/test/evaluate.mjs:2651` | 目录配对按字符串精确比较 base：Windows 大小写不同配不上；同目录 `a.jsonl` 与 `a.frames.json` 会重复配同一份 labels |
| P2-3 | `web/test/evaluate.mjs:3028`、`:3072`、`ppe-eval.mjs:887`、`headpose-eval.mjs:374`、`signal-compare.mjs:276` | `--json` 时状态行仍写 stdout，管道给 `jq` / `JSON.parse` 会失败；`--quiet` 也压不住 |
| P2-4 | `web/test/manifest-check.mjs:150` | `none` / `noArm` 给上下文动作 nearEquipment 也记反例，与 `evaluate.mjs` 口径不一致 |
| P2-5 | `scripts/refuel-sampling-suite.mjs:580` | 全部用例 FAIL/ERROR 仍 `exit 0` |
| P2-6 | `web/test/throughput-probe.mjs:161` | 一帧没采到仍 exit 0（素材 404 被过滤） |
| P2-7 | `web/js/track.js:307` | `prune` 在匹配之后：断档 >maxLostMs 时旧轨迹先被匹配、本帧不 prune，新人继承旧 id/uid（PPE 计时续上） |
| P2-8 | `web/js/multi.js:372` | 满 16 条时按 lastTs 淘汰，会淘汰仍活跃、缺席 < gapMs 的流水线 |
| P2-9 | `web/js/track.js:111` | `appearWeight` 被接收但从不参与 `similarity`（死配置，还会改变 `params_hash`） |
| P2-10 | `web/js/geometry.js:19` | `normalizeRect` 不校验归一化值域：`w:56` 的手滑会静默放大 ROI（多边形那条路是 fail-closed） |

## 五、未验证 / 设计取舍（不下结论）

| # | 位置 | 事项 |
|---|---|---|
| U-1 | `scripts/deterministic-replay.mjs:190` | 用已弃用的 `Page.setDownloadBehavior` 且 `.catch(()=>{})`；若 Chrome 不再支持，导出落默认目录，30s 后只报「没拿到 JSONL」。`clip-recognition` 用的是 `Browser.setDownloadBehavior` |
| U-2 | `scripts/slice-video.py:157` | 依赖 seek 后的 `CAP_PROP_POS_MSEC`；个别容器恒 0 时会写满到文件尾（有 `written==0` 守卫，没有上限守卫） |
| U-3 | `web/test/mot17-eval.mjs:239` | `seqinfo.ini` 缺失时 `imageSize` 为 0×0，gt 裁剪被静默关闭 |
| U-4 | `web/test/cdp.mjs` | WebSocket 断开/浏览器崩溃时 `CDP.send` 的 Promise 可能永不 settle，脚本挂起 |
| U-5 | `web/test/signal-compare.mjs` | 无 `video_time` 或循环导出时按 `t0 + sec*1000` 取样，录制起点不在 0s 时区间整体偏移 |
| U-6 | `web/js/geometry.js:404` | `drawMinTorsoDrop=0` 在俯拍/深弯腰（髋高于肩）时会隐藏真人骨架；文档只讨论了误检，未覆盖这种机位 |
| U-7 | `web/js/signals.js` head | `use3d` 实际依赖 `signals.world.enabled`；两者不一致时静默退回 2D，`validateParams` 不提示 |

## 六、建议顺序

1. **P0 一次修完**：`evaluate.mjs` 四条（ReferenceError / fit 取错人 / baseline 假绿 / 拿取回溯）+ BOM、ppe-eval 跨 clip、operating 结构校验、3D yaw。**（已完成，见 §七）**
2. **P1 按模块分批**：先手部链路（app.js 1191/1246/1774 + handroi），再评估工具（autolabel / signal-compare / ppe-eval / manifest-check），最后脚本与 UI 状态。
3. 每批修完跑 `npm test`，并在 `docs/` 对应章节补一句口径；P2 与「未验证」项等实拍/实跑确认后再动。

## 七、P0 修复记录（2026-11-20）

| # | 修复 | 回归测试 |
|---|---|---|
| P0-1 | `segmentTrack` 改用函数级 `let id`（原来在 `seg.track` 分支里声明，缺省路径赋值抛 ReferenceError） | `eval-test [31]`：多人导出 + 段不写 track |
| P0-2 | 告警事件带上 `clip`，匹配时先比较 clip 再比 target/camera/时间窗 | `ppe-eval --self-test [7]`：A 段误报不被 B 段 missing 标注洗白 |
| P0-3 | `fitThresholds` 复用 `segmentTrack`，按段解析 track 后取该 track 的时间线；段指向不存在的 track 直接跳过 | `eval-test [31]`：track 1 的段取 track 1 的膝角分位 |
| P0-4 | baseline 精确键查不到时回退到「该动作唯一的一行」；一条都没匹配上时列「baseline 未匹配」并判失败 | `eval-test [31]`：旧基线回退判退化 / 零匹配不假绿 |
| P0-5 | 拿取周期起点改为向前记录（计数帧上相位已归零，`endPhase` 永远找不到） | `eval-test [31]`：三次拿取草稿起点递增 |
| P0-6 | `parseJsonl` 入口统一 `stripBom`（`loadFrames` 的 catch 分支传的是原文） | `eval-test [31]`：BOM + 多行 JSONL |
| P0-7 | 3D yaw 改为「头自身左右轴相对相机像平面的转角」并去 roll；旧实现取鼻相对眼线的偏移，刚性转头恒 0 | `headpose-test [5]`：刚性 ±30° 出角度、只挪鼻点不再产生 yaw |
| P0-8 | 新增 `validateArmStructure`：`operating`/`nearEquipment` 必须是对象，`equipmentLabels` 必须是数组 | `eval-test [31]`：`operating: null`、`equipmentLabels: "panel"` 加载即抛错 |
| 文档 | `docs/signals.md` 3D yaw 口径；`docs/eval.md` baseline 回退与 BOM；README 计数（1322 项） | — |

## 八、P1 修复记录（2026-11-20，按模块分批）

> 25 项 P1 全部修复，`npm test` **1369 项 / 0 失败**（新增 47 项：多人/逻辑/头部/提示/
> 自动标注/清单/PPE 评估/信号对比）。P2 与 §五「未验证」项未动。

### 手部链路

| # | 修复 | 回归测试 |
|---|---|---|
| P1-1 | `handsOfTarget` 与 `completeHands` 的「已检出」改用 `nearestHandSide` + `HAND_ASSIGN_MAX_DIST`（0.8×scale + 可见性），与 `assignHands` 同一判据；不再用 2×scale 像素距离 | `multi-test`：归一化距离/阈值；源码接线断言 |
| P1-2 | `completeHandsMulti` 的 8px 去重按 `owner_track_id` 匹配；整帧手归给 B 时不再挤掉 A 的 ROI 检出 | `multi-test`：去重看 owner 的接线断言 |
| P1-3 | 手部连续失败自动关闭时走 `releaseHands()`（释放实例 + 推进代次），重新勾选能重新初始化 | `multi-test`：自动关闭分支调用 releaseHands |
| P1-7 | `nearestWristSide` 过滤 `vis < 0.3` 的腕点（与 `wristSideFor` 同口径） | `logic-test`：遮挡腕点不参与归属 / 全遮挡返回 null |
| P1-13 | `initHands` 增加创建代次：停止/关闭后 await 回来的旧创建被作废并释放；同代次复用在途 promise | `multi-test`：创建后校验 `gen !== handsGen`（两处） |
| P1-14 | 单人道 ROI 补检也检查 `hand.roi.minScalePx`（与多人 `pickRoiPersons` 一致） | `multi-test`：源码接线断言 |

### 评估工具

| # | 修复 | 回归测试 |
|---|---|---|
| P1-21 | `repSessions` 遇 `empty`/无判定行重置 `prevCount`/`downTs`，计数回退也按归零处理 | `autolabel-test`：离场 >1s 后第一次拿取仍进草稿；计数回退 |
| P1-22 | `signal-compare` 的段匹配归一 id/flag，跳过 `!动作` 与 `expect:false` | 新增 `signal-compare-test`（7 项） |
| P1-23 | `ppe-eval` 记录 `labelCounts` / `missingUnbound` / `missingAbstained`；有 missing 标注但 `nRecall=0` 时门槛失败并说明原因 | `ppe-eval --self-test [8]` |
| P1-24 | `manifest-check` 区分 labels 缺失（ENOENT，交给清单校验）与解析失败；后者记 `labelErrors`、清单 `ok=false`、退出码 1 | `manifest-test`：截断 labels → 读取错误；缺文件不重复报 |

### 脚本与 UI 状态

| # | 修复 | 回归测试 |
|---|---|---|
| P1-4 | `resetRuntime` 推进 `runtimeGen`（不重建检测器）；在途物体结果同时校验 `runtimeGen` | `multi-test`：源码接线断言 |
| P1-5 | `analyzeStill` 捕获输入/运行时代次，`await detectObjects` 后失效即放弃整次分析 | `multi-test`：await 后 stale 检查 |
| P1-6 | 多人估计器创建完成后比对 `desiredMultiKey()`；不一致则关闭并在当前 promise 结束后按新配置重建 | `multi-test`：`multiRecreatePending` 接线 |
| P1-8 | `dirWord` 单轴不可用时只报另一轴，不再产出 `null_down` | `headpose-test`：单轴/双轴 null 与组合 |
| P1-9 | `armhint` 按 `equipmentFallbackRoi` 判断 ROI 是否可作证据：fail-closed + 关物体检测时 operating/nearEquipment 标不可用并说明原因 | `armhint-test`：fail-closed 关/开检测器、无类别 |
| P1-10 | 新增 `actions.holds.maxCallGap`（500ms）：非持续 Hold 检查「真值帧断档」，`cond=false` 仍立即重置 | `logic-test`：callGap 断档/断档内累计/false 仍重置；源码接线 |
| P1-11 | `stopAll` 清空 `lastVerdicts` | `multi-test`：源码接线断言 |
| P1-12 | 关闭手部不再清空 `activeHandModel`（导出 `meta.hand_model` 保留来源） | `multi-test`：源码接线断言 |
| P1-15 | `py-cv.mjs` 探活 20s 超时不再套在真实运行上（`timeoutMs: 0`） | 手工审阅（脚本无单测） |
| P1-16 | `py-cv.mjs` 探活使用与真实运行相同的 `-I` 选项 | 同上 |
| P1-17 | `cdp.openPage` 失败路径也关闭 Chrome/删除临时 profile；删除带重试（Windows EBUSY） | 同上 |
| P1-18 | `headless-pose-switch` 的正则改为 `/^lite\|CPU\|/`（原 `\\|` 产生空分支，恒真） | 同上 |
| P1-19 | `fetch-eval-data.py` 记录失败文件/实际数量/`failed`，退出码非 0；缺帧时不合成 MP4 | 手工审阅 |
| P1-20 | `prepare-ppe-dataset.py` 先写 `*.build` 再替换；strict 缺 split 在删除前报错；0 产出保留旧数据并退出非 0 | 手工审阅 |
| P1-25 | 「框有效期覆盖检测间隔」在 `boxMinHits=1` + `equipmentFallbackRoi=false` 时也校验 | `operating-test`：fail-closed + minHits=1 报错 / interval 150 通过 |

### 文档

`docs/signals.md`（Hold 断档口径、方向词、signal-compare 反例过滤）、`docs/eval.md`
（manifest 退出码口径）、`docs/equipment-detector.md`（fail-closed 下的时序校验与面板提示）、
`docs/data-collection.md`（自动标注离场重计数）、`docs/open-datasets.md`（下载失败/帧号）、
`docs/ppe-training.md`（构建目录替换与退出码）、README 计数（1369 项）。

## 九、P2 修复记录（2026-11-20）

> 10 项 P2 全部修复，`npm test` **1385 项 / 0 失败**（新增 16 项）。§五「未验证」项未动。

| # | 修复 | 回归测试 |
|---|---|---|
| P2-1 | 计数类反例只要求「窗口内没有新增」：`expect=false` 时用 `got <= 0`，计数器重置导致的负增量不再判失败 | `eval-test`：`got=-2` 的反例通过 |
| P2-2 | 目录配对按 Windows 大小写不敏感比较；同一 base 的 `a.jsonl` / `a.frames.json` 只保留一个（优先 JSONL）；同一份 labels 在 `loadPairs` 按 labels 去重 | `eval-test [10b]`：重复别名只配一次；Windows 大小写别名能配对 |
| P2-3 | `--json` 时状态行改走 stderr，`--quiet` 一并压住；覆盖 evaluate / ppe-eval / headpose-eval / signal-compare | `eval-test [9]`：`--json` stdout 可 `JSON.parse`；`--quiet` stdout 为空 |
| P2-4 | manifest 覆盖度的 `none` / `noArm` 不再给上下文动作（nearEquipment）记反例，与 evaluate 同口径 | `manifest-test`：nearEquipment 的 none/noArm 反例为 0；显式 `!nearEquipment` 才计 |
| P2-5 | `refuel-sampling-suite` 任一用例 FAIL/ERROR 时退出码 1 | 手工审阅（需浏览器/素材） |
| P2-6 | `throughput-probe` 一帧都没采到时退出码 1（素材 404/视频没播不再算成功） | 手工审阅 |
| P2-7 | Tracker `prune` 移到匹配之前：断档 > `maxLostMs` 的旧轨迹不再被匹配后刷新 `lastTs`，新人不会继承旧 id/uid | `multi-test`：无空帧调用、断档 2s 直接回来 → 新 id/uid |
| P2-8 | `PersonPipelines` 满上限时只淘汰已超过 `gapMs` 的流水线；活跃的不淘汰（临时超上限，由每帧 `prune()` 回收） | `multi-test`：活跃流水线保留、过期优先淘汰 |
| P2-9 | 删除死配置 `signals.track.appearWeight`（不参与 similarity，只改 `params_hash`） | `multi-test`：`resolveParams().signals.track.appearWeight === undefined` |
| P2-10 | `normalizeRect` 校验归一化值域（0~1、须落在画面内）：`w:56` 之类手滑 fail-closed，不再静默放大 ROI | `geometry-test`：w=56 / 超出画面 / 负坐标均判非法 |

### 文档

`docs/eval.md`（重复帧别名配对口径）、`docs/signals.md`（ROI 值域 fail-closed）、
`docs/multi-and-objects.md`（先 prune 再匹配、流水线上限语义）、
`docs/data-collection.md` / `docs/eval.md`（上下文动作不记 none/noArm 反例）、README 计数（1385 项）。
