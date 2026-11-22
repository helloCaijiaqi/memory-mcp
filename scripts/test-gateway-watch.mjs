// gateway.json 热加载监视器专项：缺失/出现/变更/非法/修复/删除全生命周期，
// 以及「内容未变不重复触发」的幂等性。全离线（临时目录 + refresh 手动驱动，
// 不依赖真实轮询时钟）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createGatewayWatcher } = await import(new URL('../src/gateway-watch.js', import.meta.url).href);
const { gatewayConfigPath } = await import(new URL('../src/gateway-config.js', import.meta.url).href);

const PREFIX = 'MEMORY_MCP_';
const SECRET = 'c'.repeat(32);

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-gwwatch-'));
}

function writeGateway(root, doc) {
  fs.writeFileSync(gatewayConfigPath(root), JSON.stringify(doc, null, 2) + '\n');
}

const baseDoc = (extra = {}) => ({
  v: 1, id: 'memory-mcp', url: 'http://127.0.0.1:7190', transport: 'http', ...extra,
});

test('watcher 生命周期：缺失→出现→变更→非法→修复→删除', () => {
  const root = tmpRoot();
  const logs = [];
  const w = createGatewayWatcher({ root, env: {}, envPrefix: PREFIX, logger: (m) => logs.push(m) });
  try {
    // 初始缺失：config=null 且 error=null（缺失不是非法）。
    assert.equal(w.current().config, null);
    assert.equal(w.current().error, null);
    assert.equal(w.current().file, gatewayConfigPath(root));

    // 出现 → 生效。
    writeGateway(root, baseDoc({ secret: SECRET }));
    w.refresh();
    assert.equal(w.current().config.id, 'memory-mcp');
    assert.equal(w.current().config.secret, SECRET);

    // 变更（重写换密钥）→ 热加载新值。
    writeGateway(root, baseDoc({ secret: 'd'.repeat(32) }));
    w.refresh();
    assert.equal(w.current().config.secret, 'd'.repeat(32));

    // 非法（transport=auto，资源服务只认 http）→ 摘除 + error 留痕。
    writeGateway(root, baseDoc({ secret: 'd'.repeat(32), transport: 'auto' }));
    w.refresh();
    assert.equal(w.current().config, null);
    assert.match(w.current().error, /只支持 http/);

    // 修复 → 自动恢复生效。
    writeGateway(root, baseDoc({ secret: 'd'.repeat(32) }));
    w.refresh();
    assert.equal(w.current().config.transport, 'http');

    // 删除 → 摘除（error=null：缺失与非法在 health 里可区分）。
    fs.unlinkSync(gatewayConfigPath(root));
    w.refresh();
    assert.equal(w.current().config, null);
    assert.equal(w.current().error, null);

    // 关键事件全部留痕（运维不用盯轮询）。
    assert.ok(logs.some((m) => /已加载/.test(m)), '初始加载有日志');
    assert.ok(logs.some((m) => /变更已热加载/.test(m) && /无需重启/.test(m)), '变更有日志');
    assert.ok(logs.some((m) => /非法/.test(m)), '非法有日志');
    assert.ok(logs.some((m) => /已移除/.test(m)), '移除有日志');
  } finally {
    w.stop();
  }
});

test('watcher 幂等：内容未变的重复 refresh 不重复触发日志/状态翻转', () => {
  const root = tmpRoot();
  const logs = [];
  const w = createGatewayWatcher({ root, env: {}, envPrefix: PREFIX, logger: (m) => logs.push(m) });
  try {
    writeGateway(root, baseDoc({ secret: SECRET }));
    w.refresh();
    assert.equal(w.current().config.id, 'memory-mcp');
    const logged = logs.length;
    w.refresh();
    w.refresh();
    assert.equal(logs.length, logged, '内容未变不产生新日志');
    assert.equal(w.current().config.secret, SECRET);
  } finally {
    w.stop();
  }
});
