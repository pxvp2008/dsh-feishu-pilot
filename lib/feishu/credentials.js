// lib/feishu/credentials.js —— 插件自有的飞书凭据层。
//
// 职责（只做凭据，不碰协议、不碰 cordis）：
//   1. 凭据读写：$DSH_HOME/<STATE_DIR_NAME>/feishu-credentials.json（路径与迁移见 lib/identity.js）；
//   2. 密钥引用解析：'env:NAME' → 环境变量；env 为空 ⇒ 回退凭据文件字段；都没有 ⇒ ''；
//   3. 扫码/手动配置状态的脱敏：深拷贝 + secret 类字段打码（App Secret 绝不进浏览器）。

import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { CREDENTIALS_REL, LEGACY_CREDENTIALS_RELS, dshHome, legacyMigrationPending } from '../identity.js';

/** env 变量名 → 凭据文件字段。 */
export const ENV_CRED_FIELDS = Object.freeze({
  FEISHU_APP_ID: 'appId',
  FEISHU_APP_SECRET: 'appSecret',
});

/**
 * 读凭据文件；读不到 ⇒ {}（调用方按「缺凭据」处理，不抛错）。
 * 语义边界（2.1.0 明确）：
 *   1. 旧路径只读回退**仅限迁移未完成窗口**（legacyMigrationPending）——迁移完成后旧目录只是
 *      备份，不再参与读取（否则有意删除的新凭据会被旧备份「复活」）；
 *   2. 只对「文件缺失（ENOENT）」继续尝试下一个候选；文件存在但 JSON 损坏 ⇒ 直接视为无凭据
 *      （优雅断开、设置页重扫码），不回退旧路径——避免用旧 app 的身份静默连上。
 */
export function readCredentials({ home, env = process.env, read = readFileSync } = {}) {
  const base = home ?? dshHome(env);
  const rels = legacyMigrationPending({ home: base })
    ? [CREDENTIALS_REL, ...LEGACY_CREDENTIALS_RELS]
    : [CREDENTIALS_REL];
  for (const rel of rels) {
    let raw;
    try {
      raw = read(join(base, rel), 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') continue; // 缺失 ⇒ 试下一个候选
      return {}; // 权限/IO 错 ⇒ 视作无凭据（不猜是哪个 app）
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      return {}; // 损坏 ⇒ 无凭据（不回退旧路径）
    }
    return {};
  }
  return {};
}

/**
 * 解析密钥引用：
 *   'env:NAME' → 环境变量 NAME；env 值为空 ⇒ 回退凭据文件字段（FEISHU_APP_ID→appId /
 *   FEISHU_APP_SECRET→appSecret）；仍为空 ⇒ ''（上游据此走「缺凭据 = 优雅断开」）。
 * 非 'env:' 的值原样返回（手动填写的明文凭据）。
 * @param {string} [value]
 * @param {{home?:string, env?:NodeJS.ProcessEnv, read?:(p:string,e:string)=>string}} [opts]
 */
export function resolveSecret(value, { home, env = process.env, read = readFileSync } = {}) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const envName = value.slice(4);
    const fromEnv = env?.[envName];
    if (fromEnv) return fromEnv;
    const field = ENV_CRED_FIELDS[envName];
    if (!field) return '';
    return readCredentials({ home, env, read })[field] ?? '';
  }
  return value;
}

// ── 脱敏 ─────────────────────────────────────────────────────────────────────

/** secret 类字段名（大小写不敏感；覆盖 client_secret 形态）。 */
const SECRET_KEY_RE = /(secret|passwd|password|token|api[-_]?key|access[-_]?key|credential|signature|authorization)/i;
/** 打码占位值：保留字段名（前端可判断「已配置」），值不可逆。 */
export const REDACTED_MASK = '***';

/**
 * 深拷贝并把 secret 类字段打码，用于任何要发往浏览器/日志的扫码或配置状态。
 * 语义与历史上游的 redactProvisioning 同向（App Secret 不外传），
 * 差别：这里是「深拷贝 + 打码」而非白名单投影——非敏感字段全部保留，新增状态字段
 * 不会因为漏进白名单而消失；不可序列化值（函数/Symbol）与循环引用被丢弃。
 * @param {any} obj
 * @param {{maxDepth?:number}} [opts]
 */
export function redactProvisioning(obj, { maxDepth = 8 } = {}) {
  const seen = new WeakSet();
  const walk = (value, depth) => {
    if (value === null) return null;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value) ? value : null;
    if (t === 'bigint') return String(value);
    if (value instanceof Date) return value.toISOString();
    if (t !== 'object') return undefined; // function / symbol / undefined
    if (seen.has(value)) return undefined; // 循环引用
    seen.add(value);
    if (depth >= maxDepth) return undefined;
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) {
        const r = walk(item, depth + 1);
        if (r !== undefined) out.push(r);
      }
      return out;
    }
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(String(key))) {
        out[key] = REDACTED_MASK;
        continue;
      }
      const r = walk(raw, depth + 1);
      if (r !== undefined) out[key] = r;
    }
    return out;
  };
  const result = walk(obj, 0);
  return result === undefined ? { phase: 'idle' } : result;
}
