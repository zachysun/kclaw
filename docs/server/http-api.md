# http-api — HTTP 路由

## 职责

`packages/server/src/app.ts` 的 `createApp` 组装 daemon 的 Fastify 应用：一个全局鉴权钩子加 37 个业务路由（健康/状态 2 个、会话 14 个、记忆 9 个、附件 3 个、任务 4 个、配置 1 个、目录浏览 1 个、用量 1 个、MCP 状态 1 个、WS 1 个）与可选的静态托管。路由实现分在 `packages/server/src/routes/`（`sessions.ts`、`attachments.ts`、`jobs.ts`、`config.ts`、`fs.ts`、`usage.ts`、`memory.ts`），`GET /mcp` 内联在 app.ts；附件与用量两组仅在对应能力注入时才注册（见下文各自小节），记忆组始终注册、未装配时降级 503。本文逐个列出方法、路径、用途与请求/响应关键字段；WS 端点的帧协议见 [realtime](./realtime.md)。

## 设计决策

- **鉴权由一个钩子统一处理**：`preHandler` 比对 `Authorization: Bearer <token>`（恒时比较），失败统一 `401 {error:"unauthorized"}`。豁免只有 `/health`、`/ws`、静态外壳三种（设计理由见 [daemon](./daemon.md) 的鉴权设计一节）。
- **错误形状统一为 `{error: string}`**：会话/任务两个路由分组（scope）注册了 `setErrorHandler`，把 Fastify 的 body 解析错误（非法 JSON、空 body）也归一成这个形状；其余分组未注册（body 解析错误走 Fastify 默认形状 `{statusCode, error, message}`），客户端需兼容两种。
- **404 显式可判别**：会话/任务路由先查存在性（`sessions.meta(id)` / `jobs.get(id)`），不存在返回 `404 {error:"session not found"|"job not found"}`，不依赖异常路径。
- **配置接口只读且脱敏**：API key 永远掩码返回，没有写回路由——修改配置通过文件（config.yaml）进行，daemon 重启后生效。
- **消息审计没有专门路由，压缩审计有只读接口**：消息轨迹页（web 的 `AuditView`）就是 `GET /sessions`（会话下拉）+ `GET /sessions/:id/messages`（按会话读取消息列表）两个只读接口组合而成，不存在 `/audit` 路由。压缩审计不同——手动压缩刻意不产生消息，纯靠消息流看不到它的痕迹，因此有专门的只读接口 `GET /sessions/:id/compactions`（会话目录下 `compactions.jsonl` 的读取窗口，见 [compaction](../core/compaction.md)）。
- **可选能力按注入条件注册**：附件路由只在传入 `attachmentsDir` 时注册、用量路由只在传入 `UsageStore` 时注册——能力未装配就没有这些路径，而不是"注册了但报错"；`GET /mcp` 则始终存在，daemon 未装配 McpManager 时返回空 server 列表。

## 路由清单

通用约定：除 `/health` 外全部需要 `Authorization: Bearer <token>`；请求体缺失时按"字段全缺"处理；下表"响应"列均为 200/201 的 body。

### 健康与状态

| 方法 | 路径 | 用途 | 响应 |
|------|------|------|------|
| GET | `/health` | 存活探测（唯一免鉴权路由） | `{ok: true}` |
| GET | `/status` | 版本与运行时长 | `{version, uptimeSec}`（uptimeSec 为整数秒；version 运行时读 package.json） |

### 会话（routes/sessions.ts，底座 `SessionStore`）

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| POST | `/sessions` | 创建会话 | `{title?, workdir?}`（均可缺省；传入时必须是非空字符串）；**workdir 缺省落 `config.workspace` 的值**，保证每条会话都带具体工作目录 | 201，`SessionMeta`（title 缺省为 `"新会话"`） |
| GET | `/sessions` | 会话列表（updatedAt 新的在前） | 查询参数 `deleted=true` 返回回收站会话；缺省只返回未删除会话 | `SessionMeta[]` |
| GET | `/sessions/:id` | 读单个会话元数据 | — | `SessionMeta` |
| PATCH | `/sessions/:id` | 改名 | `{title?}`（非空字符串；body 里的 `workdir` 被解析但**不生效**，只有 title 传给 `updateMeta`） | `SessionMeta` |
| DELETE | `/sessions/:id` | 软删除（移入回收站，标记 `deleted`/`deletedAt`） | — | `SessionMeta` |
| POST | `/sessions/:id/restore` | 从回收站恢复（清除 `deleted`/`deletedAt`） | — | `SessionMeta` |
| POST | `/sessions/:id/purge` | 永久删除（整个会话目录删除） | — | `{ok: true}` |
| POST | `/sessions/:id/model` | 会话级模型切换（只影响此会话**之后**的 run，历史不动） | `{model?}`：provider 条目名（entry key，见 [run-manager](./run-manager.md) 的模型解析）或裸模型名；`""`/缺省清空回落默认；类型不对 400 `model must be a string`，条目不存在 400 `model not found: <name>` | `SessionMeta` |
| POST | `/sessions/:id/readonly` | 会话级只读开关（write/exec 类工具被拒，见 [permissions](../core/permissions.md)） | `{readonly: boolean}` 必填；`false` 清除标记 | `SessionMeta` |
| GET | `/sessions/:id/messages` | 读全部消息（轨迹/断线恢复的数据源） | — | `Message[]`（JSONL 逐行读出的完整对话史；**排队未执行的消息不在其中**，见 `/queue`） |
| GET | `/sessions/:id/queue` | 排队消息快照（message-queue spec §4.3）：重连/刷新的全量纠偏兜底 | — | `QueueEntry[]`（`meta.queue`，数组顺序即执行顺序；steer 条目排在可执行条目之后；空队列返回 `[]`） |
| POST | `/sessions/:id/disposition` | 会话级发送处置覆盖（CLI `/steer`、`/wait` 与 Web 三选的 steer/wait 的 sticky 存储；interrupt 在 Web 为一次性、CLI 为 `/interrupt` 一次性动作，均不落覆盖，spec §6/§7.1） | `{disposition: "steer"\|"wait"\|"interrupt"}` 必填；非法值 400 `disposition must be "steer", "wait" or "interrupt"` | `SessionMeta`（写入 `dispositionOverride`，优先于配置默认） |
| GET | `/sessions/:id/compactions` | 压缩审计记录（审计页"压缩记录"区块的数据源） | — | `CompactionRecord[]`（compactions.jsonl 逐行读出，按行序；文件缺失返回 `[]`） |
| POST | `/sessions/:id/compact` | 手动压缩：跳过触发线立即压缩一次（机制见 [compaction](../core/compaction.md)） | `{focus?}`：可选非空字符串，作为重点说明进入两次摘要调用；空串/非字符串 400 `focus must be a non-empty string` | `{message: string}`：成功 `压缩了 N 段，剩 X 条原文消息`；无可压缩内容 `无可压缩内容` |

`:id` 不存在时上述全部返回 `404 {error:"session not found"}`；body 校验失败返回 400（如 `title must be a non-empty string`）。compact 的额外拒绝路径（双条件、两条文案，队列优先——正在跑的 run 与积压队列并存时"先处理排队"才是可行动建议）：队列非空 409 `还有 N 条排队消息，先处理或取消`；会话活跃 409 `会话正在运行，等它结束`；RunManager 未装配时 503。

`SessionMeta` 字段（`packages/core/src/session/store.ts`）：

```ts
interface SessionMeta {
  id: string            // ses_<ULID>
  title: string
  createdAt: string     // ISO-8601
  updatedAt: string     // appendMessage/updateMeta 都会刷新
  jobId?: string        // 由定时任务创建的会话带此字段
  workdir?: string      // 会话级工作目录（run 以它覆盖全局 workspace）
  model?: string        // 会话级模型覆盖（缺省 → 守护进程默认模型）
  readonly?: boolean    // 会话级只读模式（write/exec 工具被拒，读取不受限）
  deleted?: boolean
  deletedAt?: string
  compactedSummary?: string   // v1 压缩遗留：读取兼容，下一次压缩写入新格式时删除
  compactedUpto?: string
  compaction?: { segments: { upto: string; summary: string }[]; top: string; upto: string }
                              // v2 分层压缩状态，字段语义见 compaction.md
  queue?: QueueEntry[]        // 排队未执行的消息（message-queue spec §3.1/§3.2）：meta.json 原子重写，
                              // 顺序即执行顺序；不进 JSONL，故 /messages 不含、/queue 专读
  dispositionOverride?: "steer" | "wait" | "interrupt"
                              // 会话级发送处置覆盖（POST /disposition 写入；优先于 sessions.defaultDisposition）
}
```

`QueueEntry`（`packages/core/src/session/store.ts`）：

```ts
interface QueueEntry {
  messageId: string                       // 分配即固定；出队执行/steer 注入用同一 id 构建 Message
  disposition: "steer" | "wait" | "interrupt"
  text: string
  trigger: "user" | "job"                 // 还原触发源（job 的 note/触发语义在出队执行时需要）
  attachments?: QueueAttachment[]         // 与 EnqueueInput 的 AttachmentRef 同构，路径已校验
  note?: string                           // job 来源说明
  enqueuedAt: string                      // ISO-8601
}
```

### 任务（routes/jobs.ts，底座 `JobScheduler`）

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| POST | `/jobs` | 创建定时任务 | `{name, cron, prompt}` 三者都必填、非空字符串（cron 是 cron 表达式：`分 时 日 月 周` 五段的时间表写法）；可选 `{model}`（该任务的模型覆盖，非空字符串） | 201，`Job`；cron 解析失败 400（cron-parser 的原始报文透传） |
| GET | `/jobs` | 任务列表 | — | `Job[]` |
| PATCH | `/jobs/:id` | 修改 | `{name?, prompt?, cron?, model?, enabled?}`（字符串字段必须非空、enabled 必须是布尔；未知字段忽略） | `Job`；cron 解析失败 400 |
| DELETE | `/jobs/:id` | 删除 | — | 204 无 body；不存在 404 `{error:"job not found"}` |

`Job` 字段（`packages/core/src/jobs/scheduler.ts`）：

```ts
interface Job {
  id: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
  nextRunAt: string          // ISO-8601，创建/更新时算出
  lastRunAt?: string
  lastStatus?: "ok" | "error"
  lastError?: string
  model?: string             // 任务级模型覆盖（缺省 → 回落会话/默认解析链）
}
```

### 配置（routes/config.ts）

| 方法 | 路径 | 用途 | 响应 |
|------|------|------|------|
| GET | `/config` | 读当前配置（脱敏副本） | `KclawConfig`，所有 provider 条目的 `apiKey` 与 `web.tavilyApiKey` 掩码 |

脱敏规则（`sanitizeConfig` + `maskSecret`）：先 `structuredClone` 深拷贝再改（原对象保持不变），掩码为 `"***" + 末 4 字符`（不足 4 字符则纯 `"***"`，空串同）。其余字段原样返回。没有对应的写路由。

### 记忆（routes/memory.ts，底座 `MemorySystem`）

记忆 v2 的 `/memory` 管理路由族（spec 9.2）：读取与整文件覆写/删除记忆塔里的项目主题线（L1）与全局认知文件（L2）。机制与文件格式见 [memory](../core/memory.md)。与附件/用量"仅注入时注册"不同，这组**始终注册**——`createApp` 未装配 `MemorySystem`（`opts.memory` 缺失，常见于测试）时，命中任何一条都返回 `503 {error:"memory system unavailable"}`，而不是 404。

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| GET | `/memory/projects` | 项目列表 | — | `{id, workdir, threads, lastActivity}[]`（id = `<目录名>-<sha1前6位>`；threads 为线数、lastActivity 为最近线活动日期） |
| GET | `/memory/projects/:id` | 某项目的主题线清单 | — | `{id, threads}`，threads 为 `{topic, title, status, updated}[]`（按 MEMORY.md 生成）；项目不存在 404 `{error:"not found"}` |
| GET | `/memory/threads/:project/:topic` | 读线文件原文 | — | `{content}`（线文件完整 markdown）；项目或线不存在 404 |
| PATCH | `/memory/threads/:project/:topic` | 整文件覆写线文件（写后重索引 + 重建 MEMORY.md） | `{content}` 必填、非空字符串，否则 400 `content must be a non-empty string` | `{ok:true}`；目标不存在 404 |
| DELETE | `/memory/threads/:project/:topic` | 删线文件 + 重建索引与 MEMORY.md | — | `{ok:true}`；目标不存在 404 |
| GET | `/memory/global` | 全局认知文件列表 | — | `{kind, name, path, scope, updated}[]`（kind ∈ persona/wiki/rule） |
| GET | `/memory/global/:kind/:file` | 读认知文件原文 | — | `{content}`；kind 非 persona/wiki/rule 或文件不存在 404 |
| PATCH | `/memory/global/:kind/:file` | 整文件覆写认知文件（写后重建全局索引） | `{content}` 必填、非空字符串，否则 400 `content must be a non-empty string` | `{ok:true}`；kind 非法或文件不存在 404 |
| DELETE | `/memory/global/:kind/:file` | 删认知文件 + 重建全局索引 | — | `{ok:true}`；kind 非法或文件不存在 404；**persona 是全局画像，不可删除，返回 400 `persona 不可删除（可清空正文）`** |
| POST | `/memory/trigger-manual` | 手动触发当前项目的手动写入（spec 4.2 手动行）：与定时/跟随同一条管线，范围 = 该项目自上次水位以来的新消息 | `{workdir?}`：可选，缺省回落 `config.workspace` | `{ok:true}`；`memory.write.manual=false` 时 400 `手动写入已关闭（memory.write.manual=false），可依赖定时/跟随触发`；管线异常 500 |

`:id`/`:project`/`:topic`/`:file` 的路径段先过白名单校验（`isSafeSegment`：段非空、非 `.`、非 `..`、不含 `/`，拦目录穿越段；允许 CJK/空格，URL 里已 encodeURIComponent）——非法段返回 400 `invalid segment`；合法段按原样传给 `MemorySystem`，读侧宽容（找不到就 404），写侧是"人即是真相"的整文件覆写。`GET /memory/projects/:id` 的响应包裹成 `{id, threads}` 是为前端取数方便（实现与 spec 的差异点，见 [memory](../core/memory.md) 的管理界面一节）。删除类的机器语义：删的是文件，`vectors.db` 里的对应条目由随后的 reindex 清除。

### 附件（routes/attachments.ts，仅当注入 `attachmentsDir` 时注册）

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| POST | `/sessions/:id/attachments?filename=<名>` | 上传附件 | body 是**原始字节流**（Content-Type 任意的 Buffer），文件名走 query；上传即落盘到 `<attachmentsDir>/<sessionId>/<att_<ULID>>__<净化后文件名>` | `{file: {path, name, size}}` |
| GET | `/sessions/:id/attachments` | 附件清单 | — | `{name, size}[]`，mtime 新的在前；尚无附件目录时返回 `[]` |
| GET | `/sessions/:id/attachments/:file` | 下载附件 | — | 文件字节流 |

出错形状：缺 `filename` 或空 body → 400；超过上限 **20MB** → 413 `attachment too large (max 20MB)`；下载路径解析后逃出会话附件目录 → 400 `invalid attachment path`（遍历防护）；目标不是文件 → 404 `attachment not found`。文件名经净化处理——剥掉路径分隔符与控制字符等，剥空回落 `"file"`。为接收任意类型的原始 body，该组路由注册了一个通配 content-type 解析器（Buffer 原样收下；JSON parser 仍优先匹配 application/json）。

### 目录浏览与用量

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| GET | `/fs/browse` | 列出某目录的子目录（WebUI 工作目录选择器的数据源） | query `path`：绝对路径或 `~` 开头（与权限引擎同样的展开规则）；缺省列 `config.workspace` | `{path, parent, dirs}`——path 为符号链接解析后的规范绝对路径；parent 为父目录，文件系统根处为 null；dirs 只含子目录名、大小写不敏感排序。符号链接跟随解析（坏链跳过），macOS 的 `/tmp → private/tmp` 一类仍可导航 |
| GET | `/usage?by=day\|session\|model` | token/费用台账聚合 | `by` 三选一；无效值静默回落 `day` | `{by, buckets[], total}`——bucket/total 形状同为 `{key, inputTokens, outputTokens, costUsd}`，费用按 `config.usage.prices` 计价，未配置价格的模型计 0 |

`/fs/browse` 的出错是三态 400：`path does not exist: <path>`、`not a directory: <path>`、`cannot read directory: <path>`。这个端点能列出本机任意目录——选择器的设计目的就是允许把工作目录设在任何地方，防线只有与其他 API 相同的 Bearer 鉴权。台账的数据来源见 [storage](../core/storage.md) 的用量台账一节。

### MCP 状态

| 方法 | 路径 | 用途 | 响应 |
|------|------|------|------|
| GET | `/mcp` | MCP server 连接状态快照 | `{servers: [{name, state, tools: {name}[], config, lastError?}]}`（`config` 为该 server 的 `McpServerConfig`，含地址等） |

路由始终注册；daemon 未装配 McpManager（`mcp.servers` 为空）时 `servers` 为空数组。消费方是 CLI 的 `kclaw mcp [list]` 命令；连接状态机见 [mcp](../core/mcp.md)。

### WS 与静态托管

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/ws` | WebSocket（建立后可双向收发消息的长连接）升级端点；HTTP 鉴权豁免，连接内首帧认证，协议见 [realtime](./realtime.md) |
| GET | `/`、`/assets/*` | 仅当 `webDist` 已配置时由 `@fastify/static` 托管构建产物；外壳三路径加 PWA 静态文件（`/manifest.webmanifest`、`/sw.js`、`/icon-192.png`、`/icon-512.png`、`/favicon.ico`）免鉴权，其余静态文件仍需 Bearer |

**队列相关的 WS 命令与事件**（message-queue spec §4，完整帧语义见 [realtime](./realtime.md) 与 [run-manager](./run-manager.md)）：

- `send_message` 增加可选 `disposition` 字段（`"steer"|"wait"|"interrupt"`；非法值 error 帧 `send_message disposition must be "steer", "wait" or "interrupt"`）。不带字段取会话覆盖 ?? 配置默认（**默认引导**——有意的行为变更，旧版为自动等待）。回包 `send_message_ack` 增加 `messageId` 与 `queued`（会话空闲直发 `queued:false`、不广播 `message.queued`；运行中按处置分流 `queued:true`）。会话忙时超限的 error 帧文案：`队列已满（10 条）`。
- `queue.cancel`：`{sessionId, messageId?}`——带 id 取消该条（wait 随时、steer 注入前），不带则清空全部可取消条目。回 `queue.cancel_ack {sessionId, cancelled}`；失败为 error 帧：已注入 `已注入`（机器不删历史）、无此条目 `not found`。
- 三个新事件：`message.queued {messageId, disposition, position?}`（消息入队/入缓冲区时；position 是 wait/interrupt 的队列序位，steer 不适用；降级按实际处置报告）、`message.steered {messageId}`（steer 注入当前 run 的时刻，事件级 `runId` 标识注入的 run）、`message.queue_cancelled {messageId}` 或 `{all:true}`（单条取消/清空）。出队执行与注入仍用既有 `run.started` + `message.created` 表达，消息 id 与排队时相同——前端气泡原地升级，无需替换。

**记忆写入事件 `memory.written`**（spec 9.3）：记忆写入管线每次实际落盘时经总线广播，帧为 `memory.written {path, kind, topic?, scope?}`——`kind` 是 `"episode"`（项目情节，带 `topic` 线名）或 `"cognition"`（全局认知，带 `scope`），`path` 是落盘文件的绝对路径；不带 `sessionId`（项目级事务）。它只作"已落盘"的轻提示：CLI dim 一行 `已写入记忆: <path>`，web 在通知条显示同文案，都不驱动任何状态机。事件不带"记忆内容"，要看内容走上面的 `/memory` 路由。payload 定义见 [protocol](../core/protocol.md)。

## 审计的读取方式

web 的轨迹页（`packages/web/src/audit/AuditView.tsx`）演示了标准用法：

1. `GET /sessions` 获取全部会话（下拉选择"按会话筛选"即选择 `:id`）；
2. `GET /sessions/:id/messages` 获取该会话全部 `Message[]`；
3. 客户端把每条消息按块（block）摊平为逐行轨迹（role + 类型标签 + 摘要，点击展开完整块）。

只读、无 mutation、无独立 `/audit` 路由——`messages.jsonl`（每行一条 JSON 的消息文件）是消息轨迹的唯一事实来源，HTTP 只是它的读取窗口。tool 消息上的 `grantedBy`（每个工具调用的放行原因）随 `Message` 一起返回，是"谁批准了这个操作"的审计依据。

消息轨迹之外，选中会话后轨迹页还追加拉取 `GET /sessions/:id/compactions`，在轨迹上方渲染"压缩记录"区块——压缩审计的事实来源是 `compactions.jsonl`，同样只读（记录格式见 [compaction](../core/compaction.md)）。

## 鉴权中间件行为

```ts
// packages/server/src/app.ts（节选）
app.addHook("preHandler", async (request, reply) => {
  const routeUrl = request.routeOptions?.url ?? request.url.split("?")[0]
  if (routeUrl === "/health" || routeUrl === "/ws") return
  if (opts.webDist !== undefined && isWebShellExempt(request)) return
  if (!bearerMatches(request.headers.authorization, opts.token)) {
    return reply.code(401).send({ error: "unauthorized" })
  }
})
```

- 判定用的 route url 取 `request.routeOptions.url`（匹配到的路由模板，如 `/sessions/:id`），静态 catch-all 场景退回原始路径。
- token 错误/缺失一律 `401 {error:"unauthorized"}`，不区分"未携带"与"携带错误"（不向探测者提供信息）。
- 会话/任务两个分组注册的 `setErrorHandler` 只兜 body 解析类错误（`error.statusCode ?? 500`），不影响鉴权钩子——钩子先于 handler 运行。

## 边界与出错

- **无分页**：`GET /sessions` 与 `GET /sessions/:id/messages` 都是全量返回；个人使用规模下接受，超大会话的截断在客户端渲染层完成。
- **软删除的会话不在默认列表**：`GET /sessions` 缺省过滤 `deleted:true`；要操作回收站必须显式 `?deleted=true`（恢复/永久删除路由不区分列表，直接按 id 操作）。
- **PATCH `/sessions/:id` 的 workdir 是解析但未生效的字段**（源码只把 title 传给 `updateMeta`）——API 消费者不应依赖它。
- **`POST /jobs` 的 cron 校验依赖 cron-parser 的报错文本**，客户端展示的是原始英文错误。
- **并发写无版本控制**：两个客户端同时 PATCH 同一资源是"后写赢"，没有乐观锁（加版本号防并发覆盖的机制）。
- **上传 ≠ 挂载**：附件这三个路由只负责把字节写到磁盘、列举和下载。附件要真正进入对话，还需要客户端在下一条 send_message 帧里带上这些文件的路径，由 run 的挂载步骤转成模型能读的内容——见 [realtime](./realtime.md) 与 [run-manager](./run-manager.md)。

## 关联

- [daemon](./daemon.md)：鉴权豁免的设计理由、静态托管的配置来源
- [realtime](./realtime.md)：`/ws` 端点的帧协议
- [run-manager](./run-manager.md)：send_message 背后的三处置决策、队列驱动器与附件挂载（`/queue` 快照与 compact 409 的服务端语义）
- [storage](../core/storage.md)：SessionStore/JobScheduler/UsageStore 的持久化实现
- [compaction](../core/compaction.md)：compact/compactions 两个路由背后的机制与记录格式
- [memory](../core/memory.md)：`/memory` 路由族背后的记忆塔存储与 `memory.written` 事件
- [mcp](../core/mcp.md)：`GET /mcp` 快照背后的连接管理器
- [jobs](../core/jobs.md)：cron 语义与 nextRunAt 推进规则
