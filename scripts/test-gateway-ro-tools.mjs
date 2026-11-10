// 只读工具专项：chat_memory_profile / chat_memory_relation（§6.4 工具面）。
// 关键断言：sessionId 一律取 request.sessionKey（网关注入，args.sessionId 不被信任，
// 防提示注入越权）、工具面无任何写入口、降权口径与渲染一致（<0.4 过滤、0.4–0.6 标待确认）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openStore } from '../src/store/store-api.js';
import { createRelationService } from '../src/service/relation-service.js';
import { createProfileService } from '../src/service/profile-service.js';
import { createGatewayV1 } from '../src/service/gateway-v1.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-rotools-'));
const SESSION = 'qq:group:90001';
const auth = { verify: () => ({ serviceId: 'gateway' }) };

async function fixture() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const relation = createRelationService({ store });
  const profile = createProfileService({ store, logger: () => {} });
  const gateway = createGatewayV1({ auth, profile, relation, logger: () => {} });
  return { store, relation, profile, gateway, close: () => store.close() };
}

/** 模拟网关注入：sessionKey 放在 request 顶层（工具 args 里塞的无效）。 */
async function call(gateway, tool, args, sessionKey = SESSION) {
  const res = await gateway.invoke({
    path: '/v1/tools/call',
    request: { v: 1, callId: `c-${tool}`, tool, args, sessionKey },
  });
  return res.body;
}

test('chat_memory_profile：按 subject 读画像与版本链；无画像返回空文本', async () => {
  const { profile, gateway, close } = await fixture();
  try {
    profile.merge({ sessionId: SESSION, subjectId: 'u1', patch: { personality: '温和', catchphrases: ['没问题'] }, confidence: 0.8 });
    const res = await call(gateway, 'chat_memory_profile', { subjectId: 'u1' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.profile.attributes.personality, '温和');
    assert.ok(res.data.text.includes('性格：温和'));
    assert.ok(res.data.versions.length >= 1);

    const empty = await call(gateway, 'chat_memory_profile', { subjectId: 'ghost' });
    assert.equal(empty.ok, true);
    assert.equal(empty.data.profile, null);
    assert.equal(empty.data.text, '');
  } finally {
    close();
  }
});

test('chat_memory_relation：只读列关系；<0.4 过滤；0.4–0.6 标待确认；写入口不存在', async () => {
  const { relation, gateway, close } = await fixture();
  try {
    relation.upsert({ sessionId: SESSION, subjectId: 'u1', key: '称呼', value: '老王', confidence: 1 });
    relation.upsert({ sessionId: SESSION, subjectId: 'u1', key: '生日', value: '3 月 5 日', confidence: 0.5 });
    relation.upsert({ sessionId: SESSION, subjectId: 'u1', key: '喜好', value: '火锅', confidence: 0.3 });

    const res = await call(gateway, 'chat_memory_relation', { subjectId: 'u1' });
    assert.equal(res.ok, true);
    assert.ok(res.data.text.includes('称呼：老王'));
    assert.ok(res.data.text.includes('生日：3 月 5 日（待确认）'));
    assert.ok(!res.data.text.includes('火锅'), 'confidence <0.4 不返回');

    const write = await call(gateway, 'chat_memory_relation_upsert', { subjectId: 'u1', key: '称呼', value: '黑客' });
    assert.equal(write.ok, false);
    assert.equal(write.error.code, 'E_UNSUPPORTED', '工具面只读：写入口不存在');
  } finally {
    close();
  }
});

test('只读工具：缺 subjectId 拒绝；args.sessionId 不被信任（越权防护）', async () => {
  const { profile, gateway, close } = await fixture();
  try {
    profile.merge({ sessionId: 'wx:room:other', subjectId: 'u1', patch: { personality: '别人会话的数据' } });

    const noSubject = await call(gateway, 'chat_memory_profile', {});
    assert.equal(noSubject.ok, false);
    assert.match(noSubject.error.message, /subjectId/);

    // ctx.sessionKey 是唯一权威：args 里塞别的会话 id，读不到那边的画像。
    const evil = await call(gateway, 'chat_memory_profile', { subjectId: 'u1', sessionId: 'wx:room:other' });
    assert.equal(evil.ok, true);
    assert.equal(evil.data.profile, null, 'args.sessionId 被忽略，越权读取落空');
  } finally {
    close();
  }
});
