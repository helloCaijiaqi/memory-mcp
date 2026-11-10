// 人物画像集合（profile + profile_history，L1 每对象一份）：
//
//   profile(session_id, subject_id) PK → 当前版本（attributes JSON / confidence /
//   source_msg_ids 证据锚点 / version）
//   profile_history → 每一版快照（含首版），回滚读历史版本。
//
// 与 relation 的分工：profile 描述倾向（性格/说话风格/口头禅/禁忌/关系定位），
// relation 记录事实（称呼/生日/情绪）——冲突时渲染层以 relation 为准。集合层只做
// 读写与版本快照；字段白名单、confidence 合成、merge 语义在 profile-service。
import { profileFromRow, profileHistoryFromRow } from './sqlite-schema.js';
import { normalizeSessionId } from '../session-id.js';

export function createProfileCollection({ usable, writable, prepare }) {
  function get(sessionId, subjectId) {
    if (!usable() || !subjectId) return null;
    return profileFromRow(
      prepare('pfGet', 'SELECT * FROM profile WHERE session_id = ? AND subject_id = ?')
        .get(normalizeSessionId(sessionId), String(subjectId)),
    );
  }

  function list(sessionId) {
    if (!usable()) return [];
    return prepare('pfList', 'SELECT * FROM profile WHERE session_id = ? ORDER BY updated_at DESC')
      .all(normalizeSessionId(sessionId))
      .map(profileFromRow);
  }

  /**
   * 写当前版 + 历史快照（每次 put 一条 history，版本号由调用方算好传入——版本
   * 语义归 service 层）。history id 由 (session, subject, version) 确定性派生。
   */
  function put({ sessionId, subjectId, platform = '', attributes, confidence, sourceMsgIds = [], version, at = Date.now() }) {
    writable();
    const sid = normalizeSessionId(sessionId);
    const subject = String(subjectId);
    const ts = Number(at);
    const attrsJson = JSON.stringify(attributes ?? {});
    const anchorsJson = JSON.stringify((sourceMsgIds ?? []).slice(0, 200));
    prepare(
      'pfPut',
      `INSERT INTO profile (session_id, platform, subject_id, attributes, confidence, source_msg_ids, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, subject_id) DO UPDATE SET
         platform = excluded.platform,
         attributes = excluded.attributes,
         confidence = excluded.confidence,
         source_msg_ids = excluded.source_msg_ids,
         version = excluded.version,
         updated_at = excluded.updated_at`,
    ).run(sid, String(platform ?? ''), subject, attrsJson, Number(confidence), anchorsJson, Number(version), ts, ts);
    prepare(
      'pfHist',
      `INSERT INTO profile_history (id, session_id, subject_id, version, attributes, confidence, source_msg_ids, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`pfh:${sid}:${subject}:${version}`, sid, subject, Number(version), attrsJson, Number(confidence), anchorsJson, ts);
    return get(sid, subject);
  }

  /** 版本链（新→旧）。 */
  function history(sessionId, subjectId, { limit = 20 } = {}) {
    if (!usable()) return [];
    return prepare(
      'pfHistList',
      'SELECT * FROM profile_history WHERE session_id = ? AND subject_id = ? ORDER BY version DESC LIMIT ?',
    ).all(normalizeSessionId(sessionId), String(subjectId), Math.max(1, Number(limit) || 20))
      .map(profileHistoryFromRow);
  }

  /** 被遗忘权：整份删除（连版本链——只删当前值等于假装忘了）。 */
  function remove(sessionId, subjectId) {
    writable();
    const sid = normalizeSessionId(sessionId);
    const subject = String(subjectId);
    const info = prepare('pfDel', 'DELETE FROM profile WHERE session_id = ? AND subject_id = ?').run(sid, subject);
    prepare('pfHistDel', 'DELETE FROM profile_history WHERE session_id = ? AND subject_id = ?').run(sid, subject);
    return info.changes > 0;
  }

  function count() {
    if (!usable()) return 0;
    return Number(prepare('pfCount', 'SELECT COUNT(*) AS n FROM profile').get().n ?? 0);
  }

  return { get, list, put, history, remove, count };
}
