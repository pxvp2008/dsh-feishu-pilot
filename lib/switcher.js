// lib/switcher.js —— 工作区切换主流程：解析目标工作区 → 取得/接管会话 → attach → 换绑 → 结果卡。
//
// 提交点（不变式 I4）：意图写入（state.setIntent）是切换的提交点 —— 紧邻 rebind 之前：
//   - 提交前失败（解析/预检/attach/空闲重查）= 干净失败：意图未动，只需 detach + dispose；
//   - 提交后失败（rebind 抛错）= 显式恢复意图（prev 快照）+ dispose handle；
//   - 进程崩溃 = 自愈朝磁盘上的意图收敛（重启后 ensureBinding/repairToIntent）。
//
// 契约：
//   createSwitcher(ctx, deps) => {
//     switchToWorkspace(msg, workspacePath, { mode }): Promise<Result>
//     repairToIntent(msg, intent, ws): Promise<Result>
//     switchOrNew(msg): Promise<Result>            // /new 重定向（含 maxSessions）
//   }
//   deps = { state, im, cards, nav, config }
//   Result = { ok, fromWorkspace?, toWorkspace?, sessionId, elapsedMs, error?, upgradeHint? }

import { stat } from 'node:fs/promises';
import { freshSessionId, rebind } from './rebind.js';
import { lookupWorkspace } from './reconcile.js';
import { archivedSet } from './session-picker.js';
import { makeAgentSetup } from './agent-setup.js';

/**
 * agentOptions 与核心同源解析：直接复用 im.agentOptions()
 * （cfg.agent 显式配置优先 → agentDefaultModel → 内置默认），两条路径不漂移。
 * @param {any} im
 * @returns {Promise<{provider?:string, model?:string}>}
 */
async function buildAgentOptions(im) {
  if (typeof im?.agentOptions === 'function') {
    try {
      const opts = await im.agentOptions();
      if (opts && (opts.provider || opts.model)) return opts;
    } catch {
      /* fall through */
    }
  }
  const cfg = im?.cfg?.agent ?? {};
  return { provider: cfg.provider ?? '', model: cfg.model ?? '' };
}

/** 会话 agent 是否存活且非 idle（切换流程的双重空闲检查：初查 + attach 后重查）。 */
function agentBusy(ctx, sessionId) {
  const agent = ctx?.agents?.get?.(sessionId);
  return !!(agent && agent.status !== 'idle');
}

function maxSessionsOf(im) {
  return im?.cfg?.security?.maxSessions ?? 10;
}

/** 服务安全访问（cordis 裸属性未声明会 throw ⇒ 只走 ctx.get()，失败 undefined）。 */
function safeSvc(ctx_, name) {
  try {
    if (ctx_ && typeof ctx_.get === 'function') return ctx_.get(name);
  } catch { /* 未注册/无权限 */ }
  return undefined;
}

/**
 * 会话显示名：结果卡不能显示裸 sessionId（对人无意义，要「哪个工作区的哪个会话」）：
 *   ① sessionQuery.readTitleSnapshots([id]) —— 落盘会话也有效（首选，与
 *      「接管指定会话」选择器同数据源）；
 *   ② sessionTitle.get(sessions.get(id))    —— 存活会话兜底（快照对象
 *      {title,...}，兼容字符串假件）；
 *   ③ 无标题 ⇒ 新会话「新建会话」；既有会话「工作区目录名 · 创建时间」
 *      （与 session-picker 无标题回退一致，绝不显示裸 id）。
 * 全程尽力而为（标题是装饰），任何失败都不得阻断切换。
 * @param {any} ctx_
 * @param {string} sessionId
 * @param {string} wsPath 目标工作区路径（回退用）
 * @param {{isNew?: boolean}} [opt]
 * @returns {Promise<string>}
 */
async function sessionDisplayName(ctx_, sessionId, wsPath, opt = {}) {
  try {
    const query = safeSvc(ctx_, 'sessionQuery');
    if (query?.readTitleSnapshots) {
      const results = await query.readTitleSnapshots([sessionId]);
      for (const res of results ?? []) {
        const t = res?.status === 'fulfilled' ? res.value?.title?.title : '';
        if (t) return t;
      }
    }
  } catch { /* best-effort */ }
  try {
    const titleSvc = safeSvc(ctx_, 'sessionTitle');
    const sess = safeSvc(ctx_, 'sessions')?.get?.(sessionId);
    if (titleSvc?.get && sess) {
      const snap = titleSvc.get(sess);
      const t = snap && typeof snap.title === 'string' ? snap.title : (typeof snap === 'string' ? snap : '');
      if (t) return t;
    }
  } catch { /* best-effort */ }
  if (opt.isNew) return '新建会话';
  try {
    const base = wsPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    const createdAt = safeSvc(ctx_, 'sessions')?.get?.(sessionId)?.header?.createdAt;
    const ts = typeof createdAt === 'number' ? new Date(createdAt) : null;
    const stamp = ts
      ? `${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
      : '';
    return base ? (stamp ? `${base} · ${stamp}` : base) : '未命名会话';
  } catch {
    return '未命名会话';
  }
}

/**
 * 全局「最近会话」查找：「接管最近会话」= **用户最近操作的会话**，不限于按钮
 * 目标工作区（用户刚在别的工作区的会话里发过消息，它就是最近的，即使当前意图
 * 工作区是别的）。
 * 数据源 = 宿主 sessionController.list()（dsh-api-session-controller）：
 *   { items: [ {sessionId, updatedAt(=max(createdAt, lastPromptAt)), cwd,
 *     running, blank, parentSessionId?} ] } —— live + 落盘全量，已按活跃度
 *   降序（新在前），与 GUI 会话侧栏同一数据面。
 * 过滤：子代理会话（parentSessionId）、归档会话（archivedSet，与 GUI
 * 「archived sessions are excluded everywhere」一致）、无 cwd、cwd 目录已删
 * （跳过后继续找次新候选）。
 * @param {any} ctx_
 * @returns {Promise<{sessionId:string, cwd:string}|null>} 首个可接管候选；
 *   服务缺席/列表为空/全部不可用 ⇒ null（调用方回退「目标工作区最近会话」）。
 */
async function findGlobalNewestSession(ctx_) {
  try {
    const sc = safeSvc(ctx_, 'sessionController');
    const res = await sc?.list?.({});
    const items = res?.items ?? (Array.isArray(res) ? res : null);
    if (!Array.isArray(items)) return null;
    const archived = archivedSet(ctx_);
    for (const it of items) {
      const id = it?.sessionId ?? it?.id;
      const cwd = it?.cwd;
      if (typeof id !== 'string' || id === '') continue;
      if (typeof cwd !== 'string' || cwd === '') continue; // 无 cwd 的会话无法定位工作区
      if (it?.parentSessionId) continue; // 子代理会话不是用户会话
      if (archived.has(id)) continue; // 归档（与 GUI 一致）
      try {
        if (!(await stat(cwd)).isDirectory()) continue; // 目录已删 ⇒ 找次新
      } catch { continue; }
      return { sessionId: id, cwd };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {any} ctx
 * @param {{state:any, im:any, cards:any, nav:any, config?:object}} deps
 */
export function createSwitcher(ctx, deps) {
  const { state, im, cards, nav } = deps;
  const log = (...a) => ctx?.logger?.warn?.(...a);
  // 本模块所有 agents.create/resume（new/adopt/repair）必须挂默认 agent
  // 预设——核心工具栈与系统提示在预设 bundle 里；裸创建 ⇒ 会话只剩全局插件工具
  // （见 lib/agent-setup.js 头注）。boot-diag 通道优先，回落 ctx.logger。
  const agentSetup = makeAgentSetup(ctx, deps.log ?? log);

  /**
   * 切换主流程。调用方须已在准入闸门内（bridge 的 isAllowed 最前）。
   * @param {any} msg   ImMessage
   * @param {string} workspacePath  目标工作区路径
   * @param {{mode?: 'new'|'adopt'|'adopt-id', sessionId?:string}} [opt]
   *        new      = /new 与「新建」按钮：总是新建会话（即使已在目标工作区）
   *        adopt    = 「接管最近会话」按钮：接管**全局**最近活跃会话
   *                   （最近 = 跨工作区、按最后操作时间——宿主
   *                   sessionController.list() 活跃度序，与 GUI 侧栏同源；最近
   *                   会话在别的工作区时目标随之切换，未注册则幂等注册）。
   *                   不做幂等短路：绑定就是全局最新会话时返回 already 确认，
   *                   否则真正换绑。宿主服务缺席 ⇒ 回退目标工作区最近会话
   *                   （兼容无该服务的旧宿主）
   *        adopt-id = 「接管指定会话」选择器：接管 opt.sessionId 指定的会话
   *                   （不幂等短路——用户要的是那个会话，不是工作区）
   * @returns {Promise<Result>}
   */
  async function switchToWorkspace(msg, workspacePath, opt = {}) {
    const mode = opt.mode === 'adopt' ? 'adopt' : opt.mode === 'adopt-id' ? 'adopt-id' : 'new';
    const t0 = Date.now();
    const key = `${msg.platform}:${msg.chatId}`;

    // 群聊切换要求 admin 权限
    if (msg.chatType === 'group' && !im.map.isAdmin(msg.platform, msg.userId)) {
      return failResult('群聊切换工作区需要管理员权限。', t0, workspacePath);
    }

    // ── adopt = 「全局最近活跃会话」（跨工作区）。
    //    按钮 token 的 workspacePath（意图工作区）仅作回退目标——全局最近会话
    //    在别的工作区时，目标随之切换（结果卡显示「哪个工作区的哪个会话」，
    //    用户可核对）；其工作区未注册时由下方步骤 -1 幂等注册；工作区不可用
    //    ⇒ 回退按钮目标工作区（adoptRecent 扫描）。
    let adoptTarget = null;
    if (mode === 'adopt') {
      adoptTarget = await findGlobalNewestSession(ctx);
    }

    // ── 步骤 -1：目标可能是「有会话但未注册」的工作区（/ws 清单 = 注册表 ∪
    //    会话语料推导；adopt 还可能是全局最近会话的工作区）⇒ 切换前幂等注册
    //    （同 ensureFeishuWorkspace 的 create 语义）；已注册/目录不存在 ⇒ 不触碰。
    // ── 步骤 0：只读解析 + 幂等短路 + 目录预检 ──
    let ws = null;
    if (mode === 'adopt' && adoptTarget && adoptTarget.cwd !== workspacePath) {
      await ensureWorkspaceRegistered(ctx, adoptTarget.cwd);
      ws = await lookupWorkspace(ctx, adoptTarget.cwd);
      if (!ws) {
        log(`[feishu-pilot] adopt: 全局最近会话的工作区不可用（${adoptTarget.cwd}），回退按钮目标工作区`);
        adoptTarget = null;
      }
    }
    if (!ws) {
      await ensureWorkspaceRegistered(ctx, workspacePath);
      ws = await lookupWorkspace(ctx, workspacePath);
    }
    if (!ws) {
      return failResult(`工作区不可用（未注册或目录不存在）：${workspacePath}`, t0, workspacePath);
    }
    try {
      if (!(await stat(ws.path)).isDirectory()) {
        return failResult(`工作区目录不存在：${ws.path}`, t0, workspacePath);
      }
    } catch {
      return failResult(`工作区目录不可访问：${ws.path}`, t0, workspacePath);
    }
    const binding = im.map.get(msg.platform, msg.chatId);
    // 幂等确认只存在于 adopt（绑定已是全局最近会话 ⇒ already）；new 语义是
    // 「总要新会话」；adopt-id 要的是**具体会话**（可能同工作区不同会话）⇒ 不短路。
    // already 结果由调用方（commands.js）发灰色确认卡收尾，绝不静默——短路路径
    // 本身不发卡，否则用户停在 ⏳ 消息再无下文。

    // ── 步骤 1：空闲初查 ──
    if (binding && agentBusy(ctx, binding.sessionId)) {
      return failResult('当前会话仍在运行，请等它结束或取消后再切换。', t0, workspacePath);
    }

    // ── 步骤 3：取得目标会话（new / adopt）──
    let handle;
    let sessionId;
    try {
      if (mode === 'new') {
        sessionId = freshSessionId(ctx, msg.platform, msg.chatId);
        handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: ws.path },
          agentOptions: await buildAgentOptions(im),
          setup: agentSetup,
        });
      } else if (mode === 'adopt') {
        if (adoptTarget) {
          // ── 主路径：全局最近活跃会话（跨工作区，宿主活跃度序）──
          if (binding?.sessionId === adoptTarget.sessionId) {
            // 绑定就是全局最近会话 ⇒ 幂等确认（不得降级/换工作区）。
            // 调用方（commands.js）对 already 结果必须发灰色确认卡，绝不静默。
            return { ok: true, already: true, alreadyNote: '（当前绑定已是全局最近活跃的会话，未做改动）', sessionName: await sessionDisplayName(ctx, adoptTarget.sessionId, ws.path), fromWorkspace: ws.title, toWorkspace: ws.title, sessionId: adoptTarget.sessionId, elapsedMs: Date.now() - t0 };
          }
          // 最近会话正在运行 ⇒ 干净拒绝，**零状态变更**：必须在 attach 之前拦截
          // ——attach 之后才拦的话，中止路径的 detachSession 会把会话移出原
          // 工作区且不恢复 ⇒ 会话变「未分组」。
          const targetAgent = ctx.agents.get?.(adoptTarget.sessionId);
          if (targetAgent && targetAgent.status !== 'idle') {
            return failResult('最近会话正在运行，无法接管（未做任何改动）。请等它结束或取消后再试。', t0, workspacePath);
          }
          const adopted = await adoptOne(ctx, im, ws, adoptTarget.sessionId, binding?.sessionId ?? null);
          if (!adopted) {
            return failResult('最近会话暂不可接管（可能正在运行或恢复失败）。可改用「🔎 工作区 会话」按钮显式点选。', t0, workspacePath);
          }
          handle = adopted.handle;
          sessionId = adopted.sessionId;
        } else {
          // ── 回退：宿主 sessionController 缺席/无可用候选 ⇒ 目标工作区最近
          //    （兼容无该服务的旧宿主）──
          const adopted = await adoptRecent(ctx, im, ws, binding?.sessionId ?? null);
          if (!adopted) {
            return failResult('目标工作区没有可接管的历史会话。', t0, workspacePath);
          }
          if (adopted.already) {
            // 绑定会话就是该工作区最近的会话 ⇒ 幂等确认（不得降级到次新会话）。
            // 调用方（commands.js）对 already 结果必须发灰色确认卡，绝不静默。
            return { ok: true, already: true, alreadyNote: '（当前绑定已是该工作区最近的会话，未做改动）', sessionName: await sessionDisplayName(ctx, adopted.sessionId, ws.path), fromWorkspace: ws.title, toWorkspace: ws.title, sessionId: adopted.sessionId, elapsedMs: Date.now() - t0 };
          }
          handle = adopted.handle;
          sessionId = adopted.sessionId;
        }
      } else {
        // adopt-id：接管会话选择器点选的具体会话
        if (typeof opt.sessionId !== 'string' || opt.sessionId === '') {
          return failResult('接管指定会话：缺少会话 id（请重新 /ws）。', t0, workspacePath);
        }
        // 点选的会话正在运行 ⇒ 干净拒绝（零状态变更）：attach 之前拦截，
        // 避免中止路径的 detach 破坏会话归属。
        const pickedAgent = ctx.agents.get?.(opt.sessionId);
        if (pickedAgent && pickedAgent.status !== 'idle') {
          return failResult('该会话正在运行，无法接管（未做任何改动）。请等它结束或取消后再试。', t0, workspacePath);
        }
        const adopted = await adoptOne(ctx, im, ws, opt.sessionId, binding?.sessionId ?? null);
        if (!adopted) {
          return failResult(`会话不可接管（不存在、正在运行、不在「${ws.title}」工作区，或恢复失败）。`, t0, workspacePath);
        }
        handle = adopted.handle;
        sessionId = adopted.sessionId;
      }
    } catch (e) {
      return failResult(`创建会话失败：${e?.message ?? e}`, t0, workspacePath);
    }

    try {
      // ── 步骤 4：attach ──
      // 接管**不得修改会话名称**：自动改名（「飞书 · <工作区>」）会覆盖用户原
      // 会话名（GUI 侧栏一片「飞书 · xx」）⇒ 不做任何改名；飞书↔会话的对应
      // 关系由设置页绑定行 + 会话 ID 前缀（im-feishu-oc_xxx）表达，不动会话身份。
      // attach **之前**记录会话原工作区归属——attach 之后任何中止（步骤 5
      // 空闲重查等）都依此恢复，绝不裸 detach。
      const origWs = await workspaceContaining(ctx, sessionId);
      try {
        await ws.attachSession(sessionId);
      } catch (e) {
        throw new Error(`attachSession 失败：${e?.message ?? e}`);
      }

      // ── 步骤 5：空闲重查 ──
      if (agentBusy(ctx, sessionId)) {
        // 中止不得破坏会话的工作区归属（裸 detach 会把会话移出原工作区且
        // 永不恢复 ⇒ GUI 侧栏「未分组」）：
        //   原属目标工作区 ⇒ 只放弃换绑、不 detach（保持原样）；
        //   原属其他工作区 ⇒ detach 后重新 attach 回原工作区；
        //   原本未归属（未分组）⇒ detach 即复原原状。
        if (!origWs || origWs.path !== ws.path) {
          try { await ws.detachSession(sessionId); } catch (e) { log(`[feishu-pilot] detach on abort: ${e?.message}`); }
          if (origWs) {
            try { await origWs.attachSession(sessionId); } catch (e) { log(`[feishu-pilot] restore on abort: ${e?.message}`); }
          }
        }
        try { await handle.dispose(); } catch (e) { log(`[feishu-pilot] dispose on abort: ${e?.message}`); }
        return failResult('会话已开始运行，请稍后再试（意图未动）。', t0, workspacePath);
      }

      // ── 步骤 6：提交点（I4）：意图写入，紧邻 rebind 之前 ──
      const prev = state.getIntent(msg.platform, msg.chatId);
      await state.setIntent(msg.platform, msg.chatId, { workspacePath: ws.path, mode, switchedAt: Date.now() });

      // ── 步骤 7：换绑（双索引 + 自检 + save 回滚 + 落盘校验）──
      let old;
      try {
        old = await rebind(ctx, im, msg.platform, msg.chatId, sessionId);
      } catch (e) {
        // 提交后失败 = 显式恢复意图（不变式 I4）
        if (prev) await state.setIntent(msg.platform, msg.chatId, prev);
        else await state.clearIntent(msg.platform, msg.chatId);
        try { await handle.dispose(); } catch { /* 已尽力 */ }
        return failResult(e?.upgradeHint
          ? `换绑失败（SessionMap 结构变更）：${e?.message} —— rebind 契约与核心 SessionMap 需同步，勿重试。`
          : `换绑失败：${e?.message ?? e}`, t0, ws.path, e?.upgradeHint === true);
      }

      // ── 步骤 9：成功收尾 ──
      state.markSwitched(msg.platform, msg.chatId, sessionId); // volatile 标记
      state.bumpSwitchCount(msg.platform, msg.chatId);
      const seq = state.nextSeq();
      nav?.enqueueNav?.({
        seq,
        platform: msg.platform,
        chatId: msg.chatId,
        workspacePath: ws.path,
        sessionId,
        title: ws.title,
      });
      const result = {
        ok: true,
        fromWorkspace: old ? old.sessionId : null,
        toWorkspace: ws.path,
        toTitle: ws.title,
        sessionId,
        // 结果卡显示会话名称（哪个工作区的哪个会话），不显示裸 id
        sessionName: await sessionDisplayName(ctx, sessionId, ws.path, { isNew: mode === 'new' }),
        elapsedMs: Date.now() - t0,
      };
      await cards.sendResultCard?.(msg, result, { retryToken: opt.retryToken ?? null });
      return result;
    } catch (e) {
      // 步骤 4–5 失败（提交前）= 干净失败：意图未动；已创建的 handle 必须 dispose
      try { await handle?.dispose?.(); } catch { /* 已尽力 */ }
      return failResult(`${e?.message ?? e}`, t0, ws.path);
    }
  }

  function failResult(message, t0, toWorkspace, upgradeHint = false) {
    return { ok: false, toWorkspace: toWorkspace ?? null, sessionId: null, elapsedMs: Date.now() - t0, error: message, upgradeHint };
  }

  /**
   * 只读：会话当前归属的工作区实体（registry 成员关系，取首个命中）；
   * 无归属（未分组）/ 服务缺席 ⇒ null。供步骤 5 中止路径恢复归属用。
   */
  async function workspaceContaining(ctx_, sessionId) {
    try {
      const reg = ctx_?.workspaceRegistry;
      if (!reg || typeof reg.list !== 'function') return null;
      for (const e of reg.list() ?? []) {
        if (e?.sessionIds?.includes(sessionId)) return e;
      }
    } catch { /* best-effort */ }
    return null;
  }

  /**
   * 步骤 -1：未注册但目录存在的工作区 ⇒ 幂等注册。
   * 仅用户显式切换/接管路径调用（对账等只读路径严禁注册）。
   * create 失败/服务缺席 ⇒ 静默（步骤 0 会按「不可用」如实报错）。
   */
  async function ensureWorkspaceRegistered(ctx_, path) {
    try {
      const reg = ctx_?.workspaceRegistry;
      if (!reg || typeof reg?.resolveByPath !== 'function' || typeof reg?.create !== 'function') return;
      const existing = await reg.resolveByPath(path);
      if (existing) return; // 已注册 ⇒ 不触碰
      let isDir = false;
      try { isDir = (await stat(path)).isDirectory(); } catch { isDir = false; }
      if (!isDir) return; // 目录不存在 ⇒ 让步骤 0 报错（保持原有错误语义）
      const title = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
      await reg.create(path, title);
      log(`[feishu-pilot] 已注册会话推导工作区: ${path}（${title}）`);
    } catch (e) {
      log(`[feishu-pilot] 会话推导工作区注册失败（继续原流程）: ${e?.message}`);
    }
  }

  /**
   * adopt 回退扫描：候选 = ws.sessionIds 最新在前、排除当前绑定，逐个过
   * adoptOne（成员资格 + 存活/resume）。返回 {handle, sessionId}、
   * {already:true, sessionId}（绑定即最近会话）或 null。
   * 候选盲区：核心原生创建的历史会话从未 attach，不在候选内 ——
   * 由「接管指定会话」选择器（session-picker.js + adopt-id）覆盖。
   */
  async function adoptRecent(ctx_, im_, ws, currentSessionId) {
    const ids = ws.sessionIds ?? [];
    // 绑定会话已是工作区最近会话 ⇒ 幂等（already）。
    // 不能交给下面的 candidates 循环——它排除当前绑定，会把用户「降级」
    // 到次新会话（语义错误）。
    if (currentSessionId && ids.length > 0 && ids[0] === currentSessionId) {
      return { already: true, sessionId: currentSessionId };
    }
    const candidates = ids.filter((id) => id !== currentSessionId);
    for (const id of candidates) { // ws.sessionIds 序 = 持久化显示序（新在前）
      const r = await adoptOne(ctx_, im_, ws, id, currentSessionId);
      if (r) return r;
    }
    return null;
  }

  /**
   * adopt 单个候选（adoptRecent 扫描与 adopt-id 指定共用）：
   *   排除当前绑定；存活 agent → cwd 成员资格校验（防其 cwd 已被移走）；
   *   非存活 → header.cwd 陷阱防护（realpath 必须 = ws.path）后 resume。
   * @returns {Promise<{handle:{agent:any,dispose:()=>Promise<void>}, sessionId:string}|null>}
   */
  async function adoptOne(ctx_, im_, ws, sessionId, excludeSessionId = null) {
    if (excludeSessionId && sessionId === excludeSessionId) return null;
    const live = ctx_.agents.get?.(sessionId);
    if (live) {
      // 运行中（非 idle）的存活会话不可接管——在 attach 之前拒绝（零状态变更）：
      // 放行到步骤 5 才被拦的话，中止路径的 detachSession 已把会话移出原
      // 工作区（⇒「未分组」）。
      if (live.status !== 'idle') return null;
      // 存活 agent 也须过成员资格校验（其记录 cwd 必须解析到 ws.path）
      if (await isCwdInWorkspace(ctx_, sessionId, ws.path)) {
        return { handle: { agent: live, dispose: async () => {} }, sessionId };
      }
      return null;
    }
    const header = ctx_.get?.('sessions')?.get?.(sessionId)?.header;
    if (header && header.cwd) {
      try {
        const { realpath } = await import('node:fs/promises');
        if ((await realpath(header.cwd)) !== ws.path) return null; // cwd 陷阱防护
      } catch {
        return null;
      }
    }
    let handle;
    try {
      handle = await ctx_.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: await buildAgentOptions(im_),
        setup: agentSetup,
      });
    } catch {
      return null;
    }
    return { handle, sessionId };
  }

  async function isCwdInWorkspace(ctx_, sessionId, wsPath) {
    const { realpath } = await import('node:fs/promises');
    const raw = ctx_.get?.('sessions')?.get?.(sessionId)?.header?.cwd;
    if (!raw) return true; // 无 cwd 可读 ⇒ 成员关系已由 ws.sessionIds 保证
    try {
      return (await realpath(raw)) === wsPath;
    } catch {
      return true;
    }
  }

  /**
   * 修复路径（ensureBinding 的不一致分支）：退避闸门 → maxSessions → freshSessionId
   * → create(meta.cwd = intent.workspacePath, agentOptions 同源) → attach → rebind。
   * 成功发公告卡（避免静默建会话）；失败退避计数 +1，不吞原始错误。
   * 索引操作一律复用 rebind() helper。
   */
  async function repairToIntent(msg, intent, ws) {
    const t0 = Date.now();
    const gate = state.repairGate(msg.platform, msg.chatId);
    if (!gate.allow) {
      return { ok: false, skipped: 'cooldown', sessionId: null, elapsedMs: Date.now() - t0 };
    }
    try {
      if (im.map.size >= maxSessionsOf(im)) {
        gate.recordFailure();
        throw new Error(`会话数已达上限（${maxSessionsOf(im)}），修复暂停`);
      }
      const sessionId = freshSessionId(ctx, msg.platform, msg.chatId);
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: ws.path },
        agentOptions: await buildAgentOptions(im),
        setup: agentSetup,
      });
      let old;
      try {
        await ws.attachSession(sessionId);
        old = await rebind(ctx, im, msg.platform, msg.chatId, sessionId);
      } catch (e) {
        try { await handle.dispose(); } catch { /* best-effort */ }
        throw e; // 意图不动（仍指向目标工作区），退避计数 +1
      }
      gate.reset();
      state.markSwitched(msg.platform, msg.chatId, sessionId);
      state.bumpSwitchCount(msg.platform, msg.chatId);
      const seq = state.nextSeq();
      nav?.enqueueNav?.({
        seq,
        platform: msg.platform,
        chatId: msg.chatId,
        workspacePath: ws.path,
        sessionId,
        title: ws.title,
      });
      await cards.sendAnnounceCard?.(msg,
        `🔧 检测到绑定会话不在目标工作区「${ws.title}」，已新建会话并完成修复。`);
      return { ok: true, repaired: true, fromWorkspace: old ? old.sessionId : null, toWorkspace: ws.path, sessionId, elapsedMs: Date.now() - t0 };
    } catch (e) {
      gate.recordFailure();
      log(`[feishu-pilot] repairToIntent failed (backoff +1): ${e?.message ?? e}`);
      return { ok: false, error: e?.message ?? String(e), sessionId: null, elapsedMs: Date.now() - t0 };
    }
  }

  /**
   * /new 重定向：有意图的聊天，/new = 在意图工作区新建会话切换。
   * maxSessions 限额复制；无意图 → 返回 {passthrough:true} 由 bridge 放行原生 /new。
   */
  async function switchOrNew(msg) {
    const intent = state.getIntent(msg.platform, msg.chatId);
    if (!intent) return { passthrough: true };
    if (im.map.size >= maxSessionsOf(im)) {
      await cards.sendText?.(msg, `⛔ 会话数已达上限（${maxSessionsOf(im)}），无法新建会话。`);
      return { ok: false, error: 'maxSessions', sessionId: null, elapsedMs: 0 };
    }
    const r = await switchToWorkspace(msg, intent.workspacePath, { mode: 'new' });
    // 失败必须回执（此前 /new 被意图重定向后失败是静默的，用户以为命令没反应）
    if (!r.ok) {
      await cards.sendText?.(msg, `❌ 新建会话失败：${r.error ?? 'unknown'}\n可先在 GUI 停止当前任务后重试 /new。`);
    }
    return r;
  }

  return { switchToWorkspace, repairToIntent, switchOrNew };
}
