// lib/bridge.js —— dispatchInbound / handleCallback 覆写桥：补丁面恒为 2（仅公开服务方法，
// 运行时属性查找；渠道每事件调用核心方法，覆写对其生效）。
// dispatchInbound 闸门顺序：isAllowed 永远最前 → 自定义回答拦截 → /ws、/new(有意图) → ensureBinding(只读对账) → 放行原生。

/**
 * 冻结契约：attach(ctx, im, deps) => disposer   // 覆写并返回恢复函数（幂等，可重复调用）
 * deps = { state, commands, switcher, ensureBinding, remoteApproval?, remoteQuestion? }
 * remoteApproval = { onCallback(p): Promise<void> }：缺席时 gapp:* 透传原生（原生按未知 data
 *   忽略并记日志——与未装审批模块等价）。
 * remoteQuestion = { onCallback(p): Promise<void>, onInbound(msg): Promise<{handled:boolean}> }：
 *   guq:* 缺席透传原生；onInbound 缺席/未认领 ⇒ 文本走原生管线。
 */
export function attach(ctx, im, deps) {
  const { state, commands, switcher, ensureBinding, remoteApproval, remoteQuestion } = deps;

  const origInbound = im.dispatchInbound.bind(im);
  const origCallback = im.handleCallback.bind(im);

  im.dispatchInbound = async (msg) => {
    if (!msg || typeof msg.platform !== 'string' || typeof msg.chatId !== 'string') return origInbound(msg);
    // 闸门最前：未授权一律放行给原管线 ⇒ 原生信任门接管（零状态变更）
    const allowed = im.map.isAllowed(msg.platform, msg.userId);
    if (!allowed) return origInbound(msg);
    // 群聊默认仅 @机器人 时响应（设置页「群聊仅 @ 时响应」；关闭后群内所有消息都响应）
    if (msg.chatType === 'group' && im.cfg?.security?.groupMentionRequired !== false && !msg.mentionedBot) return;
    // 自定义回答拦截——处于 awaitingCustom 态的提问认领此文本（用户已点
    // 「✍️ 自定义回答」显式表态：下一条消息即回答，不再派活/建会话）
    if (remoteQuestion) {
      try {
        const r = await remoteQuestion.onInbound?.(msg);
        if (r?.handled) return;
      } catch { /* 拦截出错 ⇒ 落到原生管线 */ }
    }
    // 自处理分支各自补 im.map.dedupe 幂等（事件与卡片回调都可能被飞书重推）
    if (commands.isWsCommand(msg?.text) && im.map.dedupe(msg.platform, msg.msgId)) {
      return commands.handleWsCommand(msg);
    }
    if (commands.isNewCommand(msg?.text) && state.hasIntent(msg) && im.map.dedupe(msg.platform, msg.msgId)) {
      const r = await switcher.switchOrNew(msg);
      if (!r.passthrough) return; // 已接管（限额拒绝/切换）；passthrough 时落到原生 /new
    }
    if (state.hasIntent(msg)) {
      await ensureBinding(ctx, {
        state,
        im,
        repair: (m, intent, ws) => switcher.repairToIntent(m, intent, ws),
        notify: (m, text) => im.push(m.platform, m.chatId, { text }).catch(() => {}),
      }, msg).catch(() => {}); // 对账失败不阻断原生派发
    }
    const isStatus = /^\/status\b/.test(String(msg?.text ?? '').trim());
    const r = await origInbound(msg);
    // /status 增强：有意图的聊天在原生输出后追加当前工作区行
    if (isStatus && state.hasIntent(msg)) {
      const intent = state.getIntent(msg.platform, msg.chatId);
      const binding = im.map.get(msg.platform, msg.chatId);
      const degraded = state.isDegraded(msg.platform, msg.chatId);
      void im.push(msg.platform, msg.chatId, {
        text: `🗂 工作区（feishu-pilot）：${intent.workspacePath}\n  会话：${binding?.sessionId ?? '未绑定'}（mode=${intent.mode}）${degraded ? ' · ⚠️ 对账降级中' : ''}`,
      }).catch(() => {});
    }
    return r;
  };

  // handleCallback 拦截顺序：ws:* → gapp:*（审批）→ guq:*（提问/计划评审）→ 其余透传原生
  // （approve/trust/retry 不受影响）
  im.handleCallback = async (p) => {
    if (p?.data?.startsWith('ws:')) {
      return commands.handleWsCallback(p);
    }
    // 任意会话飞书审批按钮回调（lib/remote-approval.js）；gapp 前缀与核心原生
    // approve 前缀互不干扰，顺序在 ws:* 之后、原生透传之前。
    if (p?.data?.startsWith('gapp:') && remoteApproval) {
      return remoteApproval.onCallback(p);
    }
    // 任意会话飞书提问/计划评审按钮回调（lib/remote-question.js）。
    if (p?.data?.startsWith('guq:') && remoteQuestion) {
      return remoteQuestion.onCallback(p);
    }
    return origCallback(p);
  };

  // 恢复：原样挂回（幂等，可重复调用）
  return () => {
    im.dispatchInbound = origInbound;
    im.handleCallback = origCallback;
  };
}
