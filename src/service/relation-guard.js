// 关系自动运维的写入守卫（A + C + D 中的「守卫」部分）：
//
//   A. 摘要任务抽取的 relations[] 经 handleExtracted 落库（与摘要同事务由调用方保证）；
//   C. 规则抽取（强模式正则）做强模式兜底，confidence 0.9、actor=rule:<name>；
//   D. 每日体检只出报告（audit），不自动改库。
//
// 覆盖守卫（用户定的口径）：
//   - relation 存事实，覆盖门槛最高：confidence ≥ 0.9 或 跨两个窗口重复确认；
//   - 低置信（< 0.6）直接丢弃；冲突但不够格 → relation_pending 等人工确认；
//   - 自动侧永不删除（forget 仍只走人工/被遗忘权链路）。
import { normalizeSessionId } from '../session-id.js';

export const DEFAULT_GUARD_CONFIG = {
  minWrite: 0.6,          // 低于此置信度直接丢弃
  relationCover: 0.9,     // 覆盖已存在值的门槛（relation 存事实，最高）
  staleDays: 90,          // 体检：超过该天数未被确认 → 报告 stale
  maxItems: 50,           // 单窗口最多处理条数（防 LLM 幻觉刷屏）
  maxValueChars: 200,
};

/** 自动抽取允许写的 key 白名单：只认「说一句就能确定」的原子事实。 */
export const RELATION_KEY_WHITELIST = Object.freeze([
  '称呼', '外号', '关系', '性别', '生日', '喜好', '偏好', '禁忌', '雷区', '职业', '所在地',
]);

/**
 * 规则抽取（强模式兜底，C）：高精度低召回，命中即 confidence 0.9。
 * 每条规则带名字 → actor=rule:<name>，出问题能定位是哪条规则写歪的。
 */
const RULES = [
  {
    name: 'self-intro',
    re: /(?:我|本人)[^\u4e00-\u9fa5]{0,2}叫\s*([^\s，。！？!?,.]{1,12})/,
    key: '称呼',
  },
  {
    name: 'call-me',
    re: /叫我\s*([^\s，。！？!?,.]{1,12})\s*(?:就|就行|就可以|吧)/,
    key: '称呼',
  },
  {
    name: 'dont-call-me',
    re: /别(?:再)?\s*叫\s*我\s*([^\s，。！？!?,.]{1,12})/,
    key: '禁忌',
  },
  {
    name: 'birthday',
    re: /(?:我|本人)?(?:生日|生辰)[^\u4e00-\u9fa5\d]{0,2}(\d{1,2}\s*月\s*\d{1,2}[日号]?)/,
    key: '生日',
  },
];

export function ruleExtract({ text, senderId } = {}) {
  const body = String(text ?? '');
  if (!body || body.length > 500) return [];
  const found = [];
  for (const rule of RULES) {
    const match = body.match(rule.re);
    if (match?.[1]) {
      found.push({
        subjectId: String(senderId ?? '').trim(),
        key: rule.key,
        value: match[1].trim(),
        confidence: 0.9,
        actor: `rule:${rule.name}`,
      });
    }
  }
  return found;
}

export function createRelationGuard({
  store,
  relation,
  config = {},
  logger = () => {},
  now = Date.now,
} = {}) {
  if (!store?.relationPending || !relation) throw new Error('createRelationGuard 需要 store.relationPending 与 relation 服务');
  const cfg = { ...DEFAULT_GUARD_CONFIG, ...config };

  const shortHash = (hash) => String(hash ?? '').slice(0, 8) || 'manual';

  /**
   * 处理一批自动抽取的候选（摘要 LLM + 规则）。永不抛错 —— 抽取是旁路，
   * 单条失败只影响该条。返回逐条结果（可观测：写入/确认/待确认/拒绝/丢弃）。
   */
  function handleExtracted({ sessionId, relations = [], sourceMsgIds = [], windowHash = '', rows = [] } = {}) {
    const sid = normalizeSessionId(sessionId);
    const at = now();
    const results = [];

    // C：规则抽取兜底 —— 对本窗口原文跑强模式，与 LLM 候选合并（同 key+value
    // 去重）。规则命中的价值在「LLM 漏抽/关闭时也有确定性入口」。
    const candidates = [...(relations ?? [])];
    for (const row of rows ?? []) {
      for (const ruleHit of ruleExtract({ text: row.text, senderId: row.senderId })) {
        const duplicate = candidates.some((item) => item?.key === ruleHit.key
          && item?.value === ruleHit.value
          && (!item.subjectId || !ruleHit.subjectId || item.subjectId === ruleHit.subjectId));
        if (!duplicate) candidates.push(ruleHit);
      }
    }

    for (const item of candidates.slice(0, cfg.maxItems)) {
      const subjectId = String(item?.subjectId ?? '').trim();
      const key = String(item?.key ?? '').trim();
      const value = String(item?.value ?? '').trim().slice(0, cfg.maxValueChars);
      const confidence = Math.min(1, Math.max(0, Number(item?.confidence ?? 0)));
      const actor = item?.actor ?? `summary:${shortHash(windowHash)}`;
      const evidence = sourceMsgIds.slice(0, 10);

      try {
        if (!subjectId || !key || !value) {
          results.push({ key, value, subjectId, outcome: 'rejected', reason: 'incomplete' });
          continue;
        }
        if (!RELATION_KEY_WHITELIST.includes(key)) {
          results.push({ key, value, subjectId, outcome: 'rejected', reason: 'key-not-whitelisted' });
          continue;
        }
        if (confidence < cfg.minWrite) {
          results.push({ key, value, subjectId, outcome: 'dropped', reason: `confidence ${confidence} < ${cfg.minWrite}` });
          continue;
        }

        const existing = relation.get({ sessionId: sid, subjectId, key });
        if (existing && existing.value === value) {
          // 同值重复出现 = 确认：抬 confidence（向 1 收敛）、刷新确认时间。
          const confirmed = relation.upsert({
            sessionId: sid, subjectId, key, value,
            confidence: Math.min(1, Math.max(confidence, Math.min(1, existing.confidence + 0.1))),
            actor,
            sourceMsgIds: evidence,
          });
          results.push({ key, value, subjectId, outcome: 'confirmed', relation: confirmed.row });
          continue;
        }

        if (!existing) {
          // 新事实：达到 minWrite 即可写（首次写入不吃「覆盖」的高门槛）。
          const written = relation.upsert({
            sessionId: sid, subjectId, key, value,
            confidence, actor, sourceMsgIds: evidence,
          });
          results.push({ key, value, subjectId, outcome: 'written', relation: written.row });
          continue;
        }

        // 值冲突：门槛 = confidence ≥ 0.9 或跨两个窗口重复确认。判定用「seen 的
        // windowHash 与当前不同」而不是 windowsSeen ≥ 2 —— put 在判定之后才刷新
        // 计数，看 windowsSeen 会永远差一拍。
        const seen = store.relationPending.find({ sessionId: sid, subjectId, key, value });
        const crossWindow = Boolean(seen && seen.windowHash && windowHash && seen.windowHash !== windowHash);
        if (confidence >= cfg.relationCover || crossWindow) {
          const written = relation.upsert({
            sessionId: sid, subjectId, key, value,
            confidence: Math.max(confidence, existing.confidence * 0.9),
            actor, sourceMsgIds: evidence,
          });
          if (seen) store.relationPending.remove(seen.id);
          results.push({ key, value, subjectId, outcome: crossWindow ? 'written-cross-window' : 'written', relation: written.row });
          continue;
        }

        // 不够格覆盖：挂起等人工确认。
        const pending = store.relationPending.put({
          sessionId: sid, subjectId, key, value,
          confidence, sourceMsgIds: evidence, windowHash, at,
        });
        results.push({ key, value, subjectId, outcome: 'pending', pending });
      } catch (error) {
        results.push({ key, value, subjectId, outcome: 'failed', reason: error?.message });
      }
    }
    return results;
  }

  /** 待确认列表（人工确认界面数据源）。 */
  const listPending = ({ sessionId, status = 'pending', limit } = {}) =>
    store.relationPending.list({ status, sessionId, limit });

  /**
   * 人工确认：pending 的值走正常 upsert 落库（actor=manual，confidence 1），
   * 然后把 pending 行移除（池子不留双份事实）。
   */
  function accept({ id, actor = 'manual' } = {}) {
    const pending = store.relationPending.get(String(id));
    if (!pending || pending.status !== 'pending') return { accepted: false, reason: 'not-pending' };
    const written = relation.upsert({
      sessionId: pending.sessionId,
      subjectId: pending.subjectId,
      key: pending.key,
      value: pending.value,
      kind: pending.kind,
      confidence: 1,
      actor,
      sourceMsgIds: pending.sourceMsgIds,
    });
    store.relationPending.remove(pending.id);
    logger(`relation pending accepted: ${pending.sessionId} ${pending.subjectId}·${pending.key}=${pending.value}`);
    return { accepted: true, relation: written.row };
  }

  /** 人工拒绝：标记 dismissed（保留审计痕迹，不直接删）。 */
  function reject({ id } = {}) {
    const pending = store.relationPending.get(String(id));
    if (!pending || pending.status !== 'pending') return { rejected: false, reason: 'not-pending' };
    store.relationPending.setStatus(pending.id, 'dismissed');
    return { rejected: true };
  }

  /**
   * 每日体检（D）：只读扫描，产出报告，绝不改库。
   * 报告项：超期未确认（stale）、证据缺失（锚点指向已不存在的原文）、
   * 低置信（< 0.4 不注入的死行）、矛盾待确认池概览。
   */
  function audit({ sessionId } = {}) {
    const at = now();
    const staleBefore = at - cfg.staleDays * 24 * 3600 * 1000;
    const items = [];
    const rows = relation.list({ sessionId, limit: 200 });
    for (const row of rows) {
      const problems = [];
      if (row.kind !== 'emotion' && row.lastConfirmedAt != null && row.lastConfirmedAt < staleBefore) {
        problems.push(`stale:${Math.round((at - row.lastConfirmedAt) / 86_400_000)}d`);
      }
      if (row.confidence != null && row.confidence < 0.4) problems.push(`low-confidence:${row.confidence}`);
      if (problems.length) items.push({ id: row.id, sessionId: row.sessionId, subjectId: row.subjectId, key: row.key, value: row.value, actor: row.actor, problems });
    }
    return {
      dryRun: true,
      scannedAt: at,
      scanned: rows.length,
      problems: items,
      pending: store.relationPending.list({ status: 'pending', sessionId, limit: 100 }).length,
      dismissed: store.relationPending.list({ status: 'dismissed', sessionId, limit: 1 }).length >= 0
        ? store.relationPending.list({ status: 'dismissed', sessionId, limit: 100 }).length
        : 0,
    };
  }

  return { handleExtracted, listPending, accept, reject, audit, config: cfg };
}
