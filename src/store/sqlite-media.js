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
      `INSERT INTO media_asset (id, session_id, platform, kind, source_path, hash, origin,
         send_hints, desc, tags, text_content, duration_ms, status, use_count, last_used_at,
         phash, merged_into, is_sticker, favorited, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id, platform = excluded.platform,
         kind = excluded.kind, source_path = excluded.source_path, hash = excluded.hash,
         origin = excluded.origin, send_hints = excluded.send_hints,
         desc = excluded.desc, tags = excluded.tags, text_content = excluded.text_content,
         duration_ms = excluded.duration_ms, status = excluded.status,
         use_count = excluded.use_count, last_used_at = excluded.last_used_at,
         phash = excluded.phash, merged_into = excluded.merged_into,
         is_sticker = excluded.is_sticker, favorited = excluded.favorited,
         updated_at = excluded.updated_at
       `,
    ).run(
      r.id,
      r.sessionId,
      r.platform,
      r.kind,
      r.sourcePath,
      r.hash,
      r.origin,
      JSON.stringify(r.sendHints),
      r.desc,
      JSON.stringify(r.tags),
      r.textContent,
      r.durationMs,
      r.status,
      r.useCount,
      r.lastUsedAt,
      r.phash,
      r.mergedInto,
      r.isSticker ? 1 : 0,
      r.favorited ? 1 : 0,
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
    if (opts.stickerOnly) {
      where.push('m.is_sticker = 1');
    }
    // 归并变体默认不出现在检索面（与主资产重复；media_describe 单查 get() 不受限）。
    if (!opts.includeMerged) {
      where.push("m.merged_into = ''");
    }
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
      // ref 列已退役（v8，路径唯一真值=source_path）：LIKE 检索只留 desc/tags。
      where.push("(m.desc LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\')");
      params.push(likePattern(text), likePattern(text));
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

  // setFavorite 已退役（收藏语义重设计——favorited 列已随 v6 迁移删除）
  // pHash 近邻候选（表情库近似匹配）：暴力扫描，表情库几千规模微秒级，无需向量索引。
  // 只扫未归并资产（变体已并入主资产）；距离计算在 service 层（hamming 来自 image-phash.js）。
  function phashCandidates(limit = 5000) {
    if (!usable()) return [];
    const sql = `SELECT * FROM media_asset WHERE phash != '' AND merged_into = ''
                 ORDER BY use_count DESC LIMIT ?`;
    return db.prepare(sql).all(Math.max(1, Math.min(20000, Math.round(limit)))).map(mediaFromRow);
  }
  return { get, put, remove, query, count, phashCandidates };
}