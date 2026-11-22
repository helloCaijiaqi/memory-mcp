// subject 身份层服务（V2 统一改造）：sender.names → subjectId 的别名登记与解析。
//
// 职责（集合层 sqlite-subject-alias 之上的语义层）：
//   - register：群名片（card）→ 会话 scope（scope='session:<sid>'）；
//     全局昵称（nickname）→ 全局 scope（scope='global'）。重名冲突（同别名已
//     指向不同 subject）后来者降权登记（confidence 0.3，可解析但不抢高置信位）。
//   - resolve：解析顺序 = 当前会话群名片 → 全局昵称（集合层实现）。
//   - forget：被遗忘权联动（清该 subject 的全部别名）。
//
// name（card||nickname 兼容口径）不单独登记：card/nickname 已分别覆盖两种 scope。
export function createSubjectService({ store, logger = () => {} } = {}) {
  const collection = store.subjectAlias;
  if (!collection || typeof collection.register !== 'function') {
    throw new Error('createSubjectService 需要 store.subjectAlias 集合（sqlite 后端，schema v3+）');
  }

  const CONFLICT_CONFIDENCE = 0.3;

  /**
   * 登记 sender.names（save 事务内调用）。senderId 必填；nickname/card 可选。
   * 返回登记明细（created 条数 / 冲突降权条数）。
   */
  function register({ sessionId, senderId, nickname, card, at = Date.now() } = {}) {
    const sid = String(sessionId ?? '').trim();
    const subject = String(senderId ?? '').trim();
    if (!sid || !subject) return { registered: 0, demoted: 0 };
    const platform = String(sid).split(':')[0]?.toLowerCase() ?? '';
    if (!platform) return { registered: 0, demoted: 0 };
    const entries = [];
    // 群名片：会话内别名（scope 随会话）。
    if (typeof card === 'string' && card.trim()) {
      entries.push({ alias: card.trim(), scope: `session:${sid}`, confidence: 1, source: 'card' });
    }
    // 全局昵称：全局别名。
    if (typeof nickname === 'string' && nickname.trim() && (!card || nickname.trim() !== card.trim())) {
      entries.push({ alias: nickname.trim(), scope: 'global', confidence: 1, source: 'nickname' });
    }

    let registered = 0;
    let demoted = 0;
    for (const entry of entries) {
      // 重名冲突检测：同 (platform, alias, scope) 已高置信指向别的 subject → 降权登记。
      const existing = collection.resolve({ platform, sessionId: sid, alias: entry.alias });
      let confidence = entry.confidence;
      if (existing && existing.subjectId !== subject && (existing.row?.confidence ?? 1) > CONFLICT_CONFIDENCE) {
        confidence = CONFLICT_CONFIDENCE;
        demoted += 1;
        logger(`subject alias 冲突：${entry.alias} 已指向 ${existing.subjectId}，新绑定 ${subject} 以低置信度登记`);
      }
      const { created } = collection.register({
        platform,
        subjectId: subject,
        alias: entry.alias,
        scope: entry.scope,
        confidence,
        source: entry.source,
        at,
      });
      if (created) registered += 1;
    }
    return { registered, demoted };
  }

  /** 名字 → subjectId（先群名片后全局昵称）；解析不到返回 null（调用方按原名处理）。 */
  function resolve({ sessionId, alias } = {}) {
    const sid = String(sessionId ?? '').trim();
    const name = String(alias ?? '').trim();
    if (!sid || !name) return null;
    const platform = String(sid).split(':')[0]?.toLowerCase() ?? '';
    return collection.resolve({ platform, sessionId: sid, alias: name })?.subjectId ?? null;
  }

  /** 被遗忘权联动：清该 subject 的全部别名。 */
  function forget({ sessionId, subjectId } = {}) {
    const sid = String(sessionId ?? '').trim();
    const platform = String(sid).split(':')[0]?.toLowerCase() ?? '';
    const subject = String(subjectId ?? '').trim();
    if (!platform || !subject) throw new TypeError('subject.forget 需要 sessionId 与 subjectId');
    return collection.removeBySubject({ platform, subjectId });
  }

  return { register, resolve, forget };
}
