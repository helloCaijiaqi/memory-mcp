import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const db = new DatabaseSync('state/memory.db', { readOnly: true });
console.log('=== 长期记忆条目（memory tier=long）===');
for (const r of db.prepare("SELECT id, session_id, substr(content,1,60) c, created_at FROM memory WHERE tier='long' ORDER BY created_at DESC").all()) {
  console.log(`  ${r.id} [${r.session_id.split(':').pop()}] ${new Date(r.created_at).toISOString().slice(5, 16)} ${r.c}`);
}
console.log('\n=== 画像 ===');
for (const r of db.prepare('SELECT * FROM profile').all()) console.log(' ', JSON.stringify(r).slice(0, 200));
console.log('\n=== 会话状态 ===');
for (const r of db.prepare('SELECT * FROM session_state').all()) console.log(' ', JSON.stringify(r).slice(0, 160));
console.log('\n=== 媒体源文件落盘核对 ===');
for (const r of db.prepare('SELECT id, status, source_path, ref FROM media_asset').all()) {
  const exists = r.source_path ? fs.existsSync(r.source_path) : false;
  console.log(`  ${r.id} ${r.status} 源文件存在=${exists} ${r.source_path ?? '-'}`);
}
db.close();
console.log('\n=== save 缓冲区（未落库的会话窗口）===');
const bufDir = 'state/session-buffer';
if (fs.existsSync(bufDir)) {
  for (const f of fs.readdirSync(bufDir)) {
    const full = `${bufDir}/${f}`;
    const st = fs.statSync(full);
    let n = '?';
    try { n = JSON.parse(fs.readFileSync(full, 'utf8')).messages?.length ?? '?'; } catch {}
    console.log(`  ${f}  ${st.size}B  ${n} 条消息  mtime=${st.mtime.toISOString().slice(5, 16)}`);
  }
} else console.log('  (无 session-buffer 目录)');
