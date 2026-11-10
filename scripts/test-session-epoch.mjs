// 会话纪元专项：epoch 惰性推进（静默判定 + CAS 防并发双推进）、活跃触点、
// render 多 block 空边界（无 subject / 无长期 / 全空）、关系渲染降权、
// 双后端（sqlite / json）语义一致。全部离线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openStore } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-epoch-'));
const SESSION = 'qq:group:50001';
const IDLE_MS = 60 * 60 * 1000;

async function fixture({ backend = 'sqlite', sessionIdleMs = IDLE_MS, at } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${backend}-`));
  const store = await openStore({ dir, backend });
  const service = createMemoryService({ store, config: { sessionIdleMs } });
  return { store, service, close: () => store.close() };
}

test('epoch：首条消息建立状态行（epoch=1，活跃时间取消息时间，平台从会话 id 提取）', async () => {
  const { store, service, close } = await fixture();
  try {
    const at = Date.now() - 5000;
    service.ingest({ sessionId: SESSION, msgId: 'm1', senderId: 'u1', text: '在吗', createdAt: at });
    const state = store.sessionState.get(SESSION);
    assert.equal(state.epoch, 1);
    assert.equal(state.lastActivityAt, at);
    assert.equal(state.platform, 'qq');
    assert.equal(state.lastSummarizedAt, null);
  } finally {
    close();
  }
});

test('epoch：推进只发生在读路径 —— 活跃期内 render 不推进；静默后首次 render 推进', async () => {
  const { store, service, close } = await fixture({ sessionIdleMs: 1000 });
  try {
    const t0 = Date.now() - 10_000;
    // ingest 只记活跃，不判静默（写路径不负责纪元推进）。
    service.ingest({ sessionId: SESSION, msgId: 'm1', senderId: 'u1', text: '第一轮', createdAt: t0 });
    service.ingest({ sessionId: SESSION, msgId: 'm2', senderId: 'u1', text: '还在聊', createdAt: t0 + 100 });
    assert.equal(store.sessionState.get(SESSION).epoch, 1);

    // 活跃会话：touch 到当前时刻，render 不推进。
    store.sessionState.touchActivity(SESSION, { platform: 'qq', at: Date.now() });
    const active = service.render({ sessionId: SESSION, subjectId: '' });
    assert.equal(active.epoch, 1, '活跃期内不推进纪元');

    // 静默超阈值（lastActivity 停在 t0+100，距今 9.9s > 1s）：读路径发现即推进。
    service.ingest({ sessionId: SESSION, msgId: 'm3', senderId: 'u1', text: '隔了很久又来了', createdAt: t0 + 2100 });
    const woken = service.render({ sessionId: SESSION, subjectId: '' });
    assert.equal(woken.epoch, 2, '静默后首次读路径应推进纪元（新会话首轮）');
    // 推进完即 touch：同一纪元内的后续轮次不再推进。
    const again = service.render({ sessionId: SESSION, subjectId: '' });
    assert.equal(again.epoch, 2);
  } finally {
    close();
  }
});

test('epoch：CAS 防并发双推进 —— expect 不匹配时沿用现值，不会 +2', async () => {
  const { store, close } = await fixture({ sessionIdleMs: 1000 });
  try {
    store.sessionState.touchActivity(SESSION, { platform: 'qq', at: Date.now() - 5000 });
    const state = store.sessionState.get(SESSION);
    const first = store.sessionState.advanceEpoch(SESSION, { expect: state.epoch, at: Date.now() });
    assert.equal(first.epoch, 2);
    // 第二个读者还拿着旧 epoch：推进失败，返回 null（调用方沿用 get 现值）。
    const second = store.sessionState.advanceEpoch(SESSION, { expect: state.epoch, at: Date.now() });
    assert.equal(second, null);
    assert.equal(store.sessionState.get(SESSION).epoch, 2, '不得出现 +2');
    // 拿新值再推进才成功。
    const third = store.sessionState.advanceEpoch(SESSION, { expect: 2, at: Date.now() });
    assert.equal(third.epoch, 3);
  } finally {
    close();
  }
});

test('epoch：摘要游标 markSummarized 落在 session_state（不单设 summary_cursor）', async () => {
  const { store, close } = await fixture();
  try {
    store.sessionState.touchActivity(SESSION, { platform: 'qq' });
    const upTo = Date.now() - 1000;
    const marked = store.sessionState.markSummarized(SESSION, { summarizedUpTo: upTo });
    assert.equal(marked.lastSummarizedAt, upTo);
    assert.equal(store.sessionState.markSummarized('qq:group:不存在', { summarizedUpTo: upTo }), null);
  } finally {
    close();
  }
});

test('render 空边界：全空 → blocks 为空但 epoch 照常返回；无 subject → 只有长期块', async () => {
  const { service, close } = await fixture();
  try {
    const empty = service.render({ sessionId: SESSION });
    assert.ok(Number.isInteger(empty.epoch) && empty.epoch >= 1, '全空也必须有纪元');
    assert.deepEqual(empty.blocks, [], '全空不注入任何段');
    assert.equal(empty.truncated, false);

    service.append({ sessionId: SESSION, tier: 'long', content: '长期事实' });
    const noSubject = service.render({ sessionId: SESSION, subjectId: '' });
    assert.deepEqual(noSubject.blocks.map((block) => block.kind), ['long'], '无 subject 不产 identity 块');

    const withSubject = service.render({ sessionId: SESSION, subjectId: 'u_none' });
    assert.deepEqual(withSubject.blocks.map((block) => block.kind), ['long'], 'subject 无画像关系 → 跳过 identity');
  } finally {
    close();
  }
});

test('render 空边界：无长期但有关系 → 只产 identity；短層存量行不渲染', async () => {
  const { store, service, close } = await fixture();
  try {
    await store.relation.upsert({ sessionId: SESSION, platform: 'qq', subjectId: 'u1', key: '称呼', value: '老王' });
    // 存量短期行（旧数据）：不再进入注入段。
    service.append({ sessionId: SESSION, tier: 'short', content: '旧短期行' });

    const out = service.render({ sessionId: SESSION, subjectId: 'u1' });
    assert.deepEqual(out.blocks.map((block) => block.kind), ['identity']);
    assert.ok(out.blocks[0].text.includes('称呼：老王'));
  } finally {
    close();
  }
});

test('render 关系降权：confidence <0.4 不注入，0.4–0.6 标「待确认」', async () => {
  const { store, service, close } = await fixture({ backend: 'sqlite' });
  try {
    await store.relation.upsert({ sessionId: SESSION, platform: 'qq', subjectId: 'u1', key: '高置信', value: 'A' });
    await store.relation.upsert({ sessionId: SESSION, platform: 'qq', subjectId: 'u1', key: '待确认', value: 'B' });
    await store.relation.upsert({ sessionId: SESSION, platform: 'qq', subjectId: 'u1', key: '太低', value: 'C' });
    // 直接改列值验证渲染语义（自动抽取的 confidence 由 relation-guard 批次落地）。
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(store.path);
    db.prepare("UPDATE relation SET confidence = 0.5 WHERE key = '待确认'").run();
    db.prepare("UPDATE relation SET confidence = 0.3 WHERE key = '太低'").run();
    db.close();

    const out = service.render({ sessionId: SESSION, subjectId: 'u1' });
    const text = out.blocks.map((block) => block.text).join('\n');
    assert.ok(text.includes('高置信：A'));
    assert.ok(text.includes('待确认：B（待确认）'), '0.4–0.6 应标注待确认');
    assert.ok(!text.includes('太低'), 'confidence <0.4 不注入');
  } finally {
    close();
  }
});

test('epoch：JSON 兜底后端语义一致（touch/advance CAS/listIdle/count）', async () => {
  const { store, service, close } = await fixture({ backend: 'json', sessionIdleMs: 1000 });
  try {
    const t0 = Date.now() - 5000;
    service.ingest({ sessionId: SESSION, msgId: 'm1', senderId: 'u1', text: '第一轮', createdAt: t0 });
    assert.equal(store.sessionState.get(SESSION).epoch, 1);

    const stale = store.sessionState.advanceEpoch(SESSION, { expect: 1, at: Date.now() });
    assert.equal(stale.epoch, 2);
    assert.equal(store.sessionState.advanceEpoch(SESSION, { expect: 1, at: Date.now() }), null);

    // listIdle：按静默阈值筛会话。
    const idle = store.sessionState.listIdle({ olderThan: Date.now() - 10_000 });
    assert.equal(idle.length, 0, '刚活跃的会话不在静默列表里');
    assert.equal(store.sessionState.listIdle({ olderThan: Date.now() + 1000 }).length, 1);
    assert.equal(store.stats().sessionState, 1);

    const out = service.render({ sessionId: SESSION, subjectId: '' });
    assert.ok(Number.isInteger(out.epoch));
  } finally {
    close();
  }
});
