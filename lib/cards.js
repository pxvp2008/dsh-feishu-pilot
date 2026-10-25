// lib/cards.js —— 出站：API-only lark client + 富卡片构造（选择器卡 / 会话选择器卡 / 结果卡 / 公告卡 / 纯文本降级）。
//
// 凭据解析复用 lib/feishu/credentials.js（env:FEISHU_APP_ID/SECRET → 环境变量 →
// 扫码/手动产物 $DSH_HOME/dsh-feishu-pilot/feishu-credentials.json）。
// 长连接集群模式约束：本模块只建 API-only Client（im.message.create/patch），永不建第二条
// WSClient 事件连接。
//
// 卡片回调 value 约束：渠道适配器只取 value 的 action/id/answer 三字段拼 data = "action:id:answer"
// ⇒ 字段内不得含冒号。按钮 value 一律
// {action:'ws', id:<token>, answer:<pick|retry|nav|next|new|adopt>}。
//
// 契约：
//   createLarkClient(ctx, config): { available, kindFor(chatId),
//     sendCard(chatId, card): Promise<messageId|null>,
//     patchCard(messageId, card): Promise<void> }
//   createCards(ctx, deps): {
//     sendSelectorCard(msg, items, currentChatKey, mode): Promise<null|{messageId}>
//     sendResultCard(msg, result, {retryToken}): Promise<void>
//     sendAnnounceCard(msg, text): Promise<void>
//     sendText(msg, text): Promise<void>
//     patchProcessing(messageId, text): Promise<void>
//   }
//   deps = { state, im, lark }

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { resolveSecret } from './feishu/credentials.js';

/**
 * 加载 lark SDK。junction 插件的直连 import 按真实路径解析 node_modules，找不到
 * profile 的 pnpm 树 ⇒ 富卡片会误降级为纯文本，故有多级回退。
 * 回退链：
 *  1) 直接 import（插件自身依赖就位，正常形态）；
 *  2) createRequire 以 profile node_modules 顶层为基准（hoisted 布局兜底）。
 */
async function loadLarkSdk() {
  try {
    const mod = await import('@larksuiteoapi/node-sdk');
    if (mod && typeof mod.Client === 'function') return mod;
  } catch { /* 落到 2) */ }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const nm = join(home, 'profiles', 'web', 'node_modules');
  for (const base of [join(nm, 'index.js')]) {
    try {
      const req = createRequire(base); // 返回值即 require 函数
      const mod = req('@larksuiteoapi/node-sdk');
      if (mod && typeof mod.Client === 'function') return mod;
    } catch { /* 尝试下一个基准 */ }
  }
  throw new Error('@larksuiteoapi/node-sdk 不可见（直连 import 与 profile 邻居解析均失败）');
}

/**
 * API-only lark client（无 WSClient）。缺凭据 → {available:false}（降级：
 * 富卡片退回 im.push 纯文本）。
 * @param {any} ctx
 * @param {object} [config] { appId?, appSecret? }  默认 'env:FEISHU_APP_ID'/'env:FEISHU_APP_SECRET'
 * @returns {Promise<{available:boolean, kindFor:(chatId:string)=>string, sendCard:(chatId:string, card:object)=>Promise<string|null>, patchCard:(messageId:string, card:object)=>Promise<void>}>}
 */
export async function createLarkClient(ctx, config = {}) {
  const log = (...a) => ctx?.logger?.warn?.(...a);
  const appId = resolveSecret(config.appId ?? 'env:FEISHU_APP_ID');
  const appSecret = resolveSecret(config.appSecret ?? 'env:FEISHU_APP_SECRET');
  if (!appId || !appSecret) {
    log('[feishu-pilot] lark client 无凭据（env:FEISHU_APP_ID/SECRET 与扫码产物均缺）—— 富卡片降级为纯文本');
    return { available: false, reason: 'no-credentials', kindFor, sendCard: async () => null, patchCard: async () => {} };
  }
  let client;
  try {
    const lark = await loadLarkSdk();
    client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel?.warn });
  } catch (e) {
    log(`[feishu-pilot] @larksuiteoapi/node-sdk 加载失败，富卡片降级：${e?.message}`);
    return { available: false, reason: 'sdk-unavailable', kindFor, sendCard: async () => null, patchCard: async () => {} };
  }
  return {
    available: true,
    kindFor,
    async sendCard(chatId, card) {
      const r = await client.im.message.create({
        params: { receive_id_type: kindFor(chatId) },
        data: { receive_id: String(chatId), msg_type: 'interactive', content: JSON.stringify(card) },
      });
      return r?.data?.message_id ?? null;
    },
    async patchCard(messageId, card) {
      await client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    },
  };
}

/** receive_id_type 判定（前缀启发，与渠道模块 kindFor 同语义）。 */
export function kindFor(chatId) {
  const s = String(chatId);
  if (s.startsWith('ou_') || s.startsWith('on_') || s.startsWith('oi_')) return 'open_id';
  return 'chat_id';
}

// /ws 选择器每工作区一个按钮（名称 = 列出该工作区的会话）⇒ 每页 10 个工作区；
// 会话选择器 7/页。
const SELECTOR_PAGE_SIZE = 10;
const PICKER_PAGE_SIZE = 7;

function mdEscape(s) {
  return String(s ?? '').replace(/[\n]/g, ' ');
}

/**
 * 契约：createCards(ctx, deps)
 * @param {any} ctx
 * @param {{state:any, im:any, lark:any, feishuWsPath?:string}} deps
 *        feishuWsPath = 飞书专用工作区路径（全局「新建会话」按钮的固定目标）
 */
export function createCards(ctx, deps) {
  const { state, im, lark, feishuWsPath = '' } = deps;
  const log = (...a) => ctx?.logger?.warn?.(...a);

  const plain = async (msg, text) => {
    try {
      await im.push(msg.platform, msg.chatId, { text });
    } catch (e) {
      log(`[feishu-pilot] plain text send failed: ${e?.message}`);
    }
  };

  /**
   * 工作区选择器卡：每工作区一个按钮——点工作区名称 = 列出该工作区的会话（进
   * 会话选择器）；「点名称直接切换/建会话」(pick) 已无 UI 入口（切换改由选择器内
   * 「接管会话 / 新建会话」完成）。
   * 按钮区两段式——工作区按钮组 + 全局操作
   * [‹上一页?/下一页?, 🆕 新建会话（⇒ 飞书专用工作区）, ♻️ 接管最近]。
   * 富卡不放顶部「名称+路径」文字清单（与按钮网格冗余、占版面；降级纯文本路径
   * 保留清单）。分页必须是真实页码：固定渲染第 1 页会让 >10 个工作区永远翻不到。
   * @param {number} [page]  当前页（1 起）；token 携带 page + 相邻页首条目路径。
   */
  async function sendSelectorCard(msg, items, currentChatKey, mode = 'sessions', page = 1) {
    const curBinding = im.map.get(msg.platform, msg.chatId);
    const curIntent = state.getIntent(msg.platform, msg.chatId);
    const rows = items.map((w) => {
      const isCurrent = (curBinding && w.sessionIds?.includes(curBinding.sessionId))
        || (curIntent?.workspacePath && w.path === curIntent.workspacePath);
      return { ...w, isCurrent };
    });
    // 分页：真实页码（越界收敛到末页）
    const totalPages = Math.max(1, Math.ceil(rows.length / SELECTOR_PAGE_SIZE));
    const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), totalPages);
    const pageItems = rows.slice((p - 1) * SELECTOR_PAGE_SIZE, p * SELECTOR_PAGE_SIZE);
    const listText = rows.map((w) => `${w.isCurrent ? '✅' : '　'} ${w.title}  \`${w.path}\``).join('\n');
    if (!lark.available) {
      // 降级：纯文本清单（点选不可用，提示用 /new 或桌面操作）；原因如实区分
      const why = lark.reason === 'no-credentials'
        ? 'lark 凭据缺失——在「设置→飞书」扫码绑定或手动填写 App ID/Secret，重启后生效'
        : `lark SDK 不可用（${lark.reason ?? 'unknown'}）——插件安装/依赖问题，见 DSH 日志`;
      await plain(msg, `🗂 工作区列表：\n${listText}\n（富卡片不可用：${why}；可重启应用后重试，或使用桌面 GUI 切换）`);
      return null;
    }
    const elements = [];
    // 每工作区一个按钮——名称点击 = 列出该工作区会话（进会话选择器）；
    // 「点击直接切换/建会话」(pick) 已无 UI 入口。
    // 工作区名完整显示，不截断加「…」
    // （16 字符截断让 llama-monitor-ds… 一类名称不可辨认）。
    const perPage = [];
    for (const w of pageItems) {
      perPage.push({
        tag: 'button',
        text: { tag: 'plain_text', content: w.isCurrent ? `${w.title}（当前）` : w.title },
        type: 'default',
        value: { action: 'ws', id: state.issueToken({ userId: msg.userId, workspacePath: w.path, mode: 'sessions', page: 1 }), answer: 'sessions' },
      });
    }
    elements.push({ tag: 'action', actions: perPage });
    const tail = [];
    if (p > 1) {
      tail.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '‹ 上一页' },
        type: 'default',
        value: { action: 'ws', id: state.issueToken({ userId: msg.userId, workspacePath: rows[(p - 2) * SELECTOR_PAGE_SIZE]?.path ?? '', mode, page: p - 1 }), answer: 'prev' },
      });
    }
    if (p < totalPages) {
      tail.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '下一页 ›' },
        type: 'primary',
        value: { action: 'ws', id: state.issueToken({ userId: msg.userId, workspacePath: rows[p * SELECTOR_PAGE_SIZE]?.path ?? '', mode, page: p + 1 }), answer: 'next' },
      });
    }
    tail.push({
      tag: 'button',
      // 「新建会话」：新会话固定
      // 归属飞书专用工作区（「飞书创建的会话」），不跟随意图工作区。
      text: { tag: 'plain_text', content: '🆕 新建会话' },
      type: 'default',
      value: { action: 'ws', id: state.issueToken({ userId: msg.userId, workspacePath: feishuWsPath, mode: 'new', page: 1 }), answer: 'new' },
    });
    tail.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '♻️ 接管最近会话' },
      type: 'default',
      value: { action: 'ws', id: state.issueToken({ userId: msg.userId, workspacePath: curIntent?.workspacePath ?? (items[0]?.path ?? ''), mode: 'adopt', page: 1 }), answer: 'adopt' },
    });
    elements.push({ tag: 'action', actions: tail });
    const pageLabel = totalPages > 1 ? `（${p}/${totalPages} 页）` : '';
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `🗂 选择工作区${pageLabel}` }, template: 'blue' },
      elements,
    };
    const messageId = await lark.sendCard(msg.chatId, card);
    return { messageId };
  }

  /**
   * 会话选择器卡（「接管指定会话」）：全量会话清单（含从未 attach 的
   * 原生历史会话）7/页，每行一个「接管」按钮（token 携带 sessionId+workspacePath，
   * mode=adopt-id ⇒ commands 路由到 switcher adopt-id 分支）。
   * 作用域视图另有「🆕 新建会话」按钮（mode=new、
   * workspacePath=scope ⇒ 在当前工作区新建会话并切换）。
   * @param {object} msg
   * @param {Array<{sessionId,title,wsTitle,wsPath,createdAt,live,busy}>} rows  已按新→旧排序
   * @param {number} skipped  不在工作区分组中的会话数（只作提示，不可接管；
   *                          未注册/空白会话，与 GUI 侧栏一致）
   * @param {string} currentChatKey
   * @param {number} [page]
   */
  // scope = {path, title}（「🔎 <工作区> 会话」进入时给定）⇒
  // 标题带工作区名 + 翻页 token 携带 workspacePath 保域；null = 全量视图。
  async function sendSessionPickerCard(msg, rows, skipped = 0, currentChatKey, page = 1, scope = null) {
    const safePage = Math.max(1, Math.floor(Number(page) || 1));
    const scopePath = scope?.path ? String(scope.path) : '';
    const totalPages = Math.max(1, Math.ceil(rows.length / PICKER_PAGE_SIZE));
    const pageRows = rows.slice((safePage - 1) * PICKER_PAGE_SIZE, safePage * PICKER_PAGE_SIZE);
    const fmtDate = (t) => {
      if (!t) return '';
      const d = new Date(t);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    // 会话名完整显示，不截断加「…」（与 /ws 选择器同款处理）。
    const listText = pageRows.map((r) =>
      `${r.live ? (r.busy ? '🔴' : '🟢') : '⚪'} ${r.title}（${r.wsTitle}）${r.createdAt ? ` · ${fmtDate(r.createdAt)}` : ''}`
    ).join('\n');
    // 富卡不放「标题+时间」文字清单（与接管按钮网格冗余，
    // /ws 选择器同款处理）——listText 仅供降级纯文本路径使用；空态保留提示。
    const elements = [];
    if (pageRows.length === 0) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: scope?.title ? '（该工作区下没有可接管的历史会话）' : '（没有可接管的历史会话）' } });
    }
    if (skipped > 0) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `另有 ${skipped} 个会话不在工作区分组中（与 GUI 侧栏一致），不列出。` } });
    }
    // 存活徽标 🟢🔴⚪ 随清单删除而移入按钮文本（信息不丢）
    const badge = (r) => (r.live ? (r.busy ? '🔴' : '🟢') : '⚪');
    const actions = pageRows.map((r) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: `接管 ${badge(r)} ${r.title}` },
      type: 'default',
      value: {
        action: 'ws',
        id: state.issueToken({ userId: msg.userId, workspacePath: r.wsPath, sessionId: r.sessionId, mode: 'adopt-id', page: safePage }),
        answer: 'adoptsess',
      },
    }));
    if (rows.length > 0) {
      // 翻页 token 携带 workspacePath：作用域视图翻页后仍停在同一工作区
      const navToken = (p) => state.issueToken({ userId: msg.userId, workspacePath: scopePath, mode: 'sessions', page: p });
      if (safePage > 1) {
        actions.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '‹ 上一页' },
          type: 'default',
          value: { action: 'ws', id: navToken(safePage - 1), answer: 'pprev' },
        });
      }
      if (safePage * PICKER_PAGE_SIZE < rows.length) {
        actions.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '下一页 ›' },
          type: 'primary',
          value: { action: 'ws', id: navToken(safePage + 1), answer: 'pnext' },
        });
      }
    }
    // 作用域视图加「新建会话」——在当前工作区新建会话
    // 并切换（token workspacePath = scope；全量视图无归属工作区，不加）。
    if (scopePath) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '🆕 新建会话' },
        type: 'default',
        value: { action: 'ws', id: state.issueToken({ userId: msg.userId, workspacePath: scopePath, mode: 'new', page: safePage }), answer: 'new' },
      });
    }
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '返回工作区列表' },
      type: 'default',
      value: { action: 'ws', id: state.issueToken({ userId: msg.userId, mode: 'wslist' }), answer: 'back' },
    });
    // 底部行红框区域显示当前页/总页数。飞书 action 行
    // 只能放按钮 ⇒ 页码做成按钮，按压重发当前页（无害刷新）。单页不显示。
    if (totalPages > 1) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: `${safePage}/${totalPages} 页` },
        type: 'default',
        value: { action: 'ws', id: state.issueToken({ userId: msg.userId, workspacePath: scopePath, mode: 'sessions', page: safePage }), answer: 'pinfo' },
      });
    }
    elements.push({ tag: 'action', actions });
    const scopeLabel = scope?.title ? `（${scope.title}）` : '';
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `🗂 选择要接管的会话${scopeLabel}（${rows.length}）` }, template: 'purple' },
      elements,
    };
    if (!lark.available) {
      await plain(msg,
        `🗂 可接管的会话${scopeLabel}（共 ${rows.length}，第 ${safePage} 页）：\n${listText || '（无）'}\n${skipped > 0 ? `另有 ${skipped} 个会话不在工作区分组中。\n` : ''}（富卡片不可用：无法点选接管；可重启应用后重试，或在桌面 GUI 打开会话）`);
      return null;
    }
    const messageId = await lark.sendCard(msg.chatId, card);
    return { messageId };
  }

  /**
   * 切换结果卡：成功 = 从 X 到 Y + 会话 + 耗时（retry 按钮保留可重入）；
   * 失败 = 原因（自检失败 → upgradeHint 升级提示）。
   */
  async function sendResultCard(msg, result, { retryToken = null } = {}) {
    if (result.ok) {
      const lines = [];
      lines.push(`✅ 已切换到工作区 **${result.toTitle ?? result.toWorkspace}**`);
      // 显示会话**名称**（哪个工作区的哪个会话），
      // 不显示裸 sessionId；名称缺失时（switcher 未解析到）才回退 id。
      if (result.already) {
        if (result.sessionName) lines.push(`当前会话：「${result.sessionName}」`);
        lines.push(result.alreadyNote ?? '（该聊天已在目标工作区，未做改动）');
      } else if (result.sessionName) {
        lines.push(`会话：「${result.sessionName}」`);
      } else {
        lines.push(`会话：\`${result.sessionId}\``);
      }
      lines.push(`耗时：${(result.elapsedMs / 1000).toFixed(1)}s`);
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: result.already ? 'ℹ️ 已在该工作区' : '✅ 切换完成' }, template: result.already ? 'grey' : 'green' },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }],
      };
      if (lark.available) {
        try {
          await lark.sendCard(msg.chatId, card);
          return;
        } catch (e) {
          log(`[feishu-pilot] result card failed, falling back to text: ${e?.message}`);
        }
      }
      await plain(msg, lines.join('\n'));
      return;
    }
    const lines = [`❌ 切换失败：${result.error ?? '未知错误'}`];
    if (result.toWorkspace) lines.push(`目标：${result.toWorkspace}`);
    if (result.upgradeHint) lines.push('⚠️ 这是核心 SessionMap 结构变更信号：请升级插件到兼容版本，不要重试。');
    if (lark.available) {
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '❌ 切换失败' }, template: 'red' },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
          ...(retryToken
            ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🔁 重试' }, type: 'default', value: { action: 'ws', id: retryToken, answer: 'retry' } }] }]
            : []),
        ],
      };
      try {
        await lark.sendCard(msg.chatId, card);
        return;
      } catch (e) {
        log(`[feishu-pilot] failure card failed, falling back to text: ${e?.message}`);
      }
    }
    await plain(msg, lines.join('\n'));
  }

  /** 修复公告卡（避免静默建会话）。 */
  async function sendAnnounceCard(msg, text) {
    if (lark.available) {
      try {
        await lark.sendCard(msg.chatId, {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '🔧 自动修复' }, template: 'orange' },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: mdEscape(text) } }],
        });
        return;
      } catch (e) {
        log(`[feishu-pilot] announce card failed, falling back to text: ${e?.message}`);
      }
    }
    await plain(msg, mdEscape(text));
  }

  /** 纯文本发送（降级/兜底通道，走核心渠道路由）。 */
  async function sendText(msg, text) {
    await plain(msg, text);
  }

  /** 快速 ack「处理中」（3s 回调预算）：优先 patch 原卡片，缺 messageId 时发新文本。 */
  async function patchProcessing(messageId, text) {
    if (lark.available && messageId) {
      try {
        await lark.patchCard(messageId, {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '⏳ 处理中' }, template: 'blue' },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: mdEscape(text) } }],
        });
        return;
      } catch (e) {
        log(`[feishu-pilot] patch failed, falling back to new text: ${e?.message}`);
      }
    }
    // 无 messageId 的降级路径由调用方决定（sendText）
  }

  return { sendSelectorCard, sendSessionPickerCard, sendResultCard, sendAnnounceCard, sendText, patchProcessing };
}

export { SELECTOR_PAGE_SIZE, PICKER_PAGE_SIZE };
