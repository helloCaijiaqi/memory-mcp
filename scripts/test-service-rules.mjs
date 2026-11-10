// 记忆服务规则的单测：幂等 ingest、滑动 TTL、分档衰减、固化判据。
// 全部在临时目录里开库，不碰生产 state。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { anchorId, openStore, platformOf } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';
import { DEFAULT_FORGETTING, lambdaFor, memoryScore, shouldConsolidate, touchedDays } from '../src/service/forgetting.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-rules-'));
const SESSION = 'qq:group:10086';
const WX_SESSION = 'wx:room:10086';
const DAY_MS = 24 * 60 * 60 * 1000;

async function svc(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const service = createMemoryService({ store, config: overrides });
  return { service, store, dir, close: () => store.close() };
}

test('ingest 幂等：同一条消息重复投递只落一条原文，锚点不变（raw-only）', async () => {
  const { service, store, close } = await svc();
  try {
    const first = service.ingest({
      sessionId: SESSION,
      msgId: '9001',
      senderId: '10001',
      text: '今天在聊语音发送',
    });
    assert.equal(first.created.raw, true);
    assert.equal(first.created.memory, false, '短期层已删除：聊天消息不进 memory 表');
    assert.equal(first.memory, null);
    assert.equal(first.anchor, anchorId(SESSION, '9001'));
    assert.equal(first.raw.platform, 'qq');

    const replay = service.ingest({
      sessionId: SESSION,
      msgId: '9001',
      senderId: '10001',
      text: '重放时被改写的正文',
    });
    assert.equal(replay.created.raw, false, '重复投递不应新建原文');
    assert.equal(replay.anchor, first.anchor, '锚点必须稳定，否则摘要里的引用会断');
    assert.equal(replay.raw.text, '今天在聊语音发送', '原文只追加不覆盖');

    assert.equal(store.raw.count({ sessionId: SESSION }), 1);
    assert.equal(store.memory.count({ sessionId: SESSION }), 0, 'memory 表不再因聊天增长');
    assert.equal(platformOf(SESSION), 'qq');
  } finally {
    close();
  }
});

test('ingest 跨进程重开仍然幂等（幂等键在数据形状里，不在内存里）', async () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'restart-'));
  const first = await openStore({ dir, backend: 'sqlite' });
  createMemoryService({ store: first }).ingest({ sessionId: SESSION, msgId: '777', senderId: 'u', text: '重启前' });
  first.close();

  const second = await openStore({ dir, backend: 'sqlite' });
  try {
    const service = createMemoryService({ store: second });
    const replay = service.ingest({ sessionId: SESSION, msgId: '777', senderId: 'u', text: '重启后' });
    assert.equal(replay.created.raw, false);
    assert.equal(second.stats().raw, 1, '原始层不应出现第二条');
    assert.equal(second.stats().memory, 0, '短期层不再出现任何行');
  } finally {
    second.close();
  }
});

test('ingest 空正文只进原始层（图片/撤回/系统事件不该变成空记忆）', async () => {
  const { service, store, close } = await svc();
  try {
    const out = service.ingest({ sessionId: SESSION, msgId: '2', senderId: 'u1', text: '   ', kind: 'image' });
    assert.equal(out.memory, null);
    assert.equal(out.created.memory, false);
    assert.ok(out.raw.id, '原始层仍要留一条（含 meta 与锚点）');
    assert.equal(store.memory.count({ sessionId: SESSION }), 0);
  } finally {
    close();
  }
});

test('ingest 平台隔离：qq 与 wx 同 scope:id 各自一条，互不可见', async () => {
  const { service, store, close } = await svc();
  try {
    const a = service.ingest({ sessionId: SESSION, msgId: '1', senderId: 'u1', text: 'QQ 群里的话' });
    const b = service.ingest({ sessionId: WX_SESSION, msgId: '1', senderId: 'u1', text: '微信群里的话' });
    assert.notEqual(a.raw.id, b.raw.id);
    assert.equal(a.memory, null, 'raw-only：memory 字段恒为 null，平台隔离只看原文层');
    assert.notEqual(a.anchor, b.anchor, '锚点按会话+消息派生，不能跨平台撞车');
    assert.equal(store.raw.count({ platform: 'qq' }), 1);
    assert.equal(store.raw.count({ platform: 'wx' }), 1);
    assert.equal(store.raw.count({ sessionId: SESSION, text: 'QQ 群里的话' }), 1, '原文按会话隔离');
  } finally {
    close();
  }
});

test('重放不会改写已落库的原文（raw-only：正文以首见为准）', async () => {
  const { store, service, close } = await svc();
  try {
    const first = service.ingest({ sessionId: SESSION, msgId: '5', senderId: 'u1', text: '反复被提起的话题' });
    assert.equal(first.created.raw, true);

    // 重放同一条消息、正文还变了：原文层的正文不能被覆盖（适配器重试时渲染可能不同）。
    const replay = service.ingest({ sessionId: SESSION, msgId: '5', senderId: 'u1', text: '渲染变了的正文' });
    assert.equal(replay.created.raw, false, '重放不新增原文行');
    assert.equal(replay.raw.text, '反复被提起的话题', '已在库的正文不因重放而改写');
    assert.equal(replay.memory, null, '短期层已删除，重放不再触碰 memory 表');
    assert.equal(store.memory.count({ sessionId: SESSION }), 0);
  } finally {
    close();
  }
});

test('ingest 的事务边界：活跃触点失败时原文也不留下', async () => {
  const { service, store, close } = await svc();
  try {
    const originalTouch = store.sessionState.touchActivity;
    store.sessionState.touchActivity = () => {
      throw new Error('模拟第二写失败');
    };
    assert.throws(
      () => service.ingest({ sessionId: SESSION, msgId: '66', senderId: 'u1', text: '这条不该留下' }),
      /模拟第二写失败/,
    );
    store.sessionState.touchActivity = originalTouch;
    assert.equal(
      store.raw.count({ sessionId: SESSION }),
      0,
      '原始层必须跟着回滚，否则会出现「有原文、无纪元触点」的半条',
    );
    assert.equal(store.sessionState.count(), 0);

    // 回滚之后重放应当正常落库（幂等没有留下「幽灵记录」把重试挡掉）。
    const retry = service.ingest({ sessionId: SESSION, msgId: '66', senderId: 'u1', text: '这条不该留下' });
    assert.equal(retry.created.raw, true);
    assert.ok(store.sessionState.get(SESSION), '重试后活跃触点正常落库');
  } finally {
    close();
  }
});

test('append 带 msgId 时也是幂等的（不经过 ingest 的调用方同样安全）', async () => {
  const { service, store, close } = await svc();
  try {
    const a = service.append({ sessionId: SESSION, msgId: 'abc', tier: 'short', content: '第一次写入' });
    const b = service.append({ sessionId: SESSION, msgId: 'abc', tier: 'short', content: '第二次写入' });
    assert.equal(a.id, b.id);
    assert.equal(b.content, '第一次写入', '同一条消息重复 append 不应改写内容');
    assert.deepEqual(b.sourceMsgIds, ['abc']);
    assert.equal(store.memory.count({ sessionId: SESSION }), 1);
  } finally {
    close();
  }
});

test('滑动 TTL：短期记忆每次被触及都把到期时间往后推，长期不设 TTL', async () => {
  const { service, close } = await svc({ shortTtlMs: 60_000 });
  try {
    const row = service.append({ sessionId: SESSION, tier: 'short', content: '还在聊的话题' });
    assert.ok(row.expiresAt >= row.createdAt + 60_000 - 1_000, '短期记忆应带 TTL');
    const firstExpiry = row.expiresAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const touched = service.touch({ id: row.id });
    assert.ok(touched.expiresAt > firstExpiry, '触及后到期时间必须往后推');
    assert.equal(touched.hits, 1);

    const long = service.append({ sessionId: SESSION, tier: 'long', content: '长期事实' });
    assert.equal(service.touch({ id: long.id }).expiresAt, null, '长期记忆不该被触及塞回 TTL');
  } finally {
    close();
  }
});

test('分档衰减：关系豁免、情绪快衰、普通按默认 λ', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const base = { baseWeight: 1, hits: 0, importance: 0, createdAt: t0, lastTouchAt: t0 };
  const now = t0 + 10 * DAY_MS;
  const plain = memoryScore({ ...base, kind: 'episodic', decayExempt: false }, { now });
  const exempt = memoryScore({ ...base, kind: 'relation', decayExempt: true }, { now });
  const mood = memoryScore({ ...base, kind: 'emotion', decayExempt: false }, { now });

  assert.equal(exempt, 1, '豁免行不该随时间掉分');
  assert.ok(plain < 1, `普通记忆 10 天后应衰减：${plain}`);
  assert.ok(mood < plain, `情绪应比普通记忆掉得快：${mood} vs ${plain}`);

  assert.equal(lambdaFor({ decayExempt: true }), 0);
  assert.equal(lambdaFor({ kind: 'emotion' }), DEFAULT_FORGETTING.emotionLambdaPerDay);
  assert.equal(lambdaFor({ kind: 'episodic' }), DEFAULT_FORGETTING.lambdaPerDay);
});

test('关系行默认豁免衰减、情绪行默认衰减（缺省值由行归一化统一给出）', async () => {
  const { store, close } = await svc();
  try {
    const relation = store.memory.put({ sessionId: SESSION, tier: 'long', kind: 'relation', content: '老王讨厌被叫全名' });
    const mood = store.memory.put({ sessionId: SESSION, tier: 'short', kind: 'emotion', content: '现在有点烦' });
    const plain = store.memory.put({ sessionId: SESSION, tier: 'short', content: '普通话题' });
    assert.equal(relation.decayExempt, true);
    assert.equal(mood.decayExempt, false);
    assert.equal(plain.decayExempt, false);
  } finally {
    close();
  }
});

test('固化判据：hits / importance / 跨天触及 / 显式，四条独立成立', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const mk = (extra) => ({ tier: 'short', hits: 0, importance: 0, createdAt: t0, lastTouchAt: t0, ...extra });

  assert.equal(shouldConsolidate(mk({ hits: 3 })), true, '命中 3 次即固化');
  assert.equal(shouldConsolidate(mk({ hits: 2 })), false);
  assert.equal(shouldConsolidate(mk({ importance: 7 })), true, '重要度 7 即固化');
  assert.equal(shouldConsolidate(mk({ importance: 6 })), false);
  assert.equal(touchedDays({ createdAt: t0, lastTouchAt: t0 + DAY_MS }), 2);
  assert.equal(shouldConsolidate(mk({ lastTouchAt: t0 + DAY_MS })), true, '跨天被触及即固化');
  assert.equal(shouldConsolidate(mk({ lastTouchAt: t0 + DAY_MS / 2 })), false, '同一天多次触及不算跨天');
  assert.equal(shouldConsolidate(mk({ hits: 99, tier: 'long' })), false, '长期记忆无需再固化');
  assert.equal(shouldConsolidate(mk({}), { explicit: true }), true, '显式要求直接固化');
});

test('跨天触及不再自动升级（长期只由 record/摘要产生）；手动 consolidate 仍可用', async () => {
  const { service, close } = await svc();
  try {
    const row = service.append({
      sessionId: SESSION,
      tier: 'short',
      content: '昨天聊过、今天又聊到',
      createdAt: Date.now() - DAY_MS,
    });
    const touched = service.touch({ id: row.id });
    assert.equal(touched.tier, 'short', '命中只抬权重与续期，不自动升级');
    const promoted = service.consolidate({ id: row.id });
    assert.equal(promoted.tier, 'long', '手动巩固仍可把存量短期行升级');
  } finally {
    close();
  }
});

test('JSON 兜底后端同样满足幂等 ingest（两后端语义一致）', async () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'json-'));
  const store = await openStore({ dir, backend: 'json' });
  try {
    const service = createMemoryService({ store });
    const first = service.ingest({ sessionId: SESSION, msgId: 'j1', senderId: 'u1', text: '兜底后端也要幂等' });
    const replay = service.ingest({ sessionId: SESSION, msgId: 'j1', senderId: 'u1', text: '重放' });
    assert.equal(first.created.raw, true);
    assert.equal(first.created.memory, false, 'raw-only：短期层不再写入');
    assert.equal(replay.created.raw, false);
    assert.equal(store.stats().raw, 1);
    assert.equal(store.stats().memory, 0);
    assert.equal(store.stats().sessionState, 1, '活跃触点同样落库');
  } finally {
    store.close();
  }
});

test('consolidate(force) 不看判据：显式要求长期记住就升级', async () => {
  const { service, close } = await svc();
  try {
    const row = service.append({ sessionId: SESSION, tier: 'short', content: '不要忘' });
    const promoted = service.consolidate({ sessionId: SESSION, force: true });
    assert.equal(promoted.length, 1);
    assert.equal(service.get(row.id).tier, 'long');
  } finally {
    close();
  }
});
