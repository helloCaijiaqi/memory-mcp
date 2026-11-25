// tts-svc：GPT-SoVITS 音色克隆适配器子服务（memory-mcp 专用模型服务之一）
// 由 model-supervisor spawn；仅绑 127.0.0.1。GPT-SoVITS 本体（python 集成包）按需
// spawn：首个合成请求拉起 api_v2.py（CPU），空闲 10 分钟自动退出省内存（峰值 ~2.3GB）。
// 协议：
//   GET  /health     → { ok, sovitsUp, spawning }
//   POST /synthesize → body { text, refPath, promptText, promptLang? } → { ok, wavBase64, elapsedMs } | { ok:false, error }
// 鉴权：Bearer token（env MEMHUB_TOKEN）。
// 内存水位保护：可用内存 < 15% 时拒绝合成（503 E_BUSY）——8GB 机器上 SoVITS 峰值 2.3GB。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TTS_PORT || 18103);
const TOKEN = String(process.env.MEMHUB_TOKEN || '');

// 路径配置：subprocesses/tts-svc/tts.config.json（GPT-SoVITS 集成包解压后按实际布局校准）
function loadTtsConfig() {
  const defaults = {
    gsvDir: 'C:/memory-mcp/models/gpt-sovits',
    runtimePython: 'runtime/python.exe',
    apiScript: 'api_v2.py',
    // v2pro 包的 api_v2.py 只收 -c 配置文件（模型路径/设备在 yaml 里）
    ttsYaml: 'GPT_SoVITS/configs/memhub-tts.yaml',
    device: 'cpu',
    apiPort: 9880,
    idleExitMs: 10 * 60 * 1000,
    memFreeRatio: 0.15,
  };
  try {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, 'tts.config.json'), 'utf8'));
    return { ...defaults, ...file };
  } catch {
    return defaults;
  }
}
const ttsCfg = loadTtsConfig();

let sovitsProc = null;
let sovitsUp = false;
let spawning = false;
let lastRequestAt = 0;
let idleTimer = null;

function spawnSovits() {
  const base = path.resolve(ttsCfg.gsvDir);
  const python = path.join(base, ttsCfg.runtimePython);
  const apiScript = path.join(base, ttsCfg.apiScript);
  if (!fs.existsSync(python) || !fs.existsSync(apiScript)) {
    throw new Error(`GPT-SoVITS 集成包不完整：缺 ${python} 或 ${apiScript}`);
  }
  const args = [
    apiScript,
    '-c', path.join(base, ttsCfg.ttsYaml),
    '-a', '127.0.0.1',
    '-p', String(ttsCfg.apiPort),
  ];
  const proc = spawn(python, args, { cwd: base, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => console.log(`[tts-svc:gsv] ${String(d).trim().slice(0, 300)}`));
  proc.stderr.on('data', (d) => console.error(`[tts-svc:gsv] ${String(d).trim().slice(0, 300)}`));
  proc.on('exit', (code) => {
    console.log(`[tts-svc:gsv] exited code=${code}`);
    sovitsProc = null;
    sovitsUp = false;
  });
  sovitsProc = proc;
}

function stopSovits(reason) {
  if (sovitsProc) {
    console.log(`[tts-svc] 空闲退出（${reason}）`);
    try { sovitsProc.kill(); } catch { /* 已退出 */ }
  }
  sovitsProc = null;
  sovitsUp = false;
}

function scheduleIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stopSovits(`空闲 ${ttsCfg.idleExitMs / 60000} 分钟`), ttsCfg.idleExitMs);
  idleTimer.unref?.();
}

async function waitSovitsReady(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${ttsCfg.apiPort}/`, { method: 'GET', signal: AbortSignal.timeout(3000) });
      // api_v2 GET 返回异常 JSON 也算端口起来了
      if (res.status === 200 || res.status === 422 || res.status === 404) return true;
    } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function sovitsTts({ text, refPath, promptText, promptLang = 'zh' }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      // POST /tts 的 Pydantic TTS_Request 字段名（api_v2.py TTS_Request）
      ref_audio_path: refPath,
      prompt_text: promptText ?? '',
      prompt_lang: promptLang,
      text,
      text_lang: 'zh',
      media_type: 'wav',
    });
    const req = http.request({
      host: '127.0.0.1',
      port: ttsCfg.apiPort,
      path: '/tts', // api_v2 端点：POST /tts（GET /tts 走 query 参数，统一用 POST JSON）
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 180000, // CPU 合成 25-70s/句，留足余量
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          reject(new Error(`SoVITS ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
          return;
        }
        resolve(buf);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('SoVITS 合成超时')); });
    req.on('error', reject);
    req.end(body);
  });
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!TOKEN) return true;
  return String(req.headers.authorization || '') === `Bearer ${TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const json = (code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (url.pathname === '/health') {
    return json(200, { ok: true, sovitsUp, spawning, gsvDir: ttsCfg.gsvDir, pid: process.pid });
  }
  if (url.pathname === '/synthesize' && req.method === 'POST') {
    if (!authorized(req)) return json(401, { ok: false, error: 'unauthorized' });
    // 内存水位保护
    const freeRatio = os.freemem() / os.totalmem();
    if (freeRatio < ttsCfg.memFreeRatio) {
      return json(503, { ok: false, error: 'E_BUSY 内存水位过高，合成暂不可用（稍后重试）' });
    }
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const text = String(body.text ?? '').trim();
      const refPath = String(body.refPath ?? '');
      if (!text) return json(400, { ok: false, error: 'text required' });
      if (!refPath || !fs.existsSync(refPath)) return json(400, { ok: false, error: '参考音频不存在' });
      lastRequestAt = Date.now();
      // 按需 spawn + 等待就绪（冷启动 CPU 需 30-60s）
      if (!sovitsUp) {
        spawning = true;
        try {
          if (!sovitsProc) spawnSovits();
          sovitsUp = await waitSovitsReady();
          if (!sovitsUp) return json(503, { ok: false, error: 'SoVITS 冷启动超时' });
        } finally {
          spawning = false;
        }
      }
      const t0 = Date.now();
      const wav = await sovitsTts({
        text,
        refPath,
        promptText: String(body.promptText ?? ''),
        promptLang: String(body.promptLang ?? 'zh'),
      });
      scheduleIdleExit();
      return json(200, { ok: true, wavBase64: wav.toString('base64'), elapsedMs: Date.now() - t0 });
    } catch (err) {
      return json(500, { ok: false, error: String(err.message || err) });
    }
  }
  return json(404, { ok: false, error: 'not-found' });
});

server.on('error', (err) => {
  console.error(`[tts-svc] listen error: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[tts-svc] listening 127.0.0.1:${PORT}（GPT-SoVITS 按需 spawn：${ttsCfg.gsvDir}）`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    stopSovits('服务退出');
    server.close(() => process.exit(0));
  });
}
