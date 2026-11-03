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
    scope: 'room',
    id: 'xxx',
    sessionId: 'wx:room:xxx',
  });
});

test('非法输入一律抛错（不静默截断，避免两条记忆撞到同一个键）', () => {
  assert.throws(() => normalizeSessionId(''), /不能为空/);
  assert.throws(() => normalizeSessionId('qq:group'), /三段式/);
  assert.throws(() => normalizeSessionId('qq:group:123:extra'), /三段式/);
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
