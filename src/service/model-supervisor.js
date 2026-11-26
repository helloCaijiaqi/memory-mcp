// model-supervisor：专用模型子进程监管（memory 主进程侧）
// 职责：
//   1) spawn subprocesses/asr-svc、subprocesses/tts-svc 子进程（仅绑 127.0.0.1），随 memory 生命周期启停；
//   2) 健康探活 + 崩溃指数退避重启（healthy 后重置退避）；
//   3) 对外提供与 llmProvider 同形状的媒体 adapter（注入 media-analyzer，替代其直接依赖 llm），
//      语音走本地 asr-svc，图片暂走 LLM vision 兜底（阶段二由 vision-svc 外部聚合替换）。
// 依赖纪律：主仓库零新增 npm 依赖（node:child_process / node:http）。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function httpGetJson(url, timeoutMs = 3000, token = '') {
  return new Promise((resolve) => {
    const req = http.get(url, {
      timeout: timeoutMs,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function httpPostJson(url, body, timeoutMs = 60000, token = '') {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        // 子服务 Bearer 鉴权（token 由 supervisor 生成并注入子进程 env）
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(payload);
  });
}

export function createModelSupervisor({ config = {}, logger = () => {} } = {}) {
  const cfg = {
    // 阶段一：仅 asr（本地推理）；tts 由 GPT-SoVITS 集成包就绪后启用。
    asr: { enabled: config.asr?.enabled !== false, port: Number(config.asr?.port || 18102) },
    tts: { enabled: config.tts?.enabled === true, port: Number(config.tts?.port || 18103) },
    token: config.token || crypto.randomBytes(24).toString('hex'),
    // 图片识别模式：'llm-fallback'（阶段一）| 'vision-svc'（阶段二）
    visionMode: config.visionMode || 'llm-fallback',
    // 阶段二：vision-svc 外部识图聚合（visionMode='vision-svc' 时 spawn，端口 18104）
    vision: {
      enabled: (config.visionMode || 'llm-fallback') === 'vision-svc',
      port: Number(config.vision?.port || config.visionPort || 18104),
    },
  };

  const children = new Map(); // name → { child, fails, backoffMs, timer, ready }
  let stopped = false;
  let reapHooked = false;

  function spawnService(name, script, env, port) {
    if (stopped) return;
    const state = children.get(name) ?? { fails: 0, backoffMs: 1000, ready: false, timer: null };
    // stdio：stdin/outer ignore + stderr pipe（子服务报错可见）。使用 start() 的
    // 测试已显式禁 hub（MEMORY_MCP_MODEL_HUB_ASR=0），pipe 不会再挂住测试退出。
    const child = spawn(process.execPath, [script], {
      cwd: REPO_ROOT,
      env: { ...process.env, MEMHUB_TOKEN: cfg.token, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (d) => {
      const line = String(d).trim();
      if (line) logger(`[model-hub:${name}] ${line}`);
    });
    child.unref();
    // 父进程退出（含测试进程自然退出）时收割子进程，不留孤儿
    if (!reapHooked) {
      reapHooked = true;
      process.once('exit', () => {
        for (const [, s] of children) {
          try { s.child?.kill(); } catch { /* 已退出 */ }
        }
      });
    }
    child.on('exit', (code, signal) => {
      state.ready = false;
      if (stopped) return;
      // 连续失败上限：端口被占等不可恢复场景无限重启会烧 CPU（实测教训）
      state.fails += 1;
      if (state.fails > 5) {
        logger(`[model-hub] ${name} 连续 ${state.fails} 次退出（最后 code=${code}），放弃重启——检查端口 ${port} 占用/模型文件`);
        children.delete(name);
        return;
      }
      const delay = state.backoffMs;
      state.backoffMs = Math.min(state.backoffMs * 2, 60000);
      logger(`[model-hub] ${name} exited (code=${code} signal=${signal})，${delay}ms 后重启`);
      state.timer = setTimeout(() => spawnService(name, script, env, port), delay);
    });
    state.child = child;
    children.set(name, state);
    // 启动后探活；成功 → ready + 重置退避与失败计数
    const probe = (left) => {
      if (stopped || state.child !== child) return;
      httpGetJson(`http://127.0.0.1:${port}/health`).then((h) => {
        // pid 校验：孤儿实例（父进程被 SIGKILL 后仍占端口的旧子服务）health 也返回
        // ok——必须确认响应者就是自己 spawn 的 child，否则转写/合成都打到孤儿上
        // 被鉴权拒绝（实测教训：401 假 ready）。
        if (h?.ok && Number(h.pid) === child.pid) {
          state.ready = true;
          state.fails = 0;
          state.backoffMs = 1000;
          logger(`[model-hub] ${name} ready (port ${port}, pid ${h.pid})`);
        } else if (left > 0) {
          setTimeout(() => probe(left - 1), 1500);
        } else if (h?.ok && Number(h.pid) !== child.pid) {
          logger(`[model-hub] ${name} 端口 ${port} 被孤儿实例占用（pid ${h.pid}≠${child.pid}），本实例不 ready`);
        }
      });
    };
    setTimeout(() => probe(12), 800);
  }

  function start() {
    stopped = false;
    if (cfg.asr.enabled) {
      spawnService('asr', path.join(REPO_ROOT, 'subprocesses/asr-svc/server.mjs'), { ASR_PORT: String(cfg.asr.port) }, cfg.asr.port);
    }
    if (cfg.tts.enabled) {
      spawnService('tts', path.join(REPO_ROOT, 'subprocesses/tts-svc/server.mjs'), { TTS_PORT: String(cfg.tts.port) }, cfg.tts.port);
    }
    if (cfg.vision.enabled) {
      spawnService('vision', path.join(REPO_ROOT, 'subprocesses/vision-svc/server.mjs'), { VISION_PORT: String(cfg.vision.port) }, cfg.vision.port);
    }
  }

  function stop() {
    stopped = true;
    for (const [name, state] of children) {
      clearTimeout(state.timer);
      try { state.child?.kill(); } catch { /* 已退出 */ }
    }
    children.clear();
  }

  const asrReady = () => cfg.asr.enabled && children.get('asr')?.ready === true;
  const ttsReady = () => cfg.tts.enabled && children.get('tts')?.ready === true;
  const visionReady = () => cfg.vision.enabled && children.get('vision')?.ready === true;
  return {
    start,
    stop,
    config: cfg,
    get asrReady() { return asrReady(); },
    get ttsReady() { return ttsReady(); },
    get ttsEnabled() { return cfg.tts.enabled; },
    get visionReady() { return visionReady(); },
    /** 转写（audioBase64 → text|null），失败返回 null（绝不瞎编纪律） */
    async transcribe({ audioBase64, mime = 'audio/wav', filename = 'audio.wav' } = {}) {
      if (!asrReady() || !audioBase64) return null;
      const out = await httpPostJson(`http://127.0.0.1:${cfg.asr.port}/transcribe`,
        { audioBase64, mime, filename }, 60000, cfg.token);
      const text = String(out?.text ?? '').trim();
      if (out?.ok && text) return text;
      logger(`[model-hub] transcribe 失败：${out === null ? 'asr-svc 无响应/超时' : `ok=${out?.ok} error=${out?.error ?? '文本为空'}`}`);
      return null;
    },
    /** 克隆合成（text+参考音频 → wavBase64|null），tts-svc 内部按需拉起 GPT-SoVITS */
    async synthesize({ text, refPath, promptText, promptLang = 'zh' } = {}) {
      if (!cfg.tts.enabled || !text || !refPath) return { ok: false, error: 'tts-not-ready' };
      const out = await httpPostJson(`http://127.0.0.1:${cfg.tts.port}/synthesize`,
        { text, refPath, promptText, promptLang }, 240000, cfg.token);
      return out ?? { ok: false, error: 'tts-svc 无响应' };
    },
    /** 外部识图聚合（imageBase64 → {ok,desc,tags,source,cached}|{ok:false,reason}），未命中/失败返回 ok:false 由 adapter 落回 LLM 兜底；
     *  opts.source 强制仅用该源（失败不降级）、opts.refresh 跳过缓存读（换源重识语义，2026-11-26） */
    async recognize({ imageBase64, mime = 'image/png', source, refresh } = {}) {
      if (!visionReady() || !imageBase64) return { ok: false, reason: 'vision-svc-not-ready' };
      const out = await httpPostJson(`http://127.0.0.1:${cfg.vision.port}/recognize`,
        { imageBase64, mime, ...(source ? { source: String(source) } : {}), ...(refresh ? { refresh: true } : {}) }, 60000, cfg.token);
      if (out?.ok) return out;
      logger(`[model-hub] recognize 失败：${out === null ? 'vision-svc 无响应/超时' : `ok=${out?.ok} reason=${out?.reason ?? out?.error ?? ''}`}`);
      return out ?? { ok: false, reason: 'vision-svc-unavailable' };
    },
    /** 可用识图源清单（name/ready/quotaRemaining），vision-svc 未就绪返回 null */
    async visionSources() {
      if (!visionReady()) return null;
      const out = await httpGetJson(`http://127.0.0.1:${cfg.vision.port}/sources`, cfg.token);
      return out?.ok ? (out.sources ?? null) : null;
    },
    status() {
      return {
        asr: { enabled: cfg.asr.enabled, ready: asrReady(), port: cfg.asr.port },
        tts: { enabled: cfg.tts.enabled, ready: ttsReady(), port: cfg.tts.port },
        vision: { enabled: cfg.vision.enabled, ready: visionReady(), port: cfg.vision.port, mode: cfg.visionMode },
      };
    },
  };
}

/**
 * 媒体 adapter：与 llmProvider 消费面同形状（analyzer 三处调用点零改动）。
 * - voice：本地 asr-svc（ready 才 enabled，未就绪保持 pending 等重试）
 * - image：visionMode='vision-svc' 时转发 vision-svc 外部聚合，未命中/不可用落回 LLM vision 兜底
 * - video：退役（videoEnabled=false，资产保持 pending）
 */
const VISION_SOURCE_ALIASES = { huggingFace: 'huggingface' }; // traceMoe 已退役（2026-11-26）
export function createMediaModelAdapter({ llm, hub } = {}) {
  return {
    get enabled() { return Boolean(llm?.enabled); },
    // llm vision 可用或 vision-svc 就绪都视为识图能力在位（analyzer L134 门控）
    get visionEnabled() { return Boolean(llm?.visionEnabled) || hub?.visionReady === true; },
    get audioEnabled() { return hub?.asrReady === true; },
    get videoEnabled() { return false; }, // video 专职块退役：video 资产保持 pending
    // analyzer 读取 libDir 定位音频文件
    config: llm?.config ?? {},
    /** 主文本模型直通（analyzer keep/skip 语义筛选与摘要共用主 LLM，非识图） */
    async complete(args = {}) {
      return llm?.complete?.(args) ?? null;
    },
    /**
     * 图片识别：vision-svc 就绪优先转发（返回 {text, source}，source=实际命中源）；
     * 未命中/不可用/未配置时落回 llm.vision（source='llm-fallback'）。返回 {text, source}|null。
     * args.source 指定时强制仅用该源（refresh 跳缓存）：失败**不落回** LLM 兜底，
     * 返回 null 由上层报错——换源重试由调用方语义决定（2026-11-26）。
     */
    async vision(args = {}) {
      if (args?.source && hub?.visionReady && args?.imageBase64) {
        const out = await hub.recognize({
          imageBase64: args.imageBase64,
          mime: args.mime,
          source: String(args.source),
          refresh: args.refresh === true,
        });
        if (!out?.ok) return null;
        const source = VISION_SOURCE_ALIASES[out.source] ?? String(out.source || args.source);
        return { text: JSON.stringify({ desc: out.desc, tags: out.tags }), source };
      }
      if (hub?.visionReady && args?.imageBase64) {
        const out = await hub.recognize({ imageBase64: args.imageBase64, mime: args.mime });
        if (out?.ok) {
          const source = VISION_SOURCE_ALIASES[out.source] ?? String(out.source || 'vision-svc');
          return { text: JSON.stringify({ desc: out.desc, tags: out.tags }), source };
        }
      }
      const text = await llm?.vision?.(args) ?? null;
      return text ? { text, source: 'llm-fallback' } : null;
    },
    async transcribe(args = {}) {
      return hub?.transcribe?.(args) ?? null;
    },
  };
}
