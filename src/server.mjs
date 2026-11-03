// 进程入口：stdio MCP（给 DSH）+ 回环 HTTP（给平台桥接）同时起。
//
// 日志一律走 stderr：stdout 是 MCP 的协议通道，被污染会导致握手失败。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store/store-api.js';
import { createMemoryService } from './service/memory-service.js';
import { createSlangService } from './service/slang-service.js';
import { createHttpApi } from './http-api.js';
import { serveStdio } from './mcp-memory.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 可降级的端口错误：被占用 / 无权限。其余错误（参数非法等）仍然快速失败。 */
const PORT_CONFLICT_CODES = new Set(['EADDRINUSE', 'EACCES']);

export function resolveConfig(env = process.env) {
  const stateDir = path.resolve(env.MEMORY_MCP_STATE_DIR ?? path.join(PKG_ROOT, 'state'));
  return {
    stateDir,
    port: Number(env.MEMORY_MCP_HTTP_PORT ?? 7181),
    host: '127.0.0.1',
    token: env.MEMORY_MCP_TOKEN ?? '',
    readonlyTokenFile: path.join(stateDir, 'http-token'),
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
  const memory = createMemoryService({ store });
  const slang = createSlangService({ store });

  const api = withHttp ? createHttpApi({ memory, slang, token, host: cfg.host, port: cfg.port, logger: log }) : null;
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
  if (stdio) {
    await serveStdio({ memory, slang });
    log('stdio MCP 已连接');
  }
  return { cfg, store, memory, slang, api: httpError ? null : api, token, httpError };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  start().catch((error) => {
    console.error('[memory-mcp] 启动失败：', error?.stack ?? error);
    process.exitCode = 1;
  });
}
