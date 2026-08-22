# http-api — HTTP 路由

## 职责

`packages/server/src/app.ts` 的 `createApp` 组装 daemon 的 Fastify 应用：一个全局鉴权钩子加 15 个业务路由（健康/状态 2 个、会话 7 个、任务 4 个、配置 1 个、WS 1 个）与可选的静态托管。路由实现分在 `packages/server/src/routes/`（`sessions.ts`、`jobs.ts`、`config.ts`）。本文逐个列出方法、路径、用途与请求/响应关键字段；WS 端点的帧协议见 [realtime](./realtime.md)。

## 设计决策

- **鉴权一个钩子管全部**：`preHandler` 比对 `Authorization: Bearer <token>`（恒时比较），失败统一 `401 {error:"unauthorized"}`。豁免只有 `/health`、`/ws`、静态外壳三种（设计理由见 [daemon](./daemon.md) 的鉴权设计一节）。
- **错误形状统一为 `{error: string}`**：每个路由分组（scope）注册 `setErrorHandler`，把 Fastify 的 body 解析错误（非法 JSON、空 body）也归一成这个形状，客户端只需一种解析逻辑。
- **404 显式可判别**：会话/任务路由先查存在性（`sessions.meta(id)` / `jobs.get(id)`），不存在返回 `404 {error:"session not found"|"job not found"}`，不靠异常路径。
- **配置接口只读且脱敏**：API key 永远掩码返回，没有写回路由——改配置走文件（config.yaml），daemon 重启生效。
- **审计轨迹没有专门路由**：轨迹页（web 的 `AuditView`）就是 `GET /sessions`（会话下拉）+ `GET /sessions/:id/messages`（按会话拉消息列表）两个只读接口组合出来的；不存在 `/audit` 路由。

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
| POST | `/sessions` | 创建会话 | `{title?, workdir?}`（均可缺省；给了就必须是非空字符串） | 201，`SessionMeta`（title 缺省为 `"新会话"`） |
| GET | `/sessions` | 会话列表（updatedAt 新的在前） | 查询参数 `deleted=true` 查回收站；缺省只回未删除的 | `SessionMeta[]` |
| PATCH | `/sessions/:id` | 改名 | `{title?}`（非空字符串；body 里的 `workdir` 被解析但**不生效**，只有 title 传给 `updateMeta`） | `SessionMeta` |
| DELETE | `/sessions/:id` | 软删除（移入回收站，标记 `deleted`/`deletedAt`） | — | `SessionMeta` |
| POST | `/sessions/:id/restore` | 从回收站恢复（清掉 `deleted`/`deletedAt`） | — | `SessionMeta` |
| POST | `/sessions/:id/purge` | 永久删除（整个会话目录删除） | — | `{ok: true}` |
| GET | `/sessions/:id/messages` | 读全部消息（轨迹/断线恢复的数据源） | — | `Message[]`（JSONL 逐行读出的完整对话史） |

`:id` 不存在时上述全部返回 `404 {error:"session not found"}`；body 校验失败返回 400（如 `title must be a non-empty string`）。

`SessionMeta` 字段（`packages/core/src/session/store.ts`）：

```ts
interface SessionMeta {
  id: string            // ses_<ULID>
  title: string
  createdAt: string     // ISO-8601
  updatedAt: string     // appendMessage/updateMeta 都会刷新
  jobId?: string        // 由定时任务创建的会话带此字段
  workdir?: string      // 会话级工作目录（run 以它覆盖全局 workspace）
  deleted?: boolean
  deletedAt?: string
}
```

### 任务（routes/jobs.ts，底座 `JobScheduler`）

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| POST | `/jobs` | 创建定时任务 | `{name, cron, prompt}` 三者都必填、非空字符串（cron 是 cron 表达式：`分 时 日 月 周` 五段的时间表写法） | 201，`Job`；cron 解析失败 400（cron-parser 的原始报文透传） |
| GET | `/jobs` | 任务列表 | — | `Job[]` |
| PATCH | `/jobs/:id` | 修改 | `{name?, prompt?, cron?, enabled?}`（enabled 必须是布尔；未知字段忽略） | `Job`；cron 解析失败 400 |
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
}
```

### 配置（routes/config.ts）

| 方法 | 路径 | 用途 | 响应 |
|------|------|------|------|
| GET | `/config` | 读当前配置（脱敏副本） | `KclawConfig`，所有 provider 条目的 `apiKey` 与 `web.tavilyApiKey` 掩码 |

脱敏规则（`sanitizeConfig` + `maskSecret`）：先 `structuredClone` 深拷贝再改（原对象不动），掩码为 `"***" + 末 4 字符`（不足 4 字符则纯 `"***"`，空串同）。其余字段原样返回。没有对应的写路由。

### WS 与静态托管

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/ws` | WebSocket（建立后可双向收发消息的长连接）升级端点；HTTP 鉴权豁免，连接内首帧认证，协议见 [realtime](./realtime.md) |
| GET | `/`、`/assets/*` | 仅当 `webDist` 已配置时由 `@fastify/static` 托管构建产物；外壳三路径免鉴权，其余静态文件仍需 Bearer |

## 审计轨迹的读取方式

web 的轨迹页（`packages/web/src/audit/AuditView.tsx`）演示了标准用法：

1. `GET /sessions` 拿全部会话（下拉选择"按会话筛选"就是选 `:id`）；
2. `GET /sessions/:id/messages` 拿该会话全部 `Message[]`；
3. 客户端把每条消息按块（block）摊平成一行行轨迹（role + 类型标签 + 摘要，点击展开完整块）。

只读、无 mutation、无独立 `/audit` 路由——`messages.jsonl`（每行一条 JSON 的消息文件）就是唯一事实来源，HTTP 只是它的读取窗口。tool 消息上的 `grantedBy`（每个工具调用的放行原因）随 `Message` 一起返回，是"谁批准了这个操作"的审计依据。

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
- token 错误/缺失一律 `401 {error:"unauthorized"}`，不区分"没带"和"带错"（不给探测者信息）。
- 路由分组各自注册的 `setErrorHandler` 只兜 body 解析类错误（`error.statusCode ?? 500`），不影响鉴权钩子——钩子先于 handler 运行。

## 边界与出错

- **无分页**：`GET /sessions` 与 `GET /sessions/:id/messages` 都是全量返回；个人使用规模下接受，超大会话的截断在客户端渲染层做。
- **软删除的会话不在默认列表**：`GET /sessions` 缺省过滤 `deleted:true`；要操作回收站必须显式 `?deleted=true`（恢复/永久删除路由本身不分列表，直接按 id 操作）。
- **PATCH `/sessions/:id` 的 workdir 是解析但未生效的字段**（源码只把 title 传给 `updateMeta`）——API 消费者不应依赖它。
- **`POST /jobs` 的 cron 校验依赖 cron-parser 的报错文本**，客户端展示的是原始英文错误。
- **并发写无版本控制**：两个客户端同时 PATCH 同一资源是"后写赢"，没有乐观锁（加版本号防并发覆盖的机制）。

## 关联

- [daemon](./daemon.md)：鉴权豁免的设计理由、静态托管的配置来源
- [realtime](./realtime.md)：`/ws` 端点的帧协议
- [storage](../core/storage.md)：SessionStore/JobScheduler 的持久化实现
- [jobs](../core/jobs.md)：cron 语义与 nextRunAt 推进规则
