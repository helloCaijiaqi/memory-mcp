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
  const { service, close } = await svc({ maxShort: 3 });
  for (let i = 0; i < 6; i += 1) {
    service.append({ sessionId: SESSION, tier: 'short', content: `话题 ${i}` });
  }
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

test('命中会抬权重；够格后自动巩固为长期', async () => {
  const { service, close } = await svc();
  const row = service.append({ sessionId: SESSION, tier: 'short', content: '反复被提起的话题' });
  const after1 = service.touch({ id: row.id });
  assert.equal(after1.hits, 1);
  assert.equal(after1.tier, 'short');
  service.touch({ id: row.id });
  const after3 = service.touch({ id: row.id });
  assert.equal(after3.tier, 'long', '触及次数达标后应升级为长期');
  assert.equal(after3.expiresAt, null, '升级后不应再带 TTL');
  close();
});

test('显式重要度达标也会巩固；consolidate 可整会话批量执行', async () => {
  const { service, close } = await svc();
  const row = service.append({ sessionId: SESSION, tier: 'short', content: '很重要的事实', importance: 9 });
  assert.equal(shouldConsolidate(row, {}), true);
  service.append({ sessionId: SESSION, tier: 'short', content: '鸡毛蒜皮', importance: 0 });
  const promoted = service.consolidate({ sessionId: SESSION });
  assert.equal(promoted.length, 1, '只有够格的才升级');
  assert.equal(service.query({ sessionId: SESSION, tier: 'long' }).rows.length, 1);
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

test('render 产出可直接拼接的【记忆】段，并按权重排序、超限截断', async () => {
  const { service, close } = await svc();
  service.append({ sessionId: SESSION, tier: 'long', content: '长期：用户讨厌被敷衍', category: '画像' });
  service.append({ sessionId: SESSION, tier: 'short', content: '短期：正在聊语音发送', category: '话题' });
  const out = service.render({ sessionId: SESSION });
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].name, '记忆');
  assert.ok(out.blocks[0].text.startsWith('【记忆】'));
  assert.ok(out.blocks[0].text.includes('长期记忆：'));
  assert.ok(out.blocks[0].text.includes('短期记忆：'));
  assert.ok(out.blocks[0].text.includes('画像'), '分类应出现在段里');
  assert.equal(out.truncated, false);

  const clipped = service.render({ sessionId: SESSION, maxChars: 40 });
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.blocks[0].text.includes('已截断'), '截断必须显式告知，不能静默砍掉');
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
