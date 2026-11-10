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
import { createHash } from 'node:crypto';
import { normalizeSessionId, parseSessionId } from '../session-id.js';

export const TIERS = ['short', 'long'];
// 记忆的「类型」轴与 tier（寿命）轴正交：tier 决定会不会过期，kind 决定衰减参数与注入位置。
export const MEMORY_KINDS = ['episodic', 'semantic', 'relation', 'emotion'];
export const RELATION_SCOPES = ['session', 'identity'];
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
 * 迁移失败（库能打开、但 schema 升级没走完）。
 *
 * 与「打不开」必须分开：打不开可以回落 JSON（能力降级但数据在新库里）；
 * 迁移失败回落 JSON 等于让服务对着空库「健康运行」——旧数据还在旧库里，
 * 新数据写进新文件，调用方完全无感。
 */
export class StoreMigrationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StoreMigrationError';
    this.cause = cause;
  }
}

/**
 * 打开存储。backend:
 *   'auto'   —— 优先 SQLite，打不开就落 JSON（仍然可用，只是没有 FTS）
 *   'sqlite' —— 只用 SQLite，失败即抛（用于测试与"必须要有检索能力"的场景）
 *   'json'   —— 只用 JSON 兜底实现
 *
 * readonly=true 供自检/巡检用：不建表、不迁移、不写文件。此时**不**回落 JSON ——
 * 回落会在只读巡检里新建一个 memory.json，把「检查」变成「改动」。
 */
/**
 * 是否允许回落 JSON（纯策略，便于单测）。
 * 迁移失败、只读巡检、显式 sqlite 都不允许回落。
 */
export function shouldFallbackToJson(error, { backend = 'auto', readonly = false } = {}) {
  if (readonly || backend === 'sqlite') return false;
  return !(error instanceof StoreMigrationError);
}

export async function openStore({ dir, backend = 'auto', file = 'memory.db', readonly = false } = {}) {
  if (!dir) throw new StoreUnavailableError('openStore 需要 dir');
  if (backend === 'json') {
    const mod = await import('./json-store.js');
    return mod.openJsonStore({ dir });
  }
  try {
    const mod = await import('./sqlite-store.js');
    return mod.openSqliteStore({ dir, file, readonly });
  } catch (error) {
    // 迁移失败不降级：见 StoreMigrationError 注释。显式 backend='json' 才是逃生口
    // （在函数开头直接返回，不会走到这里）。
    if (!shouldFallbackToJson(error, { backend, readonly })) throw error;
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
  const kind = MEMORY_KINDS.includes(row.kind) ? row.kind : 'episodic';
  return {
    id: String(row.id ?? '').trim() || newId('mem'),
    sessionId,
    platform: platformOf(sessionId),
    tier,
    kind,
    subjectId: String(row.subjectId ?? '').trim(),
    sourceMsgIds: normalizeIdList(row.sourceMsgIds),
    // 关系是「事实」，不该像话题一样随时间淡出；情绪反过来，必须衰减。
    decayExempt: row.decayExempt == null ? kind === 'relation' : Boolean(row.decayExempt),
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

// ---------------------------------------------------------------------------
// 平台维度
//
// platform 只有一处来源：sessionId 的第一段。任何 API 都不接受独立的 platform 入参，
// 否则「同一条记忆两处说法不一致」这种 bug 会一直存在到出问题那天。
// ---------------------------------------------------------------------------

/** 从 sessionId 取平台（已校验格式）。 */
export function platformOf(sessionId) {
  return parseSessionId(sessionId).platform;
}

/** 平台与 sessionId 前缀是否一致；不一致说明有人绕过 normalizeSessionId 直接拼了行。 */
export function platformMatches(sessionId, platform) {
  return platformOf(sessionId) === String(platform ?? '').toLowerCase();
}

/** 稳定的短哈希：同一 (sessionId, msgId) 永远得到同一个 id，幂等即来自此。 */
export function stableKey(...parts) {
  return createHash('sha1').update(parts.map((part) => String(part ?? '')).join('|')).digest('hex');
}

/**
 * 锚点：写进注入消息文本的短标识（`[#m1a2b3c4]`），让 DSH 的压缩摘要天然带上它。
 * 10 个字符，对 token 的影响可以忽略；同一消息重算不变，所以重复投递不会产生第二个锚点。
 */
export function anchorId(sessionId, msgId) {
  return `m${stableKey(sessionId, msgId).slice(0, 8)}`;
}

/** 原始层的确定性 id：与 UNIQUE(session_id, msg_id) 同源。 */
export function rawRowId(sessionId, msgId) {
  return `raw_${stableKey(sessionId, msgId).slice(0, 16)}`;
}

/**
 * 短期层从消息派生的确定性 id：同一 (sessionId, msgId) 重复 ingest 落到同一行，
 * 幂等不需要额外的去重表。sessionId 里含平台，`qq:group:1` 与 `wx:room:1` 不会撞。
 */
export function memoryRowId(sessionId, msgId) {
  return `mem_${stableKey(sessionId, msgId).slice(0, 16)}`;
}

/**
 * 明确记录（record）的确定性 id：同一会话里重复上报同一条事实落到同一行。
 *
 * 「用户讨厌被敷衍」今天说一次、下周复述一次，长期层不该堆出两条同义行 ——
 * 所以幂等键是内容本身，而不是「谁在什么时候说的」。
 */
export function recordRowId(sessionId, { kind = 'semantic', subjectId = '', content = '' } = {}) {
  return `mem_${stableKey(sessionId, `record|${kind}|${subjectId}`, String(content ?? '').trim()).slice(0, 16)}`;
}

/** 关系行的确定性 id：同一 (会话, 说话人, 键, 作用域) 永远落到同一行。 */
export function relationRowId({ sessionId, subjectId, key, scope = 'session' } = {}) {
  return `rel_${stableKey(sessionId, subjectId, key, scope).slice(0, 16)}`;
}

function normalizeIdList(value, max = 50) {
  const list = Array.isArray(value) ? value : parseJsonArray(value);
  return list
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function parseJsonArray(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 原始消息行。text 允许为空（归档后只留元数据），msgId 必填。 */
export function normalizeRawRow(row, { now = nowMs() } = {}) {
  if (!row || typeof row !== 'object') throw new TypeError('原始消息行必须是对象');
  const sessionId = normalizeSessionId(row.sessionId);
  const msgId = String(row.msgId ?? '').trim();
  if (!msgId) throw new TypeError('原始消息缺少 msgId');
  const meta = row.meta == null ? '{}' : typeof row.meta === 'string' ? row.meta : JSON.stringify(row.meta);
  return {
    id: String(row.id ?? '').trim() || rawRowId(sessionId, msgId),
    sessionId,
    platform: platformOf(sessionId),
    msgId,
    senderId: String(row.senderId ?? '').trim(),
    kind: String(row.kind ?? 'text').trim() || 'text',
    text: String(row.text ?? ''),
    meta,
    anchor: String(row.anchor ?? '').trim() || anchorId(sessionId, msgId),
    createdAt: clampInt(row.createdAt, 0, Number.MAX_SAFE_INTEGER, now),
    archivedAt: row.archivedAt == null ? null : clampInt(row.archivedAt, 0, Number.MAX_SAFE_INTEGER, null),
  };
}

/** 关系/情绪行：单值 + 版本链里的「当前值」。 */
export function normalizeRelationRow(row, { now = nowMs() } = {}) {
  if (!row || typeof row !== 'object') throw new TypeError('关系行必须是对象');
  const sessionId = normalizeSessionId(row.sessionId);
  const subjectId = String(row.subjectId ?? '').trim();
  if (!subjectId) throw new TypeError('关系行缺少 subjectId');
  const key = String(row.key ?? '').trim();
  if (!key) throw new TypeError('关系行缺少 key');
  const value = String(row.value ?? '').trim();
  if (!value) throw new TypeError('关系行缺少 value');
  const scope = RELATION_SCOPES.includes(row.scope) ? row.scope : 'session';
  const kind = row.kind === 'emotion' ? 'emotion' : 'relation';
  return {
    id: String(row.id ?? '').trim() || relationRowId({ sessionId, subjectId, key, scope }),
    sessionId,
    platform: platformOf(sessionId),
    subjectId,
    key,
    value,
    kind,
    scope,
    // 只在写历史时用到（relation 表本身不存），缺了它版本链就永远查不到「这条关系是谁说的」。
    sourceMsgIds: normalizeIdList(row.sourceMsgIds),
    importance: clampInt(row.importance, 0, 10, 0),
    // 可信度守卫三列（v2 迁移）：人工写入默认满置信；自动抽取必须显式给
    // confidence 与 actor（summary:<hash> / rule:<name>），渲染层按它降权。
    confidence: row.confidence == null ? 1 : Math.min(1, Math.max(0, Number(row.confidence))),
    actor: String(row.actor ?? 'manual').trim() || 'manual',
    lastConfirmedAt: row.lastConfirmedAt == null ? null : clampInt(row.lastConfirmedAt, 0, Number.MAX_SAFE_INTEGER, now),
    // 关系默认不衰减；情绪必须衰减（默认 decayExempt=false）。
    decayExempt: row.decayExempt == null ? kind !== 'emotion' : Boolean(row.decayExempt),
    createdAt: clampInt(row.createdAt, 0, Number.MAX_SAFE_INTEGER, now),
    updatedAt: now,
  };
}

/** head 冻结快照。headText 由 head-builder 生成，这里只做形状校验。 */
export function normalizeSnapshotRow(row, { now = nowMs() } = {}) {
  if (!row || typeof row !== 'object') throw new TypeError('快照行必须是对象');
  const sessionId = normalizeSessionId(row.sessionId);
  const revision = String(row.revision ?? '').trim();
  if (!revision) throw new TypeError('快照缺少 revision');
  const headText = String(row.headText ?? '');
  return {
    sessionId,
    platform: platformOf(sessionId),
    revision,
    headText,
    builtAt: clampInt(row.builtAt, 0, Number.MAX_SAFE_INTEGER, now),
    lastActivityAt: clampInt(row.lastActivityAt, 0, Number.MAX_SAFE_INTEGER, now),
  };
}
