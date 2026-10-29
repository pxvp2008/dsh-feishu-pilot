// dsh-feishu-pilot —— 飞书远控插件（host 半装配）。
// 插件自带会话能力（lib/core/）与飞书接入（lib/feishu/），无外部插件依赖：
// bootstrapCore → wire(bridge 等覆写) → bootstrapFeishu（lib/boot.js）。
// 覆写面仅 2 个核心入口（dispatchInbound / handleCallback）+ 自有 API-only lark client。
// imCore.enabled=false ⇒ 降级纯工具模式（agent 工具 feishu_ws 文本交互，无富卡片）。
// 不变式：I1 每聊天恰一条绑定（rebind 只替换/首建）；I2 旧会话不 detach（被淘汰会话留原工作区，GUI 可打开）；
// I3 对账修复方向恒指向磁盘意图（只读对账）；I4 意图写入是提交点（紧邻 rebind 之前）。

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createState } from './lib/state.js';
import { PKG_NAME, migrateLegacyStateDir, stateDirOf } from './lib/identity.js';
import { attach } from './lib/bridge.js';
import { createSwitcher } from './lib/switcher.js';
import { createCommands } from './lib/commands.js';
import { createCards, createLarkClient } from './lib/cards.js';
import { createNav, installRpc, NAV_CHANNEL } from './lib/nav.js';
import { ensureBinding } from './lib/reconcile.js';
import { createProgress } from './lib/progress.js';
import { createRemoteNotify } from './lib/remote-notify.js';
import { createRemoteApproval } from './lib/remote-approval.js';
import { createRemoteQuestion } from './lib/remote-question.js';
import { createSendToolDefinition } from './lib/send-tool.js';
import { loadOverrides, applyOverrides } from './lib/im-overrides.js';
import { ensureFeishuWorkspace, DEFAULT_FEISHU_WS, resolveFeishuWsDir } from './lib/feishu-workspace.js';
import { bootstrapCore, bootstrapFeishu } from './lib/boot.js';

// sessionTitle 不进 inject：声明式依赖会让降级场景误判。生产修复只依赖
// ctx.get('sessionTitle')（ctx 真实方法，不受 inject 声明限制）
// + 无标题时的「目录名 · 时间」人类可读回退（见 lib/session-picker.js）。
export const name = PKG_NAME;
export const inject = ['agents', 'workspaceRegistry'];

const DEFAULT_CONFIG = Object.freeze({
  tokenTtlMs: 10 * 60_000,
  tokenLruMax: 200,
  repairCooldownMs: 10 * 60_000,
  repairFailThreshold: 3,
  nav: { tickMs: 2000, retryMaxMs: 15000, retryMaxCount: 8 },
  progress: { enabled: true, intervalMs: 1500, patchTerminal: false, toolLines: true, maxTools: 8, maxTextChars: 4000 },
  // agent 主动发消息（lib/send-tool.js，0.12.0）：仅本会话绑定聊天，5 条/分钟
  sendTool: { enabled: true },
  // 任意会话任务结束 → 飞书通知（lib/remote-notify.js）
  notify: {
    enabled: true,
    targetChatId: '', // oc_/ou_；空 = 自动取核心管理员里第一个 feishu:ou_… 的 open_id
    includeBound: false, // 飞书绑定会话也发（默认关：绑定聊天已由核心通知总线推结果卡）
    includeSubagents: false, // 子智能体/团队子会话也发（默认关：防刷屏）
    maxSummaryChars: 300,
    rateLimitMs: 30_000,
  },
  // 任意会话的飞书审批 answerer（lib/remote-approval.js）
  remoteApproval: {
    enabled: true,
    mode: 'feishu', // feishu=双端同时（GUI 与飞书竞速，先处理者生效） | gui-first=仅 GUI | off=仅 GUI
    timeoutSec: 300, // 飞书卡有效窗口 → 仅飞书侧失效，结果以 GUI 最终结算为准
    targetChatId: '', // 同 notify.targetChatId 语义
  },
  // 任意会话的飞书交互提问/计划评审 answerer（lib/remote-question.js）
  remoteQuestion: {
    enabled: true,
    mode: 'feishu', // 同 remoteApproval.mode 语义（双端同时）
    timeoutSec: 300, // 同 remoteApproval.timeoutSec 语义（飞书卡有效窗口）
    targetChatId: '', // 同 notify.targetChatId 语义
  },
  // 内置会话配置（lib/core/，引导见 lib/boot.js）。
  // security.admins 默认空 = deny-all（核心会打警告）：真实 open_id 属个人信息，
  // **不写入可发布的代码**；部署方在 profile 配置里填自己的 feishu:ou_…（见 HANDOVER）。
  imCore: {
    enabled: true, // false = 不引导核心（纯工具模式：只剩 feishu_ws 工具）
    security: {
      admins: [], // 管理员 = 自动推送目标（由部署方配置，见上）
      allowlist: [], // 运行期信任的追加持久化在核心 storeDir（mappings.json）
      autoCreate: false,
      maxSessions: 10,
      trustOnFirstContact: false,
      // 群聊默认仅 @机器人 时响应（关闭后群内所有消息都会派活）
      groupMentionRequired: true,
    },
    // 绑定会话审批：飞书卡有效窗口（设置页「审批 / 提问有效期」同步）
    approval: { timeoutSec: 300 },
    // provider/model 留空 = 跟随 GUI 默认模型（agentDefaultModel 服务，
    // 逐会话实时解析，见 lib/boot.js bootstrapCore）；显式填值 = 钉死。
    // workspace 留空 ⇒ 运行时回退到飞书专用工作区目录（可移植，不写死本机路径）。
    agent: { provider: '', model: '', workspace: '' },
    storeDir: '', // 空 = 插件状态目录 $DSH_HOME/dsh-feishu-pilot
  },
  // 飞书接入凭据/日志（env: 引用；缺凭据 = 优雅断开）
  feishuChannel: {
    appId: 'env:FEISHU_APP_ID',
    appSecret: 'env:FEISHU_APP_SECRET',
    debug: false,
    logLevel: 'warn',
    domain: 'https://open.feishu.cn',
    syncSlashCommands: true, // 首次连上后同步 / 指令面板（需应用有 app_slash_command 权限）
    // 斜杠指令权限仅提供「用户身份」⇒ 测试时可给 user_access_token（默认读环境变量）
    userAccessToken: 'env:FEISHU_USER_ACCESS_TOKEN',
    attachImages: false, // 飞书图片入模型（默认关；设置页可开）
  },
});

function mergeConfig(userConfig = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    nav: { ...DEFAULT_CONFIG.nav, ...(userConfig.nav ?? {}) },
    progress: { ...DEFAULT_CONFIG.progress, ...(userConfig.progress ?? {}) },
    notify: { ...DEFAULT_CONFIG.notify, ...(userConfig.notify ?? {}) },
    remoteApproval: { ...DEFAULT_CONFIG.remoteApproval, ...(userConfig.remoteApproval ?? {}) },
    remoteQuestion: { ...DEFAULT_CONFIG.remoteQuestion, ...(userConfig.remoteQuestion ?? {}) },
    sendTool: { ...DEFAULT_CONFIG.sendTool, ...(userConfig.sendTool ?? {}) },
    // 飞书创建会话的专用工作区（lib/feishu-workspace.js）
    feishuWs: { ...DEFAULT_FEISHU_WS, ...(userConfig.feishuWs ?? {}) },
    // 独立模式（imCore 逐字段合并，security/agent 子块单独合并）
    imCore: {
      ...DEFAULT_CONFIG.imCore,
      ...(userConfig.imCore ?? {}),
      security: { ...DEFAULT_CONFIG.imCore.security, ...(userConfig.imCore?.security ?? {}) },
      approval: { ...DEFAULT_CONFIG.imCore.approval, ...(userConfig.imCore?.approval ?? {}) },
      agent: { ...DEFAULT_CONFIG.imCore.agent, ...(userConfig.imCore?.agent ?? {}) },
    },
    feishuChannel: { ...DEFAULT_CONFIG.feishuChannel, ...(userConfig.feishuChannel ?? {}) },
  };
}

/**
 * im 惰性访问代理：核心引导是异步的（state.load → bootstrapCore），而 switcher 等
 * 模块在引导完成前就要构造 ⇒ 所有对核心的访问走代理，核心就位后透明解析。
 * @param {{current: any}} holder
 */
function imProxy(holder) {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const im = holder.current;
      if (!im) return undefined;
      const v = im[prop];
      return typeof v === 'function' ? v.bind(im) : v;
    },
  });
}

export function apply(ctx, rawConfig = {}) {
  const config = mergeConfig(rawConfig);
  // 2.1.0 更名：先把旧状态目录里的凭据/绑定/授权/待批准/意图迁到新目录，再构造 state 与引导
  // （顺序不能反——createState 是 apply 内第一个读盘者）。显式配置了 stateDir 时不迁移：
  // 旧目录只存在于默认位置，自定义目录意味着用户自己管理状态。
  const migrationWarnings = [];
  const migration = config.stateDir
    ? { migrated: false, from: null, to: config.stateDir, copied: [], errors: [], elapsedMs: 0 }
    : migrateLegacyStateDir({ log: (m) => migrationWarnings.push(m) });
  // 引导诊断落盘：宿主 stdout 未必可见（GUI 后台启动），插件级日志与引导标记
  // 写进状态目录 boot-diag.log，供真机排障。
  const bootDiag = (m) => {
    try {
      const dir = stateDirOf(config);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'boot-diag.log'), `${new Date().toISOString()} ${m}\n`);
    } catch { /* 诊断不得成为故障源 */ }
  };
  const log = (m) => { ctx.logger?.warn?.(`dsh-feishu-pilot: ${m}`); bootDiag(m); };
  if (migration.migrated) {
    bootDiag(`状态目录迁移：${migration.from} → ${migration.to}`
      + `（${migration.copied.length} 项，${migration.elapsedMs}ms）`);
  }
  // 迁移期的告警也要落 boot-diag（失败诊断入口），不能只进宿主 console
  for (const warning of migrationWarnings) bootDiag(`状态目录迁移告警：${warning}`);
  const state = createState(ctx, { stateDir: config.stateDir, ...config });
  const disposers = [];
  const imHolder = { current: null };
  const im = imProxy(imHolder);
  let wired = false;
  // im-overrides.json 现值（UI 开关即时翻转 + 跨重启持久化）。
  // wire 加载时置初值；remote-notify / remote-approval 每次事件现读此引用。
  const ovrRef = { current: null };
  // 飞书接入/扫码会话 holder（nav RPC 的 feishu.* 端点现读）
  const feishuRef = { current: null };

  // lark 引用 holder：createCards/createProgress 闭包持有同一对象，凭据解析完成后
  // Object.assign 原地刷新（lark client 的构造是异步的）
  const larkHolder = { available: false, kindFor: undefined, sendCard: async () => null, patchCard: async () => {} };
  // 断开连接时清空 API 客户端：否则 remote-notify/progress 仍持有旧 app 的 client，
  // 会继续用旧机器人推任务通知（0.19.1 修复）。
  const clearLark = () => {
    Object.assign(larkHolder, {
      available: false,
      kindFor: undefined,
      sendCard: async () => null,
      patchCard: async () => {},
    });
  };
  // 换机器人/重连后按新凭据重建 API 客户端，通知改走新机器人。
  const refreshLark = async () => {
    try {
      Object.assign(larkHolder, config.larkClient ?? (await createLarkClient(ctx, config)));
      return larkHolder.available === true;
    } catch (e) {
      log(`[feishu-pilot] lark client refresh failed: ${e?.message ?? e}`);
      clearLark();
      return false;
    }
  };
  // 全局「新建会话」按钮的固定目标 = 飞书专用工作区（显式配置优先，否则 $DSH_HOME/feishu-sessions）
  const feishuWsPath = resolveFeishuWsDir(config.feishuWs);
  const cards = createCards(ctx, { state, im, lark: larkHolder, feishuWsPath });
  const nav = createNav({ state });
  const switcher = createSwitcher(ctx, { state, im, cards, nav, config, log });
  const commands = createCommands(ctx, { state, im, switcher, cards, nav, feishuWsPath });

  // 降级工具随时可注册（seams 缺失时立即注册；seams 后到时也可补桥）。
  // tools 是宿主服务、本 fiber 未声明 ⇒ 裸访问抛 "without inject"（e2e 全局 provide 会掩盖）
  // ⇒ 用运行期 ctx.inject 等待（同 nav RPC 模式）。
  const registerTool = () => {
    const doIt = (c) => {
      try {
        c.tools.register(feishuWsTool(state, switcher, log));
      } catch (e) {
        log(`feishu_ws tool register failed: ${e?.message}`);
      }
    };
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['tools'], doIt);
        return;
      } catch { /* 落回裸访问（测试假 ctx） */ }
    }
    doIt(ctx);
  };

  const wire = (core) => {
    if (wired) return;
    wired = true;
    imHolder.current = core;
    // 0.12.0：feishu_send（agent 主动发消息），只允许本会话绑定的聊天
    const registerSend = (c) => {
      try {
        const def = createSendToolDefinition({ im: core, log, config: config.sendTool });
        if (def) disposers.push(c.tools.register(def));
      } catch (e) {
        log(`feishu_send tool register failed: ${e?.message}`);
      }
    };
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['tools'], registerSend);
      } catch { registerSend(ctx); }
    } else {
      registerSend(ctx);
    }
    const stateDir = stateDirOf(config);
    // 飞书审批 answerer 先于桥 attach 创建（bridge 覆写要路由 gapp:* 回调）
    const remoteApproval = createRemoteApproval(ctx, { im: core, lark: larkHolder, config, ovrRef, log, stateDir });
    // 飞书提问/计划评审 answerer（bridge 覆写路由 guq:* 回调，同审批）
    const remoteQuestion = createRemoteQuestion(ctx, { im: core, config, ovrRef, log, stateDir });
    disposers.push(attach(ctx, core, { state, commands, switcher, ensureBinding, remoteApproval, remoteQuestion }));
    disposers.push(() => remoteApproval.dispose());
    disposers.push(() => remoteQuestion.dispose());
    // UI 覆盖：im-overrides.json > 配置文件（lib/im-overrides.js）。
    // 核心每条消息现读 cfg.security ⇒ 翻转字段即立即生效；wire 在启动期
    // 完成（用户消息远在其后），竞态窗口可忽略。
    void (async () => {
      const ovr = await loadOverrides(stateDir);
      ovrRef.current = ovr; // 0.2.0：remote-notify/approval 的 live 覆盖现值
      // 绑定会话审批走核心 ApprovalManager：启动时同步有效期，避免重启后回落到 300s
      const approvalTimeout = Number(ovr?.remoteApproval?.timeoutSec);
      if (Number.isFinite(approvalTimeout)) {
        core.approvals.timeoutSec = Math.max(30, Math.min(3600, Math.round(approvalTimeout)));
      }
      core.approvals.guiOnly = ovr?.remoteApproval?.enabled === false
        || ovr?.remoteApproval?.mode === 'gui-first'
        || ovr?.remoteApproval?.mode === 'off';
      const applied = applyOverrides(core, ovr);
      // 图片入模型开关也持久化在 im-overrides（channel 通过 getter 现读）
      if (typeof ovr?.attachImages === 'boolean') {
        config.feishuChannel.attachImages = ovr.attachImages;
        applied.attachImages = ovr.attachImages;
      }
      if (Object.keys(applied).length) log(`applied im overrides: ${JSON.stringify(applied)}`);
    })().catch((e) => log(`im overrides apply failed: ${e?.message}`));
    // nav RPC 通道：本 DSH 版本的 connection.rpc.handle 不可用（owner.webServer 经 traceable
    // shadow 锚定到 connection 服务自身 fiber，必报 "without inject"，与消费方 inject 无关）
    // ⇒ installRpc 走 webServer.register 自注册前缀路由（lib/rpc-route.js，
    // dsh-webhook-github 同款生产模式；协议与客户端 rpc.call 兼容）。
    // webServer 缺席的平台（非 web）⇒ 该 inject 永不触发 ⇒ nav 通道静默不装；
    // installRpc 内部另有 webServer 缺席检测，外层 catch 双保险（只降级不炸 boot）。
    ctx.inject?.(['connection', 'webServer'], (c) => {
      try {
        disposers.push(installRpc(c, {
          state,
          im: core,
          log,
          stateDir,
          // feishu.* 端点（渠道状态 / 扫码接入 / 手动配置，0.9.0 并入本插件 RPC 通道）
          feishu: feishuRef,
          // 图片入模型开关（live 修改，channel 通过 getter 现读）
          feishuChannel: config.feishuChannel,
          // remote.* 端点（任务通知/飞书审批/飞书提问开关，写 im-overrides.json）
          remote: {
            ovrRef,
            approval: remoteApproval,
            question: remoteQuestion,
            notifyBase: config.notify,
            approvalBase: config.remoteApproval,
            questionBase: config.remoteQuestion,
          },
        }));
      } catch (e) {
        log(`[feishu-pilot] nav RPC 注册失败 —— GUI 导航跟随不可用（服务端切换不受影响）: ${e?.message}`);
      }
    });
    const progress = createProgress(ctx, { state, im: core, cards, lark: larkHolder, config, diag: bootDiag });
    disposers.push(() => progress.dispose());
    // 进度卡已展示正文与统计 ⇒ 抑制“全文单独一条”和绑定会话结果卡，避免多条重复；
    // lark 不可用时进度卡发不出去，结果卡仍是唯一兜底。
    if (core?.notify && config.progress?.enabled !== false) {
      core.notify.suppressFullText = true;
      core.notify.suppressBoundResult = () => larkHolder.available === true;
    }
    // 任意会话任务结束 → 飞书通知（绑定/子会话默认跳过，lib/remote-notify.js）
    const remoteNotify = createRemoteNotify(ctx, { im: core, config, ovrRef, lark: larkHolder, log });
    disposers.push(() => remoteNotify.dispose());
  };

  state
    .load()
    .then(async () => {
      // 测试缝：显式注入的 lark client（离线 e2e 断言卡片用）优先于 env 凭据解析
      await refreshLark();
      bootDiag(`lark client: available=${larkHolder.available === true}`);
      // 飞书创建会话的专用工作区（独立于核心；失败只记日志，不阻断 boot）
      void ensureFeishuWorkspace(ctx, { ...config.feishuWs, log }).catch(() => {});
      if (config.imCore?.enabled === false) {
        log('imCore.enabled=false ⇒ 纯工具模式（只剩 feishu_ws 工具）');
        registerTool();
        return;
      }
      try {
        const core = await bootstrapCore(ctx, config, { stateDir: stateDirOf(config), log });
        if (typeof config.coreBootHook === 'function') config.coreBootHook(core); // 测试缝（e2e 取实例）
        wire(core);
        // 渠道在 wire 之后创建：收到消息即 dispatch，桥未就位会丢命令拦截
        const feishu = await bootstrapFeishu(ctx, config, core, {
          log,
          ...(config.feishuInternals ? { internals: config.feishuInternals } : {}),
        });
        // 换机器人后通知/进度/审批也必须改用新 app 的 API client
        const reconnectChannel = feishu.reconnect;
        if (typeof reconnectChannel === 'function') {
          feishu.reconnect = async () => {
            const ok = await reconnectChannel();
            if (ok) await refreshLark();
            else clearLark();
            return ok;
          };
        }
        // nav 的「断开连接」在删除凭据后调用，立即停掉旧 app 的通知推送
        feishu.clearLark = clearLark;
        feishuRef.current = feishu;
        disposers.push(() => feishu.dispose());
        log('引导完成（核心 + bridge + 飞书接入）');
      } catch (e) {
        log(`核心引导失败: ${e?.message ?? e} —— 降级为纯工具模式`);
        registerTool();
      }
    })
    .catch((e) => log(`init failed: ${e?.message ?? e}`));

  return () => {
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch (e) {
        log(`disposer failed: ${e?.message}`);
      }
    }
    void state.dispose();
  };
}

/**
 * 纯工具模式（imCore.enabled=false 或核心引导失败）的 agent 文本工具。
 * 让 agent 能查询/切换工作区绑定（纯文本，无富卡片）。
 */
function feishuWsTool(state, switcher, log) {
  return {
    name: 'feishu_ws',
    description:
      '飞书远控工作区工具（降级模式）：查询飞书聊天的工作区绑定，或把某个飞书聊天切换到指定已注册工作区（新建会话）。'
      + '参数：action=list（列出绑定）/ switch（platform, chatId, workspacePath）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'switch'], description: 'list 或 switch' },
        platform: { type: 'string', description: '平台标识（switch 必填）' },
        chatId: { type: 'string', description: '聊天 id（switch 必填）' },
        workspacePath: { type: 'string', description: '目标工作区绝对路径（switch 必填）' },
      },
      required: ['action'],
    },
    async execute({ action, platform, chatId, workspacePath }) {
      if (action === 'list') {
        const rows = state.listIntents();
        return { text: rows.length ? rows.map((r) => `${r.chatKey} → ${r.workspacePath} (${r.mode})`).join('\n') : '（无绑定）' };
      }
      if (action === 'switch') {
        if (!platform || !chatId || !workspacePath) throw new Error('switch 需要 platform/chatId/workspacePath');
        const msg = { platform, chatId, userId: 'agent-tool', chatType: 'private', text: '' };
        const result = await switcher.switchToWorkspace(msg, workspacePath, { mode: 'new' });
        return {
          text: result.ok
            ? `✅ 已切换 ${chatId} → ${result.toWorkspace}（会话 ${result.sessionId}）`
            : `❌ 切换失败：${result.error}`,
        };
      }
      throw new Error(`unknown action: ${action}`);
    },
  };
}

export { NAV_CHANNEL };
export default { name, inject, apply };
