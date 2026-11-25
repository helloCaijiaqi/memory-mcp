#!/usr/bin/env node
// vision-svc：外部识图聚合子服务（端口 18104）。
// 聚合链：24h SHA-256 磁盘缓存 → SauceNAO/trace.moe 动漫双轨并行（相似度 >=80% 判命中）
//        → Cloudflare Workers AI 照片描述 → HuggingFace Inference → ok:false（由调用方落回 LLM 兜底）。
// 鉴权/健康/退避重启契约与 asr-svc、tts-svc 完全同构（/health 带 pid 供 supervisor 探活）。
// 可测试性：createVisionServer 工厂（cacheDir/configPath/端点均可注入），顶层 main 守卫直跑。
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SERVICE_DIR, '..', '..');
const DEFAULT_PORT = 18104;
const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, 'state', 'data', 'vision-cache');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'vision.config.json');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ANIME_SIM_THRESHOLD = 80; // 双轨 >=80% 判命中
const PROVIDERS = ['saucenao', 'traceMoe', 'cloudflare', 'huggingFace'];

export function createVisionServer({
  port = DEFAULT_PORT,
  token = '',
  cacheDir = DEFAULT_CACHE_DIR,
  configPath = DEFAULT_CONFIG_PATH,
  fetchImpl = globalThis.fetch,
} = {}) {
  // ---------- 配置（懒加载：文件 mtime 变化自动重读，注册 key 后无需重启） ----------
  let cfgCache = null;
  let cfgMtimeMs = -1;
  function getConf() {
    try {
      const mtime = fs.statSync(configPath).mtimeMs;
      if (!cfgCache || mtime !== cfgMtimeMs) {
        cfgCache = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
        cfgMtimeMs = mtime;
      }
      return cfgCache;
    } catch {
      cfgCache = {};
      cfgMtimeMs = -1;
      return cfgCache;
    }
  }
  function providerConf(name) {
    const conf = getConf();
    // 键名兼容：模板/文档用 sauceNao（驼峰），内部标识统一 saucenao（小写）
    const raw = conf[name] ?? (name === 'saucenao' ? conf.sauceNao : undefined);
    return raw && typeof raw === 'object' ? raw : null;
  }
  function providerReady(name) {
    const c = providerConf(name);
    if (!c) return false;
    if (name === 'saucenao') return Boolean(c.apiKey);
    if (name === 'traceMoe') return true; // 无 key 也可用（限流更严），有 key 提升额度
    if (name === 'cloudflare') return Boolean(c.accountId && c.apiToken);
    if (name === 'huggingFace') return Boolean(c.token);
    return false;
  }
  function providerQuota(name) {
    const c = providerConf(name);
    return Number(c?.dailyQuota || (name === 'traceMoe' ? 120 : name === 'saucenao' ? 100 : name === 'cloudflare' ? 2000 : 50));
  }

  // ---------- 配额计数（<cacheDir>/usage-YYYYMMDD.json，跨日自动重置） ----------
  function todayStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }
  const usagePath = () => path.join(cacheDir, `usage-${todayStamp()}.json`);
  function readUsage() {
    try {
      const raw = JSON.parse(fs.readFileSync(usagePath(), 'utf8'));
      return raw && typeof raw === 'object' && Number(raw.date) === Number(todayStamp()) ? raw : { date: todayStamp() };
    } catch {
      return { date: todayStamp() };
    }
  }
  function writeUsage(u) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(usagePath(), JSON.stringify(u));
    } catch (err) {
      console.error('[vision-svc] usage write failed:', err.message);
    }
  }
  const quotaAvailable = (name) => (readUsage()[name] || 0) < providerQuota(name);
  function bumpQuota(name) {
    const u = readUsage();
    u[name] = (u[name] || 0) + 1;
    writeUsage(u);
  }

  // ---------- 缓存（<sha256>.json，24h TTL；坏档静默删档重建） ----------
  const cachePath = (hash) => path.join(cacheDir, `${hash}.json`);
  function readCache(hash) {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath(hash), 'utf8'));
      if (raw && raw.desc && Number(raw.expiresAt) > Date.now()) return raw;
      fs.rmSync(cachePath(hash), { force: true });
      return null;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try { fs.rmSync(cachePath(hash), { force: true }); } catch { /* 忽略 */ }
      }
      return null;
    }
  }
  function writeCache(hash, desc, tags, source) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachePath(hash), JSON.stringify({ desc, tags, source, expiresAt: Date.now() + CACHE_TTL_MS }));
    } catch (err) {
      console.error('[vision-svc] cache write failed:', err.message);
    }
  }

  // ---------- HTTP 工具 ----------
  function multipartBody(field, filename, mime, buffer) {
    const boundary = `----memhubvision${Date.now().toString(16)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return {
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: Buffer.concat([head, buffer, tail]),
    };
  }
  async function httpJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 10000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = { raw: String(text).slice(0, 500) }; }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- 外部识图源（端点可在 vision.config.json 覆盖，测试注入 mock） ----------
  async function sauceNaoSearch(buf, mime) {
    const conf = providerConf('saucenao');
    const mp = multipartBody('file', 'image.png', mime, buf);
    const base = conf?.searchUrl || 'https://saucenao.com/search.php';
    const url = `${base}?db=999&output_type=2&numres=3&api_key=${encodeURIComponent(conf.apiKey || '')}`;
    const { status, json } = await httpJson(url, {
      method: 'POST',
      headers: { 'content-type': mp.contentType },
      body: mp.body,
      timeoutMs: 10000,
    });
    if (status !== 200) throw new Error(`saucenao http ${status}`);
    const results = Array.isArray(json?.results) ? json.results : [];
    let best = null;
    for (const r of results) {
      const sim = Number(r?.header?.similarity || 0);
      if (!best || sim > best.sim) best = { sim, data: r?.data || {} };
    }
    if (!best) throw new Error('saucenao empty results');
    const d = best.data;
    const chars = Array.isArray(d.characters) ? d.characters.filter(Boolean) : [];
    const title = d.title || d.material || d.source || d.eng_name || '';
    const artist = d.member_name ? `，画师 ${d.member_name}` : '';
    const charPart = chars.length ? `角色 ${chars.slice(0, 3).join('、')}` : '';
    const desc = `动漫画面：${[charPart, title ? `出自《${title}》` : ''].filter(Boolean).join('')}${artist}（SauceNAO 相似度 ${best.sim.toFixed(1)}%）`.trim();
    return { sim: best.sim, desc, tags: chars.slice(0, 3) };
  }

  async function traceMoeSearch(buf, mime) {
    const conf = providerConf('traceMoe');
    const mp = multipartBody('image', 'image.png', mime, buf);
    const base = conf?.searchUrl || 'https://api.trace.moe/search';
    const headers = { 'content-type': mp.contentType };
    if (conf?.apiKey) headers['x-trace-key'] = conf.apiKey;
    const { status, json } = await httpJson(`${base}?anilistInfo=1`, { method: 'POST', headers, body: mp.body, timeoutMs: 10000 });
    if (status !== 200) throw new Error(`trace.moe http ${status}`);
    const results = Array.isArray(json?.result) ? json.result : [];
    let best = null;
    for (const r of results) {
      const sim = Number(r?.similarity || 0) * 100;
      if (!best || sim > best.sim) best = { sim, a: r?.anilist || {}, episode: r?.episode };
    }
    if (!best) throw new Error('trace.moe empty results');
    const t = best.a.title || {};
    const title = t.native || t.romaji || t.english || '';
    const chars = (Array.isArray(best.a.characters) ? best.a.characters : [])
      .map((c) => c?.name?.full)
      .filter(Boolean)
      .slice(0, 3);
    const charPart = chars.length ? `角色 ${chars.join('、')}` : '';
    const epPart = best.episode ? `第 ${best.episode} 话` : '';
    const desc = `动漫画面：${[charPart, title ? `出自《${title}》` : '', epPart].filter(Boolean).join('')}（trace.moe 相似度 ${best.sim.toFixed(1)}%）`.trim();
    return { sim: best.sim, desc, tags: chars };
  }

  async function cloudflareDescribe(buf, mime) {
    const conf = providerConf('cloudflare');
    // 2026-11-26：llava 已下架（7000 No route），迁移到 mistral-small-3.1（实测 200 中文描述）。
    // 请求体用标准 messages 架构（image_url data URI），response 双形态兼容：
    //   chat 模型（mistral/llama-3.2）= result.choices[0].message.content；遗留 llava = result.description。
    const model = conf?.model || '@cf/mistralai/mistral-small-3.1-24b-instruct';
    const url = conf?.runUrl || `https://api.cloudflare.com/client/v4/accounts/${conf?.accountId ?? ''}/ai/run/${model}`;
    const dataUri = `data:${mime || 'image/png'};base64,${buf.toString('base64')}`;
    const { status, json } = await httpJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conf?.apiToken ?? ''}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [
          { type: 'text', text: '用一句简短的中文描述这张图片。' },
          { type: 'image_url', image_url: { url: dataUri } },
        ] }],
        max_tokens: 200,
      }),
      timeoutMs: 15000,
    });
    if (status !== 200 || json?.success !== true) throw new Error(`cloudflare http ${status}`);
    const desc = String(json?.result?.choices?.[0]?.message?.content || json?.result?.description || '').trim();
    if (!desc) throw new Error('cloudflare empty description');
    return { desc, tags: ['photo'] };
  }

  async function huggingFaceDescribe(buf, mime) {
    const conf = providerConf('huggingFace');
    const model = conf?.model || 'Salesforce/blip-image-captioning-large';
    const url = conf?.runUrl || conf?.url || `https://router.huggingface.co/hf-inference/models/${model}`;
    const { status, json } = await httpJson(url, {
      method: 'POST',
      headers: { 'content-type': mime, authorization: `Bearer ${conf?.token ?? ''}` },
      body: buf,
      timeoutMs: 15000,
    });
    if (status !== 200) throw new Error(`huggingface http ${status}`);
    const text = Array.isArray(json) ? json[0]?.generated_text : json?.generated_text;
    const desc = String(text || '').trim();
    if (!desc) throw new Error('huggingface empty caption');
    return { desc, tags: ['photo'] };
  }

  // ---------- 聚合链 ----------
  async function recognize(imageBase64, mime = 'image/png') {
    const buf = Buffer.from(String(imageBase64 || ''), 'base64');
    if (!buf.length) return { ok: false, reason: 'empty-image' };
    const hash = createHash('sha256').update(buf).digest('hex');

    const cached = readCache(hash);
    if (cached) {
      return { ok: true, desc: cached.desc, tags: cached.tags || [], source: cached.source, cached: true, hash };
    }

    // 动漫双轨并行（配额可用才烧请求）
    const tasks = [];
    for (const [name, fn] of [['saucenao', sauceNaoSearch], ['traceMoe', traceMoeSearch]]) {
      if (providerReady(name) && quotaAvailable(name)) {
        tasks.push(
          fn(buf, mime)
            .then((r) => ({ name, ...r }))
            .catch((err) => {
              console.error(`[vision-svc] ${name} failed:`, err.message);
              return null;
            })
        );
      } else {
        tasks.push(Promise.resolve(null));
      }
    }
    const [sauceRes, traceRes] = await Promise.all(tasks);
    for (const r of [sauceRes, traceRes]) if (r) bumpQuota(r.name);

    const hits = [sauceRes, traceRes].filter((r) => r && r.sim >= ANIME_SIM_THRESHOLD).sort((a, b) => b.sim - a.sim);
    if (hits.length) {
      const hit = hits[0];
      writeCache(hash, hit.desc, hit.tags, hit.name);
      return { ok: true, desc: hit.desc, tags: hit.tags, source: hit.name, cached: false, hash };
    }

    // 照片域：Cloudflare → HF，逐级降级
    for (const name of ['cloudflare', 'huggingFace']) {
      if (!providerReady(name) || !quotaAvailable(name)) continue;
      try {
        const r = name === 'cloudflare' ? await cloudflareDescribe(buf, mime) : await huggingFaceDescribe(buf, mime);
        bumpQuota(name);
        writeCache(hash, r.desc, r.tags, name);
        return { ok: true, desc: r.desc, tags: r.tags, source: name, cached: false, hash };
      } catch (err) {
        console.error(`[vision-svc] ${name} failed:`, err.message);
      }
    }

    return { ok: false, reason: 'no-hit', hash };
  }

  // ---------- HTTP 骨架（与 asr-svc 同构） ----------
  const json = (res, code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const authorized = (req) => !token || req.headers.authorization === `Bearer ${token}`;
  function readBody(req, limitBytes = 64 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limitBytes) {
          req.destroy();
          reject(new Error('body too large'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        engine: 'vision-agg',
        ready: true,
        pid: process.pid,
        keys: Object.fromEntries(PROVIDERS.map((p) => [p, providerReady(p)])),
      });
    }
    if (url.pathname === '/recognize' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        if (!body?.imageBase64) return json(res, 400, { ok: false, error: 'imageBase64 required' });
        const out = await recognize(body.imageBase64, String(body.mime || 'image/png'));
        return json(res, 200, out);
      } catch (err) {
        console.error('[vision-svc] recognize error:', err.message);
        return json(res, 500, { ok: false, error: err.message });
      }
    }
    json(res, 404, { ok: false, error: 'not found' });
  });

  return {
    server,
    port,
    recognize,
    keys: () => Object.fromEntries(PROVIDERS.map((p) => [p, providerReady(p)])),
    usage: () => readUsage(),
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          console.log(`[vision-svc] listening on 127.0.0.1:${port}`);
          resolve();
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------- main 守卫：直跑时才 listen / 退出（import 不产生副作用） ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const svc = createVisionServer({ port: Number(process.env.VISION_PORT || DEFAULT_PORT), token: String(process.env.MEMHUB_TOKEN || '') });
  svc.listen().catch((err) => {
    console.error('[vision-svc] server error:', err.message);
    process.exit(1);
  });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
