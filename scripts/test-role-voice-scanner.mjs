/**
 * role-voice-scanner 集成回归（2026-11-26）：目录即数据库架构——
 * scan 扫描角色夹 config.json（跳过 inbox/out 保留名与坏 JSON 夹）+ 角色四字段
 * 匹配与情绪回落链 + promote 写回角色夹（同情绪 -n 序号新录音优先）+ 新角色自动建夹。
 * 临时目录真文件布局，零 mock。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createRoleVoiceScanner } = await import('../src/service/role-voice-scanner.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'role-voice-'));
const voiceDir = path.join(root, 'audios');
const inboxDir = path.join(root, 'state', 'audio', 'inbox');
fs.mkdirSync(inboxDir, { recursive: true });

const wav = (n = 16) => Buffer.alloc(n, 0x7f);
const writeCfg = (folder, cfg) => {
  fs.mkdirSync(path.join(voiceDir, folder), { recursive: true });
  fs.writeFileSync(path.join(voiceDir, folder, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
};
const writeWav = (folder, file, buf = wav()) => {
  fs.mkdirSync(path.join(voiceDir, folder), { recursive: true });
  fs.writeFileSync(path.join(voiceDir, folder, file), buf);
};

const logs = [];
const scanner = createRoleVoiceScanner({
  voiceDir,
  inboxDir,
  config: { pruneDays: 3 },
  logger: (m) => logs.push(m),
});

// ---------- 1) 空库：resolve 报 voice-bank-empty ----------
assert.equal(scanner.resolve({ role: '雪露' }).reason, 'voice-bank-empty', '空库报 voice-bank-empty');
assert.deepEqual(scanner.listRoles(), [], '空库 listRoles 为空');

// ---------- 2) scan：两角色 + 保留名 inbox/out/broken 夹跳过 ----------
writeCfg('雪露', {
  id: 'snowluma', nameEn: 'xuelu', nameZh: '雪露', aliases: ['雪露露'],
  defaultEmotion: '平静',
  audios: [{ file: '平静.wav', emotion: '平静', promptText: '今天天气真好。' }],
});
writeWav('雪露', '平静.wav');
writeCfg('小蓝', {
  id: 'blue', nameEn: 'Blue', nameZh: '小蓝', aliases: [],
  defaultEmotion: '开心',
  audios: [
    { file: '开心.wav', emotion: '开心', promptText: '太棒了！' },
    { file: '难过.wav', emotion: '难过', promptText: '呜……' },
  ],
});
writeWav('小蓝', '开心.wav');
writeWav('小蓝', '难过.wav');
fs.mkdirSync(path.join(voiceDir, 'inbox'), { recursive: true });
fs.writeFileSync(path.join(voiceDir, 'inbox', 'staged.wav'), wav());
fs.mkdirSync(path.join(voiceDir, 'out'), { recursive: true });
fs.writeFileSync(path.join(voiceDir, 'out', 'ma_x.wav'), wav());
fs.mkdirSync(path.join(voiceDir, 'broken'), { recursive: true });
fs.writeFileSync(path.join(voiceDir, 'broken', 'config.json'), '{bad json');

const roles = scanner.listRoles();
assert.equal(roles.length, 2, `只扫出两个角色（跳过 inbox/out/broken）：实际 ${roles.length}`);
const xuelu = roles.find((r) => r.nameZh === '雪露');
assert.ok(xuelu, '雪露在列');
assert.equal(xuelu.id, 'snowluma', 'id 透传');
assert.deepEqual(xuelu.aliases, ['雪露露'], 'aliases 透传');
assert.ok(xuelu.keywords.includes('雪露露'), 'keywords 含别名');

// ---------- 3) resolve：四字段匹配 + 情绪回落链 + 人设关键词 ----------
{
  const byZh = scanner.resolve({ role: '雪露', emotion: '平静' });
  assert.ok(byZh.ok && byZh.role === '雪露', '中文名匹配');
  assert.equal(byZh.refPath, path.join(voiceDir, '雪露', '平静.wav'), 'refPath 指角色夹');
  assert.equal(byZh.promptText, '今天天气真好。', 'promptText 透传');
  const byAlias = scanner.resolve({ role: '雪露露' });
  assert.ok(byAlias.ok && byAlias.role === '雪露', '别名匹配');
  const byEn = scanner.resolve({ role: 'BLUE', emotion: '难过' });
  assert.ok(byEn.ok && byEn.role === '小蓝', '英文名大小写不敏感');
  const byId = scanner.resolve({ role: 'blue' });
  assert.ok(byId.ok && byId.role === '小蓝', 'id 匹配');
  const fallbackDefault = scanner.resolve({ role: '小蓝', emotion: '愤怒' });
  assert.ok(fallbackDefault.ok && fallbackDefault.emotion === '开心', '情绪回落到 defaultEmotion');
  writeCfg('小蓝', {
    id: 'blue', nameEn: 'Blue', nameZh: '小蓝', aliases: [],
    defaultEmotion: '冷静',
    audios: [{ file: '难过.wav', emotion: '难过', promptText: '呜……' }],
  });
  const fallbackAny = scanner.resolve({ role: '小蓝', emotion: '愤怒' });
  assert.ok(fallbackAny.ok && fallbackAny.emotion === '难过', 'defaultEmotion 无音频 → 回落任一可用');
  const byPersona = scanner.resolve({ personaKeywords: ['雪露露', '活泼'] });
  assert.ok(byPersona.ok && byPersona.role === '雪露', 'personaKeywords 自动匹配');
  assert.equal(scanner.resolve({ role: '不存在' }).reason, 'role-not-found', '未知角色报 role-not-found');
}

// ---------- 4) promote：现有角色写回 config.json + 同情绪 -n 序号 ----------
{
  const src = path.join(root, 'stage.wav');
  fs.writeFileSync(src, wav(64));
  const r1 = scanner.promote({ sourcePath: src, role: '雪露', emotion: '开心', promptText: '好开心呀。' });
  assert.ok(r1.ok && r1.ref === '雪露/开心.wav', '归档落角色夹');
  assert.ok(fs.existsSync(path.join(voiceDir, '雪露', '开心.wav')), '音频文件已复制');
  const cfgOnDisk = JSON.parse(fs.readFileSync(path.join(voiceDir, '雪露', 'config.json'), 'utf8'));
  assert.equal(cfgOnDisk.audios.find((a) => a.emotion === '开心').promptText, '好开心呀。', 'config.json 已写回');
  assert.equal(cfgOnDisk.id, 'snowluma', '既有 config.json 字段保留');
  const r2 = scanner.promote({ sourcePath: src, role: '雪露', emotion: '开心', promptText: '重录版。' });
  assert.ok(r2.ok && r2.ref === '雪露/开心-2.wav', '同情绪落 -n 序号');
  const cfg2 = JSON.parse(fs.readFileSync(path.join(voiceDir, '雪露', 'config.json'), 'utf8'));
  const entries = cfg2.audios.filter((a) => a.emotion === '开心');
  assert.equal(entries.length, 1, '同情绪只保留一条登记');
  assert.equal(entries[0].file, '开心-2.wav', '登记指向新录音');
  const fresh = scanner.resolve({ role: '雪露', emotion: '开心' });
  assert.ok(fresh.ok && fresh.refPath.endsWith('开心-2.wav'), 'promote 后 resolve 热加载命中新音频');
  assert.equal(scanner.promote({ sourcePath: src, role: '雪露', emotion: '平静' }).reason, 'prompt-text-required', '缺 promptText 拒绝');
  assert.equal(scanner.promote({ sourcePath: src, role: '', emotion: '平静', promptText: 'x' }).reason, 'role-required', '缺 role 拒绝');
  assert.equal(scanner.promote({ sourcePath: path.join(root, 'gone.wav'), role: '雪露', emotion: '平静', promptText: 'x' }).reason, 'source-missing', '源文件缺失拒绝');
}

// ---------- 5) promote：新角色自动建夹（中文名 → 夹名 + 别名回填 + id=夹名） ----------
{
  const src = path.join(root, 'stage2.wav');
  fs.writeFileSync(src, wav(32));
  const r = scanner.promote({ sourcePath: src, role: '阿紫', emotion: '平静', promptText: '你好呀。' });
  assert.ok(r.ok && r.ref === '阿紫/平静.wav', '新角色建夹归档');
  const cfgOnDisk = JSON.parse(fs.readFileSync(path.join(voiceDir, '阿紫', 'config.json'), 'utf8'));
  assert.equal(cfgOnDisk.id, '阿紫', '新角色 id 缺省取夹名');
  assert.equal(cfgOnDisk.nameZh, '阿紫', 'nameZh 取角色名');
  assert.equal(cfgOnDisk.defaultEmotion, '平静', 'defaultEmotion 缺省平静');
  assert.equal(cfgOnDisk.audios.length, 1, 'audios 登记一条');
  assert.ok(scanner.resolve({ role: '阿紫' }).ok, '新角色 resolve 可命中');
}

// ---------- 6) 分段命名 prune：.in 段走清退管道、未接线时不动带 id 文件 ----------
{
  assert.equal(scanner.inboxDir(), inboxDir, 'inboxDir 透传装配值');
  const staleIn = path.join(inboxDir, 'ma_aaaa00000001.in.wav');
  const freshIn = path.join(inboxDir, 'ma_bbbb00000001.in.wav');
  fs.writeFileSync(staleIn, wav());
  fs.writeFileSync(freshIn, wav());
  const past = new Date(Date.now() - 4 * 24 * 3600 * 1000);
  fs.utimesSync(staleIn, past, past); // mtime 拨回 4 天前（> pruneDays=3）
  scanner.start(); // start() 立即跑一轮 prune；主 scanner 无 retireAsset → 带段文件不动（安全优先）
  assert.ok(fs.existsSync(staleIn), 'retireAsset 未接线：带段超龄文件保守跳过不裸删');
  assert.ok(fs.existsSync(freshIn), '新鲜暂存文件保留');

  // 接线清退管道的实例：.in 超龄走 retireAsset（管道决定删/豁免）
  const deleted = [];
  const s1 = createRoleVoiceScanner({
    voiceDir,
    inboxDir,
    config: { pruneDays: 3 },
    retireAsset: async (row) => {
      if (row.id === 'ma_bbbb00000001') return { skipped: 'favorited' }; // 收藏豁免（管道内判定）
      fs.rmSync(row.sourcePath, { force: true });
      deleted.push(row.id);
      return { retired: row.id, memoryRows: 0, rawRows: 0 };
    },
    logger: (m) => logs.push(m),
  });
  s1.start();
  assert.ok(!fs.existsSync(staleIn), '超龄 .in 走清退管道删除');
  assert.ok(fs.existsSync(freshIn), '管道报收藏豁免的文件保留');
  assert.deepEqual(deleted, ['ma_aaaa00000001'], '管道收到正确 id');
  assert.ok(logs.some((m) => m.includes('inbox 清扫')), '清扫日志');
}

// ---------- 6b) 三区合一 prune：.out 段 7 天 / 无段名 30 天兜底 / 同目录去重 ----------
{
  const outDir = path.join(root, 'state', 'audio', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const past8d = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  const past40d = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  const staleOut = path.join(outDir, 'ma_cccc00000001.out.wav');
  const staleFav = path.join(outDir, 'ma_dddd00000001.out.wav');
  const plainOld = path.join(outDir, 'clone-test.wav'); // 无段名 8 天：< 30 天兜底 → 保留
  const plainAncient = path.join(outDir, 'ancient.wav'); // 无段名 40 天：> 兜底 → 直删
  for (const f of [staleOut, staleFav, plainOld, plainAncient]) fs.writeFileSync(f, wav());
  fs.utimesSync(staleOut, past8d, past8d);
  fs.utimesSync(staleFav, past8d, past8d);
  fs.utimesSync(plainOld, past8d, past8d);
  fs.utimesSync(plainAncient, past40d, past40d);
  const s2 = createRoleVoiceScanner({
    voiceDir,
    inboxDir: outDir, // 三区合一：与 outDir 同目录
    outDir,
    config: { pruneDays: 3, outPruneDays: 7, unsegmentedPruneDays: 30 },
    retireAsset: async (row) => {
      if (row.id === 'ma_dddd00000001') return { skipped: 'favorited' };
      fs.rmSync(row.sourcePath, { force: true });
      return { retired: row.id, memoryRows: 0, rawRows: 0 };
    },
    logger: (m) => logs.push(m),
  });
  s2.start(); // 启动钩子立即跑一轮（同目录去重，实际扫一次）
  assert.ok(!fs.existsSync(staleOut), '超龄 .out 走清退管道删除');
  assert.ok(fs.existsSync(staleFav), '收藏的合成语音豁免清扫');
  assert.ok(fs.existsSync(plainOld), '无段名 8 天保留（< 30 天兜底）');
  assert.ok(!fs.existsSync(plainAncient), '无段名 40 天超兜底直删');
  assert.ok(logs.some((m) => m.includes('清扫')), '清扫日志');
}

// ---------- 7) 缓存指纹：config 未变不重扫（日志无异常即通过） ----------
assert.deepEqual(scanner.listRoles().map((r) => r.nameZh).sort(), ['小蓝', '雪露', '阿紫'].sort(), '最终角色清单');

console.log('test-role-voice-scanner: all assertions passed');
