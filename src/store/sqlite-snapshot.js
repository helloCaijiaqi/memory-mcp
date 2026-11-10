// head 冻结快照的 SQL 实现。
//
// 存在意义只有一个：让「这个会话的稳定区已经发过、且内容是这个版本」成为可查的事实。
// 没有它，每轮都得重新拼 head，拼出来只要有 1 个字节不同，前缀缓存就全废。
import { normalizeSnapshotRow } from './store-api.js';
import { snapshotFromRow } from './sqlite-schema.js';
import { normalizeSessionId } from '../session-id.js';

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function createSnapshotCollection({ db, usable, writable, prepare }) {
  function get(sessionId) {
    if (!usable() || !sessionId) return null;
    return snapshotFromRow(
      prepare('snapGet', 'SELECT * FROM head_snapshot WHERE session_id = ?').get(normalizeSessionId(sessionId)),
    );
  }

  function put(row) {
    writable();
    const r = normalizeSnapshotRow(row);
    prepare(
      'snapPut',
      `INSERT INTO head_snapshot (session_id, platform, revision, head_text, built_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         platform = excluded.platform, revision = excluded.revision, head_text = excluded.head_text,
         built_at = excluded.built_at, last_activity_at = excluded.last_activity_at`,
    ).run(r.sessionId, r.platform, r.revision, r.headText, r.builtAt, r.lastActivityAt);
    return get(r.sessionId);
  }

  /** 只推活跃时间（每条入站消息都会调用），不动 revision 与 headText。 */
  function touch(sessionId, at = Date.now()) {
    writable();
    const id = normalizeSessionId(sessionId);
    prepare('snapTouch', 'UPDATE head_snapshot SET last_activity_at = ? WHERE session_id = ?').run(
      clampInt(at, 0, Number.MAX_SAFE_INTEGER, Date.now()),
      id,
    );
    return get(id);
  }

  function remove(sessionId) {
    writable();
    const changes =
      prepare('snapDel', 'DELETE FROM head_snapshot WHERE session_id = ?').run(normalizeSessionId(sessionId))
        .changes ?? 0;
    return changes > 0;
  }

  function count() {
    if (!usable()) return 0;
    return Number(db.prepare('SELECT COUNT(*) AS n FROM head_snapshot').get()?.n ?? 0);
  }

  return { get, put, touch, remove, count };
}
