/**
 * gateway.json —— 「怎么连 agent-gateway」的唯一事实源。
 *
 * 为什么不用环境变量：四个键（身份 / 地址 / 密钥 / 传输）分散在 shell、批处理、
 * 服务管理器里，换一台机器就要重抄一遍，而且「设了却没生效」最难查。改成仓库根目录
 * 一份静态文件：文件名即用途、字段有结构、由网关生成后直接复制。
 *
 * 文件由 agent-gateway 产出（state/gateway/handoff/<登记id>.gateway.json），
 * 复制到本仓库根目录并保持文件名 gateway.json。文件缺失 = 不接入网关（本进程仍可
 * 作为 stdio MCP 使用），不算致命错误。
 */
import fs from 'node:fs';
import path from 'node:path';

export const GATEWAY_CONFIG_FILE = 'gateway.json';

/** 已退役的环境变量后缀：设了也不读，直接报错（见 assertNoLegacyEnv）。 */
const LEGACY_ENV_SUFFIXES = ['SECRET', 'ID', 'WS_URL', 'TRANSPORT'];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
// 传输按角色非对称：资源服务纯被动（只接受网关的 HTTP tool.call，不向网关发
// 消息），WS 能力已随 ws-connector 退役——transport 只支持 http（缺省同值）。
const TRANSPORTS = new Set(['http']);
const MIN_SECRET_LENGTH = 16;

/** gateway.json 的绝对路径（root = 仓库根目录）。 */
export function gatewayConfigPath(root) {
  return path.join(root, GATEWAY_CONFIG_FILE);
}

/**
 * 旧环境变量检测：`<PREFIX>GATEWAY_*` 一旦非空就报错。
 *
 * 刻意不「兼容读取」：两套来源并存时，用户改了 .env 却忘了改 gateway.json（或反之），
 * 看到的现象是「配置明明改了却不生效」——比启动失败难查得多。
 */
export function assertNoLegacyEnv({ env = process.env, prefix, file = GATEWAY_CONFIG_FILE } = {}) {
  if (!prefix) throw new Error('assertNoLegacyEnv 需要 prefix（如 MEMORY_MCP_）');
  const found = LEGACY_ENV_SUFFIXES
    .map((suffix) => `${prefix}GATEWAY_${suffix}`)
    .filter((key) => typeof env[key] === 'string' && env[key].trim() !== '');
  if (found.length) {
    throw new Error(
      `检测到已退役的环境变量：${found.join('、')}。网关连接信息现在只从仓库根目录的 ${file} 读取`
      + '（该文件由 agent-gateway 生成，复制到本仓库根目录即可）。\n'
      + `  处理方式：删除这些环境变量（或从启动脚本 / 服务配置里去掉），改为维护 ${file}。`,
    );
  }
}

function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON：${error?.message ?? error}`);
  }
}

function requireString(value, field, file) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${file} 缺少必填字段 ${field}`);
  return text;
}

/** secretFile 优先、secret 兼容；两者并存且不一致时以文件为准并告警。 */
function resolveSecret(doc, file, logger) {
  const inline = typeof doc.secret === 'string' && doc.secret.trim() ? doc.secret.trim() : '';
  const referenced = typeof doc.secretFile === 'string' && doc.secretFile.trim() ? doc.secretFile.trim() : '';
  if (referenced) {
    const secretFile = path.resolve(path.dirname(file), referenced);
    let text = '';
    try {
      text = fs.readFileSync(secretFile, 'utf8').trim();
    } catch (error) {
      throw new Error(
        `${file} 的 secretFile 无法读取：${secretFile}（${error?.code ?? error?.message ?? error}）。`
        + '同机部署请确认网关 state/gateway 下的密钥文件存在；跨机复制请让网关用 --inline-secret 重新生成。',
      );
    }
    if (inline && inline !== text) {
      logger?.(`⚠️ ${file} 同时含 secret 与 secretFile：以 secretFile 为准（${secretFile}）`);
    }
    if (text.length < MIN_SECRET_LENGTH) {
      throw new Error(`密钥长度不足（${text.length} < ${MIN_SECRET_LENGTH}）：${secretFile}`);
    }
    return { secret: text, auth: 'secretFile', secretFile };
  }
  if (!inline) {
    throw new Error(
      `${file} 没有密钥：需要 secretFile（指向网关侧 *.secret）或 secret（内联明文）。`
      + `若登记用的是 secretEnv，网关拿不到明文，需要在 ${file} 里手工补 secret。`,
    );
  }
  if (inline.length < MIN_SECRET_LENGTH) {
    throw new Error(`${file} 的 secret 太短（${inline.length} < ${MIN_SECRET_LENGTH}）`);
  }
  return { secret: inline, auth: 'inline', secretFile: null };
}

let hintedMissing = false;

/**
 * 读取并校验 gateway.json。
 *
 * @param {object} options
 * @param {string} options.root 仓库根目录
 * @param {NodeJS.ProcessEnv} [options.env] 用于旧环境变量检测
 * @param {string} options.envPrefix 本进程的环境变量前缀（如 `MEMORY_MCP_`）
 * @param {(msg: string) => void} [options.logger]
 * @returns {null | {id: string, url: string, transport: 'http', secret: string,
 *                   auth: 'secretFile'|'inline', file: string, secretFile: string|null}}
 *          null = 没有配置文件（不接入网关，stdio 照常可用）
 */
export function loadGatewayConfig({ root, env = process.env, envPrefix, logger } = {}) {
  if (!root) throw new Error('loadGatewayConfig 需要 root（仓库根目录）');
  assertNoLegacyEnv({ env, prefix: envPrefix, file: GATEWAY_CONFIG_FILE });

  const file = gatewayConfigPath(root);
  if (!fs.existsSync(file)) {
    if (!hintedMissing) {
      hintedMissing = true;
      logger?.(`未发现 ${file}：本进程不接入网关（/v1 端点不启用），stdio MCP 功能不受影响。`
        + '要接入：把网关生成的 handoff/<id>.gateway.json 复制到仓库根目录并命名为 gateway.json。');
    }
    return null;
  }

  const doc = readJsonFile(file);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} 必须是 JSON 对象`);
  if (doc.v !== 1) throw new Error(`${file} 的 v=${JSON.stringify(doc.v)} 不受支持（当前只支持 v: 1）`);

  const id = requireString(doc.id, 'id', file);
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${file} 的 id="${id}" 不合法：只允许小写字母/数字/连字符，且不超过 64 字符`);
  }
  const url = requireString(doc.url, 'url', file);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${file} 的 url 不合法：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${file} 的 url 只支持 http/https：${url}`);
  }
  const transport = String(doc.transport ?? 'http').trim().toLowerCase();
  if (!TRANSPORTS.has(transport)) {
    throw new Error(
      `${file} 的 transport="${doc.transport}" 不合法：资源服务只支持 http（WS 能力已退役——`
      + `网关只经 HTTP POST /v1/tools/call 调用本服务）；迁移 "transport": "${transport}" → "transport": "http"。`
      + '要完全断开网关接入请移走 gateway.json',
    );
  }
  const { secret, auth, secretFile } = resolveSecret(doc, file, logger);
  return { id, url, transport, secret, auth, file, secretFile };
}
