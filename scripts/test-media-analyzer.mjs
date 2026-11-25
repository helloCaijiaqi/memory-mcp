// media-analyzer 专职模型路由测试（2026-11-25 三类媒体分模型）：
//   image→vision / voice→audio(ASR) / video→video 理解，各走各的专职模型；
//   失败语义：模型未配置（*-disabled）→ 保持 pending 等配置自动补解析；
//   素材取不到（no-xxx-data）/ 模型失败（xxx-failed）→ 标 failed 不无限重试；
//   file 类型无解析面 → kind-unsupported 直接 failed。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { openStore } from '../src/store/store-api.js';
import { createMediaService } from '../src/service/media-service.js';
import { createMediaAnalyzer } from '../src/service/media-analyzer.js';
import { createLlmProvider } from '../src/llm-provider.js';
import { createMediaModelAdapter } from '../src/service/model-supervisor.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-media-anlz-'));
const SID = 'qq:private:398102999';
const mk = (c) => `ma_${c.repeat(12)}`;

async function open() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const service = createMediaService({ store, config: { mediaDir } });
  return { store, service, dir, mediaDir, close: () => store.close() };
}

/** 最小 LLM mock：/audio/transcriptions 返回转写文本；/chat/completions 返回 JSON 描述。 */
function startLlmMock({ transcript = '你好呀，最近怎么样？', visionJson = '{"desc":"测试图片","tags":["t1"]}', videoJson = '{"desc":"测试视频","tags":["v1"]}' } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(body).toString('latin1');
      if (req.url.endsWith('/audio/transcriptions')) {
        seen.push({ kind: 'asr', model: raw.includes('asr-model') ? 'asr-model' : (raw.includes('asr') ? 'asr' : '?') });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ text: transcript }));
        return;
      }
      const parsed = JSON.parse(Buffer.concat(body).toString());
      seen.push({ kind: 'chat', model: parsed.model, isVideo: JSON.stringify(parsed).includes('video_url') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(parsed?.messages).includes('video_url') ? videoJson : visionJson } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, seen, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close(),
  })));
}

/** 真实 provider 承载子配置语义（getter + 请求都走 createLlmProvider）。 */
function makeLlm(mockUrl, { vision = null, audio = null, video = null } = {}) {
  return createLlmProvider({ enabled: true, baseUrl: mockUrl, apiKey: 'sk-test', model: 'main-model', vision, audio, video });
}

test('voice 未配 audio 模型 → audio-disabled 保持 pending（等配置补解析）', async () => {
  const { service, close } = await open();
  try {
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('a'), kind: 'voice', ref: 'hello.wav' }] });
    const analyzer = createMediaAnalyzer({ service, llm: makeLlm('http://127.0.0.1:9/v1'), logger: () => {} });
    const r = await analyzer.analyzeOne(service.get(mk('a')));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'audio-disabled');
    assert.equal(service.get(mk('a')).status, 'pending', 'audio-disabled 绝不能标 failed');
  } finally {
    close();
  }
});

test('voice 配置 ASR → 转写写 desc（截断）+ textContent（全文）+ ready', async () => {
  const { service, close } = await open();
  const libDir = fs.mkdtempSync(path.join(TMP_ROOT, 'voice-lib-'));
  fs.writeFileSync(path.join(libDir, 'hello.wav'), Buffer.from('fake-wav-bytes'));
  const mock = await startLlmMock({ transcript: '这是一条超过十个字的语音转写内容用于验证全文与截断双写行为' });
  try {
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('b'), kind: 'voice', ref: 'hello.wav' }] });
    const analyzer = createMediaAnalyzer({
      service,
      llm: makeLlm(mock.url, { audio: { enabled: true, model: 'asr-model', libDir, timeoutMs: 3000 } }),
      logger: () => {},
    });
    const r = await analyzer.analyzeOne(service.get(mk('b')));
    assert.equal(r.ok, true, `应转写成功：${JSON.stringify(r)}`);
    const row = service.get(mk('b'));
    assert.equal(row.status, 'ready');
    assert.ok(row.desc.length <= 80, 'desc 截断到 maxDescChars');
    assert.ok(row.textContent.includes('语音转写'), 'textContent 保留转写全文');
    assert.equal(mock.seen.at(-1).model, 'asr-model', 'ASR 请求用专职模型');
  } finally {
    mock.close();
    close();
  }
});

test('voice 素材不存在 → no-audio-data，批处理标 failed（不无限重试）', async () => {
  const { service, close } = await open();
  const libDir = fs.mkdtempSync(path.join(TMP_ROOT, 'voice-lib2-'));
  const mock = await startLlmMock();
  try {
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('c'), kind: 'voice', ref: 'missing.wav' }] });
    const analyzer = createMediaAnalyzer({
      service,
      llm: makeLlm(mock.url, { audio: { enabled: true, model: 'asr', libDir, timeoutMs: 3000 } }),
      logger: () => {},
    });
    const r = await analyzer.analyzeOne(service.get(mk('c')));
    assert.equal(r.reason, 'no-audio-data');
    await analyzer.analyzeBatch();
    assert.equal(service.get(mk('c')).status, 'failed');
  } finally {
    mock.close();
    close();
  }
});

test('video 不进详情表（2026-11-25 裁定）；image 照常走 vision', async () => {
  const { service, mediaDir, close } = await open();
  const img = path.join(mediaDir, 'v.png');
  fs.writeFileSync(img, Buffer.from('fake-image'));
  const mock = await startLlmMock();
  try {
    await service.ensureAssets({ sessionId: SID, media: [
      { id: mk('d'), kind: 'video', ref: 'clip.mp4' },
      { id: mk('e'), kind: 'image', fileRef: img, ref: 'https://x/v.png' },
    ] });
    const analyzer = createMediaAnalyzer({
      service,
      llm: makeLlm(mock.url, { vision: { enabled: true, model: 'vl-model', timeoutMs: 3000 } }),
      logger: () => {},
    });
    // 视频/文件登记即跳过：无行、无源文件、无占位符解析面
    assert.equal(service.get(mk('d')), null, 'video 不进收藏详情表（ensureAssets 跳过）');
    const ri = await analyzer.analyzeOne(service.get(mk('e')));
    assert.equal(ri.ok, true, `image 应解析成功：${JSON.stringify(ri)}`);
    assert.equal(service.get(mk('e')).status, 'ready');
    assert.equal(mock.seen.filter((s) => s.kind === 'chat').at(-1).model, 'vl-model', 'vision 请求用专职模型');
  } finally {
    mock.close();
    close();
  }
});

test('file 类型不进详情表（2026-11-25 裁定：登记即跳过）', async () => {
  const { service, close } = await open();
  try {
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('f'), kind: 'file', ref: 'doc.pdf' }] });
    assert.equal(service.get(mk('f')), null, 'file 不进收藏详情表（ensureAssets 跳过）');
  } finally {
    close();
  }
});

test('analyzeBatch：三类混合 pending，只解各自已配置的 kind，未配置的保持 pending', async () => {
  const { service, mediaDir, store, close } = await open();
  const libDir = fs.mkdtempSync(path.join(TMP_ROOT, 'voice-lib3-'));
  fs.writeFileSync(path.join(libDir, 'a.wav'), Buffer.from('wav'));
  const img = path.join(mediaDir, 'i.png');
  fs.writeFileSync(img, Buffer.from('img'));
  const mock = await startLlmMock();
  try {
    await service.ensureAssets({ sessionId: SID, media: [
      { id: mk('1'), kind: 'image', fileRef: img, ref: 'https://x/i.png' },
      { id: mk('2'), kind: 'voice', ref: 'a.wav' },
      { id: mk('3'), kind: 'video', ref: 'c.mp4' },
    ] });
    // 只配 vision + audio，video 不配 → video 保持 pending
    const analyzer = createMediaAnalyzer({
      store,
      service,
      llm: makeLlm(mock.url, { vision: { enabled: true, model: 'vl', timeoutMs: 3000 }, audio: { enabled: true, model: 'asr', libDir, timeoutMs: 3000 } }),
      logger: () => {},
    });
    const r = await analyzer.analyzeBatch();
    assert.equal(r.ok, 2, `image+voice 应成功，实际 ${JSON.stringify(r)}`);
    assert.equal(service.get(mk('1')).status, 'ready');
    assert.equal(service.get(mk('2')).status, 'ready');
    // 视频/文件不入详情表（2026-11-25 用户裁定）：登记时直接跳过，无行可查
    assert.equal(service.get(mk('3')), null, 'video 不进收藏详情表（ensureAssets 跳过）');
    const s = analyzer.stats();
    assert.deepEqual(s.analyzers, { vision: true, audio: true, video: false });
  } finally {
    mock.close();
    close();
  }
});

test('image 走 LLM 直通（裸 provider 旧形态）→ 兜底标注 via-llm-fallback', async () => {
  const { service, mediaDir, close } = await open();
  const img = path.join(mediaDir, 'fallback.png');
  fs.writeFileSync(img, Buffer.from('img-fallback'));
  const mock = await startLlmMock({ visionJson: '{"desc":"兜底描述","tags":["fb"]}' });
  try {
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('7'), kind: 'image', fileRef: img, ref: 'https://x/f.png' }] });
    const analyzer = createMediaAnalyzer({
      service,
      llm: makeLlm(mock.url, { vision: { enabled: true, model: 'vl', timeoutMs: 3000 } }),
      logger: () => {},
    });
    const r = await analyzer.analyzeOne(service.get(mk('7')));
    assert.equal(r.ok, true);
    const row = service.get(mk('7'));
    assert.equal(row.status, 'ready');
    assert.equal(row.desc, '兜底描述');
    assert.ok(row.tags.includes('via-llm-fallback'), `应有兜底标注，实际 ${JSON.stringify(row.tags)}`);
  } finally {
    mock.close();
    close();
  }
});

test('vision-svc 模式：adapter 转发 hub.recognize，按命中源标注 via-saucenao（LLM 零调用）', async () => {
  const { service, mediaDir, close } = await open();
  const img = path.join(mediaDir, 'anime.png');
  fs.writeFileSync(img, Buffer.from('img-anime'));
  const mock = await startLlmMock();
  let recognizeCalls = 0;
  const hub = {
    get visionReady() { return true; },
    async recognize() {
      recognizeCalls += 1;
      return { ok: true, desc: '动漫画面：角色 芙莉莲，出自《葬送的芙莉莲》', tags: ['芙莉莲'], source: 'saucenao' };
    },
  };
  try {
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('8'), kind: 'image', fileRef: img, ref: 'https://x/a.png' }] });
    const adapter = createMediaModelAdapter({ llm: makeLlm(mock.url, { vision: null }), hub });
    assert.equal(adapter.visionEnabled, true, 'vision-svc ready 时即使未配 LLM vision 也视为识图能力在位');
    const analyzer = createMediaAnalyzer({ service, llm: adapter, logger: () => {} });
    const r = await analyzer.analyzeOne(service.get(mk('8')));
    assert.equal(r.ok, true);
    assert.equal(recognizeCalls, 1, '应走 vision-svc 转发');
    const row = service.get(mk('8'));
    assert.equal(row.status, 'ready');
    assert.ok(row.desc.includes('芙莉莲'));
    assert.ok(row.tags.includes('via-saucenao'), `应按命中源标注，实际 ${JSON.stringify(row.tags)}`);
    assert.equal(mock.seen.filter((s) => s.kind === 'chat' && !s.isVideo).length, 0, 'LLM vision 零调用');
  } finally {
    mock.close();
    close();
  }
});

test('vision-svc 未命中 → 落回 LLM vision 兜底，标注 via-llm-fallback', async () => {
  const { service, mediaDir, close } = await open();
  const img = path.join(mediaDir, 'miss.png');
  fs.writeFileSync(img, Buffer.from('img-miss'));
  const mock = await startLlmMock({ visionJson: '{"desc":"兜底描述","tags":["fb2"]}' });
  const hub = {
    get visionReady() { return true; },
    async recognize() { return { ok: false, reason: 'no-hit' }; },
  };
  try {
    await service.ensureAssets({ sessionId: SID, media: [{ id: mk('9'), kind: 'image', fileRef: img, ref: 'https://x/m.png' }] });
    const adapter = createMediaModelAdapter({ llm: makeLlm(mock.url, { vision: { enabled: true, model: 'vl', timeoutMs: 3000 } }), hub });
    const analyzer = createMediaAnalyzer({ service, llm: adapter, logger: () => {} });
    const r = await analyzer.analyzeOne(service.get(mk('9')));
    assert.equal(r.ok, true);
    const row = service.get(mk('9'));
    assert.equal(row.status, 'ready');
    assert.equal(row.desc, '兜底描述');
    assert.ok(row.tags.includes('via-llm-fallback'), `未命中应落回 LLM 兜底标注，实际 ${JSON.stringify(row.tags)}`);
    assert.equal(mock.seen.filter((s) => s.kind === 'chat' && !s.isVideo).length, 1, 'LLM vision 兜底应被调用一次');
  } finally {
    mock.close();
    close();
  }
});
