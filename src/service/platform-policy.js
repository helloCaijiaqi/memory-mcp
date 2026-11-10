// 平台白名单：新平台接入时的第一道闸门。
//
// 为什么需要：`sessionId` 由桥接产出，本服务无法预知「tg:group:1」是不是笔误或串台。
// 但默认**不能拒绝**——新桥接上线跑通之前就 500，比串台更难排查。所以：
//   默认（strict=false）：未知平台放行，只告警一次（`/api/health` 侧可见日志）；
//   MEMORY_MCP_PLATFORM_STRICT=1：未知平台直接拒绝，适合「只允许已知平台」的部署。
//
// platform 依然只由 sessionId 派生，这里做的是「校验」而不是「第二处真相」。
import { parseSessionId } from '../session-id.js';

export const DEFAULT_PLATFORM_POLICY = { known: ['qq'], strict: false };

export class UnknownPlatformError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnknownPlatformError';
  }
}

export function createPlatformPolicy({ known = DEFAULT_PLATFORM_POLICY.known, strict = false, logger } = {}) {
  const set = new Set(
    (Array.isArray(known) ? known : String(known ?? '').split(','))
      .map((item) => String(item ?? '').trim().toLowerCase())
      .filter(Boolean),
  );
  const warned = new Set();

  return {
    known: [...set],
    strict: Boolean(strict),

    /** 校验并返回 platform；未知平台在 strict 下抛错，否则告警一次后放行。 */
    check(sessionId) {
      const { platform } = parseSessionId(sessionId);
      // 白名单为空 = 不设限（显式配置成空串的人知道自己要什么）。
      if (!set.size || set.has(platform)) return platform;
      if (strict) {
        throw new UnknownPlatformError(
          `未知平台 ${platform}：不在 MEMORY_MCP_PLATFORMS（${[...set].join(',')}）内，当前为 strict 模式`,
        );
      }
      if (!warned.has(platform)) {
        warned.add(platform);
        logger?.(`[memory] unknown platform: ${platform}（不在白名单内，已放行；MEMORY_MCP_PLATFORM_STRICT=1 可拒绝）`);
      }
      return platform;
    },
  };
}
