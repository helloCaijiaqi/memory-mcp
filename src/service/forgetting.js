// 遗忘机制：四种手段统一到一套权重模型，避免各管一段、互相打架。
//
//   score = baseWeight × exp(-λ × 距今上次触及的天数) + 命中加成 + 重要度加成
//
// 四种手段：
//   1. 时间衰减 —— 上式里的指数项，越久没被触及分数越低
//   2. 容量淘汰 —— 超出上限时按最低 score 淘汰（沿用 qq-bridge 里 SLANG_MAX_ENTRIES 的治理思路）
//   3. 软遗忘   —— status='archived'：不注入提示词，但控制台可见、可恢复
//   4. 硬删除   —— 物理删除，服务于被遗忘权（见 qq-bridge/docs/guides/PRIVACY.md 的同类约定）
//
// 惰性计算：读取时才算分数，不做定时全表刷新 —— 全表刷会把 I/O 放大到与记忆量成正比。
export const DEFAULT_FORGETTING = {
  lambdaPerDay: 0.08, // 约 9 天衰减到一半
  hitBonus: 0.2, // 命中加成的上限
  hitBonusFullAt: 10, // 命中多少次拿满加成
  importanceWeight: 0.5, // importance(0-10) 折算出的最大加成
  consolidateHits: 3, // 短期记忆被触及几次后升级为长期
  consolidateImportance: 7, // 或显式重要度达到多少
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysSince(timestamp, now = Date.now()) {
  return Math.max(0, (now - Number(timestamp ?? now)) / DAY_MS);
}

export function decayFactor(days, lambdaPerDay = DEFAULT_FORGETTING.lambdaPerDay) {
  return Math.exp(-Math.max(0, lambdaPerDay) * Math.max(0, days));
}

/** 单条记忆的当前权重。row 需要 baseWeight / hits / importance / lastTouchAt。 */
export function memoryScore(row, opts = {}) {
  const cfg = { ...DEFAULT_FORGETTING, ...opts };
  const now = opts.now ?? Date.now();
  const base = Number(row?.baseWeight ?? 1);
  const decayed = base * decayFactor(daysSince(row?.lastTouchAt ?? now, now), cfg.lambdaPerDay);
  const hitPart = Math.min(1, Number(row?.hits ?? 0) / cfg.hitBonusFullAt) * cfg.hitBonus;
  const impPart = (Math.min(10, Math.max(0, Number(row?.importance ?? 0))) / 10) * cfg.importanceWeight;
  return decayed + hitPart + impPart;
}

/** 生成一个可直接喂给 store.prune({ scoreOf }) 的打分函数。 */
export function makeScorer(opts = {}) {
  return (row) => memoryScore(row, opts);
}

/** 短期记忆是否该升级为长期：被反复触及，或显式标记为重要。 */
export function shouldConsolidate(row, opts = {}) {
  const cfg = { ...DEFAULT_FORGETTING, ...opts };
  if (!row || row.tier !== 'short') return false;
  return Number(row.hits ?? 0) >= cfg.consolidateHits || Number(row.importance ?? 0) >= cfg.consolidateImportance;
}
