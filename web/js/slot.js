// slot.js — 异步估计器槽位：单实例 + 创建代次
//
// 为什么需要：`createFromOptions` 是异步的（下载/编译 wasm）。快速切模型/后端时
// 两次创建会并发：后完成的覆盖先完成的，先完成的实例没有 close()，占着 GPU/wasm
// 内存。objects.js 里的 epoch 是同一套思路；这里抽成通用槽位给 pose.js 用。
//
// 语义：
//   - 同 key 直接复用当前实例；
//   - 每次 acquire 都推进代次：比它新的请求会让旧创建在完成时自我释放并报 superseded；
//   - close() 同样推进代次，在途创建不会再安装到槽位上。

/** 被更新请求取代（调用方不应把它当成「模型加载失败」） */
export function supersededError(message = '估计器创建被新的请求取代') {
  const e = new Error(message);
  e.superseded = true;
  e.code = 'estimator_superseded';
  return e;
}

export const isSuperseded = (e) => !!(e && e.superseded);

export class EstimatorSlot {
  /**
   * @param {{close?: (instance:any)=>void, supersededMessage?: string}} opts
   *   close：实例释放函数（默认调用 instance.close()）
   *   supersededMessage：被取代时的报错文案（单/多人各写各的，便于排查）
   */
  constructor({ close, supersededMessage } = {}) {
    this.epoch = 0;
    this.current = null;
    this.key = '';
    this.closeImpl = close || ((x) => x?.close?.());
    this.supersededMessage = supersededMessage || '估计器创建被新的请求取代';
  }

  get ready() {
    return !!this.current;
  }

  /**
   * 取同 key 的实例，或在代次保护下新建。
   * 旧实例在开始新建前释放（与旧行为一致：新配置与旧实例不兼容，留着也没用）。
   *
   * @param {string} key 配置指纹
   * @param {() => Promise<any>} build
   * @returns {Promise<any>}
   */
  async acquire(key, build) {
    const myEpoch = ++this.epoch;
    if (this.current && key === this.key) return this.current;

    this.closeCurrent();

    let created;
    try {
      created = await build();
    } catch (e) {
      // 自己已经过期时，失败也不该覆盖新请求的状态
      if (myEpoch !== this.epoch) throw supersededError(this.supersededMessage);
      throw e;
    }

    if (myEpoch !== this.epoch) {
      // 创建期间有更新的请求：这个实例没人用，必须关掉，否则就是泄漏
      this.release(created);
      throw supersededError(this.supersededMessage);
    }
    this.current = created;
    this.key = key;
    return created;
  }

  /** 作废在途创建并释放当前实例 */
  close() {
    this.epoch++;
    this.closeCurrent();
  }

  release(instance) {
    try {
      this.closeImpl(instance);
    } catch { /* ignore */ }
  }

  closeCurrent() {
    if (this.current) {
      this.release(this.current);
      this.current = null;
    }
    this.key = '';
  }
}
