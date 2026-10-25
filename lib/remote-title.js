// lib/remote-title.js —— 卡片正文里的会话标题显示。
//
// 原则：**不修改 DSH 会话标题**。飞书卡片直接使用与 GUI 相同的标题原文，
// 只做两件纯展示的事：
//   1. 压成单行（去掉换行/连续空白）；
//   2. 超长时截断（80 字 + `…`），避免卡片被超长标题撑爆。
// 标题为空时才回退定位信息（工作区名 · 会话 id 后 8 位），不改写标题本身。

const MAX_TITLE_CHARS = 80;

/**
 * @param {unknown} raw        titleOf() 的原始返回值（字符串/对象）
 * @param {string} sessionId
 * @param {string} [cwd]       工作区目录名（仅标题为空时用于兜底定位）
 * @returns {string} 可直接拼在「会话 」后面的标题
 */
export function displayTitle(raw, sessionId = '', cwd = '') {
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (raw && typeof raw === 'object' && typeof raw.title === 'string') text = raw.title;
  text = String(text).replace(/\s+/g, ' ').trim();

  if (text) return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS)}…` : text;

  // 只有标题为空时才回退定位信息（不猜测、不覆盖）
  const id = String(sessionId ?? '');
  const idSuffix = id ? id.slice(-8) : '';
  if (cwd) return idSuffix ? `${cwd} · ${idSuffix}` : cwd;
  return idSuffix || '未命名会话';
}
