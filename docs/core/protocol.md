# protocol — 消息 / 内容块 / 事件三层协议

## 职责

`packages/core/src/protocol/` 定义贯穿全系统的数据模型，四个文件按粒度分层：`messages.ts`（持久化单位；持久化 = 写入磁盘长期保存）、`blocks.ts`（消息内结构化片段）、`events.ts`（瞬时广播）、`ids.ts`（ID 体系）。三层按生命周期划分：

```
Event（瞬时，不持久化）──沉淀为──▶ Message（持久化单位）──内含──▶ Block（结构化片段）
```

server 与 CLI/WebUI 之间传输的就是这些类型：JSONL（每行一条 JSON 的文本文件）里每行一条 `Message`，WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）事件流里每帧一个 `AgentEvent`，daemon 不翻译、不改写。

---

## 设计决策

- **事件名 = 块名 + 生命周期后缀**：客户端通过事件前缀即可识别需要处理的块类型；简单客户端可只监听 `*.completed` 做非流式渲染。
- **delta 统一为纯字符串增量**：文本增量与 tool args 的 JSON 片段本质相同，拼接逻辑一套。
- **`llm.*` 事件暴露每次真实模型调用**（attempt/usage/latency）——个人 agent 控成本与调试的基础。
- **`role:"tool"` 独立消息**而非塞回 user：JSONL 逐行读出即完整对话史，发给 provider 只需一层薄转换（`toProviderMessages`）。
- **工具调用跨消息用 `callId` 配对**（OpenAI 风格）；`ToolCallBlock` 同时保留 `args`（解析后，给执行器）与 `argsJson`（原始串，给审计与 provider 回放）。

---

## Message（`messages.ts`）

```ts
export type Role = "user" | "assistant" | "tool"

export type StopReason =
  | "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
  | "content_filter" | "aborted" | "error"

export interface Usage { inputTokens: number; outputTokens: number }

export interface Message {
  id: string
  sessionId: string
  role: Role
  blocks: Block[]
  createdAt: string        // ISO-8601
}

export interface AssistantMessage extends Message {
  role: "assistant"
  model: string
  usage: Usage
  stopReason: StopReason
}

export type GrantedBy = "safe" | "whitelist" | "session_grant" | "confirmed"

export interface ToolMessage extends Message {
  role: "tool"
  grantedBy?: Record<string, GrantedBy>   // callId → 放行原因
}
```

构造函数：`newMessage(sessionId, role, blocks)`、`newToolMessage(sessionId, blocks, grantedBy?)`、`newAssistantMessage(sessionId, model, blocks, usage?, stopReason?)`。

role 与块的事实约定（由 agent 循环维护，非类型强制）：

| role | 块类型 |
|------|--------|
| user | text / note / attachment |
| assistant | thinking / text / tool_call |
| tool | tool_result / note |

---

## Block（`blocks.ts`）

六种类型：

```ts
export interface TextBlock     { id: BlockId; type: "text"; text: string }
export interface ThinkingBlock { id: BlockId; type: "thinking"; text: string }

export interface ToolCallBlock {
  id: BlockId; type: "tool_call"
  callId: string          // provider 侧的工具调用 id（配对键）
  name: string
  args: unknown           // 流结束后 JSON.parse 的结果
  argsJson: string        // 原始参数串
}

export interface ToolResultBlock {
  id: BlockId; type: "tool_result"
  callId: string
  status: ToolStatus      // "ok" | "error"
  output: string          // 给模型看
  data?: unknown          // 可选结构化产物，给客户端渲染
  durationMs: number
}

export type NoteKind = "system" | "job" | "memory" | "timeout" | "denied" | "compact"
export interface NoteBlock { id: BlockId; type: "note"; kind: NoteKind; text: string }

export type AttachmentSource =
  | { type: "base64"; data: string }
  | { type: "url"; url: string }
  | { type: "file"; path: string }
export interface AttachmentBlock {
  id: BlockId; type: "attachment"; mimeType: string
  name?: string           // 原始文件名，给展示层做标签
  text?: string           // 文本类附件的内联正文（挂载时截断封顶）
  source: AttachmentSource
}
```

note 是"系统写入对话的信息"（记忆注入、job 触发、压缩摘要、权限拒绝/超时），属于对话内容、模型可读。类型守卫 `isBlockType(t, v)` 与 `newBlockId()` 也在此文件。

---

## Event（`events.ts`）

信封（事件的公共外层字段）与构造：

```ts
export type AgentEvent<T extends EventType = EventType> = {
  id: string
  ts: string               // ISO-8601
  type: T
  sessionId?: string       // 缺失 == 广播（job.*）
  runId?: string
  payload: EventPayloadMap[T]
}

export function makeEvent<T extends EventType>(
  type: T, payload: EventPayloadMap[T],
  ctx: { sessionId?: string; runId?: string } = {},
): AgentEvent<T>
```

`EventType` 共 **34 种**，八个分组：

| 分组 | 事件 | 数量 |
|------|------|------|
| 生命周期 | `run.started` `run.completed` `run.failed` `message.created` `message.completed` `job.started` `job.completed` `job.failed` | 8 |
| 会话元数据 | `session.renamed` | 1 |
| 流式 | `text.created/delta/completed` `thinking.created/delta/completed` `tool_call.created/delta/completed` `tool_result.created/delta/completed` `attachment.created` `attachment.completed` | 14 |
| 模型调用 | `llm.started` `llm.completed` `llm.failed` | 3 |
| 人工确认 | `confirmation.requested` `confirmation.resolved` | 2 |
| note 单发 | `note.emitted` | 1 |
| 消息排队与引导 | `message.queued` `message.steered` `message.queue_cancelled` | 3 |
| 上下文压缩 | `compaction.started` `compaction.completed` | 2 |

关键 payload：

```ts
export interface RunStartedPayload   { trigger: "user" | "job" }
export interface RunCompletedPayload { stopReason: StopReason; usage: Usage }
export interface RunFailedPayload    { error: { code: string; message: string } }
export interface JobCompletedPayload { jobId: string; summary: string }
export interface SessionRenamedPayload { title: string }

export interface BlockPayload         { messageId: string; block: Block }
export interface BlockDeltaPayload    { messageId: string; blockId: string; delta: string }
export interface ToolResultDeltaPayload { messageId: string; callId: string; delta: string }

export interface LlmStartedPayload   { model: string; attempt: number }
export interface LlmCompletedPayload { usage: Usage; stopReason: StopReason; latencyMs: number }
export interface LlmFailedPayload    { error: { code: string; message: string }; willRetry: boolean }
export interface CompactionCompletedPayload { segments: number; kept: number }

export interface ConfirmationRequestedPayload {
  confirmationId: string
  toolCall: ToolCallBlock
  risk: "safe" | "sensitive"
  expiresAt: string
}
export interface ConfirmationResolvedPayload {
  confirmationId: string
  approved: boolean
  by: "cli" | "web" | "timeout"
}

export interface NoteEmittedPayload { messageId: string; block: NoteBlock }

export interface MessageQueuedPayload {
  messageId: string
  disposition: "steer" | "wait" | "interrupt"   // 按实际生效处置报告：空闲会话上发 steer 降级入队后报 wait
  position?: number                            // wait/interrupt 在队列中的序位（0 起）；steer 在缓冲区、不带
}
export interface MessageSteeredPayload { messageId: string }
export interface MessageQueueCancelledPayload { messageId?: string; all?: boolean }
```

发射方分布：

| 事件 | 发射方 |
|------|--------|
| run / message / 流式 / llm / confirmation / note / `message.steered` | core 的 agent 循环（`agent/loop.ts`；`message.steered` 在 steering 注入时逐条发出，事件级 `runId` 标识注入的 run） |
| `message.queued` `message.queue_cancelled` | server 的 `RunManager`（`run.ts`：submit / recoverQueues / queueCancel） |
| `job.*` | server 的 `scheduler-tick.ts` |
| `session.renamed` | server 的自动命名（`autoname.ts`：新标题写回 meta 后发出） |
| `attachment.*` | 目前**已定义无发射方**——附件以 attachment 块随用户消息整体持久化与广播（`message.completed` 携带全量消息），不需要单独的块级事件流 |

---

## ID 体系（`ids.ts`）

```ts
import { monotonicFactory } from "ulidx"
const ulid = monotonicFactory()

export type IdPrefix = "msg" | "ses" | "blk" | "call" | "evt" | "run" | "conf" | "mem" | "job" | "att"

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`     // 例: run_01J…，前缀 + 单调 ULID（按时间递增、可排序的唯一 ID）
}
```

10 个前缀的生成点：

| 前缀 | 生成点 |
|------|--------|
| `msg` | `messages.ts` 的 newMessage |
| `ses` | `session/store.ts` 的 create |
| `blk` | `blocks.ts` 的 newBlockId |
| `evt` | `events.ts` 的 makeEvent |
| `run` | `agent/loop.ts` 的 runAgent |
| `conf` | `permissions/engine.ts` 的确认 id 工厂 |
| `mem` | `memory/store.ts` |
| `job` | `jobs/scheduler.ts` |
| `att` | server 的上传路由（`routes/attachments.ts`，落盘文件名 `<att_…>__<原名>`） |

`call` 前缀已声明但当前无生成点——`callId` 由 provider 原样传入（OpenAI 的 tool_call id，缺失时 provider 合成 `call_idx_<index>`，见 `provider/openai-compat.ts`）。单调 ULID 保证同进程内 ID 按时间排序，日志/JSONL 天然有序。

---

## 持久化规则

- **事件不持久化、不回放**。断线恢复 = HTTP `GET /sessions/:id/messages` 拉全量消息 + 只订阅新事件（WS `subscribe`）。单 WS 连接天然有序，事件不带序号——有意的简化。
- **持久化的块永远是完整的**："写到一半的块"只存在于事件流中；`onMessage` 收到的消息是终稿快照。因此 JSONL 每行读取后自洽，无需校验。
- **持久化格式**：`sessions/<id>/messages.jsonl`，一行一条 `JSON.stringify(message)`；meta（标题/时间戳）在单独的 `meta.json` 里。崩溃容忍：读到尾部残缺行（只写了一半的行）时丢弃、写前字节级修复（`storage/jsonl.ts` 的 `readJsonl` / `repairTornTail`）。
- **先持久化后广播**：`message.completed` 永远跟在 `onMessage` 之后，事件流反映的是已持久化状态。

---

## 边界与出错

- 事件无 ack、无重发：客户端错过的事件不补发，通过"拉全量 + 订阅新事件"对账，而非回放。
- `message.created` 之后消息可能永远不 `completed`（空 assistant 被丢弃、宿主钩子抛错）——客户端不能假设 created 必有 completed 配对。
- `AgentEvent.sessionId` 缺失即广播语义（`EventBus.emit` 发给全部已连接 socket），客户端不应把它当异常。
- `attachment` 的 `file` source 指向 `<home>/attachments/<session-id>/`：客户端先把文件传到该目录（HTTP `POST /sessions/:id/attachments`），发起消息时引用路径、由服务端挂载为块（见 [run-manager](../server/run-manager.md)）；大文件不进 JSONL，JSONL 里只有指向磁盘的元数据。

---

## 关联

- [agent-loop](./agent-loop.md)：谁在什么时机发这些事件
- [storage](./storage.md)：JSONL 崩溃容忍与路径布局
- [realtime](../server/realtime.md)：EventBus 的订阅与广播实现
- [architecture](../architecture.md)：三层协议在全局数据流中的位置
