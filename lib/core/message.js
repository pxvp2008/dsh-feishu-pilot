// lib/core/message.js —— 统一消息模型与键约定（插件内部）。
//
// 渠道模块只做「平台协议 ⇄ 这个统一模型」的转换，不含业务逻辑。
// 入站消息由渠道构造 ImMessage 后交给 runtime.dispatchInbound()；
// 出站消息由核心构造 OutboundMessage 后交给对应渠道的 send()。

/**
 * 入站消息（IM → agent）。
 * @typedef {Object} ImMessage
 * @property {string} platform    渠道标识（'feishu' | 'mock' ...）
 * @property {string} chatId      聊天标识（私聊=用户 id；群聊=群 id）
 * @property {string} userId      发送者平台 id
 * @property {string} [userName]  发送者昵称
 * @property {string} text        文本内容
 * @property {string} [msgId]     平台消息 id（幂等去重）
 * @property {'private'|'group'} [chatType] 聊天类型，默认 'private'
 */

/**
 * 出站消息。
 * @typedef {Object} OutboundMessage
 * @property {string} text           文本（核心渲染器已转纯文本）
 * @property {Array<{id:string, label:string, style?:'primary'|'danger'|'default'}>} [buttons]
 *                                    内联按钮；id 为不透明回调载荷（'approve:<id>:yes' 等）
 */

/** 聊天标识（平台+chatId 的唯一键）。 */
export function chatKey(platform, chatId) {
  return `${platform}:${chatId}`;
}

/** 用户标识（平台+userId 的唯一键，对应配置 allowlist 条目）。 */
export function userKey(platform, userId) {
  return `${platform}:${userId}`;
}

/** 从配置条目解析用户键（容忍 "feishu:user_a" 或裸 userId + 平台参数）。 */
export function parseUserKey(raw, platform) {
  if (typeof raw !== 'string') return null;
  const idx = raw.indexOf(':');
  if (idx > 0) {
    const p = raw.slice(0, idx);
    const u = raw.slice(idx + 1);
    if (p && u) return { platform: p, userId: u, key: raw };
  }
  if (platform) return { platform, userId: raw, key: `${platform}:${raw}` };
  return null;
}

/**
 * 会话 id（chat 的确定性映射，重启后不变）。
 * 契约：格式 `im-<platform>-<chatId 净化>`——宿主会话存储里已持久化的既有会话
 * （如 `im-feishu-oc_xxx`）必须能被新核心继续恢复，格式不可变。
 */
export function sessionIdFor(platform, chatId) {
  const safe = String(chatId).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return `im-${platform}-${safe || 'chat'}`;
}
