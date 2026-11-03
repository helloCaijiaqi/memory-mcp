# memory-mcp

会话记忆 + 黑话/网络用语学习。与 qq-bridge **平级部署**，与 QQ 无关（将来接微信可直接复用）。

- 记忆：短期 / 长期分层 + 巩固；遗忘四件套（时间衰减、容量淘汰、软遗忘归档、硬删除）
- 检索：SQLite FTS5（trigram），查询词 < 3 字符自动降级 `LIKE`（trigram 对短查询静默 0 命中）
- 黑话：n-gram + 互信息 + 左右熵的规则发现（零模型依赖），可选 LLM 解释（默认关）
- 存储：Node 内置 `node:sqlite`（Node ≥ 22.13，24.x 起免 `--experimental-sqlite`）

## 用法

```bash
npm install
npm start          # stdio MCP（DSH）+ 回环 HTTP（127.0.0.1:7181）
npm test           # 全量单测
npm run migrate    # 从 qq-bridge 复制式导入（原件不动，留 .bak）
npm run backup     # 快照到 state/backups/，保留最近 7 份
```

## 接口

| 入口 | 说明 |
| --- | --- |
| stdio MCP | `memory_append / query / touch / forget / restore / consolidate / context_render`、`slang_discover / query / submit / confirm / reject` |
| 回环 HTTP | 同上能力的 `/api/*` 路由；只监听 127.0.0.1，非回环 403，需本地令牌 |

段落契约（与 rolecard-mcp 共用）：

```js
{ blocks: [{ name: '记忆' | '黑话', text, chars }], truncated }
```

## sessionId

只认 `platform:scope:id`（如 `qq:group:123456`）。`group:群号` → `qq:group:群号` 的映射由平台桥接负责，
本服务不解析平台语义。

## 配置

| 变量 | 默认 |
| --- | --- |
| `MEMORY_MCP_HTTP_PORT` | `7181` |
| `MEMORY_MCP_TOKEN` | 自动生成并存 `state/http-token`（`0o600`） |
| `MEMORY_MCP_DATA_DIR` | `<包>/state` |

详见 qq-bridge 的 `docs/guides/MEMORY_MCP.md`。

## 许可

MIT，见 [LICENSE](LICENSE)。
