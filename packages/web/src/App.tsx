/**
 * Root of the kclaw web shell. Bootstraps the token once; without one it
 * shows the token form, otherwise the main shell.
 *
 * MainShell owns the top-level state: the active tab (对话/任务/审计 — plain
 * useState, no router), the session list (GET /sessions on mount), and the
 * selected session (kept across tab switches). Selecting a session pulls its
 * full message list (GET /sessions/:id/messages, cached per session) and mounts
 * the ChatPanel with a fresh per-session ws client; the panel is kept mounted
 * (hidden) on the other tabs so the live stream survives navigation.
 *
 * The ChatPanel's two effects key on `[sessionId, api, ws, createWs]` and
 * `[sessionId, initialMessages]`, so this component takes care that every one
 * of those references is STABLE across re-renders (api via useMemo on the
 * token, createWs via useCallback, ws via useMemo per selection, and the
 * initial message array via the per-session cache) — otherwise a tab switch or
 * a status ping would re-fire the subscription or reset the live view (the
 * double-subscribe and initialMessages-reference-reinit pitfalls).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { bootstrapToken, clearToken, saveToken } from "./token.js"
import { createApi } from "./api.js"
import { createWsClient, type WsClient } from "./ws.js"
import { ChatPanel } from "./chat/ChatPanel.js"
import { UsageView } from "./usage/UsageView.js"
import type { Message } from "./chat/model.js"
import { SessionList } from "./sessions/SessionList.js"
import { TrashView } from "./sessions/TrashView.js"
import { JobsView } from "./jobs/JobsView.js"
import { AuditView } from "./audit/AuditView.js"
import type { FsBrowseResult, SessionMeta } from "./types.js"

type DaemonStatus = "connecting" | "connected" | "error"
type Tab = "chat" | "jobs" | "audit" | "usage" | "trash"

/** Same-origin ws endpoint (the daemon serves the SPA itself). */
function wsUrlFor(): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws"
  return `${protocol}://${window.location.host}/ws`
}

export function App() {
  const [token, setToken] = useState<string | null>(() => bootstrapToken())

  // 401 re-entry: any API 401 — the mount-time status
  // ping or any later call — clears the stale token and re-renders the token
  // form. Without this a reload would re-bootstrap the SAME stale token and
  // loop the auth notice forever.
  const handleAuthExpired = useCallback(() => {
    clearToken()
    setToken(null)
  }, [])

  if (token === null) return <TokenForm />
  return <MainShell token={token} onAuthExpired={handleAuthExpired} />
}

/** Shown when no token is stored: paste the daemon token to continue. */
function TokenForm() {
  const [value, setValue] = useState("")

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault()
      const token = value.trim()
      if (token === "") return
      saveToken(token)
      window.location.reload()
    },
    [value],
  )

  return (
    <div className="token-gate">
      <h1>kclaw</h1>
      <p className="muted">
        This instance is protected by a bearer token. Paste the token from
        your daemon — run <code>kclaw web</code>, or read <code>~/.kclaw/token</code>.
      </p>
      <form onSubmit={submit}>
        <input
          type="text"
          placeholder="daemon token"
          value={value}
          data-testid="token-input"
          onChange={(event) => setValue(event.target.value)}
          autoFocus
        />
        <button type="submit">Connect</button>
      </form>
    </div>
  )
}

/** Main shell: header with tabs + daemon status, sidebar, and the tab body. */
function MainShell({ token, onAuthExpired }: { token: string; onAuthExpired: () => void }) {
  // onUnauthorized is shared by every call this instance makes (the shell's
  // own pings/pulls plus the tab views) — a 401 anywhere re-enters the token
  // form instead of surfacing a dead "refresh" notice.
  const api = useMemo(
    () => createApi("", () => token, { onUnauthorized: onAuthExpired }),
    [token, onAuthExpired],
  )
  const [wsUrl] = useState(() => wsUrlFor())
  const [status, setStatus] = useState<DaemonStatus>("connecting")
  const [tab, setTab] = useState<Tab>("chat")
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messagesCache, setMessagesCache] = useState<Record<string, Message[]>>({})
  const [sessionNotice, setSessionNotice] = useState<string | null>(null)
  // Mobile-only: the sidebar slides in as a drawer behind this flag (desktop
  // keeps it permanently visible).
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // One-shot ?session=<id> deep link (notification targets): consumed exactly
  // once, after the session list loads, then stripped from the URL.
  const deepLinkConsumed = useRef(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<{ ok?: boolean }>("/status")
      .then(() => {
        if (!cancelled) setStatus("connected")
      })
      .catch(() => {
        if (!cancelled) setStatus("error")
      })
    return () => {
      cancelled = true
    }
  }, [api])

  // Session list on mount (server sorts by updatedAt desc).
  useEffect(() => {
    let cancelled = false
    api
      .get<SessionMeta[]>("/sessions")
      .then((metas) => {
        if (!cancelled) setSessions(metas)
        if (!cancelled && !deepLinkConsumed.current) {
          deepLinkConsumed.current = true
          const target = new URLSearchParams(window.location.search).get("session")
          // Consume the param either way (hit or miss) so a refresh or later
          // navigation never re-triggers the jump.
          window.history.replaceState({}, "", "/")
          if (target !== null && metas.some((meta) => meta.id === target)) {
            setSelectedId(target)
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessions([])
          setSessionNotice("加载会话列表失败")
        }
      })
    return () => {
      cancelled = true
    }
  }, [api])

  // Pull (and cache) the selected session's messages. The cache is keyed by
  // session id, so the array reference handed to the ChatPanel stays stable
  // for the session's whole lifetime — re-renders never reset its live view.
  useEffect(() => {
    if (selectedId === null || messagesCache[selectedId] !== undefined) return
    let cancelled = false
    api
      .get<Message[]>(`/sessions/${encodeURIComponent(selectedId)}/messages`)
      .then((messages) => {
        if (!cancelled) setMessagesCache((cache) => ({ ...cache, [selectedId]: messages }))
      })
      .catch(() => {
        // An empty conversation is a valid fallback; the live view self-heals.
        if (!cancelled) setMessagesCache((cache) => ({ ...cache, [selectedId]: [] }))
      })
    return () => {
      cancelled = true
    }
  }, [api, selectedId, messagesCache])

  const readyMessages: Message[] | null =
    selectedId === null ? null : (messagesCache[selectedId] ?? null)
  const selectedMeta = sessions?.find((x) => x.id === selectedId) ?? null

  const createWs = useCallback(() => createWsClient(wsUrl, token), [wsUrl, token])
  // A fresh authenticated client per selection — created only when the chat
  // can actually mount, so an abandoned click never leaks an open socket.
  const ws: WsClient | null = useMemo(
    () => (selectedId !== null && readyMessages !== null ? createWsClient(wsUrl, token) : null),
    [selectedId, readyMessages, wsUrl, token],
  )

  const selectSession = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  // A tab click on mobile should also dismiss the sidebar drawer.
  const switchTab = useCallback((next: Tab) => {
    setSidebarOpen(false)
    setTab(next)
  }, [])

  const handleCreateSession = useCallback(async (workdir: string): Promise<void> => {
    setSessionNotice(null)
    try {
      // An empty box means "the daemon's configured workspace": drop the
      // field so the session carries no workdir and runs fall back to it.
      const meta = await api.post<SessionMeta>("/sessions", workdir === "" ? {} : { workdir })
      setSessions((prev) => [meta, ...(prev ?? [])])
      // Selecting the fresh session triggers the message pull (empty) and the
      // ws subscribe below — the new empty conversation becomes the active one.
      setSelectedId(meta.id)
    } catch (err) {
      setSessionNotice(err instanceof Error ? err.message : "创建会话失败")
    }
  }, [api])

  // Directory listings for the workdir picker (no path = the picker root,
  // i.e. the daemon's configured workspace).
  const browseDirs = useCallback(
    (path?: string): Promise<FsBrowseResult> =>
      api.get<FsBrowseResult>(path === undefined ? "/fs/browse" : `/fs/browse?path=${encodeURIComponent(path)}`),
    [api],
  )

  const handleRenameSession = useCallback(
    async (id: string, title: string): Promise<void> => {
      setSessionNotice(null)
      try {
        const meta = await api.patch<SessionMeta>(`/sessions/${encodeURIComponent(id)}`, { title })
        setSessions((prev) => (prev ?? []).map((s) => (s.id === id ? meta : s)))
      } catch (err) {
        setSessionNotice(err instanceof Error ? err.message : "重命名失败")
      }
    },
    [api],
  )

  // Soft-delete (the server marks the session deleted; it moves to the trash).
  const handleDeleteSession = useCallback(
    async (id: string): Promise<void> => {
      setSessionNotice(null)
      try {
        await api.del(`/sessions/${encodeURIComponent(id)}`)
        setSessions((prev) => (prev ?? []).filter((s) => s.id !== id))
        if (selectedId === id) setSelectedId(null)
      } catch (err) {
        setSessionNotice(err instanceof Error ? err.message : "删除失败")
      }
    },
    [api, selectedId],
  )

  const chatActive = selectedId !== null && readyMessages !== null

  return (
    <div className="shell">
      <header className="topbar">
        <button
          type="button"
          className="sidebar-toggle"
          data-testid="sidebar-toggle"
          aria-label="打开会话列表"
          onClick={() => setSidebarOpen(true)}
        >
          ☰
        </button>
        <span className="brand">kclaw</span>
        <nav className="tabs" data-testid="tabs">
          <button
            type="button"
            className={tab === "chat" ? "tab active" : "tab"}
            data-testid="tab-chat"
            onClick={() => switchTab("chat")}
          >
            对话
          </button>
          <button
            type="button"
            className={tab === "jobs" ? "tab active" : "tab"}
            data-testid="tab-jobs"
            onClick={() => switchTab("jobs")}
          >
            任务
          </button>
          <button
            type="button"
            className={tab === "audit" ? "tab active" : "tab"}
            data-testid="tab-audit"
            onClick={() => switchTab("audit")}
          >
            审计
          </button>
          <button
            type="button"
            className={tab === "usage" ? "tab active" : "tab"}
            data-testid="tab-usage"
            onClick={() => switchTab("usage")}
          >
            用量
          </button>
          <button
            type="button"
            className={tab === "trash" ? "tab active" : "tab"}
            data-testid="tab-trash"
            onClick={() => switchTab("trash")}
          >
            回收站
          </button>
        </nav>
        <span
          className={`status-dot ${status}`}
          data-testid="status-dot"
          title={`daemon: ${status}`}
        />
      </header>
      <div className="body">
        <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
          <SessionList
            sessions={sessions ?? []}
            selectedId={selectedId}
            loading={sessions === null}
            onSelect={(id) => {
              setSidebarOpen(false)
              selectSession(id)
            }}
            onCreate={(workdir) => void handleCreateSession(workdir)}
            onRename={(id, title) => void handleRenameSession(id, title)}
            onDelete={(id) => void handleDeleteSession(id)}
            onBrowse={browseDirs}
          />
          {sessionNotice !== null && (
            <p className="sidebar-notice" data-testid="session-notice" role="alert">
              {sessionNotice}
            </p>
          )}
        </aside>
        {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
        <main className="main">
          {selectedId !== null && readyMessages !== null && ws !== null && (
            // Kept mounted across tab switches (hidden elsewhere) so the live
            // stream and the composer draft survive navigation.
            <div className="chat-host" hidden={tab !== "chat"} data-testid="chat-host">
              <ChatPanel
                sessionId={selectedId}
                api={api}
                ws={ws}
                createWs={createWs}
                initialMessages={readyMessages}
                sessionModel={selectedMeta?.model}
              />
            </div>
          )}
          {tab === "chat" && !chatActive && (
            <p className="muted" data-testid="chat-empty">
              {selectedId === null ? "No session selected." : "加载会话中…"}
            </p>
          )}
          {tab === "jobs" && <JobsView api={api} />}
          {tab === "audit" && <AuditView api={api} />}
          {tab === "usage" && <UsageView api={api} />}
          {tab === "trash" && <TrashView api={api} />}
        </main>
      </div>
    </div>
  )
}
