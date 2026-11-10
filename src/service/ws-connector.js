// 网关 WS 客户端连接器（V2 主线）：以「自主登记的装饰器服务」身份连入
// agent-gateway /v1/ws，收 service.call / tool.call 帧并就地应答。
//
// 为什么需要它：GATEWAY_V2_REFACTOR §2 的「WebSocket 为主、HTTP 备用」对装饰器/
// 过滤器服务方向 = 服务主动连入。网关侧 ws-hub 的 service.call / tool.call 帧协议
// 早在 P2/P3 就实现了（含 callId 请求-响应关联、心跳、断线清理），服务侧一直只有
// HTTP 被调用端（gateway-v1.js 的两个端点）——本文件补上连接器，让网关的
// transport=auto/ws 真正有 WS 通道可走。
//
// 边界：
//   - 业务零改动：帧到达后直接调 gateway-v1 暴露的 invoke（与 HTTP 入口同一组
//     serviceCall()/toolsCall() 处理函数），本文件只管连接生命周期与帧编解码；
//   - 鉴权：握手 query（adapterId/ts/nonce/sign，body 空串签名）——与 ws-hub
//     verifyHandshake 同公式；帧本身不再逐帧签名（secret 只有网关与本服务知道，
//     且这是「网关 → 服务」单向调用方向，与 qq-bridge 的 action 帧风险级别不同）；
//   - 断线指数退避重连（1s → 30s 封顶）；连接断开期间网关侧 service-registry
//     的 auto 判定自动回落 HTTP，服务无需自己切换。
//
// 与 rolecard-mcp 的同名文件是「互持同形副本」关系（两仓不引共享包，先例：
// gateway-v1.js 头注释）。协议一致性由两仓各自的 test-ws-connector.mjs 钉住。
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

function handshakeQuery({ serviceId, secret, now }) {
  const timestamp = now();
  const nonce = randomBytes(9).toString('hex');
  const bodyHash = createHash('sha256').update('', 'utf8').digest('hex');
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${bodyHash}`, 'utf8')
    .digest('hex');
  return new URLSearchParams({
    adapterId: String(serviceId),
    ts: String(timestamp),
    nonce,
    sign: `v1=${signature}`,
  });
}

/**
 * @param {object} options
 * @param {string} options.url       网关基址（http://127.0.0.1:8787，内部转 ws）
 * @param {string} options.serviceId 登记文件 id（32 位 hash）
 * @param {string} options.secret    与登记文件同源的网关共享密钥
 * @param {'ws'|'auto'} [options.transport] 连接器口径（权威选路在网关 service-registry）
 * @param {(args:{path:string, request:object}) => Promise<{status:number, body:object}>} options.invoke
 *        gateway-v1 的免验签分发入口（方法名 `invoke`；本文件没有 handleFrame）
 * @param {number} [options.handshakeTimeoutMs] 握手看门狗（默认 10s）
 * @param {(line:string)=>void} [options.logger]
 * @param {Function} [options.now]
 * @param {Function} [options.wsImpl] 测试注入（默认 ws 包）
 */
export function createGatewayWsConnector({
  url,
  serviceId,
  secret,
  transport = 'auto',
  invoke,
  logger = () => {},
  now = Date.now,
  wsImpl = WebSocket,
  reconnectMinMs = RECONNECT_MIN_MS,
  reconnectMaxMs = RECONNECT_MAX_MS,
  // 握手看门狗：401/半开握手时 ws 包不保证发 close，没有上限会永久停在这个状态。
  handshakeTimeoutMs = 10_000,
} = {}) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('gateway ws 需要 url（如 http://127.0.0.1:8787）');
  if (!serviceId) throw new Error('gateway ws 需要登记 id（MEMORY_MCP_GATEWAY_ID）');
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('gateway ws 需要至少 16 字符的共享密钥');
  if (transport !== 'ws' && transport !== 'auto') {
    throw new Error(`gateway.transport 只支持 ws|auto（got "${transport}"）——非法值启动即失败`);
  }
  if (typeof invoke !== 'function') throw new TypeError('gateway ws connector requires an invoke() function');

  const base = String(url).trim().replace(/\/+$/, '');
  const endpoint = `${base.replace(/^http/i, 'ws')}/v1/ws`;

  let socket = null;
  let open = false;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer = null;

  function send(payload) {
    if (!socket || !open) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      logger(`gateway ws send failed: ${error?.message ?? error}`);
      return false;
    }
  }

  async function answerServiceCall(message) {
    const { type: _type, ...request } = message;
    try {
      const { status, body } = await invoke({ path: '/v1/service/call', request });
      const ok = status === 200 && body && !body.error;
      if (ok) {
        send({ v: 1, type: 'service.call/result', callId: message.callId, ok: true, result: body });
      } else {
        send({
          v: 1, type: 'service.call/result', callId: message.callId, ok: false,
          error: {
            code: body?.error?.code ?? 'E_INTERNAL',
            message: String(body?.error?.message ?? body?.error ?? `service.call failed (HTTP ${status})`),
          },
        });
      }
    } catch (error) {
      // 契约层错误（缺 callId 等）：回失败帧，网关按 degraded 放行。
      send({
        v: 1, type: 'service.call/result', callId: message.callId, ok: false,
        error: { code: 'E_SCHEMA', message: String(error?.message ?? error) },
      });
    }
  }

  async function answerToolCall(message) {
    const { type: _type, ...request } = message;
    try {
      const { status, body } = await invoke({ path: '/v1/tools/call', request });
      const payload = body && typeof body === 'object'
        ? body
        : { v: 1, callId: message.callId, ok: false, error: { code: 'E_INTERNAL', message: `tool.call failed (HTTP ${status})` } };
      send({ v: 1, type: 'tool.call/result', callId: message.callId, ...payload });
    } catch (error) {
      send({
        v: 1, type: 'tool.call/result', callId: message.callId, ok: false,
        error: { code: 'E_SCHEMA', message: String(error?.message ?? error) },
      });
    }
  }

  function handleFrame(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      logger('gateway ws: dropped a frame that is not valid JSON');
      return;
    }
    switch (message?.type) {
      case 'service.call':
        void answerServiceCall(message);
        return;
      case 'tool.call':
        void answerToolCall(message);
        return;
      case 'ping':
        send({ v: 1, type: 'pong', at: now() });
        return;
      default:
        return;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(reconnectMinMs * 2 ** attempt, reconnectMaxMs);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  /** 连接失效收口：清引用 → 排下一次退避重连（归属不符的迟到事件直接忽略）。 */
  function resetSocket(sock, reason) {
    if (socket !== sock) return;
    socket = null;
    open = false;
    logger(`gateway ws reset: ${reason}`);
    scheduleReconnect();
  }

  function connect() {
    if (stopped || socket) return;
    let sock;
    try {
      sock = wsImpl === WebSocket
        // 只给真正的 ws 包传 options：浏览器/undici 形态第二参是子协议。
        ? new wsImpl(`${endpoint}?${handshakeQuery({ serviceId, secret, now }).toString()}`, { handshakeTimeout: handshakeTimeoutMs })
        : new wsImpl(`${endpoint}?${handshakeQuery({ serviceId, secret, now }).toString()}`);
    } catch (error) {
      logger(`gateway ws connect failed: ${error?.message ?? error}`);
      scheduleReconnect();
      return;
    }
    socket = sock;
    let guard = null;
    const clearGuard = () => {
      if (guard) {
        clearTimeout(guard);
        guard = null;
      }
    };
    const onOpen = () => {
      if (socket !== sock) return;
      clearGuard();
      open = true;
      attempt = 0;
      logger(`gateway ws connected (service=${serviceId}, transport=${transport})`);
    };
    const onMessage = (data) => {
      if (socket !== sock) return;
      handleFrame(typeof data === 'string' ? data : String(data));
    };
    const onClose = () => {
      if (socket !== sock) return;
      clearGuard();
      logger('gateway ws closed; reconnecting with backoff');
      resetSocket(sock, 'closed');
    };
    const onError = () => {
      if (socket !== sock) return;
      logger('gateway ws connection error');
      // ws 的 error 不保证再发 close：主动收口，否则 `socket` 非空会卡住重连。
      try { sock.terminate?.(); } catch { /* 已断开 */ }
      clearGuard();
      resetSocket(sock, 'connection error');
    };
    if (typeof sock.on === 'function') {
      sock.on('open', onOpen);
      sock.on('message', (data) => onMessage(String(data)));
      sock.on('close', onClose);
      sock.on('error', onError);
      sock.on('unexpected-response', (_req, res) => {
        if (socket !== sock) return;
        res?.resume?.();
        try { sock.terminate?.(); } catch { /* 已断开 */ }
        clearGuard();
        resetSocket(sock, `handshake rejected (HTTP ${res?.statusCode ?? '?'})`);
      });
      guard = setTimeout(() => {
        if (socket !== sock || open) return;
        logger(`gateway ws handshake timeout after ${handshakeTimeoutMs}ms`);
        try { sock.terminate?.(); } catch { /* 已断开 */ }
        resetSocket(sock, 'handshake timeout');
      }, handshakeTimeoutMs);
      guard.unref?.();
    } else {
      sock.onopen = onOpen;
      sock.onmessage = (event) => onMessage(typeof event?.data === 'string' ? event.data : String(event?.data));
      sock.onclose = onClose;
      sock.onerror = onError;
    }
  }

  return {
    /** 启动连接（幂等；断线后自动重连）。 */
    start() {
      stopped = false;
      connect();
    },
    /** 停止：取消重连并优雅关闭。 */
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try { socket.close(1000); } catch { /* 已断开 */ }
        socket = null;
      }
      open = false;
    },
    get connected() { return open; },
    status() {
      return {
        transport,
        connected: open,
        endpoint,
        serviceId,
        reconnectAttempt: attempt,
      };
    },
  };
}
