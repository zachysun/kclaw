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
}
export interface ConfirmationResolvedPayload {
  confirmationId: string
  approved: boolean
  by: "cli" | "web" | "timeout"
}

export interface NoteEmittedPayload { messageId: string; block: NoteBlock }

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
