// 仅回环的 HTTP 接口：给平台桥接（qq-bridge 等）调用。
//
// 为什么除了 stdio 还要这个：DSH 是 MCP 客户端，走 stdio 天然合适；
// 但平台桥接是普通 Node 进程，为它再接一套 MCP client 要引入客户端 + 进程管理 + 重连，
// 成本高于收益。于是同一层 service 同时挂两种入口，业务实现不重复。
//
// 安全边界（与 qq-bridge 控制台 127.0.0.1:7187 同一级别）：
//   - 只监听 127.0.0.1
//   - 非回环来源直接 403（防止被端口转发暴露到局域网）
//   - 除 /api/health 外都要带本地令牌
import http from 'node:http';
import { createRequire } from 'node:module';

// 健康检查要报版本号：直接读包自身的 package.json，避免再维护一份常量。
const PKG_VERSION = createRequire(import.meta.url)('../package.json').version ?? '0.0.0';

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function json(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大（上限 1MB）');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

export function createHttpApi({ memory, slang, token, host = '127.0.0.1', port = 7181, logger } = {}) {
  const log = logger ?? (() => {});
  const startedAt = Date.now();
  const routes = new Map([
    ['/api/memory/append', (args) => memory.append(args)],
    ['/api/memory/query', (args) => memory.query(args)],
    ['/api/memory/touch', (args) => memory.touch(args)],
    ['/api/memory/forget', (args) => memory.forget(args)],
    ['/api/memory/restore', (args) => memory.restore(args)],
    ['/api/memory/consolidate', (args) => memory.consolidate(args)],
    ['/api/slang/discover', (args) => slang.discover(args)],
    ['/api/slang/absorb', (args) => slang.absorb(args)],
    ['/api/slang/submit', (args) => slang.submit(args)],
    ['/api/slang/query', (args) => slang.query(args)],
    ['/api/slang/confirm', (args) => slang.confirm(args)],
    ['/api/slang/reject', (args) => slang.reject(args)],
    ['/api/blocks/render', (args) => {
      const memoryBlocks = memory.render({ sessionId: args.sessionId, maxChars: args.maxChars }).blocks;
      const slangBlocks = slang.render({ maxChars: args.slangMaxChars, includeCandidates: false }).blocks;
      return { blocks: [...memoryBlocks, ...slangBlocks] };
    }],
    ['/api/stats', () => ({ memory: memory.stats(), slang: slang.stats() })],
  ]);

  const server = http.createServer(async (req, res) => {
    try {
      const remote = req.socket?.remoteAddress ?? '';
      if (!LOOPBACK.has(remote)) {
        json(res, 403, { error: '仅允许本机回环访问' });
        return;
      }
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/api/health') {
        // 部署验收用的最小事实集：版本、pid、端口、成活时长。不含业务内容，所以免令牌。
        json(res, 200, {
          ok: true,
          service: 'memory-mcp',
          version: PKG_VERSION,
          pid: process.pid,
          port: server.address()?.port ?? port,
          uptimeMs: Date.now() - startedAt,
          stats: memory.stats(),
        });
        return;
      }
      if (token && req.headers['x-mcp-token'] !== token && req.headers.authorization !== `Bearer ${token}`) {
        json(res, 401, { error: '缺少或错误的本地令牌' });
        return;
      }
      const handler = routes.get(path);
      if (!handler) {
        json(res, 404, { error: `未知路由：${path}` });
        return;
      }
      if (req.method !== 'POST' && req.method !== 'GET') {
        json(res, 405, { error: `不支持的方法：${req.method}` });
        return;
      }
      const args = req.method === 'POST' ? await readBody(req) : Object.fromEntries(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams);
      json(res, 200, await handler(args));
    } catch (error) {
      // 失败必须说清楚：桥接要靠这个错误决定降级还是报错给 AI，不能返回假成功。
      log(`[memory-mcp] HTTP 处理失败：${error?.message ?? error}`);
      json(res, 400, { error: String(error?.message ?? error) });
    }
  });

  const api = {
    port,
    host,
    address: null,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        // 端口传 0 时由系统分配，真实端口只能从 address() 拿（测试要用）。
        server.listen(port, host, () => {
          api.address = server.address();
          resolve(api.address);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}
