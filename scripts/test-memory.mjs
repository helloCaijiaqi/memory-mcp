// 记忆引擎的离线单测：分层、巩固、遗忘四件套、段落渲染。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';
import { daysSince, memoryScore, shouldConsolidate } from '../src/service/forgetting.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-svc-'));
const SESSION = 'qq:group:10086';

async function svc(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const service = createMemoryService({ store, config: overrides });
  return { service, store, close: () => store.close() };
}

test('短期记忆带 TTL，长期记忆不带', async () => {
  const { service, close } = await svc();
  const short = service.append({ sessionId: SESSION, tier: 'short', content: '今天的话题' });
  const long = service.append({ sessionId: SESSION, tier: 'long', content: '这个人的画像' });
  assert.ok(short.expiresAt > Date.now(), '短期记忆应有到期时间');
  assert.equal(long.expiresAt, null, '长期记忆不应有到期时间');
  close();
});

test('过期记忆会被清理（遗忘手段之一：到期淘汰）', async () => {
  const { service, close } = await svc();
  service.append({ sessionId: SESSION, tier: 'short', content: '昨天的话题', expiresAt: Date.now() - 1 });
  service.append({ sessionId: SESSION, tier: 'short', content: '今天的话题' });
  service.append({ sessionId: SESSION, tier: 'short', content: '再触发一次 prune' });
  const { rows } = service.query({ sessionId: SESSION });
  assert.equal(rows.length, 2, '过期记忆不应再被查到');
  close();
});

test('容量超出时按最低权重淘汰（遗忘手段之二）', async () => {
  // prune 节流后（每 20 次写或 60s 才执行），淘汰动作由 forcePrune 显式触发；
  // 本用例验证的是「按分数淘汰到上限」的语义，不关心触发时机。
  const { service, close } = await svc({ maxShort: 3 });
  for (let i = 0; i < 6; i += 1) {
    service.append({ sessionId: SESSION, tier: 'short', content: `话题 ${i}` });
  }
  service.forcePrune(SESSION, 'short');
  assert.equal(service.stats().memory, 3, '超出上限应淘汰到只剩 3 条');
  close();
});

test('时间衰减：越久没触及，分数越低（遗忘手段之三的前提）', () => {
  const base = { baseWeight: 1, hits: 0, importance: 0 };
  const t0 = Date.UTC(2026, 0, 1);
  const fresh = memoryScore({ ...base, lastTouchAt: t0 }, { now: t0 });
  const old = memoryScore({ ...base, lastTouchAt: t0 }, { now: t0 + 10 * 86400000 });
  assert.ok(fresh > old, `10 天后分数应更低：${fresh} vs ${old}`);
  assert.ok(daysSince(t0, t0 + 2 * 86400000) === 2);
});

test('命中会抬权重并滑动续期；自动巩固已随短期层移除（手动 consolidate 仍可用）', async () => {
  const { service, close } = await svc();
  const row = service.append({ sessionId: SESSION, tier: 'short', content: '反复被提起的话题' });
  const after1 = service.touch({ id: row.id });
  assert.equal(after1.hits, 1);
  assert.equal(after1.tier, 'short');
  assert.ok(after1.expiresAt > row.expiresAt, '命中应把 TTL 往后推');
  service.touch({ id: row.id });
  const after3 = service.touch({ id: row.id });
  assert.equal(after3.tier, 'short', '命中不再自动升级（长期只由 record/摘要产生）');
  const manual = service.consolidate({ id: row.id });
  assert.equal(manual.tier, 'long', '手动巩固仍可把存量短期行升级为长期');
  assert.equal(manual.expiresAt, null, '升级后不应再带 TTL');
  close();
});

test('软遗忘：不进提示词，但可恢复；硬删除：物理消失', async () => {
  const { service, close } = await svc();
  const row = service.append({ sessionId: SESSION, tier: 'long', content: '先记住再说' });
  service.forget({ id: row.id, mode: 'soft' });
  assert.equal(service.query({ sessionId: SESSION }).rows.length, 0, '归档后默认查不到');
  assert.equal(service.query({ sessionId: SESSION, includeArchived: true }).rows.length, 1, '但仍在库里');
  assert.equal(service.render({ sessionId: SESSION }).blocks.length, 0, '归档后不注入提示词');
  service.restore({ id: row.id });
  assert.equal(service.query({ sessionId: SESSION }).rows.length, 1, '恢复后重新可见');

  const victim = service.append({ sessionId: SESSION, tier: 'long', content: '需要被彻底忘掉' });
  service.forget({ id: victim.id, mode: 'hard' });
  assert.equal(service.get(victim.id), null, '硬删除后彻底消失');
  close();
});

test('遗忘归属校验：跨会话删除被拒，本会话仍可删', async () => {
  const { service, close } = await svc();
  const row = service.append({ sessionId: SESSION, tier: 'long', content: '别人的记忆' });
  assert.throws(
    () => service.forget({ id: row.id, sessionId: 'qq:group:other' }),
    /不属于当前会话/,
    '知道 id 也不能删别的会话',
  );
  assert.ok(service.get(row.id), '拒绝后数据必须仍在');
  service.forget({ id: row.id, sessionId: SESSION, mode: 'hard' });
  assert.equal(service.get(row.id), null);
  close();
});

test('render 产出多 block（epoch + identity/long），subject 相关优先、超限截断', async () => {
  const { service, close } = await svc();
  service.append({ sessionId: SESSION, tier: 'long', content: '长期：用户讨厌被敷衍', category: '画像', subjectId: 'u_1' });
  service.append({ sessionId: SESSION, tier: 'long', content: '长期：群里的公共约定', subjectId: '' });
  service.append({ sessionId: SESSION, tier: 'short', content: '短期：正在聊语音发送', category: '话题' });
  const out = service.render({ sessionId: SESSION, subjectId: 'u_1' });
  assert.ok(Number.isInteger(out.epoch) && out.epoch >= 1, 'render 必须返回会话纪元');
  // 短期层已删除：不再渲染短期行。
  const longBlock = out.blocks.find((block) => block.kind === 'long');
  assert.ok(longBlock, '应产出【长期记忆】块');
  assert.equal(longBlock.name, '长期记忆');
  assert.ok(longBlock.text.startsWith('【长期记忆】'));
  assert.ok(longBlock.text.indexOf('用户讨厌被敷衍') < longBlock.text.indexOf('群里的公共约定'),
    'subject 相关行应排在不相关行之前');
  assert.ok(!out.blocks.some((block) => block.text.includes('语音发送')), '短期行不再进入注入段');
  assert.ok(longBlock.text.includes('画像'), '分类应出现在段里');
  assert.equal(out.truncated, false);

  // 预算截断：longBudget 保底 200，用一条超长内容把尾部行挤出预算。
  service.append({ sessionId: SESSION, tier: 'long', content: `填充：${'x'.repeat(300)}` });
  const clipped = service.render({ sessionId: SESSION, subjectId: 'u_1', maxChars: 200 });
  assert.equal(clipped.truncated, true, '超预算必须显式标记 truncated，不能静默砍掉');
  const clippedLong = clipped.blocks.find((block) => block.kind === 'long');
  assert.ok(clippedLong.text.includes('用户讨厌被敷衍'), 'subject 相关行优先保留');
  close();
});

test('会话隔离：A 会话的记忆不会渲染进 B 会话', async () => {
  const { service, close } = await svc();
  service.append({ sessionId: 'qq:group:111', tier: 'long', content: 'A 群的事' });
  service.append({ sessionId: 'wx:room:222', tier: 'long', content: 'B 群的事' });
  const a = service.render({ sessionId: 'qq:group:111' });
  assert.ok(a.blocks[0].text.includes('A 群的事'));
  assert.ok(!a.blocks[0].text.includes('B 群的事'));
  close();
});
