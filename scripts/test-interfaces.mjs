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
const DAY = 24 * 60 * 60 * 1000;

function tmpState() {
  return fs.mkdtempSync(path.join(TMP_ROOT, 'state-'));
}

async function withApi(fn, extraEnv = {}) {
  const dir = tmpState();
  const app = await start({
    env: { MEMORY_MCP_STATE_DIR: dir, MEMORY_MCP_HTTP_PORT: '0', MEMORY_MCP_TOKEN: 'test-token', ...extraEnv },
    stdio: false,
    logger: () => {},
  });
  const port = app.api.address?.port ?? 0;
  assert.ok(port > 0, '应拿到真实监听端口');
  try {
    return await fn({ app, token: 'test-token', port, dir });
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

test('HTTP：健康检查不需要令牌，业务路由需要，且健康检查暴露存储事实', async () => {
  await withApi(async ({ port }) => {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    // 降级与只读必须在这里可见：否则「悄悄用 JSON 兜底」没人知道。
    assert.equal(body.store.backend, 'sqlite');
    assert.equal(body.store.degraded, false);
    assert.equal(typeof body.store.schemaVersion, 'number');
    assert.equal(body.layersV2, true, '默认启用分层注入；关闭要显式设 MEMORY_LAYERS_V2=0');

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
    // 会话纪元模型：【记忆】单段拆为多 block（identity/long），此处无 subject → 只有长期块。
    assert.ok(names.includes('长期记忆'), `应含【长期记忆】块，实际：${names.join('、')}`);
    assert.ok(blocks.body.blocks[0].text.startsWith('【长期记忆】'));
  });
});

test('HTTP：分段注入 head 在断点内逐字节复用，invalidate 后重建', async () => {
  await withApi(async ({ port, token }) => {
    const auth = { 'x-mcp-token': token };
    await call(port, '/api/memory/append', { sessionId: SESSION, tier: 'long', content: '用户讨厌被敷衍', category: '画像' }, auth);

    const first = await call(port, '/api/context/compose', { sessionId: SESSION, body: '用户：在吗' }, auth);
    assert.equal(first.status, 200);
    assert.equal(first.body.head.rebuilt, true);
    assert.ok(first.body.text.includes('【长期记忆】'));
    assert.ok(first.body.text.endsWith('用户：在吗'), '本轮正文必须拼在末尾');

    const again = await call(port, '/api/context/compose', { sessionId: SESSION, body: '用户：还在吗' }, auth);
    assert.equal(again.body.head.rebuilt, false, '同一断点内不该重建');
    assert.equal(again.body.head.text, first.body.head.text, 'head 必须逐字节相同，否则前缀缓存作废');
    assert.ok(again.body.text.endsWith('用户：还在吗'));
    assert.ok(!again.body.text.includes('用户：在吗'), '上一轮正文不能残留');

    const reset = await call(port, '/api/context/invalidate', { sessionId: SESSION }, auth);
    assert.equal(reset.body.removed, true);
    const rebuilt = await call(port, '/api/context/head', { sessionId: SESSION }, auth);
    assert.equal(rebuilt.body.rebuilt, true);
    assert.equal(rebuilt.body.text, first.body.head.text, '内容没变，重建后字节仍应一致');
  });
});

test('HTTP：关系写入 / 读取 / 版本链，identity 默认被拒并带错误码', async () => {
  await withApi(async ({ port, token }) => {
    const auth = { 'x-mcp-token': token };
    const base = { sessionId: SESSION, subjectId: '10001', key: '称呼' };

    const first = await call(port, '/api/relation/upsert', { ...base, value: '老王' }, auth);
    assert.equal(first.status, 200);
    assert.equal(first.body.created, true);

    const second = await call(port, '/api/relation/upsert', { ...base, value: '王哥' }, auth);
    assert.equal(second.body.changed, true);

    const got = await call(port, '/api/relation/get', base, auth);
    assert.equal(got.body.value, '王哥');

    const chain = await call(port, '/api/relation/history', base, auth);
    assert.deepEqual(chain.body.rows.map((row) => row.value), ['老王', '王哥']);

    const denied = await call(port, '/api/relation/upsert', { ...base, value: '老王', scope: 'identity' }, auth);
    assert.equal(denied.status, 400);
    assert.equal(denied.body.code, 'relation_scope_disabled', '调用方要靠错误码区分「开关没开」和「参数写错」');
  });
});

test('HTTP：跨平台关系开关可配置（MEMORY_MCP_RELATION_IDENTITY=1）', async () => {
  await withApi(
    async ({ port, token }) => {
      const auth = { 'x-mcp-token': token };
      const out = await call(
        port,
        '/api/relation/upsert',
        { sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王', scope: 'identity' },
        auth,
      );
      assert.equal(out.status, 200);
      assert.equal(out.body.row.scope, 'identity');

      const head = await call(port, '/api/context/head', { sessionId: SESSION }, auth);
      assert.ok(!head.body.text.includes('老王'), 'identity 关系默认不参与渲染');
    },
    { MEMORY_MCP_RELATION_IDENTITY: '1' },
  );
});

test('HTTP：原始层积压可见，归档 dry-run 不落盘', async () => {
  await withApi(async ({ port, token }) => {
    const auth = { 'x-mcp-token': token };
    const old = Date.now() - 40 * DAY;
    const ingested = await call(port, '/api/memory/ingest', { sessionId: SESSION, msgId: 'h1', senderId: 'u1', text: '四十天前的话', createdAt: old }, auth);
    assert.equal(ingested.status, 200);
    assert.ok(ingested.body.anchor, 'ingest 必须返回锚点');

    const backlog = await call(port, '/api/raw/backlog', { days: 30 }, auth);
    assert.equal(backlog.body.rows, 1);

    const dry = await call(port, '/api/raw/archive', { days: 30, dryRun: true }, auth);
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dryRun, true);
    assert.equal(dry.body.backlog, 1);
    assert.equal(fs.existsSync(dry.body.files[0].path), false, 'dry-run 不该写盘');
  });
});

test('HTTP：record 幂等，召回默认只查本平台并如实标注降级', async () => {
  await withApi(async ({ port, token }) => {
    const auth = { 'x-mcp-token': token };
    const first = await call(port, '/api/memory/record', { sessionId: SESSION, content: '用户讨厌被敷衍', subjectId: '10001' }, auth);
    assert.equal(first.status, 200);
    assert.equal(first.body.created, true);
    const again = await call(port, '/api/memory/record', { sessionId: SESSION, content: '用户讨厌被敷衍', subjectId: '10001' }, auth);
    assert.equal(again.body.created, false, '同内容重复上报不该堆出第二条');

    const hit = await call(port, '/api/recall', { sessionId: SESSION, text: '敷衍' }, auth);
    assert.equal(hit.status, 200);
    assert.equal(hit.body.scope, 'platform');
    assert.equal(hit.body.rows.length, 1);
    assert.ok(hit.body.text.startsWith('- '), '返回的 text 应可直接拼进【召回】段');

    const denied = await call(port, '/api/recall', { sessionId: SESSION, text: '敷衍', platforms: ['wx'] }, auth);
    assert.equal(denied.body.downgraded, true);
    assert.deepEqual(denied.body.platforms, ['qq']);
  });
});

test('灰度：MEMORY_LAYERS_V2=0 时新路由整组 404，旧接口照常可用', async () => {
  await withApi(
    async ({ port, token }) => {
      const auth = { 'x-mcp-token': token };
      const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      assert.equal(health.layersV2, false);

      for (const route of [
        '/api/context/head',
        '/api/context/compose',
        '/api/memory/ingest',
        '/api/memory/record',
        '/api/relation/list',
        '/api/raw/backlog',
        '/api/recall',
      ]) {
        const res = await call(port, route, { sessionId: SESSION }, auth);
        assert.equal(res.status, 404, `${route} 应随开关关闭（拿到 404 桥接才会回落旧接口）`);
      }

      // 旧接口必须原样保留：关闭开关等价于「这套还没上线」，而不是服务降级。
      const blocks = await call(port, '/api/blocks/render', { sessionId: SESSION }, auth);
      assert.equal(blocks.status, 200);
      const appended = await call(port, '/api/memory/append', { sessionId: SESSION, content: '回退路径仍然可写' }, auth);
      assert.equal(appended.status, 200);
    },
    { MEMORY_LAYERS_V2: '0' },
  );
});

test('HTTP：参数不合法时返回明确错误与错误码，不静默成功', async () => {
  await withApi(async ({ port, token }) => {
    const auth = { 'x-mcp-token': token };
    const bad = await call(port, '/api/memory/append', { sessionId: 'not-a-session-id', content: 'x' }, auth);
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.includes('三段式'), `错误信息应说明原因，实际：${bad.body.error}`);
    assert.equal(bad.body.code, 'bad_request');
  });
});

test('HTTP：未知路由 404', async () => {
  await withApi(async ({ port, token }) => {
    const res = await call(port, '/api/nope', {}, { 'x-mcp-token': token });
    assert.equal(res.status, 404);
  });
});

/** 起一个 stdio 子进程，按 JSON-RPC 行协议收发；返回按 id 索引的响应。 */
async function mcpSession(requests, { timeoutMs = 8000 } = {}) {
  const dir = tmpState();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MEMORY_MCP_STATE_DIR: dir, MEMORY_MCP_HTTP_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'iface-test', version: '1.0.0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const request of requests) send(request);

  const lastId = requests.at(-1)?.id;
  const deadline = Date.now() + timeoutMs;
  const text = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const joined = stdout.join('');
      if (joined.includes(`"id":${lastId}`)) {
        clearInterval(timer);
        resolve(joined);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        resolve(joined);
      }
    }, 100);
  });
  child.kill();

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
  return { payloads, stdout: text, stderr: stderr.join(''), byId: new Map(payloads.map((item) => [item.id, item])) };
}

test('stdio MCP：能握手，暴露约定工具，且工具能真正执行', async () => {
  const { payloads, stderr, byId } = await mcpSession([
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory_append', arguments: { sessionId: SESSION, tier: 'long', content: '用户讨厌被敷衍', category: '画像' } },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'memory_context_compose', arguments: { sessionId: SESSION, body: '用户：在吗' } },
    },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'relation_set', arguments: { sessionId: SESSION, subjectId: '10001', key: '称呼', value: '老王' } },
    },
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'raw_backlog', arguments: { days: 30 } },
    },
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'memory_record', arguments: { sessionId: SESSION, content: '用户讨厌被敷衍', subjectId: '10001' } },
    },
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'memory_recall', arguments: { sessionId: SESSION, text: '讨厌被敷衍' } },
    },
  ]);

  assert.ok(payloads.some((item) => item.result?.protocolVersion), `握手应返回结果，实际输出：${stdoutSlice(payloads)}`);
  const listPayload = payloads.find((item) => Array.isArray(item.result?.tools));
  assert.ok(listPayload, `应返回工具列表，stderr：${stderr.slice(0, 300)}`);
  const names = listPayload.result.tools.map((tool) => tool.name).sort();
  for (const expected of [
    'memory_append',
    'memory_query',
    'memory_touch',
    'memory_forget',
    'memory_restore',
    'memory_consolidate',
    'memory_ingest',
    'memory_record',
    'memory_recall',
    'memory_context_head',
    'memory_context_tail',
    'memory_context_compose',
    'memory_context_invalidate',
    'memory_context_render',
    'slang_discover',
    'slang_submit',
    'slang_query',
    'slang_confirm',
    'slang_reject',
    'relation_set',
    'relation_get',
    'relation_list',
    'relation_history',
    'relation_forget',
    'raw_archive',
    'raw_purge',
    'raw_backlog',
  ]) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}，实际：${names.join('、')}`);
  }

  // tools/list 只能证明名字在，不能证明能跑：这里真的调一次，走完整个执行路径。
  const appended = toolResult(byId.get(3));
  assert.ok(appended.id, `memory_append 应返回行 id，实际：${JSON.stringify(appended)}`);

  const composed = toolResult(byId.get(4));
  assert.ok(composed.text.includes('【长期记忆】'), `compose 应带稳定前缀，实际：${composed.text?.slice(0, 200)}`);
  assert.ok(composed.text.endsWith('用户：在吗'));

  const relation = toolResult(byId.get(5));
  assert.equal(relation.row.value, '老王');
  assert.equal(relation.row.scope, 'session');

  const backlog = toolResult(byId.get(6));
  assert.equal(typeof backlog.rows, 'number');

  const recorded = toolResult(byId.get(7));
  assert.equal(recorded.created, true);
  assert.equal(recorded.memory.tier, 'long');

  const recalled = toolResult(byId.get(8));
  assert.equal(recalled.scope, 'platform');
  assert.ok(recalled.rows.length >= 1, `召回应命中刚写入的内容，实际：${JSON.stringify(recalled)}`);
  assert.ok(recalled.text.includes('敷衍'));
});

function toolResult(payload) {
  assert.ok(payload, '缺少对应的工具响应');
  assert.ok(!payload.error, `工具调用失败：${JSON.stringify(payload.error)}`);
  const text = payload.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', `工具应返回 text content，实际：${JSON.stringify(payload.result)}`);
  return JSON.parse(text);
}

function stdoutSlice(payloads) {
  return JSON.stringify(payloads).slice(0, 300);
}
