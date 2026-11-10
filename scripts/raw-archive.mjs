#!/usr/bin/env node
// 原始层归档维护 CLI：交给计划任务调用（服务里不起定时器 —— 一个跑在 stdio 上的 MCP 进程
// 本来就不该负责周期任务，重启即丢）。
//
//   node scripts/raw-archive.mjs                        # 按默认保留期（30 天）归档
//   node scripts/raw-archive.mjs --days 7 --dry-run      # 只看会归档多少、写到哪些分片
//   node scripts/raw-archive.mjs --platform qq           # 只处理某个平台
//   node scripts/raw-archive.mjs --session qq:group:123  # 只处理某个会话
//
// 退出码：0 正常；1 失败（写盘失败、库只读等），交给计划任务报警，绝不静默跳过。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store/store-api.js';
import { createRawService } from '../src/service/raw-service.js';
import { resolveConfig } from '../src/server.mjs';

const USAGE = `用法：node scripts/raw-archive.mjs [--days N] [--dry-run] [--platform qq] [--session qq:group:1] [--json]`;

export function parseArgs(argv = []) {
  const out = { days: undefined, dryRun: false, platform: undefined, session: undefined, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const next = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--json') out.json = true;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--days') {
      const value = Number(next());
      if (!Number.isFinite(value) || value < 0) throw new Error('--days 需要一个非负数字');
      out.days = value;
    } else if (flag === '--platform') out.platform = String(next() ?? '').toLowerCase() || undefined;
    else if (flag === '--session') out.session = String(next() ?? '').trim() || undefined;
    else throw new Error(`未知参数：${arg}\n${USAGE}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), { env = process.env, logger = console } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    logger.log(USAGE);
    return { help: true };
  }

  const cfg = resolveConfig(env);
  const store = await openStore({ dir: cfg.stateDir });
  try {
    if (store.degradedFrom) logger.error(`[raw-archive] 存储已降级：${store.degradedFrom}`);
    if (store.readonly) throw new Error('记忆库当前只读，无法归档');

    const retention = Number(env.MEMORY_MCP_RAW_RETENTION_DAYS);
    const raw = createRawService({
      store,
      stateDir: cfg.stateDir,
      config: Number.isFinite(retention) && retention >= 0 ? { rawRetentionDays: retention } : {},
      logger,
    });

    const result = await raw.archive({
      days: args.days ?? raw.config.rawRetentionDays,
      platform: args.platform,
      sessionId: args.session,
      dryRun: args.dryRun,
    });

    if (args.json) {
      logger.log(JSON.stringify(result, null, 2));
    } else if (result.dryRun) {
      logger.log(
        `[raw-archive] 待归档 ${result.backlog} 条（截止 ${new Date(result.cutoff).toISOString()}），本批采样 ${result.sampled} 条`,
      );
    } else {
      logger.log(`[raw-archive] 已归档 ${result.archived} 条，涉及 ${result.files.length} 个分片`);
      if (result.truncated) logger.error('[raw-archive] 单次处理量达到上限，请提高 --days 频率或调大 archiveBatch');
    }
    return result;
  } finally {
    store.close();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[raw-archive] 失败：', error?.message ?? error);
    process.exitCode = 1;
  });
}
