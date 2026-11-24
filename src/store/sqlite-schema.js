// SQLite 建表语句与行列映射。SQL 只出现在这里，换后端时业务代码不用改。
//
// 两种角色，别混：
//   SCHEMA      —— 基线。新库一次建全；只允许追加 IF NOT EXISTS 的语句，不改已有表结构。
//   MIGRATIONS  —— 增量。已有库靠它补齐基线之后的形状；语句必须可重复执行
//                  （ALTER 的列存在性由 sqlite-store 的迁移器判定，CREATE 一律带 IF NOT EXISTS）。
//
// 为什么不用 SCHEMA 改表：SCHEMA 靠 IF NOT EXISTS 执行，对「表已存在但缺列」完全无效，
// 老库会静默缺列（写入报错或字段丢失），这类问题在生产上极难定位。

export const SCHEMA_VERSION = 5;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  platform      TEXT NOT NULL,
  tier          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  extra         TEXT NOT NULL DEFAULT '',
  importance    INTEGER NOT NULL DEFAULT 0,
  base_weight   REAL NOT NULL DEFAULT 1,
  hits          INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_touch_at INTEGER NOT NULL,
  expires_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_session ON memory(session_id, tier, status);
CREATE INDEX IF NOT EXISTS idx_memory_touch   ON memory(last_touch_at);

CREATE TABLE IF NOT EXISTS slang (
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  meaning    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'candidate',
  evidence   TEXT NOT NULL DEFAULT '[]',
  score      REAL NOT NULL DEFAULT 0,
  hits       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slang_status ON slang(status, score);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, id UNINDEXED, tokenize = 'trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS slang_fts  USING fts5(content, meaning, id UNINDEXED, tokenize = 'trigram');

-- 会话纪元（召回只在会话创建时注入一次的依据）：静默 ≥ inactiveMs 惰性推进 epoch。
-- last_summarized_at 同时承担摘要游标（= 摘要过的 raw 上界），不再单设 summary_cursor。
CREATE TABLE IF NOT EXISTS session_state (
  session_id         TEXT PRIMARY KEY,
  platform           TEXT NOT NULL DEFAULT '',
  epoch              INTEGER NOT NULL DEFAULT 1,
  last_activity_at   INTEGER NOT NULL,
  last_summarized_at INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- 人物画像（每对象一份）+ 版本链（可回滚）。
-- scope 双层（V2 统一改造）：identity = 全局画像（session_id=''，platform+subject_id
-- 打底），session = 会话覆盖（存量口径，默认值）。get 时 identity 打底 + session 覆盖。
CREATE TABLE IF NOT EXISTS profile (
  session_id     TEXT NOT NULL,
  platform       TEXT NOT NULL DEFAULT '',
  subject_id     TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'session',
  attributes     TEXT NOT NULL DEFAULT '{}',
  confidence     REAL NOT NULL DEFAULT 0.5,
  source_msg_ids TEXT NOT NULL DEFAULT '[]',
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, subject_id)
);
CREATE TABLE IF NOT EXISTS profile_history (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  version        INTEGER NOT NULL,
  attributes     TEXT NOT NULL,
  confidence     REAL NOT NULL,
  source_msg_ids TEXT NOT NULL DEFAULT '[]',
  changed_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_history ON profile_history(session_id, subject_id, version);

-- 关系冲突待确认池：自动抽取低于覆盖阈值（relation 0.9 / profile 0.8）时挂起，
-- 人工 accept 走正常 upsert（actor=manual），reject 标记 dismissed。
CREATE TABLE IF NOT EXISTS relation_pending (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  platform       TEXT NOT NULL DEFAULT '',
  subject_id     TEXT NOT NULL,
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'relation',
  confidence     REAL NOT NULL,
  source_msg_ids TEXT NOT NULL DEFAULT '[]',
  window_hash    TEXT NOT NULL DEFAULT '',
  windows_seen   INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relation_pending ON relation_pending(status, created_at);

-- subject 身份层（V2 统一改造）：别名 → subjectId 的解析索引。
--   scope='global'         全局昵称（sender.names.nickname）
--   scope='session:<sid>'  会话内群名片（sender.names.card）
-- 解析顺序 = 当前会话群名片优先 → 全局昵称；同别名指向多个 subject 时按
-- confidence 取最高（重名冲突的后来者登记为低置信度，见 subject-service）。
CREATE TABLE IF NOT EXISTS subject_alias (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  alias       TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'global',
  confidence  REAL NOT NULL DEFAULT 1,
  source      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subject_alias_unique
  ON subject_alias(platform, alias, scope, subject_id);
CREATE INDEX IF NOT EXISTS idx_subject_alias_lookup
  ON subject_alias(platform, alias, scope);

-- 多媒体记忆层（media memory tier，v4）：多媒体内容的详情表，占位符 id 主键。
-- gateway 在观察消息时为媒体项生成确定性占位符 id（ma_<sha1 前 12 位>）并嵌入
-- 消息文本；session-save 落 raw 时检测占位符 + 随行 media 元数据 → 按 id 在此
-- 自动新建详情记录（status=pending）；LLM 解析（网关/DSH 回写或 media-analyzer
-- 兜底队列）完成后回写 desc/tags 并置 ready。kind 统一大范围概念（image 涵盖
-- 表情包，无独立 sticker），ref 存平台发送凭据（QQ 收藏 resId / 语音库相对路径 /
-- 源 URL），send_hints 存各平台发送方式提示（跨平台发送适配层读取）。
CREATE TABLE IF NOT EXISTS media_asset (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  platform     TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'image',
  source_path  TEXT NOT NULL DEFAULT '',
  hash         TEXT NOT NULL DEFAULT '',
  origin       TEXT NOT NULL DEFAULT 'inbound',
  ref          TEXT NOT NULL DEFAULT '',
  send_hints   TEXT NOT NULL DEFAULT '{}',
  desc         TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '[]',
  text_content TEXT NOT NULL DEFAULT '',
  duration_ms  INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending',
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  favorited    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_fav     ON media_asset(favorited, updated_at);
CREATE INDEX IF NOT EXISTS idx_media_status  ON media_asset(status, created_at);
CREATE INDEX IF NOT EXISTS idx_media_session ON media_asset(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_hash    ON media_asset(hash) WHERE hash != '';
CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(desc, tags, id UNINDEXED, tokenize = 'trigram');
`;

// platform 一律由 session_id 派生，CHECK 只做兜底：两处不一致说明上层绕过了 normalizeSessionId。
const PLATFORM_CHECK = `CHECK (platform = substr(session_id, 1, instr(session_id, ':') - 1))`;

export const MIGRATIONS = [
  {
    version: 1,
    statements: [
      // --- memory：从「两层 tier + 一个 category」扩到「层 × 类型 × 可回指的锚点」---
      `ALTER TABLE memory ADD COLUMN kind TEXT NOT NULL DEFAULT 'episodic'`,
      `ALTER TABLE memory ADD COLUMN subject_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE memory ADD COLUMN source_msg_ids TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE memory ADD COLUMN decay_exempt INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_memory_platform ON memory(platform, kind, created_at)`,

      // --- L0 原始层：唯一不可重建的一层，只追加、不更新正文 ---
      `CREATE TABLE IF NOT EXISTS raw_message (
         id          TEXT PRIMARY KEY,
         session_id  TEXT NOT NULL,
         platform    TEXT NOT NULL,
         msg_id      TEXT NOT NULL,
         sender_id   TEXT NOT NULL DEFAULT '',
         kind        TEXT NOT NULL DEFAULT 'text',
         text        TEXT NOT NULL DEFAULT '',
         meta        TEXT NOT NULL DEFAULT '{}',
         anchor      TEXT NOT NULL DEFAULT '',
         created_at  INTEGER NOT NULL,
         archived_at INTEGER,
         ${PLATFORM_CHECK}
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_msg ON raw_message(session_id, msg_id)`,
      `CREATE INDEX IF NOT EXISTS idx_raw_platform_time ON raw_message(platform, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_raw_sender ON raw_message(session_id, sender_id)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(text, id UNINDEXED, tokenize = 'trigram')`,

      // --- L2 语义关系：单值（唯一键回答「现在是什么」）+ 版本链（回答「变成过什么」）---
      `CREATE TABLE IF NOT EXISTS relation (
         id           TEXT PRIMARY KEY,
         session_id   TEXT NOT NULL,
         platform     TEXT NOT NULL,
         subject_id   TEXT NOT NULL,
         key          TEXT NOT NULL,
         value        TEXT NOT NULL,
         kind         TEXT NOT NULL DEFAULT 'relation',
         scope        TEXT NOT NULL DEFAULT 'session',
         importance   INTEGER NOT NULL DEFAULT 0,
         decay_exempt INTEGER NOT NULL DEFAULT 1,
         created_at   INTEGER NOT NULL,
         updated_at   INTEGER NOT NULL,
         ${PLATFORM_CHECK}
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_relation_key
         ON relation(session_id, subject_id, key, scope)`,
      `CREATE INDEX IF NOT EXISTS idx_relation_platform_subject
         ON relation(platform, subject_id)`,
      `CREATE TABLE IF NOT EXISTS relation_history (
         id             TEXT PRIMARY KEY,
         relation_id    TEXT NOT NULL,
         platform       TEXT NOT NULL,
         value          TEXT NOT NULL,
         kind           TEXT NOT NULL DEFAULT 'relation',
         changed_at     INTEGER NOT NULL,
         source_msg_ids TEXT NOT NULL DEFAULT '[]'
       )`,
      `CREATE INDEX IF NOT EXISTS idx_relation_history_rel
         ON relation_history(relation_id, changed_at)`,

      // --- head 冻结快照：稳定区「发过一次就不再重发」的依据 ---
      `CREATE TABLE IF NOT EXISTS head_snapshot (
         session_id       TEXT PRIMARY KEY,
         platform         TEXT NOT NULL,
         revision         TEXT NOT NULL,
         head_text        TEXT NOT NULL,
         built_at         INTEGER NOT NULL,
         last_activity_at INTEGER NOT NULL
       )`,
    ],
  },
  {
    version: 2,
    statements: [
      // --- 写入成本：prune 的过期扫描此前是全表扫描（每条消息一次），部分索引
      //     只覆盖「有 TTL 的行」，长期行不进索引、不增写入成本。 ---
      `CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory(expires_at) WHERE expires_at IS NOT NULL`,

      // --- relation：可信度守卫三列（自动抽取写入的降权/审计依据）---
      //     confidence：抽取可信度 0..1（人工写入默认 1）；渲染 <0.4 不注入、
      //     0.4–0.6 标待确认。last_confirmed_at：证据最后一次确认时间（体检
      //     判「超期未确认」）。actor：写入来源（manual / summary:<hash> / rule:<name>）。
      `ALTER TABLE relation ADD COLUMN confidence REAL NOT NULL DEFAULT 1`,
      `ALTER TABLE relation ADD COLUMN last_confirmed_at INTEGER`,
      `ALTER TABLE relation ADD COLUMN actor TEXT NOT NULL DEFAULT 'manual'`,
      `ALTER TABLE relation_history ADD COLUMN actor TEXT NOT NULL DEFAULT 'manual'`,
      `CREATE INDEX IF NOT EXISTS idx_relation_session_subject ON relation(session_id, subject_id)`,

      // 新库由 SCHEMA 直接建表；本段只对 v1 时代的旧库补齐（IF NOT EXISTS 幂等）。
      `CREATE TABLE IF NOT EXISTS session_state (
         session_id         TEXT PRIMARY KEY,
         platform           TEXT NOT NULL DEFAULT '',
         epoch              INTEGER NOT NULL DEFAULT 1,
         last_activity_at   INTEGER NOT NULL,
         last_summarized_at INTEGER,
         created_at         INTEGER NOT NULL,
         updated_at         INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS profile (
         session_id     TEXT NOT NULL,
         platform       TEXT NOT NULL DEFAULT '',
         subject_id     TEXT NOT NULL,
         attributes     TEXT NOT NULL DEFAULT '{}',
         confidence     REAL NOT NULL DEFAULT 0.5,
         source_msg_ids TEXT NOT NULL DEFAULT '[]',
         version        INTEGER NOT NULL DEFAULT 1,
         created_at     INTEGER NOT NULL,
         updated_at     INTEGER NOT NULL,
         PRIMARY KEY (session_id, subject_id)
       )`,
      `CREATE TABLE IF NOT EXISTS profile_history (
         id             TEXT PRIMARY KEY,
         session_id     TEXT NOT NULL,
         subject_id     TEXT NOT NULL,
         version        INTEGER NOT NULL,
         attributes     TEXT NOT NULL,
         confidence     REAL NOT NULL,
         source_msg_ids TEXT NOT NULL DEFAULT '[]',
         changed_at     INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_profile_history ON profile_history(session_id, subject_id, version)`,
      `CREATE TABLE IF NOT EXISTS relation_pending (
         id             TEXT PRIMARY KEY,
         session_id     TEXT NOT NULL,
         platform       TEXT NOT NULL DEFAULT '',
         subject_id     TEXT NOT NULL,
         key            TEXT NOT NULL,
         value          TEXT NOT NULL,
         kind           TEXT NOT NULL DEFAULT 'relation',
         confidence     REAL NOT NULL,
         source_msg_ids TEXT NOT NULL DEFAULT '[]',
         window_hash    TEXT NOT NULL DEFAULT '',
         windows_seen   INTEGER NOT NULL DEFAULT 1,
         status         TEXT NOT NULL DEFAULT 'pending',
         created_at     INTEGER NOT NULL,
         updated_at     INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_relation_pending ON relation_pending(status, created_at)`,
    ],
  },
  {
    version: 3,
    statements: [
      // --- subject 身份层（tool.call 统一改造）：别名 → subjectId 解析索引 ---
      `CREATE TABLE IF NOT EXISTS subject_alias (
         id          TEXT PRIMARY KEY,
         platform    TEXT NOT NULL,
         subject_id  TEXT NOT NULL,
         alias       TEXT NOT NULL,
         scope       TEXT NOT NULL DEFAULT 'global',
         confidence  REAL NOT NULL DEFAULT 1,
         source      TEXT NOT NULL DEFAULT '',
         created_at  INTEGER NOT NULL,
         updated_at  INTEGER NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_subject_alias_unique
         ON subject_alias(platform, alias, scope, subject_id)`,
      `CREATE INDEX IF NOT EXISTS idx_subject_alias_lookup
         ON subject_alias(platform, alias, scope)`,

      // --- profile 双层 scope：identity（全局打底，session_id=''）+ session
      //     （会话覆盖）。存量行默认 'session' —— 计划口径「存量 (session_id,
      //     subject_id) 迁移为 session scope」由默认值直接满足，无需数据搬运。 ---
      `ALTER TABLE profile ADD COLUMN scope TEXT NOT NULL DEFAULT 'session'`,
    ],
  },
  {
    version: 4,
    statements: [
      // --- 多媒体记忆层：media_asset 详情表（占位符 id 主键）+ fts 索引 ---
      //     新库由 SCHEMA 直接建表；本段对 v3 旧库补齐（IF NOT EXISTS 幂等）。
      `CREATE TABLE IF NOT EXISTS media_asset (
         id           TEXT PRIMARY KEY,
         session_id   TEXT NOT NULL,
         platform     TEXT NOT NULL,
         kind         TEXT NOT NULL DEFAULT 'image',
         source_path  TEXT NOT NULL DEFAULT '',
         hash         TEXT NOT NULL DEFAULT '',
         origin       TEXT NOT NULL DEFAULT 'inbound',
         ref          TEXT NOT NULL DEFAULT '',
         send_hints   TEXT NOT NULL DEFAULT '{}',
         desc         TEXT NOT NULL DEFAULT '',
         tags         TEXT NOT NULL DEFAULT '[]',
         text_content TEXT NOT NULL DEFAULT '',
         duration_ms  INTEGER,
         status       TEXT NOT NULL DEFAULT 'pending',
         use_count    INTEGER NOT NULL DEFAULT 0,
         last_used_at INTEGER,
         created_at   INTEGER NOT NULL,
         updated_at   INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_media_status  ON media_asset(status, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_media_session ON media_asset(session_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_media_hash    ON media_asset(hash) WHERE hash != ''`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(desc, tags, id UNINDEXED, tokenize = 'trigram')`,
    ],
  },
  {
    version: 5,
    statements: [
      // --- 媒体收藏（媒体管道 v2，2026-11-24）：favorited 标识符——收藏的资产
      //     豁免缺省清退（永久保留），【多媒体】注入优先展示。QQ 收藏（collect）
      //     已退役，收藏判断归 DSH，经 chat_media_favorite 标记（前置存在检查）。
      `ALTER TABLE media_asset ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_media_fav ON media_asset(favorited, updated_at)`,
    ],
  },
];

function parseIdList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  const text = String(value ?? '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function memoryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    platform: row.platform,
    tier: row.tier,
    kind: row.kind ?? 'episodic',
    subjectId: row.subject_id ?? '',
    sourceMsgIds: parseIdList(row.source_msg_ids),
    decayExempt: Number(row.decay_exempt ?? 0) !== 0,
    category: row.category,
    content: row.content,
    extra: row.extra,
    importance: row.importance,
    baseWeight: row.base_weight,
    hits: row.hits,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTouchAt: row.last_touch_at,
    expiresAt: row.expires_at ?? null,
  };
}

export function rawFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    platform: row.platform,
    msgId: row.msg_id,
    senderId: row.sender_id,
    kind: row.kind,
    text: row.text,
    meta: row.meta,
    anchor: row.anchor,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? null,
  };
}

export function relationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    platform: row.platform,
    subjectId: row.subject_id,
    key: row.key,
    value: row.value,
    kind: row.kind,
    scope: row.scope,
    importance: row.importance,
    decayExempt: Number(row.decay_exempt ?? 0) !== 0,
    // 可信度守卫三列（v2 迁移）：旧库/旧行缺列时按人工写入的满置信处理。
    confidence: row.confidence === undefined || row.confidence === null ? 1 : Number(row.confidence),
    lastConfirmedAt: row.last_confirmed_at ?? null,
    actor: row.actor ?? 'manual',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function relationHistoryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    relationId: row.relation_id,
    platform: row.platform,
    value: row.value,
    kind: row.kind,
    changedAt: row.changed_at,
    sourceMsgIds: parseIdList(row.source_msg_ids),
    actor: row.actor ?? 'manual',
  };
}

export function profileFromRow(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    platform: row.platform,
    subjectId: row.subject_id,
    // v3 迁移前/旧行缺列时按会话层处理（存量口径）。
    scope: row.scope ?? 'session',
    attributes: parseAttributes(row.attributes),
    confidence: Number(row.confidence ?? 0.5),
    sourceMsgIds: parseIdList(row.source_msg_ids),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function subjectAliasFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    subjectId: row.subject_id,
    alias: row.alias,
    scope: row.scope,
    confidence: Number(row.confidence ?? 1),
    source: row.source ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function profileHistoryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    subjectId: row.subject_id,
    version: row.version,
    attributes: parseAttributes(row.attributes),
    confidence: Number(row.confidence ?? 0.5),
    sourceMsgIds: parseIdList(row.source_msg_ids),
    changedAt: row.changed_at,
  };
}

export function sessionStateFromRow(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    platform: row.platform,
    epoch: row.epoch,
    lastActivityAt: row.last_activity_at,
    lastSummarizedAt: row.last_summarized_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseAttributes(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function snapshotFromRow(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    platform: row.platform,
    revision: row.revision,
    headText: row.head_text,
    builtAt: row.built_at,
    lastActivityAt: row.last_activity_at,
  };
}

export function slangFromRow(row) {
  if (!row) return null;
  let evidence = [];
  try {
    const parsed = JSON.parse(row.evidence || '[]');
    if (Array.isArray(parsed)) evidence = parsed.map((item) => String(item));
  } catch {
    evidence = [];
  }
  return {
    id: row.id,
    content: row.content,
    meaning: row.meaning,
    status: row.status,
    evidence,
    score: row.score,
    hits: row.hits,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function mediaFromRow(row) {
  if (!row) return null;
  let sendHints = {};
  try {
    const parsed = JSON.parse(row.send_hints || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sendHints = parsed;
  } catch {
    sendHints = {};
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    platform: row.platform,
    kind: row.kind,
    sourcePath: row.source_path ?? '',
    hash: row.hash ?? '',
    origin: row.origin,
    ref: row.ref ?? '',
    sendHints,
    desc: row.desc ?? '',
    tags: parseTags(row.tags),
    textContent: row.text_content ?? '',
    durationMs: row.duration_ms ?? null,
    status: row.status,
    useCount: row.use_count ?? 0,
    lastUsedAt: row.last_used_at ?? null,
    favorited: row.favorited === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
