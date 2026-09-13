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
 * (改名 → input + 保存/取消). Clicking the header folds/unfolds the group —
 * the folded set persists in localStorage (so it survives reloads) and a
 * folded header shows its session count. Each group header carries a ＋
 * button that creates a session directly in that directory, plus 删除: a
 * two-step armed button (first click shows 确认删除, second click commits)
 * that soft-deletes every session in the group into the trash. The top-level
 * 选择工作目录 button opens the DirectoryPicker for a directory not in the
 * list yet — picking a path creates the session there. Sessions without a
 * workdir (old rows, job sessions) land in a muted "未指定工作目录" group.
 */
import { useMemo, useState, type ChangeEvent } from "react"
import type { FsBrowseResult, SessionMeta } from "../types.js"
import { IconButton } from "../ui/IconButton.js"
import { PencilIcon, TrashIcon } from "../ui/icons.js"
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
  /** Soft-delete every session under one workdir (the project group). */
  onDeleteGroup: (workdir: string) => Promise<void>
  /** Fetch a directory listing for the workdir picker (no path = picker root). */
  onBrowse: (path?: string) => Promise<FsBrowseResult>
}

const WORKDIR_NAMES_KEY = "kclaw_workdir_names"
const COLLAPSED_GROUPS_KEY = "kclaw_collapsed_workdirs"

function loadWorkdirNames(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKDIR_NAMES_KEY) ?? "{}") as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    // Validate the leaves too: a non-string value would reach JSX and crash
    // the whole sidebar on render.
    const names: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") names[key] = value
    }
    return names
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

/** Collapsed workdir groups persist across reloads; corrupt storage → all open. */
function loadCollapsedGroups(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "[]") as unknown
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set()
  } catch {
    return new Set()
  }
}

function saveCollapsedGroups(groups: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups]))
  } catch {
    // ignore — collapsing still applies for this session
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
  onDeleteGroup,
  onBrowse,
}: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [workdirNames, setWorkdirNames] = useState<Record<string, string>>(loadWorkdirNames)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState("")
  const [deletingGroup, setDeletingGroup] = useState<string | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [pathTip, setPathTip] = useState<{ text: string; top: number; left: number; maxWidth: number } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerListing, setPickerListing] = useState<FsBrowseResult | null>(null)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)

  /** Fold/unfold one workdir group; the set persists to localStorage. */
  const toggleGroup = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveCollapsedGroups(next)
      return next
    })
  }

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
    setDeletingGroup(null)
  }

  /** Two-step arm: the first click arms the button, the second commits. */
  const startGroupDelete = (key: string) => {
    setDeletingGroup(key)
    setDeletePending(false)
  }

  const commitGroupDelete = async (): Promise<void> => {
    const key = deletingGroup
    if (key === null || deletePending) return
    setDeletePending(true)
    try {
      await onDeleteGroup(key)
    } finally {
      setDeletingGroup(null)
      setDeletePending(false)
    }
  }

  // The group label tail-ellipsizes long paths, so the full path only exists
  // in a hover/focus tooltip. Fixed-positioned under the header (a CSS pseudo
  // element would be clipped by the sidebar's scroll container); scroll or
  // leaving the header dismisses it.
  const showPathTip = (el: HTMLElement, text: string): void => {
    const rect = el.getBoundingClientRect()
    setPathTip({
      text,
      top: rect.bottom + 4,
      left: rect.left,
      maxWidth: Math.max(160, Math.min(360, window.innerWidth - rect.left - 8)),
    })
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
    <div className="session-list" data-testid="session-list" onScrollCapture={() => setPathTip(null)}>
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
        {groups.map(({ key, sessions: groupSessions }) => {
          const collapsed = collapsedGroups.has(key)
          return (
            <li key={key} className={`workdir-group${collapsed ? " collapsed" : ""}`} data-testid={`workdir-group-${key}`}>
              <div className="workdir-group-header">
                <button
                  type="button"
                  className={`workdir-group-name${key === "" ? " muted" : ""}`}
                  data-testid={`workdir-group-name-${key}`}
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroup(key)}
                  onMouseEnter={key === "" ? undefined : (event) => showPathTip(event.currentTarget, key)}
                  onMouseLeave={() => setPathTip(null)}
                  onMouseDown={() => setPathTip(null)}
                  onFocus={key === "" ? undefined : (event) => showPathTip(event.currentTarget, key)}
                  onBlur={() => setPathTip(null)}
                >
                  <span className="fold-mark" aria-hidden="true" />
                  <span className="group-name-text">{groupLabel(key)}</span>
                </button>
                {collapsed && (
                  <span className="group-count" data-testid={`group-count-${key}`}>
                    {groupSessions.length}
                  </span>
                )}
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
                    <IconButton
                      label="改名"
                      icon={<PencilIcon />}
                      testid={`group-rename-${key}`}
                      onClick={() => startGroupRename(key)}
                    />
                    {deletingGroup === key ? (
                      <button
                        type="button"
                        className="group-delete-trigger danger"
                        data-testid={`group-delete-${key}`}
                        disabled={deletePending}
                        onClick={() => void commitGroupDelete()}
                      >
                        {deletePending ? "删除中…" : "确认删除"}
                      </button>
                    ) : (
                      <IconButton
                        label="删除"
                        danger
                        icon={<TrashIcon />}
                        testid={`group-delete-${key}`}
                        onClick={() => startGroupDelete(key)}
                      />
                    )}
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
              {!collapsed && (
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
                        <span className="session-meta">
                          {meta.workdir !== undefined && (
                            <span className="session-workdir" data-testid={`session-workdir-${meta.id}`} title={meta.workdir}>
                              {meta.workdir}
                            </span>
                          )}
                          <span className="session-time">{formatWhen(meta.updatedAt)}</span>
                        </span>
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
                          <IconButton
                            label="改名"
                            icon={<PencilIcon />}
                            testid={`session-rename-${meta.id}`}
                            onClick={() => startRename(meta)}
                          />
                          <IconButton
                            label="删除"
                            danger
                            icon={<TrashIcon />}
                            testid={`session-delete-${meta.id}`}
                            onClick={() => onDelete(meta.id)}
                          />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      {pathTip !== null && (
        <div
          className="workdir-tip"
          data-testid="workdir-tip"
          role="tooltip"
          style={{ top: pathTip.top, left: pathTip.left, maxWidth: pathTip.maxWidth }}
        >
          {pathTip.text}
        </div>
      )}
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

/**
 * Compact local display for a session's updatedAt: today → HH:MM, this
 * year → MM/DD HH:MM, else YYYY/MM/DD; raw ISO when unparseable. All
 * comparison is local Date arithmetic (no timezone-sensitive formatting).
 */
function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const hhmm = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  if (sameDay) return hhmm
  const md = `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${hhmm}`
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}/${md}`
}
