// 多媒体解析兜底器（media-analyzer）：pending 扫描后台队列 + 同步快解析。
// 与 slang 的可选 LLM 解释同纪律：LLM 是旁路，失败绝不抛错打断主链路。
//   - 后台队列：定时扫 pending（并发=1 防限流），解析成功回写 desc/tags + ready
//   - analyzeSync：摘要完整性检查用（短超时），网关/DSH 先行回写后这里只补缺口
//   - 专职模型分层（2026-11-25）：按 asset.kind 路由到各自专职模型——
//     image→vision（chat/completions 多模态）、voice→audio 识别（OpenAI 兼容
//     /audio/transcriptions，转写写 desc+textContent）、video→video 理解（多模态
//     video content）。主文本模型不承担任何媒体解析（防瞎编污染）。
//   - 失败语义：专职模型未配置（xxx-disabled）→ 保持 pending 积压，配好后自动
//     补解析；素材取不到 / 模型调用失败 → 标 failed（不无限重试）。
//   - file 类型无解析面 → kind-unsupported 直接 failed（浅元数据照常保留）。
import fs from 'node:fs';
import path from 'node:path';
import { phashFromFile, PHASH_CONFIRM_DISTANCE } from './image-phash.js';

export const DEFAULT_MEDIA_ANALYZER_CONFIG = {
  enabled: true,
  intervalMs: 60000,      // 兜底扫描周期
  batchLimit: 10,         // 每轮最多处理几条 pending
  perItemTimeoutMs: 25000,
  syncTimeoutMs: 8000,    // 摘要完整性快解析的总超时（短超时，绝不长等）
  maxDescChars: 80,
  voiceInboxDir: '',      // 语音源暂存根（state/data/audio/inbox）；空=转写后源文件留原处
};

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

// 各 kind 音视频扩展名 → mime（ASR/视频模型入参用）
const AUDIO_MIME_BY_EXT = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr', ogg: 'audio/ogg', flac: 'audio/flac', silk: 'audio/silk' };
const VIDEO_MIME_BY_EXT = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo' };

const SYSTEM_PROMPT = '你是图片内容描述器。只输出 JSON：{"desc":"不超过60字的中文画面描述（含画面主体与情绪/含义）","tags":["2到5个简短标签"]}，不要输出其他任何内容。';

const VIDEO_SYSTEM_PROMPT = '你是视频内容描述器。只输出 JSON：{"desc":"不超过60字的中文内容描述（含主体与事件）","tags":["2到5个简短标签"]}，不要输出其他任何内容。';

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
      const url = asset.sourcePath && /^https?:\/\//.test(asset.sourcePath) ? asset.sourcePath : '';
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

  /** 从本机路径读文件 base64（存在才读）；不存在返回 null。 */
  function readLocalBase64(filePath, mime) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      const buf = fs.readFileSync(filePath);
      return buf.length > 0 ? { base64: buf.toString('base64'), mime } : null;
    } catch {
      return null;
    }
  }

  /** voice 资产取音频 base64：ref 相对 audio 子配置的 libDir（voice_lib 素材在
   *  本机语音库）；绝对路径 ref 直接拒绝（与 bridge resolveVoicePathForV2 同纪律，
   *  防越界读文件）。 */
  function loadAudio(asset) {
    // 比较大小写不敏感（2026-11-26）：path.resolve 不归一化盘符大小写，bridge 小写
    // c:\ 与配置大写 C:\ 会让 startsWith 误拒（win32 磁盘本就不区分大小写）。
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const inRoot = (child, root) =>
      norm(path.resolve(child)).startsWith(norm(path.resolve(root)) + (process.platform === 'win32' ? '' : path.sep));
    // sourcePath 是唯一源定位符（v8 ref 退役）：绝对路径白名单内直接读；
    // 相对名视为语音库 libDir 内文件（join 后必须仍在 libDir 内，防逃逸）；
    // URL 不支持（音频无远程读取通道，维持原行为）。
    const sourcePath = String(asset.sourcePath ?? '').trim();
    if (!sourcePath || /^https?:\/\//.test(sourcePath)) return null;
    if (path.isAbsolute(sourcePath)) {
      if (!fs.existsSync(sourcePath)) return null;
      const ext0 = path.extname(sourcePath).slice(1).toLowerCase();
      return readLocalBase64(sourcePath, AUDIO_MIME_BY_EXT[ext0] ?? 'audio/wav');
    }
    const libDir = llm?.config?.audio?.libDir;
    if (!libDir) return null;
    const ext = path.extname(sourcePath).slice(1).toLowerCase();
    const file = path.join(libDir, sourcePath);
    // 防 libDir 外逃逸：join 后必须仍在 libDir 内
    if (!inRoot(file, libDir)) return null;
    return readLocalBase64(file, AUDIO_MIME_BY_EXT[ext] ?? 'audio/wav');
  }

  /** video 资产取视频 base64：sourcePath 落盘优先（kind 子目录），否则 http 下载。 */
  async function loadVideo(asset) {
    const ext = path.extname(asset.sourcePath ?? '').slice(1).toLowerCase();
    const mime = VIDEO_MIME_BY_EXT[ext] ?? 'video/mp4';
    try {
      if (asset.sourcePath && fs.existsSync(asset.sourcePath)) {
        return readLocalBase64(asset.sourcePath, mime);
      }
      const url = asset.sourcePath && /^https?:\/\//.test(asset.sourcePath) ? asset.sourcePath : '';
      if (!url) return null;
      const controller = new AbortController();
      const timer2 = setTimeout(() => controller.abort(), cfg.perItemTimeoutMs);
      return await fetch(url, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          return { base64: buf.toString('base64'), mime: String(res.headers.get('content-type') ?? mime).split(';')[0] };
        })
        .finally(() => clearTimeout(timer2));
    } catch {
      return null;
    }
  }

  /**
   * 单条解析：按 kind 路由专职模型 → updateDesc。返回 { ok, reason? }：
   *   reason=vision/audio/video-disabled → 模型未配置，保持 pending（配置后自动补解析）；
   *   reason=no-xxx-data / xxx-failed / kind-unsupported → 调用方标 failed 不重试。
   */
  async function analyzeOne(asset, { visionSource } = {}) {
    const kind = asset.kind;
    if (kind === 'image') {
      if (!llm?.visionEnabled) return { ok: false, reason: 'vision-disabled' };
      // 表情库 pHash 归并（2026-11-26）：先算感知哈希，近邻距离 ≤6 且主资产 ready →
      // 直接继承主资产描述（省识图配额：同款表情第二次出现不再调 vision-svc）。
      // 算不出哈希 / 未命中 → 正常走识图流程（哈希在回写时一并落库，供后续查询）。
      // 指定 visionSource（换源强制重识）时跳过归并——继承旧描述会让换源失效。
      const ph = asset.sourcePath && fs.existsSync(asset.sourcePath) ? phashFromFile(asset.sourcePath) : null;
      if (!visionSource && ph?.hash) {
        const near = service.findNearPhash(ph.hash, PHASH_CONFIRM_DISTANCE);
        if (near && near.asset.status === 'ready' && !near.asset.mergedInto) {
          service.mergeVariant(asset.id, near.asset.id, ph.hash);
          return { ok: true, merged: true, masterId: near.asset.id, distance: near.distance };
        }
      }
      let img;
      try {
        img = await loadImage(asset);
      } catch {
        img = null;
      }
      if (!img?.base64) return { ok: false, reason: 'no-image-data' };
      const out = await llm.vision({
        system: SYSTEM_PROMPT,
        prompt: '描述这张图片的内容。',
        imageBase64: img.base64,
        mime: img.mime,
        maxTokens: 200,
        ...(visionSource ? { source: String(visionSource), refresh: true } : {}),
      });
      // adapter.vision 返回 {text, source}|null（兼容裸字符串=旧 LLM 直通形态）
      const text = typeof out === 'string' ? out : out?.text;
      if (!text) return { ok: false, reason: 'vision-failed' };
      const parsed = extractJson(text);
      const desc = parsed?.desc ?? String(text).trim();
      const tags = Array.isArray(parsed?.tags) ? parsed.tags : [];
      // 识图来源标注：vision-svc 按实际命中源（via-saucenao/via-trace-moe/via-cloudflare/
      // via-huggingface）；LLM 兜底链尾仍标 via-llm-fallback
      const source = typeof out === 'string' ? 'llm-fallback' : String(out?.source || 'llm-fallback');
      tags.push(source === 'llm-fallback' ? 'via-llm-fallback' : `via-${source}`);
      if (!desc) return { ok: false, reason: 'empty-desc' };
      // 表情启发式（2026-11-26）：短边小图 + 字节小，或描述含表情关键词 → is_sticker。
      // 判错代价低（下次识图可修正），阈值放宽松一侧。
      let bytes = 0;
      try { bytes = asset.sourcePath && fs.existsSync(asset.sourcePath) ? fs.statSync(asset.sourcePath).size : 0; } catch { bytes = 0; }
      const shortSide = ph ? Math.min(ph.width, ph.height) : null;
      const stickerLike = (shortSide != null && shortSide <= 240 && bytes > 0 && bytes <= 400 * 1024)
        || /表情|表情包|梗图|贴纸|贴图|sticker|emoji/i.test(desc);
      if (stickerLike) tags.push('表情');
      const row = service.updateDesc(asset.id, { desc, tags, status: 'ready', phash: ph?.hash, isSticker: stickerLike });
      return { ok: Boolean(row && row.status === 'ready'), reason: row ? undefined : 'update-failed' };
    }
    if (kind === 'voice') {
      // 专职 ASR：转写文本即内容本体——desc 截 maxDescChars，全文进 textContent。
      if (!llm?.audioEnabled) return { ok: false, reason: 'audio-disabled' };
      const audio = loadAudio(asset);
      if (!audio?.base64) return { ok: false, reason: 'no-audio-data' };
      const text = await llm.transcribe({
        audioBase64: audio.base64,
        mime: audio.mime,
        filename: path.basename(String(asset.sourcePath ?? 'audio.wav')),
      });
      if (!text) return { ok: false, reason: 'audio-failed' };
      const desc = text.slice(0, cfg.maxDescChars);
      const row = service.updateDesc(asset.id, { desc, textContent: text, tags: ['语音', '转写'], status: 'ready' });
      // 语音资产瘦身（2026-11-25；2026-11-26 三区合一更新）：详情记录只留转写文本；
      // 源文件挪到语音运行时区（media/qq/audio，与合成产物/收媒体同目录共用）暂存
      // ——分段命名 ma_<id>.in.<ext>，3 天归档窗口，超龄走 scanner 清退管道。
      // 源文件已在该目录（bridge 直落共享区）时原地即暂存，跳过 move。
      const voiceInboxDir = cfg.voiceInboxDir;
      const voiceSrc = String(row?.sourcePath ?? asset.sourcePath ?? '');
      const sameDir = voiceInboxDir && voiceSrc
        && path.resolve(path.dirname(voiceSrc)) === path.resolve(voiceInboxDir);
      if (row?.status === 'ready' && voiceInboxDir && !sameDir && typeof service.relocateSource === 'function') {
        try {
          service.relocateSource(asset.id, path.join(voiceInboxDir, `${asset.id}.in.wav`));
        } catch { /* 迁移失败降级：源文件留原处等 retention 清退 */ }
      }
      return { ok: Boolean(row && row.status === 'ready'), reason: row ? undefined : 'update-failed' };
    }
    if (kind === 'video') {
      // 专职视频理解：输出形状与 image 一致（desc+tags JSON）。
      if (!llm?.videoEnabled) return { ok: false, reason: 'video-disabled' };
      let video;
      try {
        video = await loadVideo(asset);
      } catch {
        video = null;
      }
      if (!video?.base64) return { ok: false, reason: 'no-video-data' };
      const text = await llm.seeVideo({
        system: VIDEO_SYSTEM_PROMPT,
        prompt: '描述这段视频的内容。',
        videoBase64: video.base64,
        mime: video.mime,
        maxTokens: 200,
      });
      if (!text) return { ok: false, reason: 'video-failed' };
      const parsed = extractJson(text);
      const desc = parsed?.desc ?? String(text).trim();
      const tags = Array.isArray(parsed?.tags) ? parsed.tags : [];
      if (!desc) return { ok: false, reason: 'empty-desc' };
      const row = service.updateDesc(asset.id, { desc, tags, status: 'ready' });
      return { ok: Boolean(row && row.status === 'ready'), reason: row ? undefined : 'update-failed' };
    }
    return { ok: false, reason: 'kind-unsupported' };
  }

  /** 专职模型任一启用即可开扫（各类 pending 各等各的模型）。 */
  function anyAnalyzerEnabled() {
    return Boolean(llm?.visionEnabled || llm?.audioEnabled || llm?.videoEnabled);
  }

  // 永久性失败 reason 清单：素材取不到 / 模型调了但失败 / 类型无解析面——
  // 标 failed 让 scanPending 不再扫到。*-disabled 缺席于此（保持 pending 等配置）。
  const FAILED_REASONS = new Set([
    'no-image-data', 'vision-failed', 'empty-desc', 'update-failed',
    'no-audio-data', 'audio-failed',
    'no-video-data', 'video-failed',
    'kind-unsupported',
  ]);

  /** 后台兜底一轮：扫 pending 逐个解析（并发=1）。 */
  async function analyzeBatch() {
    if (running || !cfg.enabled || !anyAnalyzerEnabled()) return { processed: 0, ok: 0 };
    running = true;
    try {
      const pending = service.scanPending({ limit: cfg.batchLimit });
      let ok = 0;
      for (const asset of pending) {
        try {
          const r = await analyzeOne(asset);
          if (r.ok) ok += 1;
          else if (FAILED_REASONS.has(r.reason)) {
            logger(`media-analyzer: ${asset.id} 标记 failed（reason=${r.reason}）`);
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
    logger(`media-analyzer: 兜底队列已启动（interval=${cfg.intervalMs}ms, vision=${llm?.visionEnabled ? 'on' : 'off'}, audio=${llm?.audioEnabled ? 'on' : 'off'}, video=${llm?.videoEnabled ? 'on' : 'off'}）`);
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
    if (!list.length || !anyAnalyzerEnabled()) return { resolved: 0, total: list.length, timedOut: false };
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
      enabled: cfg.enabled && anyAnalyzerEnabled(),
      analyzers: { vision: Boolean(llm?.visionEnabled), audio: Boolean(llm?.audioEnabled), video: Boolean(llm?.videoEnabled) },
      running,
      lastRunAt,
      pending: store.media.count({ status: 'pending' }),
      failed: store.media.count({ status: 'failed' }),
    };
  }

  return { config: cfg, analyzeOne, analyzeBatch,
    screenForMemory, analyzeSync, start, stop, stats };
}