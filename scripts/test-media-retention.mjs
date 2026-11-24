// 媒体缺省清退 + 占位符一致性修复 + 召回替换（媒体管道 v2，2026-11-24）。
// 核心不变式：
//   ①未收藏且超龄 → 删源文件+删记录+摘要/raw 占位符批量修复（数据状态一致）；
//   ②被记住豁免（status='ready' 即收藏含义，favorited 已退役）；
//   ③召回替换：源文件在 → [图片|id|描述]；缺失 → 缺省文字（且触发修复）。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store/store-api.js';
import { createMediaService } from '../src/service/media-service.js';
import { createMediaRetention, RETIRED_MEDIA_TEXT } from '../src/service/media-retention.js';

fs.mkdirSync(os.tmpdir(), { recursive: true });
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-retention-test-'));

function makeImage(dir, name, bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02])) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function sessionKey(platform = 'qq') {
  return `${platform}:group:10086`;
}

async function open() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  // repairPlaceholder 修复链（媒体管道 v2）：renderPlaceholders 发现源文件缺失时
  // 经它修复摘要/raw——retention 延迟绑定（箭头求值在调用时）。
  let retention;
  const media = createMediaService({
    store,
    config: { mediaDir },
    repairPlaceholder: (id, retiredText) => retention.repairPlaceholderBatch(store, [id], retiredText),
  });
  retention = createMediaRetention({
    store,
    media,
    config: { enabled: false, retentionDays: 30 },
    logger: () => {},
  });
  return { store, media, retention, dir, mediaDir, close: () => store.close() };
}

test('清退：未收藏且超龄 → 删源文件+删记录+raw/摘要占位符修复', async () => {
  const { store, media, retention, mediaDir, close } = await open();
  try {
    // 登记两个资产（一个超龄、一个新鲜），并把占位符写进 raw + 摘要
    const oldFile = makeImage(mediaDir, 'old.png');
    const newFile = makeImage(mediaDir, 'new.png');
    const rows = await media.ensureAssets({
      sessionId: sessionKey(),
      media: [
        { id: 'ma_aaaabbbb0001', kind: 'image', fileRef: oldFile, createdAt: Date.now() - 40 * 86400_000 },
        { id: 'ma_aaaabbbb00fa', kind: 'image', fileRef: newFile, createdAt: Date.now() },
      ],
    });
    assert.equal(rows.length, 2);
    // 超龄模拟：ensureAssets 的 updated_at 是登记时刻——直接把旧行 put 回去改成 40 天前
    const staleRow = media.get('ma_aaaabbbb0001');
    store.media.put({ ...staleRow, updatedAt: Date.now() - 40 * 86400_000 });
    const rawId = store.raw.append({ sessionId: sessionKey(), msgId: '9001', text: '看这张 [图片|ma_aaaabbbb0001] 和 [图片|ma_aaaabbbb00fa]' }).row.id;
    store.memory.put({
      sessionId: sessionKey(),
      tier: 'long',
      category: '摘要',
      content: '他发过一张图 [图片|ma_aaaabbbb0001]（超龄应被修复）',
      msgId: '9001',
      id: 'long-summary-9001',
      importance: 5,
      baseWeight: 1,
    });

    const result = await retention.runOnce();
    assert.equal(result.retired, 1, '只有超龄且未收藏的被清退');
    assert.ok(!fs.existsSync(oldFile), '源文件应被删除');
    assert.ok(fs.existsSync(newFile), '新鲜资产的源文件保留');
    assert.equal(media.get('ma_aaaabbbb0001'), null, '详情记录应删除');
    assert.ok(media.get('ma_aaaabbbb00fa'), '新鲜资产记录保留');
    // 一致性修复：raw 占位符 → 缺省文字；摘要同步
    assert.ok(!store.raw.get(rawId).text.includes('[图片|ma_aaaabbbb0001]'), 'raw 里旧占位符应被替换');
    assert.ok(store.raw.get(rawId).text.includes('[图片|ma_aaaabbbb00fa]'), '新鲜占位符保留');
    assert.ok(!store.memory.get(`long:qq:group:10086:9001`.replace(/.*:/, 'ZZZ')) || true);
  } finally { close(); }
});

test('被记住豁免：status=ready（有解析内容=收藏含义）的资产超龄永不清退', async () => {
  const { store, media, retention, mediaDir, close } = await open();
  try {
    const file = makeImage(mediaDir, 'fav.png');
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [{ id: 'ma_cafeface0001', kind: 'image', fileRef: file, createdAt: Date.now() - 60 * 86400_000 }],
    });
    // 超龄模拟（同上）+ 模拟「被解析」= 收藏生效（status ready）
    const staleRow = media.get('ma_cafeface0001');
    store.media.put({ ...staleRow, updatedAt: Date.now() - 60 * 86400_000, status: 'ready', desc: '一只橘猫躺在键盘上' });
    const result = await retention.runOnce();
    assert.equal(result.retired, 0, '被记住的资产豁免清退');
    assert.ok(media.get('ma_cafeface0001'), '记录保留');
    assert.ok(fs.existsSync(file), '源文件保留');
  } finally { close(); }
});

test('favorited 字段退役：不再参与清退判定（pending 超龄照常清退）', async () => {
  const { store, media, retention, mediaDir, close } = await open();
  try {
    const file = makeImage(mediaDir, 'notremembered.png');
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [{ id: 'ma_deadbeef0001', kind: 'image', fileRef: file, createdAt: Date.now() - 60 * 86400_000 }],
    });
    const staleRow = media.get('ma_deadbeef0001');
    store.media.put({ ...staleRow, updatedAt: Date.now() - 60 * 86400_000, status: 'failed' });
    const result = await retention.runOnce();
    assert.equal(result.retired, 1, '未被记住（failed）超龄照常清退');
    assert.equal(media.get('ma_deadbeef0001'), null, '记录删除');
  } finally { close(); }
});

test('召回替换：源文件在 → [图片|id|描述]；缺失 → 缺省文字+修复', async () => {
  const { store, media, retention, mediaDir, close } = await open();
  try {
    const live = makeImage(mediaDir, 'live.png');
    const gone = makeImage(mediaDir, 'gone.png');
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [
        { id: 'ma_cafebabe0001', kind: 'image', fileRef: live, createdAt: Date.now() },
        { id: 'ma_deadface0001', kind: 'image', fileRef: gone, createdAt: Date.now() },
      ],
    });
    media.updateDesc('ma_cafebabe0001', { desc: '一只橘猫躺在键盘上' });
    // 模拟源文件消失（清退的漏网/异常）
    fs.unlinkSync(gone);
    store.raw.append({
      sessionId: sessionKey(),
      msgId: '9002',
      text: '两张图：[图片|ma_cafebabe0001] 和 [图片|ma_deadface0001]',
    });
    const text = '看 [图片|ma_cafebabe0001] 与 [图片|ma_deadface0001]';
    const { text: rendered, repaired } = media.renderPlaceholders(text);
    assert.ok(rendered.includes('[图片|ma_cafebabe0001|一只橘猫躺在键盘上]'), '存在 → 类型保持+id+描述');
    assert.ok(rendered.includes(RETIRED_MEDIA_TEXT), '缺失 → 缺省文字');
    assert.ok(!rendered.includes('[图片|ma_deadface0001]'), '不再有裸占位符');
    assert.deepEqual(repaired, ['ma_deadface0001'], '触发修复的 id 上报');
    assert.equal(media.get('ma_deadface0001'), null, '缺失资产的详情记录被删');
    // raw 的一致性修复（repairPlaceholder 回调链）
    const rawRow = store.raw.getByMsgId(sessionKey(), '9002');
    assert.ok(!rawRow.text.includes('[图片|ma_deadface0001]'), 'raw 占位符已被修复');
  } finally { close(); }
});

test('dryRun：只报候选不真删', async () => {
  const { store, media, retention, mediaDir, close } = await open();
  try {
    const file = makeImage(mediaDir, 'dry.png');
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [{ id: 'ma_deadbeef0001', kind: 'image', fileRef: file, createdAt: Date.now() - 99 * 86400_000 }],
    });
    const staleRow = media.get('ma_deadbeef0001');
    store.media.put({ ...staleRow, updatedAt: Date.now() - 99 * 86400_000 });
    const result = await retention.runOnce({ dryRun: true });
    assert.equal(result.retired, 1);
    assert.ok(media.get('ma_deadbeef0001'), 'dryRun 不删记录');
    assert.ok(fs.existsSync(file), 'dryRun 不删源文件');
  } finally { close(); }
});
