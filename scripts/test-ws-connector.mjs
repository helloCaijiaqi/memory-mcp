// 网关 WS 连接器测试（真 WS 服务端，握手按 ws-hub 同公式验签）。
//
// 覆盖：握手签名、service.call 应答（成功/失败）、tool.call 应答、ping→pong、
// 错密钥 401、配置 fail-closed（非法 transport / 缺 id）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createGatewayWsConnector } from '../src/service/ws-connector.js';

const SECRET = 'gateway-ws-secret-0123456789';
const SERVICE_ID = 'a'.repeat(32);

function verifyHandshake(url) {
  const id = url.searchParams.get('adapterId');
  const tsRaw = url.searchParams.get('ts');
  const nonce = url.searchParams.get('nonce');
  const sign = url.searchParams.get('sign');
  if (!id || !tsRaw || !nonce || !sign) return false;
  if (id !== SERVICE_ID) return false;
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;
  const bodyHash = crypto.createHash('sha256').update('').digest('hex');
  const expected = crypto.createHmac('sha256', SECRET).update(`${ts}\n${nonce}\n${bodyHash}`).digest('hex');
  return sign === `v1=${expected}`;
}

// 8s：满负载（并行跑其它仓测试）时，401 握手 + 退避重连可能超过 3s。
function waitFor(predicate, ms = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      if (predicate()) {
        clearInterval(tick);
        resolve(true);
      } else if (Date.now() - started > ms) {
        clearInterval(tick);
        reject(new Error('waitFor timeout'));
      }
    }, 15);
  });
}

async function startHub({ secret = SECRET } = {}) {
  const server = http.createServer((req, res) => res.end('ok'));
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  const received = [];
  let rejected = 0;
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ok = secret === SECRET && verifyHandshake(url);
    if (!ok) {
      rejected += 1;
      // 客户端可能直接 RST（terminate），server 侧 socket 的 ECONNRESET 必须有处落地，
      // 否则会被 node:test 当成当前用例的未捕获异常。
      socket.on('error', () => {});
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data) => received.push(JSON.parse(String(data))));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    received,
    get rejected() { return rejected; },
    send(payload) { for (const ws of sockets) ws.send(JSON.stringify(payload)); },
    async close() {
      for (const ws of sockets) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('连接器：握手签名 + service.call 成功/失败应答', async () => {
  const hub = await startHub();
  let mode = 'ok';
  const connector = createGatewayWsConnector({
    url: hub.baseUrl,
    serviceId: SERVICE_ID,
    secret: SECRET,
    transport: 'auto',
    invoke: async ({ path, request }) => {
      if (path === '/v1/service/call' && mode === 'ok') {
        return { status: 200, body: { v: 1, callId: request.callId, verdict: 'pass', sections: [{ name: '记忆', text: 'x' }] } };
      }
      return { status: 400, body: { error: 'bad request', callId: request.callId } };
    },
    logger: () => {},
  });
  try {
    connector.start();
    await waitFor(() => connector.connected);
    assert.equal(hub.rejected, 0);

    hub.send({ v: 1, type: 'service.call', callId: 'c1', sessionKey: 'qq:group:1', maxChars: 100 });
    await waitFor(() => hub.received.some((m) => m.type === 'service.call/result' && m.callId === 'c1'));
    const okReply = hub.received.find((m) => m.type === 'service.call/result' && m.callId === 'c1');
    assert.equal(okReply.ok, true);
    assert.equal(okReply.result.verdict, 'pass');
    assert.equal(okReply.result.sections[0].name, '记忆');

    mode = 'fail';
    hub.send({ v: 1, type: 'service.call', callId: 'c2', sessionKey: 'qq:group:1' });
    await waitFor(() => hub.received.some((m) => m.type === 'service.call/result' && m.callId === 'c2'));
    const failReply = hub.received.find((m) => m.type === 'service.call/result' && m.callId === 'c2');
    assert.equal(failReply.ok, false);
    assert.ok(failReply.error.message.includes('bad request'));
  } finally {
    connector.stop();
    await hub.close();
  }
});

test('连接器：tool.call 应答 + ping→pong', async () => {
  const hub = await startHub();
  const connector = createGatewayWsConnector({
    url: hub.baseUrl,
    serviceId: SERVICE_ID,
    secret: SECRET,
    invoke: async ({ path, request }) => {
      assert.equal(path, '/v1/tools/call');
      return { status: 200, body: { v: 1, callId: request.callId, ok: true, data: { tool: request.tool } } };
    },
    logger: () => {},
  });
  try {
    connector.start();
    await waitFor(() => connector.connected);
    hub.send({ v: 1, type: 'tool.call', callId: 't1', tool: 'chat_memory_recall', args: {} });
    await waitFor(() => hub.received.some((m) => m.type === 'tool.call/result' && m.callId === 't1'));
    const reply = hub.received.find((m) => m.type === 'tool.call/result' && m.callId === 't1');
    assert.equal(reply.ok, true);
    assert.equal(reply.data.tool, 'chat_memory_recall');

    hub.send({ v: 1, type: 'ping', at: Date.now() });
    await waitFor(() => hub.received.some((m) => m.type === 'pong'));
  } finally {
    connector.stop();
    await hub.close();
  }
});

test('连接器：握手挂起时看门狗收口，不永久停在 connecting', async () => {
  const sockets = [];
  class SilentSocket {
    constructor() { this.handlers = {}; sockets.push(this); }
    on(event, handler) { (this.handlers[event] ??= []).push(handler); }
    send() {}
    close() {}
    terminate() { this.terminated = true; }
  }
  const connector = createGatewayWsConnector({
    url: 'http://127.0.0.1:1',
    serviceId: SERVICE_ID,
    secret: SECRET,
    invoke: async () => ({ status: 200, body: {} }),
    logger: () => {},
    wsImpl: SilentSocket,
    handshakeTimeoutMs: 50,
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
  });
  try {
    connector.start();
    await waitFor(() => sockets.length >= 1, 500);
    await waitFor(() => sockets[0].terminated === true, 500);
    assert.equal(connector.connected, false);
  } finally {
    connector.stop();
  }
});

test('连接器：错密钥 401 + 配置 fail-closed', async () => {
  const hub = await startHub();
  try {
    const bad = createGatewayWsConnector({
      url: hub.baseUrl,
      serviceId: SERVICE_ID,
      secret: 'wrong-secret-0123456789',
      invoke: async () => ({ status: 200, body: {} }),
      logger: () => {},
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    });
    bad.start();
    // `>= 1`：重连间隔很短时两次 401 升级可能落在同一个轮询间隔内（计数直接到 2）。
    await waitFor(() => hub.rejected >= 1);
    bad.stop();
  } finally {
    await hub.close();
  }

  assert.throws(() => createGatewayWsConnector({
    url: 'http://127.0.0.1:1', serviceId: SERVICE_ID, secret: SECRET, transport: 'http', invoke: async () => ({}),
  }), /只支持 ws\|auto/);
  assert.throws(() => createGatewayWsConnector({ url: '', serviceId: SERVICE_ID, secret: SECRET }), /需要 url/);
  assert.throws(() => createGatewayWsConnector({ url: 'http://x', secret: SECRET }), /登记 id/);
  assert.throws(() => createGatewayWsConnector({ url: 'http://x', serviceId: SERVICE_ID, secret: 'short' }), /16 字符/);
});
