// lib/boot.js —— 核心引导编排（插件自有，0.9.0）。
//
// 职责：把插件配置（imCore 块）翻译成核心 CoreConfig、解析 agent 模型与预设挂载、
// 初始化核心，再创建飞书接入与扫码会话。
// 编排顺序由 index.js 保证：bootstrapCore → wire(bridge 等) → bootstrapFeishu
// （渠道开始收消息前，桥已就位）。
//
// 状态目录：核心 storeDir 默认 = 插件状态目录（$DSH_HOME/dsh-feishu-pilot）。

import { commandCatalog, FeishuImCore } from './core/runtime.js';
import { makeAgentSetup } from './agent-setup.js';
import { createFeishuChannel } from './feishu/channel.js';
import { createFeishuProvisionSession } from './feishu/provision.js';
import { resolveSecret } from './feishu/credentials.js';
import { dshHome, SHORT_ID } from './identity.js';
import { resolveFeishuWsDir } from './feishu-workspace.js';

/** 核心安全/agent 配置默认值（审批与通知策略在核心模块内固定）。 */
export const CORE_DEFAULTS = Object.freeze({
  security: {
    allowlist: [],
    admins: [],
    autoCreate: false,
    maxSessions: 10,
    trustOnFirstContact: false,
    groupMentionRequired: true,
  },
  agent: { provider: '', model: '', workspace: '' },
  storeDir: '',
});

function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object') {
    return over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

/** 合并核心配置：CORE_DEFAULTS ← 插件 config.imCore 块（storeDir 空 ⇒ 插件状态目录；
 *  agent.workspace 空 ⇒ 飞书专用工作区目录，避免回退到 process.cwd()）。 */
export function mergeCoreConfig(pluginConfig = {}, stateDir) {
  const { imCore = {} } = pluginConfig;
  const cfg = deepMerge(CORE_DEFAULTS, imCore);
  cfg.storeDir = cfg.storeDir || stateDir;
  if (!cfg.agent.workspace) cfg.agent.workspace = resolveFeishuWsDir(pluginConfig.feishuWs ?? {});
  delete cfg.enabled; // imCore.enabled 是插件级开关，不进核心
  return cfg;
}

/**
 * 等待某个服务就位，双保险：
 * ① ctx.get 轮询——服务已在祖先链上（e2e 根 ctx provide / 宿主挂载顺序靠前）时立即可见；
 * ② ctx.inject 等待——服务由晚挂载的兄弟插件 fiber 提供（真宿主 agentDefaultModel
 *    即此形态，裸 get 不可见）⇒ provide 时 notify 补触发。
 * 超时返回 undefined。
 */
export function waitForService(ctx, name, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false;
    let poll = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (poll) clearInterval(poll);
      resolve(v);
    };
    const tryGet = () => {
      try {
        const v = ctx.get?.(name) ?? ctx.reflect?.get?.(name, false);
        if (v) finish(v);
      } catch {
        /* 不可见时 get 可能抛 ⇒ 忽略，等 inject/轮询 */
      }
    };
    tryGet();
    try {
      ctx.inject?.([name], (c) => {
        try {
          const v = c[name];
          if (v) finish(v); // falsy 不提前结算 ⇒ 交给轮询/超时
        } catch {
          /* 未就位即访问会抛 ⇒ 交给轮询/超时 */
        }
      });
    } catch {
      /* 无 inject API ⇒ 只剩轮询 */
    }
    if (!done) {
      if (typeof ctx.inject !== 'function') {
        // 无 inject API（e2e 假 ctx / 单测裸对象）：不可见即缺席，立即结算
        // （unref 定时器撑不住 await，会挂死测试；真宿主 ctx 必有 inject）
        finish(undefined);
      } else {
        poll = setInterval(tryGet, 200);
        if (typeof poll.unref === 'function') poll.unref();
        const t = setTimeout(() => finish(undefined), timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }
    }
  });
}

/**
 * 引导核心（已初始化、agent 解析已就位）。
 * imCore.agent 未钉死（provider/model 为空）⇒ 运行时解析 'agentDefaultModel'
 * 服务（GUI 默认模型）并覆写 core.agentOptions——每次创建派活会话都实时读取
 * 当前默认模型，改默认模型无需重启。核心自带的 ctx.get 回退链在真宿主不通
 * （不声明 inject 且引导早于该插件挂载），故这里用 inject 等待语义补齐。
 * @param {any} ctx Cordis Context
 * @param {object} pluginConfig 本插件配置（读 imCore 块）
 * @param {{stateDir: string, log?: (msg:string)=>void}} opts
 * @returns {Promise<FeishuImCore>}
 */
export async function bootstrapCore(ctx, pluginConfig, { stateDir, log = () => {} }) {
  const cfg = mergeCoreConfig(pluginConfig, stateDir);
  const core = new FeishuImCore({ ctx, cfg, logger: makeCoreLogger(ctx, log) });
  await core.init();

  if (!cfg.agent.provider || !cfg.agent.model) {
    const svc = await waitForService(ctx, 'agentDefaultModel');
    if (svc && typeof svc.currentSelection === 'function') {
      core.setAgentOptionsResolver(async () => {
        try {
          const sel = svc.currentSelection();
          if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
        } catch { /* 落回兜底 */ }
        return { provider: 'home-new-api', model: 'qwen3.8-flash-next' };
      });
      log('imCore.agent 未钉死 ⇒ 飞书派活会话跟随 GUI 默认模型（agentDefaultModel，逐会话实时解析）');
    } else {
      log('imCore.agent 未钉死且 agentDefaultModel 服务缺席 ⇒ 用内置兜底 home-new-api/qwen3.8-flash-next');
      core.setAgentOptionsResolver(async () => ({ provider: 'home-new-api', model: 'qwen3.8-flash-next' }));
    }
  }

  // 会话创建/恢复必须挂默认 agent 预设：核心工具栈（read/edit/pwsh/bash/web…）与
  // 系统提示都挂在预设 bundle 里；裸 agents.create 的派活会话只剩全局可见的
  // 插件工具、系统提示为空（真机实录）。
  const presets = await waitForService(ctx, 'agentPresets');
  if (presets && typeof presets.mount === 'function') {
    core.agentSetup = makeAgentSetup(ctx, log);
    log('im 会话创建/恢复将挂载默认 agent 预设（agentPresets）⇒ 核心工具栈 + 系统提示就位');
  } else {
    log('agentPresets 服务缺席 ⇒ im 会话保持裸创建（缺核心工具栈/系统提示）');
  }
  return core;
}

/** 核心日志适配器：ctx.logger(SHORT_ID)，缺席时 console。 */
function makeCoreLogger(ctx, log) {
  const base = typeof ctx?.logger === 'function' ? ctx.logger(SHORT_ID) : null;
  const emit = (level, ...args) => {
    const fn = typeof base?.[level] === 'function' ? base[level] : undefined;
    if (fn) fn.call(base, ...args);
    else if (level === 'warn' || level === 'error') log(formatArgs(args));
  };
  return {
    info: (...a) => emit('info', ...a),
    warn: (...a) => emit('warn', ...a),
    error: (...a) => emit('error', ...a),
    debug: () => {},
  };
}

function formatArgs(args) {
  return args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
}

/**
 * 创建飞书接入 + 扫码会话（须在 wire(bridge) 之后调用——渠道收到消息即 dispatch，
 * 桥未就位会丢命令拦截）。
 * 缺凭据 ⇒ 渠道优雅断开（不抛错）。
 * 扫码/手填成功后调用返回的 reconnect() 即可**免重启**换机器人。
 * @param {any} ctx
 * @param {object} pluginConfig 读 feishuChannel 块
 * @param {FeishuImCore} core
 * @param {{log?:Function, internals?:{sdk?:object, provisionSdk?:object, skipChannel?:boolean}}} [opts]
 *   internals.skipChannel=true（测试专用）：不创建真渠道，只保留扫码会话。
 * @returns {{ dispose: () => void, provision: {begin:Function, poll:Function, cancel:Function}, reconnect: () => Promise<boolean> }}
 */
export async function bootstrapFeishu(ctx, pluginConfig, core, { log = () => {}, internals = {} } = {}) {
  const provision = createFeishuProvisionSession({
    home: dshHome(),
    log: (m) => log(`[feishu-pilot] provision: ${m}`),
    ...(internals.provisionSdk ? { sdk: internals.provisionSdk } : {}),
  });
  if (internals.skipChannel) {
    return {
      dispose: () => { try { provision.cancel(); } catch { /* 幂等 */ } },
      provision,
      reconnect: async () => false,
    };
  }
  const channelConfig = () => {
    const { appId, appSecret, debug, logLevel } = pluginConfig.feishuChannel ?? {};
    return {
      appId: appId ?? 'env:FEISHU_APP_ID',
      appSecret: appSecret ?? 'env:FEISHU_APP_SECRET',
      debug: debug ?? false,
      logLevel: logLevel ?? 'warn',
      // 连接生命周期/看门狗事件写 boot-diag，断网恢复慢时可追溯
      diag: (m) => log(m),
      // 斜杠面板同步（application/v7/app_slash_commands；缺权限时渠道内优雅跳过）
      slashCommands: commandCatalog(),
      // 图片入模型开关（设置页可即时翻转；默认关）
      get attachImages() {
        return pluginConfig.feishuChannel?.attachImages === true;
      },
    };
  };
  const currentAppId = () => {
    const { appId } = pluginConfig.feishuChannel ?? {};
    return resolveSecret(appId ?? 'env:FEISHU_APP_ID');
  };
  // 渠道启动前先绑定身份：appId 变化即清空旧 app 的绑定/授权/通知目标
  await core.bindBotIdentity?.(currentAppId());
  let disposeChannel = createFeishuChannel(ctx, channelConfig(), core, internals);
  let reconnecting = false;
  // 等待渠道真正连上（鉴权失败/网络失败会停在 false），用于给 UI 返回真实结果
  const waitConnected = async (timeoutMs = 8000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const ch = core.getChannel?.('feishu');
      if (ch?.status?.connected === true) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  };
  // 扫码/手填写入新凭据后调用：换身份 → 关旧渠道 → 用文件里的新凭据重建
  const reconnect = async () => {
    if (reconnecting) return false;
    reconnecting = true;
    try {
      const nextAppId = currentAppId();
      const changed = await core.bindBotIdentity?.(nextAppId);
      if (changed) log(`[feishu-pilot] bot identity switched → ${nextAppId}; old app state cleared`);
      try {
        await disposeChannel?.();
      } catch { /* 旧连接可能已断 */ }
      // 给 WSClient.close 一点时间释放旧长连接，避免新旧同 app 短暂并存
      await new Promise((r) => setTimeout(r, 200));
      disposeChannel = createFeishuChannel(ctx, channelConfig(), core, internals);
      if (!(await waitConnected())) {
        log('[feishu-pilot] channel reconnect did not connect (check appId/appSecret/permissions)');
        return false;
      }
      log('[feishu-pilot] channel reconnected with new credentials (hot reload)');
      return true;
    } catch (err) {
      log(`[feishu-pilot] channel reconnect failed: ${err?.message ?? err}`);
      return false;
    } finally {
      reconnecting = false;
    }
  };
  return {
    dispose: () => {
      try {
        provision.cancel();
      } catch { /* 幂等 */ }
      try {
        disposeChannel?.();
      } catch { /* 幂等 */ }
    },
    provision,
    reconnect,
  };
}
