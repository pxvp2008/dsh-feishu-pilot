// lib/core/approvals.js —— 绑定会话的审批管理（插件内部）。
//
// 两段式接线：
//  1. tools/pre-execute 门：按风险规则对「IM 绑定会话」的工具调用返回 {kind:'ask'}
//     （风险 < medium 一律放行——防审批疲劳）。同时捕获 callId→参数摘要供卡片展示。
//  2. approval/request answerer：把宿主审批 seam 路由到 IM——推送审批卡片
//     （按钮 approve:<id>:yes|no，/approve 文本降级），首个响应者生效。
//  非绑定会话 ⇒ next() 委派（GUI 兜底 / 插件 remote-approval 卡片）。
//
// 超时语义（可恢复拒绝）：timeoutSec 内无人响应 → 「任务被阻塞」提醒 + pending；
// 可稍后点按钮或 /approve 恢复；pendingMaxSec 仍无人响应 → 失败关闭（rejected）。
//
// 钩子必须 {global:true, prepend:true}：接管（/ws）的 GUI 会话，其审批/工具派发
// 发生在会话自己的 fiber 上，非全局 hook 不可见；prepend 保证排在宿主 GUI 兜底
// answerer 之前（与 remote-approval/remote-question 同一 fiber 规则）。
//
// 审批记录：storeDir/approvals.log（追加式 JSON 行）。

import { randomUUID } from 'node:crypto';
import { argsSummary } from './renderer.js';

// ── 风险规则（顺序敏感：先匹配先生效） ──────────────────────────────────────
// 默认规则贴合真实工作流：npm install / rm -rf node_modules 等常规操作 = low，
// 不触发审批——避免「审批疲劳 → 用户关掉审批 → 反而更不安全」。
//
// 注意：规则的 tool 字段用 'tool-bash' 表达「命令类工具」，实际工具名随运行时变化
// （Windows 是 `pwsh`、类 Unix 可能是 `bash`/`shell`）。匹配时按别名组归一，
// 否则 Windows 上所有命令规则都会失效（0.11.1 真机发现）。

/** 命令类工具别名（规则里统一写 tool-bash）。 */
const COMMAND_TOOLS = new Set(['tool-bash', 'bash', 'pwsh', 'powershell', 'shell', 'exec', 'terminal']);

export function defaultRiskRules() {
  return [
    // ── 低风险（常规开发操作，永不审批；必须先于同名高危规则匹配）──
    { tool: 'tool-bash', args: 'rm\\s+-rf\\s+[^|;&]*node_modules', risk: 'low' },
    { tool: 'tool-bash', args: '(Remove-Item|rm)\\s+[^\\n]*node_modules', risk: 'low' },
    { tool: 'tool-bash', args: '(npm|pnpm|yarn|bun)\\s+(install|ci|add|remove|update)', risk: 'low' },
    { tool: 'tool-bash', args: 'pip\\s+(install|uninstall)', risk: 'low' },
    { tool: 'tool-bash', args: 'git\\s+(pull|clone|fetch|checkout|merge)|git\\s+push\\s+(?!-f\\b|--force\\b)', risk: 'low' },

    // ── 高风险 ──
    { tool: 'tool-bash', args: 'rm\\s+-rf\\s+[~/]|rm\\s+-rf\\s+\\*', risk: 'high' },
    { tool: 'tool-bash', args: 'rm\\s+-rf\\s+/(etc|usr|var|boot|home)', risk: 'high' },
    { tool: 'tool-bash', args: '(mkfs|fdisk|dd\\s+if=)', risk: 'high' },
    { tool: 'tool-bash', args: 'curl.*\\|\\s*(ba)?sh|wget.*\\|\\s*(ba)?sh', risk: 'high' },
    { tool: 'tool-bash', args: 'chmod\\s+-R\\s+777', risk: 'high' },
    { tool: 'tool-bash', args: '\\bsudo\\s+(rm\\s+-rf|shutdown|reboot|poweroff)', risk: 'high' },
    { tool: 'tool-bash', args: '(Format-Volume|Clear-Disk|Initialize-Disk)', risk: 'high' },
    { tool: 'tool-bash', args: '(Clear-RecycleBin)', risk: 'medium' },

    // ── 中风险（需要人确认）──
    { tool: 'tool-bash', args: '\\brm\\s+-rf\\b', risk: 'medium' },
    { tool: 'tool-bash', args: 'Remove-Item\\s+[^\\n]*(?:-Recurse[^\\n]*-Force|-Force[^\\n]*-Recurse)', risk: 'medium' },
    { tool: 'tool-bash', args: '\\b(del|erase)\\s+[^\\n]*(?:/s|/q)', risk: 'medium' },
    { tool: 'tool-bash', args: 'git\\s+push\\s+.*(--force|-f\\b)', risk: 'medium' },
    { tool: 'tool-bash', args: '\\bsudo\\b', risk: 'medium' },
    { tool: 'tool-bash', args: 'kill\\s+-9', risk: 'medium' },
    { tool: 'tool-bash', args: 'Stop-Process\\s+[^\\n]*-Force', risk: 'medium' },
    { tool: 'tool-bash', args: '(Stop-Computer|Restart-Computer|shutdown|reboot|poweroff)', risk: 'medium' },
    // 历史规则：这些工具名在现运行时不存在，保留但不生效（避免误伤正常编辑）
    { tool: 'tool-fs', args: 'remove', risk: 'medium' },
    { tool: 'tool-str-replace-editor', args: '', risk: 'medium' },
  ];
}

function riskAtLeast(a, b) {
  const rank = { none: 0, low: 1, medium: 2, high: 3 };
  return rank[a] >= rank[b];
}

/** 规则 tool 与实际工具名是否匹配（命令类工具按别名归一）。 */
function toolMatches(ruleTool, tool) {
  if (ruleTool === tool) return true;
  return ruleTool === 'tool-bash' && COMMAND_TOOLS.has(String(tool));
}

function evaluateRisk(tool, argsJson, rules) {
  const haystack = argsJson ?? '';
  for (const rule of rules) {
    if (!toolMatches(rule.tool, tool)) continue;
    if (rule.args) {
      let re;
      try {
        re = new RegExp(rule.args, 'i');
      } catch {
        continue;
      }
      if (!re.test(haystack)) continue;
    }
    return rule.risk;
  }
  return 'low';
}

// ── 审批管理器 ───────────────────────────────────────────────────────────────

export class ApprovalManager {
  /**
   * @param {Object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx
   * @param {import('./session-map.js').SessionMap} deps.map
   * @param {(chat: {platform:string, chatId:string}, out: object) => Promise<any>} deps.send
   * @param {(line: object) => void} deps.logLine
   */
  constructor({ ctx, map, send, logLine }) {
    this.ctx = ctx;
    this.map = map;
    this.send = send;
    this.logLine = logLine;
    /** approvalId → record */
    this.records = new Map();
    /** callId → {tool, risk, args, at}（pre-execute 捕获，卡片渲染用） */
    this.callArgs = new Map();
    /** 最近已决记录（供「已被响应」提示） */
    this.recentDecisions = new Map();
    this.timeoutSec = 300;
    this.pendingMaxSec = 3600;
    /** true = 仅 GUI（设置页「仅 GUI」）：不推飞书卡，直接交回 GUI answerer。 */
    this.guiOnly = false;
    this.riskRules = defaultRiskRules();
    this._dispose = [];
  }

  /** 挂接 tools/pre-execute 门 + approval/request answerer（global+prepend，见头注）。 */
  mount() {
    this._dispose.push(this.ctx.on('tools/pre-execute', (exec, next) => this.gate(exec, next), { global: true, prepend: true }));
    this._dispose.push(this.ctx.on('approval/request', (req, next) => this.answer(req, next), { global: true, prepend: true }));
  }

  dispose() {
    for (const d of this._dispose) d();
    this._dispose = [];
    for (const rec of this.records.values()) {
      clearTimeout(rec.timeoutTimer);
      clearTimeout(rec.pendingTimer);
      rec.resolve('cancelled');
    }
    this.records.clear();
  }

  /** 风险门只对 IM 绑定会话生效；其余会话交给其他策略（Web UI 等），不双弹窗。 */
  gate(exec, next) {
    const agent = exec.agent;
    const binding = agent ? this.map.bySessionId(agent.id) : null;
    if (!binding) return next();
    const argsJson = JSON.stringify(exec.arguments ?? {});
    const risk = evaluateRisk(exec.name, argsJson, this.riskRules);
    // 阈值以下直接放行；常规操作（low）永不触发审批
    if (!riskAtLeast(risk, 'medium')) return next();
    const callId = exec.callId;
    if (callId) {
      this.callArgs.set(callId, { tool: exec.name, risk, args: argsSummary(argsJson), at: Date.now() });
      if (this.callArgs.size > 200) {
        const oldest = this.callArgs.keys().next().value;
        this.callArgs.delete(oldest);
      }
    }
    const reason = `工具 "${exec.name}" 被判定为 ${risk} 风险（IM 远程审批，默认拒绝）`;
    return { kind: 'ask', reason };
  }

  /** approval/request answerer：只应答 IM 绑定会话的请求，否则 next() 委托。 */
  answer(req, next) {
    const binding = this.map.bySessionId(req.agent.id);
    if (!binding) return next();
    return this.prompt(req, binding, next);
  }

  /** 推送审批卡片并等待响应（GUI 与飞书双端竞速，先处理者生效）。 */
  async prompt(req, binding, next = () => 'unavailable') {
    // 仅 GUI：不推飞书卡，直接交回 GUI answerer（否则绑定会话会在飞书弹卡）
    if (this.guiOnly) {
      try {
        return await next();
      } catch {
        return 'unavailable';
      }
    }
    const approvalId = randomUUID().slice(0, 8);
    const callInfo = req.callId ? this.callArgs.get(req.callId) : null;
    const risk = callInfo?.risk ?? 'medium';
    const record = {
      id: approvalId,
      req,
      binding,
      toolName: req.toolName,
      args: callInfo?.args ?? '',
      risk,
      reason: req.reason ?? '',
      createdAt: Date.now(),
      messageId: '', // 推送成功后记录：回调校验「点的是不是这张卡」（防转发卡越权）
      state: 'waiting', // waiting → pending（超时后飞书侧失效）→ decided
      feishuExpired: false, // true = 飞书卡已失效，仅 GUI / /approve 可继续
      responder: null,
      resolve: null,
      timeoutTimer: null,
      pendingTimer: null,
    };
    const outcome = new Promise((resolve) => {
      record.resolve = (value) => {
        if (record.state === 'decided') return;
        record.state = 'decided';
        clearTimeout(record.timeoutTimer);
        clearTimeout(record.pendingTimer);
        this.logLine({
          ts: new Date().toISOString(),
          approvalId,
          agent: binding.sessionId,
          tool: req.toolName,
          args: record.args,
          requester: `${binding.platform}:${binding.chatId}`,
          responder: record.responder,
          outcome: value,
          durationMs: Date.now() - record.createdAt,
        });
        this.records.delete(approvalId);
        this.recentDecisions.set(approvalId, { outcome: value, at: Date.now(), responder: record.responder });
        if (this.recentDecisions.size > 100) {
          const oldest = this.recentDecisions.keys().next().value;
          this.recentDecisions.delete(oldest);
        }
        resolve(value);
      };
    });
    this.records.set(approvalId, record);

    try {
      const sent = await this.send({ platform: binding.platform, chatId: binding.chatId }, this.renderCard(record));
      if (sent && typeof sent === 'object') record.messageId = String(sent.messageId ?? '');
    } catch {
      // 推送失败：飞书端不可用，交回后续 answerer（GUI）兜底；都不可用则 fail closed
      record.resolve('unavailable');
      try {
        return await next();
      } catch {
        return 'unavailable';
      }
    }

    // 超时 → 飞书卡失效（转 GUI），GUI 仍可处理；再超 → fail closed
    record.timeoutTimer = setTimeout(() => {
      if (record.state !== 'waiting') return;
      record.state = 'pending';
      record.feishuExpired = true;
      void this.send({ platform: binding.platform, chatId: binding.chatId }, {
        text: `⏰ 审批 #${approvalId} 飞书卡片已失效，请在 GUI 处理；任务等待中（可回复 /approve ${approvalId} yes｜no）。`,
      }).catch(() => {});
      // 再超 → 失败关闭（deny-by-default 兜底）
      record.pendingTimer = setTimeout(() => {
        if (record.state !== 'pending') return;
        record.resolve('rejected');
        void this.send({ platform: binding.platform, chatId: binding.chatId }, {
          text: `❌ 审批 #${approvalId} 超时未响应，已拒绝（可重试）。`,
        }).catch(() => {});
      }, this.pendingMaxSec * 1000);
    }, this.timeoutSec * 1000);

    // 会话取消 → cancelled
    req.signal?.addEventListener('abort', () => record.resolve('cancelled'), { once: true });

    // 双端竞速：发卡后把请求同时交回 GUI answerer（next()），任一端先处理生效。
    // 修复真机 D2：此前认领后不再 next()，绑定会话的审批永远不会出现在 GUI。
    let chain;
    try {
      chain = Promise.resolve(next());
    } catch {
      chain = Promise.resolve('unavailable');
    }
    const guiFirst = chain.then(
      (value) => ({ from: 'gui', value }),
      () => ({ from: 'gui', value: 'unavailable' }),
    );
    const feishuFirst = outcome.then((value) => ({ from: 'feishu', value }));
    const first = await Promise.race([feishuFirst, guiFirst]);
    if (first.from === 'feishu') return first.value;
    if (first.value === 'unavailable' || first.value === undefined || first.value === null) {
      return outcome; // GUI 无客户端 / 未接手 ⇒ 继续等飞书
    }
    // GUI 先处理：作废飞书卡并回执；避免另一端再点按钮重复生效
    if (record.state !== 'decided') {
      record.responder = `gui:${first.value}`;
      record.resolve(first.value);
      await this.send({ platform: binding.platform, chatId: binding.chatId }, {
        text: `⚠️ 审批 #${approvalId} 已在 GUI 端处理（${first.value}），本卡片已失效。`,
      }).catch(() => {});
    }
    return first.value;
  }

  renderCard(record) {
    const lines = [
      `#${record.id}`,
      `工具: ${record.toolName}`,
    ];
    if (record.args) lines.push(`参数: ${record.args}`);
    lines.push(`风险: ${record.risk}`);
    if (record.reason) lines.push(`原因: ${record.reason}`);
    lines.push(`会话: ${record.binding.sessionId}`);
    return {
      text: lines.join('\n'),
      title: '🔐 审批请求',
      template: 'blue',
      buttons: [
        { id: `approve:${record.id}:yes`, label: '✅ 批准', style: 'primary' },
        { id: `approve:${record.id}:no`, label: '❌ 拒绝', style: 'danger' },
      ],
    };
  }

  /**
   * 用户响应（按钮回调 / /approve 命令）。首个响应者生效。
   * @param {{platform:string,userId:string,userName?:string,messageId?:string}} actor
   *        messageId 仅按钮回调携带：与推送时记录的卡片 id 不一致 ⇒ 拒绝（转发卡/旧卡越权）
   * @returns {'accepted'|'rejected'|'ignored'|'not-found'|'forbidden'|'wrong-card'}
   */
  respond(approvalId, answer, { platform, userId, userName, messageId = '' }) {
    const record = this.records.get(approvalId);
    if (!record) {
      return this.recentDecisions.has(approvalId) ? 'ignored' : 'not-found';
    }
    if (!this.map.isAllowed(platform, userId)) return 'forbidden';
    // 飞书卡超时后按钮回调拒绝；/approve 命令（无 messageId）仍可兜底
    if (record.feishuExpired && messageId) return 'expired';
    if (record.messageId && messageId && record.messageId !== messageId) return 'wrong-card';
    if (record.state === 'decided') return 'ignored';
    if (answer !== 'yes' && answer !== 'no') return 'ignored';
    record.responder = `${platform}:${userId}${userName ? ` (${userName})` : ''}`;
    record.resolve(answer === 'yes' ? 'allowed-once' : 'rejected');
    return answer === 'yes' ? 'accepted' : 'rejected';
  }

  /** 当前等待中的审批（/status 用）。 */
  pendingList() {
    return [...this.records.values()].map((r) => ({
      id: r.id,
      tool: r.toolName,
      state: r.state,
      ageSec: Math.round((Date.now() - r.createdAt) / 1000),
    }));
  }
}
