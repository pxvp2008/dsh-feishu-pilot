// lib/remote-notify.js —— 任意会话任务结束 → 飞书通知：补核心 NotifyBus 只推 IM 绑定会话的缺口。
// 事件源（host 全局，不限会话归属）：session/event turn/start 计时、assistant/message 摘要源、
// turn/end 触发、agent/error 失败通知。

import { basename } from 'node:path';
import { summarizeMarkdown } from './core/renderer.js';

const DEFAULT_NOTIFY = Object.freeze({
  enabled: true,
  targetChatId: '',
  includeBound: false,
  includeSubagents: false,
  maxSummaryChars: 300,
  rateLimitMs: 30_000,
});

/** 标题提取：兼容快照对象 {title,...} 与字符串形态假件（与 session-picker 同款）。 */
function titleOf(snap) {
  if (snap && typeof snap.title === 'string') return snap.title;
  if (typeof snap === 'string') return snap;
  return '';
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * 冻结契约：createRemoteNotify(ctx, deps) => { dispose(): void }
 * deps = { im, config, ovrRef, lark, log }
 * config.notify = { enabled, targetChatId, includeBound, includeSubagents,
 *                   maxSummaryChars, rateLimitMs }
 * ovrRef = { current: object|null }（im-overrides.json 现值，UI 即时翻转）
 * 默认过滤（防刷屏/防双推）：绑定会话跳过（核心已推结果卡到绑定聊天，
 * notify.includeBound 可开）；subagent 子会话跳过（session.header.origin === 'subagent'，
 * notify.includeSubagents 可开）；每会话限流 notify.rateLimitMs。
 * @param {any} ctx
 * @param {{im:any, config?:object, ovrRef?:{current?:object|null}, lark?:any, log?:(...a:any[])=>void}} deps
 */
export function createRemoteNotify(ctx, deps) {
  const { im, lark, ovrRef, log = () => {} } = deps;
  const cfgBase = { ...DEFAULT_NOTIFY, ...(deps.config?.notify ?? {}) };
  /** 现值 = 配置 ∪ UI 覆盖（每次事件读，翻转即时生效）。 */
  const live = () => ({ ...cfgBase, ...(ovrRef?.current?.notify ?? {}) });

  /** sessionId → {turnStartAt, turnText, lastText, lastNotifyAt} */
  const sessions = new Map();
  const stOf = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { turnStartAt: 0, turnText: '', lastText: '', lastNotifyAt: 0 };
      sessions.set(id, s);
    }
    return s;
  };

  const isExcluded = (session, cfg) => {
    if (session?.header?.origin === 'subagent' && !cfg.includeSubagents) return true;
    try {
      // 绑定会话的通知一律归核心 NotifyBus（文本结果卡）：未静音时核心推，静音时核心不推
      // ⇒ 本模块必须跳过，否则「/mute」无法真正静音，且未静音时会出现双推。
      // 历史 includeBound 开关不再对绑定会话生效（保留字段只为配置兼容）。
      if (im?.map?.bySessionId?.(session.id)) return true;
    } catch { /* im 面异常 ⇒ 不拦 */ }
    return false;
  };

  /**
   * 目标聊天（只认当前 bot 身份域内的确定值）：
   * 1) 显式 targetChatId；
   * 2) 当前机器人记住的通知私聊 chatId（首个授权用户/授权用户私聊时写入，
   *    换 bot 时随身份清空并由新 bot 首次接触重新写入）；
   * 3) null（通知关闭）。
   */
  let targetLogged = false;
  const resolveTarget = (cfg) => {
    if (cfg.targetChatId) return String(cfg.targetChatId);
    const remembered = im?.map?.notifyChatId;
    if (typeof remembered === 'string' && remembered) return remembered;
    if (!targetLogged) {
      targetLogged = true;
      log('[feishu-pilot] remote notify: 无目标聊天（未配置 targetChatId，且当前机器人尚无授权用户私聊）—— 通知关闭中');
    }
    return null;
  };

  /** 发送平台：feishu 渠道在则用之，否则第一个已注册渠道（e2e mock 兼容）。 */
  const platformOf = () => {
    try {
      if (im?.getChannel?.('feishu')) return 'feishu';
      const st = im?.channelsStatus?.();
      return st?.[0]?.platform ?? 'feishu';
    } catch {
      return 'feishu';
    }
  };

  const titleOfSession = async (session) => {
    try {
      const svc = ctx.get?.('sessionTitle');
      const t = titleOf(svc?.get?.(session));
      if (t) return t;
    } catch { /* 兜底 */ }
    const cwd = session?.header?.cwd;
    return cwd ? `${basename(String(cwd))}（${String(session.id).slice(0, 8)}）` : String(session.id).slice(0, 8);
  };

  const wsTitleOf = async (session) => {
    try {
      const reg = ctx.get?.('workspaceRegistry');
      const cwd = session?.header?.cwd;
      if (reg?.resolveByPath && cwd) {
        const ws = await reg.resolveByPath(String(cwd));
        if (ws?.title) return String(ws.title);
      }
    } catch { /* 未注册工作区等 */ }
    const cwd = session?.header?.cwd;
    return cwd ? basename(String(cwd)) : '';
  };

  /** 发送：lark 可用 → 富卡；不可用或发卡失败 → im.push 纯文本（渠道长连接在即可达）。 */
  const send = async (target, { template, title, lines, summary }) => {
    const text = [title, ...lines, ...(summary ? ['', summary] : [])].join('\n');
    if (lark?.available) {
      try {
        await lark.sendCard(target, {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: title }, template },
          elements: [
            { tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } },
            ...(summary ? [{ tag: 'hr' }, { tag: 'div', text: { tag: 'plain_text', content: summary } }] : []),
          ],
        });
        return;
      } catch (e) {
        log(`[feishu-pilot] remote notify card failed, falling back to text: ${e?.message}`);
      }
    }
    try {
      await im.push(platformOf(), target, { text });
    } catch (e) {
      log(`[feishu-pilot] remote notify text send failed: ${e?.message}`);
    }
  };

  async function onTurnEnd(session, event) {
    const cfg = live();
    if (!cfg.enabled) return;
    if (isExcluded(session, cfg)) return;
    const target = resolveTarget(cfg);
    if (!target) return;
    const st = stOf(session.id);
    const now = Date.now();
    if (now - st.lastNotifyAt < cfg.rateLimitMs) return;
    const kind = event?.data?.reason?.kind;
    const ok = kind === 'completed' || kind === undefined || kind === null;
    const maxChars = Math.max(50, Number(cfg.maxSummaryChars) || 300);
    const summary = summarizeMarkdown(st.turnText || st.lastText || '', { maxChars, maxLines: 8 });
    const lines = [];
    const title = await titleOfSession(session);
    const ws = await wsTitleOf(session);
    lines.push(`会话：${title}`);
    if (ws) lines.push(`工作区：${ws}`);
    const dur = fmtDuration(st.turnStartAt ? now - st.turnStartAt : NaN);
    if (dur) lines.push(`耗时：${dur}`);
    const head = ok
      ? '✅ 任务完成'
      : `⚠️ 任务结束（${kind ?? 'unknown'}）`;
    await send(target, {
      template: ok ? 'green' : 'orange',
      title: head,
      lines,
      summary,
    });
    st.lastNotifyAt = now;
    st.lastText = '';
    st.turnText = '';
    st.turnStartAt = 0;
  }

  async function onAgentError({ agent, error }) {
    if (!agent?.id) return;
    const cfg = live();
    if (!cfg.enabled) return;
    // 只补核心未覆盖的会话（绑定会话的失败通知归核心通知总线）
    let bound = false;
    try {
      bound = !!(im?.map?.bySessionId?.(agent.id));
    } catch { /* 无 */ }
    if (bound && !cfg.includeBound) return;
    const target = resolveTarget(cfg);
    if (!target) return;
    const st = stOf(agent.id);
    const now = Date.now();
    if (now - st.lastNotifyAt < cfg.rateLimitMs) return;
    const title = await titleOfSession({ id: agent.id });
    const msg = String(error?.message ?? error ?? 'unknown').slice(0, 300);
    await send(target, {
      template: 'red',
      title: '❌ 会话运行出错',
      lines: [`会话：${title}`, `错误：${msg}`],
      summary: '',
    });
    st.lastNotifyAt = now;
  }

  function onSessionEvent(session, event) {
    if (!session?.id || !event?.type) return;
    const st = stOf(session.id);
    switch (event.type) {
      case 'turn/start':
        st.turnStartAt = Date.now();
        st.turnText = '';
        st.lastText = '';
        break;
      case 'assistant/message': {
        try {
          const blocks = event?.data?.message?.content;
          if (Array.isArray(blocks)) {
            const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
            if (text) {
              st.lastText = text.slice(-500);
              // 整轮累积（多段 assistant/message 拼接）；结果卡摘要取开头
              st.turnText = (st.turnText ? `${st.turnText}\n` : '') + text;
              if (st.turnText.length > 20_000) st.turnText = st.turnText.slice(0, 20_000);
            }
          }
        } catch { /* 形态异常不拦主流程 */ }
        break;
      }
      case 'turn/end':
        void onTurnEnd(session, event).catch((e) => log(`[feishu-pilot] remote notify turn/end failed: ${e?.message}`));
        break;
      default:
        break;
    }
  }

  const dSession = ctx.on('session/event', onSessionEvent);
  const dError = ctx.on('agent/error', (payload) => {
    void onAgentError(payload).catch((e) => log(`[feishu-pilot] remote notify error failed: ${e?.message}`));
  });

  return {
    dispose() {
      dSession?.();
      dError?.();
      sessions.clear();
    },
  };
}

export { DEFAULT_NOTIFY };
