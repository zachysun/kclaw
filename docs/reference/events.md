# events — 总线事件清单（40 种）

> 真相源：`packages/core/src/protocol/events.ts`（payload 接口同文件）。投递与订阅机制见 [realtime](../server/realtime.md)，设计取舍见 [protocol](../core/protocol.md)。

这些事件经 `EventBus`（`core/src/bus.ts`）在 WS 上广播：带 `sessionId` 的发给订阅该会话的连接，不带 `sessionId` 的是广播（发给全部已连接 socket）。实时事件不持久化、不回放；持久化的是 [会话事件](./session-events.md)。

## 核心源码

```ts
export type EventType =
  // 生命周期
  | "run.started" | "run.completed" | "run.failed"
  | "message.created" | "message.completed"
  | "message.truncated"
  | "job.started" | "job.completed" | "job.failed"
  | "session.appended"
  // 会话元数据
  | "session.renamed"
  // 流式
  | "text.created" | "text.delta" | "text.completed"
  | "thinking.created" | "thinking.delta" | "thinking.completed"
  | "tool_call.created" | "tool_call.delta" | "tool_call.completed"
  | "tool_result.created" | "tool_result.delta" | "tool_result.completed"
  | "attachment.created" | "attachment.completed"
  // 模型调用
  | "llm.started" | "llm.completed" | "llm.failed"
  // 人工介入
  | "confirmation.requested" | "confirmation.resolved"
  | "question.requested" | "question.resolved"
  // note 单发
  | "note.emitted"
  // 记忆写入
  | "memory.written"
  // 消息排队与引导
  | "message.queued" | "message.steered" | "message.queue_cancelled"
  // 上下文压缩
  | "compaction.started" | "compaction.completed"
  // 扩展
  | "hook.failed"

export type AgentEvent<T extends EventType = EventType> = {
  id: string
  ts: string               // ISO-8601
  type: T
  sessionId?: string       // 缺失 == 广播
  runId?: string
  payload: EventPayloadMap[T]
}

/** 分布式判别联合：三端客户端 switch (e.type) 时用它逐案收窄 payload。 */
export type AnyAgentEvent = { [T in EventType]: AgentEvent<T> }[EventType]
```

## 分组与数量

| 分组 | 事件 | 数量 |
|------|------|------|
| 生命周期 | run.started / run.completed / run.failed；message.created / message.completed / message.truncated；job.started / job.completed / job.failed；session.appended | 10 |
| 会话元数据 | session.renamed | 1 |
| 流式 | text、thinking、tool_call 各 created/delta/completed；tool_result 的 created/delta/completed；attachment.created / attachment.completed | 14 |
| 模型调用 | llm.started / llm.completed / llm.failed | 3 |
| 人工介入 | confirmation.requested / resolved；question.requested / resolved | 4 |
| note 单发 | note.emitted | 1 |
| 消息排队与引导 | message.queued / message.steered / message.queue_cancelled | 3 |
| 上下文压缩 | compaction.started / compaction.completed | 2 |
| 记忆写入 | memory.written | 1 |
| 扩展 | hook.failed | 1 |

## 逐事件 payload

| 事件 | payload 字段 |
|------|--------------|
| `run.started` | `trigger`（user/job/agent/team） |
| `run.completed` | `stopReason`、`usage`（全程累计） |
| `run.failed` | `error { code, message }` |
| `message.created` | `message`（Message 全量） |
| `message.completed` | `message`（终稿快照，持久化之后才发） |
| `message.truncated` | `fromMessageId`（编辑重试/重新生成的截断广播） |
| `job.started` | `jobId` |
| `job.completed` | `jobId`、`summary` |
| `job.failed` | `jobId`、`error { code, message }` |
| `session.appended` | `eventType`（刚写入 events.jsonl 的会话事件类型；先写入后广播） |
| `session.renamed` | `title` |
| `text.created` / `text.completed` | `messageId`、`block`（BlockPayload） |
| `text.delta` | `messageId`、`blockId`、`delta` |
| `thinking.created` / `thinking.completed` | BlockPayload 同上 |
| `thinking.delta` | 同 delta 形状 |
| `tool_call.created` / `tool_call.completed` | BlockPayload |
| `tool_call.delta` | `messageId`、`blockId`、`delta`（args 的 JSON 片段） |
| `tool_result.created` / `tool_result.completed` | BlockPayload |
| `tool_result.delta` | `messageId`、`callId`、`delta`（按 callId 而非 blockId） |
| `attachment.created` / `attachment.completed` | BlockPayload（当前已定义无发射方，附件随 message.completed 整体携带） |
| `llm.started` | `model`、`attempt` |
| `llm.completed` | `usage`、`stopReason`、`latencyMs` |
| `llm.failed` | `error { code, message }`、`willRetry` |
| `confirmation.requested` | `confirmationId`、`toolCall`、`risk`（safe/sensitive）、`expiresAt`、`noteText?`（给人工看的原因） |
| `confirmation.resolved` | `confirmationId`、`decision`（once/project/global/reject/timeout）、`by`（cli/web/feishu/timeout） |
| `question.requested` | `questionId`、`questions`（QuestionSpec 数组，1–5 个）、`expiresAt`、`noteText?` |
| `question.resolved` | `questionId`、`answers?`（string[][]，超时缺省）、`by` |
| `note.emitted` | `messageId`、`block`（NoteBlock） |
| `memory.written` | `path`、`kind`（episode/cognition）、`topic?`、`scope?`（不带 sessionId，项目级广播） |
| `message.queued` | `messageId`、`disposition`（steer/wait/interrupt）、`position?`（wait/interrupt 的队列序位） |
| `message.steered` | `messageId`（事件级 runId 标识注入的 run） |
| `message.queue_cancelled` | `messageId?`、`all?` |
| `compaction.started` | `phase`（in-run/post-run/manual） |
| `compaction.completed` | `segments`、`kept`、`phase`、`result`（ok/failed/cancelled；非 ok 时前两值为 0） |
| `hook.failed` | `hook`、`position`、`error`、`phase`（load/run） |

QuestionSpec：`{ text, options?, multiSelect? }` —— options 存在时从选项里选，缺省自由文本。

## 发射方

| 事件 | 发射方 |
|------|--------|
| run / message / 流式 / llm / confirmation / note / message.steered | core 的 agent 循环（`agent/loop.ts`） |
| question.requested / question.resolved | `ask_user_questions` 工具执行器（`tools/ask.ts`，经装配的 emit 钩子） |
| message.queued / message.queue_cancelled | server 的 RunManager（`server/src/run.ts`） |
| compaction.started / compaction.completed | core 压缩引擎 `Compactor`（`session/compactor.ts`） |
| memory.written | core 的 MemoryPipeline（`memory/pipeline.ts`，经装配的 emit 钩子） |
| hook.failed | core 钩子系统（`hooks/runner.ts` 执行失败 + `hooks/registry.ts` 装载失败） |
| job.* | server 的 `scheduler-tick.ts` |
| session.renamed | 内置钩子 `autoname`（经 `session/autoname.ts`） |
| session.appended | core 的 SessionStore（`session/store.ts`，每个事件写入成功后） |
| attachment.* | 已定义、当前无发射方 |
