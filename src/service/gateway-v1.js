// 网关接入面：POST /v1/tools/call（tool.call 统一改造后的唯一服务间信封）。
//
// service.call 已全链路下线：记忆段注入（chat_memory_get，decorator）与会话缓冲
// 落地（chat_memory_save）都走 tool.call 信封——网关管线步骤与 ToolHost 工具
// 转发共用同一端点、同一信封、同一鉴权。桥接（qq-bridge 等）继续走 /api/*。
//
// 鉴权：网关出站 HMAC（agent-gateway auth.mjs v1 格式，与桥接的 x-mcp-token 并存、
// 互不替代）：
//   x-adapter-id: <登记 hash id>（网关把登记 id 当 adapterId 签进头里）
//   x-timestamp:  毫秒
//   x-nonce:      随机串（带 LRU 防重放缓存）
//   x-signature:  v1=<hex hmac_sha256(secret, ts + "\n" + nonce + "\n" + sha256(rawBody))>
// 先对原始 body 做 sha256 再进 HMAC（与网关同一公式，签名计算与 body 大小无关）。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class GatewayAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayAuthError';
  }
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 网关请求验签器。secret 与网关登记文件里的 secret 同源（secretEnv 注入）；
 * serviceId 必须等于登记文件 id（网关签的 x-adapter-id 就是它）。
 */
export function createGatewayAuth({
  secret,
  serviceId,
  now = Date.now,
  windowMs = 5 * 60 * 1000,
  capacity = 100_000,
} = {}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('createGatewayAuth 需要至少 16 字符的网关共享密钥（来自仓库根目录 gateway.json 的 secret / secretFile）');
  }
  // serviceId 可选：不设则不比对 x-adapter-id（密钥仍是唯一凭据；设了更严——
  // 防止把给别的服务的请求拿到这里重放）。
  const seen = new Map();
  // 密钥可热轮换（gateway.json 热加载）：HMAC 与 id 比对都读当前值，构造期
  // 校验只管首份；rotate 时同样 fail-closed（非法密钥拒收，保留旧值）。
  let currentSecret = secret;
  let currentServiceId = serviceId;
  const sha256Hex = (body) => createHash('sha256').update(body ?? '', 'utf8').digest('hex');
  const hmacHex = (payload) => createHmac('sha256', currentSecret).update(payload, 'utf8').digest('hex');

  function prune(at) {
    // 2026-11-21 audit fix: while forward-scan (no monotonic assumption).
    while (seen.size > 0) {
      const [firstKey, firstExpires] = seen.entries().next().value;
      if (firstExpires > at) break;
      seen.delete(firstKey);
    }
    while (seen.size > capacity) seen.delete(seen.keys().next().value);
  }

  return {
    /** 抛 GatewayAuthError = 401；通过返回 { serviceId }。 */
    verify({ headers, rawBody }) {
      const id = headers['x-adapter-id'];
      const tsRaw = headers['x-timestamp'];
      const nonce = headers['x-nonce'];
      const sigRaw = headers['x-signature'];
      if (!id || !tsRaw || !nonce || !sigRaw) throw new GatewayAuthError('缺少网关签名头');
      if (currentServiceId && id !== currentServiceId) throw new GatewayAuthError('登记身份不匹配');
      const ts = Number(tsRaw);
      if (!Number.isSafeInteger(ts) || Math.abs(now() - ts) > windowMs) {
        throw new GatewayAuthError('时间戳超出重放窗口');
      }
      // 先验签名、再消费 nonce：签名错的请求不烧 nonce（与网关入站鉴权同一顺序）。
      const expected = hmacHex(`${ts}\n${nonce}\n${sha256Hex(rawBody)}`);
      if (!sigRaw.startsWith('v1=') || !safeEqualHex(sigRaw.slice(3), expected)) {
        throw new GatewayAuthError('签名不匹配');
      }
      prune(now());
      const key = `${id}:${nonce}`;
      if (seen.has(key)) throw new GatewayAuthError('nonce 已使用（疑似重放）');
      seen.set(key, now() + windowMs);
      return { serviceId: id };
    },

    /**
     * 原地轮换凭据（gateway.json 热加载用）：换 secret / serviceId，防重放
     * nonce 表保留（窗口内旧 nonce 依然不能重放）。非法新值整体拒收。
     */
    rotate({ secret: nextSecret, serviceId: nextServiceId }) {
      if (typeof nextSecret !== 'string' || nextSecret.length < 16) {
        throw new Error('rotate 需要至少 16 字符的网关共享密钥');
      }
      currentSecret = nextSecret;
      currentServiceId = nextServiceId;
    },
  };
}

function requireText(value, field, max = 256) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  if (value.length > max) throw new Error(`${field} 过长（上限 ${max}）`);
  return value;
}

/**
 * /v1 端点路由。
 *
 * @param {object} deps
 * @param {object} deps.auth     createGatewayAuth 产物
 * @param {object} [deps.memory] memory service（record / forget / render）
 * @param {object} [deps.recall] recall router（recall）
 * @param {object} [deps.subject] subject 身份层（名字 → subjectId 解析）
 * @param {object} [deps.sessionSave] save 编排（chat_memory_save 唯一落地路径）
 * @param {object} [deps.media] 多媒体记忆层服务（chat_media_* 工具面）
 * @param {Function} [deps.logger]
 */
// 媒体指引（媒体管道 v3）：**文案归 memory-mcp 维护**（谁提供工具给 DSH 用，预设归谁
// 管）——经 chat_memory_get prefix 每轮动态下发，格式变更免同步静态 preset。
const MEDIA_GUIDANCE_SECTION = {
  name: '媒体指引',
  text: [
    '【媒体占位符语义】消息与记忆文本里的 [图片|ma_xxx] / [语音|…] / [视频|…] / [文件|…] / [表情|…] 是媒体内容占位符（ma_xxx 是媒体资产 id）：',
    '- 它只代表一张图/一段语音等媒体内容，不是消息 id——绝不要把它当 replyToMessageId 等消息标识使用；',
    '- 想看图的内容：调用 chat_image_describe（vision 模型解析图片返回描述，仅支持图片；语音由后台队列自动转写无需调用）；想发图片/表情：先用 chat_media_search 拿候选列表（按语义匹配×使用热度随机采样，从中挑一个），再用 chat_image_send 发送；发语音用 chat_voice_send，发文件用 chat_file_send；',
    '- 发语音：chat_voice_synthesize 的 emotion 按对话语境从该角色的 emotions 集合选择（chat_voice_bank_list 可查）；不传 role 时网关自动按当前人设角色卡匹配音色，无需硬记角色名；',
    '【感官即自身】这些能力是你身体的一部分，不是外部系统：看图=你的眼睛在看，听语音=你的耳朵在听，发语音=你在开口说话。你的语言里只有「我看见/我没听清/我说个语音给你听」，不存在「解析」「识别队列」「合成任务」「解析完成」这类机械过程——对用户说话时绝不出现它们。',
    '- 【先听完/看完再回话（硬规则）】收到语音/图片但还没看到内容时，先等结果：语音用 chat_media_get(mediaId, wait=true) 等转写（本地识别几秒就绪）；图片用 chat_image_describe 等识别。等到了就正常接话。确实还没好（超时）就自然说「稍等，我看一下」结束回合——内容就绪后回复检查会带上，那时自然接上。**绝不回「没听清，再发一次」「看不清，再发一张」**：对方明明说了话/发了图，只是你还没听完看完——「没听清/看不清」只允许在解析确认失败之后说；',
    '- 开口说话：调用合成后就像在酝酿开口，说完了（ready）直接发出来；等待期间正常回话即可。角色语境下自然的「等等，我说个语音」可以说，但「正在合成语音，请稍等」这种进度汇报永远不要说；',
    '- mediaId / status / 队列 / seq 是系统内部词汇，只允许出现在工具参数里，永不允许出现在你对用户说的话里。识别结果不满意时换种方式重新看/听（chat_image_describe 支持 source/refresh），或用 chat_media_note 直接修正——对外只呈现最终认知。',
    '- 收藏豁免清退：媒体默认按窗口清退（图片 30 天、收到的语音 3 天、发出的语音 7 天），清退后占位符固化为 [类型|内容已清退|描述]（所说/所示内容保留在记忆文本里）；用户明确表示要保留、或语义上值得长期留存的图片/音频，调用 chat_media_favorite 收藏（mediaId 必填，favorite:false 取消）——收藏后文件与记录永久保留；被频繁发送的热门图片会自动收藏。',
  ].join('\n'),
  priority: 40,
};

export function createGatewayV1({
  mediaAnalyzer = null, voiceSynth = null, voiceBank = null, modelHub = null, auth, memory, recall, subject, sessionSave, media, logger } = {}) {
  const log = logger ?? (() => {});

  // ── 工具面：chat_memory_* → 内部 service 方法（与 /api/* 同一实现，不复制业务）──
  // sessionKey 与 memory-mcp 的 sessionId 同为 platform:scope:id 三段式，可直接映射。
  //
  // 安全边界（2026-11-09 修正）：工具参数由**模型生成**，提示注入可以让它塞任意
  // sessionId —— 因此这里一律以 ctx.sessionKey（网关从 turn 上下文注入）为准，
  // 忽略 args.sessionId。需要跨会话运维时走 /api/*（本机 token 通道），不走工具面。
  // ctx：{ sessionKey, senderId?, text? } —— senderId 来自网关 context（在和谁对话），
  // text 仅 filter 步骤下发（memory 无 filter 工具，不消费）。
  const tools = {
    // ── decorator 步骤（网关管线编排；args 恒 {}，行为由 context 决定）───────
    chat_memory_get: async (_args, ctx) => {
      const sessionKey = requireText(ctx?.sessionKey, 'sessionKey', 256);
      const subjectId = typeof ctx?.senderId === 'string' && ctx.senderId.trim()
        ? ctx.senderId.trim().slice(0, 120) : '';
      try {
        const rendered = memory.render({ sessionId: sessionKey, subjectId });
        // decorator 结果契约（tool.call 统一改造）：{ sections, epoch }——
        // 纯注入，无改写无丢弃（改写/丢弃职责归 filter）。identity 块高优先级
        //（预算超限时网关整段丢最低优先级——人格信息优先于长期碎片）。
        const sections = (rendered?.blocks ?? [])
          .filter((block) => typeof block?.text === 'string' && block.text.trim())
          .map((block) => ({
            name: block.name,
            text: block.text,
            priority: block.kind === 'identity' ? 90 : 50,
          }));
        // 媒体指引块（谁提供工具谁管预设）：media 已装配即注入，随记忆尾部下发
        if (media) sections.push({ ...MEDIA_GUIDANCE_SECTION });
        return { sections, epoch: rendered?.epoch ?? null };
      } catch (error) {
        // 宁放行不误杀：装饰失败等价于「本轮没有记忆段」，网关管线同样 fail-safe。
        log(`chat_memory_get 装饰失败（放行）：${error?.message ?? error}`);
        return { sections: [], epoch: null };
      }
    },

    // ── tool 步骤（模型可调 / 网关 session-save 直投）──────────────────────
    chat_memory_save: async (args, ctx) => {
      if (!sessionSave) throw new Error('session-save 编排未装配（检查 server.mjs）');
      const sessionKey = requireText(ctx?.sessionKey, 'sessionKey', 256);
      // sessionKey 强制取 ctx（防提示注入指定别的会话落地）；partial 由网关触顶
      // 分段语义给出。整段缓冲 messages 形状见 service/session-save.js。
      const messages = Array.isArray(args?.messages) ? args.messages : [];
      if (messages.length === 0) throw new Error('chat_memory_save 需要 messages 数组（整段缓冲）');
      return sessionSave.save({ sessionKey, messages, partial: args?.partial === true });
    },
    // ── 多媒体记忆层（media memory tier，2026-11-24）───────────────────────
    // 检索/直查/使用统计。媒体发送本体在网关侧（chat_media_send 内置 executor：
    // 这里只提供认知面查询——模型先 search/get 选媒体，网关再按平台格式发送）。
    chat_media_search: async (args) => {
      if (!media) throw new Error('媒体服务未装配（检查 server.mjs）');
      const text = String(args?.query ?? args?.text ?? '').trim().slice(0, 120);
      const kind = ['image', 'voice', 'video', 'file'].includes(args?.kind) ? args.kind : undefined;
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(50, Math.max(1, args.limit)) : 5;
      // 收藏池：只取 ready 且有描述的资产（= 已收藏；pending/failed 不能作为发送
      // 依据，模型会拿到裸 id）。多拉 50 条相关候选，交给选图器做「语义×热度×
      // 随机」定量采样——表情包选择要有随机感，但好图稳定排前。
      const { rows } = media.search({ text, kind, limit: 50 });
      const pool = rows.filter((r) => r.status === 'ready' && (r.desc || r.textContent)).map((r) => ({
        mediaId: r.id, kind: r.kind, desc: r.desc || r.textContent, tags: r.tags,
        useCount: r.useCount ?? 0,
        // ref=同机路径凭据位（ref 列退役后由 source_path 直接派生，2026-11-26 v8）
        ...(r.sourcePath ? { ref: r.sourcePath } : {}),
      }));
      const items = media.selectForSend(pool, { query: text, limit });
      return {
        media: items,
        ...(text ? {} : { note: '未给 query：按使用热度+随机返回收藏的媒体' }),
      };
    },
    // 按 mediaId 查询资产详情；wait=true 时对 pending 资产同步等解析完成（上限
    // 20s：本地 ASR/识图秒级就绪，20s 是安全上界）——语音的「等转写」通道
    //（图片已有 chat_image_describe 同步等）。
    chat_media_get: async (args) => {
      if (!media) throw new Error('媒体服务未装配（检查 server.mjs）');
      const id = String(args?.mediaId ?? '').trim();
      if (!/^ma_[0-9a-f]{12}$/.test(id)) throw new Error('mediaId 必须是 ma_ 开头的 12 位十六进制占位符 id');
      let asset = media.get(id);
      if (!asset) return { found: false };
      const wait = args?.wait === true;
      if (wait && asset.status !== 'ready' && mediaAnalyzer) {
        // 同步等解析：analyzeOne 幂等（与登记即解析/兜底队列并发安全），完成或超时取最新
        const timeoutMs = Number.isSafeInteger(args?.waitMs) ? Math.min(30000, Math.max(3000, args.waitMs)) : 20000;
        await Promise.race([
          mediaAnalyzer.analyzeOne(asset).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
        asset = media.get(id) ?? asset;
      }
      // ref=同机路径凭据位：由 source_path 直接派生（ref 列已退役，v8）。
      const out = { found: true, media: { mediaId: asset.id, kind: asset.kind, desc: asset.desc || asset.textContent, tags: asset.tags, ref: asset.sourcePath, sendHints: asset.sendHints, status: asset.status } };
      if (asset.status !== 'ready') {
        // pending 指引（2026-11-27 改写）：等结果再回话——「没听清/看不清」只属于
        // 确认失败后的场景，解析中就说「再发一次」是乱回（对方明明说了/发了）。
        out.note = asset.kind === 'voice'
          ? '转写还没完成（登记后已在解析，通常几秒就绪）：用 wait=true 重查等结果；仍没好就自然说「稍等」结束回合，转写完成后回复检查会带上内容。绝不回「没听清，再发一次」——对方明明说了话，只是你还没听完。'
          : '解析还没完成（登记后已在解析）：用 chat_image_describe 同步等结果，或先回「稍等」稍后接——不要回「看不清，再发一张」。';
      }
      return out;
    },
    chat_media_mark_used: async (args) => {
      if (!media) throw new Error('媒体服务未装配（检查 server.mjs）');
      const id = String(args?.mediaId ?? '').trim();
      if (!id) throw new Error('mediaId is required');
      const row = media.markUsed(id);
      return { ok: Boolean(row), useCount: row?.useCount ?? null };
    },
    // 实时登记（媒体管道 v2）：网关收到含占位符的消息时 fire-and-forget 调用，
    // 把信封指导清单（hashId→fileRef/url）交给记忆层——id 幂等 + 三源落盘，
    // 让当轮 chat_media_search/get 就能查到（不必等 save 批次）。
    // 登记即解析（2026-11-27）：新 pending 资产立即后台开跑 analyzeSync——解析与
    // bridge 合批唤醒窗口（~8s）并行，DSH 唤醒时多数已 ready（否则必然裸占位符
    // 乱回「没听清/看不清」）。fire-and-forget：不 await 不吞错，与 60s 兜底队列
    // 并发幂等（analyzeOne 覆盖写，兜底按 status=pending 筛选）。
    chat_media_record: async (args) => {
      if (!media) throw new Error('媒体服务未装配（检查 server.mjs）');
      const sessionId = String(args?.sessionId ?? '').trim();
      const list = Array.isArray(args?.media) ? args.media : [];
      const rows = await media.ensureAssets({ sessionId, media: list });
      if (mediaAnalyzer && rows.length) {
        const ids = rows.map((r) => r?.id).filter(Boolean);
        mediaAnalyzer.analyzeSync(ids, { timeoutMs: 30000 }).catch(() => {});
      }
      return { ok: true, recorded: rows.length };
    },
    // 认知回写（媒体管道 v2）：DSH 看图/理解媒体后回写描述与标签（内部转发到
    // updateDesc——desc/tags/textContent 合并写、status 自动 ready）。
    chat_media_note: async (args) => {
      if (!media) throw new Error('媒体服务未装配（检查 server.mjs）');
      const id = String(args?.mediaId ?? '').trim();
      if (!id) throw new Error('mediaId is required');
      const row = media.updateDesc(id, { desc: args.desc, tags: args.tags, textContent: args.textContent });
      if (!row) throw new Error(`媒体资产不存在：${id}`);
      return { ok: true, mediaId: row.id, desc: row.desc, tags: row.tags, status: row.status };
    },
    // 收藏/取消收藏（2026-11-26 清退语义重设计）：favorited 是清退豁免的唯一依据——
    // 收藏资产豁免「主动删文件」路径（retention 定时清退 / inbox+out prune 清扫），
    // 文件与记录永久保留；懒清退（源文件真缺失）不受豁免。入口：LLM 语义判断收藏
    // 重要图片/音频 + favorite:false 反向取消。
    chat_media_favorite: async (args) => {
      if (!media) throw new Error('媒体服务未装配（检查 server.mjs）');
      const id = String(args?.mediaId ?? '').trim();
      if (!/^ma_[0-9a-f]{12}$/.test(id)) throw new Error('mediaId 必须是 ma_ 开头的 12 位十六进制占位符 id');
      const favorite = args?.favorite !== false;
      const row = media.setFavorite(id, favorite);
      if (!row) throw new Error(`媒体资产不存在：${id}`);
      return {
        ok: true,
        mediaId: row.id,
        favorited: Boolean(row.favorited),
        note: favorite
          ? '已收藏：文件与记录永久保留，不再参与定期清退'
          : '已取消收藏：恢复默认清退窗口（图片 30 天/语音 3-7 天）',
      };
    },
    // 主动解析（媒体管道 v3）：DSH 当轮想看图时经此触发 vision 解析——
    // ready 直接返回已有描述；pending 同步解析（超时降级后台队列，绝不标 failed）；
    // 收藏语义重设计后「进入详情表且被解析 = 收藏」，无收藏动作工具。
    // 换源重识（2026-11-26）：source（强制仅用该源，失败不降级）或 refresh（跳过缓存
    // 全链重跑）任一存在时绕过 ready 短路——重识结果经 updateDesc 覆盖旧描述。
    chat_image_describe: async (args) => {
      if (!media || !mediaAnalyzer) throw new Error('媒体服务未装配（检查 server.mjs）');
      const id = String(args?.mediaId ?? '').trim();
      if (!/^ma_[0-9a-f]{12}$/.test(id)) throw new Error('mediaId 必须是 ma_ 开头的 12 位十六进制占位符 id');
      const asset = media.get(id);
      if (!asset) throw new Error(`媒体资产不存在：${id}`);
      if (asset.kind !== 'image') {
        return { ok: false, reason: 'kind-not-image', mediaId: id, kind: asset.kind, note: '当前仅支持图片解析' };
      }
      const source = args?.source ? String(args.source).trim() : '';
      const refresh = args?.refresh === true;
      if (source && !['saucenao', 'cloudflare', 'huggingFace'].includes(source)) {
        return { ok: false, reason: 'unknown-source', mediaId: id, note: 'source 仅支持 saucenao / cloudflare / huggingFace（可用 chat_vision_sources 查询就绪状态）' };
      }
      if (!source && !refresh && asset.status === 'ready' && (asset.desc || asset.textContent)) {
        return { ok: true, mediaId: id, desc: asset.desc || asset.textContent, tags: asset.tags, cached: true };
      }
      // 同步解析 + 超时降级（Promise.race）：超时后 analyzeOne 继续跑完写库，
      // 模型拿到「已转入后台队列重试」——保持 pending，绝不标 failed。
      const timeoutMs = Number.isSafeInteger(args?.timeoutMs) ? Math.min(60000, Math.max(5000, args.timeoutMs)) : 30000;
      let raced = false;
      const job = mediaAnalyzer.analyzeOne(asset, source ? { visionSource: source } : {}).finally(() => { raced = true; });
      const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
      const result = await Promise.race([job, timer]);
      if (result === 'timeout') {
        return { ok: false, reason: 'timeout', mediaId: id, note: '解析耗时较长，已转入后台队列继续，稍后可用 chat_media_get 查询' };
      }
      if (result?.ok) {
        const fresh = media.get(id);
        return { ok: true, mediaId: id, desc: fresh?.desc, tags: fresh?.tags, ...(source || refresh ? { refreshed: true } : {}) };
      }
      const failedNote = source
        ? `指定源 ${source} 识别失败（不降级其它源），可换 source 重试或用 chat_media_note 直接修正描述；对用户只说暂时看不清，不提内部机制`
        : '这次没看清（后台会继续重试，结果好了自然呈现）；对用户只说暂时看不清/换个说法，不要提队列、后台或重试机制';
      return { ok: false, reason: result?.reason ?? 'vision-failed', mediaId: id, note: failedNote };
    },
    // 识图源清单（2026-11-26 换源重识）：各源就绪状态与当日配额余量——模型据此
    // 自主判断是否/如何指定 chat_image_describe 的 source 参数。
    chat_vision_sources: async () => {
      if (!modelHub) return { ok: true, sources: [{ name: 'llm-fallback', ready: true, note: 'vision-svc 未装配，识图走 LLM 兜底（不支持指定源）' }] };
      const list = await modelHub.visionSources();
      if (!list) return { ok: false, reason: 'vision-svc-not-ready', note: 'vision-svc 未就绪，识图将走 LLM 兜底' };
      return { ok: true, sources: list, note: 'saucenao=动漫图匹配；cloudflare/huggingFace=通用照片描述；source 指定后强制仅用该源，失败不降级' };
    },
    // 主动开口说话（voice-synth 工具面，2026-11-25）：文本 → 克隆音色合成语音
    // 入 voice_lib。异步任务：立即返回 mediaId(status=synthesizing)，合成完成后
    // ready，再用 chat_voice_send 发送（未 ready 走既有 E_NOT_READY 降级）。
    chat_voice_synthesize: async (args, ctx) => {
      if (!voiceSynth) throw new Error('语音合成 worker 未装配（检查 server.mjs）');
      const text = String(args?.text ?? '').trim();
      if (!text) throw new Error('text 必填：要说的话');
      const result = await voiceSynth.submit({
        text,
        sessionId: requireText(ctx?.sessionKey, 'sessionKey'),
        role: args?.role,
        emotion: args?.emotion,
        personaKeywords: args?.personaKeywords,
      });
      if (!result.ok) return { ok: false, reason: result.reason, note: result.note ?? '语音合成未就绪' };
      return {
        ok: true,
        mediaId: result.mediaId,
        role: result.role,
        emotion: result.emotion,
        status: 'synthesizing',
        // note 是给模型的行为指令，不是给用户的话术：合成是「酝酿开口」，期间正常
        // 回话；mediaId/status 是内部凭据——向用户播报合成进度即违反感官具身化纪律。
        note: '已开始合成（约需半分钟）。期间正常回话或安静等待，不要向用户提及合成过程、耗时或任何内部凭据；用 chat_media_get 确认 ready 后（或直接）用 chat_voice_send 把语音发出——发出去才算「说出口」。',
      };
    },
    // 音色库查询（voice-bank 工具面）：LLM 选角色/情绪前先看可用清单
    chat_voice_bank_list: async () => {
      if (!voiceBank) throw new Error('voice-bank 未装配（检查 server.mjs）');
      return {
        ok: true,
        roles: voiceBank.listRoles(),
        note: 'chat_voice_synthesize 传 role + emotion（从该角色 emotions 集合里选）；不传 role 时按 personaKeywords 自动匹配角色',
      };
    },
    // 音色归档：把听到的语音暂存文件登记为某角色某情绪的克隆参考音频
    chat_voice_bank_add: async (args) => {
      if (!voiceBank) throw new Error('voice-bank 未装配（检查 server.mjs）');
      const id = String(args?.mediaId ?? '').trim();
      if (!/^ma_[0-9a-f]{12}$/.test(id)) throw new Error('mediaId 必须是 ma_ 开头的 12 位十六进制占位符 id');
      const asset = media.get(id);
      if (!asset) throw new Error(`媒体资产不存在：${id}`);
      if (asset.kind !== 'voice') throw new Error(`只能归档语音资产（当前 kind=${asset.kind}）`);
      const result = voiceBank.promote({
        sourcePath: asset.sourcePath,
        role: args?.role,
        emotion: args?.emotion,
        promptText: args?.promptText ?? asset.textContent ?? '',
      });
      const notes = {
        'source-missing': '源文件已不在：语音源文件转写后只暂存 3 天（inbox），请用近期语音归档',
        'prompt-text-required': 'promptText 必填：参考音频里说的那句话（GPT-SoVITS 克隆需要文本对齐）',
        'voice-lib-not-configured': '音色库未配置（audios/[角色]/config.json）',
        'role-required': 'role 必填：归档到哪个角色',
      };
      if (!result.ok) return { ok: false, reason: result.reason, note: notes[result.reason] ?? '归档失败' };
      return { ok: true, mediaId: id, role: result.role, emotion: result.emotion, ref: result.ref };
    },
    chat_memory_recall: (args, ctx) => {
      if (!recall) throw new Error('recall 服务未装配（检查 server.mjs）');
      const sessionKey = requireText(ctx?.sessionKey, 'sessionKey');
      // subjectId 支持按名字解析（subject 身份层：群名片 → 全局昵称）；解析不到
      // 按原样处理（可能是调用方直接传的稳定 id）。
      let subjectId = args.subjectId;
      if (subjectId && subject) {
        subjectId = subject.resolve({ sessionId: sessionKey, alias: subjectId }) ?? subjectId;
      }
      return recall.recall({
        sessionId: sessionKey,
        text: String(args.text ?? ''),
        kinds: args.kinds,
        subjectId,
        limit: args.limit,
      });
    },
    chat_memory_record: (args, ctx) => {
      requireText(args.content, 'content');
      return memory.record({
        sessionId: requireText(ctx?.sessionKey, 'sessionKey'),
        content: args.content,
        kind: args.kind,
        subjectId: args.subjectId,
        category: args.category,
        importance: args.importance,
        extra: args.extra,
      });
    },
    chat_memory_forget: (args, ctx) => {
      requireText(args.id, 'id');
      // 归属校验下沉到 memory.forget（防「知道 id 就能删别人会话」）。
      return memory.forget({
        id: args.id,
        mode: args.mode,
        sessionId: requireText(ctx?.sessionKey, 'sessionKey'),
      });
    },
  };

  /** 工具调用（唯一信封）：业务失败以 ok:false 正常返回（HTTP 仍 200），网关原样透传。 */
  async function toolsCall(request) {
    if (request.v !== 1) throw new Error('tool.call 只支持 v=1');
    requireText(request.callId, 'callId');
    const tool = requireText(request.tool, 'tool', 128);
    const handler = tools[tool];
    if (!handler) {
      return {
        v: 1, callId: request.callId, ok: false,
        error: { code: 'E_UNSUPPORTED', message: `未知工具：${tool}（支持：${Object.keys(tools).join('、')}）` },
      };
    }
    const args = request.args && typeof request.args === 'object' ? request.args : {};
    const context = request.context && typeof request.context === 'object' ? request.context : {};
    const ctx = {
      sessionKey: request.sessionKey,
      senderId: context.senderId,
      text: context.text,
    };
    try {
      const data = await handler(args, ctx);
      return { v: 1, callId: request.callId, ok: true, data };
    } catch (error) {
      log(`tools.call ${tool} 业务失败：${error?.message ?? error}`);
      return {
        v: 1, callId: request.callId, ok: false,
        error: { code: 'E_ACTION', message: String(error?.message ?? error) },
      };
    }
  }

  // ── 工具清单（GET /v1/tools；控制台「拉取清单预填」的数据源）────────────────
  // 与上方 tools 分发表同源：增删工具必须同步维护本清单。role 是网关视角的
  // 参考预填值（decorator=可进管线编排；登记文件里最终 role 由操作者确认）。
  const TOOL_MANIFEST = [
    { name: 'chat_memory_get', role: 'decorator', description: '按会话与对话对象渲染长期记忆为管线注入块（identity 高优先级）', inputSchema: { type: 'object' } },
    { name: 'chat_memory_save', role: 'tool', description: '会话缓冲落库：规整消息、窗口哈希幂等、LLM 自动提取摘要/画像/关系', inputSchema: { type: 'object' } },
    { name: 'chat_memory_recall', role: 'tool', description: '按查询意图检索长期记忆条目（话题/偏好/关系召回）', inputSchema: { type: 'object' } },
    { name: 'chat_memory_record', role: 'tool', description: '写入单条长期记忆（显式「记住某件事」路径）', inputSchema: { type: 'object' } },
    { name: 'chat_memory_forget', role: 'tool', description: '删除指定的长期记忆条目', inputSchema: { type: 'object' } },
    { name: 'chat_media_search', role: 'tool', description: '从收藏的媒体（已识别的图片/表情等）按含义检索，返回定量候选列表（语义匹配度×使用热度×随机采样，mediaId+描述+热度）——发送前先用本工具选图，配合网关媒体发送工具使用', inputSchema: { type: 'object' } },
    { name: 'chat_media_get', role: 'tool', description: '按 mediaId 查询多媒体资产详情（描述/标签/发送凭据）。wait=true 对解析中的资产同步等结果（语音转写/图片识别几秒就绪）——收到语音/图片想等内容就用它。mediaId/status/ref 是内部凭据：只用于工具参数，绝不向用户提及', inputSchema: { type: 'object', properties: { mediaId: { type: 'string', pattern: '^ma_[0-9a-f]{12}$' }, wait: { type: 'boolean', description: 'true=解析中时同步等结果（上限 20s）' }, waitMs: { type: 'number', description: '等待上限毫秒（默认 20000）' } }, required: ['mediaId'] } },
    { name: 'chat_media_mark_used', role: 'tool', description: '标记某媒体资产被使用（发送后回写学习信号）', inputSchema: { type: 'object' } },
    { name: 'chat_media_record', role: 'tool', description: '登记多媒体资产（网关实时旁路：hashId→fileRef/url 指导清单，幂等）', inputSchema: { type: 'object' } },
    { name: 'chat_media_note', role: 'tool', description: '回写媒体认知：对看过的媒体直接修正描述/标签（mediaId 必须已存在）。与 chat_image_describe 换源重识互补：重识=机器换途径再猜，本工具=直接定论', inputSchema: { type: 'object' } },
    { name: 'chat_media_favorite', role: 'tool', description: '收藏/取消收藏媒体：收藏后文件与记录永久保留，豁免定期清退（清退窗口：图片 30 天/语音 3-7 天；懒清退即源文件真缺失时不豁免）。对用户明确表示要保留、或语义上值得长期留存的图片/音频调用；favorite:false 取消', inputSchema: { type: 'object', properties: { mediaId: { type: 'string', pattern: '^ma_[0-9a-f]{12}$' }, favorite: { type: 'boolean', description: 'true=收藏（默认），false=取消' } }, required: ['mediaId'] } },
    { name: 'chat_image_describe', role: 'tool', description: '用眼睛看图：vision 看图返回描述并回写详情表（仅支持图片；ready 直接返回已看到的描述；超时降级后台继续看）。可选 source 强制换种看法（saucenao=动漫图匹配 / cloudflare|huggingFace=通用照片描述，失败不降级）、refresh 忽略已有认知重新看——是否需要由你根据对话语义自主判断（重看结果覆盖旧认知；可用 chat_vision_sources 查各源就绪与配额）。看的过程是内部机制：对用户只呈现最终「看到了什么」', inputSchema: { type: 'object', properties: { mediaId: { type: 'string', pattern: '^ma_[0-9a-f]{12}$' }, source: { type: 'string', enum: ['saucenao', 'cloudflare', 'huggingFace'], description: '强制仅用该识图源（跳过缓存与降级链）' }, refresh: { type: 'boolean', description: 'true=忽略缓存强制重新识别' } }, required: ['mediaId'] } },
    { name: 'chat_vision_sources', role: 'tool', description: '查询可用识图源清单：各源名称、就绪状态、当日配额余量（配合 chat_image_describe 的 source 参数使用）', inputSchema: { type: 'object' } },
    { name: 'chat_voice_synthesize', role: 'tool', description: '开口说话：把要说的话用克隆音色合成为语音（异步：提交后像在酝酿开口，约半分钟；role+emotion 指定音色与情绪，可先用 chat_voice_bank_list 查可用角色；不传 role 时网关自动按当前人设角色卡匹配音色）。mediaId/status 是内部凭据，绝不向用户提及合成过程——说出口（chat_voice_send）才算「说了」', inputSchema: { type: 'object' } },
    { name: 'chat_voice_bank_list', role: 'tool', description: '查询音色库：可用角色、人设关键词、各角色支持的情绪集', inputSchema: { type: 'object' } },
    { name: 'chat_voice_bank_add', role: 'tool', description: '音色归档：把一条已转写的语音登记为某角色某情绪的克隆参考音频（语音源文件只暂存 3 天，尽快归档）', inputSchema: { type: 'object' } },
  ];

  const endpoints = new Map([
    ['/v1/tools/call', (request) => toolsCall(request)],
    // GET /v1/tools：只读工具清单（rawBody 为空 → request={}，invoke 的对象检查天然通过）。
    ['/v1/tools', () => ({ ok: true, tools: TOOL_MANIFEST })],
  ]);

  /**
   * 分发（已鉴权的请求体）：HTTP 入口 handle 验签后进入；单独导出供测试直连。
   * WS 帧入口已退役（传输按角色非对称：资源服务只走 HTTP tool.call）。
   */
  async function invoke({ path, request }) {
    const handler = endpoints.get(path);
    if (!handler) return { status: 404, body: { error: `未知路由：${path}` } };
    if (!request || typeof request !== 'object') return { status: 400, body: { error: '请求体必须是对象' } };
    try {
      return { status: 200, body: await handler(request) };
    } catch (error) {
      // 契约层错误（缺 callId 等）= 调用方要修的，400；带 callId 时尽量回传以便关联。
      const callId = typeof request?.callId === 'string' ? request.callId : undefined;
      log(`gateway-v1 ${path} 契约错误：${error?.message ?? error}`);
      return { status: 400, body: { error: String(error?.message ?? error), ...(callId ? { callId } : {}) } };
    }
  }

  return {
    /** 该服务的工具面清单（登记文件 tools[] 的服务端事实源）。 */
    toolNames: () => Object.keys(tools),

    /** 分发入口：不重复验签（验签在 handle），供 HTTP handle 与测试使用。 */
    invoke,

    /**
     * HTTP 层入口：验签 → 解析 → 分发。永不 throw（错误已翻译成状态码）；
     * 只有编程错误（auth 缺失等）会上抛，由 http-api 的外层 catch 兜底。
     * @returns {Promise<{status: number, body: object}>}
     */
    async handle({ path, headers, rawBody }) {
      if (!auth) return { status: 503, body: { error: '网关接入未配置（仓库根目录缺少 gateway.json）' } };
      try {
        auth.verify({ headers, rawBody });
      } catch (error) {
        return { status: 401, body: { error: String(error?.message ?? error) } };
      }
      let request;
      try {
        request = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return { status: 400, body: { error: '请求体不是合法 JSON' } };
      }
      return invoke({ path, request });
    },
  };
}
