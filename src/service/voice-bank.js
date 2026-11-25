// voice-bank：角色音色库（voice_bank.json，GPT-SoVITS 克隆合成的参考音频登记处）
// 结构：角色 → 人设关键词 → 声明情绪集 → 情绪 → 参考音频（ref 相对 voiceLibDir + promptText）
// 职责：
//   - resolve：LLM 传 role/emotion（或人设卡关键词自动匹配角色）→ 参考音频绝对路径 + prompt 文本；
//     情绪不在声明集 → 回落角色 defaultEmotion → 再回落「平静」→ 任一可用情绪；
//   - promote：把听到的语音（inbox 暂存区）归档为音色参考（复制进 voice_lib，写回 bank）；
//   - pruneInbox：暂存区超龄自动清理（语音详情记录不留源文件的折衷：先入 inbox，
//     3 天内可被归档为参考，否则删除——资源可控且克隆有料可用）。
// 频律：bank 文件 mtime 变化即热加载；写入走 tmp+rename 原子替换。
import fs from 'node:fs';
import path from 'node:path';

const BANK_VERSION = 1;

export function createVoiceBank({
  bankPath,
  defaultLibDir = '',
  config = {},
  logger = () => {},
} = {}) {
  const cfg = {
    pruneDays: Number(config.pruneDays || 3),
    maxRoles: Number(config.maxRoles || 32),
  };
  let cached = null;
  let cachedMtimeMs = -1;

  function load() {
    try {
      const stat = fs.statSync(bankPath);
      if (cached && stat.mtimeMs === cachedMtimeMs) return cached;
      const parsed = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
      cached = {
        version: parsed.version ?? BANK_VERSION,
        voiceLibDir: String(parsed.voiceLibDir ?? defaultLibDir ?? '').trim(),
        roles: Array.isArray(parsed.roles) ? parsed.roles : [],
      };
      cachedMtimeMs = stat.mtimeMs;
    } catch (err) {
      if (!cached) cached = { version: BANK_VERSION, voiceLibDir: String(defaultLibDir ?? '').trim(), roles: [] };
      logger(`[voice-bank] 加载失败（用内存态兜底）：${err.message}`);
    }
    return cached;
  }

  function save(bank) {
    const tmp = `${bankPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...bank, version: BANK_VERSION }, null, 2) + '\n');
    fs.renameSync(tmp, bankPath);
    cached = bank;
    cachedMtimeMs = fs.statSync(bankPath).mtimeMs;
  }

  function libDir(bank) {
    return bank.voiceLibDir || String(defaultLibDir ?? '').trim();
  }

  function resolveRefPath(bank, ref) {
    const p = String(ref ?? '').trim();
    if (!p) return '';
    return path.isAbsolute(p) ? p : path.join(libDir(bank), p);
  }

  function findRole(bank, role) {
    const want = String(role ?? '').trim().toLowerCase();
    if (!want) return null;
    return bank.roles.find((r) => String(r.role ?? '').trim().toLowerCase() === want) ?? null;
  }

  function pickEmotion(role, emotion) {
    const emotions = role?.emotions ?? {};
    const keys = Object.keys(emotions);
    if (keys.length === 0) return null;
    const want = String(emotion ?? '').trim();
    if (want && emotions[want]) return { name: want, entry: emotions[want] };
    for (const fallback of [role?.defaultEmotion, '平静']) {
      if (fallback && emotions[fallback]) return { name: fallback, entry: emotions[fallback] };
    }
    return { name: keys[0], entry: emotions[keys[0]] };
  }

  /** 关键词自动匹配角色：personaKeywords（字符串或数组）命中角色关键词最多者胜 */
  function matchRoleByKeywords(bank, personaKeywords) {
    const text = Array.isArray(personaKeywords)
      ? personaKeywords.join(' ')
      : String(personaKeywords ?? '');
    if (!text.trim()) return null;
    let best = null;
    let bestScore = 0;
    for (const role of bank.roles) {
      const score = (Array.isArray(role.keywords) ? role.keywords : [])
        .reduce((acc, kw) => acc + (kw && text.includes(String(kw)) ? 1 : 0), 0);
      if (score > bestScore) {
        best = role;
        bestScore = score;
      }
    }
    return best;
  }

  function pruneInbox() {
    const bank = load();
    const inbox = path.join(libDir(bank), 'inbox');
    let removed = 0;
    try {
      if (!fs.existsSync(inbox)) return removed;
      const cutoff = Date.now() - cfg.pruneDays * 24 * 3600 * 1000;
      for (const name of fs.readdirSync(inbox)) {
        const file = path.join(inbox, name);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) {
            fs.rmSync(file, { force: true });
            removed += 1;
          }
        } catch { /* 单文件失败忽略 */ }
      }
    } catch { /* 目录不可读忽略 */ }
    if (removed) logger(`[voice-bank] inbox 清理 ${removed} 个超龄暂存文件`);
    return removed;
  }

  return {
    /** 角色清单（LLM 选角色/情绪用） */
    listRoles() {
      const bank = load();
      return bank.roles.map((role) => ({
        role: role.role,
        keywords: role.keywords ?? [],
        emotions: Object.keys(role.emotions ?? {}),
        defaultEmotion: role.defaultEmotion ?? '平静',
      }));
    },
    /**
     * 解析合成参考：显式 role 优先，其次人设关键词匹配。
     * 返回 { ok, role, emotion, refPath, promptText } | { ok:false, reason }
     */
    resolve({ role, emotion, personaKeywords } = {}) {
      const bank = load();
      if (bank.roles.length === 0) return { ok: false, reason: 'voice-bank-empty' };
      const target = (role && findRole(bank, role))
        ?? matchRoleByKeywords(bank, personaKeywords);
      if (!target) return { ok: false, reason: role ? 'role-not-found' : 'no-role-matched' };
      const picked = pickEmotion(target, emotion);
      if (!picked) return { ok: false, reason: 'no-emotion-ref' };
      const refPath = resolveRefPath(bank, picked.entry.ref);
      if (!refPath || !fs.existsSync(refPath)) {
        return { ok: false, reason: 'ref-file-missing', ref: picked.entry.ref };
      }
      return {
        ok: true,
        role: target.role,
        emotion: picked.name,
        refPath,
        promptText: String(picked.entry.promptText ?? '').trim(),
      };
    },
    /**
     * 归档：把一条已转写语音的暂存文件复制进 voice_lib 并登记到 bank。
     * sourcePath 为空/文件缺失 → { ok:false, reason:'source-missing' }（转写后源文件已删的老资产不可归档）。
     */
    promote({ sourcePath, role, emotion, promptText } = {}) {
      const bank = load();
      const roleName = String(role ?? '').trim();
      const emotionName = String(emotion ?? '').trim() || '平静';
      if (!roleName) return { ok: false, reason: 'role-required' };
      if (!sourcePath || !fs.existsSync(sourcePath)) return { ok: false, reason: 'source-missing' };
      if (!promptText || !String(promptText).trim()) return { ok: false, reason: 'prompt-text-required' };
      const dir = libDir(bank);
      if (!dir) return { ok: false, reason: 'voice-lib-not-configured' };

      fs.mkdirSync(path.join(dir, 'voices'), { recursive: true });
      const safeRole = roleName.replace(/[\\/:*?"<>|]/g, '');
      const safeEmotion = emotionName.replace(/[\\/:*?"<>|]/g, '');
      let refRel = `voices/${safeRole}-${safeEmotion}.wav`;
      let n = 2;
      while (fs.existsSync(path.join(dir, refRel))) {
        refRel = `voices/${safeRole}-${safeEmotion}-${n}.wav`;
        n += 1;
      }
      fs.copyFileSync(sourcePath, path.join(dir, refRel));

      let entry = findRole(bank, roleName);
      if (!entry) {
        if (bank.roles.length >= cfg.maxRoles) return { ok: false, reason: 'role-limit' };
        entry = { role: roleName, keywords: [roleName], emotions: {}, defaultEmotion: '平静' };
        bank.roles.push(entry);
      }
      entry.emotions = entry.emotions ?? {};
      entry.emotions[emotionName] = { ref: refRel, promptText: String(promptText).trim() };
      save(bank);
      logger(`[voice-bank] 归档参考音频：${roleName}/${emotionName} → ${refRel}`);
      return { ok: true, role: roleName, emotion: emotionName, ref: refRel };
    },
    /** inbox 暂存目录（analyzer 转写完成后把语音源文件挪到这里） */
    inboxDir() {
      const bank = load();
      return path.join(libDir(bank), 'inbox');
    },
    /** 周期清理：暂存超龄文件（unref 定时器，随进程退出） */
    start() {
      const timer = setInterval(() => pruneInbox(), 6 * 3600 * 1000);
      timer.unref?.();
      pruneInbox();
    },
  };
}
