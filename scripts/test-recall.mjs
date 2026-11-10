// 主动召回的单元测试：策略透传、平台收窄、后端占位、预算裁剪、原文兜底、record 幂等。
// 只起临时库，不连 HTTP / MCP —— 接口层在 test-interfaces.mjs 里验。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { memoryRowId, openStore } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';
import { createFts5Backend, createRecallRouter, createVectorBackend } from '../src/service/recall.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-recall-'));
const SESSION = 'qq:group:30001';
const WX_SESSION = 'wx:room:30001';

async function fixture(recallConfig = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const memory = createMemoryService({ store });
  const recall = createRecallRouter({
    store,
    backends: [createFts5Backend({ store }), createVectorBackend()],
    config: recallConfig,
  });
  return { store, memory, recall, close: () => store.close() };
}

test('召回：中文关键词既能走 FTS5 也能落 LIKE，策略如实透传', async () => {
  const { memory, recall, close } = await fixture();
  try {
    memory.append({ sessionId: SESSION, tier: 'long', content: '用户讨厌被敷衍', category: '画像' });

    // 3 字以上走 trigram；2 字必然落 LIKE —— 两条路径都必须能召回，而不是「搜不到就算没有」。
    const long = recall.recall({ sessionId: SESSION, text: '讨厌被敷衍' });
    assert.equal(long.strategy, 'fts5');
    assert.equal(long.rows.length, 1);
    assert.equal(long.rows[0].layer, 'memory');

    const short = recall.recall({ sessionId: SESSION, text: '敷衍' });
    assert.equal(short.strategy, 'like');
    assert.equal(short.rows.length, 1);
    assert.ok(short.text.startsWith('- '), '返回的 text 应可直接拼进【召回】段');
  } finally {
    close();
  }
});

test('召回：默认只查当前平台，跨平台请求被降级并显式标注', async () => {
  const { memory, recall, close } = await fixture();
  try {
    memory.append({ sessionId: SESSION, tier: 'long', content: 'QQ 群里说过：周末去爬山' });
    memory.append({ sessionId: WX_SESSION, tier: 'long', content: '微信里说过：周末去爬山' });

    const local = recall.recall({ sessionId: SESSION, text: '爬山' });
    assert.equal(local.scope, 'platform');
    assert.deepEqual(local.platforms, ['qq']);
    assert.equal(local.downgraded, false);
    assert.equal(local.rows.length, 1);
    assert.equal(local.rows[0].sessionId, SESSION, '不许跨会话召回');

    const denied = recall.recall({ sessionId: SESSION, text: '爬山', platforms: ['wx'] });
    assert.equal(denied.scope, 'platform', '未开启时必须降级为当前平台');
    assert.equal(denied.downgraded, true);
    assert.deepEqual(denied.platforms, ['qq']);
    assert.equal(denied.rows.length, 1);
    assert.equal(denied.rows[0].sessionId, SESSION);
  } finally {
    close();
  }
});

test('召回：显式开启后可以跨平台，结果带 platform 便于区分来源', async () => {
  const { memory, recall, close } = await fixture({ crossPlatform: true });
  try {
    memory.append({ sessionId: SESSION, tier: 'long', content: 'QQ 群里说过：周末去爬山' });
    memory.append({ sessionId: WX_SESSION, tier: 'long', content: '微信里说过：周末去爬山' });

    const out = recall.recall({ sessionId: SESSION, text: '爬山', platforms: ['qq', 'wx'] });
    assert.equal(out.scope, 'cross-platform');
    assert.equal(out.downgraded, false);
    assert.deepEqual(out.platforms, ['qq', 'wx']);
    assert.equal(out.rows.length, 2);
    assert.deepEqual(
      out.rows.map((row) => row.platform).sort(),
      ['qq', 'wx'],
    );
  } finally {
    close();
  }
});

test('召回：向量后端是占位，没有被误当成可用能力', async () => {
  const { store, close } = await fixture();
  try {
    const router = createRecallRouter({ store, backends: [createVectorBackend()], config: {} });
    assert.deepEqual(router.available(), []);
    assert.deepEqual(router.backends, ['vector']);
    const out = router.recall({ sessionId: SESSION, text: '随便' });
    assert.equal(out.strategy, 'unavailable');
    assert.equal(out.backend, null);
    assert.equal(out.rows.length, 0);
  } finally {
    close();
  }
});

test('召回：条数与字符双预算，截断要说出来', async () => {
  const { memory, recall, close } = await fixture({ maxRows: 1, maxChars: 12 });
  try {
    memory.append({ sessionId: SESSION, tier: 'long', content: '用户喜欢在周末去爬山，顺便拍照' });
    memory.append({ sessionId: SESSION, tier: 'long', content: '用户爬山时一定要带够水' });

    const out = recall.recall({ sessionId: SESSION, text: '爬山' });
    assert.equal(out.rows.length, 1, 'maxRows 必须生效');
    assert.equal(out.truncated.rows, true);
    assert.equal(out.truncated.chars, true);
    assert.ok(out.text.includes('召回已截断'), `截断必须显式标注，实际：${out.text}`);
    assert.ok(out.chars <= 40, `字符预算被超出：${out.chars}`);
  } finally {
    close();
  }
});

test('召回：短期记忆被淘汰后，原文仍能被召回（L0 兜底）', async () => {
  const { memory, recall, close } = await fixture();
  try {
    memory.ingest({ sessionId: SESSION, msgId: 'r1', senderId: 'u1', text: '三天前说过：讨厌被敷衍' });
    // 模拟短期层被淘汰：原文还在，摘要没了。
    memory.forget({ id: memoryRowId(SESSION, 'r1'), mode: 'hard' });

    const out = recall.recall({ sessionId: SESSION, text: '讨厌被敷衍' });
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].layer, 'raw');
    assert.equal(out.rows[0].msgId, 'r1');
    assert.ok(out.rows[0].anchor.startsWith('m'), '原文命中要带锚点，才能回到原消息');
  } finally {
    close();
  }
});

test('召回：摘要与原文同在时只返回摘要（msgId 去重）', async () => {
  const { memory, recall, close } = await fixture();
  try {
    // raw-only：ingest 只落原文；同 msgId 的摘要行经 append 显式构造（幂等键同构）。
    memory.ingest({ sessionId: SESSION, msgId: 'r2', senderId: 'u1', text: '用户讨厌被敷衍（原文全文很长）' });
    memory.append({ sessionId: SESSION, msgId: 'r2', tier: 'long', content: '摘要：用户讨厌被敷衍' });
    const out = recall.recall({ sessionId: SESSION, text: '讨厌被敷衍' });
    assert.equal(out.rows.length, 1, '同 msgId 的原文与摘要只出一条');
    assert.equal(out.rows[0].layer, 'memory', '同等命中摘要优先');
    assert.equal(out.rows[0].msgId, 'r2');
  } finally {
    close();
  }
});

test('召回：JSON 兜底后端如实报 like，不假装有 FTS，且标注 degraded', async () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'json-'));
  const store = await openStore({ dir, backend: 'json' });
  try {
    const memory = createMemoryService({ store });
    const recall = createRecallRouter({ store, backends: [createFts5Backend({ store })], config: {} });
    memory.append({ sessionId: SESSION, tier: 'long', content: '用户讨厌被敷衍' });

    const out = recall.recall({ sessionId: SESSION, text: '敷衍' });
    assert.equal(out.strategy, 'like', '兜底实现没有 FTS，策略必须如实');
    assert.equal(out.rows.length, 1);
    assert.equal(out.degraded, true);
  } finally {
    store.close();
  }
});

test('memory_record：长期 + 同内容幂等，不堆同义行', async () => {
  const { memory, store, close } = await fixture();
  try {
    const first = memory.record({ sessionId: SESSION, content: '用户讨厌被敷衍', subjectId: '10001' });
    assert.equal(first.created, true);
    assert.equal(first.memory.tier, 'long');
    assert.equal(first.memory.expiresAt, null, 'record 的语义是「别忘」，不该带 TTL');
    assert.equal(first.memory.kind, 'semantic');

    const again = memory.record({ sessionId: SESSION, content: '用户讨厌被敷衍', subjectId: '10001' });
    assert.equal(again.created, false);
    assert.equal(again.memory.id, first.memory.id);

    const { rows } = store.memory.query({ sessionId: SESSION, text: '敷衍', limit: 10 });
    assert.equal(rows.length, 1, '重复上报不该产生第二条');

    // 不同平台同样的内容是不同的行：幂等键里含 sessionId。
    const wx = memory.record({ sessionId: WX_SESSION, content: '用户讨厌被敷衍', subjectId: '10001' });
    assert.equal(wx.created, true);
    assert.notEqual(wx.memory.id, first.memory.id);
  } finally {
    close();
  }
});
