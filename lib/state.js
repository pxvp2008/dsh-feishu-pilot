// lib/state.js —— 意图基础设施 + 内存 token 表。
// 状态模型：权威 1 = SessionMap（核心 mappings.json）——「这个聊天当前绑哪个会话」；
// 权威 2 = state.json（本模块，只存意图）——「这个聊天应该在哪个工作区」。
// state.json 永不存 sessionId（避免双状态源；崩溃收敛恒朝意图，I3/I4）。
// 持久化：$DSH_HOME/dsh-feishu-pilot/state.json（tmp+rename 原子写 + 防抖）：
//   intents；navSeq/navLatest（seq 单调持久化，只保留最新）；repair 冷却截止时间戳。
// 内存态（重启失效属预期）：token 表（LRU + TTL，用后即焚）、volatile 刚换绑标记、
// degraded 标记（可逆，意图永久保留）、切换/修复计数（per-chat 软上限）。

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

import { stateDirOf } from './identity.js';

const STATE_VERSION = 1;

const DEFAULTS = Object.freeze({
  tokenTtlMs: 10 * 60_000,
  tokenLruMax: 200,
  repairCooldownMs: 10 * 60_000,
  repairFailThreshold: 3,
  saveDebounceMs: 300,
});

/** 合并配置（浅校验，缺失回默认）。 */
function resolveStateConfig(config = {}) {
  return {
    tokenTtlMs: Number(config.tokenTtlMs ?? DEFAULTS.tokenTtlMs),
    tokenLruMax: Number(config.tokenLruMax ?? DEFAULTS.tokenLruMax),
    repairCooldownMs: Number(config.repairCooldownMs ?? DEFAULTS.repairCooldownMs),
    repairFailThreshold: Number(config.repairFailThreshold ?? DEFAULTS.repairFailThreshold),
    saveDebounceMs: Number(config.saveDebounceMs ?? DEFAULTS.saveDebounceMs),
  };
}

/**
 * 冻结契约 —— createState(ctx, config) 返回：
 *   getIntent(p, c) / setIntent(p, c, i): Promise / clearIntent(p, c): Promise
 *   hasIntent(msgLike): boolean            // ≡ 存在意图
 *   listIntents(): Array
 *   nextSeq(): number; keepNav(cmd): void; lastNav(maxAgeMs?): cmd|null
 *   issueToken({userId, workspacePath, mode, page, ...rest}): string  // rest 原样透传
 *   validateToken(token, {userId}): payload|null（含 rest 字段）; consumeToken(token): void
 *   withQueue(chatKey, fn): Promise        // per-chat 串行
 *   markSwitched(p, c, sessionId): void; justSwitched(p, c, sessionId): boolean // volatile，一次性
 *   markDegraded(p, c): void; isDegraded(p, c): boolean; clearDegraded(p, c): void
 *   repairGate(p, c): { allow, recordFailure(), reset() }
 *   bumpSwitchCount(p, c): number; switchCount(p, c): number
 *   load(): Promise; dispose(): Promise
 *
 * @param {any} ctx      DSH host ctx（logger 可选）
 * @param {object} [config] { stateDir?, tokenTtlMs?, tokenLruMax?, repairCooldownMs?, repairFailThreshold?, saveDebounceMs? }
 */
export function createState(ctx, config = {}) {
  const cfg = resolveStateConfig(config);
  const dir = stateDirOf(config);
  const file = join(dir, 'state.json');
  const log = (...a) => ctx?.logger?.warn?.(...a);

  /** @type {{version:number, intents:Object<string,{workspacePath:string,mode:string,switchedAt:number}>, navSeq:number, navLatest:object|null, repair:Object<string,{cooldownUntil:number}>}} */
  let data = { version: STATE_VERSION, intents: {}, navSeq: 0, navLatest: null, repair: {} };
  let loaded = false;
  let saveTimer = null;
  let saving = null;

  // ── 内存态 ──
  const tokens = new Map(); // token → {userId, workspacePath, mode, page, createdAt, consumed}
  const queues = new Map(); // chatKey → tail promise
  const switched = new Map(); // chatKey → {sessionId, at}（volatile，一次性消费）
  const degraded = new Set(); // chatKey
  const degradedNotified = new Set(); // chatKey（每聊天一次性提示）
  const repairFailures = new Map(); // chatKey → count
  const switchCounts = new Map(); // chatKey → count

  const keyOf = (p, c) => `${p}:${c}`;

  // ── 持久化 ──
  async function load() {
    if (loaded) return;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      if (raw && raw.version === STATE_VERSION) {
        data = {
          version: STATE_VERSION,
          intents: raw.intents ?? {},
          navSeq: Number(raw.navSeq ?? 0),
          navLatest: raw.navLatest ?? null,
          repair: raw.repair ?? {},
        };
      } else {
        log(`[feishu-pilot] state.json 版本不匹配（${raw?.version}），从空意图启动`);
      }
    } catch {
      /* ENOENT → 空状态 */
    }
    loaded = true;
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void save();
    }, cfg.saveDebounceMs);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  /** 原子写：tmp + rename。 */
  async function save() {
    if (saving) return saving;
    saving = (async () => {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await rename(tmp, file);
    })().finally(() => {
      saving = null;
    });
    return saving;
  }

  async function dispose() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await save().catch((e) => log(`[feishu-pilot] state save on dispose failed: ${e?.message}`));
  }

  // ── 意图（权威 2）──
  /** @returns {null|{workspacePath:string, mode:string, switchedAt:number}} */
  function getIntent(platform, chatId) {
    return data.intents[keyOf(platform, chatId)] ?? null;
  }

  async function setIntent(platform, chatId, intent) {
    data.intents[keyOf(platform, chatId)] = {
      workspacePath: intent.workspacePath,
      mode: intent.mode ?? 'new',
      switchedAt: intent.switchedAt ?? Date.now(),
    };
    // 意图变更 → 退避状态重置（repairToIntent 退避条款）
    repairFailures.delete(keyOf(platform, chatId));
    scheduleSave();
    await save(); // 意图写入是提交点（I4）—— 同步落盘，不依赖防抖
  }

  async function clearIntent(platform, chatId) {
    const k = keyOf(platform, chatId);
    if (!(k in data.intents)) return;
    delete data.intents[k];
    repairFailures.delete(k);
    scheduleSave();
    await save();
  }

  /** ≡ 存在意图 */
  function hasIntent(msgLike) {
    if (!msgLike || typeof msgLike.platform !== 'string' || typeof msgLike.chatId !== 'string') return false;
    return getIntent(msgLike.platform, msgLike.chatId) !== null;
  }

  function listIntents() {
    return Object.entries(data.intents).map(([chatKey, intent]) => ({ chatKey, ...intent }));
  }

  // ── 导航 ──
  function nextSeq() {
    data.navSeq = (data.navSeq ?? 0) + 1;
    return data.navSeq;
  }

  /** 服务端只保留最新导航命令（多标签按 seq 去重；ack 不清队列）。
   *  入队时打时间戳：导航是「切换后立刻跟随」的一次性 UI 同步，陈旧命令不应在下次页面
   *  重载（lastApplied 归 0）时被重放——否则客户端会对已失效的 chat/会话反复重试并 nav.fail。
   */
  function keepNav(cmd) {
    data.navLatest = { ...cmd, enqueuedAt: Date.now() };
    scheduleSave();
  }

  /**
   * 最新导航命令；给 maxAgeMs 时过滤过期命令。
   * 兼容旧持久化状态：没有 enqueuedAt 的命令视为过期（不重放历史命令）。
   */
  function lastNav(maxAgeMs = Infinity) {
    const cmd = data.navLatest;
    if (!cmd) return null;
    if (!Number.isFinite(maxAgeMs)) return cmd;
    const at = Number(cmd.enqueuedAt ?? 0);
    if (!at || Date.now() - at > maxAgeMs) return null;
    return cmd;
  }

  // ── token 表（内存态，LRU + TTL + 用后即焚）──
  // 载荷通用化：除 userId/workspacePath/mode/page 外，其余字段
  // （如「接管指定会话」的 sessionId）原样透传（validateToken 回带）。
  function issueToken({ userId, workspacePath, mode, page = 1, ...rest } = {}) {
    const token = `t-${randomUUID()}`;
    tokens.set(token, { ...rest, userId, workspacePath, mode, page, createdAt: Date.now(), consumed: false });
    while (tokens.size > cfg.tokenLruMax) {
      const oldest = tokens.keys().next().value;
      tokens.delete(oldest);
    }
    return token;
  }

  /** 校验 token：存在 + 未消费 + 未过期 + 点击者 userId 匹配。只绑 userId，不绑 chatId（p2p 回调 chatId 可能与入站不一致）。 */
  function validateToken(token, { userId }) {
    const entry = tokens.get(token);
    if (!entry || entry.consumed) return null;
    if (Date.now() - entry.createdAt > cfg.tokenTtlMs) return null;
    if (entry.userId !== userId) return null;
    const { createdAt: _c, consumed: _x, ...fields } = entry;
    return { token, ...fields };
  }

  /** pick/adopt/new 成功后置 consumed（重推幂等）；retry/nav 保留可重入。 */
  function consumeToken(token) {
    const entry = tokens.get(token);
    if (entry) entry.consumed = true;
  }

  // ── per-chat 串行队列 ──
  async function withQueue(chatKey, fn) {
    const prev = queues.get(chatKey) ?? Promise.resolve();
    const run = prev.then(() => fn());
    queues.set(chatKey, run.then(() => {}, () => {}));
    return run;
  }

  // ── volatile 刚换绑标记（一次性短路对账）──
  function markSwitched(platform, chatId, sessionId) {
    switched.set(keyOf(platform, chatId), { sessionId, at: Date.now() });
  }

  /** 命中即消费（「跳过一次性检查」语义）。 */
  function justSwitched(platform, chatId, sessionId) {
    const k = keyOf(platform, chatId);
    const entry = switched.get(k);
    if (entry && entry.sessionId === sessionId) {
      switched.delete(k);
      return true;
    }
    return false;
  }

  // ── degraded（内存态、可逆；意图永久保留）──
  function markDegraded(platform, chatId) {
    degraded.add(keyOf(platform, chatId));
  }

  function isDegraded(platform, chatId) {
    return degraded.has(keyOf(platform, chatId));
  }

  function clearDegraded(platform, chatId) {
    degraded.delete(keyOf(platform, chatId));
  }

  /** 每聊天一次性提示：返回 true 表示应当提示（且只提示一次，直到状态重置）。 */
  function degradedNotifyOnce(platform, chatId) {
    const k = keyOf(platform, chatId);
    if (degradedNotified.has(k)) return false;
    degradedNotified.add(k);
    return true;
  }

  function resetDegradedNotify(platform, chatId) {
    degradedNotified.delete(keyOf(platform, chatId));
  }

  // ── 修复退避（连续 ≥N 次失败 → 冷却；意图变更/重启后重置）──
  function repairGate(platform, chatId) {
    const k = keyOf(platform, chatId);
    if (!data.repair[k]) data.repair[k] = { cooldownUntil: 0 };
    const rec = data.repair[k];
    const gate = {
      allow: Date.now() >= (rec.cooldownUntil ?? 0),
      recordFailure() {
        const n = (repairFailures.get(k) ?? 0) + 1;
        repairFailures.set(k, n);
        if (n >= cfg.repairFailThreshold) {
          rec.cooldownUntil = Date.now() + cfg.repairCooldownMs;
          repairFailures.delete(k);
          scheduleSave();
        }
      },
      reset() {
        repairFailures.delete(k);
        if (rec.cooldownUntil) {
          rec.cooldownUntil = 0;
          scheduleSave();
        }
      },
    };
    return gate;
  }

  // ── 切换/修复计数（内存态软上限）──
  function bumpSwitchCount(platform, chatId) {
    const k = keyOf(platform, chatId);
    const n = (switchCounts.get(k) ?? 0) + 1;
    switchCounts.set(k, n);
    return n;
  }

  function switchCount(platform, chatId) {
    return switchCounts.get(keyOf(platform, chatId)) ?? 0;
  }

  return {
    file,
    get data() {
      return data;
    },
    load,
    save,
    dispose,
    getIntent,
    setIntent,
    clearIntent,
    hasIntent,
    listIntents,
    nextSeq,
    keepNav,
    lastNav,
    issueToken,
    validateToken,
    consumeToken,
    withQueue,
    markSwitched,
    justSwitched,
    markDegraded,
    isDegraded,
    clearDegraded,
    degradedNotifyOnce,
    resetDegradedNotify,
    repairGate,
    bumpSwitchCount,
    switchCount,
  };
}
