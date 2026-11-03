// stdio MCP server：把记忆与黑话能力暴露成工具，供 DSH（任何 MCP 客户端）调用。
//
// 契约上的两条原则：
//   1. 工具直接返回**可直接拼接的提示词段落**（memory_context_render），不要求调用方理解内部数据结构。
//   2. 写失败必须抛错透传，绝不返回假成功 —— 沿用 qq-bridge 的既有原则。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }] });

export function createMcpMemoryServer({ memory, slang }) {
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

  return server;
}

export async function serveStdio({ memory, slang }) {
  const server = createMcpMemoryServer({ memory, slang });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
