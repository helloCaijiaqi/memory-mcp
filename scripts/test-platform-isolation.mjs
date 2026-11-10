// 平台隔离的单元测试：platform 只有一个来源（sessionId）、四个存储层各自隔离、
// 关系默认不跨平台、identity 作用域默认被拒、召回默认不跨平台。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore, platformOf } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';
import { RelationScopeError, createRelationService } from '../src/service/relation-service.js';
import { UnknownPlatformError, createPlatformPolicy } from '../src/service/platform-policy.js';
import { createFts5Backend, createRecallRouter } from '../src/service/recall.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-platform-'));
const QQ = 'qq:group:50001';
const WX = 'wx:room:50001'; // scope:id 与 QQ 完全相同，只有平台不同
const QQ_SAME = 'qq:private:50001';

async function fixture(relationConfig = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  return {
    store,
    memory: createMemoryService({ store }),
    relation: createRelationService({ store, config: relationConfig }),
    recall: createRecallRouter({ store, backends: [createFts5Backend({ store })], config: {} }),
    close: () => store.close(),
  };
}

test('platform 只由 sessionId 派生：传入的 platform 一律被忽略', async () => {
  const { store, memory, close } = await fixture();
  try {
    const row = memory.append({ sessionId: QQ, tier: 'long', content: '群里说过的话', platform: 'wx' });
    assert.equal(row.platform, 'qq', '两处来源会漂移，所以 API 不接受独立 platform 入参');
    assert.equal(platformOf(QQ), 'qq');
    assert.equal(store.memory.get(row.id).platform, 'qq');
  } finally {
    close();
  }
});

test('同 scope:id 不同平台：记忆与原文层互不可见', async () => {
  const { store, memory, close } = await fixture();
  try {
    memory.append({ sessionId: QQ, tier: 'long', content: 'QQ 群里的秘密' });
    memory.append({ sessionId: WX, tier: 'long', content: '微信里的秘密' });
    memory.ingest({ sessionId: QQ, msgId: 'p1', text: 'QQ 原文' });
    memory.ingest({ sessionId: WX, msgId: 'p1', text: '微信原文' });

    // raw-only：ingest 不再写 memory 表，记忆层只有显式 append 的行。
    assert.equal(store.memory.count({ sessionId: QQ }), 1);
    assert.equal(store.memory.count({ sessionId: WX }), 1);
    assert.equal(store.memory.count({ platform: 'qq' }), 1);
    assert.equal(store.memory.count({ platform: 'wx' }), 1);

    const qqRows = memory.query({ sessionId: QQ, limit: 10 }).rows;
    assert.ok(qqRows.every((row) => row.platform === 'qq'));
    assert.ok(qqRows.every((row) => row.sessionId === QQ));

    // 同一平台上不同会话也不串：召回与注入都以 sessionId 收窄。
    assert.equal(store.memory.count({ sessionId: QQ_SAME }), 0);
    const raw = store.raw.query({ sessionId: WX, text: '原文' });
    assert.equal(raw.rows.length, 1);
    assert.equal(raw.rows[0].sessionId, WX);
    assert.equal(raw.rows[0].platform, 'wx');
  } finally {
    close();
  }
});

test('关系按平台隔离：同一个人、同一个键，在两个平台各存一份', async () => {
  const { store, relation, close } = await fixture();
  try {
    relation.upsert({ sessionId: QQ, subjectId: '10001', key: '称呼', value: '老王' });
    relation.upsert({ sessionId: WX, subjectId: '10001', key: '称呼', value: '王老师' });

    assert.equal(relation.get({ sessionId: QQ, subjectId: '10001', key: '称呼' }).value, '老王');
    assert.equal(relation.get({ sessionId: WX, subjectId: '10001', key: '称呼' }).value, '王老师');

    assert.equal(store.relation.count({ platform: 'qq' }), 1);
    assert.equal(store.relation.count({ platform: 'wx' }), 1);
    const qqOnly = store.relation.list({ platform: 'qq' }).rows;
    assert.equal(qqOnly.length, 1);
    assert.equal(qqOnly[0].value, '老王');

    // 版本链上也带平台：跨平台排查时能说清「这条是哪边的变化」。
    const history = relation.history({ sessionId: WX, subjectId: '10001', key: '称呼' });
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].platform, 'wx');
  } finally {
    close();
  }
});

test('head 只渲染本平台的关系：同一 sessionId 尾段不会串台', async () => {
  const { relation, memory, close } = await fixture();
  try {
    relation.upsert({ sessionId: QQ, subjectId: '10001', key: '称呼', value: '老王' });
    relation.upsert({ sessionId: WX, subjectId: '10001', key: '称呼', value: '王老师' });

    const qqHead = memory.renderHead({ sessionId: QQ, force: true });
    assert.ok(qqHead.text.includes('老王'));
    assert.ok(!qqHead.text.includes('王老师'), `head 串台了：${qqHead.text}`);

    const wxHead = memory.renderHead({ sessionId: WX, force: true });
    assert.ok(wxHead.text.includes('王老师'));
    assert.ok(!wxHead.text.includes('老王'));
  } finally {
    close();
  }
});

test('跨平台关系（scope=identity）默认被拒，开启后才允许写入', async () => {
  const { relation, close } = await fixture();
  try {
    assert.throws(
      () => relation.upsert({ sessionId: QQ, subjectId: '10001', key: '称呼', value: '老王', scope: 'identity' }),
      (error) => error instanceof RelationScopeError,
      '默认按会话隔离：跨平台共享是产品决策，必须显式开启',
    );
  } finally {
    close();
  }

  const enabled = await fixture({ identityEnabled: true });
  try {
    const out = enabled.relation.upsert({
      sessionId: QQ,
      subjectId: '10001',
      key: '称呼',
      value: '老王',
      scope: 'identity',
    });
    assert.equal(out.row.scope, 'identity');
    // 写入仍然落在具体会话上（platform 随 sessionId 派生），共享是查询层的事。
    assert.equal(out.row.platform, 'qq');
  } finally {
    enabled.close();
  }
});

test('召回默认不跨平台；关系与原文的隔离也由同一套规则兜住', async () => {
  const { memory, recall, close } = await fixture();
  try {
    memory.append({ sessionId: QQ, tier: 'long', content: '周末去爬山' });
    memory.append({ sessionId: WX, tier: 'long', content: '周末去爬山' });
    memory.ingest({ sessionId: WX, msgId: 'r1', text: '微信里说的爬山计划' });

    const local = recall.recall({ sessionId: QQ, text: '爬山' });
    assert.equal(local.scope, 'platform');
    assert.ok(local.rows.every((row) => row.platform === 'qq'));

    const denied = recall.recall({ sessionId: QQ, text: '爬山', platforms: ['wx'] });
    assert.equal(denied.downgraded, true);
    assert.deepEqual(denied.platforms, ['qq']);
    assert.ok(denied.rows.every((row) => row.platform === 'qq'));
  } finally {
    close();
  }
});

test('平台白名单：默认放行未知平台并只告警一次，strict 下拒绝写入', async () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  try {
    const warnings = [];
    const loose = createPlatformPolicy({ known: ['qq'], strict: false, logger: (msg) => warnings.push(msg) });
    const memory = createMemoryService({ store, platformPolicy: loose });
    memory.append({ sessionId: WX, content: '微信也能写' });
    memory.append({ sessionId: WX, content: '第二条不该重复告警' });
    assert.equal(warnings.length, 1, `未知平台每进程只该告警一次：${warnings.join('|')}`);
    assert.ok(warnings[0].includes('unknown platform: wx'));

    const strict = createPlatformPolicy({ known: ['qq'], strict: true, logger: () => {} });
    const strictMemory = createMemoryService({ store, platformPolicy: strict });
    assert.throws(
      () => strictMemory.append({ sessionId: WX, content: '应该被拒' }),
      (error) => error instanceof UnknownPlatformError,
    );
    assert.throws(() => strictMemory.ingest({ sessionId: WX, msgId: 'x1', text: '也不该落库' }));
    strictMemory.append({ sessionId: QQ, content: 'qq 在白名单里，照常写' });

    // 关系写入走同一道闸门：否则「记忆拒了、关系还在悄悄存」。
    assert.throws(
      () =>
        createRelationService({ store, platformPolicy: strict }).upsert({
          sessionId: WX,
          subjectId: '10001',
          key: '称呼',
          value: '王老师',
        }),
      (error) => error instanceof UnknownPlatformError,
    );

    const both = createPlatformPolicy({ known: ['qq', 'wx'], strict: true });
    assert.equal(both.check(WX), 'wx');
  } finally {
    store.close();
  }
});

test('platformStats：按平台统计四类行，运维能看出库里有几路数据', async () => {
  const { store, memory, relation, close } = await fixture();
  try {
    memory.append({ sessionId: QQ, tier: 'long', content: 'QQ 的一条' });
    memory.ingest({ sessionId: WX, msgId: 's1', text: '微信的一条' });
    relation.upsert({ sessionId: QQ, subjectId: '10001', key: '称呼', value: '老王' });
    memory.renderHead({ sessionId: QQ, force: true });

    const stats = store.platformStats();
    const qq = stats.find((item) => item.platform === 'qq');
    const wx = stats.find((item) => item.platform === 'wx');
    assert.ok(qq && wx, `应有两个平台的统计，实际：${JSON.stringify(stats)}`);
    assert.equal(qq.memory, 1);
    assert.equal(qq.relation, 1);
    assert.equal(qq.snapshot, 1);
    assert.equal(wx.memory, 0, 'raw-only：ingest 不再产生 memory 行');
    assert.equal(wx.raw, 1);
    assert.equal(wx.relation, 0);
  } finally {
    close();
  }
});
