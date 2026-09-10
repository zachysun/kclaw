# jobs — 定时任务调度

## 职责

让 kclaw 在指定时刻自动发起会话并执行任务：`JobScheduler`（`packages/core/src/jobs/scheduler.ts`）把"cron 表达式 + 一段 prompt"作为一条 job 记录持久化在 SQLite；daemon 侧的 `startSchedulerTick`（`packages/server/src/scheduler-tick.ts`）周期轮询这张表，将到期的 job 转换为一次真实的 agent 运行，并将结果记录回 job 行。边界：调度器仅负责"何时触发、结果如何"；执行本身交给 RunManager（见 [run-manager](../server/run-manager.md)）；job 的增删改查 HTTP 接口在 `packages/server/src/routes/jobs.ts`。

---

## 设计决策

- **全部状态一张表**：job 的所有字段（含下次触发时间、上次结果）都存在 `<home>/jobs.db` 的 `jobs` 表里，进程内存中不缓存。每个 `JobScheduler` 实例打开同一个文件看到同一批行，daemon 可以使用全新句柄轮询，重启无需恢复步骤。
- **时间存 ISO-8601 字符串**：ISO 字符串的字典序就是时间序，所以"到期与否"可以下推成一条 SQL 字符串比较（`next_run_at <= now`），不需要读出整表在 JS 里比时间。
- **跳过积压**：`claimDue` 在认领时（认领 = 原子地取走到期任务并推进它的下次触发时间，防止重复触发）把 `nextRunAt` 推进到"now 之后的下一次"，而不是"上次触发点加一个周期"。daemon 停机两小时后重启，`*/5` 的任务不会补执行 24 次错过的时间点，而是直接计算 now 之后的下一次；`markRun` 只记录 `last_*` 字段，不再推进时间。
- **`next()` 严格排他**：cron-parser 的 `next()` 对 `currentDate` 是排他的（恰好相等也不算），所以 `nextIsoAfter` 的语义是"严格晚于给定时刻的第一次触发"。无效 cron 表达式原样抛出 cron-parser 自身的错误消息，不做包装。
- **id 即创建序**：id 用 `newId("job")` 生成（ULID，一种按时间有序的唯一 id），`list()` 按 `ORDER BY id` 排序，天然就是创建顺序。
- **job 事件广播不带会话**：`job.started` / `job.completed` / `job.failed` 事件用不带上下文的 `makeEvent` 构造（无 sessionId/runId），EventBus 会把它们广播给每一个连接的客户端——任何界面都能看到调度活动，而不只是订阅了某个会话的客户端。
- **tick 失败不中断轮询**：一次 tick 抛错（`scheduler.claimDue` 失败、单个 job 的记录步骤失败）只记日志并丢弃这一轮，`setInterval` 不中断——轮询循环必须能在自身失败后继续运行。

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
  model?: string      // 可选：该 job 的模型覆盖（空/缺省 = daemon 默认模型）
  enabled: boolean
  nextRunAt: string   // ISO-8601，下一次触发时间
  lastRunAt?: string  // ISO-8601，上次实际触发时间
  lastStatus?: JobStatus
  lastError?: string  // 上次失败的消息；成功时清空
}
```

SQLite 表结构与之一一对应（`enabled` 存 0/1，驼峰字段转下划线列名 `next_run_at` 等）；老库在启动时自动 `ALTER TABLE jobs ADD COLUMN model` 补上新列。

`JobScheduler` 的方法语义：

| 方法 | 语义 |
|------|------|
| `create(input)` | 插入一条 job；`enabled` 默认 true，`nextRunAt` = now 之后的第一次 cron 触发 |
| `list()` | 全部 job，按 id（创建序）排列 |
| `get(id)` | 取一条；不存在返回 undefined |
| `update(id, patch)` | 部分字段更新；见下方"启用/停用" |
| `remove(id)` | 物理删除；返回是否真的删了 |
| `due(now)` | `enabled = 1 且 next_run_at <= now` 的行，按到期先后排列 |
| `claimDue(now)` | 一个事务内认领 `enabled = 1 且 next_run_at <= now` 的行：每行把 `next_run_at` 推进到 now 之后的下一次（跳过积压），CAS 更新恰好命中一行才算认领并返回——重叠 tick 或同库第二个句柄都无法重复认领 |
| `markRun(id, status, now, error?)` | 记录 `lastRunAt/lastStatus/lastError`（status 为 "ok" 时清空 lastError）；不碰 `nextRunAt`——认领时已由 `claimDue` 推进；job 已被删则什么都不做 |

---

## 核心流程

### tick 轮询（`packages/server/src/scheduler-tick.ts`）

`startSchedulerTick` 在 daemon 启动时被调用（`packages/server/src/daemon.ts`），启动后**立即执行一次检查**，随后 `setInterval` 每 `intervalMs` 执行一轮（默认 `DEFAULT_INTERVAL_MS = 30_000`，即 30 秒；daemon 侧默认值 `DEFAULT_SCHEDULER_INTERVAL_MS` 同为 30 秒）。

一轮 tick 完成两件事：

1. **认领并触发到期的 job**：`scheduler.claimDue(now())` 在一个事务内认领到期集合——每行的 `nextRunAt` 当场推进到 now 之后的下一次（CAS 更新，恰好命中一行才算认领成功）——逐个（同一轮内串行）触发不在 `inFlight` 集合里的 job。
2. **回收站清理**：`sessions.purgeExpired(purgeTtlMs)` 物理删除软删除超过保留期的会话（见下）。

单个 job 的触发流程（`fireJob`）：

1. 把 job.id 加入 `inFlight`（进程内第二道防线：`nextRunAt` 已在认领时推进，重叠 tick 不会再认领到它；它只拦一种情况——一次运行尚未结束而下个调度点已到并被新 tick 认领时，该次触发被跳过，丢弃而不是并发再跑）。
2. `sessions.create(job.name, job.id)` 创建一个新会话：标题即 job 名字，`jobId` 记进 `meta.json`。创建后随即做历史封顶：`sessions.listByJob(job.id)` 按新到旧排列，第 `JOB_SESSION_KEEP = 20` 个之后的老会话一律软删除（`sessions.delete`，落入回收站、由回收站保留期清理）——job 每次触发都建新会话，不封顶会让该 job 的会话目录无限增长。
3. 广播 `job.started {jobId}`。
4. `run.enqueue(sessionId, { userText: job.prompt, trigger: "job", note: "本会话由定时任务「<name>」触发", ...(job.model !== undefined && job.model !== "" ? { model: job.model } : {}) })`——RunManager 把 prompt 作为用户消息发起一次运行（job 配置的 `model` 作为本次运行的模型覆盖透传，缺省则走会话/默认解析链），该 note 写入用户消息上紧跟正文的 `kind: "job"` note 块（组装过程见 core `packages/core/src/agent/run-assembly.ts` 的 `executeRun`）。
5. 运行结束：`outcome.stopReason !== "error"` → `markRun(id, "ok", now)` + 广播 `job.completed {jobId, summary: stopReason}`；否则 `markRun(id, "error", ...)` + 广播 `job.failed {jobId, error}`（enqueue 本身抛错也走同一条失败记录路径）。到达终态时若 daemon 配置了 `notify.channels`，会经 notifier 异步推送一条终态通知（含 job 名、摘要与 `?session=` 会话链接；失败仅记日志，不重试、不阻塞 job 记录；channels 为空则完全不推送）。
6. `finally` 里将 job.id 移出 `inFlight`——无论成败都移除该条目。

**审计信息的位置**：没有独立的审计文件；一次触发的全部痕迹 = job 行上的 `lastRunAt/lastStatus/lastError` + 对应会话目录里完整的 `events.jsonl` 事件流（job 会话与普通会话使用同一条持久化路径，消息即 `message` 事件），以及广播的三个 `job.*` 事件。

### 会话命名

job 会话的标题在创建时就定为 `job.name`，而自动命名（`scheduleAutoname`，core `packages/core/src/session/autoname.ts`）只对 `trigger !== "job"` 的运行触发——所以 job 会话的标题永远不会被自动改名覆盖。

### 启用 / 停用 / 删除

HTTP 接口（`packages/server/src/routes/jobs.ts`，均需 Bearer token）：

- `POST /jobs`：`{name, cron, prompt}` 三者必填且非空，可带 `model`（该 job 的模型覆盖）；cron 解析失败返回 400（cron-parser 的原始错误消息）。
- `PATCH /jobs/:id`：只接受 `name` / `prompt` / `cron` / `enabled` / `model` 五个字段，其余忽略；`enabled: false` 即停用——`due()` 只取 `enabled = 1` 的行，停用的 job 不触发但记录保留；`enabled: true` 重新启用。
- `DELETE /jobs/:id`：立即物理删除该行，没有软删除、没有回收站（这是 job 与会话在删除语义上的差别）。

`update` 的一个细节：patch 里带 `cron` 且不带 `nextRunAt` 时，`nextRunAt` 自动从 now 重算（修改周期后按新周期计算）；显式传 `nextRunAt` 则按传入值写入（测试用它回填时间）。

### 回收站 30 天自动清理

tick 的第二步 `sessions.purgeExpired(purgeTtlMs)`：把 `deletedAt` 距今 ≥ 保留期的软删除会话整目录删除。保留期来自 `config.yaml` 的 `sessions.recycleBinTtlMs`（见 [storage](./storage.md)），默认 `30 * 24 * 60 * 60 * 1000`（30 天）；tick 自己的默认值 `DEFAULT_RECYCLE_BIN_TTL_MS` 同为 30 天，daemon 启动时总是传入配置值。清理失败只记日志，不影响 interval。

---

## 边界与出错

- **无效 cron**：`create`/`update` 时 cron-parser 抛错，HTTP 层转 400；已存进表里的 job 不会再解析 cron，除非 `claimDue`——若通过直接修改数据库写入了无效 cron，`claimDue` 的重算会抛错，被 tick 的守卫捕获记日志。
- **触发期间 job 被删**：`markRun` 对不存在的 id 是 no-op，运行照常完成，只是无处记录。
- **停机与在途运行**：`stop()` 清除 interval 并 `Promise.allSettled` 等待所有在途 job 运行结束（有界：已结束的 promise 自动从追踪列表移除）。daemon 若在运行途中崩溃，该次触发认领时已推进 `nextRunAt`，被杀死的这一次不会重放，job 在下个调度点照常触发。
- **单 daemon 假设**：`claimDue` 的 CAS 认领让两个句柄同时 tick 也无法重复认领同一次触发，但调度层之外并无互斥；设计前提是单机单 daemon（daemon.json 的 wx 独占认领即为此服务，见 [daemon](../server/daemon.md)）。
- **CLI 功能面较窄**：`kclaw jobs list` 只读列表（`packages/cli/src/index.ts`）；增删改目前走 HTTP。

---

## 关联

- [agent-loop](./agent-loop.md)：job 触发的运行最终进入的循环
- [storage](./storage.md)：`jobs.db` 所在的目录树与 `recycleBinTtlMs` 配置
- [run-manager](../server/run-manager.md)：`enqueue`、job note 块与 `trigger: "job"` 的服务端组装
- [daemon](../server/daemon.md)：tick 的启动参数与停机语义
