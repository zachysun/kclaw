import { newId } from "./ids.js"
import type { Block, NoteBlock, ToolCallBlock } from "./blocks.js"
import type { Message, StopReason, Usage } from "./messages.js"
import type { SessionEvent } from "./session-events.js"

export type EventType =
  // 生命周期
  | "run.started" | "run.completed" | "run.failed"
  | "message.created" | "message.completed"
  // Edit & retry / regenerate: live broadcast of a persisted truncation (payload = the discarded range's start id)
  | "message.truncated"
  | "cron.started" | "cron.completed" | "cron.failed"
  | "process.started" | "process.completed" | "process.failed"
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
  // 运行中提问（ask_user_questions 工具的等待生命周期）
  | "question.requested" | "question.resolved"
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

/** Who initiated a run — the bus payload, the persisted run.started event, the enqueue input and the engine input share this union. */
export type RunTrigger = "user" | "cron" | "process" | "agent" | "team" | "goal"

export interface RunStartedPayload {
  trigger: RunTrigger
  /** 与持久化 run.started 事件同款三字段（模型/供应商/权限模式快照）。 */
  model?: string
  provider?: string
  permissionMode?: import("../permissions/modes.js").PermissionMode
}
export interface RunCompletedPayload { stopReason: StopReason; usage: Usage }
export interface RunFailedPayload { error: { code: string; message: string } }
export interface MessageCreatedPayload { message: Message }
export interface MessageCompletedPayload { message: Message }
export interface MessageTruncatedPayload { fromMessageId: string }
export interface CronStartedPayload { cronId: string }
export interface CronCompletedPayload { cronId: string; summary: string }
export interface CronFailedPayload { cronId: string; error: { code: string; message: string } }
export interface ProcessStartedPayload { processId: string; sessionId: string; command: string }
export interface ProcessCompletedPayload { processId: string; sessionId: string; exitCode: number }
export interface ProcessFailedPayload { processId: string; sessionId: string; error: string }
export interface SessionRenamedPayload { title: string; /** 触发来源：auto = autoname 生成，manual = 用户改名（旧事件默认按 manual）。 */ source?: "auto" | "manual" }

/** Persist notice: one session event has been written to events.jsonl. Emitted by the store after a successful append — persisted BEFORE announced, so consumers can incrementally refetch safely. */
export interface SessionAppendedPayload { eventType: SessionEvent["type"] }

export interface BlockPayload { messageId: string; block: Block }
export interface BlockDeltaPayload { messageId: string; blockId: string; delta: string }
export interface ToolResultDeltaPayload { messageId: string; callId: string; delta: string }

export interface LlmStartedPayload { model: string; attempt: number }
export interface LlmCompletedPayload {
  usage: Usage
  stopReason: StopReason
  latencyMs: number
  /**
   * 缓存未命中归因（R5）：本次请求相对同一会话上次请求的前缀指纹变化。
   * 纯追加（前缀应命中）或调用方未启用归因探针时不携带。
   */
  cacheMiss?: CacheMissAttribution
}
export interface LlmFailedPayload {
  error: { code: string; message: string }
  willRetry: boolean
  /** 同 llm.completed 的归因语义；终止性失败时归因同样随事件可见。 */
  cacheMiss?: CacheMissAttribution
}

/** 一次请求前缀相对上次变化的原因（cache-attribution 的指纹比对产出）。 */
export interface CacheMissAttribution {
  /** 具名原因：tools_changed | system_changed | history_rebuilt | history_diverged。 */
  reasons: string[]
  /** 首个变化消息的 1-based 序号（history_diverged 时携带）。 */
  divergedAt?: number
  /** 变化消息的头部摘录（诊断辅助）：上次 vs 本次。 */
  prevHead?: string
  nextHead?: string
}

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
  by: "cli" | "web" | "feishu" | "timeout"
}

/** One question the model asks the user mid-run (ask_user_questions). */
export interface QuestionSpec {
  text: string
  /** When present the user picks from these; absent → free text. */
  options?: string[]
  /** Only meaningful with options: allow several picks (default single). */
  multiSelect?: boolean
}
export interface QuestionRequestedPayload {
  questionId: string
  questions: QuestionSpec[]
  expiresAt: string
  /** Human-facing label (e.g. "来自subagent X" on a forwarded card). */
  noteText?: string
}
export interface QuestionResolvedPayload {
  questionId: string
  /** Per-question answers in ask order; absent when nobody answered (timeout). */
  answers?: string[][]
  by: "cli" | "web" | "feishu" | "timeout"
}

export interface NoteEmittedPayload { messageId: string; block: NoteBlock }

/** 记忆写入广播：项目级事务，不携带 sessionId（跨项目/定时路径无会话归属）。trigger 与持久化 MemoryEvent 的 trigger 同口径。 */
export interface MemoryWrittenPayload { path: string; kind: "episode" | "cognition"; topic?: string; scope?: string; trigger?: "immediate" | "manual" | "interval" | "follow" | "clear" | "nightly" | "admin" }

export interface MessageQueuedPayload {
  messageId: string
  disposition: "steer" | "wait" | "interrupt"  // 按实际处置报告：空闲降级入队后报 wait
  position?: number                            // wait/interrupt 在队列中的序位；steer 不适用
}
export interface MessageSteeredPayload { messageId: string } // 事件级 runId 标识注入的 run
export interface MessageQueueCancelledPayload { messageId?: string; all?: boolean }

/** v3: 压缩触发阶段——post-run = run 前预压缩，in-run = 迭代边界中途压缩，manual = 手动。 */
export type CompactionPhase = "in-run" | "post-run" | "manual"
/** 压缩实际开始（budget过线且边界已定，即将调用摘要器）。trigger 与持久化 CompactionEvent 的 trigger 同口径。 */
export interface CompactionStartedPayload { phase: CompactionPhase; trigger?: "manual" | "in-run" | "auto" }
/** 压缩结束（每次 started 必有配对 completed）：新累计段数与压缩后保留的原文消息条数；非 ok 时 segments/kept 为 0。 */
export interface CompactionCompletedPayload { segments: number; kept: number; phase: CompactionPhase; result: "ok" | "failed" | "cancelled"; trigger?: "manual" | "in-run" | "auto"; emergency?: boolean }

/** hook 系统：一个用户 hook 的装载或执行失败。 */
export interface HookFailedPayload { hook: string; position: string; error: string; phase: "load" | "run" }

export type EventPayloadMap = {
  "run.started": RunStartedPayload
  "run.completed": RunCompletedPayload
  "run.failed": RunFailedPayload
  "message.created": MessageCreatedPayload
  "message.completed": MessageCompletedPayload
  "message.truncated": MessageTruncatedPayload
  "cron.started": CronStartedPayload
  "cron.completed": CronCompletedPayload
  "cron.failed": CronFailedPayload
  "process.started": ProcessStartedPayload
  "process.completed": ProcessCompletedPayload
  "process.failed": ProcessFailedPayload
  "session.appended": SessionAppendedPayload
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
  "question.requested": QuestionRequestedPayload
  "question.resolved": QuestionResolvedPayload
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

/**
 * AgentEvent distributed over every EventType — the discriminated union the
 * three clients narrow on (`switch (e.type)` narrows the payload per case).
 * The generic `AgentEvent` does NOT distribute; narrow on this one.
 */
export type AnyAgentEvent = { [T in EventType]: AgentEvent<T> }[EventType]

export function makeEvent<T extends EventType>(
  type: T, payload: EventPayloadMap[T],
  ctx: { sessionId?: string; runId?: string } = {},
): AgentEvent<T> {
  const e: AgentEvent<T> = { id: newId("evt"), ts: new Date().toISOString(), type, payload }
  if (ctx.sessionId !== undefined) e.sessionId = ctx.sessionId
  if (ctx.runId !== undefined) e.runId = ctx.runId
  return e
}
