// v2 迁移专项：expires_at 部分索引、迁移可重复执行（幂等）、prune 节流语义、
// 过期行读侧不可见（延迟淘汰不泄露）。JSON 兜底后端无索引概念，索引用例仅 sqlite。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryService } from '../src/service/memory-service.js';
import { openStore } from '../src/store/store-api.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-v2-'));
const SESSION = 'qq:group:10086';

async function withStore(fn, { config } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'v2-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  try {
    return await fn(store, dir, config ?? {});
  } finally {
    store.close();
  }
}

test('[sqlite] v2 迁移：expires_at 部分索引存在，且只覆盖有 TTL 的行', async () => {
  await withStore(async (store, dir) => {
    const { DatabaseSync } = await import('node:sqlite');
    const probe = new DatabaseSync(path.join(dir, 'memory.db'));
    const index = probe.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_expires'",
    ).get();
    probe.close();
    assert.ok(index, 'idx_memory_expires 必须存在');
    assert.match(index.sql, /WHERE expires_at IS NOT NULL/, '必须是部分索引（长期行不进索引）');
  });
});

test('[sqlite] 迁移可重复执行：手动加过列/建过索引的库不炸', async () => {
  await withStore(async (store, dir) => {
    const { DatabaseSync } = await import('node:sqlite');
    // 模拟「手工加过列」的库：把 confidence 拆掉再重建，验证迁移器的列存在性跳过。
    const probe = new DatabaseSync(path.join(dir, 'memory.db'));
    probe.exec('CREATE TABLE relation_backup AS SELECT * FROM relation');
    probe.exec('DROP TABLE relation');
    probe.exec(`CREATE TABLE relation (
       id TEXT PRIMARY KEY, session_id TEXT NOT NULL, platform TEXT NOT NULL,
       subject_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
       kind TEXT NOT NULL DEFAULT 'relation', scope TEXT NOT NULL DEFAULT 'session',
       importance INTEGER NOT NULL DEFAULT 0, decay_exempt INTEGER NOT NULL DEFAULT 1,
       confidence REAL NOT NULL DEFAULT 1, last_confirmed_at INTEGER,
       actor TEXT NOT NULL DEFAULT 'manual',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    probe.exec('INSERT INTO relation SELECT * FROM relation_backup');
    probe.exec('DROP TABLE relation_backup');
    probe.close();
    // 重新打开同一目录：迁移器跳过已存在的列，不抛 StoreMigrationError。
    const store2 = await openStore({ dir, backend: 'sqlite' });
    assert.equal(store2.backend, 'sqlite');
    store2.close();
  });
});

test('prune 节流：20 次写内不执行全量淘汰，读侧过期行不可见；强制时执行', async () => {
  await withStore(async (store) => {
    const memory = createMemoryService({ store, config: { pruneEveryN: 20, pruneIntervalMs: 60_000, maxLong: 5 } });
    // 写 8 条长期记忆（超过 maxLong=5）：节流期内不做容量淘汰。
    for (let i = 0; i < 8; i += 1) {
      memory.record({ sessionId: SESSION, content: `事实 ${i}` });
    }
    assert.equal(
      store.memory.query({ sessionId: SESSION, tier: 'long', limit: 50 }).rows.length,
      8,
      '节流期内不做容量淘汰（查询侧照常可见）',
    );
    // 强制淘汰：按分数裁到 maxLong。
    memory.forcePrune?.(SESSION, 'long');
    assert.equal(
      store.memory.query({ sessionId: SESSION, tier: 'long', limit: 50 }).rows.length,
      5,
      '强制 prune 后裁到容量上限',
    );
  });
});

test('过期行读侧不可见：延迟淘汰不等于泄露（查询内过滤 expires_at）', async () => {
  await withStore(async (store) => {
    const memory = createMemoryService({ store, config: { pruneEveryN: 1000, pruneIntervalMs: 60_000 } });
    const past = Date.now() - 1000;
    // 直接写一条已过期的行（模拟 TTL 已到但 prune 尚未执行）。
    store.memory.put({
      sessionId: SESSION,
      tier: 'short',
      content: '已过期的短期记忆',
      createdAt: past,
      updatedAt: past,
      lastTouchAt: past,
      expiresAt: past,
    });
    const { rows } = store.memory.query({ sessionId: SESSION, limit: 50 });
    assert.equal(rows.length, 0, '查询必须过滤过期行（节流只推迟物理删除）');
    assert.equal(store.memory.count({ sessionId: SESSION }), 0);
    // 物理行还在（未被 prune），prune 后物理删除：
    const outcome = store.memory.prune({ sessionId: SESSION, tier: 'short', maxEntries: 200, now: Date.now() });
    assert.ok(outcome.expired >= 1, `prune 应清掉过期行，实际 ${JSON.stringify(outcome)}`);
  });
});
