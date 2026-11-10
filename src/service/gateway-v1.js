// 网关 V2 P3 接入面：POST /v1/service/call（装饰器契约）+ POST /v1/tools/call（工具调用契约）。
//
// 这两个端点只服务于 agent-gateway（V2 管线）：memory-mcp 以「自主登记的装饰器
// 服务」身份接入网关管线——记忆段注入走 service.call，模型侧的 chat_memory_*
// 工具调用经网关 ToolHost 转发到 tools.call。桥接（qq-bridge 等）继续走 /api/*。
//
// 鉴权：网关出站 HMAC（agent-gateway auth.mjs v1 格式，与桥接的 x-mcp-token 并存、
// 互不替代）：
//   x-adapter-id: <登记 hash id>（网关把登记 id 当 adapterId 签进头里）
//   x-timestamp:  毫秒
//   x-nonce:      随机串（带 LRU 防重放缓存）
//   x-signature:  v1=<hex hmac_sha256(secret, ts + "\n" + nonce + "\n" + sha256(rawBody))>
// 先对原始 body 做 sha256 再进 HMAC（与网关同一公式，签名计算与 body 大小无关）。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class GatewayAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayAuthError';
  }
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 网关请求验签器。secret 与网关登记文件里的 secret 同源（secretEnv 注入）；
 * serviceId 必须等于登记文件 id（网关签的 x-adapter-id 就是它）。
 */
export function createGatewayAuth({
  secret,
  serviceId,
  now = Date.now,
  windowMs = 5 * 60 * 1000,
  capacity = 100_000,
} = {}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('createGatewayAuth 需要至少 16 字符的网关共享密钥（MEMORY_MCP_GATEWAY_SECRET）');
  }
  // serviceId 可选：不设则不比对 x-adapter-id（密钥仍是唯一凭据；设了更严——
  // 防止把给别的服务的请求拿到这里重放）。
  const seen = new Map();
  const sha256Hex = (body) => createHash('sha256').update(body ?? '', 'utf8').digest('hex');
  const hmacHex = (payload) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  function prune(at) {
    for (const [, expiresAt] of seen) {
      if (expiresAt > at) break;
      seen.delete(seen.keys().next().value);
    }
    while (seen.size > capacity) seen.delete(seen.keys().next().value);
  }

  return {
    /** 抛 GatewayAuthError = 401；通过返回 { serviceId }。 */
    verify({ headers, rawBody }) {
      const id = headers['x-adapter-id'];
      const tsRaw = headers['x-timestamp'];
      const nonce = headers['x-nonce'];
      const sigRaw = headers['x-signature'];
      if (!id || !tsRaw || !nonce || !sigRaw) throw new GatewayAuthError('缺少网关签名头');
      if (serviceId && id !== serviceId) throw new GatewayAuthError('登记身份不匹配');
      const ts = Number(tsRaw);
      if (!Number.isSafeInteger(ts) || Math.abs(now() - ts) > windowMs) {
        throw new GatewayAuthError('时间戳超出重放窗口');
      }
      // 先验签名、再消费 nonce：签名错的请求不烧 nonce（与网关入站鉴权同一顺序）。
      const expected = hmacHex(`${ts}\n${nonce}\n${sha256Hex(rawBody)}`);
      if (!sigRaw.startsWith('v1=') || !safeEqualHex(sigRaw.slice(3), expected)) {
        throw new GatewayAuthError('签名不匹配');
      }
      prune(now());
      const key = `${id}:${nonce}`;
      if (seen.has(key)) throw new GatewayAuthError('nonce 已使用（疑似重放）');
      seen.set(key, now() + windowMs);
      return { serviceId: id };
    },
  };
}

function requireText(value, field, max = 256) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  if (value.length > max) throw new Error(`${field} 过长（上限 ${max}）`);
  return value;
}

/**
 * /v1 端点路由。
 *
 * @param {object} deps
 * @param {object} deps.auth     createGatewayAuth 产物
 * @param {object} [deps.memory] memory service（record / forget / render）
 * @param {object} [deps.recall] recall router（recall）
 * @param {object} [deps.profile] profile service（chat_memory_profile 只读）
 * @param {object} [deps.relation] relation service（chat_memory_relation 只读）
 * @param {Function} [deps.logger]
 */
const PROFILE_FIELD_LABELS = { personality: '性格', speakingStyle: '说话风格', catchphrases: '口头禅', taboos: '禁忌', relation: '关系定位' };

export function createGatewayV1({ auth, memory, recall, profile, relation, logger } = {}) {
  const log = logger ?? (() => {});

  // ── 工具面：chat_memory_* → 内部 service 方法（与 /api/* 同一实现，不复制业务）──
  // sessionKey 与 memory-mcp 的 sessionId 同为 platform:scope:id 三段式，可直接映射。
  //
  // 安全边界（2026-11-09 修正）：工具参数由**模型生成**，提示注入可以让它塞任意
  // sessionId —— 因此这里一律以 ctx.sessionKey（网关从 turn 上下文注入）为准，
  // 忽略 args.sessionId。需要跨会话运维时走 /api/*（本机 token 通道），不走工具面。
  const tools = {
    chat_memory_recall: (args, ctx) => {
      if (!recall) throw new Error('recall 服务未装配（检查 server.mjs）');
      return recall.recall({
        sessionId: requireText(ctx?.sessionKey, 'sessionKey'),
        text: String(args.text ?? ''),
        kinds: args.kinds,
        subjectId: args.subjectId,
        limit: args.limit,
      });
    },
    chat_memory_record: (args, ctx) => {
      requireText(args.content, 'content');
      return memory.record({
        sessionId: requireText(ctx?.sessionKey, 'sessionKey'),
        content: args.content,
        kind: args.kind,
        subjectId: args.subjectId,
        category: args.category,
        importance: args.importance,
        extra: args.extra,
      });
    },
    chat_memory_forget: (args, ctx) => {
      requireText(args.id, 'id');
      // 归属校验下沉到 memory.forget（防「知道 id 就能删别人会话」）。
      return memory.forget({
        id: args.id,
        mode: args.mode,
        sessionId: requireText(ctx?.sessionKey, 'sessionKey'),
      });
    },
    // ── 只读画像/关系工具（§6.4）：模型按需查「这个人是谁」，写入只走摘要守卫
    // 与 /api/*（工具面无任何写入口，防提示注入改写人设/关系）。
    chat_memory_profile: (args, ctx) => {
      if (!profile) throw new Error('profile 服务未装配（检查 server.mjs）');
      const sessionId = requireText(ctx?.sessionKey, 'sessionKey');
      const subjectId = requireText(args.subjectId, 'subjectId', 120);
      const doc = profile.get(sessionId, subjectId);
      const versions = profile.history(sessionId, subjectId, { limit: 3 });
      return {
        subjectId,
        profile: doc,
        versions: versions.map((item) => ({ version: item.version, changedAt: item.changedAt })),
        text: doc && Object.keys(doc.attributes ?? {}).length
          ? Object.entries(doc.attributes).map(([key, value]) => `- ${PROFILE_FIELD_LABELS[key] ?? key}：${Array.isArray(value) ? value.join('、') : value}`).join('\n')
          : '',
      };
    },
    chat_memory_relation: (args, ctx) => {
      if (!relation) throw new Error('relation 服务未装配（检查 server.mjs）');
      const sessionId = requireText(ctx?.sessionKey, 'sessionKey');
      const subjectId = requireText(args.subjectId, 'subjectId', 120);
      const rows = relation
        .list({ sessionId, subjectId, kind: args.kind, limit: Math.min(50, Math.max(1, Number(args.limit) || 20)) })
        .filter((row) => row.confidence == null || row.confidence >= 0.4); // 与渲染同一降权口径
      return {
        subjectId,
        rows,
        text: rows.length
          ? rows.map((row) => `- ${row.key}：${row.value}${row.confidence != null && row.confidence < 0.6 ? '（待确认）' : ''}`).join('\n')
          : '',
      };
    },
  };

  /**
   * 装饰器：会话纪元记忆注入。verdict 恒 pass（decorator 不表达丢弃），出错只记日志不阻塞。
   *
   * 多 block + epoch 契约：senderId（网关从 turn 上下文透传，即「在和谁对话」）
   * 决定 identity 块（画像+关系）；epoch 由服务端会话状态推进，网关按
   * (sessionKey, subjectId, epoch) 去重实现「会话首轮注入一次」。sections 里
   * 每项带 kind（identity=只在首轮 / long=首轮 + 可选按需），旧网关忽略 kind
   * 也能正常拼接（多注入几次是幂等无害的 at-least-once）。
   */
  async function serviceCall(request) {
    if (request.v !== 1) throw new Error('service.call 只支持 v=1');
    requireText(request.callId, 'callId');
    requireText(request.sessionKey, 'sessionKey', 256);
    try {
      const rendered = memory.render({
        sessionId: request.sessionKey,
        subjectId: typeof request.senderId === 'string' ? request.senderId.trim() : '',
        maxChars: Number.isSafeInteger(request.maxChars) ? request.maxChars : undefined,
      });
      const sections = (rendered?.blocks ?? [])
        .filter((block) => typeof block?.text === 'string' && block.text.trim())
        .map((block) => ({ name: block.name, text: block.text, priority: 0, kind: block.kind }));
      return { v: 1, callId: request.callId, verdict: 'pass', epoch: rendered?.epoch ?? null, sections };
    } catch (error) {
      // 宁放行不误杀：装饰失败等价于「本轮没有记忆段」，网关管线同样 fail-safe。
      log(`service.call 装饰失败（放行）：${error?.message ?? error}`);
      return { v: 1, callId: request.callId, verdict: 'pass', epoch: null, sections: [] };
    }
  }

  /** 工具调用：业务失败以 ok:false 正常返回（HTTP 仍 200），网关 ToolHost 原样透传。 */
  async function toolsCall(request) {
    if (request.v !== 1) throw new Error('tools.call 只支持 v=1');
    requireText(request.callId, 'callId');
    const tool = requireText(request.tool, 'tool', 128);
    const handler = tools[tool];
    if (!handler) {
      return {
        v: 1, callId: request.callId, ok: false,
        error: { code: 'E_UNSUPPORTED', message: `未知工具：${tool}（支持：${Object.keys(tools).join('、')}）` },
      };
    }
    const args = request.args && typeof request.args === 'object' ? request.args : {};
    try {
      const data = await handler(args, { sessionKey: request.sessionKey });
      return { v: 1, callId: request.callId, ok: true, data };
    } catch (error) {
      log(`tools.call ${tool} 业务失败：${error?.message ?? error}`);
      return {
        v: 1, callId: request.callId, ok: false,
        error: { code: 'E_ACTION', message: String(error?.message ?? error) },
      };
    }
  }

  const endpoints = new Map([
    ['/v1/service/call', (request) => serviceCall(request)],
    ['/v1/tools/call', (request) => toolsCall(request)],
  ]);

  /**
   * 分发（已鉴权的请求体）：HTTP 与 WS 两个入口共用。
   * 帧入口（ws-connector）不重复验签——握手即鉴权，且 secret 只有网关与本服务知道。
   */
  async function invoke({ path, request }) {
    const handler = endpoints.get(path);
    if (!handler) return { status: 404, body: { error: `未知路由：${path}` } };
    if (!request || typeof request !== 'object') return { status: 400, body: { error: '请求体必须是对象' } };
    try {
      return { status: 200, body: await handler(request) };
    } catch (error) {
      // 契约层错误（缺 callId 等）= 调用方要修的，400；带 callId 时尽量回传以便关联。
      const callId = typeof request?.callId === 'string' ? request.callId : undefined;
      log(`gateway-v1 ${path} 契约错误：${error?.message ?? error}`);
      return { status: 400, body: { error: String(error?.message ?? error), ...(callId ? { callId } : {}) } };
    }
  }

  return {
    /** 该服务的工具面清单（登记文件 tools[] 的服务端事实源）。 */
    toolNames: () => Object.keys(tools),

    /** WS 帧入口：不验签（握手即鉴权），直接分发。 */
    invoke,

    /**
     * HTTP 层入口：验签 → 解析 → 分发。永不 throw（错误已翻译成状态码）；
     * 只有编程错误（auth 缺失等）会上抛，由 http-api 的外层 catch 兜底。
     * @returns {Promise<{status: number, body: object}>}
     */
    async handle({ path, headers, rawBody }) {
      if (!auth) return { status: 503, body: { error: '网关接入未配置（MEMORY_MCP_GATEWAY_SECRET 未设置）' } };
      try {
        auth.verify({ headers, rawBody });
      } catch (error) {
        return { status: 401, body: { error: String(error?.message ?? error) } };
      }
      let request;
      try {
        request = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return { status: 400, body: { error: '请求体不是合法 JSON' } };
      }
      return invoke({ path, request });
    },
  };
}
