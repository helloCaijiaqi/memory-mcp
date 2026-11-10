// stdio MCP server：把记忆与黑话能力暴露成工具，供 DSH（任何 MCP 客户端）调用。
//
// 契约上的两条原则：
//   1. 工具直接返回**可直接拼接的提示词段落**（memory_context_render），不要求调用方理解内部数据结构。
//   2. 写失败必须抛错透传，绝不返回假成功 —— 沿用 qq-bridge 的既有原则。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }] });

export function createMcpMemoryServer({ memory, slang, relation, raw, recall }) {
  const server = new McpServer({ name: 'memory-mcp', version: '0.1.0' });

  server.tool(
    'memory_append',
    '写入一条记忆。tier=short 为会话内的短期记忆（默认带一天 TTL），tier=long 为跨会话的长期记忆。',
    {
      sessionId: z.string().describe('platform:scope:id，例如 qq:group:123456'),
      tier: z.enum(['short', 'long']).default('short'),
      content: z.string().min(1),
      category: z.string().optional(),
      importance: z.number().int().min(0).max(10).optional(),
      extra: z.string().optional(),
      expiresAt: z.number().int().optional(),
    },
    async (args) => ok(memory.append(args)),
  );

  server.tool(
    'memory_query',
    '查询记忆。给 text 走全文检索；不按权重排序时默认按最近触及排序。',
    {
      sessionId: z.string().optional(),
      tier: z.enum(['short', 'long']).optional(),
      text: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      includeArchived: z.boolean().optional(),
    },
    async (args) => ok(memory.query(args)),
  );

  server.tool(
    'memory_touch',
    '标记一条记忆被命中：抬权重并刷新触及时间；够格时会自动巩固为长期记忆。',
    { id: z.string().min(1) },
    async (args) => ok(memory.touch(args)),
  );

  server.tool(
    'memory_forget',
    "遗忘一条记忆。mode=soft 归档（不注入但可恢复），mode=hard 物理删除（被遗忘权）。",
    { id: z.string().min(1), mode: z.enum(['soft', 'hard']).default('soft') },
    async (args) => ok(memory.forget(args)),
  );

  server.tool(
    'memory_restore',
    '从归档恢复一条被软遗忘的记忆。',
    { id: z.string().min(1) },
    async (args) => ok(memory.restore(args)),
  );

  server.tool(
    'memory_consolidate',
    '把够格的短期记忆升级为长期记忆；给 sessionId 表示整会话批量执行。',
    { id: z.string().optional(), sessionId: z.string().optional() },
    async (args) => ok(memory.consolidate(args)),
  );

  server.tool(
    'memory_ingest',
    '入站消息落地：原文进原始层、正文进短期记忆，两写一个事务。幂等键是 msgId，重复投递不会产生第二条。',
    {
      sessionId: z.string().describe('platform:scope:id，例如 qq:group:123456'),
      msgId: z.string().min(1).describe('平台消息 id，幂等键与锚点都由它派生'),
      text: z.string(),
      senderId: z.string().optional(),
      kind: z.enum(['episodic', 'semantic', 'relation', 'emotion']).optional(),
      importance: z.number().int().min(0).max(10).optional(),
      createdAt: z.number().int().optional(),
    },
    async (args) => ok(memory.ingest(args)),
  );

  server.tool(
    'memory_record',
    '把一条「值得长期记住」的事实写进长期层（不是每条消息都该记）。内容相同重复上报幂等，不会堆出两条。',
    {
      sessionId: z.string(),
      content: z.string().min(1).describe('要记住的事实，一句话'),
      kind: z.enum(['episodic', 'semantic', 'relation', 'emotion']).default('semantic'),
      subjectId: z.string().optional().describe('这条事实关于谁（平台号或 self）'),
      category: z.string().optional(),
      importance: z.number().int().min(0).max(10).optional(),
    },
    async (args) => ok(memory.record(args)),
  );

  /**
   * 分段注入的三件套。为什么拆开而不是一次给整块：
   * head 是「稳定前缀」（长期事实/关系/黑话），在断点之间逐字节不变，客户端才能命中前缀缓存；
   * tail 每轮都变（当前时间、最近几条、召回、本轮正文）。混在一起每次都变，缓存等于没有。
   */
  server.tool(
    'memory_context_head',
    '产出稳定前缀（【长期记忆】【关系】【情绪】【黑话】）。同一断点内逐字节不变，可安全复用缓存。',
    { sessionId: z.string(), force: z.boolean().optional().describe('强制重建，忽略断点窗口') },
    async (args) => ok(memory.renderHead(args)),
  );

  server.tool(
    'memory_context_tail',
    '产出动态尾部（当前时间、最近几条短期记忆、上次情绪、召回片段、本轮正文）。每轮新拼。',
    { sessionId: z.string(), body: z.string().optional(), recall: z.string().optional() },
    async (args) => ok(memory.renderTail(args)),
  );

  server.tool(
    'memory_context_compose',
    '一次拿到完整注入块：head（可复用）+ tail（本轮新拼）+ 拼接结果 text。桥接通常只用这一个。',
    {
      sessionId: z.string(),
      body: z.string().optional().describe('本轮用户消息，拼在尾部末尾'),
      recall: z.string().optional().describe('外部召回片段（可为空）'),
      force: z.boolean().optional(),
    },
    async (args) => ok(memory.compose(args)),
  );

  server.tool(
    'memory_context_invalidate',
    '手动失效稳定前缀：角色设定变更、记忆被批量改写后调用，下一次渲染必然重建。',
    { sessionId: z.string() },
    async (args) => ok(memory.invalidateHead(args)),
  );

  server.tool(
    'slang_discover',
    '从一批消息里用规则发现黑话候选（n-gram 频次 + 互信息 + 左右熵），不入库、不联网。',
    {
      messages: z.array(z.string()).min(1),
      topN: z.number().int().min(1).max(100).optional(),
    },
    async (args) => ok(slang.discover(args)),
  );

  server.tool(
    'slang_submit',
    '提交一条黑话（默认状态为候选，需确认后才会注入提示词）。',
    {
      content: z.string().min(1),
      meaning: z.string().optional(),
      evidence: z.array(z.string()).optional(),
      status: z.enum(['candidate', 'confirmed', 'rejected']).optional(),
      score: z.number().optional(),
    },
    async (args) => ok(slang.submit(args)),
  );

  server.tool(
    'slang_query',
    '查询黑话词条。',
    {
      text: z.string().optional(),
      status: z.enum(['candidate', 'confirmed', 'rejected']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args) => ok(slang.query(args)),
  );

  server.tool(
    'slang_confirm',
    '确认一条黑话候选（确认后才会进入【黑话】段）。',
    { id: z.string().min(1) },
    async (args) => ok(slang.confirm(args)),
  );

  server.tool(
    'slang_reject',
    '拒绝一条黑话候选（不再注入，但保留记录以免反复发现）。',
    { id: z.string().min(1) },
    async (args) => ok(slang.reject(args)),
  );

  /**
   * 段落渲染：这是平台桥接真正要用的入口 —— 一次拿齐【记忆】【黑话】两段，直接拼进提示词。
   * 桥接不需要知道记忆分几层、黑话怎么打分。
   */
  server.tool(
    'memory_context_render',
    '产出可直接拼接的提示词段落（【记忆】【黑话】），平台桥接拿去即用。',
    { sessionId: z.string().optional(), maxChars: z.number().int().min(1).optional() },
    async (args) => {
      const memoryBlocks = memory.render({ sessionId: args.sessionId, maxChars: args.maxChars }).blocks;
      const slangBlocks = slang.render({}).blocks;
      return ok({ blocks: [...memoryBlocks, ...slangBlocks] });
    },
  );

  // 关系 / 情绪：单值 + 版本链。只在装配了 relation 服务时注册，避免工具存在但一调就报「未装配」。
  if (relation) {
    server.tool(
      'relation_set',
      '写下「现在的事实」：称呼、喜好、约定，或当前情绪（kind=emotion）。同一 (说话人, 键) 只有一条，值变化才留历史。',
      {
        sessionId: z.string(),
        subjectId: z.string().min(1).describe('说话人 id（平台号）'),
        key: z.string().min(1).describe('属性名，如 称呼 / 忌口 / mood'),
        value: z.string(),
        kind: z.enum(['relation', 'emotion']).default('relation'),
        scope: z.enum(['session', 'identity']).default('session'),
        importance: z.number().int().min(0).max(10).optional(),
      },
      async (args) => ok(relation.upsert(args)),
    );

    server.tool(
      'relation_get',
      '读一条关系/情绪的当前值（含版本链里的最新一条）。',
      {
        sessionId: z.string(),
        subjectId: z.string().min(1),
        key: z.string().min(1),
        scope: z.enum(['session', 'identity']).default('session'),
      },
      async (args) => ok(relation.get(args)),
    );

    server.tool(
      'relation_list',
      '列出一个会话的关系或情绪。kind=emotion 只取情绪；不给 kind 取全部。',
      {
        sessionId: z.string(),
        kind: z.enum(['relation', 'emotion']).optional(),
        scope: z.enum(['session', 'identity']).default('session'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      async (args) => ok(relation.list(args)),
    );

    server.tool(
      'relation_history',
      '查一条关系的版本链（谁在什么时候把它改成了什么）。',
      {
        sessionId: z.string(),
        subjectId: z.string().min(1),
        key: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
      },
      async (args) => ok(relation.history(args)),
    );

    server.tool(
      'relation_forget',
      '硬删一条关系，连版本链一起删（被遗忘权：只删当前值等于假装忘了）。',
      { sessionId: z.string(), subjectId: z.string().min(1), key: z.string().min(1) },
      async (args) => ok(relation.forget(args)),
    );
  }

  // 原始层运维：归档与硬删不可撤销，工具描述里必须写清楚破坏性。
  if (raw) {
    server.tool(
      'raw_archive',
      '把超过保留期的原文导出成 gzip 分片并清空正文（保留 msgId/发送者/锚点）。先落盘再改库，可先用 dryRun 看积压。',
      {
        days: z.number().int().min(0).optional(),
        platform: z.string().optional(),
        sessionId: z.string().optional(),
        dryRun: z.boolean().optional(),
      },
      async (args) => ok(raw.archive(args)),
    );

    server.tool(
      'raw_purge',
      '【不可撤销】按消息 / 发言人 / 平台硬删原文，重写归档分片，并清除派生记忆里的 sourceMsgIds 引用。',
      {
        id: z.string().optional(),
        sessionId: z.string().optional(),
        msgId: z.string().optional(),
        senderId: z.string().optional(),
        platform: z.string().optional(),
      },
      async (args) => ok(raw.purge(args)),
    );

    server.tool(
      'raw_backlog',
      '报告待归档的原文条数（计划任务与告警用）。',
      { days: z.number().int().min(0).optional() },
      async (args) => ok(raw.backlog(args)),
    );
  }

  // 主动召回：返回的 text 就是【召回】段正文，模型拿去拼提示词即可，不必自己组织格式。
  if (recall) {
    server.tool(
      'memory_recall',
      '按当前对话内容主动检索记忆（短期记忆被淘汰后还能从原文里捞回）。默认只查本平台；返回可直接用的 text 与结构化 rows。',
      {
        sessionId: z.string(),
        text: z.string().describe('检索词，通常取自用户刚说的话'),
        kinds: z.array(z.enum(['episodic', 'semantic', 'relation', 'emotion'])).optional(),
        subjectId: z.string().optional(),
        platforms: z.array(z.string()).optional().describe('跨平台召回需显式列出平台，且服务端要开启'),
        since: z.number().int().optional(),
        until: z.number().int().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async (args) => ok(recall.recall(args)),
    );
  }

  return server;
}

export async function serveStdio({ memory, slang, relation, raw, recall }) {
  const server = createMcpMemoryServer({ memory, slang, relation, raw, recall });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
