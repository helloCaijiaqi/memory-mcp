// L0 原始层的 SQL 实现。只追加：同一条消息重复投递不会覆盖已存的原文。
//
// 为什么单独一张表而不是塞进 memory：
//   memory 行会被淘汰/归档/改写（hits、lastTouchAt、tier 都在变），而原始层必须逐字节稳定，
//   它的价值就是「别的都错了还能回到这里」。两者的生命周期完全不同。
import { normalizeRawRow } from './store-api.js';
import { rawFromRow } from './sqlite-schema.js';
import { normalizeSessionId } from '../session-id.js';
import { ftsPhrase, ftsQueryable, likePattern } from './sqlite-text.js';

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function createRawCollection({ db, usable, writable, prepare }) {
  function refreshFts(row) {
    prepare('rawFtsDel', 'DELETE FROM raw_fts WHERE id = ?').run(row.id);
    // 归档后正文被清空：FTS 里留着空串只会拖慢检索，直接不建索引。
    if (!row.text) return;
    prepare('rawFtsIns', 'INSERT INTO raw_fts(text, id) VALUES (?, ?)').run(row.text, row.id);
  }

  function dropFts(id) {
    prepare('rawFtsDel', 'DELETE FROM raw_fts WHERE id = ?').run(id);
  }

  function get(id) {
    if (!usable()) return null;
    return rawFromRow(prepare('rawGet', 'SELECT * FROM raw_message WHERE id = ?').get(String(id)));
  }

  function getByMsgId(sessionId, msgId) {
    if (!usable()) return null;
    return rawFromRow(
      prepare('rawGetByMsg', 'SELECT * FROM raw_message WHERE session_id = ? AND msg_id = ?').get(
        normalizeSessionId(sessionId),
        String(msgId),
      ),
    );
  }

  /**
   * 追加一条原始消息。返回 { row, created }：
   *   created=false 表示这条 (sessionId, msgId) 已经在库里，原样返回旧行（不刷新、不覆盖）。
   */
  function append(row) {
    writable();
    const r = normalizeRawRow(row);
    const existing = get(r.id);
    if (existing) return { row: existing, created: false };
    prepare(
      'rawPut',
      `INSERT INTO raw_message (id, session_id, platform, msg_id, sender_id, kind, text, meta,
                                anchor, created_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      r.id,
      r.sessionId,
      r.platform,
      r.msgId,
      r.senderId,
      r.kind,
      r.text,
      r.meta,
      r.anchor,
      r.createdAt,
      r.archivedAt,
    );
    refreshFts(r);
    return { row: get(r.id), created: true };
  }

  function buildWhere(opts, params) {
    const where = [];
    if (opts.sessionId) {
      where.push('r.session_id = ?');
      params.push(normalizeSessionId(opts.sessionId));
    }
    if (opts.platform) {
      where.push('r.platform = ?');
      params.push(String(opts.platform).toLowerCase());
    }
    if (opts.msgId) {
      where.push('r.msg_id = ?');
      params.push(String(opts.msgId));
    }
    if (opts.senderId) {
      where.push('r.sender_id = ?');
      params.push(String(opts.senderId));
    }
    if (opts.since != null) {
      where.push('r.created_at >= ?');
      params.push(clampInt(opts.since, 0, Number.MAX_SAFE_INTEGER, 0));
    }
    if (opts.until != null) {
      where.push('r.created_at <= ?');
      params.push(clampInt(opts.until, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
    }
    if (opts.archived === 'only') where.push('r.archived_at IS NOT NULL');
    else if (!opts.includeArchived) where.push('r.archived_at IS NULL');
    return where;
  }

  function query(opts = {}) {
    const limit = clampInt(opts.limit, 1, 500, 50);
    if (!usable()) return { rows: [], strategy: 'scan' };
    const where = [];
    const params = [];
    const filters = buildWhere(opts, params);
    where.push(...filters);
    const text = String(opts.text ?? '').trim();

    if (text && ftsQueryable(text)) {
      try {
        const sql = `SELECT r.* FROM raw_fts JOIN raw_message AS r ON r.id = raw_fts.id
                     WHERE raw_fts.text MATCH ? ${where.length ? `AND ${where.join(' AND ')}` : ''}
                     ORDER BY bm25(raw_fts) LIMIT ?`;
        const rows = db.prepare(sql).all(ftsPhrase(text), ...params, limit);
        return { rows: rows.map(rawFromRow), strategy: 'fts5' };
      } catch {
        // FTS 语法/索引异常：落到 LIKE，不让查询失败。
      }
    }

    if (text) {
      where.push("r.text LIKE ? ESCAPE '\\'");
      params.push(likePattern(text));
    }
    const sql = `SELECT r.* FROM raw_message AS r ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY r.created_at ASC, r.id ASC LIMIT ?`;
    return { rows: db.prepare(sql).all(...params, limit).map(rawFromRow), strategy: text ? 'like' : 'scan' };
  }

  /** 标记归档并清空正文（元数据与锚点保留，回溯用）。 */
  function archive({ ids = [], at = Date.now() } = {}) {
    writable();
    const archivedAt = clampInt(at, 0, Number.MAX_SAFE_INTEGER, Date.now());
    let archived = 0;
    for (const id of ids) {
      const row = get(id);
      if (!row || row.archivedAt != null) continue;
      prepare('rawArchive', 'UPDATE raw_message SET archived_at = ?, text = ? WHERE id = ?').run(
        archivedAt,
        '',
        row.id,
      );
      dropFts(row.id);
      archived += 1;
    }
    return { archived };
  }

  /** 硬删除：被遗忘权。按 id / 消息 / 发送者 / 平台 四选一（可叠加）；ids 用于分批精确删除。 */
  function purge({ id, ids: idsIn, sessionId, msgId, senderId, platform } = {}) {
    writable();
    const where = [];
    const params = [];
    if (id) {
      where.push('id = ?');
      params.push(String(id));
    }
    const idList = Array.isArray(idsIn) ? idsIn.map((item) => String(item ?? '').trim()).filter(Boolean) : [];
    if (idList.length) {
      where.push(`id IN (${idList.map(() => '?').join(', ')})`);
      params.push(...idList);
    }
    if (sessionId) {
      where.push('session_id = ?');
      params.push(normalizeSessionId(sessionId));
    }
    if (msgId) {
      where.push('msg_id = ?');
      params.push(String(msgId));
    }
    if (senderId) {
      where.push('sender_id = ?');
      params.push(String(senderId));
    }
    if (platform) {
      where.push('platform = ?');
      params.push(String(platform).toLowerCase());
    }
    if (!where.length) throw new TypeError('purge 至少需要一个过滤条件，拒绝清空整表');
    const ids = db
      .prepare(`SELECT id FROM raw_message WHERE ${where.join(' AND ')}`)
      .all(...params)
      .map((row) => row.id);
    for (const rowId of ids) {
      prepare('rawDel', 'DELETE FROM raw_message WHERE id = ?').run(rowId);
      dropFts(rowId);
    }
    return { removed: ids.length, ids };
  }

  function count(opts = {}) {
    if (!usable()) return 0;
    const params = [];
    const where = buildWhere(opts, params);
    const sql = `SELECT COUNT(*) AS n FROM raw_message AS r ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    return Number(db.prepare(sql).get(...params)?.n ?? 0);
  }

  return { get, getByMsgId, append, query, archive, purge, count };
}
