import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { newId } from "../protocol/ids.js"
import type { Message } from "../protocol/messages.js"
import { writeFileAtomic } from "../storage/atomic.js"
import { appendJsonlLine, readJsonl } from "../storage/jsonl.js"

/** Per-session metadata persisted at <sessionsDir>/<id>/meta.json. */
export interface SessionMeta {
  id: string
  title: string
  createdAt: string // ISO-8601
  updatedAt: string // ISO-8601
  jobId?: string
  workdir?: string
  deleted?: boolean
  deletedAt?: string
}

const META_FILE = "meta.json"
const MESSAGES_FILE = "messages.jsonl"

/**
 * Append-only JSONL session persistence:
 * each session lives in <sessionsDir>/<id>/ holding meta.json plus
 * messages.jsonl with one JSON.stringify(message) per line.
 *
 * Crash tolerance: a torn trailing line (crash mid-append) is
 * dropped on read, and the append repairs it first (storage/jsonl.ts) so the
 * next message survives; a corrupt line anywhere earlier is corruption,
 * not a crash artifact, so readMessages throws.
 */
export class SessionStore {
  private readonly sessionsDir: string

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir
    mkdirSync(sessionsDir, { recursive: true })
  }

  private sessionDir(id: string): string {
    return join(this.sessionsDir, id)
  }

  private metaPath(id: string): string {
    return join(this.sessionDir(id), META_FILE)
  }

  private messagesPath(id: string): string {
    return join(this.sessionDir(id), MESSAGES_FILE)
  }

  private writeMeta(meta: SessionMeta): void {
    writeFileAtomic(this.metaPath(meta.id), JSON.stringify(meta))
  }

  /** Create a new session directory with initial meta.json. */
  create(title?: string, jobId?: string, workdir?: string): SessionMeta {
    const id = newId("ses")
    const now = new Date().toISOString()
    const meta: SessionMeta = { id, title: title ?? "新会话", createdAt: now, updatedAt: now }
    if (jobId !== undefined) meta.jobId = jobId
    if (workdir !== undefined) meta.workdir = workdir
    mkdirSync(this.sessionDir(id), { recursive: true })
    this.writeMeta(meta)
    return meta
  }

  /** Sessions with readable meta, newest-updated first; corrupt/missing meta is skipped.
   *  By default only non-deleted sessions are returned; pass `{ deleted: true }` for the recycle bin. */
  list(opts: { deleted?: boolean } = {}): SessionMeta[] {
    const entries = readdirSync(this.sessionsDir, { withFileTypes: true })
    const metas: SessionMeta[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = this.meta(entry.name)
      if (meta === undefined) continue
      const wantDeleted = opts.deleted === true
      if (wantDeleted !== (meta.deleted === true)) continue
      metas.push(meta)
    }
    return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  }

  /** Read one session's meta; undefined when the session or its meta.json is missing/unreadable. */
  meta(id: string): SessionMeta | undefined {
    try {
      return JSON.parse(readFileSync(this.metaPath(id), "utf8")) as SessionMeta
    } catch {
      return undefined
    }
  }

  /** Append one message as a JSONL line and bump updatedAt (meta.json rewrite). */
  appendMessage(id: string, message: Message): void {
    mkdirSync(this.sessionDir(id), { recursive: true })
    appendJsonlLine(this.messagesPath(id), message)
    const current = this.meta(id)
    if (current === undefined) return // orphan append: no meta to bump
    this.writeMeta({ ...current, updatedAt: new Date().toISOString() })
  }

  /** Load a session's messages; missing file yields []. */
  readMessages(id: string): Message[] {
    return readJsonl(this.messagesPath(id)) as Message[]
  }

  /** Merge `patch` into meta.json and bump updatedAt. `undefined` keys in the patch are removed. */
  updateMeta(id: string, patch: Partial<SessionMeta>): SessionMeta {
    const current = this.meta(id)
    if (current === undefined) throw new Error(`session not found: ${id}`)
    const merged: SessionMeta = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() }
    for (const k of Object.keys(merged) as (keyof SessionMeta)[]) {
      if (merged[k] === undefined) delete merged[k]
    }
    this.writeMeta(merged)
    return merged
  }

  /** Soft-delete a session: mark it deleted so it leaves the default list. */
  delete(id: string): SessionMeta {
    const now = new Date().toISOString()
    return this.updateMeta(id, { deleted: true, deletedAt: now })
  }

  /** Restore a soft-deleted session back to the default list. */
  restore(id: string): SessionMeta {
    return this.updateMeta(id, { deleted: undefined, deletedAt: undefined })
  }

  /** Permanently delete a session's directory. */
  purge(id: string): void {
    rmSync(this.sessionDir(id), { recursive: true, force: true })
  }

  /** Permanently delete soft-deleted sessions whose `deletedAt` is at least `ttlMs` old. */
  purgeExpired(ttlMs: number): string[] {
    const now = Date.now()
    const purged: string[] = []
    for (const meta of this.list({ deleted: true })) {
      if (meta.deletedAt === undefined) continue
      if (now - Date.parse(meta.deletedAt) >= ttlMs) {
        this.purge(meta.id)
        purged.push(meta.id)
      }
    }
    return purged
  }
}