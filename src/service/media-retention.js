/**
 * 媒体缺省清退 + 占位符一致性修复（媒体管道 v2，2026-11-24；2026-11-26 清退语义重设计）。
 *
 * 清退策略（缺省）：media_asset 中**未收藏**且 updated_at 超过 retentionDays 的资产
 * → 删源文件 + 删详情记录。收藏（favorited=1）豁免「主动删文件」路径，永久保留；
 * pending/synthesizing（合成中/待解析中间态）硬约束跳过，绝不误删。status==='ready'
 * 的隐式豁免已移除——未收藏 ready 资产超龄同样清退，记忆经占位符描述封存进 raw。
 *
 * 一致性修复（用户定案）：源文件消失的资产，其占位符不能残留——
 *   ①raw_message：批量把 [media:<id>] 占位符替换为「[类型|内容已清退|<描述>]」
 *     （按资产 kind 定类型词 + 描述封存，一次扫描多 id，审计 A4 防逐资产全表扫）；
 *     FTS 同步重建。
 *   ②长期摘要（memory 表 tier='long'）：防御性扫描替换（rewriteForSummary
 *     写入时已把占位符转文字，正常扫不到——漏网兜底）。
 *   ③召回时惰性验证兜底漏网（media-service.renderPlaceholders → repairPlaceholder）。
 */

import { unlinkSync, existsSync } from 'node:fs';

/** 缺省清退文字（无类型上下文的缺省；实际替换按资产 kind + desc 生成三段式）。 */
export const RETIRED_MEDIA_TEXT = '[图片|内容已清退]';

/** 公用 id 正则（与 bridge / memory-ingest / store-api 同源——占位符正则单格式化后
 *  修复按 id 匹配，不再依赖具体格式字面量）。 */
const MEDIA_ID_RE = /^ma_[0-9a-f]{12}$/;

/** 资产 kind → 占位符类型词（清退替换的类型保持依据；kind 是权威类型）。 */
const KIND_ZH = { image: '图片', voice: '语音', video: '视频', file: '文件' };

/**
 * 生成清退替换文本：[<类型>|<核心词>|<描述>]，描述缺失退化为 [<类型>|<核心词>]。
 * 核心词取自 retiredText/override 的末尾中文短语（config.retiredText override 语义
 * 保留）；描述封存：desc/textContent 截断 120 固化进占位符（记忆不随详情行死亡）。
 */
function buildRetired(kindZh, desc, retiredText = RETIRED_MEDIA_TEXT) {
  const core = String(retiredText).match(/[\u4e00-\u9fa5]+(?=])$/)?.[0] ?? '内容已清退';
  const body = String(desc ?? '').trim().slice(0, 120);
  const zh = KIND_ZH[kindZh] ?? '媒体';
  return body ? `[${zh}|${core}|${body}]` : `[${zh}|${core}]`;
}

/** 逃逸 LIKE 通配符（% _ \）——与 sqlite-text.js 的 likePattern 同语义。 */
function likePattern(text) {
  return `%${String(text).replace(/([%_\\])/g, '\\$1')}%`;
}

/**
 * 占位符一致性修复：对一批已删除/缺失的资产 id，把 memory 表与 raw_message 表
 * 中残留的占位符替换为缺省文字。只替换占位符子串，其余字节不动。
 * descs（可选）：id → { desc, kind } 快照——删行前由 runOnce 批量读出，用于类型
 * 保持 + 描述封存（[类型|内容已清退|<描述>]）；缺省（手动调用/测试）退化为
 * 图片类型无描述清退文本。
 * JSON 兜底后端：raw 无替换原语——跳过 raw（兜底库不做清退修复），memory 仍修。
 */
function repairPlaceholderBatch(store, ids, retiredText = RETIRED_MEDIA_TEXT, logger = () => {}, descs = new Map()) {
  const pairs = [];
  for (const id of ids) {
    if (!MEDIA_ID_RE.test(String(id))) continue;
    // v3 id 模式：传 id 而非占位符字面量——raw/memory 行内按 id 匹配任意形态占位符。
    // runOnce 路径：descs 快照在（类型按 kind 生成 + 描述封存）；手动/回调路径
    // （renderPlaceholders repairPlaceholder / 测试）无快照——retiredText 即完整
    // 替换文本（调用方已按占位符类型生成），原样使用保留 override 语义。
    const snap = descs.get(id);
    pairs.push([id, snap ? buildRetired(snap.kind ?? 'image', snap.desc, retiredText) : retiredText]);
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
        // 函数式替换：desc 可能含 $&/$' 等，字符串替换会被当特殊模式解析
        const next = row.content.replace(phRe, () => replacement);
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
      // 候选（2026-11-26 清退语义重设计）：
      //   favorited=1 → 豁免（收藏是「主动删文件」路径的唯一豁免依据）；
      //   synthesizing → 硬约束跳过（合成 25-90s 中间态，sourcePath 为空绝不误删）；
      //   pending 且无 sourcePath → 硬约束跳过（analyzer 队列中间态）；
      //   ready 隐式豁免已移除——未收藏超龄一律清，记忆经描述封存进 raw。
      const candidates = rows.filter(
        (r) => !r.favorited && !(r.status === 'synthesizing' || (r.status === 'pending' && !r.sourcePath))
          && Number.isFinite(r.updatedAt) && r.updatedAt < cutoff,
      );
      // 删行前快照（类型保持 + 描述封存的原料）：id → { desc, kind }
      const snapshots = new Map(
        candidates.map((r) => [r.id, { desc: r.desc ?? r.textContent ?? '', kind: r.kind ?? 'image' }]),
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
      // 批量一致性修复（一次扫描多 id——审计 A4；描述封存用删行前快照）
      let repair = { memoryRows: 0, rawRows: 0, ids: [] };
      if (!dryRun && removedIds.length) {
        repair = repairPlaceholderBatch(store, removedIds, cfg.retiredText, logger, snapshots);
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

  /**
   * 单资产清退（2026-11-26 抽出，供 role-voice-scanner prune 按段路由接线）：
   * 与 runOnce 同语义的单条版本——favorited → skipped（收藏豁免单实现）；
   * synthesizing/pending 且无 sourcePath → skipped（中间态硬约束）；
   * 否则 删源文件 + 删详情行 + raw/摘要占位符固化（快照取本行 desc/kind）。
   * 返回 { skipped: 原因 } 或 { retired, memoryRows, rawRows }。
   */
  async function retireOne(row) {
    const id = String(row?.id ?? '');
    if (!MEDIA_ID_RE.test(id)) return { skipped: 'bad-id' };
    let cur = row;
    try { cur = media.get(id) ?? row; } catch { /* 行已不在，按传入行处理 */ }
    if (cur?.favorited) return { skipped: 'favorited' };
    if (cur?.status === 'synthesizing' || (cur?.status === 'pending' && !cur.sourcePath)) return { skipped: 'transient' };
    const snapshots = new Map([[id, { desc: cur.desc ?? cur.textContent ?? '', kind: cur.kind ?? 'image' }]]);
    // 源文件路径：详情行为准（收媒体路径在 DB）；合成产物旧数据 sourcePath 为空时
    // 用调用方传入路径兜底（scanner prune 手里只有磁盘文件路径）
    const sourcePath = String(cur.sourcePath || row?.sourcePath || '').trim();
    if (sourcePath && existsSync(sourcePath)) {
      try { unlinkSync(sourcePath); } catch (error) {
        logger(`[media-retention] 源文件删除失败 ${id}: ${error?.message ?? error}`);
      }
    }
    try { media.remove(id); } catch (error) {
      logger(`[media-retention] 记录删除失败 ${id}: ${error?.message ?? error}`);
      return { skipped: 'remove-failed' };
    }
    const repair = repairPlaceholderBatch(store, [id], cfg.retiredText, logger, snapshots);
    return { retired: id, memoryRows: repair.memoryRows, rawRows: repair.rawRows };
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

  return { start, stop, runOnce, retireOne, stats, repairPlaceholderBatch };
}

export default { createMediaRetention, RETIRED_MEDIA_TEXT, repairPlaceholderBatch };
