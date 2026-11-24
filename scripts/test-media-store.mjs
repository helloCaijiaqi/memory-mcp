// 多媒体记忆层 store 层离线单测：v4 迁移、占位符 id 幂等写入、检索（fts/like 降级）、
// 状态流转、使用统计。组合语义（ensureByRef/updateDesc/scanPending/markUsed）在
// media-service 层测（test-media-service.mjs）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/store-api.js';
import { MEDIA_ID_RE, MEDIA_PLACEHOLDER_RE, normalizeMediaRow } from '../src/store/store-api.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-media-'));

function open() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  return openStore({ dir, backend: 'sqlite' }).then((store) => ({
    store,
    media: store.media,
    close: () => store.close(),
  }));
}

const SID = 'qq:group:123456';
const MA_ID = 'ma_' + 'a'.repeat(12);

test('占位符 id 格式与文本提取正则', () => {
  assert.ok(MEDIA_ID_RE.test(MA_ID));
  assert.ok(!MEDIA_ID_RE.test('ma_short'));
  const text = '今天发的图真搞笑 [图片|ma_7f3a00000000] 哈哈 [图片|ma_000000000001]';
  // v3 正则捕获组 2 = id（组 1 是中文类型词）
  const ids = [...text.matchAll(MEDIA_PLACEHOLDER_RE)].map((m) => m[2]);
  assert.deepEqual(ids, ['ma_7f3a00000000', 'ma_000000000001']);
});

test('normalizeMediaRow：默认值/校验/派生 platform', () => {
  const r = normalizeMediaRow({ id: MA_ID, sessionId: SID });
  assert.equal(r.kind, 'image');
  assert.equal(r.status, 'pending');
  assert.equal(r.origin, 'inbound');
  assert.equal(r.platform, 'qq');
  assert.deepEqual(r.tags, []);
  assert.deepEqual(r.sendHints, {});
  assert.equal(r.durationMs, null);
  assert.throws(() => normalizeMediaRow({ id: 'bad', sessionId: SID }), /占位符 id/);
  assert.throws(() => normalizeMediaRow({ sessionId: SID }), /占位符 id/);
});

test('put/get 往返 + fts 检索 + 状态过滤', async () => {
  const { media, close } = await open();
  try {
    await media.put({
      id: MA_ID, sessionId: SID, kind: 'image',
      desc: '一只橘猫躺在键盘上的梗图', tags: ['猫', '梗图'], hash: 'abc123',
    });
    await media.put({
      id: 'ma_' + 'b'.repeat(12), sessionId: SID, kind: 'voice',
      desc: '语音消息：咕咕咕叫', tags: ['语音'], status: 'ready', durationMs: 3200,
    });
    const got = await media.get(MA_ID);
    assert.equal(got.desc, '一只橘猫躺在键盘上的梗图');
    assert.deepEqual(got.tags, ['猫', '梗图']);
    assert.equal(got.platform, 'qq');
    assert.equal(got.status, 'pending');

    const fts = await media.query({ text: '橘猫躺' });
    assert.equal(fts.strategy, 'fts5');
    assert.equal(fts.rows.length, 1);
    assert.equal(fts.rows[0].id, MA_ID);

    const pend = await media.query({ status: 'pending' });
    assert.equal(pend.rows.length, 1);
    const ready = await media.query({ status: 'ready' });
    assert.equal(ready.rows[0].kind, 'voice');
    assert.equal(ready.rows[0].durationMs, 3200);
    assert.equal(await media.count(), 2);
    assert.equal(await media.count({ status: 'ready' }), 1);
  } finally {
    close();
  }
});

test('put 幂等更新：同 id 二次写入保留 createdAt', async () => {
  const { media, close } = await open();
  try {
    const first = await media.put({ id: MA_ID, sessionId: SID, desc: 'v1' });
    const second = await media.put({ id: MA_ID, sessionId: SID, desc: 'v2', status: 'ready' });
    assert.equal(second.createdAt, first.createdAt, 'createdAt 不被覆盖');
    assert.equal(second.desc, 'v2');
    assert.equal(second.status, 'ready');
  } finally {
    close();
  }
});
