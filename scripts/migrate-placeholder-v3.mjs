// 占位符格式 v3 一次性迁移（2026-11-24）：
//   [media:ma_xxx]（旧格式）→ [图片|ma_xxx] 等新格式（按 media_asset.kind 中文映射）。
//   详情表查不到的 id（已清退）→ [媒体|ma_xxx] 兜底词。
// 覆盖 raw_message（含 FTS 重建）与 memory 表（长期摘要等）。
// 直接 SQL（独立于 store 抽象——只触碰 text/content 两列与 raw_fts 重建）。
// 用法：node scripts/migrate-placeholder-v3.mjs [--db <path>] [--dry]
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : 'c:/memory-mcp/state/memory.db';
if (!fs.existsSync(dbPath)) { console.error(`数据库不存在: ${dbPath}`); process.exit(1); }

const ZH = { image: '图片', voice: '语音', video: '视频', file: '文件' };
const OLD_RE = /\[media:(ma_[0-9a-f]{12})\]/g;

const db = new DatabaseSync(dbPath);
const kindOf = (id) => {
  try {
    const row = db.prepare('SELECT kind FROM media_asset WHERE id = ?').get(id);
    return ZH[row?.kind] ?? '媒体';
  } catch { return '媒体'; }
};
const rewrite = (text) => {
  let changed = 0;
  const next = String(text ?? '').replace(OLD_RE, (full, id) => {
    changed += 1;
    return `[${kindOf(id)}|${id}]`;
  });
  return { next, changed };
};

// ---------- raw_message（含 FTS 重建） ----------
let rawRows = 0, rawReplaced = 0;
try {
  const rows = db.prepare("SELECT id, text FROM raw_message WHERE text LIKE '%[media:ma_%'").all();
  for (const row of rows) {
    const { next, changed } = rewrite(row.text);
    if (!changed) continue;
    if (!dry) {
      db.prepare('UPDATE raw_message SET text = ? WHERE id = ?').run(next, row.id);
      db.prepare('DELETE FROM raw_fts WHERE id = ?').run(row.id);
      db.prepare('INSERT INTO raw_fts(text, id) VALUES (?, ?)').run(next, row.id);
    }
    rawRows += 1; rawReplaced += changed;
  }
} catch (error) {
  console.error(`raw 扫描失败: ${error?.message ?? error}`);
}

// ---------- memory 表（长期摘要等） ----------
let memRows = 0, memReplaced = 0;
try {
  const rows = db.prepare("SELECT id, content FROM memory WHERE content LIKE '%[media:ma_%'").all();
  for (const row of rows) {
    const { next, changed } = rewrite(row.content);
    if (!changed) continue;
    if (!dry) db.prepare('UPDATE memory SET content = ? WHERE id = ?').run(next, row.id);
    memRows += 1; memReplaced += changed;
  }
} catch (error) {
  console.error(`memory 扫描失败: ${error?.message ?? error}`);
}

console.log(`迁移${dry ? '（dryRun 预览）' : '完成'}：raw 行 ${rawRows}（替换 ${rawReplaced} 处）｜memory 行 ${memRows}（替换 ${memReplaced} 处）`);
db.close();
