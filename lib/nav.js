// lib/nav.js —— GUI 导航通道的 host 半：自注册 loopback 前缀路由 '/dsh-feishu-pilot'（lib/rpc-route.js）。
// 用插件自己的 ctx.webServer.register：本运行时 connection.rpc.handle 不可用（owner.webServer 锚定到
// connection 服务自身 fiber，必报 "without inject"）；协议与客户端 connection.rpc.call 兼容，Host/Origin
// 围栏复用 connection.requestRejection。
//
// 导航语义：nav.poll {lastApplied} 只在 seq > lastApplied 时下发最新命令；服务端不清队列，多标签各自
// 按 seq 去重，nav.ack 只是遥测；nav.fail {seq, chatKey, workspacePath} 按 chatKey 定向发「桌面视图
// 同步超时」卡片。载荷 {seq, platform, chatId, workspacePath, sessionId, title}，chatKey 由
// platform/chatId 拼出（定向回报必须能定位聊天）。
//
// 设置页端点：security.admins / admin.add / admin.remove —— 核心 SessionMap 现成 API，运行时增删即
// 持久化（mappings.json），可信用户管理不必改配置重启；security.autoCreate.get/set —— 翻转 cfg（每条
// 消息现读 ⇒ 立即生效）并写 im-overrides.json（覆盖配置文件值，重启后 wire 时重新应用）；
// feishu.status / qr.begin / qr.poll / qr.cancel / config.set —— 渠道状态 + 扫码接入（lib/feishu/
// provision.js）+ 手动配置写凭据（0600，只回 appId 不回 secret）；
// settings.channel.cancel —— 取消飞书连接：channel.dispose()（lark WSClient.close() = 确定性停止、
// 无效化自动重连循环）+ 删插件自有凭据文件（env 凭据不受影响）
// ⇒ 重启后不自动重连，可重新扫码绑定新机器人；remote.notify / approval / question 的 get/set ——
// 读 live 现值（插件配置 ∪ im-overrides.json）/ 写覆盖节（原子落盘 + ovrRef 刷新，模块每次事件
// 现读 ⇒ 即时生效），approval 与 question 另有 mode 三态校验 + pending 计数。
//
// 契约：
//   installRpc(ctx, deps) => disposer     ← ctx 需已 inject ['connection','webServer']
//   createNav(deps) => { enqueueNav(cmd) }
//   deps = { state, im, log, stateDir?, remote?, feishu? }   // feishu = {current: {provision}}

import { registerRpcChannel } from './rpc-route.js';
import { saveOverride } from './im-overrides.js';
import { readCredentials, resolveSecret } from './feishu/credentials.js';
import { writeCredentials } from './feishu/provision.js';
import { PKG_NAME, dshHome, CREDENTIALS_REL, LEGACY_CREDENTIALS_RELS } from './identity.js';

export const NAV_CHANNEL = `/${PKG_NAME}`;

/** 导航命令有效期：页面重载后不下发超过此年龄的命令（陈旧命令会被反复重放 → nav.fail → 400）。 */
const NAV_TTL_MS = 120_000;

/**
 * 用户键规范化：核心用户键 = `platform:userId`
 * （SessionMap.isAdmin 等按此拼接）。设置页输入兼容两种形态：
 *   - 完整键 'feishu:ou_xxx'（机器人「当前未授权」消息里给出的形态）
 *   - 裸 open_id 'ou_xxx'（自动补 feishu: 前缀）
 * @returns {string|null} 规范化后的键；非法输入返回 null
 */
export function normalizeUserKey(raw) {
  const key = String(raw ?? '').trim();
  if (!key) return null;
  const idx = key.indexOf(':');
  const platform = idx > 0 ? key.slice(0, idx) : 'feishu';
  const userId = idx > 0 ? key.slice(idx + 1) : key;
  if (!/^[a-z][a-z0-9-]*$/.test(platform)) return null;
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(userId)) return null;
  return `${platform}:${userId}`;
}

function splitUserKey(key) {
  const idx = key.indexOf(':');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/**
 * @param {any} ctx  已 inject ['connection','webServer'] 的上下文（有 .webServer.register）
 * @param {{state:any, im:any, log?:(...a:any[])=>void}} deps
 */
export function installRpc(ctx, deps) {
  const { state, im, log = () => {}, stateDir = null, remote = null, feishu = null, feishuChannel = null } = deps;
  if (typeof ctx?.webServer?.register !== 'function') {
    log('[feishu-pilot] webServer 不可用 —— GUI 导航跟随不可用（服务端切换不受影响）');
    return () => {};
  }

  // ── remote.* 端点辅助（任务通知 / 飞书审批 设置卡）──
  // live 值 = 插件配置节 ∪ im-overrides.json 现值（UI 翻转即时生效）。
  const remoteLive = (section, base) => ({
    ...(base ?? {}),
    ...(remote?.ovrRef?.current?.[section] ?? {}),
  });
  /** 授权名单（当前用户优先：admins 在前，其后 allowlist；去重）。 */
  const authorizedKeys = () => {
    const out = [];
    const seen = new Set();
    const push = (k) => {
      if (typeof k !== 'string' || !k || seen.has(k)) return;
      seen.add(k);
      out.push(k);
    };
    try {
      const a = im?.map?.admins;
      if (a) for (const k of a instanceof Set ? [...a] : Array.from(a)) push(String(k));
      const l = im?.map?.allowlist;
      if (l) for (const k of l instanceof Set ? [...l] : Array.from(l)) push(String(k));
    } catch { /* 无 */ }
    return out;
  };
  const ownerKeyOf = () => {
    try {
      if (typeof im?.ownerKey === 'function') return im.ownerKey();
    } catch { /* 无 */ }
    return authorizedKeys()[0] ?? '';
  };
  const pendingList = () => {
    try {
      return im?.pending?.list?.() ?? [];
    } catch {
      return [];
    }
  };
  const usersPayload = () => {
    const owner = ownerKeyOf();
    return {
      users: authorizedKeys().map((key) => ({ key, owner: key === owner })),
      owner,
      pending: pendingList(),
    };
  };

  const feishuTarget = (cfg) => {
    if (cfg.targetChatId) return String(cfg.targetChatId);
    // 当前机器人记住的私聊（首个授权用户写入；换 bot 时随身份清空）
    const remembered = im?.map?.notifyChatId;
    return typeof remembered === 'string' && remembered ? remembered : null;
  };
  const feishuChannelOk = () => {
    try {
      if (im?.getChannel?.('feishu')) return true;
      const st = im?.channelsStatus?.();
      return !!st?.[0] && st[0].connected !== false;
    } catch {
      return false;
    }
  };
  /**
   * 查询当前机器人是否已开通「群内全部消息」权限 im:message.group_msg。
   * 用应用信息接口（需要 application:application:self_manage）；失败返回 granted=null。
   * 结果缓存 60 秒，避免设置页轮询重复打接口。
   * @returns {Promise<{appId:string, granted:boolean|null, grantUrl:string, reason?:string}>}
   */
  let groupScopeCache = { at: 0, appId: '', value: null };
  const checkGroupMsgScope = async (force = false) => {
    const raw = readCredentials({ home: dshHome() });
    const appId = resolveSecret(feishuChannel?.appId ?? 'env:FEISHU_APP_ID')
      || (typeof raw?.appId === 'string' ? raw.appId : '');
    if (!appId) return { appId: '', granted: null, grantUrl: '', reason: 'no-app-id' };
    if (!force && groupScopeCache.appId === appId && Date.now() - groupScopeCache.at < 60_000) {
      return groupScopeCache.value;
    }
    const appSecret = resolveSecret(feishuChannel?.appSecret ?? 'env:FEISHU_APP_SECRET')
      || (typeof raw?.appSecret === 'string' ? raw.appSecret : '');
    const base = String(feishuChannel?.domain ?? 'https://open.feishu.cn').replace(/\/+$/, '');
    // self_manage 已在扫码时预填：能查应用信息 ⇒ 只需再开 group_msg
    const groupUrl = `https://open.feishu.cn/app/${appId}/auth?q=im:message.group_msg&op_from=openapi&token_type=tenant`;
    const bothUrl = `https://open.feishu.cn/app/${appId}/auth?q=im:message.group_msg,application:application:self_manage&op_from=openapi&token_type=tenant`;
    if (!appSecret) return { appId, granted: null, selfManageGranted: null, grantUrl: bothUrl, reason: 'no-app-secret' };
    let value;
    try {
      const tok = await (await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(8000),
      })).json();
      const token = tok?.tenant_access_token;
      if (!token) {
        value = { appId, granted: null, selfManageGranted: null, grantUrl: bothUrl, reason: `token ${tok?.code ?? ''}` };
      } else {
        const res = await (await fetch(`${base}/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        })).json();
        if (res?.code !== 0) {
          value = { appId, granted: null, selfManageGranted: null, grantUrl: bothUrl, reason: `${res?.code ?? ''} ${res?.msg ?? ''}`.trim() };
        } else {
          const scopes = Array.isArray(res?.data?.app?.scopes) ? res.data.app.scopes : [];
          value = {
            appId,
            granted: scopes.some((s) => s?.scope === 'im:message.group_msg'),
            selfManageGranted: true,
            grantUrl: groupUrl,
          };
        }
      }
    } catch (err) {
      value = { appId, granted: null, selfManageGranted: null, grantUrl: bothUrl, reason: String(err?.message ?? err) };
    }
    groupScopeCache = { at: Date.now(), appId, value };
    return value;
  };
  const mergeRemoteSection = (section, keys, payload) => {
    const cur = remote?.ovrRef?.current?.[section] ?? {};
    const patch = { ...cur };
    for (const k of keys) if (payload?.[k] !== undefined) patch[k] = payload[k];
    return patch;
  };

  const sendToChat = async (platform, chatId, text) => {
    try {
      await im.push(platform, chatId, { text });
    } catch (e) {
      log(`[feishu-pilot] nav fail-notice send failed: ${e?.message}`);
    }
  };

  return registerRpcChannel(ctx, NAV_CHANNEL, async (endpoint, payload = {}) => {
    try {
      switch (endpoint) {
        case 'nav.poll': {
          const lastApplied = Number(payload.lastApplied ?? 0);
          // 只下发新鲜命令：页面重载时 lastApplied 归 0，持久化的旧命令会被反复重放，
          // 客户端对已失效的 chat/会话重试 → nav.fail → 向已失效 chat 推送 → 飞书 400。
          const cmd = state.lastNav(NAV_TTL_MS);
          if (cmd && cmd.seq > lastApplied) return { ok: true, value: { seq: cmd.seq, cmd } };
          return { ok: true, value: { seq: state.data.navSeq ?? 0, cmd: null } };
        }
        case 'nav.ack':
          // 仅遥测：服务端不清队列（多标签各自按 seq 去重）
          return { ok: true, value: { acked: payload.seq ?? null } };
        case 'nav.fail': {
          const chatKey = String(payload.chatKey ?? '');
          const idx = chatKey.indexOf(':');
          if (idx <= 0) return { ok: false, error: 'bad chatKey' };
          const platform = chatKey.slice(0, idx);
          const chatId = chatKey.slice(idx + 1);
          // 只向「当前仍绑定」的聊天发通告：陈旧命令的 chatKey（已解绑/已失效聊天）推送会被
          // 飞书拒（400 invalid receive_id），既无意义又刷日志。
          let bound = false;
          try { bound = !!(im?.map?.get?.(platform, chatId)); } catch { /* 无核心面 ⇒ 视为未绑定 */ }
          log(`[feishu-pilot] nav fail: seq=${payload.seq ?? '?'} chat=${chatKey}`
            + ` ws=${payload.workspacePath ?? ''} reason=${payload.reason ?? 'n/a'} bound=${bound}`);
          if (!bound) {
            return { ok: true, value: { notified: null, skipped: chatKey } };
          }
          await sendToChat(platform, chatId,
            `⏱ 桌面视图同步超时：请从 GUI 手动打开工作区「${payload.workspacePath ?? ''}」（服务端切换已生效，仅视图未跟上）。`);
          return { ok: true, value: { notified: chatKey } };
        }
        case 'settings.status': {
          // 每行富化会话名称（sessionTitle 投影）+ 工作区标题（workspaceRegistry
          // 只读 resolveByPath）——只有 chatKey + sessionId 无法辨认绑定的是哪个会话。
          const sessionsSvc = ctx.get?.('sessions');
          const titleSvc = ctx.get?.('sessionTitle');
          const wsReg = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry');
          const bindings = [];
          // 以真实绑定为准（/status 同源）；intent 仅用于补充工作区/模式。
          // 旧实现遍历 listIntents，导致没有意图记录的聊天（如群聊）在设置页消失。
          const intentByChat = new Map();
          for (const it of state.listIntents()) intentByChat.set(it.chatKey, it);
          for (const b of im.map.list()) {
            const chatKey = `${b.platform}:${b.chatId}`;
            const intent = intentByChat.get(chatKey) ?? {};
            const sess = sessionsSvc?.get?.(b.sessionId);
            const row = {
              ...intent,
              chatKey,
              platform: b.platform,
              chatId: b.chatId,
              chatType: b.chatType,
              sessionId: b.sessionId,
              workspacePath: intent.workspacePath ?? sess?.header?.cwd ?? '',
              degraded: state.isDegraded(b.platform, b.chatId),
              sessionTitle: '',
            };
            if (sess) {
              try {
                const snap = titleSvc?.get?.(sess);
                row.sessionTitle = snap && typeof snap.title === 'string' ? snap.title : (typeof snap === 'string' ? snap : '');
              } catch { /* 标题缺失不阻断 */ }
            }
            // 冷会话（重启后 / 非 live）标题不在 sessionTitle 服务里：与 /status 同源，
            // 从落盘快照兜底，避免设置页永远显示「未命名会话」。
            if (!row.sessionTitle) {
              try {
                const query = ctx.get?.('sessionQuery');
                if (query?.readTitleSnapshots) {
                  const [res] = await query.readTitleSnapshots([b.sessionId]);
                  const t = res?.status === 'fulfilled' ? res.value?.title?.title : '';
                  if (typeof t === 'string') row.sessionTitle = t.trim();
                }
              } catch { /* 兜底失败不阻断 */ }
            }
            if (row.workspacePath) {
              try {
                const ws = wsReg?.resolveByPath ? await wsReg.resolveByPath(row.workspacePath) : undefined;
                if (ws?.title) row.workspaceTitle = ws.title;
              } catch { /* 工作区暂不可用 ⇒ 无标题（路径仍在） */ }
            }
            bindings.push(row);
          }
          return { ok: true, value: { bindings, navSeq: state.data.navSeq ?? 0 } };
        }
        case 'settings.unbind': {
          const chatKey = String(payload.chatKey ?? '');
          const idx = chatKey.indexOf(':');
          if (idx <= 0) return { ok: false, error: 'bad chatKey' };
          const platform = chatKey.slice(0, idx);
          const chatId = chatKey.slice(idx + 1);
          // 真正删除绑定（旧实现只清意图，绑定仍在 ⇒ /status 与列表都不变）
          if (typeof im?.map?.remove === 'function') im.map.remove(platform, chatId);
          await state.clearIntent(platform, chatId);
          return { ok: true, value: { unbound: chatKey } };
        }
        case 'security.admins': {
          // 兼容端点（旧设置页/测试）：admins + allowlist + 待批准
          const map = im.map;
          if (!map) return { ok: false, error: 'core unavailable' };
          return { ok: true, value: { admins: [...map.admins], allowlist: [...map.allowlist], pending: pendingList() } };
        }
        case 'security.users': {
          // 单一授权名单（当前用户 = 第一条）+ 待批准
          if (!im.map) return { ok: false, error: 'core unavailable' };
          return { ok: true, value: usersPayload() };
        }
        case 'security.user.add': {
          const map = im.map;
          if (!map || typeof map.addToAllowlist !== 'function') return { ok: false, error: 'core unavailable' };
          const key = normalizeUserKey(payload.key);
          if (!key) return { ok: false, error: 'bad key（格式 feishu:ou_xxx 或裸 open_id）' };
          const existed = map.allowlist?.has?.(key) === true || map.admins?.has?.(key) === true;
          map.addToAllowlist(...splitUserKey(key));
          im.pending?.remove(key);
          return { ok: true, value: { ...usersPayload(), added: key, existed } };
        }
        case 'security.user.remove': {
          const map = im.map;
          if (!map || typeof map.removeFromAllowlist !== 'function') return { ok: false, error: 'core unavailable' };
          const key = normalizeUserKey(payload.key);
          if (!key) return { ok: false, error: 'bad key（格式 feishu:ou_xxx 或裸 open_id）' };
          if (key === ownerKeyOf()) return { ok: false, error: '不能移除当前用户' };
          map.removeFromAllowlist(...splitUserKey(key));
          if (typeof map.removeAdmin === 'function') map.removeAdmin(...splitUserKey(key));
          im.pending?.remove(key);
          return { ok: true, value: { ...usersPayload(), removed: key } };
        }
        case 'security.pending.approve': {
          const map = im.map;
          if (!map || typeof map.addToAllowlist !== 'function') return { ok: false, error: 'core unavailable' };
          const key = normalizeUserKey(payload.key);
          if (!key) return { ok: false, error: 'bad key（格式 feishu:ou_xxx 或裸 open_id）' };
          const item = typeof im.pending?.get === 'function' ? im.pending.get(key) : null;
          map.addToAllowlist(...splitUserKey(key));
          im.pending?.remove(key);
          // 回执给被批准用户（拿不到 chatId 或渠道不在时静默）
          if (item?.chatId) {
            try {
              await im.send({ platform: item.platform, chatId: item.chatId }, {
                text: '✅ 已授权，可以开始派活。发送 /new 创建会话。',
              });
            } catch { /* 渠道不可达不影响批准结果 */ }
          }
          return { ok: true, value: { ...usersPayload(), approved: key } };
        }
        case 'security.pending.ignore': {
          const key = normalizeUserKey(payload.key);
          if (!key) return { ok: false, error: 'bad key（格式 feishu:ou_xxx 或裸 open_id）' };
          im.pending?.remove(key);
          return { ok: true, value: { ...usersPayload(), ignored: key } };
        }
        case 'security.admin.add': {
          const map = im.map;
          if (!map || typeof map.addAdmin !== 'function') return { ok: false, error: 'core unavailable' };
          const key = normalizeUserKey(payload.key);
          if (!key) return { ok: false, error: 'bad key（格式 feishu:ou_xxx 或裸 open_id）' };
          map.addAdmin(...splitUserKey(key)); // 内部 _scheduleSave ⇒ mappings.json 持久化
          return { ok: true, value: { admins: [...map.admins], allowlist: [...map.allowlist], added: key } };
        }
        case 'security.admin.remove': {
          const map = im.map;
          if (!map || typeof map.removeAdmin !== 'function') return { ok: false, error: 'core unavailable' };
          const key = normalizeUserKey(payload.key);
          if (!key) return { ok: false, error: 'bad key（格式 feishu:ou_xxx 或裸 open_id）' };
          map.removeAdmin(...splitUserKey(key)); // 内部 _scheduleSave ⇒ mappings.json 持久化
          return { ok: true, value: { admins: [...map.admins], allowlist: [...map.allowlist], removed: key } };
        }
        case 'security.autoCreate.get': {
          const sec = im.cfg?.security;
          if (!sec) return { ok: false, error: 'core unavailable' };
          return { ok: true, value: { enabled: !!sec.autoCreate } };
        }
        case 'security.autoCreate.set': {
          const sec = im.cfg?.security;
          if (!sec) return { ok: false, error: 'core unavailable' };
          if (typeof payload.enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值' };
          sec.autoCreate = payload.enabled; // 核心每条消息现读 ⇒ 下一条消息即生效
          if (stateDir) {
            await saveOverride(stateDir, { autoCreate: payload.enabled }); // 持久化 > 配置文件
          }
          return { ok: true, value: { enabled: payload.enabled, persisted: !!stateDir } };
        }
        case 'settings.groupMention.get': {
          const sec = im.cfg?.security;
          if (!sec) return { ok: false, error: 'core unavailable' };
          const required = sec.groupMentionRequired !== false;
          if (required) return { ok: true, value: { required } };
          // 关闭「仅 @」后持续检查 group_msg：未开通/无法确认时前端保留引导链接
          let grant = null;
          try {
            grant = await checkGroupMsgScope();
          } catch { /* 检查失败按未知处理 */ }
          return {
            ok: true,
            value: {
              required,
              ...(grant ? {
                appId: grant.appId,
                groupMsgGranted: grant.granted,
                selfManageGranted: grant.selfManageGranted,
                grantUrl: grant.grantUrl,
                ...(grant.reason ? { reason: grant.reason } : {}),
              } : {}),
            },
          };
        }
        case 'settings.groupMention.set': {
          const sec = im.cfg?.security;
          if (!sec) return { ok: false, error: 'core unavailable' };
          if (typeof payload.required !== 'boolean') return { ok: false, error: 'required 必须是布尔值' };
          sec.groupMentionRequired = payload.required; // 每条入站消息现读 ⇒ 立即生效
          if (stateDir) {
            await saveOverride(stateDir, { groupMentionRequired: payload.required });
          }
          // 关闭「仅 @」后，群内全部消息依赖 im:message.group_msg：自动检查并给开通链接
          let grant = null;
          if (payload.required === false) {
            try {
              grant = await checkGroupMsgScope();
            } catch { /* 检查失败不阻断设置 */ }
          }
          return {
            ok: true,
            value: {
              required: payload.required,
              persisted: !!stateDir,
              ...(grant ? {
                appId: grant.appId,
                groupMsgGranted: grant.granted,
                selfManageGranted: grant.selfManageGranted,
                grantUrl: grant.grantUrl,
                ...(grant.reason ? { reason: grant.reason } : {}),
              } : {}),
            },
          };
        }
        case 'settings.attachImages.get': {
          if (!feishuChannel) return { ok: false, error: 'channel config unavailable' };
          return { ok: true, value: { enabled: feishuChannel.attachImages === true } };
        }
        case 'settings.attachImages.set': {
          if (!feishuChannel) return { ok: false, error: 'channel config unavailable' };
          if (typeof payload.enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值' };
          feishuChannel.attachImages = payload.enabled; // channel 每条消息现读 getter
          if (stateDir) await saveOverride(stateDir, { attachImages: payload.enabled });
          return { ok: true, value: { enabled: payload.enabled, persisted: !!stateDir } };
        }
        // ── remote.*（设置页「任务完成通知」「飞书审批」卡）──
        // 读现值（live = 插件配置 ∪ im-overrides.json）；写 = 合并覆盖节 +
        // 原子落 im-overrides.json + 刷新 ovrRef（模块每次事件现读 ⇒ 即时生效）。
        case 'remote.notify.get': {
          if (!remote) return { ok: false, error: 'remote module not wired' };
          const cfg = remoteLive('notify', remote.notifyBase);
          const target = feishuTarget(cfg);
          return { ok: true, value: {
            enabled: !!cfg.enabled,
            includeBound: !!cfg.includeBound,
            includeSubagents: !!cfg.includeSubagents,
            target: target ?? '',
            targetSource: cfg.targetChatId ? 'config' : (target ? 'bot' : 'none'),
            blacklist: Array.isArray(cfg.blacklist) ? cfg.blacklist : [],
            channelOk: feishuChannelOk(),
          } };
        }
        case 'remote.notify.set': {
          if (!remote || !stateDir) return { ok: false, error: 'remote module not wired' };
          if (payload?.blacklist !== undefined && !Array.isArray(payload.blacklist)) {
            return { ok: false, error: 'blacklist must be an array' };
          }
          const patch = mergeRemoteSection('notify',
            ['enabled', 'includeBound', 'includeSubagents', 'targetChatId', 'blacklist'], payload);
          if (Array.isArray(patch.blacklist)) {
            // 去重 + 去空 + 限长（最多 50 条，每条 200 字符）
            patch.blacklist = [...new Set(patch.blacklist
              .map((x) => String(x ?? '').trim().slice(0, 200))
              .filter(Boolean))].slice(0, 50);
          }
          const next = await saveOverride(stateDir, { notify: patch });
          remote.ovrRef.current = next;
          return { ok: true, value: next.notify };
        }
        case 'remote.approval.get': {
          if (!remote) return { ok: false, error: 'remote module not wired' };
          const cfg = remoteLive('remoteApproval', remote.approvalBase);
          const target = feishuTarget(cfg);
          return { ok: true, value: {
            enabled: !!cfg.enabled,
            mode: cfg.mode ?? 'feishu',
            timeoutSec: Number(cfg.timeoutSec) || 300,
            target: target ?? '',
            targetSource: cfg.targetChatId ? 'config' : (target ? 'bot' : 'none'),
            pending: remote.approval?.pending?.() ?? 0,
            channelOk: feishuChannelOk(),
          } };
        }
        case 'remote.approval.set': {
          if (!remote || !stateDir) return { ok: false, error: 'remote module not wired' };
          const patch = mergeRemoteSection('remoteApproval',
            ['enabled', 'mode', 'timeoutSec', 'targetChatId'], payload);
          if (patch.mode !== undefined && !['feishu', 'gui-first', 'off'].includes(patch.mode)) {
            return { ok: false, error: `invalid mode: ${patch.mode}` };
          }
          const next = await saveOverride(stateDir, { remoteApproval: patch });
          remote.ovrRef.current = next;
          // 绑定会话审批由核心 ApprovalManager 处理 ⇒ 同步 live 窗口
          const t = Number(patch.timeoutSec);
          if (Number.isFinite(t) && im?.approvals) {
            im.approvals.timeoutSec = Math.max(30, Math.min(3600, Math.round(t)));
          }
          if (patch.mode !== undefined || patch.enabled !== undefined) {
            const ra = next.remoteApproval ?? {};
            if (im?.approvals) {
              im.approvals.guiOnly = ra.enabled === false
                || ra.mode === 'gui-first'
                || ra.mode === 'off';
            }
          }
          return { ok: true, value: next.remoteApproval };
        }
        // ── remote.question.*（设置页「飞书提问」卡，lib/remote-question.js）──
        case 'remote.question.get': {
          if (!remote) return { ok: false, error: 'remote module not wired' };
          const cfg = remoteLive('remoteQuestion', remote.questionBase);
          const target = feishuTarget(cfg);
          return { ok: true, value: {
            enabled: !!cfg.enabled,
            mode: cfg.mode ?? 'feishu',
            timeoutSec: Number(cfg.timeoutSec) || 300,
            target: target ?? '',
            targetSource: cfg.targetChatId ? 'config' : (target ? 'bot' : 'none'),
            pending: remote.question?.pending?.() ?? 0,
            channelOk: feishuChannelOk(),
          } };
        }
        case 'remote.question.set': {
          if (!remote || !stateDir) return { ok: false, error: 'remote module not wired' };
          const patch = mergeRemoteSection('remoteQuestion',
            ['enabled', 'mode', 'timeoutSec', 'targetChatId'], payload);
          if (patch.mode !== undefined && !['feishu', 'gui-first', 'off'].includes(patch.mode)) {
            return { ok: false, error: `invalid mode: ${patch.mode}` };
          }
          const next = await saveOverride(stateDir, { remoteQuestion: patch });
          remote.ovrRef.current = next;
          return { ok: true, value: next.remoteQuestion };
        }
        case 'feishu.status': {
          // 渠道卡轮询：连接状态 + 扫码会话状态（一律脱敏，secret 不出 Host）
          const ch = im.channels?.get?.('feishu');
          const provision = feishu?.current?.provision;
          return {
            ok: true,
            value: {
              connected: ch?.status?.connected === true,
              detail: ch?.status?.detail ?? '',
              lastEventAt: ch?.status?.lastEventAt ?? null,
              provision: provision ? provision.poll() : { phase: 'unavailable' },
            },
          };
        }
        case 'feishu.qr.begin': {
          // 必须发射后不管：await 会把响应阻塞到扫码完成 ⇒ 浏览器等 begin、begin 等扫码、
          // 扫码要 poll 带出二维码 —— 三方互等，UI 永卡「申请中…」（历史实测）
          const provision = feishu?.current?.provision;
          if (!provision) return { ok: false, error: 'provision session unavailable' };
          if (feishu?.current) feishu.current.qrReconnectDone = false;
          void provision.begin();
          return { ok: true, value: { phase: 'starting' } };
        }
        case 'feishu.qr.poll': {
          const provision = feishu?.current?.provision;
          if (!provision) return { ok: false, error: 'provision session unavailable' };
          const value = provision.poll();
          // 扫码完成（凭据已落盘）⇒ 本进程内直接重建渠道，免重启生效
          if (value?.phase === 'succeeded') {
            const cur = feishu?.current;
            if (cur && !cur.qrReconnectDone) {
              cur.qrReconnectDone = true;
              void Promise.resolve(cur.reconnect?.())
                .then((ok) => log(`[feishu-pilot] qr hot reconnect: ${ok ? 'ok' : 'failed'}`))
                .catch((err) => log(`[feishu-pilot] qr hot reconnect error: ${err?.message ?? err}`));
            }
          }
          return { ok: true, value };
        }
        case 'feishu.qr.cancel': {
          const provision = feishu?.current?.provision;
          if (!provision) return { ok: false, error: 'provision session unavailable' };
          provision.cancel();
          return { ok: true, value: { phase: 'cancelled' } };
        }
        case 'feishu.config.set': {
          // 手动配置：写凭据文件（0600），只回 appId 不回 secret；随后热重连，免重启。
          const appId = typeof payload?.appId === 'string' ? payload.appId.trim() : '';
          const appSecret = typeof payload?.appSecret === 'string' ? payload.appSecret.trim() : '';
          if (!appId || !appSecret) return { ok: false, error: 'appId 与 appSecret 均必填' };
          await writeCredentials({ home: dshHome(), appId, appSecret, source: 'manual' });
          log(`[feishu-pilot] credentials written for appId=${appId}, hot reconnect`);
          let reconnected = false;
          try {
            reconnected = await feishu?.current?.reconnect?.() === true;
          } catch { /* 重连失败：凭据已写入，用户可重试/重启 */ }
          return { ok: true, value: { appId, reconnected } };
        }
        case 'settings.channel.info': {
          // 手动配置卡片的「当前机器人」识别（单机器人架构，
          // 凭据链 = env 优先 → 文件）。只读，不改任何状态。
          const ch = im.channels?.get?.('feishu');
          const connected = ch?.status?.connected === true;
          const envActive = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
          const raw = readCredentials({ home: dshHome() });
          const fileAppId = typeof raw?.appId === 'string' ? raw.appId : null;
          const fileSource = typeof raw?.source === 'string' ? raw.source : (fileAppId ? 'unknown' : null);
          return { ok: true, value: { connected, envActive, fileAppId, fileSource } };
        }
        case 'settings.channel.cancel': {
          // 取消飞书连接（设置页「❌ 取消连接」按钮）
          const ch = im.channels?.get?.('feishu');
          let closed = false;
          if (ch?.dispose) {
            try { await ch.dispose(); closed = true; } catch { /* 已关闭/无连接 */ }
          }
          // 渠道 dispose 已置断开态；此处兜底补写 detail（UI 轮询 feishu.status 即可读到）
          if (ch?.status) {
            ch.status.connected = false;
            ch.status.detail = '已手动取消（凭据已清除，重新扫码可绑定新机器人）| cancelled by user';
          }
          // 删插件自有凭据文件；env 凭据不受影响。
          let cleared = false;
          try {
            const { rm } = await import('node:fs/promises');
            const { join } = await import('node:path');
            const home = dshHome();
            // 现行凭据 + 历史路径（错误连接时两处都清，避免旧目录凭据被只读回退捡回）
            const files = [CREDENTIALS_REL, ...LEGACY_CREDENTIALS_RELS].map((rel) => join(home, rel));
            try {
              let removed = false;
              for (const f of files) {
                try { await rm(f, { force: true }); removed = true; } catch { /* 不存在 ⇒ 跳过 */ }
              }
              cleared = removed;
            } catch { /* 权限等异常 ⇒ 视作未清除 */ }
          } catch (e) {
            log(`[feishu-pilot] cancel: credential cleanup failed: ${e?.message}`);
          }
          // 立即清空 API 客户端：否则通知/进度模块仍用旧 app 凭据继续推送（0.19.1）
          try { feishu?.current?.clearLark?.(); } catch { /* 无 lark 来源 */ }
          // 手动断开 = 换机器人/重置：清空绑定、授权、意图（旧 app 的 chatId/open_id 全部失效）
          let clearedBindings = 0;
          let clearedUsers = 0;
          try {
            const map = im?.map;
            const before = new Set([...(map?.admins ?? []), ...(map?.allowlist ?? [])]);
            clearedBindings = map?.chats?.size ?? 0;
            clearedUsers = before.size;
            map?.clearAll?.();
            await map?.save?.();
          } catch (e) {
            log(`[feishu-pilot] cancel: local state cleanup failed: ${e?.message}`);
          }
          try {
            for (const it of state?.listIntents?.() ?? []) {
              await state?.clearIntent?.(it.platform, it.chatId);
            }
          } catch (e) {
            log(`[feishu-pilot] cancel: intent cleanup failed: ${e?.message}`);
          }
          log(`[feishu-pilot] channel cancelled (closed=${closed}, cleared=${cleared}, bindings=${clearedBindings}, users=${clearedUsers})`);
          return { ok: true, value: { closed, cleared, clearedBindings, clearedUsers } };
        }
        default:
          return { ok: false, error: `Unknown endpoint: ${endpoint}` };
      }
    } catch (err) {
      log(`[feishu-pilot] rpc ${endpoint} failed: ${err?.message}`);
      return { ok: false, error: err?.message ?? String(err) };
    }
  }, 'feishu-pilot: nav rpc channel');
}

/**
 * 导航队列（host）：服务端只保留最新命令，seq 单调持久化。
 * @param {{state:any}} deps
 */
export function createNav(deps) {
  const { state } = deps;
  return {
    /** enqueueNav({seq, platform, chatId, workspacePath, sessionId, title}) */
    enqueueNav(cmd) {
      state.keepNav(cmd);
    },
  };
}
