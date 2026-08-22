# jobs — 定时任务调度

## 职责

让 kclaw 在指定时刻自动发起会话并执行任务：`JobScheduler`（`packages/core/src/jobs/scheduler.ts`）把"cron 表达式 + 一段 prompt"作为一条 job 记录持久化在 SQLite；daemon 侧的 `startSchedulerTick`（`packages/server/src/scheduler-tick.ts`）周期轮询这张表，将到期的 job 转换为一次真实的 agent 运行，并将结果记录回 job 行。边界：调度器仅负责"何时触发、结果如何"；执行本身交给 RunManager（见 [run-manager](../server/run-manager.md)）；job 的增删改查 HTTP 接口在 `packages/server/src/routes/jobs.ts`。

---

## 设计决策

- **全部状态一张表**：job 的所有字段（含下次触发时间、上次结果）都存在 `<home>/jobs.db` 的 `jobs` 表里，进程内存中不缓存。每个 `JobScheduler` 实例打开同一个文件看到同一批行，daemon 可以使用全新句柄轮询，重启无需恢复步骤。
- **时间存 ISO-8601 字符串**：ISO 字符串的字典序就是时间序，所以"到期与否"可以下推成一条 SQL 字符串比较（`next_run_at <= now`），不需要读出整表在 JS 里比时间。
- **跳过积压**：`markRun` 把 `nextRunAt` 推进到"now 之后的下一次"，而不是"上次触发点加一个周期"。daemon 停机两小时后重启，`*/5` 的任务不会补执行 24 次错过的时间点，而是直接计算 now 之后的下一次。
- **`next()` 严格排他**：cron-parser 的 `next()` 对 `currentDate` 是排他的（恰好相等也不算），所以 `nextIsoAfter` 的语义是"严格晚于给定时刻的第一次触发"。无效 cron 表达式原样抛出 cron-parser 自身的错误消息，不做包装。
- **id 即创建序**：id 用 `newId("job")` 生成（ULID，一种按时间有序的唯一 id），`list()` 按 `ORDER BY id` 排序，天然就是创建顺序。
- **job 事件广播不带会话**：`job.started` / `job.completed` / `job.failed` 事件用不带上下文的 `makeEvent` 构造（无 sessionId/runId），EventBus 会把它们广播给每一个连接的客户端——任何界面都能看到调度活动，而不只是订阅了某个会话的客户端。
- **tick 失败不中断轮询**：一次 tick 抛错（`scheduler.due` 失败、单个 job 的记录步骤失败）只记日志并丢弃这一轮，`setInterval` 不中断——轮询循环必须能在自身失败后继续运行（v1 决策）。

---

## 数据模型

```ts
// packages/core/src/jobs/scheduler.ts
export type JobStatus = "ok" | "error"

export interface Job {
  id: string          // "job_" + ULID
  name: string
  cron: string        // 标准 5 段 cron 表达式（分 时 日 月 周）
  prompt: string      // 到点后作为用户消息发给 agent 的文本
  enabled: boolean
  nextRunAt: string   // ISO-8601，下一次触发时间
  lastRunAt?: string  // ISO-8601，上次实际触发时间
  lastStatus?: JobStatus
  lastError?: string  // 上次失败的消息；成功时清空
}
```

SQLite 表结构与之一一对应（`enabled` 存 0/1，驼峰字段转下划线列名 `next_run_at` 等）。

`JobScheduler` 的方法语义：

| 方法 | 语义 |
|------|------|
| `create(input)` | 插入一条 job；`enabled` 默认 true，`nextRunAt` = now 之后的第一次 cron 触发 |
| `list()` | 全部 job，按 id（创建序）排列 |
| `get(id)` | 取一条；不存在返回 undefined |
| `update(id, patch)` | 部分字段更新；见下方"启用/停用" |
| `remove(id)` | 物理删除；返回是否真的删了 |
| `due(now)` | `enabled = 1 且 next_run_at <= now` 的行，按到期先后排列 |
| `markRun(id, status, now, error?)` | 记录 `lastRunAt/lastStatus/lastError`（status 为 "ok" 时清空 lastError），并把 `nextRunAt` 推进到 now 之后的下一次（跳过积压）；job 已被删则什么都不做 |

---

## 核心流程

### tick 轮询（`packages/server/src/scheduler-tick.ts`）

`startSchedulerTick` 在 daemon 启动时被调用（`packages/server/src/daemon.ts`），启动后**立即执行一次检查**，随后 `setInterval` 每 `intervalMs` 执行一轮（默认 `DEFAULT_INTERVAL_MS = 30_000`，即 30 秒；daemon 侧默认值 `DEFAULT_SCHEDULER_INTERVAL_MS` 同为 30 秒）。

一轮 tick 完成两件事：

1. **触发到期的 job**：`scheduler.due(now())` 取出到期集合，逐个（同一轮内串行）触发不在 `inFlight` 集合里的 job。
2. **回收站清理**：`sessions.purgeExpired(purgeTtlMs)` 物理删除软删除超过保留期的会话（见下）。

单个 job 的触发流程（`fireJob`）：

1. 把 job.id 加入 `inFlight`（防止下一轮 tick 重复触发同一 job——`markRun` 只在运行结束后才推进 `nextRunAt`，在那之前该行一直是"到期"状态，重入防护完全依赖该集合）。
2. `sessions.create(job.name, job.id)` 创建一个新会话：标题即 job 名字，`jobId` 记进 `meta.json`。
3. 广播 `job.started {jobId}`。
4. `run.enqueue(sessionId, { userText: job.prompt, trigger: "job", note: "本会话由定时任务「<name>」触发" })`——RunManager 把 prompt 作为用户消息发起一次运行，该 note 写入用户消息上紧跟正文的 `kind: "job"` note 块（组装过程见 `packages/server/src/run.ts` 的 `#execute`）。
5. 运行结束：`outcome.stopReason !== "error"` → `markRun(id, "ok", now)` + 广播 `job.completed {jobId, summary: stopReason}`；否则 `markRun(id, "error", ...)` + 广播 `job.failed {jobId, error}`（enqueue 本身抛错也走同一条失败记录路径）。
6. `finally` 里将 job.id 移出 `inFlight`——无论成败都移除该条目。

**审计信息的位置**：没有独立的审计文件；一次触发的全部痕迹 = job 行上的 `lastRunAt/lastStatus/lastError` + 对应会话目录里完整的 `messages.jsonl`（job 会话与普通会话使用同一条持久化路径），以及广播的三个 `job.*` 事件。

### 会话命名

job 会话的标题在创建时就定为 `job.name`，而自动命名（`scheduleAutoname`，`packages/server/src/autoname.ts`）只对 `trigger !== "job"` 的运行触发——所以 job 会话的标题永远不会被自动改名覆盖。

### 启用 / 停用 / 删除

HTTP 接口（`packages/server/src/routes/jobs.ts`，均需 Bearer token）：

- `POST /jobs`：`{name, cron, prompt}` 三者必填且非空；cron 解析失败返回 400（cron-parser 的原始错误消息）。
- `PATCH /jobs/:id`：只接受 `name` / `prompt` / `cron` / `enabled` 四个字段，其余忽略；`enabled: false` 即停用——`due()` 只取 `enabled = 1` 的行，停用的 job 不触发但记录保留；`enabled: true` 重新启用。
- `DELETE /jobs/:id`：立即物理删除该行，没有软删除、没有回收站（这是 job 与会话在删除语义上的差别）。

`update` 的一个细节：patch 里带 `cron` 且不带 `nextRunAt` 时，`nextRunAt` 自动从 now 重算（修改周期后按新周期计算）；显式传 `nextRunAt` 则按传入值写入（测试用它回填时间）。

### 回收站 30 天自动清理

tick 的第二步 `sessions.purgeExpired(purgeTtlMs)`：把 `deletedAt` 距今 ≥ 保留期的软删除会话整目录删除。保留期来自 `config.yaml` 的 `sessions.recycleBinTtlMs`（见 [storage](./storage.md)），默认 `30 * 24 * 60 * 60 * 1000`（30 天）；tick 自己的默认值 `DEFAULT_RECYCLE_BIN_TTL_MS` 同为 30 天，daemon 启动时总是传入配置值。清理失败只记日志，不影响 interval。

---

## 边界与出错

- **无效 cron**：`create`/`update` 时 cron-parser 抛错，HTTP 层转 400；已存进表里的 job 不会再解析 cron，除非 `markRun`——若通过直接修改数据库写入了无效 cron，`markRun` 的重算会抛错，被 tick 的守卫捕获记日志。
- **触发期间 job 被删**：`markRun` 对不存在的 id 是 no-op，运行照常完成，只是无处记录。
- **停机与在途运行**：`stop()` 清除 interval 并 `Promise.allSettled` 等待所有在途 job 运行结束（有界：已结束的 promise 自动从追踪列表移除）。daemon 若异常退出，在途 job 的 `nextRunAt` 未推进，重启后仍是"到期"状态，会重新触发一次。
- **单 daemon 假设**：没有跨进程锁；两个 daemon 同时打开同一个 `jobs.db` 会各自 tick、重复触发。设计前提是单机单 daemon（daemon.json 即为此服务，见 [daemon](../server/daemon.md)）。
- **CLI 功能面较窄**：`kclaw jobs list` 只读列表（`packages/cli/src/index.ts`）；增删改目前走 HTTP。

---

## 关联

- [agent-loop](./agent-loop.md)：job 触发的运行最终进入的循环
- [storage](./storage.md)：`jobs.db` 所在的目录树与 `recycleBinTtlMs` 配置
- [run-manager](../server/run-manager.md)：`enqueue`、job note 块与 `trigger: "job"` 的服务端组装
- [daemon](../server/daemon.md)：tick 的启动参数与停机语义
