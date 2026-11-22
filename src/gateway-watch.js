/**
 * gateway.json 热加载监视器。
 *
 * 解决的问题：网关侧登记（或换密钥重注册）产出新的 gateway.json 后，资源服务
 * 不应再要求重启——文件出现/修复/变更 ≤intervalMs 自动生效。
 *
 * 语义（fail-safe，不是 fail-closed）：
 *   - 文件缺失 → 网关接入摘除（/v1/tools/call 503），stdio MCP 不受影响；
 *   - 文件非法 → 同样摘除 + 告警日志（带着坏凭据继续服务比拒绝服务更危险）；
 *   - 文件恢复合法 → 自动重新装配；
 *   - 变更检测按内容哈希轮询（比 fs.watch 跨平台更可靠；同尺寸快速重写、编辑器
 *     原子替换都能捕捉）。网关轮换密钥必然重写文件 → 内容哈希必变。
 *
 * 轮询而非 watch 事件的原因：DSH 拉起的子进程环境里 fs.watch 的句柄行为不稳定，
 * 2s 级延迟对「登记后自动生效」完全够用（登记目录本身的热加载也是秒级）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadGatewayConfig } from './gateway-config.js';

/**
 * @param {object} options
 * @param {string} options.root 仓库根目录（gateway.json 所在目录）
 * @param {NodeJS.ProcessEnv} [options.env] 旧环境变量检测透传
 * @param {string} options.envPrefix 本进程环境变量前缀（如 `MEMORY_MCP_`）
 * @param {(msg: string) => void} [options.logger]
 * @param {number} [options.intervalMs] 轮询间隔（默认 2000）
 * @returns {{ current: () => {config: object|null, error: string|null, file: string},
 *             file: string, refresh: () => void, stop: () => void }}
 *          current() 的 config=null 表示未生效（error=null 是缺失，非 null 是非法）。
 */
export function createGatewayWatcher({
  root,
  env = process.env,
  envPrefix,
  logger = () => {},
  intervalMs = 2000,
} = {}) {
  if (!root) throw new Error('createGatewayWatcher 需要 root（仓库根目录）');
  const file = path.join(root, 'gateway.json');
  let state = { config: null, error: null, file };
  let lastSig = null;

  function probe(initial = false) {
    let sig;
    // 内容哈希做签名：mtime/size 在快速连续重写（同尺寸、同 mtime tick）下不可靠，
    // gateway.json 只有几百字节，每次轮询哈希一遍成本可忽略。
    try {
      sig = createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    } catch {
      sig = 'missing';
    }
    if (sig === lastSig) return;
    const had = Boolean(state.config || state.error);
    if (sig === 'missing') {
      state = { config: null, error: null, file };
      if (had && !initial) {
        logger?.('gateway.json 已移除：网关接入摘除（/v1/tools/call 返回 503），stdio MCP 不受影响');
      }
    } else {
      try {
        const config = loadGatewayConfig({ root, env, envPrefix });
        state = { config, error: null, file };
        // 首次生效与后续变更分开措辞（启动期加载 vs 热加载），运维一眼可辨。
        logger?.(`${had ? 'gateway.json 变更已热加载' : 'gateway.json 已加载'}：`
          + `id=${config.id} auth=${config.auth} transport=${config.transport}${had ? '（无需重启）' : ''}`);
      } catch (error) {
        state = { config: null, error: String(error?.message ?? error), file };
        logger?.(`gateway.json 非法，网关接入摘除（修复后自动热加载，无需重启）：${error?.message ?? error}`);
      }
    }
    lastSig = sig;
  }

  probe(true);
  if (typeof fs.watchFile === 'function') {
    const statWatcher = fs.watchFile(file, { interval: intervalMs }, () => probe(false));
    // unref：轮询器不持有事件循环——进程生命周期由 stdio 长连接锚定，
    // 否则测试进程跑完用例会被这个 2s 轮询拖住无法退出。
    statWatcher?.unref?.();
  }

  return {
    current: () => state,
    file,
    /** 测试与运维用：立即重扫一次（不等下一个轮询周期）。 */
    refresh: () => probe(false),
    stop: () => fs.unwatchFile(file),
  };
}
