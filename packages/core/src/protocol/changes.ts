/**
 * Change-drawer wire shapes: the per-file aggregation of a session's ok
 * fs_write / fs_edit calls (GET /sessions/:id/changes) and the
 * current-content preview envelope (GET /sessions/:id/changes/file).
 * Type-only (no Node API) — the server routes produce these, the WebUI
 * change drawer consumes them; the named shapes live here per the
 * Protocol rule (CONTEXT.md: one type source, no per-end mirrors).
 */

/** One successful fs_write/fs_edit call against a file, newest first within a file. */
export interface ChangeOp {
  callId: string
  tool: "fs_write" | "fs_edit"
  at: string
  /** fs_edit carries old/new, fs_write carries the written content itself. */
  args: { old?: string; new?: string; content?: string }
}

/** Change records for one file, aggregated over the whole session event stream. */
export interface ChangeFile {
  /** Resolved absolute path — the whitelist key of the file-content route. */
  path: string
  /** Workspace-relative display path; null when the file lives outside the workspace. */
  relativePath: string | null
  firstAt: string
  lastAt: string
  ops: ChangeOp[]
}

/** Envelope of GET /sessions/:id/changes. */
export type ChangesView = { files: ChangeFile[] }

/** Envelope of GET /sessions/:id/changes/file — current disk content, or binary flagged and withheld. */
export type ChangeFileContent =
  | { content: string; bytes: number }
  | { binary: true; bytes: number }
