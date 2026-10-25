// lib/send-tool.js —— agent 主动发飞书消息（0.12.0）。
//
// 只允许发往「调用方会话已绑定的飞书聊天」：不暴露跨聊天参数，避免被用来骚扰其他会话。
// 每会话 60s 内最多 5 条，超出直接报错给模型（而不是静默丢弃）。

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 5;
const MAX_TEXT_CHARS = 3500;

/**
 * 构造 `feishu_send` 工具定义（交给 ctx.tools.register）。
 * @param {Object} deps
 * @param {any} deps.im        核心实例（需要 map.bySessionId / push）
 * @param {(m:string)=>void} [deps.log]
 * @param {{enabled?:boolean}} [deps.config]
 * @returns {object|null} 工具定义；禁用时返回 null
 */
export function createSendToolDefinition({ im, log = () => {}, config = {} } = {}) {
  if (config.enabled === false) return null;

  /** sessionId → 最近发送时间戳数组 */
  const sentAt = new Map();

  const allow = (sessionId) => {
    const now = Date.now();
    const list = (sentAt.get(sessionId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (list.length >= RATE_LIMIT) {
      sentAt.set(sessionId, list);
      return false;
    }
    list.push(now);
    sentAt.set(sessionId, list);
    return true;
  };

  return {
    name: 'feishu_send',
    description: '给当前会话已绑定的飞书聊天发送一条纯文本消息，用于长任务中途主动汇报。'
      + '只能发到本会话绑定的聊天（不能指定其他聊天）；每会话每分钟最多 5 条。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: '要发送的纯文本内容（支持换行；不要放敏感凭据）。',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          chatId: { type: 'string' },
          messageId: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? '已发送到飞书' : '未发送' }],
    },
    async execute(args, exec) {
      const text = String(args?.text ?? '').trim();
      if (!text) throw new Error('feishu_send: text 不能为空');
      if (text.length > MAX_TEXT_CHARS) throw new Error(`feishu_send: 文本过长（最多 ${MAX_TEXT_CHARS} 字）`);

      const sessionId = exec?.agent?.id;
      const binding = sessionId ? im?.map?.bySessionId?.(sessionId) : null;
      if (!binding) throw new Error('feishu_send: 当前会话未绑定飞书聊天，无法发送');
      if (!allow(sessionId)) throw new Error(`feishu_send: 发送过于频繁（每 ${RATE_WINDOW_MS / 1000}s 最多 ${RATE_LIMIT} 条）`);

      const sent = await im.push(binding.platform, binding.chatId, { text: `📣 ${text}` });
      log(`feishu_send: ${sessionId} → ${binding.platform}:${binding.chatId} (${text.length} chars)`);
      return { ok: true, chatId: `${binding.platform}:${binding.chatId}`, messageId: String(sent?.messageId ?? '') };
    },
  };
}
