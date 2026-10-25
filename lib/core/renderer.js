// lib/core/renderer.js —— 出站文本渲染（插件内部）。
//
// 策略：把 agent 输出的 Markdown 降级为手机友好的纯文本（不渲染表格/图片，
// 代码块保留缩进），超长按段落拆分；完整输出经 /log 以文件形式交付。

/** 单条 IM 消息的安全上限（各平台普遍限制，取保守值）。 */
export const MAX_MESSAGE_CHARS = 3500;

/**
 * Markdown → 纯文本（降级渲染）。
 * - 代码围栏：保留内容，代码块不丢失
 * - 行内代码/粗体/斜体/链接：剥掉标记，链接保留为 "标题 (url)"
 * - 标题：转为 "▍标题"
 * - 表格：逐行合并为 " | " 分隔的文本行
 * - 图片/HTML：丢弃
 */
export function markdownToText(md) {
  if (typeof md !== 'string') return '';
  const lines = md.split(/\r?\n/);
  const out = [];
  let inFence = false;
  for (let raw of lines) {
    const fence = raw.match(/^\s*```+/);
    if (fence) {
      inFence = !inFence;
      out.push('```');
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    let line = raw;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      // 分隔行（| --- | :---: |）无信息，跳过
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      // 两列表格 → "· 键：值"；多列 → "· a · b · c"（避免整行竖线在手机端拥挤）
      out.push(cells.length === 2 ? `· ${cells[0]}：${cells[1]}` : `· ${cells.join(' · ')}`);
      continue;
    }
    line = line.replace(/^(#{1,6})\s+/, '▍ ');
    line = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')           // 图片 → 标题
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')       // 链接 → 标题 (url)
      .replace(/`([^`]+)`/g, '$1')                           // 行内代码
      .replace(/\*\*([^*]+)\*\*/g, '$1')                     // 粗体
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')             // 斜体
      .replace(/(^|[^_])_([^_\n]+)_/g, '$1$2')
      .replace(/~~([^~]+)~~/g, '$1')                         // 删除线
      .replace(/<[^>]+>/g, '');                              // HTML
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 通知卡片摘要：剔除不适合卡片的块（表格、代码围栏）后降级为纯文本，
 * 取**开头**若干行/字符（不取尾部——尾部常是表格或清单，读不出结论）。
 * @param {string} md 原始 assistant 文本（Markdown）
 * @param {{maxChars?:number, maxLines?:number}} [opts]
 * @returns {string} 纯文本摘要（可能以 … 结尾）
 */
export function summarizeMarkdown(md, { maxChars = 400, maxLines = 8 } = {}) {
  if (typeof md !== 'string' || !md.trim()) return '';
  const kept = [];
  let inFence = false;
  let skippedTable = false;
  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*```+/.test(raw)) { inFence = !inFence; continue; } // 代码围栏整块不摘要
    if (inFence) continue;
    if (/^\s*\|.*\|\s*$/.test(raw)) { skippedTable = true; continue; } // 表格整块跳过
    kept.push(raw);
  }
  const text = markdownToText(kept.join('\n'));
  const picked = [];
  let used = 0;
  let truncated = false;
  for (const raw of text.split('\n')) {
    let line = raw.trimEnd();
    if (!line.trim()) continue; // 卡片本身有分隔线，摘要内不留空行
    line = line.replace(/^[-*+]\s+/, '· ');
    const remain = maxChars - used;
    if (picked.length >= maxLines || remain <= 0) { truncated = true; break; }
    if (line.length > remain) {
      picked.push(line.slice(0, Math.max(0, remain - 1)) + '…');
      used = maxChars;
      truncated = true;
      break;
    }
    picked.push(line);
    used += line.length + 1;
  }
  if (picked.length === 0) return '';
  if (skippedTable) picked.push('（表格略）');
  return picked.join('\n') + (truncated ? '\n…' : '');
}

/**
 * 超长单行硬切：优先在空白/中文标点处断开，找不到合理落点则按 maxLen 直切。
 * @param {string} line
 * @param {number} maxLen
 * @returns {string[]} 每段 ≤ maxLen
 */
function hardSplitLine(line, maxLen) {
  const pieces = [];
  let rest = line;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    let cut = maxLen;
    let best = -1;
    for (const ch of ['\n', ' ', '，', '。', '；', '、', '：', '）', ')', ']', '}']) {
      best = Math.max(best, window.lastIndexOf(ch));
    }
    if (best > maxLen * 0.5) cut = best + 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * 按段落拆分长文本：每段 ≤ maxLen，**不设块数上限**（不丢内容）；
 * 单行超长时硬切（避免被飞书按长度拒收）。
 * @param {string} text
 * @param {{maxLen?:number}} [opts]
 * @returns {string[]}
 */
export function splitLongText(text, { maxLen = MAX_MESSAGE_CHARS } = {}) {
  if (typeof text !== 'string' || text === '') return [];
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const para of text.split(/\n{2,}/)) {
    // 段内先按行拆分；超长行硬切
    const lines = [];
    for (const line of para.split('\n')) {
      if (line.length <= maxLen) lines.push(line);
      else lines.push(...hardSplitLine(line, maxLen));
    }
    const block = lines.join('\n');
    const sep = current ? '\n\n' : '';
    if (current.length + sep.length + block.length <= maxLen) {
      current = current ? `${current}\n\n${block}` : block;
      continue;
    }
    if (block.length <= maxLen) {
      flush();
      current = block;
      continue;
    }
    // 整段仍超长（多行堆叠）：逐行装填
    for (const line of lines) {
      const addition = current ? `\n${line}` : line;
      if (current.length + addition.length > maxLen) flush();
      current += current ? `\n${line}` : line;
    }
    flush();
  }
  flush();
  return chunks;
}

/**
 * 组装 turn/end 结果卡片。
 * @param {Object} opts
 * @param {string} opts.status  'completed' | 'error' | 'aborted' | 'max-tokens' | 'blocked' | 'interrupted'
 * @param {string} [opts.summary] 最后一条 assistant 文本（截断后）
 * @param {number} [opts.durationMs]
 * @param {{inputTokens?:number, outputTokens?:number}} [opts.usage]
 */
export function resultCard({ status, summary = '', durationMs, usage }) {
  const icon = { completed: '✅', error: '❌', aborted: '⏹️', 'max-tokens': '⚠️', blocked: '⏳', interrupted: '⚠️' }[status] ?? '✅';
  const label = { completed: '任务完成', error: '任务失败', aborted: '任务已取消', 'max-tokens': '输出达到上限', blocked: '任务被阻塞', interrupted: '任务被中断' }[status] ?? '任务结束';
  const lines = [`${icon} ${label}`];
  if (summary) lines.push('', summary);
  const meta = [];
  if (durationMs != null) meta.push(`⏱ ${(durationMs / 1000).toFixed(1)}s`);
  if (usage && (usage.inputTokens || usage.outputTokens)) {
    meta.push(`🔢 ${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out tokens`);
  }
  if (meta.length) lines.push('', meta.join(' · '));
  return lines.join('\n');
}

/** 工具调用参数摘要（审批卡片展示，敏感参数脱敏）。 */
export function argsSummary(argsJson) {
  if (!argsJson) return '';
  let obj;
  try {
    obj = JSON.parse(argsJson);
  } catch {
    return String(argsJson).slice(0, 120);
  }
  const REDACT_KEYS = /(token|secret|key|password|passwd|credential|authorization|cookie|api[_-]?key)/i;
  const REDACT_PATTERN = /(Bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9._-]{20,})/g;
  const walk = (value, depth = 0) => {
    if (depth > 4) return '…';
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'string') {
      return value.replace(REDACT_PATTERN, '***').slice(0, 200);
    }
    if (typeof value === 'number' || value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      if (value.length > 6) return `[${value.slice(0, 6).map((v) => walk(v, depth + 1)).join(', ')}, …×${value.length - 6}]`;
      return `[${value.map((v) => walk(v, depth + 1)).join(', ')}]`;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length > 8) {
        const shown = entries.slice(0, 8).map(([k, v]) => `${k}=${walk(v, depth + 1)}`);
        return `{${shown.join(', ')}, …+${entries.length - 8}}`;
      }
      return `{${entries.map(([k, v]) => {
        if (REDACT_KEYS.test(k)) return `${k}=***`;
        if (typeof v === 'string' && REDACT_PATTERN.test(v)) return `${k}=***`;
        return `${k}=${walk(v, depth + 1)}`;
      }).join(', ')}}`;
    }
    return '…';
  };
  return walk(obj).slice(0, 400);
}
