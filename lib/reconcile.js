// lib/reconcile.js —— 只读对账（意图 × 权威绑定 × 成员关系）。
// 铁律：对账查询全程只读 —— 禁止 workspaceRegistry.create()（注册副作用）；
//       工作区不可用（未注册/未就绪/已删）→ 内存态 degraded（可逆）+ 每聊天一次性提示，
//       绝不删意图。
// 判据：一致 = ws.sessionIds.includes(binding.sessionId)              （成员关系，主判据）
//        OR resolveCwd(sessionId) 规范化后 === ws.path             （放宽项，feature-detect）
//
// 冻结契约：
//   lookupWorkspace(ctx, path): Promise<wsEntity|null>
//   consistent(ws, binding, intent, {ctx}): Promise<boolean>
//   ensureBinding(ctx, deps, msg): Promise<void>
//     deps = { state, im, repair(msg, intent, ws): Promise, notify(msg, text): Promise<void> }

import { realpath } from 'node:fs/promises';

/**
 * 只读解析工作区实体。
 * 首选 workspaceRegistry.resolveByPath(path)（DSH 实测存在的只读查询面：
 * get() 只按 id 查；resolveByPath 做 realpath 后按 canonical path 匹配，未命中返回
 * undefined，不存在的路径 reject —— 全部按「不可用」处理，绝不注册）。
 * 退化路径：realpath + list().find（list() 是同步投影，无持久化读）。
 * @param {any} ctx
 * @param {string} path
 * @returns {Promise<any|null>}
 */
export async function lookupWorkspace(ctx, path) {
  const reg = ctx?.workspaceRegistry;
  if (!reg || typeof reg.list !== 'function') return null;
  if (typeof reg.resolveByPath === 'function') {
    try {
      return (await reg.resolveByPath(path)) ?? null;
    } catch {
      return null; // realpath 失败 = 目录不存在 ⇒ 不可用
    }
  }
  try {
    const canonical = await realpath(path);
    return reg.list().find((w) => w.path === canonical) ?? null;
  } catch {
    return null;
  }
}

/**
 * 会话 cwd 可读性（feature-detect）：
 * 优先 live sessions 服务的 header.cwd，退化到 workspaceRegistry 内部的 headers 面不存在时返回 null。
 * @param {any} ctx
 * @param {string} sessionId
 * @returns {Promise<string|null>} 规范化 cwd 或 null
 */
async function resolveSessionCwd(ctx, sessionId) {
  const raw = ctx?.get?.('sessions')?.get?.(sessionId)?.header?.cwd;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return await realpath(raw);
  } catch {
    return null;
  }
}

/**
 * 一致性判据：成员关系 OR cwd 相同（放宽项）。
 * @param {any} ws        工作区实体（.path/.sessionIds）
 * @param {any} binding   SessionMap 绑定（.sessionId）
 * @param {any} intent    意图（.workspacePath）
 * @param {{ctx?: any}} [opt]
 * @returns {Promise<boolean>}
 */
export async function consistent(ws, binding, intent, opt = {}) {
  if (!ws || !binding?.sessionId) return false;
  const ids = ws.sessionIds ?? [];
  if (ids.includes(binding.sessionId)) return true;
  // 放宽判据：cwd 可读且与意图工作区路径一致（覆盖未 attach 的原生会话）
  const cwd = await resolveSessionCwd(opt.ctx, binding.sessionId);
  if (cwd && intent?.workspacePath) {
    try {
      const target = await realpath(intent.workspacePath);
      if (cwd === target) return true;
    } catch {
      /* 意图路径不可解析 ⇒ 仅成员关系判据 */
    }
  }
  return false;
}

/**
 * ensureBinding：意图 × 权威 × 成员关系 三方对账（dispatchInbound 包装器内，只读对账版）。
 * 短路顺序：无意图 → 原生行为；无绑定 → 原生管线；volatile 刚换绑 → 跳过（一次性）；
 * degraded 冷却中 → 跳过（一次性提示已发）；工作区不可用 → markDegraded + 一次性提示；
 * 一致 → 完成；不一致 → deps.repair（repairToIntent，退避在其内）。
 *
 * @param {any} ctx
 * @param {{state:any, im:any, repair:(msg:any, intent:any, ws:any)=>Promise<any>, notify:(msg:any, text:string)=>Promise<void>}} deps
 * @param {any} msg  ImMessage（{platform, chatId, userId, ...}）
 * @returns {Promise<void>}
 */
export async function ensureBinding(ctx, deps, msg) {
  const { state, im, repair, notify } = deps;
  const intent = state.getIntent(msg.platform, msg.chatId);
  if (!intent) return; // 未托管聊天 → 原生行为
  const binding = im.map.get(msg.platform, msg.chatId);
  if (!binding) return; // 无绑定 → 原生管线处理
  if (state.justSwitched(msg.platform, msg.chatId, binding.sessionId)) return; // volatile 短路
  // 注意：degraded 不做早退 —— 每条消息都重新只读探测（realpath 级成本），
  // 否则工作区恢复后永远无法自愈（degraded 只抑制重复提示，由 notifyOnce 门控）。
  const ws = await lookupWorkspace(ctx, intent.workspacePath);
  if (!ws) {
    state.markDegraded(msg.platform, msg.chatId);
    if (state.degradedNotifyOnce(msg.platform, msg.chatId)) {
      await notify?.(msg, '⚠️ 目标工作区暂不可用（未注册/目录不存在/已注销），已暂停自动对账；恢复后自动继续。');
    }
    return; // 绝不 create() 注册、绝不删意图
  }
  const wasDegraded = state.isDegraded(msg.platform, msg.chatId);
  state.clearDegraded(msg.platform, msg.chatId);
  if (wasDegraded) state.resetDegradedNotify(msg.platform, msg.chatId); // 恢复 ⇒ 下次降级可再提示
  if (await consistent(ws, binding, intent, { ctx })) return;
  await repair(msg, intent, ws); // 不一致 → 朝意图修复（罕见路径，退避在 repair 内）
}
