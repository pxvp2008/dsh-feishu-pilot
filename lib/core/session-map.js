// lib/core/session-map.js —— 聊天 ⇄ 会话映射与信任名单持久化。
//
// 私聊：platform+chatId → 一个 DSH SessionId（确定性生成，重启不变）。
// 群聊：platform+chatId → 共享 session。
// 持久化：storeDir/mappings.json（原子写 tmp+rename，变更防抖），重启后聊天自动回到原会话。
// 同时持久化运行期追加的 allowlist / admins（信任确认的落点）。
//
// 持久化格式（version 1）是与旧部署状态兼容的契约：既有 mappings.json 必须原样可读。

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { chatKey, sessionIdFor } from './message.js';

const STORE_VERSION = 1;

export class SessionMap {
  /** @param {string} storeDir 持久化目录 */
  constructor(storeDir) {
    this.storeDir = storeDir;
    this.file = join(storeDir, 'mappings.json');
    /** @type {Map<string, ChatBinding>} key = `${platform}:${chatId}` */
    this.chats = new Map();
    /** @type {Map<string, string>} sessionId → key（反查双索引） */
    this.bySession = new Map();
    /** 运行期追加的 allowlist 用户键（配置之外） */
    this.allowlist = new Set();
    /** 运行期追加的 admin 用户键（配置之外；admin 隐式放行） */
    this.admins = new Set();
    /** 最近处理过的消息 id（幂等去重），Map 兼做 LRU */
    this.seen = new Map();
    /** 用户手动断开并清空过授权 ⇒ 重启后不再把配置里的旧 admins 重新种回来 */
    this.adminsCleared = false;
    /** 当前机器人 appId：app 内状态（绑定/授权/通知目标）都按它隔离，换 bot 即重建 */
    this.appId = '';
    /** 当前机器人下记住的通知私聊 chatId（首个授权用户自动记下） */
    this.notifyChatId = '';
    this._saveTimer = null;
    this._saving = null;
  }

  /** 启动时加载（失败则从空开始，不阻断启动）。 */
  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (data.version !== STORE_VERSION) return;
      for (const entry of data.chats ?? []) {
        const key = chatKey(entry.platform, entry.chatId);
        const binding = {
          platform: entry.platform,
          chatId: String(entry.chatId),
          chatType: entry.chatType ?? 'private',
          sessionId: entry.sessionId,
          createdAt: entry.createdAt ?? Date.now(),
          lastActivityAt: entry.lastActivityAt ?? 0,
          muted: entry.muted === true,
          /** Map<userId, {name, lastActiveAt}> */
          users: new Map(),
        };
        for (const u of entry.users ?? []) {
          binding.users.set(String(u.userId), { name: u.name ?? '', lastActiveAt: u.lastActiveAt ?? 0 });
        }
        this.chats.set(key, binding);
        this.bySession.set(binding.sessionId, key);
      }
      for (const u of data.allowlist ?? []) this.allowlist.add(String(u));
      for (const u of data.admins ?? []) this.admins.add(String(u));
      this.adminsCleared = data.adminsCleared === true;
      this.appId = typeof data.appId === 'string' ? data.appId : '';
      this.notifyChatId = typeof data.notifyChatId === 'string' ? data.notifyChatId : '';
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.error(`[feishu-pilot] mappings.json load failed (starting fresh): ${err.message}`);
      }
    }
  }

  /** 找聊天绑定；无则 null。 */
  get(platform, chatId) {
    return this.chats.get(chatKey(platform, chatId)) ?? null;
  }

  /** 按会话 id 反查绑定。 */
  bySessionId(sessionId) {
    const key = this.bySession.get(sessionId);
    return key ? this.chats.get(key) ?? null : null;
  }

  /** 是否已有绑定。 */
  has(platform, chatId) {
    return this.chats.has(chatKey(platform, chatId));
  }

  /** 创建绑定（默认会话 id 确定性生成；/new 可传 freshSessionId 避免与已存在会话撞 id）。 */
  create(platform, chatId, { chatType = 'private', sessionId } = {}) {
    const key = chatKey(platform, chatId);
    const sid = sessionId ?? sessionIdFor(platform, chatId);
    if (this.chats.has(key)) return this.chats.get(key);
    const binding = {
      platform,
      chatId: String(chatId),
      chatType,
      sessionId: sid,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      muted: false,
      users: new Map(),
    };
    this.chats.set(key, binding);
    this.bySession.set(sid, key);
    this._scheduleSave();
    return binding;
  }

  /** 删除绑定。 */
  remove(platform, chatId) {
    const key = chatKey(platform, chatId);
    const binding = this.chats.get(key);
    if (!binding) return;
    this.chats.delete(key);
    this.bySession.delete(binding.sessionId);
    this._scheduleSave();
  }

  /** 记录活跃（在线判定数据源：最近 N 分钟发过消息）。 */
  touch(platform, chatId, userId, userName) {
    const binding = this.get(platform, chatId);
    if (!binding) return null;
    binding.lastActivityAt = Date.now();
    binding.users.set(String(userId), { name: userName ?? '', lastActiveAt: Date.now() });
    this._scheduleSave();
    return binding;
  }

  /** 在线判定：绑定存在且最近 windowMs 内有该聊天任一用户发过消息。 */
  isOnline(platform, chatId, windowMs) {
    const binding = this.get(platform, chatId);
    if (!binding) return false;
    return Date.now() - binding.lastActivityAt <= windowMs;
  }

  /** 会话总数（maxSessions 上限用）。 */
  get size() {
    return this.chats.size;
  }

  /** 幂等去重：msgId 已处理过返回 false，否则记录并返回 true。 */
  dedupe(platform, msgId, limit = 1000) {
    if (!msgId) return true;
    const key = `${platform}:${msgId}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now());
    if (this.seen.size > limit) {
      const oldest = this.seen.keys().next().value;
      this.seen.delete(oldest);
    }
    return true;
  }

  /** 是否放行：allowlist 成员，或 admins（管理员隐式放行）。 */
  isAllowed(platform, userId) {
    const key = `${platform}:${userId}`;
    return this.allowlist.has(key) || this.admins.has(key);
  }

  /**
   * 断开连接时清空本地状态：所有绑定、allowlist、admins（换机器人后旧 chatId/open_id
   * 都属于旧 app，保留会误导）。调用方负责持久化 save()。
   */
  clearAll() {
    this.chats.clear();
    this.bySession.clear();
    this.allowlist.clear();
    this.admins.clear();
    this.adminsCleared = true;
    this.appId = '';
    this.notifyChatId = '';
    this.seen.clear();
    this._scheduleSave();
  }

  /**
   * 绑定当前机器人身份。appId 变化 = 换了机器人，旧 app 的绑定/授权/通知目标全部作废，
   * 必须整体清空重建（而不是靠通知目标兜底）。
   * @param {string} appId
   * @returns {{changed:boolean, previous:string}}
   */
  bindAppId(appId) {
    const previous = this.appId;
    const changed = !!previous && !!appId && previous !== appId;
    if (changed) this.clearAll();
    this.appId = appId || '';
    if (changed) this.notifyChatId = '';
    this._scheduleSave();
    return { changed, previous };
  }

  /** 记住当前机器人下用于任务通知的私聊 chatId。 */
  rememberNotifyChat(chatId) {
    const id = String(chatId ?? '').trim();
    if (!id || id === this.notifyChatId) return;
    this.notifyChatId = id;
    this._scheduleSave();
  }

  addToAllowlist(platform, userId) {
    this.allowlist.add(`${platform}:${userId}`);
    this._scheduleSave();
  }

  removeFromAllowlist(platform, userId) {
    this.allowlist.delete(`${platform}:${userId}`);
    this._scheduleSave();
  }

  isAdmin(platform, userId) {
    return this.admins.has(`${platform}:${userId}`);
  }

  addAdmin(platform, userId) {
    this.admins.add(`${platform}:${userId}`);
    this._scheduleSave();
  }

  removeAdmin(platform, userId) {
    this.admins.delete(`${platform}:${userId}`);
    this._scheduleSave();
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      void this.save();
    }, 500);
  }

  /** 原子写：tmp + rename。 */
  async save() {
    if (this._saving) return this._saving;
    this._saving = (async () => {
      await mkdir(this.storeDir, { recursive: true });
      const payload = {
        version: STORE_VERSION,
        chats: [...this.chats.values()].map((b) => ({
          platform: b.platform,
          chatId: b.chatId,
          chatType: b.chatType,
          sessionId: b.sessionId,
          createdAt: b.createdAt,
          lastActivityAt: b.lastActivityAt,
          muted: b.muted === true,
          users: [...b.users.entries()].map(([userId, u]) => ({ userId, name: u.name, lastActiveAt: u.lastActiveAt })),
        })),
        allowlist: [...this.allowlist],
        admins: [...this.admins],
        adminsCleared: this.adminsCleared,
        appId: this.appId,
        notifyChatId: this.notifyChatId,
      };
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await rename(tmp, this.file);
    })().finally(() => {
      this._saving = null;
    });
    return this._saving;
  }

  /** 序列化视图（/status 用）。 */
  list() {
    return [...this.chats.values()].map((b) => ({
      platform: b.platform,
      chatId: b.chatId,
      chatType: b.chatType,
      sessionId: b.sessionId,
      lastActivityAt: b.lastActivityAt,
      userCount: b.users.size,
    }));
  }

  async dispose() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this.save();
  }
}
