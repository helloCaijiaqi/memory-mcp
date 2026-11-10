// 遗忘机制：四种手段统一到一套权重模型，避免各管一段、互相打架。
//
//   score = baseWeight × exp(-λ(行) × 距今上次触及的天数) + 命中加成 + 重要度加成
//
// 四种手段：
//   1. 时间衰减 —— 上式里的指数项；λ 分档（见 lambdaFor），「关系」豁免、「情绪」快衰
//   2. 容量淘汰 —— 超出上限时按最低 score 淘汰（沿用 qq-bridge 里 SLANG_MAX_ENTRIES 的治理思路）
//   3. 软遗忘   —— status='archived'：不注入提示词，但控制台可见、可恢复
//   4. 硬删除   —— 物理删除，服务于被遗忘权（见 qq-bridge/docs/guides/PRIVACY.md 的同类约定）
//
// 惰性计算：读取时才算分数，不做定时全表刷新 —— 全表刷会把 I/O 放大到与记忆量成正比。
export const DEFAULT_FORGETTING = {
  lambdaPerDay: 0.08, // 约 9 天衰减到一半
  // 情绪单独一档：今天生气不代表明天还在生气，半衰期约 33 小时。
  emotionLambdaPerDay: 0.5,
  hitBonus: 0.2, // 命中加成的上限
  hitBonusFullAt: 10, // 命中多少次拿满加成
  importanceWeight: 0.5, // importance(0-10) 折算出的最大加成
  consolidateHits: 3, // 短期记忆被触及几次后升级为长期
  consolidateImportance: 7, // 或显式重要度达到多少
  // 跨天被触及：连续两天聊到同一件事，说明它明天还会出现，不该按「24h 到期」清掉。
  consolidateTouchDays: 2,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysSince(timestamp, now = Date.now()) {
  return Math.max(0, (now - Number(timestamp ?? now)) / DAY_MS);
}

export function decayFactor(days, lambdaPerDay = DEFAULT_FORGETTING.lambdaPerDay) {
  return Math.exp(-Math.max(0, lambdaPerDay) * Math.max(0, days));
}

/**
 * 这一行该用多大的衰减系数（每天）。
 *   decayExempt → 0（关系、显式豁免的事实，永远不衰减）
 *   kind=emotion → emotionLambdaPerDay
 *   其余 → lambdaPerDay
 *
 * 分档放在这里而不是给每行存一个 λ：参数调整只改配置，不用回写历史行。
 */
export function lambdaFor(row, opts = {}) {
  const cfg = { ...DEFAULT_FORGETTING, ...opts };
  if (row?.decayExempt) return 0;
  if (row?.kind === 'emotion') return Math.max(0, Number(cfg.emotionLambdaPerDay ?? 0));
  return Math.max(0, Number(cfg.lambdaPerDay ?? 0));
}

/** 单条记忆的当前权重。row 需要 baseWeight / hits / importance / lastTouchAt / kind / decayExempt。 */
export function memoryScore(row, opts = {}) {
  const cfg = { ...DEFAULT_FORGETTING, ...opts };
  const now = opts.now ?? Date.now();
  const base = Number(row?.baseWeight ?? 1);
  const decayed = base * decayFactor(daysSince(row?.lastTouchAt ?? now, now), lambdaFor(row, cfg));
  const hitPart = Math.min(1, Number(row?.hits ?? 0) / cfg.hitBonusFullAt) * cfg.hitBonus;
  const impPart = (Math.min(10, Math.max(0, Number(row?.importance ?? 0))) / 10) * cfg.importanceWeight;
  return decayed + hitPart + impPart;
}

/** 生成一个可直接喂给 store.prune({ scoreOf }) 的打分函数。 */
export function makeScorer(opts = {}) {
  return (row) => memoryScore(row, opts);
}

/**
 * 这条记忆被「几个自然日」触及过：同一天=1，跨一天=2。
 * 用 createdAt → lastTouchAt 的日跨度算，不额外存计数列（少一列就少一处能写歪的地方）。
 * 按 UTC 日切分：确定性优先于「用户所在时区」的精确性，这个判据只需要稳定。
 */
export function touchedDays(row) {
  const start = Number(row?.createdAt);
  const end = Number(row?.lastTouchAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.floor(end / DAY_MS) - Math.floor(start / DAY_MS) + 1);
}

/**
 * 短期记忆是否该升级为长期。四条独立判据，命中任一即可：
 *   1. 被反复触及（hits ≥ consolidateHits）
 *   2. 显式重要（importance ≥ consolidateImportance）
 *   3. 跨天被触及（touchedDays ≥ consolidateTouchDays）
 *   4. 调用方明确要求（opts.explicit）
 */
export function shouldConsolidate(row, opts = {}) {
  const cfg = { ...DEFAULT_FORGETTING, ...opts };
  if (!row || row.tier !== 'short') return false;
  if (opts.explicit === true) return true;
  if (Number(row.importance ?? 0) >= cfg.consolidateImportance) return true;
  if (Number(row.hits ?? 0) >= cfg.consolidateHits) return true;
  return touchedDays(row) >= cfg.consolidateTouchDays;
}
