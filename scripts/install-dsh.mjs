#!/usr/bin/env node
// install-dsh.mjs — 把 memory-mcp 登记成 DSH 的一个 MCP server（本服务自己的安装器）。
//
// 为什么不再由 qq-bridge/scripts/setup-dsh.mjs 代劳：
//   ① 那个脚本是 QQ 桥接的安装器：除了挂 MCP，它还要注册 bundle、重建 preset patch、
//      写 qq-bridge/state/mode.json。本服务为了挂一条 MCP 去跑别人的安装器，是把
//      「谁能装我」和「谁需要我」绑在一起——桥接换机器、换目录，本服务就被迫跟着重装。
//   ② 它把 cordis.patch.yml 整体 yaml.load → yaml.dump 重写，注释与手写格式全部丢失。
//      两个兄弟包各自维护条目时，谁都不是这份文件的唯一主人；只要有人整体重写，
//      别人的区块标记就没了。所以这里改成**只追加/替换自己的一段注释包裹区块**，
//      其余字节一律不动（包括别人的区块、注释和空行）。
//
// DSH 的加载规则（0.1.7+，见 DSH 自带 docs/subsystems/mcp.md）：
//   · profile 层：<DSH_HOME>/profiles/<profile>/cordis.patch.yml
//   · home 层：  <DSH_HOME>/cordis.patch.yml —— 对所有 profile 生效，且优先级更高
//   文件必须是**顶层 YAML 数组**，MCP server 写成一条 `- insert:` 里的
//   @deepseek-ai/dsh-mcp-client 行（id 在全树唯一、serverName 在同一 scope 内唯一）。
//   改完不需要 npm install、也不需要重启 DSH：新建会话即可看到工具（mcp__memory__*）。
//
// 用法：
//   node scripts/install-dsh.mjs                # 装进 web profile
//   node scripts/install-dsh.mjs work           # 装进 work profile
//   node scripts/install-dsh.mjs --global       # 装进 home 层（所有 profile 生效）
//   node scripts/install-dsh.mjs --check        # 只检查登记状态；缺失/路径不符退出码 1
//   node scripts/install-dsh.mjs --print        # 只打印将要写入的区块，不落盘
//   node scripts/install-dsh.mjs --remove       # 移除本服务的区块
//   DSH_HOME=/path/to/.dsh node scripts/install-dsh.mjs <profile>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_SCRIPT = path.join(REPO_ROOT, 'src', 'server.mjs');

// 这三项是 DSH 侧的契约：id 是全树唯一键，serverName 决定工具名（mcp__memory__*）。
// 改名等于工具改名，桥接侧 prompt 里引用的工具名会全部失效，所以故意写成常量而不是参数。
const SERVICE = { label: 'memory-mcp', id: 'mcp-memory', serverName: 'memory' };

const BEGIN = `# === ${SERVICE.label} MCP BEGIN ===`;
const END = `# === ${SERVICE.label} MCP END ===`;

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

function log(msg) {
  console.log(`[install-dsh] ${msg}`);
}

function fatal(msg) {
  console.error(`[install-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { profile: 'web', profileGiven: false, global: false, check: false, print: false, remove: false };
  for (const arg of argv) {
    if (arg === '--global') opts.global = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--print') opts.print = true;
    else if (arg === '--remove') opts.remove = true;
    else if (arg.startsWith('-')) fatal(`未知参数：${arg}（可用：--global --check --print --remove）`);
    else if (opts.profileGiven) fatal('只能给一个 profile 名');
    else { opts.profile = arg; opts.profileGiven = true; }
  }
  if (opts.global && opts.profileGiven) fatal('--global 与 profile 名互斥：home 层对所有 profile 生效');
  // 与 DSH 自己的 resolveProfileDir 同一边界：profile 是目录名，不是路径。
  const { profile } = opts;
  if (profile === '.' || profile === '..' || profile === 'node_modules'
      || /[\\/\x00-\x1f<>:"|?*]/.test(profile) || /[. ]$/.test(profile)) {
    fatal(`非法 profile 名：${JSON.stringify(profile)}（只能是单个目录名）`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const target = opts.global
  ? path.join(DSH_HOME, 'cordis.patch.yml')
  : path.join(DSH_HOME, 'profiles', opts.profile, 'cordis.patch.yml');

// YAML 里单引号字符串要写成 ''；不改写用户文件，只为让 Windows 路径里的反斜杠/冒号安全。
function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function pickEol(text) {
  // 跟着现有文件的换行风格走，避免一次安装把整份文件的 diff 变成「全行改动」。
  if (!text) return '\n';
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return crlf > 0 && crlf === lf ? '\r\n' : '\n';
}

function buildBlock(eol) {
  // 顶层序列的一项：`- insert:` 后面才是 loader entry。
  // 注意不能照抄 mcp-client 的 README（那是 loader entry list 的形态，直接写进 patch
  // 会被 applyEntryPatches 当成「改已有行」，只打 warning、根本不新增）。
  const lines = [
    BEGIN,
    `# 由 ${SERVICE.label}/scripts/install-dsh.mjs 维护：整段会被替换，请勿手工编辑内部条目。`,
    '# 卸载：node scripts/install-dsh.mjs --remove',
    '- insert:',
    `    - id: ${SERVICE.id}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${SERVICE.serverName}`,
    '        transport: stdio',
    `        command: ${yamlQuote(process.execPath)}`,
    '        args:',
    `          - ${yamlQuote(SERVER_SCRIPT)}`,
    END,
  ];
  return `${lines.join(eol)}${eol}`;
}

/** 剥掉本脚本写的那段区块（含标记行与其后换行），其余字节原样返回。 */
function stripBlock(text) {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin === -1 && end === -1) return { hasBlock: false, rest: text };
  if (begin === -1 || end === -1 || end < begin) {
    fatal(`托管标记不完整（只找到 BEGIN 或 END）：${target}\n  请先手工删掉残留的标记行后重跑。`);
  }
  const afterEnd = text.indexOf('\n', end);
  return { hasBlock: true, rest: text.slice(0, begin) + (afterEnd === -1 ? '' : text.slice(afterEnd + 1)) };
}

/**
 * 拼出最终文件文本：用户内容在前，本服务区块在后。
 *
 * 唯一需要特判的历史形态是「整份文件就是一个空数组根 `[]`」（DSH 建 profile 时的初值）：
 * 在 `[]` 后面再追加 `- insert:` 会变成两个根节点，DSH 直接报
 * "must be a top-level YAML array"。`[]` 出现在 `args: []` 这种位置不受影响，
 * 因为这里只认「整行只有一个 []」。
 */
function compose(rest, block) {
  let body = rest.replace(/^\uFEFF/, '');
  const structural = body.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  const bareRoots = structural.filter((line) => /^[ \t]*\[\][ \t]*$/.test(line));
  if (bareRoots.length) {
    if (structural.length > bareRoots.length) {
      fatal(`文件里同时存在空数组根 [] 和其他条目，YAML 已不合法：${target}\n  请先手工修好这份文件再重跑（本次未写入）。`);
    }
    body = '';
  }
  body = body.replace(/\s+$/, '');
  return body ? `${body}${eol}${eol}${block}` : block;
}

/** 找「不在本脚本区块里」的同 id 条目——那是手工写的或别的安装器留下的。 */
function findForeignEntry(text) {
  const re = new RegExp(`^[ \\t]*-[ \\t]*id:[ \\t]*['"]?${SERVICE.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?[ \\t]*$`, 'm');
  const match = re.exec(text);
  if (!match) return null;
  // 顺着这条 entry 往后找 args 的第一项，判断它指向的是不是当前这份代码。
  const chunk = text.slice(match.index, match.index + 800);
  const argLine = /args:\s*\r?\n\s*-\s*['"]?([^'"\r\n]+)['"]?/.exec(chunk);
  return { index: match.index, script: argLine ? argLine[1].trim() : '' };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const samePath = (a, b) => {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
};

const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
const eol = pickEol(current);
const block = buildBlock(eol);
const { hasBlock, rest } = stripBlock(current);

if (opts.print) {
  process.stdout.write(block);
  process.exit(0);
}

if (opts.check) {
  if (hasBlock) {
    if (current.includes(yamlQuote(SERVER_SCRIPT))) {
      log(`已登记到 ${target}`);
      process.exit(0);
    }
    log(`区块存在但指向旧路径（当前应为 ${SERVER_SCRIPT}）：${target}`);
    process.exit(1);
  }
  const foreign = findForeignEntry(current);
  if (foreign && samePath(foreign.script, SERVER_SCRIPT)) {
    log(`已由外部条目登记（同一路径，不在本脚本托管的区块内）：${target}`);
    process.exit(0);
  }
  log(`未登记到 DSH：${target}（跑 node scripts/install-dsh.mjs 安装）`);
  process.exit(1);
}

if (opts.remove) {
  if (!hasBlock) {
    log(`没有找到本服务的区块，无需移除：${target}`);
    process.exit(0);
  }
  const nextBody = rest.replace(/^\uFEFF/, '').replace(/\s+$/, '');
  // 空的 patch 文件会被 DSH 判成 "must be a top-level YAML array"（load 返回 undefined），
  // 所以清空后必须留一个合法的空数组根。
  const next = nextBody ? `${nextBody}${eol}` : `[]${eol}`;
  writeAtomic(target, next);
  log(`已移除本服务区块：${target}（其余内容未改动）`);
  log('新建 DSH 会话后生效（无需重启）。');
  process.exit(0);
}

// ── 安装 ────────────────────────────────────────────────────────────────────
const foreign = findForeignEntry(rest);
if (foreign) {
  if (samePath(foreign.script, SERVER_SCRIPT)) {
    // 常见来源：qq-bridge 的 setup-dsh 曾代为登记；它整体 yaml.dump 重写，会把别人的
    // 区块注释抹掉但保留条目。这种情况条目本身是对的，再追加一份就成了重复 id，只报告。
    log('检测到同 id、同路径的条目，但它不在本脚本托管的区块内（通常由 qq-bridge 的 setup-dsh 写入，或区块标记被别的安装器整体重写抹掉）。');
    log('条目有效，不重复写入（重复 loader id 会让 DSH 启动失败）。');
    log(`位置：${target}`);
    log('若要让本脚本重新纳管，先手工删掉那条 id 条目再重跑。');
    process.exit(0);
  }
  fatal(`patch 里已有 id=${SERVICE.id} 的条目，但它指向 ${foreign.script || '(读不出 args)'}\n`
    + `  而当前代码在 ${SERVER_SCRIPT}。为避免 DSH 出现重复 loader id，本次未写入。\n`
    + `  处理：手工删掉那条条目后重跑本脚本。`);
}

const next = compose(rest, block);
if (next === current) {
  log(`已是最新：${target}`);
} else {
  writeAtomic(target, next);
  log(`已写入：${target}`);
}
log(`本服务作为 ${SERVICE.id}（serverName=${SERVICE.serverName}）登记，工具名 mcp__${SERVICE.serverName}__*`);
log('新建 DSH 会话即可看到工具（无需重启 DSH）。');
