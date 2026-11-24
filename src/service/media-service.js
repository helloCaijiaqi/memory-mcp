// 多媒体记忆层服务（media memory tier，与 slang-service 同级同风格）。
// 后端无关：只用 store.media 的 get/put/query/count 原语组合，JSON 兜底后端同一套代码可用。
// 职责：占位符检测 → 幂等登记（id 幂等 + hash 内容去重）→ 描述回写 → 检索/渲染 → 使用统计。
//
// 去重矩阵（历史窗口重放场景，任何一层重复都不产生脏数据）：
//   1. 占位符 id：gateway 生成确定性 id，同媒体项必同 id（重放幂等的前提）
//   2. ensureAssets id 幂等：占位符已存在 → 只补缺失元数据，desc/status 不动
//   3. hash 内容去重：同图转发/重发（不同占位符 id）→ desc/tags/status 直接继承，不重复解析
//   4. 源文件落盘按 sha256 命名：同内容只存一份
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_ID_RE, MEDIA_PLACEHOLDER_RE, MEDIA_KINDS } from '../store/store-api.js';

export const DEFAULT_MEDIA_CONFIG = {
  mediaDir: '',             // 源文件落盘根目录（如 <repo>/state/media）；空 = 不落盘只留 ref
  maxDescChars: 200,
  headLimit: 8,
  downloadTimeoutMs: 15000,
  maxFileBytes: 20 * 1024 * 1024,
};

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
  'video/mp4': 'mp4',
};

const extByUrl = (url) => {
  const m2 = /\.(jpe?g|png|gif|webp|aac|amr|mp3|m4a|wav|mp4)(?:[?#]|$)/i.exec(String(url));
  return m2 ? m2[1].toLowerCase().replace('jpeg', 'jpg') : '';
};

/**
 * 描述入参防御（2026-11-24）：desc 被整包 JSON 污染的修复。
 * 实测污染模式：模型把工具返回的资产行 JSON（含 desc/tags/status/createdAt…）原样
 * 塞进 chat_media_note 的 desc 参数 → 整个 blob 入库，检索/注入时模型拿到的是
 * 不可读的 JSON 串。这里在回写唯一漏斗（updateDesc）做防御性解包：
 *   - 仅当 trim 后以 '{' 开头才尝试 JSON.parse（普通描述永远走原样路径，O(1)）；
 *   - 解析成功且为对象、且含**字符串** desc 字段 → 取内层 desc + 内层 tags；
 *   - 解析失败/非对象/无内层 desc → 原样返回（绝不抛错打断回写主链路）。
 * 返回 { desc, tags }：tags 为解包出的标签数组（无则空数组）。
 */
export function sanitizeDescInput(rawDesc) {
  const text = String(rawDesc ?? '').trim();
  if (!text.startsWith('{')) return { desc: text, tags: [] };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.desc === 'string' && parsed.desc.trim()) {
      const tags = Array.isArray(parsed.tags)
        ? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
        : [];
      return { desc: parsed.desc.trim(), tags };
    }
  } catch { /* 非 JSON：走残片兜底 */ }
  // JSON 残片兜底（实测污染形态：模型复制整行 JSON 时被截断，如
  // `{"desc":"三位动漫角色并排站立`——解析必然失败且**闭合引号也丢了**，
  // 但 desc 键值对前缀仍完整。不要求尾部引号：字符类排除 `"`，
  // 捕获自然停在下一个引号或串尾；转义序列（\\"）由第二个分支消化）。
  const shard = /^{"desc"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text);
  if (shard && shard[1].trim()) return { desc: shard[1].trim(), tags: [] };
  return { desc: text, tags: [] };
}

export function createMediaService({ store, config = {}, repairPlaceholder = null } = {}) {
  if (!store) throw new Error('createMediaService 需要 store');
  const cfg = { ...DEFAULT_MEDIA_CONFIG, ...config };
  // repairPlaceholder（媒体管道 v2）：召回时发现源文件缺失 → 删记录 + 修复摘要/raw
  // 的一致性回调（server.mjs 注入 media-retention 的 repairPlaceholderBatch）。
  const retiredText = config.retiredText ?? '[媒体：内容已清退]';
  const m = store.media;

  // ---------- 占位符 ----------
  /** 文本中的占位符 id（Set 去重——同一占位符在窗口里出现多次只算一个） */
  function extractPlaceholders(text) {
    const out = new Set();
    // v3 正则捕获组 2 = id（组 1 是中文类型词）
    for (const match of String(text ?? '').matchAll(MEDIA_PLACEHOLDER_RE)) out.add(match[2]);
    return [...out];
  }

  const hasPlaceholders = (text) => extractPlaceholders(text).length > 0;

  // ---------- 源文件获取（memory 侧落盘，sha256 命名） ----------
  async function fetchToStore(item) {
    if (!cfg.mediaDir) return null;
    try {
      let buffer = null;
      let ext = '';
      if (item.fileRef && fs.existsSync(item.fileRef)) {
        // 白名单（媒体管道 v2）：fileRef 必须在 mediaDir 内（bridge 落盘共享目录即
        // mediaDir 的 qq/ 子目录）——单份存储直接引用，不复制；白名单外一律拒绝，
        // 防任意路径读。
        const resolved = path.resolve(item.fileRef);
        const root = path.resolve(cfg.mediaDir);
        if (!resolved.startsWith(root)) return null;
        const stat = fs.statSync(resolved);
        if (!stat.isFile() || stat.size > cfg.maxFileBytes) return null;
        const direct = fs.readFileSync(resolved);
        if (!direct.length) return null;
        const directHash = createHash('sha256').update(direct).digest('hex');
        return { hash: directHash, sourcePath: resolved, bytes: stat.size };
      } else if (item.url && /^https?:\/\//.test(item.url)) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.downloadTimeoutMs);
        try {
          const res = await fetch(item.url, { signal: controller.signal });
          if (!res.ok) return null;
          const ct = String(res.headers.get('content-type') ?? '').split(';')[0];
          buffer = Buffer.from(await res.arrayBuffer());
          ext = EXT_BY_MIME[ct] || extByUrl(item.url);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!buffer || !buffer.length || buffer.length > cfg.maxFileBytes) return null;
      const hash = createHash('sha256').update(buffer).digest('hex');
      if (!ext) ext = 'bin';
      const dir = path.join(cfg.mediaDir, String(item.kind ?? 'image'));
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${hash}.${ext}`);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);   // 同内容只存一份
      return { hash, sourcePath: filePath, bytes: buffer.length };
    } catch {
      return null;   // 获取失败保留平台引用（ref），不阻断登记
    }
  }

  function findByHash(hash) {
    if (!hash) return null;
    if (store.backend === 'sqlite') {
      const { rows } = m.query({ hash, limit: 1 });
      return rows[0] ?? null;
    }
    // JSON 兜底：scan + 过滤（兜底后端量小，可接受）
    const { rows } = m.query({ limit: 500 });
    return rows.find((r) => r.hash === hash) ?? null;
  }
  // ---------- 登记（幂等 + 去重） ----------
  /**
   * save payload 的 media 元数据 → 幂等建/补详情记录（session-save 落 raw 时调用）。
   * 语义：
   *   - id 已存在（历史窗口重放）：只补缺失的 ref/hash/duration，desc/status 绝不覆盖
   *   - id 不存在但 hash 命中（转发/重发同图）：desc/tags/status 继承已解析资产，零重复解析
   *   - 全新：落盘拿 hash（QQ 图片 URL 会过期，尽早固化）→ pending 待解析
   */
  async function ensureAssets({ sessionId, media = [] } = {}) {
    const rows = [];
    for (const item of media) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id ?? '');
      if (!MEDIA_ID_RE.test(id)) continue;
      const existing = m.get(id);
      if (existing) {
        const patch = {};
        if (!existing.ref && (item.ref || item.url)) patch.ref = String(item.ref ?? item.url);
        if (!existing.hash && item.hash) patch.hash = String(item.hash);
        if (existing.durationMs == null && item.durationMs != null) patch.durationMs = item.durationMs;
        rows.push(Object.keys(patch).length ? m.put({ ...existing, ...patch }) : existing);
        continue;
      }
      let hash = String(item.hash ?? '');
      let sourcePath = '';
      if (!hash && (item.url || item.fileRef)) {
        const fetched = await fetchToStore(item);
        if (fetched) { hash = fetched.hash; sourcePath = fetched.sourcePath; }
      }
      let desc = '';
      let tags = [];
      let status = 'pending';
      const sendHints = item.sendHints && typeof item.sendHints === 'object' ? { ...item.sendHints } : {};
      if (hash) {
        const twin = findByHash(hash);
        if (twin) {
          desc = twin.desc;
          tags = [...twin.tags];
          if (twin.status === 'ready') status = 'ready';   // 内容已解析过，直接复用
          if (!sourcePath && twin.sourcePath) sourcePath = twin.sourcePath;
          Object.assign(sendHints, twin.sendHints ?? {});
        }
      }
      rows.push(m.put({
        id,
        sessionId,
        kind: MEDIA_KINDS.includes(item.kind) ? item.kind : 'image',
        origin: item.origin ?? 'inbound',
        ref: String(item.ref ?? item.url ?? item.fileRef ?? ''),
        sourcePath,
        hash,
        desc,
        tags,
        status,
        sendHints,
        durationMs: item.durationMs ?? null,
      }));
    }
    return rows;
  }

  // ---------- 描述回写（网关/DSH/media-analyzer 三方共用入口） ----------
  function updateDesc(id, { desc, tags, textContent, status } = {}) {
    const existing = m.get(String(id));
    if (!existing) return null;
    const next = { ...existing };
    if (typeof desc === 'string' && desc.trim()) {
      const clean = sanitizeDescInput(desc);
      next.desc = clean.desc.trim().slice(0, cfg.maxDescChars);
      // 污染解包出的内层 tags 在调用方未提供 tags 时兜底合并（保持模型回写的标签信息）。
      if (!Array.isArray(tags) || !tags.length) {
        if (clean.tags.length) {
          next.tags = [...new Set([...existing.tags, ...clean.tags])].slice(0, 20);
        }
      }
    }
    if (Array.isArray(tags) && tags.length) {
      next.tags = [...new Set([...existing.tags, ...tags.map((t) => String(t).trim()).filter(Boolean)])].slice(0, 20);
    }
    if (typeof textContent === 'string' && textContent.trim()) next.textContent = textContent.trim();
    if (status === 'ready' || status === 'failed') next.status = status;
    else if ((next.desc || next.textContent) && next.status === 'pending') next.status = 'ready';
    return m.put(next);
  }

  // markFavorite 已退役（媒体管道 v3 收藏语义重设计）：进入详情表且被解析
  // （status='ready'）即被记住 = 收藏含义，无需标记动作；favorited 列保留弃用。

  /** 发送学习信号：use_count+1（【多媒体】注入排序依据）。 */
  function markUsed(id, { at = Date.now() } = {}) {
    const existing = m.get(String(id));
    if (!existing) return null;
    return m.put({ ...existing, useCount: (existing.useCount ?? 0) + 1, lastUsedAt: Math.round(at) });
  }

  /**
   * bridge 认知同步 upsert（单向：bridge 是表情/语音认知的源，覆盖式更新 desc/tags）。
   * 与 ensureAssets 的差异：ensureAssets 对已存在记录只补元数据（desc/status 不动），
   * 本方法以推送内容为准（note/remark 变更必须反映到记忆面）。确定性 id 由 bridge 侧
   * 按 resId/文件路径生成（ma_<sha1 前 12 位>），重放幂等。
   */
  function upsertCognition(item = {}) {
    const id = String(item.id ?? '');
    if (!MEDIA_ID_RE.test(id)) return null;
    const existing = m.get(id);
    const base = existing ?? {
      id,
      sessionId: String(item.sessionId ?? ''),
      kind: 'image',
      origin: ['collect', 'voice_lib', 'manual'].includes(item.origin) ? item.origin : 'collect',
    };
    const desc = typeof item.desc === 'string' && item.desc.trim()
      ? item.desc.trim().slice(0, cfg.maxDescChars)
      : (base.desc ?? '');
    return m.put({
      ...base,
      kind: MEDIA_KINDS.includes(item.kind) ? item.kind : (base.kind ?? 'image'),
      ref: String(item.ref ?? base.ref ?? ''),
      sendHints: item.sendHints && typeof item.sendHints === 'object' ? { ...base.sendHints, ...item.sendHints } : (base.sendHints ?? {}),
      desc,
      tags: Array.isArray(item.tags) && item.tags.length ? item.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : (base.tags ?? []),
      status: desc ? 'ready' : (base.status === 'ready' ? 'ready' : 'pending'),
    });
  }
  // ---------- 查询 ----------
  const get = (id) => m.get(String(id));

  // descOnly（v3 收藏语义重设计）：只返回有解析内容（ready）的资产——原 favOnly
  //（favorited 标记）随收藏动作退役；实现上等价于 status='ready' 过滤。
  const search = ({ text, sessionId, kind, limit, descOnly } = {}) =>
    m.query({ text, sessionId, kind, ...(descOnly ? { status: 'ready' } : {}), limit: limit ?? 20 });

  // ---------- 选图策略（媒体管道 v3.1 收藏池，2026-11-25）----------
  /**
   * 收藏池选图（表情包选择器）：调用方传入收藏池（ready+有描述的映射行，不含
   * sourcePath 等内部字段），按「语义匹配度 × 使用热度 × 随机扰动」打分取定量
   * 列表——模型表达同一意图时每次拿到的组合不同（表情包的随机感），但好图
   * （匹配度高+常用）稳定排在前面。
   *   - 相关度：有 query 时 rows 已按 bm25 相关度序 → 序位衰减 1/(1+i/2)；无 query
   *     时人人等权（纯热度+随机 = 「随机来一张收藏的表情」）。
   *   - 热度：1 + ln(1+useCount)——常用表情加分但有天花板（log 增长），不会永久
   *     霸榜挤死新收藏。
   *   - 扰动：0.75~1.25 均匀随机——「定量随机」语义，弱相关的热门图也有机会进
   *     候选（表达多样性），强相关的冷门图不会永远埋没。
   * rand 注入参数供测试确定性；返回行附 score（两位小数）供调试。
   */
  function selectForSend(rows, { query, limit = 5, rand = Math.random } = {}) {
    const scored = (Array.isArray(rows) ? rows : []).map((row, index) => {
      const relevance = query ? 1 / (1 + index / 2) : 1;
      const heat = 1 + Math.log1p(Number(row?.useCount) || 0);
      const jitter = 0.75 + 0.5 * rand();
      return { row, score: relevance * heat * jitter };
    }).sort((a, b) => b.score - a.score);
    return scored
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map((entry) => ({ ...entry.row, score: Math.round(entry.score * 100) / 100 }));
  }

  /** pending 扫描（media-analyzer 兜底队列用），created_at 升序——老记录先补。 */
  const scanPending = ({ limit = 20 } = {}) =>
    m.query({ status: 'pending', limit, order: 'oldest' }).rows;

  function findByRef(ref, { platform } = {}) {
    const key = String(ref ?? '');
    if (!key) return null;
    const { rows } = m.query({ text: key, limit: 50 });
    return rows.find((r) => r.ref === key && (!platform || r.platform === platform)) ?? null;
  }

  // ---------- 摘要完整性（占位符 → 解释文字） ----------
  /**
   * 窗口文本集合里的占位符盘点（Set 去重）：
   *   ready   —— 已就绪可直接参与摘要（desc/textContent 有值）
   *   missing —— 未就绪（调用方决定：快解析 or 最小描述）
   */
  function collectFromTexts(texts) {
    const ids = new Set();
    for (const t of texts ?? []) for (const id of extractPlaceholders(t)) ids.add(id);
    const ready = new Map();
    const missing = [];
    for (const id of ids) {
      const asset = m.get(id);
      if (asset && asset.status === 'ready' && (asset.desc || asset.textContent)) ready.set(id, asset);
      else missing.push(id);
    }
    return { ids: [...ids], ready, missing };
  }

  /** 元数据最小描述（快解析也失败时的兜底，绝不裸占位符进摘要）。 */
  function minimalDesc(asset) {
    const dur = asset?.durationMs ? `（时长 ${(asset.durationMs / 1000).toFixed(1)}s）` : '';
    if (asset?.kind === 'voice') return `语音消息${dur}`;
    if (asset?.kind === 'video') return `视频${dur}`;
    if (asset?.kind === 'file') return '文件附件';
    return '图片（内容暂未识别）';
  }

  const KIND_LABEL = { image: '图片', voice: '语音', video: '视频', file: '文件' };

  /**
   * 占位符重写为解释文字（摘要输入专用；raw 层保持原占位符不动——它是永久锚点）。
   * 降级阶梯：已就绪 desc > resolveExtra(id)（调用方注入的快解析结果）> 元数据最小描述。
   */
  function rewriteForSummary(text, { resolveExtra } = {}) {
    return String(text ?? '').replace(MEDIA_PLACEHOLDER_RE, (full, zh, id) => {
      const asset = m.get(id);
      if (asset && asset.status === 'ready' && (asset.desc || asset.textContent)) {
        const body = (asset.desc || asset.textContent).slice(0, 120);
        return `[${KIND_LABEL[asset.kind] ?? zh}: ${body}]`;
      }
      const extra = resolveExtra?.(id);
      if (extra) return `[${KIND_LABEL[asset?.kind] ?? zh}: ${String(extra).slice(0, 120)}]`;
      if (asset) return `[${minimalDesc(asset)}]`;
      // 详情都没建出来（异常路径）：给通用占位描述，绝不裸占位符进摘要。
      return `[${zh}：多媒体内容（详情缺失）]`;
    });
  }

  // ---------- head 渲染（一行一资产：query 按 id 返回，注入层天然去重） ----------
  /**
   * 召回占位符验证替换（媒体管道 v3，2026-11-24）：所有流出 DSH 的文本统一过这里。
   * 占位符 → 查详情表 + 验证源文件存在：
   *   存在  → 替换为 [图片|<id>|<描述>]（类型保持 + id + 内容描述，DSH 可读）；
   *   缺失  → 删详情记录 + 占位符换 [图片|内容已清退] + repairPlaceholder 修复摘要/raw
   *           （三层数据状态一致）。
   * 返回 { text, repaired }（repaired = 触发修复的 id，供观测）。
   */
  function renderPlaceholders(text, { retiredText: overrideRetired } = {}) {
    const repaired = [];
    const out = String(text ?? '').replace(MEDIA_PLACEHOLDER_RE, (full, zh, id) => {
      const asset = m.get(id);
      if (asset && asset.sourcePath && fs.existsSync(asset.sourcePath)) {
        const body = String(asset.desc || asset.textContent || minimalDesc(asset) || '媒体内容').slice(0, 120);
        return `[${zh}|${id}|${body}]`;
      }
      // 源文件缺失（清退/异常/兜底库）：删详情记录 + 缺省文字（类型保持）+ 一致性修复。
      const retiredZh = overrideRetired ?? `[${zh}|${(retiredText.match(/[\u4e00-\u9fa5]+(?=])$/) ?? ['内容已清退'])[0]}]`;
      try { m.remove(id); } catch {}
      try { repairPlaceholder?.(id, retiredZh); } catch {}
      repaired.push(id);
      return retiredZh;
    });
    return { text: out, repaired };
  }

  function headRows({ limit } = {}) {
    const cap = limit ?? cfg.headLimit;
    // 被记住的优先（媒体管道 v3 收藏语义重设计）：有解析内容（status='ready'）的资产
    // = 收藏含义，优先注入；无 favorited 标记概念。
    const { rows } = m.query({ status: 'ready', limit: cap, order: 'stable' });
    return rows
      .filter((r) => r.desc || r.textContent)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        text: `${r.desc || r.textContent}${r.tags.length ? ` #${r.tags.join(' #')}` : ''}`.slice(0, 200),
      }));
  }

  return {
    config: cfg,
    extractPlaceholders,
    hasPlaceholders,
    ensureAssets,
    upsertCognition,
    updateDesc,
    markUsed,
    get,
    search,
    /** 收藏池选图（v3.1）：语义×热度×随机的定量列表（gateway-v1 chat_media_search 用）。 */
    selectForSend,
    /** 全量列表（清退任务用）：透传 store.media.query 的稳定序。 */
    list: ({ limit } = {}) => m.query({ limit: limit ?? 500, order: 'stable' }),
    /** 删除资产（清退/修复用）：源文件由调用方负责，这里只删记录+FTS。 */
    remove: (id) => m.remove(String(id)),
    scanPending,
    findByHash,
    findByRef,
    collectFromTexts,
    minimalDesc,
    rewriteForSummary,
    renderPlaceholders,
    headRows,
  };
}
