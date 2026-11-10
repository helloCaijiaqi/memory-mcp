// 稳定头部（head）+ 动态尾部（tail）：把「基本不变的内容」与「每轮都变的内容」分开注入。
//
// 为什么值得单开一个模块：模型的前缀缓存是按字节比对的。head 里只要有一个字不同
// （时间、分数、命中数、排序抖动），整段上下文都要重算。所以 head 的渲染规则必须满足：
//   1. 只依赖记忆内容，不依赖 now / score / hits；
//   2. 排序键固定，截断按条数而不是按字符；
//   3. 生成后冻结在 head_snapshot 里，只在「自然断点」重建。
//
// tail 反过来：时间、本轮消息、召回结果每轮都在变，全部丢到末尾，坏了缓存也坏得有限。
import { createHash } from 'node:crypto';
import { DEFAULT_EMOTION_FRESH_MS } from './relation-service.js';

export const DEFAULT_HEAD_CONFIG = {
  maxLong: 20, // 长期记忆条数上限（不按字符切：字符切会让一条记忆被劈成半句）
  maxRelation: 20,
  maxSlang: 20,
  maxEmotionInTail: 3,
  maxShortInTail: 8,
  quietWindowMs: 30 * 60 * 1000, // 静默这么久才认为是一段对话的自然断点
  emotionFreshMs: DEFAULT_EMOTION_FRESH_MS, // 情绪超过 2 小时不再代表「现在」，移出稳定区
  maxHeadChars: 900,
  maxTailChars: 800,
  timeZone: 'Asia/Shanghai',
};

/** 码点序比较：不用 localeCompare，避免不同 ICU 版本排出不同的顺序。 */
function cmpStr(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

const formatters = new Map();

function formatterFor(timeZone, withTime) {
  const key = `${timeZone}|${withTime ? 'dt' : 'd'}`;
  if (formatters.has(key)) return formatters.get(key);
  const options = withTime
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { year: 'numeric', month: '2-digit', day: '2-digit' };
  let fmt;
  try {
    // sv-SE 输出 "2026-11-03 14:05"，接近 ISO 且不受系统 locale 影响。
    fmt = new Intl.DateTimeFormat('sv-SE', { timeZone, ...options });
  } catch {
    fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', ...options });
  }
  formatters.set(key, fmt);
  return fmt;
}

/** 稳定时间戳（tail 与关系 asOf 用；head 里只有「建立日期」这类粗粒度信息）。 */
export function formatStamp(timestamp, { timeZone = DEFAULT_HEAD_CONFIG.timeZone, withTime = true } = {}) {
  const n = Number(timestamp);
  if (!Number.isFinite(n)) return '';
  return formatterFor(timeZone, withTime).format(new Date(n));
}

export function revisionOf(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * 断点判定。返回 { rebuild, reason }：
 *   forced  —— 调用方显式要求（角色变更、手动失效）
 *   cold    —— 还没有快照
 *   quiet   —— 快照存在但已经静默足够久，可以做一次「批量重建」
 *   frozen  —— 仍在同一段对话里，直接复用快照（这条路径不查任何记忆表）
 *
 * 注意：这里不比对 revision —— 未重建就无从得知新 revision。revison 相同的判定在
 * 重建之后做（见 buildHead 调用方），效果一样但省掉了每轮一次全量查询。
 */
export function headDecision({
  force = false,
  snapshot = null,
  now = Date.now(),
  quietWindowMs = DEFAULT_HEAD_CONFIG.quietWindowMs,
} = {}) {
  if (force) return { rebuild: true, reason: 'forced' };
  if (!snapshot) return { rebuild: true, reason: 'cold' };
  const last = Number(snapshot.lastActivityAt ?? 0);
  if (!Number.isFinite(last) || now - last >= Math.max(0, Number(quietWindowMs) || 0)) {
    return { rebuild: true, reason: 'quiet' };
  }
  return { rebuild: false, reason: 'frozen' };
}

export function shouldRebuildHead(args = {}) {
  return headDecision(args).rebuild;
}

/** 按行截断：优先在换行处收尾，绝不把一条记忆劈成半句。 */
export function clipText(text, maxChars, marker = '…（已截断）') {
  const limit = Math.max(0, Number(maxChars) || 0);
  const source = String(text ?? '');
  if (!limit || source.length <= limit) return { text: source, truncated: false };
  const room = Math.max(0, limit - marker.length - 1);
  const head = source.slice(0, room);
  const cut = head.lastIndexOf('\n');
  const body = cut > 0 ? head.slice(0, cut) : head;
  return { text: `${body}\n${marker}`, truncated: true };
}

function longLine(row) {
  const label = row.category ? row.category : '记忆';
  return `- ${label}：${row.content}`;
}

function relationLine(row, { timeZone }) {
  const asOf = formatStamp(row.updatedAt ?? row.createdAt, { timeZone, withTime: false });
  return `- ${row.subjectId}·${row.key}：${row.value}${asOf ? `（${asOf}）` : ''}`;
}

function emotionLine(row, { timeZone }) {
  const at = formatStamp(row.updatedAt, { timeZone, withTime: true });
  return `- ${row.subjectId}：${row.value}${at ? `（${at}）` : ''}`;
}

function slangLine(row) {
  return row.meaning ? `- ${row.content}：${row.meaning}` : `- ${row.content}`;
}

/**
 * 渲染稳定区。纯函数：同样的输入必然产出同样的字节。
 *
 * 顺序与截断规则（改动这里等于改缓存命中率，务必同步更新测试）：
 *   长期：按创建时间升序取「最近 maxLong 条」（越新的画像越该留下）
 *   关系：按 subject → key → scope → id 升序取前 maxRelation 条
 *   情绪：仅保留 emotionFreshMs 内的，按 subject → id 升序取前 maxRelation 条
 *   黑话：按 content → id 升序取前 maxSlang 条
 */
export function buildHead({
  longRows = [],
  relationRows = [],
  emotionRows = [],
  slangRows = [],
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_HEAD_CONFIG, ...config };

  const long = [...longRows]
    .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0) || cmpStr(a.id, b.id))
    .slice(-Math.max(0, cfg.maxLong));
  const relations = [...relationRows]
    .sort(
      (a, b) =>
        cmpStr(a.subjectId, b.subjectId) ||
        cmpStr(a.key, b.key) ||
        cmpStr(a.scope, b.scope) ||
        cmpStr(a.id, b.id),
    )
    .slice(0, Math.max(0, cfg.maxRelation));
  const emotions = [...emotionRows]
    .sort((a, b) => cmpStr(a.subjectId, b.subjectId) || cmpStr(a.id, b.id))
    .slice(0, Math.max(0, cfg.maxRelation));
  const slang = [...slangRows].sort((a, b) => cmpStr(a.content, b.content) || cmpStr(a.id, b.id)).slice(0, Math.max(0, cfg.maxSlang));

  const sections = [];
  if (long.length) sections.push(['【长期记忆】', ...long.map(longLine)]);
  if (relations.length) sections.push(['【关系】', ...relations.map((row) => relationLine(row, cfg))]);
  if (emotions.length) sections.push(['【情绪】', ...emotions.map((row) => emotionLine(row, cfg))]);
  if (slang.length) sections.push(['【黑话】', ...slang.map(slangLine)]);

  const raw = sections.map((lines) => lines.join('\n')).join('\n');
  const clipped = clipText(raw, cfg.maxHeadChars, '…（头部已截断）');
  return {
    text: clipped.text,
    revision: revisionOf(clipped.text),
    chars: clipped.text.length,
    truncated: {
      chars: clipped.truncated,
      long: longRows.length > cfg.maxLong,
      relation: relationRows.length > cfg.maxRelation,
      emotion: emotionRows.length > cfg.maxRelation,
      slang: slangRows.length > cfg.maxSlang,
    },
  };
}

function shortLine(row) {
  const label = row.category ? row.category : '话题';
  return `- ${label}：${row.content}`;
}

/**
 * 渲染动态区：当前时间 → 短期记忆 → 上次情绪 → 召回 → 本轮正文。
 * 这里允许每轮都变；正文永远优先保留，预算不够就砍记忆段，不砍用户刚说的话。
 */
export function buildTail({
  shortRows = [],
  staleEmotions = [],
  recallText = '',
  body = '',
  now = Date.now(),
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_HEAD_CONFIG, ...config };
  const short = [...shortRows]
    .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0) || cmpStr(a.id, b.id))
    .slice(-Math.max(0, cfg.maxShortInTail));
  const emotions = [...staleEmotions]
    .sort((a, b) => Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0) || cmpStr(a.id, b.id))
    .slice(-Math.max(0, cfg.maxEmotionInTail));

  const lines = [`【当前时间】${formatStamp(now, cfg)}`];
  if (short.length) {
    lines.push('【短期记忆】', ...short.map(shortLine));
  }
  if (emotions.length) {
    lines.push('【上次情绪】', ...emotions.map((row) => emotionLine(row, cfg)));
  }
  const recall = String(recallText ?? '').trim();
  if (recall) {
    lines.push('【召回】', recall);
  }

  const text = String(body ?? '');
  const bodyBlock = text.trim() ? `\n${text}` : '';
  const budget = Math.max(0, cfg.maxTailChars - bodyBlock.length);
  const clipped = clipText(lines.join('\n'), budget);
  const out = clipText(`${clipped.text}${bodyBlock}`, cfg.maxTailChars, '…（已截断）');
  return {
    text: out.text,
    chars: out.text.length,
    truncated: out.truncated || clipped.truncated,
    counts: { short: short.length, staleEmotions: emotions.length, recallChars: recall.length },
  };
}
