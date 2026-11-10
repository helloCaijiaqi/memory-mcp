// L0 原始层的运维：冷归档 + 元数据清理 + 硬删级联。
//
// 三条不能含糊的语义：
//   1. 先落文件，再改库。顺序反了就会出现「库里说已归档、盘上没有」——那才是真的丢消息。
//   2. 归档只清正文，保留 msg_id / sender_id / kind / anchor：锚点还在，摘要与派生记忆就还能回溯。
//   3. 硬删必须级联：删原文不删派生行，等于「忘了但还记着」。派生行引用清空则整行归档。
//
// 流式：写用 gzip 逐批 append（多 member 的 gzip 是合法格式，gunzip 会依次解开），
// 重写用 line-by-line 过滤，内存只与单行相关，不随归档总量增长。
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createGzip, createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RAW_CONFIG = {
  rawRetentionDays: 30,
  archiveBatch: 200, // 单次读写批大小：控制内存与单次事务时长
  archiveDirName: 'raw-archive',
  maxBatches: 1000, // 兜底：单次维护最多处理 maxBatches × archiveBatch 条
};

/** 文件名安全化：sessionId 里有冒号（qq:group:10086），不能直接当文件名。 */
function safeName(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || 'unknown';
}

/** UTC 日分片：确定性优先，归档文件名不需要跟着本地时区漂。 */
export function archiveDay(createdAt) {
  return new Date(Number(createdAt) || 0).toISOString().slice(0, 10).replaceAll('-', '');
}

export function archivePathFor(root, { platform, sessionId, createdAt }) {
  return path.join(root, safeName(platform), `${safeName(sessionId)}-${archiveDay(createdAt)}.jsonl.gz`);
}

function serializeRaw(row) {
  return JSON.stringify({
    id: row.id,
    sessionId: row.sessionId,
    platform: row.platform,
    msgId: row.msgId,
    senderId: row.senderId,
    kind: row.kind,
    text: row.text,
    meta: row.meta,
    anchor: row.anchor,
    createdAt: row.createdAt,
  });
}

async function writeGzipMember(file, lines) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const payload = `${lines.join('\n')}\n`;
  await new Promise((resolve, reject) => {
    const out = createWriteStream(file, { flags: 'a', mode: 0o600 });
    const gz = createGzip({ level: 9 });
    gz.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    gz.pipe(out);
    gz.end(payload);
  });
}

async function readGzipText(file) {
  const gunzip = createGunzip();
  const chunks = [];
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on('error', reject)
      .pipe(gunzip)
      .on('data', (chunk) => chunks.push(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 过滤一个归档分片：保留 predicate 为真的行。
 * 返回 { kept, removed }；kept=0 时文件被删掉，否则原子替换（tmp + rename）。
 */
async function filterArchiveFile(file, predicate) {
  const tmp = `${file}.${process.pid}.tmp`;
  let kept = 0;
  let removed = 0;
  await new Promise((resolve, reject) => {
    const source = createReadStream(file);
    const gunzip = createGunzip();
    const gz = createGzip({ level: 9 });
    const out = createWriteStream(tmp, { flags: 'w', mode: 0o600 });
    const rl = readline.createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });
    const fail = (error) => {
      rl.close();
      reject(error);
    };
    source.on('error', fail);
    gunzip.on('error', fail);
    gz.on('error', fail);
    out.on('error', fail);
    out.on('finish', resolve);
    rl.on('line', (line) => {
      if (!line.trim()) return;
      if (predicate(line)) {
        gz.write(`${line}\n`);
        kept += 1;
      } else {
        removed += 1;
      }
    });
    rl.on('close', () => gz.end());
    gz.pipe(out);
  });

  // 一行都没命中：别白白重写一次文件（硬删时大部分分片都是这种）。
  if (removed === 0) {
    await fsp.rm(tmp, { force: true });
    return { kept, removed, deleted: false, unchanged: true };
  }
  if (kept === 0) {
    await fsp.rm(tmp, { force: true });
    await fsp.rm(file, { force: true });
    return { kept, removed, deleted: true };
  }
  await fsp.rename(tmp, file);
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    /* Windows 上可能不支持 */
  }
  return { kept, removed, deleted: false };
}

async function listArchiveFiles(root, platform) {
  const dir = path.join(root, safeName(platform));
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    // 目录不存在 = 该平台没有归档（正常）。其它错误（EACCES/ENOTDIR/IO）必须
    // 抛出：吞掉的话 purge 会认为「没有归档要改」，照样删库，盘上原文却还在。
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => name.endsWith('.jsonl.gz')).map((name) => path.join(dir, name));
}

export function createRawService({ store, stateDir, config = {}, now, logger = console } = {}) {
  if (!store?.raw) throw new Error('createRawService 需要带 raw 集合的 store');
  const cfg = { ...DEFAULT_RAW_CONFIG, ...config };
  const root = path.join(stateDir ?? process.cwd(), cfg.archiveDirName);
  const clock = typeof now === 'function' ? now : () => Date.now();
  const at = () => {
    const t = Number(clock());
    return Number.isFinite(t) ? t : Date.now();
  };

  /**
   * 冷归档。返回 { cutoff, archived, files: [{ path, rows }], dryRun, backlog? }。
   *
   * 循环的停止条件不是游标而是「这一批归档后查不到了」：不引入游标就避免了
   * 「同一毫秒的多条消息在分页边界被跳过」这类只在生产才出现的漏归档。
   */
  async function archive({ days = cfg.rawRetentionDays, platform, sessionId, dryRun = false, batch = cfg.archiveBatch } = {}) {
    const ts = at();
    const cutoff = ts - Math.max(0, Number(days) || 0) * DAY_MS;
    const scope = { until: cutoff, platform, sessionId };

    if (dryRun) {
      const backlog = store.raw.count({ ...scope, includeArchived: false });
      const { rows } = store.raw.query({ ...scope, limit: batch, includeArchived: false });
      const files = new Map();
      for (const row of rows) {
        const file = archivePathFor(root, row);
        files.set(file, (files.get(file) ?? 0) + 1);
      }
      return {
        dryRun: true,
        cutoff,
        backlog,
        sampled: rows.length,
        files: [...files].map(([file, count]) => ({ path: file, rows: count })),
        note: 'dry-run 只采样一批，backlog 是准确值，files 是采样结果',
      };
    }

    const files = new Map();
    let archived = 0;
    let batches = 0;
    for (; batches < cfg.maxBatches; batches += 1) {
      const { rows } = store.raw.query({ ...scope, limit: batch, includeArchived: false });
      if (!rows.length) break;

      const groups = new Map();
      for (const row of rows) {
        const file = archivePathFor(root, row);
        if (!groups.has(file)) groups.set(file, []);
        groups.get(file).push(row);
      }
      // 先落盘（失败会抛，库里一行都不会被标记），再改库。
      for (const [file, group] of groups) {
        await writeGzipMember(file, group.map(serializeRaw));
        files.set(file, (files.get(file) ?? 0) + group.length);
      }
      archived += store.raw.archive({ ids: rows.map((row) => row.id), at: ts }).archived;
      if (rows.length < batch) break;
    }

    if (archived) {
      logger?.log?.(`[raw] 已归档 ${archived} 条到 ${files.size} 个分片（cutoff=${new Date(cutoff).toISOString()}）`);
    }
    return {
      dryRun: false,
      cutoff,
      archived,
      batches,
      truncated: batches >= cfg.maxBatches,
      files: [...files].map(([file, rows]) => ({ path: file, rows })),
    };
  }

  /**
   * 收集要删的行（**只读**分页扫描，不删库）。
   *
   * 旧实现边扫边 `purge`，随后才重写归档：归档写失败时库里的行已经没了，盘上
   * 还留着（被遗忘权的要求正好相反——数据必须真的消失）。现在先收齐、再重写
   * 归档、最后才删库，任一步失败都可以整体重试。
   *
   * 游标用 `(createdAt, id)` 复合键：只按 createdAt 分页时，同一毫秒内超过一页
   * 的行会被反复取到（seen 过滤后无新行 → 提前 truncated）。
   */
  function collectVictims(filters) {
    const victims = [];
    const seen = new Set();
    let cursor = null;
    for (let guard = 0; guard < cfg.maxBatches; guard += 1) {
      const opts = { ...filters, includeArchived: true, limit: 500 };
      if (cursor) opts.since = cursor.createdAt;
      const { rows } = store.raw.query(opts);
      const fresh = rows.filter((row) => {
        if (seen.has(row.id)) return false;
        if (!cursor) return true;
        // 严格大于游标：同毫秒内按 id 继续前进。
        return row.createdAt > cursor.createdAt
          || (row.createdAt === cursor.createdAt && String(row.id) > String(cursor.id));
      });
      for (const row of fresh) {
        seen.add(row.id);
        victims.push(row);
      }
      if (rows.length < 500) return { victims, truncated: false };
      if (!fresh.length) return { victims, truncated: true };
      cursor = fresh.at(-1);
    }
    return { victims, truncated: true };
  }

  /**
   * 重写受影响的归档分片：被删的行不能再留在盘上。
   *
   * 命中判定以 anchor 为准（行级唯一）；退回 msgId 时必须带上 sessionId——
   * 两个会话各自有一条 `msgId=100` 是常态，只按 msgId 删会把别人的归档一起抹掉。
   */
  async function rewriteArchivesFor({ anchors, msgKeys, platforms }) {
    let rewritten = 0;
    let deletedFiles = 0;
    let removedLines = 0;
    for (const platform of platforms) {
      for (const file of await listArchiveFiles(root, platform)) {
        let hit = false;
        const outcome = await filterArchiveFile(file, (line) => {
          let row;
          try {
            row = JSON.parse(line);
          } catch {
            return true; // 读不懂的行保留：宁可留着也别悄悄丢数据
          }
          const victim = (row?.anchor && anchors.has(row.anchor))
            || (row?.msgId && msgKeys.has(`${row.sessionId}\u0000${row.msgId}`));
          if (victim) hit = true;
          return !victim;
        });
        if (!hit) continue;
        removedLines += outcome.removed;
        if (outcome.deleted) deletedFiles += 1;
        else rewritten += 1;
      }
    }
    return { rewritten, deletedFiles, removedLines };
  }

  /**
   * 派生行级联：把被删消息从 memory.sourceMsgIds 里摘掉。
   * 引用清空 → 整行归档（内容已经无法回溯到原文，不该继续当「有据可查的记忆」）。
   */
  function cascadeDerived({ msgIds, sessionIds }) {
    const victims = new Set(msgIds);
    if (!victims.size) return { cleaned: 0, archived: 0, sessions: new Set() };
    const touchedSessions = new Set();
    let cleaned = 0;
    let archived = 0;

    const scan = (sessionId) => {
      const seen = new Set();
      // 复合游标 (createdAt, id)：只按 createdAt 会漏掉同一毫秒内跨页的行
      // （`until` 是闭区间，翻页时那一组会被重复取到，seen 一过滤就没「新行」）。
      let cursor = null;
      for (let guard = 0; guard < cfg.maxBatches; guard += 1) {
        // 不要传 now=MAX：那会把「未过期」反过来判成「已过期」，短期记忆全被漏掉。
        const opts = { limit: 200, order: 'recent', includeArchived: true };
        if (sessionId) opts.sessionId = sessionId;
        if (cursor) opts.until = cursor.createdAt;
        const { rows } = store.memory.query(opts);
        const fresh = rows.filter((row) => {
          if (seen.has(row.id)) return false;
          if (!cursor) return true;
          return row.createdAt < cursor.createdAt
            || (row.createdAt === cursor.createdAt && String(row.id) < String(cursor.id));
        });
        if (!fresh.length) break;
        for (const row of fresh) {
          seen.add(row.id);
          const refs = row.sourceMsgIds ?? [];
          if (!refs.some((ref) => victims.has(ref))) continue;
          const remaining = refs.filter((ref) => !victims.has(ref));
          if (remaining.length) {
            store.memory.put({ ...row, sourceMsgIds: remaining });
            cleaned += 1;
          } else {
            store.memory.put({ ...row, sourceMsgIds: [], status: 'archived' });
            archived += 1;
          }
          touchedSessions.add(row.sessionId);
        }
        cursor = fresh.at(-1);
        if (rows.length < 200) break;
      }
    };

    if (sessionIds?.size) for (const sessionId of sessionIds) scan(sessionId);
    else scan(null);

    return { cleaned, archived, sessions: touchedSessions };
  }

  /**
   * 硬删（被遗忘权）。顺序不可换：
   *   1) 先查受害者（需要 anchor / msgId 才能清归档与派生行）
   *   2) 先重写归档（盘上先干净；失败则整个操作抛错，库里还没动）
   *   3) 再删库 + 级联派生行 + 失效 head 快照（快照里的关系/事实可能引用了被删消息）
   */
  async function purge({ id, sessionId, msgId, senderId, platform, rewriteArchives = true } = {}) {
    if (!id && !sessionId && !msgId && !senderId && !platform) {
      throw new TypeError('purge 至少需要一个过滤条件，拒绝清空整表');
    }
    const filters = { id, sessionId, msgId, senderId, platform };
    const collected = collectVictims(filters);
    const victims = collected.victims;
    const anchors = new Set(victims.map((row) => row.anchor).filter(Boolean));
    const msgIds = new Set(victims.map((row) => row.msgId).filter(Boolean));
    const msgKeys = new Set(
      victims.filter((row) => row.msgId).map((row) => `${row.sessionId}\u0000${row.msgId}`),
    );
    const platforms = new Set(victims.map((row) => row.platform).filter(Boolean));

    // 顺序：先重写归档（失败即整体抛错，库里一行没动），再删库。
    const archives = rewriteArchives
      ? await rewriteArchivesFor({ anchors, msgKeys, platforms })
      : { rewritten: 0, deletedFiles: 0, removedLines: 0 };

    if (victims.length) store.raw.purge({ ids: victims.map((row) => row.id) });

    const sessionIds = new Set(victims.map((row) => row.sessionId).filter(Boolean));
    const derived = cascadeDerived({ msgIds, sessionIds });

    let headsInvalidated = 0;
    if (typeof store.snapshot?.remove === 'function') {
      for (const sessionId of new Set([...sessionIds, ...derived.sessions])) {
        if (store.snapshot.remove(sessionId)) headsInvalidated += 1;
      }
    }

    return {
      filters,
      removed: victims.length,
      truncated: collected.truncated,
      anchors: anchors.size,
      archives,
      derived: { cleaned: derived.cleaned, archived: derived.archived },
      sessions: [...sessionIds],
      headsInvalidated,
    };
  }

  /** 归档积压（/api/health 与 preflight 用）。 */
  function backlog({ days = cfg.rawRetentionDays } = {}) {
    const cutoff = at() - Math.max(0, Number(days) || 0) * DAY_MS;
    return { cutoff, rows: store.raw.count({ until: cutoff, includeArchived: false }) };
  }

  /** 列出某个平台已归档的分片（运维与硬删后可核对）。 */
  async function listArchives({ platform = 'qq' } = {}) {
    const files = await listArchiveFiles(root, platform);
    const out = [];
    for (const file of files) {
      const stat = await fsp.stat(file).catch(() => null);
      out.push({ path: file, bytes: stat?.size ?? 0 });
    }
    return out;
  }

  /** 读回一个分片（测试与人工核对用；生产路径不需要）。 */
  async function readArchive(file) {
    return readGzipText(file);
  }

  return { config: cfg, root, archive, purge, backlog, listArchives, readArchive };
}
