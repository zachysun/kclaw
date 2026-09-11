/**
 * Audit page model — pure functions over the session event stream. No React,
 * no fetch, no DOM: the component layer (AuditView) renders what these return.
 *
 * Row identity: every row carries `index` — the position of its source event
 * in the append-only event array — and a stable `key` (`${index}` or
 * `${index}-${blockPos}`), so expansion state and scroll anchors survive
 * incremental appends and full recomputes.
 */
import type {
  Block, CompactionEvent, MemoryEvent, MessageEvent, PermissionDecidedEvent, Role, RunEndedEvent, RunStartedEvent,
  SandboxCheckedEvent, SessionCreatedEvent, SessionDeletedEvent, SessionEvent, SessionRenamedEvent,
  SessionRestoredEvent, SessionSetEvent, SystemEvent, ToolGrantReason, Usage,
} from "../types.js"

export type SessionMetaEvent = SessionCreatedEvent | SessionRenamedEvent | SessionDeletedEvent | SessionRestoredEvent | SessionSetEvent

export type AuditRowKind = "block" | "compaction" | "memory" | "system" | "sandbox" | "session" | "run" | "decision"

/**
 * One flattened audit row. Block rows carry the owning message's role,
 * timestamp, and — on assistant messages — its usage and LLM latency
 * (`messageTail` marks the row that should DISPLAY them: the message's last
 * block). `index` is the source event's position in the event array.
 */
export type AuditRow =
  | {
    kind: "block"; key: string; index: number; role: Role; block: Block; createdAt: string
    grantedBy?: ToolGrantReason; usage?: Usage; latencyMs?: number; messageTail: boolean
  }
  | { kind: "compaction"; key: string; index: number; record: CompactionEvent; at: string }
  | { kind: "memory"; key: string; index: number; event: MemoryEvent; at: string }
  | { kind: "system"; key: string; index: number; event: SystemEvent; at: string; changed: boolean }
  | { kind: "sandbox"; key: string; index: number; event: SandboxCheckedEvent; at: string }
  | { kind: "session"; key: string; index: number; event: SessionMetaEvent; at: string }
  | { kind: "run"; key: string; index: number; event: RunStartedEvent | RunEndedEvent; at: string }
  | { kind: "decision"; key: string; index: number; event: PermissionDecidedEvent; at: string }

/**
 * Flatten the event stream into rows, one per rendered event. Message events
 * flatten into one row per block (authored order). Tool rows carry the grant
 * reason for their callId, joined from tool message events' message-level
 * `grantedBy` maps. System rows carry `changed` — whether the text differs
 * from the previous system row in stream order (first one never changes).
 * Session metadata events (created/renamed/deleted/restored/set) become
 * lightweight "会话" rows: behavior changes leave visible traces. The stream
 * is append-only and time-ordered, so rows emit in event-array order.
 */
export function flattenAudit(events: SessionEvent[]): AuditRow[] {
  const rows: AuditRow[] = []
  const ctx = { lastSystemText: null as string | null }
  const grantByCallId = collectGrantReasons(events)
  events.forEach((event, index) => flattenEventInto(rows, event, index, grantByCallId, ctx))
  return rows
}

/**
 * Incremental counterpart to flattenAudit for live appends: flatten only the
 * freshly appended slice (`baseIndex` = its first event's array index) and
 * continue the existing row list. Equivalent to re-flattening the whole
 * stream — guarded by an equivalence test. Two cross-batch seams are handled
 * explicitly: grant reasons arriving in the slice backfill tool rows from
 * EARLIER batches (the tool message event lands after the tool_call block it
 * explains), and the system `changed` marker seeds from the last system row
 * already in `rows`.
 */
export function appendRows(rows: AuditRow[], baseIndex: number, fresh: SessionEvent[]): AuditRow[] {
  if (fresh.length === 0) return rows
  const grantByCallId = collectGrantReasons(fresh)

  // Backfill: a grant reason in this slice may explain a tool block flattened
  // by an earlier batch.
  const backfilled = rows.map((row) => {
    if (
      row.kind !== "block" || row.grantedBy !== undefined ||
      (row.block.type !== "tool_call" && row.block.type !== "tool_result")
    ) return row
    const reason = grantByCallId.get(row.block.callId)
    return reason === undefined ? row : { ...row, grantedBy: reason }
  })

  let lastSystemText: string | null = null
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.kind === "system") {
      lastSystemText = row.event.text
      break
    }
  }
  const ctx = { lastSystemText }
  fresh.forEach((event, offset) => flattenEventInto(backfilled, event, baseIndex + offset, grantByCallId, ctx))
  return backfilled
}

/** callId → grant reason from every tool message event's grantedBy map. */
function collectGrantReasons(events: SessionEvent[]): Map<string, ToolGrantReason> {
  // MessageEvent is a Message superset without per-role fields, so the
  // role-conditional grantedBy narrows by cast.
  const map = new Map<string, ToolGrantReason>()
  for (const event of events) {
    if (event.type !== "message" || event.role !== "tool") continue
    const granted = (event as MessageEvent & { grantedBy?: Record<string, ToolGrantReason> }).grantedBy
    if (granted === undefined) continue
    for (const [callId, reason] of Object.entries(granted)) map.set(callId, reason)
  }
  return map
}

/** Flatten ONE event at array position `index`, appending its row(s). */
function flattenEventInto(
  rows: AuditRow[], event: SessionEvent, index: number,
  grantByCallId: Map<string, ToolGrantReason>, ctx: { lastSystemText: string | null },
): void {
  switch (event.type) {
    case "message": {
      const msg = event as MessageEvent & { usage?: Usage; latencyMs?: number }
      const isAssistant = msg.role === "assistant"
      const usage = isAssistant ? msg.usage : undefined
      const latencyMs = isAssistant ? msg.latencyMs : undefined
      const last = msg.blocks.length - 1
      msg.blocks.forEach((block, i) => {
        const row: AuditRow = {
          kind: "block",
          key: `${index}-${i}`,
          index,
          role: msg.role,
          block,
          createdAt: msg.createdAt,
          messageTail: i === last,
        }
        if (isAssistant) {
          row.usage = usage
          row.latencyMs = latencyMs
        }
        if (block.type === "tool_call" || block.type === "tool_result") {
          const reason = grantByCallId.get(block.callId)
          if (reason !== undefined) row.grantedBy = reason
        }
        rows.push(row)
      })
      break
    }
    case "compaction":
      rows.push({ kind: "compaction", key: `${index}`, index, record: event, at: event.at })
      break
    case "memory":
      rows.push({ kind: "memory", key: `${index}`, index, event, at: event.at })
      break
    case "system": {
      rows.push({
        kind: "system",
        key: `${index}`,
        index,
        event,
        at: event.at,
        changed: ctx.lastSystemText !== null && ctx.lastSystemText !== event.text,
      })
      ctx.lastSystemText = event.text
      break
    }
    case "sandbox.checked":
      rows.push({ kind: "sandbox", key: `${index}`, index, event, at: event.at })
      break
    case "run.started":
    case "run.ended":
      rows.push({ kind: "run", key: `${index}`, index, event, at: event.at })
      break
    case "permission.decided":
      rows.push({ kind: "decision", key: `${index}`, index, event, at: event.at })
      break
    case "session.created":
    case "session.renamed":
    case "session.deleted":
    case "session.restored":
    case "session.set":
      rows.push({ kind: "session", key: `${index}`, index, event, at: event.at })
      break
    default: {
      // Compile-time exhaustiveness sentinel: a new SessionEvent member
      // fails this assignment instead of silently vanishing from the audit.
      const unhandled: never = event
      void unhandled
      break
    }
  }
}

// ---------- 过滤 ----------

export type TimePreset = "all" | "1h" | "today" | "custom"

/** The six row-type toggles + keyword + time range, combined with AND: a row
 *  is visible only when its kind is on, its full text contains the keyword,
 *  and its timestamp falls in the time window. */
export interface AuditFilter {
  kinds: Record<AuditRowKind, boolean>
  keyword: string
  timePreset: TimePreset
  /** custom-preset bounds, ISO or "" (= unbounded); inclusive on both ends. */
  timeFrom: string
  timeTo: string
}

export const ALL_KINDS: AuditRowKind[] = ["block", "compaction", "memory", "system", "sandbox", "session", "run", "decision"]

export const DEFAULT_FILTER: AuditFilter = {
  kinds: { block: true, compaction: true, memory: true, system: true, sandbox: true, session: true, run: true, decision: true },
  keyword: "",
  timePreset: "all",
  timeFrom: "",
  timeTo: "",
}

/** The row's display timestamp (block rows use the owning message's createdAt). */
export function rowTime(row: AuditRow): string {
  return row.kind === "block" ? row.createdAt : row.at
}

/** 1h preset cutoff and custom bounds compare on parse time; an unparseable row time passes the filter (never silently swallow rows). */
function timeMatches(row: AuditRow, f: AuditFilter, now: Date): boolean {
  if (f.timePreset === "all") return true
  const t = Date.parse(rowTime(row))
  if (Number.isNaN(t)) return true
  if (f.timePreset === "1h") return t >= now.getTime() - 3_600_000
  if (f.timePreset === "today") {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return t >= start.getTime()
  }
  const from = f.timeFrom === "" ? -Infinity : Date.parse(f.timeFrom)
  const to = f.timeTo === "" ? Infinity : Date.parse(f.timeTo)
  return t >= (Number.isNaN(from) ? -Infinity : from) && t <= (Number.isNaN(to) ? Infinity : to)
}

/** Everything the keyword filter matches against — FULL content, not the truncated summary. */
export function rowSearchText(row: AuditRow): string {
  switch (row.kind) {
    case "block": {
      const body = row.block.type === "attachment" ? JSON.stringify(row.block.source) : blockFullContent(row.block)
      return `${row.role} ${body}`
    }
    case "compaction":
      return `${row.record.trigger} ${row.record.focus ?? ""} ${row.record.segmentSummary} ${row.record.top}`
    case "memory":
      return memoryFullContent(row.event)
    case "system":
      return row.event.text
    case "sandbox":
      return `${sandboxSummary(row.event)} ${sandboxFullContent(row.event)}`
    case "session":
      return sessionSummary(row.event)
    case "run":
      return runSummary(row.event)
    case "decision":
      return `${decisionSummary(row.event)} ${decisionFullContent(row.event)}`
  }
}

/** Blank keyword matches everything; otherwise a case-insensitive substring
 *  test over the row's full text. */
function keywordMatches(row: AuditRow, f: AuditFilter): boolean {
  const needle = f.keyword.trim().toLowerCase()
  return needle === "" || rowSearchText(row).toLowerCase().includes(needle)
}

export function rowMatchesFilter(row: AuditRow, f: AuditFilter, now: Date): boolean {
  return f.kinds[row.kind] === true && keywordMatches(row, f) && timeMatches(row, f, now)
}

export function filterRows(rows: AuditRow[], f: AuditFilter, now: Date): AuditRow[] {
  return rows.filter((row) => rowMatchesFilter(row, f, now))
}

// ---------- 跳转锚点 ----------

/**
 * The nearest candidate strictly after (dir=1) / before (dir=-1) `from`,
 * wrapping around like an editor search; null when there is no candidate.
 */
export function jumpTarget(candidates: number[], from: number, dir: 1 | -1): number | null {
  if (candidates.length === 0) return null
  if (dir === 1) {
    return candidates.find((c) => c > from) ?? candidates[0]!
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i]! < from) return candidates[i]!
  }
  return candidates[candidates.length - 1]!
}

// ---------- 增量合并 ----------

/** Append the `?since=` slice to the loaded stream (append-only; caller passes since = existing.length). */
export function appendEvents(existing: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  return incoming.length === 0 ? existing : [...existing, ...incoming]
}

// ---------- 格式化 ----------

/** 450ms / 2.3s / 1m04s */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) {
    const s = ms / 1000
    return `${s >= 10 ? Math.round(s) : s.toFixed(1)}s`
  }
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${String(s).padStart(2, "0")}s`
}

/** 入 1,234 · 出 567 */
export function fmtUsage(u: Usage): string {
  return `入 ${u.inputTokens.toLocaleString()} · 出 ${u.outputTokens.toLocaleString()}`
}

/** Today → HH:MM:SS; otherwise MM-DD HH:MM (local time). */
export function fmtRowTime(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, "0")
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------- 行摘要与全文（组件层渲染用） ----------

/** One-line memory summary: 记忆 · trigger · kind · op · (topic) · (file). */
export function memorySummary(event: MemoryEvent): string {
  let s = `记忆 · ${event.trigger} · ${event.kind} · ${event.op}`
  if (event.topic !== undefined) s += ` · ${event.topic}`
  if (event.file !== undefined) s += ` · ${event.file}`
  return s
}

/** Full memory payload on expand (present fields only). */
export function memoryFullContent(event: MemoryEvent): string {
  const lines = [`trigger: ${event.trigger}`, `kind: ${event.kind}`, `op: ${event.op}`]
  if (event.topic !== undefined) lines.push(`topic: ${event.topic}`)
  if (event.file !== undefined) lines.push(`file: ${event.file}`)
  if (event.scope !== undefined) lines.push(`scope: ${event.scope}`)
  if (event.source !== undefined) lines.push(`source: ${event.source}`)
  return lines.join("\n")
}

/** One-line sandbox summary: 可用 / 不可用（原因）/ 已关闭. */
export function sandboxSummary(event: SandboxCheckedEvent): string {
  if (!event.enabled) return "已关闭（配置未启用）"
  if (!event.available) return `不可用${event.unavailableReason !== undefined ? `（${event.unavailableReason}）` : ""}`
  return "可用"
}

/** Full sandbox audit payload on expand. */
export function sandboxFullContent(event: SandboxCheckedEvent): string {
  const lines = [`enabled: ${event.enabled}`, `available: ${event.available}`]
  if (event.unavailableReason !== undefined) lines.push(`unavailableReason: ${event.unavailableReason}`)
  return lines.join("\n")
}

/** One-line run-boundary summary: 运行开始 · trigger / 运行结束 · stopReason（+用量或失败原因）. */
export function runSummary(event: RunStartedEvent | RunEndedEvent): string {
  if (event.type === "run.started") return `运行开始 · ${event.trigger}`
  let s = `运行结束 · ${event.stopReason}`
  if (event.error !== undefined) s += ` · ${event.error.code}: ${event.error.message}`
  else if (event.usage !== undefined) s += ` · ${fmtUsage(event.usage)}`
  return s
}

/** One-line permission-decision summary: 权限 · 裁决 · 谁批的 · 工具名. */
export function decisionSummary(event: PermissionDecidedEvent): string {
  const verdict =
    event.decision === "once" ? "批准（仅本次）"
    : event.decision === "project" ? "批准（本项目）"
    : event.decision === "global" ? "批准（全局）"
    : event.decision === "reject" ? "拒绝"
    : "超时"
  return `权限 · ${verdict} · ${event.by} · ${event.tool.name}`
}

/** Full permission-decision payload on expand. */
export function decisionFullContent(event: PermissionDecidedEvent): string {
  return [
    `decision: ${event.decision}`,
    `by: ${event.by}`,
    `tool: ${event.tool.name}`,
    `callId: ${event.tool.callId}`,
    `argsJson: ${event.tool.argsJson}`,
    `confirmationId: ${event.confirmationId}`,
  ].join("\n")
}

/** One-line session metadata summary, per event kind. */
export function sessionSummary(event: SessionMetaEvent): string {
  switch (event.type) {
    case "session.created": {
      const bits = [`创建 · ${event.title}`]
      if (event.mode !== undefined) bits.push(`模式 ${event.mode}`)
      if (event.workdir !== undefined) bits.push(event.workdir)
      return bits.join(" · ")
    }
    case "session.renamed":
      return `改名 · ${event.title}`
    case "session.deleted":
      return "移入回收站"
    case "session.restored":
      return "从回收站还原"
    case "session.set": {
      const bits: string[] = ["参数"]
      if (event.model !== undefined) bits.push(`模型 ${event.model === null ? "（恢复默认）" : event.model}`)
      if (event.mode !== undefined) bits.push(`模式 ${event.mode === null ? "（清除）" : event.mode}`)
      if (event.disposition !== undefined) bits.push(`排队 ${event.disposition === null ? "（清除）" : event.disposition}`)
      if (event.readonly === true) bits.push("只读")
      return bits.join(" · ")
    }
  }
}

/** Full session metadata payload on expand (present fields only). */
export function sessionFullContent(event: SessionMetaEvent): string {
  const lines: string[] = [`type: ${event.type}`, `at: ${event.at}`]
  if (event.type === "session.created" || event.type === "session.renamed") lines.push(`title: ${event.title}`)
  if (event.type === "session.created") {
    if (event.mode !== undefined) lines.push(`mode: ${event.mode}`)
    if (event.workdir !== undefined) lines.push(`workdir: ${event.workdir}`)
    if (event.jobId !== undefined) lines.push(`jobId: ${event.jobId}`)
  }
  if (event.type === "session.set") {
    if (event.model !== undefined) lines.push(`model: ${String(event.model)}`)
    if (event.mode !== undefined) lines.push(`mode: ${String(event.mode)}`)
    if (event.disposition !== undefined) lines.push(`disposition: ${String(event.disposition)}`)
    if (event.readonly !== undefined) lines.push(`readonly: ${String(event.readonly)}`)
  }
  return lines.join("\n")
}

/** Whitespace-collapsed, first-N-chars summary. */
export function summarize(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * Whether a bus frame is the store's persist notice (`session.appended`) —
 * the one frame the audit page answers with an incremental re-pull.
 * Agent-event frames carry a payload; command acks and error frames do not.
 */
export function isAppendedFrame(frame: unknown): boolean {
  if (typeof frame !== "object" || frame === null || !("payload" in frame)) return false
  return (frame as { type?: unknown }).type === "session.appended"
}

export function blockTypeLabel(block: Block): string {
  switch (block.type) {
    case "text":
      return "text"
    case "thinking":
      return "thinking"
    case "tool_call":
      return "tool_call"
    case "tool_result":
      return "tool_result"
    case "note":
      return `note:${block.kind}` // 具体类型可见（job/memory/system/timeout/denied），审计页不用展开就能分辨来源
    case "attachment":
      return "attachment"
  }
}

export function blockSummary(block: Block): string {
  switch (block.type) {
    case "text":
    case "thinking":
      return summarize(block.text)
    case "tool_call":
      return `${block.name} ${summarize(block.argsJson)}`
    case "tool_result":
      return summarize(block.output)
    case "note":
      return summarize(block.text)
    case "attachment":
      return block.mimeType
  }
}

export function blockFullContent(block: Block): string {
  switch (block.type) {
    case "text":
    case "thinking":
    case "note":
      return block.text
    case "tool_call":
      return block.argsJson
    case "tool_result":
      return block.output
    case "attachment":
      return JSON.stringify(block.source, null, 2)
  }
}
