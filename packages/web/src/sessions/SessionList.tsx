/**
 * SessionList — the sidebar's session list (WebUI). No HTTP: sessions arrive
 * through props and every daemon call escapes through a callback (onSelect,
 * onCreate, onRename, onDelete, onBrowse) to the owner (App). One piece of
 * browser-local state lives here in localStorage — the per-workdir
 * display-name overrides (so group renames survive reloads); it degrades to
 * defaults when storage is unavailable.
 *
 * Sessions are grouped by workdir: rows sharing a directory sit under one
 * header whose label defaults to the path itself and can be renamed inline
 * (改名 → input + 保存/取消). Each group header carries a ＋ button that
 * creates a session directly in that directory; the top-level 选择工作目录
 * button opens the DirectoryPicker for a directory not in the list yet —
 * picking a path creates the session there. Sessions without a workdir (old
 * rows, job sessions) land in a muted "未指定工作目录" group and still show
 * their workdir line when they have one.
 */
import { useMemo, useState, type ChangeEvent } from "react"
import type { FsBrowseResult, SessionMeta } from "../types.js"
import { DirectoryPicker } from "./DirectoryPicker.js"

export interface SessionListProps {
  sessions: SessionMeta[]
  /** The currently selected session id, if any. */
  selectedId: string | null
  /** True while the initial list is still being fetched (suppresses the empty state). */
  loading: boolean
  onSelect: (id: string) => void
  /** Escape a create-session request with the chosen working directory. */
  onCreate: (workdir: string) => void
  /** Escape the inline-edit commit (id + trimmed new title) to the owner. */
  onRename: (id: string, title: string) => void
  /** Escape a soft-delete request to the owner. */
  onDelete: (id: string) => void
  /** Fetch a directory listing for the workdir picker (no path = picker root). */
  onBrowse: (path?: string) => Promise<FsBrowseResult>
}

const WORKDIR_NAMES_KEY = "kclaw_workdir_names"

function loadWorkdirNames(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKDIR_NAMES_KEY) ?? "{}") as unknown
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

function saveWorkdirNames(names: Record<string, string>): void {
  try {
    localStorage.setItem(WORKDIR_NAMES_KEY, JSON.stringify(names))
  } catch {
    // ignore — renames still apply for this session
  }
}

export function SessionList({
  sessions,
  selectedId,
  loading,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onBrowse,
}: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [workdirNames, setWorkdirNames] = useState<Record<string, string>>(loadWorkdirNames)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerListing, setPickerListing] = useState<FsBrowseResult | null>(null)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)

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

  const startGroupRename = (key: string) => {
    setRenamingGroup(key)
    setGroupDraft(workdirNames[key] ?? key)
  }

  const commitGroupRename = () => {
    const key = renamingGroup
    const name = groupDraft.trim()
    if (key === null || name === "") {
      setRenamingGroup(null)
      return
    }
    const next = { ...workdirNames, [key]: name }
    setWorkdirNames(next)
    saveWorkdirNames(next)
    setRenamingGroup(null)
  }

  const loadPicker = async (path?: string): Promise<void> => {
    setPickerLoading(true)
    setPickerError(null)
    try {
      setPickerListing(await onBrowse(path))
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : "目录读取失败")
    } finally {
      setPickerLoading(false)
    }
  }

  const openPicker = () => {
    setPickerOpen(true)
    setPickerListing(null)
    // The picker starts at the daemon's configured workspace.
    void loadPicker(undefined)
  }

  const pickCurrent = () => {
    if (pickerListing === null) return
    setPickerOpen(false)
    // Picking a directory IS the create gesture: a new session goes there.
    onCreate(pickerListing.path)
  }

  // Groups preserve the server's updatedAt-desc order: first appearance of a
  // workdir fixes the group order, rows keep their relative order within it.
  const groups = useMemo(() => {
    const byKey = new Map<string, SessionMeta[]>()
    const order: string[] = []
    for (const meta of sessions) {
      const key = meta.workdir ?? ""
      if (!byKey.has(key)) {
        byKey.set(key, [])
        order.push(key)
      }
      byKey.get(key)!.push(meta)
    }
    return order.map((key) => ({ key, sessions: byKey.get(key)! }))
  }, [sessions])

  const groupLabel = (key: string): string =>
    key === "" ? "未指定工作目录" : (workdirNames[key] ?? key)

  return (
    <div className="session-list" data-testid="session-list">
      <div className="sidebar-title">Sessions</div>
      <div className="new-session-controls">
        <button
          type="button"
          className="new-session"
          data-testid="pick-workdir"
          onClick={openPicker}
        >
          ＋ 选择工作目录新建会话
        </button>
      </div>
      {!loading && sessions.length === 0 && (
        <p className="muted session-empty" data-testid="session-empty">
          新建一个会话开始
        </p>
      )}
      <ul className="session-items">
        {groups.map(({ key, sessions: groupSessions }) => (
          <li key={key} className="workdir-group">
            <div className="workdir-group-header">
              <span className={`workdir-group-name${key === "" ? " muted" : ""}`} data-testid={`workdir-group-name-${key}`} title={key === "" ? undefined : key}>
                {groupLabel(key)}
              </span>
              {key !== "" && renamingGroup !== key && (
                <span className="group-actions">
                  <button
                    type="button"
                    className="group-new"
                    data-testid={`group-new-${key}`}
                    title="在此目录新建会话"
                    onClick={() => onCreate(key)}
                  >
                    ＋
                  </button>
                  <button
                    type="button"
                    className="group-rename-trigger"
                    data-testid={`group-rename-${key}`}
                    onClick={() => startGroupRename(key)}
                  >
                    改名
                  </button>
                </span>
              )}
            </div>
            {renamingGroup === key && (
              <span className="group-rename">
                <input
                  type="text"
                  data-testid="group-rename-input"
                  value={groupDraft}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setGroupDraft(event.target.value)}
                  autoFocus
                />
                <button type="button" data-testid="group-rename-confirm" onClick={commitGroupRename}>
                  保存
                </button>
                <button type="button" data-testid="group-rename-cancel" onClick={() => setRenamingGroup(null)}>
                  取消
                </button>
              </span>
            )}
            <ul className="group-sessions">
              {groupSessions.map((meta) => (
                <li key={meta.id} className="session-row">
                  <button
                    type="button"
                    className={`session-item${meta.id === selectedId ? " selected" : ""}`}
                    data-testid={`session-item-${meta.id}`}
                    data-selected={meta.id === selectedId}
                    onClick={() => onSelect(meta.id)}
                  >
                    <span className="session-title">{meta.title}</span>
                    {meta.workdir !== undefined && (
                      <span className="session-workdir" data-testid={`session-workdir-${meta.id}`} title={meta.workdir}>
                        {meta.workdir}
                      </span>
                    )}
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
          </li>
        ))}
      </ul>
      {pickerOpen && (
        <DirectoryPicker
          listing={pickerListing}
          loading={pickerLoading}
          error={pickerError}
          onNavigate={(path) => void loadPicker(path)}
          onPick={pickCurrent}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}

/** Local-time display for a session's updatedAt; raw ISO when unparseable. */
function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}
