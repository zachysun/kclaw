/**
 * AuditView — the trail page (轨迹页). Single source of truth is the session's
 * messages.jsonl, read through GET /sessions (the session dropdown) and
 * GET /sessions/:id/messages (the message list). Each message is flattened into
 * one row per block, ordered by message createdAt ascending — newest at the
 * bottom, like a log; each row shows a type label plus a one-line summary, and
 * expands on click to the full block
 * payload. No mutation, no /audit — the old audit tail route is gone. A
 * selected session additionally pulls its compaction log
 * (GET /sessions/:id/compactions) and merges each record into the trail as a
 * "压缩" row placed at the time the compaction happened (record.at), i.e.
 * right after the last message it covered.
 */
import { useEffect, useState } from "react"
import { type ApiClient } from "../api.js"
import type { Block, CompactionRecord, Message, Role, SessionMeta, ToolGrantReason, ToolMessage } from "../types.js"

/**
 * One flattened trail row: either a message block (carrying the owning
 * message's role + timestamp, and for tool rows the grant reason) or a
 * compaction audit record (carrying its own `at` timestamp).
 */
type TrailRow =
  | { kind: "block"; key: string; role: Role; block: Block; createdAt: string; grantedBy?: ToolGrantReason }
  | { kind: "compaction"; key: string; record: CompactionRecord; at: string }

export function AuditView({ api }: { api: ApiClient }) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [selectedId, setSelectedId] = useState<string>("")
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [compactions, setCompactions] = useState<CompactionRecord[] | null>(null)
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

  // Pull the selected session's messages (none until a session is chosen).
  useEffect(() => {
    if (selectedId === "") {
      setMessages(null)
      return
    }
    let cancelled = false
    setMessages(null)
    setError(null)
    api
      .get<Message[]>(`/sessions/${encodeURIComponent(selectedId)}/messages`)
      .then((msgs) => {
        if (cancelled) return
        setMessages(msgs)
      })
      .catch((err) => {
        if (cancelled) return
        setMessages([])
        setError(err instanceof Error ? err.message : "加载轨迹失败")
      })
    return () => {
      cancelled = true
    }
  }, [api, selectedId])

  // Pull the selected session's compaction audit log alongside the messages
  // (same cancellation pattern). A failure here is auxiliary — the section
  // just stays hidden (mirrors the ChatPanel /config fetch's silent catch).
  useEffect(() => {
    if (selectedId === "") {
      setCompactions(null)
      return
    }
    let cancelled = false
    setCompactions(null)
    api
      .get<CompactionRecord[]>(`/sessions/${encodeURIComponent(selectedId)}/compactions`)
      .then((records) => {
        if (cancelled) return
        setCompactions(records)
      })
      .catch(() => {
        if (cancelled) return
        setCompactions([])
      })
    return () => {
      cancelled = true
    }
  }, [api, selectedId])

  const rows = flattenTrail(messages, compactions)

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
          {rows.map((row) =>
            row.kind === "compaction" ? (
              <li key={row.key} className="trail-row-item">
                <button
                  type="button"
                  className="trail-row"
                  data-testid={`compaction-row-${row.key}`}
                  onClick={() => setExpandedKey((key) => (key === row.key ? null : row.key))}
                >
                  <span className="trail-type">压缩</span>
                  <span className="trail-summary">
                    {row.record.trigger === "manual"
                      ? `手动${row.record.focus ? `（${row.record.focus}）` : ""}`
                      : "自动"}
                    {` · ${row.record.from ?? "会话开头"} – ${row.record.upto} · ${row.record.messages} 条`}
                  </span>
                  <span className="trail-meta muted">{new Date(row.at).toLocaleString()}</span>
                </button>
                {expandedKey === row.key && (
                  <pre className="trail-full" data-testid={`compaction-full-${row.key}`}>
                    {`段摘要：\n${row.record.segmentSummary}\n\n总摘要：\n${row.record.top}`}
                  </pre>
                )}
              </li>
            ) : (
              <li key={row.key} className="trail-row-item">
                <button
                  type="button"
                  className="trail-row"
                  data-testid={`trail-row-${row.key}`}
                  onClick={() => setExpandedKey((key) => (key === row.key ? null : row.key))}
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
                {expandedKey === row.key && (
                  <pre className="trail-full" data-testid={`trail-full-${row.key}`}>
                    {blockFullContent(row.block)}
                  </pre>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * Flatten messages (createdAt ascending — newest at the bottom) into one row
 * per block; blocks within
 * a message keep their authored order. Tool rows (tool_call/tool_result) carry
 * the grant reason for their callId, resolved from the tool messages' message-
 * level `grantedBy` maps (a tool_call lives on an assistant message, its
 * tool_result + grantedBy on the matching tool message — so we join by callId).
 * Compaction records become rows of their own; the combined list is sorted by
 * timestamp ascending, so each compaction sits where it happened — after the
 * last message it covered, before everything that came later. Timestamp ties
 * keep insertion order (stable sort; blocks first), which places a compaction
 * after a message recorded at the exact same instant — compaction always
 * happens after the message it follows.
 */
function flattenTrail(messages: Message[] | null, compactions: CompactionRecord[] | null): TrailRow[] {
  const rows: TrailRow[] = []

  if (messages !== null) {
    const sorted = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))

    // callId → grant reason, gathered from every tool message's grantedBy map.
    const grantByCallId = new Map<string, ToolGrantReason>()
    for (const message of sorted) {
      if (message.role !== "tool") continue
      const grants = (message as ToolMessage).grantedBy
      if (grants === undefined) continue
      for (const [callId, reason] of Object.entries(grants)) grantByCallId.set(callId, reason)
    }

    for (const message of sorted) {
      message.blocks.forEach((block, i) => {
        const row: TrailRow = {
          kind: "block",
          key: `${message.id}-${i}`,
          role: message.role,
          block,
          createdAt: message.createdAt,
        }
        if (block.type === "tool_call" || block.type === "tool_result") {
          const reason = grantByCallId.get(block.callId)
          if (reason !== undefined) row.grantedBy = reason
        }
        rows.push(row)
      })
    }
  }

  if (compactions !== null) {
    compactions.forEach((record, i) => rows.push({ kind: "compaction", key: `cp-${i}`, record, at: record.at }))
  }

  const rowTime = (row: TrailRow): string => (row.kind === "compaction" ? row.at : row.createdAt)
  return rows.sort((a, b) => {
    const at = rowTime(a)
    const bt = rowTime(b)
    return at < bt ? -1 : at > bt ? 1 : 0
  })
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
