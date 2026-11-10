// JSON 兜底后端：SQLite 打不开时用（无 FTS、无索引，靠内存扫描）。
//
// 存在的意义是"服务仍然可用"，不是为了性能：量级小的时候够用，量级大时应该先把 SQLite 修好。
// 两条硬性语义与 SQLite 后端一致：只读时写操作抛错；query 回传 strategy（这里只可能是 like / scan）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  StoreReadOnlyError,
  StoreUnavailableError,
  normalizeMemoryRow,
  normalizeRawRow,
  normalizeRelationRow,
  normalizeSlangRow,
  normalizeSnapshotRow,
  relationRowId,
  stableKey,
} from './store-api.js';

const FILE_MODE = 0o600;

/** 码点序比较：与 SQLite 的 BINARY 排序对齐，且不受运行时 locale 影响。 */
function cmpStr(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function atomicWrite(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // 随机后缀：同进程并发 flush（多请求同时落盘）时固定 pid 名会互相踩；失败清理 tmp。
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: FILE_MODE });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 已不存在 */ }
    throw error;
  }
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

  let data = { version: 2, memory: [], slang: [], raw: [], relation: [], relationHistory: [], snapshot: [], sessionState: [], profile: [], profileHistory: [], relationPending: [] };
  let readonly = false;

  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // 老文件没有这些数组：就地补空，不做版本升级写入（读旧写新即可）。
      if (Array.isArray(parsed?.memory)) data.memory = parsed.memory;
      if (Array.isArray(parsed?.slang)) data.slang = parsed.slang;
      if (Array.isArray(parsed?.raw)) data.raw = parsed.raw;
      if (Array.isArray(parsed?.relation)) data.relation = parsed.relation;
      if (Array.isArray(parsed?.relationHistory)) data.relationHistory = parsed.relationHistory;
      if (Array.isArray(parsed?.snapshot)) data.snapshot = parsed.snapshot;
      if (Array.isArray(parsed?.sessionState)) data.sessionState = parsed.sessionState;
      if (Array.isArray(parsed?.profile)) data.profile = parsed.profile;
      if (Array.isArray(parsed?.profileHistory)) data.profileHistory = parsed.profileHistory;
      if (Array.isArray(parsed?.relationPending)) data.relationPending = parsed.relationPending;
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
        if (opts.kind) rows = rows.filter((row) => (row.kind ?? 'episodic') === opts.kind);
        if (Array.isArray(opts.kindIn) && opts.kindIn.length) {
          rows = rows.filter((row) => opts.kindIn.includes(row.kind ?? 'episodic'));
        }
        if (opts.subjectId) rows = rows.filter((row) => row.subjectId === opts.subjectId);
        if (opts.since != null) rows = rows.filter((row) => row.createdAt >= Number(opts.since));
        if (opts.until != null) rows = rows.filter((row) => row.createdAt <= Number(opts.until));
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
        if (opts.order === 'stable' && name === 'memory') {
          // 与 SQLite 后端同一套稳定键：kind → subject → 建立时间 → id。
          rows.sort(
            (a, b) =>
              cmpStr(a.kind ?? 'episodic', b.kind ?? 'episodic') ||
              cmpStr(a.subjectId ?? '', b.subjectId ?? '') ||
              a.createdAt - b.createdAt ||
              cmpStr(a.id, b.id),
          );
        } else if (opts.order === 'recent' && name === 'memory') {
          rows.sort((a, b) => b.createdAt - a.createdAt || cmpStr(b.id, a.id));
        } else if (opts.order === 'stable' && name === 'slang') {
          rows.sort((a, b) => cmpStr(a.content, b.content) || cmpStr(a.id, b.id));
        } else if (typeof opts.scoreOf === 'function') rows.sort((a, b) => opts.scoreOf(b) - opts.scoreOf(a));
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
        if (maxEntries > 0) {
          // 与 sqlite-memory.prune 同语义：容量淘汰只在**调用方给的范围内**计数。
          // 旧实现忽略 sessionId/tier，把全局最低分的行淘汰到「本会话本层不超过
          // maxEntries」，等于按一个会话的写入把别的会话的记忆删掉。
          const inScope = (row) =>
            (!opts.sessionId || row.sessionId === opts.sessionId)
            && (!opts.tier || row.tier === opts.tier)
            && (!opts.kind || (row.kind ?? 'episodic') === opts.kind)
            && (!opts.status || row.status === opts.status);
          const scopeRows = data[name].filter(inScope);
          if (scopeRows.length > maxEntries) {
            const scoreOf = typeof opts.scoreOf === 'function' ? opts.scoreOf : (row) => row.score ?? row.lastTouchAt ?? 0;
            const sorted = [...scopeRows].sort((a, b) => scoreOf(a) - scoreOf(b));
            const victims = new Set(sorted.slice(0, scopeRows.length - maxEntries).map((row) => row.id));
            data[name] = data[name].filter((row) => !victims.has(row.id));
            result.evicted = victims.size;
          }
        }
        if (result.expired || result.evicted) flush();
        return result;
      },
      count(opts = {}) {
        return this.query({ ...opts, limit: 200 }).rows.length;
      },
    };
  }

  // --- L0 原始层（兜底实现：无 FTS，text 走子串匹配，strategy 如实报 like）---
  function rawMatches(row, opts = {}) {
    if (opts.sessionId && row.sessionId !== opts.sessionId) return false;
    if (opts.platform && row.platform !== opts.platform) return false;
    if (opts.msgId && row.msgId !== opts.msgId) return false;
    if (opts.senderId && row.senderId !== opts.senderId) return false;
    if (opts.since != null && row.createdAt < Number(opts.since)) return false;
    if (opts.until != null && row.createdAt > Number(opts.until)) return false;
    if (opts.archived === 'only') return row.archivedAt != null;
    if (!opts.includeArchived && row.archivedAt != null) return false;
    return true;
  }

  const raw = {
    get(id) {
      return byId(data.raw, id);
    },
    getByMsgId(sessionId, msgId) {
      return data.raw.find((row) => row.sessionId === sessionId && row.msgId === String(msgId)) ?? null;
    },
    append(row) {
      const r = normalizeRawRow(row);
      const existing = byId(data.raw, r.id);
      // 只追加：同一条消息重复投递原样返回旧行，绝不覆盖已存原文。
      if (existing) return { row: existing, created: false };
      data.raw.push(r);
      flush();
      return { row: r, created: true };
    },
    query(opts = {}) {
      const limit = Math.min(500, Math.max(1, Math.round(Number(opts.limit ?? 50))));
      const text = String(opts.text ?? '').trim().toLowerCase();
      let rows = data.raw.filter((row) => rawMatches(row, opts));
      if (text) rows = rows.filter((row) => String(row.text).toLowerCase().includes(text));
      rows = [...rows].sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
      return { rows: rows.slice(0, limit), strategy: text ? 'like' : 'scan' };
    },
    archive({ ids = [], at = Date.now() } = {}) {
      let archived = 0;
      for (const id of ids) {
        const row = byId(data.raw, id);
        if (!row || row.archivedAt != null) continue;
        row.archivedAt = Number(at);
        row.text = '';
        archived += 1;
      }
      if (archived) flush();
      return { archived };
    },
    purge({ id, ids, sessionId, msgId, senderId, platform } = {}) {
      const idSet = Array.isArray(ids) ? new Set(ids.map((item) => String(item ?? '').trim()).filter(Boolean)) : null;
      if (!id && !idSet?.size && !sessionId && !msgId && !senderId && !platform) {
        throw new TypeError('purge 至少需要一个过滤条件，拒绝清空整表');
      }
      const victims = data.raw
        .filter((row) => {
          if (id && row.id !== String(id)) return false;
          if (idSet?.size && !idSet.has(row.id)) return false;
          if (sessionId && row.sessionId !== sessionId) return false;
          if (msgId && row.msgId !== String(msgId)) return false;
          if (senderId && row.senderId !== String(senderId)) return false;
          if (platform && row.platform !== String(platform).toLowerCase()) return false;
          return true;
        })
        .map((row) => row.id);
      if (victims.length) {
        const set = new Set(victims);
        data.raw = data.raw.filter((row) => !set.has(row.id));
        flush();
      }
      return { removed: victims.length, ids: victims };
    },
    count(opts = {}) {
      return data.raw.filter((row) => rawMatches(row, opts)).length;
    },
  };

  // --- L2 关系/情绪（单值 + 版本链）---
  const relation = {
    get(id) {
      return byId(data.relation, id);
    },
    getByKey({ sessionId, subjectId, key, scope = 'session' } = {}) {
      return (
        data.relation.find(
          (row) =>
            row.sessionId === sessionId &&
            row.subjectId === String(subjectId) &&
            row.key === String(key) &&
            row.scope === String(scope),
        ) ?? null
      );
    },
    upsert(row, { changedAt = Date.now() } = {}) {
      const r = normalizeRelationRow(row);
      const existing = this.getByKey({
        sessionId: r.sessionId,
        subjectId: r.subjectId,
        key: r.key,
        scope: r.scope,
      });
      const pushHistory = (saved) => {
        data.relationHistory.push({
          id: `rh_${stableKey(saved.id, changedAt, saved.value).slice(0, 16)}`,
          relationId: saved.id,
          platform: saved.platform,
          value: saved.value,
          kind: saved.kind,
          changedAt,
          sourceMsgIds: r.sourceMsgIds ?? [],
          actor: r.actor ?? 'manual',
        });
      };
      if (!existing) {
        const saved = { ...r, id: r.id || relationRowId(r) };
        data.relation.push(saved);
        pushHistory(saved);
        flush();
        return { row: saved, created: true, changed: true };
      }
      const sameValue = existing.value === r.value;
      existing.value = r.value;
      existing.kind = r.kind;
      existing.importance = r.importance;
      existing.decayExempt = r.decayExempt;
      existing.confidence = r.confidence;
      existing.actor = r.actor;
      existing.lastConfirmedAt = r.lastConfirmedAt;
      existing.updatedAt = r.updatedAt;
      if (!sameValue) pushHistory(existing);
      flush();
      return { row: existing, created: false, changed: !sameValue };
    },
    list(opts = {}) {
      const limit = Math.min(200, Math.max(1, Math.round(Number(opts.limit ?? 50))));
      let rows = data.relation.filter((row) => {
        if (opts.sessionId && row.sessionId !== opts.sessionId) return false;
        if (opts.platform && row.platform !== opts.platform) return false;
        if (opts.subjectId && row.subjectId !== String(opts.subjectId)) return false;
        if (opts.kind && row.kind !== String(opts.kind)) return false;
        if (opts.scope && row.scope !== String(opts.scope)) return false;
        return true;
      });
      rows = [...rows].sort(
        (a, b) =>
          cmpStr(a.kind, b.kind) ||
          cmpStr(a.subjectId, b.subjectId) ||
          a.createdAt - b.createdAt ||
          cmpStr(a.id, b.id),
      );
      return { rows: rows.slice(0, limit), strategy: 'scan' };
    },
    history({ relationId, limit = 50 } = {}) {
      if (!relationId) return { rows: [] };
      const rows = data.relationHistory
        .filter((row) => row.relationId === String(relationId))
        .sort((a, b) => a.changedAt - b.changedAt || String(a.id).localeCompare(String(b.id)));
      return { rows: rows.slice(0, Math.max(1, Math.round(Number(limit)))) };
    },
    remove(id) {
      const before = data.relation.length;
      data.relation = data.relation.filter((row) => row.id !== String(id));
      if (data.relation.length !== before) flush();
      return data.relation.length !== before;
    },
    removeHistory({ relationId } = {}) {
      if (!relationId) throw new TypeError('removeHistory 需要 relationId');
      const before = data.relationHistory.length;
      data.relationHistory = data.relationHistory.filter((row) => row.relationId !== String(relationId));
      if (data.relationHistory.length !== before) flush();
      return before - data.relationHistory.length;
    },
    count(opts = {}) {
      return data.relation.filter((row) => {
        if (opts.sessionId && row.sessionId !== opts.sessionId) return false;
        if (opts.platform && row.platform !== opts.platform) return false;
        if (opts.kind && row.kind !== opts.kind) return false;
        return true;
      }).length;
    },
  };

  // --- head 冻结快照 ---
  const snapshot = {
    get(sessionId) {
      return data.snapshot.find((row) => row.sessionId === sessionId) ?? null;
    },
    put(row) {
      const r = normalizeSnapshotRow(row);
      const index = data.snapshot.findIndex((item) => item.sessionId === r.sessionId);
      if (index >= 0) data.snapshot[index] = r;
      else data.snapshot.push(r);
      flush();
      return r;
    },
    touch(sessionId, at = Date.now()) {
      const row = data.snapshot.find((item) => item.sessionId === sessionId);
      if (!row) return null;
      row.lastActivityAt = Number(at);
      flush();
      return row;
    },
    remove(sessionId) {
      const before = data.snapshot.length;
      data.snapshot = data.snapshot.filter((row) => row.sessionId !== sessionId);
      if (data.snapshot.length !== before) flush();
      return data.snapshot.length !== before;
    },
    count() {
      return data.snapshot.length;
    },
  };

  // --- 会话纪元（与 sqlite-session-state.js 同一套语义，行是 camelCase） ---
  const sessionState = {
    get(sessionId) {
      return data.sessionState.find((row) => row.sessionId === String(sessionId)) ?? null;
    },
    touchActivity(sessionId, { platform = '', at = Date.now() } = {}) {
      const sid = String(sessionId);
      const ts = Number(at);
      let row = data.sessionState.find((item) => item.sessionId === sid);
      if (!row) {
        row = { sessionId: sid, platform: String(platform ?? ''), epoch: 1, lastActivityAt: ts, lastSummarizedAt: null, createdAt: ts, updatedAt: ts };
        data.sessionState.push(row);
      } else {
        row.lastActivityAt = ts;
        row.updatedAt = ts;
      }
      flush();
      return row;
    },
    /** CAS：expect 不匹配（已被推进）返回 null，与 SQLite 后端同语义。 */
    advanceEpoch(sessionId, { expect, at = Date.now() } = {}) {
      const row = data.sessionState.find((item) => item.sessionId === String(sessionId));
      if (!row || row.epoch !== Number(expect)) return null;
      row.epoch += 1;
      row.updatedAt = Number(at);
      flush();
      return row;
    },
    markSummarized(sessionId, { at = Date.now(), summarizedUpTo } = {}) {
      const row = data.sessionState.find((item) => item.sessionId === String(sessionId));
      if (!row) return null;
      row.lastSummarizedAt = Number(summarizedUpTo ?? at);
      row.updatedAt = Number(at);
      flush();
      return row;
    },
    listIdle({ olderThan = 0, limit = 100 } = {}) {
      return data.sessionState
        .filter((row) => row.lastActivityAt <= Number(olderThan))
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
        .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    },
    count() {
      return data.sessionState.length;
    },
  };

  // --- 关系冲突待确认池（与 sqlite-relation-pending.js 同一套语义） ---
  const relationPending = {
    get(id) {
      return data.relationPending.find((row) => row.id === String(id)) ?? null;
    },
    find({ sessionId, subjectId, key, value } = {}) {
      return data.relationPending.find((row) => row.sessionId === String(sessionId)
        && row.subjectId === String(subjectId)
        && row.key === String(key)
        && row.value === String(value)) ?? null;
    },
    put({ sessionId, subjectId, key, value, kind = 'relation', confidence, sourceMsgIds = [], windowHash = '', at = Date.now() } = {}) {
      const sid = String(sessionId);
      const found = this.find({ sessionId: sid, subjectId, key, value });
      if (found && found.status !== 'pending') return found;
      const crossWindow = Boolean(found && found.windowHash && windowHash && found.windowHash !== windowHash);
      const row = {
        id: found?.id ?? `rp_${stableKey(`${sid}\u0000${subjectId}\u0000${key}\u0000${value}`, 0, '').slice(0, 20)}`,
        sessionId: sid,
        platform: sid.split(':')[0] ?? '',
        subjectId: String(subjectId),
        key: String(key),
        value: String(value),
        kind: kind === 'emotion' ? 'emotion' : 'relation',
        confidence: Math.max(Number(confidence) || 0, found?.confidence ?? 0),
        sourceMsgIds: [...new Set([...(found?.sourceMsgIds ?? []), ...sourceMsgIds])].slice(0, 50),
        windowHash: String(windowHash),
        windowsSeen: (found?.windowsSeen ?? 1) + (crossWindow ? 1 : 0),
        status: 'pending',
        createdAt: found?.createdAt ?? Number(at),
        updatedAt: Number(at),
      };
      if (found) Object.assign(found, row);
      else data.relationPending.push(row);
      flush();
      return row;
    },
    list({ status = 'pending', sessionId, limit = 100 } = {}) {
      return data.relationPending
        .filter((row) => row.status === String(status) && (!sessionId || row.sessionId === String(sessionId)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    },
    setStatus(id, status, { at = Date.now() } = {}) {
      const row = this.get(id);
      if (!row) return null;
      row.status = String(status);
      row.updatedAt = Number(at);
      flush();
      return row;
    },
    remove(id) {
      const before = data.relationPending.length;
      data.relationPending = data.relationPending.filter((row) => row.id !== String(id));
      if (data.relationPending.length !== before) flush();
      return data.relationPending.length !== before;
    },
    count() {
      return data.relationPending.length;
    },
  };

  // --- 人物画像（与 sqlite-profile.js 同一套语义，行是 camelCase） ---
  const profile = {
    get(sessionId, subjectId) {
      if (!subjectId) return null;
      return data.profile.find((row) => row.sessionId === String(sessionId) && row.subjectId === String(subjectId)) ?? null;
    },
    list(sessionId) {
      return data.profile
        .filter((row) => row.sessionId === String(sessionId))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    put({ sessionId, subjectId, platform = '', attributes, confidence, sourceMsgIds = [], version, at = Date.now() }) {
      const sid = String(sessionId);
      const subject = String(subjectId);
      const ts = Number(at);
      const anchors = (sourceMsgIds ?? []).slice(0, 200);
      let row = data.profile.find((item) => item.sessionId === sid && item.subjectId === subject);
      const snapshotRow = { attributes: { ...(attributes ?? {}) }, confidence: Number(confidence), sourceMsgIds: anchors, version: Number(version) };
      if (!row) {
        row = { sessionId: sid, platform: String(platform ?? ''), subjectId: subject, ...snapshotRow, createdAt: ts, updatedAt: ts };
        data.profile.push(row);
      } else {
        Object.assign(row, { platform: String(platform ?? ''), ...snapshotRow, updatedAt: ts });
      }
      data.profileHistory.push({ id: `pfh:${sid}:${subject}:${snapshotRow.version}`, sessionId: sid, subjectId: subject, ...snapshotRow, changedAt: ts });
      flush();
      return row;
    },
    history(sessionId, subjectId, { limit = 20 } = {}) {
      return data.profileHistory
        .filter((row) => row.sessionId === String(sessionId) && row.subjectId === String(subjectId))
        .sort((a, b) => b.version - a.version)
        .slice(0, Math.max(1, Number(limit) || 20));
    },
    remove(sessionId, subjectId) {
      const sid = String(sessionId);
      const subject = String(subjectId);
      const before = data.profile.length;
      data.profile = data.profile.filter((row) => !(row.sessionId === sid && row.subjectId === subject));
      data.profileHistory = data.profileHistory.filter((row) => !(row.sessionId === sid && row.subjectId === subject));
      flush();
      return data.profile.length < before;
    },
    count() {
      return data.profile.length;
    },
  };

  return {
    backend: 'json',
    degraded: true,
    schemaVersion: null,
    get readonly() {
      return readonly;
    },
    path: filePath,
    memory: makeCollection('memory', (row) => normalizeMemoryRow(row)),
    slang: makeCollection('slang', (row) => normalizeSlangRow(row)),
    raw,
    relation,
    snapshot,
    sessionState,
    profile,
    relationPending,
    // 兜底后端没有真正的原子事务：不假装能回滚，调用方仍可用（写入不会留半条，flush 是整文件重写）。
    // 但异步回调一律拒绝：await 期间的写入已经落到内存/文件，调用方以为「失败了会回滚」，
    // 实际是半写状态 —— 与 sqlite 后端保持同一约束，迁移时才不会踩坑。
    transaction(fn) {
      const result = fn();
      if (result && (typeof result === 'object' || typeof result === 'function')
        && typeof result.then === 'function') {
        throw new TypeError('transaction 回调必须是同步函数（JSON 兜底后端同样不支持异步事务）');
      }
      return result;
    },
    /** 与 SQLite 后端同形状的平台统计（兜底后端也要能回答「有哪些平台的数据」）。 */
    platformStats() {
      const out = new Map();
      const bump = (platform, name, n) => {
        const key = String(platform ?? '');
        if (!key) return;
        if (!out.has(key)) out.set(key, { platform: key, memory: 0, raw: 0, relation: 0, snapshot: 0 });
        out.get(key)[name] += n;
      };
      for (const row of data.memory) bump(row.platform, 'memory', 1);
      for (const row of data.raw) bump(row.platform, 'raw', 1);
      for (const row of data.relation) bump(row.platform, 'relation', 1);
      for (const row of data.snapshot) bump(row.platform, 'snapshot', 1);
      return [...out.values()].sort((a, b) => cmpStr(a.platform, b.platform));
    },
    stats() {
      return {
        memory: data.memory.length,
        slang: data.slang.length,
        raw: data.raw.length,
        relation: data.relation.length,
        snapshot: data.snapshot.length,
        sessionState: data.sessionState.length,
        profile: data.profile.length,
        relationPending: data.relationPending.length,
        readonly,
        schemaVersion: null,
        degraded: true,
      };
    },
    close() {
      /* JSON 后端每次写都落盘，无需关闭动作 */
    },
  };
}
