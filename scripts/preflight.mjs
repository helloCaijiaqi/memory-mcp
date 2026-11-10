#!/usr/bin/env node
// 部署前自检：一条命令回答「这台机器现在能不能跑这个服务」。
//
// 为什么需要它：这两个服务没有构建步骤，所以"发布闸门"只能在运行时环境上做——
// Node 版本（node:sqlite）、依赖是否装全、数据目录能不能写、令牌在不在、端口归谁。
// 端口被占用默认只提醒：生产上往往就是"本服务已经在跑"，那是正常状态。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { openStore } from '../src/store/store-api.js';
import { SCHEMA_VERSION } from '../src/store/sqlite-schema.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = createRequire(import.meta.url)('../package.json');
const REQUIRED_MAJOR = 24;
const SERVER_SCRIPT = path.join(PKG_ROOT, 'src', 'server.mjs');
const DSH_MCP_ID = 'mcp-memory';
const DAY_MS = 24 * 60 * 60 * 1000;

const results = [];
// 输出走「当前日志器」：被测试或巡检脚本复用时，不该把结论直接喷到调用方的 stdout。
let currentLogger = (...args) => console.log(...args);

function record(level, name, detail) {
  results.push({ level, name, detail });
  const mark = level === 'fail' ? '✗' : level === 'warn' ? '⚠' : '✓';
  currentLogger(`[preflight] ${mark} ${name}：${detail}`);
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < REQUIRED_MAJOR) {
    record('fail', 'node 版本', `v${process.versions.node} 太低（要求 >=${REQUIRED_MAJOR}：node:sqlite 在 24 之前要带 --experimental-sqlite）`);
    return;
  }
  record('ok', 'node 版本', `v${process.versions.node}`);
}

async function checkDeps() {
  const probes = [['@modelcontextprotocol/sdk/server/mcp.js', '@modelcontextprotocol/sdk'], ['zod', 'zod']];
  for (const [spec, label] of probes) {
    try {
      await import(spec);
      // package.json 未必在 exports 里，读不到版本不算失败。
      let version = '';
      try {
        version = createRequire(import.meta.url)(`${label}/package.json`)?.version ?? '';
      } catch {
        version = '';
      }
      record('ok', `依赖 ${label}`, version ? `已安装（${version}）` : '已安装');
    } catch (error) {
      record('fail', `依赖 ${label}`, `加载失败：${error?.message ?? error}（先跑 npm ci）`);
    }
  }
}

function checkStateDir(stateDir) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const probe = path.join(stateDir, '.preflight-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    record('ok', '数据目录', `${stateDir}（可写）`);
  } catch (error) {
    record('fail', '数据目录', `${stateDir} 不可写：${error?.message ?? error}`);
  }
}

function checkToken(tokenFile) {
  if (!fs.existsSync(tokenFile)) {
    record('warn', '本地令牌', `${tokenFile} 尚不存在，首次启动会生成（桥接需重启才能读到新令牌）`);
    return;
  }
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    record(token ? 'ok' : 'warn', '本地令牌', token ? `已存在（${token.length} 字符）` : '文件存在但为空，启动时会重新生成');
  } catch (error) {
    record('fail', '本地令牌', `读取失败：${error?.message ?? error}`);
  }
}

/** 分层注入的灰度开关：不是「配了没」，而是「现在这副身体跑的是哪套注入」。 */
function checkLayers(env) {
  const off = String(env.MEMORY_LAYERS_V2 ?? '') === '0';
  record(
    off ? 'warn' : 'ok',
    '分层注入',
    off
      ? '已关闭（MEMORY_LAYERS_V2=0）：只保留旧接口与单块【记忆】，head/tail/关系/召回路由返回 404'
      : '启用：head 冻结 + tail 动态，原始层 / 关系 / 召回路由已注册',
  );
}

/** 平台白名单：新平台接入前最该确认的一条 —— 是「放行并告警」还是「直接拒绝」。 */
function checkPlatforms(env) {
  const known = String(env.MEMORY_MCP_PLATFORMS ?? 'qq')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const strict = String(env.MEMORY_MCP_PLATFORM_STRICT ?? '') === '1';
  record(
    'ok',
    '平台白名单',
    `${known.length ? known.join('、') : '(不设限)'}${strict ? '（strict：未知平台拒绝写入）' : '（未知平台放行并告警一次）'}`,
  );
}

function countArchiveFiles(dir) {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of fs.readdirSync(path.join(dir, entry.name))) {
        if (name.endsWith('.jsonl.gz')) count += 1;
      }
    }
  } catch {
    /* 还没归档过：目录不存在是正常状态 */
  }
  return count;
}

/**
 * 记忆库体检：只读打开，不建表、不迁移、不落盘 —— 自检不该改动被检查的东西。
 * 关心四件事：库版本（落后于代码会静默缺列）、归档积压（不归档会一直占着库）、
 * head 快照数（有快照的会话才谈得上复用前缀）、按平台的真实数据分布。
 */
async function checkStore(stateDir, env) {
  if (!fs.existsSync(path.join(stateDir, 'memory.db'))) {
    record('warn', '记忆库', '尚无 memory.db（首次启动时创建；此前只有黑话/空库也属正常）');
    return;
  }
  let store;
  try {
    store = await openStore({ dir: stateDir, readonly: true });
  } catch (error) {
    record('fail', '记忆库', `只读打开失败：${error?.message ?? error}`);
    return;
  }
  try {
    const stats = store.stats();
    record(
      'ok',
      '记忆库',
      `只读巡检 · schema v${store.schemaVersion ?? '?'}（${store.backend}）· 记忆 ${stats.memory} · 原文 ${stats.raw} · 关系 ${stats.relation} · head 快照 ${stats.snapshot}`,
    );

    // 只读巡检不迁移，所以「库落后于代码」只能报警、不能在自检里顺手升库。
    const current = Number(store.schemaVersion ?? 0);
    if (store.backend === 'sqlite' && current < SCHEMA_VERSION) {
      record(
        'warn',
        '库版本',
        `schema v${current} < 代码 v${SCHEMA_VERSION}：下次启动会自动迁移（自检不写库）；迁移前原始层/关系表不可用`,
      );
      return;
    }

    const retention = Number(env.MEMORY_MCP_RAW_RETENTION_DAYS ?? 30);
    const cutoff = Date.now() - Math.max(0, retention) * DAY_MS;
    const backlog = typeof store.raw?.count === 'function' ? store.raw.count({ until: cutoff }) : 0;
    record(
      backlog > 0 ? 'warn' : 'ok',
      '原文归档积压',
      backlog > 0
        ? `${backlog} 条超过 ${retention} 天未归档（npm run archive 处理；不归档会一直占着库）`
        : `无（保留 ${retention} 天）`,
    );

    const archives = countArchiveFiles(path.join(stateDir, 'raw-archive'));
    if (archives) record('ok', '归档分片', `${archives} 个 .jsonl.gz（按平台分目录）`);

    const platforms = typeof store.platformStats === 'function' ? store.platformStats() : [];
    record(
      'ok',
      '平台分布',
      platforms.length
        ? platforms
            .map((item) => `${item.platform}：记忆 ${item.memory} / 原文 ${item.raw} / 关系 ${item.relation}`)
            .join('；')
        : '暂无数据',
    );
  } finally {
    store.close();
  }
}

/**
 * DSH 侧的登记状态：只提醒，不算失败。
 *
 * 本服务有两条对外通道：stdio MCP（DSH 派生进程）和回环 HTTP（桥接调用）。
 * 只配桥接、不装 DSH 也是合法部署，所以这里不 fail。
 * 判断方式刻意不用 YAML 解析：只看两件事——本服务的 id 在不在、args 指向的是不是这份代码。
 * 目录与 install-dsh.mjs 一致：home 层对所有 profile 生效，profile 层只对一个生效。
 */
function checkDshEntry(env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profile = env.DSH_PROFILE || 'web';
  const idRe = new RegExp(`^\\s*-\\s*id:\\s*['"]?${DSH_MCP_ID}['"]?\\s*$`, 'm');
  const found = [];
  for (const file of [path.join(home, 'cordis.patch.yml'), path.join(home, 'profiles', profile, 'cordis.patch.yml')]) {
    if (!fs.existsSync(file)) continue;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      record('warn', 'DSH 登记', `${file} 读不了：${error?.message ?? error}`);
      continue;
    }
    if (idRe.test(text)) found.push({ file, samePath: text.includes(SERVER_SCRIPT) });
  }
  if (!found.length) {
    record('warn', 'DSH 登记', `未在 ${home} 的 patch 里登记（npm run install:dsh 可登记；只用回环 HTTP 时可忽略）`);
    return;
  }
  const stale = found.filter((hit) => !hit.samePath);
  if (stale.length) {
    record('warn', 'DSH 登记', `${stale[0].file} 的条目指向别处（应为 ${SERVER_SCRIPT}）：重跑 npm run install:dsh 后新建 DSH 会话`);
    return;
  }
  record('ok', 'DSH 登记', `${found[0].file}（${DSH_MCP_ID} → 本目录）`);
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        record('warn', 'HTTP 端口', `${host}:${port} 已被占用（若已有实例在跑即正常；否则新实例会降级为 stdio-only，MCP 工具仍可用）`);
      } else {
        record('warn', 'HTTP 端口', `${host}:${port} 无法绑定：${error?.code ?? error}`);
      }
      resolve();
    });
    server.listen(port, host, () => {
      server.close(() => {
        record('ok', 'HTTP 端口', `${host}:${port} 可用`);
        resolve();
      });
    });
  });
}

export async function preflight({ env = process.env, logger = console.log } = {}) {
  // 每次调用都从空结论开始：CLI 只跑一次，但被测试/巡检复用时会累加上一次的条目。
  results.length = 0;
  currentLogger = typeof logger === 'function' ? logger : console.log;
  // 与 server.mjs 的 resolveConfig 同一条解析顺序：旧名字 MEMORY_MCP_DATA_DIR 也认。
  const stateDir = path.resolve(env.MEMORY_MCP_STATE_DIR ?? env.MEMORY_MCP_DATA_DIR ?? path.join(PKG_ROOT, 'state'));
  const port = Number(env.MEMORY_MCP_HTTP_PORT ?? 7181);

  checkNode();
  await checkDeps();
  checkStateDir(stateDir);
  checkToken(path.join(stateDir, 'http-token'));
  checkLayers(env);
  checkPlatforms(env);
  await checkStore(stateDir, env);
  checkDshEntry(env);
  await checkPort('127.0.0.1', port);

  const failed = results.filter((r) => r.level === 'fail').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  logger(`[preflight] 结论：${failed ? `不可用（${failed} 项失败）` : '可运行'}${warned ? `（${warned} 项提醒）` : ''}`);
  return { failed, warned, results };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const { failed } = await preflight();
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error('[preflight] 自检本身失败：', error?.stack ?? error);
    process.exitCode = 1;
  }
}
