// 人物画像服务（profile）：每个 subject 一份字段化文档 + 整份版本链。
//
// 字段白名单是硬约束：摘要模型输出越界字段一律丢弃并告警 —— 宁可少写，不写错。
// 与 relation 的分工（冲突时渲染层 relation 赢）：profile 描述倾向（性格/说话
// 风格/口头禅/禁忌/关系定位），relation 记录事实（称呼/生日/情绪/禁忌条目）。
export const PROFILE_FIELDS = Object.freeze(['personality', 'speakingStyle', 'catchphrases', 'taboos', 'relation']);

const TEXT_LIMITS = { personality: 500, speakingStyle: 500, relation: 300 };
const LIST_FIELDS = new Set(['catchphrases', 'taboos']);
const LIST_MAX = 20;
const LIST_ITEM_MAX = 80;
const SOURCE_MAX = 200;

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * 白名单清洗：返回 { fields, dropped }。
 *  - 越界 key → dropped（丢弃并告警，绝不入库）；
 *  - 列表字段（catchphrases/taboos）→ 字符串数组，去空、去重、截断；
 *  - 文本字段 → 字符串，截断到字段上限；
 *  - 值为 null → { field: null }（merge 语义 = 删除该字段，原样传递）。
 */
function sanitize(patch) {
  const fields = {};
  const dropped = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!PROFILE_FIELDS.includes(key)) {
      dropped.push(key);
      continue; // eslint-disable-line no-continue
    }
    if (value === null) {
      fields[key] = null;
      continue; // eslint-disable-line no-continue
    }
    if (LIST_FIELDS.has(key)) {
      if (!Array.isArray(value)) {
        dropped.push(key);
        continue; // eslint-disable-line no-continue
      }
      fields[key] = [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))]
        .map((item) => (item.length > LIST_ITEM_MAX ? `${item.slice(0, LIST_ITEM_MAX)}…` : item))
        .slice(0, LIST_MAX);
      continue; // eslint-disable-line no-continue
    }
    const text = String(value ?? '').trim();
    const limit = TEXT_LIMITS[key] ?? 300;
    fields[key] = text.length > limit ? `${text.slice(0, limit)}…` : text;
  }
  return { fields, dropped };
}

export function createProfileService({ store, logger = () => {}, now = Date.now } = {}) {
  if (typeof store.profile?.put !== 'function') {
    throw new Error('createProfileService 需要 store.profile 集合（sqlite / json 双实现）');
  }

  const get = (sessionId, subjectId) => store.profile.get(sessionId, subjectId);
  const list = (sessionId) => store.profile.list(sessionId);
  const history = (sessionId, subjectId, opts) => store.profile.history(sessionId, subjectId, opts);
  const count = () => store.profile.count();

  /**
   * merge（摘要任务路径）：只覆盖本次给出的字段，未提及字段保留；null = 删除该
   * 字段。confidence = 旧×0.7 + 新×0.3（无旧值 = 新值）；证据锚点并集去重截 200；
   * version 自增。
   */
  function merge({ sessionId, subjectId, platform = '', patch = {}, confidence = 0.5, sourceMsgIds = [] } = {}) {
    if (!sessionId || !subjectId) throw new Error('profile.merge 需要 sessionId 与 subjectId');
    const { fields, dropped } = sanitize(patch);
    if (dropped.length) logger(`profile merge dropped out-of-whitelist fields: ${dropped.join(', ')}`);
    const current = store.profile.get(sessionId, subjectId);
    const attributes = { ...(current?.attributes ?? {}) };
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) {
        delete attributes[key];
        continue; // eslint-disable-line no-continue
      }
      const empty = LIST_FIELDS.has(key) ? value.length === 0 : !value;
      if (empty) delete attributes[key];
      else attributes[key] = value;
    }
    const conf = current
      ? clamp01(current.confidence * 0.7 + Number(confidence) * 0.3)
      : clamp01(confidence);
    const anchors = [...new Set([...(current?.sourceMsgIds ?? []), ...sourceMsgIds])].slice(0, SOURCE_MAX);
    return store.profile.put({
      sessionId,
      subjectId,
      platform: platform || current?.platform || '',
      attributes,
      confidence: conf,
      sourceMsgIds: anchors,
      version: (current?.version ?? 0) + 1,
      at: now(),
    });
  }

  /** replace（运维路径）：整份覆盖，缺失字段即清空（人工修正人设）。 */
  function replace({ sessionId, subjectId, platform = '', patch = {}, confidence = 1, sourceMsgIds = [] } = {}) {
    if (!sessionId || !subjectId) throw new Error('profile.replace 需要 sessionId 与 subjectId');
    const { fields, dropped } = sanitize(patch);
    if (dropped.length) logger(`profile replace dropped out-of-whitelist fields: ${dropped.join(', ')}`);
    const current = store.profile.get(sessionId, subjectId);
    const attributes = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) continue; // eslint-disable-line no-continue
      const empty = LIST_FIELDS.has(key) ? value.length === 0 : !value;
      if (!empty) attributes[key] = value;
    }
    return store.profile.put({
      sessionId,
      subjectId,
      platform: platform || current?.platform || '',
      attributes,
      confidence: clamp01(confidence),
      sourceMsgIds: [...new Set(sourceMsgIds)].slice(0, SOURCE_MAX),
      version: (current?.version ?? 0) + 1,
      at: now(),
    });
  }

  /** 回滚到指定历史版本（内容取快照，版本仍前进 —— 回滚也是一次变更，可再回滚）。 */
  function rollback({ sessionId, subjectId, toVersion } = {}) {
    const target = store.profile.history(sessionId, subjectId, { limit: 100 })
      .find((item) => item.version === Number(toVersion));
    if (!target) {
      throw new Error(`profile.rollback: version ${toVersion} not found`);
    }
    const current = store.profile.get(sessionId, subjectId);
    return store.profile.put({
      sessionId,
      subjectId,
      platform: current?.platform ?? '',
      attributes: target.attributes,
      confidence: target.confidence,
      sourceMsgIds: target.sourceMsgIds,
      version: (current?.version ?? 0) + 1,
      at: now(),
    });
  }

  /** 被遗忘权：整份删除（连版本链）。 */
  const forget = ({ sessionId, subjectId } = {}) => {
    if (!sessionId || !subjectId) throw new Error('profile.forget 需要 sessionId 与 subjectId');
    return store.profile.remove(sessionId, subjectId);
  };

  return { get, list, history, count, merge, replace, rollback, forget, FIELDS: PROFILE_FIELDS };
}
