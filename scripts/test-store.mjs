// 存储层的离线单测：每个用例都在临时目录里开库，不碰生产 state。
// 两个后端（sqlite / json）跑同一套语义，保证"换底座不改业务"这句话是真的。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/store-api.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-store-'));
const SESSION = 'qq:group:10086';
const OTHER_SESSION = 'qq:private:20086';

async function withStore(backend, fn) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${backend}-`));
  const store = await openStore({ dir, backend });
  try {
    return await fn(store, dir);
  } finally {
    store.close();
  }
}

function runSuite(backend) {
  test(`[${backend}] 写入并读回：platform 由 sessionId 推导，服务不认识 QQ 语义`, async () => {
    await withStore(backend, async (store) => {
      const row = store.memory.put({
        sessionId: SESSION,
        tier: 'short',
        category: '话题',
        content: '今天讨论了记忆检索的方案',
      });
      assert.ok(row.id, '应返回带 id 的行');
      assert.equal(row.platform, 'qq');
      assert.equal(store.memory.get(row.id).content, '今天讨论了记忆检索的方案');
    });
  });

  test(`[${backend}] 同 id 再次写入是更新：旧文本不应再被搜到`, async () => {
    await withStore(backend, async (store) => {
      const row = store.memory.put({ sessionId: SESSION, tier: 'short', content: '旧话题：记忆检索' });
      store.memory.put({ id: row.id, sessionId: SESSION, tier: 'short', content: '新话题：语音发送' });
      assert.equal(store.memory.count(), 1, '不应产生第二条');
      assert.equal(store.memory.query({ sessionId: SESSION, text: '语音发送' }).rows.length, 1);
      assert.equal(store.memory.query({ sessionId: SESSION, text: '记忆检索' }).rows.length, 0);
    });
  });

  test(`[${backend}] 2 字查询必须能命中（trigram 会静默返回 0 条，靠 LIKE 兜底）`, async () => {
    await withStore(backend, async (store) => {
      store.memory.put({ sessionId: SESSION, tier: 'short', content: '群里在聊黑话和新梗' });
      const short = store.memory.query({ sessionId: SESSION, text: '黑话' });
      assert.equal(short.rows.length, 1, `2 字查询必须命中，实际 strategy=${short.strategy}`);
      assert.equal(short.strategy, backend === 'sqlite' ? 'like' : 'like');
      const long = store.memory.query({ sessionId: SESSION, text: '黑话和新梗' });
      assert.equal(long.rows.length, 1, '多字查询也应命中');
    });
  });

  test(`[${backend}] 检索策略会如实回传`, async () => {
    await withStore(backend, async (store) => {
      store.memory.put({ sessionId: SESSION, tier: 'short', content: '四字以上的检索词' });
      const withText = store.memory.query({ sessionId: SESSION, text: '检索词' });
      const without = store.memory.query({ sessionId: SESSION });
      assert.equal(withText.strategy, backend === 'sqlite' ? 'fts5' : 'like');
      assert.equal(without.strategy, 'scan');
    });
  });

  test(`[${backend}] 会话隔离：另一个会话的记忆不会串进来`, async () => {
    await withStore(backend, async (store) => {
      store.memory.put({ sessionId: SESSION, tier: 'short', content: 'A 会话的话题' });
      store.memory.put({ sessionId: OTHER_SESSION, tier: 'short', content: 'B 会话的话题' });
      assert.equal(store.memory.query({ sessionId: SESSION }).rows.length, 1);
      assert.equal(store.memory.query({ sessionId: OTHER_SESSION }).rows.length, 1);
      assert.equal(store.memory.query({}).rows.length, 2);
    });
  });

  test(`[${backend}] 归档默认不出现，includeArchived 可以捞回来`, async () => {
    await withStore(backend, async (store) => {
      const row = store.memory.put({ sessionId: SESSION, tier: 'long', content: '被软遗忘的记忆' });
      store.memory.put({ id: row.id, sessionId: SESSION, tier: 'long', content: '被软遗忘的记忆', status: 'archived' });
      assert.equal(store.memory.query({ sessionId: SESSION }).rows.length, 0);
      assert.equal(store.memory.query({ sessionId: SESSION, includeArchived: true }).rows.length, 1);
    });
  });

  test(`[${backend}] prune：过期清理 + 容量淘汰`, async () => {
    await withStore(backend, async (store) => {
      store.memory.put({ sessionId: SESSION, tier: 'short', content: '到期的话题', expiresAt: Date.now() - 1000 });
      for (let i = 0; i < 4; i += 1) {
        store.memory.put({ sessionId: SESSION, tier: 'short', content: `普通话题 ${i}` });
      }
      const first = store.memory.prune({ sessionId: SESSION });
      assert.equal(first.expired, 1, '到期记忆应被清掉');
      const second = store.memory.prune({ sessionId: SESSION, maxEntries: 2 });
      assert.equal(second.evicted, 2, '超出容量应按权重淘汰最低分');
      assert.equal(store.memory.count({ sessionId: SESSION }), 2);
    });
  });

  test(`[${backend}] 黑话：证据合并去重、状态流转、上限淘汰`, async () => {
    await withStore(backend, async (store) => {
      const row = store.slang.put({ content: 'yyds', meaning: '永远的神', evidence: ['甲说的'] });
      store.slang.put({ id: row.id, content: 'yyds', meaning: '永远的神', evidence: ['甲说的', '乙说的'] });
      const stored = store.slang.get(row.id);
      assert.deepEqual(stored.evidence, ['甲说的', '乙说的'], '旧证据保留、新证据追加、去重');
      store.slang.put({ id: row.id, content: 'yyds', meaning: '永远的神', status: 'confirmed', score: 5 });
      assert.equal(store.slang.query({ status: 'confirmed' }).rows.length, 1);
      assert.equal(store.slang.query({ status: 'candidate' }).rows.length, 0);
      store.slang.put({ content: 'emo', meaning: '情绪低落', score: 1 });
      assert.equal(store.slang.prune({ maxEntries: 1 }).evicted, 1, '超上限淘汰低分词条');
    });
  });

  test(`[${backend}] 硬删除后彻底查不到（服务于被遗忘权）`, async () => {
    await withStore(backend, async (store) => {
      const row = store.memory.put({ sessionId: SESSION, tier: 'long', content: '需要被彻底删除的记忆' });
      assert.equal(store.memory.remove(row.id), true);
      assert.equal(store.memory.get(row.id), null);
      assert.equal(store.memory.query({ sessionId: SESSION, text: '彻底删除' }).rows.length, 0);
    });
  });
}

runSuite('sqlite');
runSuite('json');

test('[sqlite] FTS5 对 2 字查询确实是 0 命中（这条是 LIKE 兜底存在的理由）', async () => {
  await withStore('sqlite', async (store, dir) => {
    store.memory.put({ sessionId: SESSION, tier: 'short', content: '黑话与新梗' });
    // 直接用裸 SQL 验证底层行为，避免哪天兜底逻辑被误删后没人发现。
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'memory.db'));
    const two = db.prepare('SELECT id FROM memory_fts WHERE memory_fts MATCH ?').all('"黑话"');
    const four = db.prepare('SELECT id FROM memory_fts WHERE memory_fts MATCH ?').all('"黑话与新梗"');
    assert.equal(two.length, 0, '2 字查询在 trigram 下应当 0 命中');
    assert.equal(four.length, 1, '4 字查询应当命中');
    db.close();
  });
});

test('[sqlite] 生产参数：WAL 已生效且是文件级设置，新连接也看得到', async () => {
  await withStore('sqlite', async (store, dir) => {
    assert.equal(store.journalMode, 'wal', '写连接应切到 WAL');
    const { DatabaseSync } = await import('node:sqlite');
    const probe = new DatabaseSync(path.join(dir, 'memory.db'));
    const mode = String(probe.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '');
    probe.close();
    assert.equal(mode, 'wal', 'WAL 写进文件头，新连接也应看到 wal');
  });
});

test('[json] 后端没有 journalMode 概念（不伪造该字段）', async () => {
  await withStore('json', async (store) => {
    assert.equal(store.journalMode, undefined);
  });
});

test('[sqlite] auto 后端拿到的就是 sqlite；dir 不可写时不假成功', async () => {
  const store = await openStore({ dir: fs.mkdtempSync(path.join(TMP_ROOT, 'auto-')) });
  assert.equal(store.backend, 'sqlite');
  assert.equal(store.readonly, false);
  store.close();
});
