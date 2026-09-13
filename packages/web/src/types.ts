/**
 * Web-facing wire types. Everything the daemon actually defines on the wire
 * (blocks, messages, agent events, session events) is imported from the typed
 * canon `@kclaw/core/protocol` — no hand-copied mirrors here. What stays in
 * THIS file are the REST response shapes the web UI models itself (the
 * UI-relevant subset of what the HTTP routes return).
 */
export type {
  AgentEvent, AttachmentBlock, AttachmentSource, Block, Message, NoteBlock, NoteKind, Role,
  TextBlock, ThinkingBlock, ToolCallBlock, ToolResultBlock, ToolStatus, Usage,
  CompactionEvent, MemoryEvent, MessageEvent, MessageTruncatedEvent, PermissionDecidedEvent, RunEndedEvent, RunStartedEvent,
  SandboxCheckedEvent, SessionCreatedEvent, SessionDeletedEvent,
  SessionEvent, SessionRenamedEvent, SessionRestoredEvent, SessionSetEvent, SystemEvent,
} from "@kclaw/core/protocol"
// The core canon names this GrantedBy; the web UI's historical name stays.
export type { GrantedBy as ToolGrantReason } from "@kclaw/core/protocol"

/** Per-session metadata as GET /sessions returns it (the UI-relevant subset of core's SessionMeta). */
export interface SessionMeta {
  id: string
  title: string
  createdAt: string // ISO-8601
  updatedAt: string // ISO-8601
  jobId?: string
  workdir?: string
  model?: string
  deleted?: boolean
  deletedAt?: string
}

/** Wire shape of `GET /fs/browse` (the workdir picker's directory listing). */
export interface FsBrowseResult {
  /** Canonical (symlink-resolved) absolute path that was listed. */
  path: string
  /** Parent directory, or null at the filesystem root. */
  parent: string | null
  /** Subdirectory names only (files excluded), sorted case-insensitively. */
  dirs: string[]
}

/** A scheduled prompt as GET /jobs returns it. */
export interface Job {
  id: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
  nextRunAt: string // ISO-8601
  lastRunAt?: string // ISO-8601
  lastStatus?: "ok" | "error"
  lastError?: string
}
