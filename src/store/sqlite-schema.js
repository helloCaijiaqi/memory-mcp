// SQLite 建表语句与行列映射。SQL 只出现在这里，换后端时业务代码不用改。

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
`;

export function memoryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    platform: row.platform,
    tier: row.tier,
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
