# memory-mcp

会话记忆 + 黑话/网络用语学习。与 qq-bridge **平级部署**，与 QQ 无关（接微信等新平台只需产出同形状的 `sessionId`）。

- 记忆：**会话纪元模型** —— 短期记忆由 DSH 上下文承担，本服务只管「跨会话」：raw 全量落地 + 长期摘要
- 原始层：入站/出站消息经网关防抖成批落地（50 条或 30s 窗口），超期转 gzip 归档；摘要与派生记忆都带锚点，压缩后仍可回指原文
- 长期层：只由 `record` / 手动巩固 / **失活摘要**产生；会话静默 ≥60 分钟即失活，从 raw 本会话窗口生成摘要（LLM，默认关，关闭时退化为 record-only）
- 召回只发生一次：会话创建（新纪元 epoch）时注入 identity（【画像】+【关系】）与【长期记忆】，由网关按 `(sessionKey, subjectId, epoch)` 去重；后续轮次靠 DSH 上下文
- 人物画像：`profile` + `profile_history` 版本链（性格/说话风格/口头禅/禁忌/关系定位），摘要任务整份合并，可回滚
- 关系：按「平台 + 会话 + 说话人 + 键」单值保存，变更留版本链；自动抽取受可信度守卫（覆盖需 ≥0.9 或跨窗口二次确认，不够格进 `relation_pending` 等人工确认）
- 检索：SQLite FTS5（trigram），查询词 < 3 字符自动降级 `LIKE`；召回后端可替换（向量占位）
- 黑话：n-gram + 互信息 + 左右熵的规则发现（零模型依赖），可选 LLM 解释（默认关）
- 存储：Node 内置 `node:sqlite`（Node ≥ 22.13，24.x 起免 `--experimental-sqlite`）；打不开时降级 JSON 并**如实上报** `degraded`

## 分层与两条轴

| 层 | 载体 | 耐久性 | 注入位置 |
| --- | --- | --- | --- |
| L0 原始 | `raw_message`（+ `raw_fts`） | 不可重建，append-only，超保留期冷归档 | 不注入（只供召回与纠错） |
| L1 长期 | `memory`（`tier=long`，摘要/记录） | 半可重建（从 raw 可再摘要） | 会话首轮注入（epoch 驱动） |
| L2 画像·关系 | `profile`(+history) / `relation`(+history) | 不可重建，版本链 | 会话首轮注入（identity 块） |
| 约束 | `maxRenderChars`（默认 1500，多 block 共享） | — | 决定各 block 预算 |

「短期记忆」不是存储层：它的载体是 DSH 进程内的会话上下文。存量 `tier=short` 行仍可被召回查询，直至自然淘汰；新数据不再写入。

## 用法

```bash
npm install
npm start            # stdio MCP（DSH）+ 回环 HTTP（127.0.0.1:7181）
npm test             # 全量单测（24 组，含纪元/摘要/画像/守卫/只读工具专项）
npm run preflight    # 部署自检：node/依赖/目录/令牌/库版本/归档积压/平台分布/端口
npm run archive      # 原始层归档（计划任务调用；服务内不起定时器）
npm run backup       # 快照到 state/backups/，保留最近 7 份
npm run migrate      # 从 qq-bridge 复制式导入（原件不动，留 .bak）
npm run install:dsh  # 把 mcp-memory 登记进 DSH（--global / --check / --remove）
```

归档 CLI：

```bash
node scripts/raw-archive.mjs                      # 按默认保留期（30 天）归档
node scripts/raw-archive.mjs --days 7 --dry-run    # 只看会归档多少、写到哪些分片
node scripts/raw-archive.mjs --platform qq         # 只处理某个平台
node scripts/raw-archive.mjs --session qq:group:1  # 只处理某个会话
```

## 接口

两条通道：stdio MCP（给 DSH）与回环 HTTP（给平台桥接）。HTTP 只监听 `127.0.0.1`，非回环 `403`，
除 `/api/health` 外都要求本地令牌（`x-mcp-token: <token>` 或 `Authorization: Bearer <token>`，`401`）。

### HTTP 路由

旧接口（始终可用）：

| 路由 | 说明 |
| --- | --- |
| `/api/memory/append` `query` `touch` `forget` `restore` `consolidate` | 记忆读写与固化 |
| `/api/blocks/render` | 单块注入（旧契约，桥接的熔断回落路径） |
| `/api/slang/discover` `submit` `query` `confirm` `reject` `explain` `remove` | 黑话 |
| `/api/stats` `/api/health` | 统计 / 健康检查（health 免令牌） |

分层注入接口（`MEMORY_LAYERS_V2=0` 时整组返回 `404`）：

| 路由 | 说明 |
| --- | --- |
| `/api/memory/ingest` | raw 原文落地（raw-only），返回锚点；`msgId` 幂等；网关自动沉淀的唯一入口 |
| `/api/memory/record` | 模型主动记一条长期事实（同内容幂等） |
| `/api/context/head` `/tail` `/compose` `/invalidate` | 分段注入 |
| `/api/relation/upsert` `get` `list` `history` `forget` | 关系 / 情绪 |
| `/api/raw/archive` `purge` `backlog` `archives` | 原始层运维 |
| `/api/recall` | 主动召回（默认只查本平台） |

错误码：`store_read_only` / `store_unavailable` → `503`；`relation_scope_disabled` / `invalid_argument` / `bad_request` → `400`；
未装配的服务显式报错（不静默 404）；写失败一律抛错透传，绝不返回假成功。

### MCP 工具

- 记忆：`memory_append` `query` `touch` `forget` `restore` `consolidate` `ingest` `record`；只读工具 `chat_memory_profile` / `chat_memory_relation`（会话纪元召回配套）
- 分段注入：`memory_context_head` `tail` `compose` `invalidate`；旧整块：`memory_context_render`
- 召回：`memory_recall`
- 关系：`relation_set` `get` `list` `history` `forget`
- 原始层：`raw_archive` `purge` `backlog`
- 黑话：`slang_discover` `submit` `query` `confirm` `reject`

### 段落契约

```js
// 旧：整块
{ blocks: [{ name: '记忆' | '黑话', text, chars }], truncated }

// 新：分段（head 可缓存，tail 每轮新拼）
{ head: { text, revision, rebuilt, reason }, tail: { text, chars, truncated }, text, revision, rebuilt }
```

## 注入契约：head / tail 与断点

**head（稳定区）** —— 只依赖记忆内容，不依赖 `now` / `score` / `hits`：

```
【长期记忆】kind=episodic && tier=long，按 createdAt 升序取最近 20 条
【关系】    当前值，按 subject → key → scope → id 升序，前 20 条，附建立日期
【情绪】    仅 emotionFreshMs 内的，按 subject → id 升序，前 20 条
【黑话】    已确认词条，按 content → id 升序，前 20 条
```

- 截断按**条数**，不按字符劈句；`revision = sha1(headText)`
- 排序键与 `score` 无关：同一批记忆每轮顺序都不同，拼出来的 head 字节就不同，前缀缓存直接作废

**断点（重建时机）** —— `head_snapshot` 冻结，命中的热路径**零 SQL**（只读一行快照）：

| 条件 | reason | 行为 |
| --- | --- | --- |
| 显式 `invalidate` / `force` | `forced` | 重建 |
| 还没有快照 | `cold` | 重建 |
| 距 `lastActivityAt` ≥ `quietWindowMs`（默认 30 分钟） | `quiet` | 重建；但若 `revision` 未变则不重发（`unchanged`） |
| 仍在同一段对话里 | `frozen` | 直接复用快照 |

**tail（动态区）** —— 每轮都可以变：

```
【当前时间】… → 【短期记忆】最近 8 条 → 【上次情绪】过期情绪最多 3 条 → 【召回】→ 本轮正文
```

正文永远优先保留：预算不够时砍记忆段，不砍用户刚说的话。

## 固化、衰减与召回

- 短期 TTL 默认 **72h**（仅存量行）；命中即**滑动续期**，不再自动升级长期（长期只由 record / 摘要产生，`consolidate` 保留为手动运维入口）
- 衰减：`score = baseWeight·e^(-λ·天) + 命中加成 + 重要度加成`；`λ=0.08/天`，情绪 `λ=0.5/天`，`decayExempt` 行（关系与显式豁免）λ 取 0
- 容量：长期 500（短期 200 仅对存量行生效），超出按 score 淘汰；prune 节流（每 20 次写或 60s）+ `expires_at` 部分索引，写入不再全表扫描
- 召回：默认 `maxRows=5` / `maxChars=400` / 单条 200 字；先查 `memory_fts`，再从 `raw_fts` 捞原文兜底（同 `msgId` 去重，摘要优先）
- 失活摘要：静默 ≥ `MEMORY_MCP_SUMMARY_QUIET_MINUTES`（默认 60，与纪元失活阈值同源）后从 raw 本会话窗口生成摘要，窗口哈希幂等，摘要/画像/游标同事务，失败回滚重试；LLM 关闭时不跑
- 召回 `strategy` 如实上报 `fts5 | like | scan | unavailable`：2 字查询必然落 `like`，JSON 兜底后端不会假装有 FTS

## 平台维度

- **单一真相**：`platform` 一律由 `sessionId` 首段派生（`normalizeSessionId`），API **不接受**独立的 `platform` 入参；写入前的 `CHECK` 只做兜底
- **隔离边界**：`session_id` 本身含平台，`qq:group:1` 与 `wx:room:1` 是两条不同的记忆；`platform` 列用于索引、统计、批量运维与跨平台召回
- **白名单**：`MEMORY_MCP_PLATFORMS`（默认 `qq`）声明已知平台。未知平台默认**放行并告警一次**（新桥接先跑通）；
  `MEMORY_MCP_PLATFORM_STRICT=1` 时拒绝写入并返回 `400 unknown_platform`。白名单为空 = 不设限
- **跨平台共享默认关**：关系写 `scope=identity` 需 `MEMORY_MCP_RELATION_IDENTITY=1`，否则 `400 relation_scope_disabled`；跨平台召回需 `MEMORY_MCP_RECALL_CROSS_PLATFORM=1`，未开启时**降级为当前平台**并返回 `scope='platform'` + `downgraded=true`
- **运维可见**：`/api/health` 暴露 `schemaVersion` / `degraded` / `layersV2` / `recall` / `platforms`；`npm run preflight` 输出各平台行数（记忆 / 原文 / 关系）

## 隐私与归档

- 原始层保留 `rawRetentionDays`（默认 30 天），超期导出到 `state/raw-archive/<platform>/<session>-<yyyymmdd>.jsonl.gz`（流式 gzip），
  然后清空正文、保留 `msg_id/sender_id/kind/anchor` —— 元数据可查，原文在压缩分片里
- 硬删（被遗忘权）：`/api/raw/purge` 按 `msgId` / `senderId` / `platform` 删库并重写受影响分片，同时清理派生记忆的 `source_msg_ids` 引用
- 记忆硬删：`/api/memory/forget {mode:'hard'}`；关系硬删默认连版本链一起删（只删当前值等于假装忘了）
- 备份：`npm run backup` 快照 `state/` 到 `state/backups/`，保留最近 7 份

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEMORY_LAYERS_V2` | `1` | `0` = 关闭分层注入路由（回退旧接口与单块【记忆】） |
| `MEMORY_MCP_HTTP_PORT` | `7181` | 回环端口；被占用时降级 stdio-only，MCP 工具仍可用 |
| `MEMORY_MCP_TOKEN` | 自动生成 `state/http-token`（`0o600`） | 本地令牌 |
| `MEMORY_MCP_STATE_DIR`（旧名 `MEMORY_MCP_DATA_DIR`） | `<包>/state` | 数据目录 |
| `MEMORY_MCP_HEAD_QUIET_MINUTES` | `30` | head 断点静默窗 |
| `MEMORY_MCP_PLATFORMS` | `qq` | 已知平台白名单（逗号分隔，如 `qq,wx`）；空 = 不设限 |
| `MEMORY_MCP_PLATFORM_STRICT` | 关 | `1` = 未知平台拒绝写入（`400 unknown_platform`） |
| `MEMORY_MCP_EMOTION_FRESH_HOURS` | `2` | 情绪「算现在」的时长 |
| `MEMORY_MCP_RELATION_IDENTITY` | 关 | `1` = 允许 `scope=identity` 的跨平台关系 |
| `MEMORY_MCP_RAW_RETENTION_DAYS` | `30` | 原始层保留天数 |
| `MEMORY_MCP_LLM_ENABLED` / `_BASE_URL` / `_API_KEY` / `_MODEL` / `_TIMEOUT_MS` | 关 | LLM（OpenAI 兼容）：黑话解释 + 失活摘要共用 |
| `MEMORY_MCP_SUMMARY_QUIET_MINUTES` / `_TICK_MINUTES` | `60` / `5` | 摘要失活阈值（与纪元失活同源）与扫描间隔 |
| `MEMORY_MCP_SESSION_IDLE_MINUTES` | `60` | 会话纪元失活阈值（静默超过即推进 epoch） |
| `MEMORY_MCP_RECALL_CROSS_PLATFORM` | 关 | `1` = 允许跨平台召回 |
| `MEMORY_MCP_RECALL_MAX_ROWS` | `5` | 召回条数上限 |
| `MEMORY_MCP_RECALL_MAX_CHARS` | `400` | 召回字符上限 |

详见 qq-bridge 的 `docs/guides/MEMORY_MCP.md`。

## 灰度与回退

默认启用分层注入。出问题时 `MEMORY_LAYERS_V2=0` 重启即可回退：

- V2 路由整组不注册（`/api/context/*`、`/api/memory/ingest|record`、`/api/relation/*`、`/api/raw/*`、`/api/recall` → `404`），桥接据此回落 `/api/blocks/render`
- 旧接口、MCP 工具、数据表一律不动：回退**不迁移、不删数据**，重新开启即接着用
- `/api/health` 的 `layersV2` 与 `npm run preflight` 的「分层注入」都会明确报出当前状态

## 自检

`npm run preflight` 以**只读**方式打开记忆库（不建表、不迁移、不写文件），逐项输出：

- node 版本、依赖、数据目录可写、本地令牌、DSH 登记、HTTP 端口
- 记忆库：`schema v?`、各层行数、`head` 快照数；库版本落后于代码时只报警（启动时才迁移）
- 原文归档积压（超过保留期未归档的条数）、归档分片数、按平台的数据分布
- 分层注入开关状态、平台白名单与 strict 状态

失败项退出码 `1`，提醒项不影响结论。

## sessionId

只认 `platform:scope:id`（如 `qq:group:123456`、`wx:room:xxxxx`）。`group:群号` → `qq:group:群号` 的映射由平台桥接负责，
本服务不解析平台语义；新平台接入按同一形状产出即可。

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

## 网关 WS 长连接（V2 主线）

`service.call` / `tool.call` 默认由网关走 HTTP 端点投递；配了 WS 长连接后，同一组
处理函数改由 `/v1/ws` 帧调用（业务零改动，见 `src/service/ws-connector.js`）。

| 环境变量 | 说明 |
| --- | --- |
| `MEMORY_MCP_GATEWAY_SECRET` | 网关共享密钥（必填，≥16 字符；与登记文件 `secretEnv` 同源） |
| `MEMORY_MCP_GATEWAY_ID` | 登记文件 id（打开 WS 时必填） |
| `MEMORY_MCP_GATEWAY_WS_URL` | 网关基址（如 `http://127.0.0.1:8787`）；留空 = 不建连接（纯 HTTP） |
| `MEMORY_MCP_GATEWAY_TRANSPORT` | `ws` 或 `auto`（默认 `auto`）；非法值启动即失败 |

部署前提（缺一即握手 401）：网关 `GATEWAY_WS=on`；登记目录里本服务条目存在且
secret 一致；`transport` 建议改 `auto`（有 WS 连接走帧、否则回落 HTTP）。
连接断开期间网关自动回落 HTTP，无需人工切换；服务侧断线按 1s→30s 退避重连。

## 许可

MIT，见 [LICENSE](LICENSE)。
