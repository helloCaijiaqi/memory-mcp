/**
 * pHash 感知哈希（表情库，2026-11-26）回归：
 *   - hamming 基础语义（自距离 0 / 已知位差 / 非法输入 Infinity）；
 *   - 真实图片编码路径（PowerShell System.Drawing 解码器）：
 *     等尺寸有损重编码（QQ 主场景）≤ 判定阈值（自动归并）；
 *     跨尺寸缩放 / GIF 调色板 → 候选区（≤12，提示不合并）；
 *     不同图距离显著大（不误合）。
 * 需要真实图像解码（零依赖纪律下走 Windows 内置 System.Drawing），非纯函数测试。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { phashFromFile, hamming, PHASH_CONFIRM_DISTANCE, PHASH_CANDIDATE_DISTANCE } =
  await import('../src/service/image-phash.js');

// ---------- 1) hamming 基础 ----------
assert.equal(hamming('ffff', 'ffff'), 0, '自距离 0');
assert.equal(hamming('00ff', 'ff00'), 16, '全位翻转 = 位宽');
assert.equal(hamming('0f00', '0e00'), 1, '相邻值一位差（0x0f^0x0e=0x01）');
assert.equal(hamming('', 'ff00'), Infinity, '空哈希 Infinity');
assert.equal(hamming('zz', '00'), Infinity, '非法十六进制 Infinity');

// ---------- 2) 真实图片编码路径 ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phash-test-'));
const ps = (script) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });

// base.png：蓝底红圆；variant.jpg：同画面等尺寸 JPEG 重编码（QQ 重压缩主场景）；
// small.jpg：同画面缩到 140px（跨尺寸变体，候选区）；variant.gif：GIF 调色板重编码；
// other.png：绿底黑斜线（不同画面）。
ps(`
Add-Type -AssemblyName System.Drawing
$dir = '${dir.replace(/\\/g, '/')}'
$bmp = New-Object System.Drawing.Bitmap(200, 200)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(30, 144, 255))
$g.FillEllipse([System.Drawing.Brushes]::Red, 50, 50, 100, 100)
$g.Dispose()
$bmp.Save("$dir/base.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$img = [System.Drawing.Image]::FromFile("$dir/base.png")
$img.Save("$dir/variant.jpg", [System.Drawing.Imaging.ImageFormat]::Jpeg)
$small = New-Object System.Drawing.Bitmap($img, 140, 140)
$small.Save("$dir/small.jpg", [System.Drawing.Imaging.ImageFormat]::Jpeg)
$small.Dispose()
$img.Save("$dir/variant.gif", [System.Drawing.Imaging.ImageFormat]::Gif)
$img.Dispose()
$o = New-Object System.Drawing.Bitmap(200, 200)
$g2 = [System.Drawing.Graphics]::FromImage($o)
$g2.Clear([System.Drawing.Color]::FromArgb(20, 160, 60))
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 8)
$g2.DrawLine($pen, 0, 200, 200, 0)
$g2.Dispose()
$o.Save("$dir/other.png", [System.Drawing.Imaging.ImageFormat]::Png)
$o.Dispose()
`);

const base = phashFromFile(path.join(dir, 'base.png'));
const variantJpg = phashFromFile(path.join(dir, 'variant.jpg'));
const smallJpg = phashFromFile(path.join(dir, 'small.jpg'));
const variantGif = phashFromFile(path.join(dir, 'variant.gif'));
const other = phashFromFile(path.join(dir, 'other.png'));

assert.ok(base, 'base.png 解码成功');
assert.deepEqual([base.width, base.height], [200, 200], '返回宽高');
assert.match(base.hash, /^[\da-f]{1,16}$/, '哈希十六进制串');
assert.equal(phashFromFile(path.join(dir, 'base.png')).hash, base.hash, '同文件确定性');

const dJpg = hamming(base.hash, variantJpg.hash);
const dSmall = hamming(base.hash, smallJpg.hash);
const dGif = hamming(base.hash, variantGif.hash);
const dOther = hamming(base.hash, other.hash);
console.log(`  distance(jpeg 等尺寸) = ${dJpg}, (跨尺寸) = ${dSmall}, (gif) = ${dGif}, (异图) = ${dOther}`);
assert.ok(dJpg <= PHASH_CONFIRM_DISTANCE, `等尺寸重编码变体 ≤ 归并阈值（实测 ${dJpg}）`);
assert.ok(dSmall <= PHASH_CANDIDATE_DISTANCE, `跨尺寸缩放变体 ≤ 候选阈值（实测 ${dSmall}）`);
assert.ok(dGif <= PHASH_CANDIDATE_DISTANCE, `GIF 调色板变体 ≤ 候选阈值（实测 ${dGif}）`);
assert.ok(dOther >= 16, `不同画面距离显著大（实测 ${dOther}）`);
assert.ok(dOther > dJpg + 8, '异图距离应远大于同图变体');

// 解码失败路径：不存在的文件 → null（调用方降级识图主流程）
assert.equal(phashFromFile(path.join(dir, 'no-such.png')), null, '缺失文件返回 null');

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-image-phash: all passed');
