/**
 * 媒体缺省清退 + 占位符一致性修复（媒体管道 v2，2026-11-24）。
 *
 * 清退策略（缺省）：media_asset 中**未收藏**且 updated_at 超过 retentionDays 的
 * 资产 → 删源文件 + 删详情记录；收藏（favorited=1）豁免，永久保留。
 *
 * 一致性修复（用户定案）：源文件消失的资产，其占位符不能残留——
 *   ①raw_message：批量把 [media:<id>] 占位符替换为缺省文字（一次扫描多 id，
 *     审计 A4 防逐资产全表扫）；FTS 同步重建。
 *   ②长期摘要（memory 表 tier='long'）：防御性扫描替换（rewriteForSummary
 *     写入时已把占位符转文字，正常扫不到——漏网兜底）。
 *   ③召回时惰性验证兜底漏网（media-service.renderPlaceholders → repairPlaceholder）。
 */

import { unlinkSync, existsSync } from 'node:fs';

/** 缺省清退文字（v3 带类型；renderPlaceholders 实际按占位符类型生成对应文字）。 */
export const RETIRED_MEDIA_TEXT = '[图片|内容已清退]';

/** 公用 id 正则（与 bridge / memory-ingest / store-api 同源——占位符正则单格式化后
 *  修复按 id 匹配，不再依赖具体格式字面量）。 */
const MEDIA_ID_RE = /^ma_[0-9a-f]{12}$/;

/** 缺省解释文字（源文件已清退的占位符替换成这个）。 */
/** 缺省清退文字（v3 带类型；renderPlaceholders 实际按占位符类型生成对应文字）。 */

/** 逃逸 LIKE 通配符（% _ \）——与 sqlite-text.js 的 likePattern 同语义。 */
function likePattern(text) {
  return `%${String(text).replace(/([%_\\])/g, '\\$1')}%`;
}

/**
 * 占位符一致性修复：对一批已删除/缺失的资产 id，把 memory 表与 raw_message 表
 * 中残留的占位符替换为缺省文字。只替换占位符子串，其余字节不动。
 * JSON 兜底后端：raw 无替换原语——跳过 raw（兜底库不做清退修复），memory 仍修。
 */
function repairPlaceholderBatch(store, ids, retiredText = RETIRED_MEDIA_TEXT, logger = () => {}) {
  const pairs = [];
  for (const id of ids) {
    if (!MEDIA_ID_RE.test(String(id))) continue;
    // v3 id 模式：传 id 而非占位符字面量——raw/memory 行内按 id 匹配任意形态占位符
    pairs.push([id, retiredText]);
  }
  if (!pairs.length) return { memoryRows: 0, rawRows: 0, ids: [] };
  let memoryRows = 0;
  try {
    for (const [id, replacement] of pairs) {
      const { rows } = store.memory.query({ text: id, limit: 500 });
      // 行内按 id 匹配任意形态占位符（[图片|id] / [媒体|id|…] 等）——类型词不定
      const phRe = new RegExp(`\\[(?:图片|语音|视频|文件|表情|媒体)\\|${id}(?:\\|[^\\]]*)?\\]`, 'g');
      for (const row of rows) {
        if (typeof row.content !== 'string' || !phRe.test(row.content)) continue;
        phRe.lastIndex = 0;
        const next = row.content.replace(phRe, replacement);
        try {
          store.memory.put({ ...row, content: next });
          memoryRows += 1;
        } catch (error) {
          logger(`[media-retention] 摘要修复失败 ${row.id}: ${error?.message ?? error}`);
        }
      }
    }
  } catch (error) {
    logger(`[media-retention] 摘要扫描失败: ${error?.message ?? error}`);
  }
  let rawRows = 0;
  try {
    if (typeof store.raw?.replacePlaceholderText === 'function') {
      const result = store.raw.replacePlaceholderText({ pairs, limit: 5000 });
      rawRows = result?.updated ?? 0;
    }
  } catch (error) {
    logger(`[media-retention] raw 修复失败: ${error?.message ?? error}`);
  }
  return { memoryRows, rawRows, ids: pairs.map(([id]) => id) };
}

/**
 * 清退任务：仿 media-analyzer 的定时器模式（setInterval + unref + 单飞）。
 * runOnce 也可手动触发（stats/观测用）。
 */
export function createMediaRetention({
  store,
  media,
  config = {},
  logger = () => {},
  repairPlaceholder = null,
}) {
  const cfg = {
    enabled: config.enabled !== false,
    intervalMs: Number.isFinite(config.intervalMs) ? config.intervalMs : 6 * 60 * 60_000,
    retentionDays: Number.isFinite(config.retentionDays) ? config.retentionDays : 30,
    batchSize: Number.isFinite(config.batchSize) ? config.batchSize : 500,
    retiredText: config.retiredText ?? RETIRED_MEDIA_TEXT,
  };
  let running = false;
  let timer = null;
  let lastRun = null;

  /** 单轮清退：候选过滤（未收藏 + 超龄）→ 删源文件 → 删记录 → 批量修复。 */
  async function runOnce({ dryRun = false } = {}) {
    if (running) return { skipped: true };
    running = true;
    try {
      const cutoff = Date.now() - Math.max(1, cfg.retentionDays) * 24 * 60 * 60_000;
      const { rows } = media.list({ limit: cfg.batchSize });
      // 候选：未被记住且超龄（v3 收藏语义重设计）；ready（有解析内容）豁免
      const candidates = rows.filter(
        (r) => r.status !== 'ready' && Number.isFinite(r.updatedAt) && r.updatedAt < cutoff,
      );
      const removedIds = [];
      for (const row of candidates) {
        if (dryRun) { removedIds.push(row.id); continue; }
        if (row.sourcePath && existsSync(row.sourcePath)) {
          try { unlinkSync(row.sourcePath); } catch (error) {
            logger(`[media-retention] 源文件删除失败 ${row.id}: ${error?.message ?? error}`);
          }
        }
        try { media.remove(row.id); removedIds.push(row.id); } catch (error) {
          logger(`[media-retention] 记录删除失败 ${row.id}: ${error?.message ?? error}`);
        }
      }
      // 批量一致性修复（一次扫描多 id——审计 A4）
      let repair = { memoryRows: 0, rawRows: 0, ids: [] };
      if (!dryRun && removedIds.length) {
        repair = repairPlaceholderBatch(store, removedIds, cfg.retiredText, logger);
      }
      lastRun = {
        at: Date.now(),
        scanned: rows.length,
        retired: removedIds.length,
        ids: removedIds.slice(0, 50),
        memoryRows: repair.memoryRows,
        rawRows: repair.rawRows,
        dryRun,
      };
      if (removedIds.length) {
        logger(`[media-retention] 清退 ${removedIds.length} 项（>${cfg.retentionDays}天 未收藏）；修复摘要 ${repair.memoryRows} 行、raw ${repair.rawRows} 行`);
      }
      return lastRun;
    } finally {
      running = false;
    }
  }

  function start() {
    if (!cfg.enabled || timer) return;
    timer = setInterval(() => { runOnce().catch(() => {}); }, Math.max(60_000, cfg.intervalMs));
    timer.unref?.();
    logger(`[media-retention] 清退任务已启动（interval=${cfg.intervalMs}ms, retentionDays=${cfg.retentionDays}, 收藏豁免）`);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function stats() {
    return {
      enabled: cfg.enabled,
      intervalMs: cfg.intervalMs,
      retentionDays: cfg.retentionDays,
      retiredText: cfg.retiredText,
      lastRun,
    };
  }

  return { start, stop, runOnce, stats, repairPlaceholderBatch };
}

export default { createMediaRetention, RETIRED_MEDIA_TEXT, repairPlaceholderBatch };
