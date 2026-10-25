// lib/rpc-route.js —— 自注册 loopback RPC 通道。
// 本 DSH 版本的 `connection.rpc.handle` 不可用——其 `owner.webServer` 经 traceable
// shadow 锚定到 connection 服务自身 fiber（服务构造 ctx），该 fiber 永远解析不到
// 兄弟 webServer 服务 ⇒ 任何消费方调用都抛 "cannot get property webServer without
// inject"（与消费方 inject 声明无关，真 HostConnectionService 实验已证实）。
// 对策（只改插件，不动 DSH）：按 dsh-webhook-github 同款生产模式，插件自己
// `ctx.effect(() => ctx.webServer.register(route))` 注册前缀路由（inject 声明
// webServer 即可跨 fiber 解析），路由内手工复刻 dsh-client-connection 的
// RPC 线上协议（POST {channel}/{endpoint}，client-request/server-response
// 信封，与客户端 `connection.rpc.call` 完全兼容），Host/Origin 围栏 + 浏览器
// 鉴权复用 connection 服务公开方法 `requestRejection(req)`（方法调用不触发
// 跨 fiber 属性检查）。
// 协议参照 dsh-client-connection/lib/index.js（rpcFetchHandler / clientRequestSchema /
// endpointFromPath）：
//   - POST 且 content-type: application/json，否则 404/415
//   - body {type:'client-request', rpcId, method, payload}；method 必须等于 endpoint
//   - 响应 200 {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
//   - 信封错误 400（非 JSON）/ 200 gateway/bad-request（信封非法/method 不匹配）
//   - handler 抛错 500

const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/;

/** 复刻 endpointFromPath：pathname 相对 channel 的 endpoint（非法段 ⇒ undefined）。 */
export function endpointOf(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT.test(seg))) return undefined;
  return endpoint;
}

/** node:http 请求体读取。 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 构造一个 RPC 通道的前缀路由（handler 签名同 webServer 前缀路由：(req, res)）。
 * @param {string} channel   形如 '/dsh-feishu-pilot'
 * @param {(endpoint:string, payload:any) => Promise<any>} endpointHandler  端点处理（返回 {ok,value}/{ok:false,error}）
 * @param {{ reject?: (req:any) => number|undefined }} [opts]  围栏：返回 401/403 状态码则拒绝（生产取 connection.requestRejection）
 */
function createRpcChannelRoute(channel, endpointHandler, { reject } = {}) {
  const sendJson = (res, status, body) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(buf);
  };
  const badRequest = (res, rpcId, message, details = {}) =>
    sendJson(res, 200, {
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code: 'gateway/bad-request', message, details } },
    });

  return {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      // Host/Origin 围栏 + 浏览器鉴权（与生产 rpc 路由同一守卫）
      const rejection = reject ? reject(req) : undefined;
      if (rejection !== undefined) {
        res.writeHead(rejection);
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      if (req.method !== 'POST') { res.writeHead(404); res.end('not found'); return; }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const endpoint = endpointOf(channel, pathname);
      if (endpoint === undefined) { res.writeHead(404); res.end('not found'); return; }
      const ctype = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
      if (ctype !== 'application/json') { res.writeHead(415); res.end('content type must be application/json'); return; }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('body is not JSON'); return; }
      if (body?.type !== 'client-request' || typeof body?.rpcId !== 'string' || typeof body?.method !== 'string') {
        badRequest(res, typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request', 'invalid client-request message');
        return;
      }
      if (body.method !== endpoint) {
        badRequest(res, body.rpcId, `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`);
        return;
      }
      let result;
      try {
        result = await endpointHandler(endpoint, body.payload);
      } catch (err) {
        res.writeHead(500);
        res.end(`handler failure: ${err?.message ?? err}`);
        return;
      }
      sendJson(res, 200, { type: 'server-response', rpcId: body.rpcId, result: toWireResult(result) });
    },
  };
}

/**
 * 把插件内部结果规范成 DSH RPC 线上格式：失败时 error 必须是
 * `{ code, message, details:{} }`（客户端会校验 details 为对象）。
 * @param {any} result
 * @returns {any}
 */
export function toWireResult(result) {
  if (!result || result.ok !== false) return result;
  const err = result.error;
  if (typeof err === 'string') {
    return { ...result, error: { code: 'plugin/error', message: err, details: {} } };
  }
  if (err && typeof err === 'object' && !err.details) {
    return { ...result, error: { ...err, details: {} } };
  }
  return result;
}

/**
 * 在插件 ctx 上注册 RPC 通道（需 inject 声明 webServer；connection 可选，有则套围栏）。
 * @returns disposer（fiber 卸载/插件停止时由 effect 回收）
 */
export function registerRpcChannel(ctx, channel, endpointHandler, label) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
  const reject = typeof connection?.requestRejection === 'function'
    ? (req) => connection.requestRejection(req)
    : undefined;
  const route = createRpcChannelRoute(channel, endpointHandler, { reject });
  return ctx.effect(() => ctx.webServer.register(route), label);
}
