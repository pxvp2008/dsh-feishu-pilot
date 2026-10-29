// lib/core/notify.js —— 绑定会话的通知总线（插件内部）。
//
// 事件源：assistant/chunk（流式增量）、assistant/message（含 usage）、
//         turn/end（结果卡片）、agent/error（失败通知）。仅推 IM 绑定会话；
//         非绑定会话的通知由插件 remote-notify 模块负责。
//
// 策略：
//  - 蓄水池 + flush：每 flushIntervalMs 或累计 N 字符推送一次增量，turn/end 强制刷完
//  - 在线/离线分流：用户最近 onlineWindowMin 活跃才推流式增量；人不在只推结果卡片
//  - 聚合：同一任务只推 1 条结果通知；错误通知 1 分钟内不重复
//  - 可操作通知：失败通知带【重试】按钮（重新 followup 同一任务）
//  - 绑定 muted 标记（/mute /unmute）：关闭本聊天通知（审批不受影响——在 approvals 侧）

import { markdownToText, resultCard, summarizeMarkdown, splitLongText } from './renderer.js';

const FLUSH_CHARS = 1400; // 累计字符强制 flush
const FLUSH_MIN_CHARS = 40; // 非强制刷新的最小推送门槛
const ONLINE_WINDOW_MIN = 10;
const FLUSH_INTERVAL_MS = 400;
/** 一次回复最多逐条发送的文本消息数；超过则改为发 `.md` 附件（不丢内容）。 */
const MAX_TEXT_MESSAGES = 6;

export class NotifyBus {
  /**
   * @param {Object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx
   * @param {import('./session-map.js').SessionMap} deps.map
   * @param {(chat: {platform:string, chatId:string}, out: object) => Promise<any>} deps.send
   * @param {(binding: {platform:string, chatId:string}, name: string, content: string) => Promise<boolean>} [deps.sendFile]
   * @param {(line: string) => void} deps.log
   * @param {(sessionId: string) => string} deps.lastUserTextFor  最近一条用户消息（重试用）
   */
  constructor({ ctx, map, send, sendFile, log, lastUserTextFor }) {
    this.ctx = ctx;
    this.map = map;
    this.send = send;
    this.sendFile = sendFile;
    this.log = log;
    this.lastUserTextFor = lastUserTextFor;
    /** sessionId → 会话内状态 */
    this.sessions = new Map();
    this._dispose = [];
    this._lastPush = new Map(); // `${sessionId}:error` → ts（1 分钟聚合）
    /** 进度卡已覆盖本会话 ⇒ 不再单独投递全文（避免进度卡/全文/结果卡三条重复） */
    this.suppressFullText = false;
    /** 进度卡负责终态 ⇒ 绑定会话不再另发结果卡（统计已融合进进度卡） */
    this.suppressBoundResult = false;
  }

  mount() {
    this._dispose.push(this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)));
    this._dispose.push(this.ctx.on('agent/error', ({ agent, error }) => this.onAgentError(agent, error)));
  }

  dispose() {
    for (const d of this._dispose) d();
    this._dispose = [];
    for (const s of this.sessions.values()) {
      if (s.flushTimer) clearTimeout(s.flushTimer);
      if (s.reservoir) void this.flush(s, true).catch(() => {});
    }
    this.sessions.clear();
  }

  onSessionEvent(session, event) {
    const binding = this.map.bySessionId(session.id);
    if (!binding) return;
    switch (event.type) {
      case 'turn/start': {
        const s = this.state(session.id);
        s.running = true;
        s.turnStartAt = Date.now();
        s.turnText = '';
        s.sawStream = false;
        break;
      }
      case 'assistant/chunk': {
        if (event.data.chunk.type === 'text-delta' && event.data.chunk.text) {
          this.state(session.id).sawStream = true;
          this.appendStream(binding, event.data.chunk.text);
        }
        break;
      }
      case 'assistant/message': {
        this.recordMessage(binding, event.data);
        break;
      }
      case 'turn/end': {
        void this.handleTurnEnd(binding, event.data)
          .catch((err) => this.log(`[notify] turn/end failed: ${err?.message ?? err}`));
        break;
      }
      default:
        break;
    }
  }

  onAgentError(agent, error) {
    const binding = this.map.bySessionId(agent.id);
    if (!binding || binding.muted) return;
    const now = Date.now();
    const last = this._lastPush.get(`${agent.id}:error`) ?? 0;
    if (now - last < 60_000) return; // 同类通知 1 分钟聚合
    this._lastPush.set(`${agent.id}:error`, now);
    const message = error instanceof Error ? error.message : String(error);
    const text = `❌ Agent 出错：${message.slice(0, 800)}`;
    const lastUserText = this.lastUserTextFor(agent.id);
    void this.send({ platform: binding.platform, chatId: binding.chatId }, {
      text,
      title: '⚠️ 会话出错',
      template: 'red',
      buttons: lastUserText ? [{ id: `retry:${agent.id}`, label: '🔁 重试', style: 'default' }] : undefined,
    }).catch((err) => this.log(`[notify] error push failed: ${err.message}`));
  }

  state(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        reservoir: '',
        flushTimer: null,
        lastAssistantText: '',
        /** 整轮累积文本（多段 assistant/message 拼接；结果卡摘要用） */
        turnText: '',
        /** 本轮是否出现过 text-delta（流式已逐条推送 ⇒ 结果卡前不再重发全文） */
        sawStream: false,
        lastUsage: null,
        turnStartAt: Date.now(),
        running: false,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** 流式增量进蓄水池；仅在线且未静音时发送。 */
  appendStream(binding, text) {
    const s = this.state(binding.sessionId);
    s.reservoir += text;
    if (binding.muted) return;
    if (!this.map.isOnline(binding.platform, binding.chatId, ONLINE_WINDOW_MIN * 60_000)) {
      return; // 人不在：只蓄水不推送（结果卡片兜底）
    }
    if (s.reservoir.length >= FLUSH_CHARS) {
      void this.flush(s, false).catch(() => {});
      return;
    }
    if (!s.flushTimer) {
      s.flushTimer = setTimeout(() => {
        s.flushTimer = null;
        void this.flush(s, false).catch(() => {});
      }, FLUSH_INTERVAL_MS);
    }
  }

  async flush(s, force) {
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    const text = markdownToText(s.reservoir);
    s.reservoir = '';
    if (!text) return;
    if (force || text.length >= FLUSH_MIN_CHARS) {
      await this.sendReservoir(s, text);
    }
  }

  async sendReservoir(s, text) {
    const binding = this.map.bySessionId(s.sessionId);
    if (!binding) return;
    const chunks = splitLongText(text);
    const head = chunks.slice(0, MAX_TEXT_MESSAGES);
    for (const chunk of head) {
      await this.send({ platform: binding.platform, chatId: binding.chatId }, { text: chunk });
    }
    if (chunks.length <= MAX_TEXT_MESSAGES) return;

    // 超过 N 段：优先发 .md 附件（完整内容），附件失败则把所有剩余段落逐条发完（不丢内容）
    const ok = await this.sendFile?.(binding, `output-${s.sessionId}.md`, text);
    if (ok) {
      await this.send({ platform: binding.platform, chatId: binding.chatId }, {
        text: `📎 内容较长（共 ${chunks.length} 段），完整版见上方附件。`,
      });
      return;
    }
    for (const chunk of chunks.slice(MAX_TEXT_MESSAGES)) {
      await this.send({ platform: binding.platform, chatId: binding.chatId }, { text: chunk });
    }
  }

  recordMessage(binding, data) {
    const s = this.state(binding.sessionId);
    const text = extractText(data.message);
    if (text) {
      s.lastAssistantText = text;
      // 整轮累积（多段 assistant/message 拼接）：结果卡摘要取开头，长文本投递用全文
      s.turnText = (s.turnText ? `${s.turnText}\n` : '') + text;
      if (s.turnText.length > 200_000) s.turnText = s.turnText.slice(0, 200_000);
    }
    if (data.usage) s.lastUsage = data.usage;
  }

  async handleTurnEnd(binding, data) {
    const s = this.state(binding.sessionId);
    const now = Date.now();
    const durationMs = s.running ? now - s.turnStartAt : 0;
    s.running = false;
    s.turnStartAt = now;

    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    // 在线时强制刷完蓄水池
    if (s.reservoir && !binding.muted && this.map.isOnline(binding.platform, binding.chatId, ONLINE_WINDOW_MIN * 60_000)) {
      await this.flush(s, true).catch(() => {});
    }
    s.reservoir = '';

    if (binding.muted) return;

    // 绑定会话由进度卡展示完整结果 + 耗时/token 统计 ⇒ 不再发重复的「任务完成」结果卡。
    // 函数形式：仅当进度卡真正可用（lark 已连接）时抑制；不可用时仍用结果卡兜底。
    const suppress = typeof this.suppressBoundResult === 'function'
      ? this.suppressBoundResult(binding)
      : this.suppressBoundResult;
    if (suppress) {
      s.turnText = '';
      s.lastAssistantText = '';
      s.lastUsage = null;
      return;
    }

    // 非流式回合：模型只回整段 assistant message（没有 text-delta），蓄水池为空；
    // 此时结果卡摘要只有 600 字。内容超过摘要上限时，先把完整文本按普通消息/附件送达，
    // 再发结果卡，避免长回复在飞书里只剩摘要。
    const fullText = s.turnText ? markdownToText(s.turnText) : '';
    if (!s.sawStream && fullText.length > 600 && !this.suppressFullText) {
      await this.sendReservoir(s, fullText).catch(() => {});
    }

    const reason = data.reason;
    const status = reason?.kind === 'completed' ? 'completed'
      : reason?.kind === 'error' ? 'error'
        : reason?.kind === 'aborted' ? 'aborted'
          : reason?.kind === 'max-tokens' ? 'max-tokens'
            : reason?.kind === 'blocked' ? 'blocked'
              : reason?.kind === 'interrupted' ? 'interrupted' : 'completed';

    const summary = (s.turnText || s.lastAssistantText)
      ? summarizeMarkdown(s.turnText || s.lastAssistantText, { maxChars: 600, maxLines: 10 })
      : '';
    const card = resultCard({ status, summary, durationMs, usage: s.lastUsage });
    const out = { text: card };
    // 失败通知带重试按钮
    const lastUserText = this.lastUserTextFor(binding.sessionId);
    if (status === 'error' && lastUserText) {
      out.buttons = [{ id: `retry:${binding.sessionId}`, label: '🔁 重试', style: 'default' }];
    }
    void this.send({ platform: binding.platform, chatId: binding.chatId }, out)
      .catch((err) => this.log(`[notify] result push failed: ${err.message}`));
  }
}

/** 从 assistant message 的 content blocks 提取文本。 */
function extractText(message) {
  if (!message?.content) return '';
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}
