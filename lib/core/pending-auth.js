// lib/core/pending-auth.js —— 未授权用户的「待批准」请求存储。
//
// 未知用户首次给机器人发消息时，信任门（runtime.trustGate）把请求记到这里：
// { platform, userId, userName, chatId, firstAt, lastAt, count }。
// 设置页「授权用户」卡读取并批准/忽略；飞书侧 /trust、「✅ 信任」按钮也会清掉对应项。
//
// 持久化：$DSH_HOME/dsh-feishu-pilot/pending-users.json
//   { version: 1, items: [...] }
// 约束：最多 20 条、7 天 TTL（按 lastAt 淘汰最旧；同毫秒用内部 seq 保证新者优先）；
//       写操作串行（Promise 队列）并原子写（tmp + rename）。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = 'pending-users.json';
const VERSION = 1;
const MAX_ITEMS = 20;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class PendingAuth {
  /**
   * @param {string} storeDir 状态目录（核心 cfg.storeDir）
   * @param {{ info?: Function, warn?: Function }} [log]
   */
  constructor(storeDir, log) {
    this.dir = storeDir;
    this.log = log ?? {};
    /** @type {Array<{platform:string,userId:string,userName:string,chatId:string,firstAt:number,lastAt:number,count:number}>} */
    this.items = [];
    this._seq = 0;
    this._queue = Promise.resolve();
  }

  filePath() {
    return join(this.dir, FILE);
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.filePath(), 'utf8'));
      const items = Array.isArray(raw?.items) ? raw.items : [];
      this.items = items
        .filter((it) => it && typeof it.platform === 'string' && typeof it.userId === 'string')
        .map((it) => ({
          platform: it.platform,
          userId: it.userId,
          userName: typeof it.userName === 'string' ? it.userName : '',
          chatId: typeof it.chatId === 'string' ? it.chatId : '',
          firstAt: Number(it.firstAt) || Date.now(),
          lastAt: Number(it.lastAt) || Number(it.firstAt) || Date.now(),
          count: Number(it.count) > 0 ? Math.floor(Number(it.count)) : 1,
        }));
      // 文件顺序 = 记录顺序（后者更新）
      this._seq = this.items.length;
      this._prune();
    } catch (err) {
      if (err?.code !== 'ENOENT') this.log.warn?.(`pending-auth: load failed: ${err?.message}`);
      this.items = [];
    }
    return this;
  }

  _sortDesc(a, b) {
    return (b.lastAt - a.lastAt) || ((b._seq ?? 0) - (a._seq ?? 0));
  }

  _prune() {
    const cutoff = Date.now() - TTL_MS;
    this.items = this.items.filter((it) => it.lastAt >= cutoff);
    if (this.items.length > MAX_ITEMS) {
      this.items.sort((a, b) => this._sortDesc(a, b));
      this.items = this.items.slice(0, MAX_ITEMS);
    }
  }

  keyOf(it) {
    return `${it.platform}:${it.userId}`;
  }

  /** 记录（同 key 去重：刷新 lastAt、count+1；保留首次 userName）。 */
  record({ platform, userId, userName, chatId }) {
    if (!platform || !userId) return null;
    const now = Date.now();
    const key = `${platform}:${userId}`;
    let it = this.items.find((x) => this.keyOf(x) === key);
    if (it) {
      it.lastAt = now;
      it._seq = ++this._seq;
      it.count += 1;
      if (userName) it.userName = String(userName);
      if (chatId) it.chatId = String(chatId);
    } else {
      it = {
        platform: String(platform),
        userId: String(userId),
        userName: userName ? String(userName) : '',
        chatId: chatId ? String(chatId) : '',
        firstAt: now,
        lastAt: now,
        count: 1,
        _seq: ++this._seq,
      };
      this.items.push(it);
    }
    this._prune();
    void this.save();
    return this._public(it);
  }

  _public(it) {
    return {
      key: this.keyOf(it),
      platform: it.platform,
      userId: it.userId,
      userName: it.userName,
      chatId: it.chatId,
      firstAt: it.firstAt,
      lastAt: it.lastAt,
      count: it.count,
    };
  }

  /** 待批准列表（最新在前）。 */
  list() {
    return [...this.items]
      .sort((a, b) => this._sortDesc(a, b))
      .map((it) => this._public(it));
  }

  has(key) {
    return this.items.some((it) => this.keyOf(it) === key);
  }

  get(key) {
    const it = this.items.find((x) => this.keyOf(x) === key);
    return it ? this._public(it) : null;
  }

  /** 移除一条（批准 / 忽略 / 已被 /trust 授权）。 */
  remove(key) {
    const before = this.items.length;
    this.items = this.items.filter((it) => this.keyOf(it) !== key);
    if (this.items.length !== before) void this.save();
    return this.items.length !== before;
  }

  /** 清空全部待批准（换机器人时旧 app 的 open_id 全部作废）。 */
  clearAll() {
    this.items = [];
    void this.save();
  }

  /** 串行落盘（record/remove 的 void save 也走同一队列，dispose 可等待其完成）。 */
  save() {
    this._queue = this._queue
      .then(() => this._writeNow())
      .catch(() => { /* 写失败只记日志，不打断调用方 */ });
    return this._queue;
  }

  async _writeNow() {
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.filePath()}.tmp`;
      const items = this.items.map((it) => ({
        platform: it.platform,
        userId: it.userId,
        userName: it.userName,
        chatId: it.chatId,
        firstAt: it.firstAt,
        lastAt: it.lastAt,
        count: it.count,
      }));
      await writeFile(tmp, JSON.stringify({ version: VERSION, items }, null, 2), 'utf8');
      await rename(tmp, this.filePath());
    } catch (err) {
      this.log.warn?.(`pending-auth: save failed: ${err?.message}`);
    }
  }

  async dispose() {
    await this.save();
  }
}
