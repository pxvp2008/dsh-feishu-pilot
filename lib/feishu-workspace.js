// lib/feishu-workspace.js —— 飞书创建会话的专用工作区。
// 问题：核心原生创建会话（自动创建 / /new）的 cwd = imCore.agent.workspace
// （配置为空时 = process.cwd()）⇒ GUI 里归入「未分组」。
// 方案（插件侧）：
//   ① 配置面：插件 config.imCore.agent.workspace 指向专用目录
//      （DEFAULT_FEISHU_WS.dir），原生创建会话的 cwd 随之落定；
//   ② 启动面：ensureFeishuWorkspace(ctx) —— mkdir -p + workspaceRegistry
//      幂等注册（create(path, title)：同路径重复调用返回既有实体、不改标题）
//      ⇒ GUI 工作区侧栏出现具名分组「飞书创建的会话」。
// 经 /ws 显式切换的会话不受影响（switcher 用 meta.cwd=ws.path 覆盖）。
// 容错语义：缺服务 / fs 失败 / create 失败 ⇒ 只记日志、永不抛
// （不阻断 boot；最坏退回「未分组」现状，无行为退化）。
// 冻结契约：
//   DEFAULT_FEISHU_WS = { dir, title }   // 可经插件 config.feishuWs 覆盖
//   ensureFeishuWorkspace(ctx, {dir?, title?, log?}): Promise<void>

import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { dshHome } from './identity.js';

/** 默认可移植路径：$DSH_HOME/feishu-sessions（不把本机绝对路径写进包）。 */
export const DEFAULT_FEISHU_WS = Object.freeze({
  dir: '',
  title: '飞书创建的会话',
});

/** 解析飞书专用工作区目录：显式 config.feishuWs.dir 优先，否则用可移植默认。 */
export function resolveFeishuWsDir(feishuWs = {}) {
  const raw = typeof feishuWs?.dir === 'string' ? feishuWs.dir.trim() : '';
  return raw || join(dshHome(), 'feishu-sessions');
}

export async function ensureFeishuWorkspace(ctx, opt = {}) {
  const dir = resolveFeishuWsDir(opt);
  const title = opt.title ?? DEFAULT_FEISHU_WS.title;
  const log = opt.log ?? (() => {});
  try {
    // workspaceRegistry.create 要求目录已存在（reject 非目录/不存在）⇒ 先 mkdir -p
    let isDir = false;
    try { isDir = (await stat(dir)).isDirectory(); } catch { isDir = false; }
    if (!isDir) await mkdir(dir, { recursive: true });
    const reg = ctx?.workspaceRegistry;
    if (typeof reg?.create !== 'function') return; // 注册服务缺席（测试 fake 等）⇒ 静默跳过
    // 只读预检：已注册 ⇒ 直接返回（不触碰 create，避免重复 enqueue）
    if (typeof reg.resolveByPath === 'function') {
      const existing = await reg.resolveByPath(dir);
      if (existing) return;
    }
    await reg.create(dir, title);
    log(`[feishu-pilot] 已注册飞书专用工作区: ${dir}（${title}）`);
  } catch (e) {
    log(`[feishu-pilot] 飞书专用工作区注册失败（不阻断启动，会话将归入「未分组」）: ${e?.message}`);
  }
}
