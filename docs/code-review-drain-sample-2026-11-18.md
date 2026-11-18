# drain_sample 代码审核记录（2026-11-18）

审核对象：`claude/elastic-grothendieck-743e19` 上未提交的 `drain_sample`（放油取样）改动，
共 10 个文件（`web/js/{params,signals,actions,app,armhint}.js`、`web/test/sampling-test.mjs`、4 个文档）。

当前状态：**问题未修复**。测试基线 `npm test` 1119/1119、`sampling-test` 30/30 全绿。

## 问题清单

| # | 严重度 | 位置 | 问题 |
|---|---|---|---|
| 1 | 中 | `web/js/armhint.js:125` | `hold` 期间单腕被遮挡时，双侧动作被显示成“左手/右手放油取样” |
| 2 | 中 | `web/js/params.js:84` | 默认 `minKnee=60` 排除了文档所说的“跪姿” |
| 3 | 中 | `web/js/signals.js:866` | 膝角用 `kneePick`，单膝跪地会随哪条腿可见而翻转 |
| 4 | 中 | `web/js/signals.js:867` | `maxKnee=140` 放行接近站立的姿势，没有“蹲”的强证据 |
| 5 | 低 | `web/js/armhint.js:60` | 提示说“或上半身前倾”，代码只在膝角不可用时才看前倾 |
| 6 | 低 | `runs/oil-sample-eval-2026-11-18/DRAIN_SAMPLE.md:76` | 浏览器复核数字是优化前测的，与最终参数不符 |
| 7 | 低 | `web/js/params.js:441` | `validateParams` 没校验 `minKnee <= maxKnee`，配错会静默失效 |

---

## 1. 双侧动作被显示成单手

**位置**：`web/js/armhint.js:125`，配合 `web/js/actions.js:336-337`。

**现象**：`drainSampleL/R` 取的是当前帧的 `drain_low_L/R`；但 `drain_sample` 要求双手同时成立。
`Hold` 在 `drainSampleMaxGap=900ms` 内会继续保持动作成立，这时被遮住那一侧的 `drain_low` 变 false，
`SIDE_FLAGS` 就把动作渲染成“左手放油取样”或“右手放油取样”。

**触发场景**：最终参数下 40–60s 窗口、50.3s 的截图，右手腕被盆/阀门挡住，动作仍成立，
面板显示“左手放油取样”。动作本身是双侧的，单手只是遮挡造成的瞬时状态。

**建议**：从 `SIDE_FLAGS` 删除 `drain_sample`，或让 `drainSampleL/R` 都等于聚合 `drainSample`
（如果保留导出字段，注明它们只是逐侧腕低诊断，不是“哪只手在做”）。

**验收**：同一窗口重跑，动作成立期间面板不再出现“左手/右手”前缀；`sampling-test` 增加一条：
hold 激活后把一侧 `drain_low` 置 false，L/R 不应一真一假（或 UI 不显示侧别）。

---

## 2. 默认 minKnee=60 排除跪姿

**位置**：`web/js/params.js:84`；采集指南 `docs/data-collection.md:73`；判据说明 `docs/signals.md`「放油取样」。

**现象**：动作名和采集指南都写“蹲/跪在放油阀旁”，但默认 `minKnee=60` 会拒绝单膝跪地
（膝角约 45°）。采集人员按指南录的跪姿正例，用默认参数永远检不出。

**触发场景**：工人单膝跪在放油阀旁接油，`kneePick≈45°` → `drainCrouched=false` → 0 检出。
这不是阈值噪声，是默认值与动作定义不一致。

**建议**（二选一）：
- 把 `minKnee=60` 从全局默认移到本场景 profile，默认保持 0，并在文档里写清楚场景标定值；
- 或者把动作/采集指南明确成“半蹲（膝角 60–140°）”，不要写“跪”，并给出深跪场景的覆盖方法。

**验收**：用一段单膝跪地接油的标注片段测试，默认档能检出，或文档明确说明默认档不支持并给出 profile 覆盖示例。

---

## 3. 单膝跪地随 kneePick 翻转

**位置**：`web/js/signals.js:866`。

**现象**：`kneePick` 由 `pickSide` 按“髋-膝-踝三点可见度”选腿，不是按弯曲程度选。
单膝跪地时两腿膝角差异很大（跪腿约 45°、支撑腿约 100°）。
如果跪腿可见度低，代码用支撑腿的 100° → 通过；如果跪腿可见度高，用 45° → 不通过。
同一姿势会随遮挡在“检出/漏检”之间跳。

**建议**：`drain_sample` 不应复用单侧的 `kneePick`。可用两条腿的膝角：
`min( knee_L, knee_R )`（更弯的那条）或“任一条腿落在 60–140°”作为蹲姿证据。
注意与现有 `knee_pick` 的语义分开，避免影响站/坐姿态和计数。

**验收**：构造左右膝角 45°/100° 的两种可见度组合，`drain_sample` 结果应一致；
在真实单膝跪地片段上不随遮挡翻转。

---

## 4. maxKnee=140 放行接近站立

**位置**：`web/js/signals.js:867`（`kneePick <= maxKnee`）。

**现象**：膝角 140° 只是轻微屈膝。站立双手拎低桶/端盆（抬臂角约 170°、两腕靠拢、膝约 130°）
会满足全部条件；因为膝角有限时不再看 `uprightness`，规则没有剩余“蹲”的证据。

**触发场景**：工人站立、微屈膝、双手在低处拎着桶或盆——姿态与 PSA 场景里的“接油”很像，
但没有蹲/跪。当前反例集里没有这类样本，所以标定时没暴露。

**建议**：增加独立的蹲姿门（髋部高度相对膝/踝、躯干前倾、或 `hip_y`/`knee_y` 的几何关系），
不要只靠膝角上限；或者把 `maxKnee` 收紧到 120–130，并接受部分正例漏检。

**验收**：补一段“站立拎低桶/微屈膝”反例，最终参数不应触发；同时 40–60s 的两段正例不漏。

---

## 5. 提示文案与实现不符

**位置**：`web/js/armhint.js:60`。

**现象**：`need` 写的是“膝角 60°–140° **或**上半身前倾”，但代码只有在
`kneePick` 不是有限值时才走 `uprightness` 回退。膝角 50° + 明显前倾时，动作仍然不成立。

**建议**：改成“膝不可用时看上半身前倾”，或改代码让前倾在膝角越界时也能兜底（后者会改变行为，
需要重新标定误报）。推荐先改文案。

**验收**：提示文案与 `signals.js` 分支一致；`armhint-test` 的提示覆盖仍全过。

---

## 6. 浏览器复核数字是优化前测的

**位置**：`runs/oil-sample-eval-2026-11-18/DRAIN_SAMPLE.md:76`（同样数字也出现在 `REPORT.md:175`）。

**现象**：报告写“553 帧 / 命中 94 帧 / 41.0–42.5、45.7–47.5s”，这是初版参数
（`minKnee` 尚未加入、gap=500）下的浏览器实测。用最终参数重跑同一 40–60s 窗口得到：
**549 帧 / 命中 147 帧 / 47.0–52.1s**。

**建议**：用最终 profile 重新跑一次 `scripts/clip-recognition.mjs`，更新数字；或明确标注
“优化前实测，仅作直播/离线性状参考”。不要把它和最终离线 3/3 事件指标混在一起。

**复现命令**：

```bash
node scripts/py.mjs serve.py 8799
MSYS_NO_PATHCONV=1 node scripts/clip-recognition.mjs \
  --base http://127.0.0.1:8799 \
  --clip /eval-data/airport-refuel/transformer_sample.mp4 \
  --profile /eval-data/airport-refuel/profile-transformer.json \
  --out runs/oil-sample-eval-2026-11-18/clip-transformer-drain-final \
  --name drain-final --start 40 --end 60 --export
```

---

## 7. 缺少膝角区间校验

**位置**：`web/js/params.js:441`（`validateParams`）。

**现象**：profile 写成 `drain: { minKnee: 150, maxKnee: 100 }` 不会报错；
`drainCrouched` 对所有帧恒 false，动作静默失效，排查时只能逐帧看信号。

**建议**：在 `validateParams` 里加：
- `minKnee <= maxKnee`；
- `maxHandsClose > 0`、`minElev` 在 0–180；
- 失败时抛错，与现有 `boxMaxAgeMs` 的校验风格一致。

**验收**：非法 profile 在页面加载/评估器读取时直接报错；`eval-test` 增加一条非法组合用例。

---

## 复现与验收

```bash
node web/test/sampling-test.mjs   # 当前 30/30
npm test                          # 当前 1119/1119
```

审核依据：

- 规则实现：`web/js/params.js`、`web/js/signals.js`、`web/js/actions.js`
- 面板提示：`web/js/armhint.js`
- 标定报告：`runs/oil-sample-eval-2026-11-18/DRAIN_SAMPLE.md`
- 近似标签：`runs/oil-sample-eval-2026-11-18/labels/`
- 参数扫描：`runs/oil-sample-eval-2026-11-18/tools/drain-sweep.mjs`
- 最终参数浏览器证据：`runs/oil-sample-eval-2026-11-18/clip-transformer-drain-final/`
  （`02_t50.30_sample.png` 可看到第 1 条的“左手放油取样”）
