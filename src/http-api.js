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

/**
 * 错误 → (状态码, 错误码)。
 *
 * 原则：状态码告诉调用方「能不能重试」，错误码告诉调用方「该修什么」。
 * 只读库重试也没用（503），参数错要改调用（400），其余一律 400 —— 保持与既有桥接的兼容，
 * 桥接只看 res.ok，加字段不会让老客户端误判。
 */
function classify(error) {
  switch (error?.name) {
    case 'StoreReadOnlyError':
      return { status: 503, code: 'store_read_only' };
    case 'StoreUnavailableError':
      return { status: 503, code: 'store_unavailable' };
    case 'RelationScopeError':
      return { status: 400, code: 'relation_scope_disabled' };
    case 'UnknownPlatformError':
      return { status: 400, code: 'unknown_platform' };
    case 'TypeError':
      return { status: 400, code: 'invalid_argument' };
    default:
      return { status: 400, code: 'bad_request' };
  }
}

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

/** /v1 端点专用：返回原始 body 文本（HMAC 签名必须对原始字节算，不能对重序列化对象算）。 */
async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大（上限 1MB）');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHttpApi({
  memory,
  slang,
  relation,
  raw,
  recall,
  profile,
  guard,
  info,
  token,
  // 网关 V2 接入面（createGatewayV1 产物）：/v1/service/call + /v1/tools/call。
  // 未传 = 两个端点不存在（404），桥接与 DSH 的既有路径不受影响。
  gateway,
  host = '127.0.0.1',
  port = 7181,
  // 分层注入（head/tail、原始层、关系、召回）的灰度开关。关闭时这些路由**不注册**：
  // 桥接拿到 404 就知道「这套还没上线」，会回落旧接口，而不是收到空结果以为「记忆是空的」。
  layersV2 = true,
  logger,
} = {}) {
  const log = logger ?? (() => {});
  const startedAt = Date.now();
  // 未装配的服务在路由里显式报错：静默 404 会让人以为「这条路由不存在」，排查会跑错方向。
  const need = (name, service) => {
    if (!service) throw new Error(`${name} 服务未装配（检查 server.mjs 的装配）`);
    return service;
  };
  // 旧接口（G1 行为）：无论灰度开关如何都在 —— 桥接的熔断回落依赖它们。
  const routes = new Map([
    ['/api/memory/append', (args) => memory.append(args)],
    ['/api/memory/query', (args) => memory.query(args)],
    ['/api/memory/touch', (args) => memory.touch(args)],
    ['/api/memory/forget', (args) => memory.forget(args)],
    ['/api/memory/restore', (args) => memory.restore(args)],
    ['/api/memory/consolidate', (args) => memory.consolidate(args)],
    ['/api/slang/discover', (args) => slang.discover(args)],
    ['/api/slang/submit', (args) => slang.submit(args)],
    ['/api/slang/query', (args) => slang.query(args)],
    ['/api/slang/confirm', (args) => slang.confirm(args)],
    ['/api/slang/reject', (args) => slang.reject(args)],
    ['/api/slang/explain', (args) => slang.explain(args)],
    ['/api/slang/remove', (args) => slang.remove(args)],
    ['/api/blocks/render', (args) => {
      const memoryBlocks = memory.render({ sessionId: args.sessionId, maxChars: args.maxChars }).blocks;
      const slangBlocks = slang.render({ maxChars: args.slangMaxChars, includeCandidates: false }).blocks;
      return { blocks: [...memoryBlocks, ...slangBlocks] };
    }],
    ['/api/stats', () => ({ memory: memory.stats(), slang: slang.stats(), ...(info ?? {}) })],
  ]);

  // 分层注入（V2）的接口：`MEMORY_LAYERS_V2=0` 时整组不注册。
  const v2Routes = new Map([
    ['/api/memory/ingest', (args) => memory.ingest(args)],
    ['/api/memory/record', (args) => memory.record(args)],
    // 主动召回：默认只查本平台，跨平台要看 MEMORY_MCP_RECALL_CROSS_PLATFORM。
    ['/api/recall', (args) => need('recall', recall).recall(args)],
    // 分段注入：head 在断点之间字节稳定（可复用前缀缓存），tail 每轮新拼。
    ['/api/context/head', (args) => memory.renderHead(args)],
    ['/api/context/tail', (args) => memory.renderTail(args)],
    ['/api/context/compose', (args) => memory.compose(args)],
    ['/api/context/invalidate', (args) => memory.invalidateHead(args)],
    ['/api/relation/upsert', (args) => need('relation', relation).upsert(args)],
    ['/api/relation/get', (args) => need('relation', relation).get(args)],
    ['/api/relation/list', (args) => need('relation', relation).list(args)],
    ['/api/relation/history', (args) => need('relation', relation).history(args)],
    ['/api/relation/forget', (args) => need('relation', relation).forget(args)],
    // relation 自动运维的人工确认面 + 每日体检（守卫只读、accept 才落库）。
    ['/api/relation/pending', (args) => need('guard', guard).listPending(args)],
    ['/api/relation/accept', (args) => need('guard', guard).accept(args)],
    ['/api/relation/reject', (args) => need('guard', guard).reject(args)],
    ['/api/relation/audit', (args) => need('guard', guard).audit(args)],
    // 人物画像：merge（摘要口径，未提及保留）/ replace（运维整份覆盖）/ 版本链 / 回滚 / 被遗忘权。
    ['/api/profile/get', (args) => need('profile', profile).get(args.sessionId, args.subjectId)],
    ['/api/profile/list', (args) => need('profile', profile).list(args.sessionId)],
    ['/api/profile/history', (args) => need('profile', profile).history(args.sessionId, args.subjectId, args)],
    ['/api/profile/merge', (args) => need('profile', profile).merge(args)],
    ['/api/profile/replace', (args) => need('profile', profile).replace(args)],
    ['/api/profile/rollback', (args) => need('profile', profile).rollback(args)],
    ['/api/profile/forget', (args) => need('profile', profile).forget(args)],
    ['/api/raw/archive', (args) => need('raw', raw).archive(args)],
    ['/api/raw/purge', (args) => need('raw', raw).purge(args)],
    ['/api/raw/backlog', (args) => need('raw', raw).backlog(args)],
    ['/api/raw/archives', (args) => need('raw', raw).listArchives(args)],
  ]);
  if (layersV2) {
    for (const [path, handler] of v2Routes) routes.set(path, handler);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const remote = req.socket?.remoteAddress ?? '';
      if (!LOOPBACK.has(remote)) {
        json(res, 403, { error: '仅允许本机回环访问' });
        return;
      }
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      // 网关 V2 端点：验签要原始 body，所以先于通用 readBody 分支（不走 x-mcp-token 通道）。
      if (gateway && (path === '/v1/service/call' || path === '/v1/tools/call')) {
        if (req.method !== 'POST') {
          json(res, 405, { error: `不支持的方法：${req.method}` });
          return;
        }
        const rawBody = await readRawBody(req);
        const { status, body } = await gateway.handle({ path, headers: req.headers, rawBody });
        json(res, status, body);
        return;
      }
      if (path === '/api/health') {
        // 部署验收用的最小事实集：版本、pid、端口、成活时长、存储后端与降级状态。
        // 不含业务内容，所以免令牌；降级信息必须在这里可见，否则「悄悄用 JSON 兜底」没人发现。
        json(res, 200, {
          ok: true,
          service: 'memory-mcp',
          version: PKG_VERSION,
          pid: process.pid,
          port: server.address()?.port ?? port,
          uptimeMs: Date.now() - startedAt,
          store: info ?? {},
          // 灰度开关必须可见：否则「新接口 404」会被当成代码坏了去查。
          layersV2: Boolean(layersV2),
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
      const { status, code } = classify(error);
      log(`[memory-mcp] HTTP 处理失败（${code}）：${error?.message ?? error}`);
      json(res, status, { error: String(error?.message ?? error), code });
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
