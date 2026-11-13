// equipment.js — 设备检测框的时序过滤（纯逻辑，Node 可单测）
//
// 为什么需要这一层：YOLO 给的是逐帧独立的框，而 operating 把「本帧有设备框」
// 直接当成物体证据。于是：
//   · 单帧误检立刻生效——画面里任何一次 panel/valve 误报都能让 operating 成立；
//   · 检测是 150ms 一次、异步落地，框本身就隔帧出现/消失。
// 这里把「框在不在」变成有记忆的证据：
//   1) 同一位置（IoU 或中心距）在 **两次不同的检测** 里都命中，才算确认（minHits）；
//   2) 超过 maxAgeMs 没再看到就过期，旧框不会一直粘着；
//   3) 同一次检测的结果在两次检测之间会被 app 反复沿用（lastObjects），
//      observationTs 相同的重复结果**不重复计数**——否则一次误检能在重复帧里攒够 hits。
//
// 旧导出没有 objects_ts：传 observationTs=null 时**不过滤**（逐位保持旧行为，
// 避免把已经发布的历史指标改掉）。新导出由 app.js 写入 objects_ts。
//
// 语义细节：
//   · 不同标签的框不会互相匹配（panel 框不会「变成」valve 框）；
//   · 未确认的 track 也会保留到过期，让它在下一次检测里继续累计；
//   · 确认后因漏检短暂消失（<maxAgeMs）仍然算数，这就是「掉帧容忍」的一半，
//     另一半是动作层 holds 的 maxGap。

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBox = (b) => Array.isArray(b) && b.length >= 4 && b.every(isNum);

const boxArea = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const boxCenter = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const boxDiag = (b) => Math.hypot(Math.max(0, b[2] - b[0]), Math.max(0, b[3] - b[1]));

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 匹配分：>0 才算同一位置。IoU 命中给 1；IoU 不够时用中心距离兜底
 * （固定机位、框抖动时 IoU 会掉到 0.3 以下）。
 */
function matchScore(a, b, { matchIou, matchCenter }) {
  const i = iou(a, b);
  if (i >= matchIou) return 1 + i;
  const ca = boxCenter(a);
  const cb = boxCenter(b);
  const d = Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
  const lim = matchCenter * Math.max(1e-6, Math.min(boxDiag(a), boxDiag(b)));
  if (d <= lim) return 0.5 * (1 - d / lim) + 0.01;
  return 0;
}

export class EquipmentBoxTracker {
  /**
   * @param {{minHits?:number, maxAgeMs?:number, matchIou?:number, matchCenter?:number}} opts
   */
  constructor({ minHits = 2, maxAgeMs = 600, matchIou = 0.3, matchCenter = 0.75 } = {}) {
    this.minHits = Math.max(1, Math.floor(Number(minHits) || 1));
    this.maxAgeMs = Math.max(0, Number(maxAgeMs) || 0);
    this.matchIou = Number.isFinite(matchIou) ? matchIou : 0.3;
    this.matchCenter = Number.isFinite(matchCenter) ? matchCenter : 0.75;
    this.tracks = [];
    this.lastObservationTs = null;
  }

  /**
   * @param {Array<{label?:string, box:number[]}>} objects 已按 label/score 过滤后的框
   * @param {number} tsMs 本帧时间（与 trakcer 的 ts 同基准，毫秒）
   * @param {number|null} observationTs 产生这批框的那次检测的时间；null=无时序信息（不过滤）
   * @returns {{boxes:number[][], confirmed:number, pending:number, fresh:boolean, bypass:boolean}}
   *          boxes 是**确认且未过期**的框数组（保持输入顺序里的最新位置）
   */
  update(objects, tsMs, observationTs = null) {
    const list = (Array.isArray(objects) ? objects : [])
      .filter((o) => o && isBox(o.box))
      .map((o) => ({ label: o.label == null ? '' : String(o.label), box: o.box }));

    // 没有时序信息：不过滤。旧导出 / 单张图片走这里，行为与引入本模块前一致。
    if (!isNum(observationTs) || !isNum(tsMs)) {
      this.lastObservationTs = null;
      return { boxes: list.map((o) => o.box), confirmed: list.length, pending: 0, fresh: false, bypass: true };
    }

    const fresh = observationTs !== this.lastObservationTs;
    if (fresh) {
      this.lastObservationTs = observationTs;
      // 过期清理必须在匹配**之前**：超过 maxAgeMs 的轨迹本轮已经作废，若先匹配再过滤，
      // 它会先拿到 hits+1 再被删掉，等于跳过了一次真实观测（minHits 形同 1）。
      // 真实可达：SignalEngine 只在有人的帧调用 update，漏检/多人缺席的帧不会推进
      // tracker，间隔再久也不会触发清理——人回来后第一次检测就能「续上」旧轨迹。
      this.tracks = this.tracks.filter((t) => tsMs - t.lastSeen <= this.maxAgeMs);
      const used = new Set();
      for (const obj of list) {
        let bestIdx = -1;
        let bestScore = 0;
        for (let i = 0; i < this.tracks.length; i++) {
          if (used.has(i)) continue;
          const t = this.tracks[i];
          if (t.label !== obj.label) continue;
          const s = matchScore(t.box, obj.box, this);
          if (s > bestScore) { bestScore = s; bestIdx = i; }
        }
        if (bestIdx >= 0) {
          const t = this.tracks[bestIdx];
          used.add(bestIdx);
          t.box = obj.box;
          t.hits += 1;
          t.lastSeen = tsMs;
        } else {
          this.tracks.push({ label: obj.label, box: obj.box, hits: 1, firstSeen: tsMs, lastSeen: tsMs });
          used.add(this.tracks.length - 1);
        }
      }
    }

    // 过期清理：未确认的也要留到过期，下一次检测还能续上 hits。
    // fresh 分支已在匹配前清过一次；这里兜住「重复沿用同一批框」的帧（时间在走、轨迹会老）。
    this.tracks = this.tracks.filter((t) => tsMs - t.lastSeen <= this.maxAgeMs);
    const confirmedTracks = this.tracks.filter((t) => t.hits >= this.minHits);
    return {
      boxes: confirmedTracks.map((t) => t.box),
      confirmed: confirmedTracks.length,
      pending: this.tracks.length - confirmedTracks.length,
      fresh,
      bypass: false,
    };
  }

  reset() {
    this.tracks = [];
    this.lastObservationTs = null;
  }
}
