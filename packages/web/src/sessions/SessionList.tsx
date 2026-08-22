/**
 * SessionList — pure presentational sidebar list (spec §10 WebUI). No I/O:
 * sessions arrive through props, selection escapes through onSelect, creation
 * through onCreate, and rename/delete escape through onRename/onDelete — the
 * owner (App) owns the HTTP calls. The empty state ("新建一个会话开始") shows once
 * the initial load finished and there is nothing to pick.
 *
 * Each row offers an inline rename (title becomes an input + 保存/取消) and a
 * delete button, so a session can be renamed or soft-deleted straight from the
 * sidebar without leaving the pure-component contract.
 */
import { useState, type ChangeEvent } from "react"
import type { SessionMeta } from "../types.js"

export interface SessionListProps {
  sessions: SessionMeta[]
  /** The currently selected session id, if any. */
  selectedId: string | null
  /** True while the initial list is still being fetched (suppresses the empty state). */
  loading: boolean
  onSelect: (id: string) => void
  /** Escape a create request with the chosen working directory (spec §5.1). */
  onCreate: (workdir: string) => void
  /** Escape the inline-edit commit (id + trimmed new title) to the owner. */
  onRename: (id: string, title: string) => void
  /** Escape a soft-delete request to the owner. */
  onDelete: (id: string) => void
}

export function SessionList({
  sessions,
  selectedId,
  loading,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [workdir, setWorkdir] = useState("home")

  const startRename = (meta: SessionMeta) => {
    setEditingId(meta.id)
    setDraft(meta.title)
  }

  const commitRename = () => {
    if (editingId === null) return
    const title = draft.trim()
    if (title === "") return
    onRename(editingId, title)
    setEditingId(null)
  }

  return (
    <div className="session-list" data-testid="session-list">
      <div className="sidebar-title">Sessions</div>
      <div className="new-session-controls">
        <input
          type="text"
          className="workdir-input"
          data-testid="session-workdir-input"
          value={workdir}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setWorkdir(event.target.value)}
          placeholder="工作目录"
          title="工作目录"
        />
        <button
          type="button"
          className="new-session"
          data-testid="new-session"
          onClick={() => onCreate(workdir)}
        >
          + 新建会话
        </button>
      </div>
      {!loading && sessions.length === 0 && (
        <p className="muted session-empty" data-testid="session-empty">
          新建一个会话开始
        </p>
      )}
      <ul className="session-items">
        {sessions.map((meta) => (
          <li key={meta.id} className="session-row">
            <button
              type="button"
              className={`session-item${meta.id === selectedId ? " selected" : ""}`}
              data-testid={`session-item-${meta.id}`}
              data-selected={meta.id === selectedId}
              onClick={() => onSelect(meta.id)}
            >
              <span className="session-title">{meta.title}</span>
              <span className="session-time">{formatWhen(meta.updatedAt)}</span>
            </button>
            {editingId === meta.id ? (
              <span className="session-rename">
                <input
                  type="text"
                  data-testid={`session-rename-input-${meta.id}`}
                  value={draft}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
                  autoFocus
                />
                <button type="button" data-testid={`session-rename-confirm-${meta.id}`} onClick={commitRename}>
                  保存
                </button>
                <button type="button" data-testid={`session-rename-cancel-${meta.id}`} onClick={() => setEditingId(null)}>
                  取消
                </button>
              </span>
            ) : (
              <span className="session-actions">
                <button type="button" data-testid={`session-rename-${meta.id}`} onClick={() => startRename(meta)}>
                  改名
                </button>
                <button type="button" data-testid={`session-delete-${meta.id}`} onClick={() => onDelete(meta.id)}>
                  删除
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Local-time display for a session's updatedAt; raw ISO when unparseable. */
function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}
