// 部署自检自身的测试：老库/新库/空目录三种状态下都要给出结论，且**不写库**。
// 自检坏了比服务坏了更隐蔽：它会在「一切正常」的错觉里放行。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/store-api.js';
import { SCHEMA_VERSION } from '../src/store/sqlite-schema.js';
import { createMemoryService } from '../src/service/memory-service.js';
import { createRelationService } from '../src/service/relation-service.js';
import { preflight } from './preflight.mjs';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-preflight-'));
const QQ = 'qq:group:60001';
const WX = 'wx:room:60001';

function tmpState() {
  return fs.mkdtempSync(path.join(TMP_ROOT, 'state-'));
}

function envFor(stateDir, extra = {}) {
  return {
    MEMORY_MCP_STATE_DIR: stateDir,
    MEMORY_MCP_HTTP_PORT: '0',
    MEMORY_MCP_TOKEN: 'preflight-token',
    ...extra,
  };
}

function names(result, level) {
  return result.results.filter((item) => item.level === level).map((item) => item.name);
}

test('preflight：空目录只提醒、不失败（首次部署也要能过闸门）', async () => {
  const dir = tmpState();
  const result = await preflight({ env: envFor(dir), logger: () => {} });
  assert.equal(result.failed, 0);
  assert.ok(names(result, 'warn').includes('记忆库'), '没有库时应提醒，而不是报错');
  const layers = result.results.find((item) => item.name === '分层注入');
  assert.equal(layers.level, 'ok', '默认启用分层注入');
  const platforms = result.results.find((item) => item.name === '平台白名单');
  assert.ok(platforms.detail.includes('qq'), `应报出默认白名单，实际：${platforms.detail}`);
});

test('preflight：已迁移的库能读出 schema 版本与平台分布', async () => {
  const dir = tmpState();
  const store = await openStore({ dir, backend: 'sqlite' });
  try {
    const memory = createMemoryService({ store });
    memory.append({ sessionId: QQ, tier: 'long', content: '用户讨厌被敷衍' });
    memory.ingest({ sessionId: WX, msgId: 'pf1', text: '微信的一条原文' });
    createRelationService({ store }).upsert({ sessionId: QQ, subjectId: '10001', key: '称呼', value: '老王' });
    memory.renderHead({ sessionId: QQ, force: true });
  } finally {
    store.close();
  }

  const before = fs.statSync(path.join(dir, 'memory.db')).mtimeMs;
  const result = await preflight({ env: envFor(dir), logger: () => {} });
  assert.equal(result.failed, 0);

  const dbItem = result.results.find((item) => item.name === '记忆库');
  assert.equal(dbItem.level, 'ok');
  assert.ok(dbItem.detail.includes(`schema v${SCHEMA_VERSION}`), `应报告库版本，实际：${dbItem.detail}`);
  assert.ok(dbItem.detail.includes('记忆 1'), `应报告记忆行数（raw-only 下 ingest 不再产生记忆行），实际：${dbItem.detail}`);
  assert.ok(dbItem.detail.includes('原文 1'));
  assert.ok(dbItem.detail.includes('head 快照 1'));
  assert.ok(dbItem.detail.includes('只读巡检'), '自检不该以可写模式打开库');

  const platforms = result.results.find((item) => item.name === '平台分布');
  assert.ok(platforms.detail.includes('qq') && platforms.detail.includes('wx'), platforms.detail);

  // 只读巡检最硬的一条：跑完自检，库文件的修改时间不变。
  assert.equal(fs.statSync(path.join(dir, 'memory.db')).mtimeMs, before, 'preflight 不得写库');
});

test('preflight：MEMORY_LAYERS_V2=0 时明确告知回退状态', async () => {
  const dir = tmpState();
  const result = await preflight({ env: envFor(dir, { MEMORY_LAYERS_V2: '0' }), logger: () => {} });
  const layers = result.results.find((item) => item.name === '分层注入');
  assert.equal(layers.level, 'warn');
  assert.ok(layers.detail.includes('404'), '应说明新路由会返回 404');
});
