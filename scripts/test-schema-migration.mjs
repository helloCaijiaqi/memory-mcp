// 迁移与新增集合的离线单测：不碰生产 state，全部在临时目录里开库。
//
// 重点是「老库能升上来」这件事。SCHEMA 靠 IF NOT EXISTS 执行，对「表已存在但缺列」完全无效，
// 所以必须有这么一个用例真的拿一个旧形状的库来升级，否则迁移写错了线上也发现不了。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { anchorId, openStore, rawRowId } from '../src/store/store-api.js';
import { SCHEMA_VERSION } from '../src/store/sqlite-schema.js';
import { openSqliteStore } from '../src/store/sqlite-store.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-schema-'));
const SESSION = 'qq:group:10086';
const PRIVATE = 'qq:private:20086';
const WX_ROOM = 'wx:room:10086';

function tempDir(label) {
  return fs.mkdtempSync(path.join(TMP_ROOT, `${label}-`));
}

/** 造一个「上线第一天」形状的库：只有基线表，user_version = 0。 */
function makeLegacyDb(dir) {
  const dbPath = path.join(dir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, platform TEXT NOT NULL, tier TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL DEFAULT 0, base_weight REAL NOT NULL DEFAULT 1,
      hits INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_touch_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(content, id UNINDEXED, tokenize = 'trigram');
  `);
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory (id, session_id, platform, tier, category, content, extra, importance,
                         base_weight, hits, status, created_at, updated_at, last_touch_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, '', 5, 1, 2, 'active', ?, ?, ?, NULL)`,
  ).run('mem_legacy', SESSION, 'qq', 'long', '话题', '升级前就存在的旧记忆', now, now, now);
  db.prepare("INSERT INTO memory_fts (content, id) VALUES (?, ?)").run('升级前就存在的旧记忆', 'mem_legacy');
  db.close();
  return dbPath;
}

function columnsOf(dbPath, table) {
  const db = new DatabaseSync(dbPath);
  try {
    return new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String(row.name)),
    );
  } finally {
    db.close();
  }
}

function userVersion(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  } finally {
    db.close();
  }
}

test('老库升级：memory 补齐新列、新表建起来，旧数据原样可读', () => {
  const dir = tempDir('upgrade');
  const dbPath = makeLegacyDb(dir);
  assert.equal(userVersion(dbPath), 0, '夹具应该是未迁移状态');

  const store = openSqliteStore({ dir });
  try {
    assert.equal(store.schemaVersion, SCHEMA_VERSION, '升级后版本号应等于 SCHEMA_VERSION');

    const memoryCols = columnsOf(dbPath, 'memory');
    for (const column of ['kind', 'subject_id', 'source_msg_ids', 'decay_exempt']) {
      assert.ok(memoryCols.has(column), `memory 应补齐列 ${column}`);
    }
    for (const table of ['raw_message', 'raw_fts', 'relation', 'relation_history', 'head_snapshot']) {
      assert.ok(columnsOf(dbPath, table).size > 0, `应建立 ${table}`);
    }

    const legacy = store.memory.get('mem_legacy');
    assert.equal(legacy.content, '升级前就存在的旧记忆', '旧数据不能被迁移动过');
    assert.equal(legacy.kind, 'episodic', '新列的默认值应让旧行可读');
    assert.deepEqual(legacy.sourceMsgIds, []);
    assert.equal(legacy.decayExempt, false);
    assert.equal(store.memory.query({ sessionId: SESSION, text: '旧记忆' }).rows.length, 1, '旧行的 FTS 索引仍可用');
  } finally {
    store.close();
  }
});

test('迁移可重复执行：第二次开库不报错、版本不变、不重复建对象', () => {
  const dir = tempDir('idempotent');
  const dbPath = makeLegacyDb(dir);
  const first = openSqliteStore({ dir });
  first.close();

  const second = openSqliteStore({ dir });
  try {
    assert.equal(second.schemaVersion, SCHEMA_VERSION);
    assert.equal(userVersion(dbPath), SCHEMA_VERSION);
    assert.equal(second.memory.count(), 1, '重复迁移不应复制数据');
  } finally {
    second.close();
  }
});

test('手工加过列的库也不会在迁移时炸（列存在性判断幂等）', () => {
  const dir = tempDir('manual-column');
  const dbPath = makeLegacyDb(dir);
  const db = new DatabaseSync(dbPath);
  // 模拟「有人用 DB Browser 手动加过一次列」：列在、版本号没涨。
  db.exec("ALTER TABLE memory ADD COLUMN kind TEXT NOT NULL DEFAULT 'semantic'");
  db.prepare("UPDATE memory SET kind = 'semantic' WHERE id = 'mem_legacy'").run();
  db.close();

  const store = openSqliteStore({ dir });
  try {
    assert.equal(store.schemaVersion, SCHEMA_VERSION);
    const cols = [...columnsOf(dbPath, 'memory')].filter((name) => name === 'kind');
    assert.equal(cols.length, 1, '不能重复加同名列');
    // 手动加过的列不被迁移改回去，值保留。
    assert.equal(store.memory.get('mem_legacy').kind, 'semantic');
  } finally {
    store.close();
  }
});

test('platform 与 sessionId 前缀不一致时，数据库层直接拒绝（CHECK 兜底）', () => {
  const dir = tempDir('platform-check');
  const store = openSqliteStore({ dir });
  store.close();
  const db = new DatabaseSync(path.join(dir, 'memory.db'));
  try {
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO relation (id, session_id, platform, subject_id, key, value, kind, scope,
                                   importance, decay_exempt, created_at, updated_at)
             VALUES ('rel_bad', ?, 'wx', 'u1', '称呼', '老王', 'relation', 'session', 0, 1, 1, 1)`,
          )
          .run(SESSION),
      /CHECK|constraint/i,
      '写错平台的派生值必须被数据库挡住',
    );
  } finally {
    db.close();
  }
});

test('原始层：重复投递只落一条，锚点稳定，平台隔离', () => {
  const dir = tempDir('raw');
  const store = openSqliteStore({ dir });
  try {
    const first = store.raw.append({
      sessionId: SESSION,
      msgId: '8899',
      senderId: '10001',
      text: '今天讨论了记忆检索的分层方案',
      meta: { type: 'text' },
    });
    assert.equal(first.created, true);
    assert.equal(first.row.id, rawRowId(SESSION, '8899'));
    assert.equal(first.row.anchor, anchorId(SESSION, '8899'));
    assert.equal(first.row.platform, 'qq');

    const again = store.raw.append({
      sessionId: SESSION,
      msgId: '8899',
      senderId: '10001',
      text: '被改写过的正文不该覆盖原文',
    });
    assert.equal(again.created, false, '同一 (sessionId, msgId) 不应产生第二条');
    assert.equal(again.row.text, '今天讨论了记忆检索的分层方案', '原始层只追加，不覆盖');
    assert.equal(store.raw.count({ sessionId: SESSION }), 1);

    // 同一 scope:id 换个平台就是另一条会话，不能串。
    store.raw.append({ sessionId: WX_ROOM, msgId: '8899', senderId: 'wxid_a', text: '微信侧同号消息' });
    assert.equal(store.raw.count({ platform: 'wx' }), 1);
    assert.equal(store.raw.getByMsgId(WX_ROOM, '8899').text, '微信侧同号消息');
    assert.notEqual(store.raw.getByMsgId(SESSION, '8899').id, store.raw.getByMsgId(WX_ROOM, '8899').id);

    const fts = store.raw.query({ sessionId: SESSION, text: '记忆检索' });
    assert.equal(fts.rows.length, 1);
    assert.equal(fts.strategy, 'fts5');
    const short = store.raw.query({ sessionId: SESSION, text: '记忆' });
    assert.equal(short.rows.length, 1, '2 字查询要落到 LIKE 兜底');
    assert.equal(short.strategy, 'like');
  } finally {
    store.close();
  }
});

test('原始层：归档清空正文但留元数据，硬删按发言人级联', () => {
  const dir = tempDir('raw-archive');
  const store = openSqliteStore({ dir });
  try {
    const a = store.raw.append({ sessionId: SESSION, msgId: '1', senderId: 'u1', text: '很早以前的一句话' });
    store.raw.append({ sessionId: SESSION, msgId: '2', senderId: 'u2', text: '另一个人说的话' });

    assert.deepEqual(store.raw.archive({ ids: [a.row.id] }), { archived: 1 });
    const archived = store.raw.get(a.row.id);
    assert.equal(archived.text, '', '归档后正文必须清空');
    assert.equal(archived.msgId, '1', '元数据与锚点要留着');
    assert.equal(archived.anchor, anchorId(SESSION, '1'));
    assert.equal(store.raw.query({ sessionId: SESSION, text: '很早以前' }).rows.length, 0, '归档行不该再被搜到');
    assert.equal(store.raw.count({ sessionId: SESSION, includeArchived: true }), 2);

    const victimId = store.raw.getByMsgId(SESSION, '2').id;
    assert.deepEqual(store.raw.purge({ sessionId: SESSION, senderId: 'u2' }), {
      removed: 1,
      ids: [victimId],
    });
    assert.equal(store.raw.count({ sessionId: SESSION, includeArchived: true }), 1);
    assert.throws(() => store.raw.purge({}), /至少需要一个过滤条件/);
  } finally {
    store.close();
  }
});

test('关系层：同值不写历史、变值留链、稳定排序、平台隔离', () => {
  const dir = tempDir('relation');
  const store = openSqliteStore({ dir });
  try {
    const created = store.relation.upsert({
      sessionId: SESSION,
      subjectId: '10001',
      key: '称呼',
      value: '老张',
      importance: 8,
    });
    assert.equal(created.created, true);
    assert.equal(created.row.decayExempt, true, '关系默认豁免衰减');
    assert.equal(store.relation.history({ relationId: created.row.id }).rows.length, 1, '新建也要写第一条历史');

    const same = store.relation.upsert({
      sessionId: SESSION,
      subjectId: '10001',
      key: '称呼',
      value: '老张',
      importance: 9,
    });
    assert.equal(same.created, false);
    assert.equal(same.changed, false, '同值重复上报不算变更');
    assert.equal(store.relation.history({ relationId: created.row.id }).rows.length, 1);
    assert.equal(same.row.importance, 9, '重要度仍然要更新');

    const changed = store.relation.upsert({
      sessionId: SESSION,
      subjectId: '10001',
      key: '称呼',
      value: '张哥',
    });
    assert.equal(changed.changed, true);
    const history = store.relation.history({ relationId: created.row.id }).rows;
    assert.equal(history.length, 2);
    assert.equal(history.at(-1).value, '张哥', '历史最后一条应等于当前值');
    assert.equal(store.relation.getByKey({ sessionId: SESSION, subjectId: '10001', key: '称呼' }).value, '张哥');

    const mood = store.relation.upsert({
      sessionId: SESSION,
      subjectId: '10001',
      key: 'mood',
      kind: 'emotion',
      value: '有点烦',
    });
    assert.equal(mood.row.decayExempt, false, '情绪必须衰减');

    store.relation.upsert({ sessionId: WX_ROOM, subjectId: '10001', key: '称呼', value: '微信里的老张' });
    const qqOnly = store.relation.list({ sessionId: SESSION });
    assert.equal(qqOnly.rows.length, 2, '另一个平台的关系不该串进来');
    assert.deepEqual(
      qqOnly.rows.map((row) => row.key),
      ['mood', '称呼'],
      '稳定排序：kind → subject → 建立时间',
    );
    assert.equal(store.relation.count({ platform: 'wx' }), 1);
  } finally {
    store.close();
  }
});

test('head 快照：put/get/touch 只推动活跃时间，不动 revision', () => {
  const dir = tempDir('snapshot');
  const store = openSqliteStore({ dir });
  try {
    store.snapshot.put({
      sessionId: SESSION,
      revision: 'rev-1',
      headText: '【长期记忆】\n- 一条',
      builtAt: 1000,
      lastActivityAt: 1000,
    });
    assert.equal(store.snapshot.get(SESSION).revision, 'rev-1');
    store.snapshot.touch(SESSION, 2000);
    const touched = store.snapshot.get(SESSION);
    assert.equal(touched.lastActivityAt, 2000);
    assert.equal(touched.revision, 'rev-1', 'touch 不能顺手重建 head');
    assert.equal(touched.platform, 'qq');
    assert.equal(store.snapshot.count(), 1);
  } finally {
    store.close();
  }
});

test('JSON 兜底后端：新集合可用、带 degraded 标记、重开仍在', async () => {
  const dir = tempDir('json');
  const store = await openStore({ dir, backend: 'json' });
  assert.equal(store.degraded, true);
  assert.equal(store.schemaVersion, null);
  store.raw.append({ sessionId: SESSION, msgId: '1', senderId: 'u1', text: '兜底后端也要落原文' });
  store.relation.upsert({ sessionId: SESSION, subjectId: 'u1', key: '称呼', value: '老王' });
  store.snapshot.put({ sessionId: SESSION, revision: 'r1', headText: 'head' });
  assert.equal(store.raw.count({ sessionId: SESSION }), 1);
  store.close();

  const reopened = await openStore({ dir, backend: 'json' });
  try {
    assert.equal(reopened.raw.getByMsgId(SESSION, '1').text, '兜底后端也要落原文');
    assert.equal(reopened.relation.getByKey({ sessionId: SESSION, subjectId: 'u1', key: '称呼' }).value, '老王');
    assert.equal(reopened.snapshot.get(SESSION).revision, 'r1');
    assert.equal(reopened.raw.query({ sessionId: SESSION, text: '落原文' }).strategy, 'like');
  } finally {
    reopened.close();
  }
});
