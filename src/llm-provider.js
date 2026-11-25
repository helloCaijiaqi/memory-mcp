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
  // audio 子配置（专职语音模型，2026-11-25 三类媒体分模型）：识别走 OpenAI
  // 兼容 POST {baseUrl}/audio/transcriptions（whisper 标准形状）；generateVoice
  // 走 {baseUrl}/audio/speech（本期仅暴露方法不接业务，供未来 voice_lib 自动
  // 填充）。enabled && model 显式给出才启用；其余继承主配置可覆盖。
  audio: null,
  // video 子配置（专职视频理解模型）：走 chat/completions 多模态 video_url
  // content（Qwen-VL 系生态形状）；不支持的服务端报错 → null → analyzer
  // 保持 pending。与 vision/audio 各配各的，互不借用。
  video: null,
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
  // audio/video 子配置：与 vision 完全同构——model 必须显式声明，baseUrl/apiKey/
  // timeoutMs 继承主配置可覆盖（三类媒体各用各的专职模型，主文本模型不承担）。
  const subCfg = (block) => block && typeof block === 'object'
    ? {
        baseUrl: String(block.baseUrl ?? cfg.baseUrl ?? ''),
        apiKey: String(block.apiKey ?? cfg.apiKey ?? ''),
        model: String(block.model ?? '').trim(),
        timeoutMs: Number(block.timeoutMs ?? cfg.timeoutMs ?? 20000),
        language: String(block.language ?? '').trim(),
        // libDir（audio 专用）：voice_lib 素材落在本机（qq-bridge 的 audio/ 目录），
        // memory 进程据此读取文件做 ASR；相对路径按本目录不存在处理（保持 pending）。
        libDir: String(block.libDir ?? '').trim(),
      }
    : null;
  const audioCfg = subCfg(cfg.audio);
  const videoCfg = subCfg(cfg.video);
  const audioUsable = Boolean(
    cfg.enabled
    && audioCfg
    && cfg.audio?.enabled === true
    && audioCfg.baseUrl
    && audioCfg.apiKey
    && audioCfg.model,
  );
  const videoUsable = Boolean(
    cfg.enabled
    && videoCfg
    && cfg.video?.enabled === true
    && videoCfg.baseUrl
    && videoCfg.apiKey
    && videoCfg.model,
  );
  return {
    get enabled() {
      return usable;
    },
    get visionEnabled() {
      return visionUsable;
    },
    get audioEnabled() {
      return audioUsable;
    },
    get videoEnabled() {
      return videoUsable;
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
    /**
     * 语音识别（专职 ASR，2026-11-25 三类媒体分模型）：OpenAI 兼容
     * POST {baseUrl}/audio/transcriptions（whisper 标准形状，multipart
     * file+model）。失败返回 null（调用方降级 pending——与 vision 同纪律）。
     * 注意 ASR 上传耗时与音频时长相关，超时给 audioCfg.timeoutMs 的 2 倍。
     */
    async transcribe({ audioBase64, mime = 'audio/wav', filename = 'audio.wav', language = '' } = {}) {
      if (!audioUsable || !audioBase64) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(2000, audioCfg.timeoutMs * 2));
      try {
        const form = new FormData();
        form.append('file', new Blob([Buffer.from(audioBase64, 'base64')], { type: mime }), filename);
        form.append('model', audioCfg.model);
        const lang = String(language ?? '').trim() || audioCfg.language;
        if (lang) form.append('language', lang);
        const res = await fetch(`${audioCfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${audioCfg.apiKey}` },
          body: form,
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = await res.json();
        const text = String(data?.text ?? '').trim();
        return text || null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    /**
     * 视频理解（专职模型）：视频 base64 → 描述文本。chat/completions 多模态
     * video_url content（Qwen-VL 系生态形状）；不支持视频输入的服务端会报错，
     * 返回 null（调用方降级 pending，不影响主链路——与 vision 同纪律）。
     */
    async seeVideo({ system, prompt, videoBase64, mime = 'video/mp4', maxTokens = 300 } = {}) {
      if (!videoUsable || !videoBase64) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, videoCfg.timeoutMs));
      try {
        const res = await fetch(`${videoCfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${videoCfg.apiKey}`,
          },
          body: JSON.stringify({
            model: videoCfg.model,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              {
                role: 'user',
                content: [
                  { type: 'text', text: String(prompt ?? '描述这段视频的内容') },
                  { type: 'video_url', video_url: { url: `data:${mime};base64,${videoBase64}` } },
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
    /**
     * 语音生成（TTS，专职语音模型的生成面）：OpenAI 兼容 POST
     * {baseUrl}/audio/speech。本期仅暴露方法不接任何业务流程（供未来
     * voice_lib 自动填充）；失败返回 null。
     */
    async generateVoice({ text, voice = 'alloy', format = 'wav', speed = 1 } = {}) {
      if (!audioUsable || !text) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(2000, audioCfg.timeoutMs * 2));
      try {
        const res = await fetch(`${audioCfg.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${audioCfg.apiKey}`,
          },
          body: JSON.stringify({
            model: audioCfg.model,
            input: String(text).slice(0, 4000),
            voice,
            response_format: format,
            speed,
          }),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.length > 0 ? buf : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
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
