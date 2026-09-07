/**
 * Session event-stream types — the wire shapes of GET /sessions/:id/events
 * (events.jsonl lines). Types ONLY (no SessionMeta, no Node APIs) so the
 * browser build can import them through the `@kclaw/core/protocol` subpath;
 * the guards and the meta projection (applyEvent) live in session/events.ts.
 */
import type { Message } from "./messages.js"

export interface SessionCreatedEvent { type: "session.created"; at: string; title: string; workdir?: string; jobId?: string }
export interface SessionRenamedEvent { type: "session.renamed"; at: string; title: string }
export interface SessionDeletedEvent { type: "session.deleted"; at: string }
export interface SessionRestoredEvent { type: "session.restored"; at: string }
export interface SessionSetEvent { type: "session.set"; at: string; model?: string | null; /** @legacy pre-mode sessions; superseded by `mode` */ readonly?: boolean | null; mode?: import("../permissions/modes.js").PermissionMode | null; disposition?: "steer" | "wait" | "interrupt" | null }
export type MessageEvent = { type: "message" } & Message
export interface CompactionEvent { type: "compaction"; at: string; trigger: "manual" | "in-run" | "auto"; emergency?: true; focus?: string; from: string | null; upto: string; messages: number; segmentSummary: string; top: string }
export interface MemoryEvent {
  type: "memory"; at: string
  trigger: "immediate" | "manual" | "interval" | "follow" | "clear" | "nightly" | "admin"
  kind: "episode" | "cognition"
  op: "append" | "update" | "new-thread" | "rewrite" | "create" | "overwrite" | "delete" | "inactivate"
  topic?: string; file?: string; scope?: string; source?: string
}
export interface SystemEvent { type: "system"; at: string; text: string }

export type SessionEvent = SessionCreatedEvent | SessionRenamedEvent | SessionDeletedEvent | SessionRestoredEvent | SessionSetEvent | MessageEvent | CompactionEvent | MemoryEvent | SystemEvent
