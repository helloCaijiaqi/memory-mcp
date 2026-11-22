// sessionId 中性化的离线单测：不连任何服务、不写生产文件。
import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidSessionId, makeSessionId, normalizeSessionId, parseSessionId } from '../src/session-id.js';

test('三段式规范化：平台与 scope 转小写，id 原样保留', () => {
  assert.equal(normalizeSessionId('QQ:Group:123456'), 'qq:group:123456');
  assert.equal(normalizeSessionId('  qq:private:654321  '), 'qq:private:654321');
  assert.equal(makeSessionId('WX', 'Room', 'abc-123'), 'wx:room:abc-123');
});

test('未来的微信会话不需要改动本服务', () => {
  assert.equal(parseSessionId('wx:room:xxx').platform, 'wx');
  assert.deepEqual(parseSessionId('wx:room:xxx'), {
    platform: 'wx',
    consumerId: null,
    scope: 'room',
    id: 'xxx',
    sessionId: 'wx:room:xxx',
  });
});

test('多消费端收编：4 段会话键（platform:consumerId:scope:id）合法且段结构保留', () => {
  // 网关多账号改造后 sessionKey 变 4 段（会话绑消费端）：normalize 保留 consumerId
  // 段——同一 subject 在不同账号会话里的记忆仍归同一 subject 身份层（platform+QQ号）。
  const four = 'qq:svc-a3f2b9c1d4e5:group:123456';
  assert.equal(normalizeSessionId(four), four);
  assert.deepEqual(parseSessionId(four), {
    platform: 'qq',
    consumerId: 'svc-a3f2b9c1d4e5',
    scope: 'group',
    id: '123456',
    sessionId: four,
  });
  // consumerId 段词法与 scope 一致：非法形态拒绝。
  assert.throws(() => normalizeSessionId('qq:svc-a3f2b9c1d4e5:9group:123'), /scope 段不合法/);
});

test('非法输入一律抛错（不静默截断，避免两条记忆撞到同一个键）', () => {
  assert.throws(() => normalizeSessionId(''), /不能为空/);
  assert.throws(() => normalizeSessionId('qq:group'), /platform:scope:id 或 platform:consumerId:scope:id/);
  assert.throws(() => normalizeSessionId('qq:group:123:extra:more'), /platform:scope:id 或 platform:consumerId:scope:id/);
  assert.throws(() => normalizeSessionId('9qq:group:123'), /platform 段不合法/);
  assert.throws(() => normalizeSessionId('qq:9group:123'), /scope 段不合法/);
  assert.throws(() => normalizeSessionId('qq:group:'), /id 段不能为空/);
  // 注意长度：超过 MAX_SESSION_ID_LENGTH 会先撞上"整体过长"，这里要测的是 id 段自身超限。
  assert.throws(() => normalizeSessionId(`qq:group:${'x'.repeat(130)}`), /id 段过长/);
  assert.throws(() => normalizeSessionId('qq:group:a\nb'), /控制字符/);
});

test('isValidSessionId 不抛错，只回答真假', () => {
  assert.equal(isValidSessionId('qq:group:1'), true);
  assert.equal(isValidSessionId('nonsense'), false);
  assert.equal(isValidSessionId(null), false);
});
