import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { newId } from "../protocol/ids.js"
import type { Message } from "../protocol/messages.js"
import type { CompactionRecord, CompactionState } from "./compaction.js"
import { writeFileAtomic } from "../storage/atomic.js"
import { appendJsonlLine, readJsonl, readJsonlFrom } from "../storage/jsonl.js"
import { applyEvent, isCompactionEvent, isMessageEvent, isMessageTruncatedEvent } from "./events.js"
import type { MessageTruncatedEvent, PermissionDecidedEvent, RunEndedEvent, RunStartedEvent, SandboxCheckedEvent, SessionCreatedEvent, SessionEvent, SessionSetEvent, SystemEvent } from "./events.js"
import type { AttachmentRef, QueueEntry } from "../protocol/wire.js"
import type { PermissionMode } from "../permissions/modes.js"

// QueueEntry/AttachmentRef 的正本在 protocol/wire.ts（@kclaw/core/protocol 出口）；
// 此处 re-export 维持既有从 store 的引用路径。
export type { AttachmentRef, QueueEntry }

/** Per-session metadata persisted at <sessionsDir>/<id>/meta.json. */
export interface SessionMeta {
  id: string
  title: string
  createdAt: string // ISO-8601
  updatedAt: string // ISO-8601
  jobId?: string
  workdir?: string
  /**
   * 父会话（subagent 派生关系）：设置即子会话。子会话不出现在默认会话列表、
   * 不进记忆提取扫描，token 用量归组到父会话名下；完整轨迹仍按 id 可查（审计）。
   */
  parentSessionId?: string
  /** Per-session model override (empty/absent → daemon default). */
  model?: string
  /**
   * Session permission mode (absent → "default"). Supersedes the legacy
   * `readonly` boolean: a projected `readonly: true` reads back as
   * `mode: "readonly"` (see normalize below and session.set handling).
   */
  mode?: PermissionMode
  deleted?: boolean
  deletedAt?: string
  /** Rolling compaction summary of messages before `compactedUpto` (context compaction). */
  compactedSummary?: string
  /** Last message id covered by `compactedSummary`; history after it is the active window. */
  compactedUpto?: string
  /** layered compaction state; absent on fresh/legacy sessions. */
  compaction?: CompactionState
  /**
   * 冻结的系统提示词基线（提示词缓存纪律），双段独立冻结：stable（人设基座
   * + 注入约定）在前不变，live（认知 + 技能清单）变化即时生效——前缀缓存按
   * 从头逐字节相同匹配，live 变化只失效变化点之后。段级 frozenAt 记录该段
   * 文本成为基线的时刻。下一次压缩清除此字段后随首个 system 审计事件重新
   * 固化（纪元边界=缓存冷启动，零额外成本）。
   * 投影由事件推进：system 事件逐段 upsert、compaction 事件清除——事件流唯一真相。
   */
  systemBaseline?: { stable: { text: string; frozenAt: string }; live?: { text: string; frozenAt: string } }
  /** 会话级处置覆盖（/steer /wait、Web 三选）：优先于 sessions.defaultDisposition。 */
  dispositionOverride?: "steer" | "wait" | "interrupt"
}

const META_FILE = "meta.json"
const EVENTS_FILE = "events.jsonl"
const QUEUE_FILE = "queue.jsonl"

/**
 * Read-time migration of pre-mode projections: a legacy `readonly: true`
 * surfaces as `mode: "readonly"`; the boolean itself is dropped so writes
 * only ever produce the new field. New sessions are untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeLegacyMeta(m: any): SessionMeta {
  if (m !== null && typeof m === "object") {
    if (m.readonly === true) {
      if (m.mode === undefined) m.mode = "readonly"
      delete m.readonly
    }
    // Pre-split single-text system baseline reads back as the stable segment
    // (live absent — the next run's assembly fills and freezes it).
    const baseline = m.systemBaseline
    if (baseline && typeof baseline.text === "string") {
      m.systemBaseline = { stable: { text: baseline.text, frozenAt: baseline.frozenAt } }
    }
  }
  return m as SessionMeta
}

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
  /**
   * Optional post-append notifier (daemon wires it to the bus as a
   * `session.appended` frame). Called after the event AND its projection are
   * durably written, so subscribers can incrementally refetch; a throwing
   * notifier is swallowed — announcing must never turn a successful write
   * into a failure.
   */
  private readonly onAppended?: (sessionId: string, event: SessionEvent) => void

  constructor(sessionsDir: string, onAppended?: (sessionId: string, event: SessionEvent) => void) {
    this.sessionsDir = sessionsDir
    this.onAppended = onAppended
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
    if (this.onAppended !== undefined) {
      try {
        this.onAppended(id, event)
      } catch {
        // A listener failure is not a write failure: event and projection are already durable.
      }
    }
  }

  /** Load a session's event stream oldest-first; missing file yields []. */
  readEvents(id: string): SessionEvent[] {
    return readJsonl(this.eventsPath(id)) as SessionEvent[]
  }

  /** Tail read for incremental pulls: the events at indexes >= since, with
   *  the skipped prefix neither parsed nor materialized. */
  readEventsFrom(id: string, since: number): SessionEvent[] {
    return readJsonlFrom(this.eventsPath(id), since) as SessionEvent[]
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

  /**
   * Create a new session directory: append a session.created event, return
   * its projected meta. The initial permission mode is frozen at creation
   * (the daemon's config default; absent → "default"), so meta.mode always
   * carries a real value and later config changes only affect NEW sessions.
   */
  create(title?: string, jobId?: string, workdir?: string, mode: PermissionMode = "default", parentSessionId?: string): SessionMeta {
    const id = newId("ses")
    const now = new Date().toISOString()
    const event: SessionCreatedEvent = { type: "session.created", at: now, title: title ?? "新会话", mode }
    if (jobId !== undefined) event.jobId = jobId
    if (workdir !== undefined) event.workdir = workdir
    if (parentSessionId !== undefined) event.parentSessionId = parentSessionId
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

  /** Sessions (recycle-bin view included) spawned by `parentSessionId`, for the delete/purge cascade. */
  listByParent(parentSessionId: string): SessionMeta[] {
    return [...this.list(), ...this.list({ deleted: true })]
      .filter((m) => m.parentSessionId === parentSessionId)
  }

  /** Read one session's projection (meta.json); when missing/corrupt, rebuild it from the event stream. */
  meta(id: string): SessionMeta | undefined {
    try {
      return normalizeLegacyMeta(JSON.parse(readFileSync(this.metaPath(id), "utf8")) as SessionMeta)
    } catch {
      return this.rebuildMeta(id)
    }
  }

  /** Append one message event; the projection's updatedAt follows the message createdAt. */
  appendMessage(id: string, message: Message): void {
    this.appendEvent(id, { type: "message", ...message })
  }

  /** Append one truncation marker (edit & retry / regenerate: messages from the start id leave the chat view); the projection's updatedAt follows the marker. */
  appendMessageTruncated(id: string, event: Omit<MessageTruncatedEvent, "type">): void {
    this.appendEvent(id, { type: "message.truncated", ...event })
  }

  /**
   * Load a session's messages (message events, oldest-first); missing stream
   * yields []. Truncation markers (edit & retry / regenerate) hide every
   * message from their start id onward — the single filter point every
   * consumer (chat view, run context assembly, compaction, memory extraction)
   * inherits. The events themselves stay in the stream: the audit page reads
   * them raw.
   */
  readMessages(id: string): Message[] {
    const events = this.readEvents(id)
    // A truncation marker only governs messages that appear BEFORE it in the
    // stream (retry messages appended after it are not bound by the old start
    // id). Walk backwards: the most recently popped marker is exactly "the
    // first truncation after this message"; a message with id >= that start
    // is discarded.
    let cutoff: string | undefined
    const out: Message[] = []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!
      if (isMessageTruncatedEvent(event)) {
        cutoff = event.fromMessageId
        continue
      }
      if (!isMessageEvent(event)) continue
      if (cutoff === undefined || event.id < cutoff) {
        const { type, ...m } = event
        out.push(m as Message)
      }
    }
    return out.reverse()
  }

  /** Append one compaction audit event. */
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

  /** Append one system audit event (每 run 一条，双段全量留痕); the projection's only effect is per-segment upserting the frozen system baseline (不推进 updatedAt)。 */
  appendSystem(id: string, event: Omit<SystemEvent, "type">): void {
    this.appendEvent(id, { type: "system", ...event })
  }

  /** Append one sandbox audit event (每 run 一条，run 装配探测后立即落盘); the projection stays untouched (不推进 updatedAt)。 */
  appendSandboxChecked(id: string, event: Omit<SandboxCheckedEvent, "type">): void {
    this.appendEvent(id, { type: "sandbox.checked", ...event })
  }

  /** Append one run-boundary audit event（run 起点/终点留痕，与消息事件夹出一轮边界）; the projection stays untouched (不推进 updatedAt)。 */
  appendRunStarted(id: string, event: Omit<RunStartedEvent, "type">): void {
    this.appendEvent(id, { type: "run.started", ...event })
  }

  /** Append one run-boundary audit event（run 终点落款；失败带 error，成功带全程用量）; the projection stays untouched (不推进 updatedAt)。 */
  appendRunEnded(id: string, event: Omit<RunEndedEvent, "type">): void {
    this.appendEvent(id, { type: "run.ended", ...event })
  }

  /** Append one permission-decision audit event（每次人工确认的裁决留痕; 中止不是裁决，不落）; the projection stays untouched (不推进 updatedAt)。 */
  appendPermissionDecided(id: string, event: Omit<PermissionDecidedEvent, "type">): void {
    this.appendEvent(id, { type: "permission.decided", ...event })
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
    // model/mode/dispositionOverride：键出现在 patch 即发 session.set 事件，
    // 值 undefined 映射为 null（= 清除）。投影只由事件推进，重建时不复活已清除的覆盖。
    if ("model" in patch || "mode" in patch || "dispositionOverride" in patch) {
      const set: SessionSetEvent = { type: "session.set", at: now }
      if ("model" in patch) set.model = patch.model ?? null
      if ("mode" in patch) set.mode = patch.mode ?? null
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