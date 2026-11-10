// 黑话候选的规则化发现：n-gram 频次 + 互信息（凝聚度）+ 左右熵（自由度）。
//
// 纯函数、零依赖、不联网、不调模型 —— 这是把黑话能力从 qq-bridge 抽出来的前提：
// 现状 bridge.js 靠自己的模型生成解释，等于让公共能力依赖了某个平台的模型；
// 这里先用规则把"哪些串像词"挑出来，解释可以留空或交给可选 LLM（默认关）。
export const DEFAULT_DISCOVER = {
  minLen: 2,
  maxLen: 6,
  minFreq: 3, // 至少在 3 条不同消息里出现过
  minCohesion: 1.2, // 互信息下限：太低说明只是碰巧相邻
  maxFreqRatio: 0.5, // 在超过半数消息里都出现的，那是常用词不是黑话
  // 左右熵默认不作为硬门槛：中文口语里大量词习惯出现在句末/句首，
  // 此时某一侧的熵必然接近 0，硬卡会把它连同真词一起滤掉。熵只参与打分排序。
  minFreedom: 0,
  topN: 20,
  maxEvidence: 3,
  evidenceChars: 40,
};

// 分段用：空白与常见标点都算边界，避免跨句拼出假词。
const SEGMENT_SPLIT_RE = /[\s,.;:!?"'“”‘’、，。！？；：（）()[\]{}<>/\\|~`@#$%^&*+=—…·\n\r\t-]+/;
const BOUNDARY = '#BOUND#';

export function toTexts(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  return list
    .map((item) => (item == null ? '' : typeof item === 'string' ? item : String(item.text ?? item.content ?? '')))
    .map((text) => String(text).trim())
    .filter(Boolean);
}

export function splitSegments(text) {
  return String(text ?? '')
    .split(SEGMENT_SPLIT_RE)
    .filter(Boolean);
}

/** 文档频次：一个词在同一条消息里出现多次也只算一次，避免刷屏污染。 */
export function countNgrams(texts, { minLen = 2, maxLen = 6 } = {}) {
  const counts = new Map();
  for (const text of texts) {
    const seen = new Set();
    for (const seg of splitSegments(text)) {
      for (let len = minLen; len <= maxLen; len += 1) {
        for (let i = 0; i + len <= seg.length; i += 1) {
          const gram = seg.slice(i, i + len);
          if (seen.has(gram)) continue;
          seen.add(gram);
          counts.set(gram, (counts.get(gram) ?? 0) + 1);
        }
      }
    }
  }
  return counts;
}

/** 凝聚度：所有切分方式里最差的那个互信息（越小说明越不该被切成两块，即越像一个词）。 */
export function cohesion(gram, freqOf, docCount) {
  if (gram.length < 2) return 0;
  let worst = Infinity;
  for (let i = 1; i < gram.length; i += 1) {
    const left = freqOf(gram.slice(0, i)) || 1;
    const right = freqOf(gram.slice(i)) || 1;
    const whole = freqOf(gram) || 1;
    const pmi = Math.log2((whole * Math.max(1, docCount)) / (left * right));
    worst = Math.min(worst, pmi);
  }
  return Number.isFinite(worst) ? worst : 0;
}

export function entropy(counter) {
  let total = 0;
  for (const value of counter.values()) total += value;
  if (!total) return 0;
  let h = 0;
  for (const value of counter.values()) {
    const p = value / total;
    h -= p * Math.log2(p);
  }
  return h;
}

/** 左右邻字分布的熵：熵高说明它能跟很多字搭配，是独立成词的信号。 */
export function branchEntropy(texts, gram) {
  const left = new Map();
  const right = new Map();
  const len = gram.length;
  for (const text of texts) {
    for (const seg of splitSegments(text)) {
      let from = 0;
      for (;;) {
        const at = seg.indexOf(gram, from);
        if (at < 0) break;
        const l = at > 0 ? seg[at - 1] : BOUNDARY;
        const r = at + len < seg.length ? seg[at + len] : BOUNDARY;
        left.set(l, (left.get(l) ?? 0) + 1);
        right.set(r, (right.get(r) ?? 0) + 1);
        from = at + 1;
      }
    }
  }
  return { left: entropy(left), right: entropy(right) };
}

function clipEvidence(text, gram, chars) {
  const at = text.indexOf(gram);
  if (at < 0) return text.slice(0, chars);
  const start = Math.max(0, at - 8);
  const piece = text.slice(start, start + chars);
  return `${start > 0 ? '…' : ''}${piece}${start + chars < text.length ? '…' : ''}`;
}

/**
 * 发现候选词。messages 为字符串数组或 { text } 数组。
 * 返回 [{ content, freq, cohesion, freedom, score, evidence }]，按 score 降序。
 */
export function discover(messages, opts = {}) {
  const cfg = { ...DEFAULT_DISCOVER, ...opts };
  const texts = toTexts(messages);
  if (!texts.length) return [];
  const counts = countNgrams(texts, { minLen: cfg.minLen, maxLen: cfg.maxLen });
  const freqOf = (gram) => counts.get(gram) ?? 0;
  const docCount = texts.length;

  const candidates = [];
  for (const [gram, freq] of counts) {
    if (freq < cfg.minFreq) continue;
    if (gram.length < cfg.minLen) continue;
    // 覆盖度过高的直接跳过：几乎每条消息都出现的串（"之后""的时候"之类）是常用词，
    // 把它们留给 AI 只会淹没真正的黑话候选。
    if (docCount > 0 && freq / docCount > cfg.maxFreqRatio) continue;
    const coh = cohesion(gram, freqOf, docCount);
    if (coh < cfg.minCohesion) continue;
    const { left, right } = branchEntropy(texts, gram);
    const freedom = Math.min(left, right);
    if (freedom < cfg.minFreedom) continue;
    candidates.push({
      content: gram,
      freq,
      cohesion: Math.round(coh * 100) / 100,
      freedom: Math.round(freedom * 100) / 100,
      // 打分刻意不让频次线性主导：否则高频常用词会永远压住真正的新词。
      // 频次只取对数，凝聚度与自由度才是主项。
      score: Math.round(coh * (0.5 + freedom) * Math.log2(1 + freq) * 100) / 100,
      evidence: texts
        .filter((text) => text.includes(gram))
        .slice(0, cfg.maxEvidence)
        .map((text) => clipEvidence(text, gram, cfg.evidenceChars)),
    });
  }

  // 去掉"只是更长候选的一部分"的短串：它们没有独立出现的证据。
  //
  // 旧实现在候选之间做双重循环（O(n²) 次 includes），候选上万时会把整轮发现拖到
  // 秒级。候选串长被 maxLen 封顶（默认 ≤6），所以改成「枚举长串的所有候选长度
  // 子串 → Set 查表」，复杂度 O(n · L²)，语义完全等价（子串任意位置）。
  const byContent = new Map(candidates.map((item) => [item.content, item]));
  const dropped = new Set();
  const byLengthDesc = [...candidates].sort((a, b) => b.content.length - a.content.length);
  for (const long of byLengthDesc) {
    const text = long.content;
    for (let len = cfg.minLen; len < text.length; len += 1) {
      for (let i = 0; i + len <= text.length; i += 1) {
        const sub = text.slice(i, i + len);
        if (dropped.has(sub)) continue;
        const short = byContent.get(sub);
        if (!short) continue;
        if (long.freq >= short.freq * 0.9) dropped.add(sub);
      }
    }
  }
  return candidates
    .filter((item) => !dropped.has(item.content))
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.topN);
}
