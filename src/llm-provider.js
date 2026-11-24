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
  // vision 子配置（多媒体记忆层，2026-11-24 拆分）：独立于主 model——主文本模型
  // 看不了图，vision() 复用主 model 会拿到瞎编的描述污染媒体记忆。规则：
  //   vision.enabled && vision.model 必须显式给出才启用视觉；
  //   baseUrl/apiKey 缺省继承主配置（vision 块可覆盖，支持换云端 API）。
  // 未配置 → vision() 返回 null → media-analyzer 保持 pending（绝不瞎编）。
  vision: null,
};

export function createLlmProvider(config = {}) {
  const cfg = { ...DEFAULT_LLM_CONFIG, ...config };
  const usable = Boolean(cfg.enabled && cfg.baseUrl && cfg.apiKey && cfg.model);
  // vision 请求参数：model 必须显式声明；baseUrl/apiKey/timeoutMs 继承主配置可覆盖。
  const visionCfg = cfg.vision && typeof cfg.vision === 'object'
    ? {
        baseUrl: String(cfg.vision.baseUrl ?? cfg.baseUrl ?? ''),
        apiKey: String(cfg.vision.apiKey ?? cfg.apiKey ?? ''),
        model: String(cfg.vision.model ?? '').trim(),
        timeoutMs: Number(cfg.vision.timeoutMs ?? cfg.timeoutMs ?? 20000),
      }
    : null;
  const visionUsable = Boolean(
    cfg.enabled
    && visionCfg
    && cfg.vision?.enabled === true
    && visionCfg.baseUrl
    && visionCfg.apiKey
    && visionCfg.model,
  );
  return {
    get enabled() {
      return usable;
    },
    get visionEnabled() {
      return visionUsable;
    },
    config: cfg,
    /**
     * 通用补全（摘要/画像等任务共用）。不可用或失败返回 null（调用方降级），
     * 不抛错 —— LLM 是旁路，绝不能把主链路打断。json=true 时带 response_format
     * 提示（OpenAI 兼容；不支持的服务端忽略该字段，解析侧仍要做坏 JSON 容错）。
     */
    async complete({ messages = [], temperature = 0.2, maxTokens = 512, json = false } = {}) {
      if (!usable || messages.length === 0) return null;
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
            messages,
            temperature,
            max_tokens: maxTokens,
            ...(json ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = await res.json();
        const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
        return text || null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    /**
     * 视觉解析（多媒体记忆层）：图片 base64 → 描述文本。OpenAI 兼容协议的
     * image_url content 格式；不支持视觉的服务端会报错，返回 null（调用方降级
     * pending，不影响主链路——与 complete 同纪律）。
     */
    async vision({ system, prompt, imageBase64, mime = 'image/png', maxTokens = 300 } = {}) {
      if (!visionUsable || !imageBase64) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, visionCfg.timeoutMs));
      try {
        const res = await fetch(`${visionCfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${visionCfg.apiKey}`,
          },
          body: JSON.stringify({
            model: visionCfg.model,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              {
                role: 'user',
                content: [
                  { type: 'text', text: String(prompt ?? '描述这张图片') },
                  { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
                ],
              },
            ],
            temperature: 0.2,
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = await res.json();
        const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
        return text || null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    /** 生成解释；不可用或失败都返回空串（降级，不抛错打断学习流程）。 */
    async explain({ content, evidence = [] } = {}) {
      const text = await this.complete({
        messages: [
          { role: 'system', content: '你是网络用语词典。只输出一句话解释，不超过 30 字，不要解释你的推理。' },
          { role: 'user', content: `词语：${content}\n上下文：${evidence.slice(0, 3).join(' / ') || '（无）'}` },
        ],
        temperature: 0.3,
        maxTokens: 120,
      });
      if (text == null) return '';
      return text.replace(/\s+/g, ' ').slice(0, 100);
    },
  };
}
