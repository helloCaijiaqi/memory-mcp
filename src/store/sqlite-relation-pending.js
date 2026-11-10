// 关系冲突待确认池（relation_pending）：自动抽取低于覆盖阈值的结论挂在这里，
// 等人工 accept（走正常 upsert，actor=manual）或 reject（标记 dismissed）。
//
// 幂等：id 由 (session, subject, key, value) 确定性派生 —— 同一结论重复抽取
// （跨窗口再次出现）只更新 confidence / 证据 / 次数，不产生第二行；「跨窗口
// 二次确认」的判定依据就是同一 pending 行被不同 windowHash 刷新过。
import { createHash } from 'node:crypto';
import { normalizeSessionId } from '../session-id.js';

function pendingId({ sessionId, subjectId, key, value }) {
  return `rp_${createHash('sha1').update(`${sessionId}\u0000${subjectId}\u0000${key}\u0000${value}`).digest('hex').slice(0, 20)}`;
}

function rowFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    platform: row.platform,
    subjectId: row.subject_id,
    key: row.key,
    value: row.value,
    kind: row.kind,
    confidence: Number(row.confidence ?? 0),
    sourceMsgIds: (() => {
      try {
        const parsed = JSON.parse(row.source_msg_ids ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
    windowHash: row.window_hash ?? '',
    windowsSeen: Number(row.windows_seen ?? 1),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRelationPendingCollection({ usable, writable, prepare }) {
  function get(id) {
    if (!usable()) return null;
    return rowFrom(prepare('rpGet', 'SELECT * FROM relation_pending WHERE id = ?').get(String(id)));
  }

  function find({ sessionId, subjectId, key, value } = {}) {
    if (!usable()) return null;
    return get(pendingId({ sessionId, subjectId, key, value }));
  }

  /** 挂起/刷新一条待确认（同结论 = 刷新，跨窗口 windowsSeen+1）。 */
  function put({ sessionId, subjectId, key, value, kind = 'relation', confidence, sourceMsgIds = [], windowHash = '', at = Date.now() } = {}) {
    writable();
    const sid = normalizeSessionId(sessionId);
    const id = pendingId({ sessionId: sid, subjectId, key, value });
    const existing = get(id);
    if (existing && existing.status !== 'pending') return existing; // 已 accept/reject 的不再翻案
    const crossWindow = Boolean(existing && existing.windowHash && windowHash && existing.windowHash !== windowHash);
    const windowsSeen = existing ? existing.windowsSeen + (crossWindow ? 1 : 0) : 1;
    const conf = Math.max(Number(confidence) || 0, existing?.confidence ?? 0);
    const anchors = [...new Set([...(existing?.sourceMsgIds ?? []), ...sourceMsgIds])].slice(0, 50);
    prepare(
      'rpPut',
      `INSERT INTO relation_pending (id, session_id, platform, subject_id, key, value, kind,
                                     confidence, source_msg_ids, window_hash, windows_seen, status,
                                     created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         confidence = excluded.confidence, source_msg_ids = excluded.source_msg_ids,
         window_hash = excluded.window_hash, windows_seen = excluded.windows_seen,
         status = 'pending', updated_at = excluded.updated_at`,
    ).run(
      id,
      sid,
      String(platformOf(sid)),
      String(subjectId),
      String(key),
      String(value),
      kind === 'emotion' ? 'emotion' : 'relation',
      conf,
      JSON.stringify(anchors),
      String(windowHash),
      windowsSeen,
      Number(at),
      Number(at),
    );
    return get(id);
  }

  function list({ status = 'pending', sessionId, limit = 100 } = {}) {
    if (!usable()) return [];
    const where = ['status = ?'];
    const params = [String(status)];
    if (sessionId) {
      where.push('session_id = ?');
      params.push(normalizeSessionId(sessionId));
    }
    return prepare(
      'rpList',
      `SELECT * FROM relation_pending WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
    ).all(...params, Math.max(1, Math.min(500, Number(limit) || 100))).map(rowFrom);
  }

  function setStatus(id, status, { at = Date.now() } = {}) {
    writable();
    const info = prepare('rpStatus', 'UPDATE relation_pending SET status = ?, updated_at = ? WHERE id = ?')
      .run(String(status), Number(at), String(id));
    return info.changes ? get(id) : null;
  }

  /** 人工确认后移除（accept 已把值写进 relation，池子不留双份事实）。 */
  function remove(id) {
    writable();
    const info = prepare('rpDel', 'DELETE FROM relation_pending WHERE id = ?').run(String(id));
    return info.changes > 0;
  }

  function count() {
    if (!usable()) return 0;
    return Number(prepare('rpCount', 'SELECT COUNT(*) AS n FROM relation_pending').get().n ?? 0);
  }

  return { get, find, put, list, setStatus, remove, count };
}

function platformOf(sessionId) {
  const parts = String(sessionId ?? '').split(':');
  return parts.length >= 3 ? parts[0] : '';
}
