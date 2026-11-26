// test-vision-svc：外部识图聚合子服务测试。
// mock 三个外部识图源（真 HTTP server）+ 直接调 createVisionServer 工厂（端口 0 随机），
// 覆盖：健康检查 / saucenao 动漫命中与缓存 / 未命中走 Cloudflare / 全败降级 / 配额跳过 /
//       坏缓存自愈 / Bearer 鉴权 / 空图入参 / 强制单源 source / refresh 跳缓存 /
//       换源覆盖缓存 / GET /sources。
// trace.moe 已剔除（2026-11-26 用户裁定：日语作品数据库，不符中文识图场景）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { after } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createVisionServer } from '../subprocesses/vision-svc/server.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-svc-test-'));
const CACHE_DIR = path.join(TMP, 'cache');
const CONFIG_PATH = path.join(TMP, 'vision.config.json');

// ---------- mock 外部识图源（mode 可切换：hit / low / fail） ----------
const mockCalls = { saucenao: 0, cf: 0, hf: 0 };
let mockMode = 'hit';
const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const p = new URL(req.url, 'http://x').pathname;
    res.setHeader('content-type', 'application/json');
    const reply = (code, obj) => { res.writeHead(code); res.end(JSON.stringify(obj)); };
    if (p === '/saucenao') {
      mockCalls.saucenao += 1;
      if (mockMode === 'fail') return reply(500, { error: 'boom' });
      return reply(200, {
        results: [{ header: { similarity: mockMode === 'low' ? 30 : 91.5 }, data: { title: '葬送的芙莉莲', characters: ['芙莉莲', '费伦'], member_name: '山田钟人' } }],
      });
    }
    if (p === '/cf') {
      mockCalls.cf += 1;
      if (mockMode === 'fail') return reply(200, { success: false, errors: [{ message: 'quota' }] });
      return reply(200, { success: true, result: { description: '一只橘猫趴在窗台上晒太阳' } });
    }
    if (p === '/hf') {
      mockCalls.hf += 1;
      if (mockMode === 'fail') return reply(500, { error: 'boom' });
      return reply(200, [{ generated_text: 'a cat sitting by the window' }]);
    }
    reply(404, {});
  });
});
const mockPort = await new Promise((resolve, reject) => {
  mockServer.once('error', reject);
  mockServer.listen(0, '127.0.0.1', () => { mockServer.removeListener('error', reject); resolve(mockServer.address().port); });
});
const mockUrl = (p) => `http://127.0.0.1:${mockPort}${p}`;

function writeConfig({ cfUrl } = {}) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    sauceNao: { apiKey: 'sk-sauce', searchUrl: mockUrl('/saucenao'), dailyQuota: 100 },
    cloudflare: { accountId: 'acct', apiToken: 'cf-tok', runUrl: cfUrl ?? mockUrl('/cf'), dailyQuota: 2000 },
    huggingFace: { token: 'hf-tok', runUrl: mockUrl('/hf'), dailyQuota: 50 },
  }));
}
writeConfig();

// ---------- 被测实例（无 token 主实例 + 带 token 鉴权实例） ----------
const svc = createVisionServer({ port: 0, cacheDir: CACHE_DIR, configPath: CONFIG_PATH });
const authSvc = createVisionServer({ port: 0, token: 'secret-token', cacheDir: CACHE_DIR, configPath: CONFIG_PATH });
await svc.listen();
await authSvc.listen();
const base = `http://127.0.0.1:${svc.server.address().port}`;

function imageBytes(seed) {
  const buf = Buffer.from(`vision-svc-test-image-${seed}`);
  return { base64: buf.toString('base64'), hash: createHash('sha256').update(buf).digest('hex') };
}
async function resetMockCalls() {
  for (const k of Object.keys(mockCalls)) mockCalls[k] = 0;
}
function todayUsageFile() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return path.join(CACHE_DIR, `usage-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`);
}

after(async () => {
  await svc.close();
  await authSvc.close();
  await new Promise((resolve) => mockServer.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('health：聚合服务在线，key 探针全亮，pid 供 supervisor 校验', async () => {
    const res = await fetch(`${base}/health`);
    const h = await res.json();
    assert.equal(res.status, 200);
    assert.equal(h.ok, true);
    assert.equal(h.engine, 'vision-agg');
    assert.equal(typeof h.pid, 'number');
    assert.deepEqual(h.keys, { saucenao: true, cloudflare: true, huggingFace: true });
  });

  test('空图入参：ok:false empty-image', async () => {
    const out = await svc.recognize('', 'image/png');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'empty-image');
  });

  test('动漫命中：SauceNAO 91.5% >=80% 判命中', async () => {
    await resetMockCalls();
    mockMode = 'hit';
    const img = imageBytes('anime-hit');
    const out = await svc.recognize(img.base64);
    assert.equal(out.ok, true);
    assert.equal(out.source, 'saucenao');
    assert.equal(out.cached, false);
    assert.ok(out.desc.includes('芙莉莲'));
    assert.ok(out.desc.includes('91.5'));
    assert.deepEqual(mockCalls, { saucenao: 1, cf: 0, hf: 0 });
    const usage = JSON.parse(fs.readFileSync(todayUsageFile(), 'utf8'));
    assert.equal(usage.saucenao, 1);
  });

  test('缓存命中：同图第二次识别零外部调用', async () => {
    await resetMockCalls();
    mockMode = 'hit';
    const img = imageBytes('anime-hit');
    const out = await svc.recognize(img.base64);
    assert.equal(out.ok, true);
    assert.equal(out.cached, true);
    assert.deepEqual(mockCalls, { saucenao: 0, cf: 0, hf: 0 });
  });

  test('未命中（<80%）走 Cloudflare 照片域', async () => {
    await resetMockCalls();
    mockMode = 'low';
    const img = imageBytes('photo-cat');
    const out = await svc.recognize(img.base64);
    assert.equal(out.ok, true);
    assert.equal(out.source, 'cloudflare');
    assert.equal(out.desc, '一只橘猫趴在窗台上晒太阳');
    assert.deepEqual(mockCalls, { saucenao: 1, cf: 1, hf: 0 });
  });

  test('CF 也未命中降级 HF', async () => {
    await resetMockCalls();
    mockMode = 'low';
    // CF 临时改走失败路径：直接把 runUrl 指到 404
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      sauceNao: { apiKey: 'sk-sauce', searchUrl: mockUrl('/saucenao'), dailyQuota: 100 },
      cloudflare: { accountId: 'acct', apiToken: 'cf-tok', runUrl: mockUrl('/cf-fail-404'), dailyQuota: 2000 },
      huggingFace: { token: 'hf-tok', runUrl: mockUrl('/hf'), dailyQuota: 50 },
    }));
    const img = imageBytes('photo-hf');
    const out = await svc.recognize(img.base64);
    assert.equal(out.ok, true);
    assert.equal(out.source, 'huggingFace');
    assert.equal(out.desc, 'a cat sitting by the window');
    writeConfig(); // 还原
  });

  test('全部未命中：ok:false no-hit（调用方落回 LLM 兜底）', async () => {
    await resetMockCalls();
    mockMode = 'fail';
    const img = imageBytes('all-fail');
    const out = await svc.recognize(img.base64);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no-hit');
    assert.deepEqual(mockCalls, { saucenao: 1, cf: 1, hf: 1 });
  });

  test('配额超限：三源全部跳过，零外部请求', async () => {
    await resetMockCalls();
    // 与服务端 todayStamp() 同口径：本地日期（UTC toISOString 在东八区 0-8 点会差一天）
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const localStamp = Number(`${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`);
    fs.writeFileSync(todayUsageFile(), JSON.stringify({
      date: localStamp,
      saucenao: 100, cloudflare: 2000, huggingFace: 50,
    }));
    mockMode = 'hit';
    const img = imageBytes('quota-exhausted');
    const out = await svc.recognize(img.base64);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no-hit');
    assert.deepEqual(mockCalls, { saucenao: 0, cf: 0, hf: 0 });
    fs.rmSync(todayUsageFile(), { force: true }); // 还原配额
  });

  test('坏缓存自愈：损坏 JSON 删档重建，不抛错', async () => {
    await resetMockCalls();
    mockMode = 'hit';
    const img = imageBytes('corrupt-cache');
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${img.hash}.json`), '{broken json!!');
    const out = await svc.recognize(img.base64);
    assert.equal(out.ok, true);
    assert.equal(out.source, 'saucenao');
    assert.equal(out.cached, false);
  });

  // ---------- 换源重识（2026-11-26）：source 强制单源 / refresh 跳缓存 / 覆盖缓存 ----------

  test('source 强制单源：动漫图走 cloudflare 也能识（跳过 saucenao 与缓存）', async () => {
    await resetMockCalls();
    mockMode = 'low'; // saucenao 会返回低相似度（走不到动漫命中），但 source=cloudflare 时根本不该调它
    const img = imageBytes('forced-cf');
    const out = await svc.recognize(img.base64, 'image/png', { source: 'cloudflare' });
    assert.equal(out.ok, true);
    assert.equal(out.source, 'cloudflare');
    assert.equal(out.cached, false);
    assert.deepEqual(mockCalls, { saucenao: 0, cf: 1, hf: 0 }, '指定源不得烧其它源配额');
  });

  test('source 强制单源：失败返回 source-failed，不降级其它源', async () => {
    await resetMockCalls();
    mockMode = 'fail';
    const img = imageBytes('forced-cf-fail');
    const out = await svc.recognize(img.base64, 'image/png', { source: 'cloudflare' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'source-failed');
    assert.equal(out.source, 'cloudflare');
    assert.deepEqual(mockCalls, { saucenao: 0, cf: 1, hf: 0 }, '失败不降级 huggingFace');
  });

  test('source 未知源：ok:false unknown-source', async () => {
    const img = imageBytes('unknown-source');
    const out = await svc.recognize(img.base64, 'image/png', { source: 'traceMoe' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'unknown-source:traceMoe');
  });

  test('source 重识覆盖缓存：后续普通识别拿到新源结果', async () => {
    mockMode = 'low';
    const img = imageBytes('cache-overwrite');
    // 第一次：默认链（saucenao low → cloudflare）
    const first = await svc.recognize(img.base64);
    assert.equal(first.source, 'cloudflare');
    // 换源强制重识：huggingFace 结果覆盖同 hash 缓存
    mockMode = 'fail'; // cf/hf 用 mode fail？hf fail 会失败——改回 low 后强制 huggingFace
    mockMode = 'low';
    const second = await svc.recognize(img.base64, 'image/png', { source: 'huggingFace' });
    assert.equal(second.ok, true);
    assert.equal(second.source, 'huggingFace');
    assert.equal(second.desc, 'a cat sitting by the window');
    // 普通识别：缓存命中且 source 已变为 huggingFace（旧 cloudflare 结果被覆盖）
    await resetMockCalls();
    const third = await svc.recognize(img.base64);
    assert.equal(third.ok, true);
    assert.equal(third.cached, true);
    assert.equal(third.source, 'huggingFace', '换源重识应覆盖旧缓存');
    assert.deepEqual(mockCalls, { saucenao: 0, cf: 0, hf: 0 });
  });

  test('refresh 跳缓存全链重跑：缓存命中图重新烧请求并覆盖结果', async () => {
    mockMode = 'hit';
    const img = imageBytes('refresh-run');
    await svc.recognize(img.base64); // 先建立缓存
    await resetMockCalls();
    const out = await svc.recognize(img.base64, 'image/png', { refresh: true });
    assert.equal(out.ok, true);
    assert.equal(out.cached, false);
    assert.deepEqual(mockCalls, { saucenao: 1, cf: 0, hf: 0 }, 'refresh 应跳过缓存重跑');
  });

  test('GET /sources：各源就绪与配额余量；带 token 鉴权', async () => {
    const res = await fetch(`${base}/sources`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.deepEqual(j.sources.map((s) => s.name), ['saucenao', 'cloudflare', 'huggingFace']);
    for (const s of j.sources) {
      assert.equal(typeof s.ready, 'boolean');
      assert.equal(typeof s.quotaRemaining, 'number');
    }
    const authBase = `http://127.0.0.1:${authSvc.server.address().port}`;
    const denied = await fetch(`${authBase}/sources`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${authBase}/sources`, { headers: { authorization: 'Bearer secret-token' } });
    assert.equal(allowed.status, 200);
  });

  test('HTTP 面：Bearer 鉴权 401 / 缺参 400 / 正常 200', async () => {
    const authBase = `http://127.0.0.1:${authSvc.server.address().port}`;
    const noToken = await fetch(`${authBase}/recognize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ imageBase64: imageBytes('auth').base64 }) });
    assert.equal(noToken.status, 401);
    const badToken = await fetch(`${authBase}/recognize`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: JSON.stringify({ imageBase64: imageBytes('auth').base64 }) });
    assert.equal(badToken.status, 401);
    const missing = await fetch(`${base}/recognize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(missing.status, 400);
    const okRes = await fetch(`${base}/recognize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ imageBase64: imageBytes('http-face').base64, mime: 'image/png' }) });
    assert.equal(okRes.status, 200);
    const okOut = await okRes.json();
    assert.equal(okOut.ok, true);
    assert.equal(okOut.source, 'saucenao');
  });
