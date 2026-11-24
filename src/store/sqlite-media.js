// media_asset 集合的 SQL 实现（多媒体记忆层详情表）。
// 与 sqlite-slang.js 同风格：原语 get/put/remove/query/count；组合语义
// （ensureByRef/updateDesc/markUsed/scanPending）在 service 层用原语组合，
// 保证 JSON 兜底后端同一套 service 代码可用。
import { normalizeMediaRow } from './store-api.js';
import { mediaFromRow } from './sqlite-schema.js';
import { ftsPhrase, ftsQueryable, likePattern } from './sqlite-text.js';

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function createMediaCollection({ db, usable, writable, prepare }) {
  function refreshFts(row) {
    prepare('ftsMedDel', 'DELETE FROM media_fts WHERE id = ?').run(row.id);
    prepare('ftsMedIns', 'INSERT INTO media_fts(desc, tags, id) VALUES (?, ?, ?)').run(
      row.desc,
      row.tags.join(' '),
      row.id,
    );
  }

  function dropFts(id) {
    prepare('ftsMedDel', 'DELETE FROM media_fts WHERE id = ?').run(id);
  }

  function get(id) {
    if (!usable()) return null;
    const row = prepare('medGet', 'SELECT * FROM media_asset WHERE id = ?').get(String(id));
    return mediaFromRow(row);
  }

  function put(row) {
    writable();
    const r = normalizeMediaRow(row);
    const existing = get(r.id);
    const createdAt = existing?.createdAt ?? r.createdAt;
    prepare(
      'medPut',
      `INSERT INTO media_asset (id, session_id, platform, kind, source_path, hash, origin, ref,
         send_hints, desc, tags, text_content, duration_ms, status, use_count, last_used_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id, platform = excluded.platform,
         kind = excluded.kind, source_path = excluded.source_path, hash = excluded.hash,
         origin = excluded.origin, ref = excluded.ref, send_hints = excluded.send_hints,
         desc = excluded.desc, tags = excluded.tags, text_content = excluded.text_content,
         duration_ms = excluded.duration_ms, status = excluded.status,
         use_count = excluded.use_count, last_used_at = excluded.last_used_at,
         updated_at = excluded.updated_at
         -- favorited 不在 upsert 更新列：登记/重放幂等补元数据时不动（favorited 列已弃用——收藏语义重设计）
       `,
    ).run(
      r.id,
      r.sessionId,
      r.platform,
      r.kind,
      r.sourcePath,
      r.hash,
      r.origin,
      r.ref,
      JSON.stringify(r.sendHints),
      r.desc,
      JSON.stringify(r.tags),
      r.textContent,
      r.durationMs,
      r.status,
      r.useCount,
      r.lastUsedAt,
      createdAt,
      r.updatedAt,
    );
    refreshFts(r);
    return get(r.id);
  }

  function remove(id) {
    writable();
    const changes = prepare('medDel', 'DELETE FROM media_asset WHERE id = ?').run(String(id)).changes ?? 0;
    dropFts(String(id));
    return changes > 0;
  }

  function query(opts = {}) {
    const limit = clampInt(opts.limit, 1, 200, 20);
    if (!usable()) return { rows: [], strategy: 'scan' };

    const where = [];
    const params = [];
    if (opts.status) {
      where.push('m.status = ?');
      params.push(String(opts.status));
    }
    if (opts.sessionId) {
      where.push('m.session_id = ?');
      params.push(String(opts.sessionId));
    }
    if (opts.kind) {
      where.push('m.kind = ?');
      params.push(String(opts.kind));
    }
    if (opts.hash) {
      where.push('m.hash = ?');
      params.push(String(opts.hash));
    }
    // favOnly 过滤分支已退役（媒体管道 v3 收藏语义重设计）：「被记住」= status='ready'，
    // 由调用方直接传 status 过滤；favorited 列保留弃用。
    const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';
    const text = String(opts.text ?? '').trim();

    if (text && ftsQueryable(text)) {
      try {
        const sql = `SELECT m.* FROM media_fts JOIN media_asset AS m ON m.id = media_fts.id
                     WHERE media_fts MATCH ? ${whereSql}
                     ORDER BY bm25(media_fts) LIMIT ?`;
        const rows = db.prepare(sql).all(ftsPhrase(text), ...params, limit);
        return { rows: rows.map(mediaFromRow), strategy: 'fts5' };
      } catch {
        // FTS 不可用就降级，不让查询失败（与 slang 同策略）。
      }
    }

    if (text) {
      where.push("(m.desc LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\' OR m.ref LIKE ? ESCAPE '\\')");
      params.push(likePattern(text), likePattern(text), likePattern(text));
    }
    // 稳定序供 head 渲染（渲染 head 必须换稳定键，与 slang 同纪律）。
    const orderSql =
      opts.order === 'stable'
        ? 'ORDER BY m.id ASC'
      : opts.order === 'oldest'
        ? 'ORDER BY m.created_at ASC, m.id ASC'
        : 'ORDER BY m.use_count DESC, m.updated_at DESC';
    const finalSql = `SELECT * FROM media_asset AS m ${where.length ? `WHERE ${where.join(' AND ')}` : ""}
                      ${orderSql} LIMIT ?`;
    const rows = db.prepare(finalSql).all(...params, limit).map(mediaFromRow);
    return { rows, strategy: text ? 'like' : 'scan' };
  }

  function count(opts = {}) {
    if (!usable()) return 0;
    const where = [];
    const params = [];
    if (opts.status) {
      where.push('status = ?');
      params.push(String(opts.status));
    }
    if (opts.sessionId) {
      where.push('session_id = ?');
      params.push(String(opts.sessionId));
    }
    const sql = `SELECT COUNT(*) AS n FROM media_asset ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    return Number(db.prepare(sql).get(...params)?.n ?? 0);
  }

  // setFavorite 已退役（收藏语义重设计——favorited 列保留弃用）
  return { get, put, remove, query, count };
}