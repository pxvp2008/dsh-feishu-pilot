// lib/core/runtime.js —— 会话运行时（插件自有，非 cordis 服务）。
//
// 职责：渠道注册与出站路由、统一入站管道（去重 → 信任校验 → 命令/派活）、
// 会话映射（SessionMap）、命令集、审批管理、通知总线。
// 飞书接入模块（lib/feishu/）只做协议转换。
//
// 生命周期由 lib/boot.js 编排：new FeishuImCore(ctx, cfg) → await init()
// → bridge attach（覆写 dispatchInbound）→ 创建飞书接入。方法内不再需要
// 「等待初始化」守卫——接线发生在 init 完成之后。
//
// 会话创建/恢复必须携带 setup（agentPresets 挂载）——核心工具栈（read/edit/pwsh…）
// 与系统提示都挂在预设 bundle 里；裸 agents.create 的会话没有核心工具
// （真机实录）。agentSetup 由 boot.js 解析注入。

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';

import { chatKey, userKey, parseUserKey, sessionIdFor } from './message.js';

/** 深度冻结（与原 dsh-llm createMessage 行为一致）。 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** 构造不可变 user 消息；替代 @deepseek-ai/dsh-llm 依赖，便于独立安装。 */
function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }));
}
import { freshSessionId } from '../rebind.js';
import { SessionMap } from './session-map.js';
import { PendingAuth } from './pending-auth.js';
import { markdownToText, splitLongText } from './renderer.js';
import { ApprovalManager } from './approvals.js';
import { NotifyBus } from './notify.js';

/**
 * @typedef {Object} CoreConfig
 * @property {{allowlist:string[], admins:string[], autoCreate:boolean, maxSessions:number, trustOnFirstContact:boolean}} security
 * @property {{provider:string, model:string, workspace:string}} agent
 * @property {string} storeDir  状态目录（boot 已解析默认值）
 */

export class FeishuImCore {
  /** @param {{ cfg: CoreConfig, logger: any, effect?: (fn:any, label?:string)=>any }} deps */
  constructor({ ctx, cfg, logger }) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.channels = new Map();
    this.lastUserTexts = new Map(); // sessionId → 最近一条用户文本（重试用）
    this._lastFullOutput = new Map(); // sessionId → 最近 turn 的完整输出（/log 用）
    this._titles = new Map(); // sessionId → 会话标题（session/title 事件缓存，/status 用）
    this.log = logger;
    /** boot 注入：agentPresets 挂载 setup（见头注） */
    this.agentSetup = null;
    /** boot 可覆写：agentOptions 解析策略（默认模型跟随等） */
    this._agentOptionsOverride = null;
    this._dispose = [];
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────

  async init() {
    const cfg = this.cfg;
    // 核心侧诊断落盘（host stdout 不一定可见）
    this.diag = (m) => {
      try {
        void appendFile(join(cfg.storeDir ?? homedir(), 'boot-diag.log'), `${new Date().toISOString()} [core] ${m}\n`).catch(() => {});
      } catch { /* 诊断不得成为故障源 */ }
    };
    this.map = new SessionMap(cfg.storeDir);
    await this.map.load();
    // 配置中的 allowlist/admins 为权威来源，与运行期追加合并；
    // 但用户手动「断开并清空」后不再把旧 admins 种回来（否则换机器人后旧身份复活）
    for (const u of cfg.security.allowlist ?? []) this.map.allowlist.add(u);
    if (!this.map.adminsCleared) {
      for (const u of cfg.security.admins ?? []) this.map.admins.add(u);
    }

    // 未授权用户的待批准请求（设置页「授权用户」卡；7 天 TTL / 20 条上限）
    this.pending = new PendingAuth(cfg.storeDir ?? homedir(), this.log);
    await this.pending.load();
    // 历史绑定补齐工作区归属（群聊 /new 曾只建会话未 attach ⇒ GUI 未分组）
    void this.attachAllBindings();

    // 安全默认引导：allowlist 与 admins 全空 = deny-all
    if ((cfg.security.allowlist?.length ?? 0) === 0 && (cfg.security.admins?.length ?? 0) === 0) {
      this.log.warn(
        'security: deny-all — no allowlist/admins configured yet. Add your own key once, e.g. imCore.security.admins: ["feishu:ou_xxx"], then every new user is approved by you with one tap. | '
        + '安全：当前拒绝所有用户。请一次性在配置 imCore.security.admins 填入你自己的用户键（如 ["feishu:ou_xxx]"), 之后新用户首条消息会触发你的一键信任确认。'
      );
    }

    this.approvals = new ApprovalManager({
      ctx: this.ctx,
      map: this.map,
      send: (chat, out) => this.send(chat, out),
      logLine: (line) => this.appendLog('approvals', line),
    });
    const approvalTimeout = Number(cfg.approval?.timeoutSec);
    if (Number.isFinite(approvalTimeout)) {
      this.approvals.timeoutSec = Math.max(30, Math.min(3600, Math.round(approvalTimeout)));
    }
    const approvalMode = cfg.approval?.mode;
    if (cfg.approval?.enabled === false) this.approvals.guiOnly = true;
    else if (approvalMode) this.approvals.guiOnly = approvalMode === 'gui-first' || approvalMode === 'off';
    this.approvals.mount();

    this.notify = new NotifyBus({
      ctx: this.ctx,
      map: this.map,
      send: (chat, out) => this.send(chat, out),
      sendFile: (binding, name, content) => this.sendFile(binding, name, content),
      log: (line) => this.log.info(line),
      lastUserTextFor: (sessionId) => this.lastUserTexts.get(sessionId) ?? '',
    });
    this.notify.mount();

    // 会话事件：捕获完整输出（/log 用）+ 会话标题（/status 展示用，不依赖 sessionTitle 服务时序）
    this._dispose.push(this.ctx.on('session/event', (session, event) => {
      if (event.type === 'session/title') {
        const title = event.data?.title;
        if (typeof title === 'string' && title.trim()) {
          this._titles.set(session.id, title.trim());
          if (this._titles.size > 200) this._titles.delete(this._titles.keys().next().value);
        }
        return;
      }
      if (event.type !== 'assistant/message') return;
      if (!this.map.bySessionId(session.id)) return;
      const text = event.data.message?.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text ?? '').join('\n');
      if (text) this._lastFullOutput.set(session.id, text);
    }));
  }

  // ── 渠道注册与出站 ────────────────────────────────────────────────────────

  /** 注册渠道（渠道对象契约：{platform, displayName?, status?, send, sendFile?, dispose?}）。 */
  registerChannel(channel) {
    if (this.channels.has(channel.platform)) {
      throw new Error(`im core: channel "${channel.platform}" already registered`);
    }
    this.channels.set(channel.platform, channel);
    this.log.info(`channel "${channel.platform}" registered | 渠道已注册`);
    return () => {
      this.channels.delete(channel.platform);
      if (typeof channel.dispose === 'function') void channel.dispose();
    };
  }

  getChannel(platform) {
    return this.channels.get(platform) ?? null;
  }

  /** 出站路由：统一模型 → 渠道 send()。 */
  async send({ platform, chatId }, out) {
    const channel = this.channels.get(platform);
    if (!channel) throw new Error(`im core: no channel registered for "${platform}"`);
    return channel.send({ ...out, platform, chatId });
  }

  /** 出站路由（显式目标，含按钮），供插件其他模块复用。 */
  async push(platform, chatId, out) {
    return this.send({ platform, chatId }, out);
  }

  /**
   * 文件交付（长文本兜底）：渠道支持 sendFile 才算成功；否则返回 false 由调用方降级。
   * @param {{platform:string, chatId:string}} binding
   * @param {string} fileName
   * @param {string} content
   * @returns {Promise<boolean>}
   */
  async sendFile(binding, fileName, content) {
    const channel = this.channels.get(binding.platform);
    if (!channel || typeof channel.sendFile !== 'function') return false;
    try {
      await channel.sendFile(binding.chatId, fileName, content);
      return true;
    } catch (e) {
      this.log.warn(`[feishu-pilot] sendFile failed: ${e?.message ?? e}`);
      return false;
    }
  }

  /** 渠道连接状态（/status 用）。 */
  channelsStatus() {
    return [...this.channels.entries()].map(([p, ch]) => ({
      platform: p,
      connected: !ch.status || ch.status.connected !== false,
      detail: ch.status?.detail ?? '',
    }));
  }

  // ── 入站管道 ──────────────────────────────────────────────────────────────

  /**
   * 统一入站入口：渠道构造 ImMessage 后调用。
   * 流程：去重 → 信任校验 → 命令优先 → 派活。
   */
  async dispatchInbound(msg) {
    if (!msg || typeof msg.platform !== 'string' || typeof msg.chatId !== 'string') {
      this.log.warn('dropped malformed inbound message | 丢弃格式错误的入站消息: %o', msg);
      return;
    }
    const { platform, chatId, userId, text = '' } = msg;
    if (!this.channels.has(platform)) {
      this.log.warn(`inbound from unregistered platform "${platform}" ignored | 忽略来自未注册平台的消息`);
      return;
    }
    if (!this.map.dedupe(platform, msg.msgId)) return; // 幂等去重

    // 群聊默认仅 @机器人 时响应（可在设置页关闭）
    if (msg.chatType === 'group' && this.cfg.security.groupMentionRequired !== false && !msg.mentionedBot) return;

    // allowlist 之外的用户「可读不可写」→ 派活/命令一律拒绝（admins 隐式放行）
    if (!this.map.isAllowed(platform, userId)) {
      const bootstrapped = await this.trustGate(msg);
      if (!bootstrapped) return; // 新 bot 首个用户：已设为管理员，继续处理本条消息
    }

    // 授权用户发来私聊 ⇒ 记为本机器人当前通知目标（换 bot 后自动更新）
    if (msg.chatType === 'private') this.map.rememberNotifyChat(chatId);

    const parsed = text ? parseCommand(text) : null;
    if (parsed && COMMANDS.has(parsed.name)) {
      await this.handleCommand(msg, parsed);
      return;
    }

    await this.dispatchTask(msg);
  }

  /**
   * 按钮/回调统一入口（渠道解析平台回调后调用）。
   * data 载荷约定：approve:<id>:yes|no / trust:<platform>:<userId> / retry:<sessionId>
   */
  async handleCallback({ platform, chatId, userId, userName, data, messageId = '' }) {
    if (!data || typeof data !== 'string') return;
    const parts = data.split(':');
    const kind = parts[0];
    const reply = (text) => this.send({ platform, chatId }, { text }).catch(() => {});
    const who = userName || userId;
    const bySuffix = who ? `（${who}）` : '';

    switch (kind) {
      case 'approve': {
        // 审批按钮回调身份校验：点按钮的人必须 ∈ allowlist
        if (!this.map.isAllowed(platform, userId)) {
          return reply(`⛔ 无权限：审批需要 allowlist 成员身份（当前 ${platform}:${userId} 未授权）。`);
        }
        const [, id, answer] = parts;
        const result = this.approvals.respond(id, answer, { platform, userId, userName, messageId });
        const texts = {
          accepted: `✅ 已批准 #${id}${bySuffix}，agent 继续执行。`,
          rejected: `❌ 已拒绝 #${id}${bySuffix}。`,
          ignored: `ℹ️ 审批 #${id} 已被响应或不存在。`,
          'not-found': `ℹ️ 审批 #${id} 不存在或已结束。`,
          expired: `⏰ 审批 #${id} 的飞书卡片已失效，请在 GUI 处理（或回复 /approve ${id} yes|no）。`,
          forbidden: `⛔ 无权限。`,
          'wrong-card': `⛔ 请在原聊天中操作该审批（这张卡片已被转发或不是审批目标）。`,
        };
        return reply(texts[result] ?? `ℹ️ ${result}`);
      }
      case 'trust': {
        const [, targetPlatform, ...rest] = parts;
        const targetUserId = rest.join(':');
        if (!this.map.isAllowed(platform, userId)) {
          return reply('⛔ 仅授权用户可批准新用户。');
        }
        if (!targetPlatform || !targetUserId) return reply('用法：/trust <platform:userId>');
        this.map.addToAllowlist(targetPlatform, targetUserId);
        this.pending?.remove(`${targetPlatform}:${targetUserId}`);
        this.log.info(`authorized user ${platform}:${userId} trusted ${targetPlatform}:${targetUserId}`);
        return reply(`✅ 已信任 ${targetPlatform}:${targetUserId}，对方可开始派活。`);
      }
      case 'permission': {
        // 权限预设选择卡：data = permission::<base64url(preset)>
        if (!this.map.isAllowed(platform, userId)) return reply('⛔ 无权限。');
        let preset = '';
        try {
          preset = Buffer.from(parts[2] ?? '', 'base64url').toString('utf8');
        } catch { /* 非法数据走空值提示 */ }
        if (!preset) return reply('ℹ️ 无效的权限预设。');
        await this.commandDsh({ platform, chatId, text: `/permission ${preset}` }, 'permission');
        return undefined;
      }
      case 'model': {
        // 模型选择卡：data = model::<base64url({p,m})>
        if (!this.map.isAllowed(platform, userId)) return reply('⛔ 无权限。');
        const binding = this.map.get(platform, chatId);
        if (!binding) return reply('ℹ️ 先创建会话（/new）。');
        let sel;
        try {
          sel = JSON.parse(Buffer.from(parts[2] ?? '', 'base64url').toString('utf8'));
        } catch {
          return reply('ℹ️ 无效的模型选择。');
        }
        if (!sel?.p || !sel?.m) return reply('ℹ️ 无效的模型选择。');
        const sc = this.ctx.get?.('sessionController');
        if (typeof sc?.selectModel !== 'function') return reply('ℹ️ 模型服务不可用。');
        try {
          await sc.selectModel({ sessionId: binding.sessionId, provider: sel.p, model: sel.m });
          return reply(`✅ 已切换模型：${sel.p} / ${sel.m}`);
        } catch (err) {
          return reply(`❌ 切换模型失败：${err?.message ?? err}`);
        }
      }
      case 'retry': {
        const sessionId = parts.slice(1).join(':');
        const text = this.lastUserTexts.get(sessionId);
        if (!text) return reply('ℹ️ 没有可重试的任务。');
        const agent = this.ctx.agents.get(sessionId);
        if (!agent) return reply('ℹ️ 会话不在线（重启后需先发一条消息恢复）。');
        agent.followup(this.userMessage(text));
        return reply('🔁 已重新提交任务。');
      }
      default:
        this.log.warn(`unknown callback data: "${data}"`);
    }
  }

  // ── 信任与授权 ────────────────────────────────────────────────────────────

  /**
   * 当前用户：授权名单第一条（admins 优先，兼容旧配置；否则 allowlist 第一条）。
   * 作用：默认通知/审批/提问收件人；不可被撤销。
   */
  ownerKey() {
    for (const k of this.map?.admins ?? []) if (typeof k === 'string' && k) return k;
    for (const k of this.map?.allowlist ?? []) if (typeof k === 'string' && k) return k;
    return '';
  }

  /** 首次接触：未知用户 → 记录待批准并推送当前用户确认（默认拒绝）。 */
  /**
   * 绑定当前机器人身份。appId 变化 = 换了机器人：旧 app 的绑定/授权/待批准/通知目标
   * 全部作废并清空，回到「新 bot 首次接触」状态。
   * @param {string} appId
   * @returns {Promise<boolean>} 是否发生了身份切换
   */
  async bindBotIdentity(appId) {
    if (!appId) return false;
    if (appId === this.map.appId) {
      if (!this.map.appId) { this.map.bindAppId(appId); await this.map.save(); }
      return false;
    }
    const { changed, previous } = this.map.bindAppId(appId);
    if (changed) {
      this.pending?.clearAll?.();
      this.log.info(`bot identity changed ${previous} → ${appId}: cleared bindings/admins/notify target | 机器人已切换，旧状态已清空`);
    }
    await this.map.save();
    return changed;
  }

  async trustGate(msg) {
    const { platform, chatId, userId, userName } = msg;
    const cfg = this.cfg.security;

    // 新机器人/清空后没有管理员：首个来信者成为管理员并记下通知私聊，
    // 否则换 bot 后既无法授权也无法推送（旧 open_id 已随旧 app 失效）。
    const authorized = (this.map.admins?.size ?? 0) + (this.map.allowlist?.size ?? 0);
    if (authorized === 0) {
      this.map.addAdmin(platform, userId);
      this.map.rememberNotifyChat(chatId);
      await this.map.save();
      this.log.info(`bootstrap owner: ${platform}:${userId} | 首个用户自动设为管理员`);
      await this.send({ platform, chatId }, {
        text: `✅ 已设为管理员：${userName ?? userId}\n发送 /new 创建会话开始使用。`,
      });
      return true;
    }

    // trustOnFirstContact=true（个人自用）→ 自动信任
    if (cfg.trustOnFirstContact) {
      this.map.addToAllowlist(platform, userId);
      this.log.info(`trust-on-first-contact: auto-trusted ${platform}:${userId} | 首次接触：已自动信任 ${platform}:${userId}`);
      await this.send({ platform, chatId }, {
        text: `👋 首次接触，已自动信任 ${userName ?? userId}（security.trustOnFirstContact=true）。\n发送 /new 创建会话开始派活。`,
      });
      return;
    }

    const pendingKey = `${platform}:${userId}`;
    // 记录待批准（设置页「授权用户」可一键批准；无当前用户时同样记录）
    await this.pending?.record({ platform, userId, userName, chatId });
    this.log.info(`trust request from ${pendingKey} (pending)`);

    const owner = this.ownerKey();
    if (owner) {
      const target = parseUserKey(owner);
      if (target) {
        await this.send({ platform: target.platform, chatId: target.userId }, {
          text: `🔐 信任确认：用户 ${userName ?? userId}（${platform}）请求使用。\n可在「设置 → 飞书 → 授权用户」批准，或回复 /trust ${pendingKey}。`,
          title: '👤 新用户请求授权',
          template: 'orange',
          buttons: [{ id: `trust:${platform}:${userId}`, label: '✅ 信任', style: 'primary' }],
        }).catch(() => {});
      }
      await this.send({ platform, chatId }, {
        text: `⏳ 已提交授权请求（${pendingKey}），管理员批准后即可使用。`,
      });
      return;
    }

    // 没有任何授权用户：只记录，等设置页批准（本机是兜底授权入口）
    this.log.warn(`untrusted inbound ${pendingKey}; no authorized user configured | 收到未授权消息 ${pendingKey}，且授权名单为空`);
    await this.send({ platform, chatId }, {
      text: `⛔ 当前未授权（${pendingKey}）。\n已提交授权请求；请桌面端在「设置 → 飞书 → 授权用户」批准。`,
    });
  }

  // ── 派活 ──────────────────────────────────────────────────────────────────

  async dispatchTask(msg) {
    const { platform, chatId, userId, userName, text } = msg;
    const cfg = this.cfg.security;
    let binding = this.map.get(platform, chatId);

    if (!binding) {
      if (!cfg.autoCreate) {
        await this.send({ platform, chatId }, {
          text: '📝 当前未创建会话。\n发送 /new 创建会话后即可派活（或设置 security.autoCreate: true 自动创建）。',
        });
        return;
      }
      if (this.map.size >= cfg.maxSessions) {
        await this.send({ platform, chatId }, {
          text: `⛔ 同时绑定的聊天数已达上限（${cfg.maxSessions}）。请用 /status 查看，或解绑/清理旧聊天后重试。`,
        });
        return;
      }
      binding = this.map.create(platform, chatId, {
        chatType: msg.chatType ?? 'private',
        // 唯一 id：避免聊天解绑后重建时撞上仍有落盘/存活会话的确定性 id
        sessionId: freshSessionId(this.ctx, platform, chatId),
      });
    }

    this.map.touch(platform, chatId, userId, userName);

    let agent = this.ctx.agents.get(binding.sessionId);
    if (!agent) {
      // 重启后：优先恢复原会话，失败才新建
      agent = await this.tryResume(binding.sessionId);
      if (!agent) agent = await this.createAgent(binding.sessionId);
    }
    await this.ensureWorkspaceAttached(binding.sessionId);

    this.lastUserTexts.set(binding.sessionId, text);
    this.diag?.(`dispatch: session=${binding.sessionId} text=${String(text).slice(0, 40)} images=${msg.images?.length ?? 0} files=${msg.files?.length ?? 0}`);
    let message;
    if (msg.images?.length || msg.files?.length) {
      // 附件处理加超时：卡住时退回纯文本，保证消息能进 DSH
      const TIMEOUT = Symbol('timeout');
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), 20_000); });
      this.diag?.('attachment attach: race start');
      try {
        message = await Promise.race([
          this.userMessageWithAttachments(text, msg.images, msg.files),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
      this.diag?.(`attachment attach: race settled${message === TIMEOUT ? ' (timeout)' : ''}`);
      if (message === TIMEOUT) {
        this.diag?.('attachment attach timeout → fallback text');
        message = this.userMessage(text);
      }
    } else {
      message = this.userMessage(text);
    }
    this.diag?.('dispatch: message built, followup');
    try {
      agent.followup(message);
    } catch (err) {
      this.diag?.(`followup failed: ${err?.message ?? err}`);
      throw err;
    }
  }

  /** 构造用户消息；图片/文件先经 attachments 服务落成引用，再作为附件 part 附加。 */
  async userMessageWithAttachments(text, images, files) {
    const content = [{ type: 'text', text }];
    // 注意：cordis 未声明 inject 时直接访问 ctx.attachments 会抛 without inject，
    // 必须走 ctx.get('attachments')（本插件其他宿主服务同理）。
    let attachments = null;
    try {
      attachments = this.ctx.get?.('attachments') ?? null;
    } catch (err) {
      this.diag?.(`attach: ctx.get(attachments) failed: ${err?.message ?? err}`);
    }
    if (Array.isArray(images) && images.length && typeof attachments?.saveImages === 'function') {
      this.diag?.(`image attach: saveImages start n=${images.length}`);
      try {
        const refs = await attachments.saveImages(
          images.map((im) => ({ data: im.data, mediaType: im.mediaType })),
        );
        this.diag?.(`image attach: saveImages done refs=${refs?.length ?? 0}`);
        for (const ref of refs ?? []) content.push({ type: 'image', attachment: ref });
      } catch (err) {
        this.log.warn(`image attach failed (text only): ${err?.message ?? err}`);
        this.diag?.(`image attach failed: ${err?.message ?? err}`);
      }
    }
    if (Array.isArray(files) && files.length && typeof attachments?.saveFile === 'function') {
      this.diag?.(`file attach: saveFile start n=${files.length}`);
      for (const file of files) {
        try {
          const ref = await attachments.saveFile({ data: file.data, name: file.name });
          if (ref) content.push({ type: 'file', attachment: ref });
        } catch (err) {
          this.log.warn(`file attach failed (skipped): ${err?.message ?? err}`);
          this.diag?.(`file attach failed: ${err?.message ?? err}`);
        }
      }
    } else if (Array.isArray(files) && files.length) {
      this.diag?.('file attach: attachments service unavailable');
    }
    try {
      return createUserMessage({ content, source: { kind: 'user' } });
    } catch (err) {
      this.diag?.(`userMessage build failed: ${err?.message ?? err}`);
      return this.userMessage(text);
    }
  }

  async tryResume(sessionId) {
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: await this.agentOptions(),
        ...this.agentSetup ? { setup: this.agentSetup } : {},
      });
      return handle.agent;
    } catch (err) {
      this.log.warn(`resume ${sessionId} failed (will create fresh) | 恢复会话失败（将新建）: ${err.message}`);
      return null;
    }
  }

  async createAgent(sessionId) {
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.workspace() },
      agentOptions: await this.agentOptions(),
      ...this.agentSetup ? { setup: this.agentSetup } : {},
    });
    await this.ensureWorkspaceAttached(sessionId);
    return handle.agent;
  }

  /**
   * 把会话附加到当前工作区记录（DSH 侧栏按 workspace.sessionIds 归组，幂等）。
   * 群聊 /new 曾只建会话未 attach ⇒ 显示「未分组」。
   */
  async ensureWorkspaceAttached(sessionId) {
    try {
      const reg = this.ctx.get?.('workspaceRegistry') ?? this.ctx.workspaceRegistry;
      const ws = await reg?.resolveByPath?.(this.workspace());
      await ws?.attachSession?.(sessionId);
    } catch (err) {
      this.log.warn(`attach ${sessionId} to workspace failed: ${err?.message ?? err}`);
    }
  }

  /** 启动时把已绑定会话补齐工作区归属（历史数据修复）。 */
  async attachAllBindings() {
    for (const b of this.map.list()) await this.ensureWorkspaceAttached(b.sessionId);
  }

  /**
   * agent 模型解析：配置钉死 → 宿主 agentDefaultModel → 抛错。
   * boot.js 在 provider/model 未钉死时覆写本方法（inject 等待语义 + 兜底），
   * 故生产路径不会走到抛错分支。
   */
  async agentOptions() {
    if (this._agentOptionsOverride) return this._agentOptionsOverride();
    const cfg = this.cfg.agent;
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
    const defaultModel = this.ctx.get?.('agentDefaultModel');
    if (defaultModel && typeof defaultModel.get === 'function') {
      try {
        const m = await defaultModel.get();
        if (m?.provider && m?.model) return { provider: m.provider, model: m.model };
      } catch { /* fall through */ }
    }
    throw new Error('agent model not resolvable (set imCore.agent.provider/model)');
  }

  /** boot 注入解析策略（默认模型跟随）。 */
  setAgentOptionsResolver(fn) {
    this._agentOptionsOverride = fn;
  }

  workspace() {
    // 归一化为本机原生路径（正斜杠 → 反斜杠）：DSH 工作区分组按 canonical cwd 匹配，
    // 正斜杠会导致新建会话落到 GUI「未分组」。
    return resolve(this.cfg.agent.workspace || process.cwd());
  }

  /** 构造 UserMessage（官方助手生成稳定 id，避免并发 followup 冲突）。 */
  userMessage(text) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
  }

  // ── 命令 ──────────────────────────────────────────────────────────────────

  async handleCommand(msg, parsed) {
    const def = COMMANDS.get(parsed.name);
    const allowed = def.perm === 'admin'
      ? this.map.isAdmin(msg.platform, msg.userId)
      : this.map.isAllowed(msg.platform, msg.userId);
    if (!allowed) {
      await this.send({ platform: msg.platform, chatId: msg.chatId }, {
        text: `⛔ 命令 /${parsed.name} 需要 ${def.perm === 'admin' ? '管理员' : 'allowlist'} 权限。`,
      });
      return;
    }
    try {
      await def.run(this, msg, parsed.args);
    } catch (err) {
      this.log.error(`command /${parsed.name} failed: %o`, err);
      await this.send({ platform: msg.platform, chatId: msg.chatId }, {
        text: `❌ 命令执行失败：${err instanceof Error ? err.message : String(err)}`,
      }).catch(() => {});
    }
  }

  async commandNew(msg) {
    const { platform, chatId } = msg;
    const cfg = this.cfg.security;
    const existing = this.map.get(platform, chatId);
    if (existing) {
      const oldAgent = this.ctx.agents.get(existing.sessionId);
      if (oldAgent && oldAgent.status !== 'idle') {
        await this.send({ platform, chatId }, { text: '⏳ 当前会话仍在运行，先等它结束或取消后再新建。' });
        return;
      }
      this.map.remove(platform, chatId);
    }
    if (this.map.size >= cfg.maxSessions) {
      await this.send({ platform, chatId }, {
        text: `⛔ 同时绑定的聊天数已达上限（${cfg.maxSessions}）。请用 /status 查看，或解绑/清理旧聊天后重试。`,
      });
      return;
    }
    const binding = this.map.create(platform, chatId, {
      chatType: msg.chatType ?? 'private',
      sessionId: freshSessionId(this.ctx, platform, chatId), // /new 必须换新 id，不能复用确定性 id
    });
    await this.createAgent(binding.sessionId);
    await this.send({ platform, chatId }, {
      text: `✅ 新会话已创建（${binding.sessionId}）。\n直接发送任务即可。`,
    });
  }

  /** 会话标题（缓存/落盘快照优先，存活服务兜底；空/异常返回 ''）。与 GUI 同源，>30 字截断。 */
  async _sessionTitle(sessionId) {
    const clip = (raw) => {
      const one = String(raw ?? '').replace(/\s+/g, ' ').trim();
      return one.length > 30 ? `${one.slice(0, 30)}…` : one;
    };
    const cached = this._titles?.get(sessionId);
    if (cached) return clip(cached);
    // 落盘会话同样有效（重启后 live 服务的 work 表可能为空）
    try {
      const query = this.ctx.get?.('sessionQuery');
      if (query?.readTitleSnapshots) {
        const [res] = await query.readTitleSnapshots([sessionId]);
        const title = res?.status === 'fulfilled' ? res.value?.title?.title : '';
        if (typeof title === 'string' && title.trim()) return clip(title);
      }
    } catch { /* 兜底 */ }
    try {
      const s = this.ctx.get?.('sessions')?.get?.(sessionId);
      const t = this.ctx.get?.('sessionTitle')?.get?.(s ?? { id: sessionId });
      return clip(typeof t?.title === 'string' ? t.title : '');
    } catch {
      return '';
    }
  }

  async commandStatus(msg) {
    const { platform, chatId } = msg;
    // 简洁版：只保留「连接 / 绑定 / 审批 / 授权」四块，不展示原始 chatId、sessionId
    const lines = [];
    for (const { platform: p, connected, detail } of this.channelsStatus()) {
      const reason = !connected && detail ? `（${String(detail).slice(0, 40)}）` : '';
      lines.push(`📡 ${p}：${connected ? '✅ 已连接' : `❌ 未连接${reason}`}`);
    }
    const typeZh = (t) => (t === 'group' ? '群聊' : t === 'private' || !t ? '私聊' : String(t));
    lines.push(`💬 聊天绑定 ${this.map.size}/${this.cfg.security.maxSessions}`);
    for (const s of this.map.list().slice(-5)) {
      const title = (await this._sessionTitle(s.sessionId)) || '新会话';
      lines.push(`  • ${typeZh(s.chatType)} ·「${title}」`);
    }
    const pending = this.approvals.pendingList();
    lines.push(pending.length === 0
      ? '🔐 审批：0'
      : `🔐 审批：${pending.length} 个等待（${pending.slice(-3).map((p) => `#${p.id}`).join(' ')}）`);
    const authorized = [...new Set([...(this.map.admins ?? []), ...(this.map.allowlist ?? [])])];
    lines.push(`👥 授权：${authorized.length} 人`);
    await this.send({ platform, chatId }, { text: lines.join('\n') });
  }

  /** /output：把上一任务的完整输出发回（文件优先，长文本兜底）。 */
  async commandOutput(msg) {
    const binding = this.map.get(msg.platform, msg.chatId);
    if (!binding) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: '先发一条任务消息。' });
    }
    const full = this._lastFullOutput.get(binding.sessionId);
    if (!full) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: '还没有可发送的输出。' });
    }
    const channel = this.channels.get(msg.platform);
    if (channel && typeof channel.sendFile === 'function') {
      await channel.sendFile(binding.chatId, `output-${binding.sessionId}.md`, full);
      return;
    }
    for (const chunk of splitLongText(markdownToText(full))) {
      await this.send({ platform: msg.platform, chatId: msg.chatId }, { text: chunk });
    }
  }

  async commandHelp(msg) {
    const rows = [];
    for (const [name, def] of COMMANDS) {
      const perm = def.perm === 'admin' ? ' [admin]' : '';
      rows.push(`/${name} ${def.usage}${perm} — ${def.desc}`);
    }
    await this.send({ platform: msg.platform, chatId: msg.chatId }, {
      text: ['📋 飞书远控命令', '', ...rows].join('\n'),
    });
  }

  /**
   * DSH 原生命令透传（goal/plan/compact/permission/feedback）：
   * 直接调用宿主 commands.execute，行为与 GUI 内执行一致；输出回传飞书。
   */
  async commandDsh(msg, name) {
    const binding = this.map.get(msg.platform, msg.chatId);
    if (!binding) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: 'ℹ️ 先创建会话（/new）。' });
    }
    let agent = this.ctx.agents.get(binding.sessionId);
    if (!agent) agent = await this.tryResume(binding.sessionId);
    if (!agent) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: 'ℹ️ 会话不在线，请先发一条消息恢复会话。' });
    }
    const commands = this.ctx.get?.('commands');
    if (typeof commands?.execute !== 'function') {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: 'ℹ️ 宿主 commands 服务不可用。' });
    }
    const line = String(msg.text ?? `/${name}`).trim();
    try {
      const controller = new AbortController();
      const res = await commands.execute(agent, line, [], controller.signal);
      if (!res) {
        await this.send({ platform: msg.platform, chatId: msg.chatId }, { text: `ℹ️ 宿主未注册 /${name}` });
        return;
      }
      // commands.execute 返回 { commandId, result: { kind, text } }
      const result = res.result ?? res;
      const raw = typeof result?.text === 'string' && result.text.trim()
        ? result.text
        : (result?.kind === 'success' ? '✅ 已完成' : 'ℹ️ 命令已执行');
      const text = translateDshResult(name, raw);
      await this.send({ platform: msg.platform, chatId: msg.chatId }, { text });
    } catch (err) {
      await this.send({ platform: msg.platform, chatId: msg.chatId }, {
        text: `❌ /${name} 执行失败：${err?.message ?? err}`,
      });
    }
  }

  /**
   * /permission：按钮卡选择权限预设（与 /ws 同款交互），按钮用中文说明；
   * 点击后仍走宿主 /permission <preset>，保持原生语义。
   */
  async commandPermission(msg, args) {
    if (args && args.length > 0) return this.commandDsh(msg, 'permission');
    const svc = this.ctx.get?.('permissionPresets');
    if (typeof svc?.catalog !== 'function') {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: 'ℹ️ 权限服务不可用。' });
    }
    let catalog;
    try {
      catalog = svc.catalog();
    } catch (err) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: `❌ 读取权限预设失败：${err?.message ?? err}` });
    }
    const options = catalog?.options ?? [];
    const binding = this.map.get(msg.platform, msg.chatId);
    let current = catalog?.defaultPreset ?? '';
    if (binding) {
      try {
        const agent = this.ctx.agents.get(binding.sessionId);
        if (agent) current = svc.current(agent.session);
      } catch { /* 离线时退回默认预设 */ }
    }
    const zh = {
      'read-only': '只读',
      'workspace-write': '工作区可写',
      'danger-full-access': '完全访问',
      auto: '自动审批',
    };
    const buttons = options.map((o) => {
      const name = o.name ?? o.id;
      const label = zh[name]
        ? `${zh[name]}（${name}）`
        : (o.label && o.label !== name ? `${o.label}（${name}）` : `${name}`);
      return {
        id: `permission::${Buffer.from(String(name), 'utf8').toString('base64url')}`,
        label: `${current === name ? '✓ ' : ''}${label}`,
        style: current === name ? 'primary' : 'default',
      };
    });
    if (buttons.length === 0) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: 'ℹ️ 没有可用的权限预设。' });
    }
    await this.send({ platform: msg.platform, chatId: msg.chatId }, {
      title: '🔐 选择权限预设',
      text: `当前预设：${current || '未知'}`,
      template: 'blue',
      buttons,
    });
  }

  /**
   * /model：列出宿主模型目录，用按钮卡选择（与 /ws 同款交互）。
   * 选择结果通过 handleCallback('model') 调 sessionController.selectModel。
   */
  async commandModel(msg) {
    const sc = this.ctx.get?.('sessionController');
    if (typeof sc?.modelCatalog !== 'function') {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: 'ℹ️ 模型服务不可用。' });
    }
    let catalog;
    try {
      catalog = await sc.modelCatalog();
    } catch (err) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: `❌ 读取模型目录失败：${err?.message ?? err}` });
    }
    const groups = catalog?.groups ?? [];
    const cur = catalog?.defaultSelection ?? null;
    const buttons = [];
    for (const g of groups) {
      for (const m of g?.models ?? []) {
        if (buttons.length >= 20) break;
        const isCur = cur && cur.provider === g.id && cur.model === m.id;
        const token = Buffer.from(JSON.stringify({ p: g.id, m: m.id }), 'utf8').toString('base64url');
        buttons.push({
          id: `model::${token}`,
          label: `${isCur ? '✓ ' : ''}${g.title ?? g.id} / ${m.name ?? m.id}`,
          style: isCur ? 'primary' : 'default',
        });
      }
      if (buttons.length >= 20) break;
    }
    if (buttons.length === 0) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: 'ℹ️ 没有可用模型。' });
    }
    await this.send({ platform: msg.platform, chatId: msg.chatId }, {
      title: '🤖 选择模型',
      text: '点击切换到该模型（当前会话 + 默认模型）',
      template: 'blue',
      buttons,
    });
  }

  async commandApprove(msg, args) {
    const [id, answer] = args;
    if (!id || !answer || !['yes', 'no'].includes(answer)) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, {
        text: '用法：/approve <id> yes|no（如 /approve a1b2c3d4 yes）',
      });
    }
    const result = this.approvals.respond(id, answer, {
      platform: msg.platform, userId: msg.userId, userName: msg.userName,
    });
    const who = msg.userName || msg.userId || '';
    const bySuffix = who ? `（${who}）` : '';
    const texts = {
      accepted: `✅ 已批准 #${id}${bySuffix}，agent 继续执行。`,
      rejected: `❌ 已拒绝 #${id}${bySuffix}。`,
      ignored: `ℹ️ 审批 #${id} 已被响应或不存在。`,
      'not-found': `ℹ️ 审批 #${id} 不存在或已结束。`,
      expired: `⏰ 审批 #${id} 的飞书卡片已失效，请在 GUI 处理。`,
      forbidden: `⛔ 无权限：审批需要 allowlist 成员身份。`,
      'wrong-card': `⛔ 请在原聊天中操作该审批。`,
    };
    await this.send({ platform: msg.platform, chatId: msg.chatId }, { text: texts[result] ?? `ℹ️ ${result}` });
  }

  // ── 工具 ──────────────────────────────────────────────────────────────────

  /** 追加式日志（approvals.log）。 */
  async appendLog(kind, line) {
    try {
      await mkdir(this.cfg.storeDir, { recursive: true });
      await appendFile(join(this.cfg.storeDir, `${kind}.log`), JSON.stringify(line) + '\n', 'utf8');
    } catch (err) {
      this.log.warn(`append ${kind}.log failed: ${err.message}`);
    }
  }

  async dispose() {
    for (const d of this._dispose) d();
    this._dispose = [];
    this.approvals?.dispose();
    this.notify?.dispose();
    await this.pending?.dispose();
    await this.map?.dispose();
  }
}

// ── 命令表（执行逻辑由运行时按权限调用） ────────────────────────────────────

/**
 * DSH 原生命令输出中文化（宿主文案为硬编码英文；这里只做内置映射，不调用任何
 * 翻译插件/外部服务）。未覆盖的文本原样返回。
 * @param {string} name 命令名（goal/plan/compact/permission）
 * @param {string} text 宿主返回文本
 * @returns {string}
 */
export function translateDshResult(name, text) {
  let s = String(text ?? '');
  const exact = {
    // plan
    'Plan mode off.': '计划模式已关闭。',
    'Leaving plan mode (applies from the next step).': '正在退出计划模式（从下一步生效）。',
    'Plan mode entry cancelled.': '已取消进入计划模式。',
    'Plan mode is already inactive.': '计划模式当前未开启。',
    'Attachments cannot accompany /plan off.': '退出计划模式时不能附带附件。',
    // compact
    'No compactable history yet.': '还没有可压缩的历史。',
    'Compaction is unavailable because this process has an active compaction, or the agent is not idle.':
      '当前无法压缩：已有压缩在进行，或会话不空闲。',
    'Compaction cancelled.': '压缩已取消。',
    'The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.':
      '待压缩的历史在替换前发生变化，本次尝试已记录到会话日志。',
    'Compaction could not produce a useful summary. The attempt is recorded in the session log.':
      '压缩未能生成有效摘要，本次尝试已记录到会话日志。',
    'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.':
      '压缩未正常完成，部分历史可能已变化；请先检查会话状态再重试。',
    'Compaction finished, but the session could not be saved.': '压缩已完成，但会话保存失败。',
    // goal
    'No goal to clear.': '当前没有可清除的目标。',
    'Goal cleared.': '目标已清除。',
    'Goal editing requires a replacement objective.': '编辑目标需要提供新的目标内容。',
    'The goal command is not valid for the current state. Run /goal to view available commands.':
      '当前状态下该目标命令无效，发送 /goal 查看可用命令。',
    'Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.':
      '附件只能随目标内容提交：/goal <目标> 或 /goal edit <目标>。',
    'Reference attachments for the goal objective.': '目标附件参考。',
  };
  if (exact[s]) return exact[s];

  if (name === 'compact') {
    s = s.replace(
      /^Compacted (\d+) history items \(~(\d+) tokens\)\.$/m,
      '已压缩 $1 条历史（约 $2 tokens）。',
    ).replace(
      /^Compacted (\d+) history items\.$/m,
      '已压缩 $1 条历史。',
    );
    return s;
  }

  if (name === 'plan') {
    s = s.replace(
      /^Entering plan mode \(applies from the next step\)\. Use \/plan off to leave\.$/m,
      '已进入计划模式（从下一步生效）。发送 /plan off 退出。',
    ).replace(
      /^Plan mode on\. Use \/plan off to leave\.$/m,
      '计划模式已开启。发送 /plan off 退出。',
    );
    return s;
  }

  if (name === 'permission') {
    s = s.replace(/^current preset (\S+) \(available: (.+)\)$/m, '当前预设：$1（可用：$2）')
      .replace(/^unknown preset "(.*)" \(available: (.+)\)$/m, '未知预设「$1」（可用：$2）')
      .replace(/^preset (\S+)$/m, '已切换预设：$1');
    return s;
  }

  if (name === 'goal') {
    const phase = { active: '进行中', paused: '已暂停', blocked: '已阻塞', complete: '已完成' };
    s = s.replace(/^Goal created$/m, '目标已创建')
      .replace(/^Goal updated$/m, '目标已更新')
      .replace(/^Goal paused$/m, '目标已暂停')
      .replace(/^Goal resumed$/m, '目标已恢复')
      .replace(/^Goal$/m, '目标')
      .replace(/^Status: (\w+)$/gm, (_, p) => `状态：${phase[p] ?? p}`)
      .replace(/^Blocker: /gm, '阻塞原因：')
      .replace(/^Objective: /gm, '目标内容：')
      .replace(/^Rounds: /gm, '轮次：')
      .replace(/^Activation: armed$/gm, '自动继续：已启用')
      .replace(/^Activation: disarmed$/gm, '自动继续：未启用')
      .replace(/^Commands: /gm, '可用命令：')
      .replace(/^Usage: /gm, '用法：')
      .replace(/^No goal is currently set\.$/m, '当前没有设置目标。')
      .replace(
        /^No goal is currently set; \/goal (\w+) requires one\. Usage: (.*)$/m,
        '当前没有设置目标；/goal $1 需要先创建目标。\n用法：$2',
      )
      .replace(
        /^A goal is already (\w+)\. Use \/goal edit <objective> to change it or \/goal clear before replacing it\.$/m,
        (_, p) => `目标已处于${phase[p] ?? p}。用 /goal edit <目标> 修改，或先 /goal clear 再重建。`,
      )
      .replace(/<objective>/g, '<目标>');
    return s;
  }

  return s;
}

/**
 * 解析斜杠命令："/cmd args"。
 * @returns {null | {name:string, args:string[], raw:string}}
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const match = t.match(/^\/([A-Za-z0-9_-]+)\s*(.*)$/s);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const rest = (match[2] ?? '').trim();
  const args = rest ? rest.split(/\s+/).filter(Boolean) : [];
  return { name, args, raw: t };
}

const COMMANDS = new Map([
  ['new', { perm: 'user', usage: '', desc: '创建新会话', run: (core, msg) => core.commandNew(msg) }],
  ['status', { perm: 'user', usage: '', desc: '状态查询', run: (core, msg) => core.commandStatus(msg) }],
  ['output', { perm: 'user', usage: '', desc: '上一任务的完整输出（文件或长文本）', run: (core, msg) => core.commandOutput(msg) }],
  ['help', { perm: 'user', usage: '', desc: '帮助', run: (core, msg) => core.commandHelp(msg) }],
  // DSH 原生命令透传（目标/规划/压缩/权限），行为与 GUI 一致
  ['goal', { perm: 'user', usage: '', desc: '设置或查看长期任务目标', run: (core, msg) => core.commandDsh(msg, 'goal') }],
  ['plan', { perm: 'user', usage: '[off|message]', desc: '进入或退出计划模式', run: (core, msg) => core.commandDsh(msg, 'plan') }],
  ['compact', { perm: 'user', usage: '', desc: '压缩以上对话内容', run: (core, msg) => core.commandDsh(msg, 'compact') }],
  ['permission', { perm: 'user', usage: '', desc: '切换权限预设（按钮选择，中文说明）', run: (core, msg, args) => core.commandPermission(msg, args) }],
  ['model', { perm: 'user', usage: '', desc: '选择本会话使用的模型', run: (core, msg) => core.commandModel(msg) }],
  ['approve', { perm: 'user', usage: '<id> yes|no', desc: '文本方式审批（无按钮渠道降级路径）', run: (core, msg, args) => core.commandApprove(msg, args) }],
]);

export { chatKey, userKey, sessionIdFor };

/**
 * 斜杠面板同步用的命令目录（0.12.0）：只含展示信息，不含 run。
 * 飞书 Slash Command 名称不含 `/`；描述带用法，便于面板里看懂。
 * @returns {{name:string, description:string}[]}
 */
export function commandCatalog() {
  // 飞书面板会单独显示命令名，描述里不要再重复 `/name`（会显示成「/ws /ws — …」）。
  const rows = [...COMMANDS].map(([name, c]) => ({
    name,
    description: c.usage ? `${c.usage} — ${c.desc}` : c.desc,
  }));
  // /ws 由 switcher 处理，不在 COMMANDS 表里
  rows.push({ name: 'ws', description: '切换工作区 / 新建或接管会话' });
  return rows;
}

