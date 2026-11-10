// 关系守卫专项：白名单、置信度门槛（<0.6 丢弃 / 覆盖需 ≥0.9 / 跨窗口二次确认）、
// pending 人工确认（accept 落库 actor=manual / reject dismissed）、规则抽取兜底、
// 每日体检 dryRun 不改库。全部离线（守卫直接喂候选，不依赖 LLM）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openStore } from '../src/store/store-api.js';
import { createRelationService } from '../src/service/relation-service.js';
import { createRelationGuard, ruleExtract, RELATION_KEY_WHITELIST } from '../src/service/relation-guard.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-guard-'));
// 注意：relation 服务 get() 直接返回行（不是 {row} 包装）。
const SESSION = 'qq:group:80001';

async function fixture(backend = 'sqlite') {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${backend}-`));
  const store = await openStore({ dir, backend });
  const relation = createRelationService({ store });
  const guard = createRelationGuard({ store, relation, logger: () => {} });
  return { store, relation, guard, close: () => store.close() };
}

test('守卫：白名单外 key 拒绝、低置信丢弃、不完整候选拒绝', async () => {
  const { guard, relation, close } = await fixture();
  try {
    const out = guard.handleExtracted({
      sessionId: SESSION,
      relations: [
        { subjectId: 'u1', key: '心情', value: '很好', confidence: 0.9 },      // 白名单外
        { subjectId: 'u1', key: '称呼', value: '老王', confidence: 0.5 },      // < 0.6
        { subjectId: '', key: '称呼', value: '无名', confidence: 0.9 },        // 缺 subject
        { subjectId: 'u1', key: '关系', value: '大学室友', confidence: 0.85 }, // 合法
      ],
      windowHash: 'w1',
    });
    const byOutcome = (outcome) => out.filter((item) => item.outcome === outcome);
    assert.equal(byOutcome('rejected').length, 2, '白名单外 + 不完整');
    assert.equal(byOutcome('dropped').length, 1, '低置信丢弃');
    assert.equal(byOutcome('written').length, 1, '新事实 minWrite 即可写');
    assert.equal(relation.get({ sessionId: SESSION, subjectId: 'u1', key: '关系' }).value, '大学室友');
    assert.ok(RELATION_KEY_WHITELIST.includes('称呼'));
  } finally {
    close();
  }
});

test('守卫：覆盖门槛 —— conf<0.9 且无二次确认 → pending；conf≥0.9 → 直接覆盖', async () => {
  const { guard, relation, store, close } = await fixture();
  try {
    relation.upsert({ sessionId: SESSION, subjectId: 'u1', key: '称呼', value: '老王' });

    guard.handleExtracted({
      sessionId: SESSION,
      relations: [{ subjectId: 'u1', key: '称呼', value: '王哥', confidence: 0.7 }],
      windowHash: 'w1',
    });
    const pending = store.relationPending.list({ status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].value, '王哥');
    assert.equal(pending[0].windowsSeen, 1);
    assert.equal(relation.get({ sessionId: SESSION, subjectId: 'u1', key: '称呼' }).value, '老王', '原值不动');

    // 同窗口再来一次：windowsSeen 不涨（同 windowHash 不算二次确认）。
    guard.handleExtracted({
      sessionId: SESSION,
      relations: [{ subjectId: 'u1', key: '称呼', value: '王哥', confidence: 0.7 }],
      windowHash: 'w1',
    });
    assert.equal(store.relationPending.find({ sessionId: SESSION, subjectId: 'u1', key: '称呼', value: '王哥' }).windowsSeen, 1);

    // 跨窗口再来（w2）：windowsSeen=2 → 覆盖放行，pending 消掉。
    guard.handleExtracted({
      sessionId: SESSION,
      relations: [{ subjectId: 'u1', key: '称呼', value: '王哥', confidence: 0.7 }],
      windowHash: 'w2',
    });
    assert.equal(relation.get({ sessionId: SESSION, subjectId: 'u1', key: '称呼' }).value, '王哥');
    assert.equal(store.relationPending.list({ status: 'pending' }).length, 0);
    const row = relation.get({ sessionId: SESSION, subjectId: 'u1', key: '称呼' });
    assert.match(row.actor, /^summary:/, '自动覆盖的 actor 记窗口哈希');

    // conf 0.95 直接覆盖（不打 pending）。
    relation.upsert({ sessionId: SESSION, subjectId: 'u2', key: '称呼', value: '小张' });
    guard.handleExtracted({
      sessionId: SESSION,
      relations: [{ subjectId: 'u2', key: '称呼', value: '张哥', confidence: 0.95 }],
      windowHash: 'w3',
    });
    assert.equal(relation.get({ sessionId: SESSION, subjectId: 'u2', key: '称呼' }).value, '张哥');
  } finally {
    close();
  }
});

test('守卫：同值重复 = 确认（confidence 抬升 + 刷新 last_confirmed_at）', async () => {
  const { guard, relation, close } = await fixture();
  try {
    guard.handleExtracted({
      sessionId: SESSION,
      relations: [{ subjectId: 'u1', key: '称呼', value: '老王', confidence: 0.7 }],
      windowHash: 'w1',
    });
    const first = relation.get({ sessionId: SESSION, subjectId: 'u1', key: '称呼' });
    guard.handleExtracted({
      sessionId: SESSION,
      relations: [{ subjectId: 'u1', key: '称呼', value: '老王', confidence: 0.8 }],
      windowHash: 'w2',
    });
    const second = relation.get({ sessionId: SESSION, subjectId: 'u1', key: '称呼' });
    assert.equal(second.value, '老王');
    assert.ok(second.confidence > first.confidence, `确认应抬升置信度：${first.confidence} -> ${second.confidence}`);
    assert.ok(second.lastConfirmedAt >= first.lastConfirmedAt);
  } finally {
    close();
  }
});

test('守卫：规则抽取兜底 —— 强模式命中 actor=rule:<name>，与 LLM 候选去重', async () => {
  const { guard, relation, close } = await fixture();
  try {
    const hits = ruleExtract({ text: '大家好，我叫王小明，叫我小明就行', senderId: 'u9' });
    assert.ok(hits.length >= 2, `应命中自我介绍与叫我规则：${JSON.stringify(hits)}`);
    assert.ok(hits.every((hit) => hit.actor.startsWith('rule:')));
    assert.equal(hits[0].confidence, 0.9);

    // 规则抽取走 handleExtracted（rows = 本窗口原文）：LLM 漏抽也有确定性入口。
    const out = guard.handleExtracted({
      sessionId: SESSION,
      relations: [], // LLM 什么都没抽到
      windowHash: 'w1',
      rows: [{ senderId: 'u9', text: '大家好，我叫王小明' }],
    });
    assert.equal(out.filter((item) => item.outcome === 'written').length, 1, '规则兜底写入');
    assert.equal(relation.get({ sessionId: SESSION, subjectId: 'u9', key: '称呼' }).value, '王小明');

    // LLM 也抽到同一条（同 key+value）→ 去重，不写两遍。
    const dedup = guard.handleExtracted({
      sessionId: SESSION,
      relations: [{ subjectId: 'u9', key: '称呼', value: '王小明', confidence: 0.8 }],
      windowHash: 'w2',
      rows: [{ senderId: 'u9', text: '大家好，我叫王小明' }],
    });
    assert.equal(dedup.length, 1, 'LLM 候选与规则命中去重后只剩一条');
    assert.equal(dedup[0].outcome, 'confirmed', '同值 → 确认路径');
  } finally {
    close();
  }
});

test('守卫：人工确认 —— accept 走正常 upsert（actor=manual, conf=1）后移除；reject 标 dismissed', async () => {
  const { guard, relation, store, close } = await fixture();
  try {
    relation.upsert({ sessionId: SESSION, subjectId: 'u1', key: '称呼', value: '老王' });
    guard.handleExtracted({
      sessionId: SESSION,
      relations: [{ subjectId: 'u1', key: '称呼', value: '王哥', confidence: 0.7 }],
      windowHash: 'w1',
    });
    const [pending] = store.relationPending.list({ status: 'pending' });

    const accepted = guard.accept({ id: pending.id, actor: 'ops:alice' });
    assert.equal(accepted.accepted, true);
    const row = relation.get({ sessionId: SESSION, subjectId: 'u1', key: '称呼' });
    assert.equal(row.value, '王哥');
    assert.equal(row.actor, 'ops:alice', '人工确认的 actor 落库（审计）');
    assert.equal(row.confidence, 1);
    assert.equal(store.relationPending.list({ status: 'pending' }).length, 0, '确认后移出池子');
    assert.equal(guard.accept({ id: pending.id }).accepted, false, '重复 accept 无效');

    // reject 路径：外号已有旧值（新事实不需要确认，冲突才需要）。
    relation.upsert({ sessionId: SESSION, subjectId: 'u1', key: '外号', value: '小胖' });
    guard.handleExtracted({
      sessionId: SESSION,
      relations: [{ subjectId: 'u1', key: '外号', value: '胖子', confidence: 0.7 }],
      windowHash: 'w4',
    });
    const [bad] = store.relationPending.list({ status: 'pending' });
    assert.equal(guard.reject({ id: bad.id }).rejected, true);
    assert.equal(store.relationPending.get(bad.id).status, 'dismissed', '拒绝保留审计痕迹');
    assert.equal(relation.get({ sessionId: SESSION, subjectId: 'u1', key: '外号' }).value, '小胖', '拒绝不改值（旧值保留）');
    // 已 dismissed 的结论不会被新窗口翻案。
    const revived = store.relationPending.put({
      sessionId: SESSION, subjectId: 'u1', key: '外号', value: '胖子', confidence: 0.9, windowHash: 'w5',
    });
    assert.equal(revived.status, 'dismissed');
  } finally {
    close();
  }
});

test('守卫：每日体检 dryRun 只出报告不改库（stale / 低置信 / 待确认计数）', async () => {
  const { guard, relation, store, close } = await fixture();
  try {
    const old = Date.now() - 120 * 24 * 3600 * 1000;
    // last_confirmed_at 可由 upsert 显式给（模拟「三个月没人再提」）。
    relation.upsert({ sessionId: SESSION, subjectId: 'u1', key: '生日', value: '3 月 5 日', confidence: 0.95, lastConfirmedAt: old });
    relation.upsert({ sessionId: SESSION, subjectId: 'u1', key: '喜好', value: '火锅', confidence: 0.3 });

    const report = guard.audit({ sessionId: SESSION });
    assert.equal(report.dryRun, true);
    assert.equal(report.scanned, 2);
    const flags = report.problems.flatMap((item) => item.problems);
    assert.ok(flags.some((flag) => flag.startsWith('stale:')), '超期未确认应报 stale');
    assert.ok(flags.some((flag) => flag.startsWith('low-confidence:')), '低置信死行应报告');
    // dryRun：库没变。
    assert.equal(relation.get({ sessionId: SESSION, subjectId: 'u1', key: '生日' }).lastConfirmedAt, old);
    assert.equal(report.pending, 0);
  } finally {
    close();
  }
});

test('守卫：JSON 兜底后端语义一致（pending 幂等/跨窗口/accept）', async () => {
  const { guard, relation, store, close } = await fixture('json');
  try {
    relation.upsert({ sessionId: SESSION, subjectId: 'u1', key: '称呼', value: '老王' });
    guard.handleExtracted({ sessionId: SESSION, relations: [{ subjectId: 'u1', key: '称呼', value: '王哥', confidence: 0.7 }], windowHash: 'w1' });
    assert.equal(store.relationPending.list({ status: 'pending' }).length, 1, '不够格 → pending');
    guard.handleExtracted({ sessionId: SESSION, relations: [{ subjectId: 'u1', key: '称呼', value: '王哥', confidence: 0.7 }], windowHash: 'w2' });
    assert.equal(relation.get({ sessionId: SESSION, subjectId: 'u1', key: '称呼' }).value, '王哥', '跨窗口二次确认覆盖');
    assert.equal(store.stats().relationPending, 0);
  } finally {
    close();
  }
});
