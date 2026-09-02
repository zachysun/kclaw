import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { newId } from "../protocol/ids.js"
import type { Message } from "../protocol/messages.js"
import type { CompactionRecord, CompactionState } from "./compaction.js"
import { writeFileAtomic } from "../storage/atomic.js"
import { appendJsonlLine, readJsonl } from "../storage/jsonl.js"
import { applyEvent, isCompactionEvent, isMessageEvent } from "./events.js"
import type { SessionCreatedEvent, SessionEvent, SessionSetEvent } from "./events.js"

/** 排队条目的附件形状（与 server 的 AttachmentRef 结构一致，结构类型互通）。 */
export interface QueueAttachment { path: string; name: string; size: number; mimeType: string }

/** One persisted queue entry in queue.jsonl (spec §3.1)。 */
export interface QueueEntry {
  messageId: string                       // 分配即固定；出队执行时用同一 id 构建 Message
  disposition: "steer" | "wait" | "interrupt"
  text: string
  trigger: "user" | "job"                 // 还原触发源（job 的 note/触发语义在出队执行时需要）
  attachments?: QueueAttachment[]
  note?: string                           // job 来源说明
  enqueuedAt: string                      // ISO-8601
}

/** Per-session metadata persisted at <sessionsDir>/<id>/meta.json. */
export interface SessionMeta {
  id: string
  title: string
  createdAt: string // ISO-8601
  updatedAt: string // ISO-8601
  jobId?: string
  workdir?: string
  /** Per-session model override (empty/absent → daemon default). */
  model?: string
  /** Per-session readonly mode (write/exec denied, reads fine). */
  readonly?: boolean
  deleted?: boolean
  deletedAt?: string
  /** Rolling compaction summary of messages before `compactedUpto` (context compaction). */
  compactedSummary?: string
  /** Last message id covered by `compactedSummary`; history after it is the active window. */
  compactedUpto?: string
  /** v2 layered compaction state (spec 5.1); absent on fresh/legacy sessions. */
  compaction?: CompactionState
  /** 会话级处置覆盖（/steer /wait、Web 三选；spec §6）：优先于 sessions.defaultDisposition。 */
  dispositionOverride?: "steer" | "wait" | "interrupt"
}

const META_FILE = "meta.json"
const EVENTS_FILE = "events.jsonl"
const QUEUE_FILE = "queue.jsonl"

/**
 * Event-sourced append-only JSONL session persistence: each session lives in
 * <sessionsDir>/<id>/ holding an immutable events.jsonl event stream (one
 * JSON.stringify(SessionEvent) per line) plus meta.json — a derived projection
 * of that stream via applyEvent. All writes go through events.jsonl first and
 * the projection second; the projection is rebuildable from the stream
 * (rebuildMeta) when it goes missing or corrupt.
 *
 * Crash tolerance: a torn trailing line (crash mid-append) is dropped on read,
 * and the append repairs it first (storage/jsonl.ts) so the next event
 * survives; a corrupt line anywhere earlier is corruption, not a crash
 * artifact, so readEvents throws. meta.json is written atomically
 * (writeFileAtomic), so it is always either the pre- or post-event projection.
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

  private eventsPath(id: string): string {
    return join(this.sessionDir(id), EVENTS_FILE)
  }

  private queuePath(id: string): string {
    return join(this.sessionDir(id), QUEUE_FILE)
  }

  private writeMeta(meta: SessionMeta): void {
    writeFileAtomic(this.metaPath(meta.id), JSON.stringify(meta))
  }

  /** 事件的时间字段：message 事件用 createdAt，其余事件用 at。 */
  private eventAt(event: SessionEvent): string {
    return event.type === "message" ? event.createdAt : event.at
  }

  /**
   * Append one event to events.jsonl (event first), then fold it into the meta
   * projection (projection second). The pre-append projection is read before
   * the append so a rebuild triggered by a missing/corrupt meta.json never
   * re-applies the just-appended event (its result already includes it).
   */
  appendEvent(id: string, event: SessionEvent): void {
    mkdirSync(this.sessionDir(id), { recursive: true })
    const current = this.meta(id)
    appendJsonlLine(this.eventsPath(id), event)
    const at = this.eventAt(event)
    const base: SessionMeta = current ?? { id, title: "", createdAt: at, updatedAt: at }
    this.writeMeta(applyEvent(base, event))
  }

  /** Load a session's event stream oldest-first; missing file yields []. */
  readEvents(id: string): SessionEvent[] {
    return readJsonl(this.eventsPath(id)) as SessionEvent[]
  }

  /** Rebuild the meta projection from the full event stream and write it back;
   *  undefined when the session has no events (does not exist). */
  rebuildMeta(id: string): SessionMeta | undefined {
    const events = this.readEvents(id)
    if (events.length === 0) return undefined
    const first = events[0]!
    const at = first.type === "message" ? first.createdAt : first.at
    const meta = events.reduce(applyEvent, { id, title: "", createdAt: at, updatedAt: at })
    this.writeMeta(meta)
    return meta
  }

  /** Create a new session directory: append a session.created event, return its projected meta. */
  create(title?: string, jobId?: string, workdir?: string): SessionMeta {
    const id = newId("ses")
    const now = new Date().toISOString()
    const event: SessionCreatedEvent = { type: "session.created", at: now, title: title ?? "新会话" }
    if (jobId !== undefined) event.jobId = jobId
    if (workdir !== undefined) event.workdir = workdir
    this.appendEvent(id, event)
    return this.meta(id)!
  }

  /** Sessions with a readable projection, newest-updated first; a missing/corrupt meta.json is rebuilt from its event stream. A session directory with no events at all is skipped.
   *  By default only non-deleted sessions are returned; pass `{ deleted: true }` for the recycle bin. */
  list(opts: { deleted?: boolean } = {}): SessionMeta[] {
    const entries = readdirSync(this.sessionsDir, { withFileTypes: true })
    const metas: SessionMeta[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // 单个会话的 meta 重建失败（meta.json 损坏且事件流也损坏）时跳过该会话，
      // 不能让它拖垮整个列表（旧行为：损坏的 meta 即被 list 跳过）。
      let meta: SessionMeta | undefined
      try {
        meta = this.meta(entry.name)
      } catch {
        continue
      }
      if (meta === undefined) continue
      const wantDeleted = opts.deleted === true
      if (wantDeleted !== (meta.deleted === true)) continue
      metas.push(meta)
    }
    return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  }

  /** Non-deleted sessions of one job, newest-updated first (job-history queries). */
  listByJob(jobId: string): SessionMeta[] {
    return this.list().filter((m) => m.jobId === jobId)
  }

  /** Read one session's projection (meta.json); when missing/corrupt, rebuild it from the event stream. */
  meta(id: string): SessionMeta | undefined {
    try {
      return JSON.parse(readFileSync(this.metaPath(id), "utf8")) as SessionMeta
    } catch {
      return this.rebuildMeta(id)
    }
  }

  /** Append one message event; the projection's updatedAt follows the message createdAt. */
  appendMessage(id: string, message: Message): void {
    this.appendEvent(id, { type: "message", ...message })
  }

  /** Load a session's messages (message events, oldest-first); missing stream yields []. */
  readMessages(id: string): Message[] {
    return this.readEvents(id).filter(isMessageEvent).map(({ type, ...m }) => m as Message)
  }

  /** Append one compaction audit event (spec 6A.1). */
  appendCompaction(id: string, record: CompactionRecord): void {
    this.appendEvent(id, { type: "compaction", ...record })
  }

  /** Read the compaction audit events; missing or corrupt stream yields []. */
  readCompactions(id: string): CompactionRecord[] {
    try {
      return this.readEvents(id).filter(isCompactionEvent).map(({ type, ...c }) => c as CompactionRecord)
    } catch {
      return []
    }
  }

  /** Append one system audit event (每次对话运行的系统提示词全量留痕); the projection stays untouched (不推进 updatedAt)。 */
  appendSystem(id: string, text: string): void {
    this.appendEvent(id, { type: "system", at: new Date().toISOString(), text })
  }

  /**
   * Read a session's persisted message queue (queue.jsonl), oldest-first;
   * a missing/empty file yields [].
   */
  readQueue(id: string): QueueEntry[] {
    return readJsonl(this.queuePath(id)) as QueueEntry[]
  }

  /**
   * Atomically rewrite a session's whole message queue (queue.jsonl): one
   * JSON.stringify(QueueEntry) per line, order = execution order. Empty
   * array writes an empty file (so readQueue stays a plain readJsonl call).
   */
  replaceQueue(id: string, entries: QueueEntry[]): void {
    writeFileAtomic(this.queuePath(id), entries.map((e) => JSON.stringify(e)).join("\n") + "\n")
  }

  /**
   * Merge `patch` into the session. Metadata fields (title/model/readonly/
   * dispositionOverride/deleted/deletedAt) become session.* events, appended
   * to the stream before the projection is rewritten — model/readonly/
   * dispositionOverride are fully event-driven: setting OR clearing emits a
   * `session.set` event (patch 值 undefined → 事件里 null = 清除)。Only
   * run-state fields (compactedSummary/compactedUpto) are merged straight
   * into the projection (undefined clears; no clearing event exists for
   * them). compaction is projection-maintained by the compaction event,
   * never merged here. Returns the newest projection.
   */
  updateMeta(id: string, patch: Partial<SessionMeta>): SessionMeta {
    const current = this.meta(id)
    if (current === undefined) throw new Error(`session not found: ${id}`)
    const now = new Date().toISOString()

    // 元数据字段 → 事件（仅当有确定的新值且确实发生变化）
    const events: SessionEvent[] = []
    if (patch.title !== undefined && patch.title !== current.title) {
      events.push({ type: "session.renamed", at: now, title: patch.title })
    }
    // model/readonly/dispositionOverride：键出现在 patch 即发 session.set 事件，
    // 值 undefined 映射为 null（= 清除）。投影只由事件推进，重建时不复活已清除的覆盖。
    if ("model" in patch || "readonly" in patch || "dispositionOverride" in patch) {
      const set: SessionSetEvent = { type: "session.set", at: now }
      if ("model" in patch) set.model = patch.model ?? null
      if ("readonly" in patch) set.readonly = patch.readonly ?? null
      if ("dispositionOverride" in patch) set.disposition = patch.dispositionOverride ?? null
      events.push(set)
    }
    if (patch.deleted === true || (patch.deletedAt !== undefined && patch.deletedAt !== current.deletedAt)) {
      events.push({ type: "session.deleted", at: patch.deletedAt ?? now })
    }
    if ("deleted" in patch && patch.deleted !== true) {
      events.push({ type: "session.restored", at: now })
    }

    // 事件优先：逐条落盘事件并折进投影
    let projection = current
    for (const event of events) {
      this.appendEvent(id, event)
      projection = applyEvent(projection, event)
    }

    // 仅剩运行态字段（compactedSummary/compactedUpto）直接合并投影（undefined 即清除）；
    // 它们没有对应的清除事件，属 legacy 行为。model/readonly/dispositionOverride 已完全
    // 事件化（session.set，含 null 清除），不再走这里。compaction 由 compaction 事件
    // 投影（applyEvent）维护，updateMeta 不直接合并（run.ts 只 appendCompaction）。
    for (const k of ["compactedSummary", "compactedUpto"] as const) {
      if (!(k in patch)) continue
      const value = patch[k]
      if (value === undefined) delete (projection as unknown as Record<string, unknown>)[k]
      else (projection as unknown as Record<string, unknown>)[k] = value
    }

    // 显式清除 deleted 时投影不保留 deleted/deletedAt 键（与旧版 meta 形状一致）
    if ("deleted" in patch && patch.deleted !== true) {
      delete projection.deleted
      delete projection.deletedAt
    }

    this.writeMeta(projection)
    return projection
  }

  /** Soft-delete a session: append a session.deleted event. */
  delete(id: string): SessionMeta {
    const now = new Date().toISOString()
    return this.updateMeta(id, { deleted: true, deletedAt: now })
  }

  /** Restore a soft-deleted session: append a session.restored event. */
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