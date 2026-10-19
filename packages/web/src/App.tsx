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
import { applyTheme, isThemeName, loadTheme, themeOptions, type ThemeName } from "./theme.js"
import type { WsClient } from "./ws.js"
import { useDaemonClients } from "./daemon-clients.js"
import { SESSIONS_CHANGED } from "./events.js"
import { ChatPanel } from "./chat/ChatPanel.js"
import { UsageView } from "./usage/UsageView.js"
import type { MemoryWrittenInfo, Message } from "./chat/model.js"
import { SessionList } from "./sessions/SessionList.js"
import { useDirectoryPicker } from "./sessions/useDirectoryPicker.js"
import { DirectoryPicker } from "./sessions/DirectoryPicker.js"
import { TrashView } from "./sessions/TrashView.js"
import { CronView } from "./cron/CronView.js"
import { AuditView } from "./audit/AuditView.js"
import { MemoryView } from "./memory/MemoryView.js"
import { SkillsView } from "./skills/SkillsView.js"
import { PermissionsView } from "./permissions/PermissionsView.js"
import { McpView } from "./mcp/McpView.js"
import { ModelView } from "./model/ModelView.js"
import { ChannelView } from "./channel/ChannelView.js"
import { ToastStack, useToasts } from "./toast.js"
import type { FsBrowseResult, SessionMeta } from "./types.js"

type DaemonStatus = "connecting" | "connected" | "error"

const TABS = ["chat", "cron", "audit", "usage", "trash", "memory", "skills", "permissions", "mcp", "model", "channel"] as const
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
  const [authExpired, setAuthExpired] = useState(false)

  // Shell theme: index.html already applied the stored value before first
  // paint; this state mirrors it. The effect re-applies on mount and on every
  // change — correcting the attribute and the meta color to a legal value
  // after any hand-edited storage — and applyTheme persists the choice.
  const [theme, setTheme] = useState<ThemeName>(loadTheme)
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // 401 re-entry: any API 401 — the mount-time status
  // ping or any later call — clears the stale token and re-renders the token
  // form. Without this a reload would re-bootstrap the SAME stale token and
  // loop the auth notice forever. The flag lets the form say why it came
  // back, instead of showing a silent blank form.
  const handleAuthExpired = useCallback(() => {
    clearToken()
    setAuthExpired(true)
    setToken(null)
  }, [])

  if (token === null) return <TokenForm authExpired={authExpired} />
  return <MainShell token={token} onAuthExpired={handleAuthExpired} theme={theme} onThemeChange={setTheme} />
}

/** Shown when no token is stored: paste the daemon token to continue. */
function TokenForm({ authExpired = false }: { authExpired?: boolean }) {
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
        本实例由 daemon 的 token（bearer token）保护。在终端跑 <code>kclaw web</code>
        可直接登录；token 存放在 <code>~/.kclaw/token</code>。
      </p>
      {authExpired && (
        <p className="token-error" role="alert" data-testid="token-error">
          上一个 token 无效或已过期，请重新输入。
        </p>
      )}
      <form onSubmit={submit}>
        <input
          type="password"
          autoComplete="new-password"
          placeholder="daemon token"
          value={value}
          data-testid="token-input"
          onChange={(event) => setValue(event.target.value)}
          autoFocus
        />
        <button type="submit">连接</button>
      </form>
    </div>
  )
}

// Keep-alive tab flag shared by the audit and memory hosts: once visited, the
// view stays mounted (hidden) on other tabs so its live state survives
// navigation.
function useVisitedTab(): [boolean, () => void] {
  const [visited, setVisited] = useState(false)
  const mark = useCallback((): void => setVisited(true), [])
  return [visited, mark]
}

/** Main shell: header with tabs + daemon status, sidebar, and the tab body. */
function MainShell({
  token,
  onAuthExpired,
  theme,
  onThemeChange,
}: {
  token: string
  onAuthExpired: () => void
  theme: ThemeName
  onThemeChange: (theme: ThemeName) => void
}) {
  // onUnauthorized is shared by every call this instance makes (the shell's
  // own pings/pulls plus the tab views) — a 401 anywhere re-enters the token
  // form instead of surfacing a dead "refresh" notice.
  const { api, createWs, wsUrl } = useDaemonClients(token, onAuthExpired)
  const [status, setStatus] = useState<DaemonStatus>("connecting")
  // ChatPanel 的 ws 连接状态（subscribe ack 判定）：顶栏状态点跟随它——
  // /status ping 只在挂载时打一次，之后 daemon 死活只有聊天连接知道。
  // null = 本页还没挂载聊天（未选会话），状态点回退到 ping 结果。
  const [chatConn, setChatConn] = useState<"connecting" | "open" | "closed" | null>(null)
  const [tab, setTab] = useState<Tab>("chat")
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  // 会话列表加载失败态：侧栏给错误说明与重试入口，而不是静默成空列表。
  // 列表加载成功后网络抖动的轮询失败静默（旧列表继续可用），不进这个态。
  const [sessionsError, setSessionsError] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messagesCache, setMessagesCache] = useState<Record<string, Message[]>>({})
  // 全局 toast 栈：侧栏操作结果与管理页回执统一落这里（内容区右上角浮层，
  // 自动消失、点击即消），不再堆在侧栏底部。
  const { toasts, notify, dismiss } = useToasts()
  // memory.written 通知条点击后的跳转目标：切到记忆页并自动打开对应文件。
  const [memoryTarget, setMemoryTarget] = useState<MemoryWrittenInfo | null>(null)
  // Mobile-only: the sidebar slides in as a drawer behind this flag (desktop
  // keeps it permanently visible).
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // The audit page stays mounted once visited (hidden offscreen on other tabs)
  // so its live connection, filters, and scroll position survive navigation.
  // The memory page does the same (hidden, not offscreen — no virtualization).
  const [auditVisited, markAuditVisited] = useVisitedTab()
  const [memoryVisited, markMemoryVisited] = useVisitedTab()
  // 进场动效两件套：tab 高亮滑块（.tab-glider 按活动按钮实际位置落位）与
  // 主内容区的 120ms 淡入（.view-enter，tab 变化时重放）。keep-alive 视图
  // 不重挂载，所以进场靠这里显式重启，而不是依赖 remount。
  const tabsRef = useRef<HTMLElement | null>(null)
  const gliderRef = useRef<HTMLSpanElement | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)
  const gliderPlaced = useRef(false)

  // 首帧直接落位（从 (0,0) 滑过来会读成动画事故），之后每次 tab 变化滑过去。
  const placeGlider = useCallback(() => {
    const nav = tabsRef.current
    const glider = gliderRef.current
    if (nav === null || glider === null) return
    const active = nav.querySelector<HTMLElement>(`[data-testid="tab-${tab}"]`)
    if (active === null) return
    glider.style.setProperty("--glider-x", `${active.offsetLeft}px`)
    glider.style.setProperty("--glider-w", `${active.offsetWidth}px`)
    if (!gliderPlaced.current) {
      gliderPlaced.current = true
      glider.style.transition = "none"
      requestAnimationFrame(() => {
        glider.style.transition = ""
      })
    }
  }, [tab])

  useEffect(() => {
    placeGlider()
  }, [placeGlider])

  useEffect(() => {
    window.addEventListener("resize", placeGlider)
    return () => window.removeEventListener("resize", placeGlider)
  }, [placeGlider])

  useEffect(() => {
    const main = mainRef.current
    if (main === null) return
    main.classList.remove("view-enter")
    // Reflow so removing + re-adding the class restarts the animation.
    void main.offsetWidth
    main.classList.add("view-enter")
  }, [tab])
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

  // Session list fetch, shared by the mount load / the error-state retry /
  // the keep-alive refresh (polling + SESSIONS_CHANGED). Returns the metas
  // so the mount path can run the deep-link consumption on a real list.
  const haveSessionsRef = useRef(false)
  const fetchSessions = useCallback(async (): Promise<SessionMeta[] | null> => {
    try {
      const metas = await api.get<SessionMeta[]>("/sessions")
      haveSessionsRef.current = true
      setSessions(metas)
      setSessionsError(false)
      return metas
    } catch {
      // 只有列表从未加载成功（重试前）才进错误态；已有列表时静默——轮询的
      // 偶发失败不该把可用侧栏打成错误页，旧列表继续可用。
      if (!haveSessionsRef.current) setSessionsError(true)
      return null
    }
  }, [api])

  // Session list on mount (server sorts by updatedAt desc); deep-link params
  // consume on the first SUCCESSFUL load (a failed load keeps them pending
  // until the retry lands).
  useEffect(() => {
    let cancelled = false
    void fetchSessions().then((metas) => {
      if (cancelled || metas === null || deepLinkConsumed.current) return
      deepLinkConsumed.current = true
      const params = new URLSearchParams(window.location.search)
      const target = params.get("session")
      const targetTab = params.get("tab")
      if (targetTab !== null && (TABS as readonly string[]).includes(targetTab)) {
        if (targetTab === "audit") markAuditVisited() // deep links mount the kept-alive host too
        if (targetTab === "memory") markMemoryVisited()
        setTab(targetTab as Tab)
      }
      // Consume the params either way (hit or miss) so a refresh or later
      // navigation never re-triggers the jump.
      window.history.replaceState({}, "", "/")
      if (target !== null && metas.some((meta) => meta.id === target)) {
        setSelectedId(target)
      }
    })
    return () => {
      cancelled = true
    }
  }, [fetchSessions])

  // 侧栏保活刷新：页面可见时每 10s 重拉 /sessions——CLI、IM channel、其他
  // 浏览器产生的会话变化不发本页事件，轮询是它们进侧栏的途径。不可见时跳过
  // （回来那一刻的 visibilitychange 立即补一次）；页内视图改了会话集合
  // （TrashView 恢复等）发 SESSIONS_CHANGED 即时刷新，不等下一拍。
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === "visible") void fetchSessions()
    }
    const timer = window.setInterval(refresh, 10_000)
    document.addEventListener("visibilitychange", refresh)
    window.addEventListener(SESSIONS_CHANGED, refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", refresh)
      window.removeEventListener(SESSIONS_CHANGED, refresh)
    }
  }, [fetchSessions])

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
    if (next === "audit") markAuditVisited()
    if (next === "memory") markMemoryVisited()
    setTab(next)
  }, [])

  // memory.written 通知条点击：切到记忆页并把目标交给 MemoryView 自动打开。
  const handleOpenMemoryWritten = useCallback((info: MemoryWrittenInfo): void => {
    setMemoryTarget(info)
    markMemoryVisited()
    setTab("memory")
  }, [])

  // A subagent's audit view: audit follows the selected session, so selecting
  // the child + switching tabs lands the audit page on it (the child never
  // appears in the sidebar).
  const handleOpenAudit = useCallback(
    (childId: string): void => {
      selectSession(childId)
      switchTab("audit")
    },
    [selectSession, switchTab],
  )

  // Shared "create a session → prepend to the list → select it" step behind
  // both the sidebar picker (workdir) and the slash commands (/new title,
  // /clear). Selecting the fresh session triggers the message pull (empty)
  // and the ws subscribe — the new empty conversation becomes the active one.
  const createAndSelectSession = useCallback(
    async (body: Record<string, unknown>): Promise<void> => {
      try {
        const meta = await api.post<SessionMeta>("/sessions", body)
        setSessions((prev) => [meta, ...(prev ?? [])])
        setSelectedId(meta.id)
      } catch (err) {
        notify(err instanceof Error ? err.message : "创建会话失败", "error")
      }
    },
    [api, notify],
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

  // Session fork 落地（ChatPanel POST 成功后上抛）：新会话进侧栏并选中，
  // 全局 toast 带"返回原会话"动作——fork 的动机就是去新线干点什么，跳过去
  // 省一次点击，回来靠这个动作。
  const handleForked = useCallback(
    (meta: SessionMeta) => {
      setSessions((prev) => [meta, ...(prev ?? [])])
      setSelectedId(meta.id)
      const sourceId = meta.forkedFrom?.sessionId
      if (sourceId !== undefined) {
        notify("已从原会话 fork", "info", { label: "返回原会话", onAction: () => setSelectedId(sourceId) })
      } else {
        notify("已从原会话 fork")
      }
    },
    [notify],
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
      try {
        const meta = await api.patch<SessionMeta>(`/sessions/${encodeURIComponent(id)}`, { title })
        setSessions((prev) => (prev ?? []).map((s) => (s.id === id ? meta : s)))
      } catch (err) {
        notify(err instanceof Error ? err.message : "重命名失败", "error")
      }
    },
    [api, notify],
  )

  // Soft-delete (the server marks the session deleted; it moves to the trash).
  const handleDeleteSession = useCallback(
    async (id: string): Promise<void> => {
      try {
        await api.del(`/sessions/${encodeURIComponent(id)}`)
        setSessions((prev) => (prev ?? []).filter((s) => s.id !== id))
        if (selectedId === id) setSelectedId(null)
      } catch (err) {
        notify(err instanceof Error ? err.message : "删除失败", "error")
      }
    },
    [api, selectedId, notify],
  )

  // Soft-delete a whole project group: every session under the workdir goes
  // to the trash. Deletes run concurrently; whatever succeeded leaves the
  // list (the group disappears with it), failures surface in the notice.
  const handleDeleteGroup = useCallback(
    async (workdir: string): Promise<void> => {
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
      if (failures > 0) notify(`${failures} 个会话删除失败,已删的会话在回收站`, "error")
    },
    [api, sessions, selectedId, notify],
  )

  const chatActive = selectedId !== null && readyMessages !== null

  // 空态的主动作落点：未选会话时主区直接给"新建会话"入口，复用侧栏同一条
  // 选目录建会话的流程（DirectoryPicker 状态经 useDirectoryPicker 共享逻辑）。
  const emptyPicker = useDirectoryPicker(browseDirs)

  // 状态点跟随聊天连接：聊天挂载时（chatActive）以 ws 状态为准（open=已连、
  // connecting=建连中、closed=断了）；聊天未挂载（未选会话、或所选会话被删
  // 等导致面板卸载）回退到挂载时的 /status ping 结果——chatConn 停留的旧值
  // 不能泄漏到无聊天状态。
  const dotStatus: DaemonStatus =
    chatActive && chatConn !== null
      ? chatConn === "open"
        ? "connected"
        : chatConn === "connecting"
          ? "connecting"
          : "error"
      : status

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
        <nav className="tabs" data-testid="tabs" ref={tabsRef}>
          <span className="tab-glider" aria-hidden="true" ref={gliderRef} />
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
            className={tab === "cron" ? "tab active" : "tab"}
            data-testid="tab-crons"
            onClick={() => switchTab("cron")}
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
          <button
            type="button"
            className={tab === "model" ? "tab active" : "tab"}
            data-testid="tab-model"
            onClick={() => switchTab("model")}
          >
            Model
          </button>
          <button
            type="button"
            className={tab === "channel" ? "tab active" : "tab"}
            data-testid="tab-channel"
            onClick={() => switchTab("channel")}
          >
            IM Channel
          </button>
        </nav>
        <select
          className="theme-select"
          data-testid="theme-select"
          aria-label="界面主题"
          value={theme}
          onChange={(e) => {
            const next = e.target.value
            if (isThemeName(next)) onThemeChange(next)
          }}
        >
          {themeOptions().map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <span
          className={`status-dot ${dotStatus}`}
          data-testid="status-dot"
          title={`daemon: ${dotStatus}`}
        />
      </header>
      <div className="body">
        <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
          <SessionList
            sessions={sessions ?? []}
            selectedId={selectedId}
            loading={sessions === null}
            error={sessionsError}
            onRetry={() => void fetchSessions()}
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
        </aside>
        {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
        <main className="main" ref={mainRef}>
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
                onOpenAudit={handleOpenAudit}
                onConnectionState={setChatConn}
                onReturnToParent={selectSession}
                onForked={handleForked}
                onOpenMcp={() => switchTab("mcp")}
              />
            </div>
          )}
          {tab === "chat" && !chatActive && (
            selectedId === null ? (
              // Empty state with the primary action in reach: the first move
              // of "start a conversation" lives where the eye lands, not in
              // the sidebar.
              <div className="chat-empty-state" data-testid="chat-empty">
                <p className="muted">未选择会话</p>
                <button
                  type="button"
                  className="new-session"
                  data-testid="chat-empty-new"
                  onClick={emptyPicker.openAtRoot}
                >
                  ＋ 新建会话
                </button>
                {emptyPicker.open && (
                  <DirectoryPicker
                    listing={emptyPicker.listing}
                    loading={emptyPicker.loading}
                    error={emptyPicker.error}
                    onNavigate={(path) => void emptyPicker.load(path)}
                    onPick={() => {
                      if (emptyPicker.listing === null) return
                      emptyPicker.close()
                      void handleCreateSession(emptyPicker.listing.path)
                    }}
                    onClose={emptyPicker.close}
                  />
                )}
              </div>
            ) : (
              <p className="muted" data-testid="chat-empty-loading">
                加载会话中…
              </p>
            )
          )}
          {tab === "cron" && <CronView api={api} />}
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
          {memoryVisited && (
            // Kept mounted (hidden on other tabs) so scroll position and the
            // expanded-file state survive tab switches.
            <div className="memory-host" hidden={tab !== "memory"} data-testid="memory-host">
              <MemoryView api={api} notice={notify} openTarget={memoryTarget} onOpenConsumed={() => setMemoryTarget(null)} />
            </div>
          )}
          {tab === "skills" && <SkillsView api={api} notice={notify} />}
          {tab === "permissions" && <PermissionsView api={api} notice={notify} workdir={selectedMeta?.workdir} />}
          {tab === "mcp" && <McpView api={api} notice={notify} sessionWorkdir={selectedMeta?.workdir} />}
          {tab === "model" && <ModelView api={api} notice={notify} />}
          {tab === "channel" && <ChannelView api={api} notice={notify} />}
        </main>
      </div>
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
