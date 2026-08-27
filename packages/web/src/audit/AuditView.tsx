/**
 * AuditView — the trail page (轨迹页). Single source of truth is the session's
 * messages.jsonl, read through GET /sessions (the session dropdown) and
 * GET /sessions/:id/messages (the message list). Each message is flattened into
 * one row per block, ordered by message createdAt ascending — newest at the
 * bottom, like a log; each row shows a type label plus a one-line summary, and
 * expands on click to the full block
 * payload. No mutation, no /audit — the old audit tail route is gone.
 */
import { useEffect, useState } from "react"
import { type ApiClient } from "../api.js"
import type { Block, Message, Role, SessionMeta, ToolGrantReason, ToolMessage } from "../types.js"

/** One flattened block, carrying the owning message's role + timestamp and (for tool rows) the grant reason. */
interface TrailRow {
  key: string
  role: Role
  block: Block
  createdAt: string
  grantedBy?: ToolGrantReason
}

export function AuditView({ api }: { api: ApiClient }) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [selectedId, setSelectedId] = useState<string>("")
  const [messages, setMessages] = useState<Message[] | null>(null)
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

  const rows = flattenTrail(messages)

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
          {rows.map((row) => (
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
          ))}
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
 */
function flattenTrail(messages: Message[] | null): TrailRow[] {
  if (messages === null) return []
  const sorted = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))

  // callId → grant reason, gathered from every tool message's grantedBy map.
  const grantByCallId = new Map<string, ToolGrantReason>()
  for (const message of sorted) {
    if (message.role !== "tool") continue
    const grants = (message as ToolMessage).grantedBy
    if (grants === undefined) continue
    for (const [callId, reason] of Object.entries(grants)) grantByCallId.set(callId, reason)
  }

  const rows: TrailRow[] = []
  for (const message of sorted) {
    message.blocks.forEach((block, i) => {
      const row: TrailRow = { key: `${message.id}-${i}`, role: message.role, block, createdAt: message.createdAt }
      if (block.type === "tool_call" || block.type === "tool_result") {
        const reason = grantByCallId.get(block.callId)
        if (reason !== undefined) row.grantedBy = reason
      }
      rows.push(row)
    })
  }
  return rows
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
