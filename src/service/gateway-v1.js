// 网关接入面：POST /v1/tools/call（tool.call 统一改造后的唯一服务间信封）。
//
// service.call 已全链路下线：记忆段注入（chat_memory_get，decorator）与会话缓冲
// 落地（chat_memory_save）都走 tool.call 信封——网关管线步骤与 ToolHost 工具
// 转发共用同一端点、同一信封、同一鉴权。桥接（qq-bridge 等）继续走 /api/*。
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
    throw new Error('createGatewayAuth 需要至少 16 字符的网关共享密钥（来自仓库根目录 gateway.json 的 secret / secretFile）');
  }
  // serviceId 可选：不设则不比对 x-adapter-id（密钥仍是唯一凭据；设了更严——
  // 防止把给别的服务的请求拿到这里重放）。
  const seen = new Map();
  // 密钥可热轮换（gateway.json 热加载）：HMAC 与 id 比对都读当前值，构造期
  // 校验只管首份；rotate 时同样 fail-closed（非法密钥拒收，保留旧值）。
  let currentSecret = secret;
  let currentServiceId = serviceId;
  const sha256Hex = (body) => createHash('sha256').update(body ?? '', 'utf8').digest('hex');
  const hmacHex = (payload) => createHmac('sha256', currentSecret).update(payload, 'utf8').digest('hex');

  function prune(at) {
    // 2026-11-21 audit fix: while forward-scan (no monotonic assumption).
    while (seen.size > 0) {
      const [firstKey, firstExpires] = seen.entries().next().value;
      if (firstExpires > at) break;
      seen.delete(firstKey);
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
      if (currentServiceId && id !== currentServiceId) throw new GatewayAuthError('登记身份不匹配');
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

    /**
     * 原地轮换凭据（gateway.json 热加载用）：换 secret / serviceId，防重放
     * nonce 表保留（窗口内旧 nonce 依然不能重放）。非法新值整体拒收。
     */
    rotate({ secret: nextSecret, serviceId: nextServiceId }) {
      if (typeof nextSecret !== 'string' || nextSecret.length < 16) {
        throw new Error('rotate 需要至少 16 字符的网关共享密钥');
      }
      currentSecret = nextSecret;
      currentServiceId = nextServiceId;
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
 * @param {object} [deps.subject] subject 身份层（名字 → subjectId 解析）
 * @param {object} [deps.sessionSave] save 编排（chat_memory_save 唯一落地路径）
 * @param {Function} [deps.logger]
 */
export function createGatewayV1({ auth, memory, recall, subject, sessionSave, logger } = {}) {
  const log = logger ?? (() => {});

  // ── 工具面：chat_memory_* → 内部 service 方法（与 /api/* 同一实现，不复制业务）──
  // sessionKey 与 memory-mcp 的 sessionId 同为 platform:scope:id 三段式，可直接映射。
  //
  // 安全边界（2026-11-09 修正）：工具参数由**模型生成**，提示注入可以让它塞任意
  // sessionId —— 因此这里一律以 ctx.sessionKey（网关从 turn 上下文注入）为准，
  // 忽略 args.sessionId。需要跨会话运维时走 /api/*（本机 token 通道），不走工具面。
  // ctx：{ sessionKey, senderId?, text? } —— senderId 来自网关 context（在和谁对话），
  // text 仅 filter 步骤下发（memory 无 filter 工具，不消费）。
  const tools = {
    // ── decorator 步骤（网关管线编排；args 恒 {}，行为由 context 决定）───────
    chat_memory_get: async (_args, ctx) => {
      const sessionKey = requireText(ctx?.sessionKey, 'sessionKey', 256);
      const subjectId = typeof ctx?.senderId === 'string' && ctx.senderId.trim()
        ? ctx.senderId.trim().slice(0, 120) : '';
      try {
        const rendered = memory.render({ sessionId: sessionKey, subjectId });
        // decorator 结果契约（tool.call 统一改造）：{ sections, epoch }——
        // 纯注入，无改写无丢弃（改写/丢弃职责归 filter）。identity 块高优先级
        //（预算超限时网关整段丢最低优先级——人格信息优先于长期碎片）。
        const sections = (rendered?.blocks ?? [])
          .filter((block) => typeof block?.text === 'string' && block.text.trim())
          .map((block) => ({
            name: block.name,
            text: block.text,
            priority: block.kind === 'identity' ? 90 : 50,
          }));
        return { sections, epoch: rendered?.epoch ?? null };
      } catch (error) {
        // 宁放行不误杀：装饰失败等价于「本轮没有记忆段」，网关管线同样 fail-safe。
        log(`chat_memory_get 装饰失败（放行）：${error?.message ?? error}`);
        return { sections: [], epoch: null };
      }
    },

    // ── tool 步骤（模型可调 / 网关 session-save 直投）──────────────────────
    chat_memory_save: async (args, ctx) => {
      if (!sessionSave) throw new Error('session-save 编排未装配（检查 server.mjs）');
      const sessionKey = requireText(ctx?.sessionKey, 'sessionKey', 256);
      // sessionKey 强制取 ctx（防提示注入指定别的会话落地）；partial 由网关触顶
      // 分段语义给出。整段缓冲 messages 形状见 service/session-save.js。
      const messages = Array.isArray(args?.messages) ? args.messages : [];
      if (messages.length === 0) throw new Error('chat_memory_save 需要 messages 数组（整段缓冲）');
      return sessionSave.save({ sessionKey, messages, partial: args?.partial === true });
    },
    chat_memory_recall: (args, ctx) => {
      if (!recall) throw new Error('recall 服务未装配（检查 server.mjs）');
      const sessionKey = requireText(ctx?.sessionKey, 'sessionKey');
      // subjectId 支持按名字解析（subject 身份层：群名片 → 全局昵称）；解析不到
      // 按原样处理（可能是调用方直接传的稳定 id）。
      let subjectId = args.subjectId;
      if (subjectId && subject) {
        subjectId = subject.resolve({ sessionId: sessionKey, alias: subjectId }) ?? subjectId;
      }
      return recall.recall({
        sessionId: sessionKey,
        text: String(args.text ?? ''),
        kinds: args.kinds,
        subjectId,
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
  };

  /** 工具调用（唯一信封）：业务失败以 ok:false 正常返回（HTTP 仍 200），网关原样透传。 */
  async function toolsCall(request) {
    if (request.v !== 1) throw new Error('tool.call 只支持 v=1');
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
    const context = request.context && typeof request.context === 'object' ? request.context : {};
    const ctx = {
      sessionKey: request.sessionKey,
      senderId: context.senderId,
      text: context.text,
    };
    try {
      const data = await handler(args, ctx);
      return { v: 1, callId: request.callId, ok: true, data };
    } catch (error) {
      log(`tools.call ${tool} 业务失败：${error?.message ?? error}`);
      return {
        v: 1, callId: request.callId, ok: false,
        error: { code: 'E_ACTION', message: String(error?.message ?? error) },
      };
    }
  }

  // ── 工具清单（GET /v1/tools；控制台「拉取清单预填」的数据源）────────────────
  // 与上方 tools 分发表同源：增删工具必须同步维护本清单。role 是网关视角的
  // 参考预填值（decorator=可进管线编排；登记文件里最终 role 由操作者确认）。
  const TOOL_MANIFEST = [
    { name: 'chat_memory_get', role: 'decorator', description: '按会话与对话对象渲染长期记忆为管线注入块（identity 高优先级）', inputSchema: { type: 'object' } },
    { name: 'chat_memory_save', role: 'tool', description: '会话缓冲落库：规整消息、窗口哈希幂等、LLM 自动提取摘要/画像/关系', inputSchema: { type: 'object' } },
    { name: 'chat_memory_recall', role: 'tool', description: '按查询意图检索长期记忆条目（话题/偏好/关系召回）', inputSchema: { type: 'object' } },
    { name: 'chat_memory_record', role: 'tool', description: '写入单条长期记忆（显式「记住某件事」路径）', inputSchema: { type: 'object' } },
    { name: 'chat_memory_forget', role: 'tool', description: '删除指定的长期记忆条目', inputSchema: { type: 'object' } },
  ];

  const endpoints = new Map([
    ['/v1/tools/call', (request) => toolsCall(request)],
    // GET /v1/tools：只读工具清单（rawBody 为空 → request={}，invoke 的对象检查天然通过）。
    ['/v1/tools', () => ({ ok: true, tools: TOOL_MANIFEST })],
  ]);

  /**
   * 分发（已鉴权的请求体）：HTTP 入口 handle 验签后进入；单独导出供测试直连。
   * WS 帧入口已退役（传输按角色非对称：资源服务只走 HTTP tool.call）。
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

    /** 分发入口：不重复验签（验签在 handle），供 HTTP handle 与测试使用。 */
    invoke,

    /**
     * HTTP 层入口：验签 → 解析 → 分发。永不 throw（错误已翻译成状态码）；
     * 只有编程错误（auth 缺失等）会上抛，由 http-api 的外层 catch 兜底。
     * @returns {Promise<{status: number, body: object}>}
     */
    async handle({ path, headers, rawBody }) {
      if (!auth) return { status: 503, body: { error: '网关接入未配置（仓库根目录缺少 gateway.json）' } };
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
