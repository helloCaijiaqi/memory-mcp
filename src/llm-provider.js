// 可选的 LLM provider：只用来给黑话候选"生成人话解释"。
//
// 默认关闭，这是刻意的：
//   现状 qq-bridge 里黑话解释是 bridge.js 调自己的模型生成的（runSlangResearch），
//   这意味着公共能力依赖了某个平台的模型。抽离后必须切断 —— 新平台接入时不应该
//   为了用记忆/黑话而先接一套模型。关闭时解释生成直接降级为空串，不影响规则发现。
export const DEFAULT_LLM_CONFIG = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  timeoutMs: 15000,
};

export function createLlmProvider(config = {}) {
  const cfg = { ...DEFAULT_LLM_CONFIG, ...config };
  const usable = Boolean(cfg.enabled && cfg.baseUrl && cfg.apiKey && cfg.model);
  return {
    get enabled() {
      return usable;
    },
    config: cfg,
    /** 生成解释；不可用或失败都返回空串（降级，不抛错打断学习流程）。 */
    async explain({ content, evidence = [] } = {}) {
      if (!usable) return '';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs));
      try {
        const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              {
                role: 'system',
                content: '你是网络用语词典。只输出一句话解释，不超过 30 字，不要解释你的推理。',
              },
              {
                role: 'user',
                content: `词语：${content}\n上下文：${evidence.slice(0, 3).join(' / ') || '（无）'}`,
              },
            ],
            temperature: 0.3,
            max_tokens: 120,
          }),
          signal: controller.signal,
        });
        if (!res.ok) return '';
        const data = await res.json();
        const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
        return text.replace(/\s+/g, ' ').slice(0, 100);
      } catch {
        return '';
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
