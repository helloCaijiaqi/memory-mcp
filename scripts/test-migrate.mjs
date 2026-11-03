// 迁移脚本的离线单测：用合成源目录验证条目对照、跳过原因，以及"只复制不移动"。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrate, toSessionId } from '../scripts/migrate-from-qq-bridge.mjs';

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeSource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-src-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state', 'slang.json'),
    JSON.stringify([
      { content: 'yyds', meaning: '永远的神', status: 'confirmed', evidence: [{ text: '这波 yyds' }] },
      { content: '   ', meaning: '空内容应被跳过' },
    ]),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'state', 'social-v2.json'),
    JSON.stringify({
      conversations: {
        'group:123': {
          activeTopics: ['群里在聊语音'],
          pendingThoughts: [{ text: '下次提醒他带文件' }],
          memberImpressions: { '10001': '爱发长语音' },
        },
        'unknown-key': { activeTopics: ['无法映射的会话'] },
      },
    }),
    'utf8',
  );
  return dir;
}

test('会话键映射：group/private → qq:*，其它一律拒绝', () => {
  assert.equal(toSessionId('group:123'), 'qq:group:123');
  assert.equal(toSessionId('private:456'), 'qq:private:456');
  assert.equal(toSessionId('unknown-key'), null);
});

test('迁移：条目数对照正确，空内容与无法映射的会话被记录为跳过', async () => {
  const src = makeSource();
  const slangFile = path.join(src, 'state', 'slang.json');
  const socialFile = path.join(src, 'state', 'social-v2.json');
  const beforeSlang = hash(slangFile);
  const beforeSocial = hash(socialFile);

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-dst-'));
  const report = await migrate({ source: src, stateDir });

  assert.equal(report.slang.source, 2);
  assert.equal(report.slang.imported, 1, '空内容那条应被跳过');
  assert.equal(report.memory.imported, 3, '话题 + 待续 + 画像 共 3 条');
  assert.ok(report.memory.skipped.some((reason) => reason.includes('无法映射')));
  assert.equal(report.stats.memory, 3);
  assert.equal(report.stats.slang, 1);

  // 只复制不移动：原件一个字节都不能变，且必须留下 .bak
  assert.equal(hash(slangFile), beforeSlang, '原件不应被修改');
  assert.equal(hash(socialFile), beforeSocial, '原件不应被修改');
  assert.ok(fs.existsSync(`${slangFile}.bak`));
  assert.ok(fs.existsSync(`${socialFile}.bak`));
});

test('迁移：dry-run 不写任何东西', async () => {
  const src = makeSource();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-dry-'));
  const report = await migrate({ source: src, stateDir, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(fs.existsSync(path.join(stateDir, 'memory.db')), false, 'dry-run 不应建库');
});

test('源目录里没有黑话库时也不炸（qq-bridge 现状如此）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-empty-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-dst2-'));
  const report = await migrate({ source: dir, stateDir });
  assert.equal(report.slang.source, 0);
  assert.equal(report.memory.imported, 0);
});
