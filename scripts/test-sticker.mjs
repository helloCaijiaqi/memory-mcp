/**
 * 表情库集成回归（2026-11-26）：sqlite store v6 迁移 + pHash 近邻识别 +
 * mergeVariant 变体归并（计数归并/检索面排除）+ stickerFind 三级检索 +
 * favorited 列删除（口径：进入详情表即收藏）。
 * 真实 sqlite（临时目录）+ 真实 pHash（Windows 解码器）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openStore } = await import('../src/store/store-api.js');
const { createMediaService } = await import('../src/service/media-service.js');
const { phashFromFile, hamming, PHASH_CONFIRM_DISTANCE } = await import('../src/service/image-phash.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-store-'));
const store = await openStore({ dir });
const media = createMediaService({ store, config: { mediaDir: path.join(dir, 'media') } });

// ---------- 0) v6 迁移：新列存在，favorited 已删（node:sqlite 只读直开库文件验证） ----------
{
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(dir, 'memory.db'), { readOnly: true });
  const cols = raw.prepare(`SELECT name FROM pragma_table_info('media_asset')`).all().map((r) => r.name);
  for (const col of ['phash', 'merged_into', 'is_sticker']) assert.ok(cols.includes(col), `v6 列存在：${col}`);
  assert.ok(!cols.includes('favorited'), 'favorited 列已删（表内即收藏）');
  const idx = raw.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((r) => r.name);
  assert.ok(!idx.includes('idx_media_fav'), 'idx_media_fav 索引已删');
  raw.close();
}

// ---------- 1) 造两张真实图片（master 蓝底红圆 / other 绿底斜线 + master 的 JPEG 变体） ----------
const ps = (script) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
ps(`
Add-Type -AssemblyName System.Drawing
$dir = '${dir.replace(/\\/g, '/')}'
$bmp = New-Object System.Drawing.Bitmap(200, 200)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(30, 144, 255))
$g.FillEllipse([System.Drawing.Brushes]::Red, 50, 50, 100, 100)
$g.Dispose()
$bmp.Save("$dir/master.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$o = New-Object System.Drawing.Bitmap(200, 200)
$g2 = [System.Drawing.Graphics]::FromImage($o)
$g2.Clear([System.Drawing.Color]::FromArgb(20, 160, 60))
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 8)
$g2.DrawLine($pen, 0, 200, 200, 0)
$g2.Dispose()
$o.Save("$dir/other.png", [System.Drawing.Imaging.ImageFormat]::Png)
$o.Dispose()
$img = [System.Drawing.Image]::FromFile("$dir/master.png")
$img.Save("$dir/variant.jpg", [System.Drawing.Imaging.ImageFormat]::Jpeg)
$q = New-Object System.Drawing.Bitmap(160, 160)
$g3 = [System.Drawing.Graphics]::FromImage($q)
$g3.Clear([System.Drawing.Color]::FromArgb(255, 165, 0))
$g3.FillRectangle([System.Drawing.Brushes]::Blue, 40, 40, 80, 80)
$g3.Dispose()
$q.Save("$dir/query.png", [System.Drawing.Imaging.ImageFormat]::Png)
$q.Dispose()
$img.Dispose()
`);

const phMaster = phashFromFile(path.join(dir, 'master.png'));
const phVariant = phashFromFile(path.join(dir, 'variant.jpg'));
assert.ok(hamming(phMaster.hash, phVariant.hash) <= PHASH_CONFIRM_DISTANCE, 'master 与变体判定同款');

// ---------- 2) 登记：master（ready + is_sticker）与变体（pending）与异图 ----------
const sessionId = 'qq:bot:group:67890';
const sid = (n) => `ma_${String(n).padStart(12, '0')}`;
store.media.put({ id: sid(1), sessionId, kind: 'image', sourcePath: path.join(dir, 'master.png'), hash: 'h1' });
store.media.put({ id: sid(2), sessionId, kind: 'image', sourcePath: path.join(dir, 'variant.jpg'), hash: 'h2' });
store.media.put({ id: sid(3), sessionId, kind: 'image', sourcePath: path.join(dir, 'other.png'), hash: 'h3' });
media.updateDesc(sid(1), { desc: '蓝底红色圆形表情', tags: ['via-cloudflare'], status: 'ready', phash: phMaster.hash, isSticker: true });
media.updateDesc(sid(3), { desc: '绿底黑色斜线图片', tags: [], status: 'ready', phash: phashFromFile(path.join(dir, 'other.png')).hash, isSticker: false });

// ---------- 3) findNearPhash：pending 变体命中 master ----------
const near = media.findNearPhash(phVariant.hash, PHASH_CONFIRM_DISTANCE);
assert.ok(near, '变体命中近邻');
assert.equal(near.asset.id, sid(1), '命中的是主资产');
assert.equal(near.asset.desc, '蓝底红色圆形表情', '主资产 desc 就绪');

// ---------- 4) mergeVariant：继承 + 计数归并 + 检索面排除 ----------
const merged = media.mergeVariant(sid(2), sid(1), phVariant.hash);
assert.ok(merged, '归并成功');
assert.equal(merged.variant.mergedInto, sid(1), '变体标归并主资产');
assert.equal(merged.variant.desc, '蓝底红色圆形表情', '变体继承主资产描述');
assert.equal(merged.variant.status, 'ready', '变体置 ready（media_describe 缓存直返）');
assert.equal(merged.master.useCount, 1, '主资产 sightings 计数 +1');

// 变体不在检索面（media_search 默认排除 merged），master 热度排序第一
const searchRows = media.search({ kind: 'image', limit: 10 });
assert.ok(!searchRows.rows.some((r) => r.id === sid(2)), '归并变体不出现在检索面');
assert.equal(searchRows.rows[0].id, sid(1), '主资产按热度排前');

// ---------- 5) stickerFind 三级检索 ----------
// 语义级
const sem = media.stickerFind({ text: '红色圆形' });
assert.ok(sem.length >= 1, '语义检索有结果');
assert.equal(sem[0].id, sid(1), '语义命中主资产');
assert.equal(sem[0].matchType, 'semantic', 'matchType=semantic');
// 常用度兜底
const pop = media.stickerFind({});
assert.equal(pop[0].matchType, 'popular', '无入参走 popular 兜底');
assert.ok(pop.every((r) => r.id !== sid(2)), 'popular 也不含归并变体');
// 带图感知匹配：用变体字节查询 → 命中主资产
const b64 = fs.readFileSync(path.join(dir, 'variant.jpg')).toString('base64');
const percept = media.stickerFind({ imageBase64: b64 });
assert.equal(percept[0].id, sid(1), '带图查询命中主资产');
assert.equal(percept[0].matchType, 'perceptual', 'matchType=perceptual');
// 未登记图带图查询：不命中 → 降级 popular（other.png 已登记会 perceptual 自命中，不作降级用例）
const queryB64 = fs.readFileSync(path.join(dir, 'query.png')).toString('base64');
const miss = media.stickerFind({ imageBase64: queryB64 });
assert.equal(miss[0].matchType, 'popular', '未登记图查询降级 popular 兜底');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows：sqlite 句柄未开放 close，留给系统清理 */ }
console.log('test-sticker: all passed');
