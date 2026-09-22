# http-api — HTTP 路由

## 职责

`packages/server/src/app.ts` 的 `createApp` 组装 daemon 的 Fastify 应用：一个全局鉴权 hook 加 75 个业务路由（健康/状态 2 个、会话 16 个、记忆 10 个、技能 16 个、hook 1 个、权限 2 个、附件 3 个、任务 4 个、配置 1 个、provider 管理 6 个、目录浏览 2 个、用量 1 个、MCP 管理 6 个、IM Channel 管理 4 个、WS 1 个）与可选的静态托管。路由实现分在 `packages/server/src/routes/`（`sessions.ts`、`attachments.ts`、`jobs.ts`、`config.ts`、`providers.ts`、`fs.ts`、`usage.ts`、`memory.ts`、`skills.ts`、`hooks.ts`、`permissions.ts`、`mcp.ts`、`channel.ts`）；附件与用量两组仅在对应能力注入时才注册（见下文各自小节），记忆组始终注册、未组装时降级 503，技能组始终注册（只读与复用管理无组装依赖；提案治理子路由族组装后才可用、未组装整体 503），hook 组在未注入 `HookRegistry` 时返回空用户侧，权限组始终注册（已保存的规则以文件为准，见 [permissions](../core/permissions.md)）。本文逐个列出方法、路径、用途与请求/响应关键字段；WS 端点的帧协议见 [realtime](./realtime.md)。

## 设计决策

- **鉴权由一个 hook 统一处理**：`preHandler` 比对 `Authorization: Bearer <token>`（恒时比较），失败统一 `401 {error:"unauthorized"}`。豁免只有 `/health`、`/ws`、静态外壳三种（设计理由见 [daemon](./daemon.md) 的鉴权设计一节）。
- **错误形状统一为 `{error: string}`**：会话/任务两个路由分组（scope）注册了 `setErrorHandler`，把 Fastify 的 body 解析错误（非法 JSON、空 body）也归一成这个形状；其余分组未注册（body 解析错误走 Fastify 默认形状 `{statusCode, error, message}`），客户端需兼容两种。客户端的共享 HTTP 基座（`@kclaw/core/client-http`）正是从这个 `error` 字段提取错误消息、取不到退回 `HTTP <status>`，见 [client-http](../core/client-http.md)。
- **404 显式可判别**：会话/任务路由先查存在性（`sessions.meta(id)` / `jobs.get(id)`），不存在返回 `404 {error:"session not found"|"job not found"}`，不依赖异常路径。
- **配置读面只读且脱敏，写面收在 provider 管理族**：`GET /config` 的 API key 永远掩码返回；改 provider 配置走 `/providers` 路由族（上一节）——改动热生效于下个 run 并持久化 `config.json`，其余配置节仍以手写配置文件为准。
- **消息审计没有专门路由，压缩审计有只读视图**：审计页（web 的 `AuditView`）没有独立 `/audit` 路由（它由 `GET /sessions/:id/events`（该会话完整事件流，`?since=` 增量游标）单源读取 + 页面私有 ws 订阅（`session.appended` 通知帧驱动增量拉取）组合而成，会话选择跟随应用侧栏的全局选中）。压缩审计不同：手动压缩刻意不产生消息，纯靠消息流看不到它的痕迹，因此 `GET /sessions/:id/compactions` 作为事件流里 `compaction` 事件的只读视图存在（见 [compaction](../core/compaction.md)）。
- **可选能力按注入条件注册**：附件路由只在传入 `attachmentsDir` 时注册、用量路由只在传入 `UsageStore` 时注册——能力未组装就没有这些路径，而不是"注册了但报错"；MCP 组始终注册，`GET /mcp` 在 daemon 未组装 McpManager 时返回空 server 列表，动作端点此时回答 503。技能组与记忆组同为始终注册，但语义不同：记忆组未组装 `MemorySystem` 时降级 503，技能组没有组装依赖（技能是以文件为准，每次请求重新扫描），始终正常工作。

## 路由清单

通用约定：除 `/health` 外全部需要 `Authorization: Bearer <token>`；请求体缺失时按"字段全缺"处理；下表"响应"列均为 200/201 的 body。

### 健康与状态

| 方法 | 路径 | 用途 | 响应 |
|------|------|------|------|
| GET | `/health` | 存活检测（唯一免鉴权路由） | `{ok: true}` |
| GET | `/status` | 版本与运行时长 | `{version, uptimeSec}`（uptimeSec 为整数秒；version 运行时读 package.json） |

### 会话（routes/sessions.ts，底层 `SessionStore`）

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| POST | `/sessions` | 创建会话 | `{title?, workdir?}`（均可默认；传入时必须是非空字符串）；**workdir 默认取 `config.workspace` 的值**，保证每条会话都带具体工作目录；初始权限模式取 `config.permissions.defaultMode` 的当前值**固化为 `meta.mode`**（默认 default；改配置只影响之后新建的会话）；创建成功后**异步触发一次切会话记忆写入**（clear 触发，归属 = 创建前的项目最近活动会话，即用户刚离开的旧会话；未组装记忆系统时不触发），不阻塞响应 | 201，`SessionMeta`（title 默认为 `"新会话"`） |
| GET | `/sessions` | 会话列表（updatedAt 新的在前） | 查询参数 `deleted=true` 返回回收站会话；默认只返回未删除会话。两种情况都**不含 subagent 会话**（meta 带 `parentSessionId` 的会话不是列表一等公民），`children=true` 才列出（给定父的 subagent 排查用，见 [subagents](../core/subagents.md)） | `SessionMeta[]` |
| GET | `/sessions/:id` | 读单个会话元数据 | — | `SessionMeta` |
| PATCH | `/sessions/:id` | 改名 | `{title?}`（非空字符串；body 里的 `workdir` 被解析但**不生效**，只有 title 传给 `updateMeta`） | `SessionMeta` |
| DELETE | `/sessions/:id` | 软删除（移入回收站，标记 `deleted`/`deletedAt`）；**先取消该会话在跑的后台 subagent 与团队组员 run**，再级联软删其全部 subagent 会话（不留残留会话，见 [subagents](../core/subagents.md)、[agent-team](../core/agent-team.md)）；若本会话是组长，团队目录随之一并归档（见 agent-team） | — | `SessionMeta` |
| POST | `/sessions/:id/restore` | 从回收站恢复（清除 `deleted`/`deletedAt`） | — | `SessionMeta` |
| POST | `/sessions/:id/purge` | 永久删除（整个会话目录删除）；**先取消该会话在跑的后台 subagent 与团队组员 run**，再级联永久删除其全部 subagent 会话；团队目录同样归档 | — | `{ok: true}` |
| POST | `/sessions/:id/model` | 会话级模型切换（只影响此会话**之后**的 run，历史不动） | `{model?}`：provider 条目名（entry key，见 [run-manager](./run-manager.md) 的模型解析）或裸模型名；`""`/默认清空回退到默认；类型不对 400 `model must be a string`，条目不存在 400 `model not found: <name>` | `SessionMeta` |
| POST | `/sessions/:id/mode` | 会话级权限模式切换（只影响此会话**之后**的 run，历史不动；机制见 [permissions](../core/permissions.md)） | `{mode: "readonly"\|"default"\|"acceptEdits"\|"trusted"\|"auto"}` 必填；非法值 400 `mode must be one of readonly \| default \| acceptEdits \| trusted \| auto` | `SessionMeta` |
| GET | `/sessions/:id/team` | agent 团队面板数据（机制见 [agent-team](../core/agent-team.md)） | — | `{team, identity: "lead"\|"member", members, tasks}`（团队、本会话身份、组员名单含忙闲与当前任务、任务板快照）；会话不在任何团队 404 |
| GET | `/sessions/:id/messages` | 读全部消息（对话/断线恢复的数据源，ChatPanel 用） | — | `Message[]`（事件流投影视图——`readMessages` 从 events.jsonl 过滤 `message` 事件按事件序返回；**排队未执行的消息不在其中**，见 `/queue`） |
| GET | `/sessions/:id/events` | 完整事件流（会话历史的唯一权威数据；审计页的单源数据） | `since?`：非负整数，只返回数组下标 `>= since` 的事件（流是 append-only：只追加、不修改，下标即稳定增量游标；默认/0 = 全量；越界返回 `[]`；负数/非整数 400 `since must be a non-negative integer`）。带 `since` 时存储层走**尾部读**（`readEventsFrom`）：文件仍整体读入（无行偏移索引），但跳过的行不解析、不构建，增量拉取的开销随返回条数而非流总长走 | `SessionEvent[]`（append-only，按事件序；含 session.created / message / message.truncated / compaction / memory / skill / system / sandbox.checked / run.started / run.ended / permission.decided / team.* 等全部 22 种事件，见 [storage](../core/storage.md)） |
| GET | `/sessions/:id/queue` | 排队消息快照：重连/刷新后校正客户端状态的全量依据 | — | `QueueEntry[]`（`queue.jsonl` 整文件读出，数组顺序即执行顺序；steer 条目排在可执行条目之后；空队列返回 `[]`） |
| POST | `/sessions/:id/disposition` | 会话级发送处置覆盖（CLI `/steer`、`/wait` 与 Web 三选的 steer/wait 的持续生效存储；interrupt 在 Web 为一次性、CLI 为 `/interrupt` 一次性动作，均不写覆盖） | `{disposition: "steer"\|"wait"\|"interrupt"}` 必填；非法值 400 `disposition must be "steer", "wait" or "interrupt"` | `SessionMeta`（写入 `dispositionOverride`，优先于配置默认） |
| GET | `/sessions/:id/compactions` | 压缩审计记录（事件流里 `compaction` 事件的只读视图） | — | `CompactionRecord[]`（从 events.jsonl 过滤 `compaction` 事件按事件序返回；无事件返回 `[]`） |
| POST | `/sessions/:id/compact` | 手动压缩：跳过触发线立即压缩一次（机制见 [compaction](../core/compaction.md)） | `{focus?}`：可选非空字符串，作为重点说明进入两次摘要调用；空串/非字符串 400 `focus must be a non-empty string` | `{message: string, queued?: boolean}`：成功 `压缩了 N 段，剩 X 条原文消息`；无可压缩内容 `无可压缩内容`；会话忙时排队 `{queued: true, message: "已排队：当前运行结束后自动压缩"}` |

`:id` 不存在时上述全部返回 `404 {error:"session not found"}`；body 校验失败返回 400（如 `title must be a non-empty string`）。compact 的额外路径：会话活跃不拒绝而是**排队**（200 `{queued: true, message: "已排队：当前运行结束后自动压缩"}`，运行结束的收尾链自动冲刷）；队列非空仍拒绝 409 `还有 N 条排队消息，先处理或取消`（排队消息会连开多个 run，压缩窗口无法预期）；RunManager 未组装时 503。

`SessionMeta` 字段（`packages/core/src/session/store.ts`）：

```ts
interface SessionMeta {
  id: string            // ses_<ULID>
  title: string
  createdAt: string     // ISO-8601
  updatedAt: string     // message / message.truncated / compaction 等事件会刷新；memory / system 事件不推进
  jobId?: string        // 由定时任务创建的会话带此字段
  workdir?: string      // 会话级工作目录（run 以它覆盖全局 workspace）
  model?: string        // 会话级模型覆盖（默认 → 守护进程默认模型）
  mode?: "readonly" | "default" | "acceptEdits" | "trusted" | "auto"   // 会话权限模式（默认 default）
  deleted?: boolean
  deletedAt?: string
  compaction?: { segments: { upto: string; summary: string }[]; top: string; upto: string }
                              // 分层压缩状态（由 compaction 事件投影），字段语义见 compaction.md
  dispositionOverride?: "steer" | "wait" | "interrupt"
                              // 会话级发送处置覆盖（POST /disposition 写入；优先于 sessions.defaultDisposition）
}
```

`QueueEntry`（类型的权威定义在 `packages/core/src/protocol/wire.ts`，`session/store.ts` re-export）：

```ts
interface QueueEntry {
  messageId: string                       // 分配即固定；出队执行/steer 注入用同一 id 构建 Message
  disposition: "steer" | "wait" | "interrupt"
  text: string
  trigger: "user" | "job" | "agent"       // 还原触发源（agent = subagent run；job 的 note/触发语义在出队执行时需要）
  attachments?: AttachmentRef[]           // {path,name,size,mimeType}，路径已校验（与 send_message 帧同一形状）
  note?: string                           // job 来源说明
  enqueuedAt: string                      // ISO-8601
}
```

### 任务（routes/jobs.ts，底层 `JobScheduler`）

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| POST | `/jobs` | 创建定时任务 | `{name, cron, prompt}` 三者都必填、非空字符串（cron 是 cron 表达式：`分 时 日 月 周` 五段的时间表写法）；可选 `{model}`（该任务的模型覆盖，非空字符串） | 201，`Job`；cron 解析失败 400（cron-parser 的原始报错原样返回） |
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
  model?: string             // 任务级模型覆盖（默认 → 回退到会话/默认解析链）
}
```

### 配置（routes/config.ts）

| 方法 | 路径 | 用途 | 响应 |
|------|------|------|------|
| GET | `/config` | 读当前配置（脱敏副本） | `KclawConfig`，所有 provider 条目的 `apiKey` 与 `web.tavilyApiKey` 掩码 |

脱敏规则（`sanitizeConfig` + `maskSecret`）：先 `structuredClone` 深拷贝再改（原对象保持不变），掩码为 `"***" + 末 4 字符`（不足 4 字符则纯 `"***"`，空串同）。其余字段原样返回。`GET /config` 本身只读；配置的写面在下面的 provider 管理族。

### Provider 管理（routes/providers.ts）

| 方法 | 路径 | 用途 | 请求/响应 |
|------|------|------|------|
| GET | `/providers` | Model 页快照：条目（key 掩码）+ 默认条目 + 内置预设目录 | `{default, entries, presets}`；`entries` 形状同 `config.providers.entries` 但 apiKey 已掩码 |
| POST | `/providers` | 新增一个条目 | 请求 `{name, entry}`；名字限定字母/数字/下划线/连字符（会话 meta 与 `/model` 命令按名引用）；`entry` 经 `parseProviderEntry` 校验（format 必须是 `openai`/`anthropic`，baseUrl 须 http(s)，model 必填，apiKey 可空，`contextWindow`/`maxOutput` 声明时必须为正数）；重复 409、形状非法 400；返回 `{ok, default, entries, presets}` |
| PATCH | `/providers/:name` | 整体替换一个条目，可同时改名 | 请求 `{entry}`，可带 `{name}`（新名字，与旧名不同即改名）；`apiKey` 为空 = 保留存量密钥（UI 只有掩码值）；改名时把条目键整体迁移，`providers.default` 与记忆提取/向量检索的引用（`memory.extractModel`、`memory.embedding.provider`）一并跟随；会话级引用保留旧名（下个 run 回退到默认条目，与删除同语义）；名字未知 404、改名目标已存在 409 |
| DELETE | `/providers/:name` | 删除一个条目 | 默认条目 409（先切默认再删）；被会话引用**不阻断**（引用方下个 run 回退到默认条目，WebUI 删除前自行提示）；名字未知 404 |
| POST | `/providers/:name/default` | 把该条目设为默认 | 名字未知 404 |
| POST | `/providers/models` | 模型列表检测（兼作连接验证） | 请求 `{name}`（用存量条目的真实密钥检测，`format`/`baseUrl`/`apiKey` 字段可逐项覆盖——编辑表单的草稿值检测）或 `{format, baseUrl, apiKey?}`（新建表单直探）；成功 `{ok: true, models: string[]}`，检测失败（端点不可达、密钥错误、响应形状不对等一律）502 `{ok: false, error}` |

所有变更路由直接改 daemon 的内存配置（**下一个 run 即热生效**：持久化后经 ConfigNotifier 发布 `providers` 变更，daemon 的客户端解析器整体清空缓存；条目签名检查保留为优化）并经 `saveConfig` 持久化：每次写都是 config.json 的整文件原子重写（0600，密钥明文只在盘上；MCP server 不经此写入，mcp.json 是唯一管理源）；持久化失败只记日志不回滚，但变更通知照发——内存里的改动已经生效，缓存不能停留在旧值上，下次写入会再试。条目改名（PATCH 带 `name`）经 `renameProviderEntry` 统一挪键并改写配置级引用（默认指针与记忆提取/embedding 条目）。没有审计事件（全局配置面，与 MCP 管理同判）。使用方是 WebUI 的 Model 页。

### 记忆（routes/memory.ts，底层 `MemorySystem`）

`/memory` 管理路由族：读取与整文件覆写/删除记忆系统里的项目主题线（L1）与全局认知文件（L2）。机制与文件格式见 [memory](../core/memory.md)。与附件/用量"仅注入时注册"不同，这组**始终注册**——`createApp` 未组装 `MemorySystem`（`opts.memory` 缺失，常见于测试）时，命中任何一条都返回 `503 {error:"memory system unavailable"}`，而不是 404。

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
| POST | `/memory/trigger-manual` | 手动触发当前项目的手动写入：与定时/跟随同一条 pipeline，范围 = 归属会话自上次提取位置以来的新消息（会话默认回退到项目最近活动会话） | `{workdir?, sessionId?}`：均可选，workdir 默认回退到 `config.workspace`，sessionId 默认回退到项目最近活动会话 | `{ok:true}`；`memory.write.manual=false` 时 400 `手动写入已关闭（memory.write.manual=false），可依赖定时/跟随触发`；pipeline 异常 500 |

`:id`/`:project`/`:topic`/`:file` 的路径段先过白名单校验（`isSafeSegment`：段非空、非 `.`、非 `..`、不含 `/`，拦目录穿越段；允许 CJK/空格，URL 里已 encodeURIComponent）。非法段返回 400 `invalid segment`；合法段按原样传给 `MemorySystem`，读侧宽容（找不到就 404），写侧是整文件覆写，请求体就是文件的新内容。`GET /memory/projects/:id` 的响应包装成 `{id, threads}` 是为前端取数方便（见 [memory](../core/memory.md) 的管理界面一节）。删除类的机器语义：删的是文件，`vectors.db` 里的对应条目由随后的 reindex 清除。

### 技能（routes/skills.ts，始终注册）

技能管理接口（CLI `/skill` 与 Web 技能页、技能即斜杠命令的共同后端），分只读、复用管理与提案治理三半。技能是以文件为准——`~/.kclaw/skills/`（全局）与工作区 `.kclaw/skills/`（项目级，覆盖全局）下的每个子目录一份 `SKILL.md`；机制、字段与复用链接见 [skills](../core/skills.md)。每次请求**重新扫描**这两个作用域（与 run 时的注入同源同规则），`?workdir=` 指定项目级作用域（默认无项目级）。

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| GET | `/skills?workdir=` | 用户可见技能清单 | `workdir` 可选：会话工作目录，决定项目级技能作用域 | `{name, displayName, description, visibility, origin, plugin}[]`——`visibility` 为 `all`（模型+用户）或 `user-only`（被 `disable-model-invocation` 隐藏但仍用户可见）；`origin` 为 `global` / `project`；`plugin` 为可选的来源插件名（插件自带的技能才带） |
| GET | `/skills/:name?workdir=` | 单个技能详情（含正文） | 同上 | `{name, displayName, description, visibility, origin, plugin, content}`——`content` 是 `SKILL.md` 正文 |
| GET | `/skills/discovery?workdir=` | 检测其他 agent 的可复用技能 | 同上 | `{sources, skills, projectSources}`——`sources` 是检测来源（含失效标），`skills` 是发现列表（realpath 去重、来源聚合、`reused`/`conflict`/`stale` 标、插件技能带 `plugin` 名），`projectSources` 是项目作用域自行登记的来源 |
| POST | `/skills/discovery/preview` | 预览候选 SKILL.md 正文 | `{path}` | `{name, body}`；路径必须解析到已发现候选或位于已登记来源之下，否则 404 |
| GET | `/skills/links?workdir=` | 当前作用域链接记录与自定义来源 | 同上 | `{links: {name, target, agent, tier, current}[], extraSources: string[]}`——直接读旁挂文件，不受用户可见性过滤影响；`current` 为 false 表示目标已不是检测正在提供的版本（插件升级过，链接可用但过时） |
| POST | `/skills/links` | 建复用链接（软链接 + 记录） | `{name, target, agent?, tier?, workdir?}` | 201 `{ok:true}`；同名冲突或已复用 409、目标不合法 400；`workdir` 必须绝对路径，默认全局 |
| PATCH | `/skills/links/:name` | 改复用技能的可见档位 | `{tier: all\|user\|model\|off, workdir?}` | `{ok:true}`；无记录 404、档位非法 400 |
| DELETE | `/skills/links/:name?workdir=` | 取消复用（删链接 + 清记录） | query | `{ok:true}`；无记录 404 |
| POST | `/skills/sources` | 登记自定义检测目录 | `{dir, workdir?}` | 201 `{ok:true}`；重复 409 |
| DELETE | `/skills/sources?dir=&workdir=` | 移除自定义检测目录 | query | `{ok:true}`；无记录 404 |

`:name` 路径段先过白名单校验（同 `/memory` 的 `isSafeSegment`），非法段 400 `invalid segment`。**`user-invocable: false` 的技能对用户面视为不存在**：列表不显示、按名调用返回 404——且与未知名字同响应（`{error:"not found"}`，不泄露存在性）。

**提案治理路由族**（技能进化，`registerSkillRoutes` 的 opts 带 `skillsEvolution` 时注册；未组装时整体 503 `skill evolution is not assembled`，不影响上面的既有路由）。治理写操作均经全局 token 鉴权中间件。机制见 [skills](../core/skills.md) 的"技能进化"一节。

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| GET | `/skills/proposals?status=` | 提案列表（applied 项带用量） | `status` 可选：proposed/applied/rejected/reverted，默认返回全部 | `{proposals: [完整 SkillProposal 字段 + applied 项带 usage（采纳后 skill_read 次数）]}`；单个损坏提案文件跳过，不拖垮列表 |
| GET | `/skills/proposals/:id` | 单个提案详情 | — | 完整 SkillProposal（applied 带 `usage`）；不存在 404；路径段先过 `isSafeSegment` |
| POST | `/skills/proposals/:id/apply` | 确认提案（proposed → applied） | — | `{ok:true}`，可带非致命 `warning`（修订的现正文与提案时 baseline 不一致、或全局新增将被他项目同名技能遮蔽）；非法迁移/同名冲突/目标是复用链接技能 409、不存在 404 |
| POST | `/skills/proposals/:id/reject` | 驳回提案（proposed → rejected，只改状态） | — | `{ok:true}`；非法流转 409、不存在 404 |
| POST | `/skills/proposals/:id/revert` | 回退已采纳提案（applied → reverted：修订写回快照、新增删技能目录） | — | `{ok:true}`；非法流转 409、不存在 404 |
| DELETE | `/skills/proposals/:id` | 删除提案文件（仅 rejected/reverted 可删） | — | `{ok:true}`；其余状态 409、不存在 404 |

### hook（routes/hooks.ts，始终注册）

只读的 hook 管理接口：内置 hook 的静态清单 + 用户 hook 文件的当前装载状态，机制见 [hooks](../core/hooks.md)。

| 方法 | 路径 | 用途 | 响应 |
|------|------|------|------|
| GET | `/hooks` | 内置 + 用户 hook 的只读快照 | `{builtin: [{name, position, description, failure, origin:"builtin"}], user: [{name, position, description?, enabled, order, failure, origin:"user", error?}]}`——`user` 侧含健康、禁用（`enabled:false`）与装载失败（`position:"?"` 且带 `error` 原因）三类条目；未注入 `HookRegistry` 时 `user` 为空数组 |

### 权限（routes/permissions.ts，始终注册）

沉淀规则（decided rules，即用户在确认里选"总是允许"后保存下来的放行规则）的只读管理接口：规则写入磁盘时做了收紧处理，机制与文件格式见 [permissions](../core/permissions.md)。文件本身仍可手写；本组只提供列表与删除（删除即收回自动放行）。实现位于 `packages/core/src/storage/decided-rules.ts`。

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| GET | `/permissions/rules` | 两档规则清单 | `workspace?` 可选：项目档所在工作区，默认回退 daemon 配置 `config.workspace` | `{global: {path, rules}, project: {path, tracked, ignored, rules}}`（每档 `rules` 为 `DecidedRuleEntry[]`（`{rule, decidedAt, origin:{tool, argsJson?, sessionId?}}`）；`project.ignored` 恒等于 `tracked`，项目档被 git 跟踪时两者为 `true` 且 `rules` 恒空，被忽略的规则不生效，UI 据此解释） |
| DELETE | `/permissions/rules` | 删除单条规则 | `{scope: "global"\|"project", index: number}`，`workspace?` 可经 body 或 `?workspace=` 查询参数附带（body 优先；WebUI 走查询参数，与列表请求同一形状）；scope 非法 400 `scope must be "global" or "project"`、index 非非负整数 400 `index must be a non-negative integer`；`workspace` 决定项目档路径，默认回退 `config.workspace` | `{ok: true, removed}`（removed 为被删条目）；index 越界 404 `{error:"not found"}` |

两档文件路径：全局 `<home>/permissions.yaml`、项目 `<workspace>/.kclaw/permissions.yaml`（首次写入时自动创建 `.kclaw` 目录并追加 gitignore 条目）。

### 附件（routes/attachments.ts，仅当注入 `attachmentsDir` 时注册）

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| POST | `/sessions/:id/attachments?filename=<名>` | 上传附件 | body 是**原始字节流**（Content-Type 任意的 Buffer），文件名走 query；上传即保存到 `<attachmentsDir>/<sessionId>/<att_<ULID>>__<净化后文件名>` | `{file: {path, name, size}}` |
| GET | `/sessions/:id/attachments` | 附件清单 | — | `{name, size}[]`，mtime 新的在前；尚无附件目录时返回 `[]` |
| GET | `/sessions/:id/attachments/:file` | 下载附件 | — | 文件字节流 |

出错形状：缺 `filename` 或空 body → 400；超过上限 **20MB** → 413 `attachment too large (max 20MB)`；下载路径解析后逃出会话附件目录 → 400 `invalid attachment path`（遍历防护）；目标不是文件 → 404 `attachment not found`。文件名经净化处理：去掉路径分隔符与控制字符等，去掉后为空时用 `"file"`。为接收任意类型的原始 body，该组路由注册了一个通配 content-type 解析器（Buffer 原样收下；JSON parser 仍优先匹配 application/json）。

### 目录浏览与用量

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| GET | `/fs/browse` | 列出某目录的子目录（WebUI 工作目录选择器的数据源） | query `path`：绝对路径或 `~` 开头（与权限引擎同样的展开规则）；默认列 `config.workspace` | `{path, parent, dirs}`——path 为符号链接解析后的规范绝对路径；parent 为父目录，文件系统根处为 null；dirs 只含子目录名、大小写不敏感排序。符号链接跟随解析（坏链跳过），macOS 的 `/tmp → private/tmp` 一类仍可导航 |
| GET | `/fs/files` | 列出一个工作区的文件清单（WebUI 输入框 `@` 文件引用抽屉的数据源，机制见 [file-mentions](../core/file-mentions.md)） | query `workdir`：绝对路径或 `~` 开头（与 `/fs/browse` 同一 `resolveQueryDir` 解析）；默认列 `config.workspace` | `{workdir, files, truncated}`——workdir 为符号链接解析后的规范路径；files 为工作区相对路径（POSIX 分隔、仅文件、大小写不敏感排序）；truncated 为清单是否在 5000 条上限处被截断。git 仓库走 `git ls-files -z -co --exclude-standard`（跟踪 + 未被 ignore 的未跟踪文件，NUL 分隔保中文名），非 git 回退递归扫描（不进入 `.git`/`.kclaw`/`node_modules`） |
| GET | `/usage?by=day\|session\|model` | token/费用用量聚合 | `by` 三选一；无效值静默回退到 `day` | `{by, buckets[], total}`——bucket/total 形状同为 `{key, inputTokens, outputTokens, costUsd}`，费用按 `config.usage.prices` 计价，未配置价格的模型计 0 |

`/fs/browse` 与 `/fs/files` 的出错是三态 400：`path does not exist: <path>`、`not a directory: <path>`、`cannot read directory: <path>`。这两个端点能列出本机任意目录——浏览端点的设计目的就是允许把工作目录设在任何地方，防线只有与其他 API 相同的 Bearer 鉴权；文件清单端点限制在工作区内（`workdir` 必须是目录），但同样不校验目录归属。用量数据记录在一张 SQLite 表里，数据来源见 [storage](../core/storage.md) 的用量记录一节。

### MCP 管理

| 方法 | 路径 | 用途 | 请求/响应 |
|------|------|------|------|
| GET | `/mcp` | MCP server 连接状态快照 | `{servers: [{name, state, scope, tools: {name, server, originalName, description}[], config, lastError?}]}`（`scope` 为该条目的来源层 `"global" | "project"`（两层配置见 [mcp](../core/mcp.md)）；`config` 为该 server 的 `McpServerConfig`，含地址等；`tools` 里的 `server` 是所属 server 名、`originalName` 是远端原名、`description` 供工具清单与 `/mcp <名字>` 展示） |
| POST | `/mcp/servers` | 新增一个 server 并后台连接 | 请求 `{name, config, layer?}`；`layer` 为 `"global" | "project"`、默认 global（新增条目的目标层，编辑不改层）；名字限定字母/数字/下划线/连字符（会进模型可见的工具名）；名字缺失/为空 400（`name is required`）；返回 `{ok, servers}`；名字重复（两层中任一占用）409、形状非法 400 |
| PATCH | `/mcp/servers/:name` | 整体替换一个 server 的配置并重连 | 请求 `{config}`；条目留在它自己的层（项目层条目改完仍写回项目文件）；名字未知 404 |
| DELETE | `/mcp/servers/:name` | 删除一个 server（断开并遗忘） | 返回 `{ok, servers}`；删除的是项目条目且全局层有同名条目时，全局条目立即恢复生效；名字未知 404 |
| POST | `/mcp/servers/:name/enable` | 启停开关（持久、热生效） | 请求 `{enabled: boolean}`；非布尔 400（`enabled must be a boolean`）；禁用即断开、启用即发起一次连接 |
| POST | `/mcp/servers/:name/reconnect` | 对失败/掉线的 server 手动发起一次连接 | 一次性尝试、不在背后排退避；对已连接的 server 是无操作；对禁用中的 server 400 |

路由始终注册；daemon 未组装 McpManager 时 `GET /mcp` 的 `servers` 为空数组、全部动作端点回答 503。任何一次保存动作（增删改启停）都会把变更持久化到**拥有它的那层**：全局层写 daemon 主目录的 `mcp.json`，项目层写回工作区 `.kclaw/mcp.json`；使用方是 WebUI 的 MCP 页、双端的 `/mcp` 命令与 CLI 的 `kclaw mcp [list]`。连接状态机与两层合并规则见 [mcp](../core/mcp.md)。

### IM Channel 管理

| 方法 | 路径 | 用途 | 关键字段 |
|---|---|---|---|
| GET | `/channel` | 飞书频道配置与状态快照（WebUI「IM Channel」页） | `{config: {enabled, appId, appSecretSet, allowlist, primaryOpenId?}, status: {state: "disabled"/"running"/"error", error?}, pendingSenders: [{openId, count, lastSeen}]}`；`appSecretSet` 只表"是否已设置"，secret 内容不出现在任何响应里 |
| POST | `/channel/config` | 保存配置并热重启通道（不重启 daemon） | 请求 `{enabled, appId, appSecret?, allowlist, primaryOpenId?}`；`appSecret` 为空即保持已存值；校验失败（enabled 缺凭据、推送接收人不在白名单）400；返回保存后的新快照 |
| POST | `/channel/test` | 用草稿凭据验证飞书应用身份（换一次 access token），不写入文件 | 请求 `{appId, appSecret?}`；secret 留空时用已存值；返回 `{ok, error?}` |
| POST | `/channel/allowlist/:openId` | 一键加白：open_id 写入白名单并热重启，同时清除对应待加白记录 | 幂等（已在白名单则不重启）；返回新快照 |

路由始终注册；daemon 未组装频道管理器时 `GET /channel` 返回未启用快照、动作端点回答 503（与 MCP 组同款）。机制、热重启语义与待加白说明见 [feishu-channel](./feishu-channel.md)。

### WS 与静态托管

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/ws` | WebSocket（建立后可双向收发消息的长连接）升级端点；HTTP 鉴权豁免，连接内首帧认证，协议见 [realtime](./realtime.md) |
| GET | `/`、`/assets/*` | 仅当 `webDist` 已配置时由 `@fastify/static` 托管构建产物；外壳三路径加 PWA 静态文件（`/manifest.webmanifest`、`/sw.js`、`/icon-192.png`、`/icon-512.png`、`/favicon.svg`、`/favicon.ico`）免鉴权，其余静态文件仍需 Bearer |

**队列相关的 WS 命令与事件**（完整帧语义见 [realtime](./realtime.md) 与 [run-manager](./run-manager.md)）：

- `send_message` 增加可选 `disposition` 字段（`"steer"|"wait"|"interrupt"`；非法值 error 帧 `send_message disposition must be "steer", "wait" or "interrupt"`）。不带字段取会话覆盖 ?? 配置默认（**默认引导**）。回包 `send_message_ack` 增加 `messageId` 与 `queued`（会话空闲直发 `queued:false`、不广播 `message.queued`；运行中按处置分流 `queued:true`）。会话忙时超限的 error 帧文案：`队列已满（10 条）`。
- `queue.cancel`：`{sessionId, messageId?}`——带 id 取消该条（wait 随时、steer 注入前），不带则清空全部可取消条目。回 `queue.cancel_ack {sessionId, cancelled}`；失败为 error 帧：已注入 `已注入`（机器不删历史）、无此条目 `not found`。
- `message.retry`：`{sessionId, fromMessageId, text, attachments?}`——编辑重试/重新生成的服务端入口（机制见 [run-manager](./run-manager.md)）：校验通过后先持久化并广播 `message.truncated {fromMessageId}`（从该消息起退出对话视图），再走普通用户消息路径提交；回 `message.retry_ack {sessionId, messageId, queued}`（与 send_message 同步决策的形状一致）。同步失败为 error 帧：`只能从最后一条用户消息重试`（fromMessageId 不是最后一条 user 消息）、`会话忙：等当前运行和压缩结束、清空队列后再重试`、`重试内容为空（无文本也无附件）`、subagent 会话只读拒绝。
- 三个新事件：`message.queued {messageId, disposition, position?}`（消息入队/入缓冲区时；position 是 wait/interrupt 的队列序位，steer 不适用；降级按实际处置报告）、`message.steered {messageId}`（steer 注入当前 run 的时刻，事件级 `runId` 标识注入的 run）、`message.queue_cancelled {messageId}` 或 `{all:true}`（单条取消/清空）。出队执行与注入仍用既有 `run.started` + `message.created` 表达，消息 id 与排队时相同——前端气泡原地升级，无需替换。

**记忆写入事件 `memory.written`**：记忆写入 pipeline 每次实际写入磁盘时经总线广播，帧为 `memory.written {path, kind, topic?, scope?}`——`kind` 是 `"episode"`（项目情节，带 `topic` 线名）或 `"cognition"`（全局认知，带 `scope`），`path` 是写入文件的绝对路径；不带 `sessionId`（项目级事务）。它只作"已写入"的轻提示：CLI 用暗色一行显示 `已写入记忆: <path>`，web 在通知条显示同文案，都不驱动任何状态机。事件不带"记忆内容"，要看内容走上面的 `/memory` 路由。payload 定义见 [protocol](../core/protocol.md)。

## 审计的读取方式

web 的审计页（`packages/web/src/audit/AuditView.tsx`）演示了标准用法：

1. 会话选择跟随应用侧栏的全局选中（也支持 `?tab=audit&session=<id>` 深链）；
2. `GET /sessions/:id/events?since=0` 获取该会话**完整事件流**（`SessionEvent[]`，append-only、按事件序）；
3. 客户端按流序摊平成逐行审计：`message` 事件每条消息按块（block）摊平（role + 类型标签 + 摘要，点击展开完整块；assistant 消息的最后一块行上显示 token 用量与 LLM 耗时 `latencyMs`，tool_result 行显示执行耗时 `durationMs`）、`message.truncated` 事件渲染成"截断"行（消息截断 · 从 `<起点>` 起退出对话视图，编辑重试/重新生成的记录）、`compaction` 事件渲染成"压缩"行、`memory` 事件渲染成"记忆"行、`skill` 事件渲染成"技能"行（技能提案的产生/采纳/驳回/回退/删除各一行，点击展开完整事件字段，见 [skills](../core/skills.md)）、`system` 事件渲染成"系统提示词"行（开头片段 + 字符数，点击展开全文，按稳定段/实时段两段展示；与相邻上一条文本不同标"已变化"）、`sandbox.checked` 事件渲染成"沙箱"行（可用 / 不可用（原因）/ 已关闭）、`run.started`/`run.ended` 渲染成"运行"行（触发来源 / 停止原因 + 用量，失败带错误，与消息事件夹出每轮边界）、`permission.decided` 渲染成"权限"行（裁决 + 裁决者 + 工具身份，展开看参数）、会话元数据事件（created/renamed/deleted/restored/set）渲染成轻量"会话"行，`team.*` 七种事件渲染成"team"行（建团/添加/组员状态/收信/送达/任务创建/任务状态的摘要，点击展开完整内容）。**二十二种持久化事件全部渲染成行**；
4. 实时增量：页面私有 ws 连接订阅会话，收到 `session.appended` 通知帧（存储层写入磁盘成功后发出，先写入磁盘再广播）即 `GET /sessions/:id/events?since=<已有条数>` 增量拉取，append-only 下标做游标、断线重连后重拉补齐。

只读、不修改任何状态、无独立 `/audit` 路由——事件流（`events.jsonl`，一行一个事件的 append-only 文件）是审计的唯一事实来源，HTTP 只是它的读取窗口。tool 消息上的 `grantedBy`（每个工具调用的放行原因）随 `message` 事件一起返回，是"谁批准了这个操作"的审计依据。

压缩审计不再单独拉取：`compaction` 事件就在同一事件流里，审计页随事件流一并渲染（`GET /sessions/:id/compactions` 仍存在，是它的只读投影视图，见 [compaction](../core/compaction.md)）。

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
- token 错误/缺失一律 `401 {error:"unauthorized"}`，不区分"未附带"与"附带错误"（不向检测者提供信息）。
- 会话/任务两个分组注册的 `setErrorHandler` 只处理 body 解析类错误（`error.statusCode ?? 500`），不影响鉴权 hook——hook 先于 handler 运行。

## 边界与出错

- **无分页，只有增量**：`GET /sessions` 与 `GET /sessions/:id/messages` 全量返回；`GET /sessions/:id/events` 全量返回但支持 `?since=` 增量游标（append-only 下标）。个人使用规模下接受；审计页的列表渲染在客户端用虚拟滚动（只渲染可视行）承载大会话。
- **软删除的会话不在默认列表**：`GET /sessions` 默认过滤 `deleted:true`；要操作回收站必须显式 `?deleted=true`（恢复/永久删除路由不区分列表，直接按 id 操作）。
- **PATCH `/sessions/:id` 的 workdir 是解析但未生效的字段**（源码只把 title 传给 `updateMeta`）——API 处理者不应依赖它。
- **`POST /jobs` 的 cron 校验依赖 cron-parser 的报错文本**，客户端展示的是原始英文错误。
- **并发写无版本控制**：两个客户端同时 PATCH 同一资源是"后写赢"，没有乐观锁（加版本号防并发覆盖的机制）。
- **上传 ≠ 挂载**：附件这三个路由只负责把字节写到磁盘、列举和下载。附件要真正进入对话，还需要客户端在下一条 send_message 帧里带上这些文件的路径，由 run 的挂载步骤转成模型能读的内容，详见 [realtime](./realtime.md) 与 [run-manager](./run-manager.md)。

## 关联

- [daemon](./daemon.md)：鉴权豁免的设计理由、静态托管的配置来源
- [realtime](./realtime.md)：`/ws` 端点的帧协议
- [run-manager](./run-manager.md)：send_message 背后的三处置决策、队列驱动器与附件挂载（`/queue` 快照与 compact 409 的服务端语义）
- [storage](../core/storage.md)：SessionStore/JobScheduler/UsageStore 的持久化实现
- [compaction](../core/compaction.md)：compact/compactions 两个路由背后的机制与事件流里的记录格式
- [memory](../core/memory.md)：`/memory` 路由族背后的记忆系统存储与 `memory.written` 事件
- [mcp](../core/mcp.md)：`GET /mcp` 快照背后的连接管理器
- [skills](../core/skills.md)：`/skills` 路由族背后的技能机制（渐进披露、双作用域、可见性档位）
- [hooks](../core/hooks.md)：`/hooks` 路由背后的 hook 系统（位置网格、内置清单、用户文件契约）
- [client-http](../core/client-http.md)：客户端共享的 HTTP 请求基座——`{error}` 形状的使用方
- [jobs](../core/jobs.md)：cron 语义与 nextRunAt 推进规则
