// test-load-env：.env 装载器测试（零依赖 parseEnvText + loadEnvFile 只补缺语义）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText, loadEnvFile } from '../src/load-env.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-load-env-'));

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('行内注释：非引号值中 空白+# 截断，引号内 # 保留', () => {
  const env = {};
  const parsed = parseEnvText('A=vision-svc  # 说明文字\nB="has # hash"\n');
  assert.equal(parsed.A, 'vision-svc');
  assert.equal(parsed.B, 'has # hash');
});
test('parseEnvText：注释/空行/引号/export 前缀/坏行宽松跳过', () => {
  const text = [
    '# 全量注释行',
    '',
    'KEY_A=plain',
    'KEY_B="quoted value"',
    "KEY_C='single'",
    'export KEY_D=1',
    'no-equals-line',
    '=empty-key',
    'KEY_E=', // 空值合法
  ].join('\r\n');
  assert.deepEqual(parseEnvText(text), {
    KEY_A: 'plain',
    KEY_B: 'quoted value',
    KEY_C: 'single',
    KEY_D: '1',
    KEY_E: '',
  });
});

test('loadEnvFile：文件不存在返回空数组（静默，不挡启动）', () => {
  const env = {};
  assert.deepEqual(loadEnvFile(path.join(TMP, 'missing-dir'), env), []);
  assert.deepEqual(env, {});
});

test('loadEnvFile：注入缺省键 + 真实 env 优先（只补缺不覆盖）', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  fs.writeFileSync(path.join(dir, '.env'), 'FOO=from-file\nBAR=from-file\nBAZ=from-file\n');
  const env = { BAR: 'from-real-env' };
  const applied = loadEnvFile(dir, env);
  assert.deepEqual(applied, ['FOO', 'BAZ'], 'BAR 已显式设置，不注入');
  assert.equal(env.FOO, 'from-file');
  assert.equal(env.BAR, 'from-real-env');
  assert.equal(env.BAZ, 'from-file');
});

test('loadEnvFile：解析失败/坏行不拒绝整个文件', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'd2-'));
  fs.writeFileSync(path.join(dir, '.env'), 'GOOD=1\n!!!bad\nKEY WITH SPACE=2\n');
  const env = {};
  assert.deepEqual(loadEnvFile(dir, env), ['GOOD']);
});
