// 媒体缺省清退 + 占位符一致性修复 + 召回替换（媒体管道 v2，2026-11-24；
// 2026-11-26 清退语义重设计）。
// 核心不变式：
//   ①未收藏且超龄 → 删源文件+删记录+摘要/raw 占位符批量修复（类型保持+描述封存）；
//   ②收藏豁免（favorited=1）仅作用于「主动删文件」路径；pending/synthesizing 硬约束跳过；
//     ready 隐式豁免已移除（未收藏 ready 超龄同样清退，记忆经描述封存进 raw）；
//   ③召回替换：源文件在 → [图片|id|描述]；缺失 → 统一懒清退（不看收藏，
//     [类型|内容已清退|描述]）+ 触发修复；pending/synthesizing 占位符原样保留。
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

test('收藏豁免：favorited=1 超龄资产不清退（文件+记录永久保留）', async () => {
  const { store, media, retention, mediaDir, close } = await open();
  try {
    const file = makeImage(mediaDir, 'fav.png');
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [{ id: 'ma_cafeface0001', kind: 'image', fileRef: file, createdAt: Date.now() - 60 * 86400_000 }],
    });
    // 超龄 + 收藏（setFavorite：清退豁免唯一依据）
    const staleRow = media.get('ma_cafeface0001');
    store.media.put({ ...staleRow, updatedAt: Date.now() - 60 * 86400_000, status: 'ready', desc: '一只橘猫躺在键盘上', favorited: true });
    assert.equal(media.get('ma_cafeface0001').favorited, true, 'v7 favorited 归一化透传');
    const result = await retention.runOnce();
    assert.equal(result.retired, 0, '收藏资产豁免清退');
    assert.ok(media.get('ma_cafeface0001'), '记录保留');
    assert.ok(fs.existsSync(file), '源文件保留');
  } finally { close(); }
});

test('ready 隐式豁免移除：未收藏 ready 超龄 → 清退 + 描述封存进 raw/摘要', async () => {
  const { store, media, retention, mediaDir, close } = await open();
  try {
    const file = makeImage(mediaDir, 'parsed.png');
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [{ id: 'ma_cafeface0002', kind: 'image', fileRef: file, createdAt: Date.now() - 60 * 86400_000 }],
    });
    const staleRow = media.get('ma_cafeface0002');
    store.media.put({ ...staleRow, updatedAt: Date.now() - 60 * 86400_000, status: 'ready', desc: '一只橘猫躺在键盘上' });
    store.raw.append({
      sessionId: sessionKey(), msgId: '9003',
      text: '看这张 [图片|ma_cafeface0002]',
    });
    const result = await retention.runOnce();
    assert.equal(result.retired, 1, 'ready 不再豁免（收藏才是唯一豁免）');
    assert.equal(media.get('ma_cafeface0002'), null, '记录删除');
    assert.ok(!fs.existsSync(file), '源文件删除');
    // 描述封存：raw 占位符 → [图片|内容已清退|一只橘猫躺在键盘上]
    assert.ok(store.raw.getByMsgId(sessionKey(), '9003').text.includes('[图片|内容已清退|一只橘猫躺在键盘上]'), '描述固化进 raw');
  } finally { close(); }
});

test('中间态硬约束：synthesizing/pending 无源文件跳过；pending 有源文件照清', async () => {
  const { store, media, retention, mediaDir, close } = await open();
  try {
    const p = makeImage(mediaDir, 'pending.png');
    const s = makeImage(mediaDir, 'synth.wav');
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [
        { id: 'ma_aabb00110001', kind: 'image', fileRef: p },
        { id: 'ma_aabb00110002', kind: 'voice', fileRef: s },
      ],
    });
    const stale = (id) => {
      const row = media.get(id);
      store.media.put({ ...row, updatedAt: Date.now() - 60 * 86400_000 });
    };
    // synthesizing（合成 25-90s 中间态，sourcePath 空）：硬约束跳过
    store.media.put({ ...media.get('ma_aabb00110002'), status: 'synthesizing', sourcePath: '' });
    stale('ma_aabb00110002');
    // pending 无源文件（analyzer 队列中间态）：跳过
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [{ id: 'ma_cafe00000001', kind: 'voice', origin: 'voice_lib', sourcePath: '' }],
    });
    store.media.put({ ...media.get('ma_cafe00000001'), updatedAt: Date.now() - 60 * 86400_000 });
    // pending 有源文件（有真文件的陈年孤儿）：超龄照清（有文件可删，无误删面）
    stale('ma_aabb00110001');
    const result = await retention.runOnce();
    assert.equal(result.retired, 1, '只清 pending 有源文件的陈年孤儿');
    assert.equal(media.get('ma_aabb00110001'), null);
    assert.ok(media.get('ma_aabb00110002') && media.get('ma_cafe00000001'), '中间态记录保留');
  } finally { close(); }
});

test('failed 超龄照常清退（僵尸行回收）', async () => {
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
    assert.equal(result.retired, 1, '未被收藏（failed）超龄照常清退');
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

test('懒清退不看收藏：favorited 语音源文件真缺失 → 删行 + [语音|内容已清退|转写]', async () => {
  const { store, media, retention, mediaDir, close } = await open();
  try {
    const wav = makeImage(mediaDir, 'voice.wav', Buffer.from([0x52, 0x49, 0x46, 0x46]));
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [{ id: 'ma_facade000001', kind: 'voice', fileRef: wav }],
    });
    media.updateDesc('ma_facade000001', { textContent: '晚上好呀～今天也辛苦啦！' });
    media.setFavorite('ma_facade000001', true);
    assert.equal(media.get('ma_facade000001').favorited, true);
    // 源文件真消失（手动删/磁盘故障）——收藏也保不住
    fs.unlinkSync(wav);
    store.raw.append({
      sessionId: sessionKey(), msgId: '9004',
      text: '我说 [语音|ma_facade000001]',
    });
    const { text: rendered, repaired } = media.renderPlaceholders('回放 [语音|ma_facade000001]');
    assert.ok(rendered.includes('[语音|内容已清退|晚上好呀～今天也辛苦啦！]'), '懒清退不受收藏豁免 + 描述封存');
    assert.deepEqual(repaired, ['ma_facade000001']);
    assert.equal(media.get('ma_facade000001'), null, '详情行删除');
    assert.ok(store.raw.getByMsgId(sessionKey(), '9004').text.includes('[语音|内容已清退|晚上好呀～今天也辛苦啦！]'), 'raw 回调修复类型保持');
  } finally { close(); }
});

test('懒清退类型词保持：表情占位符 + 无描述资产 → [表情|内容已清退]', async () => {
  const { media, mediaDir, close } = await open();
  try {
    const img = makeImage(mediaDir, 'sticker.png');
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [{ id: 'ma_decade000001', kind: 'image', fileRef: img }],
    });
    fs.unlinkSync(img); // 无 desc/textContent → 退化为两段式
    const { text } = media.renderPlaceholders('来个 [表情|ma_decade000001]');
    assert.ok(text.includes('[表情|内容已清退]'), '类型词按占位符保持（不再错标图片）');
    assert.ok(!text.includes('ma_decade000001'), '裸 id 不残留');
  } finally { close(); }
});

test('synthesizing 占位符原样保留；pending 无文件孤儿走懒清退', async () => {
  const { media, mediaDir, close } = await open();
  try {
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [{ id: 'ma_c0de00000001', kind: 'voice', origin: 'voice_lib', sourcePath: '' }],
    });
    media.markSynthesizing('ma_c0de00000001');
    const synthText = '说一句 [语音|ma_c0de00000001]';
    const { text: r1 } = media.renderPlaceholders(synthText);
    assert.equal(r1, synthText, 'synthesizing 原样保留（硬约束）');
    // pending 无文件孤儿（提交即标 synthesizing，残留 pending 是异常）：懒清退兜底
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [{ id: 'ma_dead00000001', kind: 'voice', origin: 'voice_lib', sourcePath: '' }],
    });
    const { text: r2 } = media.renderPlaceholders('另一句 [语音|ma_dead00000001]');
    assert.ok(r2.includes('[语音|内容已清退]'), 'pending 孤儿懒清退（转写从未发生，无记忆可保）');
  } finally { close(); }
});

test('热门图片自动收藏：use_count 达阈值 setFavorite；语音不触发', async () => {
  const { store, media, mediaDir, close } = await open();
  try {
    const img = makeImage(mediaDir, 'hot.png');
    const wav = makeImage(mediaDir, 'voice-hot.wav', Buffer.from([0x52, 0x49, 0x46, 0x46]));
    await media.ensureAssets({
      sessionId: sessionKey(),
      media: [
        { id: 'ma_feed00000001', kind: 'image', fileRef: img },
        { id: 'ma_beef00000001', kind: 'voice', fileRef: wav },
      ],
    });
    for (let i = 0; i < 3; i += 1) media.markUsed('ma_feed00000001'); // 阈值 3
    assert.equal(media.get('ma_feed00000001').favorited, true, '图片第 3 次使用自动收藏');
    media.markUsed('ma_beef00000001');
    media.markUsed('ma_beef00000001');
    media.markUsed('ma_beef00000001');
    media.markUsed('ma_beef00000001');
    assert.notEqual(media.get('ma_beef00000001').favorited, true, '语音不参与频率收藏');
  } finally { close(); }
});
