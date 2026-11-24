// 多媒体记忆层服务级离线单测：登记去重（id 幂等 + hash 内容去重）、描述回写、
// 摘要完整性（占位符重写降级阶梯）、【多媒体】head 注入、session-save 挂载链。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/store-api.js';
import { createMediaService, sanitizeDescInput } from '../src/service/media-service.js';
import { buildHead } from '../src/service/head-builder.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-media-svc-'));

async function open() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const service = createMediaService({ store, config: { mediaDir } });
  // 白名单语义（媒体管道 v2）：fileRef 必须在 mediaDir 内（bridge 落盘共享目录）——
  // 测试的媒体文件统一放 mediaDir（makeImage 的 dir 参数传 mediaDir）。
  return { store, service, dir: mediaDir, close: () => store.close() };
}

const SID = 'qq:group:123456';
const mk = (c) => `ma_${c.repeat(12)}`;

function makeImage(dir, name, bytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

test('登记三层去重：id 幂等 / hash 继承 / 源文件单份', async () => {
  const { service, dir, close } = await open();
  try {
    const img = makeImage(dir, 'a.png', 'same-image-content');
    const first = await service.ensureAssets({
      sessionId: SID,
      media: [{ id: mk('1'), kind: 'image', fileRef: img, ref: 'https://x/a.jpg' }],
    });
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'pending');
    assert.ok(first[0].hash, '本地 fileRef 登记应算出 sha256');

    // 同占位符重放（历史窗口）→ 幂等，不新建不覆盖
    const replay = await service.ensureAssets({
      sessionId: SID,
      media: [{ id: mk('1'), kind: 'image', fileRef: img, durationMs: null }],
    });
    assert.equal(replay[0].hash, first[0].hash);
    assert.equal(replay[0].ref, 'https://x/a.jpg');

    // 描述回写 → ready
    service.updateDesc(mk('1'), { desc: '橘猫键盘梗图', tags: ['猫'] });
    assert.equal(service.get(mk('1')).status, 'ready');

    // 同图不同占位符（转发/重发）→ hash 继承 desc，直接 ready
    const twin = await service.ensureAssets({
      sessionId: 'qq:group:789',
      media: [{ id: mk('2'), kind: 'image', fileRef: img }],
    });
    assert.equal(twin[0].desc, '橘猫键盘梗图');
    assert.equal(twin[0].status, 'ready');
    assert.equal(twin[0].sourcePath, first[0].sourcePath, '同内容源文件复用');
  } finally {
    close();
  }
});

test('摘要完整性：占位符重写降级阶梯', async () => {
  const { service, dir, close } = await open();
  try {
    const img = makeImage(dir, 'b.png', 'content-b');
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('3'), kind: 'image', fileRef: img }] });
    // A) 已就绪 → desc 解释
    service.updateDesc(mk('3'), { desc: '日落海滩照片' });
    // B) 登记但未解析 → 最小描述
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('4'), kind: 'image', fileRef: makeImage(dir, 'c.png', 'content-c') }] });
    // C) 无详情（异常路径）→ 通用占位描述
    const out1 = service.rewriteForSummary(`看 [图片|${mk('3')}] 这张`);
    assert.equal(out1, '看 [图片: 日落海滩照片] 这张');
    const out2 = service.rewriteForSummary(`发 [语音|${mk('4')}]`);
    assert.ok(out2.includes('[图片（'), `未解析应走元数据最小描述，实际：${out2}`);
    assert.ok(!/\[media:|\[(?:图片|语音|视频|文件|表情|媒体)\|ma_[0-9a-f]{12}\]$/.test(out2), '不能裸占位符进摘要');
    const out3 = service.rewriteForSummary('[图片|ma_f00000000000]');
    assert.ok(!/\[(?:图片|语音|视频|文件|表情|媒体)\|ma_[0-9a-f]{12}\]/.test(out3), `无详情也不裸占位符，实际：${out3}`);

    // Set 去重：同占位符多次出现只盘点一次
    const dedup = service.collectFromTexts([`[图片|${mk('3')}]`, `又是 [图片|${mk('3')}]`, `[语音|${mk('4')}]`]);
    assert.equal(dedup.ids.length, 2);
    assert.equal(dedup.ready.size, 1);
    assert.equal(dedup.missing.length, 1);
  } finally {
    close();
  }
});

test('【多媒体】head 注入：一行一资产 + 稳定序', async () => {
  const { service, dir, close } = await open();
  try {
    const imgA = makeImage(dir, 'd.png', 'content-d');
    const imgB = makeImage(dir, 'e.png', 'content-e');
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('5'), kind: 'image', fileRef: imgA }] });
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('6'), kind: 'image', fileRef: imgB }] });
    service.updateDesc(mk('5'), { desc: '第一张图', tags: ['图'] });
    service.updateDesc(mk('6'), { desc: '第二张图', tags: ['照片'] });
    const rows = service.headRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.id).sort(), [mk('5'), mk('6')].sort());
    const head = buildHead({ mediaRows: rows });
    assert.ok(head.text.includes('【多媒体】'), '应含【多媒体】段');
    assert.ok(head.text.includes('第一张图'));
    assert.ok(head.text.includes('#图'), '标签应渲染');
    // 空媒体不影响 head
    const headEmpty = buildHead({ mediaRows: [] });
    assert.ok(!headEmpty.text.includes('【多媒体】'));
  } finally {
    close();
  }
});

test('使用统计：markUsed 与检索', async () => {
  const { service, dir, close } = await open();
  try {
    const img = makeImage(dir, 'f.png', 'content-f');
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('7'), kind: 'image', fileRef: img }] });
    service.updateDesc(mk('7'), { desc: '猫猫头梗图', tags: ['猫', '梗图'] });
    service.markUsed(mk('7'));
    service.markUsed(mk('7'));
    const asset = service.get(mk('7'));
    assert.equal(asset.useCount, 2);
    assert.ok(asset.lastUsedAt > 0);
    const found = service.search({ text: '猫猫头' });
    assert.equal(found.rows.length, 1);
    assert.equal(found.rows[0].id, mk('7'));
  } finally {
    close();
  }
});

test('desc 污染防御：sanitizeDescInput 解包 JSON blob / 普通文本原样 / 畸形 JSON 回落', async () => {
  // 纯函数层
  assert.deepEqual(sanitizeDescInput('三位动漫角色并排站立'), { desc: '三位动漫角色并排站立', tags: [] }, '普通文本原样');
  const blob = JSON.stringify({ desc: '三位动漫角色并排站立', tags: ['火影'], status: 'ready', useCount: 2, createdAt: 1 });
  assert.deepEqual(sanitizeDescInput(blob), { desc: '三位动漫角色并排站立', tags: ['火影'] }, '整包 JSON 解包取内层');
  assert.equal(sanitizeDescInput('{ 这不是合法 JSON {').desc, '{ 这不是合法 JSON {', '畸形 JSON 原样回落');
  assert.equal(sanitizeDescInput('{"desc":"三位动漫角色并排站立').desc, '三位动漫角色并排站立', 'JSON 残片（截断 blob）正则兜底解包');
  assert.equal(sanitizeDescInput('{"tags":["a"]}').desc, '{"tags":["a"]}', 'JSON 但无字符串 desc 字段 → 原样');
  assert.equal(sanitizeDescInput(null).desc, '', 'null 安全');
  // 服务层：blob 进 updateDesc → 库里是纯文本 + 内层 tags 合并
  const { service, dir, close } = await open();
  try {
    const img = makeImage(dir, 'g.png', 'content-g');
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('8'), kind: 'image', fileRef: img }] });
    service.updateDesc(mk('8'), { desc: blob });
    const asset = service.get(mk('8'));
    assert.equal(asset.desc, '三位动漫角色并排站立', '入库为纯文本而非 JSON 串');
    assert.ok(asset.tags.includes('火影'), '调用方未提供 tags 时合并内层标签');
    assert.equal(asset.status, 'ready', '有描述即 ready');
  } finally {
    close();
  }
});
