// lib/identity.js —— 插件身份的单一事实源 + 更名迁移。
//
// 身份三元组（任何一处改名都必须同步，test/identity.test.mjs 全仓扫描锁死）：
//   PKG_NAME   = 'dsh-feishu-pilot'   package.json name · cordis insert name · RPC 前缀 '/'+PKG_NAME
//   SHORT_ID   = 'feishu-pilot'       cordis 实例 id · 日志命名空间 · 日志前缀 [feishu-pilot]
//   STATE_DIR  = PKG_NAME             $DSH_HOME/<STATE_DIR>（state.json / mappings.json /
//                                     im-overrides.json / pending-users.json / 凭据 / 日志）
//
// 更名沿革（2.1.0）：本项目最初叫 dsh-feishu-remote（「重名太多」），2.0.0 起包名改为
// dsh-feishu-pilot；2.0.2 修客户端入口、2.0.5 修 cordis 实例 id，但状态目录与 RPC 前缀
// 当时刻意保留旧值。2.1.0 把剩下的两层一并改干净：
//   · RPC 前缀   /dsh-feishu-remote  → /dsh-feishu-pilot（host 注册与 client 半部同源）
//   · 状态目录   $DSH_HOME/dsh-feishu-remote → $DSH_HOME/dsh-feishu-pilot
// 状态目录改名不能「删旧建新」——里面有凭据、聊天绑定、授权名单、待批准、意图：
//   1. 启动期一次性迁移（migrateLegacyStateDir）：新目录缺什么补什么，绝不覆盖已有文件；
//      旧目录原样保留（回退旧版 / 取证都还有）；
//   2. 凭据读取另留只读回退（readCredentials）：迁移失败时仍能连上，不因改名丢连接。
// 旧名称只允许出现在本模块与 test/identity.test.mjs（迁移用例），其余代码由守卫测试兜底。

import { cpSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** npm 包名 / 插件全名（也是 RPC 前缀与状态目录名的来源）。 */
export const PKG_NAME = 'dsh-feishu-pilot';

/** 短身份：cordis 实例 id、日志命名空间、日志前缀（= PKG_NAME 去掉 'dsh-'）。 */
export const SHORT_ID = PKG_NAME.replace(/^dsh-/, '');

/** 状态目录名（$DSH_HOME/<此名>）。 */
export const STATE_DIR_NAME = PKG_NAME;

/** 历史包名（只用于迁移旧状态目录/旧凭据；不作为任何现行路径）。 */
export const LEGACY_PKG_NAMES = ['dsh-feishu-remote'];

/** 历史状态目录名（与历史包名同形）。 */
export const LEGACY_STATE_DIR_NAMES = LEGACY_PKG_NAMES;

/** $DSH_HOME；未设置 ⇒ ~/.dsh。每次调用现读 env（测试可热改）。 */
export function dshHome(env = process.env) {
  const raw = env?.DSH_HOME;
  return typeof raw === 'string' && raw.trim() ? raw : join(homedir(), '.dsh');
}

/** 状态目录（config.stateDir 或 $DSH_HOME/<STATE_DIR_NAME>）。 */
export function stateDirOf(config = {}) {
  return config.stateDir ?? join(dshHome(), STATE_DIR_NAME);
}

/** 凭据文件（相对 $DSH_HOME）；也是扫码/手动配置的写入目标。 */
export const CREDENTIALS_REL = join(STATE_DIR_NAME, 'feishu-credentials.json');

/** 历史凭据文件（相对 $DSH_HOME）；只读回退，永不写入。 */
export const LEGACY_CREDENTIALS_RELS = LEGACY_STATE_DIR_NAMES.map((n) => join(n, 'feishu-credentials.json'));

/** 凭据文件路径（绝对）。 */
export function credentialsFile({ home, env = process.env } = {}) {
  return join(home ?? dshHome(env), CREDENTIALS_REL);
}

/** 迁移完成标记（放在新目录里；文件名含历史目录名，仅本模块使用）。 */
function migrationMarker(to, legacyName) {
  return join(to, `.migrated-${legacyName}`);
}

/**
 * 旧目录是否仍处于「待迁移」状态（旧目录存在但尚无完成标记）。
 * 凭据读取据此决定是否允许只读回退：迁移完成后旧目录只是备份、不再参与读取，
 * 避免用户有意删除的新凭据被旧备份「复活」。
 * @param {{home?:string}} [opts]
 */
export function legacyMigrationPending({ home } = {}) {
  const base = home ?? dshHome();
  const to = join(base, STATE_DIR_NAME);
  return LEGACY_STATE_DIR_NAMES.some((legacyName) => (
    existsSync(join(base, legacyName)) && !existsSync(migrationMarker(to, legacyName))
  ));
}

/**
 * 把旧状态目录迁到当前目录。同步、幂等、绝不抛错。
 * 新目录缺失 ⇒ 整目录复制；两目录并存 ⇒ 只补缺、绝不覆盖；
 * 成功后写一次性标记，之后不再从旧目录补缺（避免被有意删除的新文件被旧目录复活）。
 * @param {{home?:string, log?:(m:string)=>void}} [opts]
 * @returns {{migrated:boolean, from:string|null, to:string, copied:string[], errors:string[], elapsedMs:number}}
 */
export function migrateLegacyStateDir({ home, log } = {}) {
  const startedAt = Date.now();
  const base = home ?? dshHome();
  const to = join(base, STATE_DIR_NAME);
  /** @type {{migrated:boolean, from:string|null, to:string, copied:string[], errors:string[], elapsedMs:number}} */
  const result = { migrated: false, from: null, to, copied: [], errors: [], elapsedMs: 0 };

  for (const legacyName of LEGACY_STATE_DIR_NAMES) {
    const from = join(base, legacyName);
    try {
      if (!existsSync(from)) continue;
      const marker = migrationMarker(to, legacyName);
      if (existsSync(marker)) continue; // 已迁移过：旧目录仅作备份，不再补缺
      if (!existsSync(to)) {
        // 首次升级：整目录复制（含凭据/绑定/日志），旧目录保留
        cpSync(from, to, { recursive: true });
        result.migrated = true;
        result.from = from;
        try { result.copied = readdirSync(to); } catch { result.copied = []; }
      } else {
        // 新目录已存在（重装/回退后再升级）：只补缺，绝不覆盖新文件
        for (const entry of readdirSync(from)) {
          const src = join(from, entry);
          const dst = join(to, entry);
          if (existsSync(dst)) continue;
          cpSync(src, dst, { recursive: statSync(src).isDirectory() });
          result.copied.push(entry);
        }
        if (result.copied.length) {
          result.migrated = true;
          result.from = from;
        }
      }
      // 标记写失败 ⇒ 下次启动重试补缺（不致命）
      try { writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf8'); } catch { /* 见上 */ }
    } catch (e) {
      const msg = `状态目录迁移失败（${legacyName} → ${STATE_DIR_NAME}）：${e?.message ?? e}`;
      result.errors.push(msg);
      log?.(msg);
    }
  }
  result.elapsedMs = Date.now() - startedAt;
  return result;
}
