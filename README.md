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
npm run install:dsh # 把 mcp-memory 登记进 DSH（--global / --check / --remove）
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

## 装进 DSH

本服务自己负责 DSH 侧的登记（`scripts/install-dsh.mjs`），不依赖 qq-bridge 的 `setup-dsh.mjs`：

```bash
npm run install:dsh              # web profile（默认）
npm run install:dsh -- work      # 指定 profile
npm run install:dsh -- --global  # home 层，所有 profile 生效
npm run install:dsh -- --check   # 只检查（未登记 / 路径不符时退出码 1）
npm run install:dsh -- --remove  # 卸载
```

- 只写自己那段 `# === memory-mcp MCP BEGIN/END ===` 区块，`cordis.patch.yml` 里其他内容一个字节不动；
- 写完**不用**重启 DSH（条目热加载），新建会话即可看到 `mcp__memory__*`；
- 换机 / 换目录后必须重跑——patch 里存的是绝对路径；
- 若曾跑过 `qq-bridge/scripts/setup-dsh.mjs`：它会整体重写 patch、把区块标记抹掉。条目仍在、工具照常可用（`--check` 也会通过），要让本脚本重新纳管就先删掉那条 `mcp-memory` 条目再重跑。

## 配置

| 变量 | 默认 |
| --- | --- |
| `MEMORY_MCP_HTTP_PORT` | `7181` |
| `MEMORY_MCP_TOKEN` | 自动生成并存 `state/http-token`（`0o600`） |
| `MEMORY_MCP_DATA_DIR` | `<包>/state` |

详见 qq-bridge 的 `docs/guides/MEMORY_MCP.md`。

## 许可

MIT，见 [LICENSE](LICENSE)。
