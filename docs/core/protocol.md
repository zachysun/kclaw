# protocol — 消息 / 内容块 / 事件 / 指令帧协议

## 职责

`packages/core/src/protocol/` 定义贯穿全系统的数据模型，六个文件按粒度分层：`messages.ts`（持久化单位；持久化 = 写入磁盘长期保存）、`blocks.ts`（消息内结构化片段）、`events.ts`（瞬时广播）、`wire.ts`（WS 指令帧与应答帧）、`session-events.ts`（会话事件流的持久化事件类型）、`ids.ts`（ID 体系）。三层按生命周期划分：

```
Event（瞬时，不持久化）──记录为──▶ Message（持久化单位）──内含──▶ Block（结构化片段）
```

server 与 CLI/WebUI 之间传输的就是这些类型：JSONL（每行一条 JSON 的文本文件）里每行一条 `Message`，WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）事件流里每帧一个 `AgentEvent`，daemon 不翻译、不改写。

**权威类型与出口**：这六份文件是全部线上数据形状的唯一类型出处。除 core 主入口外，它们经 `package.json` 的子路径出口 `@kclaw/core/protocol` 对外发布——纯类型与纯函数、不含任何 Node API，浏览器构建（WebUI）直接 `import type` 引用而不会把 Node 绑定的主入口打进包里（`@kclaw/core/commands` 是同一先例）。三端约定：不手抄镜像，一律引用这份权威定义；web/cli 的事件消费 switch 以 `default: const unhandled: never = event` 哨兵收尾，core 新增事件类型而消费端未表态时编译失败。

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
  latencyMs?: number    // LLM 生成耗时（毫秒，流结束时刻测量）；仅流成功完成时存在，历史消息可能缺省
}

export type GrantedBy = "safe" | "whitelist" | "session_grant" | "confirmed" | "accept_edits" | "learned" | "sandboxed" | "trusted"

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

export type NoteKind = "system" | "job" | "memory" | "timeout" | "denied"
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

note 是"系统写入对话的信息"（记忆注入、job 触发、迭代截断、权限拒绝/超时），属于对话内容、模型可读。类型守卫 `isBlockType(t, v)` 与 `newBlockId()` 也在此文件。

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

`EventType` 共 **39 种**，十一个分组：

| 分组 | 事件 | 数量 |
|------|------|------|
| 生命周期 | `run.started` `run.completed` `run.failed` `message.created` `message.completed` `job.started` `job.completed` `job.failed` `session.appended` | 9 |
| 会话元数据 | `session.renamed` | 1 |
| 流式 | `text.created/delta/completed` `thinking.created/delta/completed` `tool_call.created/delta/completed` `tool_result.created/delta/completed` `attachment.created` `attachment.completed` | 14 |
| 模型调用 | `llm.started` `llm.completed` `llm.failed` | 3 |
| 人工确认 | `confirmation.requested` `confirmation.resolved` | 2 |
| 运行中提问 | `question.requested` `question.resolved` | 2 |
| note 单发 | `note.emitted` | 1 |
| 消息排队与引导 | `message.queued` `message.steered` `message.queue_cancelled` | 3 |
| 上下文压缩 | `compaction.started` `compaction.completed` | 2 |
| 记忆写入 | `memory.written` | 1 |
| 扩展 | `hook.failed` | 1 |

关键 payload：

```ts
export interface RunStartedPayload   { trigger: "user" | "job" | "agent" }
export interface RunCompletedPayload { stopReason: StopReason; usage: Usage }
export interface RunFailedPayload    { error: { code: string; message: string } }
export interface JobCompletedPayload { jobId: string; summary: string }
export interface SessionRenamedPayload { title: string }
/** 持久化通知：一条会话事件已写入 events.jsonl（store 写入成功后发出，先写入后广播）。 */
export interface SessionAppendedPayload { eventType: SessionEvent["type"] }

export interface BlockPayload         { messageId: string; block: Block }
export interface BlockDeltaPayload    { messageId: string; blockId: string; delta: string }
export interface ToolResultDeltaPayload { messageId: string; callId: string; delta: string }

export interface LlmStartedPayload   { model: string; attempt: number }
export interface LlmCompletedPayload { usage: Usage; stopReason: StopReason; latencyMs: number }
export interface LlmFailedPayload    { error: { code: string; message: string }; willRetry: boolean }
// phase: 压缩发生在哪个时机——收尾（post-run）/ 运行中（in-run）/ 手动（manual）
export type CompactionPhase = "in-run" | "post-run" | "manual"
export interface CompactionStartedPayload { phase: CompactionPhase }
// result 必达：started 一旦发出，completed 必然随之而来（ok/failed/cancelled）；
// 非 ok 时 segments/kept 为 0。预算未过线、压缩没开始则两个事件都不发。
export interface CompactionCompletedPayload {
  segments: number; kept: number; phase: CompactionPhase; result: "ok" | "failed" | "cancelled"
}

export interface ConfirmationRequestedPayload {
  confirmationId: string
  toolCall: ToolCallBlock
  risk: "safe" | "sensitive"
  expiresAt: string
  noteText?: string            // 给人工看的原因（如 exec 沙箱不可用），见 permissions.md 第 7 节
}
export interface ConfirmationResolvedPayload {
  confirmationId: string
  // 人工四选裁决（once 仅本次 / project 总是·项目 / global 总是·全局 / reject 拒绝），
  // timeout 是无人裁决时等到超时的结果——循环侧产生，不经确认网关。
  decision: "once" | "project" | "global" | "reject" | "timeout"
  by: "cli" | "web" | "timeout"
}

// 运行中提问（ask_user_questions 工具，issue #21）：与确认共用同一个网关对象
// （一个 broker 对象、两类等待中的条目）。question.requested 发出后等待三方——
// 人工回答 / 超时 / run 中止，谁先到算谁；中止不是回答（不发 resolved，与确认流同规则）。
export interface QuestionSpec {
  text: string                      // 问题本身，自包含、可独立回答
  options?: string[]                // 有则从选项里选（单选；multiSelect 时多选），无则自由文本
  multiSelect?: boolean             // 仅对有 options 的题有意义：允许多选
}
export interface QuestionRequestedPayload {
  questionId: string
  questions: QuestionSpec[]         // 1–5 个问题
  expiresAt: string
  noteText?: string                 // 给人工看的标签（如"来自子代理 X"的转发卡）
}
export interface QuestionResolvedPayload {
  questionId: string
  answers?: string[][]              // 按提问顺序每题一个数组；无人回答（超时）时缺省
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

// 记忆写入管线每次实际写入文件时发出：episode 带 topic（线名）、cognition 带 scope；
// 事件不带 sessionId（项目级事务），只作「已写入」的轻提示，订阅端不驱动状态机。
export interface MemoryWrittenPayload {
  path: string
  kind: "episode" | "cognition"
  topic?: string
  scope?: string
}

// 钩子失败：失败时的行为自行声明（skip 跳过 / deny 否决闸门），run 不因钩子失败而崩，但失败必须可见。
// phase:"load" 是装载期失败（无 sessionId/runId）；"run" 是执行期失败（带所在 run 的上下文）。
export interface HookFailedPayload {
  hook: string
  position: string
  error: string
  phase: "load" | "run"
}
```

发射方分布：

| 事件 | 发射方 |
|------|--------|
| run / message / 流式 / llm / confirmation / note / `message.steered` | core 的 agent 循环（`agent/loop.ts`；`message.steered` 在 steering 注入时逐条发出，事件级 `runId` 标识注入的 run） |
| `question.requested` `question.resolved` | `ask_user_questions` 工具的执行器（`tools/ask.ts`，经 run 装配注入的 emit 钩子带 run 上下文发到总线；执行器在循环的工具回合内运行） |
| `message.queued` `message.queue_cancelled` | server 的 `RunManager`（`run.ts`：submit / recoverQueues / queueCancel） |
| `compaction.started` `compaction.completed` | core 压缩引擎 `Compactor`（`packages/core/src/session/compactor.ts` 的 `compact` / `auto`，覆盖收尾 post-run / 运行中 in-run / 手动 manual 三路） |
| `memory.written` | core 的 `MemoryPipeline`（`memory/pipeline.ts`，每次写入经装配的 emit 钩子广播；daemon 侧接钩子的点在 `server/daemon.ts`） |
| `hook.failed` | core 钩子系统（`hooks/runner.ts` 的 skip 失败报告 + `hooks/registry.ts` 的装载失败去重报告；两处都经 run 装配/daemon 的总线扇出） |
| `job.*` | server 的 `scheduler-tick.ts` |
| `session.renamed` | server 的自动命名（`autoname.ts`：新标题写回 meta 后发出） |
| `session.appended` | core 的 `SessionStore`（`session/store.ts`：每个事件与其投影成功写入后经构造时注入的回调发出；daemon 装配时接 `EventBus`——先写入后广播，web 审计页据此增量拉取） |
| `attachment.*` | 目前**已定义无发射方**——附件以 attachment 块随用户消息整体持久化与广播（`message.completed` 携带全量消息），不需要单独的块级事件流 |

---

## 指令帧与会话事件（`wire.ts` / `session-events.ts`）

`wire.ts` 定义 WS 的客户端→daemon 指令帧（`ClientCommand` 联合：auth / subscribe / unsubscribe / confirmation.resolve / question.resolve / send_message / message.retry / queue.cancel / run.cancel / compaction.cancel）与 daemon→客户端的应答帧（各指令的 ack、`ErrorFrame`），合并为 `ServerFrame`；附件引用 `AttachmentRef{path,name,size,mimeType}` 与排队条目 `QueueEntry` 也在此（`session/store.ts` re-export 保持旧引用路径）。字段规则与报错文案不在类型里——它们的唯一实现是 server 的 `command-check.ts`（见 [realtime](../server/realtime.md)）。

`session-events.ts` 定义会话事件流（`events.jsonl`，`GET /sessions/:id/events` 的返回形状）的十四种事件类型：会话元数据五种（created/renamed/deleted/restored/set）+ `message` / `message.truncated` / `compaction` / `memory` / `system` / `sandbox.checked` + 运行档案三种（`run.started` / `run.ended` / `permission.decided`）。`message.truncated` 是编辑重试/重新生成的截断标记：携带 `fromMessageId`（被重做的最后一条用户消息），从它起的所有消息退出对话视图——事件流只追加这条标记、不改写任何历史行，可见性是读取端投影（`readMessages` 过滤，客户端经同名广播收敛）。截断可以叠加：重试消息的起始 id 单调递增，先于消息出现的标记决定它是否可见。`session.created` 携带创建时固化的初始权限模式 `mode`（可选，旧流缺省 default）与可选 `parentSessionId`（子代理会话的父会话标识——引擎侧一切子代理特化从它派生，见 [subagents](./subagents.md)）；`session.set` 携带元数据的增量补丁（`model` / `mode`（会话权限模式）/ `disposition`，键出现在补丁里才发）；旧会话流里的 `readonly` 布尔字段是 legacy，读取时映射为 `mode`。`sandbox.checked` 是每 run 一条的沙箱状态审计（`{enabled, available, unavailableReason?}`），与 `system` 一样只写事件流、不进 bus 的 `EventType`——它们对外部的可见性由 `session.appended` 通知帧间接承载（订阅端收到后拉 `/events` 即见）。`run.started` / `run.ended` 每 run 成对出现，把该 run 的消息事件夹成一轮边界——失败 run 也落 `run.ended`（`stopReason:"error"` 带错误），起点的 run 必有终点留痕；`permission.decided` 记录每次落定的人工确认裁决（裁决、裁决者、工具身份），运行中被中止的确认不落（中止不是裁决）。`system` 事件是每 run 一条的双段系统提示词留痕：`stable`（人设基座 + 注入约定）与可选 `live`（认知 + 技能清单），legacy 单文本事件只带 `text`（读作 stable）。assistant 消息可携带可选 `latencyMs`（LLM 生成耗时毫秒，流成功完成时随 `usage` 一并持久化；旧消息与失败流缺省）。只放类型；运行时守卫（`isMessageEvent` 等）与 meta 投影（`applyEvent`）在 `session/events.ts`。

---

## ID 体系（`ids.ts`）

```ts
import { monotonicFactory } from "ulidx"
const ulid = monotonicFactory()

export type IdPrefix = "msg" | "ses" | "blk" | "call" | "evt" | "run" | "conf" | "mem" | "job" | "att" | "q"

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`     // 例: run_01J…，前缀 + 单调 ULID（按时间递增、可排序的唯一 ID）
}
```

11 个前缀的生成点：

| 前缀 | 生成点 |
|------|--------|
| `msg` | `messages.ts` 的 newMessage；另在 `server/run.ts` submit 入队时为消息条目预分配 messageId（`input.messageId ?? newId("msg")`） |
| `ses` | `session/store.ts` 的 create |
| `blk` | `blocks.ts` 的 newBlockId |
| `evt` | `events.ts` 的 makeEvent |
| `run` | `agent/loop.ts` 的 runAgent |
| `conf` | `permissions/engine.ts` 的确认 id 工厂 |
| `mem` | 已声明、当前无生成点（旧版 note id 前缀，现版线/认知文件不用前缀 id，见下） |
| `job` | `jobs/scheduler.ts` |
| `att` | server 的上传路由（`routes/attachments.ts`，写入磁盘的文件名 `<att_…>__<原名>`） |
| `q` | `tools/ask.ts` 的 ask_user_questions（每次提问的 questionId） |

`call` 前缀已声明但当前无生成点——`callId` 由 provider 原样传入（OpenAI 的 tool_call id，缺失时 provider 合成 `call_idx_<index>`，见 `provider/openai-compat.ts`）。`mem` 前缀同 `call`：现在的代码里 `newId("mem")` 全仓无调用处（线/认知文件按 `topic`/`kind-name` 命名，不生成 mem_* id），保留声明仅为兼容阅读旧版的 note id（`mem_<ULID>`）。单调 ULID 保证同进程内 ID 按时间排序，日志/JSONL 天然有序。

---

## 持久化规则

- **实时增量事件不持久化、不回放**。WS 上推送的事件（text.delta、message.created 等）只描述"正在发生"的增量，不写入磁盘、不重发；会话的权威历史是 events.jsonl 事件流（见下"持久化格式"）。断线恢复 = HTTP `GET /sessions/:id/messages` 拉全量消息 + 只订阅新事件（WS `subscribe`）。单 WS 连接天然有序，事件不带序号——有意的简化。
- **持久化的块永远是完整的**："写到一半的块"只存在于事件流中；`onMessage` 收到的消息是终稿快照。因此 JSONL 每行读取后自洽，无需校验。
- **持久化格式**：会话目录是事件流结构（见 [storage](./storage.md)）——`sessions/<id>/events.jsonl` 是唯一真相，一行一条 `JSON.stringify(event)`（消息即 `{type:"message"}` 事件，携带完整 Message）；`meta.json` 是投影快照（标题/时间戳等当前值，可由事件流重建）；`queue.jsonl` 存运行态排队。崩溃容忍：读到尾部残缺行（只写了一半的行）时丢弃、写前字节级修复（`storage/jsonl.ts` 的 `readJsonl` / `repairTornTail`）。
- **先持久化后广播**：`message.completed` 永远跟在 `onMessage` 之后，事件流反映的是已持久化状态。

---

## 边界与出错

- 实时事件无 ack、无重发：客户端错过的增量事件不补发，靠「HTTP 拉全量 + 只订阅新事件」补齐，而不是回放（回放语义由 events.jsonl 的唯一真相承载，`GET /sessions/:id/events` 可按会话回查整条事件流）。
- `message.created` 之后消息可能永远不 `completed`（空 assistant 被丢弃、宿主钩子抛错）——客户端不能假设 created 必有 completed 配对。
- `AgentEvent.sessionId` 缺失即广播语义（`EventBus.emit` 发给全部已连接 socket），客户端不应把它当异常。
- `attachment` 的 `file` source 指向 `<home>/attachments/<session-id>/`：客户端先把文件传到该目录（HTTP `POST /sessions/:id/attachments`），发起消息时引用路径、由服务端挂载为块（见 [run-manager](../server/run-manager.md)）；大文件不进 JSONL，JSONL 里只有指向磁盘的元数据。

---

## 关联

- [agent-loop](./agent-loop.md)：谁在什么时机发这些事件
- [storage](./storage.md)：JSONL 崩溃容忍与路径布局
- [realtime](../server/realtime.md)：EventBus 的订阅与广播实现
- [architecture](../architecture.md)：三层协议在全局数据流中的位置
