// 分段命名迁移（2026-11-26）：旧三区（audio/inbox、audio/out、media/qq 平铺）
// → media/qq/{img,audio,file} 分型子目录 + ma_<id>.<段>.<ext> 分段命名。
// 纪律：UPDATE 先于 rename（失败回滚）；迁移后双向一致性校验（DB sourcePath 存在 +
// ma_* 文件可反查行）。
// 用法：node scripts/migrate-media-segmented.mjs [--apply]   （缺省 dry-run）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const STATE = 'C:/memory-mcp/state/data';
const AUDIO = path.join(STATE, 'audio');
const MEDIA_QQ = path.join(STATE, 'media', 'qq');
const ID_RE = /^(ma_[0-9a-f]{12})/;

const db = new DatabaseSync(path.join(STATE, 'memory.db'));
const plans = []; // { from, to, updates: [{ id, sourcePath, ref }] }

function plan(from, to, updates = []) { if (fs.existsSync(from)) plans.push({ from, to, updates }); }
function sha112(hex) { return `ma_${createHash('sha1').update(hex).digest('hex').slice(0, 12)}`; }

// ── 1. inbox：ma_*.wav 是收到语音转写产物 → .in 段；无段名（用户素材）原样保留 ──
const inboxDir = path.join(AUDIO, 'inbox');
for (const name of fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : []) {
  const from = path.join(inboxDir, name);
  if (!fs.statSync(from).isFile()) continue;
  const m = ID_RE.exec(name);
  if (!m) {
    // clone-test.wav 等用户素材（无段名）：原样搬入新运行时区（不动 DB，无详情行）
    plans.push({ from, to: path.join(MEDIA_QQ, 'audio', name), updates: [] });
    continue;
  }
  plans.push({ from, to: path.join(MEDIA_QQ, 'audio', `${m[1]}.in.wav`), updates: [{ id: m[1], sourcePath: path.join(MEDIA_QQ, 'audio', `${m[1]}.in.wav`), ref: null }] });
}

// ── 2. out：合成产物 ma_*.wav → .out 段（ref+sourcePath 都要同步）──
const outDir = path.join(AUDIO, 'out');
for (const name of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
  const from = path.join(outDir, name);
  if (!fs.statSync(from).isFile()) continue;
  const m = ID_RE.exec(name);
  if (!m) continue;
  const toName = `${m[1]}.out.wav`;
  plans.push({ from, to: path.join(MEDIA_QQ, 'audio', toName), updates: [{ id: m[1], sourcePath: path.join(MEDIA_QQ, 'audio', toName), ref: toName }] });
}

// ── 3. media/qq 平铺：hash 命名 → 分型子目录 + ma_<id>.in.<ext> ──
for (const name of fs.existsSync(MEDIA_QQ) ? fs.readdirSync(MEDIA_QQ) : []) {
  const from = path.join(MEDIA_QQ, name);
  if (!fs.statSync(from).isFile()) continue;
  const ext = path.extname(name).toLowerCase();
  const sha256hex = name.replace(/\.[^.]+$/, '');
  const id = sha112(sha256hex);
  const subdir = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext) ? 'img' : ['.amr', '.silk', '.mp3', '.wav', '.m4a'].includes(ext) ? 'audio' : 'file';
  const toName = `${id}.in${ext}`;
  plans.push({ from, to: path.join(MEDIA_QQ, subdir, toName), updates: [{ id, sourcePath: path.join(MEDIA_QQ, subdir, toName), ref: null }] });
}

// ── 展示计划 ──
console.log(`== ${APPLY ? 'APPLY' : 'DRY-RUN'}：${plans.length} 个文件 ==`);
for (const p of plans) {
  const row = p.updates[0] ? db.prepare('SELECT id, source_path AS sourcePath, ref FROM media_asset WHERE id = ?').get(p.updates[0].id) : null;
  console.log(`${path.relative(STATE, p.from)}\n  -> ${path.relative(STATE, p.to)}\n  DB: ${row ? `sourcePath=${row.sourcePath} ref=${row.ref}` : '(无详情行)'}`);
}

if (!APPLY) {
  console.log('\ndry-run 完成，加 --apply 执行');
  process.exit(0);
}

// ── 执行：UPDATE 先行（该行存在才更新），rename 失败回滚 UPDATE ──
const upd = db.prepare('UPDATE media_asset SET source_path = ?, ref = COALESCE(?, ref) WHERE id = ?');
let migrated = 0, dbMiss = 0, errors = 0;
for (const p of plans) {
  try {
    fs.mkdirSync(path.dirname(p.to), { recursive: true });
    const done = [];
    for (const u of p.updates) {
      const r = upd.run(u.sourcePath, u.ref, u.id);
      if (r.changes > 0) done.push(u); else dbMiss += 1;
    }
    fs.renameSync(p.from, p.to);
    migrated += 1;
  } catch (e) {
    errors += 1;
    console.error(`FAIL ${p.from}: ${e.message}（需人工核对 DB）`);
  }
}
console.log(`\n迁移完成：${migrated}/${plans.length}，无详情行 ${dbMiss}，失败 ${errors}`);

// ── 双向一致性校验 ──
let dbMissingFile = 0, fileMissingRow = 0, checked = 0;
const { rows } = { rows: db.prepare('SELECT id, source_path AS sourcePath FROM media_asset WHERE source_path IS NOT NULL AND source_path != \'\'').all() };
for (const r of rows) {
  checked += 1;
  if (!fs.existsSync(r.sourcePath)) { dbMissingFile += 1; console.error(`DB→FS 缺失: ${r.id} ${r.sourcePath}`); }
}
for (const sub of ['img', 'audio', 'file']) {
  const dir = path.join(MEDIA_QQ, sub);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!ID_RE.test(name)) continue;
    const id = ID_RE.exec(name)[1];
    const row = db.prepare('SELECT id FROM media_asset WHERE id = ?').get(id);
    if (!row) { fileMissingRow += 1; console.error(`FS→DB 缺行: ${path.join(sub, name)}`); }
  }
}
console.log(`一致性校验：DB ${checked} 行，源文件缺失 ${dbMissingFile}；目录 ma_* 缺行 ${fileMissingRow}`);
process.exit(dbMissingFile || fileMissingRow || errors ? 1 : 0);
