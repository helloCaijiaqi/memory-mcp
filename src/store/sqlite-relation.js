// L2 语义关系层的 SQL 实现：单值 + 版本链。
//
// 两条不可省的语义：
//   1. 同一 (session_id, subject_id, key, scope) 只有一行 —— 模型问「现在是什么」必须有唯一答案，
//      不能靠「按时间取最新一条」在应用层猜。
//   2. 值真正变化时才写 history —— 同值重复上报（模型每轮都可能重复确认一次称呼）不该污染变更链。
import { normalizeRelationRow, stableKey } from './store-api.js';
import { relationFromRow, relationHistoryFromRow } from './sqlite-schema.js';
import { normalizeSessionId } from '../session-id.js';

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

function parseIds(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function createRelationCollection({ db, usable, writable, prepare }) {
  function get(id) {
    if (!usable()) return null;
    return relationFromRow(prepare('relGet', 'SELECT * FROM relation WHERE id = ?').get(String(id)));
  }

  function getByKey({ sessionId, subjectId, key, scope = 'session' } = {}) {
    if (!usable()) return null;
    return relationFromRow(
      prepare(
        'relGetByKey',
        'SELECT * FROM relation WHERE session_id = ? AND subject_id = ? AND key = ? AND scope = ?',
      ).get(normalizeSessionId(sessionId), String(subjectId), String(key), String(scope)),
    );
  }

  function writeHistory(row, { changedAt = Date.now(), sourceMsgIds = [], actor = 'manual' } = {}) {
    const ids = parseIds(sourceMsgIds).slice(0, 50);
    prepare(
      'relHistPut',
      `INSERT INTO relation_history (id, relation_id, platform, value, kind, changed_at, source_msg_ids, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `rh_${stableKey(row.id, changedAt, row.value).slice(0, 16)}`,
      row.id,
      row.platform,
      row.value,
      row.kind,
      changedAt,
      JSON.stringify(ids),
      String(actor ?? 'manual'),
    );
  }

  /**
   * 写入当前值。返回 { row, created, changed }：
   *   created=true  —— 新建（同时写第一条历史，保证「历史最后一条 == 当前值」这个不变量）
   *   changed=true  —— 值变了（写一条历史）
   *   两者都 false —— 值没变（只更新 importance / decayExempt / updated_at）
   */
  function upsert(row, { changedAt = Date.now() } = {}) {
    writable();
    const r = normalizeRelationRow(row);
    const existing = getByKey({
      sessionId: r.sessionId,
      subjectId: r.subjectId,
      key: r.key,
      scope: r.scope,
    });

    if (!existing) {
      prepare(
        'relPut',
        `INSERT INTO relation (id, session_id, platform, subject_id, key, value, kind, scope,
                               importance, decay_exempt, confidence, actor, last_confirmed_at,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           value = excluded.value, kind = excluded.kind, importance = excluded.importance,
           decay_exempt = excluded.decay_exempt, confidence = excluded.confidence,
           actor = excluded.actor, last_confirmed_at = excluded.last_confirmed_at,
           updated_at = excluded.updated_at`,
      ).run(
        r.id,
        r.sessionId,
        r.platform,
        r.subjectId,
        r.key,
        r.value,
        r.kind,
        r.scope,
        r.importance,
        r.decayExempt ? 1 : 0,
        r.confidence,
        r.actor,
        r.lastConfirmedAt,
        r.createdAt,
        r.updatedAt,
      );
      const saved = get(r.id);
      writeHistory(saved, { changedAt, sourceMsgIds: r.sourceMsgIds, actor: r.actor });
      return { row: saved, created: true, changed: true };
    }

    const sameValue = existing.value === r.value;
    prepare(
      'relUpdate',
      `UPDATE relation SET value = ?, kind = ?, importance = ?, decay_exempt = ?,
                           confidence = ?, actor = ?, last_confirmed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(r.value, r.kind, r.importance, r.decayExempt ? 1 : 0, r.confidence, r.actor, r.lastConfirmedAt, r.updatedAt, existing.id);
    const saved = get(existing.id);
    if (!sameValue) writeHistory(saved, { changedAt, sourceMsgIds: r.sourceMsgIds, actor: r.actor });
    return { row: saved, created: false, changed: !sameValue };
  }

  /** 稳定排序：kind → subject → 建立时间 → id。渲染 head 时不能按分数排（分数每轮都变）。 */
  function list(opts = {}) {
    const limit = clampInt(opts.limit, 1, 200, 50);
    if (!usable()) return { rows: [], strategy: 'scan' };
    const where = [];
    const params = [];
    if (opts.sessionId) {
      where.push('session_id = ?');
      params.push(normalizeSessionId(opts.sessionId));
    }
    if (opts.platform) {
      where.push('platform = ?');
      params.push(String(opts.platform).toLowerCase());
    }
    if (opts.subjectId) {
      where.push('subject_id = ?');
      params.push(String(opts.subjectId));
    }
    if (opts.kind) {
      where.push('kind = ?');
      params.push(String(opts.kind));
    }
    if (opts.scope) {
      where.push('scope = ?');
      params.push(String(opts.scope));
    }
    const sql = `SELECT * FROM relation ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY kind ASC, subject_id ASC, created_at ASC, id ASC LIMIT ?`;
    return { rows: db.prepare(sql).all(...params, limit).map(relationFromRow), strategy: 'scan' };
  }

  function history({ relationId, limit = 50 } = {}) {
    if (!usable() || !relationId) return { rows: [] };
    const rows = db
      .prepare(
        `SELECT * FROM relation_history WHERE relation_id = ?
         ORDER BY changed_at ASC, id ASC LIMIT ?`,
      )
      .all(String(relationId), clampInt(limit, 1, 500, 50));
    return { rows: rows.map(relationHistoryFromRow) };
  }

  function remove(id) {
    writable();
    const changes = prepare('relDel', 'DELETE FROM relation WHERE id = ?').run(String(id)).changes ?? 0;
    return changes > 0;
  }

  /**
   * 删掉某条关系的版本链。被遗忘权要求「连历史一起忘」：
   * 只删当前值而把旧值留在 relation_history 里，等于假装忘了。
   */
  function removeHistory({ relationId } = {}) {
    writable();
    if (!relationId) throw new TypeError('removeHistory 需要 relationId');
    return Number(prepare('relHistDel', 'DELETE FROM relation_history WHERE relation_id = ?').run(String(relationId)).changes ?? 0);
  }

  function count(opts = {}) {
    if (!usable()) return 0;
    const where = [];
    const params = [];
    if (opts.sessionId) {
      where.push('session_id = ?');
      params.push(normalizeSessionId(opts.sessionId));
    }
    if (opts.platform) {
      where.push('platform = ?');
      params.push(String(opts.platform).toLowerCase());
    }
    if (opts.kind) {
      where.push('kind = ?');
      params.push(String(opts.kind));
    }
    const sql = `SELECT COUNT(*) AS n FROM relation ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    return Number(db.prepare(sql).get(...params)?.n ?? 0);
  }

  return { get, getByKey, upsert, list, history, remove, removeHistory, count };
}
