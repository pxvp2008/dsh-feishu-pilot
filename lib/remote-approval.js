// lib/remote-approval.js —— 非绑定（GUI/桌面）会话的飞书审批 answerer（approval/request 瀑布）。
// 绑定会话恒 next() 交核心 ApprovalManager；非绑定会话本模块认领：GUI 与飞书同时发起、竞速，先处理者生效，后处理端一律失效。
// 无人响应 → unavailable（fail-closed）；留痕：状态目录 approvals-global.log（JSONL）。

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { displayTitle } from './remote-title.js';
import { argsSummary } from './core/renderer.js';

const DEFAULT_APPROVAL = Object.freeze({
  enabled: true,
  mode: 'feishu', // 'feishu'（双端同时，默认）| 'gui-first'（仅 GUI，不发飞书卡）| 'off'（同 gui-first）
  timeoutSec: 300, // 飞书卡有效窗口 → 仅飞书侧失效，结果以 GUI 最终结算为准
  targetChatId: '',
});

const RECENT_WINDOW_MS = 30 * 60_000; // 失效/已被响应提示窗口
const DELEGATE = Symbol('delegate'); // 飞书超时 ⇒ 以 chain（GUI）最终结果为准
const CHAIN_WON = Symbol('chain-won'); // GUI 先处理 ⇒ 飞书卡失效
const ABORT = Symbol('abort'); // signal abort / 插件卸载

/**
 * @param {any} ctx
 * @param {{im:any, lark?:any, config?:object, ovrRef?:{current?:object|null}, log?:(...a:any[])=>void, stateDir?:string}} deps
 */
export function createRemoteApproval(ctx, deps) {
  const { im, lark, ovrRef, log = () => {} } = deps;
  const cfgBase = { ...DEFAULT_APPROVAL, ...(deps.config?.remoteApproval ?? {}) };
  const liveCfg = () => ({ ...cfgBase, ...(ovrRef?.current?.remoteApproval ?? {}) });

  /** id → {id, settle, done, timer, abortHandler, toolName, sessionId, createdAt, invalidated} */
  const records = new Map();
  /** id → {ts, invalidatedBy}（失效/已被响应提示用，有界清理） */
  const recent = new Map();

  const logLine = (line) => {
    if (!deps.stateDir) return;
    const p = join(deps.stateDir, 'approvals-global.log');
    void mkdir(dirname(p), { recursive: true })
      .then(() => appendFile(p, JSON.stringify(line) + '\n', 'utf8'))
      .catch(() => {}); // 留痕失败不影响审批主流程
  };

  /** 运行时探针：注册/调用/委派/认领/推送/结算全阶段留痕，独立于留痕主流程。 */
  const dbgLine = (line) => {
    if (!deps.stateDir) return;
    const p = join(deps.stateDir, 'approvals-debug.log');
    void mkdir(dirname(p), { recursive: true })
      .then(() => appendFile(p, `[${new Date().toISOString()}] ` + JSON.stringify(line) + '\n', 'utf8'))
      .catch(() => {});
  };

  /** 诊断辅助：渠道状态快照（渠道缺失时定位用）。 */
  const safeChannels = () => {
    try {
      const st = im?.channelsStatus?.();
      return Array.isArray(st)
        ? st.map((c) => ({ platform: c?.platform, connected: c?.status?.connected }))
        : (st ?? null);
    } catch {
      return 'unavailable';
    }
  };

  /** 目标聊天：显式配置 → 当前 bot 记住的私聊 → null（无目标 ⇒ 委派，不发飞书）。 */
  const resolveTarget = (cfg) => {
    if (cfg.targetChatId) return String(cfg.targetChatId);
    const remembered = im?.map?.notifyChatId;
    return typeof remembered === 'string' && remembered ? remembered : null;
  };

  const platformOf = () => {
    try {
      if (im?.getChannel?.('feishu')) return 'feishu';
      const st = im?.channelsStatus?.();
      return st?.[0]?.platform ?? 'feishu';
    } catch {
      return 'feishu';
    }
  };

  const titleOf = async (sessionId) => {
    try {
      const sessions = ctx.get?.('sessions');
      const s = sessions?.get?.(sessionId);
      let cwd = '';
      if (s?.header?.cwd) {
        const { basename } = await import('node:path');
        cwd = basename(String(s.header.cwd));
      }
      const svc = ctx.get?.('sessionTitle');
      const t = svc?.get?.(s ?? { id: sessionId });
      // 不改 DSH 标题：原样取标题（仅单行化/超长截断），与 GUI 侧栏保持一致
      const raw = typeof t?.title === 'string' ? t.title : '';
      return { title: displayTitle(raw, sessionId, cwd), cwd };
    } catch { /* 兜底 */ }
    return { title: '', cwd: '' };
  };

  /** 向目标聊天推一条提示文本（失效/回执），失败静默。 */
  const pushNote = (platform, target, text) => {
    try {
      return im.push(platform, target, { text }).catch(() => {});
    } catch {
      return undefined;
    }
  };

  /** 把原审批卡改为终态（去掉按钮），避免失效后仍可点击。
   *  所有分支都写 approvals-debug.log（patch-skipped / patch-ok / patch-failed），
   *  否则「卡片没变」只能靠猜：2.1.0 真机曾出现 patch 静默失败、卡片保持可点。 */
  const markCardHandled = async (rec, label, source = 'GUI') => {
    const skip = !rec?.messageId ? 'no-messageId'
      : !lark?.available ? 'lark-unavailable'
        : typeof lark.patchCard !== 'function' ? 'no-patchCard' : null;
    if (skip) {
      dbgLine({ ev: 'patch-skipped', id: rec?.id, why: skip, source });
      return false;
    }
    try {
      await lark.patchCard(rec.messageId, {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: `⚠️ 审批已${label}` }, template: 'grey' },
        elements: [{
          tag: 'div',
          text: { tag: 'lark_md', content: `#${rec.id} 已在 ${source} 端处理（已${label}），本卡片已失效。` },
        }],
      });
      dbgLine({ ev: 'patch-ok', id: rec.id, source, messageId: rec.messageId });
      return true;
    } catch (e) {
      dbgLine({
        ev: 'patch-failed', id: rec.id, source, messageId: rec.messageId,
        err: String(e?.message ?? e), code: e?.code ?? null, status: e?.response?.status ?? null,
      });
      log(`[feishu-pilot] approval card patch failed (#${rec.id}): ${e?.message ?? e}`);
      return false;
    }
  };

  /**
   * 认领一个非绑定会话的审批请求：GUI 与飞书同时发起，先处理者生效。
   * 返回 waterfall outcome。
   */
  async function answer(req, next) {
    const cfg = liveCfg();
    const sessionId = req?.agent?.id;
    dbgLine({ ev: 'called', session: sessionId, tool: req?.toolName ?? '', cfg: { enabled: cfg.enabled, mode: cfg.mode } });
    if (!cfg.enabled || cfg.mode === 'off' || cfg.mode === 'gui-first') {
      dbgLine({ ev: 'delegated', why: 'gui-only-mode', session: sessionId, mode: cfg.mode });
      return next(); // 仅 GUI
    }
    let bound = false;
    try {
      bound = !!(im?.map?.bySessionId?.(sessionId));
    } catch { /* 无 im 面 */ }
    if (bound) {
      dbgLine({ ev: 'delegated', why: 'bound', session: sessionId });
      return next(); // 核心 ApprovalManager 负责
    }
    const platform = platformOf();
    if (!im?.push || !im?.getChannel?.(platform)) {
      dbgLine({ ev: 'delegated', why: 'channel-missing', session: sessionId, platform, hasPush: !!im?.push, hasGetChannel: typeof im?.getChannel, channels: safeChannels() });
      return next(); // 渠道不可用 ⇒ 仅 GUI
    }
    const target = resolveTarget(cfg);
    if (!target) {
      dbgLine({ ev: 'delegated', why: 'no-target', session: sessionId });
      return next();
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const rec = {
      id,
      done: false,
      timer: null,
      abortHandler: null,
      toolName: req?.toolName ?? '',
      sessionId: sessionId ?? '',
      createdAt: Date.now(),
      messageId: '', // 推送成功后记录：回调校验「点的是不是这张卡」（防转发卡越权）
      platform,
      target,
      invalidated: null, // null | 'gui'
      settle: null,
    };
    records.set(id, rec);
    dbgLine({ ev: 'claiming', id, session: sessionId, platform, target, tool: rec.toolName });

    const settle = (v) => {
      if (rec.done) return;
      rec.done = true;
      if (rec.timer) clearTimeout(rec.timer);
      if (rec.abortHandler) req?.signal?.removeEventListener?.('abort', rec.abortHandler);
      records.delete(id);
      recent.set(id, { ts: Date.now(), invalidatedBy: rec.invalidated, outcome: typeof v === 'string' ? v : null });
      pruneRecent();
      dbgLine({ ev: 'settled', id, outcome: String(v), ageMs: Date.now() - rec.createdAt });
      rec._resolve?.(v);
    };
    rec.settle = settle;
    rec._resolve = null;

    const reason = req?.displayReason?.zh ?? req?.displayReason?.en ?? req?.reason ?? '';
    const info = await titleOf(sessionId);
    const title = displayTitle(info.title, sessionId, info.cwd);
    const timeoutSec = Math.max(0.1, Number(cfg.timeoutSec) || 300);
    const snap = req?.callId ? callSnapshots.get(req.callId) : null;
    const text = [
      `#${id} · 会话 ${title}`,
      `工具：${req?.toolName ?? 'unknown'}`,
      ...(snap?.args ? [`参数：${snap.args}`] : []),
      ...(reason ? [String(reason).slice(0, 300)] : []),
      `（GUI 与飞书同时受理，任一端先处理即生效；${timeoutSec}s 内飞书未响应则仅 GUI 有效）`,
    ].join('\n');
    rec.text = text;

    const waitPromise = new Promise((resolve) => {
      rec._resolve = resolve;
    });

    try {
      const pushed = await im.push(platformOf(), target, {
        text,
        title: '🔐 审批请求',
        buttons: [
          { id: `gapp:${id}:yes`, label: '✅ 批准', style: 'primary' },
          { id: `gapp:${id}:no`, label: '❌ 拒绝', style: 'danger' },
        ],
      });
      if (pushed && typeof pushed === 'object') rec.messageId = String(pushed.messageId ?? '');
      dbgLine({ ev: 'pushed', id, platform, target, messageId: rec.messageId });
    } catch (e) {
      dbgLine({ ev: 'push-failed', id, err: String(e?.message ?? e), channels: safeChannels() });
      records.delete(id);
      log(`[feishu-pilot] remote approval card push failed — delegating: ${e?.message}`);
      return next(); // 发卡失败 ⇒ 仅 GUI
    }

    // 双端同时发起：立即 next()（GUI answerer 展示并等待）与飞书卡竞速。
    // 注意：waterfall 的 next() 可能返回非 Promise 同步值 ⇒ 一律 Promise.resolve 包裹。
    let chainP;
    try {
      chainP = Promise.resolve(next());
    } catch (e) {
      chainP = Promise.reject(e);
    }
    let chainVal = undefined;
    let chainErr = null;
    const chainSettledP = new Promise((res) => {
      chainP.then((v) => { chainVal = v; res(); }, (e) => { chainErr = e; res(); });
    });
    void (async () => {
      await chainSettledP;
      if (chainErr || chainVal === 'unavailable') return; // 无下游应答者 ⇒ 飞书继续有效
      if (rec.done) return; // 飞书已先胜
      rec.invalidated = 'gui';
      dbgLine({ ev: 'invalidated-by-gui', id, guiOutcome: chainVal });
      const label = chainVal === 'allowed-once' ? '批准' : '拒绝';
      const patched = await markCardHandled(rec, label);
      if (!patched) {
        await pushNote(platform, target,
          `⚠️ 审批 #${id} 已在 GUI 端处理（已${label}），本卡片已失效。`);
      }
      settle(CHAIN_WON);
    })();

    rec.timer = setTimeout(() => settle(DELEGATE), timeoutSec * 1000);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();
    if (req?.signal) {
      if (req.signal.aborted) {
        settle(ABORT);
      } else {
        rec.abortHandler = () => settle(ABORT);
        req.signal.addEventListener('abort', rec.abortHandler, { once: true });
      }
    }

    const outcome = await waitPromise;
    if (outcome === ABORT) {
      await pushNote(platform, target, `ℹ️ 审批 #${id} 已取消（会话中断）。`);
      return 'cancelled';
    }
    if (outcome === CHAIN_WON) {
      return chainVal; // GUI 先处理 ⇒ 回传 GUI 结果
    }
    if (outcome === DELEGATE) {
      dbgLine({ ev: 'feishu-timeout', id });
      await chainSettledP; // 飞书侧失效；结果以 GUI 最终结算为准
      if (chainErr) throw chainErr;
      return chainVal; // 'unavailable'（GUI 也未答）或 GUI 迟到的结果
    }
    // 飞书胜出：按钮回调侧已写审计 + 发回执 ⇒ 此处直接回传结果
    return outcome;
  }

  function pruneRecent() {
    const now = Date.now();
    for (const [k, v] of recent) if (now - v.ts > RECENT_WINDOW_MS) recent.delete(k);
  }

  /**
   * 飞书按钮回调（bridge.js 路由 gapp:* 到此处）。
   * data = 'gapp:<id>:yes|no'；身份校验：点击者必须 ∈ allowlist。
   * @param {{platform:string, chatId:string, userId:string, userName?:string, data:string}} p
   */
  async function onCallback(p) {
    const parts = String(p?.data ?? '').split(':');
    if (parts[0] !== 'gapp' || parts.length < 3) return;
    const [, id, answer] = parts;
    const reply = (t) => pushNote(p.platform, p.chatId, t);
    const rec = records.get(id);
    if (!rec) {
      const meta = recent.get(id);
      if (meta?.invalidatedBy === 'gui') {
        const label = meta.outcome === 'allowed-once' ? '批准' : meta.outcome === 'rejected' ? '拒绝' : '处理';
        return reply(`ℹ️ 审批 #${id} 已在 GUI 端处理（已${label}），本卡片已失效。`);
      }
      const r = meta ? 'ignored' : 'not-found';
      return reply(r === 'ignored' ? `ℹ️ 审批 #${id} 已被响应或已结束。` : `ℹ️ 审批 #${id} 不存在或已结束。`);
    }
    let allowed = false;
    try {
      allowed = im.map.isAllowed(p.platform, p.userId);
    } catch { /* 无 */ }
    if (!allowed) {
      return reply(`⛔ 无权限：审批需要飞书可信用户身份（当前 ${p.platform}:${p.userId} 未授权）。`);
    }
    // 卡片消息 id 校验：点击的必须是当初推出去的那张卡（转发/旧卡一律拒绝）
    if (rec.messageId && p.messageId && rec.messageId !== p.messageId) {
      return reply(`⛔ 请在原聊天中操作该审批（这张卡片已被转发或不是审批目标）。`);
    }
    if (answer !== 'yes' && answer !== 'no') {
      return reply(`ℹ️ 无法识别的响应：${answer}`);
    }
    const who = p.userName || p.userId;
    rec.settle(answer === 'yes' ? 'allowed-once' : 'rejected');
    // 先发回执再改卡：patch 失败也不影响主流程；失败时补一条说明，避免用户以为卡还能点
    void markCardHandled(rec, answer === 'yes' ? '批准' : '拒绝', '飞书').then((ok) => {
      if (!ok) {
        return pushNote(p.platform, p.chatId,
          `⚠️ 审批 #${id} 已处理，但原卡片状态未更新成功（以本条回执为准）。`);
      }
      return undefined;
    });
    logLine({
      id,
      responder: `${p.platform}:${p.userId}${p.userName ? ` (${p.userName})` : ''}`,
      answer,
      at: new Date().toISOString(),
    });
    return reply(answer === 'yes' ? `✅ 已批准 #${id}（${who}），任务继续执行。` : `❌ 已拒绝 #${id}（${who}）。`);
  }

  // waterfall answerer（与核心 ApprovalManager 并存）。
  // approval/request 是单决策瀑布：先注册的 answerer 认领后链即停止（base 层的 GUI
  // 转发 answerer 把请求送进界面并等待点击，不再向下）。本插件在 profile 层加载、
  // push 注册必然排在 base 之后 ⇒ 从未轮到。prepend: true 置链首取得首认领权；
  // global: true 保证对 agent 作用域派发可见（scope 谓词本身放行无标签 ctx，双保险）。
  // 未认领（绑定会话/仅 GUI 模式/渠道缺/无目标）一律 next() 交回原链 ⇒ GUI 兜底不变。
  const dAnswer = ctx.on('approval/request', (req, next) => answer(req, next), { global: true, prepend: true });

  // 工具调用参数快照：审批卡要能显示「到底批准什么」（仅内存，200 条上限）。
  // 只记录不拦截，原样 next() 交回链。
  const callSnapshots = new Map();
  const dCapture = ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (exec?.callId) {
        callSnapshots.set(exec.callId, {
          tool: exec.name,
          args: argsSummary(JSON.stringify(exec.arguments ?? {})),
          at: Date.now(),
        });
        if (callSnapshots.size > 200) callSnapshots.delete(callSnapshots.keys().next().value);
      }
    } catch { /* 快照失败不影响审批 */ }
    return next();
  }, { global: true, prepend: true });

  // 运行时探针：观察每次派发并快照共享链状态（internal/dispatch 不带 carrier
  // ⇒ 无 scope 过滤 ⇒ 所有监听者可见）。
  const dObserve = ctx.on('internal/dispatch', (mode, name, _args, thisArg) => {
    if (name !== 'approval/request') return;
    let verdict = 'no-carrier';
    try {
      const f = thisArg && thisArg[Symbol.for('cordis.filter')];
      if (typeof f === 'function') verdict = f.call(thisArg, ctx) ? 'my-ctx-ADMITTED' : 'my-ctx-FILTERED-OUT';
      else verdict = 'carrier-without-filter-fn';
    } catch (e) {
      verdict = 'filter-threw:' + String(e?.message ?? e);
    }
    let hooksLen = 'err';
    try {
      const h = ctx.events?._hooks?.['approval/request'];
      hooksLen = Array.isArray(h) ? h.length : 'no-array';
    } catch { /* 忽略 */ }
    dbgLine({ ev: 'dispatch-seen', mode, verdict, myHooksLen: hooksLen });
  });

  let answererHooks = 'err';
  try {
    const h = ctx.events?._hooks?.['approval/request'];
    answererHooks = Array.isArray(h) ? h.map((x) => ({ global: !!x.global, hasCallback: typeof x.callback === 'function' })) : 'no-array';
  } catch { /* 忽略 */ }
  dbgLine({
    ev: 'registered',
    platform: platformOf(),
    channelFeishu: !!im?.getChannel?.('feishu'),
    hasPush: !!im?.push,
    channels: safeChannels(),
    cfg: liveCfg(),
    typeofDAnswer: typeof dAnswer,
    answererHooks,
  });

  return {
    onCallback,
    pending: () => records.size,
    liveCfg,
    dispose() {
      dAnswer?.();
      dObserve?.();
      dCapture?.();
      callSnapshots.clear();
      for (const rec of [...records.values()]) {
        try {
          rec.settle?.(ABORT);
        } catch { /* 已定 */ }
      }
      records.clear();
      recent.clear();
    },
  };
}

export { DEFAULT_APPROVAL };
