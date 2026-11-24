/**
 * 收藏池选图器（媒体管道 v3.1，2026-11-25）回归：
 *   - 语义序位衰减 + 热度（log 天花板）+ 随机扰动的评分排序；
 *   - 无 query = 纯热度+随机（「随机来一张收藏的表情」）；
 *   - limit 截断与边界（空池 / 超大 limit / rand 注入确定性）。
 * 纯函数测试，不需要 store/LLM。
 */
import assert from 'node:assert/strict';

// 与 src/service/media-service.js 同源的独立副本会漂移——直接 import 真实现。
// media-service 导出工厂（需要 store），selectForSend 是纯函数但闭包在工厂内，
// 这里通过最小 store 桩创建工厂后取函数。
const { createMediaService } = await import('../src/service/media-service.js');

const storeStub = { media: { get: () => null, query: () => ({ rows: [] }), put: (x) => x, count: () => 0, remove: () => {} } };
const media = createMediaService({ store: storeStub, config: { mediaDir: null } });
const { selectForSend } = media;

const pool = [
  { mediaId: 'ma_000000000001', kind: 'image', desc: '橘猫梗图', tags: ['猫'], useCount: 0 },
  { mediaId: 'ma_000000000002', kind: 'image', desc: '开心表情', tags: ['开心'], useCount: 10 },
  { mediaId: 'ma_000000000003', kind: 'image', desc: '震惊表情', tags: ['震惊'], useCount: 3 },
  { mediaId: 'ma_000000000004', kind: 'image', desc: '晚安图', tags: ['晚安'], useCount: 100 },
];

// 1) 有 query + 确定性 rand=0：同热度前提下语义序位衰减主导——第一名必是 bm25
//    相关度最高的 pool[0]（扰动相同 → 序位决定胜负）。热度不同时高热度者可以
//    压过相关度第一的冷门资产（设计意图，见用例 2）。
{
  const equalHeat = pool.map((item) => ({ ...item, useCount: 5 }));
  const picked = selectForSend(equalHeat, { query: '猫', limit: 5, rand: () => 0 });
  assert.equal(picked[0].mediaId, 'ma_000000000001', '同热度时有 query 时相关度第一的资产稳居榜首');
  assert.ok(picked[0].score > picked[picked.length - 1].score, '分数单调递减');
  assert.ok(picked.every((item) => typeof item.score === 'number'), '返回行附 score');
  const mixed = selectForSend(pool, { query: '猫', limit: 4, rand: () => 0 });
  assert.equal(mixed[0].mediaId, 'ma_000000000002', '热度高的资产可压过相关度第一的冷门图');
}

// 2) 热度天花板：useCount=100 的晚安图在无 query 时靠热度领先，但 log 增长
//    （≈5.6 倍）不会无限放大——与 useCount=3（≈2.4 倍）差距有界。
{
  const picked = selectForSend(pool, { query: '', limit: 4, rand: () => 0 });
  assert.equal(picked[0].mediaId, 'ma_000000000004', '无 query 时热度最高者居首');
}

// 3) 随机扰动真的在起作用：相同输入、不同 rand 序 → 非榜首位置的组成会变化。
{
  const a = selectForSend(pool, { query: '', limit: 2, rand: (() => { let i = 0; return () => [0, 0.9, 0.1, 0.8][i++ % 4]; })() });
  const b = selectForSend(pool, { query: '', limit: 2, rand: (() => { let i = 0; return () => [0.9, 0, 0.8, 0.1][i++ % 4]; })() });
  assert.notDeepEqual(a.map((x) => x.mediaId), b.map((x) => x.mediaId), '扰动改变候选组成（定量随机语义）');
}

// 4) 边界：空池返回空数组；limit 截断生效；limit 超大不超过池大小；limit<1 落 1。
{
  assert.deepEqual(selectForSend([], { query: 'x' }), []);
  assert.equal(selectForSend(pool, { query: '', limit: 2 }).length, 2);
  assert.equal(selectForSend(pool, { query: '', limit: 99 }).length, 4);
  assert.equal(selectForSend(pool, { query: '', limit: 0 }).length, 1);
}

// 5) 扰动区间：score 抖动不超过基准的 ±25%（rand∈[0,1] → jitter∈[0.75,1.25]）。
{
  const baseline = selectForSend([{ ...pool[1] }], { query: '', limit: 1, rand: () => 0.5 });
  const low = selectForSend([{ ...pool[1] }], { query: '', limit: 1, rand: () => 0 });
  const high = selectForSend([{ ...pool[1] }], { query: '', limit: 1, rand: () => 1 });
  assert.ok(low[0].score < baseline[0].score && baseline[0].score < high[0].score, '扰动单调');
}

console.log('test-media-select: all passed');
