// JSON 兜底后端：SQLite 打不开时用（无 FTS、无索引，靠内存扫描）。
//
// 存在的意义是"服务仍然可用"，不是为了性能：量级小的时候够用，量级大时应该先把 SQLite 修好。
// 两条硬性语义与 SQLite 后端一致：只读时写操作抛错；query 回传 strategy（这里只可能是 like / scan）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StoreReadOnlyError, StoreUnavailableError, normalizeMemoryRow, normalizeSlangRow } from './store-api.js';

const FILE_MODE = 0o600;

function atomicWrite(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: FILE_MODE });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, FILE_MODE);
  } catch {
    /* Windows 上 chmod 可能不支持，忽略 */
  }
}

export function openJsonStore({ dir, file = 'memory.json' } = {}) {
  if (!dir) throw new StoreUnavailableError('openJsonStore 需要 dir');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, file);

  let data = { version: 1, memory: [], slang: [] };
  let readonly = false;

  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed?.memory)) data.memory = parsed.memory;
      if (Array.isArray(parsed?.slang)) data.slang = parsed.slang;
    } else {
      // 首次启动就试着写一次：写不进去说明没权限，立刻降级只读，别等到运行时才发现。
      atomicWrite(filePath, JSON.stringify(data));
    }
  } catch (error) {
    readonly = true;
  }

  function flush() {
    if (readonly) {
      throw new StoreReadOnlyError(`记忆库当前只读，拒绝写入：${filePath}`);
    }
    try {
      atomicWrite(filePath, `${JSON.stringify(data)}${os.EOL}`);
    } catch (error) {
      readonly = true;
      throw new StoreReadOnlyError(`记忆库写入失败，已降级只读：${error?.message ?? error}`);
    }
  }

  const byId = (list, id) => list.find((item) => item.id === String(id)) ?? null;

  function makeCollection(name, normalize) {
    return {
      get(id) {
        return byId(data[name], id);
      },
      put(row) {
        const r = normalize(row);
        const index = data[name].findIndex((item) => item.id === r.id);
        const next = index >= 0 ? { ...data[name][index], ...r } : r;
        if (index >= 0) data[name][index] = next;
        else data[name].push(next);
        flush();
        return next;
      },
      remove(id) {
        const before = data[name].length;
        data[name] = data[name].filter((item) => item.id !== String(id));
        if (data[name].length !== before) flush();
        return data[name].length !== before;
      },
      query(opts = {}) {
        const limit = Math.min(200, Math.max(1, Math.round(Number(opts.limit ?? 20))));
        let rows = [...data[name]];
        if (opts.sessionId) rows = rows.filter((row) => row.sessionId === opts.sessionId);
        if (opts.platform) rows = rows.filter((row) => row.platform === opts.platform);
        if (opts.tier) rows = rows.filter((row) => row.tier === opts.tier);
        if (opts.status) rows = rows.filter((row) => row.status === opts.status);
        else if (!opts.includeArchived && name === 'memory') rows = rows.filter((row) => row.status === 'active');
        const now = opts.now ?? Date.now();
        if (!opts.includeExpired && name === 'memory') {
          rows = rows.filter((row) => row.expiresAt == null || row.expiresAt > now);
        }
        const text = String(opts.text ?? '').trim();
        if (text) {
          const lower = text.toLowerCase();
          rows = rows.filter(
            (row) =>
              String(row.content).toLowerCase().includes(lower) ||
              String(row.meaning ?? '').toLowerCase().includes(lower),
          );
        }
        if (typeof opts.scoreOf === 'function') rows.sort((a, b) => opts.scoreOf(b) - opts.scoreOf(a));
        else if (name === 'memory') rows.sort((a, b) => b.lastTouchAt - a.lastTouchAt);
        else rows.sort((a, b) => b.score - a.score || b.hits - a.hits);
        return { rows: rows.slice(0, limit), strategy: text ? 'like' : 'scan' };
      },
      prune(opts = {}) {
        const result = { expired: 0, evicted: 0 };
        const now = opts.now ?? Date.now();
        if (name === 'memory') {
          const before = data[name].length;
          data[name] = data[name].filter((row) => row.expiresAt == null || row.expiresAt > now);
          result.expired = before - data[name].length;
        }
        const maxEntries = Number(opts.maxEntries ?? 0);
        if (maxEntries > 0 && data[name].length > maxEntries) {
          const scoreOf = typeof opts.scoreOf === 'function' ? opts.scoreOf : (row) => row.score ?? row.lastTouchAt ?? 0;
          const sorted = [...data[name]].sort((a, b) => scoreOf(a) - scoreOf(b));
          const victims = new Set(sorted.slice(0, data[name].length - maxEntries).map((row) => row.id));
          data[name] = data[name].filter((row) => !victims.has(row.id));
          result.evicted = victims.size;
        }
        if (result.expired || result.evicted) flush();
        return result;
      },
      count(opts = {}) {
        return this.query({ ...opts, limit: 200 }).rows.length;
      },
    };
  }

  return {
    backend: 'json',
    get readonly() {
      return readonly;
    },
    path: filePath,
    memory: makeCollection('memory', (row) => normalizeMemoryRow(row)),
    slang: makeCollection('slang', (row) => normalizeSlangRow(row)),
    stats() {
      return { memory: data.memory.length, slang: data.slang.length, readonly };
    },
    close() {
      /* JSON 后端每次写都落盘，无需关闭动作 */
    },
  };
}
