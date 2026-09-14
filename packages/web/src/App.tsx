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
 * `[sessionId, initialMessages]`, so every one of those references must be
 * STABLE across re-renders. api/createWs/wsUrl come from useDaemonClients
 * (daemon-clients.ts), which owns the memoization structurally — a hook
 * consumer cannot accidentally inline them into a per-render reference. ws
 * stays a useMemo here per selection, and the initial message array rides
 * the per-session cache; a tab switch or status ping therefore never re-fires
 * the subscription or resets the live view.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { bootstrapToken, clearToken, saveToken } from "./token.js"
import { applyTheme, loadTheme, nextTheme, type ThemeName } from "./theme.js"
import type { WsClient } from "./ws.js"
import { useDaemonClients } from "./daemon-clients.js"
import { ChatPanel } from "./chat/ChatPanel.js"
import { UsageView } from "./usage/UsageView.js"
import type { MemoryWrittenInfo, Message } from "./chat/model.js"
import { SessionList } from "./sessions/SessionList.js"
import { TrashView } from "./sessions/TrashView.js"
import { JobsView } from "./jobs/JobsView.js"
import { AuditView } from "./audit/AuditView.js"
import { MemoryView } from "./memory/MemoryView.js"
import { SkillsView } from "./skills/SkillsView.js"
import { PermissionsView } from "./permissions/PermissionsView.js"
import { McpView } from "./mcp/McpView.js"
import type { FsBrowseResult, SessionMeta } from "./types.js"

type DaemonStatus = "connecting" | "connected" | "error"

const TABS = ["chat", "jobs", "audit", "usage", "trash", "memory", "skills", "permissions", "mcp"] as const
type Tab = (typeof TABS)[number]

/**
 * Union two raw message lists by id, chronological (a cache snapshot can be
 * BEHIND the server list but never ahead of it — unknown ids from the fresh
 * fetch append at the end).
 */
function unionById(prev: Message[], fresh: Message[]): Message[] {
  if (prev.length === 0) return fresh
  const known = new Set(prev.map((m) => m.id))
  return [...prev, ...fresh.filter((m) => !known.has(m.id))]
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
  const { api, createWs, wsUrl } = useDaemonClients(token, onAuthExpired)
  const [status, setStatus] = useState<DaemonStatus>("connecting")
  const [tab, setTab] = useState<Tab>("chat")
  // Shell theme (phantom/amber): index.html already set the attribute before
  // first paint; this state mirrors it for the toggle and persists changes.
  const [theme, setTheme] = useState<ThemeName>(loadTheme)
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messagesCache, setMessagesCache] = useState<Record<string, Message[]>>({})
  const [sessionNotice, setSessionNotice] = useState<string | null>(null)
  // memory.written 通知条点击后的跳转目标：切到记忆页并自动打开对应文件。
  const [memoryTarget, setMemoryTarget] = useState<MemoryWrittenInfo | null>(null)
  // Mobile-only: the sidebar slides in as a drawer behind this flag (desktop
  // keeps it permanently visible).
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // The audit page stays mounted once visited (hidden offscreen on other tabs)
  // so its live connection, filters, and scroll position survive navigation.
  const [auditVisited, setAuditVisited] = useState(false)
  // One-shot ?session=<id> deep link (notification targets): consumed exactly
  // once, after the session list loads, then stripped from the URL. An
  // optional ?tab=<name> rides along (e.g. /?tab=audit&session=…).
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
          const params = new URLSearchParams(window.location.search)
          const target = params.get("session")
          const targetTab = params.get("tab")
          if (targetTab !== null && (TABS as readonly string[]).includes(targetTab)) {
            if (targetTab === "audit") setAuditVisited(true) // deep links mount the kept-alive host too
            setTab(targetTab as Tab)
          }
          // Consume the params either way (hit or miss) so a refresh or later
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

  // Pull the selected session's messages — on EVERY selection, not just the
  // first visit: the cache snapshot goes stale once a session's live stream
  // has grown it (switch away → back would show the outdated base). The fetch
  // result is UNIONED into the cache; the ChatPanel's same-session path then
  // merges the refreshed base into its live view instead of resetting it.
  useEffect(() => {
    if (selectedId === null) return
    let cancelled = false
    api
      .get<Message[]>(`/sessions/${encodeURIComponent(selectedId)}/messages`)
      .then((messages) => {
        if (!cancelled) {
          setMessagesCache((cache) => ({ ...cache, [selectedId]: unionById(cache[selectedId] ?? [], messages) }))
        }
      })
      .catch(() => {
        // An empty conversation is a valid fallback (first visit only — an
        // existing cached list stays); the live view self-heals.
        if (!cancelled) {
          setMessagesCache((cache) =>
            cache[selectedId] !== undefined ? cache : { ...cache, [selectedId]: [] },
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [api, selectedId])

  const readyMessages: Message[] | null =
    selectedId === null ? null : (messagesCache[selectedId] ?? null)
  const selectedMeta = sessions?.find((x) => x.id === selectedId) ?? null

  // A fresh authenticated client per selection — created only when the chat
  // can actually mount, so an abandoned click never leaks an open socket.
  const ws: WsClient | null = useMemo(
    () => (selectedId !== null && readyMessages !== null ? createWs() : null),
    [selectedId, readyMessages, createWs],
  )

  const selectSession = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  // The daemon renamed a session (autoname after the first message); patch the
  // list so the sidebar shows the new title without a reload.
  const handleSessionRenamed = useCallback((sessionId: string, title: string): void => {
    setSessions((prev) => (prev ?? []).map((s) => (s.id === sessionId ? { ...s, title } : s)))
  }, [])

  // A tab click on mobile should also dismiss the sidebar drawer.
  const switchTab = useCallback((next: Tab) => {
    setSidebarOpen(false)
    if (next === "audit") setAuditVisited(true)
    setTab(next)
  }, [])

  // Toggle the shell theme: applyTheme writes <html data-theme> (the CSS swap
  // is pure tokens) and persists the choice.
  const toggleTheme = useCallback((): void => {
    setTheme((prev) => {
      const next = nextTheme(prev)
      applyTheme(next)
      return next
    })
  }, [])

  // memory.written 通知条点击：切到记忆页并把目标交给 MemoryView 自动打开。
  const handleOpenMemoryWritten = useCallback((info: MemoryWrittenInfo): void => {
    setMemoryTarget(info)
    setTab("memory")
  }, [])

  // Shared "create a session → prepend to the list → select it" step behind
  // both the sidebar picker (workdir) and the slash commands (/new title,
  // /clear). Selecting the fresh session triggers the message pull (empty)
  // and the ws subscribe — the new empty conversation becomes the active one.
  const createAndSelectSession = useCallback(
    async (body: Record<string, unknown>): Promise<void> => {
      setSessionNotice(null)
      try {
        const meta = await api.post<SessionMeta>("/sessions", body)
        setSessions((prev) => [meta, ...(prev ?? [])])
        setSelectedId(meta.id)
      } catch (err) {
        setSessionNotice(err instanceof Error ? err.message : "创建会话失败")
      }
    },
    [api],
  )

  const handleCreateSession = useCallback(
    (workdir: string): Promise<void> =>
      // An empty box means "the daemon's configured workspace": drop the
      // field so the session carries no workdir and runs fall back to it.
      createAndSelectSession(workdir === "" ? {} : { workdir }),
    [createAndSelectSession],
  )

  // Slash-command creation always lands in the daemon's default workspace —
  // the web has no meaningful cwd to pin a workdir to.
  const handleSlashCreateSession = useCallback(
    (title?: string): Promise<void> => createAndSelectSession(title === undefined ? {} : { title }),
    [createAndSelectSession],
  )

  // The /sessions command: reveal the list (no-op visually on desktop, where
  // the sidebar is permanent; opens the drawer on mobile).
  const handleOpenSessions = useCallback((): void => {
    setSidebarOpen(true)
  }, [])

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

  // Soft-delete a whole project group: every session under the workdir goes
  // to the trash. Deletes run concurrently; whatever succeeded leaves the
  // list (the group disappears with it), failures surface in the notice.
  const handleDeleteGroup = useCallback(
    async (workdir: string): Promise<void> => {
      setSessionNotice(null)
      const ids = (sessions ?? []).filter((s) => s.workdir === workdir).map((s) => s.id)
      const results = await Promise.allSettled(
        ids.map((id) => api.del(`/sessions/${encodeURIComponent(id)}`)),
      )
      const deleted = new Set<string>()
      let failures = 0
      results.forEach((result, i) => {
        if (result.status === "fulfilled") deleted.add(ids[i]!)
        else failures += 1
      })
      if (deleted.size > 0) {
        setSessions((prev) => (prev ?? []).filter((s) => !deleted.has(s.id)))
        if (selectedId !== null && deleted.has(selectedId)) setSelectedId(null)
      }
      if (failures > 0) setSessionNotice(`${failures} 个会话删除失败,已删的会话在回收站`)
    },
    [api, sessions, selectedId],
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
          <button
            type="button"
            className={tab === "memory" ? "tab active" : "tab"}
            data-testid="tab-memory"
            onClick={() => switchTab("memory")}
          >
            记忆
          </button>
          <button
            type="button"
            className={tab === "skills" ? "tab active" : "tab"}
            data-testid="tab-skills"
            onClick={() => switchTab("skills")}
          >
            技能
          </button>
          <button
            type="button"
            className={tab === "permissions" ? "tab active" : "tab"}
            data-testid="tab-permissions"
            onClick={() => switchTab("permissions")}
          >
            权限
          </button>
          <button
            type="button"
            className={tab === "mcp" ? "tab active" : "tab"}
            data-testid="tab-mcp"
            onClick={() => switchTab("mcp")}
          >
            MCP
          </button>
        </nav>
        <button
          type="button"
          className="theme-toggle"
          data-testid="theme-toggle"
          title={theme === "phantom" ? "切换到琥珀主题" : "切换到红黑主题"}
          aria-label={theme === "phantom" ? "切换到琥珀主题" : "切换到红黑主题"}
          onClick={toggleTheme}
        >
          {theme === "phantom" ? "◆" : "❚"}
        </button>
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
            onDeleteGroup={(workdir) => handleDeleteGroup(workdir)}
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
                onSessionRenamed={handleSessionRenamed}
                onCreateSession={handleSlashCreateSession}
                onOpenSessions={handleOpenSessions}
                workdir={selectedMeta?.workdir}
                onOpenMemoryWritten={handleOpenMemoryWritten}
                onOpenAudit={(childId) => {
                  // A subagent's audit view: audit follows the selected
                  // session, so selecting the child + switching tabs lands the
                  // audit page on it (the child never appears in the sidebar).
                  selectSession(childId)
                  switchTab("audit")
                }}
                onOpenMcp={() => switchTab("mcp")}
              />
            </div>
          )}
          {tab === "chat" && !chatActive && (
            <p className="muted" data-testid="chat-empty">
              {selectedId === null ? "No session selected." : "加载会话中…"}
            </p>
          )}
          {tab === "jobs" && <JobsView api={api} />}
          {auditVisited && (
            // Kept mounted (offscreen, not display:none — Virtuoso needs real
            // layout) so the live stream, filters, and scroll survive tab switches.
            <div className={tab === "audit" ? "audit-host" : "audit-host offscreen"} data-testid="audit-host">
              <AuditView
                api={api}
                createWs={createWs}
                sessionId={selectedId}
                sessionTitle={selectedMeta?.title ?? null}
              />
            </div>
          )}
          {tab === "usage" && <UsageView api={api} />}
          {tab === "trash" && <TrashView api={api} />}
          {tab === "memory" && <MemoryView api={api} notice={(t) => setSessionNotice(t)} openTarget={memoryTarget} onOpenConsumed={() => setMemoryTarget(null)} />}
          {tab === "skills" && <SkillsView api={api} notice={(t) => setSessionNotice(t)} />}
          {tab === "permissions" && <PermissionsView api={api} notice={(t) => setSessionNotice(t)} workdir={selectedMeta?.workdir} />}
          {tab === "mcp" && <McpView api={api} notice={(t) => setSessionNotice(t)} />}
        </main>
      </div>
    </div>
  )
}
