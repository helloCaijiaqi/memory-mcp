// 黑话引擎的离线单测：规则发现、状态流转、证据合并、段落渲染、LLM 默认关闭。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/store-api.js';
import { createSlangService } from '../src/service/slang-service.js';
import { branchEntropy, cohesion, countNgrams, discover } from '../src/slang-discover.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-slang-'));

// 合成语料：目标词出现 6 次且左右邻字各不相同；
// 填充语料刻意造到几百条 —— 互信息本身随语料规模缩放（PMI 含 log(语料量) 项），
// 只用十几条消息测会把真词一起滤掉，这与真实使用（一个消息窗口几百条）不符。
const TARGET_MESSAGES = [
  '我觉得尊嘟假嘟这个说法挺有意思的',
  '你别尊嘟假嘟了，赶紧说重点',
  '群里今天又在刷尊嘟假嘟',
  '尊嘟假嘟到底是什么意思啊',
  '听完解释之后我觉得尊嘟假嘟挺形象',
  '别拿尊嘟假嘟糊弄新人',
];

const SUBJECTS = ['网关', '控制台', '语音', '表情', '记忆', '会话', '插件', '日志', '配置', '权限'];
const VERBS = ['重启之后', '升级之后', '归档之后', '同步之后', '校验之后', '加载之后', '写入之后', '回滚之后'];
const TAILS = ['需要人工确认一次', '会在下个版本修', '已经写进文档了', '先观察一天再说', '要走灰度开关', '只在回环地址上可用'];
const FILLER = [];
for (const subject of SUBJECTS) {
  for (const verb of VERBS) {
    for (const tail of TAILS) FILLER.push(`${subject}${verb}${tail}`);
  }
}

const CORPUS = [...TARGET_MESSAGES, ...FILLER];

async function svc(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'db-'));
  const store = await openStore({ dir, backend: 'sqlite' });
  const service = createSlangService({ store, config: overrides });
  return { service, store, close: () => store.close() };
}

test('规则发现：重复出现且左右邻字多样的串应该被挑出来', () => {
  const found = discover(CORPUS, { minFreq: 3, topN: 10 });
  const hit = found.find((item) => item.content === '尊嘟假嘟');
  assert.ok(hit, `目标词应进入候选，实际候选：${found.map((item) => item.content).join('、') || '（空）'}`);
  // 排序同样重要：候选要交给 AI / 人确认，被高频常用词淹没等于没发现。
  assert.equal(found[0].content, '尊嘟假嘟', `目标词应排第一，实际第一是「${found[0]?.content}」`);
  assert.equal(hit.freq, 6);
  assert.ok(hit.evidence.length > 0, '应带上下文证据');
  assert.ok(hit.cohesion >= 1.2, `凝聚度应达标，实际 ${hit.cohesion}`);
});

test('只出现一次的串不会变成候选（频次门槛）', () => {
  const found = discover(CORPUS, { minFreq: 3, topN: 50 });
  assert.ok(!found.some((item) => item.content === '今天天气'), '一次性短语不应进候选');
});

test('凝聚度与左右熵是可单独验证的纯函数', () => {
  const counts = countNgrams(CORPUS, { minLen: 2, maxLen: 4 });
  const freqOf = (gram) => counts.get(gram) ?? 0;
  assert.ok(cohesion('尊嘟假嘟', freqOf, CORPUS.length) > 0, '目标词凝聚度应为正');
  const { left, right } = branchEntropy(CORPUS, '尊嘟假嘟');
  assert.ok(left > 0 && right >= 0, '左右熵应可计算');
});

test('empty 输入不炸：空语料返回空数组', () => {
  assert.deepEqual(discover([]), []);
  assert.deepEqual(discover(null), []);
});

test('absorb：候选入库、证据合并、不重复建条目', async () => {
  const { service, close } = await svc();
  const first = service.absorb({ messages: CORPUS });
  assert.ok(first.length > 0, '应写入候选');
  const target = first.find((row) => row.content === '尊嘟假嘟');
  assert.ok(target, '目标词应入库');
  assert.equal(target.status, 'candidate', '默认状态是候选，未经确认不注入提示词');

  const again = service.absorb({ messages: CORPUS });
  const still = again.find((row) => row.content === '尊嘟假嘟');
  assert.equal(still.id, target.id, '同内容应合并到同一条，不重复建条目');
  assert.ok(still.evidence.length >= target.evidence.length);
  close();
});

test('确认后进【黑话】段；拒绝后不进', async () => {
  const { service, close } = await svc();
  const row = service.submit({ content: 'yyds', meaning: '永远的神', status: 'candidate', score: 3 });
  service.submit({ content: '绝绝子', meaning: '非常好', status: 'candidate', score: 2 });
  assert.equal(service.render().blocks.length, 0, '候选默认不注入');

  service.confirm({ id: row.id });
  const out = service.render();
  assert.equal(out.blocks[0].name, '黑话');
  assert.ok(out.blocks[0].text.includes('yyds：永远的神'));
  assert.ok(!out.blocks[0].text.includes('绝绝子'), '未确认的不应出现');

  service.reject({ id: row.id });
  assert.equal(service.render().blocks.length, 0, '拒绝后不再注入');
  close();
});

test('黑话段超限会截断并显式告知', async () => {
  const { service, close } = await svc();
  const row = service.submit({ content: '一个很长很长的网络用语词条', meaning: '解释也很长很长很长', status: 'confirmed', score: 1 });
  service.confirm({ id: row.id });
  const clipped = service.render({ maxChars: 20 });
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.blocks[0].text.includes('已截断'));
  close();
});

test('LLM 默认关闭：explain 不报错、也不假装有解释', async () => {
  const { service, close } = await svc();
  assert.equal(service.llmEnabled, false, '默认必须关闭');
  const row = service.submit({ content: 'emo', meaning: '', status: 'confirmed' });
  const after = await service.explain({ id: row.id });
  assert.equal(after.meaning, '', '关闭时不生成解释，也不应抛错');
  close();
});

test('容量上限：超出后按最低分淘汰', async () => {
  const { service, close } = await svc({ maxEntries: 2 });
  service.submit({ content: 'a', score: 5 });
  service.submit({ content: 'b', score: 3 });
  service.submit({ content: 'c', score: 1 });
  assert.equal(service.stats().slang, 2, '超上限应淘汰');
  const rows = service.query({}).rows.map((row) => row.content).sort();
  assert.deepEqual(rows, ['a', 'b'], '淘汰的应是最低分的 c');
  close();
});
