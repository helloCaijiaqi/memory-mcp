// session-save 专项（tool.call 统一改造）：chat_memory_save 单事务语义——
// raw 批量幂等落地、subject 别名登记（card → 会话 scope / nickname → 全局 scope，
// 重名冲突降权）、摘要窗口哈希幂等、LLM 启用路径（假 provider）、画像补丁 session
// scope、epoch 推进（仅会话收尾 save，partial 分段不推进）、重放幂等。
// 取代旧 test-summarize.mjs（内部失活摘要调度器已删除）与
// test-service-ingest-step.mjs（service.call step=ingest 已下线）。全部离线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openStore } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';
import { createProfileService } from '../src/service/profile-service.js';
import { createSubjectService } from '../src/service/subject-service.js';
import { createSessionSave } from '../src/service/session-save.js';
import { createRelationService } from '../src/service/relation-service.js';
import { createRelationGuard } from '../src/service/relation-guard.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-save-'));
const SESSION = 'qq:group:50001';

const MESSAGES = [
  { msgId: 'm1', senderId: '10001', nickname: '小明', card: '小明哥', text: '我是小明，喜欢打篮球', createdAt: 1700000000000, kind: 'episodic' },
  { msgId: 'm2', senderId: '', name: 'assistant', text: '你好小明', createdAt: 1700000005000, kind: 'assistant' },
  { msgId: 'm3', senderId: '10002', nickname: '小红', text: '明哥带我一个', createdAt: 1700000010000, kind: 'episodic' },
];

async function fixture({ llm = null } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 's-'));
  const store = await openStore({ dir });
  const profile = createProfileService({ store, logger: () => {} });
  const memory = createMemoryService({ store, profile });
  const subject = createSubjectService({ store, logger: () => {} });
  const relation = createRelationService({ store });
  const guard = createRelationGuard({ store, relation, logger: () => {} });
  const save = createSessionSave({
    store, memory, subject, profile,
    guard: { handleExtracted: (input) => guard.handleExtracted(input) },
    llm,
    logger: () => {},
  });
  return { store, memory, profile, subject, save, close: () => store.close() };
}

test('save：raw 批量落地 + 别名登记 + 出站消息无 senderId 不登记 + 收尾推进纪元', async () => {
  const { store, subject, save, close } = await fixture();
  try {
    const result = await save.save({ sessionKey: SESSION, messages: MESSAGES });
    assert.equal(result.raw.created, 3);
    assert.equal(result.raw.duplicate, 0);
    assert.equal(result.alias.registered, 3, '小明哥(会话) + 小明(全局) + 小红(全局)');
    assert.equal(result.partial, false);
    assert.ok(Number.isSafeInteger(result.epoch) && result.epoch >= 1, '收尾 save 后有纪元');

    // raw 行内容：出站消息 senderId 为空、kind 保留 assistant。
    const rawRows = store.raw.query({ sessionId: SESSION, limit: 10 }).rows;
    assert.equal(rawRows.length, 3);
    const outbound = rawRows.find((row) => row.msgId === 'm2');
    assert.equal(outbound.senderId, '');
    assert.equal(outbound.kind, 'assistant');

    // 别名解析顺序：当前会话群名片 → 全局昵称。
    assert.equal(subject.resolve({ sessionId: SESSION, alias: '小明哥' }), '10001');
    assert.equal(subject.resolve({ sessionId: SESSION, alias: '小明' }), '10001');
    assert.equal(subject.resolve({ sessionId: SESSION, alias: '小红' }), '10002');
    assert.equal(subject.resolve({ sessionId: 'qq:group:别的会话', alias: '小明哥' }), null, '群名片不跨会话');
  } finally {
    close();
  }
});

test('save：重放幂等 —— raw 全 duplicate、别名不重复登记、摘要不重写、纪元不再推进', async () => {
  const { store, save, close } = await fixture();
  try {
    const first = await save.save({ sessionKey: SESSION, messages: MESSAGES });
    const epochAfterFirst = store.sessionState.get(SESSION).epoch;
    const replay = await save.save({ sessionKey: SESSION, messages: MESSAGES });
    assert.equal(replay.raw.created, 0);
    assert.equal(replay.raw.duplicate, MESSAGES.length);
    assert.equal(replay.alias.registered, 0, '同 (platform, scope, alias, subject) 幂等');
    assert.equal(replay.summary.reason, first.summary.reason, '重放不再走 LLM（窗口哈希短路）');
    assert.equal(store.memory.query({ sessionId: SESSION, tier: 'long', limit: 10 }).rows
      .filter((row) => row.content.startsWith('会话摘要')).length, 0, 'LLM 关闭时重放不产生第二份摘要');
    assert.equal(store.sessionState.get(SESSION).epoch, epochAfterFirst, '纯重放（全 duplicate）不推进纪元');
    assert.ok(first.epoch >= 1);
  } finally {
    close();
  }
});

test('save：partial=true（触顶分段）不推进纪元；后续收尾 save 推进', async () => {
  const { store, save, close } = await fixture();
  try {
    const seg1 = await save.save({ sessionKey: SESSION, messages: MESSAGES, partial: true });
    const epochAfterSeg = store.sessionState.get(SESSION).epoch;
    assert.equal(seg1.partial, true);
    // 触顶分段推进纪元的口径：partial 不推进（会话未结束，identity 不重注入）。
    const seg2 = await save.save({ sessionKey: SESSION, messages: [
      { msgId: 'm4', senderId: '10001', text: '第二段', createdAt: 1700000020000 },
    ], partial: true });
    assert.equal(store.sessionState.get(SESSION).epoch, epochAfterSeg, 'partial 分段不推进纪元');

    const final = await save.save({ sessionKey: SESSION, messages: [
      { msgId: 'm5', senderId: '10001', text: '收尾', createdAt: 1700000030000 },
    ] });
    assert.equal(final.partial, false);
    assert.equal(store.sessionState.get(SESSION).epoch, epochAfterSeg + 1, '收尾 save 推进纪元（下轮 get 重注入 identity）');
    void seg2;
  } finally {
    close();
  }
});

test('save：LLM 启用 —— 假 provider 产摘要/画像/关系，画像写 session scope，关系过守卫', async () => {
  const { store, profile, save, close } = await fixture({
    llm: {
      enabled: true,
      async complete() {
        return JSON.stringify({
          summary: '小明和小红约好一起打篮球',
          profile: { subjectId: '10001', personality: '热情', confidence: 0.8 },
          relations: [
            { subjectId: '10001', key: '称呼', value: '小明哥', confidence: 0.9 },
            { subjectId: '10001', key: '禁忌话题', value: '身高', confidence: 0.9 },
          ],
        });
      },
    },
  });
  try {
    const result = await save.save({ sessionKey: SESSION, messages: MESSAGES });
    assert.equal(result.summary.written, true);
    assert.equal(result.profileMerged, true);
    assert.ok(result.relationCandidates > 0, '关系候选进守卫');

    // 摘要行落 long 层（id 为 memoryRowId 哈希，按内容判）；画像在 session scope。
    const longRows = store.memory.query({ sessionId: SESSION, tier: 'long', limit: 20 }).rows;
    assert.ok(longRows.some((row) => row.content.startsWith('会话摘要')));
    const doc = profile.get(SESSION, '10001');
    assert.equal(doc.attributes.personality, '热情');

    // 关系落库：白名单 key（称呼）直写；白名单外 key（禁忌话题）被守卫拒绝。
    const relations = store.relation.list({ sessionId: SESSION, limit: 20 }).rows;
    assert.ok(relations.some((row) => row.subjectId === '10001' && row.key === '称呼' && row.value === '小明哥'));
    assert.equal(relations.some((row) => row.key === '禁忌话题'), false, '白名单外 key 不落库');

    // LLM 失败 → save 抛错（网关退避重试），且不留下半成品（raw 回滚）。
    const { save: failing } = await fixture({
      llm: { enabled: true, async complete() { return null; } },
    });
    try {
      await failing.save({ sessionKey: 'qq:group:999', messages: [
        { msgId: 'x1', senderId: '1', text: '新会话', createdAt: 1700000000000 },
      ] });
      assert.fail('LLM 失败必须抛错');
    } catch (error) {
      assert.match(String(error.message), /摘要不可用|LLM/);
    }
    const { store: store999 } = await fixture();
    assert.equal(store999.raw.query({ sessionId: 'qq:group:999', limit: 10 }).rows.length, 0, '失败事务回滚，raw 不落库');
    store999.close();
  } finally {
    close();
  }
});

test('save：LLM 关闭 —— 跳过摘要层，raw + alias + 纪元照常落地（长期层退化为 record）', async () => {
  const { store, save, close } = await fixture({ llm: { enabled: false } });
  try {
    const result = await save.save({ sessionKey: SESSION, messages: MESSAGES });
    assert.equal(result.summary.written, false);
    assert.equal(result.summary.reason, 'llm-disabled');
    assert.equal(result.raw.created, MESSAGES.length);
    assert.ok(result.epoch >= 1);
    assert.equal(store.memory.query({ sessionId: SESSION, tier: 'long', limit: 10 }).rows.some((row) => row.msgId.startsWith('summary:')), false);
  } finally {
    close();
  }
});

test('save：非法输入 fail-fast（空 messages / 缺 sessionKey / 全空文本）', async () => {
  const { save, close } = await fixture();
  try {
    await assert.rejects(() => save.save({ messages: MESSAGES }), /sessionKey/);
    await assert.rejects(() => save.save({ sessionKey: SESSION, messages: [] }), /messages/);
    await assert.rejects(() => save.save({ sessionKey: SESSION, messages: [{ msgId: '', text: 'x' }] }), /可落地消息/);
  } finally {
    close();
  }
});
