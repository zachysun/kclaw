/**
 * Structural wire shapes for the daemon's REST API (sessions / jobs /
 * messages). The web package is intentionally self-contained (no runtime
 * dependency on @kclaw/core): these mirror the core protocol types
 * (SessionMeta, Job, Message, Block) exactly — only the
 * UI-relevant subset is modeled here.
 */

/** Per-session metadata (mirrors @kclaw/core SessionMeta). */
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

/** A scheduled prompt (mirrors @kclaw/core Job). */
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

/**
 * Message protocol shapes (mirrors @kclaw/core protocol/messages + blocks).
 * These back the trail view (轨迹页): a message is a role-typed list of blocks,
 * each of which carries its own discriminated-union payload.
 */

/** Who authored a message (mirrors @kclaw/core Role). */
export type Role = "user" | "assistant" | "tool"

export interface TextBlock { id: string; type: "text"; text: string }
export interface ThinkingBlock { id: string; type: "thinking"; text: string }

export interface ToolCallBlock {
  id: string
  type: "tool_call"
  callId: string
  name: string
  args: unknown
  argsJson: string
}

export type ToolStatus = "ok" | "error"

export interface ToolResultBlock {
  id: string
  type: "tool_result"
  callId: string
  status: ToolStatus
  output: string
  data?: unknown
  durationMs: number
}

/** Why a note was emitted (mirrors @kclaw/core NoteKind). */
export type NoteKind = "system" | "job" | "memory" | "timeout" | "denied"

export interface NoteBlock { id: string; type: "note"; kind: NoteKind; text: string }

export type AttachmentSource =
  | { type: "base64"; data: string }
  | { type: "url"; url: string }
  | { type: "file"; path: string }

export interface AttachmentBlock {
  id: string
  type: "attachment"
  mimeType: string
  text?: string
  source: AttachmentSource
}

export type Block =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | NoteBlock
  | AttachmentBlock

export interface Message {
  id: string
  sessionId: string
  role: Role
  blocks: Block[]
  createdAt: string // ISO-8601
}

/** Why a tool call was allowed to run (mirrors @kclaw/core GrantedBy). */
export type ToolGrantReason = "safe" | "whitelist" | "session_grant" | "confirmed"

/** A tool message carries per-call grant reasons (mirrors @kclaw/core ToolMessage). */
export interface ToolMessage extends Message {
  role: "tool"
  grantedBy?: Record<string, ToolGrantReason>
}

/** One line of a session's compactions.jsonl audit log (GET /sessions/:id/compactions). */
export interface CompactionRecord {
  at: string
  trigger: "auto" | "in-run" | "manual"
  /** 超限紧急压缩的审计标记（仅自动压缩可能携带）。 */
  emergency?: true
  focus?: string
  from: string | null
  upto: string
  messages: number
  segmentSummary: string
  top: string
}
