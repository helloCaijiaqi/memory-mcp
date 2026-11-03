// 从 qq-bridge 复制式导入：黑话库 + social-v2 里的记忆字段。
//
// 原则（与方案一致）：只复制不移动 —— 原件一个字节都不改，只在旁边留一份 .bak 备份，
// 导入完出「源条目数 / 入库数 / 跳过原因」对照，方便核对有没有丢。
//
// 用法：
//   node scripts/migrate-from-qq-bridge.mjs [--source c:/qq-bridge] [--state-dir <dir>] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';
import { createSlangService } from '../src/service/slang-service.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { source: process.env.QQ_BRIDGE_DIR ?? 'c:/qq-bridge', stateDir: '', dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const [key, inline] = argv[i].replace(/^--/, '').split('=');
    const value = inline ?? argv[i + 1];
    if (key === 'source') args.source = value;
    else if (key === 'state-dir') args.stateDir = value;
    else if (key === 'dry-run') args.dryRun = true;
  }
  return args;
}

/** 平台桥接的会话键（group:123 / private:456）→ 中性 sessionId（qq:group:123）。 */
export function toSessionId(rawKey) {
  const key = String(rawKey ?? '').trim();
  const [scope, id] = key.split(':');
  if (!id) return null;
  const normalizedScope = scope === 'group' || scope === 'private' ? scope : null;
  if (!normalizedScope) return null;
  return `qq:${normalizedScope}:${id}`;
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const target = `${file}.bak`;
  fs.copyFileSync(file, target);
  return target;
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    return String(value.text ?? value.content ?? value.topic ?? value.thought ?? value.summary ?? '').trim();
  }
  return String(value).trim();
}

export async function migrate(args) {
  const sourceRoot = path.resolve(args.source);
  const stateDir = path.resolve(args.stateDir || path.join(PKG_ROOT, 'state'));
  const report = { source: sourceRoot, stateDir, slang: { source: 0, imported: 0, skipped: [] }, memory: { source: 0, imported: 0, skipped: [] }, backups: [] };

  const slangFile = path.join(sourceRoot, 'state', 'slang.json');
  const socialFile = path.join(sourceRoot, 'state', 'social-v2.json');

  const slangSource = fs.existsSync(slangFile) ? JSON.parse(fs.readFileSync(slangFile, 'utf8')) : null;
  const socialSource = fs.existsSync(socialFile) ? JSON.parse(fs.readFileSync(socialFile, 'utf8')) : null;

  // 先备份原件（只复制，不动原件）
  for (const file of [slangFile, socialFile]) {
    const made = backup(file);
    if (made) report.backups.push(made);
  }

  if (args.dryRun) {
    report.dryRun = true;
    return report;
  }

  const store = await openStore({ dir: stateDir });
  const memory = createMemoryService({ store });
  const slang = createSlangService({ store });

  // ── 黑话 ────────────────────────────────────────────────────────────────
  const entries = Array.isArray(slangSource)
    ? slangSource
    : Array.isArray(slangSource?.entries)
      ? slangSource.entries
      : [];
  report.slang.source = entries.length;
  for (const entry of entries) {
    const content = String(entry?.content ?? '').trim();
    if (!content) {
      report.slang.skipped.push('内容为空，跳过');
      continue;
    }
    const status = ['candidate', 'confirmed', 'rejected'].includes(entry?.status) ? entry.status : 'candidate';
    const evidence = Array.isArray(entry?.evidence)
      ? entry.evidence.map((item) => textOf(item)).filter(Boolean)
      : [];
    slang.submit({
      content,
      meaning: String(entry?.meaning ?? '').trim(),
      status,
      evidence: evidence.length ? evidence : [String(entry?.example ?? '')].filter(Boolean),
      score: Number(entry?.hits ?? 0) || 0,
    });
    report.slang.imported += 1;
  }

  // ── 记忆（social-v2 会话状态里的字段）────────────────────────────────────
  // 映射沿用方案：activeTopics / pendingThoughts → 短期；memberImpressions → 长期画像。
  const conversations = socialSource?.conversations ?? {};
  for (const [rawKey, conversation] of Object.entries(conversations)) {
    const sessionId = toSessionId(rawKey);
    if (!sessionId) {
      report.memory.skipped.push(`会话键无法映射：${rawKey}`);
      continue;
    }
    const topics = Array.isArray(conversation?.activeTopics) ? conversation.activeTopics : [];
    const thoughts = Array.isArray(conversation?.pendingThoughts) ? conversation.pendingThoughts : [];
    const impressions = conversation?.memberImpressions ?? {};

    for (const item of topics) {
      const content = textOf(item);
      if (!content) continue;
      report.memory.source += 1;
      memory.append({ sessionId, tier: 'short', category: '话题', content });
      report.memory.imported += 1;
    }
    for (const item of thoughts) {
      const content = textOf(item);
      if (!content) continue;
      report.memory.source += 1;
      memory.append({ sessionId, tier: 'short', category: '待续', content });
      report.memory.imported += 1;
    }
    for (const [memberId, value] of Object.entries(impressions)) {
      const content = textOf(value);
      if (!content) continue;
      report.memory.source += 1;
      memory.append({ sessionId, tier: 'long', category: '画像', content: `${memberId}：${content}` });
      report.memory.imported += 1;
    }
  }

  report.stats = store.stats();
  store.close();
  return report;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv);
  migrate(args)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      const slangDiff = report.slang.source - report.slang.imported;
      const memoryDiff = report.memory.source - report.memory.imported;
      console.log(
        `\n导入完成：黑话 ${report.slang.imported}/${report.slang.source}（差 ${slangDiff}），` +
          `记忆 ${report.memory.imported}/${report.memory.source}（差 ${memoryDiff}）`,
      );
      if (report.memory.skipped.length || report.slang.skipped.length) {
        console.log('跳过明细：', [...report.memory.skipped, ...report.slang.skipped].slice(0, 20).join('；'));
      }
    })
    .catch((error) => {
      console.error('迁移失败：', error?.stack ?? error);
      process.exitCode = 1;
    });
}
