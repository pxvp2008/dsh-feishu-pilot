// lib/feishu/provision.js —— 扫码接入（官方 registerApp 设备授权）+ 凭据落盘（0.9.0 去依赖重构）。
//
// 合并两种入口形态（Web 状态机 + 一次性 CLI 流程）：
// 同一套预填项（PROVISION_ADDONS）、同一套凭据写入（writeCredentials，0600）、
// 同一条 registerApp 调用方式，两个入口共用。
//
// 状态机契约（Web 设置页签 ⇄ Host 轮询）：
//   begin() 发射后永不 reject——内部 catch 一切，异常写进 phase:'error'。
//   二维码只经 onQRCodeReady 回调写入 state，由 poll() 带出；HTTP 侧必须
//   `void session.begin()`（await 会把响应阻塞到扫码完成 ⇒ 三方互等，UI 永卡「申请中…」）。
//   终态（succeeded/error/expired/cancelled）一旦写入不再被回调覆盖；取消经 AbortController
//   中断 registerApp 轮询。
//
// 凭据只写 Host 本机文件 $DSH_HOME/dsh-feishu-pilot/feishu-credentials.json（0600）；
// 对外状态一律经 redactProvisioning 打码，App Secret 不进浏览器。不依赖 cordis。

import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { redactProvisioning } from './credentials.js';
import { CREDENTIALS_REL, dshHome } from '../identity.js';

/** 扫码建应用的预填项：与全功能所需的权限/事件/回调集。 */
export const PROVISION_ADDONS = Object.freeze({
  preset: false,
  scopes: {
    tenant: [
      'im:message:send_as_bot', // 发消息/卡片
      'im:message.p2p_msg:readonly', // 私聊接收
      'im:message.group_at_msg:readonly', // 群聊 @ 接收
      'im:message:readonly', // 下载消息图片资源
      'im:resource', // 上传文件（/output 发文件）
      'application:application:self_manage', // 查询本应用权限（判断 group_msg 是否开通）
      // 斜杠命令面板：read=读取已注册命令，write=创建/更新/下线命令
      'application:app_slash_command:read',
      'application:app_slash_command:write',
    ],
  },
  events: {
    items: {
      tenant: ['im.message.receive_v1'],
    },
  },
  callbacks: {
    items: ['card.action.trigger'],
  },
});

/** 应用预填名称/描述（{user} 由飞书侧替换为扫码人）。 */
export const PROVISION_APP_PRESET = Object.freeze({
  name: 'DSH 智能体（{user}）',
  desc: 'DeepSeek Harness 飞书远控：远程派活 / 结果通知 / 危险操作审批（dsh-feishu-pilot）',
});

/** 轮询可见的终态。 */
const TERMINAL_PHASES = new Set(['succeeded', 'error', 'expired', 'cancelled']);

/** 官方 SDK（只用 registerApp）；动态加载 ⇒ 本模块缺席 SDK 时只降级不炸。 */
async function loadLarkSdk() {
  try {
    return await import('@larksuiteoapi/node-sdk');
  } catch {
    return null;
  }
}

/** qrcode 是可选依赖：缺席时只回传原始 URL（state.qrUrl），由前端自行渲染。 */
async function loadQrLib() {
  try {
    const mod = await import('qrcode');
    const lib = mod?.default ?? mod;
    return typeof lib?.toDataURL === 'function' ? lib : null;
  } catch {
    return null;
  }
}

/** 二维码 URL → data URL（浏览器 <img> 直接显示，不走外部服务）；qrcode 缺席 ⇒ null。 */
export async function encodeQrDataUrl(url, { width = 280, margin = 1 } = {}) {
  const QRCode = await loadQrLib();
  if (!QRCode) return null;
  return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin, width, type: 'image/png' });
}

/**
 * 写凭据文件（扫码/手动配置同一落盘形态）：目录自动创建，权限 0600。
 * @param {{home?:string, appId:string, appSecret:string, source?:string, file?:string,
 *          write?:Function, mkdirFn?:Function}} opts
 * @returns {Promise<string>} 实际写入路径
 */
export async function writeCredentials({
  home,
  appId,
  appSecret,
  source = 'scan',
  file,
  write = writeFile,
  mkdirFn = mkdir,
} = {}) {
  const target = file ?? join(home ?? dshHome(), CREDENTIALS_REL);
  await mkdirFn(dirname(target), { recursive: true });
  await write(target, JSON.stringify({
    appId,
    appSecret,
    source,
    updatedAt: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600 });
  return target;
}

/**
 * 一次扫码会话（Web 设置页签轮询用）。
 * @param {{home?:string, log?:Function, sdk?:{registerApp:Function},
 *          write?:Function, mkdirFn?:Function, encodeQr?:Function}} [opts]
 * @returns {{begin:()=>Promise<void>, poll:()=>object, cancel:()=>void, state:object, getState:()=>object}}
 */
export function createFeishuProvisionSession({
  home,
  log,
  sdk,
  write = writeFile,
  mkdirFn = mkdir,
  encodeQr = encodeQrDataUrl,
} = {}) {
  const base = home ?? dshHome();
  const credFile = join(base, CREDENTIALS_REL);
  const say = typeof log === 'function' ? log : () => {};

  let state = { phase: 'idle' };
  let controller = null;

  /** 对外快照一律脱敏（secret 类字段打码）。 */
  const snapshot = () => redactProvisioning(state);

  async function begin() {
    try {
      const lark = sdk ?? (await loadLarkSdk());
      if (typeof lark?.registerApp !== 'function') {
        state = { phase: 'error', message: 'registerApp unavailable — @larksuiteoapi/node-sdk 不可用' };
        say(`❌ ${state.message}`);
        return;
      }
      controller?.abort(); // 同一会话重复 begin：先中断上一轮轮询
      controller = new AbortController();
      state = { phase: 'starting' };

      /** 回调可能先于结果/错误完成；await 前后都要查终态与取消。 */
      const live = () => !controller.signal.aborted && !TERMINAL_PHASES.has(state.phase);

      const result = await lark.registerApp({
        appPreset: { ...PROVISION_APP_PRESET },
        addons: PROVISION_ADDONS,
        onQRCodeReady: async ({ url, expireIn } = {}) => {
          if (!live()) return;
          const qrDataUrl = await encodeQr(url);
          if (!live()) return;
          state = { ...state, phase: 'qr', qrUrl: url, qrDataUrl, expiresIn: expireIn };
        },
        onStatusChange: ({ status, interval } = {}) => {
          if (!live()) return;
          state = {
            ...state,
            pollMessage: status === 'slow_down'
              ? `轮询限速（${interval}s）| throttled`
              : String(status ?? ''),
          };
        },
        signal: controller.signal,
      });

      const appId = result?.client_id;
      const appSecret = result?.client_secret;
      if (typeof appId !== 'string' || !appId || typeof appSecret !== 'string' || !appSecret) {
        state = { phase: 'error', message: '扫码注册未返回有效凭据（client_id/client_secret）| registration returned no credentials' };
        say(`❌ ${state.message}`);
        return;
      }
      await writeCredentials({ home: base, appId, appSecret, source: 'scan', write, mkdirFn });
      state = { phase: 'succeeded', appId };
      say(`✅ 凭据已安全写入 ${credFile}（仅本机可读）`);
    } catch (err) {
      // begin 永不 reject：异常只写进状态，由 poll 带出（发射后调用的安全前提）
      if (controller?.signal.aborted) {
        state = { phase: 'cancelled' };
        return;
      }
      state = { phase: 'error', message: err?.message ?? String(err) };
      say(`❌ 扫码接入失败 | provisioning failed: ${state.message}`);
    }
  }

  function cancel() {
    controller?.abort();
    state = { phase: 'cancelled' };
  }

  return {
    begin,
    poll: snapshot,
    cancel,
    get state() {
      return snapshot();
    },
    getState: snapshot, // 历史兼容别名（旧 web-rpc 侧调用形态）
  };
}

/**
 * 一次性扫码流程（CLI 形态）：跑完 registerApp 并直接落盘凭据。
 * @param {{home?:string, log?:Function, sdk?:{registerApp:Function}, renderQr?:Function,
 *          write?:Function, mkdirFn?:Function, signal?:AbortSignal}} opts
 * @returns {Promise<{appId:string, appSecret:string, credFile:string, userInfo:object}>}
 */
export async function runFeishuQrSetup({
  home,
  log = console.log,
  sdk,
  renderQr = () => {},
  write = writeFile,
  mkdirFn = mkdir,
  signal,
} = {}) {
  const lark = sdk ?? (await loadLarkSdk());
  if (typeof lark?.registerApp !== 'function') {
    throw new TypeError('runFeishuQrSetup requires registerApp（官方 @larksuiteoapi/node-sdk）');
  }
  const base = home ?? dshHome();
  log('🔗 正在向飞书开放平台申请二维码… | requesting QR code from Feishu Open Platform');
  const result = await lark.registerApp({
    appPreset: { ...PROVISION_APP_PRESET },
    addons: PROVISION_ADDONS,
    onQRCodeReady: ({ url, expireIn }) => {
      log(`📱 请用飞书扫码（${Math.round((expireIn ?? 0) / 60)} 分钟内有效）：| scan with Feishu`);
      renderQr(url);
      log(`   打不开二维码？直接访问：${url}`);
    },
    onStatusChange: ({ status, interval }) => {
      if (status === 'slow_down') log(`⏳ 轮询被限速（${interval}s），继续等待… | polling throttled`);
      else log(`⏳ 状态：${status}`);
    },
    signal,
  });
  const appId = result?.client_id;
  const appSecret = result?.client_secret;
  if (typeof appId !== 'string' || !appId || typeof appSecret !== 'string' || !appSecret) {
    throw new Error('扫码注册未返回有效凭据（client_id/client_secret）| registration returned no credentials');
  }
  const credFile = await writeCredentials({ home: base, appId, appSecret, source: 'scan', write, mkdirFn });
  log(`✅ 凭据已安全写入 ${credFile}（仅本机可读）`);
  return { appId, appSecret, credFile, userInfo: result.user_info ?? {} };
}
