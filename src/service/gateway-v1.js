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
    '- 想看图的内容：调用 chat_media_describe（会解析图片返回描述）；想发图片/表情：先用 chat_media_search 拿候选列表（按语义匹配×使用热度随机采样，从中挑一个），再用 chat_image_send 发送；发语音用 chat_voice_send，发文件用 chat_file_send；',
    '- 媒体是否被记住是自动的：被记忆服务解析过的媒体会长期保留并优先注入，无需收藏动作。',
  ].join('\n'),
  priority: 40,
};

export function createGatewayV1({
  mediaAnalyzer = null, voiceSynth = null, voiceBank = null, auth, memory, recall, subject, sessionSave, media, logger } = {}) {
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
        ...(r.ref ? { ref: r.ref } : {}),
      }));
      const items = media.selectForSend(pool, { query: text, limit });
      return {
        media: items,
        ...(text ? {} : { note: '未给 query：按使用热度+随机返回收藏的媒体' }),
      };
    },
    chat_media_get: async (args) => {
      if (!media) throw new Error('媒体服务未装配（检查 server.mjs）');
      const id = String(args?.mediaId ?? '').trim();
      if (!/^ma_[0-9a-f]{12}$/.test(id)) throw new Error('mediaId 必须是 ma_ 开头的 12 位十六进制占位符 id');
      const asset = media.get(id);
      if (!asset) return { found: false };
      return { found: true, media: { mediaId: asset.id, kind: asset.kind, desc: asset.desc || asset.textContent, tags: asset.tags, ref: asset.ref, sendHints: asset.sendHints, status: asset.status } };
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
    chat_media_record: async (args) => {
      if (!media) throw new Error('媒体服务未装配（检查 server.mjs）');
      const sessionId = String(args?.sessionId ?? '').trim();
      const list = Array.isArray(args?.media) ? args.media : [];
      const rows = await media.ensureAssets({ sessionId, media: list });
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
    // 主动解析（媒体管道 v3）：DSH 当轮想看图时经此触发 vision 解析——
    // ready 直接返回已有描述；pending 同步解析（超时降级后台队列，绝不标 failed）；
    // 收藏语义重设计后「进入详情表且被解析 = 收藏」，无收藏动作工具。
    chat_media_describe: async (args) => {
      if (!media || !mediaAnalyzer) throw new Error('媒体服务未装配（检查 server.mjs）');
      const id = String(args?.mediaId ?? '').trim();
      if (!/^ma_[0-9a-f]{12}$/.test(id)) throw new Error('mediaId 必须是 ma_ 开头的 12 位十六进制占位符 id');
      const asset = media.get(id);
      if (!asset) throw new Error(`媒体资产不存在：${id}`);
      if (asset.kind !== 'image') {
        return { ok: false, reason: 'kind-not-image', mediaId: id, kind: asset.kind, note: '当前仅支持图片解析' };
      }
      if (asset.status === 'ready' && (asset.desc || asset.textContent)) {
        return { ok: true, mediaId: id, desc: asset.desc || asset.textContent, tags: asset.tags, cached: true };
      }
      // 同步解析 + 超时降级（Promise.race）：超时后 analyzeOne 继续跑完写库，
      // 模型拿到「已转入后台队列重试」——保持 pending，绝不标 failed。
      const timeoutMs = Number.isSafeInteger(args?.timeoutMs) ? Math.min(60000, Math.max(5000, args.timeoutMs)) : 30000;
      let raced = false;
      const job = mediaAnalyzer.analyzeOne(asset).finally(() => { raced = true; });
      const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
      const result = await Promise.race([job, timer]);
      if (result === 'timeout') {
        return { ok: false, reason: 'timeout', mediaId: id, note: '解析耗时较长，已转入后台队列继续，稍后可用 chat_media_get 查询' };
      }
      if (result?.ok) {
        const fresh = media.get(id);
        return { ok: true, mediaId: id, desc: fresh?.desc, tags: fresh?.tags };
      }
      return { ok: false, reason: result?.reason ?? 'vision-failed', mediaId: id, note: '暂无法解析（视觉模型不可用或内容取不到），已转入后台队列重试' };
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
        note: '正在用克隆音色合成（CPU 需 25-70 秒），稍后用 chat_media_get 查询状态，ready 后用 chat_voice_send 发送',
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
        'voice-lib-not-configured': 'voice_lib 未配置（voice_bank.json voiceLibDir）',
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
    { name: 'chat_media_get', role: 'tool', description: '按 mediaId 查询多媒体资产详情（描述/标签/发送凭据）', inputSchema: { type: 'object' } },
    { name: 'chat_media_mark_used', role: 'tool', description: '标记某媒体资产被使用（发送后回写学习信号）', inputSchema: { type: 'object' } },
    { name: 'chat_media_record', role: 'tool', description: '登记多媒体资产（网关实时旁路：hashId→fileRef/url 指导清单，幂等）', inputSchema: { type: 'object' } },
    { name: 'chat_media_note', role: 'tool', description: '回写媒体认知：对看过的媒体补充描述/标签（mediaId 必须已存在）', inputSchema: { type: 'object' } },
    { name: 'chat_media_describe', role: 'tool', description: '主动解析图片内容：vision 模型看图返回描述并回写详情表（ready 直接返回缓存描述；超时降级后台队列）', inputSchema: { type: 'object' } },
    { name: 'chat_voice_synthesize', role: 'tool', description: '主动开口说话：把要说的话用克隆音色合成语音（异步，立即返回 mediaId；role+emotion 指定音色与情绪，可先用 chat_voice_bank_list 查可用角色；不传 role 按人设关键词自动匹配）', inputSchema: { type: 'object' } },
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
