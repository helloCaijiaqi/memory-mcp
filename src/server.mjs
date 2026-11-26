// 进程入口：stdio MCP（给 DSH）+ 回环 HTTP（给平台桥接）同时起。
//
// 日志一律走 stderr：stdout 是 MCP 的协议通道，被污染会导致握手失败。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store/store-api.js';
import { createMemoryService } from './service/memory-service.js';
import { createRelationService } from './service/relation-service.js';
import { createRawService } from './service/raw-service.js';
import { createFts5Backend, createRecallRouter, createVectorBackend } from './service/recall.js';
import { createPlatformPolicy } from './service/platform-policy.js';
import { createSlangService } from './service/slang-service.js';
import { createMediaService } from './service/media-service.js';
import { createMediaAnalyzer } from './service/media-analyzer.js';
import { createMediaRetention } from './service/media-retention.js';
import { createGatewayAuth, createGatewayV1 } from './service/gateway-v1.js';
import { createGatewayWatcher } from './gateway-watch.js';
import { createProfileService } from './service/profile-service.js';
import { createSubjectService } from './service/subject-service.js';
import { createSessionSave } from './service/session-save.js';
import { createRelationGuard } from './service/relation-guard.js';
import { createLlmProvider } from './llm-provider.js';
import { loadEnvFile } from './load-env.js';
import { createModelSupervisor, createMediaModelAdapter } from './service/model-supervisor.js';
import { createVoiceSynthWorker } from './service/voice-synth.js';
import { createRoleVoiceScanner } from './service/role-voice-scanner.js';
import { createHttpApi } from './http-api.js';
import { serveStdio } from './mcp-memory.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 可降级的端口错误：被占用 / 无权限。其余错误（参数非法等）仍然快速失败。 */
const PORT_CONFLICT_CODES = new Set(['EADDRINUSE', 'EACCES']);
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── LLM 提取配置（2026-11-18）：根目录 llm.config.json 为默认，显式 env 覆盖 ──
// 文件字段用驼峰（enabled/baseUrl/apiKey/model/timeoutMs），真实文件含 apiKey、
// 已入 .gitignore（同 gateway.json 模式）；示例见 llm.config.example.json。
const LLM_FILE_FIELDS = [
  ['MEMORY_MCP_LLM_ENABLED', 'enabled'],
  ['MEMORY_MCP_LLM_BASE_URL', 'baseUrl'],
  ['MEMORY_MCP_LLM_API_KEY', 'apiKey'],
  ['MEMORY_MCP_LLM_MODEL', 'model'],
  ['MEMORY_MCP_LLM_TIMEOUT_MS', 'timeoutMs'],
];

function loadLlmFileConfig() {
  try {
    const raw = fs.readFileSync(path.join(PKG_ROOT, 'llm.config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // 告警走 stderr（stdout 是 MCP 协议通道）；fail-open 不挡启动。
      console.error(`[memory-mcp] llm.config.json 解析失败（忽略文件，回退 env/默认值）：${error?.message ?? error}`);
    }
    return {};
  }
}

function resolveLlmConfig(env, warn) {
  const file = loadLlmFileConfig();
  const merged = {};
  let hasEnv = false;
  let hasFile = false;
  for (const [envKey, fileKey] of LLM_FILE_FIELDS) {
    const envValue = env[envKey];
    const fileValue = file[fileKey];
    if (envValue != null) hasEnv = true;
    if (fileValue !== undefined) hasFile = true;
    // env 显式残留会静默压过文件（曾 setx 过是常见来源），冲突即告警提示清理。
    if (envValue != null && fileValue !== undefined && String(envValue) !== String(fileKey === 'apiKey' ? '***' : fileValue)) {
      warn(`${envKey}（env）压过 llm.config.json 的 ${fileKey}——环境变量残留建议清理`);
    }
    merged[fileKey] = envValue ?? fileValue;
  }
  // vision 子配置（多媒体记忆层，2026-11-24）：主文本模型看不了图，vision 必须
  // 显式配置独立 model 才启用（enabled+model），baseUrl/apiKey/timeoutMs 继承主
  // 配置可覆盖。未配置 → media-analyzer 保持 pending（绝不瞎编）。
  const visionRaw = file.vision && typeof file.vision === 'object' ? file.vision : {};
  const vision = {
    enabled: visionRaw.enabled === true || String(env.MEMORY_MCP_LLM_VISION_ENABLED ?? '') === '1',
    model: env.MEMORY_MCP_LLM_VISION_MODEL ?? String(visionRaw.model ?? '').trim(),
    ...(env.MEMORY_MCP_LLM_VISION_BASE_URL ? { baseUrl: env.MEMORY_MCP_LLM_VISION_BASE_URL } : (visionRaw.baseUrl ? { baseUrl: String(visionRaw.baseUrl) } : {})),
    ...(env.MEMORY_MCP_LLM_VISION_API_KEY ? { apiKey: env.MEMORY_MCP_LLM_VISION_API_KEY } : (visionRaw.apiKey ? { apiKey: String(visionRaw.apiKey) } : {})),
    ...(visionRaw.timeoutMs != null ? { timeoutMs: num(visionRaw.timeoutMs, 45_000) } : {}),
  };
  // audio/video 子配置透传（2026-11-25）：resolveLlmConfig 此前只解析 vision，
  // audio（libDir 等）在 server.mjs 这层被丢弃 → llm-provider 恒拿到 null →
  // 语音资产的 loadAudio 找不到 libDir 全部 no-audio-data。这里原样透传文件块。
  const audioRaw = file.audio && typeof file.audio === 'object' ? file.audio : null;
  const videoRaw = file.video && typeof file.video === 'object' ? file.video : null;
  return {
    enabled: merged.enabled === true || String(merged.enabled ?? '') === '1',
    baseUrl: merged.baseUrl ?? '',
    apiKey: merged.apiKey ?? '',
    model: merged.model ?? '',
    timeoutMs: num(merged.timeoutMs, 20_000),
    vision,
    ...(audioRaw ? { audio: audioRaw } : {}),
    ...(videoRaw ? { video: videoRaw } : {}),
    source: hasEnv ? 'env' : (hasFile ? 'file' : 'none'),
  };
}

export function resolveConfig(env = process.env) {
  // MEMORY_MCP_DATA_DIR 是文档里的旧名字：两个都认，避免升级后旧部署「换了目录还不自知」。
  // 严格布局（2026-11-25）：state 按类型分目录——
  //   state/data/    = 机器运行数据（memory.db、media/、raw-archive/、vision-cache/、backups/）
  //   state/secrets/ = 安全敏感（http-token，0600）
  // MEMORY_MCP_STATE_DIR 语义保持「数据目录」重定位（测试/搬盘用）；secrets 固定
  // <repo>/state/secrets（token 一次性生成，极少随盘搬；ensureToken 兼容旧位置迁移）。
  const stateDir = path.resolve(env.MEMORY_MCP_STATE_DIR ?? env.MEMORY_MCP_DATA_DIR ?? path.join(PKG_ROOT, 'state', 'data'));
  const secretsDir = path.resolve(path.join(PKG_ROOT, 'state', 'secrets'));
  return {
    stateDir,
    secretsDir,
    // 分层注入（head/tail + 原始层 + 关系 + 召回）的灰度开关：默认开，`=0` 只留旧接口。
    // 默认开是因为桥接已经按新契约改造；开关的存在是为了「出问题时一条环境变量回退」。
    layersV2: String(env.MEMORY_LAYERS_V2 ?? '1') !== '0',
    port: num(env.MEMORY_MCP_HTTP_PORT, 7181),
    host: '127.0.0.1',
    token: env.MEMORY_MCP_TOKEN ?? '',
    readonlyTokenFile: path.join(secretsDir, 'http-token'),
    // 网关接入：唯一来源是仓库根目录的 gateway.json——但不再在 resolveConfig
    // 里读取（启动期一次性绑定是「注册后必须重启」的根源）。改由 start() 里的
    // createGatewayWatcher 热加载：文件出现/修复/变更 ≤2s 自动生效。旧
    // *_GATEWAY_* 环境变量已退役，设置了会直接报错（检测挪进 watcher）。
    // head 断点与情绪时效：两个服务共用同一组数字，不允许各配各的。
    head: {
      quietWindowMs: num(env.MEMORY_MCP_HEAD_QUIET_MINUTES, 30) * MINUTE_MS,
      emotionFreshMs: num(env.MEMORY_MCP_EMOTION_FRESH_HOURS, 2) * HOUR_MS,
    },
    relation: {
      // 跨平台共享同一个人的关系是产品决策，默认关；要开就显式设成 1。
      identityEnabled: String(env.MEMORY_MCP_RELATION_IDENTITY ?? '') === '1',
    },
    // 平台白名单：默认只认 qq；新平台接入时按需加进 MEMORY_MCP_PLATFORMS。
    // strict 默认关 —— 未知平台先放行并告警，等桥接跑通再收紧。
    platforms: String(env.MEMORY_MCP_PLATFORMS ?? 'qq')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    platformStrict: String(env.MEMORY_MCP_PLATFORM_STRICT ?? '') === '1',
    raw: {
      rawRetentionDays: num(env.MEMORY_MCP_RAW_RETENTION_DAYS, 30),
    },
    // 媒体缺省清退（媒体管道 v2）：未收藏且超龄的媒体资产删源文件+删记录，
    // 删行时批量修复摘要/raw 占位符；收藏豁免。缺省每 6 小时扫一轮、30 天超龄。
    mediaRetention: {
      enabled: String(env.MEMORY_MCP_MEDIA_RETENTION ?? '1') !== '0',
      intervalMs: num(env.MEMORY_MCP_MEDIA_RETENTION_HOURS, 6) * HOUR_MS,
      retentionDays: num(env.MEMORY_MCP_MEDIA_RETENTION_DAYS, 30),
    },
    // LLM（OpenAI 兼容）：黑话解释 + save 摘要共用一个 provider。默认关闭 ——
    // 关闭时 chat_memory_save 跳过摘要/画像/关系步骤（raw + alias + 纪元照常
    // 落地），长期层退化为「record / 手动巩固」，行为与旧版一致。
    llm: resolveLlmConfig(env, (msg) => console.error(`[memory-mcp] ${msg}`)),
    // 专用模型子进程（model-hub，2026-11-25）：ASR 等专职服务随 memory 一起
    // spawn 监管；识图阶段一走 LLM vision 兜底（visionMode='llm-fallback'）。
    modelHub: {
      asr: {
        enabled: String(env.MEMORY_MCP_MODEL_HUB_ASR ?? '1') !== '0',
        port: num(env.MEMORY_MCP_MODEL_HUB_ASR_PORT, 18102),
      },
      tts: {
        // 2026-11-25 起 GPT-SoVITS 集成包就位，默认启用（tts-svc 自带水位保护，
        // 内存不足时 E_BUSY 降级）；MEMORY_MCP_MODEL_HUB_TTS=0 可显式关闭。
        enabled: String(env.MEMORY_MCP_MODEL_HUB_TTS ?? '1') !== '0',
        port: num(env.MEMORY_MCP_MODEL_HUB_TTS_PORT, 18103),
      },
      visionMode: env.MEMORY_MCP_MODEL_HUB_VISION_MODE ?? 'llm-fallback',
      // 阶段二：visionMode='vision-svc' 时 spawn subprocesses/vision-svc（外部识图聚合）
      visionPort: num(env.MEMORY_MCP_MODEL_HUB_VISION_PORT, 18104),
    },
    memory: {
      sessionIdleMs: num(env.MEMORY_MCP_SESSION_IDLE_MINUTES, 60) * MINUTE_MS,
    },
    recall: {
      // 跨平台召回默认关：同一个 scope:id 在不同平台是不同的人/群，串台比召回不到更糟。
      crossPlatform: String(env.MEMORY_MCP_RECALL_CROSS_PLATFORM ?? '') === '1',
      maxRows: num(env.MEMORY_MCP_RECALL_MAX_ROWS, 5),
      maxChars: num(env.MEMORY_MCP_RECALL_MAX_CHARS, 400),
    },
  };
}

/** 本地令牌：优先用环境变量，否则在 state/secrets/ 里生成一份（0600，与数据文件物理分离）。
 *  旧布局兼容：state/http-token（升级前）存在则自动搬进 secrets/，桥接无感。 */
function ensureToken(cfg) {
  if (cfg.token) return cfg.token;
  fs.mkdirSync(cfg.secretsDir, { recursive: true });
  try {
    const existing = fs.readFileSync(cfg.readonlyTokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* secrets/ 还没生成过 */
  }
  // 旧位置迁移：state/http-token → state/secrets/http-token（rename 失败降级 copy）
  const legacyTokenFile = path.join(PKG_ROOT, 'state', 'http-token');
  try {
    const legacy = fs.readFileSync(legacyTokenFile, 'utf8').trim();
    if (legacy) {
      try {
        fs.renameSync(legacyTokenFile, cfg.readonlyTokenFile);
      } catch {
        fs.copyFileSync(legacyTokenFile, cfg.readonlyTokenFile);
      }
      return legacy;
    }
  } catch {
    /* 旧布局也没有 */
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(cfg.readonlyTokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(cfg.readonlyTokenFile, 0o600);
  } catch {
    /* Windows 上可能不支持 */
  }
  return token;
}

export async function start({ env = process.env, stdio = true, http: withHttp = true, logger } = {}) {
  // .env 装载（2026-11-25）：MEMORY_MCP_* 配置的显性载体——根目录 .env（gitignored，
  // 模板 .env.example）。真实 env > .env > 默认值；装载的键打日志，配过什么可查证。
  const envApplied = loadEnvFile(PKG_ROOT, env);
  const log0 = logger ?? ((...args) => console.error('[memory-mcp]', ...args));
  if (envApplied.length) log0(`.env 已装载 ${envApplied.length} 项：${envApplied.join(', ')}`);
  const cfg = resolveConfig(env);
  const log = logger ?? log0;
  const token = ensureToken(cfg);

  const store = await openStore({ dir: cfg.stateDir });
  if (store.degradedFrom) log(`存储降级：${store.degradedFrom}`);

  const platformPolicy = createPlatformPolicy({
    known: cfg.platforms,
    strict: cfg.platformStrict,
    logger: log,
  });

  // 人物画像服务先于 memory 装配（memory.render 的 identity 块用双层合并读：
  // identity 全局打底 + session 会话覆盖，见 profile-service.get）。
  const profile = createProfileService({ store, logger: log });
  const memory = createMemoryService({
    store,
    profile,
    config: { head: cfg.head, sessionIdleMs: cfg.memory.sessionIdleMs },
    platformPolicy,
    mediaRender: (text) => media.renderPlaceholders(text),
});
  const slang = createSlangService({ store });

  const relation = createRelationService({
    store,
    config: { identityEnabled: cfg.relation.identityEnabled, emotionFreshMs: cfg.head.emotionFreshMs },
    platformPolicy,
  });
  const raw = createRawService({ store, stateDir: cfg.stateDir, config: cfg.raw, logger: { log } });
  const llm = createLlmProvider(cfg.llm);

  // 专用模型子进程监管（2026-11-25）：spawn asr-svc 等本地专职服务，媒体识别
  // 经 adapter 走子服务（语音）与 LLM 兜底（识图，阶段一）；随 memory 生命周期启停。
  // 子服务 token 与 http-token 同源（2026-11-26）：此前 supervisor 每次启动随机生成，
  // 子服务 token 随重启轮换且无法外部探活；统一用 ensureToken 的持久 token。
  const modelHub = createModelSupervisor({ config: { ...(cfg.modelHub ?? {}), token }, logger: log });
  modelHub.start();
  // 媒体识别 adapter：与 llmProvider 同形状——analyzer 注入它而非裸 llm。
  const mediaLlm = createMediaModelAdapter({ llm, hub: modelHub });

  // 多媒体记忆层（media memory tier）：详情表服务 + 解析兜底队列（2026-11-24）。
  // mediaDir 固定 state/media（源文件落盘，sha256 命名）；analyzer 是可选 LLM 的
  // 旁路（vision key 未配置时保持 pending 积压，不影响登记/摘要链路）。
  const media = createMediaService({
    store,
    config: { mediaDir: path.join(cfg.stateDir, 'media'), retiredText: cfg.mediaRetention?.retiredText },
    // 召回占位符一致性修复回调（媒体管道 v2）：renderPlaceholders 发现源文件缺失时
    // 由它批量修复摘要/raw（mediaRetention 在下方创建，箭头延迟求值安全）。
    repairPlaceholder: (id, retiredText) =>
      mediaRetention.repairPlaceholderBatch(store, [id], retiredText ?? undefined, log),
  });
  const mediaAnalyzer = createMediaAnalyzer({
    store,
    service: media,
    llm: mediaLlm,
    config: { voiceInboxDir: process.env.MEMORY_MCP_VOICE_RUNTIME_DIR || path.join(cfg.stateDir, 'media', 'qq', 'audio') },
    logger: log,
  });
  mediaAnalyzer.start();
  // 媒体缺省清退（媒体管道 v2）：未收藏且超龄（缺省 30 天）的资产删源文件+删记录，
  // 删行时批量修复摘要/raw 占位符；收藏豁免。配置 config.json mediaRetention 块。
  // 装配先于 voiceBank（2026-11-26）：scanner prune 的 retireAsset 清退管道接线
  // 依赖它（启动即跑一轮 prune，不能 late-binding 空引用）；无循环依赖。
  const mediaRetention = createMediaRetention({ store, media, config: cfg.mediaRetention ?? {}, logger: log });
  mediaRetention.start();
  // 角色音色库（目录即数据库）：audios/[角色]/config.json + 情绪音频，扫描器带
  // mtime 指纹缓存热加载。配置/运行时分离：配置区 audios/ 只放角色夹（固定资产）。
  // 运行时区三区合一（2026-11-26）：inbox（收到暂存）与 out（合成产物）并入
  // media/qq/audio 与 bridge 收媒体同目录共用，文件名分段 ma_<id>.<段>.<ext> 区分
  // 生命周期：.in 3 天归档窗口 / .out 7 天 / 无段名 30 天兜底；带段删除一律走
  // retireAsset 清退管道（删源文件+删详情行+raw 占位符固化），绝不裸删。
  const voiceRuntimeDir = process.env.MEMORY_MCP_VOICE_RUNTIME_DIR
    || path.join(cfg.stateDir, 'media', 'qq', 'audio');
  const voiceBank = createRoleVoiceScanner({
    voiceDir: path.resolve(PKG_ROOT, 'audios'),
    inboxDir: voiceRuntimeDir,
    outDir: voiceRuntimeDir,
    config: {
      pruneDays: Number(process.env.MEMORY_MCP_VOICE_PRUNE_DAYS || 3) || 3,
      outPruneDays: Number(process.env.MEMORY_MCP_VOICE_OUT_PRUNE_DAYS || 7) || 7,
      unsegmentedPruneDays: Number(process.env.MEMORY_MCP_VOICE_UNSEGMENTED_PRUNE_DAYS || 30) || 30,
    },
    retireAsset: (row) => mediaRetention.retireOne(row),
    logger: log,
  });
  voiceBank.start();
  // voice-synth 异步合成 worker（chat_voice_synthesize 工具链）：文本 → 克隆音色
  // 语音落 voiceRuntimeDir（ma_<id>.out.wav 分段命名）。TTS 子服务随 GPT-SoVITS 集成包启用。
  const voiceSynth = createVoiceSynthWorker({
    media,
    hub: modelHub,
    bank: voiceBank,
    config: { outDir: voiceRuntimeDir },
    logger: log,
  });
  // subject 身份层 + session-save 编排（tool.call 统一改造）：网关经 tool.call
  // chat_memory_save 投递整段缓冲，单事务落地 raw/别名/摘要/画像/关系并推进纪元；
  // 内部空闲摘要调度器已删除，落地时机完全由网关裁决。
  // SQLite 降级到 JSON 兜底时（无 subject_alias 集合）save 面缺席：gateway-v1 的
  // chat_memory_save 会按业务失败返回，网关缓冲退避重试——绝不在降级后端上假落地。
  const subject = store.subjectAlias ? createSubjectService({ store, logger: log }) : null;
  const sessionSave = subject
    ? createSessionSave({
      store,
      memory,
      subject,
      profile,
      // save 抽取的 relations + 窗口原文（规则兜底用）→ 守卫处理；save 事务不受
      // 守卫结果影响（守卫永不抛错，失败逐条进 pending/日志）。
      guard: {
        handleExtracted: ({ sessionId, relations, sourceMsgIds, windowHash, rows }) => {
          const results = guard.handleExtracted({ sessionId, relations, sourceMsgIds, windowHash, rows });
          const pending = results.filter((item) => item.outcome === 'pending').length;
          if (pending) log(`save 关系抽取：${results.length} 条候选，其中 ${pending} 条待人工确认`);
          return results;
        },
      },
      llm,
      media,
      mediaAnalyzer,
      logger: log,
    })
    : null;
  if (!sessionSave) log('警告：存储降级（无 subject_alias 集合），chat_memory_save 不可用——网关缓冲将保留重试');
  // 关系守卫：摘要抽取 + 规则兜底的唯一写入通道（阈值/白名单/pending 在这层强制）。
  const guard = createRelationGuard({ store, relation, logger: log });
  // 召回后端按能力装配：FTS5 现在可用，向量是占位（available() === false，不拖慢热路径）。
  const recall = createRecallRouter({
    store,
    backends: [createFts5Backend({ store, config: cfg.recall }), createVectorBackend()],
    config: cfg.recall,
    // 召回行文本的媒体占位符验证替换（媒体管道 v2）
    mediaRender: (text) => media.renderPlaceholders(text),
  });

  // 网关接入面（热加载）：gateway.json 出现/修复/变更 ≤2s 自动生效，无需重启。
  // /v1/tools/call 常挂载——未生效时返回 503 带文案，而不是端点整体缺席。
  // auth 失败只 401，不影响 /api/* 与 stdio。
  const gatewayWatcher = createGatewayWatcher({ root: PKG_ROOT, env, envPrefix: 'MEMORY_MCP_', logger: log });

  // 内部 handler 惰性装配：首个有效配置出现时创建（auth 持有 nonce 防重放表）；
  // 之后配置变更走 auth.rotate 原地换密钥——防重放窗口不重置，业务依赖不重建。
  let gatewayInner = null;
  let gatewayAuthHandle = null;
  const ensureGatewayHandler = (config) => {
    if (!gatewayInner) {
      gatewayAuthHandle = createGatewayAuth({ secret: config.secret, serviceId: config.id || undefined });
      gatewayInner = createGatewayV1({
        auth: gatewayAuthHandle,
        memory,
        recall,
        subject,
        sessionSave,
        media,
        // chat_image_describe 主动解析需要 analyzer 的 analyzeOne（媒体管道 v3）
        mediaAnalyzer,
        // chat_voice_synthesize 主动开口说话（voice-synth 异步 worker）
        voiceSynth,
        // chat_voice_bank_list / chat_voice_bank_add（角色音色库）
        voiceBank,
        // chat_vision_sources 识图源清单（model-hub supervisor，2026-11-26 换源重识）
        modelHub,
        logger: log,
      });
    } else {
      gatewayAuthHandle.rotate({ secret: config.secret, serviceId: config.id || undefined });
    }
    return gatewayInner;
  };

  // 传输按角色非对称：资源服务纯被动（网关 → 本服务的 HTTP tool.call 是唯一
  // 通道，WS 能力已退役），接入生效就必须给齐 id/secret（tool.call 验签要）。
  // 读取器 + watcher 已保证 config 存在时字段齐全，这里不再兜装配顺序的底。
  const gateway = {
    async handle({ path, headers, rawBody }) {
      const { config, error } = gatewayWatcher.current();
      if (!config) {
        return {
          status: 503,
          body: {
            error: `网关接入未生效（${error ? `gateway.json 非法：${error}` : '未找到 gateway.json'}）。`
              + '把网关生成的 handoff/<id>.gateway.json 复制到本仓库根目录命名 gateway.json，'
              + '≤2s 自动热加载，无需重启。',
          },
        };
      }
      return ensureGatewayHandler(config).handle({ path, headers, rawBody });
    },
  };

  const initialGateway = gatewayWatcher.current();
  log(initialGateway.config
    ? `网关接入：${initialGateway.file}（id=${initialGateway.config.id} auth=${initialGateway.config.auth} `
      + `transport=${initialGateway.config.transport}；热加载 ≤2s，无需重启）`
    : `网关接入：未生效（${initialGateway.error ? `gateway.json 非法：${initialGateway.error}` : '未找到 gateway.json'}）；`
      + '放入/修复后自动热加载，无需重启；stdio MCP 照常可用');
  // LLM 提取状态直接进启动日志与 health：排障时第一眼可见 provider 是否启用。
  log(cfg.llm.enabled
    ? `LLM 提取已启用：model=${cfg.llm.model} baseUrl=${cfg.llm.baseUrl}（来源=${cfg.llm.source}）`
    : `LLM 提取未启用（来源=${cfg.llm.source}）——chat_memory_save 只落 raw，长期层退化为 record/手动巩固`);
  log(cfg.llm.vision?.enabled && cfg.llm.vision?.model
    ? `LLM 视觉已启用：model=${cfg.llm.vision.model}（多媒体记忆层解析；主模型无视觉能力也不受影响）`
    : 'LLM 视觉未启用——媒体解析保持 pending（绝不瞎编）');

  // 健康检查要能看见「降级到 JSON 兜底」「库是只读」这两件事实，而不是只写进日志。
  const info = {
    backend: store.backend,
    degraded: Boolean(store.degradedFrom),
    degradedFrom: store.degradedFrom ?? null,
    readonly: Boolean(store.readonly),
    schemaVersion: store.schemaVersion ?? null,
    archiveDir: path.relative(cfg.stateDir, raw.root) || '.',
    layersV2: cfg.layersV2,
    // LLM 提取 provider 状态（不含 apiKey）：enabled=false 时 save 只落 raw。
    llm: {
      enabled: cfg.llm.enabled,
      model: cfg.llm.model,
      baseUrl: cfg.llm.baseUrl,
      source: cfg.llm.source,
      vision: { enabled: Boolean(cfg.llm.vision?.enabled && cfg.llm.vision?.model), model: cfg.llm.vision?.model ?? null },
    },
    // 网关接入状态（动态 getter）：热加载后 configured/id 跟着变——排障时第一个
    // 要确认的「到底读没读到 gateway.json、现在生效的是哪份身份」。
    get gateway() {
      const g = gatewayWatcher.current();
      return g.config
        ? {
          configured: true,
          hotReload: true,
          file: g.file,
          auth: g.config.auth,
          transport: g.config.transport,
          id: g.config.id,
        }
        : { configured: false, hotReload: true, file: g.file, lastError: g.error };
    },
    platforms: { known: platformPolicy.known, strict: platformPolicy.strict },
    recall: {
      backends: recall.backends,
      available: recall.available(),
      crossPlatform: cfg.recall.crossPlatform,
      maxRows: cfg.recall.maxRows,
      maxChars: cfg.recall.maxChars,
    },
  };

  const api = withHttp
    ? createHttpApi({
        memory,
        slang,
        media,
        mediaAnalyzer,
        relation,
        raw,
        recall,
        profile,
        guard,
        info,
        token,
        gateway,
        host: cfg.host,
        port: cfg.port,
        layersV2: cfg.layersV2,
        logger: log,
      })
    : null;
  // 端口抢不到（被别的实例占着、或无权限）**不能**拖死 stdio：
  // DSH 的工具面与端口无关，为一条 HTTP 旁路把进程整个退出，
  // 会让 memory_* 全部消失；桥接那边本来就有熔断回落，降级即可。
  let httpError = null;
  if (api) {
    try {
      await api.listen();
      log(`回环 HTTP 已监听 http://${cfg.host}:${cfg.port}`);
    } catch (error) {
      if (!PORT_CONFLICT_CODES.has(error?.code)) throw error;
      httpError = error;
      log(`回环 HTTP 未启动（${error.code} ${cfg.host}:${cfg.port}）：已降级为 stdio-only，MCP 工具仍可用；qq-bridge 将回落本地实现`);
    }
  }
  // 统一退出路径：关 HTTP → 关 SQLite 句柄 → exit。
  // 旧实现每个模块各自 process.once('SIGINT')：stdio 模式下
  // stdin 还开着，进程不退出；SQLite 的 WAL/句柄也没有正常关闭点。
  // 摘要调度器已删除：save 的落地时机完全由网关裁决（网关关停补发 → 缓冲重试），
  // 本服务关停时无需任何补发动作。
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在关闭（http/store）…`);
    try { if (api && !httpError) await api.close(); } catch { /* 已关 */ }
    try { gatewayWatcher.stop(); } catch { /* 已关 */ }
    try { voiceSynth.stop(); } catch { /* 已关 */ }
    try { modelHub.stop(); } catch { /* 已关 */ }
    try { store.close?.(); } catch { /* 已关 */ }
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  if (stdio) {
    await serveStdio({ memory, slang, relation, raw, recall, media, mediaAnalyzer });
    log('stdio MCP 已连接');
  }
  return { cfg, store, memory, slang, media, mediaAnalyzer, relation, raw, recall, profile, subject, sessionSave, guard, llm, modelHub, api: httpError ? null : api, token, httpError, info, gatewayWatcher };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  start().catch((error) => {
    console.error('[memory-mcp] 启动失败：', error?.stack ?? error);
    process.exitCode = 1;
  });
}
