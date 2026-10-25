// lib/rebind.js —— 换绑核心：双索引原子维护 + save 失败回滚 + 落盘校验。
// 核心 SessionMap（lib/core/session-map.js）事实：
//   - sessionId 默认是 chat 的确定性映射（im-${platform}-${safe(chatId)}），SessionMap.create()
//     对已存在 key 直接返回旧绑定 ⇒ 「同一聊天换工作区」必须用唯一随机 sessionId；
//   - bySession（sessionId→chatKey 反查索引）只在 create/remove 中维护 ⇒ 直改
//     binding.sessionId 会让索引失配 ⇒ 通知总线 / /log 对该会话静默失效；
//   - save() 有合并语义（if (this._saving) return this._saving）⇒ 直写后若撞上在飞保存，
//     读回的可能仍是变更前快照 ⇒ verifyPersisted() 读回比对、不符重存。
// 不变式：I1 换绑只替换既有绑定（或首建），chats.size 不膨胀；
// I4 rebind 是切换提交点后的一步 —— 失败必须回滚内存索引并重抛（意图恢复由 switcher 负责）。

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * 冻结契约：
 * @typedef {Object} RebindDeps
 * @property {any} ctx        DSH host ctx（ctx.agents.get / ctx.logger 仅用于尽力查重与告警）。
 * @property {any} im         核心 FeishuImCore（im.map = SessionMap）。
 */

/**
 * 唯一会话 id：形态与核心确定性 id 同族（im-<platform>-<slug>-<rand>），绝不与
 * 确定性 id（im-<platform>-<slug>）重合。查重为尽力而为（只能发现存活 agent），最终保证来自
 * agents.create 失败 + 回滚。
 * @param {any} ctx
 * @param {string} platform
 * @param {string} chatId
 * @returns {string}
 */
export function freshSessionId(ctx, platform, chatId) {
  const slug = String(chatId).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'chat';
  for (let i = 0; i < 5; i++) {
    const id = `im-${platform}-${slug}-${randomUUID().slice(0, 8)}`;
    try {
      if (!ctx?.agents?.get?.(id)) return id;
    } catch {
      return id; // agents 面不可用时直接放行，交给 create 兜底
    }
  }
  return `im-${platform}-${slug}-${randomUUID()}`;
}

/**
 * 换绑：双索引原子维护（先建新后删旧）+ 自检断言 + save 失败回滚 + 落盘校验。
 * 返回旧绑定（仅供结果/失败卡内容「从 X 切到 Y」，不用于回滚）。
 *
 * @param {any} ctx
 * @param {any} im
 * @param {string} platform
 * @param {string} chatId
 * @param {string} newSessionId
 * @returns {Promise<null|{platform:string, chatId:string, chatType:string, sessionId:string, createdAt:number, lastActivityAt:number}>} 旧绑定（首绑时为 null）
 */
export async function rebind(ctx, im, platform, chatId, newSessionId) {
  const key = `${platform}:${chatId}`;
  const map = im.map;
  const old = map.chats.get(key) ?? null;
  map.chats.set(key, old
    ? { ...old, sessionId: newSessionId, lastActivityAt: Date.now() }
    : {
      platform,
      chatId: String(chatId),
      chatType: 'private',
      sessionId: newSessionId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      users: new Map(),
    });
  map.bySession.set(newSessionId, key);
  if (old) map.bySession.delete(old.sessionId);

  // 自检断言：新 id 反查命中且旧 id 反查已清 —— 失败即回滚并抛「上游结构变更」级错误。
  const ok = map.bySession.get(newSessionId) === key && (!old || !map.bySession.has(old.sessionId));
  if (!ok) {
    rollbackRebind(map, key, old, newSessionId);
    const err = new Error('核心 SessionMap 结构已变化，rebind 自检失败（SessionMap 契约变更需同步本模块）');
    err.upgradeHint = true;
    throw err;
  }
  try {
    await map.save(); // 原子写；失败即回滚内存态
  } catch (e) {
    rollbackRebind(map, key, old, newSessionId);
    throw e;
  }
  await verifyPersisted(ctx, im, key, newSessionId); // 落盘校验
  return old;
}

/**
 * 落盘校验：直写可能撞上在飞保存（save() 合并语义返回的是变更前快照的 promise）⇒
 * 读回比对；不符则重存（此刻在飞保存必已结束，重存必为新鲜快照）。两次仍不符只告警：
 * 内存态已正确，防抖落盘 + 成员关系自愈兜底。
 * @param {any} ctx
 * @param {any} im
 * @param {string} key   `${platform}:${chatId}`
 * @param {string} expectedId
 * @returns {Promise<void>}
 */
export async function verifyPersisted(ctx, im, key, expectedId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = JSON.parse(await readFile(im.map.file, 'utf8'));
      if ((raw.chats ?? []).some((c) => `${c.platform}:${c.chatId}` === key && c.sessionId === expectedId)) return;
    } catch {
      /* 读失败按未命中处理 */
    }
    await im.map.save();
  }
  ctx?.logger?.warn?.('[feishu-pilot] mappings.json 落盘校验未命中：内存态正确，等待下次防抖落盘；成员关系自愈兜底');
}

/**
 * rebind 回滚：恢复旧绑定与旧反查（首绑时删 key），清掉新反查，尽力落盘。
 * @param {any} map    SessionMap
 * @param {string} key
 * @param {null|object} old
 * @param {string} newSessionId
 * @returns {void}
 */
export function rollbackRebind(map, key, old, newSessionId) {
  if (old) {
    map.chats.set(key, old);
    map.bySession.set(old.sessionId, key);
  } else {
    map.chats.delete(key);
  }
  map.bySession.delete(newSessionId);
  void map.save();
}
