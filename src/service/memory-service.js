// 记忆服务：会话纪元召回（raw 全量落地 + 长期层）+ 遗忘 + 产出可拼接的记忆 block。
//
// 平台无关：只认 sessionId（platform:scope:id），不认识 QQ，也不认识任何平台概念。
// 写入失败必须抛错（由上层透传），绝不返回假成功 —— 沿用 qq-bridge 的既有原则。
//
// 分层语义（会话纪元模型）：短期记忆由 DSH 上下文承担，本服务只管「跨会话」——
// ingest 只写 raw（原文层），长期层由 record / 手动巩固 / 摘要产生；召回只在会话
// 创建（新 epoch）时注入一次 identity（画像+关系）与长期记忆，由网关按 epoch 去重。
import { normalizeSessionId } from '../session-id.js';
import { MEMORY_KINDS, anchorId, memoryRowId, recordRowId } from '../store/store-api.js';
import { DEFAULT_FORGETTING, makeScorer, memoryScore, shouldConsolidate } from './forgetting.js';
import { DEFAULT_HEAD_CONFIG, buildHead, buildTail, headDecision } from './head-builder.js';
import { partitionRelations } from './relation-service.js';

export const DEFAULT_MEMORY_CONFIG = {
  // 短期记忆默认存活 3 天。24h 太短：跨天的连续话题会在半夜被清掉；
  // 真正防泄漏的是「命中即滑动续期 + 超出容量按分数淘汰」，不是这个数字。
  // （新数据不再写短期层；此参数只为存量行与 append 兼容保留。）
  shortTtlMs: 72 * 60 * 60 * 1000,
  maxShort: 200,
  maxLong: 500,
  maxRenderChars: 1500,
  // 会话失活阈值：静默超过该时长，下次读路径发现即推进 epoch（新会话首轮）。
  sessionIdleMs: 60 * 60 * 1000,
  queryLimit: 20,
  forgetting: { ...DEFAULT_FORGETTING },
  // 头部/尾部的预算与断点参数，逐项可被 config.head 覆盖。
  head: { ...DEFAULT_HEAD_CONFIG },
};

export function createMemoryService({ store, config = {}, platformPolicy } = {}) {
  if (!store) throw new Error('createMemoryService 需要 store');
  // 平台白名单只在写入前校验一次：读路径放行（未知平台本来就查不到东西，不该抛错）。
  const checkPlatform = (sessionId) => {
    platformPolicy?.check?.(sessionId);
    return sessionId;
  };
  const cfg = {
    ...DEFAULT_MEMORY_CONFIG,
    ...config,
    forgetting: { ...DEFAULT_FORGETTING, ...(config.forgetting ?? {}) },
    head: { ...DEFAULT_HEAD_CONFIG, ...(config.head ?? {}) },
  };
  // 打分函数在调用时取当前时间：衰减是惰性计算的，不需要定时刷新。
  const scorer = makeScorer({ ...cfg.forgetting, now: undefined });
  const now = () => Date.now();

  const platformOf = (sessionId) => {
    const parts = String(sessionId ?? '').split(':');
    return parts.length >= 3 ? parts[0] : '';
  };

  /**
   * 会话纪元解析：读 last_activity_at 判静默；静默 ≥ sessionIdleMs 就 CAS 推进
   * epoch（本调用 = 新会话首轮），无论推进与否都 touchActivity 记活跃。返回当前
   * epoch；存储不支持会话状态时返回 null（调用方按「无纪元」处理，功能降级不报错）。
   */
  function resolveEpoch(sessionId) {
    if (typeof store.sessionState?.touchActivity !== 'function') return null;
    const at = now();
    const existing = store.sessionState.get(sessionId);
    let epoch = existing?.epoch ?? 1;
    if (existing && at - existing.lastActivityAt >= cfg.sessionIdleMs) {
      const advanced = store.sessionState.advanceEpoch(sessionId, { expect: existing.epoch, at });
      epoch = advanced?.epoch ?? (store.sessionState.get(sessionId)?.epoch ?? existing.epoch);
    }
    store.sessionState.touchActivity(sessionId, { platform: platformOf(sessionId), at });
    return epoch;
  }

  /**
   * 容量淘汰（节流版）。此前每次 append/record 都直接跑一次 prune，而 prune 的
   * 过期扫描在无索引时是全表扫描——写入繁忙时每条消息都是 O(全库行数)。
   * 现在按 (会话, 层级) 记账：攒满 pruneEveryN 次写或距上次超过 pruneIntervalMs
   * 才真正执行； consolidate/摘要/硬删除等低频关键路径调 forcePrune 强制执行。
   * 读侧正确性不受影响：查询本身过滤 expires_at（sqlite-memory.js:133），
   * 延迟淘汰只影响「行何时被物理删掉」，不影响「行是否可见」。
   */
  const pruneState = new Map(); // `${sessionId}\u0000${tier}` → { count, lastAt }
  const DEFAULT_PRUNE = { pruneEveryN: 20, pruneIntervalMs: 60_000 };

  function pruneTier(sessionId, tier) {
    const key = `${sessionId}\u0000${tier}`;
    const state = pruneState.get(key) ?? { count: 0, lastAt: 0 };
    state.count += 1;
    const at = now();
    if (state.count < (cfg.pruneEveryN ?? DEFAULT_PRUNE.pruneEveryN)
      && at - state.lastAt < (cfg.pruneIntervalMs ?? DEFAULT_PRUNE.pruneIntervalMs)) {
      pruneState.set(key, state);
      return 0;
    }
    state.count = 0;
    state.lastAt = at;
    pruneState.set(key, state);
    return forcePrune(sessionId, tier);
  }

  function forcePrune(sessionId, tier) {
    return store.memory.prune({
      sessionId,
      tier,
      maxEntries: tier === 'long' ? cfg.maxLong : cfg.maxShort,
      scoreOf: scorer,
      now: now(),
    });
  }

  /**
   * 收集 head 需要的行。三条有界查询，全部走会话索引：
   *   长期 = tier='long' 且 kind='episodic'（语义/关系/情绪各有自己的载体，不混在这一层）
   *   关系 = relation 表的当前值（单值，天然没有「取最新一条」的歧义）
   *   黑话 = 已确认词条（全局，不分会话）
   * 多取一条用于判断是否被截断，截断本身按条数做。
   */
  function collectHeadRows(sessionId, head, at) {
    const longRows = store.memory.query({
      sessionId,
      tier: 'long',
      kind: 'episodic',
      // 稳定区保留「最近 maxLong 条」：按建立时间倒序取候选，渲染层再翻成正序。
      // 用 recent 而不是 stable 取候选，是因为 stable 升序会先返回最老的 N 条，新事实永远进不了 head。
      order: 'recent',
      limit: head.maxLong + 1,
      now: at,
    }).rows;

    // 关系 / 情绪的「谁进头部、谁进尾部」只在 relation-service 里判断一次。
    const parts =
      typeof store.relation?.list === 'function'
        ? partitionRelations(store.relation.list({ sessionId, limit: 200 }).rows, {
            at,
            emotionFreshMs: head.emotionFreshMs,
          })
        : { relations: [], freshEmotions: [] };
    const relationRows = parts.relations;
    const emotionRows = parts.freshEmotions;

    const slangRows = store.slang.query({ status: 'confirmed', order: 'stable', limit: head.maxSlang + 1 }).rows;
    return { longRows, relationRows, emotionRows, slangRows };
  }

  /** 过期情绪不进稳定区，改在尾部以「上次情绪」出现：状态会变，别污染前缀。 */
  function collectStaleEmotions(sessionId, head, at) {
    if (typeof store.relation?.list !== 'function') return [];
    return partitionRelations(store.relation.list({ sessionId, kind: 'emotion', limit: 50 }).rows, {
      at,
      emotionFreshMs: head.emotionFreshMs,
    }).staleEmotions;
  }

  return {
    config: cfg,

    /**
     * 写一条记忆。带 msgId 时 id 是确定性的（`mem_<sha1(sessionId|msgId)>`），
     * 所以「同一条消息重复投递」不会产生第二条 —— 幂等在 id 上，不靠去重表。
     */
    append(input = {}) {
      const sessionId = checkPlatform(normalizeSessionId(input.sessionId));
      const tier = input.tier === 'long' ? 'long' : 'short';
      const msgId = String(input.msgId ?? '').trim();
      const id = input.id ?? (msgId ? memoryRowId(sessionId, msgId) : undefined);
      // 重放已存在的行时原样返回：已经升级成长期、已经累加的 hits 与 TTL 不能被回滚。
      if (id && !input.overwrite) {
        const existing = store.memory.get(id);
        if (existing) return existing;
      }
      const row = store.memory.put({
        ...input,
        id,
        sessionId,
        tier,
        sourceMsgIds: input.sourceMsgIds ?? (msgId ? [msgId] : []),
        // 长期记忆不设到期时间；短期记忆默认带 TTL，调用方可覆盖。
        expiresAt: tier === 'long' ? null : (input.expiresAt ?? now() + cfg.shortTtlMs),
        baseWeight: input.baseWeight ?? (tier === 'long' ? 1.2 : 1),
      });
      pruneTier(sessionId, tier);
      return row;
    },

    /**
     * 明确记录一条「值得长期记住」的事实（由模型主动调用，不是每条消息都记）。
     *
     * 与 append 的两点差别：
     *   1. tier 固定 long —— record 的语义就是「这条别忘」，不带 TTL；
     *   2. id 由 (会话, 类型, 说话人, 内容) 派生 —— 同一句话重复上报是幂等的，
     *      否则模型每轮复述一次画像，长期层就会堆出一串同义句。
     */
    record({ sessionId, content, kind = 'semantic', subjectId = '', category = '', importance = 0, extra } = {}) {
      const sid = checkPlatform(normalizeSessionId(sessionId));
      const body = String(content ?? '').trim();
      if (!body) throw new TypeError('record 需要 content');
      const type = MEMORY_KINDS.includes(kind) ? kind : 'semantic';
      const id = recordRowId(sid, { kind: type, subjectId, content: body });
      const existing = store.memory.get(id);
      if (existing) return { memory: existing, created: false };
      const memory = this.append({
        id,
        sessionId: sid,
        tier: 'long',
        kind: type,
        subjectId,
        category,
        content: body,
        importance,
        extra,
      });
      return { memory, created: true };
    },

    /**
     * 入站消息落地：raw 原文层（会话纪元模型下唯一自动写入口）。
     *
     * 短期层已删除 —— DSH 上下文承担短期记忆，聊天消息不再进 memory 表；
     * 长期层只由 record / 手动巩固 / 摘要产生。幂等：raw 有 UNIQUE(session_id,
     * msg_id)，重放原样返回 created.raw=false。不接 LLM：这里只是「把消息记住」，
     * 判断它值不值得记是摘要任务的事。
     */
    ingest(input = {}) {
      const sessionId = checkPlatform(normalizeSessionId(input.sessionId));
      const msgId = String(input.msgId ?? '').trim();
      if (!msgId) throw new Error('ingest 需要 msgId（幂等键与锚点都由它派生）');
      const anchor = anchorId(sessionId, msgId);
      const at = now();

      const write = () => {
        const { row: raw, created: rawCreated } = store.raw.append({
          sessionId,
          msgId,
          senderId: input.senderId,
          kind: input.rawKind ?? 'text',
          // 原文不做 trim：换行与空白是聊天的信息，压缩渲染时再收拾。
          text: String(input.text ?? ''),
          meta: input.meta,
          createdAt: input.createdAt ?? at,
        });

        // 入站即「活跃」：纪元窗口与断点窗口都按最后一条消息算，而不是按上次渲染时刻算。
        if (typeof store.snapshot?.touch === 'function') store.snapshot.touch(sessionId, input.createdAt ?? at);
        if (typeof store.sessionState?.touchActivity === 'function') {
          store.sessionState.touchActivity(sessionId, { platform: platformOf(sessionId), at: input.createdAt ?? at });
        }

        // memory 字段保留为 null（响应形状兼容）；短期层写入已随纪元模型移除。
        return { raw, memory: null, anchor: raw.anchor, created: { raw: rawCreated, memory: false } };
      };

      // 事务保证「raw + 活跃触点」要么都落库，要么都不落。没有事务的后端按顺序写（失败会抛，不会假成功）。
      return typeof store.transaction === 'function' ? store.transaction(write) : write();
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

    /**
     * 命中：抬权重、刷新触及时间，并**滑动续期**短期记忆的 TTL。
     * 自动巩固已随短期层一起移除（长期层只由 record / 摘要产生）；升级仍可经
     * consolidate({id}) 手动触发（存量短期行 / 运维操作）。
     */
    touch({ id } = {}) {
      const row = store.memory.get(id);
      if (!row) return null;
      const at = now();
      return store.memory.put({
        ...row,
        hits: row.hits + 1,
        lastTouchAt: at,
        // 还在聊的话题不该因为「创建满 72 小时」被清掉：到期时间跟着触及往后推。
        expiresAt: row.tier === 'long' ? null : at + cfg.shortTtlMs,
      });
    },

    /**
     * 手动巩固：把短期记忆升级为长期（保留内容与新字段，去掉 TTL，抬一点基础权重）。
     * force=true 时不看判据（显式要求「这条要长期记住」）。
     */
    consolidate({ id, sessionId, force = false } = {}) {
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
        if (force || shouldConsolidate(row, cfg.forgetting)) promoted.push(this.consolidate({ id: row.id }));
      }
      return promoted;
    },

    /**
     * 软遗忘（归档，可恢复）/ 硬删除（物理删除，服务于被遗忘权）。
     *
     * 传 sessionId 时做归属校验：模型侧工具调用必须带当前会话，跨会话删除直接
     * 拒绝（否则知道/猜到一个 id 就能抹掉别的会话的记忆）。
     */
    forget({ id, mode = 'soft', sessionId } = {}) {
      if (!id) throw new Error('forget 需要 id');
      const row = store.memory.get(id);
      if (!row) return { removed: false, archived: false, missing: true };
      if (sessionId && row.sessionId !== sessionId) {
        throw new Error('记忆不属于当前会话，拒绝删除');
      }
      if (mode === 'hard') {
        return { removed: store.memory.remove(id) };
      }
      store.memory.put({ ...row, status: 'archived', updatedAt: now() });
      return { archived: true };
    },

    restore({ id } = {}) {
      const row = store.memory.get(id);
      if (!row) return null;
      return store.memory.put({ ...row, status: 'active', lastTouchAt: now() });
    },

    /**
     * 会话纪元召回（网关管线的唯一记忆入口），返回多 block + epoch：
     *   - identity 块：【画像】+【关系】，按当前对话对象（subjectId）取，
     *     由网关在会话首轮注入一次（epoch 去重），后续轮次不重发；
     *   - long 块：【长期记忆】，subject 相关行优先、其余按分，≤20 条 / 预算内；
     *   - epoch：resolveEpoch 顺带完成「静默 → 新纪元」判定与活跃触点。
     *
     * 空边界：无 subject / 无画像关系 → 跳过 identity；无长期行 → 跳过 long；
     * 全空 → blocks: []（epoch 仍返回，网关照常推进轮次，不注入任何段）。
     * 短期层已删除（DSH 上下文承担），存量 short 行不再渲染。
     */
    render({ sessionId, subjectId = '', maxChars } = {}) {
      const sid = normalizeSessionId(sessionId);
      const epoch = resolveEpoch(sid);
      const budget = Math.max(1, Number(maxChars ?? cfg.maxRenderChars));
      const blocks = [];
      let truncated = false;

      // ── identity：关系（画像集合由摘要批次落地，缺集合时静默跳过）──
      let identityChars = 0;
      if (subjectId) {
        const relationRows = (store.relation?.list?.({ sessionId: sid, subjectId, limit: 13 }).rows ?? []);
        const visible = relationRows.filter((row) => {
          const confidence = row.confidence == null ? 1 : Number(row.confidence);
          return confidence >= 0.4; // <0.4 不注入；0.4–0.6 渲染时标「待确认」
        });
        if (visible.length) {
          const lines = visible.slice(0, 12).map((row) => {
            const confidence = row.confidence == null ? 1 : Number(row.confidence);
            const marker = confidence < 0.6 ? '（待确认）' : '';
            return `- ${row.key}：${row.value}${marker}`;
          });
          const text = `【关系】\n${lines.join('\n')}`;
          identityChars += text.length;
          blocks.push({ name: '关系', kind: 'identity', text, chars: text.length });
        }
        const profile = store.profile?.get?.(sid, subjectId) ?? null;
        if (profile?.attributes && Object.keys(profile.attributes).length) {
          const labels = {
            personality: '性格', speakingStyle: '说话风格', catchphrases: '口头禅',
            taboos: '禁忌', relation: '关系定位',
          };
          const lines = Object.entries(profile.attributes)
            .filter(([key]) => labels[key] && profile.attributes[key] != null)
            .map(([key, value]) => `- ${labels[key]}：${Array.isArray(value) ? value.join('、') : value}`);
          if (lines.length) {
            const text = `【画像】\n${lines.join('\n')}`;
            identityChars += text.length;
            blocks.push({ name: '画像', kind: 'identity', text, chars: text.length });
          }
        }
      }

      // ── long：subject 相关优先，其余按 memoryScore 精排 ──
      const longBudget = Math.max(200, budget - identityChars);
      const { rows } = this.query({ sessionId: sid, tier: 'long', limit: 50, includeArchived: false });
      const scored = rows.map((row) => ({ row, score: memoryScore(row, { ...cfg.forgetting, now: now() }) }));
      scored.sort((a, b) => {
        const aHit = a.row.subjectId && a.row.subjectId === subjectId ? 1 : 0;
        const bHit = b.row.subjectId && b.row.subjectId === subjectId ? 1 : 0;
        if (aHit !== bHit) return bHit - aHit;
        return b.score - a.score;
      });
      const picked = [];
      let used = 0;
      for (const item of scored.slice(0, 20)) {
        const prefix = item.row.category ? `${item.row.category}：` : '';
        const line = `- ${prefix}${item.row.content}`;
        if (used + line.length + 1 > longBudget) {
          truncated = true; // 只砍尾部，并让调用方如实知道被砍
          break;
        }
        picked.push(line);
        used += line.length + 1;
      }
      if (picked.length) {
        const text = `【长期记忆】\n${picked.join('\n')}`;
        blocks.push({ name: '长期记忆', kind: 'long', text, chars: text.length });
      }

      return { epoch, blocks, truncated };
    },

    /**
     * 稳定区（head）。只在断点重建，其余时刻原样返回快照 —— 这条路径只读一行快照，不查记忆表。
     *
     * 返回 { text, revision, rebuilt, reason, chars, truncated, degraded? }：
     *   rebuilt=false + reason='frozen'  —— 复用快照（热路径）
     *   rebuilt=false + reason='unchanged' —— 到了断点但内容没变，不重发
     *   rebuilt=true                     —— 重建并写入快照
     */
    renderHead({ sessionId, force = false, now: atMs, ...overrides } = {}) {
      const sid = normalizeSessionId(sessionId);
      const head = { ...cfg.head, ...overrides };
      const at = Number.isFinite(Number(atMs)) ? Number(atMs) : now();
      const snapshot = typeof store.snapshot?.get === 'function' ? store.snapshot.get(sid) : null;
      const decision = headDecision({ force, snapshot, now: at, quietWindowMs: head.quietWindowMs });

      const reused = (row, reason) => ({
        sessionId: sid,
        revision: row.revision,
        text: row.headText,
        chars: row.headText.length,
        rebuilt: false,
        reason,
        builtAt: row.builtAt,
        degraded: Boolean(store.degraded),
      });

      if (!decision.rebuild && snapshot) return reused(snapshot, decision.reason);

      const collected = collectHeadRows(sid, head, at);
      const built = buildHead({ ...collected, config: head });
      // 到了断点但内容没变（只是过了静默窗）：保持原快照，字节与已发出的完全一致。
      // 顺手把 lastActivityAt 推到本次重建时刻，否则下一轮又会被判成「静默超时」反复重建。
      if (snapshot && snapshot.revision === built.revision) {
        try {
          if (typeof store.snapshot?.touch === 'function') store.snapshot.touch(sid, at);
        } catch (error) {
          if (error?.name !== 'StoreReadOnlyError') throw error;
        }
        return reused(snapshot, 'unchanged');
      }

      const payload = {
        sessionId: sid,
        revision: built.revision,
        headText: built.text,
        builtAt: at,
        lastActivityAt: at,
      };
      try {
        if (typeof store.snapshot?.put === 'function') store.snapshot.put(payload);
      } catch (error) {
        // 只读兜底：这次照样把 head 交给调用方，但如实标注「没冻住」，下一轮还会重建。
        if (error?.name !== 'StoreReadOnlyError') throw error;
        return {
          sessionId: sid,
          revision: built.revision,
          text: built.text,
          chars: built.chars,
          rebuilt: true,
          reason: `${decision.reason}:read-only`,
          builtAt: at,
          truncated: built.truncated,
          degraded: true,
        };
      }
      return {
        sessionId: sid,
        revision: built.revision,
        text: built.text,
        chars: built.chars,
        rebuilt: true,
        reason: decision.reason,
        builtAt: at,
        truncated: built.truncated,
        degraded: Boolean(store.degraded),
      };
    },

    /** 动态区（tail）：当前时间 + 短期记忆 + 上次情绪 + 召回 + 本轮正文。每轮都可以变。 */
    renderTail({ sessionId, body = '', recall = '', now: atMs, ...overrides } = {}) {
      const sid = normalizeSessionId(sessionId);
      const head = { ...cfg.head, ...overrides };
      const at = Number.isFinite(Number(atMs)) ? Number(atMs) : now();
      const shortRows = store.memory.query({
        sessionId: sid,
        tier: 'short',
        kind: 'episodic',
        order: 'recent',
        limit: head.maxShortInTail,
        now: at,
      }).rows;
      const built = buildTail({
        shortRows,
        staleEmotions: collectStaleEmotions(sid, head, at),
        recallText: recall,
        body,
        now: at,
        config: head,
      });
      return { sessionId: sid, ...built, degraded: Boolean(store.degraded) };
    },

    /** 一次拿到注入用的完整块：head（可复用）+ tail（每轮新拼）。 */
    compose({ sessionId, body = '', recall = '', force = false, now: atMs, head: headOverrides, tail: tailOverrides } = {}) {
      const head = this.renderHead({ sessionId, force, now: atMs, ...(headOverrides ?? {}) });
      const tail = this.renderTail({ sessionId, body, recall, now: atMs, ...(tailOverrides ?? {}) });
      const text = [head.text, tail.text].filter(Boolean).join('\n');
      return { sessionId: head.sessionId, head, tail, text, revision: head.revision, rebuilt: head.rebuilt };
    },

    /** 手动失效快照：下一次渲染必然重建（角色变更、记忆被批量改写后调用）。 */
    invalidateHead({ sessionId } = {}) {
      if (typeof store.snapshot?.remove !== 'function') return { removed: false };
      return { removed: store.snapshot.remove(normalizeSessionId(sessionId)) };
    },

    stats() {
      return store.stats();
    },

    /** 强制容量淘汰（consolidate / 摘要写入 / 硬删除等低频关键路径用）。 */
    forcePrune(sessionId, tier) {
      return forcePrune(normalizeSessionId(sessionId), tier);
    },
  };
}
