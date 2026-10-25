// lib/agent-setup.js —— 所有建会话路径共用的 agent 预设 setup。
// 宿主 GUI 创建会话走 sessionController：agents.create({ setup: presets.mount(agentCtx, 默认预设) })
// ——核心工具栈（read/edit/pwsh/bash/web…）与系统提示都由 agent 预设 bundle 提供。
// 本插件自建/恢复 agent 的每一条路径（核心 createAgent/tryResume、
// switcher 的 new/adopt/repair）都必须传同款 setup，否则 agent 只剩
// 全局可见的插件工具、系统提示为空（真机会话日志 request/header 实录）。
// 服务缺席时静默 no-op（保持裸装配，不阻断建会话）。

import { waitForService } from './boot.js';

/**
 * @param {any} ctx 插件 Context
 * @param {(msg: string) => void} [log] 引导/审计日志（boot-diag.log 落盘）
 * @returns {(agentCtx: any, agent?: any) => Promise<void>} agents.create/resume 的 setup 回调
 */
export function makeAgentSetup(ctx, log = () => {}) {
  let presets;
  let pending = null;
  return async function agentSetup(agentCtx, agent) {
    const who = agent?.id ?? '?';
    try {
      if (presets === undefined) {
        pending ??= waitForService(ctx, 'agentPresets', 5000);
        presets = await pending;
      }
      if (!presets || typeof presets.mount !== 'function') {
        log(`agent 预设服务缺席 ⇒ ${who} 裸装配（缺核心工具栈/系统提示）`);
        return;
      }
      const resolved = typeof presets.resolve === 'function' ? await presets.resolve() : null;
      await presets.mount(agentCtx, resolved?.id);
      log(`agent 预设已挂载 ⇒ ${who}（preset=${resolved?.id ?? 'default'}）`);
    } catch (e) {
      log(`agent 预设挂载失败 ⇒ ${who}: ${e?.message ?? e}`);
    }
  };
}
