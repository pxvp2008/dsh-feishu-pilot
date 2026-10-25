// lib/session-picker.js —— 「接管指定会话」候选收集：列出可接管的会话，每行一个「接管」按钮
// （token 携带 sessionId + workspacePath，mode=adopt-id）。
//
// 与 GUI 会话侧栏同源（对齐语义）：
//   - 候选集 = 工作区注册表记录成员（ws.sessionIds getter 已由 DSH 按 canonical cwd 过滤）；
//     语料命中 cwd 但不在记录中的会话不列出（计 skipped）——否则会把大量未注册的遗留会话列出来。
//   - 归档会话不列出（GUI「archived sessions are excluded everywhere」）：归档不删文件，落盘语料
//     里仍有归档会话 ⇒ 按 workspaceRegistry.archivedSessionIds 过滤（作用域内计 skippedArchived）。
//   - 空白会话不列出（GUI「Blank sessions are excluded」）：取宿主 sessionController.list() summary
//     的 blank 字段；服务缺席/调用失败 ⇒ 保守放行（best effort）。
//   - 无标题会话回退「工作区目录名 · 创建时间」，绝不显示裸 id。
// 数据源（全走宿主公开服务，零补丁）：
//   ctx.get('sessionQuery').listSessions()        —— 完整语料（live 优先 + 落盘持久化，首选）；
//     宿主 sessions.list() 只返回内存存活会话（"All live sessions"）⇒ 只作兜底。
//   ctx.get('sessionQuery').readTitleSnapshots()  —— 批量标题（对落盘会话同样有效）
//   ctx.get('sessionTitle').get(session)          —— 存活会话标题兜底
//   workspaceRegistry.list()                      —— 成员资格（realpath(cwd) 命中）
//   agents.get(id)                                —— 存活状态（live/busy 徽标）
//   服务一律走 ctx.get()：cordis 的 ctx 代理对未声明 inject 的裸属性直接 throw
//   （"cannot get property X without inject"）⇒ 裸属性访问在真机必炸（被 try/catch 吞掉后静默降级）。
//
// 契约：
//   collectAdoptableSessions(ctx, scopePath?): Promise<{
//     rows: Array<{sessionId, title, wsTitle, wsPath, createdAt, live, busy}>,
//     skipped: number           // cwd 缺失/不可解析/不在已注册工作区/未注册（不在工作区记录
//                               //   sessionIds）/空白
//     skippedArchived: number   // 已归档会话（GUI 语义对齐，不列出）
//     source: 'corpus' | 'live' // 实际数据源（corpus=全量语料, live=仅存活兜底）
//   }>                          // rows 按 createdAt 降序（新在前）；rows ⊆ 工作区注册表记录成员
//   scopePath 给定 ⇒ rows 只含该工作区（realpath 或字符串命中）的会话，
//   skippedArchived 也只统计作用域内。

import { realpath } from 'node:fs/promises';

/**
 * 服务安全访问：优先 ctx.get()（ctx 真实方法，不受 inject 声明限制）；
 * 兜底裸属性（测试假件/已声明服务）——cordis 对未声明属性会 throw，被捕获。
 */
function safeGet(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const v = ctx.get(name);
      if (v) return v;
    }
  } catch { /* 未注册/无权限 ⇒ 属性兜底 */ }
  try {
    if (ctx && ctx[name]) return ctx[name];
  } catch { /* cordis: cannot get property without inject */ }
  return undefined;
}

/** 标题提取：兼容快照对象 {title,...} 与字符串形态假件。 */
function titleOf(snap) {
  if (snap && typeof snap.title === 'string') return snap.title;
  if (typeof snap === 'string') return snap;
  return '';
}

/**
 * 归档会话集（GUI 语义对齐）。
 * `workspaceRegistry.archivedSessionIds` 是 dsh-workspace 服务的 getter
 * （requireState() 未初始化时会 throw ⇒ 捕获为空集）；品牌字符串按 String 归一。
 * 导出：switcher 的全局最近会话查找复用同一过滤面。
 */
export function archivedSet(ctx) {
  let reg = undefined;
  try { if (ctx?.workspaceRegistry) reg = ctx.workspaceRegistry; } catch { /* cordis 未声明属性 */ }
  if (!reg && ctx && typeof ctx.get === 'function') {
    try { reg = ctx.get('workspaceRegistry'); } catch { /* 同上 */ }
  }
  const out = new Set();
  try {
    const list = reg?.archivedSessionIds;
    if (Array.isArray(list)) for (const id of list) out.add(String(id));
  } catch { /* 未初始化/假件无该面 ⇒ 视为无归档 */ }
  return out;
}

export async function collectAdoptableSessions(ctx, scopePath) {
  const reg = ctx.workspaceRegistry?.list?.() ?? [];
  const wsByReal = new Map(); // realpath(cwd) → ws；原路径也索引一份（realpath 失败兜底）
  for (const w of reg) {
    if (w?.path) wsByReal.set(w.path, w);
    try { wsByReal.set(await realpath(w.path), w); } catch { /* 保留原路径索引 */ }
  }

  // ── 数据源：sessionQuery 完整语料（live + 落盘）⇒ 兜底 sessions.list()（仅存活）──
  const query = safeGet(ctx, 'sessionQuery');
  let all = [];
  let source = 'live';
  if (query?.listSessions) {
    try {
      const records = await query.listSessions();
      if (Array.isArray(records) && records.length) {
        all = records.map((r) => ({ id: r?.header?.id, header: r?.header ?? {} }));
        source = 'corpus';
      }
    } catch { /* 语料读取失败 ⇒ 兜底存活列表 */ }
  }
  if (!all.length) {
    all = (safeGet(ctx, 'sessions')?.list?.() ?? []).map((s) => ({ id: s?.id, header: s?.header ?? {} }));
  }

  // 归档集（作用域过滤后统计，保证计数与展示一致）
  const archived = archivedSet(ctx);

  let rows = [];
  let skipped = 0;
  for (const s of all) {
    const cwd = s?.header?.cwd;
    if (typeof cwd !== 'string' || cwd === '') { skipped += 1; continue; }
    let rp;
    try { rp = await realpath(cwd); } catch { skipped += 1; continue; }
    const ws = wsByReal.get(rp) ?? wsByReal.get(cwd);
    if (!ws) { skipped += 1; continue; }
    // GUI 侧栏分组 = 注册表记录成员（ws.sessionIds
    // getter 已按 canonical cwd 过滤）⇒ cwd 命中但不在记录中的会话
    // （未注册的遗留旧版会话）GUI 不显示 ⇒ 选择器不列出。
    if (!ws.sessionIds?.includes?.(s.id)) { skipped += 1; continue; }
    rows.push({
      sessionId: s.id,
      title: '',
      ws: { title: ws.title, path: ws.path, real: rp },
      createdAt: typeof s.header?.createdAt === 'number' ? s.header.createdAt : 0,
      // live 兜底数据源时 s 是活体 Session（titleSvc.get 可用）；
      // corpus 数据源时 s 只是 header 记录 ⇒ 标题需按 id 取活体
      liveObj: source === 'corpus' ? undefined : s,
      archived: archived.has(s.id),
    });
  }

  // ── 作用域过滤（两段式：先选工作区，再选其下会话）──
  if (typeof scopePath === 'string' && scopePath) {
    let scopeR = scopePath;
    try { scopeR = await realpath(scopePath); } catch { /* 原样匹配 */ }
    rows = rows.filter((r) => r.ws.path === scopePath || r.ws.real === scopeR || wsByReal.get(scopeR)?.path === r.ws.path);
    skipped = 0; // 作用域内无「外部会话」概念 ⇒ 不报 skipped
  }

  // ── 归档过滤（GUI 语义对齐：归档会话不列出）──
  let skippedArchived = 0;
  if (rows.some((r) => r.archived)) {
    skippedArchived = rows.filter((r) => r.archived).length;
    rows = rows.filter((r) => !r.archived);
  }

  // ── 空白过滤（GUI 语义对齐：「Blank sessions are excluded」）──
  // 与 GUI 侧栏同源：宿主 sessionController.list() summary 的 blank 字段；
  // 服务缺席/调用失败 ⇒ 不过滤（保守放行，best effort）。
  try {
    const sc = safeGet(ctx, 'sessionController');
    if (sc?.list) {
      const res = await sc.list();
      const items = res?.items ?? (Array.isArray(res) ? res : []);
      const blank = new Set(items.filter((x) => x?.blank).map((x) => String(x?.sessionId ?? x?.id)));
      if (blank.size) {
        const n = rows.filter((r) => blank.has(r.sessionId)).length;
        if (n) { skipped += n; rows = rows.filter((r) => !blank.has(r.sessionId)); }
      }
    }
  } catch { /* 保守放行 */ }

  // ── 标题：sessionQuery 批量折叠（落盘会话有效）⇒ 存活会话 sessionTitle 兜底 ──
  const ids = rows.map((r) => r.sessionId);
  const titleMap = new Map();
  if (query?.readTitleSnapshots && ids.length) {
    try {
      const results = await query.readTitleSnapshots(ids);
      for (const res of results ?? []) {
        if (res?.status === 'fulfilled' && res.value?.title?.title) titleMap.set(res.sessionId, res.value.title.title);
      }
    } catch { /* 批量失败 ⇒ 单会话兜底 */ }
  }
  const titleSvc = safeGet(ctx, 'sessionTitle');
  const sessionsSvc = safeGet(ctx, 'sessions');
  for (const r of rows) {
    if (titleMap.has(r.sessionId)) { r.title = titleMap.get(r.sessionId); continue; }
    // 存活会话兜底（corpus 模式下 record 只有 header ⇒ 按 id 取活体；
    // live 兜底数据源下 liveObj 即 list() 返回的活体 Session）
    try {
      if (titleSvc?.get) {
        const live = r.liveObj ?? sessionsSvc?.get?.(r.sessionId);
        if (live) r.title = titleOf(titleSvc.get(live));
      }
    } catch { /* 标题是装饰，缺失不阻断 */ }
  }

  const out = rows.map((r) => {
    // 无标题回退：工作区目录名 · 创建时间（裸 id 对人是无意义的）
    let fallback = '';
    try {
      const base = r.ws.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
      const ts = r.createdAt ? new Date(r.createdAt) : null;
      fallback = base
        ? `${base} · ${ts ? `${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}` : ''}`
        : '';
    } catch { fallback = ''; }
    const live = ctx.agents?.get?.(r.sessionId);
    const { liveObj: _drop, archived: _arch, ws, sessionId, title: t, createdAt } = r;
    return {
      sessionId,
      title: t || fallback || sessionId,
      wsTitle: ws.title,
      wsPath: ws.path,
      createdAt,
      live: !!live,
      busy: !!(live && live.status !== 'idle'),
    };
  });
  out.sort((a, b) => b.createdAt - a.createdAt);
  return { rows: out, skipped, skippedArchived, source };
}
