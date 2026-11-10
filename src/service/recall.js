// 主动召回：模型按当前对话内容主动检索，而不是只靠注入的那几行。
//
// 三条设计约束：
//   1. 后端可替换：接口只有 available() / search()。FTS5 先上，向量后置 —— 换后端不改调用方，
//      调用方只看 strategy 字段决策，不猜实现。
//   2. 平台默认收窄：召回默认只查当前会话所在平台。跨平台是产品决策，要显式开启；
//      被拒绝时降级为当前平台并在返回值里标 scope，绝不「悄悄跨平台查了」。
//   3. 结果有预算：条数与字符都封顶。召回是叠在尾部的补充，不能挤掉本轮正文。
//
// 原文兜底层：短期记忆被淘汰后，30 天内的原文还在 L0。召回只看 memory 表的话，
// 「三天前聊过、但短期层已经清掉」的话题会凭空消失 —— 所以 fts5 后端同时查原文，
// 用 msgId 去重（原文在、摘要也在时只保留摘要）。
import { normalizeSessionId, parseSessionId } from '../session-id.js';
import { anchorId } from '../store/store-api.js';
import { clipText } from './head-builder.js';

export const RECALL_STRATEGIES = ['fts5', 'like', 'scan', 'unavailable', 'none'];

export const DEFAULT_RECALL_CONFIG = {
  maxRows: 5,
  maxChars: 400,
  // 跨平台召回默认关：同一个 scope:id 在不同平台是不同的人/群，串台比召回不到更糟。
  crossPlatform: false,
  // 后端优先级：前面的先查，有结果就停。
  order: ['fts5', 'vector'],
  // 单条内容上限：召回要的是线索，不是把整段聊天搬进提示词。
  contentChars: 200,
  memoryBonus: 0.15, // 同等命中下，摘要优先于原文
};

const PLATFORM_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

function normalizePlatforms(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out = [];
  for (const item of list) {
    const platform = String(item ?? '').trim().toLowerCase();
    // '*' 不在这里展开：通配等于「全部平台」，那必须由配置放行，不能由请求方随手写一个星号决定。
    if (!platform || platform === '*' || !PLATFORM_RE.test(platform)) continue;
    if (!out.includes(platform)) out.push(platform);
  }
  return out;
}

/** 命中强度：查询串在正文里出现几次。比 bm25 粗糙，但跨后端/跨层可比，且完全确定。 */
function relevanceOf(text, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return 0;
  const body = String(text ?? '').toLowerCase();
  let count = 0;
  let index = body.indexOf(q);
  while (index !== -1) {
    count += 1;
    index = body.indexOf(q, index + q.length);
  }
  return count;
}

function clipContent(text, maxChars) {
  const raw = String(text ?? '').trim();
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, Math.max(0, maxChars - 1))}…`;
}

function compareHits(a, b) {
  return (
    b.relevance - a.relevance ||
    Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0) ||
    String(a.id).localeCompare(String(b.id))
  );
}

/** 多后端/多平台混合时取**最保守**的策略：有一路降级过，就不能对外声称走了 FTS。 */
function worstStrategy(set) {
  if (set.has('like')) return 'like';
  if (set.has('fts5')) return 'fts5';
  if (set.has('scan')) return 'scan';
  return 'none';
}

function memoryHit(row, query, cfg) {
  const content = clipContent(row.content, cfg.contentChars);
  const msgId = row.sourceMsgIds?.[0] ?? '';
  return {
    id: row.id,
    layer: 'memory',
    sessionId: row.sessionId,
    platform: row.platform,
    kind: row.kind,
    tier: row.tier,
    subjectId: row.subjectId,
    category: row.category,
    content,
    msgId,
    anchor: msgId ? anchorId(row.sessionId, msgId) : '',
    createdAt: row.createdAt,
    relevance: relevanceOf(row.content, query) + cfg.memoryBonus,
  };
}

function rawHit(row, query, cfg) {
  return {
    id: row.id,
    layer: 'raw',
    sessionId: row.sessionId,
    platform: row.platform,
    kind: row.kind,
    tier: null,
    subjectId: row.senderId ?? '',
    category: '',
    content: clipContent(row.text, cfg.contentChars),
    msgId: row.msgId,
    anchor: row.anchor,
    createdAt: row.createdAt,
    relevance: relevanceOf(row.text, query),
  };
}

/**
 * FTS5 后端：memory 全文检索 + raw_message 原文兜底。
 *
 * strategy 由 store 回传（trigram 对 2 字查询不可用时会落 LIKE），这里只做聚合，
 * 不改写 —— 上层要能看出「这次召回其实没走索引」。
 */
export function createFts5Backend({ store, config = {} } = {}) {
  const cfg = { ...DEFAULT_RECALL_CONFIG, ...config };
  return {
    name: 'fts5',
    available() {
      return typeof store?.memory?.query === 'function';
    },
    search({ sessionId, platforms = [], text = '', kinds, subjectId, since, until, limit = cfg.maxRows, now } = {}) {
      const query = String(text ?? '').trim();
      // 单平台时用 sessionId 精确收窄（同平台的不同会话不该互相召回）；
      // 多平台时 sessionId 不成立，只能按 platform 过滤，此时范围由调用方（配置）负责。
      const scopes = platforms.length > 1 ? platforms.map((platform) => ({ platform })) : [{ sessionId }];
      const strategies = new Set();
      const memories = [];
      const take = Math.max(limit * 2, 10);

      for (const scope of scopes) {
        const out = store.memory.query({
          ...scope,
          text: query,
          kindIn: Array.isArray(kinds) && kinds.length ? kinds : undefined,
          subjectId,
          since,
          until,
          limit: take,
          now,
          includeArchived: false,
        });
        strategies.add(out.strategy ?? 'scan');
        for (const row of out.rows) memories.push(memoryHit(row, query, cfg));
      }

      // 原文兜底：摘要被淘汰/归档后，原文仍然是「唯一不可重建」的那一层。
      const raws = [];
      if (typeof store?.raw?.query === 'function') {
        const seenMsgIds = new Set(memories.map((hit) => hit.msgId).filter(Boolean));
        for (const scope of scopes) {
          const out = store.raw.query({ ...scope, text: query, senderId: subjectId, since, until, limit: take });
          strategies.add(out.strategy ?? 'scan');
          for (const row of out.rows) {
            // 空正文 = 已归档，原文在 gzip 分片里；召回不该把「已不在库里」的内容当成命中。
            if (!row.text || seenMsgIds.has(row.msgId)) continue;
            raws.push(rawHit(row, query, cfg));
            seenMsgIds.add(row.msgId);
          }
        }
      }

      const rows = [...memories, ...raws].sort(compareHits).slice(0, limit);
      return { rows, strategy: worstStrategy(strategies) };
    },
  };
}

/**
 * 向量后端占位。
 *
 * 现在 available() 恒为 false —— 调用方不会因为「有个 vector 后端」就去等一个不存在的索引。
 * 真接上向量库时只改这一个工厂：available() 返回真实能力，search() 返回同形状的 rows。
 */
export function createVectorBackend({ available = () => false, search = () => ({ rows: [], strategy: 'unavailable' }) } = {}) {
  return {
    name: 'vector',
    available,
    search,
  };
}

export function createRecallRouter({ store, backends = [], config = {} } = {}) {
  const cfg = { ...DEFAULT_RECALL_CONFIG, ...config };
  const registry = new Map();
  for (const backend of backends) {
    if (backend?.name) registry.set(backend.name, backend);
  }

  function isAvailable(backend) {
    try {
      return backend.available() !== false;
    } catch {
      return false;
    }
  }

  function backendNames() {
    const ordered = cfg.order.filter((name) => registry.has(name));
    const rest = [...registry.keys()].filter((name) => !ordered.includes(name));
    return [...ordered, ...rest];
  }

  return {
    config: cfg,
    backends: backendNames(),
    available() {
      return backendNames().filter((name) => isAvailable(registry.get(name)));
    },

    /**
     * 召回。返回 { rows, text, strategy, scope, platforms, downgraded, truncated, backend, degraded }。
     *
     * scope 的三种取值说明这次到底查了多大范围：
     *   'platform'      —— 只查当前平台（默认；请求跨平台但未开启时也落在这里，并置 downgraded）
     *   'cross-platform' —— 显式开启后跨平台查
     */
    recall({ sessionId, text = '', platforms, kinds, subjectId, since, until, limit, now } = {}) {
      const sid = normalizeSessionId(sessionId);
      const platform = parseSessionId(sid).platform;
      const requested = normalizePlatforms(platforms);
      const asked = requested.length ? requested : [platform];
      const wantsCross = asked.length > 1 || asked.some((item) => item !== platform);
      const allowed = !wantsCross || cfg.crossPlatform;
      const effective = allowed ? asked : [platform];
      const scope = effective.length > 1 || effective.some((item) => item !== platform) ? 'cross-platform' : 'platform';
      const maxRows = clampInt(limit ?? cfg.maxRows, 1, 50, cfg.maxRows);

      let rows = [];
      const attempts = [];
      for (const name of backendNames()) {
        const candidate = registry.get(name);
        if (!isAvailable(candidate)) continue;
        const out = candidate.search({
          sessionId: sid,
          platform,
          platforms: effective,
          text,
          kinds,
          subjectId,
          since,
          until,
          limit: maxRows * 2,
          now,
        });
        if (!out) continue;
        rows = Array.isArray(out.rows) ? out.rows : [];
        attempts.push({ name: candidate.name, strategy: out.strategy ?? 'scan', count: rows.length });
        // 有结果就停：后面的后端只是兜底，不是「多路融合」——融合会把延迟与不确定性一起带进来。
        if (rows.length) break;
      }
      // 没有结果时也要如实回答「查过哪一路、用的什么策略」，否则调用方分不清「没查到」和「没查」。
      const used = attempts.at(-1) ?? null;
      const backend = used?.name ?? null;
      const strategy = used?.strategy ?? 'unavailable';

      const total = rows.length;
      const kept = rows.slice(0, maxRows);
      const lines = kept.map((row) => (row.layer === 'raw' ? `- ［原文］${row.content}` : `- ${row.content}`));
      const clipped = clipText(lines.join('\n'), cfg.maxChars, '…（召回已截断）');

      return {
        sessionId: sid,
        platform,
        scope,
        platforms: effective,
        requestedPlatforms: asked,
        downgraded: wantsCross && !allowed,
        backend,
        strategy,
        rows: kept,
        text: clipped.text,
        chars: clipped.text.length,
        truncated: { rows: total > kept.length, chars: clipped.truncated, messages: kept.length },
        degraded: Boolean(store?.degraded),
      };
    },
  };
}
