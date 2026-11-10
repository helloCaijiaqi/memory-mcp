// SQLite 后端入口：开库、只读降级、迁移、装配集合。
//
// 用内置 node:sqlite（Node >= 22.13，24.x 起免启动标志），无原生依赖、无需 node-gyp。
// 全部 node:sqlite 调用只出现在本目录，API 若在小版本间变化，改动面就这一个目录。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StoreMigrationError, StoreReadOnlyError, StoreUnavailableError } from './store-api.js';
import { MIGRATIONS, SCHEMA } from './sqlite-schema.js';
import { createMemoryCollection } from './sqlite-memory.js';
import { createSlangCollection } from './sqlite-slang.js';
import { createRawCollection } from './sqlite-raw.js';
import { createRelationCollection } from './sqlite-relation.js';
import { createSnapshotCollection } from './sqlite-snapshot.js';
import { createSessionStateCollection } from './sqlite-session-state.js';
import { createProfileCollection } from './sqlite-profile.js';
import { createRelationPendingCollection } from './sqlite-relation-pending.js';

const ALTER_ADD_COLUMN_RE = /^\s*ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/i;

function readUserVersion(db) {
  try {
    return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  } catch {
    return 0;
  }
}

function tableColumns(db, table) {
  try {
    return new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String(row.name)),
    );
  } catch {
    return new Set();
  }
}

function runMigrationStatements(db, statements) {
  for (const statement of statements) {
    const alter = ALTER_ADD_COLUMN_RE.exec(statement);
    // 手工加过列的库（DB Browser、临时脚本）不该在这里炸：列已存在就跳过。
    if (alter && tableColumns(db, alter[1]).has(alter[2])) continue;
    db.exec(statement);
  }
}

/**
 * 把库升到 SCHEMA_VERSION。返回升级后的版本号。
 *
 * 每条迁移整体在一个事务里：中途失败就回滚，绝不留「一半列已加、版本号没涨」的中间态。
 * 只读句柄不迁移，只回报当前版本（由 /api/health 暴露出去，让「库落后于代码」可见）。
 */
export function applyMigrations(db, { readonly = false, logger = console } = {}) {
  const current = readUserVersion(db);
  if (readonly) return current;
  let version = current;
  for (const migration of MIGRATIONS) {
    if (!migration || migration.version <= version) continue;
    db.exec('BEGIN');
    try {
      runMigrationStatements(db, migration.statements);
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
      db.exec('COMMIT');
      version = migration.version;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败时保留原始错误，别用第二条错误盖掉第一条 */
      }
      logger?.error?.(`[store] 迁移到 v${migration.version} 失败：${error?.message ?? error}`);
      throw new StoreUnavailableError(
        `记忆库迁移失败（v${migration.version}）：${error?.message ?? error}`,
        error,
      );
    }
  }
  return version;
}

export function openSqliteStore({ dir, file = 'memory.db', logger = console, readonly: readOnlyRequested = false } = {}) {
  if (!dir) throw new StoreUnavailableError('openSqliteStore 需要 dir');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, file);

  let db;
  let readonly = false;
  let journalMode = null;
  if (readOnlyRequested) {
    // 显式只读（preflight 用）：不建表、不迁移、不切 WAL —— 自检不该改动被检查的东西。
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      readonly = true;
    } catch (error) {
      throw new StoreUnavailableError(`无法只读打开记忆库（${dbPath}）：${error?.message ?? error}`, error);
    }
  } else {
    try {
      db = new DatabaseSync(dbPath);
      db.exec(SCHEMA);
    } catch (error) {
      try {
        db?.close();
      } catch {
        /* 关不掉就算了，下面重新开一个只读句柄 */
      }
      // 写权限缺失或文件损坏：能读就降级只读，绝不假装可写 —— 写失败必须由上层显式报给调用方。
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        readonly = true;
      } catch {
        throw new StoreUnavailableError(`无法打开记忆库（${dbPath}）：${error?.message ?? error}`);
      }
    }
  }

  // 生产参数：busy_timeout 让并发写等待而不是立刻抛 SQLITE_BUSY；WAL 缩短写锁、允许读写并行。
  // 只读句柄不设（切 WAL 要改文件头，只读连接会失败）。
  if (!readonly) {
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      // 记下实际生效的日志模式：网络盘上可能被拒，此时仍是默认模式（不假装成功）。
      journalMode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '');
    } catch {
      /* 网络盘 / 只读挂载可能不支持 WAL：退回默认日志模式，功能不受影响 */
    }
  }

  // 迁移放在建表之后、装配集合之前：集合的 SQL 直接引用新列/新表，顺序反了会在首轮查询炸。
  let schemaVersion;
  try {
    schemaVersion = applyMigrations(db, { readonly, logger });
  } catch (error) {
    // 库能打开但迁移没完成：不允许 openStore 静默回落 JSON（否则旧数据「消失」）。
    throw new StoreMigrationError(`sqlite 迁移失败：${error?.message ?? error}`, error);
  }

  // 只读 + 库里没有表（例如首次启动就没写成）：当空库用，读返回空而不是抛错。
  let usableFlag = true;
  if (readonly) {
    try {
      usableFlag = Boolean(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory'").get(),
      );
    } catch {
      usableFlag = false;
    }
  }
  const usable = () => usableFlag;

  const writable = () => {
    if (readonly || !usableFlag) {
      throw new StoreReadOnlyError(
        `记忆库当前只读（${readonly ? '打开时写权限校验失败' : '库不可用'}），拒绝写入：${dbPath}`,
      );
    }
  };

  const cache = new Map();
  const prepare = (key, sql) => {
    if (!cache.has(key)) cache.set(key, db.prepare(sql));
    return cache.get(key);
  };

  const memory = createMemoryCollection({ db, usable, writable, prepare });
  const slang = createSlangCollection({ db, usable, writable, prepare });
  const raw = createRawCollection({ db, usable, writable, prepare });
  const relation = createRelationCollection({ db, usable, writable, prepare });
  const snapshot = createSnapshotCollection({ db, usable, writable, prepare });
  const sessionState = createSessionStateCollection({ usable, writable, prepare });
  const profile = createProfileCollection({ usable, writable, prepare });
  const relationPending = createRelationPendingCollection({ usable, writable, prepare });

  /**
   * 事务：让「原始层 + 短期层」两次写入要么都发生、要么都不发生。
   * 集合方法本身不开事务（否则嵌套 BEGIN 会报错），事务边界只在这里划。
   */
  function transaction(fn) {
    writable();
    db.exec('BEGIN IMMEDIATE');
    const rollback = () => {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败时保留原始错误 */
      }
    };
    let result;
    try {
      result = fn();
    } catch (error) {
      rollback();
      throw error;
    }
    // 异步回调不能包事务：await 期间 COMMIT 早已执行，后续写入跑在事务外，
    // 失败时也不会回滚 —— 静默的半写状态比直接报错危险得多。
    if (result && (typeof result === 'object' || typeof result === 'function')
      && typeof result.then === 'function') {
      rollback();
      throw new TypeError('transaction 回调必须是同步函数（异步写入请拆成多次事务）');
    }
    try {
      db.exec('COMMIT');
      return result;
    } catch (error) {
      rollback();
      throw error;
    }
  }

  return {
    backend: 'sqlite',
    readonly,
    journalMode,
    schemaVersion,
    path: dbPath,
    memory,
    slang,
    raw,
    relation,
    snapshot,
    sessionState,
    profile,
    relationPending,
    transaction,
    /**
     * 按平台统计行数：跨平台接入后，「这个库里到底存了哪些平台的数据」是运维必看的一项。
     * 表名只出现在这里，不散到 preflight —— 存储布局变化时只改这一处。
     */
    platformStats() {
      if (!usableFlag) return [];
      const out = new Map();
      const bump = (platform, name, n) => {
        const key = String(platform ?? '');
        if (!key) return;
        if (!out.has(key)) out.set(key, { platform: key, memory: 0, raw: 0, relation: 0, snapshot: 0 });
        out.get(key)[name] += n;
      };
      for (const [name, table] of [
        ['memory', 'memory'],
        ['raw', 'raw_message'],
        ['relation', 'relation'],
        ['snapshot', 'head_snapshot'],
        ['sessionState', 'session_state'],
        ['profile', 'profile'],
        ['relationPending', 'relation_pending'],
      ]) {
        // 只读打开一个「还没迁移到最新版」的老库时，新表不存在是正常状态：统计跳过，不炸自检。
        let rows = [];
        try {
          rows = db.prepare(`SELECT platform, COUNT(*) AS n FROM ${table} GROUP BY platform`).all();
        } catch {
          continue;
        }
        for (const row of rows) bump(row.platform, name, Number(row.n ?? 0));
      }
      return [...out.values()].sort((a, b) => String(a.platform).localeCompare(String(b.platform)));
    },
    stats() {
      if (!usableFlag) {
        return { memory: 0, slang: 0, raw: 0, relation: 0, snapshot: 0, readonly: true, schemaVersion };
      }
      // 逐项兜底：健康检查/自检是最需要「别抛」的两条路径，缺表只该让计数变成 0。
      const safe = (fn) => {
        try {
          return fn();
        } catch {
          return 0;
        }
      };
      return {
        memory: safe(() => memory.count()),
        slang: safe(() => slang.count()),
        raw: safe(() => raw.count()),
        relation: safe(() => relation.count()),
        snapshot: safe(() => snapshot.count()),
        sessionState: safe(() => sessionState.count()),
        profile: safe(() => profile.count()),
        relationPending: safe(() => relationPending.count()),
        readonly,
        schemaVersion,
      };
    },
    close() {
      try {
        db.close();
      } catch {
        /* 关闭失败不影响进程退出 */
      }
    },
  };
}
