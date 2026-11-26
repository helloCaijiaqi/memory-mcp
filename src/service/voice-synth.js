// voice-synth：语音合成异步任务 worker（memory 专用模型服务链）
// DSH 经 chat_voice_synthesize 工具提交（text + role/emotion 或人设关键词）→
// voice-bank 解析参考音频 → 立即登记 voice 资产（status=pending，ref=<mediaId>.wav）
// 并入队 → worker 调 tts-svc（GPT-SoVITS 克隆合成，CPU 慢 25-70s/句）→ wav 落
// voice_lib → updateDesc ready。
// 发送链路：chat_voice_send（网关三发送工具之一）→ bridge send_voice；
// 未 ready 时走既有 E_NOT_READY 降级。
// 纪律：任务超时/失败标 failed（desc 写原因），绝不静默丢任务。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function createVoiceSynthWorker({
  media,
  hub,
  bank = null,
  config = {},
  logger = () => {},
} = {}) {
  const cfg = {
    outDir: String(config.outDir ?? '').trim(), // 合成产物落盘根（state/data/audio/out，运行时区）
    maxTextChars: Number(config.maxTextChars || 300),
    taskTimeoutMs: Number(config.taskTimeoutMs || 10 * 60 * 1000), // 排队+合成总超时 10min
    pollMs: Number(config.pollMs || 5000),
  };
  const queue = [];
  let running = false;
  let stopped = false;

  async function runOne(task) {
    const result = await hub.synthesize({
      text: task.text,
      refPath: task.refPath,
      promptText: task.promptText,
    });
    if (!result?.ok || !result.wavBase64) {
      media.updateDesc(task.mediaId, {
        desc: `合成失败：${result?.error ?? 'tts-svc 不可用'}（稍后可重试）`,
        status: 'failed',
      });
      return;
    }
    // 分段命名（2026-11-26）：产物名 ma_<id>.out.wav——.out 段标记合成产物生命周期
    // （7 天 prune + 收藏豁免）。路径唯一真值 = sourcePath（认知面 ref 由 gateway-v1
    // 从 sourcePath 派生输出，此处不再双写 ref，避免两个路径源漂移）。
    const fileName = `${task.mediaId}.out.wav`;
    fs.mkdirSync(cfg.outDir, { recursive: true });
    const filePath = path.join(cfg.outDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(result.wavBase64, 'base64'));
    try {
      const row = media.get(task.mediaId);
      if (row) media.put({ ...row, sourcePath: filePath, status: 'ready' });
    } catch { /* 回写失败不阻断：desc 更新照常 */ }
    media.updateDesc(task.mediaId, {
      desc: task.text.slice(0, cfg.maxTextChars),
      textContent: task.text,
      tags: ['语音', '克隆合成', `${task.role}/${task.emotion}`],
      status: 'ready',
    });
    logger(`[voice-synth] ${task.mediaId} ready（${result.elapsedMs ?? '?'}ms，${task.role}/${task.emotion}）`);
  }

  async function loop() {
    if (running || stopped) return;
    running = true;
    try {
      while (queue.length > 0 && !stopped) {
        const task = queue.shift();
        if (Date.now() - task.createdAt > cfg.taskTimeoutMs) {
          media.updateDesc(task.mediaId, { desc: '合成超时：任务排队过久被清理（可重新发起）', status: 'failed' });
          continue;
        }
        // 等 tts-svc ready（GPT-SoVITS 冷启动/按需 spawn 慢，轮询等待）
        let waited = 0;
        while (!hub?.ttsReady && waited < cfg.taskTimeoutMs) {
          await new Promise((r) => setTimeout(r, cfg.pollMs));
          waited += cfg.pollMs;
          if (stopped) break;
        }
        if (stopped) break;
        if (!hub?.ttsReady) {
          media.updateDesc(task.mediaId, { desc: '合成失败：tts 服务长时间不可用', status: 'failed' });
          continue;
        }
        await runOne(task);
      }
    } catch (err) {
      logger(`[voice-synth] worker 异常：${err?.stack ?? err}`);
    } finally {
      running = false;
      // 异常退出后若还有积压，重新驱动
      if (!stopped && queue.length > 0) setTimeout(() => { void loop(); }, 1000);
    }
  }

  return {
    /**
     * 提交合成任务：voice-bank 解析角色/情绪参考音频 → 登记 voice 资产（pending）
     * 并入队，立即返回 mediaId。失败返回 { ok:false, reason, note? }。
     */
    async submit({ text, sessionId, role, emotion, personaKeywords } = {}) {
      const content = String(text ?? '').trim();
      if (!content) return { ok: false, reason: 'text-required' };
      if (content.length > 500) return { ok: false, reason: 'text-too-long', max: 500 };
      if (!cfg.outDir) return { ok: false, reason: 'voice-lib-not-configured' };
      if (!hub?.ttsEnabled) return { ok: false, reason: 'tts-disabled', note: 'TTS 子服务未启用（MEMORY_MCP_MODEL_HUB_TTS=1）' };
      const ref = bank?.resolve?.({ role, emotion, personaKeywords });
      if (!ref?.ok) {
        return {
          ok: false,
          reason: ref?.reason ?? 'no-reference',
          note: '参考音频解析失败：用 chat_voice_bank_list 查看可用角色与情绪集，或在 audios/[角色]/config.json 登记',
        };
      }
      const mediaId = `ma_${crypto.randomBytes(6).toString('hex')}`;
      // 分段命名：产物 = <mediaId>.out.wav（.out 段=合成产物生命周期）；落盘在
      // runOne 完成后回写 source_path（ref 列已退役，入队不再写占位凭据）。
      await media.ensureAssets({
        sessionId: String(sessionId ?? 'voice_lib'),
        media: [{ id: mediaId, kind: 'voice', origin: 'voice_lib', sourcePath: '' }],
      });
      // 立即转 synthesizing（2026-11-26）：合成需 25-90s > analyzer 60s 兜底轮，
      // 留在 pending 会被 no-audio-data 误杀（实测 ma_ce8080da1d1a）。
      media.markSynthesizing(mediaId);
      queue.push({
        mediaId,
        text: content,
        refPath: ref.refPath,
        promptText: ref.promptText,
        role: ref.role,
        emotion: ref.emotion,
        createdAt: Date.now(),
      });
      setTimeout(() => { void loop(); }, 0);
      return { ok: true, mediaId, role: ref.role, emotion: ref.emotion, status: 'synthesizing', queueDepth: queue.length };
    },
    status() {
      return { queueDepth: queue.length, running, outDir: cfg.outDir };
    },
    stop() { stopped = true; },
  };
}
