// memory 集合的 SQL 实现。对外只暴露 store-api.js 约定的那几个动词。
import { normalizeMemoryRow } from './store-api.js';
import { normalizeSessionId } from '../session-id.js';
import { memoryFromRow } from './sqlite-schema.js';
import { ftsPhrase, ftsQueryable, likePattern } from './sqlite-text.js';

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function createMemoryCollection({ db, usable, writable, prepare }) {
  function refreshFts(row) {
    prepare('ftsMemDel', 'DELETE FROM memory_fts WHERE id = ?').run(row.id);
    prepare('ftsMemIns', 'INSERT INTO memory_fts(content, id) VALUES (?, ?)').run(row.content, row.id);
  }

  function dropFts(id) {
    prepare('ftsMemDel', 'DELETE FROM memory_fts WHERE id = ?').run(id);
  }

  function get(id) {
    if (!usable()) return null;
    const row = prepare('memGet', 'SELECT * FROM memory WHERE id = ?').get(String(id));
    return memoryFromRow(row);
  }

  function put(row) {
    writable();
    const r = normalizeMemoryRow(row);
    const existing = get(r.id);
    const createdAt = existing?.createdAt ?? r.createdAt;
    prepare(
      'memPut',
      `INSERT INTO memory (id, session_id, platform, tier, category, content, extra, importance,
                           base_weight, hits, status, created_at, updated_at, last_touch_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id, platform = excluded.platform, tier = excluded.tier,
         category = excluded.category, content = excluded.content, extra = excluded.extra,
         importance = excluded.importance, base_weight = excluded.base_weight, hits = excluded.hits,
         status = excluded.status, updated_at = excluded.updated_at,
         last_touch_at = excluded.last_touch_at, expires_at = excluded.expires_at`,
    ).run(
      r.id,
      r.sessionId,
      r.platform,
      r.tier,
      r.category,
      r.content,
      r.extra,
      r.importance,
      r.baseWeight,
      r.hits,
      r.status,
      createdAt,
      r.updatedAt,
      r.lastTouchAt,
      r.expiresAt,
    );
    refreshFts(r);
    return get(r.id);
  }

  function remove(id) {
    writable();
    const changes = prepare('memDel', 'DELETE FROM memory WHERE id = ?').run(String(id)).changes ?? 0;
    dropFts(String(id));
    return changes > 0;
  }

  /**
   * 查询。返回 { rows, strategy }：
   *   strategy='fts5' —— 走了 FTS5 全文检索（按相关度排序）
   *   strategy='like' —— 查询词太短（trigram 下限）或 FTS 异常，降级为 LIKE 子串匹配
   *   strategy='scan' —— 没有查询词，按最近触及排序
   */
  function query(opts = {}) {
    const limit = clampInt(opts.limit, 1, 200, 20);
    if (!usable()) return { rows: [], strategy: 'scan' };

    const where = [];
    const params = [];
    if (opts.sessionId) {
      where.push('m.session_id = ?');
      params.push(normalizeSessionId(opts.sessionId));
    }
    if (opts.platform) {
      where.push('m.platform = ?');
      params.push(String(opts.platform).toLowerCase());
    }
    if (opts.tier) {
      where.push('m.tier = ?');
      params.push(String(opts.tier));
    }
    if (opts.category) {
      where.push('m.category = ?');
      params.push(String(opts.category));
    }
    if (!opts.includeArchived) {
      where.push('m.status = ?');
      params.push(opts.status ?? 'active');
    }
    if (!opts.includeExpired) {
      where.push('(m.expires_at IS NULL OR m.expires_at > ?)');
      params.push(opts.now ?? Date.now());
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const text = String(opts.text ?? '').trim();

    if (text && ftsQueryable(text)) {
      try {
        const sql = `SELECT m.* FROM memory_fts JOIN memory AS m ON m.id = memory_fts.id
                     WHERE memory_fts.content MATCH ? ${where.length ? `AND ${where.join(' AND ')}` : ''}
                     ORDER BY bm25(memory_fts) LIMIT ?`;
        const rows = db.prepare(sql).all(ftsPhrase(text), ...params, limit);
        return { rows: rows.map(memoryFromRow), strategy: 'fts5' };
      } catch {
        // FTS 语法问题或索引损坏：不能让查询直接失败，落到 LIKE 继续。
      }
    }

    if (text) {
      where.push("m.content LIKE ? ESCAPE '\\'");
      params.push(likePattern(text));
    }
    const finalSql = `SELECT * FROM memory AS m ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                      ORDER BY m.last_touch_at DESC LIMIT ?`;
    // 多取一些候选再按权重排序：衰减是惰性计算的，SQL 里先按最近性粗排、JS 里精排。
    const rows = db.prepare(finalSql).all(...params, Math.max(limit * 4, 50)).map(memoryFromRow);
    const sorted = typeof opts.scoreOf === 'function' ? rows.sort((a, b) => opts.scoreOf(b) - opts.scoreOf(a)) : rows;
    return { rows: sorted.slice(0, limit), strategy: text ? 'like' : 'scan' };
  }

  /** 到期清理 + 容量淘汰。scoreOf 由上层（遗忘策略）注入，存储层不定义衰减语义。 */
  function prune(opts = {}) {
    if (!usable()) return { expired: 0, evicted: 0 };
    writable();
    const now = opts.now ?? Date.now();

    const expiredIds = db
      .prepare('SELECT id FROM memory WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .all(now)
      .map((row) => row.id);
    for (const id of expiredIds) {
      prepare('memDel', 'DELETE FROM memory WHERE id = ?').run(id);
      dropFts(id);
    }

    let evicted = 0;
    const maxEntries = Number(opts.maxEntries ?? 0);
    if (maxEntries > 0) {
      const scope = [];
      const params = [];
      if (opts.sessionId) {
        scope.push('session_id = ?');
        params.push(normalizeSessionId(opts.sessionId));
      }
      if (opts.tier) {
        scope.push('tier = ?');
        params.push(String(opts.tier));
      }
      const rows = db
        .prepare(
          `SELECT id, base_weight, hits, importance, last_touch_at FROM memory ${scope.length ? `WHERE ${scope.join(' AND ')}` : ''}`,
        )
        .all(...params);
      if (rows.length > maxEntries) {
        const scoreOf = typeof opts.scoreOf === 'function' ? opts.scoreOf : (row) => row.last_touch_at;
        const victims = [...rows].sort((a, b) => scoreOf(a) - scoreOf(b)).slice(0, rows.length - maxEntries);
        for (const row of victims) {
          prepare('memDel', 'DELETE FROM memory WHERE id = ?').run(row.id);
          dropFts(row.id);
          evicted += 1;
        }
      }
    }
    return { expired: expiredIds.length, evicted };
  }

  function count(opts = {}) {
    if (!usable()) return 0;
    const where = [];
    const params = [];
    if (opts.sessionId) {
      where.push('session_id = ?');
      params.push(normalizeSessionId(opts.sessionId));
    }
    if (opts.tier) {
      where.push('tier = ?');
      params.push(String(opts.tier));
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(String(opts.status));
    }
    const sql = `SELECT COUNT(*) AS n FROM memory ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    return Number(db.prepare(sql).get(...params)?.n ?? 0);
  }

  return { get, put, remove, query, prune, count };
}
