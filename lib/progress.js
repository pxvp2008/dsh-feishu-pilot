// lib/progress.js —— 绑定会话的流式进度卡（0.13.x）。
//
// turn/start 发一张卡；assistant/chunk 按 intervalMs 节流 patch 同一张卡（文本尾部 + 工具行）；
// tool/call / tool/result 更新「工具行」（名称 + 参数摘要 + 运行/完成/失败状态）；
// turn/end / agent/error 终态 patch，并把耗时/token 统计融合进终态卡。
// 绑定会话不再另发结果卡（结果卡仅用于非绑定会话的 remote-notify）。

import { markdownToText } from './core/renderer.js';

const DEFAULT_PROGRESS = Object.freeze({
  enabled: true,
  intervalMs: 1500,
  patchTerminal: false,
  toolLines: true,
  maxTools: 8,
  maxTextChars: 4000,
});

const TOOL_ICON = { running: '⏳', done: '✅', error: '❌' };

/** 工具参数的一行摘要（尽量显示“在操作什么”）。 */
function briefArgs(name, args) {
  let a = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { a = {}; }
  }
  if (!a || typeof a !== 'object') a = {};
  const pick = (...keys) => {
    for (const k of keys) if (typeof a[k] === 'string' && a[k].trim()) return a[k].trim();
    return '';
  };
  const raw = pick('command', 'file_path', 'path', 'pattern', 'query', 'url', 'text', 'description')
    || JSON.stringify(a);
  const oneLine = String(raw).replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

function toolLine(name, brief, state) {
  return `${TOOL_ICON[state] ?? '•'} \`${name}\`${brief ? ` ${brief}` : ''}`;
}

/** 终态统计行：耗时 + token（与结果卡同款格式）。 */
function statsLine(durationMs, usage) {
  const meta = [];
  if (durationMs != null) meta.push(`⏱ ${(durationMs / 1000).toFixed(1)}s`);
  if (usage && (usage.inputTokens || usage.outputTokens)) {
    meta.push(`🔢 ${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out tokens`);
  }
  return meta.join(' · ');
}

/** 模型 Markdown → lark_md 能正常显示的纯文本（去表格竖线、代码围栏、行内标记）。 */
function toCardText(md) {
  return markdownToText(String(md ?? ''))
    .split('\n')
    .filter((line) => !/^\s*```/.test(line))
    .join('\n')
    .trim();
}

/** tool/result 失败判定：isError，或内容里出现非零 `[exit code: N]`（pwsh 失败但 isError=false）。 */
function resultFailed(msg, data) {
  if (data?.isError || msg?.isError) return true;
  const text = (msg?.content ?? []).map((b) => b.text ?? '').join('\n');
  const m = text.match(/\[exit code:\s*(-?\d+)\]/);
  return !!m && Number(m[1]) !== 0;
}

/**
 * 冻结契约：createProgress(ctx, deps) => { dispose(): void }
 * deps = { state, im, cards, lark, config }；config.progress 覆盖 DEFAULT_PROGRESS。
 * 只跟踪 im 绑定会话；lark 不可用时不发卡。
 */
export function createProgress(ctx, deps) {
  const { im, lark, config = {}, diag = () => {} } = deps;
  const cfg = { ...DEFAULT_PROGRESS, ...(config.progress ?? {}) };
  const log = (...a) => { ctx?.logger?.warn?.(...a); diag(`progress: ${a.map((x) => String(x)).join(' ')}`); };

  /** sessionId → { messageId, lastPatchAt, text, tools: Map<callId, {name,brief,state}>, order: callId[] } */
  const sessions = new Map();
  const bound = (sessionId) => im.map.bySessionId(sessionId);

  const renderCard = (s, title, template) => {
    const plain = toCardText(s.text);
    const elements = [{
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: plain ? `…${plain.slice(-cfg.maxTextChars)}` : '⏳ 进行中…',
      },
    }];
    if (cfg.toolLines && s.order.length) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: s.order
            .map((id) => s.tools.get(id))
            .filter(Boolean)
            .map((t) => toolLine(t.name, t.brief, t.state))
            .join('\n'),
        },
      });
    }
    if (s.stats) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: s.stats } });
    }
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: title }, template },
      elements,
    };
  };

  const stateOf = (sessionId) => {
    let s = sessions.get(sessionId);
    if (!s) {
      s = { messageId: null, lastPatchAt: 0, text: '', tools: new Map(), order: [], turnStartAt: 0, usage: null, stats: '' };
      sessions.set(sessionId, s);
    }
    return s;
  };

  const patch = async (sessionId, s, title, template) => {
    if (!s.messageId) return;
    s.lastPatchAt = Date.now();
    await lark.patchCard(s.messageId, renderCard(s, title, template));
  };

  async function onSessionEvent(session, event) {
    if (!cfg.enabled || !lark?.available) return;
    const binding = bound(session.id);
    if (!binding) return;
    // /mute：绑定聊天静音时进度卡也不推（与告诉用户的“任务回复与完成通知都不再推送”一致）
    if (binding.muted) return;
    try {
      switch (event.type) {
        case 'turn/start': {
          const s = stateOf(session.id);
          diag(`progress: turn/start session=${session.id} card=${s?.messageId ? 'reuse' : 'new'}`);
          s.text = '';
          s.tools.clear();
          s.order = [];
          s.turnStartAt = Date.now();
          s.usage = null;
          s.stats = '';
          if (s.messageId) {
            await lark.patchCard(s.messageId, renderCard(s, '⏳ 任务进行中', 'blue'));
          } else {
            s.messageId = await lark.sendCard(binding.chatId, renderCard(s, '⏳ 任务进行中', 'blue'));
          }
          s.lastPatchAt = Date.now();
          break;
        }
        case 'assistant/chunk': {
          const s = sessions.get(session.id);
          if (!s?.messageId) return;
          if (event.data?.chunk?.type === 'text-delta' && event.data.chunk.text) {
            s.text = (s.text + event.data.chunk.text).slice(-cfg.maxTextChars);
          }
          if (Date.now() - s.lastPatchAt >= cfg.intervalMs) {
            await patch(session.id, s, '⏳ 任务进行中', 'blue');
          }
          break;
        }
        case 'assistant/message': {
          const s = sessions.get(session.id);
          if (!s) return;
          const text = event.data?.message?.content
            ?.filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n') ?? '';
          if (text) s.text = text.slice(-cfg.maxTextChars);
          if (event.data?.usage) s.usage = event.data.usage;
          break;
        }
        case 'tool/call': {
          const s = sessions.get(session.id);
          if (!s?.messageId || !cfg.toolLines) return;
          const callId = String(event.data?.callId ?? '');
          if (!callId) return;
          s.tools.set(callId, {
            name: String(event.data?.name ?? 'tool'),
            brief: briefArgs(event.data?.name, event.data?.arguments),
            state: 'running',
          });
          s.order.push(callId);
          while (s.order.length > cfg.maxTools) {
            const oldest = s.order.shift();
            s.tools.delete(oldest);
          }
          if (Date.now() - s.lastPatchAt >= cfg.intervalMs) {
            await patch(session.id, s, '⏳ 任务进行中', 'blue');
          }
          break;
        }
        case 'tool/result': {
          const s = sessions.get(session.id);
          const msg = event.data?.message;
          // 真实事件用 message.toolCallId；兼容旧字段 message.callId / source.callId
          const callId = String(msg?.toolCallId ?? msg?.callId ?? msg?.source?.callId ?? '');
          if (!s?.messageId || !cfg.toolLines || !callId) return;
          const t = s.tools.get(callId);
          if (t) {
            t.state = resultFailed(msg, event.data) ? 'error' : 'done';
            if (Date.now() - s.lastPatchAt >= cfg.intervalMs) {
              await patch(session.id, s, '⏳ 任务进行中', 'blue');
            }
          }
          break;
        }
        case 'turn/end': {
          const s = sessions.get(session.id);
          diag(`progress: turn/end session=${session.id} card=${s?.messageId ? 'yes' : 'none'}`);
          if (!s?.messageId) break;
          const durationMs = s.turnStartAt ? Date.now() - s.turnStartAt : 0;
          s.stats = statsLine(durationMs, s.usage);
          const kind = event.data?.reason?.kind;
          const ok = kind === 'completed' || kind === undefined;
          const endTitle = {
            aborted: '⚠️ 已取消',
            cancelled: '⚠️ 已取消',
            canceled: '⚠️ 已取消',
            blocked: '⚠️ 被阻塞',
            timeout: '⚠️ 超时',
            error: '⚠️ 失败',
            failed: '⚠️ 失败',
          }[kind] ?? `⚠️ ${kind ?? '已结束'}`;
          if (cfg.patchTerminal) {
            await patch(session.id, s, ok ? '✅ 完成' : endTitle, ok ? 'green' : 'orange');
            diag('progress: terminal patch ok');
          } else {
            await patch(session.id, s, ok ? '✅ 已完成' : endTitle,
              ok ? 'green' : 'orange');
            diag('progress: terminal patch ok');
          }
          s.messageId = null;
          s.text = '';
          s.tools.clear();
          s.order = [];
          break;
        }
        default:
          break;
      }
    } catch (e) {
      log(`[feishu-pilot] progress card update failed: ${e?.message}`);
    }
  }

  async function onAgentError({ agent, error }) {
    if (!cfg.enabled || !lark?.available || !agent?.id) return;
    const s = sessions.get(agent.id);
    if (!s?.messageId) return;
    try {
      await lark.patchCard(s.messageId, renderCard(s, '❌ 出错', 'red'));
      s.messageId = null;
    } catch (e) {
      log(`[feishu-pilot] progress error patch failed: ${e?.message}`);
    }
  }

  const dSession = ctx.on('session/event', onSessionEvent);
  const dError = ctx.on('agent/error', onAgentError);
  const dEffect = ctx.effect(() => () => {
    sessions.clear();
  }, 'feishu-pilot.progress');

  return {
    dispose() {
      dSession?.();
      dError?.();
      dEffect?.();
      sessions.clear();
    },
  };
}
