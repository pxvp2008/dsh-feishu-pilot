// dsh-feishu-pilot 浏览器半部：host 侧 dsh-client-modules 按 package.json 的 dsh.client
// 声明 + exports["./client"] 把本文件并入 web shell 模块图（factory 内可 require("react")）。
// 职责 1 导航跟随（§4.5）：轮询 nav.poll → sessions.open + layout.selectPanel，有界重试，失败 nav.fail。
// 职责 2 设置页（0.10.0）：单页「飞书远控」—— 连接 / 远程功能 / 会话 / 授权用户（含待批准）/ 高级设置。
//   控件自绘，只用 --dsw-alias-* 主题 token；不 require 任何 Harness Client 包。

window.__ModuleLoader__.load({
  id: "dsh-feishu-pilot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var CHANNEL = "/dsh-feishu-pilot";
    var ENDPOINTS = Object.freeze({
      poll: "nav.poll",
      ack: "nav.ack",
      fail: "nav.fail",
      status: "settings.status",
      unbind: "settings.unbind",
      cancelChannel: "settings.channel.cancel", // 取消飞书连接（断 WS + 清文件凭据）
      channelInfo: "settings.channel.info", // 当前机器人识别
      feishuStatus: "feishu.status", // 渠道状态 + 扫码会话状态
      qrBegin: "feishu.qr.begin",
      qrPoll: "feishu.qr.poll",
      qrCancel: "feishu.qr.cancel",
      configSet: "feishu.config.set",
      // 单一授权名单 + 待批准（0.10.0）
      users: "security.users",
      userAdd: "security.user.add",
      userRemove: "security.user.remove",
      pendingApprove: "security.pending.approve",
      pendingIgnore: "security.pending.ignore",
      autoCreateGet: "security.autoCreate.get",
      autoCreateSet: "security.autoCreate.set"
    });
    // 与 host 侧 config.nav 默认值对齐
    var POLL_MS = 2000;
    var RETRY_MAX_MS = 15000;
    var RETRY_MAX_COUNT = 8;
    var SETTINGS_POLL_MS = 5000; // 设置页轻量轮询
    var QR_POLL_MS = 1500;

    // apply 时绑定（组件 ownerProps 无注入 ⇒ 数据只能走闭包）
    var rpcCall = null; // 本插件通道（nav.* / settings.* / security.* / remote.* / feishu.*）

    // ── 完成通知黑名单（设置页编辑器 + 侧栏会话行按钮共用一份内存态）──
    // 条目 = 会话 ID（精确匹配）或会话标题片段；行按钮只对「会话 ID 精确命中」生效。
    var notifyBlacklist = { entries: null, loading: null, listeners: new Set() };

    /** 该会话是否已关闭完成通知（仅按会话 ID 精确匹配）。 */
    function isSessionMuted(entries, sessionId) {
      return Array.isArray(entries) && entries.indexOf(String(sessionId)) >= 0;
    }

    /** 开关后的新黑名单数组（纯函数，测试缝）。 */
    function nextNotifyBlacklist(entries, sessionId, enabled) {
      var list = Array.isArray(entries) ? entries.map(String) : [];
      var id = String(sessionId);
      var has = list.indexOf(id) >= 0;
      if (enabled && has) return list.filter(function (x) { return x !== id; });
      if (!enabled && !has) return list.concat([id]);
      return list;
    }

    function emitNotifyBlacklist() {
      notifyBlacklist.listeners.forEach(function (fn) { fn(); });
    }

    /** 拉取黑名单（共享单飞请求；rpc 未就绪时返回上次值）。 */
    function fetchNotifyBlacklist(force) {
      if (typeof rpcCall !== "function") return Promise.resolve(notifyBlacklist.entries || []);
      if (!force && notifyBlacklist.entries) return Promise.resolve(notifyBlacklist.entries);
      if (notifyBlacklist.loading) return notifyBlacklist.loading;
      var call = rpcCall;
      notifyBlacklist.loading = call("remote.notify.get", {})
        .then(function (res) {
          var list = res && res.ok !== false && res.value && Array.isArray(res.value.blacklist)
            ? res.value.blacklist.map(String)
            : [];
          notifyBlacklist.entries = list;
          return list;
        })
        .catch(function () { return notifyBlacklist.entries || []; })
        .then(function (list) {
          notifyBlacklist.loading = null;
          emitNotifyBlacklist();
          return list;
        });
      return notifyBlacklist.loading;
    }

    /** 行按钮/编辑器共用的 React 订阅（首次挂载拉取，变更广播）。 */
    function useNotifyBlacklist() {
      var [version, setVersion] = React.useState(0);
      React.useEffect(function () {
        var onChange = function () { setVersion(function (v) { return v + 1; }); };
        notifyBlacklist.listeners.add(onChange);
        void fetchNotifyBlacklist(false);
        return function () { notifyBlacklist.listeners.delete(onChange); };
      }, []);
      return notifyBlacklist.entries;
    }

    // ── 已绑定飞书的会话集合：绑定会话的完成卡由核心负责 ⇒ 不显示行内开关 ──
    var boundSessions = { ids: null, loading: null, listeners: new Set() };

    function emitBoundSessions() {
      boundSessions.listeners.forEach(function (fn) { fn(); });
    }

    /** 拉取当前绑定会话 ID 集合（共享单飞；rpc 未就绪 ⇒ null）。 */
    function fetchBoundSessions() {
      if (typeof rpcCall !== "function") return Promise.resolve(null);
      if (boundSessions.ids) return Promise.resolve(boundSessions.ids);
      if (boundSessions.loading) return boundSessions.loading;
      var call = rpcCall;
      boundSessions.loading = call("settings.status", {})
        .then(function (res) {
          var list = res && res.value && Array.isArray(res.value.bindings) ? res.value.bindings : [];
          boundSessions.ids = new Set(list
            .map(function (b) { return String((b && b.sessionId) || ""); })
            .filter(Boolean));
          return boundSessions.ids;
        })
        .catch(function () { return boundSessions.ids; })
        .then(function (ids) {
          boundSessions.loading = null;
          emitBoundSessions();
          return ids;
        });
      return boundSessions.loading;
    }

    function useBoundSessions() {
      var [version, setVersion] = React.useState(0);
      React.useEffect(function () {
        var onChange = function () { setVersion(function (v) { return v + 1; }); };
        boundSessions.listeners.add(onChange);
        void fetchBoundSessions();
        return function () { boundSessions.listeners.delete(onChange); };
      }, []);
      return boundSessions.ids;
    }

    /** 绑定集合判定（测试缝）。 */
    function isBoundSession(ids, sessionId) {
      return ids instanceof Set && ids.has(String(sessionId));
    }

    /** 切换某会话的完成通知（乐观更新 + 失败回滚）。 */
    function setSessionNotify(sessionId, enabled) {
      if (typeof rpcCall !== "function") return Promise.resolve();
      var prev = notifyBlacklist.entries || [];
      var next = nextNotifyBlacklist(prev, sessionId, enabled);
      notifyBlacklist.entries = next;
      emitNotifyBlacklist();
      return rpcCall("remote.notify.set", { blacklist: next })
        .then(function (res) {
          if (res && res.ok === false) throw new Error(res.error || "保存失败");
          var saved = res && res.value && Array.isArray(res.value.blacklist) ? res.value.blacklist.map(String) : next;
          notifyBlacklist.entries = saved;
          emitNotifyBlacklist();
        })
        .catch(function () {
          notifyBlacklist.entries = prev;
          emitNotifyBlacklist();
        });
    }

    // ── 导航跟随状态机（模块级单例：多标签页场景下每标签各自轮询、按 seq 去重）──
    var navState = {
      lastApplied: 0,
      attempt: null // { cmd, tries, startedAt }
    };

    function makeNav({ sessions, layout, uiWorkspace }) {
      const call = (endpoint, payload) => (rpcCall ? rpcCall(endpoint, payload) : Promise.reject(new Error("rpc not ready")));
      const openSession = (cmd) => {
        // 导航以 GUI 侧栏同源的 uiWorkspace.openSession 为准（DSH 客户端现行 API：
        // sessions 服务没有 open()，旧写法必抛 TypeError → 重试耗尽 → nav.fail）。
        // 旧壳（无 uiWorkspace 服务）才回退 sessions.open + layout.selectPanel。
        if (uiWorkspace && typeof uiWorkspace.openSession === "function") {
          uiWorkspace.openSession(cmd.sessionId);
          return;
        }
        sessions.open(cmd.sessionId);
        layout.selectPanel(null);
      };
      const tick = async () => {
        try {
          const attempt = navState.attempt;
          if (attempt) {
            // 进行中：超时判定先行
            if (Date.now() - attempt.startedAt > RETRY_MAX_MS || attempt.tries >= RETRY_MAX_COUNT) {
              try {
                await call(ENDPOINTS.fail, {
                  seq: attempt.cmd.seq,
                  chatKey: `${attempt.cmd.platform}:${attempt.cmd.chatId}`,
                  workspacePath: attempt.cmd.workspacePath,
                  reason: attempt.lastError || undefined
                });
              } catch { /* 遥测失败不影响主流程 */ }
              navState.lastApplied = attempt.cmd.seq; // 该命令已尽力，停止重试
              navState.attempt = null;
              return;
            }
            try {
              attempt.tries += 1;
              openSession(attempt.cmd);
              navState.lastApplied = attempt.cmd.seq;
              try { await call(ENDPOINTS.ack, { seq: attempt.cmd.seq }); } catch { /* 遥测 */ }
              navState.attempt = null;
            } catch (e) {
              // 打开会话抛错 = 会话尚未进入客户端目录 → 拉新目录，下一 tick 重试
              navState.attempt.lastError = String((e && e.message) || e);
              try { sessions.refresh && sessions.refresh(); } catch { /* best effort */ }
            }
            return;
          }
          const res = await call(ENDPOINTS.poll, { lastApplied: navState.lastApplied });
          if (!res?.ok) return;
          const cmd = res.value?.cmd;
          if (cmd && cmd.seq > navState.lastApplied) {
            navState.attempt = { cmd, tries: 0, startedAt: Date.now() };
            // 立即试一次（不等下一个 tick）
            try {
              navState.attempt.tries += 1;
              openSession(cmd);
              navState.lastApplied = cmd.seq;
              try { await call(ENDPOINTS.ack, { seq: cmd.seq }); } catch { /* 遥测 */ }
              navState.attempt = null;
            } catch (e) {
              navState.attempt.lastError = String((e && e.message) || e);
              try { sessions.refresh && sessions.refresh(); } catch { /* best effort */ }
            }
          }
        } catch {
          /* 轮询异常静默（连接抖动），下一 tick 继续 */
        }
      };
      const timer = setInterval(tick, POLL_MS);
      void tick(); // 首 tick 不等周期
      return () => clearInterval(timer);
    }

    // ═══════════════════════════════════════════════════════════════════
    // 设置页
    // ═══════════════════════════════════════════════════════════════════

    // ── 样式：仅 --dsw-alias-* token；类名统一 fsh- 前缀（卸载即随组件消失）──
    var CSS = [
      ".fsh-root{display:flex;flex-direction:column;gap:12px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}",
      ".fsh-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:2px 16px}",
      ".fsh-card-flush{padding:0}",
      ".fsh-hero{display:flex;align-items:flex-start;gap:12px;padding:14px 0 12px}",
      ".fsh-hero-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
      ".fsh-hero-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;flex-wrap:wrap}",
      ".fsh-hero-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}",
      ".fsh-sub{color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}",
      ".fsh-muted{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".fsh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}",
      ".fsh-id{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
      ".fsh-id:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-offset:2px}",
      ".fsh-row{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
      ".fsh-row-first{border-top:none}",
      ".fsh-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".fsh-row-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:400;flex-wrap:wrap}",
      ".fsh-row-desc{color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}",
      ".fsh-row-control{flex:0 0 auto;display:flex;align-items:center;gap:8px}",
      ".fsh-row-child{border-top:none;padding:6px 0 0}",
      ".fsh-row-child .fsh-row-main{padding-left:26px;position:relative}",
      ".fsh-row-child .fsh-row-main:before{content:'';position:absolute;left:12px;top:0;bottom:0;border-left:1px solid var(--dsw-alias-border-l2)}",
      ".fsh-row-child .fsh-row-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}",
    ".fsh-row-desc-inline{margin-left:10px;font-size:12px;line-height:16px;font-weight:400;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".fsh-row-extra{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0 2px}",
      ".fsh-seg{display:inline-flex;padding:2px;gap:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}",
      ".fsh-seg>button{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer}",
      ".fsh-seg>button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}",
      ".fsh-seg>button:disabled{opacity:.5;cursor:not-allowed}",
      ".fsh-switch{position:relative;flex:0 0 auto;width:36px;height:20px;border-radius:99px;border:none;padding:0;cursor:pointer;background:var(--dsw-alias-border-l2);transition:background .15s}",
      ".fsh-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}",
      ".fsh-switch:disabled{opacity:.5;cursor:not-allowed}",
      ".fsh-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}",
      ".fsh-switch[aria-checked=true]::after{transform:translateX(16px)}",
      ".fsh-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
      ".fsh-chipgroup{display:inline-flex;padding:2px;gap:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}",
      ".fsh-chip{font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".fsh-chip[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}",
      ".fsh-chip:hover:not(:disabled):not([aria-pressed=true]){color:var(--dsw-alias-label-primary)}",
      ".fsh-chip:disabled{opacity:.5;cursor:not-allowed}",
    ".fsh-nb{border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}",
    ".fsh-nb:hover{color:var(--dsw-alias-label-primary)}",
    ".fsh-nb:disabled{opacity:.5;cursor:not-allowed}",
      ".fsh-btn{font:inherit;font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}",
      ".fsh-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}",
      ".fsh-btn:disabled{opacity:.5;cursor:not-allowed}",
      ".fsh-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}",
      ".fsh-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.05)}",
      ".fsh-btn-danger{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-state-error,#d92d20))}",
      ".fsh-btn-danger-solid{background:#fff;color:#d92d20;border:1px solid #d92d20}",
      ".fsh-btn-danger-solid:hover:not(:disabled){background:#fef3f2}",
      ".fsh-link{border:none;background:none;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:underline;text-underline-offset:2px}",
      ".fsh-perm-warn{margin:8px 0 2px;padding:10px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:5px}",
      ".fsh-perm-title{font-size:13px;font-weight:600;color:var(--dsw-alias-state-warn-primary)}",
      ".fsh-perm-list{margin:0;padding-left:18px;font-size:12px;line-height:1.75}",
      ".fsh-perm-list code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}",
      ".fsh-perm-link{align-self:flex-start;margin-top:3px;padding:5px 12px;border-radius:7px;background:var(--dsw-alias-brand-primary);color:#fff;text-decoration:none;font-size:12px;font-weight:500}",
      ".fsh-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".fsh-pill-ok{color:var(--dsw-alias-state-success-primary)}",
      ".fsh-pill-warn{color:var(--dsw-alias-state-warn-primary)}",
      ".fsh-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto}",
      ".fsh-dot-ok{background:var(--dsw-alias-state-success-primary)}",
      ".fsh-dot-warn{background:var(--dsw-alias-state-warn-primary)}",
      ".fsh-tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}",
      ".fsh-tag-warn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-warn-primary)}",
      ".fsh-disc{width:100%;display:flex;align-items:center;gap:8px;padding:13px 16px;background:none;border:none;font:inherit;font-size:13px;font-weight:400;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}",
      ".fsh-disc-body{padding:0 16px 14px}",
      ".fsh-chev{margin-left:auto;color:var(--dsw-alias-label-secondary);transition:transform .15s;flex:0 0 auto}",
      ".fsh-disc[aria-expanded=true] .fsh-chev{transform:rotate(180deg)}",
      ".fsh-subhead{display:flex;align-items:center;gap:8px;padding:14px 0 2px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}",
      ".fsh-bind{display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
    ".fsh-muted-head{display:flex;align-items:center;gap:6px;padding:4px 0 2px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}",
    ".fsh-muted-list{display:flex;flex-direction:column;padding-left:6px}",
    ".fsh-muted-row{display:flex;align-items:center;gap:6px;padding:2px 0}",
    ".fsh-muted-dot{width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}",
    ".fsh-muted-row .fsh-muted-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-primary)}",
    ".fsh-muted-row .fsh-btn{padding:1px 8px;font-size:12px;line-height:18px}",
      ".fsh-bind:first-of-type{border-top:none}",
      ".fsh-bind-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".fsh-bind-type{flex:0 0 auto;margin-top:2px}",
      ".fsh-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:8px 0 14px}",
      ".fsh-banner{display:flex;align-items:center;gap:8px;font-size:12px;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}",
      ".fsh-banner-error{color:var(--dsw-alias-state-error-primary)}",
      ".fsh-banner-warn{color:var(--dsw-alias-state-warn-primary)}",
      ".fsh-banner-ok{color:var(--dsw-alias-state-success-primary)}",
      ".fsh-banner-info{color:var(--dsw-alias-label-secondary)}",
      ".fsh-banner-text{flex:1;min-width:0}",
      // 浮动提示：固定在视口顶部居中，保存/操作结果不再随页面滚动而看不到。
      ".fsh-toast{position:fixed;top:12px;left:0;right:0;z-index:2147483000;display:flex;justify-content:center;padding:0 16px;pointer-events:none;animation:fsh-toast-in .16s ease-out}",
      ".fsh-toast .fsh-banner{pointer-events:auto;max-width:min(560px,100%);box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.16)}",
      "@keyframes fsh-toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}",
      "@media (prefers-reduced-motion:reduce){.fsh-toast{animation:none}}",
      ".fsh-field{display:flex;flex-direction:column;gap:4px;margin-top:10px;max-width:420px}",
      ".fsh-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".fsh-input{font:inherit;font-size:12px;padding:5px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);width:100%;box-sizing:border-box}",
      ".fsh-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      ".fsh-manual{padding:0 0 14px;max-width:440px}",
      ".fsh-qr{display:flex;flex-direction:column;align-items:center;gap:8px;padding:2px 0 14px}",
      ".fsh-qr img{width:200px;height:200px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:#fff}",
      ".fsh-qr-wait{width:200px;height:200px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12px;background:var(--dsw-alias-bg-layer-2)}",
      ".fsh-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      // 高级设置行：说明在左、控件靠右（与功能行开关对齐）
      ".fsh-adv-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;flex-wrap:nowrap}",
      ".fsh-adv-ctl{display:flex;align-items:center;gap:8px;flex:0 0 auto}",
      ".fsh-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:8px}"
    ].join("\n");

    // ── 自绘控件（对齐宿主观感：行、开关、分段、折叠）──
    function Switch({ checked, onChange, disabled, label }) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": checked ? "true" : "false",
        "aria-label": label,
        className: "fsh-switch",
        disabled: !!disabled,
        onClick: () => { if (!disabled) onChange(!checked); }
      });
    }

    function Segmented({ options, value, onChange, disabled, label }) {
      return h("div", { className: "fsh-seg", role: "group", "aria-label": label },
        options.map((o) => h("button", {
          type: "button",
          key: o.value,
          "aria-pressed": value === o.value ? "true" : "false",
          disabled: !!disabled,
          onClick: () => { if (!disabled && value !== o.value) onChange(o.value); }
        }, o.label)));
    }

    function Chevron() {
      return h("svg", {
        className: "fsh-chev", width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true"
      }, h("path", {
        d: "M2.5 4.5 6 8l3.5-3.5", fill: "none", stroke: "currentColor",
        strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round"
      }));
    }

    function StateDot({ ok, warn }) {
      return h("span", { className: "fsh-dot" + (ok ? " fsh-dot-ok" : (warn ? " fsh-dot-warn" : "")), "aria-hidden": "true" });
    }

    function StatusChip({ ok, warn, text }) {
      return h("span", { className: "fsh-pill" + (ok ? " fsh-pill-ok" : (warn ? " fsh-pill-warn" : "")) },
        h(StateDot, { ok, warn }), text);
    }

    /** 两步内联确认：首点进入待确认（5s 自动复位），再点执行；不用 window.confirm。 */
    function ConfirmButton({ label, confirmLabel, danger, onConfirm, disabled, busy }) {
      var [armed, setArmed] = React.useState(false);
      React.useEffect(function () {
        if (!armed) return;
        var t = setTimeout(function () { setArmed(false); }, 5000);
        return function () { clearTimeout(t); };
      }, [armed]);
      if (!armed) {
        return h("button", {
          type: "button",
          className: "fsh-btn" + (danger ? " fsh-btn-danger" : ""),
          disabled: !!disabled,
          onClick: function () { setArmed(true); }
        }, label);
      }
      return h("span", { className: "fsh-inline" },
        h("button", {
          type: "button",
          className: "fsh-btn" + (danger ? " fsh-btn-danger-solid" : ""),
          // 内联兜底：不依赖主题危险色变量，避免白底白字
          style: danger ? { background: "#fff", color: "#d92d20", border: "1px solid #d92d20" } : undefined,
          disabled: !!busy,
          onClick: function () { setArmed(false); void onConfirm(); }
        }, busy ? "处理中…" : confirmLabel),
        h("button", {
          type: "button",
          className: "fsh-btn",
          onClick: function () { setArmed(false); }
        }, "取消"));
    }

    function Row({ title, desc, control, children, first }) {
      return h("div", { className: "fsh-row" + (first ? " fsh-row-first" : "") },
        h("div", { className: "fsh-row-main" },
          h("div", { className: "fsh-row-title" }, title),
          desc ? h("div", { className: "fsh-row-desc" }, desc) : null,
          children ?? null),
        control ? h("div", { className: "fsh-row-control" }, control) : null);
    }

    function Card({ children, flush, className }) {
      return h("div", { className: "fsh-card" + (flush ? " fsh-card-flush" : "") + (className ? " " + className : "") }, children);
    }

    function Banner({ kind, text, onDismiss, onRetry }) {
      var cls = kind === "ok" ? "fsh-banner-ok"
        : (kind === "error" ? "fsh-banner-error"
          : (kind === "warn" ? "fsh-banner-warn" : "fsh-banner-info"));
      var icon = kind === "error" || kind === "warn" ? "⚠ " : (kind === "ok" ? "✓ " : "");
      return h("div", { className: "fsh-banner " + cls, role: "status" },
        h("span", { className: "fsh-banner-text" }, icon + text),
        onRetry ? h("button", { type: "button", className: "fsh-btn", onClick: onRetry }, "重试") : null,
        onDismiss ? h("button", { type: "button", className: "fsh-link", onClick: onDismiss }, "关闭") : null);
    }

    /** 渲染兜底：子组件抛错时只替换本页，不炸掉整个设置槽。 */
    var PageBoundary = (typeof React.Component === "function")
      ? class PageBoundary extends React.Component {
        constructor(props) { super(props); this.state = { failed: false }; }
        static getDerivedStateFromError() { return { failed: true }; }
        componentDidCatch(err) {
          if (typeof console !== "undefined") console.error("[feishu-pilot] settings page crashed", err);
        }
        render() {
          if (this.state.failed) return h("div", { className: "fsh-banner fsh-banner-error" }, "设置页渲染异常，请刷新页面重试。");
          return this.props.children;
        }
      }
      : function PageBoundary({ children }) { return children; };

    // ── 纯视图逻辑（可单测；见 module.exports.__test）──

    /** 绑定行聊天类型标签（与 /status 的 private/group 对应）。 */
    function chatTypeLabel(chatType) {
      return chatType === "group" ? "群聊" : "私聊";
    }

    function channelView(status, info) {
      var connected = status?.connected === true;
      var detail = status?.detail ?? "";
      var reconnecting = !connected && /reconnecting|重连中/i.test(detail);
      var envActive = info?.envActive === true;
      var appId = info?.fileAppId ?? "";
      var phase = status?.provision?.phase ?? "idle";
      return {
        connected: connected,
        reconnecting: reconnecting,
        envActive: envActive,
        appId: appId,
        subtitle: connected ? (envActive ? "凭据来自环境变量" : "")
          : (reconnecting ? "网络恢复后会自动重连" : "绑定后即可在手机飞书里操控桌面会话"),
        detail: detail,
        provisionPhase: phase
      };
    }

    /** App ID 脱敏：首 8 + … + 末 4（≤12 位原样）。 */
    function maskAppId(id) {
      var s = String(id || "");
      return s.length <= 12 ? s : s.slice(0, 8) + "…" + s.slice(-4);
    }

    /**
     * 三功能行：开关即总开关（开 = 飞书 + GUI 双端受理；关 = 仅 GUI）。
     * 不再暴露“双端同时 / 仅 GUI”单选，避免两层配置混淆。
     */
    function featureRows(data) {
      var notify = data?.notify ?? {};
      var appr = data?.approval ?? {};
      var ques = data?.question ?? {};
      var feishuOn = function (s) {
        return !!s && s.enabled === true && s.mode !== "off" && s.mode !== "gui-first";
      };
      return [
        {
          key: "notify",
          title: "任务完成通知",
          desc: "任务结束后把结果发到飞书",
          on: !!notify.enabled,
          // includeBound 是历史遗留、Host 侧已忽略（绑定会话由核心结果卡负责），不再展示
          options: [
            { kind: "switch", key: "includeSubagents", label: "包含子智能体", on: !!notify.includeSubagents }
          ]
        },
        {
          key: "approval",
          title: "飞书审批",
          desc: "开启：飞书与 GUI 同时受理；关闭：仅 GUI",
          on: feishuOn(appr),
          pending: Number(appr.pending) || 0
        },
        {
          key: "question",
          title: "飞书提问",
          desc: "开启：飞书与 GUI 同时受理；关闭：仅 GUI",
          on: feishuOn(ques),
          pending: Number(ques.pending) || 0
        }
      ];
    }

    function patchFor(kind, action, current) {
      var cur = current || {};
      if (kind === "notify") {
        if (action.type === "toggle") return { enabled: !cur.on };
        if (action.type === "chip") {
          // Chip state lives in row.options[].on, not on the row itself; the
          // caller passes the current value so a click really flips it.
          var was = typeof action.on === "boolean" ? action.on : !!cur[action.key];
          return { [action.key]: !was };
        }
        return null;
      }
      if (kind === "approval" || kind === "question") {
        if (action.type === "toggle") {
          // 开 = 飞书 + GUI 双端；关 = 仅 GUI（不再单独选模式）
          return cur.on
            ? { enabled: false, mode: "gui-first" }
            : { enabled: true, mode: "feishu" };
        }
        if (action.type === "mode") return { mode: action.mode };
        return null;
      }
      return null;
    }

    function deriveQrView(provision) {
      var phase = provision?.phase ?? "idle";
      switch (phase) {
        case "starting":
          return { kind: "pending", text: "正在申请二维码…" };
        case "qr":
          return { kind: "qr", text: "打开飞书扫一扫", qrDataUrl: provision.qrDataUrl, qrUrl: provision.qrUrl, status: provision.pollMessage ?? "" };
        case "scanned":
          return { kind: "qr", text: "已扫码，请在手机上确认", qrDataUrl: provision.qrDataUrl, status: provision.pollMessage ?? "" };
        case "succeeded":
          return { kind: "ok", text: "绑定成功，正在连接…" };
        case "error":
          return { kind: "error", text: "申请失败：" + (provision.message || "未知错误") };
        case "expired":
          return { kind: "error", text: "二维码已过期，请重试" };
        case "cancelled":
          return { kind: "info", text: "已取消扫码" };
        case "unavailable":
          return { kind: "unavailable", text: "扫码通道不可用，请手动填写凭据" };
        default:
          return { kind: "idle", text: "" };
      }
    }

    /** 待批准行：无 name 时回退 key。 */
    function pendingRows(pending) {
      return (pending ?? []).map((p) => ({
        key: p.key,
        label: p.userName && p.userName !== p.key ? p.userName + "（" + p.key + "）" : p.key
      }));
    }

    /** Host 错误 → 用户可读文案。 */
    function errorText(res) {
      var raw = typeof res?.error === "string" ? res.error : (res?.error?.message ?? "请求失败");
      if (/core unavailable/i.test(raw)) return "核心未就绪，请稍后重试";
      if (/rpc not ready/i.test(raw)) return "配置服务未就绪，请稍后重试";
      if (/Unknown endpoint/i.test(raw)) return "插件版本不匹配，请升级插件后重试";
      if (/provision session unavailable/i.test(raw)) return "扫码通道不可用，请手动填写凭据";
      if (/bad key/i.test(raw)) return "请填写正确的 open_id（ou_ 或 feishu:ou_ 开头）";
      return raw;
    }

    // ── 数据：一次全量 + 一个轻量轮询（页根唯一 timer）──
    var READ_FULL = [
      ["feishu.status", {}, "status"],
      ["settings.channel.info", {}, "info"],
      ["settings.status", {}, "bindings"],
      ["security.users", {}, "users"],
      ["security.autoCreate.get", {}, "autoCreate"],
      ["settings.groupMention.get", {}, "groupMention"],
      ["settings.attachImages.get", {}, "attachImages"],
      ["remote.notify.get", {}, "notify"],
      ["remote.approval.get", {}, "approval"],
      ["remote.question.get", {}, "question"]
    ];
    var READ_LIGHT = [
      ["feishu.status", {}, "status"],
      ["settings.channel.info", {}, "info"],
      ["security.users", {}, "users"],
      ["settings.groupMention.get", {}, "groupMention"],
      ["settings.attachImages.get", {}, "attachImages"],
      ["remote.notify.get", {}, "notify"],
      ["remote.approval.get", {}, "approval"],
      ["remote.question.get", {}, "question"]
    ];

    function useSettingsPage(rpc) {
      var [data, setData] = React.useState(null);
      var [banner, setBanner] = React.useState(null);
      var [busy, setBusy] = React.useState({});
      var alive = React.useRef(true);
      var inflight = React.useRef(false);
      var rpcRef = React.useRef(rpc);
      rpcRef.current = rpc;

      var callRaw = async function (endpoint, payload) {
        if (typeof rpcRef.current !== "function") throw new Error("配置服务未就绪，请稍后重试");
        var res = await rpcRef.current(endpoint, payload);
        if (!res || res.ok !== true) throw new Error(errorText(res));
        return res.value;
      };

      var readMany = async function (list) {
        var results = await Promise.allSettled(list.map(function (it) { return callRaw(it[0], it[1]); }));
        var vals = {};
        var firstErr = null;
        results.forEach(function (r, i) {
          if (r.status === "fulfilled") vals[list[i][2]] = r.value;
          else if (!firstErr) firstErr = r.reason?.message ?? "加载失败";
        });
        return { vals: vals, err: firstErr };
      };

      var refresh = async function () {
        var out = await readMany(READ_FULL);
        if (alive.current) setData(out.vals);
        return out.vals;
      };

      React.useEffect(function () {
        var mounted = true;
        alive.current = true;
        void (async function () {
          try {
            var out = await readMany(READ_FULL);
            if (!mounted) return;
            setData(out.vals);
            if (out.err) setBanner({ kind: "error", text: out.err });
          } catch (e) {
            if (mounted) setBanner({ kind: "error", text: e?.message ?? "加载失败" });
          }
        })();
        var timer = setInterval(function () {
          if (inflight.current) return;
          if (typeof document !== "undefined" && document.hidden) return; // 页面不可见时不轮询
          inflight.current = true;
          readMany(READ_LIGHT)
            .then(function (out) {
              if (!mounted) return;
              setData(function (prev) { return prev ? Object.assign({}, prev, out.vals) : out.vals; });
            })
            .catch(function () { /* 抖动静默，下一轮重试 */ })
            .finally(function () { inflight.current = false; });
        }, SETTINGS_POLL_MS);
        return function () {
          mounted = false;
          alive.current = false;
          clearInterval(timer);
        };
      }, []);

      // 成功/中性提示 4s 自动消失；失败保留（需手动关闭或重试）
      React.useEffect(function () {
        if (!banner || banner.kind === "error") return;
        var t = setTimeout(function () { setBanner(null); }, 4000);
        return function () { clearTimeout(t); };
      }, [banner]);

      var run = async function (key, fn) {
        setBusy(function (prev) { var n = Object.assign({}, prev); n[key] = true; return n; });
        setBanner(null);
        try {
          var note = await fn();
          var values = await readMany(READ_FULL);
          if (alive.current) setData(values.vals);
          if (note) setBanner(typeof note === "string" ? { kind: "ok", text: note } : note);
        } catch (e) {
          try {
            var values2 = await readMany(READ_FULL);
            if (alive.current) setData(values2.vals);
          } catch { /* 刷新失败时保留旧值 */ }
          if (alive.current) setBanner({ kind: "error", text: e?.message ?? "操作失败" });
        } finally {
          setBusy(function (prev) {
            var n = Object.assign({}, prev);
            delete n[key];
            return n;
          });
        }
      };

      return { data, banner, setBanner, busy, run, call: callRaw, refresh };
    }

    // ── 连接卡：状态 + 主操作（扫码 / 断开）+ 扫码流程 + 手动凭据 ──
    function ConnectionCard({ page }) {
      var status = page.data?.status;
      var info = page.data?.info;
      var view = channelView(status, info);
      var [provision, setProvision] = React.useState(null);
      var [revealAppId, setRevealAppId] = React.useState(false);
      var [credOpen, setCredOpen] = React.useState(false);
      var [appId, setAppId] = React.useState("");
      var [secret, setSecret] = React.useState("");

      // Host 侧扫码会话状态随 feishu.status 带回（页面重开也能续上）
      React.useEffect(function () {
        var p = status?.provision;
        if (p && p.phase && p.phase !== "idle") setProvision(p);
      }, [status]);

      var phase = provision?.phase;
      React.useEffect(function () {
        if (!phase || ["starting", "qr", "scanned"].indexOf(phase) < 0) return;
        var timer = setInterval(function () {
          void (async function () {
            try {
              var p = await page.call(ENDPOINTS.qrPoll, {});
              if (["succeeded", "error", "expired", "cancelled"].indexOf(p?.phase) >= 0) {
                clearInterval(timer);
                var qrView = deriveQrView(p);
                setProvision(null);
                if (qrView.kind === "ok") {
                  page.setBanner({ kind: "ok", text: qrView.text });
                  await page.refresh();
                } else if (qrView.kind === "error") {
                  page.setBanner({ kind: "error", text: qrView.text });
                } else {
                  page.setBanner({ kind: "info", text: qrView.text });
                }
                return;
              }
              setProvision(p);
            } catch (e) {
              clearInterval(timer);
              setProvision(null);
              page.setBanner({ kind: "error", text: e?.message ?? "扫码状态获取失败" });
            }
          })();
        }, QR_POLL_MS);
        return function () { clearInterval(timer); };
      }, [phase]);

      var begin = function () {
        return page.run("qr", async function () {
          await page.call(ENDPOINTS.qrBegin, {});
          setProvision({ phase: "starting" });
          return null;
        });
      };
      var cancelQr = async function () {
        try { await page.call(ENDPOINTS.qrCancel, {}); } catch { /* 忽略 */ }
        setProvision(null);
        page.setBanner({ kind: "info", text: "已取消扫码" });
      };
      var disconnect = function () {
        return page.run("disconnect", async function () {
          var v = await page.call(ENDPOINTS.cancelChannel, {});
          setProvision(null);
          return v?.closed
            ? "已断开：凭据、绑定（" + (v.clearedBindings ?? 0) + "）与授权（" + (v.clearedUsers ?? 0) + "）已清空"
            : "当前没有活动连接";
        });
      };
      var saveCreds = function () {
        var id = String(appId).trim();
        var sec = String(secret).trim();
        if (!id || !sec) {
          page.setBanner({ kind: "error", text: "App ID 与 App Secret 都需要填写" });
          return Promise.resolve();
        }
        return page.run("creds", async function () {
          var res = await page.call(ENDPOINTS.configSet, { appId: id, appSecret: sec });
          setSecret("");
          setCredOpen(false);
          if (!res?.reconnected) {
            throw new Error("凭据已保存，但连接失败：请检查 App ID / Secret 或应用权限");
          }
          return "凭据已保存，已连接新机器人";
        });
      };

      var qr = deriveQrView(provision);
      var connecting = phase === "starting" || phase === "qr" || phase === "scanned";
      var manualAllowed = !connecting;

      var actions = "";
      if (view.connected) {
        actions = h(ConfirmButton, {
          label: "断开连接",
          confirmLabel: "确认断开并清空",
          danger: true,
          busy: !!page.busy.disconnect,
          onConfirm: disconnect
        });
      } else if (view.reconnecting) {
        actions = h("button", { type: "button", className: "fsh-btn", disabled: true }, "重连中…");
      } else if (connecting) {
        actions = h("button", { type: "button", className: "fsh-btn", onClick: () => void cancelQr() }, "取消扫码");
      } else {
        if (view.provisionPhase !== "unavailable") {
          actions = h("button", {
            type: "button",
            className: "fsh-btn fsh-btn-primary",
            disabled: !!page.busy.qr,
            onClick: () => void begin()
          }, page.busy.qr ? "申请中…" : "扫码连接");
        }
        if (manualAllowed) {
          actions = h(React.Fragment, null, actions,
            h("button", { type: "button", className: "fsh-btn", onClick: () => setCredOpen(!credOpen) }, "手动填写凭据"));
        }
      }

      var inlineId = "";
      if (view.connected) {
        if (view.envActive) inlineId = "凭据来自环境变量";
        else if (view.appId) {
          inlineId = h("button", {
            type: "button",
            className: "fsh-id",
            "aria-expanded": revealAppId ? "true" : "false",
            title: revealAppId ? "点击收起" : "点击显示完整 App ID",
            onClick: () => setRevealAppId(!revealAppId)
          }, revealAppId ? view.appId : maskAppId(view.appId));
        }
      }

      var qrArea = null;
      if (qr.kind === "pending") {
        qrArea = h("div", { className: "fsh-qr" }, h("div", { className: "fsh-qr-wait" }, qr.text));
      } else if (qr.kind === "qr") {
        qrArea = h("div", { className: "fsh-qr" },
          h("div", { className: "fsh-sub" }, qr.text),
          qr.qrDataUrl
            ? h("img", { src: qr.qrDataUrl, alt: "飞书扫码" })
            : (qr.qrUrl
              ? h("a", { href: qr.qrUrl, target: "_blank", rel: "noreferrer" }, "打开扫码链接")
              : h("div", { className: "fsh-muted" }, "二维码获取中…")),
          qr.status ? h("div", { className: "fsh-muted" }, qr.status) : null);
      }

      return h(Card, null,
        h("div", { className: "fsh-hero" },
          h("div", { className: "fsh-hero-main" },
            h("div", { className: "fsh-hero-title" },
              "飞书机器人",
              h(StatusChip, {
                ok: view.connected,
                warn: view.reconnecting,
                text: view.connected ? "已连接" : (view.reconnecting ? "重连中" : "未连接")
              }),
              inlineId ? h("span", { className: "fsh-muted", style: { fontWeight: 400 } }, inlineId) : null),
            view.subtitle ? h("div", { className: "fsh-sub" }, view.subtitle) : null),
          h("div", { className: "fsh-hero-actions" }, actions)),

        credOpen && manualAllowed
          ? h("div", { className: "fsh-manual" },
            h("div", { className: "fsh-field" },
              h("label", { className: "fsh-field-label" }, "App ID"),
              h("input", {
                className: "fsh-input",
                value: appId,
                placeholder: "cli_...",
                autoComplete: "off",
                onChange: (e) => setAppId(e.target.value)
              })),
            h("div", { className: "fsh-field" },
              h("label", { className: "fsh-field-label" }, "App Secret"),
              h("input", {
                className: "fsh-input",
                type: "password",
                value: secret,
                placeholder: "••••••••",
                autoComplete: "new-password",
                onChange: (e) => setSecret(e.target.value)
              })),
            h("div", { className: "fsh-actions" },
              h("button", {
                type: "button",
                className: "fsh-btn",
                disabled: !!page.busy.creds,
                onClick: () => void saveCreds()
              }, page.busy.creds ? "保存中…" : "保存凭据"),
              h("span", { className: "fsh-muted" }, "保存后自动连接；环境变量凭据优先")))
          : null,

        qrArea);
    }

    // ── 侧栏会话行内「完成通知」开关（注册到壳公开插槽，不修改 DSH 源码）──
    var TIP_DELAY_MS = 500;

    function hideRowTip(el) {
      if (!el || !el.__fshTip) return;
      el.__fshTip.remove();
      el.__fshTip = null;
    }

    /** 壳 Tooltip 同款气泡（fixed 定位、下方右对齐、500ms 延迟；portal 到 body 避免被侧栏滚动裁剪）。 */
    function showRowTip(el, text) {
      if (typeof document === "undefined" || !el) return;
      hideRowTip(el);
      var tip = document.createElement("div");
      tip.className = "fsh-tip";
      tip.textContent = text;
      document.body.appendChild(tip);
      var r = el.getBoundingClientRect();
      tip.style.left = Math.round(r.right) + "px";
      tip.style.top = Math.round(r.bottom + 6) + "px";
      tip.style.transform = "translateX(-100%)";
      // 左边界兜底：气泡不能超出窗口/侧栏左侧（宽度已限 220px）
      var rect = tip.getBoundingClientRect();
      if (rect.left < 8) {
        tip.style.transform = "none";
        tip.style.left = "8px";
      }
      el.__fshTip = tip;
    }

    /** 行内图标按钮样式（与壳 Rows.module.css 的 iconButton 同规格；CSS 由 apply 全局注入）。 */
    function ensureRowButtonCss() {
      if (typeof document === "undefined" || !document.head) return;
      if (document.getElementById("dsh-feishu-pilot-row-css")) return;
      var tag = document.createElement("style");
      tag.id = "dsh-feishu-pilot-row-css";
      tag.textContent = [
        ".fsh-nb{appearance:none;-webkit-appearance:none;box-sizing:border-box;border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;margin:0;font:inherit;display:inline-flex;line-height:1}",
        ".fsh-nb:hover{color:var(--dsw-alias-label-primary)}",
        ".fsh-nb:disabled{opacity:.5;cursor:not-allowed}",
        ".fsh-tip{position:fixed;z-index:1100;width:max-content;max-width:min(220px,50vw);padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:normal;overflow-wrap:break-word;pointer-events:none;animation:fsh-tip-in .15s ease-in-out}",
        "@keyframes fsh-tip-in{from{opacity:0}to{opacity:1}}"
      ].join("");
      document.head.appendChild(tag);
    }

    /** 线性铃铛图标（14px，与「归档会话」按钮同款描边/尺寸/取色）。 */
    function BellIcon({ off }) {
      return h("svg", {
        viewBox: "0 0 24 24",
        width: 14,
        height: 14,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true"
      },
      h("path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" }),
      h("path", { d: "M13.7 21a2 2 0 0 1-3.4 0" }),
      off ? h("path", { d: "M3 3l18 18" }) : null);
    }

    function SessionNotifyRowButton({ sessionId, displayTitle }) {
      var entries = useNotifyBlacklist();
      var bound = useBoundSessions();
      // 绑定会话的完成卡由核心结果卡负责（原设计边界）⇒ 不显示开关；未就绪时也不渲染，避免误导
      if (bound === null || isBoundSession(bound, sessionId)) return null;
      var muted = isSessionMuted(entries, sessionId);
      var label = (muted ? "开启" : "关闭") + "完成通知";
      return h("button", {
        type: "button",
        className: "fsh-nb",
        "aria-label": label,
        "aria-pressed": muted ? "false" : "true",
        onMouseEnter: function (e) {
          var el = e.currentTarget;
          hideRowTip(el);
          el.__fshTipTimer = setTimeout(function () { el.__fshTipTimer = null; showRowTip(el, label); }, TIP_DELAY_MS);
        },
        onMouseLeave: function (e) {
          var el = e.currentTarget;
          if (el.__fshTipTimer) { clearTimeout(el.__fshTipTimer); el.__fshTipTimer = null; }
          hideRowTip(el);
        },
        onClick: function (e) {
          e.preventDefault();
          e.stopPropagation();
          hideRowTip(e.currentTarget);
          void setSessionNotify(sessionId, muted);
        },
        onBlur: function (e) { hideRowTip(e.currentTarget); }
      }, h(BellIcon, { off: muted }));
    }

    // ── 已关闭通知的会话（来自会话行铃铛；设置页一键恢复）──
    function MutedSessions({ page }) {
      var items = page.data?.notify?.blacklistItems ?? [];
      var raw = page.data?.notify?.blacklist ?? [];
      if (!items.length) return null;
      var enable = function (id) {
        var next = raw.filter(function (x) { return String(x) !== String(id); });
        return page.run("notify:muted:" + id, async function () {
          await page.call("remote.notify.set", { blacklist: next });
          return "已恢复完成通知";
        });
      };
      return h("div", { className: "fsh-row fsh-row-child" },
        h("div", { className: "fsh-row-main" },
          h("div", { className: "fsh-muted-head" }, "已关闭通知的会话",
            h("span", { className: "fsh-tag" }, String(items.length))),
          h("div", { className: "fsh-muted-list" },
            items.map(function (it) {
              return h("div", { className: "fsh-muted-row", key: it.id },
                h("span", { className: "fsh-muted-dot" }),
                h("div", { className: "fsh-muted-title", title: it.id }, it.title),
                h("button", {
                  type: "button",
                  className: "fsh-btn",
                  disabled: !!page.busy["notify:muted:" + it.id],
                  onClick: function () { void enable(it.id); }
                }, "开启"));
            }))));
    }

    // ── 远程功能：3 行 × 真开关（审批/提问带双端-仅GUI 分段；通知带两个范围 chip）──
    function FeaturesCard({ page }) {
      var rows = featureRows(page.data);
      var users = page.data?.users?.users ?? [];
      var anyOn = rows.some(function (r) { return r.on; });
      var channelOk = page.data?.status?.connected === true;
      var warnings = [];
      if (anyOn && page.data && !channelOk) warnings.push("飞书未连接，暂不推送");
      if (rows[0]?.on && page.data && users.length === 0) warnings.push("未设置授权用户，通知不可达");

      var feedbackFor = function (row, action) {
        if (row.key === "notify") {
          if (action.type === "toggle") return row.on ? "已关闭：任务完成通知" : "已开启：任务完成通知";
          return action.on ? "已关闭：含子智能体" : "已开启：含子智能体";
        }
        if (row.key === "approval") {
          return row.on ? "已关闭：飞书审批（仅 GUI）" : "已开启：飞书审批（飞书与 GUI 同时受理）";
        }
        if (row.key === "question") {
          return row.on ? "已关闭：飞书提问（仅 GUI）" : "已开启：飞书提问（飞书与 GUI 同时受理）";
        }
        return "已保存";
      };

      var apply = function (row, action) {
        var patch = patchFor(row.key, action, row);
        if (!patch) return Promise.resolve();
        var key = row.key + ":" + (action.type === "chip" ? action.key : action.type);
        var endpoint = "remote." + row.key + ".set";
        return page.run(key, async function () {
          await page.call(endpoint, patch);
          return feedbackFor(row, action);
        });
      };

      return h(Card, null,
        h("div", { className: "fsh-row fsh-row-first" },
          h("div", { className: "fsh-row-main" }, h("div", { className: "fsh-row-title" }, "远程功能")),
          warnings.length
            ? h("div", { className: "fsh-row-control" }, h("span", { className: "fsh-muted" }, warnings.join("；")))
            : null),
        rows.map(function (row) {
          // Chips share the matrix track/selected style with the mode segmented
          // control, so every multi/one-choice control looks the same.
          var chips = (row.options ?? []).filter(function (op) { return op.kind === "chip"; })
            .map(function (op) {
              return h("button", {
                type: "button",
                key: op.key,
                className: "fsh-chip",
                "aria-pressed": op.on ? "true" : "false",
                disabled: !!page.busy[row.key + ":" + op.key],
                onClick: function () { void apply(row, { type: "chip", key: op.key, on: op.on }); }
              }, (op.on ? "✓ " : "") + op.label);
            });

          var childRows = row.on
            ? (row.options ?? []).filter(function (op) { return op.kind === "switch"; })
              .map(function (op) {
                return h("div", { className: "fsh-row fsh-row-child", key: "child:" + op.key },
                  h("div", { className: "fsh-row-main" },
                    h("div", { className: "fsh-row-title" }, op.label)),
                  h("div", { className: "fsh-row-control" },
                    h(Switch, {
                      checked: op.on,
                      label: op.label,
                      disabled: !!page.busy[row.key + ":" + op.key],
                      onChange: function () { void apply(row, { type: "chip", key: op.key, on: op.on }); }
                    })));
              })
            : [];
          // 「已关闭通知的会话」= 任务完成通知的子项（紧跟「包含子智能体」）
          if (row.key === "notify" && row.on) childRows.push(h(MutedSessions, { page, key: "muted" }));

          return h(React.Fragment, { key: row.key },
            h("div", { className: "fsh-row" },
              h("div", { className: "fsh-row-main" },
                h("div", { className: "fsh-row-title" }, row.title,
                  row.pending > 0 ? h("span", { className: "fsh-tag fsh-tag-warn" }, row.pending + " 个待处理") : null,
                  row.desc ? h("span", { className: "fsh-row-desc-inline" }, row.desc) : null),
                row.on && chips.length
                  ? h("div", { className: "fsh-row-extra" },
                    h("div", { className: "fsh-chipgroup" }, chips))
                  : null),
              h("div", { className: "fsh-row-control" },
                h(Switch, {
                  label: row.title,
                  checked: row.on,
                  disabled: !!page.busy[row.key + ":toggle"],
                  onChange: function () { void apply(row, { type: "toggle" }); }
                }))),
            childRows);
        }));
    }

    // ── 会话：自动建会话开关 + 飞书绑定清单 ──
    function SessionsCard({ page }) {
      var bindings = page.data?.bindings?.bindings ?? [];
      var autoCreate = page.data?.autoCreate?.enabled;

      var unbind = function (chatKey) {
        return page.run("unbind:" + chatKey, async function () {
          await page.call(ENDPOINTS.unbind, { chatKey });
          return "已解绑 " + chatKey;
        });
      };

      return h(Card, null,
        h(Row, {
          first: true,
          title: "新聊天自动建会话",
          desc: "首条消息自动新建会话；关闭后需先发 /new",
          control: h(Switch, {
            label: "新聊天自动建会话",
            checked: autoCreate === true,
            disabled: autoCreate === undefined || !!page.busy.autocreate,
            onChange: function (v) {
              void page.run("autocreate", async function () {
                await page.call(ENDPOINTS.autoCreateSet, { enabled: v });
                return v ? "已开启：首条消息自动建会话" : "已关闭：需要先发 /new";
              });
            }
          })
        }),
        h("div", { className: "fsh-subhead" }, "飞书绑定",
          h("span", { className: "fsh-tag" }, bindings.length ? bindings.length + " 个" : "无")),
        bindings.length === 0
          ? h("div", { className: "fsh-empty" }, "还没有绑定。在飞书里发 /ws 选择工作区即可。")
          : bindings.map(function (b) {
            var ws = b.workspaceTitle || b.workspacePath || "未设置工作区";
            var title = (b.sessionTitle || "未命名会话");
            return h("div", { className: "fsh-bind", key: b.chatKey },
              h("span", { className: "fsh-tag fsh-bind-type" }, chatTypeLabel(b.chatType)),
              h("div", { className: "fsh-bind-main" },
                h("div", { className: "fsh-row-title", title: b.chatKey + " · " + (b.sessionId ?? "") },
                  title,
                  b.degraded ? h("span", { className: "fsh-tag fsh-tag-warn" }, "工作区不可用") : null),
                h("div", { className: "fsh-row-desc", title: b.chatKey + " · " + (b.sessionId ?? "") },
                  "工作区：" + ws)),
              h(ConfirmButton, {
                label: "解绑",
                confirmLabel: "确认解绑",
                danger: true,
                busy: !!page.busy["unbind:" + b.chatKey],
                onConfirm: function () { return unbind(b.chatKey); }
              }));
          }));
    }

    // ── 授权用户（折叠）：待批准 + 单一名单（第一条 = 当前用户）──
    function UsersCard({ page }) {
      var [open, setOpen] = React.useState(false);
      var [draft, setDraft] = React.useState("");
      var autoOpened = React.useRef(false);
      var users = page.data?.users?.users ?? [];
      var pending = page.data?.users?.pending ?? [];

      // 首次拿到数据：名单为空或有待批准时自动展开
      React.useEffect(function () {
        if (!page.data || autoOpened.current) return;
        autoOpened.current = true;
        var list = page.data?.users?.users ?? [];
        var pend = page.data?.users?.pending ?? [];
        if (!list.length || pend.length) setOpen(true);
      }, [page.data]);

      var approve = function (key) {
        var row = pendingRows(pending).find(function (r) { return r.key === key; });
        return page.run("pending:" + key, async function () {
          await page.call(ENDPOINTS.pendingApprove, { key });
          return "已批准 " + (row?.label ?? key);
        });
      };
      var ignore = function (key) {
        var row = pendingRows(pending).find(function (r) { return r.key === key; });
        return page.run("pending:" + key, async function () {
          await page.call(ENDPOINTS.pendingIgnore, { key });
          return "已忽略 " + (row?.label ?? key);
        });
      };
      var add = function () {
        var key = String(draft).trim();
        if (!key) return Promise.resolve();
        return page.run("user:add", async function () {
          var v = await page.call(ENDPOINTS.userAdd, { key });
          setDraft("");
          return v?.existed
            ? { kind: "warn", text: "已存在：" + key }
            : "已添加 " + key;
        });
      };
      var remove = function (key) {
        return page.run("user:" + key, async function () {
          await page.call(ENDPOINTS.userRemove, { key });
          return "已移除 " + key;
        });
      };

      var pendingBlock = pending.length
        ? h(React.Fragment, null,
          h("div", { className: "fsh-subhead", style: { borderTop: "none", paddingTop: 2 } }, "待批准"),
          pendingRows(pending).map(function (p) {
            return h("div", { className: "fsh-bind", key: p.key },
              h("div", { className: "fsh-bind-main" }, h("div", { className: "fsh-row-title" }, p.label)),
              h("button", {
                type: "button",
                className: "fsh-btn fsh-btn-primary",
                disabled: !!page.busy["pending:" + p.key],
                onClick: function () { void approve(p.key); }
              }, "批准"),
              h("button", {
                type: "button",
                className: "fsh-btn",
                disabled: !!page.busy["pending:" + p.key],
                onClick: function () { void ignore(p.key); }
              }, "忽略"));
          }))
        : null;

      return h("div", { className: "fsh-card fsh-card-flush" },
        h("button", {
          type: "button",
          className: "fsh-disc",
          "aria-expanded": open ? "true" : "false",
          onClick: function () { setOpen(!open); }
        },
        "授权用户",
        h("span", { className: "fsh-muted", style: { fontWeight: 400 } }, users.length ? users.length + " 位" : "未设置"),
        pending.length ? h("span", { className: "fsh-tag fsh-tag-warn" }, pending.length + " 个待批准") : null,
        h(Chevron)),
        open
          ? h("div", { className: "fsh-disc-body" },
            pendingBlock,
            h("div", { className: "fsh-subhead" }, "授权用户"),
            users.length === 0
              ? h("div", { className: "fsh-empty", style: { color: "var(--dsw-alias-state-warn-primary)" } },
                "还没有授权用户，飞书消息会被拒绝。先把自己加进来。")
              : users.map(function (u) {
                return h("div", { className: "fsh-bind", key: u.key },
                  h("div", { className: "fsh-bind-main" },
                    h("div", { className: "fsh-row-title" }, u.key,
                      u.owner ? h("span", { className: "fsh-tag" }, "当前用户") : null)),
                  u.owner ? null : h(ConfirmButton, {
                    label: "移除",
                    confirmLabel: "确认移除",
                    danger: true,
                    busy: !!page.busy["user:" + u.key],
                    onConfirm: function () { return remove(u.key); }
                  }));
              }),
            h("div", { className: "fsh-inline", style: { paddingTop: 8 } },
              h("input", {
                className: "fsh-input",
                style: { maxWidth: 280 },
                value: draft,
                placeholder: "ou_xxx 或 feishu:ou_xxx",
                autoComplete: "off",
                "aria-label": "新增授权用户 open_id",
                onChange: function (e) { setDraft(e.target.value); },
                onKeyDown: function (e) { if (e.key === "Enter") void add(); }
              }),
              h("button", {
                type: "button",
                className: "fsh-btn",
                disabled: !!page.busy["user:add"] || !String(draft).trim(),
                onClick: function () { void add(); }
              }, page.busy["user:add"] ? "添加中…" : "添加")))
          : null);
    }

    // ── 高级设置（折叠）：群聊 @ 策略 + 图片 + 审批/提问有效期 ──
    function AdvancedCard({ page, open, onToggle }) {
      var [draft, setDraft] = React.useState(null);
      var [grantUrl, setGrantUrl] = React.useState(null);
      var saved = Number(page.data?.approval?.timeoutSec) || 300;
      var value = draft !== null ? draft : String(saved);
      var mentionRequired = page.data?.groupMention?.required !== false;
      var attachImages = page.data?.attachImages?.enabled === true;

      var save = function () {
        var seconds = Number(String(value).trim());
        if (!Number.isFinite(seconds) || seconds < 30 || seconds > 3600 || Math.floor(seconds) !== seconds) {
          page.setBanner({ kind: "error", text: "有效期需为 30–3600 之间的整数秒" });
          return Promise.resolve();
        }
        return page.run("timeout", async function () {
          await page.call("remote.approval.set", { timeoutSec: seconds });
          await page.call("remote.question.set", { timeoutSec: seconds });
          setDraft(null);
          return "已保存：有效期 " + seconds + " 秒";
        });
      };

      var toggleMention = function () {
        return page.run("groupMention", async function () {
          var next = !mentionRequired;
          var v = await page.call("settings.groupMention.set", { required: next });
          if (next) {
            setGrantUrl(null);
            return "已开启：群聊仅 @ 时响应";
          }
          var granted = v?.groupMsgGranted;
          if (granted === false || granted === null) {
            setGrantUrl(v?.grantUrl || "");
            return {
              kind: "warn",
              text: granted === false
                ? "已关闭仅 @：未开通 im:message.group_msg，群内非 @ 消息不会到达"
                : "已关闭仅 @：无法自动确认 im:message.group_msg 权限，请检查",
            };
          }
          setGrantUrl(null);
          return "已关闭：群内消息都会响应";
        });
      };

      var toggleImages = function () {
        return page.run("attachImages", async function () {
          var next = !attachImages;
          await page.call("settings.attachImages.set", { enabled: next });
          return next ? "已开启：飞书图片会进入模型" : "已关闭：图片只显示为 [图片]";
        });
      };

      var mentionInfo = page.data?.groupMention;
      var mentionGrantMissing = !mentionRequired
        && (mentionInfo?.groupMsgGranted === false || mentionInfo?.groupMsgGranted === null);
      var shownGrantUrl = mentionGrantMissing ? (grantUrl || mentionInfo?.grantUrl || "") : "";

      return h("div", { className: "fsh-card fsh-card-flush" },
        h("button", {
          type: "button",
          className: "fsh-disc",
          "aria-expanded": open ? "true" : "false",
          onClick: onToggle
        }, "高级设置", h(Chevron)),
        open
          ? h("div", { className: "fsh-disc-body" },
            h("div", { className: "fsh-adv-row" },
              h("label", { className: "fsh-field-label" }, "群聊仅 @ 时响应"),
              h("div", { className: "fsh-adv-ctl" }, h(Switch, {
                checked: mentionRequired,
                disabled: !!page.busy.groupMention,
                label: "群聊仅 @ 时响应",
                onChange: function () { void toggleMention(); }
              }))),
            h("div", { className: "fsh-muted", style: { paddingTop: 4 } },
              "关闭后群内任意消息都会响应。"),
            shownGrantUrl
              ? h("div", { className: "fsh-perm-warn" },
                h("div", { className: "fsh-perm-title" },
                  mentionInfo?.groupMsgGranted === false ? "⚠️ 群消息权限未开通" : "⚠️ 群消息权限未确认"),
                h("div", { className: "fsh-row-desc" },
                  mentionInfo?.selfManageGranted === true
                    ? "扫码时已自动申请应用信息权限，这里只需再勾选 1 项："
                    : "关闭「仅 @」后，需在飞书开放平台同时勾选以下 2 项权限："),
                h("ul", { className: "fsh-perm-list" },
                  h("li", null,
                    "获取群组中所有消息（敏感权限）",
                    h("code", null, "im:message.group_msg")),
                  mentionInfo?.selfManageGranted === true
                    ? null
                    : h("li", null,
                      "管理应用自身资源",
                      h("code", null, "application:application:self_manage"),
                      "（用于自动检查权限）")),
                h("a", {
                  className: "fsh-perm-link",
                  href: shownGrantUrl,
                  target: "_blank",
                  rel: "noreferrer",
                }, mentionInfo?.selfManageGranted === true
                  ? "去飞书开通（勾选 1 项）"
                  : "去飞书开通（两项都勾选）"))
              : null,
            h("div", { className: "fsh-adv-row" },
              h("label", { className: "fsh-field-label" }, "接收飞书图片"),
              h("div", { className: "fsh-adv-ctl" }, h(Switch, {
                checked: attachImages,
                disabled: !!page.busy.attachImages,
                label: "接收飞书图片",
                onChange: function () { void toggleImages(); }
              }))),
            h("div", { className: "fsh-muted", style: { paddingTop: 4 } },
              "图片会进入模型，消耗更多 token。"),
            h("div", { className: "fsh-adv-row" },
              h("label", { className: "fsh-field-label" }, "审批 / 提问有效期"),
              h("div", { className: "fsh-adv-ctl" },
                h("input", {
                  className: "fsh-input",
                  style: { width: 96 },
                  inputMode: "numeric",
                  value: value,
                  onChange: function (e) { setDraft(e.target.value); }
                }),
                h("span", { className: "fsh-muted" }, "秒"),
                h("button", {
                  type: "button",
                  className: "fsh-btn",
                  disabled: !!page.busy.timeout,
                  onClick: function () { void save(); }
                }, page.busy.timeout ? "保存中…" : "保存"))),
            h("div", { className: "fsh-muted", style: { paddingTop: 4 } },
              "超时后飞书卡片失效，只保留 GUI 处理（30–3600 秒）。"))
          : null);
    }

    // ── 页面装配 ──
    function FeishuSection() {
      var [advOpen, setAdvOpen] = React.useState(false);
      var page = useSettingsPage(rpcCall);

      if (typeof rpcCall !== "function") {
        return h("div", { className: "fsh-root" },
          h("style", null, CSS),
          h(Card, null,
            h("div", { className: "fsh-hero" },
              h("div", { className: "fsh-hero-main" },
                h("div", { className: "fsh-hero-title" }, "飞书机器人"),
                h("div", { className: "fsh-sub" }, "配置服务未就绪，请稍后重试")))));
      }

      return h(PageBoundary, null,
        h("div", { className: "fsh-root" },
          h("style", null, CSS),
          page.banner
            ? h("div", { className: "fsh-toast" },
              h(Banner, {
                kind: page.banner.kind,
                text: page.banner.text,
                onDismiss: function () { page.setBanner(null); },
                onRetry: page.banner.kind === "error" ? function () { void page.refresh(); } : undefined
              }))
            : null,
          h(ConnectionCard, { page }),
          h(FeaturesCard, { page }),
          h(SessionsCard, { page }),
          h(UsersCard, { page }),
          h(AdvancedCard, { page, open: advOpen, onToggle: function () { setAdvOpen(!advOpen); } })));
    }

    var name = "dsh-feishu-pilot";
    // inject 里的 token 均为客户端已 provide 的服务，缺任何一个都会让插件永久 park。
    var inject = ["slots", "connection", "sessions", "layout", "uiWorkspace"];

    // 飞书品牌图标（Semi Design feishu_logo，MIT；官方字形，仅改品牌色）。
    var FEISHU_LOGO_MASK = "data:image/png;base64,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";

    /**
     * 设置页导航图标由壳按 section id 固定映射，未知 id 回退齿轮；
     * 插件不修改壳，只把自己那一行的齿轮替换为飞书品牌图标。
     */
    function installFeishuNavIcon(ctx) {
      if (typeof document === "undefined" || !document.body) return;
      var patch = function () {
        var buttons = document.querySelectorAll("button");
        for (var i = 0; i < buttons.length; i += 1) {
          var btn = buttons[i];
          var label = String(btn.textContent || "").replace(/\s+/g, "");
          if (label !== "飞书远控" || btn.getAttribute("data-fsh-nav-icon") === "1") continue;
          var svg = btn.querySelector("svg");
          if (!svg) continue;
          var icon = document.createElement("span");
          icon.setAttribute("class", svg.getAttribute("class") || "");
          icon.style.width = "16px";
          icon.style.height = "16px";
          icon.style.flex = "none";
          icon.style.display = "inline-block";
          icon.style.backgroundColor = "currentColor";
          icon.style.webkitMask = "url(" + FEISHU_LOGO_MASK + ") center / contain no-repeat";
          icon.style.mask = "url(" + FEISHU_LOGO_MASK + ") center / contain no-repeat";
          svg.replaceWith(icon);
          btn.setAttribute("data-fsh-nav-icon", "1");
        }
      };
      patch();
      var observer = new MutationObserver(function () { patch(); });
      observer.observe(document.body, { childList: true, subtree: true });
      if (ctx && ctx.effect) {
        ctx.effect(function () { return function () { observer.disconnect(); }; }, "feishu-pilot: nav icon");
      }
    }

    function apply(ctx) {
      // 闭包绑定 RPC（组件 ownerProps 无注入；makeNav 与设置页共用同一句柄）
      if (ctx.connection && ctx.connection.rpc && typeof ctx.connection.rpc.call === "function") {
        rpcCall = (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload);
      }
      // 导航跟随：uiWorkspace（DSH 现行）或 sessions/layout（旧壳）任一可用即可；都缺则静默降级
      const sessions = ctx.get ? ctx.get("sessions") : undefined;
      const layout = ctx.get ? ctx.get("layout") : undefined;
      const uiWorkspace = ctx.get ? ctx.get("uiWorkspace") : undefined;
      const canNavigate = (uiWorkspace && typeof uiWorkspace.openSession === "function") || (sessions && layout);
      if (canNavigate) {
        const stopNav = makeNav({ sessions, layout, uiWorkspace });
        try {
          // fiber 效果：插件卸载/页面销毁时自动清理轮询
          ctx.effect && ctx.effect(() => { return stopNav; }, "feishu-pilot: navigation follow");
        } catch {
          // effect 不可用（旧壳）⇒ 裸 timer
        }
      }
      // 侧栏会话行内按钮：壳公开插槽 sidebar.workspaces.session.row.action（与「归档会话」同区）。
      try {
        ctx.slots.inject("sidebar.workspaces.session.row.action", () =>
          ctx.slots.register(
            {
              name: "sidebar.workspaces.session.row.action",
              id: "feishu-notify",
              order: 50
            },
            SessionNotifyRowButton
          ));
      } catch { /* 旧壳无该插槽 ⇒ 仅保留设置页黑名单 */ }
      // 设置页：唯一的飞书顶级设置节「飞书」。
      // settings.section 与「Agent 预设 / Linux 运维」平级；注册元数据仅 {id, order, label}，无 inject 字段。
      // 组件 ownerProps 为 {close}（本组件忽略）；RPC 与数据一律走 apply 闭包（ctx.connection.rpc / ctx.get）。
      ctx.slots.inject(
        "settings.section",
        () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "feishu",
              order: 94,
              label: "飞书远控"
            },
            FeishuSection
          )
      );
      installFeishuNavIcon(ctx);
      ensureRowButtonCss();
    }

    module.exports = {
      name,
      inject,
      apply,
      // 纯逻辑测试缝（壳只读 name/inject/apply）
      __test: {
        channelView, maskAppId, featureRows, patchFor, deriveQrView, pendingRows, chatTypeLabel,
        isSessionMuted, nextNotifyBlacklist, isBoundSession
      }
    };
    return module.exports;
  }
});
