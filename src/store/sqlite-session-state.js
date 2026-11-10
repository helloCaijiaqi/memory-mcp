// 会话纪元状态（L0 会话生命周期）：
//
//   session_id PK → { platform, epoch, last_activity_at, last_summarized_at }
//
// 纪元（epoch）是「召回只发生一次」的依据：静默 ≥ sessionIdleMs（默认 60 分钟）
// 视为会话失活，下次任何读路径（render）发现静默就惰性推进 epoch —— 新纪元 =
// 新会话，网关侧按 (sessionKey, subjectId, epoch) 去重，只在首轮注入
// relation/profile/长期记忆，后续轮次靠 DSH 上下文。
//
// 推进用 CAS（WHERE epoch = 读到的值）：两个读者同时判定「静默」，只有一个能
// 改成功，另一个沿用新值 —— 不会 epoch+2。last_summarized_at 同时承担摘要
// 游标（= 已摘要 raw 的 created_at 上界），不单设 summary_cursor 表。
import { sessionStateFromRow } from './sqlite-schema.js';
import { normalizeSessionId } from '../session-id.js';

export function createSessionStateCollection({ usable, writable, prepare }) {
  function get(sessionId) {
    if (!usable()) return null;
    return sessionStateFromRow(
      prepare('ssGet', 'SELECT * FROM session_state WHERE session_id = ?').get(normalizeSessionId(sessionId)),
    );
  }

  /** 活跃触点：raw 落地与 render 都调。首见即建行（epoch=1）。 */
  function touchActivity(sessionId, { platform = '', at = Date.now() } = {}) {
    writable();
    const sid = normalizeSessionId(sessionId);
    const ts = Number(at);
    prepare(
      'ssTouch',
      `INSERT INTO session_state (session_id, platform, epoch, last_activity_at, last_summarized_at, created_at, updated_at)
       VALUES (?, ?, 1, ?, NULL, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_activity_at = excluded.last_activity_at,
         updated_at = excluded.updated_at`,
    ).run(sid, String(platform ?? ''), ts, ts, ts);
    return get(sid);
  }

  /**
   * CAS 推进纪元。expect 必须来自调用方刚读到的 epoch：不匹配（已被并发读者
   * 推进）返回 null，调用方沿用 get() 的现值即可 —— 推进本身是幂等目标，
   * 「推进过一次」就足够，不需要每个读者都成功。
   */
  function advanceEpoch(sessionId, { expect, at = Date.now() } = {}) {
    writable();
    const sid = normalizeSessionId(sessionId);
    const info = prepare(
      'ssAdvance',
      'UPDATE session_state SET epoch = epoch + 1, updated_at = ? WHERE session_id = ? AND epoch = ?',
    ).run(Number(at), sid, Number(expect));
    if (!info.changes) return null;
    return get(sid);
  }

  /** 摘要游标推进（与摘要写入同事务由上层编排；这里只做单点更新）。 */
  function markSummarized(sessionId, { at = Date.now(), summarizedUpTo } = {}) {
    writable();
    const sid = normalizeSessionId(sessionId);
    const info = prepare(
      'ssMarkSum',
      'UPDATE session_state SET last_summarized_at = ?, updated_at = ? WHERE session_id = ?',
    ).run(Number(summarizedUpTo ?? at), Number(at), sid);
    return info.changes ? get(sid) : null;
  }

  /** 摘要 tick 用：列出静默超过 olderThan 的会话（最久未活跃优先）。 */
  function listIdle({ olderThan = 0, limit = 100 } = {}) {
    if (!usable()) return [];
    return prepare(
      'ssIdle',
      'SELECT * FROM session_state WHERE last_activity_at <= ? ORDER BY last_activity_at ASC LIMIT ?',
    ).all(Number(olderThan), Math.max(1, Math.min(500, Number(limit) || 100))).map(sessionStateFromRow);
  }

  function count() {
    if (!usable()) return 0;
    return Number(prepare('ssCount', 'SELECT COUNT(*) AS n FROM session_state').get().n ?? 0);
  }

  return { get, touchActivity, advanceEpoch, markSummarized, listIdle, count };
}
