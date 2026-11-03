// SQLite 后端入口：开库、只读降级、装配两个集合。
//
// 用内置 node:sqlite（Node >= 22.13，24.x 起免启动标志），无原生依赖、无需 node-gyp。
// 全部 node:sqlite 调用只出现在本目录，API 若在小版本间变化，改动面就这一个目录。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StoreReadOnlyError, StoreUnavailableError } from './store-api.js';
import { SCHEMA } from './sqlite-schema.js';
import { createMemoryCollection } from './sqlite-memory.js';
import { createSlangCollection } from './sqlite-slang.js';

export function openSqliteStore({ dir, file = 'memory.db' } = {}) {
  if (!dir) throw new StoreUnavailableError('openSqliteStore 需要 dir');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, file);

  let db;
  let readonly = false;
  let journalMode = null;
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

  return {
    backend: 'sqlite',
    readonly,
    journalMode,
    path: dbPath,
    memory,
    slang,
    stats() {
      if (!usableFlag) return { memory: 0, slang: 0, readonly: true };
      return { memory: memory.count(), slang: slang.count(), readonly };
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
