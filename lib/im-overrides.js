// lib/im-overrides.js —— UI 管理的核心运行期覆盖。
// `security.autoCreate` 本是核心的启动期配置（config.imCore）；核心的
// dispatchTask 每条消息都现读 `this.cfg.security` ⇒ 翻转 cfg 对象字段即**立即生效**，
// 故 UI 开关只需改 cfg 并持久化到本插件状态目录：
//   $DSH_HOME/dsh-feishu-pilot/im-overrides.json
//   { "autoCreate": true|false, "updatedAt": "..." }
// 优先级：本文件 > 插件配置 imCore 块（wire 时应用到核心的 cfg；
// 文件缺失 ⇒ 配置文件值原样生效）。写入走 tmp+rename 原子写。
// 冻结契约：
//   overridesPath(stateDir): string
//   loadOverrides(stateDir): Promise<object|null>
//   saveOverride(stateDir, patch): Promise<object>
//   applyOverrides(im, ovr): object   // 返回实际应用到的字段

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const IM_OVERRIDES_FILE = 'im-overrides.json';

function overridesPath(stateDir) {
  return join(stateDir, IM_OVERRIDES_FILE);
}

/** 读覆盖文件；缺失/损坏 ⇒ null（不阻断启动）。 */
export async function loadOverrides(stateDir) {
  try {
    const data = JSON.parse(await readFile(overridesPath(stateDir), 'utf8'));
    return (data && typeof data === 'object') ? data : null;
  } catch {
    return null;
  }
}

/** 合并 patch 原子写回；返回写后的完整对象。 */
export async function saveOverride(stateDir, patch) {
  const p = overridesPath(stateDir);
  let cur = {};
  try {
    cur = JSON.parse(await readFile(p, 'utf8'));
    if (!cur || typeof cur !== 'object') cur = {};
  } catch { /* 从零开始 */ }
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, p);
  return next;
}

/**
 * 把覆盖应用到核心实例的 cfg（live ⇒ 下一条消息生效）。
 * @param {any} im   核心 FeishuImCore（有 .cfg.security）或代理
 * @param {object|null} ovr  loadOverrides 的结果
 * @returns {object} 实际应用到的字段（空对象 = 无覆盖）
 */
export function applyOverrides(im, ovr) {
  const applied = {};
  const sec = im?.cfg?.security;
  if (!sec || typeof sec !== 'object') return applied;
  if (ovr && typeof ovr.autoCreate === 'boolean') {
    sec.autoCreate = ovr.autoCreate;
    applied.autoCreate = ovr.autoCreate;
  }
  if (ovr && typeof ovr.groupMentionRequired === 'boolean') {
    sec.groupMentionRequired = ovr.groupMentionRequired;
    applied.groupMentionRequired = ovr.groupMentionRequired;
  }
  return applied;
}
