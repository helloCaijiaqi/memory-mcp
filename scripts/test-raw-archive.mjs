// 原始层运维的单测：冷归档（gzip 分片）、元数据清理、按消息 / 发送者 / 平台硬删级联。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { anchorId, openStore } from '../src/store/store-api.js';
import { createMemoryService } from '../src/service/memory-service.js';
import { archivePathFor, createRawService } from '../src/service/raw-service.js';
import { parseArgs } from './raw-archive.mjs';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-raw-'));
const SESSION = 'qq:group:40001';
const WX_SESSION = 'wx:room:40001';
const DAY = 24 * 60 * 60 * 1000;
const OLD = Date.now() - 40 * DAY;

async function svc() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const raw = createRawService({ store, stateDir: dir, logger: { log() {} } });
  const memory = createMemoryService({ store });
  return { dir, store, raw, memory, close: () => store.close() };
}

function lines(text) {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test('归档：先落 gzip 分片，再清正文并保留 msgId/发送者/锚点', async () => {
  const { store, raw, close } = await svc();
  try {
    for (const index of [1, 2, 3]) {
      store.raw.append({
        sessionId: SESSION,
        msgId: `a${index}`,
        senderId: 'u1',
        text: `四十天前的话 ${index}`,
        createdAt: OLD + index,
      });
    }
    store.raw.append({ sessionId: SESSION, msgId: 'fresh', senderId: 'u1', text: '刚说的话' });

    const out = await raw.archive({ days: 30 });
    assert.equal(out.archived, 3);
    assert.equal(out.dryRun, false);
    assert.equal(out.files.length, 1, '同一天的同一会话应落在一个分片里');

    const file = archivePathFor(raw.root, { platform: 'qq', sessionId: SESSION, createdAt: OLD });
    assert.equal(out.files[0].path, file);
    assert.ok(fs.existsSync(file), '盘上必须有分片，否则就是「库里说归档了、其实丢了」');

    const archived = lines(await raw.readArchive(file));
    assert.equal(archived.length, 3);
    assert.ok(archived.every((row) => row.text && row.anchor && row.msgId && row.senderId), '正文与锚点都要完整');
    assert.ok(archived.some((row) => row.text === '四十天前的话 2'));

    const row = store.raw.getByMsgId(SESSION, 'a1');
    assert.equal(row.text, '', '归档后正文清空，避免双份留存');
    assert.ok(row.archivedAt > 0);
    assert.equal(row.anchor, anchorId(SESSION, 'a1'), '锚点必须保留，摘要还要靠它回溯');
    assert.equal(row.senderId, 'u1');
    assert.equal(row.msgId, 'a1');

    const fresh = store.raw.getByMsgId(SESSION, 'fresh');
    assert.equal(fresh.text, '刚说的话', '保留期内的消息不能被碰');
    assert.equal(fresh.archivedAt, null);

    assert.equal(store.raw.count({ sessionId: SESSION }), 1, '默认查询只看未归档');
    assert.equal(store.raw.count({ sessionId: SESSION, includeArchived: true }), 4);
    assert.deepEqual(store.raw.query({ sessionId: SESSION, text: '四十天前的话 1' }).rows, [], '归档后 FTS 不该再命中');
  } finally {
    close();
  }
});

test('归档幂等；按平台分目录', async () => {
  const { store, raw, close } = await svc();
  try {
    store.raw.append({ sessionId: SESSION, msgId: 'q1', senderId: 'u1', text: 'QQ 旧消息', createdAt: OLD });
    store.raw.append({ sessionId: WX_SESSION, msgId: 'w1', senderId: 'wxid', text: '微信旧消息', createdAt: OLD });

    const first = await raw.archive({ days: 30 });
    assert.equal(first.archived, 2);
    assert.equal(first.files.length, 2, '不同平台必须分目录');
    const qqFile = archivePathFor(raw.root, { platform: 'qq', sessionId: SESSION, createdAt: OLD });
    const wxFile = archivePathFor(raw.root, { platform: 'wx', sessionId: WX_SESSION, createdAt: OLD });
    assert.ok(fs.existsSync(qqFile) && fs.existsSync(wxFile));
    assert.ok(qqFile.includes(path.join('raw-archive', 'qq')));
    assert.ok(wxFile.includes(path.join('raw-archive', 'wx')));

    const again = await raw.archive({ days: 30 });
    assert.equal(again.archived, 0, '已归档的行不该被再次导出');
    assert.equal(again.files.length, 0);
  } finally {
    close();
  }
});

test('dry-run 只报数：不写盘、不改库', async () => {
  const { store, raw, close } = await svc();
  try {
    store.raw.append({ sessionId: SESSION, msgId: 'd1', senderId: 'u1', text: '待归档一', createdAt: OLD });
    store.raw.append({ sessionId: SESSION, msgId: 'd2', senderId: 'u1', text: '待归档二', createdAt: OLD + 1 });

    const dry = await raw.archive({ days: 30, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.backlog, 2, 'backlog 必须是准确值');
    assert.equal(dry.sampled, 2);
    assert.equal(fs.existsSync(dry.files[0].path), false, 'dry-run 不能落盘');

    const row = store.raw.getByMsgId(SESSION, 'd1');
    assert.equal(row.text, '待归档一', 'dry-run 不能清正文');
    assert.equal(row.archivedAt, null);
    assert.equal(store.raw.count({ includeArchived: true }), 2);
  } finally {
    close();
  }
});

test('旧分片可以多次追加（多 gzip member 仍能被读成一个文件）', async () => {
  const { store, raw, close } = await svc();
  try {
    store.raw.append({ sessionId: SESSION, msgId: 'm1', senderId: 'u1', text: '第一批', createdAt: OLD });
    await raw.archive({ days: 30 });
    store.raw.append({ sessionId: SESSION, msgId: 'm2', senderId: 'u1', text: '第二批', createdAt: OLD + 1000 });
    await raw.archive({ days: 30 });

    const file = archivePathFor(raw.root, { platform: 'qq', sessionId: SESSION, createdAt: OLD });
    const rows = lines(await raw.readArchive(file));
    assert.deepEqual(
      rows.map((row) => row.msgId),
      ['m1', 'm2'],
    );
  } finally {
    close();
  }
});

test('按消息硬删：库行消失，归档分片同步重写', async () => {
  const { store, raw, close } = await svc();
  try {
    for (const index of [1, 2, 3]) {
      store.raw.append({ sessionId: SESSION, msgId: `p${index}`, senderId: 'u1', text: `原文 ${index}`, createdAt: OLD + index });
    }
    await raw.archive({ days: 30 });
    const file = archivePathFor(raw.root, { platform: 'qq', sessionId: SESSION, createdAt: OLD });

    const out = await raw.purge({ sessionId: SESSION, msgId: 'p2' });
    assert.equal(out.removed, 1);
    assert.equal(out.truncated, false);
    assert.equal(store.raw.getByMsgId(SESSION, 'p2'), null, '库里必须彻底消失');

    const rows = lines(await raw.readArchive(file));
    assert.deepEqual(
      rows.map((row) => row.msgId),
      ['p1', 'p3'],
      '盘上也不能留着被删的那条',
    );
    assert.equal(out.archives.removedLines, 1);
  } finally {
    close();
  }
});

test('归档重写失败：purge 抛错且库行保留（不能「删了库、盘上还在」）', async () => {
  const { store, raw, close } = await svc();
  try {
    store.raw.append({ sessionId: SESSION, msgId: 'x1', senderId: 'u1', text: '要被彻底忘掉', createdAt: OLD });
    await raw.archive({ days: 30 });
    assert.ok(store.raw.getByMsgId(SESSION, 'x1'), '前置条件：行还在库里（已归档，正文清空）');

    // 故障注入：把平台归档目录换成普通文件 → readdir 抛 ENOTDIR。
    // 旧实现此时已经把库行删掉了（边扫边删），盘上原文却还在。
    const platformDir = path.join(raw.root, 'qq');
    fs.rmSync(platformDir, { recursive: true, force: true });
    fs.writeFileSync(platformDir, 'not a directory');

    await assert.rejects(() => raw.purge({ sessionId: SESSION, msgId: 'x1' }));
    assert.ok(store.raw.getByMsgId(SESSION, 'x1'), '归档没改成功前，库行必须保留，方便整体重试');

    // 恢复后重试：这次能真正删掉（归档目录已不存在 → 视为无分片）。
    fs.rmSync(platformDir, { force: true });
    const out = await raw.purge({ sessionId: SESSION, msgId: 'x1' });
    assert.equal(out.removed, 1);
    assert.equal(store.raw.getByMsgId(SESSION, 'x1'), null);
  } finally {
    close();
  }
});

test('跨会话同名 msgId：只删目标会话的归档行', async () => {
  const { store, raw, close } = await svc();
  const A = 'qq:group:50001';
  const B = 'qq:group:50002';
  try {
    store.raw.append({ sessionId: A, msgId: '100', senderId: 'u1', text: 'A 的消息', createdAt: OLD });
    store.raw.append({ sessionId: B, msgId: '100', senderId: 'u2', text: 'B 的消息', createdAt: OLD + 1 });
    await raw.archive({ days: 30 });

    await raw.purge({ sessionId: A, msgId: '100' });
    assert.equal(store.raw.getByMsgId(A, '100'), null);

    const fileB = archivePathFor(raw.root, { platform: 'qq', sessionId: B, createdAt: OLD + 1 });
    const rowsB = lines(await raw.readArchive(fileB));
    assert.deepEqual(rowsB.map((row) => row.text), ['B 的消息'], 'B 会话同 msgId 的归档必须原样保留');
  } finally {
    close();
  }
});

test('按发送者硬删：级联摘掉派生行的 sourceMsgIds，引用清空则整行归档', async () => {
  const { store, raw, memory, close } = await svc();
  try {
    // raw-only：ingest 只落原文；派生行（摘要/记录）经 memory.put 显式构造，
    // 用 sourceMsgIds 锚定到将被 purge 的原文 msgId —— 级联逻辑与行的来源无关。
    memory.ingest({ sessionId: SESSION, msgId: 'c1', senderId: 'u9', text: '要忘掉的话一' });
    memory.ingest({ sessionId: SESSION, msgId: 'c2', senderId: 'u9', text: '要忘掉的话二' });
    const direct1 = store.memory.put({
      sessionId: SESSION,
      tier: 'short',
      content: '只引用 c1 的行',
      sourceMsgIds: ['c1'],
    });
    const direct2 = store.memory.put({
      sessionId: SESSION,
      tier: 'short',
      content: '只引用 c2 的行',
      sourceMsgIds: ['c2'],
    });
    const shared = store.memory.put({
      sessionId: SESSION,
      tier: 'short',
      content: '同时引用两条的摘要',
      sourceMsgIds: ['c1', 'c2'],
    });
    const partial = store.memory.put({
      sessionId: SESSION,
      tier: 'short',
      content: '只引用一条的摘要',
      sourceMsgIds: ['c1', 'keep'],
    });
    memory.renderHead({ sessionId: SESSION });
    assert.ok(store.snapshot.get(SESSION), '前置条件：head 快照存在');

    const out = await raw.purge({ sessionId: SESSION, senderId: 'u9' });
    assert.equal(out.removed, 2);
    assert.equal(store.raw.count({ sessionId: SESSION, includeArchived: true }), 0);

    const archivedOne = store.memory.get(direct1.id);
    assert.deepEqual(archivedOne.sourceMsgIds, []);
    assert.equal(archivedOne.status, 'archived', '引用清空就该整行归档，否则是「忘了但还记着」');
    assert.equal(store.memory.get(direct2.id).status, 'archived');
    assert.equal(store.memory.get(shared.id).status, 'archived');

    const still = store.memory.get(partial.id);
    assert.deepEqual(still.sourceMsgIds, ['keep'], '只摘掉被删的引用');
    assert.equal(still.status, 'active');

    assert.equal(out.derived.archived, 3);
    assert.equal(out.derived.cleaned, 1);
    assert.equal(store.snapshot.get(SESSION), null, '派生内容变了，head 快照必须失效');
    assert.equal(out.headsInvalidated, 1);
  } finally {
    close();
  }
});

test('按平台硬删：整平台清理（退出 / 迁移用），不碰别的平台', async () => {
  const { store, raw, close } = await svc();
  try {
    store.raw.append({ sessionId: SESSION, msgId: 'f1', senderId: 'u1', text: 'QQ 侧', createdAt: OLD });
    store.raw.append({ sessionId: WX_SESSION, msgId: 'f2', senderId: 'wxid', text: '微信侧', createdAt: OLD });
    await raw.archive({ days: 30 });

    const out = await raw.purge({ platform: 'qq' });
    assert.equal(out.removed, 1);
    assert.equal(store.raw.count({ platform: 'qq', includeArchived: true }), 0);
    assert.equal(store.raw.count({ platform: 'wx', includeArchived: true }), 1);
    assert.deepEqual(await raw.listArchives({ platform: 'qq' }), [], '该平台的分片应被删干净');
    assert.equal((await raw.listArchives({ platform: 'wx' })).length, 1);
  } finally {
    close();
  }
});

test('没有任何过滤条件的硬删必须拒绝（不允许清空整表）', async () => {
  const { raw, close } = await svc();
  try {
    await assert.rejects(() => raw.purge({}), TypeError);
    await assert.rejects(() => raw.purge({ sessionId: undefined }), TypeError);
  } finally {
    close();
  }
});

test('backlog 报出归档积压（preflight / 告警用）', async () => {
  const { store, raw, close } = await svc();
  try {
    store.raw.append({ sessionId: SESSION, msgId: 'b1', senderId: 'u1', text: '旧', createdAt: OLD });
    store.raw.append({ sessionId: SESSION, msgId: 'b2', senderId: 'u1', text: '新' });
    const pending = raw.backlog({ days: 30 });
    assert.equal(pending.rows, 1);
    assert.ok(pending.cutoff < Date.now());
  } finally {
    close();
  }
});

test('CLI 参数解析：默认值、等号写法、未知参数快速失败', () => {
  assert.deepEqual(parseArgs([]), { days: undefined, dryRun: false, platform: undefined, session: undefined, json: false, help: false });
  assert.equal(parseArgs(['--dry-run', '--days', '7']).days, 7);
  assert.equal(parseArgs(['--days=3']).days, 3);
  assert.equal(parseArgs(['--platform=QQ']).platform, 'qq');
  assert.equal(parseArgs(['--session=qq:group:1']).session, 'qq:group:1');
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
  assert.throws(() => parseArgs(['--days', 'abc']), /非负数字/);
});
