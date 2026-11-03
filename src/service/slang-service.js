// 黑话服务：规则发现 → 候选/确认/拒绝 → 产出【黑话】段。
//
// 零模型依赖是硬性要求：发现与排序全靠规则（slang-discover.js），
// 解释生成走可选的 llm-provider（默认关闭，关闭时解释为空，不影响其它能力）。
import { DEFAULT_DISCOVER, discover } from '../slang-discover.js';
import { DEFAULT_LLM_CONFIG, createLlmProvider } from '../llm-provider.js';

export const DEFAULT_SLANG_CONFIG = {
  maxEntries: 300,
  maxRenderChars: 800,
  queryLimit: 20,
  discover: { ...DEFAULT_DISCOVER },
  llm: { ...DEFAULT_LLM_CONFIG },
};

export function createSlangService({ store, config = {} } = {}) {
  if (!store) throw new Error('createSlangService 需要 store');
  const cfg = {
    ...DEFAULT_SLANG_CONFIG,
    ...config,
    discover: { ...DEFAULT_DISCOVER, ...(config.discover ?? {}) },
    llm: { ...DEFAULT_LLM_CONFIG, ...(config.llm ?? {}) },
  };
  const llm = createLlmProvider(cfg.llm);

  function findByContent(content) {
    const { rows } = store.slang.query({ text: content, limit: 50 });
    return rows.find((row) => row.content === content) ?? null;
  }

  return {
    config: cfg,
    get llmEnabled() {
      return llm.enabled;
    },

    /** 只做发现、不入库：让调用方（AI 或控制台）先看候选再决定。 */
    discover({ messages, topN } = {}) {
      return discover(messages, { ...cfg.discover, ...(topN ? { topN } : {}) });
    },

    /** 发现并入库为候选；已存在的按内容合并证据，不重复建条目。 */
    absorb({ messages, topN } = {}) {
      const candidates = this.discover({ messages, topN });
      const written = [];
      for (const item of candidates) {
        const existing = findByContent(item.content);
        const row = store.slang.put({
          id: existing?.id,
          content: item.content,
          meaning: existing?.meaning ?? '',
          status: existing?.status ?? 'candidate',
          evidence: [...(existing?.evidence ?? []), ...item.evidence].slice(0, 20),
          score: Math.max(existing?.score ?? 0, item.score),
        });
        written.push(row);
      }
      store.slang.prune({ maxEntries: cfg.maxEntries, scoreOf: (row) => row.score });
      return written;
    },

    submit({ content, meaning = '', evidence = [], status = 'candidate', score = 0 } = {}) {
      const text = String(content ?? '').trim();
      if (!text) throw new Error('黑话内容不能为空');
      const existing = findByContent(text);
      const row = store.slang.put({
        id: existing?.id,
        content: text,
        meaning: existing?.meaning || meaning,
        status,
        evidence: [...(existing?.evidence ?? []), ...evidence].slice(0, 20),
        score: Math.max(existing?.score ?? 0, score),
      });
      store.slang.prune({ maxEntries: cfg.maxEntries, scoreOf: (row) => row.score });
      return row;
    },

    query({ text, status, limit } = {}) {
      return store.slang.query({ text, status, limit: limit ?? cfg.queryLimit });
    },

    confirm({ id }) {
      const row = store.slang.get(id);
      if (!row) return null;
      return store.slang.put({ ...row, status: 'confirmed' });
    },

    reject({ id }) {
      const row = store.slang.get(id);
      if (!row) return null;
      return store.slang.put({ ...row, status: 'rejected' });
    },

    remove({ id }) {
      return store.slang.remove(id);
    },

    /** 用可选 LLM 补解释；未启用时返回原行（meaning 保持原样），不抛错。 */
    async explain({ id } = {}) {
      const row = store.slang.get(id);
      if (!row) return null;
      if (!llm.enabled || row.meaning) return row;
      const meaning = await llm.explain({ content: row.content, evidence: row.evidence });
      if (!meaning) return row;
      return store.slang.put({ ...row, meaning });
    },

    /** 产出可直接拼接的【黑话】段。默认只给已确认的，候选未经确认不注入提示词。 */
    render({ maxChars, includeCandidates = false } = {}) {
      const limit = Math.max(1, Number(maxChars ?? cfg.maxRenderChars));
      const { rows } = store.slang.query({ status: 'confirmed', limit: 100 });
      const extras = includeCandidates ? store.slang.query({ status: 'candidate', limit: 50 }).rows : [];
      const items = [...rows, ...extras];
      if (!items.length) return { blocks: [], truncated: false };
      const body = items
        .sort((a, b) => b.score - a.score)
        .map((row) => `- ${row.content}${row.meaning ? `：${row.meaning}` : ''}`)
        .join('\n');
      const text = `【黑话】\n${body}`;
      if (text.length <= limit) return { blocks: [{ name: '黑话', text, chars: text.length }], truncated: false };
      const clipped = `${text.slice(0, Math.max(0, limit - 12))}\n…（已截断）`;
      return { blocks: [{ name: '黑话', text: clipped, chars: clipped.length }], truncated: true };
    },

    stats() {
      return store.stats();
    },
  };
}
