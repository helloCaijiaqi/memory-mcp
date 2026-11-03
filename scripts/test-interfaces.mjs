// 双接口的契约测试：回环 HTTP + stdio MCP。
// 不连 DSH、不连 QQ，只在临时目录里起进程。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(PKG_ROOT, 'src', 'server.mjs');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-iface-'));
const SESSION = 'qq:group:10086';

function tmpState() {
  return fs.mkdtempSync(path.join(TMP_ROOT, 'state-'));
}

async function withApi(fn) {
  const dir = tmpState();
  const app = await start({
    env: { MEMORY_MCP_STATE_DIR: dir, MEMORY_MCP_HTTP_PORT: '0', MEMORY_MCP_TOKEN: 'test-token' },
    stdio: false,
    logger: () => {},
  });
  const port = app.api.address?.port ?? 0;
  assert.ok(port > 0, '应拿到真实监听端口');
  try {
    return await fn({ app, token: 'test-token', port });
  } finally {
    await app.api.close();
    app.store.close();
  }
}

async function call(port, route, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

test('HTTP：健康检查不需要令牌，业务路由需要', async () => {
  await withApi(async ({ port }) => {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    const noToken = await call(port, '/api/memory/query', { sessionId: SESSION });
    assert.equal(noToken.status, 401);
    const badToken = await call(port, '/api/memory/query', {}, { 'x-mcp-token': 'wrong' });
    assert.equal(badToken.status, 401);
    const good = await call(port, '/api/memory/query', {}, { 'x-mcp-token': 'test-token' });
    assert.equal(good.status, 200);
  });
});

test('HTTP：写入 → 查询 → 渲染段落', async () => {
  await withApi(async ({ port, token }) => {
    const auth = { 'x-mcp-token': token };
    const row = await call(port, '/api/memory/append', { sessionId: SESSION, tier: 'long', content: '用户讨厌被敷衍', category: '画像' }, auth);
    assert.equal(row.status, 200);
    assert.ok(row.body.id);

    const found = await call(port, '/api/memory/query', { sessionId: SESSION, text: '敷衍' }, auth);
    assert.equal(found.status, 200);
    assert.equal(found.body.rows.length, 1, `2 字查询必须命中，strategy=${found.body.strategy}`);

    const blocks = await call(port, '/api/blocks/render', { sessionId: SESSION }, auth);
    assert.equal(blocks.status, 200);
    const names = blocks.body.blocks.map((block) => block.name);
    assert.ok(names.includes('记忆'), `应含【记忆】段，实际：${names.join('、')}`);
    assert.ok(blocks.body.blocks[0].text.startsWith('【记忆】'));
  });
});

test('HTTP：参数不合法时返回明确错误，不静默成功', async () => {
  await withApi(async ({ port, token }) => {
    const auth = { 'x-mcp-token': token };
    const bad = await call(port, '/api/memory/append', { sessionId: 'not-a-session-id', content: 'x' }, auth);
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.includes('三段式'), `错误信息应说明原因，实际：${bad.body.error}`);
  });
});

test('HTTP：未知路由 404', async () => {
  await withApi(async ({ port, token }) => {
    const res = await call(port, '/api/nope', {}, { 'x-mcp-token': token });
    assert.equal(res.status, 404);
  });
});

test('stdio MCP：能握手，且暴露约定的工具', async () => {
  const dir = tmpState();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MEMORY_MCP_STATE_DIR: dir, MEMORY_MCP_HTTP_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString('utf8')));
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'iface-test', version: '1.0.0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  const deadline = Date.now() + 8000;
  const text = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const joined = stdout.join('');
      if (joined.includes('"id":2') || Date.now() > deadline) {
        clearInterval(timer);
        resolve(joined);
      }
    }, 100);
  });
  child.kill();

  assert.ok(text.includes('"protocolVersion"'), `握手应返回结果，实际输出：${text.slice(0, 300)}`);
  // initialize 的响应里也有 "tools"（那是能力声明），必须找真正带工具数组的那条。
  const payloads = text
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const listPayload = payloads.find((item) => Array.isArray(item.result?.tools));
  assert.ok(listPayload, `应返回工具列表，stderr：${stderr.join('').slice(0, 300)}`);
  const names = listPayload.result.tools.map((tool) => tool.name).sort();
  for (const expected of ['memory_append', 'memory_query', 'memory_touch', 'memory_forget', 'memory_restore', 'memory_consolidate', 'slang_discover', 'slang_submit', 'slang_query', 'slang_confirm', 'slang_reject', 'memory_context_render']) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}，实际：${names.join('、')}`);
  }
});
