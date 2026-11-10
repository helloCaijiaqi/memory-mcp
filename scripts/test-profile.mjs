// 人物画像专项：字段白名单（越界丢弃）、merge 语义（未提及保留 / null 删除 /
// 置信度合成 / 锚点并集）、replace 整份覆盖、版本链回滚、被遗忘权、双后端一致。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openStore } from '../src/store/store-api.js';
import { createProfileService, PROFILE_FIELDS } from '../src/service/profile-service.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-profile-'));
const SESSION = 'qq:group:60001';
const SUBJECT = 'u_1';

async function fixture(backend = 'sqlite') {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${backend}-`));
  const store = await openStore({ dir, backend });
  const profile = createProfileService({ store, logger: () => {} });
  return { store, profile, close: () => store.close() };
}

test('profile：白名单清洗 —— 越界字段丢弃、列表字段去重截断、null = 删除', async () => {
  const { profile, close } = await fixture();
  try {
    assert.deepEqual([...PROFILE_FIELDS], ['personality', 'speakingStyle', 'catchphrases', 'taboos', 'relation']);

    const merged = profile.merge({
      sessionId: SESSION,
      subjectId: SUBJECT,
      patch: {
        personality: '嘴硬心软',
        secretIntent: '越界字段必须丢', // 不在白名单
        catchphrases: ['绝了', '', '绝了', 'x'.repeat(100)], // 去空去重截断
        taboos: '不是数组也丢',
      },
      confidence: 0.6,
    });
    assert.equal(merged.attributes.personality, '嘴硬心软');
    assert.equal(merged.attributes.secretIntent, undefined);
    assert.ok(!('taboos' in merged.attributes), '非数组值整体丢弃');
    assert.deepEqual(merged.attributes.catchphrases, ['绝了', `${'x'.repeat(80)}…`]);

    // null = 删除该字段。
    const afterNull = profile.merge({ sessionId: SESSION, subjectId: SUBJECT, patch: { personality: null } });
    assert.ok(!('personality' in afterNull.attributes));
    assert.deepEqual(afterNull.attributes.catchphrases, ['绝了', `${'x'.repeat(80)}…`], '未提及字段保留');
  } finally {
    close();
  }
});

test('profile：confidence 合成 = 旧×0.7 + 新×0.3；版本自增；锚点并集', async () => {
  const { profile, close } = await fixture();
  try {
    const v1 = profile.merge({ sessionId: SESSION, subjectId: SUBJECT, patch: { personality: 'A' }, confidence: 0.8, sourceMsgIds: ['m1'] });
    assert.equal(v1.version, 1);
    assert.ok(Math.abs(v1.confidence - 0.8) < 1e-9, '无旧值 = 新值');

    const v2 = profile.merge({ sessionId: SESSION, subjectId: SUBJECT, patch: { speakingStyle: '短句' }, confidence: 0.2, sourceMsgIds: ['m2', 'm1'] });
    assert.equal(v2.version, 2);
    assert.ok(Math.abs(v2.confidence - (0.8 * 0.7 + 0.2 * 0.3)) < 1e-9);
    assert.deepEqual(v2.sourceMsgIds, ['m1', 'm2'], '锚点并集去重');
    assert.equal(v2.attributes.personality, 'A', '未提及字段保留');
  } finally {
    close();
  }
});

test('profile：replace 整份覆盖（缺失字段清空）；rollback 回到指定版本；forget 连版本链删除', async () => {
  const { store, profile, close } = await fixture();
  try {
    profile.merge({ sessionId: SESSION, subjectId: SUBJECT, patch: { personality: '旧性格', catchphrases: ['哈哈'] } });
    const replaced = profile.replace({ sessionId: SESSION, subjectId: SUBJECT, patch: { personality: '运维修正' }, confidence: 1 });
    assert.deepEqual(Object.keys(replaced.attributes), ['personality'], 'replace 不保留未提及字段');

    const versions = profile.history(SESSION, SUBJECT, { limit: 10 }).map((item) => item.version);
    assert.deepEqual(versions, [2, 1], '每版一条快照（新→旧）');

    const rolled = profile.rollback({ sessionId: SESSION, subjectId: SUBJECT, toVersion: 1 });
    assert.deepEqual(rolled.attributes.catchphrases, ['哈哈'], '回滚取历史快照内容');
    assert.equal(rolled.version, 3, '回滚本身也是一次版本前进（可再回滚）');

    assert.throws(() => profile.rollback({ sessionId: SESSION, subjectId: SUBJECT, toVersion: 99 }), /not found/);

    assert.equal(profile.forget({ sessionId: SESSION, subjectId: SUBJECT }), true);
    assert.equal(profile.get(SESSION, SUBJECT), null);
    assert.deepEqual(profile.history(SESSION, SUBJECT), [], '被遗忘权连版本链一起删');
    assert.equal(profile.forget({ sessionId: SESSION, subjectId: SUBJECT }), false);
  } finally {
    close();
  }
});

test('profile：JSON 兜底后端语义一致', async () => {
  const { profile, store, close } = await fixture('json');
  try {
    profile.merge({ sessionId: SESSION, subjectId: SUBJECT, patch: { personality: '温和' }, confidence: 0.7 });
    const v2 = profile.merge({ sessionId: SESSION, subjectId: SUBJECT, patch: { taboos: ['别提工资'] }, confidence: 0.9 });
    assert.equal(v2.version, 2);
    assert.ok(Math.abs(v2.confidence - (0.7 * 0.7 + 0.9 * 0.3)) < 1e-9);
    assert.equal(profile.rollback({ sessionId: SESSION, subjectId: SUBJECT, toVersion: 1 }).attributes.personality, '温和');
    assert.equal(store.stats().profile, 1);
  } finally {
    close();
  }
});
