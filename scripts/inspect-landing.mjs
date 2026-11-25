// 落地数据盘点（只读）：raw / 摘要 / 快照 / 长期记忆 / 画像 / 关系 / 媒体资产。
// 用内置 node:sqlite（与 src/store/sqlite-store.js 同驱动），state/data/memory.db 只读打开。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('state/memory.db', { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
console.log('=== 全部表 ===');
console.log(tables.join(', '));
console.log('\n=== 行数 ===');
for (const t of tables) {
  if (/_(fts|data|idx|config|doclist)/.test(t)) continue;
  try { console.log(t.padEnd(24), db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n); }
  catch { console.log(t.padEnd(24), 'ERR'); }
}
const q = (sql, label) => {
  try { return db.prepare(sql).all(); }
  catch (e) { console.log(`${label}: (无此表或查询失败：${e.message})`); return null; }
};
console.log('\n=== raw 落地（按会话）===');
let rows = q('SELECT session_id, COUNT(*) n, MIN(created_at) f, MAX(created_at) l FROM raw_message GROUP BY session_id', 'raw');
for (const r of rows ?? []) console.log(`${r.session_id}: ${r.n} 条  (${new Date(r.f).toISOString().slice(0, 16)} ~ ${new Date(r.l).toISOString().slice(0, 16)})`);
console.log('\n=== 摘要 / 快照 ===');
rows = q('SELECT session_id, revision, built_at, LENGTH(head_text) len FROM head_snapshot', 'snapshot');
for (const r of rows ?? []) console.log(`snapshot ${r.session_id}: rev=${r.revision} headText=${r.len}字 (${new Date(r.built_at).toISOString().slice(0, 16)})`);
rows = q('SELECT session_id, COUNT(*) n FROM session_summary GROUP BY session_id', 'summary');
for (const r of rows ?? []) console.log(`summary ${r.session_id}: ${r.n} 份`);
console.log('\n=== 长期记忆 / 画像 / 关系 ===');
rows = q('SELECT tier, COUNT(*) n FROM memory GROUP BY tier', 'memory');
for (const r of rows ?? []) console.log(`memory tier=${r.tier}: ${r.n} 条`);
rows = q('SELECT subject_id, COUNT(*) n FROM profile GROUP BY subject_id', 'profile');
for (const r of rows ?? []) console.log(`profile ${r.subject_id}: ${r.n} 条`);
rows = q('SELECT COUNT(*) n FROM relation', 'relation');
if (rows) console.log('relation:', rows[0].n, '条');
console.log('\n=== 媒体资产 ===');
rows = q('SELECT id, kind, status, substr(desc,1,34) d, source_path IS NOT NULL has_file, use_count FROM media_asset', 'media');
for (const r of rows ?? []) console.log(`  ${r.id} ${r.kind}/${r.status} 源文件=${r.has_file ? 'Y' : 'N'} heat=${r.use_count ?? 0} desc="${r.d ?? ''}"`);
db.close();
