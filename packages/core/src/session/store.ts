import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { newId } from "../protocol/ids.js"
import type { Message } from "../protocol/messages.js"
import type { CompactionRecord, CompactionState } from "./compaction.js"
import { writeFileAtomic } from "../storage/atomic.js"
import { appendJsonlLine, readJsonl, readJsonlFrom } from "../storage/jsonl.js"
import { applyEvent, isCompactionEvent, isMessageEvent, isMessageTruncatedEvent } from "./events.js"
import { chainGenesis, lineDigest, stripChainField, verifyEventChain } from "./integrity.js"
import type { ChainMetaAnchor, ChainVerifyResult } from "./integrity.js"
import type { MessageTruncatedEvent, PermissionDecidedEvent, RunEndedEvent, RunStartedEvent, SandboxCheckedEvent, SessionCreatedEvent, SessionEvent, SessionSetEvent, SystemEvent, TeamAuditEvent } from "./events.js"
import type { GoalCheckedEvent, GoalClearedEvent, GoalSetEvent, TodoWrittenEvent } from "./events.js"
import type { GoalSnapshot } from "../goal/types.js"
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
  cronId?: string
  workdir?: string
  /**
   * 父会话（subagent 派生关系）：设置即子会话。子会话不出现在默认会话列表、
   * 不进记忆提取扫描，token 用量归组到父会话名下；完整轨迹仍按 id 可查（审计）。
   */
  parentSessionId?: string
  /**
   * fork 血缘（session.forked 事件投影，单边：只有 fork 出的新会话带）。
   * sessionId = 来源会话，messageId = 用户所点的语义分叉点（未归一化；
   * 实际复制区间到该消息所属 run 的结束处，见 session/fork.ts）。fork 出的
   * 会话是完全独立的普通会话：删除互不级联，与 subagent 的 parentSessionId
   * 语义无关。
   */
  forkedFrom?: { sessionId: string; /** 用户所点的分叉点消息；不带 messageId 且流内无消息时省略。 */ messageId?: string }
  /** 会话级 todo 清单（todo.written 事件投影，后写胜出；模型自组织草稿，见 tools/todo.ts）。 */
  todo?: import("../protocol/session-events.js").TodoItem[]
  /** Per-session model override (empty/absent → daemon default). */
  model?: string
  /** Session permission mode (absent → "default"). */
  mode?: PermissionMode
  deleted?: boolean
  deletedAt?: string
  /** Layered compaction state, maintained by compaction events. */
  compaction?: CompactionState
  /**
   * 冻结的系统提示词基线（提示词缓存纪律），双段独立冻结：stable（人设基础文本
   * + 注入约定）在前不变，live（认知 + 技能清单）变化即时生效——前缀缓存按
   * 从头逐字节相同匹配，live 变化只失效变化点之后。段级 frozenAt 记录该段
   * 文本成为基线的时刻。下一次压缩清除此字段后随首个 system 审计事件重新
   * 固化（基线重置点=缓存冷启动，零额外成本）。
   * 投影由事件推进：system 事件逐段 upsert、compaction 事件清除——事件流是权威数据。
   */
  systemBaseline?: { stable: { text: string; frozenAt: string }; live?: { text: string; frozenAt: string } }
  /** 会话级处置覆盖（/steer /wait、Web 三选）：优先于 sessions.defaultDisposition。 */
  dispositionOverride?: "steer" | "wait" | "interrupt"
  /**
   * 事件流哈希链锚定（integrity.ts）：chainHead = 最新一行原文的 SHA-256，
   * chainLength = 文件总行数（含未起链的旧前缀）。写入路径维护；崩溃窗口
   * 允许落后一行（事件已写、meta 未写），verify 容忍并随下次追加自愈。
   */
  chainHead?: string
  chainLength?: number
  /**
   * 会话级目标快照（issue #47 /goal）：goal.set 事件全量替换、goal.cleared
   * 删除——以事件流为权威数据，投影只跟随。终态（complete）后仍保留在 meta 里
   * 供展示，直到用户 clear。进程内的自续开关（armed）不持久化：重启后目标
   * 还在但不会自动续跑（ADR-0002）。
   */
  goal?: GoalSnapshot
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
    // 链真相源是文件末行原文（不是 meta.chainHead——崩溃窗口里事件已写、
    // meta 未写，末行才是已生效的历史）；末行无 $prev（未起链的旧会话）或
    // 空文件 → 新链从创世起。
    const prev = this.nextChainPrev(id)
    appendJsonlLine(this.eventsPath(id), { ...event, $prev: prev })
    const at = this.eventAt(event)
    const base: SessionMeta = current ?? { id, title: "", createdAt: at, updatedAt: at }
    const projection = applyEvent(base, event)
    // 链字段：追加完成后按磁盘原文回填（appendJsonlLine 可能修复撕裂尾，
    // 行数以修复后的文件为准）
    const { head, length } = this.chainTail(id)
    projection.chainHead = head
    projection.chainLength = length
    this.writeMeta(projection)
    if (this.onAppended !== undefined) {
      try {
        this.onAppended(id, event)
      } catch {
        // A listener failure is not a write failure: event and projection are already durable.
      }
    }
  }

  /** 新一行的 $prev：末行原文摘要（续链）或创世（空文件/旧会话首条）。 */
  private nextChainPrev(id: string): string {
    const lines = this.readChainLines(id)
    const last = lines[lines.length - 1]
    if (last === undefined) return chainGenesis(id)
    try {
      if ("$prev" in (JSON.parse(last) as object)) return lineDigest(last)
    } catch { /* 撕裂行：将被修复砍掉，视为无末行 */ }
    return chainGenesis(id)
  }

  /** 修复后文件的链尾事实：末行摘要与总行数（无文件 → 创世与 0）。 */
  private chainTail(id: string): { head: string; length: number } {
    const lines = this.readChainLines(id)
    if (lines.length === 0) return { head: chainGenesis(id), length: 0 }
    return { head: lineDigest(lines[lines.length - 1]!), length: lines.length }
  }

  /**
   * 事件文件的完整行（原文文本）。撕裂尾规范化与 appendJsonlLine 的修复
   * 语义一致：不以换行结尾的末行视为崩溃残迹、丢弃。
   */
  private readChainLines(id: string): string[] {
    let raw: string
    try {
      raw = readFileSync(this.eventsPath(id), "utf8")
    } catch {
      return []
    }
    if (raw === "") return []
    // 到最后一个换行（含）为止：撕裂尾随之丢弃，与 appendJsonlLine 的修复语义一致
    const body = raw.slice(0, raw.lastIndexOf("\n") + 1)
    return body === "" ? [] : body.slice(0, -1).split("\n")
  }

  /** Load a session's event stream oldest-first; missing file yields []. `$prev` 链字段在读取边界剥离（不进领域模型）。 */
  readEvents(id: string): SessionEvent[] {
    return (readJsonl(this.eventsPath(id)) as unknown[]).map((v) => stripChainField<SessionEvent>(v))
  }

  /** Tail read for incremental pulls: the events at indexes >= since, with
   *  the skipped prefix neither parsed nor materialized. `$prev` 同样剥离。 */
  readEventsFrom(id: string, since: number): SessionEvent[] {
    return (readJsonlFrom(this.eventsPath(id), since) as unknown[]).map((v) => stripChainField<SessionEvent>(v))
  }

  /**
   * fork 支持：把一段事件原文一次性写进新会话的 events.jsonl。与 appendEvent
   * 的区别：不折叠投影、不触发 onAppended——复制段不产生总线帧、不喂搜索
   * 索引（重复归属防线，见 session/fork.ts）；投影由调用方随后 rebuildMeta
   * 建立。仅供刚建目录、尚无事件的会话使用。
   */
  writeEventsRaw(id: string, events: SessionEvent[]): void {
    mkdirSync(this.sessionDir(id), { recursive: true })
    // 只许写入尚无事件的会话（fork 建新流用）：append-only 的历史一旦整文件
    // 覆盖就无从恢复，误用必须当场炸出来。
    const target = this.eventsPath(id)
    if (existsSync(target) && statSync(target).size > 0) throw new Error(`writeEventsRaw: event stream already exists: ${id}`)
    // 建新流即建新链：创世绑定本会话 id，逐行续接（复制段是重链化的独立
    // 流，不是源流的延续——源流在源会话里自有链）。
    let prev = chainGenesis(id)
    const lines = events.map((e) => {
      const line = JSON.stringify({ ...e, $prev: prev })
      prev = lineDigest(line)
      return line
    })
    writeFileAtomic(target, lines.join("\n") + (lines.length > 0 ? "\n" : ""))
  }

  /** Rebuild the meta projection from the full event stream and write it back;
   *  undefined when the session has no events (does not exist). 链锚字段按
   *  事件文件原文重算（重建的 meta 与流对齐，不是投影事件能推出的）。 */
  rebuildMeta(id: string): SessionMeta | undefined {
    const events = this.readEvents(id)
    if (events.length === 0) return undefined
    const first = events[0]!
    const at = first.type === "message" ? first.createdAt : first.at
    const meta = events.reduce(applyEvent, { id, title: "", createdAt: at, updatedAt: at })
    const { head, length } = this.chainTail(id)
    meta.chainHead = head
    meta.chainLength = length
    this.writeMeta(meta)
    return meta
  }

  /** 校验本会话事件流的哈希链（integrity.ts 纯函数的 IO 组装）。 */
  verifyChain(id: string): ChainVerifyResult {
    let meta: ChainMetaAnchor | null = null
    try {
      meta = JSON.parse(readFileSync(this.metaPath(id), "utf8")) as ChainMetaAnchor
    } catch {
      meta = null
    }
    let raw = ""
    try {
      raw = readFileSync(this.eventsPath(id), "utf8")
    } catch {
      return { status: "not-chained", checked: 0, reason: "事件流不存在" }
    }
    return verifyEventChain(raw, meta, id)
  }

  /**
   * Create a new session directory: append a session.created event, return
   * its projected meta. The initial permission mode is frozen at creation
   * (the daemon's config default; absent → "default"), so meta.mode always
   * carries a real value and later config changes only affect NEW sessions.
   */
  create(title?: string, cronId?: string, workdir?: string, mode: PermissionMode = "default", parentSessionId?: string): SessionMeta {
    const id = newId("ses")
    const now = new Date().toISOString()
    const event: SessionCreatedEvent = { type: "session.created", at: now, title: title ?? "新会话", mode }
    if (cronId !== undefined) event.cronId = cronId
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

  /** Non-deleted sessions of one cron, newest-updated first (cron-history queries). */
  listByCron(cronId: string): SessionMeta[] {
    return this.list().filter((m) => m.cronId === cronId)
  }

  /** Every session projection including the recycle bin (workdir-union consumers, the purge cascade). */
  allMetas(): SessionMeta[] {
    return [...this.list(), ...this.list({ deleted: true })]
  }

  /** Sessions (recycle-bin view included) spawned by `parentSessionId`, for the delete/purge cascade. */
  listByParent(parentSessionId: string): SessionMeta[] {
    return this.allMetas().filter((m) => m.parentSessionId === parentSessionId)
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

  /** Append one system audit event (每 run 一条，双段全量记录); the projection's only effect is per-segment upserting the frozen system baseline (不推进 updatedAt)。 */
  appendSystem(id: string, event: Omit<SystemEvent, "type">): void {
    this.appendEvent(id, { type: "system", ...event })
  }

  /** Append one sandbox audit event (每 run 一条，run 组装时检测沙箱后立即写入); the projection stays untouched (不推进 updatedAt)。 */
  appendSandboxChecked(id: string, event: Omit<SandboxCheckedEvent, "type">): void {
    this.appendEvent(id, { type: "sandbox.checked", ...event })
  }

  /** Append one run-boundary audit event（run 起点/终点记录，与消息事件夹出一轮边界）; the projection stays untouched (不推进 updatedAt)。 */
  appendRunStarted(id: string, event: Omit<RunStartedEvent, "type">): void {
    this.appendEvent(id, { type: "run.started", ...event })
  }

  /** Append one run-boundary audit event（run 终点记录；失败带 error，成功带全程用量）; the projection stays untouched (不推进 updatedAt)。 */
  appendRunEnded(id: string, event: Omit<RunEndedEvent, "type">): void {
    this.appendEvent(id, { type: "run.ended", ...event })
  }

  /** Append one permission-decision audit event（每次人工确认的裁决记录; 中止不是裁决，不落）; the projection stays untouched (不推进 updatedAt)。 */
  appendPermissionDecided(id: string, event: Omit<PermissionDecidedEvent, "type">): void {
    this.appendEvent(id, { type: "permission.decided", ...event })
  }

  /** Append one team audit event（team/* 族：真相在团队目录，事件只记录）; the projection stays untouched (不推进 updatedAt)。 */
  appendTeamAudit(id: string, event: TeamAuditEvent): void {
    this.appendEvent(id, event)
  }

  /** Append one goal snapshot mutation（goal.set：快照全量替换进投影，推进 updatedAt）。 */
  appendGoalSet(id: string, event: Omit<GoalSetEvent, "type">): void {
    this.appendEvent(id, { type: "goal.set", ...event })
  }

  /** Append one goal removal（goal.cleared：投影删除 goal，推进 updatedAt）。 */
  appendGoalCleared(id: string, event: Omit<GoalClearedEvent, "type">): void {
    this.appendEvent(id, { type: "goal.cleared", ...event })
  }

  /** Append one goal-check audit event（每轮判定至多一条；验收输出+裁决或失败）; the projection stays untouched (不推进 updatedAt)。 */
  appendGoalChecked(id: string, event: Omit<GoalCheckedEvent, "type">): void {
    this.appendEvent(id, { type: "goal.checked", ...event })
  }

  /** Append one todo snapshot write（全量替换，后写胜出；投影 todo，不推进 updatedAt）。 */
  appendTodoWritten(id: string, event: Omit<TodoWrittenEvent, "type">): void {
    this.appendEvent(id, { type: "todo.written", ...event })
  }

  /** Read a session's persisted message queue (queue.jsonl), oldest-first; a missing/empty file yields []. */
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
   * Merge `patch` into the session. Metadata fields (title/model/mode/
   * dispositionOverride/deleted/deletedAt) become session.* events, appended
   * to the stream before the projection is rewritten — model/mode/
   * dispositionOverride are fully event-driven: setting OR clearing emits a
   * `session.set` event (patch 值 undefined → 事件里 null = 清除)。compaction
   * is projection-maintained by the compaction event, never merged here.
   * Returns the newest projection.
   */
  updateMeta(id: string, patch: Partial<SessionMeta>, opts: { renameSource?: "auto" | "manual" } = {}): SessionMeta {
    const current = this.meta(id)
    if (current === undefined) throw new Error(`session not found: ${id}`)
    const now = new Date().toISOString()

    // 元数据字段 → 事件（仅当有确定的新值且确实发生变化）
    const events: SessionEvent[] = []
    if (patch.title !== undefined && patch.title !== current.title) {
      events.push({ type: "session.renamed", at: now, title: patch.title, source: opts.renameSource ?? "manual" })
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

    // 事件优先：逐条写入事件并折进投影
    let projection = current
    for (const event of events) {
      this.appendEvent(id, event)
      projection = applyEvent(projection, event)
    }

    // 显式清除 deleted 时投影不保留 deleted/deletedAt 键
    if ("deleted" in patch && patch.deleted !== true) {
      delete projection.deleted
      delete projection.deletedAt
    }

    // 链锚字段不属于投影事件，本地 projection 上没有——从磁盘取回（appendEvent
    // 循环里已维护），避免这次整体重写把它们抹掉
    const disk = this.meta(id)
    if (disk?.chainHead !== undefined) {
      projection.chainHead = disk.chainHead
      projection.chainLength = disk.chainLength
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