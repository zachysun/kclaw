import { newId } from "./ids.js"
import type { Block, NoteBlock, ToolCallBlock } from "./blocks.js"
import type { Message, StopReason, Usage } from "./messages.js"

export type EventType =
  // 生命周期
  | "run.started" | "run.completed" | "run.failed"
  | "message.created" | "message.completed"
  | "job.started" | "job.completed" | "job.failed"
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
  // note 单发
  | "note.emitted"
  // 记忆写入（项目级事务，广播，不带 sessionId）
  | "memory.written"
  // 消息排队与引导
  | "message.queued" | "message.steered" | "message.queue_cancelled"
  // 上下文压缩（运行前的预压缩过程，早于 run.started）
  | "compaction.started" | "compaction.completed"
  // 扩展（hook 系统）：用户 hook 装载/执行失败，fail-open 不影响 run
  | "hook.failed"

export interface RunStartedPayload { trigger: "user" | "job" }
export interface RunCompletedPayload { stopReason: StopReason; usage: Usage }
export interface RunFailedPayload { error: { code: string; message: string } }
export interface MessageCreatedPayload { message: Message }
export interface MessageCompletedPayload { message: Message }
export interface JobStartedPayload { jobId: string }
export interface JobCompletedPayload { jobId: string; summary: string }
export interface JobFailedPayload { jobId: string; error: { code: string; message: string } }
export interface SessionRenamedPayload { title: string }

export interface BlockPayload { messageId: string; block: Block }
export interface BlockDeltaPayload { messageId: string; blockId: string; delta: string }
export interface ToolResultDeltaPayload { messageId: string; callId: string; delta: string }

export interface LlmStartedPayload { model: string; attempt: number }
export interface LlmCompletedPayload { usage: Usage; stopReason: StopReason; latencyMs: number }
export interface LlmFailedPayload { error: { code: string; message: string }; willRetry: boolean }

export interface ConfirmationRequestedPayload {
  confirmationId: string
  toolCall: ToolCallBlock
  risk: "safe" | "sensitive"
  expiresAt: string
  /** Human-facing reason shown on the confirmation (e.g. sandbox unavailable). */
  noteText?: string
}
export interface ConfirmationResolvedPayload {
  confirmationId: string
  decision: "once" | "project" | "global" | "reject" | "timeout"
  by: "cli" | "web" | "timeout"
}

export interface NoteEmittedPayload { messageId: string; block: NoteBlock }

/** 记忆写入广播：项目级事务，不携带 sessionId（跨项目/定时路径无会话归属）。 */
export interface MemoryWrittenPayload { path: string; kind: "episode" | "cognition"; topic?: string; scope?: string }

export interface MessageQueuedPayload {
  messageId: string
  disposition: "steer" | "wait" | "interrupt"  // 按实际处置报告：空闲降级入队后报 wait
  position?: number                            // wait/interrupt 在队列中的序位；steer 不适用
}
export interface MessageSteeredPayload { messageId: string } // 事件级 runId 标识注入的 run
export interface MessageQueueCancelledPayload { messageId?: string; all?: boolean }

/** v3: 压缩触发阶段——post-run = run 前预压缩，in-run = 迭代边界中途压缩，manual = 手动。 */
export type CompactionPhase = "in-run" | "post-run" | "manual"
/** 压缩实际开始（预算过线且边界已定，即将调用摘要器）。 */
export interface CompactionStartedPayload { phase: CompactionPhase }
/** 压缩结束（每次 started 必有配对 completed）：新累计段数与压缩后保留的原文消息条数；非 ok 时 segments/kept 为 0。 */
export interface CompactionCompletedPayload { segments: number; kept: number; phase: CompactionPhase; result: "ok" | "failed" | "cancelled" }

/** hook 系统：一个用户 hook 的装载或执行失败。 */
export interface HookFailedPayload { hook: string; position: string; error: string; phase: "load" | "run" }

export type EventPayloadMap = {
  "run.started": RunStartedPayload
  "run.completed": RunCompletedPayload
  "run.failed": RunFailedPayload
  "message.created": MessageCreatedPayload
  "message.completed": MessageCompletedPayload
  "job.started": JobStartedPayload
  "job.completed": JobCompletedPayload
  "job.failed": JobFailedPayload
  "session.renamed": SessionRenamedPayload
  "text.created": BlockPayload
  "text.delta": BlockDeltaPayload
  "text.completed": BlockPayload
  "thinking.created": BlockPayload
  "thinking.delta": BlockDeltaPayload
  "thinking.completed": BlockPayload
  "tool_call.created": BlockPayload
  "tool_call.delta": BlockDeltaPayload
  "tool_call.completed": BlockPayload
  "tool_result.created": BlockPayload
  "tool_result.delta": ToolResultDeltaPayload
  "tool_result.completed": BlockPayload
  "attachment.created": BlockPayload
  "attachment.completed": BlockPayload
  "llm.started": LlmStartedPayload
  "llm.completed": LlmCompletedPayload
  "llm.failed": LlmFailedPayload
  "confirmation.requested": ConfirmationRequestedPayload
  "confirmation.resolved": ConfirmationResolvedPayload
  "note.emitted": NoteEmittedPayload
  "memory.written": MemoryWrittenPayload
  "message.queued": MessageQueuedPayload
  "message.steered": MessageSteeredPayload
  "message.queue_cancelled": MessageQueueCancelledPayload
  "compaction.started": CompactionStartedPayload
  "compaction.completed": CompactionCompletedPayload
  "hook.failed": HookFailedPayload
}

export type AgentEvent<T extends EventType = EventType> = {
  id: string
  ts: string
  type: T
  sessionId?: string
  runId?: string
  payload: EventPayloadMap[T]
}

export function makeEvent<T extends EventType>(
  type: T, payload: EventPayloadMap[T],
  ctx: { sessionId?: string; runId?: string } = {},
): AgentEvent<T> {
  const e: AgentEvent<T> = { id: newId("evt"), ts: new Date().toISOString(), type, payload }
  if (ctx.sessionId !== undefined) e.sessionId = ctx.sessionId
  if (ctx.runId !== undefined) e.runId = ctx.runId
  return e
}
