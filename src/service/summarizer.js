// 失活摘要任务（会话纪元模型的长期层入口）：
//
//   静默 ≥ quietMs（= 失活阈值 60min）的会话 → 从 raw 取「本会话窗口」
//   （last_summarized_at 之后、截至失活点）→ LLM 压成摘要（严格 JSON：
//   { summary, profile, relations }）→ 同事务写：
//     1) 摘要行（long 层，category=摘要，msgId=summary:<windowHash> 幂等，
//        正文带会话时间段 + 参与者 + sourceMsgIds 锚点）
//     2) profile merge（白名单/置信度合成在 profile-service）
//     3) relations[]（relation-guard 批次接入守卫写入；本文件只校验形状并透传）
//     4) 摘要游标推进（session_state.last_summarized_at）
//   任一失败整体回滚、游标不推进，下个 tick 重试。
//
// 降级边界：LLM 未启用/超时/坏 JSON/空摘要 → 不写任何东西、游标不动、只计
// degraded —— 摘要是旁路，绝不阻塞 ingest/render 主链路。
import { createHash } from 'node:crypto';
import { memoryRowId } from '../store/store-api.js';

export const DEFAULT_SUMMARIZER_CONFIG = {
  // 与失活阈值同源：静默 60 分钟 = 会话结束（用户定的口径）。
  quietMs: 60 * 60 * 1000,
  tickMs: 5 * 60 * 1000,
  maxWindowRows: 200,
  maxInputChars: 12_000,
  summaryMaxChars: 600,
  maxSessionsPerTick: 20,
  maxMessageChars: 400,
};

function platformOf(sessionId) {
  const parts = String(sessionId ?? '').split(':');
  return parts.length >= 3 ? parts[0] : '';
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

function formatTime(ts) {
  const date = new Date(Number(ts));
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(ts);
}

/** 去掉 markdown 代码围栏后解析 JSON（部分服务端无视 response_format）。 */
function parseLlmJson(text) {
  const cleaned = String(text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM output is not a JSON object');
  }
  return parsed;
}

export function createSummarizer({
  store,
  memory,
  profile = null,
  /** relation 写入钩子（relation-guard 批次注入：带守卫的 upsert/pending）。 */
  onRelations = null,
  llm,
  config = {},
  logger = () => {},
  now = Date.now,
} = {}) {
  const cfg = { ...DEFAULT_SUMMARIZER_CONFIG, ...config };
  const usable = () => Boolean(llm?.enabled);
  let timer = null;
  let running = false;
  let lastRunAt = 0;
  let degradedCount = 0;

  function status() {
    return { enabled: usable(), running, lastRunAt, degradedCount };
  }

  /** 摘要 prompt：对话窗口 + 元数据（时间段/参与者），要求严格 JSON 输出。 */
  function buildPrompt({ sessionId, rows }) {
    const participants = [...new Set(rows.map((row) => row.senderId).filter(Boolean))];
    const lines = rows.map((row) => `[${formatTime(row.createdAt)}] ${row.senderId || 'unknown'}: ${String(row.text ?? '').slice(0, cfg.maxMessageChars)}`);
    // 输入预算：从头部保起（会话开头有上下文价值），超限砍尾部。
    let body = lines.join('\n');
    if (body.length > cfg.maxInputChars) body = `${body.slice(0, cfg.maxInputChars)}\n…（已截断）`;
    return [
      '你是会话记忆整理员。把下面一段群聊/私聊记录压缩成一段摘要，供下次会话开始时回忆使用。',
      '要求：',
      '1. summary：一段话（不超过 400 字），保留关键事实、约定、未决事项；',
      '2. profile：如果对话里能看出某个参与者的性格/说话风格/口头禅/禁忌/关系定位，输出该参与者的画像补丁（subjectId 必须是参与者之一），看不出就输出 null；',
      '3. relations：从对话里抽出的原子事实（称呼/关系/生日/喜好/禁忌等），每条带 confidence(0~1)；没有就输出空数组；',
      '4. 只输出 JSON 对象，不要输出任何解释文字。',
      `会话 id：${sessionId}`,
      `参与者：${participants.length ? participants.join('、') : '（未知）'}`,
      `对话记录（${rows.length} 条）：`,
      body,
    ].join('\n');
  }

  /** 对单个会话执行「取窗口 → 摘要 → 同事务落库」。永不抛错（结果对象带 reason）。 */
  async function summarizeSession(sessionId) {
    const state = store.sessionState.get(sessionId);
    if (!state) return { sessionId, ok: false, reason: 'no-state' };
    const at = now();
    if (at - state.lastActivityAt < cfg.quietMs) return { sessionId, ok: false, reason: 'active' };

    // 摘要游标：null = 从未摘要 → 从会话最早一行 raw 开始；窗口截至失活点。
    // since 排他（游标上的那行已在上个窗口摘要过），否则恰在游标上的消息会
    // 被下个窗口重复捞回（游标永远追不上）。
    const since = state.lastSummarizedAt ?? 0;
    const until = state.lastActivityAt;
    const queried = store.raw.query({ sessionId, since, until, limit: cfg.maxWindowRows }).rows;
    const rows = state.lastSummarizedAt == null ? queried : queried.filter((row) => row.createdAt > since);
    if (rows.length === 0) return { sessionId, ok: false, reason: 'empty-window' };

    // 窗口哈希幂等：同窗口（首末行 + 条数）重复触发只推进游标，不写第二份摘要。
    const windowHash = createHash('sha1')
      .update(`${sessionId}\u0000${rows[0].id}\u0000${rows[rows.length - 1].id}\u0000${rows.length}`)
      .digest('hex');
    const summaryMsgId = `summary:${windowHash}`;
    if (store.memory.get(memoryRowId(sessionId, summaryMsgId))) {
      store.sessionState.markSummarized(sessionId, { summarizedUpTo: until, at });
      return { sessionId, ok: true, reason: 'already-summarized', windowHash };
    }

    const prompt = buildPrompt({ sessionId, rows });
    let text = null;
    try {
      text = await llm.complete({
        messages: [{ role: 'user', content: prompt }],
        json: true,
        maxTokens: 900,
        temperature: 0.2,
      });
    } catch (error) {
      // LLM 抛错（网络/超时）= 不可用，与返回 null 同口径降级。
      logger(`summarizer llm call failed (${sessionId}): ${error?.message ?? error}`);
    }
    if (text == null) {
      degradedCount += 1;
      return { sessionId, ok: false, reason: 'llm-unavailable' };
    }
    let parsed;
    try {
      parsed = parseLlmJson(text);
    } catch (error) {
      degradedCount += 1;
      return { sessionId, ok: false, reason: 'bad-json', detail: error?.message };
    }
    const summary = String(parsed.summary ?? '').trim();
    if (!summary) {
      degradedCount += 1;
      return { sessionId, ok: false, reason: 'empty-summary' };
    }

    const participants = [...new Set(rows.map((row) => row.senderId).filter(Boolean))];
    const sourceMsgIds = rows.map((row) => row.msgId);
    const windowStart = formatTime(rows[0].createdAt);
    const windowEnd = formatTime(rows[rows.length - 1].createdAt);
    const content = `会话摘要（${windowStart} ～ ${windowEnd}${participants.length ? `，与 ${participants.join('、')}` : ''}）：${summary}`.slice(0, cfg.summaryMaxChars + 120);

    const write = () => {
      // 摘要行：确定性 id（memoryRowId(session, summary:<hash>)），importance 6
      // 让它在 50 条候选池里稳定压过日常闲聊。
      memory.append({
        sessionId,
        msgId: summaryMsgId,
        tier: 'long',
        kind: 'semantic',
        category: '摘要',
        subjectId: '',
        content,
        importance: 6,
        sourceMsgIds,
      });
      // 画像 merge：白名单/置信度/版本由 profile-service 强制；无 subject 画像则跳过。
      if (profile && parsed.profile && typeof parsed.profile === 'object' && parsed.profile.subjectId) {
        try {
          profile.merge({
            sessionId,
            subjectId: String(parsed.profile.subjectId),
            platform: platformOf(sessionId),
            patch: parsed.profile,
            confidence: clamp01(parsed.profile.confidence ?? 0.6),
            sourceMsgIds: sourceMsgIds.slice(0, 20),
          });
        } catch (error) {
          // 画像失败不回滚摘要（画像可由下个窗口补全）；但要如实暴露。
          logger(`summarizer profile merge failed (${sessionId}): ${error?.message ?? error}`);
        }
      }
      // 关系守卫写入（relation-guard 批次注入；未注入 = 不写，摘要与游标照常推进）。
      // rows 一并交给守卫：规则抽取兜底在守卫内部跑（不依赖 LLM 抽全）。
      if (onRelations) {
        try {
          onRelations({ sessionId, relations: parsed.relations, sourceMsgIds, windowHash, rows });
        } catch (error) {
          logger(`summarizer relations handler failed (${sessionId}): ${error?.message ?? error}`);
        }
      }
      store.sessionState.markSummarized(sessionId, { summarizedUpTo: until, at });
      return { sessionId, ok: true, windowHash, chars: content.length };
    };

    try {
      // 摘要行 + 画像 + 游标一个事务：任一抛错整体回滚，游标不动，下个 tick 重试。
      return typeof store.transaction === 'function' ? store.transaction(write) : write();
    } catch (error) {
      degradedCount += 1;
      return { sessionId, ok: false, reason: 'write-failed', detail: error?.message };
    }
  }

  /** tick：扫静默会话逐个摘要；单会话失败不影响其余。返回结果列表（测试/运维用）。 */
  async function tick() {
    if (!usable() || running) return [];
    running = true;
    try {
      const idle = store.sessionState.listIdle({
        olderThan: now() - cfg.quietMs,
        limit: cfg.maxSessionsPerTick,
      });
      const results = [];
      for (const state of idle) {
        // 逐个 await：控制对 LLM 的并发，别一个 tick 打出 20 个请求。
        results.push(await summarizeSession(state.sessionId));
      }
      lastRunAt = now();
      const failed = results.filter((item) => item.ok === false && item.reason !== 'active' && item.reason !== 'empty-window');
      if (failed.length) logger(`summarizer tick: ${failed.length}/${results.length} sessions failed`);
      return results;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      Promise.resolve(tick()).catch((error) => logger(`summarizer tick crashed: ${error?.message ?? error}`));
    }, Math.max(30_000, cfg.tickMs));
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { tick, summarizeSession, start, stop, status };
}
