// lib/commands.js —— 命令/回调编排：
// /ws        → 只读工作区列表 → 选择器卡（issueToken）
// ws:* 回调  → validateToken（userId 绑定）/ consumeToken（用后即焚）→
//              快速 ack（3s 预算）→ 异步 switchToWorkspace → 结果卡
// /new       → 有意图时 switchOrNew（maxSessions 限额），无意图放行原生
//
// 重推幂等：token 是内存态（重启或超时后失效）；pick/adopt/new 成功后置 consumed，
// 重推回调 validate 直接失败（「已被处理」）；retry/nav 保留可重入。
//
// 契约：
//   createCommands(ctx, deps) => {
//     isWsCommand(text): boolean
//     isNewCommand(text): boolean
//     handleWsCommand(msg): Promise<void>
//     handleWsCallback(payload): Promise<void>   // payload = {platform, chatId, userId, data}
//     handleNewCommand(msg): Promise<void>
//   }
//   deps = { state, im, switcher, cards, nav }

import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { collectAdoptableSessions } from './session-picker.js';

const WS_CMD = /^\/ws\b/;
const NEW_CMD = /^\/new\b/;

/** 服务安全访问（cordis 裸属性未声明会 throw ⇒ 只走 ctx.get()，失败 undefined）。 */
function safeSvc(ctx_, name) {
  try {
    if (ctx_ && typeof ctx_.get === 'function') return ctx_.get(name);
  } catch { /* 未注册/无权限 */ }
  return undefined;
}

/**
 * /ws 工作区清单：已注册工作区 ∪ 会话语料推导的工作区。
 * 语料 = sessionQuery.listSessions()（live + 落盘全量）去重 cwd，过滤目录
 * 仍存在的，未注册的以目录名为标题（切换时由 switcher 步骤 -1 幂等注册）。
 * sessionQuery 缺席 ⇒ 只返回注册表（旧行为，不报错）。
 * @returns {Promise<Array<{path:string,title:string,sessionIds:string[]}>>}
 */
export async function listAllWorkspaces(ctx_) {
  const reg = (ctx_.workspaceRegistry?.list?.() ?? []).map((w) => ({
    path: w.path, title: w.title, sessionIds: w.sessionIds ?? [],
  }));
  const known = new Set(reg.map((w) => w.path));
  for (const w of reg) {
    try { known.add(await realpath(w.path)); } catch { /* 原路径已入 */ }
  }
  const out = [...reg];
  // 用户主目录不是合法工作区——早期会话回退
  // cwd=process.cwd()=home 会推出「<your-user>」这类目录名条目 ⇒ 推导时跳过。
  let homeReal = '';
  try { homeReal = await realpath(homedir()); } catch { homeReal = ''; }
  const query = safeSvc(ctx_, 'sessionQuery');
  if (!query?.listSessions) return out;
  let records = [];
  try { records = await query.listSessions(); } catch { return out; }
  const seenDerived = new Set();
  for (const r of records ?? []) {
    const cwd = r?.header?.cwd;
    if (typeof cwd !== 'string' || cwd === '') continue;
    if (known.has(cwd)) continue;
    let rp = cwd;
    try { rp = await realpath(cwd); } catch { continue; } // 目录不存在 ⇒ 跳过
    if (known.has(rp)) continue;
    if (homeReal && rp === homeReal) continue; // 用户主目录 ⇒ 不当工作区列出
    if (seenDerived.has(rp)) continue;
    let isDir = false;
    try { isDir = (await stat(cwd)).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue;
    seenDerived.add(rp);
    known.add(rp);
    out.push({ path: cwd, title: cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd, sessionIds: [] });
  }
  return out;
}

/** @param {any} ctx @param {{state:any, im:any, switcher:any, cards:any, nav:any, feishuWsPath?:string}} deps */
export function createCommands(ctx, deps) {
  const { state, im, switcher, cards, nav, feishuWsPath = '' } = deps;
  const log = (...a) => ctx?.logger?.warn?.(...a);

  function isWsCommand(text) {
    return typeof text === 'string' && WS_CMD.test(text.trim());
  }

  function isNewCommand(text) {
    return typeof text === 'string' && NEW_CMD.test(text.trim());
  }

  /**
   * 打开会话选择器（工作区作用域）：token 携带 workspacePath ⇒
   * 只列该工作区下的会话（两段式：先选工作区再选会话）；未携带 ⇒ 全量视图。
   * @returns {Promise<{rows:Array, skipped:number, scope:{path,title}|null}>}
   */
  async function openSessionPicker(ctx, hit) {
    const scopePath = hit.workspacePath ? String(hit.workspacePath) : '';
    if (!scopePath) {
      const r = await collectAdoptableSessions(ctx);
      return { ...r, scope: null };
    }
    const r = await collectAdoptableSessions(ctx, scopePath);
    const ws = (ctx.workspaceRegistry?.list?.() ?? []).find((w) => w?.path === scopePath);
    return { ...r, scope: ws ? { path: ws.path, title: ws.title } : { path: scopePath, title: scopePath.split(/[\\/]/).filter(Boolean).pop() ?? scopePath } };
  }

  /** /ws：只读列表 → 选择器卡（第 1 页）。调用方须已过 isAllowed + dedupe 闸门。 */
  async function handleWsCommand(msg) {
    try {
      const wsItems = await listAllWorkspaces(ctx);
      await cards.sendSelectorCard(msg, wsItems, `${msg.platform}:${msg.chatId}`, 'sessions', 1);
    } catch (e) {
      log(`[feishu-pilot] /ws failed: ${e?.message}`);
      await cards.sendText(msg, `❌ /ws 失败：${e?.message ?? e}`);
    }
  }

  /**
   * ws:* 回调。data 形如 "ws:<token>:<answer>"（适配器拼接，字段内无冒号）。
   * @param {{platform:string, chatId:string, userId:string, userName?:string, data:string}} payload
   */
  async function handleWsCallback(payload) {
    const { platform, chatId, userId, data } = payload;
    const parts = String(data ?? '').split(':');
    const token = parts[1] ?? '';
    const answer = parts.slice(2).join(':') || 'sessions'; // 缺省回退 = 列表（pick 已无 UI 入口）

    const hit = state.validateToken(token, { userId });
    if (!hit) {
      await cards.sendText({ platform, chatId }, '⛔ 链接已过期或不属于你（卡片 token 内存态，重启/10 分钟后失效）——请重新发送 /ws。');
      return;
    }
    const msg = { platform, chatId, userId };

    try {
      switch (answer) {
        case 'new': {
          // 「新建会话」——目标工作区取 token：
          //   /ws 卡全局按钮 ⇒ 飞书专用工作区（卡片面写死，固定归属「飞书创建的会话」）；
          //   会话选择器按钮 ⇒ 当前作用域工作区（在该工作区新建会话）。
          // token 无 workspacePath（旧卡/翻页残留）⇒ 兜底飞书专用工作区。
          const target = hit.workspacePath || feishuWsPath;
          if (!target) {
            await cards.sendText(msg, 'ℹ️ 无法确定新建会话的目标工作区，请重新 /ws。');
            return;
          }
          state.consumeToken(token);
          await state.withQueue(`${platform}:${chatId}`, async () => {
            await cards.sendText(msg, `⏳ 正在「${target}」新建会话…`);
            const result = await switcher.switchToWorkspace(msg, target, { mode: 'new', retryToken: token });
            if (!result.ok && !result.already) {
              await cards.sendResultCard(msg, { ...result, error: result.error }, { retryToken: token });
            } else if (result.already) {
              await cards.sendResultCard(msg, result, {}); // already 亦须收尾发卡
            }
          });
          return;
        }
        case 'adopt': {
          const target = hit.workspacePath;
          if (!target) {
            await cards.sendText(msg, 'ℹ️ 该按钮未绑定工作区（可能已翻页），请重新 /ws。');
            return;
          }
          // 成功后用后即焚（重推幂等）；重试保留可重入（retry 分支不 consume）
          state.consumeToken(token);
          await state.withQueue(`${platform}:${chatId}`, async () => {
            await cards.sendText(msg, `⏳ 正在切换到「${target}」（${hit.mode === 'adopt' ? '接管最近会话' : '新建会话'}）…`);
            const result = await switcher.switchToWorkspace(msg, target, { mode: hit.mode, retryToken: token });
            if (!result.ok && !result.already) {
              await cards.sendResultCard(msg, { ...result, error: result.error }, { retryToken: token });
            } else if (result.already) {
              // already（幂等短路）路径必须发卡收尾：switcher 提前返回时不发卡，
              // 此处条件若再跳过，用户永远停在 ⏳ 消息 ⇒ 一律以灰色确认卡收尾。
              await cards.sendResultCard(msg, result, {});
            }
            // 正常成功时结果卡已由 switchToWorkspace 发出
          });
          return;
        }
        case 'retry': {
          const target = hit.workspacePath;
          if (!target) return;
          await state.withQueue(`${platform}:${chatId}`, async () => {
            await cards.sendText(msg, '⏳ 正在重试切换…');
            const result = await switcher.switchToWorkspace(msg, target, { mode: hit.mode, retryToken: token });
            if (!result.ok && !result.already) {
              await cards.sendResultCard(msg, result, { retryToken: token });
            } else if (result.already) {
              await cards.sendResultCard(msg, result, {}); // already 亦须收尾发卡
            }
          });
          return;
        }
        case 'nav': {
          const binding = im.map.get(platform, chatId);
          if (!binding) {
            await cards.sendText(msg, 'ℹ️ 当前聊天没有绑定会话，无法导航。');
            return;
          }
          nav?.enqueueNav?.({
            seq: state.nextSeq(),
            platform,
            chatId,
            workspacePath: hit.workspacePath || binding.sessionId,
            sessionId: binding.sessionId,
            title: hit.workspacePath || '',
          });
          await cards.sendText(msg, '🧭 已重新推送桌面导航命令（若桌面 GUI 开着应秒级打开该会话）。');
          return;
        }
        case 'next':
        case 'prev': {
          // 真分页：按 token 页码 ±1 重发对应页（固定重发第 1 页 ⇒ 后面的工作区永远翻不到）
          const base = Math.max(1, Number(hit.page ?? 1));
          const page = Math.max(1, base + (answer === 'next' ? 1 : -1));
          const items = await listAllWorkspaces(ctx);
          await cards.sendSelectorCard(msg, items, `${platform}:${chatId}`, hit.mode, page);
          return;
        }
        // ── 接管指定会话（工作区作用域）：
        //    「🔎 <工作区> 会话」按钮 ⇒ token 携带 workspacePath ⇒ 只列该工作区 ──
        case 'sessions': {
          // 打开会话选择器（第 1 页）；不 consume（可反复打开）
          const { rows, skipped, scope } = await openSessionPicker(ctx, hit);
          await cards.sendSessionPickerCard(msg, rows, skipped, `${platform}:${chatId}`, 1, scope);
          return;
        }
        case 'adoptsess': {
          const target = hit.workspacePath;
          const sid = hit.sessionId;
          if (!target || !sid) {
            await cards.sendText(msg, 'ℹ️ 该按钮未绑定会话（可能已翻页），请重新 /ws。');
            return;
          }
          // 成功后用后即焚（重推幂等，同 pick/adopt）
          state.consumeToken(token);
          await state.withQueue(`${platform}:${chatId}`, async () => {
            await cards.sendText(msg, `⏳ 正在接管会话（${sid.slice(0, 12)}…）…`);
            const result = await switcher.switchToWorkspace(msg, target, { mode: 'adopt-id', sessionId: sid, retryToken: token });
            if (!result.ok && !result.already) {
              await cards.sendResultCard(msg, { ...result, error: result.error }, { retryToken: token });
            } else if (result.already) {
              await cards.sendResultCard(msg, result, {}); // already 亦须收尾发卡（统一）
            }
            // 正常成功时结果卡已由 switchToWorkspace 发出
          });
          return;
        }
        case 'pnext':
        case 'pprev': {
          // 会话选择器翻页（token 重新签发；workspacePath 保域）
          const page = Math.max(1, Number(hit.page ?? 1) + (answer === 'pnext' ? 1 : -1));
          const { rows, skipped, scope } = await openSessionPicker(ctx, hit);
          await cards.sendSessionPickerCard(msg, rows, skipped, `${platform}:${chatId}`, page, scope);
          return;
        }
        case 'back': {
          // 会话选择器 → 返回工作区列表（第 1 页）
          const items = await listAllWorkspaces(ctx);
          await cards.sendSelectorCard(msg, items, `${platform}:${chatId}`, 'sessions', 1);
          return;
        }
        case 'pinfo': {
          // 页码按钮（纯展示，位于底部行红框区）——按压重发当前页（无害刷新）
          const page = Math.max(1, Number(hit.page ?? 1));
          const { rows, skipped, scope } = await openSessionPicker(ctx, hit);
          await cards.sendSessionPickerCard(msg, rows, skipped, `${platform}:${chatId}`, page, scope);
          return;
        }
        default:
          await cards.sendText(msg, `ℹ️ 未知按钮动作：${answer}`);
      }
    } catch (e) {
      log(`[feishu-pilot] ws callback failed: ${e?.message}`);
      await cards.sendText(msg, `❌ 处理失败：${e?.message ?? e}`).catch(() => {});
    }
  }

  /**
   * /new 重定向入口（有意图才接管；无意图 → 原生 /new 行为由 bridge 放行）。
   * @returns {Promise<{passthrough?:boolean, ok?:boolean, [k:string]:any}>}
   */
  async function handleNewCommand(msg) {
    return switcher.switchOrNew(msg);
  }

  return { isWsCommand, isNewCommand, handleWsCommand, handleWsCallback, handleNewCommand };
}
