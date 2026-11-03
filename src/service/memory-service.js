// 记忆服务：短期 / 长期分层 + 巩固 + 遗忘四件套 + 产出可直接拼接的【记忆】段。
//
// 平台无关：只认 sessionId（platform:scope:id），不认识 QQ，也不认识任何平台概念。
// 写入失败必须抛错（由上层透传），绝不返回假成功 —— 沿用 qq-bridge 的既有原则。
import { normalizeSessionId } from '../session-id.js';
import { DEFAULT_FORGETTING, makeScorer, memoryScore, shouldConsolidate } from './forgetting.js';

export const DEFAULT_MEMORY_CONFIG = {
  shortTtlMs: 24 * 60 * 60 * 1000, // 短期记忆默认存活一天
  maxShort: 200,
  maxLong: 500,
  maxRenderChars: 1500,
  queryLimit: 20,
  forgetting: { ...DEFAULT_FORGETTING },
};

export function createMemoryService({ store, config = {} } = {}) {
  if (!store) throw new Error('createMemoryService 需要 store');
  const cfg = {
    ...DEFAULT_MEMORY_CONFIG,
    ...config,
    forgetting: { ...DEFAULT_FORGETTING, ...(config.forgetting ?? {}) },
  };
  // 打分函数在调用时取当前时间：衰减是惰性计算的，不需要定时刷新。
  const scorer = makeScorer({ ...cfg.forgetting, now: undefined });
  const now = () => Date.now();

  function pruneTier(sessionId, tier) {
    store.memory.prune({
      sessionId,
      tier,
      maxEntries: tier === 'long' ? cfg.maxLong : cfg.maxShort,
      scoreOf: scorer,
      now: now(),
    });
  }

  return {
    config: cfg,

    append(input = {}) {
      const sessionId = normalizeSessionId(input.sessionId);
      const tier = input.tier === 'long' ? 'long' : 'short';
      const row = store.memory.put({
        ...input,
        sessionId,
        tier,
        // 长期记忆不设到期时间；短期记忆默认带 TTL，调用方可覆盖。
        expiresAt: tier === 'long' ? null : (input.expiresAt ?? now() + cfg.shortTtlMs),
        baseWeight: input.baseWeight ?? (tier === 'long' ? 1.2 : 1),
      });
      pruneTier(sessionId, tier);
      return row;
    },

    query(input = {}) {
      const sessionId = input.sessionId ? normalizeSessionId(input.sessionId) : undefined;
      return store.memory.query({
        ...input,
        sessionId,
        limit: input.limit ?? cfg.queryLimit,
        scoreOf: scorer,
        now: now(),
      });
    },

    get(id) {
      return store.memory.get(id);
    },

    /** 命中：抬权重并刷新触及时间；够格就顺手巩固为长期。 */
    touch({ id, consolidate = true } = {}) {
      const row = store.memory.get(id);
      if (!row) return null;
      const next = store.memory.put({
        ...row,
        hits: row.hits + 1,
        lastTouchAt: now(),
      });
      if (consolidate && shouldConsolidate(next, cfg.forgetting)) {
        return this.consolidate({ id });
      }
      return next;
    },

    /** 手动巩固：把短期记忆升级为长期（保留内容，去掉 TTL，抬一点基础权重）。 */
    consolidate({ id, sessionId } = {}) {
      if (id) {
        const row = store.memory.get(id);
        if (!row) return null;
        if (row.tier === 'long') return row;
        store.memory.remove(row.id);
        const promoted = store.memory.put({
          ...row,
          tier: 'long',
          expiresAt: null,
          baseWeight: Math.max(row.baseWeight, 1.2),
          lastTouchAt: now(),
        });
        return promoted;
      }
      if (!sessionId) throw new Error('consolidate 需要 id 或 sessionId');
      const { rows } = store.memory.query({
        sessionId: normalizeSessionId(sessionId),
        tier: 'short',
        limit: 200,
        scoreOf: scorer,
      });
      const promoted = [];
      for (const row of rows) {
        if (shouldConsolidate(row, cfg.forgetting)) promoted.push(this.consolidate({ id: row.id }));
      }
      return promoted;
    },

    /** 软遗忘（归档，可恢复）/ 硬删除（物理删除，服务于被遗忘权）。 */
    forget({ id, mode = 'soft' } = {}) {
      if (!id) throw new Error('forget 需要 id');
      if (mode === 'hard') {
        return { removed: store.memory.remove(id) };
      }
      const row = store.memory.get(id);
      if (!row) return { archived: false };
      store.memory.put({ ...row, status: 'archived', updatedAt: now() });
      return { archived: true };
    },

    restore({ id } = {}) {
      const row = store.memory.get(id);
      if (!row) return null;
      return store.memory.put({ ...row, status: 'active', lastTouchAt: now() });
    },

    /** 产出可直接拼接的【记忆】段。平台桥接拿去即用，不需要理解内部数据结构。 */
    render({ sessionId, maxChars } = {}) {
      const limit = Math.max(1, Number(maxChars ?? cfg.maxRenderChars));
      const { rows } = this.query({
        sessionId: normalizeSessionId(sessionId),
        limit: 50,
        includeArchived: false,
      });
      const scored = rows.map((row) => ({ row, score: memoryScore(row, { ...cfg.forgetting, now: now() }) }));
      scored.sort((a, b) => b.score - a.score);
      const long = scored.filter((item) => item.row.tier === 'long');
      const short = scored.filter((item) => item.row.tier === 'short');

      const lines = [];
      const push = (label, item) => {
        const prefix = item.row.category ? `${label}·${item.row.category}` : label;
        lines.push(`- ${prefix}：${item.row.content}`);
      };
      if (long.length) {
        lines.push('长期记忆：');
        long.forEach((item) => push('长期', item));
      }
      if (short.length) {
        if (lines.length) lines.push('');
        lines.push('短期记忆：');
        short.forEach((item) => push('短期', item));
      }
      if (!lines.length) return { blocks: [], truncated: false };

      const body = lines.join('\n');
      const text = `【记忆】\n${body}`;
      if (text.length <= limit) {
        return { blocks: [{ name: '记忆', text, chars: text.length }], truncated: false };
      }
      // 截断只砍尾部，并明确告知被砍 —— 静默截断会让 AI 以为记忆就这么点。
      const clipped = `${text.slice(0, Math.max(0, limit - 12))}\n…（已截断）`;
      return { blocks: [{ name: '记忆', text: clipped, chars: clipped.length }], truncated: true };
    },

    stats() {
      return store.stats();
    },
  };
}
