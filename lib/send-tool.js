// lib/send-tool.js —— agent 主动发飞书消息 / 附件（0.12.0，1.2.0 起支持文件）。
//
// 只允许发往「调用方会话已绑定的飞书聊天」：不暴露跨聊天参数，避免被用来骚扰其他会话。
// 只允许发送 **当前工作区内** 的文件（防止把任意本机文件外发；写入工作区外本就需要审批）。
// 每会话 60s 内最多 5 条（一次调用 = 1 条），超出直接报错给模型（而不是静默丢弃）。

import { basename, isAbsolute, join, relative } from 'node:path';
import { stat } from 'node:fs/promises';

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 5;
const MAX_TEXT_CHARS = 3500;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024; // 飞书文件消息上限内（20MB）

/**
 * 构造 `feishu_send` 工具定义（交给 ctx.tools.register）。
 * @param {Object} deps
 * @param {any} deps.im        核心实例（需要 map.bySessionId / push / sendLocalFile）
 * @param {(m:string)=>void} [deps.log]
 * @param {{enabled?:boolean, maxFiles?:number, maxFileBytes?:number}} [deps.config]
 * @returns {object|null} 工具定义；禁用时返回 null
 */
export function createSendToolDefinition({ im, log = () => {}, config = {} } = {}) {
  if (config.enabled === false) return null;

  const maxFiles = Math.max(1, Math.floor(Number(config.maxFiles) || DEFAULT_MAX_FILES));
  const maxFileBytes = Math.max(1, Number(config.maxFileBytes) || DEFAULT_MAX_FILE_BYTES);

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

  /** 解析/校验附件路径：仅限工作区内、必须存在且为文件、不超过大小上限。 */
  const resolveFiles = async (rawFiles, cwd) => {
    const root = String(cwd || process.cwd());
    const out = [];
    const seen = new Set();
    for (const raw of rawFiles) {
      const input = String(raw ?? '').trim();
      if (!input) continue;
      const abs = isAbsolute(input) ? input : join(root, input);
      const rel = relative(root, abs);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`feishu_send: 只能发送当前工作区内的文件：${input}`);
      }
      if (seen.has(abs)) continue;
      seen.add(abs);
      let info = null;
      try {
        info = await stat(abs);
      } catch {
        throw new Error(`feishu_send: 文件不存在：${input}`);
      }
      if (!info.isFile()) throw new Error(`feishu_send: 不是文件：${input}`);
      if (info.size > maxFileBytes) {
        throw new Error(`feishu_send: 文件过大（上限 ${Math.round(maxFileBytes / 1024 / 1024)}MB）：${input}`);
      }
      out.push({ path: abs, name: basename(abs) });
    }
    return out;
  };

  return {
    name: 'feishu_send',
    description: '给当前会话已绑定的飞书聊天发送一条纯文本消息和/或文件附件，用于长任务中途主动汇报。'
      + '只能发到本会话绑定的聊天（不能指定其他聊天）；附件仅限当前工作区内文件，'
      + `一次最多 ${maxFiles} 个、每个不超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB；每会话每分钟最多 5 条。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: '要发送的纯文本内容（支持换行；不要放敏感凭据）。可留空，仅发附件。',
        },
        files: {
          type: 'array',
          description: `文件附件路径（相对当前工作区或绝对路径，且必须在工作区内）；最多 ${maxFiles} 个。`,
          items: { type: 'string' },
          maxItems: maxFiles,
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          chatId: { type: 'string' },
          messageId: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                ok: { type: 'boolean' },
              },
              required: ['name', 'ok'],
            },
          },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `已发送到飞书${value.files?.length ? `（含 ${value.files.length} 个附件）` : ''}`
          : '未发送',
      }],
    },
    async execute(args, exec) {
      const text = String(args?.text ?? '').trim();
      const rawFiles = Array.isArray(args?.files) ? args.files : [];
      if (!text && rawFiles.length === 0) throw new Error('feishu_send: text 与 files 至少提供一个');
      if (text.length > MAX_TEXT_CHARS) throw new Error(`feishu_send: 文本过长（最多 ${MAX_TEXT_CHARS} 字）`);
      if (rawFiles.length > maxFiles) throw new Error(`feishu_send: 附件最多 ${maxFiles} 个`);

      const sessionId = exec?.agent?.id;
      const binding = sessionId ? im?.map?.bySessionId?.(sessionId) : null;
      if (!binding) throw new Error('feishu_send: 当前会话未绑定飞书聊天，无法发送');
      if (rawFiles.length > 0 && typeof im?.sendLocalFile !== 'function') {
        throw new Error('feishu_send: 当前渠道不支持发送文件附件');
      }

      // 先校验附件（读盘/越界/大小），通过后才消耗频率额度
      const files = rawFiles.length > 0 ? await resolveFiles(rawFiles, exec?.cwd) : [];
      if (rawFiles.length > 0 && files.length === 0) throw new Error('feishu_send: files 中没有有效文件');
      if (!allow(sessionId)) throw new Error(`feishu_send: 发送过于频繁（每 ${RATE_WINDOW_MS / 1000}s 最多 ${RATE_LIMIT} 条）`);

      let messageId = '';
      if (text) {
        const sent = await im.push(binding.platform, binding.chatId, { text: `📣 ${text}` });
        messageId = String(sent?.messageId ?? '');
      }
      const sentFiles = [];
      for (const f of files) {
        const ok = await im.sendLocalFile(binding, f.path, f.name);
        if (!ok) throw new Error(`feishu_send: 附件发送失败：${f.name}`);
        sentFiles.push({ name: f.name, ok: true });
      }
      log(`feishu_send: ${sessionId} → ${binding.platform}:${binding.chatId}`
        + ` (${text.length} chars, ${sentFiles.length} files)`);
      return {
        ok: true,
        chatId: `${binding.platform}:${binding.chatId}`,
        messageId,
        files: sentFiles,
      };
    },
  };
}
