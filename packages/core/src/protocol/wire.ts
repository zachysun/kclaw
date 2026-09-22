/**
 * Wire shapes for the daemon↔client boundary — the Protocol 正本 (CONTEXT.md):
 * every type that crosses between the daemon and its clients is defined or
 * re-exported here, and the three consumers (server, web, cli) import it
 * through the `@kclaw/core/protocol` subpath instead of hand-copying mirrors.
 * Types and pure data only — no Node APIs — so the browser build can import
 * it without pulling the Node-bound main entry (the @kclaw/core/commands
 * precedent).
 */
import type { AgentEvent } from "./events.js"
import type { NoteKind } from "./blocks.js"

/** How a send_message rides the queue: steer injects, wait queues, interrupt preempts. */
export type SendDisposition = "steer" | "wait" | "interrupt"

/**
 * A reference to an uploaded attachment file (the daemon mounts it as an
 * attachment block). One canonical shape for the three former hand-copies:
 * the server's runtime queue, core's queue.jsonl persistence, and the
 * clients' upload payloads.
 */
export interface AttachmentRef {
  path: string
  name: string
  size: number
  mimeType: string
}

/**
 * The structured provenance note riding a queue entry onto its user message
 * (as a note block right after the text): WHO asked for this run, when the
 * requester was not the user. `kind:"job"` = the scheduler's per-job line;
 * `kind:"subagent"` = a background completion delivery declaring that the
 * message is machine-originated, not user speech.
 */
export interface QueueNote {
  kind: NoteKind
  text: string
}

/** One persisted queue entry in queue.jsonl 。 */
export interface QueueEntry {
  messageId: string                       // 分配即固定；出队执行时用同一 id 构建 Message
  disposition: SendDisposition
  text: string
  trigger: "user" | "job" | "agent" | "team"  // 还原触发源（job 的 note/触发语义在出队执行时需要；agent = subagent 派生的子 run；team = 团队收信箱投递/派活，按常规处置走 steer 注入）
  attachments?: AttachmentRef[]
  note?: QueueNote                        // 机器来源说明
  enqueuedAt: string                      // ISO-8601
}

// ---- inbound command frames (client → daemon) ----
// The typed canon of the ws command protocol; the server-side field checks
// (server/src/command-check.ts) validate raw JSON against exactly these
// shapes, error message for error message.

/** The pre-auth handshake frame — the first frame on every connection (or the `?token=` query). */
export interface AuthFrame {
  type: "auth"
  token: string
}

export interface SubscribeFrame { type: "subscribe"; sessionId: string }
export interface UnsubscribeFrame { type: "unsubscribe"; sessionId: string }

/** A human verdict on a pending confirmation: the persistence scope of the
 * approval (`once` approves this call only) or an explicit reject. */
export type ConfirmationDecision = "once" | "project" | "global" | "reject"

export interface ConfirmationResolveFrame {
  type: "confirmation.resolve"
  confirmationId: string
  decision: ConfirmationDecision
  /** Verdict provenance: the web UI names itself ("web"); omitted → "cli". */
  client?: "cli" | "web"
}

/** One answer set for a pending ask_user_questions call: one string array per question, in ask order. */
export interface QuestionResolveFrame {
  type: "question.resolve"
  questionId: string
  answers: string[][]
  /** Answer provenance: the web UI names itself ("web"); omitted → "cli". */
  client?: "cli" | "web"
}

export interface SendMessageFrame {
  type: "send_message"
  sessionId: string
  text: string
  disposition?: SendDisposition
  attachments?: AttachmentRef[]
  /** Agent team targeted send: the member name to deliver to. Absent = the
   * session itself (the lead). The message also lands in the lead's history
   * with a forwarding marker, per the team spec's user-to-member path. */
  target?: string
}

/**
 * Edit & retry / regenerate: discard everything from `fromMessageId` (must be
 * the session's last user message) and start a new run with `text`. Regenerate
 * is the same frame with the original text and attachments.
 */
export interface MessageRetryFrame {
  type: "message.retry"
  sessionId: string
  fromMessageId: string
  text: string
  attachments?: AttachmentRef[]
}

export interface QueueCancelFrame {
  type: "queue.cancel"
  sessionId: string
  /** Omitted = cancel every still-cancellable entry (the key must be absent on the wire). */
  messageId?: string
}

export interface RunCancelFrame { type: "run.cancel"; sessionId: string }
export interface CompactionCancelFrame { type: "compaction.cancel"; sessionId: string }

/** One client→daemon command frame. */
export type ClientCommand =
  | AuthFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | ConfirmationResolveFrame
  | QuestionResolveFrame
  | SendMessageFrame
  | MessageRetryFrame
  | QueueCancelFrame
  | RunCancelFrame
  | CompactionCancelFrame

// ---- server → client replies (command acks + error frames) ----

export interface SubscribedAck { type: "subscribed"; sessionId: string }
export interface UnsubscribedAck { type: "unsubscribed"; sessionId: string }
export interface ConfirmationResolvedAck { type: "confirmation.resolved_ack"; confirmationId: string; ok: true }
export interface QuestionResolvedAck { type: "question.resolved_ack"; questionId: string; ok: true }
export interface SendMessageAck { type: "send_message_ack"; sessionId: string; messageId: string; queued: boolean }
export interface MessageRetryAck { type: "message.retry_ack"; sessionId: string; messageId: string; queued: boolean }
export interface QueueCancelAck { type: "queue.cancel_ack"; sessionId: string; cancelled: string[] }
export interface RunCancelAck { type: "run_cancel_ack"; sessionId: string }
export interface CompactionCancelAck { type: "compaction_cancel_ack"; sessionId: string; active: boolean }

/** One error frame — the daemon's universal "command rejected" reply (connection stays open). */
export interface ErrorFrame { type: "error"; message: string }

export type ServerAck =
  | SubscribedAck
  | UnsubscribedAck
  | ConfirmationResolvedAck
  | QuestionResolvedAck
  | SendMessageAck
  | MessageRetryAck
  | QueueCancelAck
  | RunCancelAck
  | CompactionCancelAck

/** Everything the daemon may push on a ws connection: bus events, command acks and error frames. */
export type ServerFrame = AgentEvent | ServerAck | ErrorFrame
