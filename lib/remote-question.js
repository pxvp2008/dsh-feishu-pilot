// lib/remote-question.js —— 任意会话的飞书交互提问 answerer：覆盖 user-questions/request 瀑布
// （ask_user_question 与 exit_plan_mode 计划评审）。GUI 与飞书同时发起、竞速，先处理者生效，
// 后处理端一律失效；无人响应 → NO_PROVIDER（fail-closed）。留痕：questions-global.log（JSONL）。

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { displayTitle } from './remote-title.js';

const DEFAULT_QUESTION = Object.freeze({
  enabled: true,
  mode: 'feishu', // 'feishu' 双端同时（默认）| 'gui-first' 仅 GUI（不发飞书卡）| 'off' 同 gui-first
  timeoutSec: 300, // 飞书卡有效窗口 → 仅飞书侧失效，结果以 GUI 最终结算为准
  targetChatId: '',
});

const RECENT_WINDOW_MS = 5 * 60_000; // 失效/已被响应提示窗口
const DELEGATE = Symbol('delegate'); // 飞书超时 ⇒ 以 chain（GUI）最终结果为准
const CHAIN_WON = Symbol('chain-won'); // GUI 先处理 ⇒ 飞书卡失效
const ABORT = Symbol('abort'); // signal abort / 插件卸载
const MAX_OPTIONS = 10; // 超出 ⇒ 委派（卡片按钮过多失去可读性）
const MAX_QUESTIONS = 4; // 多问上限（超出 ⇒ 委派 GUI，发卡刷屏保护）
const PLAN_DETAIL_CHARS = 600; // 计划正文入卡截断（完整计划 GUI 可见）
const Q_DETAIL_CHARS = 300;

/**
 * @param {any} ctx
 * @param {{im:any, config?:object, ovrRef?:{current?:object|null}, log?:(...a:any[])=>void, stateDir?:string}} deps
 */
export function createRemoteQuestion(ctx, deps) {
  const { im, ovrRef, log = () => {} } = deps;
  const cfgBase = { ...DEFAULT_QUESTION, ...(deps.config?.remoteQuestion ?? {}) };
  const liveCfg = () => ({ ...cfgBase, ...(ovrRef?.current?.remoteQuestion ?? {}) });

  /** id → 记录（单问/多问两形态共用 settle/timer/abort 骨架） */
  const records = new Map();
  /** id → {ts, invalidatedBy}（失效/已被响应提示用，有界清理） */
  const recent = new Map();

  const logLine = (line) => {
    if (!deps.stateDir) return;
    const p = join(deps.stateDir, 'questions-global.log');
    void mkdir(dirname(p), { recursive: true })
      .then(() => appendFile(p, JSON.stringify(line) + '\n', 'utf8'))
      .catch(() => {}); // 留痕失败不影响主流程
  };

  /** 运行时探针：与审批共用 approvals-debug.log（宿主 console 拿不到时的离线通道）。 */
  const dbgLine = (line) => {
    if (!deps.stateDir) return;
    const p = join(deps.stateDir, 'approvals-debug.log');
    void mkdir(dirname(p), { recursive: true })
      .then(() => appendFile(p, `[${new Date().toISOString()}] ` + JSON.stringify(line) + '\n', 'utf8'))
      .catch(() => {});
  };

  const safeChannels = () => {
    try {
      const st = im?.channelsStatus?.();
      return Array.isArray(st)
        ? st.map((c) => ({ platform: c?.platform, connected: c?.status?.connected }))
        : (st ?? null);
    } catch {
      return 'unavailable';
    }
  };

  /**
   * 目标聊天：显式配置 → 当前 bot 记住的私聊 → null（无目标 ⇒ 委派）。
   * 主动投递：不等用户先发消息，凭稳定目标把决策内容投到飞书；回复侧只走卡片按钮
   * 回调（guq:<id>:<选项序号>）路由回本模块——非绑定会话无绑定，文本无法寻址。
   */
  const resolveTarget = (cfg) => {
    if (cfg.targetChatId) return String(cfg.targetChatId);
    const remembered = im?.map?.notifyChatId;
    return typeof remembered === 'string' && remembered ? remembered : null;
  };

  const platformOf = () => {
    try {
      if (im?.getChannel?.('feishu')) return 'feishu';
      const st = im?.channelsStatus?.();
      return st?.[0]?.platform ?? 'feishu';
    } catch {
      return 'feishu';
    }
  };

  const titleOf = async (sessionId) => {
    try {
      const sessions = ctx.get?.('sessions');
      const s = sessions?.get?.(sessionId);
      let cwd = '';
      if (s?.header?.cwd) {
        const { basename } = await import('node:path');
        cwd = basename(String(s.header.cwd));
      }
      const svc = ctx.get?.('sessionTitle');
      const t = svc?.get?.(s ?? { id: sessionId });
      // 不改 DSH 标题：原样取标题（仅单行化/超长截断），与 GUI 侧栏保持一致
      const raw = typeof t?.title === 'string' ? t.title : '';
      return { title: displayTitle(raw, sessionId, cwd), cwd };
    } catch { /* 兜底 */ }
    return { title: '', cwd: '' };
  };

  /** 向目标聊天推一条提示文本（失效/回执），失败静默。 */
  const pushNote = (platform, target, text) => {
    try {
      return im.push(platform, target, { text }).catch(() => {});
    } catch {
      return undefined;
    }
  };

  /** 单问解析（含 plan-review）。 */
  const parseSingle = (q) => {
    if (!q || typeof q.id !== 'string' || !q.id) return { why: 'bad-question' };
    const options = Array.isArray(q.options)
      ? q.options.filter((o) => o && typeof o.label === 'string' && o.label)
      : [];
    if (options.length === 0) return { why: 'no-options' };
    if (options.length > MAX_OPTIONS) return { why: 'too-many-options' };
    return {
      q,
      options: options.map((o) => o.label),
      planReview: q.intent?.kind === 'plan-review',
      approveLabel: q.intent?.kind === 'plan-review' ? q.intent.approve : undefined,
      // 多选：飞书按钮表达不了多选 ⇒ 单问走「文本编号作答」；多问混入仍委派（见 parseQuestion）
      multiText: q.multiSelect === true,
    };
  };

  /**
   * 解析整单请求 ⇒ 单问或多问（items 逐问可答）；不可答返回 {why}。
   * 认领条件（全满足才认领，否则 next() 委派 GUI——飞书按钮表达不了）：
   * 1–4 个问题、每问单选（非 multiSelect）、每问选项 1–10 个、plan-review 恒单问。
   */
  const parseQuestion = (req) => {
    const qs = Array.isArray(req?.questions) ? req.questions : [];
    if (qs.length === 0) return { why: 'no-questions' };
    if (qs.length === 1) return parseSingle(qs[0]);
    if (qs.length > MAX_QUESTIONS) return { why: 'too-many-questions' };
    const items = [];
    for (const q of qs) {
      const one = parseSingle(q);
      if (one.multiText) return { why: 'multi-select' }; // 多选仅支持单问（多问混入 ⇒ 整单委派）
      if (one.why) return { why: one.why }; // 任一问不可按钮作答 ⇒ 整单委派
      if (one.planReview) return { why: 'plan-review-multi' }; // 计划评审恒单问
      items.push(one);
    }
    return { multi: true, items };
  };

  /**
   * 认领一个提问请求：GUI 与飞书同时发起，先处理者生效（瀑布单决策，第一个给出
   * 回答的 answerer 独占；无人响应 → NO_PROVIDER）。
   * 返回 Promise<AskUserQuestionAnswer> = { answers: [{ id, selected: [选项标签] }] }。
   */
  /** 解析多选编号文本：'1,3' / '1 3' / '1、3' ⇒ [0,2]（1-based 去重；越界/非数字 ⇒ null）。 */
  const parseMultiNumbers = (text, count) => {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const parts = raw.split(/[\s,，、;；]+/).filter(Boolean);
    if (parts.length === 0) return null;
    const seen = new Set();
    const idxs = [];
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return null;
      const n = Number(part);
      if (!Number.isInteger(n) || n < 1 || n > count) return null;
      if (!seen.has(n - 1)) { seen.add(n - 1); idxs.push(n - 1); }
    }
    return idxs.length ? idxs : null;
  };

  async function answer(req, next) {
    const cfg = liveCfg();
    const sessionId = req?.agent?.id;
    const parsed = parseQuestion(req);
    dbgLine({ ev: 'q-called', session: sessionId, kind: parsed.why ? undefined : (parsed.multi ? 'multi' : (parsed.planReview ? 'plan-review' : 'question')), why: parsed.why ?? null, cfg: { enabled: cfg.enabled, mode: cfg.mode } });
    if (!cfg.enabled || cfg.mode === 'off' || cfg.mode === 'gui-first') {
      dbgLine({ ev: 'q-delegated', why: 'gui-only-mode', session: sessionId, mode: cfg.mode });
      return next(); // 仅 GUI
    }
    if (parsed.why) {
      dbgLine({ ev: 'q-delegated', why: parsed.why, session: sessionId });
      return next(); // 飞书按钮表达不了 ⇒ 仅 GUI
    }
    // 绑定/接管会话同样认领（核心没有提问 answerer）⇒ 把卡推到该会话绑定的
    // 聊天，用户在同一个聊天里作答。
    let binding = null;
    try {
      binding = im?.map?.bySessionId?.(sessionId) ?? null;
    } catch { /* 无 im 面 */ }
    const platform = binding?.platform ?? platformOf();
    if (!im?.push || !im?.getChannel?.(platform)) {
      dbgLine({ ev: 'q-delegated', why: 'channel-missing', session: sessionId, platform, hasPush: !!im?.push, channels: safeChannels() });
      return next();
    }
    const target = binding ? String(binding.chatId) : resolveTarget(cfg);
    if (!target) {
      dbgLine({ ev: 'q-delegated', why: 'no-target', session: sessionId });
      return next();
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const timeoutSec = Math.max(0.1, Number(cfg.timeoutSec) || 300);
    const info = await titleOf(sessionId);
    // 新会话标题常是第一条消息（可能是带格式/JSON 内容）⇒ 统一走展示兜底
    const title = displayTitle(info.title, sessionId, info.cwd);

    const rec = {
      id,
      done: false,
      timer: null,
      abortHandler: null,
      multi: !!parsed.multi,
      toolName: 'ask_user_question',
      sessionId: sessionId ?? '',
      createdAt: Date.now(),
      messageIds: new Set(), // 已推送卡片的消息 id：回调校验「点的是不是这些卡」（防转发卡越权）
      invalidated: null, // null | 'gui'
      settle: null,
      // 单问字段
      qid: null,
      options: null,
      awaitingCustom: null, // {platform, chatId, userId, since}（等用户发文本）
      multiText: false, // 多选文本作答模式（单问）
      multiTextWait: null, // {platform, chatId, userId, since}（等用户回复编号）
      // 多问字段
      questions: null, // [{id, question, header, detail}]
      optionsList: null, // 每问选项标签
      answers: null, // 每问 {selected:[label]} | {selected:[],custom} | null
      answeredCount: 0,
      armed: null, // {qIdx, platform, chatId, userId, since}（每单同时一个自定义等待）
    };

    /** 滑动超时（多问）：计时起点 = 最近一次活动（发卡/任一问答完/任一 ✍️ 武装），每次活动重设 timeoutSec。 */
    const bumpTimer = () => {
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = setTimeout(() => rec.settle(DELEGATE), timeoutSec * 1000);
      if (typeof rec.timer.unref === 'function') rec.timer.unref();
    };

    const settle = (v) => {
      if (rec.done) return;
      rec.done = true;
      if (rec.timer) clearTimeout(rec.timer);
      if (rec.abortHandler) req?.signal?.removeEventListener?.('abort', rec.abortHandler);
      rec.awaitingCustom = null; // 任何结算都关闭自定义回答等待（迟到文本走原生管线）
      rec.multiTextWait = null;
      rec.armed = null;
      records.delete(id);
      recent.set(id, { ts: Date.now(), invalidatedBy: rec.invalidated });
      pruneRecent();
      dbgLine({
        ev: 'q-settled',
        id,
        kind: rec.multi && Array.isArray(v?.multiAnswers) ? 'multi'
          : rec.multiText && Array.isArray(v?.multiSelected) ? 'multi-select'
            : v && typeof v === 'object' && v.custom !== undefined ? 'custom' : String(v),
        answered: rec.multi ? `${rec.answeredCount}/${rec.questions.length}` : undefined,
        ageMs: Date.now() - rec.createdAt,
      });
      rec._resolve?.(v);
    };
    rec.settle = settle;
    rec._resolve = null;

    const waitPromise = new Promise((resolve) => {
      rec._resolve = resolve;
    });
    records.set(id, rec); // 先登记再发卡（发卡期间点击不会「不存在」；失败路径删除）

    const cap = Q_DETAIL_CHARS;
    const detailOf = (q) => {
      const detail = String(q.detail ?? '').trim();
      if (!detail) return '';
      return detail.length > cap ? detail.slice(0, cap) + '\n…（完整内容见 GUI）' : detail;
    };

    if (!rec.multi) {
      // ── 单问路径：一张卡，每选项一个按钮 guq:<id>:<idx>（+ 自定义按钮）──
      const { q, options, planReview, approveLabel } = parsed;
      rec.qid = q.id;
      rec.options = options;
      rec.multiText = parsed.multiText === true;
      rec.toolName = planReview ? 'exit_plan_mode' : 'ask_user_question';
      const planCap = planReview ? PLAN_DETAIL_CHARS : Q_DETAIL_CHARS;
      const detail = String(q.detail ?? '').trim();
      const planTruncated = planReview && detail.length > planCap;
      const detailText = detail
        ? (detail.length > planCap
          ? detail.slice(0, planCap) + (planTruncated ? '\n…（完整计划见附件）' : '\n…（完整内容见 GUI）')
          : detail)
        : '';
      const text = [
        `会话 ${title}`,
        ...(q.header && !planReview ? [q.header] : []),
        planReview ? '是否批准该计划并退出计划模式？' : String(q.question ?? ''),
        ...(detailText ? ['\n' + detailText] : []),
        ...(rec.multiText
          ? ['\n多选：点下方按钮后回复编号（如 1,3）', ...options.map((label, i) => `${i + 1}. ${label}`)]
          : []),
        `（GUI 与飞书同时受理，任一端先回答即生效；${timeoutSec}s 内飞书未回答则仅 GUI 有效）`,
      ].filter(Boolean).join('\n');
      const buttons = rec.multiText
        ? [{ id: `guq:${id}:multi`, label: '✍️ 回复编号作答', style: 'primary' }]
        : options.map((label, i) => ({
        id: `guq:${id}:${i}`,
        // 计划评审按钮文案中文化（回答值仍用原始 label，保持与 DSH 语义一致）
        label: planReview
          ? (label === 'Approve' ? '✅ 批准并执行'
            : label === 'Keep planning' ? '✏️ 继续规划'
              : label === 'Reject' ? '❌ 拒绝' : label)
          : label,
        style: (planReview && label === approveLabel) || (!planReview && i === 0) ? 'primary' : 'default',
      }));
      if (!planReview && !rec.multiText) {
        // 自定义回答（等价 GUI 面板的自定义输入；计划评审为二元决策，不提供）
        buttons.push({ id: `guq:${id}:custom`, label: '✍️ 自定义回答', style: 'default' });
      }
      try {
        const sent = await im.push(platform, target, {
          text,
          title: planReview ? '📋 计划评审' : rec.multiText ? '🤔 AI 提问（多选）' : '🤔 AI 提问',
          buttons,
        });
        if (sent?.messageId) rec.messageIds.add(String(sent.messageId));
        dbgLine({ ev: 'q-pushed', id, platform, target });
        // 计划过长：卡片只放摘要，完整计划以 .md 附件补齐（真机反馈：计划显示不完整）
        if (planTruncated && typeof im.sendFile === 'function') {
          try {
            const okFile = await im.sendFile({ platform, chatId: target }, `plan-${id}.md`, detail);
            dbgLine({ ev: 'q-plan-file', id, ok: okFile !== false, chars: detail.length });
          } catch (e) {
            dbgLine({ ev: 'q-plan-file-failed', id, err: String(e?.message ?? e) });
          }
        }
      } catch (e) {
        dbgLine({ ev: 'q-push-failed', id, err: String(e?.message ?? e), channels: safeChannels() });
        records.delete(id);
        log(`[feishu-pilot] remote question card push failed — delegating: ${e?.message}`);
        return next(); // 发卡失败 ⇒ 仅 GUI
      }
      const startTimer = () => {
        if (rec.timer) clearTimeout(rec.timer);
        rec.timer = setTimeout(() => settle(DELEGATE), timeoutSec * 1000);
        if (typeof rec.timer.unref === 'function') rec.timer.unref();
      };
      rec._bump = startTimer; // 多选：进入/重试编号作答时重新计时
      startTimer(); // 单问：固定窗口（自推送起）
    } else {
      // ── 多问路径：每问一张卡同时推送，逐问独立作答、集齐前可改选，集齐 N 问整单结算 ──
      rec.questions = parsed.items.map((it) => it.q);
      rec.optionsList = parsed.items.map((it) => it.options);
      rec.answers = new Array(parsed.items.length).fill(null);
      const N = parsed.items.length;
      try {
        for (let k = 0; k < N; k++) {
          const q = parsed.items[k].q;
          const detailText = detailOf(q);
          const text = [
            `会话 ${title} · 问题 ${k + 1}/${N}`,
            ...(q.header ? [q.header] : []),
            String(q.question ?? ''),
            ...(detailText ? ['\n' + detailText] : []),
            `（共 ${N} 问，全部回答后生效；每次作答后重新计时，${timeoutSec}s 无动作则转 GUI；GUI 与飞书同时受理，先答完整者生效）`,
          ].filter(Boolean).join('\n');
          // 按钮 id 契约：飞书接入 parseButtonValue 固定 3 段
          // {action,id,answer}（lib/feishu/channel.js，回调按 action:id:answer
          // 重建）——4 段 id 的第 4 段会被吞。故多问序号编码进 answer 段：
          // `guq:<id>:<qIdx>.<optIdx>` / `guq:<id>:<qIdx>.custom`。
          const buttons = parsed.items[k].options.map((label, i) => ({
            id: `guq:${id}:${k}.${i}`,
            label,
            style: i === 0 ? 'primary' : 'default',
          }));
          buttons.push({ id: `guq:${id}:${k}.custom`, label: '✍️ 自定义回答', style: 'default' });
          const sent = await im.push(platform, target, { text, title: '🤔 AI 提问', buttons });
          if (sent?.messageId) rec.messageIds.add(String(sent.messageId));
        }
        dbgLine({ ev: 'q-pushed', id, platform, target, questions: N });
      } catch (e) {
        dbgLine({ ev: 'q-push-failed', id, err: String(e?.message ?? e), channels: safeChannels() });
        records.delete(id);
        log(`[feishu-pilot] remote question multi-card push failed — delegating: ${e?.message}`);
        return next(); // 任一卡失败 ⇒ 整单仅 GUI（不半途而废）
      }
      bumpTimer(); // 滑动窗口起点
      rec._bump = bumpTimer; // 回调侧作答/武装后复用（每次活动重新计时）
    }

    dbgLine({ ev: 'q-claiming', id, session: sessionId, platform, target, multi: rec.multi, questions: rec.multi ? rec.questions.length : 1, qid: rec.qid ?? undefined });

    // 双端同时发起：立即 next()（GUI answerer 展示问题面板并等待）+ 发飞书卡，两端竞速。
    // chain 以 NO_PROVIDER 拒绝（无 GUI 客户端）⇒ 飞书继续有效；GUI 先答 ⇒ 飞书卡失效。
    // 注意：waterfall 的 next() 可能返回非 Promise 同步值 ⇒ 一律 Promise.resolve 包裹。
    let chainP;
    try {
      chainP = Promise.resolve(next());
    } catch (e) {
      chainP = Promise.reject(e);
    }
    let chainVal = undefined;
    let chainErr = null;
    const chainSettledP = new Promise((res) => {
      chainP.then((v) => { chainVal = v; res(); }, (e) => { chainErr = e; res(); });
    });
    void (async () => {
      await chainSettledP;
      if (chainErr) return; // 无下游应答者（NO_PROVIDER）⇒ 飞书继续有效
      if (rec.done) return; // 飞书已先胜
      rec.invalidated = 'gui';
      dbgLine({ ev: 'q-invalidated-by-gui', id, answered: rec.multi ? `${rec.answeredCount}/${rec.questions.length}` : undefined });
      await pushNote(platform, target, `⚠️ 该提问 #${id} 已在 GUI 端回答，本卡片已失效。`);
      settle(CHAIN_WON);
    })();

    if (req?.signal) {
      if (req.signal.aborted) {
        settle(ABORT);
      } else {
        rec.abortHandler = () => settle(ABORT);
        req.signal.addEventListener('abort', rec.abortHandler, { once: true });
      }
    }

    const outcome = await waitPromise;
    // abort / 插件卸载 ⇒ 抛错（user-questions 转 ASK_ABORTED；该轮工具调用失败，用户可重新提问）
    if (outcome === ABORT) {
      await pushNote(platform, target, `ℹ️ 提问 #${id} 已取消（会话中断）。`);
      throw new Error('ask_user_question aborted before answer');
    }
    if (outcome === CHAIN_WON) {
      return chainVal; // GUI 先回答 ⇒ 回传 GUI 回答
    }
    if (outcome === DELEGATE) {
      dbgLine({ ev: 'q-feishu-timeout', id, answered: rec.multi ? `${rec.answeredCount}/${rec.questions.length}` : undefined });
      await pushNote(platform, target, rec.multi
        ? `⏰ 提问 #${id} 超时（已答 ${rec.answeredCount}/${rec.questions.length} 保留），剩余问题转 GUI。`
        : `⏰ 提问 #${id} 飞书卡片已失效，请在 GUI 回答；任务等待中。`);
      await chainSettledP; // 飞书侧失效；结果以 GUI 最终结算为准
      if (chainErr) throw chainErr; // GUI 也未答 ⇒ 瀑布 NO_PROVIDER
      // 多问：飞书已答项优先保留，GUI 只补未答项（避免 GUI 重问覆盖先答结果）
      if (rec.multi && rec.answeredCount > 0 && Array.isArray(chainVal?.answers)) {
        const answered = new Map();
        rec.answers.forEach((a, i) => { if (a) answered.set(rec.questions[i].id, a); });
        const merged = chainVal.answers.map((a) => (a && answered.has(a.id) ? { ...a, ...answered.get(a.id) } : a));
        for (const [qid, a] of answered) {
          if (!merged.some((x) => x && x.id === qid)) merged.push({ id: qid, ...a });
        }
        return { ...chainVal, answers: merged };
      }
      return chainVal;
    }
    // 飞书胜出：回调/入站侧已写审计 + 发回执 ⇒ 此处转结构化回答
    if (rec.multi && Array.isArray(outcome?.multiAnswers)) {
      return { answers: outcome.multiAnswers }; // 多问：按请求顺序的逐问回答
    }
    if (rec.multiText && Array.isArray(outcome?.multiSelected)) {
      return { answers: [{ id: rec.qid, selected: outcome.multiSelected }] };
    }
    if (outcome && typeof outcome === 'object' && outcome.custom !== undefined) {
      // 自定义回答：与 GUI 自定义回答同编码（selected 空 + custom 文本）
      return { answers: [{ id: rec.qid, selected: [], custom: outcome.custom }] };
    }
    return { answers: [{ id: rec.qid, selected: [outcome] }] };
  }

  function pruneRecent() {
    const now = Date.now();
    for (const [k, v] of recent) if (now - v.ts > RECENT_WINDOW_MS) recent.delete(k);
  }

  /** 多问：某问作答后的公共处理（计数/集齐结算/滑动计时/回执）。 */
  function answerMultiPart(rec, qIdx, answerObj, msg, p) {
    const N = rec.questions.length;
    const prev = rec.answers[qIdx];
    rec.answers[qIdx] = answerObj;
    if (!prev) rec.answeredCount++;
    if (rec.armed?.qIdx === qIdx) rec.armed = null; // 该问已定 ⇒ 解除其自定义等待
    logLine({
      id: rec.id,
      tool: rec.toolName,
      session: rec.sessionId,
      qid: rec.questions[qIdx].id,
      responder: `${p.platform}:${p.userId}${p.userName ? ` (${p.userName})` : ''}`,
      answer: answerObj.custom !== undefined ? `自定义：${String(answerObj.custom).slice(0, 100)}` : answerObj.selected[0],
      at: new Date().toISOString(),
      ageMs: Date.now() - rec.createdAt,
    });
    dbgLine({ ev: prev ? 'q-reanswer' : 'q-answered', id: rec.id, qIdx, answered: `${rec.answeredCount}/${N}` });
    const reply = (t) => pushNote(p.platform, p.chatId, t);
    if (rec.answeredCount >= N) {
      rec.settle({ multiAnswers: rec.answers.map((a, i) => ({ id: rec.questions[i].id, ...a })) });
      return reply(`✅ ${prev ? '已改选：' : ''}${msg}。全部 ${N} 问已回答 #${rec.id}，回答已回传会话。`);
    }
    rec._bump?.(); // 滑动超时：每次作答重新计时
    return reply(`${prev ? '已改选：' : ''}${msg}（已答 ${rec.answeredCount}/${N}，继续其余问题）。`);
  }

  /**
   * 飞书按钮回调（bridge.js 路由 guq:* 到此处）。
   * 单问 data = 'guq:<id>:<选项序号|custom>'；
   * 多问 data = 'guq:<id>:<qIdx>.<选项序号|custom>'——序号编码进第 3 段
   * （适配器 parseButtonValue 固定 3 段契约，4 段 id 尾段会被吞）。
   * 身份校验：点击者必须 ∈ allowlist。
   * @param {{platform:string, chatId:string, userId:string, userName?:string, data:string}} p
   */
  async function onCallback(p) {
    const parts = String(p?.data ?? '').split(':');
    if (parts[0] !== 'guq' || parts.length < 3) return;
    const [, id] = parts;
    const answerSeg = parts.slice(2).join(':'); // 正常恰为 3 段；防御性合并
    const multiFmt = answerSeg.includes('.');
    const reply = (t) => pushNote(p.platform, p.chatId, t);
    const rec = records.get(id);
    if (!rec) {
      const meta = recent.get(id);
      if (meta?.invalidatedBy === 'gui') {
        return reply(`ℹ️ 提问 #${id} 已在 GUI 端回答，本卡片已失效。`);
      }
      const r = meta ? 'ignored' : 'not-found';
      return reply(r === 'ignored' ? `ℹ️ 提问 #${id} 已被响应或已结束。` : `ℹ️ 提问 #${id} 不存在或已结束。`);
    }
    let allowed = false;
    try {
      allowed = im.map.isAllowed(p.platform, p.userId);
    } catch { /* 无 */ }
    if (!allowed) {
      return reply(`⛔ 无权限：回答提问需要飞书可信用户身份（当前 ${p.platform}:${p.userId} 未授权）。`);
    }
    // 卡片消息 id 校验：点击的必须是当初推出去的那张卡（转发/旧卡一律拒绝）
    if (rec.messageIds?.size && p.messageId && !rec.messageIds.has(String(p.messageId))) {
      return reply(`⛔ 请在原聊天中操作该提问（这张卡片已被转发或不是提问目标）。`);
    }
    if (rec.multi !== multiFmt) {
      return reply(`ℹ️ 无法识别的按钮：${p.data}`); // 单问卡收到多问 id（或反之）
    }

    if (rec.multi) {
      const N = rec.questions.length;
      const dot = answerSeg.indexOf('.');
      if (dot < 0) return reply(`ℹ️ 无法识别的按钮：${p.data}`); // 多问卡收到旧格式 id
      const qIdx = Number(answerSeg.slice(0, dot));
      if (!Number.isInteger(qIdx) || qIdx < 0 || qIdx >= N) {
        return reply(`ℹ️ 无法识别的问题序号：${answerSeg}`);
      }
      const optRaw = answerSeg.slice(dot + 1);
      if (optRaw === 'custom') {
        // 每单同时只允许一个武装问（armed.qIdx）；换武装时回执说明
        if (rec.armed?.qIdx === qIdx) {
          return reply(`ℹ️ 问题 ${qIdx + 1}/${N} 正在等待自定义回答——直接在飞书里发送文字即可（选项按钮也仍可用）。`);
        }
        const prevArmed = rec.armed?.qIdx;
        rec.armed = { qIdx, platform: p.platform, chatId: String(p.chatId), userId: p.userId, since: Date.now() };
        dbgLine({ ev: 'q-custom-armed', id, qIdx, switchedFrom: prevArmed ?? undefined });
        rec._bump?.();
        return reply(`✍️ 好的——请直接回复本对话：你发送的文字将作为问题 ${qIdx + 1}/${N} 的自定义回答（该条消息不会进入任何会话）。${prevArmed !== undefined ? `（问题 ${prevArmed + 1} 的等待已取消）` : '改主意可随时点上方选项按钮。'}`);
      }
      const optIndex = Number(optRaw);
      const options = rec.optionsList[qIdx];
      if (!Number.isInteger(optIndex) || optIndex < 0 || optIndex >= options.length) {
        return reply(`ℹ️ 无法识别的选项：${optRaw}`);
      }
      const label = options[optIndex];
      return answerMultiPart(
        rec, qIdx, { selected: [label] },
        `问题 ${qIdx + 1}/${N} 已选择「${label}」`,
        p,
      );
    }

    // ── 单问路径 ────────────────────────────────────────────────────
    const optRaw = answerSeg;
    if (optRaw === 'multi') {
      if (!rec.multiText) return reply(`ℹ️ 无法识别的按钮：${p.data}`);
      if (rec.multiTextWait) return reply('ℹ️ 正在等待你回复编号——直接发送如 1,3 即可。');
      rec.multiTextWait = { platform: p.platform, chatId: String(p.chatId), userId: p.userId, since: Date.now() };
      dbgLine({ ev: 'q-multi-armed', id });
      rec._bump?.();
      return reply('✍️ 请直接回复本对话，用编号多选，例如：1,3（该消息不会进入任何会话）。改主意可重新点按钮。');
    }
    if (optRaw === 'custom') {
      // 进入自定义回答等待（两段式：飞书卡片 v1 无输入组件）——用户随后直接发文本即回答，bridge.js 拦截
      if (rec.awaitingCustom) {
        return reply(`ℹ️ 提问 #${id} 正在等待自定义回答——直接在飞书里发送文字即可（选项按钮也仍可用）。`);
      }
      rec.awaitingCustom = { platform: p.platform, chatId: String(p.chatId), userId: p.userId, since: Date.now() };
      dbgLine({ ev: 'q-custom-armed', id });
      return reply(`✍️ 好的——请直接回复本对话：你发送的文字将作为此提问的自定义回答（该条消息不会进入任何会话）。改主意可随时点上方选项按钮。`);
    }
    const optIndex = Number(optRaw);
    if (!Number.isInteger(optIndex) || optIndex < 0 || optIndex >= rec.options.length) {
      return reply(`ℹ️ 无法识别的选项：${optRaw}`);
    }
    const label = rec.options[optIndex];
    logLine({
      id: rec.id,
      tool: rec.toolName,
      session: rec.sessionId,
      qid: rec.qid,
      responder: `${p.platform}:${p.userId}${p.userName ? ` (${p.userName})` : ''}`,
      answer: label,
      at: new Date().toISOString(),
      ageMs: Date.now() - rec.createdAt,
    });
    rec.settle(label);
    return reply(`✅ 已选择「${label}」#${id}，回答已回传会话。`);
  }

  /**
   * 入站文本拦截（bridge.js 的 dispatchInbound 覆写在 allowlist 闸门之后调用）。
   * 处于自定义等待的提问认领同平台同聊天的下一条文本为自定义回答——该条文本
   * 不再进入核心原生派活（不建会话/不路由）。
   * 多问：文本记给当前武装问（armed.qIdx），回执注明问题序号；答错可在集齐前改选。
   * @param {{platform:string, chatId:string, userId:string, userName?:string, text?:string}} msg
   * @returns {Promise<{handled:boolean}>} handled=true ⇒ 已作为自定义回答结算。
   */
  async function onInbound(msg) {
    const platform = String(msg?.platform ?? '');
    const chatId = String(msg?.chatId ?? '');
    let rec = null;
    let recWait = null;
    for (const r of records.values()) {
      const wait = r.multiText ? r.multiTextWait : (r.multi ? r.armed : r.awaitingCustom);
      if (!wait) continue;
      if (wait.platform !== platform) continue;
      if (wait.chatId !== chatId) continue;
      if (!rec || wait.since >= recWait.since) {
        rec = r; // 多待答 ⇒ 取最近进入等待的那个
        recWait = wait;
      }
    }
    if (!rec) return { handled: false };
    const text = String(msg?.text ?? '').trim();
    if (!text) return { handled: false };
    if (rec.multiText) {
      const idxs = parseMultiNumbers(text, rec.options.length);
      if (idxs === null) {
        await pushNote(platform, chatId, `ℹ️ 请回复选项编号（1-${rec.options.length}），可多选，例如：1,3。`);
        rec._bump?.();
        return { handled: true };
      }
      const labels = idxs.map((i) => rec.options[i]);
      dbgLine({ ev: 'q-multi-answer', id: rec.id, picks: idxs });
      logLine({
        id: rec.id,
        tool: rec.toolName,
        session: rec.sessionId,
        qid: rec.qid,
        responder: `${msg.platform}:${msg.userId}${msg.userName ? ` (${msg.userName})` : ''}`,
        answer: labels.join('、'),
        at: new Date().toISOString(),
        ageMs: Date.now() - rec.createdAt,
      });
      rec.multiTextWait = null;
      rec.settle({ multiSelected: labels });
      await pushNote(platform, chatId, `✅ 已选择「${labels.join('、')}」#${rec.id}，回答已回传会话。`);
      return { handled: true };
    }
    const custom = text.slice(0, 2000);
    if (rec.multi) {
      const qIdx = rec.armed.qIdx;
      const N = rec.questions.length;
      dbgLine({ ev: 'q-custom-answer', id: rec.id, qIdx, chars: custom.length });
      await answerMultiPart(
        rec, qIdx, { selected: [], custom },
        `已收到自定义回答「${custom.slice(0, 100)}」——记为问题 ${qIdx + 1}/${N}`,
        { platform, chatId, userId: msg?.userId, userName: msg?.userName },
      );
      return { handled: true };
    }
    dbgLine({ ev: 'q-custom-answer', id: rec.id, chars: custom.length });
    logLine({
      id: rec.id,
      tool: rec.toolName,
      session: rec.sessionId,
      qid: rec.qid,
      responder: `${msg.platform}:${msg.userId}${msg.userName ? ` (${msg.userName})` : ''}`,
      answer: `自定义：${custom.slice(0, 100)}`,
      at: new Date().toISOString(),
      ageMs: Date.now() - rec.createdAt,
    });
    rec.settle({ custom });
    await pushNote(platform, chatId, `✅ 已收到自定义回答「${custom.slice(0, 100)}」#${rec.id}，回答已回传会话。`);
    return { handled: true };
  }

  // user-questions/request 同为单决策瀑布，GUI remote answerer 先注册会短路
  // ⇒ prepend 链首取得首认领权 + global 保证 agent 作用域派发可见。
  const dAnswer = ctx.on('user-questions/request', (req, next) => answer(req, next), { global: true, prepend: true });

  // 运行时探针：观察每次派发并快照共享链状态（与审批同文件，ev 前缀 q-*）。
  const dObserve = ctx.on('internal/dispatch', (mode, name, _args, thisArg) => {
    if (name !== 'user-questions/request') return;
    let verdict = 'no-carrier';
    try {
      const f = thisArg && thisArg[Symbol.for('cordis.filter')];
      if (typeof f === 'function') verdict = f.call(thisArg, ctx) ? 'my-ctx-ADMITTED' : 'my-ctx-FILTERED-OUT';
      else verdict = 'carrier-without-filter-fn';
    } catch (e) {
      verdict = 'filter-threw:' + String(e?.message ?? e);
    }
    let hooksLen = 'err';
    try {
      const h = ctx.events?._hooks?.['user-questions/request'];
      hooksLen = Array.isArray(h) ? h.length : 'no-array';
    } catch { /* 忽略 */ }
    dbgLine({ ev: 'q-dispatch-seen', mode, verdict, myHooksLen: hooksLen });
  });

  dbgLine({
    ev: 'q-registered',
    platform: platformOf(),
    channelFeishu: !!im?.getChannel?.('feishu'),
    hasPush: !!im?.push,
    channels: safeChannels(),
    cfg: liveCfg(),
    typeofDAnswer: typeof dAnswer,
  });

  return {
    onCallback,
    onInbound,
    pending: () => records.size,
    liveCfg,
    dispose() {
      dAnswer?.();
      dObserve?.();
      for (const rec of [...records.values()]) {
        try {
          rec.settle?.(ABORT);
        } catch { /* 已定 */ }
      }
      records.clear();
      recent.clear();
    },
  };
}

export { DEFAULT_QUESTION };
