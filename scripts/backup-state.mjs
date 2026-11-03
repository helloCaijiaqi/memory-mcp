#!/usr/bin/env node
// 记忆库备份：用 VACUUM INTO 生成一致性快照。
//
// 为什么不直接 copy 文件：开了 WAL 之后，最新写入可能还留在 memory.db-wal 里没合并进主库，
// 单独拷 memory.db 会得到「旧数据」；VACUUM INTO 读的是已提交状态，导出的是一致快照。
//
// 令牌单独存一份 http-token.bak，不参与轮转：桥接进程只在启动时读一次令牌，
// 令牌被换掉要重启桥接才生效，留一份是为了灾难恢复时能「原样还原」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = 7;

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function prune(backupDir, keep) {
  const pattern = /^memory-\d{8}-\d{6}\.db$/;
  const files = fs.readdirSync(backupDir)
    .filter((name) => pattern.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const stale = files.slice(keep);
  for (const file of stale) fs.rmSync(path.join(backupDir, file.name), { force: true });
  return stale.map((file) => file.name);
}

export function backupState({ stateDir, keep = KEEP, logger = console.log } = {}) {
  const dir = path.resolve(stateDir ?? process.env.MEMORY_MCP_STATE_DIR ?? path.join(PKG_ROOT, 'state'));
  const dbPath = path.join(dir, 'memory.db');
  if (!fs.existsSync(dbPath)) {
    logger(`[backup] 没有记忆库（${dbPath}），无需备份`);
    return { skipped: true };
  }

  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `memory-${stamp()}.db`);

  const db = new DatabaseSync(dbPath);
  try {
    // 服务可能正在写：等锁而不是立刻失败。
    db.exec('PRAGMA busy_timeout = 5000');
    // VACUUM INTO 要求目标文件不存在；路径里的单引号按 SQL 字面量转义。
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const tokenFile = path.join(dir, 'http-token');
  if (fs.existsSync(tokenFile)) fs.copyFileSync(tokenFile, path.join(backupDir, 'http-token.bak'));

  const removed = prune(backupDir, keep);
  const size = fs.statSync(target).size;
  logger(`[backup] 已生成 ${target}（${size} 字节）${removed.length ? `，清理 ${removed.length} 份旧快照` : ''}`);
  return { target, size, removed };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    backupState();
  } catch (error) {
    console.error('[backup] 失败：', error?.stack ?? error);
    process.exitCode = 1;
  }
}
