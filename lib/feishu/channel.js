// lib/feishu/channel.js —— 插件自有的飞书接入模块（0.9.0 去依赖重构）。
//
// 只做「飞书协议 ⇄ 统一消息模型」的转换，不含业务逻辑（业务在 lib/core/runtime.js）：
//   入站  WSClient 长连接（免公网）→ EventDispatcher
//           im.message.receive_v1  → core.dispatchInbound(ImMessage)
//           card.action.trigger     → core.handleCallback({…, data:'action:id:answer'})
//   出站  core 的 OutboundMessage → im.message.create（文本 / 按钮卡片）
//                                     im.file.create + im.message.create（文件）
//
// core = lib/core/runtime.js 的 FeishuImCore 实例（或任何实现
// registerChannel / dispatchInbound / handleCallback 的对象）。本模块不使用
// cordis Service / Config schema（配置由插件自己的 DEFAULT_CONFIG 提供），
// 日志前缀 [<SHORT_ID>]（见 lib/identity.js）。
//
// 前置条件（企业自建应用，长连接仅支持自建应用）：开放平台开启「机器人」能力，
// 订阅事件 im.message.receive_v1、回调 card.action.trigger，发布版本并把机器人加进
// 可用范围/群。凭据可用扫码接入（lib/feishu/provision.js）或 env:FEISHU_APP_ID/SECRET。

import * as lark from '@larksuiteoapi/node-sdk';

import { resolveSecret } from './credentials.js';
import { createAttemptQuota, createReconnectWatchdog } from './liveness.js';
import { SHORT_ID } from '../identity.js';

const LOG_PREFIX = `[${SHORT_ID}]`;
const DEFAULT_APP_ID_REF = 'env:FEISHU_APP_ID';
const DEFAULT_APP_SECRET_REF = 'env:FEISHU_APP_SECRET';
/** 按钮卡片标题（与插件其余按钮卡同一线上格式：config/header/elements）。 */
const APPROVAL_CARD_TITLE = '🔐 审批请求';

/**
 * 创建并注册飞书接入。
 * @param {any} ctx 宿主 Context（只用 ctx.logger(SHORT_ID)）
 * @param {{appId?:string, appSecret?:string, debug?:boolean, logLevel?:string}} [config]
 *        appId/appSecret 支持 'env:NAME' 引用——解析在本模块内完成（resolveSecret）
 * @param {{registerChannel:(ch:any)=>any, dispatchInbound:(m:any)=>any, handleCallback:(c:any)=>any}} core
 * @param {{sdk?:{Client:any, WSClient:any, EventDispatcher:any, LoggerLevel?:any}}} [internals]
 *        internals.sdk 注入假 lark SDK（测试用）；缺省用官方 @larksuiteoapi/node-sdk
 * @returns {() => void} disposer：注销渠道 + 关闭长连接（幂等）
 */
export function createFeishuChannel(ctx, config = {}, core, internals = {}) {
  if (!core || typeof core.registerChannel !== 'function') {
    throw new TypeError(`${LOG_PREFIX} createFeishuChannel: core.registerChannel 不可用（需要 会话运行时实例）`);
  }
  const appId = resolveSecret(config.appId ?? DEFAULT_APP_ID_REF);
  const appSecret = resolveSecret(config.appSecret ?? DEFAULT_APP_SECRET_REF);
  const debug = config.debug === true;
  const logLevel = config.logLevel ?? 'warn';
  const baseUrl = String(config.domain ?? 'https://open.feishu.cn').replace(/\/+$/, '');
  /** 机器人 open_id / 名称（群聊 @ 判定；启动后异步获取）。 */
  let botOpenId = '';
  let botName = '';
  let botInfoLoaded = false;
  /** 可选诊断出口（boot.js 传入 → boot-diag.log）；用于追溯重连/看门狗。 */
  const diagFn = typeof config.diag === 'function' ? config.diag : () => {};
  const diag = (m) => {
    try {
      diagFn(`${LOG_PREFIX} ${m}`);
    } catch { /* 诊断失败不影响连接 */ }
  };

  /** tenant_access_token（失败返回 ''）。 */
  async function fetchTenantToken() {
    try {
      const res = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = await res.json();
      return String(json?.tenant_access_token ?? '');
    } catch {
      return '';
    }
  }

  /** 机器人 open_id / 名称（群聊 @ 判定）。启动后异步取一次；测试跳过。 */
  async function loadBotInfo() {
    if (botInfoLoaded || internals.sdk) return;
    botInfoLoaded = true;
    const token = await fetchTenantToken();
    if (!token) return;
    try {
      const json = await (await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      })).json();
      botOpenId = String(json?.bot?.open_id ?? '');
      botName = String(json?.bot?.app_name ?? '');
      diag(`bot info: ${botName || 'bot'}${botOpenId ? ` (${botOpenId.slice(-6)})` : ''}`);
    } catch (e) {
      diag(`bot info failed: ${e?.message ?? e}`);
    }
  }

  const logger = typeof ctx?.logger === 'function' ? ctx.logger(SHORT_ID) : console;
  /** debug=false 时丢弃 debug 级日志（事件逐条追踪只在 debug=true 时出现）。 */
  const log = (level, ...args) => {
    if (level === 'debug' && !debug) return;
    const fn = typeof logger?.[level] === 'function' ? logger[level] : undefined;
    if (fn) fn.call(logger, ...args);
  };

  // 可注入依赖（测试用）：sdk = { Client, WSClient, EventDispatcher, LoggerLevel }
  const sdk = internals.sdk ?? lark;
  const levelOf = () => sdk.LoggerLevel?.[logLevel];

  /** chatId → receive_id_type（'chat_id' | 'open_id'）：入站时学习，出站优先用学习值 */
  const chatIdKinds = new Map();

  let client = null;
  let wsClient = null;
  let dispatcher = null;
  let watchdog = null;
  let healthTimer = null;
  let fatalAuth = false;
  let slashSynced = false;
  let wsGen = 0;
  let disposed = false;
  let unregister = null;

  /** open_id → 姓名缓存（卡片回调不带姓名；通讯录查询失败时不缓存，下次再试）。 */
  const nameCache = new Map();
  async function resolveUserName(openId) {
    if (!openId) return '';
    if (nameCache.has(openId)) return nameCache.get(openId);
    try {
      const get = client?.contact?.user?.get;
      if (typeof get !== 'function') return '';
      const r = await get.call(client.contact.user, {
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const name = r?.data?.user?.name ?? '';
      if (name) nameCache.set(openId, name);
      return name;
    } catch {
      return ''; // 无通讯录权限 / 查询失败：回退 open_id
    }
  }

  const channel = {
    platform: 'feishu',
    displayName: '飞书',
    status: {
      connected: false,
      detail: appId && appSecret ? 'starting' : 'missing appId/appSecret',
      lastEventAt: null, // 连接活着 ≠ 事件在流：任何事件都刷新此时间戳
    },
    send,
    sendFile,
    dispose: async () => {
      if (disposed) return; // 幂等
      disposed = true;
      watchdog?.dispose();
      watchdog = null;
      stopWs();
      channel.status.connected = false;
      channel.status.detail = 'disposed';
    },
  };

  const ret = core.registerChannel(channel);
  if (typeof ret === 'function') unregister = ret;

  if (!appId || !appSecret) {
    // 缺凭据 = 优雅断开：不建 WSClient、不抛错，状态里如实显示缺口
    log('error',
      '%s missing appId/appSecret — scan to connect in Settings → 飞书, or set FEISHU_APP_ID / FEISHU_APP_SECRET; channel stays disconnected | 缺少 appId/appSecret：可在网页设置「飞书」扫码接入，或设置 FEISHU_APP_ID / FEISHU_APP_SECRET，通道保持断开',
      LOG_PREFIX);
    return disposer;
  }

  client = new sdk.Client({ appId, appSecret, loggerLevel: levelOf() });
  dispatcher = new sdk.EventDispatcher({ loggerLevel: levelOf() });
  dispatcher.register({
    'im.message.receive_v1': (data) => handleMessage(data),
    'card.action.trigger': (data) => handleCardAction(data),
  });
  log('info', '%s event handlers registered (im.message.receive_v1 / card.action.trigger)', LOG_PREFIX);

  // 长连接看门狗：SDK 自带重连，但极端网络下可能「状态卡住且不报错」；
  // 超过 3 分钟仍未恢复 ⇒ 主动拆掉重建（退避 + 配额，见 liveness.js）。
  const quota = createAttemptQuota({ windowMs: 30 * 60_000, limit: 10 });
  watchdog = createReconnectWatchdog({
    deadlineMs: 3 * 60_000,
    // 沿用原参数：30/60/120/300s 退避 + 10 次/30 分钟配额。
    backoffMs: [30_000, 60_000, 120_000, 300_000],
    status: () => {
      try {
        return wsClient?.getConnectionStatus?.()?.state;
      } catch {
        return undefined;
      }
    },
    rebuild: async () => {
      stopWs();
      await startWs();
    },
    report: (line) => {
      log('warn', '%s %s', LOG_PREFIX, line);
      diag(line);
    },
    quota,
  });

  const started = startWs();
  // 20s 健康巡检：SDK 的 reconnect 回调偶尔不触发 / 状态停在 failed。
  // 未连接 ≥ 一个巡检周期就 arm 看门狗；failed 直接立即重建；认证类错误不再重建。
  try {
    started.catch((err) => {
      if (disposed) return;
      channel.status.connected = false;
      channel.status.detail = `start failed | 启动失败: ${err?.message ?? err}`;
      log('error', '%s start failed | 启动失败: %s', LOG_PREFIX, err?.message ?? err);
      diag(`start failed: ${err?.message ?? err}`);
      if (isFatalAuthError(err)) fatalAuth = true;
    });
  } catch { /* 启动同步抛错：交给健康巡检 */ }

  healthTimer = setInterval(() => {
    if (disposed || fatalAuth) return;
    let state;
    try {
      state = wsClient?.getConnectionStatus?.()?.state;
    } catch {
      state = undefined;
    }
    if (state === 'failed') {
      watchdog?.onFailed?.();
      return;
    }
    if (!channel.status.connected) watchdog?.onDisconnected?.();
  }, 20_000);
  healthTimer.unref?.();

  return disposer;

  // ── 斜杠面板同步（0.12.0）──────────────────────────────────────────────────
  //
  // 飞书原生 `/` 指令面板由 OpenAPI 管理：GET/POST /open-apis/application/v7/app_slash_commands。
  // 权限（应用身份）：read=GET 列表，write=POST 创建缺失指令；要「自动注册」两条都必需。
  // syncSlashCommands: true(默认 full) | 'readonly'(只 GET，不创建) | false(关闭)。
  // 客户端有约 5 分钟缓存，注册后不立即显示属正常。
  async function syncSlashCommands() {
    if (slashSynced) return;
    slashSynced = true;
    const rows = config.slashCommands;
    if (internals.sdk || config.syncSlashCommands === false) return; // 测试/显式关闭
    if (!Array.isArray(rows) || rows.length === 0) return;
    const readOnly = config.syncSlashCommands === 'readonly';
    const base = String(config.domain ?? 'https://open.feishu.cn').replace(/\/+$/, '');
    try {
      // 默认走应用身份 tenant token（用户身份 user token 仅作测试/兼容手段）。
      // 优先用配置/环境变量里的 user token；没有才取 tenant token。
      const configuredUserToken = resolveSecret(config.userAccessToken ?? '');
      let token = typeof configuredUserToken === 'string' ? configuredUserToken.trim() : '';
      if (token) {
        diag('slash sync: using user_access_token');
      } else {
        const tokRes = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
          signal: AbortSignal.timeout(10_000),
        });
        const tokJson = await tokRes.json();
        token = tokJson?.tenant_access_token ?? '';
        if (!token) {
          diag(`slash sync skipped: tenant token failed (${tokJson?.code} ${tokJson?.msg})`);
          return;
        }
      }
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const listed = await (await fetch(`${base}/open-apis/application/v7/app_slash_commands`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })).json();
      if (listed?.code !== 0) {
        diag(`slash sync skipped: ${listed?.code} ${listed?.msg}（需应用身份 application:app_slash_command:read）`);
        return;
      }
      const existingMap = new Map((listed?.data?.items ?? [])
        .map((it) => [String(it?.command ?? ''), it]));
      // 已下线命令：mute/unmute/trust/revoke/feedback，以及改名后的 log（→ /output）
      const retired = [...existingMap.values()].filter((it) => ['mute', 'unmute', 'trust', 'revoke', 'feedback', 'log'].includes(it?.command));
      const missing = rows.filter((row) => row?.name && !existingMap.has(row.name));
      const stale = rows.filter((row) => {
        const it = existingMap.get(row?.name);
        if (!it) return false;
        const cur = it?.description?.default_value;
        return typeof cur === 'string' && cur !== row.description;
      });
      if (readOnly) {
        diag(`slash sync (readonly): 已注册 ${existingMap.size} 条，缺失 ${missing.length} 条，描述待更新 ${stale.length} 条，待下线 ${retired.length} 条（write 关闭，不自动处理）`);
        return;
      }
      for (const item of retired) {
        const deleted = await (await fetch(`${base}/open-apis/application/v7/app_slash_commands/${item.command_id}`, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(10_000),
        })).json();
        if (deleted?.code !== 0) {
          diag(`slash command /${item.command} delete failed: ${deleted?.code} ${deleted?.msg}`);
        } else {
          diag(`slash command retired: /${item.command}`);
        }
      }
      for (const row of missing) {
        const created = await (await fetch(`${base}/open-apis/application/v7/app_slash_commands`, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            command: row.name,
            description: { default_value: row.description ?? row.name },
          }),
        })).json();
        if (created?.code !== 0) {
          diag(`slash command /${row.name} failed: ${created?.code} ${created?.msg}（需应用身份 application:app_slash_command:write）`);
          return; // 权限/配额类错误：停止本次同步，下次启动再试
        }
        diag(`slash command registered: /${row.name}`);
      }
      // 已存在但描述变化（例如修正了重复的 /name 前缀）→ PATCH 更新
      for (const row of stale) {
        const item = existingMap.get(row.name);
        const patched = await (await fetch(`${base}/open-apis/application/v7/app_slash_commands/${item.command_id}`, {
          method: 'PATCH',
          headers,
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            description: { default_value: row.description, i18n: { zh_cn: row.description } },
          }),
        })).json();
        if (patched?.code !== 0) {
          diag(`slash command /${row.name} update failed: ${patched?.code} ${patched?.msg}`);
          return;
        }
        diag(`slash command updated: /${row.name}`);
      }
      diag('slash commands synced');
    } catch (err) {
      diag(`slash sync failed: ${err?.message ?? err}`);
    }
  }

  // ── 传输生命周期（重建时复用）──────────────────────────────────────────────

  /** 创建并启动一条 WSClient；每次重建换新实例，旧回调按 wsGen 失配忽略。 */
  function startWs() {
    const gen = ++wsGen;
    const ws = new sdk.WSClient({
      appId,
      appSecret,
      loggerLevel: levelOf(),
      autoReconnect: true, // 心跳/断线重连由 SDK 内置（看门狗只兜底「卡住」）
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 90 }, // 90s 无任何入站帧 ⇒ SDK 判死并进入重连
      onReady: () => {
        if (disposed || gen !== wsGen) return;
        channel.status.connected = true;
        channel.status.detail = 'long connection ready | 长连接已就绪';
        watchdog?.onConnected();
        log('info', '%s long connection ready | 长连接已就绪', LOG_PREFIX);
        diag('long connection ready');
        void loadBotInfo();
        void syncSlashCommands();
      },
      onError: (err) => {
        if (disposed || gen !== wsGen) return;
        channel.status.connected = false;
        channel.status.detail = `ws error: ${err?.message ?? err}`;
        log('error', '%s %s', LOG_PREFIX, err?.message ?? err);
        diag(`ws error: ${err?.message ?? err}`);
        if (isFatalAuthError(err)) {
          fatalAuth = true;
          diag('fatal auth error; watchdog disabled (credentials need fixing)');
          return;
        }
        watchdog?.onDisconnected();
      },
      onReconnecting: () => {
        if (disposed || gen !== wsGen) return;
        channel.status.connected = false;
        channel.status.detail = 'reconnecting | 重连中';
        log('warn', '%s long connection lost, reconnecting | 长连接断开，重连中', LOG_PREFIX);
        diag('long connection lost → reconnecting');
        watchdog?.onDisconnected();
      },
      onReconnected: () => {
        if (disposed || gen !== wsGen) return;
        channel.status.connected = true;
        channel.status.detail = 'long connection ready | 长连接已就绪';
        watchdog?.onConnected();
        log('info', '%s long connection reconnected | 长连接已恢复', LOG_PREFIX);
        diag('long connection reconnected');
        void loadBotInfo();
        void syncSlashCommands();
      },
    });
    wsClient = ws;
    const started = ws.start({ eventDispatcher: dispatcher });
    return started && typeof started.catch === 'function' ? started : Promise.resolve();
  }

  /** 关闭当前 WSClient（幂等）；wsGen 前进使旧实例的回调失效。 */
  function stopWs() {
    wsGen += 1;
    const old = wsClient;
    wsClient = null;
    try {
      old?.close?.();
    } catch { /* 关闭失败不阻断重建 */ }
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────────

  function disposer() {
    try {
      if (unregister) unregister();
      else core.channels?.delete?.('feishu');
    } catch (err) {
      log('warn', '%s channel unregister failed | 渠道注销失败: %s', LOG_PREFIX, err?.message ?? err);
    }
    void channel.dispose();
  }

  // ── 入站 ───────────────────────────────────────────────────────────────────

  /** 提取消息里的图片 key：image 消息 / post 富文本内的 img 段。 */
  function extractImageKeys(message) {
    try {
      const obj = JSON.parse(message.content ?? '{}');
      if (message.message_type === 'image') return obj?.image_key ? [String(obj.image_key)] : [];
      if (message.message_type === 'post') {
        // 飞书事件里 post 正文有两种形态：{post:{zh_cn:{...}}} 或直接的 {title,content}
        const body = obj?.post?.zh_cn ?? obj?.post?.en_us ?? obj;
        const keys = [];
        for (const row of body?.content ?? []) {
          for (const seg of row ?? []) {
            if (seg?.tag === 'img' && seg.image_key) keys.push(String(seg.image_key));
          }
        }
        return keys;
      }
    } catch { /* 非 JSON/无图 */ }
    return [];
  }

  /** 下载飞书图片（image 消息 → bytes）。失败返回 null。 */
  async function downloadImage(messageId, imageKey) {
    if (!messageId || !imageKey) return null;
    const token = await fetchTenantToken();
    if (!token) {
      diag('image download: no tenant token');
      return null;
    }
    try {
      const res = await fetch(
        `${baseUrl}/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) {
        diag(`image download HTTP ${res.status}`);
        return null;
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length === 0 || data.length > 10 * 1024 * 1024) {
        diag(`image download size rejected: ${data.length}`);
        return null;
      }
      const mediaType = String(res.headers.get('content-type') ?? '').split(';')[0].trim() || 'image/png';
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
        diag(`image download type rejected: ${mediaType}`);
        return null;
      }
      return { mediaType, data };
    } catch (e) {
      diag(`image download failed: ${e?.message ?? e}`);
      return null;
    }
  }

  /** 提取消息里的文件：file 消息 / post 内嵌 files（飞书文件+文字常合并为 post）。 */
  function extractFileInfos(message) {
    try {
      const obj = JSON.parse(message.content ?? '{}');
      if (message.message_type === 'file') {
        if (!obj?.file_key) return [];
        return [{ fileKey: String(obj.file_key), name: String(obj.file_name ?? 'file') }];
      }
      if (message.message_type === 'post') {
        const body = obj?.post?.zh_cn ?? obj?.post?.en_us ?? obj;
        return (Array.isArray(body?.files) ? body.files : [])
          .filter((f) => f?.file_key && f?.is_folder !== true)
          .slice(0, 2)
          .map((f) => ({ fileKey: String(f.file_key), name: String(f.file_name ?? 'file') }));
      }
    } catch { /* 非 JSON/无文件 */ }
    return [];
  }

  /** 下载飞书文件（file 消息 → bytes）。失败返回 null。 */
  async function downloadFile(messageId, info) {
    if (!messageId || !info?.fileKey) return null;
    const token = await fetchTenantToken();
    if (!token) {
      diag('file download: no tenant token');
      return null;
    }
    try {
      const res = await fetch(
        `${baseUrl}/open-apis/im/v1/messages/${messageId}/resources/${info.fileKey}?type=file`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
      );
      if (!res.ok) {
        diag(`file download HTTP ${res.status}`);
        return null;
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length === 0 || data.length > 20 * 1024 * 1024) {
        diag(`file download size rejected: ${data.length}`);
        return null;
      }
      return { data, name: info.name };
    } catch (e) {
      diag(`file download failed: ${e?.message ?? e}`);
      return null;
    }
  }

  async function handleMessage(data) {
    const message = data?.message;
    if (!message) return;
    const sender = data?.sender ?? {};
    channel.status.lastEventAt = Date.now();
    if (debug) {
      log('info', '%s event=%s msgId=%s chatId=%s type=%s sender_type=%s',
        LOG_PREFIX, data?.event_type ?? '?', message.message_id, message.chat_id,
        message.message_type, sender.sender_type);
    }
    if (sender.sender_type === 'bot') return; // 忽略机器人自己发的消息（防自激）

    const chatId = String(message.chat_id ?? '');
    const chatType = message.chat_type === 'p2p' ? 'private' : 'group';
    chatIdKinds.set(chatId, 'chat_id'); // 入站即学到该 id 的 receive_id_type
    const openId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? '';
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    // 群聊 @ 判定：优先按机器人 open_id/名称匹配；bot 信息尚未取到时，有 mention 即视为 @ 机器人
    const mentionedBot = mentions.some((m) => {
      const oid = m?.id?.open_id;
      return (botOpenId && oid === botOpenId) || (botName && m?.name === botName);
    }) || (!botOpenId && mentions.length > 0);
    // 图片入模型（默认关；设置页可开）：image 消息 / post 内嵌图片下载后随入站交给核心
    let images = [];
    const imageKeys = extractImageKeys(message);
    if (imageKeys.length || message.message_type === 'image') {
      diag(`image msg: attachImages=${String(config.attachImages)} type=${message.message_type} keys=${imageKeys.length}`);
    }
    if (config.attachImages === true) {
      for (const key of imageKeys.slice(0, 4)) { // 单条最多 4 张，控制体积
        const img = await downloadImage(message.message_id, key);
        if (img) images.push(img);
        else diag(`image download failed: ${String(key).slice(0, 16)}`);
      }
    }
    // 文件：下载后作为 file 附件进模型（file 消息或 post 内嵌 files，20MB/个）
    const files = [];
    for (const fileInfo of extractFileInfos(message)) {
      const file = await downloadFile(message.message_id, fileInfo);
      if (file) files.push(file);
      else diag(`file download failed: ${fileInfo.name}`);
    }
    let text = stripMentionPlaceholders(parseMessageContent(message));
    if (!text.trim() && files.length) {
      text = files.map((f) => `[文件] ${f.name}`).join('\n');
    }
    const inbound = {
      platform: 'feishu',
      chatId,
      userId: String(openId),
      userName: sender.sender_id?.open_id ?? '',
      text,
      msgId: String(message.message_id ?? ''),
      chatType,
      mentionedBot,
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
    };
    settle(core.dispatchInbound(inbound), 'inbound dispatch failed | 入站消息处理失败');
  }

  async function handleCardAction(data) {
    const value = data?.action?.value ?? {};
    const operator = data?.operator ?? {};
    const openId = operator.open_id ?? operator.user_id ?? '';
    const chatId = data?.context?.open_chat_id ?? data?.open_chat_id ?? openId;
    const messageId = data?.context?.open_message_id ?? data?.open_message_id ?? '';
    channel.status.lastEventAt = Date.now();
    if (debug) log('info', '%s card callback action=%s id=%s by=%s', LOG_PREFIX, value.action, value.id, openId);
    if (!value.action) return;
    const id = String(chatId);
    chatIdKinds.set(id, id.startsWith('oc_') ? 'chat_id' : 'open_id');
    // 飞书卡片回调只带 open_id、不带姓名；尽量解析成人名（缓存；无通讯录权限时回退 open_id）
    const userName = operator.name || (await resolveUserName(String(openId))) || String(openId);
    settle(core.handleCallback({
      platform: 'feishu',
      chatId: id,
      userId: String(openId),
      userName,
      // 卡片消息 id：用于校验「点击的是不是当初发出去的那张卡」（防转发卡越权）
      messageId: String(messageId),
      // 卡片 value 三段原样拼回核心回调载荷（字段内不得含冒号）
      data: `${value.action}:${value.id ?? ''}:${value.answer ?? ''}`,
    }), 'callback failed | 回调处理失败');
  }

  /** 核心方法可能返回非 promise（假 core / 同步实现）⇒ 两种形态都只记日志，不外抛。 */
  function settle(result, label) {
    if (result && typeof result.catch === 'function') {
      result.catch((err) => log('warn', '%s %s: %s', LOG_PREFIX, label, err?.message ?? err));
      return;
    }
    if (result instanceof Error) log('warn', '%s %s: %s', LOG_PREFIX, label, result.message);
  }

  // ── 出站 ───────────────────────────────────────────────────────────────────

  /** receive_id_type 判定：入站学习的类型优先；否则按前缀启发（ou_/on_/oi_=open_id，其余=chat_id）。 */
  function kindFor(chatId) {
    const s = String(chatId);
    const known = chatIdKinds.get(s);
    if (known) return known;
    if (s.startsWith('ou_') || s.startsWith('on_') || s.startsWith('oi_')) return 'open_id';
    return 'chat_id';
  }

  /** 出站：无 buttons ⇒ 文本消息；有 buttons ⇒ 审批按钮卡片。返回 {messageId}。 */
  async function send(out = {}) {
    const receiveId = out.chatId;
    const receiveIdType = kindFor(receiveId);
    if (out.buttons?.length) {
      return sendCard(receiveId, receiveIdType, out);
    }
    if (out.text) {
      try {
        const r = await client.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: out.text }) },
        });
        if (debug) log('info', '%s text sent to %s (%s) ok=%s', LOG_PREFIX, receiveId, receiveIdType, r?.code === 0);
        return { messageId: messageIdOf(r) };
      } catch (err) {
        log('error', '%s send to %s failed | 发送失败: %s (code=%s msg=%s)',
          LOG_PREFIX, receiveId, err?.message ?? err, err?.code, err?.msg);
        throw err;
      }
    }
    return {};
  }

  /** 按钮卡片：每按钮 value = {action,id,answer}（由按钮 id 'action:id:answer' 拆出，回调原样回传）。 */
  async function sendCard(receiveId, receiveIdType, out) {
    const actions = out.buttons.map((b) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: b.label },
      type: b.style === 'danger' ? 'danger' : b.style === 'primary' ? 'primary' : 'default',
      value: parseButtonValue(b.id),
    }));
    const card = {
      config: { wide_screen_mode: true },
      // 卡片标题由调用方给（审批 / AI 提问 / 新用户授权 / 出错重试…），缺省沿用审批标题
      header: { title: { tag: 'plain_text', content: out.title ?? APPROVAL_CARD_TITLE }, template: out.template ?? 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: out.text } },
        { tag: 'action', actions },
      ],
    };
    const sent = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    return { messageId: messageIdOf(sent) };
  }

  /** 文件消息（/log 全量交付）：先上传（upload_file 形态）再发 file 消息。 */
  async function sendFile(chatId, fileName, content) {
    const receiveIdType = kindFor(chatId);
    const upload = await client.im.file.create({
      data: { file_type: 'stream', file_name: fileName, file: Buffer.from(String(content ?? ''), 'utf8') },
    });
    const fileKey = upload?.file_key;
    if (!fileKey) throw new Error(`${LOG_PREFIX} feishu file upload failed (no file_key)`);
    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
    });
  }
}

/** 飞书消息创建响应 → message_id（不同 SDK 版本字段层级不同）。 */
function messageIdOf(res) {
  return String(res?.data?.message_id ?? res?.message_id ?? '');
}

/** 认证类错误：重建也解决不了，反复重连只会烧连接配额。 */
function isFatalAuthError(err) {
  const text = `${err?.message ?? ''} ${err?.code ?? ''} ${err?.msg ?? ''}`;
  return /app_id|app_secret|invalid app|credential|authentication|permission denied/i.test(text);
}

/**
 * 按钮 id（'approve:a1b2:yes'）→ 卡片 value 三段（飞书把 value 原样回传，故三段不得含冒号）。
 * @param {string} id
 * @returns {{action:string, id:string, answer:string}}
 */
export function parseButtonValue(id) {
  const parts = String(id ?? '').split(':');
  return { action: parts[0] ?? '', id: parts[1] ?? '', answer: parts[2] ?? '' };
}

/**
 * 去掉飞书 @ 占位符（`@_user_1` / `@_all`）：群聊命令必须还原成 `/new` 才能被识别。
 * @param {string} text
 * @returns {string}
 */
export function stripMentionPlaceholders(text) {
  return String(text ?? '')
    .replace(/@_user_\d+/g, ' ')
    .replace(/@_all\b/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 解析飞书消息内容（text / post / file / image / interactive）为纯文本。
 * @param {{message_type?:string, content?:string}} message
 * @returns {string}
 */
export function parseMessageContent(message) {
  if (!message?.content) return '';
  let obj;
  try {
    obj = JSON.parse(message.content);
  } catch {
    return String(message.content);
  }
  if (message.message_type === 'text') return typeof obj?.text === 'string' ? obj.text : '';
  if (message.message_type === 'post') {
    // 兼容 {post:{zh_cn:{...}}} 与直接的 {title, content} 两种事件形态
    const body = obj?.post?.zh_cn ?? obj?.post?.en_us ?? obj;
    const text = (body?.content ?? [])
      .map((row) => (row ?? []).map((seg) => {
        if (seg?.tag === 'text') return seg.text ?? '';
        if (seg?.tag === 'a') return `${seg.text ?? ''} (${seg.href ?? ''})`;
        if (seg?.tag === 'img') return ''; // 图片由 images 附件承载
        return seg?.text ?? '';
      }).join(''))
      .filter((line) => line.trim())
      .join('\n');
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    return title ? `${title}\n${text}` : text;
  }
  if (message.message_type === 'file') return `[文件] ${obj?.file_name ?? ''}`.trim();
  if (message.message_type === 'image') return '[图片]';
  if (message.message_type === 'interactive') return '[交互卡片]';
  return JSON.stringify(obj).slice(0, 500);
}
