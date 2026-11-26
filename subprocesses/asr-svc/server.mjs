// asr-svc：SenseVoice int8 本地语音识别子服务（memory-mcp 专用模型服务之一）
// 由 src/service/model-supervisor.js spawn 监管；仅绑 127.0.0.1。
// 协议：
//   GET  /health     → { ok, engine, ready }
//   POST /transcribe → body { audioBase64, mime?, filename?, language? } → { ok, text, elapsedMs }
// 鉴权：Bearer token（env MEMHUB_TOKEN，由 supervisor 注入）。
// 纪律：识别失败返回 { ok:false, error }，绝不返回猜测文本（绝不瞎编纪律）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sherpaOnnx = require('sherpa-onnx-node');
const { isSilk, decode: silkDecode } = require('silk-wasm');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ASR_PORT || 18102);
const TOKEN = String(process.env.MEMHUB_TOKEN || '');
const MODEL_DIR = process.env.ASR_MODEL_DIR
  || path.resolve(__dirname, '../../models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
const NUM_THREADS = Math.max(1, Math.min(2, Number(process.env.ASR_THREADS || 2))); // 4C8T 机器留核给主进程

function createRecognizer() {
  const model = path.join(MODEL_DIR, 'model.int8.onnx');
  const tokens = path.join(MODEL_DIR, 'tokens.txt');
  if (!fs.existsSync(model) || !fs.existsSync(tokens)) {
    throw new Error(`ASR model files missing under ${MODEL_DIR}`);
  }
  return new sherpaOnnx.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model,
        language: '',
        useInverseTextNormalization: 1,
      },
      tokens,
      numThreads: NUM_THREADS,
      debug: 0,
      provider: 'cpu',
    },
  });
}

let recognizer = null;
try {
  recognizer = createRecognizer();
  console.log(`[asr-svc] model loaded: ${MODEL_DIR}`);
} catch (err) {
  console.error(`[asr-svc] model load failed: ${err.message}`);
}

// CPU 推理串行队列：4C8T 机器上并发推理会挤占 memory/bridge 的核
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ffmpeg：非 wav 音频（QQ 语音常见 aac/amr/m4a/mp3）先转 16k 单声道 wav。
// FFMPEG_PATH 环境变量优先，其次 PATH；找不到 ffmpeg 时仅支持 wav 输入。
function findFfmpeg() {
  const custom = process.env.FFMPEG_PATH;
  if (custom && fs.existsSync(custom)) return custom;
  const local = path.resolve(__dirname, '../../models/tools/ffmpeg/bin/ffmpeg.exe');
  if (fs.existsSync(local)) return local;
  return 'ffmpeg'; // 交给 PATH
}

let ffmpegBin = null;
try { ffmpegBin = findFfmpeg(); } catch { ffmpegBin = null; }

async function transcodeToWav(srcPath, mime) {
  const isWav = /\.wav$/i.test(srcPath) || String(mime || '').includes('wav');
  if (isWav) return srcPath;
  // QQ 语音实为 SILK V3（文件常带 .amr 后缀的假名），ffmpeg 不支持 → silk-wasm 解码
  // 成 PCM（24kHz mono s16）后补 WAV 头（sherpa readWave 带重采样，22050→16k 已验证）。
  const head = Buffer.alloc(8);
  const fd = fs.openSync(srcPath, 'r');
  try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
  if (head.subarray(1, 9).toString('ascii').includes('#!SILK') || isSilk(head)) {
    const silk = fs.readFileSync(srcPath);
    const { data } = await silkDecode(silk, 24000);   // Uint8Array PCM s16le mono 24kHz
    const out = `${srcPath}.24k.wav`;
    const pcm = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(out, Buffer.concat([header, pcm]));
    return out;
  }
  const out = `${srcPath}.16k.wav`;
  const { execFileSync } = require('node:child_process');
  execFileSync(ffmpegBin, [
    '-y', '-loglevel', 'error', '-i', srcPath,
    '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', out,
  ], { timeout: 30000 });
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('ffmpeg 转码失败（输出为空，格式可能不支持如 silk）');
  return out;
}

async function transcribeWav(base64, mime) {
  const tmp = path.join(os.tmpdir(), `memhub-asr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, Buffer.from(base64, 'base64'));
  let wavPath = tmp;
  try {
    wavPath = await transcodeToWav(tmp, mime);
    const { samples, sampleRate } = sherpaOnnx.readWave(wavPath);
    if (!samples || samples.length === 0) throw new Error('empty audio samples');
    const t0 = Date.now();
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples }); // 本版 sherpa-onnx-node 为对象参数
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    return { text: String(result?.text ?? '').trim(), elapsedMs: Date.now() - t0 };
  } finally {
    fs.rmSync(tmp, { force: true });
    if (wavPath !== tmp) fs.rmSync(wavPath, { force: true });
  }
}

function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!TOKEN) return true; // supervisor 未注入 token 时仅在 127.0.0.1 绑定下裸跑
  return String(req.headers.authorization || '') === `Bearer ${TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const json = (code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (url.pathname === '/health') {
    return json(200, { ok: true, engine: 'sensevoice-int8', ready: Boolean(recognizer), pid: process.pid });
  }
  if (url.pathname === '/transcribe' && req.method === 'POST') {
    if (!authorized(req)) return json(401, { ok: false, error: 'unauthorized' });
    if (!recognizer) return json(503, { ok: false, error: 'model-not-loaded' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const audioBase64 = String(body.audioBase64 || '');
      if (!audioBase64) return json(400, { ok: false, error: 'audioBase64 required' });
      const out = await enqueue(() => transcribeWav(audioBase64, body.mime));
      return json(200, { ok: true, text: out.text, elapsedMs: out.elapsedMs });
    } catch (err) {
      return json(500, { ok: false, error: String(err.message || err) });
    }
  }
  return json(404, { ok: false, error: 'not-found' });
});

server.on('error', (err) => {
  // 端口被占等不可恢复错误：直接退出，交给 supervisor 的重启上限处理
  console.error(`[asr-svc] listen error: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[asr-svc] listening 127.0.0.1:${PORT}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => server.close(() => process.exit(0)));
}
