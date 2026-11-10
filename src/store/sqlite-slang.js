// slang 集合的 SQL 实现（黑话/网络用语词条）。
import { normalizeSlangRow } from './store-api.js';
import { slangFromRow } from './sqlite-schema.js';
import { ftsPhrase, ftsQueryable, likePattern } from './sqlite-text.js';

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function createSlangCollection({ db, usable, writable, prepare }) {
  function refreshFts(row) {
    prepare('ftsSlgDel', 'DELETE FROM slang_fts WHERE id = ?').run(row.id);
    prepare('ftsSlgIns', 'INSERT INTO slang_fts(content, meaning, id) VALUES (?, ?, ?)').run(
      row.content,
      row.meaning,
      row.id,
    );
  }

  function dropFts(id) {
    prepare('ftsSlgDel', 'DELETE FROM slang_fts WHERE id = ?').run(id);
  }

  function get(id) {
    if (!usable()) return null;
    const row = prepare('slgGet', 'SELECT * FROM slang WHERE id = ?').get(String(id));
    return slangFromRow(row);
  }

  function put(row) {
    writable();
    const r = normalizeSlangRow(row);
    const existing = get(r.id);
    const createdAt = existing?.createdAt ?? r.createdAt;
    // 证据合并：已确认的词条再次出现时，旧证据保留（去重），只追加新证据。
    const evidence = existing
      ? [...new Set([...existing.evidence, ...r.evidence])].slice(0, 20)
      : r.evidence;
    prepare(
      'slgPut',
      `INSERT INTO slang (id, content, meaning, status, evidence, score, hits, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content, meaning = excluded.meaning, status = excluded.status,
         evidence = excluded.evidence, score = excluded.score, hits = excluded.hits,
         updated_at = excluded.updated_at`,
    ).run(
      r.id,
      r.content,
      r.meaning,
      r.status,
      JSON.stringify(evidence),
      r.score,
      r.hits,
      createdAt,
      r.updatedAt,
    );
    refreshFts({ ...r, evidence });
    return get(r.id);
  }

  function remove(id) {
    writable();
    const changes = prepare('slgDel', 'DELETE FROM slang WHERE id = ?').run(String(id)).changes ?? 0;
    dropFts(String(id));
    return changes > 0;
  }

  function query(opts = {}) {
    const limit = clampInt(opts.limit, 1, 200, 20);
    if (!usable()) return { rows: [], strategy: 'scan' };

    const where = [];
    const params = [];
    if (opts.status) {
      where.push('s.status = ?');
      params.push(String(opts.status));
    }
    const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const text = String(opts.text ?? '').trim();

    if (text && ftsQueryable(text)) {
      try {
        const sql = `SELECT s.* FROM slang_fts JOIN slang AS s ON s.id = slang_fts.id
                     WHERE slang_fts MATCH ? ${whereSql}
                     ORDER BY bm25(slang_fts) LIMIT ?`;
        const rows = db.prepare(sql).all(ftsPhrase(text), ...params, limit);
        return { rows: rows.map(slangFromRow), strategy: 'fts5' };
      } catch {
        // 同上：FTS 不可用就降级，不让查询失败。
      }
    }

    if (text) {
      where.push("(s.content LIKE ? ESCAPE '\\' OR s.meaning LIKE ? ESCAPE '\\')");
      params.push(likePattern(text), likePattern(text));
    }
    // 稳定序供 head 渲染：黑话是按 score 排序的，命中数一变 head 就抖 —— 渲染 head 时必须换稳定键。
    const orderSql =
      opts.order === 'stable'
        ? 'ORDER BY s.content ASC, s.id ASC'
        : 'ORDER BY s.score DESC, s.hits DESC, s.updated_at DESC';
    const finalSql = `SELECT * FROM slang AS s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                      ${orderSql} LIMIT ?`;
    const rows = db.prepare(finalSql).all(...params, limit).map(slangFromRow);
    void sqlWhere;
    return { rows, strategy: text ? 'like' : 'scan' };
  }

  /** 上限淘汰：按 scoreOf 升序淘汰最低分（默认用表内 score）。 */
  function prune(opts = {}) {
    if (!usable()) return { evicted: 0 };
    writable();
    const maxEntries = Number(opts.maxEntries ?? 0);
    if (maxEntries <= 0) return { evicted: 0 };
    const rows = db.prepare('SELECT id, score, hits, status, updated_at FROM slang').all();
    if (rows.length <= maxEntries) return { evicted: 0 };
    const scoreOf = typeof opts.scoreOf === 'function' ? opts.scoreOf : (row) => row.score;
    const victims = [...rows].sort((a, b) => scoreOf(a) - scoreOf(b)).slice(0, rows.length - maxEntries);
    let evicted = 0;
    for (const row of victims) {
      prepare('slgDel', 'DELETE FROM slang WHERE id = ?').run(row.id);
      dropFts(row.id);
      evicted += 1;
    }
    return { evicted };
  }

  function count(opts = {}) {
    if (!usable()) return 0;
    const where = [];
    const params = [];
    if (opts.status) {
      where.push('status = ?');
      params.push(String(opts.status));
    }
    const sql = `SELECT COUNT(*) AS n FROM slang ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    return Number(db.prepare(sql).get(...params)?.n ?? 0);
  }

  return { get, put, remove, query, prune, count };
}
