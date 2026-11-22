// subject 身份层集合（L0 别名索引，V2 统一改造新增）：
//
//   subject_alias(platform, subject_id, alias, scope, confidence, source)
//     scope='global'         全局昵称（sender.names.nickname）
//     scope='session:<sid>'  会话内群名片（sender.names.card）
//
// 解析顺序 = 当前会话群名片优先 → 全局昵称；同别名指向多个 subject 时取
// confidence 最高（重名冲突的后来者由 subject-service 降权登记）。
// 集合层只做读写；冲突降权与解析优先级语义在 subject-service。
import { createHash } from 'node:crypto';
import { subjectAliasFromRow } from './sqlite-schema.js';

export const ALIAS_SOURCE_MAX = 60;

/** 确定性 id：同一条 (platform, scope, alias, subject) 重放不产生第二行。 */
export function aliasRowId(platform, scope, alias, subjectId) {
  return `alias_${createHash('sha1').update(`${platform}\u0000${scope}\u0000${alias}\u0000${subjectId}`).digest('hex').slice(0, 16)}`;
}

export function createSubjectAliasCollection({ usable, writable, prepare }) {
  function get(id) {
    if (!usable()) return null;
    return subjectAliasFromRow(prepare('saGet', 'SELECT * FROM subject_alias WHERE id = ?').get(String(id)));
  }

  /**
   * 登记一条别名。幂等：同 (platform, scope, alias, subject) 重放只刷新
   * confidence（取高者）与 source，不产生第二行。返回 { row, created }。
   */
  function register({ platform, subjectId, alias, scope = 'global', confidence = 1, source = '', at = Date.now() } = {}) {
    writable();
    const platformText = String(platform ?? '').trim().toLowerCase();
    const subject = String(subjectId ?? '').trim();
    const aliasText = String(alias ?? '').trim();
    const scopeText = String(scope ?? 'global').trim();
    if (!platformText) throw new TypeError('subject_alias.register 需要 platform');
    if (!subject) throw new TypeError('subject_alias.register 需要 subjectId');
    if (!aliasText) throw new TypeError('subject_alias.register 需要 alias');
    if (!scopeText) throw new TypeError('subject_alias.register 需要 scope');
    const conf = Math.min(1, Math.max(0, Number(confidence) || 0));
    const id = aliasRowId(platformText, scopeText, aliasText, subject);
    const existing = get(id);
    const ts = Number(at);
    if (existing) {
      // 已指向同一 subject：confidence 只升不降（群名片更新不影响既有高置信）。
      const nextConf = Math.max(existing.confidence, conf);
      prepare(
        'saUpd',
        'UPDATE subject_alias SET confidence = ?, source = ?, updated_at = ? WHERE id = ?',
      ).run(nextConf, (source || existing.source).slice(0, ALIAS_SOURCE_MAX), ts, id);
      return { row: get(id), created: false };
    }
    prepare(
      'saPut',
      `INSERT INTO subject_alias (id, platform, subject_id, alias, scope, confidence, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, platformText, subject, aliasText, scopeText, conf, String(source ?? '').slice(0, ALIAS_SOURCE_MAX), ts, ts);
    return { row: get(id), created: true };
  }

  /**
   * 解析：当前会话群名片优先，其次全局昵称；各自内部取 confidence 最高。
   * 返回 { subjectId, row } 或 null。
   */
  function resolve({ platform, sessionId = '', alias } = {}) {
    if (!usable()) return null;
    const platformText = String(platform ?? '').trim().toLowerCase();
    const aliasText = String(alias ?? '').trim();
    if (!platformText || !aliasText) return null;
    const scopes = ['global'];
    const sid = String(sessionId ?? '').trim();
    if (sid) scopes.unshift(`session:${sid}`);
    // 先试会话 scope（群名片），命中即返回；否则落全局。
    for (const scope of scopes) {
      const row = prepare(
        'saResolve',
        `SELECT * FROM subject_alias WHERE platform = ? AND alias = ? AND scope = ?
         ORDER BY confidence DESC, updated_at DESC LIMIT 1`,
      ).get(platformText, aliasText, scope);
      if (row) return { subjectId: row.subject_id, row: subjectAliasFromRow(row) };
    }
    return null;
  }

  /** 被遗忘权：按 subject 清别名（连历史一起删——别名索引没有版本链）。 */
  function removeBySubject({ platform, subjectId } = {}) {
    writable();
    const platformText = String(platform ?? '').trim().toLowerCase();
    const subject = String(subjectId ?? '').trim();
    if (!platformText || !subject) throw new TypeError('subject_alias.removeBySubject 需要 platform 与 subjectId');
    const info = prepare(
      'saDelSubject',
      'DELETE FROM subject_alias WHERE platform = ? AND subject_id = ?',
    ).run(platformText, subject);
    return info.changes;
  }

  function count() {
    if (!usable()) return 0;
    return Number(prepare('saCount', 'SELECT COUNT(*) AS n FROM subject_alias').get().n ?? 0);
  }

  return { get, register, resolve, removeBySubject, count };
}
