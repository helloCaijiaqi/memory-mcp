#!/usr/bin/env node
// 部署前自检：一条命令回答「这台机器现在能不能跑这个服务」。
//
// 为什么需要它：这两个服务没有构建步骤，所以"发布闸门"只能在运行时环境上做——
// Node 版本（node:sqlite）、依赖是否装全、数据目录能不能写、令牌在不在、端口归谁。
// 端口被占用默认只提醒：生产上往往就是"本服务已经在跑"，那是正常状态。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = createRequire(import.meta.url)('../package.json');
const REQUIRED_MAJOR = 24;

const results = [];
function record(level, name, detail) {
  results.push({ level, name, detail });
  const mark = level === 'fail' ? '✗' : level === 'warn' ? '⚠' : '✓';
  console.log(`[preflight] ${mark} ${name}：${detail}`);
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
  const stateDir = path.resolve(env.MEMORY_MCP_STATE_DIR ?? path.join(PKG_ROOT, 'state'));
  const port = Number(env.MEMORY_MCP_HTTP_PORT ?? 7181);

  checkNode();
  await checkDeps();
  checkStateDir(stateDir);
  checkToken(path.join(stateDir, 'http-token'));
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
