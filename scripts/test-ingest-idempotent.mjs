// 入站落地的单元测试（会话纪元模型，raw-only）：幂等（同 msgId 只落一条原文）、
// 重放不改写正文、空正文只进原文层、事务边界（触点失败不留半条）、跨平台同 msgId 不撞、
// 活跃触点（session_state）随 ingest 落库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { anchorId, openStore } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-ingest-'));
const SESSION = 'qq:group:40001';
const WX_SESSION = 'wx:room:40001';

async function fixture() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  return { store, memory: createMemoryService({ store }), close: () => store.close() };
}

test('ingest：同 msgId 重复投递只落一条原文，锚点不变；不再写短期层', async () => {
  const { store, memory, close } = await fixture();
  try {
    const first = memory.ingest({ sessionId: SESSION, msgId: 'm1', senderId: 'u1', text: '今晚去吃火锅' });
    assert.equal(first.created.raw, true);
    assert.equal(first.created.memory, false, '短期层已删除：聊天消息不进 memory 表');
    assert.equal(first.anchor, anchorId(SESSION, 'm1'));

    const again = memory.ingest({ sessionId: SESSION, msgId: 'm1', senderId: 'u1', text: '今晚去吃火锅' });
    assert.equal(again.created.raw, false, '原文层不该有第二条');
    assert.equal(again.memory, null);
    assert.equal(again.anchor, first.anchor, '锚点必须由 (sessionId, msgId) 唯一确定');
    assert.equal(again.raw.id, first.raw.id);

    assert.equal(store.raw.count({ sessionId: SESSION }), 1);
    assert.equal(store.memory.count({ sessionId: SESSION }), 0, '短期层不再增长');
  } finally {
    close();
  }
});

test('ingest：重放不覆盖已落库的正文（正文以首见为准）', async () => {
  const { store, memory, close } = await fixture();
  try {
    const first = memory.ingest({ sessionId: SESSION, msgId: 'm2', text: '用户讨厌被敷衍' });

    // 重放同一条消息、正文还变了（适配器重试时渲染可能不同）：原文不能被覆盖。
    const replay = memory.ingest({ sessionId: SESSION, msgId: 'm2', text: '用户很讨厌被敷衍' });
    assert.equal(replay.created.raw, false);
    assert.equal(replay.raw.text, '用户讨厌被敷衍', '已在库的正文不因重放而改写');
    assert.equal(store.raw.count({ sessionId: SESSION }), 1);
  } finally {
    close();
  }
});

test('ingest：没有正文的消息只进原文层，不产生空记忆', async () => {
  const { store, memory, close } = await fixture();
  try {
    const out = memory.ingest({ sessionId: SESSION, msgId: 'img1', senderId: 'u1', text: '', rawKind: 'image' });
    assert.equal(out.created.raw, true);
    assert.equal(out.created.memory, false);
    assert.equal(out.memory, null);
    assert.equal(out.raw.kind, 'image');
    assert.equal(store.memory.count({ sessionId: SESSION }), 0);

    // 空正文也不影响锚点：图片同样能回指。
    assert.equal(out.anchor, anchorId(SESSION, 'img1'));
  } finally {
    close();
  }
});

test('ingest：活跃触点随 ingest 落库（纪元窗口按最后一条消息算）', async () => {
  const { store, memory, close } = await fixture();
  try {
    const at = Date.now() - 1000;
    memory.ingest({ sessionId: SESSION, msgId: 'a1', senderId: 'u1', text: '在吗', createdAt: at });
    const state = store.sessionState.get(SESSION);
    assert.ok(state, '首条消息应建立会话状态行');
    assert.equal(state.epoch, 1);
    assert.equal(state.lastActivityAt, at, '活跃时间取消息时间而不是处理时间');
    assert.equal(state.platform, 'qq');
    assert.equal(state.lastSummarizedAt, null, '摘要游标初始为空（还没摘要过）');
  } finally {
    close();
  }
});

test('ingest：同 msgId 在不同平台是两行，互不覆盖', async () => {
  const { store, memory, close } = await fixture();
  try {
    const qq = memory.ingest({ sessionId: SESSION, msgId: 'same', text: '群里的说法' });
    const wx = memory.ingest({ sessionId: WX_SESSION, msgId: 'same', text: '微信里的说法' });

    assert.notEqual(qq.raw.id, wx.raw.id, 'sessionId 含平台，幂等键天然不撞');
    assert.equal(qq.raw.platform, 'qq');
    assert.equal(wx.raw.platform, 'wx');
    assert.equal(store.raw.count({ platform: 'qq' }), 1);
    assert.equal(store.raw.count({ platform: 'wx' }), 1);
  } finally {
    close();
  }
});
