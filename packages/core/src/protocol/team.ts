/**
 * Agent team domain shapes — the pure, browser-safe canon for the team
 * directory (`<workspace>/.kclaw/teams/<team-name>/` and
 * `<workspace>/.kclaw/tasks/<team-name>/`), the team audit events
 * (session-events.ts) and the team facade (core/src/team). Types and pure
 * data only — no Node APIs — so the browser build can import them through
 * the `@kclaw/core/protocol` subpath (the session-events precedent).
 */

/** Member lifecycle: provisioning → active | failed (terminal). Runtime
 * busy/idle is a derived observation and never persisted in the list. */
export type TeamMemberStatus = "provisioning" | "active" | "failed"

/** One member-list entry (config.json `members`). */
export interface TeamMember {
  name: string
  /** Child session id; empty until provisioning has created the session. */
  sessionId: string
  role?: string
  status: TeamMemberStatus
  /** Resolved provider/model snapshot taken at spawn time; cold recovery and
   * every later turn route by this, not by the lead's current routing. */
  model?: string
  failReason?: string
  createdAt: string
  settledAt?: string
}

export interface TeamMemberList {
  version: 1
  members: TeamMember[]
}

/** Where a mailbox message came from. Rendered as a sender prefix so a
 * receiver can always tell a peer/lead message from a user instruction. */
export type TeamSenderKind = "lead" | "member" | "user"

export type MailboxStatus = "pending" | "delivered"

/** One inbox entry (inboxes/<name>.json). "pending = undelivered" is the
 * crash-recovery contract: entries still pending after a restart get
 * redelivered in file order. */
export interface MailboxEntry {
  id: string
  from: { kind: TeamSenderKind; name?: string }
  to: string
  /** v1 is always "text"; the field reserves room for structured mail. */
  type: "text"
  text: string
  status: MailboxStatus
  at: string
  deliveredAt?: string
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled"

/** A task is a full snapshot (tasks/<team-name>/task-<id>.json); every update rewrites the
 * whole file guarded by a monotonic revision (compare-and-swap). */
export interface TaskSnapshot {
  id: number
  subject: string
  detail: string
  status: TaskStatus
  /** Owner member name; null = unclaimed (dispatch-ready when deps are done). */
  assignee: string | null
  /** Team-local task ids; all must be completed before this task can be claimed. */
  dependencies: number[]
  /** Execution count; increments on every (re)start of work. */
  attempt: number
  /** Identity of the current execution; progress updates must echo it, so a
   * superseded executor's late writes cannot clobber the successor's result. */
  attemptId?: string
  revision: number
  createdAt: string
  updatedAt: string
}

/** Team record (the non-members part of teams/<team-name>/config.json). */
export interface TeamRecord {
  version: 1
  teamId: string
  name: string
  leadSessionId: string
  createdAt: string
}
