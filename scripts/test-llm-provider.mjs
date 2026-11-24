// llm-provider 离线单测：vision 独立配置语义（2026-11-24 拆分）。
// 核心：vision.model 未显式配置 → vision() 返回 null（主文本模型绝不承担视觉，
// 防瞎编污染媒体记忆）；配置后 vision 用独立 model 请求（继承主 baseUrl/apiKey）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlmProvider, DEFAULT_LLM_CONFIG } from '../src/llm-provider.js';
import http from 'node:http';

/** 最小 OpenAI 兼容 mock 服务：记录收到的 model 与 content 形态。 */
function startMock({ content = '红色' } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ model: parsed.model, hasImage: JSON.stringify(parsed).includes('image_url') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('DEFAULT_LLM_CONFIG 含 vision:null（默认不启用视觉）', () => {
  assert.equal(DEFAULT_LLM_CONFIG.vision, null);
});

test('主配置可用但未配 vision → visionEnabled=false 且 vision() 返回 null', () => {
  const llm = createLlmProvider({ enabled: true, baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'cn:deepseek-v4.1-flash' });
  assert.equal(llm.enabled, true);
  assert.equal(llm.visionEnabled, false);
  return llm.vision({ imageBase64: 'aGk=' }).then((r) => assert.equal(r, null, '未配 vision 必须返回 null（绝不复用主模型看图）'));
});

test('vision 未显式 enabled（只有 model）→ 仍不启用', () => {
  const llm = createLlmProvider({
    enabled: true, baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'cn:deepseek-v4.1-flash',
    vision: { model: 'cn:glm-5.3-flash' }, // 缺 enabled:true
  });
  assert.equal(llm.visionEnabled, false);
});

test('vision 配置完整 → 启用且请求走 vision.model（继承主 baseUrl/apiKey）', async () => {
  const { server, seen, url } = await startMock();
  try {
    const llm = createLlmProvider({
      enabled: true,
      baseUrl: url,
      apiKey: 'sk-main-key',
      model: 'cn:deepseek-v4.1-flash',
      vision: { enabled: true, model: 'cn:glm-5.3-flash', timeoutMs: 3000 },
    });
    assert.equal(llm.visionEnabled, true);
    const r = await llm.vision({ prompt: '这张图是什么颜色？', imageBase64: 'aGk=' });
    assert.equal(r, '红色');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'cn:glm-5.3-flash', 'vision 请求必须用独立模型');
    assert.equal(seen[0].hasImage, true);
  } finally {
    server.close();
  }
});

test('vision 块可覆盖 baseUrl/apiKey（云端 API 场景）', async () => {
  const { server, seen, url } = await startMock();
  try {
    const llm = createLlmProvider({
      enabled: true, baseUrl: url, apiKey: 'sk-main', model: 'm1',
      vision: { enabled: true, model: 'cloud-vl', baseUrl: url, apiKey: 'sk-cloud', timeoutMs: 3000 },
    });
    assert.equal(llm.visionEnabled, true);
    await llm.vision({ imageBase64: 'aGk=' });
    // mock 不校验 key，只确认请求打到了覆盖的 baseUrl（seen 有记录即成功）
    assert.equal(seen.length, 1);
  } finally {
    server.close();
  }
});

test('complete() 不受 vision 拆分影响（主链路照旧）', async () => {
  const { server, seen, url } = await startMock({ content: '一句话解释' });
  try {
    const llm = createLlmProvider({ enabled: true, baseUrl: url, apiKey: 'sk-t', model: 'cn:deepseek-v4.1-flash' });
    const text = await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(text, '一句话解释');
    assert.equal(seen[0].model, 'cn:deepseek-v4.1-flash');
    assert.equal(seen[0].hasImage, false);
  } finally {
    server.close();
  }
});
