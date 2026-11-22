// gateway.json 读取器专项：只在启动时读一次，所以每个失败分支都必须把「怎么修」
// 写清楚——否则运维只能看到「没连上网关」而不知道是文件没复制还是密钥路径错了。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { GATEWAY_CONFIG_FILE, gatewayConfigPath, loadGatewayConfig, assertNoLegacyEnv } =
  await import(new URL('../src/gateway-config.js', import.meta.url).href);

const PREFIX = 'MEMORY_MCP_';
const SECRET = 'c'.repeat(32);

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-gwcfg-'));
}

function writeGateway(root, doc) {
  const file = gatewayConfigPath(root);
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n');
  return file;
}

function baseDoc(extra = {}) {
  return { v: 1, id: 'memory-mcp', kind: 'service', url: 'http://127.0.0.1:7190', transport: 'http', ...extra };
}

test('缺文件：返回 null（不接网关），只提示一次', () => {
  const root = tmpRoot();
  const hints = [];
  assert.equal(loadGatewayConfig({ root, env: {}, envPrefix: PREFIX, logger: (m) => hints.push(m) }), null);
  assert.equal(hints.length, 1);
  assert.match(hints[0], /不接入网关[\s\S]*stdio/);
  // 第二次不再刷屏。
  loadGatewayConfig({ root, env: {}, envPrefix: PREFIX, logger: (m) => hints.push(m) });
  assert.equal(hints.length, 1);
});

test('读取：secretFile 相对路径按 gateway.json 目录解析、trim 换行', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secrets', 'm.secret'), `${SECRET}\n`);
  const file = writeGateway(root, baseDoc({ secretFile: 'secrets/m.secret' }));

  const cfg = loadGatewayConfig({ root, env: {}, envPrefix: PREFIX });
  assert.equal(cfg.id, 'memory-mcp');
  assert.equal(cfg.url, 'http://127.0.0.1:7190');
  assert.equal(cfg.transport, 'http');
  assert.equal(cfg.secret, SECRET);
  assert.equal(cfg.auth, 'secretFile');
  assert.equal(cfg.secretFile, path.join(root, 'secrets', 'm.secret'));
  assert.equal(cfg.file, file);
});

test('读取：内联 secret 可用；并存时以 secretFile 为准并告警', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secrets', 'k.secret'), `${SECRET}\n`);

  writeGateway(root, baseDoc({ secret: 'd'.repeat(32) }));
  assert.equal(loadGatewayConfig({ root, env: {}, envPrefix: PREFIX }).auth, 'inline');

  writeGateway(root, baseDoc({ secret: 'd'.repeat(32), secretFile: 'secrets/k.secret' }));
  const warnings = [];
  const cfg = loadGatewayConfig({ root, env: {}, envPrefix: PREFIX, logger: (m) => warnings.push(m) });
  assert.equal(cfg.auth, 'secretFile');
  assert.equal(cfg.secret, SECRET);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /以 secretFile 为准/);
});

test('读取：失败分支都指向可操作动作', () => {
  const root = tmpRoot();

  writeGateway(root, baseDoc({ v: 2 }));
  assert.throws(() => loadGatewayConfig({ root, env: {}, envPrefix: PREFIX }), /v=2 不受支持/);

  writeGateway(root, baseDoc({ id: 'Memory MCP' }));
  assert.throws(() => loadGatewayConfig({ root, env: {}, envPrefix: PREFIX }), /id="Memory MCP" 不合法/);

  writeGateway(root, baseDoc({ url: 'ftp://127.0.0.1' }));
  assert.throws(() => loadGatewayConfig({ root, env: {}, envPrefix: PREFIX }), /url 只支持 http\/https/);

  // 传输按角色非对称：资源服务纯被动，只允许 http（WS 能力已退役），给迁移文案。
  writeGateway(root, baseDoc({ transport: 'ws' }));
  assert.throws(
    () => loadGatewayConfig({ root, env: {}, envPrefix: PREFIX }),
    /资源服务只支持 http[\s\S]*WS 能力已退役[\s\S]*"transport": "ws" → "transport": "http"/,
  );
  writeGateway(root, baseDoc({ transport: 'auto' }));
  assert.throws(() => loadGatewayConfig({ root, env: {}, envPrefix: PREFIX }), /资源服务只支持 http/);

  writeGateway(root, baseDoc({ secretFile: 'secrets/none.secret' }));
  assert.throws(() => loadGatewayConfig({ root, env: {}, envPrefix: PREFIX }), /secretFile 无法读取[\s\S]*none\.secret/);

  writeGateway(root, baseDoc({ secret: 'short' }));
  assert.throws(() => loadGatewayConfig({ root, env: {}, envPrefix: PREFIX }), /secret 太短/);

  // secretEnv 登记的降级：文件里没有可读明文时要能指明原因。
  writeGateway(root, baseDoc({ authNote: '登记使用 secretEnv=FOO' }));
  assert.throws(() => loadGatewayConfig({ root, env: {}, envPrefix: PREFIX }), /没有密钥[\s\S]*secretEnv/);

  // BOM（Windows 编辑器常见）不能判非法。
  writeGateway(root, `\uFEFF${JSON.stringify(baseDoc({ secret: SECRET }))}`);
  assert.equal(loadGatewayConfig({ root, env: {}, envPrefix: PREFIX }).secret, SECRET);
});

test('退役环境变量：残留即报错，并指明改用哪个文件', () => {
  const root = tmpRoot();
  writeGateway(root, baseDoc({ secret: SECRET }));
  assert.throws(
    () => loadGatewayConfig({ root, env: { [`${PREFIX}GATEWAY_SECRET`]: SECRET }, envPrefix: PREFIX }),
    /已退役的环境变量：MEMORY_MCP_GATEWAY_SECRET[\s\S]*gateway\.json[\s\S]*删除这些环境变量/,
  );
  // 空串不算「设置了」——批处理里 `set X=` 的清理写法不该挡住启动。
  assert.equal(
    loadGatewayConfig({ root, env: { [`${PREFIX}GATEWAY_SECRET`]: '  ' }, envPrefix: PREFIX }).secret,
    SECRET,
  );
});

test('assertNoLegacyEnv：四个键都能识别；无 prefix 直接拒绝', () => {
  const env = {
    MEMORY_MCP_GATEWAY_SECRET: 'x',
    MEMORY_MCP_GATEWAY_ID: 'y',
    MEMORY_MCP_GATEWAY_WS_URL: 'z',
    MEMORY_MCP_GATEWAY_TRANSPORT: 'auto',
  };
  assert.throws(() => assertNoLegacyEnv({ env, prefix: PREFIX }), /SECRET.*ID.*WS_URL.*TRANSPORT/s);
  assert.doesNotThrow(() => assertNoLegacyEnv({ env: {}, prefix: PREFIX }));
  assert.throws(() => assertNoLegacyEnv({ env }), /需要 prefix/);
});

test('常量：文件名固定为 gateway.json', () => {
  assert.equal(GATEWAY_CONFIG_FILE, 'gateway.json');
  assert.equal(path.basename(gatewayConfigPath('/x')), 'gateway.json');
});
