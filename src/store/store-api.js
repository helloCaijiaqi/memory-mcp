// 存储抽象：service / mcp / http 三层只认这一层，不直接碰 SQL，也不直接碰文件。
//
// 契约（两个集合：memory 与 slang，四个动词）：
//   get(id)      -> 行对象 | null
//   put(row)     -> 行对象（按 id upsert）
//   query(opts)  -> { rows, strategy }   strategy: 'fts5' | 'like' | 'scan'
//   prune(opts)  -> { expired, evicted }
// 另外两个必要动作：remove(id)（硬删除，服务被遗忘权）、close()（关句柄）
//
// 两条硬性语义（照搬 qq-bridge 踩过的坑，不能省）：
//   1. 只读降级可以读，但绝不假装能写：写操作抛 StoreReadOnlyError，由上层显式失败并透传给调用方。
//      对应 bridge.js 里 slangStoreWritable 的既有约定 —— 读失败就降级只读，绝不回写。
//   2. query 必须回传 strategy：trigram 分词器对 <3 字符的查询会静默返回 0 条，
//      不把策略暴露出来，排查"明明有这条记忆却搜不到"就只能靠猜。
import { normalizeSessionId } from '../session-id.js';

export const TIERS = ['short', 'long'];
export const MEMORY_STATUS = ['active', 'archived'];
export const SLANG_STATUS = ['candidate', 'confirmed', 'rejected'];
export const QUERY_STRATEGIES = ['fts5', 'like', 'scan'];

export class StoreUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StoreUnavailableError';
    this.cause = cause;
  }
}

export class StoreReadOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreReadOnlyError';
  }
}

/**
 * 打开存储。backend:
 *   'auto'   —— 优先 SQLite，打不开就落 JSON（仍然可用，只是没有 FTS）
 *   'sqlite' —— 只用 SQLite，失败即抛（用于测试与"必须要有检索能力"的场景）
 *   'json'   —— 只用 JSON 兜底实现
 */
export async function openStore({ dir, backend = 'auto', file = 'memory.db' } = {}) {
  if (!dir) throw new StoreUnavailableError('openStore 需要 dir');
  if (backend === 'json') {
    const mod = await import('./json-store.js');
    return mod.openJsonStore({ dir });
  }
  try {
    const mod = await import('./sqlite-store.js');
    return mod.openSqliteStore({ dir, file });
  } catch (error) {
    if (backend === 'sqlite') throw error;
    const mod = await import('./json-store.js');
    const store = mod.openJsonStore({ dir });
    store.degradedFrom = error instanceof Error ? error.message : String(error);
    return store;
  }
}

const nowMs = () => Date.now();

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

let idCounter = 0;
export function newId(prefix = 'm') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 记忆行的规范化与缺省补齐；id 缺失时自动生成。 */
export function normalizeMemoryRow(row, { now = nowMs() } = {}) {
  if (!row || typeof row !== 'object') throw new TypeError('记忆行必须是对象');
  const sessionId = normalizeSessionId(row.sessionId);
  const tier = TIERS.includes(row.tier) ? row.tier : 'short';
  const status = MEMORY_STATUS.includes(row.status) ? row.status : 'active';
  const content = String(row.content ?? '').trim();
  if (!content) throw new TypeError('记忆内容不能为空');
  const extra = row.extra == null ? '' : typeof row.extra === 'string' ? row.extra : JSON.stringify(row.extra);
  return {
    id: String(row.id ?? '').trim() || newId('mem'),
    sessionId,
    platform: sessionId.split(':')[0],
    tier,
    category: String(row.category ?? '').trim(),
    content,
    extra,
    importance: clampInt(row.importance, 0, 10, 0),
    baseWeight: clampFloat(row.baseWeight, 0, 100, 1),
    hits: clampInt(row.hits, 0, 1e9, 0),
    status,
    createdAt: clampInt(row.createdAt, 0, Number.MAX_SAFE_INTEGER, now),
    updatedAt: now,
    lastTouchAt: clampInt(row.lastTouchAt, 0, Number.MAX_SAFE_INTEGER, now),
    expiresAt: row.expiresAt == null ? null : clampInt(row.expiresAt, 0, Number.MAX_SAFE_INTEGER, null),
  };
}

/** 黑话行的规范化与缺省补齐。 */
export function normalizeSlangRow(row, { now = nowMs() } = {}) {
  if (!row || typeof row !== 'object') throw new TypeError('黑话行必须是对象');
  const content = String(row.content ?? '').trim();
  if (!content) throw new TypeError('黑话内容不能为空');
  const status = SLANG_STATUS.includes(row.status) ? row.status : 'candidate';
  const evidence = Array.isArray(row.evidence)
    ? row.evidence.map((item) => String(item)).filter(Boolean).slice(0, 20)
    : [];
  return {
    id: String(row.id ?? '').trim() || newId('slg'),
    content,
    meaning: String(row.meaning ?? '').trim(),
    status,
    evidence,
    score: clampFloat(row.score, 0, 1e9, 0),
    hits: clampInt(row.hits, 0, 1e9, 0),
    createdAt: clampInt(row.createdAt, 0, Number.MAX_SAFE_INTEGER, now),
    updatedAt: now,
  };
}
