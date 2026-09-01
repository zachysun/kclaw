/**
 * AuditView — the trail page (轨迹页). Single source of truth is the session's
 * event stream, read through GET /sessions (the session dropdown) and
 * GET /sessions/:id/events (the trail itself). The stream is append-only and
 * time-ordered (session.created → message → compaction → memory …), so it is
 * rendered in array order — oldest at the top, newest at the bottom, like a
 * log. Message events carry the full Message payload and flatten into one row
 * per block; compaction events become "压缩" rows; memory events become "记忆"
 * rows; the session metadata events (session.created/renamed/…) are skipped.
 * Each row shows a type label plus a one-line summary, and expands on click
 * to the full payload. No mutation, no /audit — the old audit tail route is
 * gone.
 */
import { useEffect, useState } from "react"
import { type ApiClient } from "../api.js"
import type { Block, CompactionEvent, MemoryEvent, MessageEvent, Role, SessionEvent, SessionMeta, ToolGrantReason } from "../types.js"

/**
 * One flattened trail row: either a message block (carrying the owning
 * message's role + timestamp, and for tool rows the grant reason), a
 * compaction event (carrying its own `at` timestamp), or a memory event.
 */
type TrailRow =
  | { kind: "block"; key: string; role: Role; block: Block; createdAt: string; grantedBy?: ToolGrantReason }
  | { kind: "compaction"; key: string; record: CompactionEvent; at: string }
  | { kind: "memory"; key: string; event: MemoryEvent }

export function AuditView({ api }: { api: ApiClient }) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [selectedId, setSelectedId] = useState<string>("")
  const [events, setEvents] = useState<SessionEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  // Session dropdown on mount.
  useEffect(() => {
    let cancelled = false
    api
      .get<SessionMeta[]>("/sessions")
      .then((metas) => {
        if (cancelled) return
        setSessions(metas)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setSessions([])
        setError(err instanceof Error ? err.message : "加载会话失败")
      })
    return () => {
      cancelled = true
    }
  }, [api])

  // Pull the selected session's full event stream (none until a session is
  // chosen). The stream is the single source of truth for the trail — no
  // separate /messages + /compactions fetches anymore.
  useEffect(() => {
    if (selectedId === "") {
      setEvents(null)
      return
    }
    let cancelled = false
    setEvents(null)
    setError(null)
    api
      .get<SessionEvent[]>(`/sessions/${encodeURIComponent(selectedId)}/events`)
      .then((evts) => {
        if (cancelled) return
        setEvents(evts)
      })
      .catch((err) => {
        if (cancelled) return
        setEvents([])
        setError(err instanceof Error ? err.message : "加载轨迹失败")
      })
    return () => {
      cancelled = true
    }
  }, [api, selectedId])

  const rows = flattenTrail(events)

  return (
    <div className="audit-view" data-testid="audit-view">
      <div className="view-head">
        <h2 className="view-title">轨迹</h2>
      </div>
      <div className="trail-filter">
        <label htmlFor="trail-session">会话</label>
        <select
          id="trail-session"
          data-testid="trail-session-select"
          value={selectedId}
          onChange={(event) => {
            setSelectedId(event.target.value)
            setExpandedKey(null)
          }}
        >
          <option value="">选择会话…</option>
          {(sessions ?? []).map((session) => (
            <option key={session.id} value={session.id}>
              {session.title}
            </option>
          ))}
        </select>
      </div>
      {error !== null && (
        <div className="form-error" role="alert" data-testid="trail-error">
          {error}
        </div>
      )}
      {rows.length === 0 ? (
        <p className="muted table-empty" data-testid="trail-empty">
          暂无轨迹
        </p>
      ) : (
        <ul className="trail-list" data-testid="trail-list">
          {rows.map((row) => {
            const isExpanded = expandedKey === row.key
            const toggle = () => setExpandedKey((key) => (key === row.key ? null : row.key))
            switch (row.kind) {
              case "compaction":
                return (
                  <li key={row.key} className="trail-row-item">
                    <button
                      type="button"
                      className="trail-row"
                      data-testid={`compaction-row-${row.key}`}
                      onClick={toggle}
                    >
                      <span className="trail-type">压缩</span>
                      <span className="trail-summary">
                        {row.record.trigger === "manual"
                          ? `手动${row.record.focus ? `（${row.record.focus}）` : ""}`
                          : row.record.trigger === "in-run"
                            ? "自动（运行中）"
                            : "自动（收尾）"}
                        {row.record.emergency === true ? "·超限急救" : ""}
                        {` · ${row.record.from ?? "会话开头"} – ${row.record.upto} · ${row.record.messages} 条`}
                      </span>
                      <span className="trail-meta muted">{new Date(row.at).toLocaleString()}</span>
                    </button>
                    {isExpanded && (
                      <pre className="trail-full" data-testid={`compaction-full-${row.key}`}>
                        {`段摘要：\n${row.record.segmentSummary}\n\n总摘要：\n${row.record.top}`}
                      </pre>
                    )}
                  </li>
                )
              case "memory":
                return (
                  <li key={row.key} className="trail-row-item">
                    <button
                      type="button"
                      className="trail-row"
                      data-testid={`memory-row-${row.key}`}
                      onClick={toggle}
                    >
                      <span className="trail-type">记忆</span>
                      <span className="trail-summary">{memorySummary(row.event)}</span>
                      <span className="trail-meta muted">{new Date(row.event.at).toLocaleString()}</span>
                    </button>
                    {isExpanded && (
                      <pre className="trail-full" data-testid={`memory-full-${row.key}`}>
                        {memoryFullContent(row.event)}
                      </pre>
                    )}
                  </li>
                )
              default:
                return (
                  <li key={row.key} className="trail-row-item">
                    <button
                      type="button"
                      className="trail-row"
                      data-testid={`trail-row-${row.key}`}
                      onClick={toggle}
                    >
                      <span className="trail-type">{blockTypeLabel(row.block)}</span>
                      <span className="trail-summary">{blockSummary(row.block)}</span>
                      <span className="trail-meta muted">
                        {row.role} · {row.createdAt}
                      </span>
                      {row.grantedBy !== undefined && (
                        <span className="trail-grant" data-testid={`trail-grant-${row.key}`}>
                          放行: {row.grantedBy}
                        </span>
                      )}
                    </button>
                    {isExpanded && (
                      <pre className="trail-full" data-testid={`trail-full-${row.key}`}>
                        {blockFullContent(row.block)}
                      </pre>
                    )}
                  </li>
                )
            }
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Flatten the event stream into one row per rendered event. Message events
 * flatten into one row per block; blocks within a message keep their authored
 * order. Tool rows (tool_call/tool_result) carry the grant reason for their
 * callId, resolved from the tool message events' message-level `grantedBy`
 * maps (a tool_call lives on an assistant message, its tool_result + grantedBy
 * on the matching tool message — so we join by callId). Compaction and memory
 * events become rows of their own. The stream is append-only and time-ordered,
 * so rows are emitted in event-array order — no timestamp re-sort needed.
 * Session metadata events (session.created/renamed/deleted/restored/set) are
 * intentionally skipped: the trail is about conversation + maintenance
 * content, and those are already reflected in the session dropdown.
 */
function flattenTrail(events: SessionEvent[] | null): TrailRow[] {
  if (events === null) return []
  const rows: TrailRow[] = []

  // callId → grant reason, gathered from every tool message event's grantedBy map.
  const grantByCallId = new Map<string, ToolGrantReason>()
  for (const event of events) {
    if (event.type !== "message") continue
    if (event.role !== "tool") continue
    const toolEvent = event as MessageEvent & { grantedBy?: Record<string, ToolGrantReason> }
    if (toolEvent.grantedBy === undefined) continue
    for (const [callId, reason] of Object.entries(toolEvent.grantedBy)) grantByCallId.set(callId, reason)
  }

  let cp = 0
  let mem = 0
  for (const event of events) {
    switch (event.type) {
      case "message":
        event.blocks.forEach((block, i) => {
          const row: TrailRow = {
            kind: "block",
            key: `${event.id}-${i}`,
            role: event.role,
            block,
            createdAt: event.createdAt,
          }
          if (block.type === "tool_call" || block.type === "tool_result") {
            const reason = grantByCallId.get(block.callId)
            if (reason !== undefined) row.grantedBy = reason
          }
          rows.push(row)
        })
        break
      case "compaction":
        rows.push({ kind: "compaction", key: `cp-${cp++}`, record: event, at: event.at })
        break
      case "memory":
        rows.push({ kind: "memory", key: `mem-${mem++}`, event })
        break
      default:
        // session.created / renamed / deleted / restored / set — not rendered.
        break
    }
  }
  return rows
}

/** One-line memory summary: 记忆 · trigger · kind · op · (topic) · (file). */
function memorySummary(event: MemoryEvent): string {
  let s = `记忆 · ${event.trigger} · ${event.kind} · ${event.op}`
  if (event.topic !== undefined) s += ` · ${event.topic}`
  if (event.file !== undefined) s += ` · ${event.file}`
  return s
}

/** Full memory payload on expand (present fields only). */
function memoryFullContent(event: MemoryEvent): string {
  const lines = [`trigger: ${event.trigger}`, `kind: ${event.kind}`, `op: ${event.op}`]
  if (event.topic !== undefined) lines.push(`topic: ${event.topic}`)
  if (event.file !== undefined) lines.push(`file: ${event.file}`)
  if (event.scope !== undefined) lines.push(`scope: ${event.scope}`)
  if (event.source !== undefined) lines.push(`source: ${event.source}`)
  return lines.join("\n")
}

/** Whitespace-collapsed, first-80-chars summary. */
function summarize(text: string): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length > 80 ? `${t.slice(0, 80)}…` : t
}

function blockTypeLabel(block: Block): string {
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
      return "note"
    case "attachment":
      return "attachment"
  }
}

function blockSummary(block: Block): string {
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

function blockFullContent(block: Block): string {
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
