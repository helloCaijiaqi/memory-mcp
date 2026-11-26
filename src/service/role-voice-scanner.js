// role-voice-scanner：角色音色库目录扫描器（目录即数据库，2026-11-26 取代 voice-bank.js）
// 布局：C:\memory-mcp\audios\ 下每个角色一个文件夹，夹内 config.json + 情绪音频：
//   audios/雪露/config.json = { id, nameEn, nameZh, aliases, defaultEmotion, audios:[{file, emotion, promptText}] }
//   audios/雪露/平静.wav     = 参考音频本体（GPT-SoVITS 克隆用）
// 职责：
//   - scan：扫 audios 根目录全部角色夹的 config.json（mtime 指纹缓存，变了才重扫）；
//   - resolve：LLM 传 role/emotion（或人设关键词自动匹配角色）→ 参考音频绝对路径 + prompt 文本；
//     情绪不在声明集 → 回落角色 defaultEmotion → 再回落「平静」→ 任一可用情绪；
//   - promote：把听到的语音（inbox 暂存区）归档为角色参考音频（写角色夹 + 原子更新 config.json；
//     新角色自动建夹，id 缺省取夹名）；
//   - pruneInbox/pruneOut：运行时区超龄自动清理（inbox 3 天可归档窗口；out 合成产物
//     7 天窗口——发完即无用；收藏文件按 mediaId 反查豁免，isFavorited 由装配注入）。
// 配置/运行时分离：voiceDir（配置区，只有角色夹）/ inboxDir、outDir（运行时区）由装配
// 各自独立传入，互不派生——配置区永远不混运行时文件。
import fs from 'node:fs';
import path from 'node:path';

const RESERVED_DIRS = new Set(['inbox', 'out']); // audios 根保留目录名（运行时区），扫描角色夹时跳过
const ROLE_CONFIG = 'config.json';

export function createRoleVoiceScanner({
  voiceDir, // 配置区根目录（audios/）
  inboxDir, // 运行时区（2026-11-26 三区合一：media/qq/audio，收到语音暂存）
  outDir, // 运行时区（与 inboxDir 同目录；合成产物 ma_<id>.out.wav 落盘）
  config = {},
  logger = () => {},
  retireAsset = null, // async ({id, sourcePath}) => 清退管道（media-retention.retireOne 注入）
} = {}) {
  const cfg = {
    pruneDays: Number(config.pruneDays || 3),
    outPruneDays: Number(config.outPruneDays || 7),
    unsegmentedPruneDays: Number(config.unsegmentedPruneDays || 30),
    maxRoles: Number(config.maxRoles || 32),
  };
  let cached = null; // [{ folder, id, nameEn, nameZh, aliases, defaultEmotion, audios }]
  let fingerprint = '';

  /** 目录即数据库：扫 audios 根全部角色夹的 config.json；指纹（根 mtime+各夹 config mtime）不变直接用缓存 */
  function scan() {
    if (!voiceDir) return [];
    let fp = '';
    try {
      const rootStat = fs.statSync(voiceDir);
      const parts = [rootStat.mtimeMs];
      for (const name of fs.readdirSync(voiceDir, { withFileTypes: true })) {
        if (!name.isDirectory() || RESERVED_DIRS.has(name.name)) continue;
        try {
          parts.push(name.name, fs.statSync(path.join(voiceDir, name.name, ROLE_CONFIG)).mtimeMs);
        } catch { /* 无 config.json 的夹：重扫时按缺角色处理 */ }
      }
      fp = parts.join('|');
      if (cached && fp === fingerprint) return cached;
    } catch {
      if (cached) return cached; // 根目录暂不可读：用内存态兜底
      return [];
    }

    const roles = [];
    try {
      for (const name of fs.readdirSync(voiceDir, { withFileTypes: true })) {
        if (!name.isDirectory() || RESERVED_DIRS.has(name.name)) continue;
        const folderAbs = path.join(voiceDir, name.name);
        const cfgPath = path.join(folderAbs, ROLE_CONFIG);
        let parsed;
        try {
          parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        } catch { /* 无 config.json 或坏 JSON：跳过该夹 */ continue; }
        roles.push(normalizeRole(name.name, parsed));
      }
    } catch (err) {
      logger(`[role-voice-scanner] 扫描失败（用内存态兜底）：${err.message}`);
      if (cached) return cached;
      return [];
    }
    cached = roles;
    fingerprint = fp;
    return cached;
  }

  function normalizeRole(folder, parsed) {
    const audios = (Array.isArray(parsed.audios) ? parsed.audios : [])
      .map((a) => ({
        file: String(a?.file ?? '').trim(),
        emotion: String(a?.emotion ?? '').trim() || '平静',
        promptText: String(a?.promptText ?? '').trim(),
      }))
      .filter((a) => a.file);
    return {
      folder,
      id: String(parsed.id ?? folder).trim(),
      nameEn: String(parsed.nameEn ?? '').trim(),
      nameZh: String(parsed.nameZh ?? folder).trim(),
      aliases: (Array.isArray(parsed.aliases) ? parsed.aliases : []).map((x) => String(x).trim()).filter(Boolean),
      defaultEmotion: String(parsed.defaultEmotion ?? '平静').trim() || '平静',
      audios,
    };
  }

  /** 角色匹配字段全集：nameZh / nameEn / id / aliases / 文件夹名，大小写不敏感 */
  function roleNames(role) {
    return [role.nameZh, role.nameEn, role.id, role.folder, ...role.aliases]
      .map((x) => String(x ?? '').trim().toLowerCase())
      .filter(Boolean);
  }

  function findRole(roles, role) {
    const want = String(role ?? '').trim().toLowerCase();
    if (!want) return null;
    return roles.find((r) => roleNames(r).includes(want)) ?? null;
  }

  function pickEmotion(role, emotion) {
    const list = role.audios;
    if (list.length === 0) return null;
    const want = String(emotion ?? '').trim();
    if (want) {
      const hit = list.find((a) => a.emotion === want);
      if (hit) return hit;
    }
    for (const fallback of [role.defaultEmotion, '平静']) {
      const hit = list.find((a) => a.emotion === fallback);
      if (hit) return hit;
    }
    return list[0];
  }

  /** 关键词自动匹配角色：personaKeywords（字符串或数组）命中角色名/别名最多者胜 */
  function matchRoleByKeywords(roles, personaKeywords) {
    const text = Array.isArray(personaKeywords)
      ? personaKeywords.join(' ')
      : String(personaKeywords ?? '');
    if (!text.trim()) return null;
    const lower = text.toLowerCase();
    let best = null;
    let bestScore = 0;
    for (const role of roles) {
      const score = roleNames(role)
        .filter((name) => name.length > 1 && lower.includes(name))
        .length;
      if (score > bestScore) {
        best = role;
        bestScore = score;
      }
    }
    return best;
  }

  /** 原子写角色 config.json（tmp+rename），指纹随之失效 */
  function saveRoleConfig(folderAbs, roleConfig) {
    const cfgPath = path.join(folderAbs, ROLE_CONFIG);
    const tmp = `${cfgPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(roleConfig, null, 2) + '\n');
    fs.renameSync(tmp, cfgPath);
    fingerprint = ''; // 强制下次重扫
  }

  /** 文件名类型段解析（2026-11-26 分段命名）：ma_<id>.<段>.<ext> → { id, seg }；
   *  旧式 ma_<id>.<ext>（迁移过渡）视作 out 段（合成产物）；非 ma_ 命名 → 无段
   *  （用户手动素材，只走兜底窗口，不进清退管道）。 */
  function parseSegment(file) {
    const name = path.basename(file);
    const segged = /^(ma_[0-9a-f]{12})\.(in|out)\./.exec(name);
    if (segged) return { id: segged[1], seg: segged[2] };
    const legacy = /^(ma_[0-9a-f]{12})\./.exec(name);
    if (legacy) return { id: legacy[1], seg: 'out' };
    return { id: null, seg: null };
  }

  /**
   * 运行时区清扫（2026-11-26 分段命名版；inboxDir/outDir 三区合一后指向同一目录，
   * start() 对唯一目录只跑一轮）。按类型段路由生命周期，删除一律走清退管道：
   *   ma_<id>.in.<ext>  → pruneDays（收到暂存 3 天归档窗口）
   *   ma_<id>.out.<ext> → outPruneDays（合成产物 7 天）
   *   无段名            → unsegmentedPruneDays（用户素材 30 天兜底，无 id 不进管道）
   * 带段超龄 → retireAsset 清退管道（删源文件+删详情行+raw 占位符固化；收藏豁免
   *   在管道内单实现）。retireAsset 未接线时不动带 id 文件（安全优先）。
   */
  async function pruneRuntimeArea(dir, label) {
    let retired = 0, removed = 0, skipped = 0;
    try {
      if (!dir || !fs.existsSync(dir)) return { retired, removed, skipped };
      const now = Date.now();
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        let st;
        try { st = fs.statSync(file); if (!st.isFile()) continue; } catch { continue; }
        const { id, seg } = parseSegment(name);
        const days = seg === 'in' ? cfg.pruneDays : seg === 'out' ? cfg.outPruneDays : cfg.unsegmentedPruneDays;
        if (now - st.mtimeMs < days * 24 * 3600 * 1000) continue;
        if (seg) {
          if (typeof retireAsset !== 'function') { skipped += 1; continue; }
          try {
            const r = await retireAsset({ id, sourcePath: file });
            if (r?.retired) retired += 1; else skipped += 1;
          } catch { skipped += 1; }
        } else {
          try { fs.rmSync(file, { force: true }); removed += 1; } catch { /* 单文件失败忽略 */ }
        }
      }
    } catch { /* 目录不可读忽略 */ }
    if (retired || removed || skipped) logger(`[role-voice-scanner] ${label} 清扫：清退 ${retired}、直删 ${removed}、跳过 ${skipped}`);
    return { retired, removed, skipped };
  }

  function pruneInbox() {
    return pruneRuntimeArea(inboxDir, 'inbox');
  }

  /** 合成语音产物清扫：与 inbox 同目录（三区合一）时去重不重跑。 */
  function pruneOut() {
    if (outDir && outDir === inboxDir) return { retired: 0, removed: 0, skipped: 0, dedup: true };
    return pruneRuntimeArea(outDir, 'out');
  }

  return {
    /** 角色清单（LLM 选角色/情绪用） */
    listRoles() {
      return scan().map((role) => ({
        id: role.id,
        nameZh: role.nameZh,
        nameEn: role.nameEn,
        aliases: role.aliases,
        keywords: [role.nameZh, ...role.aliases, role.nameEn].filter(Boolean),
        emotions: [...new Set(role.audios.map((a) => a.emotion))],
        defaultEmotion: role.defaultEmotion,
      }));
    },
    /**
     * 解析合成参考：显式 role 优先（nameZh/nameEn/id/别名/夹名），其次人设关键词匹配。
     * 返回 { ok, role, emotion, refPath, promptText } | { ok:false, reason }
     */
    resolve({ role, emotion, personaKeywords } = {}) {
      const roles = scan();
      if (roles.length === 0) return { ok: false, reason: 'voice-bank-empty' };
      const target = (role && findRole(roles, role))
        ?? matchRoleByKeywords(roles, personaKeywords);
      if (!target) return { ok: false, reason: role ? 'role-not-found' : 'no-role-matched' };
      const picked = pickEmotion(target, emotion);
      if (!picked) return { ok: false, reason: 'no-emotion-ref' };
      const refPath = path.join(voiceDir, target.folder, picked.file);
      if (!fs.existsSync(refPath)) {
        return { ok: false, reason: 'ref-file-missing', ref: picked.file };
      }
      return {
        ok: true,
        role: target.nameZh,
        emotion: picked.emotion,
        refPath,
        promptText: picked.promptText,
      };
    },
    /**
     * 归档：把一条已转写语音的暂存文件复制进角色夹并更新其 config.json。
     * 新角色自动建夹（夹名=消毒后的角色名，id 缺省取夹名）；同情绪已有参考则
     * 落 -n.wav 序号并以新音频覆盖登记（新录音优先）。
     * sourcePath 为空/文件缺失 → { ok:false, reason:'source-missing' }（转写后源文件已删的老资产不可归档）。
     */
    promote({ sourcePath, role, emotion, promptText } = {}) {
      const roleName = String(role ?? '').trim();
      const emotionName = String(emotion ?? '').trim() || '平静';
      if (!roleName) return { ok: false, reason: 'role-required' };
      if (!sourcePath || !fs.existsSync(sourcePath)) return { ok: false, reason: 'source-missing' };
      if (!promptText || !String(promptText).trim()) return { ok: false, reason: 'prompt-text-required' };
      if (!voiceDir) return { ok: false, reason: 'voice-lib-not-configured' };
      const roles = scan();

      const existing = findRole(roles, roleName);
      const folder = existing?.folder ?? roleName.replace(/[\\/:*?"<>|]/g, '');
      if (!folder) return { ok: false, reason: 'role-required' };
      if (!existing && roles.length >= cfg.maxRoles) return { ok: false, reason: 'role-limit' };

      const folderAbs = path.join(voiceDir, folder);
      fs.mkdirSync(folderAbs, { recursive: true });
      const safeEmotion = emotionName.replace(/[\\/:*?"<>|]/g, '') || '平静';
      let file = `${safeEmotion}.wav`;
      let n = 2;
      while (fs.existsSync(path.join(folderAbs, file))) {
        file = `${safeEmotion}-${n}.wav`;
        n += 1;
      }
      fs.copyFileSync(sourcePath, path.join(folderAbs, file));

      const roleConfig = existing
        ? readRoleConfig(folderAbs, folder)
        : {
          id: folder,
          nameEn: '',
          nameZh: roleName,
          aliases: [],
          defaultEmotion: '平静',
          audios: [],
        };
      if (!existing && roleName !== folder) roleConfig.aliases.push(roleName);
      const entry = { file, emotion: emotionName, promptText: String(promptText).trim() };
      const prevIdx = roleConfig.audios.findIndex((a) => a.emotion === emotionName);
      if (prevIdx >= 0) roleConfig.audios[prevIdx] = entry;
      else roleConfig.audios.push(entry);
      saveRoleConfig(folderAbs, roleConfig);

      logger(`[role-voice-scanner] 归档参考音频：${roleName}/${emotionName} → ${folder}/${file}`);
      return { ok: true, role: roleName, emotion: emotionName, ref: `${folder}/${file}` };
    },
    /** inbox 暂存目录（analyzer 转写完成后把语音源文件挪到这里） */
    inboxDir() {
      return inboxDir ?? '';
    },
    /** 周期清理：inbox 暂存（3 天）+ out 合成产物（7 天）超龄文件（unref 定时器，
     *  随进程退出；启动钩子立即跑一轮） */
    start() {
      // 三区合一后 inboxDir === outDir：pruneOut 内部去重，实际每轮只扫一次
      const timer = setInterval(() => { pruneInbox(); pruneOut(); }, 6 * 3600 * 1000);
      timer.unref?.();
      pruneInbox();
      pruneOut();
    },
  };
}

function readRoleConfig(folderAbs, folder) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(folderAbs, ROLE_CONFIG), 'utf8'));
    return {
      id: String(parsed.id ?? folder).trim(),
      nameEn: String(parsed.nameEn ?? '').trim(),
      nameZh: String(parsed.nameZh ?? folder).trim(),
      aliases: (Array.isArray(parsed.aliases) ? parsed.aliases : []).map((x) => String(x).trim()).filter(Boolean),
      defaultEmotion: String(parsed.defaultEmotion ?? '平静').trim() || '平静',
      audios: (Array.isArray(parsed.audios) ? parsed.audios : [])
        .map((a) => ({
          file: String(a?.file ?? '').trim(),
          emotion: String(a?.emotion ?? '').trim() || '平静',
          promptText: String(a?.promptText ?? '').trim(),
        }))
        .filter((a) => a.file),
    };
  } catch {
    return { id: folder, nameEn: '', nameZh: folder, aliases: [], defaultEmotion: '平静', audios: [] };
  }
}
