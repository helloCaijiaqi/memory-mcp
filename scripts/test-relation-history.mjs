// 关系 / 情绪的单测：单值 upsert、版本链、情绪时效、作用域守门。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';
import {
  DEFAULT_EMOTION_FRESH_MS,
  RelationScopeError,
  createRelationService,
  isEmotionStale,
  partitionRelations,
} from '../src/service/relation-service.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-relation-'));
const SESSION = 'qq:group:30001';
const WX_SESSION = 'wx:room:30001';
const HOUR = 60 * 60 * 1000;

async function svc({ config = {}, backend = 'sqlite' } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend });
  const relation = createRelationService({ store, config });
  const memory = createMemoryService({ store });
  return { relation, memory, store, close: () => store.close() };
}

test('首次 upsert 建行并写第一条历史（历史最后一条 == 当前值）', async () => {
  const { relation, close } = await svc();
  try {
    const out = relation.upsert({
      sessionId: SESSION,
      subjectId: '10001',
      key: '称呼',
      value: '老王',
      sourceMsgIds: ['9001'],
      changedAt: 1000,
    });
    assert.equal(out.created, true);
    assert.equal(out.changed, true);
    assert.equal(out.row.platform, 'qq');
    assert.equal(out.row.decayExempt, true, '关系默认豁免时间衰减');

    const chain = relation.history({ sessionId: SESSION, subjectId: '10001', key: '称呼' });
    assert.equal(chain.rows.length, 1);
    assert.equal(chain.rows[0].value, '老王');
    assert.deepEqual(chain.rows[0].sourceMsgIds, ['9001'], '版本链要能回到原文');
    assert.equal(chain.rows.at(-1).value, chain.relation.value);
  } finally {
    close();
  }
});

test('同值重复上报不写历史，只更新元数据', async () => {
  const { relation, store, close } = await svc();
  try {
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王', changedAt: 1000 });
    const again = relation.upsert({
      sessionId: SESSION,
      subjectId: '10001',
      key: '称呼',
      value: '老王',
      importance: 8,
      changedAt: 2000,
    });
    assert.equal(again.created, false);
    assert.equal(again.changed, false, '同值不算变化');
    assert.equal(again.row.importance, 8, '元数据仍要更新');
    assert.equal(store.relation.count({ sessionId: SESSION }), 1, '同一 (说话人, 键) 只能有一行');

    const chain = relation.history({ sessionId: SESSION, subjectId: '10001', key: '称呼' });
    assert.equal(chain.rows.length, 1, '同值重复不该污染变更链');
  } finally {
    close();
  }
});

test('值变化才追加历史，版本链按时间升序且可限量', async () => {
  const { relation, close } = await svc();
  try {
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王', changedAt: 1000 });
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '王哥', changedAt: 2000 });
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '王哥', changedAt: 2500 });
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '小王', changedAt: 3000 });

    const chain = relation.history({ sessionId: SESSION, subjectId: '10001', key: '称呼' });
    assert.deepEqual(
      chain.rows.map((row) => row.value),
      ['老王', '王哥', '小王'],
    );
    assert.deepEqual(
      chain.rows.map((row) => row.changedAt),
      [1000, 2000, 3000],
    );
    assert.equal(chain.relation.value, '小王', '当前值永远是最后一条历史');

    const limited = relation.history({ sessionId: SESSION, subjectId: '10001', key: '称呼', limit: 2 });
    assert.equal(limited.rows.length, 2);
  } finally {
    close();
  }
});

test('情绪默认不豁免衰减，关系默认豁免；缺字段时报错而不是写半条', async () => {
  const { relation, close } = await svc();
  try {
    const mood = relation.upsert({ sessionId: SESSION, subjectId: '10001', key: 'mood', value: '有点烦', kind: 'emotion' });
    assert.equal(mood.row.kind, 'emotion');
    assert.equal(mood.row.decayExempt, false);

    assert.throws(
      () => relation.upsert({ sessionId: SESSION, key: '称呼', value: '老王' }),
      /subjectId/,
    );
    assert.throws(() => relation.upsert({ sessionId: SESSION, subjectId: '10001', value: '老王' }), /key/);
  } finally {
    close();
  }
});

test('作用域守门：scope=identity 默认拒绝读写，开启后才生效', async () => {
  const { relation, store, close } = await svc();
  try {
    assert.throws(
      () => relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王', scope: 'identity' }),
      (error) => error instanceof RelationScopeError,
    );
    assert.throws(
      () => relation.get({ sessionId: SESSION, subjectId: '10001', key: '称呼', scope: 'identity' }),
      RelationScopeError,
    );
    assert.equal(store.relation.count({ sessionId: SESSION }), 0, '被拒绝的写入不能留下任何行');
  } finally {
    close();
  }

  const opened = await svc({ config: { identityEnabled: true } });
  try {
    const out = opened.relation.upsert({
      sessionId: SESSION,
      subjectId: '10001',
      key: '称呼',
      value: '老王',
      scope: 'identity',
    });
    assert.equal(out.row.scope, 'identity');
    // 但默认渲染仍然看不见它：跨平台共享要显式打开渲染侧。
    const head = opened.memory.renderHead({ sessionId: SESSION });
    assert.ok(!head.text.includes('老王'), 'identity 关系默认不进稳定区');
    assert.equal(opened.relation.list({ sessionId: SESSION }).length, 0, '默认 list 只返回会话内关系');
    assert.equal(
      opened.relation.list({ sessionId: SESSION, scope: 'identity' }).length,
      1,
      '显式按 identity 查才看得到',
    );
  } finally {
    opened.close();
  }
});

test('平台隔离：同一 scope:id 的两个平台各存各的关系', async () => {
  const { relation, store, close } = await svc();
  try {
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: 'QQ 侧的老王' });
    relation.upsert({ sessionId: WX_SESSION, subjectId: '10001', key: '称呼', value: '微信侧的老王' });

    assert.equal(relation.get({ sessionId: SESSION, subjectId: '10001', key: '称呼' }).value, 'QQ 侧的老王');
    assert.equal(relation.get({ sessionId: WX_SESSION, subjectId: '10001', key: '称呼' }).value, '微信侧的老王');
    assert.equal(store.relation.count({ platform: 'qq' }), 1);
    assert.equal(store.relation.count({ platform: 'wx' }), 1);
  } finally {
    close();
  }
});

test('情绪时效：2 小时内算「现在」，之后算「上次情绪」', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const mood = { kind: 'emotion', updatedAt: t0, subjectId: '10001', id: 'rel_1' };
  const fact = { kind: 'relation', updatedAt: t0, subjectId: '10001', id: 'rel_2' };

  assert.equal(isEmotionStale(mood, { at: t0 + DEFAULT_EMOTION_FRESH_MS }), false, '恰好到期仍算新鲜');
  assert.equal(isEmotionStale(mood, { at: t0 + DEFAULT_EMOTION_FRESH_MS + 1 }), true);
  assert.equal(isEmotionStale(fact, { at: t0 + 30 * 24 * HOUR }), false, '关系不是情绪，永不过期');

  const parts = partitionRelations([mood, fact, { ...fact, id: 'rel_3', scope: 'identity' }], {
    at: t0 + 3 * HOUR,
  });
  assert.equal(parts.relations.length, 1);
  assert.equal(parts.freshEmotions.length, 0);
  assert.equal(parts.staleEmotions.length, 1);
  assert.equal(parts.relations[0].id, 'rel_2', 'identity 行默认不参与渲染');
});

test('过期情绪不进 head，改在 tail 以「上次情绪」出现（整链验证）', async () => {
  const { relation, memory, close } = await svc();
  try {
    const t0 = Date.now();
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王' });
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: 'mood', value: '有点烦', kind: 'emotion' });

    const fresh = memory.renderHead({ sessionId: SESSION, now: t0 });
    assert.ok(fresh.text.includes('【情绪】'));

    const later = t0 + 3 * HOUR;
    const stale = memory.renderHead({ sessionId: SESSION, now: later });
    assert.ok(!stale.text.includes('【情绪】'), '过期情绪不能留在字节稳定的头部');
    assert.ok(stale.text.includes('10001·称呼：老王'), '关系照旧');

    const tail = memory.renderTail({ sessionId: SESSION, now: later });
    assert.ok(tail.text.includes('【上次情绪】'));
    assert.equal(tail.counts.staleEmotions, 1);
  } finally {
    close();
  }
});

test('forget 连版本链一起删（只删当前值等于假装忘了）', async () => {
  const { relation, store, close } = await svc();
  try {
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王', changedAt: 1000 });
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '王哥', changedAt: 2000 });
    const chain = relation.history({ sessionId: SESSION, subjectId: '10001', key: '称呼' });
    assert.equal(chain.rows.length, 2);

    const out = relation.forget({ sessionId: SESSION, subjectId: '10001', key: '称呼' });
    assert.equal(out.removed, true);
    assert.equal(out.historyRemoved, 2);
    assert.equal(relation.get({ sessionId: SESSION, subjectId: '10001', key: '称呼' }), null);
    assert.equal(store.relation.count({ sessionId: SESSION }), 0);
    assert.equal(store.relation.history({ relationId: chain.relation.id }).rows.length, 0, '历史必须一起消失');

    // 不存在的目标：如实返回 false，不假装成功
    assert.deepEqual(relation.forget({ sessionId: SESSION, subjectId: 'nobody', key: '称呼' }), {
      removed: false,
      historyRemoved: 0,
    });
  } finally {
    close();
  }
});

test('JSON 兜底后端语义一致：同值不写历史、变更留链', async () => {
  const { relation, store, close } = await svc({ backend: 'json' });
  try {
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王', changedAt: 1000 });
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王', changedAt: 2000 });
    relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '王哥', changedAt: 3000 });
    const chain = relation.history({ sessionId: SESSION, subjectId: '10001', key: '称呼' });
    assert.deepEqual(
      chain.rows.map((row) => row.value),
      ['老王', '王哥'],
    );
    assert.equal(store.stats().relation, 1);
  } finally {
    close();
  }
});
