// 网关接入面测试：/v1/tools/call（tool.call 唯一信封：HMAC 鉴权、decorator 契约
// {sections, epoch}、工具路由、业务失败透传、nonce 防重放）。全离线：memory/recall 用假实现。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createGatewayAuth, createGatewayV1 } from '../src/service/gateway-v1.js';
import { createHttpApi } from '../src/http-api.js';

const SECRET = 'gateway-shared-secret-0123456789';
const REG_ID = crypto.randomUUID().replaceAll('-', '');
let passed = 0;
let failed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ✔ ${name}`); })
    .catch((error) => { failed += 1; console.error(`  ✖ ${name}\n    ${error?.stack ?? error}`); });
}

function signRequest({ secret, adapterId, body, timestamp = Date.now(), nonce = crypto.randomBytes(12).toString('hex') }) {
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${bodyHash}`).digest('hex');
  return {
    'x-adapter-id': adapterId,
    'x-timestamp': String(timestamp),
    'x-nonce': nonce,
    'x-signature': `v1=${signature}`,
  };
}

const fakeMemory = {
  render({ sessionId, subjectId }) {
    assert.ok(sessionId.startsWith('qq:'), 'decorator 收到 platform:scope:id 形 sessionId');
    fakeMemory.lastSubjectId = subjectId ?? '';
    return { blocks: [{ name: '记忆', text: '【记忆】\n测试记忆段', kind: 'long', chars: 12 }], epoch: 3 };
  },
  async record(args) {
    assert.ok(args.content, 'record 需要 content');
    return { memory: { id: 'm1', content: args.content }, created: true };
  },
  async forget(args) {
    // 记录调用参数：用于断言工具面必须把当前会话带下去（归属校验）。
    fakeMemory.lastForget = args;
    return { archived: args.mode !== 'hard' };
  },
  stats() { return { memories: 1 }; },
};
const fakeRecall = {
  async recall(args) {
    assert.equal(args.sessionId, 'qq:group:123');
    return { rows: [{ id: 'm1' }], text: '回忆正文', strategy: 'fts5', degraded: false };
  },
};

function post(port, path, { headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// decorator 形态的 tool.call：args 恒 {}，context.senderId 决定 identity 主体。
const decoratorCallBody = JSON.stringify({
  v: 1, callId: 'svc-1', tool: 'chat_memory_get', args: {},
  sessionKey: 'qq:group:123', context: { senderId: 'u_1' },
});
const toolCallBody = JSON.stringify({
  v: 1, callId: 'tool-1', tool: 'chat_memory_recall', args: { text: '旅行' }, sessionKey: 'qq:group:123',
});

const gateway = createGatewayV1({
  auth: createGatewayAuth({ secret: SECRET, serviceId: REG_ID }),
  memory: fakeMemory,
  recall: fakeRecall,
  logger: () => {},
});
const api = createHttpApi({ memory: fakeMemory, recall: fakeRecall, token: 'local-tok', gateway, port: 0 });
const { port } = await api.listen();

try {
  await check('未签名请求 → 401', async () => {
    const res = await post(port, '/v1/tools/call', { body: decoratorCallBody });
    assert.equal(res.status, 401);
  });

  await check('错误密钥 → 401', async () => {
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: 'wrong-secret-0123456789', adapterId: REG_ID, body: decoratorCallBody }),
      body: decoratorCallBody,
    });
    assert.equal(res.status, 401);
  });

  await check('身份头与登记 id 不匹配 → 401', async () => {
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: 'other-service', body: decoratorCallBody }),
      body: decoratorCallBody,
    });
    assert.equal(res.status, 401);
  });

  await check('nonce 重放 → 401', async () => {
    const headers = signRequest({ secret: SECRET, adapterId: REG_ID, body: decoratorCallBody });
    const first = await post(port, '/v1/tools/call', { headers, body: decoratorCallBody });
    assert.equal(first.status, 200);
    const second = await post(port, '/v1/tools/call', { headers, body: decoratorCallBody });
    assert.equal(second.status, 401);
  });

  await check('tools/call：decorator 契约（ok + sections + epoch，context.senderId 下传）', async () => {
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body: decoratorCallBody }),
      body: decoratorCallBody,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.v, 1);
    assert.equal(res.body.callId, 'svc-1');
    assert.equal(res.body.ok, true);
    assert.equal(fakeMemory.lastSubjectId, 'u_1', 'context.senderId 必须传给 render');
    assert.equal(res.body.data.epoch, 3);
    assert.equal(res.body.data.sections[0].name, '记忆');
    assert.ok(res.body.data.sections[0].text.includes('测试记忆段'));
    assert.equal(res.body.data.sections[0].priority, 50, 'long 块中等优先级');
  });

  await check('tools/call：chat_memory_recall 路由到 recall', async () => {
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body: toolCallBody }),
      body: toolCallBody,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { v: 1, callId: 'tool-1', ok: true, data: { rows: [{ id: 'm1' }], text: '回忆正文', strategy: 'fts5', degraded: false } });
  });

  await check('tools/call：args.sessionId 被忽略，只能操作当前会话', async () => {
    const body = JSON.stringify({
      v: 1, callId: 'tool-cross', tool: 'chat_memory_recall',
      args: { text: '旅行', sessionId: 'qq:group:999' }, sessionKey: 'qq:group:123',
    });
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body }),
      body,
    });
    assert.equal(res.status, 200);
    // fakeRecall 内部断言 sessionId === 'qq:group:123'：传 999 也必须被忽略。
    assert.equal(res.body.ok, true);
  });

  await check('tools/call：forget 带上当前会话（归属校验依据）', async () => {
    const body = JSON.stringify({
      v: 1, callId: 'tool-forget', tool: 'chat_memory_forget',
      args: { id: 'm1', mode: 'soft', sessionId: 'qq:group:999' }, sessionKey: 'qq:group:123',
    });
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body }),
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(fakeMemory.lastForget.sessionId, 'qq:group:123', '必须用 ctx.sessionKey 而不是 args.sessionId');
  });

  await check('tools/call：record 缺 content → ok:false 业务失败透传', async () => {
    const body = JSON.stringify({ v: 1, callId: 'tool-2', tool: 'chat_memory_record', args: {}, sessionKey: 'qq:group:123' });
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body }),
      body,
    });
    assert.equal(res.status, 200, '业务失败是正常结果，HTTP 仍 200');
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'E_ACTION');
  });

  await check('tools/call：未知工具 → ok:false E_UNSUPPORTED', async () => {
    const body = JSON.stringify({ v: 1, callId: 'tool-3', tool: 'chat_memory_nope', args: {} });
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body }),
      body,
    });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'E_UNSUPPORTED');
  });

  await check('契约错误（缺 callId）→ 400', async () => {
    const body = JSON.stringify({ v: 1, tool: 'chat_memory_forget', args: { id: 'm1' } });
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body }),
      body,
    });
    assert.equal(res.status, 400);
  });

  await check('坏 JSON → 400', async () => {
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body: '{broken' }),
      body: '{broken',
    });
    assert.equal(res.status, 400);
  });

  await check('空 body 无签名 → 401', async () => {
    const res = await post(port, '/v1/service/call', { body: '' });
    assert.equal(res.status, 401, '无签名先 401');
  });

  await check('/api/health 免令牌且不受影响', async () => {
    const res = await post(port, '/api/health', { body: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'memory-mcp');
  });

  await check('/api/* 既有令牌通道不受影响（带 x-mcp-token）', async () => {
    const body = JSON.stringify({ sessionId: 'qq:group:123', text: '旅行' });
    const res = await post(port, '/api/recall', { headers: { 'x-mcp-token': 'local-tok' }, body });
    assert.equal(res.status, 200);
    assert.equal(res.body.text, '回忆正文');
  });
} finally {
  await api.close();
}

// ── 热加载：auth.rotate 原地换密钥（gateway.json 热加载的地基）─────────────────
await check('rotate：换密钥后旧签名 401、新签名通过', async () => {
  const auth = createGatewayAuth({ secret: SECRET, serviceId: REG_ID });
  const gateway = createGatewayV1({ auth, memory: fakeMemory, recall: fakeRecall });
  const oldSig = signRequest({ secret: SECRET, adapterId: REG_ID, body: decoratorCallBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: oldSig, rawBody: decoratorCallBody })).status, 200);

  const NEXT = 'rotated-shared-secret-0123456789';
  auth.rotate({ secret: NEXT, serviceId: REG_ID });
  // 旧密钥签名（换掉 secret 但换新 nonce）→ 401：密钥真的换掉了。
  const stale = signRequest({ secret: SECRET, adapterId: REG_ID, body: decoratorCallBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: stale, rawBody: decoratorCallBody })).status, 401);
  // 新密钥签名 → 200；业务 handler 未重建（同一个 gateway 实例继续工作）。
  const fresh = signRequest({ secret: NEXT, adapterId: REG_ID, body: decoratorCallBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: fresh, rawBody: decoratorCallBody })).status, 200);
});

await check('rotate：serviceId 一并轮换；过短密钥整体拒收（保留旧值）', async () => {
  const auth = createGatewayAuth({ secret: SECRET, serviceId: 'id-a' });
  const gateway = createGatewayV1({ auth, memory: fakeMemory, recall: fakeRecall });
  const otherIdBody = decoratorCallBody;
  // id-a 期间用 id-b 签名 → 身份不匹配 401。
  const wrongId = signRequest({ secret: SECRET, adapterId: 'id-b', body: otherIdBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: wrongId, rawBody: otherIdBody })).status, 401);

  assert.throws(() => auth.rotate({ secret: 'short' }), /至少 16 字符/);
  // 拒收后旧值仍在：id-a + 旧密钥照常通过。
  const stillOld = signRequest({ secret: SECRET, adapterId: 'id-a', body: otherIdBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: stillOld, rawBody: otherIdBody })).status, 200);

  auth.rotate({ secret: SECRET, serviceId: 'id-b' });
  const withNewId = signRequest({ secret: SECRET, adapterId: 'id-b', body: otherIdBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: withNewId, rawBody: otherIdBody })).status, 200);
});

await check('rotate：换密钥不重置防重放 nonce 窗口', async () => {
  const auth = createGatewayAuth({ secret: SECRET, serviceId: REG_ID });
  const gateway = createGatewayV1({ auth, memory: fakeMemory, recall: fakeRecall });
  const nonce = crypto.randomBytes(12).toString('hex');
  const headers = signRequest({ secret: SECRET, adapterId: REG_ID, body: decoratorCallBody, nonce });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers, rawBody: decoratorCallBody })).status, 200);
  auth.rotate({ secret: 'rotated-shared-secret-0123456789', serviceId: REG_ID });
  // 同一 nonce 用新密钥重签 → 依然 401：轮换不重置防重放窗口。
  const replay = signRequest({ secret: 'rotated-shared-secret-0123456789', adapterId: REG_ID, body: decoratorCallBody, nonce });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: replay, rawBody: decoratorCallBody })).status, 401);
});

console.log(`\nℹ tests ${passed + failed}\nℹ pass ${passed}\nℹ fail ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
