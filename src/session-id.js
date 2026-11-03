// 会话标识的中性化。
//
// 这个服务是平台无关的：它只认 `platform:scope:id`，从不解析 platform 的语义。
// 平台桥接（qq-bridge / 未来的微信桥接）负责把自家会话号映射成这个形状：
//   qq:group:123456     QQ 群
//   qq:private:654321   QQ 私聊
//   wx:room:xxxxx       未来的微信群
// 映射规则不进本服务，这样新平台接入时不用改这里。

const PLATFORM_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SCOPE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export const MAX_SESSION_ID_LENGTH = 200;
export const MAX_RAW_ID_LENGTH = 128;

// 控制字符与换行会让日志、提示词注入变形，一律拒绝。
// 用码点判断而不是正则字面量：字面上写控制字符会让这个文件变成"二进制"，难以审阅与 diff。
function hasControlChars(text) {
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export class SessionIdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionIdError';
  }
}

/** 校验并规范化 sessionId；不合法直接抛错（不做静默截断，避免两条记忆落到同一个键上）。 */
export function normalizeSessionId(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new SessionIdError('sessionId 不能为空');
  if (text.length > MAX_SESSION_ID_LENGTH) {
    throw new SessionIdError(`sessionId 过长（${text.length} > ${MAX_SESSION_ID_LENGTH}）：${text.slice(0, 40)}…`);
  }
  const parts = text.split(':');
  if (parts.length !== 3) {
    throw new SessionIdError(`sessionId 必须是 platform:scope:id 三段式，实际 ${parts.length} 段：${text}`);
  }
  const [platform, scope, id] = parts.map((part) => part.trim());
  const lowerPlatform = platform.toLowerCase();
  const lowerScope = scope.toLowerCase();
  if (!PLATFORM_RE.test(lowerPlatform)) {
    throw new SessionIdError(`platform 段不合法（仅允许字母开头 + 字母数字_-，最长 32）：${platform}`);
  }
  if (!SCOPE_RE.test(lowerScope)) {
    throw new SessionIdError(`scope 段不合法（仅允许字母开头 + 字母数字_-，最长 32）：${scope}`);
  }
  if (!id) throw new SessionIdError('id 段不能为空');
  if (id.length > MAX_RAW_ID_LENGTH) {
    throw new SessionIdError(`id 段过长（${id.length} > ${MAX_RAW_ID_LENGTH}）`);
  }
  if (hasControlChars(id)) throw new SessionIdError('id 段不能包含控制字符');
  return `${lowerPlatform}:${lowerScope}:${id}`;
}

/** 拼装 sessionId（三个字段各自可来自平台桥接的原始值）。 */
export function makeSessionId(platform, scope, id) {
  return normalizeSessionId(`${platform}:${scope}:${id}`);
}

export function isValidSessionId(value) {
  try {
    normalizeSessionId(value);
    return true;
  } catch {
    return false;
  }
}

/** 拆成 { platform, scope, id }；已保证 platform / scope 为小写。 */
export function parseSessionId(value) {
  const normalized = normalizeSessionId(value);
  const [platform, scope, id] = normalized.split(':');
  return { platform, scope, id, sessionId: normalized };
}
