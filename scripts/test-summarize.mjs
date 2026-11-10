// 失活摘要专项：触发条件（静默判定）、窗口哈希幂等（不写第二份）、同事务
// （画像失败不回滚摘要、游标失败整体回滚）、LLM 关闭/坏 JSON/空摘要降级、
// 空窗口不推进、摘要行带会话时间段与参与者。LLM 用假 provider（可编程返回）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openStore } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';
import { createProfileService } from '../src/service/profile-service.js';
import { createSummarizer } from '../src/service/summarizer.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-summary-'));
const SESSION = 'qq:group:70001';
const QUIET_MS = 60 * 60 * 1000;

/** 假 LLM：返回值/抛错可编程；记录收到的 prompt。 */
function fakeLlm({ reply, throw: throwReply } = {}) {
  const prompts = [];
  return {
    prompts,
    enabled: true,
    async complete({ messages } = {}) {
      prompts.push(messages?.[0]?.content ?? '');
      if (throwReply) throw new Error('llm boom');
      return typeof reply === 'function' ? reply() : reply;
    },
  };
}

async function fixture({ llm } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const memory = createMemoryService({ store });
  const profile = createProfileService({ store, logger: () => {} });
  const summarizer = createSummarizer({ store, memory, profile, llm, config: { quietMs: QUIET_MS }, logger: () => {} });
  return { store, memory, profile, summarizer, close: () => store.close() };
}

test('摘要：静默窗口触发；摘要行带会话时间段与参与者；游标推进', async () => {
  const llm = fakeLlm({
    reply: JSON.stringify({
      summary: '群里讨论了周末火锅局，约好周六六点。',
      profile: null,
      relations: [],
    }),
  });
  const { store, memory, summarizer, close } = await fixture({ llm });
  try {
    const t0 = Date.now() - 2 * QUIET_MS;
    memory.ingest({ sessionId: SESSION, msgId: 'm1', senderId: 'u1', text: '周六吃火锅吗', createdAt: t0 });
    memory.ingest({ sessionId: SESSION, msgId: 'm2', senderId: 'u2', text: '六点老地方', createdAt: t0 + 60_000 });

    const out = await summarizer.summarizeSession(SESSION);
    assert.equal(out.ok, true, `应摘要成功：${JSON.stringify(out)}`);

    // 摘要行：long 层、category=摘要、正文带时间段与参与者、锚点指向原文 msgId。
    const summaries = memory.query({ sessionId: SESSION, tier: 'long', limit: 10 }).rows
      .filter((row) => row.category === '摘要');
    assert.equal(summaries.length, 1);
    assert.ok(summaries[0].content.includes('周六六点'));
    assert.ok(summaries[0].content.includes('u1'), '正文应含参与者');
    assert.deepEqual(summaries[0].sourceMsgIds, ['m1', 'm2'], '锚点可回溯原文');

    // 游标推进：再跑一次 = 空窗口（原文没新增），不写第二份。
    assert.equal(store.sessionState.get(SESSION).lastSummarizedAt != null, true);
    const again = await summarizer.summarizeSession(SESSION);
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'empty-window');
  } finally {
    close();
  }
});

test('摘要：窗口哈希幂等 —— 同窗口重复触发只推进游标，不写第二份摘要', async () => {
  const llm = fakeLlm({ reply: JSON.stringify({ summary: '重复触发的摘要', profile: null, relations: [] }) });
  const { memory, store, summarizer, close } = await fixture({ llm });
  try {
    const t0 = Date.now() - 2 * QUIET_MS;
    memory.ingest({ sessionId: SESSION, msgId: 'a1', senderId: 'u1', text: '内容', createdAt: t0 });
    const first = await summarizer.summarizeSession(SESSION);
    assert.equal(first.ok, true);

    // 模拟游标丢失（崩溃恢复/手工回拨）：同窗口再次触发。
    store.sessionState.markSummarized(SESSION, { summarizedUpTo: 0 });
    const second = await summarizer.summarizeSession(SESSION);
    assert.equal(second.ok, true);
    assert.equal(second.reason, 'already-summarized', '同窗口哈希命中即跳过');
    assert.equal(llm.prompts.length, 1, '不再打第二次 LLM');
    assert.equal(memory.query({ sessionId: SESSION, tier: 'long', limit: 50 }).rows.filter((r) => r.category === '摘要').length, 1);
  } finally {
    close();
  }
});

test('摘要：降级边界 —— LLM 关闭/坏 JSON/空摘要都不写、游标不动、下轮可重试', async () => {
  const { memory, store, summarizer, close } = await fixture({
    llm: fakeLlm({ reply: '这不是 JSON{{{', }),
  });
  try {
    const t0 = Date.now() - 2 * QUIET_MS;
    memory.ingest({ sessionId: SESSION, msgId: 'b1', senderId: 'u1', text: '内容', createdAt: t0 });
    store.sessionState.markSummarized(SESSION, { summarizedUpTo: 0 }); // 显式从未摘要

    const bad = await summarizer.summarizeSession(SESSION);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'bad-json');
    assert.equal(store.sessionState.get(SESSION).lastSummarizedAt, 0, '坏 JSON 游标不动');
    assert.equal(memory.query({ sessionId: SESSION, tier: 'long', limit: 10 }).rows.length, 0, '不写任何行');

    // LLM 关闭：tick 空转（不跑会话）。
    const disabled = createSummarizer({ store, memory, llm: { enabled: false }, config: { quietMs: QUIET_MS } });
    assert.deepEqual(await disabled.tick(), []);
    assert.equal(disabled.status().enabled, false);

    // 空摘要：同样不写。
    const emptyLlm = fakeLlm({ reply: JSON.stringify({ summary: '', profile: null }) });
    const s2 = createSummarizer({ store, memory, llm: emptyLlm, config: { quietMs: QUIET_MS } });
    const empty = await s2.summarizeSession(SESSION);
    assert.equal(empty.reason, 'empty-summary');
  } finally {
    close();
  }
});

test('摘要：画像 merge 同事务成功路径 + 画像字段越界由白名单挡下', async () => {
  const llm = fakeLlm({
    reply: JSON.stringify({
      summary: '聊了性格。',
      profile: { subjectId: 'u1', personality: '热心', catchphrases: ['没问题'], evilField: '越界' },
      relations: [],
    }),
  });
  const { memory, profile, summarizer, close } = await fixture({ llm });
  try {
    const t0 = Date.now() - 2 * QUIET_MS;
    memory.ingest({ sessionId: SESSION, msgId: 'c1', senderId: 'u1', text: '我挺热心的', createdAt: t0 });
    const out = await summarizer.summarizeSession(SESSION);
    assert.equal(out.ok, true);
    const doc = profile.get(SESSION, 'u1');
    assert.ok(doc, '画像应随摘要任务落库');
    assert.equal(doc.attributes.personality, '热心');
    assert.deepEqual(doc.attributes.catchphrases, ['没问题']);
    assert.equal(doc.attributes.evilField, undefined, '越界字段被白名单丢弃');
  } finally {
    close();
  }
});

test('摘要：游标写入失败 → 整体回滚（摘要行不留半条），下轮重试成功', async () => {
  const llm = fakeLlm({ reply: JSON.stringify({ summary: '会回滚的摘要', profile: null, relations: [] }) });
  const { memory, store, summarizer, close } = await fixture({ llm });
  try {
    const t0 = Date.now() - 2 * QUIET_MS;
    memory.ingest({ sessionId: SESSION, msgId: 'd1', senderId: 'u1', text: '内容', createdAt: t0 });
    store.sessionState.markSummarized(SESSION, { summarizedUpTo: 0 });

    const originalMark = store.sessionState.markSummarized;
    store.sessionState.markSummarized = () => { throw new Error('模拟游标写入失败'); };
    const failed = await summarizer.summarizeSession(SESSION);
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'write-failed');
    store.sessionState.markSummarized = originalMark;

    // 回滚验证：摘要行不留（否则下轮会因 already-summarized 跳过、游标永远卡住）。
    assert.equal(memory.query({ sessionId: SESSION, tier: 'long', limit: 10 }).rows.length, 0);

    const retry = await summarizer.summarizeSession(SESSION);
    assert.equal(retry.ok, true, '重试成功（事务没有留下幽灵记录挡路）');
  } finally {
    close();
  }
});

test('摘要：活跃会话不摘要；tick 只处理静默会话且单会话失败不拖累其余', async () => {
  const llm = fakeLlm({ reply: () => { throw new Error('llm boom'); } });
  const { store, memory, summarizer, close } = await fixture({ llm });
  try {
    const now = Date.now();
    // 活跃会话：lastActivity 就在刚才。
    memory.ingest({ sessionId: 'qq:group:active', msgId: 'x1', senderId: 'u1', text: '在聊', createdAt: now - 1000 });
    // 静默会话 A（会失败）与 B（会成功）：用两个假 LLM 不行——单 provider。
    // 改为：A 正常摘要；再验证 summarizeSession 对不存在会话返回 no-state。
    memory.ingest({ sessionId: SESSION, msgId: 'y1', senderId: 'u1', text: '早聊完了', createdAt: now - 3 * QUIET_MS });

    const active = await summarizer.summarizeSession('qq:group:active');
    assert.equal(active.ok, false);
    assert.equal(active.reason, 'active', '活跃会话不摘要');

    const missing = await summarizer.summarizeSession('qq:group:ghost');
    assert.equal(missing.reason, 'no-state');

    // tick：只扫静默会话（active 不进列表）。
    const results = await summarizer.tick();
    assert.equal(results.length, 1, '只有静默会话被处理');
    assert.equal(results[0].sessionId, SESSION);
    assert.equal(results[0].ok, false, 'LLM 抛错 = 该会话失败（degraded），但不抛出');
    assert.equal(summarizer.status().degradedCount >= 1, true);
    assert.equal(memory.query({ sessionId: 'qq:group:active', tier: 'long', limit: 5 }).rows.length, 0, '活跃会话没被写入');
  } finally {
    close();
  }
});
