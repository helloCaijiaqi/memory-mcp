// install-dsh.mjs 的行为测试：全部在临时 DSH_HOME 里跑，不碰真实的 ~/.dsh。
// 覆盖点：首次安装、幂等、用户内容零改动、`[]` 初值修复、外部同 id 条目的两种处置、
// --check / --print / --remove / --global、profile 名边界、换行风格跟随。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-dsh.mjs');
const SERVER_SCRIPT = path.join(ROOT, 'src', 'server.mjs');
const SERVICE = { label: 'memory-mcp', id: 'mcp-memory', serverName: 'memory' };
const BEGIN = `# === ${SERVICE.label} MCP BEGIN ===`;
const END = `# === ${SERVICE.label} MCP END ===`;

function makeHome(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-install-test-'));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
  return home;
}

function run(home, args = []) {
  const result = spawnSync(process.execPath, [INSTALLER, ...args], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    cwd: ROOT,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const profilePatch = (home, profile = 'web') => path.join(home, 'profiles', profile, 'cordis.patch.yml');
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const hash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
const countOf = (text, needle) => text.split(needle).length - 1;

test('首次安装：写入自己的区块，id / serverName / 脚本路径都是本服务', () => {
  const home = makeHome();
  const { status } = run(home);
  assert.equal(status, 0);
  const text = read(profilePatch(home));
  assert.equal(countOf(text, BEGIN), 1);
  assert.equal(countOf(text, END), 1);
  assert.match(text, new RegExp(`^\\s*- id: ${SERVICE.id}$`, 'm'));
  assert.match(text, new RegExp(`^\\s*serverName: ${SERVICE.serverName}$`, 'm'));
  // MCP 行必须包在顶层 `- insert:` 里，否则 DSH 只会打一条 warning、根本不新增
  assert.match(text, /^- insert:$/m);
  assert.ok(text.includes(SERVER_SCRIPT.replace(/\\/g, '\\')), 'args 里应写本服务的 server.mjs 绝对路径');
  assert.ok(text.includes(process.execPath), 'command 应写当前 node 的绝对路径');
});

test('幂等：连跑两次字节完全一致', () => {
  const home = makeHome();
  run(home);
  const first = read(profilePatch(home));
  const { status } = run(home);
  assert.equal(status, 0);
  assert.equal(hash(read(profilePatch(home))), hash(first));
});

test('用户内容零改动：已有条目、注释、空数组值全部原样保留', () => {
  const user = [
    '# 用户自己写的注释',
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-web-app/settings"',
    '  config:',
    '    hidden: []',
    '',
    '- insert:',
    '    - id: llm-pi-ai',
    "      name: '@deepseek-ai/dsh-llm-pi-ai'",
    '      config:',
    '        models: []',
    '',
  ].join('\n');
  const home = makeHome({ 'profiles/web/cordis.patch.yml': user });
  assert.equal(run(home).status, 0);
  const text = read(profilePatch(home));
  // 前缀逐字节相同 ⇒ 我们只在自己的区块里动土
  assert.ok(text.startsWith(user), '既有内容必须原样保留在前部');
  assert.ok(text.includes('hidden: []'), '`args: []` 这种行内空数组不能被当成空根删掉');
  assert.equal(countOf(text, BEGIN), 1);
});

test('DSH 建 profile 时的空数组初值 `[]` 会被替换，而不是追加成两个根节点', () => {
  const home = makeHome({ 'profiles/web/cordis.patch.yml': '# 空\n[]\n' });
  assert.equal(run(home).status, 0);
  const text = read(profilePatch(home));
  assert.doesNotMatch(text, /^[ \t]*\[\][ \t]*$/m, '不得留下独立成行的 []');
  assert.equal(countOf(text, BEGIN), 1);
});

test('外部同 id 但指向别处：拒绝写入并保持文件不变', () => {
  const user = ['- insert:', `    - id: ${SERVICE.id}`, "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:', '        serverName: memory', '        transport: stdio', "        command: 'node'",
    '        args:', "          - 'D:/old/place/src/server.mjs'", ''].join('\n');
  const home = makeHome({ 'profiles/web/cordis.patch.yml': user });
  const { status, stderr } = run(home);
  assert.equal(status, 1, '有重复 id 风险时必须失败');
  assert.match(stderr, /手工删掉那条条目/);
  assert.equal(read(profilePatch(home)), user, '失败时不得改动文件');
});

test('外部同 id 且路径一致（别的安装器抹掉了区块标记）：不重复写入，退出码 0', () => {
  const user = ['- insert:', `    - id: ${SERVICE.id}`, "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:', '        serverName: memory', '        transport: stdio', `        command: '${process.execPath.replace(/'/g, "''")}'`,
    '        args:', `          - '${SERVER_SCRIPT.replace(/'/g, "''")}'`, ''].join('\n');
  const home = makeHome({ 'profiles/web/cordis.patch.yml': user });
  const { status, stdout } = run(home);
  assert.equal(status, 0);
  assert.match(stdout, /不重复写入/);
  assert.equal(read(profilePatch(home)), user, '不应追加第二份同 id 条目');
});

test('--check：未登记退出 1，登记后退出 0', () => {
  const home = makeHome();
  assert.equal(run(home, ['--check']).status, 1);
  run(home);
  assert.equal(run(home, ['--check']).status, 0);
});

test('--print 只输出区块，不落盘', () => {
  const home = makeHome();
  const { status, stdout } = run(home, ['--print']);
  assert.equal(status, 0);
  assert.ok(stdout.includes(BEGIN) && stdout.includes(END));
  assert.ok(!fs.existsSync(profilePatch(home)), '--print 不应创建文件');
});

test('--remove 清空后留下合法的空数组根，而不是空文件', () => {
  const home = makeHome();
  run(home);
  assert.equal(run(home, ['--remove']).status, 0);
  const text = read(profilePatch(home));
  assert.ok(!text.includes(BEGIN), '区块应被移除');
  assert.equal(text.trim(), '[]', '空文件会被 DSH 判成非数组，必须留 []');
  // 再移除一次是空操作，不应报错
  assert.equal(run(home, ['--remove']).status, 0);
});

test('--remove 只删自己的区块，别人写的内容照旧', () => {
  const user = ['# 别人的配置', '- id: ui-settings-general', '  name: x', ''].join('\n');
  const home = makeHome({ 'profiles/web/cordis.patch.yml': user });
  run(home);
  run(home, ['--remove']);
  assert.equal(read(profilePatch(home)).trim(), user.trim());
});

test('--global 写 home 层，profile 文件不受影响', () => {
  const home = makeHome();
  assert.equal(run(home, ['--global']).status, 0);
  assert.ok(read(path.join(home, 'cordis.patch.yml')).includes(BEGIN));
  assert.ok(!fs.existsSync(profilePatch(home)));
  assert.equal(run(home, ['--global', '--check']).status, 0);
});

test('profile 名边界：带路径分隔符或 .. 的一律拒绝', () => {
  const home = makeHome();
  for (const bad of ['../x', 'a/b', 'a\\b', '..', 'node_modules']) {
    const { status } = run(home, [bad]);
    assert.equal(status, 1, `profile ${bad} 应被拒绝`);
  }
  assert.equal(run(home, ['-x']).status, 1, '未知参数应被拒绝');
});

test('换行风格跟随现有文件（CRLF 文件写入 CRLF 区块）', () => {
  const home = makeHome({ 'profiles/web/cordis.patch.yml': '- id: ui-settings-general\r\n  name: x\r\n' });
  assert.equal(run(home).status, 0);
  const raw = fs.readFileSync(profilePatch(home), 'utf8');
  assert.equal(raw.split('\n').length - 1, (raw.match(/\r\n/g) ?? []).length, '不应混入裸 LF 行');
});
