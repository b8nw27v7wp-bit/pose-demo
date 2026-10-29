# 项目插图提示词

用途：README 头图、课程/作品集封面、汇报首页。

**一条硬规则：不要让模型生成文字。** 图里的标题、数据卡、按钮标签全部后期加——
AI 画中文必乱，画英文也经常拼错，修起来比重新排版贵。

配色取自界面：背景 `#f5f5f7`、主文字 `#1d1d1f`、次级 `#6e6e73`、
状态绿 `#2f8f5b`、警示黄 `#b07d18`、错误红 `#b23b2e`。

---

## A. 头图（推荐）

**画面概念**：一个人在浅色工作室里，身上覆盖着精确的骨架；右侧留白处有膝角曲线和几张没有文字的状态卡。
气质是「工程图 + 编辑插画」，不是赛博朋克，也不是塑料 3D。

**English prompt**

```
Clean editorial technical illustration, 16:9. A single full-body person standing calmly in an otherwise empty light-gray studio, rendered as a flat, semi-transparent warm-gray silhouette. Over the body, a precise skeletal overlay: small circular joints connected by thin 1.5px graphite bones following human pose anatomy, most joints muted green, two joints amber and one joint soft red to suggest confidence levels. To the right, floating in generous negative space, a minimal interface panel: a thin line chart with one curve and two faint horizontal guide lines, three small rounded status chips, one tiny green dot; all shapes abstract, absolutely no readable text or numbers. Background #f5f5f7, soft even lighting, no shadows, no gradients, no glow. Restrained palette: graphite #1d1d1f, warm gray #6e6e73, green #2f8f5b, amber #b07d18, red #b23b2e. Flat vector-meets-technical-diagram aesthetic, thin consistent strokes, precise geometry, calm and credible, plenty of white space, poster-like composition.
```

**Negative prompt**

```
text, letters, numbers, Chinese characters, watermark, signature, logo, readable UI labels, extra limbs, deformed hands, photorealistic skin, glossy plastic, 3D render, neon cyberpunk, purple, blue gradient, glow, lens flare, drop shadow, cluttered background, busy patterns
```

**参数建议**

| 工具 | 参数 |
|---|---|
| Midjourney | `--ar 16:9 --style raw --stylize 100`（版本不同参数可能失效，以当前文档为准） |
| SDXL / ComfyUI | 1536×864，steps 30，CFG 5，加 negative prompt |
| DALL·E / 通用对话模型 | 直接贴上面两段，明确「不要生成任何文字」 |

**构图变体**

1. **标题留白版**：人物放在左 1/3，右侧 2/3 纯背景，后期压标题——最适合 README 头图。
2. **四角卡片版**：人物居中，四角各一张小卡（姿态 / 手臂 / 手势 / 计数），卡片里只放抽象图形。
3. **深蹲侧视版**（更贴项目实际动作）：侧面机位、下蹲到一半的人，右侧膝角曲线出现一个明确的 U 形，
   两条阈值线一上一下。这一版最能把「信号 + 阈值」讲清楚，但人物姿势更难画对，建议多出几张挑。

---

## B. 深色海报（可选）

适合汇报封面。与界面浅色风格不一致，但投影时更抓眼。

```
Minimal dark poster, 16:9. Deep charcoal #101012 background. A single human figure drawn only as an off-white skeletal line overlay with small circular joints; most joints pale green, one amber. A thin green line chart floats to the right, rising and falling in one clean curve. Vast empty space, thin strokes, no text, no glow, no gradients, no 3D. Quiet, precise, technical, cinematic but restrained.
```

Negative 同上（再加 `neon, sci-fi HUD, hologram, blue glow`）。

---

## C. 架构概念图（可选）

用于讲「感知 / 信号 / 规则 / 事件」四层，不放正文里也可以当汇报的一页。

```
Minimal isometric technical diagram on an off-white background, no text. Left: a small camera aimed at a person whose body is covered by a precise green skeletal overlay. Center: a translucent stack of flat rounded rectangles suggesting frame data, next to a thin line chart with one curve. Right: three thin card-like layers feeding into a clean horizontal stream of small dots, suggesting events. Graphite thin outlines, one green accent, amber for exceptions, generous spacing, flat vector style, precise and airy, no shadows, no gradients.
```

**后期**：四层分别用 1 行小字标注「感知 / 信号 / 规则 / 事件」，其余不写字。

---

## 出图与后期清单

- 一次出 4 张挑 1 张，固定 seed 再微调；不要指望第一张就能用。
- 人物手指/脚趾最容易崩：裁掉手部，或让手自然垂在身侧。
- 所有文字、数字、坐标轴刻度后期加；字体用系统默认无衬线（PingFang SC / Segoe UI）。
- 导出 1600×900 或 1200×630（社交卡片），压成 WebP；文件放 `docs/` 或展示用目录，不要进 `web/`。
- 绿色只留给「判定成立」这一个语义，别当装饰色到处用。

---

## 附：如果你要的是**文案**提示词

```
写一段 300 字以内的项目介绍，读者是「想快速判断这东西靠不靠谱」的技术人。
必须包含：
1. 浏览器零安装、全本地推理，摄像头/视频/样例三种输入；
2. 动作判定是「信号层 + 配置规则」，不是端到端视频分类；
3. 能力边界：单人、每个场景需校准、手部精细动作不在范围内；
4. 目前缺什么：还没有实拍评估数据，阈值是量级参考。
不要用「赋能 / 颠覆 / 革命性」这类词，不要写愿景，不要用感叹号。
```
