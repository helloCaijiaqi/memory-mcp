// 多媒体解析兜底器（media-analyzer）：pending 扫描后台队列 + 同步快解析。
// 与 slang 的可选 LLM 解释同纪律：LLM 是旁路，失败绝不抛错打断主链路。
//   - 后台队列：定时扫 pending（并发=1 防限流），解析成功回写 desc/tags + ready
//   - analyzeSync：摘要完整性检查用（短超时），网关/DSH 先行回写后这里只补缺口
//   - vision 模型未配置（llm.config.json vision.model 必须显式给出）→ 保持
//     pending 积压，配好后自动补解析；主文本模型不承担视觉（防瞎编污染）
// 一期只解析 image（vision）；voice 元数据描述在登记时写入（ASR 转 P2）。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MEDIA_ANALYZER_CONFIG = {
  enabled: true,
  intervalMs: 60000,      // 兜底扫描周期
  batchLimit: 10,         // 每轮最多处理几条 pending
  perItemTimeoutMs: 25000,
  syncTimeoutMs: 8000,    // 摘要完整性快解析的总超时（短超时，绝不长等）
  maxDescChars: 80,
};

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

const SYSTEM_PROMPT = '你是图片内容描述器。只输出 JSON：{"desc":"不超过60字的中文画面描述（含画面主体与情绪/含义）","tags":["2到5个简短标签"]}，不要输出其他任何内容。';

function extractJson(text) {
  const match = /\{[\s\S]*\}/.exec(String(text ?? ''));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function createMediaAnalyzer({ store, service, llm, config = {}, logger = () => {} } = {}) {
  if (!service) throw new Error('createMediaAnalyzer 需要 mediaService');
  const cfg = { ...DEFAULT_MEDIA_ANALYZER_CONFIG, ...config };
  let timer = null;
  let running = false;
  let lastRunAt = null;

  /** 从资产取图片 base64 + mime；取不到返回 null（保持 pending）。 */
  function loadImage(asset) {
    try {
      if (asset.sourcePath && fs.existsSync(asset.sourcePath)) {
        const ext = path.extname(asset.sourcePath).slice(1).toLowerCase();
        return { base64: fs.readFileSync(asset.sourcePath).toString('base64'), mime: MIME_BY_EXT[ext] ?? 'image/png' };
      }
      const url = asset.ref && /^https?:\/\//.test(asset.ref) ? asset.ref : '';
      if (!url) return null;
      // URL 下载走 service 的落盘通道（顺带固化源文件，一举两得）
      const controller = new AbortController();
      const timer2 = setTimeout(() => controller.abort(), cfg.perItemTimeoutMs);
      return fetch(url, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          return { base64: buf.toString('base64'), mime: String(res.headers.get('content-type') ?? 'image/png').split(';')[0] };
        })
        .finally(() => clearTimeout(timer2));
    } catch {
      return null;
    }
  }

  /** 单条解析：vision → JSON → updateDesc。任何失败都保持 pending，返回 { ok, reason? }。 */
  async function analyzeOne(asset) {
    if (asset.kind !== 'image') return { ok: false, reason: 'kind-not-image' };   // 一期只解析图片
    if (!llm?.visionEnabled) return { ok: false, reason: 'vision-disabled' };
    let img;
    try {
      img = await loadImage(asset);
    } catch {
      img = null;
    }
    if (!img?.base64) return { ok: false, reason: 'no-image-data' };
    const text = await llm.vision({
      system: SYSTEM_PROMPT,
      prompt: '描述这张图片的内容。',
      imageBase64: img.base64,
      mime: img.mime,
      maxTokens: 200,
    });
    if (!text) return { ok: false, reason: 'vision-failed' };
    const parsed = extractJson(text);
    const desc = parsed?.desc ?? String(text).trim();
    const tags = Array.isArray(parsed?.tags) ? parsed.tags : [];
    if (!desc) return { ok: false, reason: 'empty-desc' };
    const row = service.updateDesc(asset.id, { desc, tags, status: 'ready' });
    return { ok: Boolean(row && row.status === 'ready'), reason: row ? undefined : 'update-failed' };
  }

  /** 后台兜底一轮：扫 pending 逐个解析（并发=1）。 */
  async function analyzeBatch() {
    if (running || !cfg.enabled || !llm?.visionEnabled) return { processed: 0, ok: 0 };
    running = true;
    try {
      const pending = service.scanPending({ limit: cfg.batchLimit });
      let ok = 0;
      for (const asset of pending) {
        try {
          const r = await analyzeOne(asset);
          if (r.ok) ok += 1;
          else if (r.reason === 'kind-not-image' || r.reason === 'no-image-data') {
            // 反复取不到内容的记录不无限重试：标记 failed 让 scanPending 不再扫到
            service.updateDesc(asset.id, { status: 'failed' });
          }
        } catch (error) {
          logger(`media-analyzer: ${asset.id} 解析异常（保持 pending）：${error?.message ?? error}`);
        }
      }
      lastRunAt = Date.now();
      if (pending.length) logger(`media-analyzer: 本轮 ${pending.length} 条，成功 ${ok}`);
      return { processed: pending.length, ok };
    } finally {
      running = false;
    }
  }

  /**
   * LLM 记忆筛选器（媒体管道 v3 收藏语义重设计，2026-11-24）：raw 落地后由
   * session-save 异步旁路调用——判定哪些新登记媒体「适合记忆收藏」：
   *   keep   → 立即 analyzeOne（vision 解析写 desc = 收藏生效，永久豁免清退）；
   *   skip   → status='failed'（浅元数据保留，后台队列不再扫，超龄照常清退）。
   * 批内合并为一次文本 LLM 调用（成本控制）；LLM 失败则全部保持 pending
   * （后台队列兜底解析，绝不丢媒体）。fire-and-forget，不阻塞 save。
   */
  async function screenForMemory(ids, context = {}) {
    if (!llm?.enabled || !Array.isArray(ids) || !ids.length) return { kept: [], skipped: [], reason: 'disabled' };
    const assets = ids.map((id) => service.get(id)).filter((a) => a && a.status === 'pending');
    if (!assets.length) return { kept: [], skipped: [], reason: 'no-pending' };
    const lines = assets.map((a) => `- ${a.id}（${a.kind}${a.desc ? `，已有浅描述：${String(a.desc).slice(0, 40)}` : ''}）`);
    const text = await llm.complete({
      messages: [
        { role: 'system', content: '你是记忆筛选器：判断哪些新出现的媒体值得长期记住（涉及人物/事件/重要信息/可能反复引用的内容）。只返回 JSON。' },
        { role: 'user', content: `聊天上下文摘要：\n${String(context.text ?? '').slice(0, 600)}\n\n媒体清单：\n${lines.join('\n')}\n\n返回 {"keep":["ma_xxx"],"skip":["ma_xxx"]}（keep=值得记住，skip=不值得）。` },
      ],
      json: true,
      maxTokens: 300,
      temperature: 0.2,
    });
    if (text == null) return { kept: [], skipped: [], reason: 'llm-failed' };
    const parsed = extractJson(text);
    const idOk = (x) => /^ma_[0-9a-f]{12}$/.test(String(x ?? ''));
    const keep = new Set((Array.isArray(parsed?.keep) ? parsed.keep : []).filter(idOk));
    const skip = new Set((Array.isArray(parsed?.skip) ? parsed.skip : []).filter(idOk));
    const kept = [];
    const skipped = [];
    for (const a of assets) {
      if (keep.has(a.id)) {
        kept.push(a.id);
        // 立即解析（fire-and-forget）：失败保持 pending 由后台队列兜底
        analyzeOne(a).catch(() => {});
      } else if (skip.has(a.id)) {
        skipped.push(a.id);
        // failed = 「不进入长期记忆」：后台队列不再扫；清退不豁免（超龄照常删）
        service.updateDesc(a.id, { status: 'failed', desc: undefined, tags: [] });
      }
    }
    if (kept.length || skipped.length) logger(`media-analyzer: 记忆筛选 keep=${kept.length} skip=${skipped.length}`);
    return { kept, skipped };
  }

  function start() {
    if (timer || !cfg.enabled) return;
    timer = setInterval(() => { analyzeBatch().catch(() => {}); }, cfg.intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    logger(`media-analyzer: 兜底队列已启动（interval=${cfg.intervalMs}ms, vision=${llm?.visionEnabled ? 'on' : 'off'}）`);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /**
   * 同步快解析（摘要完整性检查用）：给定 id 集合，总超时内能解多少算多少。
   * 超时不抛错——返回已完成的部分，剩余交给后台队列兜底。
   */
  async function analyzeSync(ids, { timeoutMs = cfg.syncTimeoutMs } = {}) {
    const list = (ids ?? []).map((id) => service.get(id)).filter(Boolean);
    if (!list.length || !llm?.visionEnabled) return { resolved: 0, total: list.length, timedOut: false };
    let resolved = 0;
    const work = (async () => {
      for (const asset of list) {
        try {
          if ((await analyzeOne(asset)).ok) resolved += 1;
        } catch { /* 保持 pending */ }
      }
    })();
    let timedOut = false;
    await Promise.race([
      work,
      new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, Math.max(1000, timeoutMs))),
    ]);
    return { resolved, total: list.length, timedOut };
  }

  function stats() {
    return {
      enabled: cfg.enabled && Boolean(llm?.visionEnabled),
      running,
      lastRunAt,
      pending: store.media.count({ status: 'pending' }),
      failed: store.media.count({ status: 'failed' }),
    };
  }

  return { config: cfg, analyzeOne, analyzeBatch,
    screenForMemory, analyzeSync, start, stop, stats };
}