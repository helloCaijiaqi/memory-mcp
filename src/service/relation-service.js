// L2 关系 / 情绪服务：单值 + 版本链 + 情绪时效 + 作用域守门。
//
// 三条语义（前两条在 store 层保证，第三条的守门在这里）：
//   1. 同一 (会话, 说话人, 键, 作用域) 只有一行 —— 「现在是什么」必须有唯一答案，
//      不能靠「按时间取最新一条」在应用层猜。
//   2. 值真正变化才写历史 —— 模型每轮都可能重复确认一次称呼，同值重复上报不该刷满变更链。
//   3. 跨平台共享（scope='identity'）默认关闭：同一个人跨平台共享关系是产品决策，
//      不是默认行为；开启要显式配置，调用要显式传 scope。
import { normalizeSessionId } from '../session-id.js';

/** 情绪「算现在」的时长：与 head 渲染共用同一个数字，避免两边各写一个常量慢慢漂移。 */
export const DEFAULT_EMOTION_FRESH_MS = 2 * 60 * 60 * 1000;

export const DEFAULT_RELATION_CONFIG = {
  emotionFreshMs: DEFAULT_EMOTION_FRESH_MS,
  maxRows: 200,
  identityEnabled: false,
};

/** 显式要求跨平台共享但开关没开：拒绝而不是静默降级，静默降级会让人以为共享生效了。 */
export class RelationScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelationScopeError';
  }
}

/** 情绪是否已经不新鲜（只有情绪会过期；关系是事实，不随时间失效）。 */
export function isEmotionStale(row, { at = Date.now(), emotionFreshMs = DEFAULT_EMOTION_FRESH_MS } = {}) {
  if (row?.kind !== 'emotion') return false;
  return at - Number(row.updatedAt ?? 0) > Math.max(0, Number(emotionFreshMs) || 0);
}

/**
 * 把关系行按「进头部 / 进尾部 / 不参与」分好：
 *   relations     —— 事实，进稳定区
 *   freshEmotions —— 当前情绪，进稳定区
 *   staleEmotions —— 过期情绪，只能进尾部（作为「上次情绪」），不能污染字节稳定的前缀
 * identity 行默认不参与渲染：跨平台关系要显式 includeIdentity 才看得见。
 */
export function partitionRelations(
  rows = [],
  { at = Date.now(), emotionFreshMs = DEFAULT_EMOTION_FRESH_MS, includeIdentity = false } = {},
) {
  const relations = [];
  const freshEmotions = [];
  const staleEmotions = [];
  for (const row of rows) {
    if (!row) continue;
    if (row.scope === 'identity' && !includeIdentity) continue;
    if (row.kind !== 'emotion') {
      relations.push(row);
      continue;
    }
    if (isEmotionStale(row, { at, emotionFreshMs })) staleEmotions.push(row);
    else freshEmotions.push(row);
  }
  return { relations, freshEmotions, staleEmotions };
}

export function createRelationService({ store, config = {}, now, platformPolicy } = {}) {
  if (!store?.relation) throw new Error('createRelationService 需要带 relation 集合的 store');
  const cfg = { ...DEFAULT_RELATION_CONFIG, ...config };
  const clock = typeof now === 'function' ? now : () => Date.now();
  const at = () => {
    const t = Number(clock());
    return Number.isFinite(t) ? t : Date.now();
  };

  function scopeOf(scope) {
    if (scope !== 'identity') return 'session';
    if (!cfg.identityEnabled) {
      throw new RelationScopeError(
        '跨平台关系共享未开启：读写 scope=identity 需要 MEMORY_MCP_RELATION_IDENTITY=1（默认按会话隔离）',
      );
    }
    return 'identity';
  }

  return {
    config: cfg,

    /**
     * 写入当前值。返回 { row, created, changed }：
     *   created=true      新建（同时写第一条历史）
     *   changed=true      值变了（写一条历史）
     *   两者都 false      值没变（只更新 importance / decayExempt / updated_at）
     *
     * 可信度三列（自动运维）：人工/API 写入默认 confidence=1、actor=manual、
     * lastConfirmedAt=now；自动链路（relation-guard）显式传 confidence 与
     * actor（summary:<hash> / rule:<name>）。渲染层按 confidence 降权。
     */
    upsert({
      sessionId,
      subjectId,
      key,
      value,
      kind = 'relation',
      scope = 'session',
      importance = 0,
      decayExempt,
      sourceMsgIds,
      changedAt,
      confidence,
      actor,
      lastConfirmedAt,
    } = {}) {
      const sid = normalizeSessionId(sessionId);
      // 关系是写入才产生数据：白名单校验放在这里，读路径不拦。
      platformPolicy?.check?.(sid);
      const ts = Number.isFinite(Number(changedAt)) ? Number(changedAt) : at();
      return store.relation.upsert(
        {
          sessionId: sid,
          subjectId,
          key,
          value,
          kind: kind === 'emotion' ? 'emotion' : 'relation',
          scope: scopeOf(scope),
          importance,
          decayExempt,
          sourceMsgIds,
          confidence: confidence == null ? 1 : Number(confidence),
          actor: actor ?? 'manual',
          lastConfirmedAt: lastConfirmedAt == null ? ts : Number(lastConfirmedAt),
        },
        { changedAt: ts },
      );
    },

    get({ sessionId, subjectId, key, scope = 'session' } = {}) {
      return store.relation.getByKey({
        sessionId: normalizeSessionId(sessionId),
        subjectId,
        key,
        scope: scopeOf(scope),
      });
    },

    list({ sessionId, kind, subjectId, scope = 'session', limit } = {}) {
      return store.relation.list({
        sessionId: normalizeSessionId(sessionId),
        kind,
        subjectId,
        scope: scopeOf(scope),
        limit: limit ?? cfg.maxRows,
      }).rows;
    },

    /** 版本链。可按 relationId 直接查，也可按 (说话人, 键) 解析后查。 */
    history({ sessionId, subjectId, key, scope = 'session', relationId, limit = 20 } = {}) {
      const row = relationId
        ? store.relation.get(String(relationId))
        : this.get({ sessionId, subjectId, key, scope });
      if (!row) return { relation: null, rows: [] };
      return { relation: row, rows: store.relation.history({ relationId: row.id, limit }).rows };
    },

    /** 硬删除（被遗忘权）：默认连版本链一起删 —— 只删当前值等于假装忘了。 */
    forget({ id, sessionId, subjectId, key, scope = 'session', keepHistory = false } = {}) {
      const row = id
        ? store.relation.get(String(id))
        : this.get({ sessionId, subjectId, key, scope });
      if (!row) return { removed: false, historyRemoved: 0 };
      const removed = store.relation.remove(row.id);
      const historyRemoved =
        !keepHistory && typeof store.relation.removeHistory === 'function'
          ? store.relation.removeHistory({ relationId: row.id })
          : 0;
      return { removed, historyRemoved };
    },

    /** 渲染层用的分区视图：时效判断只有这一处，head/tail 不再各算一遍。 */
    partition({ sessionId, at: ts, limit } = {}) {
      const rows = this.list({ sessionId, limit: limit ?? cfg.maxRows });
      return partitionRelations(rows, {
        at: Number.isFinite(Number(ts)) ? Number(ts) : at(),
        emotionFreshMs: cfg.emotionFreshMs,
      });
    },
  };
}
