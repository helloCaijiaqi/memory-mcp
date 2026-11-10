// head/tail 分区的单测：稳定排序、条数截断、revision 与断点重建、尾部动态区。
// 核心断言只有一句：同一断点内两次构建的 head 必须逐字节相同。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StoreReadOnlyError, openStore } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';
import { buildHead, headDecision, revisionOf, shouldRebuildHead } from '../src/service/head-builder.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-head-'));
const SESSION = 'qq:group:20001';
const WX_SESSION = 'wx:room:20001';
const MIN = 60 * 1000;

async function svc(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const service = createMemoryService({ store, config: overrides });
  return { service, store, close: () => store.close() };
}

test('断点判定：force / 冷启动 / 静默超时 / 窗口内冻结', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(shouldRebuildHead({ force: true }), true);
  assert.equal(shouldRebuildHead({ snapshot: null }), true);
  assert.equal(
    shouldRebuildHead({ snapshot: { lastActivityAt: now }, now, quietWindowMs: 30 * MIN }),
    false,
  );
  assert.equal(
    shouldRebuildHead({ snapshot: { lastActivityAt: now - 60 * MIN }, now, quietWindowMs: 30 * MIN }),
    true,
  );
  assert.equal(headDecision({ force: true }).reason, 'forced');
  assert.equal(headDecision({ snapshot: null }).reason, 'cold');
  assert.equal(headDecision({ snapshot: { lastActivityAt: now }, now }).reason, 'frozen');
  assert.equal(headDecision({ snapshot: { lastActivityAt: now - 60 * MIN }, now }).reason, 'quiet');
});

test('冷启动构建 head，随后的调用原样复用快照（零记忆查询的热路径）', async () => {
  const { service, store, close } = await svc();
  try {
    service.append({ sessionId: SESSION, tier: 'long', content: '用户讨厌被敷衍', category: '画像' });
    const first = service.renderHead({ sessionId: SESSION });
    assert.equal(first.rebuilt, true);
    assert.equal(first.reason, 'cold');
    assert.ok(first.text.includes('【长期记忆】'));
    assert.ok(first.text.includes('- 画像：用户讨厌被敷衍'));

    const second = service.renderHead({ sessionId: SESSION });
    assert.equal(second.rebuilt, false);
    assert.equal(second.reason, 'frozen');
    assert.equal(second.text, first.text, '同一断点内 head 必须逐字节相同');
    assert.equal(second.revision, first.revision);
    assert.equal(second.revision, revisionOf(first.text));

    const snapshot = store.snapshot.get(SESSION);
    assert.equal(snapshot.revision, first.revision, '快照里存的必须是这个版本');
    assert.equal(snapshot.platform, 'qq');
  } finally {
    close();
  }
});

test('到了断点但内容没变时不重发（revision 相同 → rebuilt=false）', async () => {
  const { service, close } = await svc();
  try {
    service.append({ sessionId: SESSION, tier: 'long', content: '事实一' });
    const first = service.renderHead({ sessionId: SESSION });
    const again = service.renderHead({ sessionId: SESSION, force: true });
    assert.equal(again.rebuilt, false);
    assert.equal(again.reason, 'unchanged');
    assert.equal(again.text, first.text);

    service.append({ sessionId: SESSION, tier: 'long', content: '事实二' });
    const changed = service.renderHead({ sessionId: SESSION, force: true });
    assert.equal(changed.rebuilt, true);
    assert.ok(changed.text.includes('事实二'));
    assert.notEqual(changed.revision, first.revision);
  } finally {
    close();
  }
});

test('静默窗内不重建：新长期记忆在断点前不进 head，断了才进', async () => {
  const { service, close } = await svc({ head: { quietWindowMs: 30 * MIN } });
  try {
    const t0 = Date.now();
    service.append({ sessionId: SESSION, tier: 'long', content: '旧事实' });
    const a = service.renderHead({ sessionId: SESSION, now: t0 });

    service.append({ sessionId: SESSION, tier: 'long', content: '断点前新增的事实' });
    const b = service.renderHead({ sessionId: SESSION, now: t0 + MIN });
    assert.equal(b.text, a.text, '会话还在继续，head 不能动');
    assert.equal(b.reason, 'frozen');

    const c = service.renderHead({ sessionId: SESSION, now: t0 + 31 * MIN });
    assert.equal(c.rebuilt, true);
    assert.equal(c.reason, 'quiet');
    assert.ok(c.text.includes('断点前新增的事实'), '断点后批量重建，新事实才进稳定区');
  } finally {
    close();
  }
});

test('条数截断：长期记忆只保留最近 maxLong 条，且显式标注被截断', async () => {
  const { service, close } = await svc({ head: { maxLong: 2 } });
  try {
    const t0 = Date.now() - 10 * MIN;
    service.append({ sessionId: SESSION, tier: 'long', content: '最早', createdAt: t0 });
    service.append({ sessionId: SESSION, tier: 'long', content: '第二早', createdAt: t0 + MIN });
    service.append({ sessionId: SESSION, tier: 'long', content: '第二新', createdAt: t0 + 2 * MIN });
    service.append({ sessionId: SESSION, tier: 'long', content: '最新', createdAt: t0 + 3 * MIN });

    const head = service.renderHead({ sessionId: SESSION });
    assert.equal(head.truncated.long, true);
    assert.ok(head.text.includes('最新'));
    assert.ok(head.text.includes('第二新'));
    assert.ok(!head.text.includes('最早'), '超出上限的旧条目不该占稳定区预算');
    assert.equal(head.text.split('\n').length, 3, '两行记忆 + 一行标题');
  } finally {
    close();
  }
});

test('稳定排序：写入顺序打乱，head 里的顺序仍按建立时间固定', async () => {
  const { service, close } = await svc();
  try {
    const t0 = Date.now() - 10 * MIN;
    service.append({ sessionId: SESSION, tier: 'long', content: 'B', category: '画像', createdAt: t0 + MIN });
    service.append({ sessionId: SESSION, tier: 'long', content: 'A', category: '画像', createdAt: t0 });
    service.append({ sessionId: SESSION, tier: 'long', content: 'C', category: '画像', createdAt: t0 + 2 * MIN });
    const head = service.renderHead({ sessionId: SESSION });
    const idxA = head.text.indexOf('：A');
    const idxB = head.text.indexOf('：B');
    const idxC = head.text.indexOf('：C');
    assert.ok(idxA < idxB && idxB < idxC, `应按建立时间升序：${head.text}`);
    assert.ok(head.text.startsWith('【长期记忆】\n- 画像：A'));
  } finally {
    close();
  }
});

test('buildHead 是纯函数：同样输入产出同样字节，与 now/score 无关', () => {
  const rows = [
    { id: 'mem_2', createdAt: 2, category: '', content: '第二条' },
    { id: 'mem_1', createdAt: 1, category: '画像', content: '第一条' },
  ];
  const a = buildHead({ longRows: rows, config: { maxLong: 5 } });
  const b = buildHead({ longRows: [...rows].reverse(), config: { maxLong: 5 } });
  assert.equal(a.text, b.text);
  assert.equal(a.revision, b.revision);
  assert.ok(a.text.indexOf('第一条') < a.text.indexOf('第二条'));
});

test('head 不含短期记忆；没有内容时产出空串与固定的 revision', async () => {
  const { service, close } = await svc();
  try {
    service.append({ sessionId: SESSION, tier: 'short', content: '刚说的这句话' });
    const head = service.renderHead({ sessionId: SESSION });
    assert.equal(head.text, '');
    assert.equal(head.revision, revisionOf(''));

    const tail = service.renderTail({ sessionId: SESSION });
    assert.ok(tail.text.includes('刚说的这句话'), '短期记忆应该走尾部');
  } finally {
    close();
  }
});

test('tail：当前时间 + 短期记忆正序 + 召回 + 本轮正文', async () => {
  const { service, close } = await svc();
  try {
    const t0 = Date.now() - 5 * MIN;
    service.append({ sessionId: SESSION, tier: 'short', content: '先说的事', createdAt: t0 });
    service.append({ sessionId: SESSION, tier: 'short', content: '后说的事', createdAt: t0 + MIN });

    const tail = service.renderTail({
      sessionId: SESSION,
      body: '用户：今天继续聊那个',
      recall: '- 上周提过语音发送',
      now: t0 + 10 * MIN,
    });
    assert.ok(tail.text.startsWith('【当前时间】'));
    assert.ok(tail.text.includes('【短期记忆】'));
    assert.ok(tail.text.indexOf('先说的事') < tail.text.indexOf('后说的事'), '尾部按时间正序');
    assert.ok(tail.text.includes('【召回】'));
    assert.ok(tail.text.endsWith('用户：今天继续聊那个'));
    assert.equal(tail.counts.short, 2);
  } finally {
    close();
  }
});

test('尾部只保留最近 maxShortInTail 条短期记忆', async () => {
  const { service, close } = await svc({ head: { maxShortInTail: 2 } });
  try {
    const t0 = Date.now() - 10 * MIN;
    for (let i = 0; i < 5; i += 1) {
      service.append({ sessionId: SESSION, tier: 'short', content: `第 ${i} 句`, createdAt: t0 + i * MIN });
    }
    const tail = service.renderTail({ sessionId: SESSION });
    assert.ok(tail.text.includes('第 4 句'));
    assert.ok(tail.text.includes('第 3 句'));
    assert.ok(!tail.text.includes('第 0 句'));
    assert.equal(tail.counts.short, 2);
  } finally {
    close();
  }
});

test('新鲜情绪进 head；过期情绪移出稳定区，改在尾部以「上次情绪」出现', async () => {
  const { service, store, close } = await svc({ head: { emotionFreshMs: 2 * 60 * MIN } });
  try {
    store.relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王' });
    store.relation.upsert({ sessionId: SESSION, subjectId: '10001', key: 'mood', value: '有点烦', kind: 'emotion' });

    const t0 = Date.now();
    const fresh = service.renderHead({ sessionId: SESSION, now: t0 });
    assert.ok(fresh.text.includes('【关系】'));
    assert.ok(fresh.text.includes('10001·称呼：老王'));
    assert.ok(fresh.text.includes('【情绪】'));
    assert.ok(fresh.text.includes('有点烦'));

    const later = t0 + 3 * 60 * MIN;
    const stale = service.renderHead({ sessionId: SESSION, now: later });
    assert.ok(!stale.text.includes('【情绪】'), '过期情绪不该留在字节稳定的头部');
    assert.ok(stale.text.includes('【关系】'), '关系不随时间失效');

    const tail = service.renderTail({ sessionId: SESSION, now: later });
    assert.ok(tail.text.includes('【上次情绪】'));
    assert.ok(tail.text.includes('有点烦'));
    assert.equal(tail.counts.staleEmotions, 1);
  } finally {
    close();
  }
});

test('黑话按内容稳定排序进 head（不按 score，否则命中一次缓存就失效）', async () => {
  const { service, store, close } = await svc();
  try {
    store.slang.put({ content: 'yyds', meaning: '永远的神', status: 'confirmed', score: 1 });
    store.slang.put({ content: '绷不住了', meaning: '忍不住笑', status: 'confirmed', score: 99 });
    store.slang.put({ content: '待定的词', meaning: '不该出现', status: 'candidate', score: 100 });
    const head = service.renderHead({ sessionId: SESSION });
    assert.ok(head.text.includes('【黑话】'));
    assert.ok(head.text.includes('- 绷不住了：忍不住笑'));
    assert.ok(head.text.includes('- yyds：永远的神'));
    assert.ok(!head.text.includes('待定的词'), '未确认的黑话不进注入');
  } finally {
    close();
  }
});

test('compose 把稳定区与动态区拼成一个块，head 冻结、tail 跟随本轮', async () => {
  const { service, close } = await svc();
  try {
    service.append({ sessionId: SESSION, tier: 'long', content: '长期事实', category: '画像' });
    const first = service.compose({ sessionId: SESSION, body: '用户：第一句' });
    assert.ok(first.text.startsWith('【长期记忆】'));
    assert.ok(first.text.endsWith('用户：第一句'));

    const second = service.compose({ sessionId: SESSION, body: '用户：第二句' });
    assert.equal(second.head.text, first.head.text, 'head 必须保持不变');
    assert.equal(second.revision, first.revision);
    assert.ok(second.text.endsWith('用户：第二句'));
    assert.ok(!second.text.includes('用户：第一句'), '上一轮的正文不能残留在注入块里');
  } finally {
    close();
  }
});

test('平台隔离：head/tail 只读当前会话所在平台的记忆', async () => {
  const { service, close } = await svc();
  try {
    service.append({ sessionId: SESSION, tier: 'long', content: 'QQ 侧画像' });
    service.append({ sessionId: WX_SESSION, tier: 'long', content: '微信侧画像' });
    const qq = service.compose({ sessionId: SESSION, body: '' });
    assert.ok(qq.text.includes('QQ 侧画像'));
    assert.ok(!qq.text.includes('微信侧画像'));
    const wx = service.compose({ sessionId: WX_SESSION, body: '' });
    assert.ok(wx.text.includes('微信侧画像'));
  } finally {
    close();
  }
});

test('invalidateHead 让下一次渲染必然重建', async () => {
  const { service } = await svc();
  service.append({ sessionId: SESSION, tier: 'long', content: '事实' });
  const first = service.renderHead({ sessionId: SESSION });
  assert.equal(first.rebuilt, true);
  assert.equal(service.renderHead({ sessionId: SESSION }).reason, 'frozen');

  const removed = service.invalidateHead({ sessionId: SESSION });
  assert.equal(removed.removed, true);
  const again = service.renderHead({ sessionId: SESSION });
  assert.equal(again.rebuilt, true);
  assert.equal(again.reason, 'cold');
  assert.equal(again.text, first.text, '内容没变，重建后字节仍然一致');
});

test('只读兜底：快照写不进去也照样返回 head，但显式标注降级', async () => {
  const { service, store, close } = await svc();
  try {
    service.append({ sessionId: SESSION, tier: 'long', content: '只读也要能读' });
    const originalPut = store.snapshot.put;
    store.snapshot.put = () => {
      throw new StoreReadOnlyError('模拟只读');
    };
    const head = service.renderHead({ sessionId: SESSION });
    store.snapshot.put = originalPut;
    assert.ok(head.text.includes('只读也要能读'));
    assert.equal(head.rebuilt, true);
    assert.match(head.reason, /read-only$/);
    assert.equal(head.degraded, true);
  } finally {
    close();
  }
});

test('JSON 兜底后端同样能产出稳定的 head（无 FTS 也要字节一致）', async () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'json-'));
  const store = await openStore({ dir, backend: 'json' });
  try {
    const service = createMemoryService({ store });
    store.slang.put({ content: 'yyds', meaning: '永远的神', status: 'confirmed' });
    store.relation.upsert({ sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王' });
    service.ingest({ sessionId: SESSION, msgId: 'x1', senderId: '10001', text: '今天聊语音' });
    const a = service.renderHead({ sessionId: SESSION });
    const b = service.renderHead({ sessionId: SESSION });
    assert.equal(b.text, a.text);
    assert.ok(a.text.includes('【关系】'));
    assert.equal(a.degraded, true, '兜底后端必须如实标注 degraded');
  } finally {
    store.close();
  }
});
