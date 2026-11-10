// 进程入口：stdio MCP（给 DSH）+ 回环 HTTP（给平台桥接）同时起。
//
// 日志一律走 stderr：stdout 是 MCP 的协议通道，被污染会导致握手失败。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store/store-api.js';
import { createMemoryService } from './service/memory-service.js';
import { createRelationService } from './service/relation-service.js';
import { createRawService } from './service/raw-service.js';
import { createFts5Backend, createRecallRouter, createVectorBackend } from './service/recall.js';
import { createPlatformPolicy } from './service/platform-policy.js';
import { createSlangService } from './service/slang-service.js';
import { createGatewayAuth, createGatewayV1 } from './service/gateway-v1.js';
import { createGatewayWsConnector } from './service/ws-connector.js';
import { createProfileService } from './service/profile-service.js';
import { createSummarizer } from './service/summarizer.js';
import { createRelationGuard } from './service/relation-guard.js';
import { createLlmProvider } from './llm-provider.js';
import { createHttpApi } from './http-api.js';
import { serveStdio } from './mcp-memory.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 可降级的端口错误：被占用 / 无权限。其余错误（参数非法等）仍然快速失败。 */
const PORT_CONFLICT_CODES = new Set(['EADDRINUSE', 'EACCES']);
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveConfig(env = process.env) {
  // MEMORY_MCP_DATA_DIR 是文档里的旧名字：两个都认，避免升级后旧部署「换了目录还不自知」。
  const stateDir = path.resolve(env.MEMORY_MCP_STATE_DIR ?? env.MEMORY_MCP_DATA_DIR ?? path.join(PKG_ROOT, 'state'));
  return {
    stateDir,
    // 分层注入（head/tail + 原始层 + 关系 + 召回）的灰度开关：默认开，`=0` 只留旧接口。
    // 默认开是因为桥接已经按新契约改造；开关的存在是为了「出问题时一条环境变量回退」。
    layersV2: String(env.MEMORY_LAYERS_V2 ?? '1') !== '0',
    port: num(env.MEMORY_MCP_HTTP_PORT, 7181),
    host: '127.0.0.1',
    token: env.MEMORY_MCP_TOKEN ?? '',
    readonlyTokenFile: path.join(stateDir, 'http-token'),
    // 网关 V2 接入（/v1 端点）：secret 与网关登记文件的 secret 同源（推荐
    // secretEnv: MEMORY_MCP_GATEWAY_SECRET）；gatewayId = 登记文件 id（32 位
    // hash，可选——不设则只验签名不比对身份头，密钥仍是唯一凭据）。
    gatewaySecret: env.MEMORY_MCP_GATEWAY_SECRET ?? '',
    gatewayId: env.MEMORY_MCP_GATEWAY_ID ?? '',
    // 网关 WS 长连接（V2 主线）：URL 非空即启用连接器（service.call / tool.call 走帧）。
    // transport 只允许 ws|auto（fail-closed：非法值启动即失败）；权威选路仍在网关
    // service-registry（登记文件 transport 字段），这里只是连接器口径。
    gatewayWsUrl: env.MEMORY_MCP_GATEWAY_WS_URL ?? '',
    gatewayTransport: (() => {
      const value = env.MEMORY_MCP_GATEWAY_TRANSPORT ?? 'auto';
      if (value !== 'ws' && value !== 'auto') {
        throw new Error(`MEMORY_MCP_GATEWAY_TRANSPORT 只支持 ws|auto（got "${value}"）`);
      }
      return value;
    })(),
    // head 断点与情绪时效：两个服务共用同一组数字，不允许各配各的。
    head: {
      quietWindowMs: num(env.MEMORY_MCP_HEAD_QUIET_MINUTES, 30) * MINUTE_MS,
      emotionFreshMs: num(env.MEMORY_MCP_EMOTION_FRESH_HOURS, 2) * HOUR_MS,
    },
    relation: {
      // 跨平台共享同一个人的关系是产品决策，默认关；要开就显式设成 1。
      identityEnabled: String(env.MEMORY_MCP_RELATION_IDENTITY ?? '') === '1',
    },
    // 平台白名单：默认只认 qq；新平台接入时按需加进 MEMORY_MCP_PLATFORMS。
    // strict 默认关 —— 未知平台先放行并告警，等桥接跑通再收紧。
    platforms: String(env.MEMORY_MCP_PLATFORMS ?? 'qq')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    platformStrict: String(env.MEMORY_MCP_PLATFORM_STRICT ?? '') === '1',
    raw: {
      rawRetentionDays: num(env.MEMORY_MCP_RAW_RETENTION_DAYS, 30),
    },
    // LLM（OpenAI 兼容）：黑话解释 + 失活摘要共用一个 provider。默认关闭 ——
    // 关闭时摘要任务不跑（长期层只由 record/手动巩固产生），行为与旧版一致。
    llm: {
      enabled: String(env.MEMORY_MCP_LLM_ENABLED ?? '') === '1',
      baseUrl: env.MEMORY_MCP_LLM_BASE_URL ?? '',
      apiKey: env.MEMORY_MCP_LLM_API_KEY ?? '',
      model: env.MEMORY_MCP_LLM_MODEL ?? '',
      timeoutMs: num(env.MEMORY_MCP_LLM_TIMEOUT_MS, 20_000),
    },
    // 失活摘要：quietMs 必须与会话纪元的 sessionIdleMs 同源（60 分钟 = 会话结束）。
    summary: {
      quietMs: num(env.MEMORY_MCP_SUMMARY_QUIET_MINUTES, 60) * MINUTE_MS,
      tickMs: num(env.MEMORY_MCP_SUMMARY_TICK_MINUTES, 5) * MINUTE_MS,
    },
    memory: {
      sessionIdleMs: num(env.MEMORY_MCP_SESSION_IDLE_MINUTES, 60) * MINUTE_MS,
    },
    recall: {
      // 跨平台召回默认关：同一个 scope:id 在不同平台是不同的人/群，串台比召回不到更糟。
      crossPlatform: String(env.MEMORY_MCP_RECALL_CROSS_PLATFORM ?? '') === '1',
      maxRows: num(env.MEMORY_MCP_RECALL_MAX_ROWS, 5),
      maxChars: num(env.MEMORY_MCP_RECALL_MAX_CHARS, 400),
    },
  };
}

/** 本地令牌：优先用环境变量，否则在 state/ 里生成一份（权限收紧，与 qq-bridge/state 同处理）。 */
function ensureToken(cfg) {
  if (cfg.token) return cfg.token;
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  try {
    const existing = fs.readFileSync(cfg.readonlyTokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* 还没生成过 */
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(cfg.readonlyTokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(cfg.readonlyTokenFile, 0o600);
  } catch {
    /* Windows 上可能不支持 */
  }
  return token;
}

export async function start({ env = process.env, stdio = true, http: withHttp = true, logger } = {}) {
  const cfg = resolveConfig(env);
  const log = logger ?? ((...args) => console.error('[memory-mcp]', ...args));
  const token = ensureToken(cfg);

  const store = await openStore({ dir: cfg.stateDir });
  if (store.degradedFrom) log(`存储降级：${store.degradedFrom}`);

  const platformPolicy = createPlatformPolicy({
    known: cfg.platforms,
    strict: cfg.platformStrict,
    logger: log,
  });

  const memory = createMemoryService({ store, config: { head: cfg.head, sessionIdleMs: cfg.memory.sessionIdleMs }, platformPolicy });
  const slang = createSlangService({ store });
  const relation = createRelationService({
    store,
    config: { identityEnabled: cfg.relation.identityEnabled, emotionFreshMs: cfg.head.emotionFreshMs },
    platformPolicy,
  });
  const raw = createRawService({ store, stateDir: cfg.stateDir, config: cfg.raw, logger: { log } });
  // 人物画像 + 失活摘要（会话纪元模型）：LLM 关闭时 summarizer.enabled=false，
  // tick 直接空转 —— 长期层退化为「record / 手动巩固」，与旧版行为一致。
  const llm = createLlmProvider(cfg.llm);
  const profile = createProfileService({ store, logger: log });
  // 关系守卫：摘要抽取 + 规则兜底的唯一写入通道（阈值/白名单/pending 在这层强制）。
  const guard = createRelationGuard({ store, relation, logger: log });
  const summarizer = createSummarizer({
    store,
    memory,
    profile,
    llm,
    // 摘要抽取的 relations + 窗口原文（规则兜底用）→ 守卫处理；摘要事务不受
    // 守卫结果影响（守卫永不抛错，失败逐条记录）。
    onRelations: ({ sessionId, relations, sourceMsgIds, windowHash, rows }) => {
      const results = guard.handleExtracted({ sessionId, relations, sourceMsgIds, windowHash, rows });
      const pending = results.filter((item) => item.outcome === 'pending').length;
      if (pending) log(`摘要抽取：${results.length} 条候选，其中 ${pending} 条待人工确认`);
      return results;
    },
    config: { quietMs: cfg.summary.quietMs, tickMs: cfg.summary.tickMs },
    logger: log,
  });
  // 召回后端按能力装配：FTS5 现在可用，向量是占位（available() === false，不拖慢热路径）。
  const recall = createRecallRouter({
    store,
    backends: [createFts5Backend({ store, config: cfg.recall }), createVectorBackend()],
    config: cfg.recall,
  });

  // 网关 V2 接入面：配了密钥才创建（未配 = /v1 端点整体缺席，网关侧按「服务
  // 未就绪」降级）。auth 失败只 401，不影响 /api/* 与 stdio。
  const gateway = cfg.gatewaySecret
    ? createGatewayV1({
      auth: createGatewayAuth({ secret: cfg.gatewaySecret, serviceId: cfg.gatewayId || undefined }),
      memory,
      recall,
      profile,
      relation,
      logger: log,
    })
    : null;

  // 网关 WS 长连接：配置了 URL 就必须给齐 id/secret（fail-closed，不静默退回 HTTP——
  // 「以为走了 WS 其实没连」比启动失败更难排查）。连接器挂 `invoke`（免验签分发，
  // 与 HTTP 入口同一组处理函数），帧到达即执行并回应。
  if (cfg.gatewayWsUrl) {
    if (!cfg.gatewaySecret) throw new Error('MEMORY_MCP_GATEWAY_WS_URL 已设置，但缺少 MEMORY_MCP_GATEWAY_SECRET');
    if (!cfg.gatewayId) throw new Error('MEMORY_MCP_GATEWAY_WS_URL 已设置，但缺少 MEMORY_MCP_GATEWAY_ID（登记文件 id）');
    if (!gateway) throw new Error('网关 WS 连接器需要 /v1 接入面（gateway-v1）已装配');
  }
  const wsConnector = gateway && cfg.gatewayWsUrl
    ? createGatewayWsConnector({
      url: cfg.gatewayWsUrl,
      serviceId: cfg.gatewayId,
      secret: cfg.gatewaySecret,
      transport: cfg.gatewayTransport,
      invoke: gateway.invoke,
      logger: log,
    })
    : null;

  // 健康检查要能看见「降级到 JSON 兜底」「库是只读」这两件事实，而不是只写进日志。
  const info = {
    backend: store.backend,
    degraded: Boolean(store.degradedFrom),
    degradedFrom: store.degradedFrom ?? null,
    readonly: Boolean(store.readonly),
    schemaVersion: store.schemaVersion ?? null,
    archiveDir: path.relative(cfg.stateDir, raw.root) || '.',
    layersV2: cfg.layersV2,
    platforms: { known: platformPolicy.known, strict: platformPolicy.strict },
    recall: {
      backends: recall.backends,
      available: recall.available(),
      crossPlatform: cfg.recall.crossPlatform,
      maxRows: cfg.recall.maxRows,
      maxChars: cfg.recall.maxChars,
    },
  };

  const api = withHttp
    ? createHttpApi({
        memory,
        slang,
        relation,
        raw,
        recall,
        profile,
        guard,
        info,
        token,
        gateway,
        host: cfg.host,
        port: cfg.port,
        layersV2: cfg.layersV2,
        logger: log,
      })
    : null;
  // 端口抢不到（被别的实例占着、或无权限）**不能**拖死 stdio：
  // DSH 的工具面与端口无关，为一条 HTTP 旁路把进程整个退出，
  // 会让 memory_* 全部消失；桥接那边本来就有熔断回落，降级即可。
  let httpError = null;
  if (api) {
    try {
      await api.listen();
      log(`回环 HTTP 已监听 http://${cfg.host}:${cfg.port}`);
    } catch (error) {
      if (!PORT_CONFLICT_CODES.has(error?.code)) throw error;
      httpError = error;
      log(`回环 HTTP 未启动（${error.code} ${cfg.host}:${cfg.port}）：已降级为 stdio-only，MCP 工具仍可用；qq-bridge 将回落本地实现`);
    }
  }
  if (wsConnector) {
    // 与本地 HTTP 端口无关：即使回环端口被占（stdio-only 降级），WS 长连接仍可工作
    // ——网关的 service.call / tool.call 因此不会因为本服务端口冲突而全部走不通。
    wsConnector.start();
    const status = wsConnector.status();
    log(`网关 WS 连接器已启动：${status.endpoint}（service=${status.serviceId} transport=${status.transport}）`);
  }
  // 失活摘要 tick（LLM 启用时才有实际动作；定时器 unref，不拖住进程退出）。
  if (summarizer.status().enabled) {
    summarizer.start();
    log(`失活摘要任务已启动：quiet=${Math.round(cfg.summary.quietMs / MINUTE_MS)}min tick=${Math.round(cfg.summary.tickMs / MINUTE_MS)}min`);
  }
  // 统一退出路径：停摘要 → 停连接器 → 关 HTTP → 关 SQLite 句柄 → exit。
  // 旧实现每个模块各自 process.once('SIGINT')，只 stop 连接器就返回：stdio 模式下
  // stdin 还开着，进程不退出；SQLite 的 WAL/句柄也没有正常关闭点。
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在关闭（summary/ws/http/store）…`);
    try { summarizer.stop(); } catch { /* 已停 */ }
    try { wsConnector?.stop(); } catch { /* 已停 */ }
    try { if (api && !httpError) await api.close(); } catch { /* 已关 */ }
    try { store.close?.(); } catch { /* 已关 */ }
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  if (stdio) {
    await serveStdio({ memory, slang, relation, raw, recall });
    log('stdio MCP 已连接');
  }
  return { cfg, store, memory, slang, relation, raw, recall, profile, guard, summarizer, llm, api: httpError ? null : api, token, httpError, info, wsConnector };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  start().catch((error) => {
    console.error('[memory-mcp] 启动失败：', error?.stack ?? error);
    process.exitCode = 1;
  });
}
