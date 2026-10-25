// lib/feishu/liveness.js —— 飞书长连接看门狗（0.11.0）。
//
// 背景：SDK 自带 autoReconnect，但极端网络（DNS/代理/NAT 卡死）下可能进入
// 「状态卡在 reconnecting、既不恢复也不报错」的静默期；外部看到的只是机器人不回消息。
// 本模块在断开后计时：超过 deadline 仍未恢复 ⇒ 主动拆掉 WSClient 重建；
// 重建按 backoff 退避，并用滑动窗口配额限制次数（避免把飞书连接配额烧光，
// 反而导致平台侧限流）。所有状态迁移都通过 report 输出，便于事后诊断。

/** 默认参数（channel.js 直接使用；测试可注入更短的值）。 */
export const DEFAULT_LIVENESS = Object.freeze({
  deadlineMs: 3 * 60 * 1000,
  backoffMs: [30_000, 60_000, 120_000, 300_000],
  quotaWindowMs: 30 * 60 * 1000,
  quotaLimit: 10,
});

/**
 * 滑动窗口配额：windowMs 内最多 limit 次重建。
 * @param {{windowMs:number, limit:number, now?:()=>number}} opts
 */
export function createAttemptQuota({ windowMs, limit, now = Date.now }) {
  if (!(windowMs > 0) || !(limit > 0)) throw new TypeError('liveness: quota 需要正的 windowMs/limit');
  let attempts = [];
  const prune = () => {
    const t = now();
    attempts = attempts.filter((at) => t - at < windowMs);
  };
  return {
    /** 当前是否还可以重建。 */
    allows() {
      prune();
      return attempts.length < limit;
    },
    /** 记录一次重建尝试。 */
    record() {
      prune();
      attempts.push(now());
    },
    /** 配额耗尽时，最早一次尝试失效的时间点（毫秒时间戳）；未耗尽返回 undefined。 */
    freeAt() {
      prune();
      return attempts.length < limit ? undefined : attempts[0] + windowMs;
    },
    /** 窗口内剩余次数。 */
    remaining() {
      prune();
      return Math.max(0, limit - attempts.length);
    },
  };
}

/**
 * 创建重连看门狗。
 * @param {Object} opts
 * @param {number} opts.deadlineMs   断开后等待多久判定「恢复循环已死」
 * @param {readonly number[]} opts.backoffMs 重建失败后的退避（最后一个值会一直重复）
 * @param {() => string|undefined} opts.status 传输自报状态（截止时再查一次，防止误杀已恢复的连接）
 * @param {() => Promise<void>} opts.rebuild   拆掉并重建传输
 * @param {(line:string)=>void} opts.report    运维日志
 * @param {ReturnType<typeof createAttemptQuota>} [opts.quota] 重建配额（缺省不限制）
 * @returns {{onDisconnected:()=>void, onConnected:()=>void, dispose:()=>void, phase:()=>string}}
 */
export function createReconnectWatchdog({ deadlineMs, backoffMs, status, rebuild, report, quota }) {
  if (!(deadlineMs > 0)) throw new TypeError('liveness: deadlineMs 必须为正');
  if (!Array.isArray(backoffMs) || backoffMs.length === 0) throw new TypeError('liveness: backoffMs 不能为空');

  let phase = 'idle'; // idle | armed | rebuilding | quarantined
  let timer = null;
  let attempt = 0;
  let disposed = false;

  const disarm = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (ms, task) => {
    timer = setTimeout(task, ms);
    if (typeof timer?.unref === 'function') timer.unref();
  };

  const settle = () => {
    phase = 'idle';
    attempt = 0;
    disarm();
  };

  /** 配额耗尽：不是放弃，而是定时唤醒，到点自动继续。 */
  const quarantine = (freeAt) => {
    phase = 'quarantined';
    const waitMs = freeAt === undefined ? deadlineMs : Math.max(1000, freeAt - Date.now());
    report(`重建配额已用尽，暂停 ${Math.round(waitMs / 1000)}s 再试（避免烧掉飞书连接配额）`);
    schedule(waitMs, () => {
      if (disposed || phase !== 'quarantined') return;
      report('重建配额已恢复，继续重试');
      phase = 'rebuilding';
      void attemptRebuild();
    });
  };

  const attemptRebuild = async () => {
    if (disposed || phase !== 'rebuilding') return;
    if (quota !== undefined && !quota.allows()) {
      quarantine(quota.freeAt());
      return;
    }
    quota?.record();
    attempt += 1;
    report(`看门狗重建长连接（第 ${attempt} 次）`);
    try {
      await rebuild();
      if (disposed || phase !== 'rebuilding') return; // SDK 自己先恢复了，别抢功
      const n = attempt;
      settle();
      report(`看门狗重建成功（第 ${n} 次）`);
    } catch (e) {
      if (disposed || phase !== 'rebuilding') return;
      const backoff = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? deadlineMs;
      report(`看门狗重建失败（${e?.message ?? e}），${Math.round(backoff / 1000)}s 后重试`);
      schedule(backoff, () => {
        void attemptRebuild();
      });
    }
  };

  const fire = () => {
    timer = null;
    if (disposed || phase !== 'armed') return;
    let state;
    try {
      state = status();
    } catch {
      state = undefined;
    }
    if (state === 'connected') {
      settle();
      report('重连期限已到，但传输自报已连接——看门狗待命');
      return;
    }
    phase = 'rebuilding';
    report(`重连停滞超过 ${Math.round(deadlineMs / 1000)}s（状态 ${state ?? 'unknown'}），开始重建`);
    void attemptRebuild();
  };

  return {
    /** 传输报告断开（reconnecting / error）。重复调用不重置已armed的期限。 */
    onDisconnected() {
      if (disposed || phase !== 'idle') return;
      phase = 'armed';
      schedule(deadlineMs, fire);
    },
    /** 传输报告恢复。 */
    onConnected() {
      if (disposed) return;
      if (phase === 'armed') settle();
    },
    dispose() {
      disposed = true;
      disarm();
      phase = 'idle';
    },
    /** 当前阶段（测试/诊断用）。 */
    phase() {
      return phase;
    },
  };
}
